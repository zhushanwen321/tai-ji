// src/execution/persistence/record-store-rounds.ts
//
// [H4 三轴拆分 / 轮次簿记轴] RecordStore 轮次过程原语的实现体：
//   - appendEvent（事件追加，turns/eventLog/totalTokens 归约）；
//   - markRoundStarted（轮始重置——字段①②⑤ + [U6/D4] stopReason 清点）；
//   - markRoundIdle（轮末收口簿记全集①-⑪——[two-state-convergence U4/D3] 轮终翻边
//     写 idle + A-lite 轮终磁盘面 `.state` 收条 + binding 快照 + pending 注销发射点②）；
//   - adoptEngineDeath（引擎死亡收养——error/result/stopReason 三写，[U5/D4] W4 新态）。
//
// 变化轴 = 「一轮会话的过程簿记」（轮始重置 / 轮终收口 / 事件归约 / 收养）——
// 轮次语义演进（SP-5 升级链、A-lite 展示位、U7 统计口径的轮终快照）集中在此。
// binding settle 快照本体在终态原语轴（record-store-terminal.ts），本文件消费。
//
// [D7 写面约束] 同终态轴：`.state` 写函数经 RoundsCtx 注入（persistSettledState
// 注入名避开七名），本文件零 R1 字面、零七名 import。依赖方向单向：
// rounds → {terminal, rebuild}，不回 import store。

import { getLogger } from "../../core/logger.ts";

import { updateFromEvent } from "./execution-record.ts";
import { zcodeAnchorBasePath } from "./state-marker.ts";
import { persistSettleSnapshot } from "./record-store-terminal.ts";
import { zcodeRefOf } from "./record-store-rebuild.ts";
import type { AgentEvent, ExecutionRecord, StopReason } from "../assembly/types.ts";
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
  /** `.state` settle 收条写（writeSettledState 注入位）。 */
  persistSettledState: (sessionFile: string, payload: { stopReason?: StopReason; endedAt?: number }) => boolean;
  /** pending-notifications 轮终注销（发射点②；未注入时容器侧 no-op）。 */
  emitPendingUnregister: (id: string, status: string) => void;
  reportRecordTransition: (record: ExecutionRecord) => void;
  notifyChange: () => void;
}

/**
 * 意图原语：事件追加（过程记录）。turns/eventLog/totalTokens 经 execution-record
 * 事件归约累积（字段⑧），随后 entry 变迁上报（best-effort——过程面可丢，重建由
 * 子 session 文件承接）。调用方按事件粒度决定调用频率（高频 delta 逐事件上报会
 * 放大 entry 写面，编排粒度属调用方职责）。
 *
 * @returns false = id 不在内存（未注册/已归档）——事件丢弃并 debug 留痕。
 */
export function appendEventImpl(id: string, event: AgentEvent, ctx: RoundsCtx): boolean {
  const rec = ctx.records.get(id);
  if (rec === undefined) {
    logger.debug("[subagents] appendEvent: record not in memory (not registered / archived)", {
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
  rec.stopReason = undefined;
  ctx.reportRecordTransition(rec);
  ctx.notifyChange();
  return true;
}

/**
 * 意图原语：轮末收口——**写 idle**（[two-state-convergence U4/D3] A-lite 桥接退役：
 * 「轮已收口」回归 §3.2.2 事件表 `running --settle--> idle` 的单字段编码，对齐
 * markSettled/`.state` 收条/重建单规则。SP-5 兼容性已核验（设计 D3）：升级 gate
 * canUpgradeToConversation 查引擎能力不查 status；message 准入走 tryEnterRunning CAS
 * （idle→running）；onMessage 按 `status!=='running'` 分流进 revive 格——idle 形态
 * 本就是 revive 直通路径的设计输入）。簿记全集（①-⑪）：
 *   ① status 写 idle；② result 按 outcome 写入（成功=content / 失败=前值??
 *      失败摘要 + lastError）；③ round+1；④ closedReason 清除（[S10]）；⑤ resumable
 *      字段已退役（[U5/D4] idle 即 resumable——字段从 record/entry 契约整体删除，
 *      无簿记动作）；⑥ idleSince 刷新
 *      （idle-GC 判据锚）；⑦ **`.alive` 保留**
 *      （D3a 跨轮延续——写权声明至 release 两出口[终态原语/idle-GC 归档]，轮终
 *      record 随时续聊 spawn 写同一 sessionFile，删则轮后跨进程防御
 *      空窗）；⑧ pending 注销发射点②（进程已死，从活跃后代差集移除——经
 *      setPendingUnregister 注入，未注入时跳过）；⑨ reportRecordTransition（entry
 *      携带新 round 与本轮 result）；
 *      ⑩ [A-lite] stopReason 展示位（成功轮 completed / 失败轮 failed——status 已
 *      idle，endedAt 不写）；⑪ [A-lite / U7] 轮终磁盘面（锚分派对齐 markSettled：
 *      pi 腿 `.state` 收条 + binding 快照 / zcode 腿锚键 binding 快照——正常轮终后
 *      宿主崩溃 revive 水合 turns/tokens 不归零）。
 * worktree/通知等副作用编排留调用方。
 *
 * @param outcome 轮终结果（kind 判别：success=content / 失败=reason）
 * @returns false = id 不在内存（debug 留痕，无副作用）。
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
  // ② result 写入规则（D7）：成功轮 = content（chat 空 content 兜底占位）；失败轮 =
  // 前值保真 ?? 失败摘要 + lastError 写失败原因（字段⑨）。
  let nextResult: string | undefined;
  if (outcome.kind === "failed") {
    rec.lastError = outcome.reason;
    nextResult = rec.result ?? `round did not complete: ${outcome.reason}`;
  } else if (rec.chatMode) {
    nextResult = outcome.content || "(no output this round)";
  } else {
    nextResult = outcome.content || rec.result || "(empty)";
  }
  rec.result = nextResult;
  // ①③④⑥：轮终翻边 idle（[two-state-convergence U4/D3] 收口权威词）+ 轮次推进 +
  // 清残留死因 + idle 锚。resumable 字段已退役（[U5/D4]，见方法头⑤）。
  rec.status = "idle";
  rec.closedReason = undefined;
  rec.round = (rec.round ?? 0) + 1;
  rec.idleSince = Date.now();
  // ⑩ [A-lite / 区1-U1+区3-U1] 轮终停因展示位：成功轮 completed / 失败轮 failed
  //（「上一轮为什么停」——SubagentList failed 红点判据词 + 排障有词；投影随 ⑨
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
    ctx.persistSettledState(rec.sessionFile, { stopReason, endedAt: Date.now() });
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
  // ⑨ entry 上报（best-effort 过程面）。
  ctx.reportRecordTransition(rec);
  ctx.notifyChange();
  return true;
}

/**
 * 意图原语：引擎死亡收养（字段⑩——error/result/stopReason 三写，[U5/D4] W4 新态
 * entry = running + error + stopReason=failed + result=∅——status 保持 running，core
 * 机器语义不变（supervisor 接管链照旧），展示面靠 stopReason 子句排除（U6 终态判据
 * isOccupied 消费）；禁 completed 谎报 / closed 直接终局）。归口写点：
 * adoptResumableAfterEngineDeath（run-orchestration——已随 U2b 修复轮迁移）；
 * 监督器 adoptOnProcessDeath 编排留调用方。
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
