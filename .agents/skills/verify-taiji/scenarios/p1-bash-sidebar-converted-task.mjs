/**
 * p1-bash-sidebar-converted-task —— V10 转后台任务的用户可见可控面（桌面 UI 通路）
 * （foreground-idle-to-background 设计 §6.2 V10 = 矩阵 A5/B3 + 侧边栏消费链；
 * 验收项 A11）。
 *
 * 入口形态裁决（2026-10-31 第二批创作时核实源码）：设计文档所述「后台任务侧边栏」
 * 的 L2 列表视图已于 2026-09-16 随「任务观察入口唯一化」退役——现行用户可见可控面 =
 * ① composer 任务托盘 bash 面板（TrayNativePanel.vue，列表 + 行内两段式终止）+
 * ② 右抽屉 bashTask tab（BackgroundTaskDetailPanel.vue，详情 + 输出尾部）。
 * 本剧本按现行形态驱动（testid 均已对源码核实，非虚构）：
 *   A1 同构场景转后台（静默命令 + idle 30s）→ registry running →
 *   UI：点侧栏会话行激活（协议建的 session 不改变 renderer 激活态，ComposerTray
 *   v-if="sessionId" 在 landing 态不渲染——同 p0-chat-stream-ui 先例）→ 托盘条目出现
 *   （composer-tray → bash 入口 pin → tray-native-panel →
 *   tray-bash-row 命令文本 + tray-bash-icon spinner 运行态）→
 *   点行开 drawer：bash-task-detail 命令全文 + bash-task-output 输出尾部 →
 *   托盘行内两段式终止（tray-bash-kill → tray-bash-kill-confirm，触发 kill 回路）→
 *   C：registry 终态 + ps 哨兵消失；UI：ended 桶计数 ≥ 1（与 registry 终态一致）。
 *
 * UI 断言全部走 ctx.ui（CDP + Playwright，data-testid 优先）；每步 UI 操作包在
 * uiStep 防御壳里——UIError 转 ev.assert 红（不中断后续取证），UI 锚漂移时
 * 报告带当前可见 testid 摘要（ui.mjs failWithContext 自带）。
 *
 * 实现前 HEAD 形态（预期红）：静默命令前台挂死无转后台无登记 → 托盘条目不渲染
 * （全量无记录时托盘条目整体不渲染）→ UI 断言全红是预期 + abortStuckTurn 收尾。
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
	pollSessionFile,
	pollUntil,
	psFind,
	readRegistry,
	toolResultsFor,
	waitForBashCallStart,
	writeIdleConfig,
} from './lib/fg-bg-lib.mjs'

/** 空闲转后台阈值（秒）：30（设计 §6.2 V10 复用 V1 场景形态）。 */
const IDLE_SEC = 30
/** 观察超时：阈值 + 25s 容差。 */
const TOOL_WAIT_MS = (IDLE_SEC + 25) * 1000
/** 挂住命令哨兵（ps 按此串精确识别；各剧本互不相同）。 */
const SLEEP_SENTINEL = 'sleep 3100134'
/** 挂住命令：先输出（输出尾部锚）后无限静默（30s 空闲触发转后台）。 */
const HANG_COMMAND = `echo FGBG-A11-OUT-9f31; ${SLEEP_SENTINEL}`
/** 输出尾部哨兵（drawer bash-task-output 断言锚）。 */
const OUT_MARK = 'FGBG-A11-OUT-9f31'
/** 托盘 bash 入口按钮（expanded 密度档；data-kind 精确定位，ComposerTray.vue 已核实）。 */
const TRAY_BASH_BUTTON = 'css=[data-testid="tray-builtin-button"][data-kind="bash"]'
/** 托盘聚合入口按钮（aggregated 密度档 fallback）。 */
const TRAY_AGG_BUTTON = 'testid=tray-aggregate-button'

export const meta = {
	id: 'p1-bash-sidebar-converted-task',
	priority: 'P1',
	title: 'V10 侧边栏通路（现行 = 托盘 bash 面板 + drawer bashTask）：转后台条目可见可查可终止，终态与 registry 一致',
	covers: ['env.launch', 'env.ready', 'env.doctor', 'session.create', 'chat.send', 'chat.wait', 'chat.stream', 'workspace.drawer'],
	requires: ['faux'],
	estimateSec: 300,
	faux: {
		responses: [
			// 轮 1：发起挂住 bash 调用（先输出后静默，未传 timeout/background）
			{ toolCalls: [{ name: 'bash', args: { command: HANG_COMMAND } }], stopReason: 'toolUse' },
			// 轮 2：转后台标记返回后模型收尾（turn #1 结束）
			{ text: 'FGBG-A11-CONVERTED-SEEN', stopReason: 'stop' },
			// 轮 3：UI kill 后完成通知 steer 唤醒的兜底应答（被 kill 任务有终止通知——
			// 不排此步该轮以 faux 耗尽 error 收尾，污染终态取证）
			{ text: 'FGBG-A11-KILLED-ACK', stopReason: 'stop' },
		],
	},
	provable: [
		'C：静默命令 30s 转后台（结果含 [TAIJI-FG-BG] 标记行）+ registry 登记运行条目',
		'A：托盘条目出现（composer-tray 可见——登记驱动托盘条目渲染）',
		'A：托盘 bash 面板行可见：tray-bash-row 命令文本 + tray-bash-icon spinner 运行态标记',
		'A：drawer bashTask 详情：bash-task-command 命令全文 + bash-task-output 输出尾部（含 echo 哨兵）',
		'A：托盘行内两段式终止可用（tray-bash-kill → tray-bash-kill-confirm，点击触发 kill 回路）',
		'C：终止后 ps 哨兵消失 + registry 条目终态落定',
		'A/C：UI ended 桶计数 ≥ 1（tray-panel-tab-count-ended），与 registry 终态一致',
	],
	notProvable: [
		'设计文档原文所述「后台任务侧边栏」L2 列表视图——该视图 2026-09-16 已退役，本剧本按现行入口（托盘 bash 面板 + drawer bashTask tab）驱动，机制语义（列表 + 运行态 + 输出尾部 + 终止 + 终态）逐项对齐 V10 验收点',
		'kill 回路身份验证（pidStartTime 两档）的分支矩阵——归 background-task-service kill 五分支测试族（单测）；本剧本只驱动真实 UI kill 一次（happy path）',
		'model 侧 bash_kill 的动态 task_id 编排——faux 静态脚本无法携带转后台后才生成的 task_id（第一批编排裁决 ①；终止链路由 UI kill 承载，同一 killProcessTree 单点）',
	],
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir, ui } = ctx
	const uncovered = []
	const gotchas = [
		'现行入口形态：侧边栏 L2 列表已退役（2026-09-16），列表/终止 = composer 任务托盘 bash 面板（TrayNativePanel），输出尾部 = drawer bashTask tab（BackgroundTaskDetailPanel）——testid 均对源码核实',
		'协议建会话不改变 renderer 激活态：UI 断言前必须点侧栏会话行激活（css=.session-item）——否则 landing 态 ComposerTray 整体不渲染（Composer.vue v-if="sessionId"），托盘断言全连锁红',
		'托盘行内 kill 按钮渲染条件 = pinned 且 running（hover 预览态刻意不渲染行内按钮防误触）——必须点击入口按钮进入 pin 态后 tray-bash-kill 才可见',
		'托盘行内 kill 按钮渲染条件 = pinned 且 running（hover 预览态刻意不渲染行内按钮防误触）——必须点击入口按钮进入 pin 态后 tray-bash-kill 才可见',
		'托盘入口按钮有密度档差异：expanded 档 = tray-builtin-button[data-kind=bash]，aggregated 档 = tray-aggregate-button（单图标聚合入口）——先试前者、超时 fallback 后者',
		'托盘面板 pin 态点面板外（如 drawer）会收起——drawer 断言后需重新点入口按钮 re-pin，行内终止按钮才回来',
		'全量无记录时托盘条目整体不渲染（面板不可达）——UI 序列必须在 registry 登记（且 2s mtime 轮询广播）之后，给 20s 可见性预算',
		'UI kill 的完成通知会 steer 唤醒新 run 消耗 faux step——轮 3 兜底应答已排（第一批编排裁决 ③）',
		'实现前 HEAD 形态：挂死 → 55s 观察超时 abortStuckTurn；托盘无条目 UI 断言全红是预期（D1 开发中，D3 全量重跑判绿）',
	]
	let sid = null
	let cleanupDone = false
	const cleanupIfNeeded = async (reason) => {
		if (cleanupDone || !sid) return
		cleanupDone = true
		const actions = await abortStuckTurn(protocol, sid, { sentinel: SLEEP_SENTINEL, log })
		ev.step({ step: 'cleanup.stuck-turn', command: 'message.abort + sentinel kill', exitCode: 0, stats: { reason, actions } })
	}
	/** UI 步骤防御壳：UIError / 超时 → ev.assert 红（带选择器与可见 testid 摘要），不中断取证。 */
	const uiStep = async (name, selectorHint, fn) => {
		try {
			const actual = await fn()
			ev.assert(name, true, { channel: 'A', expected: 'ok', actual: String(actual).slice(0, 300) })
			return actual
		} catch (e) {
			const msg = e instanceof Error ? `${e.message}` : String(e)
			ev.assert(name, false, { channel: 'A', expected: `UI 锚 ${selectorHint}`, actual: msg.slice(0, 500) })
			return null
		}
	}
	/** 打开（或 re-pin）托盘 bash 面板：先试 expanded 档 bash 按钮，fallback 聚合入口。 */
	const openTrayBashPanel = async () => {
		try {
			await ui.click(TRAY_BASH_BUTTON, { timeoutMs: 8_000 })
			ev.attach('tray-entry', 'expanded 档 bash 入口（tray-builtin-button[data-kind=bash]）')
			return 'builtin'
		} catch {
			await ui.click(TRAY_AGG_BUTTON, { timeoutMs: 8_000 })
			ev.attach('tray-entry', 'aggregated 档聚合入口（tray-aggregate-button）')
			return 'aggregate'
		}
	}

	try {
		// ── 1. 注入空闲阈值配置 ─────────────────────────────────────
		const cfgPath = writeIdleConfig(dataDir, { idleBackgroundSec: IDLE_SEC })
		ev.step({ step: 'config.idle-inject', command: `write ${cfgPath}`, exitCode: 0, stats: { idleBackgroundSec: IDLE_SEC } })

		// ── 2. 建会话 ───────────────────────────────────────────────
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fgbg-a11-'))
		const created = await protocol.call('session.create', { cwd, label: 'p1-fgbg-a11' }, { timeoutMs: 120_000 })
		sid = created.session?.id
		ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
			channel: 'B',
			expected: 'session.id 非空',
			actual: JSON.stringify(created.session ?? {}).slice(0, 200),
		})
		if (!sid) throw new Error('session.create 未返回 sessionId')
		await protocol.subscribe(sid)
		log(`session=${sid} cwd=${cwd}`)

		// ── 3. 驱动：挂住命令转后台 ─────────────────────────────────
		const since = protocol.events.length
		await protocol.send(sid, 'FGBG-A11-START 执行挂住探针命令')
		const startEvt = await waitForBashCallStart(protocol, sid, { commandIncludes: '3100134', timeoutMs: 60_000, since })
		ev.assert('B: bash 工具调用发起（tool_call_start，挂住命令）', Boolean(startEvt), {
			channel: 'B',
			expected: 'message.tool_call_start toolName=bash command 含哨兵',
			actual: startEvt ? `at=${new Date(startEvt.receivedAt).toISOString()}` : '60s 内未观察到',
		})
		if (!startEvt) throw new Error('bash tool_call_start 未到达')

		const sessionFile = created.session?.sessionFile ?? (await pollUntil(() => findSessionFile(dataDir, sid), { timeoutMs: 15_000 }))
		ev.step({ step: 'evidence.session-file', command: `locate ${sid}`, exitCode: sessionFile ? 0 : 1, stats: { sessionFile: sessionFile ?? '未找到' } })
		const { entries, hit } = await pollSessionFile(
			sessionFile,
			(es) => toolResultsFor(es, 'bash').some((r) => r.text.includes('[TAIJI-FG-BG]')),
			{ timeoutMs: TOOL_WAIT_MS },
		)
		const converted = toolResultsFor(entries, 'bash').find((r) => r.text.includes('[TAIJI-FG-BG]')) ?? null
		ev.assert('C: 结果含 [TAIJI-FG-BG] 转后台标记行（30s 静默触发）', Boolean(converted), {
			channel: 'C',
			expected: '结果文本含 [TAIJI-FG-BG]',
			actual: converted ? converted.text.slice(0, 300) : `${TOOL_WAIT_MS / 1000}s 内无标记行（实现前 HEAD 形态：前台挂死）`,
		})
		if (converted) ev.attach('converted-tool-result', converted.text)

		let end1 = null
		try {
			end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 60_000 })
		} catch (e) {
			ev.attach('turn1-end-miss', String(e?.message ?? e).slice(0, 600))
		}
		ev.assert('B: turn #1 以 message.complete 收尾（阻塞解除）', end1?.type === 'message.complete' && end1.ok, {
			channel: 'B',
			expected: 'message.complete（faux 轮 2 收尾）',
			actual: end1 ? `${end1.type} stop=${String(end1.payload?.stopReason)}` : '未等到（实现前 HEAD 形态）',
		})
		if (!converted || !end1 || !end1.ok) await cleanupIfNeeded('turn-未收尾或未转后台（实现前 HEAD 形态）')

		// ── 4. registry 登记（C 锚）+ taskId ────────────────────────
		const registryEntry = await pollUntil(() => findRegistryEntry(readRegistry(dataDir, sid), SLEEP_SENTINEL), { timeoutMs: 20_000 })
		ev.assert('C: registry 登记转后台运行条目（running）', registryEntry?.state === 'running', {
			channel: 'C',
			expected: "{command 含哨兵, state:'running'}",
			actual: registryEntry ? JSON.stringify(registryEntry).slice(0, 300) : '20s 内无登记条目',
		})
		const taskId = registryEntry?.taskId ?? extractTaskId(converted?.text ?? '')
		ev.step({ step: 'evidence.registry', command: `read registry ${sid}`, exitCode: registryEntry ? 0 : 1, stats: { taskId: taskId ?? null, state: registryEntry?.state ?? null } })

		// ── 5. UI：激活会话 + 托盘条目出现 + 打开 bash 面板 ───────────
		// 协议建的 session 不改变 renderer 激活态（同库先例 p0-chat-stream-ui ui.activate）：
		// landing 态下 ComposerTray 整体不渲染（Composer.vue v-if="sessionId"——无 session
		// 无任务面），UI 断言前必须点侧栏会话行激活；dataDir 全新仅一个会话，first() 语义安全。
		await uiStep('A: 点击侧栏会话行激活协议创建的会话（css=.session-item——协议建会话不改变 renderer 激活态）', 'css=.session-item', async () => {
			await ui.click('css=.session-item', { timeoutMs: 30_000 })
			ev.step({ step: 'ui.activate', command: 'click css=.session-item', exitCode: 0, stats: { sid } })
			return 'session activated via sidebar'
		})
		await uiStep('A: 托盘条目出现（composer-tray 可见——登记驱动渲染）', 'composer-tray', () => ui.expectVisible('testid=composer-tray', { timeoutMs: 20_000 }))
		const entryKind = await uiStep('A: 托盘 bash 面板打开（点击入口按钮 pin）', `${TRAY_BASH_BUTTON} | ${TRAY_AGG_BUTTON}`, () => openTrayBashPanel())
		await uiStep('A: 托盘 bash 面板容器可见（tray-native-panel）', 'tray-native-panel', () => ui.expectVisible('testid=tray-native-panel', { timeoutMs: 10_000 }))
		await ui.screenshot('a11-tray-bash-panel.png')

		// ── 6. UI：条目可见（命令文本 + 运行态标记） ─────────────────
		const rowText = await uiStep('A: 托盘行可见且命令文本在场（tray-bash-row 含哨兵）', 'tray-bash-row', async () => {
			await ui.expectVisible('testid=tray-bash-row', { timeoutMs: 10_000 })
			return ui.expectText('testid=tray-bash-row', SLEEP_SENTINEL, { timeoutMs: 10_000 })
		})
		await uiStep('A: 行运行态标记 = spinner（tray-bash-icon 内 animate-spin——running 形态）', 'tray-bash-icon', async () => {
			const html = await ui.html('testid=tray-bash-icon')
			if (!html.includes('animate-spin')) throw new Error(`tray-bash-icon 非 spinner 形态（期望 running）：${html.slice(0, 200)}`)
			return html.slice(0, 200)
		})
		ev.attach('tray-row-text', String(rowText ?? '').slice(0, 300))

		// ── 7. UI：drawer bashTask 详情（点行）+ 输出尾部 ────────────
		await uiStep('A: 点击行打开 drawer 详情（bash-task-detail 可见）', 'tray-bash-row → bash-task-detail', async () => {
			await ui.click('testid=tray-bash-row', { timeoutMs: 10_000 })
			await ui.expectVisible('testid=bash-task-detail', { timeoutMs: 15_000 })
			return 'bash-task-detail visible'
		})
		await uiStep('A: drawer 命令全文含哨兵（bash-task-command）', 'bash-task-command', () =>
			ui.expectText('testid=bash-task-command', SLEEP_SENTINEL, { timeoutMs: 10_000 }),
		)
		await uiStep('A: drawer 输出尾部含 echo 哨兵（bash-task-output，running 2s 跟随）', 'bash-task-output', () =>
			ui.expectText('testid=bash-task-output', OUT_MARK, { timeoutMs: 20_000 }),
		)
		await ui.screenshot('a11-drawer-bash-task.png')

		// ── 8. UI：两段式终止（re-pin 托盘 → tray-bash-kill → confirm） ─
		await uiStep('A: re-pin 托盘面板（drawer 交互后面板收起，重开）', 'tray bash entry', () => openTrayBashPanel())
		await uiStep('A: 行内终止按钮可用（tray-bash-kill 可见——pinned + running）', 'tray-bash-kill', () =>
			ui.expectVisible('testid=tray-bash-kill', { timeoutMs: 10_000 }),
		)
		const killClickedAt = Date.now()
		await uiStep('A: 两段式终止——首击进入确认态（tray-bash-kill-confirm 出现）', 'tray-bash-kill → tray-bash-kill-confirm', async () => {
			await ui.click('testid=tray-bash-kill', { timeoutMs: 10_000 })
			await ui.expectVisible('testid=tray-bash-kill-confirm', { timeoutMs: 10_000 })
			return 'confirm state reached'
		})
		await uiStep('A: 两段式终止——确认击发 kill 回路（点击 tray-bash-kill-confirm）', 'tray-bash-kill-confirm', async () => {
			await ui.click('testid=tray-bash-kill-confirm', { timeoutMs: 10_000 })
			return 'kill clicked'
		})
		ev.step({ step: 'ui.kill-confirm', command: 'click tray-bash-kill → tray-bash-kill-confirm', exitCode: 0, stats: { taskId: taskId ?? null, entryKind: entryKind ?? null, at: new Date(killClickedAt).toISOString() } })

		// ── 9. 终态：进程消失 + registry 终态 + UI ended 桶 ─────────
		const gone = await pollUntil(async () => psFind(SLEEP_SENTINEL).length === 0, { timeoutMs: 20_000 })
		ev.assert('C: UI kill 后命令进程消失（ps 无哨兵残留）', Boolean(gone), {
			channel: 'C',
			expected: `${SLEEP_SENTINEL} 不可见`,
			actual: JSON.stringify(psFind(SLEEP_SENTINEL)),
		})
		const terminalEntry = await pollUntil(() => {
			const e = findRegistryEntry(readRegistry(dataDir, sid), SLEEP_SENTINEL)
			return e && e.state !== 'running' ? e : undefined
		}, { timeoutMs: 25_000 })
		ev.assert('C: registry 条目终态落定（UI kill 与 registry 终态一致）', Boolean(terminalEntry), {
			channel: 'C',
			expected: "state ∈ 终态（exited / killing→exited，reason=killed）",
			actual: terminalEntry ? JSON.stringify({ state: terminalEntry.state, reason: terminalEntry.reason }).slice(0, 200) : '未观察到终态',
		})
		await uiStep('A: UI 侧终态一致——ended 桶计数 ≥ 1（tray-panel-tab-count-ended）', 'tray-panel-tab-count-ended', () =>
			ui.expectText('testid=tray-panel-tab-count-ended', /[1-9]/, { timeoutMs: 15_000 }),
		)
		await ui.screenshot('a11-after-kill-ended-bucket.png')

		if (!converted || !registryEntry) {
			uncovered.push('V10 UI 通路（托盘条目/drawer 详情/行内终止/终态一致）在当前 HEAD 未生效——无转后台登记则托盘条目不渲染、UI 断言红是预期（D1 开发中，D3 全量重跑本剧本判绿）')
		}
		log(`done sid=${sid} taskId=${taskId} terminal=${terminalEntry?.state ?? 'n/a'}`)
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
