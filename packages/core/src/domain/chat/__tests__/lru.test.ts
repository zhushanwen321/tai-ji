/**
 * domain/chat lru 迁移单测（语义等价锁定，w2 原样迁移）。
 *
 * 锁定 W3 H3 LRU 驱逐语义：
 * - touchLru 维护访问时间戳；evictIfNeeded 按 recency 排序（非 FIFO）驱逐最久未访问
 * - streaming/pending/compacting 豁免（isExempt）
 * - subagent:sid:xxx 三段式虚拟 key 随主 session 联动驱逐；agentcall 两段式不联动
 * - LRU_MAX_SESSIONS=8 阈值触发
 * - makeLruEvictDeps 的 deleteMessageKey 走不可变写 + has 检查
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { ShallowRef } from 'vue'
import { shallowRef } from 'vue'
import {
  touchLru,
  isVirtualKey,
  isVirtualKeyOf,
  evictIfNeeded,
  evictSessionWithVirtual,
  disposeLruEntry,
  getLruMaxSessions,
  makeLruEvictDeps,
  setLruMaxSessions,
  _resetLruForTest,
  _lruSizeForTest,
  LRU_MAX_SESSIONS,
  type LruEvictDeps,
} from '../lru'

// sessionLastAccessed 是模块级 Map，每个 it 前必须重置，否则用例间互相污染
beforeEach(() => {
  _resetLruForTest()
})

describe('isVirtualKey / isVirtualKeyOf', () => {
  it('subagent: / agentcall: 前缀判为虚拟 key', () => {
    expect(isVirtualKey('subagent:s1:s2')).toBe(true)
    expect(isVirtualKey('agentcall:a1')).toBe(true)
    expect(isVirtualKey('normal-session')).toBe(false)
  })

  it('isVirtualKeyOf 仅匹配 subagent 三段式前缀，agentcall 两段式不匹配', () => {
    expect(isVirtualKeyOf('subagent:s1:child', 's1')).toBe(true)
    expect(isVirtualKeyOf('subagent:s2:child', 's1')).toBe(false)
    // agentcall 两段式无 mainSid 命名空间，不按前缀联动（由 workflow store 映射清理）
    expect(isVirtualKeyOf('agentcall:s1', 's1')).toBe(false)
  })
})

describe('evictIfNeeded', () => {
  /** 构造最小 deps：messages 由 Map 驱动，hydrated 为空 Set，isExempt 永远 false */
  function makeDeps(
    sids: string[],
    opts: { exempt?: Set<string> } = {},
  ): { deps: LruEvictDeps; messages: ShallowRef<Map<string, unknown>> } {
    const messages = shallowRef(new Map(sids.map((s) => [s, {}] as [string, unknown])))
    const hydrated = shallowRef(new Set<string>())
    const isExempt = (sid: string) => (opts.exempt?.has(sid) ?? false)
    const deps = makeLruEvictDeps(messages, hydrated, isExempt, () => {}, () => {})
    return { deps, messages }
  }

  it('不超阈值（≤LRU_MAX_SESSIONS）不驱逐', () => {
    const sids = Array.from({ length: LRU_MAX_SESSIONS }, (_, i) => `s${i}`)
    sids.forEach(touchLru)
    const { deps, messages } = makeDeps(sids)
    evictIfNeeded(deps)
    expect(messages.value.size).toBe(LRU_MAX_SESSIONS)
  })

  it('超阈值按 recency 排序驱逐最久未访问（非 FIFO）', () => {
    // s_old 访问最早，s_new 最晚；中间夹其他。驱逐应丢最旧的（s_old 先访问）
    const sids = ['s_old', 's_mid', 's_new']
    // 补足到 LRU_MAX_SESSIONS+2 触发驱逐 2 个
    const all = [...sids]
    for (let i = 0; i < LRU_MAX_SESSIONS - 1; i++) all.push(`fill${i}`)
    // 故意让 s_old 时间戳最小（最早访问），s_new 最大
    touchLru('s_old')
    // 用 Date.now 差值保证排序：中间间隔足够大
    const base = Date.now()
    // 因为 touchLru 用 Date.now()，连续调用时间戳可能相同；用 monotonic 保证：手动按顺序 touch
    // 这里用「访问顺序」模拟 recency：先 touch 的更旧
    all.filter((s) => s !== 's_old').forEach((s) => touchLru(s))
    touchLru('s_new') // 再 touch 一次让 s_new 最新
    const { deps, messages } = makeDeps(all)
    evictIfNeeded(deps)
    // 驱逐数 = all.length - LRU_MAX_SESSIONS = (LRU_MAX_SESSIONS+2) - LRU_MAX_SESSIONS = 2
    // 最旧的两个应被驱逐：s_old（最早）+ 某个 fill（次旧）
    expect(messages.value.has('s_old')).toBe(false)
    // s_new 最新，绝不被驱逐
    expect(messages.value.has('s_new')).toBe(true)
    expect(messages.value.size).toBe(LRU_MAX_SESSIONS)
  })

  it('streaming/pending 豁免的 session 不参与驱逐（候选超阈值才触发）', () => {
    // LRU_MAX_SESSIONS+2 个 session，其中 s0 豁免 → 候选 = (LRU_MAX+2)-1 = LRU_MAX+1，超阈值 1
    // 驱逐 1 个非豁免的最旧；豁免的 s0 始终保留（不进候选）
    const sids = Array.from({ length: LRU_MAX_SESSIONS + 2 }, (_, i) => `s${i}`)
    sids.forEach(touchLru)
    const { deps, messages } = makeDeps(sids, { exempt: new Set(['s0']) })
    evictIfNeeded(deps)
    // 豁免的不被驱逐
    expect(messages.value.has('s0')).toBe(true)
    // 总数 = 原 (LRU_MAX+2) - 驱逐 1 = LRU_MAX+1
    expect(messages.value.size).toBe(LRU_MAX_SESSIONS + 1)
  })

  it('豁免集足够大时候选不超阈值，零驱逐', () => {
    // LRU_MAX+1 个 session，1 个豁免 → 候选 = LRU_MAX，等于阈值，不驱逐
    const sids = Array.from({ length: LRU_MAX_SESSIONS + 1 }, (_, i) => `s${i}`)
    sids.forEach(touchLru)
    const { deps, messages } = makeDeps(sids, { exempt: new Set(['s0']) })
    evictIfNeeded(deps)
    expect(messages.value.size).toBe(LRU_MAX_SESSIONS + 1) // 全保留
  })

  it('subagent:sid:xxx 三段式虚拟 key 随主 session 联动驱逐', () => {
    // 主 session s1 + 其虚拟 key subagent:s1:c1，s1 被驱逐时虚拟 key 一起清
    const main = 's1'
    const virtual = 'subagent:s1:c1'
    // 凑够超阈值：8 个普通 + s1，使 s1 成为最旧被驱逐
    const sids = [main, virtual]
    for (let i = 0; i < LRU_MAX_SESSIONS; i++) sids.push(`fill${i}`)
    sids.forEach((s) => touchLru(s))
    // 让 s1 最旧（重新 touch 其他让其更新）
    sids.filter((s) => s !== main && s !== virtual).forEach((s) => touchLru(s))
    const { deps, messages } = makeDeps(sids)
    evictIfNeeded(deps)
    expect(messages.value.has(main)).toBe(false)
    expect(messages.value.has(virtual)).toBe(false) // 虚拟 key 联动驱逐
  })

  it('无访问记录（未 touchLru）的 session 不参与驱逐候选', () => {
    // s_no_record 在 messages 但没 touchLru → 不算候选，不会被驱逐，也不占阈值名额
    const sids = Array.from({ length: LRU_MAX_SESSIONS }, (_, i) => `s${i}`)
    sids.forEach(touchLru)
    sids.push('s_no_record') // 有 messages 无 access 记录
    const { deps, messages } = makeDeps(sids)
    evictIfNeeded(deps)
    // 未记录的不被驱逐（无法判断新旧）
    expect(messages.value.has('s_no_record')).toBe(true)
  })
})

describe('evictSessionWithVirtual', () => {
  it('显式驱逐指定 session + 其 subagent 虚拟 key（不论阈值）', () => {
    const messages = shallowRef(new Map([
      ['s1', {}],
      ['subagent:s1:c1', {}],
      ['other', {}],
    ]))
    const hydrated = shallowRef(new Set<string>())
    const deps = makeLruEvictDeps(messages, hydrated, () => false, () => {}, () => {})
    evictSessionWithVirtual('s1', deps)
    expect(messages.value.has('s1')).toBe(false)
    expect(messages.value.has('subagent:s1:c1')).toBe(false)
    expect(messages.value.has('other')).toBe(true)
  })

  it('streaming 豁免的 session 不驱逐（SR8 竞态防护）', () => {
    const messages = shallowRef(new Map([['s1', {}]]))
    const hydrated = shallowRef(new Set<string>())
    const deps = makeLruEvictDeps(messages, hydrated, () => true, () => {}, () => {}) // 永远豁免
    evictSessionWithVirtual('s1', deps)
    expect(messages.value.has('s1')).toBe(true) // 未被驱逐
  })
})

describe('B9 agentcall LRU 联动（agentCallEvictionsOf 注入回调）', () => {
  /** 构造带联动回调的最小 deps：agentcall 分区以 agentcall: 前缀 key 预置进 messages */
  function makeLinkageDeps(
    sids: string[],
    mapping: Map<string, string[]>,
  ): { deps: LruEvictDeps; messages: ShallowRef<Map<string, unknown>> } {
    const messages = shallowRef(new Map(sids.map((s) => [s, {}] as [string, unknown])))
    const hydrated = shallowRef(new Set<string>())
    const deps = makeLruEvictDeps(
      messages,
      hydrated,
      () => false,
      () => {},
      () => {},
      // 装配侧回调等价物：workflow 映射 ∖ viewedVids（豁免在回调内应用——豁免集里的 vid 不返回）
      (mainSid) => (mapping.get(mainSid) ?? []),
    )
    return { deps, messages }
  }

  it('联动驱逐（阈值路径）：主 session 被驱逐时回调返回的 agentcall 分区释放，回调未返回的存活（豁免）', () => {
    const main = 's1'
    const viewed = 'agentcall:acs-viewed' // 豁免：装配回调不返回 → 存活
    const unviewed = 'agentcall:acs-unviewed' // 未查看：回调返回 → 释放
    const sids = [main, viewed, unviewed]
    for (let i = 0; i < LRU_MAX_SESSIONS; i++) sids.push(`fill${i}`)
    sids.forEach((s) => touchLru(s))
    sids.filter((s) => s !== main).forEach((s) => touchLru(s)) // 让 s1 最旧
    const { deps, messages } = makeLinkageDeps(sids, new Map([[main, [unviewed]]]))
    evictIfNeeded(deps)
    expect(messages.value.has(main)).toBe(false)
    expect(messages.value.has(unviewed)).toBe(false) // 联动释放
    expect(messages.value.has(viewed)).toBe(true) // 豁免存活
  })

  it('两路径都触发：evictSessionWithVirtual 显式驱逐同样联动释放（不论阈值）', () => {
    const messages = shallowRef(new Map([
      ['s1', {}],
      ['agentcall:a1', {}],
      ['agentcall:a2', {}],
    ]))
    const hydrated = shallowRef(new Set<string>())
    const calls: string[] = []
    const deps = makeLruEvictDeps(
      messages,
      hydrated,
      () => false,
      () => {},
      () => {},
      (mainSid) => {
        calls.push(mainSid)
        return ['agentcall:a1']
      },
    )
    evictSessionWithVirtual('s1', deps)
    expect(calls).toEqual(['s1']) // 显式路径也触发回调
    expect(messages.value.has('s1')).toBe(false)
    expect(messages.value.has('agentcall:a1')).toBe(false) // 联动释放
    expect(messages.value.has('agentcall:a2')).toBe(true) // 未返回的存活
  })

  it('未注入回调（默认）：agentcall 分区不受 LRU 驱逐影响（向后兼容，旧行为）', () => {
    const main = 's1'
    const sids = [main, 'agentcall:acs-1']
    for (let i = 0; i < LRU_MAX_SESSIONS; i++) sids.push(`fill${i}`)
    sids.forEach((s) => touchLru(s))
    sids.filter((s) => s !== main).forEach((s) => touchLru(s))
    const messages = shallowRef(new Map(sids.map((s) => [s, {}] as [string, unknown])))
    const hydrated = shallowRef(new Set<string>())
    const deps = makeLruEvictDeps(messages, hydrated, () => false, () => {}, () => {})
    evictIfNeeded(deps)
    expect(messages.value.has(main)).toBe(false)
    expect(messages.value.has('agentcall:acs-1')).toBe(true) // 无回调不联动
  })

  it('联动驱逐同步清 agentcall vid 的时序记录（touchLru 写入的记录不残留）', () => {
    const messages = shallowRef(new Map<string, unknown>([
      ['s1', {}],
      ['agentcall:a1', {}],
    ]))
    const hydrated = shallowRef(new Set<string>())
    touchLru('agentcall:a1')
    const deps = makeLruEvictDeps(
      messages,
      hydrated,
      () => false,
      () => {},
      () => {},
      () => ['agentcall:a1'],
    )
    evictSessionWithVirtual('s1', deps)
    expect(_lruSizeForTest()).toBe(0)
  })
})

describe('disposeLruEntry', () => {
  it('清理指定 session 的访问记录（不影响 messages）', () => {
    touchLru('s1')
    disposeLruEntry('s1')
    // disposeLruEntry 只清 sessionLastAccessed，不动 messages（messages 由 store 管）
    // 验证方式：s1 清掉后，后续 evictIfNeeded 不再把它当候选
    const messages: ShallowRef<Map<string, unknown>> = shallowRef(new Map<string, unknown>([['s1', {}], ...Array.from({ length: LRU_MAX_SESSIONS }, (_, i) => [`f${i}`, {}] as [string, unknown])]))
    const hydrated = shallowRef(new Set<string>())
    // 其他 session 都 touch，s1 已 dispose 无记录
    for (let i = 0; i < LRU_MAX_SESSIONS; i++) touchLru(`f${i}`)
    const deps = makeLruEvictDeps(messages, hydrated, () => false, () => {}, () => {})
    evictIfNeeded(deps)
    // s1 无记录不被驱逐（dispose 已清）
    expect(messages.value.has('s1')).toBe(true)
  })
})

describe('makeLruEvictDeps.deleteMessageKey', () => {
  it('存在的 key 走不可变写：删除并替换为新 Map', () => {
    const original = new Map([['s1', {}], ['s2', {}]])
    const messages = shallowRef(original)
    const hydrated = shallowRef(new Set<string>())
    const deps = makeLruEvictDeps(messages, hydrated, () => false, () => {}, () => {})
    deps.deleteMessageKey('s1')
    expect(messages.value.has('s1')).toBe(false)
    expect(messages.value.has('s2')).toBe(true)
    expect(messages.value).not.toBe(original) // 引用已变（不可变写）
  })

  it('不存在的 key 跳过：.value 引用不变（has 检查避免无谓响应式）', () => {
    const original = new Map([['s1', {}]])
    const messages = shallowRef(original)
    const hydrated = shallowRef(new Set<string>())
    const deps = makeLruEvictDeps(messages, hydrated, () => false, () => {}, () => {})
    deps.deleteMessageKey('not-exist')
    expect(messages.value).toBe(original) // 引用未变（has 检查拦截）
  })

  it('deleteStreamingFlag 不受 has 守卫门控：keyless sid 同样清理（幂等，防 flag 残留慢泄漏）', () => {
    // 场景：messages 无该 sid 分区，但 isGenerating(sid) 曾被查询过 → flag 已惰性创建。
    // 若 flag 清理被 has 守卫门控，该 flag 永不清理（messages 分区不存在则 deleteMessages
    // 路径不可达）→ 慢泄漏。flag delete（Map.delete）幂等无代价，故移出守卫无条件执行。
    const original = new Map([['s1', {}]])
    const messages = shallowRef(original)
    const hydrated = shallowRef(new Set<string>())
    const flagDeleted: string[] = []
    const deps = makeLruEvictDeps(messages, hydrated, () => false, (sid) => flagDeleted.push(sid), () => {})
    // keyless sid：Map 不替换（无谓响应式仍被 has 检查拦截），flag 清理仍执行
    deps.deleteMessageKey('flag-only')
    expect(messages.value).toBe(original)
    expect(messages.value.has('flag-only')).toBe(false)
    expect(flagDeleted).toEqual(['flag-only'])
    // 有 key 的 sid：Map 删除 + flag 清理两者都执行
    deps.deleteMessageKey('s1')
    expect(messages.value.has('s1')).toBe(false)
    expect(messages.value).not.toBe(original)
    expect(flagDeleted).toEqual(['flag-only', 's1'])
  })

  it('deleteChangeSetStatuses 随 deleteMessageKey 同点清理：keyless sid 同样清（W19 review Fix-2，与 deleteStreamingFlag 同语义）', () => {
    // 场景：LRU 驱逐删 messages 分区时，changeSetStatuses 的 `${sid}:${messageId}` 前缀
    // 条目必须同步清（此前仅 disposeSession 清理 → 驱逐重进后 map 泄漏）。keyless sid
    // （messages 分区不存在）同样清——幂等前缀删除，防残留。
    const messages = shallowRef(new Map([['s1', {}]]))
    const hydrated = shallowRef(new Set<string>())
    const cleared: string[] = []
    const deps = makeLruEvictDeps(messages, hydrated, () => false, () => {}, (sid) => cleared.push(sid))
    deps.deleteMessageKey('keyless')
    expect(cleared).toEqual(['keyless'])
    deps.deleteMessageKey('s1')
    expect(cleared).toEqual(['keyless', 's1'])
  })

  it('evictIfNeeded 驱逐路径联动清 changeSetStatuses：主 key + subagent 虚拟 key 都清', () => {
    const main = 's1'
    const virtual = 'subagent:s1:c1'
    const sids = [main, virtual]
    for (let i = 0; i < LRU_MAX_SESSIONS; i++) sids.push(`fill${i}`)
    sids.forEach((s) => touchLru(s))
    sids.filter((s) => s !== main && s !== virtual).forEach((s) => touchLru(s)) // main 最旧
    const messages = shallowRef<Map<string, unknown>>(new Map(sids.map((s) => [s, {} as unknown])))
    const hydrated = shallowRef(new Set<string>())
    const cleared: string[] = []
    const deps = makeLruEvictDeps(messages, hydrated, () => false, () => {}, (sid) => cleared.push(sid))
    evictIfNeeded(deps)
    expect(messages.value.has(main)).toBe(false) // 前置：s1 确实被驱逐
    // 主 key 与虚拟 key 联动驱逐时，两者的 changeSetStatuses 前缀清理都被触发
    expect(cleared).toContain(main)
    expect(cleared).toContain(virtual)
  })

  it('deleteHydrated 同样走 has 检查 + 不可变写', () => {
    const messages = shallowRef(new Map())
    const hydrated = shallowRef(new Set(['h1', 'h2']))
    const originalHydrated = hydrated.value
    const deps = makeLruEvictDeps(messages, hydrated, () => false, () => {}, () => {})
    deps.deleteHydrated('h1')
    expect(hydrated.value.has('h1')).toBe(false)
    expect(hydrated.value.has('h2')).toBe(true)
    expect(hydrated.value).not.toBe(originalHydrated)
    // 不存在的跳过
    const before = hydrated.value
    deps.deleteHydrated('nope')
    expect(hydrated.value).toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 运行时可变上限（crash-forensics-and-watchdog §3.3 D4 memory-relief / 偏差 #28②，
// u7d 消费方 = renderer useMemoryPressure defaultReliefAction）
// ─────────────────────────────────────────────────────────────────────────────

describe('setLruMaxSessions 可变上限（#28② 压窗 API）', () => {
  /** 独立 makeDeps（局部最小构造，不依赖上方 describe 内 helper）。 */
  function makeDeps(sids: string[]): { deps: LruEvictDeps; messages: ShallowRef<Map<string, unknown>> } {
    const messages = shallowRef(new Map(sids.map((s) => [s, {}] as [string, unknown])))
    const hydrated = shallowRef(new Set<string>())
    const deps = makeLruEvictDeps(messages, hydrated, () => false, () => {}, () => {})
    return { deps, messages }
  }

  it('设窗后驱逐生效：默认 8 不驱逐的 8 个，压窗到 4 驱逐最旧 4 个', () => {
    const sids = Array.from({ length: 8 }, (_, i) => `s${i}`)
    sids.forEach(touchLru)
    const { deps, messages } = makeDeps(sids)
    evictIfNeeded(deps)
    expect(messages.value.size).toBe(8) // 前置：默认窗内零驱逐

    setLruMaxSessions(4)
    evictIfNeeded(deps)
    expect(messages.value.size).toBe(4) // 压窗生效：驱逐到 4
    // 驱逐的是最旧一半（s0-s3 先 touch）
    expect(messages.value.has('s0')).toBe(false)
    expect(messages.value.has('s3')).toBe(false)
    expect(messages.value.has('s7')).toBe(true)
  })

  it('null 恢复默认：压窗驱逐后回默认，后续 evictIfNeeded 按 8 判定（已驱逐的不回补）', () => {
    const sids = Array.from({ length: 8 }, (_, i) => `s${i}`)
    sids.forEach(touchLru)
    const { deps, messages } = makeDeps(sids)
    setLruMaxSessions(4)
    evictIfNeeded(deps)
    expect(messages.value.size).toBe(4)

    setLruMaxSessions(null)
    expect(getLruMaxSessions()).toBe(LRU_MAX_SESSIONS)
    evictIfNeeded(deps)
    expect(messages.value.size).toBe(4) // 恢复默认不回补已驱逐（只影响后续判定）
    // 后续新增至超默认窗才会再触发（语义：恢复默认 = 恢复常规容量，非撤销 relief 已生效动作）。
    // 注意被驱逐的 s0-s3 连 touchLru 记录一起清了（非候选），剩余 s4-s7；新增 5 个后候选
    // = 4+5 = 9 > 8 → 驱逐最旧 1 个。
    for (let i = 9; i < 14; i++) {
      messages.value = new Map(messages.value).set(`s${i}`, {})
      touchLru(`s${i}`)
    }
    evictIfNeeded(deps)
    expect(messages.value.size).toBe(LRU_MAX_SESSIONS) // 9 候选 → 驱逐 1 回到 8
    expect(messages.value.has('s4')).toBe(false) // 驱逐的是最旧候选
  })

  it('下限钳制 ≥1 且非整数向下取整；getLruMaxSessions 读当前生效值', () => {
    expect(getLruMaxSessions()).toBe(LRU_MAX_SESSIONS)
    setLruMaxSessions(0)
    expect(getLruMaxSessions()).toBe(1) // 0 = 全量驱逐会让切回重进变常态，钳到 1
    setLruMaxSessions(2.9)
    expect(getLruMaxSessions()).toBe(2)
    setLruMaxSessions(-5)
    expect(getLruMaxSessions()).toBe(1)
  })

  it('重复设置同值幂等（setter 幂等，无副作用累积）', () => {
    setLruMaxSessions(4)
    setLruMaxSessions(4)
    setLruMaxSessions(4)
    expect(getLruMaxSessions()).toBe(4)
  })
})
