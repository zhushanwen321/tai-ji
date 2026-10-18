/**
 * subagent-control 帧层（runtime 侧视角，M3 设计 §3.4.3 帧表 + §3.3 D8）。
 *
 * 单行 JSON 信封协议；kind/version/reason 词表单源 = SDK control-protocol.ts（禁手写
 * 字面量）。本模块职责：帧 payload 接口（u-foundation 留给消费单元的部分）、形状守卫
 * 解析、上限常量、超长帧头部归因提取。runtime 是 hello_ok/hello_reject/engine_opened/
 * engine_open_failed/engine_closed/error 的发送方、hello/engine_open/engine_frame/
 * engine_close 的接收方。
 *
 * engine_open 的 launch 字段：契约 SSOT = core transport/types.ts 的 EngineLaunchSpec
 * （core 包 exports 未暴露该 deep path，runtime 以结构镜像承载——不 value import 该
 * deep path；runtime 对 core 的运行时消费限于 barrel 与语义子入口）。设计 §3.4.3 帧表把 engineId/
 * rootSessionId/parentRecordId/depth 列在顶层、§3.4.3 launch spec 接口将其收在 launch
 * 内——解析取「launch 权威 + 顶层同名字段存在即覆盖」的并集读法，两种写法均可解析。
 */
import {
  SUBAGENT_CONTROL_PROTOCOL_VERSION,
  SUBAGENT_CONTROL_FRAME_KINDS,
  SUBAGENT_CONTROL_CLOSED_REASONS,
  isSubagentControlFrameKind,
  isSubagentControlClosedReason,
  type SubagentControlClosedReason,
} from '@zhushanwen/subagent-engine-sdk'

export {
  SUBAGENT_CONTROL_PROTOCOL_VERSION,
  SUBAGENT_CONTROL_FRAME_KINDS,
  SUBAGENT_CONTROL_CLOSED_REASONS,
  isSubagentControlClosedReason,
}
export type { SubagentControlClosedReason }

// ── 上限与时间窗（§3.3 D8；测试经 server options 注入小值，缺省为设计值）──────

/** control 信封单帧上限（engine_frame.line 是其中的字符串载荷）。 */
// eslint-disable-next-line no-magic-numbers -- 设计标定值（32MB，D8）
export const CONTROL_MAX_FRAME_BYTES = 32 * 1024 * 1024
/** 每 channel 单方向待写队列字节上限。 */
export const CHANNEL_QUEUE_MAX_BYTES = CONTROL_MAX_FRAME_BYTES
/** 每 channel 单方向待写队列帧数上限。 */
export const CHANNEL_QUEUE_MAX_FRAMES = 4096
/** 每连接每方向全部 channel 待写字节总和上限（聚合上界，R1 影响面审 #4）。 */
// eslint-disable-next-line no-magic-numbers -- 设计标定值（256MB，D8）
export const CONNECTION_QUEUE_MAX_BYTES = 256 * 1024 * 1024
/** 每连接 channel 数上限（超出回 engine_open_failed channel_limit）。 */
export const MAX_CHANNELS_PER_CONNECTION = 256
/** hello 等待窗（连接建立到 hello 帧；超时断连）。 */
export const CONTROL_HELLO_TIMEOUT_MS = 10_000
/** engine_open 处理窗（占位登记到 spawn 应答；超时中止 + 杀组）。 */
export const ENGINE_OPEN_TIMEOUT_MS = 10_000
/** engine_close 有界等待（dispose 异步落盘窗口；超时即杀组，D7 时间窗登记）。 */
export const ENGINE_CLOSE_GRACE_MS = 3_000
/** stderr 尾部环缓冲容量（engine_closed.stderrTail，排障用）。 */
export const STDERR_TAIL_CHARS = 400
/** 超长帧归因提取的头部字节数（D8：读前 1KB 提取 v/kind/channelId）。 */
export const OVERSIZE_FRAME_HEAD_BYTES = 1024

// ── 帧 payload 接口（方向见 SDK control-protocol.ts 文件头帧表）──────────────

/** engine_open 帧的 launch 载荷（wire 形；契约 SSOT = core EngineLaunchSpec 结构镜像）。 */
export type EngineLaunchSpecWire = {
  engineId: string
  entryPath: string
  args: string[]
  cwd: string
  envPrefixes: string[]
  rootSessionId: string
  parentRecordId?: string
  depth?: number
  /**
   * 本通道的自申报 record id（可选 wire 扩展，设计帧表未列）：channel 树的父链挂点——
   * 嵌套通道以 parentRecordId 指向父通道的 recordId 建树（递归收割的登记面）。缺省
   * null：该通道无树挂点，收割依赖进程组 + 连接 fan-out 的结构性保证（嵌套 task pi
   * 死亡必关其连接）。
   */
  recordId?: string
}

export type ControlHelloFrame = {
  v: number
  kind: typeof SUBAGENT_CONTROL_FRAME_KINDS.hello
  id: string | number
  hostPid?: number
  hostKind?: string
}

export type ControlEngineOpenFrame = {
  v: number
  kind: typeof SUBAGENT_CONTROL_FRAME_KINDS.engineOpen
  id: string | number
  launch: EngineLaunchSpecWire
}

export type ControlEngineFrameFrame = {
  v: number
  kind: typeof SUBAGENT_CONTROL_FRAME_KINDS.engineFrame
  channelId: string
  line: string
}

export type ControlEngineCloseFrame = {
  v: number
  kind: typeof SUBAGENT_CONTROL_FRAME_KINDS.engineClose
  channelId: string
}

/** C→R 四帧（runtime 接收面）。 */
export type ControlInboundFrame =
  | ControlHelloFrame
  | ControlEngineOpenFrame
  | ControlEngineFrameFrame
  | ControlEngineCloseFrame

// ── 形状守卫（外部输入解析的单点判据；畸形 → null，处置按连接阶段分流）────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFrameId(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && !value.some((v) => typeof v !== 'string')
}

/** launch 载荷形状守卫（engine_open 专判；顶层同名字段在 mergeLaunchAliases 合并）。 */
function isLaunchSpecShape(value: unknown): value is EngineLaunchSpecWire {
  if (!isRecord(value)) return false
  return typeof value.engineId === 'string' && value.engineId.length > 0
    && typeof value.entryPath === 'string' && value.entryPath.length > 0
    && typeof value.cwd === 'string' && value.cwd.length > 0
    && isStringArray(value.args)
    && isStringArray(value.envPrefixes)
    && typeof value.rootSessionId === 'string' && value.rootSessionId.length > 0
}

/** 顶层同名字段覆盖（§3.4.3 帧表写法兼容；不改变 launch 权威读法）。 */
function mergeLaunchAliases(frame: Record<string, unknown>, launch: EngineLaunchSpecWire): EngineLaunchSpecWire {
  const merged = { ...launch }
  if (typeof frame.rootSessionId === 'string' && frame.rootSessionId.length > 0) merged.rootSessionId = frame.rootSessionId
  if (typeof frame.parentRecordId === 'string' && frame.parentRecordId.length > 0) merged.parentRecordId = frame.parentRecordId
  if (typeof frame.depth === 'number') merged.depth = frame.depth
  if (typeof frame.recordId === 'string' && frame.recordId.length > 0) merged.recordId = frame.recordId
  return merged
}

/**
 * 解析一行 control 帧（C→R 接收面）。返回 null = 畸形（JSON 错 / kind 不在词表 /
 * 该 kind 形状守卫不过）——处置归调用方按连接阶段分流（hello 前拒绝断连；hello 后
 * 计数丢弃或按 channelId 归因关通道）。
 */
export function parseControlInboundFrame(line: string): ControlInboundFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (!isSubagentControlFrameKind(parsed.kind)) return null
  if (parsed.v !== SUBAGENT_CONTROL_PROTOCOL_VERSION) return null
  switch (parsed.kind) {
    case SUBAGENT_CONTROL_FRAME_KINDS.hello:
      return toHelloFrame(parsed)
    case SUBAGENT_CONTROL_FRAME_KINDS.engineOpen:
      return toEngineOpenFrame(parsed)
    case SUBAGENT_CONTROL_FRAME_KINDS.engineFrame:
      return toEngineFrameFrame(parsed)
    case SUBAGENT_CONTROL_FRAME_KINDS.engineClose:
      return toEngineCloseFrame(parsed)
    default:
      return null // R→C 方向的 kind 不该出现在 C→R
  }
}

function toHelloFrame(parsed: Record<string, unknown>): ControlHelloFrame | null {
  if (!isFrameId(parsed.id)) return null
  return {
    v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
    kind: SUBAGENT_CONTROL_FRAME_KINDS.hello,
    id: parsed.id,
    hostPid: typeof parsed.hostPid === 'number' ? parsed.hostPid : undefined,
    hostKind: typeof parsed.hostKind === 'string' ? parsed.hostKind : undefined,
  }
}

function toEngineOpenFrame(parsed: Record<string, unknown>): ControlEngineOpenFrame | null {
  if (!isFrameId(parsed.id)) return null
  if (!isLaunchSpecShape(parsed.launch)) return null
  return {
    v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
    kind: SUBAGENT_CONTROL_FRAME_KINDS.engineOpen,
    id: parsed.id,
    launch: mergeLaunchAliases(parsed, parsed.launch),
  }
}

function toEngineFrameFrame(parsed: Record<string, unknown>): ControlEngineFrameFrame | null {
  const channelId = parsed.channelId
  if (typeof channelId !== 'string' || channelId.length === 0) return null
  if (typeof parsed.line !== 'string') return null
  return {
    v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
    kind: SUBAGENT_CONTROL_FRAME_KINDS.engineFrame,
    channelId,
    line: parsed.line,
  }
}

function toEngineCloseFrame(parsed: Record<string, unknown>): ControlEngineCloseFrame | null {
  const channelId = parsed.channelId
  if (typeof channelId !== 'string' || channelId.length === 0) return null
  return {
    v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
    kind: SUBAGENT_CONTROL_FRAME_KINDS.engineClose,
    channelId,
  }
}

// ── engine_open_failed / error 帧的 code 词表（runtime 侧裁决字面）────────────
//
// SDK ENGINE_TRANSPORT_ERROR_CODES 族是 extension 侧 transport 错误面；引擎通道裁决
// 帧的 code 是 runtime 侧行内词表（设计 §3.4.3 只点名 session/channel_limit，spawn
// 失败透传 SDK EngineSdkError.code 如 engine_not_found）。消费方（core control-shared
// 的 mapControlError）逐 code 收敛：engine_ 前缀码原样透传
//（engine_open_timeout / engine_frame_too_large / engine_backpressure_overflow）；
// 非 engine_ 前缀按语义分流——channel_limit → engine_backpressure_overflow（detail
// 显式标注「通道数上限，非字节背压」）、invalid_launch / spawn_failed → engine_crashed、
// session / duplicate → engine_transport_unavailable、unknown_channel → **原 code 透传**
//（通道终局，不是连接丢失——D10 的 engine_transport_lost 只表示 control 连接中途丢失），
// 词表未覆盖的其它非 engine_ code 才落 engine_transport_unavailable。
// 词表扩充时须同步核对消费侧映射。

export const CONTROL_FRAME_ERROR_CODES = {
  sessionMismatch: 'session',
  channelLimit: 'channel_limit',
  duplicate: 'duplicate',
  invalidLaunch: 'invalid_launch',
  openTimeout: 'engine_open_timeout',
  spawnFailed: 'spawn_failed',
  unknownChannel: 'unknown_channel',
  frameTooLarge: 'engine_frame_too_large',
  backpressureOverflow: 'engine_backpressure_overflow',
} as const

export type ControlFrameErrorCode = (typeof CONTROL_FRAME_ERROR_CODES)[keyof typeof CONTROL_FRAME_ERROR_CODES]
  | // spawn 失败透传 SDK 错误码（engine_not_found 等）
  string

// ── 超长帧头部归因（D8：读前 1KB 提取 v/kind/channelId，无法归因才关整条连接）──

/**
 * 超长帧头部归因（D8：读前 1KB 提取 v/kind/channelId，无法归因才关整条连接）。
 * 截断 JSON 不可解析（字符串字面量未闭合，补右括号无效）——按字段名正则提取，
 * 字段在前 1KB 内即可归因（channelId 在 envelope 头部，line 载荷在其后）。
 */
/** 超长帧头部归因结果（数据形状，非可实现契约——按 oe-audit 口径用 type 别名）。 */
export type OversizeFrameHead = {
  kind: unknown
  channelId?: string
}

const HEAD_FIELD_RES = {
  kind: /"kind"\s*:\s*"([a-z_]+)"/,
  channelId: /"channelId"\s*:\s*"([^\"]+)"/,
} as const

export function extractOversizeFrameHead(line: string): OversizeFrameHead {
  const head = line.slice(0, OVERSIZE_FRAME_HEAD_BYTES)
  const kindMatch = HEAD_FIELD_RES.kind.exec(head)
  const channelMatch = HEAD_FIELD_RES.channelId.exec(head)
  return {
    kind: kindMatch !== null ? kindMatch[1] : undefined,
    channelId: channelMatch !== null ? channelMatch[1] : undefined,
  }
}

/** 字节计数（UTF-8；上限判据统一走本函数，不用 string.length 低估多字节）。 */
export function byteLengthOf(line: string): number {
  return Buffer.byteLength(line, 'utf8')
}
