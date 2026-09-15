/**
 * visual-chromium project 的 worker-scoped fixture —— 管理 vite dev server 生命周期。
 *
 * 复用 W1（token-consume-check.mjs）/ W2（visual-capture.mjs）已验证的 spawnVite 范式：
 *   findFreePort(1430)  避开 renderer vite.config.ts 的 strictPort:true 1420 占用
 *   spawn vite         cwd=packages/renderer + --no-strictPort + PATH 注入 node_modules/.bin
 *                      （三陷阱：strictPort 占用 / pnpm -- 传参 / PATH 解析，均已由 W1/W2 解决）
 *   pollReady          fetch 轮询直到 vite ready（或子进程退出提前失败）
 *   killProcess        try/finally SIGTERM + 兜底 SIGKILL（graceMs:2000）
 *
 * worker scope：vite 只起一次（workers:1 全局串行），所有 visual spec 共享同一 vite + baseURL。
 * auto:true：spec 无需显式依赖 fixture，仅声明 ({ page, visualBaseURL }) 即可拿到 url。
 *
 * 不覆盖 page fixture：用 visual-chromium project 默认的 chromium page（viewport 来自 project use），
 * spec 里 page.goto(visualBaseURL) 导航到 mock renderer。
 *
 * 设计依据：slice plan IF3 / TC4 / DM3；不用全局 webServer 是为隔离 electron project（design-review TO1）。
 */
import { test as base } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT_START = 1430
const PORT_SCAN_SPAN = 50
const PORT_END = PORT_START + PORT_SCAN_SPAN
const READY_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 500
const KILL_GRACE_MS = 2000
const HTTP_SERVER_ERROR = 500
const STDERR_TAIL_LINES = 20

const REPO_ROOT = process.cwd()
const RENDERER_DIR = resolve(REPO_ROOT, 'packages/renderer')

/** 找一个空闲端口（1430-1479），避开被占用的 strictPort 冲突。 */
async function findFreePort(): Promise<number> {
  for (let port = PORT_START; port < PORT_END; port++) {
    const ok = await new Promise<boolean>((r) => {
      const srv = createServer()
      srv.unref()
      srv.once('error', () => r(false))
      srv.listen(port, () => srv.close(() => r(true)))
    })
    if (ok) return port
  }
  throw new Error(`[visual-server] 未找到空闲端口（${PORT_START}-${PORT_END - 1}）`)
}

/** spawn vite dev server（packages/renderer + VITE_MOCK=true），返回 child + stderr 缓冲。 */
function spawnVite(port: number, stderrBuf: string[]): ChildProcess {
  const binDirs = [
    resolve(RENDERER_DIR, 'node_modules', '.bin'),
    resolve(REPO_ROOT, 'node_modules', '.bin'),
  ]
  const child = spawn(`vite --port ${port} --no-strictPort`, {
    cwd: RENDERER_DIR,
    shell: true,
    env: {
      ...process.env,
      VITE_MOCK: 'true',
      PATH: `${binDirs.join(':')}:${process.env.PATH}`,
    },
  })
  child.stderr.on('data', (c: Buffer) => stderrBuf.push(c.toString()))
  child.stdout.on('data', () => {
    /* 吸收避免 pipe 破裂 */
  })
  return child
}

/** 轮询 url 直到 < 500 响应（vite ready），或子进程退出 / 超时。 */
async function pollReady(
  url: string,
  child: ChildProcess,
): Promise<{ ok: true; ms: number } | { ok: false; reason: string }> {
  const start = Date.now()
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (child.exitCode !== null) return { ok: false, reason: 'vite 子进程已退出' }
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.status < HTTP_SERVER_ERROR) return { ok: true, ms: Date.now() - start }
    } catch (err) {
      /* ECONNREFUSED → 继续轮询 */
      void err
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return { ok: false, reason: `轮询超时（${READY_TIMEOUT_MS}ms）` }
}

/** 优雅 kill：SIGTERM 等 graceMs，超时 SIGKILL 兜底。 */
async function killProcess(child: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode) return
  const exitP = new Promise<boolean>((r) => child.once('exit', () => r(true)))
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const exited = await Promise.race([exitP, sleep(KILL_GRACE_MS).then(() => false)])
  if (!exited) {
    try {
      child.kill('SIGKILL')
    } catch (err) {
      /* 进程已退出时 kill 抛错，兜底路径忽略 */
      void err
    }
  }
}

/**
 * worker-scoped auto fixture：提供 visualBaseURL（vite dev server 地址）。
 *
 * worker 启动时 spawn vite，所有 visual spec 共享；worker 结束自动 cleanup kill。
 * 失败（vite 未 ready）抛错，visual spec 全部 error（不影响 electron project）。
 */
export const test = base.extend<Record<never, never>, { visualBaseURL: string }>({
  visualBaseURL: [
    async ({}, use) => {
      const port = await findFreePort()
      const url = `http://localhost:${port}`
      const stderrBuf: string[] = []
      const child = spawnVite(port, stderrBuf)
      try {
        const ready = await pollReady(url, child)
        if (ready.ok === false) {
          const tail = stderrBuf.slice(-STDERR_TAIL_LINES).join('')
          throw new Error(
            `[visual-server] vite dev server 未 ready（${ready.reason}）@ ${url}\n${tail}\n` +
              `提示：检查 packages/renderer 依赖是否已安装（pnpm install）、端口是否被占`,
          )
        }
        console.log(`[visual-server] vite ready @ ${url} (${ready.ms}ms)`)
        await use(url)
      } finally {
        await killProcess(child)
      }
    },
    { scope: 'worker', auto: true },
  ],
})

export { expect } from '@playwright/test'
