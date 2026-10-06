/**
 * stream-view-items 逐项恒等缓存测试（streaming perf）。
 *
 * 覆盖（行为不变义务的机器锚）：
 * - 同输入二次构建 → 同数组引用 + 同 view item 对象引用（preview 零重算的证据）
 * - streaming 末位 turn 引用替换（同内容新对象）→ 仅末位重建，历史项对象引用逐位复用
 * - 标量入参（lastRenderTurn）变化 → 只重建受影响项（isLastTurn 翻转项），其余复用
 * - 尾部 append（长度变化）→ 新增位重建，既有位复用（前缀复用不因长度失效）
 * - broken 项不缓存复用：同位置下一帧重试正常构建（瞬时故障不固化）
 * - [索引一致性硬约束] 任意输入下返回数组与入参 1:1（同长度同顺序）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/stream-view-items.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { DeepReadonly } from 'vue'
import { buildStreamViewItems } from '@/components/panel/message-stream/stream-view-items'
import type { Message } from '@taiji/shared'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { SkillNoticeEntry, SkillNoticeStreamItem } from '@/composables/panel/useSkillNoticeStream'

function makeUserMsg(id: string, content: string): Message {
  return { id, role: 'user', content, status: 'complete', timestamp: 0 } as Message
}

function turnFixture(index: number, userId: string, content: string, over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index,
    user: makeUserMsg(userId, content),
    assistants: [],
    isStreaming: false,
    ...over,
  } as MessageTurn
}

function turnItem(turn: MessageTurn): SkillNoticeStreamItem {
  return { kind: 'turn', turn }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildStreamViewItems — 逐项恒等缓存（streaming perf）', () => {
  it('同输入二次构建：同数组引用 + 同 view item 对象引用（缓存命中，preview 不重算）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const items = [
      turnItem(turnFixture(0, 'u1', 'first question')),
      turnItem(turnFixture(1, 'u2', 'second question')),
    ]
    const first = buildStreamViewItems(items, 1, items[1]!.turn)
    const second = buildStreamViewItems(items, 1, items[1]!.turn)

    expect(second).toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    // 内容仍逐字节正确（引用复用不改变投影值）
    expect(second[1]).toMatchObject({ kind: 'turn', key: 't-u2', preview: 'second question', canEdit: true, isLastTurn: true })
  })

  it('streaming 末位 turn 引用替换（同内容新对象）：仅末位重建，历史项对象引用逐位复用', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const historyTurn = turnFixture(0, 'u1', 'history question')
    const lastTurn = turnFixture(1, 'u2', 'streaming question')
    const items = [turnItem(historyTurn), turnItem(lastTurn)]
    const first = buildStreamViewItems(items, 1, lastTurn)

    // 模拟 toRenderItemsIncremental 每 delta 重建末位 turn（新对象，同内容）
    const rebuiltLast = turnFixture(1, 'u2', 'streaming question')
    const second = buildStreamViewItems([turnItem(historyTurn), turnItem(rebuiltLast)], 1, rebuiltLast)

    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0]) // 历史项复用（preview 不重算的核心收益）
    expect(second[1]).not.toBe(first[1]) // 末位重建
    expect(second[1]).toMatchObject({ key: 't-u2', preview: 'streaming question', isLastTurn: true })
  })

  it('lastRenderTurn 变化（isLastTurn 翻转）→ 只重建受影响项，其余项对象引用复用', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const turnA = turnFixture(0, 'u1', 'a')
    const turnB = turnFixture(1, 'u2', 'b')
    const items = [turnItem(turnA), turnItem(turnB)]
    const first = buildStreamViewItems(items, 1, turnB)
    expect(first[1]).toMatchObject({ isLastTurn: true })

    // 末位判定目标换成不在 items 里的 turn：turnB 的 isLastTurn true → false（重建），
    // turnA 仍 false（显式比对通过 → 复用）
    const outsider = turnFixture(9, 'u9', 'later')
    const second = buildStreamViewItems(items, 1, outsider)

    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1]).toMatchObject({ isLastTurn: false })
  })

  it('尾部 append（长度变化）→ 新增位重建，派生字段未变的既有位引用复用', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const turnA = turnFixture(0, 'u1', 'a')
    const items = [turnItem(turnA)]
    // 首帧 lastUserTurnIdx=-1 / lastRenderTurn=null：turnA 的 canEdit/isLastTurn 均为 false
    const first = buildStreamViewItems(items, -1, null)

    // append 后 turnA 的派生字段不变（lastUserTurnIdx=1 不落 turnA，末位是 turnB）→ 复用
    const turnB = turnFixture(1, 'u2', 'b')
    const second = buildStreamViewItems([turnItem(turnA), turnItem(turnB)], 1, turnB)

    expect(second).toHaveLength(2)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toMatchObject({ kind: 'turn', key: 't-u2', canEdit: true })
  })

  it('broken 项不缓存复用：同位置下一帧重试正常构建（瞬时故障不固化）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const brokenItems = [{ kind: 'turn', turn: undefined } as unknown as SkillNoticeStreamItem]
    const first = buildStreamViewItems(brokenItems, -1, null)
    expect(first[0]).toMatchObject({ kind: 'broken', key: 'broken-0' })

    // 数据修复（同位置换成可正常求值的项）→ 重新构建成功，不固化 broken
    const okTurn = turnFixture(0, 'u1', 'recovered')
    const second = buildStreamViewItems([turnItem(okTurn)], -1, okTurn)
    expect(second[0]).toMatchObject({ kind: 'turn', key: 't-u1' })

    // broken 位置维持 broken 输入 → 每帧重试（warn 逐帧记录，与旧行为一致）
    buildStreamViewItems(brokenItems, -1, null)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  it('[索引一致性硬约束] 各形态下返回数组与入参 1:1（同长度同顺序，broken 占位不删位）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const okTurn = turnFixture(0, 'u1', 'ok')
    const items = [
      { kind: 'turn', turn: undefined } as unknown as SkillNoticeStreamItem,
      turnItem(okTurn),
      { kind: 'bashExecution', message: makeUserMsg('b1', 'bash line') } as unknown as SkillNoticeStreamItem,
      { kind: 'systemNotice', message: makeUserMsg('s1', 'system line') } as unknown as SkillNoticeStreamItem,
    ]
    const views = buildStreamViewItems(items, 1, okTurn)
    expect(views).toHaveLength(items.length)
    expect(views.map((v) => v.key)).toEqual(['broken-0', 't-u1', 's-b1', 's-s1'])
  })

  it('skillNotice 项按 entry 引用恒等复用', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entry = { id: 'n-sig', reason: 'skill_missing', skills: ['a', 'b'] } as DeepReadonly<SkillNoticeEntry>
    const item: SkillNoticeStreamItem = { kind: 'skillNotice', entry }
    const first = buildStreamViewItems([item], -1, null)
    const second = buildStreamViewItems([item], -1, null)
    expect(second[0]).toBe(first[0])
    expect(first[0]).toMatchObject({ kind: 'skillNotice', key: 'n-sig', preview: 'a, b' })
  })
})
