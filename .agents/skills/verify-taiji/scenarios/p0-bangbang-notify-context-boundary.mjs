/**
 * p0-bangbang-notify-context-boundary —— N3 `!!` 通道（不进 LLM 上下文档）转后台与
 * 完成通知上下文边界（completion-signal-delivery 设计 §4.1 N3 / GL2、GL4；验收项
 * A13，D0 约定名，2026-11-02 前置组装义务履行入库——同链组装先例
 * p0-userbash-hang-to-background-fullchain（A7，`!` 档转后台全链驱动形态，本场景
 * `!!` 档的对照组基线）与 p0-notify-criteria-four-state-truth（A3，通知 JSONL 取证
 * 口径）。2026-11-02 样本轮实测（探针 probe-a13-entries，verify-a13probe 实例）：
 *   ① `!!` 档（excludeFromContext=true）转后台 bash 的会话 JSONL 条目 =
 *      {type:'message', message:{role:'bashExecution', excludeFromContext:true, …}}
 *      ——exclude 条目照常落盘且字段随身（bash-effects.ts:20-25 探针①登记的现状
 *      语义：recordBashResult 对 exclude 无分支；pi 1.0.0 实测复核一致）；
 *   ② `!` 档（exclude 缺省）bashExecution 条目无 excludeFromContext 键（rpc-client
 *      undefined 不传键，走 pi 默认）；
 *   ③ 完成通知条目 = {type:'custom_message', customType:'background-bash', content,
 *      display:true, details, id, parentId, timestamp}——两档形态同构、均无 exclude
 *      类字段（桌面 custom_message 通用渲染通道，notify.ts:68；display:true = 用户
 *      可见载体字段）。
 *
 * 驱动通道：`message.bash` RPC（用户输入框直发的协议层入口，A7 同款）——`!!` 档 =
 * payload 显式 excludeFromContext:true（renderer composer 分流 packages/core/src/
 * domain/composer/dispatch/bash.ts:73-76 `!!` → excludeFromContext:true 的协议层
 * 等价形态），`!` 对照组 = 缺省不传（A7 同款）。任务经 idleBackgroundSec=30 静默
 * 转后台，完成通知经 port.deliver steer 注入唤醒新 run——faux 排 2 步应答。
 *
 * 断言面（设计 N3 通过标准）：完成通知条目存在于对话流（display:true 用户可见）；
 * 其上下文行为与该通道 bashResult 条目现状语义一致——`!!` bash 条目照常落盘 +
 * excludeFromContext:true 在场，通知条目两档同构（键集/display 同值/均无 exclude
 * 字段）= 通知通道不因 bash exclude 档位引入新分叉；`!` 对照组通知与 bash 条目同
 * 落盘语义。同会话串行两档（impl-plan A13 行：「`!` 单感叹号对照组断言依赖同一装配」）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	extractTaskId,
	findSessionFile,
	pollSessionFile,
	psFind,
	writeIdleConfig,
} from './lib/fg-bg-lib.mjs'

/** 空闲转后台阈值（秒，设计 N3 步骤①口径）。 */
const IDLE_SEC = 30
/** `!!` 档命令（设计 N3 步骤①原文 `!!sleep 90` 的协议层形态）。 */
const DOUBLE_COMMAND = 'sleep 90 && echo n3-double-done'
/** `!` 对照组命令（设计未指定时值——短于 `!!` 档以控总时长，转后台机制同一）。 */
const SINGLE_COMMAND = 'sleep 45 && echo n3-single-done'
/** bashResult 终态等待预算：阈值 + 25s 容差（A7 同款）。 */
const RESULT_WAIT_MS = (IDLE_SEC + 25) * 1000
/** 完成通知等待预算：任务剩余时长 + 守望 2s + steer 注入/run 开销。 */
const NOTIFY_WAIT_MS = 120_000
/** 通知幂等复查静默窗（A7/N2 同款）。 */
const IDEMPOTENT_SETTLE_MS = 8_000
/** 转后台用户向标记行（user-bash-interceptor USER_MARKER_NOTE——转后台成立锚）。 */
const USER_MARKER_ANCHOR = '已转后台'
/** 完成通知「结果未知」形态头行（notify.ts buildNotificationContent：转后台任务退出码结构性不可得）。 */
const NOTIFY_UNKNOWN_RE = /\[background-bash\][^\n]*finished \(exit code unknown[^\n]*\)/
/** 投递日志 outbox 条目的 customType（A3/A7 同款排除口径：每条通知结构性落两行）。 */
const OUTBOX_CUSTOM_TYPE = 'delivery-port-outbox'

export const meta = {
	id: 'p0-bangbang-notify-context-boundary',
	priority: 'P0',
	title: 'N3：`!!` 通道（不进 LLM 上下文档）转后台与完成通知上下文边界——通知进对话流且两档同构不分叉',
	covers: ['session.create', 'chat.bash'],
	requires: ['faux'],
	estimateSec: 420,
	faux: {
		responses: [
			// `!!` 档完成通知 steer 注入唤醒的新 run 应答（缺这步该轮以 faux 耗尽 error 收尾）
			{ text: 'A13-NOTIFY-ACK-DOUBLE', stopReason: 'stop' },
			// `!` 对照组完成通知唤醒的新 run 应答
			{ text: 'A13-NOTIFY-ACK-SINGLE', stopReason: 'stop' },
		],
	},
	provable: [
		'C：装配自检——idleBackgroundSec=30 写入扩展配置通道并读回核验',
		'B：`!!` 档直发转后台——bashResult 帧 excludeFromContext=true 且 output 尾部含用户向标记行（30s±开销带到达）',
		'C：`!!` 档 bashExecution 条目照常落盘且 excludeFromContext=true 在场（现状语义：exclude 只管 LLM 上下文、条目照常落盘）',
		'C：`!!` 档完成通知条目存在于对话流——custom_message 条目在场、customType=background-bash、display=true（用户可见）',
		'C：`!!` 档通知形态「结果未知」+ details.taskId 与转后台 taskId 一致（通知与任务锚定同一幂等键）',
		'C：上下文边界不引入新分叉——两档通知 custom_message 条目键集同构、display 同值 true、均无 excludeFromContext 字段（通知通道与 bash exclude 档位解耦）',
		'C：`!` 对照组 bashExecution 条目照常落盘且无 excludeFromContext 键（进上下文档缺省形态）',
		'C：`!` 对照组通知条目在场 display=true（与该档 bash 条目同落盘语义）',
		'C：`!` 对照组转后台成立（bashResult 帧 + registry running 条目）——对照组与 `!!` 档走同一装配机制',
		'B：两档完成通知各恰好 1 条（customStart 帧按 taskId 计数，+8s 静默窗复查不增）',
	],
	notProvable: [
		'LLM 上下文构造的真机直读（excludeFromContext 条目与 custom_message 条目是否实际进入发给模型的上下文）：faux 模型不消费上下文、产品无上下文内检探针——以条目字段在场性（bash 条目 excludeFromContext=true / 两档通知条目同构无 exclude 字段）作会话 JSONL 代理，pi 上游语义由 bash-effects.ts:20-25 探针①（0.84.1 dist 实测）与本场景 1.0.0 落盘形态复核共同锚定',
		'用户在输入框键入 `!`/`!!` 前缀的解析层（composer extractBashCommand 前缀剥离）：本剧本经 message.bash RPC（输入框直发的协议层入口）驱动——`!!` 档以 payload excludeFromContext:true 为协议层等价形态，键入解析归 UI',
		'bash 气泡与通知气泡的视觉渲染档位（GUI pane）：协议层无 UI 帧——以 display:true 字段与 custom_message 通用渲染通道语义（notify.ts:68）作协议层代理；GUI 渲染归 UI 剧本',
	],
}

/** 会话 JSONL 全量解析（坏行跳过；文件不存在 = []）。 */
function readEntries(sessionFile) {
	if (!sessionFile || !fs.existsSync(sessionFile)) return []
	const out = []
	for (const line of fs.readFileSync(sessionFile, 'utf8').split('\n')) {
		const t = line.trim()
		if (!t) continue
		try {
			out.push(JSON.parse(t))
		} catch {
			/* 尾部半行：跳过 */
		}
	}
	return out
}

/** bashExecution 落盘条目（role=bashExecution 的 message 条目，按 command 匹配）。 */
function bashExecutionEntries(entries, command) {
	return entries.filter((e) => e?.type === 'message' && e?.message?.role === 'bashExecution' && e?.message?.command === command)
}

/** 完成通知注入条目（type=custom_message 且 customType=background-bash；排除 outbox 投递日志行——后者 type=custom，A3/A7 同款口径）。 */
function notifyEntries(entries, taskId) {
	return entries.filter((e) => {
		if (e?.type !== 'custom_message' || e?.customType !== 'background-bash') return false
		return taskId ? String(e?.details?.taskId ?? '') === taskId || String(e?.content ?? '').includes(taskId) : true
	})
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'`!!` 档的协议层驱动形态：renderer composer 分流把 `!!` 前缀剥离后以 excludeFromContext:true 发 message.bash（bash.ts:73-76）——本场景直接发 payload excludeFromContext:true，等价于用户直发 `!!sleep 90 && echo …`',
		'两档 bashExecution 条目的 excludeFromContext 字段形态实测不同：`!!` 档显式 true、`!` 档（缺省）键缺席（rpc-client undefined 不传键）——「同落盘语义」按「照常落盘」承载，不按键值相等承载',
		'通知条目与 bash 条目形态不同构是现状设计而非分叉：bash = message entry（role=bashExecution），通知 = 专用 custom_message entry（桌面通用渲染通道）——「不引入新分叉」的断言对象是两档「之间」的通知形态（`!!` vs `!`），非通知与 bash 的形态差异',
		'通知 steer 注入唤醒新 run 消耗 1 个 faux step——responses 已排两档各一步；耗尽则该轮 error 收尾（通知条目仍进对话流，但唤醒链失态）',
		'会话 JSONL 落盘时机：通知唤醒 run 后 conversation 成立、文件创建——转后台阶段落盘的 bashExecution/pending 条目与通知条目同文件可取证（探针 probe-a13-entries 实测 14 行在场）；纯 bash 无通知会话不落盘（A6 基线）不适用本场景',
	]
	/** 哨兵兜底清理（红灯路径残留）：只杀本会话 cmd.sh 行与 sleep 精确行（A7 同款）。 */
	const sidRef = { value: null }
	const cleanupSentinel = () => {
		if (!sidRef.value) return []
		const anchor = `ext-sessions/${sidRef.value}/background-tasks/`
		const targets = [
			...psFind(anchor),
			...psFind('sleep 90').filter((p) => p.command.trim() === 'sleep 90'),
			...psFind('sleep 45').filter((p) => p.command.trim() === 'sleep 45'),
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
		// ── 1. 注入空闲阈值配置（热重载，先于 session 创建） ─────────────────
		const cfgPath = writeIdleConfig(dataDir, { idleBackgroundSec: IDLE_SEC })
		ev.step({ step: 'config.idle-inject', command: `write ${cfgPath}`, exitCode: 0, stats: { idleBackgroundSec: IDLE_SEC } })
		ev.assert('C: 装配自检——idleBackgroundSec=30 写入扩展配置通道', cfgPath.endsWith('base-tool-enhance-ext-config.json'), {
			channel: 'C',
			expected: '<dataDir>/agent/config/base-tool-enhance-ext-config.json',
			actual: cfgPath,
		})

		// ── 2. 建会话（临时 cwd，不污染 repo） ──────────────────────────────
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-bangbang-n3-'))
		const created = await protocol.call('session.create', { cwd, label: 'p0-bangbang-n3' }, { timeoutMs: 120_000 })
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
		let sessionFile = created.session?.sessionFile ?? findSessionFile(dataDir, sid)

		// ── 3. `!!` 档直发：sleep 90（excludeFromContext=true）→ 30s 转后台 ──
		const sinceDouble = protocol.events.length
		const doubleCall = protocol.call('message.bash', { sessionId: sid, command: DOUBLE_COMMAND, excludeFromContext: true }, { replyType: 'message.status', timeoutMs: 240_000 })
		let doubleStart = null
		try {
			doubleStart = await protocol.waitFor((e) => e.type === 'message.bashStart' && e.payload?.command === DOUBLE_COMMAND, { since: sinceDouble, timeoutMs: 60_000, sessionId: sid })
		} catch {
			/* bashStart 缺席由下方断言承载 */
		}
		ev.assert('B: `!!` 档命令执行开始广播（message.bashStart）', Boolean(doubleStart), {
			channel: 'B',
			expected: `bashStart 帧（command=${DOUBLE_COMMAND}）`,
			actual: doubleStart ? `at=${new Date(doubleStart.receivedAt).toISOString()} exclude=${doubleStart.payload?.excludeFromContext}` : '60s 内未观察到',
		})
		if (!doubleStart) throw new Error('`!!` 档 bashStart 未到达（message.bash 未被受理）')

		let doubleResult = null
		try {
			doubleResult = await protocol.waitFor((e) => e.type === 'message.bashResult' && e.payload?.command === DOUBLE_COMMAND, { since: sinceDouble, timeoutMs: RESULT_WAIT_MS, sessionId: sid })
		} catch {
			/* 超时红由断言承载 */
		}
		const doubleFrame = doubleResult?.payload ?? null
		const doubleReply = await doubleCall
		const doubleElapsedOk = doubleResult ? doubleResult.receivedAt - doubleStart.receivedAt <= RESULT_WAIT_MS : false
		ev.assert('B: `!!` 档转后台——bashResult 帧 30s±开销带到达（前台不等满 90s）', doubleResult !== null && doubleElapsedOk && doubleReply?.status === 'settled', {
			channel: 'B',
			expected: `bashResult ≤ ${RESULT_WAIT_MS / 1000}s ∧ status=settled`,
			actual: doubleResult ? `${doubleResult.receivedAt - doubleStart.receivedAt}ms status=${doubleReply?.status ?? 'no-reply'}` : `${RESULT_WAIT_MS / 1000}s 内未返回（转后台机制缺席）`,
		})
		const doubleOutput = String(doubleFrame?.output ?? '')
		ev.assert('C: `!!` 档 bashResult output 尾部含用户向标记行（已转后台去向说明）', doubleOutput.includes(USER_MARKER_ANCHOR), {
			channel: 'C',
			expected: `output 含「${USER_MARKER_ANCHOR}」标记行`,
			actual: doubleOutput ? doubleOutput.split('\n').filter((l) => l.trim()).slice(-1)[0]?.slice(0, 200) : '（output 为空）',
		})

		// ── 4. 等 `!!` 档任务完成（≈90s）→ 完成通知帧 ───────────────────────
		let doubleNotify = null
		try {
			doubleNotify = await protocol.waitFor((e) => e.type === 'message.customStart' && e.payload?.customType === 'background-bash' && e.receivedAt > (doubleResult?.receivedAt ?? 0), { sessionId: sid, timeoutMs: NOTIFY_WAIT_MS })
		} catch (e) {
			ev.attach('n3-double-notify-miss', String(e?.message ?? e).slice(0, 600))
		}
		ev.assert('B: `!!` 档完成通知帧到达（message.customStart background-bash）', doubleNotify !== null, {
			channel: 'C',
			expected: `customStart 帧（任务完成 ≈ 转后台后 ${90 - IDLE_SEC}s + 守望 + steer 注入）`,
			actual: doubleNotify ? `at=${new Date(doubleNotify.receivedAt).toISOString()}` : `${NOTIFY_WAIT_MS / 1000}s 内未达`,
		})
		const doubleTaskId = extractTaskId(doubleOutput) ?? extractTaskId(String(doubleNotify?.payload?.content ?? ''))
		if (doubleNotify) ev.attach('n3-double-notify-frame', JSON.stringify(doubleNotify.payload, null, 2).slice(0, 2000))

		// 等 `!!` 档通知唤醒 run 收尾（faux 步消费完），JSONL 稳定后定位会话文件
		await new Promise((r) => setTimeout(r, IDEMPOTENT_SETTLE_MS))
		if (!sessionFile || !fs.existsSync(sessionFile)) sessionFile = findSessionFile(dataDir, sid)

		// ── 5. `!!` 档 JSONL 取证：bashExecution 条目 + 通知条目 ────────────
		const doubleEntries = readEntries(sessionFile)
		const doubleBashEntries = bashExecutionEntries(doubleEntries, DOUBLE_COMMAND)
		const doubleBash = doubleBashEntries[0] ?? null
		ev.assert('C: `!!` 档 bashExecution 条目照常落盘且 excludeFromContext=true 在场（exclude 只管 LLM 上下文、条目照常落盘）', Boolean(doubleBash && doubleBash.message?.excludeFromContext === true), {
			channel: 'C',
			expected: "{role:'bashExecution', excludeFromContext:true} 条目在场",
			actual: doubleBash ? `excludeFromContext=${JSON.stringify(doubleBash.message?.excludeFromContext)} output 头行=${String(doubleBash.message?.output ?? '').split('\n')[0]?.slice(0, 120)}` : `条目缺席（sessionFile=${sessionFile ?? '未定位'}，总条目=${doubleEntries.length}）`,
		})
		if (doubleBash) ev.attach('n3-double-bash-entry', JSON.stringify(doubleBash, null, 2).slice(0, 2400))

		const doubleNotifies = notifyEntries(doubleEntries, doubleTaskId)
		const doubleNotifyEntry = doubleNotifies[0] ?? null
		ev.assert('C: `!!` 档完成通知条目存在于对话流（custom_message 在场、display=true 用户可见）', Boolean(doubleNotifyEntry && doubleNotifyEntry.display === true && doubleNotifyEntry.customType === 'background-bash'), {
			channel: 'C',
			expected: "{type:'custom_message', customType:'background-bash', display:true} 条目在场",
			actual: doubleNotifyEntry ? `display=${doubleNotifyEntry.display} type=${doubleNotifyEntry.type}` : `通知条目缺席（双行口径 outbox 行在场性另查；taskId=${doubleTaskId ?? '未锚定'}）`,
		})
		const doubleNotifyHead = doubleNotifyEntry ? (NOTIFY_UNKNOWN_RE.exec(String(doubleNotifyEntry.content ?? ''))?.[0] ?? null) : null
		ev.assert('C: `!!` 档通知为「结果未知」形态且 details.taskId 与转后台 taskId 一致（同一幂等键锚定）', Boolean(doubleNotifyHead && doubleNotifyEntry?.details?.taskId === doubleTaskId), {
			channel: 'C',
			expected: `content 头行 finished (exit code unknown…) ∧ details.taskId=${doubleTaskId ?? 'bt-…'}`,
			actual: `head=${doubleNotifyHead ? doubleNotifyHead.slice(0, 160) : '未匹配'} details.taskId=${doubleNotifyEntry?.details?.taskId ?? '缺席'}`,
		})
		if (doubleNotifyEntry) ev.attach('n3-double-notify-entry', JSON.stringify(doubleNotifyEntry, null, 2).slice(0, 2400))

		// ── 6. `!` 对照组直发（缺省档）：sleep 45 → 转后台 → 完成通知 ────────
		const sinceSingle = protocol.events.length
		const singleCall = protocol.call('message.bash', { sessionId: sid, command: SINGLE_COMMAND }, { replyType: 'message.status', timeoutMs: 180_000 })
		let singleStart = null
		try {
			singleStart = await protocol.waitFor((e) => e.type === 'message.bashStart' && e.payload?.command === SINGLE_COMMAND, { since: sinceSingle, timeoutMs: 60_000, sessionId: sid })
		} catch {
			/* 缺席由断言承载 */
		}
		let singleResult = null
		try {
			singleResult = await protocol.waitFor((e) => e.type === 'message.bashResult' && e.payload?.command === SINGLE_COMMAND, { since: sinceSingle, timeoutMs: RESULT_WAIT_MS, sessionId: sid })
		} catch {
			/* 超时红由断言承载 */
		}
		const singleReply = await singleCall
		const singleFrame = singleResult?.payload ?? null
		const singleOutput = String(singleFrame?.output ?? '')
		const singleTaskId = extractTaskId(singleOutput) ?? ''
		ev.assert('C: `!` 对照组转后台成立（bashResult 帧到达 + 标记行 + taskId 锚定）——与 `!!` 档同一装配机制', Boolean(singleResult && singleReply?.status === 'settled' && singleOutput.includes(USER_MARKER_ANCHOR) && singleTaskId), {
			channel: 'C',
			expected: 'bashResult settled ∧ output 含已转后台标记 ∧ bt- taskId',
			actual: singleResult ? `status=${singleReply?.status ?? 'no-reply'} marker=${singleOutput.includes(USER_MARKER_ANCHOR)} taskId=${singleTaskId || '未提取'}` : `${RESULT_WAIT_MS / 1000}s 内未返回`,
		})
		let singleNotify = null
		try {
			singleNotify = await protocol.waitFor((e) => e.type === 'message.customStart' && e.payload?.customType === 'background-bash' && e.receivedAt > (singleResult?.receivedAt ?? 0), { sessionId: sid, timeoutMs: NOTIFY_WAIT_MS })
		} catch (e) {
			ev.attach('n3-single-notify-miss', String(e?.message ?? e).slice(0, 600))
		}
		ev.assert('B: `!` 对照组完成通知帧到达', singleNotify !== null, {
			channel: 'C',
			expected: `customStart 帧（任务完成 ≈ 转后台后 ${45 - IDLE_SEC}s + 守望 + steer 注入）`,
			actual: singleNotify ? `at=${new Date(singleNotify.receivedAt).toISOString()}` : `${NOTIFY_WAIT_MS / 1000}s 内未达`,
		})
		// 等对照组通知唤醒 run 收尾 + JSONL 稳定
		await new Promise((r) => setTimeout(r, IDEMPOTENT_SETTLE_MS))
		if (!sessionFile || !fs.existsSync(sessionFile)) sessionFile = findSessionFile(dataDir, sid)

		// ── 7. 对照组 JSONL 取证 + 两档同构断言（不引入新分叉） ─────────────
		const finalEntries = readEntries(sessionFile)
		const singleBashEntries = bashExecutionEntries(finalEntries, SINGLE_COMMAND)
		const singleBash = singleBashEntries[0] ?? null
		ev.assert('C: `!` 对照组 bashExecution 条目照常落盘且无 excludeFromContext 键（进上下文档缺省形态）', Boolean(singleBash && singleBash.message?.excludeFromContext === undefined), {
			channel: 'C',
			expected: "{role:'bashExecution'} 条目在场 ∧ excludeFromContext 键缺席（rpc-client undefined 不传键）",
			actual: singleBash ? `excludeFromContext=${JSON.stringify(singleBash.message?.excludeFromContext)}（键在场=${Object.prototype.hasOwnProperty.call(singleBash.message ?? {}, 'excludeFromContext')}）` : '条目缺席',
		})
		const singleNotifies = notifyEntries(finalEntries, singleTaskId)
		const singleNotifyEntry = singleNotifies[0] ?? null
		ev.assert('C: `!` 对照组通知条目在场 display=true（与该档 bash 条目同落盘语义）', Boolean(singleNotifyEntry && singleNotifyEntry.display === true), {
			channel: 'C',
			expected: "{type:'custom_message', display:true} 条目在场",
			actual: singleNotifyEntry ? `display=${singleNotifyEntry.display}` : `通知条目缺席（taskId=${singleTaskId || '未锚定'}）`,
		})
		// 两档通知条目同构 = 通知通道不因 bash exclude 档位引入新分叉（N3「同款」期望的可证形态）
		const shapeOf = (n) => (n ? Object.keys(n).sort().join(',') : null)
		const doubleShape = shapeOf(doubleNotifyEntry)
		const singleShape = shapeOf(singleNotifyEntry)
		const bothNoExclude = Boolean(doubleNotifyEntry && singleNotifyEntry && !('excludeFromContext' in doubleNotifyEntry) && !('excludeFromContext' in singleNotifyEntry))
		ev.assert('C: 上下文边界不引入新分叉——两档通知条目键集同构、均无 excludeFromContext 字段（通知通道与 bash exclude 档位解耦）', Boolean(doubleShape && doubleShape === singleShape && bothNoExclude && doubleNotifyEntry.display === singleNotifyEntry.display), {
			channel: 'C',
			expected: `两档 custom_message 键集相等（${doubleShape ?? '待 `!!` 档取证'}）∧ 均无 excludeFromContext ∧ display 同值 true`,
			actual: `double=[${doubleShape}] single=[${singleShape}] noExclude=${bothNoExclude} display=${doubleNotifyEntry?.display}/${singleNotifyEntry?.display}`,
		})
		ev.step({ step: 'n3.context-boundary', command: `read ${path.basename(sessionFile ?? 'missing')}`, exitCode: doubleShape === singleShape && bothNoExclude ? 0 : 1, stats: { doubleShape, singleShape } })

		// ── 8. 幂等：+8s 静默窗后两档通知各恰好 1 条（帧计数） ───────────────
		await new Promise((r) => setTimeout(r, IDEMPOTENT_SETTLE_MS))
		const customStarts = protocol.events.filter((e) => e.type === 'message.customStart' && e.payload?.customType === 'background-bash')
		const doubleFrameCount = customStarts.filter((e) => JSON.stringify(e.payload ?? {}).includes(DOUBLE_COMMAND)).length
		const singleFrameCount = customStarts.filter((e) => JSON.stringify(e.payload ?? {}).includes(SINGLE_COMMAND)).length
		ev.assert('B: 两档完成通知各恰好 1 条（customStart 帧按命令锚定计数，+8s 静默窗复查不增）', doubleFrameCount === 1 && singleFrameCount === 1, {
			channel: 'B',
			expected: 'double=1 ∧ single=1（taskId 幂等）',
			actual: `double=${doubleFrameCount} single=${singleFrameCount}（总 customStart=${customStarts.length}）`,
		})
		ev.step({ step: 'n3.idempotent-recheck', command: 'protocol.events customStart count', exitCode: doubleFrameCount === 1 && singleFrameCount === 1 ? 0 : 1, stats: { double: doubleFrameCount, single: singleFrameCount } })

		// ── 9. 红灯登记：核心链任一环缺席时如实 uncovered（不静默降级） ─────
		const coreOk = Boolean(doubleBash?.message?.excludeFromContext === true && doubleNotifyEntry?.display === true && doubleShape === singleShape && bothNoExclude && singleBash && singleNotifyEntry?.display === true)
		if (!coreOk) {
			uncovered.push('N3 上下文边界断言面存在红灯（`!!` bash 条目落盘/通知条目在场/两档同构）——按失败归因处置（docs/TROUBLESHOOTING.md），不在本剧本内放宽')
		}
		log(`done sid=${sid} double=${doubleTaskId ?? '?'} single=${singleTaskId || '?'} shapes=${doubleShape === singleShape ? '同构' : '异构'}`)
		return { uncovered, gotchas }
	} finally {
		const killed = cleanupSentinel()
		if (killed.length > 0) {
			ev.step({ step: 'cleanup.sentinel', command: 'kill cmd.sh + sleep 90/45', exitCode: 0, stats: { pids: killed } })
			log(`哨兵兜底清理 killed=${JSON.stringify(killed)}`)
		}
	}
}
