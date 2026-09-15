/**
 * AgentSettledDelayer — agent_settled 延迟注入协作对象（V7 验收基建）+ userStopped 收敛窗常量。
 *
 * [协作对象，T4 拆分] 从 event-interpreter.ts 按变化轴抽出：settlingDelayTimer 与 disposed
 * 短路标志两个可变态只服务「agent_settled 何时执行三件副作用」这一个时序决策，与 interpreter
 * 主编排无共享状态（解释见 event-interpreter.ts 头注「协作对象」节）。interpreter 构造时以
 * apply 回调装配（回调内执行三件副作用），本对象不持有 interpreter 主引用。
 *
 * 收敛窗常量（ABORT_STALL_CONVERGENCE_WINDOW_MS）随迁：readDevSettlingDelayMs 的上界约束
 * 引用它（避免 settled-delay → event-interpreter 反向 import 成环）；event-interpreter.ts
 * re-export 保住既有导出面，UserStoppedGate（留守主文件）从本文件 import。
 */
/**
 * 收敛静默窗初值（session-dead-structural-fixes D4：abort 完成起算，窗满且最后一次被掐
 * turn 的 agent_settled 已到达 → 判收敛清标记）。常量 export 供测试跟随（SR6 SSOT 惯例）；
 * 实施期按 P-1 探针实测标定（设计 §3.5：初值 3s，可调）。
 */
export const ABORT_STALL_CONVERGENCE_WINDOW_MS = 3_000

/**
 * [V7 验收基建，实施期裁决保留（设计 §4.2 开关保留策略已登记偏离默认理由）] dev-only 事件流延迟注入开关。
 *
 * 环境变量 XYZ_AGENT_DEV_SETTLING_DELAY_MS 设置为正数（毫秒）时生效：agent_settled 事件
 * 延迟 N ms 再处理，用于在 dev 环境拉长 settling 窗口，构造 D2 行为变更（settling 预检
 * 拒绝入队）的正向验收场景（V7）。真实链路定性（设计 v3）：pi 与 provider 交互完全真实，
 * 本注入是时间维度的 chaos 延迟手法，非 mock、不替换任何依赖。
 *
 * [与 D4 收敛窗的耦合约束（定向复审缺陷 1）] 上界 = ABORT_STALL_CONVERGENCE_WINDOW_MS：
 * delay 达到收敛静默窗量级时，restore-abort 受害 turn 的 agent_settled 会被推迟到窗满
 * 之后——该 turn 不经 noteAgentStart（主 abort 受害），pendingSettled=false 下
 * onWindowElapsed 会在 settled 未到时误判收敛清标记（设计 v4 ③「掐而 settled 未到」
 * 边界缝被确定性重开）。故 delay ≥ 窗口值时拒绝生效（warn + 返回 null = 零行为差异），
 * 不做 clamp——clamp 会让实际延迟悄悄偏离设定值、V7 验收观测失真；拒绝则显式零差异
 * 且 warn 指路（调小 delay 或缩短验收构造）。
 *
 * 未设 / 非法值（非数字、≤0、≥ 上界）→ 返回 null = 零行为差异（不带默认值进 prod）。
 * 纯内存延迟不落盘。export 供测试跟随（SR6 SSOT 惯例）。
 */
export function readDevSettlingDelayMs(): number | null {
  const raw = process.env.XYZ_AGENT_DEV_SETTLING_DELAY_MS
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n >= ABORT_STALL_CONVERGENCE_WINDOW_MS) {
    console.warn(
      `[event-interpreter] XYZ_AGENT_DEV_SETTLING_DELAY_MS=${raw} rejected: delay must stay below ` +
      `ABORT_STALL_CONVERGENCE_WINDOW_MS(${ABORT_STALL_CONVERGENCE_WINDOW_MS}ms) or the delayed ` +
      `agent_settled lands past the restore-abort convergence window and breaks its settled-based ` +
      `convergence judgment (design v4 boundary seam). Lower the delay.`,
    )
    return null
  }
  return n
}

/**
 * agent_settled 延迟注入器（V7）+ 会话销毁短路（定向复审缺陷 2）。
 *
 * handleSettled() 编排（interpreter agent-settled 挂点委托，原 handleAgentSettled 逐字迁移）：
 * dev-only 开关生效时整体延迟 apply 执行。注入点时点约束（设计 v4）：延迟必须作用于
 * settling→idle 转移处理**之前**——若落在转移后仅延迟广播，settling 窗口构造会静默失败且
 * 难与「注入无效」区分，故延迟包住全部副作用（含转移）。未设开关 = 直通零开销。
 *
 * 受控 timer 异步延迟：interpret 循环对后续事件照常同步处理，不阻塞事件流。延迟窗口内
 * 重复 agent_settled（物理上极窄：pi 单 run 结束只发一次）→ 先同步 flush 前一个再排新
 * timer——顺序保持、事件不丢（apply 各副作用均幂等，flush 乱序无害）。
 *
 * dispose()（interpreter dispose 委托）：清在途延迟 timer + 置 disposed 短路标志。幂等。
 * 仅 V7 开关生效时存在真实 settling timer；未设开关时该 timer 恒 null（零开销）。
 *
 * B1 关联（memory-leak-remediation §3.2-B1，2026-09-14）：interpreter.dispose() 会在 pi
 * turn 中崩溃（detach 后事件源退订、turn-end 永不再达）时被组合根调用，本对象的在途
 * timer 必须在该时点清理——防销毁后在途延迟 timer 打在「同 id restore 重注册的新
 * session 记录」上（幽灵 idle 写 + 幽灵置闲）。disposed 短路标志覆盖同步路径：置位后
 * 本实例的全部 agent_settled 副作用短路。其他 interpret 路径不需此标志：detach 已
 * unsub 事件源，唯一残留副作用源就是本 timer。
 */
export class AgentSettledDelayer {
  /** [V7 验收基建] agent_settled 延迟注入的 pending timer（null = 无延迟在途）。仅 dev-only 开关生效时非 null；未设开关时恒 null 零开销。 */
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 会话销毁标志：dispose() 置位后 run() 短路（缺陷 2 防御深度，覆盖延迟到点与同步直通两路）。 */
  private disposed = false

  constructor(private readonly apply: () => void) {}

  handleSettled(): void {
    const delayMs = readDevSettlingDelayMs()
    if (delayMs === null) {
      this.run()
      return
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
      this.run()
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.run()
    }, delayMs)
  }

  /** 会话销毁清理：置 disposed 短路标志 + 清在途延迟 timer。幂等。 */
  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 副作用执行入口（销毁短路唯一守卫点）。 */
  private run(): void {
    // [定向复审缺陷 2] 销毁短路：interpreter 已随 adapter detach 而废弃（同 id restore 会
    // 重注册新实例），在途延迟 timer 到点的幽灵副作用（idle 行无条件写 + fanOutSettled
    // 置闲）必须拦在本实例入口——session 记录/收敛环都无从辨别「旧实例的迟到帧」。
    if (this.disposed) return
    this.apply()
  }
}
