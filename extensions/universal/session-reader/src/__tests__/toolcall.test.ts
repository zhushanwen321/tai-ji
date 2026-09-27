import { describe, it, expect } from 'vitest'
import { extractToolCalls, formatToolCallSummary } from '../core/toolcall.js'
import type { Entry } from '../core/parser.js'

/**
 * D1 映射表（design §3.3）确定性测试：formatToolCallSummary 12 个 switch 分支
 * + extractToolCalls 提取/coerceArgs 兜底各形态。修复 MF-2（原仅经 render.test.ts
 * fixture 间接覆盖 bash/read/edit/write 四分支，head/todo/subagent/cw/unknown 零直接覆盖）。
 */

/** 构造带 content 的 assistant message entry。 */
function entryWithContent(content: unknown): Entry {
  return { type: 'message', id: 'm1', parentId: null, message: { role: 'assistant', content } }
}

describe('formatToolCallSummary — bash/read/edit/write', () => {
  it('bash：有 command → 摘要（超 60 字截断加省略号）；无 command → 仅工具名', () => {
    expect(formatToolCallSummary({ id: 'c1', name: 'bash', arguments: { command: 'ls -la' } })).toBe(
      'bash: ls -la',
    )
    // 60 字边界：恰好 60 不截断
    expect(
      formatToolCallSummary({
        id: 'c1',
        name: 'bash',
        arguments: { command: 'y'.repeat(60) },
      }),
    ).toBe(`bash: ${'y'.repeat(60)}`)
    // 61 字 → 前 60 + 省略号
    expect(
      formatToolCallSummary({
        id: 'c1',
        name: 'bash',
        arguments: { command: 'z'.repeat(61) },
      }),
    ).toBe(`bash: ${'z'.repeat(60)}…`)
    expect(formatToolCallSummary({ id: 'c1', name: 'bash', arguments: {} })).toBe('bash')
  })

  it('read：有 path → basename（尾斜杠剥除）；无 path → 仅工具名', () => {
    expect(
      formatToolCallSummary({ id: 'c1', name: 'read', arguments: { path: '/a/b/c.ts' } }),
    ).toBe('read: c.ts')
    // 尾斜杠：basename 先剥 / 再取末段
    expect(formatToolCallSummary({ id: 'c1', name: 'read', arguments: { path: '/a/b/' } })).toBe(
      'read: b',
    )
    expect(formatToolCallSummary({ id: 'c1', name: 'read', arguments: {} })).toBe('read')
  })

  it('edit：path + edits 数组 → blocks 数；缺 path / 缺 edits 各自降级', () => {
    const base = { path: '/p/f.ts' }
    expect(
      formatToolCallSummary({
        id: 'c1',
        name: 'edit',
        arguments: { ...base, edits: [{ a: 1 }, { a: 2 }, { a: 3 }] },
      }),
    ).toBe('edit: f.ts (3 blocks)')
    expect(formatToolCallSummary({ id: 'c1', name: 'edit', arguments: base })).toBe('edit: f.ts')
    // 无 path 有 edits → head 降级为工具名，保留 blocks
    expect(
      formatToolCallSummary({ id: 'c1', name: 'edit', arguments: { edits: [1, 2] } }),
    ).toBe('edit (2 blocks)')
    // edits 非数组（object）→ 无 blocks 维度
    expect(
      formatToolCallSummary({ id: 'c1', name: 'edit', arguments: { ...base, edits: { a: 1 } } }),
    ).toBe('edit: f.ts')
  })

  it('write：content utf8 字节转 KB（<1KB 取 1，>1KB 四舍五入）；无 content → 仅 head', () => {
    const base = { path: '/p/f.ts' }
    // 100 字节 < 1KB → 下限 1KB
    expect(
      formatToolCallSummary({
        id: 'c1',
        name: 'write',
        arguments: { ...base, content: 'a'.repeat(100) },
      }),
    ).toBe('write: f.ts (1KB)')
    // 2048 字节 = 2KB
    expect(
      formatToolCallSummary({
        id: 'c1',
        name: 'write',
        arguments: { ...base, content: 'a'.repeat(2048) },
      }),
    ).toBe('write: f.ts (2KB)')
    // 多字节字符按 utf8 字节计（'你' = 3 字节，1024 个 = 3KB）
    expect(
      formatToolCallSummary({
        id: 'c1',
        name: 'write',
        arguments: { ...base, content: '你'.repeat(1024) },
      }),
    ).toBe('write: f.ts (3KB)')
    // 无 path 有 content → head 降级为工具名
    expect(
      formatToolCallSummary({ id: 'c1', name: 'write', arguments: { content: 'abc' } }),
    ).toBe('write (1KB)')
    expect(formatToolCallSummary({ id: 'c1', name: 'write', arguments: base })).toBe('write: f.ts')
  })
})

describe('formatToolCallSummary — head/todo/subagent', () => {
  it('head：limit 双形态（number/string）都输出；缺 path / 缺 limit 各自降级', () => {
    const base = { path: '/p/f.ts' }
    expect(formatToolCallSummary({ id: 'c1', name: 'head', arguments: { ...base, limit: 5 } })).toBe(
      'head: f.ts (5)',
    )
    // string limit（实测 number，防御 string）
    expect(
      formatToolCallSummary({ id: 'c1', name: 'head', arguments: { ...base, limit: '5' } }),
    ).toBe('head: f.ts (5)')
    expect(formatToolCallSummary({ id: 'c1', name: 'head', arguments: base })).toBe('head: f.ts')
    // 无 path 有 limit → head 降级
    expect(formatToolCallSummary({ id: 'c1', name: 'head', arguments: { limit: 5 } })).toBe(
      'head (5)',
    )
  })

  it('todo：id 双形态（number/string）；缺 action / 缺 id 各自降级', () => {
    expect(
      formatToolCallSummary({ id: 'c1', name: 'todo', arguments: { action: 'add', id: 3 } }),
    ).toBe('todo: add(3)')
    expect(
      formatToolCallSummary({ id: 'c1', name: 'todo', arguments: { action: 'add', id: 'abc' } }),
    ).toBe('todo: add(abc)')
    expect(formatToolCallSummary({ id: 'c1', name: 'todo', arguments: { action: 'add' } })).toBe(
      'todo: add',
    )
    expect(formatToolCallSummary({ id: 'c1', name: 'todo', arguments: {} })).toBe('todo')
  })

  it('subagent：task 截断 40 字；无 task → 仅工具名', () => {
    expect(
      formatToolCallSummary({ id: 'c1', name: 'subagent', arguments: { task: 'do work' } }),
    ).toBe('subagent: do work')
    expect(
      formatToolCallSummary({
        id: 'c1',
        name: 'subagent',
        arguments: { task: 'x'.repeat(41) },
      }),
    ).toBe(`subagent: ${'x'.repeat(40)}…`)
    expect(formatToolCallSummary({ id: 'c1', name: 'subagent', arguments: {} })).toBe('subagent')
  })
})

describe('formatToolCallSummary — coding-workflow-* / unknown fallback', () => {
  it('coding-workflow-gate：phase 存在（任意类型 String() 化）；缺 phase → 仅工具名', () => {
    expect(
      formatToolCallSummary({
        id: 'c1',
        name: 'coding-workflow-gate',
        arguments: { phase: 'prompt' },
      }),
    ).toBe('cw-gate: phase=prompt')
    // 非 string phase（number）→ String() 化
    expect(
      formatToolCallSummary({ id: 'c1', name: 'coding-workflow-gate', arguments: { phase: 2 } }),
    ).toBe('cw-gate: phase=2')
    expect(
      formatToolCallSummary({ id: 'c1', name: 'coding-workflow-gate', arguments: {} }),
    ).toBe('cw-gate')
  })

  it('coding-workflow-init：slug 存在 / 缺失', () => {
    expect(
      formatToolCallSummary({
        id: 'c1',
        name: 'coding-workflow-init',
        arguments: { slug: 'abc' },
      }),
    ).toBe('cw-init: abc')
    expect(
      formatToolCallSummary({ id: 'c1', name: 'coding-workflow-init', arguments: {} }),
    ).toBe('cw-init')
  })

  it('coding-workflow-phase-start：恒为 cw-phase-start（忽略参数）', () => {
    expect(
      formatToolCallSummary({ id: 'c1', name: 'coding-workflow-phase-start', arguments: {} }),
    ).toBe('cw-phase-start')
    expect(
      formatToolCallSummary({
        id: 'c1',
        name: 'coding-workflow-phase-start',
        arguments: { phase: 'x' },
      }),
    ).toBe('cw-phase-start')
  })

  it('unknown fallback：空 arguments → 仅工具名；非空 → JSON 前 50 字截断；循环引用 → 仅工具名', () => {
    expect(formatToolCallSummary({ id: 'c1', name: 'my-tool', arguments: {} })).toBe('my-tool')
    // JSON 16 字 ≤ 50 → 不截断
    expect(
      formatToolCallSummary({ id: 'c1', name: 'my-tool', arguments: { long: 'value' } }),
    ).toBe('my-tool: {"long":"value"}')
    // JSON 68 字 > 50 → 前 50 + 省略号（'{"a":"' 6 字 + 44 x）
    expect(
      formatToolCallSummary({
        id: 'c1',
        name: 'my-tool',
        arguments: { a: 'x'.repeat(60) },
      }),
    ).toBe(`my-tool: {"a":"${'x'.repeat(44)}…`)
    // JSON.stringify 抛错（循环引用）→ 仅工具名
    const circ: Record<string, unknown> = { a: 1 }
    circ.self = circ
    expect(formatToolCallSummary({ id: 'c1', name: 'my-tool', arguments: circ })).toBe('my-tool')
  })

  it('treats prototype-chain key names as unknown (Map lookup, no Object.prototype hit)', () => {
    // 表驱动用 Map 查找的语义锚：普通对象下标会把 "constructor"/"toString"/"__proto__"
    // 解析到 Object.prototype（formatter 命中非函数成员返回对象/抛 TypeError），
    // 这里必须与其它未知 toolName 同走 formatUnknownTool fallback 分支。
    expect(formatToolCallSummary({ id: 'c1', name: 'constructor', arguments: {} })).toBe(
      'constructor',
    )
    expect(formatToolCallSummary({ id: 'c1', name: 'toString', arguments: {} })).toBe('toString')
    expect(formatToolCallSummary({ id: 'c1', name: '__proto__', arguments: { a: 1 } })).toBe(
      '__proto__: {"a":1}',
    )
  })
})

describe('extractToolCalls — 提取 + coerceArgs 兜底', () => {
  it('无 message / content 非数组 → 空数组', () => {
    expect(extractToolCalls({ type: 'message', id: 'm1', parentId: null })).toEqual([])
    expect(extractToolCalls(entryWithContent('plain text'))).toEqual([])
    expect(extractToolCalls(entryWithContent([]))).toEqual([])
  })

  it('过滤非 toolCall block / 缺 id / 缺 name 的 block', () => {
    const content = [
      null,
      'str',
      { type: 'text', text: 'hi' },
      { type: 'toolCall', name: 'bash' }, // 缺 id
      { type: 'toolCall', id: 42, name: 'bash' }, // id 非 string
      { type: 'toolCall', id: 'c2' }, // 缺 name
      { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
    ]
    const out = extractToolCalls(entryWithContent(content))
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ id: 'c1', name: 'bash', arguments: { command: 'ls' } })
  })

  it('coerceArgs：object 原样；string JSON 解析；非法 string / number / null / array / boolean → {}', () => {
    const blocks = (args: unknown) => [{ type: 'toolCall', id: 'c1', name: 't', arguments: args }]
    // object 原样
    expect(extractToolCalls(entryWithContent(blocks({ a: 1 })))[0].arguments).toEqual({ a: 1 })
    // string JSON → 解析
    expect(
      extractToolCalls(entryWithContent(blocks('{"command":"ls"}')))[0].arguments,
    ).toEqual({ command: 'ls' })
    // 非法 JSON → {}
    expect(extractToolCalls(entryWithContent(blocks('not-json')))[0].arguments).toEqual({})
    // JSON 解析结果非 object（'42' → number）→ {}
    expect(extractToolCalls(entryWithContent(blocks('42')))[0].arguments).toEqual({})
    // number / null / array / boolean / undefined → {}
    expect(extractToolCalls(entryWithContent(blocks(5)))[0].arguments).toEqual({})
    expect(extractToolCalls(entryWithContent(blocks(null)))[0].arguments).toEqual({})
    expect(extractToolCalls(entryWithContent(blocks([1, 2])))[0].arguments).toEqual({})
    expect(extractToolCalls(entryWithContent(blocks(true)))[0].arguments).toEqual({})
    expect(extractToolCalls(entryWithContent(blocks(undefined)))[0].arguments).toEqual({})
  })
})
