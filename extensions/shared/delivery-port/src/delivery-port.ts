// src/delivery-port.ts
//
// pi 半区投递端口主体（设计 .tmp/tech-design/unified-delivery.md §3.7 组件表）：
// 把 pi 扩展运行时端口接线成 @zhushanwen/session-delivery v3 内核的 port 半区
// 装配——custom 车道唯一执行者。与账本（notify-ledger）的四步生命周期逐条对位：
//   ① record（受理前落盘）→ deliver 入口 appendEntry（outbox，plain entry）；
//   ② deliver（投递）→ 内核 on-accept 受理即出站 → pi.sendMessage 直达唯一队列
//     （两档出队由 pi 原生 steer/followUp 队列承载，本端口零注入时机代码——提交
//     侧缓冲只决定「何时把账交给内核」，不持注入队列、零自建出队机制）；
//   ③ ack（销账）→ message_end 事件命中 details.deliveryId → 内核
//     confirmDeliveredByProof → 内核终局 store.ack → appendEntry(ack)；
//   ④ replay（重启恢复）→ session_start 差集重放（outbox − delivered − ack）。
//
// 装配形态（§3.7）：每 session 一份（session_start 重绑 = 旧实例 dispose + 新实例
// recover）；消费方经 Symbol.for 进程级槽 getDeliveryPort 获取（C-ext-06 惯例）。
//
// ── 提交侧双缓冲与按通道分组放行（§3.7 合批行 + 批组隔离行）───────────────
// 全部提交先落盘再进提交缓冲（攒批成员 mergeBuffer / 直通成员 directBuffer），由
// 放行泵按通道分组交给内核：
//   - 默认通道组（subagent-bg-notify）：60s 滑动窗口攒批（攒批条件 = 有活跃后台
//     任务），到期/flush 时经 merge-commit hold 逐条提交内核（注入闸门 hold →
//     内核 retain → 条目 queued 聚合）→ kernel.flush() → 内核 buildBatchPayload
//     合成一条 {batch:true, items} 消息一次 sendMessage 入队；
//   - 外部通道组（workflow-result / managed-session-notify 等）：逐条提交、逐条
//     消息（账本 [u9] 分组规则——batch 合并形态对外部通道无消费契约）。
// 分组放行的不变量：内核 queued 集恒来自单次单组放行 → 内核 doSend 的合批产物恒
// 单通道——批组隔离不依赖时序巧合（混批窗口结构性消除；残余边界见 pumpDirect
// 注释）。双缓冲（攒批/直通分离）的原因：直通放行不得携带窗口攒批成员（窗口语义
// = 攒到到期/flush）。账目/幂等/回执/ack 全程逐条（成员各自独立内核条目，
// items[].deliveryId 逐项对位），合批只发生在注入形态。
//
// ── compaction 防御（§3.8 提交侧等待）────────────────────────
// 挂起判定 = compaction 事件标记（session_before_compact → 置位；session_compact /
// session_compact_failed → 复位）：标记 true 时整缓冲挂起（落盘已完成，等待只是注入
// 时机的悬置），边沿复位 + 唤醒重放。标记不查 host.isIdle()——isIdle 复合了「run
// 活跃」与「compaction 进行中」两态，run 活跃必须放行（sendMessage 入 pi steer 队列
// 不拒；挂起会让通知等到 settled 边沿甚至永不唤醒），只有 compaction 期间才须挂起
// （triggerTurn 分支会与 compaction 并发起新 run）。内核侧 retain 条目（注入失败留
// 守）的重投由 settled 边沿与本边沿的 kernel.flush() 驱动（事件驱动无定时器）。内核
// send 内保留第二道防线（标记检查，覆盖提交同步链与 compaction 边沿交叠的残余窗口）；
// 标记读取无异常面（原 isIdle 探测的保守 busy 吞咽随预检移除）。
//
// ── 耐久面的分工（为什么 store.persist 是 no-op）─────────────
// outbox 权威 = 成员记录（deliver 入口 appendEntry，先于受理——「耐久承诺先于投递
// 尝试」内核契约由该同步时序等价兑现：appendEntry 抛错 = 承诺未落 → deliver 返回
// rejected("persist-failed")，不进投递流程）。内核侧 store.persist 因此有意 no-op：
// 成员记录若由内核 persist 再落盘会与成员记录双写（重放差集把同一条当两条重建，
// 合批投出后成员记录无法单独销账 → 必然双投）。port 的内核句柄是本闭包私有面，
// store 的 no-op 形态不外泄。store 其余职责（ack / discard / loadUndelivered /
// loadTerminalIds / hasTerminal）照常承载。

import { createDelivery } from "@zhushanwen/session-delivery";
import type {
  CustomPayload,
  DeliveryConfigWithWarn,
  DeliveryFailurePolicy,
  DeliveryMessage,
  DeliveryPort as KernelPort,
  DeliveryStore,
  DeliveryStoreRecord,
  DeliveryIntent,
} from "@zhushanwen/session-delivery";

import {
  ACK_CUSTOM_TYPE,
  DEFAULT_NOTIFY_CUSTOM_TYPE,
  OUTBOX_CUSTOM_TYPE,
  extractDeliveryIds,
  isPlainObject,
  scanJournal,
  type JournalRecord,
  type JournalScan,
} from "./journal.ts";
import type {
  DeliveryDeliverOptions,
  DeliveryDeliverResult,
  DeliveryEnvelope,
  DeliveryPortHandle,
  DeliveryPortHost,
  DeliveryPortMetrics,
  DeliveryTiming,
} from "./types.ts";
import { deliveryCollectStubs } from "./types.ts";

/** 提交侧合批窗口（账本 MERGE_WINDOW_MS=60s 现状保持，设计 §3.7 合批行）。 */
const MERGE_WINDOW_MS = 60_000;

/** 进程级槽键（C-ext-06：Symbol.for + globalThis，防 jiti 多实例槽分裂）。 */
export const DELIVERY_PORT_SLOT_KEY = Symbol.for("@zhushanwen/pi-delivery-port.deliveryPort");

type DeliveryPortSlot = { current: DeliveryPortHandle | undefined };

function getSlot(): DeliveryPortSlot {
  // globalThis 无 symbol 索引签名，Reflect 安全读写
  let slot = Reflect.get(globalThis, DELIVERY_PORT_SLOT_KEY) as DeliveryPortSlot | undefined;
  if (!slot) {
    slot = { current: undefined };
    Reflect.set(globalThis, DELIVERY_PORT_SLOT_KEY, slot);
  }
  return slot;
}

/**
 * session_start 装配入口：构造端口并绑定为进程级单例。重复 bind（/resume /fork
 * /new 的 session_start）先 dispose 旧实例再绑定新实例（dispose 旧实例 + 重建
 * ——内核态按 session 重建，防跨 session 重投）。
 * 调用方随后应调 handle.recover() 完成差集重放（装配点接线）。
 */
export function bindDeliveryPort(host: DeliveryPortHost): DeliveryPortHandle {
  getSlot().current?.dispose();
  const handle = createDeliveryPort(host);
  getSlot().current = handle;
  return handle;
}

/** 消费入口：未装配（缺席窗口）→ undefined——调用方按缺席语义降级直发 + warn。 */
export function getDeliveryPort(): DeliveryPortHandle | undefined {
  return getSlot().current;
}

/** 测试隔离：dispose 并清进程级绑定（生产禁用——绑定生命周期与 session 一致）。 */
export function _resetDeliveryPortForTest(): void {
  getSlot().current?.dispose();
  getSlot().current = undefined;
}

// ─── 端口构造 ───────────────────────────────────────────────

/**
 * 构造投递端口（内核装配 + 提交侧机制 + 回执订阅 + 重放）。
 * 事件订阅在构造期建立、dispose 时退订——构造即生效，不依赖调用方再接线。
 */
export function createDeliveryPort(host: DeliveryPortHost): DeliveryPortHandle {
  const scan = scanJournal(host.readSessionEntries(), Date.now());
  const state = new JournalState(scan);
  const buckets: DeliveryPortMetrics = { settleRejected: 0, recoveryReplays: 0 };
  let disposed = false;
  /**
   * 提交双缓冲（落盘已完成，等待放行；仅在缓冲期持有，放行即摘）：
   * - mergeBuffer = 默认通道攒批成员（60s 窗口，到期聚合批放行）；
   * - directBuffer = 直通成员（外部通道 / 无后台任务 / merge:false；按通道分组
   *   立即放行）。
   * 分两缓冲的原因：直通放行不得携带窗口攒批成员（窗口语义 = 攒到到期/flush），
   * 统一单缓冲时「直通触发的 pump」会把窗口成员提前冲出——正是内核 v1 clearMergeTimer
   * 注释登记过的「孤儿 timer 冲出窗口成员」同构缺陷，结构性规避。
   */
  const mergeBuffer = new Map<string, JournalRecord>();
  const directBuffer = new Map<string, JournalRecord>();
  /** 已受理 id 索引（deliver 幂等预检的全窗口快路径；内核三级判重对已入内核条目
   *  兜底）。仅增量添加，无淘汰——量级 = 每 session 通知总量（数十~数百）。 */
  const seenIds = new Set<string>();
  let mergeTimer: ReturnType<typeof setTimeout> | undefined;
  /** merge-commit 期标志：默认通道组逐条提交内核期间 hold 注入，使成员聚合为内核
   *  queued 集，最后 kernel.flush() 一次合批出站（见文件头分组放行段）。 */
  let mergeCommitting = false;
  /**
   * compaction 挂起标记（§3.8 提交侧等待的唯一判定源）：事件标记承载——
   * session_before_compact 置位 / session_compact / session_compact_failed 复位。
   * 不查 host.isIdle()：isIdle 复合「run 活跃」（须放行——sendMessage 入 pi steer
   * 队列不拒）与「compaction 进行中」（须挂起——triggerTurn 分支会与 compaction
   * 并发起新 run）两态，复合语义会误挂 run 活跃期的通知（run 结束不产生
   * session_compact，挂起成员可能永不唤醒）。
   */
  let compacting = false;
  let idSeq = 0;
  /**
   * 显式覆写的失败保留策略（deliver opts.onFailure → submitToKernel 的单次传递）：
   * 条目在提交缓冲期（合批窗口 / compaction 挂起）暂存 id → policy，提交内核时
   * 消费并摘除。不进 JournalRecord / outbox schema（§3.7 耐久面行 schema 定形，
   * 策略是提交时选项非账目字段）。重放重建的条目不在册（缺省 retain）：forget
   * 条目首败即 discard 落终局列、不在重放差集；「首败前崩溃」的残留条目重放按
   * retain 重投（通知域安全侧，多留账不丢不重）。
   */
  const failurePolicies = new Map<string, DeliveryFailurePolicy>();

  function warn(msg: string, err?: unknown): void {
    host.logger.warn(msg, err === undefined ? undefined : { error: toErrorMessage(err) });
  }

  // ─── 内核装配（v3 on-accept 模式 + session entry store + details-id 凭据）───

  const store: DeliveryStore = {
    persist(_record: DeliveryStoreRecord): void {
      // 有意 no-op：port 半区落盘在 deliver 提交层前置完成（文件头「耐久面的分工」）。
    },
    ack(id: string): void {
      // 内核终局（delivered / cancelled）→ 持久终局列。抛错由内核 ackStore 捕获
      // warn（终局事实已发生不回滚）——本层不重复吞咽。
      host.appendEntry(ACK_CUSTOM_TYPE, { v: 2, id });
      state.ackedIds.add(id);
    },
    discard(id: string): void {
      // forget 失败条目的持久标记：append-only 介质下与 ack 同列（outcome:"discarded"），
      // 重放差集同判「不再重投」。port 半区 retain 为主，本路径仅显式覆写 forget 可达。
      host.appendEntry(ACK_CUSTOM_TYPE, { v: 2, id, outcome: "discarded" });
      state.ackedIds.add(id);
    },
    loadUndelivered(): readonly DeliveryStoreRecord[] {
      return [...state.outbox.values()]
        .filter((r) => !state.ackedIds.has(r.id) && !state.deliveredIds.has(r.id))
        .map(toStoreRecord);
    },
    loadTerminalIds(): readonly string[] {
      return [...state.ackedIds, ...state.deliveredIds];
    },
    hasTerminal(id: string): boolean {
      return state.ackedIds.has(id) || state.deliveredIds.has(id);
    },
  };

  /**
   * 内核出站端口（intent → pi 参数翻译在适配器内；内核零 pi 词汇纪律由此收口）。
   * 方法体引用的闭包变量（mergeCommitting / compacting / buckets）在内核出站时点
   * 已初始化。
   */
  const kernelPort: KernelPort = {
    supportedPayloads: ["custom"],
    // 内核接口必填成员；on-accept 模式内核 busy gate 短路旁路（delivery.ts flush/
    // scheduleFlush 均先判 on-accept），恒不被消费。提交侧挂起判定 = compacting
    // 事件标记（见 send 第二道防线与放行泵预检），不走本探测。
    isIdle: () => host.isIdle(),
    subscribeSettled: (cb) => host.onAgentSettled(cb),
    send(msg: DeliveryMessage, intent: DeliveryIntent) {
      // merge-commit 期 hold：默认通道组聚合窗口（文件头分组放行段）。设计内等待
      // 非失败，不计 settleRejected（内核 retain warn 逐条留痕可查）。
      if (mergeCommitting) {
        return { accepted: false, reason: "merge-commit-hold" };
      }
      // 提交侧 compaction 等待（§3.8）的第二道防线：pump 的缓冲挂起是常态路径
      // （提交前统一预检），本检查覆盖「提交同步链与 compaction 边沿交叠」的
      // 残余窗口。标记 true 即留账（内核 retain）等唤醒边沿重投。
      if (compacting) {
        return { accepted: false, reason: "compaction-wait" };
      }
      const payload = msg.payload;
      if (payload.kind !== "custom") {
        return { accepted: false, reason: "unsupported-payload" };
      }
      const deliverAs: DeliveryTiming = intent === "after-run" ? "followUp" : "steer";
      try {
        host.sendMessage(
          {
            customType: payload.customType,
            content: payload.content,
            display: payload.display,
            details: payload.details,
          },
          { deliverAs, triggerTurn: true },
        );
      } catch (err) {
        // 注入类失败不吞咽（§3.7 失败行）：计数 + 上抛 → 内核首败 → retain 留账
        buckets.settleRejected += 1;
        emitBucketLog("settleRejected", buckets.settleRejected);
        throw err;
      }
      return { accepted: true };
    },
  };

  const kernelConfig: DeliveryConfigWithWarn = {
    intent: "interrupt-at-turn-boundary",
    dispatchMode: "on-accept",
    store,
    // details-id 凭据判定：state.deliveredIds 由 message_end 边沿增量维护（事件与
    // entry 写入同栈——收到事件 = entry 已持久），O(1) 且锚定磁盘事实。
    proofCheck: (id: string) => state.deliveredIds.has(id),
    warn,
  };
  const kernel = createDelivery(kernelPort, kernelConfig);

  // ─── 事件订阅（构造期建立 / dispose 退订）──────────────────

  const unsubMessageEnd = host.onMessageEnd(onMessageEnd);
  const unsubBeforeCompact = host.onSessionBeforeCompact(onBeforeCompact);
  const unsubCompact = host.onSessionCompact(onCompactionEdge);
  const unsubCompactFailed = host.onSessionCompactFailed(onCompactionEdge);

  /**
   * compaction 开始边沿：挂起标记置位（此后整缓冲挂起 + 内核 send 拒受理，直至
   * 终态边沿复位）。manual /compact / threshold / overflow recovery 全 trigger 在
   * 此收口（pi 两路发射点：manual compact 与 auto compaction）。
   */
  function onBeforeCompact(): void {
    if (disposed) return;
    compacting = true;
  }

  /**
   * compaction 终态边沿（成功/失败同一处理）：挂起标记复位 + 缓冲挂起成员重放 +
   * 内核 retain 条目重投尝试。失败边沿同样唤醒（失败也要尝试恢复；失败可见性归
   * 日志）。复位先于放行——挂起预检读本标记。
   */
  function onCompactionEdge(): void {
    if (disposed) return;
    compacting = false;
    try {
      flushMergeBuffer("compaction-edge");
      pumpDirect();
      kernel.flush();
    } catch (err) {
      warn("delivery-port post-compaction dispatch failed", err);
    }
  }

  /**
   * 送达凭据边沿（'details-id'）：注入消息落 transcript 时 pi 同栈 emit message_end
   * （探针 V2：注入时点即发 message_end 并写 custom_message entry）。事件 message
   * = 注入的 custom 消息本体（role:"custom" + customType + details）。命中判定锚定
   * 磁盘事实（entry 已写），本边沿只是「证据到达」的触发点（内核 confirmDeliveredByProof
   * 契约注释的装配方义务）。
   *
   * 逐 id 驱动确认：单条消息 details.deliveryId / 内核合批消息 items[].deliveryId
   * （各成员独立内核条目，逐条确认逐条 ack）。证据先登记再确认（proofCheck 读增量
   * 集——事件与 entry 写入同栈，登记即事实）。
   */
  function onMessageEnd(raw: unknown): void {
    if (disposed) return;
    try {
      if (!isPlainObject(raw) || raw["role"] !== "custom") return;
      const customType = raw["customType"];
      if (typeof customType !== "string" || !state.channels.has(customType)) return;
      const ids = extractDeliveryIds(raw["details"]);
      if (ids.length === 0) return;
      for (const id of ids) state.deliveredIds.add(id);
      let confirmed = 0;
      for (const id of ids) {
        // 非在册 id（v1 存量已投递条目 / 上一 port 实例的条目）confirm 幂等 no-op
        if (kernel.confirmDeliveredByProof(id)) confirmed += 1;
      }
      if (confirmed === 0) {
        host.logger.debug("delivery-port message_end ids confirmed none in-ledger", {
          detail: { ids },
        });
      }
    } catch (err) {
      // 边沿回调异常不向 pi 事件循环传播；错过边沿的回执由 session_start 差集重放兜底
      warn("delivery-port message_end handler failed; receipt picked up by next replay", err);
    }
  }

  // ─── 提交入口 ──────────────────────────────────────────────

  function deliver(envelope: DeliveryEnvelope, opts?: DeliveryDeliverOptions): DeliveryDeliverResult {
    if (disposed) {
      warn("deliver ignored: delivery port disposed (caller should re-acquire via getDeliveryPort)");
      return { kind: "rejected", reason: "disposed" };
    }
    const id = envelope.id ?? genId();
    // 幂等预检（全窗口快路径）：缓冲成员 / 已受理条目命中即吞。内核三级判重对已入
    // 内核条目兜底（本预检 miss + 内核命中 → 放行时内核返回 swallowed，丢弃不重投）。
    if (seenIds.has(id)) {
      warn(`deliver swallowed by idempotency dedupe: id already seen (id=${id})`);
      return { kind: "swallowed", reason: "already-seen" };
    }
    const timing: DeliveryTiming = envelope.timing ?? "steer";
    const channel = envelope.payload.customType;
    // 受理前落盘（耐久承诺先于投递尝试）：appendEntry 抛错 = 承诺未落 → 拒收。
    const record: JournalRecord = {
      id,
      timing,
      payload: { ...envelope.payload },
      recordedAt: Date.now(),
    };
    try {
      host.appendEntry(OUTBOX_CUSTOM_TYPE, {
        v: 2,
        id,
        timing,
        payload: record.payload,
        recordedAt: record.recordedAt,
      });
    } catch (err) {
      warn(`delivery-port persist failed before accept; entry rejected (id=${id})`, err);
      return { kind: "rejected", reason: "persist-failed" };
    }
    state.outbox.set(id, record);
    state.channels.add(channel);
    // 显式失败策略随条目登记（submitToKernel 单次消费；缺省 retain 不占位）。
    // 登记在落盘成功后——persist-failed rejected 的条目不残留策略项。
    if (opts?.onFailure) failurePolicies.set(id, opts.onFailure);
    // 攒批判定（§3.4 缺省值表）：默认通道 + 有活跃后台任务 → 60s 窗口攒批；其余
    // → 立即放行（泵按通道分组）：外部通道结构性逐条——merge:true 亦不得覆盖
    // （批组隔离 [u9]，窗口合批形态 {batch,items} 对外部通道无消费契约，任务书
    // 目标 6）；默认通道的无后台任务 / merge:false 覆写同样立即放行。
    const wantMerge =
      channel === DEFAULT_NOTIFY_CUSTOM_TYPE &&
      (opts?.merge ?? host.hasRunningBackground());
    if (wantMerge) {
      mergeBuffer.set(id, record);
      seenIds.add(id);
      armMergeTimer();
    } else {
      directBuffer.set(id, record);
      seenIds.add(id);
      pumpDirect();
    }
    return { kind: "accepted", id };
  }

  // ─── 合批窗口（60s 滑动；攒批路径专用）─────────────────────

  function clearMergeTimer(): void {
    if (mergeTimer !== undefined) {
      clearTimeout(mergeTimer);
      mergeTimer = undefined;
    }
  }

  /** 滑动窗口：每次新攒批成员到达重置窗口尾（账本内核 mergeWindowMs 滑动语义同源）。 */
  function armMergeTimer(): void {
    clearMergeTimer();
    mergeTimer = setTimeout(() => {
      mergeTimer = undefined;
      flushMergeBuffer("merge-window");
    }, MERGE_WINDOW_MS);
  }

  // ─── 放行泵（按通道分组交给内核）───────────────────────────

  /**
   * 窗口攒批成员聚合放行（mergeBuffer → 一次批消息）。compaction 挂起标记置位时
   * 整缓冲挂起（compaction 终态边沿唤醒）。
   */
  function flushMergeBuffer(_reason: string): void {
    if (disposed || mergeBuffer.size === 0) return;
    if (compacting) return; // compaction 等待：整缓冲挂起（终态边沿复位 + 唤醒）
    const group = [...mergeBuffer.values()];
    mergeBuffer.clear();
    commitAsBatch(group);
  }

  /**
   * 直通成员分组放行（directBuffer）。不变量：内核 queued 集恒来自单次单组放行
   * → 内核 doSend 的合批产物恒单通道——批组隔离不依赖时序巧合。
   *
   * - 默认通道组：merge-commit hold 聚合 → kernel.flush() 合成一条批消息入队
   *   （bg=false 直通的默认通道成员积压恢复时同通道合批，批形态语义合法）；
   * - 外部通道组：逐条提交（on-accept 即时出站 = 逐条消息）。
   *
   * 残余边界（登记，不加机制）：同组连续注入 throw（内核 retain 留守 queued）时，
   * 组内后继成员的出站批会与留守成员合并（同通道合批，外部通道的逐条形态在该
   * 异常窗口内退化）——注入 throw = stale 窗口 / 底层崩溃级异常，后续成员通常
   * 同样失败，窗口自愈于下一唤醒边沿；不为该窗口引入内核内部探测机制。
   */
  function pumpDirect(): void {
    if (disposed || directBuffer.size === 0) return;
    if (compacting) return; // compaction 等待：整缓冲挂起（终态边沿复位 + 唤醒）
    while (directBuffer.size > 0 && !disposed) {
      const first = directBuffer.values().next().value;
      if (first === undefined) break;
      const channel = first.payload.customType;
      // 取同通道成员（Map 迭代序 = 到达序，确定性）
      const group: JournalRecord[] = [];
      for (const rec of directBuffer.values()) {
        if (rec.payload.customType === channel) group.push(rec);
      }
      for (const rec of group) directBuffer.delete(rec.id);
      commitAsBatch(group);
    }
  }

  /**
   * 单通道组聚合放行：merge-commit hold 逐条提交内核（注入闸门 hold 聚合为
   * queued 集）→ kernel.flush() 一次出站。组内成员同通道 → doSend 合批产物恒
   * 单通道；单成员组出站即单条消息（buildBatchPayload 单条透传）。
   */
  function commitAsBatch(group: JournalRecord[]): void {
    if (group.length === 0) return;
    mergeCommitting = true;
    try {
      for (const rec of group) {
        submitToKernel(rec);
        if (disposed) return;
      }
    } finally {
      mergeCommitting = false;
    }
    kernel.flush();
  }

  /**
   * 单成员提交内核。返回值处置：swallowed = 已终局（幂等命中，丢弃即正确——该
   * 通知已送达过）；rejected 理论不可达（store.persist no-op 恒成功、payload 恒
   * custom、放行前已挡 disposed），warn 防御留痕；accepted 出站面由内核托管
   * （retain 留守 → settled 边沿 / compaction 边沿重投）。
   */
  function submitToKernel(rec: JournalRecord): void {
    // 显式覆写的失败策略单次消费（deliver 登记 → 此处透传 → 摘除），读取后立即
    // 删除——send throw 也不泄漏；缺省 retain（§3.4 缺省值表通知域语义）。内核按
    // 条目 onFailure 分流首败处置：retain 留守（settled / compaction 边沿重投）/
    // forget 走 store.discard（持久终局列 outcome:"discarded"，重放不复活）。
    const onFailure = failurePolicies.get(rec.id) ?? "retain";
    failurePolicies.delete(rec.id);
    // 内核 send 返回 DeliverySendResult | void（替身兼容口径）——本包恒传真内核
    // 本体（恒返回具体结果），void 分支防御性跳过。
    const result = kernel.send(toKernelMessage(rec), {
      id: rec.id,
      receiptAnchor: "details-id",
      onFailure,
    });
    if (result === undefined) return;
    if (result.kind === "swallowed") {
      host.logger.debug("delivery-port submit swallowed by kernel dedupe (already terminal)", {
        detail: { id: rec.id },
      });
    } else if (result.kind === "rejected") {
      warn(`delivery-port submit rejected by kernel (id=${rec.id}, reason=${result.reason})`);
    }
  }

  function flush(): void {
    if (disposed) return;
    clearMergeTimer();
    flushMergeBuffer("flush");
    pumpDirect();
    kernel.flush();
  }

  // ─── 重放（session_start 差集重放）─────────────────────────

  function recover(): number {
    if (disposed) return 0;
    let replayed = 0;
    for (const rec of state.outbox.values()) {
      // 幂等（账本 recover 的 items.has 同判）：本实例已受理（缓冲中 / 已交内核）
      // 的 id 不重建——重放后条目处于 in-flight 等回执（未终局、仍在差集）时，
      // 二次 recover 不得重复入账重投。
      if (seenIds.has(rec.id)) continue;
      if (state.ackedIds.has(rec.id) || state.deliveredIds.has(rec.id)) continue;
      seenIds.add(rec.id);
      if (rec.payload.customType === DEFAULT_NOTIFY_CUSTOM_TYPE) {
        mergeBuffer.set(rec.id, rec);
      } else {
        directBuffer.set(rec.id, rec);
      }
      replayed += 1;
    }
    if (replayed > 0) {
      buckets.recoveryReplays += replayed;
      emitBucketLog("recoveryReplays", buckets.recoveryReplays);
      // 立即尝试投递（重放合并形态：攒批成员合并批、直通成员分组放行）。
      flushMergeBuffer("replay");
      pumpDirect();
    }
    return replayed;
  }

  // ─── 诊断 / 生命周期 ───────────────────────────────────────

  function emitBucketLog(bucket: keyof DeliveryPortMetrics, total: number): void {
    host.logger.warn(`delivery-port bucket [${bucket}]`, { detail: { total } });
  }

  function metrics(): DeliveryPortMetrics {
    return { ...buckets };
  }

  function dispose(): void {
    disposed = true;
    clearMergeTimer();
    mergeBuffer.clear();
    directBuffer.clear();
    unsubMessageEnd();
    unsubBeforeCompact();
    unsubCompact();
    unsubCompactFailed();
    kernel.dispose();
    if (getSlot().current === handle) getSlot().current = undefined;
  }

  function genId(): string {
    idSeq += 1;
    // 时间戳段（进程墙钟，不随实例重置）保证跨实例唯一：bindDeliveryPort 每次
    // session_start 重建实例后 idSeq 归零，纯序号会与同 session 历史条目（fork /
    // resume 复制 entries）已终局的 dp-N 撞 id——内核判重（loadTerminalIds 播种）
    // swallowed 静默丢通知。序号段区分同实例同毫秒内的多条提交。
    return `dp-${Date.now().toString(36)}-${idSeq}`;
  }

  // collect 面 = deliveryCollectStubs（u-foundation 契约先行占位，调用即抛错；
  // u-p-port 以挂起面实装替换——collectArm/consume/collectRelease/onCollectArrival）。
  const handle: DeliveryPortHandle = {
    deliver,
    recover,
    metrics,
    flush,
    dispose,
    ...deliveryCollectStubs,
  };
  return handle;
}

// ─── 模块级 helper（无闭包状态）─────────────────────────────

/**
 * journal 记录 → 内核提交消息：注入前统一写 details.deliveryId（§3.3 送达凭据词条：
 * 身份由注入端附加，业务字段保持原样——details 其余字段不改动）。timing → 内核
 * intent 翻译（内核零 pi 词汇）。
 */
function toKernelMessage(rec: JournalRecord): DeliveryMessage {
  return {
    payload: withDeliveryId(rec.payload, rec.id),
    intent: rec.timing === "followUp" ? "after-run" : "interrupt-at-turn-boundary",
  };
}

/** payload 副本 + details.deliveryId 注入（details 非对象时以 {deliveryId} 兜底）。 */
function withDeliveryId(payload: CustomPayload, id: string): CustomPayload {
  const details = isPlainObject(payload.details) ? payload.details : {};
  return { ...payload, details: { ...details, deliveryId: id } };
}

/** journal 记录 → 内核持久记录投影（store.loadUndelivered 的读取单元）。 */
function toStoreRecord(rec: JournalRecord): DeliveryStoreRecord {
  return {
    id: rec.id,
    lane: "steer",
    payload: rec.payload,
    intent: rec.timing === "followUp" ? "after-run" : "interrupt-at-turn-boundary",
    recordedAt: rec.recordedAt,
    receiptAnchor: "details-id",
  };
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 运行时增量维护的 journal 状态（构造期全量基线 + 终局/送达增量）。 */
class JournalState {
  readonly outbox: Map<string, JournalRecord>;
  readonly ackedIds: Set<string>;
  readonly deliveredIds: Set<string>;
  readonly channels: Set<string>;

  constructor(scan: JournalScan) {
    this.outbox = scan.outbox;
    this.ackedIds = scan.ackedIds;
    this.deliveredIds = scan.deliveredIds;
    this.channels = scan.channels;
  }
}
