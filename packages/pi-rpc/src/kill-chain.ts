// src/kill-chain.ts
//
// pi 进程杀链：SIGKILL 直杀 + 立即 resolve（exit 收尾钩子异步执行）。
//
// 来源（行为提取自 runtime rpc-client.ts RpcClient.kill()）。原形态为
// SIGCONT → SIGTERM → grace 等待 → SIGKILL 阶梯（D3a integrity-hardening）；
// grace 优雅退出等待窗经 ADR-0122 防御机制清查退役（2026-10-05 用户裁决，
// 推翻 crash-forensics 附录 E「回收层统一有界兜底」对 kill 族 grace 的背书）：
// SIGTERM 优雅退出窗口删除后 SIGCONT/SIGTERM 成死信号，杀链收敛为 SIGKILL 直杀。
//
// 与 @zhushanwen/subagent-engine-sdk killChain 的关系（README「刻意不统一清单」）：
// SDK 版是引擎中立层（SIGTERM → grace → SIGKILL + 有界收尸 + terminated/killed
// 判别返回值，zcode 消费）；本版是 pi 进程杀链单源（SIGKILL 直杀 + 不等收尸的
// promise settle 语义）——U1 归并后 runtime rpc-client 与 pi-subagent-cli
// （spawn-runner killChild / active-children dispose 收割）双侧消费。
// zcode 引擎继续走 SDK killChain，不经本包（app-server 是另一协议）。

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
  /** 注册 exit 监听（onExit 收尾钩子载体；重复触发由 settled 幂等守卫）。 */
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/** 已退判别（exitCode / signalCode 任一非 null；无字段的 fake 视为存活）。 */
function isAlreadyExited(child: KillableChild): boolean {
  return (child.exitCode !== undefined && child.exitCode !== null)
    || (child.signalCode !== undefined && child.signalCode !== null)
}

/**
 * pi 进程杀链（SIGKILL 直杀，无等待窗）。
 *
 * 时序：
 *   1. 前置 exitCode/signalCode 短路（已回收进程 kill 是幂等 no-op）；
 *   2. SIGKILL 直杀 → promise resolve（不等收尸——exit handler 由进程生命周期
 *      接手，信号已发出即承诺兑现）；
 *   3. exit 事件到达时执行 onExit 收尾钩子（调用方清 pending 等）。
 *
 * 进程存活守卫：runtime 侧调用方（RpcClient.kill 的幂等短路）+ 本函数前置
 * exitCode/signalCode 短路双层——后者是 U1 归并引入（pi-subagent-cli 的
 * killChild/killAllActiveChildren 调用点无调用方守卫，agent_end 回补 finally
 * 的 kill 常落在已回收进程上，前置短路保「零信号」语义）。
 *
 * kill 抛错守卫：经 safeKill 吞错（对齐 SDK killChain 的 safeKill 单源语义）
 * ——进程恰在退出态检查与 kill 之间自退时 ChildProcess.kill 可能抛（zsub 实测
 * 经验），且本包消费方 killChild/killAllActiveChildren 是 void fire-and-forget
 * 无 .catch。kill 失败是尽力而为语义（对已死进程信号本就是 no-op），warn 留痕
 * 后吞掉。
 */
/**
 * 发信号守卫包裹（单点收口，对齐 SDK killChain safeKill 同名语义）：kill 抛错吞掉
 * + warn 留痕。日志走本包既有 console 约定（无 logger 依赖，spawn-args 同款
 * '[rpc]' 前缀）。
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
    /** exit 事件到达时的收尾钩子（调用方 rejectAll pending 等）。 */
    onExit?: () => void
  },
): Promise<void> {
  if (isAlreadyExited(child)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false

    const done = () => {
      if (!settled) { settled = true; resolve() }
    }

    child.on('exit', () => {
      opts?.onExit?.()
      done()
    })

    safeKill(child, 'SIGKILL')
    // 信号已发出即承诺兑现（原 grace 超时路径的 settle 语义）：resolve 不等真实
    // exit，exit 到达时 onExit 收尾钩子照常执行（幂等性由调用方保证）。
    done()
  })
}
