/**
 * p0-notify-cancelled-exclusion-lock —— V10 cancelled 族终态 record 不补投：D5 两排除位
 * 的真机行为锁（completion-signal-delivery 设计 §4.1 V10 / 验收项 A14，D0 约定名，
 * 2026-11-02 前置组装义务履行入库——排除位真值表单测先行归 u3，本剧本为真机批）。
 *
 * 被锁行为（subagent 域对账，notify-reconcile.ts isExcludedReconcileRecord）：
 *   排除位一（成因位，全 origin）：closedReason="cancelled" → 非候选——主路径对
 *   cancelled 成因不发任何通知（notifier buildLlmContent 的 cancelled 文案分支是旧
 *   CAS 终态化时代遗留、现行无产生路径），补投不得投出「Subagent … cancelled.」。
 *   排除位二（origin 位）：origin="workflow" 的终态 record 整体排除（cancelled 与
 *   gc 皆然）——成员结果由脚本返回值承载、run 收尾通知由 subagent-workflow 域
 *   wf-done 承载，无主路径同构 payload 可构造。
 *
 * 三个受试对象（同一 session，同一次对账边沿内互为对照）：
 *   M1 workflow 正常完成成员（closed+gc，origin=workflow）→ 排除位二单独命中；
 *   M2 workflow 中途取消成员（closed+cancelled，origin=workflow）→ 两排除位双命中；
 *   S3 存量 legacy cancelled record（closedReason=cancelled、origin 缺席——旧 CAS
 *      写点 + manifest 重建 closedReason + binding sidecar 缺失致 origin 缺席的历史
 *      遗留形态，不在排除位二覆盖内）→ 排除位一单独命中。
 *   S4 正向对照（legacy user-close record，origin 缺席——非排除成因）→ 必须补投
 *      （close 归档提示补投对象）。S4 的在场使「零补投」断言可信：它证明对账确实
 *      扫到了 manifest 源 record 且补投管道可用——否则「S3 不可见」与「S3 被排除」
 *      不可区分（A4 判据代差假绿的同型风险）。
 *
 * 三步断言面（设计 §4.1 V10）：
 *   ① 构造 workflow origin 终态 record：经 workflow origin 路径派发（最短 workflow
 *      run 的双成员 fan-out），M1 干净收尾（closed+gc）；M2 run 级 abort 中途取消
 *      （session.workflowAction → settleOneShotOutcome aborted 分支 → settleWorkflowRecord
 *      契约写点 → closed+cancelled；origin=tool 一次性任务中途取消不终态化，不可用于
 *      本场景）。manifest 磁盘事实断言两成员终态形态（①构造前提）。
 *   ② 注入 S3/S4 存量 fixture（manifest 单源形态：无 eventsStamp、无 .events——
 *      mergeManifestRecords 的存量宽容通道，manifestToSubagent 派生 idle+closedReason、
 *      origin 缺席）+ 触发对账边沿（回合收尾 agent_settled，V4b「切回或回合收尾」
 *      二选一形态，A5 组 b 同款驱动）。
 *   ③ 断言零补投：M1/M2/S3 三对象通知 entry 与投递日志 outbox 条目均零、fileLog 无
 *      补投受理行；S4 恰 1 条补投（正向对照）；对话流无「Subagent … cancelled.」文案；
 *      幂等静默窗 + 二次边沿后计数不变。
 *
 * 断言通道：B（getWorkflows / 轮收尾事件）+ C（record manifest 磁盘事实、主会话
 * JSONL 通知/outbox 条目、subagents fileLog 对账派发行、mock.requests 成员请求铁证）。
 * 本剧本刻意不碰 UI。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { pollUntil } from './lib/fg-bg-lib.mjs'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 复用既有 workflow 夹具（fanout-partial：双成员 fan-out，逐成员 model 指定 → per-model 队列零交错）。 */
const WORKFLOW_SCRIPT = path.join(SKILL_ROOT, 'fixtures', 'workflows', 'fanout-partial.workflow.js')

const MAIN_MODEL = 'mock-1'
/** M1（正常完成成员）的执行模型：SO 交付步 + stop 收尾步 → 干净收尾 closed+gc。 */
const SUB_MODEL_OK = 'mock-sub-a'
/** M2（中途取消成员）的执行模型：长 SO 队列保持在途，等 run 级 abort。 */
const SUB_MODEL_CANCEL = 'mock-sub-b'
/** M1 交付 canary（structured-output summary，随 record 落盘）。 */
const GC_CANARY = 'A14_GC_MEMBER_CANARY'
/** M2 长队列步数（引擎每步一次完整往返，300 步 ≈ 10s+ 在途窗——abort 的确定性跑道；
 * 60 步曾在本机快载下被跑完致 M2 自然收尾 gc，A14 wrapper 首验实测）。 */
const CANCEL_QUEUE_STEPS = 300
/** subagent 域通知 customType（extension-protocol custom-types.ts NOTIFY_CUSTOM_TYPE 单源别名）。 */
const NOTIFY_CUSTOM_TYPE = 'subagent-bg-notify'
/** 投递日志 outbox 条目的 customType（delivery-port journal.ts）。 */
const OUTBOX_CUSTOM_TYPE = 'delivery-port-outbox'
/** record id 前缀（record-access.ts `sa-${crypto.randomUUID()}`）。 */
const RECORD_ID_PREFIX = 'sa-'
/** subagent-core logger 的 fileLog 文件名前缀（core/logger.ts getLogger("subagents")）。 */
const CORE_LOG_PREFIX = 'subagents'
/** 对账入口 debug 日志消息串（notify-reconcile.ts，EXT_LOG 观测档以 info 落盘）。 */
const SUB_RECONCILE_MARK = 'notify reconcile dispatch'
/** 补投受理 debug 日志消息串（notify-reconcile.ts redelivered 分支）。 */
const REDLIVERED_MARK = 'notify reconcile redelivered terminal notification'
/** 旧 CAS 终态化时代遗留文案的判别正则（notifier.ts buildLlmContent cancelled 分支）。 */
const CANCELLED_COPY_RE = /Subagent "[^"]+" \([^)]+\) cancelled\./
/** fileLog 行首时间戳宽度（ISO 8601 UTC）。 */
const ISO_TS_LEN = new Date().toISOString().length
/** 补投/静默窗预算（毫秒）。 */
const REDLIVERY_BUDGET_MS = 60_000
const IDEMPOTENCE_QUIET_MS = 8_000

/** S3（legacy cancelled，origin 缺席）与 S4（legacy user-close 正向对照）的 fixture id。 */
const LEGACY_CANCELLED_ID = `${RECORD_ID_PREFIX}a14legacycancelled7d3a`
const LEGACY_USERCLOSE_ID = `${RECORD_ID_PREFIX}a14legacyuserclose9f21`

export const meta = {
	id: 'p0-notify-cancelled-exclusion-lock',
	priority: 'P0',
	title: 'V10：cancelled 族终态 record 不补投——D5 两排除位真机行为锁（成因位全 origin / origin=workflow 整体排除），对话流无 cancelled 文案',
	covers: [
		'session.create', 'chat.send', 'chat.wait',
		'subagent.dispatch', 'subagent.list',
		'workflow.dispatch', 'workflow.runs',
		'protocol.rpc',
	],
	requires: ['mock-http'],
	estimateSec: 420,
	llm: {
		responses: {
			// 主队：轮 1 派发 workflow_run → 轮 2 哨兵收尾 → 轮 3/4 两次对账边沿触发轮的
			// 应答（回合收尾 = agent_settled 挂点）→ 轮 5+ 备用（多备无害）。
			[`mockllm/${MAIN_MODEL}`]: [
				{
					text: '跑一个双成员 fan-out workflow（A14）：',
					toolCalls: [
						{
							name: 'workflow_run',
							args: {
								name: WORKFLOW_SCRIPT,
								model: `mockllm/${SUB_MODEL_OK}`,
								args: {
									tasks: ['第一路：报出你剧本里的 canary', '第二路：报出你剧本里的 canary'],
									models: [`mockllm/${SUB_MODEL_OK}`, `mockllm/${SUB_MODEL_CANCEL}`],
								},
							},
						},
					],
					stopReason: 'toolUse',
				},
				{ text: 'A14-WORKFLOW-DISPATCHED', stopReason: 'stop' },
				{ text: 'A14-EDGE-1-ACK', stopReason: 'stop' },
				{ text: 'A14-EDGE-2-ACK', stopReason: 'stop' },
				{ text: 'A14-ACK-SPARE-1', stopReason: 'stop' },
				{ text: 'A14-ACK-SPARE-2', stopReason: 'stop' },
			],
			// M1：SO 交付步 + 带文本 stop 收尾步（成员轮成败只产自引擎收尾边沿；stop 步
			// 必须携带文本——探针实测无文本 stop 步后引擎仍会再请求、队列耗尽 404 使成员
			// 判 failed，A5 成员队列的 text+stop 已验证形态）。
			[`mockllm/${SUB_MODEL_OK}`]: [
				{ toolCalls: [{ name: 'structured-output', args: { summary: GC_CANARY } }], stopReason: 'toolUse' },
				{ text: `${GC_CANARY}-done`, stopReason: 'stop' },
			],
			// M2：长 SO 队列保持在途（run 级 abort 的确定性跑道）；尾步带文本 stop 仅在
			// abort 竞态全输时兜底（此时 closed+cancelled 前提断言红，如实失败重跑）。
			[`mockllm/${SUB_MODEL_CANCEL}`]: [
				...Array.from({ length: CANCEL_QUEUE_STEPS }, (_, i) => ({
					toolCalls: [{ name: 'structured-output', args: { summary: `A14 cancel member step ${i}` } }],
					stopReason: 'toolUse',
				})),
				{ text: 'A14-CANCEL-MEMBER-UNEXPECTED-END', stopReason: 'stop' },
			],
		},
		mainModel: MAIN_MODEL,
		subModel: SUB_MODEL_OK,
	},
	env: {
		// 托管观测档：subagents component 的 debug fileLog 全量落盘（对账派发行与补投
		// 受理行的唯一落盘留痕；边沿可辨 = dispatch 行 detail.reason）。
		TAIJI_AGENT_EXT_LOG: '1',
	},
	provable: [
		'C：装配自检——models.json 的 mock provider 指向本机 mock 服务且成员模型在册（p0-workflow-partial 同款）',
		'B：workflow run 受理——fanout-partial run 出现（getWorkflows）',
		'B：派发轮收尾（turn #1 message.complete，run 异步在途）',
		'C：M1 构造前提——workflow 正常完成成员 manifest 落 closed+gc（closedReason="gc" ∧ origin="workflow"）',
		'B：run 级 abort 受理（session.workflowAction abort → workflowActionDone）',
		'C：M2 构造前提——中途取消成员 manifest 落 closed+cancelled（closedReason="cancelled" ∧ origin="workflow"，settleWorkflowRecord 契约写点产物）',
		'C：S3/S4 存量 fixture 已注入且形状正确（manifest 单源形态：status=closed ∧ closedReason 对应 ∧ 无 origin ∧ 无 eventsStamp）',
		'B：对账边沿已驱动（回合收尾轮 message.complete）',
		'C：边沿可辨——subagents 日志 dispatch reason="agent_settled" ≥1（时窗内）',
		'C：正向对照 S4 补投恰 1 条（notify entry details.notifyId = S4 id）且 outbox 条目落盘——manifest 源 record 确实被扫描、补投管道可用',
		'C：S3（legacy cancelled，origin 缺席）零补投——notify=0 ∧ outbox=0 ∧ fileLog 无该 id 补投受理行（排除位一单独命中）',
		'C：M2（workflow cancelled 成员）零补投——notify=0 ∧ outbox=0（排除位一双命中）',
		'C：M1（workflow gc 成员）零补投——notify=0 ∧ outbox=0（排除位二单独命中）',
		'C：对话流无「Subagent … cancelled.」文案（全会话条目正则零命中——该文案分支现行无产生路径）',
		'C：幂等——静默窗 + 二次边沿后 S4 恒 1、三排除对象恒 0（无第二条同 id）',
	],
	notProvable: [
		'N1（killed 不补投）的 bash 域侧：跨域双锁的另一半由 u1 RL3 真值表单测承载（验收映射 A11 不编译节点）——本剧本只锁 subagent 域两排除位',
		'排除位真值表全组合逐行判定：u3 单测承载（真值表 2×2×2 组合不可真机逐行构造）——本剧本锁真机可达的四行（gc+workflow / cancelled+workflow / cancelled+origin 缺席 / user-close+origin 缺席）',
		'「Subagent … cancelled.」现行无产生路径的全称否定：本剧本只证本场景窗口内全会话条目零命中（历史会话与其他域不在窗口）',
		'切回补强边沿（__taiji_bg_reconcile__）形态：V10 ②「切回或回合收尾」二选一——本剧本用回合收尾（agent_settled，A5 组 b 同款驱动）；切回形态由 A5 场景承载',
		'UI 面：通知气泡渲染（归 UI 剧本）——本剧本只验执行层投递与落盘事实',
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

/** 时窗内含 mark 的行清单（行首时间戳 ≥ sinceMs）。 */
function linesWithMarkInWindow(text, mark, sinceMs) {
	return text.split('\n').filter((line) => {
		if (!line.includes(mark)) return false
		const ts = Date.parse(line.slice(0, ISO_TS_LEN))
		return Number.isFinite(ts) && ts >= sinceMs
	})
}

/** 时窗内 dispatch 行按 detail.reason 的计数表（A5 同款口径）。 */
function dispatchReasonCounts(text, mark, sinceMs) {
	const counts = {}
	for (const line of linesWithMarkInWindow(text, mark, sinceMs)) {
		const m = /"reason":"([a-z_]+)"/.exec(line)
		const reason = m?.[1] ?? '(unparsed)'
		counts[reason] = (counts[reason] ?? 0) + 1
	}
	return counts
}

/** 主文件注入通知 entry 行：customType=subagent-bg-notify 且 JSON.parse 成功。 */
function notifyEntryLines(raw) {
	return raw.split('\n').filter((line) => {
		if (!line.includes(NOTIFY_CUSTOM_TYPE)) return false
		try {
			return JSON.parse(line)?.customType === NOTIFY_CUSTOM_TYPE
		} catch {
			return false
		}
	})
}

/** 通知行的幂等键集（details.notifyId ∨ details.deliveryId ∨ details.id）。 */
function notifyEntryIds(lines) {
	const ids = new Set()
	for (const line of lines) {
		try {
			const details = JSON.parse(line)?.details ?? {}
			for (const k of ['notifyId', 'deliveryId', 'id']) {
				if (typeof details[k] === 'string' && details[k] !== '') ids.add(details[k])
			}
		} catch { /* 坏行跳过 */ }
	}
	return ids
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

/** 读主会话 JSONL 原文（本剧本进程读不受写句柄影响，A1/A5 同款）。 */
function readRaw(sessionFile) {
	try {
		return sessionFile ? fs.readFileSync(sessionFile, 'utf8') : ''
	} catch {
		return ''
	}
}

/** 读 records 目录下全部 manifest（<id>.json → 解析成功的对象数组，附文件名）。 */
function readRecordManifests(recordsDir) {
	if (!fs.existsSync(recordsDir)) return []
	const out = []
	for (const f of fs.readdirSync(recordsDir)) {
		if (!f.endsWith('.json') || f.includes('.tmp.')) continue
		try {
			const m = JSON.parse(fs.readFileSync(path.join(recordsDir, f), 'utf8'))
			if (m && typeof m === 'object' && typeof m.id === 'string') out.push({ file: f, ...m })
		} catch { /* 坏文件跳过 */ }
	}
	return out
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir, repo, instance } = ctx
	const uncovered = []
	const gotchas = [
		'M1/M2 终态判定读 manifest 磁盘事实（terminalManifestRecord：status="closed" ∧ executionStatus="idle" ∧ closedReason 随派生视图）——比 getSubagents 派生视图更靠近判据输入（isLegacyClosedSettled 读的就是 idle ∧ closedReason 位）',
		'S3/S4 为 manifest 单源 fixture（无 .events、无 eventsStamp——mergeManifestRecords 的存量宽容通道；origin 缺席 = 旧 CAS 时代 binding sidecar 缺失的历史遗留形态，不在排除位二覆盖内，正是排除位一「全 origin」的受试形态）',
		'S4 正向对照是「零补投」断言可信性的结构保障：若对账根本没扫到 manifest 源 record，S4 断言红（假绿防御——A4 判据代差假绿的同型风险）',
		'M2 的 closed+cancelled 依赖 run 级 abort（session.workflowAction）命中在途轮：若 abort 晚于 M2 队列耗尽（60 步 SO 跑完），M2 落 closed+gc，M2 构造前提断言红——装配竞态非产品缺陷，重跑即消',
		'run 级 abort 会派生 run 收尾 wf-done 通知（customType=workflow-result，取消亦通知）——不属本域断言对象（subagent 域排除位锁的是成员 record 的 subagent-bg-notify 通道），断言按 customType 过滤不受其干扰',
	]

	// ── 段 0：装配自检 ──
	if (!fs.existsSync(WORKFLOW_SCRIPT)) {
		ev.assert('夹具：fanout-partial.workflow.js 在盘', false, { channel: 'C', expected: WORKFLOW_SCRIPT, actual: '文件不存在' })
		return { uncovered: ['workflow 夹具缺失，剧本中止', ...uncovered], gotchas }
	}
	const topo = instance.llm
	const modelsJson = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'models.json'), 'utf8') || '{}')
	const provider = modelsJson.providers?.[topo.providerId]
	ev.assert('装配：models.json 的 mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
		channel: 'C',
		expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
		actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
	})

	// ── 段 1：派发最短 workflow run（双成员 fan-out）──
	const created = await protocol.call('session.create', { cwd: repo, label: 'a14-cancelled-lock' }, { timeoutMs: 120_000 })
	const sid = created.session?.id
	ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
		channel: 'B',
		expected: 'session.id 非空',
		actual: JSON.stringify(created.session ?? {}).slice(0, 200),
	})
	if (!sid) throw new Error('session.create 未返回 sessionId')
	await protocol.subscribe(sid)
	log(`session=${sid} model=${created.session?.modelId}`)
	ev.step({ step: 'session.create', channel: 'B', exitCode: 0, stats: { sessionId: sid } })

	const since = protocol.events.length
	await protocol.send(sid, 'run the two-member fan-out workflow (A14 段 1)')
	const end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
	ev.assert('B: 派发轮收尾（turn #1 message.complete，run 异步在途）', end1.type === 'message.complete' && end1.ok, {
		channel: 'B',
		expected: 'message.complete + 主队哨兵',
		actual: `${end1.type} stop=${end1.payload?.stopReason ?? 'n/a'}`,
	})

	// run 受理（getWorkflows 出现 fanout-partial run）
	// recordsDir 布局（session-store-paths.ts getSessionSubagentRecordsDir）：
	// <dataDir>/ext-sessions/<sid>/subagents/records/——成员 manifest（<id>.json）所在。
	const recordsDir = path.join(dataDir, 'ext-sessions', String(sid), 'subagents', 'records')
	const deadlineRun = Date.now() + 120_000
	let runs = []
	while (Date.now() < deadlineRun) {
		const reply = await protocol.call('session.getWorkflows', { sessionId: sid }, { timeoutMs: 60_000 })
		runs = reply.workflows ?? []
		if (runs.length > 0) break
		await new Promise((r) => setTimeout(r, 500))
	}
	const run1 = runs[0] ?? null
	ev.assert('B: workflow run 受理（getWorkflows 含 fanout-partial run）', Boolean(run1?.runId), {
		channel: 'B',
		expected: 'getWorkflows 含 run 且 runId 非空',
		actual: `runs=${runs.length} runId=${run1?.runId ?? '<缺>'} status=${run1?.status ?? '<缺>'}`,
	})
	if (!run1?.runId) throw new Error('workflow run 未出现——段 2 abort 无对象')
	ev.attach('workflow-runs', JSON.stringify(runs, null, 2).slice(0, 40_000))

	// 等 M1 终态（manifest closedReason="gc" ∧ origin="workflow"）——M2 仍在途（长队列）
	const m1Terminal = await pollUntil(() => {
		const ms = readRecordManifests(recordsDir).filter((m) => m.origin === 'workflow')
		return ms.some((m) => m.closedReason === 'gc') ? ms : null
	}, { timeoutMs: 180_000, intervalMs: 200 })
	const workflowMembers = m1Terminal ?? readRecordManifests(recordsDir).filter((m) => m.origin === 'workflow')
	const m1 = workflowMembers.find((m) => m.closedReason === 'gc') ?? null
	ev.assert('C: M1 构造前提——workflow 正常完成成员 manifest 落 closed+gc ∧ origin=workflow', Boolean(m1?.id), {
		channel: 'C',
		expected: `recordsDir 含 origin=workflow 且 closedReason="gc" 的成员 manifest`,
		actual: `workflowMembers=${JSON.stringify(workflowMembers.map((m) => ({ id: m.id, status: m.status, executionStatus: m.executionStatus, closedReason: m.closedReason })))}`,
	})
	if (!m1?.id) throw new Error('M1（gc 成员）未出现——三对象对照无法构造')
	const m1Id = m1.id

	// ── 段 2：run 级 abort —— M2 中途取消（settleWorkflowRecord 契约写点）──
	let abortReply = null
	try {
		abortReply = await protocol.call('session.workflowAction', { sessionId: sid, action: 'abort', runId: run1.runId }, { replyType: 'session.workflowActionDone', timeoutMs: 60_000 })
	} catch (e) {
		ev.attach('abort-error', String(e?.message ?? e).slice(0, 400))
	}
	ev.assert('B: run 级 abort 受理（session.workflowAction abort）', Boolean(abortReply), {
		channel: 'B',
		expected: 'session.workflowActionDone 回包',
		actual: abortReply ? JSON.stringify(abortReply).slice(0, 200) : 'RPC 失败（见 abort-error 附件）',
	})
	ev.step({ step: 'workflow.abort', channel: 'B', exitCode: abortReply ? 0 : 1, stats: { runId: run1.runId } })

	// 等 M2 终态：closed+cancelled（settleOneShotOutcome aborted 分支 → settleWorkflowRecord）
	const m2Terminal = await pollUntil(() => {
		const ms = readRecordManifests(recordsDir).filter((m) => m.origin === 'workflow')
		return ms.some((m) => m.closedReason === 'cancelled') ? ms : null
	}, { timeoutMs: 120_000, intervalMs: 500 })
	const workflowFinal = m2Terminal ?? readRecordManifests(recordsDir).filter((m) => m.origin === 'workflow')
	const m2 = workflowFinal.find((m) => m.closedReason === 'cancelled') ?? null
	ev.assert('C: M2 构造前提——中途取消成员 manifest 落 closed+cancelled ∧ origin=workflow', Boolean(m2?.id), {
		channel: 'C',
		expected: 'recordsDir 含 origin=workflow 且 closedReason="cancelled" 的成员 manifest',
		actual: `workflowFinal=${JSON.stringify(workflowFinal.map((m) => ({ id: m.id, status: m.status, executionStatus: m.executionStatus, closedReason: m.closedReason })))}`,
	})
	if (!m2?.id) throw new Error('M2（cancelled 成员）未落 closed+cancelled——V10 ①构造前提不成立')
	const m2Id = m2.id
	const m1Final = readRecordManifests(recordsDir).find((m) => m.id === m1Id)
	ev.step({
		step: 'workflow.members.terminal', channel: 'C', exitCode: 0,
		stats: { m1: `${m1Id}:closed+${m1Final?.closedReason}`, m2: `${m2Id}:closed+cancelled`, recordsDir },
	})

	// ── 段 3：注入 S3/S4 存量 fixture（manifest 单源形态）──
	// 形态依据：mergeManifestRecords 存量宽容通道（无 eventsStamp 接受）+ manifestToSubagent
	// （旧三态 status → idle；closedReason 随派生视图；origin 仅 workflow 才下行——缺席态）。
	// 旧 CAS 写点时代无 executionStatus 字段，S3/S4 刻意不带该字段（回落 mapManifestStatus）。
	function legacyManifest(id, agentName, closedReason, slug) {
		return {
			id,
			rootSessionId: sid,
			agentName,
			status: 'closed',
			closedReason,
			createdAt: Date.now() - 86_400_000,
			completedAt: Date.now() - 86_300_000,
			task: `A14 legacy fixture (${closedReason}, origin absent — binding sidecar missing)`,
			slug,
		}
	}
	const fixtures = [
		{ file: `${LEGACY_CANCELLED_ID}.json`, manifest: legacyManifest(LEGACY_CANCELLED_ID, 'legacy-cancelled-agent', 'cancelled', 'a14-legacy-cancelled') },
		{ file: `${LEGACY_USERCLOSE_ID}.json`, manifest: legacyManifest(LEGACY_USERCLOSE_ID, 'legacy-userclose-agent', 'user-close', 'a14-legacy-userclose') },
	]
	for (const f of fixtures) {
		fs.writeFileSync(path.join(recordsDir, f.file), `${JSON.stringify(f.manifest, null, 2)}\n`, 'utf8')
	}
	const fixtureShapes = fixtures.map((f) => {
		const m = readRecordManifests(recordsDir).find((x) => x.id === f.manifest.id)
		return m ? { id: m.id, status: m.status, closedReason: m.closedReason, origin: m.origin, eventsStamp: m.eventsStamp } : null
	})
	ev.assert(
		'C: S3/S4 存量 fixture 已注入且形状正确（closed ∧ 对应 closedReason ∧ origin 缺席 ∧ 无 eventsStamp）',
		fixtureShapes.every((s) => s && s.status === 'closed' && s.origin === undefined && s.eventsStamp === undefined)
			&& fixtureShapes.some((s) => s?.closedReason === 'cancelled') && fixtureShapes.some((s) => s?.closedReason === 'user-close'),
		{
			channel: 'C',
			expected: '两条 manifest 单源 fixture（cancelled / user-close，origin 与 eventsStamp 双缺席）',
			actual: JSON.stringify(fixtureShapes),
		},
	)
	ev.attach('a14-fixtures', JSON.stringify(fixtures.map((f) => f.manifest), null, 2))

	// ── 段 4：触发对账边沿（回合收尾 agent_settled——V4b 形态）──
	const edge1At = Date.now()
	const sinceE1 = protocol.events.length
	await protocol.send(sid, 'edge 1: confirm the workflow members are on file (A14 段 4 对账边沿)')
	let endE1 = null
	try {
		endE1 = await protocol.waitTurnEnd(sid, { since: sinceE1, timeoutMs: 120_000 })
	} catch (e) {
		ev.attach('edge1-turn-end-miss', String(e?.message ?? e).slice(0, 400))
	}
	ev.assert('B: 对账边沿已驱动（回合收尾轮 message.complete）', endE1?.type === 'message.complete' && endE1?.ok, {
		channel: 'B',
		expected: 'message.complete（主队 EDGE-1 应答）',
		actual: endE1 ? `${endE1.type} stop=${endE1.payload?.stopReason ?? 'n/a'}` : '未等到',
	})

	// 边沿可辨：dispatch reason="agent_settled" ≥1（时窗）
	const dispatchSeen = await pollUntil(() => {
		const { text } = readComponentLog(dataDir, CORE_LOG_PREFIX)
		return (dispatchReasonCounts(text, SUB_RECONCILE_MARK, edge1At).agent_settled ?? 0) >= 1 ? true : null
	}, { timeoutMs: 15_000, intervalMs: 500 })
	const { text: coreLogE1 } = readComponentLog(dataDir, CORE_LOG_PREFIX)
	const reasonsE1 = dispatchReasonCounts(coreLogE1, SUB_RECONCILE_MARK, edge1At)
	ev.step({ step: 'observe.reconcile-dispatch', channel: 'C', exitCode: 0, stats: { reasons: reasonsE1 } })
	ev.assert('C: 边沿可辨——subagents 日志 dispatch reason="agent_settled" ≥1', Boolean(dispatchSeen), {
		channel: 'C',
		expected: 'notify reconcile dispatch {"detail":{"reason":"agent_settled"}} ≥1',
		actual: `边沿时窗 reason 计数=${JSON.stringify(reasonsE1)}`,
	})

	// ── 段 5：零补投断言（S4 正向对照先到位——对账确实扫到 manifest 源 record）──
	const excludedIds = new Set([m1Id, m2Id, LEGACY_CANCELLED_ID])
	const s4Delivered = await pollUntil(() => {
		const ids = notifyEntryIds(notifyEntryLines(readRaw(created.session?.sessionFile ?? '')))
		return ids.has(LEGACY_USERCLOSE_ID) ? ids : null
	}, { timeoutMs: REDLIVERY_BUDGET_MS, intervalMs: 1_000 })

	const raw1 = readRaw(created.session?.sessionFile ?? '')
	const notifyLines1 = notifyEntryLines(raw1)
	const notifyIds1 = s4Delivered ?? notifyEntryIds(notifyLines1)
	const s4NotifyLines = notifyLines1.filter((line) => line.includes(LEGACY_USERCLOSE_ID))
	ev.assert(`C: 正向对照 S4 补投恰 1 条（manifest 源 record 确实被扫描、补投管道可用；时延 ${Date.now() - edge1At}ms）`, s4Delivered !== null && s4NotifyLines.length === 1, {
		channel: 'C',
		expected: `notify=1 且 details.notifyId=${LEGACY_USERCLOSE_ID}（≤${REDLIVERY_BUDGET_MS}ms）`,
		actual: `S4 notify=${s4NotifyLines.length} 边沿后全量 notify=${notifyLines1.length} 幂等键集=${JSON.stringify([...notifyIds1])}`,
	})
	const s4Outbox = outboxEntryLines(raw1, new Set([LEGACY_USERCLOSE_ID]))
	ev.assert('C: S4 补投受理落盘（delivery-port-outbox 条目 data.id = S4 id）', s4Outbox.length >= 1, {
		channel: 'C',
		expected: `outbox 条目 data.id=${LEGACY_USERCLOSE_ID} ≥1`,
		actual: `outbox=${s4Outbox.length}`,
	})
	if (s4NotifyLines[0]) ev.attach('s4-notify-entry', s4NotifyLines[0].slice(0, 8_000))

	// 三排除对象零补投：notify entry / outbox 条目 / fileLog 补投受理行三通道全零
	const excludedNotify = notifyLines1.filter((line) => {
		if (![m1Id, m2Id, LEGACY_CANCELLED_ID].some((id) => line.includes(id))) return false
		return true
	})
	const excludedOutbox = outboxEntryLines(raw1, excludedIds)
	const { text: redeliveredLog1 } = readComponentLog(dataDir, CORE_LOG_PREFIX)
	const redeliveredLines1 = linesWithMarkInWindow(redeliveredLog1, REDLIVERED_MARK, edge1At).filter((line) =>
		[m1Id, m2Id, LEGACY_CANCELLED_ID].some((id) => line.includes(id)))
	ev.assert('C: S3（legacy cancelled，origin 缺席）零补投——notify=0 ∧ outbox=0 ∧ 无补投受理行（排除位一单独命中）',
		!excludedNotify.some((l) => l.includes(LEGACY_CANCELLED_ID)) && !excludedOutbox.some((l) => l.includes(LEGACY_CANCELLED_ID)) && !redeliveredLines1.some((l) => l.includes(LEGACY_CANCELLED_ID)), {
		channel: 'C',
		expected: `${LEGACY_CANCELLED_ID} 三通道全零`,
		actual: `notify=${excludedNotify.filter((l) => l.includes(LEGACY_CANCELLED_ID)).length} outbox=${excludedOutbox.filter((l) => l.includes(LEGACY_CANCELLED_ID)).length} fileLog=${redeliveredLines1.filter((l) => l.includes(LEGACY_CANCELLED_ID)).length}`,
	})
	ev.assert('C: M2（workflow cancelled 成员）零补投——notify=0 ∧ outbox=0（排除位一双命中）',
		!excludedNotify.some((l) => l.includes(m2Id)) && !excludedOutbox.some((l) => l.includes(m2Id)) && !redeliveredLines1.some((l) => l.includes(m2Id)), {
		channel: 'C',
		expected: `${m2Id} 三通道全零`,
		actual: `notify=${excludedNotify.filter((l) => l.includes(m2Id)).length} outbox=${excludedOutbox.filter((l) => l.includes(m2Id)).length} fileLog=${redeliveredLines1.filter((l) => l.includes(m2Id)).length}`,
	})
	ev.assert('C: M1（workflow gc 成员）零补投——notify=0 ∧ outbox=0（排除位二单独命中）',
		!excludedNotify.some((l) => l.includes(m1Id)) && !excludedOutbox.some((l) => l.includes(m1Id)) && !redeliveredLines1.some((l) => l.includes(m1Id)), {
		channel: 'C',
		expected: `${m1Id} 三通道全零`,
		actual: `notify=${excludedNotify.filter((l) => l.includes(m1Id)).length} outbox=${excludedOutbox.filter((l) => l.includes(m1Id)).length} fileLog=${redeliveredLines1.filter((l) => l.includes(m1Id)).length}`,
	})

	// 对话流无「Subagent … cancelled.」文案（全会话条目，不限 customType）
	const cancelledCopyHits = raw1.split('\n').filter((line) => CANCELLED_COPY_RE.test(line))
	ev.assert('C: 对话流无「Subagent … cancelled.」文案（全会话条目正则零命中）', cancelledCopyHits.length === 0, {
		channel: 'C',
		expected: '0 条（该文案分支为旧 CAS 终态化时代遗留、现行无产生路径）',
		actual: `hits=${cancelledCopyHits.length}${cancelledCopyHits[0] ? `：${cancelledCopyHits[0].slice(0, 200)}` : ''}`,
	})
	if (cancelledCopyHits.length > 0) ev.attach('cancelled-copy-hits', cancelledCopyHits.join('\n').slice(0, 8_000))

	// ── 段 6：幂等——静默窗 + 二次边沿后计数不变 ──
	await new Promise((r) => setTimeout(r, IDEMPOTENCE_QUIET_MS))
	const sinceE2 = protocol.events.length
	await protocol.send(sid, 'edge 2: idempotence probe (A14 段 6 二次对账边沿)')
	try {
		await protocol.waitTurnEnd(sid, { since: sinceE2, timeoutMs: 120_000 })
	} catch (e) {
		ev.attach('edge2-turn-end-miss', String(e?.message ?? e).slice(0, 400))
	}
	await new Promise((r) => setTimeout(r, 4_000))
	const raw2 = readRaw(created.session?.sessionFile ?? '')
	const notifyLines2 = notifyEntryLines(raw2)
	const s4Final = notifyLines2.filter((line) => line.includes(LEGACY_USERCLOSE_ID))
	const excludedFinal = notifyLines2.filter((line) => [m1Id, m2Id, LEGACY_CANCELLED_ID].some((id) => line.includes(id)))
	ev.assert('C: 幂等——静默窗 + 二次边沿后 S4 恒 1、三排除对象恒 0（无第二条同 id）',
		s4Final.length === 1 && excludedFinal.length === 0, {
		channel: 'C',
		expected: `S4 notify=1 ∧ 排除对象 notify=0（+${IDEMPOTENCE_QUIET_MS / 1000}s 静默窗 + 二次边沿后）`,
		actual: `S4=${s4Final.length} 排除对象=${excludedFinal.length} 全量=${notifyLines2.length}`,
	})

	// 铁证观察：mock server 收到的成员模型请求（M2 真的在途消费过队列）
	const allRequests = instance.mockLlm?.requests ?? []
	const cancelReq = allRequests.filter((r) => r.model === SUB_MODEL_CANCEL && r.status === 200)
	ev.step({
		step: 'mock.requests', channel: 'C', exitCode: 0,
		stats: { total: allRequests.length, [`${SUB_MODEL_CANCEL}Ok`]: cancelReq.length, models: [...new Set(allRequests.map((r) => r.model))].join(',') },
	})

	log(`done m1=${m1Id}(gc) m2=${m2Id}(cancelled) s3=${LEGACY_CANCELLED_ID} s4=${LEGACY_USERCLOSE_ID} notify=${notifyLines2.length}`)
	return { uncovered, gotchas }
}
