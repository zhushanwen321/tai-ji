/**
 * index.test.ts —— IF3 facade 集成单测（AC1，TC-1~TC-4）。
 *
 * 全部从 './index' 导入（不深导入 './resolve' './custom-registry' '@zhushanwen/extension-protocol'），
 * 验证 facade 聚合是唯一入口：
 * - TC-1：re-export 完整可解析（7 ext-protocol 符号 + resolve/custom-registry 面 runtime 值非 undefined）
 * - TC-2：resolveComponent 经 index 四分支冒烟（深度覆盖在 w2 resolve.test.ts）
 * - TC-3：isCustomRegistered 经 index 行为正确（facade 不破坏 w1 契约）
 * - TC-4：无回归（由 vitest run src/rendering-protocol/ 整体绿侧证，本文件自身不报错）
 *
 * 纯 re-export 验证零 mock；占位组件 () => null（与 resolve.test.ts 同模式）。
 */
import { describe, it, expect } from 'vitest'
import {
  PROTOCOL_VERSION,
  extractGui,
  guiResult,
  resolveComponent,
  isCustomRegistered,
  EMPTY_CUSTOM_REGISTRY,
  GUI_CUSTOM_REGISTRY_KEY,
} from './index'
// type-only import（编译期擦除，运行时无值；存在性由 tsc 间接验证）
import type {
  GuiComponent,
  GuiComponentType,
  GuiComponentProps,
  GuiRenderResult,
  ResolvedRender,
} from './index'

/** 占位组件（node 环境无 .vue，Component 类型兼容函数组件；与 resolve.test.ts 同模式） */
const dummyComponent = () => null

// 类型符号编译期擦除——用 eslint-disable 避免 unused 报错，断言靠 tsc（运行时无值）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeCheck: GuiComponent | GuiComponentType | GuiComponentProps | GuiRenderResult | ResolvedRender = undefined as never

describe('IF3 TC-1: index.ts re-export 完整可解析', () => {
  it('PROTOCOL_VERSION 常量值传递（=== 1，证明不是空 re-export）', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })

  it('4 个 runtime 函数均 callable（runtime 导出非 undefined）', () => {
    expect(typeof guiResult).toBe('function')
    expect(typeof extractGui).toBe('function')
    expect(typeof resolveComponent).toBe('function')
    expect(typeof isCustomRegistered).toBe('function')
  })

  it('EMPTY_CUSTOM_REGISTRY 是 frozen 空对象（w1 常量经 index 透传无破损）', () => {
    expect(Object.keys(EMPTY_CUSTOM_REGISTRY)).toHaveLength(0)
    expect(Object.isFrozen(EMPTY_CUSTOM_REGISTRY)).toBe(true)
  })

  it('GUI_CUSTOM_REGISTRY_KEY 是 symbol（w1 key 经 index 透传）', () => {
    expect(typeof GUI_CUSTOM_REGISTRY_KEY).toBe('symbol')
  })
})

describe('IF3 TC-2: resolveComponent 经 index 入口四分支冒烟', () => {
  it('① builtin card 合法 props → type+props 原样透传', () => {
    const props = { variant: 'default' as const, body: [] }
    const r = resolveComponent({ type: 'card', props })
    expect(r.type).toBe('card')
    expect(r.props).toStrictEqual(props)
  })

  it('② ansi-text lines 数组 → join(\\n)', () => {
    const r = resolveComponent({ type: 'ansi-text', props: { lines: ['a', 'b'] } })
    expect(r).toStrictEqual({ type: 'ansi-text', props: { content: 'a\nb' } })
  })

  it('③ custom 未注册（undefined registry 缺省）→ 降级 ansi-text', () => {
    const r = resolveComponent({ type: 'custom', props: { component: 'unknown', props: {} } })
    expect(r.type).toBe('ansi-text')
  })

  it('④ null 脏数据 → 降级 content=\'null\'（JSON.stringify(null) 不抛）', () => {
    const r = resolveComponent(null)
    expect(r.type).toBe('ansi-text')
    expect((r.props as { content: string }).content).toBe('null')
  })
})

describe('IF3 TC-3: isCustomRegistered 经 index 入口行为正确（w1 契约不破坏）', () => {
  it('undefined registry（空表语义）→ false', () => {
    expect(isCustomRegistered(undefined, 'x')).toBe(false)
  })

  it('命中 → true', () => {
    expect(isCustomRegistered({ foo: dummyComponent }, 'foo')).toBe(true)
  })

  it('未命中 → false', () => {
    expect(isCustomRegistered({ foo: dummyComponent }, 'bar')).toBe(false)
  })
})
