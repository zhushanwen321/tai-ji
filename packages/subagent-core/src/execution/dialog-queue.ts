// src/execution/dialog-queue.ts
//
// L2 跨子进程全局 dialog 串行队列。
//
// 进程单例语义：跨所有子进程共享，串行所有 dialog 类 UI 请求
//（isDialogMethod(method)===true，即 select/confirm/input/editor）。
//
// 设计动机（.fix-plans/00-master-summary.md §一 冲突 3）：
//   - L1 per-child 队列（session-runner.createUiRequestQueue）只解决同一子进程内的串行，
//     多个并行子进程仍可同时把 dialog 请求涌向父 UI（争输入焦点）。
//   - L2 全局队列在主 agent handler 入口前再串行一次，保证同一时刻主 agent 只呈现一个 dialog。
//   - 排队绑定 method 交互模型（dialog 才排队），不绑定 channel——排队是 Pi 协议固有属性。
//
// SR-4（child close reject）：入队项带 child 引用，child close 时把该 child 的 pending dialog
//   全部 resolve 为 {cancelled:true}，防 Promise 永挂 + 内存泄漏。
//
// handler 抛错兜底：catch → 回 {cancelled:true} → 继续处理下一个。不能让一个失败卡死队列。
//
// 调用方约定：只对 dialog 类（isDialogMethod===true）调 enqueue；fire-and-forget 由调用方
//   直接调 handler（见 ui-request-handler-factory.ts），不经过本队列。enqueue 内仍防御性兼容
//   fire-and-forget（万一调用方未判）：直接调 handler 返回，不入队串行。调用方不应依赖此防御。

import { getLogger } from "../core/logger.ts";
import { MAX_TIMER_DELAY_MS } from "../shared/timer-delay.ts";

import { isDialogMethod } from "./ui-interaction-model.ts";

const logger = getLogger("subagents");

// ── dialog 超时上界（LC-3 / T2⑦，设计 docs/design/subagent-core-unbounded-wait-audit.md）──

/** 分钟/秒/毫秒换算常数（与 lifecycle-manager.ts 同款命名）。 */
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/** dialog 默认超时上界（30 分钟）：请求方未传 timeout 时的回收层兜底。
 *
 * 30 分钟是裁决值（产品语义：ask_user 挂起 30 分钟无响应视为放弃），不随 P-T2
 * （keep-alive 分布，等后代）标定——那是无关总体。请求方需要更长等待时在协议
 * request 上显式传 timeout（毫秒，pi ExtensionUIDialogOptions.timeout 同义）覆盖。
 *
 * 「等用户无限久」改为默认有界是有意的行为变更：LC-3 的两种形态（host UI promise
 * 挂死 / 用户永不回答）原都会把 L2 processing 永久占死 → 所有子进程 ask_user 全局
 * 死锁 + 该 child L1 队列 head-of-line 阻塞。 */
const DEFAULT_DIALOG_TIMEOUT_MINUTES = 30;
export const DEFAULT_DIALOG_TIMEOUT_MS =
  DEFAULT_DIALOG_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * 解析一个 dialog 项的队列级上界：请求方传了合法正数 timeout 用之，否则挂默认上界。
 * 非法值（<=0 / NaN / ±Infinity）回落默认——不因脏参数把上界拆掉（拆掉即回到 LC-3 无界）。
 *
 * 这里 clamp 到 MAX_TIMER_DELAY_MS 而非 fail-fast（timer-delay.ts 的 assertSafeTimerDelay
 * 惯例是配置入口 fail-fast）：timeout 是 per-request 运行时传值，fail-fast 会把整个
 * dialog 处理路径炸成 cancelled（伤害正常请求）；超大 timeout 的调用方意图是「近乎不限时」，
 * clamp 到 2^31-1（约 24.8 天）是该意图在 setTimeout 域内的安全语义近似——不 clamp 会被
 * Node 塌缩为 1ms 立即触发（语义反转：刚入队就超时）。
 */
function resolveDialogTimeoutMs(timeout: number | undefined): number {
  const resolved = isValidDialogTimeout(timeout) ? timeout : DEFAULT_DIALOG_TIMEOUT_MS;
  return Math.min(resolved, MAX_TIMER_DELAY_MS);
}

/**
 * dialog req.timeout 合法域判定（单一权威源，A2-3）：合法正数（finite 且 > 0）才参与
 * 超时语义——队列层据此决定上界取值（非法回落 DEFAULT_DIALOG_TIMEOUT_MS），
 * factory 层据此决定是否透传 SDK 第三参（非法不透传，数组为空，由队列层默认上界兜底）。
 * 两处共用本函数，禁止各写一份判定（此前两处不一致：SDK 层把 0/负数/NaN 原样透传，
 * 队列层判非法回落默认）。
 */
export function isValidDialogTimeout(timeout: number | undefined): timeout is number {
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0;
}

/** 超时 settle 的日志消息（恢复指引 + 已等待时长，父进程日志是完整错误消息的承载面——
 * pi 协议 RpcExtensionUIResponse 是封闭联合（value/confirmed/cancelled），错误文本
 * 无法进 stdin 响应体，子 agent 侧收到的是 cancelled 语义）。 */
function dialogTimeoutLogMessage(req: UiRequest, waitedMs: number): string {
  return (
    `[subagents] dialog timed out after ${waitedMs}ms without response ` +
    `(id=${req.id}, method=${req.method}) — settled as cancelled. ` +
    "Recovery: the requesting agent can continue and re-issue the question (重新发起提问); " +
    "to wait longer, pass an explicit timeout (ms) on the request."
  );
}

// ── 类型再导出（W7 / R3 S-A + R4-S③：SSOT 迁 @zhushanwen/subagent-engine-sdk
// src/ui-types.ts，结构等价；队列实现本体留 core——壳侧 host/askUser 消费端与
// inproc 过渡链路同样消费该类型面。双向可赋值断言挂本包 typecheck 断言族
// （contract-closure），漂移编译期可抓。 ──
export type { UiMethod, UiRequest, UiRequestHandler, UiResponse } from "@zhushanwen/subagent-engine-sdk";
import type { UiRequest, UiRequestHandler, UiResponse } from "@zhushanwen/subagent-engine-sdk";

// ── DialogGlobalQueue 实现 ──

/** 入队项的 child 引用形状（只取 pid 用于 rejectChildDialogs 匹配）。 */
export interface DialogChildRef {
  pid: number;
}

/** enqueue 的可选项。child 用于 rejectChildDialogs 关联（child close 时批量 reject）。 */
export interface EnqueueOptions {
  child?: DialogChildRef;
}

/** 队列内一项：请求 + handler + resolve + 所属 child。
 *  pending 状态持有 resolve，handler 完成 / rejectChildDialogs 时调它 settle Promise。
 *  settled 标志保证只 settle 一次（rejectChildDialogs 与 handler 完成可能竞争）。 */
interface QueueItem {
  req: UiRequest;
  handler: UiRequestHandler;
  resolve: (resp: UiResponse) => void;
  childPid: number | undefined;
  /** 是否已 settle（防 handler 完成 / rejectChildDialogs 重复 resolve）。 */
  settled: boolean;
  /** 队列级超时 timer 句柄（processNext 使 item 成为 current 时挂上）。
   *  settleItem 统一 clearTimeout——handler 永挂时 processNext 的 await 永不 resume，
   *  其内联 clearTimeout 不可达，reject/rejectAll 抢先 settle 的路径只能靠这里清理
   *  （A2-2：否则 timer armed 到期触发虚假「dialog timed out」warn + 句柄滞留）。 */
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

/**
 * L2 跨子进程全局 dialog 串行队列（进程单例）。
 *
 * 用法（createUiRequestHandlerForMode 返回的总 handler 内）：
 * ```ts
 * const dialogQueue = new DialogGlobalQueue();
 * return async (req: UiRequest) => {
 *   // 调用方负责判断：dialog 入队，fire-and-forget 直接调 realHandler
 *   if (isDialogMethod(req.method)) return dialogQueue.enqueue(req, realHandler);
 *   return realHandler(req);
 * };
 * ```
 *
 * 语义保证：
 *   - FIFO 串行：前一个 handler settle 后才处理下一个
 *   - SR-4：rejectChildDialogs(child) 把该 child 的 pending 全部 resolve 为 {cancelled:true}
 *   - handler 抛错兜底：catch → {cancelled:true} → 继续下一个（队列不卡死）
 *   - 超时上界（LC-3/T2⑦）：每个 dialog 项必有上界——req.timeout 显式传值优先，
 *     未传挂 DEFAULT_DIALOG_TIMEOUT_MS（30min，裁决值）；到点 settle {cancelled:true}
 *     并 warn（恢复指引见 dialogTimeoutLogMessage），L2 processing 释放、队列继续推进。
 *     「等用户无限久」改为默认有界是有意的行为变更。
 *   - 调用方约定只对 dialog 类调 enqueue；fire-and-forget 由调用方直接调 handler 不入队
 *（enqueue 内仍防御性兼容 fire-and-forget，但不保证行为）
 *
 * 线程模型：纯 Promise + 微任务驱动，无锁。Node 单线程 event loop 保证队列状态一致。
 *
 * 单 session 假设（M-2，与 index.ts lastSessionId 同源）：本队列是进程级单例（实例挂在
 * globalThis[Symbol.for("@zhushanwen/pi-subagents.dialogQueue")]，见 getOrCreateDialogQueue）。
 * rejectAll() 清空所有 pending dialog——无 per-session 隔离。Pi 当前架构保证单进程
 * 单 session 串行（同进程不会并发多个 session），故 session_shutdown 调 rejectAll() 只会清掉
 * 当前 session 的 pending。若未来 Pi 支持同进程多 session 并发，session A 退出会误清 session B
 * 的 pending dialog——届时需改为 per-session 隔离（入队项 QueueItem 带 sessionId，rejectAll
 * 改 rejectAllForSession(sessionId)，session_shutdown 只清当前 session）。
 */
export class DialogGlobalQueue {
  /** 等待处理的队列（FIFO）。正在处理的项从 queue shift 出后由 current 持有。 */
  private queue: QueueItem[] = [];
  /** 正在处理的项（handler 已调、未 settle）。用于 rejectChildDialogs 取消占位中的 dialog。 */
  private current: QueueItem | undefined;
  private processing = false;

  /**
   * 入队一个 UI 请求，返回 Promise<UiResponse>。
   *
   * 调用方约定：只对 dialog 类（isDialogMethod===true）调 enqueue。fire-and-forget 由
   * 调用方（ui-request-handler-factory.ts）在 enqueue 前判 isDialogMethod 后直接调 handler，
   * 不经过本队列。enqueue 内仍防御性兼容 fire-and-forget（万一调用方未判）：直接调 handler 返回，
   * 不入队串行，但调用方不应依赖此防御行为。
   *
   * dialog 项处理（TC-E4 case 1）：进队列 FIFO 串行，等前一个 settle 后才调 handler
   *（争输入焦点，防并发弹窗）。
   *
   * handler 抛错兜底：catch → 回 {cancelled:true}（dialog 路径，队列不卡死）。
   * SR-4：opts.child 用于 rejectChildDialogs 关联（dialog 项会被批量 reject，含 current）。
   *
   * @param req UI 请求（约定只传 dialog 类；fire-and-forget 防御性兼容）
   * @param handler 真正执行请求的 handler（TUI/GUI 模式分流后的 realHandler）
   * @param opts 可选 child 引用（用于 rejectChildDialogs 关联）
   * @returns handler 的响应；dialog 抛错时回 {cancelled:true}；child close 时回 {cancelled:true}
   */
  enqueue(
    req: UiRequest,
    handler: UiRequestHandler,
    opts?: EnqueueOptions,
  ): Promise<UiResponse> {
    // 防御性兼容 fire-and-forget：调用方约定不应传此类 req 进 enqueue（factory 层已判
    // isDialogMethod 直接调 handler），但万一调用方未判，这里直接调 handler 不入队，避免阻塞。
    // 直接返回 handler 真实结果（不做兜底形变为 cancelled——fire-and-forget 无串行语义）。
    if (!isDialogMethod(req.method)) {
      return handler(req);
    }
    // dialog：入队 FIFO 串行
    return new Promise<UiResponse>((resolve) => {
      this.queue.push({
        req,
        handler,
        resolve,
        childPid: opts?.child?.pid,
        settled: false,
      });
      void this.processNext();
    });
  }

  /**
   * settle 一个 item（幂等）。handler 完成 / rejectChildDialogs / rejectAll / 超时 timer
   * 都通过本方法，settled 标志保证只 settle 一次（防竞争）。
   *
   * #19 单一推进点：本方法 settle Promise + 清状态后，**唯一**调 processNext 推进队列。
   * processNext 尾部不再调 processNext（旧代码双重推进，虽靠 processing 标志幂等，但语义混乱）。
   * 为什么推进必须在 settleItem 而非 processNext 尾部：rejectChildDialogs 取消一个永不 settle
   * 的 current（handler 等用户输入卡死）时，processNext 的 `await item.handler` 永不 resume，
   * 尾部不会执行；只有 settleItem 里的 processNext 才能打破死锁，推进下一个。
   *
   * [A2-2] 超时 timer 清理也统一收口在这里：任何路径抢先 settle（reject/rejectAll/超时
   * 自身）都必须撤下 armed timer——handler 永挂时 processNext 内联的 clearTimeout 不可达，
   * 不在这里清则 timer 到期触发虚假「dialog timed out」warn 且句柄滞留至超时点。
   */
  private settleItem(item: QueueItem, resp: UiResponse): void {
    if (item.settled) return;
    item.settled = true;
    if (item.timeoutTimer) {
      clearTimeout(item.timeoutTimer);
      item.timeoutTimer = undefined;
    }
    item.resolve(resp);
    // 若是正在处理的项，清空 current/processing 并推进队列（唯一推进点）。
    // 非当前项（队列中被 reject）只 settle Promise，不影响 current/推进。
    if (this.current === item) {
      this.current = undefined;
      this.processing = false;
      void this.processNext();
    }
  }

  /**
   * SR-4：把指定 child 的所有 pending dialog resolve 为 {cancelled:true}。
   *
   * 触发场景：子进程 close（用户取消 / crash / 超时 kill）时，其 pending dialog 的 handler
   * 可能永不 settle（等用户输入），导致 Promise 永挂 + 内存泄漏。本方法批量清理。
   *
   * 处理范围（TC-E4 case 2）：
   *   - 正在处理中（current）的该 child 项：settle {cancelled:true}，解阻塞队列推进下一个
   *     （关键：handler 可能永不 settle，必须由这里打破死锁）
   *   - 队列中等待处理的该 child 项：settle {cancelled:true} 并移除
   *
   * 不影响其他 child 的 pending dialog（TC-E4 case 2 子测试 2）。
   */
  rejectChildDialogs(child: DialogChildRef): void {
    // [清理顺序] 先把同 child 的排队项摘出队列，再 settle current——settleItem(current)
    // 会推进队列（processNext 把队首提升为 current），若顺序反了，同 child 的排队项在
    // 摘除前已被提升为 current 并逃过本次清理（残留到 30min 队列级超时才释放）。
    const matched: QueueItem[] = [];
    if (this.queue.length > 0) {
      const remaining: QueueItem[] = [];
      for (const item of this.queue) {
        if (item.childPid === child.pid) {
          matched.push(item);
        } else {
          remaining.push(item);
        }
      }
      this.queue = remaining;
    }
    // 正在处理的项（可能永不 settle，必须由这里解阻塞并推进下一个）
    if (this.current && this.current.childPid === child.pid) {
      this.settleItem(this.current, { cancelled: true });
    }
    // 已摘除的排队项：settle Promise（非 current，不触发推进）
    for (const item of matched) {
      this.settleItem(item, { cancelled: true });
    }
  }

  /**
   * 处理队列下一项（FIFO）。
   *
   * processing 标志保证串行：handler 运行期间 processing=true，新的 processNext 调用直接返回；
   * handler settle 后由 settleItem 清 processing=false 并推进下一项（#19 单一推进点）。
   *
   * handler 抛错兜底（TC-E4 case 3）：catch → settle {cancelled:true} → 继续。
   * 不能让一个失败卡死队列（processing 永远 true）。
   *
   * LC-3/T2⑦ 超时上界：`await item.handler` 原本无上界——host UI promise 挂死或用户
   * 永不回答时 processing 恒 true（全局 dialog 死锁）。现在每项挂队列级 timer：
   * req.timeout（请求方显式传值）优先，未传/非法挂 DEFAULT_DIALOG_TIMEOUT_MS。
   * 到点 settle {cancelled:true}（完整错误消息落父进程日志，含恢复指引与等待时长），
   * settleItem 的 settled 标志保证与 handler 完成 / rejectChildDialogs 三方竞态下
   * 恰 settle 一次。timer 回调闭包捕获 item（非读 this.current）：迟到触发时
   * settled 标志已置位，直接 noop，不误伤后继项。
   */
  private async processNext(): Promise<void> {
    if (this.processing) return;
    if (this.queue.length === 0) return;
    this.processing = true;
    const item = this.queue.shift()!;
    this.current = item;
    const timeoutMs = resolveDialogTimeoutMs(item.req.timeout);
    const timer = setTimeout(() => {
      // [A2-2] 已被抢先 settle（正常 settle 时 timer 已被 settleItem 清除，这里是防御性
      // 兜底）：静默返回，不发虚假「dialog timed out」warn、不重复 settle。
      if (item.settled) return;
      logger.warn(dialogTimeoutLogMessage(item.req, timeoutMs));
      this.settleItem(item, { cancelled: true });
    }, timeoutMs);
    item.timeoutTimer = timer;
    try {
      const resp = await item.handler(item.req);
      clearTimeout(timer);
      // handler 完成：settle（若已被超时 timer / rejectChildDialogs 抢先 settle 则 noop）。
      // settleItem 内会清 current/processing 并推进队列（#19 单一推进点）。
      this.settleItem(item, resp);
    } catch {
      clearTimeout(timer);
      // handler 抛错兜底：回 cancelled，不向上抛（队列不能卡死）
      this.settleItem(item, { cancelled: true });
    }
    // #19：不在尾部再调 processNext——推进统一由 settleItem 负责（避免双重推进）。
  }

  /**
   * #10：把所有 pending dialog（queue + current）全部 settle 为 {cancelled:true}，
   * 并清空 queue/current/processing 状态。session_shutdown 调用，保证不留永挂 Promise。
   *
   * 约定签名：rejectAll(): void（无参，返 void）。Group C 的 index.ts session_shutdown 依赖此契约。
   *
   * 幂等：依赖 settleItem 的 settled 标志——重复调用只会对已 settled 项 noop。
   * 顺序敏感（#19 推进点在 settleItem）：必须先清空 queue 数组再 settle current，
   * 否则 settleItem(current) 同步触发的 processNext 会从旧 queue 抢占下一项作为新 current，
   * 避开本方法的 cancel 语义。清空后 processNext 看到空队列直接返回，新 current 不会被抢占。
   *
   * 单 session 假设（M-2）：见类注释。本方法清空所有 pending 不分 session——依赖 Pi 单进程
   * 单 session 串行保证。session_shutdown handler（index.ts）调用本方法时，进程内只会有当前
   * session 的 pending dialog。多 session 并发场景的迁移策略（rejectAllForSession）见类注释。
   */
  rejectAll(): void {
    // 先捕获并清空队列——防 settleItem(current) 触发的 processNext 抢占同队列下一项
    const items = this.queue;
    this.queue = [];
    // 再 settle current（processNext 此时看到空队列，不会抢占）
    if (this.current) {
      this.settleItem(this.current, { cancelled: true });
    }
    // settle 所有原队列项（Promise 必须 resolve，不能挂）
    for (const item of items) {
      this.settleItem(item, { cancelled: true });
    }
    // 状态清理（幂等：settleItem(current) 可能已清）
    this.current = undefined;
    this.processing = false;
  }

  /** 清空队列状态（仅在 rejectAll 之后调用）。pending Promise 必须先由 rejectAll settle。
   *  不 settle Promise 的纯状态重置——单独调用会导致 Promise 永挂（footgun），故设为 private。
   *  外部调用方应使用 rejectAll()（它 settle 所有 pending + 重置状态，是原子操作）。 */
  private resetState(): void {
    this.queue = [];
    this.current = undefined;
    this.processing = false;
  }

  /** 当前队列长度（测试/诊断用）。含等待处理项（不含 current）。 */
  get size(): number {
    return this.queue.length;
  }
}

// ============================================================
// 活跃队列登记 + 子进程退出取消（SR-4 接线的宿主侧触达面）
// ============================================================

/**
 * 进程级活跃 dialog 队列（生产单实例：宿主壳创建后经 createUiRequestHandlerForMode
 * 传入，登记点在该工厂内——壳侧无需额外接线）。
 *
 * 为什么需要模块级登记：队列实例由宿主壳持有（它是跨子进程的全局串行队列），而
 * 「子进程退出」信号从 core 的引擎镜像层（SpawnedChildrenMirror）到达——两者之间
 * 没有实例引用链，模块级登记点是交界面（对齐 host-ui-endpoint 的
 * setHostUiRequestEndpoint 先例）。
 */
let activeDialogQueue: DialogGlobalQueue | undefined;

/** 登记活跃队列（createUiRequestHandlerForMode 调用；undefined = 注销）。 */
export function registerActiveDialogQueue(queue: DialogGlobalQueue | undefined): void {
  activeDialogQueue = queue;
}

/**
 * 子进程退出通知：取消该 pid 的全部挂起 dialog（current + 排队项，经
 * rejectChildDialogs 的既有语义）。
 *
 * 调用点 = 引擎镜像层（SpawnedChildrenMirror 的 exited 分支与 killAll 整体置死）。
 * 语义 = SR-4 原设计「child close → 取消其 pending」在协议化架构下的落点：宿主不再
 * 持有 pi 子进程句柄，改由引擎经 host/childStateChanged 上报，本函数是消费端——
 * 未接线的后果是「子进程已死、宿主仍占着队列串行位等应答」，直到队列级 30min 超时
 * 才释放（延迟清理，非死锁）。
 *
 * 未登记队列（headless / 无 UI 通道宿主）或该 pid 无 pending 时 no-op。
 */
export function notifyChildProcessExited(pid: number): void {
  activeDialogQueue?.rejectChildDialogs({ pid });
}

/** 测试钩子：读当前登记队列（undefined = 未登记）。 */
export function _getActiveDialogQueueForTest(): DialogGlobalQueue | undefined {
  return activeDialogQueue;
}
