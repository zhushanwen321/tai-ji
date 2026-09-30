// src/execution/persistence/record-store-rounds.ts
//
// [H4 三轴拆分 / 轮次簿记轴] RecordStore 轮次过程原语的实现体：
//   - appendEvent（事件追加，turns/eventLog/totalTokens 归约）；
//   - markRoundStarted（轮始重置——字段①②⑤ + [U6/D4] stopReason 清点）；
//   - markRoundIdle（轮末收口簿记全集①-⑫——[two-state-convergence U4/D3] 轮终翻边
//     写 idle + A-lite 轮终磁盘面 `.state` 收条 + binding 快照 + pending 注销发射点②
//     + [B2] 轮终派生 manifest 投影——session-reader manifest 直读主路径的数据源）；
//   - adoptEngineDeath（引擎死亡收养——error/result/stopReason 三写，[U5/D4] W4 新态）。
//
// 变化轴 = 「一轮会话的过程簿记」（轮始重置 / 轮终收口 / 事件归约 / 收养）——
// 轮次语义演进（SP-5 升级链、A-lite 展示位、U7 统计口径的轮终快照）集中在此。
// binding settle 快照本体在终态原语轴（record-store-terminal.ts），本文件消费。
//
// [D7 写面约束] 同终态轴：`.state` 写函数与两个 manifest 物化面（轮终派生投影
// writeDerivedManifest / bound 物化 materializeBoundManifest）均经 ctx 或写面构造
// 参数注入，本文件零 R1 字面、零写函数 import（manifest-store 写函数调用字面只留
// record-store.ts——写面检查 R1 的豁免面）。依赖方向单向：rounds → {terminal, rebuild}，
// 不回 import store。

import { getLogger } from "../../core/logger.ts";

import { updateFromEvent } from "./execution-record.ts";
import { zcodeAnchorBasePath } from "./state-marker.ts";
import { persistSettleSnapshot, summarizeResultForJournal } from "./record-store-terminal.ts";
import { zcodeRefOf } from "./record-store-rebuild.ts";
// [W1 / U2a] 事件文件写面接线层（fold 缓存 + 写点幂等判定 + 物化编排）的依赖面：
// u0 契约层原语（词表/fold/seq 单源）+ terminal 轴载荷构造 + manifest 物化写面。
import * as fs from "node:fs";

import { SUBAGENT_RECORD_CUSTOM_TYPE } from "./record-entry.ts";
import {
  INITIAL_RECORD_EVENT_FOLD_STATE,
  applyRecordEvent,
  createRecordEventJournal,
  foldRecordEvents,
  parseRecordEventFileLine,
  recordEventsPath,
} from "./record-events.ts";
import type {
  RecordEventJournal,
  RecordJournalEvent,
  RecordJournalEventInput,
  RecordEventFoldState,
} from "./record-events.ts";
import {
  buildBoundEventPayload,
  buildCreatedEventPayload,
  buildSettledEventPayload,
  isBoundSignatureUnchanged,
  settledEntrySourceOf,
  toRegisteredEntryData,
  toSettledEntryData,
} from "./record-store-terminal.ts";
import type { StopReason } from "../domain/record-types.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import type { AgentEvent } from "../assembly/types.ts";
import type { RoundSettlementOutcome } from "./finalize-record.ts";

const logger = getLogger("subagents");

/**
 * 轮次原语实现的 store 通道（D7 写面注入，同 TerminalCtx 口径——注入名避开
 * R1 七名）。records 传共享 Map 引用（与容器同一 Map，零拷贝——写入直达成
 * store 内存态，与原 this.records 访问同对象）。
 */
export interface RoundsCtx {
  /** 内存 record 表（RecordStore.records 的共享引用）。 */
  records: Map<string, ExecutionRecord>;
  /**
   * [B2 / 簿记⑫] 轮终派生 manifest 投影写（record-store.ts 构造点绑定
   * writeManifestPersisted(derivedManifestRecord(recordToSubagent(rec)))）——轮终留内存
   * idle 的 record 不经任何终态/回收写点，缺本写则 records/ 目录长期缺席该 record，
   * session-reader 的 manifest 直读主路径（zcode 定点直读 / pi isRecordManifest 扫描）
   * 永不命中。写的是派生投影（缓存性质，与 markSettled 的 manifest 落盘字节同源），
   * 重复写幂等无害。D7 写面约束：本文件不 import manifest 写函数，落盘经本注入位。
   */
  writeDerivedManifest: (record: ExecutionRecord) => void;
  /** pending-notifications 轮终注销（发射点②；未注入时容器侧 no-op）。 */
  emitPendingUnregister: (id: string, status: string) => void;
  reportRecordTransition: (record: ExecutionRecord) => void;
  /**
   * [W1 / D3 表行 3/4] record 事件追加注入位（markRoundStarted 的
   * record-round-started 帧 / markRoundIdle 的 record-round-idle 帧——record 轮次
   * 粒度事件进 journal 是 D5 增量裁决：不进则 .state 仍是事实源，事实源介质数
   * 降不到 1）。幂等/落盘收在被调侧（容器 appendJournal 单点）。
   */
  appendJournalEvent: (record: ExecutionRecord, input: RecordJournalEventInput) => void;
  notifyChange: () => void;
}

/**
 * 意图原语：事件追加（过程记录）。turns/eventLog/totalTokens 经 execution-record
 * 事件归约累积（字段⑧），随后 entry 变迁上报（best-effort——过程面可丢，重建由
 * 子 session 文件承接）。调用方按事件粒度决定调用频率（高频 delta 逐事件上报会
 * 放大 entry 写面，编排粒度属调用方职责）。
 *
 * @returns false = id 不在内存（未注册/已回收）——事件丢弃并 debug 留痕。
 */
export function appendEventImpl(id: string, event: AgentEvent, ctx: RoundsCtx): boolean {
  const rec = ctx.records.get(id);
  if (rec === undefined) {
    logger.debug("[subagents] appendEvent: record not in memory (not registered)", {
      detail: { id, eventType: event.type },
    });
    return false;
  }
  updateFromEvent(rec, event);
  ctx.reportRecordTransition(rec);
  ctx.notifyChange();
  return true;
}

/**
 * 意图原语：轮始重置（字段①②⑤ + [U6/D4 轮始清点族扩字段] stopReason）。
 * status=running + result 清除 + stopReason 清除——§5.4 isStreaming 公式要求 result
 * undefined 才显示 streaming，不清则续轮流仍显示 waiting；[U6] isOccupied 终态判据
 * （`running && stopReason === undefined`）要求在飞期 stopReason 必为空——轮终写入
 * 的上轮停因（markRoundIdleImpl 簿记⑩）不清则第 2+ 轮在飞 record 被确定性误排除
 * （A2 第二轮 spinner+badge+1 必挂）。代价裁决（two-state-convergence §3.1）：在飞期
 * 上轮停因不可见（与「stopReason=上轮停因」语义的显式冲突裁决）。revive 格同步清
 * （conversation-continuation reviveOrThrow）与本清点同族。归口写点：热路径轮始与
 * 冷启动 resume 续轮（subagent-service，U3 迁移）。
 *
 * @returns false = id 不在内存（debug 留痕，无副作用）。
 */
export function markRoundStartedImpl(id: string, ctx: RoundsCtx): boolean {
  const rec = ctx.records.get(id);
  if (rec === undefined) {
    logger.debug("[subagents] markRoundStarted: record not in memory", { detail: { id } });
    return false;
  }
  rec.status = "running";
  rec.result = undefined;
  // [U6/D4 轮始清点族扩字段] 上轮停因随轮始清点——isOccupied 的 stopReason 子句
  // 依赖本清点（W4 新态 failed 在飞期不存在：adoptEngineDeath 纳管态无新轮可派）。
  // [modeless 波1] 上轮失败 error 随轮始清点（失败轮 markRoundIdle 写入的镜像清除）。
  rec.stopReason = undefined;
  rec.error = undefined;
  // [W1 / D3 表行 3] record-round-started 帧（resumeRound / reopen 后续轮——首轮经
  // created→bound 隐含，续轮显式落账；round = 将要跑的轮次计数）。
  ctx.appendJournalEvent(rec, {
    type: "record-round-started",
    ts: Date.now(),
    round: rec.round ?? 0,
    epoch: rec.epoch ?? 0,
  });
  ctx.reportRecordTransition(rec);
  ctx.notifyChange();
  return true;
}

/**
 * 意图原语：轮末收口——**写 idle**（[two-state-convergence U4/D3] A-lite 桥接退役：
 * 「轮已收口」回归 §3.2.2 事件表 `running --settle--> idle` 的单字段编码，对齐
 * markSettled/`.state` 收条/重建单规则。message 资资格核验已核验（设计 D3 + [modeless
 * 波1] SP-5 记录级升级门 canUpgradeToConversation 消亡）：资格 = 引擎能力轴
 * engineSupportsConversation（不查 status）；message 准入走 tryEnterRunning CAS
 * （idle→running）；onMessage 按 `status!=='running'` 分流进 revive 格——idle 形态
 * 本就是 revive 直通路径的设计输入）。簿记全集（①-⑫）：
 *   ① status 写 idle；② result 按 outcome 写入（成功=content / 失败=前值??
 *      失败摘要 + lastError）；③ round+1；④ closedReason 清除（[S10]）；⑤ resumable
 *      字段已退役（[U5/D4] idle 即 resumable——字段从 record/entry 契约整体删除，
 *      无簿记动作）；⑥ idleSince 已退役（30 天空闲回收判据锚，ADR-0081，无簿记动作）；
 *      ⑦ **`.alive` 保留**
 *      （D3a 跨轮延续——写权声明至 release 单出口[终态原语 markSettledOut]，轮终
 *      record 随时续聊 spawn 写同一 sessionFile，删则轮后跨进程防御
 *      空窗）；⑧ pending 注销发射点②（进程已死，从活跃后代差集移除——经
 *      setPendingUnregister 注入，未注入时跳过）；⑨ reportRecordTransition（entry
 *      携带新 round 与本轮 result）；
 *      ⑩ [A-lite] stopReason 展示位（成功轮 completed / 失败轮 failed——status 已
 *      idle，endedAt 不写）；⑪ [A-lite / U7] 轮终磁盘面（锚分派对齐 markSettled：
 *      pi 腿 `.state` 收条 + binding 快照 / zcode 腿锚键 binding 快照——正常轮终后
 *      宿主崩溃 revive 水合 turns/tokens 不归零）；⑫ [B2] 轮终派生 manifest 投影
 *      （ctx.writeDerivedManifest——session-reader manifest 直读主路径的数据源，
 *      idle 派生投影 = legacy "running" + executionStatus "idle"；缓存性质重复写
 *      幂等无害）。
 * worktree/通知等副作用编排留调用方。
 *
 * @param outcome 轮终结果（kind 判别：success=content / 失败=reason）
 * @returns false = id 不在内存（debug 留痕，无副作用）或**在途门拒绝**（状态已非
 *          running——warn 留痕，零副作用；见下方 CAS 段）。
 * @throws Error record 终态簿记已冻结（endedAt 已设——复活终态的调用即 bug，
 *         fail-fast，对齐 doFinalizeRoundToIdle A3 断言）。
 */
export function markRoundIdleImpl(id: string, outcome: RoundSettlementOutcome, ctx: RoundsCtx): boolean {
  const rec = ctx.records.get(id);
  if (rec === undefined) {
    logger.debug("[subagents] markRoundIdle: record not in memory", { detail: { id } });
    return false;
  }
  if (rec.endedAt !== undefined) {
    throw new Error(
      `markRoundIdle(${id}): terminal bookkeeping already frozen ` +
        `(status: ${rec.status}${rec.closedReason !== undefined ? `/${rec.closedReason}` : ""}, endedAt: ${rec.endedAt}) — ` +
        `round-idle finalization would resurrect a finalized record. ` +
        `Recovery: caller must gate on record.status === "running" before settling a round.`,
    );
  }
  // [轮次轴 CAS] 在途门：只在「在途（running）」时允许轮终。此前唯一保护是上面的
  // endedAt 终态冻结检查——cancel（markSettled 有意不写 endedAt）或迟到应答把 record
  // 收成 idle 后再轮终，会静默多推一轮：round 二次递增 + `.state` 收条被覆写 +
  // 多写一条 record-round-idle 事件行（事件流事实源被污染）。三类生产调用链
  // （settleOneShotOutcome / finalizeFailed / chat 域 onRunSettled）均在 running 门下，
  // 本段为原语级兜底（chat 域的门与轮终之间隔着 settleRoundXxx 的 await 边界）。
  // 拒绝语义对齐 markReopened / markSettled：warn 留痕 + 返回 false，不抛错——调用
  // 链是 `void settleRoundXxx(...)` 的断头 promise 形式，抛错会升级为无人接的
  // promise 拒绝（而不是被上层的 status 门接住）。
  if (rec.status !== "running") {
    logger.warn("[subagents] markRoundIdle: CAS rejected (record not running)", {
      detail: { id, status: rec.status, stopReason: rec.stopReason },
    });
    return false;
  }
  // ② result 写入规则（D7）：成功轮 = content（chat 空 content 兜底占位）；失败轮 =
  // 前值保真 ?? 失败摘要 + lastError 写失败原因（字段⑨）。
  let nextResult: string | undefined;
  if (outcome.kind === "failed") {
    rec.lastError = outcome.reason;
    // [modeless 波1] 失败轮同步写 rec.error（投影/通知 outcome 派生消费——
    // toNotifyRecord 的 deriveOutcome(closedReason, error) 判 failed；旧 one-shot
    // 路径经 finalizeFailed → completeLegacyClosed 写 error 的等价承接）。
    rec.error = outcome.reason;
    nextResult = rec.result ?? `round did not complete: ${outcome.reason}`;
  } else {
    // [modeless 波1] 成功轮统一 chat 占位语义（旧 one-shot 分支
    // `content || rec.result || "(empty)"` 随 chatMode 消亡）。
    nextResult = outcome.content || "(no output this round)";
  }
  rec.result = nextResult;
  // ①③④：轮终翻边 idle（[two-state-convergence U4/D3] 收口权威词）+ 轮次推进 +
  // 清残留死因；⑥ idleSince 已退役（30 天空闲回收判据锚，ADR-0081）。resumable 字段已
  // 退役（[U5/D4]，见方法头⑤）。
  rec.status = "idle";
  rec.closedReason = undefined;
  rec.round = (rec.round ?? 0) + 1;
  // ⑩ [A-lite / 区1-U1+区3-U1] 轮终停因展示位：成功轮 completed / 失败轮 failed
  //（「上一轮为什么停」——任务卡片 failed 状态词 + 排障有词；投影随 ⑨
  // entry/recordToSubagent 自动携带）。status 已翻 idle（U4 翻边）；中断族走
  // markSettled interrupted 族不经本原语，值域无冲突。endedAt 内存位不写（终态冻结
  // 信号，写了会击穿方法头 A3 断言——同 record 跨轮轮终第二次即抛错；对齐
  // markSettled「非终态不写 endedAt」先例），收条时间戳只进磁盘面。
  const stopReason: StopReason = outcome.kind === "failed" ? "failed" : "completed";
  rec.stopReason = stopReason;
  // ⑪ [A-lite / U7 统计口径] 轮终磁盘面（锚分派对齐 markSettled 写法）：
  // 正常轮终后宿主崩溃 → markResurrected 的 revive 水合需 binding 快照在场
  //（turns/tokens 不归零，U7 目标在最常见形态成立）。`.state` 收条 = 轮收口 idle
  // 形态（U4 翻边后内存面与磁盘面同词——重建单规则「一律 idle」不再有桥接例外）。
  // best-effort 语义同 markSettled（失败 warn 留痕不抛——内存态已收口，磁盘面
  // 滞后由下次收口/接管补写）。
  const zcodeAnchor = rec.sessionFile === undefined ? zcodeRefOf(rec) : undefined;
  if (rec.sessionFile !== undefined) {
    // `.state` 轮终收条已退场（③）：轮终停因由 record-round-idle 事件承载，读侧从折叠取。
    persistSettleSnapshot(rec.sessionFile, rec);
  } else if (zcodeAnchor !== undefined) {
    // zcode 腿（无 pi 文件锚是常态形态非异常，不 warn——对齐 markSettled）：
    // 快照/收条承载 = transcriptRef 派生锚键；`.state` 无文件锚不写。
    persistSettleSnapshot(zcodeAnchorBasePath(zcodeAnchor), rec, zcodeAnchor);
  } else {
    logger.warn("[subagents] markRoundIdle: no sessionFile anchor, .state/binding faces skipped", {
      detail: { id },
    });
  }
  // ⑦ `.alive` 保留——无删除动作（D3a 跨轮延续，见方法头）。
  // ⑧ pending 注销发射点②（已接线 SubagentService 装配点；未注入时跳过——纯内存
  // 测试形态 no-op）。第二参数是注销 reason 字面量（notify-host emitPendingUnregister
  // 契约），非状态投影——轮终翻边不改变该字面量（U4 保留簿记，行为零变更）。
  ctx.emitPendingUnregister(id, "running");
  // ⑨ entry 上报（best-effort 过程面）→ [W1 / D2 停写写点] reportRecordTransition
  // 不再落 v1 快照 entry，只做引擎域回填感知（record-bound 帧）。
  ctx.reportRecordTransition(rec);
  // [W1 / D3 表行 4] record-round-idle 帧（轮终收条——stopReason + 轮统计快照 +
  // result 摘要锚 + 失败原因原文；.state 降级为本事件的落盘物化投影，D2 sidecar
  // 裁决表 .state 行）。摘要锚与 record-settled 同款截断（summarizeResultForJournal
  // 单源）——承接 v1 轮终 result 显示信号（U8b），本轮 rec.result 已在②定稿。
  // error 原文锚（W1 终态同步 F2-2 裁决）：失败轮承载 outcome.reason——v1 rec.error
  // 显示信号的 journal 承接；成功轮缺席。「轮始清残留死因」的投影侧语义由供源分流
  // 保证（round-started 后 lastEvent 非 round-idle，本值不透传）。
  ctx.appendJournalEvent(rec, {
    type: "record-round-idle",
    ts: Date.now(),
    // 轮终时点的累计轮数（[② 读侧换源] ——revive 水合 round 的折叠源，原 binding
    // round 快照的承载接替；③ increment 已在上方法簿记③完成）。
    round: rec.round ?? 0,
    stopReason,
    turns: rec.turnCount,
    totalTokens: rec.totalTokens,
    resultSummary: summarizeResultForJournal(nextResult),
    error: outcome.kind === "failed" ? outcome.reason : undefined,
    // 事件流自承载绑定侧独有字段（.record-binding 退场的前置）：轮被弃置的标记。
    ...(rec.lastAbandonedRound !== undefined ? { lastAbandonedRound: rec.lastAbandonedRound } : {}),
  });
  // ⑫ [B2] 轮终派生 manifest 投影（session-reader manifest 直读主路径的数据源）：
  // 轮终 record 留内存 idle（U4 翻边），不经任何终态/回收写点——缺本写则 records/
  // 目录长期缺席该 record，外部直读只能落 entry 慢兜底。写的是派生投影（缓存性质，
  // 与 markSettled 的 manifest 落盘字节同源），跨轮重复写幂等无害。
  ctx.writeDerivedManifest(rec);
  ctx.notifyChange();
  return true;
}

/**
 * 意图原语：引擎死亡收养（字段⑩——error/result/stopReason 三写，[U5/D4] 新态
 * entry = running + error + stopReason=failed + result=∅——status 保持 running，core
 * 机器语义不变，展示面靠 stopReason 子句排除（U6 终态判据
 * isOccupied 消费）；禁 completed 谎报 / closed 直接终局）。归口调用面已随 adopt
 * 派发链退役：one-shot engine-run 编排不再经本原语收口（原归口调用点随 U2b 修复轮
 * 移除），现仅测试直调可达（run-orchestration-write-lease.test.ts 用例 2/5 为退役
 * 与归口语义锚）。
 *
 * @returns false = id 不在内存（debug 留痕，无副作用）。
 */
export function adoptEngineDeathImpl(id: string, opts: { error: string }, ctx: RoundsCtx): boolean {
  const rec = ctx.records.get(id);
  if (rec === undefined) {
    logger.debug("[subagents] adoptEngineDeath: record not in memory", { detail: { id } });
    return false;
  }
  rec.error = opts.error;
  rec.result = undefined;
  // [U5/D4] W4 死亡纳管的跨重启标记从 resumable=true 迁移为 stopReason='failed'
  //（resumable 字段退役；failed 如实——引擎死亡即本轮失败证据，与 markRoundIdle
  // 失败轮的展示位值域一致）。
  rec.stopReason = "failed";
  ctx.reportRecordTransition(rec);
  ctx.notifyChange();
  return true;
}


// ============================================================
// [W1 / U2a] RecordEventsWriteFace——record 事件文件写面接线层
// ============================================================
//
// 为什么在本文件：事件落账的调用面主体 = RoundsCtx/TerminalCtx 注入位（轮次粒度
// 帧 / reopened / settled 均经轴文件 ctx 写入）——face 是这些注入位的共享写面
// 基础设施，与轮次簿记同文件聚合（容器经薄转发消费，见 record-store.ts 各写点）。
//
// 同步性设计（写点是同步方法，pi 工具 handler 同步链直调）：
// - foldOf **同步**返回——缓存 miss 时 readFileSync 全量 fold 装载（u0 scan 的
//   async 形态面向 U3 tail 消费；写点判定链需要同步值，此处用导出的
//   parseRecordEventFileLine + foldRecordEvents 组合同义装载，行解析与
//   fold 语义单源复用，不重复实现）；
// - append 走 u0 原语（createRecordEventJournal——seq 分配权与头行契约单点），
//   fire-and-forget 但落盘同步完成（appendFileSync 在调用轮内执行）；缓存增量
//   推进同步预推进 + then 校验（见 appendEvent）。
// - 写失败（fs 错）响亮 error 日志——事件文件是唯一事实源，静默丢失不可接受；
//   主流程不中断（同步写点无重抛通道，缓存回滚 = 状态如实滞后，下次全量装载自愈）。

const faceLogger = getLogger("subagents");

export class RecordEventsWriteFace {
  private readonly journal: RecordEventJournal;
  /** id → fold 当前态（写点幂等判定与 append 增量推进的单点状态；dispose/revive
   *  由容器调 resetFoldCache 重置——事件文件可能已被外部/清理通道改变）。 */
  private readonly foldCache = new Map<string, RecordEventFoldState>();

  constructor(
    /** recordsDir（与 manifest 同目录——D3 落点，事件文件 = `<dir>/<sa-id>.events`）。 */
    private readonly recordsDir: string,
    /** 主 session 条目上报通道（v2 两条款经 pi appendEntry 落主 session——D1）。 */
    private readonly appendEntry: (customType: string, data: unknown) => void,
    /** bound manifest 物化写面（D2 决策 9）——record-store.ts 构造点绑定
     *  materializeBoundRecordManifest(recordsDir, derivedManifestRecord(recordToSubagent(rec)))。
     *  经构造参数注入的理由同 RoundsCtx 的 writeDerivedManifest：manifest 写函数调用
     *  字面只留 record-store.ts（R1 豁免面），本文件不 import 写函数。 */
    private readonly materializeBoundManifest: (record: ExecutionRecord) => void,
  ) {
    this.journal = createRecordEventJournal(recordsDir);
  }

  // ── fold 读面 ─────────────────────────────────────────────

  /** 同步 fold（缓存 miss → 文件全量装载；文件缺 ENOENT = 空 journal 态）。 */
  foldOf(id: string): RecordEventFoldState {
    const hit = this.foldCache.get(id);
    if (hit !== undefined) return hit;
    let content: string;
    try {
      content = fs.readFileSync(recordEventsPath(this.recordsDir, id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        faceLogger.warn("[subagents] record event journal read failed (treated as empty)", { detail: { id, error: err instanceof Error ? err.message : String(err) } });
      }
      this.foldCache.set(id, INITIAL_RECORD_EVENT_FOLD_STATE);
      return INITIAL_RECORD_EVENT_FOLD_STATE;
    }
    const events: RecordJournalEvent[] = [];
    for (const line of content.split("\n")) {
      const event = parseRecordEventFileLine(line);
      if (event !== undefined) events.push(event); // 空行/头行/坏行跳过（u0 行解析器内消化）
    }
    const state = foldRecordEvents(events);
    this.foldCache.set(id, state);
    return state;
  }

  /** dispose / revive 后的缓存复位（事件文件可能已被改变，按需重装载）。 */
  resetFoldCache(): void {
    this.foldCache.clear();
  }

  // ── 写点（幂等判定在 face，容器零判定逻辑）────────────────

  /**
   * register 写点（D3 表行 1）：record-created 帧（唯一事实写）+ v2 注册条目
   * （身份与锚点）。幂等：事件文件已有创建帧（revive / 重启后重注册）时跳过
   * 两面——事件文件是「已注册」的判定权威。
   */
  syncCreation(record: ExecutionRecord): void {
    if (this.foldOf(record.id).identity !== undefined) return;
    this.appendEvent(record.id, buildCreatedEventPayload(record));
    this.appendEntry(SUBAGENT_RECORD_CUSTOM_TYPE, toRegisteredEntryData(record));
  }

  /**
   * reportRecordTransition 写点（D2 停写写点的接替面 / D3 表行 2）：引擎域
   * （sessionFile/engine/engineHandle）相对已落账 bound 帧变化时落 record-bound
   * 帧（spawn 回填）+ bound manifest 物化一次（D2 决策 9：zcode 运行窗口锚定；
   * 锚定就绪守卫与写失败降级在 materializeBoundRecordManifest）。引擎域未变
   * （高频 turns 归约后的过渡调用）时零写入。
   */
  syncBoundEvent(record: ExecutionRecord): void {
    const { sessionFile, engine, engineHandle } = record;
    // 全缺 = spawn 未回填（无锚可落账）：零写入（transition 的过程面消费到此为止）。
    if (sessionFile === undefined && engineHandle === undefined && engine === undefined) return;
    if (isBoundSignatureUnchanged(this.foldOf(record.id).bound, sessionFile, engine, engineHandle)) {
      return; // 引擎域签名未变：零追加（事件面不随过程调用放大）
    }
    this.appendEvent(record.id, buildBoundEventPayload(record));
    // bound manifest 物化（与轮终簿记⑫同款派生投影——manifest 是物化投影不是
    // 条目；守卫（pi 子文件存在性 / zcode 零探查）与写失败降级在被调函数内）。
    // 经构造参数注入调用（本文件不 import manifest 写函数，见构造函数注释）。
    this.materializeBoundManifest(record);
  }

  /**
   * 终局写点（D3 表行 5；markSettled 与 archive 真终局共用注入位）：record-settled
   * 帧 + v2 终态条目（终态条目是 result 全文的唯一落点——事件行只存摘要锚）。
   * 幂等：fold 已 settled 即跳过两面（archive 真终局在 markSettled 之后的重复
   * 终局写点不再追加）。
   */
  settleViaJournal(record: ExecutionRecord, endedAt: number): void {
    if (this.foldOf(record.id).settled !== undefined) return;
    this.appendEvent(record.id, buildSettledEventPayload(record, endedAt));
    this.appendEntry(SUBAGENT_RECORD_CUSTOM_TYPE, toSettledEntryData(settledEntrySourceOf(record), endedAt));
  }

  /** 通用事件追加注入位（round-started / round-idle / reopened / 收编 settled——
   *  轴文件 ctx 注入与容器收编入口共用；幂等判定由调用方先行）。 */
  appendJournal(id: string, input: RecordJournalEventInput): void {
    this.appendEvent(id, input);
  }

  /**
   * append 单点（同步预推进 + 落盘校验双层）：
   * - **同步预推进**：seq 预测 = 缓存水位 + 1，立即应用进缓存。必须同步：写点是
   *   同步方法，同一调用链中下一个写点的幂等判定（foldOf）在本调用返回前执行——
   *   缓存等微任务推进会读到滞后态（实测：轮次轴 markRoundStarted →
   *   reportRecordTransition 链中 bound 帧被重复落账）。
   * - **then 校验**：断层（full.seq > 水位+1）= 外部写入，作废缓存重装载；恰落后
   *   一格 = 按落盘真值补齐；≤ 水位 = 缓存已含或已领先（同步段连续 append 正常态）。
   * - fs 错误响亮 error（唯一事实源写失败不可静默），缓存回滚（预推进撤销——
   *   落盘未发生，缓存不得持有幽灵事件）。
   */
  private appendEvent(id: string, input: RecordJournalEventInput): Promise<void> {
    const cur = this.foldOf(id);
    const predicted = { ...input, seq: cur.lastSeq + 1 } as RecordJournalEvent;
    this.foldCache.set(id, applyRecordEvent(cur, predicted));
    return this.journal
      .append(id, input)
      .then((full) => {
        const now = this.foldCache.get(id);
        if (now === undefined || full.seq <= now.lastSeq) return; // 并发清理 / 缓存已含或已领先（连续 append 正常态）
        if (full.seq > now.lastSeq + 1) {
          this.foldCache.delete(id); // 断层：外部写入——作废缓存，下次如实重装载
          return;
        }
        this.foldCache.set(id, applyRecordEvent(now, full)); // 恰落后一格：按落盘真值补齐
      })
      .catch((err: unknown) => {
        this.foldCache.delete(id);
        faceLogger.error(
          `[subagents] record event journal append failed (id=${id}, type=${String(input.type)}) — fact source write lost: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}
