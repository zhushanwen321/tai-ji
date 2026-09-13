/**
 * 用户审批 UI（W5 集成层 + W6 T9 Reject-with-Reason）。
 *
 * 三分支（按 ctx.mode 分发，ctx 由 caller 从 Pi ExtensionContext 提取）：
 *  - tui：ctx.ui.custom 自定义 Component（ApprovalComponent，G4 补 invalidate）。
 *    G3：调 ctx.ui.custom 前先检查 signal.aborted 短路（AI 先于 UI factory 执行时
 *    controller.abort() 触发但 comp 尚未创建，cancel 落空）。
 *  - rpc：ctx.ui.select（GUI 对话框）。M2：接收 signal，abort 短路 + 透传给 ui.select。
 *  - headless（json/print）：无交互 UI，立即 fail-closed deny（requestHeadless）。auto 模式
 *    Racing 不走此路径（pipeline runLayer3WithRacing 的 isHeadless 分支纯等 AI 判定）。
 *
 * ApprovalComponent 是简化版 TUI 组件（参考 ask-user AskUserComponent）：
 *  - 显示工具名 + 命令 + 触发原因 + 可选 AI 预分类。
 *  - Enter/approve、Esc/deny。
 *  - signal abort → comp.cancel()（复用 _resolved 守卫，避免二次 done）。
 *
 * W6 T9 G3 Reject-with-Reason：用户拒绝时，若 ctx.ui.input 存在则弹出文本输入框
 * 采集真实拒绝理由（回传给 agent，辅助理解为何被拒）；ctx.ui.input 不存在则 fallback
 * 用固定 "denied via rpc/tui" 文案。当前 RPC 分支已完整接入 ctx.ui.input；
 * TUI 分支因 pi-tui Input 组件集成成本较高，暂保留简化 deny（TODO 后续迭代）。
 */

import { type Component, matchesKey, type SelectItem, truncateToWidth } from "@earendil-works/pi-tui";

import type { ApprovalRequest } from "./pipeline.js";
import type { ToolInvocationContext, UserDecision } from "./types.js";

// ──────────────────────── ApprovalContext（从 ExtensionContext 提取的最小子集） ────────────────────────

/**
 * 审批 UI 上下文（从 Pi ExtensionContext 提取的最小子集）。
 *
 * 提取为独立接口便于：
 *  - 测试 mock（不依赖完整 ExtensionContext）。
 *  - 明确 requestUserApproval 只用 mode + ui.{custom,select,notify,input}。
 *
 * mode 来自 ExtensionContext.mode（"tui"|"rpc"|"json"|"print"）。
 * headless = mode !== "tui" && mode !== "rpc"（json/print 无交互 UI）。
 *
 * W6 T9 G3：ui.input 可选（SDK 提供，但测试 mock 可能缺失）。
 * Reject-with-Reason 的「受阻」定义为可观测条件：
 *  - ui.input 存在（typeof === 'function'）→ 采集真实 reason
 *  - ui.input 缺失 → fallback 固定文案
 */
export interface ApprovalContext {
	mode: "tui" | "rpc" | "json" | "print";
	ui: {
		notify(msg: string, type?: "info" | "warning" | "error"): void;
		select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
		custom<T = void>(
			factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => Component,
			options?: { overlay?: boolean },
		): Promise<T>;
		/** W6 T9 G3：可选文本输入（Reject-with-Reason 用）。SDK 提供，mock 可能缺失。 */
		input?(title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
	};
}

// ──────────────────────── requestUserApproval ────────────────────────

/**
 * 请求用户审批（按 mode 分发）。
 *
 * @param req 审批请求数据（工具名 + 命令 + 原因 + 可选 AI 预分类）
 * @param _ctxUnused 未使用（保留签名对称性；实际 UI ctx 在 approvalCtx）
 * @param signal abort signal（racing 用：AI 赢时 abort，UI 短路）
 * @param approvalCtx UI 上下文（mode + ui.*）
 * @returns UserDecision（approved + reason）
 */
export async function requestUserApproval(
	req: ApprovalRequest,
	_ctxUnused: ToolInvocationContext,
	signal: AbortSignal | undefined,
	approvalCtx: ApprovalContext,
): Promise<UserDecision> {
	switch (approvalCtx.mode) {
		case "tui":
			return await requestTui(req, signal, approvalCtx);
		case "rpc":
			// M2：传 signal 给 requestRpc（abort 时短路 + 透传给 ui.select 关闭对话框）
			return await requestRpc(req, signal, approvalCtx);
		case "json":
		case "print":
		default:
			// headless 立即 fail-closed deny（无 UI 无 AI 可判）。
			// auto 模式的 Racing 在 headless 下不调用此路径（见 runLayer3WithRacing 的 isHeadless 分支）。
			return requestHeadless(req, approvalCtx);
	}
}

// ──────────────────────── TUI 分支（G3 + G4） ────────────────────────

/** TUI 模式：ctx.ui.custom + ApprovalComponent。G3：先检查 signal.aborted。 */
async function requestTui(
	req: ApprovalRequest,
	signal: AbortSignal | undefined,
	approvalCtx: ApprovalContext,
): Promise<UserDecision> {
	// G3 修正：AI 先于 UI factory 执行时，controller.abort() 已触发但 comp 未创建。
	// 在调 ctx.ui.custom 前检查 signal.aborted，短路返回 deny（fail-closed）。
	if (signal?.aborted) {
		approvalCtx.ui.notify(`[pi-permission] approval aborted before prompt: ${req.toolName}`, "warning");
		return { approved: false, reason: "aborted before prompt (AI won the race)" };
	}

	return approvalCtx.ui.custom<UserDecision>((tui, _theme, _kb, done) => {
		const comp = new ApprovalComponent(req, tui as TuiLike, done);
		// signal abort → comp.cancel()（复用 _resolved 守卫，避免二次 done）
		if (signal) {
			signal.addEventListener("abort", () => comp.cancel(), { once: true });
		}
		return comp;
	});
}

// ──────────────────────── RPC 分支 ────────────────────────

/** RPC 模式：ctx.ui.select（GUI 单选对话框）+ W6 T9 G3 Reject-with-Reason。 */
async function requestRpc(
	req: ApprovalRequest,
	signal: AbortSignal | undefined,
	approvalCtx: ApprovalContext,
): Promise<UserDecision> {
	const title = formatTitle(req);
	// TODO: spec 未要求 session/always scope，当前仅支持 once。
	// 未来如需扩展，options 加 "Approve (session)" / "Approve (always)"，并在 UserDecision
	// 上新增 scope 字段承载（当前 UserDecision 只有 approved/reason）。
	const options = ["Approve (once)", "Deny"];
	// M2：与 requestTui 一致——调 select 前检查 signal.aborted 短路（AI 先于对话框弹出赢 race 时，
	// controller.abort() 已触发但 select 尚未发起，这里 fail-closed deny 避免弹出无意义对话框）。
	if (signal?.aborted) {
		approvalCtx.ui.notify(`[pi-permission] approval aborted before prompt: ${req.toolName}`, "warning");
		return { approved: false, reason: "aborted before prompt (AI won the race)" };
	}
	// M2：把 signal 透传给 ui.select（SDK 支持 { signal } options），AI 赢 race abort 时关闭对话框。
	const choice = await approvalCtx.ui.select(title, options, signal ? { signal } : undefined);
	if (choice === undefined) {
		return { approved: false, reason: "user dismissed the prompt" };
	}
	if (choice.startsWith("Approve")) {
		return { approved: true, reason: "approved via rpc" };
	}
	// W6 T9 G3：Reject-with-Reason。用户选 Deny 后，若 ctx.ui.input 存在则采集真实理由。
	// 「受阻」可观测条件：typeof ctx.ui.input === 'function'。
	return { approved: false, reason: await collectRejectReason(req, approvalCtx) };
}

/**
 * W6 T9 G3：采集拒绝理由（Reject-with-Reason）。
 *
 * 可观测条件：ctx.ui.input 存在（typeof === 'function'）→ 弹文本输入框采集真实 reason。
 * 否则 fallback 固定文案（"denied via <mode>"）。
 *
 * 空输入（用户直接回车）也 fallback 固定文案（不强制要求理由）。
 *
 * @param req 审批请求（用于构造提示标题）
 * @param approvalCtx UI 上下文
 * @returns 拒绝理由字符串（真实采集或 fallback）
 */
export async function collectRejectReason(
	req: ApprovalRequest,
	approvalCtx: ApprovalContext,
): Promise<string> {
	// 「受阻」可观测条件：ctx.ui.input 必须是函数
	if (typeof approvalCtx.ui.input !== "function") {
		return `denied via ${approvalCtx.mode}`;
	}
	try {
		const reason = await approvalCtx.ui.input(
			`[pi-permission] Reason for denying ${req.toolName}${req.command ? `: ${req.command}` : ""} (optional, press Enter to skip)`,
			"Why are you denying this?",
		);
		// 空输入或 undefined（用户跳过）→ fallback
		if (reason === undefined || reason.trim().length === 0) {
			return `denied via ${approvalCtx.mode}`;
		}
		return `denied via ${approvalCtx.mode}: ${reason.trim()}`;
	} catch {
		// input 调用异常 → fail-soft fallback（不阻塞 deny）
		return `denied via ${approvalCtx.mode}`;
	}
}

// ──────────────────────── headless 分支 ────────────────────────

/**
 * headless（json/print）：无交互 UI → fail-closed deny。
 *
 * 此函数服务于 strict/approve 的 `askUser` 路径——这些路径无 AI 层可兜底，
 * headless 下既无法问用户也无法判风险，立即 deny 是唯一正确行为。
 *
 * auto 模式的 Racing（`runLayer3WithRacing`）在 headless 下不调用此函数——
 * `CheckPermissionDeps.isHeadless()` 让 Racing 跳过 user promise，纯等 AI 判定
 * （M1 修正：headless 下 auto 应让 AI classifier 有机会赢，而非立即 deny 退化成 strict）。
 */
function requestHeadless(req: ApprovalRequest, approvalCtx: ApprovalContext): UserDecision {
	approvalCtx.ui.notify(`[pi-permission] headless mode auto-deny: ${req.reason}`, "warning");
	return { approved: false, reason: `headless mode (${approvalCtx.mode}): cannot prompt, auto-deny` };
}

// ──────────────────────── 辅助：字段集内核 + 标题格式化 ────────────────────────

/**
 * E6（M6/D5）：审批卡字段集（内核，唯一字段来源）。
 *
 * 「审批卡显示哪些内容」由 buildApprovalFieldSet 单点决定；两外壳只做排版——
 * formatTitle（RPC）压紧凑行数组（AI 单行摘要 + reasoning 行），renderApprovalView
 * （TUI）展开缩进块。排版是两外壳的形态差异，不属双写。
 */
interface ApprovalFieldSet {
	title: string;
	tool: string;
	command: string | undefined;
	reason: string;
	ai?: {
		risk: string;
		outcome: string;
		confidence: number;
		reasoning: string;
	};
}

/** 构造审批卡字段集（title/tool/command/reason + 可选 AI 四元组含 reasoning）。 */
function buildApprovalFieldSet(req: ApprovalRequest): ApprovalFieldSet {
	return {
		title: "[pi-permission] Approval required",
		tool: req.toolName,
		// 空字符串与 undefined 同义（两外壳的 Command 行都只在非空时渲染）
		command: req.command !== undefined && req.command.length > 0 ? req.command : undefined,
		reason: req.reason,
		...(req.preClassification
			? {
					ai: {
						risk: req.preClassification.risk_level,
						outcome: req.preClassification.outcome,
						confidence: req.preClassification.confidence,
						reasoning: req.preClassification.reasoning,
					},
				}
			: {}),
	};
}

/**
 * 格式化审批标题（RPC select）。消费字段集，压成紧凑行数组（6 行）。
 * M6 漂移修复：补 reasoning 行——此前 RPC 用户看不到 AI 理由（TUI 一直有）。
 */
function formatTitle(req: ApprovalRequest): string {
	const fields = buildApprovalFieldSet(req);
	const lines: string[] = [];
	lines.push(fields.title);
	lines.push(`Tool: ${fields.tool}`);
	if (fields.command !== undefined) {
		lines.push(`Command: ${fields.command}`);
	}
	lines.push(`Reason: ${fields.reason}`);
	if (fields.ai) {
		lines.push(`AI: risk=${fields.ai.risk} outcome=${fields.ai.outcome} (conf=${fields.ai.confidence})`);
		lines.push(`  reasoning: ${fields.ai.reasoning}`);
	}
	return lines.join("\n");
}

// ──────────────────────── ApprovalComponent（TUI 组件，G4 invalidate） ────────────────────────

/** 最小 TUI 接口（满足真实 TUI 和测试 stub）。 */
interface TuiLike {
	requestRender(): void;
}

/**
 * TUI 审批组件（简化版，参考 ask-user AskUserComponent）。
 *
 * 显示：标题 + 工具名 + 命令 + 原因 + 可选 AI 预分类 + 操作提示。
 * 键位：Enter → approve；Esc → deny/cancel（y/n 快捷键已移除，测试钉住 no-op）。
 *
 * G4：implements Component，补 invalidate()（调 tui.requestRender()）。
 * signal abort → cancel()（复用 _resolved 守卫）。
 *
 * TODO W6：若需更丰富的 TUI（方向键选择 once/session/always scope、高亮风险等级、
 * Reject-with-Reason 的内联文本输入），参考 ask-user AskUserComponent 的 SelectList
 * + pi-tui Input 组件集成。当前简化版的 deny 走固定文案（RPC 分支已接入 ctx.ui.input
 * 采集真实理由，TUI 分支因 Input 组件集成成本较高暂保留简化 deny，后续迭代补齐）。
 */
export class ApprovalComponent implements Component {
	private readonly req: ApprovalRequest;
	private readonly tui: TuiLike;
	private readonly done: (result: UserDecision) => void;
	private _resolved = false;

	// 渲染缓存（width → lines），invalidate 清空。
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(req: ApprovalRequest, tui: TuiLike, done: (result: UserDecision) => void) {
		this.req = req;
		this.tui = tui;
		this.done = done;
		this.invalidate();
	}

	/** G4：Component 接口要求。失效渲染缓存 + 请求重绘。 */
	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private rerender(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}
		const lines = renderApprovalView(this.req, width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): void {
		if (this._resolved) return;
		// Enter → approve
		if (matchesKey(data, "enter")) {
			this.approve();
			return;
		}
		// Esc → deny
		if (matchesKey(data, "escape")) {
			this.deny();
			return;
		}
		// 其他键 no-op（不泄漏）
	}

	private approve(): void {
		if (this._resolved) return;
		this._resolved = true;
	// TODO: spec 未要求 session/always scope，当前硬编码 "once"。未来如需扩展，
	// 增加 handleInput 对应键位（如 's' → session、'a' → always），并在 UserDecision
	// 上新增 scope 字段承载（当前 UserDecision 只有 approved/reason）。
		this.done({ approved: true, reason: "approved via tui" });
	}

	private deny(): void {
		if (this._resolved) return;
		this._resolved = true;
		this.done({ approved: false, reason: "denied via tui" });
	}

	/** 取消（signal abort 调用）。复用 _resolved 守卫，避免二次 done。 */
	cancel(): void {
		if (this._resolved) return;
		this._resolved = true;
		this.done({ approved: false, reason: "cancelled (signal abort)" });
	}
}

/** box 边框左右各占用 1 列（│ × 2） */
const BORDER_OVERHEAD = 2;

/** 渲染审批视图（纯函数，便于单测）。消费字段集（E6 内核），排版为 TUI 展开块。 */
export function renderApprovalView(req: ApprovalRequest, width: number): string[] {
	const fields = buildApprovalFieldSet(req);
	const innerWidth = Math.max(0, width - BORDER_OVERHEAD); // 减去左右边框
	const inner: string[] = [];
	inner.push(fields.title);
	inner.push("");
	inner.push(`Tool: ${fields.tool}`);
	if (fields.command !== undefined) {
		inner.push(`Command: ${fields.command}`);
	}
	inner.push(`Reason: ${fields.reason}`);
	if (fields.ai) {
		inner.push("");
		inner.push(`AI classification:`);
		inner.push(`  risk: ${fields.ai.risk}`);
		inner.push(`  outcome: ${fields.ai.outcome}`);
		inner.push(`  confidence: ${fields.ai.confidence}`);
		inner.push(`  reasoning: ${fields.ai.reasoning}`);
	}
	inner.push("");
	inner.push("[Enter] Approve  [Esc] Deny");

	// 用 box 边框包裹
	const lines: string[] = [];
	lines.push(`┌${"─".repeat(innerWidth)}┐`);
	for (const line of inner) {
		const padded = truncateToWidth(line, innerWidth, "", true);
		lines.push(`│${padded}│`);
	}
	lines.push(`└${"─".repeat(innerWidth)}┘`);
	return lines;
}

// re-export SelectItem 仅为测试便利（mock ctx.ui.select 时构造选项）
export type { SelectItem };
