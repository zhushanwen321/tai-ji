/**
 * p0-userbash-hang-to-background-fullchain —— V6 `!` 命令挂死转后台全链：标记行 +
 * 侧边栏 + 通道复位 + 完成通知（completion-signal-delivery 设计 §4.1 V6 / GL2；
 * 验收项 A7，D0 约定名，2026-11-02 前置组装义务履行入库——同链组装先例
 * p0-userbash-passthrough-equivalence（A6，user bash 驱动形态）与
 * p0-bash-idle-notify-once（V2+N2，通知计数口径，设计 V6 断言面点名同构先例）。
 *
 * 驱动通道：`message.bash` RPC（用户输入框直发 `!` 命令的协议层入口，A6 同款）→
 * runtime bash-dispatcher sendBash → pi bash RPC → emitUserBash → user-bash-interceptor
 * 包装执行（execWrappedUserBash → bin/taiji-fg-wrap）。命令不进 LLM turn；
 * 完成通知（约 90s 自然完成）经 port.deliver steer 注入唤醒新 run——faux 排 1 步应答。
 *
 * 路径（设计 V6 四步）：idleBackgroundSec=30 注入 → 直发 `sleep 90 && echo done` →
 * 30s±5s bashResult 终态到达（output 尾部用户向标记行 + exitCode 未知档）→ ps 哨兵
 * 存活 + 侧边栏条目（list running / output RPC 可达）→ 通道复位探针（新 `!` 命令
 * 立即可发，无「Agent 正在处理」拒收）→ 等约 90s 自然完成 → 完成通知恰好 1 条
 * （exit code unknown 形态）+ 侧边栏条目同步终态。
 *
 * 断言形态（设计 V6：标记行文本 + ps 哨兵 + 侧边栏 testid + JSONL 通知条目计数，
 * 先例 p0-bash-idle-to-background 同构）：GUI testid 由协议层代理承载（同链先例 A6
 * 实测校准同款口径）——侧边栏数据源 = backgroundTask.list RPC 条目（运行态/输出尾部/
 * 终止能力载体），通知计数 = customStart 帧计数 + 会话 JSONL 注入 entry 行计数
 * （排除 delivery-port-outbox 投递日志行）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	findRegistryEntry,
	findSessionFile,
	pollUntil,
	psFind,
	readRegistry,
	writeIdleConfig,
} from './lib/fg-bg-lib.mjs'

/** 空闲转后台阈值（秒）：30s（设计 V6 步骤①口径）。 */
const IDLE_SEC = 30
/** 挂死命令（设计 V6 步骤①原文）：阈值 30s < 90s，转后台后自然完成。 */
const HANG_COMMAND = 'sleep 90 && echo done'
/** 通道复位探针命令（转后台后立即可发断言，输出哨兵即命令文本）。 */
const PROBE_COMMAND = 'echo TAIJI-A7-CHANNEL-OK'
/** 时序通过带：30s±5s（设计 V6）+ 上侧 10s 开销余量（先例 p0-bash-idle-to-background 同款）。 */
const ELAPSED_MIN_MS = (IDLE_SEC - 5) * 1000
const ELAPSED_MAX_MS = (IDLE_SEC + 15) * 1000
/** bashResult 终态等待预算：阈值 + 25s 容差（派发 / 抄送 / wire 开销）。 */
const RESULT_WAIT_MS = (IDLE_SEC + 25) * 1000
/** 完成通知等待预算：转后台确认后任务剩余约 60s + 守望 2s 轮询 + steer 注入/run 开销。 */
const NOTIFY_WAIT_MS = 90_000
/** 用户向标记行（user-bash-interceptor.ts USER_MARKER_NOTE 原文——转后台登记成功后
 * onData 补发进 output 尾部；文案漂移即断言红，属产品契约锚）。 */
const USER_MARKER =
	'[TAIJI-FG-BG] 已转后台：命令仍在运行、尚未完成（暂无退出码）。可在侧边栏「后台任务」中查看输出或停止；完成后会在对话流通知。'
/** wrapper 模型向标记行特征（taiji-fg-wrap 三方协议——经抄送流先到，含工具语法）。 */
const MODEL_MARKER_ANCHOR = 'Command moved to background after'
/** 完成通知「结果未知」形态头行（notify.ts buildNotificationContent：natural + 无退出码；
 * 转后台任务退出码结构性不可得——命令 reparent 到 init、无父权 wait）。 */
const NOTIFY_UNKNOWN_RE = /\[background-bash\][^\n]*finished \(exit code unknown[^\n]*\)/
/** 投递端口 outbox 日志条目的 customType（先例 p0-bash-idle-notify-once 同款排除口径：
 * 每条通知在会话 JSONL 结构性落两行——outbox 日志行 + 注入 custom entry，日志行不计数）。 */
const OUTBOX_CUSTOM_TYPE = 'delivery-port-outbox'

export const meta = {
	id: 'p0-userbash-hang-to-background-fullchain',
	priority: 'P0',
	title: 'V6：`!` 命令挂死转后台全链（用户向标记行 + 未知档 + 侧边栏条目 + 通道复位 + 完成通知恰 1 条）',
	covers: ['session.create', 'chat.bash'],
	requires: ['faux'],
	estimateSec: 420,
	faux: {
		responses: [
			// 完成通知 steer 注入唤醒的新 run 应答（缺这步该轮以 faux 耗尽 error 收尾——
			// 通知条目本身已进对话流，但收尾失态；先例 p0-bash-idle-notify-once 轮 4 同款）
			{ text: 'A7-NOTIFY-ACK', stopReason: 'stop' },
		],
	},
	provable: [
		'C：装配自检——idleBackgroundSec=30 写入扩展配置通道并读回核验',
		'B：直发挂命令后 message.bash 回执 settled（转后台后 RPC 返回，非前台等待 90s）',
		'B：bashResult 终态在 30s±5s（+上侧开销余量）内到达（bashStart→bashResult 时序带 25–45s）',
		'C：output 尾部 = 用户向标记行（已转后台/尚未完成/侧边栏可查可停/完成后通知四要素，且不含 bash_output/bash_kill 工具语法）',
		'C：output 含 wrapper 模型向标记行（Command moved to background + Full log——抄送链在场）',
		'C：exit code 未知档——bashResult exitCode=null 且 cancelled=false（AS11：resolve({exitCode:null}) 官方组装呈现）',
		'C：ps 可见命令进程仍活（bash cmd.sh 行 + sleep 90 精确行，转后台不杀不重启）',
		'C：registry 出现 running 登记条目（command 含挂命令原文）',
		'B：backgroundTask.list（侧边栏数据源）含 running 条目；backgroundTask.output RPC 可达（输出尾部通道）',
		'B：通道复位——bashResult 终态后新 `!` 命令立即可发：探针回执 settled、窗口内无 send.rejected「Agent 正在处理」帧、探针 bashResult exitCode=0 含哨兵',
		'C：约 90s 完成通知进对话流恰好 1 条（customStart 帧 background-bash 计数，+8s 静默窗复查不增）',
		'C：通知为「结果未知」形态（finished (exit code unknown, 耗时) + Last lines 含 done + Full output 路径）',
		'C：会话 JSONL 注入 entry 行计数恰好 1（排除 outbox 日志行；文件存在时核对）',
		'C：侧边栏条目同步终态——registry 与 backgroundTask.list 条目转 exited，backgroundTask.output 含 done',
	],
	notProvable: [
		'bash 气泡「结果未知」档的视觉渲染档位与侧边栏「终止按钮」的可点击性：协议层无 UI 帧——以 exitCode=null/cancelled=false 帧字段与 backgroundTask.list running 条目（终止按钮的数据源前提）作协议层代理；GUI 渲染归 UI 剧本',
		'用户在输入框键入 `!` 前缀的解析层：本剧本经 message.bash RPC（输入框直发的协议层入口）驱动，键入解析归 UI',
		'侧边栏终止按钮点击后的整组终止链（V7 断言面）：本场景任务须自然完成以兑现「exit code unknown 完成通知」，不可中途 kill——终止链由 V7 场景承载',
		'完成通知到达时刻与任务完成时刻的精确差（守望间隔 2s + 注入开销属时序容差，本剧本只断到达与恰好一条）',
	],
}

/** 注入通知 entry 行清单（先例 p0-bash-idle-notify-once notifyEntryLines 同款）：
 * 排除 customType=delivery-port-outbox 的投递日志行，按通知头行形态匹配——每条通知
 * 恰一行（注入 entry），计数 = 行数。半行（写入中）跳过，下一轮询再试。 */
function notifyEntryLines(raw) {
	return String(raw ?? '').split('\n').filter((line) => {
		if (!line.includes('[background-bash]')) return false
		try {
			return JSON.parse(line)?.customType !== OUTBOX_CUSTOM_TYPE && NOTIFY_UNKNOWN_RE.test(line)
		} catch {
			return false
		}
	})
}

/** 会话 JSONL 原文（文件不存在 / 读失败 = 空串）。 */
function readRaw(sessionFile) {
	try {
		return sessionFile && fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8') : ''
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
		'idleBackgroundSec 注入通道 = <dataDir>/agent/config/base-tool-enhance-ext-config.json（热重载，execute 读时生效）——不是 settings.json；launch 后写即生效',
		'output 含两处 [TAIJI-FG-BG] 行：wrapper 模型向标记行（三方协议，含 bash_output/bash_kill 工具语法，抄送流先到）+ interceptor 用户向标记行（onData 补发，output 尾部）——设计「不含工具语法」约束的是用户向标记行本体，整段 output 必含工具语法（模型向在场是抄送链断言）',
		'完成通知计数口径 = customStart 帧计数（协议流权威）+ JSONL 注入 entry 行计数（文件存在时核对，排除 delivery-port-outbox 投递日志行）——先例 p0-bash-idle-notify-once：按原文头行计数会每条双计（outbox 日志行 payload 携带完整通知文本）',
		'ps 哨兵唯一性：`sleep 90` 是通用串，进程存活断言以 bash cmd.sh 行（ext-sessions/<sid>/ 路径全局唯一）为主锚、sleep 90 精确行（command 全等）为辅锚；兜底清理同样只杀这两类',
		'通知 steer 注入唤醒新 run 消耗 1 个 faux step——responses 已排 A7-NOTIFY-ACK 应答步；耗尽则该轮 error 收尾（通知条目仍进对话流，但唤醒链失态）',
	]
	/** 哨兵兜底清理（红灯路径残留）：只杀本会话 cmd.sh 行与 sleep 90 精确行——
	 * 正常完成路径进程已退出，kill 为 no-op（先例 p0-bash-idle-to-background finally 同款）。 */
	const sidRef = { value: null }
	const cleanupSentinel = () => {
		if (!sidRef.value) return []
		const anchor = `ext-sessions/${sidRef.value}/background-tasks/`
		const targets = [...psFind(anchor), ...psFind('sleep 90').filter((p) => p.command.trim() === 'sleep 90')]
		const killed = []
		for (const p of targets) {
			try {
				process.kill(p.pid, 'SIGKILL')
				killed.push(p.pid)
			} catch {
				/* 已退出：跳过 */
			}
		}
		return killed
	}

	try {
		// ── 1. 注入空闲阈值配置（热重载，先于 session 创建） ─────────────────
		const cfgPath = writeIdleConfig(dataDir, { idleBackgroundSec: IDLE_SEC })
		ev.step({ step: 'config.idle-inject', command: `write ${cfgPath}`, exitCode: 0, stats: { idleBackgroundSec: IDLE_SEC } })
		ev.assert('C: 装配自检——idleBackgroundSec=30 写入扩展配置通道', cfgPath.endsWith('base-tool-enhance-ext-config.json'), {
			channel: 'C',
			expected: '<dataDir>/agent/config/base-tool-enhance-ext-config.json',
			actual: cfgPath,
		})

		// ── 2. 建会话（临时 cwd，不污染 repo） ──────────────────────────────
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-userbash-a7-'))
		const created = await protocol.call('session.create', { cwd, label: 'p0-userbash-a7' }, { timeoutMs: 120_000 })
		const sid = created.session?.id
		sidRef.value = sid
		ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
			channel: 'B',
			expected: 'session.id 非空',
			actual: JSON.stringify(created.session ?? {}).slice(0, 200),
		})
		if (!sid) throw new Error('session.create 未返回 sessionId')
		await protocol.subscribe(sid)
		log(`session=${sid} cwd=${cwd}`)

		// 会话 JSONL 定位：通知注入的 custom entry 构成 conversation（文件应落盘）；
		// 先例 A6 实测口径——纯 bash 会话不落盘，文件缺席时帧计数为权威、JSONL 降级登记
		let sessionFile = created.session?.sessionFile ?? findSessionFile(dataDir, sid)
		ev.step({ step: 'evidence.session-file', command: `locate ${sid}`, exitCode: 0, stats: { sessionFile: sessionFile ?? '暂未落盘（通知注入后补定位）' } })

		// ── 3. 驱动：直发挂命令（`!sleep 90 && echo done`） ─────────────────
		const since = protocol.events.length
		const tSend = Date.now()
		const callPromise = protocol.call('message.bash', { sessionId: sid, command: HANG_COMMAND }, { replyType: 'message.status', timeoutMs: 180_000 })
		let startEvt = null
		try {
			startEvt = await protocol.waitFor((e) => e.type === 'message.bashStart' && e.payload?.command === HANG_COMMAND, { since, timeoutMs: 60_000, sessionId: sid })
		} catch {
			/* bashStart 缺席由下方断言承载 */
		}
		ev.assert('B: 挂命令执行开始广播（message.bashStart）', Boolean(startEvt), {
			channel: 'B',
			expected: 'bashStart 帧（command=sleep 90 && echo done）',
			actual: startEvt ? `at=${new Date(startEvt.receivedAt).toISOString()}` : '60s 内未观察到',
		})
		if (!startEvt) throw new Error('bashStart 未到达（message.bash 未被受理）')
		const startAt = startEvt.receivedAt

		// ── 4. 等 bashResult 终态（转后台解除阻塞；时序带 25–45s） ──────────
		let resultEvt = null
		try {
			resultEvt = await protocol.waitFor((e) => e.type === 'message.bashResult' && e.payload?.command === HANG_COMMAND, { since, timeoutMs: RESULT_WAIT_MS, sessionId: sid })
		} catch {
			/* 超时红由断言承载 */
		}
		const elapsedMs = resultEvt ? resultEvt.receivedAt - startAt : null
		ev.assert(`B: bashResult 终态在 ${IDLE_SEC}s±5s（+开销余量）内到达（${ELAPSED_MIN_MS / 1000}–${ELAPSED_MAX_MS / 1000}s 通过带）`, elapsedMs !== null && elapsedMs >= ELAPSED_MIN_MS && elapsedMs <= ELAPSED_MAX_MS, {
			channel: 'B',
			expected: `${ELAPSED_MIN_MS}–${ELAPSED_MAX_MS} ms（30s±5s + 上侧 10s 开销余量）`,
			actual: elapsedMs === null ? `${RESULT_WAIT_MS / 1000}s 内未返回（转后台机制缺席：前台等满 90s 或更久）` : `${elapsedMs} ms（send→start=${startAt - tSend}ms）`,
		})
		const frame = resultEvt?.payload ?? null
		const reply = await callPromise
		ev.assert('B: message.bash 回执 settled（转后台后 RPC 返回）', reply?.status === 'settled', {
			channel: 'B',
			expected: 'message.status settled（rejected=busy 拒收 / started=未收尾）',
			actual: reply ? `status=${reply.status}${reply.error ? ` error=${String(reply.error).slice(0, 120)}` : ''}` : '回执未达',
		})

		// ── 5. output 尾部用户向标记行（四要素 + 无工具语法） ───────────────
		const output = String(frame?.output ?? '')
		const lastLine = output.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0).pop() ?? ''
		ev.assert('C: output 尾部 = 用户向标记行（转后台去向说明，onData 补发恒在尾行）', lastLine === USER_MARKER, {
			channel: 'C',
			expected: USER_MARKER,
			actual: lastLine || '（output 为空）',
		})
		ev.assert('C: 用户向标记行四要素（已转后台/尚未完成/侧边栏可查可停/完成后会通知）', lastLine.includes('已转后台') && lastLine.includes('尚未完成') && lastLine.includes('侧边栏') && lastLine.includes('查看输出或停止') && lastLine.includes('完成后会在对话流通知'), {
			channel: 'C',
			expected: '已转后台 ∧ 尚未完成 ∧ 侧边栏可查可停 ∧ 完成后会通知',
			actual: lastLine.slice(0, 200),
		})
		ev.assert('C: 用户向标记行不含 bash_output/bash_kill 工具语法（用户没有工具，指引指向侧边栏）', !lastLine.includes('bash_output') && !lastLine.includes('bash_kill'), {
			channel: 'C',
			expected: '标记行无 bash_output / bash_kill 字样',
			actual: `bash_output=${lastLine.includes('bash_output')} bash_kill=${lastLine.includes('bash_kill')}`,
		})
		ev.assert('C: output 含 wrapper 模型向标记行（Command moved to background + Full log——抄送链在场）', output.includes(MODEL_MARKER_ANCHOR) && /Full log:\s*\S+/.test(output), {
			channel: 'C',
			expected: '[TAIJI-FG-BG] Command moved to background after … Full log: <path>',
			actual: output.split('\n').find((l) => l.includes(MODEL_MARKER_ANCHOR))?.slice(0, 220) ?? '未出现（wrapper 标记行未进抄送流）',
		})
		if (frame) ev.attach('converted-bash-frame', JSON.stringify(frame, null, 2).slice(0, 4000))

		// ── 6. exit code 未知档（exitCode null + 非取消） ───────────────────
		ev.assert('C: exit code 未知档——bashResult exitCode=null 且 cancelled=false（AS11）', frame !== null && frame.exitCode === null && frame.cancelled === false, {
			channel: 'C',
			expected: 'exitCode=null ∧ cancelled=false（协议帧形态；组装层 exitCode undefined 的 JSON 载体）',
			actual: frame ? `exitCode=${JSON.stringify(frame.exitCode)} cancelled=${frame.cancelled} truncated=${frame.truncated}` : 'bashResult 帧缺席',
		})

		// ── 7. ps 哨兵：命令进程仍活（转后台不杀不重启） ────────────────────
		const bashCmdAnchor = `ext-sessions/${sid}/background-tasks/`
		const bashCmdProcs = psFind(bashCmdAnchor)
		ev.assert('C: ps 可见命令进程仍活（bash cmd.sh 行，ext-sessions/<sid> 路径主锚）', bashCmdProcs.length > 0, {
			channel: 'C',
			expected: `ps 含 bash <dataDir>/${bashCmdAnchor}<taskId>.sh`,
			actual: bashCmdProcs.length > 0 ? bashCmdProcs.map((p) => `pid=${p.pid} ${p.command.trim().slice(0, 160)}`).join(' | ') : '不可见（未转后台或进程死亡）',
		})
		const sleepProcs = psFind('sleep 90').filter((p) => p.command.trim() === 'sleep 90')
		ev.assert('C: ps 可见 sleep 90 进程仍活（精确行辅锚）', sleepProcs.length > 0, {
			channel: 'C',
			expected: 'ps 行 command 全等 "sleep 90"',
			actual: sleepProcs.length > 0 ? sleepProcs.map((p) => `pid=${p.pid}(pgid=${p.pgid})`).join(',') : '不可见',
		})
		if (bashCmdProcs.length > 0 || sleepProcs.length > 0) {
			ev.attach('post-conversion-ps', JSON.stringify({ bashCmd: bashCmdProcs, sleep: sleepProcs }, null, 2))
		}

		// ── 8. 登记与侧边栏数据源（运行态条目 + 输出尾部通道） ──────────────
		const registryEntry = await pollUntil(() => findRegistryEntry(readRegistry(dataDir, sid), HANG_COMMAND), { timeoutMs: 20_000 })
		ev.assert('C: registry 出现转后台登记条目（running，command 含挂命令原文）', registryEntry?.state === 'running', {
			channel: 'C',
			expected: `{command 含 "${HANG_COMMAND}", state:'running'}`,
			actual: registryEntry ? JSON.stringify({ state: registryEntry.state, taskId: registryEntry.taskId, pid: registryEntry.pid }).slice(0, 300) : '20s 内未出现登记条目',
		})
		let listReply = null
		try {
			listReply = await protocol.call('backgroundTask.list', { sessionId: sid }, { replyType: 'backgroundTask.tasks', timeoutMs: 30_000 })
		} catch (e) {
			ev.attach('bgt-list-miss', String(e?.message ?? e).slice(0, 400))
		}
		const listEntry = (listReply?.tasks ?? []).find((t) => String(t.command ?? '').includes(HANG_COMMAND))
		ev.assert('B: backgroundTask.list 含 running 条目（侧边栏数据源：运行态条目在场）', listEntry?.state === 'running', {
			channel: 'B',
			expected: 'tasks[] 含挂命令条目 state=running（终止按钮的数据源前提）',
			actual: listReply ? `tasks=${(listReply.tasks ?? []).length} match=${JSON.stringify(listEntry ? { state: listEntry.state, taskId: listEntry.taskId } : null).slice(0, 200)}` : 'RPC 未达',
		})
		let outReply = null
		const listTaskId = listEntry?.taskId ?? registryEntry?.taskId ?? null
		if (listTaskId) {
			try {
				outReply = await protocol.call('backgroundTask.output', { sessionId: sid, taskId: listTaskId }, { replyType: 'backgroundTask.outputResult', timeoutMs: 30_000 })
			} catch (e) {
				ev.attach('bgt-output-miss', String(e?.message ?? e).slice(0, 400))
			}
		}
		ev.assert('B: backgroundTask.output RPC 可达（侧边栏输出尾部通道，运行态 sleep 静默允许空文本）', outReply !== null && typeof outReply.text === 'string', {
			channel: 'B',
			expected: 'outputResult {text, lost} 形态（text 可为空串——sleep 静默期）',
			actual: outReply ? `text=${JSON.stringify(String(outReply.text ?? '').slice(0, 120))} lost=${outReply.lost}` : 'RPC 未发起（无 taskId）或未达',
		})
		ev.step({ step: 'sidebar.running-check', command: 'backgroundTask.list + output', exitCode: listEntry?.state === 'running' && outReply !== null ? 0 : 1, stats: { taskId: listTaskId, state: listEntry?.state ?? registryEntry?.state } })

		// ── 9. 通道复位：新 `!` 命令立即可发（bashResult 终态、任务仍在跑） ──
		const sinceProbe = protocol.events.length
		const probeCall = protocol.call('message.bash', { sessionId: sid, command: PROBE_COMMAND }, { replyType: 'message.status', timeoutMs: 60_000 })
		let probeFrame = null
		try {
			probeFrame = await protocol.waitFor((e) => e.type === 'message.bashResult' && e.payload?.command === PROBE_COMMAND, { since: sinceProbe, timeoutMs: 60_000, sessionId: sid })
		} catch {
			/* 超时红由断言承载 */
		}
		const probeReply = await probeCall
		const rejectedFrames = protocol.events.slice(sinceProbe).filter((e) => e.type === 'send.rejected' && e.payload?.reason === 'busy')
		ev.assert('B: 通道复位——探针 `!` 命令立即可发（回执 settled，非 rejected 拒收）', probeReply?.status === 'settled', {
			channel: 'B',
			expected: 'message.status settled（bash 通道占用已随转后台复位）',
			actual: `status=${probeReply?.status ?? 'no-reply'}${probeReply?.error ? ` error=${String(probeReply.error).slice(0, 120)}` : ''}`,
		})
		ev.assert('B: 探针窗口无「Agent 正在处理」拒收帧（send.rejected busy 计数=0）', rejectedFrames.length === 0, {
			channel: 'B',
			expected: 'count=0',
			actual: `count=${rejectedFrames.length}${rejectedFrames.length > 0 ? `：${JSON.stringify(rejectedFrames[0].payload).slice(0, 160)}` : ''}`,
		})
		ev.assert('B: 探针真实执行（bashResult exitCode=0 且 output 含哨兵）', probeFrame !== null && probeFrame.payload?.exitCode === 0 && String(probeFrame.payload?.output ?? '').includes('TAIJI-A7-CHANNEL-OK'), {
			channel: 'B',
			expected: 'bashResult exitCode=0 output 含 TAIJI-A7-CHANNEL-OK',
			actual: probeFrame ? `exitCode=${JSON.stringify(probeFrame.payload?.exitCode)} output=${JSON.stringify(String(probeFrame.payload?.output ?? '').slice(0, 120))}` : 'bashResult 帧未达',
		})
		const stillAlive = psFind(bashCmdAnchor).length > 0 || psFind('sleep 90').some((p) => p.command.trim() === 'sleep 90')
		ev.assert('C: 探针发出时挂命令仍在跑（转后台任务不受探针影响）', stillAlive, {
			channel: 'C',
			expected: 'ps 仍见 cmd.sh / sleep 90',
			actual: stillAlive ? '进程在场' : '进程已消失（任务提前结束或被误杀）',
		})

		// ── 10. 等任务自然完成（约 90s）：完成通知进对话流恰好 1 条 ─────────
		// 帧等待与 JSONL 文件轮询并发（先例竞态教训：唤醒 run 的 faux 轮实测数百毫秒，
		// 串行游标取帧会结构性漏检）；本场景断言面只锚通知到达与计数，唤醒 run 收尾不断言。
		const notifyPoll = pollRawText(sessionFile, (raw) => notifyEntryLines(raw).length >= 1, { timeoutMs: NOTIFY_WAIT_MS, intervalMs: 500 })
		let notifyFrame = null
		try {
			notifyFrame = await protocol.waitFor((e) => e.type === 'message.customStart' && e.payload?.customType === 'background-bash' && e.receivedAt > tSend, { sessionId: sid, timeoutMs: NOTIFY_WAIT_MS })
		} catch (e) {
			ev.attach('notify-frame-miss', String(e?.message ?? e).slice(0, 600))
		}
		const rawNotified = await notifyPoll
		if (!sessionFile || !fs.existsSync(sessionFile)) sessionFile = findSessionFile(dataDir, sid)
		const rawFinal = sessionFile && fs.existsSync(sessionFile) ? readRaw(sessionFile) : rawNotified
		const notifyLines = notifyEntryLines(rawFinal)
		const firstNotifyLine = notifyLines[0] ?? null
		const firstHead = firstNotifyLine ? (NOTIFY_UNKNOWN_RE.exec(firstNotifyLine)?.[0] ?? null) : null
		ev.assert('C: 完成通知帧到达（message.customStart customType=background-bash）', notifyFrame !== null, {
			channel: 'C',
			expected: 'customStart 帧（任务完成 ≈ startAt+90s + 守望 2s + steer 注入）',
			actual: notifyFrame ? `at=${new Date(notifyFrame.receivedAt).toISOString()}（sleep 启动→通知 +${((notifyFrame.receivedAt - startAt) / 1000).toFixed(1)}s）` : `${NOTIFY_WAIT_MS / 1000}s 内未达（转后台或通知链缺席）`,
		})
		ev.assert('C: 通知为「结果未知」形态（finished (exit code unknown, 耗时)）——转后台任务退出码结构性不可得', Boolean(firstHead), {
			channel: 'C',
			expected: '[background-bash] bt-… finished (exit code unknown, …): sleep 90 && echo done',
			actual: firstHead ?? (notifyLines.length > 0 ? notifyLines[0].slice(0, 240) : '无通知行'),
		})
		if (firstNotifyLine) {
			const headIdx = firstNotifyLine.indexOf(firstHead)
			const window = firstNotifyLine.slice(headIdx, headIdx + 1200)
			ev.assert('C: 通知含 Last lines 输出尾部（done）', window.includes('Last lines:') && window.includes('done'), {
				channel: 'C',
				expected: 'Last lines: …done…（echo done 的输出尾部）',
				actual: window.split('\\n').slice(0, 4).join(' | ').slice(0, 400),
			})
			ev.assert('C: 通知含 Full output 路径', /Full output:\s*\S+/.test(window), {
				channel: 'C',
				expected: 'Full output: <background-tasks>/<taskId>.log',
				actual: /Full output:\s*(\S+)/.exec(window)?.[1] ?? '未匹配',
			})
			ev.attach('notification-window', window)
		}

		// ── 11. 侧边栏条目同步终态 ──────────────────────────────────────────
		const terminalRegistry = await pollUntil(() => {
			const e = findRegistryEntry(readRegistry(dataDir, sid), HANG_COMMAND)
			return e && e.state === 'exited' ? e : undefined
		}, { timeoutMs: 30_000 })
		ev.assert('C: registry 条目转终态 exited（自然完成）', Boolean(terminalRegistry), {
			channel: 'C',
			expected: "state='exited'（reason=natural，exitCode null——退出码结构性不可得）",
			actual: terminalRegistry ? JSON.stringify({ state: terminalRegistry.state, reason: terminalRegistry.reason, exitCode: terminalRegistry.exitCode ?? null }).slice(0, 240) : '30s 内未观察到终态',
		})
		const terminalList = await pollUntil(async () => {
			try {
				const r = await protocol.call('backgroundTask.list', { sessionId: sid }, { replyType: 'backgroundTask.tasks', timeoutMs: 30_000 })
				return (r?.tasks ?? []).find((t) => String(t.command ?? '').includes(HANG_COMMAND) && t.state === 'exited')
			} catch {
				return undefined
			}
		}, { timeoutMs: 30_000, intervalMs: 1000 })
		ev.assert('B: backgroundTask.list 条目同步终态 exited（侧边栏数据源）', Boolean(terminalList), {
			channel: 'B',
			expected: 'tasks[] 挂命令条目 state=exited',
			actual: terminalList ? `taskId=${terminalList.taskId} state=${terminalList.state}` : '30s 内未观察到终态条目',
		})
		let finalOut = null
		const finalTaskId = terminalList?.taskId ?? terminalRegistry?.taskId ?? listTaskId
		if (finalTaskId) {
			try {
				finalOut = await protocol.call('backgroundTask.output', { sessionId: sid, taskId: finalTaskId }, { replyType: 'backgroundTask.outputResult', timeoutMs: 30_000 })
			} catch (e) {
				ev.attach('bgt-final-output-miss', String(e?.message ?? e).slice(0, 400))
			}
		}
		ev.assert('C: 终态后 backgroundTask.output 含 done（echo done 输出已落任务日志）', finalOut !== null && String(finalOut.text ?? '').includes('done'), {
			channel: 'C',
			expected: 'output text 含 done',
			actual: finalOut ? JSON.stringify(String(finalOut.text ?? '').slice(-160)) : 'RPC 未发起（无 taskId）或未达',
		})

		// ── 12. N2 同款负面：+8s 静默窗后通知计数仍恰好 1 ───────────────────
		await new Promise((r) => setTimeout(r, 8_000))
		const frameCount = protocol.events.filter((e) => e.type === 'message.customStart' && e.payload?.customType === 'background-bash').length
		ev.assert('C: 完成通知恰好 1 条（customStart 帧计数，+8s 静默窗复查不增）', frameCount === 1, {
			channel: 'C',
			expected: 'count=1（taskId 幂等）',
			actual: `count=${frameCount}`,
		})
		const jsonlCount = notifyEntryLines(rawFinal).length
		const jsonlExists = Boolean(sessionFile && fs.existsSync(sessionFile))
		ev.step({ step: 'evidence.session-file-final', command: `locate ${sid}`, exitCode: jsonlExists ? 0 : 1, stats: { sessionFile: sessionFile ?? '未落盘', notifyLines: jsonlCount } })
		ev.assert('C: 会话 JSONL 注入 entry 行计数恰好 1（排除 outbox 日志行；文件存在时核对）', !jsonlExists || jsonlCount === 1, {
			channel: 'C',
			expected: jsonlExists ? 'count=1' : '会话文件未落盘（帧计数为权威，登记形态不算红）',
			actual: jsonlExists ? `count=${jsonlCount}（sessionFile=${sessionFile}）` : 'JSONL 未落盘（通知以协议帧承载）',
		})

		// ── 13. 红灯登记：核心链任一环缺席时如实 uncovered（不静默降级） ────
		if (elapsedMs === null || lastLine !== USER_MARKER || frameCount !== 1) {
			uncovered.push('V6 全链（转后台标记行/未知档/通道复位/完成通知恰 1 条）存在红灯断言——按失败归因处置（docs/TROUBLESHOOTING.md），不在本剧本内放宽')
		}
		log(`done sid=${sid} elapsed=${elapsedMs}ms notifyFrames=${frameCount} notifyLines=${jsonlCount}`)
		return { uncovered, gotchas }
	} finally {
		const killed = cleanupSentinel()
		if (killed.length > 0) {
			ev.step({ step: 'cleanup.sentinel', command: 'kill cmd.sh + sleep 90', exitCode: 0, stats: { pids: killed } })
			log(`哨兵兜底清理 killed=${JSON.stringify(killed)}`)
		}
	}
}
