/**
 * turn-progress 单测（session-dead-structural-fixes §3.3 D6 C1 方案一：turn 进展观测面）。
 *
 * 源码语义：从 chat store 既有事件流（occupancy turn 维度 + messages 分区引用）纯本地
 * 派生「本 turn 已进行时长 + 超阈值警示」。零协议。按设计语义逐块覆盖：
 * ① turn 边界投影：occupancy generating/dispatching/settling → idle 的快照生命周期
 *   （turn 开始有快照、结束归 null；边沿不重算快照，展示刷新由秒级 tick 驱动）；
 * ② 计时：turnElapsedMs = 墙钟差值（基线优先取末位 assistant timestamp——message_start
 *   写入的墙钟，比 watch 触发时刻更贴近事件点）；setInterval(DEFAULT_TICK_MS=1000) tick 刷新；
 * ③ warn 判定：elapsed ≥ TURN_PROGRESS_WARN_THRESHOLD_MS(600_000) 且非豁免 → warn=true；
 *   ask_user 豁免（getAwaitingUser → true，每 tick 轮询 ≤1 tick 生效）超阈值也不 warn；
 *   snoozeWarn() 后本 turn 内不再 warn，turn 结束自动复位；
 * ④ turn 锚守门（F-U1）：锚 = 记忆 turn 首条 assistant 消息 id，与 message-turns SSOT
 *   分组末组首条比对——同 turn 切回（锚匹配）延续计时；后台 turn 更替（锚失配）重落基线
 *   elapsed 不虚高；dispatching 空窗切入基线暂取末位 assistant（上一 turn，残余窗口偏虚高），
 *   message_start(assistant) 到达即重落自纠；同 turn 内追加 assistant（锚=组内首条，不变）
 *   不重置计时；
 * ⑤ per-session 隔离（ADR-0049 Map 分区）：两 session 各自独立计时互不干扰，切走保留、
 *   切回延续；快路径 lastAssistantId（边沿逐沿刷新的 O(1) 判据）短路时不走 SSOT 分组；
 * ⑥ scope 清理：onScopeDispose 清理 interval；tick 内 idle / 无 sid / 无分区记忆三族
 *   防御性收口。
 *
 * 驱动方式（裸 node vitest 已验证可行）：
 * - composable 包 effectScope(true).run(...)（watch immediate + onScopeDispose 需要 scope）；
 * - chat source 用 vue ref 承载 messages/occupancy（结构性同构真实 store 的响应式分区），
 *   watch 依赖真实追踪，nextTick() 驱动结构边沿回调；
 * - vi.useFakeTimers({ now: BASE }) 接管 Date.now 与 setInterval，vi.advanceTimersByTime
 *   驱动 tick（fake timers 下 mocked Date 随 timer 推进同步走钟）。
 * 纯内存，不触 fs，不 mock fs-guard。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import type { Message } from '@taiji/shared'
import { useTurnProgress, TURN_PROGRESS_WARN_THRESHOLD_MS } from '../turn-progress'
import type { TurnProgressChatSource, UseTurnProgressOptions } from '../turn-progress'
import { __clearSessionCleanupRegistryForTest } from '../../../foundation/use-session-scoped-state'

type TurnState = 'idle' | 'dispatching' | 'generating' | 'settling'

/** 测试基线时刻（fake timers 初值；所有 timestamp/elapsed 断言锚定此处）。 */
const BASE = Date.parse('2026-01-01T00:00:00.000Z')

let seq = 0
function assistantMessage(timestamp: number): Message {
  return { id: `a-${++seq}`, role: 'assistant', content: '', status: 'streaming', timestamp }
}
function userMessage(timestamp: number): Message {
  return { id: `u-${++seq}`, role: 'user', content: '', status: 'complete', timestamp }
}

/** 响应式 chat source harness：ref 承载 per-sid 分区，结构性同构真实 store（只读投影）。 */
interface Harness {
  sid: Ref<string | null>
  source: TurnProgressChatSource
  append(sid: string, m: Message): void
  setTurn(sid: string, turn: TurnState): void
}

function makeHarness(): Harness {
  const messagesBySid = ref<Record<string, Message[]>>({})
  const turnBySid = ref<Record<string, TurnState>>({})
  return {
    sid: ref<string | null>(null),
    source: {
      getMessages: (id) => messagesBySid.value[id] ?? [],
      getOccupancy: (id) => ({ turn: turnBySid.value[id] ?? 'idle' }),
    },
    append(id, m) {
      messagesBySid.value = { ...messagesBySid.value, [id]: [...(messagesBySid.value[id] ?? []), m] }
    },
    setTurn(id, turn) {
      turnBySid.value = { ...turnBySid.value, [id]: turn }
    },
  }
}

describe('useTurnProgress（turn 进展观测面）', () => {
  let disposals: Array<() => void> = []

  beforeEach(() => {
    vi.useFakeTimers({ now: BASE })
  })

  afterEach(() => {
    for (const d of disposals) d()
    disposals = []
    // useSessionScopedState 模块级 cleanup 注册表隔离（scope stop 已反注册，此处兜底）
    __clearSessionCleanupRegistryForTest()
    vi.useRealTimers()
  })

  /** 挂载 composable（effectScope 包裹 watch immediate / onScopeDispose，respawn-notice 同款）。 */
  function mount(
    source: TurnProgressChatSource,
    sid: Ref<string | null>,
    options?: UseTurnProgressOptions,
  ) {
    const scope = effectScope(true)
    disposals.push(() => scope.stop())
    const api = scope.run(() => useTurnProgress(sid, source, options))!
    return { scope, snapshot: api.snapshot, snoozeWarn: api.snoozeWarn }
  }

  /** 切换展示目标 session 并排空结构边沿回调（watch flush:pre）。 */
  async function show(sid: Ref<string | null>, id: string | null): Promise<void> {
    sid.value = id
    await nextTick()
  }

  describe('turn 边界投影（快照生命周期）', () => {
    it('idle 挂载无快照；dispatching 计入活跃（快照出现）；settling 仍活跃；idle 收口归 null 且停表', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      await show(h.sid, 's1')
      // 挂载于 idle session：无残留在先，复位幂等（prev undefined 路径）
      expect(snapshot.value).toBeNull()

      // dispatching 计入活跃（用户视角 turn 从发送起）：无消息 → 基线退化为当前时刻
      h.setTurn('s1', 'dispatching')
      await nextTick()
      expect(snapshot.value).toEqual({ turnElapsedMs: 0, warn: false })

      // generating 边沿：turn 仍活跃，锚未更替不重落；边沿 tick 时墙钟未走 → elapsed 不变
      h.setTurn('s1', 'generating')
      await nextTick()
      expect(snapshot.value!.turnElapsedMs).toBe(0)

      // 秒级 tick 刷新（事件边沿不重算快照——展示刷新只由 interval 驱动）
      vi.advanceTimersByTime(3000)
      expect(snapshot.value!.turnElapsedMs).toBe(3000)

      // settling 计入活跃（到 settled 收口止）
      h.setTurn('s1', 'settling')
      await nextTick()
      expect(snapshot.value).not.toBeNull()

      // agent_settled → idle：快照归 null（消费方渲染自动消失）+ interval 停
      h.setTurn('s1', 'idle')
      await nextTick()
      expect(snapshot.value).toBeNull()
      vi.advanceTimersByTime(5000)
      expect(snapshot.value).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('计时基线取末位 assistant timestamp（message_start 写入的墙钟），非 watch 触发时刻', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      // cold-start / 同批到达形态：挂载时 turn 已活跃且末位 assistant 在 10s 前
      h.setTurn('s1', 'generating')
      h.append('s1', userMessage(BASE - 12_000))
      h.append('s1', assistantMessage(BASE - 10_000))
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(10_000)
      vi.advanceTimersByTime(1000)
      expect(snapshot.value!.turnElapsedMs).toBe(11_000)
    })

    it('turn 收口后新 turn：快照重新出现并从新基线计时', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', userMessage(BASE - 10_000))
      h.append('s1', assistantMessage(BASE - 10_000))
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(10_000)
      h.setTurn('s1', 'idle')
      await nextTick()
      expect(snapshot.value).toBeNull()
      // 新 turn（新 assistant 锚）：从新 timestamp 重落
      vi.advanceTimersByTime(4000)
      h.setTurn('s1', 'generating')
      h.append('s1', userMessage(BASE - 1000))
      h.append('s1', assistantMessage(BASE - 1000))
      await nextTick()
      expect(snapshot.value!.turnElapsedMs).toBe(5000)
    })
  })

  describe('计时与秒级 tick', () => {
    it('DEFAULT_TICK_MS=1000：interval 到点才刷新展示，999ms 内保持陈旧值', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'dispatching')
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(0)
      vi.advanceTimersByTime(999)
      expect(snapshot.value!.turnElapsedMs).toBe(0)
      vi.advanceTimersByTime(1)
      expect(snapshot.value!.turnElapsedMs).toBe(1000)
    })

    it('now/tickMs 注入：接管时钟与刷新间隔（options 契约）', async () => {
      let fakeNow = BASE
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid, { now: () => fakeNow, tickMs: 100 })
      h.setTurn('s1', 'dispatching')
      await show(h.sid, 's1')
      fakeNow = BASE + 500
      vi.advanceTimersByTime(100)
      expect(snapshot.value!.turnElapsedMs).toBe(500)
    })

    it('Math.max(0, …) 钳制：重落基线不早于当前时刻时 elapsed 不为负', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', userMessage(BASE))
      h.append('s1', assistantMessage(BASE))
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(0)
    })
  })

  describe('warn 判定（阈值 + ask_user 豁免 + snooze）', () => {
    it('elapsed 恰等于阈值（≥ 判定）且无豁免注入 → warn=true', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', userMessage(BASE - TURN_PROGRESS_WARN_THRESHOLD_MS - 1000))
      h.append('s1', assistantMessage(BASE - TURN_PROGRESS_WARN_THRESHOLD_MS))
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(TURN_PROGRESS_WARN_THRESHOLD_MS)
      expect(snapshot.value!.warn).toBe(true)
    })

    it('差 1ms 未达阈值 → warn=false', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', assistantMessage(BASE - (TURN_PROGRESS_WARN_THRESHOLD_MS - 1)))
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(TURN_PROGRESS_WARN_THRESHOLD_MS - 1)
      expect(snapshot.value!.warn).toBe(false)
    })

    it('ask_user 豁免（getAwaitingUser → true）：超阈值也不 warn；解除后 ≤1 tick 生效', async () => {
      let awaiting = true
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid, { getAwaitingUser: () => awaiting })
      h.setTurn('s1', 'generating')
      h.append('s1', assistantMessage(BASE - 650_000))
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(650_000)
      // D6 豁免态：警示不参与（漏判 = 措辞不准零伤害）；计时照常
      expect(snapshot.value!.warn).toBe(false)
      // 非响应式轮询：信号解除后 ≤1 tick 生效
      awaiting = false
      vi.advanceTimersByTime(1000)
      expect(snapshot.value!.warn).toBe(true)
    })

    it('getAwaitingUser 返回非 true（false）不豁免', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid, { getAwaitingUser: () => false })
      h.setTurn('s1', 'generating')
      h.append('s1', assistantMessage(BASE - TURN_PROGRESS_WARN_THRESHOLD_MS))
      await show(h.sid, 's1')
      expect(snapshot.value!.warn).toBe(true)
    })

    it('有 sid 但尚无快照时 snoozeWarn：置位分区标记、不凭空造快照', async () => {
      const h = makeHarness()
      const { snapshot, snoozeWarn } = mount(h.source, h.sid)
      await show(h.sid, 's1') // idle：无快照
      snoozeWarn()
      expect(snapshot.value).toBeNull()
    })

    it('snoozeWarn：本 turn 内抑制警示（tick 维持），turn 结束自动复位后新 turn 正常警示', async () => {
      const h = makeHarness()
      const { snapshot, snoozeWarn } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', userMessage(BASE - 601_000))
      h.append('s1', assistantMessage(BASE - 600_000))
      await show(h.sid, 's1')
      expect(snapshot.value!.warn).toBe(true)

      snoozeWarn()
      expect(snapshot.value!.warn).toBe(false)
      vi.advanceTimersByTime(2000)
      // 计时仍在走、警示维持抑制（snoozed 是分区记忆，tick 每次读取）
      expect(snapshot.value!.turnElapsedMs).toBe(602_000)
      expect(snapshot.value!.warn).toBe(false)

      // turn 收口 → 复位；新 turn（新锚）超阈值 → warn 重新出现
      h.setTurn('s1', 'idle')
      await nextTick()
      expect(snapshot.value).toBeNull()
      h.setTurn('s1', 'generating')
      h.append('s1', userMessage(BASE - 599_000))
      h.append('s1', assistantMessage(BASE - 599_000))
      await nextTick()
      expect(snapshot.value!.turnElapsedMs).toBe(601_000)
      expect(snapshot.value!.warn).toBe(true)
    })

    it('无 sid 时 snoozeWarn no-op 不抛错', () => {
      const h = makeHarness()
      const { snoozeWarn } = mount(h.source, h.sid)
      expect(() => snoozeWarn()).not.toThrow()
    })
  })

  describe('turn 锚守门（F-U1：同 turn 延续 / 更替重落）', () => {
    it('同 turn 切回（锚匹配，快路径短路）：延续计时，不从记忆重落虚高也不归零', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', assistantMessage(BASE - 60_000))
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(60_000)

      // 切到 idle 的 s2：快照消失、停表；s1 分区记忆保留（Map 分区不随切走清除）
      await show(h.sid, 's2')
      expect(snapshot.value).toBeNull()
      expect(vi.getTimerCount()).toBe(0)

      // 后台时间推进（interval 已停，仅推钟）
      vi.advanceTimersByTime(30_000)
      // 切回 s1：消息未变 → lastAssistantId 快路径 O(1) 判据命中 → 保留计时基线
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(90_000)
      expect(vi.getTimerCount()).toBe(1)
    })

    it('后台 turn 更替（锚失配）：切回重落基线，elapsed 不从陈旧记忆虚高', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      // turn1 已运行 2 分钟（基线 a1 = BASE-120s）
      h.setTurn('s1', 'generating')
      h.append('s1', userMessage(BASE - 121_000))
      h.append('s1', assistantMessage(BASE - 120_000))
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(120_000)

      await show(h.sid, 's2')
      // 后台：turn1 收口、turn2 开启（新 user/assistant 锚，a2 = BASE-5s）
      h.setTurn('s1', 'idle')
      h.setTurn('s1', 'generating')
      h.append('s1', userMessage(BASE - 6_000))
      h.append('s1', assistantMessage(BASE - 5_000))
      vi.advanceTimersByTime(10_000)

      // 切回：锚失配（a2 ≠ a1）→ 重落 = a2.timestamp → 15s（陈旧记忆会虚高到 130s）
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(15_000)
    })

    it('dispatching 空窗切入残余窗口：基线暂取末位 assistant（上一 turn，偏虚高），message_start 到达重落自纠', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      // 上一 turn 历史消息（末位 assistant a1 = BASE-299s）
      h.append('s1', userMessage(BASE - 300_000))
      h.append('s1', assistantMessage(BASE - 299_000))
      await show(h.sid, 's1')
      expect(snapshot.value).toBeNull() // idle：无快照

      // dispatching 空窗：新 turn 真实起点不可观测 → 基线暂取 a1.timestamp（登记的偏虚高形态）
      h.setTurn('s1', 'dispatching')
      await nextTick()
      expect(snapshot.value!.turnElapsedMs).toBe(299_000)

      // message_start(user) 先到：无新 assistant → 快路径命中（lastAssistantId 未变）→ 不重落
      h.append('s1', userMessage(BASE))
      await nextTick()
      expect(snapshot.value!.turnElapsedMs).toBe(299_000)

      // message_start(assistant) 到达：锚更替 → 重落自纠（a2.timestamp = now → 钳 0，不再虚高）
      h.append('s1', assistantMessage(BASE))
      await nextTick()
      expect(snapshot.value!.turnElapsedMs).toBe(0)
    })

    it('同 turn 内追加 assistant（tool 循环续命）：锚 = 组内首条不变 → 慢路径比对匹配，计时延续不重置', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', userMessage(BASE - 61_000))
      h.append('s1', assistantMessage(BASE - 60_000))
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(60_000)

      // 末位 assistant 更替 → 快路径失配 → 走 SSOT 分组慢路径：末组首条 assistant 仍是 a1 → 匹配保留
      h.append('s1', assistantMessage(BASE - 30_000))
      await nextTick()
      expect(snapshot.value!.turnElapsedMs).toBe(60_000)
    })
  })

  describe('per-session 隔离（ADR-0049 Map 分区）', () => {
    it('两 session 各自独立计时：切走保留、切回延续、互不干扰', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      // s1 基线 BASE-100s，s2 基线 BASE-10s，均 generating
      h.setTurn('s1', 'generating')
      h.append('s1', assistantMessage(BASE - 100_000))
      h.setTurn('s2', 'generating')
      h.append('s2', assistantMessage(BASE - 10_000))

      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(100_000)

      // 切到 s2：s2 用自己的分区记忆（基线独立），不继承 s1 的 elapsed
      await show(h.sid, 's2')
      expect(snapshot.value!.turnElapsedMs).toBe(10_000)
      vi.advanceTimersByTime(5000)
      expect(snapshot.value!.turnElapsedMs).toBe(15_000)

      // 切回 s1：s1 记忆在切走期间保留 → 延续计时（100s + 后台 5s），不被 s2 时间线污染
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(105_000)
    })

    it('切走期间对方 turn 收口不误清自己：快照只随当前展示 session 收口', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', assistantMessage(BASE - 10_000))
      await show(h.sid, 's1')
      expect(snapshot.value).not.toBeNull()

      // 切到 s2（idle）→ 快照消失；再切回 s1（仍 generating）→ 快照按 s1 记忆恢复
      await show(h.sid, 's2')
      expect(snapshot.value).toBeNull()
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(10_000)
    })
  })

  describe('scope 清理与防御性收口', () => {
    it('onScopeDispose 清理 interval：scope.stop 后无残留 timer，推进时间不再驱动', async () => {
      const h = makeHarness()
      const { snapshot, scope } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', assistantMessage(BASE - 5000))
      await show(h.sid, 's1')
      expect(vi.getTimerCount()).toBe(1)

      scope.stop()
      expect(vi.getTimerCount()).toBe(0)
      const frozen = snapshot.value
      vi.advanceTimersByTime(5000)
      expect(snapshot.value).toBe(frozen)
    })

    it('tick 内 idle 兜底（边沿漏检防御）：occupancy 转 idle 而边沿未 flush 时 interval 收口', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', assistantMessage(BASE - 5000))
      await show(h.sid, 's1')
      expect(vi.getTimerCount()).toBe(1)

      // 不 await nextTick：watcher 尚未 flush，interval 先行 → tick 读到 idle → finishTurn
      h.setTurn('s1', 'idle')
      vi.advanceTimersByTime(1000)
      expect(snapshot.value).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
      await nextTick() // 排空 watcher（幂等收口，不抛错）
    })

    it('tick 内无 sid 兜底：sid 置 null 而边沿未 flush 时 interval 停表 + 快照归 null', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', assistantMessage(BASE - 5000))
      await show(h.sid, 's1')
      expect(vi.getTimerCount()).toBe(1)

      h.sid.value = null
      vi.advanceTimersByTime(1000)
      expect(snapshot.value).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
      await nextTick()
    })

    it('tick 内无分区记忆兜底：切 sid 瞬间 interval 先行 → 新 sid 无记忆 → 停表且不泄旧值', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', assistantMessage(BASE - 5000))
      await show(h.sid, 's1')
      expect(snapshot.value).not.toBeNull()

      // 切到无记忆的 s2 且边沿未 flush：interval 用当前 sid 读 s2 分区 → turnStartedAt null → 收口
      h.sid.value = 's2'
      vi.advanceTimersByTime(1000)
      expect(snapshot.value).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
      await nextTick()
    })

    it('后台结束的 turn 切回无残留展示（edge idle + 分区记忆残留分支）', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', assistantMessage(BASE - 5000))
      await show(h.sid, 's1')
      expect(snapshot.value).not.toBeNull()

      // 切走（s1 分区记忆保留）→ s1 在后台收口
      await show(h.sid, 's2')
      h.setTurn('s1', 'idle')
      // 切回：wasActive=false（prev 是 s2 idle），但 s1 分区 turnStartedAt 残留 → finishTurn 收口
      await show(h.sid, 's1')
      expect(snapshot.value).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('tick 内锚失配兜底（F-U1 防御同款校验）：边沿 flush 前陈旧记忆在 tick 里重落，快照不从陈旧基线取值', async () => {
      const h = makeHarness()
      const { snapshot } = mount(h.source, h.sid)
      h.setTurn('s1', 'generating')
      h.append('s1', userMessage(BASE - 121_000))
      h.append('s1', assistantMessage(BASE - 120_000))
      await show(h.sid, 's1')
      expect(snapshot.value!.turnElapsedMs).toBe(120_000)

      // 不 await nextTick：后台 turn 更替（新锚 a2）先于边沿 flush 被 interval tick 看到
      h.append('s1', userMessage(BASE - 500))
      h.append('s1', assistantMessage(BASE - 500))
      vi.advanceTimersByTime(1000)
      // tick 内锚失配 → 重落 = a2.timestamp → elapsed = 1s + 0.5s = 1.5s（陈旧基线会虚高到 121s）
      expect(snapshot.value!.turnElapsedMs).toBe(1500)

      // 排空 watcher：锚已在 tick 内重落 → 边沿快路径命中；ensureTicking 幂等（不叠加 interval）
      await nextTick()
      expect(snapshot.value!.turnElapsedMs).toBe(1500)
      expect(vi.getTimerCount()).toBe(1)
    })

    it('getMessages 返回 undefined（越界防御）不崩溃：startTurn 退化为当前时刻基线', async () => {
      const sid = ref<string | null>('s1')
      const source = {
        getMessages: () => undefined as unknown as Message[],
        getOccupancy: () => ({ turn: 'generating' as const }),
      }
      const { snapshot } = mount(source, sid)
      await nextTick()
      // 无消息可观测：基线 = now()（= BASE）→ elapsed 0；锚/lastAssistantId 落 null
      expect(snapshot.value).toEqual({ turnElapsedMs: 0, warn: false })
    })
  })
})
