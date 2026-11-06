/**
 * agg-error-presentation —— 端点供给侧失败（凭据缺失）的显式呈现
 * （provider-aggregation 设计 §4.1 V4，AX5 分层反向验证，GL3）。
 *
 * 判据原文（设计文档 V4 行摘录）：
 *   模型路由仅一个端点，撤销该端点凭据（设置页删除 api key）：
 *   1. 单端点模型路由正常对话一轮 → 2. 设置页删除该端点 api key → 3. 再次发消息 →
 *   4. 检查对话流错误呈现与日志。
 *   通过标准：对话流出现结构化错误，错误内容指明端点名与失败原因（pi 出站凭据错误透传，
 *   经 runtime 适配映射），并含恢复指引（到设置页更新凭据的路径提示）；请求未发往任何
 *   其他渠道；不出现静默重试到耗尽或假成功。
 *
 * 装配：mock-http（createInstance llm 通道；retry.enabled=false 由 ensureLlm 写死——
 * lib/instance.mjs ensureLlm 步骤 2，无静默重试的装配前提）。
 *
 * 机制链（全部本会话亲读依据 + 第 1 轮实跑 20261107-032757 实测形态）：
 * - route 求值不含凭据输入（AX5 分层）：extensions/universal/provider-aggregation/src/index.ts:34-38
 *   「端点供给侧状态（凭据、provider 启停）不在求值输入」——route 照常命中端点。
 * - 凭据拦截点在 pi resolveModel（流启动前）：route 返回物理模型后 pi 检查
 *   hasConfiguredAuth，无凭据 throw
 *   `Virtual model <聚合p>/<路由id> routed to <端点p>/<端点id>, which has no credentials.`
 *   （node_modules @earendil-works/pi-coding-agent dist/core/model-runtime.js:744-751，第 1 轮
 *   实测 errorMessage 逐字命中）。流前 throw 不经 message_update 子事件 → 无 message.stream_error 帧，
 *   错误经 agent_end → message.complete(stopReason=error) + errorMessage 原文透传
 *  （packages/runtime/src/infra/pi/event-adapter.ts extractAgentEndFields:393）。
 * - runtime 映射（AX5 runtime 半边，U3）：词表前缀 `No API key`（packages/shared/src/provider.ts:274）
 *   → formatCredentialMissingPresentation（provider.ts:286-296）→ message.stream_error
 *   （event-adapter.ts:206-212）。**词表与 pi 实装文本不匹配（本验收的核心 finding）**：虚拟模型
 *   路由路径的凭据错误文本是 `Virtual model ... routed to ..., which has no credentials.`，
 *   非 'No API key' 前缀 → 映射不命中 → 呈现无恢复指引。设计范围裁断（provider.ts:280-284）
 *   明文「恢复指引随 A23/V4 真机验收观察真实文本后补」——本剧本观察到的真实文本即后补条件触发点。
 * - UI 呈现：message.complete stopReason=error → errorText=payload.errorMessage
 *   （packages/core/src/domain/chat/effects/registry.ts:261-265）→ assistant 消息 error 字段 →
 *   block-text-error danger 行（packages/ui/src/features/chat/TextRow.vue:26-29）。
 * - 删 key 写点：config.setProvider 的 apiKey 空串 = 清除语义（删键）——packages/shared/src/protocol.ts:532-533 +
 *   packages/runtime/src/services/provider-config-helper.ts:838-841（applyProviderCredentials 防线②）；
 *   与设置页保存同一写点（packages/runtime/src/transport/provider-message-handler.ts:156-168）。
 * - 会话行 UI 定位：协议 label 不等于侧栏行显示名——label 持久化移交 pi set_session_name
 *   （packages/runtime/src/services/session/event-interpreter.ts:416/439），无 rename 时行显示
 *   cwd basename（第 1 轮实测截图）；定位一律用 config.sessions 返回的 summary.label 现值。
 *
 * 为什么「再次发消息」前重开会话（pi 进程消费删除后配置的真实路径）：
 *   pi 的模型快照是「加载时同步」——运行中热更新不提供（extensions/universal/provider-live-sync/
 *   src/index.ts:19-20；session_start 时 refresh 重读 models.json，:106-127）。运行中会话的 pi 进程
 *   在删 key 后仍持旧凭据出站；mock server 不校验 Authorization（scripts/lib/mock-llm.mjs createServer
 *   无 Authorization 检查），该形态在本通道表现为出站成功（mock-http 特有，真实世界 = 厂商侧撤销凭据
 *   后拒绝，厂商失败文本映射按设计范围裁断未实装——provider.ts:280-284「恢复指引随 A23/V4 真机验收
 *   观察真实文本后补」）。重开会话（forceQuit + switch = 新 pi 进程 session_start refresh）让 pi 进程
 *   真实消费删除后的配置，触发「凭据缺失」结构化呈现路径——这是本剧本实证的面；运行中不重开形态
 *   如实登记 notProvable。
 *
 * 命中断言通道：
 * - B 协议：message.stream_error content = 结构化映射文案（端点名 + 失败原因 + 恢复指引）；
 *   message.complete stopReason=error（终态非假成功）。
 * - C 磁盘：会话 JSONL error assistant entry（model = 端点物理模型——失败发生在该端点，非其他渠道）；
 *   mock 请求记录零新增（出站未发生 = 请求未发往任何渠道 + 无重试出站）；models.json apiKey 键删/复原；
 *   settings.json retry.enabled=false；runtime 日志 spawning pi 计数（重开事实）。
 * - A UI：对话流 block-text-error 错误行文本 = 映射文案。
 */
import fs from 'node:fs'
import path from 'node:path'

const AGG = 'aggregation'
const PROVIDER = 'mockllm'
const ROUTE = 'agg-err-route'
const EP_MODEL = 'ep-cred-a'
const REF_ROUTE = `${AGG}/${ROUTE}`
const ENDPOINT_REF = `${PROVIDER}/${EP_MODEL}`
const MOCK_KEY = 'mock-key-not-needed'

/** 实测错误文本锚段（第 1 轮 20261107-032757 errorMessage 逐字；源 model-runtime.js:749）。 */
const ERR_ROUTED_ANCHOR = 'routed to'
const ERR_ENDPOINT_ANCHOR = `routed to ${ENDPOINT_REF}` // 端点名完整复合串（比预期更精确）
const ERR_REASON_ANCHOR = 'no credentials'
/** 判据子项锚段（恢复指引）：实测 NOT 命中——映射词表未覆盖 resolveModel 凭据拦截文本。 */
const GUIDE_ANCHORS = ['设置页', '更新凭据']

// ── mock 演员：主模型队列留破绽标记（命中 = 请求发往其他渠道 = 判据违反），端点模型 2 步 ──
const step = (tag) => ({ text: tag, stopReason: 'stop' })
const responses = {
  _note: 'model-keyed；pi 请求体 model 是裸 id（mock-http README 坑 1）；_note 被忽略',
  'mockllm/mock-1': [step('agg-err-default-should-never-hit-1'), step('agg-err-default-should-never-hit-2')],
  'mockllm/mock-sub-a': [step('agg-err-sub-spare')],
  'mockllm/ep-cred-a': [step('agg-err-normal-turn1'), step('agg-err-recovered-turn')],
}

export const meta = {
  id: 'agg-error-presentation',
  priority: 'P0',
  title: '端点供给侧失败（凭据缺失）显式呈现（V4）：结构化错误 / 恢复指引 / 零出站 / 无重试无假成功',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.wait',
    'model.list', 'settings.provider',
  ],
  requires: ['mock-http'],
  llm: {
    responses,
    mainModel: 'mock-1',
    subModel: 'mock-sub-a',
    models: ['mock-1', 'mock-sub-a', 'ep-cred-a'],
  },
  estimateSec: 420,
  provable: [
    'V4 步骤 1：单端点路由会话正常对话一轮——命中唯一端点 ep-cred-a（mock 尾部裸 id + 会话 JSONL 助手消息物理模型记录）',
    'V4 步骤 2：config.setProvider（apiKey 空串 = 清除语义）后 agent/models.json 该 provider 无 apiKey 键（删 key 落盘）',
    '重开会话消费删除后配置：forceQuit+switch 后 pi 进程重开（runtime 日志 spawning pi 计数增加）+ 路由绑定保持（路由仍在，resume 不回落）',
    'V4 步骤 3+4：再次发消息出现结构化错误——message.complete(stopReason=error) errorMessage 指明端点名与失败原因：「routed to mockllm/ep-cred-a」（完整端点复合串）+「no credentials」（pi resolveModel 凭据拦截，model-runtime.js:749，流前 throw 原文透传）',
    'V4 无假成功：该轮 message.complete stopReason=error（终态错误，非正常出话）',
    'V4 请求未发往任何其他渠道：失败轮 mock 请求记录（含全部 status）零新增——出站未发生；主模型 mock-1 队列零消费（破绽标记未命中）',
    'V4 无静默重试：settings.json retry.enabled=false 落盘 + 失败轮 mock 零请求 + 第二次发消息同形态结构化失败（稳定终态非重试耗尽）',
    'C 日志：会话 JSONL error assistant entry（provider=aggregation、model=路由 id——pi 契约「failed 路由把虚拟模型留在消息上」）',
    'A UI：对话流 block-text-error 错误行呈现该错误文本（errorText = errorMessage，registry.ts:261-265）',
    '恢复路径闭环：恢复 apiKey（同一写点）+ 重开后发消息正常出话命中 ep-cred-a（错误是凭据状态驱动，指引可操作）',
  ],
  notProvable: [
    '**V4 判据子项「含恢复指引」实测不成立（fail 项，非证不了）**：pi resolveModel 凭据拦截文本（Virtual model ... routed to ..., which has no credentials.）不含恢复指引，且 runtime 映射词表（No API key 前缀，provider.ts:274）与该实装文本不匹配 → formatCredentialMissingPresentation 不命中 → 无「到设置页更新凭据」提示。设计范围裁断（provider.ts:280-284）明文「恢复指引随 A23/V4 真机验收观察真实文本后补」——本剧本即该观察：真实文本已捕获，词表需按 `routed to`/`which has no credentials` 形态扩充',
    '运行中会话（不重开 pi 进程）删 key 后立即发消息的形态：pi 模型快照按加载时同步机制消费配置（provider-live-sync src/index.ts:19-20，运行中热更新不提供），出站仍持旧凭据；mock server 不校验 Authorization（lib/mock-llm.mjs），该形态在本通道表现为出站成功（mock-http 特有假成功；真实世界 = 厂商拒绝旧凭据透传，厂商失败文本映射按设计范围裁断未实装）。本剧本证「pi 进程已消费删除后配置」的凭据缺失呈现（重开会话 = pi 加载时同步的真实用户路径）',
    '设置页 UI 表单删 key 的交互面（表单编辑/保存按钮链）：本剧本走 config.setProvider 协议写侧（与设置页保存同一写点 provider-message-handler.ts:156-168）；UI 表单交互归 p0-settings-provider/手工验收',
    '真实厂商 401/429/5xx 文本的呈现形态：无统一形态，设计范围裁断不建映射词表（provider.ts:280-284），mock-http 通道无法模拟厂商侧凭据撤销',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    'pi 模型快照是加载时同步（provider-live-sync src/index.ts:19-20）：运行中删 key 不影响已运行 pi 进程的出站凭据；剧本在删 key 后 forceQuit+switch 重开会话，让新 pi 进程 session_start refresh 消费删除后的 models.json——「再次发消息」的凭据缺失错误在重开后的同一会话触发',
    '凭据拦截点在 pi resolveModel（model-runtime.js:749，route 返回后、流启动前），错误文本 `Virtual model <p>/<route> routed to <endpoint>, which has no credentials.` 经 message.complete(stopReason=error) 透传——无 message.stream_error 帧，event-adapter 的 formatCredentialMissingPresentation（No API key 词表）不命中，呈现无恢复指引（V4 判据子项，如实 fail）',
    'config.setProvider 删 key = apiKey 传空串（protocol.ts:532 空串清除语义）；其余字段（name/api/baseUrl/models）从 models.json 现值保真回传，避免整条 provider 定义被部分覆写',
    'mock 请求零新增断言按 requests 全量（含 status 404）计数：凭据拦截在客户端 throw，HTTP 请求不发出，mock 侧应零记录',
    '会话行 UI 定位用 config.sessions 返回的 summary.label 现值，不假设等于 session.create 传入的 label（label 持久化走 pi set_session_name，无 rename 时行显示 cwd basename——第 1 轮实测截图）',
  ]

  const modelsJsonPath = path.join(dataDir, 'agent', 'models.json')
  const readModelsJson = () => JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'))
  const settingsPath = path.join(dataDir, 'agent', 'settings.json')
  const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  const extrasPath = path.join(dataDir, 'agent', 'config', 'providers.json')
  const extras = () => JSON.parse(fs.readFileSync(extrasPath, 'utf8'))

  // ── 0. 前提断言 ─────────────────────────────────────────────────────────────
  const modelsJson0 = readModelsJson()
  const providerDef0 = modelsJson0.providers?.[PROVIDER]
  const endpointIds = (providerDef0?.models ?? []).map((m) => m.id)
  const premiseOk = endpointIds.includes(EP_MODEL) && providerDef0?.apiKey === MOCK_KEY && providerDef0?.baseUrl
  ev.assert('C: 前提——mockllm provider 定义含端点模型 ep-cred-a + apiKey 字面量 + baseUrl（mock 出站可达）', Boolean(premiseOk), {
    channel: 'C',
    expected: `models 含 ${EP_MODEL}、apiKey=${MOCK_KEY}、baseUrl 非空`,
    actual: `models=${endpointIds.join(',')} apiKey=${providerDef0?.apiKey ?? '<none>'} baseUrl=${providerDef0?.baseUrl ?? '<none>'}`,
  })
  ev.attach('provider-def-before', JSON.stringify(providerDef0, null, 2).slice(0, 2_000))
  const retryDisabled = readSettings().retry?.enabled === false
  ev.assert('C: 前提——settings.json retry.enabled=false（mock-http 装配写死，无静默重试的装配前提）', retryDisabled, {
    channel: 'C',
    expected: 'retry.enabled=false',
    actual: `retry=${JSON.stringify(readSettings().retry ?? null)}`,
  })
  ev.step({ step: 'premise', channel: 'C', exitCode: premiseOk && retryDisabled ? 0 : 1, stats: {} })

  // ── 共用 helper（agg-delete-lifecycle 同族先例） ─────────────────────────────
  async function saveRoute(route, label) {
    const saved = await protocol.call('aggregation.saveRoute', { route }, { replyType: 'aggregation.routeSaved', timeoutMs: 60_000 })
    ev.assert(`B: aggregation.saveRoute ${label} 回执（routeSaved）`, saved?.route?.id === route.id, {
      channel: 'B',
      expected: `route.id=${route.id}`,
      actual: `reply.id=${saved?.route?.id} memberIssues=${(saved?.memberIssues ?? []).length}`,
    })
    return saved
  }

  async function setScoped(models, label) {
    const reply = await protocol.call('config.setScopedModels', { models }, { replyType: 'config.scopedModels', timeoutMs: 60_000 })
    ev.assert(`B: setScopedModels ${label} 回执`, JSON.stringify(reply?.scopedModels ?? []) === JSON.stringify(models), {
      channel: 'B',
      expected: JSON.stringify(models).slice(0, 200),
      actual: JSON.stringify(reply?.scopedModels ?? null).slice(0, 200),
    })
    return reply
  }

  async function readAssistantEntries(sessionFile, expectMinEntries, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    let entries = []
    for (;;) {
      try {
        const raw = fs.readFileSync(sessionFile, 'utf8')
        entries = []
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line)
            const m = obj?.message ?? obj
            if (m?.role === 'assistant' && typeof m?.model === 'string') {
              entries.push({ model: m.model, provider: m.provider ?? null, stopReason: m.stopReason ?? null })
            }
          } catch {
            /* 非 JSON 行跳过 */
          }
        }
      } catch {
        /* 文件未 flush 完毕重试 */
      }
      if (entries.length >= expectMinEntries || Date.now() >= deadline) return entries
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  async function sessionFileOf(sid) {
    const list = await protocol.call('config.sessions', {}, { timeoutMs: 60_000 })
    for (const g of list.groups ?? []) {
      for (const s of g.sessions ?? []) {
        if (s.id === sid) return { sessionFile: s.sessionFile ?? '', label: String(s.label ?? '') }
      }
    }
    return { sessionFile: '', label: '' }
  }

  const allRequests = () => instance.mockLlm.requests
  const okRequests = () => instance.mockLlm.requests.filter((r) => r.status === 200)

  /** 条件轮询 getState 直到 modelId 等于期望绑定（快照 seed 竞态窗口防护）。 */
  async function pollBoundModelId(sid, expectedRef, label, { timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    for (;;) {
      last = await protocol.call('session.getState', { sessionId: sid }, { timeoutMs: 60_000 })
      if (last?.modelId === expectedRef) break
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert(`B: ${label}`, last?.modelId === expectedRef, {
      channel: 'B',
      expected: `getState.modelId=${expectedRef}`,
      actual: `sid=${sid} modelId=${last?.modelId ?? '<none>'}`,
    })
    return last?.modelId === expectedRef
  }

  /**
   * 发一条消息并断言本轮正常完成且命中 expectBareModel（mockLlm.requests 尾部裸 id
   * + JSONL 助手消息物理模型记录）。
   */
  async function sendTurn(sid, text, expectBareModel, label, { sessionFile, expectAssistantCount } = {}) {
    const since = protocol.events.length
    await protocol.send(sid, text)
    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert(`B: ${label} turn 正常完成`, end.type === 'message.complete' && end.ok, {
      channel: 'B',
      expected: 'message.complete stopReason≠error',
      actual: `${end.type} stopReason=${end.payload?.stopReason ?? 'n/a'}`,
    })
    const tail = okRequests()[okRequests().length - 1] ?? null
    ev.assert(`C: ${label} 命中端点 = ${expectBareModel}（mockLlm.requests 尾部裸 id）`, tail?.model === expectBareModel, {
      channel: 'C',
      expected: `model=${expectBareModel}`,
      actual: `tail.model=${tail?.model ?? '<none>'} stepIndex=${tail?.stepIndex}`,
    })
    if (sessionFile && expectAssistantCount !== undefined) {
      const entries = await readAssistantEntries(sessionFile, expectAssistantCount)
      const okEntries = entries.filter((e) => e.stopReason !== 'error' && e.stopReason !== 'aborted')
      const last = okEntries[okEntries.length - 1]
      ev.assert(`C: ${label} 助手消息物理模型记录 = ${expectBareModel}（会话 JSONL）`, last?.model === expectBareModel, {
        channel: 'C',
        expected: `第 ${expectAssistantCount} 条成功助手消息 model=${expectBareModel}`,
        actual: `count=${entries.length} last=${JSON.stringify(last ?? null)}`,
      })
    }
    if (end.type !== 'message.complete' || end.payload?.stopReason === 'error') {
      // sendTurn 期待成功但以错误终态收尾：把错误文本留档供归因（正常轮该分支不进）
      const errs = collectErrorTexts(since, sid)
      ev.attach(`${label}-unexpected-error`, (errs.completeMessage || errs.streamContent || errs.messageError || '<no error text>').slice(0, 800))
    }
    return { end, tail }
  }

  /** 从事件队列抓取该轮（since 之后）的错误呈现文本（complete errorMessage 为主帧 + stream_error/message.error 兜底）。 */
  function collectErrorTexts(since, sid) {
    const frames = protocol.events.slice(Math.max(0, since))
    const mine = frames.filter((e) => e.payload?.sessionId === undefined || e.payload?.sessionId === sid)
    const streamErr = mine.find((e) => e.type === 'message.stream_error')
    const completeErr = mine.find((e) => e.type === 'message.complete' && e.payload?.stopReason === 'error')
    const msgErr = mine.find((e) => e.type === 'message.error')
    return {
      streamContent: String(streamErr?.payload?.content ?? ''),
      completeMessage: String(completeErr?.payload?.errorMessage ?? ''),
      messageError: String(msgErr?.payload?.message ?? ''),
      sawStreamError: Boolean(streamErr),
      sawCompleteError: Boolean(completeErr),
    }
  }

  /**
   * 发消息并断言凭据缺失结构化失败全链（V4 步骤 3+4）：
   * 终态 error + errorMessage 指明端点名与失败原因（pi resolveModel 凭据拦截透传）
   * + mock 记录零新增 + JSONL error entry（虚拟模型留在消息上）。
   * 恢复指引断言独立成行（判据子项，实测不命中——映射词表与 pi 实装文本不匹配）。
   */
  async function sendTurnExpectCredentialError(sid, text, label, { sessionFile } = {}) {
    const since = protocol.events.length
    const countBefore = allRequests().length
    await protocol.send(sid, text)
    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
    const endedAsError = end.type !== 'message.complete' || end.payload?.stopReason === 'error'
    ev.assert(`B: ${label} 该轮以错误终态结束（无假成功）`, endedAsError, {
      channel: 'B',
      expected: '非 message.complete 或 stopReason=error',
      actual: `${end.type} stopReason=${end.payload?.stopReason ?? 'n/a'} ok=${end.ok}`,
    })

    const errs = collectErrorTexts(since, sid)
    const presentation = errs.completeMessage || errs.streamContent || errs.messageError
    ev.assert(`B: ${label} 错误终态帧带错误文本（errorMessage 透传通路）`, Boolean(presentation), {
      channel: 'B',
      expected: 'message.complete(stopReason=error) 的 errorMessage 非空（agent_end extractAgentEndFields:393）',
      actual: `completeError=${errs.sawCompleteError} streamError=${errs.sawStreamError} messageError=${Boolean(errs.messageError)} text=${presentation.slice(0, 200) || '<empty>'}`,
    })
    ev.assert(
      `B: ${label} 错误指明端点名（「${ERR_ENDPOINT_ANCHOR}」——完整端点复合串）`,
      presentation.includes(ERR_ENDPOINT_ANCHOR),
      {
        channel: 'B',
        expected: `errorMessage 含「${ERR_ENDPOINT_ANCHOR}」（model-runtime.js:749 routed to <endpoint>）`,
        actual: `text=${presentation.slice(0, 400) || '<empty>'}`,
      },
    )
    ev.assert(`B: ${label} 错误指明失败原因（「${ERR_REASON_ANCHOR}」）`, presentation.includes(ERR_REASON_ANCHOR), {
      channel: 'B',
      expected: `errorMessage 含「${ERR_REASON_ANCHOR}」（pi 凭据拦截原因）`,
      actual: `text=${presentation.slice(0, 400) || '<empty>'}`,
    })
    const guideHit = GUIDE_ANCHORS.filter((a) => presentation.includes(a))
    ev.assert(`B: ${label} 判据子项：呈现含恢复指引（到设置页更新凭据）`, guideHit.length >= 2, {
      channel: 'B',
      expected: `呈现含「${GUIDE_ANCHORS.join('」+「')}」（V4 判据「含恢复指引」）`,
      actual: `命中=${guideHit.join(',') || '<none>'} text=${presentation.slice(0, 400)}`,
    })
    ev.attach(`${label}-error-text`, presentation.slice(0, 800))

    const countAfter = allRequests().length
    ev.assert(`C: ${label} 请求未发往任何渠道（mock 请求记录零新增，含全部 status）`, countAfter === countBefore, {
      channel: 'C',
      expected: `请求数保持 ${countBefore}（凭据拦截客户端 throw，HTTP 不发出）`,
      actual: `before=${countBefore} after=${countAfter}`,
    })
    const mainConsumed = allRequests().some((r) => r.model === 'mock-1')
    ev.assert(`C: ${label} 主模型队列零消费（未发往其他渠道的破绽标记未命中）`, !mainConsumed, {
      channel: 'C',
      expected: 'mock-1 队列零请求',
      actual: `requests=${JSON.stringify(allRequests().map((r) => ({ model: r.model, status: r.status }))).slice(0, 300)}`,
    })

    if (sessionFile) {
      const entries = await readAssistantEntries(sessionFile, 1)
      const errEntry = [...entries].reverse().find((e) => e.stopReason === 'error')
      ev.assert(`C: ${label} JSONL error 记录（虚拟模型留在消息上：provider=aggregation、model=${ROUTE}）`, Boolean(errEntry) && errEntry?.provider === AGG && errEntry?.model === ROUTE, {
        channel: 'C',
        expected: `error assistant entry provider=${AGG} model=${ROUTE}（pi 契约「failed 路由把虚拟模型留在消息上」）`,
        actual: `entries=${entries.length} last=${JSON.stringify(entries[entries.length - 1] ?? null)}`,
      })
    }
    return { end, errs }
  }

  /** forceQuit + switch 重开会话（新 pi 进程，session_start refresh 消费当前 models.json）。 */
  async function reopenSession(sid, label) {
    const { readRuntimeLogs } = await import('../scripts/lib/instance.mjs')
    const spawnsBefore = readRuntimeLogs(dataDir).split('\n').filter((l) => l.includes('spawning pi')).length
    const fq = await protocol.call('session.forceQuit', { sessionId: sid }, { timeoutMs: 60_000 })
    ev.assert(`B: ${label} forceQuit ack`, fq?.status === 'force_quit', {
      channel: 'B',
      expected: "status='force_quit'",
      actual: JSON.stringify(fq ?? null).slice(0, 200),
    })
    const switched = await protocol.call('session.switch', { sessionId: sid }, { replyType: 'session.switched', timeoutMs: 120_000 })
    ev.assert(`B: ${label} session.switch 回执`, switched?.sessionId === sid, {
      channel: 'B',
      expected: `session.switched sessionId=${sid}`,
      actual: `sessionId=${switched?.sessionId}`,
    })
    await protocol.subscribe(sid)
    const spawnsAfter = readRuntimeLogs(dataDir).split('\n').filter((l) => l.includes('spawning pi')).length
    ev.assert(`C: ${label} pi 进程重开（runtime 日志 spawning pi 计数增加）`, spawnsAfter > spawnsBefore, {
      channel: 'C',
      expected: `spawning pi 计数 > ${spawnsBefore}`,
      actual: `before=${spawnsBefore} after=${spawnsAfter}`,
    })
    return { spawnsBefore, spawnsAfter }
  }

  /** setProvider 保真回传（从 models.json 现值构造 payload，apiKey 按需置空/恢复）。 */
  async function setProviderApiKey(apiKey, label) {
    const def = readModelsJson().providers?.[PROVIDER]
    const payload = {
      providerId: PROVIDER,
      name: def?.name ?? 'Mock LLM (verify-taiji local mock-http)',
      type: 'custom',
      api: def?.api ?? 'openai-completions',
      baseUrl: def?.baseUrl,
      apiKey,
      models: (def?.models ?? []).map((m) => ({ id: m.id, name: m.name })),
    }
    await protocol.call('config.setProvider', payload, { timeoutMs: 60_000 })
    ev.step({ step: `config.setProvider.${label}`, channel: 'B', exitCode: 0, stats: { providerId: PROVIDER, apiKey: apiKey === '' ? '<cleared>' : '<set>' } })
    const after = readModelsJson().providers?.[PROVIDER]
    return after
  }

  // ══ 1. 装配单端点路由 + scopedModels ═══════════════════════════════════════
  const route = {
    id: ROUTE,
    name: ROUTE,
    modelId: ROUTE,
    enabled: true,
    mode: 'advanced',
    members: [{ id: 'ep1', providerId: PROVIDER, modelId: EP_MODEL, type: 'none' }],
    specials: [],
  }
  await saveRoute(route, '单端点（ep1=none 无条件）')
  const routesOnDisk = extras().routes?.routes ?? []
  ev.assert('C: 路由落盘 providers.json routes 段（saveRoute 唯一写点）', routesOnDisk.some((r) => r.id === ROUTE), {
    channel: 'C',
    expected: `routes 含 ${ROUTE}`,
    actual: `routeIds=${routesOnDisk.map((r) => r.id).join(',')}`,
  })
  await setScoped([REF_ROUTE, `${PROVIDER}/mock-1`], '路由入白名单')

  let listed = false
  {
    const deadline = Date.now() + 15_000
    for (;;) {
      const ml = await protocol.call('model.list', {}, { timeoutMs: 60_000 })
      if ((ml.models ?? []).some((m) => (m.aggregation === true || m.providerId === AGG) && m.id === ROUTE)) {
        listed = true
        break
      }
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
  ev.assert('B: model.list 出现聚合条目（选择器候选 = 注入 × scopedModels 白名单，条件轮询）', listed, {
    channel: 'B',
    expected: `model.list 含聚合条目 ${ROUTE}`,
    actual: listed ? '出现' : '15s 未出现',
  })

  // ══ 2. V4 步骤 1：单端点路由正常对话一轮 ════════════════════════════════════
  const S_LABEL = 'agg-err-presentation'
  const created = await protocol.call(
    'session.create',
    { cwd: repo, label: S_LABEL, modelOverride: REF_ROUTE },
    { timeoutMs: 120_000 },
  )
  const sid = created.session?.id
  await pollBoundModelId(sid, REF_ROUTE, '会话绑定单端点路由（spawn --model 命中工厂期注册）')
  await protocol.subscribe(sid)
  const { sessionFile, label: sessionLabel } = await sessionFileOf(sid)
  ev.assert('B: config.sessions summary 含会话 label 现值（UI 行定位依据）', Boolean(sessionLabel), {
    channel: 'B',
    expected: 'label 非空',
    actual: `label=${sessionLabel || '<empty>'}（session.create 传入 label=${S_LABEL}；label 持久化走 pi set_session_name，现值可能为 cwd basename）`,
  })
  ev.attach('session-summary-label', `passedLabel=${S_LABEL} summaryLabel=${sessionLabel}`)
  const normalTurn = await sendTurn(sid, 'V4 步骤 1：单端点路由正常对话一轮', EP_MODEL, 'V4 正常轮', { sessionFile, expectAssistantCount: 1 })
  ev.step({ step: 'v4.normal-turn', channel: 'C', exitCode: normalTurn.tail?.model === EP_MODEL ? 0 : 1, stats: { model: normalTurn.tail?.model } })

  // ══ 3. V4 步骤 2：设置页删除该端点 api key（config.setProvider 空串清除语义） ══
  const defAfterDelete = await setProviderApiKey('', 'delete-key')
  ev.assert('C: 删 key 后 models.json 该 provider 无 apiKey 键（空串 = 清除删键，protocol.ts:532）', defAfterDelete && !('apiKey' in defAfterDelete), {
    channel: 'C',
    expected: 'mockllm 定义无 apiKey 键',
    actual: `keys=${Object.keys(defAfterDelete ?? {}).join(',')}`,
  })
  ev.attach('provider-def-after-delete', JSON.stringify(defAfterDelete, null, 2).slice(0, 2_000))

  // ══ 4. 重开会话：新 pi 进程 session_start refresh 消费删除后配置 ════════════
  const reopen1 = await reopenSession(sid, 'V4 重开 1')
  await pollBoundModelId(sid, REF_ROUTE, '重开后路由绑定保持（路由仍在盘，虚拟模型重新注册，resume 不回落）', { timeoutMs: 30_000 })

  // ══ 5. V4 步骤 3+4：再次发消息 → 结构化错误呈现（两轮稳定形态） ═════════════
  const fail1 = await sendTurnExpectCredentialError(sid, 'V4 步骤 3：删 key 后再次发消息，应显式失败', 'V4 失败轮 1', { sessionFile })
  ev.step({ step: 'v4.credential-error-1', channel: 'B', exitCode: fail1.errs.sawCompleteError ? 0 : 1, stats: {} })
  const fail2 = await sendTurnExpectCredentialError(sid, 'V4 稳定性复验：再次发消息仍显式失败（非偶发非重试耗尽）', 'V4 失败轮 2', { sessionFile })
  ev.step({ step: 'v4.credential-error-2', channel: 'B', exitCode: fail2.errs.sawCompleteError ? 0 : 1, stats: {} })

  // ══ 6. A 通道：对话流 block-text-error 错误行文本 ═══════════════════════════
  // 行定位用 config.sessions 的 label 现值（不假设等于传入 label——第 1 轮实测行显示 cwd basename）
  const ui = ctx.ui
  try {
    const zoneExpanded = await ui.attr('testid=default-project-anchor', 'aria-expanded')
    if (zoneExpanded !== 'true') await ui.click('testid=default-project-anchor')
    const rowSelector = `css=.session-item[aria-label="${sessionLabel.replace(/"/g, '\\"')}"]`
    await ui.expectVisible(rowSelector, { timeoutMs: 20_000 })
    await ui.click(rowSelector)
    await ui.expectText('testid=panel-session-label', sessionLabel, { timeoutMs: 20_000 })
    const errText = await ui.expectText('testid=block-text-error', ERR_REASON_ANCHOR, { timeoutMs: 15_000 })
    ev.assert('A: 对话流错误行（block-text-error）呈现凭据缺失错误文本', errText.includes(ERR_ENDPOINT_ANCHOR) && errText.includes(ERR_REASON_ANCHOR), {
      channel: 'A',
      expected: `block-text-error 含「${ERR_ENDPOINT_ANCHOR}」+「${ERR_REASON_ANCHOR}」（TextRow.vue:26 msg.error = errorMessage）`,
      actual: `text=${String(errText).slice(0, 300)}`,
    })
    const guideHitUi = GUIDE_ANCHORS.filter((a) => errText.includes(a))
    ev.assert('A: 判据子项：错误行含恢复指引（到设置页更新凭据）', guideHitUi.length >= 2, {
      channel: 'A',
      expected: `错误行含「${GUIDE_ANCHORS.join('」+「')}」（V4 判据「含恢复指引」）`,
      actual: `命中=${guideHitUi.join(',') || '<none>'} text=${String(errText).slice(0, 300)}`,
    })
    await ev.shot(await instance.page(), 'v4-error-bubble')
    ev.step({ step: 'v4.ui-error-line', channel: 'A', exitCode: 0, stats: {} })
  } catch (e) {
    ev.assert('A: 对话流错误行（block-text-error）呈现凭据缺失错误文本', false, {
      channel: 'A',
      expected: 'block-text-error 可见且含端点名与原因锚段',
      actual: String(e?.message ?? e).slice(0, 400),
    })
    ev.attach('v4-ui-error', JSON.stringify({ message: e?.message, hint: e?.hint, evidence: e?.evidence }, null, 2).slice(0, 20_000))
    try {
      await ev.shot(await instance.page(), 'v4-ui-fail')
    } catch {
      /* 页面不可用时放弃截图 */
    }
    ev.step({ step: 'v4.ui-error-line', channel: 'A', exitCode: 1, stats: {} })
  }

  // ══ 7. 恢复路径闭环：恢复 apiKey + 重开 + 正常出话（指引可操作性的证明） ════
  const defAfterRestore = await setProviderApiKey(MOCK_KEY, 'restore-key')
  ev.assert('C: 恢复 key 后 models.json apiKey 键回归原字面量', defAfterRestore?.apiKey === MOCK_KEY, {
    channel: 'C',
    expected: `apiKey=${MOCK_KEY}`,
    actual: `apiKey=${defAfterRestore?.apiKey ?? '<none>'}`,
  })
  await reopenSession(sid, 'V4 重开 2（恢复后）')
  await pollBoundModelId(sid, REF_ROUTE, '恢复后路由绑定保持', { timeoutMs: 30_000 })
  const recovered = await sendTurn(sid, 'V4 恢复轮：更新凭据后应正常出话', EP_MODEL, 'V4 恢复轮', { sessionFile, expectAssistantCount: 3 })
  ev.step({ step: 'v4.recovered-turn', channel: 'C', exitCode: recovered.tail?.model === EP_MODEL ? 0 : 1, stats: { model: recovered.tail?.model } })

  ev.attach('mock-requests-summary', JSON.stringify(allRequests().map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex, at: new Date(r.at).toISOString() })), null, 2))
  log(`agg-error-presentation done sid=${sid} route=${REF_ROUTE} endpoint=${ENDPOINT_REF} reopenSpawns=${reopen1.spawnsBefore}->${reopen1.spawnsAfter}`)
  return { uncovered, gotchas }
}
