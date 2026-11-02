/**
 * p0-notify-agent-settled-fallback-reconcile —— V9 agent_settled 回合收尾边沿兜底对账
 * （completion-signal-delivery 设计 §4.1 V9 / §4.2 RL10+RL13；验收项 A10，D0 约定名）。
 *
 * 与同族 p0-notify-rejected-reconcile-switchback（V1/A1）同装配批次族：同一
 * rejected(persist-failed) 形态、同一 chmod 0444 钩子驱动、同一 sleep 45 转后台
 * 长任务——唯一差异是恢复边沿：V1 关钩子后切走会话再切回（__taiji_bg_reconcile__
 * 命令，reason="resume"），本场景（V9）关钩子后不重启不切回，让父回合继续一步
 * 小工作产生回合收尾（agent_settled 边沿，reason="agent_settled"）。同进程不重启
 * 不切回时 session_start 与 __taiji_bg_reconcile__ 两入口均不可达，回合收尾是
 * 仅剩的确定性事件边沿（base-tool-enhance index.ts agent_settled 订阅注释原文；
 * 订阅接线 delivery-port pi-host.ts onAgentSettled → pi.on("agent_settled")）。
 *
 * 路径（设计 V9 三步断言面）：
 *   ① 开「appendEntry 强制失败」钩子（会话 JSONL chmod 0444——真实 persist 失败
 *   驱动，非注入假失败：pi appendFileSync EACCES 同步抛错 → delivery-port
 *   persistOutboxRecord catch → deliver 返回 rejected(persist-failed)），发转后台
 *   命令（sleep 45 && echo done）等待自然完成——完成瞬间 rejected(persist-failed)，
 *   生产方当场单次重提仍失败（钩子使转换窗形态持续；notify.ts:196 首败 warn +
 *   notify.ts:230 single retry spent warn）。
 *   ② 关钩子（恢复原权限）；不重启不切回，发一条消息让父回合继续一步小工作——
 *   该回合收尾触发 pi.on("agent_settled") → runReconcileMaintenance(reason=
 *   "agent_settled") → reconcilePendingEntries 判据命中（registry 终态 ∧ 会话
 *   entries 无送达痕迹 ∧ 投递日志无该幂等键条目，三重事实读 session JSONL 磁盘
 *   条目——pending-reconcile.ts「判据事实源磁盘化」段）→ port.deliver 补投。
 *   ③ 观察补投到达时序与日志中边沿来源。
 *
 * 通过标准（设计 V9 四条）：回合收尾后（秒级）补投到达恰好 1 条；全程未发生
 * session_start 与切回（日志核对补投由 agent_settled 挂点触发——关钩子后窗口内
 * 存在 reason="agent_settled" 的 dispatch 行、零条 reason∈{startup,reload,new,
 * resume,fork} 的 dispatch 行，区别于 V1 的切回路径）；投递日志出现该 taskId 的
 * delivery-port-outbox 条目；无第二条同 id 通知（跨边沿幂等：+8s 静默窗 + 二次
 * agent_settled 边沿后计数仍 1——幂等双保险 = port 幂等吞并 + 送达痕迹判据阻断，
 * pending-reconcile.ts「幂等体系」段）。
 *
 * 计数口径：通知按注入 entry 行统计（customType≠delivery-port-outbox 且头行形态
 * 匹配）——unified-delivery 主路径每条通知结构性落两行（outbox 日志行 + 注入
 * custom entry），日志行不计数（同族 V1/A1 先例）。
 *
 * 装配：faux + idleBackgroundSec=30 + TAIJI_AGENT_EXT_LOG=1（托管观测档：debug
 * 降档 info 落盘 <agentDir>/logs/base-tool-enhance-<YYYY-MM-DD>.log——dispatch 行
 * 与 rejected 双 warn 是边沿来源与形态判定的唯一落盘留痕）。
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

/** 空闲转后台阈值（秒，与 V1 同装配）。 */
const IDLE_SEC = 30
/** 长任务命令（与 V1 同款）：阈值 30s < 45s，转后台后自然完成。 */
const LONG_COMMAND = 'sleep 45 && echo done'
/** turn #1 收尾哨兵（faux 轮 2 文本——chmod 时点锚：哨兵落盘后 assistant 写入已完毕）。 */
const TURN1_SENTINEL = 'ASFB-A10-TURN1-END'
/** turn #2 收尾哨兵（faux 轮 3 文本——agent_settled 边沿时点锚：小工作回合收尾）。 */
const TURN2_SENTINEL = 'ASFB-A10-TURN2-END'
/** turn #3 收尾哨兵（faux 轮 4 文本——补投唤醒 run 收尾）。 */
const TURN3_SENTINEL = 'ASFB-A10-TURN3-END'
/** 完成通知「结果未知」形态头行（单行匹配用，同族 V1 同款）。 */
const NOTIFY_UNKNOWN_RE = /\[background-bash\][^\n]*finished \(exit code unknown[^\n]*\)/
/** 投递日志 outbox 条目的 customType（delivery-port journal OUTBOX_CUSTOM_TYPE）。 */
const OUTBOX_CUSTOM_TYPE = 'delivery-port-outbox'
/** 扩展名（extension-logger fileLog 文件名前缀）。 */
const EXT_NAME = 'base-tool-enhance'
/** turn 收尾事件类型（与 protocol.mjs waitTurnEnd 内部集合一致）。 */
const TURN_END_TYPES = new Set(['message.complete', 'message.error', 'message.stream_error', 'session.exited'])
/** 补投 notifyId 形态（registry taskId，幂等键）。 */
const TASK_ID_RE = /bt-[A-Za-z0-9_-]+/
/** 维护链入口 dispatch 行的固定片段（S6 观测通道，logger.debug 落盘）。 */
const DISPATCH_MARK = 'reconcile maintenance dispatch'
/**
 * session_start 系 dispatch 的 reason 值域（startup/reload/new/resume/fork——
 * base-tool-enhance index.ts「任意 session 启动触发」注释）。V9 断言关钩子后
 * 窗口内该值域零命中 = 全程未发生 session_start 边沿；"resume" 单值另覆盖切回
 * 命令边沿（__taiji_bg_reconcile__ reason 恒 "resume"）。
 */
const NON_SETTLED_REASONS = new Set(['startup', 'reload', 'new', 'resume', 'fork'])

export const meta = {
	id: 'p0-notify-agent-settled-fallback-reconcile',
	priority: 'P0',
	title: 'V9：agent_settled 回合收尾边沿兜底对账——不重启不切回秒级补投、outbox 落盘、跨边沿幂等',
	covers: ['session.create', 'chat.send', 'chat.wait', 'chat.stream'],
	requires: ['faux'],
	estimateSec: 420,
	faux: {
		responses: [
			// 轮 1：长任务命令（30s 静默转后台，45s 自然完成）
			{ toolCalls: [{ name: 'bash', args: { command: LONG_COMMAND } }], stopReason: 'toolUse' },
			// 轮 2：转后台标记返回后模型收尾（turn #1 结束）
			{ text: TURN1_SENTINEL, stopReason: 'stop' },
			// 轮 3：关钩子后父回合小工作应答（turn #2 收尾 → agent_settled 兜底边沿）
			{ text: TURN2_SENTINEL, stopReason: 'stop' },
			// 轮 4：补投通知 steer 唤醒的新 run 应答（缺这步该轮以 faux 耗尽 error 收尾）
			{ text: TURN3_SENTINEL, stopReason: 'stop' },
			// 轮 5：二次 agent_settled 幂等边沿的小工作应答
			{ text: 'ASFB-A10-TURN4-END', stopReason: 'stop' },
		],
	},
	env: {
		// 托管观测档：debug 降档 info 全量落盘（rejected 双 warn 与 dispatch reason
		// 是边沿来源判定的唯一落盘留痕，extension-logger fileLog extLogMode 分支）。
		TAIJI_AGENT_EXT_LOG: '1',
	},
	provable: [
		'C：转后台标记行到达且可提取 taskId（bt-…，30s 静默转后台）',
		'C：turn #1 以 message.complete 收尾（阻塞解除，chmod 时点锚就绪）',
		'C：完成瞬间 rejected(persist-failed)：首败 warn + 重提仍败 warn 均含 recovered 指引（扩展日志文件）',
		'C：只读窗口内会话文件无通知 entry、无 delivery-port-outbox 条目（outbox 未落的结构性证据）',
		'C：关钩子后父回合小工作 run 以 message.complete 收尾（turn #2——agent_settled 边沿的产生动作）',
		'C：关钩子后窗口内存在 reason="agent_settled" 的维护链 dispatch 行（补投由回合收尾挂点触发）',
		'C：关钩子后窗口内零条 reason∈{startup,reload,new,resume,fork} 的 dispatch 行（全程未发生 session_start 与切回）',
		'C：回合收尾后补投完成通知到达恰好 1 条（taskId 与原任务一致、结果未知形态）',
		'C：投递日志出现该 taskId 的 delivery-port-outbox 条目（补投受理落盘）',
		'B：补投 steer 唤醒新 run 并以 message.complete#3 收尾',
		'C：+8s 静默窗 + 二次 agent_settled 边沿后通知计数仍恰好 1（跨边沿幂等）',
	],
	notProvable: [
		'补投到达的精确时延上界（设计 V9「秒级」无量值承诺——同族 V1/A1 同款处置：观察窗内到达 + 到达时距登记证据，不设可证伪上界）',
		'GUI pane 渲染细节（视觉档位核对归 V6 真机视觉节点；本剧本不驱动 UI 通道——切回 UI 动作会引入 resume 边沿污染「无切回」断言）',
	],
}

/** 读会话 JSONL 原文（只读窗口内 pi 持写句柄不影响本进程读）。 */
function readRaw(sessionFile) {
	try {
		return sessionFile ? fs.readFileSync(sessionFile, 'utf8') : ''
	} catch {
		return ''
	}
}

/** 原文条件轮询。 */
async function pollRawText(sessionFile, predicate, { timeoutMs, intervalMs = 500 } = {}) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const raw = readRaw(sessionFile)
		if (predicate(raw)) return raw
		if (Date.now() >= deadline) return raw
		await new Promise((r) => setTimeout(r, intervalMs))
	}
}

/** 注入通知 entry 行清单：排除 delivery-port-outbox 投递日志行，按头行形态匹配。 */
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

/** delivery-port-outbox 投递日志条目行（JSON.parse 成功且 data.id 命中）。 */
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

/** 扩展日志文件路径（extension-logger fileLog：<agentDir>/logs/<ext>-<YYYY-MM-DD>.log）。 */
function extLogFileOf(dataDir) {
	const today = new Date().toISOString().slice(0, 10)
	return path.join(dataDir, 'agent', 'logs', `${EXT_NAME}-${today}.log`)
}

/** 读扩展日志全文（文件不存在 / 只读窗口等读失败按空文）。 */
function readExtLog(logFile) {
	try {
		return fs.readFileSync(logFile, 'utf8')
	} catch {
		return ''
	}
}

/**
 * 解析 dispatch 行：`<ISO> [info] reconcile maintenance dispatch {"detail":{"reason":"…"}}`。
 * 返回 { at:number, reason:string } 列表（EXT_LOG 档 debug 降档 info，level 不参与判定）。
 */
function dispatchLines(logText) {
	const out = []
	for (const line of logText.split('\n')) {
		if (!line.includes(DISPATCH_MARK)) continue
		const ts = /^(\S+Z)\s/.exec(line)?.[1]
		const reason = /"reason":"([A-Za-z_]+)"/.exec(line)?.[1] ?? '(缺失)'
		const at = ts ? Date.parse(ts) : NaN
		out.push({ at: Number.isNaN(at) ? 0 : at, reason, line })
	}
	return out
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'「appendEntry 强制失败」测试钩子的真机物理实现 = 会话 JSONL chmod 0444（真实 persist 失败，非注入假失败）：产品侧钩子按 impl-plan u4 落单测域（__tests__/ territory）真机不可用；chmod 时点锚 = turn#1 收尾哨兵落盘后（assistant 写入已完毕）、任务 45s 完成前——窗口内 pi 侧唯一强制写入是完成通知的 outbox persist（正是被测对象）；warn 的 appendEntry 通道同窗失败由 extension-logger 降级 fileLog（TAIJI_AGENT_EXT_LOG=1 已注入），不干扰主链（同族 V1/A1 同款）',
		'边沿唯一性由驱动结构性保证：本剧本全程只经 chat.send 驱动回合与文件系统开关钩子，禁调 session.getCommands（切回后 renderer 必经查询，runtime 在此经 prompt("/__taiji_bg_reconcile__") 注入 reason="resume" dispatch——调了即污染「无切回」断言）；二次幂等边沿因此不用 V1 的 getCommands 形态，改用第二次回合收尾（agent_settled 同源边沿）',
		'通知计数按注入 entry 行统计、排除 delivery-port-outbox 日志行（同族 V1/A1 先例：每条通知结构性落两行，按原文头行计数会双计）',
		'补投与唤醒等待并发执行（waitFor 全历史扫描 + 事件时间戳晚于 turn#2 收尾过滤）：通知检出（500ms 文件轮询）可能晚于注入唤醒（faux 轮实测 ≈数百 ms），检出后才取游标会让 waitFor 漏掉已落事件的 complete#3（同族 V1 首跑实测竞态先例）',
		'跨边沿幂等双保险（pending-reconcile.ts「幂等体系」段）：第二路 deliver 同 id 被 port 幂等吞并（swallowed）+ 已送达任务由送达痕迹判据阻断（details.taskId / content bt- token 在 entries）——本剧本断言的是外部可观测结果（计数恒 1），不穿透内核计数器',
	]

	// ── 1. 注入空闲阈值配置 ─────────────────────────────────────────
	const cfgPath = writeIdleConfig(dataDir, { idleBackgroundSec: IDLE_SEC })
	ev.step({ step: 'config.idle-inject', command: `write ${cfgPath}`, exitCode: 0, stats: { idleBackgroundSec: IDLE_SEC } })

	// ── 2. 建会话（临时 cwd，不污染 repo） ─────────────────────────
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-asfb-a10-'))
	const created = await protocol.call('session.create', { cwd, label: 'p0-asfb-a10' }, { timeoutMs: 120_000 })
	const sid = created.session?.id
	ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
		channel: 'B',
		expected: 'session.id 非空',
		actual: JSON.stringify(created.session ?? {}).slice(0, 200),
	})
	if (!sid) throw new Error('session.create 未返回 sessionId')
	await protocol.subscribe(sid)
	log(`session=${sid} cwd=${cwd}`)

	// ── 3. 驱动：长任务转后台 ──────────────────────────────────────
	const since = protocol.events.length
	await protocol.send(sid, 'ASFB-A10-START 长任务转后台后回合收尾验证补投')

	const longStart = await waitForBashCallStart(protocol, sid, { commandIncludes: 'sleep 45', timeoutMs: 90_000, since })
	ev.assert('B: 长任务 bash 调用发起（tool_call_start）', Boolean(longStart), {
		channel: 'B',
		expected: 'sleep 45 && echo done tool_call_start',
		actual: longStart ? `at=${new Date(longStart.receivedAt).toISOString()}` : '90s 内未观察到',
	})

	// 段①前置：转后台标记行 + taskId 提取（30s 静默触发；判定锚结构化 toolResult）
	const sessionFile = created.session?.sessionFile ?? (await pollUntil(() => findSessionFile(dataDir, sid), { timeoutMs: 15_000 }))
	ev.step({ step: 'evidence.session-file', command: `locate ${sid}`, exitCode: sessionFile ? 0 : 1, stats: { sessionFile: sessionFile ?? '未找到' } })
	if (!sessionFile) throw new Error('未定位到会话 JSONL（chmod 钩子无法装配）')
	const { entries: convertedEntries } = await pollSessionFile(
		sessionFile,
		(es) => toolResultsFor(es, 'bash').some((r) => r.text.includes('[TAIJI-FG-BG]')),
		{ timeoutMs: (IDLE_SEC + 30) * 1000 },
	)
	const longResult = toolResultsFor(convertedEntries, 'bash').find((r) => r.text.includes('[TAIJI-FG-BG]')) ?? null
	const taskId = extractTaskId(longResult?.text ?? '')
	ev.assert('C: 转后台标记行到达且提取 taskId（30s 静默触发）', Boolean(longResult && taskId), {
		channel: 'C',
		expected: '结果文本含 [TAIJI-FG-BG] 与 bt-… taskId',
		actual: longResult ? `taskId=${taskId ?? '未提取到'}` : `${IDLE_SEC + 30}s 内无标记行`,
	})
	if (longResult) ev.attach('long-task-result', longResult.text)
	if (!taskId) throw new Error('转后台标记行无 bt- taskId——补投断言无法锚定幂等键')

	// turn #1 收尾（阻塞解除 + chmod 时点锚）
	let end1 = null
	try {
		end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
	} catch (e) {
		ev.attach('turn1-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	const end1At = end1?.at ?? 0
	ev.assert('B: turn #1 以 message.complete 收尾（阻塞解除）', end1?.type === 'message.complete' && end1.ok, {
		channel: 'B',
		expected: 'message.complete（faux 轮 2 收尾）',
		actual: end1 ? `${end1.type} stop=${String(end1.payload?.stopReason)}` : '未等到',
	})
	// 哨兵落盘确认（chmod 时点锚：assistant 收尾文本已写盘，只读窗口内无普通写入竞争）
	await pollSessionFile(sessionFile, (es) => es.some((e) => e?.type === 'message' && JSON.stringify(e.message ?? {}).includes(TURN1_SENTINEL)), {
		timeoutMs: 30_000,
	})

	// ── 4. 段①：开钩子（chmod 0444——真实 persist 失败驱动） ────────
	const originalMode = fs.statSync(sessionFile).mode & 0o777
	fs.chmodSync(sessionFile, 0o444)
	const hookOn = (fs.statSync(sessionFile).mode & 0o777) === 0o444
	ev.assert('C: appendEntry 强制失败钩子已开（会话文件置只读 0444）', hookOn, {
		channel: 'C',
		expected: 'mode=0o444',
		actual: `mode=${(fs.statSync(sessionFile).mode & 0o777).toString(8)}（原 ${originalMode.toString(8)}）`,
	})
	ev.step({ step: 'hook.append-fail.on', command: `chmod 444 ${path.basename(sessionFile)}`, exitCode: hookOn ? 0 : 1, stats: { originalMode: originalMode.toString(8) } })

	// ── 5. 段②前半：等任务自然完成 → rejected(persist-failed) 证据 ──
	// 任务 45s 完成 + 守望 2s 轮询 + deliver 同步收尾；60s 预算从当前时刻起算。
	const logFile = extLogFileOf(dataDir)
	const rejectEvidence = await pollUntil(() => {
		const text = readExtLog(logFile)
		return text.includes('rejected by delivery port') && text.includes('recovered by reconcile fallback') ? text : null
	}, { timeoutMs: 60_000, intervalMs: 1000 })
	const rejectFirst = rejectEvidence ? /background task notify rejected by delivery port[^\n]*/.exec(rejectEvidence)?.[0] ?? null : null
	const rejectRetry = rejectEvidence ? /background task notify retry rejected[^\n]*/.exec(rejectEvidence)?.[0] ?? null : null
	ev.assert(
		'C: 完成瞬间 rejected(persist-failed)：首败 warn 含 recovered 指引（生产方 notify.ts rejected 分支）',
		Boolean(rejectFirst),
		{
			channel: 'C',
			expected: '…rejected by delivery port; retrying once…, recovered by reconcile fallback…',
			actual: rejectFirst ? rejectFirst.slice(0, 220) : `${logFile} 内 60s 无 rejected warn（任务未完成或钩子未生效）`,
		},
	)
	ev.assert('C: 处置阶梯①当场单次重提仍 rejected（single retry spent warn）', Boolean(rejectRetry), {
		channel: 'C',
		expected: '…retry rejected after the single re-acquire attempt; single retry spent, recovered by reconcile fallback…',
		actual: rejectRetry ? rejectRetry.slice(0, 220) : '无重提仍败 warn',
	})
	if (rejectFirst) ev.attach('reject-warn-first', rejectFirst)
	if (rejectRetry) ev.attach('reject-warn-retry', rejectRetry)

	// 结构性负向证据：只读窗口内 outbox 未落、通知未注入（rejected = 幂等键未登记）
	const rawInWindow = readRaw(sessionFile)
	const notifyInWindow = notifyEntryLines(rawInWindow)
	const outboxInWindow = outboxEntryLines(rawInWindow, taskId)
	ev.assert('C: 只读窗口内无通知注入、无投递日志条目（rejected 结构性证据）', notifyInWindow.length === 0 && outboxInWindow.length === 0, {
		channel: 'C',
		expected: 'count=0 / outbox=0（outbox 未落 = 幂等键未登记，重放无从覆盖）',
		actual: `notify=${notifyInWindow.length} outbox=${outboxInWindow.length}`,
	})

	// ── 6. 段②后半：关钩子 + 不重启不切回驱动回合收尾 ──────────────
	fs.chmodSync(sessionFile, originalMode)
	const hookOff = (fs.statSync(sessionFile).mode & 0o777) === originalMode
	ev.assert('C: appendEntry 强制失败钩子已关（恢复原权限）', hookOff, {
		channel: 'C',
		expected: `mode=${originalMode.toString(8)}`,
		actual: `mode=${(fs.statSync(sessionFile).mode & 0o777).toString(8)}`,
	})
	ev.step({ step: 'hook.append-fail.off', command: `chmod ${originalMode.toString(8)} ${path.basename(sessionFile)}`, exitCode: hookOff ? 0 : 1, stats: {} })
	// 边沿来源判定窗口锚：关钩子时刻。此窗口内本剧本不引入任何切回/重启动作，
	// 窗口内出现的 dispatch 只能来自产品侧事件边沿。
	const hookOffAt = Date.now()

	// 边沿前取证：registry 快照（对账判据第一重事实的独立自检——终态形态）。
	const registryBefore = readRegistry(dataDir, sid)
	ev.attach('registry-before-edge', registryBefore ? JSON.stringify(registryBefore, null, 2) : `(不存在：${registryPathOf(dataDir, sid)})`)

	// 父回合继续一步小工作（turn #2）——回合收尾即 agent_settled 兜底边沿。
	const since2 = protocol.events.length
	await protocol.send(sid, 'ASFB-A10-TURN2 钩子已关，做一步小工作后收尾')
	let end2 = null
	try {
		end2 = await protocol.waitTurnEnd(sid, { since: since2, timeoutMs: 90_000 })
	} catch (e) {
		ev.attach('turn2-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	const end2At = end2?.at ?? 0
	const end2Ok = end2?.type === 'message.complete' && end2.ok
	ev.assert('B: 父回合小工作 run 以 message.complete 收尾（turn #2——agent_settled 边沿的产生动作）', end2Ok, {
		channel: 'B',
		expected: `message.complete（faux 轮 3 收尾，含哨兵 ${TURN2_SENTINEL}）`,
		actual: end2 ? `${end2.type} stop=${String(end2.payload?.stopReason)}` : '未等到',
	})

	// ── 7. 段③：边沿来源日志核对（agent_settled 挂点触发，无 session_start/切回） ──
	// 等 reason="agent_settled" 的 dispatch 行出现在关钩子后的日志窗口内（维护链
	// dispatch 在回合收尾 handler 同步打出，先于对账/补投动作）。
	const settledDispatch = await pollUntil(() => {
		return dispatchLines(readExtLog(logFile)).find((d) => d.reason === 'agent_settled' && d.at >= hookOffAt) ?? null
	}, { timeoutMs: 30_000, intervalMs: 500 })
	ev.assert(
		'C: 关钩子后窗口内存在 reason="agent_settled" 维护链 dispatch（补投由回合收尾挂点触发）',
		Boolean(settledDispatch),
		{
			channel: 'C',
			expected: `${DISPATCH_MARK} {"detail":{"reason":"agent_settled"}}（at ≥ 关钩子时刻）`,
			actual: settledDispatch ? settledDispatch.line.slice(0, 220) : `关钩子后 30s 内 ${logFile} 无 agent_settled dispatch`,
		},
	)
	if (settledDispatch) ev.attach('settled-dispatch-line', settledDispatch.line)

	// 「全程未发生 session_start 与切回」：关钩子后窗口内 session_start 系（startup/
	// reload/new/resume/fork——含切回命令的 reason="resume"）dispatch 零命中。
	// 静置片刻让边沿后的同步链（dispatch → 对账 → 补投）落完日志再核对。
	await pollRawText(sessionFile, () => false, { timeoutMs: 3_000, intervalMs: 1000 })
	const foreignDispatches = dispatchLines(readExtLog(logFile)).filter((d) => d.at >= hookOffAt && NON_SETTLED_REASONS.has(d.reason))
	ev.assert(
		'C: 关钩子后窗口内零条 session_start 系/切回系 dispatch（全程未发生 session_start 与切回）',
		foreignDispatches.length === 0,
		{
			channel: 'C',
			expected: 'reason∈{startup,reload,new,resume,fork} 命中 0 条（含 __taiji_bg_reconcile__ 的 reason="resume"）',
			actual: foreignDispatches.length === 0 ? '0 条' : foreignDispatches.map((d) => d.line.slice(0, 160)).join(' || ').slice(0, 400),
		},
	)

	// ── 8. 段③：补投恰好 1 条 + 唤醒 + outbox 落盘 ─────────────────
	// 补投文件轮询与唤醒等待并发（同族 V1/A1 竞态纪律——全历史扫描 + 时间戳过滤）。
	const notifyPoll = pollRawText(sessionFile, (raw) => notifyEntryLines(raw).length >= 1, { timeoutMs: 60_000, intervalMs: 500 })
	let end3 = null
	try {
		end3 = await protocol.waitFor((e) => TURN_END_TYPES.has(e.type) && e.receivedAt > end2At, { sessionId: sid, timeoutMs: 90_000 })
	} catch (e) {
		ev.attach('turn3-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	const notifiedAt = Date.now()
	const rawNotified = await notifyPoll
	const notifyLines = notifyEntryLines(rawNotified)
	const firstNotifyLine = notifyLines[0] ?? null
	const firstHead = firstNotifyLine ? (NOTIFY_UNKNOWN_RE.exec(firstNotifyLine)?.[0] ?? null) : null

	// 判据磁盘事实自检（补投未达时的归因面：产品判据三重事实 vs 剧本独立读取）。
	if (notifyLines.length === 0) {
		const entries = readSessionEntries(sessionFile)
		const registryAfter = readRegistry(dataDir, sid)
		ev.attach('reconcile-facts-selfcheck', JSON.stringify({
			registryEntry: registryAfter ? (JSON.stringify(registryAfter).includes(taskId) ? 'taskId 在册' : 'taskId 不在册') : 'registry 不存在',
			registryRaw: registryAfter ? JSON.stringify(registryAfter).slice(0, 1200) : null,
			sessionEntriesWithTaskId: entries.filter((e) => JSON.stringify(e ?? {}).includes(taskId)).length,
			extLogTail: readExtLog(logFile).slice(-6000),
		}, null, 2))
	}
	ev.assert('C: 回合收尾后补投完成通知到达（结果未知形态）', notifyLines.length >= 1, {
		channel: 'C',
		expected: '[background-bash] bt-… finished (exit code unknown, …)（注入 entry 行）',
		actual: firstHead ? firstHead.slice(0, 200) : '60s 内无补投通知（agent_settled 边沿未触发对账或判据未命中）',
	})

	// taskId 一致（幂等键同源）+ 到达时距证据（「秒级」不设可证伪上界，登记时距供复盘）。
	if (firstNotifyLine) {
		const notifyTaskId = TASK_ID_RE.exec(firstNotifyLine)?.[0] ?? null
		ev.assert('C: 补投通知 taskId 与原任务一致（幂等键同源）', notifyTaskId === taskId, {
			channel: 'C',
			expected: taskId,
			actual: notifyTaskId ?? '通知行无 bt- id',
		})
		ev.attach('notify-latency', JSON.stringify({
			turn2CompletedAt: end2At ? new Date(end2At).toISOString() : null,
			notifyObservedAt: new Date(notifiedAt).toISOString(),
			observedGapMs: end2At ? notifiedAt - end2At : null,
			note: '观察口径 = 500ms 文件轮询检出，含轮询粒度误差；设计 V9「秒级」无量值承诺',
		}))
		ev.attach('notification-head', firstHead ?? firstNotifyLine.slice(0, 400))
	}

	// 投递日志：补投受理落盘（delivery-port-outbox 条目，data.id = taskId）。
	const outboxLines = outboxEntryLines(rawNotified, taskId)
	ev.assert('C: 投递日志出现该 taskId 的 outbox 条目（补投受理落盘）', outboxLines.length >= 1, {
		channel: 'C',
		expected: `delivery-port-outbox 条目 data.id=${taskId}`,
		actual: `outbox 条目数=${outboxLines.length}`,
	})

	// 唤醒断言（补投 steer 注入唤醒新 run——turn #3）。
	const end3Ok = end3?.type === 'message.complete' && end3.payload?.stopReason !== 'error'
	ev.assert('B: 补投唤醒新 run 并以 message.complete#3 收尾（steer 自动唤醒）', end3Ok, {
		channel: 'B',
		expected: 'turn #3 message.complete（faux 轮 4 应答）',
		actual: end3
			? `${end3.type} stop=${String(end3.payload?.stopReason)}`
			: notifyLines.length >= 1
				? '有补投注入但未等到新 run 收尾——排查产品唤醒链路'
				: '未等到新 run（无补投即无唤醒）',
	})
	ev.step({ step: 'chat.wait.turn3-notify', channel: 'B', exitCode: end3Ok ? 0 : 1, stats: { stopReason: end3?.payload?.stopReason } })

	// ── 9. 幂等：+8s 静默窗 + 二次 agent_settled 边沿后计数仍 1 ─────
	// 二次边沿用第二次回合收尾（同源 agent_settled），不用 V1 的 getCommands——
	// 那是切回边沿，会注入 reason="resume" dispatch 污染「无切回」断言（gotchas）。
	await new Promise((r) => setTimeout(r, 8_000))
	const since4 = protocol.events.length
	await protocol.send(sid, 'ASFB-A10-TURN4 二次幂等边沿小工作')
	try {
		await protocol.waitTurnEnd(sid, { since: since4, timeoutMs: 60_000 })
	} catch (e) {
		ev.attach('turn4-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	await pollRawText(sessionFile, () => false, { timeoutMs: 4_000, intervalMs: 1000 }) // 静置 4s 让二次边沿对账跑完
	const notifyLinesAfter = notifyEntryLines(readRaw(sessionFile))
	ev.assert('C: 通知恰好 1 条（跨边沿幂等：+8s 静默窗 + 二次 agent_settled 边沿后无第二条）', notifyLinesAfter.length === 1, {
		channel: 'C',
		expected: 'count=1（注入 entry 行口径；跨边沿由送达痕迹判据 + port 幂等吞并双保险）',
		actual: `count=${notifyLinesAfter.length}${notifyLinesAfter.length > 1 ? ` 多余条目：${(NOTIFY_UNKNOWN_RE.exec(notifyLinesAfter[1])?.[0] ?? notifyLinesAfter[1]).slice(0, 200)}` : ''}`,
	})

	const coreOk =
		notifyLinesAfter.length === 1 &&
		outboxLines.length >= 1 &&
		Boolean(rejectFirst) &&
		Boolean(rejectRetry) &&
		notifyInWindow.length === 0 &&
		Boolean(settledDispatch) &&
		foreignDispatches.length === 0
	if (!coreOk) {
		uncovered.push('V9 完整链路（rejected→回合收尾兜底对账→补投恰好 1 条→outbox 落盘→无 session_start/切回→幂等）未全绿——补投链回归或驱动窗口时序漂移，按失败处置纪律先归因（扩展日志 + runDir 证据）再重试')
	}
	log(`done sid=${sid} taskId=${taskId} notifyCount=${notifyLinesAfter.length} outbox=${outboxLines.length}`)
	return { uncovered, gotchas }
}
