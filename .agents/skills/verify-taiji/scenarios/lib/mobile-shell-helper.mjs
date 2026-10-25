/**
 * 移动壳验收公共助手（verify-taiji scenarios/lib；remote-use-mobile-v2 V1-V12 系列剧本共享）。
 *
 * 访问形态（源码核对，2026-10-25）：移动壳的真实用户路径 = 桌面实例 runtime 的 HTTP 服务
 * 静态托管壳产物 + 同端口 WS 验身（V1「扫码打开 http://<lan-ip>:<runtimePort>/?token=…」），
 * 不是 vite dev（packages/mobile-renderer vite.config.ts 的 1421 dev server 无 WS 代理，
 * 只用于壳视图开发，验不了验身链）。装配链 = 三件事同时成立：
 *   ① <dataDir>/remote-access.json 预置 enabled=true + 64hex token（main spawn runtime 时
 *      现读决定开态 → 拼 --remote-access --mobile-dist argv；契约源 packages/shared/src/
 *      remote-access.ts RemoteAccessConfig）；
 *   ② packages/mobile-renderer/dist 存在（runtime 启动期 resolveMobileStaticRoot 探测，
 *      缺失 → 静态托管禁用 → GET / 404，仅 /health 通）；
 *   ③ runtime HTTP 服务端口 = <dataDir>/runtime.port 文件值（instance.info().runtimePort）。
 * ①由本文件 writeRemoteAccessConfig 提供（run.mjs meta.remoteAccess 钩子在 launch 前调用）；
 * ②③由剧本装配判定步骤显式检查（assertShellServing）。
 *
 * 设备仿真形态：Playwright 内置设备描述符（devices['iPhone 13'] = viewport/touch/UA/DPR
 * 全套，与现有剧本的 Playwright 驱动库同栈）。不用裸 CDP Emulation.setDeviceMetricsOverride：
 * 触屏形态需要 hasTouch+UA+DPR 联动，CDP 单参数容易漏且脱离既有驱动栈。
 *
 * 零第三方依赖（playwright 经 instance.mjs loadPlaywright 从 repo 解析）；零产品语义
 * （token key / 配置文件名只是契约常量引用，不做任何凭据裁决）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

/** remote token 在移动壳 localStorage 的持久 key（契约源 mobile-renderer connection-profile.ts）。 */
export const MOBILE_TOKEN_STORAGE_KEY = 'taiji.remote-access.token'

/** 移动壳用户偏好持久 key（单 JSON 键；契约源 mobile-renderer shell/app-runtime.ts MOBILE_PREFS_STORAGE_KEY）。 */
export const MOBILE_PREFS_STORAGE_KEY = 'taiji.mobile.prefs'

/** remote-access.json 文件名与内容契约（SSOT packages/shared/src/remote-access.ts）。 */
export const REMOTE_ACCESS_FILENAME = 'remote-access.json'

/** 移动壳三态锚点（ConnectScreen.vue / TokenInputView.vue testid；boot 期三态呈现面）。 */
export const MOBILE_BOOT_STATE_TESTIDS = ['shell-boot-skeleton', 'token-input-view', 'shell-failed-screen']

/** 移动壳 dist 解析（与 electron main dev 分支 resolveMobileDistPath 同构：repoRoot 推导）。 */
export function resolveMobileDist(repo) {
  return path.join(repo, 'packages', 'mobile-renderer', 'dist')
}

/**
 * 生成 remote token：32 字节随机值 hex 编码（对齐 main 写侧 generateRemoteAccessToken 的
 * 熵量与形态：64 位小写 hex，REMOTE_TOKEN_HEX64 可验）。
 */
export function generateRemoteToken() {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * 预置 remote-access.json（launch 前调用——main spawn runtime 时现读定开态，launch 后写
 * 不生效）。权限 0600 对齐 main 写侧（token 等同远程控制凭据）。幂等覆盖：验收实例每次
 * run 预置新 token，避免复用旧目录时拿到已轮换的旧值。
 */
export function writeRemoteAccessConfig(dataDir, token, { enabled = true } = {}) {
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error(`remote token 形态非法（须 64 位小写 hex）：${token.slice(0, 8)}…`)
  }
  const file = path.join(dataDir, REMOTE_ACCESS_FILENAME)
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    file,
    `${JSON.stringify({ enabled, token, createdAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  )
  return file
}

/**
 * remote-access 开态生效取证（区分「GET / 404 = 开态没生效」vs「开了但 dist 缺失禁用」）：
 * - main 侧（verify-launch.log）：spawn 时现读 remote-access.json 开态会打
 *   `remote access enabled: --remote-access --mobile-dist=...`（process-control buildRemoteAccessSpawnArgs）；
 * - runtime 侧（logs/runtime-*.log）：开态 + dist 缺失时 resolveMobileStaticRoot 打
 *   `remote access: 移动壳 dist 目录不存在: <path>，静态托管面已禁用`。
 * 两行均在 = 预置生效且 404 归因 dist 缺失；main 行缺 = 预置没生效（恢复：检查写点时序）。
 * 返回 { mainEnabled, runtimeDisabledByDist, mainLine, runtimeLine }（找不到为 null）。
 */
export function readRemoteAccessSpawnEvidence(dataDir) {
  const readSafe = (file) => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  const launchLog = readSafe(path.join(dataDir, 'verify-launch.log'))
  const mainLine = launchLog.split('\n').find((l) => l.includes('remote access enabled')) ?? null
  const logDir = path.join(dataDir, 'logs')
  let runtimeLogText = ''
  try {
    for (const f of fs.readdirSync(logDir)) {
      if (f.startsWith('runtime-')) runtimeLogText += readSafe(path.join(logDir, f))
    }
  } catch {
    /* logs 目录不存在 */
  }
  const runtimeLine =
    runtimeLogText.split('\n').find((l) => l.includes('remote access') && (l.includes('dist 目录不存在') || l.includes('--mobile-dist'))) ?? null
  return {
    mainEnabled: mainLine !== null,
    runtimeDisabledByDist: runtimeLine !== null && runtimeLine.includes('dist 目录不存在'),
    mainLine,
    runtimeLine,
  }
}

/** GET 一个 runtime HTTP 路径（毫秒级本地探测；非 2xx 也返回状态码供判定）。 */
function httpGet(port, pathname, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, error: 'timeout' })
    })
  })
}

/**
 * 移动壳静态托管装配判定（B 通道）：/health 必通（runtime 活着）+ GET / 应 200 且是 HTML
 * （dist 在位且 handler 注入）。404 = dist 缺失/E5 禁用（恢复动作指向构建）；非 200 非 404
 * = 服务异常。不抛错，返回事实由剧本记断言（装配不完整是验收 fail 的真实结果，不是异常）。
 */
export async function probeShellServing(runtimePort) {
  const health = await httpGet(runtimePort, '/health')
  const shell = await httpGet(runtimePort, '/')
  return {
    healthOk: health.status === 200,
    healthStatus: health.status,
    shellStatus: shell.status,
    shellContentType: shell.headers?.['content-type'] ?? '',
    shellIsHtml: (shell.headers?.['content-type'] ?? '').includes('text/html'),
    bodyHead: (shell.body ?? '').slice(0, 200),
  }
}

/**
 * 打开移动壳页面（Playwright chromium headless + 设备描述符仿真）。
 *
 * @param {{repo:string, runtimePort:number, token:string, deviceName?:string,
 *          locale?:string, timeoutMs?:number}} opts
 *   locale：浏览器 nav 语言（vue-i18n 按 locale 选词表）；缺省 = 设备描述符自带（en-US）。
 *   文案断言的剧本（V9-V11 系）显式传 'zh-CN' 对齐中文用户真机形态。
 * @returns console/pageerror 收集器挂在返回值上（白屏归因的第一现场：模块加载 SyntaxError
 *   会以 pageerror 形态出现，是「断链白屏」与「逻辑 bug 白屏」的分辨证据）。
 */
export async function openMobileShell({ repo, runtimePort, token, deviceName = 'iPhone 13', locale, timeoutMs = 30_000 }) {
  const { loadPlaywright } = await import('../../scripts/lib/instance.mjs')
  const { chromium, devices } = loadPlaywright(repo)
  const device = devices[deviceName]
  if (!device) {
    throw new Error(`Playwright 设备描述符不存在：${deviceName}（可用：${Object.keys(devices).filter((k) => k.toLowerCase().includes('iphone')).join(', ')}…）`)
  }
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext(locale ? { ...device, locale } : { ...device })
  const page = await context.newPage()
  const consoleLines = []
  const pageErrors = []
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`))
  // SyntaxError 类 pageerror 的 stack 为空串（V8 导出绑定错误不填栈）——序列化必须带
  // name+message，只取 stack 会拿到空串丢失全部定位信息（2026-10-25 探针实测）。
  page.on('pageerror', (err) => {
    pageErrors.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
  })
  const url = `http://127.0.0.1:${runtimePort}/?token=${encodeURIComponent(token)}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  return { browser, context, page, consoleLines, pageErrors, url }
}

/**
 * 首屏白屏采样（断言①原语）：domcontentloaded 起高频轮询 #app 子元素数与三态锚点。
 *
 * 判定语义（V1 通过标准「首屏任意时点非白屏」）：采样窗内存在任意一个 #app 非空时刻即
 * 通过；blankMs 累计、firstNonBlankAt 首个非空时刻、statesSeen 命中的三态锚点集合同步
 * 返回供证据。条件轮询（禁 sleep 后断言），采样间隔 100ms 保证「任意时点」的分辨率。
 */
export async function watchFirstPaint(page, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const startedAt = Date.now()
  let firstNonBlankAt = null
  let firstStateSeen = null
  const samples = []
  for (;;) {
    const snap = await page
      .evaluate((stateIds) => {
        const app = document.getElementById('app')
        const childCount = app ? app.childElementCount : -1
        const states = stateIds.filter((id) => document.querySelector(`[data-testid="${id}"]`) !== null)
        return { childCount, states }
      }, MOBILE_BOOT_STATE_TESTIDS)
      .catch((e) => ({ childCount: -1, states: [], error: String(e?.message ?? e) }))
    samples.push(snap)
    if (snap.childCount > 0 && firstNonBlankAt === null) {
      firstNonBlankAt = Date.now() - startedAt
      firstStateSeen = snap.states
    }
    if (snap.states.length > 0 && firstStateSeen === null) firstStateSeen = snap.states
    if (firstNonBlankAt !== null && firstStateSeen !== null) break // 两证齐了即可提前收
    if (Date.now() - startedAt >= timeoutMs) break
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  const blankMs = firstNonBlankAt === null ? Date.now() - startedAt : firstNonBlankAt
  return { firstNonBlankAt, blankMs, firstStateSeen, samples: samples.length }
}

/** 读移动壳 localStorage 的 remote token（断言②③的凭据事实读侧）。 */
export async function readStoredToken(page) {
  return page.evaluate((key) => window.localStorage.getItem(key), MOBILE_TOKEN_STORAGE_KEY)
}

/**
 * 等待「query token 已验身消费」完成（断言②原语）：location.search 无 token 且 storage
 * 落盘了同值凭据（connection-profile D4：auth 成功 → set storage + replaceState 抹地址栏，
 * 两个写点都发生才算消费完成）。条件轮询，超时返回最后事实由剧本判定。
 */
export async function waitForTokenHandover(page, token, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = { search: '', stored: null }
  for (;;) {
    last = await page
      .evaluate((key) => ({ search: window.location.search, stored: window.localStorage.getItem(key) }), MOBILE_TOKEN_STORAGE_KEY)
      .catch((e) => ({ search: `<eval 失败: ${e?.message ?? e}>`, stored: null }))
    const stripped = !last.search.includes('token=')
    if (stripped && last.stored === token) return { ok: true, ...last }
    if (Date.now() >= deadline) return { ok: false, ...last }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * 等待验身失败落 token 输入态（断言③原语）：坏 query token 验身被拒 → connection-view
 * 信号③ → token-input 视图。条件轮询 testid 出现；超时返回可见性事实由剧本判定。
 */
export async function waitForTokenInputView(page, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const visible = await page
      .locator('[data-testid="token-input-view"]')
      .first()
      .isVisible()
      .catch(() => false)
    if (visible) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 收尾：关浏览器（context 先于 browser，保证页面事件流 flush）。幂等。 */
export async function closeMobileShell(handle) {
  if (!handle) return
  try {
    await handle.context?.close()
  } catch {
    /* 已关 */
  }
  try {
    await handle.browser?.close()
  } catch {
    /* 已关 */
  }
}

// ── V9/V10/V11 系列共享驱动原语（mobile-subagent-panel / mobile-disconnect-reconnect /
//    mobile-preferences-session-exit 三剧本复用；装配仍归上方 openMobileShell，不重复）────

/**
 * 条件等 testid 元素可见（playwright 原生 waitFor，超时返回 false 由剧本记断言，不抛）。
 */
export async function waitForTestidVisible(page, testid, { timeoutMs = 15_000 } = {}) {
  try {
    await page.locator(`[data-testid="${testid}"]`).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/**
 * 等壳 connected：bottom-nav 挂载 = 已验身成功且路由已离开 connect 页的稳定信号
 * （BottomNav 只在非 connect 路由渲染，App.vue；token 交接在先由 connection-profile 完成）。
 */
export async function waitForShellConnected(page, { timeoutMs = 30_000 } = {}) {
  return waitForTestidVisible(page, 'bottom-nav', { timeoutMs })
}

/** 移动壳 Composer 输入区 locator（ComposerInput = contenteditable div；fill 不触发 input 逻辑）。 */
export function shellComposerInput(page) {
  return page.locator('[data-testid="mobile-composer"] [contenteditable]').first()
}

/**
 * 点会话行切入聊天（SessionsScreen 行 testid = `session-row-<sid>` → chat-screen 挂载）。
 * 点入前先等行在（connected 边沿 loadSessions 异步拉列表，广播可能晚于可点时机）。
 */
export async function openSessionInShell(page, sessionId, { timeoutMs = 20_000 } = {}) {
  await page
    .locator(`[data-testid="session-row-${sessionId}"]`)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
  await page.locator(`[data-testid="session-row-${sessionId}"]`).first().click()
  const chatShown = await waitForTestidVisible(page, 'chat-screen', { timeoutMs })
  return chatShown
}
