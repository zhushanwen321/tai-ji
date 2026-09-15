#!/usr/bin/env node
/**
 * W2 VLM 视觉验证——截图脚本（IF2 / B 层基础设施）。
 *
 * 目标：为 minimax-m3 VLM 语义对照提供稳定的截图入口。支持三 target：
 *   - demo  : spawn .tmp/v6 vite dev server（v6 视觉参考实现，localhost:1421）→ chromium.launch → 截图
 *   - devapp: chromium.connectOverCDP('http://localhost:9222') 连已运行的 dev Electron renderer → 复用现有 page → 截图（不 spawn）
 *   - mock  : spawn packages/renderer vite + VITE_MOCK=true（自洽渲染，复用 W1 token-consume-check 范式）→ chromium.launch → 截图
 *
 * 机制（复用 scripts/token-consume-check.mjs + scripts/dev-smoke.mjs 成熟范式）：
 *   findFreePort（避开 strictPort 占用）+ spawn vite（--no-strictPort + PATH 注入 node_modules/.bin）
 *   + pollReady（fetch 轮询）+ chromium.launch + page.screenshot + try/finally cleanup kill child。
 *
 * 输出：PNG 到 --out-dir（默认 .taiji-harness/visual/<YYYY-MM-DD>-<page>/），文件名 <target>-<page>.png。
 *
 * 半自动形态（D2）：重构期 agent/人触发，非 CI gate。失败不阻塞（ERR3 降级人工肉眼对照）。
 *
 * exit code：
 *   0 = 截图成功，PNG 已产出
 *   1 = 参数错误 / 未知 target
 *   2 = dev server 启动超时（demo/mock）
 *   3 = chromium launch / connect 失败（提示 npx playwright install chromium 或先 pnpm dev）
 *
 * 用法：
 *   node scripts/visual-capture.mjs --target demo [--page shell] [--out-dir DIR] [--port 1421] [--selector SEL] [--url URL]
 *   node scripts/visual-capture.mjs --target devapp [--page shell] [--cdp-url http://localhost:9222]
 *   node scripts/visual-capture.mjs --target mock [--page shell] [--port 1430]
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const DEMO_DIR = resolve(REPO_ROOT, '.tmp/v6')
const RENDERER_DIR = resolve(REPO_ROOT, 'packages/renderer')
const HARNESS_VISUAL_DIR = resolve(REPO_ROOT, '.taiji-harness/visual')

const DEMO_DEFAULT_PORT = 1421
const MOCK_DEFAULT_PORT_START = 1430
const DEFAULT_READY_TIMEOUT = 60000
const POLL_INTERVAL_MS = 500
const KILL_GRACE_MS = 2000
const SETTLE_MS = 2000

// demo（.tmp/v6）首屏根容器；mock（renderer）首屏根容器
const DEMO_ROOT_SELECTOR = '.stage, .window-frame'
const MOCK_ROOT_SELECTOR = '.app-shell'

// ---------------------------------------------------------------------------
// 共享工具（复用 token-consume-check.mjs 范式）
// ---------------------------------------------------------------------------
async function findFreePort(start) {
  for (let port = start; port < start + 50; port++) {
    const ok = await new Promise((r) => {
      const srv = createServer()
      srv.unref()
      srv.once('error', () => r(false))
      srv.listen(port, () => srv.close(() => r(true)))
    })
    if (ok) return port
  }
  throw new Error(`未找到空闲端口（${start}-${start + 49}）`)
}

async function pollReady(url, timeout, child) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (child && child.exitCode !== null) return { ok: false, reason: 'child-exited' }
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.status < 500) return { ok: true, ms: Date.now() - start }
    } catch {
      /* ECONNREFUSED → 继续轮询 */
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return { ok: false, reason: 'timeout' }
}

async function killProcess(child, graceMs) {
  if (!child || child.exitCode !== null || child.signalCode) return
  const exitP = new Promise((r) => child.once('exit', () => r(true)))
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const exited = await Promise.race([exitP, sleep(graceMs).then(() => false)])
  if (!exited) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

function todayStr() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function defaultOutDir(page) {
  return resolve(HARNESS_VISUAL_DIR, `${todayStr()}-${page}`)
}

/** spawn vite dev server，返回 { child, url, stderrBuf }。cwd/port/env 由 caller 决定。 */
function spawnVite({ cwd, port, extraEnv, stderrBuf }) {
  const binDirs = [
    resolve(cwd, 'node_modules', '.bin'),
    resolve(REPO_ROOT, 'node_modules', '.bin'),
  ]
  const child = spawn(`vite --port ${port} --no-strictPort`, {
    cwd,
    shell: true,
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${binDirs.join(':')}:${process.env.PATH}`,
    },
  })
  child.stderr.on('data', (c) => stderrBuf.push(c.toString()))
  child.stdout.on('data', () => { /* 吸收避免 pipe 破裂 */ })
  return child
}

async function capturePage({ browser, url, rootSelector, selector, readyTimeout, settleMs }) {
  const page = await browser.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: readyTimeout })
  if (rootSelector) {
    await page.waitForSelector(rootSelector, { state: 'visible', timeout: readyTimeout }).catch(() => {})
  }
  await sleep(settleMs ?? SETTLE_MS)
  const screenshotOpts = { fullPage: true }
  if (selector) {
    const el = await page.$(selector)
    if (el) {
      return { page, png: await el.screenshot(), scoped: true }
    }
    console.warn(`[visual-capture] --selector "${selector}" 未命中，降级整页截图`)
  }
  return { page, png: await page.screenshot(screenshotOpts), scoped: false }
}

// ---------------------------------------------------------------------------
// demo target：spawn .tmp/v6 vite → chromium.launch → 截图
// ---------------------------------------------------------------------------
async function captureDemo({ port, url, selector, readyTimeout }) {
  const chosenPort = port || DEMO_DEFAULT_PORT
  const targetUrl = url || `http://localhost:${chosenPort}`
  let child
  let browser
  const stderrBuf = []
  try {
    child = spawnVite({ cwd: DEMO_DIR, port: chosenPort, extraEnv: {}, stderrBuf })
    const ready = await pollReady(targetUrl, readyTimeout, child)
    if (!ready.ok) {
      const tail = stderrBuf.slice(-20).join('')
      console.error(`[visual-capture] demo dev server 未 ready（${ready.reason}）@ ${targetUrl}\n${tail}`)
      return { exitCode: 2 }
    }
    console.log(`[visual-capture] demo dev server ready @ ${targetUrl} (${ready.ms}ms)`)
    try {
      browser = await chromium.launch()
    } catch (e) {
      console.error(`[visual-capture] chromium launch 失败: ${e.message}\n提示: npx playwright install chromium`)
      return { exitCode: 3 }
    }
    const { png, scoped } = await capturePage({
      browser, url: targetUrl, rootSelector: DEMO_ROOT_SELECTOR, selector, readyTimeout,
    })
    return { exitCode: 0, png, scoped, targetUrl }
  } finally {
    if (browser) await browser.close().catch(() => {})
    await killProcess(child, KILL_GRACE_MS)
  }
}

// ---------------------------------------------------------------------------
// devapp target：connectOverCDP 连已运行 dev Electron renderer（不 spawn）
// ---------------------------------------------------------------------------
async function captureDevapp({ cdpUrl, selector }) {
  const endpoint = cdpUrl || 'http://localhost:9222'
  let browser
  try {
    browser = await chromium.connectOverCDP(endpoint)
  } catch (e) {
    console.error(`[visual-capture] CDP 连接失败 @ ${endpoint}: ${e.message}\n提示: 请先 pnpm dev 启动 dev Electron（renderer 开 --remote-debugging-port=9222）`)
    return { exitCode: 3 }
  }
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext())
    let page = ctx.pages()[0]
    if (!page) {
      console.warn('[visual-capture] devapp 无现有 page，newPage 等待渲染')
      page = await ctx.newPage()
    }
    await sleep(SETTLE_MS)
    let png
    let scoped = false
    if (selector) {
      const el = await page.$(selector)
      if (el) {
        png = await el.screenshot()
        scoped = true
      } else {
        console.warn(`[visual-capture] --selector "${selector}" 未命中，降级整页截图`)
      }
    }
    if (!png) png = await page.screenshot({ fullPage: true })
    return { exitCode: 0, png, scoped, targetUrl: page.url() }
  } finally {
    // connectOverCDP 的 close 只断开连接，不关 dev Electron
    await browser.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// mock target：spawn renderer vite + VITE_MOCK=true（复用 W1 token-consume-check 范式）
// ---------------------------------------------------------------------------
async function captureMock({ port, url, selector, readyTimeout }) {
  const chosenPort = port || (await findFreePort(MOCK_DEFAULT_PORT_START))
  const targetUrl = url || `http://localhost:${chosenPort}`
  let child
  let browser
  const stderrBuf = []
  try {
    child = spawnVite({ cwd: RENDERER_DIR, port: chosenPort, extraEnv: { VITE_MOCK: 'true' }, stderrBuf })
    const ready = await pollReady(targetUrl, readyTimeout, child)
    if (!ready.ok) {
      const tail = stderrBuf.slice(-20).join('')
      console.error(`[visual-capture] mock dev server 未 ready（${ready.reason}）@ ${targetUrl}\n${tail}`)
      return { exitCode: 2 }
    }
    console.log(`[visual-capture] mock dev server ready @ ${targetUrl} (${ready.ms}ms)`)
    try {
      browser = await chromium.launch()
    } catch (e) {
      console.error(`[visual-capture] chromium launch 失败: ${e.message}\n提示: npx playwright install chromium`)
      return { exitCode: 3 }
    }
    const { png, scoped } = await capturePage({
      browser, url: targetUrl, rootSelector: MOCK_ROOT_SELECTOR, selector, readyTimeout,
    })
    return { exitCode: 0, png, scoped, targetUrl }
  } finally {
    if (browser) await browser.close().catch(() => {})
    await killProcess(child, KILL_GRACE_MS)
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
async function run(opts) {
  const { target } = opts
  let result
  if (target === 'demo') {
    result = await captureDemo(opts)
  } else if (target === 'devapp') {
    result = await captureDevapp(opts)
  } else if (target === 'mock') {
    result = await captureMock(opts)
  } else {
    console.error(`[visual-capture] 未知 --target "${target}"（应为 demo|devapp|mock）`)
    return 1
  }

  if (result.exitCode !== 0 || !result.png) return result.exitCode

  const pageName = opts.page || 'page'
  const dir = opts.outDir ? resolve(opts.outDir) : defaultOutDir(pageName)
  mkdirSync(dir, { recursive: true })
  const file = resolve(dir, `${target}-${pageName}.png`)
  writeFileSync(file, result.png)
  console.log(`[visual-capture] 截图已保存: ${file}（${result.scoped ? 'selector 范围' : '整页 fullPage'}）`)
  if (result.targetUrl) console.log(`[visual-capture] 源 URL: ${result.targetUrl}`)
  return 0
}

/**
 * CLI 参数表：flag → opts key。numeric=true 的取值经 Number() 转换
 * （--port / --ready-timeout），其余为字符串原样。--help 不进表（见 parseArgs 落空分支）。
 */
const ARG_SPECS = [
  { flag: '--target', key: 'target' },
  { flag: '--page', key: 'page' },
  { flag: '--out-dir', key: 'outDir' },
  { flag: '--port', key: 'port', numeric: true },
  { flag: '--url', key: 'url' },
  { flag: '--cdp-url', key: 'cdpUrl' },
  { flag: '--selector', key: 'selector' },
  { flag: '--ready-timeout', key: 'readyTimeout', numeric: true },
]

function printVisualCaptureHelp() {
  console.log(`用法: node scripts/visual-capture.mjs --target demo|devapp|mock [options]
  --target      必需：demo(.tmp/v6 vite:1421) | devapp(CDP:9222) | mock(renderer vite+VITE_MOCK)
  --page        截图命名（默认 page，影响输出目录名 <date>-<page> 与文件名 <target>-<page>.png）
  --out-dir     输出目录（默认 .taiji-harness/visual/<YYYY-MM-DD>-<page>/）
  --port        demo/mock 端口（demo 默认 1421，mock 默认 findFreePort(1430)）
  --url         覆盖默认导航 URL
  --cdp-url     devapp CDP 端点（默认 http://localhost:9222）
  --selector    局部元素截图（CSS 选择器，默认整页 fullPage）
  --ready-timeout  dev server ready 超时 ms（默认 60000）`)
}

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const spec = ARG_SPECS.find((s) => s.flag === a)
    if (spec && argv[i + 1]) {
      opts[spec.key] = spec.numeric ? Number(argv[i + 1]) : argv[i + 1]
      i++
    } else if (a === '-h' || a === '--help') {
      printVisualCaptureHelp()
      process.exit(0)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.target) {
  console.error('[visual-capture] 缺少 --target（demo|devapp|mock）。--help 查看用法。')
  process.exit(1)
}
run({ ...opts, readyTimeout: opts.readyTimeout || DEFAULT_READY_TIMEOUT })
  .then((code) => {
    console.log(`\n[visual-capture] exit ${code}`)
    process.exit(code)
  })
  .catch((e) => {
    console.error(`[visual-capture] 未捕获错误: ${e.stack || e.message}`)
    process.exit(1)
  })
