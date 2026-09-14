/**
 * @zhushanwen/pi-base-tool-enhance 入口。
 *
 * M1：同名 override pi 内置 bash 工具 + 前台委托官方工厂 + 工具报错审计 hook（D11）。
 * M2：background 任务核心生命周期——bash background 分支（spawn 后台 + registry +
 * 轮询器单例任务表）、bash_output / bash_kill 工具、进程退出收殓、subagent 降级。
 * M3：pending-notifications 通知接入——load 时刷新轮询器通知通路的 pi 引用（D17
 * session 替换接管）+ 挂 exit 边沿通知回调（unregister emit + sendMessage steer）+
 * session_start 对账（appendEntry 权威路径兜底 pending 收尾）。
 * 收殓下沉（u-bte-remove）：M5 孤儿收殓已移交 xyz-agent runtime（background-task-
 * reaper 双触发面——session 销毁时 + 启动期兜底扫描，设计 file-lock-unification-
 * and-reaper-sink.md §3.2 D2），extension 不再做全局扫描/全局锁；session_start
 * 维护链仅剩 M3 对账（session 级豁免类，每 session_start 执行，D3 粒度段）。
 * 白名单与配置体系（M4 已交付）经 bash-tool execute 读时加载接入。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { createBashOutputToolDefinition } from "./bash-output-tool.ts";
import { createBashKillToolDefinition } from "./bash-kill-tool.ts";
import { createBashOverrideToolDefinition } from "./bash-tool.ts";
import { handleTaskExit, refreshPiReference } from "./background/notify.ts";
import { installProcessExitGuard } from "./background/process-exit-guard.ts";
import { reconcilePendingEntries } from "./background/pending-reconcile.ts";
import { setOnTaskExit } from "./background/poller.ts";
import { setupToolErrorAudit } from "./tool-error-audit.ts";

const logger = getLogger("base-tool-enhance");

export default function baseToolEnhanceExtension(pi: ExtensionAPI): void {
	// D17 pi 引用刷新：同进程 session 替换（/fork、选择器切换、RPC session.*）→ 新
	// ResourceLoader/eventBus + extension 重新 load → 本调用把通知通路（notify.ts
	// 模块级引用）切到新 pi——任务发起于旧 session 而完成通知投递新 session。
	refreshPiReference(pi);
	// ⑧⑨ 轮询器 exit 边沿 → pending:unregister emit + sendMessage steer（kill 路径
	// 不 sendMessage，见 notify.ts 单点归属规则）。重复 load 幂等（覆盖同一回调）
	setOnTaskExit(handleTaskExit);
	// 同名 "bash" 覆盖内置工具（pi agent-session _refreshToolRegistry：custom 定义后注册者胜）
	pi.registerTool(createBashOverrideToolDefinition());
	// 查询 / 终止工具（D9：独立小工具，kill 与查询权限语义分离）
	pi.registerTool(createBashOutputToolDefinition());
	pi.registerTool(createBashKillToolDefinition());
	// 进程级收殓（D12）：只认 process 信号/退出，绝不在 session_shutdown / dispose 路径
	installProcessExitGuard();
	// unified-hooks 退役承接：工具报错审计（D11 落点）
	setupToolErrorAudit(pi);
	// pending 对账（M3）：任意 session 启动触发（startup/reload/new/resume/fork 全
	// reason）。孤儿收殓已下沉 runtime（见文件头），本链无全局扫描
	pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
		runSessionStartMaintenance(pi, ctx, event.reason);
	});
}

/**
 * session_start 维护链（仅剩 M3 对账——收殓下沉 runtime 后，u-bte-remove）。
 *
 * 执行形态：同步直跑不 await——对账毫秒级（readRegistry + kill(pid,0) +
 * appendEntry），不构成 session 启动链延迟；错误吞掉记 warn（对账失败无害：僵尸
 * register 停留差集，下一 session_start 幂等重查）。
 *
 * 频率语义（D3 守卫粒度）：对账是 session 级操作（读当前 session 的 pi entries +
 * 当前 session 的 registry，appendEntry 幂等），属豁免类不挂进程级 once flag，
 * 每 session_start 都执行。桌面端每次激活是 startup+resume 双派发（factory 二调
 * 下 handler 还会累积），对账多次执行幂等无害；反之若挂进程级 flag，startup 消费
 * flag 后目标 session 的对账将永远被跳过（M3 对账在主链路被禁用，此处是唯一执行点）。
 *
 * 入口无条件 debug 日志（S6 观测通道）：每次 handler 派发都打，含 reason——
 * XYZ_AGENT_DEBUG=1 时落 extension 日志（默认 no-op），供「factory 二调下维护链
 * 行为」验收观测派发次数。变更登记（u-bte-remove）：reap 下沉 runtime 后本链
 * 不再含全局扫描/全局锁，原 reapSkipped 字段随 reap 调用一并移除——对应 S6
 * 场景「批 2 后 reap 类操作不再执行」。
 */
function runSessionStartMaintenance(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reason: SessionStartEvent["reason"],
): void {
	logger.debug("session_start maintenance dispatch", {
		detail: { reason },
	});
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		reconcilePendingEntries(pi, getAgentDir(), sessionId, ctx.sessionManager.getEntries());
	} catch (err) {
		// 对账失败无害：僵尸 register 停留差集，下一 session_start 幂等重查
		logger.warn("session_start pending reconcile failed; zombies retried next session start", {
			detail: { err: toErrorMessage(err) },
		});
	}
}
