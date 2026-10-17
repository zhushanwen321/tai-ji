// src/types.ts
//
// @zhushanwen/pi-delivery-port 契约面（设计 .tmp/tech-design/unified-delivery.md
// §3.7 pi 半区组件表 / §3.4 提交选项缺省值表）。
//
// 本包是「知 pi 又知内核」的适配层：把 pi 扩展运行时
// 端口接线成 @zhushanwen/session-delivery v3 内核的 port 半区——custom 车道唯一
// 执行者（outbox 投递日志 / details-id 送达凭据 / session_start 差集重放 / 提交侧
// 合批与批组隔离 / compaction 等待）。消费方（notifier / session-manager / bash）
// 经 Symbol.for 进程级槽 getDeliveryPort() 获取实例（C-ext-06 惯例）。包依赖分层：
// extensions 层消费方与本包同层直依（package.json dependencies）；packages 层
// subagent-core 受 D9 闭包红线禁 import，经宿主壳注入槽访问器。
//
// pi 词汇边界：本文件 timing 的 "steer"/"followUp" 与 host.sendMessage 的
// deliverAs 是 pi 注入通道词汇，合法持有点 = 本包（pi 半区适配层，ADR-0126 清单
// 的 extensions 侧同位形态）；内核包零 pi 词汇的纪律由 session-delivery 自守。

import type { CustomPayload, DeliveryFailurePolicy } from "@zhushanwen/session-delivery";

// ─── envelope ───────────────────────────────────────────────

/**
 * 期望注入时机（envelope 声明档，设计 §3.3 timing 词条）：steer = 下一个轮边界；
 * followUp = run 将停处。缺省 steer（用户裁决 2026-10-16）。与内核包内零 pi 词汇
 * 的 DeliveryIntent 的翻译在本包内完成（interrupt-at-turn-boundary ↔ steer /
 * after-run ↔ followUp）。
 */
export type DeliveryTiming = "steer" | "followUp";

/**
 * 投递信封（进程内 custom 车道）：text 载荷属 runtime 半区端点，不出现在本端口面。
 *
 * to 字段刻意缺席：port 每 session 装配一份（session_start 重绑），投递目标恒为
 * 当前 session——进程内端口无跨 session 寻址语义（跨会话互投是设计 §9 非目标）。
 */
export interface DeliveryEnvelope { // oe-exempt:20261017:framework:统一投递对外 API 契约（唯一提交入口载荷形态）
  /** custom 载荷（原样透传；deliveryId 由本端口在注入前统一写入 details）。 */
  payload: CustomPayload;
  /** 期望注入时机。缺省 "steer"。 */
  timing?: DeliveryTiming;
  /** 幂等键（提交方提供即参与判重：notifyId / taskId 等）。缺省内部生成。 */
  id?: string;
  /**
   * port 端点暂不透传 meta（通知域无消费方）；承载随 phase 2 collect 立项实装——
   * 内核 msg.meta 透传链已就绪（persistRecord / callOnSettled）。
   */
  meta?: Record<string, unknown>;
}

/** deliver 提交选项（缺省值表 §3.4：通知域 = steer + retain + 合批 + details-id）。 */
export interface DeliveryDeliverOptions { // oe-exempt:20261017:framework:统一投递对外 API 契约（deliver 提交选项面）
  /**
   * 合批窗口判定覆盖。缺省 = 「默认通道（subagent-bg-notify）且宿主有活跃后台任务」
   * 时进 60s 滑动窗口攒批；外部通道（workflow-result / managed-session-notify 等）
   * 恒逐条（批组隔离 [u9] 规则，merge:true 不得覆盖——窗口合批形态 {batch,items}
   * 对外部通道无消费契约）。显式 merge:false 可让默认通道条目跳过窗口立即提交。
   */
  merge?: boolean;
  /**
   * 失败保留策略（内核首败处置）。缺省 "retain"（留账：下一边沿 / compaction 唤醒 /
   * session_start 重放重投——通知域无人值守语义）；显式 "forget" = 首败即弃（discard
   * 持久标记，重启不复活）。重放重建的条目不携带本选项（按缺省 retain 重投）：
   * forget 条目首败即落终局列、不在重放差集，仅「首败前崩溃」的残留条目按 retain
   * 重投（通知域安全侧——多留账不丢不重）。
   */
  onFailure?: DeliveryFailurePolicy;
}

/**
 * deliver 受理结果（与内核 DeliverySendResult 三分口径同构）：
 * accepted = 已受理（缓冲或已入内核）；swallowed = 幂等吞；rejected = 拒收未受理
 * （persist-failed = 受理前落盘失败等）。rejected 条目可重试（幂等键未登记）。
 */
export type DeliveryDeliverResult =
  | { kind: "accepted"; id: string }
  | { kind: "swallowed"; reason: "already-seen" | "duplicate-content" }
  | { kind: "rejected"; reason: string };

// ─── 诊断 ───────────────────────────────────────────────────

/**
 * 分桶计数（设计 §3.7 诊断行；账本 NotifyDeliveryBucketMetrics 泛化，桶口径对齐）：
 * settleRejected = 注入调用被拒（sendMessage throw）次数；recoveryReplays =
 * session_start 恢复重放条数。增量同时经 host.logger 落日志（限流面归 logger）。
 */
export interface DeliveryPortMetrics { // oe-exempt:20261017:framework:分桶诊断契约（extensionLogger 消费面）
  settleRejected: number;
  recoveryReplays: number;
}

// ─── host 端口（装配点接线面）───────────────────────────────

/** host logger 最小面（@zhushanwen/pi-extension-logger 的 ExtensionLogger 结构性满足）。 */
export interface DeliveryPortLogger { // oe-exempt:20261017:framework:日志注入契约（宿主提供实现）
  warn(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
}

/**
 * port 宿主最小端口面（session_start 装配点经 createPiDeliveryPortHost 接线；
 * 接口化解耦便于测试，内核/端口本体零 pi import）。
 *
 * 订阅面全部返回退订函数（pi 1.0.0 起 on 返回 unsubscribe；port dispose 时兑现，
 * 防 session_start 重绑累积死 handler）。
 */
export interface DeliveryPortHost { // oe-exempt:20261017:framework:pi 能力注入契约（sendMessage/appendEntry/on 事件宿主面）
  /** 写 plain custom entry（outbox / ack 通道；pi.appendEntry——不进 LLM 上下文）。 */
  appendEntry(customType: string, data: unknown): void;
  /** 读当前 session 全部 entry（回执扫描 / 重放扫描；ctx.sessionManager.getEntries()）。 */
  readSessionEntries(): readonly unknown[];
  /**
   * 主 agent 是否空闲（ctx.isIdle()——含 run 活跃与 compaction 两态）。仅作内核
   * port.isIdle 供给（内核接口必填成员；on-accept 模式内核 busy gate 旁路，恒不
   * 消费）。提交侧挂起判定不用本端口——compaction 等待由 compaction 事件标记承载
   * （见 onSessionBeforeCompact），run 活跃必须放行（sendMessage 入 pi steer 队列
   * 不拒），isIdle 的复合语义不能承载该区分。
   */
  isIdle(): boolean;
  /**
   * 单通道注入直达唯一队列（pi.sendMessage；两档出队由 pi 原生 steer/followUp
   * 队列承载，本端口零时机代码）。注入类失败（stale / assertActive 等）不在此
   * 吞咽——同步 throw 原样上抛，由端口走 retain 处置。
   */
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { deliverAs: DeliveryTiming; triggerTurn: true },
  ): void;
  /** 送达凭据事件边沿订阅（pi.on("message_end")——事件 message 携带注入的 custom
   *  消息本体，details.deliveryId 命中判定的事实源）。 */
  onMessageEnd(handler: (message: unknown) => void): () => void;
  /** settled 边沿订阅（内核 subscribeSettled 接线——retain 留守条目的重投触发）。 */
  onAgentSettled(handler: () => void): () => void;
  /** compaction 开始前边沿（session_before_compact——manual/threshold/overflow 全
   *  trigger 覆盖）：提交侧挂起标记置位（compaction 期间 sendMessage triggerTurn
   *  分支会与 compaction 并发起新 run，须挂起）。 */
  onSessionBeforeCompact(handler: () => void): () => void;
  /** compaction 成功边沿（挂起标记复位 + 等待中的条目唤醒重投）。 */
  onSessionCompact(handler: () => void): () => void;
  /** compaction 失败/中止边沿（标记同样复位 + 唤醒——失败也要重投尝试，失败可见性归日志）。 */
  onSessionCompactFailed(handler: () => void): () => void;
  /** 攒批条件谓词（有活跃后台任务；账本 mergeHoldActive = hasRunningBackground 同源）。 */
  hasRunningBackground(): boolean;
  /** 分桶诊断与降级 warn 出口（extensionLogger——落 session JSONL 不进 LLM +
   *  TAIJI_AGENT_DEBUG 落日志盘）。 */
  logger: DeliveryPortLogger;
}

// ─── handle（进程级槽暴露面）────────────────────────────────

/**
 * 投递端口句柄（custom 车道唯一执行者的对外形态）。
 * 同 session 必须单例（session_start 重绑 = 旧实例 dispose + 新实例 recover）。
 */
export interface DeliveryPortHandle { // oe-exempt:20261017:framework:进程级槽交付的端口句柄契约（消费方读槽面）
  /**
   * 唯一提交入口（§3.4 端点形态）：受理前 appendEntry 落投递日志 → 缓冲（攒批路径）
   * 或内核 send（直通路径）→ 受理结果同步返回。fire-and-forget 语义：调用方忽略
   * 返回值不受影响；rejected 条目由调用方裁决重试（幂等键未登记，重提合法）。
   */
  deliver(envelope: DeliveryEnvelope, opts?: DeliveryDeliverOptions): DeliveryDeliverResult;
  /**
   * session_start 差集重放：扫投递日志 −
   * （对话记录已送达 ∪ ack）差集 → 重入队 → 立即尝试投递。重放条目若满足攒批
   * 条件经窗口合并投出（合并形态与直通路径一致）。幂等：可
   * 重复调用，差集为空零动作。
   *
   * @returns 重放条数。
   */
  recover(): number;
  /** 分桶计数快照（副本）。 */
  metrics(): DeliveryPortMetrics;
  /** 强制投递尝试（窗口缓冲提前出站 + 内核 flush——外部重触发口）。 */
  flush(): void;
  /** 销毁：清窗口 timer + 内核 dispose + 退订全部事件订阅 + 摘进程级槽绑定。 */
  dispose(): void;
}
