/**
 * p0-notify-criteria-four-state-truth —— V3 判据四态真值（防误补投）：真机会话构造
 * 四种形态逐态核对三重判据输出，补投只认 rejected 丢失形态
 * （completion-signal-delivery 设计 §4.1 V3 / §4.2 RL3 真机形态抽验——RL3 真值表
 * 逐行布尔断言归 u1 单测 notify-reconcile-judgement.test.ts:187-195，验收项 A3，
 * D0 约定名，2026-11-02 前置组装义务履行入库）。
 *
 * 三重判据（pending-reconcile.ts isReapNotifyCandidate → 骨架
 * notify-reconcile-judgement.ts:125-127）：候选 = registry 终态 ∧ 非 killed ∧
 * 送达痕迹未命中 ∧ 投递日志无条目。四态 → 判定位映射（本剧本的抽验对象）：
 *   ① 已送达（delivered 命中）：主路径通知正常注入 → 对账 → 零补投
 *   ② 已受理在途（journaled 命中、delivered 未命中）：投递日志有条目、通知未送达
 *      → 对账 → 零补投（有条目 = 差集重放职责，补投日志无 deliver 记录）
 *   ③ 已终局（ack 终局确认落盘 = journaled 经 ack 位命中）：对账 → 零补投
 *   ④ rejected 丢失（三重全未命中）：对账 → 恰好 1 条补投
 *
 * 装配：faux + idleBackgroundSec=30 + TAIJI_AGENT_EXT_LOG=1（warn fileLog 落盘供
 * rejected / 补投痕迹取证，A1/A2 同款）。单会话串行四态（共享环境面纪律：四态
 * 共用对账触发设施同批跑——verify 串行链保证无并发争用）：
 *   任务 T1（sleep 35，无钩子）：自然完成 → 主路径通知送达 → 态①（通知落盘后立即
 *   对账）+ 态③（等 delivery-port-ack 终局条目落盘后二次对账）。
 *   任务 T2（sleep 45，chmod 0444 钩子）：完成瞬间 rejected(persist-failed)（幂等
 *   键未登记、outbox 未落）→ 关钩子 → 对账 → 态④（恰好 1 条补投 + outbox 落盘 +
 *   幂等）。
 *   态②（磁盘 fixture 注入，静默窗后）：向 registry 追加终态 fixture 条目（模板 =
 *   T2 真实 exited 条目）+ 向会话 JSONL append 一条 delivery-port-outbox fixture
 *   行（形态对齐 persistOutboxRecord，可被 readOutboxDataV2 解析）且不注入通知
 *   entry——即「受理已落盘、送达缺席」的磁盘等价形态；对账后断言零补投。
 *
 * 对账边沿驱动 = session.getCommands RPC（切回必经查询，runtime 经 prompt
 * '/__taiji_bg_reconcile__' 无条件补触发维护链，A1 同款手段）。三入口对账只跑
 * reconcilePendingEntries、不含差集重放（index.ts runReconcileMaintenance；recover
 * 仅挂 session_start 装配点）——态② fixture 行不会被重放中途投出，断言口径干净。
 *
 * 通知计数口径：注入 entry 行统计（customType≠delivery-port-outbox 且头行形态匹配，
 * 排除投递日志行）——unified-delivery 每条通知结构性落两行，A1 同款纪律。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	findSessionFile,
	pollSessionFile,
	pollUntil,
	toolResultsFor,
	waitForBashCallStart,
	writeIdleConfig,
	extractTaskId,
	readRegistry,
	registryPathOf,
	readSessionEntries,
} from './lib/fg-bg-lib.mjs'

/** 空闲转后台阈值（秒，A1/A2 同款前置）。 */
const IDLE_SEC = 30
/** turn 收尾哨兵（faux 收尾轮文本——chmod 时点锚 + turn 边界锚）。 */
const T1_SENTINEL = 'FGBG-A3-T1-END'
const T2_SENTINEL = 'FGBG-A3-T2-END'
/** 完成通知「结果未知」形态头行（单行匹配用，A1/A2 同款）。 */
const NOTIFY_UNKNOWN_RE = /\[background-bash\][^\n]*finished \(exit code unknown[^\n]*\)/
/** 投递日志 outbox 条目的 customType（delivery-port journal.ts OUTBOX_CUSTOM_TYPE）。 */
const OUTBOX_CUSTOM_TYPE = 'delivery-port-outbox'
/** 投递终局 ack 条目的 customType（journal.ts ACK_CUSTOM_TYPE；data = {v:2, id}）。 */
const ACK_CUSTOM_TYPE = 'delivery-port-ack'
/** 扩展名（extension-logger fileLog 文件名前缀）。 */
const EXT_NAME = 'base-tool-enhance'
/** 首败 rejected warn 消息串（notify.ts rejected 分支，A1 同款正则锚定）。 */
const FIRST_REJECT_RE = /background task notify rejected by delivery port[^\n]*/
/** 重提仍败 warn 消息串（notify.ts single retry spent，A1 同款）。 */
const RETRY_REJECT_RE = /background task notify retry rejected[^\n]*/
/** 补投通道痕迹标记（pending-reconcile rejected/skipped warn 共同子串——accepted
 * 补投无 warn，其痕迹 = 新增 outbox 条目，由计数断言承载）。 */
const REAP_MARK = 'reap-notify'
/** 维护链派发证据（index.ts debug 日志，TAIJI_AGENT_EXT_LOG=1 下降档落盘）。 */
const DISPATCH_MARK = 'reconcile maintenance dispatch'
/** turn 收尾事件类型（与 protocol waitTurnEnd 内部集合一致）。 */
const TURN_END_TYPES = new Set(['message.complete', 'message.error', 'message.stream_error', 'session.exited'])
/** 补投/主路径通知的 bt- id 形态（A1 同款）。 */
const TASK_ID_RE = /bt-[A-Za-z0-9_-]+/
/** 态③ ack 终局条目等待预算（毫秒）：通知出站 → message_end 凭据确认 → store.ack。 */
const ACK_WAIT_MS = 45_000
/** 对账边沿后补投产出观测静置（毫秒，覆盖注入与 fileLog 落盘抖动）。 */
const EDGE_SETTLE_MS = 5_000

export const meta = {
	id: 'p0-notify-criteria-four-state-truth',
	priority: 'P0',
	title: 'V3：判据四态真值——已送达/在途/已终局对账零补投、rejected 丢失恰好 1 条补投',
	covers: ['session.create', 'chat.send', 'chat.wait', 'chat.stream'],
	requires: ['faux'],
	estimateSec: 480,
	faux: {
		responses: [
			// 轮 1：T1 长任务命令（30s 静默转后台，35s 自然完成）
			{ toolCalls: [{ name: 'bash', args: { command: 'sleep 35 && echo t1-done' } }], stopReason: 'toolUse' },
			// 轮 2：T1 转后台标记返回后模型收尾（turn #1 结束）
			{ text: T1_SENTINEL, stopReason: 'stop' },
			// 轮 3：T1 主路径完成通知 steer 注入唤醒的新 run 应答
			{ text: 'FGBG-A3-T1-NOTIFY-ACK', stopReason: 'stop' },
			// 轮 4：T2 长任务命令（30s 静默转后台，45s 自然完成，完成瞬间撞只读窗）
			{ toolCalls: [{ name: 'bash', args: { command: 'sleep 45 && echo t2-done' } }], stopReason: 'toolUse' },
			// 轮 5：T2 转后台标记返回后模型收尾（turn #2 结束，chmod 时点锚）
			{ text: T2_SENTINEL, stopReason: 'stop' },
			// 轮 6：T2 对账补投 steer 注入唤醒的新 run 应答
			{ text: 'FGBG-A3-T2-NOTIFY-ACK', stopReason: 'stop' },
		],
	},
	env: {
		// 托管观测档：warn fileLog 全量落盘（rejected 瞬间 appendEntry 通道被只读窗口
		// 拦截，文件日志是首败/重提/补投 rejected warn 的唯一落盘留痕，A1/A2 同款）。
		TAIJI_AGENT_EXT_LOG: '1',
	},
	provable: [
		'C：T1 转后台标记行到达且提取 taskId1（bt-…，30s 静默转后台）',
		'B：turn #1 以 message.complete 收尾（T1 阻塞解除）',
		'C：态①已送达——主路径通知注入恰 1 条、投递日志 outbox 恰 1 条（主路径受理落盘）',
		'C：态①——对账边沿后零补投（通知恒 1、outbox 恒 1、ext log 无 reap-notify 痕迹新增；delivered 命中 → 非候选）',
		'C：态③已终局——delivery-port-ack 终局条目落盘（data.id = taskId1）',
		'C：态③——二次对账后仍零补投（通知恒 1、outbox 恒 1、ack 恒 1、无 reap-notify 痕迹新增；终局命中 → 非候选）',
		'C：态④——钩子开（0444）后 T2 完成瞬间 rejected：首败 warn（含 recovered 指引）+ 单次重提仍败 warn',
		'C：态④——关钩子对账后补投完成通知恰好 1 条（taskId 与 T2 一致、exit code unknown 形态）',
		'C：态④——投递日志出现 taskId2 的 outbox 条目（补投受理落盘）',
		'C：态④——+8s 静默窗 + 二次对账边沿后通知仍恰好 1 条（幂等）',
		'B：态④——补投 steer 注入唤醒新 run 并以 message.complete 收尾',
		'C：态②已受理在途——fixture 输入事实在位（registry 终态条目回读在册 + 会话 JSONL outbox fixture 行回读命中、通知 entry 缺席）',
		'C：态②——对账边沿后零补投（该 id outbox 恒 1 条即 fixture 原行、无通知 entry、ext log 无 reap-notify 痕迹新增；journaled 命中 → 非候选，补投日志无 deliver 记录）',
	],
	notProvable: [
		'三重判据内部布尔（isTerminal/delivered/journaled/excludedByOrigin）的真机直读：产品无判据内检探针——四态判定由「输入磁盘事实在位断言 + 补投通道产出（零/恰 1）」承载；真值表逐行布尔断言归 u1 单测（RL3 单测化，coverage.md A3 行分工：A3 = 真机形态抽验，逐行判定归单测）',
		'态②设计原文手段「钩子暂停注入」（测试构建钩子）真机不可用：产品侧无 dev 注入开关（A1/A2 chmod 先例同款纪律）——以磁盘 fixture（registry 终态条目 + outbox 受理行、通知 entry 缺席）等价驱动「受理已落盘、送达缺席」形态',
		'GUI pane 渲染细节（视觉档位核对归 V6 真机视觉节点；磁盘事实断言不受 UI 通道影响）',
	],
}

/** 读会话 JSONL 原文（只读本剧本进程不受 pi 写句柄影响，A1 同款）。 */
function readRaw(sessionFile) {
	try {
		return sessionFile ? fs.readFileSync(sessionFile, 'utf8') : ''
	} catch {
		return ''
	}
}

/** 原文条件轮询（A1 同款）。 */
async function pollRawText(sessionFile, predicate, { timeoutMs, intervalMs = 500 } = {}) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const raw = readRaw(sessionFile)
		if (predicate(raw)) return raw
		if (Date.now() >= deadline) return raw
		await new Promise((r) => setTimeout(r, intervalMs))
	}
}

/** 注入通知 entry 行清单：排除 outbox 投递日志行，按头行形态匹配（A1 同款口径）。 */
function notifyEntryLines(raw) {
	return raw.split('\n').filter((line) => {
		if (!line.includes('[background-bash]')) return false
		try {
			return JSON.parse(line)?.customType !== OUTBOX_CUSTOM_TYPE && NOTIFY_UNKNOWN_RE.test(line)
		} catch {
			return false
		}
	})
}

/** 指定 taskId 的 outbox 投递日志条目行（data.id 命中，A1 同款）。 */
function outboxEntryLines(raw, taskId) {
	return raw.split('\n').filter((line) => {
		if (!line.includes(OUTBOX_CUSTOM_TYPE)) return false
		try {
			const entry = JSON.parse(line)
			const data = entry?.data ?? entry
			return data?.id === taskId
		} catch {
			return false
		}
	})
}

/** 指定 taskId 的 ack 终局条目行（customType=delivery-port-ack 且 data.id 命中）。 */
function ackEntryLines(raw, taskId) {
	return raw.split('\n').filter((line) => {
		if (!line.includes(ACK_CUSTOM_TYPE)) return false
		try {
			const entry = JSON.parse(line)
			const data = entry?.data ?? entry
			return data?.id === taskId
		} catch {
			return false
		}
	})
}

/** 消息串出现次数（fileLog 单行一条，A2 同款）。 */
function countMark(text, mark) {
	let n = 0
	let i = text.indexOf(mark)
	while (i !== -1) {
		n += 1
		i = text.indexOf(mark, i + mark.length)
	}
	return n
}

/** 读扩展日志文件全文（extension-logger fileLog：<dataDir>/agent/logs/<ext>-<日期>.log）。 */
function readExtLog(dataDir) {
	const today = new Date().toISOString().slice(0, 10)
	const logFile = path.join(dataDir, 'agent', 'logs', `${EXT_NAME}-${today}.log`)
	try {
		return { logFile, text: fs.readFileSync(logFile, 'utf8') }
	} catch {
		return { logFile, text: '' }
	}
}

/**
 * 单任务驱动段：发命令 → 等 bash 发起 → 等转后台标记 → 提取 taskId。
 * excludeTaskIds = 前序任务的 taskId 集合（同会话多任务时标记行谓词必须排除——
 * 标记行文本不含命令（[TAIJI-FG-BG] 行形态 = after Ns without output + Full log +
 * task_id，wrapper-foreground-idle.test.ts:243 正则锚定），「任意标记行」谓词在 T2
 * 驱动时会立即误命中 T1 的存量行（首跑 a3asm1 实测 t1===t2 锚错任务）。
 */
async function driveBackgroundTask(ctx, protocol, sid, marker, commandIncludes, excludeTaskIds = []) {
	const { ev } = ctx
	const since = protocol.events.length
	await protocol.send(sid, `${marker} 判据四态真值抽验任务`)
	const start = await waitForBashCallStart(protocol, sid, { commandIncludes, timeoutMs: 90_000, since })
	ev.assert(`B: bash 调用发起（tool_call_start：${commandIncludes}）`, Boolean(start), {
		channel: 'B',
		expected: `${commandIncludes} tool_call_start`,
		actual: start ? `at=${new Date(start.receivedAt).toISOString()}` : '90s 内未观察到',
	})
	const sessionFile = await pollUntil(() => findSessionFile(ctx.dataDir, sid), { timeoutMs: 15_000 })
	if (!sessionFile) throw new Error('未定位到会话 JSONL（四态构造无法装配）')
	const isOwnMarker = (r) => {
		if (!r.text.includes('[TAIJI-FG-BG]')) return false
		const id = extractTaskId(r.text)
		return id !== undefined && !excludeTaskIds.includes(id)
	}
	const { entries } = await pollSessionFile(sessionFile, (es) => toolResultsFor(es, 'bash').some(isOwnMarker), {
		timeoutMs: (IDLE_SEC + 30) * 1000,
	})
	const converted = toolResultsFor(entries, 'bash').find(isOwnMarker) ?? null
	const taskId = extractTaskId(converted?.text ?? '')
	ev.assert(`C: 转后台标记行到达且提取 taskId（${marker}，30s 静默触发）`, Boolean(converted && taskId), {
		channel: 'C',
		expected: '[TAIJI-FG-BG] + bt-… taskId',
		actual: converted ? `taskId=${taskId ?? '未提取到'}` : `${IDLE_SEC + 30}s 内无标记行`,
	})
	if (!taskId) throw new Error(`${marker} 转后台标记行无 bt- taskId——四态断言无法锚定幂等键`)
	return { sessionFile, taskId }
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'态②的磁盘 fixture 等价：设计原文手段「钩子暂停注入」（测试构建钩子）真机不可用（产品侧无 dev 注入开关，A1/A2 chmod 先例同款纪律）——「受理已落盘、送达缺席」以 registry 终态 fixture 条目（模板 = T2 真实 exited 条目，写回保持 {version,entries} 字节形态）+ 会话 JSONL append 一条 delivery-port-outbox 行（形态对齐 persistOutboxRecord，v:2/id/timing/payload/recordedAt 全字段可被 readOutboxDataV2 解析）构造；fixture content 不用「finished」文案避免与通知头行口径纠缠，且 customType=outbox 使 collectDeliveredTaskIds 不误收（delivered 恒未命中，正是态②判定位形态）',
		'三入口对账（getCommands 切回 / agent_settled）只跑 reconcilePendingEntries、不含差集重放（index.ts runReconcileMaintenance；recover 仅挂 session_start 装配点）——态② fixture 行不会被重放中途投出，「零补投」断言口径干净；「有条目未送达归差集重放职责」的重放行为本身归 session_start 入口（重启恢复域），不在本剧本断言面',
		'态④钩子窗口内 turn #2 收尾的 agent_settled 边沿会对 T2 发起一次对账补投并 rejected（ext log「reap-notify rejected」warn，判据仍命中 → 下一边沿幂等重投）——设计内自愈重投，非多投；「恰好 1 条」按通知 entry 计数承载（rejected 补投幂等键未登记、无磁盘残留）',
		'态①对账时点 = 主路径通知 entry 落盘后（delivered 已命中）；轮 3 收尾的 agent_settled 边沿同窗自动对账一次，判定同值（幂等无害）',
		'通知计数按注入 entry 行统计、排除 delivery-port-outbox 日志行（A1 同款先例：每条通知结构性落两行）',
	]

	// ── 1. 注入空闲阈值配置 ─────────────────────────────────────────
	const cfgPath = writeIdleConfig(dataDir, { idleBackgroundSec: IDLE_SEC })
	ev.step({ step: 'config.idle-inject', command: `write ${cfgPath}`, exitCode: 0, stats: { idleBackgroundSec: IDLE_SEC } })

	// ── 2. 建会话（临时 cwd，不污染 repo） ─────────────────────────
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fgbg-a3-'))
	const created = await protocol.call('session.create', { cwd, label: 'p0-fgbg-a3' }, { timeoutMs: 120_000 })
	const sid = created.session?.id
	ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
		channel: 'B',
		expected: 'session.id 非空',
		actual: JSON.stringify(created.session ?? {}).slice(0, 200),
	})
	if (!sid) throw new Error('session.create 未返回 sessionId')
	await protocol.subscribe(sid)
	log(`session=${sid} cwd=${cwd}`)

	// ── 3. 态①③共用任务 T1：无钩子自然完成 → 主路径通知送达 ──────
	const t1 = await driveBackgroundTask(ctx, protocol, sid, 'FGBG-A3-T1-START', 'sleep 35')
	const sessionFile = t1.sessionFile
	const taskId1 = t1.taskId
	let end1 = null
	try {
		end1 = await protocol.waitTurnEnd(sid, { since: 0, timeoutMs: 120_000 })
	} catch (e) {
		ev.attach('t1-turn-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	const end1At = end1?.at ?? 0
	ev.assert('B: turn #1 以 message.complete 收尾（T1 阻塞解除）', end1?.type === 'message.complete' && end1.ok, {
		channel: 'B',
		expected: 'message.complete（faux 轮 2 收尾）',
		actual: end1 ? `${end1.type} stop=${String(end1.payload?.stopReason)}` : '未等到',
	})

	// 主路径通知送达（无钩子 → deliver accepted：通知 entry + outbox 受理行双落盘）
	const rawDelivered = await pollRawText(
		sessionFile,
		(raw) => notifyEntryLines(raw).some((l) => TASK_ID_RE.test(l) && TASK_ID_RE.exec(l)?.[0] === taskId1) && outboxEntryLines(raw, taskId1).length >= 1,
		{ timeoutMs: 60_000 },
	)
	const t1Notify = notifyEntryLines(rawDelivered).filter((l) => TASK_ID_RE.exec(l)?.[0] === taskId1)
	const t1Outbox = outboxEntryLines(rawDelivered, taskId1)
	ev.assert('C: 态①已送达——主路径通知注入恰 1 条、投递日志 outbox 恰 1 条', t1Notify.length === 1 && t1Outbox.length === 1, {
		channel: 'C',
		expected: 'notify=1 outbox=1（deliver accepted 双落盘）',
		actual: `notify=${t1Notify.length} outbox=${t1Outbox.length}`,
	})

	// ── 4. 态①：对账边沿 → delivered 命中 → 零补投 ────────────────
	const reapBeforeState1 = countMark(readExtLog(dataDir).text, REAP_MARK)
	try {
		await protocol.call('session.getCommands', { sessionId: sid }, { timeoutMs: 30_000 })
	} catch (e) {
		ev.attach('state1-get-commands-error', String(e?.message ?? e).slice(0, 300))
	}
	await new Promise((r) => setTimeout(r, EDGE_SETTLE_MS))
	const rawState1 = readRaw(sessionFile)
	const { text: extState1 } = readExtLog(dataDir)
	const state1Notify = notifyEntryLines(rawState1).filter((l) => TASK_ID_RE.exec(l)?.[0] === taskId1).length
	const state1Outbox = outboxEntryLines(rawState1, taskId1).length
	const state1ReapDelta = countMark(extState1, REAP_MARK) - reapBeforeState1
	ev.assert('C: 态①已送达——对账边沿后零补投（delivered 命中 → 非候选）', state1Notify === 1 && state1Outbox === 1 && state1ReapDelta === 0, {
		channel: 'C',
		expected: 'notify=1 outbox=1 reap-notify 痕迹新增=0（送达痕迹判据阻断补投）',
		actual: `notify=${state1Notify} outbox=${state1Outbox} reapDelta=${state1ReapDelta}`,
	})
	ev.step({ step: 'state1.delivered-reconcile', command: `session.getCommands ${sid}`, exitCode: state1Notify === 1 && state1Outbox === 1 && state1ReapDelta === 0 ? 0 : 1, stats: { state: 'delivered', notify: state1Notify, outbox: state1Outbox } })

	// ── 5. 态③：等 ack 终局条目落盘 → 二次对账 → 仍零补投 ─────────
	const rawAck = await pollRawText(sessionFile, (raw) => ackEntryLines(raw, taskId1).length >= 1, { timeoutMs: ACK_WAIT_MS })
	const t1Ack = ackEntryLines(rawAck, taskId1)
	ev.assert('C: 态③已终局——delivery-port-ack 终局条目落盘（data.id = taskId1）', t1Ack.length >= 1, {
		channel: 'C',
		expected: 'delivery-port-ack 条目 data.id=taskId1（message_end 凭据确认 → store.ack）',
		actual: t1Ack.length >= 1 ? `ack=1` : `${ACK_WAIT_MS}ms 内无 ack 条目（终局确认链未走完）`,
	})
	const reapBeforeState3 = countMark(readExtLog(dataDir).text, REAP_MARK)
	try {
		await protocol.call('session.getCommands', { sessionId: sid }, { timeoutMs: 30_000 })
	} catch (e) {
		ev.attach('state3-get-commands-error', String(e?.message ?? e).slice(0, 300))
	}
	await new Promise((r) => setTimeout(r, EDGE_SETTLE_MS))
	const rawState3 = readRaw(sessionFile)
	const { text: extState3 } = readExtLog(dataDir)
	const state3Notify = notifyEntryLines(rawState3).filter((l) => TASK_ID_RE.exec(l)?.[0] === taskId1).length
	const state3Outbox = outboxEntryLines(rawState3, taskId1).length
	const state3Ack = ackEntryLines(rawState3, taskId1).length
	const state3ReapDelta = countMark(extState3, REAP_MARK) - reapBeforeState3
	ev.assert('C: 态③已终局——二次对账后仍零补投（ack 终局命中 → 非候选）', state3Notify === 1 && state3Outbox === 1 && state3Ack === 1 && state3ReapDelta === 0, {
		channel: 'C',
		expected: 'notify=1 outbox=1 ack=1 reapDelta=0（终局事实下补投通道零产出）',
		actual: `notify=${state3Notify} outbox=${state3Outbox} ack=${state3Ack} reapDelta=${state3ReapDelta}`,
	})
	ev.step({ step: 'state3.terminal-reconcile', command: `session.getCommands ${sid}`, exitCode: state3Notify === 1 && state3Outbox === 1 && state3Ack === 1 && state3ReapDelta === 0 ? 0 : 1, stats: { state: 'terminal', notify: state3Notify, outbox: state3Outbox, ack: state3Ack } })

	// 等 T1 通知唤醒 run（轮 3）收尾——T2 发送卫生（发送前会话空闲）
	let end3 = null
	try {
		end3 = await protocol.waitFor((e) => TURN_END_TYPES.has(e.type) && e.receivedAt > end1At, { sessionId: sid, timeoutMs: 60_000 })
	} catch (e) {
		ev.attach('t1-notify-run-end-miss', String(e?.message ?? e).slice(0, 400))
	}
	ev.step({ step: 't1.notify-run-settled', channel: 'B', exitCode: 0, stats: { ended: Boolean(end3), type: end3?.type ?? 'none' } })

	// ── 6. 态④：T2 + chmod 钩子 → rejected → 关钩子对账 → 恰 1 补投 ─
	const t2 = await driveBackgroundTask(ctx, protocol, sid, 'FGBG-A3-T2-START', 'sleep 45', [taskId1])
	const taskId2 = t2.taskId
	let end2 = null
	try {
		end2 = await protocol.waitFor((e) => TURN_END_TYPES.has(e.type) && e.receivedAt > (end3?.receivedAt ?? end1At), { sessionId: sid, timeoutMs: 120_000 })
	} catch (e) {
		ev.attach('t2-turn-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	const end2At = end2?.receivedAt ?? Date.now()
	// waitFor 返回原始事件（无 waitTurnEnd 的加工 ok 字段）——收尾健康判定用
	// stopReason !== 'error'（A1 场景 end2 同款口径）
	const end2Ok = end2?.type === 'message.complete' && end2.payload?.stopReason !== 'error'
	ev.assert('B: turn #2 以 message.complete 收尾（T2 阻塞解除，chmod 时点锚就绪）', end2Ok, {
		channel: 'B',
		expected: 'message.complete（faux 轮 5 收尾）',
		actual: end2 ? `${end2.type} stop=${String(end2.payload?.stopReason)}` : '未等到',
	})
	// 哨兵落盘确认（chmod 时点锚：assistant 收尾文本已写盘，只读窗口内无普通写入竞争）
	await pollSessionFile(sessionFile, (es) => es.some((e) => e?.type === 'message' && JSON.stringify(e.message ?? {}).includes(T2_SENTINEL)), { timeoutMs: 30_000 })

	// 开钩子（chmod 0444——真实 persist 失败驱动，A1/A2 同款）
	const originalMode = fs.statSync(sessionFile).mode & 0o777
	fs.chmodSync(sessionFile, 0o444)
	const hookOn = (fs.statSync(sessionFile).mode & 0o777) === 0o444
	ev.assert('C: appendEntry 强制失败钩子已开（会话文件置只读 0444）', hookOn, {
		channel: 'C',
		expected: 'mode=0o444',
		actual: `mode=${(fs.statSync(sessionFile).mode & 0o777).toString(8)}（原 ${originalMode.toString(8)}）`,
	})
	ev.step({ step: 'hook.append-fail.on', command: `chmod 444 ${path.basename(sessionFile)}`, exitCode: hookOn ? 0 : 1, stats: { originalMode: originalMode.toString(8) } })

	// 等 T2 完成瞬间 rejected（首败 + 单次重提仍败双 warn）
	const logFile = readExtLog(dataDir).logFile
	const rejectEvidence = await pollUntil(() => {
		const { text } = readExtLog(dataDir)
		return text.includes('rejected by delivery port') && text.includes('single retry spent') ? text : null
	}, { timeoutMs: 90_000, intervalMs: 1000 })
	const rejectFirst = rejectEvidence ? FIRST_REJECT_RE.exec(rejectEvidence)?.[0] ?? null : null
	const rejectRetry = rejectEvidence ? RETRY_REJECT_RE.exec(rejectEvidence)?.[0] ?? null : null
	ev.assert('C: 态④——T2 完成瞬间 rejected：首败 warn 含 recovered 指引', Boolean(rejectFirst), {
		channel: 'C',
		expected: '…rejected by delivery port; retrying once…, recovered by reconcile fallback…',
		actual: rejectFirst ? rejectFirst.slice(0, 220) : `${logFile} 内 90s 无首败 warn（任务未完成或钩子未生效）`,
	})
	ev.assert('C: 态④——处置阶梯①当场单次重提仍 rejected（single retry spent）', Boolean(rejectRetry), {
		channel: 'C',
		expected: '…retry rejected after the single re-acquire attempt; single retry spent…',
		actual: rejectRetry ? rejectRetry.slice(0, 220) : '无重提仍败 warn',
	})
	if (rejectFirst) ev.attach('a3-reject-warn-first', rejectFirst)
	if (rejectRetry) ev.attach('a3-reject-warn-retry', rejectRetry)

	// 关钩子（恢复原权限）
	fs.chmodSync(sessionFile, originalMode)
	const hookOff = (fs.statSync(sessionFile).mode & 0o777) === originalMode
	ev.assert('C: appendEntry 强制失败钩子已关（恢复原权限）', hookOff, {
		channel: 'C',
		expected: `mode=${originalMode.toString(8)}`,
		actual: `mode=${(fs.statSync(sessionFile).mode & 0o777).toString(8)}`,
	})
	ev.step({ step: 'hook.append-fail.off', command: `chmod ${originalMode.toString(8)} ${path.basename(sessionFile)}`, exitCode: hookOff ? 0 : 1, stats: {} })

	// 对账边沿（切回同款手段）→ 补投
	const registryBeforeT2 = readRegistry(dataDir, sid)
	ev.attach('registry-before-t2-edge', registryBeforeT2 ? JSON.stringify(registryBeforeT2).slice(0, 1600) : `(不存在：${registryPathOf(dataDir, sid)})`)
	try {
		await protocol.call('session.getCommands', { sessionId: sid }, { timeoutMs: 30_000 })
	} catch (e) {
		ev.attach('state4-get-commands-error', String(e?.message ?? e).slice(0, 300))
	}
	const dispatched = await pollUntil(() => (readExtLog(dataDir).text.includes(DISPATCH_MARK) ? true : null), { timeoutMs: 15_000, intervalMs: 500 })
	ev.step({ step: 'state4.reconcile-edge', command: `session.getCommands ${sid}`, exitCode: 0, stats: { dispatched: Boolean(dispatched), edge: '__taiji_bg_reconcile__' } })

	// 补投恰好 1 条 + outbox 落盘（文件轮询与唤醒等待并发，A1 竞态纪律）
	const notifyPoll4 = pollRawText(sessionFile, (raw) => notifyEntryLines(raw).filter((l) => TASK_ID_RE.exec(l)?.[0] === taskId2).length >= 1, { timeoutMs: 60_000 })
	let end4 = null
	try {
		end4 = await protocol.waitFor((e) => TURN_END_TYPES.has(e.type) && e.receivedAt > end2At, { sessionId: sid, timeoutMs: 90_000 })
	} catch (e) {
		ev.attach('t2-notify-run-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	const rawState4 = await notifyPoll4
	const t2Notify = notifyEntryLines(rawState4).filter((l) => TASK_ID_RE.exec(l)?.[0] === taskId2)
	const t2Outbox = outboxEntryLines(rawState4, taskId2)
	ev.assert('C: 态④rejected 丢失——对账后补投完成通知恰好 1 条（taskId2 一致）', t2Notify.length === 1, {
		channel: 'C',
		expected: 'notify=1（三重全未命中 → 候选成立 → 恰 1 条补投）',
		actual: `notify=${t2Notify.length}${t2Notify[0] ? `：${(NOTIFY_UNKNOWN_RE.exec(t2Notify[0])?.[0] ?? '').slice(0, 160)}` : ''}`,
	})
	ev.assert('C: 态④——投递日志出现 taskId2 的 outbox 条目（补投受理落盘）', t2Outbox.length >= 1, {
		channel: 'C',
		expected: 'delivery-port-outbox 条目 data.id=taskId2',
		actual: `outbox=${t2Outbox.length}`,
	})
	// waitFor 原始事件（无 ok 字段）——stopReason !== 'error' 口径（A1 同款，见上）
	const end4Ok = end4?.type === 'message.complete' && end4.payload?.stopReason !== 'error'
	ev.assert('B: 态④——补投 steer 注入唤醒新 run 并以 message.complete 收尾', end4Ok, {
		channel: 'B',
		expected: 'message.complete（faux 轮 6 应答）',
		actual: end4 ? `${end4.type} stop=${String(end4.payload?.stopReason)}` : '未等到新 run 收尾',
	})

	// 幂等：+8s 静默窗 + 二次对账边沿后通知仍 1 条
	await new Promise((r) => setTimeout(r, 8_000))
	try {
		await protocol.call('session.getCommands', { sessionId: sid }, { timeoutMs: 30_000 })
	} catch {
		/* 二次边沿触发失败不影响计数断言（+8s 窗口已含 agent_settled 边沿） */
	}
	await pollRawText(sessionFile, () => false, { timeoutMs: 4_000, intervalMs: 1000 }) // 静置让二次边沿跑完
	const t2NotifyAfter = notifyEntryLines(readRaw(sessionFile)).filter((l) => TASK_ID_RE.exec(l)?.[0] === taskId2).length
	ev.assert('C: 态④——+8s 静默窗 + 二次对账边沿后通知仍恰好 1 条（幂等）', t2NotifyAfter === 1, {
		channel: 'C',
		expected: 'count=1（送达痕迹判据 + port 幂等吞并双保险）',
		actual: `count=${t2NotifyAfter}`,
	})
	ev.step({ step: 'state4.rejected-redeliver', command: `session.getCommands ${sid}`, exitCode: t2Notify.length === 1 && t2Outbox.length >= 1 && t2NotifyAfter === 1 ? 0 : 1, stats: { state: 'rejected-lost', notify: t2NotifyAfter, outbox: t2Outbox.length } })

	// ── 7. 态②：磁盘 fixture 注入（journaled 命中形态）→ 零补投 ──
	// 静止窗口注入：T2 补投唤醒 run 已收尾、无产品 registry 写点（任务全终态）、
	// 会话无 run 活跃——无并发写（registry 锁内 RMW / 会话 JSONL append 的竞争源）。
	const fixtureId = `bt-${Date.now()}-fxtr02aa`
	// 7a. registry fixture 条目（模板 = T2 真实 exited 条目，保 {version,entries} 形态）
	const regRaw = readRegistry(dataDir, sid)
	const regEntries = Array.isArray(regRaw?.entries) ? regRaw.entries : null
	if (!regEntries) throw new Error('registry 无 entries 数组（形态漂移？）——态② fixture 无法装配')
	const template = regEntries.find((e) => e?.taskId === taskId2) ?? null
	if (!template) throw new Error(`registry 无 T2 终态条目（taskId2=${taskId2}）——态②模板缺失`)
	const fixtureEntry = {
		...JSON.parse(JSON.stringify(template)),
		taskId: fixtureId,
		command: 'echo fixture-accepted-not-delivered',
		outputFile: path.join(cwd, 'fixture-output.log'),
		startedAt: Date.now() - 60_000,
		endedAt: Date.now() - 30_000,
		durationMs: 30_000,
	}
	fs.writeFileSync(registryPathOf(dataDir, sid), `${JSON.stringify({ ...regRaw, entries: [...regEntries, fixtureEntry] }, null, 2)}\n`, 'utf8')
	// 7b. 会话 JSONL outbox fixture 行（persistOutboxRecord 形态；readOutboxDataV2 可解析）
	const fixtureLine = `${JSON.stringify({
		type: 'custom',
		customType: OUTBOX_CUSTOM_TYPE,
		data: {
			v: 2,
			id: fixtureId,
			timing: 'steer',
			payload: {
				kind: 'custom',
				customType: 'background-bash',
				content: `[background-bash] ${fixtureId} fixture journal entry (accepted, not delivered)`,
				display: true,
			},
			recordedAt: Date.now(),
		},
	})}\n`
	fs.appendFileSync(sessionFile, fixtureLine, 'utf8')
	// 7c. 输入事实在位断言（否则「零补投」无证明力——registry 无条目也会零补投）
	const regAfterInject = readRegistry(dataDir, sid)
	const fixtureInRegistry = Array.isArray(regAfterInject?.entries) && regAfterInject.entries.some((e) => e?.taskId === fixtureId)
	const rawFixture = readRaw(sessionFile)
	const fixtureOutboxLines = outboxEntryLines(rawFixture, fixtureId)
	const fixtureNotify = notifyEntryLines(rawFixture).filter((l) => l.includes(fixtureId)).length
	ev.assert('C: 态②已受理在途——fixture 输入事实在位（registry 条目 + outbox 行在、通知 entry 缺席）', fixtureInRegistry && fixtureOutboxLines.length === 1 && fixtureNotify === 0, {
		channel: 'C',
		expected: 'registry 在册 + outbox=1（受理已落盘）+ notify=0（送达缺席）',
		actual: `registry=${fixtureInRegistry ? '在册' : '缺席'} outbox=${fixtureOutboxLines.length} notify=${fixtureNotify}`,
	})
	ev.step({ step: 'state2.fixture-inject', command: `inject ${fixtureId}`, exitCode: fixtureInRegistry && fixtureOutboxLines.length === 1 && fixtureNotify === 0 ? 0 : 1, stats: { fixtureId, registry: fixtureInRegistry, outbox: fixtureOutboxLines.length } })

	// 7d. 对账边沿 → journaled 命中 → 零补投
	const reapBeforeState2 = countMark(readExtLog(dataDir).text, REAP_MARK)
	try {
		await protocol.call('session.getCommands', { sessionId: sid }, { timeoutMs: 30_000 })
	} catch (e) {
		ev.attach('state2-get-commands-error', String(e?.message ?? e).slice(0, 300))
	}
	await new Promise((r) => setTimeout(r, EDGE_SETTLE_MS))
	const rawState2 = readRaw(sessionFile)
	const { text: extState2 } = readExtLog(dataDir)
	const state2Outbox = outboxEntryLines(rawState2, fixtureId).length
	const state2Notify = notifyEntryLines(rawState2).filter((l) => l.includes(fixtureId)).length
	const state2ReapDelta = countMark(extState2, REAP_MARK) - reapBeforeState2
	ev.assert('C: 态②已受理在途——对账后零补投（journaled 命中 → 非候选，补投日志无 deliver 记录）', state2Outbox === 1 && state2Notify === 0 && state2ReapDelta === 0, {
		channel: 'C',
		expected: 'outbox 恒 1（fixture 原行、无补投受理新行）+ notify=0 + reap-notify 痕迹新增=0',
		actual: `outbox=${state2Outbox} notify=${state2Notify} reapDelta=${state2ReapDelta}`,
	})
	ev.step({ step: 'state2.journaled-reconcile', command: `session.getCommands ${sid}`, exitCode: state2Outbox === 1 && state2Notify === 0 && state2ReapDelta === 0 ? 0 : 1, stats: { state: 'journaled-in-flight', outbox: state2Outbox, notify: state2Notify } })

	// 观察项（不判 pass/fail）：四态终盘快照（归因对照面）
	ev.step({
		step: 'observe.four-state-final',
		channel: 'C',
		exitCode: 0,
		stats: {
			taskId1: { notify: state3Notify, outbox: state3Outbox, ack: state3Ack },
			taskId2: { notify: t2NotifyAfter, outbox: t2Outbox.length },
			fixtureId: { outbox: state2Outbox, notify: state2Notify },
		},
	})

	log(`done sid=${sid} t1=${taskId1} t2=${taskId2} fixture=${fixtureId} state1(0/0) state3(0/0) state4(1) state2(0)`)
	return { uncovered, gotchas }
}
