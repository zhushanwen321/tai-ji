/**
 * p0-bash-abort-process-group —— V6 用户中止：包装进程组整组终止
 * （foreground-idle-to-background 设计 §6.2 V6 = 矩阵 B4；验收项 A7）。
 *
 * 装配：faux。不注入 idleBackgroundSec（缺省 600——A5 包装格默认生效，中止发生在
 * 阈值前的执行窗口内，阈值取值与本剧本无关）。
 *
 * 路径：
 *   faux 发起前台挂住命令（sleep 哨兵）→ 执行窗口内观察包装脚本进程在场
 *   （ps：taiji-fg-wrap，设计 §5 部件 1——实现前 HEAD 无包装进程，断言红是预期）→
 *   B：message.abort（用户点停止的真实协议通道）→ reply status=aborted +
 *   广播 message.complete{stopReason:'aborted'}（官方式中止结果）→
 *   C：包装脚本与真实命令（同进程组）整组消失（ps 无哨兵/无 wrapper 残留）→
 *   C：无登记条目（registry 无本命令条目）→
 *   B：中止后会话不卡死——立刻再发一条并得到正常回复（occupancy 回落）。
 *
 * 实现前 HEAD 形态：官方原生执行无包装——wrapper 在场断言红（预期）；abort 杀
 * 官方进程组、哨兵同灭、无登记、可再发——这些断言在 HEAD 即绿（官方 abort 语义
 * 既有），正好构成 D3 前后的行为对照面。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	findRegistryEntry,
	findSessionFile,
	killByPattern,
	pollUntil,
	psFind,
	readRegistry,
	waitForBashCallStart,
} from './lib/fg-bg-lib.mjs'

/** 挂住命令哨兵（各剧本互不相同，ps 精确识别）。 */
const SLEEP_SENTINEL = 'sleep 3100128'
const HANG_COMMAND = SLEEP_SENTINEL
/** 包装脚本进程名（设计 §5 部件 1：新文件 bin/taiji-fg-wrap）。 */
const WRAPPER_NAME = 'taiji-fg-wrap'

export const meta = {
	id: 'p0-bash-abort-process-group',
	priority: 'P0',
	title: 'V6：包装执行中用户中止——包装进程组整组终止 + 官方式 aborted 结果 + 无登记',
	covers: ['env.launch', 'env.ready', 'env.doctor', 'session.create', 'chat.send', 'chat.wait', 'chat.abort'],
	requires: ['faux'],
	estimateSec: 240,
	faux: {
		responses: [
			// 轮 1：发起挂住命令（包装执行中被中止）
			{ toolCalls: [{ name: 'bash', args: { command: HANG_COMMAND } }], stopReason: 'toolUse' },
			// 轮 2：中止后恢复发送的应答（「中止后不卡死」断言的消费步）
			{ text: 'FGBG-A7-AFTER-ABORT-OK', stopReason: 'stop' },
		],
	},
	provable: [
		'C：执行窗口内包装脚本进程在场（ps：taiji-fg-wrap，A5 包装格生效证据）',
		'B：message.abort 回执 status=aborted + 广播 message.complete{stopReason:aborted}（官方式中止结果）',
		'C：中止后包装脚本与真实命令整组消失（ps 无哨兵、无 wrapper 残留）',
		'C：无登记条目（registry 无本命令条目——中止发生在转后台之前）',
		'B：中止后会话不卡死——立刻再发一条并以 message.complete 正常收尾',
	],
	notProvable: [
		'渲染层停止按钮的 DOM 形态（chat.abort 域已覆盖；本剧本走协议通道 = 同一 runtime 中止入口）',
		'中止时序与空闲阈值的竞争窗口（B6 静默将满时恰好退出的串行判定属单测覆盖）',
	],
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'包装脚本进程按名 taiji-fg-wrap 识别（设计 §5 部件 1 bin/taiji-fg-wrap）——实现前 HEAD 无该进程，「在场」断言红是预期（D1 开发中）',
		'中止后「无登记」的判据 = registry 文件不存在或不含本哨兵命令条目（中止发生在转后台判定之前，设计矩阵 B4）',
		'中止后会话恢复的断言消费 faux 轮 2——响应脚本必须排恢复应答步',
	]
	let sid = null
	try {
		// ── 1. 建会话（无 idle 配置注入：缺省阈值下验证默认包装格） ──
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fgbg-a7-'))
		const created = await protocol.call('session.create', { cwd, label: 'p0-fgbg-a7' }, { timeoutMs: 120_000 })
		sid = created.session?.id
		ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
			channel: 'B',
			expected: 'session.id 非空',
			actual: JSON.stringify(created.session ?? {}).slice(0, 200),
		})
		if (!sid) throw new Error('session.create 未返回 sessionId')
		await protocol.subscribe(sid)
		log(`session=${sid} cwd=${cwd}`)

		// ── 2. 驱动：挂住命令（包装执行中） ────────────────────────
		const since = protocol.events.length
		await protocol.send(sid, 'FGBG-A7-START 挂住命令后我会中止')
		const startEvt = await waitForBashCallStart(protocol, sid, { commandIncludes: '3100128', timeoutMs: 60_000, since })
		ev.assert('B: bash 挂住命令调用发起（tool_call_start）', Boolean(startEvt), {
			channel: 'B',
			expected: 'sleep 哨兵命令 tool_call_start',
			actual: startEvt ? `at=${new Date(startEvt.receivedAt).toISOString()}` : '60s 内未观察到',
		})
		if (!startEvt) throw new Error('bash tool_call_start 未到达')

		// ── 3. 执行窗口内观察包装进程（A5 包装格生效证据） ──────────
		const wrapperSeen = await pollUntil(() => psFind(WRAPPER_NAME), { timeoutMs: 15_000, intervalMs: 300 })
		ev.assert('C: 执行窗口内包装脚本进程在场（taiji-fg-wrap）', (wrapperSeen ?? []).length > 0, {
			channel: 'C',
			expected: `ps 含 ${WRAPPER_NAME}（A5 格命令被包装）`,
			actual: (wrapperSeen ?? []).length > 0 ? JSON.stringify(wrapperSeen).slice(0, 300) : '15s 内未见包装进程（实现前 HEAD 形态：官方原生执行）',
		})
		if (wrapperSeen) ev.attach('wrapper-ps-pre-abort', JSON.stringify(wrapperSeen, null, 2))
		const preAbort = {
			wrapper: psFind(WRAPPER_NAME),
			sentinel: psFind(SLEEP_SENTINEL),
			at: new Date().toISOString(),
		}
		ev.attach('pre-abort-ps', JSON.stringify(preAbort, null, 2))
		ev.step({ step: 'ps.pre-abort', command: `ps find ${WRAPPER_NAME} / ${SLEEP_SENTINEL}`, exitCode: 0, stats: { wrapperCount: preAbort.wrapper.length, sentinelCount: preAbort.sentinel.length } })

		// ── 4. 用户中止（协议通道 = UI 停止按钮同一 runtime 入口） ──
		let abortReply = null
		try {
			abortReply = await protocol.call('message.abort', { sessionId: sid }, { replyType: 'message.status', timeoutMs: 30_000 })
		} catch (e) {
			ev.attach('abort-miss', String(e?.message ?? e).slice(0, 400))
		}
		ev.assert('B: message.abort 回执 status=aborted', abortReply?.status === 'aborted', {
			channel: 'B',
			expected: "{status:'aborted'}",
			actual: abortReply ? JSON.stringify(abortReply).slice(0, 200) : 'RPC 未达',
		})
		let endAborted = null
		try {
			endAborted = await protocol.waitTurnEnd(sid, { since, timeoutMs: 45_000 })
		} catch (e) {
			ev.attach('abort-end-miss', String(e?.message ?? e).slice(0, 400))
		}
		ev.assert('B: 官方式中止结果——message.complete{stopReason:aborted}', endAborted?.type === 'message.complete' && endAborted.payload?.stopReason === 'aborted', {
			channel: 'B',
			expected: "message.complete stopReason='aborted'",
			actual: endAborted ? `${endAborted.type} stop=${String(endAborted.payload?.stopReason)}` : '未等到终态',
		})
		ev.step({ step: 'chat.abort', command: 'message.abort', exitCode: abortReply?.status === 'aborted' && endAborted?.payload?.stopReason === 'aborted' ? 0 : 1, stats: { replyStatus: abortReply?.status, stopReason: endAborted?.payload?.stopReason } })

		// ── 5. 进程组整组终止（ps 无残留） ─────────────────────────
		const sentinelGone = await pollUntil(async () => psFind(SLEEP_SENTINEL).length === 0, { timeoutMs: 15_000, intervalMs: 300 })
		const wrapperGone = await pollUntil(async () => psFind(WRAPPER_NAME).length === 0, { timeoutMs: 15_000, intervalMs: 300 })
		ev.assert('C: 中止后真实命令进程消失（ps 无哨兵残留）', Boolean(sentinelGone), {
			channel: 'C',
			expected: `${SLEEP_SENTINEL} 不可见`,
			actual: JSON.stringify(psFind(SLEEP_SENTINEL)),
		})
		ev.assert('C: 中止后包装脚本进程消失（同进程组一并杀，无残留）', Boolean(wrapperGone), {
			channel: 'C',
			expected: `${WRAPPER_NAME} 不可见`,
			actual: JSON.stringify(psFind(WRAPPER_NAME)),
		})

		// ── 6. 无登记条目 ──────────────────────────────────────────
		const sessionFile = created.session?.sessionFile ?? findSessionFile(dataDir, sid)
		const entry = findRegistryEntry(readRegistry(dataDir, sid), SLEEP_SENTINEL)
		ev.assert('C: registry 无本命令登记条目（中止在转后台之前）', !entry, {
			channel: 'C',
			expected: '无哨兵命令条目',
			actual: entry ? JSON.stringify(entry).slice(0, 300) : `无条目（sessionFile=${sessionFile ? '在' : '缺'}）`,
		})

		// ── 7. 中止后会话不卡死（立刻再发一条并正常收尾） ───────────
		const sinceRecover = protocol.events.length
		await protocol.send(sid, 'FGBG-A7-RECOVER 中止后恢复发送')
		let endRecover = null
		try {
			endRecover = await protocol.waitTurnEnd(sid, { since: sinceRecover, timeoutMs: 60_000 })
		} catch (e) {
			ev.attach('recover-end-miss', String(e?.message ?? e).slice(0, 400))
		}
		ev.assert('B: 中止后立刻再发一条并正常收尾（occupancy 回落、会话不卡死）', endRecover?.type === 'message.complete' && endRecover.ok, {
			channel: 'B',
			expected: 'message.complete（faux 轮 2 应答）',
			actual: endRecover ? `${endRecover.type} stop=${String(endRecover.payload?.stopReason)}` : '未等到（会话可能卡死）',
		})
		ev.step({ step: 'chat.send.recover', channel: 'B', exitCode: endRecover?.ok ? 0 : 1, stats: { stopReason: endRecover?.payload?.stopReason } })

		if (!wrapperSeen || (wrapperSeen ?? []).length === 0) {
			uncovered.push('V6 的「包装进程组」面在当前 HEAD 不可验（无 taiji-fg-wrap 进程——D1 开发中）；中止/整组终止/无登记/恢复链路在 HEAD 已绿（官方 abort 语义），D3 重跑补包装面判绿')
		}
		log(`done sid=${sid} wrapperSeen=${(wrapperSeen ?? []).length > 0}`)
	} finally {
		// 兜底：哨兵不残留（中止链失效时的人工保险；只杀本剧本哨兵）
		const left = psFind(SLEEP_SENTINEL)
		if (left.length > 0) {
			const killed = killByPattern(SLEEP_SENTINEL)
			ev.step({ step: 'cleanup.sentinel', command: `kill ${SLEEP_SENTINEL}`, exitCode: 0, stats: { pids: killed } })
		}
	}
	return { uncovered, gotchas }
}
