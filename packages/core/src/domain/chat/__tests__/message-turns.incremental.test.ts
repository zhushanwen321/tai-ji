/**
 * message-turns 纯函数单测 —— 分组规则 v2（W3，conversation-turn-attribution §3.3 D3/D4）
 * + toRenderItemsIncremental 增量缓存（D-4，08-render-layer §3.3.1，perf W21）。
 *
 * 分组规则 v2 验收口径（plan W3）：
 * - 5 条规则逐条覆盖：user 锚 / 隐藏完成通知边界（机制 A）/ assistant 归属 / inline notice
 *   归 turn 内（机制 C）/ 可见 system 边界（现状）
 * - 空 turn 折叠：连续边界折叠为一、边界后 user / 可见 system / 数组结束不产出空 trigger turn
 * - 隐藏通知参与边界但自身不渲染；inline notice 无当前 turn 退化为独立 static 项
 * - 纯函数等价：同一数组两次分组 deep-equal、输入不被 mutate（W6 等价性测试铺路）
 *
 * 增量缓存验收口径（plan W21）：
 * - ① 增量复用：同源数组引用第二次调用 cachedItems 引用恒等（零重算）
 * - ② 末位追加消息只重建末位 turn（前面 turn 对象引用 toBe 恒等）
 * - ③ forceWorking 变化只重算末位（源数组不变走快路径）
 * - ④ 非 turn 项（systemNotice/bashExecution）行为等价（快路径引用复用 + 重扫与全量版 deepEqual）
 * - ⑤ 缓存分区隔离：经 useSessionScopedState 工厂分区持有，sid A/B 互不污染、切回恢复、
 *   cleanup 后重建（ADR-0049 Map 分区语义）
 * - cache=undefined 退化路径与全量版输出 deepEqual；流式追加序列逐步与全量版等价
 *   （W3 起 toRenderItems 消费全量数组并在输出侧过滤 display:false，比较基准同输入）
 *
 * 前提：D-1 不可变消息身份（成员引用未变 = 内容未变）——fixture 严格遵守「更新 = 新对象替换」。
 *
 * 运行：cd packages/core && pnpm vitest run src/domain/chat/__tests__/message-turns.incremental.test.ts
 */
import { describe, it, expect } from 'vitest'
import { effectScope, ref, shallowRef } from 'vue'
import {
  toRenderItems,
  toRenderItemsIncremental,
  createTurnRenderCache,
  turnStableId,
  groupTurns,
} from '../message-turns'
import type { RenderItem, TurnRenderCache } from '../message-turns'
import { useSessionScopedState } from '../../../foundation/use-session-scoped-state'
import type { Message } from '@taiji/shared'

// ── fixture 构造 helper ───────────────────────────────────────────────

let seq = 0
function makeMsg(over: Partial<Message> = {}): Message {
  seq += 1
  return { id: `m${seq}`, role: 'assistant', content: '', status: 'complete', timestamp: 0, ...over }
}

function bashMsg(id: string, over: Partial<Message> = {}): Message {
  return makeMsg({
    id,
    role: 'system',
    content: '',
    bashExecution: {
      command: 'echo hi',
      output: 'hi',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1000,
    },
    ...over,
  })
}

/** 隐藏完成通知（subagent-bg-notify / workflow-result，display:false——生产端覆写形态） */
function notifyMsg(id: string, customType = 'subagent-bg-notify'): Message {
  return makeMsg({ id, role: 'system', customType, display: false, content: '' })
}

/** liveOnly 健康警告（stream_warn 形态；liveOnly 由 W2 在创建点打标，此处只构造读取） */
function liveWarnMsg(id: string): Message {
  return makeMsg({ id, role: 'system', content: 'stream 超时', liveOnly: true })
}

/** 收窄 helper：取 turn 项的 MessageTurn（非 turn 项抛错，测试自检用） */
function turnOf(item: RenderItem) {
  if (item.kind !== 'turn') throw new Error(`expected turn item, got ${item.kind}`)
  return item.turn
}

/** 混合 fixture：turn / systemNotice / bashExecution 全 kind 覆盖。
 *  bash 置于 c1（可见 system 边界）之后 → 无当前 turn → 退化独立 static 项（规则 4 兜底）；
 *  若置于 turn 内则按规则 v2 inline 归 turn（notices），不再产出独立 bashExecution 项。 */
function mixedFixture(): Message[] {
  return [
    makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
    makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
    makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
    bashMsg('bash-1'),
    makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
    makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
  ]
}

describe('toRenderItemsIncremental —— 退化路径与等价性', () => {
  it('cache=undefined 退化为全量版：输出与 toRenderItems deepEqual（forceWorking 双态）', () => {
    for (const fw of [false, true]) {
      const msgs = mixedFixture()
      expect(toRenderItemsIncremental(msgs, fw, undefined)).toEqual(
        toRenderItems(msgs, fw),
      )
    }
  })

  it('流式追加序列逐步等价：末位 assistant 对象逐步替换 + 新 turn + system 穿插，每步与全量版 deepEqual', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
    const a1v1 = makeMsg({ id: 'a1', role: 'assistant', content: '部分', status: 'streaming' })
    const steps: Message[][] = [
      [u1],
      [u1, a1v1],
      // token 推进 = 末位 assistant 新对象替换（D-1 不可变语义）
      [u1, makeMsg({ id: 'a1', role: 'assistant', content: '部分回复', status: 'streaming' })],
      // 新 turn 追加（上一末位 streaming 态应被校正为 false）
      [
        u1,
        makeMsg({ id: 'a1', role: 'assistant', content: '完整回复', status: 'complete' }),
        makeMsg({ id: 'c1', role: 'system', content: 'notice' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      ],
      [
        u1,
        makeMsg({ id: 'a1', role: 'assistant', content: '完整回复', status: 'complete' }),
        makeMsg({ id: 'c1', role: 'system', content: 'notice' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2', status: 'streaming' }),
      ],
    ]
    for (const step of steps) {
      expect(toRenderItemsIncremental(step, false, cache)).toEqual(
        toRenderItems(step, false),
      )
    }
  })

  it('display:false 非通知消息透明：分组消费全量数组，隐藏消息不产出渲染项、不切断 turn（D3 输出侧过滤）', () => {
    const cache = createTurnRenderCache()
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: 'hidden' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
    ]
    const items = toRenderItemsIncremental(msgs, false, cache)
    expect(items.map((i) => i.kind)).toEqual(['turn'])
    // a2 仍归 u1 的 turn（隐藏消息透明，不切断）；输出与全量版一致
    expect(turnOf(items[0]).assistants.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(items).toEqual(toRenderItems(msgs, false))
  })
})

describe('toRenderItemsIncremental —— ① 快路径零重算', () => {
  it('同源数组引用第二次调用：返回引用恒等 + turn 对象 toBe 恒等', () => {
    const cache = createTurnRenderCache()
    const msgs = mixedFixture()
    const r1 = toRenderItemsIncremental(msgs, false, cache)
    expect(r1).toBe(cache.cachedItems)
    // 快路径：同引用再次调用直接复用 cachedItems（含非 turn 项）不重扫（W4 起 filter 参数已移除——分组恒消费全量数组）
    const r2 = toRenderItemsIncremental(msgs, false, cache)
    expect(r2).toBe(r1)
    expect(turnOf(r2[0])).toBe(turnOf(r1[0]))
    expect(cache.lastSourceRef).toBe(msgs)
  })
})

describe('toRenderItemsIncremental —— ② 末位追加只重建末位 turn', () => {
  it('追加 assistant 进末位 turn：前面 turn 对象 toBe 恒等，末位 turn 重建（签名变化）', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const u2 = makeMsg({ id: 'u2', role: 'user' })
    const r1 = toRenderItemsIncremental([u1, a1, u2], false, cache)
    const a2 = makeMsg({ id: 'a2', role: 'assistant', content: 'r2' })
    const r2 = toRenderItemsIncremental([u1, a1, u2, a2], false, cache)
    expect(turnOf(r2[0])).toBe(turnOf(r1[0])) // 历史 turn 复用（身份恒等）
    expect(turnOf(r2[1])).not.toBe(turnOf(r1[1])) // 末位 turn 重建（[u2] → [u2,a2]）
    expect(turnOf(r2[1]).assistants.map((m) => m.id)).toEqual(['u2', 'a2'].slice(1))
    expect(r2).toEqual(toRenderItems([u1, a1, u2, a2], false))
  })

  it('追加新 user turn：历史 turn 全部 toBe 复用，新 turn 新建', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const r1 = toRenderItemsIncremental([u1, a1], false, cache)
    const u2 = makeMsg({ id: 'u2', role: 'user' })
    const a2 = makeMsg({ id: 'a2', role: 'assistant', content: 'r2' })
    const r2 = toRenderItemsIncremental([u1, a1, u2, a2], false, cache)
    expect(turnOf(r2[0])).toBe(turnOf(r1[0]))
    expect(turnOf(r2[1])).not.toBe(turnOf(r1[0]))
    expect(turnOf(r2[1]).index).toBe(2)
  })

  it('上次末位 turn 的 streaming 态过期被校正：追加新 turn 后旧末位 isStreaming 翻 false（不可变替换）', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1s = makeMsg({ id: 'a1', role: 'assistant', content: 'r', status: 'streaming' })
    const r1 = toRenderItemsIncremental([u1, a1s], false, cache)
    expect(turnOf(r1[0]).isStreaming).toBe(true)
    const u2 = makeMsg({ id: 'u2', role: 'user' })
    const r2 = toRenderItemsIncremental([u1, a1s, u2], false, cache)
    // turn1 不再是末位：isStreaming 校正为 false，对象不可变替换（ assistants 引用保留）
    expect(turnOf(r2[0]).isStreaming).toBe(false)
    expect(turnOf(r2[0])).not.toBe(turnOf(r1[0]))
    expect(turnOf(r2[0]).assistants).toBe(turnOf(r1[0]).assistants)
    expect(r2).toEqual(toRenderItems([u1, a1s, u2], false))
  })

  it('hasFoldable 随成员变化重算：追加带 thinking 的 assistant 后末位 turn hasFoldable=true', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const r1 = toRenderItemsIncremental([u1], false, cache)
    expect(turnOf(r1[0]).hasFoldable).toBe(false)
    const a1 = makeMsg({
      id: 'a1',
      role: 'assistant',
      thinking: [{ id: 'th1', content: '推理', collapsed: false }],
    })
    const r2 = toRenderItemsIncremental([u1, a1], false, cache)
    expect(turnOf(r2[0])).not.toBe(turnOf(r1[0]))
    expect(turnOf(r2[0]).hasFoldable).toBe(true)
  })
})

describe('toRenderItemsIncremental —— ③ forceWorking 变化只重算末位', () => {
  it('源数组不变 fw false→true：仅末位 turn 对象替换，历史 turn toBe 恒等；再次同参引用恒等', () => {
    const cache = createTurnRenderCache()
    // mixedFixture items = [turn, systemNotice, bashExecution, turn]（v2：bash 在可见 system
    // 边界后无当前 turn，退化独立 static 项），末位 turn 在 index 3
    const msgs = mixedFixture()
    const r1 = toRenderItemsIncremental(msgs, false, cache)
    const r2 = toRenderItemsIncremental(msgs, true, cache)
    expect(r2).not.toBe(r1)
    expect(turnOf(r2[0])).toBe(turnOf(r1[0])) // 历史 turn 复用
    const t1 = turnOf(r1[3])
    const t2 = turnOf(r2[3])
    expect(t2).not.toBe(t1) // 末位 turn 替换
    expect(t2.isStreaming).toBe(true)
    expect(t1.isStreaming).toBe(false)
    // bashExecution 项（末位 turn 前的 static 项）引用恒等复用
    expect(r2[2]).toBe(r1[2])
    expect(r2[2].kind).toBe('bashExecution')
    // cache 自洽：替换后再次同参 → 引用恒等（零重算）
    const r3 = toRenderItemsIncremental(msgs, true, cache)
    expect(r3).toBe(r2)
    // fw true→false 对称回退
    const r4 = toRenderItemsIncremental(msgs, false, cache)
    expect(turnOf(r4[3]).isStreaming).toBe(false)
    expect(turnOf(r4[0])).toBe(turnOf(r1[0]))
  })

  it('快路径末位 turn 查找正确跳过 static 项（末位是 bashExecution 时仍驱动最后一个 turn）', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    // v2：bash 之前先放可见 system（c1）关闭 turn → bash 无当前 turn 退化独立 static 项，
    // 末位形态 = [turn, systemNotice, bashExecution]（最后一个 turn 后跟两个 static 项）
    const c1 = makeMsg({ id: 'c1', role: 'system', content: 'notice' })
    const bash = bashMsg('bash-1')
    const msgs = [u1, a1, c1, bash]
    const r1 = toRenderItemsIncremental(msgs, false, cache)
    expect(r1.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'bashExecution'])
    const r2 = toRenderItemsIncremental(msgs, true, cache)
    expect(turnOf(r2[0]).isStreaming).toBe(true) // static 项之后的最后一个 turn 被正确驱动
    // static 项本身引用复用（不依赖 forceWorking）
    expect(r2[1]).toBe(r1[1])
    expect(r2[2]).toBe(r1[2])
  })

  it('末位 assistant status=streaming 时 fw 翻转 isStreaming 期望不变：引用恒等返回（零重算）', () => {
    const cache = createTurnRenderCache()
    const msgs = [
      makeMsg({ id: 'u1', role: 'user' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r', status: 'streaming' }),
    ]
    const r1 = toRenderItemsIncremental(msgs, false, cache)
    expect(turnOf(r1[0]).isStreaming).toBe(true)
    const r2 = toRenderItemsIncremental(msgs, true, cache)
    expect(r2).toBe(r1) // 期望值不变 → cachedItems 引用恒等
  })
})

describe('toRenderItemsIncremental —— ④ 非 turn 项行为等价', () => {
  it('快路径：systemNotice/bashExecution 项引用恒等复用（cachedItems 整体复用）', () => {
    const cache = createTurnRenderCache()
    const msgs = mixedFixture()
    const r1 = toRenderItemsIncremental(msgs, false, cache)
    const r2 = toRenderItemsIncremental(msgs, false, cache)
    expect(r2[1]).toBe(r1[1]) // systemNotice
    // items = [turn, systemNotice, bashExecution, turn]（长度 4，bash 在下标 2）
    expect(r2[2]).toBe(r1[2]) // bashExecution
    expect(r2[2].kind).toBe('bashExecution') // 确认下标 2 确是 bashExecution（防下标写错退化成 vacuous）
  })

  it('重扫路径：system 项重建但 message 引用相同、kind 相同，整体与全量版 deepEqual', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant' })
    const c1 = makeMsg({ id: 'c1', role: 'system', content: '压缩记录' })
    const bash = bashMsg('bash-1')
    const r1 = toRenderItemsIncremental([u1, a1, c1, bash], false, cache)
    const u2 = makeMsg({ id: 'u2', role: 'user' })
    const src2 = [u1, a1, c1, bash, u2]
    const r2 = toRenderItemsIncremental(src2, false, cache)
    expect(r2[1]).not.toBe(r1[1]) // static 项重扫重建（新 wrapper 对象）
    expect(r2[1]).toEqual(r1[1]) // 内容等价
    if (r2[1].kind !== 'systemNotice' || r1[1].kind !== 'systemNotice') throw new Error('expected systemNotice')
    expect(r2[1].message).toBe(r1[1].message) // message 引用不变
    expect(r2).toEqual(toRenderItems(src2, false))
  })
})

describe('toRenderItemsIncremental —— ④b 平移场景（W21 review Fix-5）', () => {
  it('prepend 历史（load-more）：输出与全量版 deepEqual，旧末位 turn 经重算路径 streaming 校正正确', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1s = makeMsg({ id: 'a1', role: 'assistant', content: 'r', status: 'streaming' })
    const r1 = toRenderItemsIncremental([u1, a1s], false, cache)
    expect(turnOf(r1[0]).isStreaming).toBe(true)

    // 头部 prepend：system notice + 一个完整 turn → 旧 turn 签名整体下移一位，
    // 同位置签名错位 → 全部重算（08 §3.3.1 失效条件 2：位置平移的 turn 重算）
    const sys = makeMsg({ id: 'sys0', role: 'system', content: 'notice' })
    const u0 = makeMsg({ id: 'u0', role: 'user', content: 'history q' })
    const a0 = makeMsg({ id: 'a0', role: 'assistant', content: 'history a' })
    const src2 = [sys, u0, a0, u1, a1s]
    const r2 = toRenderItemsIncremental(src2, false, cache)

    // 正确性兜底：平移场景输出与全量版 deepEqual（错位复用会导致 index/user 错乱，此处兜住）
    expect(r2).toEqual(toRenderItems(src2, false))
    expect(r2.map((i) => i.kind)).toEqual(['systemNotice', 'turn', 'turn'])
    // 旧末位 turn（现第 2 个 turn）仍为末位：重算后 isStreaming 正确保持 true（成员 a1s 仍 streaming）
    expect(turnOf(r2[2]).isStreaming).toBe(true)
    expect(turnOf(r2[2]).user?.id).toBe('u1')
    expect(turnOf(r2[2]).index).toBe(2)
  })

  it('中删一 turn（branch/fork 剪枝）：后续 turn 重算，index 连续不跳号，前缀 turn 引用复用', () => {
    const cache = createTurnRenderCache()
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
    ]
    const r1 = toRenderItemsIncremental(msgs, false, cache)
    expect(r1.map((i) => i.kind)).toEqual(['turn', 'turn', 'turn'])

    // 删中间 turn2（[u2,a2] 整组移除）：位置 1 旧签名 [u2,a2] vs 新 [u3,a3] 错位 → 重算
    const src2 = msgs.filter((m) => m.id !== 'u2' && m.id !== 'a2')
    const r2 = toRenderItemsIncremental(src2, false, cache)

    // 前缀 turn 引用复用（位置 0 签名对齐）
    expect(turnOf(r2[0])).toBe(turnOf(r1[0]))
    // 后续 turn 重算：index 连续（1,2 —— 非 1,3 跳号残留）
    expect(r2.map((i) => i.kind)).toEqual(['turn', 'turn'])
    expect(turnOf(r2[1]).index).toBe(2)
    expect(turnOf(r2[1]).user?.id).toBe('u3')
    expect(turnOf(r2[1])).not.toBe(turnOf(r1[2])) // 旧 turn3 对象不复用（签名错位重算）
    expect(r2).toEqual(toRenderItems(src2, false))
  })
})

describe('toRenderItemsIncremental —— ⑤ 缓存分区隔离（useSessionScopedState 组合语义）', () => {
  /** 模拟 MessageStream 的消费形态：工厂分区持有 shallowRef 包裹的 TurnRenderCache */
  function setup() {
    const scope = effectScope()
    const store: Record<string, Message[]> = {
      a: [
        makeMsg({ id: 'ua1', role: 'user', content: 'A 的提问' }),
        makeMsg({ id: 'aa1', role: 'assistant', content: 'A 的回复' }),
      ],
      b: [
        makeMsg({ id: 'ub1', role: 'user', content: 'B 的提问' }),
        makeMsg({ id: 'ab1', role: 'assistant', content: 'B 的回复' }),
      ],
    }
    let deriveFor!: (sid: string, forceWorking?: boolean) => RenderItem[]
    let state: ReturnType<typeof useSessionScopedState<ReturnType<typeof makeCacheRef>>>
    function makeCacheRef() {
      return shallowRef<TurnRenderCache>(createTurnRenderCache())
    }
    scope.run(() => {
      const sidRef = ref<string | null>('a')
      state = useSessionScopedState(sidRef, makeCacheRef)
      deriveFor = (sid: string, forceWorking = false) => {
        sidRef.value = sid
        const cacheRef = state.current.value
        return toRenderItemsIncremental(store[sid], forceWorking, cacheRef.value)
      }
    })
    return { deriveFor, state: () => state, store }
  }

  it('sid A/B 互不污染：切 B 再切回 A，A 的 cachedItems 引用恒等（快路径命中、分区保留）', () => {
    const { deriveFor } = setup()
    const ra1 = deriveFor('a')
    const rb = deriveFor('b')
    // B 的派生内容正确（不串台）
    expect(turnOf(rb[0]).user?.id).toBe('ub1')
    expect(turnOf(rb[0]).user?.content).toBe('B 的提问')
    // 切回 A：分区保留 → 源数组引用未变 → 快路径命中（被 B 污染则会重扫或内容错乱）
    const ra2 = deriveFor('a')
    expect(ra2).toBe(ra1)
    expect(turnOf(ra2[0]).user?.id).toBe('ua1')
    // B 侧同理
    const rb2 = deriveFor('b')
    expect(rb2).toBe(rb)
  })

  it('cleanup(sid) 后分区重建：该 sid 重新全量派生（对象新），另一 sid 分区不受影响', () => {
    const { deriveFor, state } = setup()
    const ra1 = deriveFor('a')
    const rb1 = deriveFor('b')
    state().cleanup('a') // 模拟 triggerSessionCleanups('a') 走到的分区删除
    const ra2 = deriveFor('a')
    expect(ra2).not.toBe(ra1) // 分区重建 → 全量重扫（引用新）
    expect(ra2).toEqual(ra1) // 内容不变（纯派生缓存可无损重建）
    const rb2 = deriveFor('b')
    expect(rb2).toBe(rb1) // B 分区未受 cleanup('a') 影响
  })
})

// ── 分组规则 v2（W3，conversation-turn-attribution §3.3 D3/D4）──────────────────

describe('groupRenderInput 分组规则 v2 —— 规则 1/3/5（现状语义锚定）', () => {
  it('R1 user 锚开新 turn；R3 assistant 归当前（无则自启 user:null turn）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'a0', role: 'assistant', content: '首条无 user' }),
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['turn', 'turn', 'turn'])
    expect(turnOf(items[0]).user).toBeNull() // 首条 assistant 自启（边缘保留）
    expect(turnOf(items[0]).trigger).toBeUndefined() // 自启 turn 无 trigger 标记
    expect(turnOf(items[1]).user?.id).toBe('u1')
    expect(turnOf(items[1]).assistants.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(turnOf(items[2]).user?.id).toBe('u2')
    expect(turnOf(items[2]).assistants).toEqual([])
  })

  it('R5 可见 system 边界语义不变：独立 systemNotice 项 + 关闭当前 turn（后续 assistant 自启无 trigger）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'c1', role: 'system', content: '压缩记录', compactionSummary: { summary: '压缩' } }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      makeMsg({ id: 'v1', role: 'system', customType: 'goal-progress', content: '可见 custom' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'turn', 'systemNotice'])
    expect(turnOf(items[0]).assistants.map((m) => m.id)).toEqual(['a1'])
    expect(turnOf(items[2]).user).toBeNull()
    expect(turnOf(items[2]).trigger).toBeUndefined() // assistant 自启，非触发 turn
  })
})

describe('groupRenderInput 分组规则 v2 —— R2 隐藏完成通知 = turn 边界（机制 A 修复，D3）', () => {
  it('R2 边界：关闭当前 turn、开启 trigger turn，后续 assistant 归入（不再并入上一提问）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      notifyMsg('n1'),
      makeMsg({ id: 'a2', role: 'assistant', content: '续跑结果' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['turn', 'turn'])
    expect(turnOf(items[0]).user?.id).toBe('u1')
    expect(turnOf(items[0]).assistants.map((m) => m.id)).toEqual(['a1'])
    const t2 = turnOf(items[1])
    expect(t2.user).toBeNull()
    expect(t2.trigger).toBe('bg-notify')
    expect(t2.assistants.map((m) => m.id)).toEqual(['a2'])
  })

  it('R2 常量源：workflow-result 同属 COMPLETE_NOTIFY_CUSTOM_TYPES（shared SSOT，无第二份判定）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
      notifyMsg('n1', 'workflow-result'),
      makeMsg({ id: 'a2', role: 'assistant', content: '续跑' }),
    ])
    expect(turnOf(items[1]).trigger).toBe('bg-notify')
    expect(turnOf(items[1]).assistants.map((m) => m.id)).toEqual(['a2'])
  })

  it('R2 空 turn 折叠：连续边界折叠为一个 trigger turn（后续 assistant 归入该组）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      notifyMsg('n1'),
      notifyMsg('n2'),
      notifyMsg('n3'),
      makeMsg({ id: 'a2', role: 'assistant', content: '续跑结果' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['turn', 'turn']) // 三个边界折叠为一
    expect(turnOf(items[1]).trigger).toBe('bg-notify')
    expect(turnOf(items[1]).assistants.map((m) => m.id)).toEqual(['a2'])
  })

  it('R2 空 turn 折叠：边界后紧跟 user 不产出空 trigger turn', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      notifyMsg('n1'),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['turn', 'turn'])
    expect(turnOf(items[1]).user?.id).toBe('u2')
    expect(turnOf(items[1]).trigger).toBeUndefined() // 空 trigger turn 已折叠，u2 开正常 turn
  })

  it('R2 空 turn 折叠：边界后数组结束 / 可见 system 边界均不产出空 trigger turn', () => {
    // 数组结束
    const endCase = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      notifyMsg('n1'),
    ])
    expect(endCase.map((i) => i.kind)).toEqual(['turn'])
    // 可见 system 边界（压缩记录）关闭未填实 trigger turn
    const sysCase = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      notifyMsg('n1'),
      makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
    ])
    expect(sysCase.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'turn'])
    expect(turnOf(sysCase[2]).trigger).toBeUndefined() // a2 自启 turn（空 trigger turn 已折叠）
  })

  it('R2 隐藏通知自身不渲染：全程无静态项产出（被消化为 trigger turn 语义，D3 输出侧过滤）', () => {
    const items = toRenderItems([notifyMsg('n1'), makeMsg({ id: 'a1', role: 'assistant', content: 'r' })])
    expect(items.map((i) => i.kind)).toEqual(['turn']) // 通知无独立渲染项
    expect(turnOf(items[0]).trigger).toBe('bg-notify')
    expect(turnOf(items[0]).user).toBeNull()
    expect(turnOf(items[0]).notices).toBeUndefined() // 通知不是 notice，是边界触发器
  })

  it('隐藏非完成通知消息透明：不切断 turn、不产出渲染项（todo-context 现状语义保留）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: 'ctx' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['turn'])
    expect(turnOf(items[0]).assistants.map((m) => m.id)).toEqual(['a1', 'a2']) // 不切断
  })

  it('trigger turn 仅含 notice 时 turnStableId 回落 notices[0]（稳定 key 兜底）', () => {
    // n1 开 trigger turn → bash notice 挂入（turn 被填实）→ n2 边界关闭它并开新空 trigger turn（末尾折叠）
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
      notifyMsg('n1'),
      bashMsg('bash-1'),
      notifyMsg('n2'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['turn', 'turn'])
    const t2 = turnOf(items[1])
    expect(t2.trigger).toBe('bg-notify')
    expect(t2.assistants).toEqual([])
    expect(t2.notices?.map((m) => m.id)).toEqual(['bash-1'])
    expect(turnStableId(t2)).toBe('bash-1')
  })
})

describe('groupRenderInput 分组规则 v2 —— R4 inline notice 归 turn 内（机制 C 修复，D4）', () => {
  it('R4 bash 执行记录归当前 turn 内部：不切断 turn、无独立渲染项（notices 按到达序追加末尾）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      bashMsg('bash-1'),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      bashMsg('bash-2'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['turn']) // 旧 role 扫描会切成 turn+bash+孤立 turn
    const t = turnOf(items[0])
    expect(t.assistants.map((m) => m.id)).toEqual(['a1', 'a2']) // turn 不被切断
    expect(t.notices?.map((m) => m.id)).toEqual(['bash-1', 'bash-2']) // notice 不出 static 项
  })

  it('R4 liveOnly 健康警告（stream_warn 形态）归当前 turn 内部（liveOnly 由 W2 打标，此处只读）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1', status: 'streaming' }),
      liveWarnMsg('w1'),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['turn'])
    expect(turnOf(items[0]).assistants.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(turnOf(items[0]).notices?.map((m) => m.id)).toEqual(['w1'])
  })

  it('R4 退化：无当前 turn 时 inline notice 退化为独立 static 项（现状兜底保留）', () => {
    const items = toRenderItems([
      bashMsg('bash-0'), // 首条，无当前 turn
      liveWarnMsg('w0'), // 同上（systemNotice 兜底 kind）
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['bashExecution', 'systemNotice', 'turn'])
    expect(turnOf(items[2]).notices).toBeUndefined() // 有当前 turn 后不再退化
  })

  it('R4 notice 挂入 trigger turn：边界后的 bash 归触发 turn 的 notices（不另起 static）', () => {
    const items = toRenderItems([
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
      notifyMsg('n1'),
      bashMsg('bash-1'),
      makeMsg({ id: 'a2', role: 'assistant', content: '续跑' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['turn', 'turn'])
    const t2 = turnOf(items[1])
    expect(t2.trigger).toBe('bg-notify')
    expect(t2.assistants.map((m) => m.id)).toEqual(['a2'])
    expect(t2.notices?.map((m) => m.id)).toEqual(['bash-1'])
  })
})

describe('groupRenderInput 分组规则 v2 —— 纯函数等价性（W6 等价性测试铺路）', () => {
  /** 全类型混合 fixture：覆盖 5 条规则 + 隐藏（通知/非通知）+ notice（bash/liveOnly）+ trigger */
  function richFixture(): Message[] {
    return [
      makeMsg({ id: 'a0', role: 'assistant', content: '首条自启' }),
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      bashMsg('bash-1'),
      makeMsg({ id: 'a1b', role: 'assistant', content: 'r1b' }),
      liveWarnMsg('w1'),
      notifyMsg('n1'),
      bashMsg('bash-2'),
      makeMsg({ id: 'a2', role: 'assistant', content: '续跑结果' }),
      notifyMsg('n2'),
      notifyMsg('n3'),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: 'ctx' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
      makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
      makeMsg({ id: 'a4', role: 'assistant', content: 'r4' }),
    ]
  }

  it('同一数组两次分组结果 deep-equal、输入数组不被 mutate（无模块级状态/副作用）', () => {
    const msgs = richFixture()
    const snapshot = JSON.parse(JSON.stringify(msgs))
    expect(toRenderItems(msgs)).toEqual(toRenderItems(msgs))
    expect(groupTurns(msgs)).toEqual(groupTurns(msgs))
    // 交叉组合也稳定：forceWorking 双态各自两次调用一致
    expect(toRenderItems(msgs, true)).toEqual(toRenderItems(msgs, true))
    expect(JSON.parse(JSON.stringify(msgs))).toEqual(snapshot) // 输入不可变（纯函数）
  })

  it('richFixture 全类型行为锚定（快照式断言：turn 结构 + trigger/notice 归属）', () => {
    const items = toRenderItems(richFixture())
    expect(items.map((i) => i.kind)).toEqual([
      'turn', // a0 自启
      'turn', // u1 锚：a1/bash-1/a1b/w1 inline
      'turn', // n1 触发：bash-2 notice + a2
      'turn', // u2 锚（n2/n3 空边界折叠）：h1 透明，a3 inline
      'systemNotice', // c1 可见 system 边界
      'turn', // a4 自启
    ])
    const t2 = turnOf(items[1])
    expect(t2.assistants.map((m) => m.id)).toEqual(['a1', 'a1b'])
    expect(t2.notices?.map((m) => m.id)).toEqual(['bash-1', 'w1'])
    const t3 = turnOf(items[2])
    expect(t3.trigger).toBe('bg-notify')
    expect(t3.assistants.map((m) => m.id)).toEqual(['a2'])
    expect(t3.notices?.map((m) => m.id)).toEqual(['bash-2'])
    const t4 = turnOf(items[3])
    expect(t4.trigger).toBeUndefined() // n2/n3 折叠，u2 开正常锚 turn
    expect(t4.assistants.map((m) => m.id)).toEqual(['a3'])
    expect(t4.notices).toBeUndefined()
    const t5 = turnOf(items[5])
    expect(t5.user).toBeNull()
    expect(t5.trigger).toBeUndefined()
  })

  it('增量版与全量版在新规则流式序列下逐步等价（notify 边界 → trigger turn → notice 追加）', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1', status: 'complete' })
    const steps: Message[][] = [
      [u1],
      [u1, a1],
      // 隐藏完成通知到达 → 空 trigger turn 挂起（无渲染项产出，与全量版一致）
      [u1, a1, notifyMsg('n1')],
      // 续跑 assistant 流入 trigger turn
      [
        u1,
        a1,
        notifyMsg('n1'),
        makeMsg({ id: 'a2', role: 'assistant', content: '部分', status: 'streaming' }),
      ],
      // bash notice 追加进 trigger turn（notice 改变签名 → 末位 turn 重建）
      [
        u1,
        a1,
        notifyMsg('n1'),
        makeMsg({ id: 'a2', role: 'assistant', content: '完整', status: 'complete' }),
        bashMsg('bash-1'),
      ],
    ]
    for (const step of steps) {
      expect(toRenderItemsIncremental(step, false, cache)).toEqual(
        toRenderItems(step, false),
      )
    }
  })

  it('追加 notice 到末位 turn：签名变化重建该 turn（notices 参与增量复用键），成员消息引用保留', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r' })
    const r1 = toRenderItemsIncremental([u1, a1], false, cache)
    expect(turnOf(r1[0]).notices).toBeUndefined()
    const r2 = toRenderItemsIncremental([u1, a1, bashMsg('bash-1')], false, cache)
    expect(turnOf(r2[0])).not.toBe(turnOf(r1[0])) // notice 追加 → 签名变化重建
    // 重扫路径 turn 对象新建，但成员消息引用保留（user/assistants 不换对象）
    expect(turnOf(r2[0]).user).toBe(u1)
    expect(turnOf(r2[0]).assistants[0]).toBe(a1)
    expect(turnOf(r2[0]).notices?.map((m) => m.id)).toEqual(['bash-1'])
  })
})

// ── 尾部快车道（D-4 三车道演进：形态①同长度仅末条替换 / ②尾部 append / ③全量兜底）──
// 正确性锚：任何车道产出与全量路径 deepEqual（既有等价断言形态，新车道同覆盖）。

describe('toRenderItemsIncremental —— ⑥ 尾部快车道形态①（同长度仅末条替换，streaming 合帧 commit）', () => {
  it('末条 assistant 不可变替换：历史 turn toBe 恒等、末位 turn 重建，输出与全量版 deepEqual', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const u2 = makeMsg({ id: 'u2', role: 'user', content: 'q2' })
    const a2v1 = makeMsg({ id: 'a2', role: 'assistant', content: '部分', status: 'streaming' })
    const r1 = toRenderItemsIncremental([u1, a1, u2, a2v1], false, cache)
    // delta-coalescer 合帧 commit：末条 token 推进 = 新对象替换（D-1 不可变语义）
    const a2v2 = makeMsg({ id: 'a2', role: 'assistant', content: '部分回复', status: 'streaming' })
    const src = [u1, a1, u2, a2v2]
    const r2 = toRenderItemsIncremental(src, false, cache)
    expect(turnOf(r2[0])).toBe(turnOf(r1[0])) // 历史 turn 引用恒等（子重跑起点之前的零重算）
    expect(turnOf(r2[1])).not.toBe(turnOf(r1[1])) // 末位 turn 重建（末位成员引用变化）
    expect(turnOf(r2[1]).user).toBe(u2) // 重建但成员引用保留
    expect(turnOf(r2[1]).assistants[0].content).toBe('部分回复')
    expect(turnOf(r2[1]).isStreaming).toBe(true)
    expect(r2).toEqual(toRenderItems(src, false)) // 正确性锚：deepEqual 全量路径
  })

  it('恒等特例：末条替换为透明消息（display:false 非通知 / 隐藏完成通知折叠）→ 引用恒等复用', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const h1 = makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: 'ctx' })
    const r1 = toRenderItemsIncremental([u1, a1, h1], false, cache)
    // 末条透明消息换成另一条透明消息（引用不同、产出不变）
    const h1b = makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: 'ctx' })
    const src = [u1, a1, h1b]
    const r2 = toRenderItemsIncremental(src, false, cache)
    expect(r2).toBe(r1) // 引用恒等（零重算承诺）
    expect(r2).toEqual(toRenderItems(src, false))
    // 隐藏完成通知同长度替换：空 trigger turn 数组末折叠，产出不变 → 恒等
    const cache2 = createTurnRenderCache()
    const n1 = notifyMsg('n1')
    const r3 = toRenderItemsIncremental([u1, a1, n1], false, cache2)
    const r4 = toRenderItemsIncremental([u1, a1, notifyMsg('n1')], false, cache2)
    expect(r4).toBe(r3)
    expect(r4).toEqual(toRenderItems([u1, a1, notifyMsg('n1')], false))
  })

  it('防御形态：末条从 assistant 换成可见 system（turn 项 → static 项结构变化）与全量版 deepEqual', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const a2 = makeMsg({ id: 'a2', role: 'assistant', content: 'r2' })
    const r1 = toRenderItemsIncremental([u1, a1, a2], false, cache)
    expect(r1.map((i) => i.kind)).toEqual(['turn'])
    const c1 = makeMsg({ id: 'c1', role: 'system', content: '压缩记录' })
    const src = [u1, a1, c1]
    const r2 = toRenderItemsIncremental(src, false, cache)
    expect(r2.map((i) => i.kind)).toEqual(['turn', 'systemNotice'])
    expect(turnOf(r2[0]).assistants.map((m) => m.id)).toEqual(['a1'])
    expect(r2).toEqual(toRenderItems(src, false))
  })
})

describe('toRenderItemsIncremental —— ⑥ 尾部快车道形态②（尾部 append）', () => {
  it('连续两次 append 归既有末位 turn：每步 deepEqual、user/assistants 成员引用保留', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
    const r1 = toRenderItemsIncremental([u1], false, cache)
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const s2 = [u1, a1]
    const r2 = toRenderItemsIncremental(s2, false, cache)
    const a2 = makeMsg({ id: 'a2', role: 'assistant', content: 'r2' })
    const s3 = [u1, a1, a2]
    const r3 = toRenderItemsIncremental(s3, false, cache)
    expect(turnOf(r2[0])).not.toBe(turnOf(r1[0])) // 签名 [u1] → [u1,a1] 重建
    expect(turnOf(r3[0])).not.toBe(turnOf(r2[0])) // 第二次 append 续建同 turn
    expect(turnOf(r3[0]).user).toBe(u1) // 成员引用保留
    expect(turnOf(r3[0]).assistants[0]).toBe(a1)
    expect(turnOf(r3[0]).assistants.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(r2).toEqual(toRenderItems(s2, false))
    expect(r3).toEqual(toRenderItems(s3, false))
  })

  it('append bash notice 进末位 turn（notices 参与签名）+ 连续 notice 到达：deepEqual、notices 序正确', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const r1 = toRenderItemsIncremental([u1, a1], false, cache)
    const b1 = bashMsg('bash-1')
    const s2 = [u1, a1, b1]
    const r2 = toRenderItemsIncremental(s2, false, cache)
    expect(r2.map((i) => i.kind)).toEqual(['turn']) // notice 不出独立项
    expect(turnOf(r2[0])).not.toBe(turnOf(r1[0]))
    expect(turnOf(r2[0]).user).toBe(u1)
    expect(turnOf(r2[0]).assistants[0]).toBe(a1)
    expect(turnOf(r2[0]).notices?.map((m) => m.id)).toEqual(['bash-1'])
    expect(r2).toEqual(toRenderItems(s2, false))
    const w1 = liveWarnMsg('w1')
    const s3 = [u1, a1, b1, w1]
    const r3 = toRenderItemsIncremental(s3, false, cache)
    expect(turnOf(r3[0]).notices?.map((m) => m.id)).toEqual(['bash-1', 'w1'])
    expect(r3).toEqual(toRenderItems(s3, false))
  })

  it('append 挂起空 trigger turn 被新消息填实：trigger turn 产出正确，前位 turn 引用复用', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const n1 = notifyMsg('n1')
    // 数组末空 trigger turn 折叠 → 产出仅前位 turn
    const r1 = toRenderItemsIncremental([u1, a1, n1], false, cache)
    expect(r1.map((i) => i.kind)).toEqual(['turn'])
    // append 续跑 assistant 填实 trigger turn（子重跑起点 = 前位 turn 起始下标 0）
    const a2 = makeMsg({ id: 'a2', role: 'assistant', content: '续跑', status: 'streaming' })
    const src = [u1, a1, n1, a2]
    const r2 = toRenderItemsIncremental(src, false, cache)
    expect(r2.map((i) => i.kind)).toEqual(['turn', 'turn'])
    expect(turnOf(r2[0])).toBe(turnOf(r1[0])) // 前位 turn 引用恒等
    expect(turnOf(r2[1]).trigger).toBe('bg-notify')
    expect(turnOf(r2[1]).assistants.map((m) => m.id)).toEqual(['a2'])
    expect(r2).toEqual(toRenderItems(src, false))
  })
})

describe('toRenderItemsIncremental —— ⑥ 全量兜底车道③（前插 / 引用全变等低频形态）', () => {
  it('前插（prefix 断裂）走全量车道：输出与全量版 deepEqual，同位置 turn 按现状签名对齐复用', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const r1 = toRenderItemsIncremental([u1, a1], false, cache)
    // 头部前插可见 system：prefix 第 0 位断裂 → 不满足尾部快车道前置 → 车道③
    const sys0 = makeMsg({ id: 'sys0', role: 'system', content: 'notice' })
    const src = [sys0, u1, a1]
    const r2 = toRenderItemsIncremental(src, false, cache)
    expect(r2.map((i) => i.kind)).toEqual(['systemNotice', 'turn'])
    // turn 组在新旧产出同为位置 0、签名 [u1,a1] 对齐 → 车道③现状语义复用对象
    expect(turnOf(r2[1])).toBe(turnOf(r1[0]))
    expect(turnOf(r2[1]).index).toBe(1)
    expect(turnOf(r2[1]).user).toBe(u1)
    expect(r2).toEqual(toRenderItems(src, false))
  })

  it('同长度引用全变（prefix 断裂）走全量车道：输出与全量版 deepEqual', () => {
    const cache = createTurnRenderCache()
    const r1 = toRenderItemsIncremental(
      [makeMsg({ id: 'u1', role: 'user', content: 'q' }), makeMsg({ id: 'a1', role: 'assistant', content: 'r' })],
      false,
      cache,
    )
    // 同 id 全新对象（fork/replay 形态）：长度相等但前缀引用断裂 → 车道③
    const src = [
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
    ]
    const r2 = toRenderItemsIncremental(src, false, cache)
    expect(r2).not.toBe(r1)
    expect(turnOf(r2[0])).not.toBe(turnOf(r1[0]))
    expect(r2).toEqual(toRenderItems(src, false))
    expect(r2).toEqual(r1) // 内容等价（引用相等 = 内容相等，同 id 同内容）
  })

  it('长会话高频形态串联（turn 前缀 + ① + ② + ③ 混合序列）：每步与全量版 deepEqual', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const u2 = makeMsg({ id: 'u2', role: 'user', content: 'q2' })
    const a2v1 = makeMsg({ id: 'a2', role: 'assistant', content: '部分', status: 'streaming' })
    const base = [u1, a1, u2, a2v1]
    const r1 = toRenderItemsIncremental(base, false, cache)
    expect(r1.map((i) => i.kind)).toEqual(['turn', 'turn'])
    const steps: Message[][] = [
      // ① 合帧 commit：末条 token 推进（×2 轮）
      [u1, a1, u2, makeMsg({ id: 'a2', role: 'assistant', content: '部分回复', status: 'streaming' })],
      [u1, a1, u2, makeMsg({ id: 'a2', role: 'assistant', content: '完整回复', status: 'complete' })],
      // ② append bash notice 进末位 turn
      [u1, a1, u2, makeMsg({ id: 'a2', role: 'assistant', content: '完整回复', status: 'complete' }), bashMsg('bash-1')],
      // ② append 新 user turn（末位地位转移：旧末位 isStreaming 校正）
      [
        u1,
        a1,
        u2,
        makeMsg({ id: 'a2', role: 'assistant', content: '完整回复', status: 'complete' }),
        bashMsg('bash-1'),
        makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
        makeMsg({ id: 'a3', role: 'assistant', content: 'r3', status: 'streaming' }),
      ],
      // ③ 中删末位 turn（prefix 前缀相等但长度缩短 → 车道③）
      [u1, a1, u2, makeMsg({ id: 'a2', role: 'assistant', content: '完整回复', status: 'complete' }), bashMsg('bash-1')],
    ]
    for (const step of steps) {
      const next = toRenderItemsIncremental(step, false, cache)
      expect(next).toEqual(toRenderItems(step, false)) // 每步正确性锚
    }
    // 串联末态：前位 turn（u1/a1）跨全程引用恒等（尾部车道零重算承诺）
    const last = toRenderItemsIncremental(steps[steps.length - 1], false, cache)
    expect(turnOf(last[0])).toBe(turnOf(r1[0]))
  })
})
