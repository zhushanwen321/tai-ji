/**
 * p0-notify-disposed-immediate-resubmit —— V2 rejected 处置阶梯①：当场单次重提路径
 * 触发 + RL10 单次不循环（completion-signal-delivery 设计 §4.1 V2 / §4.2 RL10 真机面；
 * 验收项 A2，D0 约定名，2026-11-02 前置组装义务履行入库）。
 *
 * 装配：faux + idleBackgroundSec=30 + TAIJI_AGENT_EXT_LOG=1（rejected 瞬间会话文件被
 * 本剧本置只读，warn 的 appendEntry 通道同步失败，降级文件日志是首败/重提 warn 的
 * 唯一落盘留痕——extension-logger index.ts warn 分支，V1 场景同款）。
 *
 * 断言面（A2.md ①②③与设计 V2 通过标准的真机映射）：
 *   ① 构造 rejected：「appendEntry 强制失败」钩子 = 会话 JSONL chmod 0444（真实
 *     persist 失败驱动）——首败 rejected(persist-failed)。设计原文的另一形态「手动
 *     dispose 端口后经旧引用提交」真机不可构造（结构性，见 notProvable 首条证据链），
 *     处置阶梯在 notify.ts:193 不区分 rejected 成因（reason 只进 warn detail），
 *     persist-failed 是该阶梯的真机等价驱动（V1 场景先例）。
 *   ② 断言 rejected 后立即重提路径触发：首败 warn 含「retrying once via re-acquired
 *     port」（notify.ts:196）+ 重提仍败 warn「single retry spent」（notify.ts:230，
 *     = retryDeliverOnce 确实执行了第二次 deliver）+ 两 warn 时间近邻 ≤5s（同步链
 *     「立即」性——非定时器延迟）。
 *   ③ deliver 调用计数恰 2（RL10 真机口径）：rejected 系 warn 恰各 1 条（首败串 1 +
 *     single retry spent 串 1）+ retry skipped 串 0（无转换窗形态）+ 只读窗口内
 *     通知 entry=0 / 投递日志 outbox=0（rejected = 幂等键未登记的结构性证据）；
 *     关钩子后 +15s 静默窗（覆盖 agent_settled 对账边沿）+ 二次对账边沿（session.
 *     getCommands）后 rejected 系 warn 计数恒定——无第三次投递、无定时器循环、无
 *     后台重试任务残留（RL10 行为面）。
 *
 * 分工边界：恢复送达面（对账补投恰好 1 条 + outbox 落盘 + 幂等）归 V1 场景
 * （p0-notify-rejected-reconcile-switchback，验收项 A1）断言，本场景不重复——
 * A1 已登记的产品缺陷（ghost entry 链）修复与否不改变本场景断言结果（补投
 * accepted 无 rejected warn，两种世界下本场景断言同值）。
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
	readSessionEntries,
} from './lib/fg-bg-lib.mjs'

/** 空闲转后台阈值（秒，与 V1 同款前置）。 */
const IDLE_SEC = 30
/** 长任务命令：阈值 30s < 45s，转后台后自然完成（完成瞬间撞只读窗口）。 */
const LONG_COMMAND = 'sleep 45 && echo done'
/** turn #1 收尾哨兵（faux 轮 2 文本——chmod 时点锚：哨兵落盘后 assistant 写入已完毕）。 */
const TURN1_SENTINEL = 'FGBG-A2-TURN1-END'
/** 完成通知「结果未知」形态头行（单行匹配用，V1 同款）。 */
const NOTIFY_UNKNOWN_RE = /\[background-bash\][^\n]*finished \(exit code unknown[^\n]*\)/
/** 投递日志 outbox 条目的 customType（delivery-port journal.ts OUTBOX_CUSTOM_TYPE）。 */
const OUTBOX_CUSTOM_TYPE = 'delivery-port-outbox'
/** 扩展名（extension-logger fileLog 文件名前缀）。 */
const EXT_NAME = 'base-tool-enhance'
/** 首败 warn 消息串（notify.ts:196——deliver#1 的 rejected 留痕，每条恰出现 1 次）。 */
const FIRST_REJECT_MARK = 'rejected by delivery port'
/** 重提仍败 warn 消息串（notify.ts:230——deliver#2 的 rejected 留痕）。 */
const RETRY_REJECT_MARK = 'single retry spent'
/** 重取缺席 warn 消息串（notify.ts:219——转换窗形态，本场景不应出现）。 */
const RETRY_SKIP_MARK = 'delivery port absent on re-acquire'
/** 「立即重提」时间近邻预算（毫秒）：同步链实测同秒级，5s 已含文件落盘抖动。 */
const IMMEDIATE_BUDGET_MS = 5_000
/** RL10 静默窗（毫秒）：覆盖 rejected 后首个 agent_settled 对账边沿。 */
const QUIET_WINDOW_MS = 15_000
/** fileLog 行首时间戳宽度（ISO 8601 UTC，extension-logger index.ts toISOString）。 */
const ISO_TS_LEN = new Date().toISOString().length

export const meta = {
	id: 'p0-notify-disposed-immediate-resubmit',
	priority: 'P0',
	title: 'V2：rejected 后当场单次重提路径触发——warn 恰各 1、deliver 恰 2、静默窗不循环（RL10）',
	covers: ['session.create', 'chat.send', 'chat.wait', 'chat.stream'],
	requires: ['faux'],
	estimateSec: 300,
	faux: {
		responses: [
			// 轮 1：长任务命令（30s 静默转后台，45s 自然完成）
			{ toolCalls: [{ name: 'bash', args: { command: LONG_COMMAND } }], stopReason: 'toolUse' },
			// 轮 2：转后台标记返回后模型收尾（turn #1 结束）
			{ text: TURN1_SENTINEL, stopReason: 'stop' },
			// 轮 3：对账补投 steer 唤醒的新 run 应答（产品缺陷修复世界下 agent_settled
			// 边沿补投会唤醒新 run；缺陷世界无补投则该轮不消费——多备无害）
			{ text: 'FGBG-A2-NOTIFY-ACK', stopReason: 'stop' },
		],
	},
	env: {
		// 托管观测档：warn fileLog 全量落盘（rejected 瞬间 appendEntry 通道被只读窗口
		// 拦截，文件日志是首败/重提 warn 的唯一落盘留痕）。
		TAIJI_AGENT_EXT_LOG: '1',
	},
	provable: [
		'C：转后台标记行到达且可提取 taskId（bt-…，30s 静默转后台）',
		'C：turn #1 以 message.complete 收尾（阻塞解除，chmod 时点锚就绪）',
		'C：首败 rejected warn 恰 1 条（rejected by delivery port；retrying once 文案在列——重提路径接线证据）',
		'C：重提仍败 warn 恰 1 条（single retry spent——retryDeliverOnce 确实执行了第二次 deliver）',
		'C：两 warn 时间近邻 ≤5s（同步链「立即」重提——非定时器延迟）',
		'C：retry skipped warn 计数 0（无转换窗/重取缺席形态）',
		'C：只读窗口内会话文件无通知 entry、无 delivery-port-outbox 条目（rejected = 幂等键未登记的结构性证据）',
		'C：+15s 静默窗（含 agent_settled 对账边沿）+ 二次对账边沿后 rejected 系 warn 恒 2 条——无第三次投递、无定时器循环、无后台重试残留（RL10 行为面）',
	],
	notProvable: [
		'首败 rejected 的 disposed 成因（设计 V2 原文形态之一）：真机结构性不可构造——四域通知生产方全部同步现取模式（bash notify.ts:189 / workflow workflow-notify.ts:345 / session-manager notify-delivery.ts:52 / scheduler backend.ts:242，取引用与 deliver 之间无 await）+ dispose 清槽（delivery-port.ts:847，disposed 实例不留在槽）+ 全扩展域无 dev 注入开关 + runtime session.* RPC 面无进程内执行通道（2026-11-02 逐项核实）；设计原文的另一指定手段「测试钩子使生产方持旧句柄提交」按 impl-plan u4 属单测域。rejected 处置阶梯在 notify.ts:193 不区分成因，persist-failed 为真机等价驱动',
		'重提成功当轮送达形态（通知当轮送达恰好 1 条）：deliver#1 与 deliver#2 在同一同步调用栈（notify.ts:192-199 无 await），外部进程的钩子（文件权限/RPC）无法只败 #1 而不败 #2——「重提成功」正面形态归单测域（RL10 单测断言 deliver 恰 2 覆盖成败两分支）；本场景以「重提路径触发 + 单次不循环」真机面承载 RL10',
		'对账补投的恢复送达（通知/outbox 终态计数）：归 V1 场景（A1）断言域，本场景静默窗只断言 rejected 系 warn 恒定（补投 accepted 无 rejected warn，缺陷修复与否不改变断言结果）；终态通知计数按观察项记录不判 pass/fail',
	],
}

/** 读扩展日志文件全文（extension-logger fileLog：<dataDir>/agent/logs/<ext>-<YYYY-MM-DD>.log）。 */
function readExtLog(dataDir) {
	const today = new Date().toISOString().slice(0, 10)
	const logFile = path.join(dataDir, 'agent', 'logs', `${EXT_NAME}-${today}.log`)
	try {
		return { logFile, text: fs.readFileSync(logFile, 'utf8') }
	} catch {
		return { logFile, text: '' }
	}
}

/** 消息串出现次数（fileLog 单行一条：`${ts} [warn] ${msg} ${detailJSON}`——detail 不含消息串本身）。 */
function countMark(text, mark) {
	let n = 0
	let i = text.indexOf(mark)
	while (i !== -1) {
		n += 1
		i = text.indexOf(mark, i + mark.length)
	}
	return n
}

/** 指定消息串的全部 warn 行（取整行供 attach 取证；行首 ISO ts 可解析时序）。 */
function markLines(text, mark) {
	return text
		.split('\n')
		.filter((line) => line.includes(mark))
}

/** 注入通知 entry 行清单：排除 delivery-port-outbox 投递日志行，按头行形态匹配（V1 同款口径）。 */
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

/** 读会话 JSONL 原文（只读窗口内读本剧本进程读不受写句柄影响，V1 同款）。 */
function readRaw(sessionFile) {
	try {
		return sessionFile ? fs.readFileSync(sessionFile, 'utf8') : ''
	} catch {
		return ''
	}
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'「appendEntry 强制失败」测试钩子的真机物理实现 = 会话 JSONL chmod 0444（真实 persist 失败，非注入假失败）：产品侧 disposed 钩子按 impl-plan u4 落单测域真机不可用；chmod 时点锚 = turn#1 收尾哨兵落盘后、任务 45s 完成前——窗口内 pi 侧唯一强制写入是完成通知的 outbox persist（正是被测对象）；首败与重提两 warn 的 appendEntry 通道同窗失败由 extension-logger 降级 fileLog（TAIJI_AGENT_EXT_LOG=1 已注入），不干扰主链',
		'首败成因口径：本场景以 persist-failed 驱动 rejected 处置阶梯（notify.ts:193 不区分 rejected 成因，reason 只进 warn detail）——设计 V2 原文 disposed 成因真机结构性不可构造（notProvable 首条证据链：四域同步现取 + dispose 清槽 + 无注入开关 + 无进程内执行通道，2026-11-02 逐项核实），不为本场景放宽或另造注入机制',
		'deliver 调用计数的真机口径 = rejected 系 warn 条数（deliver 每次 rejected 同步留痕一条 warn：首败 notify.ts:196、重提 notify.ts:230）+ retry skipped 计 0 + 关钩子后静默窗计数恒定；accepted 形态的 deliver 无 warn（重提成功世界），故「恰 2 次」在本场景形态下由「恰 2 条 rejected warn + 静默窗零新增」承载（RL10 真机面）——deliver#1/#2 同步栈内无法分离成败（notProvable 次条）',
		'恢复送达面分工：A1（V1 场景 p0-notify-rejected-reconcile-switchback）已断言对账补投恰好 1 条 + outbox 落盘 + 幂等，并登记了补投失效的产品缺陷（ghost entry 链）——本场景静默窗内若观察到补投到达（缺陷修复世界）属合法恢复路径（accepted 无 rejected warn），不构成「不循环」违例；通知/outbox 终态计数按观察项记录',
	]

	// ── 1. 注入空闲阈值配置 ─────────────────────────────────────────
	const cfgPath = writeIdleConfig(dataDir, { idleBackgroundSec: IDLE_SEC })
	ev.step({ step: 'config.idle-inject', command: `write ${cfgPath}`, exitCode: 0, stats: { idleBackgroundSec: IDLE_SEC } })

	// ── 2. 建会话（临时 cwd，不污染 repo） ─────────────────────────
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fgbg-a2-'))
	const created = await protocol.call('session.create', { cwd, label: 'p0-fgbg-a2' }, { timeoutMs: 120_000 })
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
	await protocol.send(sid, 'FGBG-A2-START 长任务转后台后 rejected 单次重提验证')

	const longStart = await waitForBashCallStart(protocol, sid, { commandIncludes: 'sleep 45', timeoutMs: 90_000, since })
	ev.assert('B: 长任务 bash 调用发起（tool_call_start）', Boolean(longStart), {
		channel: 'B',
		expected: 'sleep 45 && echo done tool_call_start',
		actual: longStart ? `at=${new Date(longStart.receivedAt).toISOString()}` : '90s 内未观察到',
	})

	// 转后台标记行 + taskId 提取（30s 静默触发；判定锚结构化 toolResult）
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
	if (!taskId) throw new Error('转后台标记行无 bt- taskId——rejected 断言无法锚定幂等键')

	// turn #1 收尾（阻塞解除 + chmod 时点锚）
	let end1 = null
	try {
		end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
	} catch (e) {
		ev.attach('turn1-end-miss', String(e?.message ?? e).slice(0, 600))
	}
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

	// ── 5. 段②：等任务自然完成 → 首败 + 重提双 warn（deliver 恰 2 的日志面） ──
	// 任务 45s 完成 + 守望 2s 轮询 + deliver 同步收尾；60s 预算从当前时刻起算。
	// chmod 段内所有证据采集用断言（不 throw），保证恢复权限必执行。
	try {
		const rejectEvidence = await pollUntil(() => {
			const { text } = readExtLog(dataDir)
			return text.includes(FIRST_REJECT_MARK) && text.includes(RETRY_REJECT_MARK) ? text : null
		}, { timeoutMs: 60_000, intervalMs: 1000 })

		const firstLines = markLines(rejectEvidence ?? '', FIRST_REJECT_MARK)
		const retryLines = markLines(rejectEvidence ?? '', RETRY_REJECT_MARK)
		const firstLine = firstLines[0] ?? null
		const retryLine = retryLines[0] ?? null

		ev.assert(
			'C: 首败 rejected warn 到达且含重提接线文案（notify.ts:196 rejected 分支）',
			Boolean(firstLine && firstLine.includes('retrying once via re-acquired port')),
			{
				channel: 'C',
				expected: '…rejected by delivery port; retrying once via re-acquired port…',
				actual: firstLine ? firstLine.slice(0, 240) : `${60_000}ms 内扩展日志无首败 warn（任务未完成或钩子未生效）`,
			},
		)
		ev.assert(
			'C: 重提仍败 warn 到达（single retry spent——retryDeliverOnce 已执行第二次 deliver）',
			Boolean(retryLine && retryLine.includes('retry rejected after the single re-acquire attempt')),
			{
				channel: 'C',
				expected: '…retry rejected after the single re-acquire attempt; single retry spent…',
				actual: retryLine ? retryLine.slice(0, 240) : '无重提仍败 warn（重提路径未触发）',
			},
		)
		if (firstLine) ev.attach('reject-warn-first', firstLine)
		if (retryLine) ev.attach('reject-warn-retry', retryLine)

		// 「立即」性：两 warn 时间近邻 ≤5s（fileLog 行首 ISO ts；同步链实测同秒级）
		let immediateMs = null
		if (firstLine && retryLine) {
			const t1 = Date.parse(firstLine.slice(0, ISO_TS_LEN))
			const t2 = Date.parse(retryLine.slice(0, ISO_TS_LEN))
			if (Number.isFinite(t1) && Number.isFinite(t2)) immediateMs = Math.abs(t2 - t1)
		}
		ev.assert(`C: 重提「立即」性——两 warn 时间近邻 ≤${IMMEDIATE_BUDGET_MS / 1000}s（非定时器延迟）`, immediateMs !== null && immediateMs <= IMMEDIATE_BUDGET_MS, {
			channel: 'C',
			expected: `Δt ≤ ${IMMEDIATE_BUDGET_MS}ms（deliver#1 rejected → 同步栈 deliver#2）`,
			actual: immediateMs !== null ? `Δt=${immediateMs}ms` : 'warn 行时间戳不可解析',
		})

		// deliver 恰 2 的计数面：rejected 系 warn 恰各 1 条 + retry skipped 0 条
		const firstCount = countMark(rejectEvidence ?? '', FIRST_REJECT_MARK)
		const retryCount = countMark(rejectEvidence ?? '', RETRY_REJECT_MARK)
		const skipCount = countMark(rejectEvidence ?? '', RETRY_SKIP_MARK)
		ev.assert('C: deliver 调用计数恰 2（rejected 系 warn 恰各 1 条：首败 1 + 重提 1）', firstCount === 1 && retryCount === 1, {
			channel: 'C',
			expected: 'first=1 retry=1（每条 rejected 同步留痕一条 warn——notify.ts:196/:230）',
			actual: `first=${firstCount} retry=${retryCount}`,
		})
		ev.assert('C: retry skipped warn 计数 0（无转换窗/重取缺席形态）', skipCount === 0, {
			channel: 'C',
			expected: 'skip=0（本场景无 session 替换，重取必在位）',
			actual: `skip=${skipCount}`,
		})

		// 结构性负向证据：只读窗口内 outbox 未落、通知未注入（rejected = 幂等键未登记）
		const rawInWindow = readRaw(sessionFile)
		const notifyInWindow = notifyEntryLines(rawInWindow)
		const outboxInWindow = outboxEntryLines(rawInWindow, taskId)
		ev.assert('C: 只读窗口内无通知注入、无投递日志条目（rejected 结构性证据）', notifyInWindow.length === 0 && outboxInWindow.length === 0, {
			channel: 'C',
			expected: 'count=0 / outbox=0（outbox 未落 = 幂等键未登记）',
			actual: `notify=${notifyInWindow.length} outbox=${outboxInWindow.length}`,
		})
	} finally {
		// ── 6. 段③：关钩子（恢复原权限）——RL10 静默窗的前提 ───────────
		fs.chmodSync(sessionFile, originalMode)
		const hookOff = (fs.statSync(sessionFile).mode & 0o777) === originalMode
		ev.assert('C: appendEntry 强制失败钩子已关（恢复原权限）', hookOff, {
			channel: 'C',
			expected: `mode=${originalMode.toString(8)}`,
			actual: `mode=${(fs.statSync(sessionFile).mode & 0o777).toString(8)}`,
		})
		ev.step({ step: 'hook.append-fail.off', command: `chmod ${originalMode.toString(8)} ${path.basename(sessionFile)}`, exitCode: hookOff ? 0 : 1, stats: {} })
	}

	// ── 7. RL10 静默窗：无循环、无定时器、无后台重试残留 ────────────
	// 不切会话、不驱动边沿——纯静默等待跨过 rejected 后首个 agent_settled 对账边沿；
	// 再经 session.getCommands 触发二次对账边沿（切回路径的产品入口，V1 同款手段）。
	// 断言口径 = rejected 系 warn 计数恒定：若存在重试循环/定时器/后台重试任务，
	// 第三次 deliver 的 rejected 会再产一条 warn（补投 accepted 无 rejected warn，
	// 故计数对补投是否发生鲁棒）。
	await new Promise((r) => setTimeout(r, QUIET_WINDOW_MS))
	try {
		await protocol.call('session.getCommands', { sessionId: sid }, { timeoutMs: 30_000 })
	} catch {
		/* 二次边沿触发失败不吞断言——下方计数恒定断言仍有效 */
	}
	await new Promise((r) => setTimeout(r, 4_000)) // 静置让二次边沿跑完（V1 同款）

	const { text: logAfterQuiet } = readExtLog(dataDir)
	const firstAfter = countMark(logAfterQuiet, FIRST_REJECT_MARK)
	const retryAfter = countMark(logAfterQuiet, RETRY_REJECT_MARK)
	const skipAfter = countMark(logAfterQuiet, RETRY_SKIP_MARK)
	ev.assert('C: RL10 静默窗后 rejected 系 warn 恒定（无第三次投递——无循环无定时器无后台重试）', firstAfter === 1 && retryAfter === 1 && skipAfter === 0, {
		channel: 'C',
		expected: `first=1 retry=1 skip=0（+${QUIET_WINDOW_MS / 1000}s 静默窗 + 二次对账边沿后）`,
		actual: `first=${firstAfter} retry=${retryAfter} skip=${skipAfter}`,
	})
	if (firstAfter !== 1 || retryAfter !== 1 || skipAfter !== 0) {
		ev.attach('ext-log-tail-after-quiet', logAfterQuiet.slice(-6000))
	}

	// 观察项（不判 pass/fail）：恢复送达终态计数——A1 断言域；缺陷/修复两世界合法值不同
	const rawFinal = readRaw(sessionFile)
	const notifyFinal = notifyEntryLines(rawFinal)
	const outboxFinal = outboxEntryLines(rawFinal, taskId)
	ev.step({
		step: 'observe.recovery-terminal-count',
		channel: 'C',
		exitCode: 0,
		stats: { notify: notifyFinal.length, outbox: outboxFinal.length, note: 'A1 断言域观察项——补投缺陷世界 0/0、修复世界 1/1 均合法' },
	})

	// 收尾自检：会话 entries 里本任务的 rejected 痕迹零残留（重提单次的账面补充证据）
	const entriesFinal = readSessionEntries(sessionFile)
	const entryTaskIdHits = entriesFinal.filter((e) => JSON.stringify(e ?? {}).includes(taskId)).length
	ev.step({ step: 'observe.session-entry-taskid-hits', channel: 'C', exitCode: 0, stats: { hits: entryTaskIdHits, note: 'ghost entry 缺陷世界含 rejected 幽灵内存条目（A1 gotchas 已登记），本观察项供归因对照' } })

	log(`done sid=${sid} taskId=${taskId} firstWarn=${firstAfter} retryWarn=${retryAfter} skipWarn=${skipAfter}`)
	return { uncovered, gotchas }
}
