/**
 * useRollingRestartStatus —— 滚动重启四态横幅 + reattach 高压延迟轻态（crash-forensics-
 * and-watchdog §3.3 D5/D3，实施单元 u7d + 偏差 #27 纵切片 renderer 半腿）。
 *
 * **双信号源**（D5 横幅契约「持续态必须可拉取」——broadcast 时序竞争教训）：
 * 1. 三个 WS 广播（rollingRestart:deferred / :countdown / :forced）+ reattach:deferred
 *    （#27，进入/缓解两帧）作加速显示；
 * 2. `rollingRestart.status` 只读 RPC 拉取作持续态唯一真相——首个消费者订阅时拉一次
 *    （覆盖手动刷新后挂载），WS 断连重连（connected 转变）后再拉（覆盖重启窗口内重连：
 *    拉到非 idle → 横幅按服务端态恢复；拉到 idle → 见下「终态分叉」）。
 *
 * **终态分叉（设计 D5「两种终态都合法」的 renderer 判定）**：
 * - 重连/刷新后拉到 idle：本窗口生命周期内出现过滚动重启活跃态（sawRollingActive）→
 *   转绿色「已恢复」30s 自动清除（重启完成窗口内重连的确认形态）；从未出现过 → 恒 idle
 *   （「横幅消失不重现」——重启完成窗口内（手动刷新）重连的窗口模块态全新，拉到 idle
 *   零渲染）。已知近似（登记）：模块态无法区分「deferred 期间网络闪断重连到同一 runtime」
 *   与「真的重启过」，闪断会误出一次绿色确认——两条件各自罕见，叠加可忽略。
 * - 转绿数据源说明：设计原文「数据源 = reattach 编排完成事件，session.restored 同源」；
 *   session.restored 是 session 级帧（无窗口级消费者通道，订阅需 per-session 常驻，
 *   横幅是窗口级单例不持有 session 列表），故以「重连 + 服务端状态机 idle」这一可拉取
 *   信号等价判定（planned 退出 → supervisor 零退避重启 → listen 先于 reattach 完成，
 *   绿色确认出现时刻 ≈ reattach 进行中而非完成后，秒级偏差可接受）。
 *
 * **reattach:deferred 并入本 composable（#27 裁决，非独立轻态）**：同一窗口级横幅容器、
 * 同一订阅基建，独立 composable 会重复 refCount/拉取基建；与滚动重启态互斥不冲突的
 * 判定 = 时域不相交——reattach 延迟只在 runtime 启动后短窗口（收割等待 + 高水位轮询），
 * 滚动重启推迟只在运行期（armed 后临界触发）。缓解帧（active=false）只清除
 * reattach-deferred 自身态，不触碰滚动重启态。
 *
 * 状态形态：窗口级单例（非 per-session）——滚动重启是全局动作、内存高压是全局信号，
 * 与 useCrashRecoveryNotice / useMemoryPressure 同款「窗口级单例状态，ADR-0049 Map 分区
 * 范式不适用」判定（无 sidRef、无 per-session 分区）。
 *
 * 订阅防重复（AGENTS 关键规则 2）：模块级 refCount——多实例共享单条物理订阅（4 条事件
 * + 1 条连接 watch），首个消费者注册、最后一个卸载时退订（useMemoryPressure 同款范式；
 * watch 建在 detached effectScope 内，生命周期归 refCount 手动管理，不随首个组件卸载）。
 */
import { ref, shallowRef, onScopeDispose, effectScope, watch, type EffectScope, type Ref } from 'vue'
import { command, onGlobalType, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import { getState } from '@taiji/core/transport/ws-client'
import type {
  ReattachDeferredPayload,
  RollingRestartCountdownPayload,
  RollingRestartDeferredPayload,
  RollingRestartForcedPayload,
  RollingRestartReason,
  RollingRestartStatusPayload,
} from '@taiji/shared'

/** 横幅相位（idle = 无横幅；其余映射四态文案 + #27 reattach 延迟轻态）。 */
export type RollingRestartBannerPhase =
  | { kind: 'idle' }
  | { kind: 'reattach-deferred'; pollMs: number }
  | { kind: 'deferred'; reason: RollingRestartDeferredPayload['reason']; inflight: number | null; deferDeadlineAt: number }
  | { kind: 'countdown'; executesAt: number; inflight: number | null }
  | { kind: 'rolling'; reason: RollingRestartReason | 'executing'; inflight: number | null }
  | { kind: 'recovered' }

/** 「已恢复」绿色态自动清除窗口（设计 D5：30s 自动清除、手动刷新不重现）。 */
export const RECOVERED_AUTO_CLEAR_MS = 30_000

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，已登记 §4 ⑧ 2026-09-12）：滚动重启横幅相位（窗口级全局观测态）
const phase = shallowRef<RollingRestartBannerPhase>({ kind: 'idle' })
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记 §4 ⑧ 2026-09-12）：最近一次 status 拉取快照（观测面）
const lastStatus = shallowRef<RollingRestartStatusPayload | null>(null)
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，已登记 §4 ⑧ 2026-09-12）：滚动重启活跃态出现过标记（终态分叉判定源，窗口级布尔）
/** 本窗口生命周期内是否出现过滚动重启活跃态（终态分叉判定源，见文件头）。 */
const sawRollingActive = ref(false)

/** 订阅引用计数（useMemoryPressure 同款：多消费者共享单条物理订阅）。 */
let refCount = 0
/** 物理退订函数（null = 当前无订阅）。 */
let unsubscribe: (() => void) | null = null
/** 订阅容器的 detached scope（连接 watch 的生命周期归 refCount，不随首个组件卸载）。 */
let subScope: EffectScope | null = null
/** recovered 30s 自动清除定时器句柄。 */
let recoveredTimer: ReturnType<typeof setTimeout> | null = null
/** status 拉取并发护栏（初始拉取与重连拉取竞态时丢弃后到者）。 */
let pullInFlight = false

function clearRecoveredTimer(): void {
  if (recoveredTimer !== null) {
    clearTimeout(recoveredTimer)
    recoveredTimer = null
  }
}

function setPhase(next: RollingRestartBannerPhase): void {
  if (next.kind !== 'recovered') clearRecoveredTimer()
  phase.value = next
}

function enterRecovered(): void {
  clearRecoveredTimer()
  phase.value = { kind: 'recovered' }
  // 30s 自动清除（设计 D5）；real timer——横幅是持续态 UI，fake timers 仅测试内注入
  recoveredTimer = setTimeout(() => {
    recoveredTimer = null
    if (phase.value.kind === 'recovered') phase.value = { kind: 'idle' }
  }, RECOVERED_AUTO_CLEAR_MS)
}

/** rollingRestart.status 拉取结果应用（重连/刷新恢复的唯一真相入口）。 */
function applyStatus(status: RollingRestartStatusPayload): void {
  lastStatus.value = status
  switch (status.state) {
    case 'deferred':
      sawRollingActive.value = true
      setPhase({ kind: 'deferred', reason: status.reason === 'absent-report' ? 'absent-report' : 'inflight', inflight: status.inflight.inFlight, deferDeadlineAt: status.deferDeadlineAt ?? 0 })
      break
    case 'countdown':
      sawRollingActive.value = true
      // status 拉取面无 executesAt（协议只带 deferDeadlineAt）——executesAt=0 表示「倒计时
      // 未知」，横幅退化为不含秒数的「即将重启」文案（T-30s 广播到达时才带精确值）
      setPhase({ kind: 'countdown', executesAt: 0, inflight: status.inflight.inFlight })
      break
    case 'rolling':
      sawRollingActive.value = true
      setPhase({ kind: 'rolling', reason: status.reason ?? 'executing', inflight: status.inflight.inFlight })
      break
    case 'idle':
      // 终态分叉（见文件头）：有过活跃态 → 绿色确认；全新窗口 → 恒 idle（不重现）。
      if (sawRollingActive.value) enterRecovered()
      else setPhase({ kind: 'idle' })
      break
  }
}

/** 拉取 rollingRestart.status（best-effort：断连/超时静默保持现状，下一事件或重连再试）。 */
async function pullStatus(): Promise<void> {
  if (pullInFlight) return
  pullInFlight = true
  try {
    const status = await command('rollingRestart.status', {}, RPC_BACKSTOP_TIMEOUT_MS)
    applyStatus(status)
  } catch (e: unknown) {
    // best-effort 降级：transport 不可用（send false 即 reject）或超时——保持现状不传播。
    // 恢复路径 = 下一事件到达或下次 connected 转变再拉；持续告警无动作面，仅 debug 留痕。
    console.debug('[useRollingRestartStatus] status pull failed (kept current phase):', e)
  } finally {
    pullInFlight = false
  }
}

function applyDeferredEvent(payload: RollingRestartDeferredPayload): void {
  sawRollingActive.value = true
  setPhase({ kind: 'deferred', reason: payload.reason, inflight: payload.inflight.inFlight, deferDeadlineAt: payload.deferDeadlineAt })
}

function applyCountdownEvent(payload: RollingRestartCountdownPayload): void {
  sawRollingActive.value = true
  setPhase({ kind: 'countdown', executesAt: payload.executesAt, inflight: payload.inflight.inFlight })
}

function applyForcedEvent(payload: RollingRestartForcedPayload): void {
  sawRollingActive.value = true
  // forced = 立即执行（硬升级/到点，无 countdown 预告）——直接进红牌态
  setPhase({ kind: 'rolling', reason: payload.reason, inflight: payload.inflight.inFlight })
}

/** #27：reattach 高压延迟进入/缓解。缓解只清自身态，不触碰滚动重启态（时域不相交判定见文件头）。 */
function applyReattachDeferred(payload: ReattachDeferredPayload): void {
  if (payload.active) {
    setPhase({ kind: 'reattach-deferred', pollMs: payload.pollMs })
    return
  }
  if (phase.value.kind === 'reattach-deferred') setPhase({ kind: 'idle' })
}

function ensureSubscribed(): void {
  if (unsubscribe !== null) return
  subScope = effectScope(true) // detached：订阅生命周期归 refCount 手动管理
  unsubscribe = subScope.run(() => {
    const unsubs = [
      onGlobalType('rollingRestart:deferred', (msg) => applyDeferredEvent(msg.payload)),
      onGlobalType('rollingRestart:countdown', (msg) => applyCountdownEvent(msg.payload)),
      onGlobalType('rollingRestart:forced', (msg) => applyForcedEvent(msg.payload)),
      onGlobalType('reattach:deferred', (msg) => applyReattachDeferred(msg.payload)),
      // 断连重连拉取（D5：重连后主动拉取恢复横幅）。getter 形态读 .value，兼容测试替身。
      watch(() => getState().value, (s, old) => {
        if (s === 'connected' && old !== 'connected') void pullStatus()
      }),
    ]
    return () => { for (const u of unsubs) u() }
  }) ?? null
  // 首个消费者订阅即拉一次（覆盖「手动刷新后挂载」的恢复语义；未连接时 reject 被吞）
  void pullStatus()
}

function releaseSubscription(): void {
  unsubscribe?.()
  unsubscribe = null
  subScope?.stop()
  subScope = null
}

/**
 * 消费滚动重启状态（窗口级单例状态 + refCount 订阅，任意组件可调用）。
 * 返回共享的模块级 ref（多实例读同一状态，无 per-instance 拷贝）。
 */
export function useRollingRestartStatus(): {
  phase: Ref<RollingRestartBannerPhase>
  lastStatus: Ref<RollingRestartStatusPayload | null>
  dismiss: () => void
  } {
  refCount++
  ensureSubscribed()
  onScopeDispose(() => {
    refCount--
    if (refCount <= 0) {
      refCount = 0
      releaseSubscription()
    }
  })
  return {
    phase,
    lastStatus,
    dismiss: () => { setPhase({ kind: 'idle' }) },
  }
}

/** 测试钩子：复位模块级状态 + 强制退订 + 清定时器（对齐 _resetXxxForTest 模式）。 */
export function _resetRollingRestartStatusForTest(): void {
  refCount = 0
  clearRecoveredTimer()
  releaseSubscription()
  phase.value = { kind: 'idle' }
  lastStatus.value = null
  sawRollingActive.value = false
  pullInFlight = false
}
