// [D4-① 通知簇职责轴] background 完成通知的 host 面——原 SubagentService 私有通知簇
// （notifyComplete / notifyClosed / piAdapter / toNotifyRecord / emitPendingRegister /
// emitPendingUnregister + notifier 实例持有）整体搬移至此（行为逐字节等价：搬移 +
// 依赖注入，不重写逻辑）。变化轴：改通知文案 / dedup 身份 / 放行守卫 / pending 注册
// 注销协议，只改本文件；Service 只保留编排与依赖注入（getPi / listRunning / isIdle）。

import { displayAgentName } from "../shared/agent-ref.ts";
import { snapshot } from "./execution-record.ts";
import { hasIdleTimer } from "./lifecycle-manager.ts";
import { hasLiveProcessHandle, isIdle, isResumable } from "./lifecycle-predicates.ts";
import type { BgNotifier, BatchBudgetParams, NotifierHost } from "./notifier.ts";
import { createNotifier } from "./notifier.ts";
import type { BgNotifyRecord } from "./notifier.ts";
import type { ExecutionRecord, RecordSnapshot } from "./types.ts";

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
  /** [C-1] chatMode close 终态通知（原 Service.notifyClosed）。 */
  notifyClosed(record: ExecutionRecord, emptyBody?: boolean): void;
  /** pending-notifications 注册（原模块函数 emitPendingRegister，pi 经 deps 取）。 */
  emitPendingRegister(id: string, name?: string): void;
  /** pending-notifications 注销（原模块函数 emitPendingUnregister）。 */
  emitPendingUnregister(id: string, reason: string): void;
  /** [sync-collect U2 合并] record → BgNotifyRecord 映射——collectCoordinator 的
   *  toNotifyRecord/notifyAsync 依赖注入消费（守卫放行逻辑单一权威在本文件）。 */
  toNotifyRecord(record: ExecutionRecord): BgNotifyRecord | undefined;
  /** [sync-collect 合并] 单条直发——collectCoordinator notifyAsync 与 E9 dispose
   *  转换路径消费（已越过 toNotifyRecord 守卫的成品通知）。 */
  notify(record: BgNotifyRecord): void;
  /** [sync-collect 合并] sync 批投递——collectCoordinator flushBatch 与 E1 补发消费。 */
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
        // v4 B-1 把旧 idle 折入 running 且 record 留 store：轮次完成的 chatMode record
        // （timer armed、无在跑轮）与 one-shot 完成后等待 message 升级的 record 都不再计入。
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
   *  SP-1: closed 统一终态，closedReason 由 BgNotifyRecord 携带。 */
  const toNotifyRecord = (record: ExecutionRecord): BgNotifyRecord | undefined => {
    // [H2 W2 / D6] workflow origin 回注全静默（单漏斗 origin gate）：完成/关闭/失败
    // 回注经此全部拒绝——workflow agent 结果由脚本返回值承载（无 message 对端），
    // 回注只会把已隐藏的 record 通知主 agent（设计 D6 出口枚举化；失败回注同静默，
    // v3 扩）。单漏斗盖住全部调用点（notifyComplete/notifyClosed/collectCoordinator
    // route 六调用面全经此，禁止散改调用点）；监督器 steer 通知族不经本漏斗——随
    // adopt 豁免对 workflow record 零触发。
    if (record.origin === "workflow") return undefined;
    const snap = snapshot(record);
    const s = snap.status;
    // [N1] isResumable 放行：SP-5 one-shot 成功完成后 finalizeRoundToIdle 把 record 回退
    // running-resumable——进程已死且永不 arm idle timer（armIdleTimer 的 arm 链随 H1 U6
    // 长驻退役失活，全仓无生产调用，见 lifecycle-predicates.ts 头注释），旧守卫
    // （closed / isIdle only）对其恒拒绝 → 完成通知静默丢失，
    // 而 one-shot 失败走 finalizeRecord 保持 closed 反而通知——与 tool 契约「runs once,
    // notifies on completion」完全倒置。isResumable = running + 无活进程，恰为该完成态；
    // 在跑轮的 record 有活进程，不会被误放行。
    if (s !== "closed" && !isIdle(record) && !isResumable(record)) return undefined;
    // closed → BgNotifyRecord.closed（cancelled 区分靠 closedReason）；chatMode 的 isIdle/
    // isResumable（轮次完成或 MF-6 失败轮回退，对话可续）→ running（轮次完成）。
    // isResumable 且非 chatMode（SP-5 one-shot 成功完成）→ closed：对主 agent 的语义是
    // completed（非对话轮次），且只有 closed 分支文案携带 worktree patchFile 的 git apply
    // 提示——one-shot worktree 模式的改动回收依赖该提示（running 分支文案不含 patchFile）。
    const notifyStatus: BgNotifyRecord["status"] =
      s === "closed" || !record.chatMode ? "closed" : "running";
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
      // SP-1: closedReason 透传给 notifier（L2 原因，供通知文案按需展示）。
      closedReason: record.closedReason,
      // [wave2] chatMode 条件透传 sessionFile：通知末尾追加 Full transcript 指针行
      //（增量语义的全文恢复通道，见 notifier.buildLlmContent）。one-shot（chatMode
      // falsy）不透传——通知输出逐字节不变（G4），该条件由 message-close 测试的
      // 必选用例锁死（漏加条件时 notifier 单测不红——notifier 层只见最终字段）。
      sessionFile: record.chatMode ? record.sessionFile : undefined,
    };
  };

  return {
    /** background 完成回注（record → BgNotifyRecord 映射 + notifier.notify）。
     *  正在执行（running + 活进程 + 非 timer-armed）静默跳过——notify 只对 closed（终态）、
     *  isIdle（chatMode 轮次完成）或 isResumable（SP-5 one-shot 成功完成 / MF-6 失败轮回退）有意义。
     *  SP-1: closed 统一终态（done/failed/crashed 合并），closedReason 携带 L2 原因。 */
    notifyComplete(record: ExecutionRecord): void {
      const notify = toNotifyRecord(record);
      if (notify) notifier.notify(notify);
    },

    /** [C-1] chatMode close 终态通知（设计 D2：正文空/本轮增量 + sessionFile 指针行）。
     *
     *  与 notifyComplete 的差异只在 dedup 身份与轮次统计：终态通知必须与最后一轮的轮次通知
     *  区分（轮次通知 key=`id:round`），否则同 key 被 60s dedup 吞——close 后父 agent 永远
     *  收不到带指针行的终态通知（审查 C-1）。故 round 置 undefined（key 回退为裸 id），
     *  轮数改经 totalRounds 进文案 "completed after N rounds."（C-2）。
     *
     *  仅 chatMode close 语义调用（closeChatIdle 终态化成功后；[H1 U6] 旧
     *  closeAfterRoundSettled 消费点已随 chat 域退役）。
     *  one-shot 显式拒绝（G4：one-shot close 路径现状无终态通知，字节不变）；cancel 走
     *  cancelBackground 自己的 notifyComplete，不经本方法。幂等性：两条 close 路径均由
     *  closeSubagent 的 status 分流守卫（closed 后幂等 no-op）/ CAS 抢锁保证只执行一次，
     *  本方法自身不重复发送；迟到的轮次收尾 .then 通知与轮次通知同 key=`id:round`，
     *  60s 窗内仍被吞，不构成第三条。 */
    /** @param emptyBody true = 终态通知正文置空串（D2 路径②）。W16 P-1 修复后
     *  closeChatIdle 的 doneResult.text 改用 record.result 保真（close 终态
     *  subagent-record entry 的 result 不抹空轮终真实值），「正文空」不再由合成空
     *  text 的副作用承载，改为显式参数——持久化 result 与通知正文两个关注点解耦。 */
    notifyClosed(record: ExecutionRecord, emptyBody = false): void {
      if (!record.chatMode) return;
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

    toNotifyRecord(record: ExecutionRecord): BgNotifyRecord | undefined {
      return toNotifyRecord(record);
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
