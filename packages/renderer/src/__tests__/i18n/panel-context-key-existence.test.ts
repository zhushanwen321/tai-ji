/**
 * panel.context 命名空间的 i18n key 存在性机器闸门（同款机制见 provider-edit-key-existence.test.ts）。
 *
 * 防的回归：组件把 t('panel.context.x') 新增/改名之后，若 locale 双侧（zh-CN / en-US）
 * 同时缺同一个 key，用户会看到裸 key（渲染出 panel.context.x 字符串）而现有守卫仍全绿：
 * - locale-sync-check 只比对双侧 key 集合一致，双侧同时缺同一个 key 抓不到；
 * - locale-key-usage-guard（存在 → 被引用的反向守卫）不校验「引用侧必有 locale」；
 * - provider-edit-key-existence 只扫 settings.providerEdit 前缀，不覆盖 panel.context。
 * 本守卫补齐 panel.context 这条「UI 引用了 → locale 必须有」的通路。
 *
 * 机制：扫 packages/ui/src 与 packages/renderer/src（排除 locale 文件与测试目录）
 * 中所有 `panel.context.<key>` 字面引用——要求 key 后紧跟引号/反引号收尾，动态拼接
 * `panel.context.${x}` 模板片段不会被误收（也不会假红）。
 * 对每个 key 断言其在 zh-CN / en-US 的 panel locale `context` 节点中都存在且为非空字符串。
 *
 * 自证不空转（防「扫描根写错 → 空集合恒绿」）：扫到的引用 key 数量有下界断言。
 *
 * 测试框架：vitest。运行：cd packages/renderer && npx vitest run src/__tests__/i18n/panel-context-key-existence.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import zhPanel from '../../i18n/locales/zh-CN/panel'
import enPanel from '../../i18n/locales/en-US/panel'

const REPO_ROOT = resolve(__dirname, '../../../../..')
/** panel.context key 的源码消费根；locale 与测试自身不算消费方 */
const SCAN_ROOTS = [join(REPO_ROOT, 'packages/ui/src'), join(REPO_ROOT, 'packages/renderer/src')]
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist'])
const SOURCE_EXT = /\.(vue|ts|js|mjs)$/
/** `panel.context.<key>` 且 key 后紧跟引号/反引号收尾（动态拼接不匹配） */
const KEY_REF = /panel\.context\.([A-Za-z0-9_]+)(?=["'`])/g

/**
 * 扫描通路自证下界（防空集合恒绿）。当前生产源码静态引用 40+ 个 context key
 * （ContextCapacityPopover / ContextChipsBar / GenStatsTriggers / useQuotaDisplay 等），
 * 下界留在明显低于实况的档位，避免正常增删 key 触发假红，又足以在扫描根写错 /
 * 正则失效时立刻暴露。
 */
const MIN_SCANNED_REFS = 30

type FlatLocale = Record<string, string | undefined>

const ZH_CONTEXT = (zhPanel as unknown as { context: FlatLocale }).context
const EN_CONTEXT = (enPanel as unknown as { context: FlatLocale }).context

/** 扫源码收集 `panel.context.<key>` 引用；同 key 只记首个出现文件（用于报错定位） */
function collectSourceRefs(): Map<string, string> {
  const refs = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
        continue
      }
      if (!SOURCE_EXT.test(entry.name)) continue
      if (full.includes(`${sep}i18n${sep}locales${sep}`)) continue
      for (const m of readFileSync(full, 'utf-8').matchAll(KEY_REF)) {
        if (!refs.has(m[1])) refs.set(m[1], full)
      }
    }
  }
  for (const root of SCAN_ROOTS) walk(root)
  return refs
}

describe('panel.context i18n key 存在性机器闸门', () => {
  const refs = collectSourceRefs()

  it('源码扫描通路有效（扫到的 key 数量足以证明根路径与正则生效）', () => {
    expect(
      refs.size,
      '未从 packages/ui/src + packages/renderer/src 扫到足量 panel.context key，扫描根/正则可能失效',
    ).toBeGreaterThan(MIN_SCANNED_REFS)
  })

  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: 每个被源码引用的 panel.context key 都存在且非空`, () => {
      const context = locale === 'zh-CN' ? ZH_CONTEXT : EN_CONTEXT
      const problems: string[] = []
      for (const [key, file] of refs) {
        const value = context[key]
        if (typeof value !== 'string' || value.trim().length === 0) {
          problems.push(`panel.context.${key}（引用自 ${relative(REPO_ROOT, file)}）`)
        }
      }
      expect(problems, `${locale} 缺失/空值 key:\n${problems.join('\n')}`).toEqual([])
    })
  }
})
