/**
 * SessionLifecycle — 从 session-service 巨石拆出的会话生命周期职责。
 *
 * 负责:create / delete / renameSession / restoreSession + sessions Map 所有权与写点
 * （S3 写点归位,设计 D2②:Map 从 Facade 迁入本模块,写点 3 处 = registerSession.set /
 * removeEntry.delete / clear;Facade 残余域读点经 ISessionRegistry 只读查询）+
 * 注册事件 onSessionRegistered（同步直发,订阅者组装根接线）。
 *
 * registerSession（原 Facade.initializeManagedSession）:session 对象构造 + sessions.set
 * + onSessionRegistered 同步直发——直接方法调用扇出,禁异步 bus/microtask;订阅扇出
 * 不设异常隔离、异常直接传播（与迁移前 Facade 体内顺序调用等价）。S3 期订阅者是
 * Facade（组装根在 Facade 构造器,按迁移前体内顺序执行 registerReplicatedStates →
 * ensureRecordEntriesCache → reconciler）,S5/S6 后换成 projection/record 模块自身。
 *
 * 其余 Facade 协作经 ILifecycleSessionOps 窄接口（10 方法,调用点实测,见
 * session-internal.ts）;adapterFactory/send 闭包经 ISessionRegisterDeps 窄依赖注入
 * （send 对 Facade 晚期注入状态的读经 getter 动态解析,语义与原内联闭包等价）。
 *
 * 依赖经构造注入:svc(lifecycle 窄接口)、pm(进程创建/销毁/rekey)、
 * registerDeps(注册装配依赖)。
 */
import { basename } from 'node:path'
import { existsSync, rmSync, unlinkSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { SessionSummary, BatchDeleteResult, ServerMessage } from '@xyz-agent/shared'
import { BUILTIN_PRESET_IDS } from '@xyz-agent/shared'
// [D6-⑨ u7] 图片缓存目录推导（shared SSOT，含 sessionId 穿越校验——cache 级联删除用）
import { getImageCacheDir } from '@xyz-agent/shared/paths'
import type { IProcessManager, IPiEngine } from '../ports/pi-engine.js'
import type { ILifecycleSessionOps, ISessionRegistry, ISessionRegisterDeps, IManagedSessionRecord } from './session-internal.js'
import type { IManagedSessionView, ScannedSession } from './types.js'
import { buildPresetClientOptions, hasSubagentWorkflowExtension, warnLaunchEffectiveMismatch } from './launch-params.js'
import type { PresetClientOptions } from './launch-params.js'
// D5 在途镜像（crash-forensics §3.3 D5 ①）：registerSession 汇聚点按本次 spawn 注入列表
// 写 injected（presetZero 订阅在 session-service，本处只写注入态——两写方字段互不触碰，
// 见 inflight-mirror.ts 文件头装配顺序说明）。
import { inflightMirror } from './inflight-mirror.js'
import type { PresetResolution } from '../preset-service.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore } from '../ports/session.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { toErrorMessage, errorWithCode, MODEL_NOT_CONFIGURED, SESSION_NOT_FOUND } from '../../utils/errors.js'
import { createForkedSessionFile, resolveEntryIdByTimestamp } from './session-fork.js'
// session-dead-structural-fixes D2/D4：转移原语（宣告帧 announce-idle 行）+ userStopped 门面
//（restore 标记检测 / delete 清理 / 收敛环）。event-interpreter 是唯一无环的兄弟依赖方向
//（session-service 值导入本文件与本文件引用的两者，反向 import 成环）。
import { applySessionOccupancyTransition, userStoppedGate } from './event-interpreter.js'
// restore 附着辅助（F2/F3 归一化 + U2/D1 生效值播种 + get_state 共用解析）——
// 自本文件迁出（max-lines 行数合规），函数体逐字节等价，见 restore-seeding.ts。
import { normalizeInactiveSessionFileIfNeeded, readEffectiveModelFromState, seedRestoreMetaOverride } from './restore-seeding.js'

// [arch 技术债登记，R3 ports 依赖倒置待收口] 下方五个 infra/pi 值 import（getSessionsDir /
// cleanupMigrateResidues + persistModelBinding / hydrateBindingMeta / assertPiSessionFile）
// 违反「services 禁止 import infra」三层规则（见 docs/architecture/runtime-layering.md 阶段 R3）。
// 同属本登记的衍生直引面：services/session/restore-seeding.ts（本文件拆出，直引
// session-file-utils 的 cleanupMigrateResidues / normalizeSessionFileInPlace /
// persistModelBinding——S2 追加登记，随 R3 同批收口，中期经 services/ports 暴露）。
// 未在本轮直接 port 化的原因：restore/fork 归一化管线是 W1 高危区（tmp+rename 原子覆盖 +
// 附着断言），包一层 port 接口属于行为敏感重构，应随 R3 阶段统一落地（ISessionStore 等
// port 扩展 + 专项测试），不在 review 修复批混入。hydrateBindingMeta 是注册表 SSOT 的
// 统一回填入口（sidecar-binding-sync 设计文档拍板接线在此），同样随 R3 收口。新写
// services 代码不得再效仿此处直引 infra。
import { getSessionsDir } from '../../infra/pi/pi-paths.js'
// B5 触发面收窄（memory-leak-remediation §3.1 + §3.2-B5，2026-09-15）：真删除路径的
// plugin sessionData 清理分发（tombstone + 分区摘除 + trash 软删除）。挂点从 removeSessionEntry
// 汇聚点收窄到本模块 delete——汇聚点四路收殓中三路（pi 崩溃 exit / forceQuit / restore 清场）
// session 存活，无条件清理会把存活 session 的插件数据 tombstone+trash。跨服务模块级分发
// 模式同 getCrashJournal（plugin-service 与 session-service 互为依赖，构造注入成环）。
import { clearRemovedSessionData } from '../plugin-service/session-data-store.js'
// 空闲回收占座原语与编排依赖类型（idle-pi-reclamation D6-2/D3，u2）。ReclaimSeat 是
// reaper 判定循环与 reclaimManagedSession 共享的互斥状态（同实例注入，u3 装配）。
import type { ReclaimSeat } from './idle-pi-reaper.js'
// persistModelBinding 锚定本模块路径是 mock 链刚需：restore 播种测试以硬编码 factory
// 替换本模块并经 importActual 取 re-export 的真身委托落盘（勿改为直引
// session-model-sidecar.js，否则真身链断、写点③⑤ 断言红）。
import { cleanupMigrateResidues, persistModelBinding } from '../../infra/pi/session-file-utils.js'
// 绑定字段注册表模块（BINDING_FIELDS / hydrateBindingMeta / CREATE_DERIVED_CALLERS SSOT）
import { hydrateBindingMeta } from '../../infra/pi/session-binding-fields.js'
import { assertPiSessionFile } from '../../infra/pi/session-attach-assert.js'

// stripSessionEndEntries / applyHeaderCwdFallback / containsSessionEndLine /
// SESSION_END_RE / normalizeInactiveSessionFileIfNeeded / get_state 生效值解析与
// restore 播种已迁 './restore-seeding.ts'（本文件 max-lines 行数合规）。

// D8-3 迁移 promise gate（06 §3.3，perf W29）：provider 迁移（apiKey → auth.json +
// enabledModels 白名单）完成前禁止 spawn pi——迁移窗口内 spawn 的 session 会读到迁移前
// 配置（pi AuthStorage 无文件监听，旧 session 不感知新 auth.json）。
// 组合根（index.ts）后台初始化块经 setMigrationGate 注入；gate 必须自带 catch——
// 迁移失败也 resolve（best-effort 语义：失败不阻塞任何功能，下次启动重试）。
// 默认 resolved（未注入时无 gate 语义：单测/无迁移场景行为与旧版一致）。
let migrationGate: Promise<unknown> = Promise.resolve()

/** 组合根注入迁移完成 gate（D8-3）。传入的 promise 必须已 catch（失败同样 resolve，不阻塞 spawn）。 */
export function setMigrationGate(gate: Promise<unknown>): void {
  migrationGate = gate
}

/** 当前 gate（测试断言/重置用）。 */
export function getMigrationGate(): Promise<unknown> {
  return migrationGate
}

// ── create / forkSession 提取 helper（复杂度债务偿还，行为保持提取）──
// 以下类型与模块级纯函数是 create / forkSession 按处理阶段拆分的载体：
// 主函数只留编排，分支细节下沉。结构与原内联参数类型逐字段一致（公共签名不动）。

/** create options 形状（create() 公共签名与本文件 helper 签名共用，字段 doc 为权威）。 */
interface CreateOptions {
  hidden?: boolean
  /** Launch preset id（设计文档 §5，绑定到新 session 并解析为 pi 启动参数）。 */
  presetId?: string
  /** 归属 project id（D14 语义修正，2026-08-04）：创建时归属当前 activeProject；空 = 默认项目兑底。 */
  projectId?: string
  /**
   * 模型覆盖。D5 契约快照化：landing 新建路径恒传 renderer resolveLaunchConfig 解析
   * 终值；fork/restore/agent-managed create 入口可缺省（走 `override > preset > 全局默认`
   * fallback 链，见 resolveCreateLaunch）。覆盖 preset.modelOverride（C-RL-6 优先级）。
   */
  modelOverride?: string
  /** thinkingLevel 覆盖，语义同 modelOverride（覆盖 preset.thinkingLevel，C-RL-6 优先级）。 */
  thinkingOverride?: string
  /** 发起来源：'user' | 'agent'。agent-managed session 标记。 */
  spawnSource?: 'user' | 'agent'
  /** 父 agent session id（spawnSource='agent' 时必填）。 */
  parentAgentSessionId?: string
  /**
   * label 是否为语义性命名（需持久化到 pi session_info 且防 auto-rename 覆盖）。
   * true：handoff 承接名 / agent-managed 显式命名。false（默认）：前端派生 prompt
   * 预览名 display-only（见 persistExplicitLabel docstring 的 A' 修正）。
   */
  persistLabel?: boolean
}

/** forkSession options 形状（原 forkSession 内联参数类型的具名别名，仅本文件 helper 签名复用）。 */
interface ForkOptions {
  fromMessageTimestamp?: number
  fromMessageRole?: string
  modelOverride?: string
  thinkingOverride?: string
}

/** get_state 读回的生效值播种形状（U2；registerSession metaOverride 参数的内联类型别名）。 */
interface EffectiveMetaOverride {
  modelId?: string
  thinkingLevel?: string
}

/**
 * create 入口 cwd 存在性解析（INV-7）：cwd 可能已被删除（worktree 清理/手动删目录），
 * 降级 homedir（与 restoreSession 对称）。前端 useNewTaskFlow 通过比对「请求 cwd」vs
 * 「reply session.cwd」判断是否 fallback 并 toast。
 */
function resolveCreateCwd(cwd: string | undefined): string {
  const requestedCwd = cwd ?? process.cwd()
  return existsSync(requestedCwd) ? requestedCwd : (() => {
    console.warn(`[session-lifecycle] create cwd does not exist: ${requestedCwd}, falling back to home`)
    return homedir()
  })()
}

/**
 * [D6-⑨ u7] session 文件路径 → sessionId。真实文件名形态 `<ISO时间戳>_<uuid>.jsonl`
 *（sidecar `<同前缀>.jsonl.<suffix>`；形态实测锚点 `2026-09-02T14-40-39-107Z_01a06290-
 * 9ac3-7d46-90f6-39a86248025e.jsonl`），sessionId = 末段 `_` 后的 uuid 段（=== 首行
 * header id，与 scanSessionMeta / external-scan 按内容解析的 sessionId 同值；renderer
 * 写 cache 目录用的正是该纯 uuid）。与 main 侧 image-cache.ts 的 sessionIdFromSessionFilePath
 * 同语义——runtime 进程无法跨包 import main 模块，内联副本（cache 级联删除的目录名派生
 * 用）。曾按「剥 `.jsonl` 后全名」派生出 `<ts>_<uuid>`，与 cache 目录名（纯 uuid）永不
 * 相等致级联删除 rmSync no-op（U3 修正）。
 */
function sessionIdFromSessionFilePath(filePath: string): string {
  const main = basename(filePath).replace(/\.jsonl.*$/, '')
  const underscore = main.lastIndexOf('_')
  return underscore === -1 ? main : main.slice(underscore + 1)
}

/**
 * 空串/非 string 归一 undefined（D6 源生效值读取用）：restore 播种在源不可知时写 '' 占位，
 * '' 属 nullish 检查不拦截的 falsy 值——直传 `override ?? preset` 链会以 '' 短路吞掉后续档。
 */
function nonEmptyStr(v: string | undefined): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/**
 * D1 写点③ 生效值解析（create）：get_state 读回真值优先于请求值（C-pi-13 写点写生效值；
 * pattern 引擎静默换模时读回值才是真值）。hydrate 与 persistModelBinding 两个写点共用。
 */
function resolveCreateEffectiveModelId(
  presetClientOptions: PresetClientOptions,
  createMetaOverride: EffectiveMetaOverride | undefined,
): string | undefined {
  return createMetaOverride?.modelId ?? presetClientOptions.model
}

function resolveCreateEffectiveThinkingLevel(
  presetClientOptions: PresetClientOptions,
  createMetaOverride: EffectiveMetaOverride | undefined,
): string | undefined {
  return createMetaOverride?.thinkingLevel
    ?? (typeof presetClientOptions.thinkingLevel === 'string' ? presetClientOptions.thinkingLevel : undefined)
}

/**
 * relay 尾扫目标（窄接口，idle-pi-reclamation D3 第 5 步）。u3 装配把 RelayRegistry 内
 * 该 mainSessionId 的注册条目 child 包装为 { kill }——kill 实现绑 relay-registry 导出的
 * killRelayChild：杀注册表在册 child 后，attachRelayChildWiring 挂载的 child 'exit'
 * handler 会自动走 cleanupEntry（tee 销毁 + pid 文件删除 + 双 Map 注销），即「杀完走
 * 注册表清理」由既有事件链结构性保证，本模块无需（也无法，领地外）手工清理注册表。
 */
export interface ReclaimRelayTarget {
  kill(): Promise<void>
}

/**
 * reclaimManagedSession 的编排依赖（D3 七步；全部窄接口注入——不 import relay-registry /
 * background-task-reaper 等具体服务，测试全 fake，生产由 u3 组合根装配）。
 */
export interface ReclaimSessionDeps {
  /** 与 reaper 判定循环共享的占座实例（D6-2 全链占座，同实例互斥）。 */
  seat: ReclaimSeat
  /**
   * relay 尾扫快照枚举（同步）——按 mainSessionId 返回当前在册的 relay 子进程目标。
   * [u3 装配清单] RelayRegistry 现无按 mainSessionId 枚举条目的公开 API（仅 u1b 的
   * hasByMainSessionId 存在性查询），u3 需补只读枚举访问器后接线。
   */
  listRelayChildrenByMainSession?(sessionId: string): ReclaimRelayTarget[]
  /**
   * 定向后台任务收殓（D3 第 5 步②）——u3 装配绑 reapSessionBackgroundTasks(getPiAgentDir(), sid)
   * （复用 background-task-reaper 单 session 入口，与 removeSessionEntry 汇聚点同款触发面）。
   */
  reapBackgroundTasks?(sessionId: string): Promise<void>
  /** pendingReload 定向清（D3 第 6 步）——u3 装配绑 ReloadOrchestrator.clearPending。 */
  clearPendingReload?(sessionId: string): void
  /**
   * 驱逐该 session 的历史重建缓存条目（B8，memory-leak-remediation §3.3-B8 候选 C：
   * 回收态驻留 8×全量历史的内存收益 > 低频单次全量重建的 CPU 成本）。装配绑
   * SessionService.evictHistoryRebuildCache → SessionHistoryReader.onSessionReclaimed。
   */
  evictHistoryRebuildCache?(sessionId: string): void
}

export class SessionLifecycle implements ISessionRegistry {
  /**
   * sessions Map（S3 起 Map 所有权在本模块,单写者 = registerSession.set /
   * removeEntry.delete / clear 三处;其余全部经 ISessionRegistry 只读）。
   * 元素可变语义：消费者拿到记录引用直接读写字段（ADR-0049 分区范式既有约定）。
   */
  private readonly sessions = new Map<string, IManagedSessionRecord>()
  /**
   * onSessionRegistered 订阅者列表（组装根接线;S3 期订阅者 = Facade,见类头注释）。
   * 列表语义（对齐 Facade onSessionDestroyedHandlers 先例）：S5/S6 换订阅者时
   * 各域模块各自注册,互不挤占。
   */
  private readonly sessionRegisteredHandlers: Array<(sessionId: string) => void> = []

  constructor(
    private readonly svc: ILifecycleSessionOps,
    private readonly pm: IProcessManager,
    private readonly configStore: IConfigStore,
    private readonly sessionStore: ISessionStore,
    private readonly workspaceService: WorkspaceService,
    /** registerSession 装配依赖（adapterFactory + send 闭包窄依赖,S3/D2② 随迁注入）。 */
    private readonly registerDeps: ISessionRegisterDeps,
    /**
     * D4（session-dead-structural-fixes）restore-abort 失败链的强杀收敛兜底（可选，组合根
     * 经 SessionService 构造注入 = dispatcher.forceQuit）。未注入时（存量测试）restore-abort
     * 失败仅记日志保留标记，下次 restore 重试。
     */
    private readonly userStoppedOps?: { forceQuitFallback: (sessionId: string) => Promise<void> },
  ) {}

  // ── ISessionRegistry：sessions Map 只读查询面（Facade 残余域读点的统一通道）──

  get(sessionId: string): IManagedSessionRecord | undefined { return this.sessions.get(sessionId) }
  has(sessionId: string): boolean { return this.sessions.has(sessionId) }
  keys(): IterableIterator<string> { return this.sessions.keys() }
  values(): IterableIterator<IManagedSessionRecord> { return this.sessions.values() }

  /**
   * 注册 session 事件订阅（组装根接线;同步直发,无异步 bus/microtask）。
   * S3 期由 Facade 构造器订阅（体内顺序 = 迁移前 initializeManagedSession 内联顺序）。
   */
  onSessionRegistered(handler: (sessionId: string) => void): void {
    this.sessionRegisteredHandlers.push(handler)
  }

  /**
   * onSessionRegistered 同步直发。**不设异常隔离、异常直接传播**——与迁移前
   * Facade initializeManagedSession 体内顺序调用等价（任一订阅者 throw →
   * registerSession reject → create/restore/fork 的 init catch 分支 safeDestroy
   * 后 rethrow,行为一致）。
   */
  private emitSessionRegistered(sessionId: string): void {
    for (const handler of this.sessionRegisteredHandlers) {
      handler(sessionId)
    }
  }

  /**
   * 初始化 ManagedSession 并写入 sessions Map（原 Facade.initializeManagedSession,
   * S3/D2② 迁入;内部名 registerSession）。create / restoreSession / forkSession
   * 三入口的注册汇聚点：session 对象构造 + sessions.set + onSessionRegistered
   * 同步直发。
   *
   * hidden 标记隐藏 session。parentSession/forkEntryId 透传 fork 血缘（FR-2 active
   * 路径回传），存入 session 对象后经 toSummary 输出到 SessionSummary。
   *
   * modelOverride：新 session 实际启动模型（"provider/modelId" 格式，已含 C-RL-6
   * 优先级解析）。传入时写入 session.modelId 元数据，让前端 composer chip 正确显示
   * （Staging Mode ADR-0056）；不传时 fallback configStore.getDefaultModel()。
   * 注意 pi 进程的模型在 createSession 时已由 pi client options 的 model 字段设定，
   * 此参数只补齐 session 元数据层的缺口。
   *
   * spawnExtensionPaths：本次 spawn 实际注入 pi 的 extension 路径列表（getExtensionPaths
   * / preset 解析结果，D5 ① per-session 可用性判定的输入）。缺省 = 未注入（测试/历史
   * 注册点）。五 spawn 形态（新 session / respawn / reattach / lazy restore / fork）全部
   * 经本汇聚点，injected 随之天然覆盖。
   */
  async registerSession(
    id: string, client: IPiEngine, cwd: string, label: string, sessionFilePath?: string, hidden?: boolean,
    parentSession?: string, forkEntryId?: string, modelOverride?: string,
    /** U2: restore/create get_state 读回的生效值播种，优先级高于 modelOverride/全局默认。 */
    metaOverride?: { modelId?: string; thinkingLevel?: string },
    /** D5 ①：本次 spawn 的 extension 注入列表（见方法 docstring）。 */
    spawnExtensionPaths?: readonly string[],
  ): Promise<IManagedSessionRecord> {
    const send = (msg: ServerMessage) => {
      // wave:perf-w09（02 文档 D1-2）：session 级消息单通道——payload 带 sessionId 的消息
      // 只走 bus.publish（per-session 单调 seq + ring/snapshot + 定向推给订阅该 sid 的 ws），
      // 盲广播腿已删除。broker.broadcast 退化为纯全局通道：只承接无 sessionId 的消息
      // （理论上 pi 事件流转发的消息恒带 sid，此分支是防御兜底，丢了比静默好）。
      // R8 验证结论（W09）：subagent.stream_delta 的 payload.sessionId 实为主 session id
      // （EventAdapter 以主 session 绑定翻译，extension setWidget 从主进程上报），
      // publish 目标即主 session，renderer 全量订阅（useSessionStreamSync）覆盖，无需 R-04。
      // S3 迁移注：messageBus / onMessageComplete 是 Facade setter 晚期注入状态，
      // 经 registerDeps getter 每次调用动态读（与原闭包捕获 this 动态查找等价）。
      const sid = (msg.payload as { sessionId?: string } | null)?.sessionId
      // PR #185 MF2：queue_update 帧不再对 queue 实例 markDirty（实例已撤销——.get() 生产
      // 零消费，防抖重拉 get_state 属无效 RPC）。深度真值 = 帧内 pendingMessageCount
      //（pi 队列深度的推送投影，与 get_state 快照同公式同源），renderer 对账直读帧值。
      if (sid) {
        this.registerDeps.getMessageBus()?.publish(sid, msg)
      } else {
        this.registerDeps.broadcastGlobal(msg)
      }
      // W5：message.complete 广播后通知 reload-orchestrator（消费 pendingReload 队）。
      // 覆盖所有 message.complete 路径（event-interpreter turn-end 主路径 + dispatcher abort
      // 手动广播）。onMessageComplete 未注入时为 no-op。
      if (msg.type === 'message.complete' && sid) {
        this.registerDeps.notifyMessageComplete(sid)
      }
    }
    // #8 G1：传 cwd 给 EventAdapter（write added/modified 判定 + agent_end git 对账用）
    const adapter = this.registerDeps.adapterFactory(id, send, cwd)
    adapter.attach(client)
    // Staging Mode（ADR-0056）：modelOverride 优先写入 session 元数据，让前端 composer chip
    // 正确显示用户选定的模型（create/fork/handoff 路径透传 effectiveModel）。pi 进程的模型
    // 已由 createSession 时 client options.model 设定，此处只补齐元数据层缺口。
    // 无 override 时 fallback 全局默认（与原行为一致）。
    // U2 播种优先级：metaOverride > modelOverride > 全局默认（hydrateBindingMeta 后续回填按矩阵语义）。
    const defaultModelRef = this.configStore.getDefaultModel()
    const fallbackModelId = defaultModelRef ? `${defaultModelRef.provider}/${defaultModelRef.modelId}` : ''
    const session: IManagedSessionRecord = {
      id, cwd, label,
      modelId: metaOverride?.modelId ?? modelOverride ?? fallbackModelId,
      thinkingLevel: metaOverride?.thinkingLevel,
      createdAt: Date.now(), lastActiveAt: Date.now(),
      // W10：inputTokens/tokenCount 退化为恒 0 派生基线（types 必填字段保留）——真值由
      // usage 实例快照持有，读点（getInputTokens / toSummary.tokenCount）从实例派生，
      // 任何路径不再直写这两个字段（旧外部 setter / applyContextUpdate 直写已删）。
      tokenCount: 0, inputTokens: 0, isGenerating: false, isCompacting: false, isBashRunning: false, bashRunToken: undefined,
      // occupancy 初值 = 全 idle（session-occupancy-send-closure D3 转移 #10 respawn 衔接）：
      // create/fork/restore（respawn）三入口共用本注册汇聚点，pi 重 spawn 后无活跃 run，
      // idle 起步成立（与上方三 flag 全 false 同语义）。idle 的 renderer 可观测性由下方
      // 显式宣告帧保证（写 state 快照 + 重订阅回放），不依赖「无帧 = idle 缺省」假设。
      occupancy: { turn: 'idle', compacting: false, bash: false },
      adapter, sessionFilePath,
      hidden,
      parentSession,
      forkEntryId,
    }
    this.sessions.set(id, session)
    // occupancy idle 宣告帧（session-dead-structural-fixes D2：收编为转移原语 announce-idle
    // 行，Gate B V6b 反例修复）：原语对该行合并/派生均为 no-op、跳过全等去重强制广播当前
    // 投影（对象初值即 idle，「转移」的全等去重会短路广播，而本帧职责恰恰是「宣告」），
    // 广播走原语既有 state-topic 通路（实时广播 + 快照写入/重订阅回放双腿随通路保留，
    // 不绕过 state topic 裸 publish）：
    // 1. 写 bus state 快照：restore（respawn）后 renderer 重订阅时 stateSnapshot 回放必含
    //    idle 帧。旧假设「重订阅无帧 = idle 缺省」被帧丢失击穿——占用中 pi 死亡时 renderer
    //    的 session.exited 兜底 handler 同步失效本地订阅（invalidateStreamSubscription），
    //    随后到达的转移 #10 idle 帧被丢弃，occupancy 分区残留 stale compacting=true；dead
    //    占位吞掉消息流使其暂不可见，重新打开（restore）后 stale 显形且永无帧修正，flush
    //   （触发条件 = 收到全 idle 帧）永不触发，defer 队列滞留至 runtime 重启。
    // 2. 广播腿：create/fork 场景此刻订阅集合为空（renderer 收到 summary 后才订阅），
    //    restore 场景旧订阅集合已随 onSessionExit 的 bus.clearSession 清除——两腿实际都只
    //    落快照，由重订阅回放消费，时序上 subscribe 必然晚于本 publish（postLoadSession 在
    //    restore RPC resolve 之后），无竞态。
    // [合并修正 2026-09] 删除此处我方 crash-resilience 的裸 publish 残留——对方
    // session-dead-structural-fixes D2 已将其收编为下方 applySessionOccupancyTransition
    // ('announce-idle') 原语行（state-topic 通路双腿：实时广播 + 快照回放），两份并存
    // 会双发同一宣告帧（occupancy-runtime registerSession 用例的 publish 次数哨兵拦截）。
    // D5 ① injected 接线（crash-forensics §3.3 D5）：injected = 该 session 装有会上报
    // in-flight 的 extension（subagent-workflow），errsShape 的 absent-report 形态以此
    // 为先决——未注入 ⇒ 无 pi 引擎 subagent 能力 ⇒ 判「无在途」（正确语义而非 errs）。
    // 按本次 spawn 列表整值覆写（跨 epoch 不继承 stale-true）；与 presetZero 顺序无关
    //（presetZero 不触碰 injected，见 inflight-mirror.ts 文件头）。独立 try 隔离：
    // mirror 是 errs 判别的旁路设施，判定异常绝不外抛——外抛会打断 registerSession
    // 主链，把旁路故障放大成创建/恢复失败（与 session-service 侧 presetZero 挂点同型）。
    try {
      inflightMirror.setInjected(id, hasSubagentWorkflowExtension(spawnExtensionPaths ?? []))
    } catch (e: unknown) {
      // best-effort 降级：injected 写失败仅退化为 errsShape 判「无在途」（errs-safe 方向），不打断注册主链。
      console.error(`[session-lifecycle] mirror setInjected failed (sessionId=${id}):`, e)
    }
    applySessionOccupancyTransition(session, this.registerDeps.getMessageBus(), 'announce-idle')
    // 注册事件同步直发（sessions.set 之后——订阅者可经 Registry 读到条目）：S3 期订阅者
    // = Facade（组装根接线），按迁移前体内顺序执行 registerReplicatedStates →
    // ensureRecordEntriesCache → reconciler 对账（fire-and-forget）。
    this.emitSessionRegistered(id)
    return session
  }

  /**
   * 从 Map 删除条目（销毁 9 步编排的第 ② 步,设计 D2②：所有者执行,纯删除不发事件——
   * onSessionDelete/didDestroy 扇出等其余 8 步编排权留 Facade.removeSessionEntry wrapper）。
   */
  removeEntry(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /**
   * 清空 sessions Map（destroyAll shutdown 路径专用）。保持迁移前行为：只清 Map,
   * 不触发 dispose/销毁通知（进程将亡,缓存随进程同灭——G3 行为等价）。
   */
  clear(): void {
    this.sessions.clear()
  }

  /** Detach adapter（按 id 查 Map;Map 所有者自查）。pi 事件订阅经 EventAdapter 唯一持有,detach 即收口。 */
  detachSession(sessionId: string): void {
    this.sessions.get(sessionId)?.adapter.detach()
  }

  /**
   * 静默销毁 session 进程：吞掉 destroy 自身的异常（用于错误清理路径，
   * 避免清理失败掩盖原始错误）。调用方的控制流不变。
   */
  private async safeDestroy(id: string): Promise<void> {
    await this.pm.destroySession(id).catch(() => {})
  }

  /**
   * W1（数据源治理）→ A' 修正（2026-08-24 rename-session 回归）：**语义性命名**的初始 label
   * 经 pi set_session_name RPC 持久化（取代原 turn_end/agent_end 兜底直写机制），调用点在
   * client 就绪后（create 流程 getState 成功即证 RPC 可用）。
   *
   * 「语义性命名」= 调用方明确期望跨重启保留且**不该被 auto-rename 覆盖**的名字，
   * 现有三处：handoff 承接名（"handoff from X"）、agent-managed session 的 agent 显式
   * 命名、fork 显式 label（当前前端恒不传，协议保留）——均经 options.persistLabel=true
   * 显式声明。
   *
   * 派生 label **不调 RPC**——display-only：含 basename(cwd) 与前端 prompt 预览名
   *（createSessionFlow 派生的首条 prompt 前 10 码点，2026-08-24 前曾被误当显式名持久化，
   * 踩死 pi-rename-session 防覆盖守卫 getSessionName() 非空即 skip → auto-rename 全量
   * 失效，v0.9.3 起）。显示由内存 session.label + 既有 scanner fallback（extractSessionName
   * 返回 null → basename(cwd)）承担；pi 内存 sessionName 保持空，auto-rename 守卫照常通过。
   * 代价：auto-rename 未跑（禁用/失败）时重启，侧边栏从预览名回退 basename（窗口极小）。
   *
   * RPC 失败**不阻断** create/fork：label 留内存显示 + console.error 上报，
   * 恢复动作 = 手动 rename（renameSession 的 RPC 路径）重试。
   */
  private async persistExplicitLabel(client: IPiEngine, sessionId: string, label: string | undefined, source: string): Promise<void> {
    if (label === undefined) return
    try {
      await client.setSessionName(label)
    // eslint-disable-next-line taste/no-silent-catch -- best-effort 降级（docstring：RPC 失败不阻断 create/fork，label 留内存显示 + console.error 上报，恢复动作 = 手动 rename 重试）
    } catch (e) {
      console.error(`[session-lifecycle] ${source}: setSessionName RPC failed for ${sessionId} (label kept in memory only):`, e)
    }
  }

  async create(cwd?: string, label?: string, options?: CreateOptions): Promise<SessionSummary> {
    const tempId = crypto.randomUUID()
    const sessionCwd = resolveCreateCwd(cwd)

    // 启动 pi 前检查 model 配置,避免 pi 因无 model 直接 exit(1)
    if (!this.configStore.getDefaultModel()) {
      throw errorWithCode('No model configured. Please configure a provider and model in Settings before starting a session.', MODEL_NOT_CONFIGURED)
    }

    const { presetId, resolution, allExtPaths, presetClientOptions } = await this.resolveCreateLaunch(sessionCwd, options)
    // D8-3（perf W29）：迁移完成前 spawn pi 会读到未迁移配置——gate 等待。
    // gate 恒 resolve（迁移失败已 catch），正常迁移 <10ms 不可感知。
    await migrationGate
    const client = await this.pm.createSession(tempId, sessionCwd, {
      skillPaths: resolution?.skillPaths ?? this.svc.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
      systemPrompt: this.svc.getReplaceSystemPrompt(),
      ...presetClientOptions,
    })

    // 从 pi 获取真实 session ID + U2: 顺带读回生效 model+thinkingLevel（D2 设计）。
    // （getState / piSessionId 空值门禁 / 失败 safeDestroy 清理细节见 readBackCreateState；
    // L2 对账探针以 create 入参 override 为 requested 侧，见 readBackCreateState docstring。）
    const { piSessionId: id, sessionFilePath, createMetaOverride } = await this.readBackCreateState(client, tempId, {
      model: options?.modelOverride,
      thinkingLevel: options?.thinkingOverride,
    })

    // 用 pi 的真实 ID 替换临时 ID
    if (id !== tempId) {
      this.pm.rekey(tempId, id)
    }

    const session = await this.registerCreateSession(
      id, client, sessionCwd, label, sessionFilePath, options, presetClientOptions, createMetaOverride, allExtPaths,
    )

    // W1 → A'：仅语义性命名（options.persistLabel=true：handoff/agent-managed）持久化；
    // 前端派生 prompt 预览名 display-only（防覆盖守卫恢复，详见 persistExplicitLabel docstring）
    if (options?.persistLabel) {
      await this.persistExplicitLabel(client, id, label, 'create')
    }

    this.persistCreateBindings(session, presetId, options, presetClientOptions, createMetaOverride)

    // hidden session（公共 session）不记工作区历史——cwd 是数据目录，不应污染最近工作区列表。
    // homedir 过滤（含降级 homedir）由 WorkspaceService.record 统一负责（方案A，一处堵死全部路径），
    // lifecycle 层不再关心 cwd 是否降级。
    if (!options?.hidden) {
      this.workspaceService.record(sessionCwd)
    }
    const createdSummary = this.svc.toSummary(session)
    // S3-W2：创建入口收敛点（create 路径）——触发插件 didCreateSession 定向投递。
    this.svc.notifySessionCreated(createdSummary)
    return createdSummary
  }

  /**
   * create 的 launch 参数解析（preset + extension/skill/systemPrompt 求值，spawn 前）。
   *
   * 求值时序与提取前一致：getLaunchPresetOptions → getExtensionPaths →
   * buildPresetClientOptions 均在 migrationGate 等待之前；getSkillPaths 仍在主流程
   * createSession options 构造时（gate 之后）求值。
   *
   * Preset 解析（设计文档 §5/§8.1）：presetId 存在时委托 PresetService.resolve，
   * 返回 PresetResolution 供 options 映射；undefined（presetService 未注入/preset 被删）
   * 时 fallback 现有 svc.getExtensionPaths/getSkillPaths 逻辑。
   *
   * D5 契约快照化：options.modelOverride/thinkingOverride 在 landing 新建路径恒为
   * renderer resolveLaunchConfig 的解析终值（透传即生效，preset 同名字段档不可达）；
   * 本函数的 `override > preset > 全局默认` fallback 链保留，服务不经 landing 解析层的
   * 入口（fork/restore/agent-managed create——session-manager-handler.ts 的 create，
   * override 可缺省）。分层不变：renderer 管用户可见配置选择（model/thinking/presetId），
   * runtime 管 preset 内部展开（tools/extensions/skills/noSkills）。
   */
  private async resolveCreateLaunch(
    sessionCwd: string,
    options: CreateOptions | undefined,
  ): Promise<{
    presetId: string | undefined
    resolution: PresetResolution | undefined
    allExtPaths: string[]
    presetClientOptions: PresetClientOptions
  }> {
    const presetId = options?.presetId
    const resolution = presetId ? await this.svc.getLaunchPresetOptions(presetId, sessionCwd) : undefined
    const allExtPaths = resolution?.extensionPaths ?? await this.svc.getExtensionPaths(sessionCwd)
    // preset + override 字段经 buildPresetClientOptions 统一构建（S-RT-4 消除三处重复），
    // 含 C-RL-6 优先级（Landing 传入 > preset 字段）与 thinkingLevel 合法值校验（S-RT-5）。
    const presetClientOptions = buildPresetClientOptions(
      resolution, options?.modelOverride, options?.thinkingOverride,
    )
    return { presetId, resolution, allExtPaths, presetClientOptions }
  }

  /**
   * create 的 get_state 读回段：真实 session ID + session 文件路径 + U2 生效值播种
   * + L2 对账探针。
   *
   * U2: 从同一 get_state 读回 pi 生效 model + thinkingLevel，通过 metaOverride 播种。
   * create 路径：pattern 引擎可能静默换模，读回值是真值（而非请求值）。
   * 解析与 restore 播种共用 readEffectiveModelFromState（restore-seeding）。
   *
   * L2 对账探针（D7/E6）：requested = create 入参 override（有传才比，undefined 跳过
   * 该字段——agent-managed create 不传 override 即无对账面），与读回生效值不一致时
   * warn 单行（≤1 行/create，readBackCreateState 每 create 恰一次）——landing create 与
   * agent-managed create 共用本段，比对逻辑统一无入口区分。不设断言不抛错（pi 钳制/
   * 静默换模是合法行为，漂移只做可观测）。
   *
   * 两条失败分支都在本段收口（与提取前同序）：getState 抛错 → safeDestroy(tempId) +
   * 「Failed to get session state from pi」；pi 无 session id → safeDestroy(tempId) +
   * 「pi did not return a session ID」。
   */
  private async readBackCreateState(
    client: IPiEngine,
    tempId: string,
    requested?: { model?: string; thinkingLevel?: string },
  ): Promise<{
    piSessionId: string
    sessionFilePath: string | undefined
    createMetaOverride: EffectiveMetaOverride | undefined
  }> {
    let piSessionId: string
    let sessionFilePath: string | undefined
    let createMetaOverride: EffectiveMetaOverride | undefined
    try {
      const stateData = await client.getState()
      piSessionId = (stateData?.sessionId as string) ?? ''
      sessionFilePath = stateData?.sessionFile as string | undefined
      const readback = readEffectiveModelFromState(stateData)
      warnLaunchEffectiveMismatch(requested ?? {}, readback)
      if (readback.modelId || readback.thinkingLevel) {
        createMetaOverride = {
          modelId: readback.modelId,
          thinkingLevel: readback.thinkingLevel,
        }
      }
    } catch (e) {
      await this.safeDestroy(tempId)
      throw new Error(`Failed to get session state from pi: ${toErrorMessage(e)}`)
    }

    if (!piSessionId) {
      await this.safeDestroy(tempId)
      throw new Error('pi did not return a session ID')
    }
    return { piSessionId, sessionFilePath, createMetaOverride }
  }

  /**
   * create 的 registerSession 注册段（M3）：registerSession 失败时（adapterFactory/attach
   * 可能抛错），pi 进程已 spawn 但未进 sessions Map → 不可见不可销毁的僵尸进程。
   * try-catch + safeDestroy 保证异常时清理 pi 进程。
   */
  private async registerCreateSession(
    id: string,
    client: IPiEngine,
    sessionCwd: string,
    label: string | undefined,
    sessionFilePath: string | undefined,
    options: CreateOptions | undefined,
    presetClientOptions: PresetClientOptions,
    createMetaOverride: EffectiveMetaOverride | undefined,
    spawnExtensionPaths: readonly string[],
  ): Promise<IManagedSessionView> {
    try {
      // Staging Mode（ADR-0056）：透传 effectiveModel（presetClientOptions.model，已含 C-RL-6 优先级解析）
      // 让 session 元数据 modelId 反映实际启动模型，前端 composer chip 正确显示。
      // U2: metaOverride（get_state 读回值）优先级高于 presetClientOptions.model。
      return await this.registerSession(
        id, client, sessionCwd, label ?? basename(sessionCwd), sessionFilePath, options?.hidden,
        undefined, undefined, presetClientOptions.model, createMetaOverride, spawnExtensionPaths,
      )
    } catch (initErr) {
      await this.safeDestroy(id)
      throw initErr
    }
  }

  /**
   * create 的绑定落盘段（refreshAll → hydrate → sidecar persist 家族 → model binding）。
   *
   * 文件操作时序与提取前一致：只写 sidecar（*.preset.json / *.project.json / *.agent.json /
   * *.model.json），不创建/触碰 pi session 文件本体。preset/project/agent 三绑定经
   * skipJsonlExistsGuard 放行 existsSync 守卫（V9-④ 根修，理由见 persistCreateSidecars
   * docstring）；本段 persistModelBinding 前置 if + 内部守卫语义不变——model 面有 turn-end
   * ensure 补偿（tryPersistModelBinding），不依赖本写点。
   */
  private persistCreateBindings(
    session: IManagedSessionView,
    presetId: string | undefined,
    options: CreateOptions | undefined,
    presetClientOptions: PresetClientOptions,
    createMetaOverride: EffectiveMetaOverride | undefined,
  ): void {
    // [HISTORICAL] 不再调 ensureSessionFile 提前创建 session 文件。
    // 之前的实现在此处用 openSync(wx) 创建含 session+session_info 两行的最小文件，理由是
    // 「pi 延迟写入期间 scanPiSessions 找不到该 session」。但这与 pi 0.80.3 SessionManager._persist
    // 的写入策略冲突：_persist 首次 flush（收到 assistant 消息时）也用 openSync("wx")，撞上已存在文件
    // → EEXIST → pi 抛 message_start{stopReason:"error"} → 整个 session 永久卡死。
    // 现在依赖 SessionScanner.listAll 的合并机制：active session 从内存 Map（this.sessions）读，
    // 即使磁盘无文件也显示（restart 后内存清空，但此时未 flush 的 session 本就无内容，丢失合理）。
    this.sessionStore.refreshAll()
    // sidecar-binding-sync：绑定字段统一回填（BINDING_FIELDS 注册表驱动，create 列 = options）。
    // 内存 patch 收敛为 hydrateBindingMeta 单入口（undefined 字段 skip，与原逐字段 `if (x)`
    // 条件 patch 等价——presetId = options?.presetId 可为 undefined）；下方各 persist* 只管
    // sidecar 落盘，磁盘形态与内存解耦。fork 在 active 期经 getSession(srcId)?.launchPresetId
    // 读到（W-RT-5）；toSummary 透传绑定字段到 SessionSummary（含 session-manager list
    // 过滤所需的 spawnSource / parentAgentSessionId）。
    hydrateBindingMeta(session, {
      launchPresetId: presetId,
      projectId: options?.projectId,
      spawnSource: options?.spawnSource,
      parentAgentSessionId: options?.parentAgentSessionId,
      // D1 写点③（一致性修复）：hydrate 值与 registerSession 播种同源——createMetaOverride
      //（get_state 读回生效值）优先于请求值 presetClientOptions，消除「请求值覆写读回真值」
      //（C-pi-13 写点写生效值；pattern 引擎静默换模时读回值才是真值）。
      modelId: resolveCreateEffectiveModelId(presetClientOptions, createMetaOverride),
      thinkingLevel: resolveCreateEffectiveThinkingLevel(presetClientOptions, createMetaOverride),
    }, 'create')
    this.persistCreateSidecars(session, presetId, options)
    // D1 写点③ create/landing：落盘生效值（读回真值优先）。注意：create 瞬间 pi 尚未首
    // flush、sessionFilePath 路径有值但 .jsonl 文件不存在（pi 0.84.4 实装：SessionManager
    // 构造即生成确定性路径），persistModelBinding 内部 existsSync 守卫跳过本写点（偏差
    // #9①）——从未显式切模型的 session 的 .model.json 由写点③的 turn-end ensure
    // （tryPersistModelBinding，session-state-projection）补写，V1 文件断言由其满足；
    // 本段仅在文件已 materialize 的少见时序生效。
    if (session.sessionFilePath) {
      persistModelBinding(
        session.sessionFilePath,
        resolveCreateEffectiveModelId(presetClientOptions, createMetaOverride) ?? '',
        resolveCreateEffectiveThinkingLevel(presetClientOptions, createMetaOverride) ?? '',
      )
    }
  }

  /**
   * create 的 sidecar 落盘（preset / project / agent 三绑定，创建语义）。
   *
   * [V9-④ 根修，2026-09-09] 三个 persist* 调用传 skipJsonlExistsGuard 放行 existsSync
   * 守卫：create 路径 session 必然真实（getState 成功 + registerSession 成功后才到达
   * 本段），.jsonl 未 flush 只是 pi 延迟写入窗口（pi 0.84.4 实装：SessionManager 构造
   * 即确定性生成 sessionFile 路径，get_state 透传——路径有值、文件不存在），不再以文件
   * 存在性当 session 有效性判据。规则 #6 禁止的是创建/触碰 pi session .jsonl 本体
   *（openSync('wx') EEXIST 卡死），sidecar 是 xyz 自有文件经 atomicWrite 落盘、不触碰
   * .jsonl，放行不违反规则 #6。此前守卫恒跳过且无补偿写点（model 面有 turn-end ensure
   * tryPersistModelBinding 补偿，preset/project/agent 无）→ landing 新建 session 重启后
   * preset 绑定永久回退 builtin:full / 项目归属丢失 / agent badge 丢失。fork 路径
   * （:persistForkBindings）不传 flag——forkedFilePath 是已写出的新文件，守卫自然通过。
   * session.sessionFilePath 第一层守卫保留：路径 undefined（pi 异常未返回）无法定位
   * sidecar 落点。空 projectId（默认项目创建）不写 sidecar——等价于未归类。
   */
  private persistCreateSidecars(
    session: IManagedSessionView,
    presetId: string | undefined,
    options: CreateOptions | undefined,
  ): void {
    // 持久化 preset 绑定到 .preset.json sidecar（设计文档 §4），供 fork/restore 继承。
    const sidecarOpts = { skipJsonlExistsGuard: true }
    if (presetId && session.sessionFilePath) {
      this.sessionStore.persistPresetBinding(session.sessionFilePath, presetId, sidecarOpts)
    }
    // 持久化归属 project 到 .project.json sidecar（D14 语义修正，2026-08-04）。
    // 空 projectId（默认项目创建）不写 sidecar——等价于未归类，读取侧一致兑底默认项目。
    if (options?.projectId && session.sessionFilePath) {
      this.sessionStore.persistProjectBinding(session.sessionFilePath, options.projectId, sidecarOpts)
    }
    // .agent.json sidecar 落盘（重启恢复链路，G-1）——与 preset/project 同模式：
    // parentAgentSessionId 可选（#15）：spawnSource 单独成立即持久化，防异常路径下 badge 重启丢失
    if (options?.spawnSource && session.sessionFilePath) {
      this.sessionStore.persistAgentBinding(session.sessionFilePath, options.spawnSource, options.parentAgentSessionId, sidecarOpts)
    }
  }

  async renameSession(sessionId: string, newName: string): Promise<void> {
    const session = this.get(sessionId)
    if (session) {
      // W1（数据源治理）：活跃 session 的 label 持久化唯一写入口 = pi set_session_name RPC
      //（pi 内部 appendSessionInfo 落盘 + 广播 session_info_changed）。xyz 不再直写 session
      // JSONL，消除「用户手动命名被 pi rename-session 扩展 auto-rename 直写竞争覆盖」的
      // last-write-wins bug。
      // client undefined（pi 崩溃窗口）或 RPC 失败（success:false / 超时）一律 throw 走上层
      // toast——静默 no-op 会造成 UI 显示新名、零持久化、无提示的静默丢写。先 RPC 后改内存：
      // 失败时旧名保留可重试。
      const client = this.pm.getClient(sessionId)
      if (!client) {
        throw new Error(`Cannot rename session ${sessionId}: pi process is not available (try again after the session is reactivated)`)
      }
      await client.setSessionName(newName)
      // 内存态同步（toSummary/config.sessions 的即时数据源；session.label 的写方全集 =
      // 此处 RPC 成功后直写 + 事件路径 setLabelCache，两写点同源 pi 权威——label 的
      // ReplicatedState 实例已撤销，PR #185 MF1，label 不再有第三份状态）。
      session.label = newName
    } else {
      // 非 active session：W11（绝对写规则）改经短命 pi——withEphemeralPi 附着该文件
      // 后调 set_session_name RPC，session JSONL 仍由 pi 写（pi 对已 flush 文件的
      // appendSessionInfo 立即落盘，尾部出现改名 session_info entry）。xyz 直写
      // （persistSessionName openSync('a')）已随 W11 删除。探针 ~600ms 端到端
      // （冷启动 ~500ms + RPC <1ms），逐次冷起（D2 裁决，无 warm pi）。
      // 失败（spawn 失败 / 附着超时 / RPC 失败）rethrow 走上层 toast——旧名保留可重试
      // （与活跃分支同语义）。
      const target = this.svc.findScannedSession(sessionId)
      // D3（p1p4-closure W1）：未命中必须 throw——旧形态 if (target) 无 else 静默
      // return，UI 改名静默不生效（无持久化、无提示）。错误信息含 sessionId 与恢复
      // 动作（全局规则 16），上层 toast 路径既有。
      if (!target) {
        throw new Error(
          `Cannot rename session ${sessionId}: not found in active sessions or persisted files `
          + `(refresh the sidebar and verify the session still exists, then retry the rename)`,
        )
      }
      // findings #4（p1p4-closure W1）：header cwd 死路径（如 worktree 清理后）时
      // pi 0.84.1 switchSession 内 assertSessionCwdExists 直接拒绝附着（pi-mono
      // coding-agent/src/core/agent-session-runtime.ts switchSession；binary strings
      // 实证，findings §4.1；RPC switch_session 不透传 cwdOverride，无法绕过）——
      // 附着前按 restoreSession 同款 F3 形态归一化（cwd fallback 落回原文件；
      // 判定含 session_end 时一并 strip），然后附着原文件。cwd 检测源 = scanner
      // 从 header 读出的 target.cwd（与 restoreSession 一致）；正常文件（cwd 活
      // 且无 session_end）判定不命中，零变换直附着（探针 ~600ms 预期不变）。
      const cwdFellBack = !existsSync(target.cwd)
      if (cwdFellBack) {
        console.warn(`[session-lifecycle] rename target cwd does not exist: ${target.cwd}, normalizing header cwd to home before attach`)
      }
      // 扫描 stale（文件已消失）时跳过预读归一化——「文件不存在」的报错分工归
      // withEphemeralPi 内 switchSession（pi 报错，见其 docstring 的 @param 语义），
      // 预读 ENOENT 会短路该分工。restoreSession 无此守卫（既有行为保持，不动）。
      if (existsSync(target.filePath)) {
        normalizeInactiveSessionFileIfNeeded(target.filePath, cwdFellBack, this.sessionStore)
      }
      await this.pm.withEphemeralPi(target.filePath, (c) => c.setSessionName(newName))
    }

    // wave:perf-w26（D9-1 rename 失效点）：写路径改变 name（活跃分支 RPC 更新 pi 内存
    // + 内存 label；非活跃分支短命 pi 落盘 session_info 改变文件 mtime/size），
    // 但目录列举 TTL 快照 1s 内仍返回旧 name——rename 后侧栏刷新立即显示新名，显式失效目录缓存。
    this.sessionStore.invalidateScanCache()
    this.sessionStore.refreshAll()
  }

  /**
   * active session 删除路径的主文件清理。
   *
   * 为什么单独成方法：原 delete 内联此块时，与 scanned 分支的 sidecar 清理逻辑重复，
   * 使 delete 圈复杂度 16 超阈值 15（metrics-gate FAIL）。提取后两分支共用
   * purgeSessionSidecars，delete 回归纯编排。
   *
   * 语义（与提取前 `sessionFilePath && existsSync` 整块守卫等价）：主文件存在时
   * trash + 清理全部关联产物；主文件不存在（外部已删）时**整体零动作**——
   * 与 scanned 分支「无条件清孤儿 sidecar」的行为差异见 delete 的 else 分支注释。
   */
  private async purgeActiveSessionFile(filePath: string): Promise<void> {
    if (!existsSync(filePath)) return
    await this.sessionStore.trash(filePath)
    this.purgeSessionSidecars(filePath)
  }

  /**
   * 清理 session 主文件的全部关联产物（delete 是唯一清理点）。
   *
   * active / scanned 两分支共用：原先两处各内联一份完全相同的清理序列，
   * 是 delete 圈复杂度超阈的主要来源。
   *
   * best-effort 语义：sidecar unlink 失败不阻塞主流程（孤儿 sidecar 无害，
   * 强失败会掩盖删除本身的成功）。
   */
  private purgeSessionSidecars(filePath: string): void {
    // 清理 sidecar（删除失败不阻塞主流程）
    try { unlinkSync(filePath + '.meta.json') } catch { void 0 }
    // 清理 preset 绑定 sidecar（设计文档 §4，delete 是唯一清理点）
    try { unlinkSync(filePath + '.preset.json') } catch { void 0 }
    try { unlinkSync(filePath + '.project.json') } catch { void 0 }
    try { unlinkSync(filePath + '.handoff.json') } catch { void 0 }
    // 清理 agent binding sidecar（agent-managed-session；delete 是唯一清理点，防孤儿 sidecar）
    try { unlinkSync(filePath + '.agent.json') } catch { void 0 }
    // 清理 model binding sidecar（model binding；delete 是唯一清理点，防孤儿 sidecar）
    try { unlinkSync(filePath + '.model.json') } catch { void 0 }
    // 清理归一化残留 .tmp-migrate-*.jsonl（差距复审 suggestion 6，与 sidecar 同点 best-effort）
    cleanupMigrateResidues(filePath)
    // [D6-⑨ u7-memory-governance] toolResult 图片缓存级联（cache/images 是 session 文件
    // 之外的第四类关联产物，delete 是唯一清理点补齐——纯缓存语义下删除级联是三条清理
    // 通道之一；main 侧生命周期 SSOT 在 apps/electron/main/images/image-cache.ts 的
    // deleteSessionImageCache，runtime 进程无法跨包 import，此处按同语义内联最小接线：
    // 同一 shared paths 推导（getImageCacheDir 含 sessionId 穿越校验）+ force 幂等删）。
    try { rmSync(getImageCacheDir(sessionIdFromSessionFilePath(filePath)), { recursive: true, force: true }) } catch { void 0 }
    // W-Runtime4：清理 session 文件头解析缓存（infra session-file-utils 的 filePath 键
    // 派生缓存，非已删的 label 影子缓存）中的 stale 条目（避免无界增长）
    this.sessionStore.invalidateMetaCache(filePath)
  }

  async delete(sessionId: string): Promise<void> {
    // D4 清理路径：delete = 彻底删除，userStopped 标记随 session 一起清理（收敛环定时器
    // 一并停——active 分支的 removeSessionEntry 只停环不清标记，本调用补齐标记清理）。
    // 两分支共用（非 active 分支不经过 removeSessionEntry 也必须清）。
    userStoppedGate.disposeForDelete(sessionId)
    const session = this.get(sessionId)
    if (session) {
      // D5①（session-dead-structural-fixes）：kill 路径全量日志 K5——活跃 session 被删除时
      // 其 pi 进程被杀，含调用源与信号链（仅 active 分支有 kill；非 active 分支无进程可杀）。
      console.warn(`[session-lifecycle] deleting active session, killing pi, session ${sessionId} (kill_source=delete | who: user delete session action | chain: detach -> pm destroy -> trash session file)`)
      this.detachSession(sessionId)
      await this.pm.destroySession(sessionId)
      this.svc.removeSessionEntry(sessionId)
      if (session.sessionFilePath) {
        await this.purgeActiveSessionFile(session.sessionFilePath)
      }
    } else {
      const target = this.svc.findScannedSession(sessionId)
      if (!target) throw new Error(`Session ${sessionId} not found`)
      // 与 active 分支的行为差异（既有语义，保持）：主文件不存在（扫描 stale）时仅跳过
      // trash，孤儿 sidecar 仍无条件清理——不把 existsSync 折进 purgeSessionSidecars，
      // 否则 active 分支「文件不存在则整体零动作」的语义会被顺带改掉。
      if (existsSync(target.filePath)) await this.sessionStore.trash(target.filePath)
      this.purgeSessionSidecars(target.filePath)
    }
    // B5 触发面收窄（memory-leak-remediation §3.1 + §3.2-B5）：plugin sessionData（内存分区
    // + 磁盘文件）与 session 本体一同进废纸篓——trash 绑定**真删除**，active / scanned 两
    // 分支共用本点（用户删除非活跃 session 的插件数据同样随本体清理）。三条 session 存活
    // 路径刻意**不清**：pi 崩溃（session-service onSessionExit）/ forceQuit（dispatcher
    // 强杀，restore 重开历史完整）/ restore 清场（clearExistingSessionForRestore，同链随后
    // notifySessionCreated 摘碑复活）——它们随后 respawn / restore 复活同 id，插件数据必须
    // 原样存活供继续读写（tombstone 也不能打：迟到写守卫只属真删除）。顺序约束（设计
    // §3.2-B5）：在 removeSessionEntry 之后——didDestroy 投递（fire-and-forget）先行，插件
    // worker 迟到的 set/delete 由 SessionDataStore tombstone 丢弃。best-effort：清理失败
    // 只 warn，不阻断删除主流程（异步腿 rejection 在分发器内部逐实例 catch+warn）。
    try {
      clearRemovedSessionData(sessionId)
    } catch (e: unknown) {
      console.warn(`[session-lifecycle] plugin sessionData clear failed (sessionId=${sessionId}):`, e)
    }
    // wave:perf-w26（D9-1 delete 失效点）：session 文件已 trash，目录 TTL 快照 1s 内仍含
    // 已删条目——显式失效，删除后立即从侧栏列表消失（05 文档 V5 验收）。
    this.sessionStore.invalidateScanCache()
    this.sessionStore.refreshAll()
  }

  /**
   * 批量删除指定 cwd（folder）下所有 session。
   *
   * best-effort 策略：单个 session 删除失败不中断循环，聚合 deleted/failed 返回。
   * 查询合并 active（getActiveSummaries）+ persisted（scanSessions）去重，
   * 覆盖 active 但 JSONL 未 flush 的边界场景（AGENTS.md 关键规则 #6）。
   * 不调广播——广播由 caller（session-message-handler）控制。
   *
   * cwd 匹配用字面 === ：依赖 caller 传入与 summary.cwd 一致的字符串
   *（前端 folder 删除按钮传的是 listPersistedSessions 返回的原始 cwd，不经规范化）。
   *
   * 故意包含 hidden session（与 SessionScanner.listAll 的 !s.hidden 过滤不同）：
   * folder 删除是按 cwd 的彻底清理，hidden session 也属于该 cwd。
   * 若未来要改为排除 hidden，需同步评估前端列表（listAll 过滤）与删除的语义对齐。
   *
   * wave:perf-w26 修正（审查）：scanSessions 传 { force: true } 旁路目录 TTL 快照——
   * deleteByCwd 是写语义的彻底清理：走快照会漏删（TTL 窗口内刚落盘的 session 不在快照里）
   * 且误报失败（快照含已删条目时 delete 内 findScannedSession 找不到 → Session not found
   * → failed 数组 → 前端误报）。该调用点低频（用户点 folder 删除按钮），无性能顾虑。
   */
  async deleteByCwd(cwd: string): Promise<BatchDeleteResult> {
    const cwdSessions = new Set<string>()
    for (const s of this.svc.getActiveSummaries()) {
      if (s.cwd === cwd) cwdSessions.add(s.id)
    }
    for (const s of this.sessionStore.scanSessions({ force: true })) {
      if (s.cwd === cwd) cwdSessions.add(s.id)
    }
    const deleted: string[] = []
    const failed: Array<{ sessionId: string; error: string }> = []
    for (const id of cwdSessions) {
      try {
        await this.delete(id)
        deleted.push(id)
      } catch (e) {
        console.warn(`[session-lifecycle] deleteByCwd: failed to delete ${id}`, toErrorMessage(e))
        failed.push({ sessionId: id, error: toErrorMessage(e) })
      }
    }
    return { cwd, deleted, failed }
  }

  /** 从持久化文件恢复 session。 */
  async restoreSession(sessionId: string): Promise<SessionSummary> {
    const restoreStartedAt = Date.now()
    // D5②（session-dead-structural-fixes）：幂等短路复用——client 已活跃且未退出时直接
    // 返回现有 summary（等价 ensureActive 的既有短路分支），不再无条件清场重开。
    //
    // 背景（设计 §2.2 附带缺陷①）：restoreSession 无幂等保护——本事故中 restore #2（用户
    // 点击 dead session 的 session.restore RPC，直连本方法不经 ensureActive）把 restore #1
    // 0.6 秒前刚拉起的 pi 杀了重开（14:14:03.104 的「幽灵 exit 143」，K3 撞车实证）。
    // 短路条件取 ensureActive 同款判定（existing && !existing.exited）+ sessions Map 条目
    // 存在（toSummary 需要；缺条目 = registerSession 未完成的半截态，走全流程重开安全）。
    // 短路命中不产生 kill 日志、不重开进程（错误规格 §3.4「session.restore 短路命中」行）。
    const reused = this.reuseRestoreSessionSummary(sessionId)
    if (reused) return reused

    // 前置校验 + 旧进程清场 + cwd 解析（顺序即语义，勿调换，与拆分前同序）：
    // findScannedSession → SESSION_NOT_FOUND → model 门禁 → 旧 pi 清场（detach →
    // safeDestroy → 移 Map 条目）→ cwd 降级判定。
    const target = this.resolveRestoreTarget(sessionId)
    await this.clearExistingSessionForRestore(sessionId)
    const { sessionCwd, cwdFellBack } = this.resolveRestoreCwd(target)
    const { client, presetId, allExtPaths } = await this.spawnRestoreClient(target, sessionId, sessionCwd)
    await this.attachRestoreFile(client, target, sessionId, cwdFellBack)

    // U2: get_state 读回 pi 生效 model + thinkingLevel（D2 设计）。
    // switchSession 成功后 pi 已附着会话文件，get_state 返回当前生效值
    //（pi 行为锚点 = 登记 ⑩：switch_session 永久重绑读写目标，agent-session-runtime.ts:193-209 /
    // session-manager.ts:815-816）。
    // r3 校准：metaOverride 恒提供（读回成功/失败两路径同构），每字段独立走
    // 「读回值 → sidecar 扫描值 → ''」兜底链。restore 从不播种全局默认：空串经
    // registerSession 的 ?? 短路阻断 modelOverride/fallbackModelId，composer 按 D3
    // 显示占位而非假值，快照收敛自愈。
    // hydrateBindingMeta restore='none' 不覆写播种值（D1 裁决），所以兜底链在此完成不经过 hydrate。
    const restoreMetaOverride = await seedRestoreMetaOverride(client, sessionId, target)

    // M3: registerSession 失败时清理 pi 进程（与 create 同模式，收口在 registerRestoredSession）
    const session = await this.registerRestoredSession(sessionId, client, sessionCwd, target, restoreMetaOverride, allExtPaths)
    // 恢复后兜底广播一次上下文用量（pi 从历史估算 contextUsage）。
    // 注意：此广播可能早于前端订阅新 sessionId 通道（时序竞争，见架构约定 #7），
    // 前端 useContextUsage composable 的恢复腿（每次切入视图拉 session.getContext）保证到达。
    // fire-and-forget：拉取失败不阻塞 session 恢复。
    void this.svc.fetchAndBroadcastContext(sessionId)
    // sidecar-binding-sync：restore 全量回填（矩阵 restore 列）——修复缺陷 A-1：原来只回填
    // launchPresetId，projectId/spawnSource/parentAgentSessionId/handedOffTo 不回填导致
    // 重开后归属/徽标丢失、广播回退默认项目。期望值来自 findScannedSession 全字段 meta。
    // D1 裁决：restore 列 = 'none'，modelId/thinkingLevel 不经 hydrate 回填（播种由上方 metaOverride 完成）。
    hydrateBindingMeta(session, {
      launchPresetId: presetId, // 已含 BUILTIN_PRESET_IDS.FULL 兜底的解析值（resolved-in-entry）
      projectId: target.projectId,
      spawnSource: target.spawnSource,
      parentAgentSessionId: target.parentAgentSessionId,
      handedOffTo: target.handedOffTo,
    }, 'restore')
    const restoredSummary = this.svc.toSummary(session)
    // D4（session-dead-structural-fixes）：restore-abort——返回前检测 userStopped 标记。判定
    // 保持在主流程（位置同拆分前：toSummary 之后、notifySessionCreated 之前）：无标记时本行
    // 不产生任何 await 边界，await 时序与拆分前逐点相同。标记命中 → applyRestoreAbortConvergence
    //（abort + 收敛环；失败链与「标记不在此清」的理由见该函数 docstring）。
    if (userStoppedGate.hasUserStoppedMark(sessionId)) {
      await this.applyRestoreAbortConvergence(client, sessionId)
    }
    // S3-W2：创建入口收敛点（restoreSession 路径）——session 复活进 Map，插件 didCreate 投递。
    this.svc.notifySessionCreated(restoredSummary)
    // D5：恢复耗时一行日志（典型 ~600ms；大 session 数秒——P8 观测数据源）。
    console.log(`[session-lifecycle] restore ${sessionId} elapsed=${Date.now() - restoreStartedAt}ms`)
    return restoredSummary
  }

  /**
   * restore 幂等短路（D5②）：client 已活跃且未退出 + sessions Map 有该条目时，返回现有
   * summary 供 restoreSession 直接短路。
   *
   * 与拆分前逐点等价（含求值顺序）：getClient 无论命中与否都求值（首行）；命中候选才查
   * sessions Map（缺条目 = registerSession 未完成的半截态 → 返回 undefined 走全流程重开）；
   * 命中先 console.log 再 toSummary（短路命中不产生 kill 日志、不重开进程——错误规格 §3.4）。
   * 同步函数，不引入 await 边界。
   */
  private reuseRestoreSessionSummary(sessionId: string): SessionSummary | undefined {
    const existingClient = this.pm.getClient(sessionId)
    if (!existingClient || existingClient.exited) return undefined
    const active = this.get(sessionId)
    if (!active) return undefined
    console.log(`[session-lifecycle] restoreSession: client already active for ${sessionId}, short-circuiting to existing summary (D5②)`)
    return this.svc.toSummary(active)
  }

  /**
   * restore 前置校验：定位已落盘 session + model 门禁（顺序同拆分前：findScannedSession →
   * 未找到抛 SESSION_NOT_FOUND → getDefaultModel 门禁——错误优先级不可调换）。
   *
   * 文案是追加（非替换）：既有测试用 toThrow 子串匹配「Persisted session X not found」
   *（test/session-service.test.ts / test/session-pool-restoresession.test.ts），见设计文档 §7.3。
   */
  private resolveRestoreTarget(sessionId: string): ScannedSession {
    const target = this.svc.findScannedSession(sessionId)
    if (!target) {
      throw errorWithCode(
        `Persisted session ${sessionId} not found — 该会话无已保存内容（进程在首次保存前退出），请新建会话`,
        SESSION_NOT_FOUND,
      )
    }
    if (!this.configStore.getDefaultModel()) {
      throw errorWithCode('No model configured. Please configure a provider and model in Settings before restoring a session.', MODEL_NOT_CONFIGURED)
    }
    return target
  }

  /**
   * restore 清场：旧 client 仍活跃时 kill 后重开（D5①）。副作用顺序同拆分前：
   * 判定 → K3 日志 → detach → **await** safeDestroy → 移 Map 条目。
   *
   * D5①（session-dead-structural-fixes）：kill 路径全量日志 K3——旧 pi 被清场重开时
   * 必须留「谁发起、为什么」痕迹（2026-09-10 事故 14:14:03.104 exit 143 无 kill 日志
   * 排查一整晚的直接教训；K3 撞车实证：restore #2 杀掉 restore #1 刚拉起的 pi）。
   */
  private async clearExistingSessionForRestore(sessionId: string): Promise<void> {
    const existing = this.get(sessionId)
    if (!existing) return
    console.warn(`[session-lifecycle] killing active pi before restore, session ${sessionId} (kill_source=restore_clear | who: restore request while old pi still active (session.restore RPC / ensureActive) | chain: detach -> safeDestroy old pi -> respawn + switch_session)`)
    this.detachSession(sessionId)
    await this.safeDestroy(sessionId)
    this.svc.removeSessionEntry(sessionId)
  }

  /**
   * restore spawn cwd 解析：session cwd 可能已被删除(如 worktree 清理后),降级到 home。
   *
   * W1（restore-fork-attach-fix）：cwd 死路径时两处都要兜底——spawn 侧 = 本函数返回的
   * sessionCwd 降级（cwdFellBack 标记）；会话文件 header 侧 = F3 归一化时
   * applyHeaderCwdFallback 落回原文件（归一化后 header cwd 持久化为 homedir——W11「源文件
   * header 永久保持旧 cwd」的声明已被本设计取代，登记表 §4 例外③已更新）。
   * 副作用顺序同拆分前：existsSync → 判定失败才 warn → homedir()。
   */
  private resolveRestoreCwd(target: ScannedSession): { sessionCwd: string; cwdFellBack: boolean } {
    if (existsSync(target.cwd)) return { sessionCwd: target.cwd, cwdFellBack: false }
    console.warn(`[session-lifecycle] session cwd does not exist: ${target.cwd}, falling back to home`)
    return { sessionCwd: homedir(), cwdFellBack: true }
  }

  /**
   * restore spawn 段：preset 解析 → migrationGate 等待 → createSession（gate 等待使启动时
   * 恢复路径与 create 一致，D8-3/perf W29）。
   *
   * preset 是 launch 配置不是终态（设计文档 §4.5），restore 后仍属同一 preset，.preset.json
   * sidecar 不清理。target.launchPresetId undefined 时（历史 session 无 sidecar）用
   * 'builtin:full' 兜底（FR-10）。
   *
   * 求值顺序硬约束（同拆分前，勿把 options 字面量提到 gate 之前）：getLaunchPresetOptions →
   * extensionPaths 兜底 → buildPresetClientOptions → **await migrationGate** → createSession
   *（skillPaths / systemPrompt 在 options 字面量内求值 = gate 之后）。
   */
  private async spawnRestoreClient(
    target: ScannedSession,
    sessionId: string,
    sessionCwd: string,
  ): Promise<{ client: IPiEngine; presetId: string; allExtPaths: string[] }> {
    const presetId = target.launchPresetId ?? BUILTIN_PRESET_IDS.FULL
    const resolution = await this.svc.getLaunchPresetOptions(presetId, sessionCwd)
    const allExtPaths = resolution?.extensionPaths ?? await this.svc.getExtensionPaths(sessionCwd)
    // restore 不接收 Landing Chip override（无用户交互）。preset 的 model 是 launch 配置
    // 只在创建时生效——附着路径的模型终态由 pi 从 model_change entry 恢复（见下方
    // inheritSessionModel），presetClientOptions.model 在此处被显式清空；thinking 仍透传
    // preset（launch 档位；session 内切档由 thinking_level_change entry 承载）。
    const presetClientOptions = buildPresetClientOptions(resolution, undefined, undefined)
    await migrationGate
    const client = await this.pm.createSession(sessionId, sessionCwd, {
      skillPaths: resolution?.skillPaths ?? this.svc.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
      systemPrompt: this.svc.getReplaceSystemPrompt(),
      ...presetClientOptions,
      // P1（pi-assumption final gate V1⑤）：pi CLI --model 恒优先于 session entry 恢复
      //（main.js buildSessionOptions），restore 路径曾因全局默认兜底把 --model 拼进 spawn
      // args，用户切换过的模型在重启重开时被静默压回默认。模型终态改由 pi 从
      // model_change entry 恢复（每次创建/切换都会写该 entry，W1a 实证）。
      model: undefined,
      inheritSessionModel: true,
    })
    return { client, presetId, allExtPaths }
  }

  /**
   * restore 附着段：F2/F3 归一化 → switchSession → 附着断言 → 清 .meta.json 旧 sidecar；
   * 任一失败 → **await** safeDestroy 已建进程后原样重抛（子进程/监听器不泄漏）。
   *
   * W1（restore-fork-attach-fix）F2/F3 分流：pi 的 switch_session 是「永久重绑读写目标」
   *（pi-mono session-manager.ts setSessionFile 把传入路径存为永久 sessionFile，_persist
   * 每轮 appendFileSync 该路径——文件被删后 append 按路径重建），必须直接附着 sessions
   * 目录内的正式文件。旧「拷贝 $TMPDIR → 附着 tmp → 立即 unlink」管线使 pi 终身写 tmp
   * 孤儿文件、原会话文件永不更新（P0 数据丢失），已整体删除。
   * 判定/变换逻辑抽至 normalizeInactiveSessionFileIfNeeded（renameSession 非活跃分支共用，
   * p1p4-closure W1），行为不变（F2 直附着 = 归一化判定未命中：零拷贝零改写，pi 的读写
   * 目标 = 登记路径 = 原文件）。
   *
   * W2（restore-fork-attach-fix F4）：附着必断言（I1「登记路径 ≡ pi 写路径」）——
   * get_state().sessionFile 与登记路径 resolve 归一后必须一致，不一致即 throw
   *（D3 fail loud；catch 分支 safeDestroy + rethrow 保证进程不泄漏）。W2-4：清理旧
   * sidecar 移到 switchSession 成功之后——原顺序是 switchSession 之前 unlink，若
   * switchSession 抛错，原 session 的终态 sidecar（done/stopped）已被删 → 原会话终态永久
   * 丢失。现在只在切换成功后才删，失败时保留旧终态。
   */
  private async attachRestoreFile(
    client: IPiEngine,
    target: ScannedSession,
    sessionId: string,
    cwdFellBack: boolean,
  ): Promise<void> {
    try {
      normalizeInactiveSessionFileIfNeeded(target.filePath, cwdFellBack, this.sessionStore)
      await client.switchSession(target.filePath)
      await assertPiSessionFile(client, target.filePath, `restoreSession(${sessionId})`)
      try { unlinkSync(target.filePath + '.meta.json') } catch { void 0 }
    } catch (e) {
      // switch_session 失败时清理已创建的资源,避免子进程/监听器泄漏
      await this.safeDestroy(sessionId)
      throw e
    }
  }

  /**
   * restore 注册段：registerSession + 失败清理（M3：registerSession 失败时清理 pi 进程，
   * 与 create 同模式）。失败原样重抛（不吞错），清理失败不掩盖原始错误（safeDestroy 自身吞错）。
   */
  private async registerRestoredSession(
    sessionId: string, client: IPiEngine, sessionCwd: string, target: ScannedSession,
    restoreMetaOverride: { modelId: string; thinkingLevel: string },
    spawnExtensionPaths: readonly string[],
  ): Promise<IManagedSessionRecord> {
    try {
      return await this.registerSession(
        sessionId, client, sessionCwd, target.name ?? basename(sessionCwd), target.filePath,
        undefined, undefined, undefined, undefined, restoreMetaOverride, spawnExtensionPaths,
      )
    } catch (initErr) {
      await this.safeDestroy(sessionId)
      throw initErr
    }
  }

  /**
   * 空闲回收的最小摘除编排（idle-pi-reclamation D3 七步，u2）。
   *
   * 与死亡清理汇聚点 removeSessionEntry（九步销毁）刻意不同：回收**不是销毁**——bus 分区
   * （订阅/seq 连续，P3 广播流不断）、PTY、插件 didDestroy
   * 投递、终态写等全部跳过（D3 被跳过步骤归属表）；历史缓存例外——B8 起回收时驱逐该
   * session 条目（evictHistoryRebuildCache，驱逐后重激活走单次全量重建是显式登记的代价）。**禁止**为图省事改调 removeSessionEntry
   * ——被否谱系第 1 条：PTY 连杀 / 广播断流 / 插件 destroy 污染三重冲突（除非三重冲突
   * 全有独立解法，当前没有）。
   *
   * 返回 true = 回收完成（进程已杀 + Map 已摘）；false = 未回收（占座被占 / 最终豁免拦截 /
   * 代际校验取消）——调用方（reaper）据此决定合并广播与分布计数。
   *
   * 广播责任在 reaper 合并层（一拍 N 个回收只广播一次），本函数不广播——静默先例 =
   * restoreSession 清场与 lifecycle.delete。
   */
  async reclaimManagedSession(sessionId: string, deps: ReclaimSessionDeps): Promise<boolean> {
    // ① seat 占座（D6-2）：false = 已有回收在途（并发 reaper 拍 / 等待方视角），直接跳过。
    if (!deps.seat.tryAcquire(sessionId)) return false
    try {
      // ② 最终豁免检查（同步块零 await——本块与第 ④ 步 kill 的首个 await 之间无任何
      // await 窗口，是 D6-1 原子性的根基：reaper 判定通过后到 detach/kill 之间没有
      // 异步间隙让 occupancy 翻转而未被察觉）。
      const session = this.get(sessionId)
      if (!session) return false
      const occ = session.occupancy
      if (occ && (occ.turn !== 'idle' || occ.compacting || occ.bash)) return false
      // ③ adapter.detach（停事件流）：pi 事件订阅经 EventAdapter 唯一持有，detach 即收口
      // ——先于 kill，避免 kill 等待窗口内 pi 的尾流事件被翻译成消息广播。
      this.detachSession(sessionId)
      // ④ pm.destroySession（既有语义：先删 pm 双 Map 再 kill——exit 回调按 clientToId
      // 无条目守卫静默跳过，_killing 语义零 crash log 零 exitCallbacks 多播，即「计划内
      // 杀」在既有语义里就不产生崩溃记录与死亡广播，D3 引用 §1.1 事实 2）。
      await this.pm.destroySession(sessionId)
      // ⑤② 定向后台任务收殓（fire-and-forget，D3：正常情况豁免 #2 已保证无 running 任务，
      // 此步兜「任务在检查与 kill 间的毫秒窗口退出/registry 写半截」的边角）。内部自带
      // setImmediate 延后，不阻塞占座释放。
      void deps.reapBackgroundTasks?.(sessionId)?.catch((e: unknown) => {
        console.warn(`[session-lifecycle] reclaim background-task reap failed (sessionId=${sessionId}):`, e)
      })
      // ⑥a 代际校验（D6-3，摘除前）：占座期间若发生并发重建（未来绕过 ensureActive 的
      // 恢复入口——restore/create 注册必产生新条目对象 + 新 pm client），引用比对即检出。
      // 检出不摘除：新条目/新进程是无辜的，杀/摘它们 = 误杀并发重建的 session。
      if (this.get(sessionId) !== session || this.pm.hasClient(sessionId)) {
        console.warn(`[session-lifecycle] reclaim ${sessionId} cancelled: session was re-created concurrently (generation check, D6-3)`)
        return false
      }
      // ⑥b 最小摘除：lifecycle sessions Map 删条目 + pendingReload 定向清（防御性 no-op：
      // pendingReload 有条目 ⇒ session busy ⇒ 恒非回收候选，真发生的窗口极窄）。
      this.removeEntry(sessionId)
      deps.clearPendingReload?.(sessionId)
      // B8（memory-leak-remediation §3.3-B8 候选 C）：驱逐历史重建缓存条目——回收不是
      // 销毁，不走 removeSessionEntry 汇聚点，只驱逐缓存这一纯派生数据。挂代际校验
      // 通过后的成功路径（并发重建取消时新 session 无辜，不摘其缓存）；驱逐后重激活
      // 走单次全量重建（P7 张力四要素显式登记的代价，见 onSessionReclaimed 注释）。
      deps.evictHistoryRebuildCache?.(sessionId)
      // ⑤① relay 尾扫（D3 第 5 步①，fire-and-forget）。**单段快照语义**：快照枚举与
      // kill 目标列表在此同步段一次完成，setImmediate 异步执行阶段只用快照闭包、禁止再查
      // 再杀——两段式（异步 kill 后二次复查再杀）可能误杀 restore 后新 session 经 relay
      // 合法 spawn 的子进程（P6 尾扫项）。快照采集点放在代际校验通过之后：校验失败（并发
      // 重建）路径不采集不杀，新 session 的 relay 条目天然不在任何快照里（fail-safe 方向）。
      // setImmediate 先例同后台任务收殓：kill 链（SIGCONT→SIGTERM→3s grace→SIGKILL，
      // relay-registry killRelayChild 同款语义）移出占座区间，
      // 不可杀的 D 状态子进程等极端阻塞不拖累占座释放。
      const relayTargets = deps.listRelayChildrenByMainSession?.(sessionId) ?? []
      if (relayTargets.length > 0) {
        console.log(`[session-lifecycle] reclaim ${sessionId}: relay tail-sweep snapshot captured ${relayTargets.length} child(ren)`)
        setImmediate(() => {
          for (const target of relayTargets) {
            void target.kill().catch((e: unknown) => {
              console.warn(`[session-lifecycle] reclaim relay tail-sweep kill failed (sessionId=${sessionId}):`, e)
            })
          }
        })
      }
      return true
    } finally {
      // ⑦ try/finally 释放占座：占座只持有第 1-6 步的有界步骤（判定 sync / detach sync /
      // kill 硬上限 2s / 摘除 sync），任一步抛异常 finally 兜底释放——等待中的 ensureActive
      // 不会因占座泄漏永久挂起（D6-2「等待方永不抢跑」以释放确定性为前提）。
      deps.seat.release(sessionId)
    }
  }

  /**
   * D4（session-dead-structural-fixes）：restore-abort——userStopped 标记命中时 `await
   * client.abort()`（对 idle pi 是无害 no-op——锚点核实 pi@0.84.4 实装：abort RPC 分支
   * `dist/modes/rpc/rpc-mode.js:329-331` → `AgentSession.abort()`（`dist/core/agent-session.js:1222-1226`，
   * 仅 abortRetry + agent.abort + waitForIdle）→ `pi-agent-core/dist/agent.js:201-204`
   * `abort() { this.activeRun?.abortController.abort() }` 可选链——无活跃 run（`activeRun = undefined`，
   * `:371`）时零副作用；waitForIdle 对 isIdle（`agent-session.js:620-622`，`!_isAgentRunActive`）
   * 立即返回——幂等无副作用；对 session_start 钩子补投（notify replay / scheduler）已起跑的
   * replay turn 是精准中止）。
   * 调用方已判定标记存在（判定点与拆分前同位置），本函数不重复判定。
   *
   * 标记不在此清：notify-ledger 有两条投递腿（session_start 恢复扫描 + settled 补发腿——
   * abort 掐掉的 turn 收尾产生 agent_settled 边沿，busy parked 的通知在该边沿补投开新
   * turn），一次性 abort 后清标记会被补发腿击穿（R1 审查反例）。改由收敛环接管：abort 成功后
   * 启动静默观察窗（起点 = abort 完成，idle 场景同样有明确起点），标记存活期内 interpreter
   * 观测到非显式投递引发的 agent_start 一律再 abort，窗满且最后一次被掐 turn 的
   * agent_settled 已到达 → 判收敛清标记（挂点与状态机见 event-interpreter.ts
   * UserStoppedGate）。显式投递（sendPrompt 等）在 dispatcher 投递前清标记放行。
   *
   * 失败链顺序同拆分前：abort 抛错 → warn → **await** forceQuitFallback → 再抛错 → warn
   *（两层 try/catch 都在本函数内，吞错边界与拆分前一致）。
   */
  private async applyRestoreAbortConvergence(client: IPiEngine, sessionId: string): Promise<void> {
    try {
      await client.abort()
      // 主 abort 成功 → 启动收敛环（abort 失败路径不起环：标记不视为已消费，收敛环未完成，
      // 下次 restore 重试——错误规格 §3.4 restore-abort 失败行）。
      userStoppedGate.beginRestoreConvergence(sessionId)
    } catch (abortErr) {
      // 既有 abort 失败链收口（错误规格 §3.4）：超时/断链 → forceQuit 强杀收敛（幂等：
      // 进程已死时成功返回）。经注入的 dispatcher.forceQuit（构造注入，避免双倍 abort
      // RPC 超时等待直达强杀）。强杀失败（极端）→ 标记保留 + 环不启动，用户再点
      // 「强制退出」即达终态（设计恢复指引）。
      console.warn(`[session-lifecycle] restore-abort failed for ${sessionId}, falling back to force-quit convergence:`, toErrorMessage(abortErr))
      try {
        await this.userStoppedOps?.forceQuitFallback?.(sessionId)
      } catch (fallbackErr) {
        // 强杀收敛吞错（降级策略）：走到此处时 abort RPC 已超时，fallback 走 forceQuitSession
        // 完整链（含自己的日志与广播），此处异常不改变收敛路径——标记保留 + 环不启动（见上），
        // 下次 restore 重试；restore 主体不可回滚（session 已复活进 Map），向上传播只会把
        // 收敛细节泄漏成 restore 失败。极端兜底再失败的用户出口：再点「强制退出」即达终态。
        console.warn(`[session-lifecycle] restore-abort force-quit fallback also failed for ${sessionId}, mark kept for next restore:`, toErrorMessage(fallbackErr))
      }
    }
  }

  /**
   * Fork session（路径 A：runtime 读 JSONL 截断 + 新进程 switch_session）。
   *
   * 与 restoreSession 的差异：restore 切到已存在的完整文件；fork 先按 fromPiEntryId 截断
   * 源 JSONL 写新文件，再 switch_session 到截断后的文件。源 session 的 pi 进程不动。
   *
   * fork 后的新 session 独立运行（独立 pi 进程），原 session 保持不变。
   * 这符合 UI 语义（fork 到另一 panel，原 panel 继续）。
   *
   * @param srcSessionId   源 session id
   * @param fromPiEntryId  fork 点的 pi entryId（前端 Message.piEntryId）
   * @param includeFrom    true: 保留到该 entry（含）；false: 保留到该 entry 前（不含）
   * @param label          可选 session 名
   */
  async forkSession(
    srcSessionId: string,
    fromPiEntryId: string | undefined,
    includeFrom: boolean,
    label?: string,
    options?: {
      /** RPC 路径加载的 session 无 piEntryId 时，按前端消息 timestamp 匹配 fork 点（S6 随 Facade 编排迁入）。 */
      fromMessageTimestamp?: number
      /** timestamp 匹配的 role 限定（用户/助手侧消息消歧）。 */
      fromMessageRole?: string
      /**
       * Staging Mode（ADR-0056）：composer 暂存的模型覆盖，优先于源 session 当前生效值与
       * 源 preset.modelOverride（D6 继承链：staging override > 源生效值 > 源 preset > 全局默认）。
       * undefined 时 fork 继承源 session 当前生效值（不可读回落源 preset，E9）。
       */
      modelOverride?: string
      /** Staging Mode（ADR-0056）：composer 暂存的思考等级覆盖，继承链同 modelOverride（D6）。 */
      thinkingOverride?: string
    },
  ): Promise<SessionSummary> {
    // 【S6 迁入的 Facade 编排半截】wave:perf-w26（微项 12 find 合并）：整个 fork 只扫一次磁盘。
    // 原链路 resolveEntryIdByTimestamp 与本方法各自 scanSessions().find()（同 handler 两次
    // 全量扫描），合并为单次解析后贯穿使用。findScannedSession 内部 force：路径解析消费方
    //（fork 源文件定位，正确性敏感，plan M-3）。
    // model 门禁提前到函数首（r5-S2）：与 create/restore 的错误优先级一致（model 未配置时
    // 先于 source/entryId 解析失败报出，避免「先修 source 再撞 model 门禁」两段式报错）。
    if (!this.configStore.getDefaultModel()) {
      throw errorWithCode('No model configured. Please configure a provider and model in Settings before forking a session.', MODEL_NOT_CONFIGURED)
    }
    const source = this.svc.findScannedSession(srcSessionId)
    if (!source) {
      throw new Error(`fork: source session not found: ${srcSessionId}`)
    }
    const resolvedEntryId = await this.resolveForkEntryId(source, fromPiEntryId, options)

    // FR-20 parentSession fallback：源 session 可能尚未落盘（pi 延迟写入窗口，
    // 内存 active session 的 sessionFilePath=undefined）。fork 时若用未落盘的临时路径
    // 作 parentSession 会断裂血缘链，故用源 sessionId 作 fallback 键。
    // 仅当源 sessionFilePath 缺失时才传 fallbackParentId（落盘则用真实路径，更可读）。
    const sourceActive = this.get(srcSessionId)
    const fallbackParentId = sourceActive?.sessionFilePath ? undefined : srcSessionId

    // 2. 截断源 JSONL → 写新文件（parentSession 指回源文件/源 sessionId，形成父子链）
    // forkEntryId 字段写入新 header（= 截断锚点 fromPiEntryId），供后续 merge 定位 fork 点
    let forked: { filePath: string; sessionId: string }
    try {
      forked = await createForkedSessionFile(
        source.filePath,
        resolvedEntryId,
        includeFrom,
        getSessionsDir(),
        resolvedEntryId,
        fallbackParentId,
      )
    } catch (e) {
      // wave:perf-w26（D9-1，审查修正）：createForkedSessionFile 写文件半程失败时可能留下
      // 残缺 fork 文件——失效目录 TTL 缓存避免快照收录残缺条目（与 switchSession/initialize
      // 失败分支的失效对称，见下）。
      this.sessionStore.invalidateScanCache()
      throw e
    }
    const { filePath: forkedFilePath, sessionId: forkedId } = forked
    // wave:perf-w26（D9-1 fork 失效点）：fork 新文件由 runtime 直接写出（非 pi 延迟落盘），
    // 显式失效目录 TTL 缓存让下一次列表构建立即包含新 session（不依赖 active 内存合并兜底）。
    this.sessionStore.invalidateScanCache()

    // 3. spawn 新 pi 进程（与 restore 同模式）
    // fork 继承源 session 的 preset（设计文档 §4.5）。spawn cwd / 继承绑定 / launch 参数
    // 解析细节见各 resolve helper（求值时序与提取前一致，均在 migrationGate 等待之前）。
    const sessionCwd = this.resolveForkSpawnCwd(source)
    const { forkPresetId, forkProjectId } = this.resolveForkInheritedBindings(srcSessionId, source)
    // D6（state-truth-sync C5）：源 session 当前生效 model+thinkingLevel 作为 fork 继承档
    //（插在 staging override 与源 preset 之间），读取链见 resolveForkSourceEffectiveBinding。
    const sourceEffective = this.resolveForkSourceEffectiveBinding(srcSessionId, source)
    const { forkResolution, allExtPaths, presetClientOptions } = await this.resolveForkLaunch(
      sessionCwd, forkPresetId, sourceEffective, options,
    )
    // D8-3（perf W29）：fork 同样 spawn pi——gate 等待（06 审查修正：fork 是第三处 spawn 点）。
    await migrationGate
    const client = await this.pm.createSession(forkedId, sessionCwd, {
      skillPaths: forkResolution?.skillPaths ?? this.svc.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
      systemPrompt: this.svc.getReplaceSystemPrompt(),
      ...presetClientOptions,
    })

    // 4. switch_session 附着 fork 产物正式文件 + sidecar 写入（失败清理见 attachForkedFile）
    await this.attachForkedFile(client, srcSessionId, forkedId, forkedFilePath, forkPresetId, forkProjectId, presetClientOptions)

    // 5. 初始化 managed session（adapter、入 sessions Map）
    // FR-2 active 路径回传血缘：parentSession + forkEntryId 透传到 IManagedSessionView，
    // toSummary 输出到 SessionSummary，前端据此渲染 fork 父子关系。
    // （registerSession 失败的孤儿清理见 registerForkedSession。）
    const session = await this.registerForkedSession(
      forkedId, client, sessionCwd, label, forkedFilePath, sourceActive, srcSessionId, resolvedEntryId, presetClientOptions, allExtPaths,
    )

    // W1 → A'：fork 显式 label（用户显式命名，语义性）持久化；当前前端恒不传 label
    //（undefined no-op），WS 协议保留该字段，传入时持久化（见 persistExplicitLabel docstring）
    await this.persistExplicitLabel(client, forkedId, label, 'forkSession')

    void this.svc.fetchAndBroadcastContext(forkedId)
    // sidecar-binding-sync：fork 选择性继承回填（矩阵 fork 列）——修复缺陷 A-2：原来只写
    // .project.json sidecar 不 patch 内存，fork 产物活跃期广播 projectId 恒 undefined、
    // 重启才恢复。spawnSource/parentAgentSessionId/handedOffTo 刻意不传（fork none 语义，
    // 与防御性 unlink .agent.json 并存）。forkProjectId 无归属时 undefined → skip → 现状等价。
    hydrateBindingMeta(session, {
      launchPresetId: forkPresetId,
      projectId: forkProjectId,
      modelId: presetClientOptions.model,
      thinkingLevel: typeof presetClientOptions.thinkingLevel === 'string' ? presetClientOptions.thinkingLevel : undefined,
    }, 'fork')
    const forkedSummary = this.svc.toSummary(session)
    // S3-W2：创建入口收敛点（forkSession 路径）——新 session 诞生，插件 didCreate 投递。
    this.svc.notifySessionCreated(forkedSummary)
    return forkedSummary
  }

  /**
   * fork 的 fork 点 entryId 解析：piEntryId 缺失（RPC 路径读取的 session）时，
   * 读 JSONL 按 timestamp + role 匹配 entryId（S6 随 Facade 编排迁入）。
   */
  private async resolveForkEntryId(
    source: ScannedSession,
    fromPiEntryId: string | undefined,
    options: ForkOptions | undefined,
  ): Promise<string> {
    let resolvedEntryId = fromPiEntryId
    if (!resolvedEntryId) {
      resolvedEntryId = await resolveEntryIdByTimestamp(
        source.filePath,
        options?.fromMessageTimestamp,
        options?.fromMessageRole,
      )
    }
    return resolvedEntryId
  }

  /**
   * fork 的 spawn cwd 兜底（existsSync 存在性判定）。
   *
   * existsSync 兜底的**spawn cwd 参数**（pi 进程工作目录）；会话文件 header.cwd 的兜底
   * 在 createForkedSessionFile 生成 newHeader 时完成（W1 F1/MF2——fork 文件是创建型
   * 新文件，生成时兜底是最早、最便宜的拦截点）。
   */
  private resolveForkSpawnCwd(source: ScannedSession): string {
    return existsSync(source.cwd) ? source.cwd : homedir()
  }

  /**
   * fork 的继承绑定解析（preset + 归属 project）。
   *
   * W-RT-5：优先读 active 源 session 的内存态 launchPresetId（pi 延迟写入窗口下
   * sidecar 未写时，内存态兜底——getSession 返回 ManagedSession 实例，as 读 launchPresetId 字段），
   * 再 fallback 到扫描结果的 sidecar 值（source.launchPresetId），
   * 最后兜底 'builtin:full'（FR-10，历史 session 无 sidecar）。
   *
   * fork 继承源 session 的归属 project（D14 语义修正，2026-08-04）：
   * 与 preset 同模式——active 内存态兑底（延迟写入窗口），fallback 扫描 sidecar 值。
   * 无归属（undefined）= 默认项目，不写 fork sidecar。
   */
  private resolveForkInheritedBindings(srcSessionId: string, source: ScannedSession): {
    forkPresetId: string
    forkProjectId: string | undefined
  } {
    const active = this.get(srcSessionId) as { launchPresetId?: string; projectId?: string } | undefined
    return {
      forkPresetId: active?.launchPresetId ?? source.launchPresetId ?? BUILTIN_PRESET_IDS.FULL,
      forkProjectId: active?.projectId ?? source.projectId,
    }
  }

  /**
   * fork 的源 session 当前生效值读取（D6 / state-truth-sync C5）：modelId + thinkingLevel 两字段
   * （sidecar BINDING_FIELDS `.model.json` 家族同源两字段，字段范围刻意不含 projectId/label 等
   * ——各有既有继承通道）。
   *
   * 读取链与 resolveForkInheritedBindings 同构（W-RT-5 双源模式）：
   * 1. 活跃源读 runtime 内存实例 meta（switchModel/setThinkingLevel 的 session.modelId/
   *    thinkingLevel 直写 + ReplicatedState 收敛保证它是当前生效值）；
   * 2. pi 已退出/未恢复源回落扫描 sidecar `.model.json` 值（source 来自 findScannedSession，
   *    与 restore-seeding seedRestoreMetaOverride 的 sidecar 兜底同源）。
   *
   * 空串归一 undefined（restore 播种在源不可知时写 '' 占位，'' 传入 override 档会以
   * `'' ?? preset` 短路吞掉 preset 档）。两档皆缺（E9：老会话无 sidecar 且实例不在内存）
   * → undefined，调用方回落源 preset 档（现行为，不劣化）。
   *
   * 已接受代价（设计 D6 / 残留风险 P4）：「切模 → pi 死（未 restore）→ 直接 fork」序列读到
   * 旧 sidecar 值——fork 不触发源 restore 自愈，陈旧窗口量级限该序列，恢复路径 = fork 后
   * chip 改选；严格优于现状（现状恒落 preset/默认档）。
   */
  private resolveForkSourceEffectiveBinding(
    srcSessionId: string,
    source: ScannedSession,
  ): { modelId?: string; thinkingLevel?: string } {
    const active = this.get(srcSessionId) as { modelId?: string; thinkingLevel?: string } | undefined
    return {
      modelId: nonEmptyStr(active?.modelId) ?? nonEmptyStr(source.modelId),
      thinkingLevel: nonEmptyStr(active?.thinkingLevel) ?? nonEmptyStr(source.thinkingLevel),
    }
  }

  /**
   * fork 的 launch 参数解析（preset 解析 + extension 求值 + presetClientOptions 构建）。
   *
   * 继承链（D6，state-truth-sync C5）：
   * `staging override > 源 session 当前生效值 > 源 preset > 全局默认`
   * ——sourceEffective（源生效值档）经 `options?.* ?? sourceEffective.*` 插在 override 与
   * preset 之间；staging 路径（fork-ask）行为不变（override 优先）。sourceEffective 两字段
   * undefined（E9 源真值不可读）时整档跳过，回落 buildPresetClientOptions 的
   * `override > preset > 默认` 既有链（旧行为）。字段级独立走链（与 restore 播种的每字段
   * 独立兜底同构）：仅传 model override 不传 thinking 时 thinking 仍继承源生效值。
   */
  private async resolveForkLaunch(
    sessionCwd: string,
    forkPresetId: string,
    sourceEffective: { modelId?: string; thinkingLevel?: string },
    options: ForkOptions | undefined,
  ): Promise<{
    forkResolution: PresetResolution | undefined
    allExtPaths: string[]
    presetClientOptions: PresetClientOptions
  }> {
    const forkResolution = await this.svc.getLaunchPresetOptions(forkPresetId, sessionCwd)
    const allExtPaths = forkResolution?.extensionPaths ?? await this.svc.getExtensionPaths(sessionCwd)
    const presetClientOptions = buildPresetClientOptions(
      forkResolution,
      options?.modelOverride ?? sourceEffective.modelId,
      options?.thinkingOverride ?? sourceEffective.thinkingLevel,
    )
    return { forkResolution, allExtPaths, presetClientOptions }
  }

  /**
   * fork 的 switch_session 附着段（W1 直附着 + W2 附着断言 + sidecar 写入家族）。
   * 失败（L5）时清理孤儿 fork 文件（已写出但 pi 未能加载）+ 失效目录 TTL 缓存 + rethrow。
   */
  private async attachForkedFile(
    client: IPiEngine,
    srcSessionId: string,
    forkedId: string,
    forkedFilePath: string,
    forkPresetId: string,
    forkProjectId: string | undefined,
    presetClientOptions: PresetClientOptions,
  ): Promise<void> {
    try {
      // 4. W1（restore-fork-attach-fix F1）：pi 的 switch_session 永久重绑读写目标
      //（pi-mono session-manager.ts setSessionFile 把传入路径存为永久 sessionFile，_persist
      // 每轮 appendFileSync 该路径），直接附着 sessions 目录内的 fork 产物正式文件——
      // 此后每轮对话落 forkedFilePath。旧「拷贝 $TMPDIR → 附着 tmp → 立即 unlink」管线
      // 已删（pi 终身写按路径重建的 tmp 孤儿文件，fork 后对话全部丢失）。
      // 无需 strip：fork 产物由 createForkedSessionFile 按树过滤生成（登记表 §4 ⑥ 创建型
      // 合法形态），游离的 legacy session_end 行（无 id 不在树内）天然不进产物。
      await client.switchSession(forkedFilePath)
      // W2（restore-fork-attach-fix F4）：附着必断言（I1「登记路径 ≡ pi 写路径」）——
      // 登记的 forkedFilePath 必须就是 pi 的终身写目标，不一致即 throw（D3 fail loud）。
      await assertPiSessionFile(client, forkedFilePath, `forkSession(${srcSessionId})`)
      // W2-4：清理旧 sidecar 移到 switchSession 成功之后。
      // 原顺序是 switchSession 之前 unlink，若 switchSession 抛错，session 的终态 sidecar
      //（done/stopped）已被删 → 终态永久丢失。现在只在切换成功后才删，失败时保留旧终态。
      try { unlinkSync(forkedFilePath + '.meta.json') } catch { void 0 }
      // fork 不继承 agent binding（binding 是创建时语义）——防御性清理同名残留 sidecar
      try { unlinkSync(forkedFilePath + '.agent.json') } catch { void 0 }
      // 写 preset 绑定到 forkedFilePath 的 sidecar（设计文档 §4.5）。
      // fork 继承源 preset，forkedFilePath 是新文件（已写出），existsSync 守卫会通过。
      this.sessionStore.persistPresetBinding(forkedFilePath, forkPresetId)
      // 写归属 project 到 forkedFilePath 的 sidecar（D14 语义修正）：fork 继承源归属。
      if (forkProjectId) {
        this.sessionStore.persistProjectBinding(forkedFilePath, forkProjectId)
      }
      // 写 model binding 到 forkedFilePath 的 sidecar（model binding）：fork 继承源模型与思考等级。
      // effectiveModel/effectiveThinkingLevel = override > preset.modelOverride 生效值（C-RL-6 优先级）。
      if (presetClientOptions.model) {
        persistModelBinding(
          forkedFilePath,
          presetClientOptions.model,
          typeof presetClientOptions.thinkingLevel === 'string' ? presetClientOptions.thinkingLevel : '',
        )
      }
    } catch (e) {
      // L5: switchSession 失败时清理孤儿 fork 文件（已写出但 pi 未能加载）
      await this.safeDestroy(forkedId)
      await unlink(forkedFilePath).catch(() => {})
      // wave:perf-w26（D9-1）：fork 文件已删，失效目录 TTL 缓存（步骤 2 的失效到此刻的
      // 窗口内可能已被其他消费方扫进快照）。
      this.sessionStore.invalidateScanCache()
      throw e
    }
  }

  /**
   * fork 的 managed session 注册段（M3 + FR-2 血缘透传）。
   * parentSession 键与 createForkedSessionFile 写入 header 的 resolvedParentSession 一致
   *（源 sessionFilePath 落盘→用文件路径；未落盘→用源 sessionId）。
   * 失败（L5）时清理孤儿 fork 文件（已写出但 session 未进 Map）+ 失效目录 TTL 缓存 + rethrow。
   */
  private async registerForkedSession(
    forkedId: string,
    client: IPiEngine,
    sessionCwd: string,
    label: string | undefined,
    forkedFilePath: string,
    sourceActive: IManagedSessionRecord | undefined,
    srcSessionId: string,
    resolvedEntryId: string,
    presetClientOptions: PresetClientOptions,
    spawnExtensionPaths: readonly string[],
  ): Promise<IManagedSessionView> {
    const parentSessionKey = sourceActive?.sessionFilePath ?? srcSessionId
    try {
      // Staging Mode（ADR-0056）：透传 effectiveModel（presetClientOptions.model）让 fork 新 session
      // 元数据 modelId 反映实际启动模型（override > 源 preset.modelOverride）。
      return await this.registerSession(
        forkedId, client, sessionCwd, label ?? basename(sessionCwd), forkedFilePath,
        undefined, parentSessionKey, resolvedEntryId, presetClientOptions.model, undefined, spawnExtensionPaths,
      )
    } catch (initErr) {
      // L5: registerSession 失败时清理孤儿 fork 文件（已写出但 session 未进 Map）
      await this.safeDestroy(forkedId)
      await unlink(forkedFilePath).catch(() => {})
      // wave:perf-w26（D9-1）：同 switchSession 失败分支——孤儿文件已删，失效目录 TTL 缓存。
      this.sessionStore.invalidateScanCache()
      throw initErr
    }
  }

}
