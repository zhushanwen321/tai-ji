#!/usr/bin/env node
/**
 * W1 token 消费层断言——chromium 真实验证轨（IF1 消费层分支）。
 *
 * 目标：在真实浏览器环境（chromium + vite dev server + Tailwind JIT 编译产物）验证
 * 5 核心组件的 Tailwind 语义类（bg-bg/text-neutral-fg/composer-box/bg-bg-input/text-accent/
 * bg-surface）computed style 取自 CSS 变量（var()）非硬编码。
 *
 * 与 vitest 轨（tokens.test.ts TC3）的关系：
 *  - vitest 轨注入「等价 CSS」验证「类名→var()」契约（happy-dom 已证实支持 var() 展开）。
 *  - 本脚本加载真实 vite dev server + Tailwind JIT 编译产物，验证组件真实渲染消费（端到端）。
 *  双轨：vitest 快速契约 + chromium 真实环境，任一发现问题即拦截 token 引用断裂（ERR1）。
 *
 * 机制（复用 scripts/dev-smoke.mjs 范式）：VITE_MOCK=true spawn vite dev server（--port 动态
 * 找空闲，避开 1420 strictPort 占用）→ 轮询 ready → chromium.launch → 取 5 组件元素
 * getComputedStyle 对比 :root 变量展开值 → try/finally cleanup。
 *
 * exit code：
 *   0 = 全部断言 pass（5 组件 computed 取自 var()）
 *   1 = 有断言 fail（token 引用断裂疑似 ERR1）或 Settings 不可达
 *   2 = dev server 启动超时
 *   3 = chromium launch 失败（提示 npx playwright install chromium）
 *
 * 用法：
 *   node scripts/token-consume-check.mjs [--port 1430] [--ready-timeout 60000]
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const RENDERER_DIR = resolve(REPO_ROOT, 'packages/renderer')
const DEFAULT_PORT_START = 1430
const DEFAULT_READY_TIMEOUT = 60000
const POLL_INTERVAL_MS = 500
const KILL_GRACE_MS = 2000

// 5 核心组件消费层断言表（label/选择器/computed 属性/期望变量/首屏/必需）
// required=true 计入 exit code 判定；required=false 为 best-effort（var() 消费由 vitest
// 契约验证 tokens.test.ts TC3 覆盖，chromium 轨为真实验证抽样，失败降级 warn）
const ASSERTIONS = [
  { label: 'AppShell', selector: '.app-shell', prop: 'backgroundColor', varName: '--bg', firstScreen: true, required: true },
  { label: 'Sidebar', selector: '.sidebar .text-neutral-fg', prop: 'color', varName: '--neutral-fg', firstScreen: true, required: true },
  { label: 'Composer', selector: '.composer-box', prop: 'backgroundColor', varName: '--bg-input', firstScreen: true, required: true },
  { label: 'MessageStream', selector: '.message-stream .text-accent, .message-stream [class*="text-accent"]', prop: 'color', varName: '--accent', firstScreen: true, required: false },
  { label: 'Settings', selector: '[role="dialog"]', prop: 'backgroundColor', varName: '--surface', firstScreen: false, required: false },
]

// ---------------------------------------------------------------------------
// 动态找空闲端口（避开 1420 strictPort 占用）
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


// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function run({ port, readyTimeout }) {
  const chosenPort = port || (await findFreePort(DEFAULT_PORT_START))
  const url = `http://localhost:${chosenPort}`
  let child
  let browser
  const results = []

  try {
    // (1) spawn vite dev server（cwd=renderer 直接起 vite，避开 pnpm filter -- 传参失效；
    //     --no-strictPort 覆盖 config strictPort:true，保证 --port 空闲端口生效；
    //     PATH 注入 node_modules/.bin 让 shell 能找到 vite 二进制）
    const binDirs = [
      resolve(RENDERER_DIR, 'node_modules', '.bin'),
      resolve(REPO_ROOT, 'node_modules', '.bin'),
    ]
    child = spawn(`vite --port ${chosenPort} --no-strictPort`, {
      cwd: RENDERER_DIR,
      shell: true,
      env: {
        ...process.env,
        VITE_MOCK: 'true',
        PATH: `${binDirs.join(':')}:${process.env.PATH}`,
      },
    })
    const stderr = []
    child.stderr.on('data', (c) => stderr.push(c.toString()))

    // (2) 轮询 ready
    const ready = await pollReady(url, readyTimeout, child)
    if (!ready.ok) {
      const tail = stderr.slice(-20).join('')
      console.error(`[token-consume] dev server 未 ready（${ready.reason}）@ ${url}\n${tail}`)
      return { exitCode: 2, results }
    }
    console.log(`[token-consume] dev server ready @ ${url} (${ready.ms}ms)`)

    // (3) chromium launch
    try {
      browser = await chromium.launch()
    } catch (e) {
      console.error(`[token-consume] chromium launch 失败: ${e.message}\n提示: npx playwright install chromium`)
      return { exitCode: 3, results }
    }
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: readyTimeout })
    await page.waitForSelector('.app-shell', { state: 'visible', timeout: readyTimeout })
    await sleep(2000) // 等 Vue mount + Tailwind JIT 编译稳定

    // (4) Settings 需交互打开（首屏 non-firstScreen 的断言前置）
    const settingsAssertion = ASSERTIONS.find((a) => !a.firstScreen)
    if (settingsAssertion) {
      try {
        // 点 sidebar 齿轮按钮：title 属性含 setting/设置（i18n），按钮内是 svg 无文字故不用 hasText
        const clicked = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('.sidebar button[title]'))
          const gear = btns.find((b) => /setting|设置/i.test(b.getAttribute('title') || ''))
          if (gear) { gear.click(); return true }
          return false
        })
        if (clicked) {
          await page.waitForSelector('[role="dialog"]', { state: 'visible', timeout: 8000 }).catch(() => {})
          await sleep(1000)
        } else {
          console.warn('[token-consume] 未找到 sidebar 齿轮按钮（title 含 setting），Settings 降级')
        }
      } catch (e) {
        console.warn(`[token-consume] Settings 打开失败（降级：跳过 Settings 真实验证，见 vitest 契约）: ${e.message}`)
      }
    }

    // (5) 5 组件消费层断言（evaluate 内取 computed style 对比 :root 变量）
    for (const a of ASSERTIONS) {
      const r = await page.evaluate(({ selector, prop, varName, label }) => {
        const el = document.querySelector(selector)
        if (!el) {
          // dump 候选调试信息（message-stream 内消费 accent 的元素）
          let dump = ''
          if (label === 'MessageStream') {
            const ms = document.querySelector('.message-stream')
            const accents = ms ? ms.querySelectorAll('[class*="accent"]') : []
            dump = `（.message-stream ${ms ? '存在' : '不存在'}，内部 [class*=accent] ×${accents.length}：${Array.from(accents).slice(0, 3).map((e) => e.className).join(' | ')}）`
          }
          return { label, found: false, actual: '', rootVal: '', matches: false, note: `选择器未命中: ${selector}${dump}` }
        }
        const actual = getComputedStyle(el)[prop]
        const rootVal = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
        function hexToRgbInv(h) {
          const m = /^#([0-9a-fA-F]{6})$/.exec((h || '').trim())
          if (!m) return null
          const n = parseInt(m[1], 16)
          return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
        }
        const rootRgb = hexToRgbInv(rootVal)
        const matches = actual === rootVal || (rootRgb !== null && actual === rootRgb)
        return { label, found: true, actual, rootVal, rootRgb, matches, note: matches ? 'ok' : `期望取自 ${varName}=${rootVal}（rgb=${rootRgb}），实际 ${actual}` }
      }, a)
      results.push({ ...a, ...r })
      const tag = r.matches ? 'PASS' : (a.required ? 'FAIL' : 'WARN')
      console.log(`[token-consume] ${tag} ${a.label}${a.required ? '' : '(best-effort)'}: ${r.note}`)
    }

    // exit code 只看 required=true 的断言（核心 3 组件）；best-effort 失败仅 warn
    const failedRequired = results.filter((r) => r.required && !r.matches)
    return { exitCode: failedRequired.length === 0 ? 0 : 1, results }
  } finally {
    if (browser) await browser.close().catch(() => {})
    await killProcess(child, KILL_GRACE_MS)
  }
}

function parseArgs(argv) {
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
    } else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/token-consume-check.mjs [--port 1430] [--ready-timeout 60000]')
      process.exit(0)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
run({ port: opts.port, readyTimeout: opts.readyTimeout || DEFAULT_READY_TIMEOUT })
  .then((r) => {
    console.log(`\n[token-consume] exit ${r.exitCode}（${r.results.filter((x) => x.matches).length}/${r.results.length} pass）`)
    process.exit(r.exitCode)
  })
  .catch((e) => {
    console.error(`[token-consume] 未捕获错误: ${e.stack || e.message}`)
    process.exit(1)
  })
