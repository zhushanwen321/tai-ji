/**
 * Playwright globalSetup —— 测试启动前确保 Electron 构建产物的**存在性与形态**。
 *
 * 产物缺失或构建形态与本次运行的轨不符时自动跑 build:e2e（形态感知构建，D3 顺带
 * 发现 8 的修复——旧形态只查存在性：真轨首跑撞上自动构建出的 mock bundle，被
 * launch-real pre-flight 拒绝且恢复动作要求手工重建）。
 *
 * 形态判定：
 * - 请求轨 = argv 信号推导：显式文件参数命中 real 轨清单（REAL_TRACK_SPECS，与
 *   playwright.config electron-real project 的 testMatch 同一 SSOT）或
 *   `--project=electron-real` → real；其余（mock 行为轨 / smoke / 缺省）→ mock。
 * - 当前产物形态 = assets 内 mock fixture 标记串探测（与 launch-app / launch-app-real
 *   的 pre-flight 同一判据 MOCK_BUNDLE_MARKER）。
 * - 混合信号（同一命令既带 real spec 又带 mock spec）：单 dist 无法同时满足两轨，
 *   按 real 形态构建，mock spec 由 launch-app 的 pre-flight fail-fast 兜底（带重建
 *   指引）——显式混合运行是操作错误，不为它建双 dist。
 *
 * 产物路径：
 * - apps/electron/dist/main/main.cjs（main entry）
 * - apps/electron/dist/preload/preload.cjs（preload）
 * - apps/electron/renderer/dist/index.html（renderer，E2E 构建时带 VITE_E2E=true）
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MOCK_BUNDLE_MARKER, RENDERER_DIST_ASSETS } from './launch-app'
import { matchesRealTrackSpec } from './real-track-specs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_DIR = path.join(REPO_ROOT, 'apps/electron')

const ARTIFACTS = [
  path.join(ELECTRON_DIR, 'dist/main/main.cjs'),
  path.join(ELECTRON_DIR, 'dist/preload/preload.cjs'),
  path.join(ELECTRON_DIR, 'renderer/dist/index.html'),
]

function artifactsMissing(): boolean {
  return ARTIFACTS.some((p) => !fs.existsSync(p))
}

/** 当前产物是否 mock 构建（marker 探测判据与两轨 pre-flight 同源）。 */
function distIsMockBundle(): boolean {
  if (!fs.existsSync(RENDERER_DIST_ASSETS)) return false
  return fs
    .readdirSync(RENDERER_DIST_ASSETS)
    .filter((f) => f.endsWith('.js'))
    .some((f) => fs.readFileSync(path.join(RENDERER_DIST_ASSETS, f), 'utf8').includes(MOCK_BUNDLE_MARKER))
}

/** argv → 请求轨（首个 real 信号即判 real；缺省 mock）。 */
function requestedTrackFromArgv(): 'real' | 'mock' {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--project=electron-real') return 'real'
    if (a === '--project' && argv[i + 1] === 'electron-real') return 'real'
    if (!a.startsWith('-') && matchesRealTrackSpec(a)) return 'real'
  }
  return 'mock'
}

export default async function globalSetup(): Promise<void> {
  // visual-only 运行（CI e2e-visual job，E2E_VISUAL_ONLY=1）只需 chromium + vite（mock），
  // 不需要 Electron 构建产物——直接跳过产物检查，避免 fresh checkout 上触发 build:e2e
  //（electron 行为轨专属，visual 轨不应承担构建开销）。
  if (process.env.E2E_VISUAL_ONLY === '1') {
    console.log('[e2e global-setup] E2E_VISUAL_ONLY=1（visual 轨），跳过 Electron 构建产物检查')
    return
  }
  const needMock = requestedTrackFromArgv() === 'mock'
  const missing = artifactsMissing()
  const formMismatch = !missing && distIsMockBundle() !== needMock
  if (missing || formMismatch) {
    const reason = missing
      ? '构建产物缺失'
      : `产物形态不符（当前 ${distIsMockBundle() ? 'mock' : 'real'} 构建，本次运行为 ${needMock ? 'mock' : 'real'} 轨）`
    console.log(`[e2e global-setup] ${reason}，按 ${needMock ? 'mock' : 'real'} 轨形态跑 build:e2e ...`)
    // VITE_E2E=true 必须透传给 renderer 构建（vite.config.ts define 读此注入 sample-project cwd）
    // VITE_MOCK 仅 mock 轨注入——real 轨构建不传（传了会被 launch-real pre-flight 拒绝）
    execSync('pnpm run build:e2e', {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, VITE_E2E: 'true', ...(needMock ? { VITE_MOCK: 'true' } : {}) },
      timeout: 180_000,
    })
    if (artifactsMissing()) {
      throw new Error('[e2e global-setup] build:e2e 完成后产物仍缺失：' + ARTIFACTS.filter((p) => !fs.existsSync(p)).join(', '))
    }
    if (distIsMockBundle() !== needMock) {
      throw new Error(
        `[e2e global-setup] build:e2e 后产物形态仍不符（期望 ${needMock ? 'mock' : 'real'} 轨）——` +
          '检查 vite define 注入链（VITE_MOCK）是否被环境变量覆盖',
      )
    }
    console.log('[e2e global-setup] 构建产物就绪（形态匹配）')
  } else {
    console.log('[e2e global-setup] 构建产物已存在且形态匹配，跳过 build')
  }
}
