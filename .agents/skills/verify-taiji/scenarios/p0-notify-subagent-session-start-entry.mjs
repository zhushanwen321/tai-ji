/**
 * p0-notify-subagent-session-start-entry —— V4 subagent 域补投：one-shot 成员完成通知
 * rejected 后经 session_start 边沿（重启）由维护链补投
 * （completion-signal-delivery 设计 §4.1 V4 / §4.2 RL14 真机面；验收项 A4，D0 约定名，
 * 2026-11-02 前置组装义务履行入库）。
 *
 * 装配：mock-http（本机 mock OpenPI 服务 + models.json 自定义 provider，零 token / 零外网）。
 * 孙进程 faux 不可达（p0-subagent-workflow-dispatch 探针结论），mock-http 是执行域唯一
 * 零 token 通道——canvas reviewer 形态 one-shot 成员经 PI_CODING_AGENT_DIR 读同一份
 * models.json 打到本机 mock server（先例 p0-subagent-workflow-dispatch 同款装配）。
 * TAIJI_AGENT_EXT_LOG=1：rejected 瞬间主会话文件被本剧本置只读，warn 的 appendEntry
 * 通道同步失败，降级文件日志（<agentDir>/logs/subagents-<date>.log，component 单源
 * core/logger.ts getLogger("subagents") → pi-host.ts createPiHostServices.log 桥接
 * extension-logger）是首败/重提 warn 的唯一落盘留痕（A1/A2 场景同款机制）。
 *
 * 路径（设计 V4 三步断言面）：
 *   ① 主会话派发一次性子代理任务（canvas reviewer 形态 = subagent_start 工具、非
 *   workflow origin；「双钩子之一拦截其完成通知投递」的钩子物理实现 = 主会话 JSONL
 *   chmod 0444——真实 persist 失败驱动：delivery-port persistOutboxRecord（delivery-port
 *   .ts:658-660/:671-686）appendFileSync EACCES → deliver 返回 rejected(persist-failed)。
 *   产品测试构建钩子按 impl-plan u4 属单测域，真机不可用，chmod 是验收资产侧等价驱动
 *   （V1/A1 场景先例，gotchas 登记）。时点锚 = turn #1 收尾（主 agent idle）后、成员
 *   引擎收尾前——窗口内主文件唯一强制写入是完成通知的 outbox persist（正是被测对象）。
 *   ② 子代理完成（record 终态落盘——ext-sessions 树 journal/.state 不受主文件 chmod
 *   影响；通知 rejected 仅 warn——首败 notifier.ts:556 + 单次重提仍败 notifier.ts:605
 *   双 warn 落 fileLog）。
 *   ③ 触发 session_start 边沿（重启——session_start 边沿的触发形态；切回是
 *   __taiji_bg_reconcile__ 补强边沿、不重发 session_start，属另一入口由 V4b 验收）：
 *   session.forceQuit（强杀 pi）→ session.restore（spawn 新 pi 附着同一会话文件——
 *   session-lifecycle.ts restoreSession；幂等短路不命中因 forceQuit 后 session 已
 *   exited）→ pi 重发 session_start → base-tool-enhance index.ts:72 重绑 SubagentService
 *   → notify-host.ts revive()（initSession 链内无条件）→ runReconcile("session_start")
 *   （notify-host.ts:337）→ 对账 record-store 三重判据 → 补投。
 *
 * 通过标准（设计 V4 通过栏）：父回合收到恰好 1 条子代理完成通知（notifyId 与主路径
 * 构造一致——id[:epoch] 形态，epoch = 世代标记）；补投 payload 与主路径同构（collectKey
 * 申报齐备——notifier.notify 对 round==null 通知申报 [record.id]，delivery-port.ts:656
 * outbox 条目 data 携带 collectKey 键集，collect_results 可收取）；record-store 扫描
 * 量级正常（对账时延预算内到达）。幂等：二次边沿后无第二条同 id 通知。
 *
 * 预期形态（2026-11-02 实测，A4-sample-r2 首跑证据 /tmp/verify-a4-sample）：段①②③
 * 全绿（钩子生效 / rejected 双 warn 恰各 1 + 近邻 ≤5s / 窗口内零通知零 outbox / record
 * 终态落盘含 canary / forceQuit+restore 重启完成）；对账编排被触发 16 次（fileLog
 * 「notify reconcile dispatch」——RL14 挂点接线正常）；段④ V4 通过标准四断言全红 =
 * 零补投（notify=0）。已定位结构性根因（设计-实现代差，非偶发缺陷）：对账候选判据
 * isLegacyClosedSettled = idle ∧ closedReason≠undefined（execution-record.ts:671），
 * 而 canvas reviewer 形态（tool origin one-shot）成功轮 markRoundIdle 落 idle 无
 * closedReason（run-orchestration.ts:815-834，万物可续 G1——「one-shot 完成即终态」
 * 的设计 V4 前提与实现现状不符）；legacy closed 写链唯一生产入口 = workflow-origin
 * D7 例外族（finalize-record.ts:53-56 + run-orchestration.ts:797-798 workflow 前置），
 * 又被 D5 排除位二整体排除（notify-reconcile.ts:151）；孤儿收编只写 stopReason 不写
 * closedReason（record-entry-write.ts:99）——tool origin record 在现行判据下无可达
 * 候选形态，session_start 维护链对该域完成通知结构性零补投。本剧本红灯是真机验收的
 * 正确产出（V4 断言面忠实设计原文），候选集扩位 / V4 载体改形态属产品/设计侧裁决，
 * 裁决前禁放宽断言绕缺陷换绿灯。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { findSessionFile, pollUntil } from './lib/fg-bg-lib.mjs'

/** 主队模型（mock server 队列键，先例同款）。 */
const MAIN_MODEL = 'mock-1'
/** 成员模型（canvas reviewer 形态 one-shot 成员的执行模型）。 */
const SUB_MODEL = 'mock-sub-a'
/** 成员 canary（子代理真的产出过 mock 回复的铁证，随 record.result 落盘）。 */
const SUB_CANARY = 'CANVAS_REVIEW_CANARY_A4_77e3'
/** turn #1 收尾哨兵（主队轮 2 文本——chmod 时点锚：主 agent idle 后成员仍在跑）。 */
const TURN1_SENTINEL = 'A4-SUBAGENT-DISPATCHED'
/** subagent 域通知 customType（extension-protocol custom-types.ts:29 NOTIFY_CUSTOM_TYPE 单源别名）。 */
const NOTIFY_CUSTOM_TYPE = 'subagent-bg-notify'
/** 投递日志 outbox 条目的 customType（delivery-port journal.ts，A1/A2 同款）。 */
const OUTBOX_CUSTOM_TYPE = 'delivery-port-outbox'
/** subagent-core logger 的 fileLog 文件名前缀（core/logger.ts getLogger("subagents")）。 */
const CORE_LOG_PREFIX = 'subagents'
/** 首败 rejected warn 消息串（notifier.ts:556 deliverViaPort rejected 分支）。 */
const FIRST_REJECT_MARK = 'retrying once via re-acquired port'
/** 重提仍败 warn 消息串（notifier.ts:605 retryDeliverOnce 单次停止位）。 */
const RETRY_REJECT_MARK = 'single retry spent'
/** 对账入口 debug 日志消息串（notify-reconcile.ts:263 RL14 边沿来源可辨；EXT_LOG 观测档以 info 落盘）。 */
const RECONCILE_DISPATCH_MARK = 'notify reconcile dispatch'
/** record id 前缀（record-access.ts:289 `sa-${crypto.randomUUID()}`）。 */
const RECORD_ID_PREFIX = 'sa-'
/** 补投到达预算（毫秒）：restore 返回 → initSession → 对账（毫秒级）→ 投递落盘。 */
const REDLIVERY_BUDGET_MS = 60_000
/** 幂等静默窗（毫秒）：覆盖重启后首个 agent_settled 对账边沿（A1 同款手段）。 */
const IDEMPOTENCE_QUIET_MS = 8_000
/** fileLog 行首时间戳宽度（ISO 8601 UTC，extension-logger index.ts toISOString）。 */
const ISO_TS_LEN = new Date().toISOString().length

export const meta = {
	id: 'p0-notify-subagent-session-start-entry',
	priority: 'P0',
	title: 'V4：one-shot 成员完成通知 rejected 后经 session_start 边沿（重启）补投——恰好 1 条、notifyId 同构、collectKey 申报齐备',
	covers: ['session.create', 'chat.send', 'chat.wait', 'subagent.dispatch', 'subagent.list'],
	requires: ['mock-http'],
	estimateSec: 240,
	llm: {
		responses: {
			[`mockllm/${MAIN_MODEL}`]: [
				{
					text: '派一个 canvas 评审子任务：',
					toolCalls: [
						{
							name: 'subagent_start',
							args: {
								task: 'Review the canvas: echo the canary word your scripted response contains, nothing else.',
								slug: 'canvas-reviewer',
								model: `mockllm/${SUB_MODEL}`,
								fork: false,
							},
						},
					],
					stopReason: 'toolUse',
				},
				// 轮 2：派发标记返回后主队收尾（turn #1 结束 → chmod 时点锚就绪）
				{ text: TURN1_SENTINEL, stopReason: 'stop' },
				// 轮 3+：重启后补投 steer/triggerTurn 唤醒新 run 的备用应答（补投唤醒世界
				// 消费、缺陷世界不消费——多备无害，A2 同款）
				{ text: 'A4-NOTIFY-ACK-1', stopReason: 'stop' },
				{ text: 'A4-NOTIFY-ACK-2', stopReason: 'stop' },
			],
			[`mockllm/${SUB_MODEL}`]: [
				// 成员队单步：canary 文本 + stop（引擎干净收尾 → 成功轮收尾边沿）
				{ text: SUB_CANARY, stopReason: 'stop' },
			],
		},
		mainModel: MAIN_MODEL,
		subModel: SUB_MODEL,
	},
	env: {
		// 托管观测档：subagents component 的 warn/debug fileLog 全量落盘（rejected 瞬间
		// appendEntry 通道被只读窗口拦截，文件日志是首败/重提 warn 的唯一落盘留痕）。
		TAIJI_AGENT_EXT_LOG: '1',
	},
	provable: [
		'C：装配自检——models.json 的 mock provider 指向本机 mock 服务且孙进程缺省模型含 mock-sub-a（先例同款）',
		'B：主会话派发 one-shot 子代理任务（session.getSubagents 出现 canvas-reviewer record）',
		'C：子代理完成且结果落盘（ext-sessions 树含 record 与 canary——record 终态落盘不受主文件只读影响）',
		'C：完成通知 rejected 仅 warn——首败 warn（retrying once via re-acquired port）恰 1 条',
		'C：rejected 处置阶梯①单次重提仍败 warn（single retry spent）恰 1 条，两 warn 近邻 ≤5s（同步链）',
		'C：只读窗口内主文件零通知注入、零投递日志条目（rejected = 幂等键未登记的结构性证据）',
		'C：重启后父回合收到恰好 1 条子代理完成通知（subagent-bg-notify entry 计数）',
		'C：notifyId 与主路径构造一致——id[:epoch] 形态（details.notifyId = record id）',
		'C：补投 payload 与主路径同构——outbox 条目 collectKey 申报含 record id（collect_results 可收取），details 携带 agent/result/notifyId',
		'C：record-store 扫描量级正常——重启后补投在 60s 预算内到达',
		'C：幂等——+8s 静默窗 + 二次对账边沿后通知计数恒 1（无第二条同 id）',
	],
	notProvable: [
		'「双钩子」的产品测试构建形态（仅测试构建暴露，N 次后自愈）：真机不可用（impl-plan u4 单测域）——本场景以 chmod 0444 真实 persist 失败等价驱动 rejected，rejected 处置阶梯不分成因（reason 只进 warn detail），V1/A1 场景先例',
		'UI 面：subagent 详情面板 / 通知气泡渲染（A 通道，归 UI 剧本）——本剧本只验执行层投递与落盘事实',
		'V4b 另两入口（切回补强 __taiji_bg_reconcile__ / agent_settled 回合收尾）：由 p0-notify-subagent-switchback-settled-entries（A5）分别验收，本场景只验 session_start 边沿',
	],
}

/** 读 subagents component 的 fileLog 全文（<agentDir>/logs/subagents-<date>.log）。 */
function readCoreLog(dataDir) {
	const today = new Date().toISOString().slice(0, ISO_TS_LEN).slice(0, 10)
	const logFile = path.join(dataDir, 'agent', 'logs', `${CORE_LOG_PREFIX}-${today}.log`)
	try {
		return { logFile, text: fs.readFileSync(logFile, 'utf8') }
	} catch {
		return { logFile, text: '' }
	}
}

/** 读指定 component 的 fileLog 全文（<agentDir>/logs/<component>-<date>.log）。 */
function readComponentLog(dataDir, component) {
	const today = new Date().toISOString().slice(0, ISO_TS_LEN).slice(0, 10)
	const logFile = path.join(dataDir, 'agent', 'logs', `${component}-${today}.log`)
	try {
		return fs.readFileSync(logFile, 'utf8')
	} catch {
		return ''
	}
}

/** 消息串出现次数（fileLog 单行一条）。 */
function countMark(text, mark) {
	let n = 0
	let i = text.indexOf(mark)
	while (i !== -1) {
		n += 1
		i = text.indexOf(mark, i + mark.length)
	}
	return n
}

/** 递归读目录下所有文本文件（体积上限保护，p0-subagent-workflow-dispatch 同款）。 */
function readTreeText(root, maxBytes = 4_000_000) {
	let total = 0
	const parts = []
	const walk = (dir, depth = 0) => {
		if (depth > 6 || total > maxBytes) return
		let entries = []
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const e of entries) {
			if (total > maxBytes) return
			const full = path.join(dir, e.name)
			if (e.isDirectory()) {
				walk(full, depth + 1)
				continue
			}
			const st = fs.statSync(full, { throwIfNoEntry: false })
			if (!st || st.size > 2_000_000) continue
			try {
				const text = fs.readFileSync(full, 'utf8')
				total += text.length
				parts.push(`# ${path.relative(root, full)}\n${text}`)
			} catch {
				/* 读失败跳过 */
			}
		}
	}
	if (fs.existsSync(root)) walk(root)
	return parts.join('\n')
}

/** 主文件注入通知 entry 行：customType=subagent-bg-notify 的 custom 条目（JSON.parse 成功）。 */
function notifyEntryLines(raw) {
	return raw.split('\n').filter((line) => {
		if (!line.includes(NOTIFY_CUSTOM_TYPE)) return false
		try {
			return JSON.parse(line)?.customType === NOTIFY_CUSTOM_TYPE
		} catch {
			return false
		}
	})
}

/** 投递日志 outbox 条目行（data.id 命中给定 id 集合任一）。 */
function outboxEntryLines(raw, ids) {
	return raw.split('\n').filter((line) => {
		if (!line.includes(OUTBOX_CUSTOM_TYPE)) return false
		try {
			const entry = JSON.parse(line)
			const data = entry?.data ?? entry
			return typeof data?.id === 'string' && data.id.startsWith(RECORD_ID_PREFIX) && ids.has(data.id)
		} catch {
			return false
		}
	})
}

/** 读主会话 JSONL 原文（只读窗口内读本剧本进程读不受写句柄影响，A1 同款）。 */
function readRaw(sessionFile) {
	try {
		return sessionFile ? fs.readFileSync(sessionFile, 'utf8') : ''
	} catch {
		return ''
	}
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir, repo, instance } = ctx
	const uncovered = []
	const gotchas = [
		'「双钩子」的真机物理实现 = 主会话 JSONL chmod 0444（真实 persist 失败驱动，非注入假失败）：产品侧测试构建钩子按 impl-plan u4 属单测域真机不可用；chmod 时点锚 = turn #1 收尾（主 agent idle）后、成员引擎收尾前——窗口内主文件唯一强制写入是完成通知的 outbox persist 与 record 簿记 entry（后者写失败仅损主文件投影，record 事实源在 ext-sessions 树不受影响，gotcha 已核）',
		'rejected 成因口径：persist-failed 驱动（delivery-port persistOutboxRecord EACCES）；subagent 域 notifier 与 bash 域共用进程级 delivery-port 槽（getDeliveryPort），rejected 处置阶梯不分成因（reason 只进 warn detail）',
		'成员完成与 chmod 的装配竞态：turn #1 收尾到成员引擎收尾边沿间隔为秒级（spawn + LLM 往返），chmod 同步亚毫秒生效——若偶发成员先完成（rejected warn 缺失断言红），重跑即消，属装配竞态非产品缺陷',
		'record 轮终态与对账候选的语义边界：one-shot 成功轮 markRoundIdle 落 idle（万物可续 G1）——设计 V4 步骤②「record 终态落盘」按「record 完成结果已持久化」口径断言（ext-sessions 树 journal settle 帧 + result canary），closedReason 有无不在断言面（补投候选判据语义归 D5，红灯归因时以 fileLog 对账日志与通知计数为裁决事实）',
		'【2026-11-02 A4-sample-r2 实测红灯归因】V4 通过标准四断言全红 = 零补投，根因 = 候选判据结构性不可达（非挂点缺失）：对账编排被触发 16 次（fileLog notify reconcile dispatch，RL14 接线正常）但零候选命中——canvas reviewer 形态（tool origin one-shot）成功轮落 idle 无 closedReason（run-orchestration.ts:815-834 markRoundIdle），对账候选判据 isLegacyClosedSettled（execution-record.ts:671 idle ∧ closedReason≠undefined）恒 false；legacy closed 唯一写链 = workflow origin 例外族（finalize-record.ts:53-56）且被 D5 排除位二封死（notify-reconcile.ts:151）；孤儿收编只写 stopReason（record-entry-write.ts:99）。判据扩位 / V4 载体改形态属产品/设计侧裁决，裁决前本剧本维持设计原文断言（红灯 = 忠实验收产出）',
	]

	// ── 0. 装配自检（先例 p0-subagent-workflow-dispatch 同款） ────────
	const topo = instance.llm
	const modelsJson = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'models.json'), 'utf8') || '{}')
	const provider = modelsJson.providers?.[topo.providerId]
	ev.assert('装配：models.json 的 mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
		channel: 'C',
		expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
		actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
	})
	const subCfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'subagents', 'config.json'), 'utf8') || '{}')
	ev.assert('装配：孙进程缺省模型 = mock-sub-a（subagents/config.json engineDefaults.pi）', String(subCfg.engineDefaults?.pi ?? '').includes(SUB_MODEL), {
		channel: 'C',
		expected: `engineDefaults.pi 含 ${SUB_MODEL}`,
		actual: subCfg.engineDefaults?.pi ?? '<缺>',
	})

	// ── 1. 段①：主会话派发一次性子代理任务（canvas reviewer 形态） ──
	const created = await protocol.call('session.create', { cwd: repo, label: 'p0-notify-sasentry' }, { timeoutMs: 120_000 })
	const sid = created.session?.id
	ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
		channel: 'B',
		expected: 'session.id 非空',
		actual: JSON.stringify(created.session ?? {}).slice(0, 200),
	})
	if (!sid) throw new Error('session.create 未返回 sessionId')
	await protocol.subscribe(sid)
	log(`session=${sid} model=${created.session?.modelId}`)
	ev.step({ step: 'session.create', channel: 'B', exitCode: 0, stats: { sessionId: sid, modelId: created.session?.modelId } })

	const since = protocol.events.length
	await protocol.send(sid, 'dispatch one canvas-reviewer subagent (p0-notify-subagent-session-start-entry 段①)')
	const end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
	ev.assert('B: turn #1 完成（subagent_start 派发轮收尾，主 agent idle）', end1.type === 'message.complete' && end1.ok, {
		channel: 'B',
		expected: 'message.complete + 主队轮 2 哨兵',
		actual: `${end1.type} stop=${end1.payload?.stopReason ?? 'n/a'}`,
	})

	// record 出现（getSubagents）+ 主文件定位（chmod 钩子装配面）。
	// reply 元素 id 字段名兼容两形态：SubagentRecord.id（assembly/types.ts:622）/
	// 快照形态 subagentId（session-view-types.ts:38）——以 attach 的原始 reply 为准。
	const deadlineRec = Date.now() + 90_000
	let records = []
	let record = null
	let lastSubagentsJson = '[]'
	while (Date.now() < deadlineRec) {
		const reply = await protocol.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 60_000 })
		records = reply.subagents ?? []
		lastSubagentsJson = JSON.stringify(records, null, 1).slice(0, 8_000)
		record = records.find((r) => String(r.slug ?? '') === 'canvas-reviewer') ?? records[0] ?? null
		if (record && (record.id ?? record.subagentId)) break
		await new Promise((r) => setTimeout(r, 500))
	}
	ev.attach('subagents-list-raw', lastSubagentsJson)
	ev.assert('B: 段① record 已派发（canvas-reviewer one-shot 成员在册）', Boolean(record?.id ?? record?.subagentId), {
		channel: 'B',
		expected: 'getSubagents 含 canvas-reviewer record 且 id 字段在列',
		actual: record ? `id=${record.id ?? record.subagentId} slug=${record.slug} status=${record.status}` : '90s 内无 record',
	})
	if (!record || (record.id ?? record.subagentId) === undefined) throw new Error('canvas-reviewer record 未出现（或 id 字段形态不符）——段②钩子无法锚定 record id')
	const recordId = record.id ?? record.subagentId

	const sessionFile = created.session?.sessionFile ?? (await pollUntil(() => findSessionFile(dataDir, sid), { timeoutMs: 15_000 }))
	if (!sessionFile) throw new Error('未定位到主会话 JSONL（chmod 钩子无法装配）')
	ev.step({ step: 'evidence.session-file', command: `locate ${sid}`, exitCode: 0, stats: { sessionFile } })

	// ── 2. 开钩子（chmod 0444——真实 persist 失败驱动） ─────────────
	// 时点锚：turn #1 已收尾（主 agent idle），成员引擎收尾边沿在秒级窗口之后——
	// 窗口内主文件唯一强制写入是完成通知的 outbox persist（被测对象）。
	const originalMode = fs.statSync(sessionFile).mode & 0o777
	fs.chmodSync(sessionFile, 0o444)
	const hookOn = (fs.statSync(sessionFile).mode & 0o777) === 0o444
	ev.assert('C: 双钩子已开（主会话文件置只读 0444——完成通知投递被拦截）', hookOn, {
		channel: 'C',
		expected: 'mode=0o444',
		actual: `mode=${(fs.statSync(sessionFile).mode & 0o777).toString(8)}（原 ${originalMode.toString(8)}）`,
	})
	ev.step({ step: 'hook.append-fail.on', command: `chmod 444 ${path.basename(sessionFile)}`, exitCode: hookOn ? 0 : 1, stats: { originalMode: originalMode.toString(8) } })

	// ── 3. 段②：子代理完成 → record 终态落盘 + 通知 rejected 仅 warn ──
	// chmod 段内所有证据采集用断言（不 throw），保证恢复权限必执行。
	let recordDiskText = ''
	try {
		// 等 rejected 双 warn（成员完成 → 轮终通知 deliver → persist 失败 → 首败 + 单次重提仍败）
		const rejectEvidence = await pollUntil(() => {
			const { text } = readCoreLog(dataDir)
			return text.includes(FIRST_REJECT_MARK) && text.includes(RETRY_REJECT_MARK) ? text : null
		}, { timeoutMs: 90_000, intervalMs: 1000 })

		const firstCount = countMark(rejectEvidence ?? '', FIRST_REJECT_MARK)
		const retryCount = countMark(rejectEvidence ?? '', RETRY_REJECT_MARK)
		const firstLine = (rejectEvidence ?? '').split('\n').find((l) => l.includes(FIRST_REJECT_MARK)) ?? null
		const retryLine = (rejectEvidence ?? '').split('\n').find((l) => l.includes(RETRY_REJECT_MARK)) ?? null
		ev.assert('C: 完成通知首败 rejected warn 恰 1 条（rejected 仅 warn——notifier.ts:556）', firstCount === 1 && Boolean(firstLine), {
			channel: 'C',
			expected: 'fileLog 含 1 条「retrying once via re-acquired port」',
			actual: `first=${firstCount}${firstLine ? `：${firstLine.slice(0, 200)}` : ''}`,
		})
		ev.assert('C: 处置阶梯①单次重提仍败 warn 恰 1 条（D7 单次停止位——notifier.ts:605）', retryCount === 1 && Boolean(retryLine), {
			channel: 'C',
			expected: 'fileLog 含 1 条「single retry spent」',
			actual: `retry=${retryCount}${retryLine ? `：${retryLine.slice(0, 200)}` : ''}`,
		})
		if (firstLine) ev.attach('reject-warn-first', firstLine)
		if (retryLine) ev.attach('reject-warn-retry', retryLine)

		// 双 warn 时间近邻 ≤5s（同步链「立即」重提——非定时器，A2 同款口径）
		let immediateMs = null
		if (firstLine && retryLine) {
			const t1 = Date.parse(firstLine.slice(0, ISO_TS_LEN))
			const t2 = Date.parse(retryLine.slice(0, ISO_TS_LEN))
			if (Number.isFinite(t1) && Number.isFinite(t2)) immediateMs = Math.abs(t2 - t1)
		}
		ev.assert('C: 重提「立即」性——双 warn 时间近邻 ≤5s', immediateMs !== null && immediateMs <= 5_000, {
			channel: 'C',
			expected: 'Δt ≤ 5000ms（deliver#1 rejected → 同步栈 deliver#2）',
			actual: immediateMs !== null ? `Δt=${immediateMs}ms` : 'warn 行时间戳不可解析',
		})

		// 结构性负向证据：只读窗口内主文件零通知注入、零投递日志条目
		const rawInWindow = readRaw(sessionFile)
		const notifyInWindow = notifyEntryLines(rawInWindow)
		const outboxInWindow = outboxEntryLines(rawInWindow, new Set([recordId]))
		ev.assert('C: 只读窗口内零通知注入、零投递日志条目（rejected = 幂等键未登记）', notifyInWindow.length === 0 && outboxInWindow.length === 0, {
			channel: 'C',
			expected: 'notify=0 / outbox=0（outbox 未落 = 主路径从未受理）',
			actual: `notify=${notifyInWindow.length} outbox=${outboxInWindow.length}`,
		})

		// record 终态落盘（ext-sessions 树——不受主文件只读影响）：record id 与 canary result 在盘
		recordDiskText = readTreeText(path.join(dataDir, 'ext-sessions', String(sid), 'subagents'))
		const recordOnDisk = recordDiskText.includes(recordId)
		const canaryOnDisk = recordDiskText.includes(SUB_CANARY)
		ev.assert('C: 子代理完成且 record 终态落盘（ext-sessions 树含 record id 与 canary result）', recordOnDisk && canaryOnDisk, {
			channel: 'C',
			expected: `subagents 树含 ${recordId} 与 ${SUB_CANARY}`,
			actual: `bytes=${recordDiskText.length} record=${recordOnDisk} canary=${canaryOnDisk}`,
		})
		ev.attach('subagents-disk', recordDiskText.slice(0, 120_000))
	} finally {
		// ── 4. 关钩子（恢复原权限）——重启后补投受理的前提 ─────────────
		fs.chmodSync(sessionFile, originalMode)
		const hookOff = (fs.statSync(sessionFile).mode & 0o777) === originalMode
		ev.assert('C: 双钩子已关（恢复原权限）', hookOff, {
			channel: 'C',
			expected: `mode=${originalMode.toString(8)}`,
			actual: `mode=${(fs.statSync(sessionFile).mode & 0o777).toString(8)}`,
		})
		ev.step({ step: 'hook.append-fail.off', command: `chmod ${originalMode.toString(8)} ${path.basename(sessionFile)}`, exitCode: hookOff ? 0 : 1, stats: {} })
	}

	// ── 5. 段③：触发 session_start 边沿（重启 = forceQuit + restore） ──
	await protocol.call('session.forceQuit', { sessionId: sid }, { replyType: 'message.status', timeoutMs: 60_000 })
	ev.step({ step: 'session.forceQuit', channel: 'B', exitCode: 0, stats: { sessionId: sid } })
	await new Promise((r) => setTimeout(r, 2_000)) // exited 收敛缓冲
	const restored = await protocol.call('session.restore', { sessionId: sid }, { timeoutMs: 120_000 })
	const restoredOk = Boolean(restored.session?.id)
	ev.assert('B: session.restore 重启完成（新 pi 附着同一会话——session_start 边沿触发形态）', restoredOk, {
		channel: 'B',
		expected: 'reply session.created 含同 sessionId',
		actual: JSON.stringify(restored.session ?? {}).slice(0, 200),
	})
	if (!restoredOk) throw new Error('session.restore 未返回 session——session_start 边沿未触发')
	await protocol.subscribe(sid).catch(() => {})
	ev.step({ step: 'session.restore', channel: 'B', exitCode: 0, stats: { sessionId: sid, restartedAt: Date.now() } })

	// 对账入口来源可辨观察项（RL14 佐证——EXT_LOG 观测档 debug 以 info 落盘）
	const { text: logAfterRestore } = readCoreLog(dataDir)
	const reconcileDispatch = countMark(logAfterRestore, RECONCILE_DISPATCH_MARK)
	ev.step({
		step: 'observe.reconcile-dispatch-log',
		channel: 'C',
		exitCode: 0,
		stats: { dispatchLogs: reconcileDispatch, note: 'RL14 边沿来源可辨观察项——runReconcile("session_start") 入口日志条数' },
	})

	// ── 6. V4 通过标准：父回合恰好 1 条补投 + notifyId/payload 同构 + 量级 ──
	const restoreReturnedAt = Date.now()
	const redelivery = await pollUntil(() => {
		const entries = notifyEntryLines(readRaw(sessionFile))
		return entries.length >= 1 ? entries : null
	}, { timeoutMs: REDLIVERY_BUDGET_MS, intervalMs: 1000 })
	const redeliveredMs = Date.now() - restoreReturnedAt

	const notifyLines = redelivery ?? []
	let notifyCount = 0
	let detailsNotifyId = null
	let detailsKeys = []
	for (const line of notifyLines) {
		try {
			const entry = JSON.parse(line)
			const details = entry?.details ?? {}
			detailsNotifyId = details.notifyId ?? detailsNotifyId
			detailsKeys = Object.keys(details)
			notifyCount += 1
		} catch {
			/* 坏行跳过 */
		}
	}
	ev.assert(`C: V4① 父回合收到恰好 1 条子代理完成通知（补投到达，时延 ${redeliveredMs}ms ≤ ${REDLIVERY_BUDGET_MS / 1000}s 预算——record-store 扫描量级正常）`, notifyCount === 1 && redeliveredMs <= REDLIVERY_BUDGET_MS, {
		channel: 'C',
		expected: `notify=1 且 Δt ≤ ${REDLIVERY_BUDGET_MS}ms`,
		actual: `notify=${notifyCount} Δt=${redeliveredMs}ms`,
	})
	ev.assert('C: V4② notifyId 与主路径构造一致（id[:epoch] 形态——details.notifyId = record id）', detailsNotifyId === recordId, {
		channel: 'C',
		expected: `details.notifyId = ${recordId}（epoch 0 裸 id）`,
		actual: `details.notifyId=${detailsNotifyId ?? '<缺>'} detailsKeys=[${detailsKeys.join(',')}]`,
	})

	// payload 同构：补投 outbox 条目 collectKey 申报 + details 事实齐备
	const rawAfter = readRaw(sessionFile)
	const outboxAfter = outboxEntryLines(rawAfter, new Set([recordId]))
	let collectKeyOk = false
	let outboxIdSeen = null
	for (const line of outboxAfter) {
		try {
			const entry = JSON.parse(line)
			const data = entry?.data ?? entry
			outboxIdSeen = data?.id ?? outboxIdSeen
			const keys = Array.isArray(data?.collectKey) ? data.collectKey : []
			if (keys.includes(recordId)) collectKeyOk = true
		} catch {
			/* 坏行跳过 */
		}
	}
	const detailsCarry = (() => {
		for (const line of notifyLines) {
			try {
				const d = JSON.parse(line)?.details ?? {}
				if (d.agent && d.notifyId) return { agent: d.agent, resultHasCanary: String(d.result ?? '').includes(SUB_CANARY) }
			} catch {
				/* skip */
			}
		}
		return null
	})()
	ev.assert('C: V4③ 补投 payload 与主路径同构（outbox collectKey 申报含 record id——collect_results 可收取；details 携带 agent 与 canary result）', collectKeyOk && Boolean(detailsCarry?.agent) && detailsCarry?.resultHasCanary === true, {
		channel: 'C',
		expected: `outbox data.collectKey 含 ${recordId} 且 details.agent/result(canary) 齐备`,
		actual: `collectKeyOk=${collectKeyOk} outboxId=${outboxIdSeen ?? '<缺>'} details=${JSON.stringify(detailsCarry ?? {}).slice(0, 200)}`,
	})
	ev.attach('notify-entries', notifyLines.join('\n').slice(0, 40_000))
	ev.attach('outbox-entries', outboxAfter.join('\n').slice(0, 40_000))
	// 端口层日志（base-tool-enhance component——bind/recover/replay/swallowed 的诊断
	// 出口）：补投计数断言红灯归因的事实源（重放窗口竞态 vs 对账重查的分判依据）。
	ev.attach('port-log', readComponentLog(dataDir, 'base-tool-enhance').slice(0, 60_000))

	// ── 7. 幂等：+8s 静默窗 + 二次对账边沿后无第二条 ─────────────────
	await new Promise((r) => setTimeout(r, IDEMPOTENCE_QUIET_MS))
	try {
		await protocol.call('session.getCommands', { sessionId: sid }, { timeoutMs: 30_000 })
	} catch {
		/* 二次边沿触发失败不吞断言——计数恒定断言仍有效 */
	}
	await new Promise((r) => setTimeout(r, 4_000))
	const finalCount = notifyEntryLines(readRaw(sessionFile)).length
	ev.assert('C: V4④ 幂等——静默窗 + 二次对账边沿后通知计数恒 1（无第二条同 id）', finalCount === 1, {
		channel: 'C',
		expected: `notify=1（+${IDEMPOTENCE_QUIET_MS / 1000}s 静默窗 + getCommands 补强边沿后）`,
		actual: `notify=${finalCount}`,
	})

	// 铁证观察：mock server 收到的成员模型请求（孙进程真的跑到 LLM）
	const allRequests = instance.mockLlm?.requests ?? []
	const childOk = allRequests.filter((r) => r.model === SUB_MODEL && r.status === 200)
	ev.step({
		step: 'mock.requests', channel: 'C', exitCode: 0,
		stats: { total: allRequests.length, childOk: childOk.length, models: [...new Set(allRequests.map((r) => r.model))].join(',') },
	})

	log(`done sid=${sid} recordId=${recordId} notify=${finalCount} firstWarn/redeliveredMs=${redeliveredMs}`)
	return { uncovered, gotchas }
}
