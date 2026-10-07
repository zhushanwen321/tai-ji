import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { REAL_TRACK_SPECS } from './e2e/fixtures/real-track-specs'

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * Playwright config —— taiji E2E（Electron 行为 + visual chromium 像素 diff）。
 *
 * 四 project 架构（W3 新增 visual-chromium；2026-09-15 新增 electron-smoke；electron 排除
 * real 轨 spec 族 + 新增 electron-real 承接，见 REAL_TRACK_SPECS 注释）：
 * - electron        : 行为 E2E mock 轨全量（_electron.launch + mock 构建产物），testIgnore visual/** + real 轨 spec 族（launch-app-real 与 mock bundle 互斥，按改动面单独跑）
 * - electron-real   : real 轨承接（真实 app 启动轨），testMatch = real 轨 spec 族；只为显式文件
 *                     命令（e2e-map REAL 族 run 形态）提供发现通道，不进任何门禁全量
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
/**
 * real 轨 spec 族（真实 app 启动：launch-app-real / 真机轨）——清单本体迁至
 * e2e/fixtures/real-track-specs.ts（SSOT：playwright project 匹配与 global-setup
 * 构建形态判定共用同一清单；变更登记说明见该文件头注）。消费关系：
 * - electron project 用它做 testIgnore —— mock bundle 与 real bundle 同 outDir 互斥
 *   （launch-app-real.ts 的 assertRealRendererBundle 对 mock 标记 fail-fast），real spec
 *   卷入 mock 轨必红；`--project=electron` 语义收敛为零 token mock 轨
 * - electron-real project 用它做 testMatch —— real 轨 run 命令是显式文件形态（如
 *   `npx playwright test e2e/workspace-real.spec.ts`，不带 --project），Playwright 的
 *   project testIgnore 对显式文件参数同样生效，排除后必须由本 project 承接才能被发现
 * - 清单登记 SSOT = docs/testing/e2e-map.json REAL/SKILLRELOAD/BTW/MODELS 各 rule 的
 *   assets；清单常量本体在 e2e/fixtures/real-track-specs.ts
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
      // 行为 E2E mock 轨：_electron.launch + mock 构建产物（零 token）。排除 visual/（由
      // visual-chromium 接管）与 real 轨 spec 族（REAL_TRACK_SPECS，见其注释）
      name: 'electron',
      testIgnore: ['**/visual/**/*.spec.ts', ...REAL_TRACK_SPECS],
      use: {},
    },
    {
      // real 轨承接 project：真实 app 启动（launch-app-real / 真机轨），按改动面显式文件跑
      // （docs/testing/e2e-map.json REAL/SKILLRELOAD/BTW/MODELS 各 rule 的 run 命令）。
      // 只为让显式文件命令在 electron project 排除 real 族后仍可发现测试；不得全量扫跑
      // （CI/PR/merge 门禁不跑本轨，AGENTS.md e2e 执行准则）
      name: 'electron-real',
      testMatch: REAL_TRACK_SPECS,
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
