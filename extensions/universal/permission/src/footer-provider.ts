// footer-provider.ts
//
// permission 端的 footer line 注册入口（consumer 端握手协议）。
//
// 设计动机（沿用 ask-user #M4 修复模式，见 extensions/universal/ask-user/src/channel-registry-register.ts）：
//  - statusline 是 registry 唯一创建方（canonical owner）—— pi-statusline 独立项目
//    （~/Code/pi-statusline）的 footer-handshake-access.ts
//  - permission 是 consumer：永不创建 registry 实例，永不写 slot.registry 字段
//  - slot 形状 {version, registry?, pending:[]}；registry 未就绪时 consumer 只 push pending
//
// 加载顺序鲁棒（statusline 可能晚于 permission 加载）：
//  - 无合规 slot → consumer 建新 slot（仅 pending，registry 留空给 owner 填）
//  - slot 存在但 registry 未就绪 → push pending（等 owner flush）
//  - slot 存在且 registry 就绪 → 直接 register
//
// 纯 globalThis 反射实现：不静态 import pi-statusline（permission 的可选 peerDep，
// 未安装时静态 import 会致整个 permission 加载失败），运行时结构兼容即可。

import { getLogger } from "@zhushanwen/pi-extension-logger";
import { MODE_LABELS, type PermissionMode } from "./types.js";
import type { PermissionPalette } from "./statusline-palette.js";

const logger = getLogger("pi-permission");

// ── 协议契约字面量（必须与 pi-statusline 的 footer-handshake-access.ts 完全一致）──
// Symbol.for 字符串是跨包稳定契约：pi-statusline(owner) 与 permission(consumer) 通过同一
// Symbol 读/写 globalThis slot。字符串不一致 → 握手静默失败（双方各持独立 slot，永不对齐）。
export const FOOTER_HANDSHAKE_KEY = Symbol.for(
	"@zhushanwen/pi-statusline.footerHandshake",
);
export const REQUEST_RENDER_KEY = Symbol.for(
	"@zhushanwen/pi-statusline.requestRender",
);

/** 握手协议版本号。读写 slot 时校验 version !== 1 视为不兼容。 */
const HANDSHAKE_VERSION = 1 as const;

/** permission 在 footer registry 中的稳定 id。 */
const FOOTER_LINE_ID = "pi-permission";

// ── 本地等价接口（结构兼容 pi-statusline 端，不静态 import）──

/**
 * footer line renderer 的本地等价接口（与 pi-statusline 端 FooterLineRenderer 形状一致）。
 * 本模块不静态 import pi-statusline；运行时结构兼容即可。
 */
export interface FooterLineRenderer {
	/** 显示顺序权重：0=line1, 1=line2, 2=line3, ... */
	order: number;
	/** 纯函数：返回单行字符串（无内容返回 null，statusline 跳过） */
	render(ctx: unknown, theme: unknown): string | null;
}

/** registry 的本地等价接口（与 pi-statusline 端 FooterLineRegistry 形状一致）。 */
interface FooterLineRegistry {
	register(id: string, renderer: FooterLineRenderer): void;
	unregister(id: string): void;
}

interface PendingEntry {
	id: string;
	renderer: FooterLineRenderer;
}

interface FooterHandshakeSlot {
	version: typeof HANDSHAKE_VERSION;
	registry?: FooterLineRegistry;
	pending: PendingEntry[];
}

// ── Slot 读取（version + 结构守卫）──

/**
 * 从 globalThis 读 slot；version !== 1 或结构不合规视为无 slot（返回 undefined）。
 *
 * 与 pi-statusline 端 readSlot 对称：version 不匹配时 warn（帮助诊断两端漂移），
 * pending 非 Array 时丢弃（防御污染槽位）。
 */
function readSlot(): FooterHandshakeSlot | undefined {
	const slot = Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY);
	if (slot === undefined) return undefined;
	if (typeof slot !== "object" || slot === null) return undefined;
	// 双字段 in 守卫：version + pending 都在才视为 slot 雏形（避免 as 到全可选类型的无校验断言）
	if (!("version" in slot) || !("pending" in slot)) return undefined;
	const loose = slot as { version: unknown; pending: unknown };
	if (loose.version !== HANDSHAKE_VERSION) {
		logger.warn("footer handshake version mismatch, discarding and recreating", {
			got: String(loose.version),
			expected: HANDSHAKE_VERSION,
		});
		return undefined;
	}
	if (!Array.isArray(loose.pending)) return undefined;
	return loose as FooterHandshakeSlot;
}

/**
 * consumer 建新 slot：只填 version + pending（registry 留空给 owner 填）。
 * 与 owner 的 ensureSlot 不同：consumer 永不在此创建 registry。
 */
function ensureSlot(): FooterHandshakeSlot {
	const slot: FooterHandshakeSlot = {
		version: HANDSHAKE_VERSION,
		pending: [],
	};
	Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, slot);
	return slot;
}

// ── 注册入口（consumer 唯一接口）──

/**
 * 注册 permission footer line renderer。
 *
 * 三分支（加载顺序鲁棒）：
 *  1. slot 不存在/版本不兼容 → ensureSlot + push pending（owner 后到时 flush）
 *  2. slot 存在但 registry 未就绪 → push pending
 *  3. slot 存在且 registry 就绪 → registry.register
 *
 * @param renderer footer line renderer（order + 纯 render 函数）
 * @returns dispose 函数：注销 renderer（registry 就绪→unregister；未就绪→从 pending 移除）
 *          并请求 statusline 重绘。once-guard 保证幂等：重复调用直接 return，无副作用。
 */
export function registerPermissionFooterLine(renderer: FooterLineRenderer): () => void {
	const slot = readSlot() ?? ensureSlot();
	if (slot.registry !== undefined) {
		slot.registry.register(FOOTER_LINE_ID, renderer);
	} else {
		slot.pending.push({ id: FOOTER_LINE_ID, renderer });
	}
	// once-guard：dispose 是一次性清理，重复调用不再触发 unregister/requestRender。
	// 防御调用方在分支切换等场景误调两次。
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		const current = readSlot();
		if (current === undefined) return;
		if (current.registry !== undefined) {
			current.registry.unregister(FOOTER_LINE_ID);
		} else {
			current.pending = current.pending.filter((p) => p.id !== FOOTER_LINE_ID);
		}
		requestFooterRender();
	};
}

/**
 * 请求 statusline 重绘。statusline 未安装时 noop（REQUEST_RENDER_KEY 不存在）。
 *
 * mode/enabled 切换后调用，使 footer 立即反映新状态（否则要等 resize/timer）。
 */
export function requestFooterRender(): void {
	const fn = Reflect.get(globalThis, REQUEST_RENDER_KEY) as
		| (() => void)
		| undefined;
	fn?.();
}

// ── footer 行渲染（纯函数）──

/**
 * 渲染 permission footer 行（纯函数，便于单测）。
 *
 * 信息密度：mode + enabled + user rule count + classifier model（auto 模式）。
 *  - enabled=true  → '[permission] <LABEL> · enabled · N user rule(s) [· classifier: <model>]'
 *  - enabled=false → '[permission] disabled'
 *
 * classifier model 仅在 auto 模式且非空时显示（其他模式不跑 AI 分类，显示无意义）。
 * rule(s) 单复数随 count 变化（1→rule，其他→rules）。
 *
 * @param mode 当前权限模式
 * @param enabled 扩展是否启用
 * @param userRuleCount 用户自定义规则数量
 * @param classifierModel classifier 模型 id（auto 模式才显示）
 * @param palette 色彩映射（测试可传透传 palette）
 */
export function renderPermissionFooterLine(
	mode: PermissionMode,
	enabled: boolean,
	userRuleCount: number,
	classifierModel: string,
	palette: PermissionPalette,
): string {
	if (!enabled) {
		return `${palette.dim("[permission]")} ${palette.warning("disabled")}`;
	}
	const label = MODE_LABELS[mode];
	const ruleWord = userRuleCount === 1 ? "rule" : "rules";
	const parts: string[] = [
		`${palette.dim("[permission]")} ${palette.accent(label)}`,
		palette.success("enabled"),
		`${palette.dim(`${userRuleCount} user ${ruleWord}`)}`,
	];
	if (mode === "auto" && classifierModel) {
		parts.push(`${palette.dim("classifier:")} ${palette.text(classifierModel)}`);
	}
	return parts.join(` ${palette.dim("·")} `);
}
