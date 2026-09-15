/**
 * resolve.test.ts —— resolveComponent 纯函数四分支全覆盖（IF1/DM1/ES1-3，AC2）。
 *
 * 契约面（IF1 contract）：
 * ① 6 builtin 类型（card/columns/list-tree/progress-bar/stats-line/tab-bar）合法 props
 *    → { type: 原type, props: 原props }（原样透传）
 * ② ansi-text 正常（lines 数组）→ { type: 'ansi-text', props: { content: lines.join('\n') } }
 * ③ custom 已注册（registry 注入）→ { type: 'custom', props: 原props }
 * ④ custom 未注册（空 registry / undefined）→ 降级，JSON 含 component 名与嵌套 props
 * ⑤ 未知 type → 降级不抛，content 含原 props 信息
 * ⑥ 脏数据五组（null / 非对象 / type 非字符串 / props 非对象 / ansi-text lines 非数组）→ 降级不抛
 * ⑦ ES3：循环引用 → 不抛，content === '[unserializable component props]'
 *
 * 纯函数零 mock：node 环境直接 import 调用断言。
 */
import { describe, it, expect } from 'vitest'
import { resolveComponent } from './resolve'

/** 占位组件（node 环境无 .vue 组件，Component 类型兼容函数组件） */
const dummyComponent = () => null

describe('resolveComponent: builtin 类型正向路由（分支 1）', () => {
  it('6 builtin 类型合法 props → type+props 原样透传', () => {
    const cases: { type: string; props: Record<string, unknown> }[] = [
      { type: 'card', props: { variant: 'default', body: [] } },
      { type: 'columns', props: { children: [] } },
      { type: 'list-tree', props: { items: [] } },
      { type: 'progress-bar', props: { current: 1, total: 3 } },
      { type: 'stats-line', props: { items: [] } },
      { type: 'tab-bar', props: { tabs: [] } },
    ]
    for (const c of cases) {
      const r = resolveComponent(c)
      expect(r.type).toBe(c.type)
      expect(r.props).toStrictEqual(c.props)
    }
  })

  it('builtin 嵌套 GuiComponent 对象原样保留（不做深度校验）', () => {
    const props = { variant: 'default' as const, body: [{ type: 'stats-line', props: { items: [] } }] }
    const r = resolveComponent({ type: 'card', props })
    expect(r).toStrictEqual({ type: 'card', props })
  })
})

describe('resolveComponent: ansi-text join（分支 4）', () => {
  it('lines 数组 → join(\'\\n\')', () => {
    const r = resolveComponent({ type: 'ansi-text', props: { lines: ['a', 'b'] } })
    expect(r).toStrictEqual({ type: 'ansi-text', props: { content: 'a\nb' } })
  })

  it('lines 空数组 → content 空串（Array.isArray 判定，正常分支）', () => {
    const r = resolveComponent({ type: 'ansi-text', props: { lines: [] } })
    expect(r).toStrictEqual({ type: 'ansi-text', props: { content: '' } })
  })
})

describe('resolveComponent: custom 已注册（分支 2）', () => {
  it('registry 注入命中 → type=\'custom\' + props 原样（含 component 字段与嵌套 props）', () => {
    const registry = { 'my-widget': dummyComponent }
    const comp = { type: 'custom' as const, props: { component: 'my-widget', props: { x: 1 } } }
    const r = resolveComponent(comp, registry)
    expect(r).toStrictEqual({ type: 'custom', props: comp.props })
  })
})

describe('resolveComponent: custom 未注册 → 降级（分支 3）', () => {
  it('空 registry → ansi-fallback，content 含 component 名与嵌套 props（信息保留）', () => {
    const r = resolveComponent({ type: 'custom', props: { component: 'unknown-comp', props: { x: 1 } } }, {})
    expect(r.type).toBe('ansi-text')
    const content = (r.props as { content: string }).content
    expect(content).toContain('unknown-comp')
    expect(content).toContain('"x"')
    expect(content).toContain('1')
    // JSON.parse 验证信息完整保留
    const parsed = JSON.parse(content)
    expect(parsed).toStrictEqual({ component: 'unknown-comp', props: { x: 1 } })
  })

  it('undefined registry（缺省空表语义）→ 降级', () => {
    const r = resolveComponent({ type: 'custom', props: { component: 'unknown-comp', props: { x: 1 } } })
    expect(r.type).toBe('ansi-text')
  })

  it('props.component 非字符串（数字）→ 视为未注册，降级不抛', () => {
    const r = resolveComponent({ type: 'custom', props: { component: 42, props: {} } })
    expect(r.type).toBe('ansi-text')
  })
})

describe('resolveComponent: 未知 type → 降级（分支 3）', () => {
  it('协议外未知 type → 不抛且 content 含原 props 信息', () => {
    const r = resolveComponent({ type: 'new-primitive', props: { a: 1 } })
    expect(r.type).toBe('ansi-text')
    const content = (r.props as { content: string }).content
    expect(content).toContain('"a"')
    expect(content).toContain('1')
  })
})

describe('resolveComponent: 脏数据 → 降级不抛（ES1/ES2）', () => {
  it('null → 降级 content=\'null\'（JSON.stringify(null) 不抛）', () => {
    const r = resolveComponent(null)
    expect(r.type).toBe('ansi-text')
    expect((r.props as { content: string }).content).toBe('null')
  })

  it('undefined → 降级不抛（String 兜底 content=\'undefined\'）', () => {
    const r = resolveComponent(undefined)
    expect(r.type).toBe('ansi-text')
    expect((r.props as { content: string }).content).toBe('undefined')
  })

  it('非对象（字符串）→ 降级不抛', () => {
    const r = resolveComponent('string')
    expect(r.type).toBe('ansi-text')
  })

  it('type 非字符串（数字）→ 降级不抛', () => {
    const r = resolveComponent({ type: 42, props: {} })
    expect(r.type).toBe('ansi-text')
  })

  it('props 非对象（null）→ 降级不抛', () => {
    const r = resolveComponent({ type: 'card', props: null })
    expect(r.type).toBe('ansi-text')
    expect((r.props as { content: string }).content).toBe('null')
  })

  it('ansi-text 但 lines 非数组 → 降级不抛（ES2，不执行 join）', () => {
    const r = resolveComponent({ type: 'ansi-text', props: { lines: 'not-array' } })
    expect(r.type).toBe('ansi-text')
  })
})

describe('resolveComponent: ES3 序列化失败兜底（仅降级路径）', () => {
  it('builtin 合法形状 + 循环引用 props → 原样透传不序列化不抛（深度校验留 renderer）', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const r = resolveComponent({ type: 'card', props: circular })
    expect(r.type).toBe('card')
    expect(r.props).toBe(circular)
  })

  it('未知 type + 循环引用 props → 降级路径序列化失败兜底不抛', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const r = resolveComponent({ type: 'unknown-type', props: circular })
    expect(r.type).toBe('ansi-text')
    expect((r.props as { content: string }).content).toBe('[unserializable component props]')
  })

  it('custom 未注册 + 循环引用嵌套 props → 降级兜底不抛', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const r = resolveComponent({ type: 'custom', props: { component: 'x', props: circular } })
    expect(r.type).toBe('ansi-text')
    expect((r.props as { content: string }).content).toBe('[unserializable component props]')
  })
})
