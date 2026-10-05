/**
 * 容器注册表单测 —— display-containers u-foundation（§7.2 条目文本逐字锚 + 载入序列对账）。
 *
 * 三视角：构建者白盒（条目六字段形状/单一事实源引用同一对象）、使用者黑盒（tab 数 8/1/2、
 * 显示序、条目文本——DrawerPanel L1 图标条的用户可见投影）、观察者形态（注册表纯数据形态）。
 * core 为 headless node 环境（vitest.config 零 DOM），用户可见断言落在 tab 数/顺序/文本等
 * 可见投影锚上；DOM 渲染断言归 ui 层 DrawerPanel 接线单元（E2E-MOCK-02 对账）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/registry.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  CONTAINER_REGISTRY,
  RIGHT_DRAWER_REGISTRY,
  BOTTOM_DRAWER_REGISTRY,
  OVERLAY_REGISTRY,
} from '../registry'
import type { ContainerRegistryEntry } from '../registry'

// ── 设计 §7.2「条目文本」块逐字锚（独立硬编码对账——registry.ts 的 text 单方改写即红）──
const DESIGN_RIGHT_TEXTS = [
  'git（变更集）',
  'doc（命令文档）',
  'detail（文件详情）',
  'subagent（子代理）',
  'bashTask（后台命令）',
  'plan（计划文档）',
  'btw（旁路线）',
  'workflow（回落载体，L1 常驻，主入口浮层）',
]
const DESIGN_BOTTOM_TEXTS = ['terminal（终端）']
const DESIGN_OVERLAY_TEXTS = ['browser（网页）', 'workflow（工作流图）']

// ── 右抽屉 L1 显示序锚（u-w2-browser-mount 撤 browser 后终态 8 条）──
const RIGHT_EXPECTED_CONTENTS = ['git', 'doc', 'detail', 'subagent', 'bashTask', 'plan', 'btw', 'workflow']

function texts(entries: readonly ContainerRegistryEntry[]): string[] {
  return entries.map((entry) => entry.text)
}

function contents(entries: readonly ContainerRegistryEntry[]): string[] {
  return entries.map((entry) => entry.content)
}

describe('注册表条目文本与设计 §7.2 逐字一致（右 8 / 底 1 / 浮 2）', () => {
  it('右抽屉 8 条目文本逐字一致（含 workflow 回落载体长文本）', () => {
    expect(texts(RIGHT_DRAWER_REGISTRY)).toEqual(DESIGN_RIGHT_TEXTS)
  })

  it('底抽屉 1 条、浮层 2 条文本逐字一致', () => {
    expect(texts(BOTTOM_DRAWER_REGISTRY)).toEqual(DESIGN_BOTTOM_TEXTS)
    expect(texts(OVERLAY_REGISTRY)).toEqual(DESIGN_OVERLAY_TEXTS)
  })

  it('容器条目数 = 右 8 / 底 1 / 浮 2（用户可见 L1 图标数锚）', () => {
    expect(RIGHT_DRAWER_REGISTRY).toHaveLength(8)
    expect(BOTTOM_DRAWER_REGISTRY).toHaveLength(1)
    expect(OVERLAY_REGISTRY).toHaveLength(2)
  })

  it('CONTAINER_REGISTRY 与分容器声明同一数据源（引用同一数组，禁止双权威）', () => {
    expect(CONTAINER_REGISTRY['right-drawer']).toBe(RIGHT_DRAWER_REGISTRY)
    expect(CONTAINER_REGISTRY['bottom-drawer']).toBe(BOTTOM_DRAWER_REGISTRY)
    expect(CONTAINER_REGISTRY.overlay).toBe(OVERLAY_REGISTRY)
  })
})

describe('右抽屉 L1 载入序列（u-w2-browser-mount：browser 走浮层，载入序列退役达终态 8/1/2）', () => {
  it('DrawerPanel 数据源 = RIGHT_DRAWER_REGISTRY：8 条、终态显示序（用户可见 L1 图标锚）', () => {
    expect(contents(RIGHT_DRAWER_REGISTRY)).toEqual(RIGHT_EXPECTED_CONTENTS)
  })

  it('迁移源侧清空：右抽屉无 terminal/browser（terminal 迁底抽屉、browser 走浮层，§7.6）', () => {
    expect(contents(RIGHT_DRAWER_REGISTRY)).not.toContain('terminal')
    expect(contents(RIGHT_DRAWER_REGISTRY)).not.toContain('browser')
    // browser/terminal 的终态归属仍在注册表（浮层/底抽屉条目），不是删除内容类型
    expect(contents(OVERLAY_REGISTRY)).toContain('browser')
    expect(contents(BOTTOM_DRAWER_REGISTRY)).toContain('terminal')
    // workflow 在右抽屉只出现一次（回落载体；浮层 workflow 是另一条目不入抽屉）
    expect(contents(RIGHT_DRAWER_REGISTRY).filter((content) => content === 'workflow')).toHaveLength(1)
  })
})

describe('条目形状契约（内容类型 + 图标标识 + i18n key）', () => {
  const allEntries = [
    ...RIGHT_DRAWER_REGISTRY,
    ...BOTTOM_DRAWER_REGISTRY,
    ...OVERLAY_REGISTRY,
  ]

  it('每条目六字段齐全且非空（text 含内容类型前缀，图标为 kebab-case 标识）', () => {
    for (const entry of allEntries) {
      expect(typeof entry.content).toBe('string')
      expect(entry.content.length).toBeGreaterThan(0)
      expect(entry.text.length).toBeGreaterThan(0)
      expect(entry.text.startsWith(entry.content)).toBe(true)
      expect(entry.icon).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(entry.labelKey.length).toBeGreaterThan(0)
      expect(entry.emptyTextKey.length).toBeGreaterThan(0)
      expect(entry.emptyHintKey.length).toBeGreaterThan(0)
    }
  })

  it('同一容器内 content 不重复（tab 条键唯一）', () => {
    for (const entries of [RIGHT_DRAWER_REGISTRY, BOTTOM_DRAWER_REGISTRY, OVERLAY_REGISTRY]) {
      expect(new Set(contents(entries)).size).toBe(entries.length)
    }
  })

  it('单条目的三把 i18n key 互不相同（标签/空态文案/空态提示各司其职）', () => {
    for (const entry of allEntries) {
      const keys = [entry.labelKey, entry.emptyTextKey, entry.emptyHintKey]
      expect(new Set(keys).size).toBe(3)
    }
  })
})
