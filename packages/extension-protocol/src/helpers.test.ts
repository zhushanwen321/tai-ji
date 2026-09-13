import { describe, it, expect } from 'vitest'
import {
  guiResult,
  guiComponent,
  guiSetWidget,
  setWidgetDual,
  isGuiCapable,
  isGuiComponent,
  isGuiRenderResult,
  extractGui,
  GUI_WIDGET_MARKER,
  PROTOCOL_VERSION,
  type GuiContext,
} from './index'

describe('isGuiCapable', () => {
  it('rpc 模式返回 true', () => {
    expect(isGuiCapable({ mode: 'rpc', hasUI: true })).toBe(true)
  })

  it('tui 模式返回 false', () => {
    expect(isGuiCapable({ mode: 'tui', hasUI: true })).toBe(false)
  })

  it('json 模式返回 false', () => {
    expect(isGuiCapable({ mode: 'json', hasUI: false })).toBe(false)
  })
})

describe('guiResult', () => {
  it('构造带版本号的 GuiRenderResult', () => {
    const component = guiComponent('stats-line', {
      items: [{ value: '3 turns' }],
    })
    const result = guiResult(component)
    expect(result.v).toBe(PROTOCOL_VERSION)
    expect(result.component.type).toBe('stats-line')
    expect(result.meta).toBeUndefined()
  })

  it('meta 可选挂载（v1.1 widget 宿主元数据），不传时键不出现', () => {
    const result = guiResult(guiComponent('list-tree', { items: [] }), {
      title: 'Todo',
      status: 'running',
      progress: { current: 1, total: 3 },
    })
    expect(result.meta).toEqual({ title: 'Todo', status: 'running', progress: { current: 1, total: 3 } })
    expect('meta' in JSON.parse(JSON.stringify(guiResult(guiComponent('list-tree', { items: [] }))))).toBe(false)
  })

  it('strip undefined 字段（序列化干净）', () => {
    const component = guiComponent('stats-line', {
      items: [{ value: 'x', label: undefined }],
    })
    const result = guiResult(component)
    const serialized = JSON.parse(JSON.stringify(result))
    // label 为 undefined，不应出现在序列化结果中
    expect('label' in serialized.component.props.items[0]).toBe(false)
  })
})

describe('guiComponent', () => {
  it('正确构造 stats-line 组件', () => {
    const c = guiComponent('stats-line', {
      items: [{ value: '3 turns', label: 'turns' }],
    })
    expect(c.type).toBe('stats-line')
    expect(c.props.items).toHaveLength(1)
    expect(c.props.items[0].label).toBe('turns')
  })

  it('正确构造 ansi-text 组件', () => {
    const c = guiComponent('ansi-text', { lines: ['line1', 'line2'] })
    expect(c.type).toBe('ansi-text')
    expect(c.props.lines).toEqual(['line1', 'line2'])
  })

  it('正确构造 card 布局原语', () => {
    const inner = guiComponent('stats-line', {
      items: [{ value: '3 turns' }],
    })
    const c = guiComponent('card', { body: [inner] })
    expect(c.type).toBe('card')
    expect(c.props.body).toHaveLength(1)
    expect(c.props.body[0].type).toBe('stats-line')
  })
})

describe('guiSetWidget', () => {
  it('RPC 模式用 marker 编码 GuiRenderResult 信封 JSON（v1.1：component + meta）', () => {
    let captured: string[] | undefined
    const ctx: GuiContext = {
      mode: 'rpc',
      hasUI: true,
      ui: {
        setWidget: (_key: string, lines: string[] | undefined) => {
          captured = lines
        },
      },
    }
    const result = guiResult(
      guiComponent('stats-line', { items: [{ value: 'x' }] }),
      { title: 'Todo', status: 'running', progress: { current: 1, total: 2 } },
    )
    guiSetWidget(ctx, 'todo', result)

    expect(captured).toBeDefined()
    expect(captured).toHaveLength(1)
    expect(captured![0].startsWith(GUI_WIDGET_MARKER)).toBe(true)

    const json = captured![0].slice(GUI_WIDGET_MARKER.length)
    const parsed = JSON.parse(json)
    expect(parsed.v).toBe(PROTOCOL_VERSION)
    expect(parsed.component.type).toBe('stats-line')
    expect(parsed.meta).toEqual({ title: 'Todo', status: 'running', progress: { current: 1, total: 2 } })
  })

  it('传 undefined 清除 widget', () => {
    let captured: string[] | undefined = ['existing']
    const ctx: GuiContext = {
      mode: 'rpc',
      hasUI: true,
      ui: {
        setWidget: (_key: string, lines: string[] | undefined) => {
          captured = lines
        },
      },
    }
    guiSetWidget(ctx, 'todo', undefined)
    expect(captured).toBeUndefined()
  })

  it('无 ui.setWidget 时安全无操作', () => {
    const ctx: GuiContext = { mode: 'rpc', hasUI: true }
    // 不应抛错
    guiSetWidget(ctx, 'todo', guiResult(guiComponent('ansi-text', { lines: [] })))
  })
})

describe('setWidgetDual（双模分派单点：清屏/推送 × GUI/TUI）', () => {
  const content = {
    gui: guiResult(guiComponent('stats-line', { items: [{ value: 'x' }] })),
    text: ['todo: 1/3', 'running'],
  }

  function captureCtx(mode: GuiContext['mode']): { ctx: GuiContext; calls: Array<{ key: string; lines: string[] | undefined }> } {
    const calls: Array<{ key: string; lines: string[] | undefined }> = []
    const ctx: GuiContext = {
      mode,
      hasUI: true,
      ui: {
        setWidget: (key, lines) => {
          calls.push({ key, lines })
        },
      },
    }
    return { ctx, calls }
  }

  it('TUI 模式 + 有内容：推原生文本行原样，结构性不产 marker 行（P3 负面断言）', () => {
    const { ctx, calls } = captureCtx('tui')
    setWidgetDual(ctx, 'todo', content)
    expect(calls).toEqual([{ key: 'todo', lines: content.text }])
    for (const line of calls[0].lines ?? []) {
      expect(line.startsWith(GUI_WIDGET_MARKER)).toBe(false)
    }
  })

  it('json 模式（非 rpc 非 tui）+ 有内容：同落文本行分支（isGuiCapable 单一判据）', () => {
    const { ctx, calls } = captureCtx('json')
    setWidgetDual(ctx, 'todo', content)
    expect(calls).toEqual([{ key: 'todo', lines: content.text }])
  })

  it('RPC 模式 + 有内容：经 guiSetWidget 走 marker 编码通道', () => {
    const { ctx, calls } = captureCtx('rpc')
    setWidgetDual(ctx, 'todo', content)
    expect(calls).toHaveLength(1)
    expect(calls[0].lines![0].startsWith(GUI_WIDGET_MARKER)).toBe(true)
  })

  it('undefined 清屏（TUI）：setWidget(key, undefined)，模式无关不经 marker 路径', () => {
    const { ctx, calls } = captureCtx('tui')
    setWidgetDual(ctx, 'todo', undefined)
    expect(calls).toEqual([{ key: 'todo', lines: undefined }])
  })

  it('undefined 清屏（RPC）：同落 setWidget(key, undefined)（清屏死分支消除的等价面）', () => {
    const { ctx, calls } = captureCtx('rpc')
    setWidgetDual(ctx, 'todo', undefined)
    expect(calls).toEqual([{ key: 'todo', lines: undefined }])
  })

  it('无 ui.setWidget（headless）：推送与清屏均安全无操作', () => {
    const headless: GuiContext = { mode: 'json', hasUI: false }
    expect(() => setWidgetDual(headless, 'todo', content)).not.toThrow()
    expect(() => setWidgetDual(headless, 'todo', undefined)).not.toThrow()
  })
})

describe('isGuiRenderResult', () => {
  it('v1.1 信封（v + 合法 component）→ true，meta 可选', () => {
    expect(isGuiRenderResult(guiResult(guiComponent('list-tree', { items: [] })))).toBe(true)
    expect(
      isGuiRenderResult(guiResult(guiComponent('list-tree', { items: [] }), { title: 'x' })),
    ).toBe(true)
  })

  it.each([
    ['null', null],
    ['v1 裸 component（无信封）', { type: 'stats-line', props: {} }],
    ['v 版本不匹配', { v: 99, component: { type: 'stats-line', props: {} } }],
    ['component 非法（缺 props）', { v: PROTOCOL_VERSION, component: { type: 'stats-line' } }],
  ])('%s → false', (_label, value) => {
    expect(isGuiRenderResult(value)).toBe(false)
  })
})

describe('extractGui', () => {
  it('从含 __gui__ 的 details 中提取 GuiRenderResult', () => {
    const details = {
      __gui__: {
        v: 1,
        component: { type: 'stats-line', props: { items: [] } },
      },
      otherField: 'value',
    }
    const result = extractGui(details)
    expect(result).toBeDefined()
    expect(result!.v).toBe(1)
    expect(result!.component.type).toBe('stats-line')
  })

  it('无 __gui__ 返回 undefined', () => {
    expect(extractGui({ foo: 'bar' })).toBeUndefined()
  })

  it('undefined details 返回 undefined', () => {
    expect(extractGui(undefined)).toBeUndefined()
  })

  it('__gui__ 缺少 v 或 component 返回 undefined', () => {
    expect(extractGui({ __gui__: { v: 1 } })).toBeUndefined()
    expect(extractGui({ __gui__: { component: {} } })).toBeUndefined()
  })
})

describe('isGuiComponent', () => {
  it('合法 GuiComponent（type 字符串 + props 对象）→ true', () => {
    expect(isGuiComponent({ type: 'stats-line', props: { items: [] } })).toBe(true)
    expect(isGuiComponent({ type: 'ansi-text', props: { lines: ['a'] } })).toBe(true)
  })

  it('缺 type 或 type 非字符串 → false', () => {
    expect(isGuiComponent({ props: {} })).toBe(false)
    expect(isGuiComponent({ type: 42, props: {} })).toBe(false)
  })

  it('缺 props 或 props 非对象 → false', () => {
    expect(isGuiComponent({ type: 'stats-line' })).toBe(false)
    expect(isGuiComponent({ type: 'stats-line', props: 'not-object' })).toBe(false)
  })

  it('props 为 null → false（typeof null === object 陷阱）', () => {
    expect(isGuiComponent({ type: 'stats-line', props: null })).toBe(false)
  })

  it('null/非对象 → false', () => {
    expect(isGuiComponent(null)).toBe(false)
    expect(isGuiComponent('string')).toBe(false)
    expect(isGuiComponent(undefined)).toBe(false)
  })
})
