import type { SchedulerBackend } from '../backend.js'
import { replayFoldEntries, type SchedulerEntryLike } from '../replay.js'
import type { ScheduledTask, SchedulerEntryOp } from '../types.js'

// 测试专用 mock（ext-simplify-08 L9：从 backend.ts 迁出——导出面即测试面的收敛，
// 生产模块不再携带测试脚手架；MockSchedulerBackend/SentMessage 零生产引用）。

export interface SentMessage {
  msg: { content: string; customType: string; display: boolean }
  opts?: { deliverAs?: 'steer'; triggerTurn?: boolean }
}

/**
 * Mock 后端：零 session/FS 副作用，记录 sendMessage/appendEntry 调用，支持注入固定时间与 fake entries。
 *
 * 能力：
 * - sentMessages: 每次 sendMessage 的 {msg, opts} 记录
 * - appendedOps: 每次 appendEntry 收到的 SchedulerEntryOp（测 runtime 各 op 断言）
 * - fakeEntries / fakeSessionFile: loadTasks 经 replayFoldEntries 的注入源（测 backend→replay 委托）
 * - nowValue: now() 返回固定值，缺省 Date.now()
 * - appendError: 注入后 appendEntry 抛该错（测 ER-APPEND-FAIL 捕获路径）
 */
export class MockSchedulerBackend implements SchedulerBackend {
  sentMessages: SentMessage[] = []
  appendedOps: SchedulerEntryOp[] = []
  fakeEntries: SchedulerEntryLike[] = []
  fakeSessionFile: string | undefined = '/test/session.json'
  nowValue: number | undefined
  appendError: Error | null = null

  async sendMessage(
    msg: { content: string; customType: string; display: boolean },
    opts?: { deliverAs?: 'steer'; triggerTurn?: boolean },
  ): Promise<void> {
    this.sentMessages.push({ msg, opts })
  }

  appendEntry(op: SchedulerEntryOp): void {
    if (this.appendError) throw this.appendError
    this.appendedOps.push(op)
  }

  getSessionFile(): string | undefined {
    return this.fakeSessionFile
  }

  now(): number {
    return this.nowValue ?? Date.now()
  }

  /**
   * 读路径（非接口成员，与 PiSchedulerBackend.loadTasks 对称）：经 replayFoldEntries 折叠
   * fakeEntries + fakeSessionFile 恢复任务。测试用它验证 backend→replay 委托（TC-W-BACKEND-REPLAY）。
   */
  loadTasks(): ScheduledTask[] {
    return [...replayFoldEntries(this.fakeEntries, this.fakeSessionFile).values()]
  }
}
