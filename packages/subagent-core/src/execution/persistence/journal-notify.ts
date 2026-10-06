// src/execution/persistence/journal-notify.ts
//
// core→壳 journal 落盘事件出口（event-push-channel W-P1，设计权威源
// .tmp/tech-design/event-push-channel.md §3.1/§3.3）。
//
// journal（事件账本 JSONL）写入方 = 本包（run 域单写者 terminal-actions、record 域
// record-store 族）；推送点 = 落盘提交点之后（推送语义与事实源同点——推的内容就是
// 刚落盘的行，seq 已分配）。本模块是这条通道的 core 侧出口，注入模式与
// execution/engine/inflight-snapshot.ts 的 setInFlightListener 同款：
//   - 监听者由壳层（extensions/universal/subagent-workflow host/journal-reporter）注册，
//     core 同步调用、绝不 await 返回值——落盘主链不被推送拖住；
//   - core 闭包红线：本模块零 pi SDK import（零领域依赖，persistence 层叶子），
//     壳层经包根 barrel 消费 setJournalAppendListener（exports 面收窄后壳侧生产
//     消费必须走 barrel，无深路径豁免）。
//
// 事件载荷纪律：events = 刚落盘的完整事件（含 seq），按写入序；单次调用通常一条
// （append 逐条），批量合并归壳层 reporter（串行化合并缓冲）。监听者异常不反噬
// core（壳层 bug 不得打断落盘主链），catch 后照常返回。
//
// 进程级单监听者（与 inflight 出口同理——journal 写入本身是进程级单写者状态），
// 后注册覆盖先注册（jiti 模块重载 / 多 factory 实例场景幂等），null 注销。

/** journal 两域（与 extension-protocol SubagentJournalDomain 同词表——通道载荷判别字段）。 */
export type JournalDomain = "run" | "record";

/**
 * 壳层注册的监听回调（同步、fire-and-forget；core 不 await 不重试）。events =
 * 刚落盘的完整事件（结构化对象，含 type/ts/seq 信封——序列化与域词表校验归壳层
 * 与读侧，core 不在此塑形）。
 */
export type JournalAppendListener = (
  domain: JournalDomain,
  fileKey: string,
  events: readonly unknown[],
) => void;

let listener: JournalAppendListener | null = null;

/** 壳层注册监听（extension factory 装配点调用；传 null 注销）。 */
export function setJournalAppendListener(next: JournalAppendListener | null): void {
  listener = next;
}

/**
 * 落盘提交点调用：把刚落盘的事件同步推给监听者。约束：
 *   - 同步 void 语义——调用方（append 链内）不 await 本函数的任何下游（监听者内部
 *     自行合并缓冲 + fire-and-forget 推送）；
 *   - 监听者异常不反噬 core（壳层 bug 不得打断 journal 落盘主链），catch 后照常返回。
 */
export function notifyJournalAppended(
  domain: JournalDomain,
  fileKey: string,
  events: readonly unknown[],
): void {
  if (listener === null || events.length === 0) return;
  try {
    listener(domain, fileKey, events);
  // eslint-disable-next-line taste/no-silent-catch -- 推送出口故障刻意静默（与 notifyInFlightChanged 同款）：壳层 bug 不得打断落盘主链；丢一帧由消费方 seq 缺口补读收敛，记日志徒增 core logger 噪音面
  } catch {
    // 同上：静默是接受的。
  }
}
