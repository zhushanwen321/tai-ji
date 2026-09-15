/**
 * summarizeTurnForRail 纯函数测试（TC-w3-9 / TC-w3-10，w3 wave）。
 *
 * 覆盖 IF5 契约：
 * - TC-w3-9：markdown 富文本 → 剥标记 + 截断到 20 字纯文本
 * - TC-w3-10：user=null → 空串
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/logic/__tests__/summarizeTurn.test.ts
 */
import { describe, it, expect } from 'vitest'
import { summarizeTurnForRail, summarizeAssistantForRail } from '../summarizeTurn'
import type { MessageTurn } from '../messageTurns'
import type { Message } from '@taiji/shared'

/** 构造最小可用的 MessageTurn（用 as 断言绕开完整 Message 字段需求）。 */
function makeTurn(userContent: string | null): MessageTurn {
  return {
    index: 1,
    user:
      userContent === null
        ? null
        : ({ id: 'u1', role: 'user', content: userContent, status: 'done' } as MessageTurn['user']),
    assistants: [],
    isStreaming: false,
    hasFoldable: false,
  } as MessageTurn
}

describe('summarizeTurnForRail (IF5)', () => {
  it('TC-w3-9: 剥离 markdown 标记后取前 20 字纯文本', () => {
    // 标题 + 加粗 + 链接 + 行内代码混合
    const turn = makeTurn('# 修复 **trace** 渲染 [bug](https://x.com) `code`')
    const summary = summarizeTurnForRail(turn)
    // 预期：# / ** / [bug](url) / ` 全部剥离，纯文本 = "修复 trace 渲染 bug code"
    expect(summary).toBe('修复 trace 渲染 bug code')
    // 长度上限校验：短文本不加省略号
    expect(summary.length).toBeLessThanOrEqual(20)
  })

  it('TC-w3-9b: 超长文本截断到 20 字 + 省略号', () => {
    const longText = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
    // 30 字符的中文串，应截到 19 字 + '…' = 20 字符
    const summary = summarizeTurnForRail(makeTurn(longText))
    expect(summary.length).toBe(20)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary.startsWith('一二三四五六七八九十一二三四五六七八九')).toBe(true)
  })

  it('TC-w3-10: user 为 null 时返回空串', () => {
    expect(summarizeTurnForRail(makeTurn(null))).toBe('')
  })
})

/** 构造带 assistant 的 MessageTurn（agent 摘要测试用）。 */
function makeTurnWithAssistant(opts: {
  assistantContents?: string[]   // 多 assistant 的 content 数组（默认 [''] 空 content）
  thinkingCount?: number
  toolCount?: number
}): MessageTurn {
  const contents = opts.assistantContents ?? ['']
  const thinking = opts.thinkingCount
    ? Array.from({ length: opts.thinkingCount }, (_, i) => ({
        id: `th${i}`, content: `thinking ${i}`, collapsed: true,
      }))
    : undefined
  const toolCalls = opts.toolCount
    ? Array.from({ length: opts.toolCount }, (_, i) => ({
        id: `tc${i}`, toolName: 'read', input: { path: `f${i}.ts` },
        status: 'done' as const, startTime: 0,
      }))
    : undefined
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: '用户输入', status: 'done' } as Message,
    assistants: contents.map((c, i) => ({
      id: `a${i}`,
      role: 'assistant',
      content: c,
      status: 'done',
      thinking: i === 0 ? thinking : undefined,
      toolCalls: i === 0 ? toolCalls : undefined,
    } as Message)),
    isStreaming: false,
    hasFoldable: false,
  } as MessageTurn
}

describe('summarizeAssistantForRail', () => {
  it('TC-A1: content 非空 → 返回 content 截断（stripMarkdown 后）', () => {
    const turn = makeTurnWithAssistant({ assistantContents: ['修复了 **Block.vue** 的折叠状态'] })
    expect(summarizeAssistantForRail(turn)).toBe('修复了 Block.vue 的折叠状态')
  })

  it('TC-A2: content 空 + 有 thinking/tools → fallback 计数 N thoughts · M tools', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''], thinkingCount: 2, toolCount: 3 })
    expect(summarizeAssistantForRail(turn)).toBe('2 thoughts · 3 tools')
  })

  it('TC-A3: content 空 + 仅 thinking → 只显 N thoughts', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''], thinkingCount: 5 })
    expect(summarizeAssistantForRail(turn)).toBe('5 thoughts')
  })

  it('TC-A4: content 空 + 仅 tools → 只显 M tools', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''], toolCount: 4 })
    expect(summarizeAssistantForRail(turn)).toBe('4 tools')
  })

  it('TC-A5: content 空 + 无 thinking/tools → 返回空串（调用方显占位）', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''] })
    expect(summarizeAssistantForRail(turn)).toBe('')
  })

  it('TC-A6: 多 assistant → 取首个非空 content（不 concat）', () => {
    const turn = makeTurnWithAssistant({ assistantContents: ['', '', '最终回复'] })
    // 前两条空，取第三条非空 content
    expect(summarizeAssistantForRail(turn)).toBe('最终回复')
  })

  it('TC-A7: assistants 为空数组 → 返回空串', () => {
    const turn = { index: 1, user: null, assistants: [], isStreaming: false, hasFoldable: false } as MessageTurn
    expect(summarizeAssistantForRail(turn)).toBe('')
  })
})
