/**
 * p0-notify-rejected-reconcile-switchback —— V1 bash 域补投：rejected 后切回对账补投送达
 * （completion-signal-delivery 设计 §4.1 V1；验收项 A1，D0 约定名）。
 *
 * 装配：faux + idleBackgroundSec=30 + TAIJI_AGENT_EXT_LOG=1（warn fileLog 落盘供
 * rejected 取证——rejected 瞬间会话文件被本剧本置只读，warn 的 appendEntry 通道
 * 同步失败，降级文件日志是唯一落盘留痕，extension-logger index.ts warn 分支）。
 *
 * 路径（设计 V1 四步断言面）：
 *   ① idleBackgroundSec=30 + 开「appendEntry 强制失败」钩子——钩子的物理实现 =
 *   会话 JSONL chmod 0444（真实 persist 失败驱动，非注入假失败）：pi appendFileSync
 *   EACCES 同步抛错（pi-coding-agent dist session-manager _persist）→ delivery-port
 *   persistOutboxRecord catch → deliver 返回 rejected(persist-failed)（delivery-port
 *   .ts:658-660/:671-686）。产品测试构建钩子按 impl-plan u4 属单测域（__tests__/
 *   territory），真机不可用——chmod 是验收资产侧的等价驱动手段（gotchas 登记）。
 *   ② 发转后台命令（sleep 45 && echo done），等自然完成：完成瞬间 appendEntry 失败
 *   → rejected(persist-failed)，首败 warn 含 recovered 指引（notify.ts:196）+ 处置
 *   阶梯①当场单次重提仍失败 →「single retry spent」warn（notify.ts:230）。
 *   ③ 关钩子（chmod 恢复原权限），切走会话再切回——对账边沿驱动 = session.getCommands
 *   RPC（切回后 renderer 必经查询，runtime 在此经 prompt('/__taiji_bg_reconcile__')
 *   无条件补触发对账，session-service.ts maybeTriggerBgReconcile；60s 节流已退役）。
 *   ④ 断言：切回后对话流出现恰好 1 条完成通知（taskId 一致、exit code unknown、
 *   Last lines 输出尾部、details 齐备 taskId/command/durationMs/endReason/exitCode
 *   ——buildNotifyDetails 同构造）；投递日志出现该 taskId 的 delivery-port-outbox
 *   条目（补投受理落盘）；+8s 静默窗 + 二次边沿后无第二条同 id 通知（幂等）。
 *
 * 计数口径：通知按注入 entry 行统计（customType≠delivery-port-outbox 且头行形态
 * 匹配）——unified-delivery 主路径每条通知结构性落两行（outbox 日志行 + 注入
 * custom entry），日志行不计数（同族 p0-bash-idle-notify-once 先例）。
 *
 * 预期形态（2026-11-01 实测，a1-assembly2 首跑证据 /tmp/verify-a1-assembly）：段①②③
 * 全绿（钩子生效 / rejected(persist-failed) 双 warn 含 recovered 指引 / 窗口内 outbox
 * 未落）；段④补投红灯 = 已定位产品侧根因（见 gotchas 首条 ghost entry 链）——单测
 * （mock appendEntry 不经真 pi SessionManager）覆盖不到该形态，本剧本红灯是真机
 * 验收的正确产出，待产品侧修复后重跑判绿；修复前禁放宽断言绕缺陷换绿灯。
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

/** 空闲转后台阈值（秒，设计 V1 前置①）。 */
const IDLE_SEC = 30
/** 长任务命令（设计 V1 前置②原文）：阈值 30s < 45s，转后台后自然完成。 */
const LONG_COMMAND = 'sleep 45 && echo done'
/** turn #1 收尾哨兵（faux 轮 2 文本——chmod 时点锚：哨兵落盘后 assistant 写入已完毕）。 */
const TURN1_SENTINEL = 'FGBG-A1-TURN1-END'
/** 完成通知「结果未知」形态头行（单行匹配用，同族 A2 同款）。 */
const NOTIFY_UNKNOWN_RE = /\[background-bash\][^\n]*finished \(exit code unknown[^\n]*\)/
/** 投递日志 outbox 条目的 customType（delivery-port journal.ts OUTBOX_CUSTOM_TYPE）。 */
const OUTBOX_CUSTOM_TYPE = 'delivery-port-outbox'
/** 扩展名（extension-logger fileLog 文件名前缀 + warn detail 定位）。 */
const EXT_NAME = 'base-tool-enhance'
/** turn 收尾事件类型（与 protocol.mjs waitTurnEnd 内部集合一致）。 */
const TURN_END_TYPES = new Set(['message.complete', 'message.error', 'message.stream_error', 'session.exited'])
/** 补投 notifyId 形态（registry taskId，幂等键——isReapNotifyCandidate 事实源）。 */
const TASK_ID_RE = /bt-[A-Za-z0-9_-]+/

export const meta = {
	id: 'p0-notify-rejected-reconcile-switchback',
	priority: 'P0',
	title: 'V1：rejected(persist-failed) 后切回对账补投送达——恰好 1 条、outbox 落盘、幂等',
	covers: ['session.create', 'chat.send', 'chat.wait', 'chat.stream'],
	requires: ['faux'],
	estimateSec: 300,
	faux: {
		responses: [
			// 轮 1：长任务命令（30s 静默转后台，45s 自然完成）
			{ toolCalls: [{ name: 'bash', args: { command: LONG_COMMAND } }], stopReason: 'toolUse' },
			// 轮 2：转后台标记返回后模型收尾（turn #1 结束）
			{ text: TURN1_SENTINEL, stopReason: 'stop' },
			// 轮 3：补投通知 steer 唤醒的新 run 应答（缺这步该轮以 faux 耗尽 error 收尾）
			{ text: 'FGBG-A1-NOTIFY-ACK', stopReason: 'stop' },
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
		'C：完成瞬间 rejected(persist-failed)：首败 warn + 重提仍败 warn 均含 recovered 指引（扩展日志文件）',
		'C：只读窗口内会话文件无通知 entry、无 delivery-port-outbox 条目（outbox 未落的结构性证据）',
		'C：切回对账边沿后对话流出现恰好 1 条补投完成通知（taskId 与原任务一致）',
		'C：通知文案含 finished (exit code unknown + Last lines 输出尾部（done）+ Full output/bash_output 指引',
		'C：通知 entry details 齐备（taskId/command/durationMs/endReason/exitCode=null 五字段）',
		'C：投递日志出现该 taskId 的 delivery-port-outbox 条目（补投受理落盘）',
		'B：补投 steer 唤醒新 run 并以 message.complete#2 收尾',
		'C：+8s 静默窗 + 二次对账边沿后通知计数仍恰好 1（幂等）',
	],
	notProvable: [
		'GUI pane 渲染细节（视觉档位核对归 V6 真机视觉节点；本剧本 UI 通道只做通知块可见取证，环境性缺席时登记 uncovered 不判失败）',
		'补投到达的精确时延上界（设计 V1 明示「时序随维护链执行，秒级量级——无精确上界承诺」）',
	],
}

/** 读会话 JSONL 原文。 */
function readRaw(sessionFile) {
	try {
		return sessionFile ? fs.readFileSync(sessionFile, 'utf8') : ''
	} catch {
		// 只读窗口内 pi 持有写句柄不影响读本剧本进程读；读失败按空文处理由上层断言暴露
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
			// 条目 data 形态（delivery-port persistOutboxRecord）：{v:2, id, timing, payload, recordedAt}
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

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'【产品缺陷定位（2026-11-01 实测，补投红灯根因，待产品侧修复）】rejected 的 outbox 条目留幽灵内存 entry：pi SessionManager._appendEntry 先 fileEntries.push 后 _persist 写盘、EACCES 抛错无回滚（node_modules @earendil-works/pi-coding-agent dist/core/session-manager.js:815-820/:901-911）——persistOutboxRecord 首败+重提两次 rejected 各留一条 {type:"custom",customType:"delivery-port-outbox",data} 幽灵（JSONL 无行，实测 outbox=0 吻合）；对账判据 collectJournaledDeliveryIds 消费 getEntries() 内存账（notify-reconcile-judgement.ts:140-170）→ taskId 误判「受理已发生」→ isReconcileNotifyCandidate=false → deliverReapNotifications 终判静默 continue（无日志，dispatch resume 后零输出吻合）→ 补投结构性失效。与 delivery-port 契约「rejected=幂等键未登记、outbox 未落，条目可重试」（delivery-port.ts:658-660/types.ts:68）矛盾。修复方向三选一归产品裁决：pi 侧 persist 失败回滚内存 / 判据改读磁盘 journal / rejected 形态标记跳过——本剧本断言面不为此放宽',
		'「appendEntry 强制失败」测试钩子的真机物理实现 = 会话 JSONL chmod 0444（真实 persist 失败，非注入假失败）：产品侧钩子按 impl-plan u4 落单测域（__tests__/ territory）真机不可用；chmod 时点锚 = turn#1 收尾哨兵落盘后（assistant 写入已完毕）、任务 45s 完成前——窗口内 pi 侧唯一强制写入是完成通知的 outbox persist（正是被测对象）；warn 的 appendEntry 通道同窗失败由 extension-logger 降级 fileLog（TAIJI_AGENT_EXT_LOG=1 已注入），不干扰主链',
		'切回对账边沿驱动 = session.getCommands RPC：产品切回路径的必经查询（切回 UI 动作最终落在 renderer 的这次拉取上），runtime 侧经 prompt("/__taiji_bg_reconcile__") 无条件补触发（60s 节流已退役、无待补任务时扩展三判据早退零开销）——同一条产品代码路径，非测试后门',
		'通知计数按注入 entry 行统计、排除 delivery-port-outbox 日志行（同族 p0-bash-idle-notify-once 先例：每条通知结构性落两行，按原文头行计数会双计）',
		'补投与唤醒等待并发执行（waitFor 全历史扫描 + 事件时间戳晚于 turn#1 收尾过滤）：通知检出（500ms 文件轮询）可能晚于注入唤醒（faux 轮实测 ≈数百 ms），检出后才取游标会让 waitFor 漏掉已落事件的 complete#2（同族首跑实测竞态）',
	]

	// ── 1. 注入空闲阈值配置 ─────────────────────────────────────────
	const cfgPath = writeIdleConfig(dataDir, { idleBackgroundSec: IDLE_SEC })
	ev.step({ step: 'config.idle-inject', command: `write ${cfgPath}`, exitCode: 0, stats: { idleBackgroundSec: IDLE_SEC } })

	// ── 2. 建会话（临时 cwd，不污染 repo） ─────────────────────────
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fgbg-a1-'))
	const created = await protocol.call('session.create', { cwd, label: 'p0-fgbg-a1' }, { timeoutMs: 120_000 })
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
	await protocol.send(sid, 'FGBG-A1-START 长任务转后台后切回验证补投')

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

	// ── 5. 段②：等任务自然完成 → rejected(persist-failed) 证据 ─────
	// 任务 45s 完成 + 守望 2s 轮询 + deliver 同步收尾；60s 预算从当前时刻起算。
	const logFile = extLogFileOf(dataDir)
	const rejectEvidence = await pollUntil(() => {
		try {
			const text = fs.readFileSync(logFile, 'utf8')
			return text.includes('rejected by delivery port') && text.includes('recovered by reconcile fallback') ? text : null
		} catch {
			return null
		}
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

	// ── 6. 段③：关钩子（恢复原权限）+ 切回对账边沿 ─────────────────
	fs.chmodSync(sessionFile, originalMode)
	const hookOff = (fs.statSync(sessionFile).mode & 0o777) === originalMode
	ev.assert('C: appendEntry 强制失败钩子已关（恢复原权限）', hookOff, {
		channel: 'C',
		expected: `mode=${originalMode.toString(8)}`,
		actual: `mode=${(fs.statSync(sessionFile).mode & 0o777).toString(8)}`,
	})
	ev.step({ step: 'hook.append-fail.off', command: `chmod ${originalMode.toString(8)} ${path.basename(sessionFile)}`, exitCode: hookOff ? 0 : 1, stats: {} })

	// 切走会话再切回 = renderer 必经的 session.getCommands 拉取（runtime 在此无条件
	// 补触发 /__taiji_bg_reconcile__ 内部命令 → 扩展维护链 reconcilePendingEntries）。
	// 边沿前取证：registry 快照（对账判据第一重事实的独立自检——终态形态与 reason）。
	const registryBefore = readRegistry(dataDir, sid)
	ev.attach('registry-before-edge', registryBefore ? JSON.stringify(registryBefore, null, 2) : `(不存在：${registryPathOf(dataDir, sid)})`)
	try {
		await protocol.call('session.getCommands', { sessionId: sid }, { timeoutMs: 30_000 })
	} catch (e) {
		ev.attach('get-commands-error', String(e?.message ?? e).slice(0, 300))
	}
	ev.step({ step: 'reconcile.edge.switchback', command: `session.getCommands ${sid}`, exitCode: 0, stats: { edge: '__taiji_bg_reconcile__' } })

	// 命令执行证据：扩展维护链入口 debug 日志（TAIJI_AGENT_EXT_LOG=1 下降档 info 落盘）
	const dispatched = await pollUntil(() => {
		try {
			return fs.readFileSync(logFile, 'utf8').includes('reconcile maintenance dispatch') ? true : null
		} catch {
			return null
		}
	}, { timeoutMs: 15_000, intervalMs: 500 })
	ev.assert('B: __taiji_bg_reconcile__ 维护链已派发（切回对账边沿执行证据）', Boolean(dispatched), {
		channel: 'B',
		expected: '扩展日志含 reconcile maintenance dispatch (reason:"resume")',
		actual: dispatched ? '已派发' : `15s 内未见派发行——prompt 未达扩展（命令未注册 / 路由分支），见 ${logFile}`,
	})
	if (!dispatched) ev.attach('ext-log-tail-at-edge', (() => { try { return fs.readFileSync(logFile, 'utf8').slice(-4000) } catch { return '(日志读不到)' } })())

	// ── 7. 段④：补投恰好 1 条 + 唤醒 + outbox 落盘 ─────────────────
	// 补投文件轮询与唤醒等待并发（同族 A2 竞态纪律——全历史扫描 + 时间戳过滤）。
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

	// 判据磁盘事实自检（补投未达时的归因面：产品判据三重事实 vs 剧本独立读取）
	if (notifyLines.length === 0) {
		const entries = readSessionEntries(sessionFile)
		const deliveredMarks = entries.filter((e) => JSON.stringify(e ?? {}).includes(taskId) && (e?.type === 'message' ? JSON.stringify(e.message ?? {}).includes('background-bash') : false)).length
		const registryAfter = readRegistry(dataDir, sid)
		ev.attach('reconcile-facts-selfcheck', JSON.stringify({
			registryEntry: registryAfter ? (JSON.stringify(registryAfter).includes(taskId) ? 'taskId 在册' : 'taskId 不在册') : 'registry 不存在',
			registryRaw: registryAfter ? JSON.stringify(registryAfter).slice(0, 1200) : null,
			sessionEntriesWithTaskId: deliveredMarks,
			extLogTail: (() => { try { return fs.readFileSync(logFile, 'utf8').slice(-6000) } catch { return '(日志读不到)' } })(),
		}, null, 2))
	}
	ev.assert('C: 切回后补投完成通知到达（结果未知形态）', notifyLines.length >= 1, {
		channel: 'C',
		expected: '[background-bash] bt-… finished (exit code unknown, …)（注入 entry 行）',
		actual: firstHead ? firstHead.slice(0, 200) : '60s 内无补投通知（对账边沿未触发或判据未命中）',
	})

	// taskId 一致 + 文案 + details 齐备
	if (firstNotifyLine) {
		const notifyTaskId = TASK_ID_RE.exec(firstNotifyLine)?.[0] ?? null
		ev.assert('C: 补投通知 taskId 与原任务一致（幂等键同源）', notifyTaskId === taskId, {
			channel: 'C',
			expected: taskId,
			actual: notifyTaskId ?? '通知行无 bt- id',
		})
		const headIdx = firstNotifyLine.indexOf(firstHead)
		const window = firstNotifyLine.slice(headIdx, headIdx + 1600)
		ev.assert('C: 通知文案含 Last lines 输出尾部（done）', window.includes('Last lines:') && window.includes('done'), {
			channel: 'C',
			expected: 'Last lines: …done…（输出尾部）',
			actual: window.split('\n').slice(0, 4).join(' | ').slice(0, 300),
		})
		ev.assert('C: 通知文案含 Full output 路径与 bash_output 指引', /Full output:\s*\S+/.test(window) && window.includes('bash_output'), {
			channel: 'C',
			expected: 'Full output: <path>; use bash_output {task_id}…',
			actual: /Full output:\s*(\S+)/.exec(window)?.[1] ?? '未匹配',
		})
		// details 齐备（buildNotifyDetails 五字段：taskId/command/durationMs/endReason/exitCode=null）
		let details = null
		try {
			const entry = JSON.parse(firstNotifyLine)
			const msg = entry?.message ?? entry
			details = msg?.details ?? null
		} catch {
			/* 半行写入中：details 断言由下方红暴露 */
		}
		const detailsOk =
			details !== null &&
			typeof details === 'object' &&
			details.taskId === taskId &&
			typeof details.command === 'string' &&
			Number.isFinite(details.durationMs) &&
			details.endReason === 'natural' &&
			details.exitCode === null
		ev.assert('C: 通知 details 齐备（taskId/command/durationMs/endReason=natural/exitCode=null）', detailsOk, {
			channel: 'C',
			expected: '{taskId, command, durationMs, endReason:"natural", exitCode:null}',
			actual: details ? JSON.stringify(details).slice(0, 260) : '通知 entry 无 details 字段',
		})
		ev.attach('notification-window', window)
	}

	// 投递日志：补投受理落盘（delivery-port-outbox 条目，data.id = taskId）
	const outboxLines = outboxEntryLines(rawNotified, taskId)
	ev.assert('C: 投递日志出现该 taskId 的 outbox 条目（补投受理落盘）', outboxLines.length >= 1, {
		channel: 'C',
		expected: `delivery-port-outbox 条目 data.id=${taskId}`,
		actual: `outbox 条目数=${outboxLines.length}`,
	})

	// 唤醒断言（补投 steer 注入唤醒新 run）
	const end2Ok = end2?.type === 'message.complete' && end2.payload?.stopReason !== 'error'
	ev.assert('B: 补投唤醒新 run 并以 message.complete#2 收尾（steer 自动唤醒）', end2Ok, {
		channel: 'B',
		expected: '第二次 message.complete（faux 轮 3 应答）',
		actual: end2
			? `${end2.type} stop=${String(end2.payload?.stopReason)}`
			: notifyLines.length >= 1
				? '有补投注入但未等到新 run 收尾——排查产品唤醒链路'
				: '未等到新 run（无补投即无唤醒）',
	})
	ev.step({ step: 'chat.wait.turn2-notify', channel: 'B', exitCode: end2Ok ? 0 : 1, stats: { stopReason: end2?.payload?.stopReason } })

	// ── 8. 幂等：+8s 静默窗 + 二次对账边沿后计数仍 1 ────────────────
	await new Promise((r) => setTimeout(r, 8_000))
	try {
		await protocol.call('session.getCommands', { sessionId: sid }, { timeoutMs: 30_000 })
	} catch {
		/* 二次边沿触发失败不影响计数断言（+8s 窗口已含 agent_settled 边沿） */
	}
	await pollRawText(sessionFile, () => false, { timeoutMs: 4_000, intervalMs: 1000 }) // 静置 4s 让二次边沿跑完
	const notifyLinesAfter = notifyEntryLines(readRaw(sessionFile))
	ev.assert('C: 通知恰好 1 条（跨边沿幂等：+8s 静默窗 + 二次对账边沿后无第二条）', notifyLinesAfter.length === 1, {
		channel: 'C',
		expected: 'count=1（注入 entry 行口径；跨边沿由送达痕迹判据 + port 幂等吞并双保险）',
		actual: `count=${notifyLinesAfter.length}${notifyLinesAfter.length > 1 ? ` 多余条目：${(NOTIFY_UNKNOWN_RE.exec(notifyLinesAfter[1])?.[0] ?? notifyLinesAfter[1]).slice(0, 200)}` : ''}`,
	})

	// ── 9. UI 取证（通知块可见；环境性缺席登记 uncovered 不判失败——视觉细节归 V6） ──
	if (notifyLinesAfter.length === 1) {
		try {
			const ui = ctx.ui
			await ui.click('css=.session-item', { timeoutMs: 30_000 })
			await ui.expectVisible('css=[data-testid^="turn-"]', { timeoutMs: 30_000 })
			await ui.screenshot('reconcile-notify-pane')
			ev.step({ step: 'ui.notify-pane', channel: 'A', exitCode: 0, stats: { screenshot: 'reconcile-notify-pane.png' } })
		} catch (e) {
			uncovered.push(`GUI pane 渲染取证未完成（UI 通道：${String(e?.message ?? e).slice(0, 160)}）——视觉档位核对归 V6 真机视觉节点，磁盘事实断言不受影响`)
		}
	}

	const coreOk =
		notifyLinesAfter.length === 1 && outboxLines.length >= 1 && Boolean(rejectFirst) && Boolean(rejectRetry) && notifyInWindow.length === 0
	if (!coreOk) {
		uncovered.push('V1 完整链路（rejected→切回对账→补投恰好 1 条→outbox 落盘→幂等）未全绿——补投链回归或驱动窗口时序漂移，按失败处置纪律先归因（扩展日志 + runDir 证据）再重试')
	}
	log(`done sid=${sid} taskId=${taskId} notifyCount=${notifyLinesAfter.length} outbox=${outboxLines.length}`)
	return { uncovered, gotchas }
}
