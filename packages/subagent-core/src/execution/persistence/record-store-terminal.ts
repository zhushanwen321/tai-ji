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
import type { RecordJournalEventInput, RecordJournalFoldState } from "./record-events.ts";
// [W1 / U2a] v2 条目契约与 v2 定界判定（u0 契约层消费）。
import { SUBAGENT_RECORD_CUSTOM_TYPE, SUBAGENT_RECORD_ENTRY_VERSION, classifySubagentRecordEntryData } from "./record-entry.ts";
import type {
  SubagentRecordRegisteredEntryData,
  SubagentRecordSettledEntryData,
} from "./record-entry.ts";
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
  /**
   * [W1 / D3 表行 5] 终局事件 + v2 终态条目（record-settled 帧，markSettled 写点；
   * archive 真终局路径同款注入位）。幂等守卫（fold 已 settled 跳过）在被调侧。
   */
  settleViaJournal: (record: ExecutionRecord, endedAt: number) => void;
  /** [W1 / D3] record 事件追加注入位（markReopened 的 record-reopened 帧）。 */
  appendJournalEvent: (record: ExecutionRecord, input: RecordJournalEventInput) => void;
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
  // ④ [W1 / D3 表行 5] record-settled 帧 + v2 终态条目（markSettled 是终局写点
  // 之一——D3 映射表「archive / markSettled / legacy 终态」；幂等守卫在被调侧）。
  // endedAt 取收口时点（settle 非终态不写 record.endedAt——事件帧的终局时间戳）。
  ctx.settleViaJournal(record, settledAt);
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
  // [W1 / D3 表行 6] record-reopened 帧（epoch 递增 + round 归零——binding 持久化
  // 成功后落账：事件文件与 binding 的 epoch 同源单点，写失败拒绝重开时事件不落）。
  ctx.appendJournalEvent(record, {
    type: "record-reopened",
    ts: Date.now(),
    epoch: record.epoch ?? 0,
    round: 0,
  });
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
    // [W0 / D1] 来源身份三字段（origin/parentRunId + stepIndex）：merge-or-create 的
    // create 腿与 reopen 新锚均经本载荷，漏拷贝则 binding 恒无该字段（schema 补键
    // 不足以让字段落盘——载荷是显式逐字段拷贝）。
    origin: record.origin,
    parentRunId: record.parentRunId,
    stepIndex: record.stepIndex,
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

// ============================================================
// [W1 / U2a] v2 条目构造族 + v2 定界扫描 + 收编组装（纯函数族）
// ============================================================
//
// 变化轴 = 「v2 条目与事件载荷的构造规则」（契约演化集中于此）——终局写点
// （markSettled/archive/收编）的载荷构造单源。字段集契约单源 = record-entry.ts
// （u0）；事件词表与 fold 单源 = record-events.ts（u0）。

/** v2 注册条目 data（register 写点；undefined 身份域归一：origin → "tool"、rootSessionId → ""）。 */
export function toRegisteredEntryData(
  record: { id: string; agent: string; task: string; slug: string; origin?: string; parentRunId?: string; stepIndex?: number; rootSessionId?: string; parentRecordId?: string; depth: number; startedAt: number },
): SubagentRecordRegisteredEntryData {
  return {
    v: SUBAGENT_RECORD_ENTRY_VERSION,
    kind: "registered",
    id: record.id,
    agent: record.agent,
    task: record.task,
    slug: record.slug,
    origin: record.origin === "workflow" ? "workflow" : "tool",
    ...(record.parentRunId !== undefined ? { parentRunId: record.parentRunId } : {}),
    ...(record.stepIndex !== undefined ? { stepIndex: record.stepIndex } : {}),
    rootSessionId: record.rootSessionId ?? "",
    ...(record.parentRecordId !== undefined ? { parentRecordId: record.parentRecordId } : {}),
    depth: record.depth,
    startedAt: record.startedAt,
  };
}

/** v2 终态条目构造载荷（终局写点共用输入面——ExecutionRecord 的统计/终局域字段子集）。 */
export interface SettledEntrySource {
  id: string;
  status: string;
  stopReason?: StopReason;
  outcome?: SubagentRecord["outcome"];
  error?: string;
  turnCount: number;
  totalTokens: number;
  model: string | undefined;
  thinkingLevel: string | undefined;
  engine?: string;
  engineHandle?: SubagentRecord["engineHandle"];
  sessionFile?: string;
  result?: string;
}

/**
 * ExecutionRecord → SettledEntrySource 映射（终局写点共用：容器终局写点与
 * face 缺省分支同款消费——条目面独立于事件面工作时载荷构造单源）。
 */
export function settledEntrySourceOf(record: ExecutionRecord): SettledEntrySource {
  return {
    id: record.id,
    status: record.status,
    stopReason: record.stopReason,
    outcome: record.outcome,
    error: record.error !== undefined && record.error.length > 0 ? record.error : undefined,
    turnCount: record.turnCount,
    totalTokens: record.totalTokens,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    engine: record.engine,
    engineHandle: record.engineHandle,
    sessionFile: record.sessionFile,
    result: record.result,
  };
}

/** v2 终态条目 data（终局写点共用：archive 真终局 / markSettled / 收编幂等补写）。 */
export function toSettledEntryData(source: SettledEntrySource, endedAt: number): SubagentRecordSettledEntryData {
  return {
    v: SUBAGENT_RECORD_ENTRY_VERSION,
    kind: "settled",
    id: source.id,
    status: "idle",
    stopReason: source.stopReason ?? "interrupted-by-restart",
    ...(source.outcome !== undefined ? { outcome: source.outcome } : {}),
    ...(source.error !== undefined ? { error: source.error } : {}),
    endedAt,
    turns: source.turnCount,
    totalTokens: source.totalTokens,
    model: source.model,
    thinkingLevel: source.thinkingLevel,
    ...(source.engine !== undefined ? { engine: source.engine } : {}),
    ...(source.engineHandle !== undefined ? { engineHandle: source.engineHandle } : {}),
    ...(source.sessionFile !== undefined ? { sessionFile: source.sessionFile } : {}),
    ...(source.result !== undefined ? { result: source.result } : {}),
  };
}

/** record-settled 帧的 result 摘要锚长度（截断摘要——全文只在 v2 终态条目一次性写）。 */
const SETTLED_RESULT_SUMMARY_MAX_CHARS = 200;

export function summarizeResultForJournal(result: string | undefined): string | undefined {
  if (result === undefined || result.length === 0) return undefined;
  return result.length <= SETTLED_RESULT_SUMMARY_MAX_CHARS
    ? result
    : `${result.slice(0, SETTLED_RESULT_SUMMARY_MAX_CHARS)}…`;
}

/** v2 条目定界状态（registered 定界 + settled 幂等证据）。 */
export interface V2EntryState {
  registered: boolean;
  settled: boolean;
  /** 末条 settled 条目的停因（D4 双面证据第二条的判别输入——interrupted 族条目
   * 不构成「非 interrupted 终态」跳过证据，收编须放行修复 journal）。 */
  settledStopReason: StopReason | undefined;
  rootSessionId: string | undefined;
}

/**
 * 主 session 内容 → 每 id 的 v2 条目定界状态（收编双面证据第二条，D4）。
 * v1 快照行不在本扫描面（v 门跳过——收编定界按注册条目形态分流：v1 实体保留
 * v1 纠偏循环，D7 兼容层）。判定单源 = classifySubagentRecordEntryData（u2b），
 * 快过滤与 collectLastRecordEntries 同款（customType 子串）。
 */
export function collectV2EntryState(content: string): Map<string, V2EntryState> {
  const out = new Map<string, V2EntryState>();
  for (const line of content.split("\n")) {
    if (!line.includes(SUBAGENT_RECORD_CUSTOM_TYPE)) continue; // 快过滤（绝大多数行不是本类型）
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 截断/异构行跳过（主文件末行可能正被写入）
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== "custom" || obj.customType !== SUBAGENT_RECORD_CUSTOM_TYPE) continue;
    const verdict = classifySubagentRecordEntryData(obj.data);
    if (!verdict.ok && verdict.reason === "v2") {
      const entry = verdict.entry;
      const prev =
        out.get(entry.id) ?? { registered: false, settled: false, settledStopReason: undefined, rootSessionId: undefined };
      if (entry.kind === "registered") {
        prev.registered = true;
        prev.rootSessionId = entry.rootSessionId;
      } else {
        prev.settled = true;
        prev.settledStopReason = entry.stopReason;
      }
      out.set(entry.id, prev);
    }
  }
  return out;
}

/**
 * interrupted 族停因（StopReason 的中断子族——重启收编语义；与 runtime
 * workflow-step-merge 的状态映射常量同词表，消费形态不同不共享实体）。
 */
const INTERRUPTED_FAMILY_STOP_REASONS: readonly string[] = [
  "interrupted",
  "interrupted-by-restart",
  "interrupted-by-parent",
];

/**
 * D4 双面证据第二条的判别（「终态条目已存在且非 interrupted」）：settled 条目
 * 在场且停因非 interrupted 族才构成跳过证据——interrupted 族条目是「条目面先行
 * 写、journal 帧缺失」的不对称窗口残留（journalAppend fire-and-forget 失败 /
 * 局部损坏），不构成跳过证据，收编须放行以追加 settled 帧修复 journal；停因
 * 缺失（契约外残缺形态）保守计为真终态（宁保留不重复）。
 */
export function isNonInterruptedSettledEvidence(st: V2EntryState | undefined): boolean {
  if (st?.settled !== true) return false;
  if (st.settledStopReason === undefined) return true;
  return !INTERRUPTED_FAMILY_STOP_REASONS.includes(st.settledStopReason);
}

/** 收编产物的 v2 终态条目（fold + 收编停因组装——model/thinkingLevel 收编形态 undefined 诚实缺省：journal 无此数据源）。 */
export function buildAdoptedSettledEntry(
  fold: RecordJournalFoldState,
  id: string,
  stopReason: StopReason,
  now: number,
): SubagentRecordSettledEntryData {
  const bound = fold.bound;
  return {
    v: SUBAGENT_RECORD_ENTRY_VERSION,
    kind: "settled",
    id,
    status: "idle",
    stopReason,
    endedAt: now,
    turns: fold.roundIdle?.turns ?? 0,
    totalTokens: fold.roundIdle?.totalTokens ?? 0,
    model: undefined,
    thinkingLevel: undefined,
    ...(bound !== undefined ? { engine: bound.engine } : {}),
    ...(bound !== undefined ? { engineHandle: bound.engineHandle } : {}),
    ...(bound !== undefined && bound.sessionFile !== "" ? { sessionFile: bound.sessionFile } : {}),
  };
}

/** 收编产物的 record-settled 帧（统计终值取 fold 轮终快照、缺帧诚实 0——判定半边在容器）。 */
export function buildAdoptedSettledEvent(
  fold: RecordJournalFoldState,
  id: string,
  stopReason: StopReason,
  now: number,
): RecordJournalEventInput {
  return {
    type: "record-settled",
    ts: now,
    stopReason,
    endedAt: now,
    turns: fold.roundIdle?.turns ?? 0,
    totalTokens: fold.roundIdle?.totalTokens ?? 0,
  };
}

/** 收编产物的 manifest 投影（derivedManifestRecord 同族形态——身份域取 created 帧、引擎域取 bound 帧、终局域取收编停因）。 */
export function buildAdoptedManifestProjection(
  fold: RecordJournalFoldState,
  id: string,
  stopReason: StopReason,
  now: number,
): ManifestRecord | undefined {
  const identity = fold.identity;
  if (identity === undefined) return undefined; // 坏链守卫在容器侧先行（skippedNoIdentity）
  const bound = fold.bound;
  return {
    id,
    rootSessionId: identity.rootSessionId || "",
    agentName: identity.agent,
    status: "running", // legacy 三态投影：无 closedReason → running（executionStatus 承载两态权威词）
    executionStatus: "idle",
    createdAt: identity.startedAt,
    completedAt: now,
    ...(bound !== undefined && bound.sessionFile !== "" ? { sessionFile: bound.sessionFile } : {}),
    task: identity.task,
    slug: identity.slug,
    ...(bound !== undefined ? { engine: bound.engine } : {}),
    ...(bound !== undefined ? { engineHandle: bound.engineHandle } : {}),
  };
}

// ── [W1 / D3] 事件帧载荷构造与引擎域签名（record-created/bound/settled——容器写
// ── 点的载荷构造半边；幂等判定与 append 编排留在容器）──────────────

/** record-created 帧载荷（register 写点——D3 表行 1 身份域全量）。 */
export function buildCreatedEventPayload(
  record: ExecutionRecord,
): RecordJournalEventInput {
  return {
    type: "record-created",
    ts: record.startedAt,
    id: record.id,
    agent: record.agent,
    task: record.task,
    slug: record.slug,
    origin: record.origin === "workflow" ? "workflow" : "tool",
    ...(record.parentRunId !== undefined ? { parentRunId: record.parentRunId } : {}),
    ...(record.stepIndex !== undefined ? { stepIndex: record.stepIndex } : {}),
    rootSessionId: record.rootSessionId ?? "",
    ...(record.parentRecordId !== undefined ? { parentRecordId: record.parentRecordId } : {}),
    depth: record.depth,
    mode: record.mode,
    startedAt: record.startedAt,
  };
}

/**
 * 引擎域签名对比（reportRecordTransition 写点——D3 表行 2）。归一形态：pi record
 * 的 engineHandle 缺省 = 空 sessionRef 桶（落账与对比共用同一归一，避免「record
 * 缺省 undefined vs 落账归一值」的伪差异把每次过程 transition 都误判为引擎域变化，
 * 事件面随高频调用放大）。签名三元组 = sessionFile/engine/engineHandle；**epoch
 * 不参与签名**——epoch 递增由 record-reopened 帧单点承载（D3 表行 6），reopen 后
 * 的 transition 再落 bound 帧会重复表达同一迁移。
 */
export function isBoundSignatureUnchanged(
  bound: { sessionFile: string; engine: string; engineHandle: { sessionRef: Record<string, string>; journalPath?: string; poolKey: string } } | undefined,
  sessionFile: string | undefined,
  engine: string | undefined,
  engineHandle: ExecutionRecord["engineHandle"],
): boolean {
  if (bound === undefined) return false;
  const normEngine = engine ?? "pi";
  const normHandle = engineHandle ?? { sessionRef: {}, poolKey: "shared" };
  return (
    bound.sessionFile === (sessionFile ?? "") &&
    bound.engine === normEngine &&
    JSON.stringify(bound.engineHandle) === JSON.stringify(normHandle)
  );
}

/** record-bound 帧载荷（spawn 回填——引擎域归一形态同签名对比）。 */
export function buildBoundEventPayload(
  record: ExecutionRecord,
): RecordJournalEventInput {
  return {
    type: "record-bound",
    ts: Date.now(),
    sessionFile: record.sessionFile ?? "",
    engine: record.engine ?? "pi",
    engineHandle: record.engineHandle ?? { sessionRef: {}, poolKey: "shared" },
    epoch: record.epoch ?? 0,
  };
}

/** record-settled 帧载荷（终局写点——stopReason 缺省 interrupted 保守兜底）。 */
export function buildSettledEventPayload(
  record: ExecutionRecord,
  endedAt: number,
): RecordJournalEventInput {
  return {
    type: "record-settled",
    ts: endedAt,
    stopReason: record.stopReason ?? "interrupted",
    ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
    ...(record.error !== undefined && record.error.length > 0 ? { error: record.error } : {}),
    endedAt,
    turns: record.turnCount,
    totalTokens: record.totalTokens,
    ...(summarizeResultForJournal(record.result) !== undefined
      ? { resultSummary: summarizeResultForJournal(record.result) }
      : {}),
  };
}
