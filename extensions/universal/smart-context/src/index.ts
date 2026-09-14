/**
 * @zhushanwen/pi-smart-context 入口：事件接线 + 门控。
 *
 * 设计文档：docs/extensions/smart-context/design.md
 * - session_start：session 级闭包状态重建（规范 Session 隔离：fired 档位/熔断计数不跨 session）
 * - subagent 进程（R6）：不注册工具、不提醒（宁缺勿污）
 * - session_before_compact：双模式接管（compact-handler）
 * - session_compact：重置提醒 fired（D3）
 * - agent_settled：越档检查 + followUp 投递一次性提醒（D3/D4）
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
	findCrossedThresholds,
	getCurrentModelId,
	isGatingActive,
	loadSmartContextConfig,
	type EntryLike,
} from "./pure.js";

/** session 级闭包状态（规范：模块级仅工厂函数，状态在 session_start 重建）。 */
interface SessionState {
	takeover: TakeoverState;
	/** 已提醒档位（token 值为键；session_compact 清空，D3）。 */
	firedThresholds: Set<number>;
}

/** session 级状态唯一构造点（初始态与 session_start 重建同源，新增字段不落两处）。 */
function createSessionState(): SessionState {
	return { takeover: createTakeoverState(), firedThresholds: new Set() };
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

	// R6：subagent 子进程不注册工具、不提醒（宁缺勿污；XYZ_AGENT_SUBAGENT 标记——
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

	pi.on("session_start", (_event: unknown, _ctx: ExtensionContext) => {
		// 先递增模块级代数再装配：自此同模块环境内所有前代闭包的 isCtxStale 返回 true
		sessionGeneration += 1;
		const myGeneration = sessionGeneration;
		isCtxStale = () => sessionGeneration !== myGeneration;
		state = createSessionState();
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

	// ── 阈值提醒（D3/D4）：agent_settled 越档检查 + followUp 一次性投递 ──
	pi.on("agent_settled", (_event, ctx) => {
		const config = loadSmartContextConfig();
		const modelId = getCurrentModelId(ctx.model);
		if (!isGatingActive(config, modelId)) return;

		const usage = ctx.getContextUsage();
		if (!usage) return; // R7：tokens 可能 null（压缩后首响应前）——findCrossedThresholds 容错
		const crossed = findCrossedThresholds(config.reminderThresholds, usage.tokens, state.firedThresholds);
		if (crossed.length === 0) return;

		for (const t of crossed) state.firedThresholds.add(t);
		const compactionCount = countCompactions(ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>);
		const message = buildThresholdReminder(crossed, usage.tokens ?? 0, usage.contextWindow, compactionCount);
		debugLog(`reminder fired: tiers=${crossed.join(",")} tokens=${usage.tokens}`);
		// D4：followUp（agent 空闲后投递并触发一个 turn，可立即决定压缩）；
		// 防循环：crossed 全部已标记 fired，提醒触发的 settled 不会重复发。
		// 事件回调内直接调用捕获的 pi——session 替换窗口可能 stale（crash-resilience D1
		// 普查接入点），守卫 stale 静默降级（不杀 pi 进程），非 stale 错误原样上抛。
		guardStaleCtx(() => {
			pi.sendUserMessage(message, { deliverAs: "followUp" });
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
