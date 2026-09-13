// src/index.ts
//
// @zhushanwen/pi-ext-guards —— pi 运行环境守卫共享库（不是 Pi extension，零依赖纯函数，
// 无 pi SDK peerDep——供任意 @zhushanwen/pi-* 包与子代理核心消费）。
//
// 背景与设计依据：docs/architecture/file-lock-unification-and-reaper-sink.md §2.2 P3 / §3.2 D3。
// pi 的 extension 缓存按 cwd 失效：switch_session 时 cwd 不变则 factory 被二次调用且
// handler 累积注册——session_start handler 的真实派发语义是「每 session × factory
// 调用次数」，不是「每 session 一次」。handler 体内的跨 session 副作用操作（写非本
// session 的文件 / 注册定时器 watcher / 扫描目录 / 进程操作）因此会被双跑（2026-09-01
// reaper 双跑即此形态）。本包把这类「pi 运行环境隐式坑」的守卫集中一处，业务
// extension 引入即用，防线不再散落各包内联。

/** 一次执行的结果记录：正常返回记值、抛错记错误——两者都不释放 key。 */
type ExecutionRecord =
	| { readonly outcome: "returned"; readonly value: unknown }
	| { readonly outcome: "threw"; readonly error: unknown };

// 「按进程去重」的物理载体 = 模块级 Map。有效前提：同一进程内模块级状态跨 factory
// 二调持久——pi extension 缓存按 cwd 失效时 factory 重跑，但 jiti/Node 模块缓存同图
// 共享、模块 top-level 不重执行（handler 累积注册正是同一机制的另一面），故 Map 在
// 二调之间存活，去重成立。
const executions = new Map<string, ExecutionRecord>();

/**
 * 进程内按 key 去重地执行 fn：同一 key 至多执行一次，后续调用重放首次结果。
 *
 * 语义细节（设计 §3.2 D3 守卫粒度段 + §3.3 D3 守卫语义）：
 *
 * - **结果缓存形态（非跳过）**：首次调用执行 fn 并缓存结果；后续同 key 调用不执行
 *   fn，返回首次的返回值——原样重放：对象返回严格同一引用（toBe 级，非重新求值）；
 *   fn 返回 Promise 时重放同一实例，因此 **rejected Promise 同样被缓存**、不因
 *   rejection 释放 key。
 * - **fn 抛错不吞、key 不释放**：同步抛错原样上抛（守卫不捕获、不包装），同时记录
 *   该错误——后续同 key 调用重抛同一错误实例、不再执行 fn。验收条款「fn 抛错不阻断
 *   后续 handler」的准确语义是**守卫不吞 fn 的错误**（调用方 catch 守卫调用即可继续
 *   handler 后续逻辑，先例：base-tool-enhance runSessionStartMaintenance 的 try/catch
 *   形态），而非把 key 释放给二次执行——失败释放会让 factory 二调双跑窗口重新打开
 *   （本次事故形态），与 u-bte-guard 内联 flag 先例「reap 抛错不重置 flag」同语义。
 *   失败重试不归守卫：需要兜底的场景由宿主的其他触发面承接（该先例的失败兜底即交
 *   runtime 收殓触发面 B）。
 * - **粒度边界**：只包「跨 session 副作用操作」（进程级全局维护类，正确频率就是每
 *   进程至多一次）。session 级幂等操作（如 pending 对账——读当前 session 的 entries
 *   与 registry，appendEntry 幂等）必须保持每 session_start 执行，不要挂本守卫；需要
 *   「每 session 一次」语义的 handler 属另一设计，本包明确不提供。
 * - **key 是进程内全局命名空间**：跨包共享一个 Map，调用方须用「包名:操作名」前缀
 *   （如 "base-tool-enhance:reap"）避免撞 key。
 *
 * @param key 去重键（进程内全局，建议带包名前缀）
 * @param fn 无参函数——首次调用时求值一次，后续调用不再执行；需要上下文（pi/ctx）
 *   的调用方在闭包里捕获，被闭包捕获的是首次调用处的值（这正是「每进程至多一次」
 *   的字面语义）
 * @returns 首次执行的返回值（后续调用重放同一结果；async fn 重放同一 Promise 实例）
 */
export function oncePerProcess<T>(key: string, fn: () => T): T {
	const hit = executions.get(key);
	if (hit !== undefined) {
		if (hit.outcome === "threw") {
			throw hit.error;
		}
		// 同 key 的值由首次调用的泛型参数化记录，模块级 Map 无法按 key 参数化类型，
		// 断言仅收窄回该泛型（构造点与重放点同函数，无跨来源混装）。
		return hit.value as T;
	}
	try {
		const result = fn();
		executions.set(key, { outcome: "returned", value: result });
		return result;
	} catch (error) {
		executions.set(key, { outcome: "threw", error });
		throw error;
	}
}

/**
 * 从任意 thrown 值提取可读的错误信息字符串：Error → `.message`，其它 → `String(value)`。
 *
 * 收敛各 extension 包散落的 `e instanceof Error ? e.message : String(e)` 样板
 * （与 core/renderer/runtime/subagent-core/electron 各自持有的同名 helper 同实现——
 * 本包是 extensions 体系的共享归宿，业务包不再各自内联）。
 */
export function toErrorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ── stale ctx 守卫（guardStaleCtx，崩溃韧性 D1）────────────────────────
//
// 背景（docs/design/crash-resilience.md §3.3 D1 / §2.2 事件 E1）：pi 的 extension API
// 对象（pi / ctx）在 session 替换（newSession/fork/switchSession/reload）后被 runner
// 标记 stale，再调用其方法会**同步抛错**（loader.js/runner.js 的 assertActive，错误文案
// 含 STALE_CTX_MARKER）。跨 session 生命周期存活的异步回调（compact 的 onComplete/onError、
// timer tick、延迟回调）在该窗口触碰 pi/ctx = pi 进程被无人接的同步 throw 炸死（9/3 E1
// 实锤：smart-context compact onError → sendUserMessage → assertActive → exit 1）。
// GUI 的每次切 session/新建/重载都在制造失效窗口——这是「pi 单独用不崩、套 GUI 就崩」
// 的核心机制差异。本守卫把 scheduler 已验证的防御范式（G1 代际前置检查 + F2 catch 文案
// 分诊）泛化成共享原语，接入方不再各自内联。

/**
 * pi ExtensionRunner 在 session 替换后标记 stale ctx 的错误文案片段。
 *
 * pi 语义断言（0.84.4 实装：runner.js `invalidate()` 默认 message + `assertActive()`
 * `throw new Error(this.staleMessage)`），登记于 docs/pi-semantics.json PS-30
 * （探针：extensions/shared/ext-guards/src/__tests__/pi-semantics-stale-ctx-wording.test.ts），
 * 随 C-proc-08 pi 版本门禁自动重验。文案变更时守卫退化为「全部上抛」（回到现状崩溃链路，
 * 有 pi-crash log 取证，不更危险），门禁报红提示更新分诊词。
 */
export const STALE_CTX_MARKER = "stale after session replacement";

/** guardStaleCtx 的可选项。全部可选——最简接入 = 只传 fn（纯文案兜底分诊）。 */
export interface GuardStaleCtxOptions {
	/** 观测标签（默认降级日志的前缀，建议 "包名:场景" 形态）。 */
	label?: string;
	/**
	 * 前置代际检查（G1 形态，主判）：返回 true 表示本回调所属的 session 已被替换，
	 * 守卫完全不执行 fn、直接走 stale 降级。调用方注入，同 scheduler 的模块级代数
	 * 计数器模式（session_start 递增模块级代数，旧代闭包捕获值 < 模块值即 stale）。
	 * 缺省（不注入）恒视为非 stale——前置检查关闭，完全依赖错误文案兜底分诊
	 * （D1 降级语义声明：无代际计数器的接入方合法形态，文案由 PS-30 门禁守卫）。
	 */
	isCtxStale?: () => boolean;
	/**
	 * stale 降级通知（静默降级的观测点）：前置检查命中时无参调用；fn 抛错被分诊为
	 * stale 时以捕获的错误为参调用。缺省 = 仅 XYZ_AGENT_DEBUG=1 时写一行 stderr
	 * debug（本包零依赖、无 pi handle，不能走 extension-logger；需要落盘日志的
	 * 接入方传入自己的 debugLog/logger.warn）。
	 */
	onStale?: (error?: unknown) => void;
}

/** PromiseLike 判定（in 收窄，无 cast）：守卫据此为 async fn 的 rejection 挂同一分诊。 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

/** 缺省降级通知：XYZ_AGENT_DEBUG=1 时 stderr 一行（对齐 extensions 包 XYZ_AGENT_DEBUG 惯例）。 */
function defaultOnStale(label: string, error?: unknown): void {
	if (process.env.XYZ_AGENT_DEBUG !== "1") return;
	const detail =
		error === undefined
			? "generation check (isCtxStale)"
			: error instanceof Error
				? error.message
				: String(error);
	const prefix = label === "" ? "" : ` (${label})`;
	process.stderr.write(`[ext-guards] stale ctx degraded${prefix}: ${detail}\n`);
}

/**
 * 包裹「跨 session 生命周期存活的异步回调」：stale ctx 错误静默降级，非 stale 错误
 * 原样上抛（守卫不吞真实 bug）。消灭 E1 型崩溃源（crash-resilience D1）。
 *
 * 语义三段（与 scheduler 范式逐条对应，scheduler/runtime.ts startScheduler 是迁移先例）：
 *
 * 1. **前置代际检查（G1 形态，主判）**：`opts.isCtxStale?.()` 为 true → 不执行 fn
 *    （完全不触碰捕获的 stale pi/ctx）、调 `opts.onStale?.()`（无参）、返回 undefined。
 * 2. **fn 同步执行 + 同步抛错分诊（F2 形态的同步面）**：错误文案含
 *    `STALE_CTX_MARKER`（或抛错后 isCtxStale 翻转）→ 调 `opts.onStale?.(error)`、
 *    返回 undefined；**非 stale 类错误原样上抛**——守卫不吞真实 bug（上抛的崩溃链路
 *    与 E1 相同，有 pi-crash log 取证 + 错误规格表走 T4 恢复链路）。
 * 3. **Promise 透传分诊（F2 形态的异步面）**：fn 返回 Promise 时守卫对 rejection
 *    挂同一分诊——stale → resolve 为 undefined，非 stale → 原样 reject 给调用方的
 *    `.catch`。返回的是新 Promise 实例（原实例的 rejection 已被守卫接管，调用方不得
 *    再对原实例挂 then/catch，否则非 stale 错误会走原实例 rejection）。
 *
 * 分诊谓词 = `isCtxStale?.() || message.includes(STALE_CTX_MARKER)`，与 scheduler
 * 迁移前字面一致：代际为主判（不依赖 pi 文案），文案为兜底（覆盖 reload 产生全新
 * 模块环境后旧闭包代数冻结、isCtxStale 恒 false 的盲区）。
 *
 * @param fn 无参回调（闭包捕获业务所需的 pi/ctx——被捕获的是注册时的引用，这正是
 *   stale 风险的来源，也是守卫存在的理由）
 * @returns fn 的返回值；stale 降级路径返回 undefined（前置检查命中时 fn 未执行、无
 *   Promise 可言，故 async 重载的返回类型是 `Promise<R | undefined> | undefined`——
 *   前置命中即 undefined）。fire-and-forget 调用方直接 `void`；需要接非 stale 错误的
 *   调用方（scheduler tick 形态）用 `?.catch`——前置命中返回 undefined 时无 rejection
 *   可接（retireStaleTimer 已由 onStale 执行），非 stale rejection 才会流到 `.catch`。
 *
 * @example fire-and-forget 回调（smart-context compact onError）
 * ```ts
 * onError: (err) => guardStaleCtx(() => pi.sendUserMessage(...), { label: "smart-context:compact" })
 * ```
 * @example timer tick（scheduler 迁移形态：非 stale 错误外层 warn 不终止调度）
 * ```ts
 * void guardStaleCtx(() => this.tickScheduler(), { isCtxStale, onStale: () => this.retireStaleTimer() })
 *   ?.catch((err) => logger.warn("tick error", { error: toErrorMessage(err) }));
 * ```
 */
export function guardStaleCtx<R>(
	fn: () => Promise<R>,
	opts?: GuardStaleCtxOptions,
): Promise<R | undefined> | undefined;
export function guardStaleCtx<R>(fn: () => R, opts?: GuardStaleCtxOptions): R | undefined;
export function guardStaleCtx(fn: () => unknown, opts?: GuardStaleCtxOptions): unknown {
	const label = opts?.label ?? "";
	const isCtxStale = opts?.isCtxStale;
	const onStale = opts?.onStale;
	const isStale = (): boolean => isCtxStale?.() ?? false;
	// 与 scheduler 迁移前字面一致的分诊谓词：代际主判 || 文案兜底
	const triage = (error: unknown): boolean =>
		isStale() || toErrorMessage(error).includes(STALE_CTX_MARKER);
	const reportStale = (error?: unknown): void => {
		if (onStale !== undefined) {
			// 前置命中（无捕获错误）无参调用；文案分诊命中携带错误——保持 JSDoc 契约
			if (error === undefined) onStale();
			else onStale(error);
		} else {
			defaultOnStale(label, error);
		}
	};

	// 1. 前置代际检查：stale 则完全不触碰捕获的 pi/ctx（P-guard-holds 的守卫第一道）
	if (isStale()) {
		reportStale();
		return undefined;
	}

	// 2. fn 同步执行 + 同步抛错分诊
	let result: unknown;
	try {
		result = fn();
	} catch (error) {
		if (triage(error)) {
			reportStale(error);
			return undefined;
		}
		throw error;
	}

	// 3. async fn：rejection 走同一分诊（stale → resolve undefined；非 stale → 原样 reject）
	if (isPromiseLike(result)) {
		return result.then(undefined, (error: unknown) => {
			if (triage(error)) {
				reportStale(error);
				return undefined;
			}
			throw error;
		});
	}
	return result;
}
