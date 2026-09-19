/**
 * SessionRecords — subagent/workflow 记录域（S6/D2③ 迁出，原 Facade 两大半截合并）。
 *
 * 域内容（一个概念域的两半，冷热同源）：
 * - W18 派生缓存族：recordEntriesCaches + get_entries 增量重拉编排（entry_appended
 *   失效信号 → 防抖 → cursor 三路径拉取 → merge → 送达水位发布；plan 模式重设计 D1③④
 *   扩容第三族——第二道 customType 早退门 + scanPlanStateEntries 派生 + session.planState
 *   publish diff；[reload-closeout D2] 发布门基线从 merge 变化信号换成已发布快照水位，
 *   守卫/发布门处丢帧 = 水位滞留 → agent_settled / 15s 定时两腿对账补发，稳态零帧）；
 * - 磁盘读侧/动作/引擎配置：getSubagents/getWorkflows/getPlanState（冷启动磁盘扫描，与缓存刷新
 *   共用 scanSubagentEntries/scanWorkflowEntries/scanPlanStateEntries 同一份派生代码，D4）、
 *   getSubagentHistory/getAgentCall*（record.sessionFile 直读）、
 *   workflowAction/subagentAction（经扩展 slash command 的生命周期/定向消息操作）、
 *   U7 引擎配置三方法（engines.json/config.json 读写）。
 *
 * 订阅接线（D2③「S5/S6 后订阅者换成 record 模块自身」）：组装根（Facade 构造器）
 * 先调 subscribe(lifecycle)——注册顺序在 projection（播种）之后、reconciler 对账之前，
 * 与迁移前 Facade 订阅体内顺序逐一等价（播种 → record 注册 → reconciler）。
 * 销毁侧无事件——onSessionDisposed 由 Facade removeSessionEntry 第 ⑤ 步直调
 * （与 TraceSync/SessionStateProjection.onSessionDisposed 并列）。
 *
 * Facade 消费面：对外 9 方法 + invalidateRecordEntries 一行委托（ISessionService 契约
 * 不变，transport/index.ts 组合根经 Facade 委托到达——u-s5 同款形态）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SubagentRecord, WorkflowRunRecord, PlanStateView, PlanDocMeta } from '@taiji/shared'
import { SUBAGENT_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_CUSTOM_TYPE } from '@taiji/shared'
import { PLAN_STATE_CUSTOM_TYPE, extractPlanStateFromSessionFile, scanPlanStateEntries, INACTIVE_PLAN_STATE_VIEW } from './plan-state-extractor.js'
import type { SubagentEngineConfigView, SubagentEnginesFile } from '@zhushanwen/extension-protocol'
import { SUBAGENTS_ENGINES_FILENAME } from '@zhushanwen/extension-protocol'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getDataDir } from '@taiji/shared/paths'
import type { IProcessManager, IPiEngine } from '../ports/pi-engine.js'
import { getHistoryFromFilePath, type HistoryFileReadResult } from '../session-history.js'
import { extractSubagentsFromSessionFile, scanSubagentEntries } from './subagent-extractor.js'
import {
  extractRecordEngine,
  readEngineSubagentHistory,
  DEFAULT_SUBAGENT_ENGINE,
} from './subagent-engine-history.js'
import { extractWorkflowsFromSessionFile, scanWorkflowEntries } from './workflow-extractor.js'
import { getPiAgentDir } from '../../infra/pi/pi-paths.js'
import { discoverAndRegisterEngines } from '@zhushanwen/subagent-core/engine/engine-discovery-scan'
import { isStrictlyUnder } from '../../utils/path-utils.js'
import type { ISessionStore } from '../ports/session.js'
import { toErrorMessage } from '../../utils/errors.js'
import { withFileLockSync } from '../../utils/file-lock.js'
import { atomicWrite } from '../../utils/fs-utils.js'
import { isEntryNotFoundError } from './trace-sync.js'
import { SCALAR_STATE_DEBOUNCE_MS } from './replicated-states.config.js'
import { LateBoundSkillSource, SkillInjector } from './skill-injector.js'
import { publishSkillNotices } from './skill-notice-publisher.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import type { SessionRegisteredSource } from './session-state-projection.js'

/**
 * W18：per-session record entry 派生缓存（subagent/workflow 列表的 runtime 侧 owner）。
 *
 * 三路径（父文档 §3.1 失效-重拉模式）：
 * - 初始态：cursor = null → 首次失效触发全量 get_entries 拉取，扫描结果整体建缓存。
 * - 增量：cursor 指向最后已拉 entryId → get_entries(since=cursor)，增量 entry 扫描结果
 *   merge 入派生 Map（自描述 entry 是完整快照，同 id 后到覆盖）。
 * - 失效自愈：游标指向的 entry 不在 pi 当前集合（"Entry not found"，session 文件被外部
 *   改写 / pi 重启）→ 丢 cursor 全量重拉重建（纯派生缓存可随时丢弃，正确性优先）。
 *
 * 数据写路径唯一 = refreshRecordEntries 的 entry 扫描（scanSubagentEntries /
 * scanWorkflowEntries，与冷启动磁盘路径同一份派生代码，D4）；发布经 messageBus
 * stateSnapshot（'subagents' / 'workflows' typeKey，W12 语义延续）。
 *
 * [reload-closeout D2] 送达水位：published* 三字段 = 已发布快照（发布门基线）。发布判定 =
 * 当前派生快照 vs 已发布快照（逐 record 比对，equals 语义与 merge 域 helpers 同源），
 * publish 调用完成即推进——守卫失败 / bus 未注入 → publish 未发生 → 水位滞留 → 下轮
 * 触发（agent_settled / 15s 定时）diff 非空必补发；稳态快照==水位零帧。生命周期随本
 * cache：销毁（onSessionDisposed）同批清理、重注册新建空水位首发布；fullRebuild 只重置
 * 派生 Map，**水位存续**（re-merge 后对水位比对，内容不变零帧——cursor 自愈全量重拉
 * 发冗余帧的旧形态就此消除）。内存与派生缓存同构 ×2（SubagentRecord KB 级 × 打开 pane
 * 数，上限 MB-10MB 级，无单调累积）——设计 D2 已裁决可接受。
 */
export interface RecordEntriesCache {
  /** 最后已拉 entryId（增量游标）。null = 从未拉过（下次全量）。 */
  cursor: string | null
  /** subagent 派生缓存（subagentId → 最新快照记录）。 */
  subagents: Map<string, SubagentRecord>
  /** workflow 派生缓存（runId → 最新快照记录）。 */
  workflows: Map<string, WorkflowRunRecord>
  /**
   * plan 状态派生缓存（最后一条 plan-state entry 的投影，D1④）——publish diff 基线：
   * null = 从未派生过，或全量重建发现 plan-state entry 被外部清空（收敛归 null，见
   * mergePlanState 的 isFullRebuild 分支——增量批的「本批无 plan entry」不归 null，
   * 保持既有基线，GUI 端 isActive:false 是缺省语义）。
   */
  planState: PlanStateView | null
  /** 防抖定时器（null = 未在等待）。 */
  debounceTimer: ReturnType<typeof setTimeout> | null
  /** in-flight 拉取 promise（并发失效共享一次拉取，消除重复 RPC）。 */
  inflight: Promise<void> | null
  /**
   * [reload-closeout D2] 送达水位：已发布 subagents 快照（publish 完成后镜像派生缓存
   * id 集；引用共享安全——scan 每轮产新对象，旧引用不可变，equals 走字段级比对）。
   */
  publishedSubagents: Map<string, SubagentRecord>
  /** [reload-closeout D2] 送达水位：已发布 workflow run-state 投影（runId → 信号面三字段 + 步骤数）。 */
  publishedWorkflows: Map<string, PublishedWorkflowRunState>
  /** [reload-closeout D2] 送达水位：已发布 planState view（null = 从未发布过）。 */
  publishedPlanState: PlanStateView | null
}

/**
 * [reload-closeout D2] workflow run-state 水位投影：workflowUpdate 信号面（runId/status/
 * reason）+ 步骤数（GUI 步骤实时可见的 diff 维度，[步骤可见性修复 2026-09-14]——running
 * 中 trace 逐步落盘，若只比 status/reason（恒 running），GUI 详情的 agentCalls 整个 run
 * 期间收不到任何 reload 触发）。
 */
export interface PublishedWorkflowRunState {
  status: string
  reason?: string
  steps: number
}

/** get_entries RPC 响应的域内收窄（u-s4 EntriesSinceResult 同款先例，见 fetchRecordEntriesRound）。 */
type EntriesSinceResult = { data?: { entries?: unknown[]; leafId?: string | null } }

/** workflow 增量信号形状（session.workflowUpdate payload.update；status/reason/步骤数任一变化一条）。 */
interface WorkflowUpdateSignal {
  runId: string
  status: string
  reason?: string
}

/**
 * SessionRecords 装配依赖（窄注入，S5/D2 风格：deps 面构造期固定，messageBus 经
 * getter 每次调用动态读——与 Facade setter 晚期注入语义逐字等价）。
 */
export interface SessionRecordsDeps {
  /** pi 进程管理（getClient：缓存刷新 RPC + 动作命令的活跃 client 获取）。 */
  pm: IProcessManager
  /** session 存储端口（scanSessions：磁盘读侧的 session 文件路径解析）。 */
  sessionStore: ISessionStore
  /** sessions Map 存在性查询（publish 前销毁守卫：已销毁不 publish，防 bus 重建已 clearSession 的 entry）。 */
  hasSession(sessionId: string): boolean
  /** MessageBus 当前值（Facade setter 晚期注入，未注入时 null → 广播 no-op）。 */
  getMessageBus(): IMessageBus | null
  /**
   * [W4] 冷启动引擎发现回退（engines.json 缺失/损坏时）。缺省 = core 发现器三级
   * 扫描（L1 env TAIJI_AGENT_ENGINE_ROOTS / 宿主根 / L2 node 解析 / L3 config.json），
   * 与派发同源（设计 §3.4 投影面表「冷启动回退源单源化」）。测试注入 fake 隔离
   * 宿主 node_modules 的真实引擎包（零命中断言需要确定性空环境）。
   *
   * [W8] deprecated 死键 getExtensionPaths 已随构造点同批删除（本文件字段 +
   * session-service.ts 装配点）——W4 登记的保留期结束。
   */
  discoverEngines?(): string[]
  /**
   * [A1 接线] session cwd 查询（subagentAction 的 skill 注入 project 扫描基准，
   * skill-reload-nondestructive D7）——与 SkillRegistry.getSessionCwd 同源（lifecycle
   * 视图 cwd）。可选窄接口（形态对齐 SkillRegistrySessionService.getSessionCwd 先例，
   * 供测试省略）；生产组合根恒接线，缺省时注入退化为 global-only 映射。
   */
  getSessionCwd?(sessionId: string): string | undefined
}

/** JSON 落盘缩进（全仓 JSON_INDENT = 2 约定）。 */
const JSON_INDENT = 2

/**
 * [reload-closeout D2] 送达水位对账定时腿间隔（低频兜底；主路径 = agent_settled 腿秒级）。
 * 15s + 单轮耗时，对 G1「完成后 ≤30s 收敛」阈值留 2x 余量。稳态成本 = 每 15s 每「有
 * record 的 session」一次 get_entries(since) 空增量 RPC（pi 侧内存读非磁盘扫描，u0 已核）。
 */
export const RECORD_RECONCILE_INTERVAL_MS = 15_000

/**
 * [reload-closeout D2 实施期门①] 单轮对账（fetch→merge→publish）耗时红绿线：
 * ≤100ms/session/轮（u0 faux 基线 15ms，~6.7x 余量）。超限 warn = 重审触发线信号
 * （扫描域 session 数 > 10 或稳态单轮超线 → 重新校准定时间隔/扫描域，设计 D2）。
 */
export const RECORD_RECONCILE_ROUND_BUDGET_MS = 100

/**
 * [reload-closeout D2 重审触发线第二维度] 对账扫描域规模观测阈值：域内 session 数超过
 * 此值时 warn（跨阈值边沿触发一次，稳态持续超线不重复刷）。超线 = 定时间隔/扫描域需
 * 重新校准的信号——设计 D2 重审触发线两维度之一（另一维度 = 上方单轮耗时红线）。
 */
export const RECORD_RECONCILE_DOMAIN_SIZE_WARN_THRESHOLD = 10

/**
 * 定向消息文本的换行编码（composer 四符号 §3.3.3 / 探针 P3 转义协议）。
 *
 * 为什么编码：`/subagents message <id> <text>` 经 client.prompt 单行传输（pi 以首个
 * 空格拆命令名后取剩余全文，真实换行会破坏命令的单行性），故发送前把真实换行编码为
 * 字面 `\n` 两字符、原生反斜杠编码为 `\\`。
 *
 * 为什么连反斜杠一起转义：extension 侧 decodeNewlineEscapes（command-actions.ts）
 * 与本函数互逆——若只编码换行不编码反斜杠，原文里的字面反斜杠+n（如路径 `C:\new`）
 * 会被误解码成换行（歧义）。反斜杠先转义消除该歧义，两侧测试对三种原文
 * （字面 \n / 反斜杠 / 真实换行）钉死往返不变。
 */
export function encodeDirectiveText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

export class SessionRecords {
  /**
   * W18（data-source-governance P3.1）：per-session record entry 派生缓存——subagent /
   * workflow 列表的唯一 runtime 数据持有（entry 扫描结果纯派生，事件 payload 永不直写）。
   * 注册点 subscribe（onSessionRegistered，与 replicatedStates 同汇聚），销毁点
   * onSessionDisposed（清防抖定时器）。
   */
  private readonly recordEntriesCaches = new Map<string, RecordEntriesCache>()

  /**
   * [reload-closeout D2] 定时对账腿：服务级单例 timer（15s，unref 不钉住进程退出）。
   * 扫描域 = 持有非空派生缓存的已注册 session；域清零随 onSessionDisposed 检查停。
   * 与防抖失效路径 / agent_settled 腿的重入经 per-session inflight 合并（既有机制）。
   */
  private reconcileTimer: ReturnType<typeof setInterval> | null = null

  /**
   * [reload-closeout D2 重审触发线第二维度] 扫描域规模边沿状态（上次 sweep 是否已超
   * 阈值）——纯 bool 随服务实例生命周期，无需 dispose；边沿翻转才 warn，防止 15s 轮询
   * 稳态持续超线时刷屏。
   */
  private reconcileDomainOverThreshold = false

  constructor(
    private readonly deps: SessionRecordsDeps,
    // [A2 D-A2-1] skill 注入器：subagentAction message/start 的定向文本出站前统一
    // 处理（与 MessageDispatcher 同款「默认实例化 + 构造可替换」形态，测试注入 spy）。
    // [A1 接线] 默认源 = 晚绑定占位（SessionService 构造期 registry 尚不存在，组合根
    // 后绑；测试默认装配无标记文本不触达映射）。
    private readonly injector: SkillInjector = new SkillInjector(new LateBoundSkillSource()),
  ) {}

  /**
   * 组装期订阅接线（D2③「换订阅者」）：向 lifecycle 注册本模块的缓存注册 handler。
   * 注册顺序在 projection（播种）之后、reconciler 对账之前——lifecycle 按订阅顺序
   * 同步直发，与迁移前 Facade 订阅体内顺序逐一等价。
   */
  subscribe(source: SessionRegisteredSource): void {
    source.onSessionRegistered((sessionId) => {
      // W18：注册 record entry 派生缓存（不播种——首个 entry_appended 失效时全量拉取；
      // 激活后 renderer 的初始列表由 getSubagents/getWorkflows RPC 磁盘扫描承接，同 scan 函数）。
      this.ensureRecordEntriesCache(sessionId)
    })
  }

  /**
   * W18：自描述 record entry 失效信号唯一入口（interpreter 经组合根注入；entry_appended
   * 主信号 + subagent/workflow 事件兜底信号都汇于此）。
   *
   * 只做失效（防抖调度 markDirty 等价），事件 payload 不进数据缓存。防抖窗口内多次失效
   * 合并为一次增量拉取（自描述 entry append 频率 = record 状态迁移频率，防抖削峰）。
   * session 未激活（无缓存条目）时 no-op——冷启动路径由 getSubagents/getWorkflows RPC
   * 的磁盘扫描承接。
   */
  invalidateRecordEntries(sessionId: string, customType: string): void {
    // 第二道 customType 早退门（D1③）：与 event-adapter 白名单（第一道门）同批扩容——
    // 白名单放行而此处早退则 live 链静默 no-op（三道运行时字符串门之一，编译器不保护）。
    if (
      customType !== SUBAGENT_RECORD_CUSTOM_TYPE &&
      customType !== WORKFLOW_RECORD_CUSTOM_TYPE &&
      customType !== PLAN_STATE_CUSTOM_TYPE
    ) {
      return
    }
    const cache = this.recordEntriesCaches.get(sessionId)
    if (!cache) return
    if (cache.debounceTimer !== null) return // 已在防抖等待中：合并
    cache.debounceTimer = setTimeout(() => {
      cache.debounceTimer = null
      void this.refreshRecordEntries(sessionId)
    }, SCALAR_STATE_DEBOUNCE_MS)
  }

  /**
   * [reload-closeout D2] 送达水位对账腿入口（agent_settled 触发，interpreter 经组合根
   * 注入 onRecordReconcile → Facade 委托到达）。对账没有第二实现——重跑同一条
   * fetch→merge→publish 管线（refreshRecordEntries），发布门 = 已发布快照水位：fetch
   * 空增量、merge 信号恒空时水位 diff 仍非空 → 补发（merge 信号基线对「merge 已对、
   * 发布跳丢」的事故主形态 diff 恒空的失明就此消除）。fire-and-forget；与在途防抖拉取
   * 经 inflight 合并。扫描域门（纯聊天 session 天然排除）：缓存非空（曾出现 record）
   * 才对账。⛔ 本腿不走 getSubagents 磁盘路径（全目录扫 32MB 上限，设计 D2 硬约束）。
   */
  reconcileRecordEntries(sessionId: string): void {
    const cache = this.recordEntriesCaches.get(sessionId)
    if (!cache || !isInReconcileDomain(cache)) return
    void this.refreshRecordEntries(sessionId).catch((e) => {
      // 恢复指引（设计 §3.1 场景 B / §3.4 错误规格「日志含恢复指引」）：数据目录可读性
      // 是该腿失败的常见根因；W18 失效链全量重拉是既有兜底路径，指给排障者。
      console.warn(
        `[session-service] record reconcile round failed for ${sessionId}: ${toErrorMessage(e)}`
        + ` — recovery: check readability of the sessions/ directory under the session data dir;`
        + ` next session start re-pulls full records via the W18 invalidation chain as fallback`,
      )
    })
  }

  /** 取/建 per-session record entry 派生缓存（subscribe 注册点调用；水位随 cache 新建为空）。 */
  private ensureRecordEntriesCache(sessionId: string): RecordEntriesCache {
    const existing = this.recordEntriesCaches.get(sessionId)
    if (existing) return existing
    const cache: RecordEntriesCache = {
      cursor: null,
      subagents: new Map(),
      workflows: new Map(),
      planState: null,
      debounceTimer: null,
      inflight: null,
      publishedSubagents: new Map(),
      publishedWorkflows: new Map(),
      publishedPlanState: null,
    }
    this.recordEntriesCaches.set(sessionId, cache)
    return cache
  }

  /**
   * W18：get_entries 拉取编排（cursor 三路径见 RecordEntriesCache 注释）。
   *
   * 拉取 → scanSubagentEntries / scanWorkflowEntries（与冷启动同一份派生代码）→ merge
   * 派生 Map → 发布门 = 送达水位（[reload-closeout D2] session.subagents 全量帧 /
   * session.workflowUpdate 增量信号 / session.planState 全量帧，水位 diff 差异集构造）。
   * 失败语义：Entry not found → 丢 cursor 就地重试一次全量自愈（两轮上限，防坏 pi 反复全量）；
   * 其他 RPC 错误 → warn 后保留 cursor（下次失效重试仍走增量），不发布（快照未变）。
   */
  private async refreshRecordEntries(sessionId: string): Promise<void> {
    const cache = this.recordEntriesCaches.get(sessionId)
    if (!cache) return
    if (cache.inflight) return cache.inflight // 并发失效共享一次拉取
    const run = async (): Promise<void> => {
      const startedAt = Date.now()
      try {
        const client = this.deps.pm.getClient(sessionId)
        if (!client) return // session 已死：缓存冻结（onSessionDisposed 会清），冷启动走磁盘路径
        // 两轮：第 1 轮按 cursor 增量；Entry not found 丢 cursor 后第 2 轮全量自愈
        const MAX_REFRESH_ROUNDS = 2
        for (let round = 0; round < MAX_REFRESH_ROUNDS; round++) {
          let fetched: { entries: unknown[]; leafId: string | undefined; fullRebuild: boolean }
          try {
            fetched = await this.fetchRecordEntriesRound(client, cache)
          } catch (e) {
            if (cache.cursor !== null && isEntryNotFoundError(e)) {
              // 游标失效自愈：since 指向的 entry 不在 pi 当前集合 → 丢 cursor 全量重拉重建
              console.warn(`[session-service] record entries incremental Entry-not-found for ${sessionId}, dropping cursor and full rebuild`)
              cache.cursor = null
              continue
            }
            // 其他错误（超时 / pi 内部错误）：不发布（快照未变），cursor 保留，下次失效重试仍走增量
            console.warn(`[session-service] refresh record entries via getEntries failed for ${sessionId}: ${toErrorMessage(e)}`)
            return
          }
          this.applyRecordEntries(cache, fetched.entries, sessionId, fetched.fullRebuild)
          if (fetched.leafId !== undefined) cache.cursor = fetched.leafId
          return
        }
      } finally {
        // [reload-closeout D2 实施期门①] 单轮红绿线观测：fetch→merge→publish 全程计时
        // （u0 基线 15ms），超线 warn = 重审触发线信号（定时间隔/扫描域重校准依据）。
        const elapsedMs = Date.now() - startedAt
        if (elapsedMs > RECORD_RECONCILE_ROUND_BUDGET_MS) {
          console.warn(`[session-service] record refresh round took ${elapsedMs}ms for ${sessionId} (budget ${RECORD_RECONCILE_ROUND_BUDGET_MS}ms) — profiling red line exceeded, recalibration trigger`)
        }
        // [reload-closeout D2] 派生内容落缓存后同步定时腿起停（域非空起、域空停）
        this.syncReconcileTimer()
      }
    }
    cache.inflight = run().finally(() => { cache.inflight = null })
    return cache.inflight
  }

  // ── [reload-closeout D2] 定时对账腿（15s 服务级单例 timer）──

  /**
   * 扫描域内逐 session 重跑对账管线（refreshRecordEntries，发布门 = 水位）。
   * 实施期门③：cursor=null（未首拉 / 自愈待全量）本轮跳过——cursor 失效全量重建的 RPC
   * 路径无 oversize 保护（32MB 预检只在磁盘路径），高频定时撞自愈会放大；跳过后等
   * agent_settled 腿走正常全量路径。
   */
  private runReconcileSweep(): void {
    try {
      const domain = this.reconcileScanDomain()
      // [reload-closeout D2 重审触发线第二维度] 扫描域规模观测（此前仅耗时红线单维度，
      // 「扫描域 session 数 > 10」零观测）：跨阈值边沿 warn 一次，稳态持续超线不重复刷；
      // 措辞与单轮耗时红线同族（recalibration trigger）。域空时 overThreshold 恒 false，
      // 边沿自然回落，下次重超线会再次 warn。
      const overThreshold = domain.length > RECORD_RECONCILE_DOMAIN_SIZE_WARN_THRESHOLD
      if (overThreshold && !this.reconcileDomainOverThreshold) {
        console.warn(
          `[session-service] record reconcile sweep domain grew to ${domain.length} sessions`
          + ` (threshold ${RECORD_RECONCILE_DOMAIN_SIZE_WARN_THRESHOLD})`
          + ` — scan-domain red line exceeded, recalibration trigger`,
        )
      }
      this.reconcileDomainOverThreshold = overThreshold
      if (domain.length === 0) {
        this.stopReconcileTimer()
        return
      }
      for (const sessionId of domain) {
        const cache = this.recordEntriesCaches.get(sessionId)
        if (!cache) continue
        if (cache.cursor === null) continue // 实施期门③
        void this.refreshRecordEntries(sessionId).catch((e) => {
          // 恢复指引与 agent_settled 腿（reconcileRecordEntries）同款，两处保持一致。
          console.warn(
            `[session-service] record reconcile round failed for ${sessionId}: ${toErrorMessage(e)}`
            + ` — recovery: check readability of the sessions/ directory under the session data dir;`
            + ` next session start re-pulls full records via the W18 invalidation chain as fallback`,
          )
        })
      }
    } catch (e) {
      // 定时器单轮 try 围栏：异常不杀 timer，下轮恢复（对账循环自身挂死处置，§3.4）
      console.warn(`[session-service] record reconcile sweep failed: ${toErrorMessage(e)}`)
    }
  }

  /** 扫描域 = 持有非空派生缓存（任一家族有内容）的已注册 session。 */
  private reconcileScanDomain(): string[] {
    const ids: string[] = []
    for (const [sessionId, cache] of this.recordEntriesCaches) {
      if (isInReconcileDomain(cache)) ids.push(sessionId)
    }
    return ids
  }

  /** 水位门起停幂等同步：域非空确保 timer 在跑、域空停（销毁/清域检查点调用）。 */
  private syncReconcileTimer(): void {
    if (this.reconcileScanDomain().length > 0) this.ensureReconcileTimer()
    else this.stopReconcileTimer()
  }

  private ensureReconcileTimer(): void {
    if (this.reconcileTimer !== null) return
    const timer = setInterval(() => this.runReconcileSweep(), RECORD_RECONCILE_INTERVAL_MS)
    // unref：对账兜底腿不得钉住进程退出（fake-timers 环境无 unref，存在性守卫跳过）
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
    this.reconcileTimer = timer
  }

  private stopReconcileTimer(): void {
    if (this.reconcileTimer === null) return
    clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
  }

  /**
   * W18：单轮 get_entries 拉取——按 cursor 有无分流增量/全量（fullRebuild 随返回值上浮，
   * 供 plan 收敛语义分流，见 mergePlanState）。
   * 全量重建时 Map 族派生缓存整体重置（纯派生语义——全量扫描结果就是新基线）；plan 基线
   * **不**在此复位：「重建前基线」正是 entry 被外部清空时收敛发布的 diff 依据，复位会把
   * 基线抹成 null 使收敛分支失去触发条件，语义由 mergePlanState 的 isFullRebuild 分支承接。
   *
   * 响应收窄（u-s4 EntriesSinceResult 同款先例）：entries 零字段消费——整体透传
   * scanSubagentEntries / scanWorkflowEntries（unknown[] 形参）。
   */
  private async fetchRecordEntriesRound(
    client: IPiEngine,
    cache: RecordEntriesCache,
  ): Promise<{ entries: unknown[]; leafId: string | undefined; fullRebuild: boolean }> {
    if (cache.cursor !== null) {
      const inc = await client.getEntries(cache.cursor) as EntriesSinceResult
      return { entries: inc.data?.entries ?? [], leafId: inc.data?.leafId ?? undefined, fullRebuild: false }
    }
    const full = await client.getEntries() as EntriesSinceResult
    cache.subagents.clear()
    cache.workflows.clear()
    return { entries: full.data?.entries ?? [], leafId: full.data?.leafId ?? undefined, fullRebuild: true }
  }

  /**
   * 扫描结果 merge 入派生缓存 + 水位发布。
   *
   * [reload-closeout D2] 发布门基线 = 送达水位（已发布快照），非 merge 变化信号——补发
   * 主形态（fetch 空增量、merge 信号恒空）下沿用 merge 信号则无帧可发，恰好复刻 v1 缺陷。
   * merge 只写派生缓存（数据写路径唯一）；守卫/发布门处丢帧 = 水位滞留 → 对账腿补发。
   *
   * - subagents：派生快照 vs 已发布快照逐 record 比对（subagentRecordEquals），差异 →
   *   publish session.subagents 全量帧（payload = 派生缓存快照数组）。
   * - workflows：按水位差异 run 构造 session.workflowUpdate 增量信号（新 run / status /
   *   reason / 步骤数任一变化一条）——发布序 = 派生 Map 迭代序（新 run 与扫描序一致）。
   * - plan（D1④）：单例状态（最后一条 plan-state entry 派生）与已发布 View 比对
   *   （planStateEquals），差异 publish session.planState 全量帧（shared 协议
   *   `{ sessionId, planState }`）；派生 null 的全量/增量收敛语义在 mergePlanState
   *   （增量批保持基线；全量重建基线非 null 且全集无 plan entry → 归 null 收敛发布，
   *   由水位的 null ↔ View 差异自然触发）。
   */
  private applyRecordEntries(
    cache: RecordEntriesCache,
    entries: unknown[],
    sessionId: string,
    isFullRebuild: boolean,
  ): void {
    // 三家族（subagents / workflows / plan）同批扫描 + merge（同一份 entries，零额外 RPC），
    // merge 语义下沉到下方模块级 merge helper。merge 先于 publish 守卫执行（已销毁
    // session 也完成缓存 merge，只拦发布——D3 登记卫生债，水位机制下无害：publish 未
    // 发生 → 水位滞留 → session 恢复后下轮触发补发）。
    mergeSubagentRecords(cache.subagents, scanSubagentEntries(entries))
    mergeWorkflowRecords(cache.workflows, scanWorkflowEntries(entries))
    mergePlanState(cache, scanPlanStateEntries(entries), isFullRebuild)

    if (!this.deps.hasSession(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    this.publishRecordChanges(cache, sessionId)
  }

  /**
   * [reload-closeout D2] merge 完成后的水位发布。**补发帧构造来源 = 水位 diff 差异集**
   * （subagents/planState 整帧重发；workflowUpdate 按差异 run 构造信号）；帧形态与发布
   * 顺序（subagents → workflowUpdate → planState）与水位门前逐一等价。
   *
   * 水位推进 = bus 非 null + publish 调用完成即推进（hasSession 守卫在调用方；publish
   * 三条内部失败路径——序列化失败/出站守卫 drop/ws.send 被吞——均不向调用方抛错，断连
   * 空投照样完成调用，u0 校准维持「调用完成即推进」，不因 bus 内部跳下移）。bus 未注入
   * → publish 短路且水位滞留（真实可观测的滞留形态），等对账腿补发。
   */
  private publishRecordChanges(cache: RecordEntriesCache, sessionId: string): void {
    const bus = this.deps.getMessageBus()
    if (!bus) return // bus 未注入窗口：不发布不推进（水位滞留，下轮触发补发）

    if (subagentsDifferFromPublished(cache.subagents, cache.publishedSubagents)) {
      bus.publish(sessionId, {
        type: 'session.subagents',
        payload: { sessionId, subagents: Array.from(cache.subagents.values()) },
      })
      cache.publishedSubagents = new Map(cache.subagents) // publish 完成即推进（镜像当前派生 id 集）
    }

    const workflowSignals = workflowSignalsAgainstPublished(cache.workflows, cache.publishedWorkflows)
    for (const update of workflowSignals) {
      bus.publish(sessionId, {
        type: 'session.workflowUpdate',
        payload: { sessionId, update },
      })
    }
    if (workflowSignals.length > 0) {
      cache.publishedWorkflows = projectPublishedWorkflowStates(cache.workflows)
    }

    if (planStateDiffersFromPublished(cache.planState, cache.publishedPlanState)) {
      bus.publish(sessionId, {
        type: 'session.planState',
        payload: { sessionId, planState: cache.planState ?? INACTIVE_PLAN_STATE_VIEW },
      })
      cache.publishedPlanState = cache.planState
    }
  }

  async getSubagents(sessionId: string): Promise<SubagentRecord[]> {
    // 找主 session 文件路径（scanSessions 扫 <agentDir>/sessions/，含 cwd-encoded 子目录）。
    // wave:perf-w26（plan M-3）：路径解析消费方 force 旁路 TTL（刚落盘 session 的
    // subagent 面板在窗口内不静默返回空）。
    const target = this.deps.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
    if (!target) return []
    // [G3] extractor 预检降级：oversize（>32MB）时 records 恒空（extraction 骨架内
    // console.warn 留痕）。oversize 正交标志在此解构时被丢弃、全仓无消费方——
    // 「会话过大」侧栏降级提示的协议/UI 接线未实施（impl-plan 偏差登记），
    // oversize 超限时 subagent 面板表现为空列表。
    const { records } = extractSubagentsFromSessionFile(target.filePath)
    return records
  }

  /**
   * subagent 对话流历史（record.sessionFile 直读）。
   *
   * u4b（D5①）：底座 getHistoryFromFilePath 对超 READ_PRECHECK_MAX_BYTES（32MB）的
   * 巨型 subagent JSONL（高发源）走逆序分块读最近预算窗口 + truncated 标记（不拒绝）。
   */
  async getSubagentHistory(sessionId: string, subagentId: string): Promise<HistoryFileReadResult> {
    // 先从主 session 提取 subagent 列表，找到 sessionFile 路径
    const subagents = await this.getSubagents(sessionId)
    const record = subagents.find((s) => s.subagentId === subagentId)
    if (!record) return { messages: [], truncated: false }

    // P5 分协议路由：非 pi 引擎（record.engine 字段路由，缺省 pi）走 extractor 的
    // 三级降级读取链（①引擎原生 reader ②journal ③outcome-only）。pi 的现有直读链
    // 零变化（A1 守护）
    const engine = extractRecordEngine(record)
    if (engine !== DEFAULT_SUBAGENT_ENGINE) {
      return { messages: await readEngineSubagentHistory(record, getDataDir()), truncated: false }
    }

    if (!record.sessionFile) return { messages: [], truncated: false }

    // 路径穿越校验：sessionFile 必须严格落在 piAgentDir 下（<dataDir>/agent/）。
    // record.sessionFile 由 subagent-extractor 从 JSONL 文本提取，不可信——攻击者构造的
    // session JSONL 可塞入任意路径（如 /etc/passwd），不校验直接读会泄露任意文件内容。
    if (!isStrictlyUnder(getPiAgentDir(), record.sessionFile)) return { messages: [], truncated: false }

    // 直读 subagent JSONL，复用 getHistoryFromFilePath 转换链路（parseJsonl + filter + convertHistory）。
    // subagent JSONL 格式与主 session 一致（pi SessionManager._persist 写入）。
    return getHistoryFromFilePath(record.sessionFile, this.deps.sessionStore)
  }

  /**
   * [U7] 子代理引擎配置视图：engines.json（extension 权威写入的动态引擎列表）+
   * config.json defaultEngine（extension ModelConfigService 读同一文件）。
   * 纯磁盘读取，Settings 冷启动（无活跃 session）也可用。
   *
   * 回退链（[W4] 冷启动回退源单源化，设计 §3.4 投影面表）：engines.json 缺失/损坏
   * → **runtime 自身三级发现**（discoverEngines 回退，与派发同源）。不保留静态 JSON
   * 兜底（H5 后扩展包 taiji.subagentEngines 声明已废弃）：零命中返回空清单——
   * 静态声明列出的 id 无 bin 可执行，会造成「能选不能跑」，与「不可用引擎不进清单」
   * 投影规则冲突；GUI 按既有语义对清单外派发给 engine_not_found + 安装指引。
   */
  async getSubagentEngineConfig(): Promise<SubagentEngineConfigView> {
    const subagentsDir = join(getPiAgentDir(), 'subagents')
    let engines: string[] | undefined
    try {
      const raw = readFileSync(join(subagentsDir, SUBAGENTS_ENGINES_FILENAME), 'utf8')
      const parsed = JSON.parse(raw) as Partial<SubagentEnginesFile>
      if (Array.isArray(parsed.engines) && parsed.engines.every((e) => typeof e === 'string') && parsed.engines.length > 0) {
        engines = parsed.engines
      }
    } catch (e) {
      // 缺失/损坏 → runtime 自身发现回退
      console.warn(`[session-service] read engines.json failed, falling back to runtime discovery: ${toErrorMessage(e)}`)
    }
    if (engines === undefined) {
      engines = this.readDiscoveredEnginesFallback()
    }
    let defaultEngine = 'pi'
    try {
      const conf = JSON.parse(readFileSync(join(subagentsDir, 'config.json'), 'utf8')) as { defaultEngine?: unknown }
      if (typeof conf.defaultEngine === 'string' && conf.defaultEngine.trim() !== '') {
        defaultEngine = conf.defaultEngine.trim()
      }
    } catch (e) {
      // 无 config / 坏 JSON → 缺省 pi（extension 侧同缺省语义）
      console.warn(`[session-service] read subagents config.json failed, defaulting engine to pi: ${toErrorMessage(e)}`)
    }
    return { engines, defaultEngine }
  }

  /**
   * [W4] 冷启动发现回退：runtime 自身三级发现（core 发现器），清单 = 已发现且可执行
   * 的引擎 id（发现即装载进注册表——W8 宿主接线后 runtime 派发同源消费）。失败或
   * 零命中返回空清单（无静态 JSON 兜底，§3.4 投影面表）。
   */
  private readDiscoveredEnginesFallback(): string[] {
    const discover = this.deps.discoverEngines ?? defaultRuntimeEngineDiscovery
    try {
      return discover()
    } catch (e) {
      console.warn(`[session-service] runtime engine discovery failed, returning empty engine list: ${toErrorMessage(e)}`)
      return []
    }
  }

  /**
   * [U7] 设置全局默认子代理引擎：读改写 config.json（保留其他字段）+ tmp+rename 原子写。
   * engineId 校验：engines.json 清单内才允许（防 GUI 端把未知引擎写进配置）。
   *
   * 🔒 跨进程锁（C-data-09）：config.json 与 agent bash 写（subagent-ext-config skill
   * 指导）、用户手编构成多写方——RMW 全程持 withFileLockSync（lockfile = config.json.lock，
   * 协议对齐 ext-config-rmw ext-config / settings.json 先例）。锁失败 fail-fast
   * 抛错（ELOCKED，预算 1s），经 RPC 错误通路返回 GUI。不取锁的 bash/手编写方作为
   * last-write-wins 残余风险由 data-source-registry.md §6 登记。
   */
  async setSubagentDefaultEngine(engineId: string): Promise<void> {
    const view = await this.getSubagentEngineConfig()
    if (!view.engines.includes(engineId)) {
      throw new Error(`unknown subagent engine '${engineId}' (available: ${view.engines.join(', ')})`)
    }
    const configPath = join(getPiAgentDir(), 'subagents', 'config.json')
    withFileLockSync(configPath, () => {
      let conf: Record<string, unknown> = {}
      try {
        conf = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      } catch {
        // 无既有配置 → 新建（extension 读侧对缺字段的容忍与 DEFAULT_CONFIG 对齐）
        conf = {}
      }
      if (conf['defaultEngine'] === engineId) return
      conf['defaultEngine'] = engineId
      // subagents 目录无需再建：withFileLockSync 取锁前已兜底 mkdir dirname(configPath)
      // （无锁时代这行 mkdir 承重，引入锁后成为死代码）。原子写单点走 fs-utils.atomicWrite
      // （tmp+rename）；写失败时 .tmp 残留不被清理——与 ext-config-rmw ext-config
      // 先例同款取舍，磁盘孤儿文件无害，不在此另复制一份清理逻辑
      atomicWrite(configPath, JSON.stringify(conf, null, JSON_INDENT), `${process.pid}-${Date.now()}`)
    })
  }

  /**
   * 获取 session 派生的 workflow 列表（从主 session JSONL 的 workflow-state-link 提取）。
   * 纯磁盘读取，不依赖 pi 进程活跃。文件不存在或无 workflow 调用时返回空数组。
   */
  async getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]> {
    // wave:perf-w26（plan M-3）：路径解析消费方 force 旁路 TTL（与 getSubagents 同理）。
    const target = this.deps.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
    if (!target) return []
    // [G3] extractor 预检降级：与 getSubagents 同款（oversize → 空列表 + 骨架 warn；
    // oversize 标志同样在此丢弃、无消费方）。
    const { records } = extractWorkflowsFromSessionFile(target.filePath)
    return records
  }

  /**
   * 获取 session 的 plan 模式状态投影（plan 模式重设计 D1⑥ 冷腿，供 session.getPlanState
   * RPC handler 调用；u1-rpc 接线）。
   *
   * 纯磁盘读取，不依赖 pi 进程活跃——冷启动首拉 / 切换首拉与 live 投影（refreshRecordEntries
   * → scanPlanStateEntries）共用同一份派生代码（D1「派生代码唯一」不变量）。文件不存在、
   * 无 plan-state entry 等「从未进过 plan」形态归一为「未激活」缺省 View（INACTIVE_PLAN_STATE_VIEW，
   * 对齐 extension DEFAULT_PLAN_STATE——RPC reply 契约 planState 无 null 域，GUI 端
   * isActive:false 即不渲染横幅）。
   */
  async getPlanState(sessionId: string): Promise<PlanStateView> {
    // 路径解析消费方 force 旁路 TTL（与 getSubagents/getWorkflows 同理：刚落盘 session 的
    // plan 面板首拉在窗口内不静默返回空）。
    const target = this.deps.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
    if (!target) return INACTIVE_PLAN_STATE_VIEW
    return extractPlanStateFromSessionFile(target.filePath)
  }

  /**
   * 获取 workflow 内 agent call 的对话流历史。
   *
   * agentCallSessionId 是 trace[].sessionId。agent call 本质是 subagent（D4）：
   * trace[].sessionId 存的是 subagent record id（sa-xxx），不是 pi session uuidv7，
   * 故复用 getSubagentHistory 的 record 查找路径（subagentId → 主 session JSONL 的
   * record.sessionFile）直读，不按 header.id 扫 subagents 目录（sa-xxx 永远不匹配
   * uuidv7 header——历史上曾按目录扫描，2026-08-14 修正）。
   *
   * 找不到 record 返回 []（前端显空对话流）。
   */
  async getAgentCallHistory(sessionId: string, agentCallSessionId: string): Promise<HistoryFileReadResult> {
    return this.getSubagentHistory(sessionId, agentCallSessionId)
  }

  /**
   * 解析 agent call 对话流 JSONL 绝对路径（record.sessionFile 直查）。
   *
   * 与 getAgentCallHistory 的区别：找不到时返回空串而非 throw——这是展示型功能
   *（PanelHeader overlay 文件名），找不到路径不应阻断 UI，前端 v-if 据空串隐藏按钮。
   */
  async getAgentCallFilePath(sessionId: string, agentCallSessionId: string): Promise<string> {
    // 同 getAgentCallHistory：agent call 是 subagent，trace.sessionId 是 subagentId（sa-xxx），
    // 复用 record 查找（subagentId → record.sessionFile），不扫目录按 header.id 匹配。
    const subagents = await this.getSubagents(sessionId)
    const record = subagents.find((s) => s.subagentId === agentCallSessionId)
    if (!record?.sessionFile) return ''
    if (!isStrictlyUnder(getPiAgentDir(), record.sessionFile)) return ''
    return record.sessionFile
  }

  /**
   * 触发 workflow 生命周期操作（abort；pause/resume 已随扩展 D-2 一次性生命周期移除）。
   * 经 client.prompt("/workflows <action> <runId>") 调扩展 slash command，
   * pi 检测 / 开头直接执行 command handler（不经 LLM）。
   * 扩展侧 RPC 分支已实现（commands.ts ctx.mode==='rpc'）。
   */
  async workflowAction(sessionId: string, action: 'abort', runId: string): Promise<void> {
    const client = this.deps.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not active`)
    await client.prompt(`/workflows ${action} ${runId}`)
  }

  /**
   * subagent 生命周期/定向消息操作（经扩展 slash command，不经 LLM）。
   * 对称 workflowAction 的转发模式：client.prompt("/subagents <action> ...")。
   * 扩展侧 RPC 分支解析（command-actions.ts parseSubagentRpcCommand）：
   * - cancel：<subagentId>（service.cancel → SIGTERM kill 子进程）
   * - message：<subagentId> <text>（subagent 续聊，热路径 stdin 直写 prompt）
   * - start：<slug> <task>（新 subagent——modeless 万物可续，续聊资格由引擎能力轴把关）
   * text/task 经 encodeDirectiveText 编码（换行 → 字面 \n，命令保持单行）；
   * [A2 MF-B] text/task 含 skill 标记时先经 SkillInjector 展开（encode 之前，见分支内
   * 注释），失效标记透传 + skillNotice 提示（与主链同款，不再静默）。
   *
   * 刻意直接 client.prompt 绕过 dispatcher busy 预检 / BeforeSend hook（对称
   * promptReload 的绕过模式）：定向消息必须「主 agent 生成中也能发」（设计 §3.3.4
   * 直达目标），且 hook 审核的是主 agent prompt，不适用于 subagent 定向文本。
   */
  async subagentAction(
    sessionId: string,
    action: 'cancel' | 'message' | 'start',
    params: { subagentId?: string; text?: string; slug?: string; task?: string },
  ): Promise<void> {
    const client = this.deps.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not active`)
    if (action === 'cancel') {
      // 错误指向恢复动作：字段缺失是调用方协议错误，fail-fast 让 WS error envelope 暴露
      if (!params.subagentId) throw new Error('[session-service] subagentAction cancel: subagentId is required')
      await client.prompt(`/subagents cancel ${params.subagentId}`)
      return
    }
    if (action === 'message') {
      if (!params.subagentId || !params.text) {
        throw new Error('[session-service] subagentAction message: subagentId and text are required')
      }
      // [A2 MF-B] skill 注入（D-A2-1）：encodeDirectiveText 之前对原始 text 注入——标记在
      // 原始文本上匹配（encode 只转义 \ 与换行，先 encode 会破坏标记属性的可读性且无必要）；
      // 注入产物的真实换行由随后的 encode 编码回单行。无标记 no-op 零 RPC 原文通过；
      // cancel/workflows 内部命令不挂（设计显式跳过，守卫白名单登记）。
      // [A1 接线] session cwd 作 project 扫描基准（D7）。
      const injection = await this.injector.inject(client, params.text, this.deps.getSessionCwd?.(sessionId))
      await client.prompt(`/subagents message ${params.subagentId} ${encodeDirectiveText(injection.text)}`)
      // [D-A2-2] notice 在发送成功后发布（与 dispatcher 时机契约同款）；prompt 失败路径
      // throw 不发。定向文本无 u- 标记 → skillNotice 的 clientUuid 缺省（类型可空）。
      publishSkillNotices(this.deps.getMessageBus(), sessionId, params.text, injection.notices)
      return
    }
    if (!params.slug || !params.task) {
      throw new Error('[session-service] subagentAction start: slug and task are required')
    }
    // [A2 MF-B] 同 message 分支：start 的 task 是用户内容（composer @ 定向首发），encode 前注入。
    const injection = await this.injector.inject(client, params.task, this.deps.getSessionCwd?.(sessionId))
    await client.prompt(`/subagents start ${params.slug} ${encodeDirectiveText(injection.text)}`)
    publishSkillNotices(this.deps.getMessageBus(), sessionId, params.task, injection.notices)
  }

  // ── 销毁清理（Facade removeSessionEntry 第 ⑤ 步直调，与 TraceSync/SessionStateProjection.onSessionDisposed 并列）──

  /**
   * W18：销毁 record entry 派生缓存（主动删 + 进程退出汇聚点）。停防抖定时器
   * （在途 inflight 的拉取完成后 applyRecordEntries 的 hasSession 守卫拦住发布，
   * 不复活已清 bus 条目）。[reload-closeout D2] 送达水位随 cache 同批清理；扫描域
   * 清零随本处检查停对账定时器。
   */
  onSessionDisposed(sessionId: string): void {
    const cache = this.recordEntriesCaches.get(sessionId)
    if (cache) {
      if (cache.debounceTimer !== null) clearTimeout(cache.debounceTimer)
      this.recordEntriesCaches.delete(sessionId)
      this.syncReconcileTimer()
    }
  }
}

// ── record 家族 merge helpers（applyRecordEntries 拆出：每家族「merge 进派生缓存」一个
// 副作用单元——数据写路径唯一；[reload-closeout D2] merge 不再返回变化信号，发布门 =
// 送达水位，diff 在下方 watermark helpers）──

/**
 * subagent 记录 merge 进派生缓存（同 id 后到覆盖）。
 * [reload-closeout D2] 不再返回变化信号——发布判定移驻 subagentsDifferFromPublished
 * （对已发布快照比对；对派生缓存自身比对的 merge 信号对「merge 已对、发布跳丢」形态
 * diff 恒空，是 v1 失明根因）。
 */
function mergeSubagentRecords(subagents: Map<string, SubagentRecord>, records: SubagentRecord[]): void {
  for (const record of records) {
    subagents.set(record.subagentId, record)
  }
}

/**
 * workflow 记录 merge 进派生缓存（同 runId 后到覆盖）。
 * [reload-closeout D2] 增量信号不再在 merge 时收集（补发主形态下 fetch 空增量、merge
 * 信号恒空——沿用则无帧可发），信号构造移驻 workflowSignalsAgainstPublished（按水位
 * 差异 run 构造；status/reason/步骤数三维度语义原样保留，见 PublishedWorkflowRunState）。
 */
function mergeWorkflowRecords(workflows: Map<string, WorkflowRunRecord>, records: WorkflowRunRecord[]): void {
  for (const record of records) {
    workflows.set(record.runId, record)
  }
}

/**
 * plan 派生 merge（单例状态，D1④）：写 cache.planState 基线。
 *
 * [MF-1] 派生 null（本批/本次扫描窗口内无 plan-state entry）按 isFullRebuild 分流——
 * JSONL append-only 下 entry 不会消失，「null = entry 被清空」的收敛只对全量重建路径
 * 合法（全集扫描即新真值）；增量批（cursor delta）的 null 仅表示本批无 plan 新信息
 * （subagent/workflow record entry 触发的重拉批必然不含 plan entry），必须保持基线，
 * 否则活跃 plan 的 GUI（横幅/审批条/产物面板）会被无关 record 增量重拉静默打回未激活。
 * 派生非 null 恒写基线。发布与否由水位门判定（planStateDiffersFromPublished：基线归
 * null 的收敛 = 已发布 View ↔ null 的水位差异，自然触发缺省 View 收敛帧）。
 */
function mergePlanState(cache: RecordEntriesCache, planState: PlanStateView | null, isFullRebuild: boolean): void {
  if (planState === null) {
    // 增量批：null = 本批无 plan 新信息，保持基线。全量重建：基线非 null 且全集无
    // plan entry = entry 被外部清空 → 归 null（收敛发布由水位 diff 承接）。
    if (isFullRebuild && cache.planState !== null) {
      cache.planState = null
    }
    return
  }
  cache.planState = planState
}

// ── [reload-closeout D2] 送达水位 diff helpers（发布门基线 = 已发布快照；equals 语义
// 与 merge 域同源：subagentRecordEquals / planStateEquals / run-state 三维度）──

/**
 * subagents 水位 diff：新增 / 消失 / 任一 record 字段级不等（subagentRecordEquals）→
 * 整帧重发。size 先行判消失（advance 时镜像当前 id 集，等 size + 全量逐 record 相等
 * 即无差异）。
 */
function subagentsDifferFromPublished(current: Map<string, SubagentRecord>, published: Map<string, SubagentRecord>): boolean {
  if (current.size !== published.size) return true
  for (const [id, record] of current) {
    const prev = published.get(id)
    if (prev === undefined || !subagentRecordEquals(prev, record)) return true
  }
  return false
}

/**
 * workflows 水位 diff：按差异 run 构造增量信号（新 run / status / reason / 步骤数任一
 * 变化一条）。run 消失（fullRebuild 后全集不再含该 run）不构造信号——信号面无删除形态，
 * 硬造旧状态帧只会发 stale 信息；消费端由下次真实变化或冷拉收敛。
 */
function workflowSignalsAgainstPublished(current: Map<string, WorkflowRunRecord>, published: Map<string, PublishedWorkflowRunState>): WorkflowUpdateSignal[] {
  const updates: WorkflowUpdateSignal[] = []
  for (const [runId, record] of current) {
    const prev = published.get(runId)
    if (prev === undefined || prev.status !== record.status || prev.reason !== record.reason ||
        prev.steps !== record.agentCalls.length) {
      updates.push({ runId, status: record.status, reason: record.reason })
    }
  }
  return updates
}

/** workflow 水位投影（推进时镜像当前派生 run-state：信号面三字段 + 步骤数 diff 维度）。 */
function projectPublishedWorkflowStates(workflows: Map<string, WorkflowRunRecord>): Map<string, PublishedWorkflowRunState> {
  const projected = new Map<string, PublishedWorkflowRunState>()
  for (const [runId, record] of workflows) {
    projected.set(runId, { status: record.status, reason: record.reason, steps: record.agentCalls.length })
  }
  return projected
}

/**
 * planState 水位 diff：null == null 无变化（从未发布且从未派生）；null ↔ View 是真变化
 * （首发 / 全量重建收敛）；View vs View 走 planStateEquals（发布帧的 null → 缺省 View
 * 归一在 publishRecordChanges 完成，水位保持 null | View 双态参与比对）。
 */
function planStateDiffersFromPublished(current: PlanStateView | null, published: PlanStateView | null): boolean {
  if (current === null || published === null) return current !== published
  return !planStateEquals(published, current)
}

/**
 * [reload-closeout D2] 对账扫描域判定：任一家族派生缓存非空（曾出现 subagent/workflow/
 * plan record）。纯聊天 session 天然排除（无 record 无可对账）；事故形态 session
 * （record 存在、run 已终态）天然包含——「仅含 running 态」门控已被设计 D2 否决
 * （事故形态下 run 已 done，门控会形成完全零触发）。
 */
function isInReconcileDomain(cache: RecordEntriesCache): boolean {
  return cache.subagents.size > 0 || cache.workflows.size > 0 || cache.planState !== null
}

/**
 * D1④：PlanStateView 逐字段相等判定（plan 派生缓存的发布 diff 基线，义务 b）。
 *
 * 漏比对会静默吞 GUI 更新（与 subagentRecordEquals 同一教训——D1 明文引用
 * subagentRecordEquals 的 diff 先例）。null 与 View 恒不等（无 entry → 有 entry 是真变化，
 * 由 applyRecordEntries 分支显式处理，本函数只管 View vs View）。
 *
 * 结构固定（shared PlanStateView 七字段），逐字段比对而非 JSON.stringify（顺序无关、
 * 无序列化抖动）；optional 字段以 undefined === undefined 参与比对（两 View 同缺某
 * optional 字段 = 相等，单缺 = 不等——「无新字段区」的差异是真实显示差异，必须 publish）；
 * skills/docs 数组逐元素比对（数组引用每轮重新派生，=== 引用比较对同值也判不等）。
 */
function planStateEquals(a: PlanStateView, b: PlanStateView): boolean {
  if (a.isActive !== b.isActive) return false
  if (a.planFilePath !== b.planFilePath) return false
  if (a.requirement !== b.requirement) return false
  if (a.templateName !== b.templateName) return false
  if (a.reviewState !== b.reviewState) return false
  if (!stringArrayEquals(a.skills, b.skills)) return false
  return planDocListEquals(a.docs, b.docs)
}

/** string[] 逐元素相等（含 undefined 双缺语义，order-sensitive——技能清单顺序即挂载顺序）。 */
function stringArrayEquals(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  return a.every((item, i) => item === b[i])
}

/** PlanDocMeta[] 逐元素字段级相等（version 翻转 / 文档增删 / 元数据修订任一变化都触发 publish）。 */
function planDocListEquals(a: PlanDocMeta[] | undefined, b: PlanDocMeta[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  return a.every((doc, i) => {
    const other = b[i]!
    return doc.fileName === other.fileName &&
      doc.absPath === other.absPath &&
      doc.sourceSkill === other.sourceSkill &&
      doc.version === other.version
  })
}

/**
 * W18：SubagentRecord 逐字段相等判定（record entry 派生缓存的发布 diff 基线）。
 * 结构固定（shared SubagentRecord），逐字段比对而非 JSON.stringify（顺序无关、无序列化抖动）。
 * origin 在比对面（R3-1②）：活 record 的 origin 实际不变，但本函数管 publish 去重——
 * 投影白名单新增/演化字段时漏比对会静默吞掉 publish diff，补齐防未来字段漏更。
 * [U8 / §3.2.8] stopReason/engine 域进基线：settle 停因、zcode 续聊换锚
 * （engineHandle.sessionRef 每轮变）任一变化都必须触发 publish。[2026-09-16 裁决]
 * intent 比对位随「已收起」机制全链路删除（旧 entry 残留键被投影层忽略）。
 * [U8b / GUI 快修①] result 补入：轮终迁移恰翻该字段（result 写入），缺比对会把
 * 「轮终等待续聊」的显示信号静默吞掉（去重层判相等 → 不 publish → GUI 停留在旧形态）。
 * [modeless 波4] chatMode 比对维度随字段消亡删除（旧 entry 残留键被投影层忽略，
 * 不再构成显示信号）。
 * [U5/D4] resumable 比对位随字段退役删除——轮终翻转由 status 位天然触发。
 * [engine 域浅比较] engineHandle/engineFallback 是嵌套对象，applyRecordEntries 每轮
 * 重新解析 entry 派生新对象引用——=== 引用比较对同值也判不等（每轮多发 publish），
 * 故走字段级浅比较（见下方两个 equals helper）。zcode 续聊每轮换新 sessionId
 * （sessionRef.sessionId 变化）是真值变化，字段级比较天然触发 publish。
 * [拆分依据] 24 字段单链 && 圈复杂度 24 超 metrics-gate 门禁（≤15），按 record
 * 语义域拆四组 helper（身份锚 / 执行配置 / 统计 / 状态展示，见下方四个 equals）。
 * 各组内仍逐字段 ===，字段全集与比较语义不变；比较均为无副作用纯函数，分组与
 * 短路求值顺序不影响布尔结果（行为保持）。
 */
function subagentRecordEquals(a: SubagentRecord, b: SubagentRecord): boolean {
  return recordIdentityEquals(a, b)
    && recordRunConfigEquals(a, b)
    && recordStatsEquals(a, b)
    && recordStateEquals(a, b)
}

/** [身份锚组] subagent 身份与会话锚五字段：subagentId / sessionFile / agent / slug / task。 */
function recordIdentityEquals(a: SubagentRecord, b: SubagentRecord): boolean {
  return a.subagentId === b.subagentId
    && a.sessionFile === b.sessionFile
    && a.agent === b.agent
    && a.slug === b.slug
    && a.task === b.task
}

/**
 * [执行配置组] 模型/思考等级标量 + engine 域三件套（engine id / fallback 留痕 /
 * handle 锚——后两者经既有浅比较 helper，见上方「engine 域浅比较」注释）。
 */
function recordRunConfigEquals(a: SubagentRecord, b: SubagentRecord): boolean {
  return a.model === b.model
    && a.thinkingLevel === b.thinkingLevel
    && a.engine === b.engine
    && engineFallbackEquals(a.engineFallback, b.engineFallback)
    && engineHandleEquals(a.engineHandle, b.engineHandle)
}

/** [统计组] 执行统计五标量：轮数 / token / 耗时 / 起止时间戳。 */
function recordStatsEquals(a: SubagentRecord, b: SubagentRecord): boolean {
  return a.turns === b.turns
    && a.totalTokens === b.totalTokens
    && a.elapsedSeconds === b.elapsedSeconds
    && a.startedAt === b.startedAt
    && a.endedAt === b.endedAt
}

/**
 * [状态展示组] 状态 + 终态/展示信号五字段：status / error / closedReason + 轮终
 * result + stopReason / origin——publish
 * 去重的全部「显示形态」信号集中于此组，翻任一字段即触发 publish。
 * [U5/D4] resumable 比对位已随字段退役删除——轮终翻转由 status 位天然触发
 * （U4 翻边后轮终写 idle）；[modeless 波4] chatMode 比对位随字段消亡删除（旧 entry
 * 残留键投影层忽略）；result 仍需显式比对（running 期覆盖写场景）；
 * [2026-09-16 裁决] intent 比对位随「已收起」机制全链路删除。
 */
function recordStateEquals(a: SubagentRecord, b: SubagentRecord): boolean {
  return a.status === b.status
    && a.error === b.error
    && a.closedReason === b.closedReason
    && a.result === b.result
    && a.stopReason === b.stopReason
    && a.origin === b.origin
}

/**
 * [engine 域浅比较] string Record 键值逐一比对（键序无关——sessionRef 是引擎自定义
 * 键集合，两轮解析的键插入序不保证稳定，禁 JSON.stringify 全量比较）。
 */
function stringRecordEquals(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => a[key] === b[key])
}

/** [engine 域浅比较] engineFallback 字段级（from/reason 均标量）。 */
function engineFallbackEquals(
  a: SubagentRecord['engineFallback'],
  b: SubagentRecord['engineFallback'],
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a.from === b.from && a.reason === b.reason
}

/**
 * [engine 域浅比较] engineHandle 字段级：sessionRef 键值逐一比对 + journalPath /
 * poolKey 标量比对（zcode 锚 = sessionRef.{sessionId,dbPath}，sessionId 换新即真变化）。
 */
function engineHandleEquals(
  a: SubagentRecord['engineHandle'],
  b: SubagentRecord['engineHandle'],
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return stringRecordEquals(a.sessionRef, b.sessionRef)
    && a.journalPath === b.journalPath
    && a.poolKey === b.poolKey
}

/**
 * [W4] runtime 侧缺省引擎发现（SessionRecordsDeps.discoverEngines 缺省实现）：
 * core 发现器三级扫描（env 根 / 宿主根 / node 解析 / config.json engines 段），
 * hostKind = 'runtime'（EngineClient pidfile 实例维度与 pi 壳区分）、agentDir =
 * pi agentDir（L3 config.json 与 engines.json 同目录锚）、dataDir = runtime 数据根
 * （TAIJI_AGENT_DATA_DIR，与 pi 壳注入引擎的 L0 值同源）。发现即装载注册表（幂等
 * 覆盖）——W8 宿主接线后 runtime 派发路径直接消费同一批 descriptor。
 */
function defaultRuntimeEngineDiscovery(): string[] {
  const result = discoverAndRegisterEngines({
    hostKind: 'runtime',
    agentDir: getPiAgentDir(),
    dataDir: getDataDir(),
  })
  return result.discovered.map((entry) => entry.id)
}
