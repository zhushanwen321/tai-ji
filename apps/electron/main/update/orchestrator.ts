/**
 * 升级流程编排器（纯逻辑，不调 app.quit）。
 *
 * 对应 slice auto-update-and-install w3：串联下载 → 校验 → 平台分发 → 触发替换。
 * orchestrator 是纯逻辑层（不依赖 electron app 生命周期），便于单元测试；
 * app.quit() 由 update-handlers 在收到 triggerRestart=true 后调用。
 *
 * 职责链：
 *   1. pickAsset：按 platform 选 asset（deb 用户选 AppImage 但 APPIMAGE undefined → unsupported）
 *   2. downloadAsset：下载 + sha256 校验（onProgress 推 downloading 进度）
 *      2.5 网络类失败 → 跨源降级续传（update-multi-source D5，见 tryCrossSourceResumeDownload）
 *   3. 写 update-result.json status='replacing'（installUpdate 阶段，self-healer 启动时检测中断）
 *   4. createPlatformUpdater().prepareUpdate：生成脚本 + 触发替换
 *   5. 据 ref.kind 决定返回值（detached-script → triggerRestart / unsupported → 抛错）
 *
 * [HISTORICAL] 不变量：
 * - orchestrator 不调 app.quit()（保持纯逻辑可测，quit 由 handler 调）
 * - onProgress 单回调：handler 负责转成 update:progress IPC 事件推 renderer
 * - 失败时 throw UpdateError/UpdateUnsupportedError，handler catch 后推 update:error 事件
 * - linux deb 用户（APPIMAGE undefined）：pickAsset 仍返回 AppImage asset，但 prepareUpdate 抛
 *   UpdateUnsupportedError（携带 fallbackUrl），orchestrator 透传给 handler
 * - 并发保护：module-level updating 标志，installUpdate 进行中时拒绝重入（避免重复 spawn 脚本）
 * - win 与 mac/linux 统一 detached-script 语义（设计 §3.4 批次 2）：wrapper 在
 *   prepareUpdate 内 spawn，orchestrator 不再延迟 spawn NSIS 安装器（原 1.5s
 *   延迟魔数常量与 win 安装器 ref 分支已整体删除）
 *
 * 依赖方向：orchestrator → download-asset + platform-updater + proxy-config + constants + types
 *   + error-log + ../release-checker（降级 by-tag 查询的默认实现，经 IReleaseChecker
 *   接口消费）+ @taiji/shared
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { URL } from 'node:url'
import type { LatestReleaseInfo, ReleaseAsset, UpdateSource, UpdateStage } from '@taiji/shared'
import { UPDATE_STALE_RELEASE } from '@taiji/shared'
import { downloadAsset } from './download-asset.js'
import { createPlatformUpdater } from './platform-updater.js'
import { pickPlatformAsset } from './pick-platform-asset.js'
import { getUpdateDir, getUpdateResultFile } from './constants.js'
import { readProxyConfig } from './proxy-config.js'
import { UpdateError, UpdateIntegrityError, UpdateUnsupportedError } from './types.js'
import type { UpdateScriptRef } from './types.js'
import { logSourceFailover, logDownloadSuccess } from './error-log.js'
import { ALLOWED_DOWNLOAD_HOSTS } from './release-sources.js'
import { ReleaseChecker } from '../release-checker.js'
import type { IReleaseChecker } from '../interfaces.js'

/** 进度完成百分比 */
const PROGRESS_COMPLETE = 100

/** 升级进度回调签名 */
export type UpdateProgressCallback = (stage: UpdateStage, percent: number) => void

/** 下载阶段返回的已校验产物路径 */
interface DownloadedFile {
  filePath: string
}

/** 升级编排器 Facade 接口（DI 契约，供 handler 注入）。
 *
 * handler（update-handlers.ts）的全部升级能力都经此接口调用，禁止绕过 DI
 * 直接 import downloadUpdate/installUpdate——这样快路径与预下载也能在测试中
 * 经 mock DI 接口替换，而非靠 mock 模块本身（见 S#11 arch-boundary）。
 */
export interface IUpdateOrchestrator {
  /**
   * 下载阶段：选 asset + 下载 + sha256 校验 + 网络类失败的跨源降级续传（D5）。
   *
   * 供预下载（后台静默下载）复用。下载完成后返回已校验的文件路径，不触发替换。
   *
   * @param release release-checker 返回的最新版本信息
   * @param onProgress 下载进度回调（0-100 百分比，仅 downloading 阶段）。可为 undefined（预下载静默）
   * @param opts.releaseChecker 跨源降级 by-tag 查询用的 checker（可注入以便测试替换）；
   *   缺省时用模块内惰性构造的 ReleaseChecker 默认实例（fetchReleaseByTag 为无状态透传，
   *   不消费缓存/退避/源顺序状态）——preloadUpdateSilently 经同一入口零改动获得降级能力
   * @returns 已下载并校验的文件路径
   * @throws UpdateError 下载/校验失败（含 downloading 锁重入拒绝）；跨源降级链任何
   *   失败均回退为原错误上抛（UpdateIntegrityError 除外，见 tryCrossSourceResumeDownload）
   */
  downloadUpdate(
    release: LatestReleaseInfo,
    onProgress?: (percent: number) => void,
    opts?: { releaseChecker?: IReleaseChecker },
  ): Promise<DownloadedFile>

  /**
   * 版本解析（批次 3 信任锚 RC1）：renderer 只传意图（version 字符串），release 数据
   * 由 main 权威解析。四分支 + 60s 节流详见 {@link resolveByVersion}。
   *
   * @param version renderer 请求的目标版本号（不可信输入，严格校验）
   * @param opts.currentVersion 当前 app 版本（checker 比较用）
   * @param opts.releaseChecker Release 权威源（缓存 / force check）
   * @throws UpdateError 格式非法 / STALE_RELEASE / check 网络失败 / 节流中
   */
  resolveByVersion(
    version: string,
    opts: { currentVersion: string; releaseChecker: IReleaseChecker },
  ): Promise<LatestReleaseInfo>

  /**
   * 安装阶段：平台分发（生成替换脚本 + 触发替换）+ 据 ref.kind 决定返回值。
   *
   * 供预下载快路径复用：预下载产物存在时跳过 downloadUpdate 直接调本函数。
   *
   * @param release 当前 release 信息（取 sha256 / version / htmlUrl，注入替换脚本）
   * @param filePath downloadUpdate 返回的已校验文件路径
   * @param onProgress 进度回调（仅 replacing 阶段）。可为 undefined
   * @returns triggerRestart=true 表示需要重启（handler 调 app.quit）
   * @throws UpdateError/UpdateUnsupportedError 准备替换失败
   */
  installUpdate(
    release: LatestReleaseInfo,
    filePath: string,
    onProgress?: UpdateProgressCallback,
  ): Promise<{ triggerRestart: boolean }>
}

/**
 * 并发保护：installUpdate 进行中时拒绝重入。
 *
 * 重复调用会竞争写 update-result.json + spawn 多个 detached 脚本（文件锁冲突 /
 * 多脚本同时替换导致破损）。用 module-level 单例标志做互斥。
 * 注意：进程内互斥即可（handler 单线程调用），跨进程由 update-result.json SSOT 兜底。
 */
let updating = false

/**
 * 并发保护：downloadUpdate 进行中时拒绝重入（含预下载）。
 *
 * 与 {@link updating} 分离：预下载（downloadUpdate）与安装（installUpdate）
 * 使用不同锁，允许「预下载进行中用户点击更新」等并发场景由调用方编排（见 update-handlers
 * 的快路径逻辑）。download-asset 自身的断点续传机制保证两者不会损坏同一临时文件。
 */
let downloading = false

/**
 * 当前安装形态是否支持自动更新（批次 6 review S：linux deb 与 Intel mac 同类门控的判定源）。
 *
 * linux 仅 AppImage 打包支持（APPIMAGE 环境变量由 AppImage 运行时注入）；deb/rpm 安装形态下
 * pickPlatformAsset 恒返回 AppImage asset——下载恒成功、install 恒抛 UpdateUnsupportedError →
 * handler 清 preloaded → 下次 check（预下载开启时）再后台下 ~170MB 循环空转。
 * 该判定同时供 downloadUpdate 门控（fail-fast 零字节）与 handler 层预下载跳过使用，
 * 两处同源防漂移。
 */
export function isAutoUpdateSupportedForCurrentInstall(): boolean {
  return !(process.platform === 'linux' && !process.env.APPIMAGE)
}

/**
 * 下载阶段：选 asset + 下载 + sha256 校验。
 *
 * 从原一键流程拆分，供预下载（后台静默下载）复用。下载完成后返回已校验的文件路径，
 * 不触发替换——调用方拿到 filePath 后可立即 installUpdate 或暂存（preloaded-update.json）。
 * 注意：不写 update-result.json 的 replacing 标记（那是 installUpdate 的职责），
 * 否则预下载后未安装就崩溃会触发 self-healer 误回滚。
 *
 * 不推 update:progress 事件：预下载是静默后台行为，进度回调由调用方决定如何处理
 * （update:download 透传给 handler 推 IPC；预下载不传回调静默）。
 *
 * @param release release-checker 返回的最新版本信息
 * @param onProgress 下载进度回调（0-100 百分比，仅 downloading 阶段）。可为 undefined（预下载）
 * @param opts.releaseChecker 跨源降级 by-tag 查询用 checker（测试注入点）；缺省用默认实例
 * @returns 已下载并校验的文件路径
 * @throws UpdateError 下载/校验失败；跨源降级链失败回退为原错误上抛（见接口注释）
 */
export async function downloadUpdate(
  release: LatestReleaseInfo,
  onProgress?: (percent: number) => void,
  opts?: { releaseChecker?: IReleaseChecker },
): Promise<{ filePath: string }> {
  // 0. 并发保护：重入直接拒绝（避免重复下载 / 写文件竞争）
  if (downloading) {
    throw new UpdateError('download already in progress', 'downloading')
  }
  downloading = true
  try {
    // 0.5 架构门控（批次 5 m8）：Intel mac 直接拒绝，不下载任何字节。
    // 落点在 downloadUpdate 入口、pickPlatformAsset 之前——预下载与手动下载共用本入口，
    // 因此预下载同样被拦住，不会先下完 ~170MB 才在 install 阶段被拒。
    // 修复的是「静默装错架构产物」：pickPlatformAsset 对 darwin 一律返回 macArm64Dmg，
    // Intel mac 装上 arm64 包会得到一个打不开的 app。
    if (process.platform === 'darwin' && process.arch !== 'arm64') {
      throw new UpdateUnsupportedError(
        `auto update supports Apple Silicon only (current arch: ${process.arch})`,
        release.htmlUrl,
      )
    }
    // 0.6 打包形态门控（review round-1 S，与 m8 同类空转的第二形态）：linux deb/rpm
    // 安装不支持自动更新——失败前置到零字节下载之前（fallbackUrl 引导手动安装），
    // 预下载与手动下载共用本入口因此同样被拦。判定源 = isAutoUpdateSupportedForCurrentInstall。
    if (!isAutoUpdateSupportedForCurrentInstall()) {
      throw new UpdateUnsupportedError(
        `auto update supports AppImage installs only on linux (APPIMAGE env not set — deb/rpm package)`,
        release.htmlUrl,
      )
    }

    // 1. 选 asset。断供错误信息并入 release 页链接：存量 darwin 用户（本版本
    //    只发 dmg 后）报错时有一键手动下载出路（设计 §3.3.3-D「错误信息可操作」）
    const asset = pickPlatformAsset(release)
    if (!asset) {
      throw new UpdateError(
        `no asset for platform ${process.platform} (release page: ${release.htmlUrl})`,
        'downloading',
      )
    }

    // 2. 下载 + 校验（downloadAsset 内部已校验 sha256/size）
    //    [C1] 读取 proxy-config.json（统一由 ./proxy-config.ts SSOT 负责），
    //    把代理配置传给 downloadAsset，让下载链路真正接入代理
    //    （downloadAsset 内部据此构造 undici ProxyAgent dispatcher）。
    //    proxyConfig 读取失败（文件损坏等）不阻断升级：降级为默认 mode='system'（直连/环境变量）。
    const proxyConfig = readProxyConfig()
    let outcome: Awaited<ReturnType<typeof downloadAsset>>
    try {
      outcome = await downloadAsset(asset, onProgress, proxyConfig)
    } catch (err) {
      // 下载段跨源降级（update-multi-source §6.5 D5）：网络类失败 → 对侧源 by-tag
      // 确认后复用 temp + resume-state 续传。降级不成立（触发集合外 / source 缺失 /
      // 对侧不可用）时原样上抛原错误。
      const failedOver = await tryCrossSourceResumeDownload({
        asset, release, err, onProgress, proxyConfig,
        releaseChecker: opts?.releaseChecker,
      })
      if (!failedOver) throw err
      outcome = failedOver
    }
    // 下载成功登记（download-success，S1 多段生效断言观测面）：multiPart = 本次
    // 实际执行路径、engine = 实际完成下载的引擎，均取自 downloadAsset 返回值
    // （降级续传成功时为对侧续传那次调用的真实观测值）。
    logDownloadSuccess({
      multiPart: outcome.multiPart,
      engine: outcome.engine,
      releaseSource: release.source,
    })
    return { filePath: outcome.filePath }
  } finally {
    downloading = false
  }
}

// ── 下载段跨源降级（update-multi-source §6.5 D5 / §6.7 D7 / §6.8 D8）────────

/**
 * 降级触发集合（errorCode 白名单）：仅网络类失败换源有意义（含「代理对当前源域
 * 不可用但对对侧可用」场景）。磁盘 / 重命名 / 权限类失败换源无意义，显式排除；
 * UpdateIntegrityError 属 D8 安全边界，单独 instanceof 拦截（sha256/size 不符时
 * 对侧产物同样不可信，fail-fast 不装坏文件）。
 */
const FAILOVER_TRIGGER_ERROR_CODES: ReadonlySet<string> = new Set([
  'UPDATE_NETWORK_FAILED',
  'UPDATE_NETWORK_TIMEOUT',
  'UPDATE_PROXY_ERROR',
  'UPDATE_PROXY_UNREACHABLE',
])

/** UpdateSource 两值枚举的补集（github ↔ gitcode）。 */
function oppositeSource(source: UpdateSource): UpdateSource {
  return source === 'github' ? 'gitcode' : 'github'
}

/**
 * 降级 by-tag 查询用 checker 解析：显式注入（测试 / 未来 DI）优先；缺省用模块内
 * 惰性构造的 ReleaseChecker 默认实例。fetchReleaseByTag 是无状态透传方法（D1 门面），
 * 不消费缓存 / 退避 / 源顺序状态，独立实例无状态副作用。
 *
 * 惰性构造的理由：避免模块加载期副作用；且 u-checker（fetchReleaseByTag 实现）落地前
 * release.source 恒为 undefined（检查链尚未多源化），降级链在 source 守卫处即被拦截，
 * 默认实例不会被真正调用——中间态安全。
 */
let defaultFailoverChecker: IReleaseChecker | undefined
function resolveFailoverChecker(injected?: IReleaseChecker): IReleaseChecker {
  if (injected) return injected
  if (!defaultFailoverChecker) defaultFailoverChecker = new ReleaseChecker()
  return defaultFailoverChecker
}

/** 平台 asset 键（LatestReleaseInfo.assets 的全部键位）。 */
const PLATFORM_ASSET_KEYS = ['macArm64Dmg', 'winX64Exe', 'linuxX64AppImage'] as const

/**
 * 在对侧 release 的平台 asset 中按 name 精确匹配目标资产（§4.2③：目标平台 asset
 * 按 name 匹配存在）。两源同名上传（D5 不变量），name 不一致 = 对侧产物形态异常，
 * 视为对侧不可用。
 */
function findSideAssetByName(
  release: LatestReleaseInfo,
  name: string,
): ReleaseAsset | undefined {
  for (const key of PLATFORM_ASSET_KEYS) {
    const candidate = release.assets[key]
    if (candidate && candidate.name === name) return candidate
  }
  return undefined
}

/**
 * 对侧 downloadUrl 域校验（防御纵深）：降级 URL 来自 by-tag API 响应，直接进
 * download-asset 的 fetch（不经过 install 前的 validateRelease），此处按与白名单
 * 同源的 ALLOWED_DOWNLOAD_HOSTS 做 https + 域校验；不合法视为对侧不可用（不降级），
 * 与 D6「非白名单域依旧 fail-fast」方向一致。
 */
function isAllowedDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

/** 跨源降级入参（downloadUpdate 内聚装配，收口成对象避免参数列膨胀）。 */
interface ICrossSourceResumeInput {
  /** 本源胜出 asset（完整性基准 sha256/size 与 temp 键控 name 的来源） */
  asset: ReleaseAsset
  /** 本次下载的 release（source / tagName 降级依据） */
  release: LatestReleaseInfo
  /** 主源下载抛出的原始错误（触发判定 + 最终上抛对象） */
  err: unknown
  /** 进度回调（透传降级续传） */
  onProgress?: (percent: number) => void
  /** 代理配置（透传降级续传） */
  proxyConfig: ReturnType<typeof readProxyConfig>
  /** 显式注入的 checker（可缺省） */
  releaseChecker?: IReleaseChecker
}

/**
 * 下载段跨源降级续传（update-multi-source §6.5 D5）。
 *
 * 降级成立（返回 { filePath }）的全部条件：
 *   ① 原错误是网络类（errorCode ∈ 触发集合）且非 UpdateIntegrityError（D8 安全边界）
 *   ② release.source 存在（undefined = 旧落盘 pending/preloaded 文件，不降级，D7）
 *   ③ 对侧 by-tag 命中该 tag（tagName 一致）且目标平台 asset（按 name 匹配）存在，
 *      且其 downloadUrl 落白名单域
 * 降级续传仅替换 downloadUrl，完整性基准（sha256/size）保持原胜出源 asset——tag 重发
 * 发散窗口下对侧内容将因 sha256 不符 fail-fast（与 D8 语义一致）。temp 按 asset.name
 * 键控 + resume-state 按 temp 路径匹配（download-asset 既有机制），跨源续传天然命中
 * 同一断点；totalBytes 不符由既有守卫自动转全量（§11.4 三组合）。
 *
 * 降级发生点（对侧确认可用、实际转向续传前）登记 logSourceFailover(segment='download')；
 * by-tag null（404 发布时间窗）与 200 但目标 asset 缺失（部分同步失败窗口）同语义：
 * 不降级、保留本源 temp+state、原错误上抛（不误报、不触发无意义续传）。
 *
 * @returns 降级续传成功返回 downloadAsset 完整结果（含 multiPart/engine 观测值，
 *          为对侧续传那次调用的真实值）；降级不成立返回 null（调用方原错误上抛）
 * @throws UpdateIntegrityError 降级续传产物完整性不符（D8：原样上抛，绝不吞成网络错误）
 */
async function tryCrossSourceResumeDownload(
  input: ICrossSourceResumeInput,
): Promise<Awaited<ReturnType<typeof downloadAsset>> | null> {
  const { asset, release, err, onProgress, proxyConfig, releaseChecker } = input
  // ① 触发集合 + 完整性安全边界
  if (!(err instanceof UpdateError)) return null
  if (err instanceof UpdateIntegrityError) return null
  if (!err.errorCode || !FAILOVER_TRIGGER_ERROR_CODES.has(err.errorCode)) return null
  // ② source 缺失（旧落盘文件）不降级，维持单源行为
  if (!release.source) return null

  const from = release.source
  const to = oppositeSource(from)
  const checker = resolveFailoverChecker(releaseChecker)

  try {
    // ③ 对侧 by-tag 精确确认（IReleaseChecker 透传；null = 该源无此 tag）
    const sideRelease = await checker.fetchReleaseByTag(to, release.tagName)
    if (!sideRelease || sideRelease.tagName !== release.tagName) {
      console.log(`[download] cross-source failover skipped: tag ${release.tagName} not found on ${to}`)
      return null
    }
    const sideAsset = findSideAssetByName(sideRelease, asset.name)
    if (!sideAsset) {
      console.log(`[download] cross-source failover skipped: asset ${asset.name} missing on ${to}`)
      return null
    }
    if (!isAllowedDownloadUrl(sideAsset.downloadUrl)) {
      console.log(`[download] cross-source failover skipped: side url host not allowed`)
      return null
    }

    // 降级发生点登记（对侧确认可用、实际转向续传前；S6 断言依赖本登记的存在性判定）
    logSourceFailover({ segment: 'download', from, to, errorCode: err.errorCode })

    // 复用既有 temp + resume-state：仅替换 downloadUrl，sha256/size 保持原胜出源基准
    return await downloadAsset({ ...asset, downloadUrl: sideAsset.downloadUrl }, onProgress, proxyConfig)
  } catch (failoverErr) {
    // 对侧产物完整性不符 = 产物与发布清单发散（D8 安全边界）：原样上抛，绝不吞成
    // 网络错误回退原错误（否则「校验失败」被降格为「网络不佳」，安全语义破坏）
    if (failoverErr instanceof UpdateIntegrityError) throw failoverErr
    // 降级链其他失败（对侧 by-tag 网络失败 / 续传网络失败）→ 原错误上抛（§7.4 下载-双源行：
    // 用户可见错误与现状同形，降级是 best-effort 而非新的失败形态）
    console.warn(
      `[download] cross-source failover to ${to} failed, rethrowing original error:`,
      failoverErr,
    )
    return null
  }
}

/**
 * 版本解析拒绝后的节流窗口：拒绝后 60s 内同 channel 后续请求直接拒绝、不触发
 * force check——恶意 renderer 高频 invoke 不能定向打光各源的检查 API 限额
 * （GitHub 匿名配额 60 次/小时；多源后节流保护面 = 任一被检查的源）。
 * 批次 4 的退避在 renderer 侧，拦不住恶意 invoke，节流必须在 main 侧。
 */
const RESOLVE_THROTTLE_MS = 60_000

/** 请求版本严格格式（3-4 段数字，与 release-checker 的 STRICT_VERSION_RE 同规则） */
const REQUESTED_VERSION_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/

/**
 * 上次版本解析拒绝时刻（epoch ms，0 = 无拒绝）。
 * 只由 STALE_RELEASE 与格式非法拒绝触发；网络失败不节流（用户网络恢复后可立即重试）。
 */
let lastResolveRejectedAt = 0

/**
 * 版本解析器（批次 3 信任锚 RC1 核心）。
 *
 * update:download 契约版本号化后，renderer 只传意图（version 字符串），release 数据
 * 由 main 权威解析。四分支（设计 §3.5.1）：
 *   ① ReleaseChecker 缓存（非强制调用 = 1h 缓存语义）命中且版本一致 → 用缓存 release
 *   ② 缓存无 / 版本不一致 → 一次权威 force check：check 失败（网络断/超时，既不能
 *      确认也不能证伪）→ 抛网络类 UpdateError，绝不回退使用任何缓存外或 renderer 侧
 *      数据；check 成功但 latest.version ≠ 请求版本 → 抛 UPDATE_STALE_RELEASE
 *      （renderer 收到后自动重查，拿到更新的 latest）
 *   ③ 请求版本格式非法（非 string / 非 3-4 段数字）→ 直接拒绝
 *   ④ 拒绝后 60s 节流：同 channel 后续请求直接拒绝，不触发 force check
 *
 * 效果断言：无论 renderer 传什么，能被下载执行的永远是任一源胜出的本仓库 latest
 * release 官方 asset——RC1 的整类攻击面消失。
 *
 * [已知语义边界] checkForLatestRelease 的 null 同时覆盖「网络失败」与「latest ≤ 当前
 * 版本」等情形（该接口不在本单元领地）：两者在此一律按失败处理拒绝升级——保守方向
 * 安全（拒绝 ≠ 误装），代价是降级请求得到网络类错误文案。
 */
export async function resolveByVersion(
  version: string,
  opts: { currentVersion: string; releaseChecker: IReleaseChecker },
): Promise<LatestReleaseInfo> {
  // ④ main 侧廉价节流：拒绝后 60s 内直接拒绝（含合法重试——设计如此取舍，
  //    renderer 侧批次 4 退避会避开窗口）
  if (Date.now() - lastResolveRejectedAt < RESOLVE_THROTTLE_MS) {
    throw new UpdateError(
      'version resolve throttled: a previous resolve was rejected recently, retry later',
      'downloading',
    )
  }

  // ③ 版本格式非法 → 直接拒绝。typeof 守卫先行：IPC payload 不受 TS 类型约束，
  //    数字等非 string 值会被正则隐式串化绕过（123 → '123' 合法），必须显式拒绝
  if (typeof version !== 'string' || !REQUESTED_VERSION_RE.test(version)) {
    lastResolveRejectedAt = Date.now()
    throw new UpdateError(`invalid requested version format: ${String(version)}`, 'downloading')
  }

  // ① 缓存优先：非强制调用命中 1h 缓存且版本一致 → 直接用缓存 release（零网络）
  const cached = await opts.releaseChecker.checkForLatestRelease(opts.currentVersion)
  if (cached && cached.version === version) {
    return cached
  }

  // ② 权威 force check（缓存无 / 版本不一致）
  const latest = await opts.releaseChecker.checkForLatestRelease(opts.currentVersion, {
    force: true,
  })
  if (!latest) {
    // check 失败：既不能确认也不能证伪请求版本 → 抛网络类错误，绝不回退
    throw new UpdateError('latest release check failed (network)', 'downloading', 'UPDATE_NETWORK_FAILED')
  }
  if (latest.version !== version) {
    // check 成功但 latest ≠ 请求版本 → 请求版本已过期（renderer 应重新检查更新）
    lastResolveRejectedAt = Date.now()
    throw new UpdateError(
      `requested version ${version} is stale (latest is ${latest.version})`,
      'downloading',
      UPDATE_STALE_RELEASE,
    )
  }
  return latest
}

/**
 * 安装阶段：平台分发（生成替换脚本 + 触发替换）+ 据 ref.kind 决定返回值。
 *
 * 从原一键流程拆分，供预下载快路径复用：预下载产物存在时跳过 downloadUpdate
 * 直接调本函数。filePath 必须是已通过 sha256 校验的下载产物。
 *
 * @param release 当前 release 信息（取 sha256 / version / htmlUrl，注入替换脚本）
 * @param filePath downloadUpdate 返回的已校验文件路径
 * @param onProgress 进度回调（仅 replacing 阶段）。可为 undefined（预下载场景不适用）
 * @returns triggerRestart=true 表示需要重启（handler 调 app.quit）
 * @throws UpdateError/UpdateUnsupportedError 准备替换失败
 */
export async function installUpdate(
  release: LatestReleaseInfo,
  filePath: string,
  onProgress?: UpdateProgressCallback,
): Promise<{ triggerRestart: boolean }> {
  // 复用 updating 锁：installUpdate 会 spawn 替换脚本，与其他安装调用互斥
  if (updating) {
    throw new UpdateError('update already in progress', 'replacing')
  }
  updating = true
  try {
    // 写 update-result.json status='replacing'（self-healer 启动时检测中断）。
    // replacing 标记是 self-healer 检测「正在替换、崩溃需回滚」的关键信号，
    // 必须在真正触发替换前写入。预下载阶段（downloadUpdate）只下载不替换，
    // 不应写 replacing——否则下载后用户未点安装就崩溃，self-healer 会误判
    // 需要回滚（实际只是下载中断）。此处放在 installUpdate（即将 spawn 替换脚本）才写。
    try {
      mkdirSync(getUpdateDir(), { recursive: true })
      writeUpdateResult('replacing', release.version)
    } catch (writeErr) {
      // 权限错误分类
      if (writeErr instanceof Error && (writeErr.message.includes('EACCES') || writeErr.message.includes('permission'))) {
        throw new UpdateError(
          'permission denied when writing update status',
          'replacing',
          'UPDATE_PERMISSION_DENIED',
        )
      }
      // 磁盘空间不足
      if (writeErr instanceof Error && (writeErr.message.includes('ENOSPC') || writeErr.message.includes('disk space'))) {
        throw new UpdateError(
          'insufficient disk space for update status file',
          'downloading',
          'UPDATE_DISK_SPACE',
        )
      }
      throw writeErr
    }

    // 平台分发（生成脚本 + 触发替换）
    onProgress?.('replacing', 0)
    const updater = createPlatformUpdater()
    let ref: UpdateScriptRef
    try {
      ref = updater.prepareUpdate(filePath, release)
    } catch (prepErr) {
      // 权限错误分类
      if (prepErr instanceof Error && (prepErr.message.includes('EACCES') || prepErr.message.includes('permission'))) {
        throw new UpdateError(
          'permission denied during update preparation',
          'replacing',
          'UPDATE_PERMISSION_DENIED',
        )
      }
      throw prepErr
    }
    onProgress?.('replacing', PROGRESS_COMPLETE)

    // 据 ref.kind 决定返回值
    return handleScriptRef(ref)
  } finally {
    updating = false
  }
}

/**
 * 根据平台升级器返回的 UpdateScriptRef 决定后续动作。
 *
 * - detached-script：三平台统一语义——替换脚本已在 prepareUpdate 内 spawn detached
 *   （win 为 cmd wrapper，见 win-updater-cmd.ts），orchestrator 只透传 triggerRestart
 * - unsupported：抛 UpdateUnsupportedError
 */
function handleScriptRef(ref: UpdateScriptRef): { triggerRestart: boolean } {
  switch (ref.kind) {
    case 'detached-script':
      // 三平台统一：脚本已 spawn detached，返回 triggerRestart=true（handler 调 app.quit）
      return { triggerRestart: true }
    case 'unsupported':
      throw new UpdateUnsupportedError(ref.reason, ref.fallbackUrl)
    default: {
      // 不可达分支（TS 已穷尽：UpdateScriptRef 只剩 detached-script / unsupported 两个
      // kind）。保留防御性 fail-fast 的理由：ref 来自 platform-updater 的返回值，未来
      // 若新增 kind 而此处漏改，静默透传会让升级停在一个没人报错的中间态——比抛错难查。
      const exhaustive: never = ref
      throw new UpdateError(`unexpected script ref kind: ${exhaustive}`, 'replacing')
    }
  }
}

/**
 * 写 update-result.json（跨进程 SSOT）。
 *
 * @param status replacing|done|failed|rolled-back
 * @param version 目标版本
 * @param error 可选错误信息（failed 时）
 *
 * 注意：写入失败直接抛错（不吞错）。调用方决定容错策略：
 *   - 初始 replacing 标记：必须成功（self-healer 检测中断的关键信号），失败应中断升级
 *   - 成功/失败终态标记：调用方可在 catch 内 best-effort 记录（不影响安全）
 */
function writeUpdateResult(status: string, version: string, error?: string): void {
  const data = { status, version, at: new Date().toISOString(), error }
  const resultFile = getUpdateResultFile()
  // 原子写（批次 5 m12 / §3.7.2）：先写 .tmp 再 renameSync，读方（self-healer）不会
  // 读到半截 JSON——半截 replacing 会被 corrupt-json 分支误判触发回滚。
  const tmpPath = `${resultFile}.tmp`
  // eslint-disable-next-line no-magic-numbers -- 2 = JSON 缩进空格数（人类可读）
  writeFileSync(tmpPath, JSON.stringify(data, null, 2))
  // 同目录 rename：同卷原子替换（目标已存在时覆盖）
  renameSync(tmpPath, resultFile)
}

/**
 * 升级编排器单例（注入 IpcHandlerDeps）。
 *
 * 实现 {@link IUpdateOrchestrator} 全部方法：downloadUpdate / resolveByVersion / installUpdate。
 * handler 经 deps.updateOrchestrator.* 调用——快路径与预下载也走 DI，使全部升级能力可经
 * mock 接口替换测试（见 S#11 arch-boundary：消除「DI 契约只含旧一键方法，新能力绕过 DI」的分裂）。
 */
export const updateOrchestrator: IUpdateOrchestrator = {
  downloadUpdate,
  resolveByVersion,
  installUpdate,
}
