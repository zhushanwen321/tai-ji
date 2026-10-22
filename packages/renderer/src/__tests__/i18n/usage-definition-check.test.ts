// @vitest-environment node

/**
 * i18n 使用面 vs 定义面机器守卫（problem-solve-canvas D3 真机验收 9 个错位 key 渲染
 * 原文的根因防线——check_i18n_locale_sync 只查 zh/en 双侧一致，「源码引用的 key 是否
 * 在定义树存在」此前无任何检查，错位 key 从合入到真机暴露隔多轮验收）。
 *
 * 提取口径（b+c 路线，2026-10-15 用户裁决）：
 * - 定义面 = import zh-CN 聚合树取真实合并结果（手工模拟 namespace 展开会漏 ui 包
 *   下沉模块与 panel 多模块展开），walk 出全部叶子 key 路径；
 * - 使用面 = 源码扫描两类形态：
 *   ① 静态 key 字面量——任何「顶层命名空间开头 + 至少一个点分段」的字符串字面量
 *     （覆盖 t() / $t() 直调与 labelKey / titleKey 等对象映射表引用——D3 实际错位形态）；
 *   ② 动态模板前缀——`a.b.${expr}` 取静态前缀段（含结尾分隔符），定义树存在该前缀
 *     的 key 即通过；
 * - 白名单（b）：守卫无法从字面形态区分 i18n key 与同名异义字面量（如事件名
 *   canvas.updated 恰好落在 canvas 命名空间下），人工裁决逐条附理由登记于
 *   USAGE_WHITELIST；新增白名单条目必须带 reason，随守卫同源维护。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import zhCN from '../../i18n/locales/zh-CN'

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
  { literal: 'btw.list', kind: 'exact', reason: 'WS 消息类型（同上）' },
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
