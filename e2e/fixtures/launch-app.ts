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
