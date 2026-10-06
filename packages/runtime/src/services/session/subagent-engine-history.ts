/**
 * subagent-engine-history —— runtime 的非 pi 引擎历史详情读取 + 协议客户端接线
 * （W8 宿主接线，设计 §3.6 宿主面 / impl-plan §2.8）。
 *
 * [W8 前] 本文件是「core session-view-service 三级降级链」的薄调用（①引擎原生
 * reader ②journal ③outcome-only，①级 = core 内建 zcode sqlite 直读）。
 *
 * [W8 起] runtime 成为协议客户端（D9 反转：runtime 不再 import 引擎实现直读）：
 * 三级发现（TAIJI_AGENT_ENGINE_ROOTS + node 解析 + config.json；engines.json 仅 GUI
 * 投影不作发现源）装载 cli descriptor → 按需 spawn 引擎 CLI 调协议 read（idle 复用
 * 5min，回收层 dispose 上界 3s 超时即杀）→ 失败降②级 journal（降级 warn 留痕；
 * SessionView.source 契约是 GUI 标注数据源，字段透出归 GUI 消费面）。
 *
 * 接线形态：runtime 把「协议 read」注册为引擎原生 reader（registerNativeSessionReader，
 * 覆盖 core 内建 zcode reader——仅本进程，pi 扩展宿主进程不受影响），core
 * readSubagentHistoryMessages 的三级降级链与 SessionView → HistoryMessage 投影
 * 原样复用，runtime 零投影代码。
 *
 * 实例管理（设计 §3.6「runtime 侧引擎进程的生命周期」）：
 * - 持有方 = runtime 自持 RemoteEngine 实例（descriptor.portFactory() 产物，不经
 *   registry 单例——单例 dispose 后不可重建，管理器 idle 回收后重建需新实例）；
 * - 与 pi 宿主实例不共享（两进程各自 spawn，同 id 两个常驻 CLI）；zcode 两实例共享
 *   同一宿主 HOME 与同一隔离库（WAL 并发，与改造前同语义——spawn env 由
 *   buildEngineChildEnv L0 注入同一 TAIJI_AGENT_DATA_DIR）；
 * - idle 5min 无 read 调用 → dispose（回收层有界兜底，AGENTS.md 规则 19；定时器
 *   owner = 本管理器）；进程退出钩子 = disposeRuntimeEngineClients（runtime index.ts
 *   shutdown() 内与 deinitRelayServer 并行，3s 聚合上界）。
 *
 * pi 的历史读取不经过本文件：session-records.getSubagentHistory 的 pi 分支保持现有
 * JSONL 直读链（getHistoryFromFilePath），A1 守护。
 */
import type { SubagentRecord, Message } from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import {
  readSubagentHistoryMessages,
  resolveEngineRouteId,
  registerNativeSessionReader,
  setEngineDiscoveryRescanOptions,
  type EnginePort,
  type SessionView,
} from '@zhushanwen/subagent-core'
import { discoverAndRegisterEngines } from '@zhushanwen/subagent-core/engine/engine-discovery-scan'
import { getPiAgentDir } from '../../infra/pi/pi-paths.js'
import { toErrorMessage } from '../../utils/errors.js'

/** record 引擎路由段的缺省引擎：存量 record 无 engine 字段 → 按 pi 投影（零迁移）。 */
export const DEFAULT_SUBAGENT_ENGINE = 'pi'

// ── 协议客户端管理面 ───────────────────────────────────────────

// ADR-0112 退役登记（2026-10-05）：协议引擎 idle 回收（ENGINE_IDLE_REUSE_MS 5min →
// dispose）已删——引擎实例进程级自持直至 shutdown dispose（退出钩子仍收口）。shutdown
// 聚合上界（DISPOSE_AGGREGATE_CAP_MS 3s）随杀链 grace 退役一并删除。

/** 管理器条目：自持协议引擎实例。 */
interface RuntimeEngineEntry {
  engine: EnginePort
}

/** 自持实例表（进程级；与 pi 宿主实例不共享）。 */
const protocolEntries = new Map<string, RuntimeEngineEntry>()

/** 已注册协议 reader 的引擎 id（每次 readEngineSubagentHistory 惰性注册）。 */
const wiredProtocolReaders = new Set<string>()

/** 宿主接线 once 标记（补扫参数 slot 装载）。 */
let wiringDone = false

/** 三级发现的 runtime 参数（与 session-records 冷启动回退同源——单一 hostKind/agentDir/dataDir 口径）。 */
function runtimeDiscoveryOptions(): { hostKind: string; agentDir: string; dataDir: string } {
  return { hostKind: 'runtime', agentDir: getPiAgentDir(), dataDir: getDataDir() }
}

/** 测试注入的发现参数覆盖（undefined = 恢复缺省推导；生产禁用）。 */
let discoveryOverrides: Parameters<typeof discoverAndRegisterEngines>[0] | undefined

/** 测试钩子：覆盖三级发现参数（如 nodeModuleRoots: [] 隔离宿主真实引擎包，保证
 *  「引擎不可发现」分支的确定性——生产禁用）。 */
export function setRuntimeDiscoveryOptionsForTests(
  overrides: Partial<Parameters<typeof discoverAndRegisterEngines>[0]> | undefined,
): void {
  discoveryOverrides = overrides !== undefined ? { ...runtimeDiscoveryOptions(), ...overrides } : undefined
}

/**
 * 宿主接线（once）：①装载 hasEngine 补扫通道参数（W4 ensureEngineDiscovered 通道，
 * agent 解析期/路由期快照未命中时一次三级补扫）；②协议 reader 按需注册由
 * ensureProtocolReaderFor 承担。
 */
function ensureRuntimeEngineWiring(): void {
  if (wiringDone) return
  wiringDone = true
  try {
    setEngineDiscoveryRescanOptions(runtimeDiscoveryOptions())
  } catch (err) {
    // best-effort 降级：接线失败不阻断 read 主链——补扫参数缺省时 hasEngineWithRescan
    // 与裸 hasEngine 等价（零行为变化），仅失去「快照未命中补扫」通道，warn 留痕。
    console.warn(`[subagent-engine-history] engine rescan wiring failed: ${toErrorMessage(err)}`)
  }
}

/** 自持实例创建：三级发现装载（幂等）→ cli descriptor portFactory 新实例。 */
function createProtocolEntry(engineId: string): RuntimeEngineEntry | undefined {
  try {
    const scan = discoverAndRegisterEngines(discoveryOverrides ?? runtimeDiscoveryOptions())
    const discovered = scan.discovered.find((e) => e.id === engineId)
    if (discovered === undefined || discovered.descriptor.kind !== 'cli') return undefined
    const engine = discovered.descriptor.portFactory()
    const entry: RuntimeEngineEntry = { engine }
    protocolEntries.set(engineId, entry)
    return entry
  } catch (err) {
    console.warn(
      `[subagent-engine-history] engine '${engineId}' protocol client creation failed: ${toErrorMessage(err)}`,
    )
    return undefined
  }
}

function ensureProtocolEntry(engineId: string): RuntimeEngineEntry | undefined {
  return protocolEntries.get(engineId) ?? createProtocolEntry(engineId)
}

/**
 * 协议 read ①级 reader（引擎原生 reader 形态）：返回 undefined = 本级不可达
 * （发现失败 / 协议失败）→ core 链自动降②级 journal（SessionView.source 契约的
 * 降级标注数据源；降级事实经 warn 留痕供重审触发观测——设计 §3.6「详情页延迟 > 1s
 * 或降级率 > 5%」）。
 */
// [池抽象降级 2026-09-13] 协议 EngineHandleData 已删 poolKey 字段——本函数参数的
// poolKey 是持久化 record 形状（EngineHandleView）的成员，不再上 wire。
function protocolReadTier(engineId: string): (handle: {
  sessionRef: Record<string, string>
  eventsPath?: string
  poolKey: string
}, dataDir: string) => Promise<SessionView | undefined> {
  return async (handle) => {
    const entry = ensureProtocolEntry(engineId)
    if (entry === undefined) {
      console.warn(
        `[subagent-engine-history] engine '${engineId}' not discovered by runtime three-tier ` +
          `scan — protocol read unavailable, degrading to journal tier`,
      )
      return undefined
    }
    try {
      return await entry.engine.read({
        data: {
          v: 1,
          engineId,
          sessionRef: handle.sessionRef,
          ...(handle.eventsPath !== undefined ? { eventsPath: handle.eventsPath } : {}),
          adapterVersion: 'runtime-protocol-read',
        },
      })
    } catch (err) {
      console.warn(
        `[subagent-engine-history] engine '${engineId}' protocol read failed, degrading to ` +
          `journal tier: ${toErrorMessage(err)}`,
      )
      return undefined
    }
  }
}

/** 协议 reader 惰性注册（per engine id 一次；覆盖 core 内建 zcode reader——仅本进程）。 */
function ensureProtocolReaderFor(engineId: string): void {
  if (wiredProtocolReaders.has(engineId)) return
  wiredProtocolReaders.add(engineId)
  registerNativeSessionReader(engineId, protocolReadTier(engineId))
}

/**
 * 测试隔离专用：清空自持实例表与接线标记（生产禁用——进程级状态，生产回收走
 * disposeRuntimeEngineClients）。reader 注册表残留幂等（同 id 重复注册覆盖），不清。
 */
export function resetRuntimeEngineWiringForTests(): void {
  for (const entry of protocolEntries.values()) {
    const disposing = entry.engine.dispose?.()
    if (disposing !== undefined) void disposing.catch(() => {})
  }
  protocolEntries.clear()
  wiredProtocolReaders.clear()
  wiringDone = false
  discoveryOverrides = undefined
}

/**
 * 进程退出钩子（runtime index.ts shutdown 消费）：全部自持协议实例并行 dispose。
 * 幂等（出表后重复调用为 no-op）。
 */
export function disposeRuntimeEngineClients(): Promise<void> {
  const entries = [...protocolEntries.values()]
  protocolEntries.clear()
  if (entries.length === 0) return Promise.resolve()
  // EnginePort.dispose?() 可选成员（RemoteEngine 恒实装）——optional call 后过滤。
  return Promise.allSettled(
    entries.map((entry) => {
      const disposing = entry.engine.dispose?.()
      return disposing !== undefined ? Promise.resolve(disposing).catch(() => {}) : Promise.resolve()
    }),
  ).then(() => {})
}

// ── record 路由与读取入口 ──────────────────────────────────────

/**
 * record 路由段：从 record 的 engine 字段选引擎。
 *
 * 消费契约（并行任务写侧）：`record.engine?: string`（'pi' | 'zcode' | ...），缺省 =
 * pi。非 trim 透传（空白 id 在 core 编排层 reader registry miss 落③级，与收敛前
 * 行为等价）。
 */
export function extractRecordEngine(record: SubagentRecord): string {
  // 单一裁决点委派 core：engine 缺失且无原生引擎锚 → pi 缺省（存量零迁移）；
  // 缺失但带原生锚（engineHandle.sessionRef 非空）→ 抛 RecordEngineIdentityError。
  // 本地复刻一份「缺省即 pi」会让损坏 record 在此先被判成 pi，core 侧守卫永不触达。
  return resolveEngineRouteId(record, record.subagentId)
}

/**
 * 非 pi record 的历史详情读取（runtime ①级 = 协议 read → ②journal → ③outcome）。
 *
 * 每级读取失败留 warn/debug 日志、不因「读不到」崩溃；但「record 身份域损坏」
 * （有原生引擎锚却无 engine）会抛 RecordEngineIdentityError —— 那是数据损坏，不是
 * 空历史，静默返回 [] 会把损坏伪装成「这个 record 没有历史」。pi record 返回 []：
 * pi 的①级 = 调用方现有 JSONL 直读链（session-records.getSubagentHistory），A1 守护。
 *
 * 类型说明：core 返回 HistoryMessage[]（shared Message 的结构子集，core 不 import
 * workspace private 的 shared 包）——TS 结构类型直接可赋值，兼容性由本函数签名的
 * 类型检查守护。
 *
 * @param record  record 快照（engine/engineHandle 为不可信源，core 链守卫消费）
 * @param dataDir taiji 数据根（getDataDir() 产物；协议 read.dataDir 与 journal/
 *                dbPath 白名单经同一份 paths.ts 布局 SSOT 推导，禁自拼）
 */
export async function readEngineSubagentHistory(record: SubagentRecord, dataDir: string): Promise<Message[]> {
  ensureRuntimeEngineWiring()
  const engineId = extractRecordEngine(record)
  if (engineId !== DEFAULT_SUBAGENT_ENGINE) ensureProtocolReaderFor(engineId)
  return readSubagentHistoryMessages(record, dataDir)
}

// ── pi session model_change 尾条目派生（subagent-model-switch §9 transport 行）──

/** model_change 条目的派生视图（shared SubagentRecentEffectiveModel 同构形状）。 */
export interface SessionModelChangeEntry {
  provider: string
  modelId: string
}

/**
 * 单条 JSONL 行的 model_change 投影（非命中返回 null；行解析失败静默跳过——
 * 尾部半写行是 pi 延迟落盘的常态形态，不构成错误）。
 */
function projectModelChangeLine(line: string): SessionModelChangeEntry | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown; provider?: unknown; modelId?: unknown }
    if (parsed.type !== 'model_change') return null
    if (typeof parsed.provider !== 'string' || typeof parsed.modelId !== 'string') return null
    if (parsed.provider === '' || parsed.modelId === '') return null
    return { provider: parsed.provider, modelId: parsed.modelId }
  } catch {
    return null
  }
}

/**
 * 尾块倒序扫描的块大小与块数上界（subagent-model-switch §6.4 分叉态重载消费）。
 *
 * model_change 在该成员 session 里的位置 = 最近一次热切换时点——分叉态重载场景
 * （切换后不久重开面板）它必然在文件尾部近邻；窗口上限只防极端大流量场景的
 * 全文件扫描成本，扫完未命中按无值处理（= 切换流量已把条目推出窗口，标签由
 * 覆盖状态通道承接——分支②的显示，不虚构生效值）。
 */
// eslint-disable-next-line no-magic-numbers -- 尾读窗口常数（64KB 块 × 4 块 = 256KB 上限，语义见上注）
const MODEL_CHANGE_TAIL_CHUNK_BYTES = 64 * 1024
const MODEL_CHANGE_TAIL_MAX_CHUNKS = 4

/**
 * pi session JSONL 的 `model_change` 尾条目派生（实际执行事实权威——§7.2 审计口径，
 * 详情载荷组装时派生读取，零新增持久化载体）。
 *
 * 仅 pi 引擎成员调用（非 pi 成员无 pi session 文件，调用方以 extractRecordEngine 判定）。
 * 读不到（文件不存在 / 尾窗口无条目 / 条目字段畸形）按无值处理（undefined）——未发生
 * 热切 = 无分叉态，字段本无消费场景。读失败 warn 一次不抛（详情载荷增强是展示域，
 * 不因它阻断列表返回）。
 */
export function readPiSessionLatestModelChange(sessionFile: string): SessionModelChangeEntry | undefined {
  let size: number
  try {
    size = statSync(sessionFile).size
  } catch {
    return undefined // 文件不存在（pi 首次 flush 前延迟写入）= 无值
  }
  const readLen = Math.min(size, MODEL_CHANGE_TAIL_CHUNK_BYTES * MODEL_CHANGE_TAIL_MAX_CHUNKS)
  const start = size - readLen
  let text: string
  try {
    const buf = Buffer.alloc(readLen)
    const fd = openSync(sessionFile, 'r')
    try {
      readSync(fd, buf, 0, readLen, start)
    } finally {
      closeSync(fd)
    }
    text = buf.toString('utf8')
  } catch (e) {
    console.warn(`[subagent-engine-history] model_change tail read failed (${toErrorMessage(e)}): ${sessionFile}`)
    return undefined
  }
  // 首行按窗口起点截齐（窗口切在行中间时残行不可解析，跳过）。
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const change = projectModelChangeLine(lines[i] ?? '')
    if (change !== null) return change
  }
  return undefined
}
