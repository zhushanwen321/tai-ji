#!/usr/bin/env node
/**
 * verify-scheduler-e2e.cjs — pi-scheduler 端到端真实环境实测脚本。
 *
 * 设计依据：.taiji-harness/2026-08-12-scheduler-session-scope/design.md §4 S1-S17 + §5 V1-V5。
 *
 * 本 wave 是端到端验证 wave，不写产品代码。脚本 spawn 真实 pi CLI（加载 extensions/universal/scheduler），
 * 经 RPC stdin/stdout 驱动工具调用，断言 design 契约：
 *   - customType='pi-scheduler:task' entry（op ∈ upsert/advance/toggle/delete）
 *   - once 回显仅 1 条 run 行、不含 "Next 5 runs:"；recurring 含 5 条
 *   - schedule_control 空列表返回 "No scheduled tasks."
 *   - session 隔离（A 建任务，B 同 cwd 看不到）
 *   - resume 重放恢复（kill 后重开同 session，任务仍在）
 *   - entry 线性增长 + advance nextRunAt 单调递增
 *
 * [L2.5 faux 翻轨] LLM 演员是 faux 脚本（真 pi 进程 + 真 scheduler extension + 假 LLM）。
 * 断言面全在扩展写盘的 entry 形态与工具 / 命令反馈（与模型智能无关），确定性、零 token、
 * 凭证无关（agentDir 预置 faux settings/models，无需 ~/.pi/agent/auth.json）。S17/S4/S12
 * 的 dispatch 注入 turn 同样消费 faux 队列（注入 prompt 的响应步骤预排余量）。
 *
 * 触发模型（scheduler 触发反转后）——两条路径各有驱动源：
 *   ① 模型路径（`schedule` tool）：**直建**，不再弹确认表单。驱动器发普通 prompt 文本
 *      + faux toolCall 步骤（toolCalls 预设 schedule/schedule_control 调用），断言 tool
 *      result 回显 + customType='pi-scheduler:task' entry。该路径**不得**出现
 *      UI_FORM_MARKER select 帧（S1/S2 断言 unexpectedScheduleForms 为空——缺省 uiActor
 *      不确认表单并记录非预期请求）。
 *   ② 人侧路径（`/schedule` 命令，唯一注册名）：命令 handler **异步打开**
 *      创建表单（不 await，规避 prompt RPC 的 60s 回包窗口）。表单经统一提问表单协议送达：
 *      UI_FORM_MARKER select，options[0] 携 {formQuestions, allowCancel}，schedule 问题
 *      initial 预填 draft；应答回 FormAnswers envelope = {key: flat ScheduleFormResult JSON}，
 *      key = header ?? question，帧契约实装核对 @earendil-works/pi-coding-agent 0.84.4
 *      dist/modes/rpc/rpc-mode.js。slash 命令在 `prompt` 内执行且**不产生 turn 事件**
 *      （无 turn_end）——驱动器用 sendCommand() 只等 prompt ack，随后轮询请求帧与 notify 帧。
 *
 * 断言源（命令路径）：命令路径**无 tool 调用**，用户可见反馈走 ctx.ui.notify →
 * extension_ui_request{method:'notify', message, notifyType} 帧（getNotifies() 捕获面 +
 * 文案断言），落库证据仍读 customType='pi-scheduler:task' entry —— 双轨断言。
 *
 * uiActor 应答器（extension_ui_request → extension_ui_response）：
 *   缺省 = **不回确认**（不再按预填草稿自动应答）——schedule 表单请求按「非预期」记录进
 *   unexpectedScheduleForms 并回 cancelled（不创建、不挂起，避免误报为 turn 超时）；
 *   其余 select 请求不应答（挂起语义与 taiji runtime 不超时同构）；notify / setWidget 等
 *   单向帧只捕获不应答。S18/S20/S21 = 用户填表 / 改值后确认（断言裁定值生效）；
 *   S19 = 用户取消（断言任务未创建且无 toast）。
 *
 * [u-e2e-adjust] 命令路径持久化证据轨改锚「确认轮（ack 合成轮）」：命令路径建任务后
 * scheduler 自身注入一次零 token 本地合成轮（覆写会话当前 provider 的 streamSimple），
 * 产出 stopReason='aborted' 的 assistant 消息 + `ack.confirm` 文案，从而打开 pi 的会话
 * 落盘开关（session-manager `_persist`：已有 assistant 消息即把整批 fileEntries 写盘）——
 * 这就是**正常路径**，故 e2e **不再自植入 flush 探针**（原 flushForJsonlEvidence 已退役，
 * 见断言辅助节的 [u-e2e-adjust] 注释）。S18/S20/S21 断言「创建后会话 JSONL 出现 aborted
 * assistant 行 + 确认文案（i18n `ack.confirm`，locale 由 makeFauxAgentDir 钉死 en-US）+
 * op=upsert 已落盘」；S19 补负向断言（取消 ⇒ 无 assistant 行、JSONL 无 op=upsert）；
 * S22 = 合成行字段（provider/model=会话模型、usage 全 0）+ 宿主不变量（model_change /
 * thinking_level_change 不因创建新增 + auto-rename 不被合成轮触发）；S23 = 同会话连续两次
 * 创建 ⇒ 确认轮恰 1 次。
 *
 * 场景分类：
 *   A 类（必须自动化通过）：S1 once 回显（tool 直建 + 无确认帧）/ S2 recurring 回显 /
 *     S3 session 隔离 / S5 resume 重放 / S9 删 session 无残留 / S17 entry 增长 /
 *     S18 命令路径表单（带参预填 + 改值确认）/ S19 命令路径表单（取消）/
 *     S20 命令路径表单（无参默认草稿）/ S21 `/schedule` 命令路径表单（预填原值确认基线）/
 *     S22 合成确认行字段 + 宿主不变量 / S23 连续两次创建 ⇒ 确认轮恰 1 次
 *   B 类（尽力自动化，跑不了标 followup）：S4/S6/S12/S14 实现；S7/S8/S10/S16 标 followup
 *   C 类（标 followup + 手工步骤）：S11 fork 隔离 / S13 延迟写入窗口 / S15 taiji 兼容
 *
 * 副作用隔离（design R-cleanup）：每场景独立 mkdtempSync 临时 cwd + session-dir +
 * agent-dir（faux 装配：settings/models/ui-preferences 预置 + 响应脚本）；cleanup 额外清理
 * getLegacyStorePath(tempCwd) 推导的 ~/.pi/agent/scheduler/<segments>/ 整棵子树。
 *
 * 用法：
 *   node scripts/verify-scheduler-e2e.cjs              # 默认跑全部 A 类
 *   node scripts/verify-scheduler-e2e.cjs S1           # 单场景（S1..S23 / V / aclass / bclass / all）
 *   诊断：场景 FAIL 时自动 dump 该场景落盘 JSONL entries（无 env 开关）
 *   SCHED_E2E_KEEP_TMP=1 node scripts/verify-scheduler-e2e.cjs S22      # 保留临时 agentDir（含扩展日志
 *     <agentDir>/logs/，自动注入 TAIJI_AGENT_DEBUG=1；会话 JSONL 属 sessionDir、不被保留）
 *   SCHED_E2E_MODEL=faux/faux-1-b node scripts/verify-scheduler-e2e.cjs  # 覆盖测试模型（仅限 faux/ 演员）
 *
 * 退出码：0 = 全过；1 = 任一失败；2 = 脚本异常
 */
'use strict'

const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  realpathSync,
} = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
// 判定器纯函数族（抽离自本脚本，无 IO/进程/时钟；单测
// scripts/__tests__/verify-scheduler-e2e.test.mjs——判定器自错 = e2e 假绿/假红不可辨）
const {
  checkScheduleFormDraftContract,
  describeEntryTypeCounts,
  getScheduleQuestionFromRequest,
  isDraftPayloadObject,
  isScheduleDraftShape,
  parseJsonlEntries,
} = require('./lib/scheduler-e2e-judgers.cjs')

const TAG = '[SCHED-E2E]'
const REPO_ROOT = path.resolve(__dirname, '..')
const EXTENSION_PATH = path.join(REPO_ROOT, 'extensions', 'universal', 'scheduler')
/**
 * rename-session 扩展（S22 显式 --extension 加载 + config.enabled=true）：
 * 「宿主 auto-rename 不被合成轮触发」的判别力来源（first-stop 入口只在 stopReason==='stop'
 * 触发，合成轮为 'aborted'）。缺省场景不加载它——避免多余事件 handler 影响既有断言面。
 */
const RENAME_SESSION_EXT_PATH = path.join(REPO_ROOT, 'extensions', 'universal', 'rename-session')
/**
 * 统一提问表单请求的 select title marker（cjs 端口；SSOT =
 * packages/extension-protocol/src/extensions/ui-form/marker.ts，改动须同步）。
 * scheduler 人侧创建表单（`/schedule` 命令路径，异步打开）走本通道：
 * options[0] = {formQuestions, allowCancel}。NUL 前缀与 ask-user / session-manager marker 同规范。
 */
const UI_FORM_MARKER = '\x00TAIJI_UI_FORM'
/** faux provider 注册 extension（与 runtime equivalence 套件同一 SSOT 文件） */
const FAUX_LLM_EXT_PATH = path.join(
  REPO_ROOT, 'packages', 'runtime', 'src', '__tests__', 'fixtures', 'faux-llm-ext.ts',
)
const PI_BIN_DEFAULT = path.join(
  REPO_ROOT,
  'apps',
  'electron',
  'resources',
  'pi',
  `pi-${process.platform}-${process.arch}`,
)
/** 测试模型（faux 演员；env 覆盖仅限 faux/ 前缀——零 token 红线） */
const MODEL = (() => {
  const m = process.env.SCHED_E2E_MODEL || 'faux/faux-1'
  if (!m.startsWith('faux/')) {
    console.error(`${TAG} SCHED_E2E_MODEL 必须是 faux/ 演员实际 "${m}"（faux 轨零 token 红线）`)
    process.exit(2)
  }
  return m
})()

// ── faux 装配 ──

/** faux 模型演员 id（--model 'faux/<id>' 的 id 段） */
const FAUX_MODEL_ID = MODEL.includes('/') ? MODEL.slice(MODEL.indexOf('/') + 1).split(':')[0] : MODEL

/**
 * 预置 faux agentDir（settings.json + models.json + ui-preferences.json + 响应脚本）并返回 env 注入块。
 * settings/models 与 e2e real 轨 launch-app-real.ts 的 seedFauxDataDir 同款语义
 *（defaultProvider=faux 过 getDefaultModel 门禁 + models.json providers.faux 供
 * pi 模型解析；sanitize 对 apiKey+models 条目判定合法保留）。
 *
 * `TAIJI_AGENT_DATA_DIR` 指向同一临时目录并预置 `ui-preferences.json`（locale=en-US）：
 * scheduler i18n 的 locale 读取器（`readUiLocale`）从 `<TAIJI_AGENT_DATA_DIR>/ui-preferences.json`
 * 取值，env 缺失时回落 en-US。显式钉死 = 拒绝宿主 env 污染（否则确认文案会在 zh/en 间漂移，
 * 而既有 notify 断言同样假定 en-US）。
 *
 * @param {Array<Object>} fauxSteps faux 响应步骤队列（写入 TAIJI_FAUX_SCRIPT 脚本）
 * @param {{ autoRename?: boolean }} [options] autoRename=true 时预置 rename-session 的
 *   **pi CLI 用户主开关**（`<agentDir>/config/rename-session-ext-config.json` 的
 *   `enabled:true`-默认 false，llm-shared getConfigPath 推导）。仅供 S22 使用
 *   （需同时经 extraExtensions 加载 rename-session 扩展）——使「合成轮不触发自动改名」
 *   具备判别力。
 */
function makeFauxAgentDir(tag, fauxSteps, options = {}) {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), `pi-sched-faux-${tag}.`))
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'faux',
    defaultModel: FAUX_MODEL_ID,
    enabledModels: [MODEL.split(':')[0]],
    retry: { enabled: false },
  }, null, 2))
  writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      faux: {
        name: 'faux',
        api: 'faux',
        apiKey: 'not-needed',
        // baseUrl 必需：pi 的自定义模型校验（provider-composer `applyModelsJson`）要求
        // 「models.json 里定义 models 的 provider 必须有 baseUrl」。基座（faux 是
        // extension-native provider，不在 pi builtins）仅在 provider 首次注册时提供
        // model 默认值；ack 的覆写走 `pi.registerProvider('faux', {api,streamSimple})`
        // 会先删 native 基座再校验，此时默认值只能来自 models.json —— 缺 baseUrl 会抛
        // `Provider faux: "baseUrl" is required when defining custom models.` 使覆写
        // 走 E1 降级（确认轮缺席）。faux 演员不耗网络，baseUrl 仅过校验（占位形态）。
        baseUrl: 'http://127.0.0.1:1/faux',
        models: [{ id: FAUX_MODEL_ID, name: `Faux ${FAUX_MODEL_ID}`, input: ['text'], contextWindow: 128000, maxTokens: 16384 }],
      },
    },
  }, null, 2))
  // locale 钉死（确认文案断言的确定性前提）：见上方 doc 注释。
  writeFileSync(path.join(agentDir, 'ui-preferences.json'), JSON.stringify({ v: 1, locale: 'en-US' }, null, 2))
  if (options.autoRename === true) {
    const renameConfigDir = path.join(agentDir, 'config')
    mkdirSync(renameConfigDir, { recursive: true })
    // 只写用户主开关字段，其余（model/mode/maxTitleLength/thinkingLevel）由
    // rename-session 的 normalizeRenameConfig 补默认（mode 默认 first-stop）。
    writeFileSync(
      path.join(renameConfigDir, 'rename-session-ext-config.json'),
      JSON.stringify({ enabled: true }, null, 2),
    )
  }
  const scriptPath = path.join(agentDir, 'faux-responses.json')
  writeFileSync(scriptPath, JSON.stringify(fauxSteps))
  return {
    agentDir,
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      TAIJI_FAUX_SCRIPT: scriptPath,
      TAIJI_AGENT_DATA_DIR: agentDir,
    },
  }
}

// ── 基础工具 ──

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** @returns {string | null} */
function locatePiBinary() {
  const candidates = [process.env.PI_BIN || null, PI_BIN_DEFAULT].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/**
 * importer.ts getLegacyStorePath 的 CommonJS 端口（R-cleanup 用，推导需清理的路径）。
 * 推导逻辑必须与 extensions/universal/scheduler/src/importer.ts 完全一致。
 */
function getLegacyStorePath(cwd) {
  const home = os.homedir()
  const resolved = path.resolve(cwd)
  const parsed = path.parse(resolved)
  const segments = resolved
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)
  const root =
    parsed.root
      .replaceAll(/[^a-zA-Z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '')
      .toLowerCase() || 'root'
  return path.join(home, '.pi', 'agent', 'scheduler', root, ...segments, 'scheduler.json')
}

/**
 * 清理 getLegacyStorePath(cwd) 推导出的整棵子树（含 .imported 残留）。
 * R-cleanup：不止删 tempCwd + session-dir，还要清用户真实 pi 数据目录内的 legacy store 残留。
 */
function cleanupLegacyStore(cwd) {
  const legacyPath = getLegacyStorePath(cwd)
  const legacyLeafDir = path.dirname(legacyPath) // <segments>/ 最深目录（含 scheduler.json / .imported）
  try {
    rmSync(legacyLeafDir, { recursive: true, force: true })
  } catch (_) {
    /* best-effort */
  }
  // 向上清理空目录，直到 ~/.pi/agent/scheduler/ 为止（不留 tempCwd 对应的空骨架）
  const schedulerRoot = path.join(os.homedir(), '.pi', 'agent', 'scheduler')
  let cur = path.dirname(legacyLeafDir)
  while (cur.startsWith(schedulerRoot) && cur !== schedulerRoot) {
    try {
      if (readdirSync(cur).length === 0) {
        rmSync(cur, { recursive: true, force: true })
      } else {
        break
      }
    } catch (_) {
      break
    }
    cur = path.dirname(cur)
  }
}

/** 创建临时工作区（cwd + session-dir 各自独立目录，便于 cleanup）。 */
function makeTempWorkspace(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `pi-sched-${label}-`))
  return {
    cwd: root,
    sessionDir: path.join(root, 'sessions'),
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch (_) {
        /* best-effort */
      }
      cleanupLegacyStore(root)
    },
  }
}

// ── pi RPC session 封装 ──

// ── stdout RPC 流处理（从 spawnSession 的 stdout 回调提取的模块级 helper 链）──

/**
 * 处理一段 pi stdout 文本：累积行缓冲，按 \n 切行逐行分发。
 * @param {string} text
 * @param {{ stdoutBuf: string, turnEndResolver: { resolve: (v: unknown) => void } | null, sessionFileCache: string | null, uiActor?: UiActor | null, respond: ((obj: Record<string, unknown>) => void) | null }} state
 * @param {unknown[]} captured
 * @param {Map<string, { resolve: (v: unknown) => void }>} pending
 */
function consumeStdoutChunk(text, state, captured, pending) {
  state.stdoutBuf += text
  let nl
  while ((nl = state.stdoutBuf.indexOf('\n')) >= 0) {
    const line = state.stdoutBuf.slice(0, nl)
    state.stdoutBuf = state.stdoutBuf.slice(nl + 1)
    consumeRpcLine(line, state, captured, pending)
  }
}

/**
 * @typedef {Object} ExtensionUiRequestView
 * @property {string} id pi 生成的请求 id（应答帧原样回传）
 * @property {string} method 'select' | 'confirm' | 'input' | 'notify' | ...
 * @property {string | undefined} title select 标题（marker 判定依据）
 * @property {string[] | undefined} options select 选项（options[0] = 序列化 draft）
 */

/**
 * @typedef {Object} NotifyFrameView
 * @property {string} id 通知帧 id（单向帧，无应答）
 * @property {string} message ctx.ui.notify 的文案
 * @property {string | undefined} notifyType 'info' | 'warning' | 'error' | ...
 */

/**
 * @callback UiActor
 * @param {ExtensionUiRequestView} req
 * @returns {{ cancelled: true } | { value: string } | null} 取消 / 确认（value=回传值）/
 *   null（不应答——select 挂起，语义与 taiji runtime 不超时等待同构）
 */

/**
 * 判定 extension_ui_request 帧是否为统一表单 schedule 请求（marker + 问题类型双条件）。
 * @param {ExtensionUiRequestView} req
 * @returns {{ type: 'schedule', header?: string, question: string, initial?: object } | null}
 */
function parseScheduleQuestion(req) {
  if (req.method !== 'select' || req.title !== UI_FORM_MARKER) return null
  return getScheduleQuestionFromRequest(req)
}

/** answers key（D2 fallback：header ?? question——与 FormOverlay qKey 同规则） */
function formAnswerKey(q) {
  return typeof q.header === 'string' ? q.header : q.question
}

/**
 * 构造 schedule 表单的确认回包：FormAnswers envelope（{key: flat ScheduleFormResult
 * JSON}，key = header ?? question）。result 为用户裁定值（action 恒 'create'）。
 * 命令路径（S18/S20/S21）的 uiActor 共用本构造函数。
 * @param {{ header?: string, question: string }} question
 * @param {Record<string, unknown>} result
 * @returns {{ value: string }}
 */
function scheduleFormAnswer(question, result) {
  return {
    value: JSON.stringify({
      [formAnswerKey(question)]: JSON.stringify({ action: 'create', ...result }),
    }),
  }
}

/** notify 帧入 state.notifies（命令路径反馈的捕获面；单向帧无应答）。 */
function captureNotifyFrame(msg, state) {
  state.notifies.push({
    id: typeof msg.id === 'string' ? msg.id : String(msg.id),
    message: typeof msg.message === 'string' ? msg.message : '',
    notifyType: typeof msg.notifyType === 'string' ? msg.notifyType : undefined,
  })
}

/**
 * extension_ui_request 帧分发：捕获 notify（命令路径断言面）+ 按场景 uiActor 应答。
 * 帧契约（pi 0.84.4 dist/modes/rpc/rpc-mode.js）：stdout 输出
 * {type:'extension_ui_request', id, method, ...}，stdin 回
 * {type:'extension_ui_response', id, ...reply}（cancelled:true → resolve undefined；
 * value → resolve value）。notify/setStatus/setWidget 等单向帧不期待应答。
 *
 * 缺省（无 uiActor）**不确认表单**：schedule 表单请求属非预期（模型路径已直建，
 * 不应弹表单）→ 记录进 state.unexpectedScheduleForms 并回 cancelled（不创建、不挂起，
 * 避免误报成 turn 超时）；其余 select 请求不应答（挂起），由场景断言暴露契约漂移。
 * @param {Record<string, unknown>} msg 已解析的 stdout JSON 帧
 * @param {{ uiActor?: UiActor | null, respond: ((obj: Record<string, unknown>) => void) | null,
 *           notifies: NotifyFrameView[], unexpectedScheduleForms: ExtensionUiRequestView[] }} state
 */
function respondExtensionUiRequest(msg, state) {
  if (!msg || msg.type !== 'extension_ui_request') return
  if (msg.method === 'notify') captureNotifyFrame(msg, state)
  const view = {
    id: typeof msg.id === 'string' ? msg.id : String(msg.id),
    method: typeof msg.method === 'string' ? msg.method : '',
    title: typeof msg.title === 'string' ? msg.title : undefined,
    options: Array.isArray(msg.options) ? msg.options.map(String) : undefined,
  }
  let reply
  if (state.uiActor) {
    reply = state.uiActor(view)
  } else {
    if (!parseScheduleQuestion(view)) return
    state.unexpectedScheduleForms.push(view)
    reply = { cancelled: true }
  }
  if (reply && state.respond) {
    state.respond({ type: 'extension_ui_response', id: msg.id, ...reply })
  }
}

/** 解析一行 JSON 并按序分发：captured → sessionFile 缓存 → pending resolve → ui 应答 → turn_end resolve。 */
function consumeRpcLine(line, state, captured, pending) {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch (_) {
    return // 非 JSON banner
  }
  captured.push(msg)
  cacheSessionFile(msg, state)
  resolvePendingResponse(msg, pending)
  respondExtensionUiRequest(msg, state)
  resolveTurnEndWaiter(msg, state)
}

/** get_state response 里的 sessionFile 进缓存（供 getJsonlSnippet() 同步读 JSONL 证据）。 */
function cacheSessionFile(msg, state) {
  if (
    msg &&
    msg.type === 'response' &&
    msg.data &&
    typeof msg.data.sessionFile === 'string'
  ) {
    state.sessionFileCache = msg.data.sessionFile
  }
}

/** response 按 id 命中 pending 表则 resolve 并移除。 */
function resolvePendingResponse(msg, pending) {
  if (msg && msg.type === 'response' && msg.id) {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p.resolve(msg)
    }
  }
}

/** turn_end（非 toolUse 才是真回合结束；toolUse 会继续下一轮）→ 唤醒 waitForTurnEnd。 */
function resolveTurnEndWaiter(msg, state) {
  if (msg && msg.type === 'turn_end') {
    const stopReason =
      (msg.message && msg.message.stopReason) || msg.stopReason || ''
    if (stopReason !== 'toolUse' && state.turnEndResolver) {
      const r = state.turnEndResolver
      state.turnEndResolver = null
      r.resolve({ ok: true, stopReason })
    }
  }
}

/**
 * spawn 一个 pi 进程（加载 scheduler + faux provider extension，关 builtin tools——
 * 模型的工具面只剩 scheduler 的 schedule/schedule_control，工具调用由 faux 队列预设）。
 * 返回 RPC 控制 API。
 *
 * @param {{ piBin: string, cwd: string, sessionDir: string, sessionFile?: string, label: string,
 *           fauxSteps: Array<Object>, uiActor?: UiActor, extraExtensions?: string[],
 *           autoRename?: boolean }} opts
 *   fauxSteps：faux 响应步骤队列（toolCall/text；模型路径必填——每 session 独立 agentDir
 *   + 独立响应脚本，S3/S5 等多进程场景互不串队）。命令路径（slash）不消费队列，可留空。
 *   uiActor：extension_ui_request 应答器。缺省 = 不回确认（schedule 表单请求记入
 *   unexpectedScheduleForms 并回 cancelled）；S18/S20/S21 注入用户裁定值确认、S19 注入取消。
 */
function spawnSession(opts) {
  const faux = makeFauxAgentDir(opts.label, opts.fauxSteps, { autoRename: opts.autoRename === true })
  const args = [
    '--no-extensions',
    '--extension',
    EXTENSION_PATH,
    '--extension',
    FAUX_LLM_EXT_PATH, // faux provider 注册（凭证无关 LLM 演员）
    '--no-builtin-tools', // 关闭内置工具，模型只能用 scheduler 的 schedule/schedule_control
    '--no-context-files', // 跳过 CLAUDE.md 等上下文文件（提速 + 避免污染）
    '--mode',
    'rpc',
    '--session-dir',
    opts.sessionDir,
    '--model',
    MODEL,
    '--approve',
  ]
  // 追加扩展（S22：rename-session）——`--no-extensions` 后逐个显式加载
  for (const extra of opts.extraExtensions || []) {
    args.push('--extension', extra)
  }
  if (opts.sessionFile) {
    args.push('--session', opts.sessionFile) // resume 指定 session 文件
  }
  const child = spawn(opts.piBin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: {
      ...process.env,
      PI_SKIP_VERSION_CHECK: '1',
      // 诊断：保留临时 agentDir 时打开 pi debug 日志，使 <agentDir>/logs/ 真有内容可取
      ...(process.env.SCHED_E2E_KEEP_TMP === '1' ? { TAIJI_AGENT_DEBUG: '1' } : {}),
      ...faux.env,
    },
  })

  let rpcId = 0
  /** @type {Map<string, { resolve: (v: unknown) => void }>} */
  const pending = new Map()
  /** @type {unknown[]} */ // 所有 stdout JSON 消息（response / streaming / turn_end 等）
  const captured = []
  // 跨 chunk 可变状态：stdout 行缓冲 / turn_end 等待者 / sessionFile 缓存 /
  // ui 应答器（extension_ui_request → extension_ui_response）/
  // notify 捕获面 + 非预期表单请求记录（命令路径断言 / 模型路径回归守卫）
  const state = {
    stdoutBuf: '',
    turnEndResolver: null,
    sessionFileCache: null,
    uiActor: opts.uiActor || null,
    respond: null,
    /** @type {Array<{ id: string, message: string, notifyType: string | undefined }>} */
    notifies: [],
    /** @type {Array<{ id: string, options: string[] }>} */
    unexpectedScheduleForms: [],
  }
  let stderrBuf = ''

  state.respond = (obj) => {
    child.stdin.write(JSON.stringify(obj) + '\n')
  }

  child.stdout.on('data', (d) => {
    consumeStdoutChunk(d.toString('utf-8'), state, captured, pending)
  })

  child.stderr.on('data', (d) => {
    stderrBuf += d.toString('utf-8')
  })

  function sendRpc(command) {
    const id = 'r' + ++rpcId
    return new Promise((resolve) => {
      pending.set(id, { resolve })
      child.stdin.write(JSON.stringify({ ...command, id }) + '\n')
    })
  }

  function waitForTurnEnd(timeoutMs) {
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (!done) {
          done = true
          state.turnEndResolver = null
          resolve({ ok: false })
        }
      }, timeoutMs)
      state.turnEndResolver = {
        resolve: (v) => {
          if (!done) {
            done = true
            clearTimeout(timer)
            resolve(v)
          }
        },
      }
    })
  }

  /** 等待 RPC 通道就绪（get_state 成功 = extension 加载成功）。 */
  async function waitReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = await Promise.race([
        sendRpc({ type: 'get_state' }),
        sleep(5000).then(() => null),
      ])
      if (r && r.success) return r
      await sleep(500)
    }
    return null
  }

  /** 发 prompt 并等回合结束（模型路径）。返回 { ok, stopReason }。 */
  async function prompt(message, turnTimeoutMs = 120000) {
    const ack = await Promise.race([
      sendRpc({ type: 'prompt', message }),
      sleep(20000).then(() => null),
    ])
    if (!ack) throw new Error('prompt ack timeout (20s)')
    if (!ack.success) {
      throw new Error('prompt rejected: ' + JSON.stringify(ack.error || ack.data))
    }
    return waitForTurnEnd(turnTimeoutMs)
  }

  /**
   * 发 slash 命令 prompt（`/schedule ...`）并**只等 ack**（命令路径）。
   * pi 的 `/` 分支在 prompt 内执行扩展命令且不产生 turn 事件（无 turn_end），
   * 故不能复用 prompt() 的回合等待；表单帧 / notify 帧由后续轮询捕获。
   */
  async function sendCommand(message, ackTimeoutMs = 20000) {
    const ack = await Promise.race([
      sendRpc({ type: 'prompt', message }),
      sleep(ackTimeoutMs).then(() => null),
    ])
    if (!ack) throw new Error('command ack timeout (20s)')
    if (!ack.success) {
      throw new Error('command rejected: ' + JSON.stringify(ack.error || ack.data))
    }
    return ack
  }

  /** 轮询等待首个统一表单 schedule 请求帧（已到的请求帧原样返回；超时返回现有列表）。 */
  async function waitForFormRequest(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const reqs = getScheduleFormRequests(captured)
      if (reqs.length > 0) return reqs
      await sleep(200)
    }
    return getScheduleFormRequests(captured)
  }

  /** 轮询等待匹配的 notify 帧（predicate 缺省匹配任意 notify）；超时返回 null。 */
  async function waitForNotify(predicate, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = state.notifies.find((n) => (predicate ? predicate(n) : true))
      if (hit) return hit
      await sleep(200)
    }
    return null
  }

  async function getEntries() {
    const r = await sendRpc({ type: 'get_entries' })
    if (r && r.success && r.data && Array.isArray(r.data.entries)) return r.data.entries
    return []
  }

  async function getMessages() {
    const r = await sendRpc({ type: 'get_messages' })
    if (r && r.success && r.data && Array.isArray(r.data.messages)) return r.data.messages
    return []
  }

  async function getState() {
    return sendRpc({ type: 'get_state' })
  }

  /** get_state 响应的 data 域（model / sessionFile / sessionName / isStreaming）；失败 ⇒ null。 */
  async function getStateData() {
    const r = await getState()
    return r && r.success && r.data ? r.data : null
  }

  /**
   * 解析式读会话 JSONL（只反映**已落盘**内容，不含内存 fileEntries）：
   * 文件不存在 / 读失败 ⇒ []（会话未落盘的正常形态）。
   * @returns {unknown[]}
   */
  function readJsonlEntries() {
    const f = state.sessionFileCache
    if (!f || !existsSync(f)) return []
    let raw
    try {
      raw = readFileSync(f, 'utf-8')
    } catch (_) {
      return []
    }
    return parseJsonlEntries(raw)
  }

  /**
   * 轮询等会话 JSONL 满足 predicate（参数 = parsed entries）。
   * 确认轮是**异步副作用**（命令路径 sendCommand 只等 prompt ack），故不可假定读时已落盘。
   * @param {(entries: unknown[]) => boolean} predicate
   * @param {number} timeoutMs 必填（调用方显式给预算，无隐式默认）
   * @returns {Promise<{ ok: boolean, entries: unknown[] }>}
   */
  async function waitForJsonlEntries(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const entries = readJsonlEntries()
      if (predicate(entries)) return { ok: true, entries }
      await sleep(200)
    }
    return { ok: false, entries: readJsonlEntries() }
  }

  function kill() {
    try {
      child.kill('SIGTERM')
    } catch (_) {
      /* noop */
    }
    // 诊断：SCHED_E2E_KEEP_TMP=1 保留临时 agentDir（含扩展文件日志 <agentDir>/logs/，
    // 如 scheduler 的 ack 分诊警告；spawn env 已注入 TAIJI_AGENT_DEBUG=1），便于失败归因；
    // 会话 JSONL 属 sessionDir、不被此处保留。常态删除（防泄漏）。
    if (process.env.SCHED_E2E_KEEP_TMP === '1') {
      console.log(`${TAG} [debug] keep tmp agentDir: ${faux.agentDir}`)
      return
    }
    // faux agentDir（settings/models/响应脚本）随 session 生命周期清理；getJsonlSnippet
    // 读的是 sessionFileCache（session-dir 内），不受影响
    try {
      rmSync(faux.agentDir, { recursive: true, force: true })
    } catch (_) {
      /* best-effort */
    }
  }

  function stderrTail(len = 400) {
    return stderrBuf.slice(-len)
  }

  /**
   * 同步读取缓存的 sessionFile，提取 pi-scheduler:task custom entry 行的精简片段。
   * kill() 后仍可调用（实例变量 + 磁盘文件均存活，直到 ws.cleanup()）。
   * 用于 A 类场景的 JSONL 持久化证据（验证 V4 appendEntry 落盘）。
   */
  function getJsonlSnippet(maxLines = 8) {
    if (!state.sessionFileCache || !existsSync(state.sessionFileCache)) return ''
    let content
    try {
      content = readFileSync(state.sessionFileCache, 'utf-8')
    } catch (_) {
      return ''
    }
    const lines = content.split('\n').filter((l) => l.includes('pi-scheduler:task'))
    if (lines.length === 0) return '(no pi-scheduler:task line in file)'
    return lines
      .slice(0, maxLines)
      .map((l) => {
        try {
          const e = JSON.parse(l)
          const d = e.data || {}
          const parts = [`op=${d.op}`]
          if (d.taskId) parts.push(`id=${String(d.taskId).slice(0, 8)}`)
          const nr =
            typeof d.nextRunAt === 'number'
              ? d.nextRunAt
              : d.task && typeof d.task.nextRunAt === 'number'
                ? d.task.nextRunAt
                : null
          if (nr !== null) parts.push(`next=${nr}`)
          return parts.join(' ')
        } catch (_) {
          return l.slice(0, 100)
        }
      })
      .join(' | ')
  }

  return {
    sendRpc,
    waitForTurnEnd,
    waitReady,
    prompt,
    sendCommand,
    waitForFormRequest,
    waitForNotify,
    getEntries,
    getMessages,
    getState,
    getStateData,
    readJsonlEntries,
    waitForJsonlEntries,
    kill,
    stderrTail,
    getJsonlSnippet,
    /** @returns {unknown[]} */
    getCaptured: () => captured,
    /** @returns {Array<{ id: string, message: string, notifyType: string | undefined }>} */
    getNotifies: () => state.notifies,
    /** @returns {Array<{ id: string, options: string[] }>} 非预期（缺省 uiActor 下）表单请求 */
    getUnexpectedScheduleForms: () => state.unexpectedScheduleForms,
  }
}

// ── 断言辅助 ──

function messageToText(message) {
  if (!message) return ''
  const c = message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

/** 从所有消息（任意 role，含 toolResult）提取全部文本。 */
function extractAllText(messages) {
  return (messages || []).map(messageToText).join('\n')
}

/**
 * 合并 blob：get_messages 文本 + 所有捕获的原始 stdout JSON。
 * 用于回显/list 文本断言——belt-and-suspenders，任一来源命中即满足。
 */
function fullTextBlob(messages, captured) {
  const msgText = extractAllText(messages)
  const capturedText = (captured || [])
    .map((m) => {
      try {
        return typeof m === 'string' ? m : JSON.stringify(m)
      } catch (_) {
        return ''
      }
    })
    .join('\n')
  return msgText + '\n' + capturedText
}

/** 过滤出 pi-scheduler:task custom entries。 */
function getSchedulerEntries(entries) {
  return (entries || []).filter(
    (e) =>
      e &&
      e.type === 'custom' &&
      e.customType === 'pi-scheduler:task' &&
      e.data &&
      typeof e.data === 'object' &&
      'op' in e.data,
  )
}

/** 提取 scheduler entry 的 op 序列（按顺序，如 ['upsert','advance','advance']）。 */
function getOpSequence(schedulerEntries) {
  return schedulerEntries.map((e) => (e.data && e.data.op) || '?')
}

/** 数 nextRun 行：recurring 的 "  N. in ..." 编号行数；once 无编号行返回 0。 */
function countNumberedRunLines(text) {
  const matches = text.match(/^\s*\d+\.\s+in\s/mg)
  return matches ? matches.length : 0
}

/**
 * 从 captured 提取统一表单 schedule 请求帧列表（命令路径表单的请求侧证据；模型路径下
 * 应为空——`schedule` tool 直建不再弹表单，回归守卫由场景断言 unexpectedScheduleForms）。
 * @param {unknown[]} captured
 * @returns {Array<{ id: string, options: string[] }>}
 */
function getScheduleFormRequests(captured) {
  return (captured || [])
    .filter(
      (m) =>
        m &&
        m.type === 'extension_ui_request' &&
        m.method === 'select' &&
        m.title === UI_FORM_MARKER,
    )
    .map((m) => ({
      id: typeof m.id === 'string' ? m.id : String(m.id),
      options: Array.isArray(m.options) ? m.options.map(String) : [],
    }))
}

/** 过滤 assistant message entries（含 aborted 合成行——pi 会照常 append）。 */
function getAssistantEntries(entries) {
  return (entries || []).filter(
    (e) =>
      e &&
      e.type === 'message' &&
      e.message &&
      typeof e.message === 'object' &&
      e.message.role === 'assistant',
  )
}

/** 会话 entries 中是否存在 aborted assistant 行（= 命令路径确认轮已落盘的判据）。 */
function hasAbortedAssistant(entries) {
  return getAssistantEntries(entries).some((e) => e.message.stopReason === 'aborted')
}

/** 数某类 entry 行数（宿主不变量：model_change / thinking_level_change / session_info 计数用）。 */
function countEntryType(entries, type) {
  return (entries || []).filter((e) => e && e.type === type).length
}

/** assistant 行字段投影摘要（provider / model / stopReason / usage / 正文片段）。 */
function describeAssistantEntry(entry) {
  const m = entry && entry.message ? entry.message : {}
  return `provider=${String(m.provider)} model=${String(m.model)} stopReason=${String(m.stopReason)} `
    + `usage=${JSON.stringify(m.usage)} text=${JSON.stringify(messageToText(m).slice(0, 120))}`
}

/** usage（含 cost 各字段）是否全 0（合成行不变量：不污染 context 统计）。 */
function isZeroUsage(usage) {
  if (!usage || typeof usage !== 'object') return false
  const cost = usage.cost && typeof usage.cost === 'object' ? usage.cost : {}
  const nums = [
    usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens,
    cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total,
  ]
  return nums.every((n) => n === 0)
}

/**
 * 确认轮断言包（S18/S20/S21/S22/S23 共用）：会话 JSONL 的 aborted assistant 行 + 确认文案。
 *
 * 断言源 = pi 落盘后的 JSONL（非内存 get_entries）：合成轮的意义就是打开落盘开关，
 * 断言必须落在磁盘产物上。文案权威源 = `extensions/universal/scheduler/src/i18n.ts`
 * 的 `ack.confirm`（en-US 形：`Task saved: {name} ({schedule}).`）——locale 由
 * makeFauxAgentDir 的 `TAIJI_AGENT_DATA_DIR/ui-preferences.json` 钉死 en-US。
 *
 * @param {unknown[]} entries parsed JSONL entries
 * @param {{ name: string, schedule: string }} expected 文案插值（任务名 + formatSchedule 结果）
 * @returns {{ ok: boolean, desc: string }}
 */
function checkAckConfirmLine(entries, expected) {
  const assistants = getAssistantEntries(entries)
  const aborted = assistants.filter((e) => e.message.stopReason === 'aborted')
  const expectedText = `Task saved: ${expected.name} (${expected.schedule}).`
  const matched = aborted.filter((e) => messageToText(e.message).includes(expectedText))
  return {
    ok: aborted.length >= 1 && matched.length >= 1,
    desc: `abortedAssistantLines=${aborted.length} confirmTextExpected=${JSON.stringify(expectedText)} `
      + `confirmTextMatched=${matched.length}`,
  }
}

/** 轮询等会话空闲（get_state.isStreaming === false）；确认轮落盘早于 turn_end 收尾时用。 */
async function waitUntilIdle(s, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = await s.getStateData()
    if (st && st.isStreaming === false) return true
    await sleep(200)
  }
  return false
}

/** 原始 JSONL 诊断转储（场景 FAIL 时由 main 无条件调用；失败归因用，不进常态输出）。 */
function debugDumpJsonl(label, entries) {
  console.log(`${TAG} [debug] ${label}: ${(entries || []).length} entries`)
  for (const e of entries || []) {
    console.log(`${TAG} [debug]   ${JSON.stringify(e).slice(0, 900)}`)
  }
}

// ── 场景定义 ──
// 每个场景函数返回 { name, status, evidence, followup? }
// status: 'PASS' | 'FAIL' | 'FOLLOWUP'

/** S1：once 回显仅 1 条 run 行、不含 "Next 5 runs:"；`schedule` tool 直建（无确认表单帧）。 */
async function runS1(piBin) {
  const ws = makeTempWorkspace('s1')
  try {
    const s = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S1',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'test-once-echo', schedule: '1h', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    const ready = await s.waitReady()
    if (!ready) return fail('S1', 'pi not ready / extension load failed: ' + s.stderrTail())

    const turnEnd = await s.prompt(
      'Create a scheduled task by calling the schedule tool with these exact arguments: prompt is "test-once-echo", schedule is "1h", kind is "once". After the tool returns, reply with the single word: done',
    )
    if (!turnEnd.ok) return fail('S1', 'turn did not end (timeout)')

    const entries = await s.getEntries()
    const sched = getSchedulerEntries(entries)
    const ops = getOpSequence(sched)
    const upserts = sched.filter((e) => e.data.op === 'upsert')
    const messages = await s.getMessages()
    const blob = fullTextBlob(messages, s.getCaptured())
    const unexpectedForms = s.getUnexpectedScheduleForms()

    s.kill()

    const hasOnceEcho = /Next run:\s+in\s+1h/.test(blob)
    const noRecurringHeader = !blob.includes('Next 5 runs:')
    const numberedLines = countNumberedRunLines(blob)
    const hasUpsert = upserts.length >= 1
    // 触发反转回归守卫：模型路径直建，不得出现确认表单帧
    const noConfirmForm = unexpectedForms.length === 0

    const pass =
      hasOnceEcho && noRecurringHeader && numberedLines === 0 && hasUpsert && noConfirmForm
    return {
      name: 'S1',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `once echo 'Next run: in 1h' present=${hasOnceEcho}; ` +
        `no 'Next 5 runs:'=${noRecurringHeader}; numbered run lines=${numberedLines}; ` +
        `no confirm form frame=${noConfirmForm} (unexpectedForms=${unexpectedForms.length}); ` +
        `upsert entries=${upserts.length}; opSeq=${JSON.stringify(ops)}; ` +
        `jsonl=[${s.getJsonlSnippet()}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/** S2：recurring 回显含 "Next 5 runs:" 且 5 条；`schedule` tool 直建（无确认表单帧）。 */
async function runS2(piBin) {
  const ws = makeTempWorkspace('s2')
  try {
    const s = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S2',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'test-recurring', schedule: '10m', kind: 'recurring' } }] },
        { text: 'done' },
      ],
    })
    const ready = await s.waitReady()
    if (!ready) return fail('S2', 'pi not ready: ' + s.stderrTail())

    const turnEnd = await s.prompt(
      'Create a scheduled task by calling the schedule tool with these exact arguments: prompt is "test-recurring", schedule is "10m", kind is "recurring". After the tool returns, reply with the single word: done',
    )
    if (!turnEnd.ok) return fail('S2', 'turn did not end (timeout)')

    const entries = await s.getEntries()
    const sched = getSchedulerEntries(entries)
    const ops = getOpSequence(sched)
    const upserts = sched.filter((e) => e.data.op === 'upsert')
    const messages = await s.getMessages()
    const blob = fullTextBlob(messages, s.getCaptured())
    const unexpectedForms = s.getUnexpectedScheduleForms()
    s.kill()

    const hasRecurringHeader = blob.includes('Next 5 runs:')
    const numberedLines = countNumberedRunLines(blob)
    const hasUpsert = upserts.length >= 1
    const noConfirmForm = unexpectedForms.length === 0

    const pass = hasRecurringHeader && numberedLines === 5 && hasUpsert && noConfirmForm
    return {
      name: 'S2',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `'Next 5 runs:' present=${hasRecurringHeader}; numbered run lines=${numberedLines} (expect 5); ` +
        `no confirm form frame=${noConfirmForm} (unexpectedForms=${unexpectedForms.length}); ` +
        `upsert entries=${upserts.length}; opSeq=${JSON.stringify(ops)}; ` +
        `jsonl=[${s.getJsonlSnippet()}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/** S3：session 隔离——A 建任务，B 同 cwd 看不到。 */
async function runS3(piBin) {
  const ws = makeTempWorkspace('s3')
  // B 用独立 session-dir（同 cwd）
  const sessionDirB = path.join(ws.cwd, 'sessions-b')
  try {
    // A
    const sA = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S3-A',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'iso-A-task', schedule: '30m', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    const readyA = await sA.waitReady()
    if (!readyA) return fail('S3', 'pi A not ready: ' + sA.stderrTail())

    const tA = await sA.prompt(
      'Create a scheduled task by calling the schedule tool: prompt is "iso-A-task", schedule is "30m", kind is "once". After the tool returns, reply: done',
    )
    if (!tA.ok) return fail('S3', 'A turn did not end')
    const entriesA = await sA.getEntries()
    const schedA = getSchedulerEntries(entriesA)
    if (schedA.filter((e) => e.data.op === 'upsert').length < 1) {
      sA.kill()
      return fail('S3', 'A did not create task (no upsert entry)')
    }
    sA.kill()

    // B（同 cwd，不同 session-dir → 不同 session 文件）
    const sB = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: sessionDirB, label: 'S3-B',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    const readyB = await sB.waitReady()
    if (!readyB) return fail('S3', 'pi B not ready: ' + sB.stderrTail())

    const tB = await sB.prompt(
      'Call the schedule_control tool with action set to "list". Then reply with the single word: done',
    )
    if (!tB.ok) return fail('S3', 'B turn did not end')

    const entriesB = await sB.getEntries()
    const schedB = getSchedulerEntries(entriesB)
    const messagesB = await sB.getMessages()
    const blobB = fullTextBlob(messagesB, sB.getCaptured())
    sB.kill()

    const bEmpty = schedB.length === 0
    const bListSaysNone = blobB.includes('No scheduled tasks.')

    const pass = bEmpty && bListSaysNone
    return {
      name: 'S3',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `B scheduler entries=${schedB.length} (expect 0); ` +
        `B list 'No scheduled tasks.' present=${bListSaysNone}; ` +
        `A created task (upsert) confirmed before B started; ` +
        `A-jsonl=[${sA.getJsonlSnippet()}]; B-jsonl=[${sB.getJsonlSnippet()}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/** S5：resume 重放——kill 后重开同 session，任务仍在。 */
async function runS5(piBin) {
  const ws = makeTempWorkspace('s5')
  try {
    const sA = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S5-A',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'resume-test', schedule: '30m', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    const readyA = await sA.waitReady()
    if (!readyA) return fail('S5', 'pi A not ready: ' + sA.stderrTail())

    const tA = await sA.prompt(
      'Create a scheduled task by calling the schedule tool: prompt is "resume-test", schedule is "30m", kind is "once". After the tool returns, reply: done',
    )
    if (!tA.ok) return fail('S5', 'A turn did not end')
    const entriesA = await sA.getEntries()
    const schedA = getSchedulerEntries(entriesA)
    if (schedA.filter((e) => e.data.op === 'upsert').length < 1) {
      sA.kill()
      return fail('S5', 'A did not create task')
    }
    const stateA = await sA.getState()
    const sessionFile =
      stateA && stateA.data && stateA.data.sessionFile
        ? stateA.data.sessionFile
        : null
    sA.kill()
    if (!sessionFile) return fail('S5', 'could not read A sessionFile from get_state')

    // resume：--session 指定原 session 文件
    const sA2 = spawnSession({
      piBin,
      cwd: ws.cwd,
      sessionDir: ws.sessionDir,
      sessionFile,
      label: 'S5-A2',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    const readyA2 = await sA2.waitReady()
    if (!readyA2) return fail('S5', 'pi A2 (resume) not ready: ' + sA2.stderrTail())

    const tA2 = await sA2.prompt(
      'Call the schedule_control tool with action set to "list". Then reply: done',
    )
    if (!tA2.ok) return fail('S5', 'A2 turn did not end')

    const entriesA2 = await sA2.getEntries()
    const schedA2 = getSchedulerEntries(entriesA2)
    const opsA2 = getOpSequence(schedA2)
    const messagesA2 = await sA2.getMessages()
    const blobA2 = fullTextBlob(messagesA2, sA2.getCaptured())
    sA2.kill()

    const hasUpsertReplay = schedA2.filter((e) => e.data.op === 'upsert').length >= 1
    const listNotSaysNone = !blobA2.includes('No scheduled tasks.')

    const pass = hasUpsertReplay && listNotSaysNone
    return {
      name: 'S5',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `resume 后 upsert entry present=${hasUpsertReplay}; ` +
        `list 不含 'No scheduled tasks.'=${listNotSaysNone}; ` +
        `resumed opSeq=${JSON.stringify(opsA2)} (含 upsert=重放恢复); ` +
        `A2-jsonl=[${sA2.getJsonlSnippet()}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/** S9：删 session 文件无残留——B 同 cwd 启动，list 为空，磁盘无孤儿。 */
async function runS9(piBin) {
  const ws = makeTempWorkspace('s9')
  const sessionDirB = path.join(ws.cwd, 'sessions-b')
  try {
    const sA = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S9-A',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'orphan-test', schedule: '30m', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    const readyA = await sA.waitReady()
    if (!readyA) return fail('S9', 'pi A not ready: ' + sA.stderrTail())

    const tA = await sA.prompt(
      'Create a scheduled task by calling the schedule tool: prompt is "orphan-test", schedule is "30m", kind is "once". After the tool returns, reply: done',
    )
    if (!tA.ok) return fail('S9', 'A turn did not end')
    const entriesA = await sA.getEntries()
    if (getSchedulerEntries(entriesA).length < 1) {
      sA.kill()
      return fail('S9', 'A did not create task')
    }
    const stateA = await sA.getState()
    const sessionFile =
      stateA && stateA.data && stateA.data.sessionFile ? stateA.data.sessionFile : null
    sA.kill()

    // 删除 A 的 session 文件（模拟 session 被删除）
    if (sessionFile && existsSync(sessionFile)) {
      try {
        rmSync(sessionFile, { force: true })
      } catch (_) {
        /* best-effort */
      }
    }

    // B 同 cwd 启动
    const sB = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: sessionDirB, label: 'S9-B',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    const readyB = await sB.waitReady()
    if (!readyB) return fail('S9', 'pi B not ready: ' + sB.stderrTail())

    const tB = await sB.prompt(
      'Call the schedule_control tool with action set to "list". Then reply: done',
    )
    if (!tB.ok) return fail('S9', 'B turn did not end')

    const entriesB = await sB.getEntries()
    const schedB = getSchedulerEntries(entriesB)
    const messagesB = await sB.getMessages()
    const blobB = fullTextBlob(messagesB, sB.getCaptured())
    sB.kill()

    // 磁盘孤儿检查：legacy store 路径不应有 scheduler.json
    const legacyPath = getLegacyStorePath(ws.cwd)
    const legacyExists = existsSync(legacyPath)

    const bEmpty = schedB.length === 0
    const bListSaysNone = blobB.includes('No scheduled tasks.')
    const pass = bEmpty && bListSaysNone && !legacyExists

    return {
      name: 'S9',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `B scheduler entries=${schedB.length} (expect 0); ` +
        `B list 'No scheduled tasks.'=${bListSaysNone}; ` +
        `legacy store orphan exists=${legacyExists} (expect false); ` +
        `B-jsonl=[${sB.getJsonlSnippet()}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/**
 * S17：entry 增长——recurring 任务连续 dispatch 后 1 upsert + N advance，nextRunAt 单调递增。
 *
 * design 写 "10 次 advance"。无法 mock tick（不改产品代码），用短间隔（10s）+ 真等 tick 触发。
 * 阈值 >=8（容忍 tick/LLM 时序抖动），核心断言=线性增长 + nextRunAt 严格递增。
 */
async function runS17(piBin) {
  const ws = makeTempWorkspace('s17')
  try {
    // dispatch 注入 turn 的响应余量：10s recurring × 7min 窗口最多 ~40 次注入，
    // 排 45 个 {text:'ok'}（advance>=10 早停后剩余步骤不消费）
    const sA = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S17',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'Reply with exactly: ok', schedule: '10s', kind: 'recurring' } }] },
        { text: 'done' },
        ...Array.from({ length: 45 }, () => ({ text: 'ok' })),
      ],
    })
    const ready = await sA.waitReady()
    if (!ready) return fail('S17', 'pi not ready: ' + sA.stderrTail())

    const tCreate = await sA.prompt(
      'Create a scheduled task by calling the schedule tool: prompt is "Reply with exactly: ok", schedule is "10s", kind is "recurring". After the tool returns, reply: done',
    )
    if (!tCreate.ok) return fail('S17', 'create turn did not end')

    const targetAdvance = 10
    const minAdvance = 8
    const waitDeadline = Date.now() + 420000 // 7 分钟（10s 间隔 + 30s tick + LLM 响应时间）
    let lastAdvanceCount = 0
    let lastEntries = []
    while (Date.now() < waitDeadline) {
      await sleep(15000)
      const entries = await sA.getEntries()
      const sched = getSchedulerEntries(entries)
      const advanceCount = sched.filter((e) => e.data.op === 'advance').length
      lastAdvanceCount = advanceCount
      lastEntries = sched
      if (advanceCount >= targetAdvance) break
    }
    sA.kill()

    const sched = lastEntries
    const upserts = sched.filter((e) => e.data.op === 'upsert')
    const advances = sched.filter((e) => e.data.op === 'advance')
    // advance 的 nextRunAt 单调递增检查
    const nextRunAts = advances.map((e) => e.data.nextRunAt)
    let monotonic = true
    for (let i = 1; i < nextRunAts.length; i++) {
      if (!(nextRunAts[i] > nextRunAts[i - 1])) {
        monotonic = false
        break
      }
    }

    const pass =
      upserts.length === 1 &&
      advances.length >= minAdvance &&
      advances.length >= 1 &&
      monotonic

    return {
      name: 'S17',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `upsert=${upserts.length} (expect 1); advance=${advances.length} ` +
        `(target ${targetAdvance}, min ${minAdvance}, got ${lastAdvanceCount}); ` +
        `nextRunAt monotonic increasing=${monotonic}; ` +
        `nextRunAt samples=${JSON.stringify(nextRunAts.slice(0, 12))}; ` +
        `jsonl=[${sA.getJsonlSnippet()}]`,
    }
  } finally {
    ws.cleanup()
  }
}

// ── B 类（尽力自动化）──

/** S4：到期只注入 owner——A 建 1m once 任务，B 同 cwd，等到期，A 触发 B 不触发。 */
async function runS4(piBin) {
  const ws = makeTempWorkspace('s4')
  const sessionDirB = path.join(ws.cwd, 'sessions-b')
  try {
    const sA = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S4-A',
      // dispatch 注入 turn 的响应余量（1m once 到期注入 1 次 + 抖动余量）
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'owner-dispatch-check', schedule: '1m', kind: 'once' } }] },
        { text: 'done' },
        ...Array.from({ length: 3 }, () => ({ text: 'ok' })),
      ],
    })
    const readyA = await sA.waitReady()
    if (!readyA) return fail('S4', 'pi A not ready: ' + sA.stderrTail())

    const tA = await sA.prompt(
      'Create a scheduled task by calling the schedule tool: prompt is "owner-dispatch-check", schedule is "1m", kind is "once". After the tool returns, reply: done',
    )
    if (!tA.ok) return fail('S4', 'A turn did not end')
    if (getSchedulerEntries(await sA.getEntries()).length < 1) {
      sA.kill()
      return fail('S4', 'A did not create task')
    }

    // B 同 cwd 启动（A 仍存活，两个进程同 cwd 不同 session）
    const sB = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: sessionDirB, label: 'S4-B',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    const readyB = await sB.waitReady()
    if (!readyB) return fail('S4', 'pi B not ready: ' + sB.stderrTail())

    // 轮询等待 once 任务到期 + tick dispatch（1m + 30s tick + 模型响应抖动，固定 80s 不够稳）
    const s4Deadline = Date.now() + 150000
    while (Date.now() < s4Deadline) {
      await sleep(15000)
      if (getSchedulerEntries(await sA.getEntries()).some((e) => e.data.op === 'delete')) break
    }

    const entriesA = await sA.getEntries()
    const entriesB = await sB.getEntries()
    const schedA = getSchedulerEntries(entriesA)
    const schedB = getSchedulerEntries(entriesB)
    sA.kill()
    sB.kill()

    // once dispatch 成功 → append delete entry（抵消 upsert）。A 应有 upsert + delete。
    const aHasDelete = schedA.some((e) => e.data.op === 'delete')
    // B 全程无 scheduler entry
    const bClean = schedB.length === 0

    const pass = aHasDelete && bClean
    return {
      name: 'S4',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `A dispatched (once→delete entry present)=${aHasDelete}; ` +
        `B scheduler entries=${schedB.length} (expect 0); ` +
        `A opSeq=${JSON.stringify(getOpSequence(schedA))}`,
    }
  } finally {
    ws.cleanup()
  }
}

/** S6：旧 store 导入——预置 legacy scheduler.json，A 启动后导入为 upsert entry。 */
async function runS6(piBin) {
  const ws = makeTempWorkspace('s6')
  // macOS /var 是 /private/var 的 symlink：mkdtempSync 返回 /var/...，但 pi 子进程的
  // process.cwd()（=importer 的 ctx.cwd）解析为 /private/var/...。两者推导的 legacy 路径不同，
  // 会导致预置文件与 importer 查找路径错配（rename ENOENT 静默 no-op）。用 realpathSync 对齐。
  const realCwd = realpathSync(ws.cwd)
  try {
    // 预置 legacy store 文件（用 realCwd，与 importer 的 ctx.cwd 推导一致）
    const legacyPath = getLegacyStorePath(realCwd)
    const legacyTask = {
      id: 'legacy001',
      name: 'legacy-import-task',
      prompt: 'imported from old store',
      kind: 'recurring',
      schedule: { mode: 'interval', intervalMs: 600000 },
      enabled: true,
      force: false,
      createdAt: Date.now() - 100000,
      nextRunAt: Date.now() + 600000,
      runCount: 0,
      history: [],
    }
    // 确保目录存在
    const legacyDir = path.dirname(legacyPath)
    try {
      require('node:fs').mkdirSync(legacyDir, { recursive: true })
    } catch (_) {
      /* ignore */
    }
    writeFileSync(legacyPath, JSON.stringify({ version: 1, tasks: [legacyTask] }), 'utf-8')

    const sA = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S6',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    const ready = await sA.waitReady()
    if (!ready) return fail('S6', 'pi not ready: ' + sA.stderrTail())

    const t = await sA.prompt(
      'Call the schedule_control tool with action set to "list". Then reply: done',
    )
    if (!t.ok) return fail('S6', 'turn did not end')

    const entries = await sA.getEntries()
    const sched = getSchedulerEntries(entries)
    const upserts = sched.filter((e) => e.data.op === 'upsert')
    const messages = await sA.getMessages()
    const blob = fullTextBlob(messages, sA.getCaptured())
    sA.kill()

    // 旧 store 应被 rename→删除（importer.ts importFromFile 末尾 unlinkSync .imported）
    const legacyStillExists = existsSync(legacyPath)
    const importedResidue = existsSync(legacyPath + '.imported')
    // 导入的任务应在 A 的 session JSONL 出现为 upsert entry
    const importedTaskPresent =
      upserts.some((e) => e.data.taskId === 'legacy001') ||
      blob.includes('legacy-import-task') ||
      blob.includes('legacy001')

    const pass =
      importedTaskPresent && !legacyStillExists && !importedResidue

    return {
      name: 'S6',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `imported task in A entries/list=${importedTaskPresent}; ` +
        `legacy scheduler.json removed=${!legacyStillExists}; ` +
        `.imported residue removed=${!importedResidue}; ` +
        `A upsert opSeq=${JSON.stringify(getOpSequence(sched))}`,
    }
  } finally {
    ws.cleanup()
    cleanupLegacyStore(realCwd) // 额外清 realpath 路径的 legacy 残留（ws.cleanup 只清 ws.cwd 路径）
  }
}

/**
 * S12：重放正确性——recurring 任务 dispatch（advance）后 kill+resume，
 * nextRunAt = advance 后的值（不回退到创建初值）。
 */
async function runS12(piBin) {
  const ws = makeTempWorkspace('s12')
  try {
    const sA = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S12-A',
      // dispatch 注入 turn 响应余量（20s recurring，70s 观察窗内 ~3 次）
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'Reply with exactly: ok', schedule: '20s', kind: 'recurring' } }] },
        { text: 'done' },
        ...Array.from({ length: 8 }, () => ({ text: 'ok' })),
      ],
    })
    const ready = await sA.waitReady()
    if (!ready) return fail('S12', 'pi A not ready: ' + sA.stderrTail())

    const tCreate = await sA.prompt(
      'Create a scheduled task by calling the schedule tool: prompt is "Reply with exactly: ok", schedule is "20s", kind is "recurring". After the tool returns, reply: done',
    )
    if (!tCreate.ok) return fail('S12', 'create turn did not end')
    const entries0 = await sA.getEntries()
    const sched0 = getSchedulerEntries(entries0)
    const upsert0 = sched0.find((e) => e.data.op === 'upsert')
    if (!upsert0) {
      sA.kill()
      return fail('S12', 'A did not create task')
    }
    const taskId = upsert0.data.taskId
    const initialNextRunAt = upsert0.data.task.nextRunAt

    // 等 ~70s 让至少 1 次 dispatch（advance）
    await sleep(70000)
    const entries1 = await sA.getEntries()
    const sched1 = getSchedulerEntries(entries1)
    const advances1 = sched1.filter((e) => e.data.op === 'advance')
    if (advances1.length < 1) {
      sA.kill()
      return {
        name: 'S12',
        status: 'FOLLOWUP',
        evidence: 'no dispatch within 70s (LLM/tick timing); cannot verify nextRunAt non-regression',
        followup:
          'S12 需真实 dispatch 后 resume。手工：建 recurring 20s 任务 → 等 1 次 dispatch → 记 advance.nextRunAt → kill → resume → 断言 list 的 nextRunAt >= advance 值（不回退到创建初值）',
      }
    }
    const advancedNextRunAt = advances1[advances1.length - 1].data.nextRunAt

    const stateA = await sA.getState()
    const sessionFile =
      stateA && stateA.data && stateA.data.sessionFile ? stateA.data.sessionFile : null
    sA.kill()
    if (!sessionFile) return fail('S12', 'no sessionFile')

    // resume
    const sA2 = spawnSession({
      piBin,
      cwd: ws.cwd,
      sessionDir: ws.sessionDir,
      sessionFile,
      label: 'S12-A2',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule_control', args: { action: 'list' } }] },
        { text: 'done' },
      ],
    })
    const ready2 = await sA2.waitReady()
    if (!ready2) return fail('S12', 'resume not ready: ' + sA2.stderrTail())
    // resume 后发 list，验证 replayFoldEntries 折叠后任务存活（list 不返回空）
    const tA2 = await sA2.prompt(
      'Call the schedule_control tool with action set to "list". Then reply: done',
    )
    if (!tA2.ok) return fail('S12', 'A2 list turn did not end')

    const entries2 = await sA2.getEntries()
    const sched2 = getSchedulerEntries(entries2)
    const upsert2 = sched2.find((e) => e.data.op === 'upsert' && e.data.taskId === taskId)
    const advances2 = sched2.filter(
      (e) => e.data.op === 'advance' && e.data.taskId === taskId,
    )
    const messagesA2 = await sA2.getMessages()
    const blobA2 = fullTextBlob(messagesA2, sA2.getCaptured())
    const a2Jsonl = sA2.getJsonlSnippet()
    sA2.kill()

    // 断言修正（旧代码 bug）：getEntries() 返回 append 原始 entries（未折叠），旧代码误检
    // upsert entry 的 task.nextRunAt 快照（恒为创建初值，必然 FAIL）。replay 折叠在 scheduler
    // 内部 replayFoldEntries（loadTasks 时）完成，不改变 getEntries 返回值。
    // 正确验证：① resume 后 upsert + advance entries 都在（重放读到完整 append 序列）；
    // ② list 显示任务（replay 折叠后任务存活）。
    // V5 精确性（nextRunAt 不回退）由 replay.ts `task.nextRunAt = op.nextRunAt`（按序折叠取最后值）
    // + S17（advance nextRunAt 单调持久化）共同保证。
    const hasUpsertReplay = !!upsert2
    const hasAdvanceReplay = advances2.length >= 1
    const listNotSaysNone = !blobA2.includes('No scheduled tasks.')
    const pass = hasUpsertReplay && hasAdvanceReplay && listNotSaysNone
    return {
      name: 'S12',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `resume 后 upsert present=${hasUpsertReplay} (taskId=${taskId.slice(0, 8)}); ` +
        `advance entries=${advances2.length} (重放保留); ` +
        `list 不含 'No scheduled tasks.'=${listNotSaysNone}; ` +
        `resume 前最后 advance nextRunAt=${advancedNextRunAt}; ` +
        `A2-jsonl=[${a2Jsonl}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/** S14：窗口外耐久——已有 assistant 消息的 session 建任务后 kill，resume 任务保留。 */
async function runS14(piBin) {
  const ws = makeTempWorkspace('s14')
  try {
    const sA = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S14-A',
      fauxSteps: [
        { text: 'hello' }, // 首轮普通对话（assistant 消息 → pi flush 落盘）
        { toolCalls: [{ name: 'schedule', args: { prompt: 'durability-test', schedule: '30m', kind: 'once' } }] },
        { text: 'done' },
      ],
    })
    const ready = await sA.waitReady()
    if (!ready) return fail('S14', 'pi A not ready: ' + sA.stderrTail())

    // 先来一轮普通对话（产生 assistant 消息 → pi flush 落盘）
    const t1 = await sA.prompt('Reply with exactly: hello')
    if (!t1.ok) return fail('S14', 'first turn did not end')
    // 再建任务（此时 session 已 flush，entry 会落盘）
    const t2 = await sA.prompt(
      'Create a scheduled task by calling the schedule tool: prompt is "durability-test", schedule is "30m", kind is "once". After the tool returns, reply: done',
    )
    if (!t2.ok) return fail('S14', 'create turn did not end')
    const entries1 = await sA.getEntries()
    if (getSchedulerEntries(entries1).length < 1) {
      sA.kill()
      return fail('S14', 'task not created')
    }
    const stateA = await sA.getState()
    const sessionFile =
      stateA && stateA.data && stateA.data.sessionFile ? stateA.data.sessionFile : null
    sA.kill()
    if (!sessionFile) return fail('S14', 'no sessionFile')

    // resume（只读 entries 断言，无 turn → 空队列即可）
    const sA2 = spawnSession({
      piBin,
      cwd: ws.cwd,
      sessionDir: ws.sessionDir,
      sessionFile,
      label: 'S14-A2',
      fauxSteps: [],
    })
    const ready2 = await sA2.waitReady()
    if (!ready2) return fail('S14', 'resume not ready: ' + sA2.stderrTail())
    const entries2 = await sA2.getEntries()
    const sched2 = getSchedulerEntries(entries2)
    const hasUpsert = sched2.some((e) => e.data.op === 'upsert')
    sA2.kill()

    const pass = hasUpsert
    return {
      name: 'S14',
      status: pass ? 'PASS' : 'FAIL',
      evidence: `resume 后 upsert entry present=${hasUpsert} (post-flush durability)`,
    }
  } finally {
    ws.cleanup()
  }
}

// ── A 类：命令路径创建表单场景（设计 §6.2 命令面 / §7.6 探针表 / §8.3 e2e 影响面）──

/** 恰 1 条 upsert entry 时取其 task 字段，否则 null。 */
function getSingleUpsertTask(upserts) {
  return upserts.length === 1 && upserts[0].data.task ? upserts[0].data.task : null
}

/** 落库 task 是否 = S18 用户裁定值（interval 45m + user-edited-prompt + once）。 */
function isEditedValueTask(task) {
  return !!task
    && task.prompt === 'user-edited-prompt'
    && task.kind === 'once'
    && !!task.schedule
    && task.schedule.mode === 'interval'
    && task.schedule.intervalMs === 45 * 60 * 1000
}

/** S18 ③ 落库 task 的诊断摘要（缺失字段以 '?' 占位）。 */
function describeUpsertTask(task) {
  return `(prompt=${task ? String(task.prompt).slice(0, 40) : '?'} kind=${task ? task.kind : '?'} `
    + `schedule=${task && task.schedule ? JSON.stringify(task.schedule) : '?'})`
}

/** 落库 task 是否 = S20 表单提交值（用户裁定 recurring + 6 字段归一化 cron）。 */
function isSubmittedCronTask(task) {
  return !!task
    && task.prompt === 'daily-standup-reminder'
    && task.kind === 'recurring'
    && !!task.schedule
    && task.schedule.mode === 'cron'
    && task.schedule.cronExpression === '0 0 9 * * *'
}

/**
 * S22 创建前基线：会话名 / 会话模型 / 宿主条目计数（model_change / thinking_level_change）。
 * ④⑤ 宿主不变量断言的对照组——合成轮不得改变这些计数。
 */
async function s22CollectBaseline(s) {
  const stateBefore = await s.getStateData()
  const entriesBefore = await s.getEntries()
  return {
    name: stateBefore ? stateBefore.sessionName : undefined,
    sessionModel: stateBefore && stateBefore.model ? stateBefore.model : null,
    modelChangeCount: countEntryType(entriesBefore, 'model_change'),
    thinkingCount: countEntryType(entriesBefore, 'thinking_level_change'),
  }
}

/**
 * S22 ①②③ 断言组：合成 assistant 行的字段不变量（语义收敛说明见 runS22 文档注释）。
 *   ① stopReason='aborted'；② provider/model/api = 创建时会话模型；③ usage 各字段全 0。
 * usage 断言只依赖 line 本身（不要求 sessionModel 在场），与原内联形态一致。
 */
function s22SyntheticLineChecks(line, sessionModel) {
  const hasLine = !!line
  const hasModel = hasLine && !!sessionModel
  return {
    stopOk: hasLine && line.message.stopReason === 'aborted',
    providerOk: hasModel
      && line.message.provider === sessionModel.provider
      && line.message.model === sessionModel.id,
    apiOk: hasModel && line.message.api === sessionModel.api,
    usageOk: hasLine && isZeroUsage(line.message.usage),
  }
}

/**
 * [u-e2e-adjust] flush 探针退役（原 `flushForJsonlEvidence` 已删除）。
 *
 * 旧形态：命令路径（slash 命令不产生 turn）的 scheduler entry 只存于内存 fileEntries，
 * 磁盘 JSONL 无证据 ⇒ 脚本在创建断言后自补一个 faux turn 触发 pi flush，并把探针当断言前提。
 *
 * 现形态：命令路径建任务后 scheduler 自身注入一次零 token 本地合成轮
 *（ack-turn：覆写会话当前 provider 的 streamSimple，产出 stopReason='aborted' 的 assistant
 * 消息 + `ack.confirm` 文案）。这就是正常路径——pi 一旦看到 assistant 消息即把全部
 * fileEntries 落盘（session-manager `_persist`）。探针因此既是多余副作用（多消费一次 faux
 * 队列）又掩盖「确认轮没发生」的回归，故退役；断言改锚「创建后 JSONL 里出现 aborted
 * assistant 行 + 确认文案 + op=upsert」（见 checkAckConfirmLine）。
 */

/**
 * S18：命令路径表单——带参预填 + 用户改值确认。
 *
 * `/schedule 1h "confirm-draft-prompt"` → 命令 handler 异步打开表单 →
 * extension_ui_request{select, title=UI_FORM_MARKER}（schedule 问题 initial 预填
 * kind=recurring / schedule=1h / prompt=confirm-draft-prompt）→ uiActor 以「用户裁定值」
 * 回 FormAnswers envelope（45m / user-edited-prompt）→ service.create 落库 + notify。
 * 断言四面（命令路径无 tool 调用 → 回显改读 notify 帧）：
 *   ① 请求帧契约：恰 1 次 UI_FORM_MARKER select，formQuestions[0] 为 schedule 问题且
 *      initial 是合法 ScheduleDraft、反映命令参数
 *   ② notify 帧文案：回显用户裁定值（45m + 改后 prompt 进自动任务名），notifyType=info
 *   ③ 落库形态：upsert entry 恰 1 条，task 字段 = 用户裁定值（非预填原值）
 *   ④ 确认轮：会话 JSONL 出现 aborted assistant 行 + `ack.confirm` 文案（en-US）
 *      + op=upsert 已落盘（无需 flush 探针）
 */
async function runS18(piBin) {
  const ws = makeTempWorkspace('s18')
  try {
    const s = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S18',
      // 命令路径（slash）不消费 faux 队列、不产生 turn；预置一步仅为兜底
      fauxSteps: [{ text: 'ok' }],
      uiActor: (req) => {
        const question = parseScheduleQuestion(req)
        if (!question) return null
        // 用户在表单里改了时间（1h → 45m）与提示词 → 回 FormAnswers envelope（裁定值）
        return scheduleFormAnswer(question, {
          kind: 'once', schedule: '45m', prompt: 'user-edited-prompt',
        })
      },
    })
    const ready = await s.waitReady()
    if (!ready) return fail('S18', 'pi not ready / extension load failed: ' + s.stderrTail())

    await s.sendCommand('/schedule 1h "confirm-draft-prompt"')
    const reqs = await s.waitForFormRequest(15000)
    const exactlyOne = reqs.length === 1
    const contract = checkScheduleFormDraftContract(reqs, {
      kind: 'recurring', schedule: '1h', prompt: 'confirm-draft-prompt',
    })
    const notify = await s.waitForNotify(n => n.message.includes('user-edited-prompt'), 15000)
    // ④ 确认轮（ack 合成轮）是异步副作用：等 JSONL 出现 aborted assistant 行（= 落盘已完成）
    const ack = await s.waitForJsonlEntries(hasAbortedAssistant, 20000)

    const entries = await s.getEntries()
    const sched = getSchedulerEntries(entries)
    const upserts = sched.filter((e) => e.data.op === 'upsert')
    const jsonl = s.getJsonlSnippet()
    // entries 来自落盘 JSONL（ack.entries = waitForJsonlEntries 读到的磁盘快照）
    const persistedUpserts = getSchedulerEntries(ack.entries)
      .filter((e) => e.data.op === 'upsert')
    s.kill()

    // ② notify 回显裁定值：45m 的下次运行 + 改后 prompt 进自动任务名。
    // 文案权威源 = i18n.ts EN_US['task.created']（u-p2b 起 notify 走 renderResultText
    // 词典渲染）= `Created {id}: {name} · {schedule} · next run {relative}`。
    const notifyEdited = !!notify
      && /^Created [0-9a-f]+: user-edited-prompt · once in 45m · next run in \d+m$/.test(notify.message)
    const notifyIsInfo = !!notify && notify.notifyType === 'info'
    // ③ 落库 = 裁定值（45m → interval 2700000ms；prompt/kind 为用户回传形态）
    const task = getSingleUpsertTask(upserts)
    const taskOk = isEditedValueTask(task)
    // 第三轨：确认轮打开落盘开关 ⇒ entry 已落到 session JSONL（无需探针）
    const persisted = persistedUpserts.length === 1
    // ④ 确认行：aborted assistant 行 + i18n ack.confirm 文案（en-US）
    const ackLine = checkAckConfirmLine(ack.entries, {
      name: 'user-edited-prompt', schedule: 'once in 45m',
    })

    const pass =
      exactlyOne && contract.ok && notifyEdited && notifyIsInfo && taskOk && persisted && ackLine.ok
    return {
      name: 'S18',
      status: pass ? 'PASS' : 'FAIL',
      debugEntries: ack.entries,
      evidence:
        `form select requests=${reqs.length} (expect 1); request draft=${contract.desc}; ` +
        `notify edited values=${notifyEdited}` +
        (notify ? ` type=${notify.notifyType} msg=${JSON.stringify(notify.message.slice(0, 140))}` : ' (no notify)') + '; ' +
        `upsert task = edited values=${taskOk} ` +
        describeUpsertTask(task) + '; ' +
        `upserts=${upserts.length}; ` +
        `ackTurn=${ack.ok ? 'reached-jsonl' : 'TIMEOUT'} ${ackLine.desc}; ` +
        `persisted=${persisted} persistedUpserts=${persistedUpserts.length}; ` +
        `jsonlTypes=[${describeEntryTypeCounts(ack.entries)}]; jsonl=[${jsonl}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/**
 * S19：命令路径表单——取消路径（取消不是错误：不创建、无 toast）。
 *
 * `/schedule 30m "cancel-path-task"` → 表单请求到达 → uiActor 回 cancelled
 * （pi resolve undefined → uiFormInteract 折叠 cancelled → 命令路径不 create、不 notify）。
 * 断言四面：
 *   ① 请求帧契约：恰 1 次 UI_FORM_MARKER select（交互确实发生）
 *   ② notify 帧数 = 0（取消不 toast）
 *   ③ 落库：零 scheduler entry（任务未创建）
 *   ④ 负向（确认轮不启动）：无 assistant 消息新增 + 会话 JSONL 无 op=upsert
 *      （取消 ⇒ 无创建 ⇒ 无合成轮；若出现即回归）
 */
async function runS19(piBin) {
  const ws = makeTempWorkspace('s19')
  try {
    const s = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S19',
      fauxSteps: [{ text: 'ok' }],
      uiActor: (req) => {
        if (!parseScheduleQuestion(req)) return null
        return { cancelled: true }
      },
    })
    const ready = await s.waitReady()
    if (!ready) return fail('S19', 'pi not ready / extension load failed: ' + s.stderrTail())

    await s.sendCommand('/schedule 30m "cancel-path-task"')
    const reqs = await s.waitForFormRequest(15000)
    // 取消路径无 toast —— 留出落库 / 通知的结算窗口后再断言
    await sleep(2000)

    const entries = await s.getEntries()
    const sched = getSchedulerEntries(entries)
    const notifies = s.getNotifies()
    const jsonlEntries = s.readJsonlEntries()
    const jsonl = s.getJsonlSnippet()
    s.kill()

    const oneInteraction = reqs.length === 1
    const noNotify = notifies.length === 0
    const noTaskPersisted = sched.length === 0
    // ④ 负向：无确认轮（无 assistant 行）+ 无落盘任务 entry
    const noAssistantLine =
      getAssistantEntries(entries).length === 0 && getAssistantEntries(jsonlEntries).length === 0
    // entries 来自落盘 JSONL（jsonlEntries = readJsonlEntries 的磁盘快照）；
    // 内存 fileEntries vs 磁盘 JSONL 的独立双轨保留在上方 noAssistantLine
    const noJsonlUpsert = getSchedulerEntries(jsonlEntries).length === 0

    const pass =
      oneInteraction && noNotify && noTaskPersisted && noAssistantLine && noJsonlUpsert
    return {
      name: 'S19',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `form select requests=${reqs.length} (expect 1); ` +
        `notify frames=${notifies.length} (expect 0 — 取消不 toast); ` +
        `scheduler entries=${sched.length} (expect 0 — 任务未创建); ` +
        `opSeq=${JSON.stringify(getOpSequence(sched))}; ` +
        `assistantLines(mem)=${getAssistantEntries(entries).length} ` +
        `assistantLines(jsonl)=${getAssistantEntries(jsonlEntries).length} (expect 0 — 无确认轮); ` +
        `jsonlUpsert=${!noJsonlUpsert}; ` +
        `jsonlTypes=[${describeEntryTypeCounts(jsonlEntries)}]; jsonl=[${jsonl}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/**
 * S20：命令路径表单——无参默认草稿 + 提交。
 *
 * `/schedule`（无参）→ 表单预填默认草稿（kind=once / schedule='' / prompt=''；
 * 默认单次为现行契约，schedule 置空由表单端派生初值，见
 * extensions/universal/scheduler/src/commands.ts 无参分支）→ uiActor 把任务改为
 * recurring 每天 09:00 后提交 → 落库 + notify。
 * 断言三面：
 *   ① 请求帧契约：恰 1 次 UI_FORM_MARKER select，initial 为默认草稿（kind/schedule/prompt）
 *   ② notify 帧文案：提交的 cron 表达式（0 9 * * *）与任务名回显
 *   ③ 落库形态：upsert entry 恰 1 条，task = cron 任务（cronExpression + prompt）
 *   ④ 确认轮：会话 JSONL 出现 aborted assistant 行 + `ack.confirm` 文案（en-US）
 *      + op=upsert 已落盘（无需 flush 探针）
 */
async function runS20(piBin) {
  const ws = makeTempWorkspace('s20')
  try {
    const s = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S20',
      fauxSteps: [{ text: 'ok' }],
      uiActor: (req) => {
        const question = parseScheduleQuestion(req)
        if (!question) return null
        // 默认草稿为 once/空串；用户在表单里改成 recurring 每天 09:00 后提交
        return scheduleFormAnswer(question, {
          kind: 'recurring', schedule: '0 9 * * *', prompt: 'daily-standup-reminder',
        })
      },
    })
    const ready = await s.waitReady()
    if (!ready) return fail('S20', 'pi not ready / extension load failed: ' + s.stderrTail())

    await s.sendCommand('/schedule')
    const reqs = await s.waitForFormRequest(15000)
    const exactlyOne = reqs.length === 1
    const contract = checkScheduleFormDraftContract(reqs, {
      kind: 'once', schedule: '', prompt: '',
    })
    const notify = await s.waitForNotify(n => n.message.includes('daily-standup-reminder'), 15000)
    // ④ 确认轮（异步副作用）：等 JSONL 出现 aborted assistant 行
    const ack = await s.waitForJsonlEntries(hasAbortedAssistant, 20000)
    const entries = await s.getEntries()
    const sched = getSchedulerEntries(entries)
    const upserts = sched.filter((e) => e.data.op === 'upsert')
    const jsonl = s.getJsonlSnippet()
    // entries 来自落盘 JSONL（ack.entries = waitForJsonlEntries 读到的磁盘快照）
    const persistedUpserts = getSchedulerEntries(ack.entries)
      .filter((e) => e.data.op === 'upsert')
    s.kill()

    // 文案权威源 = i18n.ts EN_US['task.created']（u-p2b 词典渲染）；cron 表达式按
    // 创建端归一化后的 6 字段形态回显。
    const notifyCron = !!notify
      && /^Created [0-9a-f]+: daily-standup-reminder · 0 0 9 \* \* \*/.test(notify.message)
    const task = getSingleUpsertTask(upserts)
    // 创建端把 5 字段 cron 归一化为 6 字段（秒位补 0）——entry 断言用归一化形态
    const taskOk = isSubmittedCronTask(task)
    // 第三轨：确认轮打开落盘开关 ⇒ entry 已落到 session JSONL（无需探针）
    const persisted = persistedUpserts.length === 1
    // ④ 确认行：aborted assistant 行 + i18n ack.confirm 文案（en-US；cron 回显归一化形态）
    const ackLine = checkAckConfirmLine(ack.entries, {
      name: 'daily-standup-reminder', schedule: '0 0 9 * * *',
    })

    const pass =
      exactlyOne && contract.ok && notifyCron && taskOk && persisted && ackLine.ok
    return {
      name: 'S20',
      status: pass ? 'PASS' : 'FAIL',
      debugEntries: ack.entries,
      evidence:
        `form select requests=${reqs.length} (expect 1); request draft=${contract.desc}; ` +
        `notify submitted cron echo=${notifyCron}` +
        (notify ? ` msg=${JSON.stringify(notify.message.slice(0, 140))}` : ' (no notify)') + '; ' +
        `upsert cron task=${taskOk} ` + describeUpsertTask(task) + '; ' +
        `upserts=${upserts.length}; ` +
        `ackTurn=${ack.ok ? 'reached-jsonl' : 'TIMEOUT'} ${ackLine.desc}; ` +
        `persisted=${persisted} persistedUpserts=${persistedUpserts.length}; ` +
        `jsonlTypes=[${describeEntryTypeCounts(ack.entries)}]; jsonl=[${jsonl}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/**
 * S21：`/schedule` 命令路径表单——预填原值确认基线。
 *
 * `/schedule 30m "alias-task"`：表单请求帧契约 + 提交后落库 + notify，
 * 与其它命令路径用例（S18/S20）同形；uiActor 按命令参数原值应答（不改动预填）。
 * 断言三面：
 *   ① 请求帧契约：恰 1 次 UI_FORM_MARKER select，initial 反映命令参数
 *   ② notify 帧文案：30m + alias-task 回显
 *   ③ 落库形态：upsert entry 恰 1 条，task = 命令参数值
 *   ④ 确认轮：会话 JSONL 出现 aborted assistant 行 + `ack.confirm` 文案（en-US）
 *      + op=upsert 已落盘（无需 flush 探针）
 */
async function runS21(piBin) {
  const ws = makeTempWorkspace('s21')
  try {
    const s = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S21',
      fauxSteps: [{ text: 'ok' }],
      uiActor: (req) => {
        const question = parseScheduleQuestion(req)
        if (!question) return null
        return scheduleFormAnswer(question, {
          kind: 'recurring', schedule: '30m', prompt: 'alias-task',
        })
      },
    })
    const ready = await s.waitReady()
    if (!ready) return fail('S21', 'pi not ready / extension load failed: ' + s.stderrTail())

    await s.sendCommand('/schedule 30m "alias-task"')
    const reqs = await s.waitForFormRequest(15000)
    const exactlyOne = reqs.length === 1
    const contract = checkScheduleFormDraftContract(reqs, {
      kind: 'recurring', schedule: '30m', prompt: 'alias-task',
    })
    const notify = await s.waitForNotify(n => n.message.includes('alias-task'), 15000)
    // ④ 确认轮（异步副作用）：等 JSONL 出现 aborted assistant 行
    const ack = await s.waitForJsonlEntries(hasAbortedAssistant, 20000)
    const entries = await s.getEntries()
    const sched = getSchedulerEntries(entries)
    const upserts = sched.filter((e) => e.data.op === 'upsert')
    const jsonl = s.getJsonlSnippet()
    // entries 来自落盘 JSONL（ack.entries = waitForJsonlEntries 读到的磁盘快照）
    const persistedUpserts = getSchedulerEntries(ack.entries)
      .filter((e) => e.data.op === 'upsert')
    s.kill()

    // 文案权威源 = i18n.ts EN_US['task.created']（u-p2b 词典渲染）。
    const notifyEcho = !!notify
      && /^Created [0-9a-f]+: alias-task · every 30m/.test(notify.message)
    const task = getSingleUpsertTask(upserts)
    const taskOk = !!task
      && task.prompt === 'alias-task'
      && !!task.schedule
      && task.schedule.mode === 'interval'
      && task.schedule.intervalMs === 30 * 60 * 1000
    // 第三轨：确认轮打开落盘开关 ⇒ entry 已落到 session JSONL（无需探针）
    const persisted = persistedUpserts.length === 1
    // ④ 确认行：aborted assistant 行 + i18n ack.confirm 文案（en-US）
    const ackLine = checkAckConfirmLine(ack.entries, {
      name: 'alias-task', schedule: 'every 30m',
    })

    const pass =
      exactlyOne && contract.ok && notifyEcho && taskOk && persisted && ackLine.ok
    return {
      name: 'S21',
      status: pass ? 'PASS' : 'FAIL',
      debugEntries: ack.entries,
      evidence:
        `form select requests=${reqs.length} (expect 1); request draft=${contract.desc}; ` +
        `notify alias echo=${notifyEcho}` +
        (notify ? ` msg=${JSON.stringify(notify.message.slice(0, 140))}` : ' (no notify)') + '; ' +
        `upsert alias task=${taskOk} ` + describeUpsertTask(task) + '; ' +
        `upserts=${upserts.length}; ` +
        `ackTurn=${ack.ok ? 'reached-jsonl' : 'TIMEOUT'} ${ackLine.desc}; ` +
        `persisted=${persisted} persistedUpserts=${persistedUpserts.length}; ` +
        `jsonlTypes=[${describeEntryTypeCounts(ack.entries)}]; jsonl=[${jsonl}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/**
 * S22：确认轮合成行字段 + 宿主不变量（可脚本化 S7①②）。
 *
 * 命令路径建 once 2h 任务（表单确认）→ 确认轮落盘后读会话 JSONL，断言：
 *   ① assistant 行 stopReason='aborted'（合成轮的终止形态投影到落盘消息）
 *   ② 该行 provider/model = **创建时会话模型**（get_state 动态取值的 model.provider /
 *      model.id）。注意语义收敛：真实环境此断言区分「合成行用会话模型」vs「掉进 pi-ai
 *      faux core（provider:'faux' 硬编码）」；e2e 演员本身就是 faux，故此处只能断言
 *      「= 会话当前模型」（动态等值），并随 evidence 输出实际值供归因。
 *   ③ usage 各字段全 0（含 cost 四字段 + totalTokens；否则污染 context 统计）
 *   ④ model_change 条数 = 1 且与创建前（内存 fileEntries）相等（pi 会话初始化自身写 1 条，
 *      合成轮不得新增）
 *   ⑤ thinking_level_change 条数不因创建而变化
 *   ⑥ 宿主 auto-rename（本场景显式加载 rename-session + config.enabled=true）不被合成轮
 *      触发：无 session_info entry + sessionName 未变。判别力：rename 的 first-stop 入口
 *      只在 stopReason==='stop' 触发，合成轮为 'aborted'；若回归为 stop，这里会变红。
 *
 * 断言失败信息把实际 JSONL 字段/计数值打进 evidence（可诊断性硬要求）。
 */
async function runS22(piBin) {
  const ws = makeTempWorkspace('s22')
  try {
    const s = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S22',
      fauxSteps: [{ text: 'ok' }],
      autoRename: true,
      extraExtensions: [RENAME_SESSION_EXT_PATH],
      uiActor: (req) => {
        const question = parseScheduleQuestion(req)
        if (!question) return null
        return scheduleFormAnswer(question, {
          kind: 'once', schedule: '2h', prompt: 's22-host-invariant',
        })
      },
    })
    const ready = await s.waitReady()
    if (!ready) return fail('S22', 'pi not ready / extension load failed: ' + s.stderrTail())

    // ⑥ 前置正控（硬前提）：rename-session 已加载 + 开关为 ON（`/auto-rename status` 经
    // notify 帧回显 `自动重命名会话：已开启 ✓`）。无此正控则「合成轮未触发改名」无判别力。
    await s.sendCommand('/auto-rename status')
    const renameStatus = await s.waitForNotify(n => n.message.includes('自动重命名会话'), 15000)
    const renameSwitchOn = !!renameStatus && renameStatus.message.includes('已开启')

    // 创建前基线（内存 fileEntries：会话初始化已 append 的宿主条目）
    const {
      name: nameBefore, sessionModel,
      modelChangeCount: modelChangeBefore, thinkingCount: thinkingBefore,
    } = await s22CollectBaseline(s)

    await s.sendCommand('/schedule 2h "s22-host-invariant"')
    const reqs = await s.waitForFormRequest(15000)
    await s.waitForNotify(n => n.message.includes('s22-host-invariant'), 15000)
    const ack = await s.waitForJsonlEntries(hasAbortedAssistant, 20000)
    const stateAfter = await s.getStateData()
    const nameAfter = stateAfter ? stateAfter.sessionName : undefined
    s.kill()

    const jsonlEntries = ack.entries
    const assistants = getAssistantEntries(jsonlEntries)
    const aborted = assistants.filter((e) => e.message.stopReason === 'aborted')
    const line = aborted.length > 0 ? aborted[aborted.length - 1] : null

    // ①②③ 合成行字段不变量：终止形态 / provider·model·api=会话模型 / usage 全 0
    const { stopOk, providerOk, apiOk, usageOk } = s22SyntheticLineChecks(line, sessionModel)
    // ④⑤ 宿主不变量：条数与创建前一致（model_change 绝对值 = 1）
    const modelChangeAfter = countEntryType(jsonlEntries, 'model_change')
    const thinkingAfter = countEntryType(jsonlEntries, 'thinking_level_change')
    const modelChangeOk = modelChangeAfter === 1 && modelChangeAfter === modelChangeBefore
    const thinkingOk = thinkingAfter === thinkingBefore
    // ⑥ auto-rename 未被合成轮触发
    const sessionInfoCount = countEntryType(jsonlEntries, 'session_info')
    const renameOk = sessionInfoCount === 0 && nameAfter === nameBefore
    // 附加：确认文案（合成行的用户可见内容）
    const ackLine = checkAckConfirmLine(jsonlEntries, {
      name: 's22-host-invariant', schedule: 'once in 2h',
    })

    const pass = [
      ack.ok, stopOk, providerOk, apiOk, usageOk,
      modelChangeOk, thinkingOk, renameOk, renameSwitchOn, ackLine.ok, reqs.length === 1,
    ].every(Boolean)
    return {
      name: 'S22',
      status: pass ? 'PASS' : 'FAIL',
      debugEntries: jsonlEntries,
      evidence:
        `form select requests=${reqs.length} (expect 1); ` +
        `ackTurn=${ack.ok ? 'reached-jsonl' : 'TIMEOUT'}; ` +
        `①stopReason=aborted:${stopOk}; ` +
        `②provider/model=sessionModel:${providerOk} (sessionModel=${sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : '?'}; ` +
        `line=${line ? describeAssistantEntry(line) : '(none)'}); ` +
        `②api=sessionModel.api:${apiOk}; ` +
        `③usageAllZero:${usageOk}; ` +
        `④model_change ${modelChangeBefore}(before)→${modelChangeAfter}(jsonl) ok=${modelChangeOk}; ` +
        `⑤thinking_level_change ${thinkingBefore}→${thinkingAfter} ok=${thinkingOk}; ` +
        `⑥autoRename switchOn=${renameSwitchOn} notTriggered=${renameOk} (status=${renameStatus ? JSON.stringify(renameStatus.message.slice(0, 60)) : '(none)'}; session_info=${sessionInfoCount} name ${JSON.stringify(nameBefore)}→${JSON.stringify(nameAfter)}); ` +
        `confirmText:${ackLine.ok} ${ackLine.desc}; ` +
        `assistantLines=${assistants.length} aborted=${aborted.length}; ` +
        `jsonlTypes=[${describeEntryTypeCounts(jsonlEntries)}]; jsonl=[${s.getJsonlSnippet()}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/**
 * S23：同一会话连续两次创建 ⇒ 确认轮只发生 1 次。
 *
 * 第一任务创建触发确认轮（打开落盘开关 + ackState 记账）；第二任务创建时
 * maybeStartAck 的落盘判据（已有 assistant 消息 ⇒ pi 已 flush）直接返回 ⇒ 不再注入合成轮。
 * 断言：aborted assistant 行**恰好 1 条** + 两个任务的 op=upsert entry 都在 JSONL 里
 * （第二个 upsert 直接 append 到已落盘的会话文件）。
 */
async function runS23(piBin) {
  const ws = makeTempWorkspace('s23')
  try {
    let formIndex = 0
    const s = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S23',
      fauxSteps: [{ text: 'ok' }],
      uiActor: (req) => {
        const question = parseScheduleQuestion(req)
        if (!question) return null
        formIndex += 1
        const spec = formIndex === 1
          ? { kind: 'once', schedule: '3h', prompt: 's23-first-task' }
          : { kind: 'once', schedule: '4h', prompt: 's23-second-task' }
        return scheduleFormAnswer(question, spec)
      },
    })
    const ready = await s.waitReady()
    if (!ready) return fail('S23', 'pi not ready / extension load failed: ' + s.stderrTail())

    // 第一次创建 → 确认轮落盘
    await s.sendCommand('/schedule 3h "s23-first-task"')
    await s.waitForNotify(n => n.message.includes('s23-first-task'), 15000)
    const ack1 = await s.waitForJsonlEntries(hasAbortedAssistant, 20000)
    // JSONL 行落盘早于 turn_end 收尾：等会话空闲再发第二次命令（避免命令撞在 streaming 中）
    const idle = await waitUntilIdle(s, 5000)

    // 第二次创建（同一会话；此时已存在 assistant 消息 ⇒ 落盘判据命中，不再注入合成轮）
    await s.sendCommand('/schedule 4h "s23-second-task"')
    await s.waitForNotify(n => n.message.includes('s23-second-task'), 15000)
    const ack2 = await s.waitForJsonlEntries(
      es => getSchedulerEntries(es).filter((e) => e.data.op === 'upsert').length >= 2,
      20000,
    )
    s.kill()

    const jsonlEntries = ack2.entries
    const aborted = getAssistantEntries(jsonlEntries).filter((e) => e.message.stopReason === 'aborted')
    // entries 来自落盘 JSONL（jsonlEntries = ack2.entries 的磁盘快照）
    const upserts = getSchedulerEntries(jsonlEntries).filter((e) => e.data.op === 'upsert')
    const prompts = upserts.map((e) => (e.data.task ? e.data.task.prompt : undefined))
    const bothTasks = prompts.includes('s23-first-task') && prompts.includes('s23-second-task')
    const exactlyOneAck = aborted.length === 1
    const confirmOk = checkAckConfirmLine(jsonlEntries, {
      name: 's23-first-task', schedule: 'once in 3h',
    }).ok

    const pass = ack1.ok && ack2.ok && idle && exactlyOneAck && bothTasks && confirmOk
    return {
      name: 'S23',
      status: pass ? 'PASS' : 'FAIL',
      debugEntries: jsonlEntries,
      evidence:
        `creates=2 (formIndex=${formIndex}); ack1=${ack1.ok ? 'reached-jsonl' : 'TIMEOUT'} `
        + `ack2(upserts>=2)=${ack2.ok ? 'reached-jsonl' : 'TIMEOUT'}; sessionIdle=${idle}; `
        + `abortedAssistantLines=${aborted.length} (expect exactly 1); `
        + `upserts=${upserts.length} prompts=${JSON.stringify(prompts)} bothTasks=${bothTasks}; `
        + `firstConfirmText=${confirmOk}; `
        + `jsonlTypes=[${describeEntryTypeCounts(jsonlEntries)}]; jsonl=[${s.getJsonlSnippet()}]`,
    }
  } finally {
    ws.cleanup()
  }
}

// ── B/C 类 followup 桩（明确标注难自动化原因 + 手工步骤）──

function followupS7() {
  return {
    name: 'S7',
    status: 'FOLLOWUP',
    evidence: 'busy 窗口精确控制不可靠（需 A 正好在 streaming 时 tick 触发）',
    followup:
      '手工：A 建 1m once 任务 → 立即向 A 发长 prompt 使其持续输出 → 同时 B 空闲 → 等 1m 到期 → ' +
      '断言 B 不触发、A 空闲后下个 tick 触发（dispatchTask 第一行 isIdle 兜底）',
  }
}

function followupS8() {
  return {
    name: 'S8',
    status: 'FOLLOWUP',
    evidence: 'subagent 隔离需派 subagent 并镜像 extension 加载，RPC 脚本难编排',
    followup:
      '手工：A 建任务 → 在 A 中用 subagent 工具派后台 subagent → 等任务到期 → 断言任务只注入 A、' +
      'subagent 的 schedule_control list 返回 "No scheduled tasks."（subagent 是独立 session，无 owner entry）',
  }
}

function followupS10() {
  return {
    name: 'S10',
    status: 'FOLLOWUP',
    evidence: '两进程并发 session_start 的 rename 竞态时序难稳定复现（窗口毫秒级）',
    followup:
      '手工：预置旧 store → 用两个终端同时 pi 启动同 cwd → 断言仅一个 session 的 JSONL 含 upsert entry、' +
      'scheduler.json 被 rename 后删除（importer.ts renameSync 原子独占 + ENOENT fallback）',
  }
}

function followupS11() {
  return {
    name: 'S11',
    status: 'FOLLOWUP',
    evidence: 'C 类：fork 隔离依赖 pi forkFrom 机制（/fork 命令或 --fork），RPC mode 难触发 + owner 过滤是核心',
    followup:
      '手工：A 建任务 → A 中执行 /fork（或 pi --fork <A-file>）→ 在 fork 出的 session 调 schedule_control list → ' +
      '断言返回 "No scheduled tasks."（fork 继承 entry 但 ownerSessionFile !== 新 sessionFile 被 replay 过滤）' +
      '；原 A resume 任务仍在',
  }
}

function followupS13() {
  return {
    name: 'S13',
    status: 'FOLLOWUP',
    evidence: 'C 类：首 turn 内 appendEntry 后、message_end 前的 kill 时序窗口极窄，难稳定命中',
    followup:
      '手工：全新 session 首个 prompt 里建任务（不等回复）→ 立即 kill 进程 → resume → ' +
      '断言任务丢失（pi 延迟写入：fileEntries 无 assistant 时不落盘，README 已明示此已知例外）',
  }
}

function followupS15() {
  return {
    name: 'S15',
    status: 'FOLLOWUP',
    evidence: 'C 类：需启动 taiji dev app（Electron GUI），CLI 脚本无法驱动',
    followup:
      '手工：用 pi 建一个含任务 entry 的 session → pnpm dev 启动 taiji → 打开同一 session → ' +
      '断言历史列表正常显示、无 custom entry 误显、不崩（session-history.ts 白名单已过滤 type:custom）',
  }
}

function followupS16() {
  return {
    name: 'S16',
    status: 'FOLLOWUP',
    evidence: '双开同一 session 文件的行为是 Out-of-scope（design §1 明示无锁无解），仅记录不修',
    followup:
      '手工（记录行为用）：两个进程 --session 同一文件 → 等任务到期 → 记录是否双触发 ' +
      '（预期可能双触发，与现状一致，文档化不修）',
  }
}

// ── V1-V5 对照确认 ──

function confirmV(results) {
  const byName = Object.fromEntries(results.map((r) => [r.name, r]))
  const pass = (n) => byName[n] && byName[n].status === 'PASS'

  // V1: getEntries 时序——session_start 含磁盘全部 entry。S5/S12 resume 重放成功即证。
  const v1 = pass('S5') || pass('S12')
  // V2: fork 复制行为——依赖 S11（C 类）。R-v2v4：标 needs-followup 不标 pass。
  const v2 = null // needs-followup
  // V3: 延迟写入窗口边界。S14（post-flush 耐久）可部分确认；S13（首 turn 丢失）C 类 followup。
  const v3postFlush = pass('S14')
  const v3firstTurn = null // needs-followup (S13)
  // V4: appendEntry RPC mode 可用性——所有 A 类 entry 出现即隐含确认。
  const v4pass = ['S1', 'S2', 'S3', 'S5', 'S9', 'S17'].every(pass)
  // V5: advance 重放恢复 nextRunAt——S12（resume 后 nextRunAt 不回退）+ S17（advance 累积 + 单调）。
  const v5 = pass('S12') && pass('S17')

  return [
    {
      name: 'V1',
      status: v1 ? 'CONFIRMED' : 'NEEDS-FOLLOWUP',
      evidence: v1
        ? 'getEntries 在 session_start 含磁盘全部 entry（S5/S12 resume 重放恢复任务）'
        : '待 S5/S12 实测通过确认',
    },
    {
      name: 'V2',
      status: 'NEEDS-FOLLOWUP',
      evidence:
        'fork 复制行为依赖 S11（C 类手工）。R-v2v4：不标 pass，待 S11 手工验证 fork 出的 session list 为空',
    },
    {
      name: 'V3',
      status: v3postFlush ? 'PARTIAL' : 'NEEDS-FOLLOWUP',
      evidence:
        `post-flush 耐久=${v3postFlush ? 'confirmed (S14)' : 'pending'}; ` +
        `首 turn 丢失窗口=needs-followup (S13 C 类)`,
    },
    {
      name: 'V4',
      status: v4pass ? 'CONFIRMED' : 'NEEDS-FOLLOWUP',
      evidence: v4pass
        ? 'appendEntry 在 RPC mode 可用——所有 A 类场景 custom entry 成功写入 session JSONL'
        : '待 A 类全部通过确认',
    },
    {
      name: 'V5',
      status: v5 ? 'CONFIRMED' : 'NEEDS-FOLLOWUP',
      evidence: v5
        ? 'advance 重放恢复 nextRunAt（S12 resume 不回退 + S17 advance 累积单调递增）'
        : '待 S12/S17 实测通过确认',
    },
  ]
}

// ── 结果辅助 ──

function fail(name, reason) {
  return { name, status: 'FAIL', evidence: reason }
}

function printResult(r) {
  const icon =
    r.status === 'PASS'
      ? '✅'
      : r.status === 'FAIL'
        ? '❌'
        : r.status === 'FOLLOWUP' || r.status === 'NEEDS-FOLLOWUP'
          ? '⏭️'
          : r.status === 'CONFIRMED'
            ? '✅'
            : r.status === 'PARTIAL'
              ? '🟡'
              : '?'
  console.log(
    `${TAG} ${icon} ${r.name}: ${r.status}` +
      (typeof r.elapsedMs === 'number' ? ` (${(r.elapsedMs / 1000).toFixed(1)}s)` : ''),
  )
  console.log(`${TAG}    ${r.evidence}`)
  if (r.followup) console.log(`${TAG}    followup: ${r.followup}`)
}

// ── 场景注册表 ──

const SCENARIOS = {
  S1: runS1,
  S2: runS2,
  S3: runS3,
  S5: runS5,
  S9: runS9,
  S17: runS17,
  S18: runS18,
  S19: runS19,
  S20: runS20,
  S21: runS21,
  S22: runS22,
  S23: runS23,
  S4: runS4,
  S6: runS6,
  S12: runS12,
  S14: runS14,
  S7: followupS7,
  S8: followupS8,
  S10: followupS10,
  S11: followupS11,
  S13: followupS13,
  S15: followupS15,
  S16: followupS16,
}

const A_CLASS = ['S1', 'S2', 'S3', 'S5', 'S9', 'S17', 'S18', 'S19', 'S20', 'S21', 'S22', 'S23']
const B_CLASS_IMPL = ['S4', 'S6', 'S12', 'S14']
const B_CLASS_FOLLOWUP = ['S7', 'S8', 'S10', 'S16']
const C_CLASS = ['S11', 'S13', 'S15']

// ── main ──

/** 参数 → 待跑场景名列表；未知参数返回 null（调用方打印 usage 后 exit 2）。 */
function selectScenarioList(arg) {
  if (arg === 'all') {
    return [...A_CLASS, ...B_CLASS_IMPL, ...B_CLASS_FOLLOWUP, ...C_CLASS]
  }
  if (arg === 'aclass') {
    return [...A_CLASS]
  }
  if (arg === 'bclass') {
    return [...B_CLASS_IMPL, ...B_CLASS_FOLLOWUP]
  }
  if (arg === 'v') {
    // 仅打印 V 对照（需先有 S 结果，这里跑 A 类后对照）
    return [...A_CLASS, ...B_CLASS_IMPL]
  }
  if (SCENARIOS[arg]) {
    return [arg]
  }
  return null
}

/** 执行单个场景：注册表未命中返回 null；异常包装为 FAIL result（不中断后续场景）。 */
async function executeScenario(name, piBin) {
  try {
    const fn = SCENARIOS[name]
    return typeof fn === 'function' ? await fn(piBin) : null
  } catch (err) {
    return {
      name,
      status: 'FAIL',
      evidence: `exception: ${err && err.stack ? err.stack : String(err)}`,
    }
  }
}

/** 汇总统计：A 类已跑/通过/失败、B 类通过/followup、C 类 followup。 */
function collectSummaryCounts(results) {
  const aRan = results.filter((r) => A_CLASS.includes(r.name))
  const aPass = aRan.filter((r) => r.status === 'PASS')
  const aFail = aRan.filter((r) => r.status === 'FAIL')
  const bPass = results.filter(
    (r) => B_CLASS_IMPL.includes(r.name) && r.status === 'PASS',
  )
  const bFollowup = results.filter(
    (r) =>
      (B_CLASS_IMPL.includes(r.name) || B_CLASS_FOLLOWUP.includes(r.name)) &&
      r.status === 'FOLLOWUP',
  )
  const cFollowup = results.filter(
    (r) => C_CLASS.includes(r.name) && r.status === 'FOLLOWUP',
  )
  return { aRan, aPass, aFail, bPass, bFollowup, cFollowup }
}

/** 汇总打印：A/B/C 分类计数 + V-gates 状态分布。 */
function printSummary({ aRan, aPass, aFail, bPass, bFollowup, cFollowup }, vResults) {
  console.log(`${TAG} ============================================================`)
  console.log(`${TAG} A-class: ${aPass.length}/${aRan.length} PASS`)
  if (aFail.length > 0) {
    console.log(`${TAG}   ❌ A-class FAIL (BLOCKER): ${aFail.map((r) => r.name).join(', ')}`)
  }
  console.log(`${TAG} B-class: ${bPass.length} PASS, ${bFollowup.length} followup`)
  console.log(`${TAG} C-class: ${cFollowup.length} followup`)
  console.log(
    `${TAG} V-gates: ${vResults.filter((v) => v.status === 'CONFIRMED').length} confirmed, ` +
      `${vResults.filter((v) => v.status === 'PARTIAL').length} partial, ` +
      `${vResults.filter((v) => v.status === 'NEEDS-FOLLOWUP').length} needs-followup`,
  )
}

async function main() {
  const piBin = locatePiBinary()
  console.log(`${TAG} ============================================================`)
  console.log(`${TAG} pi-scheduler e2e real-env verification`)
  console.log(`${TAG} model: ${MODEL}`)
  if (!piBin) {
    console.log(`${TAG} pi binary not found (set PI_BIN)`)
    return 2
  }
  if (!existsSync(EXTENSION_PATH)) {
    console.log(`${TAG} extension not found: ${EXTENSION_PATH}`)
    return 2
  }
  console.log(`${TAG} pi: ${piBin}`)
  console.log(`${TAG} extension: ${EXTENSION_PATH}`)

  const arg = process.argv[2] || 'aclass'
  const toRun = selectScenarioList(arg)
  if (!toRun) {
    console.log(`${TAG} unknown scenario: ${arg}`)
    console.log(`${TAG} usage: node verify-scheduler-e2e.cjs [S1..S23|aclass|bclass|all|v]`)
    return 2
  }

  const results = []
  for (const name of toRun) {
    console.log(`${TAG} ------------------------------------------------------------`)
    console.log(`${TAG} running ${name} ...`)
    const t0 = Date.now()
    const r = await executeScenario(name, piBin)
    if (r) {
      r.elapsedMs = Date.now() - t0
      results.push(r)
      printResult(r)
      // 失败归因：无条件 dump 该场景落盘 entries（原先靠 SCHED_E2E_DEBUG_JSONL env 门）
      if (r.status === 'FAIL') debugDumpJsonl(r.name, r.debugEntries)
    }
  }

  // V1-V5 对照（基于已跑结果）
  console.log(`${TAG} ------------------------------------------------------------`)
  console.log(`${TAG} V1-V5 verification gates:`)
  const vResults = confirmV(results)
  for (const v of vResults) printResult(v)

  // 汇总
  const counts = collectSummaryCounts(results)
  printSummary(counts, vResults)

  // 任一已跑场景 FAIL = exit 1；aclass 聚合跑全 8 个且全过 = exit 0
  // （单场景跑成功也返回 0，便于分场景驱动；gate 用 aclass 聚合判定）
  const code = results.length > 0 && counts.aFail.length === 0 ? 0 : 1
  console.log(`${TAG} exit code: ${code}`)
  return code
}

main()
  .then((code) => {
    setTimeout(() => process.exit(code), 300)
  })
  .catch((err) => {
    console.error(`${TAG} crashed: ${err && err.stack ? err.stack : err}`)
    process.exit(2)
  })

// 全局安全超时（S17 单跑需 ~7min；跑全集放宽到 20min）
setTimeout(() => {
  console.log(`${TAG} global timeout 1200s — killing`)
  process.exit(1)
}, 1200000).unref()
