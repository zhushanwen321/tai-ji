/**
 * p0-bash-idle-notify-once —— V2 长任务静默误转后自然完成 + N2 通知恰好一条
 * （foreground-idle-to-background 设计 §6.2 V2/N2 = 矩阵 A5/B3/C1；验收项 A2）。
 *
 * 装配：faux + idleBackgroundSec=30（扩展配置通道热重载注入）。
 *
 * 路径：
 *   段 1 基线：普通前台 echo 命令结果到达（包装机制下正常路径透传——两世界恒绿，
 *   兼作脚手架冒烟锚点）→
 *   段 2 转后台：`sleep 45 && echo done`（阈值 30s < 45s）静默转后台，结果含
 *   [TAIJI-FG-BG] 标记 → turn #1 以 complete 收尾 →
 *   段 3 完成通知（C1 退出感知守望）：45s 任务自然完成 → steer 注入完成通知恰好
 *   1 条——「结果未知」形态（finished (exit code unknown, <耗时>) + Last lines
 *   输出尾部含 done + Full output 路径；退出码结构性不可得，设计 §5 部件 5）→
 *   通知唤醒新 run（faux 轮 4 应答）→ message.complete#2 →
 *   段 4 负面：+8s 静默窗后复查通知计数仍 = 1（N2 无第二条）。
 *
 * 计数口径：通知按注入 entry 行统计（unified-delivery 主路径每条通知在会话 JSONL
 * 结构性落两行——delivery-port-outbox 投递日志行（payload 携带完整通知文本）+
 * 注入的 custom entry（customType=background-bash），日志行不计数）。
 * 唤醒时序：唤醒等待与通知文件轮询并发执行——waitFor 全历史扫描 + 事件时间戳晚于
 * turn#1 收尾时刻过滤，消除「通知检出（500ms 轮询粒度）晚于注入唤醒（faux 轮
 * 实测 ≈226ms）→ 游标后才取已漏帧」的结构性竞态（首跑实测 complete#2 落在游标前）。
 *
 * 实现前 HEAD 形态（预期红）：sleep 45 在前台跑满 45s 自然返回（结果含 done、
 * 无标记行、无通知）——转后台/通知断言红是预期；段 1 基线恒绿证明装配链路可用。
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
} from './lib/fg-bg-lib.mjs'

/** 空闲转后台阈值（秒）。 */
const IDLE_SEC = 30
/** 长任务命令（设计 §6.2 V2 原文）：阈值 30s < 45s，转后台后自然完成。 */
const LONG_COMMAND = 'sleep 45 && echo done'
/** 基线命令哨兵（普通前台命令，两世界恒绿）。 */
const BASELINE_TEXT = 'FGBG-A2-BASELINE-OK'
/** 完成通知「结果未知」形态头行（设计 §5 部件 5：natural + null 退出码修订；单行匹配用）。 */
const NOTIFY_UNKNOWN_RE = /\[background-bash\][^\n]*finished \(exit code unknown[^\n]*\)/
/** 投递端口 outbox 日志条目的 customType（delivery-port src/journal.ts OUTBOX_CUSTOM_TYPE）。
 * unified-delivery 主路径每条通知在会话 JSONL 结构性落两行：outbox 日志行（payload
 * 携带完整通知文本）+ 注入的 custom entry（customType=background-bash）——通知计数
 * 只认注入 entry 行，排除 outbox 日志行（按原文头行计数会每条双计）。 */
const OUTBOX_CUSTOM_TYPE = 'delivery-port-outbox'
/** turn 收尾事件类型（与 protocol.mjs waitTurnEnd 内部集合一致——唤醒等待需时间戳
 * 过滤谓词，不经 waitTurnEnd 直接用 waitFor）。 */
const TURN_END_TYPES = new Set(['message.complete', 'message.error', 'message.stream_error', 'session.exited'])

export const meta = {
	id: 'p0-bash-idle-notify-once',
	priority: 'P0',
	title: 'V2+N2：长任务静默转后台后自然完成，完成通知恰好 1 条（exit code unknown + Last lines）',
	covers: ['env.launch', 'env.ready', 'env.doctor', 'session.create', 'chat.send', 'chat.wait', 'chat.stream'],
	requires: ['faux'],
	estimateSec: 330,
	faux: {
		responses: [
			// 轮 1：基线普通前台命令（脚手架锚点，两世界恒绿）
			{ toolCalls: [{ name: 'bash', args: { command: `echo ${BASELINE_TEXT}` } }], stopReason: 'toolUse' },
			// 轮 2：长任务命令（30s 静默转后台，45s 自然完成）
			{ toolCalls: [{ name: 'bash', args: { command: LONG_COMMAND } }], stopReason: 'toolUse' },
			// 轮 3：转后台标记返回后模型收尾（turn #1 结束）
			{ text: 'FGBG-A2-TURN1-END', stopReason: 'stop' },
			// 轮 4：完成通知 steer 唤醒的新 run 应答（缺这步该轮以 faux 耗尽 error 收尾）
			{ text: 'FGBG-A2-NOTIFY-ACK', stopReason: 'stop' },
		],
	},
	provable: [
		'C：基线普通前台命令结果到达且含哨兵（正常路径透传锚点，两世界恒绿）',
		'C：长任务结果含 [TAIJI-FG-BG] 标记行（30s 静默转后台）',
		'B：turn #1 以 message.complete 收尾（阻塞解除）',
		'C：完成通知到达且为「结果未知」形态（finished (exit code unknown + 耗时)）',
		'C：通知含 Last lines 输出尾部（done）与 Full output 路径',
		'B：通知唤醒新 run 并以 message.complete#2 收尾（steer 自动唤醒）',
		'C：+8s 静默窗后通知计数仍恰好 1（N2 无第二条）',
	],
	notProvable: [
		'通知到达时刻与任务完成时刻的精确差（守望间隔 2s + 容差属 V11 时序验收，本剧本只断到达与恰好一条）',
		'模型对通知内容的事后决策（faux 不读上下文）',
	],
}

/** 读会话 JSONL 原文（通知计数按原文统计，与 custom entry 结构形态解耦）。 */
function readRaw(sessionFile) {
	try {
		return sessionFile ? fs.readFileSync(sessionFile, 'utf8') : ''
	} catch {
		return ''
	}
}

/** 原文条件轮询（通知谓词直接作用于文件原文）。 */
async function pollRawText(sessionFile, predicate, { timeoutMs, intervalMs = 500 } = {}) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const raw = readRaw(sessionFile)
		if (predicate(raw)) return raw
		if (Date.now() >= deadline) return raw
		await new Promise((r) => setTimeout(r, intervalMs))
	}
}

/** 注入通知 entry 行清单：逐行解析会话 JSONL，排除 customType="delivery-port-outbox"
 * 的投递日志行（payload 携带完整通知文本，按原文统计会每条双计），其余行按通知头行
 * 形态匹配——每条通知恰一行（注入 entry），计数 = 行数。JSON.parse 失败（写入中的
 * 部分行）跳过，下一轮询再试。 */
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

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'完成通知经 pi.sendMessage steer + triggerTurn 注入——会唤醒新 run 并消耗一个 faux step，响应脚本必须排通知应答步（轮 4），否则该轮以 faux 耗尽 error 收尾',
		'通知计数按注入 entry 行统计，排除 delivery-port-outbox 投递日志行——unified-delivery 主路径每条通知在会话 JSONL 结构性落两行（outbox 日志行 payload 携带完整通知文本 + 注入的 custom entry），按原文头行计数会每条双计（首跑实测 count=2 即日志行双计，非产品重复通知；+8s 静默窗 count 不增佐证产品 taskId 幂等正常）',
		'唤醒等待必须与通知检出并发（waitFor 全历史扫描 + 事件时间戳晚于 turn#1 收尾时刻过滤）——若在通知检出（500ms 文件轮询粒度）后才取游标，注入唤醒的 faux 轮（实测 ≈226ms）可能已落事件流，waitFor 只扫游标后帧 → complete#2 结构性漏检（首跑实测：turn2-end-miss「waitFor 超时（60000ms，已扫 67 帧）」）；时间戳过滤同时避免提前的游标误命中 turn#1 自己的 complete#1',
		'工具结果判定必须锚结构化 toolResult entry（message.role=toolResult）——原文子串谓词会被 assistant toolCall 的 arguments 里的命令文本抢先命中（首跑实测：toolCall 落盘早于 toolResult 数百毫秒，哨兵在命令里即假命中）',
		'实现前 HEAD 形态：sleep 45 前台跑满自然返回，无标记行、无通知——段 2/3/4 断言红是预期（D1 开发中），段 1 基线恒绿证明装配/驱动/清理链路可用（脚手架冒烟形态）',
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

	// ── 3. 驱动：轮 1 基线 + 轮 2 长任务（一次 user 消息，faux 按序消费） ──
	const since = protocol.events.length
	await protocol.send(sid, 'FGBG-A2-START 先基线后长任务')

	// 段 1：基线普通命令结果到达（两世界恒绿的脚手架锚点）
	const baseStart = await waitForBashCallStart(protocol, sid, { commandIncludes: BASELINE_TEXT, timeoutMs: 60_000, since })
	ev.assert('B: 基线 bash 调用发起（tool_call_start）', Boolean(baseStart), {
		channel: 'B',
		expected: 'echo 基线命令 tool_call_start',
		actual: baseStart ? `at=${new Date(baseStart.receivedAt).toISOString()}` : '60s 内未观察到',
	})
	const sessionFile = created.session?.sessionFile ?? (await pollUntil(() => findSessionFile(dataDir, sid), { timeoutMs: 15_000 }))
	ev.step({ step: 'evidence.session-file', command: `locate ${sid}`, exitCode: sessionFile ? 0 : 1, stats: { sessionFile: sessionFile ?? '未找到' } })
	// 基线判定必须锚 toolResult（结构化谓词）——原文谓词会被 assistant toolCall 的
	// arguments 里的命令文本抢先命中（首跑实测：toolCall 落盘早于 toolResult 数百毫秒）
	const { entries: baseEntries } = await pollSessionFile(
		sessionFile,
		(es) => toolResultsFor(es, 'bash').some((r) => r.text.includes(BASELINE_TEXT)),
		{ timeoutMs: 30_000 },
	)
	const baseResult = toolResultsFor(baseEntries, 'bash').find((r) => r.text.includes(BASELINE_TEXT)) ?? null
	ev.assert('C: 基线普通前台命令结果到达且含哨兵（正常路径透传锚点）', Boolean(baseResult), {
		channel: 'C',
		expected: `bash toolResult 含 ${BASELINE_TEXT}`,
		actual: baseResult ? baseResult.text.slice(0, 200) : `会话条目数=${baseEntries.length}，结构化 toolResult 未匹配`,
	})
	ev.step({ step: 'baseline.echo', command: `echo ${BASELINE_TEXT}`, exitCode: baseResult ? 0 : 1, stats: { arrived: Boolean(baseResult) } })

	// 段 2：长任务转后台（标记行）
	const longStart = await waitForBashCallStart(protocol, sid, { commandIncludes: 'sleep 45', timeoutMs: 90_000, since })
	ev.assert('B: 长任务 bash 调用发起（tool_call_start）', Boolean(longStart), {
		channel: 'B',
		expected: 'sleep 45 && echo done tool_call_start',
		actual: longStart ? `at=${new Date(longStart.receivedAt).toISOString()}` : '90s 内未观察到',
	})
	const longSleepStartAt = longStart?.receivedAt ?? Date.now()
	// 标记行判定锚 toolResult（结构化谓词，同基线理由）
	const { entries: convertedEntries } = await pollSessionFile(
		sessionFile,
		(es) => toolResultsFor(es, 'bash').some((r) => r.text.includes('[TAIJI-FG-BG]')),
		{ timeoutMs: (IDLE_SEC + 30) * 1000 },
	)
	const longResult = toolResultsFor(convertedEntries, 'bash').find((r) => r.text.includes('[TAIJI-FG-BG]')) ?? null
	ev.assert('C: 长任务结果含 [TAIJI-FG-BG] 转后台标记行（30s 静默触发）', Boolean(longResult), {
		channel: 'C',
		expected: '结果文本含 [TAIJI-FG-BG]',
		actual: longResult ? longResult.text.slice(0, 400) : `${IDLE_SEC + 30}s 内无标记行（实现前 HEAD 形态：前台跑满）`,
	})
	if (longResult) ev.attach('long-task-result', longResult.text)

	// turn #1 收尾（阻塞解除）
	let end1 = null
	try {
		end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
	} catch (e) {
		ev.attach('turn1-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	ev.assert('B: turn #1 以 message.complete 收尾（阻塞解除）', end1?.type === 'message.complete' && end1.ok, {
		channel: 'B',
		expected: 'message.complete（faux 轮 3 收尾）',
		actual: end1 ? `${end1.type} stop=${String(end1.payload?.stopReason)}` : '未等到',
	})
	ev.step({ step: 'chat.wait.turn1', channel: 'B', exitCode: end1?.ok ? 0 : 1, stats: { stopReason: end1?.payload?.stopReason } })

	// ── 4. 段 3：完成通知恰好一条（结果未知形态 + steer 唤醒） ─────
	// 任务自 longSleepStartAt 起 45s 完成 + 守望 2s 轮询 + 注入开销；此处从当前时刻
	// 起给 60s 预算（覆盖 HEAD 形态下等待超时的完整窗口）。唤醒等待与通知文件轮询
	// 并发执行：通知检出（500ms 轮询粒度）可能晚于注入唤醒（faux 轮实测 ≈226ms），
	// 检出后才取游标会让 waitFor 只扫游标后帧而漏掉已落事件的 complete#2（首跑实测
	// 竞态漏检）。改用 waitFor 全历史扫描 + 事件时间戳晚于 turn#1 收尾时刻过滤——
	// complete#2 因果上晚于 turn#1 收尾（注入由任务完成守望触发，任务完成 ≈45s 晚于
	// 转后台后 ≈30s 的 turn#1 收尾），谓词不会误命中 turn#1 自己的 complete#1。
	const end1At = end1?.at ?? 0
	const notifyPoll = pollRawText(sessionFile, (raw) => notifyEntryLines(raw).length >= 1, { timeoutMs: 60_000, intervalMs: 500 })
	let end2 = null
	try {
		end2 = await protocol.waitFor((e) => TURN_END_TYPES.has(e.type) && e.receivedAt > end1At, { sessionId: sid, timeoutMs: 90_000 })
	} catch (e) {
		ev.attach('turn2-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	const rawNotified = await notifyPoll
	const notifyLines = notifyEntryLines(rawNotified)
	const firstNotifyLine = notifyLines[0] ?? null
	const firstHead = firstNotifyLine ? (NOTIFY_UNKNOWN_RE.exec(firstNotifyLine)?.[0] ?? null) : null
	ev.assert('C: 完成通知到达且为「结果未知」形态（finished (exit code unknown, 耗时)）', notifyLines.length >= 1, {
		channel: 'C',
		expected: '[background-bash] bt-… finished (exit code unknown, …)（注入 entry 行）',
		actual: firstHead ? `${firstHead}（sleep 启动→通知检出 ${((Date.now() - longSleepStartAt) / 1000).toFixed(1)}s）` : '60s 内无该形态通知（实现前 HEAD 形态：无转后台即无通知）',
	})
	if (firstNotifyLine) {
		const headIdx = firstNotifyLine.indexOf(firstHead)
		const window = firstNotifyLine.slice(headIdx, headIdx + 1200)
		ev.assert('C: 通知含 Last lines 输出尾部（done）', window.includes('Last lines:') && window.includes('done'), {
			channel: 'C',
			expected: 'Last lines: …done…（输出尾部）',
			actual: window.split('\n').slice(0, 4).join(' | ').slice(0, 400),
		})
		ev.assert('C: 通知含 Full output 路径与 bash_output 指引', /Full output:\s*\S+/.test(window) && window.includes('bash_output'), {
			channel: 'C',
			expected: 'Full output: <path>; use bash_output {task_id}…',
			actual: /Full output:\s*(\S+)/.exec(window)?.[1] ?? '未匹配',
		})
		ev.attach('notification-window', window)
	}

	// 唤醒断言（ok 口径与 protocol.waitTurnEnd 一致：message.complete 且停因非 error）
	const end2Ok = end2?.type === 'message.complete' && end2.payload?.stopReason !== 'error'
	ev.assert('B: 通知唤醒新 run 并以 message.complete#2 收尾（steer 自动唤醒）', end2Ok, {
		channel: 'B',
		expected: '第二次 message.complete（faux 轮 4 应答）',
		actual: end2
			? `${end2.type} stop=${String(end2.payload?.stopReason)}`
			: notifyLines.length >= 1
				? '有通知注入但未等到新 run 收尾——排查产品唤醒链路（pi.sendMessage steer + triggerTurn idle 唤醒）'
				: '未等到新 run（无通知即无唤醒——实现前 HEAD 形态）',
	})
	ev.step({ step: 'chat.wait.turn2-notify', channel: 'B', exitCode: end2Ok ? 0 : 1, stats: { stopReason: end2?.payload?.stopReason } })

	// ── 5. 段 4（N2 负面）：+8s 静默窗后通知计数仍恰好 1 ───────────
	await new Promise((r) => setTimeout(r, 8_000))
	const notifyLinesAfter = notifyEntryLines(readRaw(sessionFile))
	ev.assert('C: 通知恰好 1 条（N2：+8s 静默窗后无第二条）', notifyLinesAfter.length === 1, {
		channel: 'C',
		expected: 'count=1（注入 entry 行口径；delivery-port-outbox 投递日志行不计）',
		actual: `count=${notifyLinesAfter.length}${notifyLinesAfter.length > 1 ? ` 多余条目：${(NOTIFY_UNKNOWN_RE.exec(notifyLinesAfter[1])?.[0] ?? notifyLinesAfter[1]).slice(0, 200)}` : ''}`,
	})

	if (!longResult || notifyLinesAfter.length !== 1) {
		uncovered.push('V2/N2 完整链路（转后台→自然完成→恰好一条通知）在当前 HEAD 未生效——新行为断言按预期红（D1 开发中，D3 全量重跑本剧本判绿）；段 1 基线（普通 bash 命令结果到达）已验装配/驱动/清理链路可用')
	}
	log(`done sid=${sid} notifyCount=${notifyLinesAfter.length}`)
	return { uncovered, gotchas }
}
