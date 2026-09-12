// [D4-③ 冷路径查询职责轴 / H1 U6 改名] message action 冷查链（原 SubagentService
// 私有的 findColdLookupCandidate / assertReconnectAllowed / resurrectColdRecord /
// coldLookupForAction + isReconnectableClosed 判定，W3 后寄居 cold-resurrect.ts）。
// [H1 U6] cold-resurrect.ts 随 chat 域退役改名落位本文件：其中「跨重启磁盘重建无条件
// 置 chatMode=true」的升级语义已迁 Continuation D4 revive 格 + D5 gate
//（conversation-continuation.ts reviveOrThrow / subagent-actions-core messageHandler
// 双写点），本文件只保留冷查定位 / 可重连守卫 / 磁盘重建注册链——UF-1 跨重启续聊
// 绑定链（getRecordForAction → coldLookupForAction → 绑定重建 → Continuation）的
// 宿主侧解析承载。变化轴：改跨重启重建 / 透明重生回边 / 可重连守卫语义，只改本文件；
// Service 的 getRecordForAction 保留归属校验编排（内存未命中分支委托 coldLookupForAction）。

import { findForeignLiveInstance } from "./alive-store.ts";
import { createRecord } from "./execution-record.ts";
import type { StatusFilter } from "./record-store.ts";
import type { ExecutionRecord, SubagentRecord } from "./types.ts";
import { isReconnectableFinalReason, ResurrectDeniedError } from "./types.ts";

/** SP-2 冷路径按 id 查 record 的 collectRecords 扫描上限（全扫兜底的容量 cap）。
 *  原定义于 subagent-service.ts，随冷查链搬移；Service.lookupRecordAnyState
 *  （全态查询）同样消费本常量。 */
export const COLD_LOOKUP_SCAN_LIMIT = 1000;

/** 冷查/复活的依赖注入（Service 侧供给，store 查询 + 归属上下文）。 */
export interface ColdLookupDeps {
  /** store 的 idToFile 索引直查（light 快照）。 */
  findLightById: (id: string) => SubagentRecord | undefined;
  /** store 的磁盘全扫（内存未命中 / 索引未热时兜底）。rootFilter 恒 undefined
   *  （冷查不做 root 过滤——归属校验在候选定位之后，见 coldLookupForAction）。 */
  collectRecords: (limit: number, statusFilter: StatusFilter, rootFilter: undefined) => SubagentRecord[];
  /** 重建 record 注册进内存 store。（[U2a/B4] register 已收编进 markResurrected
   *  ——生产链不调用（resurrect 回边经 markResurrected 幂等再注册）；保留供编排层
   *  显式性与测试断言。） */
  register: (record: ExecutionRecord) => void;
  /** 重建后的 transition entry 上报（live ≡ reload 等价性——纯投递副作用，留编排层）。 */
  reportRecordTransition: (record: ExecutionRecord) => void;
  /** [U2a/B4] 透明重生回边原语（store.markResurrected，D3c 规格）：acquire-first
   *  三件套（写 .alive 写权声明 → 删 .state → 删 .finalized legacy）+ resurrectClosed
   *  内存翻回 + register，单 try 域原子收敛；任一步失败响亮抛错中止主流程。 */
  markResurrected: (record: ExecutionRecord, wasClosed: boolean) => void;
  /** 当前所属根 session id（归属校验用，运行时可变——initSession 建立）。 */
  getSessionRootId: () => string | null;
  /** 本进程嵌套基线 recordId（直接父校验用；根进程 undefined）。 */
  getBaselineRecordId: () => string | undefined;
}

/** 冷查候选定位（coldLookupForAction 步骤 1）：idToFile 索引直查 running 命中，
 *  未命中再全目录 collectRecords 兜底（running，或 allowReconnect 且可重连 closed）。
 *
 *  [T5③ / PS-7b] running 候选异进程活实例守卫：冷查 running 候选（跨重启 / 内存重建）
 *  此前不经任何探针直接 resurrect + resume spawn——若其 .alive marker 仍指向活着的
 *  异进程实例（父进程重启后旧子进程尚存的窗口），resume 会 spawn 第二个 pi 子进程
 *  写同一 session JSONL（本代码最忌惮的双写者形态，v4 A-5/P7 事故模式）。closed 候选
 *  的同款守卫已在 assertReconnectAllowed（v8.5 D）；本守卫闭合 running 候选的防御
 *  不对称。marker 的 pid 是**宿主进程** pid（D3d 失实注释修正：写者 = 宿主的写权声明
 *  acquire——resurrect 回边 / running 接管 / spawn 锚点确立，非子进程 pi 自写），本
 *  进程持有的 running record 恒在内存（archive 才移出），可达本冷查分支的 running
 *  候选必然来自磁盘重建——探针命中即拒绝（ResurrectDeniedError，与 closed 候选守卫
 *  同异常类型，错误含 pid 与恢复指引）。 */
function findColdLookupCandidate(
  deps: ColdLookupDeps,
  id: string,
  allowReconnect: boolean,
): SubagentRecord | undefined {
  const direct = deps.findLightById(id);
  const found =
    (direct?.status === "running" ? direct : undefined) ??
    deps
      .collectRecords(COLD_LOOKUP_SCAN_LIMIT, "all", undefined)
      .find((r) => r.id === id && (r.status === "running" || (allowReconnect && isReconnectableClosed(r))));
  if (found?.status === "running" && found.sessionFile) {
    const foreign = findForeignLiveInstance(found.sessionFile);
    if (foreign) {
      throw new ResurrectDeniedError(
        `subagent ${id} is currently running in another process instance (pid ${foreign.pid}, ` +
          `startedAt=${new Date(foreign.startedAt).toISOString()}); resuming here would double-write ${found.sessionFile}. ` +
          `Recovery: retry once that process exits; if it never exits, action:'close' this subagent, then action:'start' a fresh one.`,
      );
    }
  }
  return found;
}

/** [v8.5 D] 冷查候选过滤：closed 且死因落在可重连集。判定源 = closedReason（buildRecord
 *  归一化后的对外字段：A 档真实死因直通、旧空 sidecar 兑底 disconnected——SubagentRecord
 *  不暴露 raw finalizedReason）；cancelled/user-close/gc 等主动关闭与自然完成死因天然不在集合内。
 *  防线在集合本身而非调用点。 */
function isReconnectableClosed(r: SubagentRecord): boolean {
  return isReconnectableFinalReason(r.closedReason);
}

/** 可重连守卫（coldLookupForAction 步骤 2，[v8.5 D]）：先于任何状态突变与注册。
 *  worktree 绑定丢失 / 异进程活实例以 ResurrectDeniedError 抛出（endedMessageGuard
 *  必须原样透传，不得改写为 fork-from 指引误导 agent 走已被判死的通道）；拒绝时
 *  内存不得残留该记录（findRecord 契约）。 */
function assertReconnectAllowed(found: SubagentRecord, id: string): void {
  if (found.status !== "closed") return;
  if (found.worktree === true) {
    throw new ResurrectDeniedError(
      `subagent ${id} cannot be transparently resumed: it was created with worktree isolation, ` +
        `and its worktree checkout no longer exists after restart (resuming in place would make spawn cwd fall back to the main repo). ` +
        `Recovery: action:'start' a fresh subagent (with a new worktree if isolation is still needed); ` +
        `its conversation history remains intact at ${found.sessionFile}.`,
    );
  }
  const foreign = found.sessionFile ? findForeignLiveInstance(found.sessionFile) : undefined;
  if (foreign) {
    throw new ResurrectDeniedError(
      `subagent ${id} is not transparently resumable: its previous instance still finishing in another process ` +
        `(pid ${foreign.pid}, startedAt=${new Date(foreign.startedAt).toISOString()}). ` +
        `Resuming in place would double-write ${found.sessionFile}. ` +
        `Recovery: retry once that process exits; if it never exits, action:'start' a fresh subagent and treat the history at ${found.sessionFile} as read-only reference.`,
    );
  }
}

/** 磁盘候选重建为可变 record 并 register + 上报（coldLookupForAction 步骤 4）。 */
function resurrectColdRecord(
  deps: ColdLookupDeps,
  found: SubagentRecord,
  id: string,
): ExecutionRecord {
  const record = createRecord(id, {
    agent: found.agent,
    model: found.model,
    thinkingLevel: found.thinkingLevel,
    mode: found.mode,
    task: found.task,
    slug: found.slug,
    startedAt: found.startedAt,
    rootSessionId: found.rootSessionId,
    parentRecordId: found.parentRecordId,
    depth: found.depth,
    // [v4 A-3 → H1 U6 / D4-D5] 水合保留持久化 chatMode（UF-1 绑定 sidecar 的身份域
    // 投影，record-store buildRecord 已承载）：磁盘上是什么就是什么。原「无条件置
    // chatMode=true」的升级语义迁 Continuation D4 revive 格 + D5 gate 双写点
    //（one-shot 跨重启重建 chatMode=false 后收到 message → gate 放行 → 升级置位再续聊）。
    chatMode: found.chatMode === true,
    controller: new AbortController(),
  });
  record.sessionFile = found.sessionFile;
  record.round = found.round;
  // [review round2] 跨重启 worktree 绑定丢失防护：原 record 创建时启用了 worktree 隔离
  //（session entry 的 worktree 标志），但 WorktreeHandle 不可序列化、重建后恒缺失。
  // 标记 hadWorktree，冷路径续轮守卫据此拒绝续聊（防 spawn cwd 静默回落主 repo 破坏
  // 隔离——正是 worktree 要防的并发写冲突场景）。close 不受影响（closeChatIdle 走
  // doFinalizeRecord，泄漏的 worktree 由 reaper 兜底回收）。
  record.hadWorktree = found.worktree === true;
  // [U2a/B4 → D3c] 透明重生回边整体收编 store.markResurrected：acquire-first 顺序
  // （写 .alive 写权声明 → 删 .state → 删 .finalized legacy）+ resurrectClosed 内存
  // 翻回 + register，单 try 域原子收敛。准入唯一依据 = A 档 sidecar 真实死因 ∈ 可重连
  // 集（守卫已在上方跑完）；reportTransition（entry 上报）留本编排层（纯投递副作用，
  // 失败不破坏状态一致性）。
  // 两种接管形态统一 acquire（D3c）：closed 候选（wasClosed=true）三件套全量；running
  // 候选接管（跨重启磁盘重建，wasClosed=false）跳过删终态位（无 .state 可删）**仍
  // acquire marker**——「接管即声明」，现状此路径不写 marker 的 B/C 双写窗随归口消灭。
  // 失败语义 = 响亮抛错中止主流程（§3.4）：acquire 失败 = 双写风险敞口，禁止
  // best-effort 吞错续跑（旧「单 try 吞错后继续 resurrectClosed + register」形态随
  // 归口消灭）；acquire-first 顺序保证失败时终态位未删、磁盘保持旧形态（可重试）。
  const wasClosed = found.status !== "running";
  deps.markResurrected(record, wasClosed);
  if (wasClosed) {
    // 重生后立刻上报 transition entry（live/reload 视图同步翻回 running，等价性由
    // applyEntry reducer 保证，对齐 SP-2 重建即报告先例）。
    deps.reportRecordTransition(record);
  }
  return record;
}

/** [D4-③] 冷查编排（原 Service.coldLookupForAction）：getRecordForAction 内存未命中
 *  分支——候选定位 → 可重连守卫 → 归属/直接父校验 → 重建注册。
 *  @returns 重建的 record；磁盘也无则 undefined
 *  @throws ResurrectDeniedError 可重连候选被 worktree/异进程活实例守卫拦截
 *  @throws Error parentRecordId 跨层不匹配（direct parent 错误，与外层校验同文案） */
export function coldLookupForAction(
  deps: ColdLookupDeps,
  id: string,
  allowReconnect: boolean,
): ExecutionRecord | undefined {
  const found = findColdLookupCandidate(deps, id, allowReconnect);
  if (!found) return undefined;
  // [v8.5 D] 可重连候选的守卫先于任何状态突变与注册（细节见 assertReconnectAllowed）
  assertReconnectAllowed(found, id);
  // [review MF-9] 归属校验先于任何持久化副作用：coldLookup 是 getRecordForAction 的
  // 内存未命中分支，若先 resurrect/register/report 再由调用方抛归属错误，会在磁盘/
  // 内存留下幽灵 running record + running transition entry（跨进程双 resurrect 窗口）。
  // rootSessionId 不匹配 → 返回 undefined，由 getRecordForAction 抛统一「not found or
  // not owned」（不区分失败形态，防跨 session 探测）；parentRecordId 跨层不匹配 →
  // 原样抛 direct parent 错误（与外层校验同文案，保留跨层导航指引）。
  if (found.rootSessionId !== deps.getSessionRootId()) {
    return undefined;
  }
  const baselineRecordId = deps.getBaselineRecordId();
  if (found.parentRecordId !== baselineRecordId) {
    throw new Error(
      `subagent ${id} is owned by its direct parent; message it through that parent ` +
        `(see /subagents list, parent=${found.parentRecordId ?? "(root layer)"}). [v4 A-5] cross-layer ` +
        `ownership guard: this process's baseline=${baselineRecordId ?? "(root)"} is not the direct parent of ${id}; ` +
        `operating here would race the owning child process's handle and double-write the session file.`,
    );
  }
  return resurrectColdRecord(deps, found, id);
}
