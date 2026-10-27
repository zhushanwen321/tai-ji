/**
 * lib-conn-datasync —— connection-datasync-ssot（dev-0.11.16-7804efaf）U7 验收剧本共享库。
 *
 * 服务 A1-A7 七个场景剧本（设计 §8 验收场景 + P-3/P-4/P-5 探针）。只提供机制原语
 * （真实数据目录种子 / 冷启动循环 / runtime 进程级操作 / 日志与协议取证 / 侧栏分组
 * DOM 读取），不定义业务断言。
 *
 * 关键事实（源码核对，勿凭示例硬写）：
 * - 快照签发点：spawnRuntimeProcess 与 token 同点签发 runtimeId 并经 env
 *   TAIJI_RUNTIME_ID 注入（apps/electron/main/supervisor/process-control.ts:448）；
 *   auth 成功应答 {ok:true, runtimeId}（packages/runtime/src/transport/connection-manager.ts:294）。
 *   P-3 探针 = 两侧 runtimeId 一致：env 侧经 `ps eww <runtimePid>` 读，应答侧经裸 WS 握手读。
 * - 端口段：dev 实例按实例名 hash 派生 TAIJI_AGENT_PORT_OFFSET（步进 10），
 *   findAvailablePort 从段首起跳、占用者一律跳过不清杀（port-discoverer.ts:235）。
 * - RPC 兜底 65s（packages/core/src/transport/api/pending.ts:38 RPC_BACKSTOP_TIMEOUT_MS）；
 *   存活探针 30s × 3（liveness-probe.ts:28-31）→ forceRestartForLiveness 强杀重启。
 * - 重启退避 1s/2s/4s/8s/16s、上限 5 次（restart-policy.ts）。
 * - 主进程 console（supervisor）与 runtime tee 输出落 <dataDir>/verify-launch.log；
 *   mainLogger（kill decision 等）落 <dataDir>/logs/main-<date>.log。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** 生产数据目录（C-proc-26：非打包进程持 ~/.taiji 树值会被 getDataDir 拒——验收只用其副本）。 */
export const PROD_DATA_DIR = path.join(os.homedir(), '.taiji')

/** session ↔ project 绑定 sidecar 后缀（session-file-utils.ts:265-268：`<sessionFile>.project.json`）。 */
const PROJECT_SIDECAR_SUFFIX = '.project.json'

export class LibError extends Error {
  constructor(message, { hint, evidence } = {}) {
    super(message)
    this.name = 'LibError'
    this.hint = hint
    this.evidence = evidence
  }
}

// ── 轮询 ────────────────────────────────────────────────────────────

/** 条件轮询（禁固定 sleep 后断言）；超时抛带 label 的错。 */
export async function pollUntil(predicate, { timeoutMs = 30_000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new LibError(`轮询超时（${timeoutMs}ms）：${label}`, {
    hint: '看 evidence 与 <dataDir>/logs/（runtime-/main-）与 verify-launch.log 归因',
    evidence: { label, timeoutMs },
  })
}

// ── 真实数据目录种子（生产 projects.json 字节副本 + 少量真实绑定会话） ──

/** 递归列举（node:fs 无 rdfilesync 老 API 兼容形态）。 */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/**
 * 挑选真实绑定会话：每个命名项目至多一条，优先小文件（总字节受控）。
 * @returns {Array<{sessionFile:string, projectId:string}>}
 */
export function pickBoundSessions(prodRoot = PROD_DATA_DIR, { maxSessions = 4, maxTotalBytes = 8_000_000 } = {}) {
  const sessionsRoot = path.join(prodRoot, 'agent', 'sessions')
  if (!fs.existsSync(sessionsRoot)) return []
  const candidates = []
  for (const file of walk(sessionsRoot)) {
    if (!file.endsWith(PROJECT_SIDECAR_SUFFIX)) continue
    const sessionFile = file.slice(0, -PROJECT_SIDECAR_SUFFIX.length)
    if (!fs.existsSync(sessionFile)) continue
    let binding
    try {
      binding = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const projectId = binding?.projectId
    if (typeof projectId !== 'string' || !projectId) continue
    candidates.push({ sessionFile, projectId, bytes: fs.statSync(sessionFile).size })
  }
  candidates.sort((a, b) => a.bytes - b.bytes)
  const picked = []
  const seenProjects = new Set()
  let total = 0
  for (const c of candidates) {
    if (picked.length >= maxSessions) break
    if (seenProjects.has(c.projectId)) continue
    if (total + c.bytes > maxTotalBytes) continue
    seenProjects.add(c.projectId)
    total += c.bytes
    picked.push({ sessionFile: c.sessionFile, projectId: c.projectId })
  }
  return picked
}

/**
 * 把「真实数据目录形态」种子进验收实例数据目录：
 * - projects.json 字节级副本（存量无 revision 形态 = P-4 读侧前提；模板种子已写入的
 *   实例文件被覆盖——首启期间 app 可能已落默认表，种子必须在停实例后覆写）；
 * - 每个命名项目一条真实会话（jsonl + 全部 sidecar：.project.json 等）。
 * 幂等：会话文件已存在则跳过（冷启动多轮不重复拷贝）。返回种子摘要。
 */
export function seedRealisticDataDir(dataDir, options = {}) {
  const prodRoot = options.prodRoot ?? PROD_DATA_DIR
  const summary = { projectsJson: false, projectsJsonOverwritten: false, sessions: [] }
  const prodProjects = path.join(prodRoot, 'projects.json')
  const destProjects = path.join(dataDir, 'projects.json')
  if (!fs.existsSync(prodProjects)) {
    throw new LibError(`生产 projects.json 不存在：${prodProjects}`, {
      hint: '本机无 ~/.taiji 生产数据时改用受控 fixture（projects.json + 自建 session sidecar）',
    })
  }
  if (fs.existsSync(destProjects)) summary.projectsJsonOverwritten = true
  fs.copyFileSync(prodProjects, destProjects)
  summary.projectsJson = true
  const picked = pickBoundSessions(prodRoot, options)
  const destSessionsRoot = path.join(dataDir, 'agent', 'sessions')
  for (const { sessionFile, projectId } of picked) {
    const rel = path.relative(path.join(prodRoot, 'agent', 'sessions'), sessionFile)
    const dest = path.join(destSessionsRoot, rel)
    if (fs.existsSync(dest)) continue
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(sessionFile, dest)
    // sidecar 家族（.project.json / .preset.json / .agent.json …）同批拷贝
    const sidecars = walk(path.dirname(sessionFile)).filter(
      (f) => f.startsWith(sessionFile) && f !== sessionFile,
    )
    for (const sc of sidecars) {
      fs.copyFileSync(sc, path.join(path.dirname(dest), path.basename(sc)))
    }
    summary.sessions.push({ projectId, file: rel })
  }
  return summary
}

// ── runtime 进程级操作 ──────────────────────────────────────────────

/** 读 runtime.port 文件。 */
export function readRuntimePort(dataDir) {
  try {
    const n = Number.parseInt(fs.readFileSync(path.join(dataDir, 'runtime.port'), 'utf8').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/** lsof 端口占用者 PID 列表。 */
export function portOwners(port) {
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`, '-P'], { encoding: 'utf8', timeout: 10_000 })
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

/**
 * runtime 进程 PID：LISTEN 状态持有者（-sTCP:LISTEN 排除 renderer 的 ESTABLISHED
 * 连接——不筛会把 Electron 进程当 runtime），并经 cmdline 运行时指纹二次核对。
 */
export function runtimePidOf(dataDir) {
  const port = readRuntimePort(dataDir)
  if (!port) return null
  let pids = []
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`, '-P', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 10_000 })
    pids = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return null
  }
  for (const pid of pids) {
    try {
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10_000 })
      if (cmd.includes('--builtin-plugins-dir=')) return pid
    } catch {
      /* 进程已退出：看下一个候选 */
    }
  }
  return pids.length > 0 ? pids[0] : null
}

/** `ps eww` 环境变量解析（macOS；自己的进程可读）。 */
export function runtimeEnvOf(pid) {
  const out = execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 })
  const env = new Map()
  for (const token of out.split(/\s+/)) {
    const eq = token.indexOf('=')
    if (eq <= 0) continue
    env.set(token.slice(0, eq), token.slice(eq + 1))
  }
  return env
}

/** 信号发送（ESRCH 视为已完成）。 */
export function signalPid(pid, signal) {
  try {
    process.kill(pid, signal)
    return true
  } catch (e) {
    if (e?.code === 'ESRCH') return false
    throw new LibError(`kill ${pid} ${signal} 失败: ${e instanceof Error ? e.message : String(e)}`, {
      hint: '按 PID 核对进程归属后处置（禁 pkill 宽匹配）',
      evidence: { pid, signal },
    })
  }
}

/** 进程存活判定（EPERM 视为存活）。 */
export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/**
 * 裸 WS 握手：返回 auth.result payload（P-3 的 runtime 侧证据）。
 * Node ≥22 全局 WebSocket；不经 protocol lib（它消费掉 auth.result 不透出 payload）。
 */
export async function authEcho(dataDir, port, { timeoutMs = 15_000 } = {}) {
  const token = fs.readFileSync(path.join(dataDir, 'runtime-token'), 'utf8').trim()
  if (!token) throw new LibError('runtime-token 缺失', { hint: '实例未就绪；先 waitReady', evidence: { dataDir } })
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close() } catch { /* ignore */ }
      reject(new LibError(`auth 握手超时（${timeoutMs}ms）`, { hint: 'runtime 未起或端口错', evidence: { port } }))
    }, timeoutMs)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
    })
    ws.addEventListener('message', (ev) => {
      let frame
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
      } catch {
        return
      }
      if (frame?.type !== 'auth.result') return
      clearTimeout(timer)
      try { ws.close() } catch { /* ignore */ }
      resolve(frame.payload ?? {})
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new LibError('auth WS 连接失败', { hint: `确认 runtime 在 127.0.0.1:${port} 监听`, evidence: { port } }))
    })
  })
}

// ── 日志读取 ────────────────────────────────────────────────────────

function latestFile(dir, prefix) {
  if (!fs.existsSync(dir)) return null
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return files.length > 0 ? path.join(dir, files[0].f) : null
}

/** 装配器日志（主进程 console + runtime tee 输出）。 */
export function readLaunchLog(dataDir) {
  const file = path.join(dataDir, 'verify-launch.log')
  if (!fs.existsSync(file)) return ''
  return fs.readFileSync(file, 'utf8')
}

/** runtime 自身日志（logs/runtime-*.log）。 */
export function readRuntimeLog(dataDir) {
  const file = latestFile(path.join(dataDir, 'logs'), 'runtime-')
  return file ? fs.readFileSync(file, 'utf8') : ''
}

/** mainLogger 日志（logs/main-*.log：kill decision / port-cleanup 等）。 */
export function readMainLog(dataDir) {
  const file = latestFile(path.join(dataDir, 'logs'), 'main-')
  return file ? fs.readFileSync(file, 'utf8') : ''
}

/** renderer console 转发日志（logs/renderer-console-*.log）。 */
export function readRendererConsole(dataDir) {
  const file = latestFile(path.join(dataDir, 'logs'), 'renderer-console-')
  return file ? fs.readFileSync(file, 'utf8') : ''
}

// ── supervisor 快照读口（P-3 签发侧证据） ───────────────────────────

/**
 * supervisor 签发的目标快照（P-3 的签发侧权威证据）：经 preload electronAPI
 * .getRuntimeTargetSnapshot（bridge-handlers GET_RUNTIME_TARGET_SNAPSHOT →
 * supervisor.currentSnapshot）在 renderer 页面上下文读取。
 * @returns {Promise<{seq:number, runtimeId:string, port:number, token:string}|null>}
 */
export async function supervisorSnapshot(page) {
  return page.evaluate(async () => {
    const api = window.electronAPI
    if (!api?.getRuntimeTargetSnapshot) return null
    const snap = await api.getRuntimeTargetSnapshot()
    return snap ?? null
  })
}

// ── 侧栏分组 DOM 读取 ──────────────────────────────────────────────

/**
 * 读取侧栏命名项目分组（project-group × data-project-id + 组头名 + 计数）。
 * 只读 DOM，不依赖内部 store——A 通道用户可见面。
 */
export async function readSidebarGroups(page) {
  return page.$$eval('[data-testid="project-group"]', (nodes) =>
    nodes.map((n) => ({
      projectId: n.getAttribute('data-project-id') ?? '',
      current: n.getAttribute('data-current') === 'true',
      name: (n.querySelector('[data-testid="project-group-toggle"]')?.getAttribute('aria-label') ?? '').trim(),
      count: Number(n.querySelector('[data-testid="project-group-count"]')?.textContent?.trim() ?? '0'),
    })),
  )
}

/** 等侧栏分组渲染（命名组数 ≥ minGroups）。 */
export async function waitForSidebarGroups(page, { minGroups = 1, timeoutMs = 60_000, label = '侧栏分组渲染' } = {}) {
  return pollUntil(
    async () => {
      const groups = await readSidebarGroups(page)
      return groups.length >= minGroups ? groups : null
    },
    { timeoutMs, label },
  )
}

/** body innerHTML 条件轮询（同 p1-disconnect-selfheal 口径）。 */
export async function pollBodyHtml(page, needle, { timeoutMs = 30_000, intervalMs = 400, wantPresent = true } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = ''
  while (Date.now() < deadline) {
    html = await page.evaluate(() => document.body.innerHTML)
    if (html.includes(needle) === wantPresent) return html
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return html
}

/** testid 元素计数（0 = 不在 DOM）。 */
export async function countTestId(page, testId) {
  return page.locator(`[data-testid="${testId}"]`).count()
}

// ── 端口预占（A2：无关进程占用段首端口） ───────────────────────────

/**
 * 以无关进程监听指定端口（ detached node TCP server，只 accept 不响应）。
 * @returns {{pid:number, release:()=>void}}
 */
export function occupyPort(port) {
  const script = `
    const net = require('node:net')
    const srv = net.createServer(() => {})
    srv.listen(${port}, '127.0.0.1', () => { process.stdout.write('listening') })
    setInterval(() => {}, 60000)
  `
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' })
  child.unref()
  return {
    pid: child.pid,
    release() {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try { process.kill(child.pid, 'SIGKILL') } catch { /* already gone */ }
      }
    },
  }
}

// ── 磁盘取证 ────────────────────────────────────────────────────────

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ── dev 实例端口段派生（A2 预占目标） ──────────────────────────────

/** 按实例名派生 runtime 端口段（与 dev-instance-lib deriveParams 同源，动态 import）。 */
export async function asyncRuntimePortRange(repo, instanceName) {
  const mod = await import(pathToFileURL(path.join(repo, 'apps', 'electron', 'scripts', 'dev-instance-lib.mjs')).href)
  const p = mod.deriveParams(instanceName)
  return { start: 3210 + p.portOffset, end: 3210 + p.portOffset + 9, portOffset: p.portOffset }
}
