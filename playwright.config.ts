import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * Playwright config —— taiji E2E（Electron 行为 + visual chromium 像素 diff）。
 *
 * 三 project 架构（W3 新增 visual-chromium；2026-09-15 新增 electron-smoke）：
 * - electron        : 行为 E2E 全量（_electron.launch + mock 构建产物），testIgnore visual/**
 * - electron-smoke  : 行为 E2E 的 P0 smoke 子集（grep @p0-smoke 用例标签），CI e2e-behavior job
 *                     每 PR 固定跑（零 token mock 轨）。与 electron 是**子集关系非互斥分轨**
 *                     （smoke ⊂ 全量），故用 grep 表达而非 testMatch/testIgnore——裸跑
 *                     `npx playwright test` 时 smoke 用例会随 electron 全量 + 本 project 各跑一遍，
 *                     跑全量请显式 `--project=electron`
 * - visual-chromium : 像素 diff（chromium.launch + spawn vite dev server @ VITE_MOCK=true），
 *                     testMatch visual/**。baseline 锚定 e2e/visual-baselines/（git tracked）
 *
 * E2E 策略（见 execution-plan W0 + slice v6-ui-refactor-test-infra IF3）：
 * - globalSetup 跑 build:e2e 确保 Electron 构建产物存在（已构建则跳过；visual project 共享此 setup，
 *   产物缺失时会先 build，属正常）
 * - workers: 1（Electron 多实例争抢 userData LOCK + 端口，强制串行；visual 也串行保证 baseline 稳定）
 *
 * smoke 子集圈定 SSOT = 本 project 的 grep 标签（@p0-smoke）；候选 = 覆盖「新建任务首条消息流 /
 * session 切换隔离 / composer slash / 侧栏核心交互 / 错误态收口 / 对话流渲染布局」的现存用例，
 * 名单与归宿纪律见 docs/TEST-STRATEGY.md「e2e 资产归宿纪律」章节。
 *
 * visual project 的 vite 由 e2e/visual/fixtures/visual-server.ts 的 worker-scoped fixture 管理
 *（复用 W1/W2 spawnVite 范式），不用全局 webServer——避免 visual 的 vite 依赖拖累 electron project。
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',

  // Electron 多实例会争抢 Chromium userData LOCK + 端口，强制串行；visual baseline 也需串行稳定
  fullyParallel: false,
  workers: 1,

  // Electron app 启动 + renderer mock 初始化较慢，给足超时；visual spawn vite 也需余量
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // 失败时保留 trace + screenshot（调试用）
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // 构建产物存在性校验（已构建则跳过，CI 本地都安全）
  globalSetup: path.resolve(REPO_ROOT, 'e2e/fixtures/global-setup.ts'),

  // 报告（本地默认 list，CI 可加 html）
  reporter: process.env.CI ? 'html' : 'list',

  projects: [
    {
      // 行为 E2E：_electron.launch + mock 构建产物。排除 visual/ 目录（由 visual-chromium 接管）
      name: 'electron',
      testIgnore: '**/visual/**/*.spec.ts',
      use: {},
    },
    {
      // 行为 E2E P0 smoke 子集（CI e2e-behavior job 每 PR 固定跑，零 token mock 轨）：
      // grep @p0-smoke 圈定（子集关系非互斥分轨，见文件头注释）；用例标签打在现存 spec 的
      // test() 标题上（圈定名单 SSOT = grep 标签 + docs/TEST-STRATEGY.md「e2e 资产归宿纪律」）
      name: 'electron-smoke',
      testIgnore: '**/visual/**/*.spec.ts',
      grep: /@p0-smoke/,
      use: {},
    },
    {
      // 像素 diff：chromium.launch + spawn vite dev server（fixture 管理）。
      // viewport 固定保证 baseline 跨次稳定；snapshotDir 锚定 e2e/visual-baselines/（git tracked，Q3/D3）；
      // snapshotPathTemplate 按 spec 文件名分目录（shell.spec.ts → e2e/visual-baselines/shell.spec/shell-default.png）
      // snapshotDir / snapshotPathTemplate 是 TestProject 直接属性（非 use），见 Playwright test.d.ts TestProject
      name: 'visual-chromium',
      testMatch: '**/visual/**/*.spec.ts',
      snapshotDir: path.resolve(REPO_ROOT, 'e2e', 'visual-baselines'),
      snapshotPathTemplate: '{snapshotDir}/{testFileBaseName}/{arg}{ext}',
      use: {
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
})
