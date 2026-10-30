/**
 * p1-bash-pool-full-register —— N4 池满时转后台登记不被拒 + 占池语义成立
 * （foreground-idle-to-background 设计 §6.2 N4 = §5 部件 2 并发池关系；验收项 A15）。
 *
 * 装配：faux + ext-config 双键注入（maxConcurrentBackground=1 + idleBackgroundSec=30，
 * fg-bg-lib writeExtConfig 通用合并写——本剧本第二批新增的 lib 导出，单键形态
 * writeIdleConfig 行为不变）。
 *
 * 时序（一次 send，faux 按序消费六步）：
 *   轮 1 显式 background:true 占池命令（sleep 哨兵 ①）→ 启动即返回 task_id，池（=1）满 →
 *   轮 2 静默命令（echo + sleep 哨兵 ②，无 timeout/background）→ 30s 空闲转后台 →
 *   断言 A：登记不被拒——结果含标记行 + registry 出现哨兵 ② running 条目（表内两条
 *   running 共存 = 「转后台登记不过并发门」语义，设计 §5 部件 2）→
 *   轮 3 tool_search 激活 bash_output（deferred 工具，第一批编排裁决 ②）→
 *   轮 4 bash_output {}（list 模式，无需动态 task_id）→ 断言 B：list 结果含哨兵 ②
 *   （标记行指令可用——任务对模型可见）→
 *   轮 5 显式 background:true 第三命令（sleep 哨兵 ③）→ 断言 C：被并发门拒绝——
 *   toolResult 含「Background task limit reached / Oldest task: bt- / bash_kill {task_id:」
 *   文案（spawn-background.ts 已核实）且哨兵 ③ 未 spawn（ps 不可见）→
 *   轮 6 文本收尾。
 *
 * 实现前 HEAD 形态（预期红）：轮 1 显式后台是现有机制（恒绿锚——占池语义 HEAD 即成立）；
 * 轮 2 静默命令前台挂死（无包装）→ 45s 观察超时 abortStuckTurn 收尾，转后台/查询/
 * 拒绝断言红是预期。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	abortStuckTurn,
	findRegistryEntry,
	findSessionFile,
	killByPattern,
	pollSessionFile,
	pollUntil,
	psFind,
	readRegistry,
	readSessionEntries,
	toolResultsFor,
	waitForBashCallStart,
	writeExtConfig,
} from './lib/fg-bg-lib.mjs'

/** 空闲转后台阈值（秒）。 */
const IDLE_SEC = 30
/** 并发池上限（设计 §6.2 N4 原文：maxConcurrentBackground 配置 1）。 */
const MAX_CONCURRENT = 1
/** 转后台观察超时：阈值 + 15s 容差。 */
const CONVERT_WAIT_MS = (IDLE_SEC + 15) * 1000
/** 三个哨兵（ps 精确识别；各剧本互不相同）。 */
const OCCUPY_SENTINEL = 'sleep 3100141'
const CONVERT_SENTINEL = 'sleep 3100142'
const DENIED_SENTINEL = 'sleep 3100143'
/** 占池命令（显式后台，立即返回 task_id）。 */
const OCCUPY_COMMAND = OCCUPY_SENTINEL
/** 静默转后台命令（先输出后静默挂住，不传 timeout/background）。 */
const CONVERT_COMMAND = `echo FGBG-A15-OUT-9f41; ${CONVERT_SENTINEL}`
/** 第三命令（显式后台——应被并发门拒绝）。 */
const DENIED_COMMAND = DENIED_SENTINEL
/** 并发门拒绝文案锚（spawn-background.ts:132-138 已核实；文案不含被拒命令）。 */
const GATE_REACHED = 'Background task limit reached'
const GATE_OLDEST = /Oldest task:\s*(bt-[A-Za-z0-9_-]+)/
const GATE_KILL_HINT = 'bash_kill {task_id:'

export const meta = {
	id: 'p1-bash-pool-full-register',
	priority: 'P1',
	title: 'N4 池满登记不拒：maxConcurrent=1 时转后台仍登记（两 running 共存 + bash_output 可查），后续显式 background 被并发门拒',
	covers: ['env.launch', 'env.ready', 'env.doctor', 'session.create', 'chat.send', 'chat.wait', 'chat.stream'],
	requires: ['faux'],
	estimateSec: 240,
	faux: {
		responses: [
			// 轮 1：显式后台占池（现有机制，HEAD 恒绿锚）
			{ toolCalls: [{ name: 'bash', args: { command: OCCUPY_COMMAND, background: true } }], stopReason: 'toolUse' },
			// 轮 2：静默命令转后台（无 timeout/background，30s 空闲触发）
			{ toolCalls: [{ name: 'bash', args: { command: CONVERT_COMMAND } }], stopReason: 'toolUse' },
			// 轮 3：bash_output 是 deferred 工具——先 tool_search 激活（第一批编排裁决 ②）
			{ toolCalls: [{ name: 'tool_search', args: { query: 'bash_output background task output' } }], stopReason: 'toolUse' },
			// 轮 4：bash_output 无参 list（唯一无需动态 task_id 的编排形态）——转后台任务对模型可见
			{ toolCalls: [{ name: 'bash_output', args: {} }], stopReason: 'toolUse' },
			// 轮 5：第三个显式后台命令——并发门拒绝（结果即断言面）
			{ toolCalls: [{ name: 'bash', args: { command: DENIED_COMMAND, background: true } }], stopReason: 'toolUse' },
			// 轮 6：收尾
			{ text: 'FGBG-A15-END', stopReason: 'stop' },
		],
	},
	provable: [
		'C：占池任务登记成功（轮 1 结果含 task_id + registry running 条目——现有机制恒绿锚）',
		'C：池满时转后台登记不被拒（轮 2 结果含 [TAIJI-FG-BG] 标记行）',
		'C：转后台条目登记 running——表内两条 running 共存（占池 + 转后台，转后台不过并发门语义）',
		'C：模型侧 bash_output list 结果含转后台任务（tool_search 激活后可查——标记行指令可用）',
		'C：转后台进程存活（ps 哨兵 ② 可见）',
		'C：占池语义成立——第三个显式 background 命令被并发门拒绝（文案含 limit reached + 最老任务提示 + bash_kill 指引）',
		'C：被拒命令未 spawn（ps 无哨兵 ③——拒绝发生在 spawn 前）',
	],
	notProvable: [
		'转后台任务的 bash_kill 可杀与侧边栏可见（N4 表内「标记行指令可用」三子项中的另两项）——可杀归 V1/V10 剧本（backgroundTask.kill 同一单点），可见归 A11 侧边栏剧本；本剧本聚焦登记不拒 + 占池语义',
		'model 侧 bash_output 对特定 task_id 的定向查询（faux 静态脚本无法携带转后台后才生成的 task_id——第一批编排裁决 ①；list 模式已证可见性）',
	],
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'ext-config 双键注入（maxConcurrentBackground + idleBackgroundSec）走 fg-bg-lib writeExtConfig（本批新增的通用合并写导出；单键 writeIdleConfig 委托它，首批四剧本行为不变）',
		'转后台登记「不过并发门」≠ 池失效——表内出现 2 条 running（上限 1）是设计内语义：上限语义 = spawn 准入控制，非表容量硬限（设计 §5 部件 2）',
		'并发门拒绝文案锚对 spawn-background.ts 现行文案（limit reached / Oldest task: bt- / bash_kill {task_id:）——文案改版时此断言先红，属契约面登记',
		'轮 5 拒绝发生在 spawn 前：ps 断言哨兵 ③ 不存在是「拒绝 = 未 spawn」的进程侧证据（若实现误改为 spawn 后杀，此断言红）',
		'实现前 HEAD 形态：轮 1 显式后台恒绿（占池语义 HEAD 即成立）；轮 2 静默命令挂死 → 45s 超时 abortStuckTurn，转后台/查询断言红是预期（D1 开发中，D3 全量重跑判绿）',
	]
	let sid = null
	let cleanupDone = false
	const cleanupIfNeeded = async (reason) => {
		if (cleanupDone || !sid) return
		cleanupDone = true
		const actions = await abortStuckTurn(protocol, sid, { sentinel: CONVERT_SENTINEL, log })
		ev.step({ step: 'cleanup.stuck-turn', command: 'message.abort + sentinel kill', exitCode: 0, stats: { reason, actions } })
	}
	const killTaskBestEffort = async (taskId) => {
		if (!taskId || !sid) return
		try {
			await protocol.call('backgroundTask.kill', { sessionId: sid, taskId }, { replyType: 'backgroundTask.killResult', timeoutMs: 20_000 })
		} catch {
			/* dispose 链会收殓进程；进程侧由哨兵清理兜底 */
		}
	}

	try {
		// ── 1. 注入双键配置（池上限 1 + 空闲阈值 30s） ───────────────
		const cfgPath = writeExtConfig(dataDir, { maxConcurrentBackground: MAX_CONCURRENT, idleBackgroundSec: IDLE_SEC })
		ev.step({ step: 'config.inject', command: `write ${cfgPath}`, exitCode: 0, stats: { maxConcurrentBackground: MAX_CONCURRENT, idleBackgroundSec: IDLE_SEC } })

		// ── 2. 建会话 ───────────────────────────────────────────────
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fgbg-a15-'))
		const created = await protocol.call('session.create', { cwd, label: 'p1-fgbg-a15' }, { timeoutMs: 120_000 })
		sid = created.session?.id
		ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
			channel: 'B',
			expected: 'session.id 非空',
			actual: JSON.stringify(created.session ?? {}).slice(0, 200),
		})
		if (!sid) throw new Error('session.create 未返回 sessionId')
		await protocol.subscribe(sid)
		log(`session=${sid} cwd=${cwd}`)

		// ── 3. 驱动：一次 send，faux 按序消费六步 ───────────────────
		const since = protocol.events.length
		await protocol.send(sid, 'FGBG-A15-START 依次执行三条命令')

		// 轮 1：占池任务（现有机制恒绿锚）
		const occupyStart = await waitForBashCallStart(protocol, sid, { commandIncludes: '3100141', timeoutMs: 60_000, since })
		ev.assert('B: 占池命令调用发起（tool_call_start，background:true）', Boolean(occupyStart), {
			channel: 'B',
			expected: 'sleep 哨兵 ① 的 tool_call_start',
			actual: occupyStart ? `at=${new Date(occupyStart.receivedAt).toISOString()}` : '60s 内未观察到',
		})
		const sessionFile = created.session?.sessionFile ?? (await pollUntil(() => findSessionFile(dataDir, sid), { timeoutMs: 15_000 }))
		ev.step({ step: 'evidence.session-file', command: `locate ${sid}`, exitCode: sessionFile ? 0 : 1, stats: { sessionFile: sessionFile ?? '未找到' } })
		const { entries: eOccupy } = await pollSessionFile(
			sessionFile,
			(es) => toolResultsFor(es, 'bash').some((r) => r.text.includes('3100141')),
			{ timeoutMs: 30_000 },
		)
		// 占池结果 = 启动即返回的 task_id 行（排除轮 2 之后同文件内的其他结果）
		const occupyResult = toolResultsFor(eOccupy, 'bash').find((r) => r.text.includes('3100141')) ?? null
		const occupyTaskId = occupyResult?.text.match(/bt-[A-Za-z0-9_-]+/)?.[0] ?? null
		ev.assert('C: 占池任务启动即返回 task_id（显式后台现有机制，恒绿锚）', Boolean(occupyResult && occupyTaskId), {
			channel: 'C',
			expected: 'toolResult 含 bt-<id>（spawn 登记成功）',
			actual: occupyResult ? occupyResult.text.slice(0, 200) : '30s 内无 toolResult',
		})
		const occupyEntry = await pollUntil(() => findRegistryEntry(readRegistry(dataDir, sid), OCCUPY_SENTINEL), { timeoutMs: 20_000 })
		ev.assert('C: 占池任务登记 running（池满前置成立）', occupyEntry?.state === 'running', {
			channel: 'C',
			expected: "{command 含哨兵 ①, state:'running'}",
			actual: occupyEntry ? JSON.stringify({ taskId: occupyEntry.taskId, state: occupyEntry.state }) : '20s 内无登记条目',
		})
		ev.step({ step: 'occupy.register', command: OCCUPY_COMMAND, exitCode: occupyEntry?.state === 'running' ? 0 : 1, stats: { taskId: occupyTaskId, state: occupyEntry?.state ?? null } })

		// 轮 2：静默命令转后台（登记不被拒的模型侧证据）
		const convertStart = await waitForBashCallStart(protocol, sid, { commandIncludes: '3100142', timeoutMs: 60_000, since })
		ev.assert('B: 静默命令调用发起（tool_call_start，无 timeout/background）', Boolean(convertStart), {
			channel: 'B',
			expected: 'echo + sleep 哨兵 ② 的 tool_call_start',
			actual: convertStart ? `at=${new Date(convertStart.receivedAt).toISOString()}` : '60s 内未观察到（faux 轮 1 未返回？）',
		})
		if (!convertStart) await cleanupIfNeeded('轮 2 未发起（占池轮异常）')
		// 命中条件仅锚 [TAIJI-FG-BG] 标记行——转后台标记文案不含原始命令（a15 首跑
		// 附件 convert-tool-result.txt 全文无 '3100142'），带哨兵号条件会 45s 空转误触发
		// cleanup。定位无歧义：显式后台（轮 1）结果文案是 task_id/pid 形态
		// （bash-tool.ts:140-143），不含该标记；标记产出点仅转后台分支（bash-tool.ts:159/351）。
		const { entries: eConvert, hit: convertHit } = await pollSessionFile(
			sessionFile,
			(es) => toolResultsFor(es, 'bash').some((r) => r.text.includes('[TAIJI-FG-BG]')),
			{ timeoutMs: CONVERT_WAIT_MS },
		)
		const convertResult = toolResultsFor(eConvert, 'bash').find((r) => r.text.includes('[TAIJI-FG-BG]')) ?? null
		ev.assert('C: 池满时转后台登记不被拒（轮 2 结果含 [TAIJI-FG-BG] 标记行）', Boolean(convertResult), {
			channel: 'C',
			expected: '结果文本含 [TAIJI-FG-BG]（标记行指令可用）',
			actual: convertResult ? convertResult.text.slice(0, 300) : `${CONVERT_WAIT_MS / 1000}s 内无标记行（实现前 HEAD 形态：前台挂死）`,
		})
		if (convertResult) ev.attach('convert-tool-result', convertResult.text)
		// 进程存活断言必须在 cleanup 触发点之前——cleanup（abortStuckTurn）按哨兵串
		// killByPattern SIGKILL 转后台进程（fg-bg-lib.mjs:245-248），断言放其后即便进程
		// 健康也必红（a15 首跑实证：cleanup 误触发 killed=[58123] 后 ps 断言红）
		const convertAlive = psFind(CONVERT_SENTINEL)
		ev.assert('C: 转后台进程存活（ps 哨兵 ② 可见）', convertAlive.length > 0, {
			channel: 'C',
			expected: `ps 含 ${CONVERT_SENTINEL}`,
			actual: convertAlive.length > 0 ? `pid=${convertAlive.map((p) => p.pid).join(',')}` : '不可见（未转后台或进程死亡）',
		})
		if (!convertHit) await cleanupIfNeeded('轮 2 未转后台（实现前 HEAD 形态）')

		// ── 4. 等 turn 收尾（覆盖轮 3/4/5/6） ───────────────────────
		let end1 = null
		try {
			end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
		} catch (e) {
			ev.attach('turn1-end-miss', String(e?.message ?? e).slice(0, 600))
			await cleanupIfNeeded('turn 未收尾')
		}
		ev.assert('B: turn 以 message.complete 收尾（六步全消费）', end1?.type === 'message.complete' && end1.ok, {
			channel: 'B',
			expected: 'message.complete（faux 轮 6 收尾）',
			actual: end1 ? `${end1.type} stop=${String(end1.payload?.stopReason)}` : '未等到（实现前 HEAD 形态：轮 2 挂死阻塞）',
		})

		// ── 5. registry：两条 running 共存（转后台不过并发门） ───────
		const finalRegistry = readRegistry(dataDir, sid)
		const convertEntry = findRegistryEntry(finalRegistry, CONVERT_SENTINEL)
		const stillOccupy = findRegistryEntry(finalRegistry, OCCUPY_SENTINEL)
		const runningStates = [stillOccupy?.state, convertEntry?.state]
		ev.assert('C: 转后台条目登记 running（池满不拒——registry 落盘证据）', convertEntry?.state === 'running', {
			channel: 'C',
			expected: "{command 含哨兵 ②, state:'running'}",
			actual: convertEntry ? JSON.stringify({ taskId: convertEntry.taskId, state: convertEntry.state }).slice(0, 200) : '无登记条目（未转后台或登记被拒）',
		})
		ev.assert('C: 表内两条 running 共存（上限 1 + 转后台登记——不过并发门语义）', runningStates.filter((s) => s === 'running').length === 2, {
			channel: 'C',
			expected: '占池条目 running + 转后台条目 running（共 2 条）',
			actual: `占池=${stillOccupy?.state ?? '缺失'} 转后台=${convertEntry?.state ?? '缺失'}`,
		})
		ev.step({
			step: 'evidence.registry-dual-running',
			command: `read registry ${sid}`,
			exitCode: runningStates.filter((s) => s === 'running').length === 2 ? 0 : 1,
			stats: { occupy: { taskId: stillOccupy?.taskId, state: stillOccupy?.state ?? null }, converted: { taskId: convertEntry?.taskId, state: convertEntry?.state ?? null } },
		})

		// ── 6. 模型侧可见：bash_output list 含转后台任务（轮 4） ────
		const parsedFinal = readSessionEntries(sessionFile)
		const outputListResult = toolResultsFor(parsedFinal, 'bash_output')[0] ?? null
		ev.assert('C: bash_output list 结果含转后台任务（tool_search 激活后可查）', Boolean(outputListResult && outputListResult.text.includes('3100142')), {
			channel: 'C',
			expected: `bash_output toolResult 含 ${CONVERT_SENTINEL}`,
			actual: outputListResult ? outputListResult.text.slice(0, 400) : '无 bash_output toolResult（轮 4 未消费或工具未激活）',
		})
		if (outputListResult) ev.attach('bash-output-list-result', outputListResult.text.slice(0, 800))

		// ── 7. 进程侧：被拒未 spawn（转后台存活断言已前移到 cleanup 触发点之前） ──

		// 轮 5：并发门拒绝（文案 + 未 spawn）。定位锚 = 拒绝文案串 GATE_REACHED——
		// 拒绝文案不含被拒命令（spawn-background.ts:132-138 只回显最老任务的截断命令，
		// 此处最老 = 占池哨兵① 'sleep 3100141'），includes('3100143') 永远 miss
		const deniedResult = toolResultsFor(parsedFinal, 'bash').find((r) => r.text.includes(GATE_REACHED)) ?? null
		const deniedText = deniedResult?.text ?? ''
		ev.assert('C: 第三个显式 background 命令被并发门拒绝（文案含 limit reached）', Boolean(deniedResult && deniedText.includes(GATE_REACHED)), {
			channel: 'C',
			expected: `toolResult 含 "${GATE_REACHED}"`,
			actual: deniedResult ? deniedText.slice(0, 400) : '无哨兵 ③ 的 toolResult（轮 5 未消费）',
		})
		const oldestMatch = GATE_OLDEST.exec(deniedText)?.[1] ?? null
		ev.assert('C: 拒绝文案含最老任务提示（Oldest task: bt-…）', Boolean(oldestMatch), {
			channel: 'C',
			expected: `Oldest task: ${occupyTaskId ?? 'bt-<占池 id>'}（最老 = 首个登记的占池任务）`,
			actual: oldestMatch ?? '未匹配 Oldest task 提示',
		})
		if (oldestMatch && occupyTaskId) {
			ev.assert('C: 最老任务指向占池任务（首个登记者）', oldestMatch === occupyTaskId, {
				channel: 'C',
				expected: occupyTaskId,
				actual: `${oldestMatch}（转后台条目为 ${convertEntry?.taskId ?? 'n/a'}）`,
			})
		}
		ev.assert('C: 拒绝文案含 bash_kill 指引（可处置，非静默损失）', deniedText.includes(GATE_KILL_HINT), {
			channel: 'C',
			expected: `含 "${GATE_KILL_HINT}"`,
			actual: deniedText.includes(GATE_KILL_HINT) ? '在场' : deniedText.slice(0, 300),
		})
		if (deniedResult) ev.attach('denied-tool-result', deniedText)
		await new Promise((r) => setTimeout(r, 1_000))
		const deniedProcs = psFind(DENIED_SENTINEL)
		ev.assert('C: 被拒命令未 spawn（ps 无哨兵 ③——拒绝发生在 spawn 前）', deniedProcs.length === 0, {
			channel: 'C',
			expected: `${DENIED_SENTINEL} 不可见`,
			actual: deniedProcs.length === 0 ? '不可见' : `意外存在：${JSON.stringify(deniedProcs)}`,
		})

		// ── 8. 收尾清理（D3 防孤儿：转后台任务按 id 杀 + 哨兵兜底） ──
		const convertTaskId = convertEntry?.taskId ?? null
		await killTaskBestEffort(convertTaskId)
		await killTaskBestEffort(occupyTaskId)
		const leftPids = [...psFind(CONVERT_SENTINEL), ...psFind(OCCUPY_SENTINEL), ...psFind(DENIED_SENTINEL)].map((p) => p.pid)
		if (leftPids.length > 0) {
			killByPattern(CONVERT_SENTINEL)
			killByPattern(OCCUPY_SENTINEL)
			killByPattern(DENIED_SENTINEL)
		}
		ev.step({ step: 'cleanup.tasks', command: 'backgroundTask.kill ×2 + sentinel sweep', exitCode: 0, stats: { convertTaskId, occupyTaskId, sweptPids: leftPids } })

		if (!convertResult || convertEntry?.state !== 'running') {
			uncovered.push('N4 转后台登记不拒链路在当前 HEAD 未生效——轮 2 静默命令未转后台（D1 开发中，D3 全量重跑本剧本判绿）；占池任务登记（恒绿锚）与并发门拒绝文案断言按现有机制核验')
		}
		log(`done sid=${sid} occupy=${occupyTaskId} convert=${convertTaskId} denied=${Boolean(deniedResult)}`)
	} finally {
		if (!cleanupDone) {
			const left = [...psFind(CONVERT_SENTINEL), ...psFind(OCCUPY_SENTINEL), ...psFind(DENIED_SENTINEL)]
			if (left.length > 0) {
				killByPattern(CONVERT_SENTINEL)
				killByPattern(OCCUPY_SENTINEL)
				killByPattern(DENIED_SENTINEL)
				ev.step({ step: 'cleanup.sentinel', command: 'kill 三哨兵', exitCode: 0, stats: { pids: left.map((p) => p.pid) } })
			}
		}
	}
	return { uncovered, gotchas }
}
