/**
 * p0-bash-wrapper-crash-fallback —— V9 包装脚本异常死亡兜底
 * （foreground-idle-to-background 设计 §6.2 V9 = 矩阵 B5；验收项 A10）。
 *
 * 装配：faux。不注入 idleBackgroundSec（缺省 600——A5 包装格默认生效；包装脚本在
 * 执行早期即被外部击杀，阈值取值与本剧本无关）。
 *
 * 路径：
 *   faux 发起前台留活命令（sleep 哨兵）→ 执行窗口内 ps 定位包装脚本进程
 *   （taiji-fg-wrap）→ 场景外部 SIGKILL 包装脚本进程（留活命令不杀——B5 事件）→
 *   B/C：官方拿到错误结果 + 结果尾部补 [TAIJI-FG-BG] 标记行（execute 收尾把还活着
 *   的命令登记为后台任务，设计 §4.3 兜底）→
 *   C：命令被登记为后台任务（registry running 条目 + 进程存活）→
 *   模型侧可查：faux 轮 2 编排 bash_output {}（list 模式，无需动态 task_id）结果
 *   含本任务 →
 *   B：backgroundTask.output 可查（输出尾部可达）→
 *   B：backgroundTask.kill 可杀（killed=true → 进程消失、条目终态）。
 *
 * 终止通道裁决同 A1：faux 静态脚本无法携带动态 task_id，bash_kill 特定 id 调用
 * 不可编排；kill 走 runtime backgroundTask.kill（侧边栏终止同款单点）。
 *
 * 实现前 HEAD 形态（预期红）：无包装进程可杀——观察超时后 abortStuckTurn 收尾，
 * 登记/查询/终止断言全红是预期。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	abortStuckTurn,
	extractTaskId,
	findRegistryEntry,
	findSessionFile,
	killByPattern,
	pollUntil,
	psFind,
	readRegistry,
	readSessionEntries,
	toolResultsFor,
	waitForBashCallStart,
} from './lib/fg-bg-lib.mjs'

/** 留活命令哨兵（各剧本互不相同）。 */
const SLEEP_SENTINEL = 'sleep 3100129'
const KEEPALIVE_COMMAND = SLEEP_SENTINEL
/** 包装脚本进程名（设计 §5 部件 1：bin/taiji-fg-wrap）。 */
const WRAPPER_NAME = 'taiji-fg-wrap'

export const meta = {
	id: 'p0-bash-wrapper-crash-fallback',
	priority: 'P0',
	title: 'V9：包装脚本被击杀——错误结果 + 存活命令登记为后台任务（可查可杀）',
	covers: ['env.launch', 'env.ready', 'env.doctor', 'session.create', 'chat.send', 'chat.wait', 'chat.stream'],
	requires: ['faux'],
	estimateSec: 300,
	faux: {
		responses: [
			// 轮 1：发起留活命令（包装执行中被场景击杀包装脚本）
			{ toolCalls: [{ name: 'bash', args: { command: KEEPALIVE_COMMAND } }], stopReason: 'toolUse' },
			// 轮 2：bash_output 是 deferred 工具（tool-declaration-slimming D4）——先
			// tool_search 激活（deferred 工具默认不在场，见 P0-P1-COVERAGE 已知空洞 #9）
			{ toolCalls: [{ name: 'tool_search', args: { query: 'bash_output background task output' } }], stopReason: 'toolUse' },
			// 轮 3：错误结果 + 标记行返回后，模型用 bash_output 无参 list 查看任务
			//（list 模式无需动态 task_id——faux 静态脚本可编排）
			{ toolCalls: [{ name: 'bash_output', args: {} }], stopReason: 'toolUse' },
			// 轮 4：收尾
			{ text: 'FGBG-A10-END', stopReason: 'stop' },
		],
	},
	provable: [
		'C：执行窗口内包装脚本进程在场并可被定位（taiji-fg-wrap）',
		'B/C：击杀包装脚本后官方拿到错误结果且尾部补 [TAIJI-FG-BG] 标记行（B5 兜底）',
		'C：留活命令被登记为后台任务（registry running 条目 + 进程存活）',
		'C：模型侧 bash_output list 结果含本任务（转后台条目对模型可见）',
		'B：backgroundTask.output 输出尾部可达（查询链路）',
		'B/C：backgroundTask.kill 终止——进程消失、条目终态',
	],
	notProvable: [
		'模型侧 bash_kill 对特定 task_id 的调用（faux 静态脚本无法携带动态 task_id；终止由 backgroundTask.kill RPC 承载，同一 killProcessTree 单点）',
		'会话销毁收殓覆盖（V9 验收表内「会话销毁被收殓」子项归 reaper 域测试族；本剧本驱动 kill 主动终止路径）',
	],
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'击杀目标按进程名 taiji-fg-wrap 定位且只杀包装脚本自身（真实命令 reparent 留活——B5 前提）',
		'bash_output list 模式（无参）是模型侧查询转后台任务的唯一无需动态 task_id 的编排形态——faux 轮 2 借此证明「任务对模型可见」',
		'实现前 HEAD 形态：无包装进程可杀，30s 观察超时后 abortStuckTurn 收尾——登记/查询/终止断言红是预期（D1 开发中）',
	]
	let sid = null
	let cleanupDone = false
	const cleanupIfNeeded = async (reason) => {
		if (cleanupDone || !sid) return
		cleanupDone = true
		const actions = await abortStuckTurn(protocol, sid, { sentinel: SLEEP_SENTINEL, log })
		ev.step({ step: 'cleanup.stuck-turn', command: 'message.abort + sentinel kill', exitCode: 0, stats: { reason, actions } })
	}

	try {
		// ── 1. 建会话（无 idle 注入：默认包装格） ───────────────────
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fgbg-a10-'))
		const created = await protocol.call('session.create', { cwd, label: 'p0-fgbg-a10' }, { timeoutMs: 120_000 })
		sid = created.session?.id
		ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
			channel: 'B',
			expected: 'session.id 非空',
			actual: JSON.stringify(created.session ?? {}).slice(0, 200),
		})
		if (!sid) throw new Error('session.create 未返回 sessionId')
		await protocol.subscribe(sid)
		log(`session=${sid} cwd=${cwd}`)

		// ── 2. 驱动：留活命令（包装执行中） ────────────────────────
		const since = protocol.events.length
		await protocol.send(sid, 'FGBG-A10-START 留活命令')
		const startEvt = await waitForBashCallStart(protocol, sid, { commandIncludes: '3100129', timeoutMs: 60_000, since })
		ev.assert('B: bash 留活命令调用发起（tool_call_start）', Boolean(startEvt), {
			channel: 'B',
			expected: 'sleep 哨兵命令 tool_call_start',
			actual: startEvt ? `at=${new Date(startEvt.receivedAt).toISOString()}` : '60s 内未观察到',
		})
		if (!startEvt) throw new Error('bash tool_call_start 未到达')

		// ── 3. 定位并击杀包装脚本（B5 事件注入） ───────────────────
		const wrapper = await pollUntil(() => psFind(WRAPPER_NAME)[0], { timeoutMs: 15_000, intervalMs: 300 })
		ev.assert('C: 执行窗口内包装脚本进程在场（taiji-fg-wrap）', Boolean(wrapper), {
			channel: 'C',
			expected: `ps 含 ${WRAPPER_NAME}`,
			actual: wrapper ? JSON.stringify(wrapper) : '15s 内未见包装进程（实现前 HEAD 形态：官方原生执行）',
		})
		if (wrapper) ev.attach('wrapper-ps', JSON.stringify(wrapper, null, 2))
		if (wrapper) {
			try {
				process.kill(wrapper.pid, 'SIGKILL')
				ev.step({ step: 'chaos.kill-wrapper', command: `kill -9 ${WRAPPER_NAME} pid=${wrapper.pid}`, exitCode: 0, stats: { pid: wrapper.pid, pgid: wrapper.pgid } })
			} catch (e) {
				ev.assert('C: 包装脚本击杀动作执行', false, { channel: 'C', expected: 'SIGKILL 成功', actual: String(e?.message ?? e) })
			}
		} else {
			await cleanupIfNeeded('no-wrapper（实现前 HEAD 形态）')
		}

		// ── 4. 官方错误结果 + 标记行（B5 兜底） ────────────────────
		const sessionFile = created.session?.sessionFile ?? (await pollUntil(() => findSessionFile(dataDir, sid), { timeoutMs: 15_000 }))
		ev.step({ step: 'evidence.session-file', command: `locate ${sid}`, exitCode: sessionFile ? 0 : 1, stats: { sessionFile: sessionFile ?? '未找到' } })
		let end1 = null
		try {
			// 击杀包装后官方 execute 随子进程死亡返回错误结果；pi 续轮消费 faux 轮 2/3 后收尾
			end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 60_000 })
		} catch (e) {
			ev.attach('turn1-end-miss', String(e?.message ?? e).slice(0, 600))
			await cleanupIfNeeded('turn-未收尾（实现前 HEAD 形态）')
		}
		ev.assert('B: 击杀包装后 turn 收尾（官方拿到错误结果、循环恢复）', end1?.type === 'message.complete' && end1.ok, {
			channel: 'B',
			expected: 'message.complete（错误结果 + bash_output list + 文本收尾）',
			actual: end1 ? `${end1.type} stop=${String(end1.payload?.stopReason)}` : '未等到（实现前 HEAD 形态：前台挂死）',
		})

		// JSONL：错误结果尾部补标记行
		const entries = readSessionEntries(sessionFile)
		const bashResults = toolResultsFor(entries, 'bash')
		const crashResult = bashResults[bashResults.length - 1] ?? null
		const crashText = crashResult?.text ?? ''
		ev.assert('C: 官方错误结果尾部补 [TAIJI-FG-BG] 标记行（B5 兜底登记指引）', crashText.includes('[TAIJI-FG-BG]'), {
			channel: 'C',
			expected: 'bash toolResult 含 [TAIJI-FG-BG]',
			actual: crashResult ? crashText.slice(0, 400) : `bash toolResult 共 ${bashResults.length} 条`,
		})
		if (crashResult) ev.attach('crash-tool-result', crashText)

		// 模型侧 bash_output list 结果含本任务（faux 轮 2 的工具结果）
		const listToolResult = toolResultsFor(entries, 'bash_output')[0] ?? null
		ev.assert('C: 模型侧 bash_output list 结果含本任务（转后台条目对模型可见）', Boolean(listToolResult && listToolResult.text.includes(SLEEP_SENTINEL)), {
			channel: 'C',
			expected: `bash_output toolResult 含 ${SLEEP_SENTINEL}`,
			actual: listToolResult ? listToolResult.text.slice(0, 400) : '无 bash_output toolResult',
		})

		// ── 5. 登记与进程存活 ──────────────────────────────────────
		const alive = psFind(SLEEP_SENTINEL)
		ev.assert('C: 留活命令进程存活（包装死亡不影响命令，reparent 后仍在跑）', alive.length > 0, {
			channel: 'C',
			expected: `ps 含 ${SLEEP_SENTINEL}`,
			actual: alive.length > 0 ? `pid=${alive.map((p) => p.pid).join(',')}` : '不可见',
		})
		const registryEntry = await pollUntil(() => findRegistryEntry(readRegistry(dataDir, sid), SLEEP_SENTINEL), { timeoutMs: 20_000 })
		ev.assert('C: 留活命令被登记为后台任务（registry running 条目）', registryEntry?.state === 'running', {
			channel: 'C',
			expected: "{command 含哨兵, state:'running'}",
			actual: registryEntry ? JSON.stringify(registryEntry).slice(0, 300) : '20s 内无登记条目',
		})
		if (registryEntry) ev.attach('crash-registry-entry', JSON.stringify(registryEntry, null, 2))

		// ── 6. 查询与终止（可查可杀） ──────────────────────────────
		const taskId = registryEntry?.taskId ?? extractTaskId(crashText)
		ev.assert('C/B: taskId 可解析（registry 或标记行）', Boolean(taskId), {
			channel: 'C',
			expected: 'bt-<id>',
			actual: taskId ?? '未解析到',
		})
		let outputReply = null
		if (taskId) {
			try {
				outputReply = await protocol.call('backgroundTask.output', { sessionId: sid, taskId }, { replyType: 'backgroundTask.outputResult', timeoutMs: 30_000 })
			} catch (e) {
				ev.attach('bgt-output-miss', String(e?.message ?? e).slice(0, 400))
			}
		}
		ev.assert('B: backgroundTask.output 可查（查询链路可达，非 lost）', outputReply?.lost === false && typeof outputReply?.text === 'string', {
			channel: 'B',
			expected: '{lost:false, text}',
			actual: outputReply ? JSON.stringify({ lost: outputReply.lost, textBytes: String(outputReply.text ?? '').length }).slice(0, 200) : '未发起/未达',
		})
		let killReply = null
		if (taskId) {
			try {
				killReply = await protocol.call('backgroundTask.kill', { sessionId: sid, taskId }, { replyType: 'backgroundTask.killResult', timeoutMs: 30_000 })
			} catch (e) {
				ev.attach('bgt-kill-miss', String(e?.message ?? e).slice(0, 400))
			}
		}
		ev.assert('B: backgroundTask.kill 可杀（killed=true）', killReply?.killed === true, {
			channel: 'B',
			expected: '{killed:true}',
			actual: killReply ? JSON.stringify(killReply).slice(0, 200) : '未发起（无 taskId）',
		})
		const gone = await pollUntil(async () => psFind(SLEEP_SENTINEL).length === 0, { timeoutMs: 15_000 })
		ev.assert('C: kill 后留活命令进程消失', Boolean(gone), {
			channel: 'C',
			expected: `${SLEEP_SENTINEL} 不可见`,
			actual: JSON.stringify(psFind(SLEEP_SENTINEL)),
		})
		ev.step({ step: 'bgt.kill', command: `backgroundTask.kill ${taskId ?? '(no-id)'}`, exitCode: killReply?.killed === true && gone ? 0 : 1, stats: { taskId, reason: killReply?.reason } })

		if (!wrapper) {
			uncovered.push('V9 完整链路（击杀包装→兜底登记→可查可杀）在当前 HEAD 不可验（无 taiji-fg-wrap 进程——D1 开发中，D3 全量重跑本剧本判绿）')
		}
		log(`done sid=${sid} taskId=${taskId} kill=${JSON.stringify(killReply ?? null)}`)
	} finally {
		if (!cleanupDone) {
			const left = psFind(SLEEP_SENTINEL)
			if (left.length > 0) {
				const killed = killByPattern(SLEEP_SENTINEL)
				ev.step({ step: 'cleanup.sentinel', command: `kill ${SLEEP_SENTINEL}`, exitCode: 0, stats: { pids: killed } })
			}
		}
	}
	return { uncovered, gotchas }
}
