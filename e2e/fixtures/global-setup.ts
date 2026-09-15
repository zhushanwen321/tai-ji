/**
 * Playwright globalSetup —— 测试启动前确保 Electron 构建产物存在。
 *
 * 产物缺失时自动跑 build:e2e（build:main + build:preload + build:vite with VITE_E2E）。
 * 产物已存在则跳过（增量开发时避免每次重建，节省时间）。
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

export default async function globalSetup(): Promise<void> {
  // visual-only 运行（CI e2e-visual job，E2E_VISUAL_ONLY=1）只需 chromium + vite（mock），
  // 不需要 Electron 构建产物——直接跳过产物检查，避免 fresh checkout 上触发 build:e2e
  //（electron 行为轨专属，visual 轨不应承担构建开销）。
  if (process.env.E2E_VISUAL_ONLY === '1') {
    console.log('[e2e global-setup] E2E_VISUAL_ONLY=1（visual 轨），跳过 Electron 构建产物检查')
    return
  }
  if (artifactsMissing()) {
    console.log('[e2e global-setup] 构建产物缺失，跑 build:e2e ...')
    // VITE_E2E=true 必须透传给 renderer 构建（vite.config.ts define 读此注入 sample-project cwd）
    // VITE_MOCK=true 同理（renderer 构建期把 mock 开关打进 bundle）
    execSync('pnpm run build:e2e', {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, VITE_E2E: 'true', VITE_MOCK: 'true' },
      timeout: 180_000,
    })
    if (artifactsMissing()) {
      throw new Error('[e2e global-setup] build:e2e 完成后产物仍缺失：' + ARTIFACTS.filter((p) => !fs.existsSync(p)).join(', '))
    }
    console.log('[e2e global-setup] 构建产物就绪')
  } else {
    console.log('[e2e global-setup] 构建产物已存在，跳过 build')
  }
}
