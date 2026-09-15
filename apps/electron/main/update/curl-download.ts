/**
 * curl 整文件下载器（升级网络双引擎的第二引擎，D6/D7/D10）。
 *
 * 设计：docs/design/update-network-resilience.md §3.3 D6（curl 调用规格全节）/
 * D7（probe 引擎为 curl 时放弃多段、整文件走本模块）/ D10（三步降级链中本模块是
 * 第二步 curl+代理与第三步 curl 直连的执行体）。
 *
 * 职责边界（与 downloadAsset 分工，u4 编排）：
 * - 本模块只负责「用系统 curl 把 asset.downloadUrl 拉到调用方传入的 tempPath」；
 *   产物写 `.downloading` temp，sha256 校验 / rename / resume-state 清理全部归
 *   downloadAsset 统一执行（D6：两引擎同点清理，不散落），本模块不碰。
 * - spawn 系统 curl（macOS 绝对路径 /usr/bin/curl——系统自带且 Apple 签名，是
 *   ad-hoc 授权失效场景的绕行依据；win/linux 走 PATH 解析，缺失由 D10 第三步
 *   回退 undici 直连兜底），参数数组传参不走 shell，无注入面（D6）。
 *
 * [HISTORICAL] 不变量：
 * - 停滞检测是本模块唯一超时形态（timeout-slow-flow-wallclock D1）：外层总墙钟已删除，
 *   连接与传输停滞由 curl 内部 --connect-timeout 10 + --speed-limit 1 --speed-time 30
 *   覆盖（exit 28 双成因，映射文案按 stderr 判别区分）；只要传输持续（≥1B/s）就不会被杀。
 * - exit 33（服务器对续传 Range 回 200 等 range error）→ 删 temp 后从头重下一次
 *   （等价 undici 路径「200 回退覆盖写」语义，D6）；重试仍失败按映射抛出，不无限重试。
 * - exit 7（连接失败）抛 {@link CurlConnectionError}：D10 第二步→第三步（判定代理
 *   整体不可用转直连兜底）依赖此形态识别；不做 errno 级分类（curl exit 7 覆盖
 *   ECONNREFUSED/EHOSTUNREACH 全部连接失败、无区分度，D8）。
 * - spawn ENOENT（curl 不存在，如 Linux 最小环境）原样上抛：D10 第三步按此形态
 *   回退 undici 直连，包装成 UpdateError 会让调用方失去引擎回退判定依据。
 * - 子进程非 detached；main 进程 before-quit 时调 {@link killActiveCurlDownloads}
 *   清杀活跃子进程（防孤儿进程在 app 退出后继续占带宽，D6；内容正确性无风险——
 *   半下载文件本就由 .downloading 后缀 + sha256 兜底）。
 * - 子 env 经 buildOutboundChildEnv 构建（约束 C-proc-09：进程创建点出站契约；
 *   顺带剥掉 HTTPS_PROXY 等环境代理变量，代理只经 -x 显式传入，无隐藏通道）。
 *
 * 依赖方向：curl-download → @taiji/shared（ReleaseAsset + 出站 env 契约）
 *   + update/types（UpdateError）+ node:child_process/fs。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { statSync, unlinkSync } from 'node:fs'
import { buildOutboundChildEnv } from '@taiji/shared'
import type { ReleaseAsset } from '@taiji/shared'
import { UpdateError } from './types.js'

// ─── 常量（对齐口径见各注释；download-asset 的同名常量未导出，故本地声明） ────

/** 空闲中止：30s 无有效字节即中止（--speed-limit 1 --speed-time 30），对齐 IDLE_TIMEOUT_MS。 */
const CURL_SPEED_TIME_SECONDS = 30

/** 连接超时 10s：对齐检测路径既有 10s 语义（D6）。 */
const CURL_CONNECT_TIMEOUT_SECONDS = 10

/** 进度轮询间隔：watch statSync(temp) 文件大小（D6），fake timers 可测。 */
const PROGRESS_POLL_INTERVAL_MS = 500

/** 空闲中止的最小速率阈值：1 字节/s——只要 30s 内有任何字节流动就不算挂死。 */
const SPEED_LIMIT_MIN_BYTES_PER_SEC = 1

// ─── curl exit code 哨兵（映射表见 mapCurlExitToError，语义依据 D6/D8） ──────

const CURL_EXIT_OK = 0
/** 7：连接失败（ECONNREFUSED / EHOSTUNREACH / ENETUNREACH 等全部连接层失败的统称）。 */
const CURL_EXIT_CONNECT_FAILED = 7
/** 22：HTTP 状态错误（-f 语义：≥400 时不落 body 即退出，http_code 仍经 -w 输出）。 */
const CURL_EXIT_HTTP_ERROR = 22
/** 28：超时（connect-timeout / speed-time 触发；删总钟后是 curl 侧唯一超时出口——双成因，文案按 stderr 判别）。 */
const CURL_EXIT_TIMEOUT = 28
/** 33：HTTP range error——续传 Range 被服务器以 200 拒绝等。 */
const CURL_EXIT_RANGE_ERROR = 33
/** 35：SSL/TLS 握手错误。 */
const CURL_EXIT_SSL_CONNECT_ERROR = 35
/** 56：接收错误（连接建立后数据传输中断）。 */
const CURL_EXIT_RECV_ERROR = 56
/** close 事件无退出码（进程被信号杀死等）时的哨兵。 */
const CURL_EXIT_UNKNOWN = -1

// ─── 错误形态 ─────────────────────────────────────────────────────────────────

/**
 * curl 连接失败（exit 7）的结构化形态。
 *
 * 供 D10 编排识别「curl 亦连接失败」→ 判定代理整体不可用 → 直连兜底；
 * 继承 UpdateError（errorCode=UPDATE_NETWORK_FAILED）保持错误体系单一（G3），
 * 额外携带 curlExitCode 供调用方 instanceof / 数值双重判定。
 */
export class CurlConnectionError extends UpdateError {
  /** curl 退出码（当前恒为 7，保留数值字段便于诊断日志与未来细分） */
  readonly curlExitCode: number

  constructor(message: string, curlExitCode: number, rawCause?: string) {
    super(message, 'downloading', 'UPDATE_NETWORK_FAILED', rawCause)
    this.name = 'CurlConnectionError'
    this.curlExitCode = curlExitCode
  }
}

/**
 * 单次 curl 运行的原始失败信号（内部控制流用，不导出）。
 *
 * 携带原始 exit code 供外层区分「exit 33 重下」与「直接映射抛出」两条路径；
 * 对用户的错误分类统一在 mapCurlExitToError 收口（对齐 download-asset 的
 * RangeNotRespectedError 内部信号模式）。
 */
class CurlExitError extends Error {
  readonly exitCode: number
  readonly stderrText: string
  readonly httpCode: string | undefined

  constructor(exitCode: number, stderrText: string, httpCode: string | undefined) {
    super(`curl exited with code ${exitCode}`)
    this.name = 'CurlExitError'
    this.exitCode = exitCode
    this.stderrText = stderrText
    this.httpCode = httpCode
  }
}

// ─── 活跃子进程登记（before-quit 清杀用，D6） ────────────────────────────────

/** 模块级活跃 curl 子进程登记：spawn 时登记、settled 后注销（防跨下载误杀）。 */
const activeCurlChildren = new Set<ChildProcess>()

/**
 * 清杀全部进行中的 curl 下载子进程。
 *
 * main 进程 `before-quit` 时调用：curl 非 detached，退出前主动 kill 防孤儿进程
 * 继续占用带宽；半下载产物由 .downloading 后缀 + 调用方 sha256 校验兜底，无
 * 内容正确性风险（D6）。被杀的子进程以 close(code=null) 收尾，对应下载 promise
 * 以 UPDATE_NETWORK_FAILED 形态 reject（app 退出中通常无人消费）。
 */
export function killActiveCurlDownloads(): void {
  for (const child of activeCurlChildren) {
    try {
      child.kill()
    } catch (err) {
      // best-effort：单个 kill 失败（进程已退出等）不阻断其余清杀
      console.warn('[curl-download] kill active curl child failed:', err)
    }
  }
}

// ─── 参数构造 ─────────────────────────────────────────────────────────────────

/**
 * curl 可执行文件解析（D6）：macOS 固定 /usr/bin/curl（系统自带 + Apple 签名，
 * 授权绕行的机制依据；不依赖 PATH 防用户环境注入）；win（System32 curl.exe）/
 * linux 走 PATH 解析，缺失时 spawn ENOENT 由 D10 第三步兜底。
 */
function getCurlPath(): string {
  return process.platform === 'darwin' ? '/usr/bin/curl' : 'curl'
}

/**
 * 构造 curl 参数数组（数组传参不走 shell，URL/代理来自受控配置，无注入面）。
 *
 * [NOTE] `-C -` 恒带：以 temp 文件实际落盘字节数为续传起点（D6「与 undici 侧
 * statSync 口径一致」——文件实际大小是唯一权威），temp 不存在时 curl 自动从 0
 * 全新下载，语义等价覆盖写；服务器对续传 Range 回 200 时 curl exit 33，由外层
 * 删 temp 从头重下一次兜底（等价 undici 200 回退）。
 */
function buildCurlArgs(url: string, tempPath: string, proxyUrl: string | undefined): string[] {
  const args = [
    // -f：HTTP ≥400 时 exit 22 且不输出 body——缺失时错误页会写进 .downloading
    // temp，被 sha256 失败掩盖真实原因（D6）
    '-f',
    // -L：必带——GitHub release URL 实测 302 两跳至 CDN 签名 URL，不跟随则拿到
    // 重定向页、sha256 必挂（与 undici redirect:'follow' 对齐，D6）
    '-L',
    '--connect-timeout', String(CURL_CONNECT_TIMEOUT_SECONDS),
    '--speed-limit', String(SPEED_LIMIT_MIN_BYTES_PER_SEC),
    '--speed-time', String(CURL_SPEED_TIME_SECONDS),
    '-C', '-',
    '-o', tempPath,
    // -w：与 -f 不冲突，exit 22 时 %{http_code} 仍输出最终码（跟随重定向后），
    // 供错误 message 携带 http_code（D6）；stdout 只含此 3 字节输出（body 落 -o 文件）
    '-w', '%{http_code}',
  ]
  if (proxyUrl) {
    args.push('-x', proxyUrl)
  }
  args.push(url)
  return args
}

/** 从 stdout 提取 -w 输出的 http_code（3 位数字；无匹配返回 undefined）。 */
function parseHttpCode(stdoutText: string): string | undefined {
  const match = /(\d{3})/.exec(stdoutText.trim())
  return match?.[1]
}

/**
 * curl exit 28 的 stderr 成因判别（timeout-slow-flow-wallclock D1 + r2 复审 SG-3）。
 *
 * exit 28 双成因：--connect-timeout 10s（连接未建立）与 --speed-time 30s（传输停滞）。
 * stderr 判别 connect-timeout 信号词 → 连接超时；否则（含 stderr 为空）按停滞。
 * 典型 stderr：connect-timeout = "curl: (28) Connection timed out after N milliseconds"
 * / "Failed to connect..."；speed-time = "curl: (28) Operation too slow. Less than
 * N bytes/sec transferred the last M seconds"。
 */
function isCurlConnectTimeout(stderrText: string): boolean {
  return /connection timed out|failed to connect/i.test(stderrText)
}

/** 把单次 curl 的原始退出码映射为用户可见错误（D6 exit code 表）。 */
function mapCurlExitToError(err: CurlExitError): UpdateError {
  const rawCause = err.stderrText.trim() || undefined
  switch (err.exitCode) {
    case CURL_EXIT_CONNECT_FAILED:
      // 结构化形态：D10 依赖此识别「curl 连接失败」判定代理不可用/引擎回退
      return new CurlConnectionError(
        `curl connection failed (exit ${err.exitCode})`,
        err.exitCode,
        rawCause,
      )
    case CURL_EXIT_TIMEOUT: {
      // 双成因文案：不把连接失败误标为「30 秒无数据停滞」（误导用户排查方向）。
      // stderr 有内容但信号词未命中（curl 升级/本地化文案漂移）时 warn 留原文，
      // 防「停滞」归类静默退化（S3）。
      const isConnectTimeout = isCurlConnectTimeout(err.stderrText)
      if (!isConnectTimeout && err.stderrText.trim().length > 0) {
        console.warn(
          `[curl-download] exit 28 stderr 未命中 connect-timeout 信号词，按停滞归类，原始 stderr：${err.stderrText.trim()}`,
        )
      }
      return new UpdateError(
        isConnectTimeout
          ? `curl connection timeout (no connection within ${CURL_CONNECT_TIMEOUT_SECONDS}s, exit ${err.exitCode})`
          : `curl download stalled (no data for ${CURL_SPEED_TIME_SECONDS}s, exit ${err.exitCode})`,
        'downloading',
        'UPDATE_NETWORK_TIMEOUT',
        rawCause,
      )
    }
    case CURL_EXIT_SSL_CONNECT_ERROR:
    case CURL_EXIT_RECV_ERROR:
    case CURL_EXIT_HTTP_ERROR:
      return new UpdateError(
        err.exitCode === CURL_EXIT_HTTP_ERROR
          ? `curl HTTP error (exit ${CURL_EXIT_HTTP_ERROR}, http_code ${err.httpCode ?? 'unknown'})`
          : `curl transfer error (exit ${err.exitCode})`,
        'downloading',
        'UPDATE_NETWORK_FAILED',
        rawCause,
      )
    default:
      return new UpdateError(
        `curl failed with exit code ${err.exitCode}`,
        'downloading',
        'UPDATE_NETWORK_FAILED',
        rawCause,
      )
  }
}

// ─── 单次运行 ─────────────────────────────────────────────────────────────────

/**
 * 执行一次 curl 下载并等待其收尾。
 *
 * - 进度：500ms 轮询 statSync(tempPath).size 推 onProgress（只推原始字节，节流
 *   与百分比折算归调用方——D6「复用现有节流回调」）；temp 未创建时跳过该轮。
 * - 无外层总墙钟（timeout-slow-flow-wallclock D1）：停滞检测由 curl 内部
 *   --connect-timeout 10（连接未建立）+ --speed-limit 1 --speed-time 30（30s
 *   平均速率 <1B/s）覆盖，触发即 exit 28 → mapCurlExitToError 按 stderr 判别成因；
 *   只要传输持续（≥1B/s），无论多久都不被杀。
 * - 'error'（spawn 失败，如 ENOENT）原样上抛；'close' 按 exit code 分流
 *   （0 成功 / 其他抛内部 CurlExitError 由外层映射）。
 */
async function runCurlOnce(
  args: string[],
  tempPath: string,
  onProgress: ((downloadedBytes: number) => void) | undefined,
): Promise<void> {
  const child = spawn(getCurlPath(), args, {
    // 非 detached（D6）；stdout 捕获 -w 的 http_code，stderr 捕获诊断文本
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildOutboundChildEnv({ parentEnv: process.env }),
  })
  activeCurlChildren.add(child)

  let stdoutText = ''
  let stderrText = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdoutText += String(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { stderrText += String(chunk) })

  let progressTimer: NodeJS.Timeout | undefined
  if (onProgress) {
    progressTimer = setInterval(() => {
      try {
        onProgress(statSync(tempPath).size)
      } catch { // eslint-disable-line taste/no-silent-catch -- temp 未创建（curl 未写出首字节）时跳过该轮；保留 catch 防 statSync 抛错炸掉 interval 回调
      }
    }, PROGRESS_POLL_INTERVAL_MS)
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      child.once('error', (err: Error) => {
        if (settled) return
        settled = true
        // spawn 失败（ENOENT = curl 不存在等）原样上抛：D10 第三步按此形态回退
        // undici 直连，包装成 UpdateError 会丢失引擎回退判定依据
        reject(err)
      })
      child.once('close', (code: number | null) => {
        if (settled) return
        settled = true
        if (code === CURL_EXIT_OK) {
          resolve()
        } else {
          reject(new CurlExitError(code ?? CURL_EXIT_UNKNOWN, stderrText, parseHttpCode(stdoutText)))
        }
      })
    })
  } finally {
    activeCurlChildren.delete(child)
    if (progressTimer) clearInterval(progressTimer)
  }
}

// ─── 对外入口 ─────────────────────────────────────────────────────────────────

/**
 * downloadViaCurl 的调用选项。
 */
export interface IDownloadViaCurlOptions {
  /** 代理 URL（含凭证形态 http://user:pass@host:port）；undefined = 直连 */
  proxyUrl?: string
  /**
   * 调用方已知的续传字节数（downloadAsset 从 resume-state / statSync 得出）。
   * 语义声明字段：curl `-C -` 以 temp 文件实际落盘字节数为续传起点（D6 statSync
   * 口径，文件实际大小是唯一权威），故本值不参与参数构造，仅作编排方意图记录。
   */
  resumeBytes?: number
  /** `.downloading` temp 路径（由调用方传入，产物原地写于此；校验/rename 归调用方） */
  tempPath: string
  /** 进度回调：收到 statSync 的原始字节数（节流与百分比折算归调用方） */
  onProgress?: (downloadedBytes: number) => void
}

/**
 * 用系统 curl 整文件下载 release asset 到 tempPath（双引擎降级的第二引擎）。
 *
 * @param asset 待下载的 release 资产（downloadUrl）
 * @param opts 见 {@link IDownloadViaCurlOptions}
 * @returns `{ tempPath }`——产物已落盘但未校验，sha256 校验与 rename 归 downloadAsset
 * @throws CurlConnectionError exit 7（连接失败，供 D10 判定代理不可用/引擎回退）
 * @throws UpdateError exit 28 → UPDATE_NETWORK_TIMEOUT；22/35/56/其他 → UPDATE_NETWORK_FAILED
 * @throws 原生 Error spawn ENOENT 等进程创建失败原样上抛（供 D10 第三步回退 undici）
 */
export async function downloadViaCurl(
  asset: ReleaseAsset,
  opts: IDownloadViaCurlOptions,
): Promise<{ tempPath: string }> {
  const args = buildCurlArgs(asset.downloadUrl, opts.tempPath, opts.proxyUrl)
  try {
    await runCurlOnce(args, opts.tempPath, opts.onProgress)
    return { tempPath: opts.tempPath }
  } catch (err) {
    if (!(err instanceof CurlExitError)) throw err
    if (err.exitCode !== CURL_EXIT_RANGE_ERROR) throw mapCurlExitToError(err)
    // exit 33：续传 Range 被服务器拒绝（典型：对 Range 回 200 全量）→ 删 temp 后
    // 从头重下一次（等价 undici 路径「200 回退覆盖写」语义，D6）；temp 已删则
    // `-C -` 自动从 0 起步。重试仍失败按映射抛出，不无限重试。
    try {
      unlinkSync(opts.tempPath)
    } catch (unlinkErr) {
      // best-effort：删失败（被占用等）时重下退化为再次续传，sha256 兜底正确性
      console.warn('[curl-download] range-error temp cleanup failed:', unlinkErr)
    }
    try {
      await runCurlOnce(args, opts.tempPath, opts.onProgress)
      return { tempPath: opts.tempPath }
    } catch (retryErr) {
      if (retryErr instanceof CurlExitError) throw mapCurlExitToError(retryErr)
      throw retryErr
    }
  }
}
