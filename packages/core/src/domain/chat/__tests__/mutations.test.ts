/**
 * domain/chat mutations 单测（W10 D-1 容器范式适配 + W13 R-17 核心断言重写 + [u6] 游标翻页前插）。
 *
 * 锁定 commitMessages/deleteMessages/truncateMessagesFrom/prependHistory 在
 * `Map<string, ShallowRef<Message[]>>` 容器下的写入语义（07 文档 §3.3.2 不变式）：
 * 1. 外层 Map 引用只在「增删 sid key」时替换；sid 已存在时 commit 只替换内层 ref 的 .value。
 * 2. 每 sid 的分区 ref 一旦创建（首次 commit），引用在 session 存活期间稳定。
 * 3. 分区隔离：A sid commit 不触碰 B sid 的分区 ref（引用与内容均不动）。
 *
 * [u6] 「加载更早」改走 session.history 游标翻页（crash-resilience §3.3 D4 中期），
 * splitHistoryBeforeAnchor 锚定切分链整体退役；prependHistory 保留兜底断言
 * （命中重复 warn + 行为仍去重）+ 游标页前插端到端行为断言。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { shallowRef } from 'vue'
import type { Message } from '@taiji/shared'
import { textToSegments } from '@taiji/shared'
import {
  commitMessages,
  deleteMessages,
  truncateMessagesFrom,
  prependHistory,
  type MessagesRef,
} from '../mutations'

function makeMessage(id: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

/** 文件侧 user 消息（hydrate/全量路径产物形态：id 与 piEntryId 均为 entry 派生 id） */
function fileUser(entryId: string, text: string, timestamp: number): Message {
  return { id: entryId, piEntryId: entryId, role: 'user', content: text, status: 'complete', timestamp }
}

/** 文件侧 assistant 消息（同 fileUser，role 区分供指纹路径断言） */
function fileAssistant(entryId: string, text: string, timestamp: number): Message {
  return { id: entryId, piEntryId: entryId, role: 'assistant', content: text, status: 'complete', timestamp }
}

/** 文件侧 system 消息（compaction 等族：无 piEntryId 字段，id 即 entry 派生 id——对称取值的关键形态） */
function fileSystem(entryId: string, text: string, timestamp: number): Message {
  return { id: entryId, role: 'system', content: text, status: 'complete', timestamp }
}

/** live 侧 user 消息（appendUser 直插形态：u- 前缀 id、content 为 Segment[]、无 piEntryId） */
function liveUser(id: string, text: string): Message {
  return { id, role: 'user', content: textToSegments(text), status: 'complete', timestamp: 99 }
}

/** live 侧 assistant 消息（overlay 路径形态：e<N> 派生 id、无 piEntryId） */
function liveAssistant(id: string, text: string): Message {
  return { id, role: 'assistant', content: text, status: 'complete', timestamp: 99 }
}

/** seed 值用真实 shallowRef 构造（与生产 store 声明同形态） */
function makeRef(seed: Record<string, Message[]> = {}): MessagesRef {
  return {
    value: new Map(Object.entries(seed).map(([sid, msgs]) => [sid, shallowRef(msgs)])),
  }
}

describe('commitMessages', () => {
  it('首次建 key：外层 Map 引用替换 + 新 key + 内层 .value 内容正确', () => {
    const ref = makeRef()
    const before = ref.value
    commitMessages(ref, 's1', [makeMessage('m1')])
    expect(ref.value).not.toBe(before) // 增 session 是外层 Map 替换的唯一触发点
    expect(ref.value.has('s1')).toBe(true)
    expect(ref.value.get('s1')!.value).toHaveLength(1)
    expect(ref.value.get('s1')!.value[0].id).toBe('m1')
  })

  it('同 sid commit：外层 Map 引用恒等 + 分区 ref 引用恒等 + 内层 .value 数组替换', () => {
    const ref = makeRef()
    commitMessages(ref, 's1', [makeMessage('m1')])
    const mapAfterFirst = ref.value
    const partition = ref.value.get('s1')!
    const arrBefore = partition.value

    commitMessages(ref, 's1', [makeMessage('m1'), makeMessage('m2')])

    expect(ref.value).toBe(mapAfterFirst) // 不变式 1：同 sid 更新不替换外层 Map
    expect(ref.value.get('s1')).toBe(partition) // 不变式 2：分区 ref 引用稳定
    expect(partition.value).not.toBe(arrBefore) // 数组整体替换（触发 shallowRef 响应）
    expect(partition.value.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('分区隔离：A sid commit 不动 B sid 的分区 ref（引用与内容均不变）', () => {
    const ref = makeRef({ a: [makeMessage('a1')], b: [makeMessage('b1')] })
    const mapBefore = ref.value
    const partitionB = ref.value.get('b')!
    const arrB = partitionB.value

    commitMessages(ref, 'a', [makeMessage('a1'), makeMessage('a2')])

    expect(ref.value).toBe(mapBefore) // Map 恒等（'a' 已存在，不建 key）
    expect(ref.value.get('b')).toBe(partitionB) // B 分区 ref 引用不变
    expect(ref.value.get('b')!.value).toBe(arrB) // B 分区数组引用不变
    expect(ref.value.get('a')!.value.map((m) => m.id)).toEqual(['a1', 'a2'])
  })

  it('保留其他 session 的既有条目（不原地 mutation）', () => {
    const ref = makeRef({ s0: [makeMessage('m0')] })
    commitMessages(ref, 's1', [makeMessage('m1')])
    expect(ref.value.get('s0')!.value).toHaveLength(1)
    expect(ref.value.get('s1')!.value).toHaveLength(1)
  })
})

describe('deleteMessages', () => {
  it('delete 后外层 Map 替换 + 条目消失 + 其他分区 ref 引用稳定', () => {
    const ref = makeRef({ s0: [makeMessage('m0')], s1: [makeMessage('m1')] })
    const before = ref.value
    const partitionS1 = ref.value.get('s1')!
    deleteMessages(ref, 's0')
    expect(ref.value).not.toBe(before) // 减 session 触发 Map 替换
    expect(ref.value.has('s0')).toBe(false)
    expect(ref.value.has('s1')).toBe(true)
    expect(ref.value.get('s1')).toBe(partitionS1) // 未删分区 ref 引用不变
  })

  it('删除不存在的 key：Map 仍整体替换，其他条目内容不变', () => {
    const ref = makeRef({ s0: [makeMessage('m0')] })
    const before = ref.value
    deleteMessages(ref, 'nope')
    expect(ref.value).not.toBe(before) // deleteMessages 无条件 new Map 整体替换（不查 key 是否存在）
    expect(ref.value.has('nope')).toBe(false)
    expect(ref.value.get('s0')!.value).toHaveLength(1)
  })

  it('泛型 V 兼容 Map<string, unknown> 宽类型（chat-lru deps 用）', () => {
    const ref: { value: Map<string, unknown> } = { value: new Map([['a', 1]]) }
    deleteMessages(ref, 'a')
    expect(ref.value.has('a')).toBe(false)
  })
})

describe('truncateMessagesFrom', () => {
  const msgs = [makeMessage('a'), makeMessage('b'), makeMessage('c')]

  it('inclusive=true：截断包含 messageId，保留其之前（编辑重发语义，useChat editAndResend 传 true）', () => {
    const ref = makeRef({ s1: msgs })
    truncateMessagesFrom(ref, 's1', 'b', true)
    expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a'])
  })

  it('inclusive=false：截断不包含 messageId，保留到含 messageId', () => {
    const ref = makeRef({ s1: msgs })
    truncateMessagesFrom(ref, 's1', 'b', false)
    expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('messageId 不存在：no-op，不写入', () => {
    const ref = makeRef({ s1: msgs })
    const mapBefore = ref.value
    const partition = ref.value.get('s1')!
    const arrBefore = partition.value
    truncateMessagesFrom(ref, 's1', 'zzz', true)
    expect(ref.value).toBe(mapBefore) // 幂等：Map 不替换
    expect(partition.value).toBe(arrBefore) // 分区数组引用也不变（未走 commit）
    expect(ref.value.get('s1')!.value).toHaveLength(3)
  })

  it('session 不存在：no-op（不新增条目）', () => {
    const ref = makeRef()
    const before = ref.value
    truncateMessagesFrom(ref, 'ghost', 'a', true)
    expect(ref.value).toBe(before)
    expect(ref.value.has('ghost')).toBe(false)
  })
})

describe('prependHistory', () => {
  it('按 messageId 去重合并到列表头部', () => {
    const ref = makeRef({ s1: [makeMessage('b'), makeMessage('c')] })
    prependHistory(ref, 's1', [makeMessage('a'), makeMessage('b')])
    expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('幂等：无新消息不触发写入（Map 与分区数组引用均不变）', () => {
    const ref = makeRef({ s1: [makeMessage('a')] })
    const before = ref.value
    const arrBefore = ref.value.get('s1')!.value
    prependHistory(ref, 's1', [makeMessage('a')])
    expect(ref.value).toBe(before)
    expect(ref.value.get('s1')!.value).toBe(arrBefore)
  })

  it('session 无历史时全量作为头部（走首建 key 分支，Map 替换）', () => {
    const ref = makeRef()
    const before = ref.value
    prependHistory(ref, 's1', [makeMessage('a'), makeMessage('b')])
    expect(ref.value).not.toBe(before) // 空分区 → 首建 key → Map 替换
    expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('[W5 D5] 兜底断言：命中重复即 console.warn（说明锚切分异常），行为仍去重（安全网）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ref = makeRef({ s1: [makeMessage('b'), makeMessage('c')] })
      prependHistory(ref, 's1', [makeMessage('a'), makeMessage('b'), makeMessage('c')])
      // 行为仍是安全网去重（锚切分异常时宁可少插不可重插）
      expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a', 'b', 'c'])
      // 断言面：命中重复必须出声（锚切分异常的诊断信号）
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toContain('prependHistory deduped 2')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('[W5 D5] 无重复时不 warn（锚切分正常路径零噪音）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ref = makeRef({ s1: [makeMessage('c')] })
      prependHistory(ref, 's1', [makeMessage('a'), makeMessage('b')])
      expect(ref.value.get('s1')!.value.map((m) => m.id)).toEqual(['a', 'b', 'c'])
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('prependHistory 游标翻页前插（u6 re-scope 后的唯一前插通路）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('[用户可见行为] 游标页前插：锚前页（runtime 返回）prepend 后对话流完整无重复、live 消息不被动', () => {
    // 场景（u6 crash-resilience §3.3 D4 中期）：session hydrate 最近窗口后又聊了两轮
    // （live 消息），点「加载更早」——runtime 按游标（分区最旧消息身份）返回锚点之前的
    // 最近窗口，页内容天然不与分区重叠。用户可见断言：对话流无重复、顺序稳定、live 不动。
    const tailWindow = [
      fileUser('ent-u2', 'question 2', 20), // ← hydrate 窗口首条 = 游标
      fileAssistant('ent-a2', 'answer 2', 21),
    ]
    const liveMsgs = [
      liveUser('u-111', 'question 3'),
      liveAssistant('e0', 'answer 3'),
    ]
    const ref = makeRef({ s1: [...tailWindow, ...liveMsgs] })

    // runtime 游标页（锚点 ent-u2 之前的窗口）：只含更早历史，无尾窗/live 对应物
    const cursorPage = [
      fileUser('ent-u0', 'question 0', 10),
      fileAssistant('ent-a0', 'answer 0', 11),
      fileUser('ent-u1', 'question 1', 15),
    ]

    prependHistory(ref, 's1', cursorPage)

    // 用户可见断言 1：对话流完整且无重复（更早页在前，尾窗与 live 依序保留）
    const finalMsgs = ref.value.get('s1')!.value
    const texts = finalMsgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    expect(texts).toEqual([
      'question 0', 'answer 0', 'question 1', // 前插的更早页（文件序）
      'question 2', 'answer 2', // hydrate 窗口
      JSON.stringify(textToSegments('question 3')), 'answer 3', // live 消息原样保留
    ])
    // 用户可见断言 2：live 消息不被重复（u-111/e0 恰好各一次）
    expect(finalMsgs.filter((m) => m.id === 'u-111')).toHaveLength(1)
    expect(finalMsgs.filter((m) => m.id === 'e0')).toHaveLength(1)
    // 用户可见断言 3：总数 = 更早页 + 窗口 + live
    expect(finalMsgs).toHaveLength(7)
  })

  it('空页（翻页到头 / cursor 未命中返回空页）不写入分区', () => {
    const ref = makeRef({ s1: [fileUser('ent-0', 'q0', 0)] })
    const before = ref.value.get('s1')!.value
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      prependHistory(ref, 's1', [])
      expect(ref.value.get('s1')!.value).toBe(before) // 引用不变（无 commit）
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
