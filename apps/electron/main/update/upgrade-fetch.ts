/**
 * 升级网络访问双引擎封装：undici fetch → 系统 curl 自动降级。
 *
 * 设计决策：docs/design/update-network-resilience.md
 * - §3.2 改进二 A 案：本封装只管引擎维度（「用给定网络参数把请求做成功，
 *   undici 不行换 curl」）；通道维度（代理→直连）由调用方编排，两维度正交。
 * - D4 降级触发矩阵：连接建立失败档降级且记忆；瞬时类/流中断只降级不记忆；
 *   HTTP 状态错误/磁盘错误/AbortError 总超时不降级。
 * - D5 进程级引擎记忆：enginePreference 模块级标志，进程重启自然复位。
 * - D6 curl 调用规格：参数数组 spawn 不走 shell；macOS '/usr/bin/curl'。
 * - D8 错误与落盘：降级点落盘 source='engine-fallback'；对用户的最终错误
 *   分类以 undici 侧为准（curl exit 7 无 errno 级区分），由编排层决定。
 *
 * 职责边界（与 u4/u6 编排层分工）：
 * - 本模块把 curl 失败形态结构化抛出（CurlFetchError：exitCode + kind +
 *   触发降级的原始 undiciError），不做最终对外分类。
 * - undici 不可降级错误原样上抛（errno 完整保留），由调用方 classifyNetError。
 *
 * 依赖方向：upgrade-fetch → net-errors / error-log / proxy-config + undici
 * + node 内置（child_process/fs/os/path）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProxyAgent } from 'undici'
import { buildOutboundChildEnv } from '@taiji/shared'
import type { UpdateStage } from '@taiji/shared'
import { classifyNetError, extractNetErrorCode, extractRawCause, getNodeErrnoCode } from './net-errors.js'
import { appendUpdateError } from './error-log.js'
import { stripCredential } from './proxy-config.js'

/** 使用的引擎（D5：enginePreference 置位后为 'curl'）。 */
export type FetchEngine = 'undici' | 'curl'

/** upgradeFetch 调用选项。 */
export interface UpgradeFetchOptions {
  /** HTTP 方法（默认 GET）。HEAD 保留用于代理连通性测试等探测场景。 */
  method?: 'GET' | 'HEAD'
  /** 附加请求头（默认自带与下载/检测路径一致的 User-Agent）。 */
  headers?: Record<string, string>
  /** 完整代理 URL（含凭证形态，供 ProxyAgent / curl -x）。undefined = 直连。 */
  proxyUrl?: string
  /** 总超时（毫秒，默认 30s 对齐 probe 语义）。 */
  timeoutMs?: number
  /**
   * 本次调用不参与 enginePreference 读写（D5「不参与置位」选项）。
   * testProxy 试错探针使用：不读（flag 已置仍试 undici）不置（探针失败不污染进程级记忆）。
   */
  disableFlagPersistence?: boolean
  /** 降级落盘的 stage 字段（默认 'downloading'）。 */
  stage?: UpdateStage
}

/** upgradeFetch 返回结果。 */
export interface UpgradeFetchResult {
  /** HTTP 2xx 为 true（与 fetch response.ok / curl -f 成功语义对齐）。 */
  ok: boolean
  /** 跟随重定向后的最终状态码（D6：-w '%{http_code}' 与 response.status 对齐）。 */
  status: number
  /** 最终响应头（key 小写，多值逗号合并——与 Headers.entries() 语义对齐）。 */
  headers: Record<string, string>
  /** 响应体文本（GET 时存在；HEAD 无）。 */
  bodyText?: string
  /** 实际使用的引擎（D7：probe 据此决定是否放弃多段）。 */
  usedEngine: FetchEngine
}

// ─── D4：undici 失败分类 ───────────────────────────────────────────

/** undici 失败经 D4 矩阵分类后的档位；'non-fallback' = 不降级。 */
export type UndiciFailureClass =
  | 'connect-establishment'
  | 'transient'
  | 'stream-interrupted'
  | 'non-fallback'

/** 连接建立失败（D4 第一档：降级且记忆）。授权拦截丢包型即 connect timeout。 */
const CONNECT_ESTABLISHMENT_CODES = new Set([
  'EHOSTUNREACH',
  'ECONNREFUSED',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
])

/** 瞬时连接类（D4 第二档：降级不记忆）。CDN 抖动/DNS 瞬断是国内常态。 */
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'])

/** 流中断（D4 第三档：降级不记忆）。 */
const STREAM_INTERRUPTED_CODES = new Set(['UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT'])

/**
 * 按 D4 矩阵分类 undici 失败形态。
 *
 * 磁盘错误与 AbortError 的判定口径与 classifyNetError 的对应分支一致
 * （磁盘：errno 精确匹配 + 'disk space' 子串兜底；超时：AbortError name/message），
 * 保证同一错误在「是否降级」与「错误分类」两条判定上不打架。
 * 未知形态保守归 'non-fallback'（不降级）：降级是白名单优化，未知形态
 * 维持现状「直接失败」语义，避免盲目重试放大故障。
 */
export function classifyUndiciFailure(err: unknown): UndiciFailureClass {
  // D4 磁盘行：换引擎不解决磁盘问题
  const diskErrno = getNodeErrnoCode(err)
  if (
    diskErrno === 'ENOSPC' ||
    diskErrno === 'EACCES' ||
    (err instanceof Error && err.message.toLowerCase().includes('disk space'))
  ) {
    return 'non-fallback'
  }
  // D4 AbortError 行（timeout-slow-flow-wallclock D1 联动改写注释，归类不变）：
  // 总墙钟已删除后 AbortError 来源为 idle 停滞中止（30s 无进展）/ 用户取消 /
  // per-part 共享中止——均非「连接建立类故障」，换引擎收益不确定，保守不降级
  //（降级是白名单优化，未知形态维持直接失败语义）。
  if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
    return 'non-fallback'
  }
  const code = extractNetErrorCode(err)
  if (code !== undefined) {
    if (CONNECT_ESTABLISHMENT_CODES.has(code)) return 'connect-establishment'
    if (TRANSIENT_CODES.has(code)) return 'transient'
    if (STREAM_INTERRUPTED_CODES.has(code)) return 'stream-interrupted'
  }
  return 'non-fallback'
}

// ─── D5：进程级引擎记忆 ───────────────────────────────────────────

/** 模块级引擎偏好（D5：进程生命周期内有效，重启自然复位）。 */
let enginePreference: FetchEngine = 'undici'

/** 查询当前引擎偏好（u4 downloadAsset flag 分流用）。 */
export function getEnginePreference(): FetchEngine {
  return enginePreference
}

/**
 * 按 D4 判定 undici 下载失败是否置 curl 偏好（仅连接建立失败档置位）。
 *
 * 供下载编排层（u4）在多段/单段 undici 下载路径上抛失败后调用——置位判定
 * 逻辑收敛在本封装内（D5），调用方不做分类决策。返回是否实际置位。
 */
export function markEnginePreferenceFromUndiciFailure(err: unknown): boolean {
  if (classifyUndiciFailure(err) === 'connect-establishment') {
    enginePreference = 'curl'
    return true
  }
  return false
}

/** 重置引擎偏好（仅测试用：隔离用例间的模块级状态）。 */
export function resetEnginePreferenceForTest(): void {
  enginePreference = 'undici'
}

// ─── curl 引擎：失败形态结构化（D6/D8） ───────────────────────────

/** curl 失败形态标签（D8 exit code 映射；kind 语义与 classifyNetError 的分类同级）。 */
export type CurlFailureKind =
  | 'connection-failed' // exit 7
  | 'timeout' // exit 28（connect-timeout / speed-time / max-time）
  | 'range-error' // exit 33（-C - 续传被 200 拒绝）
  | 'ssl-error' // exit 35
  | 'receive-error' // exit 56
  | 'http-error' // exit 22（-f 语义）
  | 'spawn-failed' // spawn 失败（ENOENT：curl 缺失，D10 第三步触发器）
  | 'unknown'

/** D8 exit code → 形态映射表。 */
const CURL_EXIT_KIND_MAP: Record<number, CurlFailureKind> = {
  7: 'connection-failed',
  28: 'timeout',
  33: 'range-error',
  35: 'ssl-error',
  56: 'receive-error',
  22: 'http-error',
}

/** exit 22 字面量（-f 的 HTTP 错误语义，解析 httpStatusCode 时判定用）。 */
const CURL_EXIT_KIND_HTTP = 22

const CURL_KIND_DESC: Record<CurlFailureKind, string> = {
  'connection-failed': 'connection failed',
  timeout: 'timeout',
  'range-error': 'HTTP range error',
  'ssl-error': 'SSL connect error',
  'receive-error': 'receive error',
  'http-error': 'HTTP status error',
  'spawn-failed': 'spawn failed',
  unknown: 'unexpected failure',
}

/** stderr 尾部保留长度（诊断用，截尾避免日志膨胀）。 */
const STDERR_TAIL_MAX_CHARS = 500

/** HTTP 2xx 判定边界（与 fetch response.ok 语义对齐）。 */
const HTTP_OK_MIN = 200
const HTTP_OK_MAX_EXCLUSIVE = 300

/**
 * curl 引擎失败（结构化抛出，D8）。
 *
 * 本错误不做最终对外分类：双引擎均失败时对用户的错误分类以 undici 侧为准
 * （undici 错误携带 errno，classifyProxyUnreachable 等精准分类只在 undici 侧成立；
 * curl exit 7 覆盖全部连接失败无 errno 级区分）——编排层（u4/u6）从
 * {@link undiciError} 取 undici 原始错误自行分类，curl 形态仅作落盘诊断字段。
 */
export class CurlFetchError extends Error {
  /** 失败形态（D8 exit code 映射）。 */
  readonly kind: CurlFailureKind
  /** curl 进程退出码（spawn 失败时缺省）。 */
  readonly exitCode?: number
  /** stderr 尾部（诊断用，截尾避免日志膨胀）。 */
  readonly stderrTail?: string
  /** exit 22 时从 -w '%{http_code}' stdout 解析的最终状态码（D6：exit 22 时仍输出）。 */
  readonly httpStatusCode?: number
  /** spawn 失败的 errno（如 ENOENT，D10 第三步「curl 缺失」判定依据）。 */
  readonly spawnErrorCode?: string
  /** 触发降级的 undici 原始错误（直连 curl 路径无此上下文时缺省）。 */
  readonly undiciError?: unknown

  constructor(init: {
    kind: CurlFailureKind
    exitCode?: number
    stderr?: string
    httpStatusCode?: number
    spawnError?: { code?: string; message: string }
    undiciError?: unknown
  }) {
    super(
      init.spawnError
        ? `curl engine unavailable: ${init.spawnError.message} (${init.spawnError.code ?? 'unknown'})`
        : init.httpStatusCode !== undefined
          ? `curl engine failed: HTTP status ${init.httpStatusCode} (exit ${init.exitCode})`
          : `curl engine failed: ${CURL_KIND_DESC[init.kind]} (exit ${init.exitCode})`,
    )
    this.name = 'CurlFetchError'
    this.kind = init.kind
    this.exitCode = init.exitCode
    this.stderrTail = init.stderr !== undefined ? init.stderr.slice(-STDERR_TAIL_MAX_CHARS) : undefined
    this.httpStatusCode = init.httpStatusCode
    this.spawnErrorCode = init.spawnError?.code
    this.undiciError = init.undiciError
  }
}

/**
 * err 是否为「携带 httpStatusCode 的 CurlFetchError」（D8 curl 引擎 HTTP 状态交互规则判定辅助）。
 *
 * true = 服务器已响应（curl -f exit 22 上抛形态）——与「网络错误」（exit 7/28 等无
 * httpStatusCode 的 CurlFetchError / undici 原始网络错误）可区分：调用方须据此重建
 * 既有 HTTP 语义（限流退避 / 非 2xx null 收口 / testProxy「任何响应算成功」），
 * 不得归入网络错误桶触发通道维度「代理→直连」重试。
 */
export function isCurlHttpStatusError(
  err: unknown,
): err is CurlFetchError & { httpStatusCode: number } {
  return err instanceof CurlFetchError && typeof err.httpStatusCode === 'number'
}

// ─── curl 引擎：runner 抽象（子进程可测注入点） ───────────────────

/** curl 一次执行的结果形态。 */
export interface CurlRunResult {
  /** 进程退出码（spawn 失败为 null）。 */
  exitCode: number | null
  /** stdout（-w '%{http_code}' 输出）。 */
  stdout: string
  /** stderr（-sS 错误输出）。 */
  stderr: string
  /** spawn 失败（如 ENOENT：curl 可执行文件缺失）。 */
  spawnError?: { code?: string; message: string }
}

/** curl 执行器：真实实现 spawn 子进程；测试注入假实现模拟 curl 落盘行为。 */
export type CurlRunner = (command: string, args: string[]) => CurlRunResult | Promise<CurlRunResult>

/** 默认 runner：spawn 收集 stdout/stderr/退出码（不走 shell，D6）。
 *
 * 子进程 env 经出站契约构建器组装（C-proc-09）：curl 子进程同样适用
 * deny 清单（剥 TAIJI_AGENT_PACKAGED / TAIJI_RUNTIME_TOKEN 等内部变量，防外泄）。
 */
const defaultCurlRunner: CurlRunner = (command, args) =>
  new Promise<CurlRunResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildOutboundChildEnv({ parentEnv: process.env }),
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        spawnError: { code: e?.code, message: e?.message ?? String(err) },
      })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ exitCode: null, stdout, stderr, spawnError: { code: err.code, message: err.message } })
    })
    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr })
    })
  })

/** curl runner 注入点（仅测试用：注入假 runner 模拟 curl 行为，不真实联网）。 */
let curlRunnerOverride: CurlRunner | undefined

export function __setCurlRunnerForTest(runner?: CurlRunner): void {
  curlRunnerOverride = runner
}

/** curl 可执行文件路径（D6：macOS 系统绝对路径——Apple 签名；win/linux PATH 解析）。 */
function curlExecutable(): string {
  return process.platform === 'darwin' ? '/usr/bin/curl' : 'curl'
}

/** 默认总超时（对齐 probe 30s 语义）。 */
const DEFAULT_TIMEOUT_MS = 30_000

/** curl 连接超时秒数（D6：对齐检测路径 10s）。 */
const CURL_CONNECT_TIMEOUT_S = 10

/** 毫秒→秒换算。 */
const MS_PER_SECOND = 1_000

/** User-Agent：与 download-asset / release-checker 硬编码值一致（GitHub API 空 UA 403）。 */
const UPGRADE_FETCH_USER_AGENT = 'taiji-updater'

/** 合并默认 UA 与调用方附加头（调用方可覆盖）。 */
function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'User-Agent': UPGRADE_FETCH_USER_AGENT, ...extra }
}

/**
 * 解析 -D 落盘的 header 文件内容为 Record（key 小写）。
 *
 * -L 跟随重定向时文件包含每一跳的响应头（空行分隔），最终语义取最后一组
 * （对齐 undici fetch 跟随后 response.headers 的最终响应语义）。
 * 同名头逗号合并（对齐 Headers.entries() 的多值合并形态）。
 */
function parseCurlHeaderFile(content: string): Record<string, string> {
  const groups = content.split(/\r?\n\r?\n/).filter((g) => g.trim().length > 0)
  const last = groups.length > 0 ? groups[groups.length - 1] : ''
  const headers: Record<string, string> = {}
  for (const line of last.split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line)
    if (!m) continue // 状态行（HTTP/1.1 200 OK）与非头行跳过
    const key = m[1].trim().toLowerCase()
    const value = m[2].trim()
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value
  }
  return headers
}

/** 读临时文件（用后清理语义下读取失败按空处理，由 exit code 决定成败）。 */
function safeReadFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * curl 引擎执行（D6 规格）。
 *
 * 阶段拆分（结构性重构，行为不变）：buildCurlArgs（参数构造）→ runner 执行 →
 * throwCurlRunFailure（失败形态结构化抛出）/ buildCurlFetchResult（成功结果组装）。
 *
 * @param undiciError 触发降级的 undici 原始错误（直连 curl 路径不传）——
 *   curl 失败时挂到 CurlFetchError 供编排层按 D8 报 undici 分类。
 */
async function runCurlEngine(
  url: string,
  opts: UpgradeFetchOptions,
  undiciError?: unknown,
): Promise<UpgradeFetchResult> {
  const method = opts.method ?? 'GET'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // headers/body 分文件（D6：避免混流解析），目录级用后清理
  const workDir = mkdtempSync(join(tmpdir(), 'upgrade-fetch-'))
  const headerFile = join(workDir, 'headers.txt')
  const bodyFile = join(workDir, 'body.txt')
  try {
    const args = buildCurlArgs(url, opts, method, timeoutMs, headerFile, bodyFile)
    const runner = curlRunnerOverride ?? defaultCurlRunner
    const r = await runner(curlExecutable(), args)

    if (r.spawnError || r.exitCode !== 0) {
      throwCurlRunFailure(r, undiciError)
    }
    return buildCurlFetchResult(r, method, headerFile, bodyFile, undiciError)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

/** 构造 curl 参数数组（D6 规格：-f/-I/-L/-sS/超时/-w/-D/-o/-x/-H，URL 收尾）。 */
function buildCurlArgs(
  url: string,
  opts: UpgradeFetchOptions,
  method: 'GET' | 'HEAD',
  timeoutMs: number,
  headerFile: string,
  bodyFile: string,
): string[] {
  const args: string[] = ['-f']
  if (method === 'HEAD') args.push('-I')
  // -L 必带：GitHub release URL 实测 302 两跳至 CDN 签名 URL；
  // -sS：静默进度表但保留错误输出到 stderr
  args.push('-L', '-sS')
  args.push('--connect-timeout', String(CURL_CONNECT_TIMEOUT_S))
  args.push('--max-time', String(Math.ceil(timeoutMs / MS_PER_SECOND)))
  args.push('-w', '%{http_code}')
  args.push('-D', headerFile)
  if (method === 'GET') args.push('-o', bodyFile)
  if (opts.proxyUrl) args.push('-x', opts.proxyUrl)
  for (const [k, v] of Object.entries(buildHeaders(opts.headers))) {
    args.push('-H', `${k}: ${v}`)
  }
  args.push(url)
  return args
}

/**
 * curl 失败形态结构化抛出（D8 exit code 映射）：spawn 失败 / 非零退出码两类。
 * 恒 throw。
 */
function throwCurlRunFailure(r: CurlRunResult, undiciError?: unknown): never {
  if (r.spawnError) {
    throw new CurlFetchError({ kind: 'spawn-failed', spawnError: r.spawnError, undiciError })
  }
  const exitCode = r.exitCode ?? -1
  // exit 22（-f 语义）时 -w '%{http_code}' 仍输出最终状态码（D6）
  const httpStatusCode =
    exitCode === CURL_EXIT_KIND_HTTP ? Number.parseInt(r.stdout.trim(), 10) : undefined
  throw new CurlFetchError({
    kind: CURL_EXIT_KIND_MAP[exitCode] ?? 'unknown',
    exitCode,
    stderr: r.stderr,
    httpStatusCode: Number.isFinite(httpStatusCode) ? httpStatusCode : undefined,
    undiciError,
  })
}

/** curl 成功退出（exit 0）后的结果组装：解析 -w 状态码 + 读落盘 header/body。 */
function buildCurlFetchResult(
  r: CurlRunResult,
  method: 'GET' | 'HEAD',
  headerFile: string,
  bodyFile: string,
  undiciError?: unknown,
): UpgradeFetchResult {
  const status = Number.parseInt(r.stdout.trim(), 10)
  if (!Number.isFinite(status) || status <= 0) {
    throw new CurlFetchError({
      kind: 'unknown',
      exitCode: r.exitCode ?? undefined,
      stderr: `unparseable -w output: ${JSON.stringify(r.stdout)}`,
      undiciError,
    })
  }
  return {
    ok: status >= HTTP_OK_MIN && status < HTTP_OK_MAX_EXCLUSIVE,
    status,
    headers: parseCurlHeaderFile(safeReadFile(headerFile)),
    bodyText: method === 'GET' ? safeReadFile(bodyFile) : undefined,
    usedEngine: 'curl',
  }
}

// ─── undici 引擎 ──────────────────────────────────────────────────

/**
 * undici 引擎执行：全局 fetch + 可选 ProxyAgent dispatcher + AbortController 总超时。
 * 代理构造方式对齐 download-asset 的 buildFetchOptions（构造失败降级直连，不阻断）。
 */
async function runUndiciEngine(url: string, opts: UpgradeFetchOptions): Promise<UpgradeFetchResult> {
  const method = opts.method ?? 'GET'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let dispatcher: ProxyAgent | undefined
  try {
    const fetchOpts: RequestInit & { dispatcher?: ProxyAgent } = {
      method,
      headers: buildHeaders(opts.headers),
      signal: controller.signal,
    }
    if (opts.proxyUrl) {
      try {
        dispatcher = new ProxyAgent(opts.proxyUrl)
        fetchOpts.dispatcher = dispatcher
      } catch (err) {
        // best-effort 降级：ProxyAgent 构造失败按直连继续请求（对齐 buildFetchOptions 语义），不阻断
        console.warn('[upgrade-fetch] proxy agent init failed, fallback to direct:', err)
      }
    }
    const res = await fetch(url, fetchOpts)
    const headers = Object.fromEntries(res.headers.entries())
    let bodyText: string | undefined
    if (method === 'GET') {
      // body 读取阶段失败（流中断：UND_ERR_SOCKET / UND_ERR_BODY_TIMEOUT）
      // 在 try 内自然上抛，参与 D4 分类降级
      bodyText = await res.text()
    } else {
      await res.body?.cancel().catch(() => {})
    }
    return { ok: res.ok, status: res.status, headers, bodyText, usedEngine: 'undici' }
  } finally {
    clearTimeout(timer)
    if (dispatcher) await dispatcher.close().catch(() => {})
  }
}

// ─── 降级编排 ─────────────────────────────────────────────────────

/**
 * 降级点落盘（D8）：undici 失败被 curl 兜住时记录 engine-fallback。
 *
 * 这是 A1/A5/A6 验收的可观测依据——降级成功时调用方 handler 不进 catch，
 * 只能在降级发生点（本封装内）落盘。落盘失败静默（不阻断降级主流程）。
 */
function logEngineFallback(err: unknown, opts: UpgradeFetchOptions): void {
  try {
    const stage = opts.stage ?? 'downloading'
    appendUpdateError({
      at: new Date().toISOString(),
      source: 'engine-fallback',
      stage,
      errorCode: classifyNetError(err, stage, opts.proxyUrl).errorCode,
      rawCause: extractRawCause(err),
      proxyUrl: opts.proxyUrl ? stripCredential(opts.proxyUrl).safeUrl : undefined,
      engine: 'undici',
    })
  } catch (err) {
    // 落盘失败不阻断降级主流程（对齐 error-log 容错语义），仅 console 兜底
    console.error('[upgrade-fetch] engine-fallback log write failed:', err)
  }
}

/**
 * 升级网络访问统一入口（双引擎 + D4 降级编排 + D5 引擎记忆）。
 *
 * - HTTP 状态错误（服务器已响应，含 403/404/5xx）不降级：fetch 正常 resolve，
 *   直接返回 ok:false 结果由调用方处理（对齐检测路径既有语义）。
 * - undici 不可降级失败（磁盘 / AbortError 总超时 / 未知形态）原样上抛。
 * - 可降级失败先试 curl：curl 兜住 → 落盘 engine-fallback 返回成功结果；
 *   curl 也失败 → 抛 CurlFetchError（携带 undiciError 供编排层分类）。
 */
export async function upgradeFetch(url: string, opts: UpgradeFetchOptions = {}): Promise<UpgradeFetchResult> {
  const participateInFlag = !opts.disableFlagPersistence
  if (participateInFlag && enginePreference === 'curl') {
    // D5：flag 已置 → 跳过 undici 重探直接 curl（此路径无 undici 错误上下文）
    return runCurlEngine(url, opts)
  }
  try {
    return await runUndiciEngine(url, opts)
  } catch (err) {
    const failureClass = classifyUndiciFailure(err)
    if (failureClass === 'non-fallback') {
      // 原始错误原样上抛：errno 完整保留，由调用方 classifyNetError
      throw err
    }
    if (failureClass === 'connect-establishment' && participateInFlag) {
      // D4 第一档：降级且记忆（授权拦截/代理拒绝是进程生命周期级稳定状态）
      enginePreference = 'curl'
    }
    const result = await runCurlEngine(url, opts, err)
    logEngineFallback(err, opts)
    return result
  }
}
