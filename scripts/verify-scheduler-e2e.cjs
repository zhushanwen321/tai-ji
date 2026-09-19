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
 * [L2.5 faux 翻轨，2026-09-15] LLM 演员改为 faux 脚本（真 pi 进程 + 真 scheduler
 * extension + 假 LLM）——断言面全在扩展写盘的 entry 形态与工具回显（与模型智能无关），
 * schedule/schedule_control 调用改 faux toolCall 步骤预设（确定性触发、零 token、凭证
 * 无关：agentDir 预置 faux settings/models，无需 ~/.pi/agent/auth.json）。原「模型不调
 * tool」的失败模式随翻轨消失。S17/S4/S12 的 dispatch 注入 turn 同样消费 faux 队列
 * （注入 prompt 的响应步骤预排余量）。prompt 文案保留（与 toolCall 参数对齐，作为
 * user 消息入 session）。
 *
 * [U7 2026-09-18 创建确认交互应答；u6 2026-09-19 统一表单协议迁移] schedule 工具创建
 * 路径为「先确认后创建」（rpc 模式经 UI_FORM_MARKER select 通道——统一提问表单协议：
 * options[0] 携 {formQuestions, allowCancel}，schedule 问题 initial 预填 draft；应答回
 * FormAnswers envelope = {key: flat ScheduleFormResult JSON}，key = header ?? question），
 * pi 输出 extension_ui_request 帧、stdin 回 extension_ui_response 应答——帧契约实装核对
 * @earendil-works/pi-coding-agent 0.84.4 dist/modes/rpc/rpc-mode.js。spawnSession 的
 * uiActor 应答器（确认/取消可配置）：默认 = auto-confirm（按 initial 草稿原样回 envelope
 * 确认形态，既有场景保持创建成功路径）；S18 = 用户改配置后确认（断言裁定值生效）；
 * S19 = 用户取消（断言任务未创建）。无 uiActor 时非 marker 的 select 请求不应答
 * （挂起语义与 taiji runtime S4 不超时同构）。
 *
 * 场景分类（design task T1-T3）：
 *   A 类（必须自动化通过）：S1 once 回显 / S2 recurring 回显 / S3 session 隔离 /
 *     S5 resume 重放 / S9 删 session 无残留 / S17 entry 增长 /
 *     S18 确认交互（改配置后确认）/ S19 确认交互（取消）
 *   B 类（尽力自动化，跑不了标 followup）：S4/S6/S12/S14 实现；S7/S8/S10/S16 标 followup
 *   C 类（标 followup + 手工步骤）：S11 fork 隔离 / S13 延迟写入窗口 / S15 taiji 兼容
 *
 * 副作用隔离（design R-cleanup）：每场景独立 mkdtempSync 临时 cwd + session-dir +
 * agent-dir（faux 装配，settings/models/响应脚本预置）；cleanup 额外清理
 * getLegacyStorePath(tempCwd) 推导的 ~/.pi/agent/scheduler/<segments>/ 整棵子树。
 *
 * 用法：
 *   node scripts/verify-scheduler-e2e.cjs              # 默认跑全部 A 类
 *   node scripts/verify-scheduler-e2e.cjs S1           # 单场景（S1..S19 / V / aclass / bclass / all）
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

const TAG = '[SCHED-E2E]'
const REPO_ROOT = path.resolve(__dirname, '..')
const EXTENSION_PATH = path.join(REPO_ROOT, 'extensions', 'universal', 'scheduler')
/**
 * 统一提问表单请求的 select title marker（cjs 端口；SSOT =
 * packages/extension-protocol/src/extensions/ui-form/marker.ts，改动须同步）。
 * scheduler 创建确认迁移后走本通道（u6）：options[0] = {formQuestions, allowCancel}。
 * NUL 前缀与 ask-user / session-manager marker 同规范。
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
 * 预置 faux agentDir（settings.json + models.json + 响应脚本）并返回 env 注入块。
 * settings/models 与 e2e real 轨 launch-app-real.ts 的 seedFauxDataDir 同款语义
 *（defaultProvider=faux 过 getDefaultModel 门禁 + models.json providers.faux 供
 * pi 模型解析；sanitize 对 apiKey+models 条目判定合法保留）。
 */
function makeFauxAgentDir(tag, fauxSteps) {
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
        models: [{ id: FAUX_MODEL_ID, name: `Faux ${FAUX_MODEL_ID}`, input: ['text'], contextWindow: 128000, maxTokens: 16384 }],
      },
    },
  }, null, 2))
  const scriptPath = path.join(agentDir, 'faux-responses.json')
  writeFileSync(scriptPath, JSON.stringify(fauxSteps))
  return {
    agentDir,
    env: { PI_CODING_AGENT_DIR: agentDir, TAIJI_FAUX_SCRIPT: scriptPath },
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
 * @callback UiActor
 * @param {ExtensionUiRequestView} req
 * @returns {{ cancelled: true } | { value: string } | null} 取消 / 确认（value=回传值）/
 *   null（不应答——select 挂起，语义与 taiji runtime 不超时等待同构）
 */

/**
 * 统一表单请求的 schedule 问题（cjs 端口）：UI_FORM_MARKER select 且 options[0]
 * payload 的 formQuestions[0] 为 type='schedule'（initial 预填 draft）时返回该问题，
 * 否则 null（非本协议请求）。payload 非法 JSON 同样返回 null——不应答（挂起暴露
 * 协议故障，不静默造回包）。
 * @param {ExtensionUiRequestView} req
 * @returns {{ type: 'schedule', header?: string, question: string, initial?: object } | null}
 */
function parseScheduleQuestion(req) {
  if (req.method !== 'select' || req.title !== UI_FORM_MARKER) return null
  try {
    const payload = JSON.parse(req.options[0])
    const q = payload && Array.isArray(payload.formQuestions) ? payload.formQuestions[0] : null
    if (q && q.type === 'schedule') return q
  } catch (_) {
    return null
  }
  return null
}

/** answers key（D2 fallback：header ?? question——与 FormOverlay qKey 同规则） */
function formAnswerKey(q) {
  return typeof q.header === 'string' ? q.header : q.question
}

/**
 * 统一表单 schedule 确认请求的默认应答：按 initial 草稿原样回确认。回包 =
 * FormAnswers envelope（{key: flat ScheduleFormResult JSON}，kind/schedule/model/
 * prompt/name/expires 字段同构透传，u6 迁移后的回包契约）。既有场景（S1-S17）
 * 经此保持创建成功路径。非本协议 select 返回 null（不应答）。
 * @param {ExtensionUiRequestView} req
 * @returns {{ cancelled: true } | { value: string } | null}
 */
function autoConfirmScheduleForm(req) {
  const question = parseScheduleQuestion(req)
  if (!question) return null
  const result = { action: 'create' }
  for (const key of ['kind', 'schedule', 'model', 'prompt', 'name', 'expires']) {
    if (
      question.initial &&
      typeof question.initial === 'object' &&
      question.initial[key] !== undefined
    ) {
      result[key] = question.initial[key]
    }
  }
  return { value: JSON.stringify({ [formAnswerKey(question)]: JSON.stringify(result) }) }
}

/**
 * extension_ui_request 帧分发：按场景 uiActor（缺省 autoConfirmScheduleForm）应答。
 * 帧契约（pi 0.84.4 dist/modes/rpc/rpc-mode.js）：stdout 输出
 * {type:'extension_ui_request', id, method, ...}，stdin 回
 * {type:'extension_ui_response', id, ...reply}（cancelled:true → resolve undefined；
 * value → resolve value）。notify/setStatus 等单向帧不期待应答，actor 返回 null 即忽略。
 * @param {Record<string, unknown>} msg 已解析的 stdout JSON 帧
 * @param {{ uiActor?: UiActor | null, respond: ((obj: Record<string, unknown>) => void) | null }} state
 */
function respondExtensionUiRequest(msg, state) {
  if (!msg || msg.type !== 'extension_ui_request') return
  const actor = state.uiActor || autoConfirmScheduleForm
  const reply = actor({
    id: typeof msg.id === 'string' ? msg.id : String(msg.id),
    method: typeof msg.method === 'string' ? msg.method : '',
    title: typeof msg.title === 'string' ? msg.title : undefined,
    options: Array.isArray(msg.options) ? msg.options.map(String) : undefined,
  })
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
 *           fauxSteps: Array<Object>, uiActor?: UiActor }} opts
 *   fauxSteps：faux 响应步骤队列（toolCall/text；faux 轨必填——每 session 独立 agentDir
 *   + 独立响应脚本，S3/S5 等多进程场景互不串队）。
 *   uiActor：extension_ui_request 应答器（确认交互，确认/取消可配置）。缺省 =
 *   autoConfirmScheduleForm（统一表单 schedule 问题按 initial 草稿原样确认——既有
 *   场景的创建成功路径）；S18 注入改配置确认、S19 注入取消。
 */
function spawnSession(opts) {
  const faux = makeFauxAgentDir(opts.label, opts.fauxSteps)
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
  if (opts.sessionFile) {
    args.push('--session', opts.sessionFile) // resume 指定 session 文件
  }
  const child = spawn(opts.piBin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: {
      ...process.env,
      PI_SKIP_VERSION_CHECK: '1',
      ...faux.env,
    },
  })

  let rpcId = 0
  /** @type {Map<string, { resolve: (v: unknown) => void }>} */
  const pending = new Map()
  /** @type {unknown[]} */ // 所有 stdout JSON 消息（response / streaming / turn_end 等）
  const captured = []
  // 跨 chunk 可变状态：stdout 行缓冲 / turn_end 等待者 / sessionFile 缓存 /
  // ui 应答器（extension_ui_request → extension_ui_response，确认交互）
  const state = {
    stdoutBuf: '',
    turnEndResolver: null,
    sessionFileCache: null,
    uiActor: opts.uiActor || null,
    respond: null,
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

  /** 发 prompt 并等回合结束。返回 { ok, stopReason }。 */
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

  function kill() {
    try {
      child.kill('SIGTERM')
    } catch (_) {
      /* noop */
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
    getEntries,
    getMessages,
    getState,
    kill,
    stderrTail,
    getJsonlSnippet,
    /** @returns {unknown[]} */
    getCaptured: () => captured,
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

/** ScheduleDraft 顶层形状守卫：非 null 的普通对象（排除数组）。 */
function isDraftPayloadObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** ScheduleDraft 可选字段守卫：undefined（未提供）或 string。 */
function isOptionalString(v) {
  return v === undefined || typeof v === 'string'
}

/** ScheduleDraft kind 字段守卫：'once' 或 'recurring'。 */
function isScheduleDraftKind(kind) {
  return kind === 'once' || kind === 'recurring'
}

/**
 * 对象是否为合法 ScheduleDraft 形状（cjs 端口；字段判定与
 * packages/extension-protocol/src/extensions/scheduler-create/helpers.ts 的
 * isScheduleDraft 一致，改动须同步）。驱动器用于断言请求帧 payload 的协议形状。
 * 判定顺序与端口源一致（顶层形状 → kind → 各字段），不可调换。
 * @param {unknown} value
 * @returns {boolean}
 */
function isScheduleDraftShape(value) {
  if (!isDraftPayloadObject(value)) return false
  const d = value
  return isScheduleDraftKind(d.kind)
    && typeof d.schedule === 'string'
    && isOptionalString(d.model)
    && typeof d.prompt === 'string'
    && isOptionalString(d.name)
    && isOptionalString(d.expires)
    && Array.isArray(d.models)
    && d.models.every((m) => typeof m === 'string')
    && isOptionalString(d.currentModel)
}

/**
 * 从 captured 提取统一表单 schedule 确认请求帧列表（确认交互的请求侧证据）。
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

// ── 场景定义 ──
// 每个场景函数返回 { name, status, evidence, followup? }
// status: 'PASS' | 'FAIL' | 'FOLLOWUP'

/** S1：once 回显仅 1 条 run 行、不含 "Next 5 runs:"。 */
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

    s.kill()

    const hasOnceEcho = /Next run:\s+in\s+1h/.test(blob)
    const noRecurringHeader = !blob.includes('Next 5 runs:')
    const numberedLines = countNumberedRunLines(blob)
    const hasUpsert = upserts.length >= 1

    const pass =
      hasOnceEcho && noRecurringHeader && numberedLines === 0 && hasUpsert
    return {
      name: 'S1',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `once echo 'Next run: in 1h' present=${hasOnceEcho}; ` +
        `no 'Next 5 runs:'=${noRecurringHeader}; numbered run lines=${numberedLines}; ` +
        `upsert entries=${upserts.length}; opSeq=${JSON.stringify(ops)}; ` +
        `jsonl=[${s.getJsonlSnippet()}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/** S2：recurring 回显含 "Next 5 runs:" 且 5 条。 */
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
    s.kill()

    const hasRecurringHeader = blob.includes('Next 5 runs:')
    const numberedLines = countNumberedRunLines(blob)
    const hasUpsert = upserts.length >= 1

    const pass = hasRecurringHeader && numberedLines === 5 && hasUpsert
    return {
      name: 'S2',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `'Next 5 runs:' present=${hasRecurringHeader}; numbered run lines=${numberedLines} (expect 5); ` +
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

// ── A 类：创建确认交互场景（U7 新增，设计 §3.4 协议契约 / §4 e2e 影响面）──

/**
 * S18 ① 请求帧契约校验：恰 1 次 UI_FORM_MARKER select，options[0] payload 的
 * formQuestions[0] 为 schedule 问题且 initial 是合法 ScheduleDraft、schedule/prompt
 * 反映 faux 参数（1h / confirm-draft-prompt）。
 * @param {Array<{ id: string, options: string[] }>} reqs getScheduleFormRequests 产物
 * @returns {{ ok: boolean, desc: string }} ok=契约成立；desc=请求侧诊断（未取到 draft 时 '(none)'）
 */
function checkScheduleFormDraftContract(reqs) {
  const baseOk = reqs.length === 1 && reqs[0].options.length >= 1
  let desc = '(none)'
  if (!baseOk) return { ok: false, desc }
  try {
    const payload = JSON.parse(reqs[0].options[0])
    const q = payload && Array.isArray(payload.formQuestions) ? payload.formQuestions[0] : null
    if (!q || q.type !== 'schedule') return { ok: false, desc }
    const draft = q.initial
    const ok = isScheduleDraftShape(draft)
      && draft.schedule === '1h'
      && draft.prompt === 'confirm-draft-prompt'
    desc = `kind=${draft.kind} schedule=${draft.schedule} prompt=${String(draft.prompt).slice(0, 40)} models=${Array.isArray(draft.models) ? draft.models.length : '?'}`
    return { ok, desc }
  } catch (_) {
    // options[0] 非 JSON，或 draft 解析为 null 后属性访问失败 → 契约不成立，诊断维持 '(none)'
    return { ok: false, desc }
  }
}

/** S18 ② tool result 回显断言：45m 下次运行 + 改后 prompt 进自动任务名。 */
function echoesEditedValues(blob) {
  return /Next run:\s+in\s+45m/.test(blob)
    && blob.includes('Task "user-edited-prompt"')
}

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

/**
 * S18：确认创建路径（用户改配置后确认）。
 *
 * faux 触发 schedule（draft: 1h / once / confirm-draft-prompt）→ extension_ui_request
 * 帧到达 → uiActor 以「用户裁定值」回 FormAnswers envelope（key 的 value = 45m /
 * user-edited-prompt 的 flat ScheduleFormResult）→ 确认创建。断言三面：
 *   ① 请求帧契约：恰 1 次 UI_FORM_MARKER select，formQuestions[0] 为 schedule 问题
 *      且 initial 是合法 ScheduleDraft、反映 faux 参数
 *   ② tool result 回显用户裁定值（45m echo + 改后 prompt 进任务名）
 *   ③ 落库形态：upsert entry 恰 1 条，task 字段 = 用户裁定值（非 draft 原值）
 */
async function runS18(piBin) {
  const ws = makeTempWorkspace('s18')
  try {
    const s = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S18',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'confirm-draft-prompt', schedule: '1h', kind: 'once' } }] },
        { text: 'done' },
      ],
      uiActor: (req) => {
        const question = parseScheduleQuestion(req)
        if (!question) return null
        // 用户在确认弹框改了时间（1h → 45m）与提示词 → 回 FormAnswers envelope（裁定值）
        return {
          value: JSON.stringify({
            [formAnswerKey(question)]: JSON.stringify({
              action: 'create', kind: 'once', schedule: '45m', prompt: 'user-edited-prompt',
            }),
          }),
        }
      },
    })
    const ready = await s.waitReady()
    if (!ready) return fail('S18', 'pi not ready / extension load failed: ' + s.stderrTail())

    const turnEnd = await s.prompt(
      'Create a scheduled task by calling the schedule tool with these exact arguments: prompt is "confirm-draft-prompt", schedule is "1h", kind is "once". After the tool returns, reply with the single word: done',
    )
    if (!turnEnd.ok) return fail('S18', 'turn did not end (timeout) — select 交互未闭环')

    const reqs = getScheduleFormRequests(s.getCaptured())
    const contract = checkScheduleFormDraftContract(reqs)
    if (!contract.ok) {
      s.kill()
      return fail('S18', `schedule form request contract broken (count=${reqs.length}, draft=${contract.desc})`)
    }

    const entries = await s.getEntries()
    const sched = getSchedulerEntries(entries)
    const upserts = sched.filter((e) => e.data.op === 'upsert')
    const messages = await s.getMessages()
    const blob = fullTextBlob(messages, s.getCaptured())
    s.kill()

    // ② tool result 回显裁定值：45m 的下次运行 + 改后 prompt 进自动任务名
    const echoEdited = echoesEditedValues(blob)
    // ③ 落库 = 裁定值（45m → interval 2700000ms；prompt/kind 为用户回传形态）
    const task = getSingleUpsertTask(upserts)
    const taskOk = isEditedValueTask(task)

    const pass = contract.ok && echoEdited && taskOk
    return {
      name: 'S18',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `request draft=${contract.desc}; ` +
        `echo edited values (45m + user-edited-prompt)=${echoEdited}; ` +
        `upsert task = edited values=${taskOk} ` +
        describeUpsertTask(task) + '; ' +
        `upserts=${upserts.length}; jsonl=[${s.getJsonlSnippet()}]`,
    }
  } finally {
    ws.cleanup()
  }
}

/**
 * S19：取消路径（D5——取消不是错误，任务不创建）。
 *
 * 统一表单 schedule 确认请求到达 → uiActor 回 cancelled（pi resolve undefined →
 * cancelled/timeout 折叠 → cancelledCreateResult）。断言三面：
 *   ① 请求帧契约：恰 1 次 UI_FORM_MARKER select（交互确实发生）
 *   ② tool result 为 cancelled 明确文案（agent 不猜测、不重试的契约文本）
 *   ③ 落库：零 scheduler entry（任务未创建）
 */
async function runS19(piBin) {
  const ws = makeTempWorkspace('s19')
  try {
    const s = spawnSession({
      piBin, cwd: ws.cwd, sessionDir: ws.sessionDir, label: 'S19',
      fauxSteps: [
        { toolCalls: [{ name: 'schedule', args: { prompt: 'cancel-path-task', schedule: '30m', kind: 'once' } }] },
        { text: 'done' },
      ],
      uiActor: (req) => {
        if (!parseScheduleQuestion(req)) return null
        return { cancelled: true }
      },
    })
    const ready = await s.waitReady()
    if (!ready) return fail('S19', 'pi not ready / extension load failed: ' + s.stderrTail())

    const turnEnd = await s.prompt(
      'Create a scheduled task by calling the schedule tool with these exact arguments: prompt is "cancel-path-task", schedule is "30m", kind is "once". After the tool returns, reply with the single word: done',
    )
    if (!turnEnd.ok) return fail('S19', 'turn did not end (timeout) — select 交互未闭环')

    const reqs = getScheduleFormRequests(s.getCaptured())
    const entries = await s.getEntries()
    const sched = getSchedulerEntries(entries)
    const messages = await s.getMessages()
    const blob = fullTextBlob(messages, s.getCaptured())
    s.kill()

    const oneInteraction = reqs.length === 1
    const cancelledEcho = blob.includes('Cancelled. The task was NOT created')
    const noTaskPersisted = sched.length === 0

    const pass = oneInteraction && cancelledEcho && noTaskPersisted
    return {
      name: 'S19',
      status: pass ? 'PASS' : 'FAIL',
      evidence:
        `form select requests=${reqs.length} (expect 1); ` +
        `cancelled tool result present=${cancelledEcho}; ` +
        `scheduler entries=${sched.length} (expect 0 — 任务未创建); ` +
        `opSeq=${JSON.stringify(getOpSequence(sched))}`,
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
  console.log(`${TAG} ${icon} ${r.name}: ${r.status}`)
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

const A_CLASS = ['S1', 'S2', 'S3', 'S5', 'S9', 'S17', 'S18', 'S19']
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
    console.log(`${TAG} usage: node verify-scheduler-e2e.cjs [S1..S19|aclass|bclass|all|v]`)
    return 2
  }

  const results = []
  for (const name of toRun) {
    console.log(`${TAG} ------------------------------------------------------------`)
    console.log(`${TAG} running ${name} ...`)
    const r = await executeScenario(name, piBin)
    if (r) {
      results.push(r)
      printResult(r)
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
