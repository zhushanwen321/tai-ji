/**
 * 实例生命周期原语（verify-taiji 能力原语层 · lib）。
 *
 * 职责边界（API-CONTRACT §0/§1.1）：只做「起实例 / 等就绪 / 委托 doctor / 收尾」的驱动与
 * 事实读取；不实现任何产品语义。端口与数据目录一律以装配器 `dev-instance.mjs --print`
 * 的 banner 为权威源（照 doctor.mjs 的解析法提炼为 parseBanner，doctor.mjs 本身保持独立）。
 *
 * 纪律：
 * - launch 用 detached spawn（后台常驻，不阻塞调用方）；
 * - 就绪判定 = 条件轮询 + 明确超时（禁「sleep 后断言」）；
 * - 只 kill 自己起的 PID（禁 pkill / 进程组宽匹配）；
 * - dispose 幂等，失败也留原始输出（实例启动日志 + 日志尾）。
 *
 * 两条零 token LLM 通道（API-CONTRACT §1.1）：
 * - `faux`    ：pi extension 注册 `api: 'faux'` provider（主会话可用；**孙进程不可达**）；
 * - `llm`     ：本机 mock HTTP 服务 + models.json 里的 `openai-completions` 自定义 provider
 *               （`lib/mock-llm.mjs`；**孙进程可达**，因为它只依赖 PI_CODING_AGENT_DIR 下的
 *               models.json，不依赖任何 extension）。
 *
 * 零第三方依赖：仅 node:*。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))

/** dev 数据树根（与 apps/electron/scripts/dev-instance-lib.mjs DEV_DATA_PARENT 同源语义）。 */
export const DEV_DATA_PARENT = path.join(os.homedir(), '.taiji-dev')

/** 扩展装载就绪阈值（SKILL.md §1 就绪判据三）。 */
export const EXT_READY_MIN_COUNT = 8

/** 轮询间隔（条件轮询，非盲等；判定条件每轮都重算）。 */
const POLL_INTERVAL_MS = 300

/** 默认就绪超时：pi 子进程 spawn + 扩展装载较慢，SKILL.md 给 30s 量级，这里留足。 */
const DEFAULT_READY_TIMEOUT_MS = 180_000

export class InstanceError extends Error {
  constructor(message, { hint, evidence } = {}) {
    super(message)
    this.name = 'InstanceError'
    this.hint = hint
    this.evidence = evidence
  }
}

/**
 * 关掉 rename-session 自动标题（验收确定性）。
 *
 * 只删 `auto-rename-enabled` 不够：runtime 首启后台串行链的 ensureAutoRenameDefault 见
 * `auto-rename-initialized` 标记不存在会重建 enabled flag（默认开，2026-10-22 实测：
 * 标题生成经 llm-shared 走 faux/mock 双注册 compat 通道，按全局到达序消耗同一响应队列，
 * 主轮之间的插队消费让后续 turn 命中「队列耗尽」error）。必须同时预置 initialized
 * 标记——ensureAutoRenameDefault 见标记存在即跳过，不再创建 enabled flag。
 * 契约源：packages/runtime/src/services/rename-session-config.ts +
 * extensions/universal/rename-session/src/pure.ts（flag 存在=开，不存在回落 config.enabled）。
 */
function disarmAutoRename(agentDir) {
  fs.rmSync(path.join(agentDir, 'auto-rename-enabled'), { force: true })
  const initialized = path.join(agentDir, 'auto-rename-initialized')
  if (!fs.existsSync(initialized)) fs.writeFileSync(initialized, '', 'utf-8')
}

/** 极简条件轮询：predicate 返回真值即返回；超时返回 undefined（调用方给带 hint 的错）。 */
async function pollUntil(predicate, { timeoutMs, intervalMs = POLL_INTERVAL_MS }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) return undefined
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 解析 worktree 根并校验装配器在场。 */
export function resolveRepo(repoArg) {
  const repo = path.resolve(repoArg ?? process.cwd())
  const devInstance = path.join(repo, 'apps/electron/scripts/dev-instance.mjs')
  if (!fs.existsSync(devInstance)) {
    throw new InstanceError(`不是 taiji worktree 根：${repo}（缺 apps/electron/scripts/dev-instance.mjs）`, {
      hint: '传 worktree 根绝对路径（含 apps/electron/scripts/dev-instance.mjs 的目录）',
    })
  }
  return repo
}

/**
 * 解析 `dev-instance.mjs --print` 的 banner（doctor.mjs 与 lib 共用的解析语义）。
 *
 * banner 形态（printBanner）：
 *   │  worktree/实例:  <name>
 *   │  数据目录:       <abs>
 *   │  Vite:           http://localhost:<port>
 *   │  CDP:            http://localhost:<port>
 *   │  runtime 端口段:  <start>-<end> (offset=<n>)
 *   │  后台模式:       是/否...
 */
export function parseBanner(text) {
  const grab = (label) => {
    const m = String(text).match(new RegExp(`${label}:\\s*(.+)`))
    return m ? m[1].trim() : ''
  }
  const viteMatch = grab('Vite').match(/:(\d+)\s*$/)
  const cdpMatch = grab('CDP').match(/:(\d+)\s*$/)
  const rangeMatch = grab('runtime 端口段').match(/(\d+)\s*-\s*(\d+)/)
  return {
    instanceName: grab('worktree/实例'),
    dataDir: grab('数据目录'),
    vitePort: viteMatch ? Number(viteMatch[1]) : 0,
    cdpPort: cdpMatch ? Number(cdpMatch[1]) : 0,
    runtimePortRange: rangeMatch ? { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]) } : null,
    background: grab('后台模式').startsWith('是'),
  }
}

/**
 * 权威派生参数（跑 `--print`，不启动实例）。
 * 对不存在的实例目录会从只读模板创建目录（doctor 同款幂等副作用，可接受）。
 */
export function printInstance({ repo, name, dataDir }) {
  const args = ['apps/electron/scripts/dev-instance.mjs', '--print']
  if (dataDir) args.push('--data-dir', dataDir)
  if (name) args.push('--name', name)
  const printed = spawnSync('node', args, { cwd: repo, encoding: 'utf8', timeout: 60_000 })
  if (printed.status !== 0) {
    throw new InstanceError(`dev-instance.mjs --print 退出码 ${printed.status}`, {
      hint: '先在 worktree 根跑 `node apps/electron/scripts/dev-instance.mjs --print` 看完整输出',
      evidence: { stderr: (printed.stderr ?? '').trim(), stdout: (printed.stdout ?? '').trim() },
    })
  }
  const parsed = parseBanner(printed.stdout)
  if (!parsed.vitePort || !parsed.cdpPort || !parsed.dataDir) {
    throw new InstanceError('banner 解析失败（装配器输出格式可能已变）', {
      hint: '核对 apps/electron/scripts/dev-instance.mjs 的 printBanner 格式',
      evidence: { stdout: String(printed.stdout).slice(0, 800) },
    })
  }
  return parsed
}

/** 端口占用者 PID 列表（lsof；无占用 = []）。 */
export function portOwners(port) {
  if (!port) return []
  const r = spawnSync('lsof', ['-ti', `:${port}`, '-P'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
}

/** PID → 命令行（证据用）。 */
export function cmdOf(pid) {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? r.stdout.trim() : ''
}

/** CDP /json/list（不可达 = null）。 */
export function cdpPages(port, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

/** TCP 可连（用于 runtime.port 已在位但尚未 listen 的窗口）。 */
export function canConnect(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

export function readRuntimeLogs(dataDir) {
  const logDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logDir)) return ''
  return fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith('runtime-'))
    .map((f) => {
      try {
        return fs.readFileSync(path.join(logDir, f), 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

export function readPiLogs(dataDir) {
  // 树内布局：<dataDir>/ext-sessions/<sid>/logs/pi-<date>.jsonl（sessionId 在路径）
  const roots = [path.join(dataDir, 'logs'), path.join(dataDir, 'ext-sessions')]
  const files = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) {
        if (e.name.startsWith('pi-') && e.name.endsWith('.jsonl')) files.push(path.join(root, e.name))
        continue
      }
      const sub = path.join(root, e.name, 'logs')
      if (!fs.existsSync(sub)) continue
      for (const f of fs.readdirSync(sub)) {
        if (f.startsWith('pi-') && f.endsWith('.jsonl')) files.push(path.join(sub, f))
      }
    }
  }
  return files
    .map((f) => {
      try {
        return fs.readFileSync(f, 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

/** 扩展装载数（runtime 日志末次 `resolved N extensions from M sources`；无信号 = 0）。 */
export function resolvedExtensionCount(dataDir) {
  const matches = [...readRuntimeLogs(dataDir).matchAll(/resolved (\d+) extensions from (\d+) sources/g)]
  if (matches.length === 0) return { count: 0, sources: 0, seen: false }
  const last = matches[matches.length - 1]
  return { count: Number(last[1]), sources: Number(last[2]), seen: true }
}

/**
 * 创建一个实例句柄（不启动）。
 * @see API-CONTRACT §1.1
 */
export function createInstance(options = {}) {
  const repo = resolveRepo(options.repo)
  const explicitDataDir = options.dataDir ? path.resolve(options.dataDir) : undefined
  const nameProvided = typeof options.name === 'string' && options.name.length > 0
  let instanceName = options.name ?? `verify-${Date.now().toString(36)}`
  const background = options.background !== false
  const faux = options.faux
  const llm = options.llm
  if (faux && llm) {
    throw new InstanceError('faux 与 llm 是两条互斥的 LLM 通道，只能选一个', {
      hint: '主会话用 faux（extension 通道）或 mock-http（llm 通道）；需孙进程可用 → 用 llm',
    })
  }
  const extraEnv = options.env ?? {}
  /** mock-http 服务的句柄（launch 时起、dispose 时关）。 */
  let mockLlm = null
  /** llm 通道装配出的 provider id / 模型清单（供探针断言与记录）。 */
  let llmTopology = null

  let state = 'idle' // idle | launched | stopped | disposed
  let parsed = null
  let pid = null
  let logFile = null
  let exitInfo = null
  let selfCreatedDataDir = false
  let readyReport = null
  let proto = null
  let uiInstance = null
  let pageInstance = null

  function dataDir() {
    if (explicitDataDir) return explicitDataDir
    if (!parsed) {
      // 自建目录：mkdtemp 到 ~/.taiji-dev/verify-*（与 --data-dir 值域规则一致）
      fs.mkdirSync(DEV_DATA_PARENT, { recursive: true })
      parsed = { ...(parsed ?? {}), dataDir: fs.mkdtempSync(path.join(DEV_DATA_PARENT, 'verify-')) }
      selfCreatedDataDir = true
    }
    return parsed.dataDir
  }

  /**
   * 保证 parsed（端口/数据目录）在位：launch 之外的「接入已有实例」路径（page/protocol/
   * waitReady/doctor）在此按 --print 派生，不 spawn、不覆盖实例目录（幂等种子）。
   */
  function ensureParams() {
    if (!parsed) {
      // 接入已有实例（无显式 name）时优先采用实例元数据里的名字，否则端口会按
      // worktree 默认名派生 → doctor/ports 判错实例。
      if (!nameProvided) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dataDir(), 'verify-instance.json'), 'utf8'))
          if (typeof meta.instanceName === 'string' && meta.instanceName.length > 0) instanceName = meta.instanceName
        } catch {
          /* 无元数据：按默认名派生 */
        }
      }
      parsed = printInstance({ repo, name: instanceName, dataDir: dataDir() })
    }
    return parsed
  }

  function ensureFaux(dir) {
    if (!faux) return
    const seedScript = path.resolve(LIB_DIR, '..', 'seed-faux.mjs')
    const tmpResponses = path.join(os.tmpdir(), `verify-faux-${process.pid}-${Date.now()}.json`)
    fs.writeFileSync(tmpResponses, JSON.stringify(faux.responses ?? []))
    const args = [seedScript, repo, dir, tmpResponses]
    if (faux.force) args.push('--force')
    const r = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 120_000 })
    try {
      fs.rmSync(tmpResponses, { force: true })
    } catch {
      /* tmp 清理失败不阻塞装配 */
    }
    if (r.status !== 0) {
      throw new InstanceError('faux 预置失败（seed-faux.mjs 非 0 退出）', {
        hint: '检查 dataDir 是否在 ~/.taiji-dev 树内且非保留目录；已有预置时加 faux.force',
        evidence: { stderr: (r.stderr ?? '').trim(), stdout: (r.stdout ?? '').trim() },
      })
    }
  }

  function buildLaunchEnv(dir, name) {
    const env = { ...process.env, ...extraEnv }
    if (background) env.TAIJI_DEV_BACKGROUND = '1'
    env.TAIJI_DEV_INSTANCE_NAME = name
    if (faux) {
      env.TAIJI_FAUX_SCRIPT = path.join(dir, 'agent', 'faux-responses.json')
      env.TAIJI_EXTENSION_PATHS = path.join(repo, 'e2e', 'fixtures', 'faux-provider-ext')
      // [M13 修] faux.tps 必须落到 TAIJI_FAUX_TPS（旧实现静默丢弃 → 永远拿不到流式窗口，
      // 所有「流式中途态」断言必然错过）。官方形态见 e2e/fixtures/launch-app-real.ts。
      if (faux.tps !== undefined && Number(faux.tps) > 0) env.TAIJI_FAUX_TPS = String(faux.tps)
    }
    // llm 通道不需要任何 env：provider 定义全在 <dataDir>/agent/models.json 里，
    // 主 pi 与孙进程都按 PI_CODING_AGENT_DIR 读同一份。
    // 子进程不允许继承「另一个实例」的残留标记
    delete env.TAIJI_E2E
    return env
  }

  /**
   * llm（mock-http）通道装配：起 mock server → 写 models.json / settings.json /
   * subagents/config.json → 删 auto-rename 标志。返回拓扑供探针断言。
   *
   * 关键事实（源码核对，勿凭示例硬写）：
   * - models.json schema = `packages/runtime/src/infra/pi/pi-provider-store.ts` 的
   *   `PiProviderConfig`：provider 级 name/baseUrl/apiKey/api/models[]，模型级
   *   id/name/api/baseUrl/reasoning/input/contextWindow/maxTokens；
   * - apiKey 用**字面量**（pi 的 resolve-config-value 把 `$VAR` 当 env 模板、`!cmd` 当命令，
   *   纯字面量才是静态 key）；
   * - 孙进程模型默认走 `<agentDir>/subagents/config.json` 的 `engineDefaults.pi`
   *   （`packages/subagent-core/src/execution/assembly/types.ts` 的
   *   `SubagentsGlobalConfig.engineDefaults`，无 per-engine defaultModel 字段）。
   */
  async function ensureLlm(dir) {
    if (!llm) return
    const { createMockLlm } = await import('./mock-llm.mjs')
    const providerId = llm.providerId ?? 'mockllm'
    const mainModel = llm.mainModel ?? 'mock-1'
    const subModel = llm.subModel ?? 'mock-sub-a'
    const actors = Array.isArray(llm.models) && llm.models.length > 0
      ? llm.models
      : [mainModel, 'mock-sub-a', 'mock-sub-b']
    mockLlm = await createMockLlm({
      port: llm.port ?? 0,
      script: llm.responses ?? llm.script ?? [],
      name: `verify-${instanceName}`,
      ...(llm.tps ? { tps: llm.tps } : {}),
    })
    llmTopology = {
      providerId,
      mainRef: `${providerId}/${mainModel}`,
      subRef: `${providerId}/${subModel}`,
      models: actors,
      baseUrl: mockLlm.baseUrl,
      port: mockLlm.port,
      mock: mockLlm,
    }

    const agentDir = path.join(dir, 'agent')
    fs.mkdirSync(path.join(agentDir, 'subagents'), { recursive: true })
    // 1) models.json：只写本 provider（模板里用户自己的 provider 保留不动）
    const modelsPath = path.join(agentDir, 'models.json')
    let models = { providers: {} }
    try {
      const parsed = JSON.parse(fs.readFileSync(modelsPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
        models = parsed
      }
    } catch {
      /* 不存在 / 坏 JSON：以最小骨架起（验收实例不承担配置迁移职责） */
    }
    models.providers[providerId] = {
      name: 'Mock LLM (verify-taiji local mock-http)',
      api: 'openai-completions',
      baseUrl: mockLlm.baseUrl,
      apiKey: 'mock-key-not-needed',
      models: actors.map((id) => ({
        id,
        name: id,
        reasoning: false,
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16_384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    }
    fs.writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`)

    // 2) settings.json：defaultProvider/defaultModel + enabledModels（pi 的 model scope）
    const settingsPath = path.join(agentDir, 'settings.json')
    let settings = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      if (parsed && typeof parsed === 'object') settings = parsed
    } catch {
      /* 模板种子理论上已写入；缺失时以空对象起 */
    }
    settings.defaultProvider = providerId
    settings.defaultModel = mainModel
    const enabled = new Set(Array.isArray(settings.enabledModels) ? settings.enabledModels : [])
    for (const id of actors) enabled.add(`${providerId}/${id}`)
    settings.enabledModels = [...enabled]
    // 重试会让「剧本耗尽」变成慢速重放，验收实例显式关掉
    settings.retry = { ...(settings.retry ?? {}), enabled: false }
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)

    // 3) subagents/config.json：engineDefaults.pi = 孙进程缺省模型（pi 引擎无 config 时
    //    会继承主 agent 模型；显式写死让「子演员」与主 agent 区分开，且不依赖派发参数）
    const subagentsPath = path.join(agentDir, 'subagents', 'config.json')
    let subCfg = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(subagentsPath, 'utf8'))
      if (parsed && typeof parsed === 'object') subCfg = parsed
    } catch {
      /* 无文件：以最小骨架起 */
    }
    subCfg.defaultEngine = subCfg.defaultEngine ?? 'pi'
    subCfg.engineDefaults = { ...(subCfg.engineDefaults ?? {}), pi: `${providerId}/${subModel}` }
    fs.writeFileSync(subagentsPath, `${JSON.stringify(subCfg, null, 2)}\n`)

    // 4) auto-rename 关掉（标题生成会经 llm-shared 打 mock，消耗剧本 step 并污染断言）
    disarmAutoRename(agentDir)
    return llmTopology
  }

  const api = {
    get repo() {
      return repo
    },
    /** mock-http 服务句柄（launch 后可用；faux 通道为 null）。 */
    get mockLlm() {
      return mockLlm
    },
    /** llm 通道拓扑（providerId / mainRef / subRef / models / baseUrl）；faux 通道为 null。 */
    get llm() {
      return llmTopology
    },
    get name() {
      return instanceName
    },
    get pid() {
      return pid
    },
    get state() {
      return state
    },
    get logFile() {
      return logFile
    },
    get ready() {
      return readyReport
    },
    get dataDir() {
      return dataDir()
    },

    /** 启动实例（detached 后台）。幂等：已启动直接返回同一份参数。 */
    async launch() {
      if (state === 'launched') return api.info()
      if (state === 'disposed') throw new InstanceError('实例已 dispose，不能再次 launch', { hint: '重新 createInstance' })
      if (explicitDataDir) {
        parsed = { ...(parsed ?? {}), dataDir: explicitDataDir }
      }
      const dir = dataDir()
      if (llm) {
        // llm 通道：先让 --print 完成模板种子（models.json / settings.json 骨架来自模板，
        // 我们只在骨架之上覆写本 provider 相关字段），再起 mock 并写盘。
        // 顺序与 faux 相反，是因为 mock-http 装配是「合并式」而非「整文件预置」。
        const printed = printInstance({ repo, name: instanceName, dataDir: dir })
        parsed = printed
        await ensureLlm(dir)
      } else {
        // 1) faux 预置必须先于 --print：--print 会从只读模板种子实例目录（settings.json 等），
        //    seed-faux 遇已存在的 settings.json 会拒绝覆盖。seed 先写，模板种子不覆盖已有文件。
        ensureFaux(dir)
        // 2) --print 拿权威端口（同时完成模板种子，幂等副作用）
        const printed = printInstance({ repo, name: instanceName, dataDir: dir })
        parsed = printed
        if (faux) {
          disarmAutoRename(path.join(dir, 'agent'))
        }
      }
      fs.mkdirSync(dir, { recursive: true })
      logFile = path.join(dir, 'verify-launch.log')
      const fd = fs.openSync(logFile, 'a')
      const args = ['apps/electron/scripts/dev-instance.mjs', '--data-dir', dir, '--name', instanceName]
      let child
      try {
        child = spawn(process.execPath, args, {
          cwd: repo,
          detached: true,
          stdio: ['ignore', fd, fd],
          env: buildLaunchEnv(dir, instanceName),
        })
      } catch (e) {
        fs.closeSync(fd)
        throw new InstanceError(`实例 spawn 失败: ${e instanceof Error ? e.message : String(e)}`, {
          hint: '检查 node 可执行与 worktree 权限',
          evidence: { args, logFile },
        })
      }
      fs.closeSync(fd)
      pid = child.pid ?? null
      child.once('exit', (code, signal) => {
        exitInfo = { code, signal, at: Date.now() }
      })
      child.once('error', (e) => {
        exitInfo = { error: e instanceof Error ? e.message : String(e), at: Date.now() }
      })
      child.unref()
      // 实例元数据（验收辅助信息，非产品数据）：让只拿到 --data-dir 的调用方
      // （vp.mjs / 人工复检）能还原实例名 → 端口派生与 doctor 判定同源。
      try {
        fs.writeFileSync(
          path.join(dir, 'verify-instance.json'),
          `${JSON.stringify(
            {
              instanceName,
              repo,
              vitePort: parsed?.vitePort ?? 0,
              cdpPort: parsed?.cdpPort ?? 0,
              runtimePortRange: parsed?.runtimePortRange ?? null,
              pid,
              launchedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          'utf8',
        )
      } catch {
        /* 元数据写失败不阻塞启动 */
      }
      state = 'launched'
      return api.info()
    },

    info() {
      return {
        pid,
        vitePort: parsed?.vitePort ?? 0,
        cdpPort: parsed?.cdpPort ?? 0,
        runtimePort: readRuntimePort(parsed?.dataDir ?? ''),
        runtimePortRange: parsed?.runtimePortRange ?? null,
        dataDir: parsed?.dataDir ?? '',
        instanceName: parsed?.instanceName ?? instanceName,
        logFile,
      }
    },

    /**
     * 三条就绪判据 + 明细（condition poll，超时抛带 hint 的错）。
     * @returns {Promise<{ok:boolean,elapsedMs:number,conditions:Array,runtimePort:number,extensions:number}>}
     */
    async waitReady(opts = {}) {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
      const minExtensions = opts.minExtensions ?? EXT_READY_MIN_COUNT
      ensureParams()
      const startedAt = Date.now()
      const dir = parsed.dataDir
      const conditions = [
        { name: 'runtime.port', ok: false, detail: '' },
        { name: 'cdp.page', ok: false, detail: '' },
        { name: 'extensions', ok: false, detail: '' },
      ]
      const ok = await pollUntil(
        async () => {
          // ① runtime.port + token + 可连
          const portFile = path.join(dir, 'runtime.port')
          const tokenFile = path.join(dir, 'runtime-token')
          const port = readRuntimePort(dir)
          const hasToken = fs.existsSync(tokenFile) && fs.readFileSync(tokenFile, 'utf8').trim().length > 0
          conditions[0] = {
            name: 'runtime.port',
            ok: port > 0 && hasToken && (await canConnect(port)),
            detail: `port=${port || '缺'} token=${hasToken ? '在' : '缺'}`,
          }
          // ② CDP 页面 URL 归属本实例 vitePort（防连错实例看旧代码）
          const pages = await cdpPages(parsed.cdpPort)
          const mine = Array.isArray(pages) ? pages.filter((p) => String(p.url ?? '').includes(`:${parsed.vitePort}`)) : []
          conditions[1] = {
            name: 'cdp.page',
            ok: mine.length > 0,
            detail: Array.isArray(pages) ? `pages=${pages.length} mine=${mine.length} urls=${pages.map((p) => p.url).join('|').slice(0, 200)}` : 'CDP 不可达',
          }
          // ③ 扩展装载完成
          const ext = resolvedExtensionCount(dir)
          conditions[2] = {
            name: 'extensions',
            ok: ext.seen && ext.count >= minExtensions,
            detail: ext.seen ? `resolved ${ext.count} extensions from ${ext.sources} sources` : '尚无 "resolved N extensions"',
          }
          return conditions.every((c) => c.ok)
        },
        { timeoutMs },
      )
      const report = {
        ok: Boolean(ok),
        elapsedMs: Date.now() - startedAt,
        conditions,
        runtimePort: readRuntimePort(dir),
        extensions: resolvedExtensionCount(dir).count,
        pid,
        exitInfo,
      }
      readyReport = report
      if (!ok) {
        throw new InstanceError(
          `实例未在 ${timeoutMs}ms 内就绪（第 ${conditions.findIndex((c) => !c.ok) + 1} 项未过）`,
          {
            hint: '看 evidence.logTail（装配日志尾）与 <dataDir>/logs/runtime-*.log；端口被占时换 --name',
            evidence: { conditions, logTail: api.logTail(80), exitInfo, dataDir: dir },
          },
        )
      }
      return report
    },

    /** 委托 doctor.mjs（不重复实现），RED 不抛错（由调用方判 ok）。 */
    async doctor() {
      const script = path.resolve(LIB_DIR, '..', 'doctor.mjs')
      ensureParams()
      const dir = dataDir()
      const args = [script, repo, '--data-dir', dir, '--name', instanceName, '--json']
      const r = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 120_000 })
      let payload = null
      try {
        payload = JSON.parse(r.stdout)
      } catch {
        payload = null
      }
      if (!payload) {
        throw new InstanceError(`doctor 输出不可解析（退出码 ${r.status}）`, {
          hint: '手工跑 node <skill>/scripts/doctor.mjs <repo> --json 看输出',
          evidence: { stdout: String(r.stdout).slice(0, 800), stderr: String(r.stderr).slice(0, 800) },
        })
      }
      return {
        ok: payload.verdict === 'GREEN',
        checks: payload.checks ?? [],
        raw: payload,
        exitCode: r.status,
      }
    },

    /** CDP 连接（幂等）+ 页面归属核对（连错实例 = 抛错，不静默看旧代码）。 */
    async page() {
      if (pageInstance) return pageInstance
      ensureParams()
      const { chromium } = loadPlaywright(repo)
      let browser
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${parsed.cdpPort}`)
      } catch (e) {
        throw new InstanceError(`CDP 连接失败: http://127.0.0.1:${parsed.cdpPort}`, {
          hint: '实例未起或 CDP 端口不对；先跑 instance.waitReady()/doctor',
          evidence: { error: e instanceof Error ? e.message : String(e) },
        })
      }
      const contexts = browser.contexts()
      const pages = contexts.flatMap((c) => c.pages())
      const mine = pages.find((p) => p.url().includes(`:${parsed.vitePort}`))
      if (!mine) {
        await browser.close().catch(() => {})
        throw new InstanceError('连错实例：CDP 页面 URL 不属于本实例 vitePort', {
          hint: `期望页面 URL 含 :${parsed.vitePort}；实际 ${pages.map((p) => p.url()).join(', ').slice(0, 300)}`,
          evidence: { vitePort: parsed.vitePort, cdpPort: parsed.cdpPort, pages: pages.map((p) => p.url()) },
        })
      }
      pageInstance = mine
      pageInstance.__verifyBrowser = browser
      return pageInstance
    },

    /** 协议客户端（幂等；依赖 runtime.port/token）。 */
    async protocol() {
      if (proto) return proto
      ensureParams()
      const { createProtocol } = await import('./protocol.mjs')
      proto = await createProtocol({ dataDir: parsed.dataDir, runtimePort: readRuntimePort(parsed.dataDir) })
      return proto
    },

    /** UI 封装（懒加载 Playwright；需 page）。 */
    async ui() {
      if (uiInstance) return uiInstance
      const { createUI } = await import('./ui.mjs')
      uiInstance = createUI({ page: await api.page(), repo })
      return uiInstance
    },

    /**
     * 释放本实例持有的客户端句柄（CDP browser + 协议 WS）。
     *
     * [M14 修] 旧实现只在 dispose() 里关这些句柄；`stop()` 单独调用（`--keep` 编排 /
     * 只停不删目录的调用方）会留下 Playwright 连接吊住 node 进程（审查 C 实测：
     * stop 后 8s 进程仍存活）。契约 §1.1「stop = 停实例」应当自洽地释放自己开的连接。
     */
    async releaseClients() {
      try {
        if (pageInstance?.__verifyBrowser) await pageInstance.__verifyBrowser.close().catch(() => {})
      } catch {
        /* CDP 断开失败不影响收尾 */
      }
      pageInstance = null
      if (proto) {
        await proto.close().catch(() => {})
        proto = null
      }
    },

    /** 停止实例（SIGTERM 自己起的 PID + 等端口释放；超时给残留 PID 明细）。 */
    async stop(opts = {}) {
      if (state === 'stopped' || state === 'disposed') return
      const timeoutMs = opts.timeoutMs ?? 45_000
      const dir = parsed?.dataDir ?? ''
      const runtimePort = readRuntimePort(dir)
      const ports = [parsed?.vitePort, parsed?.cdpPort, runtimePort].filter((p) => p > 0)
      // mock server 属于本实例的生命周期：stop 也要关（否则调用方只 stop 不 dispose 时
      // 会留一个 listen 中的 HTTP server 吊住进程）；幂等（已关 = no-op）。
      if (mockLlm) {
        try {
          await mockLlm.close()
        } catch {
          /* 关闭失败不阻断 stop */
        }
        mockLlm = null
      }
      if (pid === null) {
        state = 'stopped'
        await releaseClients()
        return
      }
      try {
        process.kill(pid, 'SIGTERM')
      } catch (e) {
        if (e?.code !== 'ESRCH') {
          throw new InstanceError(`kill ${pid} 失败: ${e instanceof Error ? e.message : String(e)}`, {
            hint: '按 PID 手工核对后处置（禁 pkill 宽匹配）',
            evidence: { pid, ports },
          })
        }
      }
      const freed = await pollUntil(
        async () => {
          const portsFree = ports.every((p) => portOwners(p).length === 0)
          const exited = exitInfo !== null || !isAlive(pid)
          return portsFree && exited
        },
        { timeoutMs, intervalMs: 400 },
      )
      if (!freed) {
        const residual = ports
          .map((p) => ({ port: p, pids: portOwners(p) }))
          .filter((x) => x.pids.length > 0)
          .map((x) => `:${x.port} → PID ${x.pids.join(',')}`)
        if (isAlive(pid)) residual.push(`PID ${pid} 仍存活（SIGTERM 未生效）`)
        throw new InstanceError(`端口未在 ${timeoutMs}ms 内释放`, {
          hint: '按残留 PID 逐个核对命令行（只杀自己实例的 PID；禁 pkill）',
          evidence: { residual, pid, logTail: api.logTail(60) },
        })
      }
      await api.releaseClients()
      state = 'stopped'
    },

    /** stop + 删除自建 dataDir（传入的 dataDir 不删；仅 verify-* 前缀自建目录删）。幂等。 */
    async dispose() {
      if (state === 'disposed') return
      let stopError = null
      try {
        await api.stop()
      } catch (e) {
        stopError = e
      }
      await api.releaseClients()
      // mock server 在 stop() 里已关闭（dispose 幂等）；此处不重复 close。
      if (!stopError && selfCreatedDataDir) {
        const dir = parsed?.dataDir ?? ''
        if (path.basename(dir).startsWith('verify-')) {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      }
      state = 'disposed'
      if (stopError) {
        throw new InstanceError('dispose 未完成（进程未停，数据目录保留以便定位）', {
          hint: stopError.hint ?? '见 evidence.residual',
          evidence: stopError.evidence,
        })
      }
    },

    /** 装配日志尾（定位启动失败：presteps / exit 1 文案都在这里）。 */
    logTail(lines = 60) {
      if (!logFile || !fs.existsSync(logFile)) return ''
      const text = fs.readFileSync(logFile, 'utf8')
      return text.split('\n').slice(-lines).join('\n')
    },

    /** 便捷截图（内部转 ui.screenshot）。 */
    async screenshot(name) {
      const ui = await api.ui()
      return ui.screenshot(name)
    },
  }

  return api
}

/** PID 存活（EPERM 也视为存活）。 */
function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

function readRuntimePort(dir) {
  if (!dir) return 0
  const file = path.join(dir, 'runtime.port')
  try {
    const n = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/** Playwright 从 repo 解析（脚本不在 repo 内，裸 import 会失败）。 */
export function loadPlaywright(repo) {
  try {
    return createRequire(path.join(repo, 'package.json'))('playwright')
  } catch (e) {
    throw new InstanceError('无法从 repo 解析 playwright', {
      hint: `在 ${repo} 执行 \`pnpm install\`（playwright 在根 devDependencies）`,
      evidence: { error: e instanceof Error ? e.message : String(e) },
    })
  }
}
