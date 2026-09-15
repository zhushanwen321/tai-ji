/**
 * U2：真实 main 进程 whenReady 自动清理已完成升级的残留产物。
 *
 * 对应修复：3d7fa534 fix(update): cleanup completed update artifacts + version guard
 * Bug 场景：自动升级完成后，170MB zip + preloaded 元信息残留磁盘，侧栏误显示「已下载」。
 *
 * 真实性：
 * - 真实 main 进程（_electron.launch）+ 真实 cleanupCompletedUpdate（whenReady 内、
 *   maybeRollbackInterruptedUpdate 之后、bootstrapMainWindow 之前，见 main.ts）
 * - 真实 fs：seed 与断言都落在 <dataDir>/update/ 下
 *
 * [R1 毕业，2026-09-15] 本用例 pi/LLM 双无关（断言面 = main 进程 fs 层），从 real 轨
 * （update-cleanup-real.spec.ts）毕业进 CI 固定环节：装配改 mock 轨 launch-app.ts
 * （TAIJI_MOCK=1 跳过 runtime spawn——cleanupCompletedUpdate 在 main.ts whenReady，
 * 不依赖 runtime/renderer 形态，两种装配走同一 main 代码路径），并打 @p0-smoke 标签
 * 进 electron-smoke project（ci.yml e2e-behavior job 每 PR 固定跑，零 token）。
 *
 * 时序依据：main.ts whenReady 中 `await cleanupCompletedUpdate()` 位于
 * bootstrapMainWindow() 之前 → launchApp 的 firstWindow() resolve 时（窗口已建）
 * cleanup 必然已执行完。断言仍用 expect.poll 短轮询兜底 fs 落盘时序。
 *
 * seed 版本约束：update-result.json.version 必须 ≤ 真实 app.getVersion()（动态读
 * apps/electron/package.json），否则 done 分支版本比较不过，保守不清（假 done 防御）。
 */
import { test, expect } from '@playwright/test'
import { launchApp } from './fixtures/launch-app'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** app.getVersion() 的真实值来源（electron.launch 加载 apps/electron/package.json） */
const APP_VERSION = (
  JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'apps', 'electron', 'package.json'), 'utf-8'),
  ) as { version: string }
).version

const UPDATE_DIR = (dataDir: string): string => path.join(dataDir, 'update')
const RESULT_FILE = (dataDir: string): string => path.join(UPDATE_DIR(dataDir), 'update-result.json')
const PRELOADED_FILE = (dataDir: string): string =>
  path.join(UPDATE_DIR(dataDir), 'preloaded-update.json')
const ZIP_FILE = (dataDir: string): string =>
  path.join(UPDATE_DIR(dataDir), `TaiJi-${APP_VERSION}-mac-arm64.zip`)
const DOWNLOADING_FILE = (dataDir: string): string => `${ZIP_FILE(dataDir)}.downloading`

test('U2: whenReady cleanupCompletedUpdate 清理 done 终态升级残留 @p0-smoke', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-u2-'))
  const updateDir = UPDATE_DIR(dataDir)
  fs.mkdirSync(updateDir, { recursive: true })

  // ── seed：done 终态 + preloaded 元信息 + 1MB 假 zip + .downloading 残留 ──
  fs.writeFileSync(RESULT_FILE(dataDir), JSON.stringify({ status: 'done', version: APP_VERSION }))
  fs.writeFileSync(
    PRELOADED_FILE(dataDir),
    JSON.stringify({
      version: APP_VERSION,
      assetName: path.basename(ZIP_FILE(dataDir)),
      filePath: ZIP_FILE(dataDir),
      downloadedAt: new Date().toISOString(),
      size: 1024 * 1024,
      release: {
        version: APP_VERSION,
        tagName: `v${APP_VERSION}`,
        releaseNotes: 'e2e seed',
        publishedAt: new Date().toISOString(),
        htmlUrl: 'https://example.com/releases',
        assets: {},
      },
    }),
  )
  fs.writeFileSync(ZIP_FILE(dataDir), Buffer.alloc(1024 * 1024, 7))
  fs.writeFileSync(DOWNLOADING_FILE(dataDir), 'partial-download')
  // 前置：seed 落盘确认
  expect(fs.existsSync(ZIP_FILE(dataDir)), 'seed 前置：zip 应存在').toBe(true)

  const { page, cleanup } = await launchApp({ dataDir })
  try {
    await page.waitForLoadState('domcontentloaded')
    // firstWindow resolve = bootstrapMainWindow 已执行 → cleanup 已在其之前完成；
    // poll 兜底 fs 异步，15s 足够真实 app 启动 + cleanup
    await expect
      .poll(() => !fs.existsSync(RESULT_FILE(dataDir)), { timeout: 15_000, intervals: [200, 500] })
      .toBe(true)

    // 残留全清（cleanup 删文件不删目录本身）
    expect(fs.existsSync(PRELOADED_FILE(dataDir)), 'preloaded-update.json 应被删').toBe(false)
    expect(fs.existsSync(ZIP_FILE(dataDir)), '下载 zip 应被删').toBe(false)
    expect(fs.existsSync(DOWNLOADING_FILE(dataDir)), '.downloading 残留应被删').toBe(false)
    expect(fs.readdirSync(updateDir), 'update 目录应为空').toEqual([])
  } finally {
    await cleanup()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
