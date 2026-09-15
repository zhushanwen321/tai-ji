/**
 * 反向守卫：`panel.*` 与 `settings.providerEdit.*` 的 locale 叶子 key 必须被源码消费。
 *
 * 存在动机（docs/design/coding-plan-quota-config-ux.impl-plan.md §7 残留风险 9）：
 * 仓库已有「引用 → 存在」守卫（provider-edit-key-existence.test.ts，防裸 key 透出），
 * 但没有反方向守卫，于是多年迭代后 locale 里沉淀了大量零引用死键（本守卫落地时
 * 一次清扫了 97 条，见 commit message）。本测试补上「存在 → 被引用」这条通路。
 *
 * 判定语义：
 * - 消费者 = 仓库源码里的字面全路径引用（`t('panel.x.y')`、key 映射表里的字符串等）。
 *   `__tests__` / `*.test.*` / `e2e/` 不算消费者——测试断言只能证明「key 存在」，
 *   不能证明 UI 会渲染它（否则给死键补一行断言就能让守卫永远绿）。
 * - 消费者之外，唯一合法豁免是 ALLOWLIST 里的显式条目（常量数组 + 逐条理由）。
 *   禁止整段正则/目录豁免——那会把守卫变成橡皮图章。
 *
 * 自证不空转（防「扫描根写错 → 空集合恒绿」）：
 * - 叶子 key 数量与被引用数量都有下界断言；
 * - allowlist 必须与「实际零引用集合」精确相等——已恢复引用的 key 留在 allowlist 里
 *   同样会红，强制清理过期豁免。
 *
 * 扫描范围：仓库根由 import.meta.url 相对推导（不写死绝对路径），排除
 * node_modules / dist / .git / test-results 等产物目录与 locale 目录本体。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/i18n/locale-key-usage-guard.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import zhPanel from '../../i18n/locales/zh-CN/panel'
import zhSettings from '../../i18n/locales/zh-CN/settings'

type LocaleNode = { [key: string]: string | LocaleNode }

/** 仓库根：本文件位于 packages/renderer/src/__tests__/i18n/，上溯 5 级 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** 扫描的源码后缀（先明确集合，避免把产物/文档/二进制读进来） */
const SOURCE_EXT = /\.(vue|ts|tsx|js|jsx|mjs|cjs)$/
/** 不递归进入的目录（产物 / 依赖 / 版本库 / 测试结果 / harness 记录） */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'dist-electron',
  'out',
  'build',
  'coverage',
  'test-results',
  '.git',
  '.vite',
  'release',
  '.taiji-harness',
])
/** 测试文件不算消费者（理由见文件头） */
const TEST_PATH = new RegExp(`${sep}__tests__${sep}|${sep}e2e${sep}|\\.test\\.|\\.spec\\.`)

/**
 * 显式 allowlist：零字面引用但允许保留的 key。
 * 每条必须写清「为什么留」；动态组装可达的必须写明构造点 file:line。
 * 当前无动态组装可达项（生产源码里 `panel.*` / `settings.providerEdit.*` 全部是字面引用；
 * 仅测试文件存在 `panel.sideDrawer.${k}` / `panel.trace.${k}` / `panel.context.${key}` 形式的
 * 模板拼接，而测试不是消费者，故不为它们开豁免）。
 */
const ALLOWLIST: readonly { key: string; reason: string }[] = []

/** 拍平嵌套 locale 对象为叶子 key 全路径 */
function flattenLeaves(node: LocaleNode, prefix: string): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(node)) {
    const full = `${prefix}.${key}`
    if (value !== null && typeof value === 'object') out.push(...flattenLeaves(value, full))
    else out.push(full)
  }
  return out
}

/**
 * 扫全仓源码收集字面引用：对每个命名空间，把「命名空间 + 后续点分路径 + 引号收尾」
 * 整体取出（贪婪匹配到引号），因此更长的 key 不会被截断成短 key。
 */
function collectLiteralRefs(namespaces: readonly string[]): Set<string> {
  const refs = new Set<string>()
  const patterns = namespaces.map(
    (ns) => new RegExp(`\\b(${ns.replace(/\./g, '\\.')}\\.[A-Za-z0-9_.]+)(?=["'\`])`, 'g'),
  )
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) walk(full)
        continue
      }
      if (!SOURCE_EXT.test(entry.name)) continue
      if (full.includes(`${sep}i18n${sep}locales${sep}`)) continue
      if (TEST_PATH.test(relative(REPO_ROOT, full))) continue
      const source = readFileSync(full, 'utf-8')
      if (!namespaces.some((ns) => source.includes(`${ns}.`))) continue
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) refs.add(match[1])
      }
    }
  }
  walk(REPO_ROOT)
  return refs
}

const NAMESPACES = ['panel', 'settings.providerEdit'] as const
const LEAVES: Record<(typeof NAMESPACES)[number], string[]> = {
  panel: flattenLeaves(zhPanel as unknown as LocaleNode, 'panel'),
  'settings.providerEdit': flattenLeaves(
    (zhSettings as unknown as { providerEdit: LocaleNode }).providerEdit,
    'settings.providerEdit',
  ),
}

/**
 * 扫描通路自证下界（防空集合恒绿）。数值取当前真实量的安全打折值：
 * panel 369 / providerEdit 165 叶子、全仓扫到 500+ 引用——下界留在明显低于实况的档位，
 * 避免正常增删 key 触发假红，又足以在扫描根写错/正则失效时立刻暴露。
 */
const MIN_PANEL_LEAVES = 300
const MIN_PROVIDER_EDIT_LEAVES = 100
const MIN_SCANNED_REFS = 300

const REFS = collectLiteralRefs(NAMESPACES)
const UNREFERENCED = NAMESPACES.flatMap((ns) => LEAVES[ns].filter((key) => !REFS.has(key)))
const ALLOWED = new Set(ALLOWLIST.map((entry) => entry.key))

describe('locale 反向守卫：panel.* / settings.providerEdit.* 无零引用死键', () => {
  it('扫描通路有效：叶子 key 与被引用数量都有合理下界（防空集合恒绿）', () => {
    expect(LEAVES.panel.length).toBeGreaterThan(MIN_PANEL_LEAVES)
    expect(LEAVES['settings.providerEdit'].length).toBeGreaterThan(MIN_PROVIDER_EDIT_LEAVES)
    expect(REFS.size).toBeGreaterThan(MIN_SCANNED_REFS)
  })

  it('每个叶子 key 都被仓库源码引用（或登记在 ALLOWLIST）', () => {
    const problems = UNREFERENCED.filter((key) => !ALLOWED.has(key))
    const detail = problems
      .map(
        (key) =>
          `  - ${key}\n` +
          '      处置二选一：\n' +
          '        (1) 删键 —— 在 packages/renderer/src/i18n/locales/{zh-CN,en-US}/ 对应文件里同号删除\n' +
          '            （locale-sync-check 守卫要求双侧键集合一致，只删一侧会红）；\n' +
          '        (2) 保留 —— 仅当存在动态组装可达时，把 key 加入本文件顶部的 ALLOWLIST 常量，\n' +
          '            并在 reason 里写明「由哪一处、什么形式可达（file:line）」；无动态可达不得豁免。',
      )
      .join('\n')
    expect(
      problems,
      `以下 ${problems.length} 个 ${NAMESPACES.join(' / ')} 叶子 key 在仓库源码中零引用（疑似死键）：\n${detail}`,
    ).toEqual([])
  })

  it('ALLOWLIST 无过期条目：登记为豁免的 key 必须当前确实零引用', () => {
    const stale = ALLOWLIST.map((entry) => entry.key).filter((key) => !UNREFERENCED.includes(key))
    expect(
      stale,
      `以下 ALLOWLIST 条目已恢复（或本就存在）源码引用，属过期豁免，请从 ALLOWLIST 删除：\n${stale
        .map((key) => `  - ${key}`)
        .join('\n')}`,
    ).toEqual([])
  })
})
