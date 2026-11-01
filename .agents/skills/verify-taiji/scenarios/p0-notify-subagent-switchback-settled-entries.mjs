/**
 * p0-notify-subagent-switchback-settled-entries —— V4b subagent 域补投另两入口：
 * 切回补强（__taiji_bg_reconcile__，同进程 reattach）与 agent_settled 回合收尾
 * （completion-signal-delivery 设计 §4.1 V4b / §4.2 RL14 真机面；验收项 A5，D0 约定名，
 * 2026-11-02 前置组装义务履行入库——同型组装先例 p0-notify-subagent-session-start-entry
 * （A4，session_start 边沿）；三入口合计覆盖 = V4 + V4b）。
 *
 * 装配：mock-http（本机 mock OpenPI 服务 + models.json 自定义 provider，零 token / 零
 * 外网；A4 同款）+ TAIJI_AGENT_EXT_LOG=1（rejected 瞬间主会话文件被本剧本置只读，warn
 * 的 appendEntry 通道同步失败，降级文件日志 <agentDir>/logs/subagents-<date>.log 是
 * 首败/重提 warn 与对账入口日志的唯一落盘留痕）。两组试验独立会话（设计 V4b 步骤①），
 * 组间 mockLlm.reset() 归零应答队列游标（mock-llm.mjs 头注登记的每组前置形态）。
 *
 * 两组路径（设计 V4b 三步断言面，段①同 V4 = A4 场景同款装配）：
 *   ① 每组主会话派发一次性子代理任务（canvas reviewer 形态 = subagent_start 工具）；
 *   turn #1 收尾后主会话 JSONL chmod 0444（双钩子的真机物理实现 = 真实 persist 失败
 *   驱动 rejected——delivery-port persistOutboxRecord EACCES，A1/A4 场景先例），成员
 *   完成通知 rejected 仅 warn（首败 notifier.ts:569 + 单次重提仍败 notifier.ts:625，
 *   双 warn 降级落 fileLog）；恢复权限。
 *   ②a 切回组：切走会话再切回（同进程 reattach，不重启）——协议层驱动 =
 *   session.getCommands RPC（切回后 renderer 必经查询；runtime 在此经 prompt(
 *   '/__taiji_bg_reconcile__') 补触发内部命令，session-service.ts maybeTriggerBgReconcile，
 *   节流已退役；A1 场景同一条产品代码路径）。期望边沿 = subagent 域对账被补强命令
 *   触发（subagents 日志 notify reconcile dispatch reason="resume"）。
 *   ②b agent_settled 组：不重启不切回，父回合继续一步小工作产生回合收尾（与 V9 同
 *   形态）——回合收尾边沿经 pi.on("agent_settled") 订阅触发对账（notify-host.ts:184，
 *   reason="agent_settled"）。
 *   ③ 分别核验补投到达与日志边沿来源可辨。
 *
 * 通过标准（设计 V4b 通过栏，四条）：两组各收到恰好 1 条子代理完成通知（notifyId 与
 * 主路径构造一致——id[:epoch] 形态）；日志可辨边沿来源（切回组 = 补强命令触发维护链
 * reason="resume"、agent_settled 组 = 回合收尾挂点触发 reason="agent_settled"——区别于
 * V4 的 session_start 路径）；全程未发生第三入口（切回组无重启、agent_settled 组无重启
 * 无切回——fileLog 按行首时间戳窗口核对）；无第二条同 id 通知（跨边沿幂等）。
 *
 * 已知事实基线（组装时点，供红灯归因参照，不构成本场景断言）：A4 实测曾判
 * product-bug（session_start 边沿零补投，候选判据 isLegacyClosedSettled 对万物可续
 * one-shot 形态结构性不可达），产品侧判据扩位修复后 A4 重验 pass（runId=A4-mvy72pte，
 * 26/26）。本场景验同一补投机制另两入口。切回入口装配现态（A5 缺陷修复后终态，
 * runId=A5-mvy87je8 曾判 product-bug：__taiji_bg_reconcile__ handler 仅接线 bash 域
 * 维护链，subagent 域对账切回边沿真机漏挂——组 a 5 断言红）：base-tool-enhance
 * handler 现经进程单例转发（SubagentService.runNotifyReconcileMaintenance →
 * NotifyHost.runReconcile，reason="resume"）补投 subagent 域；修复后重验组 a 若再红
 * = 已接线链路的回归产出（红灯归因入 gotchas，禁放宽断言绕缺陷换绿灯，升级裁决归
 * 产品/设计侧）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { findSessionFile, pollUntil } from './lib/fg-bg-lib.mjs'

/** 主队模型（mock server 队列键，A4 同款；两组组间 reset 归零复用同一队列）。 */
const MAIN_MODEL = 'mock-1'
/** 成员模型（canvas reviewer 形态 one-shot 成员的执行模型）。 */
const SUB_MODEL = 'mock-sub-a'
/** 成员 canary（子代理真的产出过 mock 回复的铁证，随 record.result 落盘）。 */
const SUB_CANARY = 'CANVAS_REVIEW_CANARY_A5_3f8a'
/** 组 a turn #1 收尾哨兵（主队轮 2 文本——chmod 时点锚：主 agent idle 后成员仍在跑）。 */
const SENTINEL_A = 'A5-GROUPA-DISPATCHED'
/** 组 b turn #1 收尾哨兵（两组共用同一主队队列——组间 reset 归零，哨兵断言以会话区分）。 */
const SENTINEL_B = SENTINEL_A
/** subagent 域通知 customType（extension-protocol custom-types.ts:29 NOTIFY_CUSTOM_TYPE 单源别名）。 */
const NOTIFY_CUSTOM_TYPE = 'subagent-bg-notify'
/** 投递日志 outbox 条目的 customType（delivery-port journal.ts，A1/A4 同款）。 */
const OUTBOX_CUSTOM_TYPE = 'delivery-port-outbox'
/** subagent-core logger 的 fileLog 文件名前缀（core/logger.ts getLogger("subagents")）。 */
const CORE_LOG_PREFIX = 'subagents'
/** base-tool-enhance logger 的 fileLog 文件名前缀（bash 域维护链派发日志落这里）。 */
const BTE_LOG_PREFIX = 'base-tool-enhance'
/** 首败 rejected warn 消息串（notifier.ts:569 deliver rejected 分支）。 */
const FIRST_REJECT_MARK = 'retrying once via re-acquired port'
/** 重提仍败 warn 消息串（notifier.ts:625 retryDeliverOnce 单次停止位）。 */
const RETRY_REJECT_MARK = 'single retry spent'
/** subagent 域对账入口 debug 日志消息串（notify-reconcile.ts:350，EXT_LOG 观测档以 info 落盘）。 */
const SUB_RECONCILE_MARK = 'notify reconcile dispatch'
/** bash 域维护链入口 debug 日志消息串（base-tool-enhance index.ts:156）。 */
const BTE_DISPATCH_MARK = 'reconcile maintenance dispatch'
/** record id 前缀（record-access.ts:289 `sa-${crypto.randomUUID()}`）。 */
const RECORD_ID_PREFIX = 'sa-'
/** 补投到达预算（毫秒）：边沿触发 → 对账（判据毫秒级）→ 投递落盘。 */
const REDLIVERY_BUDGET_MS = 60_000
/** 幂等静默窗（毫秒）：覆盖边沿后次生对账（补投唤醒 run 收尾再触发 agent_settled）。 */
const IDEMPOTENCE_QUIET_MS = 8_000
/** fileLog 行首时间戳宽度（ISO 8601 UTC，extension-logger toISOString）。 */
const ISO_TS_LEN = new Date().toISOString().length

export const meta = {
	id: 'p0-notify-subagent-switchback-settled-entries',
	priority: 'P0',
	title: 'V4b：subagent 域补投另两入口（切回补强 __taiji_bg_reconcile__ / agent_settled 回合收尾）——两组各恰 1 条、边沿来源可辨、无第三入口、跨边沿幂等',
	covers: ['session.create', 'chat.send', 'chat.wait', 'subagent.dispatch', 'subagent.list'],
	requires: ['mock-http'],
	estimateSec: 360,
	llm: {
		responses: {
			// 主队（两组共用同一队列；组间 instance.mockLlm.reset() 归零游标、各组从头消费）：
			//   轮 1 subagent_start 派发 → 轮 2 哨兵收尾（turn #1 结束 → chmod 时点锚）
			//   轮 3 组 b 小工作应答（turn #2 收尾 = agent_settled 边沿；组 a 补投红灯世界
			//   不消费）→ 轮 4+ 补投 steer/唤醒备用应答（补投唤醒世界消费——多备无害，A4 同款）
			//   消耗核算：组 a ≤3（派发/哨兵/唤醒）、组 b ≤5（派发/哨兵/小工作/唤醒 ≤2），5 备足。
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
				{ text: SENTINEL_A, stopReason: 'stop' },
				{ text: 'A5-GROUPB-WORK-DONE', stopReason: 'stop' },
				{ text: 'A5-NOTIFY-ACK-1', stopReason: 'stop' },
				{ text: 'A5-NOTIFY-ACK-2', stopReason: 'stop' },
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
		// 托管观测档：subagents / base-tool-enhance component 的 warn/debug fileLog 全量
		// 落盘（rejected 瞬间 appendEntry 通道被只读窗口拦截，文件日志是 warn 与对账
		// 入口日志的唯一落盘留痕；边沿来源辨析 = dispatch 行 detail.reason 精确匹配）。
		TAIJI_AGENT_EXT_LOG: '1',
	},
	provable: [
		'C：装配自检——models.json 的 mock provider 指向本机 mock 服务且孙进程缺省模型含 mock-sub-a（A4 同款）',
		'C：组 a（切回组）rejected 仅 warn——首败 warn（retrying once via re-acquired port）恰 1 条',
		'C：组 a 处置阶梯①单次重提仍败 warn（single retry spent）恰 1 条，两 warn 近邻 ≤5s（同步链）',
		'C：组 a 只读窗口内主文件零通知注入、零投递日志条目（rejected = 幂等键未登记的结构性证据）',
		'C：组 a 子代理完成且 record 结果落盘（ext-sessions 树含 record id 与 canary）',
		'B：组 a 切回补强边沿已派发——切回驱动 session.getCommands 后 base-tool-enhance 日志出现 reconcile maintenance dispatch reason="resume"',
		'C：组 a 补投恰好 1 条（60s 预算内到达）且 notifyId 与主路径构造一致（details.notifyId = record id）',
		'C：组 a 日志可辨边沿来源——subagents 日志 reason="resume" 对账派发（补强命令触发维护链，区别于 session_start 路径）',
		'C：组 a 无第三入口——切回后 subagents 日志无 reason="session_start" 对账派发（同进程 reattach 无重启）',
		'C：组 a 投递日志出现该 record id 的 outbox 条目（补投受理落盘）',
		'C：组 a 幂等——+8s 静默窗 + 二次边沿后通知计数恒 1（无第二条同 id）',
		'C：组 b（agent_settled 组）rejected 仅 warn——首败 + 重提双 warn 恰各 1 条',
		'C：组 b 只读窗口内零通知注入、零投递日志条目',
		'C：组 b 子代理完成且 record 结果落盘（ext-sessions 树含 record id 与 canary）',
		'B：组 b 父回合小工作轮收尾（turn #2 message.complete——agent_settled 边沿驱动形态）',
		'C：组 b 日志可辨边沿来源——subagents 日志 reason="agent_settled" 对账派发（回合收尾挂点触发）',
		'C：组 b 补投恰好 1 条（60s 预算内到达）且 notifyId 与主路径构造一致',
		'C：组 b 无第三入口——边沿后 subagents 日志无 reason="session_start" 派发（无重启）且 base-tool-enhance 日志无 reason="resume" 派发（无切回）',
		'C：组 b 投递日志出现该 record id 的 outbox 条目（补投受理落盘）',
		'C：组 b 幂等——+8s 静默窗（覆盖补投唤醒 run 收尾的次生 agent_settled 边沿）后通知计数恒 1',
	],
	notProvable: [
		'「双钩子」的产品测试构建形态（仅测试构建暴露，N 次后自愈）：真机不可用（impl-plan u4 单测域）——本场景以 chmod 0444 真实 persist 失败等价驱动 rejected，A1/A4 场景先例',
		'GUI「切走」动作的视觉层（pane 焦点切换渲染）：协议层无独立「切走」RPC——切回驱动 = session.getCommands（切回后 renderer 必经查询，runtime 补触发点，A1 场景同一条产品代码路径）；GUI 渲染细节归 UI 剧本',
		'V4 的 session_start 边沿（重启）：由 p0-notify-subagent-session-start-entry（A4）验收，本场景只验另两入口（设计 V4b 与 V4 合计三入口）',
		'UI 面：subagent 详情面板 / 通知气泡渲染（A 通道，归 UI 剧本）——本剧本只验执行层投递与落盘事实',
	],
}

/** 读指定 component 的 fileLog 全文（<agentDir>/logs/<component>-<date>.log）。 */
function readComponentLog(dataDir, component) {
	const today = new Date().toISOString().slice(0, ISO_TS_LEN).slice(0, 10)
	const logFile = path.join(dataDir, 'agent', 'logs', `${component}-${today}.log`)
	try {
		return { logFile, text: fs.readFileSync(logFile, 'utf8') }
	} catch {
		return { logFile, text: '' }
	}
}

/**
 * 时窗内指定 component 日志中，dispatch 行按 detail.reason 的计数表。
 * 行形态（extension-logger fileLog 实测，A4 port-log 佐证）：
 *   <ISO时间戳> [level] [component] <message> {"detail":{...,"reason":"..."}}
 * 只统计行首时间戳 ≥ sinceMs 的行（组间时窗切分——两组写同一进程级日志文件）。
 */
function dispatchReasonCounts(text, mark, sinceMs) {
	const counts = {}
	for (const line of text.split('\n')) {
		if (!line.includes(mark)) continue
		const ts = Date.parse(line.slice(0, ISO_TS_LEN))
		if (Number.isFinite(sinceMs) && (!Number.isFinite(ts) || ts < sinceMs)) continue
		const m = /"reason":"([a-z_]+)"/.exec(line)
		const reason = m?.[1] ?? '(unparsed)'
		counts[reason] = (counts[reason] ?? 0) + 1
	}
	return counts
}

/** 递归读目录下所有文本文件（体积上限保护，A4 同款）。 */
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

/**
 * 时窗 + recordId 过滤的 warn 行清单（组间共享同一进程级 fileLog 的隔离口径）：
 * 行含 mark、notifyId detail 含本组 record id、行首时间戳 ≥ sinceMs。
 * 首跑教训（A5-sample-r1）：无过滤时组 b 的 rejected 等待读到组 a 的 warn 行假阳性
 * 通过 → 提前 hook off → 本组成员轮终时主路径直投成功，两组断言全部失真。
 */
function warnLinesForRecord(text, mark, recordId, sinceMs) {
	return text.split('\n').filter((line) => {
		if (!line.includes(mark) || !line.includes(recordId)) return false
		const ts = Date.parse(line.slice(0, ISO_TS_LEN))
		return Number.isFinite(ts) && ts >= sinceMs
	})
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

/**
 * 单组试验段①（同 V4 = A4 场景同款装配）：派发 → turn #1 收尾 → record 在册 →
 * chmod 0444 → 成员完成 rejected 双 warn + record 结果落盘 → 恢复权限。
 * 返回 { sid, sessionFile, recordId, hookOffAt }。chmod 段内证据采集用断言不 throw
 * （finally 保证恢复权限必执行，A4 同款）。装配自检两组各验一次（独立会话独立证据）。
 */
async function runGroupPhase1(ctx, { label }) {
	const { protocol, ev, log, dataDir, repo, instance } = ctx

	// 装配自检
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

	// 段①-1：主会话派发一次性子代理任务
	const created = await protocol.call('session.create', { cwd: repo, label }, { timeoutMs: 120_000 })
	const sid = created.session?.id
	ev.assert(`B: [${label}] session.create 返回 sessionId`, Boolean(sid), {
		channel: 'B',
		expected: 'session.id 非空',
		actual: JSON.stringify(created.session ?? {}).slice(0, 200),
	})
	if (!sid) throw new Error(`[${label}] session.create 未返回 sessionId`)
	await protocol.subscribe(sid)
	log(`[${label}] session=${sid} model=${created.session?.modelId}`)
	ev.step({ step: `${label}.session.create`, channel: 'B', exitCode: 0, stats: { sessionId: sid } })

	const since = protocol.events.length
	await protocol.send(sid, `dispatch one canvas-reviewer subagent (${label} 段①)`)
	const end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
	ev.assert(`B: [${label}] turn #1 完成（subagent_start 派发轮收尾，主 agent idle）`, end1.type === 'message.complete' && end1.ok, {
		channel: 'B',
		expected: 'message.complete + 主队轮 2 哨兵',
		actual: `${end1.type} stop=${end1.payload?.stopReason ?? 'n/a'}`,
	})

	// record 出现（getSubagents；reply 元素 id 字段名兼容两形态，A4 同款）
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
	ev.attach(`${label}-subagents-list-raw`, lastSubagentsJson)
	ev.assert(`B: [${label}] 段① record 已派发（canvas-reviewer one-shot 成员在册）`, Boolean(record?.id ?? record?.subagentId), {
		channel: 'B',
		expected: 'getSubagents 含 canvas-reviewer record 且 id 字段在列',
		actual: record ? `id=${record.id ?? record.subagentId} slug=${record.slug} status=${record.status}` : '90s 内无 record',
	})
	if (!record || (record.id ?? record.subagentId) === undefined) throw new Error(`[${label}] canvas-reviewer record 未出现——段②钩子无法锚定 record id`)
	const recordId = record.id ?? record.subagentId

	const sessionFile = created.session?.sessionFile ?? (await pollUntil(() => findSessionFile(dataDir, sid), { timeoutMs: 15_000 }))
	if (!sessionFile) throw new Error(`[${label}] 未定位到主会话 JSONL（chmod 钩子无法装配）`)

	// 段①-2：开钩子（chmod 0444——时点锚 = turn #1 收尾后、成员引擎收尾前）
	const originalMode = fs.statSync(sessionFile).mode & 0o777
	fs.chmodSync(sessionFile, 0o444)
	const hookOn = (fs.statSync(sessionFile).mode & 0o777) === 0o444
	ev.assert(`C: [${label}] 双钩子已开（主会话文件置只读 0444——完成通知投递被拦截）`, hookOn, {
		channel: 'C',
		expected: 'mode=0o444',
		actual: `mode=${(fs.statSync(sessionFile).mode & 0o777).toString(8)}（原 ${originalMode.toString(8)}）`,
	})
	ev.step({ step: `${label}.hook.on`, command: `chmod 444 ${path.basename(sessionFile)}`, exitCode: hookOn ? 0 : 1, stats: {} })

	// 段①-3：等 rejected 双 warn + record 结果落盘（chmod 段内断言不 throw，finally 恢复）
	// warn 等待按时窗 + 本组 recordId 过滤（组间共享 fileLog 的隔离口径，见 helper 注释）
	const hookOnAt = Date.now()
	try {
		const rejectEvidence = await pollUntil(() => {
			const { text } = readComponentLog(dataDir, CORE_LOG_PREFIX)
			const first = warnLinesForRecord(text, FIRST_REJECT_MARK, recordId, hookOnAt)
			const retry = warnLinesForRecord(text, RETRY_REJECT_MARK, recordId, hookOnAt)
			return first.length >= 1 && retry.length >= 1 ? { first, retry } : null
		}, { timeoutMs: 90_000, intervalMs: 1000 })

		const firstLines = rejectEvidence?.first ?? []
		const retryLines = rejectEvidence?.retry ?? []
		const firstLine = firstLines[0] ?? null
		const retryLine = retryLines[0] ?? null
		ev.assert(`C: [${label}] 完成通知首败 rejected warn 恰 1 条（rejected 仅 warn——notifier.ts:569）`, firstLines.length === 1 && Boolean(firstLine), {
			channel: 'C',
			expected: 'fileLog 含 1 条本组 recordId 的「retrying once via re-acquired port」（hookOn 时窗内）',
			actual: `first=${firstLines.length}${firstLine ? `：${firstLine.slice(0, 200)}` : ''}`,
		})
		ev.assert(`C: [${label}] 处置阶梯①单次重提仍败 warn 恰 1 条（单次停止位——notifier.ts:625）`, retryLines.length === 1 && Boolean(retryLine), {
			channel: 'C',
			expected: 'fileLog 含 1 条本组 recordId 的「single retry spent」（hookOn 时窗内）',
			actual: `retry=${retryLines.length}${retryLine ? `：${retryLine.slice(0, 200)}` : ''}`,
		})
		if (firstLine) ev.attach(`${label}-reject-warn-first`, firstLine)
		if (retryLine) ev.attach(`${label}-reject-warn-retry`, retryLine)

		// 双 warn 时间近邻 ≤5s（同步链「立即」重提——A4 同款口径）
		let immediateMs = null
		if (firstLine && retryLine) {
			const t1 = Date.parse(firstLine.slice(0, ISO_TS_LEN))
			const t2 = Date.parse(retryLine.slice(0, ISO_TS_LEN))
			if (Number.isFinite(t1) && Number.isFinite(t2)) immediateMs = Math.abs(t2 - t1)
		}
		ev.assert(`C: [${label}] 重提「立即」性——双 warn 时间近邻 ≤5s`, immediateMs !== null && immediateMs <= 5_000, {
			channel: 'C',
			expected: 'Δt ≤ 5000ms（deliver#1 rejected → 同步栈 deliver#2）',
			actual: immediateMs !== null ? `Δt=${immediateMs}ms` : 'warn 行时间戳不可解析',
		})

		// 结构性负向证据：只读窗口内主文件零通知注入、零投递日志条目
		const rawInWindow = readRaw(sessionFile)
		const notifyInWindow = notifyEntryLines(rawInWindow)
		const outboxInWindow = outboxEntryLines(rawInWindow, new Set([recordId]))
		ev.assert(`C: [${label}] 只读窗口内零通知注入、零投递日志条目（rejected = 幂等键未登记）`, notifyInWindow.length === 0 && outboxInWindow.length === 0, {
			channel: 'C',
			expected: 'notify=0 / outbox=0（outbox 未落 = 主路径从未受理）',
			actual: `notify=${notifyInWindow.length} outbox=${outboxInWindow.length}`,
		})

		// record 结果落盘（ext-sessions 树——不受主文件只读影响）
		const recordDiskText = readTreeText(path.join(dataDir, 'ext-sessions', String(sid), 'subagents'))
		const recordOnDisk = recordDiskText.includes(recordId)
		const canaryOnDisk = recordDiskText.includes(SUB_CANARY)
		ev.assert(`C: [${label}] 子代理完成且 record 结果落盘（ext-sessions 树含 record id 与 canary result）`, recordOnDisk && canaryOnDisk, {
			channel: 'C',
			expected: `subagents 树含 ${recordId} 与 ${SUB_CANARY}`,
			actual: `bytes=${recordDiskText.length} record=${recordOnDisk} canary=${canaryOnDisk}`,
		})
		ev.attach(`${label}-subagents-disk`, recordDiskText.slice(0, 120_000))
	} finally {
		// 段①-4：关钩子（恢复原权限）——补投受理的前提
		fs.chmodSync(sessionFile, originalMode)
		const hookOff = (fs.statSync(sessionFile).mode & 0o777) === originalMode
		ev.assert(`C: [${label}] 双钩子已关（恢复原权限）`, hookOff, {
			channel: 'C',
			expected: `mode=${originalMode.toString(8)}`,
			actual: `mode=${(fs.statSync(sessionFile).mode & 0o777).toString(8)}`,
		})
		ev.step({ step: `${label}.hook.off`, command: `chmod ${originalMode.toString(8)} ${path.basename(sessionFile)}`, exitCode: hookOff ? 0 : 1, stats: {} })
	}

	return { sid, sessionFile, recordId, hookOffAt: Date.now() }
}

/** 通知行解析：details.notifyId / details 键集（A4 同款）。 */
function parseNotifyDetails(notifyLines) {
	let detailsNotifyId = null
	let detailsKeys = []
	for (const line of notifyLines) {
		try {
			const entry = JSON.parse(line)
			const details = entry?.details ?? {}
			detailsNotifyId = details.notifyId ?? detailsNotifyId
			detailsKeys = Object.keys(details)
		} catch {
			/* 坏行跳过 */
		}
	}
	return { detailsNotifyId, detailsKeys }
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir, instance } = ctx
	const uncovered = []
	const gotchas = [
		'切走/切回的协议层驱动：GUI「切走」无独立 RPC；切回驱动 = session.getCommands（切回后 renderer 必经查询，runtime 在此经 prompt("/__taiji_bg_reconcile__") 无条件补触发——session-service.ts maybeTriggerBgReconcile，60s 节流已退役；A1 场景同一条产品代码路径，非测试后门）',
		'「双钩子」的真机物理实现 = 主会话 JSONL chmod 0444（真实 persist 失败驱动）：chmod 时点锚 = turn #1 收尾（主 agent idle）后、成员引擎收尾前；成员完成与 chmod 的装配竞态（成员先完成 → rejected warn 缺失断言红）重跑即消，属装配竞态非产品缺陷（A4 gotcha 同款）',
		'两组共用进程级 fileLog（subagents-/base-tool-enhance-<date>.log），组间隔离口径 = 时窗 + 本组 recordId 双过滤：rejected warn 等待按 warnLinesForRecord（行含 mark + 本组 recordId + 时间戳 ≥ hookOnAt），dispatch 行 reason 计数按时间戳 ≥ hookOffAt——首跑（A5-sample-r1）组 b 曾因 warn 等待无过滤读到组 a 的 warn 行假阳性通过、提前 hook off 致本组成员轮终主路径直投成功（round 1 通知冒充补投），两组断言连带失真，已修',
		'组间 mock 应答队列隔离 = instance.mockLlm.reset()（mock-llm.mjs 头注登记的每组前置形态，游标归零）——组 a 补投唤醒轮的有无（绿灯消耗 1 个 ACK / 红灯 0 个）不影响组 b 从头消费',
		'【2026-11-02 A5-sample-r2 实测红灯归因（升级裁决事实源）】组 a（切回组）5 断言红 = RL14 三入口在 subagent 域「切回」入口真机漏挂（产品侧缺陷，非剧本装配问题）：切回补强命令确已到达并触发 bash 域维护链（base-tool-enhance 日志 reconcile maintenance dispatch reason="resume" 恰 1 条——getCommands → prompt("/__taiji_bg_reconcile__") 链路通），但 subagents 日志组 a 时窗 dispatch 计数 = {}（subagent 域对账零触发）→ 零补投（notify=0 / outbox=0）。根因 = __taiji_bg_reconcile__ handler（base-tool-enhance index.ts:112-118）仅调 bash 域 reconcilePendingEntries；subagent-core 对账导出 runNotifyReconcileMaintenance（subagent-core index.ts:272）全仓无包外消费者——其 index.ts:263 自述「切回入口生产接线 = 扩展侧/壳侧经本导出消费（reason=resume）」与实现不符（设计-实现代差，A4 判据代差的同族第二形态）。对照组：组 b（agent_settled 组）同轮全绿——补投形态与 A4 pass 实测同构（notifyId = 裸 record id、closed 终态通知、outbox collectKey 申报齐备、幂等恒 1），证明判据与补投通道正常、红灯仅切回入口缺席。修复方向（产品/设计侧裁决）：扩展侧命令 handler 补挂 subagent 域对账（经 subagent-core 导出，reason="resume"）或等价壳侧接线；裁决前本剧本维持设计原文断言（红灯 = 忠实验收产出，禁放宽断言绕缺陷换绿灯）',
	]

	// ── 组 a：切回组（切走会话再切回——__taiji_bg_reconcile__ 补强边沿） ──
	instance.mockLlm?.reset?.()
	log('组 a（切回组）开始——mock 队列游标已归零')
	const ga = await runGroupPhase1(ctx, { label: 'groupA-switchback' })

	// 段②a：切走会话再切回（同进程 reattach，不重启）——getCommands 切回必经查询
	try {
		await protocol.call('session.getCommands', { sessionId: ga.sid }, { timeoutMs: 30_000 })
	} catch (e) {
		ev.attach('groupA-get-commands-error', String(e?.message ?? e).slice(0, 300))
	}
	ev.step({ step: 'groupA.reconcile.edge.switchback', command: `session.getCommands ${ga.sid}`, exitCode: 0, stats: { edge: '__taiji_bg_reconcile__' } })

	// 补强边沿执行证据：bash 域维护链随补强命令派发（base-tool-enhance 日志 reason="resume"）
	const bteDispatched = await pollUntil(() => {
		const { text } = readComponentLog(dataDir, BTE_LOG_PREFIX)
		return dispatchReasonCounts(text, BTE_DISPATCH_MARK, ga.hookOffAt).resume >= 1 ? true : null
	}, { timeoutMs: 15_000, intervalMs: 500 })
	ev.assert('B: 组 a 切回补强边沿已派发（base-tool-enhance 日志 reason="resume"——补强命令触达维护链）', Boolean(bteDispatched), {
		channel: 'B',
		expected: 'reconcile maintenance dispatch {"detail":{"reason":"resume"}}',
		actual: bteDispatched ? '已派发' : `15s 内未见 resume 派发行——prompt 未达扩展（命令未注册 / 路由分支）`,
	})
	if (!bteDispatched) {
		const { text: bteTail } = readComponentLog(dataDir, BTE_LOG_PREFIX)
		ev.attach('groupA-bte-log-tail', bteTail.slice(-4000))
	}

	// 段③a：补投恰好 1 条 + notifyId 一致 + outbox 落盘
	const edgeAAt = Date.now()
	const redeliveryA = await pollUntil(() => {
		const entries = notifyEntryLines(readRaw(ga.sessionFile))
		return entries.length >= 1 ? entries : null
	}, { timeoutMs: REDLIVERY_BUDGET_MS, intervalMs: 1000 })
	const notifyLinesA = redeliveryA ?? []
	const redeliveredMsA = Date.now() - edgeAAt
	ev.assert(`C: 组 a 切回后补投恰好 1 条（时延 ${redeliveredMsA}ms ≤ ${REDLIVERY_BUDGET_MS / 1000}s 预算）`, notifyLinesA.length === 1, {
		channel: 'C',
		expected: `notify=1 且 Δt ≤ ${REDLIVERY_BUDGET_MS}ms`,
		actual: `notify=${notifyLinesA.length} Δt=${redeliveredMsA}ms`,
	})
	const { detailsNotifyId: notifyIdA } = parseNotifyDetails(notifyLinesA)
	ev.assert('C: 组 a notifyId 与主路径构造一致（id[:epoch] 形态——details.notifyId = record id）', notifyIdA === ga.recordId, {
		channel: 'C',
		expected: `details.notifyId = ${ga.recordId}`,
		actual: `details.notifyId=${notifyIdA ?? '<缺>'}`,
	})
	const outboxLinesA = outboxEntryLines(readRaw(ga.sessionFile), new Set([ga.recordId]))
	ev.assert('C: 组 a 投递日志出现该 record id 的 outbox 条目（补投受理落盘）', outboxLinesA.length >= 1, {
		channel: 'C',
		expected: `delivery-port-outbox 条目 data.id=${ga.recordId}`,
		actual: `outbox 条目数=${outboxLinesA.length}`,
	})
	ev.attach('groupA-notify-entries', notifyLinesA.join('\n').slice(0, 40_000))
	ev.attach('groupA-outbox-entries', outboxLinesA.join('\n').slice(0, 40_000))

	// 边沿来源可辨（设计 V4b 通过栏②）：切回组 = 补强命令触发维护链——subagent 域对账
	// 派发日志 reason="resume"（区别于 V4 的 session_start 路径）
	const { text: coreLogA } = readComponentLog(dataDir, CORE_LOG_PREFIX)
	const subReasonsA = dispatchReasonCounts(coreLogA, SUB_RECONCILE_MARK, ga.hookOffAt)
	ev.step({
		step: 'groupA.observe.reconcile-dispatch',
		channel: 'C',
		exitCode: 0,
		stats: { reasons: subReasonsA, note: 'RL14 边沿来源观察：组 a 时窗内 subagents 日志 dispatch reason 计数' },
	})
	ev.assert('C: 组 a 日志可辨边沿来源——subagent 域对账派发 reason="resume"（补强命令触发维护链）', (subReasonsA.resume ?? 0) >= 1, {
		channel: 'C',
		expected: 'notify reconcile dispatch {"detail":{"reason":"resume"}} ≥1',
		actual: `组 a 时窗 reason 计数=${JSON.stringify(subReasonsA)}`,
	})
	// 无第三入口（通过栏③前半）：切回组无重启——时窗内无 session_start 对账派发
	ev.assert('C: 组 a 无第三入口——切回后无 session_start 对账派发（同进程 reattach 无重启）', (subReasonsA.session_start ?? 0) === 0, {
		channel: 'C',
		expected: 'reason="session_start" dispatch = 0',
		actual: `组 a 时窗 reason 计数=${JSON.stringify(subReasonsA)}`,
	})
	if (notifyLinesA.length === 0) {
		// 补投红灯归因面：subagent 域对账是否被触发 + bash 域链派发证据（升级裁决事实源）
		ev.attach('groupA-redlight-facts', JSON.stringify({
			subReconcileReasons: subReasonsA,
			bteDispatchReasons: dispatchReasonCounts(readComponentLog(dataDir, BTE_LOG_PREFIX).text, BTE_DISPATCH_MARK, ga.hookOffAt),
			coreLogTail: coreLogA.slice(-6000),
		}, null, 2))
	}

	// 段④a：幂等——+8s 静默窗 + 二次切回边沿后计数恒 1
	await new Promise((r) => setTimeout(r, IDEMPOTENCE_QUIET_MS))
	try {
		await protocol.call('session.getCommands', { sessionId: ga.sid }, { timeoutMs: 30_000 })
	} catch {
		/* 二次边沿触发失败不吞断言——计数恒定断言仍有效 */
	}
	await new Promise((r) => setTimeout(r, 4_000))
	const finalCountA = notifyEntryLines(readRaw(ga.sessionFile)).length
	ev.assert('C: 组 a 幂等——静默窗 + 二次切回边沿后通知计数恒 1（无第二条同 id）', finalCountA === 1, {
		channel: 'C',
		expected: `notify=1（+${IDEMPOTENCE_QUIET_MS / 1000}s 静默窗 + 二次 getCommands 补强边沿后）`,
		actual: `notify=${finalCountA}`,
	})

	// ── 组 b：agent_settled 组（不重启不切回——父回合小工作产生回合收尾） ──
	instance.mockLlm?.reset?.()
	log('组 b（agent_settled 组）开始——mock 队列游标已归零')
	const gb = await runGroupPhase1(ctx, { label: 'groupB-agent-settled' })

	// 段②b：父回合继续一步小工作产生回合收尾（turn #2 收尾 = agent_settled 边沿）
	const sinceB = protocol.events.length
	await protocol.send(gb.sid, 'do one small step: confirm the reviewer result is on file (groupB-agent-settled 段②b)')
	let endB = null
	try {
		endB = await protocol.waitTurnEnd(gb.sid, { since: sinceB, timeoutMs: 120_000 })
	} catch (e) {
		ev.attach('groupB-turn2-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	ev.assert('B: 组 b 父回合小工作轮收尾（turn #2 message.complete——回合收尾边沿驱动形态）', endB?.type === 'message.complete' && endB?.ok, {
		channel: 'B',
		expected: 'message.complete（主队轮 3 小工作应答）',
		actual: endB ? `${endB.type} stop=${endB.payload?.stopReason ?? 'n/a'}` : '未等到',
	})

	// 段③b：边沿来源可辨——subagent 域对账派发 reason="agent_settled"（回合收尾挂点）
	const subReasonsB = await pollUntil(() => {
		const { text } = readComponentLog(dataDir, CORE_LOG_PREFIX)
		const counts = dispatchReasonCounts(text, SUB_RECONCILE_MARK, gb.hookOffAt)
		return (counts.agent_settled ?? 0) >= 1 ? counts : null
	}, { timeoutMs: 15_000, intervalMs: 500 })
	ev.step({
		step: 'groupB.observe.reconcile-dispatch',
		channel: 'C',
		exitCode: 0,
		stats: { reasons: subReasonsB ?? dispatchReasonCounts(readComponentLog(dataDir, CORE_LOG_PREFIX).text, SUB_RECONCILE_MARK, gb.hookOffAt), note: 'RL14 边沿来源观察：组 b 时窗内 dispatch reason 计数' },
	})
	ev.assert('C: 组 b 日志可辨边沿来源——subagent 域对账派发 reason="agent_settled"（回合收尾挂点触发）', Boolean(subReasonsB), {
		channel: 'C',
		expected: 'notify reconcile dispatch {"detail":{"reason":"agent_settled"}} ≥1',
		actual: `组 b 时窗 reason 计数=${JSON.stringify(subReasonsB ?? {})}`,
	})

	// 补投恰好 1 条 + notifyId 一致 + outbox 落盘
	const edgeBAt = Date.now()
	const redeliveryB = await pollUntil(() => {
		const entries = notifyEntryLines(readRaw(gb.sessionFile))
		return entries.length >= 1 ? entries : null
	}, { timeoutMs: REDLIVERY_BUDGET_MS, intervalMs: 1000 })
	const notifyLinesB = redeliveryB ?? []
	const redeliveredMsB = Date.now() - edgeBAt
	ev.assert(`C: 组 b agent_settled 边沿后补投恰好 1 条（时延 ${redeliveredMsB}ms ≤ ${REDLIVERY_BUDGET_MS / 1000}s 预算）`, notifyLinesB.length === 1, {
		channel: 'C',
		expected: `notify=1 且 Δt ≤ ${REDLIVERY_BUDGET_MS}ms`,
		actual: `notify=${notifyLinesB.length} Δt=${redeliveredMsB}ms`,
	})
	const { detailsNotifyId: notifyIdB } = parseNotifyDetails(notifyLinesB)
	ev.assert('C: 组 b notifyId 与主路径构造一致（details.notifyId = record id）', notifyIdB === gb.recordId, {
		channel: 'C',
		expected: `details.notifyId = ${gb.recordId}`,
		actual: `details.notifyId=${notifyIdB ?? '<缺>'}`,
	})
	const outboxLinesB = outboxEntryLines(readRaw(gb.sessionFile), new Set([gb.recordId]))
	ev.assert('C: 组 b 投递日志出现该 record id 的 outbox 条目（补投受理落盘）', outboxLinesB.length >= 1, {
		channel: 'C',
		expected: `delivery-port-outbox 条目 data.id=${gb.recordId}`,
		actual: `outbox 条目数=${outboxLinesB.length}`,
	})
	ev.attach('groupB-notify-entries', notifyLinesB.join('\n').slice(0, 40_000))
	ev.attach('groupB-outbox-entries', outboxLinesB.join('\n').slice(0, 40_000))

	// 无第三入口（通过栏③后半）：组 b 无重启无切回——时窗内无 session_start / resume 派发
	const { text: coreLogB } = readComponentLog(dataDir, CORE_LOG_PREFIX)
	const subReasonsBFinal = dispatchReasonCounts(coreLogB, SUB_RECONCILE_MARK, gb.hookOffAt)
	const bteReasonsBFinal = dispatchReasonCounts(readComponentLog(dataDir, BTE_LOG_PREFIX).text, BTE_DISPATCH_MARK, gb.hookOffAt)
	ev.assert('C: 组 b 无第三入口——时窗内无 session_start（无重启）且 base-tool-enhance 无 resume（无切回）派发', (subReasonsBFinal.session_start ?? 0) === 0 && (bteReasonsBFinal.resume ?? 0) === 0, {
		channel: 'C',
		expected: 'session_start=0（subagents）∧ resume=0（base-tool-enhance）',
		actual: `subagents=${JSON.stringify(subReasonsBFinal)} base-tool-enhance=${JSON.stringify(bteReasonsBFinal)}`,
	})
	if (notifyLinesB.length === 0) {
		ev.attach('groupB-redlight-facts', JSON.stringify({
			subReconcileReasons: subReasonsBFinal,
			bteDispatchReasons: bteReasonsBFinal,
			coreLogTail: coreLogB.slice(-6000),
		}, null, 2))
	}

	// 段④b：幂等——+8s 静默窗（补投唤醒 run 收尾的次生 agent_settled 边沿落在窗内，
	// 正好强化「跨边沿幂等」断言；组 b 不再人为触发任何边沿）
	await new Promise((r) => setTimeout(r, IDEMPOTENCE_QUIET_MS))
	await new Promise((r) => setTimeout(r, 4_000))
	const finalCountB = notifyEntryLines(readRaw(gb.sessionFile)).length
	ev.assert('C: 组 b 幂等——静默窗（含次生 agent_settled 边沿）后通知计数恒 1（无第二条同 id）', finalCountB === 1, {
		channel: 'C',
		expected: `notify=1（+${IDEMPOTENCE_QUIET_MS / 1000}s 静默窗 + 4s 收敛缓冲后）`,
		actual: `notify=${finalCountB}`,
	})

	// 铁证观察：mock server 收到的成员模型请求（两组孙进程都真的跑到 LLM）
	const allRequests = instance.mockLlm?.requests ?? []
	const childOk = allRequests.filter((r) => r.model === SUB_MODEL && r.status === 200)
	ev.step({
		step: 'mock.requests', channel: 'C', exitCode: 0,
		stats: { total: allRequests.length, childOk: childOk.length, models: [...new Set(allRequests.map((r) => r.model))].join(',') },
	})

	log(`done A(${ga.sid} notify=${finalCountA}) B(${gb.sid} notify=${finalCountB})`)
	return { uncovered, gotchas }
}
