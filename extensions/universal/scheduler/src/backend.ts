import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { replayFoldEntries, type SchedulerEntryLike } from './replay.js'
import type { ScheduledTask, SchedulerEntryOp } from './types.js'

// ── SchedulerBackend 接口 ──

/**
 * 运行时协作后端抽象（依赖反转）。SchedulerRuntime 只依赖此接口：
 * 不触碰 session JSONL、不持有 pi。
 *
 * - sendMessage: 到期 dispatch 的消息注入（生产实现委托 pi.sendMessage）
 * - appendEntry: 按 op 写 pi-scheduler:task custom entry（event sourcing）。
 *   生产实现委托 pi.appendEntry（同步落盘）。失败必须被调用方 try-catch（ER-APPEND-FAIL：
 *   runtime 捕获后 logger.warn + 不 rethrow，内存态已更新，at-least-once 已知恶化窗口）
 * - getSessionFile: 当前 session JSONL 路径（addTask 构建 upsert op 的 ownerSessionFile 用；
 *   --no-session 模式返回 undefined，调用方 ?? '' 兜底）
 * - now: 时间源（测试可注入固定值）
 *
 * 读路径不在接口：loadTasks 由 PiSchedulerBackend 类方法承担（非接口成员），内部委托
 * replayFoldEntries（折叠当前 session 的 custom entries 恢复任务），index.ts 装配点调用后
 * 经 runtime.loadTasks(tasks) 注入。append-only 模型无需全量 persist——runtime 按 op 调
 * appendEntry，replay 重放恢复，故 persist/persistSync 已移除。
 *
 * sendMessage 的 msg 签名与 pi 的 CustomMessage 对齐（customType/display 必填）：
 * 调用方必须显式提供，PiSchedulerBackend 直接透传无需兜底默认值。
 *
 * delivery handle 不在本接口（ext-simplify-08 L2）：backend 自身不消费，曾以
 * setDeliveryHandle/getDeliveryHandle 中转给 runtime 属穿层传参——现由装配点经
 * SchedulerRuntime 构造器直传。
 */
export interface SchedulerBackend {
  sendMessage(
    msg: { content: string; customType: string; display: boolean },
    opts?: { deliverAs?: 'followUp'; triggerTurn?: boolean },
  ): Promise<void>
  appendEntry(op: SchedulerEntryOp): void
  getSessionFile(): string | undefined
  now(): number
}

/**
 * ctx.sessionManager 的最小可识别形状（duck-typed）。真实 ExtensionContext.sessionManager
 * 返回 pi 的 SessionManager（getEntries(): SessionEntry[]、getSessionFile(): string|undefined），
 * 结构兼容本接口。PiSchedulerBackend 只依赖这两个方法。
 */
export interface SchedulerBackendCtx {
  sessionManager: {
    getEntries(): SchedulerEntryLike[] | Iterable<SchedulerEntryLike>
    getSessionFile(): string | undefined
  }
}

// ── 生产实现 ──

/**
 * 生产后端：pi.appendEntry（写 custom entry 到 owner session JSONL）+ pi.sendMessage + Date.now()。
 *
 * 任务状态以 append-only event sourcing 持久化：runtime 各操作调 appendEntry 写 op，
 * session_start 时 loadTasks 经 replayFoldEntries 折叠历史 entries 恢复。不再持有 store 文件、
 * 不再全量 persist/persistSync。
 */
export class PiSchedulerBackend implements SchedulerBackend {
  private ctx: SchedulerBackendCtx
  private pi: Pick<ExtensionAPI, 'sendMessage' | 'appendEntry'>

  constructor(ctx: SchedulerBackendCtx, pi: Pick<ExtensionAPI, 'sendMessage' | 'appendEntry'>) {
    this.ctx = ctx
    this.pi = pi
  }

  /**
   * 读路径：折叠当前 session 的 pi-scheduler:task custom entries 恢复任务（非接口成员，
   * 由装配点 session_start 调用）。replayFoldEntries 内部含 fork owner 过滤与异常兜底。
   */
  loadTasks(): ScheduledTask[] {
    return [
      ...replayFoldEntries(this.ctx.sessionManager.getEntries(), this.ctx.sessionManager.getSessionFile()).values(),
    ]
  }

  async sendMessage(
    msg: { content: string; customType: string; display: boolean },
    opts?: { deliverAs?: 'followUp'; triggerTurn?: boolean },
  ): Promise<void> {
    await this.pi.sendMessage(msg, opts)
  }

  appendEntry(op: SchedulerEntryOp): void {
    this.pi.appendEntry('pi-scheduler:task', op)
  }

  getSessionFile(): string | undefined {
    return this.ctx.sessionManager.getSessionFile()
  }

  now(): number {
    return Date.now()
  }
}
