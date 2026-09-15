/**
 * subagent-directive 双链路测试（composer-symbol-system §3.3.3a，U2c-runtime）。
 *
 * 锁定三条不变量：
 * 1. live 链路：pi message_end{role:'custom', customType:'subagent-directive'} → 附加
 *    subagent.directive 广播（字段齐全、带 sessionId）；message_start 不产（pi sendMessage
 *    对同一 message 双发 start+end，挂 start 会双广播）；非 directive custom 消息零影响（回归）。
 * 2. reload 链路：JSONL 含 subagent-directive custom_message entry → rebuildHistoryFromEntries
 *    产出的聊天流含定向消息项（custom system message + display:true 覆写）；旧 session 零变化。
 * 3. live ≡ reload（关键规则 9）：同一 entry 数据喂两条链路，广播 payload 字段与 reload
 *    消息项经 parseSubagentDirective 解析的字段相等（共享构造单点）。
 *
 * translate / rebuildHistoryFromEntries 均为纯函数，直接调用断言。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/subagent-directive.test.ts
 */
import { describe, it, expect } from 'vitest'
import { translate } from '../event-adapter.js'
import { rebuildHistoryFromEntries } from '../entry-tree-builder.js'
import { parseSubagentDirective, SUBAGENT_DIRECTIVE_CUSTOM_TYPE } from '@taiji/shared'
import type { ServerMessage } from '@taiji/shared'
import type { PiTranslatedEvent } from '../../../services/session/types.js'
import type { PiEvent, PiMessageEndEvent, PiMessageStartEvent, PiSessionEntry, PiSessionCustomMessageEntry } from '../pi-protocol.js'

const SID = 'sess-directive-1'

/** 定向消息的权威 entry 数据（extension 经 pi.sendMessage 落盘形态，commit 21578c74f 实测）。 */
const DIRECTIVE_MESSAGE = {
  role: 'custom',
  customType: SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
  content: '刚才的测试结果再展开讲讲',
  display: false,
  details: { subagentId: 'sub-abc-1', slug: 'build-api', direction: 'user' },
  timestamp: 1755900000000,
}

/** 构造 pi message_end 事件（message 体可定制，模拟 pi emit 的 wire 形态）。 */
function messageEnd(message: Record<string, unknown>): PiMessageEndEvent {
  return { type: 'message_end', message } as unknown as PiMessageEndEvent
}

/** 构造 pi message_start 事件。 */
function messageStart(message: Record<string, unknown>): PiMessageStartEvent {
  return { type: 'message_start', message } as unknown as PiMessageStartEvent
}

/** 从 translate 产出中筛出 WS 消息（剥掉 trace-trigger 等非 message 中间事件）。 */
function wireMessages(events: PiTranslatedEvent[]): ServerMessage[] {
  return events.filter((e): e is Extract<PiTranslatedEvent, { kind: 'message' }> => e.kind === 'message')
    .map((e) => e.message)
}

/** 构造 subagent-directive custom_message entry（pi session JSONL 持久化形态）。 */
function makeDirectiveEntry(overrides?: { details?: unknown; content?: unknown }): PiSessionCustomMessageEntry {
  return {
    type: 'custom_message',
    id: 'dir00001',
    parentId: null,
    timestamp: '2026-08-24T10:00:00.000Z',
    customType: SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
    content: (overrides?.content ?? DIRECTIVE_MESSAGE.content) as string,
    display: false,
    details: (overrides?.details ?? DIRECTIVE_MESSAGE.details) as Record<string, unknown>,
  }
}

// ── 1. live 链路（event-adapter）──────────────────────────────────────

describe('subagent-directive live 链路（event-adapter）', () => {
  it('message_end{custom, subagent-directive} → 附加 subagent.directive 广播（字段齐全 + sessionId）', () => {
    const messages = wireMessages(translate(messageEnd(DIRECTIVE_MESSAGE), SID))

    // 既有 message.message_end 帧保持不变（generic 通路，customStart 已喂 reducer，此帧被
    // registry 端 custom 去双计跳过——不因新增广播改变）
    expect(messages.filter((m) => m.type === 'message.message_end')).toHaveLength(1)
    // ★ 新增定向广播
    const directive = messages.filter((m) => m.type === 'subagent.directive')
    expect(directive).toHaveLength(1)
    expect(directive[0]!.payload).toEqual({
      sessionId: SID,
      subagentId: 'sub-abc-1',
      slug: 'build-api',
      direction: 'user',
      text: '刚才的测试结果再展开讲讲',
    })
  })

  it('message_start{custom, subagent-directive} → 仅 message.customStart，不产 subagent.directive（pi 双发防双广播）', () => {
    const messages = wireMessages(translate(messageStart(DIRECTIVE_MESSAGE), SID))

    // generic customStart 通路不变（display:false → 前端不可见，可见气泡归 message_end 侧广播）
    const customStart = messages.filter((m) => m.type === 'message.customStart')
    expect(customStart).toHaveLength(1)
    // ★ 定向广播唯一产出点是 message_end——start 侧产出即为双广播 bug
    expect(messages.filter((m) => m.type === 'subagent.directive')).toHaveLength(0)
  })

  it('message_end{custom, 非 subagent-directive} → 无 subagent.directive（现状行为回归）', () => {
    const messages = wireMessages(translate(messageEnd({
      role: 'custom',
      customType: 'subagent-bg-notify',
      content: 'Subagent done',
      display: true,
      details: { id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000 },
      timestamp: 1755900000000,
    }), SID))

    expect(messages.filter((m) => m.type === 'message.message_end')).toHaveLength(1)
    expect(messages.filter((m) => m.type === 'subagent.directive')).toHaveLength(0)
  })

  it('message_end{subagent-directive, details 畸形} → 降级不广播（generic 通路不受影响）', () => {
    const cases: Array<{ name: string; details: unknown }> = [
      { name: '缺 slug', details: { subagentId: 'sub-1', direction: 'user' } },
      { name: 'direction 非 user', details: { subagentId: 'sub-1', slug: 's', direction: 'assistant' } },
      { name: 'subagentId 类型错', details: { subagentId: 123, slug: 's', direction: 'user' } },
      { name: 'details 为 null', details: null },
    ]
    for (const c of cases) {
      const messages = wireMessages(translate(messageEnd({
        ...DIRECTIVE_MESSAGE,
        details: c.details,
      }), SID))
      expect(messages.filter((m) => m.type === 'subagent.directive'), c.name).toHaveLength(0)
      expect(messages.filter((m) => m.type === 'message.message_end'), c.name).toHaveLength(1)
    }
  })
})

// ── 2. reload 链路（entry-tree-builder ← mapSessionEntries）──────────

describe('subagent-directive reload 链路（rebuildHistoryFromEntries）', () => {
  it('JSONL 含 subagent-directive entry → 聊天流含定向消息项（形态 + 顺序 + display 覆写）', () => {
    const entries: PiSessionEntry[] = [
      {
        type: 'message', id: 'm1', parentId: null, timestamp: '2026-08-24T09:59:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '派个 subagent' }], timestamp: 1755899940000 },
      },
      makeDirectiveEntry(),
      {
        type: 'message', id: 'm2', parentId: null, timestamp: '2026-08-24T10:01:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: 1755900060000 },
      },
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    // user + system(定向) + assistant，顺序保留（关键规则 9：重开后定向气泡仍在原位）
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
    const directive = messages[1]!
    // ★ U2b 渲染契约：custom system message 承载定向数据（customType 判别 + content=text +
    // details={subagentId,slug,direction} + display:true 覆写——false 是 pi TUI 语义）
    expect(directive.customType).toBe(SUBAGENT_DIRECTIVE_CUSTOM_TYPE)
    expect(directive.content).toBe('刚才的测试结果再展开讲讲')
    expect(directive.details).toEqual({ subagentId: 'sub-abc-1', slug: 'build-api', direction: 'user' })
    expect(directive.display).toBe(true)
    expect(directive.status).toBe('complete')
  })

  it('旧 session（无 subagent-directive entry）→ 零变化（bg-notify display 覆写不受影响）', () => {
    const entries: PiSessionEntry[] = [
      {
        type: 'message', id: 'm1', parentId: null, timestamp: '2026-08-24T09:59:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '跑个后台任务' }], timestamp: 1755899940000 },
      },
      {
        type: 'custom_message', id: 'cm1', parentId: null, timestamp: '2026-08-24T10:00:00.000Z',
        customType: 'subagent-bg-notify',
        content: 'Subagent done',
        display: true, // pi 可能持久化 true——完成通知类覆写 false（既有行为）
        details: { id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000 },
      },
    ]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(['user', 'system'])
    // 完成通知类 display 覆写 false（既有 SSOT 行为不回归）
    expect(messages[1]!.customType).toBe('subagent-bg-notify')
    expect(messages[1]!.display).toBe(false)
  })

  it('details 畸形的 subagent-directive entry → display 透传不覆写（隐藏，与 live 降级对称），不崩溃', () => {
    const entries: PiSessionEntry[] = [makeDirectiveEntry({ details: { subagentId: 'sub-1' } })]

    const { messages } = rebuildHistoryFromEntries(entries, null)

    expect(messages).toHaveLength(1)
    expect(messages[0]!.customType).toBe(SUBAGENT_DIRECTIVE_CUSTOM_TYPE)
    // 畸形 → 不覆写，extension 落的 false 透传 → 前端隐藏（两链路对畸形数据一致不可见）
    expect(messages[0]!.display).toBe(false)
  })
})

// ── 3. live ≡ reload 双链路一致性（关键规则 9）───────────────────────

describe('subagent-directive live ≡ reload 字段一致性', () => {
  it('同一 entry 数据喂两条链路 → 广播 payload 与 reload 消息项 parse 结果字段相等', () => {
    // live：pi message_end 事件（extension sendMessage 后 pi emit 的 wire 形态）
    const liveMessages = wireMessages(translate(messageEnd(DIRECTIVE_MESSAGE), SID))
    // 类型谓词收窄到 ServerMessage<'subagent.directive'>——payload 字段编译期即受
    // ServerMessageMap 契约校验（D5 收益），无需运行时字段存在性防御
    const broadcast = liveMessages.find(
      (m): m is ServerMessage<'subagent.directive'> => m.type === 'subagent.directive',
    )

    // reload：同一条消息在 session JSONL 的持久化形态（custom_message entry）
    const { messages } = rebuildHistoryFromEntries([makeDirectiveEntry()], null)
    const directiveMsg = messages.find((m) => m.customType === SUBAGENT_DIRECTIVE_CUSTOM_TYPE)

    expect(broadcast).toBeDefined()
    expect(directiveMsg).toBeDefined()
    const { subagentId, slug, direction, text, sessionId } = broadcast!.payload
    // ★ reload 消息项（content + details）经同一解析器还原出的定向数据 = 广播去掉 sessionId 的字段
    const reloadParsed = parseSubagentDirective(directiveMsg!.content, directiveMsg!.details)
    expect(reloadParsed).toEqual({ subagentId, slug, direction, text })
    // 广播必带 sessionId（架构约定 #7）
    expect(sessionId).toBe(SID)
  })

  it('pi sendMessage 时序模拟：message_start → message_end 只产一次定向广播', () => {
    // pi sendMessage 无 triggerTurn 的真实事件序（0.84.1 dist agent-session.js:1093-1096）：
    // append entry 后连发 message_start + message_end（同一 message 对象）
    const startMessages = wireMessages(translate(messageStart(DIRECTIVE_MESSAGE), SID))
    const endMessages = wireMessages(translate(messageEnd(DIRECTIVE_MESSAGE), SID))

    const total = [...startMessages, ...endMessages].filter((m) => m.type === 'subagent.directive')
    // ★ 全事件流恰好一条定向广播（挂 message_end 单点 + start 不产，双发源头防双计）
    expect(total).toHaveLength(1)
  })
})

// 显式引用 PiEvent 联合（translate 入参契约——与 event-adapter-delta.test.ts 同款收窄用法）
type _PiEventCheck = PiEvent
