/**
 * a3-askuser-pending-stall-exempt —— V3：ask_user 等待豁免（矩阵 C7 格）
 * （pi-stall-detection 验收节点 A3，设计 §4.1 V3 rendered.md:326 + §4.2 RL5 :346）。
 *
 * 场景：agent 发起 ask_user 表单后等待用户作答（等待远超判死阈值 T），断言 ask_user
 * pending 豁免锚点在场即暂停计时——无辅助提示、不判死；作答后回合正常继续、无状态
 * 残留；第 1 层探测（PingProbe）全程绿。豁免缺失时该形态会在 T_hint 出提示、T 判死
 * 自动 abort（表单关闭 + session.exited）——本场景同时反向验证豁免必要性。
 *
 * 装配：faux（真 Electron + 真 pi + 假 LLM 演员，零 token）+ idleBackgroundSec=1 缩短
 * 配置（<dataDir>/agent/config/base-tool-enhance-ext-config.json，会话构造时读定）→
 * T = 1s + 300s = 301s、T_hint = 241s。缩短为等差联动（MODEL_WINDOW_FALLBACK_MS 常量
 * 分量不随配置缩放），等待窗 400s ≈ 1.33×T（对齐设计原版 1200s/900s 比例）。
 * 判死分支装配前提（排除「没装配所以不判死」的假阳性）：faux settings.json 无
 * httpIdleTimeoutMs → modelWindow=300s < T=301s；无 mcp.json → mcpMax=60s < T；
 * idleBackgroundSec=1 ≠ null —— resolveStallMatrixArms → judge=true，剧本内按同源
 * 公式复算断言。
 *
 * 路径：
 *   段 1 注入缩短配置 + 装配前提复算 → 建会话 → 发消息触发 faux step1（ask_user
 *   toolUse）→ FormOverlay 呈现（锚点置位的呈现面）；
 *   段 2 等待窗 400s（>T）：每 60s 观测快照（无 session.stall_hint / 无
 *   message.stream_warn / 无 session.exited / 表单仍在场），窗末集中断言 a/c；
 *   段 3 作答（真实用户路径 CDP：两题各点一选项 → form-next → form-submit）→
 *   faux step2 文本（DONE 标记）→ turn complete → 断言 b（继续 + 无残留）。
 *
 * 断言通道：B（WS 协议事件/RPC）为主；A（CDP DOM）承载表单在场与 stall 行缺席；
 * C（配置文件读回）承载缩短注入与装配前提。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeIdleConfig } from './lib/fg-bg-lib.mjs'

/** 转后台空闲阈值（秒）：1s（归一化 floor ≥ 1 的最小合法值）→ T = 301s 最短判死阈值。 */
const IDLE_SEC = 1
/** 判死阈值 T = idleBackgroundSec + 300s（MODEL_WINDOW_FALLBACK_MS 常量分量，RL4 等式）。 */
const T_MS = (IDLE_SEC + 300) * 1000
/** 提示阈值 T_hint = T − 60s（SILENCE_HINT_LEAD_MS）。 */
const T_HINT_MS = T_MS - 60_000
/** 等待窗：400s ≈ 1.33×T（对齐设计原版 1200s/900s 的「远超阈值」比例，跨过 T 达 99s）。 */
const WAIT_MS = 400_000
/** 等待期观测快照间隔（60s——秒级 tick 的 60 倍，足以暴露 T_hint/T 边沿）。 */
const SNAPSHOT_MS = 60_000
/** faux step2 收尾标记（作答后回合继续的文本证据）。 */
const DONE_MARKER = 'ASKUSER-DONE-V3'

export const meta = {
	id: 'a3-askuser-pending-stall-exempt',
	priority: 'P0',
	title: 'V3 ask_user 等待豁免（C7 格）：表单 pending 超 T 无提示不判死 + 作答回合继续 + 第 1 层探测全程绿',
	covers: ['env.launch', 'env.ready', 'env.doctor', 'session.create', 'chat.send', 'chat.wait', 'interaction.askuser'],
	requires: ['faux'],
	estimateSec: 660,
	faux: {
		responses: [
			// 轮 1：发起 ask_user 两题表单（形态对齐 fixtures/faux-responses/ask-user-two-questions.json
			// ——schema options minItems 2，每题带 header）
			{
				toolCalls: [{
					name: 'ask_user',
					args: {
						questions: [
							{
								header: 'DB',
								question: '选哪个数据库？',
								context: '需要 ACID 与 JSON 列。',
								options: [{ label: 'SQLite', description: '零运维，嵌入式' }, { label: 'Postgres', description: '成熟，强一致' }],
							},
							{
								header: 'Region',
								question: '部署在哪个区域？',
								context: '决定延迟与合规边界。',
								options: [{ label: 'us-east-1', description: '美东，延迟低' }, { label: 'eu-west-1', description: '欧盟，合规友好' }],
							},
						],
					},
				}],
				stopReason: 'toolUse',
			},
			// 轮 1 续：作答回灌后模型收尾（agent 循环恢复推进的证据文本）
			{ text: `已收到你的两题选择，按此继续（${DONE_MARKER}）。`, stopReason: 'stop' },
		],
	},
	provable: [
		'B/C：缩短配置注入且判死分支装配在位（idleBackgroundSec=1 → T=301s；settings 无 httpIdleTimeoutMs → modelWindow 300s < T；无 mcp 条目 → 60s < T —— judge=true，反向验证豁免必要性的前提）',
		'A：ask_user 表单呈现（form-overlay + 两题 tab），锚点在场的用户可见面',
		'B：表单 pending 等待 400s（> T=301s 达 99s）全程零 session.stall_hint 帧（无辅助提示，T_hint=241s 边沿未触发）',
		'B：等待全程零判死（无 session.exited / 无自动 abort）、表单仍在场、无 message.stream_warn（第 1 层探测零告警）',
		'A/B：作答后浮层关闭、faux 收尾文本到达、turn 以 message.complete 收尾（回合正常继续）',
		'B：作答后无状态残留（session.stall_hint 全程零帧、occupancy 复位 idle、无 message.error）',
	],
	notProvable: [
		'设计原版的真实人离席 20 分钟时长——以缩短配置等差联动（T=301s）+ 等待 1.33×T 等比承载；「远超阈值」的判死不可达证明在等待跨过 T 后即成立（判死检查为秒级 tick，跨 T 不触发 = 阈值语义不成立）',
		'判死强杀分型的反事实演练（若锚点豁免缺失会发生的 abort 链）——负向对照由单测承载（silence-matrix.test.ts「notify 不置锚 → 静默超窗照常判死」对照用例），真机不实际制造误判死',
	],
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		`缩短通道 = idleBackgroundSec 写 <dataDir>/agent/config/base-tool-enhance-ext-config.json（会话构造时读定 readStallMatrixConfigSnapshot）——T 等差联动非等比：T = ${T_MS / 1000}s、T_hint = ${T_HINT_MS / 1000}s`,
		'表单 pending 期间 turn 呈工具运行态且无任何帧流（锚点冻结计时的前提形态）——不要把「没有文本流」误判为挂死（features/ask-user-form.md Gotcha 同款）',
		'作答通道 = 桌面 FormOverlay testid（form-option-<label> 原样、form-next、form-submit）；extension.ui_response 是其底层 RPC，非本剧本通道',
	]

	// ── 段 1：缩短配置 + 装配前提 + 建会话触发表单 ────────────────────
	const cfgPath = writeIdleConfig(dataDir, { idleBackgroundSec: IDLE_SEC })
	const cfgOnDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
	ev.assert('C: idleBackgroundSec=1 写入扩展配置通道（缩短注入）', cfgOnDisk?.idleBackgroundSec === IDLE_SEC, {
		channel: 'C',
		expected: `{idleBackgroundSec:${IDLE_SEC}} @ ${path.join('agent', 'config', 'base-tool-enhance-ext-config.json')}`,
		actual: JSON.stringify(cfgOnDisk).slice(0, 200),
	})

	// 判死分支装配前提复算（readStallMatrixConfigSnapshot 同源读侧：settings.json + mcp.json）
	const settingsPath = path.join(dataDir, 'agent', 'settings.json')
	const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
	const mcpPath = path.join(dataDir, 'agent', 'mcp.json')
	const mcpAbsent = !fs.existsSync(mcpPath)
	const noHttpIdle = settings?.httpIdleTimeoutMs === undefined
	const judgeArmed = noHttpIdle && mcpAbsent // modelWindow=300s < T=301s 且 mcpMax=60s < T
	ev.assert(
		`C: 判死分支装配在位（judge=true 前提：modelWindow 300s < T ${T_MS / 1000}s、mcpMax 60s < T、idleBackgroundSec 非 null）`,
		judgeArmed,
		{
			channel: 'C',
			expected: 'settings 无 httpIdleTimeoutMs（→fallback 300s）+ 无 mcp.json（→默认 60s）+ idleBackgroundSec=1 → resolveStallMatrixArms judge=true',
			actual: `httpIdleTimeoutMs=${JSON.stringify(settings?.httpIdleTimeoutMs ?? null)} mcp.json 存在=${String(!mcpAbsent)} T=${T_MS / 1000}s`,
		},
	)
	if (!judgeArmed) {
		uncovered.push('判死分支装配前提不成立（settings/mcp 预置含超界窗）——「不判死」无法归因于豁免锚点')
	}

	const os = await import('node:os')
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-a3-askuser-'))
	// 并行 A1 验收的 mock pi 置换旁路（两态兼容）：mock 壳在场时（apps/electron/resources/pi/
	// pi-darwin-arm64 为脚本壳），借其自带透传机制——TAIJI_A1_STATE_DIR（本剧本私有，与 A1
	// 状态隔离）+ 同 cwd 预写 count=1（壳读后 n=2 ≥ 2 → 透传 TAIJI_A1_REAL_PI 真二进制）；
	// 真 pi 在场时 env 无消费者、预写目录无人读，零影响。env 链已核实：run.mjs meta.env →
	// dev-instance → runtime → buildPiOutboundEnv（ENV_WHITELIST_PREFIXES 'TAIJI_' 整前缀准入）。
	const a1StateDir = process.env.TAIJI_A1_STATE_DIR
	const a1RealPi = process.env.TAIJI_A1_REAL_PI
	if (a1StateDir && a1RealPi) {
		// 壳进程 process.cwd() 是 OS 真实路径形态（macOS /var → /private/var，第 4 轮实测
		// trace 佐证）——realpath 后再算 key，与壳的 count 文件名对齐。
		const realCwd = fs.realpathSync(cwd)
		for (const base of new Set([cwd, realCwd])) {
			const key = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)
			fs.mkdirSync(a1StateDir, { recursive: true })
			fs.writeFileSync(path.join(a1StateDir, `spawn-${key}.count`), '1')
		}
		ev.step({ step: 'mockpi.bypass-primed', channel: 'C', exitCode: 0, stats: { stateDir: a1StateDir, realPi: a1RealPi, note: 'count=1 预写（/var 与 /private/var 双形态）' } })
		log(`mock-pi bypass primed: stateDir=${a1StateDir}`)
	}
	const created = await protocol.call('session.create', { cwd, label: 'a3-askuser-stall' }, { timeoutMs: 120_000 })
	const sid = created.session?.id
	ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
		channel: 'B',
		expected: 'session.id 非空',
		actual: JSON.stringify(created.session ?? {}).slice(0, 200),
	})
	if (!sid) throw new Error('session.create 未返回 sessionId')
	await protocol.subscribe(sid)
	log(`session=${sid} cwd=${cwd} T=${T_MS / 1000}s T_hint=${T_HINT_MS / 1000}s`)

	const sinceSend = protocol.events.length
	await protocol.send(sid, 'A3-V3-START 请确认两个部署选项')
	// 等 ask_user 请求帧（extension.dialog / extension.ui_request——form:true 富交互帧）：
	// 请求挂在 runtime pending 表后，renderer 侧（另一条 WS 连接）选中会话才会经冷读
	// 拉取恢复呈现（useExtensionUI C3——protocol 建的会话 UI 未选中时 Panel 未挂载）。
	let formFrame = null
	try {
		formFrame = await protocol.waitFor(
			(e) => e.type === 'extension.dialog' || e.type === 'extension.ui_request',
			{ sessionId: sid, timeoutMs: 60_000, since: sinceSend },
		)
	} catch (e) {
		ev.attach('form-frame-miss', String(e?.message ?? e).slice(0, 400))
	}
	ev.assert('B: ask_user 请求帧到达（extension.dialog/ui_request，工具已执行、请求已挂 pending 表）', Boolean(formFrame), {
		channel: 'B',
		expected: 'extension.dialog 或 extension.ui_request 帧',
		actual: formFrame ? `${formFrame.type}@${new Date(formFrame.receivedAt).toISOString()}` : '60s 内未观察到（faux step1 未消费或 ask_user 工具断）',
	})
	if (!formFrame) throw new Error('ask_user 请求帧 60s 未到达（链路断，后续段无意义）')

	// UI 切换选中该会话（会话行根 .session-item[role=button]，aria-label=label——
	// features/session-management.md 已知漂移登记；选中后 Panel 挂载 + 冷读拉取恢复表单）
	const ui = ctx.ui
	const rowSel = `.session-item[aria-label="${created.session?.label ?? 'a3-askuser-stall'}"]`
	await ui.click(rowSel, { timeoutMs: 30_000 })
	ev.step({ step: 'ui.select-session', channel: 'A', exitCode: 0, stats: { selector: rowSel } })
	await ui.expectVisible('testid=form-overlay', { timeoutMs: 120_000 })
	const formShownAt = Date.now()
	const q0 = await ui.expectVisible('testid=form-question-text-multi', { timeoutMs: 15_000 })
	ev.assert('A: ask_user 表单呈现（form-overlay + 两题 multi 题面，锚点在场的用户可见面）', Boolean(q0), {
		channel: 'A',
		expected: 'form-overlay + form-question-text-multi 可见（多题形态；单题形态才渲染 form-question-text——FormOverlay.vue:219 v-if !multiQuestion）',
		actual: q0 ? '可见' : '15s 未现（faux step1 未消费或 form 通道断）',
	})
	await ev.shot(ui.page, 'a3-form-pending')

	// ── 段 2：等待窗 400s（> T=301s）——锚点豁免的被测本体 ─────────────
	const waitStart = Date.now()
	let snapshots = 0
	let abortedEarly = null
	while (Date.now() - waitStart < WAIT_MS) {
		await new Promise((r) => setTimeout(r, Math.min(SNAPSHOT_MS, WAIT_MS - (Date.now() - waitStart))))
		snapshots++
		const hints = protocol.events.slice(sinceSend).filter((e) => e.type === 'session.stall_hint')
		const warns = protocol.events.slice(sinceSend).filter((e) => e.type === 'message.stream_warn')
		const exited = protocol.events.slice(sinceSend).filter((e) => e.type === 'session.exited')
		let formStillVisible = false
		try {
			formStillVisible = (await ui.locator('testid=form-overlay').then((l) => l.first().isVisible())) === true
		} catch {
			formStillVisible = false
		}
		ev.step({
			step: `wait.snapshot-${snapshots}`,
			channel: 'B',
			exitCode: hints.length === 0 && warns.length === 0 && exited.length === 0 && formStillVisible ? 0 : 1,
			stats: {
				elapsedSec: Math.round((Date.now() - waitStart) / 1000),
				stallHintFrames: hints.length,
				streamWarnFrames: warns.length,
				sessionExited: exited.length,
				formVisible: formStillVisible,
			},
		})
		if (hints.length > 0 || exited.length > 0 || warns.length > 0 || !formStillVisible) {
			abortedEarly = { hints: hints.length, warns: warns.length, exited: exited.length, formStillVisible }
			break
		}
	}
	const waitedMs = Date.now() - waitStart
	const finalHints = protocol.events.slice(sinceSend).filter((e) => e.type === 'session.stall_hint' && e.payload?.active !== false)
	ev.assert(
		`B: 表单 pending 等待 ${Math.round(waitedMs / 1000)}s（> T ${T_MS / 1000}s）全程零 session.stall_hint 帧（无辅助提示，T_hint ${T_HINT_MS / 1000}s 边沿未触发）`,
		!abortedEarly && waitedMs >= WAIT_MS && finalHints.length === 0,
		{
			channel: 'B',
			expected: `等待 ≥ ${WAIT_MS / 1000}s 且 stall_hint 帧数 = 0（含 active=false 清除帧）`,
			actual: `waited=${Math.round(waitedMs / 1000)}s snapshots=${snapshots} stallHintFrames=${finalHints.length}${abortedEarly ? ` 提前脱离=${JSON.stringify(abortedEarly)}` : ''}`,
		},
	)
	const finalExited = protocol.events.slice(sinceSend).filter((e) => e.type === 'session.exited')
	const finalWarns = protocol.events.slice(sinceSend).filter((e) => e.type === 'message.stream_warn')
	const lastOccBefore = [...protocol.events].reverse().find((e) => e.type === 'session.occupancy' && e.payload?.sessionId === sid)
	ev.assert(
		'B: 等待全程零判死零告警（无 session.exited、无第 1 层 message.stream_warn、无 message.error）',
		finalExited.length === 0 && finalWarns.length === 0 && !protocol.events.slice(sinceSend).some((e) => e.type === 'message.error'),
		{
			channel: 'B',
			expected: 'exited=0 stream_warn=0 error=0（豁免在场即暂停计时，第 1 层探测零误报）',
			actual: `exited=${finalExited.length} stream_warn=${finalWarns.length} lastOccupancy=${lastOccBefore ? JSON.stringify(lastOccBefore.payload).slice(0, 200) : '无帧'}`,
		},
	)
	if (abortedEarly) {
		uncovered.push(`等待期提前脱离（${JSON.stringify(abortedEarly)}）——锚点豁免疑似失效或表单异常关闭，作答段跳过`)
		return { uncovered, gotchas }
	}

	// 等待窗末 UI 复核：无 stall 行（activity-strip-row-stall 缺席）+ 表单仍在
	const stallRowCount = await ui.locator('testid=activity-strip-row-stall').count()
	ev.assert('A: 等待超 T 后活动条无 stall 辅助提示行（renderer 呈现面零污染）', stallRowCount === 0, {
		channel: 'A',
		expected: 'activity-strip-row-stall 计数 0',
		actual: `count=${stallRowCount}`,
	})
	await ev.shot(ui.page, 'a3-after-T-still-pending')

	// ── 段 3：作答（真实用户路径 CDP）→ 回合继续 → 无残留 ─────────────
	await ui.click('testid=form-option-SQLite', { timeoutMs: 15_000 })
	const answered0 = await ui.expectVisible('testid=form-tab-answered', { timeoutMs: 10_000 })
	ev.assert('A: 第 1 题选中（form-tab-answered 标记）', Boolean(answered0), {
		channel: 'A',
		expected: 'form-tab-0 出现已答标记',
		actual: answered0 ? '已答标记可见' : '10s 未现',
	})
	await ui.click('testid=form-next', { timeoutMs: 10_000 })
	await ui.click('testid=form-option-us-east-1', { timeoutMs: 15_000 })
	await ev.shot(ui.page, 'a3-both-answered')
	await ui.click('testid=form-submit', { timeoutMs: 15_000 })
	await ui.expectGone('testid=form-overlay', { timeoutMs: 30_000 })
	ev.assert('A: 提交后浮层关闭（作答回灌 agent）', true, {
		channel: 'A',
		expected: 'form-overlay detached',
		actual: '已消失',
	})

	const sinceAnswer = protocol.events.length
	const end = await protocol.waitTurnEnd(sid, { since: sinceSend, timeoutMs: 120_000 })
	ev.assert('B: 作答后 turn 以 message.complete 收尾（回合正常继续，无 abort/error）', end.type === 'message.complete' && end.ok, {
		channel: 'B',
		expected: `message.complete（faux 收尾文本含 ${DONE_MARKER}）`,
		actual: `${end.type} stop=${String(end.payload?.stopReason)}`,
	})

	const history = await protocol.call('session.history', { sessionId: sid, limitTurns: 5 }, { timeoutMs: 60_000 })
	const historyText = JSON.stringify(history ?? {})
	ev.assert(`B: faux 收尾文本入历史（${DONE_MARKER}，作答确实回灌推进）`, historyText.includes(DONE_MARKER), {
		channel: 'B',
		expected: `session.history 含 ${DONE_MARKER}`,
		actual: historyText.includes(DONE_MARKER) ? '命中' : historyText.slice(0, 300),
	})

	const hintsAfter = protocol.events.slice(sinceSend).filter((e) => e.type === 'session.stall_hint')
	const exitedAfter = protocol.events.slice(sinceSend).filter((e) => e.type === 'session.exited')
	const occIdle = [...protocol.events].reverse().find(
		(e) => e.type === 'session.occupancy' && e.payload?.sessionId === sid && e.payload?.turn === 'idle',
	)
	ev.assert(
		'B: 作答后无状态残留（stall_hint 全程零帧、零 session.exited、occupancy 复位 idle）',
		hintsAfter.length === 0 && exitedAfter.length === 0 && Boolean(occIdle),
		{
			channel: 'B',
			expected: 'stall_hint=0 exited=0 occupancy turn=idle',
			actual: `stallHint=${hintsAfter.length} exited=${exitedAfter.length} occupancy=${occIdle ? JSON.stringify(occIdle.payload).slice(0, 150) : '未见 idle 帧'}`,
		},
	)
	await ev.shot(ui.page, 'a3-after-answer-idle')

	log(`done sid=${sid} waited=${Math.round(waitedMs / 1000)}s complete=${end.type}`)
	return { uncovered, gotchas }
}
