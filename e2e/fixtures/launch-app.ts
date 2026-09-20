/**
 * Playwright _electron launch fixture —— E2E harness 核心。
 *
 * 设计依据（见 execution-plan W0）：
 * - main entry = apps/electron/dist/main/main.cjs（vite 打包后），Electron 读 apps/electron/package.json 的 `main` 字段
 * - E2E 走构建产物 + mock 注入，env：
 *   - VITE_E2E=true → renderer 构建期注入 sample-project cwd + mock 层注入 e2eTestSession（见 renderer/vite.config.ts define）
 *   - VITE_MOCK=true → renderer mock API（不走 transport/ws-client）
 *   - TAIJI_MOCK=1 → main 跳过 runtime spawn（不起 pi 子进程）
 *   - TAIJI_E2E=1 → window-factory.ts 跳过 waitForVite 直接 loadFile 构建产物
 *   - TAIJI_AGENT_DATA_DIR → 隔离数据目录（避免污染 dev/prod 的 ~/.taiji[-dev]）
 *
 * session 注入路径：renderer mock 层（VITE_MOCK=true 时 fixtureSessions + e2eTestSession 经 buildGroups 注入）。
 * 不走 Electron IPC（main 无 session 创建通道），不起 runtime（TAIJI_MOCK=1）。
 */
import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_DIR = path.join(REPO_ROOT, 'apps/electron')

// pnpm hoisted 模式（node-linker=hoisted）下 electron 包提升到 root node_modules/electron，
// 但 createRequire 需要以 workspace 子包目录为起点才能正确解析 workspace 依赖。
// 用 createRequire 在 apps/electron 上下文解析 electron 包导出的可执行文件路径
// （Node 向上查找会命中 root node_modules/electron；跨平台路径计算由 electron/index.js 负责）。
const requireFromElectronDir = createRequire(path.join(ELECTRON_DIR, 'noop.js'))
const ELECTRON_EXECUTABLE = requireFromElectronDir('electron') as string

/** renderer 产物 assets 目录（main 进程 loadFile 目标；mock/real 轨共用同一 outDir）。 */
export const RENDERER_DIST_ASSETS = path.join(REPO_ROOT, 'apps', 'electron', 'renderer', 'dist', 'assets')

/**
 * mock 构建的标记串：mock fixture session 名（packages/core/src/transport/mock/data.ts
 * fixtureSessions 的 s4.label）。real 构建（不传 VITE_MOCK）下 mock 模块链随
 * `import.meta.env.VITE_MOCK === 'true'` 死分支摇除——实测（2026-09-16，138 个 assets/*.js）：
 * mock 构建命中 1 个文件，real 构建（VITE_E2E 传与不传两档）零命中。故本串是
 * 「当前产物是 mock 构建」的判据（而非 mock 代码是否存在）。
 */
export const MOCK_BUNDLE_MARKER = 'Promise 代码评审'

/**
 * pre-flight：确认当前 renderer 产物是 mock bundle（real 产物在场即 fail-fast）。
 *
 * 与 launch-app-real.ts 的 assertRealRendererBundle 对称。背景：两条轨共用
 * apps/electron/renderer/dist（构建期 VITE_MOCK define），而 e2e globalSetup 只查产物
 * 存在、不查构建形态。若先跑 real 轨再跑 mock 轨，renderer 走 real transport 链路
 * （无 mock 层/无 fixture session），所有 mock spec 的 session 断言会以 30s 超时呈现，
 * 失败信号不指向恢复动作。此处把该前置条件变成带恢复命令的响亮失败。
 */
function assertMockRendererBundle(): void {
  if (!fs.existsSync(RENDERER_DIST_ASSETS)) {
    throw new Error(
      `[launch-mock] renderer 产物缺失（${RENDERER_DIST_ASSETS}）——先构建 mock bundle：` +
        'VITE_E2E=true VITE_MOCK=true pnpm run build:e2e',
    )
  }
  // assets 约 8MB / 138 个 js——逐文件 includes 约几十毫秒，launch 次数个位数，不必加缓存
  const mockAsset = fs
    .readdirSync(RENDERER_DIST_ASSETS)
    .filter((f) => f.endsWith('.js'))
    .find((f) => fs.readFileSync(path.join(RENDERER_DIST_ASSETS, f), 'utf8').includes(MOCK_BUNDLE_MARKER))
  if (!mockAsset) {
    throw new Error(
      `[launch-mock] 未检出 mock renderer bundle（assets 无 mock fixture 标记「${MOCK_BUNDLE_MARKER}」）；` +
        '当前产物疑为 real 构建（构建时未传 VITE_MOCK）。rebuild with: ' +
        'VITE_E2E=true VITE_MOCK=true pnpm run build:e2e，再重跑本 spec',
    )
  }
}

/**
 * 启动 TaiJi Electron app（构建产物 + mock 模式）。
 *
 * 每次启动创建独立临时数据目录（TAIJI_AGENT_DATA_DIR），避免跨用例污染。
 * 调用方负责 close（经返回的 cleanup 或 Playwright fixture afterAll）。
 *
 * @param opts.dataDir 覆盖数据目录（默认 mkdtemp）——「main whenReady 启动期逻辑」
 *   用例需要 seed 预置 dataDir 时传入；传入后 cleanup 不删目录（由调用方管理）。
 * @returns app ElectronApplication + 首个窗口 Page + cleanup 闭包
 */
export async function launchApp(opts: { dataDir?: string } = {}): Promise<{
  app: ElectronApplication
  page: Page
  dataDir: string
  cleanup: () => Promise<void>
}> {
  assertMockRendererBundle()
  const tmpDataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-e2e-'))

  const app = await electron.launch({
    // 显式指定 electron 可执行文件（hoisted 模式下在 root node_modules/electron）
    executablePath: ELECTRON_EXECUTABLE,
    // Electron 进程的 cwd 指向 apps/electron（含 package.json 的 main 字段），
    // app.getAppPath() 会解析到此处，dist/main/main.cjs + dist/preload/preload.cjs + renderer/dist 都在此树下
    cwd: ELECTRON_DIR,
    env: {
      ...process.env,
      // renderer 侧：mock API + E2E 注入（Vite 构建期 define 已把 sample-project cwd 打进 bundle）
      VITE_MOCK: 'true',
      VITE_E2E: 'true',
      // main 侧：跳过 runtime spawn + 跳过 Vite 轮询直接 loadFile
      TAIJI_MOCK: '1',
      TAIJI_E2E: '1',
      // 隔离数据目录，防 Chromium LevelDB LOCK 竞争 + 不污染 dev/prod
      TAIJI_AGENT_DATA_DIR: tmpDataDir,
    },
    // 用 @playwright/test 自带的 electron（node_modules/.bin/electron）；
    // 不指定 executablePath 时 _electron 默认走 playwright 解析的 electron
    args: ['.'],
  })

  // 等待首个窗口（ready-to-show 后 BrowserWindow.show，E2E 用 firstWindow 拿渲染页）
  const page = await app.firstWindow()
  // 给 renderer 一点时间完成 mock 连接 + session.list 拉取（mock sleep TIMING.ack ≈ 40ms，留余量）
  await page.waitForLoadState('domcontentloaded')

  const cleanup = async (): Promise<void> => {
    try {
      await app.close()
    } finally {
      // 仅清理自建的临时目录（opts.dataDir 传入的由调用方管理）
      if (!opts.dataDir) {
        fs.rmSync(tmpDataDir, { recursive: true, force: true })
      }
    }
  }

  return { app, page, dataDir: tmpDataDir, cleanup }
}

/**
 * 扩展 Playwright test fixture：每个 test 自动启动 + 清理 Electron app。
 *
 * 用法：
 *   import { test, expect } from './fixtures/launch-app'
 *   test('xxx', async ({ electronApp, page }) => { ... })
 *
 * 每个用例独立 app 实例（Electron 不宜跨用例复用，状态隔离更可靠）。
 * worker 级 fixture 也可（app 启动慢），但 TaiJi 有大量 localStorage/sessionStorage 状态，
 * per-test 重启更安全。后续若启动成为瓶颈可改 worker fixture + beforeEach clearStorage。
 */
export const test = base.extend<{ electronApp: ElectronApplication; page: Page }>({
  electronApp: async ({}, use) => {
    const { app, cleanup } = await launchApp()
    await use(app)
    await cleanup()
  },
  // 覆盖默认 page fixture：用 Electron 的首个窗口而非独立 browser context
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
})

export { expect }
