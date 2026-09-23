// src/execution/persistence/record-store-terminal.ts
//
// [H4 三轴拆分 / 终态原语轴] RecordStore 终态/settle/收口动作原语的实现体：
//   - legacy 终态族（markFinalized / markCancelled——workflow D7 例外族专用，U5 退役）；
//   - settle / 收口动作族（markSettled / markReopened / markSettledOut /
//     markIdleEvicted——永久会话模型 §3.2.2/§3.2.5）；
//   - 磁盘终态位翻活（markResurrected）；[collect 退役] 原 sync 批终态
//     （markBatchFinalized）已随批机制删除；
//   - binding settle 快照族（settleSnapshotPatch / fullBindingPayload /
//     persistSettleSnapshot——U7 统计口径的写侧载荷）与写权 release 锚分派
//     （releaseWriteLeaseImpl）。
//
// 变化轴 = 「record 持久化终态/收口写面的编排规则」：写序（D8 v7）、锚分派
// （pi/zcode 双腿）、CAS 语义、词汇双写投影的选择集中在此文件。
//
// [D7 写面约束] 本文件不 import 任何 `.state`/`.alive`/manifest 写函数——
// 七名写函数的调用字面只留在 record-store.ts（守卫 R1 与 eslint
// no-restricted-imports 的白名单物理边界），经 TerminalCtx 注入（ctx 字段名
// 刻意避开七名：persistFinalized / acquireLease / releaseLease）。
// 依赖方向单向：terminal → rebuild（投影），rebuild/rounds 不回 import 本文件。

import * as fs from "node:fs";

import { getLogger } from "../../core/logger.ts";

import { resurrectClosed } from "./execution-record.ts";
import { updateRecordBinding, writeRecordBinding, readRecordBinding, zcodeAnchorBasePath, STATE_SIDECAR_EXT } from "./state-marker.ts";
import type { RecordBinding } from "./state-marker.ts";
import type { ManifestRecord } from "./manifest-store.ts";
import { derivedManifestRecord, hydrateReviveBaseline, recordToSubagent, zcodeRefOf } from "./record-store-rebuild.ts";
import { findForeignLiveInstance } from "./alive-store.ts";
import { ResurrectDeniedError, isPiTranscriptRef } from "../assembly/types.ts";
import type { ClosedReason, ExecutionRecord, StopReason, SubagentRecord, TranscriptRef } from "../assembly/types.ts";

const logger = getLogger("subagents");

/** [D8 v7] manifest 同步写的 JSON 缩进空格数——与 ManifestStore.writeManifest 字节
 *  形态一致（读写两侧格式互认，外部 session-reader 直读不感知差异）。 */
export const MANIFEST_INDENT_SPACES = 2;

/**
 * 终态原语实现的 store 通道（D7 写面注入）。record-store.ts 构造时绑定真实写函数
 * 与容器方法——注入名刻意避开 R1 七名（writeFinalizedState 等），保证本文件可被
 * check-record-write-surface 扫描而不命中（写面唯一入口语义仍收口在 store 家族）。
 */
export interface TerminalCtx {
  /** `.state` finalized 收条写（writeFinalizedState 注入位）。 */
  persistFinalized: (sessionFile: string, reason?: string) => boolean;
  /** `.state` cancelled 收条写（writeCancelledState 注入位）。 */
  persistCancelled: (sessionFile: string, endedAt: number) => boolean;
  /** `.state` settle 收条写（writeSettledState 注入位）。 */
  persistSettledState: (sessionFile: string, payload: { stopReason?: StopReason; endedAt?: number }) => boolean;
  /** `.alive` 写权声明（writeAliveMarker 注入位）。 */
  acquireLease: (sessionFile: string, marker: { pid: number; id: string; startedAt: number }) => void;
  /** `.alive` 写权释放（removeAliveMarker 注入位）。 */
  releaseLease: (sessionFile: string) => void;
  /** [D8 v7] manifest 同步写目录（构造时快照；undefined = 纯内存测试形态）。 */
  manifestDir: string | undefined;
  archive: (record: ExecutionRecord) => void;
  register: (record: ExecutionRecord) => void;
  reportRecordTransition: (record: ExecutionRecord) => void;
  reportSubagentRecord: (record: SubagentRecord) => void;
  /** manifest 落盘统一通道（record-store.ts 私有 writeManifestPersisted 注入位）。 */
  writeManifestPersisted: (id: string, manifest: ManifestRecord) => void;
  /** 终态 manifest 落盘（record-store.ts 私有 writeTerminalManifest 注入位）。 */
  writeTerminalManifest: (record: ExecutionRecord) => void;
  notifyChange: () => void;
}

/**
 * legacy 终态族的共用写序编排（D8 v7）：`.state` writeSync **先**（persist 失败 →
 * 返回 false，零持久化副作用）→ binding usage 快照 → archive → 终态 manifest 后 →
 * `.alive` 删除（release 出口①）。markFinalized / markCancelled 差异仅在 `.state`
 * persist 注入与 warn 标签，编排规则单源于此。
 *
 * 失败语义（§3.4）：`.state` 重试耗尽仍未落 → 返回 false，**零持久化副作用**（不
 * archive / 不写 manifest / 不 release 写权声明）——record 留 running 形态（磁盘无
 * 终态位，下次 boot 孤儿恢复终态化承接）；错误已在 state-marker 层 error 级响亮暴露。
 */
function legacyTerminalWrite(
  record: ExecutionRecord,
  persist: (sessionFile: string) => boolean,
  label: string,
  ctx: TerminalCtx,
): boolean {
  if (record.sessionFile !== undefined) {
    if (!persist(record.sessionFile)) return false;
    // 终态 usage 快照随 binding 落盘（维持 doFinalizeRecord Step3a 现状——light
    // 列表面的唯一低成本 usage 源）。binding 内部 best-effort（缺失不造残缺身份）。
    updateRecordBinding(record.sessionFile, {
      totalTokens: record.totalTokens,
      turns: record.turnCount,
      endedAt: record.endedAt,
    });
  } else {
    logger.warn(`[subagents] ${label}: no sessionFile anchor, .state face skipped`, {
      detail: { id: record.id },
    });
  }
  ctx.archive(record);
  ctx.writeTerminalManifest(record);
  if (record.sessionFile !== undefined) ctx.releaseLease(record.sessionFile);
  return true;
}

/**
 * 意图原语：正常终态（含 disposeAllRecords 编排性关闭，reason=parent-*，D8 矩阵）。
 * 只吸收**持久化面**——collectPatch / worktree cleanup / pending 注销① / onFinalized
 * 钩子留调用方编排（§3.1 副作用边界）。内存终态冻结（completeRecord/tryTransition
 * 桥接：置 idle + closedReason/stopReason 双写）亦留调用方——状态机操作非文件布局。
 *
 * [U2 桥接期] 永久会话模型下终态概念删除，本原语保留旧持久化编排直至 U5 收口动作
 * 接线退役（正常收口归 markSettled、close 收口归 markSettledOut、编排性关闭归新编排）；
 * `.state` 旧格式由 U3 读侧单规则上行映射（finalized → idle + stopReason=reason）。
 *
 * @returns true = 持久化面完成；false = `.state` 未落（record 不应被视作已终态化）。
 * @deprecated U5 退役（归 markSettled / markSettledOut / 编排性关闭新编排承接）。
 */
export function markFinalizedImpl(record: ExecutionRecord, closedReason: ClosedReason | undefined, ctx: TerminalCtx): boolean {
  const reason = closedReason ?? record.closedReason ?? "gc";
  return legacyTerminalWrite(record, (sessionFile) => ctx.persistFinalized(sessionFile, reason), "markFinalized", ctx);
}

/**
 * 意图原语：取消终态（tombstone）。写序与失败语义同 markFinalized（D8 v7）；区别
 * 仅 `.state` 载荷 = {status:"cancelled", endedAt}（重建判定分支消费精确结束时间）。
 * 归口写点：cancelBackground 终态写面（record-lifecycle，U2a 迁移）。
 *
 * [U2 桥接期] 新模型下 cancel = 中断当前轮回 idle（不终态化，stopReason=interrupted）
 * ——U5 意愿动作接线后本原语退役为 markSettled("interrupted") 路径。
 *
 * @deprecated U5 退役（cancel 语义归 markSettled("interrupted") + 放弃轮标记）。
 */
export function markCancelledImpl(record: ExecutionRecord, ctx: TerminalCtx): boolean {
  return legacyTerminalWrite(
    record,
    (sessionFile) => ctx.persistCancelled(sessionFile, record.endedAt ?? Date.now()),
    "markCancelled",
    ctx,
  );
}

// [collect 退役] 原 markBatchFinalizedImpl（sync 批终态统一写点）已随批机制整体删除。

/**
 * 意图原语：磁盘终态位翻回活态（透明重生回边整体收编，D3c 规格）。
 *
 * acquire-first 顺序（单 try 域原子收敛）：写 `.alive` 写权声明（acquire）→ 删
 * `.state` → 删 `.finalized`/`.cancelled` legacy（读侧兼容回退认领旧名，残留未删
 * 则重建仍读出终态），随后 resurrectClosed 内存翻回 + register——
 * 任一步失败**响亮抛错**（禁止 best-effort 吞错续跑：acquire 失败 = 双写风险敞口；
 * acquire-first 顺序保证失败时磁盘保持 closed 可读形态——极端形态下经 legacy
 * 文件名回退仍读出终态，见 catch 文案）。reportTransition（entry 上报）留编排层
 * （纯投递副作用，失败不破坏状态一致性）。
 *
 * 两种接管形态统一（wasClosed 判别）：closed 候选 = 三件套全量；running 候选接管
 * （跨重启磁盘重建）= 跳过删终态位（无 `.state` 可删）**仍 acquire marker**
 * （「接管即声明」——现状此路径不写 marker 的双写窗随归口消灭）。
 * 中间形态推演（G3 单点论证）见设计 D3c (i)(ii)(iii)：三形态无卡死态、无双写窗。
 *
 * [U7 / §3.2.6 锚分派] zcode 锚不再被「no sessionFile anchor」硬拒：写权声明的
 * 物理对象 = 会话库条目（dbPath 单库共享，双宿主开同一 dataDir 时互斥语义与 pi
 * 同构），声明键 = transcriptRef 派生锚基底（zcodeAnchorBasePath）。zcode 无
 * `.state`/legacy 终态位（settle 不写——无文件锚），wasClosed 删位动作只对 pi 腿。
 * zcode 的异进程占用探针收编到 acquire 点（cold-lookup 探针面只覆盖 sessionFile
 * 形态——findColdLookupCandidate 对无 sessionFile 候选不探）。
 *
 * [U7 / §3.2.7] revive 统计基线水合先于 acquire/register：冷复活链的 createRecord
 * 产物 turnCount/totalTokens/round/epoch 全部归零，不水合则 register/reportRecordTransition
 * 的 entry 投影以归零值 last-writer-wins 覆盖磁盘原值（GUI 快修批次⑤根因）——
 * binding 快照（settle 权威终值）恢复基线，新轮增量在其上累加（跨轮连续）。
 *
 * @param record 调用方重建的可变 record（createRecord 产物）
 * @param wasClosed 磁盘候选是否为 closed 形态（cold-lookup 的 found.status 判定）
 * @throws Error acquire 或终态位删除失败（含双锚皆缺——无锚点无法声明写权）；
 *         zcode 锚被异进程持有时 ResurrectDeniedError（含 pid 与恢复指引）。
 */
export function markResurrectedImpl(record: ExecutionRecord, wasClosed: boolean, ctx: TerminalCtx): void {
  const { id, sessionFile } = record;
  const zcodeAnchor = sessionFile === undefined ? zcodeRefOf(record) : undefined;
  // 写权声明键：pi = 子 session 文件；zcode = transcriptRef 派生锚基底。双锚皆缺
  // （无任何可声明的物理锚点）→ 响亮抛错（现行语义保留）。
  const leaseBase =
    sessionFile !== undefined
      ? sessionFile
      : zcodeAnchor !== undefined
        ? zcodeAnchorBasePath(zcodeAnchor)
        : undefined;
  if (leaseBase === undefined) {
    throw new Error(
      `markResurrected(${id}): no sessionFile anchor — cannot acquire write lease; ` +
        `resurrect aborted without touching disk or memory (no half-state).`,
    );
  }
  // zcode 锚 acquire 前探针（pi 腿的探针在 cold-lookup 候选定位统一执行；zcode
  // 形态 cold-lookup 不探——此处收编，放在 try 域外保持「占用拒绝 ≠ acquire 失败」
  // 的错误语义分离）。
  if (sessionFile === undefined) {
    const foreign = findForeignLiveInstance(leaseBase);
    if (foreign) {
      throw new ResurrectDeniedError(
        `another process (pid ${foreign.pid}) is writing this session (${leaseBase}, ` +
          `startedAt=${new Date(foreign.startedAt).toISOString()}); ` +
          `close it or wait for it to exit, then retry.`,
      );
    }
  }
  // [U7] 统计基线水合（纯读盘 + 内存赋值，失败无副作用——binding 缺失/损坏时
  // 静默保持归零基线，与 binding best-effort 记账语义对齐）。
  hydrateReviveBaseline(record, zcodeAnchor);
  try {
    // acquire-first：先声明写权——失败即中止，终态位未删（D3c (i)/(ii) 形态锚）。
    ctx.acquireLease(leaseBase, { pid: process.pid, id, startedAt: Date.now() });
    if (wasClosed && sessionFile !== undefined) {
      fs.rmSync(`${sessionFile}${STATE_SIDECAR_EXT}`, { force: true });
      // 旧名两名全量清理（与 writeStateMarker 写侧清理对称）：readStateMarker 在 .state
      // 缺失时回退旧名——残留任一旧终态文件都会让重建读出 cancelled/finalized，破坏
      // live ≡ reload。
      fs.rmSync(`${sessionFile}.finalized`, { force: true });
      fs.rmSync(`${sessionFile}.cancelled`, { force: true });
    }
  } catch (err) {
    logger.error(
      `[subagents] markResurrected(${id}) failed to acquire/flip terminal position; ` +
        `resurrect aborted loudly (disk keeps a closed-readable shape (possibly via legacy filename), memory unregistered)`,
      { detail: { sessionFile: sessionFile ?? leaseBase, error: err instanceof Error ? err.message : String(err) } },
    );
    throw new Error(
      `markResurrected(${id}): write-lease acquire/terminal-position flip failed for ${sessionFile ?? leaseBase} ` +
        `(${err instanceof Error ? err.message : String(err)}). Recovery: inspect disk (permissions/full) and retry message; ` +
        `terminal state remains closed (possibly via legacy filename), the record stays resurrectable.`,
      { cause: err },
    );
  }
  resurrectClosed(record);
  ctx.register(record);
}

/**
 * 派生 manifest 投影落盘（settle/收口/回收共用的写面单点；写序敏感面，
 * 调用方负责决定其后是否接 entry 上报 + 通知——见 commitDerivedTransition）。
 */
function persistDerivedManifest(record: ExecutionRecord, ctx: TerminalCtx): void {
  ctx.writeManifestPersisted(record.id, derivedManifestRecord(recordToSubagent(record)));
}

/** persistDerivedManifest + entry 上报 + 通知重渲（settle/收口落账的标准收尾三元组，写序固定）。 */
function commitDerivedTransition(record: ExecutionRecord, ctx: TerminalCtx): void {
  persistDerivedManifest(record, ctx);
  ctx.reportRecordTransition(record);
  ctx.notifyChange();
}

/**
 * 意图原语：内存回收（evicted，§3.2.4 release 出口②）。30 天 TTL 内存回收，
 * 用户不可见，非终态化——磁盘不动、可重建。
 *
 * 写序（D3a/轮 5，语义不变）：store.archive **先**、`.alive` release **后**——
 * archive 抛错则原语整体失败、marker 必未删（持有与声明一致）；release 失败
 * best-effort 留痕（removeAliveMarker 内部 warn——GC 为旁路维护路径不阻断
 * interval，泄漏窗 = 至宿主退出，已接受）。回收 record 后续被接管时统一
 * acquireWriteLease 重新声明。
 *
 * [U4c / G2] 回收点补写 manifest（投影 running——磁盘确仍 running）：record 离开
 * 内存后，外部 session-reader 的 identity 富字段主路径只剩 manifest（子文件
 * identity entry 随 30 天 GC 衰减），回收时不落盘则该 record 在 manifest 面长期
 * 缺席。写失败走 writeTerminalManifest 同款响亮上报（终态写面共用通道）。
 */
export function markIdleEvictedImpl(record: ExecutionRecord, ctx: TerminalCtx): void {
  ctx.archive(record);
  // [U4c / G2] 回收点补写：经状态派生投影（running 如实投影——非终态化语义，
  // terminalManifestRecord 的 closed 硬编码不适用），响亮失败通道同终态写面。
  persistDerivedManifest(record, ctx);
  releaseWriteLeaseImpl(record, ctx);
}

/**
 * [U7 / §3.2.4 release 出口] 写权声明 release 的锚分派：pi = 子 session 文件
 * （现行键）；zcode = transcriptRef 派生锚基底（markResurrected acquire 的对称
 * 反向）。双锚皆缺（spawn 窗口期未确立锚）无声明可释——静默跳过（acquire 同形态
 * 硬拒，对称成立）。
 */
export function releaseWriteLeaseImpl(record: ExecutionRecord, ctx: TerminalCtx): void {
  if (record.sessionFile !== undefined) {
    ctx.releaseLease(record.sessionFile);
    return;
  }
  const zcode = zcodeRefOf(record);
  if (zcode !== undefined) ctx.releaseLease(zcodeAnchorBasePath(zcode));
}

/**
 * 意图原语：轮收口（settle）。§3.2.2 事件表 settle 行——「轮完成 / 失败 / 中断
 * 收口」统一落 idle + stopReason 展示值写入；承接 markFinalized / markCancelled
 * 的轮收口角色（两旧原语 U5 退役）。**不终态化**：record 留内存 idle（随时可接
 * 下一条 message），closedReason 不写（桥接不变量的新侧——settle 产出的 idle 不
 * 携带旧终态遗留位）。
 *
 * CAS：仅 running 可收口（对 idle record 重复 settle = 非法迁移，拒绝返回 false
 * + warn 留痕——与 tryTransition 抢锁语义同族）。
 *
 * 写序（D8：`.state` 先 → binding → manifest 后）：
 *   ① `.state` 新格式收条 {status:"idle", stopReason, endedAt}（writeSettledState；
 *      U2/U3 窗口期现有读侧对本格式落存在性降级分支，读侧兼容归 U3）；
 *   ② usage 快照落 binding（§3.2.7 统计口径——binding 快照为基准；含 round 推进）；
 *   ③ manifest 派生投影（settle 非终态 → legacy "running"——session-reader 视角
 *      的活跃成员，§3.2.8 下行映射）。
 *
 * **`.alive` 跨轮保留**（§3.2.4——settle 不释放写权声明，idle record 随时可能
 * 续写同一 transcript）；副作用编排（进程按 idle timer 回收等）留调用方。
 * record.endedAt 不写（非终态，duration 语义保持 running 起算）。
 *
 * @param stopReason 展示值（成功/失败轮用旧值族、中断轮用 interrupted 族——
 *        值域见 types.ts StopReason；展示 + 排障，U6 起参与 isOccupied 判定）。
 * @returns true = 收口完成；false = CAS 拒绝（record 非 running）。
 */
export function markSettledImpl(record: ExecutionRecord, stopReason: StopReason, ctx: TerminalCtx): boolean {
  if (record.status !== "running") {
    logger.warn("[subagents] markSettled: CAS rejected (record not running)", {
      detail: { id: record.id, status: record.status, stopReason },
    });
    return false;
  }
  record.status = "idle";
  record.stopReason = stopReason;
  record.idleSince = Date.now();
  const settledAt = Date.now();
  // [U7 / §3.2.7 统计口径单基准] settle 快照锚分派（U6-D2 交接收编）：
  //   - pi：子 session 文件锚（现行——`.state` 收条 + binding 快照）；
  //   - zcode：transcriptRef 派生锚键承载 binding 快照（`.state` 无文件锚不写，
  //     上一轮收条经 entry/manifest 投影承载）——zcode 无 pi 文件锚是常态形态
  //     非异常，不 warn；
  //   - 双锚皆缺（spawn 窗口期 / 从未开跑）：warn 留痕（现行）。
  const zcodeAnchor = record.sessionFile === undefined ? zcodeRefOf(record) : undefined;
  if (record.sessionFile !== undefined) {
    // ① `.state` 收条（失败 warn 留痕不抛——轮收口非终态，内存态已收口，磁盘面
    // 滞后由下次收口/接管补写；错误已在 state-marker 层 error 级响亮暴露）。
    ctx.persistSettledState(record.sessionFile, { stopReason, endedAt: settledAt });
    // ② binding 快照。[U5 / §3.2.7] epoch 与放弃轮标记同批落盘（cancel/编排性
    // 关闭的中断轮 settle 是标记的置位点——gate ②判据跨重启有效是硬要求，丢标记
    // = 中断轮迟到回注防双发失效）。[U7] 写点统一为 merge-or-create：binding
    // 缺失（spawn 回填点 best-effort 写失败的窗口）时以 settle 时点的完整身份域
    // 造全载荷（对齐 markReopened 创建先例）——统计基准不因回填点失败而永久丢失。
    persistSettleSnapshot(record.sessionFile, record);
  } else if (zcodeAnchor !== undefined) {
    // [U7 / U6-D2] zcode 锚 settle 快照：锚键基底承载（readRecordBinding/
    // writeRecordBinding 的键形态对 pi/zcode 同构，见 state-marker 注释）。
    // transcriptRef 显式落位（锚键是派生形态，显式字段让 markResurrected 水合
    // 与重启恢复的读侧单源）。
    persistSettleSnapshot(zcodeAnchorBasePath(zcodeAnchor), record, zcodeAnchor);
  } else {
    logger.warn("[subagents] markSettled: no sessionFile anchor, .state/binding faces skipped", {
      detail: { id: record.id },
    });
  }
  // ③ manifest 投影（D8 写序 manifest 后；派生投影——非终态如实 legacy running）。
  commitDerivedTransition(record, ctx);
  return true;
}

/**
 * 意图原语：带历史重开（reopen，锚失效降级路径 §3.2.3）。同 id 不换——新
 * transcriptRef（pi 新 sessionFile / zcode 新 sessionId）+ round 归零 + epoch+1 +
 * stopReason=reopened；首轮 prompt 的历史摘要注入编排留调用方（U4 reopen 降级
 * 路径接线）。触发方式：仅用户显式 message（不自动重开）。
 *
 * CAS：仅 idle 可重开（running = 一轮在飞，非法迁移拒绝）。
 *
 * epoch 持久化（跨重启单调是硬要求，丢 epoch 会被二次 reopen 击穿）：pi 锚经
 * writeRecordBinding 在新 sessionFile 旁落盘完整 binding（新锚旁无存量 binding 可
 * merge——updateRecordBinding 不造新，reopen 的新文件锚必须走创建入口）；
 * [U7 / U6-D2 收编] zcode 锚同款落盘（锚键基底派生，见 zcodeAnchorBasePath）。
 * **binding 写失败 = 拒绝重开**（§3.4 失败语义）：epoch 未落盘时推进内存世代会让
 * 二次 reopen 防撞击穿——内存面回滚（transcriptRef/round/epoch/stopReason 还原，
 * record 保持原 idle 形态可重试）并返回 false，走调用方既有拒绝面（reviveOrThrow
 * 响亮报错 + Recovery 指引，不崩进程）。残留 lastAbandonedRound 不迁移（跨 epoch
 * 自然失效，§3.2.7——判定第一步以 record 当前 epoch 为基准丢弃旧世代回注）。
 * `.alive` 写权声明迁移归调用方编排（acquireWriteLease 于新锚确立时）。
 *
 * @returns true = 重开完成；false = CAS 拒绝（record 非 idle）或 binding 持久化
 *          失败（内存面已回滚，record 保持重开前形态）。
 */
export function markReopenedImpl(record: ExecutionRecord, transcriptRef: TranscriptRef, ctx: TerminalCtx): boolean {
  if (record.status !== "idle") {
    logger.warn("[subagents] markReopened: CAS rejected (record not idle)", {
      detail: { id: record.id, status: record.status, engine: transcriptRef.engine },
    });
    return false;
  }
  // 重开前形态快照（binding 写失败时回滚锚点——回滚必须逐字段还原，含 undefined
  // 字段：epoch/stopReason 重开前可能是 undefined，展开 spread 会把 undefined 变成
  // 自有属性，直接逐字段赋值）。
  const prevTranscriptRef = record.transcriptRef;
  const prevRound = record.round;
  const prevEpoch = record.epoch;
  const prevStopReason = record.stopReason;
  record.transcriptRef = transcriptRef;
  record.round = 0;
  record.epoch = (record.epoch ?? 0) + 1;
  record.stopReason = "reopened";
  // 锚分派（U7 / U6-D2）：pi = 子 session 文件锚；zcode = transcriptRef 派生锚键
  // 基底（state-marker.writeRecordBinding 键形态对 pi/zcode 同构）。epoch/统计基线
  // 随新锚落盘——旧锚下 binding 保留（历史锚回溯，与 pi 侧旧文件 binding 同族）。
  const anchorBase = isPiTranscriptRef(transcriptRef)
    ? transcriptRef.sessionFile
    : zcodeAnchorBasePath(transcriptRef);
  if (!writeRecordBinding(anchorBase, fullBindingPayload(record, transcriptRef))) {
    // epoch 随 binding 持久化是硬要求（types.ts Epoch：防撞依赖跨重启单调，丢
    // epoch 会被二次 reopen 击穿）——拒绝重开 + 回滚（错误详情已由 writeRecordBinding
    // warn 留痕，此处补拒绝面语境）。
    record.transcriptRef = prevTranscriptRef;
    record.round = prevRound;
    record.epoch = prevEpoch;
    record.stopReason = prevStopReason;
    logger.warn(
      "[subagents] markReopened: binding persistence failed — reopen rejected, record rolled back (retry the message after fixing disk state)",
      { detail: { id: record.id, anchor: anchorBase } },
    );
    return false;
  }
  ctx.reportRecordTransition(record);
  ctx.notifyChange();
  return true;
}

/**
 * [U7 / §3.2.7] settle 快照的统计域 patch（turns/tokens 终值 + round/epoch/放弃轮
 * 标记——binding 为统计单基准的写侧载荷）。endedAt 取 record 终值（非终态 settle
 * 恒 undefined，与 markSettled「不写 endedAt」语义一致——快照槽位保留供
 * markFinalized/markCancelled 终态路径 merge 复用）。
 */
export function settleSnapshotPatch(
  record: ExecutionRecord,
): Pick<RecordBinding, "totalTokens" | "turns" | "endedAt" | "round" | "epoch" | "lastAbandonedRound"> {
  return {
    totalTokens: record.totalTokens,
    turns: record.turnCount,
    endedAt: record.endedAt,
    round: record.round ?? 0,
    epoch: record.epoch,
    lastAbandonedRound: record.lastAbandonedRound,
  };
}

/**
 * [U7] record → 完整 binding 载荷（merge-or-create 的 create 腿与 markReopened
 * 新锚旁落盘共用——身份域取 settle/reopen 时点的内存 record（齐全非残缺），对齐
 * 「binding 缺失不造残缺身份」原则的合法例外：调用时点 record 身份已定型）。
 */
export function fullBindingPayload(record: ExecutionRecord, transcriptRef: TranscriptRef | undefined): RecordBinding {
  return {
    v: 1,
    recordId: record.id,
    rootSessionId: record.rootSessionId,
    parentRecordId: record.parentRecordId,
    depth: record.depth,
    agent: record.agent,
    task: record.task,
    slug: record.slug,
    mode: "background",
    startedAt: record.startedAt,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    worktree: record.worktreeHandle !== undefined || record.hadWorktree === true,
    origin: record.origin,
    parentRunId: record.parentRunId,
    ...settleSnapshotPatch(record),
    ...(transcriptRef !== undefined ? { transcriptRef } : {}),
  };
}

/**
 * [U7 / §3.2.7] settle 统计快照落 binding（merge-or-create）：现有 binding merge
 * patch（updateRecordBinding 既有语义）；缺失时全载荷创建（spawn 回填点 best-effort
 * 写失败的窗口下统计基准不丢——「binding 为单基准」的写侧可靠性收口）。best-effort
 * 语义同写侧（state-marker.writeRecordBinding 内部 warn 不抛）。
 */
export function persistSettleSnapshot(basePath: string, record: ExecutionRecord, transcriptRef?: TranscriptRef): void {
  const existing = readRecordBinding(basePath);
  if (existing === undefined) {
    writeRecordBinding(basePath, fullBindingPayload(record, transcriptRef));
    return;
  }
  updateRecordBinding(basePath, {
    ...settleSnapshotPatch(record),
    ...(transcriptRef !== undefined ? { transcriptRef } : {}),
  });
}

/**
 * 意图原语：close 收口落账（收口动作 §3.2.5 close 行）——会话收口的账面落定：
 * `.alive` release（§3.2.4 release 出口①——收口即放弃写权）+ worktreeHandle 清句
 * + manifest 投影 + entry 上报。
 *
 * 顺序约束 [写死]：收口轮 settle → 轮次通知送达 → 收口落账 + 注销补发（收口落账
 * 必须在通知链之后，提前调用会丢收口轮通知）。worktree 回收（patch 落盘前移到
 * 收口点）与 pending 注销补发的编排留调用方；本原语只吸收写权声明 + worktreeHandle
 * 清句（S5 修复——收口即绑定消亡，重建守卫据 hadWorktree 触发）两写面。
 *
 * 幂等：release 对缺失 marker 静默、worktree 清句对无 handle no-op（重复 close /
 * dispose 重复调用无害）。record 留内存 idle（收口 ≠ 内存回收——占用位不动，
 * message 随时可续聊复活）。
 *
 * session-reader 下行投影（§3.2.8）：本原语经 derivedManifestRecord 投影——
 * 收口落账 record（idle、无 closedReason）legacy status="running" +
 * executionStatus="idle"（两态权威词）双写。对外契约只有 running/ended 两态，
 * 旧版 session-reader 视其为活跃成员（行为变化登记：原「归入已完成分区」的
 * archived→closed 下行随 intent 概念删除而退役，§3.4 方案 A 裁决）。
 *
 * @returns true = 收口落账写面完成（幂等，恒 true）。
 */
export function markSettledOutImpl(record: ExecutionRecord, ctx: TerminalCtx): boolean {
  // [S5 修复] worktree 绑定随收口消亡：调用方（archiveRecord / disposeAllRecords）
  // 已在收口前完成 patch 前移 + worktree 回收，handle 指向已删目录——残留会让
  // Continuation 重建守卫（!record.worktreeHandle 判「绑定丢失」）永不触发，续聊
  // spawn cwd 回落已删目录。清句前先置 hadWorktree（此后 entry/binding 的 worktree
  // 投影与重建守卫判据均由本标志承载——与 execute 创建点置位呼应）。幂等：无
  // handle 时 no-op（重复收口零影响）。
  if (record.worktreeHandle !== undefined) {
    record.hadWorktree = true;
    record.worktreeHandle = undefined;
  }
  releaseWriteLeaseImpl(record, ctx);
  commitDerivedTransition(record, ctx);
  return true;
}
