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
  firstContentText,
  validateWidgetIconPaths,
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

describe('firstContentText', () => {
  it('content[0] 为 text 块 → 取其 text', () => {
    expect(
      firstContentText({ content: [{ type: 'text', text: 'hello' }] })
    ).toBe('hello')
  })

  it('content[0] 非 text 块 → 空串', () => {
    expect(
      firstContentText({ content: [{ type: 'image', url: 'x' } as { type: string }] })
    ).toBe('')
  })

  it('content 为空数组 → 空串', () => {
    expect(firstContentText({ content: [] })).toBe('')
  })

  it('text 块缺失 text 字段（undefined）→ 空串', () => {
    expect(firstContentText({ content: [{ type: 'text' }] })).toBe('')
  })
})

describe('validateWidgetIconPaths（自定义 icon paths 白名单，宿主 fallback 消费）', () => {
  /** 合法 d 字符集内的 n 字符 path（'M' + 数字填充） */
  const pathOfChars = (n: number): string => 'M' + '0'.repeat(n - 1)

  describe('合法 paths 通过', () => {
    it('常规多段 path 全通过且逐条保留', () => {
      const paths = ['M12 2L2 7', 'M2 7a1 1 0 1 0 2 0', 'M-1.5,2.25h4v-3.5z']
      const result = validateWidgetIconPaths(paths)
      expect(result).toEqual({ valid: true, paths })
      // 返回独立副本：宿主可安全持有校验结果，不被 extension 侧数组改动影响
      expect(result.valid && result.paths).not.toBe(paths)
    })

    it('边界内极值通过：8 条 / 单条 512 字符 / 总长 2048 字符', () => {
      expect(validateWidgetIconPaths(Array.from({ length: 8 }, () => 'M0 0')).valid).toBe(true)
      expect(validateWidgetIconPaths([pathOfChars(512)]).valid).toBe(true)
      expect(validateWidgetIconPaths(Array.from({ length: 4 }, () => pathOfChars(512))).valid).toBe(true)
    })

    it('S/s/T/t 平滑曲线命令通过（@lucide/vue 全量 5869 条 d 串中 58 条用到；旧白名单误拒）', () => {
      const paths = [
        // 真实 lucide 形状（rocket.mjs / waves-horizontal.mjs）
        'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
        'M2 12q2.5 2 5 0t5 0 5 0 5 0',
        // 大写 S/T（平滑三次/二次曲线续段）
        'M4 20S8 4 12 4',
        'M4 20Q6 4 8 4T12 4',
      ]
      expect(validateWidgetIconPaths(paths)).toEqual({ valid: true, paths })
    })
  })

  describe('非法字符拒绝', () => {
    it.each([
      ['标签注入面', 'M0 0" onload="alert(1)'],
      ['脚本注入面', 'M0 0</path><script>'],
      ['指数记法（e/E 不在白名单）', 'M0 0e5'],
      ['换行', 'M0 0\nL1 1'],
      ['中文', 'M0 0中文'],
      ['分号分隔（非白名单标点）', 'M0 0;L1 1'],
      ['白名单未整体放开（g 非 d 命令字母）', 'M0 0g5 5'],
    ])('%s → illegal-char', (_label, path) => {
      expect(validateWidgetIconPaths([path])).toEqual({ valid: false, reason: 'illegal-char' })
    })

    it('入参非数组（undefined / null / 字符串）→ not-array', () => {
      expect(validateWidgetIconPaths(undefined)).toEqual({ valid: false, reason: 'not-array' })
      expect(validateWidgetIconPaths(null)).toEqual({ valid: false, reason: 'not-array' })
      expect(validateWidgetIconPaths('M0 0')).toEqual({ valid: false, reason: 'not-array' })
    })

    it('空数组 / 非 string 条目各自归因', () => {
      expect(validateWidgetIconPaths([])).toEqual({ valid: false, reason: 'empty' })
      expect(validateWidgetIconPaths(['M0 0', 42])).toEqual({ valid: false, reason: 'non-string' })
    })
  })

  describe('超条数拒绝', () => {
    it('9 条（上限 8）→ too-many', () => {
      const paths = Array.from({ length: 9 }, () => 'M0 0')
      expect(validateWidgetIconPaths(paths)).toEqual({ valid: false, reason: 'too-many' })
    })
  })

  describe('超长度拒绝', () => {
    it('单条 513 字符（上限 512）→ too-long', () => {
      expect(validateWidgetIconPaths([pathOfChars(513)])).toEqual({ valid: false, reason: 'too-long' })
    })

    it('总长 2049 字符（上限 2048）→ total-too-long（条数与单条均在限内）', () => {
      const paths = [...Array.from({ length: 4 }, () => pathOfChars(512)), pathOfChars(1)]
      expect(validateWidgetIconPaths(paths)).toEqual({ valid: false, reason: 'total-too-long' })
    })
  })
})
