// src/execution/notify/notifier.ts
//
// Background 完成回注主对话（单条通知通道）。
//
// 职责：
//   - buildLlmContent：格式化通知文案（本文件唯一逻辑职责）
//   - createNotifier：薄工厂——ledger 装配时（bindNotifyLedgerHost 已注入）走
//     四步生命周期（写账 → courier 边沿投递 → 回执销账 → notifyId 幂等重放，
//     notify-ledger.ts）；未装配时退回投递内核路径（createDelivery 经通知域窄端口
//     NotifyDomainPorts 注入——core 依赖闭包不含 session-delivery，见 core/notify-ports.ts；
//     合并窗口 / 去重 / 退避 / flush 委托内核，旧装配 / 无 ledger 测试兼容）
//
// [collect 退役] 原 notifyBatch / buildBatchLlmContent / computeBatchBudget /
// buildBatchNotifyId（sync 批通知三件套 + 批幂等键）已随 collect 批机制整体删除。

// 投递通道（D5 单通道化）：ledger 路径经 courier 在 settled 边沿直达
// pi.sendMessage({triggerTurn:true})；内核路径的 port.send 同样只传
// {triggerTurn:true}——steer / followUp / nextTurn 通道已全部删除（nextTurn 的
// 唯一 drain 点在 session.prompt() 内，主 agent 长 streaming 场景下无限期滞留，
// 设计 D5 实测证伪）；busy 场景由 ledger（settled 边沿 + isIdle 二次复查）或内核
// settled 订阅驱动在空闲边沿投递。

import { getLogger } from "../../core/logger.ts";
import { getNotifyDomainPorts, type DeliveryHandle, type DeliveryPort } from "../../core/notify-ports.ts";

import { deriveOutcome } from "../persistence/execution-record.ts";
import { getBoundNotifyLedger, NOTIFY_CUSTOM_TYPE } from "./notify-ledger.ts";
import type { AbandonedRoundMark, ClosedReason, Epoch, ExecutionOutcome } from "../assembly/types.ts";

// ============================================================
// [T4① / PS-2 → U5 二元组] notify 门（H1 U2 自 subagent-service.ts 迁入——
// Continuation 成功/失败分支双闸共用；原位置 re-export 保持既有 import 路径不变）
// ============================================================

/**
 * notify 门的 record 状态入参（永久会话模型 §3.2.7 通知 gate 的判据源，
 * 全部从 ExecutionRecord 同名字段直传——调用点 `notifyGateAllowsDelivery(record)`）。
 */
export interface NotifyGateRecordState {
  /** record 当前世代（两步判定的比较基准——非标记槽 epoch，§3.2.7 显式两步）。 */
  readonly epoch?: Epoch;
  /** 放弃轮标记（gate 判据，单槽）：abort（cancel / 编排性关闭打断）时置在飞轮。 */
  readonly lastAbandonedRound?: AbandonedRoundMark | null;
  /** 当前轮次（gate 第二步的回注轮缺省源——settle 推进后的值，正常轮通知凭此
   *  越过旧标记；被中断轮不推进，迟到回注轮 ≤ 标记轮被丢弃）。 */
  readonly round?: number;
}

/**
 * notify 门的回注声明身份（迟到帧自带；缺省 = 读 record 自身——同世代、当前轮）。
 * 现有消费点的回注均从 record 投影（无独立世代/轮载体），缺省路径恒命中「同世代」，
 * 拦截由第二步标记判定承担；跨世代重复帧的最终防线 = notifyId（id:epoch:round）
 * 账本去重（reopen 前最后轮必已同步入账，晚到回注必为重复帧——设计 §3.2.7 论证）。
 */
export interface NotifyGateInbound {
  /** 回注声明世代（缺省 = record 当前 epoch，第一步恒同世代）。 */
  readonly epoch?: Epoch;
  /** 回注声明轮（缺省 = record.round ?? 0）。 */
  readonly round?: number;
}

/**
 * [U5 / §3.2.7 通知 gate] 轮次完成回注的投递门。
 *
 * 两个阻断维度承接旧 closedReason 集合门的事故防御（v4 A-6 僵尸回执 / cancelled
 * 防双发），判据源 = 「放弃标记」单维（收口/静默场景由放弃轮标记 + 轮身份守卫 +
 * notifyId 账本三层承接——原 intent=archived 静默 gate 随 intent 概念删除退役）：
 *
 *   ① 回注 epoch ≠ record 当前 epoch → 丢弃（跨世代回注）；
 *   ② 放弃轮标记命中 → 阻断（承接原 cancelled 阻断防双发）。**显式两步**（比较基准
 *      = record 当前 epoch，非标记槽 epoch——reopen 后标记残留旧 epoch，按标记槽比较
 *      会把新世代全部正常轮通知吞掉）：
 *        第一步：回注 epoch ≠ record 当前 epoch → 丢弃；
 *        第二步：同 epoch 时标记非空、标记槽世代 = 当前世代且回注轮 ≤ 标记轮 → 丢弃。
 *
 * 收口轮豁免（构造性）：close 挂起等待的最后一轮（closeAfterRound 消费）通知正常
 * 送达——close 不置放弃轮标记（标记只由 cancel/编排性关闭的 abort 置位），且收口
 * 落账编排挂在轮次通知送达之后（§3.2.5 顺序约束 [写死]），settle 时点 record 仍
 * running 非放弃轮，①②均不命中。收口后的残余迟到回注由轮身份守卫（Continuation
 * abortAndClearQueue 废弃轮身份）+ notifyId 账本去重承接。
 *
 * 正常轮通知不该被旧标记吞的论证（为何比较 record.round 而非标记槽）：正常轮 N settle
 * 后 round 已推进（markRoundIdle +1），回注轮 = record.round > 标记轮 → 放行，重复帧由
 * notifyId 去重兜底；只有「被显式放弃的轮」才进标记（stopReason 单值会被新轮覆盖，
 * 无法承载 per-round 终局）。
 *
 * 消费面：Continuation 成功/失败分支双闸 + drain 丢弃通知 + 泛化派发主干尾部
 *（one-shot 回注）+ watchdog 失败通知（run-orchestration）。
 */
export function notifyGateAllowsDelivery(
  state: NotifyGateRecordState,
  inbound: NotifyGateInbound = {},
): boolean {
  const currentEpoch = state.epoch ?? 0;
  // ① 第一步：跨世代回注丢弃（比较基准 = record 当前 epoch）。
  const inboundEpoch = inbound.epoch ?? currentEpoch;
  if (inboundEpoch !== currentEpoch) return false;
  // ② 第二步：标记槽在当前世代且回注轮 ≤ 标记轮 → 丢弃（防双发）。标记槽世代 ≠
  // 当前世代（reopen 残留）→ 标记自然失效，跨世代重复帧由 notifyId 去重承接。
  const mark = state.lastAbandonedRound;
  if (mark != null && mark.epoch === currentEpoch) {
    const inboundRound = inbound.round ?? state.round ?? 0;
    if (inboundRound <= mark.round) return false;
  }
  return true;
}

/** U4：delivery warn 出口注入用——facade 同 component 同引用，与 index.ts 的
 *  getLogger("subagents") 共享单例；configureCore 后透明切换到宿主实现。 */
const notifyLogger = getLogger("subagents");

/**
 * 一条待发送的完成通知记录。
 * SP-1: done/failed/crashed 合并为 closed + closedReason L2 子枚举。
 */
export interface BgNotifyRecord {
  id: string;
  /**
   * 完成状态。v4 B-1 两态收敛：closed（终态，含 cancelled，closedReason 表达 L2 原因）
   * 或 running（对话模式轮次完成，旧 idle 折入 running，携带本轮结果送回主 agent）。
   * toNotifyRecord 守卫放行后经此联合穷尽。
   */
  status: "running" | "closed";
  /** L2 关闭原因子枚举（仅 status="closed" 时有意义）。内部诊断 + outcome 兑底派生输入。 */
  closedReason?: ClosedReason;
  /**
   * 终态三态对外语义（U3 C-outcome）。notify() 投影边界物化：closed 入参缺省时按
   * deriveOutcome(closedReason, error) 兑底填充（所有可达流程下与 completeRecord
   * 冻结的 record.outcome 等价——toNotifyRecord 构造点在 completeRecord 之后；该
   * 构造点属 U3 领地外，不透传本字段）。buildLlmContent 与 bg-notify-render 只读本字段。
   */
  outcome?: ExecutionOutcome;
  agent: string;
  /** 执行所用 model（RecordSnapshot.model），用于完成通知显示。 */
  model?: string;
  result?: string;
  error?: string;
  startedAt: number;
  endedAt: number | undefined;
  /**
   * 对话轮次计数（仅 idle 有意义）。dedup key 按 `id:round` 去重——对话模式每轮 round
   * 不同，60s 内多轮不被吞；首轮前 round 恒定（0/undefined），key 同旧 id 行为不变。
   */
  round?: number;
  /** [MF#1] worktree 模式下子 agent 改动的 patch 路径（worktree 外，cleanup 后留存）。
   *  done 时通知文本显式提示 `git apply`，否则 background 子 agent 在隔离 worktree 的改动
   *  会静默丢失——父 LLM 不知 patch 路径，无法应用。 */
  patchFile?: string;
  /** [wave2 → modeless 波1] 子 agent session 文件路径（全文恢复通道）。
   *  全体透传（toNotifyRecord 无条件携带）——通知末尾追加
   *  "Full transcript: <path>" 指针行，父 LLM 可按需读全文；万物可续下每个
   *  record 都要能被 message/fork 定位。缺失时 buildLlmContent 省略整行。 */
  sessionFile?: string;
  /** [U2] 通知身份键（投影边界物化 = dedupe key：`id` / `id:round`；[U5 / §3.2.3]
   *  epoch>0 时扩为 `id:epoch:round`——reopen 后 round 归零不与历史轮撞键，epoch=0
   *  恒旧格式，磁盘账本零迁移）。账本条目 / 回执匹配 / 幂等去重共用——details 携带
   *  （不进文案，G4 字节锁定不受影响），重复注入条目凭此可识别为同一条（G2
   *  at-least-once 幂等键）。 */
  notifyId?: string;
  /**
   * [U5 / §3.2.3] 通知所属世代（reopen 防撞维度）：notifyId 构造消费——epoch>0 的
   *  轮次通知 key 带 epoch 段。缺省（undefined）= epoch 0 旧格式。
   */
  epoch?: number;
  /**
   * [drain-drop 修复] notifyId 构造的显式覆盖（notify() 优先消费；缺省 = 既有
   *  `id` / `id:round` 语义零变化）。供「同轮先导通知与派生通知必须区分」的场景使用：
   *  现行唯一消费方 = drain 队列丢弃通知（`${id}:${round}:drain-drop`）——同轮
   *  settleRoundFailed 失败通知缺省 key 为 `id:round`，丢弃通知若沿用同 key 会被
   *  ledger/内核按 key 永久去重吞掉（「队列消息被丢」的显式反馈永不可达）。
   */
  dedupKey?: string;
  /** [C-2] close 终态通知的轮次统计（文案 "completed after N rounds." 用）。
   *  仅收口落账提示语义（notifyClosed）构造时携带——此时 dedup 身份 round 已被
   *  置 undefined（与轮次通知的 id:round key 区分，终态不被吞），轮数改由本字段进
   *  文案。one-shot 完成通知不设置，文案保持 "completed. Result:" 逐字节（G4）。 */
  totalRounds?: number;
}

/** notifier 依赖的宿主最小接口（解耦，便于测试）。
 *  迁移后：仅用于构造 DeliveryPort 的底层依赖。 */
export interface NotifierHost {
  /** 注入消息到主对话（U2 单通道：options 只接受 triggerTurn——多通道投递已删）。 */
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean },
  ): void;
  /** 是否还有 running 的 background 任务（用于滑动窗口立即 flush 判断）。 */
  hasRunningBackground(): boolean;
  /** 主 agent 是否空闲（非 streaming）。可选：未注入时 flush 不 gate。 */
  isIdle?: () => boolean;
  /**
   * 原生 settled 事件订阅能力（D8）：注册 handler 监听主 agent settled 边沿。
   * 无退订语义（pi 0.84.4 的 `pi.on(...)` 全部重载返回 void、无 off——实装锚点：
   * node_modules `@earendil-works/pi-coding-agent` dist/core/extensions/types.d.ts
   * `on()` 系列重载，0.84.4 实测）——退订由本模块的 disposed
   * 标志包装兑现（见下方 port 装配）。可选：未注入时内核退化退避轮询（busy 消息
   * 靠退避达上限强发，不走 settled 边沿驱动）。
   */
  onAgentSettled?(handler: () => void): void;
}

/**
 * 将 BgNotifyRecord 格式化为 LLM 可读的 notification content。
 *
 * 模块内唯一消费方是下方 createNotifier 的 notify()（预格式化后传 delivery.send，
 * 内核只做拼接——多条以 "\n\n---\n\n" join）。
 */
function buildLlmContent(record: BgNotifyRecord): string {
  const agent = record.agent;
  const id = record.id;
  // [wave2 指针行 → modeless 波1] 轮次通知携带本轮增量，异步 flush 窗口丢失时不可
  // 重发，恢复通道是 session 文件全文。全体透传 sessionFile（万物可续——每个
  // record 都要能被 message/fork 定位）；cancelled/gc-failed 不追加（无成功结果
  // 可读，指针无意义）；缺失时省略整行（追加空串 = 输出逐字节不变）。
  const transcriptPointer = record.sessionFile
    ? `\n\nFull transcript: ${record.sessionFile}`
    : "";
  switch (record.status) {
    case "closed": {
      // U3 C-outcome：终态文案只读 outcome（notify() 投影边界已物化；?? 兑底为防御
      // 完整性——单一权威函数，非同构重写）。判定先于 patchFile——失败轮也会写
      // patchFile（doFinalizeRecord Step 0 对 worktreeHandle 无条件 collectPatch），
      // failed 分支不展示 patch 提示，否则 worktree 失败并存时 LLM 被告知 completed
      // （历史 bug 存档见 deriveOutcome 注释）。
      const outcome = record.outcome ?? deriveOutcome(record.closedReason, record.error);
      if (outcome === "cancelled") {
        return `Subagent "${agent}" (${id}) cancelled.`;
      }
      if (outcome === "failed") {
        return `Subagent "${agent}" (${id}) failed: ${record.error}`;
      }
      // 成功完成或通用结束：展示结果。
      // [C-2] close 收口提示附轮次统计（设计 D2 路径①"completed after N rounds"）。
      // totalRounds 仅 notifyClosed（收口提示）携带；轮次通知不设置（轮次身份由
      // round 承载），文案保持 "completed. Result:" 逐字节（G4 硬约束锚定）。
      const roundsSuffix =
        record.totalRounds != null && record.totalRounds > 0
          ? ` after ${record.totalRounds} round${record.totalRounds === 1 ? "" : "s"}`
          : "";
      const base = `Subagent "${agent}" (${id}) completed${roundsSuffix}. Result:\n${record.result ?? "(empty)"}`;
      if (record.patchFile) {
        // [wave2 review] 长 return 拆行：模板串内不可直接换行（会改变输出内容），提取 patchHint 中转变量
        const patchHint = `\n\nThis subagent ran in an isolated worktree; its file changes were captured as a patch:\n  ${record.patchFile}\nTo bring these changes into the current repo, run: \`git apply ${record.patchFile}\``;
        return `${base}${patchHint}${transcriptPointer}`;
      }
      return `${base}${transcriptPointer}`;
    }
    case "running":
      // v4 B-1: 对话模式轮次完成（旧 idle 折入 running）：携带本轮结果送回主 agent，等待下一轮 message。
      return `Subagent "${agent}" (${id}) finished a round. Reply:\n${record.result ?? "(empty)"}${transcriptPointer}`;
  }
}

/**
 * Background 完成通知器接口（迁移后由内核实现）。
 *
 * 保持与旧 BgNotifier 类相同的公共 API，避免消费方（subagent-service）改动面过大。
 */
export interface BgNotifier {
  /** 入队一条完成通知（去重 + 合批窗口合并）。dispose 后短路。 */
  notify(record: BgNotifyRecord): void;
  /** 立即 flush（session_shutdown 调用，防丢失）。 */
  flushPendingNotifications(): void;
  /** session 结束：清队列，dispose 内核 handle。 */
  dispose(): void;
  /** /resume /fork /new 后复活。 */
  revive(): void;
}

/**
 * 投递工厂缺席降级（NotifyDomainPorts.createDelivery === undefined）时的最小直发
 * handle：send 直接调 port.send，无 gate / 合批窗口 / dedupe / 退避。
 *
 * 缺席形态 = 宿主漏配通知域窄端口（生产接线在 extension 入口 configureNotifyDomain，
 * 见 index.ts——正常不可达）或测试未装配。降级是「消息仍能发出」的安全侧退化：
 * 丢失的只是 busy 场景的投递时机治理（isIdle gate 由 port.send 装配层兜底语义吸收）。
 */
function createDirectSendHandle(port: DeliveryPort): DeliveryHandle {
  return {
    send: (msg) => {
      // D5 单通道下 port.send 装配忽略 intent 参数；传 notifier 装配的唯一 intent
      // 与工厂配置保持语义一致。回执（receipt）为扩展位，直发路径不消费。
      void port.send(msg, "interrupt-at-turn-boundary");
    },
    flush: () => {}, // 无队列（每条 send 即投），无待 flush 内容
    dispose: () => {}, // 无 timer / 订阅需清理
  };
}

/**
 * 创建 Background 完成通知器（薄工厂）。
 *
 * ledger 装配时（bindNotifyLedgerHost）：四步生命周期接线（写账 → courier 边沿
 * 投递 → 回执销账 → notifyId 幂等，见 notify-ledger.ts）。未装配时：装配投递内核
 * （createDelivery 经 NotifyDomainPorts 注入，缺席降级直发见 createDirectSendHandle）
 * ——gate（isIdle 退避）/ 合批窗口（滑动 60s）/
 * dedup（按 id:round）/ flush / shutdown flush 均委托内核。
 * 本函数职责：BgNotifyRecord → 预格式化 content + notifyId 物化。
 *
 * @param host 宿主能力注入（pi.sendMessage + hasRunningBackground + isIdle）
 * @returns BgNotifier 接口（与旧类同形）
 */
export function createNotifier(host: NotifierHost): BgNotifier {
  let disposed = false;

  // 构造 DeliveryPort：intent → pi 参数翻译在适配器内（D3）
  const port: DeliveryPort = {
    supportedPayloads: ["custom"],
    isIdle: () => {
      if (host.isIdle) {
        return host.isIdle();
      }
      // 未注入 isIdle → 视为 idle（不 gate，向后兼容旧 host）
      return true;
    },
    hasPendingMessages: () => false, // notifier 不关心 hasPendingMessages
    // D8（must-fix #4）：settled 边沿驱动装配——内核 busy 入队后由 settled 事件唤醒
    // flush（watch-dog 兜底事件丢失），替代无订阅时的退避轮询。host 只注入原生订阅
    // 能力；disposed 标志包装（兑现退订语义——pi.on 返回 void 且无 off）在此完成。
    subscribeSettled:
      host.onAgentSettled === undefined
        ? undefined
        : (cb) => {
          let disposed = false;
          host.onAgentSettled?.(() => {
            if (!disposed) cb();
          });
          return () => {
            disposed = true;
          };
        },
    send: (msg, _intent) => {
      // D5 单通道：投递意图唯一化——steer/followUp/nextTurn 多通道全部删除，
      // 唯一发送形态 = sendCustomMessage({triggerTurn:true})。busy 场景由 ledger
      //（settled 边沿 + isIdle 二次复查）或内核 settled 订阅在空闲边沿驱动，
      // 不在此层分流。返回 void = 受理成功（同步无异常；SendReceipt 扩展位留待
      // 升级方接入）。
      host.sendMessage(
        {
          customType: NOTIFY_CUSTOM_TYPE,
          content: msg.payload.content,
          display: true,
          details: msg.payload.kind === "custom" ? msg.payload.details : undefined,
        },
        { triggerTurn: true },
      );
    },
  };

  // #5（must-fix）：内核 handle 的 disposed 不可逆——dispose 后 revive 必须重建 handle，
  // 否则 revive 后所有 notify() 被内核静默吞（外层标志复位救不回已销毁的内核）。
  // revive = 新生命周期：合批窗口 / 在途批次 / dedup LRU 随重建自然复位（可接受）。
  // 工厂经通知域窄端口解析（每次 createHandle 时取——与 facade logger 同款延迟解析，
  // 宿主 configureNotifyDomain 的时序无关紧要）；缺席降级直发并 warn 一次（per-notifier
  // 一次：revive 重建 handle 不重复刷屏，新 session 新 notifier 再 warn 可接受）。
  let directFallbackWarned = false;
  const createHandle = (): DeliveryHandle => {
    const factory = getNotifyDomainPorts().createDelivery;
    if (factory === undefined) {
      if (!directFallbackWarned) {
        directFallbackWarned = true;
        // 错误必须可操作：指出恢复动作（configureNotifyDomain 注入）与 pi 壳落点。
        notifyLogger.warn(
          "NotifyDomainPorts.createDelivery not configured - falling back to direct-send delivery " +
            "(no idle gate / merge window / dedupe). Host must call configureNotifyDomain({ createDelivery }) " +
            "during extension initialization (pi shell: createPiNotifyDomainPorts in src/host/pi-host.ts).",
        );
      }
      return createDirectSendHandle(port);
    }
    return factory(port, {
      intent: "interrupt-at-turn-boundary",    // D3：turn 边界抢占（F1 教训内化）
      mergeWindowMs: 60_000,                   // 滑动窗口合批（继承 MERGE_WINDOW_MS=60s）
      mergeHoldActive: () => host.hasRunningBackground(), // D4 must-fix #1：禁止用 isIdle 代替
      busyPolicy: "retry-force",               // settled 边沿驱动 + 退避达上限强发
      backoff: { ms: 100, max: 50 },           // 继承 FLUSH_BACKOFF_MS/MAX
      // dedup LRU：语义与旧 DEDUP_TTL_MS=60s **不同**——按 key 永久去重（仅 LRU 逐出后
      // 同 key 可再入）。当前 key 空间（id / id:round，id 每 spawn 唯一）无实际差异；
      // 后续复用方勿按「60s 内不重复」假设接入（同 key 通知会被永久吞）。
      dedupe: { maxKeys: 1000 },
      // U4 warn 出口参数化：内核投递失败警告接 core logger facade（pi 壳下经
      // extension-logger appendEntry 落 session JSONL + TAIJI_AGENT_DEBUG 落
      // <dataDir>/logs/），不再走 console.warn（stderr tee 不到日志盘——排查无痕，
      // 设计 §5 U4）。
      warn: (msg, err) => notifyLogger.warn(msg, err),
    });
  };
  let handle: DeliveryHandle = createHandle();

  /** 四步投递链收尾共用段（S2，code-simplify）：ledger 在 → ①写账（拒绝 = false，
   *  幂等去重：同 notifyId 已在账/已销账）→ ②attemptDeliver（settled 边沿 + isIdle
   *  二次复查，③④销账/重放在 ledger 内）；ledger 缺（旧装配 / 部分测试，含 jiti
   *  单例分裂的失效形态）→ 内核路径降级 + 降级留痕 warn（C-ext-06 配套，不改变向
   *  后兼容行为）。notify 为 fire-and-forget，返回值忽略。闭包读 let handle：
   *  revive 重建后自然指向新 handle。 */
  function deliverViaLedgerOrKernel(notifyId: string, content: string, details: object): boolean {
    const ledger = getBoundNotifyLedger();
    if (ledger) {
      if (!ledger.record(notifyId, content, details)) return false;
      ledger.attemptDeliver();
      return true;
    }
    notifyLogger.warn("notify ledger not bound, falling back to delivery kernel path (at-most-once)", {
      notifyId,
    });
    handle.send({
      payload: {
        kind: "custom",
        customType: NOTIFY_CUSTOM_TYPE,
        content,
        display: true,
        details,
      },
      dedupeKey: notifyId,
    });
    return true;
  }

  return {
    notify(record: BgNotifyRecord): void {
      if (disposed) return;

      // U3 C-outcome：投影边界物化 outcome——closed payload 缺省时按单一权威
      // deriveOutcome 兑底填充，content 与 details（GUI pane 消费）均携带一等 outcome；
      // 所有可达流程下与 record.outcome 等价（toNotifyRecord 在 completeRecord 之后
      // 构造）。running（轮次通知）语义上无 outcome，不物化。消源自 record 的浅拷贝
      // ——不改写入方对象（BgNotifyRecord 由调用方持有）。notifyId 同批物化（U2：
      // dedupe key 与账本身份键同源，details 携带供回执匹配）。
      // notifyId 构造：dedupKey 显式覆盖优先（drain 丢弃通知等派生通知的独立去重
      // 身份），缺省 = `id:round` / `id` 旧格式；[U5 / §3.2.3] epoch>0 扩为
      // `id:epoch:round`（reopen 后 round 归零不与历史轮撞键，同 key 撞车吞通知是
      // 本代码库已修复过的事故类——epoch 是同族防御的构造性根治）。
      const roundKey =
        record.round != null
          ? (record.epoch !== undefined && record.epoch > 0
            ? `${record.id}:${record.epoch}:${record.round}`
            : `${record.id}:${record.round}`)
          : record.id;
      const notifyId = record.dedupKey ?? roundKey;
      const payload: BgNotifyRecord =
        record.status === "closed"
          ? { ...record, outcome: record.outcome ?? deriveOutcome(record.closedReason, record.error), notifyId }
          : { ...record, notifyId };

      const content = buildLlmContent(payload);

      // U2 B-ledger 四步接线（设计 D4/D5）：账本装配时①写账（appendEntry 先于一切
      // 投递尝试）→ ②courier 边沿投递（settled 边沿 + 120s 看门狗 + isIdle 二次
      // 复查）→ ③回执销账 / ④重放幂等均在 ledger 内。record 返回 false = 同
      // notifyId 已在账或已销账（幂等去重，含重启恢复后的已送达账号零重发）。
      // 无 ledger 装配时内核路径降级 + 降级留痕（C-ext-06 配套，见 helper 注释）。
      // 单条通知为 fire-and-forget，返回值忽略。
      deliverViaLedgerOrKernel(notifyId, content, payload);
    },

    flushPendingNotifications(): void {
      // ledger 路径：立即投递尝试（isIdle 复查，busy 则挂 pending 等边沿——账已落盘，
      // 重启恢复兑底）；内核路径：flush。
      const ledger = getBoundNotifyLedger();
      if (ledger) {
        ledger.attemptDeliver();
        return;
      }
      handle.flush();
    },

    dispose(): void {
      disposed = true;
      handle.dispose();
      // ledger 销毁（清看门狗 + 摘模块级绑定；settled 回调由 disposed 标志静默）。
      // 未 bind 时 no-op。bind 归 index.ts session_start 装配，对称免受。
      getBoundNotifyLedger()?.dispose();
    },

    revive(): void {
      disposed = false;
      // #5：内核 disposed 不可逆——revive 必须重建 handle（/resume /fork /new 后的
      // session_start 时序：disposeAll → initSession → revive）。旧 handle 若仍存活
      // （首次 session_start 的 revive）dispose 为幂等清理，无副作用。
      handle.dispose();
      handle = createHandle();
    },
  };
}
