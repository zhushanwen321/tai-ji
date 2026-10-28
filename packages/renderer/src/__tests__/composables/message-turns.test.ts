// @vitest-environment node

/**
 * node 环境纯逻辑组合并文件（簇 3-9 A 组，4 源合一）：
 * - message-turns.test.ts —— expandAssistantBlocks/renderKey/toRenderItems 纯函数
 * - use-quota-query.test.ts —— useQuotaQuery 查询逻辑（quota domain + @/api 门面 + @/i18n mock）
 * - useToast.test.ts —— useToast timer 清理/分级/hover（fake timers 各 describe 内 before/after 自封闭）
 * - useSideDrawer.test.ts —— per-session 控制态隔离（@/stores/panel mock）
 *
 * mock 交叉核实：useToast.ts 仅 import vue+@taiji/shared（真模块断言不受任何 mock 影响）；
 * @/i18n mock 仅 useQuotaQuery 消费；@/stores/panel mock 仅 useSideDrawer 消费。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { apiProjectMock } from '../helpers/api-facade-mock'
import { subscriptionStubs } from '../helpers/settings-modal-api-mock'
import type { Message, NormalizedQuotaRow } from '@taiji/shared'

// ── use-quota-query 节 mock ──
vi.mock('@taiji/core/transport/api/domains/quota', () => ({
  getCached: vi.fn(),
  fetchQuota: vi.fn(),
  configure: vi.fn(),
}))

// terminal config 回复（getTerminalConfig / setTerminalConfig 共用形状）
const terminalConfigReply = () => ({
  config: { version: 1, shell: '', shellArgs: [], fontSize: 14, fontFamily: '', scrollback: 1000, cursorStyle: 'block' as const, bell: false },
  corrupted: false,
})

// '@/api' 门面 mock：导入静默底盘（真实门面拉起 WS 连接，node env 不可用）。
vi.mock('@/api', () => ({
  project: apiProjectMock(),
  config: {
    ...subscriptionStubs([
      'onProviders', 'onSkills', 'onAgents', 'onSkillDirs', 'onAgentDirs',
      'onExtensionDirs', 'onDefaults', 'onSystemPrompt', 'onTerminalConfig',
    ]),
    getTerminalConfig: vi.fn(async () => terminalConfigReply()),
    setTerminalConfig: vi.fn(async () => terminalConfigReply()),
  },
  model: subscriptionStubs(['onModels']),
  extension: subscriptionStubs(['onExtensions']),
  settings: {
    getSystem: vi.fn(async () => ({ locale: 'zh-CN', theme: 'dark', themePreset: '' })),
    updateSystem: vi.fn(async () => {}),
  },
}))

vi.mock('@/i18n', () => ({
  setLocale: vi.fn(),
  // useQuotaQuery 的 quotaFailReasonText 经 i18n.global.t 映射 reason 文案（mock 返回 key 本身，断言用）
  default: { global: { t: (key: string) => key } },
}))

// ── useSideDrawer 节 mock：panel store（控制 focusedSessionId 分区键）──
const mockFocusedSessionId = ref<string | null>(null)
const mockPanels = ref<Array<{ id: string; sessionId: string | null }>>([
  { id: 'panel-root', sessionId: null },
])

vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    get focusedSessionId() {
      return mockFocusedSessionId.value
    },
    get panels() {
      return mockPanels.value
    },
    setActive(panelId: string) {
      const p = mockPanels.value.find((leaf) => leaf.id === panelId)
      if (p) mockFocusedSessionId.value = p.sessionId
    },
    loadSession(panelId: string, sessionId: string | null) {
      const p = mockPanels.value.find((leaf) => leaf.id === panelId)
      if (p) {
        p.sessionId = sessionId
        if (panelId === 'panel-root') mockFocusedSessionId.value = sessionId
      }
    },
  }),
}))

import * as quotaApi from '@taiji/core/transport/api/domains/quota'
import { useQuotaQuery } from '@/composables/features/model/useQuotaQuery'
import { useQuotaStore } from '@/stores/quota'
import {
  expandAssistantBlocks,
  renderKey,
  toRenderItems,
  toRenderItemsIncremental,
  createTurnRenderCache,
} from '@/composables/logic/messageTurns'
import type { RenderItem } from '@/composables/logic/messageTurns'
import { useToast } from '@/composables/useToast'
import { useSideDrawer, resetSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { triggerSessionCleanups } from '@/composables/useSessionScopedState'

// ═══ 来源节：message-turns.test.ts —— expandAssistantBlocks/renderKey/toRenderItems 纯函数 ═══
describe('message-turns', () => {
  function makeMsg(over: Partial<Message> = {}): Message {
    return { id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: Date.now(), ...over }
  }

  // [W3·D3 演进] display 过滤已内化到分组输出层：隐藏完成通知消化为 trigger turn 边界、
  // 隐藏非通知消息在 groupRenderInput 透明跳过——独立的 filterDisplayableMessages 无调用点的导出
  // 随过度设计审计候选 1 删除，其行为由「分组规则 v2」用例（core message-turns.incremental）
  // 经 toRenderItems 输出侧锁定。

  describe('expandAssistantBlocks —— 单条 assistant 内部块按时序展开', () => {
    it('B1: 有 contentBlocks → 严格按其顺序输出（thinking→text→tool→thinking 交替）', () => {
      const msg = makeMsg({
        content: '中间产出',
        thinking: [
          { id: 'th1', content: '推理1', collapsed: true },
          { id: 'th2', content: '推理2', collapsed: true },
        ],
        toolCalls: [
          { id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 },
        ],
        contentBlocks: [
          { type: 'thinking', refId: 'th1' },
          { type: 'text', refId: 'text' },
          { type: 'toolCall', refId: 'tc1' },
          { type: 'thinking', refId: 'th2' },
        ],
      })
      const result = expandAssistantBlocks(msg)
      expect(result.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool', 'thinking'])
      expect(result.map((b) => b.kind)).not.toEqual(['text', 'thinking', 'tool', 'thinking'])
    })

    it('B2: text 块 ref = msg.content（完整字符串，非单 chunk delta）', () => {
      const msg = makeMsg({
        content: '完整文本',
        contentBlocks: [{ type: 'text', refId: 'text' }],
      })
      const result = expandAssistantBlocks(msg)
      expect(result).toHaveLength(1)
      expect(result[0].kind).toBe('text')
      expect(result[0].ref).toBe('完整文本')
    })

    it('B3: 无 contentBlocks（降级）→ 旧顺序 text→thinking→tool', () => {
      const msg = makeMsg({
        content: '文本',
        thinking: [{ id: 'th1', content: '推理', collapsed: true }],
        toolCalls: [{ id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 }],
        // 无 contentBlocks
      })
      const result = expandAssistantBlocks(msg)
      expect(result.map((b) => b.kind)).toEqual(['text', 'thinking', 'tool'])
    })

    it('B4: contentBlocks 引用不存在的 thinking/toolCall id → 跳过（防御异常数据）', () => {
      const msg = makeMsg({
        content: '文本',
        thinking: [{ id: 'th1', content: '推理', collapsed: true }],
        // 只有一个 toolCall，但 contentBlocks 引用了 tc2（不存在）
        toolCalls: [{ id: 'tc1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 }],
        contentBlocks: [
          { type: 'text', refId: 'text' },
          { type: 'thinking', refId: 'th_missing' }, // 不存在 → 跳过
          { type: 'toolCall', refId: 'tc_missing' }, // 不存在 → 跳过
          { type: 'thinking', refId: 'th1' },
        ],
      })
      const result = expandAssistantBlocks(msg)
      // 只解出 text + th1（两个 missing 被跳过）
      expect(result.map((b) => b.kind)).toEqual(['text', 'thinking'])
      const thRef = result[1].ref as { id: string }
      expect(thRef.id).toBe('th1')
    })

    it('B5: 空 contentBlocks + 无内容 → 空数组', () => {
      const msg = makeMsg({ content: '', contentBlocks: [] })
      expect(expandAssistantBlocks(msg)).toEqual([])
    })

    /* ── agentgraph 识别：subagent/workflow toolCall 解为 kind='agentgraph'（IF3）── */

    it('B6: 有 contentBlocks 时 subagent/workflow toolCall → kind=agentgraph（contentBlocks 路径）', () => {
      // subagent/workflow 是图结构重型操作，按 toolName 识别为 agentgraph（不是普通 tool）
      const msg = makeMsg({
        content: 'done',
        toolCalls: [
          { id: 'sa1', toolName: 'subagent', input: {}, status: 'completed', startTime: 0 },
          { id: 'wf1', toolName: 'workflow', input: {}, status: 'completed', startTime: 0 },
          { id: 'grep1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 },
        ],
        contentBlocks: [
          { type: 'text', refId: 'text' },
          { type: 'toolCall', refId: 'sa1' },
          { type: 'toolCall', refId: 'wf1' },
          { type: 'toolCall', refId: 'grep1' },
        ],
      })
      const result = expandAssistantBlocks(msg)
      // subagent + workflow → agentgraph；grep → 普通 tool
      expect(result.map((b) => b.kind)).toEqual(['text', 'agentgraph', 'agentgraph', 'tool'])
      // ref 仍是 ToolCall（数据结构不变，仅 kind 不同）
      const saRef = result[1].ref as { id: string; toolName: string }
      expect(saRef.id).toBe('sa1')
      expect(saRef.toolName).toBe('subagent')
    })

    it('B7: 无 contentBlocks（降级）时 subagent/workflow toolCall → kind=agentgraph（fallback 路径同步识别）', () => {
      // 降级路径（无 contentBlocks）同样按 toolName 识别 agentgraph，与 contentBlocks 路径一致
      const msg = makeMsg({
        content: '文本',
        toolCalls: [
          { id: 'sa1', toolName: 'subagent', input: {}, status: 'completed', startTime: 0 },
          { id: 'grep1', toolName: 'grep', input: {}, status: 'completed', startTime: 0 },
        ],
        // 无 contentBlocks → 走降级路径
      })
      const result = expandAssistantBlocks(msg)
      // 降级顺序 text→tool：subagent 标 agentgraph，grep 标 tool
      expect(result.map((b) => b.kind)).toEqual(['text', 'agentgraph', 'tool'])
    })
  })

  /**
   * kind 全集现算（renderer-model 归一 M1，conversation-renderer-model-unification §3.3.1）。
   *
   * kind 是 toRenderItems 每渲染从同一堆可选字段现算的派生值（不落 store），全集三态：
   * turn（user+assistant 回合）/ systemNotice（system 无 bashExecution）/ bashExecution（system + bashExecution）。
   *
   * 判定顺序与旧 MessageStream system 分支一致：bashExecution 优先于 systemNotice 兜底。
   * bgNotify/gui 不属全集（完成通知 display:false 过滤 + workflow-result 同源移除，见 SSOT）。
   */
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

  /** kind 全集 → MessageStream 渲染组件映射契约（M1 检查点 1 的测试载体）。
   *  新增 kind 时必须同步更新此表 + MessageStream.vue 模板分发（TC3 防遗漏/多余）。 */
  const KIND_COMPONENT_MAP: Record<RenderItem['kind'], string> = {
    turn: 'Turn',
    systemNotice: 'SystemNotice',
    bashExecution: 'BashOutputBlock',
  }

  describe('renderKey 稳定生成（M5 stable-key）', () => {
    /** 三 kind 全覆盖 fixture：turn(用户首条消息 id) + systemNotice + bashExecution */
    function stableFixture(): Message[] {
      return [
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
        bashMsg('bash-1'),
      ]
    }

    it('TC1: 同一组消息两次 toRenderItems → 各 item 的 renderKey 一致（不随渲染重建漂移）', () => {
      const messages = stableFixture()
      const keysA = toRenderItems(messages).map(renderKey)
      const keysB = toRenderItems(messages).map(renderKey)
      expect(keysA).toEqual(keysB)
      // 且 key 是稳定 id 派生（turn 用首条消息 id，system 类用 message.id），非索引。
      // [W3 v2] bash 消息归 turn 内 notices（不产独立 bashExecution 项）——bash-1 落在 t-u2 的 turn 内
      expect(keysA).toEqual(['t-u1', 's-c1', 't-u2'])
    })

    it('TC1: 顶部插入（load-more）后既有 turn 的 renderKey 不漂移', () => {
      const base = [
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
        makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
        makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
      ]
      const before = toRenderItems(base).map(renderKey)
      // load-more 在顶部插入更早的 turn（旧实现按索引生成 key 会让全部既有 key +1 漂移）
      const withMore = [
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        ...base,
      ]
      const after = toRenderItems(withMore).map(renderKey)
      // 既有 turn 的 key 值不变，只多出首项新 turn 的 key（稳定 id 非索引）
      expect(after.slice(1)).toEqual(before)
    })

    it('TC1: 中间插入/删除后既有 turn 的 renderKey 不漂移', () => {
      const base = [
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
        makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
        makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
      ]
      const before = toRenderItems(base).map(renderKey)
      // 中间插入一条 user/assistant 对（新 turn 出现在 index 2 位置）
      const inserted = [
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'uX', role: 'user', content: 'qX' }),
        makeMsg({ id: 'aX', role: 'assistant', content: 'rX' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
        makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
        makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
      ]
      const afterInsert = toRenderItems(inserted).map(renderKey)
      // 新 turn 插在中间，u2/u3 两个既有 turn 的 key 保持 t-u2/t-u3（索引方案会变 t-3/t-4）
      expect(afterInsert).toEqual(['t-u1', 't-uX', 't-u2', 't-u3'])
      // 删除 u2 turn 后，u3 的 key 仍为 t-u3
      const removed = [
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
        makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
      ]
      expect(toRenderItems(removed).map(renderKey)).toEqual(['t-u1', 't-u3'])
      expect(before).toEqual(['t-u1', 't-u2', 't-u3'])
    })

    it('TC1: assistant 自启 turn（首条即 assistant，无 user）用首条 assistant id 作稳定 key', () => {
      const items = toRenderItems([
        makeMsg({ id: 'a0', role: 'assistant', content: '首条 assistant' }),
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      ])
      expect(items.map(renderKey)).toEqual(['t-a0', 't-u1'])
    })

    it('TC1: 同 session 消息追加（streaming 中间态）不改变既有 turn 的 key 集合', () => {
      const mid = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      ])
      const done = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      ])
      // 末尾追加 assistant 只扩展 u2 turn，u1/u2 两个 turn 的 key 不变
      expect(mid.map(renderKey)).toEqual(['t-u1', 't-u2'])
      expect(done.map(renderKey)).toEqual(['t-u1', 't-u2'])
    })
  })

  describe('toRenderItems kind 全集现算（renderer-model M1）', () => {
    it('TC1: user/assistant 消息 → turn（assistant 归入 user 开启的同一回合）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
      ])
      expect(items.map((i) => i.kind)).toEqual(['turn'])
      const turn = items[0]
      if (turn.kind !== 'turn') throw new Error('expected turn item')
      expect(turn.turn.assistants.map((m) => m.id)).toEqual(['a1'])
    })

    it('TC1: system + bashExecution → bashExecution（不落 systemNotice）', () => {
      const items = toRenderItems([bashMsg('bash-1')])
      expect(items.map((i) => i.kind)).toEqual(['bashExecution'])
      const item = items[0]
      if (item.kind !== 'bashExecution') throw new Error('expected bashExecution item')
      expect(item.message.id).toBe('bash-1')
    })

    it('TC1: system 无 bashExecution（compactionSummary/branchSummary/stream_warn）→ systemNotice', () => {
      const items = toRenderItems([
        makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
        makeMsg({ id: 'b1', role: 'system', branchSummary: { summary: 's', fromId: 'prev-id' } }),
        makeMsg({ id: 'w1', role: 'system', customType: 'stream_warn', content: 'warn' }),
      ])
      expect(items.map((i) => i.kind)).toEqual(['systemNotice', 'systemNotice', 'systemNotice'])
    })

    it('TC1: 混合序列顺序：turn → systemNotice → turn（边界 system 独立、bash 归 turn 内 notices）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
        makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
        bashMsg('bash-1'),
      ])
      // [W3 v2] 压缩记录仍是独立 systemNotice 边界项；bash 执行记录归第二 turn 的 notices（不再独立成项）
      expect(items.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'turn'])
      // 压缩记录穿插在 turn 之间，不并入任何 turn
      const notice = items[1]
      if (notice.kind !== 'systemNotice') throw new Error('expected systemNotice item')
      expect(notice.message.content).toBe('压缩记录')
      // bash 记录挂在 u2 turn 内部末尾（D4 inline notice）
      const lastTurn = items[2]
      if (lastTurn.kind !== 'turn') throw new Error('expected turn item')
      expect(lastTurn.turn.notices?.map((m) => m.id)).toEqual(['bash-1'])
    })

    it('TC3 kind 一致性：全覆盖消息形态产出的 kind 集合恰好 = 全集（无遗漏/无多余）', () => {
      const messages: Message[] = [
        // → turn
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
        // → systemNotice 各形态（compactionSummary/branchSummary/stream_warn/customType）
        makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
        makeMsg({ id: 'b1', role: 'system', branchSummary: { summary: 's', fromId: 'prev-id' } }),
        makeMsg({ id: 'w1', role: 'system', customType: 'stream_warn', content: 'warn' }),
        // → bashExecution（[W3 v2] 边界 system 已关闭当前 turn，无 current 的 bash 退化为独立 static 项）
        bashMsg('bash-1'),
      ]
      const kinds = new Set(toRenderItems(messages).map((i) => i.kind))
      // 三态全集恰好都被产出（无 kind 被遗漏）
      expect([...kinds].sort()).toEqual(['bashExecution', 'systemNotice', 'turn'])
      // 组件映射表 keys 与 kind 全集一致（无多余/缺失分支，与 MessageStream 查表对齐）
      expect(Object.keys(KIND_COMPONENT_MAP).sort()).toEqual(['bashExecution', 'systemNotice', 'turn'])
    })
  })

  describe('W21 re-export —— D-4 增量函数经 renderer shim 可导入（perf plan minor 消化）', () => {
    // MessageStream 消费的 toRenderItemsIncremental / createTurnRenderCache / TurnRenderCache
    // 必须经本 shim（renderer 旧消费方统一 import 路径）re-export 自 core SSOT。
    it('toRenderItemsIncremental/createTurnRenderCache 可导入且行为等价全量版 + 快路径引用恒等', () => {
      expect(typeof toRenderItemsIncremental).toBe('function')
      expect(typeof createTurnRenderCache).toBe('function')
      const cache = createTurnRenderCache()
      const msgs: Message[] = [
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
        bashMsg('bash-1'),
      ]
      // [W4] filter 弃用参数已移除：分组消费全量数组，display 过滤内化到 toRenderItems 输出层
      const r1 = toRenderItemsIncremental(msgs, false, cache)
      expect(r1).toEqual(toRenderItems(msgs, false))
      // 同源数组引用二次调用 → 快路径零重算（引用恒等）
      const r2 = toRenderItemsIncremental(msgs, false, cache)
      expect(r2).toBe(r1)
    })
  })

  describe('U6 D5 边界聚合 —— notifySummary 经 renderer 通路（全量构造点）产出', () => {
    /** subagent-bg-notify 隐藏完成通知（display:false + details 单条 record） */
    function notifyMsg(id: string, details: Record<string, unknown>): Message {
      return makeMsg({ id, role: 'system', customType: 'subagent-bg-notify', display: false, content: '', details })
    }

    it('renderer shim 的 toRenderItems：trigger turn 携带 core 派生的 notifySummary（计数 + 三态 + 耗时）', () => {
      const items = toRenderItems([
        makeMsg({ id: 'u1', role: 'user', content: 'q' }),
        makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
        notifyMsg('n1', {
          batch: true,
          items: [
            { id: 't1', status: 'running', agent: 'main', startedAt: 1000, endedAt: 61_000 },
            { id: 't2', status: 'failed', agent: 'main', startedAt: 0 },
          ],
        }),
        makeMsg({ id: 'a2', role: 'assistant', content: '续跑' }),
      ])
      const trigger = items[1]
      if (trigger.kind !== 'turn') throw new Error('expected turn item')
      expect(trigger.turn.trigger).toBe('bg-notify')
      expect(trigger.turn.notifySummary).toEqual({
        count: 2,
        failedCount: 1,
        neutralCount: 0,
        outcomes: ['success', 'failed'],
        durationMs: 60_000, // 聚合集合 = 含 endedAt 记录：max(endedAt)=61000 − min(startedAt)=1000（t2 无 endedAt 不入集合）
      })
      // 渲染过滤不变：隐藏通知本体不产出独立渲染项
      expect(items.map((i) => i.kind)).toEqual(['turn', 'turn'])
    })
  })
})

// ═══ 来源节：useToast.test.ts —— timer 清理/分级/透传/hover（fake timers 节内自封闭） ═══
describe('useToast', () => {
  describe('useToast timer 句柄清理（Q1-8）', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      // useToast 是模块级单例状态：触发全部残留 timer 清空 toasts，避免跨用例污染
      vi.runAllTimers()
      vi.useRealTimers()
    })

    it('remove 提前关闭 toast 后 timer 已清：advance 后回调不再触发', () => {
      const { toasts, error, remove } = useToast()
      error('boom')
      expect(toasts.value).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(1) // 自动移除 timer 已挂

      remove(toasts.value[0].id)
      expect(toasts.value).toHaveLength(0)
      // timer 已被 clearTimeout：fake timers 活跃计数归零
      expect(vi.getTimerCount()).toBe(0)

      // advance 超过最长时长：回调不再触发，无任何副作用
      vi.advanceTimersByTime(8000)
      expect(toasts.value).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('不提前 remove 时 info 4s 后自然移除（原行为保持）', () => {
      const { toasts, info } = useToast()
      info('hello')
      expect(toasts.value).toHaveLength(1)

      vi.advanceTimersByTime(3999)
      expect(toasts.value).toHaveLength(1) // 未到期不移除

      vi.advanceTimersByTime(1)
      expect(toasts.value).toHaveLength(0) // 到期自然移除
      expect(vi.getTimerCount()).toBe(0) // 句柄自清
    })

    it('多个 toast 独立计时，remove 只清对应 timer', () => {
      const { toasts, info, remove } = useToast()
      info('first')
      info('second')
      expect(vi.getTimerCount()).toBe(2)

      remove(toasts.value[0].id) // 提前关第一个
      expect(toasts.value).toHaveLength(1)
      expect(toasts.value[0].message).toBe('second')
      expect(vi.getTimerCount()).toBe(1) // 第二个的 timer 仍在

      vi.advanceTimersByTime(4000) // 第二个自然到期移除
      expect(toasts.value).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('useToast 停留时长分级（notify 优化）', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.runAllTimers()
      vi.useRealTimers()
    })

    it('error/warning 停留 8s：4s 时仍在、8s 时移除', () => {
      const { toasts, error, warning } = useToast()
      error('boom')
      warning('careful')
      expect(vi.getTimerCount()).toBe(2)

      vi.advanceTimersByTime(4000)
      expect(toasts.value).toHaveLength(2) // 未到期

      vi.advanceTimersByTime(4000)
      expect(toasts.value).toHaveLength(0) // 8s 到期
    })
  })

  describe('useToast session 定位透传（notify 优化）', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.runAllTimers()
      vi.useRealTimers()
    })

    it('opts.sessionLabel/sessionId 进入 toast 条目', () => {
      const { toasts, warning } = useToast()
      warning('Goal blocked. Use /goal resume.', {
        sessionLabel: '修通知组件 · taiji',
        sessionId: 'sid-1',
      })
      expect(toasts.value[0].sessionLabel).toBe('修通知组件 · taiji')
      expect(toasts.value[0].sessionId).toBe('sid-1')
    })

    it('不带 opts 的调用 sessionLabel/sessionId 为 undefined（退化纯消息）', () => {
      const { toasts, info } = useToast()
      info('plain')
      expect(toasts.value[0].sessionLabel).toBeUndefined()
      expect(toasts.value[0].sessionId).toBeUndefined()
    })
  })

  describe('useToast hover 暂停/恢复（notify 优化）', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.runAllTimers()
      vi.useRealTimers()
    })

    it('pause 后 advance 超额仍留存，resume 按剩余时长续走', () => {
      const { toasts, info, pause, resume } = useToast()
      info('hover me')
      const id = toasts.value[0].id

      vi.advanceTimersByTime(1000) // 已消耗 1s
      pause(id)
      vi.advanceTimersByTime(10_000) // 暂停期间时间流逝不生效
      expect(toasts.value).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0) // timer 已清

      resume(id) // 剩余 3s 重建
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(2999)
      expect(toasts.value).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(toasts.value).toHaveLength(0)
    })

    it('未暂停时 pause no-op；已移除后 resume no-op', () => {
      const { toasts, info, pause, resume } = useToast()
      info('x')
      const id = toasts.value[0].id

      resume(id) // 未暂停：无 timer 变化
      expect(vi.getTimerCount()).toBe(1)

      pause(id)
      pause(id) // 幂等：不重复计时
      expect(vi.getTimerCount()).toBe(0)

      resume(id)
      vi.runAllTimers() // 自然移除
      expect(toasts.value).toHaveLength(0)
      resume(id) // 已移除：no-op 不复活
      expect(toasts.value).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})

// ═══ 来源节：use-quota-query.test.ts —— useQuotaQuery 查询逻辑 ═══
describe('use-quota-query', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  const mockRow: NormalizedQuotaRow = {
    label: 'Zhipu Coding Plan',
    wins: [
      { pct: 68, resetSec: 4980 },
      { pct: 42, resetSec: 266400 },
      { pct: null, resetSec: null },
    ],
  }

  const mockCachedResult = { data: mockRow, lastFetchAt: 1000 }
  const mockFetchResult = { data: { ...mockRow, wins: [{ pct: 72, resetSec: 3600 }, mockRow.wins[1], mockRow.wins[2]] }, lastFetchAt: 2000 }

  describe('useQuotaQuery', () => {
    it('providerId 为 null → data 为 null，onHoverEnter 是 no-op', async () => {
      const providerIdRef = ref<string | null>(null)
      const { data, lastFetchAt, onHoverEnter } = useQuotaQuery(providerIdRef)

      expect(data.value).toBeNull()
      expect(lastFetchAt.value).toBeNull()

      await onHoverEnter()
      expect(quotaApi.getCached).not.toHaveBeenCalled()
      expect(quotaApi.fetchQuota).not.toHaveBeenCalled()
    })

    it('onHoverEnter：先调 getCached 再调 fetchQuota', async () => {
      vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue(mockFetchResult)

      const providerIdRef = ref<string | null>('zhipu')
      const { data, lastFetchAt, onHoverEnter } = useQuotaQuery(providerIdRef)

      await onHoverEnter()

      expect(quotaApi.getCached).toHaveBeenCalledWith('zhipu')
      expect(quotaApi.fetchQuota).toHaveBeenCalledWith('zhipu')
      // fetch 的结果覆盖 cached 的结果
      expect(data.value).toEqual(mockFetchResult.data)
      expect(lastFetchAt.value).toBe(2000)
    })

    it('onHoverEnter：fetchQuota 失败时，如有 cached 结果则保留', async () => {
      vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
      vi.mocked(quotaApi.fetchQuota).mockRejectedValue(new Error('network'))

      const providerIdRef = ref<string | null>('zhipu')
      const { data, lastFetchAt, onHoverEnter } = useQuotaQuery(providerIdRef)

      await onHoverEnter()

      // getCached 成功写入
      expect(data.value).toEqual(mockRow)
      expect(lastFetchAt.value).toBe(1000)
    })

    it('onHoverEnter：fetch fulfilled 但带 reason（A2-4 失败态契约）→ 保留旧 data + 写 error 文案', async () => {
      // 场景：store 已有旧缓存（此前成功过），本次 fetch 失败返回 data=null + reason（runtime 不抛错）
      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000, reason: 'unauthorized' })
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: 1000, reason: 'unauthorized' })

      const providerIdRef = ref<string | null>('zhipu')
      const { data, error, onHoverEnter } = useQuotaQuery(providerIdRef)

      await onHoverEnter()

      // 旧 data 不被 null 覆写（回归检查：BL round1 #3）
      expect(data.value).toEqual(mockRow)
      // error 写入 reason 映射文案（i18n mock 返回 key 本身）
      expect(error.value).toBe('panel.context.quotaFailUnauthorized')
    })

    it('onHoverEnter：fetch fulfilled 无 reason → 成功路径写 data 清 error', async () => {
      vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue(mockFetchResult)

      const providerIdRef = ref<string | null>('zhipu')
      const { data, error, onHoverEnter } = useQuotaQuery(providerIdRef)

      await onHoverEnter()

      expect(data.value).toEqual(mockFetchResult.data)
      expect(error.value).toBeNull()
    })

    it('onHoverEnter：getCached 初始填充带 reason（runtime 内存失败标记）→ 首屏即失败态而非空白', async () => {
      // 场景：store 无条目（renderer 重载），runtime 内存有失败标记且无缓存数据
      vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null, reason: 'network' })
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null, reason: 'network' })

      const providerIdRef = ref<string | null>('zhipu')
      const { data, error, onHoverEnter } = useQuotaQuery(providerIdRef)

      await onHoverEnter()

      expect(data.value).toBeNull()
      expect(error.value).toBe('panel.context.quotaFailNetwork')
    })

    it('onHoverEnter：并发保护——pending 期间重复调用被跳过', async () => {
      // 让 fetchQuota 挂起（不 resolve）
      let resolveFetch: (v: typeof mockFetchResult) => void
      const fetchPromise = new Promise<typeof mockFetchResult>((resolve) => {
        resolveFetch = resolve
      })
      vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
      vi.mocked(quotaApi.fetchQuota).mockReturnValue(fetchPromise)

      const providerIdRef = ref<string | null>('zhipu')
      const store = useQuotaStore()
      const { onHoverEnter } = useQuotaQuery(providerIdRef)

      // 第一次调用
      const p1 = onHoverEnter()
      // 第二次调用（pending 期间）
      const p2 = onHoverEnter()

      // 第二次应该是 no-op（同一 tick 内）
      expect(store.isPending('zhipu')).toBe(true)

      // 解析 fetch
      resolveFetch!(mockFetchResult)
      await Promise.all([p1, p2])

      // getCached 只被调一次（第二次被 pending 跳过）
      expect(quotaApi.getCached).toHaveBeenCalledTimes(1)
      expect(quotaApi.fetchQuota).toHaveBeenCalledTimes(1)
    })

    it('onHoverEnter：providerId 变化后使用新 ID', async () => {
      vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue(mockFetchResult)

      const providerIdRef = ref<string | null>('zhipu')
      const { onHoverEnter } = useQuotaQuery(providerIdRef)

      await onHoverEnter()
      expect(quotaApi.getCached).toHaveBeenCalledWith('zhipu')

      // 切换 provider
      providerIdRef.value = 'kimi'
      vi.mocked(quotaApi.getCached).mockClear()
      vi.mocked(quotaApi.fetchQuota).mockClear()

      await onHoverEnter()
      expect(quotaApi.getCached).toHaveBeenCalledWith('kimi')
      expect(quotaApi.fetchQuota).toHaveBeenCalledWith('kimi')
    })

    it('data 是响应式：store 更新后 computed 自动刷新', async () => {
      vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
      vi.mocked(quotaApi.fetchQuota).mockResolvedValue(mockFetchResult)

      const providerIdRef = ref<string | null>('zhipu')
      const { data, onHoverEnter } = useQuotaQuery(providerIdRef)

      expect(data.value).toBeNull()
      await onHoverEnter()
      expect(data.value).toEqual(mockFetchResult.data)
    })
  })
})

// ═══ 来源节：useSideDrawer.test.ts —— per-session 控制态隔离 ═══
describe('useSideDrawer', () => {
  /** 切换当前 focused session（模拟 selectSession 改 active panel 的 session 绑定） */
  function focusSession(sid: string | null): void {
    mockFocusedSessionId.value = sid
  }

  beforeEach(() => {
    // 注意：不调 __clearSessionCleanupRegistryForTest()——useSideDrawer 是模块级单例，
    // controlState 的 cleanup 注册在模块加载时完成（一次），跨 test 保留是正确的。
    // clear 反而会丢掉单例的 cleanup 注册，导致 U5 的 triggerSessionCleanups 验证失效。
    // 状态隔离靠 resetSideDrawer（清分区）。
    mockFocusedSessionId.value = null
    mockPanels.value = [{ id: 'panel-root', sessionId: null }]
    resetSideDrawer()
  })

  describe('useSideDrawer U1 (AC-1) 跨 session 不干扰', () => {
    it('session A 的 drawer 打开，用户在 B，B 的 drawer 不被弹开', () => {
      focusSession('A')
      useSideDrawer().open('git')

      focusSession('B')
      const { isOpen, activeTab } = useSideDrawer()

      // B 的 drawer 不被弹开
      expect(isOpen.value).toBe(false)
      expect(activeTab.value).toBe('git')
    })
  })

  describe('useSideDrawer U5 (AC-5) deleteSession 清理分区', () => {
    it('triggerSessionCleanups(A) 清掉 A 控制态分区', () => {
      focusSession('A')
      useSideDrawer().open('git')

      // session 销毁编排
      triggerSessionCleanups('A')

      // A 分区重置：切到 A 应是默认态（isOpen=false）
      focusSession('A')
      expect(useSideDrawer().isOpen.value).toBe(false)
      expect(useSideDrawer().activeTab.value).toBe('git')
    })
  })

  describe('useSideDrawer U6 (AC-6) 手动关不被重开', () => {
    it('A 手动 open 后 close，切走再切回，drawer 保持关闭（无新事件）', () => {
      focusSession('A')
      const drawer = useSideDrawer()
      drawer.open('git')
      drawer.close()

      focusSession('B')
      focusSession('A') // 切回，无新事件

      expect(useSideDrawer().isOpen.value).toBe(false)
    })
  })

  describe('useSideDrawer U9 (AC-9) 双 panel standby 无独立状态', () => {
    it('setActive(P2) 后 drawer 显示 B 分区状态（standby 期间无独立维护）', () => {
      // 双 panel 布局：P1(A) P2(B)
      mockPanels.value = [
        { id: 'P1', sessionId: 'A' },
        { id: 'P2', sessionId: 'B' },
      ]
      focusSession('A') // P1 active

      // 在 A 分区操作：开 git tab
      useSideDrawer().open('git')
      expect(useSideDrawer().activeTab.value).toBe('git')

      // 切到 P2（B 变 active）—— B 作为 standby 期间无操作，其分区是默认态
      focusSession('B')
      const drawer = useSideDrawer()
      expect(drawer.isOpen.value).toBe(false) // B 默认态
      expect(drawer.activeTab.value).toBe('git')

      // 切回 P1（A），A 分区状态保留
      focusSession('A')
      expect(useSideDrawer().isOpen.value).toBe(true)
      expect(useSideDrawer().activeTab.value).toBe('git')
    })
  })
})
