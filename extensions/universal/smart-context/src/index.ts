/**
 * @zhushanwen/pi-smart-context 入口：事件接线 + 门控。
 *
 * - session_start：session 级闭包状态重建（规范 Session 隔离：熔断计数不跨 session）
 *   + fired 档位从 session entries 重建（D15：reload/进程重启同 session 不重复提醒）
 * - subagent 进程（R6）：不注册工具、不提醒（宁缺勿污）
 * - session_before_compact：双模式接管（compact-handler）
 * - session_compact：重置提醒 fired（D3）
 * - agent_settled：越档检查 + marker 持久化 + 静默注入（D3/D4/D15）
 * - model_select：跨界通知 + downshift 提醒（D5）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { guardStaleCtx, isSubagentProcess, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { setPiHandle } from "@zhushanwen/pi-extension-logger";

import {
	createBeforeCompactHandler,
	createTakeoverState,
	debugLog,
	type TakeoverState,
} from "./compact-handler.js";
import { buildDownshiftNotice, buildSwitchNotice, buildThresholdReminder } from "./reminder.js";
import { registerCompactContextTool } from "./tool.js";
import {
	countCompactions,
	deriveFiredThresholds,
	findCrossedThresholds,
	FIRED_ENTRY_CUSTOM_TYPE,
	getCurrentModelId,
	isGatingActive,
	loadSmartContextConfig,
	THRESHOLD_REMINDER_CUSTOM_TYPE,
	type EntryLike,
} from "./pure.js";

/** session 级闭包状态（规范：模块级仅工厂函数，状态在 session_start 重建）。 */
interface SessionState {
	takeover: TakeoverState;
	/** 已提醒档位（token 值为键；session_compact 清空，D3）。 */
	firedThresholds: Set<number>;
	/** fired 是否已从 session entries seed 过（D15：每次状态重建恰好 seed 一次）。 */
	firedSeeded: boolean;
}

/** session 级状态唯一构造点（初始态与 session_start 重建同源，新增字段不落两处）。 */
function createSessionState(): SessionState {
	return { takeover: createTakeoverState(), firedThresholds: new Set(), firedSeeded: false };
}

// G1 代际检测（crash-resilience D1，同 scheduler/src/index.ts 的模块级代数计数器范式）：
// 必须声明在模块级而非 factory 体内——pi 每次 session 替换（newSession/fork/switchSession）
// 都重跑 extension factory 函数体（extensionCache 只缓存 factory 函数对象），闭包级声明
// 每次重跑即重置，各代的 isCtxStale 恒 false。模块级声明下 extensionCache 命中期间共享
// 同一模块绑定，计数器跨 factory 重跑保留递增：新代 session_start 递增后，旧代闭包捕获
// 的代数从此小于模块值 → isCtxStale 生效。残余盲区（显式 reload 触发 jiti 重新 import
// 产生全新模块环境）由 guardStaleCtx 的 STALE_CTX_MARKER 文案兜底分诊覆盖（PS-30 门禁）。
let sessionGeneration = 0;

/**
 * pi-smart-context extension 工厂函数。
 *
 * agent 自决上下文压缩：compact_context 工具 + 双模式接管生成（same-model kv-cache /
 * cross-model 廉价模型）+ 3 档阈值提醒 + 排除模型门控与切换通知。
 */
export default function smartContextExtension(pi: ExtensionAPI): void {
	// 日志通道注入（extension-logger 两阶段初始化：工厂拿 pi → setPiHandle）
	setPiHandle(pi);

	// R6：subagent 子进程不注册工具、不提醒（宁缺勿污；TAIJI_AGENT_SUBAGENT 标记——
	// ext-guards isSubagentProcess，ext-simplify-17 D4 重锚）
	if (isSubagentProcess()) {
		debugLog("subagent process detected, staying inert");
		return;
	}

	// session 级状态（session_start 重建闭包；模块级引用仅指向当前 session 的容器）
	let state: SessionState = createSessionState();

	// G1 代际比对闭包（isCtxStale）：session_start 装配本代比对（读实时模块级代数），
	// 供下方事件回调与 compact 工具回调的 guardStaleCtx 前置检查使用——stale 分诊不依赖
	// pi 错误文案。首个 session_start 前无 session，恒 false 为安全默认。
	let isCtxStale: () => boolean = () => false;

	/**
	 * fired 档位 seed（D15）：从 session entries 重建已提醒档位。
	 *
	 * reload 会重跑 factory（+ jiti 重新 import）清零闭包/模块态，且 pi 发的 session_start
	 * reason 是 `startup`（见 pure.ts FIRED_ENTRY_CUSTOM_TYPE 注释）——只能从 session 自身
	 * 的 marker entry 恢复。`firedSeeded` 保证每次状态重建只 seed 一次（settle 热路径不重复扫 entries）。
	 *
	 * ctx 可能缺 sessionManager（测试 / 极早期窗口）→ 逐层降级为空集，不阻断提醒链路。
	 */
	const seedFiredThresholds = (ctx: ExtensionContext): void => {
		if (state.firedSeeded) return;
		state.firedSeeded = true;
		try {
			const entries = ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>;
			state.firedThresholds = deriveFiredThresholds(entries);
			if (state.firedThresholds.size > 0) {
				debugLog(`fired thresholds restored from session entries: ${[...state.firedThresholds].join(",")}`);
			}
		} catch (error) {
			// 恢复失败降级为空集（最坏结果 = 同档多提醒一次，不阻断主流程）
			debugLog(`fired thresholds restore failed: ${toErrorMessage(error)}`);
		}
	};

	/**
	 * compaction 计数读取（D13-12 降智提示判据）：entries 读取异常 → 0。
	 * 拆函数是为了不走同一条 try：提醒投递本身不依赖 entries（marker 写入 / 静默注入都能成），
	 * 降智提示只是附加行——读失败不得把整条提醒一起拆掉。
	 */
	const readCompactionCount = (ctx: ExtensionContext): number => {
		try {
			return countCompactions(ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>);
		} catch (error) {
			debugLog(`compaction count read failed: ${toErrorMessage(error)}`);
			return 0;
		}
	};

	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		// 先递增模块级代数再装配：自此同模块环境内所有前代闭包的 isCtxStale 返回 true
		sessionGeneration += 1;
		const myGeneration = sessionGeneration;
		isCtxStale = () => sessionGeneration !== myGeneration;
		state = createSessionState();
		seedFiredThresholds(ctx);
	});

	// ── 压缩生成接管（D1/D12）──
	const beforeCompact = createBeforeCompactHandler(
		pi,
		() => state.takeover,
		loadSmartContextConfig,
	);
	pi.on("session_before_compact", beforeCompact);

	// ── 压缩完成：重置提醒档位（D3）──
	pi.on("session_compact", (_event, _ctx) => {
		state.firedThresholds.clear();
	});

	// ── 工具注册（常驻，不可用态由 execute 运行时校验拒绝，D5）──
	// isCtxStale 必须传 live 绑定 wrapper 而非简写属性：本行在 factory 体同步执行，简写
	// { isCtxStale } 会把此刻的初始 () => false 快照进 deps 对象，上方 session_start
	// handler 的重新赋值不回写已构造对象 → compact onComplete/onError（E1 实锤崩溃点）
	// 守卫的前置代际检查恒不生效。wrapper 每次调用读闭包当前绑定。
	registerCompactContextTool(pi, { isCtxStale: () => isCtxStale() });

	// ── 阈值提醒（D3/D4/D4'）：agent_settled 越档检查 + 静默注入（不触发 turn） ──
	pi.on("agent_settled", (_event, ctx) => {
		const config = loadSmartContextConfig();
		const modelId = getCurrentModelId(ctx.model);
		if (!isGatingActive(config, modelId)) return;

		// D15 兜底 seed：session_start 未送达本代实例（reload 后先 settle 后 start 的窗口）时补上
		seedFiredThresholds(ctx);

		const usage = ctx.getContextUsage();
		if (!usage) return; // R7：tokens 可能 null（压缩后首响应前）——findCrossedThresholds 容错
		const crossed = findCrossedThresholds(config.reminderThresholds, usage.tokens, state.firedThresholds);
		if (crossed.length === 0) return;

		for (const t of crossed) state.firedThresholds.add(t);
		const compactionCount = readCompactionCount(ctx);
		const message = buildThresholdReminder(crossed, usage.tokens ?? 0, usage.contextWindow, compactionCount);
		debugLog(`reminder fired: tiers=${crossed.join(",")} tokens=${usage.tokens}`);
		// D15：marker 落 session entries（先写，fire-once 语义优先于投递）——下次
		// reload/进程重启从这里重建 fired，同一档不再重复提醒。
		guardStaleCtx(() => {
			pi.appendEntry(FIRED_ENTRY_CUSTOM_TYPE, { tiers: crossed, tokens: usage.tokens ?? 0 });
		}, {
			isCtxStale,
			label: "smart-context:fired-marker",
			onStale: (error) => debugLog(`fired marker skipped (stale ctx): ${toErrorMessage(error)}`),
		});
		// D4'：静默注入——custom message + triggerTurn:false = 只进 LLM 上下文，不触发新 turn、
		// 不进对话流（display:false）。不再用 sendUserMessage（pi 语义：user message 恒触发
		// 一轮），避免用户已收工时被提醒强行唤醒烧一整轮全量上下文。
		// 用户继续对话时，模型在下一轮自然看到本提醒并自行决定是否 compact。
		// 防循环：crossed 全部已标记 fired，marker 也不会产生新 turn。
		// 事件回调内直接调用捕获的 pi——session 替换窗口可能 stale（crash-resilience D1
		// 普查接入点），守卫 stale 静默降级（不杀 pi 进程），非 stale 错误原样上抛。
		guardStaleCtx(() => {
			pi.sendMessage(
				{ customType: THRESHOLD_REMINDER_CUSTOM_TYPE, content: message, display: false },
				{ triggerTurn: false },
			);
		}, {
			isCtxStale,
			label: "smart-context:threshold-reminder",
			onStale: (error) => debugLog(`threshold reminder delivery skipped (stale ctx): ${toErrorMessage(error)}`),
		});
	});

	// ── 模型切换：跨界通知 + downshift 提醒（D5，仅跨界时注入一次）──
	// event 类型由 on() 重载上下文推导为 SDK ModelSelectEvent（不在包根导出，省略标注）
	pi.on("model_select", (event, ctx) => {
		const config = loadSmartContextConfig();
		const modelId = getCurrentModelId(event.model);
		const previousModelId = getCurrentModelId(event.previousModel);
		if (modelId === "" || modelId === previousModelId) return;

		const nowExcluded = config.excludedModels.includes(modelId);
		const wasExcluded = config.excludedModels.includes(previousModelId);

		// 跨越排除边界：注入一条可用性变化通知（同边界内切换静默）
		if (config.enabled && nowExcluded !== wasExcluded) {
			const notice = buildSwitchNotice(nowExcluded ? "unavailable" : "available", modelId);
			debugLog(`switch notice: ${nowExcluded ? "unavailable" : "available"} (${modelId})`);
			// session 替换窗口可能 stale（D1 普查接入点）——守卫 stale 静默降级
			guardStaleCtx(() => {
				pi.sendUserMessage(notice, { deliverAs: "steer" });
			}, {
				isCtxStale,
				label: "smart-context:switch-notice",
				onStale: (error) => debugLog(`switch notice delivery skipped (stale ctx): ${toErrorMessage(error)}`),
			});
			return;
		}

		// downshift 检测：切到更小窗口模型且将触线 → 建议先压缩（不阻止切换）
		const usage = ctx.getContextUsage();
		const downshift = buildDownshiftNotice(
			usage?.tokens ?? null,
			event.previousModel?.contextWindow,
			event.model?.contextWindow,
		);
		if (downshift && isGatingActive(config, modelId)) {
			debugLog("downshift notice fired");
			// session 替换窗口可能 stale（D1 普查接入点）——守卫 stale 静默降级
			guardStaleCtx(() => {
				pi.sendUserMessage(downshift, { deliverAs: "steer" });
			}, {
				isCtxStale,
				label: "smart-context:downshift-notice",
				onStale: (error) => debugLog(`downshift notice delivery skipped (stale ctx): ${toErrorMessage(error)}`),
			});
		}
	});
}
