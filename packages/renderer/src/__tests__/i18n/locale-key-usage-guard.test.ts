// @vitest-environment node

/**
 * 反向检查：`panel.*` / `settings.providerEdit.*` / `composable.*` 的 locale 叶子 key 必须被源码消费。
 *
 * 存在动机：
 * 仓库已有「引用 → 存在」检查（provider-edit-key-existence.test.ts，防裸 key 透出），
 * 但没有反方向检查，于是多年迭代后 locale 里积累了大量零引用死键（本检查落地时
 * 一次清扫了 97 条，见 commit message）。本测试补上「存在 → 被引用」这条通路。
 *
 * 判定语义：
 * - 消费者 = 仓库源码里的字面全路径引用（`t('panel.x.y')`、key 映射表里的字符串等）。
 *   `__tests__` / `*.test.*` / `e2e/` 不算消费者——测试断言只能证明「key 存在」，
 *   不能证明 UI 会渲染它（否则给死键补一行断言就能让检查永远绿）。
 * - 消费者之外，唯一合法豁免是 ALLOWLIST 里的显式条目（常量数组 + 逐条理由）。
 *   禁止整段正则/目录豁免——那会把检查变成橡皮图章。
 *
 * 自证不空转（防「扫描根写错 → 空集合恒绿」）：
 * - 叶子 key 数量与被引用数量都有下界断言；
 * - allowlist 必须与「实际零引用集合」精确相等——已恢复引用的 key 留在 allowlist 里
 *   同样会红，强制清理过期豁免。
 *
 * 扫描范围：仓库根由 import.meta.url 相对推导（不写死绝对路径），排除
 * node_modules / dist / .git / test-results 等产物目录与 locale 目录本体。
 *
 * 单文件多源合并（3 源同装载簇，全 node 环境源码扫描/locale 断言、零 vi.mock）：
 * locale-key-usage-guard（本节，最大源）+ provider-edit-key-existence +
 * usage-definition-check——三者路径推导均基于 __dirname / import.meta.url 的同目录
 * 相对上溯（合并文件仍在本目录，推导不变），扫描器均排除 __tests__（不自扫）。
 * 各节以裸块隔离节内常量与 helper（REPO_ROOT / SKIP_DIRS 等同名异值常量不串）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/i18n/locale-key-usage-guard.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import zhPanel from '@taiji/ui/locale/zh-CN/panel'
import enPanel from '@taiji/ui/locale/en-US/panel'
import zhSettings from '@taiji/ui/locale/zh-CN/settings'
import enSettings from '@taiji/ui/locale/en-US/settings'
import zhComposable from '@taiji/ui/locale/zh-CN/composable'
import zhCN from '../../i18n/locales/zh-CN'

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
const SUBAGENT_MODEL_SOURCE_REASON =
  '动态组装可达：packages/renderer/src/composables/features/subagent/useSubagentModel.ts:358 ' +
  '(`panel.sideDrawer.subagentModelSource.${source}`) 与 :362 ' +
  '(`panel.sideDrawer.subagentModelSourceTitle.${source}`)，source 取值域 = SubagentModelSource ' +
  '(packages/shared/src/subagent.ts:44, 即 explicit/frontmatter/preference/default)'

const ALLOWLIST: readonly { key: string; reason: string }[] = [
  { key: 'panel.sideDrawer.subagentModelSource.explicit', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSource.frontmatter', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSource.preference', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSource.default', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSourceTitle.explicit', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSourceTitle.frontmatter', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSourceTitle.preference', reason: SUBAGENT_MODEL_SOURCE_REASON },
  { key: 'panel.sideDrawer.subagentModelSourceTitle.default', reason: SUBAGENT_MODEL_SOURCE_REASON },
  // chat-flow-consistency U1 停止/截断提示行：key 由 core notice-text.ts:40 动态组装
  //（`panel.message.chatNotice.${key}`，ChatNoticeKey 闭集枚举）经 useMessageEffects.ts:40
  // 的 translator 注入消费——静态字面扫描不可达，动态组装闭集登记于此。
  { key: 'panel.message.chatNotice.stoppedBeforeStart', reason: 'core notice-text ChatNoticeKey 闭集动态组装（notice-text.ts:40 + useMessageEffects.ts:40 translator 注入）' },
  { key: 'panel.message.chatNotice.truncatedMaxTokens', reason: 'core notice-text ChatNoticeKey 闭集动态组装（notice-text.ts:40 + useMessageEffects.ts:40 translator 注入）' },
  { key: 'panel.message.chatNotice.truncatedContentFilter', reason: 'core notice-text ChatNoticeKey 闭集动态组装（notice-text.ts:40 + useMessageEffects.ts:40 translator 注入）' },
]

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

const NAMESPACES = ['panel', 'settings.providerEdit', 'composable'] as const
const LEAVES: Record<(typeof NAMESPACES)[number], string[]> = {
  panel: flattenLeaves(zhPanel as unknown as LocaleNode, 'panel'),
  'settings.providerEdit': flattenLeaves(
    (zhSettings as unknown as { providerEdit: LocaleNode }).providerEdit,
    'settings.providerEdit',
  ),
  composable: flattenLeaves(zhComposable as unknown as LocaleNode, 'composable'),
}

/**
 * 扫描通路自证下界（防空集合恒绿）。数值取当前真实量的安全打折值：
 * panel 369 / providerEdit 165 / composable 40 叶子、全仓扫到 500+ 引用——下界留在明显低于
 * 实况的档位，避免正常增删 key 触发假红，又足以在扫描根写错/正则失效时立刻暴露。
 */
const MIN_PANEL_LEAVES = 300
const MIN_PROVIDER_EDIT_LEAVES = 100
const MIN_COMPOSABLE_LEAVES = 30
const MIN_SCANNED_REFS = 300

const REFS = collectLiteralRefs(NAMESPACES)
const UNREFERENCED = NAMESPACES.flatMap((ns) => LEAVES[ns].filter((key) => !REFS.has(key)))
const ALLOWED = new Set(ALLOWLIST.map((entry) => entry.key))

describe('locale 反向检查：panel.* / settings.providerEdit.* / composable.* 无零引用死键', () => {
  it('扫描通路有效：叶子 key 与被引用数量都有合理下界（防空集合恒绿）', () => {
    expect(LEAVES.panel.length).toBeGreaterThan(MIN_PANEL_LEAVES)
    expect(LEAVES['settings.providerEdit'].length).toBeGreaterThan(MIN_PROVIDER_EDIT_LEAVES)
    expect(LEAVES.composable.length).toBeGreaterThan(MIN_COMPOSABLE_LEAVES)
    expect(REFS.size).toBeGreaterThan(MIN_SCANNED_REFS)
  })

  it('每个叶子 key 都被仓库源码引用（或登记在 ALLOWLIST）', () => {
    const problems = UNREFERENCED.filter((key) => !ALLOWED.has(key))
    const detail = problems
      .map(
        (key) =>
          `  - ${key}\n` +
          '      处置二选一：\n' +
          '        (1) 删键 —— 在 packages/ui/src/locale/{zh-CN,en-US}/ 对应文件里同号删除\n' +
          '            （locale-sync-check 检查要求双侧键集合一致，只删一侧会红）；\n' +
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

/** 按「Allowlist 键形态 = 动态组装可达」的前提，正向断言这些键在真实 locale 消息里可解析出文案 */
function resolveLocaleKey(messages: unknown, key: string): unknown {
  const path = key.split('.')
  return path.slice(1).reduce<unknown>(
    (node, segment) =>
      node !== null && typeof node === 'object'
        ? (node as Record<string, unknown>)[segment]
        : undefined,
    messages,
  )
}

describe('ALLOWLIST 动态组装键的真实 i18n 解析断言', () => {
  it.each([
    ['zh-CN', zhPanel],
    ['en-US', enPanel],
  ] as const)('%s：每个动态组装键都解析到非空字符串（防键形态错配退化为显示键名）', (_locale, messages) => {
    for (const entry of ALLOWLIST) {
      const resolved = resolveLocaleKey(messages, entry.key)
      expect(resolved, `key ${entry.key} 在 ${_locale} locale 中不可解析`).toEqual(expect.any(String))
      expect(resolved as string).not.toBe('')
      expect(resolved as string).not.toBe(entry.key)
    }
  })
})


// ══════════ 来源：provider-edit-key-existence.test.ts ══════════
{

const REPO_ROOT = resolve(__dirname, '../../../../..')
/** providerEdit key 的源码消费根；locale 与测试自身不算消费方 */
const SCAN_ROOTS = [join(REPO_ROOT, 'packages/ui/src'), join(REPO_ROOT, 'packages/renderer/src')]
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist'])
const SOURCE_EXT = /\.(vue|ts|js|mjs)$/
/** `providerEdit.<key>` 且 key 后紧跟引号/反引号收尾（动态拼接不匹配） */
const KEY_REF = /providerEdit\.([A-Za-z0-9_]+)(?=["'`])/g
/**
 * `panel.context.quotaFail<Reason>` 字面引用（reason→key 映射表消费，见 useQuotaQuery.ts
 * QUOTA_FAIL_REASON_KEYS）。原 quota-reason-i18n.test.ts 的显式数组职责由本扫描吸收
 * （该数组范式曾自证失败：数组漏列 → 删 locale 值仍全绿，见原文件头 U-3 补齐记录）。
 * 限定 quotaFail 前缀：panel.context 下非 quota 语义的 key 不在本检查范围。 */
const PANEL_CONTEXT_KEY_REF = /panel\.context\.(quotaFail[A-Za-z0-9_]+)(?=["'`])/g

/** 本改动新增的 providerEdit key（locale 基线 62a9651e5 → HEAD 的 providerEdit 新增键全量） */
const NEW_UI_KEYS_REQUIRED = [
  'quotaTypeFirstHint',
  'quotaEnableHintIdle',
  'quotaProviderCredentialMissing',
  'quotaProviderCredentialPendingSave',
  'quotaExclusiveKeyPlaceholder',
  'quotaCredentialSourceLabel',
  'quotaSourceProvider',
  'quotaSourceExclusive',
  'quotaSourceProviderOauthHint',
  'quotaSourceProviderApiKeyHint',
  'quotaSourceExclusiveHint',
  'quotaConfigureFail',
  'quotaSaveAndTest',
  'quotaSaveAndTestRunning',
  'quotaReadyHint',
  'quotaMissingCookie',
  'quotaMissingApiKey',
  'quotaMissingWorkspace',
  'quotaSaveAndTestFail',
  'quotaFetchFailUnauthorizedCookie',
  'quotaFetchFailNoCredential',
  'quotaFetchFailNoCredentialCookie',
  'quotaRequiredBadge',
  'quotaConfiguredBadge',
] as const

type FlatLocale = Record<string, string | undefined>

const ZH_PROVIDER_EDIT = (zhSettings as unknown as { providerEdit: FlatLocale }).providerEdit
const EN_PROVIDER_EDIT = (enSettings as unknown as { providerEdit: FlatLocale }).providerEdit

/** 扫源码收集 `providerEdit.<key>` / `panel.context.quotaFail*` 引用；同 key 只记首个出现文件（用于报错定位） */
function collectSourceRefs(ref: RegExp): Map<string, string> {
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
      for (const m of readFileSync(full, 'utf-8').matchAll(ref)) {
        if (!refs.has(m[1])) refs.set(m[1], full)
      }
    }
  }
  for (const root of SCAN_ROOTS) walk(root)
  return refs
}

describe('providerEdit i18n key 存在性机器门禁（U-3）', () => {
  const refs = collectSourceRefs(KEY_REF)
  // panel.context quotaFail 简短文案（原 quota-reason-i18n.test.ts 的 panel.context describe 并入）
  const panelContextRefs = collectSourceRefs(PANEL_CONTEXT_KEY_REF)

  it('源码扫描通路有效（扫到的 key 数量足以证明根路径与正则生效）', () => {
    expect(
      refs.size,
      '未从 packages/ui/src + packages/renderer/src 扫到足量 providerEdit key，扫描根/正则可能失效',
    ).toBeGreaterThan(100)
  })

  it('panel.context 扫描通路有效（quotaFail key 下界自证，防空集合恒绿）', () => {
    expect(
      panelContextRefs.size,
      `panel.context.quotaFail 扫描数量异常（期望 ≥6 个 reason 映射，实得 ${panelContextRefs.size}），扫描根/正则可能失效`,
    ).toBeGreaterThanOrEqual(6)
  })

  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: 本改动新增的 ${NEW_UI_KEYS_REQUIRED.length} 个 providerEdit key 都存在且非空`, () => {
      const providerEdit = locale === 'zh-CN' ? ZH_PROVIDER_EDIT : EN_PROVIDER_EDIT
      const missing = NEW_UI_KEYS_REQUIRED.filter((key) => {
        const value = providerEdit[key]
        return typeof value !== 'string' || value.trim().length === 0
      })
      expect(missing, `${locale} 缺失/空值的新增 key: ${missing.join(', ')}`).toEqual([])
    })
  }

  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: 每个被 UI/renderer 源码引用的 providerEdit key 都存在且非空`, () => {
      const providerEdit = locale === 'zh-CN' ? ZH_PROVIDER_EDIT : EN_PROVIDER_EDIT
      const problems: string[] = []
      for (const [key, file] of refs) {
        const value = providerEdit[key]
        if (typeof value !== 'string' || value.trim().length === 0) {
          problems.push(`${key}（引用自 ${relative(REPO_ROOT, file)}）`)
        }
      }
      expect(problems, `${locale} 缺失/空值 key:\n${problems.join('\n')}`).toEqual([])
    })
  }

  const ZH_PANEL_CONTEXT = (zhPanel as unknown as { context: FlatLocale }).context
  const EN_PANEL_CONTEXT = (enPanel as unknown as { context: FlatLocale }).context
  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: 每个被源码引用的 panel.context.quotaFail key 都存在且非空`, () => {
      const context = locale === 'zh-CN' ? ZH_PANEL_CONTEXT : EN_PANEL_CONTEXT
      const problems: string[] = []
      for (const [key, file] of panelContextRefs) {
        const value = context[key]
        if (typeof value !== 'string' || value.trim().length === 0) {
          problems.push(`${key}（引用自 ${relative(REPO_ROOT, file)}）`)
        }
      }
      expect(problems, `${locale} 缺失/空值 key:\n${problems.join('\n')}`).toEqual([])
    })
  }
})

}

// ══════════ 来源：usage-definition-check.test.ts ══════════
{

// ── 定义面：聚合树叶子路径全集 ──────────────────────────────────────────────

const definedLeafKeys = new Set<string>()

function collectPaths(node: unknown, prefix: string): void {
  if (node === null || typeof node !== 'object') {
    definedLeafKeys.add(prefix)
    return
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    collectPaths(v, prefix ? `${prefix}.${k}` : k)
  }
}

collectPaths(zhCN, '')
const namespaces = new Set(Object.keys(zhCN))

/** key 在定义树存在 = 叶子，或是有子节点的内部节点（后者承载「拼接子 key」类用法，
 * 如 settings.compat.thinkingFormat.options + '.${suffix}' 的选项前缀组合）。 */
function isDefined(key: string): boolean {
  if (definedLeafKeys.has(key)) return true
  const prefix = `${key}.`
  for (const k of definedLeafKeys) {
    if (k.startsWith(prefix)) return true
  }
  return false
}

// ── 使用面：源码扫描（renderer + ui 双根；locale 定义文件本身排除）──────────

const RENDERER_SRC = resolve(__dirname, '../..')
const UI_SRC = resolve(__dirname, '../../../../ui/src')
const SCAN_EXTENSIONS = new Set(['.vue', '.ts', '.tsx'])

/** 测试文件不算使用面（与 locale-key-usage-guard 反向守卫同口径：测试里的假 key 是
 * mock 形态不是渲染真值，扫入只产噪声；D3 的 9 个错位 key 全在生产源码）。 */
function isTestFile(path: string): boolean {
  return /__tests__\/|\.test\.|\.spec\./.test(path)
}

/** 定义文件排除：locale 对象的键名/值不是使用面（键是裸词、值是文案），扫入只产噪声。 */
function isDefinitionFile(path: string): boolean {
  return path.includes(`${join('i18n', 'locales')}/`) || path.includes(`${join('locale')}/`)
}

function walkSources(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (name === 'node_modules') continue
      walkSources(full, out)
    } else if (SCAN_EXTENSIONS.has(name.slice(name.lastIndexOf('.'))) && !name.endsWith('.d.ts') && !isDefinitionFile(full) && !isTestFile(full)) {
      out.push(full)
    }
  }
}

const sources: string[] = []
walkSources(RENDERER_SRC, sources)
walkSources(UI_SRC, sources)

/** 静态 key 字面量（单双引号——t() 直调、映射表值、测试断言里的 key 同扫）。 */
const EXACT_RE = /['"]([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)['"]/g
/** 动态模板前缀（反引号 + 插值——取 ${ 前的静态前缀段）。 */
const TEMPLATE_PREFIX_RE = /`([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)\$\{/g
/** 反引号整 key（无插值）。 */
const TEMPLATE_EXACT_RE = /`([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)`/g

/**
 * 白名单（b 路线）：字面形态与 i18n key 无法区分的非 i18n 字面量。
 * 新增条目必须带 reason；撤销时连 reason 一并删。
 */
const USAGE_WHITELIST: ReadonlyArray<{ literal: string; kind: 'exact' | 'prefix'; reason: string }> = [
  {
    literal: 'canvas.updated',
    kind: 'exact',
    reason: 'runtime broker 全局广播事件名（WS 消息类型，use-canvas-sync 订阅）——canvas 恰为 i18n 顶层命名空间，形态无法区分',
  },
  {
    literal: 'app.config.errorHandler',
    kind: 'exact',
    reason: 'Vue 全局错误处理器 API 名（boot/error-reporter 注释引用），非 i18n key',
  },
  {
    literal: 'find.query.value',
    kind: 'exact',
    reason: '模板属性里的 store 属性链（FindBar v-model="find.query.value"），非 i18n key',
  },
  { literal: 'btw.create', kind: 'exact', reason: 'WS 消息类型（ServerMessageMap 索引 / command 名），btw 恰为 i18n 命名空间' },
  { literal: 'btw.remove', kind: 'exact', reason: 'WS 消息类型（command 名）' },
  {
    literal: 'sidebar.collapsed',
    kind: 'exact',
    reason: '模板属性里的 store 属性链（v-if="sidebar.collapsed"），非 i18n key',
  },
  {
    literal: 'sidebar.widthPx',
    kind: 'exact',
    reason: '模板属性里的 store 属性链（SidebarResizeHandle :aria-valuenow="sidebar.widthPx"），非 i18n key',
  },
  {
    literal: 'sidebar.activeTab',
    kind: 'exact',
    reason: '模板属性里的 store 属性链（v-model="sidebar.activeTab"），非 i18n key',
  },
  { literal: 'panel.header', kind: 'exact', reason: 'PanelHeader 的 view-id 标识字符串（视图定位 id），非 i18n key' },
  { literal: 'app.info', kind: 'exact', reason: 'runtime 全局广播事件名（onGlobalType 订阅），非 i18n key' },
  { literal: 'app.thinking.cycle', kind: 'exact', reason: 'composer 快捷动作 ID（快捷键映射表值），非 i18n key' },
  { literal: 'app.model.cycleForward', kind: 'exact', reason: 'composer 快捷动作 ID（同上）' },
  { literal: 'app.model.cycleBackward', kind: 'exact', reason: 'composer 快捷动作 ID（同上）' },
  { literal: 'app.message.copy', kind: 'exact', reason: 'composer 快捷动作 ID（同上）' },
  { literal: 'sidebar.tab', kind: 'exact', reason: '扩展宿主 placement 枚举值（placement === "sidebar.tab"），非 i18n key' },
  { literal: 'rollingRestart.status', kind: 'exact', reason: 'RPC 命令名（command("rollingRestart.status")），非 i18n key' },
  { literal: 'workspace.detected', kind: 'exact', reason: 'WS 消息类型（ServerMessageMap 索引），非 i18n key' },
]

interface Violation { // oe-exempt:20261015:test:守卫违规条目形状（测试 harness 数据结构，非抽象接口单实现）
  file: string
  line: number
  kind: 'exact' | 'prefix'
  literal: string
}

function lineOf(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++
  return line
}

const violations: Violation[] = []

for (const file of sources) {
  const content = readFileSync(file, 'utf-8')
  const checkExact = (key: string, index: number): void => {
    if (!namespaces.has(key.split('.')[0])) return
    if (USAGE_WHITELIST.some((w) => w.kind === 'exact' && w.literal === key)) return
    if (!isDefined(key)) violations.push({ file, line: lineOf(content, index), kind: 'exact', literal: key })
  }
  const checkPrefix = (prefix: string, index: number): void => {
    if (!namespaces.has(prefix.split('.')[0])) return
    if (USAGE_WHITELIST.some((w) => w.kind === 'prefix' && w.literal === prefix)) return
    let hasAnchor = false
    for (const k of definedLeafKeys) {
      if (k.startsWith(prefix)) {
        hasAnchor = true
        break
      }
    }
    if (!hasAnchor) violations.push({ file, line: lineOf(content, index), kind: 'prefix', literal: prefix })
  }
  for (const m of content.matchAll(EXACT_RE)) checkExact(m[1], m.index ?? 0)
  for (const m of content.matchAll(TEMPLATE_EXACT_RE)) checkExact(m[1], m.index ?? 0)
  for (const m of content.matchAll(TEMPLATE_PREFIX_RE)) checkPrefix(m[1], m.index ?? 0)
}

describe('i18n 使用面 vs 定义面守卫', () => {
  it('源码引用的每个静态 key 都在 zh-CN 聚合树中存在', () => {
    const exactMisses = violations.filter((v) => v.kind === 'exact')
    expect(
      exactMisses.map((v) => `${v.file.replace(RENDERER_SRC, '<renderer>').replace(UI_SRC, '<ui>')}:${v.line} → ${v.literal}`),
    ).toEqual([])
  })

  it('每个动态模板前缀在定义树中至少有一个落点 key', () => {
    const prefixMisses = violations.filter((v) => v.kind === 'prefix')
    expect(
      prefixMisses.map((v) => `${v.file.replace(RENDERER_SRC, '<renderer>').replace(UI_SRC, '<ui>')}:${v.line} → ${v.literal}*`),
    ).toEqual([])
  })

  it('定义树非空（聚合树 import 未被构建变化打断）', () => {
    expect(definedLeafKeys.size).toBeGreaterThan(100)
    expect(namespaces.has('panel')).toBe(true)
  })
})

}
