/**
 * pi MCP 连接测试探针（设计 pi-mcp-management §3.3 D3 通道契约 + D8 pi 实测类徽标，单元 u4）。
 *
 * 通道：spawn `pi mcp list --json`。CLI 权威 = node_modules @earendil-works/pi-coding-agent
 * 1.0.0 dist/extensions/mcp/cli.js（list 分支：全部条目并行真实连接后 JSON.stringify 一次性
 * 输出 stdout，退出码 0 全部正常 / 1 有失败——errors 非空或任一启用条目 state ≠ connected）。
 *
 * 定死契约（D3）：
 * 1. 子进程 env 与会话 spawn 同一装配点（rpc-client.ts start 同款）：buildPiOutboundEnv
 *    （pi-rpc）注入 buildOutboundChildEnv（C-proc-09 出站契约，不直传 process.env）+
 *    PI_CODING_AGENT_DIR 指向 <数据目录>/agent/（getPiAgentDir SSOT，值同源）；
 * 2. spawn cwd = taiji 数据目录（getConfigDir，非任何会话目录）——项目级 .pi/mcp.json 的
 *    信任判定按持久化 trust store 且数据目录不通过，测试范围恒等于用户级条目；
 * 3. 整体墙钟超时默认 150 秒：pi 逐请求 timeout 默认 60 秒，单条目最坏经过 initialize 与
 *    tools/list 两个各计超时的请求段（≈120 秒），150 秒为默认下限，防误杀合法慢服务器。
 *    调用方可传 timeoutMs 放大——D3 公式「2 × 最大显式 timeout + 30 秒余量」的输入是
 *    mcp.json 内容，属装配层（u2b）职责，probe 只收最终墙钟。到点杀进程，本次测试无任何
 *    结果（kind:'timeout'）：CLI 一次性输出，中途杀进程 stdout 无可解析的部分结果（D3
 *    结构限制），不存在「部分条目照常呈现」形态。
 *
 * 非零退出码（有失败服务器）= 正常解析输出 + 失败态徽标，不抛错不阻塞清单读写（D3）。
 * stdout 非法 JSON = 降级错误态（kind:'invalid-output'，含原始输出摘要）。
 */
import { spawn } from 'node:child_process'
import { buildOutboundChildEnv } from '../spawn-env.js'
import { buildPiOutboundEnv } from '@zhushanwen/pi-rpc'
import { findPiExecutable } from './find-pi-executable.js'
import { getConfigDir, getPiAgentDir } from './pi-paths.js'

/** D3 默认墙钟下限（量级依据见文件头注释 3）。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 150_000

/** invalid-output 摘要截断长度（防 CLI 异常输出整段入内存/日志）。 */
const RAW_EXCERPT_MAX_CHARS = 500

/**
 * pi 连接层 ServerState 枚举（pi 1.0.0 dist/extensions/mcp/runtime.d.ts:19）+ list 报告
 * 对禁用条目固定写入的 'disabled'（cli.js:356）。
 */
export const PI_SERVER_STATES = [
  'connecting',
  'connected',
  'disconnected',
  'needs-auth',
  'failed',
  'closed',
] as const
export type PiServerState = (typeof PI_SERVER_STATES)[number] | 'disabled'

/** `pi mcp list --json` servers[] 条目形状（V2 字段集锚定：cli.js:348-383 逐字段核实）。 */
export interface PiMcpListServerReport { // oe-exempt:20261004:framework:pi CLI 输出契约形状（V2 字段集核对锚，适配层不信任外部格式）
  name: string
  scope: string
  source: string
  enabled: boolean
  exposure: string
  transport: string
  state: PiServerState
  tools: string[]
  toolExposure?: Record<string, string>
  resources?: number
  resourceTemplates?: number
  error?: string
}

/** `pi mcp list --json` 顶层形状（cli.js:387；note 仅在项目级文件存在且不被信任时出现）。 */
export interface PiMcpListOutput { // oe-exempt:20261004:framework:pi CLI 输出契约形状（V2 字段集核对锚，适配层不信任外部格式）
  servers: PiMcpListServerReport[]
  errors: string[]
  note?: string
}

/**
 * D8 pi 实测类状态徽标（§3.3 D8①：「已连接（N 个工具）/ 连接失败（含错误原因）/
 * 需要登录 / 已停用」——此处为语义枚举 + 数据，中文文案由 renderer i18n 承担）。
 */
export type McpProbeServerStatus =
  | { kind: 'connected'; toolsCount: number; toolNames: string[] }
  | { kind: 'needs-auth' }
  | { kind: 'disabled' }
  | {
      kind: 'failed'
      /** pi 原始 state（connecting/disconnected/failed/closed 及异常残留），供 UI 展示原值。 */
      state: PiServerState
      /** 条目级完整错误详情（CLI 的 error 字段，含 stderr 尾部——D8：失败徽标详情入口全文展开）；无错误时缺省。 */
      errorDetail?: string
    }

/** 单条目清单行素材（status 为 D8 pi 实测类徽标；scope/exposure/transport 以 CLI 默认值兜底）。 */
export interface McpProbeServerReport { // oe-exempt:20261004:framework:probe→handler 投影形状（D8 徽标语义层，UI 文案由 i18n 承担）
  name: string
  scope: string
  exposure: string
  transport: string
  status: McpProbeServerStatus
}

export type McpProbeResult =
  | {
      kind: 'ok'
      /** CLI 退出码：0 全部正常 / 1 有失败服务器或配置错误（非零不抛错，D3）。 */
      exitCode: number
      servers: McpProbeServerReport[]
      /** errors[] 原文（`<path>: <原因>` 字符串数组）——「配置有误」标注素材（D8③ 的来源素材）。 */
      configErrors: string[]
      /** 项目级文件不被信任时的 CLI 附注（taiji cwd = 数据目录，正常不出现；透传防丢信息）。 */
      note?: string
    }
  /** 整体墙钟超时：本次测试无任何结果（D3 结构限制——CLI 一次性输出，无部分条目）。 */
  | { kind: 'timeout'; timeoutMs: number }
  /** stdout 非法 JSON / 形状不符：降级错误态，rawExcerpt = 原始输出摘要。 */
  | { kind: 'invalid-output'; rawExcerpt: string }
  /** pi 二进制定位失败或 spawn 系统级错误（ENOENT 等）。 */
  | { kind: 'spawn-failed'; message: string }

/** probe 子进程最小结构缝（node ChildProcess 结构兼容；DI 供表驱动单测注入 fake）。 */
export interface McpProbeChildProcess { // oe-exempt:20261004:framework:probe 子进程最小结构缝（node ChildProcess 结构兼容，DI fake 契约）
  stdout: { on(event: 'data', listener: (chunk: string | Buffer) => void): unknown }
  stderr: { on(event: 'data', listener: (chunk: string | Buffer) => void): unknown }
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown
  /** 与 node ChildProcess.kill 同签名（超时到点杀进程，D3；probe 只以无参形式调用）。 */
  kill(signal?: NodeJS.Signals | number): boolean
}

export type McpProbeSpawnImpl = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
) => McpProbeChildProcess

export interface McpProbeOptions { // oe-exempt:20261004:framework:probe 注入缝选项（spawnImpl/piExecutable DI 缝契约）
  /** 整体墙钟（D3 默认下限 150 秒；装配层按「2 × 最大显式 timeout + 30 秒」放大后传入）。 */
  timeoutMs?: number
  /** findPiExecutable 入参（dev 模式 = apps/electron 目录，同 process-manager 用法）。 */
  projectRoot?: string
  /** 跳过二进制定位直接指定 pi 路径（装配覆盖 / 测试注入）。缺省走 findPiExecutable。 */
  piExecutable?: string
  /** spawn 实现注入（测试缝；缺省 node child_process.spawn）。 */
  spawnImpl?: McpProbeSpawnImpl
}

/**
 * 执行一次连接测试。整体测试接口（D3 结构限制：CLI 全部条目测完一次性输出，
 * 单条目独立测试做不到）；失败全部走结果态降级，不抛错（连接测试是辅助功能，
 * 失败降级为状态显示不阻塞主流程——设计 §3.2 P 级核对）。
 */
export async function runMcpProbe(options: McpProbeOptions = {}): Promise<McpProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  let piPath: string
  try {
    piPath = options.piExecutable ?? findPiExecutable(options.projectRoot ?? process.cwd())
  } catch (error) {
    return {
      kind: 'spawn-failed',
      message: `pi 可执行文件定位失败：${errorMessage(error)}。请确认 pi 已安装（或重装应用修复内置二进制）。`,
    }
  }

  // C-proc-09 + D3 契约①：与会话 spawn（rpc-client.ts start）同一 env 装配点——
  // 白名单过滤 + deny 兜底（buildOutboundChildEnv）+ PI_CODING_AGENT_DIR 数据目录隔离。
  const env = buildPiOutboundEnv({
    parentEnv: process.env,
    buildChildEnv: buildOutboundChildEnv,
    piAgentDir: getPiAgentDir(),
  })
  // D3 契约②：cwd = taiji 数据目录（项目级配置不被读取，范围恒用户级条目）。
  const cwd = getConfigDir()

  const spawnImpl: McpProbeSpawnImpl = options.spawnImpl ?? ((command, args, opts) => spawn(command, args, opts))

  let child: McpProbeChildProcess
  try {
    child = spawnImpl(piPath, ['mcp', 'list', '--json'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return { kind: 'spawn-failed', message: `启动 pi mcp list 失败：${errorMessage(error)}` }
  }

  return await new Promise<McpProbeResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let spawnError: Error | undefined
    let timedOut = false
    let settled = false

    const settle = (result: McpProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    // stdin 用 'ignore'：list 分支不读 stdin（login 才读），防异常形态下 CLI 等待输入挂起。
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    })
    child.on('error', (error) => {
      // spawn 系统级失败（ENOENT 等）。close 随后可能仍触发，由 settled 去重。
      spawnError = error
    })
    child.on('close', (code) => {
      if (timedOut) {
        settle({ kind: 'timeout', timeoutMs })
        return
      }
      if (spawnError !== undefined) {
        settle({
          kind: 'spawn-failed',
          message: `启动 pi mcp list 失败：${spawnError.message}。请确认 pi 可执行文件可用后重试。`,
        })
        return
      }
      settle(parseMcpListOutput(stdout, stderr, code ?? 1))
    })
  })
}

/**
 * 解析 `pi mcp list --json` 的 stdout（纯函数，表驱动锚定点）。
 *
 * 降级判定：JSON.parse 失败、顶层形状不符（servers/errors 非数组）均归 invalid-output。
 * 非零退出码不进此函数判定（CLI 有失败时输出仍为合法 JSON，退出码由调用方随 ok 结果透出）。
 */
export function parseMcpListOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
): Extract<McpProbeResult, { kind: 'ok' }> | Extract<McpProbeResult, { kind: 'invalid-output' }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { kind: 'invalid-output', rawExcerpt: buildRawExcerpt(stdout, stderr) }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'invalid-output', rawExcerpt: buildRawExcerpt(stdout, stderr) }
  }
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.servers) || !Array.isArray(record.errors)) {
    return { kind: 'invalid-output', rawExcerpt: buildRawExcerpt(stdout, stderr) }
  }

  const servers = record.servers
    .map((entry) => mapServerReport(entry))
    .filter((entry): entry is McpProbeServerReport => entry !== undefined)
  const configErrors = record.errors.filter((entry): entry is string => typeof entry === 'string')
  const note = typeof record.note === 'string' ? record.note : undefined

  return note === undefined
    ? { kind: 'ok', exitCode, servers, configErrors }
    : { kind: 'ok', exitCode, servers, configErrors, note }
}

/**
 * 单条目映射（纯函数）：pi state 枚举 → D8 pi 实测类徽标。条目形状守卫按「pi 适配层
 * 不信任外部格式」执行：name 非字符串的条目丢弃（返回 undefined），其余字段缺失按
 * CLI 默认值兜底（cli.js:351-355 同款默认）。状态映射穷尽枚举：
 * connected → 已连接（工具数）；needs-auth → 需要登录；disabled → 已停用；
 * 其余（connecting/disconnected/failed/closed）→ 连接失败（errorDetail = 条目 error 全文）。
 */
export function mapServerReport(raw: unknown): McpProbeServerReport | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name === '') return undefined

  const state = isPiServerState(record.state) ? record.state : 'failed'
  const tools = Array.isArray(record.tools)
    ? record.tools.filter((tool): tool is string => typeof tool === 'string')
    : []

  let status: McpProbeServerStatus
  if (state === 'connected') {
    status = { kind: 'connected', toolsCount: tools.length, toolNames: tools }
  } else if (state === 'needs-auth') {
    status = { kind: 'needs-auth' }
  } else if (state === 'disabled') {
    status = { kind: 'disabled' }
  } else {
    status = {
      kind: 'failed',
      state,
      ...(typeof record.error === 'string' ? { errorDetail: record.error } : {}),
    }
  }

  return {
    name: record.name,
    scope: typeof record.scope === 'string' ? record.scope : 'global',
    exposure: typeof record.exposure === 'string' ? record.exposure : 'codemode',
    transport: typeof record.transport === 'string' ? record.transport : '',
    status,
  }
}

function isPiServerState(value: unknown): value is PiServerState {
  return typeof value === 'string'
    && ((PI_SERVER_STATES as readonly string[]).includes(value) || value === 'disabled')
}

/** invalid-output 摘要：stdout 优先；stdout 空时退 stderr（CLI usage/崩溃信息更可诊断）。 */
function buildRawExcerpt(stdout: string, stderr: string): string {
  const source = stdout.trim() !== '' ? stdout : stderr
  const truncated = source.length > RAW_EXCERPT_MAX_CHARS
    ? `${source.slice(0, RAW_EXCERPT_MAX_CHARS)}…（截断，共 ${source.length} 字符）`
    : source
  return truncated.trim() !== '' ? truncated : '（pi mcp list 无输出）'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
