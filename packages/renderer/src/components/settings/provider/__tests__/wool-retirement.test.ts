/**
 * 羊毛旧界面退役断言（provider-plugin-access U6：WoolWizard / useWool* 删除后零残留引用）。
 *
 * 断言两件事：
 *  1) 退役载体已不在盘上（WoolWizard/ 六文件 + useWool / useWoolEntries / useWoolWizard +
 *     wool i18n 词条 + 两个随源测试）；
 *  2) 全仓源码零引用——import / import() / 模板标签 / wool.* i18n key 四类形态均不命中
 *     （注释里提到退役事实不算引用：模式只匹配可执行形态）。
 *
 * 扫描范围 = packages/* 的 src 与 test 目录（不含 node_modules / dist / test-results），
 * 扩展名 .ts / .vue / .mts / .js。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/provider
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** packages/renderer/src/components/settings/provider/__tests__ → 仓库根 */
const REPO_ROOT = resolve(HERE, '../../../../../../..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

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
const REFERENCE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'import WoolWizard', re: /from\s+['"][^'"]*WoolWizard(?:\/[^'"]*)?['"]/ },
  { label: 'dynamic import WoolWizard', re: /import\(\s*['"][^'"]*WoolWizard[^'"]*['"]\s*\)/ },
  { label: 'import useWool*', re: /from\s+['"][^'"]*\/useWool(?:Entries|Wizard)?(?:\.js)?['"]/ },
  { label: 'WoolWizard tag', re: /<WoolWizard[\s/>]/ },
  { label: 'Wool 子组件 tag', re: /<(?:WoolEntryCard|WoolFamilyCards|WoolOauthFlow|WoolExtractFlow|WoolStepRow)[\s/>]/ },
  { label: 'wool i18n key', re: /\bt\(\s*['"]wool\./ },
]

const SCAN_EXTS = ['.ts', '.vue', '.mts', '.js']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test-results', 'coverage', '.git'])

function collectSourceFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) {
      collectSourceFiles(abs, out)
      continue
    }
    if (SCAN_EXTS.some((ext) => name.endsWith(ext))) out.push(abs)
  }
}

describe('羊毛旧界面退役（U6 零残留引用）', () => {
  it('退役载体不在盘上', () => {
    for (const rel of RETIRED_PATHS) {
      expect(existsSync(join(REPO_ROOT, rel)), `应已删除：${rel}`).toBe(false)
    }
  })

  it('全仓源码零引用（import / 动态 import / 模板标签 / wool.* i18n key）', () => {
    const files: string[] = []
    const pkgNames = readdirSync(PACKAGES_DIR).filter((n) => statSync(join(PACKAGES_DIR, n)).isDirectory())
    for (const pkg of pkgNames) {
      for (const sub of ['src', 'test']) {
        const dir = join(PACKAGES_DIR, pkg, sub)
        if (existsSync(dir)) collectSourceFiles(dir, files)
      }
    }
    // 其余一级源码目录（非 packages）
    for (const top of ['apps', 'e2e', 'extensions', 'scripts']) {
      const dir = join(REPO_ROOT, top)
      if (existsSync(dir)) collectSourceFiles(dir, files)
    }
    // 扫描规模下限自查（防「零文件扫描 → 全绿」的假阳性）
    expect(files.length).toBeGreaterThan(500)

    const hits: string[] = []
    for (const abs of files) {
      const text = readFileSync(abs, 'utf8')
      for (const { label, re } of REFERENCE_PATTERNS) {
        if (re.test(text)) hits.push(`${label}: ${abs.slice(REPO_ROOT.length + 1)}`)
      }
    }
    expect(hits).toEqual([])
  })
})
