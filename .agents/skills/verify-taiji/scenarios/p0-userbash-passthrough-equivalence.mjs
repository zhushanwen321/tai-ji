/**
 * p0-userbash-passthrough-equivalence —— V5 `!` 命令正常路径零感知（透传等价）
 * （completion-signal-delivery 设计 §4.1 V5 / §4.2 RL7 真机面；验收项 A6，D0 约定名，
 * 2026-11-02 前置组装义务履行入库——同链组装先例 p0-notify-subagent-switchback-settled-entries
 * （A5）；A6.md「前置组装义务」条款：D0 当期剧本本体 new 态，执行前先组装入场景库并对
 * 样本数据实跑 exit 0 再经 wrapper 执行）。
 *
 * 驱动通道：`message.bash` RPC（用户输入框直发 `!` 命令的协议层入口）→ runtime
 * bash-dispatcher sendBash → pi bash RPC → rpc-mode handleBashCommand →
 * extensionRunner.emitUserBash → base-tool-enhance user_bash handler
 * （user-bash-interceptor.ts）——handler 返回 undefined = 官方本地执行；返回
 * { operations } = 包装执行（execWrappedUserBash，bin/taiji-fg-wrap）。命令不进
 * LLM turn，本场景零模型应答（无 faux / 无 llm，requires none——env 型装配）。
 *
 * 两组路径（设计 V5 三步断言面）：
 *   ① 关包装形态：注入 idleBackgroundSec=null（用户 opt-out 测试开关——
 *      shouldWrapUserBash 判定回落官方执行，user-bash-interceptor.ts:106-111），
 *      逐条执行 `ls`、`pnpm -v`、`exit 7`、读 stdin 命令（head -n 1）与 3s 锚点命令；
 *   ② 开包装形态：注入 idleBackgroundSec=600（机制在场默认档），重跑同组命令；
 *   ③ 逐条对比 bash 气泡终态协议层载体（message.bashResult 帧：output / exitCode /
 *      truncated / cancelled）+ 会话 JSONL bashExecution 落盘条目 + message.status
 *      回执（BashDispatchReceipt）。
 *
 * 通过标准（设计 V5 通过栏，四条 + 锚）：两形态结果文本逐字一致（豁免项同先例透传
 * 等价测试族：随机临时文件路径与耗时字段归一化后比对）；回执同为 settled；无登记
 * 条目、无任何通知（正常完成不进后台域）；bash 气泡 ephemeral 执行行行为一致；
 * 「包装在场」锚内置：组 2 锚点命令 3s 窗口 ps 抓 taiji-fg-wrap（先例第二批裁决
 * 同款——短命令执行窗口 <500ms ps 抓不到，没有锚则「透传等价」与「从未包装」同形
 * 全绿，剧本失去红灯能力）；对照组 1 锚点窗口断言无包装进程（开关真关上的区分度）。
 *
 * 观测面口径（2026-11-02 样本轮 A6-sample-r1 实测校准）：纯 `!` 命令会话不产生
 * 会话 JSONL——pi 上游语义「会话文件仅在首条 user/assistant 消息后创建」（pi
 * session-manager _hasConversation：bashExecution 不构成 conversation，setup 条目
 * 留内存防无对话残留文件）。因此「无任何通知」的权威载体 = 协议事件流全程无
 * message.customStart 帧（customType='background-bash'——完成通知进对话流的唯一
 * 推送通道）；会话 JSONL 原文复查降级为文件存在时的附加核对（纯 bash 会话无文件 =
 * 上游不落盘形态，不算红）。bashExecution 的 JSONL 落盘面同理不在本场景断言
 * （透传等价的含对话落盘形态由 V6 全链场景与 RL7 单测族承载）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { findSessionFile, pollUntil, psFind, readRegistry, registryPathOf, writeIdleConfig } from './lib/fg-bg-lib.mjs'

/** 开包装形态注入的空闲阈值（秒）：600 = 默认档（机制在场）。 */
const IDLE_SEC_ON = 600
/** 包装脚本进程名（bin/taiji-fg-wrap，与 bash-tool / user-bash-interceptor 同源）。 */
const WRAPPER_NAME = 'taiji-fg-wrap'
/** 锚点命令时长（秒）：3s——ps 采样 ~10 次，覆盖派发开销仍有富余。 */
const ANCHOR_SEC = 3
/** 锚点命令 ps 采样窗（毫秒）：执行时长 + 派发开销预算。 */
const ANCHOR_PS_WINDOW_MS = (ANCHOR_SEC + 4) * 1000

/** 各命令的输出哨兵（bashResult 帧按 command 原文匹配，命令文本本身即区分键）。 */
const LS_COMMAND = 'ls'
const PNPM_COMMAND = 'pnpm -v'
const EXIT_COMMAND = 'exit 7'
const STDIN_COMMAND = 'head -n 1'
const ANCHOR_MARK = 'UBASH-A6-ANCHOR'
const ANCHOR_COMMAND = `echo ${ANCHOR_MARK}-START && sleep ${ANCHOR_SEC} && echo ${ANCHOR_MARK}-DONE`
/** V5 命令集（设计 §4.1 V5 步骤①原文四条 + 锚点）。 */
const COMMANDS = [LS_COMMAND, PNPM_COMMAND, EXIT_COMMAND, STDIN_COMMAND, ANCHOR_COMMAND]
/** 通知原文锚：任何 [background-bash] 头行（正常完成零通知——应恒 0 条）。 */
const NOTIFY_ANY_RE = /\[background-bash\][^\n]*/g

/**
 * 归一化（设计 V5 豁免项：随机临时文件路径与耗时字段）：两形态各自执行，输出中的
 * 临时目录绝对路径（os.tmpdir() / /var/folders/… / /tmp/…）与耗时 token（1234ms /
 * 1.5s 形态）替换为占位符后比对。pnpm 版本号（10.18.3）无 ms/s 后缀不受影响；
 * fixture 文件名不含「数字+s」结尾，不被耗时规则误伤。
 */
function normalizeOutput(text) {
	let t = String(text ?? '')
	const tmpdir = os.tmpdir()
	if (tmpdir && tmpdir !== '/') t = t.split(tmpdir).join('<TMPDIR>')
	t = t.replace(/\/var\/folders\/[^\s:'"]+/g, '<TMPDIR>')
	t = t.replace(/\/tmp\/[^\s:'"]+/g, '<TMPDIR>')
	t = t.replace(/\b\d[\d,]*(?:\.\d+)?ms\b/g, '<DUR>')
	t = t.replace(/\b\d+(?:\.\d+)?s\b/g, '<DUR>')
	return t
}

export const meta = {
	id: 'p0-userbash-passthrough-equivalence',
	priority: 'P0',
	title: 'V5：`!` 命令正常路径零感知（透传等价）——关/开包装两形态结果逐字一致、回执同 settled、零登记零通知、包装在场锚',
	covers: ['session.create', 'chat.bash'],
	requires: ['none'],
	estimateSec: 240,
	provable: [
		'C：装配自检——组 1 配置 idleBackgroundSec=null（关包装）、组 2 =600（开包装），写入后读回核验',
		'B：组 1（关包装）五条命令逐条 message.status 回执 settled（官方直跑路径）',
		'B：组 2（开包装）五条命令逐条 message.status 回执 settled（包装路径）',
		'C：每条命令两形态 output 归一化后逐字一致（临时路径/耗时字段豁免）',
		'C：每条命令两形态 exitCode 一致（exit 7 → 7、head -n 1 → 0）；truncated 均 false、cancelled 均 false',
		'C：组 2 锚点命令 3s 窗口内包装进程在场（taiji-fg-wrap，ps 可见——证明走了包装路径）',
		'C：组 1 锚点命令 3s 窗口内无包装进程（对照形态——开关真关上，官方直跑无 taiji-fg-wrap）',
		'B：ephemeral 执行行行为一致——每条命令每形态 message.bashStart 恰 1 条、message.bashResult 恰 1 条',
		'C：registry 无任何登记条目（两组收尾各查一次，正常完成不进后台域）',
		'C：协议事件流全程无任何完成通知帧（message.customStart customType=background-bash 计数=0，+8s 静默窗复查仍为 0）',
		'C：会话 JSONL 原文无 [background-bash] 头行（文件存在时核对——纯 bash 会话上游不落盘 = 形态登记）',
	],
	notProvable: [
		'bash 气泡 ephemeral 执行行的视觉层（执行中文案、完成态渲染、消失行为）：协议层无 UI 帧——本剧本以 bashStart/bashResult 帧对为协议层代理断言；GUI 渲染归 UI 剧本',
		'truncated 脚注的非 false 形态（超长输出截断与 fullOutputPath 落盘）：V5 四条命令输出量级不触发截断，截断语义归透传等价单测族（RL7）与 V6 全链场景',
		'`!!`（excludeFromContext=true）档：归 N3 断言面（另一场景），本场景全走 `!` 进上下文档默认形态',
		'bashExecution 的会话 JSONL 落盘同形：纯 `!` 会话上游不落盘（pi _hasConversation——首条 user/assistant 消息前文件不创建，bashExecution 不构成 conversation），落盘面由含对话的 V6 全链场景与 RL7 单测族承载',
	],
}

/** 读扩展配置当前值（装配自检用；文件不存在 / 坏 JSON → null）。 */
function readIdleConfig(dataDir) {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'config', 'base-tool-enhance-ext-config.json'), 'utf8'))
		return parsed && typeof parsed === 'object' ? (parsed.idleBackgroundSec ?? null) : null
	} catch {
		return null
	}
}

/** 读会话 JSONL 原文（通知计数按原文统计）。 */
function readRaw(sessionFile) {
	try {
		return sessionFile ? fs.readFileSync(sessionFile, 'utf8') : ''
	} catch {
		return ''
	}
}

/**
 * 单形态跑完整命令集：逐条发 message.bash（bash↔bash 互斥——严格串行，上一条
 * settled 回执到达后才发下一条），收集 { reply, bashResult 帧, bashStart 计数 }。
 * bashResult 帧时序契约：sendBash await 命令完成后同步发布 bashResult、再回 settled
 * reply（bash-dispatcher.ts:176-186）——同一 WS 上帧先于 reply，call 返回后按
 * command + 组起始游标回捞必命中；waitFor 仅作兜底（防未来重排）。
 * ps 采样钩子（可选）：仅锚点命令执行期间并发轮询 psFind——锚点 3s 窗口是唯一可采样
 * 窗口（其余命令毫秒级，ps 200ms 间隔抓不到，先例 p1 同判据）；「包装在场/不在场」
 * 断言都锚在这一个窗口上。
 */
async function runCommandSet(ctx, sid, since, { psHook = null, label } = {}) {
	const { protocol, ev, log } = ctx
	const results = {}
	for (const command of COMMANDS) {
		const isAnchor = command === ANCHOR_COMMAND
		let psPromise = null
		if (psHook && isAnchor) {
			psPromise = pollUntil(psHook, { timeoutMs: ANCHOR_PS_WINDOW_MS, intervalMs: 200 })
		}
		const callPromise = protocol.call('message.bash', { sessionId: sid, command }, { replyType: 'message.status', timeoutMs: 120_000 })
		let frame = null
		try {
			frame = await protocol.waitFor(
				(e) => e.type === 'message.bashResult' && e.payload?.command === command,
				{ since, timeoutMs: 120_000, sessionId: sid },
			)
		} catch {
			/* 超时红由下方断言承载（帧缺席 = 终态未广播） */
		}
		const reply = await callPromise
		const startCount = protocol.events.slice(since).filter((e) => e.type === 'message.bashStart' && e.payload?.command === command).length
		const psSeen = psPromise ? await psPromise : undefined
		results[command] = { reply, frame: frame?.payload ?? null, startCount, psSeen }
		log(`[${label}] ${command} → reply=${reply.status} exit=${frame?.payload?.exitCode ?? '?'} start=${startCount}${psHook ? ` ps=${psSeen ? 'seen' : 'none'}` : ''}`)
		ev.step({ step: `${label}.bash`, command, exitCode: reply.status === 'settled' ? 0 : 1, stats: { replyStatus: reply.status, exitCode: frame?.payload?.exitCode ?? null, startCount, psSeen: psSeen === undefined ? undefined : Boolean(psSeen) } })
	}
	return results
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'关/开包装的测试开关 = 扩展配置 idleBackgroundSec（<dataDir>/agent/config/base-tool-enhance-ext-config.json，mtime+size 读时热重载）：null = 用户 opt-out 官方直跑（shouldWrapUserBash 回落），600 = 机制在场包装执行——场景运行中写文件即切换，无需重启',
		'组 1 锚点窗口「无包装进程」与组 2「包装在场」是一对区分度断言：只有组 2 有锚时，无法区分「开关生效走官方直跑」与「开关未生效但恰好输出一致」；对照窗口 ps 抓 taiji-fg-wrap 为空证明组 1 真走了官方路径',
		'读 stdin 命令（head -n 1）的透传语义 = 立即 EOF：包装 spawn stdio ignore 与官方本地执行 stdin 形态一致，两形态都零输出 exit 0（RL7 单测族同口径）',
		'归一化豁免项（设计 V5 同先例透传等价测试族）：随机临时文件路径（os.tmpdir() / /var/folders / /tmp）与耗时 token（ms/s 形态）——四条命令当前输出不产生这两类噪声，规则为防御性保留（未来命令集扩位不破逐字比对）',
		'【2026-11-02 样本轮 A6-sample-r1 实测事实基线（组装时点，供红灯归因参照）】纯 `!` 命令会话不产生会话 JSONL：pi session-manager _hasConversation 语义——会话文件仅在首条 user/assistant 消息后创建（bashExecution 不构成 conversation，防无对话 pi 留残留文件，pi 上游 #10000）；A6-sample-r1 实测 agent/sessions 树零文件、session.create 回执的 sessionFile 为预期路径 ENOENT（探针 probe-r2/r3 实证）。据此「无任何通知」权威载体 = 协议事件流 message.customStart 帧，JSONL 降级附加核对；bashExecution 落盘同形断言移除（provable/notProvable 已同步）',
	]

	// ── 1. 建会话（临时 cwd，预置 fixture 使 ls 输出非空且两形态稳定） ──
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-userbash-a6-'))
	fs.writeFileSync(path.join(cwd, 'userbash-v5-fixture.txt'), 'userbash v5 passthrough fixture\n')
	const created = await protocol.call('session.create', { cwd, label: 'p0-userbash-a6' }, { timeoutMs: 120_000 })
	const sid = created.session?.id
	ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
		channel: 'B',
		expected: 'session.id 非空',
		actual: JSON.stringify(created.session ?? {}).slice(0, 200),
	})
	if (!sid) throw new Error('session.create 未返回 sessionId')
	await protocol.subscribe(sid)
	log(`session=${sid} cwd=${cwd}`)
	// 会话 JSONL 仅作通知附加核对（纯 bash 会话上游不落盘——文件头观测面口径）：
	// 单次尽力定位不轮询（pollUntil 会白等 15s），收尾核对时再补定位一次
	let sessionFile = created.session?.sessionFile ?? findSessionFile(dataDir, sid)
	ev.step({ step: 'evidence.session-file', command: `locate ${sid}`, exitCode: 0, stats: { sessionFile: sessionFile ?? '未定位（纯 bash 会话可不落盘）' } })

	// ── 2. 组 1：关包装（idleBackgroundSec=null → 官方直跑） ──────────
	writeIdleConfig(dataDir, { idleBackgroundSec: null })
	await new Promise((r) => setTimeout(r, 800))
	const idleOff = readIdleConfig(dataDir)
	ev.assert('C: 装配自检——组 1 配置 idleBackgroundSec=null（关包装开关已注入）', idleOff === null, {
		channel: 'C',
		expected: 'idleBackgroundSec = null',
		actual: `配置读回 idleBackgroundSec=${JSON.stringify(idleOff)}`,
	})
	const since1 = protocol.events.length
	const group1 = await runCommandSet(ctx, sid, since1, {
		label: 'groupA-wrap-off',
		// 对照窗口钩子：锚点命令执行期间轮询 ps——关包装形态应全程无 wrapper
		psHook: () => psFind(WRAPPER_NAME)[0] ?? null,
	})
	const offRepliesSettled = COMMANDS.every((c) => group1[c].reply?.status === 'settled')
	ev.assert('B: 组 1（关包装）五条命令逐条回执 settled（官方直跑路径）', offRepliesSettled, {
		channel: 'B',
		expected: 'message.status 全部 settled',
		actual: COMMANDS.map((c) => `${c}=${group1[c].reply?.status ?? 'no-reply'}`).join(' | '),
	})
	const offNoWrapper = group1[ANCHOR_COMMAND].psSeen === undefined || group1[ANCHOR_COMMAND].psSeen === null
	ev.assert('C: 组 1 锚点命令 3s 窗口内无包装进程（对照形态——官方直跑无 taiji-fg-wrap）', offNoWrapper, {
		channel: 'C',
		expected: `锚点窗口 ps 无 ${WRAPPER_NAME}（开关 null = 官方直跑）`,
		actual: offNoWrapper ? '窗口内未见包装进程（官方直跑形态）' : `ps 命中：${JSON.stringify(group1[ANCHOR_COMMAND].psSeen)}`,
	})

	// ── 3. 组 2：开包装（idleBackgroundSec=600 → 包装执行） ──────────
	writeIdleConfig(dataDir, { idleBackgroundSec: IDLE_SEC_ON })
	await new Promise((r) => setTimeout(r, 800))
	const idleOn = readIdleConfig(dataDir)
	ev.assert('C: 装配自检——组 2 配置 idleBackgroundSec=600（开包装开关已注入）', idleOn === IDLE_SEC_ON, {
		channel: 'C',
		expected: `idleBackgroundSec = ${IDLE_SEC_ON}`,
		actual: `配置读回 idleBackgroundSec=${JSON.stringify(idleOn)}`,
	})
	const since2 = protocol.events.length
	const group2 = await runCommandSet(ctx, sid, since2, {
		label: 'groupB-wrap-on',
		// 「包装在场」锚：锚点命令执行窗口轮询 ps 抓 wrapper（3s 采样 ~10 次）
		psHook: () => psFind(WRAPPER_NAME)[0] ?? null,
	})
	const onRepliesSettled = COMMANDS.every((c) => group2[c].reply?.status === 'settled')
	ev.assert('B: 组 2（开包装）五条命令逐条回执 settled（包装路径）', onRepliesSettled, {
		channel: 'B',
		expected: 'message.status 全部 settled',
		actual: COMMANDS.map((c) => `${c}=${group2[c].reply?.status ?? 'no-reply'}`).join(' | '),
	})
	const wrapperSeen = group2[ANCHOR_COMMAND].psSeen
	ev.assert('C: 组 2 锚点命令 3s 窗口内包装进程在场（taiji-fg-wrap，ps 可见——证明走了包装路径）', Boolean(wrapperSeen), {
		channel: 'C',
		expected: `ps 含 ${WRAPPER_NAME}（${ANCHOR_SEC}s 窗口）`,
		actual: wrapperSeen ? `pid=${wrapperSeen.pid}` : '窗口内未见包装进程（开关未生效 / 未走包装路径——透传等价失去对照前提）',
	})
	if (wrapperSeen) ev.attach('wrapper-ps', JSON.stringify(wrapperSeen, null, 2))

	// ── 4. 透传等价逐条对比（两形态 bashResult 帧 + settled 回执） ────
	for (const command of COMMANDS) {
		const a = group1[command]
		const b = group2[command]
		const aOut = a.frame?.output
		const bOut = b.frame?.output
		const sameText = normalizeOutput(aOut) === normalizeOutput(bOut)
		ev.assert(`C: 「${command}」两形态 output 归一化后逐字一致`, a.frame && b.frame && sameText, {
			channel: 'C',
			expected: `关=${JSON.stringify(normalizeOutput(aOut ?? '')).slice(0, 200)}`,
			actual: `开=${JSON.stringify(normalizeOutput(bOut ?? '')).slice(0, 200)}（帧缺席：关=${Boolean(a.frame)} 开=${Boolean(b.frame)}）`,
		})
		const sameExit = (a.frame?.exitCode ?? undefined) === (b.frame?.exitCode ?? undefined)
		const expectedExit = command === EXIT_COMMAND ? 7 : 0
		ev.assert(`C: 「${command}」两形态 exitCode 一致且符合预期（期望 ${expectedExit}）`, sameExit && b.frame?.exitCode === expectedExit, {
			channel: 'C',
			expected: `exitCode=${expectedExit}`,
			actual: `关=${a.frame?.exitCode} 开=${b.frame?.exitCode}`,
		})
		ev.assert(`C: 「${command}」truncated 均 false、cancelled 均 false（正常完成无截断无中止）`, a.frame?.truncated === false && b.frame?.truncated === false && a.frame?.cancelled === false && b.frame?.cancelled === false, {
			channel: 'C',
			expected: 'truncated=false ∧ cancelled=false（两形态）',
			actual: `关(tr=${a.frame?.truncated},cx=${a.frame?.cancelled}) 开(tr=${b.frame?.truncated},cx=${b.frame?.cancelled})`,
		})
		// ephemeral 执行行行为一致：每命令每形态 bashStart 恰 1 条（执行开始广播），
		// bashResult 恰 1 条由 frame 唯一性承载（waitFor 命中即存在；计数此处补齐）
		const b2Count = protocol.events.slice(since2).filter((e) => e.type === 'message.bashResult' && e.payload?.command === command).length
		ev.assert(`B: 「${command}」ephemeral 执行行行为一致（两形态各 bashStart×1 + bashResult×1）`, a.startCount === 1 && b.startCount === 1 && b2Count === 1, {
			channel: 'B',
			expected: 'bashStart 关=1 开=1 ∧ bashResult（组 2 窗口）=1',
			actual: `start 关=${a.startCount} 开=${b.startCount} result（组 2 窗口）=${b2Count}`,
		})
		if (!sameText) ev.attach(`mismatch-${command}`, JSON.stringify({ off: aOut, on: bOut }, null, 2).slice(0, 8000))
	}

	// ── 5. 零登记（registry 空表） ───────────────────────────────────
	// 读盘前给收尾 IO 一个短窗；registry.json 可能不存在（无任何后台任务 = 最干净形态）
	await new Promise((r) => setTimeout(r, 1_500))
	const registryRaw = readRegistry(dataDir, sid)
	const entryValues = Array.isArray(registryRaw)
		? registryRaw
		: Array.isArray(registryRaw?.entries)
			? registryRaw.entries
			: Object.values(registryRaw?.entries ?? {})
	const entryCount = (entryValues ?? []).filter((e) => e && typeof e === 'object').length
	ev.assert('C: registry 无任何登记条目（正常完成不进后台域）', entryCount === 0, {
		channel: 'C',
		expected: 'entries 数 = 0（或 registry.json 不存在）',
		actual: registryRaw === null ? 'registry.json 不存在（零登记最干净形态）' : `entries 数 = ${entryCount}：${JSON.stringify(entryValues).slice(0, 300)}`,
	})
	ev.step({ step: 'evidence.registry-empty', command: `read ${registryPathOf(dataDir, sid)}`, exitCode: entryCount === 0 ? 0 : 1, stats: { entryCount, fileExists: registryRaw !== null } })

	// ── 6. 无任何完成通知（协议事件流权威 + JSONL 附加核对） ─────────
	// 权威载体 = 协议事件流：完成通知进对话流的唯一推送通道是 message.customStart 帧
	// （customType='background-bash'，event-adapter 翻译 pi custom message_start）。
	// +8s 静默窗复查（覆盖收尾 IO 与次生边沿）；会话 JSONL 为附加核对——纯 `!` 会话
	// 上游不落盘（见文件头观测面口径），文件不存在登记形态、不算红。
	await new Promise((r) => setTimeout(r, 8_000))
	sessionFile = sessionFile && fs.existsSync(sessionFile) ? sessionFile : findSessionFile(dataDir, sid)
	const notifyFrames = protocol.events.filter((e) => e.type === 'message.customStart' && e.payload?.customType === 'background-bash')
	ev.assert('C: 协议事件流全程无任何完成通知帧（message.customStart background-bash = 0，+8s 静默窗）', notifyFrames.length === 0, {
		channel: 'C',
		expected: 'count=0',
		actual: `count=${notifyFrames.length}${notifyFrames.length > 0 ? `：${JSON.stringify(notifyFrames.slice(0, 2).map((e) => e.payload)).slice(0, 300)}` : ''}`,
	})
	ev.step({ step: 'evidence.notify-frames', channel: 'C', exitCode: notifyFrames.length === 0 ? 0 : 1, stats: { notifyFrames: notifyFrames.length, totalEvents: protocol.events.length } })
	const sessionFileExists = Boolean(sessionFile && fs.existsSync(sessionFile))
	const notifyHeads = sessionFileExists ? (readRaw(sessionFile).match(NOTIFY_ANY_RE) ?? []) : []
	ev.assert('C: 会话 JSONL 原文无 [background-bash] 头行（文件存在时核对）', !sessionFileExists || notifyHeads.length === 0, {
		channel: 'C',
		expected: sessionFileExists ? 'count=0' : '会话文件不存在（纯 bash 会话上游不落盘形态——登记不算红）',
		actual: sessionFileExists ? `count=${notifyHeads.length}` : `会话文件未落盘（sessionFile=${sessionFile ?? '未定位'}）`,
	})

	if (!wrapperSeen) {
		uncovered.push('V5 透传等价断言未在包装路径上验证（组 2 锚点窗口无 taiji-fg-wrap 进程——开关未生效或包装链路缺席；透传等价本身可能仍绿但失去「包装路径」前提，归因后重跑）')
	}
	log(`done sid=${sid} wrapper=${wrapperSeen ? 'seen' : 'miss'} registry=${entryCount} notify=${notifyHeads.length}`)
	return { uncovered, gotchas }
}
