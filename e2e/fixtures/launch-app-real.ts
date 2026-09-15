/**
 * Playwright _electron launch fixture —— REAL 模式（与 launch-app.ts 的 mock 模式对立）。
 *
 * 与 mock 模式的差异：
 * - 不设 VITE_MOCK → renderer bundle（构建期 VITE_MOCK=false/undefined）走 real transport/ws-client
 * - 不设 TAIJI_MOCK → main.ts 启动 runtime（spawn pi 子进程 + WS server）
 * - 保留 TAIJI_E2E=1 → window-factory 跳过 vite 轮询 + loadFile 构建产物 + showInactive
 * - 保留 TAIJI_AGENT_DATA_DIR → 隔离数据目录（临时）
 *
 * faux LLM 轨（L2.5 翻轨，2026-09-15）：`opts.faux` 提供即启用凭证无关装配——
 * 真 Electron 进程树 + 真 pi 子进程 + 真 extension 加载 + 假 LLM（faux 演员）。
 * 注入链（全部经 env 白名单/进程继承透传，零产品代码改动）：
 * - `<dataDir>/agent/settings.json` defaultProvider=faux / defaultModel=faux-1
 *   （过 runtime getDefaultModel 门禁）+ `<dataDir>/agent/models.json` providers.faux
 *   （api:'faux'，pi 侧模型解析；sanitize 校验 apiKey+models 合法保留）
 * - TAIJI_FAUX_SCRIPT（响应脚本 JSON）→ Electron main → runtime → pi 子进程
 *   （RpcClient parentEnv=process.env + buildOutboundChildEnv 不剥 TAIJI_ 前缀）
 * - TAIJI_EXTENSION_PATHS=e2e/fixtures/faux-provider-ext → runtime extension-service
 *   scanUserExtensions → spawn --extension 注入（faux provider 注册 extension 壳）
 * dev 模式下 mandatory 扩展（ask-user/goal/todo/rename-session/scheduler 等 SSOT 见
 * packages/shared/src/mandatory-extensions.json）经 scanBundledExtensions 源码目录自动加载，
 * 无需 npm 目录——凭证无关（不依赖 ~/.taiji-dev 或任何真实 provider 配置）。
 *
 * 注意：real E2E 需要单独 build real renderer bundle（VITE_MOCK 不传），
 * 与 mock bundle 输出冲突（同 renderer/dist）→ mock/real E2E 分批 build + 跑。
 */
import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import WebSocket from 'ws'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_DIR = path.join(REPO_ROOT, 'apps', 'electron')

const requireFromElectronDir = createRequire(path.join(ELECTRON_DIR, 'noop.js'))
const ELECTRON_EXECUTABLE = requireFromElectronDir('electron') as string

/** waitForRuntime 默认超时：pi 子进程 spawn 较慢，给 30s */
const RUNTIME_START_TIMEOUT_MS = 30_000
/** waitForRuntime 轮询 runtime.port 文件的间隔 */
const RUNTIME_PORT_POLL_INTERVAL_MS = 300

// ── faux LLM 轨装配 ─────────────────────────────────────────────────────

/**
 * 声明式响应步骤（同构 pi-fixture.ts 的 ScriptedStep——SSOT 在
 * packages/runtime/src/__tests__/equivalence/pi-fixture.ts，extension 侧读同形态翻译；
 * e2e 不 import runtime 测试文件，两侧靠序列化边界耦合，改动须两侧同步）。
 */
export interface FauxStep {
  thinking?: string
  text?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  stopReason?: 'stop' | 'toolUse' | 'error' | 'aborted'
  error?: string
}

/** faux 轨装配选项 */
export interface FauxOptions {
  /**
   * 响应步骤：统一队列（数组，逐轮 shift 消费）或 model-keyed 对象
   * （{ "provider/id": FauxStep[] }——主/子进程共享脚本按 --model 选队，
   * 形态见 runtime fixtures faux-llm-ext.ts loadScript）。
   */
  responses: FauxStep[] | Record<string, FauxStep[]>
  /** 流控 tokens/s（>0 才生效；竞态窗口类用例用它拉长单响应耗时） */
  tps?: number
}

/** faux 轨 spawn 的固定模型（spawn --model 与 settings.json default 同源） */
export const FAUX_MODEL_REF = 'faux/faux-1'

/** 四演员清单（与 runtime fixtures faux-llm-ext.ts 注册的模型保持一致） */
const FAUX_ACTORS: Array<{ id: string; name: string; reasoning: boolean }> = [
  { id: 'faux-1', name: 'Faux 1 (reasoning off)', reasoning: false },
  { id: 'faux-1-reasoning', name: 'Faux 1 Reasoning (reasoning on)', reasoning: true },
  { id: 'faux-1-b', name: 'Faux 1 B (slot actor)', reasoning: false },
  { id: 'faux-1-c', name: 'Faux 1 C (slot actor)', reasoning: false },
]

/** faux provider 注册 extension 壳目录（TAIJI_EXTENSION_PATHS 注入目标） */
const FAUX_PROVIDER_EXT_DIR = path.join(REPO_ROOT, 'e2e', 'fixtures', 'faux-provider-ext')

/**
 * 预置 faux 轨数据目录：settings.json + models.json + 响应脚本 + 子进程注入面
 * （见文件头「注入链」）。settings/models 落 <dataDir>/agent/（runtime pi-paths
 * getPiAgentDir = <dataDir>/agent，同时是 RpcClient 注入 pi 的 PI_CODING_AGENT_DIR
 * ——runtime 门禁与 pi 模型解析同源）。
 *
 * 子进程注入面（workflow agent() / subagent 的 pi 孙进程）：
 * - extensions/faux-llm-ext.ts 复制：协议化引擎的 argv-mirror 读引擎自身 argv（无
 *   主 pi 的显式 --extension），孙进程拿不到 TAIJI_EXTENSION_PATHS 注入——经
 *   <agentDir>/extensions/ 自动发现装载（先例 scripts/probes/subagent-sync-collect）。
 *   主 pi 带 --no-extensions 不受自动发现影响（显式注入不受抑制）。
 * - subagents/config.json（L3 引擎注册）：workflow 域 agent() 走引擎 registry，
 *   pi 引擎 cli descriptor 需显式注册（command=node + pi-subagent-cli bin）。
 *   TAIJI_FAUX_SCRIPT env 经 shared buildOutboundChildEnv 白名单透传到孙进程。
 */
function seedFauxDataDir(dataDir: string, faux: FauxOptions): { scriptPath: string } {
  const JSON_INDENT = 2
  const agentDir = path.join(dataDir, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'faux',
    defaultModel: 'faux-1',
    enabledModels: FAUX_ACTORS.map((a) => `faux/${a.id}`),
    retry: { enabled: false },
  }, null, JSON_INDENT))
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      faux: {
        name: 'faux',
        api: 'faux',
        apiKey: 'not-needed',
        models: FAUX_ACTORS.map((a) => ({
          id: a.id,
          name: a.name,
          reasoning: a.reasoning,
          input: ['text'],
          contextWindow: 128_000,
          maxTokens: 16_384,
        })),
      },
    },
  }, null, JSON_INDENT))
  const scriptPath = path.join(agentDir, 'faux-responses.json')
  fs.writeFileSync(scriptPath, JSON.stringify(faux.responses))
  // pi 孙进程自动发现装载 faux extension（子进程 --extension 镜像断链的既定绕法）
  const extDir = path.join(agentDir, 'extensions')
  fs.mkdirSync(extDir, { recursive: true })
  fs.copyFileSync(
    path.join(REPO_ROOT, 'packages', 'runtime', 'src', '__tests__', 'fixtures', 'faux-llm-ext.ts'),
    path.join(extDir, 'faux-llm-ext.ts'),
  )
  // L3 引擎注册（workflow 域 agent() 走 registry）
  const subagentsDir = path.join(agentDir, 'subagents')
  fs.mkdirSync(subagentsDir, { recursive: true })
  fs.writeFileSync(path.join(subagentsDir, 'config.json'), JSON.stringify({
    engines: {
      pi: {
        command: process.execPath,
        args: [path.join(REPO_ROOT, 'packages', 'pi-subagent-cli', 'bin', 'pi-subagent-cli.mjs')],
        enabled: true,
      },
    },
  }, null, JSON_INDENT))
  return { scriptPath }
}

export interface RealLaunchOptions {
  /** 覆盖数据目录（默认每次临时目录）；用于「重启」场景复用同一目录 */
  dataDir?: string
  /** faux LLM 轨装配（提供即启用；凭证无关） */
  faux?: FauxOptions
}

/**
 * 启动 REAL 模式 TaiJi（runtime + real renderer bundle）。
 *
 * @returns app + page + cleanup + dataDir（供重启场景复用）
 */
export async function launchRealApp(opts: RealLaunchOptions = {}): Promise<{
  app: ElectronApplication
  page: Page
  dataDir: string
  cleanup: () => Promise<void>
}> {
  // 复用传入 dataDir（重启场景）或新建临时目录
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-real-'))
  fs.mkdirSync(dataDir, { recursive: true })
  // 清 stale runtime.port：复用 dataDir 的重启场景里，上一次 app 关闭后残留的 port 文件
  // 会让 waitForRuntime 立即返回旧值，而新 runtime 尚未 spawn（ECONNREFUSED 时序坑）
  fs.rmSync(path.join(dataDir, 'runtime.port'), { force: true })
  lastLaunchedDataDir = dataDir

  const fauxEnv: Record<string, string> = {}
  if (opts.faux) {
    const { scriptPath } = seedFauxDataDir(dataDir, opts.faux)
    fauxEnv.TAIJI_FAUX_SCRIPT = scriptPath
    if (opts.faux.tps && opts.faux.tps > 0) fauxEnv.TAIJI_FAUX_TPS = String(opts.faux.tps)
    fauxEnv.TAIJI_EXTENSION_PATHS = FAUX_PROVIDER_EXT_DIR
  }

  const app = await electron.launch({
    executablePath: ELECTRON_EXECUTABLE,
    cwd: ELECTRON_DIR,
    env: {
      ...process.env,
      // 不设 VITE_MOCK（renderer 已 real bundle）+ 不设 TAIJI_MOCK（启动 runtime）
      TAIJI_E2E: '1',
      TAIJI_AGENT_DATA_DIR: dataDir,
      ...fauxEnv,
    },
    args: ['.'],
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const cleanup = async (): Promise<void> => {
    try {
      await app.close()
    } finally {
      // 仅清理自建的临时目录（opts.dataDir 传入的由调用方管理）
      if (!opts.dataDir) {
        fs.rmSync(dataDir, { recursive: true, force: true })
      }
    }
  }

  return { app, page, dataDir, cleanup }
}

/**
 * 等 runtime 健康（runtime.port 文件出现 = spawn + waitForHealth + writePortFile 全通过）。
 * @param dataDir 数据目录（runtime.port 所在）
 * @param timeoutMs 默认 30s（pi 子进程 spawn 较慢）
 */
export async function waitForRuntime(dataDir: string, timeoutMs = RUNTIME_START_TIMEOUT_MS): Promise<number> {
  const portFile = path.join(dataDir, 'runtime.port')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const port = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10)
      if (port > 0) return port
    }
    await new Promise((r) => setTimeout(r, RUNTIME_PORT_POLL_INTERVAL_MS))
  }
  throw new Error(`runtime.port not found in ${dataDir} within ${timeoutMs}ms — runtime failed to start`)
}

// ── real 轨共享 helper（各 spec 原自带同款副本，L2.5 翻轨收口到 fixture 层） ──

/**
 * 打开 WS 并完成 auth 握手（S1-W1 契约：连接后首条消息必须是 {type:'auth'}，token =
 * <dataDir>/runtime-token——main spawn runtime 时写入，轮询等文件出现）。auth 失败直接
 * 抛错（token 文件缺失 = runtime 未起或装配断链，fail-fast）。
 */
/** runtime WS 帧最小面（e2e 只消费 type/id/payload；更深结构由调用方按需收窄） */
export interface WsFrame {
  id?: string
  type?: string
  payload?: Record<string, unknown>
}

/** auth 握手与轮询的节奏常量 */
const AUTH_TIMEOUT_MS = 15_000
const TOKEN_POLL_INTERVAL_MS = 300
const ROUND_TRIP_TIMEOUT_MS = 30_000
const KEEPALIVE_INTERVAL_MS = 20_000
const EXT_READY_TIMEOUT_MS = 90_000
const EXT_READY_MIN_COUNT = 8
const EXT_READY_POLL_INTERVAL_MS = 1000

async function openAuthedWs(port: number, dataDir: string, timeoutMs = AUTH_TIMEOUT_MS): Promise<WebSocket> {
  const tokenFile = path.join(dataDir, 'runtime-token')
  const deadline = Date.now() + timeoutMs
  let token: string | null = null
  while (Date.now() < deadline) {
    try {
      token = fs.readFileSync(tokenFile, 'utf-8').trim()
      if (token) break
    } catch {
      // best-effort 轮询：runtime-token 未写入属预期慢路径，超时统一由 deadline 兜底
      console.warn('[launch-real] runtime-token not ready yet, retrying')
    }
    await new Promise((r) => setTimeout(r, TOKEN_POLL_INTERVAL_MS))
  }
  if (!token) throw new Error(`runtime-token not found in ${dataDir} within ${timeoutMs}ms`)
  const ws: WebSocket = await new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('WS auth handshake timeout')), timeoutMs)
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString())
      if (m.type === 'auth.result') {
        clearTimeout(to)
        if (m.payload?.ok === true) resolve()
        else reject(new Error(`WS auth failed: ${m.payload?.reason ?? 'unknown'}`))
      }
    })
    ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
  })
  return ws
}

/** 连 runtime WS（auth 握手后），发消息，等指定 id 的 reply */
export async function wsRoundTrip(port: number, msg: object, replyId: string, timeoutMs = ROUND_TRIP_TIMEOUT_MS, dataDir?: string): Promise<WsFrame> {
  const ws = await openAuthedWs(port, dataDir ?? guessDataDir(), timeoutMs)
  try {
    return await new Promise<WsFrame>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`WS reply ${replyId} timeout ${timeoutMs}ms`)), timeoutMs)
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString())
        if (m.id === replyId) {
          clearTimeout(to)
          resolve(m)
        }
      })
      ws.send(JSON.stringify(msg))
    })
  } finally {
    ws.close()
  }
}

/**
 * 开第二个 WS 专门监听广播事件（无 id 的消息），返回 { ws, events }。
 *
 * @param sessionId 提供 session 级事件的订阅目标——runtime MessageBus 是订阅模型
 *   （session.subscribe RPC），不订阅则收不到 session 级广播（message.* / session.*）。
 *   订阅 reply 带 id，不会混入 events。
 * 心跳 keepalive：runtime 45s 无消息断连（HEARTBEAT_TIMEOUT_MS），监听期静默连接会被
 * 周期 config.get（只读 RPC，reply 带 id 不入 events）保活；ws close 时自动停。
 */
export async function openListenWs(port: number, sessionId?: string): Promise<{ ws: WebSocket; events: WsFrame[] }> {
  const ws = await openAuthedWs(port, guessDataDir())
  const events: WsFrame[] = []
  if (sessionId) {
    ws.send(JSON.stringify({ type: 'session.subscribe', id: `sub-${Date.now()}`, payload: { sessionId } }))
  }
  const keepalive = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: 'config.get', id: `ka-${Date.now()}`, payload: {} }))
    } catch {
      // best-effort 保活：ws 已关闭时发送必失败，close handler 已清掉定时器
      console.warn('[launch-real] keepalive config.get send failed (ws closing)')
    }
  }, KEEPALIVE_INTERVAL_MS)
  ws.on('close', () => clearInterval(keepalive))
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString())
      if (!m.id && m.type !== 'auth.result') events.push(m)
    } catch {
      // 非 JSON 帧忽略（心跳等二进制/杂帧），不计入 events
      console.warn('[launch-real] received non-JSON ws frame, ignored')
    }
  })
  return { ws, events }
}

/**
 * 当前 spec 的 dataDir 推导（auth token 定位用）：module 级保存最近一次 launchRealApp
 * 的 dataDir。e2e real 轨每 spec 独立 dataDir，spec 内先 launch 再 WS 直连，module 级
 * 单值够用（workers=1 串行）。
 */
let lastLaunchedDataDir = ''
function guessDataDir(): string {
  if (!lastLaunchedDataDir) throw new Error('launchRealApp 尚未被调用（auth token 需要 dataDir）')
  return lastLaunchedDataDir
}

/** 读 dataDir/logs 下所有 runtime 日志合并成一个字符串（extension load / error 证据源） */
export function readRuntimeLogs(dataDir: string): string {
  const logDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logDir)) return ''
  return fs.readdirSync(logDir)
    .filter((f) => f.startsWith('runtime-'))
    .map((f) => fs.readFileSync(path.join(logDir, f), 'utf8'))
    .join('\n')
}

/** 读 dataDir/logs 下所有 pi stdout jsonl 合并（tool 调用 / 报错证据） */
export function readPiLogs(dataDir: string): string {
  const logDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logDir)) return ''
  return fs.readdirSync(logDir)
    .filter((f) => f.startsWith('pi-') && f.endsWith('.jsonl'))
    .map((f) => fs.readFileSync(path.join(logDir, f), 'utf8'))
    .join('\n')
}

/**
 * 等 runtime 的 extension 注入就绪（resolver 扫到 mandatory 包）。
 *
 * runtime.port 在 ready 时写入，早于 ensureMandatoryExtensions 的 npm 安装（faux 轨
 * dev 装配下 mandatory 扩展走源码目录扫描，无 npm 安装等待，但仍以日志信号确认）。
 * 信号：runtime 日志最后一次 resolved N ≥ minCount。
 */
export async function waitForExtensionsReady(
  dataDir: string,
  timeoutMs = EXT_READY_TIMEOUT_MS,
  minCount = EXT_READY_MIN_COUNT,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const logs = readRuntimeLogs(dataDir)
    const matches = [...logs.matchAll(/resolved (\d+) extensions from \d+ sources/g)]
    if (matches.length > 0) {
      const last = parseInt(matches[matches.length - 1][1], 10)
      if (last >= minCount) return last
    }
    await new Promise((r) => setTimeout(r, EXT_READY_POLL_INTERVAL_MS))
  }
  return 0
}

export const realTest = base.extend<{ electronApp: ElectronApplication; page: Page }>({
  electronApp: async ({}, use) => {
    const { app, cleanup } = await launchRealApp()
    await use(app)
    await cleanup()
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
})

export { expect }
