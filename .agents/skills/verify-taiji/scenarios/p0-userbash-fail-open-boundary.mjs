/**
 * p0-userbash-fail-open-boundary —— V8 拦截层 fail-open 边界：构造失败命令照常官方执行
 * （completion-signal-delivery 设计 §4.1 V8 / §4.2 AX5；验收项 A9，D0 约定名，
 * 2026-11-02 前置组装义务履行入库——同链组装先例 p0-userbash-abort-channel（A8，user bash
 * 驱动形态）与 p0-notify-criteria-four-state-truth（A3，ext log warn 断言口径）。
 *
 * 驱动通道：`message.bash` RPC（用户输入框直发 `!` 命令的协议层入口，A8 同款）→
 * runtime bash-dispatcher sendBash → pi bash RPC → emitUserBash → user-bash-interceptor
 * handleUserBash。fail-open 注入面 = prepareUserBashWrap 的 writeFileSync(cmdShPath)：
 * background-tasks 目录 chmod 0o500 后 mkdirSync(recursive) 对已存在目录 no-op 不抛、
 * 写三文件 EACCES 原样抛出 → handler catch → logger.warn（ext log 落盘）→ 返回 undefined
 * 走官方执行——AX5：构造失败时 wrapper 从未 spawn，单次命令恰好一条执行路径。
 *
 * 路径（设计 V8 断言面三段）：①background-tasks 目录置只读（chmod 500，cmd.sh 写失败）
 * → ②直发 `!echo ok`：bashStart / bashResult 各恰 1 帧（无双执行）、exitCode=0 output 与
 * 官方直跑一致（无 [TAIJI-FG-BG] 标记行）、registry 零登记、ext log warn 留痕并指向恢复
 * 动作（check disk space / permissions）→ ③恢复目录权限后直发 `!sleep 5`：wrapper 进程组
 * 在场（包装格自动恢复）+ 正常完成收尾（exitCode=0、无残留、零登记）+ 权限复原核对。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	findRegistryEntry,
	pollUntil,
	psFind,
	readRegistry,
	registryPathOf,
} from './lib/fg-bg-lib.mjs'

/** fail-open 探针命令（设计 V8 步骤②原文 `!echo ok`；协议层 message.bash 收裸命令）。 */
const FAILOPEN_COMMAND = 'echo ok'
/** warmup 命令（令 tasksDir 经产品 mkdirSync 路径自然创建 + 通道基线；命令文本与探针不同，帧过滤互不命中）。 */
const WARMUP_COMMAND = 'echo warmup-ok'
/** 恢复探针命令（挂住可观察——包装格生效证据 = ps 观察 wrapper/cmd.sh 在场，echo 类快命令观察窗毫秒级；5s ≪ 缺省阈值 600s 不触转后台判定）。 */
const RECOVERY_COMMAND = 'sleep 5'
/** 包装脚本进程名（bin/taiji-fg-wrap，A8 同款锚）。 */
const WRAPPER_NAME = 'taiji-fg-wrap'
/** 转后台标记行前缀（官方执行形态断言：output 不含该标记 = 未走包装登记路径）。 */
const MARKER_TAG = '[TAIJI-FG-BG]'
/** 扩展名（extension-logger fileLog 文件名前缀，A3 同款）。 */
const EXT_NAME = 'base-tool-enhance'
/** fail-open warn 消息三锚（user-bash-interceptor.ts handler catch 分支 logger.warn 原文）。 */
const WARN_MARK = 'user_bash wrap prepare failed'
const WARN_FALLBACK_MARK = 'falling back to official execution'
const WARN_RECOVERY_HINT_MARK = 'check disk space / permissions'

export const meta = {
	id: 'p0-userbash-fail-open-boundary',
	priority: 'P0',
	title: 'V8：拦截层 fail-open——构造失败命令照常官方执行（无双执行 + warn 指向恢复动作 + 权限恢复后包装自动恢复）',
	covers: ['session.create', 'chat.bash'],
	requires: ['faux'],
	estimateSec: 150,
	faux: {
		// 全程无 LLM turn：user bash 不进 turn（A8 同款），探针均不触发 run
		responses: [],
	},
	env: {
		// 托管观测档：warn fileLog 落盘（runtime rpc-client extras 通道恒注入，此处显式
		// 声明对齐 A1/A2/A3 先例——warn 的 appendEntry 主通道不显 TUI，文件日志是断言载体）。
		TAIJI_AGENT_EXT_LOG: '1',
	},
	provable: [
		'C：注入在位——background-tasks 目录 chmod 0o500 后 mode 核对（cmd.sh 写失败注入面）',
		'B：fail-open 探针 `!echo ok` 照常受理执行（message.bash 回执 settled）',
		'C：无双执行——bashStart 恰 1 帧 + bashResult 恰 1 帧（AX5：构造失败 wrapper 从未 spawn，官方执行恰好一次）',
		'C：结果与官方直跑一致——exitCode=0、output 含 ok、无 [TAIJI-FG-BG] 标记行（官方执行形态）',
		'C：fail-open 零登记——registry 无 echo ok 条目（权限恢复后回读，防 500 窗口 EACCES 假阴性）',
		'C：warn 留痕并指向恢复动作——ext log（<dataDir>/agent/logs/base-tool-enhance-<日期>.log）warn 行含 user_bash wrap prepare failed + falling back to official execution + check disk space / permissions，且 data 关联本命令',
		'C：恢复自动生效——权限复原后直发 `!sleep 5`：本会话 background-tasks 锚行在场且含 taiji-fg-wrap（包装格恢复）',
		'C：恢复探针正常收尾——bashResult exitCode=0 + 回执 settled + ps 无残留 + registry 零登记（B2 透传）',
		'C：Cleanup 权限复原——目录 mode 恢复注入前原值（红灯路径兜底同覆盖）',
	],
	notProvable: [
		'warn 的用户可见面（TUI/notify 形态）：extension-logger 设计 warn 不显 TUI 不进 LLM——磁盘留痕（fileLog / appendEntry 会话 JSONL）是唯一载体，以 ext log 行为协议层代理（A1/A2/A3 同款口径；GUI 归 UI 剧本）',
		'「构造成功后 exec 无返回 undefined 分叉」的 handler 内部判定：真机以 bashResult 恰 1 帧代理；分叉布尔归 u2 单测（RL6 恰好一次；coverage.md A9 行分工：真机形态抽验，逐行判定归单测）',
		'cmd.sh 写失败的错误细节措辞（EACCES message 形态）：node fs 实现细节非断言面要求——err 原文随 warn data 落盘（命中行 attach 留证）',
	],
}

/** 读扩展日志文件全文（extension-logger fileLog：<dataDir>/agent/logs/<ext>-<日期>.log，A3 同款）。 */
function readExtLog(dataDir) {
	const today = new Date().toISOString().slice(0, 10)
	const logFile = path.join(dataDir, 'agent', 'logs', `${EXT_NAME}-${today}.log`)
	try {
		return fs.readFileSync(logFile, 'utf8')
	} catch {
		return ''
	}
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'chmod 500 注入点 = ext-sessions/<sid>/background-tasks/ 目录本身（cmd.sh/log/pid 与 registry.json 同目录）；mkdirSync(recursive) 对已存在只读目录 no-op 不抛——抛错点确为 writeFileSync(cmdShPath) EACCES，正是 prepareUserBashWrap 注释登记的 fail-open 注入面',
		'registry.json 与三文件同目录：fail-open 窗口内读 registry 会被 EACCES 静默吞成 null（断言假阴性风险）——零登记断言放权限恢复后回读',
		'TAIJI_AGENT_EXT_LOG=1 由 runtime spawn env 恒注入（rpc-client extras 通道，U3-3），场景 env 显式声明对齐 A1/A2/A3 先例；warn 的 appendEntry 主通道同内容写会话 JSONL（不显 TUI 不进 LLM）',
		'恢复探针用 sleep 5 而非快命令：包装格生效证据 = ps 观察 wrapper/cmd.sh 在场，echo 类快命令观察窗毫秒级抓不住（A8 用 sleep 300 同款理由）；5s 远小于缺省阈值 600s，不触转后台判定，B2 正常完成透传',
		'warmup（!echo warmup-ok）作用 = 令 tasksDir 经产品 mkdirSync 路径自然创建 + 通道基线；协议层包装/官方执行形态无差异（RL7 透传等价语义），包装生效证据只对挂住命令的 ps 观察成立',
	]
	const sidRef = { value: null }
	/** 只读注入目录（registryPathOf 的 dirname = 产品 prepareUserBashWrap 的 tasksDir 推导同源）。 */
	const tasksDirRef = { value: null }
	const originalModeRef = { value: null }

	/** 哨兵兜底清理（红灯路径残留）：只杀本会话 background-tasks 锚行与 sleep 5 精确行。 */
	const cleanupSentinel = () => {
		if (!sidRef.value) return []
		const anchor = `ext-sessions/${sidRef.value}/background-tasks/`
		const targets = [
			...psFind(anchor),
			...psFind(RECOVERY_COMMAND).filter((p) => p.command.trim() === RECOVERY_COMMAND),
		]
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
		// ── 1. 建会话（无 idle 配置注入：缺省阈值 600s 下包装格全量生效） ──
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-userbash-a9-'))
		const created = await protocol.call('session.create', { cwd, label: 'p0-userbash-a9' }, { timeoutMs: 120_000 })
		const sid = created.session?.id
		sidRef.value = sid
		ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
			channel: 'B',
			expected: 'session.id 非空',
			actual: JSON.stringify(created.session ?? {}).slice(0, 200),
		})
		if (!sid) throw new Error('session.create 未返回 sessionId')
		await protocol.subscribe(sid)
		tasksDirRef.value = path.dirname(registryPathOf(dataDir, sid))
		log(`session=${sid} cwd=${cwd} tasksDir=${tasksDirRef.value}`)

		// ── 2. warmup：通道基线 + tasksDir 经产品路径自然创建 ────────────────
		const sinceWarm = protocol.events.length
		const warmCall = protocol.call('message.bash', { sessionId: sid, command: WARMUP_COMMAND }, { replyType: 'message.status', timeoutMs: 90_000 })
		let warmFrame = null
		try {
			warmFrame = await protocol.waitFor((e) => e.type === 'message.bashResult' && e.payload?.command === WARMUP_COMMAND, { since: sinceWarm, timeoutMs: 60_000, sessionId: sid })
		} catch {
			/* 超时红由断言承载 */
		}
		let warmReply = null
		try {
			warmReply = await warmCall
		} catch (e) {
			ev.attach('warmup-reply-miss', String(e?.message ?? e).slice(0, 400))
		}
		const warmOk = warmFrame?.payload?.exitCode === 0 && String(warmFrame.payload?.output ?? '').includes('warmup-ok')
		ev.assert('B: warmup 命令正常执行（bashResult exitCode=0 且 output 含哨兵——通道基线）', warmOk, {
			channel: 'B',
			expected: `bashResult {command:${WARMUP_COMMAND}, exitCode:0, output 含 warmup-ok}`,
			actual: warmFrame ? `exitCode=${JSON.stringify(warmFrame.payload?.exitCode)} output=${JSON.stringify(String(warmFrame.payload?.output ?? '').slice(0, 120))}` : 'bashResult 帧未达',
		})
		// tasksDir 必须已存在（warmup 包装格构造路径 mkdirSync 创建）；缺席时场景按同源推导兜底创建，
		// 保证步骤 3 的 chmod 0o500 注入面成立（否则 mkdirSync(recursive) 会在可写父目录下新建成功目录，fail-open 不触发）
		if (!fs.existsSync(tasksDirRef.value)) {
			fs.mkdirSync(tasksDirRef.value, { recursive: true })
			ev.step({ step: 'tasksdir.seed', command: `mkdirSync ${tasksDirRef.value}`, exitCode: 0, stats: { seededBy: 'scenario' } })
			log(`tasksDir 缺席，场景兜底创建：${tasksDirRef.value}`)
		}

		// ── 3. 注入只读：background-tasks 目录 chmod 0o500（设计 V8 步骤①） ──
		const beforeMode = fs.statSync(tasksDirRef.value).mode & 0o777
		originalModeRef.value = beforeMode
		fs.chmodSync(tasksDirRef.value, 0o500)
		const injectedMode = fs.statSync(tasksDirRef.value).mode & 0o777
		ev.assert('C: 注入在位——background-tasks 目录已置只读（mode 0o500，cmd.sh 写失败注入面）', injectedMode === 0o500, {
			channel: 'C',
			expected: `mode=500（注入前 ${beforeMode.toString(8)}）`,
			actual: `mode=${injectedMode.toString(8)}`,
		})
		ev.step({ step: 'inject.readonly', command: `chmod 500 ${tasksDirRef.value}`, exitCode: injectedMode === 0o500 ? 0 : 1, stats: { beforeMode: beforeMode.toString(8), injectedMode: injectedMode.toString(8) } })

		// ── 4. fail-open 探针：直发 `!echo ok`（设计 V8 步骤②） ─────────────
		const since = protocol.events.length
		const callPromise = protocol.call('message.bash', { sessionId: sid, command: FAILOPEN_COMMAND }, { replyType: 'message.status', timeoutMs: 90_000 })
		let resultFrame = null
		try {
			resultFrame = await protocol.waitFor((e) => e.type === 'message.bashResult' && e.payload?.command === FAILOPEN_COMMAND, { since, timeoutMs: 60_000, sessionId: sid })
		} catch (e) {
			ev.attach('failopen-result-miss', String(e?.message ?? e).slice(0, 400))
		}
		let reply = null
		try {
			reply = await callPromise
		} catch (e) {
			ev.attach('failopen-reply-miss', String(e?.message ?? e).slice(0, 400))
		}
		// 帧计数（无双执行判据）：bashResult 到达后统计——该命令的全部帧已落事件流
		const startFrames = protocol.events.slice(since).filter((e) => e.type === 'message.bashStart' && e.payload?.command === FAILOPEN_COMMAND)
		const resultFrames = protocol.events.slice(since).filter((e) => e.type === 'message.bashResult' && e.payload?.command === FAILOPEN_COMMAND)
		ev.assert('B: fail-open 探针照常受理执行（message.bash 回执 settled，非拒收非挂起）', reply?.status === 'settled', {
			channel: 'B',
			expected: 'message.status settled（fail-open 后官方执行路径正常收尾）',
			actual: reply ? `status=${reply.status}${reply.error ? ` error=${String(reply.error).slice(0, 120)}` : ''}` : '回执未达（RPC 超时或失败）',
		})
		ev.assert('C: 无双执行——bashStart 恰 1 帧（执行发起恰一次）', startFrames.length === 1, {
			channel: 'C',
			expected: `bashStart(command=${FAILOPEN_COMMAND}) 计数=1`,
			actual: `count=${startFrames.length}`,
		})
		ev.assert('C: 无双执行——bashResult 恰 1 帧（AX5：构造失败 wrapper 从未 spawn，单次命令一条执行路径）', resultFrames.length === 1, {
			channel: 'C',
			expected: `bashResult(command=${FAILOPEN_COMMAND}) 计数=1`,
			actual: `count=${resultFrames.length}`,
		})
		const outText = String(resultFrame?.payload?.output ?? '')
		ev.assert('C: 结果与官方直跑一致——exitCode=0 且 output 含 ok', resultFrame?.payload?.exitCode === 0 && outText.includes('ok'), {
			channel: 'C',
			expected: 'exitCode=0 且 output 含 "ok"',
			actual: resultFrame ? `exitCode=${JSON.stringify(resultFrame.payload?.exitCode)} output=${JSON.stringify(outText.slice(0, 120))}` : 'bashResult 帧未达',
		})
		ev.assert('C: 官方执行形态——output 无 [TAIJI-FG-BG] 标记行（未走包装登记路径）', !outText.includes(MARKER_TAG), {
			channel: 'C',
			expected: `output 不含 ${MARKER_TAG}`,
			actual: outText.includes(MARKER_TAG) ? 'output 含标记行（意外走了包装路径）' : '无标记行',
		})
		if (resultFrame) ev.attach('failopen-bash-frame', JSON.stringify(resultFrame.payload, null, 2).slice(0, 2000))
		ev.step({
			step: 'userbash.failopen',
			command: `message.bash ${FAILOPEN_COMMAND}`,
			exitCode: reply?.status === 'settled' && startFrames.length === 1 && resultFrames.length === 1 && resultFrame?.payload?.exitCode === 0 && !outText.includes(MARKER_TAG) ? 0 : 1,
			stats: { startCount: startFrames.length, resultCount: resultFrames.length, exitCode: resultFrame?.payload?.exitCode ?? null, bashReply: reply?.status ?? null },
		})

		// ── 5. warn 留痕断言：ext log warn 行三锚 + 命令关联 ─────────────────
		const warnLine = await pollUntil(() => {
			const line = readExtLog(dataDir).split('\n').find((l) => l.includes(WARN_MARK))
			return line ?? null
		}, { timeoutMs: 15_000, intervalMs: 500 })
		ev.assert('C: warn 留痕——ext log 含 user_bash wrap prepare failed（handler catch 分支执行证据）', Boolean(warnLine), {
			channel: 'C',
			expected: `${EXT_NAME}-<日期>.log 存在含「${WARN_MARK}」的 warn 行`,
			actual: warnLine ? 'warn 行命中' : '15s 内未观察到（warn 未落盘或 fileLog 通道未开）',
		})
		if (warnLine) ev.attach('failopen-warn-line', warnLine.slice(0, 600))
		ev.assert('C: warn 指向恢复动作——行含 fail-open 语义与磁盘/权限检查指引', Boolean(warnLine) && warnLine.includes(WARN_FALLBACK_MARK) && warnLine.includes(WARN_RECOVERY_HINT_MARK), {
			channel: 'C',
			expected: `warn 行含「${WARN_FALLBACK_MARK}」与「${WARN_RECOVERY_HINT_MARK}」`,
			actual: warnLine ? (warnLine.includes(WARN_FALLBACK_MARK) && warnLine.includes(WARN_RECOVERY_HINT_MARK) ? '两锚均在' : `缺锚：fallback=${warnLine.includes(WARN_FALLBACK_MARK)} hint=${warnLine.includes(WARN_RECOVERY_HINT_MARK)}`) : 'warn 行未命中',
		})
		ev.assert('C: warn 关联本命令——data 含命令原文 echo ok', Boolean(warnLine) && warnLine.includes(FAILOPEN_COMMAND), {
			channel: 'C',
			expected: `warn 行 data 含 ${FAILOPEN_COMMAND}`,
			actual: warnLine ? (warnLine.includes(FAILOPEN_COMMAND) ? 'data.command 命中' : 'data 未含本命令（warn 属其他事件）') : 'warn 行未命中',
		})

		// ── 6. 恢复目录权限（设计 V8 步骤③前半）+ fail-open 零登记回读 ──────
		fs.chmodSync(tasksDirRef.value, originalModeRef.value)
		const restoredMode = fs.statSync(tasksDirRef.value).mode & 0o777
		ev.assert('C: 目录权限复原（注入解除，mode 回注入前原值）', restoredMode === originalModeRef.value, {
			channel: 'C',
			expected: `mode=${originalModeRef.value.toString(8)}`,
			actual: `mode=${restoredMode.toString(8)}`,
		})
		// 零登记断言放权限恢复后：500 窗口内 readRegistry 会被 EACCES 静默吞成 null（假阴性）；
		// 若产品在 fail-open 时错登条目，该写入同样 EACCES 失败——恢复后回读无条目即零登记
		const failEntry = findRegistryEntry(readRegistry(dataDir, sid), FAILOPEN_COMMAND)
		ev.assert('C: fail-open 零登记——registry 无 echo ok 条目（官方执行不走登记链）', !failEntry, {
			channel: 'C',
			expected: `registry 无 ${FAILOPEN_COMMAND} 条目`,
			actual: failEntry ? JSON.stringify(failEntry).slice(0, 300) : '无条目',
		})

		// ── 7. 恢复探针：直发 `!sleep 5`——包装格自动恢复（设计 V8 步骤③后半） ──
		const sinceRec = protocol.events.length
		const recCall = protocol.call('message.bash', { sessionId: sid, command: RECOVERY_COMMAND }, { replyType: 'message.status', timeoutMs: 90_000 })
		const anchor = `ext-sessions/${sid}/background-tasks/`
		// 谓词判 .length 再返回非空数组或 null（A8 同款教训：裸空数组也是 truthy 会首轮即返回）
		const groupSeen = await pollUntil(
			() => {
				const hits = psFind(anchor)
				return hits.length > 0 ? hits : null
			},
			{ timeoutMs: 10_000, intervalMs: 300 },
		)
		const groupLines = groupSeen ?? []
		ev.assert('C: 权限恢复后包装自动恢复——本会话 wrapper/cmd.sh 进程在场（background-tasks 路径锚）', groupLines.length > 0, {
			channel: 'C',
			expected: `ps 含 ${anchor}（wrapper 与 cmd.sh 同目录路径）`,
			actual: groupLines.length > 0 ? groupLines.map((p) => `pid=${p.pid} ${p.command.trim().slice(0, 160)}`).join(' | ') : '10s 内未见（恢复后仍走官方执行——fail-open 未自动恢复）',
		})
		const wrapperSeen = groupLines.some((p) => p.command.includes(WRAPPER_NAME))
		ev.assert('C: 包装脚本在场（taiji-fg-wrap——包装格恢复生效证据）', wrapperSeen, {
			channel: 'C',
			expected: `ps 行含 ${WRAPPER_NAME}`,
			actual: wrapperSeen ? 'wrapper 行在场' : `background-tasks 锚行中无 ${WRAPPER_NAME}（${groupLines.length} 行）`,
		})
		if (groupLines.length > 0) ev.attach('recovery-ps', JSON.stringify(groupLines, null, 2))
		let recFrame = null
		try {
			recFrame = await protocol.waitFor((e) => e.type === 'message.bashResult' && e.payload?.command === RECOVERY_COMMAND, { since: sinceRec, timeoutMs: 45_000, sessionId: sid })
		} catch {
			/* 超时红由断言承载 */
		}
		let recReply = null
		try {
			recReply = await recCall
		} catch (e) {
			ev.attach('recovery-reply-miss', String(e?.message ?? e).slice(0, 400))
		}
		ev.assert('B: 恢复探针回执 settled（包装路径 B2 正常收尾回执）', recReply?.status === 'settled', {
			channel: 'B',
			expected: 'message.status settled',
			actual: recReply ? `status=${recReply.status}${recReply.error ? ` error=${String(recReply.error).slice(0, 120)}` : ''}` : '回执未达',
		})
		ev.assert('C: 恢复探针正常完成收尾——bashResult exitCode=0（wrapper wait 真实退出码透传）', recFrame?.payload?.exitCode === 0, {
			channel: 'C',
			expected: 'exitCode=0',
			actual: recFrame ? `exitCode=${JSON.stringify(recFrame.payload?.exitCode)}` : 'bashResult 帧未达',
		})
		const groupGone = await pollUntil(() => psFind(anchor).length === 0, { timeoutMs: 15_000, intervalMs: 300 })
		const residualGroup = psFind(anchor)
		ev.assert('C: 收尾后无进程残留（B2 三文件清理 + 进程自然退出）', Boolean(groupGone), {
			channel: 'C',
			expected: `${anchor} 锚行 0 条`,
			actual: residualGroup.length === 0 ? '无残留' : residualGroup.map((p) => `pid=${p.pid} ${p.command.trim().slice(0, 160)}`).join(' | '),
		})
		const recEntry = findRegistryEntry(readRegistry(dataDir, sid), RECOVERY_COMMAND)
		ev.assert('C: 恢复探针零登记（B2 正常完成不登记——转后台仅阈值触发，5s ≪ 600s）', !recEntry, {
			channel: 'C',
			expected: `registry 无 ${RECOVERY_COMMAND} 条目`,
			actual: recEntry ? JSON.stringify(recEntry).slice(0, 300) : '无条目',
		})
		ev.step({
			step: 'userbash.recovery',
			command: `message.bash ${RECOVERY_COMMAND}`,
			exitCode: groupLines.length > 0 && wrapperSeen && recReply?.status === 'settled' && recFrame?.payload?.exitCode === 0 && groupGone && !recEntry ? 0 : 1,
			stats: { groupCount: groupLines.length, wrapperSeen, exitCode: recFrame?.payload?.exitCode ?? null, bashReply: recReply?.status ?? null },
		})

		// ── 8. 红灯登记：核心链任一环缺席时如实 uncovered（不静默降级） ──────
		if (reply?.status !== 'settled' || startFrames.length !== 1 || resultFrames.length !== 1 || resultFrame?.payload?.exitCode !== 0 || outText.includes(MARKER_TAG) || !warnLine || !warnLine.includes(WARN_FALLBACK_MARK) || !warnLine.includes(WARN_RECOVERY_HINT_MARK) || failEntry || groupLines.length === 0 || !wrapperSeen || recFrame?.payload?.exitCode !== 0 || recEntry) {
			uncovered.push('V8 fail-open 边界链（无双执行/官方执行形态/warn 指向恢复动作/零登记/恢复后包装自动收复）存在红灯断言——按失败归因处置（docs/TROUBLESHOOTING.md），不在本剧本内放宽')
		}
		log(`done sid=${sid} failOpenResult=${resultFrames.length === 1 && resultFrame?.payload?.exitCode === 0} warnHit=${Boolean(warnLine)} wrapperRecovered=${wrapperSeen}`)
		return { uncovered, gotchas }
	} finally {
		// 哨兵兜底清理（红灯路径残留进程）
		const killed = cleanupSentinel()
		if (killed.length > 0) {
			ev.step({ step: 'cleanup.sentinel', command: `kill background-tasks 锚行 + ${RECOVERY_COMMAND}`, exitCode: 0, stats: { pids: killed } })
			log(`哨兵兜底清理 killed=${JSON.stringify(killed)}`)
		}
		// 权限复原兜底（红灯路径注入残留防护——共享环境面纪律：chmod 注入必须用例结束恢复原权限）
		if (tasksDirRef.value && originalModeRef.value !== null && fs.existsSync(tasksDirRef.value)) {
			const cur = fs.statSync(tasksDirRef.value).mode & 0o777
			if (cur !== originalModeRef.value) {
				try {
					fs.chmodSync(tasksDirRef.value, originalModeRef.value)
					ev.step({ step: 'cleanup.chmod', command: `chmod ${originalModeRef.value.toString(8)} ${tasksDirRef.value}`, exitCode: 0, stats: { restoredMode: originalModeRef.value.toString(8) } })
					log(`权限兜底复原：${tasksDirRef.value} → ${originalModeRef.value.toString(8)}`)
				} catch (e) {
					ev.step({ step: 'cleanup.chmod', command: `chmod ${originalModeRef.value.toString(8)} ${tasksDirRef.value}`, exitCode: 1, stats: { error: String(e?.message ?? e).slice(0, 200) } })
				}
			}
		}
	}
}
