/**
 * AbortLiveness — abort RPC 超时路径的三信号判据 + 三级阶梯（独立协作类）。
 *
 * 从 message-dispatcher.ts 抽出（test-infra-source-simplify T5）：abort 阶梯
 * （三级 + 防重入 + 处置竞态）是自成体系的状态机，与消息派发主链无共享可变状态——
 * 唯二交互点（abort() 的 RpcTimeoutError 入口、阶梯 3 的 forceQuitSession 收口）
 * 均经 AbortLivenessDeps 回调注入。公开行为由 message-dispatcher-abort-liveness.test.ts
 * 9 用例锁定（抽离为行为保持重构，断言零修改）。
 */
import type { ServerMessage } from '@xyz-agent/shared'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { ForceQuitSource } from './types.js'
import { RpcTimeoutError } from '../../utils/errors.js'

/** 静默秒数换算（本文件独立小常量，不与 dispatcher 的 formatTimeoutDuration 换算系数共享——两个语义域）。 */
const MS_PER_SECOND = 1000

// ── abort RPC 超时路径的三信号判据 + 三级阶梯（chat-domain-v1x-liveness-governance W7 / D3）──
//
// 事故背景（设计 §2.1 环 6）：goal 循环中用户 ESC → abort RPC（CMD_TIMEOUT_MS=60s）无应答 →
// 旧代码直接判「pi event loop frozen」强杀主 pi，连带击杀子代理——事后证实 pi 未冻结（循环中
// 还在正常执行工具调用）。实装 pi 的 abort RPC 应答即收敛，收敛前无中间信号：60s 超时只能区分
// 「收敛了/没收敛」，不能区分「忙/死」。误杀正常会话正是本阶梯要消除的。
//
// 三信号（全部为 runtime↔主 pi 面可观测）：①快超时探测（getState，RpcClient 侧已配
// FAST_TIMEOUT_MS=10s）；②桥事件窗产出（RpcClient.lastEventAt——事件帧到达 stdout 的时刻）；
// ③abort-RPC pending 状态（本方法入口即「仍在等收敛」，重试计数显式承载）。

/**
 * 阶梯 1（探测有响应）的有界 abort 重试次数上限。设计 D3 建议值；每级有终点、级间迁移
 * 闭合——重试耗尽仍不收敛 → 迁移阶梯 2（用户显式强关），不存在无界重试分支。
 */
const ABORT_STALL_RETRY_LIMIT = 2

/**
 * 阶梯 3（真冻结直达强杀）的事件静默「超保守窗」默认值：10 分钟。
 *
 * 为什么是分钟级大窗：bridge 事件只在 delta / tool 调用边沿产生，LLM 请求等待期可长静默
 * （大 prompt + 慢模型数分钟无 delta 是合法形态）——裸事件新鲜度单独使用会误杀（ADR-0047
 * 「静默 ≠ 卡死」）。本窗只在「快超时探测无响应」已成立后才参与判定（双信号叠加），且
 * 取保守大窗让静默方向错误率趋零。
 *
 * [P3 实测待定] 实施期门 P3（三类会话事件间隔分布实测：正常 turn / abort 落地 / 真冻结）
 * 数据落地后才可收窄；实测前严禁调小。env 逃生门 XYZ_RUNTIME_ABORT_FROZEN_SILENCE_MS
 * 可覆盖（仅限实验/诊断，读一次缓存——对齐 resolveBashRpcTimeoutMs 先例）。
 */
const FROZEN_EVENT_SILENCE_MS_DEFAULT = 600_000

let cachedFrozenEventSilenceMs: number | null = null

function resolveFrozenEventSilenceMs(): number {
  if (cachedFrozenEventSilenceMs === null) {
    const raw = process.env.XYZ_RUNTIME_ABORT_FROZEN_SILENCE_MS
    const parsed = raw !== undefined ? Number(raw) : Number.NaN
    cachedFrozenEventSilenceMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : FROZEN_EVENT_SILENCE_MS_DEFAULT
  }
  return cachedFrozenEventSilenceMs
}

/**
 * 读取 client 的事件活跃戳（RpcClient.lastEventAt，W7 桥事件窗信号）。
 *
 * IPiEngine port 未暴露该成员（W7 领地约束：不动 ports 契约面），此处结构检测 + 运行时
 * guard 读取（全局规则「断言须有运行时 guard」）；实现无此成员（mock / 旧形态）时返回 0
 * （= 从未观测到事件，配合探测无响应即冻结判据，见 RpcClient.lastEventAt getter 注释）。
 */
function readClientLastEventAt(client: IPiEngine): number {
  const candidate = (client as { lastEventAt?: unknown }).lastEventAt
  return typeof candidate === 'number' ? candidate : 0
}

/** 测试隔离：清空阶梯 3 事件静默窗的 env 覆盖缓存（对齐 rpc-client resetBashRpcTimeoutForTest 先例）。生产勿调。 */
export function resetAbortLivenessForTest(): void {
  cachedFrozenEventSilenceMs = null
}

/**
 * abort 发起方分型（U2 修复，一致性审查）：收敛环复用 abort 完整链时用于区分「用户操作」
 * 与「runtime 自动收敛」的终态语义。默认 'user'（全部既有调用方零改动保持用户语义）；
 * 'convergence' 仅由 session-service 的 userStoppedGate.configure 接线传入（收敛环
 * restore-abort 后的 re-abort 通路——收敛环掐掉的是 runtime 自动收敛的补发 turn，非用户
 * 操作，终态与日志不得写「User aborted」语义）。
 */
export type AbortSource = 'user' | 'convergence'

/**
 * AbortLiveness 的宿主依赖（全部回调注入，收窄到阶梯实际消费面）：
 * - getClient：stillOwns 处置竞态判据（阶梯判定期间 session 被用户处置 → 静默中止，R2）
 * - persistSessionOutcome：阶梯 1 终点 A 的 stopped 终态写入
 * - publish：会话级定向发布（阶梯 2 通知 / 终点 A complete 帧）；messageBus 可后置注入
 *   （setMessageBus），undefined-safe 由宿主闭包保证
 * - forceQuitSession：阶梯 3 收口（宿主的强杀收敛编排，与 forceQuit 入口共用）
 */
export interface AbortLivenessDeps {
  getClient(sessionId: string): IPiEngine | undefined
  persistSessionOutcome(sessionId: string, outcome: 'stopped', reason: string): void
  publish(sessionId: string, msg: ServerMessage): void
  forceQuitSession(sessionId: string, outcomeReason: string, exitReason: string, source: ForceQuitSource): Promise<void>
}

export class AbortLiveness {
  /**
   * 进行中的 abort 超时阶梯（W7，per-session 防重入）：key = sessionId，value = 阶梯
   * promise。多个 abort() 同时超时时共享同一实例（后到者 await 先到者的终点），finally
   * 清理——阶梯终点（收敛 / 用户处置移交 / 强杀收敛）即出表，无泄漏。
   */
  private readonly abortStallLadders = new Map<string, Promise<void>>()

  constructor(private readonly deps: AbortLivenessDeps) {}

  /**
   * abort RPC 超时入口（MessageDispatcher.abort 的 RpcTimeoutError 分支委托）。
   * 入口不变量（abort-RPC pending 信号）：caller 只在 catch RpcTimeoutError 时进入——abort
   * 发出 60s（CMD_TIMEOUT_MS）无应答、仍未收敛。
   */
  async handleAbortRpcTimeout(sessionId: string, client: IPiEngine, errMsg: string, source: AbortSource): Promise<void> {
    // 防重入：用户连按 ESC / renderer 重试会让多个 abort() 同时超时——后到者共享先到者的
    // 阶梯实例（await 同一终点），避免双份重试与双份广播。
    const ongoing = this.abortStallLadders.get(sessionId)
    if (ongoing) return ongoing
    const ladder = this.runAbortStallLadder(sessionId, client, errMsg, source)
      .finally(() => this.abortStallLadders.delete(sessionId))
    this.abortStallLadders.set(sessionId, ladder)
    return ladder
  }

  /**
   * 阶梯状态机（每级有终点，级间迁移闭合，无无界分支）：
   *
   * | 级 | 触发条件（三信号组合）                                        | 动作                                   | 终点 |
   * |----|---------------------------------------------------------------|----------------------------------------|------|
   * | 1  | 探测有响应（无论事件窗）→ pi 活、abort 收敛中或排队              | warn 迟滞 + 有界重试 abort（≤2 次）      | A：重试收敛 → abort 成功收口 |
   * |    |                                                               |                                        | 迁移：耗尽 → 级 2 |
   * | 2  | pi 活但 abort 落不了地（级 1 耗尽；或探测无响应 + 事件窗有产出   | 广播「会话无法响应停止请求」+ 强制关闭    | B：决策移交用户（既有 |
   * |    | ——RPC 层饿死的事故形态）                                       | 指引，不自动杀进程                       | session.forceQuit RPC / pi 自然收敛） |
   * | 3  | 探测无响应 + 事件窗静默超保守窗 → 真冻结                         | 直达强杀（现状行为的收窄保留）            | C：forceQuitSession 收敛 |
   *
   * 「record 如实 failed」的 core 侧 record 终态归 D2 裁决表（W3/W4 领地）；runtime 领地
   * 负责的是 session outcome（阶梯 1 成功/A 阶梯 3 → stopped + 原因；阶梯 2 不 persist——
   * abort 未落地、session 存活，persist 会谎报终态）与用户可见广播。
   */
  private async runAbortStallLadder(sessionId: string, client: IPiEngine, errMsg: string, source: AbortSource): Promise<void> {
    // 阶梯判定可长达数分钟（探测 10s × N + 重试 60s × N）：期间用户可能已自行 forceQuit
    // （进程表条目删除 / rebind）。client 不再绑定该 session 即中止——不对已被处置的
    // session 继续重试或广播。
    const stillOwns = (): boolean => this.deps.getClient(sessionId) === client

    // ── 阶梯 1：快超时探测有响应 → pi 活、abort 迟滞 → 有界重试 ──
    let piResponsive = await this.probeEngineAlive(client)
    if (piResponsive) {
      for (let attempt = 1; attempt <= ABORT_STALL_RETRY_LIMIT; attempt++) {
        if (!stillOwns()) return
        console.warn(`[message-dispatcher] abort stalled but pi responsive (liveness probe OK), bounded retry ${attempt}/${ABORT_STALL_RETRY_LIMIT}: sessionId=${sessionId}`)
        try {
          await client.abort()
          // 终点 A：迟滞后收敛。与 abort() 成功路径同构收口（isGenerating/occupancy 已在
          // abort() catch 入口复位，此处不重复）。
          this.deps.persistSessionOutcome(sessionId, 'stopped', `User aborted (abort recovered on stall retry ${attempt}/${ABORT_STALL_RETRY_LIMIT})`)
          const completeMsg = { type: 'message.complete' as const, payload: { sessionId, stopReason: 'aborted' as const } }
          this.deps.publish(sessionId, completeMsg)
          return
        } catch (retryErr) {
          if (!(retryErr instanceof RpcTimeoutError)) {
            // 非超时失败（EPIPE / 进程退出 / RPC 显式拒绝）：transport 已断，重试无意义——
            // 落探测判定（必然无响应）→ 走事件窗判据区分阶梯 2/3。
            piResponsive = false
            break
          }
          // 又超时：复查探测——仍响应则继续重试（下一轮或耗尽迁移阶梯 2）；失联则立即
          // 落窗判定（不再空耗剩余重试名额，pi 已无应答能力）。
          piResponsive = await this.probeEngineAlive(client)
          if (!piResponsive) break
        }
      }
      if (!stillOwns()) return
      if (piResponsive) {
        // 阶梯 1 耗尽 → 迁移阶梯 2（重试名额用尽且探测仍响应 = pi 活但 abort 落不了地）。
        this.publishAbortStalledNotice(sessionId, errMsg)
        return
      }
      // 中途失联：fall through 到事件窗判据（下方阶梯 2/3 分岔）。
    }

    // ── 探测无响应：事件窗判据分岔阶梯 2（有产出）/ 阶梯 3（静默超窗）──
    if (!stillOwns()) return
    const silenceMs = resolveFrozenEventSilenceMs()
    const silentForSec = Math.round((Date.now() - readClientLastEventAt(client)) / MS_PER_SECOND)
    if (silentForSec * MS_PER_SECOND <= silenceMs) {
      // 阶梯 2 直接入口（事故形态）：探测无响应 + 事件窗近窗有产出 → pi 活但 RPC 层饿死。
      console.warn(`[message-dispatcher] abort stalled: pi RPC starved (probe unresponsive but event stream active ${silentForSec}s ago), leaving session alive for explicit user action: sessionId=${sessionId}`)
      this.publishAbortStalledNotice(sessionId, errMsg)
      return
    }
    // 阶梯 3 / 终点 C：真冻结（双信号同时成立：探测无响应 + 静默超保守窗）→ 直达强杀。
    // 这是旧「abort 超时即杀」行为的收窄保留——对真冻结仍及时生效（探测 10s + 判定即杀）。
    // D5①（session-dead-structural-fixes）：K2 结构化 kill 日志——exit 143 类进程死亡可从
    // kill_source/who 回溯到发起方；[U2] who 按 abort 的 source 区分，收敛环 re-abort
    // （convergence）不得在 kill 日志里冒充用户 abort。
    const abortWho = source === 'convergence' ? 'convergence re-abort (runtime auto)' : 'user abort'
    console.warn(`[message-dispatcher] abort RPC timed out and pi frozen (probe unresponsive + event stream silent ${silentForSec}s > window ${Math.round(silenceMs / MS_PER_SECOND)}s), force-destroying session ${sessionId} (kill_source=abort_timeout | who: ${abortWho} | chain: forceQuitSession -> detach -> SIGTERM destroy -> persist stopped -> occupancy reset -> session.exited)`)
    // D4 置位分型 K2：abort 无响应的冻结强杀收口 = 「用户要停」链路末端，置 userStopped 标记。
    await this.deps.forceQuitSession(
      sessionId,
      `Abort failed (pi frozen: probe unresponsive + event stream silent ${silentForSec}s): ${errMsg}`,
      'pi 无响应且事件流静默超窗（判定冻结），进程已强制终止。重发消息即可恢复（自动重启进程，历史完整）',
      'abort_timeout',
    )
  }

  /**
   * 快超时活性探测（三信号之一）：getState 是毫秒级内存快照 RPC，RpcClient 侧已配
   * FAST_TIMEOUT_MS（10s）快超时——pi 忙于 turn 时 RPC 事件循环仍应答；真冻结时超时无响应。
   * 复用既有方法（设计 D3：该面无名为 ping 的方法，不新造）。resolve = true；任何 reject
   * （超时 / 进程退出 / 传输错误）= false——后两者与冻结同向（无应答能力），归并处理安全。
   */
  private async probeEngineAlive(client: IPiEngine): Promise<boolean> {
    try {
      await client.getState()
      return true
    } catch {
      return false
    }
  }

  /**
   * 阶梯 2 通知（pi 活但 abort 落不了地）：经既有 session 级广播通道发布用户可见状态 +
   * 显式动作请求 + 后果说明。
   *
   * 广播消息形态（GUI 消费面本期不改——runtime 只发状态，动作出口复用既有 RPC）：
   * - 通道：messageBus.publish(sessionId, msg)——session 级定向推送（与 session.exited 同
   *   通道，订阅该 sid 的前端全收）。
   * - type：复用 'message.error'（进聊天流错误气泡，renderer 既有消费面零改动）。不新造
   *   wire type——ServerMessageType 登记在 shared（W7 领地不动 shared）；GUI 结构化消费面
   *   落地时再登记专属 'session.abortStalled' 帧（含 probe/eventWindow/abortRetries 诊断
   *   字段），届时本方法改发新帧即可。
   * - payload：{ sessionId, message }——文案三要素：现象（无法响应停止请求）+ 显式动作
   *   出口（侧边栏右键「强制退出」= 既有 session.forceQuit RPC）+ 后果（历史完整，重开可恢复）。
   */
  private publishAbortStalledNotice(sessionId: string, errMsg: string): void {
    const stallMsg = {
      type: 'message.error' as const,
      payload: {
        sessionId,
        message: `会话无法响应停止请求（${errMsg}）：pi 仍在运行，但停止请求迟迟未生效。可等待其自然结束；如需立即终止，请在侧边栏右键该会话选择「强制退出」——会话历史已保存，重新打开即可恢复。`,
      },
    }
    this.deps.publish(sessionId, stallMsg)
  }
}
