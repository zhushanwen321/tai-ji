/**
 * 自动升级 IPC handler。
 *
 * 对应 slice auto-update-and-install：注册两类 channel：
 *   - 'update:check'：检测最新版（w2，委托 IReleaseChecker.checkForLatestRelease）
 *   - 'update:perform'：已删除（批次 3 m17：UI 走两阶段 download/install，一键路径连同
 *     renderer 暴露点一并移除；未来静默升级入口按「只传版本号」新契约另建）
 *   - 'update:download'：拆分后的下载阶段（批次 3 契约版本号化：resolveByVersion 权威解析
 *     → downloadUpdate + 写 preloaded；update-network-resilience D1 后入口先走本地短路
 *     ①preloaded 严格同版本 ②pending 认领 manual/ 产物，均纯本地零网络——断网逃生通道）
 *   - 'update:install'：拆分后的安装阶段（从 preloaded 读取 release + filePath，委托 installUpdate；
 *     响应含实装 version 字段，D2 交错缓解：renderer 进入 restarting 态前对齐实装版本）
 *   - 'update:getPreloaded'：读取预下载产物（readPreloadedUpdateRaw，供前端判断是否已下载完成；
 *     miss 后尝试认领 manual/ 产物，D1 启动恢复链——app 启动即显示「已下载可安装」态）
 *   - 'update:testProxy'：代理探测（upgradeFetch 双引擎：undici 失败自动换 curl，
 *     单引擎被兜住即成功；D5 探针不参与 enginePreference 置位）
 *   - 'update:openManualDir'：打开手动产物目录（D9 设置页手动通道「打开目录」：
 *     首次点击先幂等建目录再 shell.openPath，用户不必手动建目录）
 *
 * [HISTORICAL] 不变量：
 * - 单 payload 对象规则：invoke payload 恒为单对象，禁止多 arg
 * - install/download 内 onProgress 转发为 'update:progress' 事件（win.isDestroyed 守卫）
 * - 错误转发为 'update:error' 事件（区分 UpdateError.stage / UpdateUnsupportedError.errorCode）
 * - orchestrator 是纯逻辑（不调 app.quit）；quit 由本 handler 在 triggerRestart=true 后调
 * - quit 用 setTimeout(500) 延迟：给前端一点时间显示「重启中」状态
 * - releaseChecker / updateOrchestrator 未注入时降级（check 返回 null / download、install 抛错）
 *
 * 依赖方向：update-handlers → electron(app/ipcMain) + interfaces + update/types + update/proxy-config
 *   + update/manual-claim + update/upgrade-fetch
 */
import { mkdirSync } from 'node:fs'
import { app, ipcMain, shell } from 'electron'
import type { LatestReleaseInfo, IProxyConfig, UpdateSettings, UpdateCheckResult, ProxyTestResult, UpdateInstallResult } from '@taiji/shared'
import type { IpcHandlerDeps } from '../interfaces.js'
import { UpdateError } from '../update/types.js'
import type { UpdateErrorInfo } from '../update/types.js'
import { readProxyConfig, writeProxyConfig, resolveProxyUrl } from '../update/proxy-config.js'
import { validateRelease } from '../update/validate-release.js'
import { writePendingUpdate, readPendingUpdate } from '../update/pending-update.js'
import { getUpdateSettings, setUpdateSettings, normalizeUpdateSourcePref } from '../update/update-settings.js'
import type { IUpdateOrchestrator, UpdateProgressCallback } from '../update/orchestrator.js'
import { isAutoUpdateSupportedForCurrentInstall } from '../update/orchestrator.js'
import { writePreloadedUpdate, readPreloadedUpdate, readPreloadedUpdateRaw, clearPreloadedUpdate } from '../update/preloaded-update.js'
import { getManualAssetDir, tryClaimManualAsset } from '../update/manual-claim.js'
import { upgradeFetch, CurlFetchError, isCurlHttpStatusError } from '../update/upgrade-fetch.js'
import { classifyNetError } from '../update/net-errors.js'
import { appendUpdateError } from '../update/error-log.js'
import { toErrorMessage } from '../utils/error-message'

/** 触发重启前留给前端渲染「重启中」状态的延迟（毫秒）。 */
const RESTART_QUIT_DELAY_MS = 500

/**
 * [A-X4] force 检测节流窗口（毫秒）。
 *
 * update:check 的 force=true 会绕 releaseChecker 缓存直打各源 releases/latest API
 * （多源逐源）；恶意/异常 renderer 高频 invoke 可烧穿 API 配额（403 后进入 2h 退避，
 * 期间所有用户检测不可用）。窗口内的重复 force 请求不拒绝而是降级为非 force 语义
 * （走 checker 缓存）——用户体验无损，API 配额不再被放大。
 */
const FORCE_CHECK_THROTTLE_MS = 10_000

/**
 * [A-X4] 上次真正发起 force 检测的时间戳（模块级）。
 *
 * handler 在 registerUpdateHandlers 内模块级注册，多个 renderer 窗口共享同一 main
 * 进程——跨窗口共享节流正是期望语义（配额是进程级共享的）。时间戳在发起 force 调用
 * 前同步置位（而非成功后）：闭住同 tick 并发窗口，第二个并发 invoke 也会被降级。
 */
let lastForceCheckAt = 0

/**
 * 尝试认领 manual/ 手动产物，异常不阻断升级主链。
 *
 * 认领短路（D1）是优化路径：tryClaimManualAsset 的契约 miss 返回 null，但并发窗口下的
 * fs 竞态（如候选文件在校验中途被移走）会抛错——此时继续走原链（网络下载仍可能成功），
 * 不能让逃生通道的意外故障反过来杀死正常升级路径。
 */
async function tryClaimManualAssetSafe(release: LatestReleaseInfo): Promise<string | null> {
  try {
    return await tryClaimManualAsset(release)
  } catch (err) {
    console.warn('[update] manual asset claim failed, falling back to normal flow:', err)
    return null
  }
}

/**
 * 测试代理连接。
 *
 * [C2] 必须真正走代理（proxyUrl 传给 upgradeFetch，undici 引擎经 ProxyAgent dispatcher /
 * curl 引擎经 -x，均强制走代理），否则即便代理不可用也会因直连成功而误报——给用户虚假
 * 的成功反馈。返回类型 = shared ProxyTestResult SSOT（update-handlers 内 errorPayload
 * 同型手写处的形状权威，防漂移）。
 *
 * [D8] 双引擎准绳：单引擎失败被另一引擎兜住 → success:true（用户测代理的目的是
 * 「升级能不能走」，curl 能走 = 能升级）；双引擎均失败才报错，且分类取 undici 侧
 * （CurlFetchError.undiciError 携带 errno 语境，curl exit 7 无 errno 级区分）。
 * 「任何 HTTP 响应算代理可用」准绳在两引擎下等价：undici 引擎任何 resolve（含
 * ok:false）即成功；curl 引擎 -f 把 HTTP ≥400 以携带 httpStatusCode 的
 * CurlFetchError 上抛——该形态同样视为「代理可达、服务器返回了 HTTP 状态」→
 * success:true（不落盘、不报错）。
 * [D5] 试错探针不参与 enginePreference 读写：设置页一次失败不该永久改变进程引擎选择。
 */
async function testProxyConnection(config: IProxyConfig): Promise<ProxyTestResult> {
  if (config.mode === 'disabled') {
    return { success: false, message: 'Proxy disabled, skipping test' }
  }

  // manual 模式：先校验代理 URL 格式（避免构造 ProxyAgent 时抛不友好错误）
  if (config.mode === 'manual') {
    const proxyUrl = config.httpsProxy ?? config.httpProxy
    if (!proxyUrl) {
      return { success: false, message: 'No proxy URL configured' }
    }
    try {
      new URL(proxyUrl)
    } catch {
      return { success: false, message: 'Invalid proxy URL format' }
    }
  }

  const proxyUrl = resolveProxyUrl(config)
  if (!proxyUrl) {
    return { success: false, message: 'No proxy resolved (check configuration or env vars)' }
  }

  try {
    // 与旧实现语义对齐：任何完成的 HTTP 响应（无论状态码）都证明代理链路可用，
    // 故只关心是否 resolve，不检查 result.ok（HTTP 状态是 GitHub 侧的事，不是代理的）。
    // 10000ms = 10s 代理探测超时（代理探测应快速失败，避免 UI 长时间等待）
    await upgradeFetch('https://github.com', {
      method: 'HEAD',
      proxyUrl,
      timeoutMs: 10000,
      disableFlagPersistence: true,
    })
    return { success: true }
  } catch (err) {
    // D8 curl 引擎 HTTP 状态交互规则：-f 使 HTTP ≥400 以携带 httpStatusCode 的
    // CurlFetchError 上抛——服务器已返回 HTTP 状态本身就证明代理链路可达（与 undici
    // 引擎「任何完成的 HTTP 响应算成功」准绳两引擎等价），不落盘、不报错
    if (isCurlHttpStatusError(err)) {
      return { success: true }
    }
    // D8: 双引擎均失败，报 undici 错误的分类（curl 降级时 CurlFetchError 携带触发降级的
    // undiciError；未降级（不可降级类）则原样上抛的即 undici 错误）。使用分类函数统一
    // 提取 cause + 判定错误码。
    const undiciErr = err instanceof CurlFetchError && err.undiciError !== undefined ? err.undiciError : err
    const classified = classifyNetError(undiciErr, 'downloading', proxyUrl)
    // timeout 成因分流（F1）：testProxy 探测超时（'timeout (aborted)' 泛化形态）给中性
    // 超时话术——无下载语境，停滞文案的「断点续传」指引在本场景是误导
    let info = resolveTimeoutUserCopy(classified.toUserFriendly(), classified.message)
    // D2（v3 修订）testProxy 统一准绳：公网 EHOSTUNREACH 也给代理语境话术。
    // 用户此刻在测代理，通用网络失败话术（非代理语境）会误导排查方向；
    // 不加映射表变体是因为该话术仅 testProxy 场景有意义，入枚举会污染
    // download/install 共用的错误码空间，handler 内覆写侵入最小。
    // suggestion 不提本地网络权限（A4 反向验证）；落盘 code 维持原分类，
    // 保证 D7 日志归因与下载路径一致。
    if (info.code === 'UPDATE_NETWORK_FAILED' && classified.message.includes('EHOSTUNREACH')) {
      info = {
        ...info,
        message: '无法连接代理 (EHOSTUNREACH)',
        suggestion: '请检查代理地址与端口是否正确、代理服务是否正在运行，以及当前网络能否连通代理',
      }
    }
    // D7: 落盘。engine 从错误形态推导（D8 诊断字段）：CurlFetchError = curl 侧失败
    // 形态（undici 已降级、curl 亦失败）；原样上抛的非降级类错误 = 仅 undici 失败
    appendUpdateError({
      at: new Date().toISOString(),
      source: 'test-proxy',
      stage: info.stage,
      errorCode: info.code,
      rawCause: classified.rawCause,
      proxyUrl,
      engine: err instanceof CurlFetchError ? 'curl' : 'undici',
    })
    return { success: false, code: info.code, message: info.message, suggestion: info.suggestion }
  }
}

/**
 * 后台预下载互斥标志：防止 update:check 多次触发重复下载。
 *
 * 与 orchestrator 的 downloading 锁分离：本标志只在 handler 层防重复触发（check 可能被
 * 多次调用），orchestrator 的 downloading 锁保护真正的下载过程。预下载失败会重置此标志，
 * 下次 check 可再次尝试。
 */
let preDownloading = false

/**
 * 进行中的预下载 promise（若有）。
 *
 * 预下载持锁的是 orchestrator 的 `downloading` 锁。若用户在预下载进行中点更新，
 * update:download 会因 `downloading` 锁被拒（'download already in progress'）。
 * 存下 promise 让 download handler 先 await 它：预下载成功 → 写入 preloaded-update.json →
 * download 重读命中快路径；预下载失败 → 锁已释放 → download 正常走完整下载。
 * promise 完成后置回 null（配合 preDownloading 标志做幂等）。
 */
let preDownloadPromise: Promise<void> | null = null

/**
 * 后台预下载（静默）：检测到新版 + 预下载开关开时触发。
 *
 * 不推 update:progress 事件（静默后台行为，不干扰用户）。下载成功后写 preloaded-update.json，
 * update:download 重读命中快路径跳过重复下载。下载失败落盘 update-error.log（D7）后 console.warn
 * 静默放弃，下次检测重试。
 *
 * download-asset 的断点续传机制保证：预下载未完成时用户手动点更新，downloadUpdate 会
 * 接管同一临时文件续传，进度不浪费。
 *
 * [S#11 arch-boundary] 经 DI 注入的 {@link IUpdateOrchestrator} 调 downloadUpdate，
 * 而非直接 import 模块级单例——使预下载能力也可在测试中经 mock DI 接口替换。
 *
 * @param orchestrator DI 注入的升级编排器（与 update:download/install 共享同一实例）
 */
async function preloadUpdateSilently(
  release: LatestReleaseInfo,
  orchestrator: IUpdateOrchestrator,
): Promise<void> {
  if (preDownloading) return
  preDownloading = true
  try {
    // 已有有效预下载产物（同版本同 asset 文件存在 + 完整性校验通过）→ 不重复下载
    const existing = await readPreloadedUpdate(release)
    if (existing) {
      console.log(`[preload] preloaded update for v${release.version} already exists, skip`)
      return
    }
    console.log(`[preload] background pre-downloading v${release.version}...`)
    const { filePath } = await orchestrator.downloadUpdate(release)
    writePreloadedUpdate(release, filePath)
    console.log(`[preload] pre-downloaded v${release.version} to ${filePath}`)
  } catch (err) {
    // D7: 预下载失败落盘（本诊断环境每次检查更新都会发生的第一失败现场）
    const proxyConfig = readProxyConfig()
    const proxyUrl = resolveProxyUrl(proxyConfig)
    if (err instanceof UpdateError) {
      appendUpdateError({
        at: new Date().toISOString(),
        source: 'preload',
        stage: err.stage,
        errorCode: err.errorCode,
        rawCause: err.rawCause,
        proxyUrl,
      })
    } else {
      appendUpdateError({
        at: new Date().toISOString(),
        source: 'preload',
        stage: 'downloading',
        rawCause: toErrorMessage(err),
        proxyUrl,
      })
    }
    console.warn(`[preload] background pre-download failed for v${release.version}:`, err)
  } finally {
    preDownloading = false
    preDownloadPromise = null
  }
}

/**
 * update:download 的本地短路链（D1 短路①②，纯本地零网络）。命中任一短路返回
 * `{ downloaded: true }`；miss 返回 null 由调用方继续原链（网络解析 + 下载）。
 */
async function resolveUpdateDownloadShortCircuit(
  currentVersion: string,
  requestedVersion: string,
): Promise<{ downloaded: true } | null> {
  // [D1 短路①] preloaded 本地短路（纯本地，断网可用）：preloaded.release.version 与
  // 请求版本**严格相等**才短路——防静默装旧版（preloaded 0.9.12 vs 请求 0.9.11 不
  // 短路）。顺带修复「断网时快路径（resolveByVersion 之后的 readPreloadedUpdate）
  // 也走不到」的缺陷。短路不触发下载进度事件。
  const preloadedRaw = await readPreloadedUpdateRaw(currentVersion)
  if (preloadedRaw && preloadedRaw.release.version === requestedVersion) {
    console.log(
      `[update:download] preloaded v${preloadedRaw.release.version} matches requested version, skip download (local short-circuit)`,
    )
    return { downloaded: true }
  }

  // [D1 短路② / D3] pending 认领短路（零网络）：以上次成功检测持久化的 pending
  // release 为基准（含 assets + sha256），与请求版本严格相等时尝试认领 manual/
  // 目录内手动投放的产物（断网逃生通道，G1）。认领 miss（无候选/校验失败）或异常
  // 均静默继续原链；认领成功由 manual-claim 内部写 preloaded 登记（source
  // 'manual-claim' 的 mismatch 落盘也在该模块内，handler 不重复落盘）。
  const pending = readPendingUpdate(currentVersion)
  if (pending && pending.version === requestedVersion) {
    const claimedPath = await tryClaimManualAssetSafe(pending)
    if (claimedPath) {
      console.log(`[update:download] claimed manual asset v${pending.version} at ${claimedPath}, skip download`)
      return { downloaded: true }
    }
  }
  return null
}

/**
 * UPDATE_NETWORK_TIMEOUT 的用户可见文案按成因分流（design-code-sync F1，
 * timeout-slow-flow-wallclock §7 错误规格表）：该码有三个真实来源，停滞文案若覆盖
 * connect 成因会把用户引向「查传输停滞」而真实问题是网络/代理不可达。
 * 判别依据 = 诊断 message（英文串是落盘诊断通道的原始记录，见 net-errors NOTE）：
 * - connect 形态（mapCurlExitToError connect 档 'curl connection timeout (...)'，
 *   curl --connect-timeout 10s 连接未建立）→ 连接超时话术
 * - 停滞形态（'... stalled ...'，undici 双路径 + curl --speed-time）→ 映射表
 *   停滞 + 断点续传文案（不覆写）
 * - 泛化形态（'timeout (aborted)'，testProxy 探测超时等；无下载语境，「断点续传」
 *   指引不适用）→ 中性超时话术
 * 对齐本文件 testProxy 的 EHOSTUNREACH handler 内覆写先例（场景特化话术不入共享映射表，
 * 避免 download/install 共用的错误码空间被单场景污染）。
 */
function resolveTimeoutUserCopy(info: UpdateErrorInfo, diagnosticMessage: string): UpdateErrorInfo {
  if (info.code !== 'UPDATE_NETWORK_TIMEOUT') return info
  if (/connection timeout/i.test(diagnosticMessage)) {
    return {
      ...info,
      message: '连接超时（10 秒未建立连接）',
      suggestion: '请检查网络连接或代理设置后重试',
    }
  }
  if (/stalled/i.test(diagnosticMessage)) return info
  return {
    ...info,
    message: '连接或响应超时',
    suggestion: '请检查网络连接是否稳定，或尝试配置代理服务器',
  }
}

/**
 * update:download 失败收尾：构造 errorPayload（UpdateError 用户友好形态 / 通用形态）、
 * D7 落盘、推 update:error 事件后 throw 可序列化对象（与 install catch 一致）。
 * 恒 throw。
 */
function reportUpdateDownloadError(deps: IpcHandlerDeps, err: unknown): never {
  const win = deps.getMainWindow()
  let errorPayload
  if (err instanceof UpdateError) {
    const f = resolveTimeoutUserCopy(err.toUserFriendly(), err.message)
    errorPayload = { stage: f.stage, message: f.message, errorCode: f.code, suggestion: f.suggestion }
    // D7: download 失败落盘
    appendUpdateError({
      at: new Date().toISOString(),
      source: 'download',
      stage: f.stage,
      errorCode: f.code,
      rawCause: err.rawCause,
      proxyUrl: resolveProxyUrl(readProxyConfig()),
    })
  } else {
    errorPayload = {
      stage: 'downloading' as const,
      message: toErrorMessage(err),
      errorCode: undefined,
      suggestion: '请重试或联系技术支持',
    }
    appendUpdateError({
      at: new Date().toISOString(),
      source: 'download',
      stage: 'downloading',
      rawCause: toErrorMessage(err),
      proxyUrl: resolveProxyUrl(readProxyConfig()),
    })
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('update:error', errorPayload)
  }
  throw { message: errorPayload.message, stage: errorPayload.stage, errorCode: errorPayload.errorCode, suggestion: errorPayload.suggestion }
}

/**
 * update:download handler 主体（行内箭头提取为具名函数，行为不变）。
 *
 * [SECURITY · 批次 3 RC1] 契约版本号化：renderer 只传意图（version 字符串），
 * release 数据由 main 权威解析（resolveByVersion：缓存 / force check）——旧契约的
 * 完整 release payload（含 downloadUrl/sha256）不再过边界，能被下载执行的永远
 * 是任一源胜出的本仓库 latest release 官方 asset。格式非法 / STALE / 网络失败在
 * resolver 内拒绝，60s 节流防 API 放大。
 */
async function handleUpdateDownload(
  deps: IpcHandlerDeps,
  payload: { version: string },
): Promise<{ downloaded: boolean }> {
  if (!deps.updateOrchestrator) {
    throw new Error('updateOrchestrator not configured')
  }
  if (!deps.releaseChecker) {
    throw new Error('releaseChecker not configured')
  }
  try {
    const shortCircuit = await resolveUpdateDownloadShortCircuit(app.getVersion(), payload.version)
    if (shortCircuit) {
      return shortCircuit
    }

    // [MUST-FIX #1] 若后台预下载仍在进行，先 await 它：预下载持有 orchestrator 的
    // downloading 锁，直接走 download 路径会被拒（'download already in progress'）。
    // await 到锁释放后再决定走快路径（预下载成功写入了产物）还是 download 路径。
    const inFlight = preDownloadPromise
    if (inFlight) {
      console.log('[update:download] background preload in progress, waiting')
      await inFlight
    }

    // 权威解析（缓存命中 / force check / 网络失败抛错 / 格式校验 + 60s 节流）
    const release = await deps.updateOrchestrator.resolveByVersion(payload.version, {
      currentVersion: app.getVersion(),
      releaseChecker: deps.releaseChecker,
    })

    // 快路径：已有有效预下载产物（同版本 + 文件存在 + 完整性通过）→ 不重复下载
    const preloadedFile = await readPreloadedUpdate(release)
    if (preloadedFile) {
      console.log(`[update:download] preloaded file exists for v${release.version}, skip download`)
      return { downloaded: true }
    }

    // 下载阶段 onProgress → update:progress 事件（stage='downloading'）
    console.log(`[update:download] downloading v${release.version}...`)
    const { filePath } = await deps.updateOrchestrator.downloadUpdate(release, (percent) => {
      const win = deps.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:progress', { stage: 'downloading', percent })
      }
    })

    // 写 preloaded（供 update:install 和 update:getPreloaded 读）
    writePreloadedUpdate(release, filePath)
    console.log(`[update:download] downloaded v${release.version} to ${filePath}`)
    return { downloaded: true }
  } catch (err) {
    // 错误处理与 install catch 一致：推 update:error + throw 可序列化对象。
    // download 失败不清 preloaded（此时 preloaded 未写或是历史残留，由 readPreloadedUpdate 自管）。
    reportUpdateDownloadError(deps, err)
  }
}

/**
 * 注册自动升级 IPC handler（update:check + update:download/install + getPending + getSettings/setSettings）。
 *
 * @param deps 注入依赖（releaseChecker / updateOrchestrator / getMainWindow）
 */
export function registerUpdateHandlers(deps: IpcHandlerDeps): void {
  // ── update:check（w2：检测最新版）──────────────────────────────
  // 返回 UpdateCheckResult（RM2.3 信号透传）：info=null 时经 rateLimited 区分
  // 「确认无新版」与「限额退避中」——renderer 据此显示非侵入提示而非假阴性。
  ipcMain.handle('update:check', async (_event, payload?: { force?: boolean }): Promise<UpdateCheckResult> => {
    if (!deps.releaseChecker) return { info: null, rateLimited: false }
    // [A-X4] force 节流：窗口内的重复 force 请求降级为非 force 语义（走 checker 缓存），
    // 不拒绝（用户体验无损）。只约束 force=true——force=false 本就命中缓存无害，透传行为
    // 保持原样（undefined / false 不改写，避免无谓改变 checker 入参形状）。
    const requestedForce = payload?.force === true
    let effectiveForce: boolean | undefined = payload?.force
    if (requestedForce) {
      const now = Date.now()
      if (now - lastForceCheckAt >= FORCE_CHECK_THROTTLE_MS) {
        lastForceCheckAt = now
      } else {
        effectiveForce = false
      }
    }
    try {
      const info = await deps.releaseChecker.checkForLatestRelease(app.getVersion(), {
        force: effectiveForce,
      })
      // 检测到新版 → 写持久化标志（功能 1：常驻提醒），best-effort 不阻塞响应
      if (info) {
        writePendingUpdate(info)
        // 预下载开关开 → 异步后台下载（功能 2），不 await 不阻塞 check 响应。
        // 把 promise 存起来（非 void），供 update:download 在预下载进行中时 await，
        // 避免与后台预下载争抢 orchestrator 的 downloading 锁而硬报错。
        // updateOrchestrator 未注入（dev/check-only 场景）时跳过预下载（download/install 会另行报错）。
        const settings = getUpdateSettings()
        // linux deb/rpm 安装形态不支持自动更新（downloadUpdate 入口同款门控，同源判定
        // isAutoUpdateSupportedForCurrentInstall）——预下载必然失败，不触发后台空转
        if (settings.preDownload && deps.updateOrchestrator && isAutoUpdateSupportedForCurrentInstall()) {
          preDownloadPromise = preloadUpdateSilently(info, deps.updateOrchestrator)
        }
      }
      // RM2.3：null 且处于限额退避窗口内 → rateLimited=true（限额未知，不是「无新版」）
      const rateLimited = !info && (deps.releaseChecker.getRateLimitedUntil?.() ?? 0) > Date.now()
      return { info, rateLimited }
    } catch (err) {
      // 兜底：理论上 checkForLatestRelease 自身已 catch，此处防止意外 reject
      console.error('[update:check] failed:', err)
      return { info: null, rateLimited: false }
    }
  })




  // ── update:download（拆分后的下载阶段）───────────────────────
  // 供新版 UI「先下载 → 再安装」两步流程的下载阶段调用。下载成功后写 preloaded-update.json，
  // 供 update:install 读取（install 权威源是 preloaded，不信任前端传入的 release）。
  // 复刻原一键路径的 inFlight-await（避免与后台预下载争抢 downloading 锁）+
  // 快路径（已有有效预下载产物 → 跳过重复下载）+ 错误转 update:error 事件。
  // 主体在 handleUpdateDownload（行内箭头提取为具名函数，复杂度门禁）。
  ipcMain.handle('update:download', async (_event, payload: { version: string }) =>
    handleUpdateDownload(deps, payload),
  )

  // ── update:install（拆分后的安装阶段）─────────────────────────
  // install 权威源是 preloaded-update.json（不是前端传入）：从 readPreloadedUpdateRaw 读取
  // release + filePath，堵「装错版本」漏洞（前端可能传旧/错 release）。
  // install 失败清 preloaded（防死循环：重试不再命中同一坏产物，强制完整重下 + 重新校验）。
  ipcMain.handle('update:install', async () => {
    if (!deps.updateOrchestrator) {
      throw new Error('updateOrchestrator not configured')
    }
    try {
      // 从 preloaded 读 release + filePath（不信任前端传入）
      const preloaded = await readPreloadedUpdateRaw(app.getVersion())
      if (!preloaded) {
        throw new Error('No preloaded update available')
      }
      const { release, filePath } = preloaded

      // [SECURITY · m11] 防御纵深：install 权威源虽是 preloaded（不信任前端传入），
      // 但 preloaded 文件本身是磁盘写入面，可能被篡改——污染的 version 会拼进下载
      // 路径与 bash 脚本单引号上下文，未校验可触发任意代码执行。与 download 路径
      // 同源白名单校验，堵「绕过 download 直改 preloaded 文件」的旁路。
      validateRelease(release)

      // 安装阶段 onProgress → update:progress 事件（stage='replacing'）
      const onProgress: UpdateProgressCallback = (stage, percent) => {
        const win = deps.getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('update:progress', { stage, percent })
        }
      }
      const result = await deps.updateOrchestrator.installUpdate(release, filePath, onProgress)
      // [D2 交错缓解] 响应携带实装版本：手动认领与后台预下载存在 preloaded 覆写窗口，
      // 实装版本可能与 UI 确认版本不一致——renderer 进入 restarting 态前以本字段对齐
      // state.latestRelease，UI 与实装归一（类型 SSOT = shared UpdateInstallResult）。
      const response: UpdateInstallResult = { ...result, version: release.version }
      if (response.triggerRestart) {
        setTimeout(() => app.quit(), RESTART_QUIT_DELAY_MS)
      }
      return response
    } catch (err) {
      // install 失败清 preloaded：避免重试反复命中同一产物（spawn 失败/权限错误等非完整性失败），
      // 下次重试强制走完整重下 + 重新校验，杜绝死循环。
      clearPreloadedUpdate()
      const win = deps.getMainWindow()
      let errorPayload
      if (err instanceof UpdateError) {
        const f = err.toUserFriendly()
        errorPayload = { stage: f.stage, message: f.message, errorCode: f.code, suggestion: f.suggestion }
        // D7: install 失败落盘
        appendUpdateError({
          at: new Date().toISOString(),
          source: 'install',
          stage: f.stage,
          errorCode: f.code,
          rawCause: err.rawCause,
          proxyUrl: resolveProxyUrl(readProxyConfig()),
        })
      } else {
        errorPayload = {
          stage: 'replacing' as const,
          message: toErrorMessage(err),
          errorCode: undefined,
          suggestion: '请重试或联系技术支持',
        }
        appendUpdateError({
          at: new Date().toISOString(),
          source: 'install',
          stage: 'replacing',
          rawCause: toErrorMessage(err),
          proxyUrl: resolveProxyUrl(readProxyConfig()),
        })
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:error', errorPayload)
      }
      throw { message: errorPayload.message, stage: errorPayload.stage, errorCode: errorPayload.errorCode, suggestion: errorPayload.suggestion }
    }
  })

  // ── update:getPreloaded（读取预下载产物）──────────────────────
  // 供前端判断是否已下载完成（决定显示「下载中」还是「安装」按钮）。
  ipcMain.handle('update:getPreloaded', async () => {
    const preloaded = await readPreloadedUpdateRaw(app.getVersion())
    if (preloaded) {
      return preloaded
    }
    // [D1 启动恢复链] miss 后尝试认领（全本地零网络；基准直接用 pending，无请求版本
    // 可比）——断网 + 用户已手动投放 zip 时，app 启动即显示「已下载可安装」态。
    // 认领 miss（常态：无手动产物）静默返回 null；认领异常同样不阻断（探针语义）。
    const pending = readPendingUpdate(app.getVersion())
    if (pending) {
      const claimedPath = await tryClaimManualAssetSafe(pending)
      if (claimedPath) {
        console.log(`[update:getPreloaded] claimed manual asset v${pending.version} at ${claimedPath}`)
        // 认领已写 preloaded 登记，重读返回标准 { release, filePath } 形状
        return readPreloadedUpdateRaw(app.getVersion())
      }
    }
    return null
  })

  // ── update:getProxyConfig（读取代理配置）──────────────────────
  ipcMain.handle('update:getProxyConfig', async () => {
    return readProxyConfig()
  })

  // ── update:setProxyConfig（保存代理配置）──────────────────────
  ipcMain.handle('update:setProxyConfig', async (_event, config: IProxyConfig) => {
    // 基本校验
    if (!['system', 'manual', 'disabled'].includes(config.mode)) {
      throw new Error('Invalid proxy mode')
    }
    if (config.mode === 'manual') {
      if (!config.httpProxy) {
        throw new Error('HTTP proxy is required in manual mode')
      }
      // 验证 URL 格式
      try {
        new URL(config.httpProxy)
        if (config.httpsProxy) new URL(config.httpsProxy)
      } catch {
        throw new Error('Invalid proxy URL format')
      }
    }
    writeProxyConfig(config)
    return { success: true }
  })

  // ── update:testProxy（测试代理连接）────────────────────────────
  ipcMain.handle('update:testProxy', async (_event, config: IProxyConfig) => {
    return testProxyConnection(config)
  })

  // ── update:getPending（读取升级提醒持久化标志）──────────────────
  // 功能 1：启动时 renderer 调此 handler 恢复「可升级」提醒（离线也能常驻）。
  // readPendingUpdate 内部做版本比较：currentVersion >= pending.version → 清除 + 返回 null。
  ipcMain.handle('update:getPending', async () => {
    return readPendingUpdate(app.getVersion())
  })

  // ── update:getSettings（读取升级设置）──────────────────────────
  ipcMain.handle('update:getSettings', async () => {
    return getUpdateSettings()
  })

  // ── update:getLaunchResult（读取启动结果，consumed 一次性）──────
  // renderer 启动时调用一次，读取 cleanupCompletedUpdate 的返回值（done/failed/rolled-back），
  // 用于显示升级成功/失败/回滚 toast。main.ts 侧缓存 + consumed 标志保证一次性语义。
  ipcMain.handle('update:getLaunchResult', async () => {
    return deps.getLaunchResult?.() ?? null
  })

  // ── update:setSettings（保存升级设置，局部更新：只传要修改的字段）──
  ipcMain.handle('update:setSettings', async (_event, settings: Partial<UpdateSettings>) => {
    // 逐字段类型校验：传了的字段必须是 boolean（缺失 = 不更新该字段）
    if (settings.preDownload !== undefined && typeof settings.preDownload !== 'boolean') {
      throw new Error('Invalid settings: preDownload must be boolean')
    }
    if (settings.autoUpdate !== undefined && typeof settings.autoUpdate !== 'boolean') {
      throw new Error('Invalid settings: autoUpdate must be boolean')
    }
    // updateSource 归一 + 枚举校验（多源 D3）：传了（非 undefined）先归一——三值原样、
    // 旧落盘值经 normalizeUpdateSourcePref 映射新标识符（v0.10.0 旧落盘值兼容），非法值抛错
    // ——handler 边界 fail-fast（对齐上方 boolean 校验先例），存储读取侧另有
    // normalizeUpdateSourcePref 逐字段兜底（非法值回退默认 'auto'），两处共用同一守卫
    if (settings.updateSource !== undefined) {
      const normalizedSource = normalizeUpdateSourcePref(settings.updateSource)
      if (normalizedSource === undefined) {
        throw new Error('Invalid settings: updateSource must be "auto", "github" or "gitcode"')
      }
      settings.updateSource = normalizedSource
    }
    setUpdateSettings(settings)
    return { success: true }
  })

  // ── update:openManualDir（D9 设置页手动通道「打开目录」）─────────
  // 首次点击先幂等建目录（recursive：已存在不报错），再 shell.openPath 在系统文件
  // 管理器打开——用户不必先手动建目录。openPath 失败时返回非空错误字符串（成功为 ''），
  // 抛 Error 携带该字符串对齐本文件既有 handler 错误风格（错误信息可操作）。
  ipcMain.handle('update:openManualDir', async () => {
    mkdirSync(getManualAssetDir(), { recursive: true })
    const openError = await shell.openPath(getManualAssetDir())
    if (openError) {
      throw new Error(`Failed to open manual asset directory: ${openError}`)
    }
    return { success: true }
  })
}
