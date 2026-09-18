/**
 * Asset 下载器（流式 + sha256 校验）。
 *
 * 对应 slice auto-update-and-install w3：从 GitHub release asset 下载安装包到
 * `<dataDir>/update/`，下载完成后做 sha256（或 size）完整性校验。
 *
 * 职责链：
 *   1. fetch asset.downloadUrl（全局 fetch，与 release-checker 一致；AbortController 60s 超时）
 *   2. 流式写到升级工作目录（getUpdateDir()）下 `<name>.downloading`（mkdirSync recursive）
 *   3. 下载完成后读文件算 sha256（createHash）
 *   4. asset.sha256 存在则校验，不匹配抛 UpdateIntegrityError
 *   5. asset.sha256 缺失则降级：size 存在校验 size，size 也缺失抛 UpdateIntegrityError
 *      （正常 release 必有 sha256 或非零 size，二者全缺视为可疑，拒绝）
 *   6. rename .downloading 到最终文件名，返回 { filePath }
 *
 * u4 双引擎降级编排接入——
 * - 入口 flag 分流（D5：enginePreference='curl' 直接 curl 整文件）+ probe 经
 *   upgradeFetch（D7：usedEngine='curl' 本次放弃多段）+ 多段/单段失败按 D4 分类降级
 *   （连接建立失败置 flag；瞬时类/流中断只降级不记忆；HTTP/磁盘/总超时不降级）
 *   + D10 三步链（curl+代理 → CurlConnectionError 判定代理不可用 → 直连兜底：
 *   curl 可用走 curl 直连，curl 缺失 spawn ENOENT 回退 undici 直连）。
 * - 双引擎均失败对外报 undici 错误分类（D8：undici 错误携带 errno 精准分类，
 *   curl 侧形态只作 engine:'curl' 落盘诊断）。
 * - resume-state 清理统一在校验链前执行（D6：undici / curl 两引擎同点清理，不散落）。
 *
 * [HISTORICAL] 不变量：
 * - 用全局 fetch（不用 electron.net，与 release-checker 一致，便于测试 mock）
 * - 流式下载：response.body.getReader() 累加 chunk 算进度 + pipe 到 writeStream（避免 100MB 一次进内存）
 * - 停滞检测是唯一超时形态（timeout-slow-flow-wallclock D1）：idle watchdog（30s 无进展
 *   即 abort）在 fetch 发起之前挂载，覆盖等响应头 + 流式传输全过程（clear 在 stream
 *   完成后才执行）；总墙钟已删除——只要下载还在传字节，无论多慢都不被杀，停滞 30s
 *   中断后走断点续传
 * - 校验失败必须删除半下载文件，避免下次误用残文件
 * - .downloading 临时后缀：崩溃后残留文件不会伪装成完整安装包
 *
 * 依赖方向：download-asset → constants + types + hash + net-errors + upgrade-fetch
 *   + curl-download + error-log + @taiji/shared + node:fs/stream
 *   （hash 为无网络依赖的纯函数叶子模块，见 hash.ts / review S#13）
 */
import { createWriteStream, createReadStream, mkdirSync, renameSync, statSync, unlinkSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ProxyAgent } from 'undici'
import type { ReleaseAsset, IProxyConfig } from '@taiji/shared'
import { getUpdateDir } from './constants.js'
import { hashFileSha256 } from './hash.js'
import { resolveProxyUrl, stripCredential } from './proxy-config.js'
import { UpdateError, UpdateIntegrityError } from './types.js'
import { classifyNetError, extractRawCause, getNodeErrnoCode } from './net-errors.js'
import {
  upgradeFetch,
  getEnginePreference,
  markEnginePreferenceFromUndiciFailure,
  classifyUndiciFailure,
} from './upgrade-fetch.js'
import type { FetchEngine } from './upgrade-fetch.js'
import { downloadViaCurl, CurlConnectionError } from './curl-download.js'
import { appendUpdateError } from './error-log.js'
import { toErrorMessage } from '../utils/error-message'

/**
 * 断点续传状态接口。
 * 记录下载进度和文件路径，支持从断点继续下载。
 */
interface IResumeState {
  /** 已下载的字节数 */
  downloadedBytes: number
  /** 总字节数 */
  totalBytes: number
  /** 临时文件路径 */
  tempPath: string
  /** 最终文件路径 */
  finalPath: string
}

/**
 * 断点续传状态文件路径（延迟求值：跟随 getDataDir，见 constants.ts）。
 */
function getResumeStateFile(): string {
  return path.join(getUpdateDir(), 'resume-state.json')
}

/**
 * 空闲超时：下载全程（等响应头 + 流式传输）连续 N ms 没有进展即中断。
 *
 * 国内网络典型故障是「连接建立后中途停滞」：流仍在「等字节」但实际已挂死。
 * 30s 无进展基本可判定连接已无效，主动 abort 后上层可走断点续传重连。
 *
 * 停滞检测是下载链路唯一保留的超时形态（timeout-slow-flow-wallclock D1）：
 * 总墙钟已删除——只要下载还在传字节，无论多慢都不被杀。watchdog 前移到
 * fetch 发起之前挂载，等响应头阶段同样受保护（响应头到达视为首个进展）。
 */
const IDLE_TIMEOUT_MS = 30_000

/**
 * 把 fetch 返回的 web ReadableStream 适配成 Node stream/web 的 ReadableStream 类型，
 * 供 `Readable.fromWeb` 消费。
 *
 * [S#4 / type-safety] 这是 Node Web Stream 互操作的公认 TS 缺陷：
 * fetch `response.body` 是 lib.dom 的 `ReadableStream<Uint8Array>`，与 `node:stream/web`
 * 的 `ReadableStream` 结构性不兼容（同构但分别声明），TS 拒绝直接赋值。
 * 运行时两者是同一个对象（Node 用 undici 实现 fetch，返回的就是 web ReadableStream）。
 * 把 `as unknown as T` 双重断言集中收敛到这唯一一处封装函数，其余调用点不再散落断言。
 */
function toNodeReadableWebStream(
  body: ReadableStream<Uint8Array> | null,
): import('stream/web').ReadableStream<Uint8Array> {
  return body as unknown as import('stream/web').ReadableStream<Uint8Array>
}

/**
 * 返回 temp 文件当前真实落盘字节数；读取失败时回退到内存计数器。
 *
 * pipe 写盘是缓冲异步的，内存计数器可能比真实文件偏大或偏小。
 * 续传必须用真实落盘字节，否则 Range 起点会越过已写内容造成重叠/空洞。
 */
function getPersistedBytes(tempPath: string, fallback: number): number {
  try {
    return statSync(tempPath).size
  } catch (err) {
    console.warn('[download] stat temp for resume failed:', err)
    return fallback
  }
}

/** ms → s 换算因子（用于错误消息里的超时秒数展示）。 */
const MS_PER_SECOND = 1000

/** HTTP 206 Partial Content：服务器接受 Range 请求、返回断点续传数据。 */
const HTTP_PARTIAL_CONTENT = 206

/**
 * 1 MiB 的字节数（字节阈值常量的组合基元）。
 * [NOTE] 保持单一字面量形式（不用 1024 * 1024）：no-magic-numbers 对
 * 「单一字面量整初始值的 const 声明」豁免，表达式初始值则逐字面量报。
 */
const BYTES_PER_MIB = 1_048_576

/**
 * 断点续传状态保存阈值：每超过上次保存点 N 字节才落盘一次。
 *
 * 替代旧的 `downloaded % 1MB === 0` 整除判断——后者在续传场景
 * （downloaded 从非 1MB 整数倍起步）几乎永远不再命中，导致中途崩溃
 * state 仍是旧值。改用阈值比较保证进度稳步落盘且不过频写文件。
 */
const SAVE_INTERVAL_BYTES = BYTES_PER_MIB

/**
 * totalBytes 一致性校验容差：续传时新请求拿到的 content-length 与
 * 记录的 totalBytes 差异超此阈值，视为 release 文件已变更（残文件过期），
 * 作废重下。允许小容差以容忍 CDN 行为差异。
 */
const TOTAL_BYTES_TOLERANCE = 1024

const PROGRESS_MAX = 100

/** 下载请求 User-Agent：与 release-checker 保持一致，避免部分 CDN 因空 UA 限速/拒绝。 */
const DOWNLOAD_USER_AGENT = 'taiji-updater'

/**
 * 多段并行下载：把单条 TCP 连接拆成 N 条并发 Range 请求，绕过部分代理/出口对
 * 单条 HTTP/1.1 连接的限速。GitHub release asset 位于 Azure Blob，支持
 * accept-ranges: bytes，具备拆分条件。
 */
const MULTI_PART_COUNT = 4

/** 多段启用阈值（MiB）：只有文件大于此值才启用多段（小文件拆分收益低、连接开销占比大）。 */
const MIN_MULTI_PART_MIB = 10
const MIN_MULTI_PART_SIZE = MIN_MULTI_PART_MIB * BYTES_PER_MIB

/** 每段最小体积（MiB），防止段数过多。 */
const MIN_BYTES_PER_PART_MIB = 2
const MIN_BYTES_PER_PART = MIN_BYTES_PER_PART_MIB * BYTES_PER_MIB

/** 进度回调节流间隔：同一段下载内最多每 N ms 推一次进度，降低 IPC 压力。 */
const PROGRESS_THROTTLE_MS = 200

/**
 * 下载单个 asset 并校验完整性。
 *
 * @param asset 待下载的 release 资产（含 downloadUrl / sha256 / size）
 * @param onProgress 下载进度回调（0-100 百分比）
 * @param proxyConfig 代理配置（可选，不传则禁用代理）
 * @returns 下载完成后最终文件路径（已通过校验）；multiPart = 本次是否实际走了
 *   多段路径（probe supported 且多段真实完成——降级单段/curl 接管均为 false）；
 *   engine = 本次成功完成下载的实际引擎（curl 接管与 undici 两态，降级后成功的
 *   以实际成功者为准）。两字段是 download-success 观测面的数据源（设计 §7.2
 *   error-log 行 / §8.2 S1：multiPart=true 断言防 probe 改造回归静默退化单段）。
 * @throws UpdateIntegrityError sha256/size 校验失败
 */
export async function downloadAsset(
  asset: ReleaseAsset,
  onProgress?: (percent: number) => void,
  proxyConfig?: IProxyConfig,
): Promise<{ filePath: string; multiPart: boolean; engine: FetchEngine }> {
  // 1. 准备目录 + 临时文件路径
  const updateDir = getUpdateDir()
  mkdirSync(updateDir, { recursive: true })
  const tempPath = path.join(updateDir, `${asset.name}.downloading`)
  const finalPath = path.join(updateDir, asset.name)
  // 引擎编排用的完整代理 URL（upgradeFetch / downloadViaCurl 吃 URL 形态；
  // undici 路径仍按原样用 proxyConfig 构造 ProxyAgent）
  const proxyUrl = proxyConfig ? resolveProxyUrl(proxyConfig) : undefined

  // 2. 检查是否有断点续传状态（恢复判定提取到 resolveResumeStartBytes）
  const resumeState = loadResumeState()
  const downloadedBytes = resolveResumeStartBytes(resumeState, tempPath, finalPath)

  // 3. 引擎编排（u4：双引擎降级 + D10 三步链，设计 §3.4 数据流图）。
  //    - A/D5 flag 分流：enginePreference 已置 curl（此前连接建立失败）→ 跳过 undici
  //      直接 curl 整文件（授权坏场景每次 undici 连接失败都是白付的失败延迟）。
  //    - B/D7 probe 经 upgradeFetch（双引擎）：usedEngine='curl' → 本次放弃多段直接
  //      curl 整文件；flag 置位与否由 upgradeFetch 内部按 D4 判定，这里不做置位决策。
  //    - C/D 多段/单段失败按 D4 分类：连接建立失败 → 置 flag + 降级 curl；瞬时类/流中断
  //      → 仅本次降级；HTTP/磁盘/超时类（non-fallback：含 idle 停滞中止/用户取消，D1 删总钟
  //      后 AbortError 均非「连接建立类故障」，保守不降级）原样上抛不降级。
  //    [时序不变量 timeout-tick-parity] 编排分支保持提取前的同步判断形态（if/else 直达
  //    首个 IO await 调用点），禁止 async 编排 wrapper：从本函数进入到首个 IO await
  //    （curl 链 / probe / downloadSingleStream→fetch）之间的 await 挂起点必须与提取前
  //    逐一 tick 对齐——D1 idle 用例以 fake timers + 同步 enqueue 编排数据流，多一个
  //    await tick 即使 fetch 晚到、测试的 source 捕获错位（2026-09 U03 实证）。
  const orchestrationCtx: IEngineOrchestrationContext = {
    tempPath, finalPath, downloadedBytes, resumeState, onProgress, proxyConfig, proxyUrl,
  }
  // useMultiPart 提升到函数级：成功返回时作为 multiPart 观测值（download-success
  // 观测面消费，见 @returns）。多段成功路径才置 true——降级单段 / curl 接管均保持 false。
  let handledByCurl = false
  let useMultiPart = false
  if (getEnginePreference() === 'curl') {
    await runCurlDownloadChain(asset, {
      tempPath: orchestrationCtx.tempPath,
      finalPath: orchestrationCtx.finalPath,
      downloadedBytes: orchestrationCtx.downloadedBytes,
      onProgress: orchestrationCtx.onProgress,
      proxyUrl: orchestrationCtx.proxyUrl,
    })
    handledByCurl = true
  }

  if (!handledByCurl) {
    // [S#1 / business-logic] 多段启用阈值用 release 声明的 asset.size，而非 probe 返回的
    // 真实 totalBytes：此判定在 probe 之前，目的是先过滤掉小文件，避免对每个小文件都发一次
    // probe 请求（额外 RTT）。即使 release 声明 size 被误填偏小，导致大文件误走单段下载，
    // probe 仍会兜底判 supported=false；多段只是加速优化，单段下载本身完全正确，无正确性风险。
    if (!resumeState && asset.size && asset.size >= MIN_MULTI_PART_SIZE) {
      const probed = await probeMultiPartSupport(asset, proxyUrl)
      if (probed.usedEngine === 'curl') {
        // D7：probe 引擎为 curl → 本次放弃多段（多段是 undici 的加速优化），直接整文件
        // curl 下载。多段前提即无续传状态，此处 downloadedBytes 恒为 0。
        await runCurlDownloadChain(asset, { tempPath, finalPath, downloadedBytes: 0, onProgress, proxyUrl })
        handledByCurl = true
      } else if (probed.supported) {
        // [RM3] 服务器/代理不遵守 Range（任一段非 206 或段长不符）→ 整批放弃多段：
        // 不设 useMultiPart，落入下方单段路径完整下载。此时 downloadedBytes=0（进多段
        // 的前提就是无续传状态），单段全新请求不带 Range 头，既有 206/200 分类天然
        // 兼容「忽略 Range 回 200」的服务器，sha256 校验兜底产物正确性。
        const multiOutcome = await attemptMultiPartDownload(asset, orchestrationCtx, probed.totalBytes)
        useMultiPart = multiOutcome.useMultiPart
        handledByCurl = multiOutcome.handledByCurl
      }
    }

    // 4. 单段下载（续传或 Probe 未通过时走此路径），失败按 D4 分类降级 curl。
    if (!useMultiPart && !handledByCurl) {
      await downloadSingleStreamWithFallback(asset, orchestrationCtx)
    }
  }

  // 5. 校验链前统一清理 resume-state（D6：undici / curl 两引擎同点清理，不散落）。
  //    curl 续传以 temp 实际落盘字节为准（-C -），state 只服务 undici 续传。
  clearResumeState()

  // 6. 校验：sha256 优先，缺失降级 size，再缺失拒绝（[BLOCKER 4] 拒绝全缺，见 helper）
  await verifyDownloadedAsset(asset, tempPath)

  // 7. rename .downloading → 最终文件名（权限/失败错误分类见 renameToFinalPath）
  renameToFinalPath(tempPath, finalPath)
  // 到达此点 = 下载已成功：engine 取实际成功者（curl 接管 / undici），失败路径不会抵达
  return { filePath: finalPath, multiPart: useMultiPart, engine: handledByCurl ? 'curl' : 'undici' }
}

/**
 * 断点续传恢复判定（downloadAsset 阶段 2）：决定本次下载的续传起点字节数。
 *
 * 仅当 state 与本次 temp/final 路径完全匹配时才考虑续传；temp 文件缺失或
 * state 显著失真时清 state 重下。返回 0 表示全新下载。
 */
function resolveResumeStartBytes(
  resumeState: IResumeState | null,
  tempPath: string,
  finalPath: string,
): number {
  if (!resumeState || resumeState.tempPath !== tempPath || resumeState.finalPath !== finalPath) {
    return 0
  }
  // 有断点续传状态，检查临时文件是否存在
  if (existsSync(tempPath)) {
    const stat = statSync(tempPath)
    // [B-4] 保存口径已统一为 statSync（保存时刻真实落盘字节），续传判定以 stat.size
    // 为准：不大于 state 直接从 stat.size 续传；略大于 state（超出量 ≤ SAVE_INTERVAL_BYTES，
    // 保存后 pipe 仍异步刷盘、硬崩溃常落在两次保存之间）同样信任真实落盘字节续传——
    // 崩溃续传不再退化为全量重下，内容正确性由 [m5] totalBytes 一致性校验（206 响应）
    // + 最终 sha256/size 校验兜底。只有 stat.size 显著大于 state（残文件被外部追加等）
    // 或超过 totalBytes 上界才作废重下。
    const overshoot = stat.size - resumeState.downloadedBytes
    if (overshoot <= 0 || (overshoot <= SAVE_INTERVAL_BYTES && stat.size <= resumeState.totalBytes)) {
      const downloadedBytes = stat.size
      console.log(`[download] resuming from ${downloadedBytes} bytes (state ${resumeState.downloadedBytes})`)
      return downloadedBytes
    }
    // temp 比 state 记录的大很多，异常 → 重新下载
    console.log(`[download] resume state mismatch (temp ${stat.size} > state ${resumeState.downloadedBytes}), restarting download`)
    clearResumeState()
    return 0
  }
  // 临时文件不存在，重新下载
  console.log(`[download] temp file not found, restarting download`)
  clearResumeState()
  return 0
}

/** 引擎编排上下文（downloadAsset 装配层 → curl/undici 路径共享参数）。 */
interface IEngineOrchestrationContext {
  /** `.downloading` temp 路径 */
  tempPath: string
  /** 最终文件路径 */
  finalPath: string
  /** 续传起点字节数（resolveResumeStartBytes 的判定结果） */
  downloadedBytes: number
  /** 已加载的断点续传状态（多段资格判定 / 单段 m5 校验用） */
  resumeState: IResumeState | null
  /** 进度回调（0-100 百分比） */
  onProgress?: (percent: number) => void
  /** 代理配置（undici ProxyAgent 构造用） */
  proxyConfig?: IProxyConfig
  /** 完整代理 URL（upgradeFetch / downloadViaCurl 吃 URL 形态） */
  proxyUrl?: string
}

/** 多段尝试结果：handledByCurl = 本次下载已由 curl 引擎接管；useMultiPart = 多段下载已成功。 */
interface IMultiPartOutcome {
  handledByCurl: boolean
  useMultiPart: boolean
}

/**
 * 多段下载执行 + 失败分类编排（仅 probe supported 后进入）。
 *
 * [RM3] 服务器/代理不遵守 Range（任一段非 206 或段长不符）→ 整批放弃多段：
 * 不设 useMultiPart，落入单段路径完整下载。此时 downloadedBytes=0（进多段
 * 的前提就是无续传状态），单段全新请求不带 Range 头，既有 206/200 分类天然
 * 兼容「忽略 Range 回 200」的服务器，sha256 校验兜底产物正确性。
 */
async function attemptMultiPartDownload(
  asset: ReleaseAsset,
  ctx: IEngineOrchestrationContext,
  totalBytes: number,
): Promise<IMultiPartOutcome> {
  try {
    const multiResult = await downloadMultiPart(asset, totalBytes, ctx.onProgress, ctx.proxyConfig)
    return { handledByCurl: false, useMultiPart: !multiResult.degradedToSingle }
  } catch (err) {
    // C：多段失败编排。RangeNotRespectedError 已在 downloadMultiPart 内部消化为
    // degradedToSingle（降级单段语义保持），到这里的是网络/磁盘/HTTP 分类错误。
    if (classifyUndiciFailure(err) === 'non-fallback') {
      throw err
    }
    // 置位判定收敛在 upgrade-fetch（D5）：仅连接建立失败档实际置 flag，
    // 瞬时类/流中断只本次降级不记忆（下次调用重探 undici 多段）。
    markEnginePreferenceFromUndiciFailure(err)
    await runCurlDownloadChain(asset, {
      tempPath: ctx.tempPath, finalPath: ctx.finalPath, downloadedBytes: 0,
      onProgress: ctx.onProgress, proxyUrl: ctx.proxyUrl, undiciError: err,
    })
    logUndiciEngineFallback(err, ctx.proxyUrl)
    return { handledByCurl: true, useMultiPart: false }
  }
}

/**
 * 单段下载（undici）+ 失败分类降级 curl（downloadAsset 阶段 4 的单段兜底路径；
 * 续传或 Probe 未通过时走此路径）。
 *
 * D：单段失败编排——连接建立失败/瞬时类/流中断 → 降级 curl（downloadViaCurl 以
 * -C - 从 temp 现有字节续传，语义对齐）；HTTP/磁盘/超时类（non-fallback）原样上抛。
 */
async function downloadSingleStreamWithFallback(asset: ReleaseAsset, ctx: IEngineOrchestrationContext): Promise<void> {
  try {
    await downloadSingleStream(asset, {
      tempPath: ctx.tempPath,
      finalPath: ctx.finalPath,
      downloadedBytes: ctx.downloadedBytes,
      resumeState: ctx.resumeState,
      onProgress: ctx.onProgress,
      proxyConfig: ctx.proxyConfig,
    })
  } catch (err) {
    if (classifyUndiciFailure(err) === 'non-fallback') {
      throw err
    }
    markEnginePreferenceFromUndiciFailure(err)
    await runCurlDownloadChain(asset, {
      tempPath: ctx.tempPath, finalPath: ctx.finalPath, downloadedBytes: ctx.downloadedBytes,
      onProgress: ctx.onProgress, proxyUrl: ctx.proxyUrl, undiciError: err,
    })
    logUndiciEngineFallback(err, ctx.proxyUrl)
  }
}

/**
 * 下载产物完整性校验（downloadAsset 阶段 6）。
 *
 * [BLOCKER 4] sha256 优先；缺失降级 size（非零）；二者全缺拒绝——正常 release 必有其一。
 * 校验失败必须删除半下载文件（best-effort，清理失败仅 console.warn），避免下次误用残文件。
 */
async function verifyDownloadedAsset(asset: ReleaseAsset, tempPath: string): Promise<void> {
  if (asset.sha256) {
    const actualSha = await hashFileSha256(tempPath)
    if (actualSha !== asset.sha256.toLowerCase()) {
      try { unlinkSync(tempPath) } catch (unlinkErr) { console.warn('[download] sha256 mismatch cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
      throw new UpdateIntegrityError(
        `sha256 mismatch: expected ${asset.sha256}, got ${actualSha}`,
        'UPDATE_SHA256_MISMATCH',
      )
    }
  } else if (asset.size && asset.size > 0) {
    const actualSize = statSync(tempPath).size
    if (actualSize !== asset.size) {
      try { unlinkSync(tempPath) } catch (unlinkErr) { console.warn('[download] size mismatch cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
      throw new UpdateIntegrityError(
        `size mismatch: expected ${asset.size}, got ${actualSize}`,
      )
    }
  } else {
    // sha256 和有效 size 都缺失：拒绝（不应出现于正常 release）
    try { unlinkSync(tempPath) } catch (unlinkErr) { console.warn('[download] no integrity cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
    throw new UpdateIntegrityError(
      `no integrity check available (sha256 and size both missing) for ${asset.name}`,
    )
  }
}

/**
 * rename .downloading → 最终文件名 + 落定失败错误分类（downloadAsset 阶段 7）。
 *
 * [W-6] 优先用 errno code（EACCES/EPERM）精确匹配，子串 'permission' 仅作非英文
 * OS message 的 fallback。[m9] 非 permission 失败用独立错误码 UPDATE_FILE_RENAME_FAILED
 * （不复用 UPDATE_INTEGRITY_FAILED，语义错配）。
 */
function renameToFinalPath(tempPath: string, finalPath: string): void {
  try {
    renameSync(tempPath, finalPath)
  } catch (renameErr) {
    const renameErrno = getNodeErrnoCode(renameErr)
    if (renameErrno === 'EACCES' || renameErrno === 'EPERM' ||
        (renameErr instanceof Error && renameErr.message.toLowerCase().includes('permission'))) {
      throw new UpdateError(
        'permission denied during file replacement',
        'replacing',
        'UPDATE_PERMISSION_DENIED',
      )
    }
    throw new UpdateError(
      `file rename failed: ${toErrorMessage(renameErr)}`,
      'replacing',
      'UPDATE_FILE_RENAME_FAILED',
    )
  }
}

/** 单段流式下载的执行上下文（downloadAsset 编排层 / curl 链 undici 直连回退共用）。 */
interface ISingleStreamContext {
  /** `.downloading` temp 路径 */
  tempPath: string
  /** 最终文件路径（m5 作废重下递归 downloadAsset 时沿用原编排参数） */
  finalPath: string
  /** 续传起点字节数（0 = 全新下载 / 覆盖写） */
  downloadedBytes: number
  /** 已加载的断点续传状态（m5 totalBytes 一致性校验用；null = 跳过该校验） */
  resumeState: IResumeState | null
  /** 进度回调（0-100 百分比） */
  onProgress?: (percent: number) => void
  /** 代理配置：undefined = 无 dispatcher 直连（D10 第三步 undici 直连回退用） */
  proxyConfig?: IProxyConfig
}

/**
 * idle 停滞检测 watchdog：连续 IDLE_TIMEOUT_MS 无进展即 abort controller。
 *
 * 在 fetch 发起之前创建（timeout-slow-flow-wallclock D1）：删除总墙钟后，等响应头
 * 阶段也由本 watchdog 覆盖——响应头到达视为首个进展（reset），之后每收到 chunk 继续
 * reset。P2 探针实证：真实 GitHub CDN header 时延 p50≈0.4s / max≈0.9s，30s 边界
 * 余量 >30x；per-part 路径（idle 本挂 fetch 前）已在生产以同形态运行。
 */
function createIdleWatchdog(controller: AbortController) {
  let timer: NodeJS.Timeout | undefined = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
  return {
    /** 收到进展（响应头到达 / 新 chunk）后重置 30s 计时。 */
    reset(): void {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
    },
    /** 流结束（成功或出错）后停表。 */
    clear(): void {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}

type IdleWatchdog = ReturnType<typeof createIdleWatchdog>

/**
 * 单段流式下载（undici fetch + idle 停滞检测 + 断点续传保存）。
 *
 * 从 downloadAsset 抽出为独立函数（u4）：既服务原单段路径，也作为 D10 第三步
 * 「curl 缺失回退 undici 直连」的执行体（proxyConfig=undefined 即无 dispatcher 直连）。
 *
 *    fetch + 流式传输共用同一个 AbortController，唯一超时形态是 idle 停滞检测
 *    （IDLE_TIMEOUT_MS，30s 无进展即中断），在 fetch 发起之前挂载：
 *    - 等响应头阶段受保护（总墙钟删除后若不前移，header 阶段将失去唯一显式保护）
 *    - 响应头到达即 reset 一次（首个进展），之后每收到 chunk 重置
 *    [NOTE] idle.clear() 必须在流式传输真正完成（writeStream finish/close）
 *    或出错后才执行——提前 clear 会让后续流式字节传输失去停滞保护，
 *    慢速/卡住连接的大文件可能永远挂住。下方用外层 try/finally 保证 stream
 *    结束才 clear。
 *
 * 阶段拆分（结构性重构，行为不变）：
 *   1. fetchSingleStreamResponse —— fetch 执行 + 网络/HTTP/空 body 校验
 *   2. m5 totalBytes 一致性校验（stale 残文件作废递归重下）
 *   3. pipeResponseToTemp —— 流式写盘 + idle 重置 + 断点续传保存
 *   4. finalizeSingleStreamError —— 流错误收尾（temp 保留决策 + 分类抛出）
 *
 * @throws UpdateError 网络/停滞/磁盘分类错误（网络类附 cause=原始 undici 错误，
 *   供编排层 classifyUndiciFailure 按 D4 分类降级——errno 只在 cause 链上可提取）
 */
async function downloadSingleStream(
  asset: ReleaseAsset,
  ctx: ISingleStreamContext,
): Promise<void> {
  const controller = new AbortController()
  // idle 停滞检测前移到 fetch 之前：等响应头阶段即受 30s 无进展保护（D1）。
  const idle = createIdleWatchdog(controller)
  // dispatcher 声明在外层，确保外层 finally 能访问到做 close（连接池清理）。
  let dispatcher: ProxyAgent | undefined
  try {
    // 构建 fetch 选项：User-Agent + 代理 + 断点续传 Range 头。
    const rangeHeaders = ctx.downloadedBytes > 0
      ? { Range: `bytes=${ctx.downloadedBytes}-` }
      : undefined
    const fetchOptions = buildFetchOptions(ctx.proxyConfig, controller.signal, rangeHeaders)
    dispatcher = fetchOptions.dispatcher

    const response = await fetchSingleStreamResponse(asset, ctx, fetchOptions)
    // 响应头到达 = 首个进展：重新计 30s，覆盖「header 之后、首个 body chunk 之前」的间隙。
    idle.reset()

    // 4. 流式写到 .downloading 临时文件，同时累加进度（共用上面的 controller/idle watchdog）
    //
    // [C3] Range 续传响应分类：发了 Range: bytes=N- 后必须区分
    //   - 206 Partial Content：续传成功，content-length 是剩余部分大小，
    //     total = content-length + downloadedBytes，writeStream 用追加模式 'a'。
    //   - 200 OK：服务器/CDN 忽略 Range（整文件回源）。若仍按续传处理，
    //     content-length 是整个文件大小，total 会多算 downloadedBytes；
    //     且 writeStream 追加模式会把完整内容拼到残文件后 → 文件损坏。
    //     因此回退到完整下载：重置 downloadedBytes=0，total 用 content-length，
    //     writeStream 用覆盖模式 'w'。
    const requestedRange = ctx.downloadedBytes > 0
    const resumeAccepted = requestedRange && response.status === HTTP_PARTIAL_CONTENT
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    // 续传成功用追加模式 + 累加 total；否则覆盖写（200 回退或全新下载）
    const writeFlags: 'a' | 'w' = resumeAccepted ? 'a' : 'w'
    const total = resumeAccepted ? contentLength + ctx.downloadedBytes : contentLength

    // [m5] totalBytes 一致性校验：续传成功（206）时，对比新算出的 total 与
    // 上次记录的 totalBytes。差异超容差说明 release 文件已变更（残文件过期），
    // 作废重下，避免把不同版本的内容拼接到一起。注意只在 resumeAccepted
    // 分支校验——200 回退场景 total 计算方式本就不同，不参与此校验。
    if (resumeAccepted && ctx.resumeState && Math.abs(total - ctx.resumeState.totalBytes) > TOTAL_BYTES_TOLERANCE) {
      await restartDownloadForStaleTemp(asset, ctx, response, ctx.resumeState.totalBytes, total)
      return
    }

    await pipeResponseToTemp(ctx, response, {
      writeFlags, total, startBytes: resumeAccepted ? ctx.downloadedBytes : 0,
    }, idle)
  } finally {
    // 外层兜底：fetch 阶段异常也确保 idle watchdog 被清理。
    idle.clear()
    // ProxyAgent 持有连接池，下载结束（成功/失败）后显式关闭避免句柄泄漏。
    if (dispatcher) {
      await dispatcher.close().catch(() => {}) // best-effort 连接池清理，失败不影响下载结果
    }
  }
}

/**
 * 单段下载的 fetch 执行 + 响应前置校验（downloadSingleStream 阶段 1）。
 *
 * @throws 分类后的网络错误（cause=原始 undici 错误）/ HTTP 非 2xx / 空 body 的 UpdateError
 */
async function fetchSingleStreamResponse(
  asset: ReleaseAsset,
  ctx: ISingleStreamContext,
  fetchOptions: RequestInit & { dispatcher?: ProxyAgent },
): Promise<Response> {
  let response: Response
  // 执行 fetch（dispatcher 存在时真正走代理），捕获网络错误并分类
  try {
    response = await fetch(asset.downloadUrl, fetchOptions as RequestInit)
  } catch (fetchErr) {
    // header 等待阶段的 idle 中止（D1 idle 前移后本阶段唯一 abort 来源）按停滞语义抛出
    // （design-code-sync F1）：与 testProxy 探测超时（同经 classifyNetError 产泛化
    // 'timeout (aborted)'）在诊断串上可判别，下游用户文案按成因分流才不误标。cause 链
    // 保留原始错误（编排层 classifyUndiciFailure 判定口径与之前 AbortError 形态一致）。
    if (fetchErr instanceof Error && (fetchErr.name === 'AbortError' || fetchErr.message.includes('aborted'))) {
      const stalled = new UpdateError(
        `download stalled (no data for ${IDLE_TIMEOUT_MS / MS_PER_SECOND}s), aborted; temp kept — retry resumes from break point`,
        'downloading',
        'UPDATE_NETWORK_TIMEOUT',
        extractRawCause(fetchErr),
      )
      stalled.cause = fetchErr
      throw stalled
    }
    // D1: 使用统一的分类函数替代内联字符串匹配（收敛三条 fetch 路径）
    const proxyUrl = ctx.proxyConfig ? resolveProxyUrl(ctx.proxyConfig) : undefined
    const classified = classifyNetError(fetchErr, 'downloading', proxyUrl)
    // 保留原始 undici 错误引用（cause 链）：编排层按 D4 分类降级需要 errno
    // （classifyUndiciFailure 的 extractNetErrorCode 沿 cause 链下钻；分类后的
    // message 不含结构化错误码）
    classified.cause = fetchErr
    throw classified
  }
  if (!response.ok) {
    // [LEAK FIX] 抛错前显式 cancel body，释放底层 socket（无引用后 GC 也会清理，
    // 但显式 cancel 更确定，避免连接挂在 keep-alive 池）。
    await response.body?.cancel().catch(() => {})
    throw new UpdateError(`download failed: HTTP ${response.status}`, 'downloading', 'UPDATE_NETWORK_FAILED')
  }
  if (!response.body) {
    throw new UpdateError('download failed: empty response body', 'downloading', 'UPDATE_NETWORK_FAILED')
  }
  return response
}

/**
 * [m5] 残文件过期作废重下（downloadSingleStream 阶段 2）：cancel 响应体、清理
 * 过期 temp 与 resume-state 后，递归 downloadAsset 从头开始（沿用编排层原参数）。
 */
async function restartDownloadForStaleTemp(
  asset: ReleaseAsset,
  ctx: ISingleStreamContext,
  response: Response,
  recordedTotalBytes: number,
  total: number,
): Promise<void> {
  console.log(`[download] total bytes changed (expected ${recordedTotalBytes}, got ${total}), restarting`)
  await response.body?.cancel().catch(() => {})
  try { unlinkSync(ctx.tempPath) } catch (e) { console.warn('[download] stale temp cleanup failed:', e) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
  clearResumeState()
  await downloadAsset(asset, ctx.onProgress, ctx.proxyConfig)
}

/** 单段流式写盘计划（Range 分类后的落盘参数）。 */
interface ISingleStreamPipePlan {
  /** temp 文件打开模式：206 续传 'a' 追加；200 回退/全新 'w' 覆盖 */
  writeFlags: 'a' | 'w'
  /** 总字节数（206 = content-length + 续传起点；否则 content-length） */
  total: number
  /** 续传起点（206 = downloadedBytes；200 回退/全新 = 0） */
  startBytes: number
}

/**
 * 流式写盘阶段（downloadSingleStream 阶段 3）：pipe response.body 到 temp 文件，
 * 期间每收到 chunk 重置 idle watchdog、节流进度与断点续传状态保存；失败走
 * finalizeSingleStreamError。idle watchdog 由调用方在 fetch 前创建（停滞检测
 * 覆盖 header 等待 + 流传输全程），本函数只负责进展重置与收尾清理。
 */
async function pipeResponseToTemp(
  ctx: ISingleStreamContext,
  response: Response,
  plan: ISingleStreamPipePlan,
  idle: IdleWatchdog,
): Promise<void> {
  const { total } = plan
  // 续传起点（206 = downloadedBytes；200 回退/全新 = 0）
  let downloaded = plan.startBytes
  // 如果是断点续传（206），使用追加模式打开文件；否则覆盖写
  const writeStream = createWriteStream(ctx.tempPath, { flags: plan.writeFlags })
  // response.body 是 web ReadableStream；转 node Readable 以 pipe。
  const nodeStream = Readable.fromWeb(toNodeReadableWebStream(response.body))
  // [M3] 记录上次保存进度（续传起点），超过 SAVE_INTERVAL_BYTES 才落盘（替代整除判断）
  let lastSavedBytes = downloaded
  // 进度回调节流：每段下载内按百分比变化 + 时间间隔推，降低 IPC 压力。
  const reportProgress = createThrottledProgress(ctx.onProgress, total)
  try {
    await new Promise<void>((resolve, reject) => {
      nodeStream.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        // [M1] 收到新数据重置 idle timer（只要有字节流动就不算挂死）
        idle.reset()
        // [NOTE] total=0（chunked 传输无 content-length）时不报进度：
        // onProgress 签名是 0-100 百分比，无总量时无法计算百分比；
        // 前端 useAppUpdate 的 state.percent 期望 0-100，传负值会 UI 异常。
        // 设计权衡：chunked 时进度条不动（但下载会完成），优于 UI 异常。
        if (total > 0) {
          reportProgress(downloaded)
        }
        // [M3] 保存断点续传状态：每超过上次保存点 SAVE_INTERVAL_BYTES 字节才落盘。
        // 旧实现 `downloaded % 1MB === 0` 在续传场景（起点非 1MB 整数倍）几乎
        // 永不命中，中途崩溃 state 仍是旧值。
        // [B-4] 统一保存口径：这里也用真实落盘字节（statSync）而非内存 downloaded 计数器。
        // 原先进度保存用 downloaded（偏大，pipe 未完全 flush）、可恢复错误保存用
        // statSync（偏小）→ 两口径不一致 → 续传判定 mismatch 重下。现在两处统一，
        // 配合放宽的续传判定（stat.size <= state）形成正确续传闭环。
        if (downloaded - lastSavedBytes >= SAVE_INTERVAL_BYTES) {
          const persisted = getPersistedBytes(ctx.tempPath, downloaded)
          saveResumeState({
            downloadedBytes: persisted,
            totalBytes: total,
            tempPath: ctx.tempPath,
            finalPath: ctx.finalPath,
          })
          lastSavedBytes = persisted
        }
      })
      nodeStream.pipe(writeStream)
      writeStream.on('finish', () => resolve())
      writeStream.on('error', reject)
      nodeStream.on('error', reject)
    })
  } catch (err) {
    // [LEAK FIX] destroy writeStream 释放底层 fd，避免错误路径泄漏文件描述符。
    writeStream.destroy()
    finalizeSingleStreamError(ctx, err, downloaded, total)
  } finally {
    // [M1] 流式传输已结束（成功 finish 或抛错）才停 idle watchdog。
    idle.clear()
  }
}

/**
 * 流式传输失败的收尾（downloadSingleStream 阶段 4）：先做 temp 保留决策
 * （[B-2] 默认可恢复保留 temp + state；磁盘错误删 temp 清 state），再按
 * 磁盘/超时/UpdateError 直通/通用网络错误分类抛出。恒 throw。
 */
function finalizeSingleStreamError(
  ctx: ISingleStreamContext,
  err: unknown,
  downloaded: number,
  total: number,
): never {
  // 超时判定（用于错误分类：UPDATE_NETWORK_TIMEOUT vs 其他），不影响是否保留 temp。
  const isTimeout = err instanceof Error && (
    err.name === 'AbortError' ||
    err.message.includes('aborted') ||
    err.message.includes('timeout')
  )
  // [W-6] 磁盘错误判定：优先用 Node errno code（ENOSPC）精确匹配，
  // 子串 'disk space' 仅作非英文 OS message 的 fallback。
  const errno = getNodeErrnoCode(err)
  const isDiskError = errno === 'ENOSPC' ||
    (err instanceof Error && err.message.toLowerCase().includes('disk space'))

  // [B-2] 默认 Error 视为可恢复——保留 temp + state 让下次续传。
  // 旧实现用白名单子串匹配（ECONNRESET/ETIMEDOUT + NETWORK_* code）判 isRecoverable，
  // 但国内网络常见错误不命中：undici 流中断 UND_ERR_SOCKET/UND_ERR_BODY_TIMEOUT
  // （message 形如 'other side closed'）、代理中途 407/TLS 错误经流 reject，
  // message 都不含上述子串 → 走 else 删 temp。这恰恰在最需要续传的「流中途断开」
  // 场景丢数据，违背 PR 核心目标。
  // 现在反转默认值：只有明确命中 isDiskError 才删 temp；其余一律保留。
  // sha256 mismatch 不受影响（它在校验段单独删 temp，不进 stream catch）。
  if (!isDiskError) {
    // 保留 temp + 用真实落盘字节存 state，下次可续传（curl 降级路径以 -C -
    // 从同一 temp 续传，两引擎共用该残文件）。
    const persistedBytes = getPersistedBytes(ctx.tempPath, downloaded)
    saveResumeState({
      downloadedBytes: persistedBytes,
      totalBytes: total,
      tempPath: ctx.tempPath,
      finalPath: ctx.finalPath,
    })
    console.log(`[download] recoverable error, kept temp file for resume (${persistedBytes} bytes)`)
  } else {
    // 磁盘空间不足：删 temp + 清 state（无法续传）。
    // [W-5] 此路径不再 saveResumeState——马上就 clear 了，save 纯属浪费。
    try { unlinkSync(ctx.tempPath) } catch (unlinkErr) { console.warn('[download] stream cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
    clearResumeState()
  }
  // 流式传输错误分类（throw 什么 errorCode）；与是否保留 temp 无关。
  if (isDiskError) {
    throw new UpdateError(
      'insufficient disk space',
      'downloading',
      'UPDATE_DISK_SPACE',
      extractRawCause(err),
    )
  }
  // 停滞中断（idle 30s 无进展 abort；总墙钟删除后单段流阶段 AbortError 唯一来源即此，
  // 见 timeout-slow-flow-wallclock D1）：映射为 UPDATE_NETWORK_TIMEOUT + 断点续传指引。
  if (isTimeout) {
    throw new UpdateError(
      `download stalled (no data for ${IDLE_TIMEOUT_MS / MS_PER_SECOND}s), aborted; temp kept — retry resumes from break point`,
      'downloading',
      'UPDATE_NETWORK_TIMEOUT',
      extractRawCause(err),
    )
  }
  // 如果已经是 UpdateError（来自上面的网络错误分类），直接抛出
  if (err instanceof UpdateError) {
    throw err
  }
  const streamError = new UpdateError(
    `download stream error: ${toErrorMessage(err)}`,
    'downloading',
    'UPDATE_NETWORK_FAILED',
    extractRawCause(err),
  )
  // 保留原始错误引用（cause 链）：编排层按 D4 分类降级需要错误码
  // （UND_ERR_SOCKET 等流中断形态只在原始错误上可提取）
  streamError.cause = err
  throw streamError
}

/** curl 引擎下载编排上下文（D10 三步链参数）。 */
interface ICurlDownloadContext {
  /** `.downloading` temp 路径（downloadViaCurl 产物原地写于此） */
  tempPath: string
  /** 最终文件路径（undici 直连回退时下载单段上下文需要） */
  finalPath: string
  /** 编排方已知续传字节（仅意图记录：curl `-C -` 以 temp 实际落盘字节数为准） */
  downloadedBytes: number
  /** 进度回调（0-100 百分比） */
  onProgress?: (percent: number) => void
  /** 完整代理 URL；undefined = 无代理配置（直连） */
  proxyUrl?: string
  /** 触发降级的 undici 错误（D8：双引擎均失败时对外报 undici 分类）；
   *  入口 flag / probe 引擎为 curl 的路径无此上下文（curl 映射错误原样对外） */
  undiciError?: unknown
}

/**
 * curl 整文件下载 + D10 三步链后半段（产物写 temp，sha256 校验/rename 归 downloadAsset）。
 *
 * 三步链（D10）：
 *   ① curl + 代理（无代理配置时本就是 curl 直连）
 *   ② CurlConnectionError（curl 也连不上代理，exit 7）→ 判定代理整体不可用 →
 *      直连兜底：curl 可用 → curl 直连（无代理重试）
 *   ③ curl 缺失（spawn ENOENT 等进程级失败，可用性判定对整条链生效）→ 跳过全部
 *      curl 形态，直连兜底走 undici（无 dispatcher 单段；flag 仅因私网代理连接失败
 *      置位时 undici 对公网直连仍可达，回退无矛盾——保证无 curl 环境矩阵第 2 行覆盖）
 *
 * 仍失败 → 对外报 undici 错误分类（有降级上下文时）；curl 侧形态仅作 engine:'curl'
 * 落盘（D8：curl exit 7 覆盖全部连接失败无 errno 区分度，不能当对外分类依据）。
 */
async function runCurlDownloadChain(asset: ReleaseAsset, ctx: ICurlDownloadContext): Promise<void> {
  // curl-download 推原始字节数（statSync 轮询），节流与百分比折算在本层复用现有
  // 回调（D6：总量 = asset.size；降级重下进度归零属预期，设计 D7 已声明）
  const progress = createThrottledProgress(ctx.onProgress, asset.size ?? 0)
  const runOnce = async (proxyUrl: string | undefined) =>
    downloadViaCurl(asset, {
      tempPath: ctx.tempPath,
      proxyUrl,
      resumeBytes: ctx.downloadedBytes,
      onProgress: progress,
    })

  let curlError: unknown
  try {
    await runOnce(ctx.proxyUrl)
    return // ① 成功
  } catch (err) {
    curlError = err
  }

  if (isCurlProcessFailure(curlError)) {
    // ③ curl 可执行不可用（spawn ENOENT 等）→ 直连兜底改走 undici（见函数尾）
    logCurlEngineUnavailable(curlError)
  } else if (curlError instanceof CurlConnectionError && ctx.proxyUrl) {
    // ② curl 亦连接失败 → 代理整体不可用 → 直连兜底（curl 可用 → curl 直连）
    logCurlSideFailure(curlError, ctx.proxyUrl)
    try {
      await runOnce(undefined)
      return
    } catch (directErr) {
      if (!isCurlProcessFailure(directErr)) {
        throw finalizeCurlSideFailure(directErr, ctx, undefined)
      }
      // 直连 curl 也进程级失败（罕见）：同样跳过 curl 形态走 undici 直连
      logCurlEngineUnavailable(directErr)
    }
  } else {
    // curl 已运行但失败（超时/HTTP/SSL 等，或本就直连无代理可降）→ 最终失败
    throw finalizeCurlSideFailure(curlError, ctx, ctx.proxyUrl)
  }

  // ③ undici 直连兜底：无 dispatcher 单段下载。续传起点对齐 curl `-C -` 口径
  //（temp 实际落盘字节；无 temp 即完整下载）。resumeState 传 null——直连重连场景
  // 残 state 的 totalBytes 基准无意义，206/200 分类 + sha256 终校验兜底正确性。
  let directResumeBytes = 0
  try {
    directResumeBytes = statSync(ctx.tempPath).size
  } catch {
    // temp 不存在（无残留）即从 0 完整下载
    directResumeBytes = 0
  }
  await downloadSingleStream(asset, {
    tempPath: ctx.tempPath,
    finalPath: ctx.finalPath,
    downloadedBytes: directResumeBytes,
    resumeState: null,
    onProgress: ctx.onProgress,
    proxyConfig: undefined,
  })
}

/**
 * curl 子进程级失败（spawn ENOENT 等）判定。
 *
 * downloadViaCurl 的失败形态二分：UpdateError 族（curl 已运行、按 exit code 映射）
 * vs 原生 Error（spawn 'error' 事件原样上抛——curl-download 刻意不包装以保留 D10
 * 第三步引擎回退判定依据）。非 UpdateError 的 Error 即进程级失败 → curl 形态整体
 * 不可用（D10：可用性判定对整条链生效）。
 */
function isCurlProcessFailure(err: unknown): boolean {
  return err instanceof Error && !(err instanceof UpdateError)
}

/** curl 引擎不可用落盘（engine-fallback：被 undici 直连兜住，A7③ 可观测依据）。 */
function logCurlEngineUnavailable(err: unknown): void {
  try {
    appendUpdateError({
      at: new Date().toISOString(),
      source: 'engine-fallback',
      stage: 'downloading',
      errorCode: 'UPDATE_NETWORK_FAILED',
      rawCause: toErrorMessage(err),
      engine: 'curl',
    })
  } catch (logErr) {
    // best-effort：落盘失败不阻断降级主流程（对齐 error-log 容错语义），仅 console 兜底
    console.error('[download] curl-unavailable log write failed:', logErr)
  }
}

/** curl 侧失败落盘（D8：curl 结果只作 engine 诊断字段，不参与对外分类）。 */
function logCurlSideFailure(err: unknown, proxyUrl: string | undefined): void {
  try {
    appendUpdateError({
      at: new Date().toISOString(),
      source: 'download',
      stage: 'downloading',
      errorCode: err instanceof UpdateError ? err.errorCode : 'UPDATE_NETWORK_FAILED',
      rawCause: toErrorMessage(err),
      proxyUrl: proxyUrl ? stripCredential(proxyUrl).safeUrl : undefined,
      engine: 'curl',
    })
  } catch (logErr) {
    // best-effort：落盘失败不阻断下载主流程（对齐 error-log 容错语义），仅 console 兜底
    console.error('[download] curl-side failure log write failed:', logErr)
  }
}

/**
 * curl 侧最终失败 → 对外错误（D8：双引擎均失败报 undici 错误分类）。
 *
 * 有 undici 上下文（降级路径）→ classifyNetError(undiciError)（errno 级精准分类
 * 只在 undici 侧成立）；无上下文（入口 flag / probe 引擎为 curl）→ curl 映射的
 * UpdateError 原样对外。curl 侧形态始终附 engine:'curl' 落盘。
 */
function finalizeCurlSideFailure(
  curlErr: unknown,
  ctx: ICurlDownloadContext,
  failedProxyUrl: string | undefined,
): UpdateError {
  logCurlSideFailure(curlErr, failedProxyUrl)
  if (ctx.undiciError !== undefined) {
    return classifyNetError(ctx.undiciError, 'downloading', ctx.proxyUrl)
  }
  if (curlErr instanceof UpdateError) {
    return curlErr
  }
  return new UpdateError(
    `curl download failed: ${toErrorMessage(curlErr)}`,
    'downloading',
    'UPDATE_NETWORK_FAILED',
  )
}

/**
 * undici 失败被 curl 兜住时的降级点落盘（D8，对齐 upgrade-fetch 的 logEngineFallback）。
 *
 * 单段/多段下载路径的 undici 失败不经 upgradeFetch（直用全局 fetch），其降级
 * 可观测性由本编排层补齐——降级成功时调用方 handler 不进 catch，只能在降级
 * 发生点落盘（A1 验收依据）。
 */
function logUndiciEngineFallback(err: unknown, proxyUrl: string | undefined): void {
  try {
    appendUpdateError({
      at: new Date().toISOString(),
      source: 'engine-fallback',
      stage: 'downloading',
      errorCode: classifyNetError(err, 'downloading', proxyUrl).errorCode,
      rawCause: extractRawCause(err),
      proxyUrl: proxyUrl ? stripCredential(proxyUrl).safeUrl : undefined,
      engine: 'undici',
    })
  } catch (logErr) {
    // best-effort：落盘失败不阻断降级主流程（对齐 error-log 容错语义），仅 console 兜底
    console.error('[download] engine-fallback log write failed:', logErr)
  }
}

/**
 * 构造 fetch 选项（User-Agent + 代理 + signal + 可选 Range 头）。
 * 与 release-checker 保持一致的 User-Agent，避免部分 CDN 因空 UA 拒绝/限速。
 */
function buildFetchOptions(
  proxyConfig: IProxyConfig | undefined,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
): RequestInit & { dispatcher?: ProxyAgent } {
  const headers: Record<string, string> = {
    'User-Agent': DOWNLOAD_USER_AGENT,
    ...extraHeaders,
  }
  const options: RequestInit & { dispatcher?: ProxyAgent } = { signal, headers }
  const proxyUrl = proxyConfig ? resolveProxyUrl(proxyConfig) : undefined
  if (proxyUrl) {
    try {
      options.dispatcher = new ProxyAgent(proxyUrl)
    } catch (err) {
      // best-effort 降级：ProxyAgent 构造失败（如非法代理 URL）回退直连继续下载，
      // 不把代理配置问题升级为下载失败——直连可用性优于直接失败
      console.warn('[download] proxy agent init failed, fallback to direct:', err)
    }
  }
  return options
}

/**
 * 探测目标是否支持多段并行下载（GET `Range: bytes=0-0` 检查 206 + Content-Range total）。
 *
 * [多源改造] 原 HEAD + accept-ranges 判定废弃：GitCode（下载域）实测禁 HEAD，
 * HEAD 探测会让 GitCode 源多段静默退化为单段；且 RFC 7233 对 206 仅强制 Content-Range，
 * accept-ranges 在该形态不可依赖。改为 GET `Range: bytes=0-0`（走 upgradeFetch 双引擎
 * 与超时语义不变），四出口归类（全形态显式，判定解析失败不抛错只落 not supported）：
 *   ① 206 + `Content-Range: bytes 0-0/{total}` 且 total ≥ MIN_MULTI_PART_SIZE → supported；
 *     totalBytes 取自 Content-Range——206 响应体仅 1 字节（content-length 恒 1），
 *     照搬 content-length 会连 GitHub 在内两源多段一起静默全灭。
 *   ② 206 但 total 数字低于阈值 → 不支持（文件不够大，拆分无收益）。
 *   ③ 206 但 Content-Range 缺失 / total 为 `*` / 单位非 bytes / 形态不可解析 → 一律
 *     不支持（无 total 即无法切分多段）。
 *   ④ 非 206（200/405 等，含服务器/代理剥 Range 的全量退化）→ 不支持，单段下载
 *     （合法出口，正确性无风险）。
 *
 * u4：probe 经 upgradeFetch（双引擎，D7）——undici 连接类失败时封装内部按 D4
 * 判定降级 curl（连接建立失败同时置 flag）并在降级点落盘 engine-fallback；
 * usedEngine 供编排层分流（curl → 本次放弃多段直接整文件 curl 下载）。
 *
 * @returns supported=true 表示支持 Range 且 totalBytes 已知（来自 Content-Range）；
 *   usedEngine 为 probe 实际引擎。probe 失败（双引擎均失败 / undici 不可降级错误）
 *   非致命：返回 supported=false 落单段路径（现有语义），引擎编排由单段失败分类接管。
 */
async function probeMultiPartSupport(
  asset: ReleaseAsset,
  proxyUrl: string | undefined,
): Promise<{ supported: boolean; totalBytes: number; usedEngine: FetchEngine }> {
  try {
    const result = await upgradeFetch(asset.downloadUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      proxyUrl,
      stage: 'downloading',
    })
    // 出口④：非 206（200 全量退化 / 405 等）→ 单段，合法出口。
    if (result.status !== HTTP_PARTIAL_CONTENT) {
      return { supported: false, totalBytes: 0, usedEngine: result.usedEngine }
    }
    // 出口①②③：206 形态必须解析出 `bytes 0-0/{total}`。正则不匹配即覆盖缺失 /
    // total `*` / 单位非 bytes 等全部不可解析形态，统一落 not supported，不抛错。
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.headers['content-range'] ?? '')
    const total = match ? Number(match[3]) : Number.NaN
    const supported =
      match !== null && Number(match[1]) === 0 && Number(match[2]) === 0 && total >= MIN_MULTI_PART_SIZE
    return { supported, totalBytes: supported ? total : 0, usedEngine: result.usedEngine }
  } catch (err) {
    console.warn('[download] multipart probe failed:', err)
    return { supported: false, totalBytes: 0, usedEngine: 'undici' }
  }
}

/** 多段下载的单个段描述。 */
interface IPartSpec {
  index: number
  start: number
  end: number
  tempPath: string
}

/**
 * [RM3] 服务器未遵守 Range 协议的内部信号：多段请求收到非 206 响应（典型：
 * 服务器/代理忽略 Range 回 200 全量），或响应内容长度与请求段不符。
 *
 * 定位是内部控制流信号而非用户可见错误——捕获方 downloadMultiPart 据此整批
 * 放弃多段、降级单段完整下载（单段路径已有正确的 206/200 分类），绝不把错位
 * 的段内容合并成损坏文件。刻意不继承 UpdateError：面向用户的网络错误分类
 * （classifyNetError）不应对降级信号生效。
 */
class RangeNotRespectedError extends Error {
  constructor(partIndex: number, reason: string) {
    super(`part ${partIndex}: server did not honor Range request (${reason})`)
    this.name = 'RangeNotRespectedError'
  }
}

/** 创建带节流的进度回调（降低 IPC/渲染进程压力）。 */
function createThrottledProgress(
  onProgress: ((percent: number) => void) | undefined,
  totalBytes: number,
): (downloadedBytes: number) => void {
  if (!onProgress || totalBytes <= 0) return () => {}
  let lastPercent = -1
  let lastTime = 0
  return (downloadedBytes: number) => {
    const percent = Math.min(PROGRESS_MAX, Math.round((downloadedBytes / totalBytes) * PROGRESS_MAX))
    const now = Date.now()
    if (percent !== lastPercent && (now - lastTime >= PROGRESS_THROTTLE_MS || percent === PROGRESS_MAX)) {
      lastPercent = percent
      lastTime = now
      onProgress(percent)
    }
  }
}

/**
 * 下载一个段（Range: bytes=start-end）到临时文件。
 *
 * @param asset 下载目标
 * @param part 段描述
 * @param proxyConfig 代理配置
 * @param onProgress 段内进度（实际只更新总进度，这里传 no-op 或段内计数）
 * @param sharedSignal downloadMultiPart 的共享 abort signal（[RM3] 段失败整批中断）：
 *   与下方 per-part watchdog controller 组合——共享 abort 触发本段 controller abort，
 *   idle 停滞检测语义保留在 per-part controller 上不变。缺省（单段调用方）无共享中断。
 * @returns 下载字节数
 */
async function downloadPart(
  asset: ReleaseAsset,
  part: IPartSpec,
  proxyConfig: IProxyConfig | undefined,
  onProgress: (bytes: number) => void,
  sharedSignal?: AbortSignal,
): Promise<number> {
  const controller = new AbortController()
  const onSharedAbort = () => controller.abort()
  if (sharedSignal) {
    if (sharedSignal.aborted) controller.abort()
    else sharedSignal.addEventListener('abort', onSharedAbort)
  }
  // per-part 只受 idle 停滞检测保护（总墙钟已删，D1）：idleTimer 本就挂在 fetch 之前，
  // 等响应头阶段已被覆盖，无需前移（timeout-slow-flow-wallclock v1.1 口径）。
  let idleTimer: NodeJS.Timeout | undefined = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
  let dispatcher: ProxyAgent | undefined
  let writeStream: ReturnType<typeof createWriteStream> | undefined
  try {
    const options = buildFetchOptions(proxyConfig, controller.signal, {
      Range: `bytes=${part.start}-${part.end}`,
    })
    dispatcher = options.dispatcher
    const response = await fetch(asset.downloadUrl, options)
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new UpdateError(`part ${part.index} download failed: HTTP ${response.status}`, 'downloading', 'UPDATE_NETWORK_FAILED')
    }
    // [RM3] 旧实现只查 response.ok，200 全量也算 ok——服务器忽略 Range 时四段各下
    // 全量，合并出 4 倍损坏文件后卡 sha 失败重试死循环。必须是 206，status 检查放
    // 最前：200 场景 body 是整文件，立即 cancel 切断，避免 4 段并发白耗整文件流量。
    // 段长校验由流结束后的实下字节数兜底（见下方 finish 回调），覆盖 chunked 等
    // 无 content-length 场景。任一失守抛 RangeNotRespectedError，downloadMultiPart
    // 据此整批放弃降级单段。
    if (response.status !== HTTP_PARTIAL_CONTENT) {
      await response.body?.cancel().catch(() => {})
      throw new RangeNotRespectedError(part.index, `HTTP ${response.status}, expected 206 Partial Content`)
    }
    const expectedPartLength = part.end - part.start + 1
    const nodeStream = Readable.fromWeb(toNodeReadableWebStream(response.body))
    writeStream = createWriteStream(part.tempPath, { flags: 'w' })
    let downloaded = 0
    return await new Promise<number>((resolve, reject) => {
      nodeStream.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        if (idleTimer) {
          clearTimeout(idleTimer)
        }
        idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
        onProgress(downloaded)
      })
      nodeStream.pipe(writeStream!)
      writeStream!.on('finish', () => {
        // [RM3] 段长兜底校验：206 但 body 被中途截短/错位（代理返回错误区间等）
        // 同样视为未遵守 Range，拒绝进入合并。
        if (downloaded !== expectedPartLength) {
          reject(new RangeNotRespectedError(part.index, `downloaded ${downloaded} bytes != part length ${expectedPartLength}`))
          return
        }
        resolve(downloaded)
      })
      writeStream!.on('error', reject)
      nodeStream.on('error', reject)
    })
  } catch (err) {
    writeStream?.destroy()
    // [RM3-CI] 失败清理必须先等 fd 生命周期落定：createWriteStream 的 open 是异步
    //（threadpool）操作，段失败链路（共享 abort → 流 error → reject）可能跑在 open
    // 完成之前——下方 unlinkSync 会 ENOENT 扑空，随后 open 完成把 .part 文件「复活」
    // 成永久残留（CI mac 高负载 threadpool 拥塞下必现；本地快路径 open 先完成，
    // 从不暴露）。'close' 事件保证在 open 完成（拿到 fd 或失败关闭）之后发出，
    // await 它使清理确定作用于终态文件；close 已发出（罕见）则直接跳过。
    if (writeStream && !writeStream.closed) {
      await new Promise<void>((resolve) => { writeStream!.once('close', resolve) })
    }
    // [MUST-FIX #4] 失败时 best-effort 删除本段已写的 part 临时文件，保证单段失败自清理。
    // 旧实现只 destroy writeStream，清理完全依赖 downloadMultiPart 的 catch（Promise.all 层），
    // 但若本段 reject 先于其他段完成，其他段的 .part-i 可能正被并发写，downloadMultiPart
    // 的 unlinkSync 与并发 write 竞争会抛 EBUSY/EPERM 吞掉原始错误。这里每段清理自己的
    // part 文件（try/catch 容错，文件不存在或被占用都不影响抛出原始 err）。
    try { unlinkSync(part.tempPath) } catch (unlinkErr) { console.warn(`[download] part ${part.index} temp cleanup failed:`, unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
    // [B4] 已构造的 UpdateError 原样直通，不再进 classifyNetError 兜底分支：
    // 上面 HTTP 非 200 抛的 `part N download failed: HTTP xxx` 若被重新分类，
    // 会二次包装成「download failed: part N ...」双重前缀（探针已实证）。
    // 已构造错误原样直通，不再进 classifyNetError 兜底分支：
    //   - [RM3] RangeNotRespectedError 是内部降级信号而非网络故障，被二次包装后
    //     downloadMultiPart 将无法识别降级条件（误报成网络错误而非降级）。
    //   - [B4] UpdateError 直通：`part N download failed: HTTP xxx` 被重新分类会
    //     产生「download failed: part N ...」双重前缀（探针已实证）。
    // 放在清理之后是刻意的——destroy/unlink 对所有错误类型都必须执行，
    // 不能提前 return 跳过。
    if (err instanceof RangeNotRespectedError || err instanceof UpdateError) {
      throw err
    }
    // D1: 对 downloadPart 的网络错误做统一分类（覆盖断点 1b：多段路径原无分类）
    const proxyUrl = proxyConfig ? resolveProxyUrl(proxyConfig) : undefined
    const classified = classifyNetError(err, 'downloading', proxyUrl)
    // 保留原始 undici 错误引用（cause 链）：编排层（downloadAsset）按 D4 分类降级
    // 需要 errno（classifyUndiciFailure 的 extractNetErrorCode 沿 cause 链下钻）。
    classified.cause = err
    throw classified
  } finally {
    if (sharedSignal) sharedSignal.removeEventListener('abort', onSharedAbort)
    if (idleTimer) clearTimeout(idleTimer)
    if (dispatcher) await dispatcher.close().catch(() => {})
  }
}

/**
 * 多段并行下载完整 asset。
 *
 * 1. 把 totalBytes 拆成 N 段（每段至少 MIN_BYTES_PER_PART）
 * 2. 每段独立 Range 请求 + 独立 ProxyAgent 连接，并发下载到各自 temp 文件
 * 3. 全部完成后按顺序合并到 .downloading 文件
 * 4. 删除段临时文件
 * 5. [RM3] 任一段检测到服务器未遵守 Range（非 206 / 段长不符）→ 清理全部段文件，
 *    返回 degradedToSingle=true，由调用方降级单段完整下载，绝不合并错位内容。
 *
 * [MUST-FIX #4 / timeout 语义说明] downloadPart 每段独立受 IDLE_TIMEOUT_MS（30s 空闲）
 * 停滞检测保护（timeout-slow-flow-wallclock D1：总墙钟已删，活跃慢速段不再被时间上限杀）。
 * 这是多段下载的固有特性：某段 Range 落到 CDN 缓存未命中的字节区，单段 30s idle 中断即经
 * 共享 abortController 中断整批。这与单段下载「同一区域只中断一次可续传」语义不同。
 * 不放宽 timeout（30s idle 是国内网络挂死检测的合理阈值，放宽会退化为挂死），
 * 阈值调整（10MB→更大）超出 must-fix 范围。确定性风险已通过 downloadPart 失败自清 part 文件
 * （见 downloadPart catch）收敛。
 */
async function downloadMultiPart(
  asset: ReleaseAsset,
  totalBytes: number,
  onProgress?: (percent: number) => void,
  proxyConfig?: IProxyConfig,
): Promise<{ tempPath: string; degradedToSingle?: boolean }> {
  const maxParts = Math.max(1, Math.min(MULTI_PART_COUNT, Math.floor(totalBytes / MIN_BYTES_PER_PART)))
  const partSize = Math.floor(totalBytes / maxParts)
  const parts: IPartSpec[] = []
  const tempPath = path.join(getUpdateDir(), `${asset.name}.downloading`)
  mkdirSync(getUpdateDir(), { recursive: true })
  // [MUST-FIX #2] multipart 路径全程不写 resume-state（各段独立写 .part-N，无单一进度可记）。
  // 若上次单段下载残留了 resume-state（state.downloadedBytes 可能远大于本次合并进度），
  // 本次 multipart 失败后下次启动会被误判为「单段续传起点」拼接到损坏的合并片段上。
  // 因此进入 multipart 前先清旧 state，保证此路径不被跨次残留干扰。
  clearResumeState()
  for (let i = 0; i < maxParts; i++) {
    const start = i * partSize
    const end = (i === maxParts - 1) ? totalBytes - 1 : (i + 1) * partSize - 1
    parts.push({
      index: i,
      start,
      end,
      tempPath: `${tempPath}.part-${i}`,
    })
  }
  const progress = createThrottledProgress(onProgress, totalBytes)
  const downloadedPerPart = new Array(maxParts).fill(0)
  const updateProgress = () => {
    const total = downloadedPerPart.reduce((a, b) => a + b, 0)
    progress(total)
  }
  const abortController = new AbortController()
  const partPromises = parts.map(async (part) => {
    try {
      const bytes = await downloadPart(asset, part, proxyConfig, (bytes) => {
        downloadedPerPart[part.index] = bytes
        updateProgress()
      }, abortController.signal)
      downloadedPerPart[part.index] = bytes
      updateProgress()
      return part
    } catch (err) {
      abortController.abort()
      throw err
    }
  })
  // [RM3] 用 allSettled 收集全部段结果而非 Promise.all：段失败经共享 abortController
  // 中断其他段（signal 已传入 downloadPart，与其 per-part watchdog controller 组合，
  // abort 真实生效——失败浮出不再等待健康段传完），其他段的 AbortError 与 Range 违约
  // 信号谁先入队是竞态——Promise.all 只暴露第一个 rejection，可能把「应降级」误判为
  // 网络失败。全部收集后统一判定才符合「任一段违约 → 整批放弃多段」的语义。
  const rejected = (await Promise.allSettled(partPromises)).filter(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  )
  if (rejected.length > 0) {
    // 清理段临时文件
    for (const part of parts) {
      try { unlinkSync(part.tempPath) } catch (unlinkErr) { console.warn('[download] part cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
    }
    // 任一段 Range 违约 → 整批放弃多段，降级单段完整下载；否则抛第一个真实错误
    if (rejected.some((r) => r.reason instanceof RangeNotRespectedError)) {
      console.log('[download] server did not honor Range requests, abandon multipart and fall back to single-stream download')
      return { tempPath, degradedToSingle: true }
    }
    throw rejected[0]?.reason
  }
  // 合并段文件到 .downloading
  const writeStream = createWriteStream(tempPath, { flags: 'w' })
  try {
    for (const part of parts) {
      await pipeline(createReadStream(part.tempPath), writeStream, { end: false })
    }
    writeStream.end()
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve)
      writeStream.on('error', reject)
    })
  } catch (err) {
    writeStream.destroy()
    // [MUST-FIX #2] 合并失败：除段临时文件外，半写入的合并产物 .downloading 也必须清理。
    // 旧的 finally 只清 .part-N，留下损坏的 .downloading；若此时 resume-state 又被
    // 上一次单段下载残留填充，下次启动会误把它当续传起点拼接，造成不可恢复的损坏。
    try { unlinkSync(tempPath) } catch (unlinkErr) { console.warn('[download] merged file cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
    throw err
  } finally {
    // 清理段临时文件（合并后无用）
    for (const part of parts) {
      try { unlinkSync(part.tempPath) } catch (unlinkErr) { console.warn('[download] part cleanup failed:', unlinkErr) } // eslint-disable-line taste/no-silent-catch -- best-effort 清理
    }
  }
  // [MUST-FIX #2] multipart 成功后的 resume-state 清理统一由 downloadAsset 在校验链前
  // 执行（D6：两引擎同点清理不散落；本路径开头已 clear 过，此处无需重复）。
  return { tempPath }
}

/**
 * 保存断点续传状态到文件。
 *
 * @param state 断点续传状态
 */
function saveResumeState(state: IResumeState): void {
  try {
    // 原子写（批次 5 m12 / §3.7.2）：先写 .tmp 再 rename，避免读到半截 JSON
    // （半截 state 会被 loadResumeState 的 parse 失败分支吞掉，丢掉续传进度）
    const resumeStateFile = getResumeStateFile()
    const tmpPath = `${resumeStateFile}.tmp`
    writeFileSync(tmpPath, JSON.stringify(state, null, 2)) // eslint-disable-line no-magic-numbers -- JSON 缩进 2 空格
    renameSync(tmpPath, resumeStateFile)
  } catch (err) {
    // best-effort：resume state 只是续传优化，写入失败不应中断下载，下次重头下即可
    console.warn('[download] save resume state failed:', err)
  }
}

/**
 * 从文件加载断点续传状态。
 *
 * @returns 断点续传状态，如果文件不存在或解析失败则返回 null
 */
function loadResumeState(): IResumeState | null {
  try {
    if (!existsSync(getResumeStateFile())) {
      return null
    }
    const data = readFileSync(getResumeStateFile(), 'utf-8')
    return JSON.parse(data) as IResumeState
  } catch (err) {
    console.warn('[download] load resume state failed:', err)
    return null
  }
}

/**
 * 清除断点续传状态文件。
 */
function clearResumeState(): void {
  try {
    if (existsSync(getResumeStateFile())) {
      unlinkSync(getResumeStateFile())
    }
  } catch (err) {
    // best-effort：清理失败只留下残留 state 文件，下次下载会因 mismatch 自动重下，无副作用
    console.warn('[download] clear resume state failed:', err)
  }
}
