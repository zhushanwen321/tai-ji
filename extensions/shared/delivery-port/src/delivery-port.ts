// src/delivery-port.ts
//
// pi 半区投递端口主体（设计 .tmp/tech-design/unified-delivery.md §3.7 组件表）：
// 把 pi 扩展运行时端口接线成 @zhushanwen/session-delivery v3 内核的 port 半区
// 装配——custom 投递路径唯一执行者。与账本（notify-ledger）的四步生命周期逐条对位：
//   ① record（受理前落盘）→ deliver 入口 appendEntry（outbox，plain entry）；
//   ② deliver（投递）→ 内核 on-accept 受理即出站 → pi.sendMessage 直达唯一队列
//     （两档出队由 pi 原生 steer/followUp 队列承载，本端口零注入时机代码——提交
//     侧缓冲只决定「何时把账交给内核」，不持注入队列、零自建出队机制）；
//   ③ ack（处理完毕）→ message_end 事件命中 details.deliveryId → 内核
//     confirmDeliveredByProof → 内核终局 store.ack → appendEntry(ack)；
//   ④ replay（重启恢复）→ session_start 差集重放（outbox − delivered − ack）。
//
// 装配形态（§3.7）：每 session 一份（session_start 重绑 = 旧实例 dispose + 新实例
// recover）；消费方经 Symbol.for 进程级槽 getDeliveryPort 获取（C-ext-06 惯例）。
//
// ── 提交侧缓冲与按通道分组放行（§3.7 批组隔离行；攒批窗已退役）─────────────
// 全部提交先落盘再进提交缓冲（directBuffer），由放行泵按通道分组交给内核：
//   - 默认通道组（subagent-bg-notify）：边沿即投——落盘受理后立即经 merge-commit
//     hold 逐条提交内核（注入门禁 hold → 内核 retain → 条目 queued 聚合）→
//     kernel.flush() → 内核 buildBatchPayload 合成一条 {batch:true, items} 消息
//     一次 sendMessage 入队（同组多成员近同时到达时仍是合法批形态——分组放行
//     语义保留，窗口等待已删）；
//   - 外部通道组（workflow-result / managed-session-notify 等）：逐条提交、逐条
//     消息（账本 [u9] 分组规则——batch 合并形态对外部通道无消费契约）。
// [subagent-observability §3.3.7③] 攒批窗（60s 滑动窗口 + mergeBuffer +
// wantMerge 判定 + MERGE_WINDOW_MS 定时器）整机制退役删除——所有通知边沿即投；
// 省 token 价值由 collect_results 批量收取能力取代。保留边界（防误删）：内核
// buildBatchPayload 与 pumpDirect/commitAsBatch/merge-commit hold（recover 重放、
// collectRelease 直通、compaction 唤醒仍产合法批形态）、消费方批兼容读分支、
// collect 挂起子系统、journal 差集重放——全部保留。
// 分组放行的不变量：内核 queued 集恒来自单次单组放行 → 内核 doSend 的合批产物恒
// 单通道——批组隔离不依赖时序巧合（混批窗口结构性消除；残余边界见 pumpDirect
// 注释）。账目/幂等/回执/ack 全程逐条（成员各自独立内核条目，
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
// ── collect 挂起面（result-collect 设计 §3.1②）──────────────
// 批量收取的分流发生在提交编排层（deliver 入口）：条目照常受理前落盘（I2 耐久不
// 变），随后按「collectKey 键集 ∩ 在途等待集 ≠ ∅」分流——命中 → 挂起缓冲（纯内存，
// 不进投递内核）+ onCollectArrival 唤醒等待器；未命中 → push 现状零变化。挂起不独立
// 持久化，投递日志即耐久层：崩溃后差集重放按未投递重投（push），收取过的条目写
// collected 终局（ack outcome 扩值）构造性退出差集。等待器三 API（collectArm 五态
// 快照 / consume 全键展开收取 / collectRelease 解散等待集 + 未收条目直通内核
// flush——边沿即投，攒批窗已删 §3.3.7③）。session 替换路径 abort 先于 dispose 归并中断语义；extension 重载在
// collect 阻塞期不可达（设计 §3.1 [重绑] 登记），dispose 只做在途等待器 warn 留痕
// 不变量检查，不定义唤醒与返回语义。
//
// ── 耐久面的分工（为什么 store.persist 是 no-op）─────────────
// outbox 权威 = 成员记录（deliver 入口 appendEntry，先于受理——「耐久承诺先于投递
// 尝试」内核契约由该同步时序等价兑现：appendEntry 抛错 = 承诺未落 → deliver 返回
// rejected("persist-failed")，不进投递流程）。内核侧 store.persist 因此有意 no-op：
// 成员记录若由内核 persist 再落盘会与成员记录双写（重放差集把同一条当两条重建，
// 合批投出后成员记录无法单独处理完毕 → 必然双投）。port 的内核句柄是本闭包私有面，
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
  scanPendingEntries,
  type MappedPendingStatus,
  type ResolvedSettlementReason,
} from "@zhushanwen/extension-protocol";

import {
  ACK_CUSTOM_TYPE,
  OUTBOX_CUSTOM_TYPE,
  extractDeliveryIds,
  isPlainObject,
  scanJournal,
  type JournalRecord,
  type JournalScan,
} from "./journal.ts";
import type {
  CollectedEntry,
  CollectSnapshot,
  DeliveryDeliverOptions,
  DeliveryDeliverResult,
  DeliveryEnvelope,
  DeliveryPortHandle,
  DeliveryPortHost,
  DeliveryPortMetrics,
  DeliveryTiming,
} from "./types.ts";

/** genId 时间戳段进制（base36：紧凑且小写字母数字安全，dp-<ts>-<seq> 的 ts 段）。 */
const ID_TIMESTAMP_RADIX = 36;

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

// ─── 子系统装配（createDeliveryPort 的两个内聚子面：内核接线 / collect 挂起面）───
//
// createDeliveryPort 是装配壳：持提交侧闭包态（双缓冲 / hold 标志 / 幂等索引），两个
// 子系统经工厂构造、以 deps 注入读端口闭包态——可变标志经 getter 出站时点读取（装配
// 期零快照），缓冲/策略面按引用共享。拆分是行为保持的体量收敛：闭包态所有权仍在
// createDeliveryPort，子系统不持可变装配态。

/** 分桶计数落日志（host.logger 出口，诊断限流面归 logger）。 */
function emitBucketLog(host: DeliveryPortHost, bucket: keyof DeliveryPortMetrics, total: number): void {
  host.logger.warn(`delivery-port bucket [${bucket}]`, { detail: { total } });
}

/** 内核装配对端口闭包态的最小依赖面。 */
interface KernelAssemblyDeps {
  host: DeliveryPortHost;
  state: JournalState;
  buckets: DeliveryPortMetrics;
  warn(msg: string, err?: unknown): void;
  /** merge-commit 期标志（默认通道组逐条提交内核期间 hold 注入）。 */
  isMergeCommitting(): boolean;
  /** compaction 挂起标记（§3.8 提交侧等待的唯一判定源）。 */
  isCompacting(): boolean;
}

/**
 * 内核装配（v3 on-accept 模式 + session entry store + details-id 凭据）：store /
 * kernelPort / kernelConfig 三件套构造 + createDelivery 实例化。出站时点的两个
 * hold 语义（merge-commit / compaction 等待）经 getter 读端口闭包标志，其余行为
 * 与原内联装配逐条等价。
 */
function createKernelAssembly(deps: KernelAssemblyDeps): { kernel: ReturnType<typeof createDelivery> } {
  const { host, state, buckets, warn } = deps;

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
   * 内核出站端口（intent → pi 参数翻译在适配器内；内核零 pi 词汇纪律由此收敛）。
   * 方法体引用的闭包标志（mergeCommitting / compacting）经 deps getter 出站时点
   * 读取——装配期不快照。
   */
  const kernelPort: KernelPort = {
    supportedPayloads: ["custom"],
    // 内核接口必填成员；内核受理即出站不读忙闲探测，恒不被消费。提交侧挂起判定 =
    // compacting 事件标记（见 send 第二道防线与放行泵预检），不走本探测。
    isIdle: () => host.isIdle(),
    subscribeSettled: (cb) => host.onAgentSettled(cb),
    send(msg: DeliveryMessage, intent: DeliveryIntent) {
      // merge-commit 期 hold：默认通道组聚合窗口（文件头分组放行段）。设计内等待
      // 非失败，不计 settleRejected（内核 retain warn 逐条留痕可查）。deferred 字段
      // 产单（MF-1-4：DeliveryDeferReason 判别联合，内核零字符串白名单）。
      if (deps.isMergeCommitting()) {
        return { accepted: false as const, deferred: "merge-commit-hold" as const };
      }
      // 提交侧 compaction 等待（§3.8）的第二道防线：pump 的缓冲挂起是常态路径
      // （提交前统一预检），本检查覆盖「提交同步链与 compaction 边沿交叠」的
      // 残余窗口。标记 true 即留账（内核 retain）等唤醒边沿重投。
      if (deps.isCompacting()) {
        return { accepted: false as const, deferred: "compaction-wait" as const };
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
        emitBucketLog(host, "settleRejected", buckets.settleRejected);
        throw err;
      }
      return { accepted: true };
    },
  };

  const kernelConfig: DeliveryConfigWithWarn = {
    intent: "interrupt-at-turn-boundary",
    store,
    // details-id 凭据判定：state.deliveredIds 由 message_end 边沿增量维护（事件与
    // entry 写入同栈——收到事件 = entry 已持久），O(1) 且锚定磁盘事实。
    proofCheck: (id: string) => state.deliveredIds.has(id),
    warn,
  };
  return { kernel: createDelivery(kernelPort, kernelConfig) };
}

/** collect 挂起面对端口闭包态的最小依赖面（result-collect 设计 §3.1②）。 */
interface CollectFaceDeps {
  host: DeliveryPortHost;
  state: JournalState;
  isDisposed(): boolean;
  /** 挂起条目收取时摘除失败策略项（deliver 登记的提交时选项不残留）。 */
  failurePolicies: Map<string, DeliveryFailurePolicy>;
  warn(msg: string, err?: unknown): void;
  /** 解散等待集后未收条目的直通放行（进 pumpDirect 分组放行管线——边沿即投，攒批窗已删 §3.3.7③）。 */
  routeDirect(records: readonly JournalRecord[]): void;
}

/** collect 挂起面对端口的路由面（deliver 分流判定 / handle 装配 / dispose 清理）。 */
interface CollectFace {
  /** deliver 分流判定：键集 ∩ 在途等待集 ≠ ∅。 */
  hasWaiterFor(collectKeys: readonly string[]): boolean;
  /** 命中等待集的条目入挂起缓冲 + 同步唤醒等待器（到达回调在 deliver 调用栈内触发）。 */
  suspend(id: string, record: JournalRecord): void;
  collectArm(keys: string[]): CollectSnapshot;
  consume(): CollectedEntry[];
  collectRelease(): void;
  onCollectArrival(cb: () => void): () => void;
  /** 清空挂起面三集合；返回清空前的在途量（dispose 不变量 warn 的判定与数据）。 */
  dispose(): { waiting: number; suspended: number };
}

/**
 * collect 挂起面（result-collect 设计 §3.1②，纯内存分流态，投递日志即耐久层）：
 * 登记等待集 / 挂起缓冲 / 到达唤醒 + consume 收取 + collectRelease 解散，自成
 * 子系统；对 push 管线只有两个触点——deliver 分流（hasWaiterFor / suspend）与
 * 解散直通（routeDirect 回调）。
 */
function createCollectFace(deps: CollectFaceDeps): CollectFace {
  const { host, state, failurePolicies, warn } = deps;
  /** 挂起缓冲（命中等待集的条目；键 = journal 记录 id——收取终局按日志条目写）。 */
  const collectBuffer = new Map<string, JournalRecord>();
  /** 在途等待集（collectArm 登记等待态键 / collectRelease 解散；挂起判定匹配集）。 */
  const collectWaitingKeys = new Set<string>();
  /** 挂起到达回调（collectArm 前注册；事件驱动唤醒等待器，无轮询）。 */
  const collectArrivalCbs = new Set<() => void>();

  /** 按收取键定位日志条目（键集包含判定）。同键多条条目取最新（reopen 新世代重新
   * 申报——当前世代的条目才是等待对象；recordedAt 序防御取最新）。 */
  function findOutboxByCollectKey(key: string): JournalRecord | undefined {
    let found: JournalRecord | undefined;
    for (const rec of state.outbox.values()) {
      if (rec.collectKey?.includes(key) && (found === undefined || rec.recordedAt >= found.recordedAt)) {
        found = rec;
      }
    }
    return found;
  }

  /** 收取条目的载荷与终态字段（type/outcome 对账 pending 基线；载荷原样共享）。 */
  function collectFieldsFor(
    key: string,
    rec: JournalRecord,
    pending: PendingBaseline,
  ): Omit<CollectedEntry, "id"> {
    return {
      type: pending.registerTypes.get(key),
      outcome: unregisterOutcomeOf(pending, key),
      content: rec.payload.content,
      details: rec.payload.details,
    };
  }

  /**
   * 登记在途等待集 + 对每个 key 按五态判据定态（同步段：JS 单线程内无交错窗口，
   * 与 deliver 分流读同一等待集——I3 等待集原子性）。
   *
   * 五态（快照单键一条；前四态 = result-collect 设计 §3.1② 判据）：
   * - ready：键 ∈ 某日志条目键集且该条目已有终局（acked ∪ delivered）→ 读侧快照
   *   收取（不写新终局——已注入条目再写 collected 会让日志宣称「未注入过」）；
   * - in-push-pipeline：键 ∈ 日志条目键集、条目无终局（已过分流点，在 push 管线
   *   排队待注入）→ 不收取不等待（等它会自锁，设计 §3.3 push 管线态决策）；
   * - unregistered-no-entry：键曾注册已注销、不属任何日志条目键集 → outcome 按
   *   unregister entry 的结清视图优先 + legacy status 兜底定值进 collected（无载荷
   *   快照形态；畸形 data 缺省语义见 types.ts CollectedEntry 注释）；
   * - waiting：活跃（register 在册无注销）且无日志条目 → 登记等待集，后续 deliver
   *   命中被挂起；
   * - unknown（MF-1-5 第五态）：键未注册且无条目——判定源 = 活跃集 ∪ 投递日志 ∪
   *   曾注册集的补集。不登记等待集（防空等到 timeout 挂死）、不虚构终态；工具侧
   *   读本态组装 errors（不再伪装 waiting——端口是唯一未知判定点，词表诚实表达）。
   */
  /** 注销 key 的 outcome（结清视图优先——权威通道 resolveSettlementReason；legacy status 兜底）。 */
function unregisterOutcomeOf(pending: PendingBaseline, key: string) {
  return pending.unregisterSettlements.get(key) ?? pending.unregisterStatus.get(key);
}

function collectArm(keys: string[]): CollectSnapshot {
    if (deps.isDisposed()) throw new Error("collectArm on disposed delivery port");
    const pending = scanPendingBaseline(host.readSessionEntries());
    const snapshot: CollectSnapshot = [];
    for (const key of keys) {
      const entry = findOutboxByCollectKey(key);
      if (entry) {
        const terminal = state.ackedIds.has(entry.id) || state.deliveredIds.has(entry.id);
        if (terminal) {
          snapshot.push({ id: key, state: "ready", entry: collectFieldsFor(key, entry, pending) });
        } else {
          snapshot.push({ id: key, state: "in-push-pipeline" });
        }
      } else if (pending.unregisteredIds.has(key)) {
        snapshot.push({
          id: key,
          state: "unregistered-no-entry",
          entry: {
            type: pending.registerTypes.get(key),
            outcome: unregisterOutcomeOf(pending, key),
            note: UNREGISTERED_NO_ENTRY_NOTE,
          },
        });
      } else if (pending.registeredIds.has(key)) {
        collectWaitingKeys.add(key);
        snapshot.push({ id: key, state: "waiting" });
      } else {
        // 未知键（未注册且无条目）：不登记等待（防挂死）、不虚构终态——显式 unknown
        // 态（工具侧读快照组装 errors，errors 判定归端口五态判据单点）。
        snapshot.push({ id: key, state: "unknown" });
      }
    }
    return snapshot;
  }

  /**
   * 取走挂起缓冲全部条目，按条目键集全量逐键展开（每键一条、载荷共享同一日志
   * 条目——managed 合批条目多键一次收齐），collected 终局按日志条目写一次且仅写
   * 从未注入的挂起条目（I1 收取唯一性）。返回条目只含 {id, content, details}——
   * type/outcome 映射归消费方终局回填的单遍扫描（MF-1-6：端口不再对每次 consume
   * 全量扫描 session entries，单次 collect 的到达处理量与全部历史条目数解耦）。
   * 终局写失败降级：先写终局后返回的正常收取路径上 appendEntry 偶发抛错 → warn
   * 留痕、载荷照常返回（条目无终局记录，差集重放可能重投为 push——偶发语义按设计
   * §3.4 处置，不向等待器传播）。
   */
  function consume(): CollectedEntry[] {
    if (deps.isDisposed()) return [];
    const results: CollectedEntry[] = [];
    const consumed = [...collectBuffer.values()];
    collectBuffer.clear();
    for (const rec of consumed) {
      try {
        // 终局写一次（一条条目一个终局，逐键展开共享）；ackedIds 增量登记使差集
        // 重放同列已完结（与 delivered 同列，读侧不区分 outcome 值）。
        host.appendEntry(ACK_CUSTOM_TYPE, { v: 2, id: rec.id, outcome: "collected" });
        state.ackedIds.add(rec.id);
      } catch (err) {
        warn(`delivery-port collect terminal write failed; entry may replay as push (id=${rec.id})`, err);
      }
      // 挂起条目未被提交内核，失败策略项随收取摘除（不残留）。
      failurePolicies.delete(rec.id);
      for (const key of rec.collectKey ?? []) {
        results.push({
          id: key,
          content: rec.payload.content,
          details: rec.payload.details,
        });
      }
    }
    return results;
  }

  /**
   * 解散等待集；未收挂起条目直通内核 flush（边沿即投——攒批窗已删，恢复 push
   * 不再有任何窗口延迟）。直通走 routeDirect（pumpDirect 按通道分组放行：外部
   * 通道逐条 / 默认通道组合批消息，批形态语义合法——分组放行保留，窗口已删）。
   */
  function collectRelease(): void {
    if (deps.isDisposed()) return;
    collectWaitingKeys.clear();
    if (collectBuffer.size > 0) {
      const pending = [...collectBuffer.values()];
      collectBuffer.clear();
      deps.routeDirect(pending);
    }
  }

  /** 挂起条目到达回调订阅（退订函数返回；dispose 清空）。 */
  function onCollectArrival(cb: () => void): () => void {
    collectArrivalCbs.add(cb);
    return () => {
      collectArrivalCbs.delete(cb);
    };
  }

  function fireCollectArrival(): void {
    for (const cb of [...collectArrivalCbs]) {
      try {
        cb();
      } catch (err) {
        // 等待器回调异常不向 deliver 调用方传播（到达事实已发生，条目在缓冲可收）。
        warn("delivery-port collect arrival callback failed", err);
      }
    }
  }

  function dispose(): { waiting: number; suspended: number } {
    const inFlight = { waiting: collectWaitingKeys.size, suspended: collectBuffer.size };
    collectWaitingKeys.clear();
    collectBuffer.clear();
    collectArrivalCbs.clear();
    return inFlight;
  }

  return {
    hasWaiterFor: (collectKeys) => keysIntersect(collectKeys, collectWaitingKeys),
    suspend(id, record) {
      collectBuffer.set(id, record);
      fireCollectArrival();
    },
    collectArm,
    consume,
    collectRelease,
    onCollectArrival,
    dispose,
  };
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
   * 提交缓冲（落盘已完成，等待放行；仅在缓冲期持有，放行即摘）。窗口攒批缓冲
   * （mergeBuffer）已随攒批窗退役删除（§3.3.7③）——全部受理条目统一进本缓冲
   * 边沿即投；同组多成员近同时到达经 pumpDirect 分组放行仍产合法批形态。
   */
  const directBuffer = new Map<string, JournalRecord>();
  /** 已受理 id 索引（deliver 幂等预检的全窗口快路径；内核三级判重对已入内核条目
   *  兜底）。仅增量添加，无淘汰——量级 = 每 session 通知总量（数十~数百）。 */
  const seenIds = new Set<string>();
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
   * 条目在提交缓冲期（compaction 挂起等提交期悬置；攒批窗已删 §3.3.7③）暂存 id → policy，提交内核时
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

  const { kernel } = createKernelAssembly({
    host,
    state,
    buckets,
    warn,
    isMergeCommitting: () => mergeCommitting,
    isCompacting: () => compacting,
  });

  // ─── collect 挂起面（result-collect 设计 §3.1②；子系统实现见 createCollectFace）───
  // routeDirect = 解散等待集后未收条目的直通放行（进 pumpDirect 分组放行管线——
  // 边沿即投，攒批窗已删 §3.3.7③，不逐条唤醒泵）。
  const collectFace = createCollectFace({
    host,
    state,
    isDisposed: () => disposed,
    failurePolicies,
    warn,
    routeDirect: (records) => {
      for (const rec of records) directBuffer.set(rec.id, rec);
      pumpDirect();
    },
  });

  // ─── 事件订阅（构造期建立 / dispose 退订）──────────────────

  const unsubMessageEnd = host.onMessageEnd(onMessageEnd);
  const unsubBeforeCompact = host.onSessionBeforeCompact(onBeforeCompact);
  const unsubCompact = host.onSessionCompact(onCompactionEdge);
  const unsubCompactFailed = host.onSessionCompactFailed(onCompactionEdge);

  /**
   * compaction 开始边沿：挂起标记置位（此后整缓冲挂起 + 内核 send 拒受理，直至
   * 终态边沿复位）。manual /compact / threshold / overflow recovery 全 trigger 在
   * 此收尾（pi 两路发射点：manual compact 与 auto compaction）。
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
    // 收取关联键（result-collect 设计 §3.1①）：空集与缺省同形（无键条目不参与匹配）。
    const collectKeys = opts?.collectKey;
    // 受理前落盘（耐久承诺先于投递尝试）：appendEntry 抛错 = 承诺未落 → 拒收。
    // 条目 data 携带 collectKey 键集（快照按键定位日志条目的事实源；升级前旧条目
    // 无键照常重放）。
    const record: JournalRecord = {
      id,
      timing,
      payload: { ...envelope.payload },
      recordedAt: Date.now(),
      ...(collectKeys !== undefined && collectKeys.length > 0 ? { collectKey: [...collectKeys] } : {}),
    };
    if (!persistOutboxRecord(record)) {
      return { kind: "rejected", reason: "persist-failed" };
    }
    state.outbox.set(id, record);
    state.channels.add(channel);
    // 显式失败策略随条目登记（submitToKernel 单次消费；缺省 retain 不占位）。
    // 登记在落盘成功后——persist-failed rejected 的条目不残留策略项。
    if (opts?.onFailure) failurePolicies.set(id, opts.onFailure);
    routeAcceptedDelivery(id, record, collectKeys);
    return { kind: "accepted", id };
  }

  /** 受理前落盘（耐久承诺先于投递尝试）：appendEntry 抛错 = 承诺未落 → false（拒收）。 */
  function persistOutboxRecord(record: JournalRecord): boolean {
    try {
      host.appendEntry(OUTBOX_CUSTOM_TYPE, {
        v: 2,
        id: record.id,
        timing: record.timing,
        payload: record.payload,
        recordedAt: record.recordedAt,
        ...(record.collectKey !== undefined ? { collectKey: record.collectKey } : {}),
      });
    } catch (err) {
      warn(`delivery-port persist failed before accept; entry rejected (id=${record.id})`, err);
      return false;
    }
    return true;
  }

  /** 受理后路由（collect 挂起分流 → 边沿即投放行）：挂起条目已落盘（persistOutboxRecord
   * 成功在前）——崩溃后差集重放按未投递重投。 */
  function routeAcceptedDelivery(
    id: string,
    record: JournalRecord,
    collectKeys: readonly string[] | undefined,
  ): void {
    // collect 挂起分流（result-collect 设计 §3.1②，先于放行）：键集 ∩ 在途
    // 等待集 ≠ ∅ → 挂起缓冲（不进内核，push 管线零感知）+ 唤醒等待器；否则 push
    // 现状零变化。
    if (collectKeys !== undefined && collectKeys.length > 0 && collectFace.hasWaiterFor(collectKeys)) {
      collectFace.suspend(id, record);
      seenIds.add(id);
      return;
    }
    // 边沿即投（§3.3.7③ 攒批窗退役后唯一路由）：落盘受理的条目直接进放行缓冲，
    // 泵按通道分组交给内核——默认通道组经 merge-commit hold 聚合出合法批形态，
    // 外部通道组结构性逐条（批组隔离 [u9] 不依赖时序）。
    directBuffer.set(id, record);
    seenIds.add(id);
    pumpDirect();
  }

  // ─── 放行泵（按通道分组交给内核）───────────────────────────

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
   * 单通道组聚合放行：merge-commit hold 逐条提交内核（注入门禁 hold 聚合为
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
      directBuffer.set(rec.id, rec);
      replayed += 1;
    }
    if (replayed > 0) {
      buckets.recoveryReplays += replayed;
      emitBucketLog(host, "recoveryReplays", buckets.recoveryReplays);
      // 立即尝试投递（重放合并形态：直通成员分组放行——同组多成员仍产合法批
      // 形态，保留边界 pumpDirect/commitAsBatch 未删）。
      pumpDirect();
    }
    return replayed;
  }

  // ─── 诊断 / 生命周期 ───────────────────────────────────────

  function metrics(): DeliveryPortMetrics {
    return { ...buckets };
  }

  function dispose(): void {
    disposed = true;
    // collect 面不变量检查（result-collect 设计 §3.1 [重绑] 不可达路径登记）：
    // dispose 时在途等待器即异常态信号 → warn 留痕；不定义唤醒与返回语义（extension
    // 重载在 collect 阻塞期不可达；session 替换路径 abort 先于 dispose 归并 [abort]）。
    const inFlight = collectFace.dispose();
    if (inFlight.waiting > 0 || inFlight.suspended > 0) {
      warn(
        `delivery-port disposed with in-flight collect waiter(s) ` +
          `(waiting=${inFlight.waiting}, suspended=${inFlight.suspended})`,
      );
    }
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
    return `dp-${Date.now().toString(ID_TIMESTAMP_RADIX)}-${idSeq}`;
  }

  const handle: DeliveryPortHandle = {
    deliver,
    recover,
    metrics,
    flush,
    dispose,
    collectArm: collectFace.collectArm,
    consume: collectFace.consume,
    collectRelease: collectFace.collectRelease,
    onCollectArrival: collectFace.onCollectArrival,
  };
  return handle;
}

// ─── 模块级 helper（无闭包状态）─────────────────────────────

/**
 * collectArm / consume 的 pending 对账基线（从当前 session entries 现算——第四态
 * 判据跨 register / unregister / 投递日志三源，JS 单线程内现算无交错窗口，I3）。
 * 字段映射（register 首见 type / 注销 status）单点在 protocol scanPendingEntries
 * （MF-2-1：与 pending-notifications 工具侧终局回填共用同一映射规则，首见语义统一
 * 为首条胜出——本包原持的本地映射段已删）；本包只读对账不维护差集产品语义，自派生
 * registeredIds 分类集（不引 pending-notifications 的产品归一——type 原样透传，
 * 归一化归消费方）。
 */
interface PendingBaseline {
  /** 曾注册集（全部 register entries 的 id，含已注销）。 */
  registeredIds: Set<string>;
  /** 注册条目 id → type 原样（protocol 首见规则单点；归一化归 pending 消费方）。 */
  registerTypes: Map<string, string>;
  /** 已注销集（unregister entry id 全局抵消）。 */
  unregisteredIds: Set<string>;
  /** 注销条目 id → status（写侧经 mapReasonToStatus 已映射落盘；畸形不收）。 */
  unregisterStatus: Map<string, MappedPendingStatus>;
  /** 注销条目 id → 结清五值（§3.3.6 权威通道 resolveSettlementReason——快照收取与
   *  工具侧回填两通道同规则，结清视图优先取值；legacy status 视图承担对账副档与
   *  本视图缺位（畸形 data：reason 非 string）时的兜底）。 */
  unregisterSettlements: Map<string, ResolvedSettlementReason>;
}

function scanPendingBaseline(entries: readonly unknown[]): PendingBaseline {
  const scan = scanPendingEntries(entries);
  const registeredIds = new Set<string>();
  for (const { data } of scan.registerEntries) {
    if (typeof data.id === "string" && data.id !== "") registeredIds.add(data.id);
  }
  return {
    registeredIds,
    registerTypes: scan.registerTypes,
    unregisteredIds: scan.unregisteredIds,
    unregisterStatus: scan.unregisterStatuses,
    unregisterSettlements: scan.unregisterSettlements,
  };
}

/** 键集 ∩ 等待集 ≠ ∅（deliver 挂起分流的匹配判定）。 */
function keysIntersect(keys: readonly string[], waiting: ReadonlySet<string>): boolean {
  for (const key of keys) {
    if (waiting.has(key)) return true;
  }
  return false;
}

/** 第四态返回体的固定说明（无载荷快照形态——终态事实取自注销记录在册信息）。 */
const UNREGISTERED_NO_ENTRY_NOTE = "经 managed 域注销无条目分支完结，无独立载荷快照";

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

/** journal 记录 → 内核持久记录派生视图（store.loadUndelivered 的读取单元）。 */
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
