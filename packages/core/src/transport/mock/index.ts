/**
 * Mock 门面 —— 与 @/api 同接口签名，VITE_MOCK=true 时由 api/index 注入。
 *
 * [G4 类型锚定] 同接口不再靠注释承诺：session/chat/config/model/plugin/composer/workspace/
 * quota/project/preset 十域对象显式标注 real 域导出类型（XDomain = typeof real 域模块），
 * 并配 AssertExact<DomainParamsExact<...>> 逐方法比较 Parameters 元组全等——real 域加参/改签名时
 * mock 侧缺参/少参/多参/错型直接 tsc 编译失败。锚定范围与未锚定域（settings/extension/
 * search/git/file）的理由登记见下方「[G4 类型锚定]」注释块与 docs/TEST-STRATEGY.md §5。
 *
 * 行为（D7 工程默认）：
 * - 不走 transport/ws-client，直接返回内存 fixture + setTimeout 模拟流式
 * - 不模拟失败（v1 永远成功），除 switchSession 的 id 不存在（契约要求抛）
 * - 全内存（reload 重置）
 * - 流式事件名严格按 protocol.ts ServerMessageType（message_start/text_delta/complete）
 *
 * 依赖方向：无（不 import transport/events/pending，独立内存实现；real 域模块仅 import type
 * 引形状，编译期擦除，无运行时依赖、不影响生产构建 mock 链摇除）。
 *
 * [W17] ⚠️ 事件总线共享警告：mock 直接复用 real events 总线（pushSession/dispatchSession
 * 走的是 real events，core transport/api/events），mock 推送的 server-push 会被所有经 events.on 注册的订阅者收到。
 * 因此 **mock 不可与 real 模式同进程加载**——若 real ws-client 已连，mock 推送会污染 real 订阅者。
 * 工程约定：测试/E2E/演示环境只用 mock（VITE_MOCK=true），生产构建不走 mock 门面（api/index
 * 在构建期静态选 real），两者互斥。若检测到 mock 与 real 同时激活（first-push 时 ws-client 已
 * connected），打一次 console.warn 提示。
 */
import type {
  Message, ModelInfo, ServerMessage, ServerMessageMap, ServerMessageUnion, SessionSummary, SessionGroup, ProviderInfo, BuiltinProviderTemplate,
  SkillInfo, AgentInfo, PluginInfo, SetProviderData,
  SkillDirConfig, FileNode, RecommendedExtension, SubagentRecord, WorkflowRunRecord,
  SystemPromptConfig,
  TerminalConfig,
  BatchDeleteResult,
  ProviderSource, ProviderImportPreview, ProviderImportResult, ProviderImportedItem,
  SkillCacheInvalidatedPayload,
  ProviderId,
  QuotaConfigurePayload,
  ThinkingLevel,
  LlmRetryConfig,
  ScannedSkillInfo,
  ScannedAgentInfo,
} from '@taiji/shared'
import { recommendedExtensions, PRESET_SKILL_DIRS, PRESET_AGENT_DIRS, PRESET_EXTENSION_DIRS, DEFAULT_DISCOVERY_CONFIG, DEFAULT_PRESETS } from '@taiji/shared'
import { createSession, fixtureMessages, fixtureSessions, e2eTestSession } from './data'
import { fixtureProviders, fixtureSkills, fixtureAgents, fixtureExtensions, toCandidate } from './settings-data'
import { MOCK_MODELS, mockModelToInfo, FILE_CANDIDATES } from './composer-data'
import { SEARCH_MOCK, SEARCH_RECENTS, SEARCH_SUGGESTED_COUNT, type SearchItem } from './search-data'
// 相对路径直达定义处（new-task-search/types.ts）：经 '@taiji/core' barrel 回引会成环，ESM 序隐患
import type { Section } from '../../domain/new-task-search/types'
import { runSendStream, type Timing } from './run-send-stream'
import { makeMockSubscription, type GlobalHandler } from './subscription'
import * as events from '../api/events'
// [W17] 检测 real ws-client 是否已 connected（mock 与 real 同进程时打 warn，防 events 总线污染）
import * as wsClient from '../ws-client'
// [W4] getSystem/updateSystem 持久化已迁 @taiji/core domain/settings/system-storage
// （经 PlatformPort.storage KVStorage，renderer 壳 useSettingsShell providePlatform 注入）。
// mock 不再转发这两个方法（消费方已切 core getSystem(getPlatform().storage)）。

// ── [G4 类型锚定] mock 域对象显式标注 real 域导出类型 ──────────────────────────
// 为什么：门面三元（renderer api/index `isMock ? mockApi.x : realX`）的两侧同构此前只靠
// 注释承诺（「与 real domain 同接口，签名一致」），real 域加参（如 session.create 的
// presetId/projectId/modelOverride/thinkingOverride 四参）时 mock 侧静默漂移、参数被丢弃。
// real 域是散函数模块（无对象/命名空间形态可复用），模块本身（typeof import）即形状单点，
// 直接引用不另抽接口。锚定后漂移变 tsc 编译错误，两层防线：
// ① `export const x: XDomain = xImpl` —— 抓成员缺失/多余、参数/返回类型漂移；
// ② AssertExact<DomainParamsExact<...>> —— 可赋值性抓不到「少可选参」（少参函数可赋给多参函数类型），
//    须逐方法比较 Parameters 元组全等（identity）。断言别名 export：未导出的 unused 类型
//    别名会被 lint no-unused-vars 拦截（tsc 侧本包未开 noUnusedLocals，不设防）。
// 已锚定：session/chat/config/model/plugin/composer/workspace/quota/project/preset（10 域）。
// 未锚定（mock 保真度登记见 docs/TEST-STRATEGY.md §5）：settings（7 成员子集转发器，
// real 是 40+ 方法全域）/ extension（onExtensions 宽类型为登记过的有意偏差，W08 收口）/
// search（real 侧无单源 domain，编排归 useSearchModalDeps）/ git、file（独立 mock 文件，
// 待后续同法锚定）。
import type * as realSessionDomain from '../api/domains/session'
import type * as realChatDomain from '../api/domains/chat'
import type * as realConfigDomain from '../api/domains/config'
import type * as realModelDomain from '../api/domains/model'
import type * as realPluginDomain from '../api/domains/plugin'
import type * as realComposerDomain from '../api/domains/composer'
import type * as realWorkspaceDomain from '../api/domains/workspace'
import type * as realQuotaDomain from '../api/domains/quota'
import type * as realProjectDomain from '../api/domains/project'
import type * as realPresetDomain from '../api/domains/preset'

/** real 域形状单点（mock 锚定源；散函数模块的 namespace 类型即域接口） */
export type SessionDomain = typeof realSessionDomain
export type ChatDomain = typeof realChatDomain
export type ConfigDomain = typeof realConfigDomain
export type ModelDomain = typeof realModelDomain
export type PluginDomain = typeof realPluginDomain
export type ComposerDomain = typeof realComposerDomain
export type WorkspaceDomain = typeof realWorkspaceDomain
export type QuotaDomain = typeof realQuotaDomain
export type ProjectDomain = typeof realProjectDomain
export type PresetDomain = typeof realPresetDomain

/** 去 tuple 标签（Parameters 产 labeled tuple；参数名是修饰不是类型身份，归一后再比对） */
type PlainTuple<T extends unknown[]> = { [K in keyof T]: T[K] }
/**
 * 元组类型全等（identity 比对而非可赋值性——可赋值性抓不到可选元素的增删）。
 * 判别臂用字符串字面量（非数值）：同为 identity 探针的两臂标记，避免 no-magic-numbers warning。
 */
type SameTuple<A extends unknown[], B extends unknown[]> =
  (<T>() => T extends PlainTuple<A> ? 'eq' : 'ne') extends (<T>() => T extends PlainTuple<B> ? 'eq' : 'ne') ? true : false
/** 断言恒真（类型实参不满足 true 约束时在使用处报编译错） */
type AssertExact<T extends true> = T
/**
 * 逐方法比较 mock 实现与 real 域的 Parameters 元组全等（identity）；任一方法少参/多参/错型，
 * 结果联合含 false。抓的正是「注解可赋值性放行」的漂移：mock 少声明一个可选参，TS 结构化
 * 比较视为合法（少参函数可赋给多参函数类型）。用法：AssertExact<DomainParamsExact<D, M>>——
 * 泛型定义内不能直接套 AssertExact（未解析泛型上约束不可证，会在定义处误报）。
 */
type DomainParamsExact<Real, Mock extends Real> = {
  [K in keyof Real]: Real[K] extends (...args: infer P) => unknown
    ? Mock[K] extends (...args: infer Q) => unknown
      ? SameTuple<P, Q>
      : false
    : true
}[keyof Real]

// mock/git.ts 的 git domain + fixtureGitStatus 透出（Wave 1a real git domain 落地后由 api/index 接线）
export { git, fixtureGitStatus } from './git'
// mock/file.ts 的 file domain 透出（W3 file-tree real domain 落地后由 api/index 接线）
export { file } from './file'
// file/git 的 ack 注入缝（setMockTiming 单入口编排：ack 与门面 TIMING 同族同步压缩）
import { __setMockFileAck } from './file'
import { __setMockGitAck } from './git'

// workflow/subagent fixture（E2E 验证 Flows/Agents tab，从 workflow-data.ts 拆出控文件行数）
import { fixtureWorkflows, fixtureSubagents } from './workflow-data'

/** "npm:" 前缀长度（install source 解析用，对齐 runtime NPM_PREFIX_LENGTH） */
const NPM_PREFIX = 'npm:'

/**
 * [W17] mock 与 real 同进程加载的 once-warn（防 events 总线污染）。
 * mock 直接 dispatchSession 走 real events 总线，若 real ws-client 已 connected，
 * mock 推送会污染 real 订阅者。检测到该状态时打一次 warn（不阻断，因测试环境可能合法共用）。
 * 用模块级 flag once-warn，避免每次 pushSession 都刷屏。
 */
let mockRealCollisionWarned = false
function warnIfRealClientActive(): void {
  if (mockRealCollisionWarned) return
  let state: string | undefined
  try {
    state = wsClient.getState?.().value
  } catch {
    // ws-client 未初始化或不可用——mock 独占模式，无需 warn
    return
  }
  if (state === 'connected') {
    mockRealCollisionWarned = true
    console.warn(
      '[mock] 检测到 real ws-client 已 connected，mock 推送将污染 real 订阅者（events 总线共用）。' +
      '工程约定 mock 与 real 互斥加载，请检查 VITE_MOCK 配置。',
    )
  }
}

/**
 * Mock 模拟 runtime session 通道推送（dispatchSession）。
 * 组件用 events.on(sessionId) 订阅 session.commands / context.update / extension:widget 等；
 * mock 不走 transport，故在此桥接——直接 dispatchSession 模拟 server-push，
 * 让组件订阅在 mock 模式下也能触发（mock/real 同构）。
 *
 * [W17] pushSession 是 mock 与 real events 总线的接触点：首次推送时检测 real ws-client 是否
 * 已 connected，若是则 warn（防 mock 推送污染 real 订阅者）。
 */
function pushSession(sessionId: string, msg: ServerMessageUnion): void {
  warnIfRealClientActive()
  events.dispatchSession(sessionId, msg)
}

/**
 * E2E 注入：VITE_E2E === 'true' 时把 e2eTestSession（cwd 指向 e2e/fixtures/sample-project）
 * 并入 fixtureSessions 快照，让 W8 文件树 E2E 拿到带确定 cwd 的 session。
 * [tc-transport-consolidation u3] core 不能读 import.meta.env——VITE_E2E 构建期值改由壳
 * facade 注入（api/index.ts 调 setMockE2E）；未注入时默认 false（非 E2E）。
 */
let isE2E = false

/** 壳注入 VITE_E2E 构建期值（renderer facade 调用；core 保持无 Vite env 依赖） */
export function setMockE2E(enabled: boolean): void {
  isE2E = enabled
}

/** 按 cwd 聚合 fixtureSessions 为 SessionGroup[]（config.sessions reply 与 server-push 共用） */
function buildGroups(): SessionGroup[] {
  // E2E 模式注入 fixture session（不修改 fixtureSessions 源数组，保持 idempotent）
  const base = fixtureSessions.map((s) => ({ ...s }))
  const snapshots = isE2E && e2eTestSession.cwd ? [e2eTestSession, ...base] : base
  const byCwd = new Map<string, SessionSummary[]>()
  for (const s of snapshots) {
    const bucket = byCwd.get(s.cwd)
    if (bucket) bucket.push(s)
    else byCwd.set(s.cwd, [s])
  }
  return Array.from(byCwd, ([cwd, sessions]) => ({ cwd, sessions }))
}

/**
 * 模拟 runtime broadcastSessionList（create/delete/rename 后推全量分组到 global 通道）。
 * useSidebar 经 events.onGlobalType('config.sessions') 订阅（refCount 防重复），mock 直 dispatchGlobal。
 */
function pushSessionList(): void {
  events.dispatchGlobal({ type: 'config.sessions', id: nextId('sl'), payload: { groups: buildGroups() } })
}

/** Mock 静态 slash 命令（模拟 pi getCommands 返回的扩展命令） */
const MOCK_COMMANDS = [
  { name: '/commit', description: '提交改动', source: 'extension' },
  { name: '/review', description: '代码审查', source: 'extension' },
  { name: '/fix', description: '修复问题', source: 'skill' },
  { name: '/compact', description: '压缩上下文', source: 'builtin' },
]

/**
 * 模拟 runtime 的 session 级 server-push（session.commands + context.update）。
 * 在 switchSession（等价 runtime session 激活）后推，模拟 runtime fetchAndBroadcastCommands +
 * onContextUpdate。延迟模拟异步推送节奏。
 */
function pushSessionState(sessionId: string): void {
  const cmdTimer = setTimeout(() => {
    pushSession(sessionId, {
      type: 'session.commands',
      id: `mock_cmd_${sessionId}`,
      payload: { sessionId, commands: MOCK_COMMANDS },
    })
  }, TIMING.switchCmd)
  timers.add(cmdTimer)
  const ctxTimer = setTimeout(() => {
    pushSession(sessionId, {
      type: 'context.update',
      id: `mock_ctx_${sessionId}`,
      payload: { sessionId, usagePercent: 6.9, inputTokens: 69000, contextLimit: 1000000 },
    })
  }, TIMING.switchCmd)
  timers.add(ctxTimer)
}

/** 流式时序默认值（ms）—— 仅用于视觉演示节奏，不影响契约。setMockTiming/resetMockTiming 的还原基准 */
const DEFAULT_TIMING: Timing = {
  ack: 40, // 命令 ack
  startGap: 60, // message_start 前
  chunk: 70, // 每个 text/thinking delta 间隔
  done: 40, // complete 前
  switchCmd: 30,
  thinkingGap: 50, // thinking 块各阶段间隔
  toolGap: 90, // tool_call 各阶段间隔（进度感）
  fileChangesGap: 120, // accumulating → ready 间隔
  retryGap: 800, // auto_retry_start → end 间隔（让指示位可见）
  steerDrain: 1500, // steer/followUp 入队 → 模拟 drain（pi 投递）间隔，让 QueueBubble 可见
  bashDelay: 2000, // bashStart→bashResult 间隔（loading 态可见）
}
/** 运行时时序（对象引用共享给 run-send-stream/branches——注入走原地 merge，消费点运行时读） */
const TIMING: Timing = { ...DEFAULT_TIMING }

/** timeout 分支在 bashDelay 之上再加的强调量（默认合计 3s，强调 timer 到期节奏） */
const MOCK_BASH_TIMEOUT_EXTRA_MS = 1000

/** 时序应用（merge 到 TIMING + 同步 file/git 同族 ack），setMockTiming/resetMockTiming 共用 */
function applyMockTiming(timing: Timing): void {
  Object.assign(TIMING, timing)
  // file/git domain 的 ack 与门面 TIMING.ack 同族（见两文件「与 TIMING.ack 一致量级」注释），单入口同步注入
  __setMockFileAck(timing.ack)
  __setMockGitAck(timing.ack)
}

/**
 * 测试钩子：压缩 mock 演示节奏。默认值面向人眼演示（40ms～2s/步），mock family 测试
 * 真实等待这些墙钟——显式调用本钩子压至 0-5ms（阶段经历顺序不变，各阶段仍按序 await）。
 * 只影响显式调用的测试文件（模块状态），生产/演示默认值零变化；afterEach/afterAll 用
 * resetMockTiming() 还原。仅「时序」可注入——fixture 数据与契约行为不受影响。
 */
export function setMockTiming(partial: Partial<Timing>): void {
  applyMockTiming({ ...TIMING, ...partial })
}

/** 还原默认时序（与 setMockTiming 配对，防跨文件/跨用例泄漏压缩时序） */
export function resetMockTiming(): void {
  applyMockTiming(DEFAULT_TIMING)
}

// taste:allow-no-data-owner W24-EX-D（VITE_MOCK 测试基建，登记草稿）：mock 流式 handler 表
const streamHandlers = new Map<string, Set<(msg: ServerMessageUnion) => void>>()
/** 已 abort 的 session：send 循环检查后提前返回 */
// taste:allow-no-data-owner W24-EX-D（VITE_MOCK 测试基建，登记草稿）：mock 取消标记集合
const cancelled = new Set<string>()
/** 运行中的 setTimeout 句柄，resolve 后自动移除，避免 Set 无限增长 */
// taste:allow-no-data-owner W24-EX-D（VITE_MOCK 测试基建，登记草稿）：mock 定时器句柄集合
const timers = new Set<ReturnType<typeof setTimeout>>()
/**
 * mock 队列状态镜像（steer/followUp pending）。
 * steer/followUp 入队时 push + emit 全量 queue_update（QueueBubble 渲染），
 * 延迟后 splice 模拟 drain（pi 投递）+ emit 全量（移除该项）→ drainPending 取 segments + appendUser（complete user 进对话流）。
 */
// taste:allow-no-data-owner W24-EX-D（VITE_MOCK 测试基建，登记草稿）：mock 队列缓冲
const mockQueues = new Map<string, { steering: string[]; followUp: string[] }>()

/** 清理所有未触发的 timer（测试 teardown / 模块卸载时调用） */
export function __clearTimers(): void {
  for (const t of timers) clearTimeout(t)
  timers.clear()
}

let idSeq = 0

function nextId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

function emit(sessionId: string, msg: ServerMessageUnion): void {
  streamHandlers.get(sessionId)?.forEach((h) => h(msg))
}

/** emit 全量 queue_update（steering + followUp 镜像），驱动 QueueBubble 渲染 */
function emitQueueUpdate(sessionId: string): void {
  const q = mockQueues.get(sessionId)
  // 发副本而非活引用：drain splice 会原地改 q.steering，按引用 emit 会让订阅方
  // 已收到的入队帧事后被改空（快照语义）
  const steering = q?.steering.length ? [...q.steering] : undefined
  const followUp = q?.followUp.length ? [...q.followUp] : undefined
  // 两者皆空时仍 emit（空 payload），让 store 侧 queue_update handler delete queueState
  // pendingMessageCount = steering + followUp 条数和（W8 契约必填，对齐 event-adapter 翻译口径）
  emit(sessionId, {
    type: 'message.queue_update',
    payload: {
      sessionId,
      steering,
      followUp,
      pendingMessageCount: (q?.steering.length ?? 0) + (q?.followUp.length ?? 0),
    },
  })
}

/**
 * steer/followUp drain（pi 投递）后补发 assistant turn（m4）：message_start → text_delta×N → complete。
 *
 * drain 只 emit queue_update 会让用户消息入流后无后续 assistant——dangling streaming bubble
 * （demo / E2E 下 steer 后看不到回复）。补一个最小 assistant turn 让 mock 与真实 pi 行为同构
 * （pi drain steer 后开新一轮 LLM turn，发 message_start + 流式回复 + complete）。
 * 内容简化为固定文案逐字流式，让 streaming 气泡可见；全程检查 cancelled。
 */
async function emitDrainAssistantTurn(sessionId: string, steeredText: string): Promise<void> {
  const messageId = nextId('m')
  emit(sessionId, { type: 'message.message_start', id: messageId, payload: { sessionId, messageId } })
  await sleep(TIMING.startGap)
  const reply = `（mock）已处理："${steeredText}"`
  for (const ch of reply) {
    if (cancelled.has(sessionId)) return
    await sleep(TIMING.chunk)
    emit(sessionId, { type: 'message.text_delta', id: messageId, payload: { sessionId, messageId, delta: ch } })
  }
  if (cancelled.has(sessionId)) return
  await sleep(TIMING.done)
  emit(sessionId, { type: 'message.complete', id: messageId, payload: { sessionId, messageId, stopReason: 'complete' } })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      timers.delete(t)
      resolve()
    }, ms)
    timers.add(t)
  })
}

// ── zcode 导入源 mock fixture（sess-session-import u-foundation）─────────────
// 契约语义对齐：sessionId 保持原始 sess_ 前缀形态（候选 id = 源系统主键原始形态，
// 归一化发生在 import source 内部）；sourcePath = db 路径结构占位（契约同构，
// zcode 的 query 匹配不消费）；lastModified 以 now 偏移现算（保持降序演示真实性）。
const ZCODE_MOCK_DB_PATH = '/mock/zcode/session-db/db.sqlite'
const MOCK_HOUR_MS = 3_600_000
const MOCK_DAY_MS = 86_400_000
const MOCK_KB_BYTES = 1024
const ZCODE_MOCK_SIZE_LARGE_KB = 512
const ZCODE_MOCK_SIZE_SMALL_KB = 96
const ZCODE_MOCK_ROWS: ReadonlyArray<{
  sessionId: string
  name: string | null
  cwd: string
  sizeBytes: number
  ageMs: number
  alreadyImported: boolean
}> = [
  { sessionId: 'sess_9d5b3a1f-2e4c-4b8d-a6f0-7c1d9e2b4a88', name: '修复构建脚本', cwd: '/Users/demo/zcode-alpha', sizeBytes: ZCODE_MOCK_SIZE_LARGE_KB * MOCK_KB_BYTES, ageMs: MOCK_HOUR_MS, alreadyImported: false },
  { sessionId: 'sess_1c7e05a2-f3b9-47d2-9a41-5e8c6b0d2f37', name: null, cwd: '/Users/demo/zcode-beta', sizeBytes: ZCODE_MOCK_SIZE_SMALL_KB * MOCK_KB_BYTES, ageMs: MOCK_DAY_MS, alreadyImported: true },
]

/** zcode mock 候选快照（map 新对象——mock 惯例 fixture 快照隔离，调用方突变不污染源数据） */
function zcodeMockCandidates(): import('@taiji/shared').ImportCandidate[] {
  const now = Date.now()
  return ZCODE_MOCK_ROWS.map((r) => ({
    sessionId: r.sessionId,
    name: r.name,
    cwd: r.cwd,
    sourcePath: ZCODE_MOCK_DB_PATH,
    lastModified: now - r.ageMs,
    size: r.sizeBytes,
    // dirLabel = basename(cwd)（zcode 源 dirs 聚合同规则；fixture cwd 无尾斜杠，
    // mock 浏览器环境无 node:path，手写 split 与 composer getFileCandidates 同模式）
    dirLabel: r.cwd.split('/').pop() ?? r.cwd,
    alreadyImported: r.alreadyImported,
    cwdExists: true,
  }))
}

const sessionImpl = {
  /**
   * session trace 台账全量（session-trace，design D4）。mock 轨道无真实 JSONL/pi 进程，
   * 恒返回 empty 快照（Trace 视图空态）；real 轨道走 runtime A1 混合路由。
   * 与 real domain 同接口（api/index 门面三元要求两侧同构）。
   */
  async getTraceEntries(sessionId: string): Promise<import('@taiji/shared').ServerMessageMap['session.traceEntries']> {
    await sleep(TIMING.ack)
    return { sessionId, source: 'empty', entries: [], malformed: [] }
  },
  /**
   * 现取当前 system prompt（session-trace §3.1 失败路径，C2）。mock 轨道无 pi 进程，
   * 恒 reject session_not_active（与 real 轨道「非活跃 session」错误路径同形，供 UI
   * 错误态演示）。与 real domain 同接口（api/index 门面三元要求两侧同构）。
   */
  async fetchCurrentSystemPrompt(sessionId: string): Promise<import('@taiji/shared').ServerMessageMap['session.currentSystemPrompt']> {
    await sleep(TIMING.ack)
    throw Object.assign(new Error(`Session ${sessionId} not active (mock)`), { code: 'session_not_active' })
  },
  /**
   * 按 cwd 分组返回（对齐后端 SessionGroup[]，D7）。
   * runtime 的 config.sessions reply 是 `{ groups: SessionGroup[] }`，同构返分组结构。
   * 同 cwd 的 session 归入一组，组内保持插入顺序（按 lastActiveAt 降序更贴近真实，
   * 但 mock fixture 已手排，此处保持稳定顺序避免打乱既有的 5 态演示）。
   */
  async list(): Promise<SessionGroup[]> {
    await sleep(TIMING.ack)
    // buildGroups 已深拷贝，调用方突变不影响 fixture
    return buildGroups()
  },

  /**
   * [G4 锚定 SessionDomain] 参数与 real 域 create 全等（含 override 四参）。
   * override 生效面（对齐 real 关键语义，落 SessionSummary 可断言）：
   * presetId → launchPresetId（real create 即锁预设进 summary）、projectId → projectId
   * （D14 归属）、modelOverride → modelId、thinkingOverride → thinkingLevel（Landing Chip
   * 覆盖值）。mock 无 pi/runtime，仅内存投影，不追求全仿真。
   */
  async create(cwd?: string, label?: string, presetId?: string, projectId?: string, modelOverride?: string, thinkingOverride?: ThinkingLevel): Promise<SessionSummary> {
    await sleep(TIMING.ack)
    const s = createSession(cwd, label)
    if (presetId !== undefined) s.launchPresetId = presetId
    if (projectId !== undefined) s.projectId = projectId
    if (modelOverride !== undefined) s.modelId = modelOverride
    if (thinkingOverride !== undefined) s.thinkingLevel = thinkingOverride
    fixtureSessions.push(s)
    // 模拟 runtime create 后 broadcastSessionList（server-push 全量分组）
    pushSessionList()
    return { ...s }
  },

  /**
   * Mock fork：模拟 runtime 截断 + 新进程，返回新 session。
   * mock 模式无真实 JSONL 截断，仅创建空 session（历史由前端 selectSession 拉）。
   * [G4 锚定 SessionDomain] 类型锚定保证与 real 域 fork 签名全等（编译强制，不再靠注释承诺）。
   * override 生效面同 create（modelOverride → modelId / thinkingOverride → thinkingLevel，
   * ADR-0056 Staging Mode 覆盖优先于源 preset）；血缘字段落 parentSession（FR-20 fallback 键：
   * mock 无 sessionFile，恒用源 sessionId）+ forkEntryId；projectId 继承父归属（real fork 同语义）。
   */
  async fork(
    srcSessionId: string,
    opts: {
      piEntryId?: string
      messageTimestamp?: number
      messageRole?: string
      includeFrom?: boolean
      label?: string
      modelOverride?: string
      thinkingOverride?: string
    },
  ): Promise<SessionSummary> {
    await sleep(TIMING.ack)
    const src = fixtureSessions.find((s) => s.id === srcSessionId)
    const cwd = src?.cwd
    const s = createSession(cwd, opts?.label)
    if (opts?.modelOverride !== undefined) s.modelId = opts.modelOverride
    if (opts?.thinkingOverride !== undefined) s.thinkingLevel = opts.thinkingOverride
    if (src?.projectId) s.projectId = src.projectId
    s.parentSession = srcSessionId
    if (opts?.piEntryId !== undefined) s.forkEntryId = opts.piEntryId
    fixtureSessions.push(s)
    pushSessionList()
    return { ...s }
  },

  async switchSession(id: string): Promise<void> {
    await sleep(TIMING.switchCmd)
    // E2E 注入的 session 不在 fixtureSessions 数组中，单独放行
    const exists = isE2E && id === e2eTestSession.id ? true : fixtureSessions.some((s) => s.id === id)
    if (!exists) {
      throw new Error(`mock: session ${id} 不存在`)
    }
    // 模拟 runtime session 激活后的 server-push（session.commands + context.update）
    pushSessionState(id)
  },

  /** mock restoreSession：等价 switchSession（mock 不真正 spawn pi，模拟激活即可）。返回 SessionSummary。 */
  async restoreSession(id: string): Promise<SessionSummary> {
    await sleep(TIMING.switchCmd)
    const s = isE2E && id === e2eTestSession.id ? e2eTestSession : fixtureSessions.find((item) => item.id === id)
    if (!s) {
      throw new Error(`mock: session ${id} 不存在`)
    }
    pushSessionState(id)
    return { ...s }
  },

  /** 拉取 session 扩展命令（与 real domain 同接口，mock 返回 MOCK_COMMANDS） */
  async getCommands(id: string): Promise<{ sessionId: string; commands: typeof MOCK_COMMANDS }> {
    await sleep(TIMING.ack)
    return { sessionId: id, commands: MOCK_COMMANDS.map((c) => ({ ...c })) }
  },

  /** 拉取上下文用量（mock 返回固定示例值，与 real domain 同接口；usage 字段 optional = 无值语义，D1） */
  async getContext(id: string): Promise<{ sessionId: string; inputTokens?: number; contextLimit?: number; usagePercent?: number }> {
    await sleep(TIMING.ack)
    return { sessionId: id, inputTokens: 12000, contextLimit: 200000, usagePercent: 6 }
  },

  async rename(sessionId: string, label: string): Promise<void> {
    await sleep(TIMING.ack)
    const target = fixtureSessions.find((s) => s.id === sessionId)
    if (!target) throw new Error(`mock: session ${sessionId} 不存在`)
    target.label = label
    // 模拟 runtime rename 后 broadcastSessionList
    pushSessionList()
  },

  /** Mock：归入项目（D14 语义修正）——与 real session.setProject 同构，更新归属 + 广播。 */
  async setProject(sessionId: string, projectId: string): Promise<void> {
    await sleep(TIMING.ack)
    const target = fixtureSessions.find((s) => s.id === sessionId)
    if (!target) throw new Error(`mock: session ${sessionId} 不存在`)
    target.projectId = projectId || undefined
    pushSessionList()
  },

  async remove(sessionId: string): Promise<void> {
    await sleep(TIMING.ack)
    const idx = fixtureSessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) throw new Error(`mock: session ${sessionId} 不存在`)
    fixtureSessions.splice(idx, 1)
    delete fixtureMessages[sessionId]
    // 模拟 runtime delete 后 broadcastSessionList
    pushSessionList()
  },

  /**
   * Mock：folder 维度批量删除（与 real session.removeByCwd 同构）。
   * best-effort 聚合 deleted/failed——mock 永远成功（fixture 删除不抛），failed 始终空。
   */
  async removeByCwd(cwd: string): Promise<BatchDeleteResult> {
    await sleep(TIMING.ack)
    const targets = fixtureSessions.filter((s) => s.cwd === cwd)
    const deleted: string[] = []
    for (const s of targets) {
      // 与 remove() 一致：findIndex 守卫 idx===-1，避免 splice(-1) 误删末尾元素。
      // targets 是 filter 快照（迭代安全），splice 在原 fixtureSessions 上原地删。
      const idx = fixtureSessions.findIndex((x) => x.id === s.id)
      if (idx === -1) continue
      fixtureSessions.splice(idx, 1)
      delete fixtureMessages[s.id]
      deleted.push(s.id)
    }
    // 模拟 runtime deleteByCwd 后单次 broadcastSessionList
    pushSessionList()
    return { cwd, deleted, failed: [] }
  },

  /** 设置思考等级（mock：持久到 fixture session.thinkingLevel；回执生效值形状对齐协议修型 U6） */
  async setThinkingLevel(sessionId: string, level: string): Promise<{ sessionId: string; level: string }> {
    await sleep(TIMING.ack)
    const target = fixtureSessions.find((s) => s.id === sessionId)
    if (target) target.thinkingLevel = level
    return { sessionId, level }
  },

  /**
   * Mock subagent 列表。
   * s3（E2E 默认激活 session）返回 fixture，其他 session 返回空——
   * 让 E2E 能验证「切 session 后列表刷新」（切到无数据 session 看空态，切回 s3 看列表）。
   */
  async getSubagents(sessionId: string): Promise<SubagentRecord[]> {
    await sleep(TIMING.ack)
    return sessionId === 's3' ? fixtureSubagents.map((s) => ({ ...s })) : []
  },

  /** Mock subagent 对话流历史（返回空数组，agent call 对话流由 getAgentCallHistory 覆盖） */
  async getSubagentHistory(_sessionId: string, _subagentId: string): Promise<Message[]> {
    await sleep(TIMING.ack)
    return []
  },

  /**
   * Mock workflow 列表。
   * s3 返回 fixture，其他 session 返回空——同 getSubagents 的区分逻辑。
   */
  async getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]> {
    await sleep(TIMING.ack)
    return sessionId === 's3' ? fixtureWorkflows.map((w) => ({ ...w })) : []
  },

  /** Mock agent call 对话流历史（返回空数组，drawer SubagentTab agentcall 分支加载不 throw 即可） */
  async getAgentCallHistory(_sessionId: string, _agentCallSessionId: string): Promise<Message[]> {
    await sleep(TIMING.ack)
    return []
  },

  /**
   * Mock agent call 对话流 JSONL 路径解析（[G4 锚定补齐]：锚定前 mock 缺此成员，门面三元
   * 下不可达）。real 按 trace 找不到返回空串（展示型功能不 throw），mock 恒 '' 同形。
   */
  async getAgentCallFilePath(_sessionId: string, _agentCallSessionId: string): Promise<string> {
    await sleep(TIMING.ack)
    return ''
  },

  /**
   * Mock 子代理引擎配置视图（[G4 锚定补齐]：锚定前 mock 缺此成员）。mock 无 engines.json
   * 基建，返回空清单 + 空 default（Settings「子代理」页 mock 轨展示空态）。
   */
  async getSubagentEngineConfig(): Promise<{ engines: string[]; defaultEngine: string }> {
    await sleep(TIMING.ack)
    return { engines: [], defaultEngine: '' }
  },

  /** Mock 设置默认子代理引擎（回执 = 请求值回显，对齐 model.switchModel mock 同模式；无持久化） */
  async setSubagentDefaultEngine(engineId: string): Promise<{ engineId: string }> {
    await sleep(TIMING.ack)
    return { engineId }
  },

  /** Mock workflow 操作（abort；pause/resume 已随扩展 D-2 移除。E2E 不断言此路径，stub resolve 即可） */
  async workflowAction(_sessionId: string, _action: 'abort', _runId: string): Promise<void> {
    await sleep(TIMING.ack)
  },

  /** Mock subagent 生命周期/定向消息操作（对称 workflowAction，stub resolve 即可） */
  async subagentAction(
    _sessionId: string,
    _action: 'cancel' | 'message' | 'start',
    _params: { subagentId?: string; text?: string; slug?: string; task?: string },
  ): Promise<void> {
    await sleep(TIMING.ack)
  },

  /**
   * Mock handoff（fast-handoff：stub resolve 即可，E2E 走 runtime 真路径）。
   * [G4 锚定 SessionDomain] options 形参补齐与 real 域全等；mock 不支持仿真——无 runtime
   * HandoffService / handoff turn 可跑，modelOverride/thinkingOverride 无生效面（显式登记，
   * 非静默丢弃；登记同步 docs/TEST-STRATEGY.md §5 mock 保真度表）。
   */
  async handoff(_sessionId: string, _reply?: string, _options?: { modelOverride?: string; thinkingOverride?: string }): Promise<void> {
    await sleep(TIMING.ack)
  },

  /** Mock 取消 handoff（对称 handoff，stub resolve 即可） */
  async abortHandoff(_sessionId: string): Promise<void> {
    await sleep(TIMING.ack)
  },

  /** Mock 强制退出（对称 real domain，stub resolve 即可；mock 无真实 pi 进程可杀） */
  async forceQuit(_sessionId: string): Promise<void> {
    await sleep(TIMING.ack)
  },

  /**
   * Mock subscribe（runtime-message-bus wave:renderer-subscribe）：与 real session.subscribe 同接口。
   * mock 模式无真实 bus ring，返回空 snapshot + stateSnapshot + lastSeq=0（无历史可回放）。
   * 不抛错——保持与 real domain 签名同构（facade 三元要求），renderer 的 reconcile 路径在 mock 下走空 snapshot + stateSnapshot。
   */
  async subscribe(_sessionId: string, _fromSeq?: number): Promise<{ snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap?: boolean }> {
    await sleep(TIMING.ack)
    return { snapshot: [], stateSnapshot: [], lastSeq: 0 }
  },

  /** Mock unsubscribe（对称 subscribe，ack 型 stub resolve 即可） */
  async unsubscribe(_sessionId: string): Promise<void> {
    await sleep(TIMING.ack)
  },

  // ── wave:runtime-patch ipc-converge-a3 W2：业务持久化写 stub（与 real domain 同接口）──
  /** Mock writeImage：返伪造落地结果（path/fileName/displayName/id/persisted）。 */
  async writeImage(payload: { sessionId: string; base64: string; mimeType: string; name: string }): Promise<{ path: string; fileName: string; displayName: string; id: string; persisted: boolean }> {
    await sleep(TIMING.ack)
    return {
      path: `/mock/attachments/${payload.sessionId || 'landing'}/mock-image.png`,
      fileName: 'mock-image.png',
      displayName: payload.name || 'mock-image.png',
      id: 'mock-image-id',
      persisted: !!payload.sessionId,
    }
  },
  /** Mock migrateImage：返 fromPath（不实际迁移）。 */
  async migrateImage(payload: { fromPath: string; sessionId: string; fileName: string }): Promise<{ path: string }> {
    await sleep(TIMING.ack)
    return { path: payload.fromPath }
  },
  /** Mock writeSegments：ack 型 stub resolve（void）。 */
  async writeSegments(_payload: { sessionId: string; entry: import('@taiji/shared').SegmentsMetadataEntry }): Promise<void> {
    await sleep(TIMING.ack)
  },
  // ── 导入会话（import-session U5 → sess-session-import u-foundation 多源扩展；与
  //     real domain 同接口，门面三元要求两侧同构；r1-S19：payload 类型 import shared
  //     契约，不手写内联形状）──
  /**
   * Mock importCandidates：source 显式判别（与 importSession 分支策略收敛，r-审查
   * P3——real 侧 resolveSource 未知 source 抛 import_source_missing，mock 否决式分支
   * 曾把缺省/pi/未知合并返回空集不同构）：缺省/'pi' 恒空候选集（mock 轨道无外部
   * pi sessions 目录可扫）；'zcode' 返回硬编码 zcode 形态候选（sess_ 前缀
   * sessionId + dirLabel 聚合，驱动导入对话框两阶段视图 mock 模式开发）；其余字面量
   * （WS JSON 注入的类型外运行时值）抛 import_source_missing。不模拟 query 过滤——
   * 与 pi 分支不模拟目录扫描同保真度层级（mock 只驱动 UI 状态机）。
   */
  async importCandidates(payload: import('@taiji/shared').ImportCandidatesRequest): Promise<import('@taiji/shared').ImportCandidatesReply> {
    await sleep(TIMING.ack)
    const source = payload.source ?? 'pi'
    if (source === 'zcode') {
      const items = zcodeMockCandidates()
      // dirs 按 dirLabel 聚合 count（zcode 源 dirs 聚合规则：basename(directory) 分组）
      const countByLabel = new Map<string, number>()
      for (const item of items) countByLabel.set(item.dirLabel, (countByLabel.get(item.dirLabel) ?? 0) + 1)
      const dirs = Array.from(countByLabel, ([label, count]) => ({ label, count }))
      return { total: items.length, items, dirs }
    }
    if (source === 'pi') {
      return { total: 0, items: [], dirs: [] }
    }
    throw Object.assign(new Error('No external sessions available in mock mode'), { code: 'import_source_missing' })
  },
  /**
   * Mock importSession：source='zcode' 返回固定 reply——reply.sessionId = T1 归一化
   * 形态（剥 sess_ 前缀 + '_'→'-'，对齐契约「reply.sessionId 与侧边栏/扫描集同域，
   * 非请求传入的原始 sess_ 形态」）；payload.sessionId 缺省回退首条候选 id。缺省/
   * pi/未知 source 维持现状 reject import_source_missing（空候选集下不可达，供 UI
   * 错误态演示，与 fetchCurrentSystemPrompt 同形）。
   */
  async importSession(payload: import('@taiji/shared').ImportRequest): Promise<import('@taiji/shared').ImportReply> {
    await sleep(TIMING.ack)
    if (payload.source !== 'zcode') {
      throw Object.assign(new Error('No external sessions available in mock mode'), { code: 'import_source_missing' })
    }
    const raw = payload.sessionId ?? ZCODE_MOCK_ROWS[0].sessionId
    const normalized = raw.replace(/^sess_/, '').replace(/_/g, '-')
    return { sessionId: normalized, targetPath: `/mock/taiji/sessions/zcode-demo/${normalized}.jsonl` }
  },
}

// [G4] 参数全等断言：mock session 任一方法少参/多参/错型（含 override 参数）在此行编译失败
export type SessionDomainParamsExact = AssertExact<DomainParamsExact<SessionDomain, typeof sessionImpl>>
export const session: SessionDomain = sessionImpl

/**
 * W7（PR#116 review）：按命令关键字分流 mock bash 结果（success/error/empty/timeout 四态）。
 *
 * - happy path（默认）：exitCode:0 + '(mock) <command>'（保留原行为）
 * - 命令含 'fail' → error：exitCode:1 + 'command not found'（覆盖错误态视觉）
 * - 命令含 'empty' → empty-output：exitCode:0 + ''（覆盖空输出态）
 * - 命令含 'timeout' → 近似超时：cancelled:true + exitCode:null（覆盖取消态视觉；
 *   bashResultEffect 构造 entry 不读 error 字段、mock 无法注入 error:'timeout'
 *   标记（原写方 bash timer 收口已随 dormant 契约删除），用 cancelled 近似 + 长 delay
 *   模拟超时节奏）
 * - 命令含 'truncate' → truncated:true（覆盖 W4 截断标记视觉）
 *
 * delay 是 bashStart→bashResult 间隔，让 streaming loading 态可见。
 */
// result 锚定 protocol 契约（ServerMessageMap['message.bashResult'] 的分支可变字段子集）——
// spread 进 payload 后由 map 登记静态校验（emit 参数为分发联合，缺字段即编译错）
function resolveBashMockBranch(
  command: string,
): { result: Pick<ServerMessageMap['message.bashResult'], 'output' | 'exitCode' | 'cancelled' | 'truncated'>; delay: number } {
  const cmd = command.toLowerCase()
  // delay 是 bashStart→bashResult 间隔，让 streaming loading 态可见（bashDelay 默认 2s，
  // 测试经 setMockTiming 压缩）；timeout 分支 +1s 强调 timer 到期节奏（默认合计 3s）
  if (cmd.includes('timeout')) {
    return {
      result: { output: '', exitCode: null, cancelled: true, truncated: false },
      delay: TIMING.bashDelay + MOCK_BASH_TIMEOUT_EXTRA_MS,
    }
  }
  if (cmd.includes('fail')) {
    return {
      result: { output: 'command not found: fail-demo', exitCode: 1, cancelled: false, truncated: false },
      delay: TIMING.bashDelay,
    }
  }
  if (cmd.includes('empty')) {
    return {
      result: { output: '', exitCode: 0, cancelled: false, truncated: false },
      delay: TIMING.bashDelay,
    }
  }
  if (cmd.includes('truncate')) {
    return {
      result: { output: '(mock) long output demo…', exitCode: 0, cancelled: false, truncated: true },
      delay: TIMING.bashDelay,
    }
  }
  return {
    result: { output: `(mock) ${command}`, exitCode: 0, cancelled: false, truncated: false },
    delay: TIMING.bashDelay,
  }
}

const chatImpl = {
  /**
   * 拉 session 历史（深拷贝 fixture，避免外部突变污染）。
   * [u6] 窗口契约字段必填（legacy historyTruncated 退役，偏差表 D7 双轨收口）；mock 无截断
   * （truncated=false，loadedTurns 数 fixture user 消息）。query 游标参数 mock 不模拟翻页
   * （fixture 无窗口概念，恒返回全量——与 truncated=false 一致）；类型引 real 域 HistoryQuery
   *（G4 锚定，杜绝内联形状漂移）。
   */
  async getHistory(sessionId: string, _query?: realChatDomain.HistoryQuery): Promise<{ messages: Message[]; truncated: boolean; loadedTurns: number; totalTurnsEstimate: number }> {
    await sleep(TIMING.ack)
    const messages = (fixtureMessages[sessionId] ?? []).map((m) => ({ ...m }))
    return { messages, truncated: false, loadedTurns: messages.filter((m) => m.role === 'user').length, totalTurnsEstimate: messages.filter((m) => m.role === 'user').length }
  },

  // options.clientUuid（session-occupancy D2）：mock 不模拟 send.rejected，参数仅签名对齐
  // real 域（门面三元要求两侧同构），运行时忽略。
  async send(
    sessionId: string,
    text: string,
    _images?: Array<{ data: string; mimeType: string }>,
    _options?: { clientUuid?: string },
  ): Promise<void> {
    cancelled.delete(sessionId)
    // ack 语义：仅模拟 pi 接收命令，立即 resolve；流式序列 fire-and-forget（不 await）。
    // isStreaming 由 message_start/complete 事件驱动（useChat.ts），不受此处 resolve 时机影响，
    // 故 Composer :disabled=isSending 不会全程 true，流式中可 steer/retry。
    await sleep(TIMING.ack)
    void runSendStream(sessionId, text, {
      nextId,
      emit,
      sleep,
      pushSession,
      isCancelled: (s) => cancelled.has(s),
      TIMING,
    })
  },

  /**
   * compact（#6）：模拟 session.compact 生命周期（compacting → compacted）。
   * [G4 锚定 ChatDomain] customInstructions 形参补齐与 real 域全等；mock 不支持仿真——
   * 无 pi 会话可挂自定义压缩指令（显式登记，非静默丢弃）。
   * 不推 compactionSummary——那是 pi 自主压缩才推的 system 行，与用户主动 /compact 语义不同
   * （§4.4：compactionSummary 走 message.compactionSummary，由 pi 驱动，mock 捆绑会造成语义混淆）。
   */
  async compact(sessionId: string, _customInstructions?: string): Promise<void> {
    await sleep(TIMING.ack)
    emit(sessionId, { type: 'session.compacting', payload: { sessionId, status: 'compacting', reason: 'manual' } })
    await sleep(TIMING.fileChangesGap)
    emit(sessionId, { type: 'session.compacted', payload: { sessionId, status: 'compacted' } })
  },

  async abort(sessionId: string): Promise<void> {
    // 标记取消，send 循环下一轮检测后退出
    cancelled.add(sessionId)
    emit(sessionId, {
      type: 'message.complete',
      payload: { sessionId, stopReason: 'aborted' },
    })
    await sleep(TIMING.ack)
  },

  // bash 执行（composer-bash-execute）：mock 模式 ack + 广播 bashStart 后，按命令关键字分流
  // 模拟 success/error/empty/timeout 四态（W7 PR#116 review）+ bashStart→bashResult 间 mockDelay
  // 让开发者能看到 loading 态（spinner + 取消按钮）。
  // 不模拟真实 shell 输出（与 send 的 mock 策略一致——只驱动 UI 状态机，不验证业务逻辑）。
  // happy path：普通命令 → exitCode:0 + '(mock) <command>'（保留原有行为，不破坏）。
  async bash(sessionId: string, command: string, excludeFromContext?: boolean): Promise<void> {
    await sleep(TIMING.ack)
    emit(sessionId, {
      type: 'message.bashStart',
      payload: { sessionId, command, excludeFromContext: !!excludeFromContext, timestamp: Date.now() },
    })
    // bashStart→bashResult 间 mockDelay 让 loading 态可见（W1 entry 化后 bashStart 写
    // ephemeral executingBash 瞬时执行反馈，非消息数组项）。timeout 分支用更长 delay 模拟
    // 超时节奏（真实 error:'timeout' 无 mock 可注入的写方——bashResultEffect 构造
    // bashExecution entry 不含 error 字段，此处只能用 cancelled:true 近似）。
    const branch = resolveBashMockBranch(command)
    await sleep(branch.delay)
    emit(sessionId, {
      type: 'message.bashResult',
      payload: {
        sessionId,
        command,
        ...branch.result,
        excludeFromContext: !!excludeFromContext,
        timestamp: Date.now(),
      },
    })
  },

  async abortBash(sessionId: string): Promise<void> {
    await sleep(TIMING.ack)
    emit(sessionId, {
      type: 'message.bashResult',
      payload: {
        sessionId,
        command: '',
        output: '',
        exitCode: null,
        cancelled: true,
        truncated: false,
        excludeFromContext: false,
        timestamp: Date.now(),
      },
    })
  },

  /**
   * steer：ack 后推 queue_update（steering 入队），延迟后模拟 drain（pi 投递：splice 移除 + emit）。
   * 入队 → QueueBubble 渲染；drain → drainPending 取 segments + appendUser（complete user 进对话流）。
   * drain 时机简化为固定延迟（真实 pi 在「当前回合工具调用结束后、下次 LLM 调用前」）。
   */
  async steer(sessionId: string, text: string): Promise<void> {
    await sleep(TIMING.ack)
    const q = mockQueues.get(sessionId) ?? { steering: [], followUp: [] }
    q.steering.push(text)
    mockQueues.set(sessionId, q)
    emitQueueUpdate(sessionId)
    // 延迟模拟 drain（投递后移除该项）+ 补发 assistant turn（m4：避免 dangling streaming bubble）
    const t = setTimeout(() => {
      const cur = mockQueues.get(sessionId)
      if (!cur || cancelled.has(sessionId)) return
      const idx = cur.steering.indexOf(text)
      if (idx !== -1) cur.steering.splice(idx, 1)
      emitQueueUpdate(sessionId)
      void emitDrainAssistantTurn(sessionId, text)
    }, TIMING.steerDrain)
    timers.add(t)
  },

  /** followUp：ack 后推 queue_update（followUp 入队），延迟后模拟 drain。语义同 steer。 */
  async followUp(sessionId: string, text: string): Promise<void> {
    await sleep(TIMING.ack)
    const q = mockQueues.get(sessionId) ?? { steering: [], followUp: [] }
    q.followUp.push(text)
    mockQueues.set(sessionId, q)
    emitQueueUpdate(sessionId)
    const t = setTimeout(() => {
      const cur = mockQueues.get(sessionId)
      if (!cur || cancelled.has(sessionId)) return
      const idx = cur.followUp.indexOf(text)
      if (idx !== -1) cur.followUp.splice(idx, 1)
      emitQueueUpdate(sessionId)
      void emitDrainAssistantTurn(sessionId, text)
    }, TIMING.steerDrain)
    timers.add(t)
  },

  streamSubscribe(sessionId: string, handler: (msg: ServerMessageUnion) => void): () => void {
    let set = streamHandlers.get(sessionId)
    if (!set) {
      set = new Set()
      streamHandlers.set(sessionId, set)
    }
    set.add(handler)
    return () => {
      streamHandlers.get(sessionId)?.delete(handler)
    }
  },
}

// [G4] 参数全等断言：mock chat 任一方法少参/多参/错型在此行编译失败
export type ChatDomainParamsExact = AssertExact<DomainParamsExact<ChatDomain, typeof chatImpl>>
export const chat: ChatDomain = chatImpl

/* ── Config mock（请求 + 订阅 + 动作）── */

// 订阅型 sub（注册即触发初始值）；请求型直接返 fixture 深拷贝
// fixture 快照深拷贝（provider 与 model 层各自展开）——mock 快照隔离策略单点
function cloneFixtureProviders() {
  return fixtureProviders.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) }))
}
// 带 scopedModels 的 providers 广播（config.providers payload 扩展）
const providersSubWithScoped = makeMockSubscription(() => ({
  providers: cloneFixtureProviders(),
  // 与 listProviders / broadcastProviders 同源（setScopedModels 后订阅初始推送一致）
  scopedModels: [...mockScopedModels],
}))
const skillsSub = makeMockSubscription(() => fixtureSkills.map((s) => ({ ...s })))
const agentsSub = makeMockSubscription(() => fixtureAgents.map((a) => ({ ...a })))
const defaultsSub = makeMockSubscription(() => 'Anthropic/claude-sonnet-4.5')

// ADR-0021 §1 discovery 加载路径配置（v2 嵌套 project/global，UI 层 A 勾选/↑↓ 用）。
// preset 直接引 shared SSOT（PRESET_*_DIRS），scope 按路径特征拆（相对→project / ~或/开头→global），
// 消除此前本地副本漂移（旧副本含已移除的 ~/.claude/* 与不存在的 .agents/extensions）。
const isGlobalShape = (p: string): boolean => p.startsWith('/') || p.startsWith('~')
const splitPreset = (preset: readonly string[]): { project: string[]; global: string[] } => ({
  project: preset.filter((p) => !isGlobalShape(p)),
  global: preset.filter(isGlobalShape),
})
const PRESET_SKILL_DIRS_PROJECT = splitPreset(PRESET_SKILL_DIRS).project
const PRESET_SKILL_DIRS_GLOBAL = splitPreset(PRESET_SKILL_DIRS).global
const PRESET_AGENT_DIRS_PROJECT = splitPreset(PRESET_AGENT_DIRS).project
const PRESET_AGENT_DIRS_GLOBAL = splitPreset(PRESET_AGENT_DIRS).global
const PRESET_EXTENSION_DIRS_PROJECT = splitPreset(PRESET_EXTENSION_DIRS).project
const PRESET_EXTENSION_DIRS_GLOBAL = splitPreset(PRESET_EXTENSION_DIRS).global

/** scoped 路径组 → SkillDirConfig[]（全部 enabled，对齐 runtime 默认态 = preset 全勾）。 */
const toEnabledConfigs = (scoped: { projectPaths: readonly string[]; globalPaths: readonly string[] }): SkillDirConfig[] => [
  ...scoped.projectPaths.map((path) => ({ path, enabled: true, scope: 'project' as const })),
  ...scoped.globalPaths.map((path) => ({ path, enabled: true, scope: 'global' as const })),
]

// v2 mock 当前态：完整 SkillDirConfig[]（含 enabled + scope）。初始 fixture = 默认态
// （DEFAULT_DISCOVERY_CONFIG，pi+taiji 全勾，与 runtime ENOENT 回落一致），
// 顺序与 runtime buildDirConfigs 一致（project.enabled → global.enabled → ...）。
// setSkillDirs 等整体透传 SkillDirConfig[]（v2 scope 穿越路 A，不降维为 string[]）。
let mockSkillDirs: SkillDirConfig[] = toEnabledConfigs(DEFAULT_DISCOVERY_CONFIG.skill)
let mockAgentDirs: SkillDirConfig[] = toEnabledConfigs(DEFAULT_DISCOVERY_CONFIG.agent)
// extension 默认同样全勾（与 runtime 默认态一致）
let mockExtensionDirs: SkillDirConfig[] = toEnabledConfigs(DEFAULT_DISCOVERY_CONFIG.extension)

/**
 * v2 buildMockDirConfigs：产带 scope 的 SkillDirConfig[]，顺序对齐 runtime buildDirConfigs
 * `[project.enabled → global.enabled → project 未启用 → global 未启用]`（项目优先级 > 全局）。
 * current 是用户最新下发的完整态；preset 中缺失的路径补为 enabled:false（scope 按所属组）。
 */
function buildMockDirConfigs(
  current: SkillDirConfig[],
  presetProject: string[],
  presetGlobal: string[],
): SkillDirConfig[] {
  const byKey = new Map<string, SkillDirConfig>()
  for (const d of current) byKey.set(d.path, { ...d })
  for (const path of presetProject) {
    if (!byKey.has(path)) byKey.set(path, { path, enabled: false, scope: 'project' })
  }
  for (const path of presetGlobal) {
    if (!byKey.has(path)) byKey.set(path, { path, enabled: false, scope: 'global' })
  }
  const all = [...byKey.values()]
  const pick = (scope: 'project' | 'global', enabled: boolean) =>
    all.filter((d) => d.scope === scope && d.enabled === enabled)
  return [...pick('project', true), ...pick('global', true), ...pick('project', false), ...pick('global', false)]
}
const skillDirsSub = makeMockSubscription(() => buildMockDirConfigs(mockSkillDirs, PRESET_SKILL_DIRS_PROJECT, PRESET_SKILL_DIRS_GLOBAL).map((d) => ({ ...d })))
const agentDirsSub = makeMockSubscription(() => buildMockDirConfigs(mockAgentDirs, PRESET_AGENT_DIRS_PROJECT, PRESET_AGENT_DIRS_GLOBAL).map((d) => ({ ...d })))
const extensionDirsSub = makeMockSubscription(() => buildMockDirConfigs(mockExtensionDirs, PRESET_EXTENSION_DIRS_PROJECT, PRESET_EXTENSION_DIRS_GLOBAL).map((d) => ({ ...d })))

/** 默认系统提示词配置（与 W7 system-prompt-page.test defaultConfig 同构）。 */
function defaultSystemPromptConfig(): SystemPromptConfig {
  return {
    version: 1,
    replace: { enabled: false, prompt: '' },
    append: { enabled: false, prompt: '' },
  }
}
// 系统提示词配置订阅（模拟 config.systemPrompt 广播；初始推默认配置，corrupted=false）。
const systemPromptSub = makeMockSubscription(() => ({ config: defaultSystemPromptConfig(), corrupted: false }))

/** 默认终端配置（Phase 6）。 */
function defaultTerminalConfig(): TerminalConfig {
  return {
    version: 1,
    shell: '',
    shellArgs: [],
    fontSize: 14,
    fontFamily: '',
    scrollback: 1000,
    cursorStyle: 'block',
    bell: false,
  }
}
// 终端配置订阅（模拟 config.terminalConfig 广播；初始推默认配置，corrupted=false）。
const terminalSub = makeMockSubscription(() => ({ config: defaultTerminalConfig(), corrupted: false }))

const configImpl = {
  // 请求型：直接返 fixture 深拷贝（不依赖 sub）。
  // scoped-model D7：与真实门面同形返回 { providers, scopedModels }，scopedModels 与
  // broadcastProviders 同源（mockScopedModels，setScopedModels 后保持一致）。
  async listProviders() {
    await sleep(TIMING.ack)
    return {
      providers: cloneFixtureProviders(),
      scopedModels: [...mockScopedModels],
    }
  },
  // wave 3：内置 provider 模板。mock 模式不接 runtime generated JSON，返空数组保持签名同构（facade 三元）。
  async listBuiltinProviders(): Promise<BuiltinProviderTemplate[]> {
    await sleep(TIMING.ack)
    return []
  },
  // 远程模型目录按需刷新：mock 无网络层，空结果保持签名同构（facade 三元）。
  async refreshProviderCatalogs(): Promise<{ refreshed: string[]; failed: Array<{ providerId: string; reason: string }> }> {
    await sleep(TIMING.ack)
    return { refreshed: [], failed: [] }
  },
  // wave-env-check：env 检测。mock 读 process.env 同构（浏览器 mock 下多为未设置）。
  async checkEnvVars(names: string[]): Promise<Record<string, boolean>> {
    await sleep(TIMING.ack)
    const results: Record<string, boolean> = {}
    for (const name of names) {
      const proc = (globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined
      const v = proc?.env?.[name]
      results[name] = v !== undefined && v !== ''
    }
    return results
  },
  // wave-oauth-infra：OAuth RPC。mock 模式无 runtime flow（无真实授权），返回 started 失败提示签名同构。
  async oauthLogin(_providerId: string): Promise<{ started: boolean; error?: string }> {
    await sleep(TIMING.ack)
    return { started: false, error: 'mock 模式不支持 OAuth 授权' }
  },
  async oauthCancel(_providerId: string): Promise<{ cancelled: boolean }> {
    await sleep(TIMING.ack)
    return { cancelled: false }
  },
  // B-1 场景 C：退出登录。mock 模式无真实 auth.json，幂等直接成功（签名同构）。
  async oauthLogout(_providerId: string): Promise<{ ok: boolean; error?: string }> {
    await sleep(TIMING.ack)
    return { ok: true }
  },
  // MF-1：mock 模式无真实 auth.json，恒 false（不默认 oauth radio）。
  async hasOAuth(_providerId: string): Promise<boolean> {
    return false
  },
  // OAuth 事件订阅：mock 不推送，返回 no-op unsubscribe 保持签名同构。
  // payload 类型引 real 域导出别名（锚定曾抓出 onAuthSuccess 内联手抄缺 oauthName? 字段——杜绝再漂移）
  onAuthDeviceCode: (_h: (payload: realConfigDomain.AuthDeviceCodePayload) => void) => () => {},
  onAuthAuthUrl: (_h: (payload: realConfigDomain.AuthAuthUrlPayload) => void) => () => {},
  onAuthSuccess: (_h: (payload: realConfigDomain.AuthSuccessPayload) => void) => () => {},
  onAuthError: (_h: (payload: realConfigDomain.AuthErrorPayload) => void) => () => {},
  // [G4 锚定 ConfigDomain] req 形状与 real 全等（含 mode?: 'test' | 'discover'——锚定抓出
  // mock 缺该键）。mock 无网络发现层，恒返回空模型集 + success（真实发现由 runtime 驱动）。
  async discoverModels(req: { baseUrl: string; apiKey?: string; providerType?: string; providerId?: string; mode?: 'test' | 'discover' }) {
    await sleep(TIMING.ack)
    void req
    // mock：返回空模型集 + success（真实发现由 runtime discoverModelsFromApi 驱动）
    return { success: true, models: [], error: undefined }
  },
  // 订阅型（handler 类型与 real domains 对齐：facade 三元要求两侧同构）
  onProviders: (h: (providers: ProviderInfo[], scopedModels?: string[]) => void) => providersSubWithScoped.subscribe((p) => h(p.providers, p.scopedModels)),
  onSkills: (h: (skills: SkillInfo[]) => void) => skillsSub.subscribe(h),
  onAgents: (h: (agents: AgentInfo[]) => void) => agentsSub.subscribe(h),
  onDefaults: (h: (defaultModel: string) => void) => defaultsSub.subscribe(h),
  // P2：带 source 的 defaults 订阅（mock 广播不携带 source，source 恒 undefined）
  onDefaultsWithSource: (h: (payload: { defaultModel: string; source?: string }) => void) => defaultsSub.subscribe((defaultModel: string) => h({ defaultModel })),
  onSkillDirs: (h: (dirs: SkillDirConfig[]) => void) => skillDirsSub.subscribe(h),
  // Wave3：skill 缓存失效信号订阅。mock 模式无真实文件系统 watcher（不广播失效信号），
  // 返回 no-op unsubscribe 保持与 real domains 签名同构（facade 三元要求）。
  onSkillCacheInvalidated: (_h: (payload: SkillCacheInvalidatedPayload) => void) => () => {},
  onAgentDirs: (h: (dirs: SkillDirConfig[]) => void) => agentDirsSub.subscribe(h),
  onExtensionDirs: (h: (dirs: SkillDirConfig[]) => void) => extensionDirsSub.subscribe(h),
  // 动作型：mock 同构——更新 fixture 后经订阅广播推回（与 real sendInitialState/广播一致）
  async setProvider(providerId: ProviderId, data: SetProviderData) {
    await sleep(TIMING.ack)
    const target = fixtureProviders.find((p) => p.id === providerId)
    if (target) {
      // 合并透传字段（name/type/apiKey/baseUrl/models/enabled）
      if (data.name !== undefined) target.name = data.name
      if (data.type !== undefined) target.api = data.type
      if (data.baseUrl !== undefined) target.baseUrl = data.baseUrl
      if (data.enabled !== undefined) target.enabled = data.enabled
      if (data.apiKey !== undefined) target.apiKeySet = data.apiKey.length > 0
      if (data.models !== undefined) {
        target.models = data.models.map((m) => (typeof m === 'string' ? { id: m } : { ...m, id: m.id }))
      }
    }
    broadcastProviders()
  },
  async deleteProvider(providerId: ProviderId) {
    await sleep(TIMING.ack)
    const idx = fixtureProviders.findIndex((p) => p.id === providerId)
    if (idx >= 0) fixtureProviders.splice(idx, 1)
    broadcastProviders()
  },
  // wave4：provider 启用切换（写 enabledModels 白名单 mock）。与 runtime toggleProviderEnabled 对齐——
  // 乐观改本地 provider.enabled + 广播 provider 列表（mock 不模拟 enabledModels 白名单语义，简化处理）。
  async toggleProviderEnabled(providerId: ProviderId, enabled: boolean) {
    await sleep(TIMING.ack)
    const p = fixtureProviders.find((p) => p.id === providerId)
    if (p) p.enabled = enabled
    broadcastProviders()
  },
  // wave4：按体系移除 provider mock。catalog/custom 统一从 fixtureProviders 移除（mock 不区分体系语义）。
  async removeProviderByKind(providerId: ProviderId, _kind: 'catalog' | 'custom') {
    await sleep(TIMING.ack)
    const idx = fixtureProviders.findIndex((p) => p.id === providerId)
    if (idx >= 0) fixtureProviders.splice(idx, 1)
    broadcastProviders()
  },
  /**
   * 设默认模型（W3 协议 config.setDefaultModel 的 mock 对齐）。
   * 改 defaultsSub 内部值并广播 "provider/modelId" 复合串，与 runtime 广播 config.defaults 同构。
   * 状态经 onDefaults 订阅推回 settingsStore.defaultModel，前端无需本地乐观更新。
   */
  async setDefaultModel(provider: ProviderId, modelId: string) {
    await sleep(TIMING.ack)
    defaultsSub.broadcast(`${provider}/${modelId}`)
  },
  /**
   * 设置 scoped models 白名单（mock 对齐 runtime config.setScopedModels）。
   * 去重保序 → 更新 mockScopedModels → 广播 providers + scopedModels。
   * default 联动：列表非空时 default = scoped[0]，经 defaultsSub 广播 "provider/modelId"
   * 复合串（形态同 setDefaultModel mock；空列表不动 default，对齐 runtime S7 语义）。
   */
  async setScopedModels(models: string[]): Promise<string[]> {
    await sleep(TIMING.ack)
    // 去重保序（Set 迭代序 = 插入序）
    const deduped = [...new Set(models)]
    mockScopedModels = deduped
    broadcastProviders()
    if (deduped.length > 0) defaultsSub.broadcast(deduped[0])
    return deduped
  },
  /**
   * [G4 锚定 ConfigDomain] 返回类型补齐：real scanSkills 返回扫描结果 ScannedSkillInfo[]
   * （锚定前 mock 返回 void，调用方读返回值在 mock 轨静默 undefined）。mock 无真实文件系统
   * 扫描，返回空结果（空 sources 扫描的同形语义）；skillsSub 广播照旧驱动订阅演示。
   */
  async scanSkills(_sources: string[]): Promise<ScannedSkillInfo[]> {
    await sleep(TIMING.ack)
    // 扫描后广播当前 skills 快照（runtime scan 后会刷新 config.skills）
    skillsSub.broadcast(fixtureSkills.map((s) => ({ ...s })))
    return []
  },
  // W2（ADR-0051）：按 session cwd 拉 project skill。mock 返回空（mock 模式无真实文件系统扫描）。
  async scanSessionSkills(_cwd: string) {
    await sleep(TIMING.ack)
    return []
  },
  // W4（FR-5）：landing 全局 skill 走 skillRegistry globalCache。mock 返回 fixtureSkills（复用 settings-data）。
  async getGlobalSkills() {
    await sleep(TIMING.ack)
    return fixtureSkills.map((s) => ({ ...s }))
  },
  // W4：按 cwd 拉项目 skill（skillRegistry projectCache）。mock 返回空（无真实文件系统）。
  async getProjectSkills(_cwd: string) {
    await sleep(TIMING.ack)
    return []
  },
  /** ADR-0021 §1 目录级管道写入（v2 scope 穿越）：更新 mock skillDirs + 广播 skill 列表 + 目录配置 */
  async setSkillDirs(dirs: SkillDirConfig[]) {
    await sleep(TIMING.ack)
    mockSkillDirs = dirs.map((d) => ({ ...d }))
    skillDirsSub.broadcast(buildMockDirConfigs(mockSkillDirs, PRESET_SKILL_DIRS_PROJECT, PRESET_SKILL_DIRS_GLOBAL).map((d) => ({ ...d })))
    skillsSub.broadcast(fixtureSkills.map((s) => ({ ...s })))
  },
  async setSkill(skill: SkillInfo) {
    await sleep(TIMING.ack)
    const idx = fixtureSkills.findIndex((s) => s.id === skill.id)
    if (idx >= 0) fixtureSkills[idx] = { ...skill }
    skillsSub.broadcast(fixtureSkills.map((s) => ({ ...s })))
  },
  async deleteSkill(skillId: string) {
    await sleep(TIMING.ack)
    const idx = fixtureSkills.findIndex((s) => s.id === skillId)
    if (idx >= 0) fixtureSkills.splice(idx, 1)
    skillsSub.broadcast(fixtureSkills.map((s) => ({ ...s })))
  },
  /** [G4 锚定 ConfigDomain] 返回类型补齐（同 scanSkills——real 返回 ScannedAgentInfo[]，mock 无扫描返回空） */
  async scanAgents(_sources: string[]): Promise<ScannedAgentInfo[]> {
    await sleep(TIMING.ack)
    agentsSub.broadcast(fixtureAgents.map((a) => ({ ...a })))
    return []
  },
  /**
   * W1（cw-2026-07-26-migration-other-agents）：检测本机其他 agent 的 skill/agent 目录。
   * mock 返回空数组（无真实文件系统扫描）；UI 在 mock 模式下显示「未检测到候选」空态。
   */
  async detectSources() {
    await sleep(TIMING.ack)
    return []
  },
  /** W2：预览导入 provider。mock 返回示例 preview，让 preview→apply 演示链路完整可见。 */
  async previewImportProviders(source: ProviderSource): Promise<{ importId: string; preview: ProviderImportPreview }> {
    await sleep(TIMING.ack)
    const preview: ProviderImportPreview = {
      source,
      providers: [{
        id: 'demo-provider',
        name: 'Demo Provider',
        protocol: 'openai-completions',
        modelCount: 1,
        apiKeyExtracted: true,
        credentialType: 'plaintext',
        conflict: 'none',
        warnings: [],
      }],
    }
    return { importId: 'mock-import-id', preview }
  },
  /** W2：应用导入。mock 触发广播让前端演示看到列表刷新（模拟 runtime apply 后 broadcastProviderList）。 */
  async applyImportProviders(_importId: string, _selectedIds: string[]): Promise<{ result: ProviderImportResult }> {
    await sleep(TIMING.ack)
    // mock 演示：追加一个示例导入 provider 让列表刷新可见
    const mockImported: ProviderImportedItem = {
      id: 'imported-demo',
      name: 'Imported Demo',
      status: 'imported',
    }
    // 这里不真的改 fixtureProviders（mock preview 返回空，无真实 selectedIds 对应），
    // 但触发广播让前端演示看到列表刷新（模拟 runtime apply 后 broadcastProviderList）
    broadcastProviders()
    return { result: { source: 'pi' as ProviderSource, imported: [mockImported], failedCount: 0 } }
  },
  /** ADR-0021 §1 目录级管道写入（v2 scope 穿越）：更新 mock agentDirs + 广播 agent 列表 + 目录配置 */
  async setAgentDirs(dirs: SkillDirConfig[]) {
    await sleep(TIMING.ack)
    mockAgentDirs = dirs.map((d) => ({ ...d }))
    agentDirsSub.broadcast(buildMockDirConfigs(mockAgentDirs, PRESET_AGENT_DIRS_PROJECT, PRESET_AGENT_DIRS_GLOBAL).map((d) => ({ ...d })))
    agentsSub.broadcast(fixtureAgents.map((a) => ({ ...a })))
  },
  /** Phase 4 目录级管道写入（v2 scope 穿越）：更新 mock extensionDirs + 广播目录配置（靠后端权威值推回） */
  async setExtensionDirs(dirs: SkillDirConfig[]) {
    await sleep(TIMING.ack)
    mockExtensionDirs = dirs.map((d) => ({ ...d }))
    extensionDirsSub.broadcast(buildMockDirConfigs(mockExtensionDirs, PRESET_EXTENSION_DIRS_PROJECT, PRESET_EXTENSION_DIRS_GLOBAL).map((d) => ({ ...d })))
  },
  async setAgent(agent: AgentInfo) {
    await sleep(TIMING.ack)
    const idx = fixtureAgents.findIndex((a) => a.id === agent.id)
    if (idx >= 0) fixtureAgents[idx] = { ...agent }
    agentsSub.broadcast(fixtureAgents.map((a) => ({ ...a })))
  },
  async deleteAgent(agentId: string) {
    await sleep(TIMING.ack)
    const idx = fixtureAgents.findIndex((a) => a.id === agentId)
    if (idx >= 0) fixtureAgents.splice(idx, 1)
    agentsSub.broadcast(fixtureAgents.map((a) => ({ ...a })))
  },
  // ── 系统提示词配置（W6 FR-4/FR-5，与 real domains/config 同构）──
  // mock 持内存默认配置；setSystemPrompt 广播 config.systemPrompt，与 runtime 行为一致。
  async getSystemPrompt() {
    await sleep(TIMING.ack)
    return { config: defaultSystemPromptConfig(), corrupted: false }
  },
  async setSystemPrompt(cfg: SystemPromptConfig) {
    await sleep(TIMING.ack)
    const next = { config: cfg, corrupted: false }
    systemPromptSub.broadcast(next)
    return next
  },
  onSystemPrompt: (h: (config: SystemPromptConfig, corrupted: boolean) => void) =>
    systemPromptSub.subscribe((p) => h(p.config, p.corrupted)),
  // ── 终端配置（Phase 6，与 real domains/config 同构）──
  // mock 持内存默认配置；setTerminalConfig 广播 config.terminalConfig，与 runtime 行为一致。
  async getTerminalConfig() {
    await sleep(TIMING.ack)
    return { config: defaultTerminalConfig(), corrupted: false }
  },
  async setTerminalConfig(cfg: TerminalConfig) {
    await sleep(TIMING.ack)
    const next = { config: cfg, corrupted: false }
    terminalSub.broadcast(next)
    return next
  },
  onTerminalConfig: (h: (config: TerminalConfig, corrupted: boolean) => void) =>
    terminalSub.subscribe((p) => h(p.config, p.corrupted)),
  // ── 重试配置（[G4 锚定补齐]：锚定前 mock 缺 getRetryConfig/setRetryConfig/onRetryConfig，
  //    Settings 重试页在 mock 轨调用会 crash）──
  // mock 内存态 stub：get 恒 configured=false（无 config.json 条目的同形语义）、set 回显
  // configured=true；不持久化、不广播（onRetryConfig no-op）——登记 docs/TEST-STRATEGY.md §5。
  async getRetryConfig(): Promise<{ config: LlmRetryConfig; configured: boolean }> {
    await sleep(TIMING.ack)
    return { config: mockRetryConfig, configured: false }
  },
  async setRetryConfig(config: LlmRetryConfig): Promise<{ config: LlmRetryConfig; configured: boolean }> {
    await sleep(TIMING.ack)
    mockRetryConfig = { ...config }
    return { config: mockRetryConfig, configured: true }
  },
  onRetryConfig: (_h: (payload: { config: LlmRetryConfig; configured: boolean }) => void) => () => {},
}

// retry 配置内存态（pi 默认值兜底；声明在 configImpl 之后同 mockScopedModels 模式——方法运行期才读）
let mockRetryConfig: LlmRetryConfig = { enabled: true, maxRetries: 3, baseDelayMs: 2000 }

// [G4] 参数全等断言：mock config 任一方法少参/多参/错型/返回漂移在此行编译失败
export type ConfigDomainParamsExact = AssertExact<DomainParamsExact<ConfigDomain, typeof configImpl>>
export const config: ConfigDomain = configImpl

/** 向 providers 订阅者广播最新 fixture 快照（模拟 runtime 动作后广播） */
let mockScopedModels: string[] = []
function broadcastProviders(): void {
  const snapshot = cloneFixtureProviders()
  providersSubWithScoped.broadcast({ providers: snapshot, scopedModels: mockScopedModels })
}

/* ── Model mock ── */
// scoped-model：模型列表按 mockScopedModels 白名单过滤（空 = 不过滤，同 runtime aggregateModels
// 空白名单语义）。mock 不模拟 scoped 有序重排，也不在 setScopedModels 后重推 modelsSub
//（与 runtime 一致——model.list 是订阅首推 + 按需拉取，setScopedModels 不主动广播模型列表）。
const modelsSub = makeMockSubscription(() =>
  mockScopedModels.length === 0
    ? MOCK_MODELS.map(mockModelToInfo)
    : MOCK_MODELS.filter((m) => mockScopedModels.includes(`${m.providerId}/${m.id}`)).map(mockModelToInfo),
)

const modelImpl = {
  onModels: (h: (models: ModelInfo[]) => void) => modelsSub.subscribe(h),
  // 主动拉取（与 onModels 同源快照，对齐 real 侧「订阅首推 + 按需拉取」双通路契约；
  // settings-lifecycle init 的 listModels 兜底拉取在 mock 模式依赖本方法——u17 mock 接回）
  async listModels(): Promise<ModelInfo[]> {
    return modelsSub.snapshot()
  },
  async switchModel(sessionId: string, provider: ProviderId, modelId: string) {
    await sleep(TIMING.ack)
    // 回执契约与真实 api 对齐（C-pi-13）：mock 无 pi，生效值 = 请求值回显
    return { sessionId, provider, modelId }
  },
}

// [G4] 参数全等断言：mock model 任一方法少参/多参/错型在此行编译失败
export type ModelDomainParamsExact = AssertExact<DomainParamsExact<ModelDomain, typeof modelImpl>>
export const model: ModelDomain = modelImpl

/* ── Extension mock ── */
// fixture 的 FixtureExtension 带 tools（ExtensionPage 模板依赖），与 shared ExtensionInfo
// （dirName/path/source）结构不同。onExtensions 暂留宽类型，由 SettingsModal 用本地
// ExtensionItem 桥接；tools/dirName/source 字段统一属 W08（Extension CRUD）。

const extensionsSub = makeMockSubscription(() => fixtureExtensions.map((e) => ({ ...e })))

export const extension = {
  onExtensions: (h: GlobalHandler<unknown>) => extensionsSub.subscribe(h),
  /** 主动重拉（对齐 runtime extension.list → 广播 config.extensions 刷新） */
  async scan() {
    await sleep(TIMING.ack)
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  async toggle(name: string, enabled: boolean): Promise<{ extensions: ReturnType<typeof toCandidate>[] }> {
    await sleep(TIMING.ack)
    const target = fixtureExtensions.find((e) => e.name === name)
    if (target) target.enabled = enabled
    // 真实 runtime：RPC reply { extensions }（scanExtensions 最新快照），routeInbound 命中 pending
    // 不触发 onExtensions 全局订阅，前端用 reply 刷新 store。mock 对齐：返回 toCandidate 转换快照
    // （toCandidate 覆盖 ExtensionInfo 必需字段，类型可赋给 Ref<ExtensionInfo[]>）。
    // broadcast 保留以模拟连接级 onExtensions 推送（幂等，值一致）。
    const snapshot = fixtureExtensions.map(toCandidate)
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
    return { extensions: snapshot }
  },
  /**
   * npm 直装（mock：剥 npm: 前缀后以真实包名加入 fixture 并广播刷新）。
   * 对齐 runtime installExtension 语义：source 形如 "npm:@scope/pkg"，runtime 用
   * pkgName（剥前缀）install，scanExtensions 读出的 name 是 package.json 的真实包名。
   * mock 直接用剥前缀后的 source 作为 name，让推荐区的 installed 匹配能命中。
   */
  async install(source: string) {
    await sleep(TIMING.ack)
    const name = source.startsWith('npm:') ? source.slice(NPM_PREFIX.length) : source
    if (!fixtureExtensions.some((e) => e.name === name)) {
      fixtureExtensions.push({ name, version: '0.0.0', description: `mock-installed: ${name}`, enabled: true, tools: [] })
    }
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  async uninstall(name: string) {
    await sleep(TIMING.ack)
    const idx = fixtureExtensions.findIndex((e) => e.name === name)
    if (idx >= 0) fixtureExtensions.splice(idx, 1)
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  /** dir/git 多步第一步：返回发现的候选（mock 把现有 fixture 当候选） */
  async installDir(_path: string) {
    await sleep(TIMING.ack)
    return { tempDir: `/mock/tmp/${Date.now()}`, candidates: fixtureExtensions.map(toCandidate) }
  },
  async installGitRepository(_url: string) {
    await sleep(TIMING.ack)
    return { tempDir: `/mock/tmp/${Date.now()}`, candidates: fixtureExtensions.map(toCandidate) }
  },
  /** 多步第二步：选中即视为已装（mock 已在 fixture 中，仅广播刷新） */
  async finishInstall(_tempDir: string, _selected: string[]) {
    await sleep(TIMING.ack)
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  async cancelInstall(_tempDir: string) {
    await sleep(TIMING.ack)
  },
  /** 拉取推荐扩展（含已安装状态）。mock 用 fixtureExtensions 判断 installed。 */
  async fetchRecommended(): Promise<Array<RecommendedExtension & { installed: boolean }>> {
    await sleep(TIMING.ack)
    const installedNames = new Set(fixtureExtensions.map((e) => e.name))
    return recommendedExtensions.map((r) => ({ ...r, installed: installedNames.has(r.name) }))
  },
  /** 升级扩展（mock：仅等待 ack，不实际升级） */
  async upgrade(_name: string) {
    await sleep(TIMING.ack)
  },
  /** 设置自动升级开关（mock：仅等待 ack） */
  async setAutoUpgrade(_name: string, _enabled: boolean) {
    await sleep(TIMING.ack)
  },
}

/* ── Plugin mock（订阅骨架，无 fixture；第3项真实集成补数据）── */

const pluginsSub = makeMockSubscription((): PluginInfo[] => [])

const pluginImpl = {
  onPlugins: (h: (plugins: PluginInfo[]) => void) => pluginsSub.subscribe(h),
  // 插件权限审批/回收（[G4 锚定补齐]：锚定前 mock 缺此二成员，门面三元下不可达）。
  // mock 无插件运行时，ack 型 stub resolve 即可。revokePermissions 与 real 同为单参
  // （回收即撤销插件全部授权，无 permissions 参数——锚定曾抓出 stub 多参，已对齐）。
  async approvePermissions(_pluginId: string, _permissions: string[]): Promise<void> {
    await sleep(TIMING.ack)
  },
  async revokePermissions(_pluginId: string): Promise<void> {
    await sleep(TIMING.ack)
  },
}

// [G4] 参数全等断言：mock plugin 任一方法少参/多参/错型在此行编译失败
export type PluginDomainParamsExact = AssertExact<DomainParamsExact<PluginDomain, typeof pluginImpl>>
export const plugin: PluginDomain = pluginImpl

/* ── Composer mock（@ 引用 / # 文件候选；# 已接 real domain，mock 模式仍用 fixture 演示）── */
/* 门面三元同构：getFileCandidates 返回 FileNode[]（与 real composer domain 一致），
   FILE_CANDIDATES（UI 形状）→ FileNode 映射在此处，消费侧 lib/file-candidates.ts 统一做 FileNode→候选映射。 */

const composerImpl = {
  /**
   * [G4 锚定 ComposerDomain] 返回类型对齐 real 域：real getMentionCandidates 已废弃、恒返回
   * 空数组（类型 Promise<[]>），mock 原返回 MENTION_CANDIDATES 演示数据属漂移，对齐后恒 []。
   */
  async getMentionCandidates(): Promise<[]> {
    await sleep(TIMING.ack)
    return []
  },
  async getFileCandidates(_sessionId: string): Promise<FileNode[]> {
    await sleep(TIMING.ack)
    // FILE_CANDIDATES（UI 形状 {name,kind,path}）→ FileNode（{path,name,type}），与 real 同构
    return FILE_CANDIDATES.map((f) => ({
      path: f.path ?? f.name,
      name: f.name.replace(/\/$/, ''),
      type: (f.kind === '目录' ? 'dir' : 'file') as FileNode['type'],
    }))
  },
  /**
   * [G4 锚定补齐] landing cwd 路文件候选（锚定前 mock 缺此成员）。现消费方
   * （command-popover-open-fetch）直连 real domain 不经本门面，mock stub 返回空页保持签名同构。
   */
  async getFileCandidatesByCwd(_cwd: string): Promise<{ files: FileNode[]; truncated: boolean }> {
    await sleep(TIMING.ack)
    return { files: [], truncated: false }
  },
}

// [G4] 参数全等断言：mock composer 任一方法少参/多参/错型在此行编译失败
export type ComposerDomainParamsExact = AssertExact<DomainParamsExact<ComposerDomain, typeof composerImpl>>
export const composer: ComposerDomain = composerImpl

/* ── Search mock（全局搜索浮层 ⌘K；后端 LSP/命令注册表就绪后接 real domain）── */

export const search = {
  /**
   * 按查询过滤四类数据，空查询返回 recent + suggested。
   * W1 i18n-frontend-p2：返回 Section[] 带 kind 字段（recent/suggested/command/file/symbol/session），
   * 供 SearchModal kind-based 判定用（不再依赖中文字面量 s.label === '最近' 比较）。
   * label 仍为本地化文案（mock 内联 zh-CN 默认值，real 轨 useSearch 统一走 i18n.t）。
   */
  async query(q: string): Promise<Section[]> {
    await sleep(TIMING.ack)
    const trimmed = q.trim().toLowerCase()
    if (!trimmed) {
      return [
        { kind: 'recent', label: '最近', items: SEARCH_RECENTS.map((i) => ({ ...i })) },
        { kind: 'suggested', label: '建议命令', items: SEARCH_MOCK.command.slice(0, SEARCH_SUGGESTED_COUNT).map((i) => ({ ...i })) },
      ]
    }
    const TYPES: SearchItem['type'][] = ['command', 'file', 'symbol', 'session']
    const LABEL: Record<SearchItem['type'], string> = { command: '命令', file: '文件', symbol: '符号', session: '会话' }
    return TYPES
      .map((t) => ({
        kind: t,
        label: LABEL[t],
        items: SEARCH_MOCK[t]
          .filter((it) => it.title.toLowerCase().includes(trimmed) || it.sub.toLowerCase().includes(trimmed))
          .map((it) => ({ ...it })),
      }))
      .filter((s) => s.items.length > 0)
  },
}

/* ── Settings mock（对齐新契约：转发 config/extension 订阅 + 复用 real 的 localStorage 偏好）── */
/* 必须在 config/extension 块之后（转发引用它们） */

export const settings = {
  // 订阅（转发到 mock sub）
  onProviders: config.onProviders,
  onSkills: config.onSkills,
  onAgents: config.onAgents,
  onExtensions: extension.onExtensions,
  onDefaults: config.onDefaults,
  // 请求
  listProviders: config.listProviders,
  // 动作
  setProvider: config.setProvider,
}

// Mock workspace domain（W3：最近工作区记录，mock 返回 3 条 records 供 E2E 验证）

/**
 * 固定 3 条样例（lastUsedAt 递减，最新在前），供 T4.1/T4.3 E2E 验证 popover 渲染与搜索过滤。
 * label = cwd basename（与 runtime workspace-message-handler 的 label 派生一致）。
 *
 * 抽为模块级内部函数而非 workspace.listRecent 方法内联：record 需复用同一份数据，
 * 早期实现 record 调 this.listRecent() 依赖 this 绑定——但 workspace 对象方法被解构赋值
 * 或脱离对象调用（如 `const { record } = workspace; record(cwd)`）时 this=undefined → 抛错。
 * 提到模块级避免该 this 绑定陷阱（S12 修复）。
 */
function listRecentRecords(): import('@taiji/shared').RecentWorkspaceRecord[] {
  const now = Date.now()
  const DAY = 86_400_000
  const oldestOffset = DAY + DAY // 2 天前（相加避免魔数 lint）
  return [
    { cwd: '/Users/demo/project-a', lastUsedAt: now, label: 'project-a' },
    { cwd: '/Users/demo/project-b', lastUsedAt: now - DAY, label: 'project-b' },
    { cwd: '/Users/demo/another-foo', lastUsedAt: now - oldestOffset, label: 'another-foo' },
  ]
}

// Mock quota domain（w4 coding-plan 额度查询）
const quotaImpl = {
  async getCached(_providerId: string) {
    return { data: null, lastFetchAt: null }
  },
  async fetchQuota(_providerId: string) {
    return { data: null, lastFetchAt: null }
  },
  async refreshQuota(_providerId: string) {
    return { data: null, lastFetchAt: null }
  },
  // [G4 锚定 QuotaDomain] 签名同构由编译强制（原注释「非编译强制」随锚定退役）
  async configure(_payload: QuotaConfigurePayload) {
    return { ok: true }
  },
}

// [G4] 参数全等断言：mock quota 任一方法少参/多参/错型在此行编译失败
export type QuotaDomainParamsExact = AssertExact<DomainParamsExact<QuotaDomain, typeof quotaImpl>>
export const quota: QuotaDomain = quotaImpl

const workspaceImpl = {
  async listRecent(): Promise<import('@taiji/shared').RecentWorkspaceRecord[]> {
    return listRecentRecords()
  },
  // record 不再依赖 this.listRecent（this 绑定陷阱，见 listRecentRecords 注释），直接调模块级函数
  async record(_cwd: string): Promise<import('@taiji/shared').RecentWorkspaceRecord[]> {
    // Mock record：模拟写入后返回最新列表（与 listRecent 一致，简化实现）
    return listRecentRecords()
  },
  // detectBare：mock 恒返非 bare（landing 态 isBare 演示由 real 轨驱动，mock 轨无需真实检测）
  async detectBare(_cwd: string): Promise<{ isBare: boolean; wsRoot: string; barePath: string }> {
    return { isBare: false, wsRoot: '', barePath: '' }
  },
  // detect：mock 恒返 not-repo（三态检测，real 轨驱动）
  async detect(_cwd: string): Promise<import('@taiji/shared').ServerMessageMap['workspace.detected']> {
    return { mode: 'not-repo', wsRoot: '', barePath: '', repoRoot: '', defaultBranch: '' }
  },
}

// [G4] 参数全等断言：mock workspace 任一方法少参/多参/错型在此行编译失败
export type WorkspaceDomainParamsExact = AssertExact<DomainParamsExact<WorkspaceDomain, typeof workspaceImpl>>
export const workspace: WorkspaceDomain = workspaceImpl

// project 域 mock 占位（D14，2026-08-04）：mock 模式无 runtime，project 列表回退默认空态。
// 与 real 轨 api/domains/project.ts 签名同构（load/save），避免门面三元崩溃。
const projectImpl = {
  async load(): Promise<import('@taiji/shared').ProjectStoreState> {
    return { projects: [], activeProjectId: '' }
  },
  // [G4 锚定 ProjectDomain] 对齐 real 契约返回 void（原 mock 返回 state 属未登记偏差，随锚定收口；
  // mock 无持久化，save 即 ack）
  async save(state: import('@taiji/shared').ProjectStoreState): Promise<void> {
    void state
  },
}

// [G4] 参数全等断言：mock project 任一方法少参/多参/错型在此行编译失败
export type ProjectDomainParamsExact = AssertExact<DomainParamsExact<ProjectDomain, typeof projectImpl>>
export const project: ProjectDomain = projectImpl

// preset 域 mock（pi-launch-presets wave1）：返回内置预设目录 + 默认全工具模式 id。
// 与 real 轨 api/domains/preset.ts 签名同构（list/getDefault/setDefault + CRUD），避免门面三元崩溃。
// mock 无自定义预设持久化（CRUD 只改内存），但**内置目录必须非空**：模式可见性三态判定
// （u5 设计 D5）把「presets 空 + 无错误」当「未加载 → 不渲染」，空列表会让非默认模式会话的
// chip / 声明行永远落不到正常分支——[u7a] 补 DEFAULT_PRESETS 后 mock fixture 的
// launchPresetId='builtin:session-dispatch' 才可解析出模式名（原为纯占位空列表，2026-09-19 收口）。
import type { PiLaunchPreset } from '@taiji/shared'
const mockPresets: PiLaunchPreset[] = DEFAULT_PRESETS.map((p) => ({ ...p }))
const presetImpl = {
  async list(): Promise<PiLaunchPreset[]> {
    return mockPresets.map((p) => ({ ...p }))
  },
  async getDefault(): Promise<string> {
    return 'builtin:full'
  },
  async setDefault(_presetId: string): Promise<void> {
    // no-op（mock 模式不持久化）
  },
  async create(p: PiLaunchPreset): Promise<PiLaunchPreset> {
    mockPresets.push({ ...p })
    return { ...p }
  },
  async update(p: PiLaunchPreset): Promise<PiLaunchPreset> {
    const idx = mockPresets.findIndex((x) => x.id === p.id)
    if (idx >= 0) mockPresets[idx] = { ...p }
    return { ...p }
  },
  async remove(presetId: string): Promise<void> {
    const idx = mockPresets.findIndex((x) => x.id === presetId)
    if (idx >= 0) mockPresets.splice(idx, 1)
  },
}

// [G4] 参数全等断言：mock preset 任一方法少参/多参/错型在此行编译失败
export type PresetDomainParamsExact = AssertExact<DomainParamsExact<PresetDomain, typeof presetImpl>>
export const preset: PresetDomain = presetImpl
