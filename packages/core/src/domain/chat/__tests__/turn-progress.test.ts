/**
 * turn 进展观测面单测（session-dead-structural-fixes §3.3 D6 C1 方案一 / §3.1 成功路径 C；
 * 收窄形态见 remove-turn-progress-bar 设计 §2.3——snapshot 仅 turnElapsedMs/warn 两字段）。
 *
 * 信号源走真实事件流入口：applyMessageEvent（message_start / text_delta / tool_call_*）
 * + store.setOccupancy（session.occupancy 帧 renderer 侧消费入口，useChat
 * handleSessionOccupancy 同一落点）。锁定验收语义：
 * - snapshot 收窄不变量：公共接口仅 turnElapsedMs/warn 两字段（snapshot 公共接口 ≡ 运行时
 *   消费面，设计 §2.3）
 * - 结构事件边界驱动计时：turn-start 起算，elapsed 仅按墙钟走（delta/事件帧
 *   不重置计时基线）
 * - ask_user pending 豁免（D6 豁免态）：经 warn 行为断言——超阈值也不 warn，
 *   豁免解除后恢复（awaitingUser 不再暴露于 snapshot）
 * - 「继续等待」snooze：本 turn 内抑制警示，turn 结束后新 turn 复位
 * - turn 结束（occupancy → idle）展示消失 + 记忆复位（设计：展示自动消失，reload
 *   天然无残留——纯本地派生无持久化）
 * - 切 session 分区记忆以 turn 锚守门（F-U1）：后台 turn 已更替 → 切入重落基线不虚高；
 *   同 turn 切回 → 计时基线保留
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/turn-progress.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, ref, effectScope } from 'vue'
import type { Ref } from 'vue'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import { useTurnProgress, TURN_PROGRESS_WARN_THRESHOLD_MS } from '../turn-progress'

const SID = 's-turn'

function makeEnv(initialSid: string | null = SID) {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  const sid: Ref<string | null> = ref(initialSid)
  const awaiting = { value: false }
  const sut = scope.run(() =>
    useTurnProgress(sid, store, { getAwaitingUser: () => awaiting.value }),
  )!
  return { scope, store, sid, awaiting, sut }
}

/** turn-start 真实事件序：occupancy 帧（generating，message_start 挂点驱动）+ message_start。 */
function startTurnEvents(store: ChatStoreInstance, sid = SID, messageId = 'a1'): void {
  store.setOccupancy(sid, { turn: 'generating', compacting: false, bash: false })
  store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId } })
}

/** 推进墙钟并跑一个 tick（interval 周期 1s）。 */
async function advanceAndTick(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms)
  await nextTick()
}

describe('turn-progress 结构事件边界驱动', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('snapshot 收窄形态：公共接口仅 turnElapsedMs/warn 两字段（设计 §2.3 收窄不变量）', async () => {
    const { scope, store, sut } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    expect(Object.keys(sut.snapshot.value!).sort()).toEqual(['turnElapsedMs', 'warn'])
    scope.stop()
  })

  it('turn-start（occupancy generating + message_start）起计时，墙钟推进即 elapsed 增长', async () => {
    const { scope, store, sut } = makeEnv()
    vi.advanceTimersByTime(100_000) // 事件到达前墙钟基线
    startTurnEvents(store)
    await nextTick()
    expect(sut.snapshot.value?.turnElapsedMs).toBe(0)
    vi.advanceTimersByTime(5_000)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(5_000)
    // 计时基线 = message_start 写入的 assistant timestamp（事件点），非 watch 触发点
    scope.stop()
  })

  it('delta 不重置计时：elapsed 仅按墙钟走，不受 delta 帧影响', async () => {
    const { scope, store, sut } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    vi.advanceTimersByTime(60_000)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(60_000)
    store.applyMessageEvent(SID, { type: 'message.text_delta', payload: { sessionId: SID, delta: 'hello' } })
    await nextTick()
    // delta 到达（事件边沿）不动计时基线
    expect(sut.snapshot.value?.turnElapsedMs).toBe(60_000)
    vi.advanceTimersByTime(5_000)
    // 若 delta 重置了计时，此处会是 5_000 而非 65_000
    expect(sut.snapshot.value?.turnElapsedMs).toBe(65_000)
    scope.stop()
  })

  it('turn 结束（occupancy → idle）：展示消失；新 turn 重新计时（记忆复位）', async () => {
    const { scope, store, sut } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    vi.advanceTimersByTime(30_000)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(30_000)
    store.setOccupancy(SID, { turn: 'idle', compacting: false, bash: false })
    await nextTick()
    expect(sut.snapshot.value).toBeNull()
    // 新 turn：基线重置（若残留旧 turnStartedAt，elapsed 会是 30_000+）
    vi.advanceTimersByTime(10_000)
    startTurnEvents(store, SID, 'a2')
    await nextTick()
    vi.advanceTimersByTime(1_000)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(1_000)
    scope.stop()
  })

  it('cold-start：挂载时 turn 已活跃（split 双 panel / 切回场景），基线取 assistant timestamp 而非挂载时刻', async () => {
    const scope = effectScope(true)
    const store = scope.run(() => createChatStore())!
    vi.advanceTimersByTime(50_000)
    startTurnEvents(store) // 无观测者在场的 turn
    vi.advanceTimersByTime(8_000)
    const sid = ref<string | null>(SID)
    const sut = scope.run(() => useTurnProgress(sid, store))!
    await nextTick()
    // 挂载即有快照（immediate watch），计时从 message_start 事件点起算（50s），不是挂载点（58s）
    expect(sut.snapshot.value?.turnElapsedMs).toBe(8_000)
    scope.stop()
  })

  it('切 session：展示随目标切换，切回活跃 session 计时延续（per-session 分区记忆）', async () => {
    const { scope, store, sut, sid } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    vi.advanceTimersByTime(20_000)
    // 切到 idle session：展示消失
    sid.value = 's-other'
    await nextTick()
    expect(sut.snapshot.value).toBeNull()
    // 切回：turn 仍在跑，计时基线保留（不是从零开始）
    vi.advanceTimersByTime(5_000)
    sid.value = SID
    await nextTick()
    expect(sut.snapshot.value?.turnElapsedMs).toBe(25_000)
    scope.stop()
  })

  it('双活跃切换：目标 turn 已在后台更替（user 开新 turn），切入重落基线不虚高（F-U1①）', async () => {
    const { scope, store, sut, sid } = makeEnv()
    // B（s-other）先有被观测的 turn1（分区留下 b1 记忆）
    sid.value = 's-other'
    startTurnEvents(store, 's-other', 'b1')
    await nextTick()
    // 切入活跃 A：双活跃（B 转后台继续）
    sid.value = SID
    startTurnEvents(store, SID, 'a1')
    await nextTick()
    vi.advanceTimersByTime(30_000)
    // 后台：B turn1 收口 + user 消息开启 turn2（观测者在 A——B 的帧不触发边沿，分区记忆滞留 b1）
    store.setOccupancy('s-other', { turn: 'idle', compacting: false, bash: false })
    store.appendUser('s-other', [{ type: 'text', text: 'q2' }])
    vi.advanceTimersByTime(10_000)
    startTurnEvents(store, 's-other', 'b2') // b2.timestamp = t=40s（turn2 真实起点）
    vi.advanceTimersByTime(2_000) // t=42s，turn2 已跑 2s
    // 切入 B：锚失配（b1 ≠ 当前末组首条 b2）→ 重落基线；elapsed ≈ 2s 而非从 b1 记忆（t=0）虚高
    sid.value = 's-other'
    await nextTick()
    expect(sut.snapshot.value?.turnElapsedMs).toBe(2_000)
    scope.stop()
  })

  it('turn 内多条 assistant 消息（text→toolCall→text）：切走再切回计时保留，后续段不重置基线（F-U1②）', async () => {
    const { scope, store, sut, sid } = makeEnv()
    startTurnEvents(store, SID, 'a1')
    await nextTick()
    vi.advanceTimersByTime(10_000)
    // 切到 idle session（prev 为非活跃源——锚方案前此路径无条件 startTurn，基线被重置丢失）
    sid.value = 's-other'
    await nextTick()
    expect(sut.snapshot.value).toBeNull()
    vi.advanceTimersByTime(5_000)
    // 切回：同 turn（锚未变）→ 计时基线保留
    sid.value = SID
    await nextTick()
    expect(sut.snapshot.value?.turnElapsedMs).toBe(15_000)
    // turn 内第二条 assistant（后续段）：锚匹配（末组首条仍 a1）→ 基线不重置
    store.applyMessageEvent(SID, { type: 'message.message_start', payload: { sessionId: SID, messageId: 'a2' } })
    store.applyMessageEvent(SID, { type: 'message.text_delta', payload: { sessionId: SID, delta: 'world!' } })
    await nextTick()
    expect(sut.snapshot.value?.turnElapsedMs).toBe(15_000)
    scope.stop()
  })
})

describe('turn-progress 阈值警示与豁免（D6）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('阈值 10 分钟（P-3 实测后定值）：仅用于警示切换，未超不警示', async () => {
    const { scope, store, sut } = makeEnv()
    expect(TURN_PROGRESS_WARN_THRESHOLD_MS).toBe(600_000)
    startTurnEvents(store)
    await nextTick()
    advanceAndTick(TURN_PROGRESS_WARN_THRESHOLD_MS - 1_000)
    expect(sut.snapshot.value?.warn).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(sut.snapshot.value?.warn).toBe(true)
    scope.stop()
  })

  it('ask_user pending 豁免（D6）：超阈值也不 warn，豁免解除后警示恢复（经 warn 行为断言）', async () => {
    const { scope, store, sut, awaiting } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 5_000)
    expect(sut.snapshot.value?.warn).toBe(true)
    awaiting.value = true
    vi.advanceTimersByTime(1_000)
    // 等待用户输入期间：警示不参与，计时照常（elapsed 继续走）
    expect(sut.snapshot.value?.warn).toBe(false)
    expect(sut.snapshot.value?.turnElapsedMs).toBeGreaterThanOrEqual(TURN_PROGRESS_WARN_THRESHOLD_MS)
    // 豁免解除后警示恢复（豁免是态不是一次性的）
    awaiting.value = false
    vi.advanceTimersByTime(1_000)
    expect(sut.snapshot.value?.warn).toBe(true)
    scope.stop()
  })

  it('「继续等待」snooze：本 turn 内抑制警示，turn 结束后新 turn 复位', async () => {
    const { scope, store, sut } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 1_000)
    expect(sut.snapshot.value?.warn).toBe(true)
    sut.snoozeWarn()
    expect(sut.snapshot.value?.warn).toBe(false)
    // turn 结束 → 新 turn：snooze 不跨 turn
    store.setOccupancy(SID, { turn: 'idle', compacting: false, bash: false })
    await nextTick()
    startTurnEvents(store, SID, 'a3')
    await nextTick()
    vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 1_000)
    expect(sut.snapshot.value?.warn).toBe(true)
    scope.stop()
  })

  it('无 sid（landing 态）/ 断连收口：无快照不 tick', async () => {
    const { scope, store, sut, sid } = makeEnv(null)
    await nextTick()
    expect(sut.snapshot.value).toBeNull()
    sid.value = SID
    startTurnEvents(store)
    await nextTick()
    expect(sut.snapshot.value?.turnElapsedMs).toBe(0)
    scope.stop()
  })

  // ── tick 防御分支（S-14 补口：9 行缺口的状态机收口不靠人肉验证）──

  it('turn 进行中清空 sessionId：tick 自停（stopTicking + 快照清空，不残留旧 turn 展示）', async () => {
    const { scope, store, sut, sid } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    expect(sut.snapshot.value).not.toBeNull()
    // 后台清空 sid（切 landing / session 销毁路径）：watch 边沿与 tick 双路都必须收口
    sid.value = null
    await nextTick()
    vi.advanceTimersByTime(5_000)
    await nextTick()
    expect(sut.snapshot.value).toBeNull()
    scope.stop()
  })

  it('dispatching 空窗：startTurn 退化基线（无消息用当前时刻），展示不缺位不悬挂', async () => {
    const { scope, store, sut } = makeEnv()
    // occupancy 已 generating 但 message_start 未到（dispatching 空窗）：
    // startTurn 退化为当前时刻作计时基线（turnStartedAt=null 的 tick 防御分支在
    // 边沿流中不可达——isActive 边沿先重落基线，防御分支只收冷启动竞态残窗）
    store.setOccupancy(SID, { turn: 'generating', compacting: false, bash: false })
    await nextTick()
    vi.advanceTimersByTime(2_000)
    await nextTick()
    expect(sut.snapshot.value?.turnElapsedMs).toBe(2_000)
    scope.stop()
  })

  it('idle 边沿漏检兜底：watch flush 前 tick 直接观测 idle → finishTurn 收口不悬挂', async () => {
    const { scope, store, sut } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    expect(sut.snapshot.value).not.toBeNull()
    // 不 await nextTick：模拟「watch 尚未 flush、interval tick 先到」的边沿漏检窗口
    store.setOccupancy(SID, { turn: 'idle', compacting: false, bash: false })
    vi.advanceTimersByTime(1_000)
    await nextTick()
    expect(sut.snapshot.value).toBeNull()
    scope.stop()
  })
})
