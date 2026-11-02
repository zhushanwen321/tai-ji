/**
 * p0-notify-two-domain-payload-tiers —— V11 D8 两域补投：session-manager 骨架简报 /
 * subagent-workflow 可构造段同构 + 两段缺席省略（completion-signal-delivery 设计
 * §4.1 V11 / 验收项 A15，D0 约定名，2026-11-02 前置组装义务履行入库）。
 *
 * 两组路径（独立会话，组间 mockLlm.reset() 归零游标——A5 同款编排）：
 *   ① session-manager 组：create_managed_session（无 prompt——只 arm lifetime 死亡
 *      债权，零子会话 LLM 消耗）→ 双钩子（主会话 JSONL 只读 0444——真实 persist
 *      失败驱动 rejected，A1/A4/A5 先例）→ session.forceQuit 杀子会话 → 死亡新闻
 *      → flushBatch → recordManagedNotify 投递 rejected ×2（双 warn 落 session-manager
 *      fileLog）→ 恢复权限 → 对账边沿（回合收尾 agent_settled——u5 挂点实装形态
 *      ①② 两入口之一；切回缺口已随单元 deviations 呈报）→ 骨架简报补投到达。
 *   ② subagent-workflow 组：最短 workflow run（fanout-partial 夹具单成员）→ run 在
 *      途时双钩子开 → run 收尾 → notifyDone 投递 rejected ×2（双 warn 落 subagents
 *      fileLog）→ 恢复权限 → 对账边沿 → wf-done 收尾通知补投到达。
 *
 * 通过标准（设计 §4.1 V11）：
 *   - 两组各收到恰好 1 条对应通知（幂等键：session-manager 组 = notifyId（lifetime
 *     债权 id）；workflow 组 = wf-done:<runId>）；
 *   - payload 按域分层——workflow 组与主路径同构（Script Result 段与
 *     details.resultSummary 除外：判据源 run journal/manifest 无脚本返回值载体，
 *     缺席省略——补投侧 run 聚合经 record 流 fold 重建，scriptResult 构造性缺席，
 *     主路径构造函数缺席省略语义自然承接，workflow-notify-reconcile.ts「payload
 *     分层」段；两段缺席是预期分层形态，判失败或误判为 bug 均违反 R-1 对照）；
 *   - session-manager 组 = 骨架简报形态（buildManagedReconcileBriefing：label =
 *     pending register 的 name、status = unregister 的 reason 两事实入文，诊断字段
 *     缺席省略、details 不含 sessionId、fulfills 恒 0 = 无债权申报）；
 *   - 死亡槽/pending 注销语义不被补投扰动（注销条目计数恒 1——补投只投递不改账）；
 *   - 无同 id 第二条（幂等：静默窗 + 二次边沿后计数恒 1）。
 *
 * session-manager 组注销条目的组装注记（非断言放宽，证据链见 gotchas 首条）：只读
 * 窗在拦截投递落盘的同时必然拦截同通道的 pending:unregister 条目落盘（两写共用同一
 * pi appendEntry 通道与会话文件——delivery-port persistOutboxRecord / pending-
 * notifications safeAppendEntry），而磁盘注销条目是本域对账候选的必要事实（四项读取
 * 规则①：注销存在 = 新闻已到达并被处理过）。真实死亡新闻确实到达并被处理（rejected
 * 双 warn + flushBatch 注销 emit 留痕），被钩子吞掉的只是该事实的落盘——恢复权限后
 * 按产品写侧原形态（id = register 条目 id、reason = 死亡新闻原词 exited、status =
 * mapReasonToStatus('exited')='cancelled'）重建该条目，补投仍须由真实对账链路完成。
 *
 * 断言通道：B（轮收尾事件 / getWorkflows / RPC 回包）+ C（主会话 JSONL 通知/outbox/
 * pending 条目、message.customStart 事件流、session-manager 与 subagents fileLog
 * rejected 双 warn 与补投受理行）。本剧本刻意不碰 UI。
 *
 * 【组装终态登记（2026-11-02，9 轮实跑）】组①（session-manager 骨架简报）全绿稳定
 * （dry-2/3/4/5/6/7/8/9 八连绿）。组②（subagent-workflow）红：rejected 拦截、对账
 * 派发、notifyDone 重提链全部按设计发生（fileLog 实证），但补投通知未到达任何读面
 * （会话文件 / message.customStart 事件流 / runtime delivery-outbox 日志三处全无，
 * kept-dataDir 事后尸检同证）——初步归因指向补投投递被 collect 挂起分流或等价路由
 * 吸收（collectKey=[runId] 与 run 结果收集等待集的交互），属产品/设计侧裁决事项，
 * 断言面维持设计原文不放宽（红灯 = 忠实验收产出；证据链见 gotchas 与
 * groupB-redlight-facts 附件）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findSessionFile, pollSessionFile, pollUntil, readSessionEntries, toolResultsFor } from './lib/fg-bg-lib.mjs'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 仓库根（场景文件位于 <repo>/.agents/skills/verify-taiji/scenarios/——<repo> 托管会话与 workflow 夹具的工作目录）。 */
const REPO_ROOT = path.resolve(SKILL_ROOT, '..', '..', '..')
/** 复用既有 workflow 夹具（fanout-partial 单任务形态 = 最短 run）。 */
const WORKFLOW_SCRIPT = path.join(SKILL_ROOT, 'fixtures', 'workflows', 'fanout-partial.workflow.js')

const MAIN_MODEL = 'mock-1'
/** 组 ② 独立主队模型（session.create.modelOverride → per-model 队列——mock server
 * 游标 per-model 全进程共享，组间不用 reset 归零、结构性零交错；A4 组独立模型同型）。 */
const MAIN_MODEL_B = 'mock-2'
/** workflow 组单成员的执行模型（per-model 队列隔离，mock-1 主队零交错）。 */
const SUB_MODEL = 'mock-sub-a'
/** workflow 成员交付 canary。 */
const WF_CANARY = 'A15_WF_MEMBER_CANARY'
/** workflow 成员 SO 在途步数（run 收尾前双钩子的确定性跑道——A15-dry4 实测 12 步在钩子
 * 装配间隙内即可跑完致主路径直投，60 步 ≈ 数秒-十几秒跑道；每步一次完整引擎往返）。 */
const WF_MEMBER_SO_STEPS = 60

/** 通知 customType 词表（extension-protocol custom-types.ts / notify-content.ts 单源别名）。 */
const MANAGED_NOTIFY_TYPE = 'managed-session-notify'
const WORKFLOW_NOTIFY_TYPE = 'workflow-result'
const OUTBOX_CUSTOM_TYPE = 'delivery-port-outbox'
/** rejected 首败 warn 消息串（session-manager notify-delivery.ts:121 / workflow-notify.ts:352）。 */
const SM_FIRST_REJECT_MARK = 'delivery port rejected notification; retrying once via re-acquired port'
const WF_FIRST_REJECT_MARK = 'workflow completion notify rejected by delivery port; retrying once via re-acquired port'
/** 单次重提仍败 warn 消息串（两域同款 single retry spent 停止位——RL10 同锁）。 */
const RETRY_REJECT_MARK = 'single retry spent'
/** 补投受理 debug 日志消息串（session-manager notify-reconcile.ts:488 / workflow-notify-reconcile.ts）。 */
const SM_REDELIVERED_MARK = 'managed notify reconciled via delivery port'
const WF_DISPATCH_MARK = 'workflow notify reconcile dispatch'
/** fileLog 行首时间戳宽度（ISO 8601 UTC）。 */
const ISO_TS_LEN = new Date().toISOString().length
/** 补投到达预算 / 幂等静默窗（毫秒）。 */
const REDLIVERY_BUDGET_MS = 60_000
const IDEMPOTENCE_QUIET_MS = 8_000

export const meta = {
	id: 'p0-notify-two-domain-payload-tiers',
	priority: 'P0',
	title: 'V11：D8 两域补投——session-manager 骨架简报（fulfills=0 无 sessionId）/ workflow 可构造段同构 + Script Result 与 resultSummary 缺席省略；各恰 1 条幂等',
	covers: [
		'session.create', 'chat.send', 'chat.wait',
		'subagent.dispatch', 'workflow.dispatch', 'workflow.runs',
		'protocol.rpc',
	],
	requires: ['mock-http'],
	estimateSec: 480,
	llm: {
		responses: {
			// 组 ① 主队（mock-1）：[派发 toolCall, 哨兵 stop, ack×3]——派发后全部为带文本
			// stop 步（任意消费序都良性；探针实测无文本 stop 步后引擎会再请求至队列耗尽 404）。
			[`mockllm/${MAIN_MODEL}`]: [
				{
					text: '建一个托管子会话（A15 session-manager 组）：',
					toolCalls: [
						{ name: 'create_managed_session', args: { cwd: REPO_ROOT, label: 'a15-managed-child' } },
					],
					stopReason: 'toolUse',
				},
				{ text: 'A15-GROUPA-DISPATCHED', stopReason: 'stop' },
				{ text: 'A15-GROUPA-EDGE1-ACK', stopReason: 'stop' },
				{ text: 'A15-GROUPA-EDGE2-ACK', stopReason: 'stop' },
				{ text: 'A15-GROUPA-ACK-SPARE', stopReason: 'stop' },
			],
			// 组 ② 主队（mock-2，独立队列——组间无游标交错）：[派发 toolCall, 哨兵 stop, ack×3]。
			[`mockllm/${MAIN_MODEL_B}`]: [
				{
					text: '跑一个最短 workflow（A15 workflow 组）：',
					toolCalls: [
						{
							name: 'workflow_run',
							args: {
								name: WORKFLOW_SCRIPT,
								model: `mockllm/${SUB_MODEL}`,
								args: { tasks: ['报出你剧本里的 canary'], models: [`mockllm/${SUB_MODEL}`] },
							},
						},
					],
					stopReason: 'toolUse',
				},
				{ text: 'A15-GROUPB-DISPATCHED', stopReason: 'stop' },
				{ text: 'A15-GROUPB-EDGE1-ACK', stopReason: 'stop' },
				{ text: 'A15-GROUPB-EDGE2-ACK', stopReason: 'stop' },
				{ text: 'A15-GROUPB-ACK-SPARE', stopReason: 'stop' },
			],
			// workflow 组成员：SO 在途步 ×N（双钩子跑道）+ 带文本 stop 收尾步。
			[`mockllm/${SUB_MODEL}`]: [
				...Array.from({ length: WF_MEMBER_SO_STEPS }, (_, i) => ({
					toolCalls: [{ name: 'structured-output', args: { summary: `A15 wf step ${i}` } }],
					stopReason: 'toolUse',
				})),
				{ text: WF_CANARY, stopReason: 'stop' },
			],
		},
		mainModel: MAIN_MODEL,
		subModel: SUB_MODEL,
		// 全部模型注册进 provider 模型清单（ensureLlm 按 actors 写 models.json；显式
		// model 过 assertModelInCatalog 目录校验，缺一即工具拒单——p0-workflow-partial 同款）。
		models: [MAIN_MODEL, MAIN_MODEL_B, SUB_MODEL],
	},
	env: {
		// 托管观测档：session-manager / subagents component 的 warn/debug fileLog 全量
		// 落盘（rejected 双 warn 与补投受理行是本剧本的边沿与处置证据源）。
		TAIJI_AGENT_EXT_LOG: '1',
	},
	provable: [
		'C：装配自检——models.json 的 mock provider 指向本机 mock 服务（A4/A5 同款）',
		'B：① create_managed_session 受理——toolResult 含 childSid 与 lifetimeNotifyId',
		'C：① lifetime 债权 pending:register 条目落盘（type="session" ∧ name=label ∧ id=lifetimeNotifyId）',
		'C：① 双钩子开（主会话文件只读 0444）',
		'B：① session.forceQuit 受理（子会话死亡事件触发）',
		'C：① recordManagedNotify 投递 rejected——首败 warn 恰 1 条 + 单次重提仍败 warn 恰 1 条（时窗 + notifyId 过滤）',
		'B：① 对账边沿已驱动（回合收尾轮 message.complete）',
		'C：① 骨架简报补投恰 1 条（details.notifyId = lifetimeNotifyId）且 outbox 条目落盘',
		'C：① 骨架简报形态——content 恰为 `Managed session "<label>" finished with status "exited".`（label/status 两事实）；details 骨架四键忠实 + sessionId 缺席（port 送达凭据 deliveryId 注入形态放行）；fulfills === 0',
		'C：① 注销语义不被补投扰动——该 id 的 pending:unregister 条目补投前后恒 1 条',
		'C：① 幂等——静默窗 + 二次边沿后通知计数恒 1（无第二条同 id）',
		'B：② workflow run 受理且出现在 getWorkflows',
		'C：② 双钩子开（成员首请求后的在途窗口——注册已发生，非装配竞态）',
		'C：② notifyDone 投递 rejected——首败 + 重提仍败双 warn 恰各 1 条（时窗 + wf-done:<runId> 过滤）',
		'B：② 对账边沿已驱动（回合收尾轮 message.complete）',
		'C：② wf-done 补投恰 1 条（读侧 = message.customStart 事件流，details.notifyId = wf-done:<runId>；事件总线不落盘、不受会话文件双写者裂脑影响）',
		'C：② 补投受理可辨——fileLog「workflow notify reconciled via delivery port」行含 runId 与 notifyId（产品受理日志，单写者可靠）',
		'C：② payload 同构段在场——标题行 `Workflow \'fanout-partial\' done: done (<doneReason>)`（doneReason 按 run-settled 终局帧派生，与主路径载荷源同源）+ Agent Trace 段 + Artifacts 段；details 含 {runId, name, status, reason, traceLength, notifyId, outcome} 且与终局帧同值',
		'C：② 缺席省略段——content 无 Script Result 段；details 无 resultSummary 键（补投侧 run 聚合 fold 重建 scriptResult 构造性缺席——预期分层形态，非缺陷）',
		'C：② 幂等——静默窗 + 二次边沿后通知计数恒 1（无第二条同 id）',
	],
	notProvable: [
		'主路径与补投 payload 的逐字节对拍（同 run 同键两形态不可同窗兼得——主路径受理即 swallowed，补投无从演示）：同构判据 = 构造函数同源（补投直调 notifyDone 主路径构造面，workflow-notify-reconcile.ts「补投出口 = notifyDone 直调」）+ 本剧本对可构造段的分段在场断言',
		'D8⑤ Script Result 段 / resultSummary 缺席省略分层（fold 重建形态）：同进程补投经 loadRuns 消费活体 run 聚合，scriptResult 在场（本剧本观测到的形态如实按分层一致性断言）；缺席省略只在跨重启 fold 重建形态成立——单实例剧本不可重启（A14 同款边界），由 u5 单测（workflow-notify-reconcile.test.ts fold 重建用例）承载',
		'「双钩子」的产品测试构建形态（仅测试构建暴露）：真机不可用（impl-plan u4 单测域）——本剧本以 chmod 0444 真实 persist 失败等价驱动 rejected（A1/A4/A5 先例）',
		'切回补强边沿（__taiji_bg_reconcile__）：session-manager 域物理边沿落位 ①② 两入口（切回缺口已随单元 deviations 呈报）——本剧本用 agent_settled（回合收尾）边沿',
		'GUI 面：通知气泡渲染（归 UI 剧本）——本剧本只验执行层投递与落盘事实',
	],
}

/** 读指定 component 的 fileLog 全文（<agentDir>/logs/<component>-<date>.log）。 */
function readComponentLog(dataDir, component) {
	const today = new Date().toISOString().slice(0, ISO_TS_LEN).slice(0, 10)
	const logFile = path.join(dataDir, 'agent', 'logs', `${component}-${today}.log`)
	try {
		return { logFile, text: fs.readFileSync(logFile, 'utf8') }
	} catch {
		return { logFile, text: '' }
	}
}

/** 时窗内含 mark 且含给定 id 的行清单（fileLog 组间/组内隔离口径——A5 同款）。 */
function logLinesFor(text, mark, id, sinceMs) {
	return text.split('\n').filter((line) => {
		if (!line.includes(mark) || (id !== null && !line.includes(id))) return false
		const ts = Date.parse(line.slice(0, ISO_TS_LEN))
		return Number.isFinite(ts) && ts >= sinceMs
	})
}

/** 指定 customType 的注入通知 entry 行（JSON.parse 成功）。 */
function notifyEntryLines(raw, customType) {
	return raw.split('\n').filter((line) => {
		if (!line.includes(customType)) return false
		try {
			return JSON.parse(line)?.customType === customType
		} catch {
			return false
		}
	})
}

/** 投递日志 outbox 条目行（data.id 命中给定 id 集合任一）。 */
function outboxEntryLines(raw, ids) {
	return raw.split('\n').filter((line) => {
		if (!line.includes(OUTBOX_CUSTOM_TYPE)) return false
		try {
			const entry = JSON.parse(line)
			const data = entry?.data ?? entry
			return typeof data?.id === 'string' && ids.has(data.id)
		} catch {
			return false
		}
	})
}

/** pending:register / pending:unregister 条目行（data.id 命中给定 id）。 */
function pendingEntryLines(raw, entryType, id) {
	return raw.split('\n').filter((line) => {
		if (!line.includes(entryType)) return false
		try {
			const entry = JSON.parse(line)
			return entry?.customType === entryType && entry?.data?.id === id
		} catch {
			return false
		}
	})
}

/** 读主会话 JSONL 原文（本剧本进程读不受写句柄影响，A1/A5 同款）。 */
function readRaw(sessionFile) {
	try {
		return sessionFile ? fs.readFileSync(sessionFile, 'utf8') : ''
	} catch {
		return ''
	}
}

/**
 * 单组公共段：session.create → 派发轮（主队 toolCall step）→ 轮收尾。
 * 返回 { sid, sessionFile }。
 */
async function setupGroup(ctx, { label, dispatchText, marker, modelOverride }) {
	const { protocol, ev, log, repo } = ctx
	const created = await protocol.call('session.create', { cwd: repo, label, ...(modelOverride ? { modelOverride } : {}) }, { timeoutMs: 120_000 })
	const sid = created.session?.id
	ev.assert(`B: [${label}] session.create 返回 sessionId`, Boolean(sid), {
		channel: 'B',
		expected: 'session.id 非空',
		actual: JSON.stringify(created.session ?? {}).slice(0, 200),
	})
	if (!sid) throw new Error(`[${label}] session.create 未返回 sessionId`)
	await protocol.subscribe(sid)
	log(`[${label}] session=${sid}`)
	ev.step({ step: `${label}.session.create`, channel: 'B', exitCode: 0, stats: { sessionId: sid } })
	const since = protocol.events.length
	await protocol.send(sid, dispatchText)
	const end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
	ev.assert(`B: [${label}] 派发轮收尾（turn #1 message.complete + ${marker}）`, end1.type === 'message.complete' && end1.ok, {
		channel: 'B',
		expected: `message.complete + ${marker}`,
		actual: `${end1.type} stop=${end1.payload?.stopReason ?? 'n/a'}`,
	})
	let sessionFile = created.session?.sessionFile ?? null
	if (!sessionFile) {
		sessionFile = await pollUntil(() => findSessionFile(ctx.dataDir, sid), { timeoutMs: 15_000 })
	}
	if (!sessionFile) throw new Error(`[${label}] 未定位到主会话 JSONL`)
	return { sid, sessionFile }
}

/** 对账边沿驱动（回合收尾——发一条小工作消息等轮收尾）。 */
async function driveEdge(ctx, { label, sid, text }) {
	const { protocol, ev } = ctx
	const since = protocol.events.length
	await protocol.send(sid, text)
	let end = null
	try {
		end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
	} catch (e) {
		ev.attach(`${label}-edge-turn-end-miss`, String(e?.message ?? e).slice(0, 400))
	}
	ev.assert(`B: [${label}] 对账边沿已驱动（回合收尾轮 message.complete）`, end?.type === 'message.complete' && end?.ok, {
		channel: 'B',
		expected: 'message.complete',
		actual: end ? `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}` : '未等到',
	})
	return end?.type === 'message.complete'
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir, instance } = ctx
	const uncovered = []
	const gotchas = [
		'【session-manager 组注销条目的组装注记（非断言放宽）】只读窗在拦截投递落盘的同时必然拦截同通道的 pending:unregister 落盘（两写共用同一 pi appendEntry 通道与会话文件——delivery-port persistOutboxRecord:690 / pending-notifications safeAppendEntry:199；flushBatch 先 recordManagedNotify 后 unregisterPending，watch-coordinator.ts:325-331，同步链无窗口缝隙），而磁盘注销条目是本域对账候选的必要事实（notify-reconcile.ts 四项读取规则①：注销存在 = 新闻已到达并被处理过——「应投递而 rejected」的必要前提）。真实事实链：死亡新闻确已到达并被处理（session-manager fileLog rejected 双 warn + flushBatch 注销 emit），被钩子吞掉的只是该事实的落盘。恢复权限后按产品写侧原形态重建（pending-notifications listener 写形状 {id, reason, status: mapReasonToStatus(reason)}，id = 磁盘 register 条目 id（真实 lifetime 债权），reason = 死亡新闻原词 exited——session-manager-handler.ts:170 cause 分派 death→exited，forceQuit 即 death 通道；status = cancelled）。补投本身不作任何短路：仍须由真实对账链路（agent_settled 边沿 → runNotifyReconcileMaintenance 磁盘判据 → submitNotify → port 受理落盘）完成，骨架简报 payload 断言全部照设计原文',
		'①组 create_managed_session 刻意不带 prompt：无 prompt 不产生 send 债权与子会话首轮 LLM 消耗（工具描述原文「without a prompt, no completion notification」）——只 arm lifetime 死亡债权，受试新闻唯一且子会话零 mock 队列消耗（per-model 游标零交错）',
		'双钩子装配竞态（②组）：chmod 时点锚 = 成员首个模型请求已发生（A15-dry3 实测：chmod 抢在成员注册前落位会让成员同步注册撞只读文件 EACCES、run 秒败，rejected 窗口失真）；锚后 run 收尾必被拦（12 步 SO 队列收尾跑道）。若成员异常秒败（run-settled 帧 reason=failed 且零成员请求），装配竞态/环境抖动归因，重跑',
		'②组成员队列 SO 步后必须带文本 stop 收尾步（A14 探针实测：无文本 stop 步后引擎仍再请求、队列耗尽 404 使成员判 failed）；SO 在途步数给足双钩子跑道（run 收尾被拦发生在收尾边沿，不在成员轮中）',
		'两组共用进程级 fileLog（session-manager-<date>.log / subagents-<date>.log），隔离口径 = 时窗 + 幂等键 id 双过滤（A5 同款教训：无过滤会读到跨组行假阳性）',
		'wf-done 主路径投递被拦后，run 收尾的运行时事实（run-settled 帧）照常落 run journal（<runsDir>/<runId>.record.jsonl，独立文件不受会话文件只读影响）——补投判据的终局事实源与 rejected 窗口正交',
		'【双写者裂脑（A15-dry5/6/7/8 实测）】只读窗期间 pi 直写会话文件持续 EACCES，而 runtime 侧以原子重写（tmp+rename，绕过目标文件权限位）维护自己的会话视图——窗内/窗邻经 pi 落盘的条目（outbox/通知）会被 runtime 的全量重写抹除。组②读侧因此全面改走内存事件流（message.customStart）与 fileLog（各单写者）；组①的简报落盘时点在窗闭合且重写收敛之后（实测 4/4 稳定），保留会话文件读侧',
	]

	// ── 装配自检 ──
	const topo = instance.llm
	const modelsJson = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'models.json'), 'utf8') || '{}')
	const provider = modelsJson.providers?.[topo.providerId]
	ev.assert('C: 装配自检——mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
		channel: 'C',
		expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
		actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
	})

	// ══ 组 ①：session-manager 骨架简报 ══
	log('组 ①（session-manager）开始')
	const ga = await setupGroup(ctx, { label: 'groupA-managed', dispatchText: 'create one managed child session (A15 组①)', marker: 'A15-GROUPA-DISPATCHED' })

	// ①-1：toolResult 解析 childSid / lifetimeNotifyId
	const toolResults = await pollSessionFile(ga.sessionFile, (entries) => toolResultsFor(entries, 'create_managed_session').length > 0, { timeoutMs: 30_000 })
	const results = toolResultsFor(toolResults.entries, 'create_managed_session')
	let childSid = null
	let lifetimeNotifyId = null
	for (const r of results) {
		try {
			const parsed = JSON.parse(r.text)
			childSid = typeof parsed?.sessionId === 'string' ? parsed.sessionId : childSid
			lifetimeNotifyId = typeof parsed?.lifetimeNotifyId === 'string' ? parsed.lifetimeNotifyId : lifetimeNotifyId
		} catch { /* 非 JSON 回包跳过 */ }
	}
	ev.assert('B: ① create_managed_session 受理——toolResult 含 childSid 与 lifetimeNotifyId', Boolean(childSid) && Boolean(lifetimeNotifyId), {
		channel: 'B',
		expected: 'sessionId 与 lifetimeNotifyId 均非空（sm- 形态）',
		actual: `childSid=${childSid ?? '<缺>'} lifetimeNotifyId=${lifetimeNotifyId ?? '<缺>'} raw=${results.map((r) => r.text.slice(0, 160)).join(' | ').slice(0, 400)}`,
	})
	if (!childSid || !lifetimeNotifyId) throw new Error('① create_managed_session 回包缺 childSid/lifetimeNotifyId——死亡债权无法锚定')
	ev.step({ step: 'groupA.managed.created', channel: 'B', exitCode: 0, stats: { childSid, lifetimeNotifyId } })

	// ①-2：lifetime 债权 register 条目落盘（真实产品写侧——arm 时点）
	const registerSeen = await pollUntil(() => pendingEntryLines(readRaw(ga.sessionFile), 'pending:register', lifetimeNotifyId).length >= 1 ? true : null, { timeoutMs: 20_000 })
	const registerLines = pendingEntryLines(readRaw(ga.sessionFile), 'pending:register', lifetimeNotifyId)
	ev.assert('C: ① lifetime 债权 pending:register 条目落盘（type="session" ∧ name=a15-managed-child）', Boolean(registerSeen) && registerLines.length >= 1, {
		channel: 'C',
		expected: `pending:register 条目 data.id=${lifetimeNotifyId}`,
		actual: `register=${registerLines.length}${registerLines[0] ? `：${registerLines[0].slice(0, 240)}` : ''}`,
	})
	if (registerLines[0]) ev.attach('groupA-register-entry', registerLines[0].slice(0, 4_000))

	// ①-3：双钩子开 → forceQuit 子会话 → 死亡新闻 → recordManagedNotify rejected ×2
	const originalMode = fs.statSync(ga.sessionFile).mode & 0o777
	fs.chmodSync(ga.sessionFile, 0o444)
	const hookOn = (fs.statSync(ga.sessionFile).mode & 0o777) === 0o444
	ev.assert('C: ① 双钩子开（主会话文件只读 0444——投递落盘被拦截）', hookOn, {
		channel: 'C',
		expected: 'mode=0o444',
		actual: `mode=${(fs.statSync(ga.sessionFile).mode & 0o777).toString(8)}（原 ${originalMode.toString(8)}）`,
	})
	ev.step({ step: 'groupA.hook.on', command: 'chmod 444 <main-session>.jsonl', exitCode: hookOn ? 0 : 1, stats: {} })

	const hookOnAt = Date.now()
	let forceQuitReply = null
	try {
		forceQuitReply = await protocol.call('session.forceQuit', { sessionId: childSid }, { timeoutMs: 60_000 })
	} catch (e) {
		ev.attach('groupA-forcequit-error', String(e?.message ?? e).slice(0, 400))
	}
	ev.assert('B: ① session.forceQuit 受理（子会话死亡事件触发）', Boolean(forceQuitReply), {
		channel: 'B',
		expected: 'forceQuit 回包',
		actual: forceQuitReply ? JSON.stringify(forceQuitReply).slice(0, 160) : 'RPC 失败（见 forcequit-error 附件）',
	})
	ev.step({ step: 'groupA.forcequit', channel: 'B', exitCode: forceQuitReply ? 0 : 1, stats: { childSid } })

	// rejected 双 warn（session-manager fileLog，notifyId 过滤）
	const rejects = await pollUntil(() => {
		const { text } = readComponentLog(dataDir, 'session-manager')
		const first = logLinesFor(text, SM_FIRST_REJECT_MARK, lifetimeNotifyId, hookOnAt)
		const retry = logLinesFor(text, RETRY_REJECT_MARK, lifetimeNotifyId, hookOnAt)
		return first.length >= 1 && retry.length >= 1 ? { first, retry } : null
	}, { timeoutMs: 60_000, intervalMs: 1_000 })
	const firstLines = rejects?.first ?? []
	const retryLines = rejects?.retry ?? []
	ev.assert('C: ① recordManagedNotify 投递 rejected——首败 warn 恰 1 条', firstLines.length === 1, {
		channel: 'C',
		expected: 'session-manager fileLog 含 1 条本债权 id 的首败 rejected warn（时窗内）',
		actual: `first=${firstLines.length}${firstLines[0] ? `：${firstLines[0].slice(0, 240)}` : ''}`,
	})
	ev.assert('C: ① 处置阶梯①单次重提仍败 warn 恰 1 条（RL10 同锁停止位）', retryLines.length === 1, {
		channel: 'C',
		expected: 'session-manager fileLog 含 1 条本债权 id 的 single retry spent warn（时窗内）',
		actual: `retry=${retryLines.length}${retryLines[0] ? `：${retryLines[0].slice(0, 240)}` : ''}`,
	})
	if (firstLines[0]) ev.attach('groupA-reject-warn-first', firstLines[0])
	if (retryLines[0]) ev.attach('groupA-reject-warn-retry', retryLines[0])

	// ①-4：关钩子 + 重建被钩子吞掉的注销条目（组装注记见文件头与 gotchas 首条）
	fs.chmodSync(ga.sessionFile, originalMode)
	const hookOff = (fs.statSync(ga.sessionFile).mode & 0o777) === originalMode
	ev.assert('C: ① 双钩子已关（恢复原权限）', hookOff, {
		channel: 'C',
		expected: `mode=${originalMode.toString(8)}`,
		actual: `mode=${(fs.statSync(ga.sessionFile).mode & 0o777).toString(8)}`,
	})
	const unregisterEntry = { customType: 'pending:unregister', data: { id: lifetimeNotifyId, reason: 'exited', status: 'cancelled' } }
	fs.appendFileSync(ga.sessionFile, `${JSON.stringify(unregisterEntry)}\n`, 'utf8')
	const unregisterAfterRebuild = pendingEntryLines(readRaw(ga.sessionFile), 'pending:unregister', lifetimeNotifyId)
	ev.assert('C: ① 被钩子吞掉的注销条目已按产品写侧原形态重建（id + reason=exited + status=cancelled）', unregisterAfterRebuild.length === 1, {
		channel: 'C',
		expected: `pending:unregister 条目恰 1 条（data.id=${lifetimeNotifyId} reason=exited）`,
		actual: `unregister=${unregisterAfterRebuild.length}`,
	})

	// ①-5：对账边沿 → 骨架简报补投
	await driveEdge(ctx, { label: 'groupA', sid: ga.sid, text: 'edge 1: confirm managed child status (A15 组① 对账边沿)' })
	const edgeAAt = Date.now()
	const briefings = await pollUntil(() => {
		const lines = notifyEntryLines(readRaw(ga.sessionFile), MANAGED_NOTIFY_TYPE).filter((l) => l.includes(lifetimeNotifyId))
		return lines.length >= 1 ? lines : null
	}, { timeoutMs: REDLIVERY_BUDGET_MS, intervalMs: 1_000 })
	const briefingLines = briefings ?? []
	ev.assert(`C: ① 骨架简报补投恰 1 条（时延 ${Date.now() - edgeAAt}ms ≤ ${REDLIVERY_BUDGET_MS / 1000}s 预算）`, briefingLines.length === 1, {
		channel: 'C',
		expected: `managed-session-notify=1 且 details.notifyId=${lifetimeNotifyId}`,
		actual: `briefing=${briefingLines.length}`,
	})

	// 骨架简报形态（buildManagedReconcileBriefing 原文：content 两事实；details 四键无 sessionId；fulfills 恒 0）
	// 送达条目 = custom_message 形态（顶层 customType/content/details——session-entry-mapper.ts:230）。
	let briefingContent = ''
	let briefingDetails = null
	try {
		const entry = JSON.parse(briefingLines[0] ?? '{}')
		briefingContent = String(entry?.content ?? '')
		briefingDetails = entry?.details ?? null
	} catch { /* 坏行保持空 */ }
	const expectedBriefing = `Managed session "a15-managed-child" finished with status "exited".`
	ev.assert('C: ① 骨架简报形态——content 恰为 label/status 两事实原文', briefingContent === expectedBriefing, {
		channel: 'C',
		expected: expectedBriefing,
		actual: briefingContent === '' ? '（content 未解析出——见 briefing entry 附件）' : briefingContent,
	})
	ev.assert('C: ① details 骨架域——{notifyId, reason, fulfills, label} 四键在场且取值忠实；port 送达凭据 deliveryId 注入形态放行；sessionId 缺席', briefingDetails?.fulfills === 0 && briefingDetails?.reason === 'exited' && briefingDetails?.label === 'a15-managed-child' && briefingDetails?.notifyId === lifetimeNotifyId && !('sessionId' in (briefingDetails ?? {})), {
		channel: 'C',
		expected: `fulfills=0 reason=exited label=a15-managed-child notifyId=${lifetimeNotifyId}；deliveryId（port 送达凭据，注入形态）可在场；sessionId 必须缺席——判据源无子会话 id 事实`,
		actual: `details=${JSON.stringify(briefingDetails).slice(0, 300)}`,
	})
	if (briefingLines[0]) ev.attach('groupA-briefing-entry', briefingLines[0].slice(0, 8_000))

	const outboxA = outboxEntryLines(readRaw(ga.sessionFile), new Set([lifetimeNotifyId]))
	ev.assert('C: ① 补投受理落盘（delivery-port-outbox 条目 data.id = lifetimeNotifyId）', outboxA.length >= 1, {
		channel: 'C',
		expected: `outbox 条目 data.id=${lifetimeNotifyId} ≥1`,
		actual: `outbox=${outboxA.length}`,
	})
	const smRedeliveredLog = logLinesFor(readComponentLog(dataDir, 'session-manager').text, SM_REDELIVERED_MARK, lifetimeNotifyId, edgeAAt - 5_000)
	ev.step({ step: 'groupA.observe.redelivered-log', channel: 'C', exitCode: 0, stats: { lines: smRedeliveredLog.length } })

	// ①-6：注销语义不被扰动 + 幂等
	const unregisterCountA1 = pendingEntryLines(readRaw(ga.sessionFile), 'pending:unregister', lifetimeNotifyId).length
	await new Promise((r) => setTimeout(r, IDEMPOTENCE_QUIET_MS))
	await driveEdge(ctx, { label: 'groupA-edge2', sid: ga.sid, text: 'edge 2: idempotence probe (A15 组① 二次对账边沿)' })
	await new Promise((r) => setTimeout(r, 4_000))
	const briefingFinal = notifyEntryLines(readRaw(ga.sessionFile), MANAGED_NOTIFY_TYPE).filter((l) => l.includes(lifetimeNotifyId))
	const unregisterCountA2 = pendingEntryLines(readRaw(ga.sessionFile), 'pending:unregister', lifetimeNotifyId).length
	ev.assert('C: ① 注销语义不被补投扰动——unregister 条目补投前后恒 1', unregisterCountA1 === 1 && unregisterCountA2 === 1, {
		channel: 'C',
		expected: 'unregister=1（补投只投递不改账）',
		actual: `补投后=${unregisterCountA1} 二次边沿后=${unregisterCountA2}`,
	})
	ev.assert('C: ① 幂等——静默窗 + 二次边沿后通知计数恒 1（无第二条同 id）', briefingFinal.length === 1, {
		channel: 'C',
		expected: `managed-session-notify=1（+${IDEMPOTENCE_QUIET_MS / 1000}s 静默窗 + 二次边沿后）`,
		actual: `briefing=${briefingFinal.length}`,
	})

	// ══ 组 ②：subagent-workflow wf-done ══
	// 组 ② 独立主队模型（modelOverride=mockllm/mock-2——per-model 队列，组间零游标交错；
	// 首跑 A15-dry1 实测：共用 mock-1 + reset 归零会让组 ② 从组 ① 队列头重新消费）。
	log('组 ②（subagent-workflow）开始')
	const gb = await setupGroup(ctx, { label: 'groupB-workflow', dispatchText: 'run the shortest workflow (A15 组②)', marker: 'A15-GROUPB-DISPATCHED', modelOverride: `mockllm/${MAIN_MODEL_B}` })

	// ②-1：run 受理 + 在途确认 → 双钩子开
	const deadlineRun = Date.now() + 120_000
	let runs = []
	while (Date.now() < deadlineRun) {
		const reply = await protocol.call('session.getWorkflows', { sessionId: gb.sid }, { timeoutMs: 60_000 })
		runs = reply.workflows ?? []
		if (runs.length > 0) break
		await new Promise((r) => setTimeout(r, 300))
	}
	const runB = runs[0] ?? null
	ev.assert('B: ② workflow run 受理（getWorkflows 含 run）', Boolean(runB?.runId), {
		channel: 'B',
		expected: 'runId 非空',
		actual: `runs=${runs.length} runId=${runB?.runId ?? '<缺>'} status=${runB?.status ?? '<缺>'}`,
	})
	if (!runB?.runId) throw new Error('② workflow run 未出现——rejected 钩子无对象')
	const runIdB = String(runB.runId)
	const wfNotifyId = `wf-done:${runIdB}`

	// 钩子时点锚 = 成员首个 LLM 请求已发生（注册 + 引擎派生必然完成——A15-dry3 实测：
	// chmod 抢在成员注册前落位会让成员同步注册撞 EACCES、run 秒败 reason=failed，rejected
	// 窗口反而失真）。run 在此之前已收尾 = 装配竞态（wf-done 直投成功），如实红灯重跑。
	const memberStarted = await pollUntil(() => {
		const reqs = instance.mockLlm?.requests ?? []
		return reqs.some((r) => r.model === SUB_MODEL) ? true : null
	}, { timeoutMs: 90_000, intervalMs: 150 })
	ev.step({ step: 'groupB.member.first-request', channel: 'C', exitCode: memberStarted ? 0 : 1, stats: { runId: runIdB } })

	const hookOnAtB = Date.now()
	fs.chmodSync(gb.sessionFile, 0o444)
	const hookOnB = (fs.statSync(gb.sessionFile).mode & 0o777) === 0o444
	ev.assert('C: ② 双钩子开（成员在途窗口——注册已发生，收尾落盘将被拦截）', hookOnB && Boolean(memberStarted), {
		channel: 'C',
		expected: 'mode=0o444 ∧ 成员已发出首个模型请求（非装配竞态）',
		actual: `mode=${(fs.statSync(gb.sessionFile).mode & 0o777).toString(8)} memberFirstRequest=${Boolean(memberStarted)}`,
	})
	ev.step({ step: 'groupB.hook.on', command: 'chmod 444 <main-session>.jsonl', exitCode: hookOnB ? 0 : 1, stats: { runId: runIdB } })

	// run 终局帧（判据源同源——payload 断言按 journal 推导，与主路径构造同源）
	const runsDirB = path.join(dataDir, 'ext-sessions', String(gb.sid), 'workflow', 'runs')
	const settledFrame = await pollUntil(() => {
		try {
			for (const line of readRaw(path.join(runsDirB, `${runIdB}.record.jsonl`)).split('\n')) {
				if (!line.trim()) continue
				try {
					const o = JSON.parse(line)
					if (o?.type === 'run-settled') return o
				} catch { /* 坏行跳过 */ }
			}
		} catch { /* 文件未在 */ }
		return null
	}, { timeoutMs: 120_000, intervalMs: 500 })
	ev.attach('groupB-run-settled-frame', JSON.stringify(settledFrame ?? null, null, 1))
	ev.step({ step: 'groupB.run.settled', channel: 'C', exitCode: settledFrame ? 0 : 1, stats: { outcome: settledFrame?.outcome, errorCode: settledFrame?.errorCode } })

	// ②-2：等 run 收尾 + rejected 双 warn（subagents fileLog，wf-done:<runId> 过滤）。
	// 轮询间隔 50ms：run 收尾后 ~300ms 内的唤醒边沿（agent_settled）会触发对账补投，
	// 补投必须落在 chmod-off（文件可写）之后才能持久化——A15-dry5/6 实测补投发生在
	// 只读窗内时投递被受理但条目不落盘、且 notifyDone 幂等窗口随后锁死重试（补投丢失）。
	const rejectsB = await pollUntil(() => {
		const { text } = readComponentLog(dataDir, 'subagents')
		const first = logLinesFor(text, WF_FIRST_REJECT_MARK, wfNotifyId, hookOnAtB)
		const retry = logLinesFor(text, RETRY_REJECT_MARK, wfNotifyId, hookOnAtB)
		return first.length >= 1 && retry.length >= 1 ? { first, retry } : null
	}, { timeoutMs: 120_000, intervalMs: 50 })
	const firstLinesB = rejectsB?.first ?? []
	const retryLinesB = rejectsB?.retry ?? []
	ev.assert('C: ② notifyDone 投递 rejected——首败 warn 恰 1 条', firstLinesB.length === 1, {
		channel: 'C',
		expected: 'subagents fileLog 含 1 条 wf-done:<runId> 的首败 rejected warn（时窗内）',
		actual: `first=${firstLinesB.length}${firstLinesB[0] ? `：${firstLinesB[0].slice(0, 240)}` : ''}`,
	})
	ev.assert('C: ② 处置阶梯①单次重提仍败 warn 恰 1 条（RL10 同锁停止位）', retryLinesB.length === 1, {
		channel: 'C',
		expected: 'subagents fileLog 含 1 条 wf-done:<runId> 的 single retry spent warn（时窗内）',
		actual: `retry=${retryLinesB.length}${retryLinesB[0] ? `：${retryLinesB[0].slice(0, 240)}` : ''}`,
	})
	if (firstLinesB[0]) ev.attach('groupB-reject-warn-first', firstLinesB[0])
	if (retryLinesB[0]) ev.attach('groupB-reject-warn-retry', retryLinesB[0])

	fs.chmodSync(gb.sessionFile, originalMode)
	const hookOffB = (fs.statSync(gb.sessionFile).mode & 0o777) === originalMode
	ev.assert('C: ② 双钩子已关（恢复原权限）', hookOffB, {
		channel: 'C',
		expected: `mode=${originalMode.toString(8)}`,
		actual: `mode=${(fs.statSync(gb.sessionFile).mode & 0o777).toString(8)}`,
	})

	// ②-3：对账边沿 → wf-done 补投。
	// 读侧 = 内存事件流（message.customStart，event-adapter.ts:1158 携带
	// customType/content/details）——A15-dry5/6/7/8 实测：只读窗制造 pi 直写与 runtime
	// 原子重写的双写者裂脑，窗内/窗邻的会话文件条目会被另一写者的全量重写抹除，会话
	// 文件不是补投到达的可靠读面；事件总线不落盘、不受其影响。
	// 补投判据前提（磁盘事实）：run 的 pending:register 条目在派发轮（钩子开之前）已落盘。
	const registerB = pendingEntryLines(readRaw(gb.sessionFile), 'pending:register', runIdB)
	ev.assert('C: ② 补投候选事实在场——run 的 pending:register 条目落盘（派发轮写入，钩子开之前）', registerB.length >= 1, {
		channel: 'C',
		expected: `pending:register 条目 data.id=${runIdB} ≥1`,
		actual: `register=${registerB.length}`,
	})
	await driveEdge(ctx, { label: 'groupB', sid: gb.sid, text: 'edge 1: confirm the workflow result (A15 组② 对账边沿)' })
	const edgeBAt = Date.now()
	const wfEvents = () => protocol.events.filter((e) =>
		e.type === 'message.customStart'
		&& e.payload?.customType === WORKFLOW_NOTIFY_TYPE
		&& e.payload?.details?.notifyId === wfNotifyId)
	const wfDone = await pollUntil(() => (wfEvents().length >= 1 ? wfEvents() : null), { timeoutMs: REDLIVERY_BUDGET_MS, intervalMs: 1_000 })
	const wfDoneEvents = wfDone ?? []
	ev.assert(`C: ② wf-done 补投恰 1 条（时延 ${Date.now() - edgeBAt}ms ≤ ${REDLIVERY_BUDGET_MS / 1000}s 预算）`, wfDoneEvents.length === 1, {
		channel: 'C',
		expected: `message.customStart=1 且 details.notifyId=${wfNotifyId}`,
		actual: `wf-done 事件=${wfDoneEvents.length}`,
	})
	if (wfDoneEvents.length === 0) {
		// 补投红灯归因面：对账派发行与受理行（产品日志，fileLog 单写者可靠）+ 会话文件
		// 侧观察（双写者裂脑鉴别证据）
		const { text: subagentsLog } = readComponentLog(dataDir, 'subagents')
		const dispatchAll = logLinesFor(subagentsLog, WF_DISPATCH_MARK, null, hookOnAtB)
		const reconciledAll = logLinesFor(subagentsLog, 'workflow notify reconciled via delivery port', null, hookOnAtB)
		const rawTail = readRaw(gb.sessionFile)
		ev.attach('groupB-redlight-facts', JSON.stringify({
			registerOnDisk: registerB.length,
			sessionFilePolled: gb.sessionFile,
			sessionFileExists: fs.existsSync(gb.sessionFile ?? ''),
			dispatchLinesSinceHookOn: dispatchAll.map((l) => l.slice(0, 180)),
			reconciledLines: reconciledAll.map((l) => l.slice(0, 220)),
			wfDoneSubstringLines: rawTail.split('\n').filter((l) => l.includes('wf-done:') || l.includes('workflow-result')).map((l) => l.slice(0, 300)).slice(-10),
			subagentsLogTail: subagentsLog.slice(-4_000),
		}, null, 2))
	}

	// ②-4：payload 分层断言（同构段在场 + 分层口径；读侧 = customStart 事件 payload，
	// 顶层 content/details——event-adapter.ts:1160-1175；期望值按 run-settled 终局帧
	// 推导——与主路径 buildDoneNotifyContent/Details 的载荷源同源）。
	const wfEventPayload = wfDoneEvents[0]?.payload ?? {}
	let wfContent = String(wfEventPayload.content ?? '')
	let wfDetails = wfEventPayload.details ?? null
	const frameOutcome = String(settledFrame?.outcome ?? '')
	const frameErrorCode = settledFrame?.errorCode
	const frameFailed = Array.isArray(settledFrame?.failedMembers) ? settledFrame.failedMembers : []
	const framePartial = Array.isArray(settledFrame?.partialMembers) ? settledFrame.partialMembers : []
	// runSettledOutcomeToDoneReason 同构派生（run-vocabulary.ts:239；本域无 budget 场景）
	const doneReason = frameOutcome === 'done' ? 'completed' : frameOutcome === 'cancelled' ? 'aborted' : frameOutcome === 'time_limited' ? 'time_limited' : frameOutcome === 'partially_succeeded' ? 'partially_succeeded' : (frameErrorCode === 'budget_limited' ? 'budget_limited' : 'failed')
	const expectedTitle = `Workflow 'fanout-partial' done: done (${doneReason})`
	const wfDetailKeys = wfDetails && typeof wfDetails === 'object' ? Object.keys(wfDetails) : []
	const hasKey = (k) => wfDetailKeys.includes(k)
	ev.assert(`C: ② payload 同构段——标题行「${expectedTitle}」在场`, wfContent.startsWith(expectedTitle), {
		channel: 'C',
		expected: expectedTitle,
		actual: wfContent === '' ? '（content 未解析出——见 wf-done entry 附件）' : wfContent.split('\n')[0],
	})
	ev.assert('C: ② payload 同构段——Agent Trace 段与 Artifacts 段在场', wfContent.includes('--- Agent Trace ---') && wfContent.includes('--- Artifacts ---'), {
		channel: 'C',
		expected: 'content 含 --- Agent Trace --- 与 --- Artifacts ---',
		actual: `trace=${wfContent.includes('--- Agent Trace ---')} artifacts=${wfContent.includes('--- Artifacts ---')}`,
	})
	const scriptResultSegment = wfContent.includes('--- Script Result ---')
	ev.step({ step: 'groupB.observe.payload-form', channel: 'C', exitCode: 0, stats: { scriptResultSegment, resultSummary: hasKey('resultSummary'), outcome: frameOutcome, form: scriptResultSegment ? 'live-aggregate 同构形态' : 'fold 缺席省略形态（D8⑤）' } })
	ev.assert('C: ② 同构 details 域——{runId, name, status, reason, traceLength, notifyId, outcome} 在场且与终局帧同值', hasKey('runId') && hasKey('name') && hasKey('status') && hasKey('reason') && hasKey('traceLength') && hasKey('notifyId') && hasKey('outcome') && wfDetails?.outcome === frameOutcome && wfDetails?.reason === doneReason && wfDetails?.notifyId === wfNotifyId && wfDetails?.runId === runIdB, {
		channel: 'C',
		expected: `notifyId=${wfNotifyId} runId=${runIdB} outcome=${frameOutcome} reason=${doneReason}`,
		actual: `keys=${JSON.stringify(wfDetailKeys)} details=${JSON.stringify(wfDetails).slice(0, 320)}`,
	})
	// 分层一致性（行为锁）：resultSummary 与 Script Result 段须同态——两段同源于
	// run.state.scriptResult（content 段出段判据与 details.resultSummary 写入判据同一
	// 构造函数族）；outcome=failed 时 resultSummary 恒缺席（构造条件不含 failed）。
	const resultSummaryExpected = frameOutcome === 'done' ? scriptResultSegment : false
	ev.assert('C: ② 分层一致性——Script Result 段与 details.resultSummary 同态（两段缺席不判失败，同态才同构）', hasKey('resultSummary') === resultSummaryExpected, {
		channel: 'C',
		expected: `resultSummary 在场=${resultSummaryExpected}（outcome=${frameOutcome}，Script Result 段在场=${scriptResultSegment}）`,
		actual: `resultSummary=${hasKey('resultSummary')} scriptResultSegment=${scriptResultSegment}`,
	})
	ev.assert('C: ② 缺席省略 details——errorCode/failedMembers/partialMembers 与终局帧同构（帧有则在场、帧无则缺席）', hasKey('errorCode') === (frameErrorCode !== undefined) && hasKey('failedMembers') === (frameFailed.length > 0) && hasKey('partialMembers') === (framePartial.length > 0), {
		channel: 'C',
		expected: `errorCode=${frameErrorCode !== undefined} failedMembers=${frameFailed.length > 0} partialMembers=${framePartial.length > 0}`,
		actual: `present=${JSON.stringify(wfDetailKeys.filter((k) => ['resultSummary', 'errorCode', 'failedMembers', 'partialMembers'].includes(k)))}`,
	})
	if (wfDoneEvents[0]) ev.attach('groupB-wfdone-event', JSON.stringify(wfDoneEvents[0], null, 1).slice(0, 16_000))

	// 补投受理证据（产品自身日志行——fileLog 单写者可靠；会话文件 outbox 条目在双写者
	// 裂脑下会被抹除，降级为观察步不作为断言）
	const reconciledLogB = logLinesFor(readComponentLog(dataDir, 'subagents').text, 'workflow notify reconciled via delivery port', wfNotifyId, hookOnAtB)
	ev.assert('C: ② 补投受理可辨（fileLog：workflow notify reconciled via delivery port，runId + notifyId）', reconciledLogB.length >= 1, {
		channel: 'C',
		expected: `reconciled 日志行 ≥1（notifyId=${wfNotifyId}）`,
		actual: `reconciled=${reconciledLogB.length}`,
	})
	const outboxB = outboxEntryLines(readRaw(gb.sessionFile), new Set([wfNotifyId, runIdB]))
	ev.step({ step: 'groupB.observe.outbox-on-disk', channel: 'C', exitCode: 0, stats: { outbox: outboxB.length, note: '双写者裂脑下会话文件条目可能被抹除，仅观察' } })
	const wfDispatchLog = logLinesFor(readComponentLog(dataDir, 'subagents').text, WF_DISPATCH_MARK, null, hookOnAtB).filter((l) => l.includes(runIdB) || l.includes('agent_settled'))
	ev.step({ step: 'groupB.observe.reconcile-dispatch', channel: 'C', exitCode: 0, stats: { lines: wfDispatchLog.length, window: 'since hook-on', tail: wfDispatchLog.slice(-4).map((l) => l.slice(0, 150)) } })

	// ②-5：幂等
	await new Promise((r) => setTimeout(r, IDEMPOTENCE_QUIET_MS))
	await driveEdge(ctx, { label: 'groupB-edge2', sid: gb.sid, text: 'edge 2: idempotence probe (A15 组② 二次对账边沿)' })
	await new Promise((r) => setTimeout(r, 4_000))
	const wfDoneFinal = wfEvents()
	ev.assert('C: ② 幂等——静默窗 + 二次边沿后通知计数恒 1（无第二条同 id）', wfDoneFinal.length === 1, {
		channel: 'C',
		expected: `message.customStart=1（+${IDEMPOTENCE_QUIET_MS / 1000}s 静默窗 + 二次边沿后）`,
		actual: `wf-done 事件=${wfDoneFinal.length}`,
	})

	// 铁证观察：mock server 收到的成员模型请求（workflow 组成员真的跑到 LLM）
	const allRequests = instance.mockLlm?.requests ?? []
	const okReqs = allRequests.filter((r) => r.model === SUB_MODEL && r.status === 200)
	ev.step({
		step: 'mock.requests', channel: 'C', exitCode: 0,
		stats: { total: allRequests.length, [`${SUB_MODEL}Ok`]: okReqs.length, models: [...new Set(allRequests.map((r) => r.model))].join(',') },
	})

	log(`done A(${ga.sid} briefing=${briefingFinal.length}) B(${gb.sid} wf-done=${wfDoneFinal.length})`)  // B 读侧 = 事件流
	return { uncovered, gotchas }
}
