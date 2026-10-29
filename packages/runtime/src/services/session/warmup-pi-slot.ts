/**
 * WarmupPiSlot — 预热空 pi 单槽，一次性消费（session-cold-switch-perf §3.3-2/§3.3-5/§3.3-6）。
 *
 * 定位：服务「执行就绪」的命中率优化（冷恢复省一次 spawn 的固定成本），不是会话正确性的
 * 一部分；槽的任何未命中形态（空/签名不匹配/进程死）都只让该次冷切回退现状 spawn 链
 * （最坏 = 现状），不参与查看链路（getHistory 尾读不依赖槽）。
 *
 * 取用三道检查（消费路径依次）：
 * ① 槽空 → 回退 + 顺带补位（「消费必查槽」使每次消费即天然重试点，复活语义）；
 * ② 参数签名（presetId + cwd）不匹配 → 弃槽（杀槽进程）+ 回退 + 后台按目标会话参数补位；
 * ③ 探活失败 → 清槽 + 回退，补位只等下次消费（防死亡环境里补位再死空转）。
 * 探活通过 → 取用，用后不回收：进程经 rekey 归目标会话生命周期管理，槽立刻后台补位。
 * 探活是存在性检查（exited 标记 + pid 存活，同步无挂起风险），禁 RPC 探活——RPC 墙钟
 * 超时已随 ADR-0122 退役，挂死进程会让探活无限挂起卡死 switch；挂死由附着阶段的
 * switch_session 失败兜底回退。
 *
 * 补位 = 失败即空槽 + 消费驱动（无自动重试状态机，否决记录见设计 §3.3-2 不采用栏）：
 * 补位 spawn 失败槽保持空，下次消费经检查①天然重试；无补位自动重试即无空转重试风暴。
 * 冷启动（正常退出后启动/首装）恒空：本模块无独立启动期发火点（构造零副作用，补位只由
 * 消费驱动），正常冷启动无消费即无补位，槽恒空（§3.3-5 不预热）；预热的首次发火 = 首次
 * 消费（冷切或崩溃恢复）后的补位。startup-reattach 的恢复消费不消耗槽实体（take 时槽空
 * → 回退现场 spawn 链；崩溃恢复形态下该次消费触发的补位经让位推迟至 reattach 完成，
 * §3.3-6）。补位候选（§3.3-5）以「本次消费的目标会话参数」直传承载，不读
 * lastViewedAtBySession：switch 主路径等价（markSessionViewed 在 switch 处理器入口先于
 * 恢复链执行，「最新查看条目」与本次消费目标同一）；restore RPC / startup-reattach /
 * 崩溃 respawn 等非 switch 消费点不写 markSessionViewed，直传消费目标是更准候选
 * （详见下方前缀注释块）。
 *
 * reattach 让位（§3.3-6）：补位 spawn 与 startup-reattach 编排期（孤儿收割/高水位轮询/
 * 分批恢复）重叠时推迟至其完成，或让位上界超时后强制发火。推迟只影响预热就绪时点，
 * 不影响触发补位的该次冷切（已回退现状 spawn 链）。
 *
 * 参数签名同源（§3.3-5）：spawn 经 deps.spawnSlotProcess 回调走 SessionLifecycle 的
 * spawnPresetClient 同一构造链（getLaunchPresetOptions → buildPresetClientOptions →
 * migrationGate → pm.createSession），禁止「预热用简化参数、取用后补挂」——pi 每次进程
 * 启动读扩展参数，后补挂与原生挂载不可证等价。
 *
 * P4 命中率结构化日志：每次消费一行 `[warmup] slot outcome=<态> ...`（四态词表：
 * hit / signature-mismatch / empty / process-dead），供命中率探针度量（前提 P4）。
 *
 * idle 超时自杀（§3.3-2 资源兜底）：槽进程空闲满 WARMUP_SLOT_IDLE_TIMEOUT_MS 即销毁清槽
 * （常驻内存的兜底上限，对冲空载 60-100MB 长期驻留；超时值 = 实现参数，§5 检查点③
 * 「空载内存 >150MB 触发收紧」的可调点）。自杀后槽空，下次冷切消费经检查①「槽空 → 回退
 * + 顺带补位」自然完成重预热——设计原文「超时自杀，被取用时重预热」由「消费必查槽」
 * 既有检查点承载，无新增复活机制。世代防护：timer 回调比对捕获的槽条目引用，条目已被
 * 消费/替换/清槽时回调作废，不误杀新槽进程。
 *
 * 摘除（P4 探针显示命中率持续偏低时的对冲设计）：本模块自包含；session-lifecycle 侧
 * 接线仅两处且同文件（构造器内槽实例组装 + restoreSession 进程获取的 acquireRestoreClient
 * 单一接线点），删除即整体摘除，行为回退 = 现状 restoreSession 全链。
 */
import type { IPiEngine } from '../ports/pi-engine.js'
import { DEFAULT_HARVEST_WAIT_BOUND_MS, isStartupReattachActive } from '../startup-reattach.js'
import { toErrorMessage } from '../../utils/errors.js'

/**
 * 槽进程在进程表中的保留 sessionId。单例槽配单例 id：tee 树（`<root>/<id>/logs/`）跨
 * 补位复用不残留；形态过 isPiSessionId（合法树内目录）→ tee 落会话树、消费 rekey 时
 * migratePiSessionLogTree 正常迁树；进程死亡时上层 exit 收敛链对槽 id 无害：组合根站
 * speakSessionDeath 的 settle 空转（槽 id 无债权记录、非父进程）后返回，SessionService
 * exit 清理路径 lifecycle.get 判空早退——零误伤。
 */
export const WARMUP_SLOT_SESSION_ID = 'warmup-pi-slot'

/** 预热目标参数签名（§3.3-5）：presetId 已过 `?? BUILTIN_PRESET_IDS.FULL` 归一，cwd 已过存在性兜底。 */
export interface WarmupSlotTarget { // oe-exempt:20261029:framework:跨文件数据形状契约（deps.spawnSlotProcess 参数签名，session-lifecycle 接线与测试按形状构造，无 implements 形态故单实现计数必然）
  presetId: string
  cwd: string
}

/** 槽 spawn 产物：进程句柄 + spawn 期解析出的派生值（取用时随命中一并移交消费方）。 */
export interface WarmupSlotSpawned { // oe-exempt:20261029:framework:跨文件数据形状契约（spawn 产物移交形状，消费方按形状构造，无 implements 形态故单实现计数必然）
  client: IPiEngine
  allExtPaths: string[]
  fellBackFromPresetId?: string
}

/** 消费结果四态词表（P4 日志 outcome 值；与设计 §3.3-2 三道检查一一对应）。 */
export type WarmupSlotOutcome = 'hit' | 'signature-mismatch' | 'empty' | 'process-dead'

export type WarmupSlotTakeResult =
  | { kind: 'hit'; client: IPiEngine; allExtPaths: string[]; fellBackFromPresetId?: string }
  | { kind: 'signature-mismatch' }
  | { kind: 'empty' }
  | { kind: 'process-dead' }

/** 定时调度注入（缺省 setTimeout；测试注入手动时钟）。返回取消函数。 */
export type WarmupSlotSchedule = (fn: () => void, ms: number) => () => void

export interface WarmupPiSlotDeps { // oe-exempt:20261029:framework:依赖注入端口（本仓「ports 接口先立、单实现常态」，生产组装一处 + 测试 mock 对象字面量满足形状，无 implements 关键字形态）
  /**
   * 槽进程 spawn（§3.3-5 同源约束的唯一落点）：实现方必须走与 restoreSession 现状 spawn
   * 同一构造链（SessionLifecycle.spawnPresetClient），slotSessionId 充当 pm 进程表键。
   */
  spawnSlotProcess: (slotSessionId: string, target: WarmupSlotTarget) => Promise<WarmupSlotSpawned>
  /** 弃槽/清槽的进程销毁（含进程表清册；实现方 = pm.destroySession(槽 id)，幂等）。 */
  destroySlotProcess: () => Promise<void>
  /** reattach 编排期查询（§3.3-6 让位检查；缺省 startup-reattach 模块级活跃标记）。 */
  isReattachBusy?: () => boolean
  /** 定时调度（缺省 setTimeout；fake timers/手动时钟测试注入）。 */
  schedule?: WarmupSlotSchedule
  /** idle 超时值（缺省 WARMUP_SLOT_IDLE_TIMEOUT_MS；测试注入短超时）。 */
  idleTimeoutMs?: number
  now?: () => number
}

/**
 * 补位候选（§3.3-5）以「本次消费的目标会话参数」直传承载，不读 lastViewedAtBySession：
 * lastViewedAtBySession 的唯一写入点 = session.switch 处理器入口（markSessionViewed 先于
 * ensureActive/restore 链执行）——**switch 主路径等价**：「最新查看条目」与本次消费目标
 * 同一；**非 switch 消费点直传更准**：restore 链的其余消费入口（手动 session.restore RPC /
 * startup-reattach / pi 崩溃 respawn 编排，均经 facade.restoreSession 恢复内核）不写
 * markSessionViewed，lastViewedAt 最新条目可能属另一个活跃会话，直传消费目标为更准候选。
 * 不另设跨模块读取器（避免为候选解析触碰 session-service 领地）。崩溃恢复启动的扩展行为：
 * startup-reattach 恢复链消费即触发补位（让位推迟至 reattach 完成后 fill，参数 = 最后
 * 恢复候选）——消费驱动的自然延伸（无独立启动期接线），槽进程有 idle 自杀兜底。
 */

/** reattach 让位轮询间隔：busy 解除后至多一个间隔内发火（纯增益时序，无需更细）。 */
const REATTACH_YIELD_POLL_MS = 1_000

/**
 * 槽进程 idle 超时（§3.3-2 资源兜底的实现参数）：槽就绪后空闲满此时长即自杀清槽。
 * 初值取 10 分钟——覆盖「用户连续切换会话」的消费节奏（分钟级间隔），停止活动后进程
 * 不无限驻留；收紧/放宽 = 改本常量（§5 检查点③「空载内存 >150MB 触发收紧」的调节点）。
 */
export const WARMUP_SLOT_IDLE_TIMEOUT_MS = 600_000

/**
 * 槽条目：签名 + spawn 产物。签名在 spawn 时刻定格——进程是按这套参数启动的，取用比对
 * 必须对「进程的实际参数」而非「此刻最新解析」，否则签名检查形同虚设。
 */
interface WarmupSlotEntry extends WarmupSlotSpawned { // oe-exempt:20261029:framework:模块内部槽条目数据形状（extends 数据形状非行为契约，实现者唯一 = 槽状态机本体）
  target: WarmupSlotTarget
}

/**
 * 存在性探活：exited 标记（进程死亡事件的同步标志）+ pid 存活检查（process.kill(pid, 0)
 * 信号零探测：ESRCH = 不存在，EPERM = 存在但无权限发信号即活）。同步原语，无挂起风险。
 */
export function isPiProcessAlive(client: Pick<IPiEngine, 'exited' | 'pid'>): boolean {
  if (client.exited) return false
  const pid = client.pid
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class WarmupPiSlot {
  private entry: WarmupSlotEntry | undefined
  private spawning = false
  private reattachYieldTimer: (() => void) | undefined
  /** idle 超时自杀定时器（armIdleTimer/cancelIdleTimer 管理，槽条目落定期间活跃）。 */
  private idleTimerCancel: (() => void) | undefined
  /** 让位推迟期间挂起的补位参数（后到消费覆盖前值——最新消费意图即最新候选）。 */
  private deferredTarget: WarmupSlotTarget | undefined
  private readonly isReattachBusy: () => boolean
  private readonly schedule: WarmupSlotSchedule
  private readonly now: () => number

  constructor(private readonly deps: WarmupPiSlotDeps) {
    this.isReattachBusy = deps.isReattachBusy ?? isStartupReattachActive
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, ms)
      return () => { clearTimeout(t) }
    })
    this.now = deps.now ?? Date.now
  }

  /**
   * 消费取用（冷恢复取进程的唯一入口，三道检查依次）。命中时调用方须先把进程 rekey 到
   * 目标 sessionId（接线层职责：tee 树随迁 + exit 回调反查正确），再走现状附着段。
   */
  take(target: WarmupSlotTarget): WarmupSlotTakeResult {
    // ① 槽空（含补位在途——spawning 视同空）：回退 + 顺带补位（消费即重试点）。
    if (!this.entry) {
      this.logConsume('empty', target)
      this.warm(target)
      return { kind: 'empty' }
    }
    const current = this.entry
    // ② 参数签名不匹配：弃槽 + 回退 + 按目标会话参数补位（§3.3-2 检查②）。
    if (!this.signatureMatches(current.target, target)) {
      this.entry = undefined
      this.cancelIdleTimer()
      this.logConsume('signature-mismatch', target, current.target)
      this.discard()
      this.warm(target)
      return { kind: 'signature-mismatch' }
    }
    // ③ 探活失败：清槽 + 回退，不立即补位（死亡环境补位再死 = 空转，等下次消费）。
    if (!isPiProcessAlive(current.client)) {
      this.entry = undefined
      this.cancelIdleTimer()
      this.logConsume('process-dead', target, current.target)
      this.discard()
      return { kind: 'process-dead' }
    }
    // 三道检查全过：取用（用后不回收，归属转移由接线层 rekey 完成）+ 槽立刻补位。
    this.entry = undefined
    this.cancelIdleTimer()
    this.logConsume('hit', target, current.target)
    this.warm(target)
    return {
      kind: 'hit',
      client: current.client,
      allExtPaths: current.allExtPaths,
      fellBackFromPresetId: current.fellBackFromPresetId,
    }
  }

  /**
   * 补位（后台，fire-and-forget）。target = 补位候选参数（见类头「补位候选」段：消费
   * 参数即最新查看候选）。已有条目/补位在途/让位推迟在途时 no-op（防重复 spawn）。
   */
  warm(target: WarmupSlotTarget): void {
    if (this.entry || this.spawning) return
    if (this.reattachYieldTimer) {
      this.deferredTarget = target
      return
    }
    if (this.isReattachBusy()) {
      this.deferredTarget = target
      this.deferUntilReattachIdle()
      return
    }
    this.fill(target)
  }

  /**
   * spawn 动作本体（无 busy 检查）：由 warm（正常路径）与让位 tick（上界超时强制发火）
   * 共用——强制发火必须绕过 warm 的 busy 检查，否则超界判定会被 busy 短路成无限推迟。
   */
  private fill(target: WarmupSlotTarget): void {
    this.spawning = true
    void this.deps.spawnSlotProcess(WARMUP_SLOT_SESSION_ID, target)
      .then((spawned) => {
        this.entry = { target, ...spawned }
        this.armIdleTimer(this.entry)
        console.log(`[warmup] slot filled presetId=${target.presetId} cwd=${target.cwd}`)
      })
      .catch((e: unknown) => {
        // 失败即空槽，无自动重试（§3.3-2 补位策略）：下次消费经检查①天然重试。
        console.warn(`[warmup] slot refill failed, slot stays empty (retried on next consume): ${toErrorMessage(e)}`)
      })
      .finally(() => {
        this.spawning = false
      })
  }

  /**
   * idle 超时自杀定时（§3.3-2 资源兜底）：槽条目落定时启动，条目清除时取消。回调带
   * 世代防护（比对捕获的槽条目引用）——条目已被消费/替换/清槽时回调作废，不误杀新槽。
   * 自杀 = 清槽 + destroySlotProcess；下次消费经检查①「槽空 → 回退 + 顺带补位」重预热。
   */
  private armIdleTimer(slotEntry: WarmupSlotEntry): void {
    this.cancelIdleTimer()
    const timeoutMs = this.deps.idleTimeoutMs ?? WARMUP_SLOT_IDLE_TIMEOUT_MS
    this.idleTimerCancel = this.schedule(() => {
      this.idleTimerCancel = undefined
      if (this.entry !== slotEntry) return
      this.entry = undefined
      console.log(`[warmup] slot idle timeout (${timeoutMs}ms), process destroyed; rewarmed on next consume`)
      this.discard()
    }, timeoutMs)
  }

  private cancelIdleTimer(): void {
    this.idleTimerCancel?.()
    this.idleTimerCancel = undefined
  }

  /** reattach 让位：轮询等编排期结束，或让位上界超时后强制发火（§3.3-6）。 */
  private deferUntilReattachIdle(): void {
    const startedAt = this.now()
    const tick = (): void => {
      this.reattachYieldTimer = undefined
      const target = this.deferredTarget
      this.deferredTarget = undefined
      if (target === undefined) return
      if (!this.isReattachBusy() || this.now() - startedAt >= DEFAULT_HARVEST_WAIT_BOUND_MS) {
        this.fill(target)
        return
      }
      this.deferredTarget = target
      this.reattachYieldTimer = this.schedule(tick, REATTACH_YIELD_POLL_MS)
    }
    this.reattachYieldTimer = this.schedule(tick, REATTACH_YIELD_POLL_MS)
  }

  private signatureMatches(slotTarget: WarmupSlotTarget, target: WarmupSlotTarget): boolean {
    return slotTarget.presetId === target.presetId && slotTarget.cwd === target.cwd
  }

  /** 弃槽/清槽的进程销毁：fire-and-forget，不阻塞消费方回退现状 spawn 链（含册清且幂等）。 */
  private discard(): void {
    void this.deps.destroySlotProcess().catch((e: unknown) => {
      console.warn(`[warmup] slot process discard failed: ${toErrorMessage(e)}`)
    })
  }

  /** P4 命中率结构化日志（一行一态，探针度量的唯一数据源）。 */
  private logConsume(outcome: WarmupSlotOutcome, target: WarmupSlotTarget, slotTarget?: WarmupSlotTarget): void {
    const detail = outcome === 'hit'
      ? `presetId=${target.presetId} cwd=${target.cwd} (reusing warmed process, refill queued)`
      : outcome === 'signature-mismatch'
        ? `slotPresetId=${slotTarget?.presetId} slotCwd=${slotTarget?.cwd} targetPresetId=${target.presetId} targetCwd=${target.cwd} (discarding slot, fallback to spawn, refill queued)`
        : outcome === 'empty'
          ? `targetPresetId=${target.presetId} targetCwd=${target.cwd} (fallback to spawn, refill queued)`
          : `presetId=${slotTarget?.presetId} cwd=${slotTarget?.cwd} (fallback to spawn, refill deferred to next consume)`
    console.log(`[warmup] slot outcome=${outcome} ${detail}`)
  }
}
