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
/** 完成通知「结果未知」形态头行（设计 §5 部件 5：natural + null 退出码修订；match(/g) 统计用）。 */
const NOTIFY_UNKNOWN_RE = /\[background-bash\][^\n]*finished \(exit code unknown[^\n]*\)/g

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

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'完成通知经 pi.sendMessage steer + triggerTurn 注入——会唤醒新 run 并消耗一个 faux step，响应脚本必须排通知应答步（轮 4），否则该轮以 faux 耗尽 error 收尾',
		'通知计数按会话 JSONL 原文的头行形态统计（/[background-bash]…finished \\(exit code unknown/ 每条通知恰一行）——不依赖 custom entry 的结构形态（与 pi 版本解耦）',
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
	// 起给 60s 预算（覆盖 HEAD 形态下等待超时的完整窗口）
	const rawNotified = await pollRawText(sessionFile, (raw) => (raw.match(NOTIFY_UNKNOWN_RE) ?? []).length >= 1, { timeoutMs: 60_000, intervalMs: 500 })
	const heads = rawNotified.match(NOTIFY_UNKNOWN_RE) ?? []
	const firstHead = heads[0] ?? null
	ev.assert('C: 完成通知到达且为「结果未知」形态（finished (exit code unknown, 耗时)）', heads.length >= 1, {
		channel: 'C',
		expected: '[background-bash] bt-… finished (exit code unknown, …)',
		actual: heads.length > 0 ? `${firstHead}（sleep 启动→通知检出 ${((Date.now() - longSleepStartAt) / 1000).toFixed(1)}s）` : '60s 内无该形态通知（实现前 HEAD 形态：无转后台即无通知）',
	})
	if (firstHead) {
		const headIdx = rawNotified.indexOf(firstHead)
		const window = rawNotified.slice(headIdx, headIdx + 1200)
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

	// 通知唤醒新 run（complete#2；游标在 turn#1 收尾等待之后）
	let end2 = null
	const since2 = protocol.events.length
	try {
		end2 = await protocol.waitTurnEnd(sid, { since: since2, timeoutMs: 60_000 })
	} catch (e) {
		ev.attach('turn2-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	ev.assert('B: 通知唤醒新 run 并以 message.complete#2 收尾（steer 自动唤醒）', end2?.type === 'message.complete' && end2.ok, {
		channel: 'B',
		expected: '第二次 message.complete（faux 轮 4 应答）',
		actual: end2 ? `${end2.type} stop=${String(end2.payload?.stopReason)}` : '未等到新 run（无通知即无唤醒——实现前 HEAD 形态）',
	})
	ev.step({ step: 'chat.wait.turn2-notify', channel: 'B', exitCode: end2?.ok ? 0 : 1, stats: { stopReason: end2?.payload?.stopReason } })

	// ── 5. 段 4（N2 负面）：+8s 静默窗后通知计数仍恰好 1 ───────────
	await new Promise((r) => setTimeout(r, 8_000))
	const headsAfter = readRaw(sessionFile).match(NOTIFY_UNKNOWN_RE) ?? []
	ev.assert('C: 通知恰好 1 条（N2：+8s 静默窗后无第二条）', headsAfter.length === 1, {
		channel: 'C',
		expected: 'count=1',
		actual: `count=${headsAfter.length}${headsAfter.length > 1 ? ` 多余条目：${headsAfter.slice(1).join(' / ').slice(0, 200)}` : ''}`,
	})

	if (!longResult || headsAfter.length !== 1) {
		uncovered.push('V2/N2 完整链路（转后台→自然完成→恰好一条通知）在当前 HEAD 未生效——新行为断言按预期红（D1 开发中，D3 全量重跑本剧本判绿）；段 1 基线（普通 bash 命令结果到达）已验装配/驱动/清理链路可用')
	}
	log(`done sid=${sid} notifyCount=${headsAfter.length}`)
	return { uncovered, gotchas }
}
