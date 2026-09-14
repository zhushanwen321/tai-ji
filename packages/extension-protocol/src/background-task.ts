/**
 * base-tool-enhance 后台任务 registry.json 契约（跨层 SSOT）。
 *
 * 契约两端：
 *  - 写侧：@zhushanwen/pi-base-tool-enhance extension（pi 进程内，registry 权威）——
 *    spawn 登记 running、bash_kill / 后台 timeout 标 killing、轮询器与 process-exit
 *    guard 写 exited 终态。写入协议：原子写 temp+rename + 统一文件锁内 RMW；
 *    解析失败/形状非法 → 重命名 .corrupt 保留现场 + 按空表重建。
 *  - 读侧：xyz-agent runtime 后台任务收殓器——按属主判定处置孤儿（见 ownerPiPid
 *    字段注释），orphaned 终态由 runtime 写入（收殓下沉，设计 docs/design/
 *    file-lock-unification-and-reaper-sink.md D2）。
 *
 * 目录布局（per-session 隔离）：
 *   <agentDir>/base-tool-enhance/<sessionId>/registry.json
 *   （agentDir = pi getAgentDir() 同源 dataDir，由调用方解析传入，不硬编码）
 *
 * 字段名/语义/枚举值与写侧现状逐字段一致（基线：extensions/universal/
 * base-tool-enhance/src/background/types.ts + registry.ts），禁止在此单侧改名。
 */

/** registry 文件名（<agentDir>/base-tool-enhance/<sessionId>/ 下）。 */
export const BACKGROUND_TASK_REGISTRY_FILENAME = 'registry.json' as const

/** 后台任务根目录名（<agentDir>/ 下，内含 per-sessionId 子目录）。 */
export const BASE_TOOL_ENHANCE_DIRNAME = 'base-tool-enhance' as const

/**
 * 任务 id 前缀（taskId 契约注释已约定：bt- 前缀，对账差集只认该前缀——区别于
 * subagent-workflow 的 bg-/run-）。升级为导出常量：对账/守卫的前缀过滤从此引用
 * 同一常量，禁止各侧字面量重写。
 */
export const BACKGROUND_TASK_ID_PREFIX = 'bt-' as const

/** registry 文件格式版本（读侧 version 不匹配按损坏处理；未来结构变更时迁移判据）。 */
export const BACKGROUND_TASK_REGISTRY_VERSION = 1 as const

/** 终态条目 LRU 上限（写侧合并时按 endedAt ?? startedAt 淘汰最老终态条目）。 */
export const MAX_TERMINAL_REGISTRY_ENTRIES = 50

/**
 * 任务状态机：running → killing（intent 瞬态）→ exited；orphaned 由收殓侧写入。
 *  - running   任务运行中（spawn 后登记的初始态）
 *  - killing   终止已发令（bash_kill / 后台 timeout）、exit 边沿未确认的瞬态
 *  - exited    终态：进程已退出（reason 说明成因）
 *  - orphaned  终态：属主 pi 已死，任务被收殓（补杀或终态收尾）
 */
export type BackgroundTaskState = 'running' | 'killing' | 'exited' | 'orphaned'

/**
 * 终态 reason 枚举（仅 exited 语义）：
 *  - natural       进程自然退出（含外力终止——观测上不可区分）
 *  - timeout       后台显式 timeout 定时器触发
 *  - killed        bash_kill 发令
 *  - process-exit  pi 进程退出收殓
 * orphaned 终态不写 reason（成因「属主强杀遗留」不在本枚举内，保持字段缺省）。
 */
export type BackgroundTaskEndReason = 'natural' | 'timeout' | 'killed' | 'process-exit'

/** registry.json 文件形状（version 锁定 + 条目数组；序列化 JSON indent 2 + 尾部换行）。 */
export interface BackgroundTaskRegistryFile {
  version: typeof BACKGROUND_TASK_REGISTRY_VERSION
  entries: BackgroundTaskRegistryEntry[]
}

/** registry.json 持久化条目（任务运行时对象剥离非持久字段后的形状）。 */
export interface BackgroundTaskRegistryEntry {
  /** 任务 id（表内唯一键；`bt-` 前缀，对账差集只认该前缀）。 */
  taskId: string
  /** 任务进程 pid（收殓补杀目标；判活用 kill(pid,0)，ESRCH = 死）。 */
  pid: number
  /** 原始命令全文。 */
  command: string
  /** stdout/stderr 重定向输出文件路径。 */
  outputFile: string
  /** 任务登记时刻（epoch 毫秒）。 */
  startedAt: number
  /** 状态机（见 BackgroundTaskState）。 */
  state: BackgroundTaskState
  /**
   * 属主判定依据：发起任务的 pi 进程 pid。pi 进程死亡（kill(ownerPiPid,0) 命中
   * ESRCH）→ 其 detached 后台任务孤儿化，收殓器按属主判定处置（属主活 → 跳过，
   * 宁漏杀勿误杀——桌面端并行 session 的合法任务靠此防线豁免）。
   */
  ownerPiPid: number
  /** 发起 session（registry 目录归属）。 */
  sessionId: string
  /** 进程退出码（被 signal 终止时为 null；条目未终态时字段缺省）。 */
  exitCode?: number | null
  /** 终态成因（仅 exited 语义；orphaned 保持缺省）。 */
  reason?: BackgroundTaskEndReason
  /** 终态时刻（epoch 毫秒）。 */
  endedAt?: number
  /** 存活时长 = endedAt - startedAt（毫秒）。 */
  durationMs?: number
  /** exit 边沿组装的输出尾部摘要。 */
  tailSummary?: string
  /**
   * 任务进程 start time（epoch 秒，ps -o lstart= 解析值——勿与 startedAt 的毫秒
   * 混用）：收殓前精确比较防 pid 复用误杀；字段缺省（旧条目 / spawn 时读取失败）
   * 走 startedAt 秒级降级校验。
   */
  pidStartTime?: number
}

/** 任务是否处于活跃态（收殓扫描的候选集；exited/orphaned 直接跳过）。 */
export function isActiveBackgroundTaskState(state: BackgroundTaskState): boolean {
  return state === 'running' || state === 'killing'
}

/** 任务是否处于终态（orphaned 同属终态——收殓二次扫描幂等 no-op 的构造性来源）。 */
export function isTerminalBackgroundTaskState(state: BackgroundTaskState): boolean {
  return state === 'exited' || state === 'orphaned'
}

/**
 * 条目形状运行时 guard（读侧防御，对齐写侧 isValidRegistryEntry 语义）：核心
 * 标识字段（8 个必填字段）类型合法即放行，缺失/脏类型单条丢弃——不因单条脏数据
 * 报废全表。可选字段不做深度校验（与写侧现状一致）。
 */
export function isBackgroundTaskRegistryEntry(item: unknown): item is BackgroundTaskRegistryEntry {
  if (typeof item !== 'object' || item === null) return false
  const e = item as Record<string, unknown>
  return (
    typeof e.taskId === 'string' &&
    typeof e.pid === 'number' &&
    typeof e.command === 'string' &&
    typeof e.outputFile === 'string' &&
    typeof e.startedAt === 'number' &&
    typeof e.state === 'string' &&
    typeof e.ownerPiPid === 'number' &&
    typeof e.sessionId === 'string'
  )
}
