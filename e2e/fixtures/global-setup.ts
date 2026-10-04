/**
 * Playwright globalSetup —— 测试启动前确保 Electron 构建产物存在，且 renderer 构建形态与本次轨匹配。
 *
 * 两种情况会跑 build:e2e（build:main + build:preload + build:vite with VITE_E2E）：
 * ① 产物缺失；② renderer 产物形态（mock / real）与本次运行 spec 所需轨形态不一致。
 * 产物齐备且形态匹配则跳过（增量开发时避免每次重建，节省时间）。
 *
 * ── 形态门禁（v-e2e-real-post-w3 失败归因 spec-bug 的根因修复）──────────────────
 * mock 轨与 real 轨共用 apps/electron/renderer/dist（构建期 VITE_MOCK define），旧逻辑只查
 * 产物存在、不查构建形态：mock 轨留下的 mock bundle 被后续 real 轨复用（此处输出
 * 「构建产物已存在，跳过 build」），real spec 全部在 fixture 期 fail-fast（launch-app-real
 * pre-flight「detected mock renderer bundle」）。现按 MOCK_BUNDLE_MARKER（判据 SSOT 与依据
 * 见 fixtures/launch-app.ts 注释）区分 mock/real 变体，变体与轨不匹配即重建——real 构建
 * VITE_E2E=true 且**不传 VITE_MOCK**（并从继承 env 剥离，防外层 shell 泄漏）；mock 构建
 * VITE_E2E=true VITE_MOCK=true。两轨产物形态切换成为运行内建前置，不再依赖手动恢复命令。
 *
 * ── 轨形态判定（本次运行需要哪个变体）────────────────────────────────────────
 * 按被选中 spec 的源码 import 判定（CLI 文件过滤语义同 playwright：对 spec 路径做子串/正则
 * 匹配）：
 * - import fixtures/launch-app-real → real 轨；import fixtures/launch-app（不带 -real）→ mock 轨；
 * - 自我跳过型 real spec 不强制 real 变体（skip 即不 launch，变体错配只表现为跳过而非失败）：
 *   凭证门 TAIJI_PI_LIVE 缺席即 skip（batch 系 / btw 双凭证门范式）、或轨道自保护
 *   （MOCK_BUNDLE_MARKER 判据 + test.skip，mock bundle 在场即带理由 skip）；
 * - 混合轨（同一次运行同时需要两种变体）物理无解（同一 outDir 只能一种形态），不自动重建，
 *   维持现状交 launch pre-flight 的响亮失败 + 恢复命令；无文件过滤的裸跑同理不强制。
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
import type { FullConfig } from '@playwright/test'
// 判据 SSOT（MOCK_BUNDLE_MARKER 与 RENDERER_DIST_ASSETS，判据依据实测注释见 launch-app.ts）
import { RENDERER_DIST_ASSETS, MOCK_BUNDLE_MARKER } from './launch-app'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_DIR = path.join(REPO_ROOT, 'apps/electron')
const E2E_DIR = path.join(REPO_ROOT, 'e2e')

const ARTIFACTS = [
  path.join(ELECTRON_DIR, 'dist/main/main.cjs'),
  path.join(ELECTRON_DIR, 'dist/preload/preload.cjs'),
  path.join(ELECTRON_DIR, 'renderer/dist/index.html'),
]

/** renderer 构建形态（轨形态）：mock = 带 VITE_MOCK 的 mock fixture 构建；real = 不带 VITE_MOCK */
export type BundleVariant = 'mock' | 'real'

const SPEC_FILE_RE = /\.spec\.[cm]?[jt]s$/

function artifactsMissing(): boolean {
  return ARTIFACTS.some((p) => !fs.existsSync(p))
}

/** 当前 renderer 产物形态（null = assets 缺失/空，无从判定） */
export function detectCurrentBundleVariant(): BundleVariant | null {
  if (!fs.existsSync(RENDERER_DIST_ASSETS)) return null
  const jsFiles = fs.readdirSync(RENDERER_DIST_ASSETS).filter((f) => f.endsWith('.js'))
  if (jsFiles.length === 0) return null
  // assets 约 8MB / 138 个 js——逐文件 includes 约几十毫秒，globalSetup 每 run 一次
  const mockHit = jsFiles.some((f) =>
    fs.readFileSync(path.join(RENDERER_DIST_ASSETS, f), 'utf8').includes(MOCK_BUNDLE_MARKER),
  )
  return mockHit ? 'mock' : 'real'
}

/** spec 源码 import 判定所需变体（null = 与轨形态无关，或自我跳过型不强制） */
function specVariant(file: string): BundleVariant | null {
  let src: string
  try {
    src = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const usesReal = src.includes('fixtures/launch-app-real')
  if (usesReal) {
    // 自我跳过型 real spec（不强制变体）：
    // ① 轨道自保护（mockBundleSkipReason 范式：MOCK_BUNDLE_MARKER 判据 + test.skip）；
    // ② 凭证门（TAIJI_PI_LIVE 双凭证门范式）——env 缺席即 skip 不 launch。
    if (src.includes('MOCK_BUNDLE_MARKER') && src.includes('test.skip')) return null
    if (src.includes('TAIJI_PI_LIVE') && process.env['TAIJI_PI_LIVE'] !== '1') return null
    return 'real'
  }
  if (src.includes('fixtures/launch-app')) return 'mock'
  return null
}

function listAllSpecFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (SPEC_FILE_RE.test(entry.name)) out.push(p)
    }
  }
  if (fs.existsSync(E2E_DIR)) walk(E2E_DIR)
  return out
}

/** playwright CLI 的文件过滤（test 子命令后非 flag 参数；语义 = 对 test 文件路径的子串/正则匹配） */
/** process.argv 的脚本参数偏移（[node, script, ...args]） */
const PROCESS_ARGV_SCRIPT_OFFSET = 2

function specFileFilters(argv: string[]): string[] {
  const start = argv.indexOf('test')
  const rest = start >= 0 ? argv.slice(start + 1) : argv.slice(PROCESS_ARGV_SCRIPT_OFFSET)
  return rest.filter((a) => a.length > 0 && !a.startsWith('-'))
}

function matchesFilter(absPath: string, filter: string): boolean {
  const norm = absPath.split(path.sep).join('/')
  if (norm.toLowerCase().includes(filter.toLowerCase())) return true
  try {
    return new RegExp(filter, 'i').test(norm)
  } catch {
    return false
  }
}

/**
 * 本次运行需要的产物形态（null = 不强制：无文件过滤的裸跑 / 选中集无定向 / 混合轨）。
 */
export function requiredBundleVariant(argv: string[]): BundleVariant | null {
  const filters = specFileFilters(argv)
  if (filters.length === 0) return null
  const selected = listAllSpecFiles().filter((f) => filters.some((flt) => matchesFilter(f, flt)))
  if (selected.length === 0) return null
  const needs = new Set<BundleVariant>()
  for (const f of selected) {
    const v = specVariant(f)
    if (v) needs.add(v)
  }
  // 0 = 全部与形态无关；≥2 = 混合轨（物理无解）——都不强制
  if (needs.size !== 1) return null
  return needs.values().next().value ?? null
}

/** 按指定形态跑 build:e2e（real 剥离继承的 VITE_MOCK，mock 显式带 VITE_MOCK:true） */
function buildE2E(variant: BundleVariant): void {
  // VITE_E2E=true 必须透传给 renderer 构建（vite.config.ts define 读此注入 sample-project cwd）
  // VITE_MOCK=true 决定 renderer 构建形态（mock fixture 链是否进 bundle）：mock 变体必须带、
  // real 变体必须不带——并从继承 env 剥离，防外层 shell 泄漏把 real 构建成 mock
  const env: NodeJS.ProcessEnv = { ...process.env, VITE_E2E: 'true' }
  if (variant === 'mock') env.VITE_MOCK = 'true'
  else delete env.VITE_MOCK
  execSync('pnpm run build:e2e', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env,
    timeout: 180_000,
  })
}

/**
 * 产物就绪保障：齐备且形态匹配则跳过 build；缺失 / 形态失配则按本次轨形态重建并校验
 * （校验与收尾日志拆到 verifyRebuiltArtifacts——globalSetup 只做 visual 轨短路 + 参数解析）。
 */
function ensureArtifacts(required: BundleVariant | null, current: BundleVariant | null): void {
  const missing = artifactsMissing()
  const mismatch = required !== null && current !== null && required !== current

  if (!missing && !mismatch) {
    console.log(
      `[e2e global-setup] 构建产物已存在（renderer ${current ?? '形态未知'} bundle` +
        (required ? `，与本次轨所需 ${required} 匹配` : '') +
        '），跳过 build',
    )
    return
  }

  // 产物缺失时按本次轨形态构建（无定向时沿用 mock 形态——既有默认行为）；
  // 形态失配时强制按所需形态重建（形态切换成为运行内建前置，不再依赖手动恢复命令）
  const variant: BundleVariant = required ?? 'mock'
  console.log(
    missing
      ? `[e2e global-setup] 构建产物缺失，跑 build:e2e（${variant} bundle）...`
      : `[e2e global-setup] renderer bundle 形态失配（当前 ${current}，本次轨需 ${required}），重建 ${variant} bundle ...`,
  )
  buildE2E(variant)
  const after = verifyRebuiltArtifacts(required)
  console.log(`[e2e global-setup] 构建产物就绪（renderer ${after ?? '形态未知'} bundle）`)
}

/** 重建后校验：产物齐备且形态与本次轨所需一致，不符即 throw（fail-fast，不静默带病续跑） */
function verifyRebuiltArtifacts(required: BundleVariant | null): BundleVariant | null {
  if (artifactsMissing()) {
    throw new Error('[e2e global-setup] build:e2e 完成后产物仍缺失：' + ARTIFACTS.filter((p) => !fs.existsSync(p)).join(', '))
  }
  const after = detectCurrentBundleVariant()
  if (required !== null && after !== required) {
    throw new Error(
      `[e2e global-setup] build:e2e 后 renderer 产物形态仍为 ${after ?? '形态未知'} bundle，` +
        `与本次轨所需 ${required} 不符——检查构建 env（mock 需 VITE_MOCK=true，real 需不传 VITE_MOCK）`,
    )
  }
  return after
}

export default async function globalSetup(config?: FullConfig): Promise<void> {
  // visual-only 运行（CI e2e-visual job，E2E_VISUAL_ONLY=1）只需 chromium + vite（mock），
  // 不需要 Electron 构建产物——直接跳过产物检查，避免 fresh checkout 上触发 build:e2e
  //（electron 行为轨专属，visual 轨不应承担构建开销）。
  if (process.env.E2E_VISUAL_ONLY === '1') {
    console.log('[e2e global-setup] E2E_VISUAL_ONLY=1（visual 轨），跳过 Electron 构建产物检查')
    return
  }

  ensureArtifacts(requiredBundleVariant(config?.argv ?? process.argv), detectCurrentBundleVariant())
}
