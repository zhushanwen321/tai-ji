/**
 * worker stderr 崩溃取证采集器（[crash-resilience §3.3 D6-⑤]，u5b-runtime-forensics）。
 *
 * Worker Thread 无 pid 可 kill 也无独立 pid 文件，取证形态与 pi 子进程（rpc-client
 * stderrChunks）不同：stderr 以 chunk 流到达（Buffer，多字节字符可能被 chunk 边界切断），
 * 按 Buffer 累积、take 时才 concat+解码，避免按 chunk 解码的 UTF-8 截断。
 * 独立模块便于单测（累积 / 超限丢最旧 / truncated 标注 / take 后清空）。
 */

/**
 * worker stderr 崩溃取证缓冲的字节上限（D6-⑤）。对齐 rpc-client STDERR_CRASH_MAX_BYTES：
 * 常态全量累计（真实崩溃 stderr 仅几十行 KB 级），上限仅防御异常洪泛（崩溃循环打印），
 * 超限丢最旧并在 crash log 头部标注 truncated。
 */
export const WORKER_STDERR_MAX_BYTES = 1_000_000

/** take() 的返回：已累计 stderr 文本 + 是否发生过超限丢弃（crash log 头部标注用）。 */
export interface WorkerStderrSnapshot {
  text: string
  truncated: boolean
}

/**
 * 创建一个采集器：createWorker 挂接到 worker.stderr 流（`stderr: true` pipe 形态），
 * 崩溃时 handleWorkerCrash take 并落盘 plugin-crash-*.log。
 */
export function createWorkerStderrCollector(maxBytes: number = WORKER_STDERR_MAX_BYTES): {
  feed: (chunk: Buffer) => void
  take: () => WorkerStderrSnapshot
} {
  const chunks: Buffer[] = []
  let totalBytes = 0
  let truncated = false
  return {
    feed(chunk: Buffer): void {
      totalBytes += chunk.length
      chunks.push(chunk)
      // 超限丢最旧（对齐 rpc-client stderrChunks 语义：保住崩溃前最后时刻的输出）
      while (totalBytes > maxBytes && chunks.length > 1) {
        const dropped = chunks.shift()
        totalBytes -= dropped?.length ?? 0
        truncated = true
      }
      // 单 chunk 即超上限（理论极端）：整块丢弃防无界，标注 truncated
      if (totalBytes > maxBytes) {
        totalBytes = 0
        chunks.length = 0
        truncated = true
      }
    },
    take(): WorkerStderrSnapshot {
      const text = Buffer.concat(chunks).toString('utf8')
      chunks.length = 0
      totalBytes = 0
      const snapshot = { text, truncated }
      truncated = false
      return snapshot
    },
  }
}
