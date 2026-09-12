// src/execution/round-supervisor/supervisor.ts
//
// [W4] 轮次活性监督器——「等待有主」的权威层（本设计事故根因主修单元的核心）。
//
// 设计权威源：docs/design/chat-domain-v1x-liveness-governance.md §3.2 D2 三态判定表
// + record 去向单一裁决表 + 通知对账 + 纳管模型。
//
// 职责一句话：后台子代理被杀后，goal 守卫（消费 pending 注册表）看不到 record 级
// resumable 状态 → 恒放行 continuation → 64min 空转；本监督器把「该等 / 该唤醒 /
// 该放弃」三态判定收拢为 record 级权威，唤醒的是主 agent 的注意力（决策指引），
// 不是自动复活任务——主 agent 是唯一决策者（resume 或重派）。
//
// 三态判定（判据状态源 = record 级，domain.ts 谓词单源）：
//  - 该等：有在途 run / 有进程驱动 → 不干预（事件流推进性归 settled-watchdog
//    中段守护管辖，监督器不重复判定——消两判据并集的第三态缝隙）。
//  - 该唤醒：resumable 未终态 且 无在途 run / 无进程驱动（run 终态 failed 即驱动
//    死亡证据；镜像置死仅作死亡事件触发信号——判定只消费 record 级视图，结构性
//    保证「重建不解管」：引擎进程被动重建重填镜像也不翻转本监督器的判定）。
//    → 通知主 agent 决策（经 notifier steer 通道）。
//  - 该放弃：决策看门狗到期（指引无响应且无收敛信号）→ record 终态化 failed +
//    注销（合法发射点枚举①：内存 record 走 finalizeRecord 路径；磁盘态 record 走
//    终态 entry 落盘，注销由对账 sweep ⑤ 补发）+ 终止通知（此时可重派）。
//
// record 视图（SupervisorRecordView）：监督器不持有 ExecutionRecord 引用——内存
// record（store.getMutable）与磁盘重建 record（collectRecords 投影）统一投影为
// 只读视图后再判定。boot 分区/重认领面对的存量 record 只在磁盘（重启后内存
// records Map 为空），视图化是两形态统一判定的前提。
//
// 定时器模型：每纳管 record 至多一个决策看门狗 timer（类实例 Map 记账，挂载/
// 清除责任内聚——对齐 settled-watchdog / armIdleTimer 的「忘清旧窗」防护先例）。
// 看门狗属回收层防挂死兜底（AGENTS.md 规则 19：回收层允许默认有界 opt-out）——
// 默认 2h（量级依据：通知账本跨 60 分钟完成 3 次投递的事故实测，窗须覆盖
// 「指引重投 + 主 agent 反应」），env 可覆盖/关闭。
//
// 通知对账：送指引前查替代（classifyReplacement 两级启发式，notify-accounting.ts）。

import { getLogger } from "../../core/logger.ts";
import { assertSafeTimerDelay } from "../../shared/timer-delay.ts";
import type { ExecutionRecord } from "../types.ts";
import {
  classifySupervisorDomain,
  isAwakeWarrantedShape,
  isBootReadoptable,
} from "./domain.ts";
import {
  classifyReplacement,
} from "./notify-accounting.ts";

const logger = getLogger("subagents");

const MS_PER_HOUR = 3_600_000;
/** 决策看门狗默认窗的小时数（量级推演见下方常量注释）。 */
const WATCHDOG_DEFAULT_HOURS = 2;

/**
 * 决策看门狗默认窗（2h）：接管/指引送达后，主 agent 无决策且无收敛信号的最长
 * 等待。到期 = 该放弃（record 终态化 failed + 注销 + 终止通知，此时可重派）。
 * 量级依据见文件头注（通知账本 60min/3 次投递的事故实测 × 安全系数）。
 */
export const ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS = WATCHDOG_DEFAULT_HOURS * MS_PER_HOUR;

/**
 * 决策看门狗窗的用户覆盖 env（规则 19：用户显式指定才生效；XYZ_SUBAGENT_* 前缀
 * 过 ENV_WHITELIST_PREFIXES 白名单——PI_ 前缀在桌面 spawn 链被静默丢弃）。
 * >0 覆盖默认窗；≤0 关闭该放弃路径（只送达指引、永不放弃——显式 opt-out，
 * warn 明示后果）；未设 = 默认 2h；非数字 = 回落默认 + warn 留痕。
 */
export const ROUND_SUPERVISOR_WATCHDOG_ENV = "XYZ_SUBAGENT_ROUND_SUPERVISOR_WATCHDOG_MS";

/** 看门狗窗解析缓存（惰性首读定案；_resetEnvCacheForTest 清缓存供测试改 env）。 */
let watchdogEnvCache: { disabled: boolean; overrideMs?: number } | undefined;

function resolveWatchdogEnv(): { disabled: boolean; overrideMs?: number } {
  if (watchdogEnvCache) return watchdogEnvCache;
  watchdogEnvCache = { disabled: false };
  const raw = process.env[ROUND_SUPERVISOR_WATCHDOG_ENV];
  if (raw === undefined || raw.trim() === "") return watchdogEnvCache;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.warn(
      `[round-supervisor] ${ROUND_SUPERVISOR_WATCHDOG_ENV}="${raw}" is invalid — falling back to ` +
        `default decision watchdog window (${ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS}ms)`,
    );
    return watchdogEnvCache;
  }
  if (parsed <= 0) {
    logger.warn(
      `[round-supervisor] ${ROUND_SUPERVISOR_WATCHDOG_ENV}=${parsed} disables the give-up path: a dead ` +
        `background task stays resumable and registered forever (goal guard keeps deferring). ` +
        `Recovery: unset the env or set a positive millisecond value.`,
    );
    watchdogEnvCache.disabled = true;
    return watchdogEnvCache;
  }
  watchdogEnvCache.overrideMs = parsed;
  return watchdogEnvCache;
}

/** 看门狗窗生效值（ms）；disabled=true 时返回值无意义。 */
export function getSupervisorWatchdogMs(): number {
  return resolveWatchdogEnv().overrideMs ?? ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS;
}

/** 该放弃路径是否被 env 显式关闭。 */
export function isSupervisorGiveUpDisabled(): boolean {
  return resolveWatchdogEnv().disabled;
}

// ── record 视图与依赖注入面 ────────────────────────────────────────────────

/**
 * record 只读视图（监督器判定的唯一状态源——内存/磁盘两形态统一投影）。
 * 字段语义对齐 ExecutionRecord / SubagentRecord 同名项。
 */
export interface SupervisorRecordView {
  id: string;
  status: "running" | "closed";
  /** 执行态信号（轮终 idle 写点 / 孤儿恢复兜底）。 */
  resumable: boolean;
  /** 已有完成产出（record.result !== undefined）——SP-5 upgrade 等待态判据。 */
  hasResult: boolean;
  chatMode: boolean;
  /** [H2 W2] 来源身份（adopt 链豁免域判据——classifySupervisorDomain 消费）。 */
  origin?: "tool" | "workflow";
  rootSessionId: string | undefined;
  agent: string;
  slug: string;
  startedAt: number;
  closedReason: string | undefined;
}

/** 该放弃的执行结果分类（文案与终态编排由 deps 侧分叉）。
 *  [F3] 无 "boot-abort" 成员：boot 直断（表 3 行 2 in-flight 直断 failed）已在
 *  record-store 孤儿恢复层完成（finalizeOrphanRecord 的 error 载体 failed 语义 +
 *  终态 entry + sidecar），监督器不重复终态化（双收尾防线）——原 "boot-abort"
 *  GiveUpKind 是头注声称但全链无调用点的死分支，随本轮回清理。 */
export type GiveUpKind = "watchdog-expired" | "superseded";

/** 对账/扫描候选（listCandidateRecords 的元素——本 root session 的 running record）。 */
export interface SupervisorCandidateRecord {
  id: string;
  rootSessionId: string | undefined;
  agent: string;
  slug: string;
  startedAt: number;
  /** [H2 W2] 来源身份（superseded 对账的 workflow 候选豁免判据）。 */
  origin?: "tool" | "workflow";
}

/** RoundSupervisor 的依赖（SubagentService 注入；全部单测替身友好）。 */
export interface RoundSupervisorDeps {
  now(): number;
  /** record 视图查询（内存 getMutable ∪ 磁盘投影，内存优先）。undefined = 不存在。 */
  getRecordView(id: string): SupervisorRecordView | undefined;
  /** 本 root session 的 running record 候选（boot 分区扫描 + 通知对账候选源）。 */
  listCandidateRecords(): SupervisorCandidateRecord[];
  /** 生命周期镜像谓词（hasLiveProcessHandle）。「有进程驱动」判据源。 */
  hasLiveProcess(recordId: string): boolean;
  /** 表 3 行 1 的合并单条通知（failed 如实 + 已接管契约——消除双通知时序窗口）。 */
  sendMergedFailureNotice(record: SupervisorRecordView, errMsg: string): void;
  /** 决策指引（steer）。exemptionDisclaimer = 低置信对账（指引自带豁免声明）。 */
  sendDecisionGuidance(record: SupervisorRecordView, opts: { exemptionDisclaimer: boolean }): void;
  /** 高置信替代的终止通知（「原任务已被新任务替代」）。 */
  sendReplacedNotice(record: SupervisorRecordView, replacementId: string): void;
  /**
   * 该放弃执行（终态化 failed + 注销发射 + 通知编排归 deps——内存
   * record 走 finalizeRecord（注销①），磁盘态 record 走终态 entry 落盘（注销交
   * sweep ⑤）。CAS 防双收尾由 deps 内部承担。boot 直断不经本方法（已在孤儿恢复
   * 层完成，见 bootPartition 头注）。
   */
  giveUp(recordId: string, kind: GiveUpKind, detail: { replacementId?: string }): void;
}

/** 纳管记账条目。 */
interface SupervisedEntry {
  /** 决策指引已送达（一窗内只送一次；run 重启收敛后清除重置）。 */
  guidanceSent: boolean;
  /** 决策看门狗 timer（awaiting-decision 时 armed；该等/解除时清）。 */
  timer: NodeJS.Timeout | undefined;
}

/**
 * 轮次活性监督器（SubagentService 持有的实例；无模块级全局态——测试直接构造）。
 */
export class RoundSupervisor {
  private readonly supervised = new Map<string, SupervisedEntry>();
  /** 在途 run 记账（subagent-service 在 run 发起/收口时报告）。「有在途 run」判据源。 */
  private readonly inFlightRuns = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: RoundSupervisorDeps) {}

  // ── 纳管模型：死亡事件纳管、重建不解管 ─────────────────────────────────

  /**
   * 死亡事件纳管（表 3 行 1：引擎/子进程死亡，宿主存活——record 保持 resumable
   * 已由调用方完成，本方法只做监督侧三件事）：合并单条通知（failed 如实 + 已接管
   * 契约）+ 纳管记账 + 立即三态评估。
   *
   * 幂等/竞态守卫：conversation 形态豁免；record 已终态（cancel/dispose 抢先）不
   * 纳管；重复纳管（同 record 二次死亡事件）不重复通知（保留既有 entry）。
   */
  adoptOnProcessDeath(record: ExecutionRecord, errMsg: string): void {
    if (this.disposed) return;
    if (classifySupervisorDomain(record) !== "run") return;
    if (record.status !== "running") return;
    const existing = this.supervised.get(record.id);
    if (!existing) {
      this.supervised.set(record.id, { guidanceSent: false, timer: undefined });
      this.deps.sendMergedFailureNotice(this.toView(record), errMsg);
    }
    this.evaluate(record.id);
  }

  /**
   * boot 分区（裁决表行 2/3——initSession 扫描）：
   *  - already-resumable-idle（非 conversation）→ 重认领接管（注册存续，process 档），
   *    监督器三态继续；
   *  - conversation 形态 → 现状（轮终 idle 机制管辖，不入监督域）。
   *
   *  in-flight（重启前在途、无 resumable 信号）不在本方法处置面：直断 failed 已由
   *  record-store 孤儿恢复（recoverOrphanRecords → finalizeOrphanRecord）在先完成
   *  （[F3] 表 3 行 2 语义：error 载体 failed 投影 + 终态 entry + sidecar），本方法
   *  重复终态化会双收尾——isBootReadoptable 谓词把 in-flight 形态挡在本方法之外
   *  （谓词与孤儿恢复保留分支同源，domain.ts）；已直断 record 的注册残留注销由
   *  reconcile sweep（发射点⑤）对「已终态 record」差集补 appendEntry 权威落盘。
   *
   * 依赖时序：须在 store 孤儿恢复（recoverOrphanRecords）之后调用——孤儿恢复已把
   * 「重启前在途且无 resumable 信号」的非 chatMode record 直断 closed（boot 直断的
   * 唯一实现锚点），并把 resumable 形态保留 running 落 entry（本方法的重认领源）。
   */
  bootPartition(): { readopted: string[] } {
    const readopted: string[] = [];
    if (this.disposed) return { readopted };
    for (const candidate of this.deps.listCandidateRecords()) {
      const view = this.deps.getRecordView(candidate.id);
      if (view === undefined || view.status !== "running") continue;
      // [H2 W2] adopt 链豁免域门（conversation 豁免 + workflow origin 豁免）：
      // classifySupervisorDomain 不把 workflow record 归入可 adopt 域（"run"）——
      // boot 重认领对 workflow 形态不生效（豁免落空面无「重认领后 2h 看门狗挂账」）。
      if (classifySupervisorDomain(view) !== "run") continue;
      // boot 分区只处理「孤儿恢复保留下来的 resumable 且无完成产出的形态」（W4 死亡
      // 纳管态跨重启）——in-flight 已被孤儿恢复直断（见头注），不再此处重复
      // 终态化（双收尾防线）；resumable 且 result 有值是 SP-5 完成态（已完成挂账，
      // idle-gc 锚归档收口，无需监督）。谓词与 record-store 孤儿恢复保留分支同源
      // （isBootReadoptable，domain.ts）。
      if (!isBootReadoptable(view)) continue;
      if (!this.supervised.has(view.id)) {
        this.supervised.set(view.id, { guidanceSent: false, timer: undefined });
      }
      readopted.push(view.id);
      this.evaluate(view.id);
    }
    if (readopted.length > 0) {
      logger.warn(
        `[round-supervisor] boot partition: readopted ${readopted.length} idle-resumable record(s): ${readopted.join(",")}`,
      );
    }
    return { readopted };
  }

  // ── 在途记账（subagent-service 报告）──────────────────────────────────

  /** run 发起（engine run / chat 轮 kickoff）：该等 → 不干预；解除看门狗等待。 */
  noteRunStarted(recordId: string): void {
    this.inFlightRuns.add(recordId);
    const entry = this.supervised.get(recordId);
    if (entry !== undefined) {
      // run 恢复 = 主 agent 决策已收敛（resume）——清指引标记与看门狗，回归该等。
      this.clearWatchdogTimer(entry);
      entry.guidanceSent = false;
    }
  }

  /** run 收口（终态迁移 / 失败 / 被杀）：驱动可能死亡 → 重新三态评估。 */
  noteRunEnded(recordId: string): void {
    this.inFlightRuns.delete(recordId);
    if (this.supervised.has(recordId)) {
      this.evaluate(recordId);
    }
  }

  // ── 三态判定 ──────────────────────────────────────────────────────────

  /** 单 record 三态评估（幂等；record 终态/消失即解除纳管）。 */
  private evaluate(recordId: string): void {
    if (this.disposed) return;
    const view = this.deps.getRecordView(recordId);
    const entry = this.supervised.get(recordId);
    if (view === undefined || entry === undefined) {
      this.release(recordId);
      return;
    }
    if (view.status !== "running") {
      // 终态 = 自然收口（finalizeRecord 已走注销①发射）——解除纳管。
      this.release(recordId);
      return;
    }
    const hasInFlight = this.inFlightRuns.has(recordId);
    const hasLive = this.deps.hasLiveProcess(recordId);
    if (hasInFlight || hasLive) {
      // 该等：不干预（解除看门狗等待——驱动存在即无需放弃计时）。
      this.clearWatchdogTimer(entry);
      return;
    }
    if (!isAwakeWarrantedShape(
      { status: view.status, resumable: view.resumable, chatMode: view.chatMode },
      hasInFlight,
      hasLive,
    )) {
      // conversation 豁免（纳管入口已滤，防御性到达）——不唤醒。
      return;
    }
    if (view.hasResult) {
      // 已有完成产出（SP-5 upgrade 等待态挂账归 idle-gc）——不唤醒。
      // [F5] 挂账态必须解除看门狗：此前的该唤醒评估可能已 armed，转挂账后 timer
      // 若留存，2h 到期会把已完成挂账 record 误 giveUp(watchdog-expired)。对照上方
      // 该等分支的清理形态——不再需要放弃计时的形态（有驱动 / 已收敛挂账）统一
      // 先清 timer 再退出。
      this.clearWatchdogTimer(entry);
      return;
    }
    // 该唤醒 → 通知对账（送指引前查替代）。
    // [H2 W2 / superseded 豁免] workflow origin 候选不参与替代判定——parallel 同
    // slug/同 agent 并行是 workflow 常态而非替代关系（replacedNotice「was already
    // replaced by your new task」会把并行任务误述为替代并错误终态化原任务）。
    const windowMs = getSupervisorWatchdogMs();
    const verdict = classifyReplacement(
      { id: view.id, rootSessionId: view.rootSessionId, agentName: view.agent, slug: view.slug },
      this.deps
        .listCandidateRecords()
        .filter((c) => c.origin !== "workflow")
        .map((c) => ({
          id: c.id,
          rootSessionId: c.rootSessionId,
          agentName: c.agent,
          slug: c.slug,
          startedAt: c.startedAt,
        })),
      windowMs,
      this.deps.now(),
    );
    if (verdict.kind === "high-confidence") {
      logger.warn(
        `[round-supervisor] record ${view.id} superseded by ${verdict.replacementId} ` +
          `(same root/agent/slug within watchdog window) — withdrawing guidance, giving up original`,
      );
      this.release(recordId);
      this.deps.sendReplacedNotice(view, verdict.replacementId);
      this.deps.giveUp(recordId, "superseded", { replacementId: verdict.replacementId });
      return;
    }
    // 低置信 / 无命中：送达决策指引（低置信自带豁免声明——把残余决策交还唯一
    // 决策者，不诱导冲突动作）；一窗内只送一次。
    if (!entry.guidanceSent) {
      this.deps.sendDecisionGuidance(view, {
        exemptionDisclaimer: verdict.kind === "low-confidence",
      });
      entry.guidanceSent = true;
    }
    this.armWatchdog(recordId, entry);
  }

  // ── 看门狗（该放弃）───────────────────────────────────────────────────

  private armWatchdog(recordId: string, entry: SupervisedEntry): void {
    this.clearWatchdogTimer(entry);
    if (isSupervisorGiveUpDisabled()) return;
    const windowMs = getSupervisorWatchdogMs();
    // 常量/env 值入口校验：防越界值静默引入 1ms 溢出语义反转（对齐 settled-watchdog）。
    assertSafeTimerDelay(windowMs, "round supervisor decision watchdog");
    const timer = setTimeout(() => {
      entry.timer = undefined;
      this.supervised.delete(recordId);
      const view = this.deps.getRecordView(recordId);
      if (view === undefined || view.status !== "running") return; // 已自然收口
      logger.warn(
        `[round-supervisor] decision watchdog expired for ${recordId} after ${windowMs}ms ` +
          `(guidance unanswered, no convergence) — giving up (failed + unregister + termination notice)`,
      );
      this.deps.giveUp(recordId, "watchdog-expired", {});
    }, windowMs);
    timer.unref?.();
    entry.timer = timer;
  }

  private clearWatchdogTimer(entry: SupervisedEntry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  /** 解除纳管（终态/消失/放弃后；幂等）。 */
  release(recordId: string): void {
    const entry = this.supervised.get(recordId);
    if (entry !== undefined) {
      this.clearWatchdogTimer(entry);
      this.supervised.delete(recordId);
    }
  }

  /** 纳管中的 record id（测试断言面）。 */
  supervisedIds(): string[] {
    return [...this.supervised.keys()];
  }

  /** ExecutionRecord → 视图（死亡事件纳管入口用——该路径恒有内存 record）。 */
  private toView(record: ExecutionRecord): SupervisorRecordView {
    return {
      id: record.id,
      status: record.status === "closed" ? "closed" : "running",
      resumable: record.resumable === true,
      hasResult: record.result !== undefined,
      chatMode: record.chatMode === true,
      origin: record.origin,
      rootSessionId: record.rootSessionId,
      agent: record.agent,
      slug: record.slug,
      startedAt: record.startedAt,
      closedReason: record.closedReason,
    };
  }

  /** dispose（session_shutdown 链）：清全部 timer + 纳管记账（注册/record 不动——
   *  process 档跨 shutdown 存活，重开 session 由 boot 分区重认领 + sweep 对账）。 */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.supervised.values()) {
      this.clearWatchdogTimer(entry);
    }
    this.supervised.clear();
    this.inFlightRuns.clear();
  }

  /** 测试隔离：重置 env 解析缓存（vi.stubEnv 改 env 后生效）。 */
  static _resetEnvCacheForTest(): void {
    watchdogEnvCache = undefined;
  }
}
