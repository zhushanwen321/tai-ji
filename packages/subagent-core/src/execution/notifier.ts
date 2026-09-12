// src/execution/notifier.ts
//
// Background 完成回注主对话。collect:"sync" 的批通知不经单条 notify() 生命周期，
// 由 collect-coordinator 合批后调本文件 notifyBatch 投递（成员结果不直接返回调用方）。
//
// 职责（U2 后）：
//   - buildLlmContent：格式化通知文案（本文件唯一逻辑职责）
//   - createNotifier：薄工厂——ledger 装配时（bindNotifyLedgerHost 已注入）走
//     四步生命周期（写账 → courier 边沿投递 → 回执销账 → notifyId 幂等重放，
//     notify-ledger.ts）；未装配时退回投递内核路径（createDelivery 经通知域窄端口
//     NotifyDomainPorts 注入——core 依赖闭包不含 session-delivery，见 core/notify-ports.ts；
//     合并窗口 / 去重 / 退避 / flush 委托内核，旧装配 / 无 ledger 测试兼容）
//   - notifyBatch / buildBatchLlmContent / computeBatchBudget：sync 批通知三件套（U3/U4）
//
// 投递通道（D5 单通道化）：ledger 路径经 courier 在 settled 边沿直达
// pi.sendMessage({triggerTurn:true})；内核路径的 port.send 同样只传
// {triggerTurn:true}——steer / followUp / nextTurn 通道已全部删除（nextTurn 的
// 唯一 drain 点在 session.prompt() 内，主 agent 长 streaming 场景下无限期滞留，
// 设计 D5 实测证伪）；busy 场景由 ledger（settled 边沿 + isIdle 二次复查）或内核
// settled 订阅驱动在空闲边沿投递。

import { createHash } from "node:crypto";

import { getLogger } from "../core/logger.ts";
import { getNotifyDomainPorts, type DeliveryHandle, type DeliveryPort } from "../core/notify-ports.ts";

import { deriveOutcome } from "./execution-record.ts";
import { getBoundNotifyLedger, NOTIFY_CUSTOM_TYPE } from "./notify-ledger.ts";
import type { ClosedReason, ExecutionOutcome } from "./types.ts";

// ============================================================
// [T4① / PS-2] notify 门（H1 U2 自 subagent-service.ts 迁入——Continuation
// 成功/失败分支双闸共用；原位置 re-export 保持既有 import 路径不变）
// ============================================================

/** notify 门拦截集：disposeAllRecords 因这两类原因关闭的 record，其迟到的
 *  轮次完成回注不得注入新 session——/new、/fork 的决策（[v4 A-6]）
 *  是「被关 record 的告知改由 list 的 closedReason 表达」，不主动通知；旧门只排除
 *  cancelled，parent-new/parent-fork 放行 → 新对话被「Subagent X failed: closed due to
 *  parent-new」的僵尸回执 triggerTurn 唤醒，已废弃会话的通知注入新上下文。 */
const NOTIFY_BLOCKED_CLOSED_REASONS: ReadonlySet<ClosedReason> = new Set(["parent-new", "parent-fork"]);

/**
 * [T4① / PS-2] 轮次完成回注的 notify 门（按 closedReason 白名单放行）。
 *
 * cancelled（cancelBackground 自己 notify）与 parent-new/parent-fork（编排性关闭，
 * 告知由 list 的 closedReason 表达）不放行；其余（undefined = 本路径抢到 CAS 尚未
 * 终态化的迟到回调、user-close/gc 等真实终态）照旧回注。导出供测试与调用点复用。
 * [H1 U2] 消费面扩为三处：Continuation 成功分支（route 前）、失败分支（独立载荷
 * 发出前，B#19 投递门照迁移）、泛化派发主干尾部（one-shot 回注，现状不变）。
 */
export function notifyGateAllowsDelivery(closedReason: ClosedReason | undefined): boolean {
  if (closedReason === undefined) return true;
  if (closedReason === "cancelled") return false;
  return !NOTIFY_BLOCKED_CLOSED_REASONS.has(closedReason);
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
   * 不同，60s 内多轮不被吞；非 chatMode round 恒定（0/undefined），key 同旧 id 行为不变。
   */
  round?: number;
  /** [MF#1] worktree 模式下子 agent 改动的 patch 路径（worktree 外，cleanup 后留存）。
   *  done 时通知文本显式提示 `git apply`，否则 background 子 agent 在隔离 worktree 的改动
   *  会静默丢失——父 LLM 不知 patch 路径，无法应用。 */
  patchFile?: string;
  /** [wave2] 子 agent session 文件路径（增量语义的全文恢复通道）。
   *  仅 chatMode 透传（toNotifyRecord 条件透传）——轮次/完成通知末尾追加
   *  "Full transcript: <path>" 指针行，父 LLM 可按需读全文；one-shot 不透传，
   *  通知输出逐字节不变。缺失时 buildLlmContent 省略整行。 */
  sessionFile?: string;
  /** [U2] 通知身份键（投影边界物化 = dedupe key：`id` / `id:round`）。账本条目 /
   *  回执匹配 / 幂等去重共用——details 携带（不进文案，G4 字节锁定不受影响），
   *  重复注入条目凭此可识别为同一条（G2 at-least-once 幂等键）。 */
  notifyId?: string;
  /**
   * [drain-drop 修复] notifyId 构造的显式覆盖（notify() 优先消费；缺省 = 既有
   *  `id` / `id:round` 语义零变化）。供「同轮先导通知与派生通知必须区分」的场景使用：
   *  现行唯一消费方 = drain 队列丢弃通知（`${id}:${round}:drain-drop`）——同轮
   *  settleRoundFailed 失败通知缺省 key 为 `id:round`，丢弃通知若沿用同 key 会被
   *  ledger/内核按 key 永久去重吞掉（「队列消息被丢」的显式反馈永不可达）。
   */
  dedupKey?: string;
  /** [C-2] close 终态通知的轮次统计（文案 "completed after N rounds." 用）。
   *  仅 chatMode close 语义（notifyClosed）构造时携带——此时 dedup 身份 round 已被
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

/** sync 批通知幂等键前缀（subagent-sync-collect 设计 §3.1.3 批身份）。 */
const BATCH_NOTIFY_ID_PREFIX = "sync-batch:";

/**
 * sync 批通知 notifyId：`sync-batch:<sha1(sorted member ids)>`。
 *
 * 成员集身份（D2 隐式批）：字典序排序后 sha1——同成员集不同登记顺序同 hash（重启
 * 重建批 / E1 补发凭此与账本原条目对齐，幂等去重）；不同成员集必异 hash（跨批不互吞）。
 * 成员 id 为 sa-xxx 格式无分隔歧义，join(",") 仅作边界防御。
 */
export function buildBatchNotifyId(memberIds: readonly string[]): string {
  const digest = createHash("sha1")
    .update([...memberIds].sort().join(","))
    .digest("hex");
  return `${BATCH_NOTIFY_ID_PREFIX}${digest}`;
}

// ─── U4 预算截断 + 指针（设计 §3.1.2 两段式预算，确定性统一收紧）───

/** sync 批预算参数（config collectSync 节语义）。U4 以设计默认值锁规格；
 * config 热读（flush 时读值）需 service 传参接线，不在本函数内自行读 config。 */
export interface BatchBudgetParams {
  /** 单条目正文上限（第一段截断）。 */
  perItemChars: number;
  /** 全批正文中量预算（第二段收紧触发阈值）。 */
  totalChars: number;
}

/** 设计默认预算（§3.1.3 config 示例值）。 */
const DEFAULT_BATCH_BUDGET: BatchBudgetParams = { perItemChars: 4000, totalChars: 24000 };

/** 预算计划（computeBatchBudget 输出，纯数据）。 */
export interface BatchBudgetPlan {
  /** ② 总量再压缩是否触发（Σ per-item 截断后正文 > totalChars）。 */
  tightened: boolean;
  /** 每条目正文有效上限：未收紧 = perItemChars（兼作第一段截断上限）；纯清单退化 = 0。 */
  effectivePerItem: number;
  /** 纯清单退化（floor(totalChars/n) < 200 → 条目只剩头行 + 指针行，正文 0 字符）。 */
  listOnly: boolean;
}

/** 绝对下限（设计 §3.1.2）：预算折算低于它时放弃正文，条目退化为「头行 + 指针行」。 */
const LIST_ONLY_FLOOR = 200;

/**
 * 两段式批预算计划（纯函数，规格测试 collect-budget.test.ts 锁定）。
 *
 * ① per-item：每条目正文 ≤ perItemChars；② 总量：Σ(截断后) > totalChars 时
 * effectivePerItem = clamp(floor(totalChars / n), 200, perItemChars) 统一收紧
 * （n = 成员数）。刻意放弃按剩余预算的瀑布分配（非确定、依赖条目顺序），
 * 统一收紧换确定性；收紧后 Σ ≤ n × floor(totalChars/n) ≤ totalChars 恒回到预算内。
 * 未触发收紧时 effectivePerItem = perItemChars（同时承担第一段截断上限）。
 */
export function computeBatchBudget(
  bodyLengths: readonly number[],
  perItemChars: number,
  totalChars: number,
): BatchBudgetPlan {
  const n = bodyLengths.length;
  const sumAfterPerItem = bodyLengths.reduce((sum, len) => sum + Math.min(len, perItemChars), 0);
  if (n === 0 || sumAfterPerItem <= totalChars) {
    return { tightened: false, effectivePerItem: perItemChars, listOnly: false };
  }
  const tight = Math.floor(totalChars / n);
  if (tight < LIST_ONLY_FLOOR) {
    return { tightened: true, effectivePerItem: 0, listOnly: true };
  }
  return { tightened: true, effectivePerItem: Math.min(tight, perItemChars), listOnly: false };
}

/** 千位分隔（对齐设计样例 11,234；手写正则零 ICU 依赖）。 */
function formatChars(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * session_read result action 的默认单条字符上限（adversarial-review-fixes §3.4 C3）。
 * 对齐 extensions/universal/session-reader/src/result-action.ts 的 RESULT_DEFAULT_LIMIT
 * （8000）——extension 与 runtime 包无共享常量处、反向 import 会建立 subagent-core 对
 * extension 的依赖，故本地常量 + 注释锚定；两侧改动须同步。
 */
const SESSION_READ_DEFAULT_LIMIT = 8000;

/** 截断指针行（设计 §3.1.2 样例）：主 agent 据此按需 session_read 取回全文。
 *  [S8 code-simplify 口径注] 本函数的 X（total - kept）= **丢弃**字符数；而
 *  session-reader result-action.ts formatResultTruncation 同模板的 X = **保留**
 *  字符数（limit）——同模板异语义，统一字符串 = 行为变更，勿顺手改口径。
 *  [C3 limit 随附] perItemLimit = 该成员实际截断预算（effectivePerItem）：预算超过
 *  session_read 默认 limit(8000) 时附 "limit":N——模型照抄指针行 JSON 调用才能取到
 *  ≥ 默认值的有效正文（否则默认 8000 反而少于通知里已见的 kept，触发第二层截断）；
 *  ≤8000 不附（默认已覆盖，避免噪音）。 */
function buildTruncationPointer(id: string, kept: number, total: number, perItemLimit: number): string {
  const limitPart = perItemLimit > SESSION_READ_DEFAULT_LIMIT ? `,"limit":${perItemLimit}` : "";
  return `[truncated ${formatChars(total - kept)} of ${formatChars(total)} chars — full result: session_read {"action":"result","session":"${id}"${limitPart}}]`;
}

/** closed 成员 outcome 兑底物化（与下方 notify() 投影边界同款）；running 原样透传。 */
function withMaterializedOutcome(record: BgNotifyRecord): BgNotifyRecord {
  return record.status === "closed"
    ? { ...record, outcome: record.outcome ?? deriveOutcome(record.closedReason, record.error) }
    : record;
}

/**
 * sync 批通知文案（U3 批形态 + U4 两段式预算截断）。
 *
 * 形态（设计 §3.1.1 交互样例）：批头行 `Subagent batch completed: N finished,
 * M failed, K cancelled.` + 各成员条目（buildLlmContent 同语义）以 "\n\n---\n\"
 * \n" join（分隔符对齐 ledger mergeItems / 内核合批——TUI/LLM 两消费方同构）。
 * 批头计数口径 = 成员 outcome 三态（completed→finished）；closed 成员 outcome 缺省
 * 时按单一权威 deriveOutcome 兑底（与 notify() 投影边界同款，幂等无害）。
 *
 * [U4 预算截断] 仅对展示结果正文的条目（closed+completed / running）生效；
 * failed/cancelled 条目无 result 可取回（指针无意义）不计正文预算、原样输出。
 * totalChars 口径（§3.1.2）：仅计条目正文（截断后）之和，批头/头行/指针行/
 * 分隔符等包装开销为有界常量不入预算。未触预算时输出与 U3 基线逐字节一致。
 * budget 缺省 = 设计默认值；config 热读接线由 flush 调用方传入。
 */
export function buildBatchLlmContent(
  records: readonly BgNotifyRecord[],
  budget: BatchBudgetParams = DEFAULT_BATCH_BUDGET,
): string {
  // 入口一次物化（S1，code-simplify）：closed 成员 outcome 兑底仅此一处，bodies/计数/
  // 条目全部读物化结果——「单一权威 deriveOutcome」从注释承诺变构造事实。幂等纯函数，
  // 与原四处各自推导逐字节等价；running 原样透传零拷贝。
  const mat = records.map(withMaterializedOutcome);
  let finished = 0;
  let failed = 0;
  let cancelled = 0;
  // 各条目参与预算的正文（§3.1.2 口径）；null = 该条目不展示 result 正文。
  const bodies = mat.map((record): string | null => {
    if (record.status === "closed" && record.outcome !== "completed") return null;
    return record.result ?? "(empty)";
  });
  const plan = computeBatchBudget(
    bodies.map((body) => body?.length ?? 0),
    budget.perItemChars,
    budget.totalChars,
  );
  const items = mat.map((record, i) => {
    if (record.status === "closed") {
      const outcome = record.outcome;
      if (outcome === "completed") finished += 1;
      else if (outcome === "failed") failed += 1;
      else if (outcome === "cancelled") cancelled += 1;
    }
    const body = bodies[i];
    if (body === null || body.length <= plan.effectivePerItem) {
      // 未触预算（含 failed/cancelled 条目）：U3 基线字节不变。
      return buildLlmContent(record);
    }
    // 截断：正文保留前 limit 字符 + 省略号，尾接指针行（kept=0 纯清单时省略号一并省略）。
    const kept = body.slice(0, plan.effectivePerItem);
    const truncated = buildLlmContent({ ...record, result: plan.listOnly ? "" : `${kept}…` });
    // 纯清单时 result 置空会在 buildLlmContent 内残留头行尾换行（"Result:\n" + ""），
    // 收掉该空行让条目严格为「头行 + 指针行」两行形态（设计 §3.1.2 纯清单退化）。
    const stripped = plan.listOnly ? truncated.replace(/\n$/, "") : truncated;
    return `${stripped}\n${buildTruncationPointer(record.id, kept.length, body.length, plan.effectivePerItem)}`;
  });
  const header = `Subagent batch completed: ${finished} finished, ${failed} failed, ${cancelled} cancelled.`;
  return [header, ...items].join("\n\n---\n\n");
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
  // [wave2 指针行] 增量语义下轮次通知只携带本轮增量，异步 flush 窗口丢失时不可重发
  //（见 subagent-service.ts onRoundSettled 注释），恢复通道是 session 文件全文。
  // 仅 chatMode 透传 sessionFile，one-shot 通知不含该行；cancelled/gc-failed 不追加
  //（无成功结果可读，指针无意义）；缺失时省略整行（追加空串 = 输出逐字节不变）。
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
      // [C-2] chatMode close 终态通知附轮次统计（设计 D2 路径①"completed after N rounds"）。
      // totalRounds 仅 close 语义携带（notifyClosed）；one-shot 完成通知不设置（round 无轮次
      // 语义），文案保持 "completed. Result:" 逐字节（G4 硬约束，one-shot 字节锁测试锚定）。
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
  /**
   * sync 批通知（subagent-sync-collect U3）：成员集 → 单条批投递。幂等键
   * `sync-batch:<sha1(sorted ids)>`，走与 notify 同一写账→settled 边沿投递链（单
   * entry）。返回 false = 幂等拒绝（同成员集批已在账/已销账）或空批 / dispose 后——
   * 调用方（service flushBatch 接线）据此决定 batchFinalized 落标。
   */
  notifyBatch(records: readonly BgNotifyRecord[], budget?: BatchBudgetParams): boolean;
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
      // extension-logger appendEntry 落 session JSONL + XYZ_AGENT_DEBUG 落
      // <dataDir>/logs/），不再走 console.warn（stderr tee 不到日志盘——排查无痕，
      // 设计 §5 U4）。
      warn: (msg, err) => notifyLogger.warn(msg, err),
    });
  };
  let handle: DeliveryHandle = createHandle();

  /** 四步投递链尾部共用段（S2，code-simplify）：notify 单条与 notifyBatch 逐行同构
   *  的收尾——原两份手写拷贝使注释宣称的「同一四步链」无结构强制，现单点实现。
   *  ledger 在 → ①写账（拒绝 = false，幂等去重：同 notifyId 已在账/已销账）→
   *  ②attemptDeliver（settled 边沿 + isIdle 二次复查，③④销账/重放在 ledger 内）；
   *  ledger 缺（旧装配 / 部分测试，含 jiti 单例分裂的失效形态）→ 内核路径降级 +
   *  降级留痕 warn（C-ext-06 配套，不改变向后兼容行为）。返回 false 仅 notifyBatch
   *  消费（调用方跳过落标）；notify 忽略（fire-and-forget）。闭包读 let handle：
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
      // 身份），缺省维持既有 `id:round` / `id` 语义（既有通知面 key 零变化）。
      const notifyId =
        record.dedupKey ?? (record.round != null ? `${record.id}:${record.round}` : record.id);
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

    notifyBatch(records: readonly BgNotifyRecord[], budget?: BatchBudgetParams): boolean {
      if (disposed || records.length === 0) return false;

      // 投影边界物化（与 notify 同款）：closed 成员补 outcome——批头计数与成员条目
      // 单一来源。消源自入参浅拷贝，不改写协调器缓冲持有的快照对象。
      const payloads = records.map((record) =>
        record.status === "closed"
          ? { ...record, outcome: record.outcome ?? deriveOutcome(record.closedReason, record.error) }
          : { ...record },
      );
      const batchNotifyId = buildBatchNotifyId(payloads.map((p) => p.id));
      // budget（可选）= service flushBatch/E1 补发接线传入的 config 热读值（U4 deviation #8
      // 由 U5 接线）；undefined → buildBatchLlmContent 参数缺省 = 设计默认值（4000/24000）。
      // 账本重放走写入时已定格的 content，预算在写账时刻生效（“flush 时热读”语义）。
      const content = buildBatchLlmContent(payloads, budget);
      // details 形态 = ledger mergeItems 批量分支（{batch:true, items}——bg-notify-render
      // extractBatch 已支持，⛔1 核对）+ 顶层 notifyId：collectDeliveredNotifyIds 的回执
      // 匹配键认 details.notifyId / details.items[].notifyId，批身份键必须顶层可达，
      // 否则批 entry 永不销账、重投至放弃。顶层 notifyId 键对 extractBatch 透明（多键无感）。
      const details = { batch: true as const, notifyId: batchNotifyId, items: payloads };

      // 与 notify 同一四步链（deliverViaLedgerOrKernel，S2 提取）：返回 false = 同成
      // 员集批已在账（E1 重建重发 / 重复 flush）→ 调用方跳过落标。
      return deliverViaLedgerOrKernel(batchNotifyId, content, details);
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
