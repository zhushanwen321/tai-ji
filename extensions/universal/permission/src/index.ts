/**
 * @zhushanwen/pi-permission — Pi permission 扩展
 *
 * 四档权限模式（yolo/auto/approve/strict）+ 三层管道（AST + 规则 + AI Classifier）。
 *
 * W5 阶段：tool_call handler 接入三层管道（checkPermission）。
 *  - G5：显式 approvalChain promise chain 串行化（Pi 不保证 tool_call handler 串行，
 *    但权限检查涉及共享状态/UI 对话框，必须串行避免竞态）。
 *  - fail-closed：handler 异常 → block + reason（不放行）。
 *  - session 隔离：每 session 独立扩展工厂闭包；config 不持有跨调用缓存，每次读时刷新
 *    （直接 loadAndWatchConfig，llm-shared mtime 去重零成本，见 config.ts「热重载契约」）。
 *  - yolo 快速路径：mode=yolo 或 enabled=false → 直接 return undefined（不跑管道）。
 */

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionUIContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { oncePerProcess } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { migrateLegacyConfig } from "@zhushanwen/pi-llm-shared";

const logger = getLogger("pi-permission");

import { handlePermissionCommand, handlePermissionModelCommand, handlePermissionRuleCommand } from "./commands.js";
import { loadAndWatchConfig, saveConfig } from "./config.js";
import { makeNextIdCounter } from "./rule-templates.js";
import { checkPermission, type CheckPermissionDeps } from "./pipeline.js";
import { createPipelineDeps } from "./production.js";
import type { PermissionConfig } from "./types.js";
import {
	registerPermissionFooterLine,
	requestFooterRender,
	renderPermissionFooterLine,
	type FooterLineRenderer,
} from "./footer-provider.js";
import { paletteFromTheme, type PermissionPalette } from "./statusline-palette.js";

// ──────────────────────── [MIGRATION] 配置路径迁移（session_start 运行时） ────────────────────────
// Added in v1.0.0. Remove after v2.0.0 (one major past).
// session_start 首次触发时把旧路径 permission-config.json 迁到 config/permission-ext-config.json。
// 幂等、best-effort（migrateLegacyConfig 见 @zhushanwen/pi-llm-shared）。
// 写 agentDir 全局配置文件属跨 session 副作用——oncePerProcess 守卫防 factory 二调/handler
// 累积双跑（u-audit-fix 收编原内联 once flag；key 带包名前缀避撞，见 pi-ext-guards JSDoc）。
// agentDir 由 getAgentDir() 推导（尊重 PI_CODING_AGENT_DIR）。

/** 默认配置 warning 回调（loadAndWatchConfig 共用，透传 logger.warn）。 */
const defaultConfigWarn = (msg: string): void => logger.warn(msg);

// ──────────────────────── tool_call event 最小子集 ────────────────────────

/**
 * Pi tool_call event 的最小子集（duck typing，不依赖完整 SDK 类型）。
 *
 * event.type='tool_call'，event.toolCallId，event.toolName，event.input。
 * bash input={command, timeout?}，其他工具 input={path, ...}。
 */
interface ToolCallEventLike {
	toolName: string;
	input: Record<string, unknown>;
	toolCallId?: string;
}

/** Pi tool_call handler 返回值：{block:true, reason} → Pi 转 isError tool_result；undefined → 放行。 */
interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * ctx.ui.select / ctx.ui.input 的 opts 参数索引（第 3 个参数，0-based）。
 * 类型位置提取 opts 时用 `Parameters<typeof ...>[typeof _UI_OPTIONS_PARAM_INDEX]`
 * （字面量索引会触发 no-magic-numbers，typeof 常量索引语义等价）。
 * 仅类型位置使用、运行时无值引用，按项目约定加 `_` 前缀豁免 no-unused-vars。
 */
const _UI_OPTIONS_PARAM_INDEX = 2;

// ──────────────────────── ctx.ui 适配（E8/M11 单源） ────────────────────────

/**
 * E8（M11）：pi ctx.ui → 本包局部 UI 上下文的统一适配（原三份闭包收敛为单源）。
 *
 * 三处消费：/permission rule（RuleEditorContext.ui）、/permission model
 * （ModelPickerContext.ui）、tool_call 审批（ApprovalContext.ui）。三个目标接口的
 * custom 泛型形态不同（前两者 factory 返回 unknown、后者返回 Component），统一靠
 * `as Parameters<typeof ui.custom<T>>[0]` cast 吸收（T5）。
 *
 * select/input 的 opts 类型经 `Parameters<typeof ...>[typeof _UI_OPTIONS_PARAM_INDEX]`
 * 索引提取（字面量索引会触发 no-magic-numbers，typeof 常量索引语义等价）。
 * input 可选守卫展开：SDK 提供，mock/headless 可能缺失——rule-editor custom 模板
 * 文本输入与 Reject-with-Reason（approval.ts collectRejectReason）都依赖此透传。
 */
function makeUiAdapter(ui: ExtensionUIContext) {
	return {
		notify: (msg: string, type?: "info" | "warning" | "error") => ui.notify(msg, type),
		select: (title: string, options: string[], opts?: Parameters<typeof ui.select>[typeof _UI_OPTIONS_PARAM_INDEX]) =>
			ui.select(title, options, opts),
		custom: <T,>(
			factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
			options?: { overlay?: boolean },
		): Promise<T> => ui.custom<T>(factory as Parameters<typeof ui.custom<T>>[0], options),
		...(typeof ui.input === "function"
			? {
					input: (title: string, placeholder?: string, opts?: Parameters<typeof ui.input>[typeof _UI_OPTIONS_PARAM_INDEX]) =>
						ui.input(title, placeholder, opts),
				}
			: {}),
	};
}

// ──────────────────────── 扩展工厂 ────────────────────────

/**
 * 扩展工厂。每个 session 独立工厂闭包；config 不持有跨调用缓存，每次读时刷新
 * （llm-shared mtime 去重零成本，详见 config.ts「热重载契约」）。
 */
export default function permissionExtension(pi: ExtensionAPI): void {
	// ──────────────────────── 配置读取（读时刷新，回归 llm-shared 框架） ────────────────────────
	// 不持有跨调用缓存：每次需要配置直接 loadAndWatchConfig()，llm-shared 内部 mtime+size 去重，
	// 文件未变时零额外 IO（只 statSync）。这是 llm-shared config「热重载契约」的正确用法——
	// 见 extensions/shared/llm-shared/src/config.ts 文件头。
	// （历史：曾用 `let config` 闭包 + 手动 refreshConfig 调用点，架空了读时刷新，同一 session 改文件不生效。）

	// ──────────────────────── session_start：迁移旧路径配置 ────────────────────────
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		// [MIGRATION] Added in v1.0.0. Remove after v2.0.0.
		oncePerProcess("permission:migrate-legacy-config", () => {
			migrateLegacyConfig(getAgentDir(), "permission-config.json", "config/permission-ext-config.json");
		});
		// 无需手动刷新：去闭包后每次 loadAndWatchConfig 读时刷新；迁移改写文件后下次读取自动生效。
		// 注册 footer line renderer（consumer 端握手，pi-statusline 是 canonical owner）。
		// renderer 无状态：render 时用 statusline 传入的 theme + loadAndWatchConfig 读最新 config。
		// renderer 覆盖式注册（registry.register 同 id 覆盖），无需存 dispose。
		registerFooterLineFor(ctx);
	});

	// session_tree：分支切换后请求 statusline 重绘（renderer 无状态，render 时读新分支 config）。
	pi.on("session_tree", () => {
		requestFooterRender();
	});

	// ──────────────────────── /permission 命令 ────────────────────────
	pi.registerCommand("permission", {
		description: "View or switch permission mode. Usage: /permission [mode|status|rule|model]",
		getArgumentCompletions(prefix: string) {
			const trimmed = prefix.trimStart().toLowerCase();
			const opts = [
				{ label: "status", value: "status", description: "查看详细权限配置" },
				{ label: "rule", value: "rule", description: "编辑用户规则（overlay）" },
				{ label: "model", value: "model", description: "选择 classifier 模型（overlay）" },
				{ label: "yolo", value: "yolo", description: "无保护，允许全部" },
				{ label: "auto", value: "auto", description: "规则 + AI 分类器" },
				{ label: "approve", value: "approve", description: "规则，非安全→手动批准" },
				{ label: "strict", value: "strict", description: "全部需批准" },
			];
			return trimmed === "" ? opts : opts.filter((o) => o.label.startsWith(trimmed));
		},
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			// 读时刷新：命令执行时读最新 config（llm-shared mtime 去重）。
			const config = loadAndWatchConfig(defaultConfigWarn);
			const trimmed = (args ?? "").trim();
			// W8：/permission rule → overlay CRUD 编辑 userRules（异步路径）
			if (trimmed === "rule") {
				await handlePermissionRuleCommand(
					{
						mode: ctx.mode,
						ui: makeUiAdapter(ctx.ui),
					},
					config,
					makeNextIdCounter(config.userRules),
					(newConfig) => {
						const r = saveConfig(newConfig);
						if (r.success) requestFooterRender();
						return r;
					},
				);
				return;
			}
			// W7：/permission model → overlay 选择 classifier model（异步路径）
			if (trimmed === "model") {
				await handlePermissionModelCommand(
					{
						mode: ctx.mode,
						// E2：model picker 数据源（listAvailableModels 走 modelRegistry）
						modelRegistry: ctx.modelRegistry,
						// input 透传保持 ctx 对称（model picker 当前不用，rule handler 用）
						ui: makeUiAdapter(ctx.ui),
					},
					config,
					(newConfig) => {
						const r = saveConfig(newConfig);
						if (r.success) requestFooterRender();
						return r;
					},
				);
				return;
			}
			// 原同步路径（yolo/auto/approve/strict/status/无参）
			const message = handlePermissionCommand(
				args,
				config,
				(newConfig: PermissionConfig) => {
					const r = saveConfig(newConfig);
					if (r.success) requestFooterRender();
					return r;
				},
			);
			ctx.ui.notify(message, "info");
		},
	});

	// ──────────────────────── tool_call handler（W5 三层管道 + G5 串行化） ────────────────────────
	// G5：显式 approvalChain promise chain。Pi 不保证 tool_call handler 串行调用，
	// 但权限检查可能弹出 UI 对话框（共享终端），必须串行避免多个对话框叠加。
	let approvalChain: Promise<ToolCallResult | undefined> = Promise.resolve(undefined);

	pi.on("tool_call", (event: unknown, ctx: ExtensionContext): Promise<ToolCallResult | undefined> => {
		// 读时刷新：每次 tool_call 读最新 config（llm-shared mtime 去重零成本；去闭包后改文件即生效）。
		const run = (): Promise<ToolCallResult | undefined> =>
			processToolCall(event, ctx, () => loadAndWatchConfig(defaultConfigWarn));
		// 串行：前一个完成（无论 resolve/reject）后才跑下一个。失败不影响后续。
		approvalChain = approvalChain.then(run, run);
		return approvalChain;
	});

	// ──────────────────────── footer line 辅助 ────────────────────────

	/**
	 * 注册 permission footer line renderer（consumer 端握手）。
	 * 不依赖 ctx.ui.theme：theme 不从 ExtensionUIContext 取——pi 的 ExtensionUIContext
	 * 虽有 theme 字段（types.d.ts:174-175），但 statusline 渲染的权威 theme 由
	 * pi-statusline 每次 render 时经 render(ctx, theme) 传入（render hook 的 theme 参数 = pi Theme 对象）。
	 * headless（rpc/json mode）时 render 收不到有效 theme → 返回 null，statusline 跳过。
	 */
	function registerFooterLineFor(_ctx: ExtensionContext): () => void {
		return registerPermissionFooterLine(makePermissionFooterRenderer());
	}

	/**
	 * 构造 footer line renderer（order=2，pi-statusline 内联进 ctx 行）。
	 * render 读时刷新：每次 statusline 重绘都 loadAndWatchConfig 读最新 config，
	 * 故任意字段（mode/enabled/rules/model）切换后重绘立即可见。
	 * theme 参数（pi Theme 对象）每次 render 传入，palette 即取即用（theme 切换也跟随）。
	 */
	function makePermissionFooterRenderer(): FooterLineRenderer {
		return {
			order: 2,
			render: (ctx: unknown, theme: unknown) => {
				const cfg = loadAndWatchConfig(defaultConfigWarn);
				const palette = paletteFromThemeSafe(theme);
				if (palette === null) return null;
				return renderPermissionFooterLine(
					cfg.mode,
					cfg.enabled,
					cfg.userRules.length,
					cfg.classifier.model,
					palette,
				);
			},
		};
	}

	/**
	 * theme 有效（含 fg 函数）→ 构造 PermissionPalette；否则 null（headless/无主题）。
	 * theme 来自 pi-statusline render hook 传入的 pi Theme 对象（fg(token, text) 签名）。
	 */
	function paletteFromThemeSafe(theme: unknown): PermissionPalette | null {
		if (typeof theme !== "object" || theme === null) return null;
		if (!("fg" in theme) || typeof theme.fg !== "function") return null;
		return paletteFromTheme(theme as { fg(token: string, text: string): string });
	}

}

// ──────────────────────── processToolCall（单次工具调用处理） ────────────────────────

/**
 * 处理单次 tool_call：提 config → checkPermission → 映射为 Pi ToolCallResult。
 *
 * fail-closed：任何异常 → block + reason（不放行）。
 * yolo 快速路径：mode=yolo 或 enabled=false → return undefined（不跑管道，最小开销）。
 *
 * @param event tool_call event（duck typing 为 ToolCallEventLike）
 * @param ctx Pi ExtensionContext
 * @param getConfig 获取最新 config（读时刷新：调用方每次传 loadAndWatchConfig，llm-shared mtime 去重）
 */
async function processToolCall(
	event: unknown,
	ctx: ExtensionContext,
	getConfig: () => PermissionConfig,
): Promise<ToolCallResult | undefined> {
	const cfg = getConfig();

	// 快速路径：yolo 或 disabled → 完全放行（不跑管道，最小开销）
	if (cfg.mode === "yolo" || !cfg.enabled) {
		return undefined;
	}

	// 提取 event 字段（duck typing，防御非预期形状）
	const evt = event as ToolCallEventLike;
	const toolName = typeof evt?.toolName === "string" ? evt.toolName : "";
	const input = evt?.input !== null && typeof evt?.input === "object" && !Array.isArray(evt.input)
		? (evt.input as Record<string, unknown>)
		: {};

	if (toolName.length === 0) {
		// 无法识别工具名 → fail-closed block
		return { block: true, reason: "[pi-permission] tool_call event missing toolName" };
	}

	// 装配 deps（每次 tool_call 重新装配，捕获当前 ctx.mode/ui；classifier 走 ctx.modelRegistry）
	const approvalCtx = {
		mode: ctx.mode,
		ui: makeUiAdapter(ctx.ui),
	};
	const deps: CheckPermissionDeps = createPipelineDeps(approvalCtx, ctx);

	try {
		const decision = await checkPermission(
			toolName,
			input,
			cfg.mode,
			cfg.classifier,
			cfg.userRules,
			deps,
			{ cwd: ctx.cwd, signal: ctx.signal },
		);

		if (decision.action === "allow") {
			// 放行：return undefined（Pi 不拦截）
			return undefined;
		}
		// deny / ask → block + reason（Pi 转 isError tool_result）
		// ask 在 checkPermission 内已转 user 决策；若到这仍是 ask，fail-closed 当 deny
		return {
			block: true,
			reason: `[pi-permission] ${decision.action}: ${decision.reason} (source=${decision.source})`,
		};
	} catch (error) {
		// fail-closed：异常 → block + reason（绝不放行）
		const msg = error instanceof Error ? error.message : String(error);
		logger.warn("tool_call handler exception", { toolName, error: msg });
		return {
			block: true,
			reason: `[pi-permission] internal error (fail-closed): ${msg}`,
		};
	}
}
