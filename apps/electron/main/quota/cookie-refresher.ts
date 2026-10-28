/**
 * 隐藏窗口 cookie 刷新器（quota:refresh-cookie 的执行主体）。
 *
 * cookie 类 provider（mimo / opencode-go）的服务端登录态换发必须走真实浏览器环境
 * （页面 JS + SSO 跳转），本模块按需创建隐藏 BrowserWindow 让续期循环跑起来：
 *
 *   种 cookie（secrets 文件 → partition）→ 加载 pageUrl → 轮询 apiUrl 直到 HTTP 200
 *   → 导出 partition 的目标域 cookie 串 → 销毁窗口（串经 IPC 回 renderer）
 *
 * 日常零内存占用：窗口按需创建、成败都 destroy；partition 用 persist 前缀（历史登录态
 * 跨刷新保留，SSO 跳转链的中间 cookie 不丢）。
 *
 * 与 runtime 的写方关系（跨进程单写方裁决，data-source-registry #66）：main **只读**
 * secrets 文件（种 cookie 直读）；导出串不落盘，由 renderer 续期链走 quota.configure
 * 保存链经 runtime QuotaService 单点写入——secrets 文件的唯一写方进程恒为 runtime，
 * 消除 main 覆盖写与 runtime 读-合并-写跨进程交错丢更新的竞态。
 *
 * 安全策略（与主窗口 window-factory 的白名单语义不同，独立成套）：
 * - will-navigate 只放行目标站点域（pageUrl / apiUrl 的 host）+ loginUrlPatterns 中
 *   host 形态 pattern 命中的账号域，其余 deny——第三方域导航会把 session cookie 带
 *   到不可信站点（Cookie SameSite 之外的最后防线）
 * - setWindowOpenHandler 一律 deny（弹窗不开）
 * - nodeIntegration: false + contextIsolation: true（加载的是平台页面，非受控内容）
 *
 * 依赖方向：quota/cookie-refresher → electron + node:fs/node:path + @taiji/shared
 * （刷新目标 SSOT）+ logs/main-logger。无下游（IPC 层 quota-cookie-ipc 消费）。
 */
import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { getQuotaRefreshTarget, normalizeCookieHeader } from '@taiji/shared'
import type { QuotaRefreshCookieResult, QuotaRefreshTarget } from '@taiji/shared'
import { mainLogger } from '../logs/main-logger.js'

/** 轮询间隔（规格：interval 1s）。 */
const POLL_INTERVAL_MS = 1_000
/** 无登录交互的总超时（规格：15s——登录态健康时页面续期循环应在数秒内放行 API）。 */
const API_TIMEOUT_MS = 15_000
/** 登录页停留判定阈值（规格：持续 5s 未离开才转可见——SSO 跳转链路过境登录域不误判）。 */
const LOGIN_LINGER_MS = 5_000
/** 转可见后的放宽总超时（规格：120s——等用户完成人工登录）。 */
const LOGIN_TIMEOUT_MS = 120_000
/** 完成信号：API 探测的 HTTP 状态码（只看 200，不校验业务字段）。 */
const HTTP_OK = 200
/** 毫秒 → 秒（超时失败文案用）。 */
const MS_PER_SECOND = 1_000

/** 刷新请求（与 IPC payload 同构；providerId 决定 partition 与 secrets 文件名）。 */
export type QuotaRefreshInput = {
  fetcherId: string
  providerId: string
}

/** 依赖注入范围：测试注入 dataDir 桩；生产缺省 @taiji/shared/paths getDataDir()。 */
export type QuotaRefreshDeps = {
  dataDir?: () => string
}

/** providerId → 在途刷新 Promise（同 provider 重入返回同一 Promise，不并发开第二个窗口）。 */
const inflight = new Map<string, Promise<QuotaRefreshCookieResult>>()

/**
 * 刷新指定 provider 的 cookie 登录态。永不 reject（异常归一进 ok:false + error 文案，
 * IPC 调用方按结果分支展示，无需 catch 面区分调用错误与执行失败）。
 */
export function refreshQuotaCookie(
  input: QuotaRefreshInput,
  deps: QuotaRefreshDeps = {},
): Promise<QuotaRefreshCookieResult> {
  const existing = inflight.get(input.providerId)
  if (existing) return existing
  const run = runRefresh(input, deps).finally(() => {
    inflight.delete(input.providerId)
  })
  inflight.set(input.providerId, run)
  return run
}

async function runRefresh(input: QuotaRefreshInput, deps: QuotaRefreshDeps): Promise<QuotaRefreshCookieResult> {
  const target = getQuotaRefreshTarget(input.fetcherId)
  if (!target) {
    // IPC 层已校验 fetcherId 在册；此处兜底（直接调用方传错 id 时给出可定位文案）
    return { ok: false, error: `no quota refresh target for fetcher: ${input.fetcherId}` }
  }
  const dataDir = deps.dataDir?.() ?? getDataDir()
  let win: BrowserWindow | null = null
  try {
    // persist 前缀 = 落盘 partition（历史登录态跨刷新保留）；providerId 维度隔离。
    // fromPartition 一并进 try：任何环节异常都归一进 ok:false，守住「永不 reject」契约
    const ses = session.fromPartition(`persist:quota-${input.providerId}`)
    await seedCookies(ses, target, dataDir, input.providerId)
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    attachNavigationGuards(win, target)
    try {
      // loadURL resolve 即主文档加载完成（含 SSO 服务端跳转链），此后页面可执行 JS
      await win.loadURL(target.pageUrl)
    } catch (err) {
      // ERR_ABORTED(-3) 不是失败：平台页 JS 发现未登录会主动导航到登录链
      // （如 xiaomimimo 的 genLoginUrl → account.xiaomi.com），打断初始加载。
      // SSO 跳转/登录页检测/超时全部由轮询承载，这里只拦真正的加载故障
      if (!isAbortedNavigation(err)) {
        return { ok: false, error: `page load failed: ${errorMessage(err)}` }
      }
    }
    const polled = await pollUntilApiOk(win, target)
    if (!polled.ok) return { ok: false, error: polled.error }
    const cookie = await exportCookies(ses, target)
    return { ok: true, cookie }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

// ── 种 cookie（secrets 文件 → partition）─────────────────────────────────────

/** cookie 文件路径：`<dataDir>/secrets/<providerId>-cookie.txt`（与 runtime quota-service 同一规则）。 */
function cookieFilePath(dataDir: string, providerId: string): string {
  return join(dataDir, 'secrets', `${providerId}-cookie.txt`)
}

async function seedCookies(ses: Session, target: QuotaRefreshTarget, dataDir: string, providerId: string): Promise<void> {
  let raw: string
  try {
    raw = readFileSync(cookieFilePath(dataDir, providerId), 'utf-8')
  } catch {
    // 文件缺失 = 首次刷新（用户从未贴过 cookie）：跳过种入，partition 里可能已有
    // 历史登录态（persist partition），让页面自己判定
    return
  }
  const normalized = normalizeCookieHeader(raw)
  if (!normalized) return
  const origin = new URL(target.pageUrl).origin
  for (const pair of normalized.split('; ')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    try {
      await ses.cookies.set({ url: origin, name: pair.slice(0, eq), value: pair.slice(eq + 1) })
    } catch (err) {
      // 单条种入失败（cookie 域/属性与服务端写入形态不符）只降级不中断：其余 cookie
      // 足以让续期循环跑起来的场景不能被个别畸形条目阻塞
      mainLogger.warn('[quota-cookie-refresher] seed cookie skipped', {
        providerId,
        name: pair.slice(0, eq),
        error: errorMessage(err),
      })
    }
  }
}

// ── 轮询（登录页检测 + API 探测）──────────────────────────────────────────────

/** 轮询结果：ok=true 表示 API 已 200；ok=false 带 error 文案。 */
type PollResult = { ok: true } | { ok: false; error: string }

async function pollUntilApiOk(win: BrowserWindow, target: QuotaRefreshTarget): Promise<PollResult> {
  const start = Date.now()
  let deadline = start + API_TIMEOUT_MS
  let loginSince: number | null = null
  let loginShown = false

  for (;;) {
    if (win.isDestroyed()) return { ok: false, error: 'refresh window destroyed before api ready' }

    // 登录页检测先于 fetch：转可见判定不被网络往返延迟（用户越早看到窗口越早登录）
    const url = safeGetUrl(win)
    if (isQuotaRefreshLoginUrl(url, target)) {
      loginSince ??= Date.now()
      if (!loginShown && Date.now() - loginSince >= LOGIN_LINGER_MS) {
        loginShown = true
        // 登录态失效确证：转可见让用户登录，超时放宽到 120s（等用户完成登录）
        deadline = Date.now() + LOGIN_TIMEOUT_MS
        win.show()
        mainLogger.info('[quota-cookie-refresher] login required, window shown', { url })
      }
    } else {
      // 离开登录页（SSO 过境或已登录跳回）：停留计时重置
      loginSince = null
    }

    const status = await probeApi(win, target)
    if (status === HTTP_OK) return { ok: true }

    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: loginShown
          ? `login not completed within ${LOGIN_TIMEOUT_MS / MS_PER_SECOND}s`
          : `api poll timed out after ${API_TIMEOUT_MS / MS_PER_SECOND}s (last status ${status})`,
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

/** 页面上下文内 fetch 目标 API，返回 HTTP status（异常/非数值归一为 0）。
 *  POST 端点（connect RPC 形态）按 target.apiMethod/apiBody 发探测——与真实额度
 *  请求同方法，GET 探测会被 405 误判为登录态失效。 */
async function probeApi(win: BrowserWindow, target: QuotaRefreshTarget): Promise<number> {
  try {
    const init =
      target.apiMethod === 'POST'
        ? `{method:'POST',body:${JSON.stringify(target.apiBody ?? '{}')}}`
        : ''
    const expr = `fetch(${JSON.stringify(target.apiUrl)},${init}).then(r => r.status).catch(() => 0)`
    const status = await win.webContents.executeJavaScript(expr)
    return typeof status === 'number' ? status : 0
  } catch {
    // 页面跳转中 / 导航被拦截时 executeJavaScript 会拒绝：本轮按无响应处理，
    // 轮询自然重试（下一轮页面稳定后恢复）
    return 0
  }
}

function safeGetUrl(win: BrowserWindow): string {
  try {
    return win.webContents.getURL()
  } catch {
    // webContents 已销毁的瞬间 getURL 会抛：按空串处理（不命中任何登录页特征）
    return ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Electron net 错误码 ERR_ABORTED：页面 JS 发起新导航打断初始加载（SSO 链标准形态）。 */
const NET_ERR_ABORTED = -3

function isAbortedNavigation(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  return code === NET_ERR_ABORTED || /ERR_ABORTED/.test(err.message)
}

// ── 导出（partition → IPC 返回值）────────────────────────────────────────────

/**
 * 导出 partition 中目标域的 cookie 串。
 *
 * ses.cookies.get({}) 能拿到 HttpOnly cookie（document.cookie 拿不到，这正是要走
 * 隐藏窗口而非 renderer fetch 的原因）；导出串保持手贴格式（`name=value; name2=value2`），
 * 除域过滤外不做任何加工——runtime fetcher 直接把它作 Cookie 请求头发送。
 * main 不落盘（跨进程单写方裁决，见模块头注释）：串经 QuotaRefreshCookieResult.cookie
 * 回 renderer，由续期链走 quota.configure 保存链经 runtime 单点写 secrets 文件。
 *
 * @returns 目标域一条 cookie 都没有时 throw（API 200 却无 cookie 属于不可能态，按异常
 *   上抛由调用方统一归一，不静默返回「成功但没导出」）
 */
async function exportCookies(ses: Session, target: QuotaRefreshTarget): Promise<string> {
  const all = await ses.cookies.get({})
  const siteHosts = siteHostsOf(target)
  const header = all
    .filter((c) => isTargetCookieDomain(c.domain, siteHosts))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
  if (!header) {
    throw new Error(`no cookies captured for target domain (${[...siteHosts].join(', ')})`)
  }
  return header
}

// ── 导航守卫（安全策略）───────────────────────────────────────────────────────

function attachNavigationGuards(win: BrowserWindow, target: QuotaRefreshTarget): void {
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedQuotaRefreshNavigation(url, target)) {
      event.preventDefault()
      mainLogger.warn('[quota-cookie-refresher] blocked navigation outside target domains', { url })
    }
  })
  // 弹窗一律不开：刷新流程没有需要新窗口的分支，window.open / target=_blank 全 deny
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

/** 目标站点域集合（pageUrl / apiUrl 的 hostname；大小写归一）。 */
function siteHostsOf(target: QuotaRefreshTarget): Set<string> {
  const hosts = new Set<string>()
  for (const u of [target.pageUrl, target.apiUrl]) {
    try {
      hosts.add(new URL(u).hostname.toLowerCase())
    } catch {
      // 在册配置 URL 非法的防御分支：跳过该条，白名单按已解析的其余域收窄
      mainLogger.warn('[quota-cookie-refresher] invalid target url in config', { url: u })
    }
  }
  return hosts
}

/**
 * 登录页判定：loginUrlPatterns 任一命中当前 URL（大小写不敏感）。
 * 与导航白名单（isAllowedQuotaRefreshNavigation）语义不同：这里对完整 URL 跑
 * pattern（路径形态 '/login' 在此生效），只用于「是否转可见」判定，不放行任何导航。
 */
export function isQuotaRefreshLoginUrl(url: string, target: QuotaRefreshTarget): boolean {
  return target.loginUrlPatterns.some((p) => new RegExp(p, 'i').test(url))
}

/**
 * 导航白名单：只放行目标站点域 + loginUrlPatterns 中 host 形态 pattern 命中的账号域。
 *
 * host 形态判定 = pattern 不含 '/'（'account\\.xiaomi\\.com' / 'auth\\.'）；
 * 路径形态（'/login'）**不参与放行**——它匹配任意域的同路径（evil.com/login 也命中），
 * 平台自身的 /login 登录页已在目标站点域内放行，不需要路径形态开洞。
 *
 * host 匹配用锚定式而非对 pattern 跑正则：无锚正则的子串语义会把伪装域
 * （account.xiaomi.com.evil.com）当账号域放行。两种 pattern 形态各自锚定：
 * 尾点形态（'auth\\.'）= 子域前缀（auth.opencode.ai）；裸域形态（'account.xiaomi.com'）
 * = 等值或子域后缀（sub.account.xiaomi.com）。
 */
export function isAllowedQuotaRefreshNavigation(url: string, target: QuotaRefreshTarget): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  const host = parsed.hostname.toLowerCase()
  if (siteHostsOf(target).has(host)) return true
  return target.loginUrlPatterns
    .filter((p) => !p.includes('/'))
    .some((p) => hostMatchesLoginHostPattern(host, p))
}

/** host 形态 pattern 的锚定匹配（形态语义见 isAllowedQuotaRefreshNavigation）。 */
function hostMatchesLoginHostPattern(host: string, pattern: string): boolean {
  if (pattern.endsWith('.')) return host.startsWith(pattern)
  return host === pattern || host.endsWith(`.${pattern}`)
}

/**
 * cookie 的 domain 属性是否落在目标站点域内（导出过滤）。
 * Electron cookie.domain 形态：'.example.com'（域 cookie，覆盖子域）或
 * 'app.example.com'（host-only）；前导 '.' 剥掉后按域后缀匹配。缺省 domain
 * （Electron 类型可缺）按不匹配处理。
 */
export function isTargetCookieDomain(cookieDomain: string | undefined, siteHosts: Set<string>): boolean {
  if (!cookieDomain) return false
  const domain = cookieDomain.replace(/^\./, '').toLowerCase()
  for (const host of siteHosts) {
    if (host === domain || host.endsWith(`.${domain}`)) return true
  }
  return false
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
