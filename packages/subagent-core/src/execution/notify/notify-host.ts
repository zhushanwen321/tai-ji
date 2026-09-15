// [D4-① 通知簇职责轴] background 完成通知的 host 面——原 SubagentService 私有通知簇
// （notifyComplete / notifyClosed / piAdapter / toNotifyRecord / emitPendingRegister /
// emitPendingUnregister + notifier 实例持有）整体搬移至此（行为逐字节等价：搬移 +
// 依赖注入，不重写逻辑）。变化轴：改通知文案 / dedup 身份 / 放行守卫 / pending 注册
// 注销协议，只改本文件；Service 只保留编排与依赖注入（getPi / listRunning / isIdle）。

import { displayAgentName } from "../../shared/agent-ref.ts";
import { snapshot } from "../persistence/execution-record.ts";
import { hasIdleTimer } from "../lifecycle/lifecycle-manager.ts";
import { hasLiveProcessHandle, isIdle, isResumable } from "../lifecycle/lifecycle-predicates.ts";
import type { BgNotifier, BatchBudgetParams, NotifierHost } from "./notifier.ts";
import { createNotifier } from "./notifier.ts";
import type { BgNotifyRecord } from "./notifier.ts";
import type { ExecutionRecord, RecordSnapshot } from "../assembly/types.ts";

/** Pi ExtensionAPI 的最小接口（duck-typed）——原定义于 subagent-service.ts，随通知簇
 *  （piAdapter / emitPending* 的依赖）搬移至此并导出（Service 的 session 注入参数仍引用）。
 *  subagent-service 直接调 pi.sendMessage 发 background 完成通知（BgNotifier 滑动窗口合并），
 *  不委托 pending-notifications EventBus 中继——后者只管 registry 不参与通知发送。 */
export interface PiLike {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }, // g4-allow: 类型注解——PiLike 接口形状（pi.sendMessage 签面子集），非投递调用
  ): void;
  /** 订阅 pi 事件（D8：notifier 的 settled 边沿订阅用 'agent_settled'）。
   *  pi 0.84.4 的 on 返回 void 且无 off——退订语义由调用侧 disposed 标志包装兑现。
   *  可选：旧测试 mock pi 可能未实现 on，缺省时 notifier 退化为内核退避路径。 */
  on?(event: "agent_settled", handler: () => void): void;
}

/** NotifyHost 的依赖注入（Service 侧供给，全部惰性求值——pi/session 级状态运行时可变）。 */
export interface NotifyHostDeps {
  /** 当前 pi session handle（session_start 注入 / shutdown 置 null）。 */
  getPi: () => PiLike | null;
  /** store 的 running record 快照（piAdapter.hasRunningBackground 用）。 */
  listRunning: () => RecordSnapshot[];
  /** 主 agent isIdle 查询（ctx.isIdle，initSession 注入；未注入时 undefined）。 */
  getIsIdle: () => (() => boolean) | undefined;
}

/** 通知簇 host 面（Service 经此消费；notifier 实例封装在内部不外露）。 */
export interface NotifyHost {
  /** background 完成回注（原 Service.notifyComplete）。 */
  notifyComplete(record: ExecutionRecord): void;
  /** [C-1] close 归档提示通知（原 Service.notifyClosed；[modeless 波1] 全 record）。 */
  notifyClosed(record: ExecutionRecord, emptyBody?: boolean): void;
  /** pending-notifications 注册（原模块函数 emitPendingRegister，pi 经 deps 取）。 */
  emitPendingRegister(id: string, name?: string): void;
  /** pending-notifications 注销（原模块函数 emitPendingUnregister）。 */
  emitPendingUnregister(id: string, reason: string): void;
  /** [sync-collect U2 合并] record → BgNotifyRecord 映射——collectCoordinator 的
   *  toNotifyRecord/notifyAsync 依赖注入消费（守卫放行逻辑单一权威在本文件）。
   *  [modeless 波3] batchMember=true = sync 批成员终态载荷形态（closed 载荷），由
   *  协调器 route 入缓冲路径传入——成员身份承载自协调器登记集，非 record 字段。 */
  toNotifyRecord(record: ExecutionRecord, opts?: { batchMember?: boolean }): BgNotifyRecord | undefined;
  /** [sync-collect 合并] 单条直发——collectCoordinator notifyAsync 与 E9 dispose
   *  转换路径消费（已越过 toNotifyRecord 守卫的成品通知）。 */
  notify(record: BgNotifyRecord): void;
  /** [sync-collect 合并] sync 批投递——collectCoordinator flushBatch 消费。 */
  notifyBatch(records: readonly BgNotifyRecord[], budget?: BatchBudgetParams): boolean;
  /** dispose 的逆操作（initSession 复活，原 notifier.revive 委托）。 */
  revive(): void;
  /** dispose 前冲刷待发通知（原 notifier.flushPendingNotifications 委托）。 */
  flushPendingNotifications(): void;
  /** 丢弃 pending 通知（原 notifier.dispose 委托）。 */
  dispose(): void;
}

/** pending-notifications 注册/注销 helper（避免重复代码）。
 *  name 是 GUI pending 通知的显示名——取 basename 短名（displayAgentName），
 *  完整路径仍走 record.agent（env 注入 / 持久化）。 */
function emitPendingRegister(pi: PiLike | null, id: string, name?: string): void {
  pi?.events.emit("pending:register", {
    id,
    type: "subagent",
    name: name ? displayAgentName(name) : id,
  });
}

function emitPendingUnregister(
  pi: PiLike | null,
  id: string,
  reason: string,
): void {
  pi?.events.emit("pending:unregister", {
    id,
    reason,
  });
}

/** 通知簇工厂：notifier 实例随本函数创建并封装（原 Service 构造器
 *  `createNotifier(this.piAdapter())` 的等价形态）。 */
export function createNotifyHost(deps: NotifyHostDeps): NotifyHost {
  /** notifier 的 NotifierHost 适配器（绑定到 pi.sendMessage + store 查询）。 */
  const piAdapter = (): NotifierHost => {
    return {
      sendMessage: (message, options) => {
        deps.getPi()?.sendMessage(message, options);
      },
      hasRunningBackground: () => {
        // [M3] 「在跑的 background 工作」= 有活进程且非等待续聊（idle timer armed）。
        // 轮终收口 idle 的 record（timer armed、无在跑轮——[modeless 波1] 全 record
        // 轮终形态）不计入。
        // 旧判定 `mode === "background"` 对这两类恒 true → 轮次完成通知恒挂 60s 合并窗口
        // （notifier MERGE_WINDOW_MS），主 agent 的续聊回复固定延迟 60s 送达，持续对话（G1）失效。
        return deps.listRunning().some(
          (r) => r.mode === "background" && hasLiveProcessHandle(r.id) && !hasIdleTimer(r.id),
        );
      },
      isIdle: () => deps.getIsIdle()?.() ?? true,
      // [must-fix #4 / D8] settled 边沿订阅，与 isIdle 同源（session_start 注入的 pi）。
      // 只注入原生订阅能力；disposed 标志包装（退订语义）在 notifier 的 port 装配完成。
      onAgentSettled: (handler) => { deps.getPi()?.on?.("agent_settled", handler); },
    };
  };

  const notifier: BgNotifier = createNotifier(piAdapter());

  /** record → BgNotifyRecord（notifier.notify 入参映射，内部不外露）。
   *  v4 B-1：守卫放行 closed（终态，含 cancelled）、isIdle（对话模式轮次完成，notify 主 agent G1）
   *  或 isResumable（running + 无活进程——SP-5 one-shot 成功完成 / MF-6 失败轮回退）。
   *  正在执行（running + 活进程 + 非 timer-armed）返回 undefined（调用方 notifyComplete 跳过）。
   *  SP-1: closed 统一终态，closedReason 由 BgNotifyRecord 携带。
   *  [U5] archived 放行：归档编排的 notifyClosed「已收起」提示载体——归档后 record
   *  idle 且无 closedReason（新 settle 语义），旧三判据全 false 会吞掉提示；archived
   *  → closed 载荷（completed 文案族）。 */
  const toNotifyRecord = (
    record: ExecutionRecord,
    opts?: { batchMember?: boolean },
  ): BgNotifyRecord | undefined => {
    // [H2 W2 / D6] workflow origin 回注全静默（单漏斗 origin gate）：完成/关闭/失败
    // 回注经此全部拒绝——workflow agent 结果由脚本返回值承载（无 message 对端），
    // 回注只会把已隐藏的 record 通知主 agent（设计 D6 出口枚举化；失败回注同静默，
    // v3 扩）。单漏斗盖住全部调用点（notifyComplete/notifyClosed/collectCoordinator
    // route 六调用面全经此，禁止散改调用点）；监督器 steer 通知族不经本漏斗——随
    // adopt 豁免对 workflow record 零触发。
    if (record.origin === "workflow") return undefined;
    const snap = snapshot(record);
    // [U2 桥接判据] 旧「closed 终态」读形态 ⟺ idle ∧ closedReason 有值（两态状态机
    // 迁移不变量）。[U5] 新 settle 路径（markSettled/markRoundIdle）产的 idle/resumable
    // 不携带 closedReason——gate 三元组（notifier.notifyGateAllowsDelivery）在消费点
    // 承担归档静默/放弃轮标记阻断，本映射只管载荷形态。
    const legacyClosed = record.status === "idle" && record.closedReason !== undefined;
    const archived = record.intent === "archived";
    // [N1] isResumable 放行：SP-5 one-shot 成功完成后 markRoundIdle 收口——失败轮
    // settle 同形态（[U5] 万物可续），失败通知可达。在跑轮的 record 有活进程，不会被
    // 误放行。
    // [two-state-convergence U4/D3a → U5/D4] 轮终翻边 idle：收口形态从
    // running-resumable 翻为 idle，isResumable 判据随 [U5/D4] 改 idle 派生（idle 即
    // resumable）——本子句被前置的 `record.status !== "idle"` 短路吸收（status=idle
    // 时前三子句已放行），保留为谓词语义的显式对齐。载荷投影分支不受
    // 影响：轮终收口 idle 统一走 running 载荷（[modeless 波1·SP-5]）。拦截集不变：
    // running + 活进程 + 非 timer-armed 仍静默。
    if (!legacyClosed && !archived && record.status !== "idle" && !isIdle(record) && !isResumable(record)) {
      return undefined;
    }
    // legacyClosed/archived → BgNotifyRecord.closed（终态/已收起文案族）；轮终收口
    // idle（含失败轮回退）→ running（轮次完成，等待 message 续）。
    // [modeless 波1·SP-5 统一] one-shot 成功轮不再折 closed——统一 idle 留守 +
    // 轮终通知带 result（closed 载荷只留给 legacy 终态遗留 / 归档提示 / 批成员终态；
    // record 的 closed 终态通知延到 idle GC 到期归档后的需要时点）。worktree patchFile
    // 的 git apply 提示仍在 closed+completed 分支文案——one-shot worktree 轮终通知
    // 随 SP-5 统一迁移 running 形态，patch 回收指针改由 result 轮次通知后的
    // fork/close 流程承接（GUI 波 4 收口）。
    // [modeless 波3·批成员身份判定] sync 批成员保持 closed 载荷（攒批一次唤醒的
    // one-shot 语义——批头计数 / patchFile 提示依赖 closed+outcome 形态；批成员
    // 完成 = 终态通知带 result，随后随批闭合自动 close）。成员身份由协调器登记集
    // 承载（route 入缓冲路径显式传入 batchMember）——collectMode 字段已出 record，
    // 波 1 临时保留的 record.collectMode 门随之消亡。async 成员按统一轮终形态 running。
    const notifyStatus: BgNotifyRecord["status"] =
      legacyClosed || archived || opts?.batchMember === true ? "closed" : "running";
    return {
      id: snap.id,
      status: notifyStatus,
      agent: snap.agent,
      model: snap.model,
      result: snap.result,
      error: snap.error,
      startedAt: snap.startedAt,
      endedAt: snap.endedAt,
      patchFile: record.patchFile,
      // round 透传给 notifier 的 dedup key（对话模式按轮次去重，G1 决策 9）。
      round: record.round,
      // [U5 / §3.2.3] 世代透传（notifyId 的 epoch 防撞段——reopen 后 round 归零不与
      // 历史轮撞键）。
      epoch: record.epoch,
      // SP-1: closedReason 透传给 notifier（L2 原因，供通知文案按需展示）。
      closedReason: record.closedReason,
      // [modeless 波1] sessionFile 全体透传：通知末尾追加 Full transcript 指针行
      //（全文恢复通道，见 notifier.buildLlmContent）。万物可续——每个 record 都要
      // 能被 message/fork 定位（旧「仅 chatMode 透传」随 chatMode 消亡）。
      sessionFile: record.sessionFile,
    };
  };

  return {
    /** background 完成回注（record → BgNotifyRecord 映射 + notifier.notify）。
     *  正在执行（running + 活进程 + 非 timer-armed）静默跳过——notify 只对 closed
     *  （legacy 终态遗留）或轮终收口 idle（[modeless 波1] 全 record：轮次完成 /
     *  失败轮回退）有意义。SP-1: closed 统一终态（done/failed/crashed 合并），
     *  closedReason 携带 L2 原因。 */
    notifyComplete(record: ExecutionRecord): void {
      const notify = toNotifyRecord(record);
      if (notify) notifier.notify(notify);
    },

    /** [C-1] close 归档提示通知（设计 D2：正文空/本轮增量 + sessionFile 指针行）。
     *
     *  与 notifyComplete 的差异只在 dedup 身份与轮次统计：归档提示必须与最后一轮的
     *  轮次通知区分（轮次通知 key=`id:round`），否则同 key 被 60s dedup 吞——close 后
     *  父 agent 永远收不到带指针行的归档提示（审查 C-1）。故 round 置 undefined（key
     *  回退为裸 id），轮数改经 totalRounds 进文案 "completed after N rounds."（C-2）。
     *
     *  close 归档语义调用（archiveRecord——markArchived 成功后；[modeless 波1] 全
     *  record 归档均提示，旧 chatMode 门随字段消亡删除——万物可续下「已收起」对
     *  任何 record 都是有信息的：record 仍在，可寻回复活）。cancel 走 cancelBackground
     *  自己的注销发射，不经本方法。幂等性：两条 close 路径均由 closeSubagent 的
     *  status 分流守卫（幂等 no-op）/ CAS 抢锁保证只执行一次，本方法自身不重复发送；
     *  迟到的轮次收尾 .then 通知与轮次通知同 key=`id:round`，60s 窗内仍被吞，不构成
     *  第三条。 */
    /** @param emptyBody true = 归档提示正文置空串（D2 路径②）。W16 P-1 修复后
     *  close 终态的 doneResult.text 改用 record.result 保真（close 终态
     *  subagent-record entry 的 result 不抹空轮终真实值），「正文空」不再由合成空
     *  text 的副作用承载，改为显式参数——持久化 result 与通知正文两个关注点解耦。 */
    notifyClosed(record: ExecutionRecord, emptyBody = false): void {
      const notify = toNotifyRecord(record);
      if (!notify) return;
      notify.round = undefined;
      if (emptyBody) notify.result = "";
      if (record.round != null) notify.totalRounds = record.round;
      notifier.notify(notify);
    },

    emitPendingRegister(id: string, name?: string): void {
      emitPendingRegister(deps.getPi(), id, name);
    },

    emitPendingUnregister(id: string, reason: string): void {
      emitPendingUnregister(deps.getPi(), id, reason);
    },

    toNotifyRecord(record: ExecutionRecord, opts?: { batchMember?: boolean }): BgNotifyRecord | undefined {
      return toNotifyRecord(record, opts);
    },

    notify(record: BgNotifyRecord): void {
      notifier.notify(record);
    },

    notifyBatch(records: readonly BgNotifyRecord[], budget?: BatchBudgetParams): boolean {
      return notifier.notifyBatch(records, budget);
    },

    revive(): void {
      notifier.revive();
    },

    flushPendingNotifications(): void {
      notifier.flushPendingNotifications();
    },

    dispose(): void {
      notifier.dispose();
    },
  };
}
