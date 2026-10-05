/**
 * Playwright globalSetup —— 测试启动前确保 Electron 构建产物存在且新鲜。
 *
 * 产物缺失或过期时自动跑 build:e2e（build:main + build:preload + build:vite with VITE_E2E）。
 * 产物存在且新鲜则跳过（增量开发时避免每次重建，节省时间）。
 *
 * 新鲜度门禁：renderer bundle 的 mtime 必须晚于 packages/{ui,core,renderer}/src 的最新
 * mtime，否则视为过期——防止测试跑在源码中途状态构建的过期 bundle 上（被测 DOM ≠ 当前
 * 源码，spec 断言对着旧 DOM 报假红）。
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

// renderer bundle 的新鲜度基准 = 渲染层三个包的源码树（vite build 每次全量重写 dist，
// index.html 的 mtime 即最近一次 renderer 构建时点）
const RENDERER_INDEX = path.join(ELECTRON_DIR, 'renderer/dist/index.html')
const RENDERER_SOURCE_ROOTS = [
  path.join(REPO_ROOT, 'packages/ui/src'),
  path.join(REPO_ROOT, 'packages/core/src'),
  path.join(REPO_ROOT, 'packages/renderer/src'),
]

function artifactsMissing(): boolean {
  return ARTIFACTS.some((p) => !fs.existsSync(p))
}

interface NewestSource {
  mtimeMs: number
  file: string
}

function newestSourceChange(roots: string[]): NewestSource {
  let newest: NewestSource = { mtimeMs: 0, file: '' }
  const stack = [...roots]
  while (stack.length > 0) {
    const dir = stack.pop()!
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        const mtimeMs = fs.statSync(full).mtimeMs
        if (mtimeMs > newest.mtimeMs) {
          newest = { mtimeMs, file: path.relative(REPO_ROOT, full) }
        }
      }
    }
  }
  return newest
}

function rendererBundleStale(): NewestSource | null {
  if (!fs.existsSync(RENDERER_INDEX)) return null // 缺失走 artifactsMissing 通道
  const bundleMtimeMs = fs.statSync(RENDERER_INDEX).mtimeMs
  const newest = newestSourceChange(RENDERER_SOURCE_ROOTS)
  return newest.mtimeMs > bundleMtimeMs ? newest : null
}

function runBuildE2e(): void {
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
}

export default async function globalSetup(): Promise<void> {
  // visual-only 运行（CI e2e-visual job，E2E_VISUAL_ONLY=1）只需 chromium + vite（mock），
  // 不需要 Electron 构建产物——直接跳过产物检查，避免 fresh checkout 上触发 build:e2e
  //（electron 行为轨专属，visual 轨不应承担构建开销）。
  if (process.env.E2E_VISUAL_ONLY === '1') {
    console.log('[e2e global-setup] E2E_VISUAL_ONLY=1（visual 轨），跳过 Electron 构建产物检查')
    return
  }
  const staleSource = rendererBundleStale()
  if (staleSource) {
    console.log(
      `[e2e global-setup] 构建产物过期（${staleSource.file} mtime 晚于 renderer bundle），跑 build:e2e ...`,
    )
    runBuildE2e()
    console.log('[e2e global-setup] 构建产物就绪（已按当前源码重建）')
  } else if (artifactsMissing()) {
    console.log('[e2e global-setup] 构建产物缺失，跑 build:e2e ...')
    runBuildE2e()
    console.log('[e2e global-setup] 构建产物就绪')
  } else {
    console.log('[e2e global-setup] 构建产物存在且新鲜（晚于 packages/{ui,core,renderer}/src），跳过 build')
  }
}
