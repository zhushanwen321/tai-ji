// src/kill-chain.ts
//
// pi 进程杀链：SIGCONT → SIGTERM → grace → SIGKILL 阶梯（grace 可参）。
//
// 来源（行为逐字等价提取，非重写）：runtime rpc-client.ts RpcClient.kill()
// （D3a integrity-hardening：SIGCONT 唤醒可能被 SIGSTOP 冻结的进程，否则 SIGTERM
// 被冻结状态吞掉、只能等 grace 后 SIGKILL，丢失优雅退出路径）。
//
// 与 @zhushanwen/subagent-engine-sdk killChain 的关系（README「刻意不统一清单」）：
// SDK 版是引擎中立层（SIGTERM → grace → SIGKILL + 有界收尸 + terminated/killed
// 判别返回值，zcode 消费）；本版是 pi 进程杀链单源（SIGCONT 前置 + grace 内 exit
// 即收 + 不等 SIGKILL 收尸的 promise settle 语义）——U1 归并后 runtime rpc-client
// 与 pi-subagent-cli（spawn-runner killChild / active-children dispose 收割）双侧
// 消费。zcode 引擎继续走 SDK killChain，不经本包（app-server 是另一协议）。

/** SIGKILL 升级前的优雅退出窗口缺省值（ms）。 */
export const DEFAULT_PI_KILL_GRACE_MS = 2_000

/** 可杀子进程的结构形状（Node ChildProcess 的结构子集；测试可注入 fake）。 */
export interface KillableChild {
  /**
   * 已退判别（可选——Node ChildProcess 恒有，自造 fake 可省略）。任一非 null
   * 即已退出：杀链前置短路零信号（K2 语义：对已回收进程 kill 是幂等 no-op，
   * 不发信号、不抛、可重复）。
   */
  exitCode?: number | null
  /** 被信号杀死判别（与 exitCode 互备，见 exitCode 注释）。 */
  signalCode?: string | null
  /** 进程 pid（safeKill 抛错留痕；真实 ChildProcess 恒有，自造 fake 可省略）。 */
  readonly pid?: number
  /** 发信号。返回 false = 进程已不存在（kill no-op）。 */
  kill(signal?: NodeJS.Signals | number): boolean
  /** 注册 exit 监听（与迁移前 RpcClient.kill 的 proc.on('exit') 同形；重复触发由 settled 幂等守卫）。 */
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/** 已退判别（exitCode / signalCode 任一非 null；无字段的 fake 视为存活）。 */
function isAlreadyExited(child: KillableChild): boolean {
  return (child.exitCode !== undefined && child.exitCode !== null)
    || (child.signalCode !== undefined && child.signalCode !== null)
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
 * 进程存活守卫：runtime 侧调用方（RpcClient.kill 的幂等短路）+ 本函数前置
 * exitCode/signalCode 短路双层——后者是 U1 归并引入（pi-subagent-cli 的
 * killChild/killAllActiveChildren 调用点无调用方守卫，agent_end 回补 finally
 * 的 kill 常落在已回收进程上，前置短路保「零信号」语义）。
 *
 * kill 抛错守卫：三处 kill 均经 safeKill 吞错（对齐 SDK killChain 的 safeKill
 * 单源语义）——进程恰在退出态检查与 kill 之间自退时 ChildProcess.kill 可能抛
 * （zsub 实测经验），且本包消费方 killChild/killAllActiveChildren 是 void
 * fire-and-forget 无 .catch：同步抛经 executor 变 rejection 即 unhandled
 * rejection；SIGKILL 在 setTimeout 回调内抛出更是直接 uncaughtException（.catch
 * 结构性无法覆盖）→ runtime graceful shutdown + 全 session 中断。kill 失败是
 * 尽力而为语义（对已死进程信号本就是 no-op），warn 留痕后吞掉。
 */
/**
 * 发信号守卫包裹（单点收口，对齐 SDK killChain safeKill 同名语义）：kill 抛错吞掉
 * + warn 留痕。日志走本包既有 console 约定（无 logger 依赖，spawn-args/onEscalate
 * 同款 '[rpc]' 前缀）；收口在本函数而非逐调用点 .catch 的理由见 killPiProcess
 * docstring——SIGKILL 位在 setTimeout 回调内，调用方 .catch 结构性无法覆盖。
 */
function safeKill(child: KillableChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch (err) {
    // 降级策略（best-effort）：kill 抛错 = 进程恰在退出态检查与发信号之间自退，
    // 对已死进程信号本就是 no-op——刻意吞掉不阻断杀链（本函数存在的唯一目的），
    // warn 留痕（pid/信号/错误）供排障，不向调用方传播。
    console.warn(
      `[rpc] ${signal} on exited/invalid process (pid: ${child.pid ?? 'unknown'}) failed (kill is best-effort): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

export function killPiProcess(
  child: KillableChild,
  opts?: {
    graceMs?: number
    /**
     * grace timer unref（缺省 false = ref'd，与 runtime rpc-client.kill 迁移前一致）。
     * pi-subagent-cli 传 true：dispose 收割路径的 fire-and-forget 杀链不得用 ref'd
     * timer 挂住引擎进程退出（grace 窗口内进程应能自然退出，收尾交 exit handler）。
     */
    unrefTimers?: boolean
    /** grace 内 exit 的收尾钩子（调用方 rejectAll pending 等）。 */
    onExit?: () => void
    /** SIGKILL 升级时的 warn 载体（如 () => console.warn('[rpc] SIGKILL after timeout')）。 */
    onEscalate?: () => void
  },
): Promise<void> {
  const graceMs = opts?.graceMs ?? DEFAULT_PI_KILL_GRACE_MS
  if (isAlreadyExited(child)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false

    const done = () => {
      if (!settled) { settled = true; resolve() }
    }

    const killTimer = setTimeout(() => {
      opts?.onEscalate?.()
      safeKill(child, 'SIGKILL')
      done()
    }, graceMs)
    if (opts?.unrefTimers === true) killTimer.unref()

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
    safeKill(child, 'SIGCONT')
    safeKill(child, 'SIGTERM')
  })
}
