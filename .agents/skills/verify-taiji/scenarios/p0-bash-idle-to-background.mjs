/**
 * p0-bash-idle-to-background —— V1 事故复刻：静默挂死前台命令空闲转后台
 * （foreground-idle-to-background 设计 §6.2 V1 = 矩阵 A5/B3/C3；验收项 A1）。
 *
 * 装配：faux（凭证无关零 token）+ idleBackgroundSec=30 注入
 * （<dataDir>/agent/config/base-tool-enhance-ext-config.json，launch 后写入即热重载）。
 *
 * 路径：
 *   faux 编排一轮 bash 工具调用（事故同构命令：cd 失败报错 + 无限静默挂住的
 *   sleep 哨兵）→ B：tool_call_start→tool_call_end 在 30s±容差内返回 →
 *   C：结果文本含 [TAIJI-FG-BG] 标记行 + Full log 路径 + cd 报错行 →
 *   B：turn 以 complete 收尾（agent 循环恢复推进）→ C：命令进程存活（ps）→
 *   B/C：registry/backgroundTask.list 登记 running 条目 →
 *   终止：backgroundTask.kill（侧边栏终止同款 killProcessTree 单点）→
 *   C：进程消失 + 条目终态。
 *
 * 终止通道裁决：faux 是静态脚本演员，无法把转后台后才生成的 task_id 填进
 * bash_kill 的脚本步骤——模型侧 bash_kill 动态参数路径不可编排（notProvable 登记）；
 * 终止链路由 runtime backgroundTask.kill RPC 承载（真实用户路径 = 桌面后台任务
 * 侧边栏终止按钮，与 bash_kill 同一 killProcessTree 终止单点）。
 *
 * 实现前 HEAD 形态（预期红）：前台命令无超时无限等待——剧本内置 55s 观察超时 +
 * abortStuckTurn（message.abort + 哨兵 pid 清理）收尾，防孤儿 sleep。
 */
import {
	abortStuckTurn,
	extractTaskId,
	findRegistryEntry,
	findSessionFile,
	killByPattern,
	pollSessionFile,
	pollUntil,
	psFind,
	readRegistry,
	toolResultsFor,
	waitForBashCallStart,
	writeIdleConfig,
} from './lib/fg-bg-lib.mjs'

/** 空闲转后台阈值（秒）：30s（设计 §6.2 V1 验收口径）。 */
const IDLE_SEC = 30
/** 观察超时：阈值 + 25s 容差（pi 派发 / 抄送 / wire 开销预算）。 */
const TOOL_WAIT_MS = (IDLE_SEC + 25) * 1000
/** 时序通过带：30s±5s（设计 V1「30s±5s 内返回」）+ 上侧 10s 开销余量。 */
const ELAPSED_MIN_MS = (IDLE_SEC - 5) * 1000
const ELAPSED_MAX_MS = (IDLE_SEC + 15) * 1000
/** 挂死命令哨兵（ps 按此串精确识别本剧本进程；各剧本互不相同）。 */
const SLEEP_SENTINEL = 'sleep 3100127'
/** 事故同构命令：cd 先失败（stderr 有输出）→ 无自然退出点的静默挂住。 */
const HANG_COMMAND = `cd /tmp/fgbg-a1-missing-dir-7c31 && echo probe-start; ${SLEEP_SENTINEL}`

export const meta = {
	id: 'p0-bash-idle-to-background',
	priority: 'P0',
	title: 'V1 事故复刻：静默挂死前台命令 30s 空闲转后台（标记行 + 进程存活 + 登记 + 终止）',
	covers: ['env.launch', 'env.ready', 'env.doctor', 'session.create', 'chat.send', 'chat.wait', 'chat.stream'],
	requires: ['faux'],
	estimateSec: 300,
	faux: {
		responses: [
			// 轮 1：发起挂死 bash 调用（事故形态：cd 失败 + 静默挂住，未传 timeout/background）
			{ toolCalls: [{ name: 'bash', args: { command: HANG_COMMAND } }], stopReason: 'toolUse' },
			// 轮 1 续：转后台标记返回后模型收尾（证明 agent 循环恢复推进）
			{ text: 'FGBG-A1-CONVERTED-SEEN', stopReason: 'stop' },
		],
	},
	provable: [
		'B：工具调用在 idle 30s±容差内返回（tool_call_start→tool_call_end 时序，25–45s 通过带）',
		'C：结果文本含 [TAIJI-FG-BG] 标记行 + Full log 日志路径 + cd 报错行（事故形态复刻）',
		'B：turn 以 message.complete 收尾（转后台解除阻塞、agent 循环恢复推进）',
		'C：转后台后命令进程存活（ps 哨兵可见，不杀不重启）',
		'C/B：registry 与 backgroundTask.list 均出现 running 登记条目（含哨兵命令）',
		'B/C：backgroundTask.kill 终止后进程消失、条目转终态 exited/killed',
	],
	notProvable: [
		'模型侧 bash_kill 工具的动态 task_id 编排——faux 静态脚本无法携带转后台后才生成的 task_id（终止链路由 backgroundTask.kill RPC 承载，同一 killProcessTree 单点；模型侧动态参数路径留 live 验收）',
		'真实 Electron 探针挂死复刻（V1 原事故命令）——以 cd 失败 + 静默 sleep 哨兵等价替代（同构：先输出后无限静默挂住），避免验收实例拉起真实 GUI 进程',
	],
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir, repo } = ctx
	const uncovered = []
	const gotchas = [
		`idleBackgroundSec 注入通道 = <dataDir>/agent/config/base-tool-enhance-ext-config.json（llm-shared getConfigPath，execute 读时热重载）——不是 settings.json；launch 后写即生效`,
		'完成通知 / 转后台后 steer 类唤醒会消耗 faux step——多轮剧本的响应脚本必须排够步（脚本耗尽 = 该轮 error 收尾）',
		`实现前 HEAD 形态：本剧本 bash 调用真挂死，55s 观察超时后走 abortStuckTurn（message.abort + 哨兵 ${SLEEP_SENTINEL} pid 清理）——新行为断言红是预期（D1 开发中）`,
		'registry 条目定位按 command 子串（哨兵）而非 taskId——taskId 由转后台结果动态生成，C 侧先按命令找到条目再取 taskId 对账',
	]
	let cleanupDone = false
	const cleanupIfNeeded = async (reason) => {
		if (cleanupDone) return
		cleanupDone = true
		const actions = await abortStuckTurn(protocol, sidRef.value, { sentinel: SLEEP_SENTINEL, log })
		ev.step({ step: 'cleanup.stuck-turn', command: 'message.abort + sentinel kill', exitCode: 0, stats: { reason, actions } })
	}
	const sidRef = { value: null }

	try {
		// ── 1. 注入空闲阈值配置（热重载，先于 session 创建） ─────────
		const cfgPath = writeIdleConfig(dataDir, { idleBackgroundSec: IDLE_SEC })
		ev.step({ step: 'config.idle-inject', command: `write ${cfgPath}`, exitCode: 0, stats: { idleBackgroundSec: IDLE_SEC } })
		ev.assert('C: idleBackgroundSec=30 配置文件写入扩展配置通道', cfgPath.endsWith('base-tool-enhance-ext-config.json'), {
			channel: 'C',
			expected: '<dataDir>/agent/config/base-tool-enhance-ext-config.json',
			actual: cfgPath,
		})

		// ── 2. 建会话（临时 cwd，不污染 repo） ──────────────────────
		const fs = await import('node:fs')
		const os = await import('node:os')
		const path = await import('node:path')
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fgbg-a1-'))
		const created = await protocol.call('session.create', { cwd, label: 'p0-fgbg-a1' }, { timeoutMs: 120_000 })
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

		// ── 3. 驱动：faux 发起挂死 bash 调用 ────────────────────────
		const since = protocol.events.length
		const tSend = Date.now()
		await protocol.send(sid, 'FGBG-A1-START 执行探针命令')
		const startEvt = await waitForBashCallStart(protocol, sid, { commandIncludes: '3100127', timeoutMs: 60_000, since })
		ev.assert('B: bash 工具调用发起（tool_call_start，挂死命令）', Boolean(startEvt), {
			channel: 'B',
			expected: "message.tool_call_start toolName=bash command 含哨兵",
			actual: startEvt ? `at=${new Date(startEvt.receivedAt).toISOString()}` : '60s 内未观察到',
		})
		if (!startEvt) throw new Error('bash tool_call_start 未到达（faux 脚本未消费或工具未注册）')

		// ── 4. 等转后台返回（阈值±容差时序） ────────────────────────
		let endEvt = null
		try {
			endEvt = await protocol.waitFor((e) => e.type === 'message.tool_call_end', {
				sessionId: sid,
				timeoutMs: TOOL_WAIT_MS,
				since,
			})
		} catch (e) {
			ev.attach('tool-end-miss', String(e?.message ?? e).slice(0, 600))
		}
		const elapsedMs = endEvt ? endEvt.receivedAt - startEvt.receivedAt : null
		ev.assert(`B: 工具调用在 idle ${IDLE_SEC}s±容差内返回（${ELAPSED_MIN_MS / 1000}–${ELAPSED_MAX_MS / 1000}s 通过带）`, elapsedMs !== null && elapsedMs >= ELAPSED_MIN_MS && elapsedMs <= ELAPSED_MAX_MS, {
			channel: 'B',
			expected: `${ELAPSED_MIN_MS}–${ELAPSED_MAX_MS} ms（30s±5s + 开销余量）`,
			actual: elapsedMs === null ? `${TOOL_WAIT_MS / 1000}s 内未返回（实现前 HEAD 形态：前台无超时挂死）` : `${elapsedMs} ms（send→start=${startEvt.receivedAt - tSend}ms）`,
		})

		// ── 5. 会话 JSONL：标记行与结果内容 ────────────────────────
		const sessionFile = created.session?.sessionFile ?? (await pollUntil(() => findSessionFile(dataDir, sid), { timeoutMs: 15_000 }))
		ev.step({ step: 'evidence.session-file', command: `locate ${sid}`, exitCode: sessionFile ? 0 : 1, stats: { sessionFile: sessionFile ?? '未找到' } })
		const { entries, hit } = await pollSessionFile(
			sessionFile,
			(es) => toolResultsFor(es, 'bash').some((r) => r.text.includes('[TAIJI-FG-BG]')),
			{ timeoutMs: 20_000 },
		)
		const bashResults = toolResultsFor(entries, 'bash')
		const converted = bashResults.find((r) => r.text.includes('[TAIJI-FG-BG]')) ?? bashResults[bashResults.length - 1] ?? null
		const resultText = converted?.text ?? ''
		ev.assert('C: 工具结果含 [TAIJI-FG-BG] 转后台标记行', Boolean(converted && converted.text.includes('[TAIJI-FG-BG]')), {
			channel: 'C',
			expected: '结果文本含 [TAIJI-FG-BG]',
			actual: converted ? resultText.slice(0, 400) : `bash toolResult 共 ${bashResults.length} 条、无标记行`,
		})
		ev.assert('C: 标记行含日志路径（Full log: *.log）', /Full log:\s*\S+\.log/.test(resultText), {
			channel: 'C',
			expected: 'Full log: <path>.log（转后台任务日志，background-tasks/ 目录）',
			actual: /Full log:\s*(\S+)/.exec(resultText)?.[1] ?? '未匹配',
		})
		ev.assert('C: 结果含 cd 报错行（事故形态复刻：先输出后静默）', resultText.includes('No such file or directory'), {
			channel: 'C',
			expected: '含 "No such file or directory"（cd 失败行）',
			actual: resultText.split('\n').find((l) => l.includes('No such file')) ?? '未出现',
		})
		if (converted) ev.attach('converted-tool-result', resultText)

		// ── 6. turn 收尾：agent 循环恢复推进 ────────────────────────
		let end1 = null
		try {
			end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 60_000 })
		} catch (e) {
			ev.attach('turn1-end-miss', String(e?.message ?? e).slice(0, 600))
		}
		ev.assert('B: turn 以 message.complete 收尾（阻塞解除、循环恢复推进）', end1?.type === 'message.complete' && end1.ok, {
			channel: 'B',
			expected: 'message.complete（faux 轮 2 文本收尾）',
			actual: end1 ? `${end1.type} stop=${String(end1.payload?.stopReason)}` : '未等到（实现前 HEAD 形态）',
		})
		if (!end1 || !end1.ok) await cleanupIfNeeded('turn-未收尾（实现前 HEAD 形态）')

		// ── 7. 转后台进程存活 ───────────────────────────────────────
		const aliveAfter = psFind(SLEEP_SENTINEL)
		ev.assert('C: 转后台后命令进程存活（ps 可见，不杀不重启）', aliveAfter.length > 0, {
			channel: 'C',
			expected: `ps 含 ${SLEEP_SENTINEL}`,
			actual: aliveAfter.length > 0 ? `pid=${aliveAfter.map((p) => `${p.pid}(pgid=${p.pgid})`).join(',')}` : '不可见（未转后台或进程死亡）',
		})
		if (aliveAfter.length > 0) ev.attach('post-conversion-ps', JSON.stringify(aliveAfter, null, 2))

		// ── 8. 登记：registry（C）+ backgroundTask.list（B） ─────────
		const registryEntry = await pollUntil(() => findRegistryEntry(readRegistry(dataDir, sid), SLEEP_SENTINEL), { timeoutMs: 20_000 })
		ev.assert('C: registry 出现转后台登记条目（running）', registryEntry?.state === 'running', {
			channel: 'C',
			expected: `{command 含哨兵, state:'running'}`,
			actual: registryEntry ? JSON.stringify(registryEntry).slice(0, 300) : '20s 内未出现登记条目',
		})
		let listReply = null
		try {
			listReply = await protocol.call('backgroundTask.list', { sessionId: sid }, { replyType: 'backgroundTask.tasks', timeoutMs: 30_000 })
		} catch (e) {
			ev.attach('bgt-list-miss', String(e?.message ?? e).slice(0, 400))
		}
		const listEntry = (listReply?.tasks ?? []).find((t) => String(t.command ?? '').includes(SLEEP_SENTINEL))
		ev.assert('B: backgroundTask.list 含转后台条目（侧边栏数据源可见）', listEntry?.state === 'running', {
			channel: 'B',
			expected: 'tasks[] 含哨兵命令条目 state=running',
			actual: listReply ? `tasks=${(listReply.tasks ?? []).length} match=${JSON.stringify(listEntry ?? null).slice(0, 200)}` : 'RPC 未达',
		})

		// ── 9. 终止：backgroundTask.kill（侧边栏终止同款单点） ───────
		const taskId = registryEntry?.taskId ?? extractTaskId(resultText)
		ev.assert('C/B: 转后台 taskId 可解析（registry 或标记行）', Boolean(taskId), {
			channel: 'C',
			expected: 'bt-<id>',
			actual: taskId ?? '未解析到',
		})
		let killReply = null
		if (taskId) {
			try {
				killReply = await protocol.call('backgroundTask.kill', { sessionId: sid, taskId }, { replyType: 'backgroundTask.killResult', timeoutMs: 30_000 })
			} catch (e) {
				ev.attach('bgt-kill-miss', String(e?.message ?? e).slice(0, 400))
			}
		}
		ev.assert('B: backgroundTask.kill 回执 killed=true', killReply?.killed === true, {
			channel: 'B',
			expected: '{killed:true, reason:killed}',
			actual: killReply ? JSON.stringify(killReply).slice(0, 200) : '未发起（无 taskId 或 RPC 未达）',
		})
		const gone = await pollUntil(async () => psFind(SLEEP_SENTINEL).length === 0, { timeoutMs: 15_000 })
		ev.assert('C: kill 后命令进程消失（ps 无哨兵残留）', Boolean(gone), {
			channel: 'C',
			expected: `${SLEEP_SENTINEL} 不可见`,
			actual: JSON.stringify(psFind(SLEEP_SENTINEL)),
		})
		const terminalEntry = await pollUntil(() => {
			const e = findRegistryEntry(readRegistry(dataDir, sid), SLEEP_SENTINEL)
			return e && (e.state === 'exited' || e.state === 'killing') ? e : undefined
		}, { timeoutMs: 20_000 })
		ev.assert('C: kill 后 registry 条目转终态（exited/killed）', Boolean(terminalEntry), {
			channel: 'C',
			expected: "state ∈ {exited}，reason=killed",
			actual: terminalEntry ? JSON.stringify({ state: terminalEntry.state, reason: terminalEntry.reason }).slice(0, 200) : '未观察到终态',
		})
		ev.step({ step: 'bgt.kill', command: `backgroundTask.kill ${taskId ?? '(no-id)'}`, exitCode: killReply?.killed === true && gone ? 0 : 1, stats: { taskId, reason: killReply?.reason } })

		if (!end1 || !end1.ok) {
			uncovered.push('V1 完整链路（转后台→登记→终止）在当前 HEAD 未生效——新行为断言按预期红（D1 开发中，D3 全量重跑本剧本判绿）')
		}
		log(`done sid=${sid} taskId=${taskId} kill=${JSON.stringify(killReply ?? null)}`)
	} finally {
		// 兜底清理：无论走到哪一步，哨兵进程不残留（只杀本剧本哨兵）
		if (!cleanupDone) {
			const killed = psFind(SLEEP_SENTINEL).map((p) => p.pid)
			if (killed.length > 0) killByPattern(SLEEP_SENTINEL)
			if (killed.length > 0) ev.step({ step: 'cleanup.sentinel', command: `kill ${SLEEP_SENTINEL}`, exitCode: 0, stats: { pids: killed } })
		}
	}
	return { uncovered, gotchas }
}
