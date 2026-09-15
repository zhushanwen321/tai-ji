#!/usr/bin/env node
/**
 * dev 启动期冒烟闸门（W1 dev-smoke-gate）。
 *
 * 目标：堵 MOCK 轨 E2E 盲区——dev 启动期崩溃（CSS 变量引用错 / Tailwind 类名错 /
 * import 路径错 / style.css 语法错 / Vue template compile 错）。这些崩溃在「只跑
 * MOCK 轨 E2E」时不会被触发（MOCK 轨依赖 build 产物，绕过 vite dev serve），
 * 也不被现有 vitest 单测覆盖（单测不挂载完整 AppShell）。
 *
 * 机制：VITE_MOCK=true spawn vite dev server（只起 vite，不起 electron）→ 轮询
 * localhost:1420 ready → Playwright chromium 连接 → 双通道抓错误 → 断言关键
 * 挂载点 → try/finally cleanup。
 *
 * 双通道错误捕获（任一非空即 fail）：
 *   (A) vite 子进程输出（stdout+stderr）逐行正则匹配编译期错误 pattern
 *       （[vite] Internal Server Error / Module not found / Build failed /
 *        [vue/compiler] / SyntaxError / Pre-transform error / Failed to resolve import）
 *   (B) page.on('console') type=error（经 ignorePatterns 过滤已知噪声）+
 *       page.on('pageerror') 未捕获异常（无白名单，确定性失败）
 *
 * exit code：
 *   0 = ok（零 error + 挂载点全存在）
 *   1 = 有 error（console/pageerror/编译 pattern 非空 或 挂载点缺失）
 *   2 = dev server 启动超时（readyTimeout 内 url 未 ready）
 *   3 = chromium launch 失败（二进制缺失，提示 npx playwright install chromium）
 *
 * 用法：
 *   node scripts/dev-smoke.mjs [--port 1420] [--ready-timeout 60000] [--settle 3000]
 *   pnpm dev:smoke   （根 package.json 暴露的便捷入口）
 *
 * 本脚本自管理完整生命周期（spawn → poll → launch → assert → cleanup），
 * 不依赖外部已启动的 dev server。VITE_MOCK 经 spawn 子进程 env 注入，不污染调用方 shell。
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

// ---------------------------------------------------------------------------
// 默认值（与 parent slice IF1/DM1 契约一致）
// ---------------------------------------------------------------------------
const DEFAULT_DEV_CMD = 'pnpm --filter @taiji/frontend run dev'
const DEFAULT_PORT = 1420
const DEFAULT_READY_TIMEOUT = 60000
const DEFAULT_CONSOLE_SETTLE_MS = 3000
const DEFAULT_MOUNT_SELECTORS = ['#app', '.app-shell']

// vite 输出命中即视为编译期错误（ERR4）。同时扫 stdout + stderr——vite logger
// 默认把 [vite] Internal Server Error / Pre-transform error 打 stdout，纯 stderr
// 监听会漏报。
const VITE_COMPILE_PATTERNS = [
  /\[vite\]\s+Internal Server Error/i,
  /Module not found/i,
  /Build failed/i,
  /\[vue\/compiler\]/i,
  /\bSyntaxError\b/,
  /Pre-transform error/i,
  /Failed to resolve import/i,
]

// 已知运行时噪声白名单（TASK-BASELINE 跑干净基线后确定，仅过滤 console type=error，
// 不影响 pageerror）。VITE_MOCK=true 下 renderer 自洽，预期接近空。
const DEFAULT_IGNORE_PATTERNS = [
  // 基线跑出噪声后在此回填，例如残留的 electronAPI 访问警告：
  // /electronAPI/,
]

// 轮询间隔
const POLL_INTERVAL_MS = 500
// dev 子进程退出宽限（SIGTERM 后等多久再 SIGKILL 兜底）
const KILL_GRACE_MS = 2000

// ---------------------------------------------------------------------------
// SmokeOptions / SmokeResult（JSDoc 形式，.mjs 无 TS；契约见 parent slice DM1/DM2）
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SmokeOptions
 * @property {string} [devCmd]        启动 dev server 的命令（shell 字符串）
 * @property {number} [port]          vite dev server 端口（默认 1420，strictPort）
 * @property {number} [readyTimeout]  轮询 ready 的总超时 ms（默认 60000）
 * @property {number} [consoleSettleMs] ready 后等待静默窗口 ms（默认 3000）
 * @property {string[]} [mountSelectors] 必须可见的关键 DOM 挂载点 selector
 * @property {RegExp[]} [ignorePatterns] 已知运行时噪声白名单（仅过滤 console error）
 */

/**
 * @typedef {Object} SmokeResult
 * @property {boolean} ok
 * @property {string[]} stderrErrors   vite 输出命中编译 pattern 的行
 * @property {string[]} consoleErrors  console type=error（过滤白名单后）
 * @property {string[]} pageErrors     pageerror 未捕获异常（无白名单）
 * @property {string[]} missingMounts  未在超时内可见的 selector
 * @property {number} readyMs          dev server ready 耗时 ms（失败时为 readyTimeout）
 * @property {0|1|2|3} exitCode        退出码
 * @property {string} [detail]         失败时的诊断信息（如 ready 超时附 stderr 尾部）
 */

// ---------------------------------------------------------------------------
// 核心实现
// ---------------------------------------------------------------------------

/**
 * 解析 options 默认值并推导 url（纯函数；主流程只做编排）。
 * @param {SmokeOptions} options
 */
function resolveSmokeOptions(options) {
  const port = options.port ?? DEFAULT_PORT
  return {
    devCmd: options.devCmd ?? DEFAULT_DEV_CMD,
    url: `http://localhost:${port}`,
    readyTimeout: options.readyTimeout ?? DEFAULT_READY_TIMEOUT,
    consoleSettleMs: options.consoleSettleMs ?? DEFAULT_CONSOLE_SETTLE_MS,
    mountSelectors: options.mountSelectors ?? DEFAULT_MOUNT_SELECTORS,
    ignorePatterns: options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
  }
}

/**
 * 单个 chunk 的行级收集：保留全部非空行进 outputLines（超时诊断取尾部），
 * 命中 vite 编译 pattern 的行进 stderrErrors。
 */
function collectChunkLines(text, { outputLines, stderrErrors }) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    outputLines.push(line)
    if (VITE_COMPILE_PATTERNS.some((p) => p.test(trimmed))) {
      stderrErrors.push(trimmed)
    }
  }
}

/**
 * spawn dev server（VITE_MOCK 经子进程 env 注入）并挂 stdout/stderr 双流收集 +
 * spawn error 监听。返回 ChildProcess。
 * @param {string} devCmd
 * @param {{ outputLines: string[], stderrErrors: string[] }} sinks
 */
function spawnDevServer(devCmd, sinks) {
  const child = spawn(devCmd, {
    shell: true,
    env: { ...process.env, VITE_MOCK: 'true' },
    cwd: process.cwd(),
  })
  const onChunk = (chunk) => collectChunkLines(chunk.toString(), sinks)
  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)
  child.on('error', (err) => {
    // spawn 本身失败（如命令不存在）
    sinks.stderrErrors.push(`[dev-smoke] spawn error: ${err.message}`)
  })
  return child
}

/**
 * ready 失败（超时 / child 提前退出）→ exit 2 结果（detail 附 vite 输出尾部诊断）。
 */
function makeReadyTimeoutResult({ url, readyTimeout, readyReason, child, sinks, consoleErrors, pageErrors, missingMounts }) {
  const tail = sinks.outputLines.slice(-50).join('\n')
  const reason = readyReason === 'child-exited'
    ? `spawn 的 dev server 提前退出（exitCode=${child.exitCode} signalCode=${child.signalCode}）—— 常见原因：${DEFAULT_PORT} 端口被占（vite strictPort 退出）/ 命令错 / 依赖未装`
    : `${url} 在 ${readyTimeout}ms 内未 ready`
  return makeResult({
    exitCode: 2,
    stderrErrors: sinks.stderrErrors,
    consoleErrors,
    pageErrors,
    missingMounts,
    readyMs: readyTimeout,
    detail: `DEV_SERVER_READY_TIMEOUT: ${reason}。vite 输出尾部:\n${tail}`,
  })
}

/**
 * 注册 page 双通道错误监听：console type=error（经 ignorePatterns 过滤已知噪声）+
 * pageerror 未捕获异常（无白名单，确定性失败）。
 */
function attachPageErrorListeners(page, { consoleErrors, pageErrors, ignorePatterns }) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      if (!ignorePatterns.some((p) => p.test(text))) {
        consoleErrors.push(text)
      }
    }
  })
  page.on('pageerror', (err) => {
    pageErrors.push(err.stack ? `${err.name}: ${err.message}\n${err.stack}` : String(err))
  })
}

/**
 * 逐个断言挂载点可见（waitForSelector 超时的 selector 记入 missingMounts，不中断后续）。
 * waitForSelector 给 consoleSettleMs + 缓冲，足够 vite 按需编译 + Vue mount。
 */
async function assertMountsVisible(page, mountSelectors, mountTimeout, missingMounts) {
  for (const sel of mountSelectors) {
    try {
      await page.waitForSelector(sel, { state: 'visible', timeout: mountTimeout })
    } catch {
      missingMounts.push(sel)
    }
  }
}

/**
 * 运行 dev 冒烟闸门。
 * @param {SmokeOptions} [options]
 * @returns {Promise<SmokeResult>}
 */
export async function runSmoke(options = {}) {
  const { devCmd, url, readyTimeout, consoleSettleMs, mountSelectors, ignorePatterns } =
    resolveSmokeOptions(options)

  /** @type {string[]} */
  const stderrErrors = []
  /** @type {string[]} */
  const consoleErrors = []
  /** @type {string[]} */
  const pageErrors = []
  /** @type {string[]} */
  const missingMounts = []
  // 保留全部 vite 输出行，超时诊断时取尾部
  const outputLines = []
  const sinks = { outputLines, stderrErrors }

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  /** @type {import('@playwright/test').Browser | null} */
  let browser = null

  try {
    // ---- (1) spawn dev server（VITE_MOCK 经子进程 env 注入）----
    child = spawnDevServer(devCmd, sinks)

    // ---- (2) 轮询 dev server ready（ECONNREFUSED 继续轮询；child 退出立即判失败，
    //      避免连到 1420 上可能已存在的别的 dev 实例导致假结果；超时则 exit 2）----
    const ready = await pollReady(url, readyTimeout, child)
    if (!ready.ok) {
      return makeReadyTimeoutResult({ url, readyTimeout, readyReason: ready.reason, child, sinks, consoleErrors, pageErrors, missingMounts })
    }
    const readyMs = ready.ms

    // ---- (3) chromium launch（失败 exit 3）----
    try {
      browser = await chromium.launch()
    } catch (e) {
      return makeResult({
        exitCode: 3,
        stderrErrors,
        consoleErrors,
        pageErrors,
        missingMounts,
        readyMs,
        detail: `CHROMIUM_LAUNCH_FAILED: ${e.message}\n提示: npx playwright install chromium`,
      })
    }

    // ---- (4) 注册 page 监听 + goto ----
    const page = await browser.newPage()
    attachPageErrorListeners(page, { consoleErrors, pageErrors, ignorePatterns })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: readyTimeout })

    // ---- (5) 断言挂载点可见 ----
    await assertMountsVisible(page, mountSelectors, consoleSettleMs + 5000, missingMounts)

    // ---- (6) settle 静默窗口（收集 mount 后异步产生的 error）----
    await sleep(consoleSettleMs)

    // ---- 判定 ----
    const ok =
      stderrErrors.length === 0 &&
      consoleErrors.length === 0 &&
      pageErrors.length === 0 &&
      missingMounts.length === 0
    return makeResult({
      exitCode: ok ? 0 : 1,
      stderrErrors,
      consoleErrors,
      pageErrors,
      missingMounts,
      readyMs,
    })
  } finally {
    // ---- cleanup：任意退出路径都释放 browser + dev 子进程 ----
    if (browser) {
      await browser.close().catch(() => {})
    }
    await killProcess(child, KILL_GRACE_MS)
  }
}

/**
 * 轮询 url 直到返回响应（200/3xx/4xx 均算 ready，仅 ECONNREFUSED/超时算未 ready）。
 * 若传入的 child 在轮询期间退出，立即判定失败（spawn 的 server 没活着，
 * 避免连到端口上可能已存在的别的 server）。
 * @returns {Promise<{ok: true, ms: number} | {ok: false, reason: 'timeout'|'child-exited'}>}
 */
async function pollReady(url, timeout, child) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (child && child.exitCode !== null) {
      return { ok: false, reason: 'child-exited' }
    }
    try {
      const res = await fetch(url, { method: 'GET' })
      // 任何 HTTP 响应都说明 server 在 listen（含 404/500 这种应用层错误也算 ready，
      // 应用层错误会经双通道捕获，不在此判定）
      if (res.status < 500) return { ok: true, ms: Date.now() - start }
    } catch {
      // ECONNREFUSED / socket hang up → 还没 ready，继续轮询
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return { ok: false, reason: 'timeout' }
}

/**
 * 发 SIGTERM，等 graceMs 未退则 SIGKILL 兜底。已退出则 no-op。
 */
async function killProcess(child, graceMs) {
  if (!child) return
  if (child.exitCode !== null || child.signalCode) return
  const exitPromise = new Promise((resolve) => {
    child.once('exit', () => resolve(true))
  })
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const exited = await Promise.race([
    exitPromise,
    sleep(graceMs).then(() => false),
  ])
  if (!exited) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {Object} p
 * @returns {SmokeResult}
 */
function makeResult({ exitCode, stderrErrors, consoleErrors, pageErrors, missingMounts, readyMs, detail }) {
  return {
    ok: exitCode === 0,
    exitCode,
    stderrErrors,
    consoleErrors,
    pageErrors,
    missingMounts,
    readyMs,
    ...(detail ? { detail } : {}),
  }
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  /** @type {SmokeOptions} */
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--port' && next) {
      opts.port = Number(next)
      i++
    } else if (a === '--ready-timeout' && next) {
      opts.readyTimeout = Number(next)
      i++
    } else if (a === '--settle' && next) {
      opts.consoleSettleMs = Number(next)
      i++
    } else if (a === '-h' || a === '--help') {
      printHelp()
      process.exit(0)
    }
  }
  return opts
}

function printHelp() {
  console.log(`dev-smoke — dev 启动期冒烟闸门

用法:
  node scripts/dev-smoke.mjs [options]
  pnpm dev:smoke

选项:
  --port <n>             vite dev server 端口（默认 1420）
  --ready-timeout <ms>   dev server ready 轮询超时（默认 60000）
  --settle <ms>          ready 后静默窗口（默认 3000）
  -h, --help             显示帮助

退出码:
  0  ok
  1  有 error（编译/console/pageerror/挂载点缺失）
  2  dev server 启动超时
  3  chromium launch 失败`)
}

function printSummary(result) {
  const okMark = result.ok ? '✓' : '✗'
  console.log(`\n${'='.repeat(60)}`)
  console.log(`${okMark} dev-smoke 结果: exitCode=${result.exitCode} ok=${result.ok}`)
  console.log(`  ready: ${result.readyMs}ms`)
  console.log(`  stderrErrors(vite编译): ${result.stderrErrors.length}`)
  console.log(`  consoleErrors(过滤后): ${result.consoleErrors.length}`)
  console.log(`  pageErrors(未捕获): ${result.pageErrors.length}`)
  console.log(`  missingMounts: ${result.missingMounts.length} ${result.missingMounts.length ? JSON.stringify(result.missingMounts) : ''}`)
  if (result.detail) {
    console.log(`  detail:\n${result.detail}`)
  }
  if (result.stderrErrors.length) {
    console.log(`  --- stderrErrors ---`)
    for (const e of result.stderrErrors) console.log(`  ${e}`)
  }
  if (result.consoleErrors.length) {
    console.log(`  --- consoleErrors ---`)
    for (const e of result.consoleErrors) console.log(`  ${e}`)
  }
  if (result.pageErrors.length) {
    console.log(`  --- pageErrors ---`)
    for (const e of result.pageErrors) console.log(`  ${e}`)
  }
  console.log(`${'='.repeat(60)}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const result = await runSmoke(opts)
  printSummary(result)
  process.exit(result.exitCode)
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  main()
}
