// control.test.ts —— core C08 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/drawer/control.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/chat/__tests__/chat-lru-btw.test.ts（8 用例，skip 0）
//   - src/domain/drawer/__tests__/control.test.ts（18 用例，skip 0）
//   - src/domain/drawer/__tests__/coordination.test.ts（13 用例，skip 0）
//   - src/domain/drawer/__tests__/selection-invariants.test.ts（4 用例，skip 0）
//   - src/domain/drawer/__tests__/selection-subagent.test.ts（7 用例，skip 0）
//   - src/domain/drawer/__tests__/types.test.ts（11 用例，skip 0）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, ref, type Ref, nextTick } from 'vue'
import { type Message, type WorkflowRunRecord } from '@taiji/shared'
import { createChatStore, type ChatStoreInstance } from '../../chat/store'
import { isVirtualKey, isVirtualKeyOf, _resetLruForTest, _lruSizeForTest } from '../../chat/lru'
// [AU1 D5] 查看态豁免真实链（同 core 包跨域测试引用；测试目录不受 AC10 收集）：
// 分区键绑定 + panel 枚举绑定 + 选中写入，与生产 getViewedVids 组合同源。
// [display-containers §6.6①] 选中态迁出后经 selection/（setBtwView）+ coordination（openSubagent 族）驱动。
import { bindDrawerSessionId, useDrawerControl, getBoundSessionId, getDrawerControlState, _resetDrawerControlForTest } from '../control'
import { bindViewedVidPanels, getViewedVids, setBtwView, selectedCommandName, detailFilePath, useBashTaskSelection, useSubagentSelection, isViewingBtwSession, useBtwViewKey, useViewedBtwSession, viewedBtwSessionFor, viewedSubagentVidFor } from '../selection'
import { openDrawerTab, setDrawerTab, _resetDrawerForTest, openSubagent, closeDrawer, bindWorkflowOverlayOpener, bindWorkflowRunLookup, closeDrawerIfTabsEmpty, clearSubagentSelection, lookupWorkflowRun, selectBackgroundTask, openWorkflow, toggleDrawer } from '../coordination'
import { readSubagentSelectionFor, setSubagentView, clearSubagentView, clearSubagentViewFor, useSubagentSelection as useSubagentSelectionDeep, _resetSubagentSelectionForTest } from '../selection/subagent'
import { type RightDrawerTab, type DrawerControlState } from '../types'
import { type BashTaskSelectionState, useBashTaskSelection as useBashTaskSelectionDeep, setBackgroundTaskView, _resetBashTaskSelectionForTest } from '../selection/bash-task'
import { type BtwSelectionState, useBtwSelection, setBtwView as setBtwViewDeep, _resetBtwSelectionForTest } from '../selection/btw'

// ======== 来源：chat-lru-btw.test.ts ========
describe("chat-lru-btw", () => {
  /** 构造最小 Message（内容参与 deep 断言，默认值不参与任何其他用例语义）。 */
  function msgOf(id: string, content: string): Message {
    return { id, role: 'user', content, status: 'complete', timestamp: 1 }
  }

  interface Harness { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    store: ChatStoreInstance
    dispose: () => void
    /** agentCallEvictionsOf 回调收到的 sid（原形态：mainSid 或 btw 线 session id）调用记录 */
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
    it('isVirtualKey 不含 btw 线分区键豁免；isVirtualKeyOf 不把 btw 线键算进任何主会话名下', () => {
      // W4a 键统一：btw 线分区键 = pi 真实会话 id（普通 key，无前缀形态）
      expect(isVirtualKey('pi-line-1')).toBe(false)
      expect(isVirtualKey('pi-line-1')).toBe(false)
      expect(isVirtualKeyOf('pi-line-1', 's-main')).toBe(false)
      // 既有两族不受影响
      expect(isVirtualKey('subagent:s1:c1')).toBe(true)
      expect(isVirtualKey('agentcall:acs-1')).toBe(true)
    })

    it('超阈值时 btw 分区照常按 recency 被驱逐（不豁免、不驻留）', () => {
      const h = makeHarness()
      try {
        const sids = ['pi-line-old', ...Array.from({ length: 8 }, (_, i) => `s${i}`)]
        for (const sid of sids) {
          h.store.setMessages(sid, [msgOf(sid, `content-${sid}`)])
          h.store.touchLru(sid) // touch 序 = recency 序（Date.now spy 单调）→ btw 最旧
        }
        h.store.evictIfNeeded()
        // 9 候选 > LRU_MAX(8) → 驱逐最旧的 btw 分区（普通候选，无豁免）
        expect(h.store.getMessages('pi-line-old')).toEqual([])
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
        'pi-line-1': ['agentcall:acs-btw'],
      })
      try {
        const mainHistory = [msgOf('m1', '主对话正文')]
        const btwHistory = [msgOf('b1', '旁路线回复')]
        h.store.hydrate('s-main', mainHistory)
        h.store.hydrate('pi-line-1', btwHistory)
        h.store.setMessages('subagent:s-main:c1', [msgOf('sa-main', '主名下子任务')])
        h.store.setMessages('subagent:pi-line-1:c1', [msgOf('sa-btw', '线名下子任务')])
        h.store.setMessages('agentcall:acs-main', [msgOf('ac-main', '主名下运行')])
        h.store.setMessages('agentcall:acs-btw', [msgOf('ac-btw', '线名下运行')])

        h.store.evictSessionWithVirtual('s-main')

        // 主侧联动清（回归锚）：主分区 + 主名下两半边派生（subagent 前缀 + workflow 映射）
        expect(h.store.getMessages('s-main')).toEqual([])
        expect(h.store.getMessages('subagent:s-main:c1')).toEqual([])
        expect(h.store.getMessages('agentcall:acs-main')).toEqual([])

        // ① btw 分区存活（D5：删除挂 deleteSession，不挂内存回收）
        expect(h.store.getMessages('pi-line-1')).toEqual(btwHistory)
        expect(h.store.isHydrated('pi-line-1')).toBe(true)
        // ② 主驱逐不动 btw 派生键（D9③：m7 前缀联动只匹配主会话名下键）
        expect(h.store.getMessages('subagent:pi-line-1:c1')).toEqual([msgOf('sa-btw', '线名下子任务')])
        expect(h.store.getMessages('agentcall:acs-btw')).toEqual([msgOf('ac-btw', '线名下运行')])
        // ③ B9 回调只以 mainSid 查询（未按线 id 枚举、线名下映射不落 main）
        expect(h.callbackCalls).toEqual(['s-main'])

        // ④ 回填一致：btw 分区随后被逐（普通候选）→ 重载链再注入 → 内容与逐前一致
        h.store.evictSessionWithVirtual('pi-line-1')
        expect(h.store.getMessages('pi-line-1')).toEqual([])
        expect(h.store.isHydrated('pi-line-1')).toBe(false) // 回填门禁重开（重开线可再回放）
        h.store.hydrate('pi-line-1', btwHistory)
        expect(h.store.getMessages('pi-line-1')).toEqual(btwHistory)
      } finally {
        h.dispose()
      }
    })

    it('主驱逐不动 btw 派生键（阈值路径）', () => {
      const h = makeHarness({ 's-main': ['agentcall:acs-main'] })
      try {
        // btw 分区与线派生键在场（不 touch：非候选，只作为「不得被联动清」的在场面）
        h.store.setMessages('pi-line-1', [msgOf('b1', '旁路线回复')])
        h.store.setMessages('subagent:pi-line-1:c1', [msgOf('sa-btw', '线名下子任务')])
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
        expect(h.store.getMessages('pi-line-1')).toEqual([msgOf('b1', '旁路线回复')])
        expect(h.store.getMessages('subagent:pi-line-1:c1')).toEqual([msgOf('sa-btw', '线名下子任务')])
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
        // 装配侧等价物：workflow 映射按线 session id 挂名，返回值已 ∖ viewedVids（viewed 项不返回）
        'pi-line-1': ['agentcall:acs-unviewed'],
      })
      try {
        h.store.hydrate('pi-line-1', [msgOf('b1', '旁路线回复')]) // touch 序最前 + hydrated 标记
        h.store.setMessages('subagent:pi-line-1:c1', [msgOf('sa', '线名下子任务')])
        h.store.setMessages('agentcall:acs-unviewed', [msgOf('ac-un', '未查看运行')])
        h.store.setMessages('agentcall:acs-viewed', [msgOf('ac-v', '查看中运行')]) // 豁免项
        for (let i = 0; i < 8; i++) {
          h.store.setMessages(`f${i}`, [msgOf(`f${i}`, 'fill')])
          h.store.touchLru(`f${i}`) // recency 晚于 hydrate 的 touch
        }

        h.store.evictIfNeeded() // 9 候选 > 8 → 驱逐最旧的 btw 线分区（pi-line-1）

        expect(h.store.getMessages('pi-line-1')).toEqual([])
        expect(h.store.isHydrated('pi-line-1')).toBe(false)
        // subagent 半边：owner 段 = 线 session id（W4a 后即 sid 本身）前缀匹配同驱
        expect(h.store.getMessages('subagent:pi-line-1:c1')).toEqual([])
        // agentcall 半边：B9 同构回调以线 session id 形态查询，返回项同驱
        expect(h.store.getMessages('agentcall:acs-unviewed')).toEqual([])
        // ∖ viewedVids：装配回调未返回的豁免项存活（查看中的派生分区不白屏）
        expect(h.store.getMessages('agentcall:acs-viewed')).toEqual([msgOf('ac-v', '查看中运行')])
        expect(h.callbackCalls).toContain('pi-line-1')
        // 阈值面收敛：剩余候选恰为 8 个 fill
        expect(h.store.getMessages('f0')).toEqual([msgOf('f0', 'fill')])
        expect(h.store.getMessages('f7')).toEqual([msgOf('f7', 'fill')])
      } finally {
        h.dispose()
      }
    })

    it('显式路径同构：evictSessionWithVirtual(线 session id) 同驱派生键 + 时序记录不残留', () => {
      const h = makeHarness({ 'pi-line-2': ['agentcall:acs-x'] })
      try {
        h.store.setMessages('pi-line-2', [msgOf('b2', '线回复')])
        h.store.setMessages('subagent:pi-line-2:c1', [msgOf('sa', '线名下子任务')])
        h.store.setMessages('agentcall:acs-x', [msgOf('ac', '线名下运行')])
        h.store.setMessages('agentcall:acs-other', [msgOf('ac-o', '别处运行')]) // 不在映射 → 存活
        h.store.touchLru('pi-line-2')
        h.store.touchLru('subagent:pi-line-2:c1')
        h.store.touchLru('agentcall:acs-x')
        expect(_lruSizeForTest()).toBe(3)

        h.store.evictSessionWithVirtual('pi-line-2')

        expect(h.store.getMessages('pi-line-2')).toEqual([])
        expect(h.store.getMessages('subagent:pi-line-2:c1')).toEqual([])
        expect(h.store.getMessages('agentcall:acs-x')).toEqual([])
        expect(h.store.getMessages('agentcall:acs-other')).toEqual([msgOf('ac-o', '别处运行')])
        expect(h.callbackCalls).toEqual(['pi-line-2'])
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
    function startViewing(sessionId: string): void {
      const sid = ref<string | null>('A')
      bindDrawerSessionId(sid)
      openDrawerTab('btw') // 写 A 分区 isOpen + activeTab='btw'
      setBtwView(sessionId)
      bindViewedVidPanels(ref<Array<string | null>>(['A']))
    }

    /** 构造 9 候选（> LRU_MAX=8）：viewed 线 touch 序最前（recency 最旧），f0..f7 较新 */
    function seedNineCandidates(h: Harness): void {
      // hydrate 置 hydrated 标记（面板在场语义），显式 touchLru 钉 recency 序最前
      h.store.hydrate('pi-line-view', [msgOf('v1', '查看中的旁路线')])
      h.store.touchLru('pi-line-view') // 最旧（无查看保护时必被逐）
      for (let i = 0; i < 8; i++) {
        h.store.setMessages(`f${i}`, [msgOf(`f${i}`, 'fill')])
        h.store.touchLru(`f${i}`)
      }
    }

    it('查看中的 btw 线不被阈值驱逐（入口刷新 recency 恒排保留区，逐次旧的 f0）', () => {
      const h = makeHarness()
      try {
        seedNineCandidates(h)
        startViewing('pi-line-view')
        expect(getViewedVids()).toEqual(new Set(['pi-line-view'])) // 查看态三分量齐

        h.store.evictIfNeeded() // 9 候选 > 8 → 无保护时最旧的 btw 线必被逐

        // 查看保护生效：btw 分区与其 hydrated 标记存活（面板不空白）
        expect(h.store.getMessages('pi-line-view')).toEqual([msgOf('v1', '查看中的旁路线')])
        expect(h.store.isHydrated('pi-line-view')).toBe(true)
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
        startViewing('pi-line-view')
        setDrawerTab('git') // 切走 btw tab → 三分量破 → viewed 清空
        expect(getViewedVids()).toEqual(new Set())

        h.store.evictIfNeeded() // 无查看保护 → 最旧的 btw 线照常被逐

        expect(h.store.getMessages('pi-line-view')).toEqual([])
        expect(h.store.isHydrated('pi-line-view')).toBe(false) // 回填门禁重开（D5 可回填）
        expect(h.store.getMessages('f0')).toEqual([msgOf('f0', 'fill')])
        expect(h.store.getMessages('f7')).toEqual([msgOf('f7', 'fill')])
      } finally {
        h.dispose()
      }
    })
  })
});

// ======== 来源：control.test.ts ========
describe("control", () => {
  /** 当前测试分区键（每用例新建，bindDrawerSessionId 覆盖绑定） */
  let sid: Ref<string | null>

  /** 切换当前 focused session（模拟 selectSession 改 active panel 的 session 绑定） */
  function focusSession(s: string | null): void {
    sid.value = s
  }

  beforeEach(() => {
    sid = ref<string | null>(null)
    bindDrawerSessionId(sid)
    _resetDrawerForTest()
  })

  describe('drawer control 分区隔离与切回恢复', () => {
    it('A 开 git，切 B 为默认态，切回 A 恢复控制态两字段（isOpen/activeTab）', () => {
      focusSession('A')
      const { isOpen, activeTab } = useDrawerControl()
      openDrawerTab('git')
      expect(isOpen.value).toBe(true)
      expect(activeTab.value).toBe('git')

      // 切到 B（B 独立操作，不影响 A 分区）
      focusSession('B')
      const drawerB = useDrawerControl()
      expect(drawerB.isOpen.value).toBe(false)
      expect(drawerB.activeTab.value).toBe('git')

      // 切回 A
      focusSession('A')
      const drawerA = useDrawerControl()
      expect(drawerA.isOpen.value).toBe(true)
      expect(drawerA.activeTab.value).toBe('git')
    })

    it('切 sid 后 isOpen 立即为 true（reactive 容器契约回归：plain object init 会失效）', () => {
      // 回归：init 工厂漏 reactive() 时，sid 稳定下 open 的 mutate 不触发 computed 重算，
      // isOpen 缓存旧值 false。修复后 reactive 容器使 mutate 正确传播。
      focusSession('A')
      const { isOpen, activeTab } = useDrawerControl()
      expect(isOpen.value).toBe(false) // 缓存建立（模拟组件已渲染）

      openDrawerTab('git') // 手动 toggle，sid 未变化

      expect(isOpen.value).toBe(true) // 修复前为 false（bug）
      expect(activeTab.value).toBe('git')
    })
  })

  describe('null sid no-op 语义', () => {
    it('绑定值为 null（绑定前等价态）时公开 API 不抛错、不写 Map 分区', () => {
      // sid 初始为 null（未绑定任何 session）。null sid 时 controlState.current 返回
      // 临时默认实例（不写 Map），update no-op——对 null 实例的 mutate 不持久。
      expect(getBoundSessionId()).toBe(null)
      expect(() => {
        openDrawerTab('git')
        openDrawerTab('doc', { commandName: '/commit' })
      }).not.toThrow()

      // 绑定真实 sid 后，其分区是默认态（isOpen=false/activeTab=git）——
      // 证明 null sid 期的 open 没有泄漏进任何真实分区
      focusSession('X')
      const drawer = useDrawerControl()
      expect(drawer.isOpen.value).toBe(false)
      expect(drawer.activeTab.value).toBe('git')
    })

    it('bindDrawerSessionId 幂等：重复绑定同一 ref 不报错，新 ref 覆盖', () => {
      const refA = ref<string | null>('A')
      bindDrawerSessionId(refA)
      expect(getBoundSessionId()).toBe('A')

      bindDrawerSessionId(refA) // 同 ref 重复绑定
      expect(getBoundSessionId()).toBe('A')

      const refB = ref<string | null>('B')
      bindDrawerSessionId(refB) // 新 ref 覆盖
      expect(getBoundSessionId()).toBe('B')

      refA.value = 'A2' // 旧 ref 不再生效（已解绑）
      expect(getBoundSessionId()).toBe('B')
    })
  })

  describe('B9 getViewedVids：agentcall LRU 联动豁免查询源（panel 枚举）', () => {
    // [B9] 豁免查询源固定为 panel 枚举：逐 panel → focusedSessionId → drawer 分区 → 当前选中
    // vid（isOpen + activeTab==='subagent' + selectedSubagentId 三分量同时满足）。禁止 drawer
    // 分区全枚举（曾开过 drawer 的 session 焦点切走后分区保留，全枚举会永久过度豁免）。
    /** panel 枚举源（每用例新建 + 重绑定，模拟 renderer 装配层注册） */
    let panels: Ref<Array<string | null>>

    beforeEach(() => {
      panels = ref<Array<string | null>>([])
      bindViewedVidPanels(panels)
    })

    it('panel 焦点 session 的 drawer 正在查看 subagent tab → 该 vid 计入豁免集', () => {
      focusSession('A')
      openSubagent({ virtualId: 'agentcall:acs-1' })
      panels.value = ['A']

      expect(getViewedVids()).toEqual(new Set(['agentcall:acs-1']))
    })

    it('关闭 drawer 后不豁免（A6：关闭 drawer 后再切走，分区应可释放）', () => {
      focusSession('A')
      openSubagent({ virtualId: 'agentcall:acs-1' })
      closeDrawer()
      panels.value = ['A']

      expect(getViewedVids()).toEqual(new Set())
    })

    it('drawer 开在其他 tab（非 subagent）→ 不算正在查看，不豁免', () => {
      focusSession('A')
      openSubagent({ virtualId: 'agentcall:acs-1' })
      setDrawerTab('git')
      panels.value = ['A']

      expect(getViewedVids()).toEqual(new Set())
    })

    it('多 panel 全查（split 模式）：各 panel 焦点分区的选中 vid 都计入；null panel 跳过', () => {
      focusSession('A')
      openSubagent({ virtualId: 'agentcall:acs-a' })
      focusSession('B')
      openSubagent({ virtualId: 'subagent:B:s1' })
      panels.value = ['A', null, 'B']

      expect(getViewedVids()).toEqual(new Set(['agentcall:acs-a', 'subagent:B:s1']))
    })

    it('禁止全枚举：panel 枚举外的分区（曾开过 drawer、焦点已切走）不计入豁免集', () => {
      // B 曾开过 drawer 选中 acs-b，焦点切走后 B 分区保留——但 panel 枚举只含 A，
      // B 的选中 vid 不得进入豁免集（否则永久过度豁免）
      focusSession('B')
      openSubagent({ virtualId: 'agentcall:acs-b' })
      focusSession('A')
      openSubagent({ virtualId: 'agentcall:acs-a' })
      panels.value = ['A']

      expect(getViewedVids()).toEqual(new Set(['agentcall:acs-a']))
    })

    it('panel 枚举为空列表（无 panel 或全 null）→ 空集（安全默认：驱逐无豁免）', () => {
      panels.value = [] // beforeEach 绑定后即空列表
      focusSession('A')
      openSubagent({ virtualId: 'agentcall:acs-1' })

      expect(getViewedVids()).toEqual(new Set())
    })
  })

  describe('D5 getViewedVids：btw 线查看豁免（btw-question，M3-a）', () => {
    // 组合链与 subagent 同构（三分量：isOpen + activeTab==='btw' + selectedBtwSessionId）；
    // 查询源同样固定为 panel 枚举，禁止 drawer 分区全枚举。
    let panels: Ref<Array<string | null>>

    beforeEach(() => {
      panels = ref<Array<string | null>>([])
      bindViewedVidPanels(panels)
    })

    it('drawer 开在 btw tab 且正在查看某线 → 该线 session id 计入豁免集（查看中不驱逐）', () => {
      focusSession('A')
      openDrawerTab('btw')
      setBtwView('pi-line-1')
      panels.value = ['A']

      expect(getViewedVids()).toEqual(new Set(['pi-line-1']))
    })

    it('关闭 drawer 后不豁免（同 A6 语义：关 drawer 即离开查看态）', () => {
      focusSession('A')
      openDrawerTab('btw')
      setBtwView('pi-line-1')
      closeDrawer()
      panels.value = ['A']

      expect(getViewedVids()).toEqual(new Set())
    })

    it('drawer 切到其他 tab → btw 线不豁免（选中残留不泄漏豁免）', () => {
      focusSession('A')
      openDrawerTab('btw')
      setBtwView('pi-line-1')
      setDrawerTab('git')
      panels.value = ['A']

      expect(getViewedVids()).toEqual(new Set())
    })

    it('btw tab 打开但未选中线 → 空集（线列表浏览态无查看对象）', () => {
      focusSession('A')
      openDrawerTab('btw')
      panels.value = ['A']

      expect(getViewedVids()).toEqual(new Set())
    })

    it('混合形态：A 看 btw 线、B 看 agentcall → 两族各自计入（互不挤占）', () => {
      focusSession('A')
      openDrawerTab('btw')
      setBtwView('pi-line-a')
      focusSession('B')
      openSubagent({ virtualId: 'agentcall:acs-b' })
      panels.value = ['A', 'B']

      expect(getViewedVids()).toEqual(new Set(['pi-line-a', 'agentcall:acs-b']))
    })

    it('禁止全枚举（D7 焦点绑定侧面）：panel 枚举外分区的 btw 选中不豁免', () => {
      // B 曾在 btw tab 选中线，焦点切走后 B 分区保留——panel 枚举只含 A，
      // B 的选中线不得进入豁免集（否则永久过度豁免，btw 分区永不驱逐）
      focusSession('B')
      openDrawerTab('btw')
      setBtwView('pi-line-b')
      focusSession('A')
      panels.value = ['A']

      expect(getViewedVids()).toEqual(new Set())
    })

    it('切回恢复（D7④）：离开 btw tab 再切回，选中未清、恢复豁免', () => {
      focusSession('A')
      openDrawerTab('btw')
      setBtwView('pi-line-1')
      panels.value = ['A']

      setDrawerTab('git')
      expect(getViewedVids()).toEqual(new Set())

      setDrawerTab('btw')
      expect(getViewedVids()).toEqual(new Set(['pi-line-1']))
    })

    it('清空选中（setBtwView(undefined)，关线/面板空态调用）→ 不再豁免', () => {
      focusSession('A')
      openDrawerTab('btw')
      setBtwView('pi-line-1')
      setBtwView(undefined)
      panels.value = ['A']

      expect(getViewedVids()).toEqual(new Set())
    })
  })
});

// ======== 来源：coordination.test.ts ========
describe("coordination", () => {
  /** 当前测试分区键（每用例新建绑定） */
  let sid: Ref<string | null>

  function focusSession(s: string | null): void {
    sid.value = s
  }

  beforeEach(() => {
    sid = ref<string | null>(null)
    bindDrawerSessionId(sid)
    _resetDrawerForTest()
    // overlay 桥接绑定解绑（workflow-visualization U6：openWorkflow 改向后 openWorkflow 的
    // 单测不依赖 renderer 装配——各用例自行绑定，用例间解绑防串扰）
    bindWorkflowOverlayOpener(null)
    bindWorkflowRunLookup(null)
  })

  describe('瞬时参数：设置 + 消费后清空', () => {
    it('openDrawerTab 的 opts 写入对应瞬时参数 ref', () => {
      focusSession('A')
      openDrawerTab('doc', { commandName: '/commit' })
      expect(selectedCommandName.value).toBe('/commit')

      openDrawerTab('detail', { filePath: 'src/foo.ts' })
      expect(detailFilePath.value).toBe('src/foo.ts')
    })

    it('opts 缺省字段不覆盖已有瞬时参数（undefined 不写入）', () => {
      focusSession('A')
      openDrawerTab('doc', { commandName: '/commit' })
      openDrawerTab('git') // 无 opts——不应把 commandName 清掉
      expect(selectedCommandName.value).toBe('/commit')
    })
  })

  // ── display-containers §6.6② 瞬时参数按会话分区：跨会话劫持消除（W0 还债）──
  // 改前全局单例：A 会话的链接点击会被 B 会话的旧参数污染（B 首开 doc/detail tab 显 A 的旧值）。
  describe('瞬时参数按会话分区（跨会话劫持消除，display-containers §6.6②）', () => {
    it('A 设置的 commandName 不劫持 B 的首次打开（B 分区独立为 null）', () => {
      focusSession('A')
      openDrawerTab('doc', { commandName: '/commit' })
      expect(selectedCommandName.value).toBe('/commit')

      // 切到 B 首开 doc tab：不得看到 A 的旧参数（改前全局单例 → 劫持）
      focusSession('B')
      expect(selectedCommandName.value).toBe(null)
      openDrawerTab('doc')
      expect(selectedCommandName.value).toBe(null)

      // B 自己的参数独立写入，不回灌 A 分区
      openDrawerTab('doc', { commandName: '/fix' })
      expect(selectedCommandName.value).toBe('/fix')
      focusSession('A')
      expect(selectedCommandName.value).toBe('/commit')
    })

    it('A 设置的 detailFilePath 不劫持 B 的首次打开；B 消费后清空不影响 A', () => {
      focusSession('A')
      openDrawerTab('detail', { filePath: 'src/a.ts' })

      focusSession('B')
      expect(detailFilePath.value).toBe(null) // B 首开不被 A 旧值劫持
      openDrawerTab('detail', { filePath: 'src/b.ts' })
      expect(detailFilePath.value).toBe('src/b.ts')

      // 消费后清空（useDetailPane 语义）：只清 B 分区
      detailFilePath.value = null
      expect(detailFilePath.value).toBe(null)
      focusSession('A')
      expect(detailFilePath.value).toBe('src/a.ts') // A 分区保留（切回恢复展示链归 W3）
    })
  })

  describe('公开 API 薄封装（close/toggle/setTab）', () => {
    it('close 关闭当前分区；toggle 从关到开可指定 tab、从开到关关闭；setTab 切 tab', () => {
      focusSession('A')
      const { isOpen, activeTab } = useDrawerControl()

      toggleDrawer('git') // 关 → 开（git tab）
      expect(isOpen.value).toBe(true)
      expect(activeTab.value).toBe('git')

      toggleDrawer() // 开 → 关
      expect(isOpen.value).toBe(false)

      setDrawerTab('doc') // 抽屉关闭时仅改 activeTab
      expect(activeTab.value).toBe('doc')
      expect(isOpen.value).toBe(false)

      closeDrawer()
      expect(isOpen.value).toBe(false)
    })
  })

  describe('二级 tab 关空收敛（closeDrawerIfTabsEmpty，规则单一落点）', () => {
    it('empty=true 关当前分区抽屉；empty=false 不动开合', () => {
      focusSession('A')
      const { isOpen } = useDrawerControl()

      openDrawerTab('detail')
      expect(isOpen.value).toBe(true)

      // 关闭动作后仍有剩余 → 不关抽屉
      closeDrawerIfTabsEmpty(false)
      expect(isOpen.value).toBe(true)

      // 关闭动作后无剩余 → 整个抽屉关闭（不回空态停留）
      closeDrawerIfTabsEmpty(true)
      expect(isOpen.value).toBe(false)

      // 抽屉已关时空参数 no-op（幂等，不自动打开）
      closeDrawerIfTabsEmpty(false)
      expect(isOpen.value).toBe(false)
    })
  })

  describe('_resetDrawerForTest 测试隔离', () => {
    it('_resetDrawerForTest 清瞬时参数（测试隔离钩子）', () => {
      focusSession('A')
      openDrawerTab('doc', { commandName: '/commit' })
      openDrawerTab('detail', { filePath: 'src/foo.ts' })
      expect(detailFilePath.value).not.toBe(null)

      _resetDrawerForTest()

      expect(selectedCommandName.value).toBe(null)
      expect(detailFilePath.value).toBe(null)
    })
  })

  describe('subagent / bashTask 编排入口（选中态落内容域分区 + 切 tab 开 drawer 落控制态）', () => {
    it('openSubagent = setSubagentView + 切 subagent tab + 开 drawer（[2026-10-19] enteredFrom 已随 workflow tab 删除）', () => {
      focusSession('A')
      const { isOpen, activeTab } = useDrawerControl()
      const { selectedSubagentId } = useSubagentSelection()

      openSubagent({ virtualId: 'subagent:A:s1' })
      expect(isOpen.value).toBe(true)
      expect(activeTab.value).toBe('subagent')
      expect(selectedSubagentId.value).toBe('subagent:A:s1')

      openSubagent({ virtualId: 'agentcall:acs-1' })
      expect(selectedSubagentId.value).toBe('agentcall:acs-1')
    })

    it('clearSubagentSelection 只清选中态、不动 drawer 开合与 activeTab', () => {
      focusSession('A')
      const { isOpen, activeTab } = useDrawerControl()
      const { selectedSubagentId } = useSubagentSelection()
      openSubagent({ virtualId: 'subagent:A:s1' })

      clearSubagentSelection()

      expect(selectedSubagentId.value).toBe(null)
      expect(isOpen.value).toBe(true) // 不开合 drawer
      expect(activeTab.value).toBe('subagent') // 不切 tab
    })

    it('selectBackgroundTask 写选中 id + 切 bashTask tab + 开 drawer；undefined=清选中', () => {
      focusSession('A')
      const { isOpen, activeTab } = useDrawerControl()
      const { selectedBackgroundTaskId } = useBashTaskSelection()

      selectBackgroundTask('task-1')
      expect(isOpen.value).toBe(true)
      expect(activeTab.value).toBe('bashTask')
      expect(selectedBackgroundTaskId.value).toBe('task-1')

      selectBackgroundTask(undefined)
      expect(selectedBackgroundTaskId.value).toBe(undefined)
      expect(activeTab.value).toBe('bashTask')
    })
  })

  describe('workflow 入口语义分立（workflow-visualization U6/D1）', () => {
    it('openWorkflow 改向 = 调绑定的 overlay opener（转发 nameOrRunId + slug + sessionId 三参）', () => {
      focusSession('A')
      const opener = vi.fn()
      bindWorkflowOverlayOpener(opener)

      // 托盘路径：runId 直传（TrayNativePanel 零改动形态）
      openWorkflow('wf-run-1')
      expect(opener).toHaveBeenCalledWith('wf-run-1', undefined, undefined)

      // block 路径：(scriptName, slug, sessionId) 三参透传
      openWorkflow('flow-a', { slug: 's-2', sessionId: 's9' })
      expect(opener).toHaveBeenCalledWith('flow-a', 's-2', 's9')

      // 无参：空串转发（opener 侧兜底）
      openWorkflow()
      expect(opener).toHaveBeenCalledWith('', undefined, undefined)
    })

    it('openWorkflow 未绑定 opener 时 no-op（headless/测试安全默认，不抛错）', () => {
      focusSession('A')
      expect(() => openWorkflow('wf-run-1')).not.toThrow()
      // drawer 未被误开（改向后 openWorkflow 不再触达 drawerControl）
      expect(useDrawerControl().isOpen.value).toBe(false)
    })

    it('lookupWorkflowRun 转发绑定 lookup；未绑定返回 undefined（安全默认）', () => {
      focusSession('A')
      expect(lookupWorkflowRun('s9', 'flow-a', 's-2')).toBeUndefined()

      const record: WorkflowRunRecord = {
        runId: 'wf-run-1',
        scriptName: 'flow-a',
        status: 'running',
        startedAt: '2026-10-02T00:00:00Z',
        agentCalls: [],
        stateFilePath: '',
      }
      const lookup = vi.fn(() => record)
      bindWorkflowRunLookup(lookup)
      expect(lookupWorkflowRun('s9', 'flow-a', 's-2')).toBe(record)
      expect(lookup).toHaveBeenCalledWith('s9', 'flow-a', 's-2')
    })
  })
});

// ======== 来源：selection-invariants.test.ts ========
describe("selection-invariants", () => {
  let sid: Ref<string | null>
  let panels: Ref<Array<string | null>>

  function focusSession(s: string | null): void {
    sid.value = s
  }

  /** 三消费方同值对账（btw 族）：豁免集 ↔ 回放触发源 ↔ 视口命中，一次断言三读数一致 */
  async function assertBtwReadingsAgree(sessionId: string, expected: string | null): Promise<void> {
    await nextTick() // 真实事件序：写入后过一个 flush，再读三消费方
    // ① chat LRU 豁免（getViewedVids）
    expect(getViewedVids().has(sessionId)).toBe(expected !== null)
    // ② btw-replay 触发源（useViewedBtwSession——renderer watch 的就是它）
    expect(useViewedBtwSession().value).toBe(expected)
    // ③ useBtwTabData 视口命中（isViewingBtwSession）+ 视口三元组 key（useBtwViewKey）
    expect(isViewingBtwSession(sessionId)).toBe(expected !== null)
    const key = useBtwViewKey().value
    if (expected === null) {
      expect(key === '' || !key.includes(sessionId)).toBe(true)
    } else {
      expect(key).toBe(`${getBoundSessionId() ?? ''}\u0000${sessionId}`)
    }
  }

  beforeEach(() => {
    sid = ref<string | null>(null)
    bindDrawerSessionId(sid)
    panels = ref<Array<string | null>>([])
    bindViewedVidPanels(panels)
    _resetDrawerForTest()
  })

  describe('三消费方复合谓词不变量（真实事件序对账，selection-invariants）', () => {
    it('开 btw → 选线 → 切 tab → 切回 → 关 drawer：每步三读数同值', async () => {
      const V = 'pi-line-1'
      focusSession('A')
      panels.value = ['A']

      // 初始：未开 → 三读数皆「不在查看」
      await assertBtwReadingsAgree(V, null)

      // 开 btw tab（未选线）→ 仍不在查看
      openDrawerTab('btw')
      await assertBtwReadingsAgree(V, null)

      // 选中线 → 三读数同翻（查看中）
      setBtwView(V)
      await assertBtwReadingsAgree(V, V)

      // 切到别的 tab → 三读数同落（选中残留不泄漏豁免——数据丢失防线）
      setDrawerTab('git')
      await assertBtwReadingsAgree(V, null)

      // 切回 btw tab → 三读数同恢复（切回恢复面板语义 D7④）
      setDrawerTab('btw')
      await assertBtwReadingsAgree(V, V)

      // 关 drawer → 三读数同落
      closeDrawer()
      await assertBtwReadingsAgree(V, null)
    })

    it('切 session（焦点换分区）→ 三读数随分区换显；A 的查看态在 A 分区不受影响', async () => {
      const V = 'pi-line-a'
      focusSession('A')
      panels.value = ['A', 'B']
      openDrawerTab('btw')
      setBtwView(V)
      await assertBtwReadingsAgree(V, V)

      // 切到 B（B 无查看态）：三消费方读当前分区 → 同落；per-sid 读（①豁免链的读取路径）不受影响
      focusSession('B')
      await nextTick()
      expect(useViewedBtwSession().value).toBe(null)
      expect(isViewingBtwSession(V)).toBe(false)
      expect(useBtwViewKey().value).toBe('')
      expect(viewedBtwSessionFor('A')).toBe(V) // A 分区查看态保留（getViewedVids 仍豁免 A）
      expect(getViewedVids()).toEqual(new Set([V]))

      // 切回 A：三读数同恢复
      focusSession('A')
      await assertBtwReadingsAgree(V, V)
    })

    it('subagent 分支：openSubagent 三分量齐 → 豁免集计入；关 drawer / 切 tab 即落（per-sid 谓词对账）', async () => {
      const V = 'agentcall:acs-1'
      focusSession('A')
      panels.value = ['A']

      openSubagent({ virtualId: V })
      await nextTick()
      expect(viewedSubagentVidFor('A')).toBe(V)
      expect(getViewedVids()).toEqual(new Set([V]))

      setDrawerTab('git')
      await nextTick()
      expect(viewedSubagentVidFor('A')).toBe(null)
      expect(getViewedVids()).toEqual(new Set())

      setDrawerTab('subagent')
      await nextTick()
      expect(viewedSubagentVidFor('A')).toBe(V)

      closeDrawer()
      await nextTick()
      expect(viewedSubagentVidFor('A')).toBe(null)
      expect(getViewedVids()).toEqual(new Set())
    })

    it('两族混合（A 看 btw、B 看 subagent）：复合谓词互不挤占，per-sid 读各自命中', async () => {
      const B = 'pi-line-a'
      const S = 'subagent:B:s1'
      focusSession('A')
      openDrawerTab('btw')
      setBtwView(B)
      focusSession('B')
      openSubagent({ virtualId: S })
      panels.value = ['A', 'B']
      await nextTick()

      expect(viewedBtwSessionFor('A')).toBe(B)
      expect(viewedSubagentVidFor('A')).toBe(null)
      expect(viewedBtwSessionFor('B')).toBe(null)
      expect(viewedSubagentVidFor('B')).toBe(S)
      expect(getViewedVids()).toEqual(new Set([B, S]))
    })
  })
});

// ======== 来源：selection-subagent.test.ts ========
describe("selection-subagent", () => {
  /** 当前测试分区键（每用例新建绑定） */
  let sid: Ref<string | null>

  function focusSession(s: string | null): void {
    sid.value = s
  }

  beforeEach(() => {
    sid = ref<string | null>(null)
    bindDrawerSessionId(sid)
    _resetSubagentSelectionForTest()
  })

  describe('useSubagentSelection 视图 + set/clear 写侧', () => {
    it('setSubagentView 写 selectedSubagentId；clearSubagentView 归 null', () => {
      focusSession('A')
      const { selectedSubagentId } = useSubagentSelectionDeep()

      expect(selectedSubagentId.value).toBe(null)

      setSubagentView('subagent:A:s1')
      expect(selectedSubagentId.value).toBe('subagent:A:s1')

      clearSubagentView()
      expect(selectedSubagentId.value).toBe(null)
    })

    it('响应式：set 后视图 computed 即时更新（reactive 容器契约，ADR-0049 W2）', () => {
      focusSession('A')
      const { selectedSubagentId } = useSubagentSelectionDeep()
      setSubagentView('agentcall:acs-1')
      expect(selectedSubagentId.value).toBe('agentcall:acs-1')
    })

    it('per-session 分区：A 的选中不污染 B；切回 A 恢复', () => {
      focusSession('A')
      setSubagentView('subagent:A:s1')

      focusSession('B')
      const viewB = useSubagentSelectionDeep()
      expect(viewB.selectedSubagentId.value).toBe(null)

      setSubagentView('subagent:B:s2')
      expect(viewB.selectedSubagentId.value).toBe('subagent:B:s2')

      focusSession('A')
      const viewA = useSubagentSelectionDeep()
      expect(viewA.selectedSubagentId.value).toBe('subagent:A:s1')
    })
  })

  describe('readSubagentSelectionFor（复合谓词跨域读，updateFor 语义）', () => {
    it('按 sid 读选中态快照', () => {
      focusSession('A')
      setSubagentView('subagent:A:s1')

      const read = readSubagentSelectionFor('A', (s) => s.selectedSubagentId)
      expect(read).toBe('subagent:A:s1')
    })

    it('从未触达的 sid 惰性建分区返回默认值 null；已删分区 no-op 返回 undefined', () => {
      // 惰性 init（useSessionScopedState 契约）：未触达 sid 读回默认 null
      expect(readSubagentSelectionFor('never-touched', (s) => s.selectedSubagentId)).toBe(null)

      focusSession('A')
      setSubagentView('subagent:A:s1')
      clearSubagentView()
      expect(readSubagentSelectionFor('A', (s) => s.selectedSubagentId)).toBe(null)
    })
  })

  describe('clearSubagentViewFor（定向清除，N-1——显式 sid 分区，不依赖 current 绑定）', () => {
    it('清指定 sid 分区且对当前绑定视图可见；其他分区不受影响', () => {
      focusSession('A')
      setSubagentView('subagent:A:s1')
      focusSession('B')
      setSubagentView('subagent:B:s2')

      clearSubagentViewFor('A')

      // 跨域读口径：A 清空、B 保留
      expect(readSubagentSelectionFor('A', (s) => s.selectedSubagentId)).toBe(null)
      expect(readSubagentSelectionFor('B', (s) => s.selectedSubagentId)).toBe('subagent:B:s2')
      // 视图口径：切回 A 后 useSubagentSelection 见到清空结果（定向清除真实生效，
      // 而非只写了无人消费的分区）
      focusSession('A')
      expect(useSubagentSelectionDeep().selectedSubagentId.value).toBe(null)
    })

    it('当前绑定不在被清 sid 时定向清除不动 current 分区（键不一致曾是 N-1 根源，反向锚定）', () => {
      focusSession('A')
      setSubagentView('subagent:A:s1')
      focusSession('B')
      setSubagentView('subagent:B:s2')

      // 清 B（= 当前绑定）之外的 A；current（B）分区保持
      clearSubagentViewFor('A')
      expect(useSubagentSelectionDeep().selectedSubagentId.value).toBe('subagent:B:s2')
    })
  })
});

// ======== 来源：types.test.ts ========
describe("types", () => {
  // ── 编译期断言（tsc 系执行；esbuild 剥离不报错，与运行期用例共存不冲突）──

  // 'bashTask' 可赋给 RightDrawerTab（成员缺失即 vue-tsc 红）
  const bashTaskTab: RightDrawerTab = 'bashTask'

  // 控制态最小形态（display-containers §6.6①/③ 后仅两字段）：若控制态被回填寄生字段，
  // 本对象字面量不受影响，但下方「五字段不在 DrawerControlState」负向锚会红
  const minimalControlState: DrawerControlState = {
    isOpen: false,
    activeTab: 'git',
  }

  // 选中态可选性锚：默认分区构造（reactive({})）不写字段即满足接口（若未来改必填，
  // createDefault* 构造点与本字面量同步被迫改——登记提示）
  const minimalBashTaskSelection: BashTaskSelectionState = {}

  const minimalBtwSelection: BtwSelectionState = {}

  describe('drawer types：bashTask tab 扩展（D5①）', () => {
    afterEach(() => {
      _resetDrawerControlForTest()
      _resetBashTaskSelectionForTest()
      _resetBtwSelectionForTest()
    })

    it("'bashTask' 是合法 RightDrawerTab 成员（编译期断言的运行期影子）", () => {
      expect(bashTaskTab).toBe('bashTask')
    })

    it('bashTask 选中态默认未选中；分区内写入可读回（selection/bash-task.ts，§6.6① 迁出后落点）', () => {
      bindDrawerSessionId(ref<string | null>('sess-bt'))
      expect(minimalBashTaskSelection.selectedBackgroundTaskId).toBeUndefined()
      expect(useBashTaskSelectionDeep().selectedBackgroundTaskId.value).toBeUndefined()
      setBackgroundTaskView('bt-abc123')
      expect(useBashTaskSelectionDeep().selectedBackgroundTaskId.value).toBe('bt-abc123')
      setBackgroundTaskView(undefined)
      expect(useBashTaskSelectionDeep().selectedBackgroundTaskId.value).toBeUndefined()
    })
  })

  // ── plan tab 扩展（plan 模式重设计 u1-drawer-tab，第 9 员）──
  // 形态照 bashTask 先例：编译期断言由 tsc 系执行，运行期影子验证成员合法 + 默认控制态
  // 零加员即可满足接口（plan tab 无选中态字段，OpenDrawerOptions 零加员）。

  // 'plan' 可赋给 RightDrawerTab（成员缺失即 vue-tsc 红）
  const planTab: RightDrawerTab = 'plan'

  describe('drawer types：plan tab 扩展（plan 模式重设计 u1-drawer-tab）', () => {
    afterEach(() => {
      _resetDrawerControlForTest()
    })

    it("'plan' 是合法 RightDrawerTab 成员（编译期断言的运行期影子）", () => {
      expect(planTab).toBe('plan')
    })

    it("默认控制态零加员即满足接口（'plan' 作 activeTab 写入分区可读回）", () => {
      bindDrawerSessionId(ref<string | null>('sess-plan'))
      const state = getDrawerControlState()
      expect(state.activeTab).not.toBe('plan')
      state.activeTab = 'plan'
      expect(getDrawerControlState().activeTab).toBe('plan')
    })
  })

  // ── btw tab 扩展（btw-question D7，M3-a 第 10 员）──
  // 形态照 bashTask 先例：编译期断言由 tsc 系执行，运行期影子验证成员合法 + 可选字段
  // selectedBtwSessionId 零加员即可满足接口（默认分区不写该字段的结构保证）。

  // 'btw' 可赋给 RightDrawerTab（成员缺失即 vue-tsc 红）
  const btwTab: RightDrawerTab = 'btw'

  describe('drawer types：btw tab 扩展（btw-question D7，M3-a）', () => {
    afterEach(() => {
      _resetDrawerControlForTest()
      _resetBtwSelectionForTest()
    })

    it("'btw' 是合法 RightDrawerTab 成员（编译期断言的运行期影子）", () => {
      expect(btwTab).toBe('btw')
    })

    it('btw 选中态默认未查看；分区内写入可读回（selection/btw.ts，§6.6① 迁出后落点）', () => {
      // 可选性锚：minimalBtwSelection 字面量（上方）未含 selectedBtwSessionId 仍满足接口，
      // 若未来改必填则该字面量 tsc 红，createDefaultBtwSelection 构造点同步被迫改。
      expect(minimalBtwSelection.selectedBtwSessionId).toBeUndefined()
      bindDrawerSessionId(ref<string | null>('sess-btw'))
      expect(useBtwSelection().selectedBtwSessionId.value).toBeUndefined()
      setBtwViewDeep('pi-line-1')
      expect(useBtwSelection().selectedBtwSessionId.value).toBe('pi-line-1')
      setBtwViewDeep(undefined)
      expect(useBtwSelection().selectedBtwSessionId.value).toBeUndefined()
    })

    it("'btw' 作 activeTab 写入分区可读回（DrawerPanel tab 元信息消费方）", () => {
      bindDrawerSessionId(ref<string | null>('sess-btw-tab'))
      const state = getDrawerControlState()
      expect(state.activeTab).not.toBe('btw')
      state.activeTab = 'btw'
      expect(getDrawerControlState().activeTab).toBe('btw')
    })
  })

  // ── 右抽屉 8 tab 枚举（display-containers §7.1，u-foundation 类型契约）──
  // 形态照 bashTask/plan/btw 先例：编译期断言由 tsc 系执行，运行期影子验证成员合法。
  // 负向断言用条件类型锚（不依赖 @ts-expect-error：若负向条件成立（即收窄被回退），
  // 类型从 true 塌缩为 false，赋值即 tsc 红）。

  // §7.1 终态 8 员逐字成员序（成员缺失/改序即 tsc 红）
  const rightDrawerTabs: RightDrawerTab[] = ['git', 'doc', 'detail', 'subagent', 'bashTask', 'plan', 'btw', 'trace']

  // 'terminal' 不属于右抽屉终态枚举（已迁底抽屉）——若 RightDrawerTab 混入 'terminal'，本类型塌缩为 false、赋值 tsc 红
  type TerminalIsNotRightTab = 'terminal' extends RightDrawerTab ? false : true
  const terminalNegativeAnchor: TerminalIsNotRightTab = true

  // [U7 收窄终态] tab 类型单一化 = RightDrawerTab：'terminal'（迁底抽屉）与 'browser'（走浮层）
  // 双双不可赋给 RightDrawerTab——负向条件锚（若成员被回混，类型堄缩 false、赋值 tsc 红）
  type BrowserIsNotRightTab = 'browser' extends RightDrawerTab ? false : true
  const browserNegativeAnchor: BrowserIsNotRightTab = true

  // 控制态 activeTab 类型收窄锚：activeTab 回流任何 terminal/browser 成员即堄缩 false、赋值 tsc 红
  type ControlTabIsRightDrawer = DrawerControlState['activeTab'] extends RightDrawerTab ? true : false
  const controlTabNarrowAnchor: ControlTabIsRightDrawer = true

  // ── display-containers §6.6①/③ 控制态收窄锚（W0 还债）──
  // 五字段与 docked 不在 DrawerControlState（若被回填进控制态，本负向锚塌缩为 false、赋值 tsc 红）。
  type ParasiteFieldsRemoved = 'docked' extends keyof DrawerControlState
    ? false
    : 'selectedSubagentId' extends keyof DrawerControlState
      ? false
      : 'selectedBtwSessionId' extends keyof DrawerControlState
        ? false
        : true
  const controlStateSlimAnchor: ParasiteFieldsRemoved = true

  describe('drawer types：右抽屉 8 tab 枚举（display-containers §7.1，U7 收窄终态）', () => {
    it('RightDrawerTab = §7.1 终态 8 员（编译期断言的运行期影子）', () => {
      expect(rightDrawerTabs).toEqual(['git', 'doc', 'detail', 'subagent', 'bashTask', 'plan', 'btw', 'trace'])
    })

    it("'terminal'/'browser' 均不可赋给 RightDrawerTab（条件类型负向锚的运行期影子；tab 类型单一化 = RightDrawerTab）", () => {
      expect(terminalNegativeAnchor).toBe(true)
      expect(browserNegativeAnchor).toBe(true)
    })

    it('DrawerControlState.activeTab 类型收窄为 RightDrawerTab（收窄锚运行期影子）', () => {
      expect(controlTabNarrowAnchor).toBe(true)
    })

    it('DrawerControlState 仅 { isOpen, activeTab }（五字段迁出 + docked 删除的负向锚运行期影子）', () => {
      expect(controlStateSlimAnchor).toBe(true)
      expect(Object.keys(minimalControlState).sort()).toEqual(['activeTab', 'isOpen'])
    })
  })
});
