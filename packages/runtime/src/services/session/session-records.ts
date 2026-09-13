/**
 * SessionRecords — subagent/workflow 记录域（S6/D2③ 迁出，原 Facade 两大半截合并）。
 *
 * 域内容（一个概念域的两半，冷热同源）：
 * - W18 派生缓存族：recordEntriesCaches + get_entries 增量重拉编排（entry_appended
 *   失效信号 → 防抖 → cursor 三路径拉取 → merge → 变化发布）；
 * - 磁盘读侧/动作/引擎配置：getSubagents/getWorkflows（冷启动磁盘扫描，与缓存刷新
 *   共用 scanSubagentEntries/scanWorkflowEntries 同一份派生代码，D4）、
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
import type { SubagentRecord, WorkflowRunRecord } from '@xyz-agent/shared'
import { SUBAGENT_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_CUSTOM_TYPE } from '@xyz-agent/shared'
import type { SubagentEngineConfigView, SubagentEnginesFile } from '@xyz-agent/extension-protocol'
import { SUBAGENTS_ENGINES_FILENAME } from '@xyz-agent/extension-protocol'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getDataDir } from '@xyz-agent/shared/paths'
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
import { SkillInjector } from './skill-injector.js'
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
 */
export interface RecordEntriesCache {
  /** 最后已拉 entryId（增量游标）。null = 从未拉过（下次全量）。 */
  cursor: string | null
  /** subagent 派生缓存（subagentId → 最新快照记录）。 */
  subagents: Map<string, SubagentRecord>
  /** workflow 派生缓存（runId → 最新快照记录）。 */
  workflows: Map<string, WorkflowRunRecord>
  /** 防抖定时器（null = 未在等待）。 */
  debounceTimer: ReturnType<typeof setTimeout> | null
  /** in-flight 拉取 promise（并发失效共享一次拉取，消除重复 RPC）。 */
  inflight: Promise<void> | null
}

/** get_entries RPC 响应的域内收窄（u-s4 EntriesSinceResult 同款先例，见 fetchRecordEntriesRound）。 */
type EntriesSinceResult = { data?: { entries?: unknown[]; leafId?: string | null } }

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
   * 扫描（L1 env XYZ_AGENT_ENGINE_ROOTS / 宿主根 / L2 node 解析 / L3 config.json），
   * 与派发同源（设计 §3.4 投影面表「冷启动回退源单源化」）。测试注入 fake 隔离
   * 宿主 node_modules 的真实引擎包（零命中断言需要确定性空环境）。
   *
   * [W8] deprecated 死键 getExtensionPaths 已随构造点同批删除（本文件字段 + 
   * session-service.ts 装配点）——W4 登记的保留期结束。
   */
  discoverEngines?(): string[]
}

/** JSON 落盘缩进（全仓 JSON_INDENT = 2 约定）。 */
const JSON_INDENT = 2

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

  constructor(
    private readonly deps: SessionRecordsDeps,
    // [A2 D-A2-1] skill 注入器：subagentAction message/start 的定向文本出站前统一
    // 处理（与 MessageDispatcher 同款「默认实例化 + 构造可替换」形态，测试注入 spy）。
    private readonly injector: SkillInjector = new SkillInjector(),
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
    if (customType !== SUBAGENT_RECORD_CUSTOM_TYPE && customType !== WORKFLOW_RECORD_CUSTOM_TYPE) return
    const cache = this.recordEntriesCaches.get(sessionId)
    if (!cache) return
    if (cache.debounceTimer !== null) return // 已在防抖等待中：合并
    cache.debounceTimer = setTimeout(() => {
      cache.debounceTimer = null
      void this.refreshRecordEntries(sessionId)
    }, SCALAR_STATE_DEBOUNCE_MS)
  }

  /** 取/建 per-session record entry 派生缓存（subscribe 注册点调用）。 */
  private ensureRecordEntriesCache(sessionId: string): RecordEntriesCache {
    const existing = this.recordEntriesCaches.get(sessionId)
    if (existing) return existing
    const cache: RecordEntriesCache = {
      cursor: null,
      subagents: new Map(),
      workflows: new Map(),
      debounceTimer: null,
      inflight: null,
    }
    this.recordEntriesCaches.set(sessionId, cache)
    return cache
  }

  /**
   * W18：get_entries 拉取编排（cursor 三路径见 RecordEntriesCache 注释）。
   *
   * 拉取 → scanSubagentEntries / scanWorkflowEntries（与冷启动同一份派生代码）→ merge
   * 派生 Map → 有变化才发布（session.subagents 全量帧 / session.workflowUpdate 增量信号）。
   * 失败语义：Entry not found → 丢 cursor 就地重试一次全量自愈（两轮上限，防坏 pi 反复全量）；
   * 其他 RPC 错误 → warn 后保留 cursor（下次失效重试仍走增量），不发布（快照未变）。
   */
  private async refreshRecordEntries(sessionId: string): Promise<void> {
    const cache = this.recordEntriesCaches.get(sessionId)
    if (!cache) return
    if (cache.inflight) return cache.inflight // 并发失效共享一次拉取
    const run = async (): Promise<void> => {
      const client = this.deps.pm.getClient(sessionId)
      if (!client) return // session 已死：缓存冻结（onSessionDisposed 会清），冷启动走磁盘路径
      // 两轮：第 1 轮按 cursor 增量；Entry not found 丢 cursor 后第 2 轮全量自愈
      const MAX_REFRESH_ROUNDS = 2
      for (let round = 0; round < MAX_REFRESH_ROUNDS; round++) {
        let fetched: { entries: unknown[]; leafId: string | undefined }
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
        this.applyRecordEntries(cache, fetched.entries, sessionId)
        if (fetched.leafId !== undefined) cache.cursor = fetched.leafId
        return
      }
    }
    cache.inflight = run().finally(() => { cache.inflight = null })
    return cache.inflight
  }

  /**
   * W18：单轮 get_entries 拉取——按 cursor 有无分流增量/全量。
   * 全量重建时派生缓存整体重置（纯派生语义——全量扫描结果就是新基线）。
   *
   * 响应收窄（u-s4 EntriesSinceResult 同款先例）：entries 零字段消费——整体透传
   * scanSubagentEntries / scanWorkflowEntries（unknown[] 形参）。
   */
  private async fetchRecordEntriesRound(
    client: IPiEngine,
    cache: RecordEntriesCache,
  ): Promise<{ entries: unknown[]; leafId: string | undefined }> {
    if (cache.cursor !== null) {
      const inc = await client.getEntries(cache.cursor) as EntriesSinceResult
      return { entries: inc.data?.entries ?? [], leafId: inc.data?.leafId ?? undefined }
    }
    const full = await client.getEntries() as EntriesSinceResult
    cache.subagents.clear()
    cache.workflows.clear()
    return { entries: full.data?.entries ?? [], leafId: full.data?.leafId ?? undefined }
  }

  /**
   * 扫描结果 merge 入派生缓存 + 变化发布。
   *
   * - subagents：merge 后与发布基线（缓存内当前值）比对，有变化 publish session.subagents
   *   全量帧（payload = 派生缓存快照数组）。
   * - workflows：merge 时收集状态变化的 run（含新增），按扫描序逐个 publish
   *   session.workflowUpdate 增量信号——最后一条即 stateSnapshot 'workflows' last-value
   *   （话题 last-value 语义与 W12 一致）。
   */
  private applyRecordEntries(cache: RecordEntriesCache, entries: unknown[], sessionId: string): void {
    const subagents = scanSubagentEntries(entries)
    let subagentsChanged = false
    for (const record of subagents) {
      const prev = cache.subagents.get(record.subagentId)
      if (prev === undefined || !subagentRecordEquals(prev, record)) subagentsChanged = true
      cache.subagents.set(record.subagentId, record)
    }

    const workflows = scanWorkflowEntries(entries)
    const workflowUpdates: Array<{ runId: string; status: string; reason?: string }> = []
    for (const record of workflows) {
      const prev = cache.workflows.get(record.runId)
      // [GUI 步骤实时可见 2026-09-14] agent 步骤数变化也发增量信号：running 中 trace
      // 逐步落盘（core dispatch 启动即 save），若只比 status/reason（恒 'running'），
      // GUI 详情的 agentCalls 在整个 run 期间收不到任何 reload 触发——步骤只在
      // 下次 status 变化时一次性涌现，实时性失效。步骤级信号频率受 core 端
      // entry append 节流（缺省 60s）约束，不会刷屏。
      if (prev === undefined || prev.status !== record.status || prev.reason !== record.reason ||
          prev.agentCalls.length !== record.agentCalls.length) {
        workflowUpdates.push({ runId: record.runId, status: record.status, reason: record.reason })
      }
      cache.workflows.set(record.runId, record)
    }

    if (!this.deps.hasSession(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    if (subagentsChanged) {
      this.deps.getMessageBus()?.publish(sessionId, {
        type: 'session.subagents',
        payload: { sessionId, subagents: Array.from(cache.subagents.values()) },
      })
    }
    for (const update of workflowUpdates) {
      this.deps.getMessageBus()?.publish(sessionId, {
        type: 'session.workflowUpdate',
        payload: { sessionId, update },
      })
    }
  }

  async getSubagents(sessionId: string): Promise<SubagentRecord[]> {
    // 找主 session 文件路径（scanSessions 扫 <agentDir>/sessions/，含 cwd-encoded 子目录）。
    // wave:perf-w26（plan M-3）：路径解析消费方 force 旁路 TTL（刚落盘 session 的
    // subagent 面板在窗口内不静默返回空）。
    const target = this.deps.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
    if (!target) return []
    return extractSubagentsFromSessionFile(target.filePath)
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
   * 兜底（H5 后扩展包 xyz-agent.subagentEngines 声明已废弃）：零命中返回空清单——
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
   * 协议对齐 worktree-config-helper ext-config / settings.json 先例）。锁失败 fail-fast
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
      // （tmp+rename）；写失败时 .tmp 残留不被清理——与 worktree-config-helper ext-config
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
    return extractWorkflowsFromSessionFile(target.filePath)
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
   * 触发 workflow 生命周期操作（pause/resume/abort）。
   * 经 client.prompt("/workflows <action> <runId>") 调扩展 slash command，
   * pi 检测 / 开头直接执行 command handler（不经 LLM）。
   * 扩展侧 RPC 分支已实现（commands.ts ctx.mode==='rpc'）。
   */
  async workflowAction(sessionId: string, action: 'pause' | 'resume' | 'abort', runId: string): Promise<void> {
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
   * - start：<slug> <task>（conversation:true 可续聊的新 subagent）
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
      const injection = await this.injector.inject(client, params.text)
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
    const injection = await this.injector.inject(client, params.task)
    await client.prompt(`/subagents start ${params.slug} ${encodeDirectiveText(injection.text)}`)
    publishSkillNotices(this.deps.getMessageBus(), sessionId, params.task, injection.notices)
  }

  // ── 销毁清理（Facade removeSessionEntry 第 ⑤ 步直调，与 TraceSync/SessionStateProjection.onSessionDisposed 并列）──

  /**
   * W18：销毁 record entry 派生缓存（主动删 + 进程退出汇聚点）。停防抖定时器
   * （在途 inflight 的拉取完成后 applyRecordEntries 的 hasSession 守卫拦住发布，
   * 不复活已清 bus 条目）。
   */
  onSessionDisposed(sessionId: string): void {
    const cache = this.recordEntriesCaches.get(sessionId)
    if (cache) {
      if (cache.debounceTimer !== null) clearTimeout(cache.debounceTimer)
      this.recordEntriesCaches.delete(sessionId)
    }
  }
}

/**
 * W18：SubagentRecord 逐字段相等判定（record entry 派生缓存的发布 diff 基线）。
 * 结构固定（shared SubagentRecord），逐字段比对而非 JSON.stringify（顺序无关、无序列化抖动）。
 * origin 在比对面（R3-1②）：活 record 的 origin 实际不变，但本函数管 publish 去重——
 * 投影白名单新增/演化字段时漏比对会静默吞掉 publish diff，补齐防未来字段漏更。
 * [U8 / §3.2.8] intent/stopReason/engine 域进基线：close 收起/寻回翻边、settle 停因、
 * zcode 续聊换锚（engineHandle.sessionRef 每轮变）任一变化都必须触发 publish。
 * [U8b / GUI 快修①] result/resumable/chatMode 三字段补入：轮终迁移恰翻这三个字段
 * （result 写入 / resumable 置位 / chatMode 显式化），缺比对会把「轮终等待续聊」的
 * 显示信号静默吞掉（去重层判相等 → 不 publish → GUI 停留在旧形态）。
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
 * [状态展示组] 状态 + 终态/展示信号九字段：status / error / closedReason + 轮终
 * 三字段（result / resumable / chatMode）+ intent / stopReason / origin——publish
 * 去重的全部「显示形态」信号集中于此组，翻任一字段即触发 publish。
 */
function recordStateEquals(a: SubagentRecord, b: SubagentRecord): boolean {
  return a.status === b.status
    && a.error === b.error
    && a.closedReason === b.closedReason
    && a.result === b.result
    && a.resumable === b.resumable
    && a.chatMode === b.chatMode
    && a.intent === b.intent
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
 * （XYZ_AGENT_DATA_DIR，与 pi 壳注入引擎的 L0 值同源）。发现即装载注册表（幂等
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
