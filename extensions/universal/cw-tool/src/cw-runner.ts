/**
 * cw 只读查询核心：白名单校验 + 参数构造 + spawn + 输出解析。
 *
 * cw 2.0 适配（Phase 2-B）：cw 2.0 删除了 1.x 的声明推进命令面（design/execute/
 * handoff 等），编排智能收进引擎（`cw run` runner + 账本 gate）。本扩展不再包写
 * 命令——写操作（create / evidence submit / review submit / verify / run）由
 * agent 经 bash 直接调 `cw`（用法见 cw-cli skill），本扩展只提供只读查询的结构化
 * 工具入口（cw_query：status / frontier / tree / report）。
 *
 * 1.x 的 workspace 门控（detectRepoWorkspace + --workspace 透传 + cw 版本探测）
 * 已随 2.0 适配删除：cw 2.0 store 布局为 `~/.cw/<encoded-cwd>/`（per-cwd，无
 * --workspace 参数），spawn 时传 cwd 即可。
 *
 * 与 Pi SDK 解耦（不 import pi 类型），纯逻辑 + 可注入 spawner，便于单测。
 * 所有错误路径返回 `{ ok: false, error }`，不抛异常（由调用方映射为 tool 返回）。
 */
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

import type { CwSpawner } from "./cw-spawn.ts";

/**
 * cw_query 工具的 action 白名单 = cw 2.0 只读命令面（dist/readonly/index.ts，
 * 2026-08-22 以 coding-workflow@2.0.1 核实）。
 *
 * 写命令（create / evidence submit / review submit / verify / run）不在工具面——
 * 需要推进流程时经 bash 调 `cw`，用法以 cw-cli skill 为 SSOT。
 */
export const CW_ACTIONS = ["status", "frontier", "tree", "report"] as const;
export type CwAction = (typeof CW_ACTIONS)[number];

/** 支持 `--json` 的 action（cw 2.0 规格锁定：仅 status / frontier）。 */
const JSON_ACTIONS = ["status", "frontier"] as const;

/** 支持 `--unit` 选择器的 action（status / report；tree / frontier 为全局视图）。 */
const UNIT_ACTIONS = ["status", "report"] as const;

/** 支持 `--root` 子树选择器的 action（仅 report；2.0 frontier 无 --root）。 */
const ROOT_ACTIONS = ["report"] as const;

/** 透传给 cw 的可选查询参数。 */
export interface CwToolOptions {
	/** unit id → `--unit <id>`（status 单 unit 详情 / report 单 unit 证据链）。 */
	unitId?: string;
	/** 子树根 id → `--root <id>`（report 子树汇总；与 unitId 互斥）。 */
	rootId?: string;
	/** 结构化输出 → `--json`（仅 status / frontier）。 */
	json?: boolean;
}

/** 工具返回的 details 结构（结构化成功/失败，调用方按 `ok` 区分）。 */
export type CwDetails =
	| { ok: true; action: string; stdout: string; parsed: true; data: unknown }
	| { ok: true; action: string; stdout: string; parsed: false }
	| { ok: false; action: string; error: string };

/**
 * 白名单校验。返回错误消息（string）或 undefined（放行）。
 *
 * 设计为 string-based，独立于 schema 枚举——schema 是 LLM 输入的第一道约束，
 * 此函数是 execute 内的防御性第二道（直接/程序化调用、宽松 provider 兜底），
 * 同时是单测的核心契约（直接调 executeCwAction 传任意 action 验证拦截）。
 */
export function rejectDisallowedAction(
	action: string,
	allowed: readonly string[],
	toolName: string,
): string | undefined {
	if (!allowed.includes(action)) {
		return `action "${action}" 不在 ${toolName} 白名单。允许的 action: ${allowed.join(", ")}。写命令（create / evidence / review / verify / run）请经 bash 调 cw，用法见 cw-cli skill。`;
	}
	return undefined;
}

const includesStr = (list: readonly string[], v: string): boolean => list.some((a) => a === v);

/**
 * 查询参数合法性校验（action × flag 匹配 + 互斥）。返回错误消息或 undefined（放行）。
 *
 * report 的 `--unit` / `--root` 在 cw 2.0 互斥；非 report 传 rootId、非 status/frontier
 * 传 json 属于本工具面错误（cw 2.0 对应命令不接受该 flag），前置拦截给出可操作错误。
 */
export function rejectInvalidQueryOptions(
	action: string,
	opts: CwToolOptions,
): string | undefined {
	if (opts.unitId !== undefined && !includesStr(UNIT_ACTIONS, action)) {
		return `action "${action}" 不支持 unitId（仅 ${UNIT_ACTIONS.join(" / ")} 接受 --unit）。`;
	}
	if (opts.rootId !== undefined && !includesStr(ROOT_ACTIONS, action)) {
		return `action "${action}" 不支持 rootId（仅 ${ROOT_ACTIONS.join(" / ")} 接受 --root）。`;
	}
	if (opts.json === true && !includesStr(JSON_ACTIONS, action)) {
		return `action "${action}" 不支持 json（cw 2.0 仅 ${JSON_ACTIONS.join(" / ")} 提供 --json）。`;
	}
	if (opts.unitId !== undefined && opts.rootId !== undefined) {
		return "unitId 与 rootId 互斥（cw report 的 --unit / --root 只能传其中一个）。";
	}
	return undefined;
}

/**
 * 构建 cw 命令行参数（action 后接 flags），flag 顺序 = 上方各 action 的注释序。
 *
 * - status：`[--unit <id>] [--json]`
 * - frontier：`[--json]`
 * - tree：无 flag
 * - report：`--unit <id>` 或 `--root <id>`（互斥，均省略 = 全账本）
 */
export function buildCwArgs(action: string, opts: CwToolOptions): string[] {
	const args: string[] = [action];
	if (opts.unitId !== undefined) {
		args.push("--unit", opts.unitId);
	} else if (opts.rootId !== undefined) {
		args.push("--root", opts.rootId);
	}
	if (opts.json === true) {
		args.push("--json");
	}
	return args;
}

/** 尝试把 stdout 解析为 JSON。成功返回解析值，失败返回 undefined。 */
function tryParseJson(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

/** cw spawn 默认超时（5 分钟）。cw 卡死时避免永久挂起 agent turn。 */
const DEFAULT_CW_TIMEOUT_MS = 300_000;

/**
 * 执行 cw 只读查询的核心逻辑：白名单校验 → 参数校验 → spawn → 解析。
 *
 * 失败判定：非零退出码（含被信号终止的 null）→ ok:false（stderr 折进错误消息）。
 * 成功后 stdout 尝试 JSON.parse：成功 → parsed:true + data；失败 → parsed:false + 原样 stdout。
 *
 * @param action   调用方请求的 action（运行时再校验白名单）。
 * @param allowed  该工具允许的 action 白名单。
 * @param toolName 工具名（错误消息归属用）。
 * @param opts     查询参数（unitId / rootId / json）。
 * @param spawner  spawn 实现（默认走真实 cw，测试注入 fake）。
 * @param cwd      子进程工作目录（cw 2.0 以 cwd 定位 `~/.cw/<encoded-cwd>/` 账本）。
 * @param signal   可选 SDK abort signal；与超时合并后透传给 spawner，abort 时 spawner kill 子进程。
 * @param timeoutMs spawn 超时（ms），默认 5 分钟；0 表示不限时。超时返回 ok:false "cw 超时"。
 */
export async function executeCwAction(
	action: string,
	allowed: readonly string[],
	toolName: string,
	opts: CwToolOptions,
	spawner: CwSpawner,
	cwd: string,
	signal?: AbortSignal,
	timeoutMs: number = DEFAULT_CW_TIMEOUT_MS,
): Promise<CwDetails> {
	const base = { action };

	const actionErr = rejectDisallowedAction(action, allowed, toolName);
	if (actionErr) return { ok: false, ...base, error: actionErr };

	const queryErr = rejectInvalidQueryOptions(action, opts);
	if (queryErr) return { ok: false, ...base, error: queryErr };

	const args = buildCwArgs(action, opts);

	// 合并 SDK abort signal 与超时为单个 signal 传给 spawner：spawner（默认实现）在 abort
	// 时 kill 子进程，避免 abort/超时后僵尸 cw 进程。
	const combined = new AbortController();
	let timedOut = false;
	const onSdkAbort = (): void => combined.abort();
	if (signal) {
		if (signal.aborted) combined.abort();
		else signal.addEventListener("abort", onSdkAbort, { once: true });
	}
	const timer =
		timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					combined.abort();
				}, timeoutMs)
			: undefined;

	let result;
	try {
		result = await spawner(args, undefined, cwd, combined.signal);
	} catch (err) {
		const msg = toErrorMessage(err);
		return { ok: false, ...base, error: `cw spawn 失败: ${msg}` };
	} finally {
		if (timer) clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onSdkAbort);
	}

	// 超时优先于结果判定（spawner 被 kill 后 resolve，exitCode 通常为 null）。
	if (timedOut) return { ok: false, ...base, error: "cw 超时" };

	const { stdout, stderr, exitCode } = result;

	// 按 exitCode 判定失败（防御性，不依赖 cw 是否向 stderr 写非错误诊断信息）。
	// 非零退出码（含 null=被信号终止）→ 失败；stderr 折进错误消息（成功时 stderr 不导致失败）。
	if (exitCode !== 0) {
		const parts: string[] = [`exit code ${exitCode ?? "null"}`];
		if (stderr.trim()) parts.push(stderr.trim());
		return { ok: false, ...base, error: parts.join(" | ") };
	}

	const data = tryParseJson(stdout);
	if (data !== undefined) {
		return { ok: true, ...base, stdout, parsed: true, data };
	}
	return { ok: true, ...base, stdout, parsed: false };
}
