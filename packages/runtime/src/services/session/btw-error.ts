/**
 * btw 域错误词汇表（BtwError / BtwErrorCode，M2-b 按 code 映射恢复指引）。
 *
 * 独立成模块的原因（max-lines 同目录内聚拆分，2026-09-22）：fork 执行腿
 *（btw-fork-exec.ts）与服务本体（btw-service.ts）都要抛错——落第三个 sibling 模块
 * 可让二者互不 import、整体保持无环（service → fork-exec → error 单向）。
 * btw-service 保持原样 re-export（导出面零变更），transport/测试的
 * `from '.../btw-service.js'` 消费路径零改动。
 */

/** btw 域错误码（M2-b 恢复指引映射的词汇表；error envelope 按 code 分流恢复文案）。 */
export type BtwErrorCode = 'fork_failed' | 'spawn_state_invalid' | 'state_mismatch' | 'line_not_found' | 'thread_file_missing'

export class BtwError extends Error {
  constructor(readonly code: BtwErrorCode, message: string) {
    super(message)
    this.name = 'BtwError'
  }
}
