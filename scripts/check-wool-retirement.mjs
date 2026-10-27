#!/usr/bin/env node
/**
 * check-wool-retirement.mjs —— 「羊毛旧界面退役」全仓零残留检查。
 *
 * 拦什么（U6 判据的原样承接）：
 *   1. 退役载体重新出现在盘上（WoolWizard 组件 / useWool* composable / wool locale / 旧测试）
 *   2. 可执行形态的残留引用：`import ... from '.../WoolWizard'`、动态 import、
 *      `<WoolWizard>` / Wool 子组件模板标签、`t('wool.*')` i18n key 取用
 *      （注释里的文字提法不命中——模式只匹配可执行形态）
 *
 * 为什么是脚本而不是 vitest 用例：全仓扫描耗时随仓库文件数单调增长（发起时实测单例
 * 1130ms，占 renderer 全量最长单条），属「静态检查」而非「行为验证」——放测试套件里
 * 每个测试文件都要为它付固定装载成本，且它不验证任何运行时行为。断言集合与阈值
 * （扫描规模下界 500 文件，防「扫描根写错 → 空集合恒绿」）与原用例完全一致。
 *
 * 用法：
 *   node scripts/check-wool-retirement.mjs        # 仓库根或任意 cwd 均可（ROOT 由脚本位置推导）
 *
 * 退出码：0 = 干净；1 = 命中残留；2 = 用法/环境错误
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 退役载体（仓库相对路径）——必须全部不在盘上 */
const RETIRED_PATHS = [
  'packages/renderer/src/components/settings/provider/WoolWizard',
  'packages/renderer/src/components/settings/provider/WoolWizard/WoolWizard.vue',
  'packages/renderer/src/components/settings/provider/WoolWizard/WoolEntryCard.vue',
  'packages/renderer/src/components/settings/provider/__tests__/WoolWizard.test.ts',
  'packages/renderer/src/composables/features/settings/useWool.ts',
  'packages/renderer/src/composables/features/settings/useWoolEntries.ts',
  'packages/renderer/src/composables/features/settings/useWoolWizard.ts',
  'packages/renderer/src/composables/features/settings/__tests__/useWool.test.ts',
  'packages/renderer/src/i18n/locales/zh-CN/wool.ts',
  'packages/renderer/src/i18n/locales/en-US/wool.ts',
]

/** 可执行形态的残留引用模式（注释提法不命中） */
const REFERENCE_PATTERNS = [
  { label: 'import WoolWizard', re: /from\s+['"][^'"]*WoolWizard(?:\/[^'"]*)?['"]/ },
  { label: 'dynamic import WoolWizard', re: /import\(\s*['"][^'"]*WoolWizard[^'"]*['"]\s*\)/ },
  { label: 'import useWool*', re: /from\s+['"][^'"]*\/useWool(?:Entries|Wizard)?(?:\.js)?['"]/ },
  { label: 'WoolWizard tag', re: /<WoolWizard[\s/>]/ },
  { label: 'Wool 子组件 tag', re: /<(?:WoolEntryCard|WoolFamilyCards|WoolOauthFlow|WoolExtractFlow|WoolStepRow)[\s/>]/ },
  { label: 'wool i18n key', re: /\bt\(\s*['"]wool\./ },
]

const SCAN_EXTS = ['.ts', '.vue', '.mts', '.js']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test-results', 'coverage', '.git'])
/** 扫描规模下限（防空集合恒绿）：当前实况远超此值 */
const MIN_SCANNED_FILES = 500

function collectSourceFiles(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      collectSourceFiles(abs, out)
      continue
    }
    if (SCAN_EXTS.some((ext) => name.endsWith(ext))) out.push(abs)
  }
}

const problems = []

for (const rel of RETIRED_PATHS) {
  if (existsSync(join(ROOT, rel))) problems.push(`退役载体仍在盘上：${rel}`)
}

const files = []
const packagesDir = join(ROOT, 'packages')
for (const pkg of readdirSync(packagesDir)) {
  if (!statSync(join(packagesDir, pkg)).isDirectory()) continue
  for (const sub of ['src', 'test']) {
    const dir = join(packagesDir, pkg, sub)
    if (existsSync(dir)) collectSourceFiles(dir, files)
  }
}
for (const top of ['apps', 'e2e', 'extensions', 'scripts']) {
  const dir = join(ROOT, top)
  if (existsSync(dir)) collectSourceFiles(dir, files)
}

if (files.length < MIN_SCANNED_FILES) {
  console.error(
    `[check-wool-retirement] 扫描规模异常：只扫到 ${files.length} 个源文件（下限 ${MIN_SCANNED_FILES}）——`
    + '扫描根或目录结构可能已变，先修扫描逻辑再信任结果',
  )
  process.exit(2)
}

for (const abs of files) {
  const text = readFileSync(abs, 'utf8')
  for (const { label, re } of REFERENCE_PATTERNS) {
    if (re.test(text)) problems.push(`${label}: ${abs.slice(ROOT.length + 1)}`)
  }
}

if (problems.length > 0) {
  console.error(`[check-wool-retirement] 命中 ${problems.length} 条羊毛旧界面残留：`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error('[FIX] 删除残留载体/引用；该界面已退役，不允许重新引入')
  process.exit(1)
}

console.log(`[check-wool-retirement] OK（扫描 ${files.length} 个源文件，退役载体零残留）`)
