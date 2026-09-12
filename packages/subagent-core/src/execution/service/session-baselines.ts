// [H3/R1] SessionBaselines 聚合（域 #2：session 注入 + ALS/嵌套身份基线）——自
// SubagentService 上帝类 strangler 抽取的首个聚合（设计
// docs/design/subagent-service-decomposition.md §2.1 域 #2 / §3.3 D4；字段归属以
// r0-inventory.md 清单①为准，含 impl-plan 漏列的 uiObservability/execNesting/forkDepthAls）。
//
// 单一职责：session 级基线状态（pi 句柄 / session 身份 / fork 深度 ALS / exec 嵌套
// ALS / UI handler 面）的**唯一宿主与唯一写者**。壳（subagent-service.ts）经同名
// 私有 getter 透传读路径（strangler 转发壳），对外方法签名零变化。
//
// [R1 打样模式——R2-R4 复用]
// 1. 依赖注入形态：deps 全晚绑定闭包（构造期零求值）——D4 late-bound getter
//    `() => ({pi, disposed})` 形态的全 deps 推广。聚合持过期引用会破 session 复活
//    （dispose → initSession 翻转 disposed 旗标），一切运行时可变态必须断言/调用时现读。
// 2. 转发壳写法：壳保留同名私有 getter（字段面）与同名方法（方法面）单行转发；
//    聚合公共面 = 壳转发面 + 测试改写后的聚合路径，两面同源零漂移。
// 3. 跨聚合边收敛：他域直写本域字段的写点收敛为显式接口方法（本聚合：
//    disposeSessionUi ← 壳 dispose 直写 uiRequestHandler/uiObservability，清单① C-3）；
//    本域直写他域字段的写点收敛为 deps 显式回调（resetSettledRescan ← initSession
//    直写 settledRescanState，清单① C-2；R2 抽取后回调改指其聚合显式接口）。
// 4. 深绑测试改写：ServiceInternals / Reflect.get(service, "字段") 改经
//    `baselines` 聚合路径（断言对象与强度不变，路径对齐终态结构——见
//    __tests__ 各改写文件头注释）。

import { AsyncLocalStorage } from "node:async_hooks";

import { getLogger } from "../../core/logger.ts";

import type { ExtensionMode } from "../host-mode.ts";
import type { DialogGlobalQueue, UiRequestHandler } from "../dialog-queue.ts";
import { ExecutionNestingContext } from "../engine/common/nesting-guard.ts";
import { setHostUiRequestEndpoint } from "../engine/host/host-ui-endpoint.ts";
import type { PiLike } from "../notify-host.ts";
import type { StreamSink } from "../stream-sink.ts";
import { UiRequestObservability } from "../ui-request-observability.ts";
// [R6/D-R3-2] ENV_SELF_RECORD_ID 因跨聚合消费（record-access）归位常量叶子文件，
// 本聚合 initSession 消费改经 import（聚合→支撑文件方向合法）。
import { ENV_SELF_RECORD_ID } from "./service-constants.ts";

const logger = getLogger("subagents");

/** 跨进程身份贯穿的 env 名（父进程 spawn 子进程时注入，子进程 initSession 读取）。
 *  仿照 PI_SUBAGENT_FORK_DEPTH 机制，让递归 subagent 的身份（rootSessionId / parentRecordId / depth）
 *  跨进程传递，使主进程 /subagents 能看到完整递归树（设计见 docs/design/recursive-subagent-visibility.md）。
 *  语义：env 描述「子进程自己的身份」，不是父的身份（决策 1）。
 *  [MF-3] 第 4 个 env：真 ROOT 的 cwd（PI_SUBAGENT_ROOT_CWD）。worktree 模式下子进程 spawn cwd =
 *  checkout 路径，若按各自 cwd 编码落盘目录，深层 record 写到 enc(worktree) 段、ROOT 磁盘重建
 *  扫不到 → 全树可见性深度 ≥ 2 断裂。子进程经本 env 拿 ROOT cwd，sessions 与 records 两套目录
 *  统一编码在 enc(ROOT cwd) 段（与身份贯穿同构，见 session-runner 注入点）。
 *  [R1] 常量 SSOT 随消费主体（initSession/initExecContextBaseline/rootCwd 推导）自壳文件
 *  迁入本聚合并 export——壳经 import 消费（壳→聚合正向合法），禁聚合→壳反向 import（D4）。
 *  [R6/D-R3-2] ENV_SELF_RECORD_ID 因 record-access 跨聚合消费归位 service-constants.ts
 *  （消费主体单一且在本聚合时留驻，跨聚合时迁叶子文件——消除 R5 台账合法边①）。 */
export const ENV_ROOT_SESSION_ID = "PI_SUBAGENT_ROOT_SESSION_ID";
export const ENV_DEPTH = "PI_SUBAGENT_DEPTH";
export const ENV_ROOT_CWD = "PI_SUBAGENT_ROOT_CWD";

/** dispose 后注入的 stub UI 请求 handler。
 *
 * [背景] Pi 单进程 session 串行接管。session A shutdown 时 SIGTERM 子进程后、
 * 子进程彻底 close 前（pi 子进程 trap SIGTERM 做 graceful shutdown，窗口几十~几百 ms），
 * 子进程的 trailing extension_ui_request 仍可能被父进程 pump 解析，调到 A 的 handler 闭包。
 * 若 dispose 不清 uiRequestHandler，旧 handler 闭包仍持有 A 的 ctx，触发
 * inproc UI 请求队列（已删） 的 catch 分支打 `[subagents] uiRequestHandler threw` 误导性
 * logger.error（看起来像 bug，实际是预期竞态；三层兜底已确保功能正确）。
 *
 * stub 始终返回 {cancelled:true}，不调 ctx.ui、不捕获任何 ctx，让 trailing ui_request
 * 干净降级为 cancelled（等价于子进程主动取消）。
 *
 * 不置 undefined —— 那会让 trailing ui_request 走 inproc UI 请求队列（已删） 的 handler-missing
 * 分支触发 notifyMissingHandlerGlobal warn，噪声性质从 threw-error 变 missing-handler，
 * 没真正解决。
 *
 * [R1] 自壳文件迁入（消费点 = disposeSessionUi + 壳 dispose 的应答端 stub 替换）。 */
export const disposedUiRequestStub: UiRequestHandler = () => Promise.resolve({ cancelled: true });

/** session_start 注入参数（session 级）。
 *  [R1] 接口本体自壳文件迁入（唯一消费者 = SessionBaselines.initSession）；壳经类型
 *  别名 re-export 保持对外符号面（SubagentServiceSessionInit 仍从 subagent-service.ts
 *  导出，消费方零改动）。 */
export interface SubagentServiceSessionInit {
  pi: PiLike;
  sessionId: string;
  /** 主 session 文件路径（session_start 解析后直传）。
   *  [E2E 实测] 不能经闭包缓存（getCachedMainSessionFile）读：jiti 多实例分裂下闭包
   *  变量不跨实例共享，恢复逻辑读到的是滞后一个事件的值（读到未 flush 的新 session
   *  ENOENT 路径，entry-born 孤儿整段漏判）。 */
  mainSessionFile?: string;
  /** UI streaming sink（ctx.ui.setWidget），用于 background text_delta 转发。 */
  streamSink?: StreamSink;
  /** 主进程运行模式（W4 守卫：headless 不注入 ask_user RPC 提示词）。
   *  initSession 读取后存入 this.sessionMode，buildSessionRunnerContext 透传给 session-runner。 */
  mode?: ExtensionMode;
  /** UI 请求 handler（session 级覆盖进程级）。
   *  [D4-④ UI 接线外提] 本字段是 handler 的唯一注入入口（原 setUiRequestHandler 方法已删）。
   *  三态语义：undefined = 不动（保留进程级构造/上次值，供不注入 handler 的调用方）；
   *  null = 显式清空（承载原 setUiRequestHandler(undefined) 语义——headless 的
   *  createUiRequestHandlerForMode 返回 undefined 时壳侧传 null）；值 = 注入并重置
   *  缺失告警去重。 */
  uiRequestHandler?: UiRequestHandler | null;
  /** L2 跨子进程全局 dialog 串行队列（进程单例）。子进程退出时经引擎镜像层
   *  （SpawnedChildrenMirror → notifyChildProcessExited）取消该 pid 的挂起请求（SR-4）。 */
  dialogQueue?: DialogGlobalQueue;
  /** [竞态修复] 主 agent 是否空闲查询（ctx.isIdle），透传给 notifier 的 flush isIdle gate。
   *  避免 background 完成通知在 agent_end→finishRun 窗口里走错 sendMessage 分支丢失。
   *  可选：未注入时 notifier flush 不 gate（原行为）。 */
  isIdle?: () => boolean;
}

/**
 * [R1 打样模式 1] 聚合协作 deps——**全部晚绑定闭包，构造期零求值**。
 *
 * 窄结构类型只声明聚合真实消费的通道（打样：deps 面 = 依赖最小化声明，不整实例注入）。
 * 三类成员：
 * - 断言状态 getter（readAssertState）：D4 形态 `() => ({pi, disposed})`——pi 在
 *   initSession 时点晚绑定注入、disposed 随壳 dispose/revive 翻转，构造期注值必持
 *   过期引用破 session 复活，必须断言时现读。
 * - 复活/重置回调（reviveDisposed / resetSettledRescan）：initSession 对壳旗标与
 *   他域字段（#5 SyncCollect 的 settledRescanState，清单① C-2）的写点显式化——
 *   R2 抽取后回调改指其聚合显式接口，聚合间零直写（G2）。
 * - 跨域编排回调（getStore/getNotifyHost/recoverOrphans/bootRoundSupervisor/
 *   runPendingReconcileSweep）：initSession 复活后的跨域编排时序（R3/R4 域）以回调
 *   注入，聚合→壳零 import（D4）；R3/R4 抽取后同点改指聚合显式接口。
 */
export interface SessionBaselinesDeps {
  /** [D4 late-bound getter] assertReady 断言状态快照源（pi 运行时注入 + 声明周期 disposed 旗标）。 */
  readonly readAssertState: () => { pi: PiLike | null; disposed: boolean };
  /** session 复活：壳 `_disposed` 置 false（dispose 的逆操作，/resume /fork /new 后）。 */
  readonly reviveDisposed: () => void;
  /** [C-2 显式回调] settled 重扫状态重置（壳 #5 SyncCollect 字段置 null；R2 改指聚合显式接口）。 */
  readonly resetSettledRescan: () => void;
  /** RecordStore 窄门面（setPi 同步注入 + revive；store 为 #1 留壳共享依赖）。 */
  readonly getStore: () => { setPi(pi: PiLike): void; revive(): void };
  /** NotifyHost 窄门面（revive；通知面 #1 留壳）。 */
  readonly getNotifyHost: () => { revive(): void };
  /** [跨域编排回调] 孤儿终态恢复（#3 RecordLifecycle 域方法；R3 改指聚合显式接口）。 */
  readonly recoverOrphans: () => void;
  /** [跨域编排回调] 轮次监督器 boot 分区（#14 协作面；R4 改指聚合显式接口）。 */
  readonly bootRoundSupervisor: () => void;
  /** [跨域编排回调] 注册对账 sweep（#14 service-binding 模块函数 + #18 finalize 委托闭包，壳装配）。 */
  readonly runPendingReconcileSweep: () => void;
}

/** 构造期静态初值（进程级；与晚绑定 deps 分离——语义不同轴）。 */
export interface SessionBaselinesCtorInit {
  /** 宿主进程 cwd（rootCwd env 推导的兜底值，见 rootCwd 字段注释 [MF-3]）。 */
  cwd: string;
  /** 进程级 UI 请求 handler 初值（session 级覆盖走 initSession.uiRequestHandler）。 */
  uiRequestHandler?: UiRequestHandler;
}

/**
 * 域 #2 聚合：session 注入 + ALS/嵌套身份基线（R1 自 SubagentService 抽取）。
 *
 *   session_start:
 *     4. service.initSession({pi, sessionId})   ← 壳转发到本聚合
 *
 * 字段所有权（r0-inventory 清单① #13-#25 全部 13 个）：本聚合唯一写者；壳经
 * getter 只读透传。assertReady 断言状态经 deps.readAssertState 现读（D4）。
 */
export class SessionBaselines {
  private readonly deps: SessionBaselinesDeps;

  /** UI 请求 handler（进程级，可被 setUiRequestHandler / initSession 覆盖）。 */
  private uiRequestHandler: SubagentServiceInitUiRequestHandler;

  /** L2 dialog 串行队列（进程级）。SR-4：子进程退出时经引擎镜像层
   *  （SpawnedChildrenMirror → notifyChildProcessExited）取消该子进程的挂起请求。 */
  private dialogQueue: DialogGlobalQueue | undefined;

  /** UI 请求可观测性（sessionMode + handler 缺失告警去重，提取自原上帝类降低行数）。 */
  private readonly _uiObservability = new UiRequestObservability();

  private _pi: PiLike | null = null;

  /** 当前 Pi session ID（本进程 pi session，事件路由等用；record 过滤不用它）。initSession 时注入。 */
  private _sessionId: string | null = null;

  /** 主 session 文件（initSession 按值直传——jiti 多实例下闭包缓存不可靠，见 SessionInit 注释）。 */
  private _mainSessionFile: string | undefined;

  /** 所属根 session ID（record 归属过滤用）。根进程 = sessionId（自己是 root）；
   *  子进程 = env PI_SUBAGENT_ROOT_SESSION_ID 贯穿的真 ROOT（initSession 读取）。
   *  与 sessionId 正交：sessionId 是本进程 pi session（事件路由等），sessionRootId 是所属根
   *  （collectRecords filter 用，与 createRecordForMode 的 rootSessionId 盖章同源——子进程
   *  因此看到整棵 ROOT 树）。设计见 recursive-subagent-visibility.md 决策 3。 */
  private _sessionRootId: string | null = null;

  /**
   * [D3-⑤ 嵌套防护合一] 进程内执行嵌套上下文（原 execCtxAls 私有字段下沉公共层
   * common/nesting-guard.ts ExecutionNestingContext——机制注释含 ALS 断裂基线兜底）。
   * 实例 per-Service：基线随宿主进程身份而异（initSession 从 env 建立）。
   */
  private readonly _execNesting = new ExecutionNestingContext();

  /** fork 深度基线（同 ALS 断裂问题：forkDepthAls.getStore() 兜底用）。根进程=0。 */
  private forkDepthBaseline = 0;

  /** [MF-3] 所属根进程 cwd（sessions/records 落盘目录编码键）。
   *  根进程=自身 cwd（构造时 init.cwd）；子进程=env PI_SUBAGENT_ROOT_CWD 贯穿的真 ROOT cwd。
   *  worktree 模式下子进程 this.cwd 是 checkout 路径，若按它编码目录，深层 record 落到
   *  enc(worktree) 段、ROOT 扫描不到 → 全树可见性深度 ≥ 2 断裂（与 sessionRootId 同构）。 */
  private readonly _rootCwd: string;

  /** UI streaming sink（ctx.ui.setWidget）。workflow 域经 getStreamSink() 取用。 */
  private _streamSink: StreamSink | null = null;

  /** [竞态修复] 主 agent isIdle 查询（ctx.isIdle）。notifier flush gate 用。
   *  initSession 注入，piAdapter 透传给 NotifierHost。 */
  private _isIdleFn: (() => boolean) | undefined;

  /** [MF#4][MF#2] fork 深度按 async 调用链传递（AsyncLocalStorage），替代共享可变计数器。
   *  主 session=0；fork 进入子 session 期间推进为子深度，供嵌套 fork 经 ALS 读到自身深度作为
   *  parentForkDepth。并发 background fork 各自独立调用链，不再互相压低深度值。
   *  [MF#2] 旧实现用单实例字段跨执行链共享 → 并发下 A 还原深度后 B 读到被压低值 → 护栏失效。 */
  private readonly forkDepthAls = new AsyncLocalStorage<number>();

  constructor(init: SessionBaselinesCtorInit, deps: SessionBaselinesDeps) {
    this.deps = deps;
    this.uiRequestHandler = init.uiRequestHandler;
    // [MF-3] rootCwd env 推导随字段迁入（原壳构造器逻辑逐行等价）：读 env PI_SUBAGENT_ROOT_CWD
    // （根进程无 env → init.cwd）。sessions 与 records 两套目录必须同源（同一 rootCwd），
    // 否则 enc 段不变量断裂（只改其一会让同 record 的 session 文件与 manifest 分落两段，
    // GC/重建互相找不到）——推导在构造期一次完成，壳经 this.rootCwd 读取。
    const envRootCwd = process.env[ENV_ROOT_CWD];
    this._rootCwd = envRootCwd && envRootCwd !== "" ? envRootCwd : init.cwd;
  }

  // ── 壳只读透传面（getter）──
  // [R1 打样模式 2] 壳侧同名私有 getter 逐个透传到这些成员；写点全部收口在本聚合
  // 方法内（D1 单写者）。getter 与存储字段分离 = 壳/测试只读，防写路径旁路聚合。

  get pi(): PiLike | null { return this._pi; }
  get sessionId(): string | null { return this._sessionId; }
  get mainSessionFile(): string | undefined { return this._mainSessionFile; }
  get sessionRootId(): string | null { return this._sessionRootId; }
  get streamSink(): StreamSink | null { return this._streamSink; }
  get isIdleFn(): (() => boolean) | undefined { return this._isIdleFn; }
  get rootCwd(): string { return this._rootCwd; }
  get uiObservability(): UiRequestObservability { return this._uiObservability; }
  get execNesting(): ExecutionNestingContext { return this._execNesting; }

  /**
   * [F6] 当前根 session id 的只读访问——引擎接线方（SAR 等）构造 RunContext 注入
   * `ctx.sessionRootId`（pi 引擎 relay 归属键 SESSION_ID 权威源）。initSession 后有值
   * （根进程 = 本 session id；嵌套 = env 贯穿的真 ROOT）。壳保留同名公共方法转发（D3+
   * 壳终态永久保留面）。
   */
  getSessionRootId(): string | null {
    return this._sessionRootId;
  }

  /** UI streaming sink 只读访问（workflow 域消费）。壳保留同名公共方法转发（D3+）。 */
  getStreamSink(): StreamSink | null {
    return this._streamSink;
  }

  /** session_start 注入 pi + revive（modelRegistry/entries 归 ModelConfigService.initModel）。
   *  跨域编排（store.setPi/revive、通知面 revive、孤儿恢复、监督器 boot、对账 sweep）经
   *  deps 回调按原时序逐行执行——时序语义与抽取前逐行等价，见各回调注释。 */
  initSession(init: SubagentServiceSessionInit): void {
    this._pi = init.pi;
    // 同步注入 pi 到 RecordStore（构造时 pi 为 null，session_start 后才有真实 handle）。
    // RecordStore 跳过损坏 manifest 时调 appendEntry 上报用户可见——若不重新注入，
    // 上报通道永远是 no-op，事故排查依然静默。
    this.deps.getStore().setPi(this._pi);
    this._sessionId = init.sessionId;
    // 主 session 文件按值直传（jiti 多实例下闭包缓存不可靠，见接口注释）。
    this._mainSessionFile = init.mainSessionFile;
    this._streamSink = init.streamSink ?? null;
    this._isIdleFn = init.isIdle;
    // 读取 mode（W4 守卫透传给 session-runner）+ session 级 handler 覆盖
    //（[D4-④] initSession.uiRequestHandler 是唯一注入入口；三态语义见接口注释——
    //null = 显式清空，承载原 setUiRequestHandler(undefined) 语义）。
    this._uiObservability.setMode(init.mode);
    if (init.uiRequestHandler !== undefined) {
      this.uiRequestHandler = init.uiRequestHandler ?? undefined;
      this._uiObservability.resetMissingHandlerWarnings();
      // [W6 R3 MF-A] session 级覆盖同步进壳侧应答端登记（三态：null = 显式清空）。
      setHostUiRequestEndpoint(this.uiRequestHandler);
    }
    // SR-4：注入 L2 dialog 队列（child close 清理路径）。undefined 时 buildSessionRunnerContext
    // 透传 undefined，session-runner onClose 跳过 L2 清理（仅清 L1，保留旧行为）。
    if (init.dialogQueue !== undefined) {
      this.dialogQueue = init.dialogQueue;
    }
    this.initForkDepthBaseline();
    // [递归可见性] 跨进程身份贯穿（设计 recursive-subagent-visibility.md）。
    // 父进程 spawn 时注入 env 描述「子进程自己的身份」（rootSessionId / selfRecordId /
    // depth / rootCwd），语义与基线建立见 initExecContextBaseline。根进程无 env →
    // sessionRootId = init.sessionId（自己是 root），execCtxAls 不 enterWith（顶层）。
    const envRoot = process.env[ENV_ROOT_SESSION_ID];
    this._sessionRootId = envRoot ?? init.sessionId;
    this.initExecContextBaseline(envRoot, init.sessionId);
    // revive（dispose 的逆操作：/resume /fork /new 后复活）——壳 _disposed 旗标经 deps
    // 回调复位（旗标所有权留壳：assertReady 断言面 readAssertState 的写侧）。
    this.deps.reviveDisposed();
    // [v2 D4] settled 重扫状态随 revive 重置：新 session 的 E1 若再判「仍有 running」
    // 可重新注册。旧 handler 闭包捕获旧 state：正常时序（session_shutdown →
    // session_start）下已随 dispose() 惰化；未经 dispose 的时序残留仍会在 settled
    // 边沿执行——其扫描壳 mainSessionFile 当前值（非注册时的旧文件），行为等价于
    // 新 session 多注册一次扫描，由账本 sync-batch:<hash> 幂等 + batchFinalized 候选
    // 过滤收敛，无跨 session 污染面。（C-2：#5 字段写点显式化为 deps 回调。）
    this.deps.resetSettledRescan();
    this.deps.getStore().revive();
    this.deps.getNotifyHost().revive();
    // 孤儿终态恢复（放 initSession 末尾：setPi 已注入（appendEntry 可用）、
    // sessionRootId 已建立（过滤当前根的 record）；单扫描者判据见 recoverOrphansIfRootProcess）
    this.deps.recoverOrphans();
    // [W4] boot 分区 + 注册对账 sweep（须在孤儿恢复之后——依赖关系见两方法注释：
    // 孤儿恢复把「重启前在途」record 直断 closed、把 resumable 形态保留 running 落
    // entry，监督器重认领消费后者；sweep 再对终态 record 补发注销落盘——表 3 行 2
    // 「注销经对账 sweep 保证落盘」的编排点）。
    this.deps.bootRoundSupervisor();
    this.deps.runPendingReconcileSweep();
  }

  /**
   * [SPAWN fork depth 跨进程传递] fork 链深度基线：子进程被父 spawn 时，父通过 env
   * PI_SUBAGENT_FORK_DEPTH 传入当前 fork 链深度。子进程 session_start 时读取作为
   * forkDepthAls 基线，使后续嵌套 spawn fork 能从正确深度递增。未设置（顶层主
   * session）→ 基线 0。enterWith 贯穿整个 session 生命周期。
   */
  private initForkDepthBaseline(): void {
    const envDepth = process.env.PI_SUBAGENT_FORK_DEPTH;
    if (envDepth !== undefined && envDepth !== "") {
      const base = Number.parseInt(envDepth, 10);
      if (!Number.isNaN(base) && base > 0) {
        this.forkDepthAls.enterWith(base);
        this.forkDepthBaseline = base;
      }
    }
  }

  /**
   * [递归可见性] exec 上下文基线：子进程读 env PI_SUBAGENT_SELF_RECORD_ID / DEPTH
   * 建立身份基线后，createRecordForMode 读嵌套上下文自动正确（孙挂到子名下）。
   * enterWith 贯穿整个 session 生命周期（与 forkDepthAls 同构，决策 4）。
   */
  private initExecContextBaseline(envRoot: string | undefined, sessionId: string): void {
    const envSelfRecord = process.env[ENV_SELF_RECORD_ID];
    if (envSelfRecord !== undefined && envSelfRecord !== "") {
      const envNestingDepth = Number.parseInt(process.env[ENV_DEPTH] ?? "0", 10);
      const nestingDepth = Number.isNaN(envNestingDepth) ? 0 : envNestingDepth;
      // [ALS 断裂修复] 基线兜底：enterWith 在 pi 事件回调模型下不可靠（机制注释见
      // common/nesting-guard.ts ExecutionNestingContext），基线是 createRecordForMode /
      // 护栏读 ALS store 失败时的权威回退。
      this._execNesting.setBaseline({ recordId: envSelfRecord, depth: nestingDepth });
      this._execNesting.enterWith({ recordId: envSelfRecord, depth: nestingDepth });
      if (process.env.XYZ_AGENT_DEBUG) {
        logger.debug(
          `[subagents] execNesting initialized: recordId=${envSelfRecord} depth=${nestingDepth} rootSessionId=${envRoot ?? sessionId}`,
        );
      }
    }
  }

  /** [C-3 显式接口收敛] dispose 时的 UI 面 stub 化：uiRequestHandler 换 stub +
   *  缺失告警去重重置。原壳 dispose 直写本聚合两个字段，R1 收敛为本显式方法
   *  （壳 dispose 编排调用；壳侧应答端登记 setHostUiRequestEndpoint(stub) 仍留壳）。
   *
   *  stub 化时序契约（原壳 dispose 注释）：第一时间换 stub，防 trailing ui_request 调到
   *  stale handler 闭包（仍持有 disposed session 的 ctx）产生误导性 console.error；
   *  必须在 emit/abort 之前——这些步骤可能同步触发 trailing pump。 */
  disposeSessionUi(): void {
    this.uiRequestHandler = disposedUiRequestStub;
    this._uiObservability.resetMissingHandlerWarnings();
  }

  /**
   * [D4 下沉] 校验 Service 就绪（pi 已注入 + 未 dispose）。原壳私有方法整体迁入，
   * 9 个壳调用点经壳同名私有方法转发（签名/错误文案逐字节不变）。
   *
   * dispose 后调用是异常路径：session_shutdown 已清资源，正常情况下紧接着
   * session_start 会 initSession 复活。若走到这里说明 session_start 没跟上
   * （RPC 边界 / reload 异常等），service 卡在 disposed 状态。
   *
   * 旧实现只抛 "hub disposed"——无信息，调用方和 AI 都看不懂，导致反复盲试。
   * 现在给出原因 + 恢复指引（重启会话或 /new）。真实错误文本会经 renderResult
   * 兜底透传到 AI（见 tool-render.ts extractResultError）。
   *
   * 断言状态经 deps.readAssertState **现读**（D4 late-bound getter）：构造期注值
   * 会持过期引用破 session 复活（initSession 复活用例锁定该语义）。
   */
  assertReady(): void {
    const { pi, disposed } = this.deps.readAssertState();
    if (pi === null) {
      throw new Error("pi not injected (initSession not called?)");
    }
    if (disposed) {
      throw new Error(
        "subagents service disposed (session ended). " +
          "This happens after session shutdown when the follow-up session_start did not arrive. " +
          "Recovery: start a new session or run /new to revive the subagents runtime.",
      );
    }
  }
}

/** 构造期 UI handler 初值类型（= SubagentServiceInit.uiRequestHandler 的同构窄类型；
 *  聚合不 import 壳 Init 接口，结构等价由构造点同语句保证）。 */
type SubagentServiceInitUiRequestHandler = UiRequestHandler | undefined;
