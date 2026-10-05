/**
 * endAndAwaitStream——写流 end + 等待真正关闭的共享原语（u9/logger 与 u1b/crash-journal
 * 的单一实现；impl-plan §5 偏差 #32①：两处模块私有复刻的控制流逐行同构，属假差异，
 * 收敛为本模块；超时报告出口保持注入——两消费方各有自己的留痕通道，本模块不做 IO）。
 *
 * 形态契约（照搬 logger.ts 审查结论，勿改顺序）：
 * - **end 后必须等待 'close'**（'close' = fd 释放、缓冲 flush 完成）：process.exit() 立即
 *   终止进程、rename 前必须有「无在途写」保证——都要求等待落盘完成，否则缓冲窗口内的
 *   尾部日志在退出时丢失 / 轮转边界在途写被 orphaning（审查 m-6）。
 * - **永不 reject**（best-effort）：'error' 也 resolve，避免日志类设施阻塞进程退出。
 * - **超时降级**（审查 W30 Fix-1）：fs 挂起时 'close' 永不触发，等待
 *   END_AWAIT_TIMEOUT_MS 后 resolve 并**强制销毁流**（destroy 释放 fd、丢弃在途缓冲）
 *   ——调用方（轮转续体 / shutdown 序）不会永久挂起。代价：超时销毁丢弃在途缓冲尾部
 *   几行，由注入的 reportTimeout 出口留痕（非静默降级）。
 * - **once 链清理**（审查 W30 Fix-9）：'close' 先触发时 'error' 监听器仍挂残留，完成后
 *   手动移除，避免悬挂监听器持有已关闭流的引用。
 */
import type { WriteStream } from 'node:fs'

/** 超时降级时的留痕出口（注入）：label 标识流归属（如 `pi-rotation:<file>`）。 */
export type EndAwaitTimeoutReporter = (label: string) => void

/**
 * end 一个写流并等待其真正关闭。rename 前必须无在途写；永不 reject。
 */
export function endAndAwaitStream(
  stream: WriteStream | undefined,
): Promise<void> {
  if (!stream) return Promise.resolve()
  if (stream.closed) return Promise.resolve() // 已关闭（含已 error 销毁的流）
  if (!stream.writableEnded) stream.end()
  if (stream.closed) return Promise.resolve() // 同步关闭路径（如测试用 fake 流）
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      // 清理 once 链（审查 W30 Fix-9）：'close' 先触发时 'error' 监听器仍挂残留，
      // 事件到达后手动移除，避免悬挂监听器持有已关闭流的引用。
      stream.removeListener('close', onClose)
      stream.removeListener('error', onError)
      {
        // 强制销毁（审查 W30 Fix-1）：不 destroy 则 fd 悬挂、「close」永不触发，
        // 后续轮转/退出若再 end 同一流仍会挂满一个超时窗口。无参 destroy 不 emit
      }
      resolve()
    }
    const onClose = () => finish()
    const onError = () => finish()
    stream.once('close', onClose)
    stream.once('error', onError)
  })
}
