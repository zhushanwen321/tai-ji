/**
 * subagent-engine-history —— runtime 的非 pi 引擎历史详情读取 + 协议客户端接线
 * （W8 宿主接线，设计 §3.6 宿主面 / impl-plan §2.8）。
 *
 * [W8 前] 本文件是「core session-view-service 三级降级链」的薄调用（①引擎原生
 * reader ②journal ③outcome-only，①级 = core 内建 zcode sqlite 直读）。
 *
 * [W8 起] runtime 成为协议客户端（D9 反转：runtime 不再 import 引擎实现直读）：
 * 三级发现（XYZ_AGENT_ENGINE_ROOTS + node 解析 + config.json；engines.json 仅 GUI
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
 *   buildEngineChildEnv L0 注入同一 XYZ_AGENT_DATA_DIR）；
 * - idle 5min 无 read 调用 → dispose（回收层有界兜底，AGENTS.md 规则 19；定时器
 *   owner = 本管理器）；进程退出钩子 = disposeRuntimeEngineClients（runtime index.ts
 *   shutdown() 内与 deinitRelayServer 并行，3s 聚合上界）。
 *
 * pi 的历史读取不经过本文件：session-records.getSubagentHistory 的 pi 分支保持现有
 * JSONL 直读链（getHistoryFromFilePath），A1 守护。
 */
import type { SubagentRecord, Message } from '@xyz-agent/shared'
import { getDataDir } from '@xyz-agent/shared/paths'
import {
  readSubagentHistoryMessages,
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

/** idle 回收窗口（设计 §3.6：idle 5min → 发 dispose）。 */
// eslint-disable-next-line no-magic-numbers -- 5 minutes = 5 * 60 * 1000ms, self-documenting with comment
const ENGINE_IDLE_REUSE_MS = 5 * 60 * 1000
/** 退出钩子聚合上界（dispose 帧 3s 上界由 EngineClient 承担；本上界保证 shutdown
 *  不被单个挂死引擎的杀链收尾无限拖住——杀链已发起，SIGKILL 升级由 reaper 兜底）。 */
const DISPOSE_AGGREGATE_CAP_MS = 3_000

/** 管理器条目：自持协议引擎实例 + idle 定时器句柄。 */
interface RuntimeEngineEntry {
  engine: EnginePort
  resetIdleTimer(): void
  clearIdleTimer(): void
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

/** idle 到期回收：dispose + 出表（dispose 后实例不可重建，出表让下次 read 走重建
 *  路径拿新实例）。真实定时器回调与测试钩子共用本函数——测试驱动的是同一实现路径。 */
function expireIdleEntry(engineId: string, engine: EnginePort): void {
  const entry = protocolEntries.get(engineId)
  if (entry === undefined || entry.engine !== engine) return
  protocolEntries.delete(engineId)
  // EnginePort.dispose?() 可选成员（RemoteEngine 恒实装）——optional call 后判空。
  const disposing = engine.dispose?.()
  if (disposing !== undefined) {
    void disposing.catch((err: unknown) => {
      console.warn(
        `[subagent-engine-history] idle dispose failed for engine '${engineId}': ${toErrorMessage(err)}`,
      )
    })
  }
}

/** idle 定时器：touch 重置；触发 → expireIdleEntry。 */
function armIdleTimer(engineId: string, engine: EnginePort): NodeJS.Timeout {
  const timer = setTimeout(() => expireIdleEntry(engineId, engine), ENGINE_IDLE_REUSE_MS)
  timer.unref()
  return timer
}

/**
 * 测试钩子：显式触发 idle 到期回收（与真实定时器回调共用 expireIdleEntry——同一
 * 实现路径，非并行仿真）。生产窗口 5min 不可等待，「窗口内复用 / 过期重建」又必须
 * 确定性验证：由用例显式驱动「窗口到期」，避免用例与真实 read 耗时竞速。
 * 生产禁用——生产恒由 armIdleTimer 的真实定时器驱动。
 */
export function expireIdleEngineClientsForTests(): void {
  for (const [engineId, entry] of [...protocolEntries]) {
    // 定时器尚未真正到期——先撤销句柄再走同一到期路径（真实到期时该 clear 为 no-op，
    // 故生产路径零差异）。
    entry.clearIdleTimer()
    expireIdleEntry(engineId, entry.engine)
  }
}

/** 自持实例创建：三级发现装载（幂等）→ cli descriptor portFactory 新实例。 */
function createProtocolEntry(engineId: string): RuntimeEngineEntry | undefined {
  try {
    const scan = discoverAndRegisterEngines(discoveryOverrides ?? runtimeDiscoveryOptions())
    const discovered = scan.discovered.find((e) => e.id === engineId)
    if (discovered === undefined || discovered.descriptor.kind !== 'cli') return undefined
    const engine = discovered.descriptor.portFactory()
    let timer: NodeJS.Timeout | undefined
    const entry: RuntimeEngineEntry = {
      engine,
      resetIdleTimer() {
        if (timer !== undefined) clearTimeout(timer)
        timer = armIdleTimer(engineId, engine)
      },
      clearIdleTimer() {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      },
    }
    timer = armIdleTimer(engineId, engine)
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
  const cached = protocolEntries.get(engineId)
  if (cached !== undefined) {
    cached.resetIdleTimer()
    return cached
  }
  return createProtocolEntry(engineId)
}

/**
 * 协议 read ①级 reader（引擎原生 reader 形态）：返回 undefined = 本级不可达
 * （发现失败 / 协议失败）→ core 链自动降②级 journal（SessionView.source 契约的
 * 降级标注数据源；降级事实经 warn 留痕供重审触发观测——设计 §3.6「详情页延迟 > 1s
 * 或降级率 > 5%」）。
 */
function protocolReadTier(engineId: string): (handle: {
  sessionRef: Record<string, string>
  journalPath?: string
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
          poolKey: handle.poolKey,
          ...(handle.journalPath !== undefined ? { journalPath: handle.journalPath } : {}),
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
    entry.clearIdleTimer()
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
 * 聚合上界缺省 3s（DISPOSE_AGGREGATE_CAP_MS）——单实例 dispose 的帧等待/杀链上界由
 * EngineClient 承担（3s dispose 帧 → 超时组杀），本聚合上界保证 shutdown 编排
 * 不被杀链收尾无限拖住。幂等（出表后重复调用为 no-op）。capMs 仅测试注入。
 */
export function disposeRuntimeEngineClients(capMs: number = DISPOSE_AGGREGATE_CAP_MS): Promise<void> {
  const entries = [...protocolEntries.values()]
  protocolEntries.clear()
  for (const entry of entries) entry.clearIdleTimer()
  if (entries.length === 0) return Promise.resolve()
  // EnginePort.dispose?() 可选成员（RemoteEngine 恒实装）——optional call 后过滤。
  const all = Promise.allSettled(
    entries.map((entry) => {
      const disposing = entry.engine.dispose?.()
      return disposing !== undefined ? Promise.resolve(disposing).catch(() => {}) : Promise.resolve()
    }),
  )
  return Promise.race([
    all,
    new Promise<void>((resolve) => setTimeout(resolve, capMs).unref()),
  ]).then(() => {})
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
  const engine = (record as { engine?: unknown }).engine
  return typeof engine === 'string' && engine.length > 0 ? engine : DEFAULT_SUBAGENT_ENGINE
}

/**
 * 非 pi record 的历史详情读取（runtime ①级 = 协议 read → ②journal → ③outcome）。
 *
 * 每级失败留 warn/debug 日志不抛崩溃（GUI 详情页永不白屏报错）。pi record 返回 []：
 * pi 的①级 = 调用方现有 JSONL 直读链（session-records.getSubagentHistory），A1 守护。
 *
 * 类型说明：core 返回 HistoryMessage[]（shared Message 的结构子集，core 不 import
 * workspace private 的 shared 包）——TS 结构类型直接可赋值，兼容性由本函数签名的
 * 类型检查守护。
 *
 * @param record  record 快照（engine/engineHandle 为不可信源，core 链守卫消费）
 * @param dataDir xyz-agent 数据根（getDataDir() 产物；协议 read.dataDir 与 journal/
 *                dbPath 白名单经同一份 paths.ts 布局 SSOT 推导，禁自拼）
 */
export async function readEngineSubagentHistory(record: SubagentRecord, dataDir: string): Promise<Message[]> {
  ensureRuntimeEngineWiring()
  const engineId = extractRecordEngine(record)
  if (engineId !== DEFAULT_SUBAGENT_ENGINE) ensureProtocolReaderFor(engineId)
  return readSubagentHistoryMessages(record, dataDir)
}
