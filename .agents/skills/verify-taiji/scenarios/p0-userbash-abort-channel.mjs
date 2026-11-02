/**
 * p0-userbash-abort-channel —— V7 `!` 命令转后台前的用户中止：abort 通道保持
 * （completion-signal-delivery 设计 §4.1 V7 / §4.2 RL5；验收项 A8，D0 约定名，
 * 2026-11-02 前置组装义务履行入库——同链组装先例 p0-userbash-hang-to-background-fullchain
 * （A7，user bash 驱动形态）与 p0-bash-abort-process-group（chat 域中止同族，进程组断言口径）。
 *
 * 驱动通道：`message.bash` RPC（用户输入框直发 `!` 命令的协议层入口，A7 同款）→
 * runtime bash-dispatcher sendBash → pi bash RPC → emitUserBash → user-bash-interceptor
 * 包装执行（execWrappedUserBash → bin/taiji-fg-wrap）。命令不进 LLM turn；
 * 中止经 `message.abortBash` RPC——UI 停止按钮在 bash 执行中的协议通道
 * （renderer chatApi.abortBash → core transport chat 域 abortBash → message.abortBash；
 * 与 turn abort 的 message.abort 不同通道，bash 执行期间 turn 未开）。
 *
 * 路径（设计 V7 两步）：直发 `sleep 300`（持续无输出但未到阈值——不注入 idleBackgroundSec，
 * 缺省 600s，中止发生在阈值前执行窗口内，阈值取值与本剧本无关）→ 执行窗口内 ps 观察
 * wrapper 进程组在场（taiji-fg-wrap + 本会话 background-tasks cmd.sh 行 + sleep 300）→
 * 等 5s → message.abortBash → 回执 status=aborted + bashResult cancelled=true（官方式中止
 * 形态）+ message.bash 回执 settled（已执行已收尾——abort 抢先收尾竞态路径）→ ps 进程组
 * 整组消失（RL5：signal → 杀 wrapper 进程组 → 无 sleep/wrapper/cmd.sh 残留）→ registry
 * 无登记条目（中止在转后台之前）→ 通道复位探针：新 `!` 命令立即可发（settled、无
 * 「Agent 正在处理」拒收、exitCode=0 含哨兵）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	findRegistryEntry,
	killByPattern,
	pollUntil,
	psFind,
	readRegistry,
} from './lib/fg-bg-lib.mjs'

/** 挂住命令（设计 V7 步骤①原文 `!sleep 300`；协议层 message.bash 收裸命令）。
 * 300s 持续无输出、远小于缺省阈值 600s——中止发生在转后台判定之前。 */
const HANG_COMMAND = 'sleep 300'
/** 通道复位探针命令（中止后立即可发断言，输出哨兵即命令文本）。 */
const PROBE_COMMAND = 'echo TAIJI-A8-CHANNEL-OK'
/** 设计 V7 步骤②口径：直发后 5s 点停止按钮。 */
const STOP_DELAY_MS = 5_000
/** wrapper 脚本进程名（设计 §5 部件 1：bin/taiji-fg-wrap）。 */
const WRAPPER_NAME = 'taiji-fg-wrap'

export const meta = {
	id: 'p0-userbash-abort-channel',
	priority: 'P0',
	title: 'V7：`!` 命令转后台前的用户中止——abort 通道保持（进程组整组被杀 + cancelled 收尾 + 回执 settled + 无登记 + 通道复位）',
	covers: ['session.create', 'chat.bash'],
	requires: ['faux'],
	estimateSec: 120,
	faux: {
		// 全程无 LLM turn：user bash 不进 turn（A7 同款），abort/探针均不触发 run
		responses: [],
	},
	provable: [
		'C：执行窗口内 wrapper 进程组在场（ps：taiji-fg-wrap + 本会话 background-tasks cmd.sh 行 + sleep 300 精确行——A5 包装格生效证据）',
		'B：message.abortBash（停止按钮的协议通道）回执 status=aborted',
		'C：bash 气泡官方式中止形态——bashResult cancelled=true',
		'B：message.bash 回执 settled（已执行已收尾——abort 抢先收尾路径，非 rejected / 非挂起）',
		'C：wrapper 进程组整组被杀（ps 无 sleep 300、无本会话 wrapper / cmd.sh 残留，RL5）',
		'C：无登记条目（registry 无本命令条目——中止发生在转后台之前）',
		'B：通道复位——后续 `!` 命令立即可发（探针回执 settled、窗口无 send.rejected「Agent 正在处理」帧、bashResult exitCode=0 含哨兵）',
	],
	notProvable: [
		'渲染层停止按钮的 DOM 形态与 bash 气泡 cancelled 档位的视觉渲染：协议层无 UI 帧——以 message.abortBash 回执与 bashResult cancelled=true 帧字段作协议层代理（与 chat.abort 域先例同款口径；GUI 归 UI 剧本）',
		'用户在输入框键入 `!` 前缀的解析层：本剧本经 message.bash RPC（输入框直发的协议层入口）驱动，键入解析归 UI',
		'中止时序与空闲阈值的竞争窗口（静默将满时恰好退出的串行判定属单测覆盖；本剧本 5s ≪ 600s 缺省阈值，无竞争面）',
	],
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'停止按钮的协议通道 = message.abortBash（bash 执行中 turn 未开，不走 message.abort turn 通道）——abortBash 回执 aborted / 未发送时 error envelope（「不得谎报 aborted」契约）',
		'「回执 settled」的机制 = abort 抢先收尾：abortBash 旋转 bashRunToken 并先行广播收尾，sendBash await 返回后检测到被抢先 → 不再重复广播、回执 settled（bash-dispatcher「已执行已收尾 → settled」竞态路径）',
		'不注入 idleBackgroundSec：缺省 600s（p0-bash-abort-process-group 同款口径），中止发生在阈值前执行窗口内，阈值取值与本剧本无关',
		'ps 哨兵唯一性：sleep 300 是通用串，进程断言以本会话 ext-sessions/<sid>/background-tasks/ 路径锚为主锚（wrapper --log/-- 与 cmd.sh 路径同目录、均含该锚）、sleep 300 精确行（command 全等）为辅锚；兜底清理同样只杀这两类',
		'cmd.sh 在前台窗口即写入 background-tasks 目录（prepareForegroundWrap 与转后台登记共用同一目录）——前台 ps 可见 bash cmd.sh 行是包装格形态，不是已转后台证据；已转后台证据是 registry 登记条目（本剧本断言其缺席）',
	]
	/** 哨兵兜底清理（红灯路径残留）：只杀本会话 background-tasks 锚行与 sleep 300 精确行。 */
	const sidRef = { value: null }
	const cleanupSentinel = () => {
		if (!sidRef.value) return []
		const anchor = `ext-sessions/${sidRef.value}/background-tasks/`
		const targets = [...psFind(anchor), ...psFind(HANG_COMMAND).filter((p) => p.command.trim() === HANG_COMMAND)]
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
		// ── 1. 建会话（无 idle 配置注入：缺省阈值下验证缺省包装格执行窗口） ──
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-userbash-a8-'))
		const created = await protocol.call('session.create', { cwd, label: 'p0-userbash-a8' }, { timeoutMs: 120_000 })
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

		// ── 2. 驱动：直发 `!sleep 300`（持续无输出、未到缺省阈值 600s） ──────
		const since = protocol.events.length
		const callPromise = protocol.call('message.bash', { sessionId: sid, command: HANG_COMMAND }, { replyType: 'message.status', timeoutMs: 90_000 })
		let startEvt = null
		try {
			startEvt = await protocol.waitFor((e) => e.type === 'message.bashStart' && e.payload?.command === HANG_COMMAND, { since, timeoutMs: 60_000, sessionId: sid })
		} catch {
			/* bashStart 缺席由下方断言承载 */
		}
		ev.assert('B: 挂命令执行开始广播（message.bashStart）', Boolean(startEvt), {
			channel: 'B',
			expected: `bashStart 帧（command=${HANG_COMMAND}）`,
			actual: startEvt ? `at=${new Date(startEvt.receivedAt).toISOString()}` : '60s 内未观察到',
		})
		if (!startEvt) throw new Error('bashStart 未到达（message.bash 未被受理）')

		// ── 3. 执行窗口内 ps 观察 wrapper 进程组（A5 包装格生效证据） ────────
		// 谓词判 .length 再返回非空数组或 null（pollUntil 以 truthy 判命中；裸空数组
		// 也是 truthy 会首轮即返回——p0-bash-abort-process-group 同款教训注释）。
		const groupSeen = await pollUntil(
			() => {
				const hits = psFind(`ext-sessions/${sid}/background-tasks/`)
				return hits.length > 0 ? hits : null
			},
			{ timeoutMs: 15_000, intervalMs: 300 },
		)
		const groupLines = groupSeen ?? []
		ev.assert('C: 执行窗口内本会话 wrapper/cmd.sh 进程在场（background-tasks 路径锚）', groupLines.length > 0, {
			channel: 'C',
			expected: `ps 含 ext-sessions/${sid}/background-tasks/（wrapper 与 cmd.sh 同目录路径）`,
			actual: groupLines.length > 0 ? groupLines.map((p) => `pid=${p.pid} ${p.command.trim().slice(0, 160)}`).join(' | ') : '15s 内未见（wrapper 未 spawn——真异常）',
		})
		const wrapperSeen = groupLines.some((p) => p.command.includes(WRAPPER_NAME))
		ev.assert('C: 执行窗口内包装脚本在场（taiji-fg-wrap，包装格生效证据）', wrapperSeen, {
			channel: 'C',
			expected: `ps 行含 ${WRAPPER_NAME}`,
			actual: wrapperSeen ? 'wrapper 行在场' : `background-tasks 锚行中无 ${WRAPPER_NAME}（${groupLines.length} 行）`,
		})
		const sleepSeen = psFind(HANG_COMMAND).some((p) => p.command.trim() === HANG_COMMAND)
		ev.assert('C: 执行窗口内 sleep 300 进程在场（真实命令已开跑）', sleepSeen, {
			channel: 'C',
			expected: 'ps 行 command 全等 "sleep 300"',
			actual: sleepSeen ? 'sleep 行在场' : '不可见',
		})
		if (groupLines.length > 0) ev.attach('pre-abort-ps', JSON.stringify(groupLines, null, 2))
		ev.step({ step: 'ps.pre-abort', command: `ps find ext-sessions/${sid}/background-tasks/ + ${HANG_COMMAND}`, exitCode: groupLines.length > 0 && wrapperSeen && sleepSeen ? 0 : 1, stats: { groupCount: groupLines.length, wrapperSeen, sleepSeen } })

		// ── 4. 设计步骤②：5s 后点停止按钮 ──────────────────────────────────
		await new Promise((r) => setTimeout(r, STOP_DELAY_MS))

		// ── 5. 用户中止：message.abortBash（停止按钮的协议通道） ────────────
		let abortReply = null
		let abortError = null
		try {
			abortReply = await protocol.call('message.abortBash', { sessionId: sid }, { replyType: 'message.status', timeoutMs: 30_000 })
		} catch (e) {
			abortError = String(e?.message ?? e).slice(0, 400)
			ev.attach('abort-miss', abortError)
		}
		ev.assert('B: message.abortBash 回执 status=aborted（停止按钮通道受理）', abortReply?.status === 'aborted', {
			channel: 'B',
			expected: "{status:'aborted'}",
			actual: abortReply ? JSON.stringify(abortReply).slice(0, 200) : `RPC 未达${abortError ? `：${abortError}` : ''}`,
		})

		// ── 6. bash 气泡官方式中止：bashResult cancelled=true ───────────────
		// abort 抢先收尾后 sendBash 发布真实 cancelled 终态（bash-dispatcher W1 修订）。
		let cancelFrame = null
		try {
			cancelFrame = await protocol.waitFor((e) => e.type === 'message.bashResult' && e.payload?.command === HANG_COMMAND && e.payload?.cancelled === true, { since, timeoutMs: 45_000, sessionId: sid })
		} catch (e) {
			ev.attach('cancel-frame-miss', String(e?.message ?? e).slice(0, 400))
		}
		ev.assert('C: bash 气泡官方式中止——bashResult cancelled=true', cancelFrame !== null, {
			channel: 'C',
			expected: 'bashResult {command, cancelled:true}（cancelled 收尾档）',
			actual: cancelFrame ? `exitCode=${JSON.stringify(cancelFrame.payload?.exitCode)} cancelled=${cancelFrame.payload?.cancelled}` : '45s 内未观察到 cancelled 终态帧',
		})
		if (cancelFrame) ev.attach('cancel-bash-frame', JSON.stringify(cancelFrame.payload, null, 2).slice(0, 2000))

		// ── 7. message.bash 回执 settled（已执行已收尾） ────────────────────
		let reply = null
		try {
			reply = await callPromise
		} catch (e) {
			ev.attach('bash-reply-miss', String(e?.message ?? e).slice(0, 400))
		}
		ev.assert('B: message.bash 回执 settled（已执行已收尾，非挂起/非拒收）', reply?.status === 'settled', {
			channel: 'B',
			expected: "message.status settled（abort 抢先收尾竞态路径的官方回执）",
			actual: reply ? `status=${reply.status}${reply.error ? ` error=${String(reply.error).slice(0, 120)}` : ''}` : '回执未达（RPC 超时或失败）',
		})
		ev.step({ step: 'chat.abortBash', command: 'message.abortBash', exitCode: abortReply?.status === 'aborted' && cancelFrame !== null && reply?.status === 'settled' ? 0 : 1, stats: { replyStatus: abortReply?.status, cancelled: cancelFrame?.payload?.cancelled ?? null, bashReply: reply?.status ?? null } })

		// ── 8. wrapper 进程组整组被杀（ps 无残留，RL5） ─────────────────────
		const groupGone = await pollUntil(async () => psFind(`ext-sessions/${sid}/background-tasks/`).length === 0, { timeoutMs: 15_000, intervalMs: 300 })
		const sleepGone = await pollUntil(async () => psFind(HANG_COMMAND).every((p) => p.command.trim() !== HANG_COMMAND), { timeoutMs: 15_000, intervalMs: 300 })
		const residualGroup = psFind(`ext-sessions/${sid}/background-tasks/`)
		ev.assert('C: 中止后 wrapper 与 cmd.sh 整组消失（同进程组一并杀，无本会话残留）', Boolean(groupGone), {
			channel: 'C',
			expected: `ext-sessions/${sid}/background-tasks/ 锚行 0 条`,
			actual: residualGroup.length === 0 ? '无残留' : residualGroup.map((p) => `pid=${p.pid} ${p.command.trim().slice(0, 160)}`).join(' | '),
		})
		const residualSleep = psFind(HANG_COMMAND).filter((p) => p.command.trim() === HANG_COMMAND)
		ev.assert('C: 中止后真实命令进程消失（ps 无 sleep 300 残留）', Boolean(sleepGone), {
			channel: 'C',
			expected: 'sleep 300 精确行 0 条',
			actual: residualSleep.length === 0 ? '无残留' : residualSleep.map((p) => `pid=${p.pid}(pgid=${p.pgid})`).join(','),
		})

		// ── 9. 无登记条目（中止发生在转后台之前） ───────────────────────────
		const entry = findRegistryEntry(readRegistry(dataDir, sid), HANG_COMMAND)
		ev.assert('C: registry 无本命令登记条目（中止在转后台之前）', !entry, {
			channel: 'C',
			expected: '无 sleep 300 条目',
			actual: entry ? JSON.stringify(entry).slice(0, 300) : '无条目',
		})

		// ── 10. 通道复位：新 `!` 命令立即可发 ───────────────────────────────
		const sinceProbe = protocol.events.length
		const probeCall = protocol.call('message.bash', { sessionId: sid, command: PROBE_COMMAND }, { replyType: 'message.status', timeoutMs: 60_000 })
		let probeFrame = null
		try {
			probeFrame = await protocol.waitFor((e) => e.type === 'message.bashResult' && e.payload?.command === PROBE_COMMAND, { since: sinceProbe, timeoutMs: 60_000, sessionId: sid })
		} catch {
			/* 超时红由断言承载 */
		}
		let probeReply = null
		try {
			probeReply = await probeCall
		} catch (e) {
			ev.attach('probe-reply-miss', String(e?.message ?? e).slice(0, 400))
		}
		const rejectedFrames = protocol.events.slice(sinceProbe).filter((e) => e.type === 'send.rejected' && e.payload?.reason === 'busy')
		ev.assert('B: 通道复位——探针 `!` 命令立即可发（回执 settled，非 rejected 拒收）', probeReply?.status === 'settled', {
			channel: 'B',
			expected: 'message.status settled（bash 通道占用已随中止复位）',
			actual: `status=${probeReply?.status ?? 'no-reply'}${probeReply?.error ? ` error=${String(probeReply.error).slice(0, 120)}` : ''}`,
		})
		ev.assert('B: 探针窗口无「Agent 正在处理」拒收帧（send.rejected busy 计数=0）', rejectedFrames.length === 0, {
			channel: 'B',
			expected: 'count=0',
			actual: `count=${rejectedFrames.length}${rejectedFrames.length > 0 ? `：${JSON.stringify(rejectedFrames[0].payload).slice(0, 160)}` : ''}`,
		})
		ev.assert('B: 探针真实执行（bashResult exitCode=0 且 output 含哨兵）', probeFrame !== null && probeFrame.payload?.exitCode === 0 && String(probeFrame.payload?.output ?? '').includes('TAIJI-A8-CHANNEL-OK'), {
			channel: 'B',
			expected: 'bashResult exitCode=0 output 含 TAIJI-A8-CHANNEL-OK',
			actual: probeFrame ? `exitCode=${JSON.stringify(probeFrame.payload?.exitCode)} output=${JSON.stringify(String(probeFrame.payload?.output ?? '').slice(0, 120))}` : 'bashResult 帧未达',
		})
		ev.step({ step: 'chat.send.probe', command: `message.bash ${PROBE_COMMAND}`, exitCode: probeReply?.status === 'settled' && probeFrame?.payload?.exitCode === 0 ? 0 : 1, stats: { probeStatus: probeReply?.status ?? null, exitCode: probeFrame?.payload?.exitCode ?? null, rejectedBusy: rejectedFrames.length } })

		// ── 11. 红灯登记：核心链任一环缺席时如实 uncovered（不静默降级） ────
		if (abortReply?.status !== 'aborted' || cancelFrame === null || reply?.status !== 'settled' || !groupGone || !sleepGone || entry || probeReply?.status !== 'settled') {
			uncovered.push('V7 abort 通道保持链（进程组整组被杀/cancelled 收尾/settled 回执/无登记/通道复位）存在红灯断言——按失败归因处置（docs/TROUBLESHOOTING.md），不在本剧本内放宽')
		}
		log(`done sid=${sid} cancelled=${cancelFrame !== null} groupGone=${Boolean(groupGone)} probeSettled=${probeReply?.status === 'settled'}`)
		return { uncovered, gotchas }
	} finally {
		const killed = cleanupSentinel()
		if (killed.length > 0) {
			ev.step({ step: 'cleanup.sentinel', command: `kill cmd.sh 锚行 + ${HANG_COMMAND}`, exitCode: 0, stats: { pids: killed } })
			log(`哨兵兜底清理 killed=${JSON.stringify(killed)}`)
		}
	}
}
