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
 * 字体固定（2026-10-12 视觉基线跨环境字体敏感根治）：test-scoped auto fixture visualFont 对每个
 * visual page 注入 bundled webfont（@fontsource-variable/noto-sans-sc，npm devDependency，文件留在
 * node_modules 不入 git）——@font-face 经 addInitScript 早于首帧注册，woff2 请求经 route 拦截从
 * node_modules 本地供给（不依赖网络），`html:root` 覆盖 `--font-sans` 变量（specificity 构造性压过
 * 产品 style.css 的 :root 声明）。本机与 CI runner 由此渲染同源字体，像素基线环境无关性由字体文件
 * 本身保证。--font-mono 不在固定范围（等宽字体差异是已知残留）。截图前须调 fontsReady() 等
 * document.fonts.ready，防「字体未就绪的 fallback 帧」照进基线。
 *
 * 设计依据：slice plan IF3 / TC4 / DM3；不用全局 webServer 是为隔离 electron project（design-review TO1）。
 */
import { test as base, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, resolve } from 'node:path'
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
const FONT_PKG_DIR = resolve(REPO_ROOT, 'node_modules', '@fontsource-variable', 'noto-sans-sc')
const FONT_FILES_DIR = resolve(FONT_PKG_DIR, 'files')
const FONT_FAMILY = 'Noto Sans SC Variable'
/**
 * 覆盖 renderer `packages/renderer/src/style.css` :root 的 --font-sans 单点声明：`html:root`
 * specificity (0,1,1) 高于产品的 :root (0,1,0)，同属性竞争中构造性获胜（产品侧无更高 specificity
 * 的 --font-sans 重声明）。原栈保留为 fallback 链（Noto Sans SC unicode 覆盖外的罕见字回落系统
 * 字体，基线 diff 会当场暴露）。--font-mono 不覆盖（等宽字体差异不在字体固定范围）。
 */
const FONT_SANS_OVERRIDE =
  `html:root { --font-sans: '${FONT_FAMILY}', system-ui, 'PingFang SC', 'Helvetica Neue',` +
  ` 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif; }`

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
 * 对 page 注入 bundled webfont（visual-chromium 轨字体固定的核心步骤）：
 *
 * 1. route 拦截：@font-face 的 url 以文档 URL 为基准解析（内嵌 CSS 后为
 *    http://localhost:<port>/files/<subset>.woff2），按 basename 映射回 node_modules
 *    fontsource files 目录本地 fulfill——不依赖网络，CI 与本机同源。
 * 2. addInitScript：每次导航后、页面任何脚本前注册 <style>（fontsource index.css 全量
 *    101 条 @font-face 带 unicode-range，浏览器按页面字符按需加载 subset + --font-sans
 *    覆盖）——早于首帧渲染，无「系统字体先渲染再换字」的中间帧。
 */
async function injectBundledFont(page: Page): Promise<void> {
  const fontCss = readFileSync(resolve(FONT_PKG_DIR, 'index.css'), 'utf8')
  await page.route(/\/files\/noto-sans-sc-.+\.woff2$/, async (route) => {
    const pathname = new URL(route.request().url()).pathname
    await route.fulfill({ path: resolve(FONT_FILES_DIR, basename(pathname)) })
  })
  await page.addInitScript(
    ({ css, override }) => {
      const install = () => {
        const style = document.createElement('style')
        style.textContent = `${css}\n${override}`
        ;(document.head || document.documentElement).appendChild(style)
      }
      if (document.head || document.documentElement) {
        install()
        return
      }
      // addInitScript 的执行点早于 HTML 解析器创建任何元素（实测 head/documentElement 均为
      // null，直接 append 会静默失败）：观测 document 子节点，根元素挂上（解析器首个产物）
      // 即安装——仍早于页面样式注入与首帧渲染，@font-face 注册不落后于任何文本渲染。
      const obs = new MutationObserver(() => {
        if (document.head || document.documentElement) {
          obs.disconnect()
          install()
        }
      })
      obs.observe(document, { childList: true })
    },
    { css: fontCss, override: FONT_SANS_OVERRIDE },
  )
}

/**
 * 截图前统一等待：document.fonts.ready（unicode-range 按需加载的 subset 全部就绪）+
 * 双 rAF（字体换上后的重排/重绘落定）。交互后新渲染文字触发的新 subset 加载也会被
 * ready 覆盖——必须在每次截图前调用，goto 后调一次不够。
 */
export async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((r) => {
      requestAnimationFrame(() => requestAnimationFrame(() => r()))
    })
  })
}

/**
 * worker-scoped auto fixture：提供 visualBaseURL（vite dev server 地址）。
 *
 * worker 启动时 spawn vite，所有 visual spec 共享；worker 结束自动 cleanup kill。
 * 失败（vite 未 ready）抛错，visual spec 全部 error（不影响 electron project）。
 */
export const test = base.extend<{ visualFont: void }, { visualBaseURL: string }>({
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
  /**
   * test-scoped auto fixture：每个 visual page 注入 bundled webfont（字体见文件头注释）。
   * auto:true —— spec 无需显式依赖，仅凭 test 签名即生效。
   */
  visualFont: [
    async ({ page }, use) => {
      await injectBundledFont(page)
      await use()
    },
    { auto: true },
  ],
})

export { expect } from '@playwright/test'
