// src/kill-chain.ts
//
// pi 进程杀链：SIGCONT → SIGTERM → grace → SIGKILL 阶梯（grace 可参）。
//
// 来源（行为逐字等价提取，非重写）：runtime rpc-client.ts RpcClient.kill()
// （D3a integrity-hardening：SIGCONT 唤醒可能被 SIGSTOP 冻结的进程，否则 SIGTERM
// 被冻结状态吞掉、只能等 grace 后 SIGKILL，丢失优雅退出路径）。
//
// 与 @zhushanwen/subagent-engine-sdk killChain 的关系（刻意不统一，README 登记）：
// SDK 版是引擎中立层（SIGTERM → grace → SIGKILL，无 SIGCONT，pi/zcode 共用）；
// 本版是 pi 主链路专属（SIGCONT 前置 + grace 内 exit 即收 + 不等 SIGKILL 收尸的
// promise settle 语义）。pi-subagent-cli 侧 spawn-runner 走 SDK killChain（引擎
// 中立面），两侧杀链完整收敛超出本包单元领地。

/** SIGKILL 升级前的优雅退出窗口缺省值（ms）。 */
export const DEFAULT_PI_KILL_GRACE_MS = 2_000

/** 可杀子进程的结构形状（Node ChildProcess 的结构子集；测试可注入 fake）。 */
export interface KillableChild {
  /** 发信号。返回 false = 进程已不存在（kill no-op）。 */
  kill(signal?: NodeJS.Signals | number): boolean
  /** 注册 exit 监听（与迁移前 RpcClient.kill 的 proc.on('exit') 同形；重复触发由 settled 幂等守卫）。 */
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/**
 * pi 进程杀链（grace 可参，缺省 2s）。
 *
 * 时序（与 runtime RpcClient.kill() 提取前逐字一致）：
 *   1. 立即 SIGCONT（唤醒 SIGSTOP 冻结形态；对运行中进程无副作用，对已退出进程
 *      返回 false 不抛错）+ SIGTERM；
 *   2. grace 窗口内 exit → onExit 回调（调用方清 pending 等收尾）→ resolve；
 *   3. grace 超时 → onEscalate（warn 留痕）+ SIGKILL → resolve（不等收尸——
 *      exit handler 由进程生命周期接手，信号已发出即承诺兑现）。
 *
 * 进程存活守卫（!proc || exited）归调用方（RpcClient.kill 的幂等短路），本函数
 * 对已退进程发信号按 ChildProcess.kill 语义 no-op。
 */
export function killPiProcess(
  child: KillableChild,
  opts?: {
    graceMs?: number
    /** grace 内 exit 的收尾钩子（调用方 rejectAll pending 等）。 */
    onExit?: () => void
    /** SIGKILL 升级时的 warn 载体（如 () => console.warn('[rpc] SIGKILL after timeout')）。 */
    onEscalate?: () => void
  },
): Promise<void> {
  const graceMs = opts?.graceMs ?? DEFAULT_PI_KILL_GRACE_MS
  return new Promise<void>((resolve) => {
    let settled = false

    const done = () => {
      if (!settled) { settled = true; resolve() }
    }

    const killTimer = setTimeout(() => {
      opts?.onEscalate?.()
      child.kill('SIGKILL')
      done()
    }, graceMs)

    child.on('exit', () => {
      clearTimeout(killTimer)
      // Safety net: clean up pending requests not rejected by the unexpected-exit
      // handler (killing flag 跳过了它)，so callers don't await their own timeout.
      opts?.onExit?.()
      done()
    })

    // D3a：SIGTERM 前先 SIGCONT——唤醒可能被 SIGSTOP 冻结的进程（事件循环卡死的
    // 一种形态），否则 SIGTERM 会被冻结状态吞掉、只能等 grace 后 SIGKILL，丢失
    // 优雅退出路径（扩展落盘等 exit handler）的执行机会。
    child.kill('SIGCONT')
    child.kill('SIGTERM')
  })
}
