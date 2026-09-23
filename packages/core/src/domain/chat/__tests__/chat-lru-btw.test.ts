/**
 * chat-lru-btw —— btw 分区 LRU 语义单测（btw-question D5「chat-lru 语义」四条 / M2-c 验收 ①②）。
 *
 * 设计点名断言（验收条款原文）：
 * - 「主会话驱逐后 btw 分区存活 + 回填一致」
 * - 「btw 驱逐同驱派生键」（B9 同构回调：线派生枚举 ∖ viewedVids）
 * - 主驱逐不动 btw 派生键（D5 不变量 / D9③「m7 前缀联动只匹配主会话名下键」）
 * - btw 键保持普通驱逐候选（不加 isVirtualKey 特例豁免）
 * - [AU1] 查看中的 btw 线不被阈值驱逐（真实 drawer 链：bindViewedVidPanels + open btw tab
 *   + setBtwView → getViewedVids → store 注入 → evictIfNeeded 入口 recency 刷新）+
 *   反面「切走（viewed 清空）后可驱逐」
 *
 * 层次 = core store 级（createChatStore + effectScope，store.test.ts 范式）：hydrate /
 * 驱逐 / 回填全链真实跑；B9 回调经 ChatStoreOptions 注入（renderer 装配侧
 * agentcall-lru-linkage 的等价物——以被驱逐 sid 原形态查询 workflow 映射 ∖ viewedVids，
 * 映射返回值即「已豁免结果」，viewed 项不返回）。
 *
 * recency 确定性：touchLru 用 Date.now，同毫秒时间戳会让阈值驱逐顺序退化为 Map 插入序
 * ——beforeEach 里 spyOn(Date,'now') 单调递增，严格按 touch 顺序定序。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/chat-lru-btw.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import type { Message } from '@taiji/shared'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import { isVirtualKey, isVirtualKeyOf, _resetLruForTest, _lruSizeForTest } from '../lru'
// [AU1 D5] 查看态豁免真实链（同 core 包跨域测试引用；测试目录不受 AC10 收集）：
// 分区键绑定 + panel 枚举绑定 + 选中写入，与生产 getViewedVids 组合同源。
import { bindDrawerSessionId, bindViewedVidPanels, getViewedVids, drawerControl } from '../../drawer/control'
import { openDrawerTab, setDrawerTab, _resetDrawerForTest } from '../../drawer/coordination'

/** 构造最小 Message（内容参与 deep 断言，默认值不参与任何其他用例语义）。 */
function msgOf(id: string, content: string): Message {
  return { id, role: 'user', content, status: 'complete', timestamp: 1 }
}

interface Harness {
  store: ChatStoreInstance
  dispose: () => void
  /** agentCallEvictionsOf 回调收到的 sid（原形态：mainSid 或 btw 线 vid）调用记录 */
  callbackCalls: string[]
}

/**
 * 构造注入 B9 等价回调的 store（renderer 装配 = workflow 映射 ∖ viewedVids 的等价物：
 * mapping 返回值即已豁免结果，豁免项/key 缺失不返回）。
 */
function makeHarness(mapping: Record<string, string[]> = {}): Harness {
  const callbackCalls: string[] = []
  const scope = effectScope(true)
  const store = scope.run(() =>
    createChatStore({
      agentCallEvictionsOf: (sid) => {
        callbackCalls.push(sid)
        return mapping[sid] ?? []
      },
    }),
  )!
  return { store, dispose: () => scope.stop(), callbackCalls }
}

let nowCounter = 0

beforeEach(() => {
  _resetLruForTest()
  nowCounter = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => nowCounter++)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('btw 键形态语义：普通驱逐候选（D5，无 isVirtualKey 特例豁免）', () => {
  it('isVirtualKey 不含 btw 前缀豁免；isVirtualKeyOf 不把 btw 键算进任何主会话名下', () => {
    expect(isVirtualKey('btw:pi-1')).toBe(false)
    expect(isVirtualKey('btw:pi-1')).toBe(false)
    expect(isVirtualKeyOf('btw:pi-1', 's-main')).toBe(false)
    // 既有两族不受影响
    expect(isVirtualKey('subagent:s1:c1')).toBe(true)
    expect(isVirtualKey('agentcall:acs-1')).toBe(true)
  })

  it('超阈值时 btw 分区照常按 recency 被驱逐（不豁免、不驻留）', () => {
    const h = makeHarness()
    try {
      const sids = ['btw:pi-old', ...Array.from({ length: 8 }, (_, i) => `s${i}`)]
      for (const sid of sids) {
        h.store.setMessages(sid, [msgOf(sid, `content-${sid}`)])
        h.store.touchLru(sid) // touch 序 = recency 序（Date.now spy 单调）→ btw 最旧
      }
      h.store.evictIfNeeded()
      // 9 候选 > LRU_MAX(8) → 驱逐最旧的 btw 分区（普通候选，无豁免）
      expect(h.store.getMessages('btw:pi-old')).toEqual([])
      expect(h.store.getMessages('s7')).toEqual([msgOf('s7', 'content-s7')])
    } finally {
      h.dispose()
    }
  })
})

describe('主会话驱逐与 btw 分区的边界（D5「主驱逐不联动」+ D9③ 键中段位）', () => {
  it('主会话驱逐后 btw 分区存活 + 回填一致', () => {
    const h = makeHarness({
      's-main': ['agentcall:acs-main'],
      'btw:pi-1': ['agentcall:acs-btw'],
    })
    try {
      const mainHistory = [msgOf('m1', '主对话正文')]
      const btwHistory = [msgOf('b1', '旁路线回复')]
      h.store.hydrate('s-main', mainHistory)
      h.store.hydrate('btw:pi-1', btwHistory)
      h.store.setMessages('subagent:s-main:c1', [msgOf('sa-main', '主名下子任务')])
      h.store.setMessages('subagent:pi-1:c1', [msgOf('sa-btw', '线名下子任务')])
      h.store.setMessages('agentcall:acs-main', [msgOf('ac-main', '主名下运行')])
      h.store.setMessages('agentcall:acs-btw', [msgOf('ac-btw', '线名下运行')])

      h.store.evictSessionWithVirtual('s-main')

      // 主侧联动清（回归锚）：主分区 + 主名下两半边派生（subagent 前缀 + workflow 映射）
      expect(h.store.getMessages('s-main')).toEqual([])
      expect(h.store.getMessages('subagent:s-main:c1')).toEqual([])
      expect(h.store.getMessages('agentcall:acs-main')).toEqual([])

      // ① btw 分区存活（D5：删除挂 deleteSession，不挂内存回收）
      expect(h.store.getMessages('btw:pi-1')).toEqual(btwHistory)
      expect(h.store.isHydrated('btw:pi-1')).toBe(true)
      // ② 主驱逐不动 btw 派生键（D9③：m7 前缀联动只匹配主会话名下键）
      expect(h.store.getMessages('subagent:pi-1:c1')).toEqual([msgOf('sa-btw', '线名下子任务')])
      expect(h.store.getMessages('agentcall:acs-btw')).toEqual([msgOf('ac-btw', '线名下运行')])
      // ③ B9 回调只以 mainSid 查询（未按 btw vid 枚举、线名下映射不落 main）
      expect(h.callbackCalls).toEqual(['s-main'])

      // ④ 回填一致：btw 分区随后被逐（普通候选）→ 重载链再注入 → 内容与逐前一致
      h.store.evictSessionWithVirtual('btw:pi-1')
      expect(h.store.getMessages('btw:pi-1')).toEqual([])
      expect(h.store.isHydrated('btw:pi-1')).toBe(false) // 回填闸门重开（重开线可再回放）
      h.store.hydrate('btw:pi-1', btwHistory)
      expect(h.store.getMessages('btw:pi-1')).toEqual(btwHistory)
    } finally {
      h.dispose()
    }
  })

  it('主驱逐不动 btw 派生键（阈值路径）', () => {
    const h = makeHarness({ 's-main': ['agentcall:acs-main'] })
    try {
      // btw 分区与线派生键在场（不 touch：非候选，只作为「不得被联动清」的在场面）
      h.store.setMessages('btw:pi-1', [msgOf('b1', '旁路线回复')])
      h.store.setMessages('subagent:pi-1:c1', [msgOf('sa-btw', '线名下子任务')])
      h.store.setMessages('agentcall:acs-btw', [msgOf('ac-btw', '线名下运行')])

      // 9 个普通候选（s-main 最旧）→ 阈值驱逐恰好 1 个
      const sids = ['s-main', ...Array.from({ length: 8 }, (_, i) => `f${i}`)]
      for (const sid of sids) {
        h.store.setMessages(sid, [msgOf(sid, `content-${sid}`)])
        h.store.touchLru(sid)
      }
      h.store.evictIfNeeded()

      expect(h.store.getMessages('s-main')).toEqual([])
      // btw 分区与其派生键全部不被主驱逐触碰
      expect(h.store.getMessages('btw:pi-1')).toEqual([msgOf('b1', '旁路线回复')])
      expect(h.store.getMessages('subagent:pi-1:c1')).toEqual([msgOf('sa-btw', '线名下子任务')])
      expect(h.store.getMessages('agentcall:acs-btw')).toEqual([msgOf('ac-btw', '线名下运行')])
      expect(h.callbackCalls).toEqual(['s-main'])
    } finally {
      h.dispose()
    }
  })
})

describe('btw 分区被驱逐时派生键同驱（D9③ 两半边：subagent 前缀 + agentcall B9 回调）', () => {
  it('btw 驱逐同驱派生键（阈值路径；B9 同构回调：线派生枚举 ∖ viewedVids）', () => {
    const h = makeHarness({
      // 装配侧等价物：workflow 映射按线 vid 挂名，返回值已 ∖ viewedVids（viewed 项不返回）
      'btw:pi-1': ['agentcall:acs-unviewed'],
    })
    try {
      h.store.hydrate('btw:pi-1', [msgOf('b1', '旁路线回复')]) // touch 序最前 + hydrated 标记
      h.store.setMessages('subagent:pi-1:c1', [msgOf('sa', '线名下子任务')])
      h.store.setMessages('agentcall:acs-unviewed', [msgOf('ac-un', '未查看运行')])
      h.store.setMessages('agentcall:acs-viewed', [msgOf('ac-v', '查看中运行')]) // 豁免项
      for (let i = 0; i < 8; i++) {
        h.store.setMessages(`f${i}`, [msgOf(`f${i}`, 'fill')])
        h.store.touchLru(`f${i}`) // recency 晚于 hydrate 的 touch
      }

      h.store.evictIfNeeded() // 9 候选 > 8 → 驱逐最旧的 btw:pi-1

      expect(h.store.getMessages('btw:pi-1')).toEqual([])
      expect(h.store.isHydrated('btw:pi-1')).toBe(false)
      // subagent 半边：owner 段 = 线 piSessionId（vid 去 btw: 前缀）前缀匹配同驱
      expect(h.store.getMessages('subagent:pi-1:c1')).toEqual([])
      // agentcall 半边：B9 同构回调以线 vid 形态查询，返回项同驱
      expect(h.store.getMessages('agentcall:acs-unviewed')).toEqual([])
      // ∖ viewedVids：装配回调未返回的豁免项存活（查看中的派生分区不白屏）
      expect(h.store.getMessages('agentcall:acs-viewed')).toEqual([msgOf('ac-v', '查看中运行')])
      expect(h.callbackCalls).toContain('btw:pi-1')
      // 阈值面收敛：剩余候选恰为 8 个 fill
      expect(h.store.getMessages('f0')).toEqual([msgOf('f0', 'fill')])
      expect(h.store.getMessages('f7')).toEqual([msgOf('f7', 'fill')])
    } finally {
      h.dispose()
    }
  })

  it('显式路径同构：evictSessionWithVirtual(btw vid) 同驱派生键 + 时序记录不残留', () => {
    const h = makeHarness({ 'btw:pi-2': ['agentcall:acs-x'] })
    try {
      h.store.setMessages('btw:pi-2', [msgOf('b2', '线回复')])
      h.store.setMessages('subagent:pi-2:c1', [msgOf('sa', '线名下子任务')])
      h.store.setMessages('agentcall:acs-x', [msgOf('ac', '线名下运行')])
      h.store.setMessages('agentcall:acs-other', [msgOf('ac-o', '别处运行')]) // 不在映射 → 存活
      h.store.touchLru('btw:pi-2')
      h.store.touchLru('subagent:pi-2:c1')
      h.store.touchLru('agentcall:acs-x')
      expect(_lruSizeForTest()).toBe(3)

      h.store.evictSessionWithVirtual('btw:pi-2')

      expect(h.store.getMessages('btw:pi-2')).toEqual([])
      expect(h.store.getMessages('subagent:pi-2:c1')).toEqual([])
      expect(h.store.getMessages('agentcall:acs-x')).toEqual([])
      expect(h.store.getMessages('agentcall:acs-other')).toEqual([msgOf('ac-o', '别处运行')])
      expect(h.callbackCalls).toEqual(['btw:pi-2'])
      // 同驱路径同步清时序记录（防 sessionLastAccessed 慢增长）
      expect(_lruSizeForTest()).toBe(0)
    } finally {
      h.dispose()
    }
  })
})

describe('AU1 D5 查看态保护：查看中的 btw 线不落阈值驱逐（evictIfNeeded 入口 recency 刷新）', () => {
  // 真实链：bind panel 枚举 + 分区键 → open btw tab + setBtwView → getViewedVids →
  // store 装配默认注入（store.ts makeLruEvictDeps）→ evictIfNeeded 入口刷新 viewed recency。
  // 与注入假源相比多验了 store.ts 生产装配点本身（端到端）。
  beforeEach(() => {
    _resetDrawerForTest()
  })

  afterEach(() => {
    _resetDrawerForTest()
    bindViewedVidPanels(ref([])) // 重绑空枚举（等价未绑定，后续用例 getViewedVids 空集）
    bindDrawerSessionId(ref(null)) // 解绑分区键（null sid no-op 语义）
  })

  /** 建立查看态（生产链：BtwPanel 选中线 → setBtwView；panel 枚举 = 装配侧 bind） */
  function startViewing(vid: string): void {
    const sid = ref<string | null>('A')
    bindDrawerSessionId(sid)
    openDrawerTab('btw') // 写 A 分区 isOpen + activeTab='btw'
    drawerControl.setBtwView(vid)
    bindViewedVidPanels(ref<Array<string | null>>(['A']))
  }

  /** 构造 9 候选（> LRU_MAX=8）：viewed 线 touch 序最前（recency 最旧），f0..f7 较新 */
  function seedNineCandidates(h: Harness): void {
    // hydrate 置 hydrated 标记（面板在场语义），显式 touchLru 钉 recency 序最前
    h.store.hydrate('btw:pi-view', [msgOf('v1', '查看中的旁路线')])
    h.store.touchLru('btw:pi-view') // 最旧（无查看保护时必被逐）
    for (let i = 0; i < 8; i++) {
      h.store.setMessages(`f${i}`, [msgOf(`f${i}`, 'fill')])
      h.store.touchLru(`f${i}`)
    }
  }

  it('查看中的 btw 线不被阈值驱逐（入口刷新 recency 恒排保留区，逐次旧的 f0）', () => {
    const h = makeHarness()
    try {
      seedNineCandidates(h)
      startViewing('btw:pi-view')
      expect(getViewedVids()).toEqual(new Set(['btw:pi-view'])) // 查看态三分量齐

      h.store.evictIfNeeded() // 9 候选 > 8 → 无保护时最旧的 btw 线必被逐

      // 查看保护生效：btw 分区与其 hydrated 标记存活（面板不空白）
      expect(h.store.getMessages('btw:pi-view')).toEqual([msgOf('v1', '查看中的旁路线')])
      expect(h.store.isHydrated('btw:pi-view')).toBe(true)
      // 被逐的换成刷新后次旧的 f0；保留区尾部 f7 存活
      expect(h.store.getMessages('f0')).toEqual([])
      expect(h.store.getMessages('f7')).toEqual([msgOf('f7', 'fill')])
    } finally {
      h.dispose()
    }
  })

  it('反面：切走（viewed 清空）后同一 btw 线可被阈值驱逐', () => {
    const h = makeHarness()
    try {
      seedNineCandidates(h)
      startViewing('btw:pi-view')
      setDrawerTab('terminal') // 切走 btw tab → 三分量破 → viewed 清空
      expect(getViewedVids()).toEqual(new Set())

      h.store.evictIfNeeded() // 无查看保护 → 最旧的 btw 线照常被逐

      expect(h.store.getMessages('btw:pi-view')).toEqual([])
      expect(h.store.isHydrated('btw:pi-view')).toBe(false) // 回填闸门重开（D5 可回填）
      expect(h.store.getMessages('f0')).toEqual([msgOf('f0', 'fill')])
      expect(h.store.getMessages('f7')).toEqual([msgOf('f7', 'fill')])
    } finally {
      h.dispose()
    }
  })
})
