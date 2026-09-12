/**
 * SP-4 idle record GC：30 天 TTL 定时归档，防 idle record 永久驻留内存。
 * 从 subagent-service.ts 抽出（文件超 max-lines；逻辑自包含：interval + TTL 扫描）。
 * 启动幂等由调用方（service.startGcTimer）守卫；返回 stop 函数供 dispose 清理。
 *
 * [W4 idle-gc 扩展 · 设计 chat-domain-v1x-liveness-governance D4 连带面 2③]
 * 注册翻 process 档后的兜底通道扩展（与翻档同批生效，先行期 = 无兜底挂账窗口）：
 *  1. 锚扩展：无 idleSince 的 resumable record 以 startedAt（创建时确定，
 *     types.ts ExecutionRecord.startedAt）为锚——兜底定位 30 天量级终态归档，
 *     创建时锚的精度损失在该量级可接受（同设计对 record startedAt 的 rationale）。
 *  2. **只归档不补注销**：被归档 record 的注册注销统一交 core 注册对账 sweep
 *     （判据含「已归档 = 视同终态」）——归档跨 session record 时 appendEntry 只达
 *     当前 session entries（写达域无效），且 archive 不走 finalizeRecord、无注销
 *     发射枚举身份（发射点枚举 D2 的 5 处不含 GC）。
 *  3. WorkflowRun store 同批纳入：running 且 meta.startedAt 超 IDLE_TTL_MS 的 run
 *     终态化归档（transition("done","time_limited") + save 持久化终态）。时间锚选择
 *     = WorkflowRunMeta.startedAt（run 创建时刻，ISO string）——run 状态无 idleSince
 *     等价物，meta.completedAt 仅终态存在，startedAt 是唯一创建时确定的锚（与
 *     record startedAt 同 rationale）。**只终态化不补注销**同上：run 的注销发射
 *     身份在 transition("done") 路径（发射点③）与其宿主收口链，GC 不越权补发。
 */
import { getLogger } from "../core/logger.ts";
import { getEngineDataDir } from "./engine/common/data-dir.ts";
import { releasePoolRef } from "./engine/common/pool-manager.ts";
import { bestEffort } from "./best-effort.ts";
import { isResumable } from "./lifecycle-predicates.ts";
import type { RecordStore } from "./record-store.ts";
import type { ExecutionRecord } from "./types.ts";

const logger = getLogger("subagents");

/** GC 扫描间隔：1 小时。 */
// eslint-disable-next-line no-magic-numbers -- 60*60*1000 = 1h 的毫秒换算常数
const GC_INTERVAL_MS = 60 * 60 * 1000;
/** idle record TTL：30 天（超龄归档）。record 锚窗与 workflow run 锚窗共用。 */
// eslint-disable-next-line no-magic-numbers -- 30*24*60*60*1000 = 30d 的毫秒换算常数
const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 毫秒/天（GC 日志的 d 换算）。 */
// eslint-disable-next-line no-magic-numbers -- 24*60*60*1000 = 1d 的毫秒换算常数
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * WorkflowRun GC 窄口（idle-gc 对 WorkflowRun store 的最小依赖面，结构类型——
 * 调用方传 FileRunStore 实例即可，不 import orchestration 具体类，保持本模块
 * 可独立编译 + 单测）。loadAll 失败（宿主未 configureCore / IO 错）由实现侧
 * 或本模块 catch 吞掉，单轮跳过下轮重试。
 */
export interface WorkflowRunGcStore {
  loadAll(): Promise<Array<{ runId: string; state: { status: string }; meta: { startedAt: string }; transition(target: "done", reason?: string): void }>>;
  save(run: unknown): Promise<void>;
}

/**
 * 启动 idle record GC 定时器，返回 stop 函数（清理 interval；幂等）。
 * 每个扫描周期：
 *  - record 面：对 store 内全部 active record 中 resumable 的，锚点（idleSince
 *    优先，缺失回退 startedAt——[W4 锚扩展]）超过 IDLE_TTL_MS 的归档
 *    （[U2b] markIdleArchived：archive 先 + `.alive` release 后——归档 = 放弃持有
 *    即放弃写权声明，D3a release 出口②）。单条失败不阻断其余（bestEffort 留痕）。
 *    **只归档不补注销**（见文件头注）。
 *  - workflow 面（注入 workflowRuns 时）：running 且 meta.startedAt 超
 *    IDLE_TTL_MS 的 run 终态化归档（transition + save），单 run 失败不阻断。
 *
 * [D8 池引用计数接线] 归档时同步释放该 record 的引擎池引用（releasePoolRef：
 * journal 跟随 record 删除 + refs 移除 + 归零删池内原生状态）。锚点选在 30 天 TTL
 * 而非 dispose/archive 类时机，依据：idle record 30 天后引擎侧不会再有活动（archive
 * 后 message 续聊走 fork-from/新 start，不触原引擎），且与 pi 域 session 文件 30 天
 * TTL（session-file-gc 同期删①级读源）形成两引擎对称衰减；disposeAllRecords/close
 * 类时机 record 数据仍保留（可 resurrect / GUI 历史重建可见），journal（②级数据源）
 * 不能删——那是 record 主数据死亡（主 session 文件被 pi 侧删除，core 无触发点）才有
 * 的处置，由 cleanupExpiredPoolRefs 的 TTL 兜底覆盖。
 */
export function startIdleGc(store: RecordStore, workflowRuns?: WorkflowRunGcStore): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const record of store.listAllActive()) {
      if (!isResumable(record)) continue;
      // [W4 锚扩展] idleSince（轮终写点）优先；缺失（resumable 但无轮终信号的
      // 存量/异常形态）回退 startedAt（创建时确定）——两锚同为「最晚活性证据」，
      // 30 天量级下 created 锚的精度损失可接受。
      const anchorMs = record.idleSince ?? record.startedAt;
      const age = now - anchorMs;
      if (age > IDLE_TTL_MS) {
        logger.warn(
          `[subagents] GC: archiving idle record ${record.id} (idle for ${Math.round(age / MS_PER_DAY)}d)`,
        );
        try {
          // [U2b / D3a release 出口②] 归口 markIdleArchived：store.archive 先、`.alive`
          // release 后（写序在 store 内部——归档 = 放弃持有 = 放弃写权声明，残留声明
          // 会把 idle 归档后的预期通道 fork-from/新 start 拦死至宿主退出，纯成本零防御
          // 收益；归档 record 后续被接管时统一 acquireWriteLease 重新声明）。
          store.markIdleArchived(record);
        } catch (err) {
          bestEffort(err, `GC archive record ${record.id}`);
        }
        releaseEnginePoolRef(record);
      }
    }
    if (workflowRuns !== undefined) {
      void gcWorkflowRuns(workflowRuns, now);
    }
  }, GC_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * [W4 WorkflowRun store 纳入] running 且 startedAt 超锚窗的 run 终态化归档。
 * reason = "time_limited"（超龄归档语义的 DoneReason，对主 agent 的语义是
 * 「run 因超时被收口」而非 completed）。失败吞错留痕（清理是旁路维护，不能
 * 拖垮 GC interval；下轮重试）。
 */
async function gcWorkflowRuns(workflowRuns: WorkflowRunGcStore, now: number): Promise<void> {
  let runs: Awaited<ReturnType<WorkflowRunGcStore["loadAll"]>>;
  try {
    runs = await workflowRuns.loadAll();
  } catch (err) {
    // 宿主未 configureCore（core_host_not_configured）/ IO 失败：本轮跳过，
    // 下轮重试。debug 留痕——这是「workflow 域未启用」的正常形态，warn 会噪声。
    logger.debug(`[subagents] GC: workflow run store loadAll failed (skipped this cycle): ${
      err instanceof Error ? err.message : String(err)
    }`);
    return;
  }
  for (const run of runs) {
    if (run.state.status !== "running") continue;
    const startedMs = Date.parse(run.meta.startedAt);
    if (!Number.isFinite(startedMs)) continue; // 畸形锚不过判（宁挂账不失明）
    const age = now - startedMs;
    if (age <= IDLE_TTL_MS) continue;
    logger.warn(
      `[subagents] GC: terminating stale running workflow run ${run.runId} (started ${Math.round(age / MS_PER_DAY)}d ago)`,
    );
    try {
      run.transition("done", "time_limited");
      await workflowRuns.save(run);
    } catch (err) {
      bestEffort(err, `GC terminate workflow run ${run.runId}`);
    }
  }
}

/**
 * 释放 record 的引擎池引用（best-effort）。无 engineHandle（存量 record / 非引擎
 * 路径）时 no-op；engine 缺省投影 'pi'（与读侧存量 entry 零迁移口径一致）。
 */
function releaseEnginePoolRef(record: ExecutionRecord): void {
  const poolKey = record.engineHandle?.poolKey;
  if (poolKey === undefined) return;
  const engineId = record.engine ?? "pi";
  try {
    releasePoolRef(getEngineDataDir(), engineId, poolKey, record.id);
  } catch (err) {
    bestEffort(err, `GC release pool ref for record ${record.id}`);
  }
}
