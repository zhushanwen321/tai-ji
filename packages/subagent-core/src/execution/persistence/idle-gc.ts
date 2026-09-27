/**
 * SP-4 idle record GC：30 天 TTL 定时内存回收，防 idle record 永久驻留内存。
 * 从 subagent-service.ts 抽出（文件超 max-lines；逻辑自包含：interval + TTL 扫描）。
 * 启动幂等由调用方（service.startGcTimer）守卫；返回 stop 函数供 dispose 清理。
 *
 * [W4 idle-gc 扩展 · 设计 chat-domain-v1x-liveness-governance D4 连带面 2③]
 * 注册翻 process 档后的兜底通道扩展（与翻档同批生效，先行期 = 无兜底挂账窗口）：
 *  1. 锚扩展：无 idleSince 的可回收 record 以 startedAt（创建时确定，
 *     types.ts ExecutionRecord.startedAt）为锚——兜底定位 30 天量级回收，
 *     创建时锚的精度损失在该量级可接受（同设计对 record startedAt 的 rationale）。
 *  2. **只回收不补注销**：被回收 record 的注册注销统一交 core 注册对账 sweep
 *     （判据含「已回收 = 视同终态」）——回收跨 session record 时 appendEntry 只达
 *     当前 session entries（写达域无效），且 archive 不走 finalizeRecord、无注销
 *     发射枚举身份（发射点枚举 D2 的 5 处不含 GC）。
 *  3. WorkflowRun store 同批纳入：超龄 run 终局化。[W2/V1 D1/D3] 记录动作改走
 *     收编入口 adoptInterruptedRun 终局记录原语（journal run-settled 帧 +
 *     manifest 物化两件直落，outcome='interrupted' + errorCode='idle-evicted'——
 *     管理性回收 = 被动终局，不稀释 cancelled 的主动语义；原 `transition("done",
 *     "time_limited") + save` 两态机活体写点已随 W2/V1 退役）。**收编形态按 run
 *     的 session 归属区分**（[W2 D3] 形态区分裁决）：
 *     - cross-session（run 属旧 session，30 天档常态）：journal + manifest 两件
 *       直落；条目/注销依赖宿主 session 重开自愈（loadAll 的
 *       appendSettledEntryFallback 补条目 + reconcile-sweep 补注销，判据源 = D6
 *       改接后的 fold/manifest 终态证据）——与 abandon 侧对称的「不新增跨 session
 *       写通道」裁决（appendEntry 对旧 session run 写达域无效）。
 *     - same-session（run 属当前 session）：**四件直落齐套**——两件之外，终态
 *       条目 + pending 注销条目经注入面直落当前 session entries（写达域有效）。
 *       归属判定锚 = 当前 session 的活跃注册差集（collectActiveRegisterEntries）；
 *       注销 reason 经 runSettledOutcomeToDoneReason 联合派生单点（D5 五处统一）。
 *     时间锚 = WorkflowRunMeta.startedAt（run 创建时刻 ISO string）；终局判定
 *     由原语的幂等前置承接（fold 终态 / manifest / 条目三面证据——不裸读快照
 *     status 字段，快照已终局的 run 命中 skippedTerminal 幂等跳过）。
 */
import { mapReasonToStatus } from "@zhushanwen/extension-protocol";
import { toErrorMessage } from "../../core/error-message.ts";
import { isHostNotConfiguredError } from "../../core/host-services.ts";
import { getLogger } from "../../core/logger.ts";
import { bestEffort } from "../assembly/best-effort.ts";
import { isResumable } from "../lifecycle/lifecycle-predicates.ts";
import { collectActiveRegisterEntries } from "../round-supervisor/reconcile-sweep.ts";
import type { RecordStore } from "./record-store.ts";
import {
  writePendingUnregisterEntryVia,
  writeSettledRecordEntryVia,
} from "../../orchestration/lifecycle.ts";
import {
  buildWorkflowRecordSettledEntryData,
  runSettledOutcomeToDoneReason,
} from "../../orchestration/worker-message-pump.ts";
import { adoptInterruptedRun } from "../../orchestration/run-registry.ts";

const logger = getLogger("subagents");

/** GC 扫描间隔缺省：1 小时。 */
// eslint-disable-next-line no-magic-numbers -- 60*60*1000 = 1h 的毫秒换算常数
const GC_INTERVAL_MS = 60 * 60 * 1000;
/** idle record TTL 缺省：30 天（超龄回收）。record 锚窗与 workflow run 锚窗共用。 */
// eslint-disable-next-line no-magic-numbers -- 30*24*60*60*1000 = 30d 的毫秒换算常数
const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 毫秒/天（GC 日志的 d 换算）。 */
// eslint-disable-next-line no-magic-numbers -- 24*60*60*1000 = 1d 的毫秒换算常数
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── [W2/V1 场景 3] idle 测试调短通道两 env 旋钮（决策 8）──────────────
//
// TTL 定超龄判据、interval 定回收节奏，两旋钮缺一不可：TTL 调短只让 run 变
// 超龄，回收动作本身仍要等下一轮 interval 定时器。解析语义（与 abandon 窗先例
// 的 opt-out 语义**不同款**，决策 8 裁决）：
// - 未设/空 → 缺省回退现状常量（TTL 30 天、interval 1h——生产行为不变）；
// - 非法值（非有限数/≤0）→ 回退缺省并 warn 留痕——不照搬 abandon 先例的
//   「非法 = opt-out 不终局化」：idle 侧整款照搬即 GC timer 整体停摆、30 天
//   回收上界失效（风险侧方向相反），不采用；warn 防刷屏（每进程每旋钮一次）。

/** run idle TTL env 通道（TAIJI_ 前缀理由对齐 abandon 窗先例 RUN_ABANDON_WINDOW_MS_ENV）。 */
export const WORKFLOW_RUN_IDLE_TTL_MS_ENV = "TAIJI_WORKFLOW_RUN_IDLE_TTL_MS";
/** GC 扫描间隔 env 通道。 */
export const WORKFLOW_RUN_GC_INTERVAL_MS_ENV = "TAIJI_WORKFLOW_RUN_GC_INTERVAL_MS";

const envWarned = new Set<string>();

/** 通用解析：未设/空 → 缺省；非法值（非有限数/≤0）→ 回退缺省 + warn 留痕。 */
function resolveMsEnv(
  envName: string,
  fallbackMs: number,
  label: string,
): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (!envWarned.has(envName)) {
      envWarned.add(envName);
      logger.warn(
        `[subagents] GC: ${envName}="${raw}" is not a finite positive number — ` +
          `falling back to the default ${label} (${fallbackMs}ms). ` +
          "Fix: unset the env or set a finite positive integer (milliseconds).",
      );
    }
    return fallbackMs;
  }
  return parsed;
}

/** 解析 run idle TTL：env 未设/空 → 缺省 30 天；非法值 → 缺省 + warn。 */
export function resolveWorkflowRunIdleTtlMs(): number {
  return resolveMsEnv(WORKFLOW_RUN_IDLE_TTL_MS_ENV, IDLE_TTL_MS, "idle TTL");
}

/** 解析 GC 扫描间隔：env 未设/空 → 缺省 1 小时；非法值 → 缺省 + warn。 */
export function resolveWorkflowRunGcIntervalMs(): number {
  return resolveMsEnv(WORKFLOW_RUN_GC_INTERVAL_MS_ENV, GC_INTERVAL_MS, "GC interval");
}

/**
 * WorkflowRun GC 窄口（idle-gc 对 WorkflowRun store 的最小依赖面，结构类型——
 * 调用方传 FileRunStore 实例即可，不 import orchestration 具体类，保持本模块
 * 可独立编译 + 单测）。loadAll 失败（宿主未 configureCore / IO 错）由实现侧
 * 或本模块 catch 吞掉，单轮跳过下轮重试。
 *
 * [W2/V1] transition/save 成员删除：终局化经收编原语（journal/manifest 写面，
 * 不经两态机快照）——快照写面不再是 GC 的职责（判据读者已随 D6 改接换源）。
 */
export interface WorkflowRunGcStore {
  loadAll(): Promise<Array<{ runId: string; state: { status: string }; meta: { startedAt: string } }>>;
}

/**
 * [W2/V1 D3 same-session 四件直落] 当前 session 直落面（全部惰性 getter——pi/
 * 主 session 文件 initSession 注入、dispose 翻转，运行时可变；对齐 notify-host
 * deps 惰性求值先例）。缺省不注入 = 全部 run 按 cross-session 两件直落（保守侧，
 * 与收编原语缺省行为一致）。
 */
export interface WorkflowRunGcSessionFace {
  /** 主 session 文件现读（run 归属判定锚——活跃注册差集证据源；undefined = 无
   *  判定通道，本轮全部按 cross-session 两件直落）。 */
  readonly sessionFile: () => string | undefined;
  /** 权威直落现读（终态条目/注销条目写当前 session entries；dispose 后 pi 置
   *  null，闭包内部现读 → no-op，对齐 notify-host「pi 缺席静默丢弃」语义）。 */
  readonly appendEntry: () => (customType: string, data: unknown) => void;
}

/**
 * 启动 idle record GC 定时器，返回 stop 函数（清理 interval；幂等）。
 * 每个扫描周期：
 *  - record 面：对 store 内全部 active record 中 resumable（[U5/D4] idle 派生——
 *    GC 候选从「running 桥接形态」扩张到全部 idle，含中断族 idle / `.state` 重建
 *    idle；W4 死亡纳管态 running 退出候选，supervisor 接管链 settle 后落 idle 回到
 *    候选集，设计待验证①范围扩张已接受）的，锚点（idleSince
 *    优先，缺失回退 startedAt——[W4 锚扩展]）超过 TTL 的回收
 *    （[U2b] markIdleEvicted：archive 先 + `.alive` release 后——回收 = 放弃持有
 *    即放弃写权声明，D3a release 出口②）。单条失败不阻断其余（bestEffort 留痕）。
 *    **只回收不补注销**（见文件头注）。
 *  - workflow 面（注入 workflowRuns 时）：超龄 run 交收编入口终局化
 *    （[W2/V1 D3] adoptInterruptedRun 原语——outcome='interrupted' +
 *    errorCode='idle-evicted'，幂等前置承接终局判定），单 run 失败不阻断。
 *    收编件数按 run 的 session 归属区分（[W2 D3] 形态区分裁决，见文件头注）：
 *    same-session 四件直落齐套（sessionFace 注入 + 注册差集命中），cross-session
 *    两件直落（条目/注销重开自愈）。
 *
 * [池抽象降级 2026-09-13] 原「回收时同步释放该 record 的引擎池引用」（releasePoolRef）
 * 接线已删除——refs 引用计数机制整体退役，record 的 journal 回收统一由
 * pool-manager cleanupExpiredJournals 的 30 天 mtime TTL 兜底（record 主数据死亡对
 * core 无触发点，mtime 是唯一可观测锚）。
 */
export function startIdleGc(
  store: RecordStore,
  workflowRuns?: WorkflowRunGcStore,
  sessionFace?: WorkflowRunGcSessionFace,
): () => void {
  // 启动可观测行（debug 级：core facade 无 info 方法，debug 仅在
  // TAIJI_AGENT_DEBUG=1 时落盘——排障时开该 env；W2 D3 真机链教训：timer
  // 轮询本身无日志，env 未达时表现为「静默零动作」，与扫描面空载不可区分，
  // 只能靠此行裁决 interval 实际值与读侧 store 注入形态）。
  logger.debug(
    `[subagents] GC: idle-gc timer started (interval=${resolveWorkflowRunGcIntervalMs()}ms, ` +
      `ttl=${resolveWorkflowRunIdleTtlMs()}ms, workflowRuns=${workflowRuns !== undefined ? "injected" : "default"})`,
  );
  const timer = setInterval(() => {
    const now = Date.now();
    // [U5/D4] 扫描面 = 全部内存 record（listAllInMemory）——判据 isResumable 已改
    // idle 派生，候选集（idle record）不在 listRunningMutable 的 running 过滤结果里。
    const ttlMs = resolveWorkflowRunIdleTtlMs();
    for (const record of store.listAllInMemory()) {
      if (!isResumable(record)) continue;
      // [W4 锚扩展] idleSince（轮终写点）优先；缺失（无轮终信号的存量/异常形态）
      // 回退 startedAt（创建时确定）——两锚同为「最晚活性证据」，
      // 30 天量级下 created 锚的精度损失可接受。
      const anchorMs = record.idleSince ?? record.startedAt;
      const age = now - anchorMs;
      if (age > ttlMs) {
        logger.warn(
          `[subagents] GC: evicting idle record ${record.id} (idle for ${Math.round(age / MS_PER_DAY)}d)`,
        );
        try {
          // [U2b / D3a release 出口②] 归口 markIdleEvicted：store.archive 先、`.alive`
          // release 后（写序在 store 内部——回收 = 放弃持有 = 放弃写权声明，残留声明
          // 会把 idle 回收后 message 同 id 续聊的冷查重建 + 新轮 spawn 通道拦死至宿主
          // 退出，纯成本零防御收益；回收 record 后续被接管时统一 acquireWriteLease
          // 重新声明）。
          store.markIdleEvicted(record);
        } catch (err) {
          bestEffort(err, `GC evict record ${record.id}`);
        }
      }
    }
    if (workflowRuns !== undefined) {
      void gcWorkflowRuns(workflowRuns, now, sessionFace);
    }
  }, resolveWorkflowRunGcIntervalMs());
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * [W4 WorkflowRun store 纳入 / W2/V1 D3 改走收编原语] 超龄 run 终局化。
 * 候选 = 快照 running 且 startedAt 超锚窗（status 粗筛只做廉价预筛：v2 终局 run
 * 的快照 status 停更 running，交原语后由三面证据幂等跳过）；终局判定权威 =
 * adoptInterruptedRun 幂等前置（fold 终态 / manifest / 条目——不裸读快照字段
 * 判终局，分流表 idle-gc 判活行）。失败吞错留痕（清理是旁路维护，不能拖垮 GC
 * interval；下轮重试——原语幂等，重试安全）。
 *
 * 收编件数按 run 的 session 归属区分（[W2 D3] 形态区分裁决）：归属锚 = 当前
 * session 活跃注册差集（collectActiveRegisterEntries——注册条目在本 session
 * 文件里 ⟺ appendEntry 写达域有效）。same-session 四件直落齐套（journal 帧 +
 * manifest + 终态条目 + 注销条目）；cross-session 两件直落（条目/注销依赖宿主
 * session 重开自愈，不新增跨 session 写通道——与 abandon 侧对称裁决）。
 * 直落失败（appendEntry 抛错）不重试本轮——残差交 reconcile-sweep 自愈（判据源
 * 已改接 fold/manifest 终态证据，与「直落失败窄竞态交 sweep」同构）。
 */
async function gcWorkflowRuns(
  workflowRuns: WorkflowRunGcStore,
  now: number,
  sessionFace?: WorkflowRunGcSessionFace,
): Promise<void> {
  let runs: Awaited<ReturnType<WorkflowRunGcStore["loadAll"]>>;
  try {
    runs = await workflowRuns.loadAll();
  } catch (err) {
    // 读失败与「域未启用」分通道（2026-09-17 错误处理审查 A11）：宿主未
    // configureCore（core_host_not_configured）= workflow 域未启用的正常形态，
    // debug 不噪声；其余（真 IO 故障）warn 留痕——静默跳过会把持续故障伪装成
    // 「无 run 可回收」，超龄 run 永不终态化且无从归因。两通道均单轮跳过下轮重试。
    const message = toErrorMessage(err);
    if (isHostNotConfiguredError(err)) {
      logger.debug(`[subagents] GC: workflow run store loadAll skipped (domain not enabled): ${message}`);
    } else {
      logger.warn(`[subagents] GC: workflow run store loadAll failed (skipped this cycle): ${message}`);
    }
    return;
  }
  const ttlMs = resolveWorkflowRunIdleTtlMs();
  // [W2/V1 D3 same-session 归属判定] 当前 session 活跃注册集（每轮现读——主
  // session 文件 initSession 注入运行时可变；文件不可读返回空集 = 本轮全部按
  // cross-session 两件直落，保守侧与重开自愈兜底等价，无回归）。
  const sessionFile = sessionFace?.sessionFile();
  const currentSessionRunIds =
    sessionFace !== undefined && sessionFile !== undefined
      ? new Set(collectActiveRegisterEntries(sessionFile).map((e) => e.id))
      : new Set<string>();
  for (const run of runs) {
    if (run.state.status !== "running") continue; // 廉价预筛（终局判定权威在原语幂等前置）
    const startedMs = Date.parse(run.meta.startedAt);
    if (!Number.isFinite(startedMs)) continue; // 畸形锚不过判（宁挂账不失明）
    const age = now - startedMs;
    if (age <= ttlMs) continue;
    const sameSession = currentSessionRunIds.has(run.runId);
    logger.warn(
      `[subagents] GC: terminating stale running workflow run ${run.runId} (started ${Math.round(age / MS_PER_DAY)}d ago` +
        `${sameSession ? ", same-session full accounting" : ""})`,
    );
    try {
      // [W2/V1 D3] 收编入口：journal 帧 + manifest 两件直落（outcome='interrupted'
      // + errorCode='idle-evicted'——管理性回收归被动终局）。same-session 追注
      // 终态条目回调（③——写达域有效）；cross-session 不传（缺省 = 不写，跨
      // session 写达域约束，重开自愈——D3 裁决，见文件头注）。
      const adopted = await adoptInterruptedRun(run.runId, {
        outcome: "interrupted",
        errorCode: "idle-evicted",
        reason: "idle run evicted after retention TTL",
        ...(sameSession
          ? {
              appendSettledEntry: (entry: ReturnType<typeof buildWorkflowRecordSettledEntryData>) => {
                // customType 绑定经白名单宿主薄写函数（R3 写面守卫：run 族
                // customType 常量不出现在消费侧文件，见 lifecycle.ts 薄写函数注释）。
                const write = sessionFace?.appendEntry();
                if (write) writeSettledRecordEntryVia(write, entry);
              },
            }
          : {}),
      });
      if (adopted === "adopted" && sameSession) {
        // 注销条目④直落（写达域有效；仅恰在本轮收编成功时发——上轮已收编而注销
        // 直落失败的残差交 reconcile-sweep 自愈，不在原语幂等跳过路径上重发）。
        // reason 经 runSettledOutcomeToDoneReason 联合派生单点（[W2 D5] 五处统一
        // ——interrupted → "failed" 诊断兜底容器，细分语境由帧 errorCode 保留）；
        // status 经 protocol mapReasonToStatus 单点映射（与 sweep 补注销同款）。
        const reason = runSettledOutcomeToDoneReason("interrupted", "idle-evicted");
        const unregisterWrite = sessionFace?.appendEntry();
        if (unregisterWrite) {
          writePendingUnregisterEntryVia(unregisterWrite, {
            id: run.runId,
            reason,
            status: mapReasonToStatus(reason),
          });
        }
      }
      if (adopted !== "adopted") {
        logger.debug(
          `[subagents] GC: stale workflow run ${run.runId} not adopted (${adopted}) — skip this cycle`,
        );
      }
    } catch (err) {
      bestEffort(err, `GC terminate workflow run ${run.runId}`);
    }
  }
}
