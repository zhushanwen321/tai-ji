/**
 * 窗口工厂。
 *
 * 对应 spec §4.2 M2/M3：WindowManager 不直接创建 BrowserWindow，
 * 创建职责由此模块承担。含 dev 模式 Vite 就绪轮询。
 *
 * [HISTORICAL] 不变量：
 * - dev 模式 waitForVite 轮询（解决 concurrently 下 Electron 比 Vite 先启动白屏）
 * - preload 路径：dist/preload/preload.cjs（electron-builder files 白名单对应）
 * - contextIsolation: true / nodeIntegration: false（Electron 安全默认）
 * - windowId 注入到 URL query，renderer 读取后用于注册到 WindowManager
 * - D2b 导航拦截：will-navigate 拒绝非应用自身源 + setWindowOpenHandler 默认 deny
 *   （integrity-hardening §3.2；防 XSS 经整页导航/新窗口接管 electronAPI）
 * - renderer 崩溃自动恢复链（crash-resilience §3.3 D2-③）：render-process-gone 详情
 *   经 main-logger 落盘 + 按 windowId 熔断的自动 reload（60s 滑窗 ≤3 次）+ 超限静态
 *   错误页（重试按钮导航回应用源时重置该窗口计数）
 *
 * 依赖方向：window-factory → electron + input-validators + main/interfaces（type-only）
 *   + logs/main-logger（render-process-gone 详情落盘，u3）+ logs/crash-journal（renderer
 *   事件台账，crash-forensics D1）+ window/recovery-policy（熔断）
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, shell } from 'electron'
import type { WindowOptions } from '../interfaces.js'
import { isAllowedAppNavigation, isValidExternalUrl } from '../gateway/input-validators.js'
import { mainLogger } from '../logs/main-logger.js'
import { crashJournal } from '../logs/crash-journal.js'
import { RecoveryPolicy } from './recovery-policy.js'
import { getDataDir } from '@xyz-agent/shared/paths'

/** Dev 模式 Vite URL（XYZ_VITE_DEV_URL 可覆盖：多 worktree 并行 dev 时错开端口，如 1421）。
 *  注意：本常量同时是 will-navigate 导航白名单的 devOrigin（createWindow 内
 *  isAllowedAppNavigation 调用）——覆盖后导航白名单同步接受覆盖源（行为正确：应用实际
 *  从哪个端口加载就应放行哪个）；prod 下仅 loadFile，该覆盖无生效面。 */
export const VITE_DEV_URL = process.env.XYZ_VITE_DEV_URL ?? 'http://localhost:1420'

/** 等待 Vite dev server 就绪的总超时 */
export const VITE_READY_TIMEOUT_MS = 30_000

/** Vite 轮询间隔 */
export const VITE_POLL_INTERVAL_MS = 300

// ── renderer 崩溃自动恢复（crash-resilience §3.3 D2-③ / u3-renderer-recovery）────

/** 模块级熔断计数器：以 windowId 为键（设计 D2 原文），多窗口互不影响；
 *  窗口 'closed' 时 reset 防长寿进程 Map 泄漏（见 createWindow 内挂点）。 */
const rendererRecovery = new RecoveryPolicy()

/** 自动 reload 重载应用时的恢复标志 query（T2「一次性恢复提示条」main 侧注入形态）：
 *  renderer 消费点 = packages/renderer/src/composables/useCrashRecoveryNotice.ts
 *  （首次消费读标志展示提示条并 replaceState 剥离，组件 = CrashRecoveredBar.vue）。 */
export const CRASH_RECOVERY_QUERY_FLAG = 'crash'

/**
 * 构造应用窗口 URL 的 query（windowId 必带；sessionId 与恢复标志按需）。
 * dev loadURL 与 prod/E2E loadFile 共用同一构造（loadFile 侧经 Object.fromEntries
 * 转 Record 形态），保证两条形态 query 字段一致。
 */
export function buildAppQuery(
  windowId: string,
  sessionId?: string,
  extra?: Record<string, string>,
): URLSearchParams {
  const params = new URLSearchParams({ windowId })
  if (sessionId) params.set('sessionId', sessionId)
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      params.set(key, value)
    }
  }
  return params
}

/** 静态错误页日志目录占位符（buildStaticErrorPageHtml 模板替换点）。 */
const LOGS_DIR_PLACEHOLDER = '{{LOGS_DIR}}'
/** 静态错误页重试目标 URL 占位符（script 内 JSON 字符串字面量替换点）。 */
const RETRY_URL_PLACEHOLDER = '{{RETRY_URL}}'

/** HTML 文本转义（logsDir 等注入模板的动态文本统一过此函数，防标记注入）。 */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 静态错误页 HTML（T2 失败路径：同窗口 60s 内第 4 次崩溃后熔断展示）。
 *
 * 内联 HTML + data: URL 加载（选型理由：静态 .html 文件需进 electron-builder files
 * 白名单——打包面改动属 AGENTS.md 规则 12 事故最高发区；data: URL 零文件依赖、
 * prod/dev 行为一致）。文案为设计 T2 失败路径定值；logsDir 由 getDataDir() 动态
 * 推导注入（AGENTS.md 规则：路径白名单禁止硬编码）。「重试」按钮经注入的 retryUrl
 * 导航回应用自身源（will-navigate 白名单放行），main 侧 did-navigate 监听据此重置
 * 该窗口熔断计数。
 */
export function buildStaticErrorPageHtml(logsDir: string, retryUrl: string): string {
  // script 内 URL 用 JSON 字符串字面量注入，'<' 全部转义防 </script> 提前闭合
  const retryUrlLiteral = JSON.stringify(retryUrl).replaceAll('<', '\\u003c')
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>TaiJi</title>',
    '<style>',
    'body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#fafafa;color:#1a1a1a;',
    'display:flex;align-items:center;justify-content:center;min-height:100vh;}',
    'main{max-width:480px;padding:32px;text-align:center;}',
    'h1{font-size:18px;font-weight:600;margin:0 0 12px;}',
    'p{font-size:14px;line-height:1.6;margin:0 0 8px;}',
    'code{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;}',
    'button{margin-top:20px;padding:8px 24px;font-size:14px;cursor:pointer;background:#1a1a1a;',
    'color:#fff;border:none;border-radius:3px;}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '<h1>界面反复崩溃</h1>',
    '<p>界面反复崩溃，请尝试重启应用。</p>',
    `<p>诊断日志位于 <code>${LOGS_DIR_PLACEHOLDER}</code></p>`,
    '<button type="button" id="retry">重试</button>',
    '</main>',
    '<script>',
    'document.getElementById("retry").addEventListener("click", function () {',
    `  window.location.href = ${RETRY_URL_PLACEHOLDER};`,
    '});',
    '</script>',
    '</body>',
    '</html>',
  ]
    .join('\n')
    .replaceAll(LOGS_DIR_PLACEHOLDER, escapeHtml(logsDir))
    .replaceAll(RETRY_URL_PLACEHOLDER, retryUrlLiteral)
}

/**
 * 等待 Vite dev server 就绪（轮询直到连接成功）。
 * 解决 concurrently 下 Electron 比 Vite 先启动导致白屏。
 *
 * @param url Vite 地址
 * @param timeoutMs 总超时
 * @throws 超时抛 Error
 */
export async function waitForVite(url: string, timeoutMs = VITE_READY_TIMEOUT_MS): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    // eslint-disable-next-line taste/no-silent-catch -- Vite dev server not yet ready, retry expected
    } catch {
      // Vite 还没启动，继续等待
    }
    await new Promise((r) => setTimeout(r, VITE_POLL_INTERVAL_MS))
  }
  throw new Error(`Vite dev server at ${url} did not become ready within ${timeoutMs}ms`)
}

/**
 * 按运行形态加载窗口内容（E2E / dev / prod 三分支），任一步失败时 destroy 已创建的窗口。
 *
 * E2E 是一类部署形态（已构建产物 + mock 注入），架构正确归位是独立分支而非 hack isDev：
 *   - 跳过 Vite dev server 轮询（E2E 不起 dev server，否则 waitForVite 30s 超时）
 *   - 加载构建产物 index.html（与 prod 同源，验证真实渲染链路）
 *   - mock 数据由 renderer 侧 import.meta.env.VITE_E2E 注入（main 不参与）
 */
async function loadWindowContent(
  win: BrowserWindow,
  windowId: string,
  options: WindowOptions | undefined,
  deps: { isDev: boolean },
): Promise<void> {
  const isE2E = process.env.XYZ_E2E === '1'
  try {
    if (!isE2E && deps.isDev) {
      // W7 幽灵窗口清理：BrowserWindow 已在 show:false 状态下创建，若 Vite dev server
      // 在超时内未就绪（waitForVite 抛错），必须 destroy 已创建的窗口，否则泄漏一个隐藏窗口。
      await waitForVite(VITE_DEV_URL)
      win.loadURL(`${VITE_DEV_URL}?${buildAppQuery(windowId, options?.sessionId).toString()}`)
      // DevTools 默认关闭：需要时显式 XYZ_DEVTOOLS=1 npm run dev 打开
      if (process.env.XYZ_DEVTOOLS === '1') {
        win.webContents.openDevTools()
      }
    } else {
      // E2E 与 prod 共用：加载构建产物（E2E 仅跳过 dev server 轮询，见函数 docstring）
      win.loadFile(path.join(app.getAppPath(), 'renderer/dist/index.html'), {
        query: Object.fromEntries(buildAppQuery(windowId, options?.sessionId)),
      })
    }
  } catch (err) {
    // W7 E3 幽灵窗口清理：waitForVite 超时或加载阶段抛错时，destroy 已创建的 BrowserWindow，
    // 避免泄漏隐藏窗口（show:false 的窗口用户感知不到，资源却已占用）。
    if (!win.isDestroyed()) {
      win.destroy()
    }
    throw err
  }
}

/**
 * 崩溃后自动重载应用界面（T2 主路径：目标 1s 内恢复可用）。
 *
 * 重载 URL（非 webContents.reload()）：需注入恢复标志 query（recoveredFrom=crash，
 * renderer 侧 useCrashRecoveryNotice 据此展示一次性提示条并清除标志），reload() 不改 query 做不到。dev/prod 分支与
 * loadWindowContent 同构但不复用它：恢复路径不做 waitForVite 轮询（窗口存活过说明
 * Vite 曾就绪；30s 轮询违背 1s 恢复目标）也不重开 DevTools（原会话的副作用于恢复
 * 场景是噪声）。loadURL 失败走既有 did-fail-load 日志，不在此吞错。
 */
function reloadWindowAfterCrash(
  win: BrowserWindow,
  windowId: string,
  sessionId: string | undefined,
  isDev: boolean,
  reason: string | undefined,
): void {
  const query = buildAppQuery(windowId, sessionId, {
    recoveredFrom: CRASH_RECOVERY_QUERY_FLAG,
    crashReason: reason ?? 'unknown',
  })
  const isE2E = process.env.XYZ_E2E === '1'
  if (!isE2E && isDev) {
    win.loadURL(`${VITE_DEV_URL}?${query.toString()}`)
  } else {
    win.loadFile(path.join(app.getAppPath(), 'renderer/dist/index.html'), {
      query: Object.fromEntries(query),
    })
  }
}

/**
 * 展示静态错误页（T2 失败路径：熔断后停自动 reload）+ 挂手动重试导航监听。
 *
 * 错误页经 data: URL 加载（选型见 buildStaticErrorPageHtml）；logsDir 从 getDataDir()
 * 动态推导（与 main-logger 的 logs 目录同一推导，禁止硬编码）。重试按钮触发页面发起
 * 的导航回应用自身源（will-navigate 白名单放行），did-navigate 监听确认导航成功后
 * 重置该窗口熔断计数并记日志——用户手动重试 = 重新获得完整自动 reload 预算。
 */
function showStaticErrorPage(
  win: BrowserWindow,
  windowId: string,
  sessionId: string | undefined,
  isDev: boolean,
): void {
  const logsDir = path.join(getDataDir(), 'logs')
  const retryUrl = buildRetryUrl(windowId, sessionId, isDev)
  mainLogger.warn('[window] renderer crash circuit-breaker opened, showing static error page', {
    windowId,
    logsDir,
  })
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildStaticErrorPageHtml(logsDir, retryUrl))}`)

  const onDidNavigate = (_e: unknown, url: string): void => {
    // data: URL 是错误页自身的程序化加载，非重试导航
    if (url.startsWith('data:')) return
    rendererRecovery.reset(windowId)
    mainLogger.info('[window] renderer recovery manual retry accepted', { windowId, url })
    win.webContents.removeListener('did-navigate', onDidNavigate)
  }
  win.webContents.on('did-navigate', onDidNavigate)
}

/** 重试目标的 URL（dev: Vite 源；prod/E2E: file:// 构建产物），均过 isAllowedAppNavigation 白名单。 */
function buildRetryUrl(windowId: string, sessionId: string | undefined, isDev: boolean): string {
  const query = buildAppQuery(windowId, sessionId)
  const isE2E = process.env.XYZ_E2E === '1'
  if (!isE2E && isDev) {
    return `${VITE_DEV_URL}?${query.toString()}`
  }
  return `${pathToFileURL(path.join(app.getAppPath(), 'renderer/dist/index.html')).href}?${query.toString()}`
}

/**
 * 创建 BrowserWindow 并加载内容（dev: Vite URL / prod: index.html）。
 *
 * @param options.windowId 指定窗口 id（不传由调用方生成）
 * @param options.sessionId 可选，携带 session 迁移
 * @param deps.isDev 是否开发模式
 * @param deps.generateId windowManager 引用（用于分配 id）
 */
export async function createWindow(
  options: WindowOptions | undefined,
  deps: { isDev: boolean; generateId: () => string },
): Promise<{ win: BrowserWindow; windowId: string }> {
  const windowId = options?.windowId ?? deps.generateId()

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: deps.isDev ? 'TaiJi dev' : 'TaiJi',
    // 跨平台窗口装饰（shell spec §五方案 X）。
    // mac：hidden + trafficLightPosition 把红黄绿放到 macOS 原生左上角位置 {8,8}（圆点中线理论 y=14，实测 ≈y15.75）。
    //   不用 hiddenInset：inset 模式强制红黄绿水平内缩，trafficLightPosition.x 被系统忽略。
    //   hidden 模式下红黄绿仍由 OS 绘制（点击/全屏 hover 行为不变），位置可控。
    //   原生位置：圆点 12px，顶理论 y=8 / 实测中线 y≈15.75（macOS 亚像素偏置，比理论 y14 低 ~2pt）；左缘 x=8 / 右缘 x=60（红 8~20 / 黄 28~40 / 绿 48~60）。
    //   AppShell 是 p-1(4px) → aside 左缘 x=4，与红黄绿 x=8 有 4px 差（AGENTS.md 规则 11 明确该差值为预期）；
    //   AppNavControls top-[5px] → 按钮中线 y=16（≈ 红黄绿实测中线 y15.75 对齐）；left-[72px]（右缘 60 + 12 呼吸）。
    //   取舍：不再追求与 PanelHeader 中线(y=32)对齐——原生 mac 应用红黄绿在 titlebar 顶部、
    //   工具栏按钮在其下方，二者本就不同高；折叠态 PanelHeader chrome 在 header 中线，与红黄绿有高度差属预期。
    // win/linux：frame:false 应用自绘圆点 mimic mac（renderer TrafficLight.vue left-0/top-0，aside 顶已在窗口 y=8）。
    ...(process.platform === 'darwin'
      ? {
        titleBarStyle: 'hidden' as const,
        trafficLightPosition: { x: 8, y: 8 },
      }
      : { frame: false }),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist/preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // [HISTORICAL] W16 UC-2：renderer 后台化时 chromium background timer throttling
      // 把 setTimeout 拉到 ~1s（50ms→980-1000ms 实测），mock 流式（70ms×N setTimeout 链）
      // 被拖到 20s+，采样窗口内看不到完成。agent 工作台用户发消息后切窗口是核心场景，
      // renderer 不应被节流（WS onmessage 事件驱动不受影响，但 setTimeout 基础设施会）。
      // 与 VSCode/Cursor 一致：禁用 backgroundThrottling。
      backgroundThrottling: false,
    },
  })

  // ── D2b 导航拦截（integrity-hardening §3.2）───────────────────────
  // will-navigate 拒绝非应用自身源：renderer 被注入（XSS）后 `window.location = 远程页`
  // 会让 preload 对新页面重新注入 electronAPI（拿 runtime token/port），一次性注入
  // 升级为持久接管，必须在 main 层掐断。放行集合 = vite dev server（dev）或
  // file://<appPath>（prod/E2E loadFile 自源）；in-page/hash 导航不触发本事件。
  win.webContents.on('will-navigate', (event) => {
    if (!isAllowedAppNavigation(event.url, { devOrigin: VITE_DEV_URL, fileRoot: app.getAppPath() })) {
      event.preventDefault()
      console.warn(`[window] blocked navigation to non-app origin: ${event.url}`)
    }
  })
  // window.open / target=_blank / shift+click 一律不建新窗口（默认 deny）；
  // http(s) 链接经 isValidExternalUrl（与 open-external IPC 同一道校验）转系统浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isValidExternalUrl(url)) {
      void shell.openExternal(url).catch((err) => {
        console.error('[window] openExternal for window.open failed:', err)
      })
    }
    return { action: 'deny' }
  })

  win.once('ready-to-show', () => {
    // 不抢前台焦点的两类场景都走 showInactive（窗口渲染但不激活，macOS 下 Playwright
    // Electron 不支持 headless，showInactive 是不抢焦点的唯一干净方案——见
    // browser-automation skill 对策 2）：
    //   - XYZ_E2E=1：E2E 构建产物形态
    //   - XYZ_DEV_BACKGROUND=1：AI agent 真机验收的 dev 实例（C-dev-01，多 agent 并行
    //     dev 时不得打断用户前台工作）
    if (process.env.XYZ_E2E === '1' || process.env.XYZ_DEV_BACKGROUND === '1') {
      win.showInactive()
    } else {
      win.show()
    }
  })

  // W7 加载失败 / 渲染进程崩溃监听（webContents 创建后立即挂，覆盖 loadFile/loadURL 全过程）：
  //   - did-fail-load：loadURL/loadFile 失败（如 Vite 重启中、构建产物损坏）。打 error 日志。
  //   - render-process-gone：渲染进程崩溃（OOM / 崩溃）。详情经 main-logger 落盘
  //     （crash-resilience G5：reason/exitCode/窗口标识/时间戳）+ 自动恢复链（D2-③）：
  //     非 destroyed 窗口经熔断计数（recovery-policy，60s 滑窗 ≤3 次按窗口隔离）决策
  //     自动 reload 或静态错误页。此处不持有 windowManager 引用，windows Map 的清理
  //     仍由 win 'closed' 事件（window-manager.register 已绑定）兜底。
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error(
      `[window] did-fail-load: windowId=${windowId} url=${validatedURL} ` +
        `code=${errorCode} desc=${errorDescription}`,
    )
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    // clean-exit = 正常退出路径（非崩溃，如 window.close 流程）：不计入 RecoveryPolicy、
    // 不写台账、不 reload——否则污染评估器条件 #9（reload 计数）且与关窗流程存在竞态窗口
    if (details?.reason === 'clean-exit') return
    // 详情落盘（u5a main-logger writer；E3 取证缺口修复：崩溃详情不再只有 dev console 一行）
    mainLogger.error('[window] render-process-gone', {
      windowId,
      reason: details?.reason,
      exitCode: details?.exitCode,
      detectedAt: new Date().toISOString(),
    })
    if (win.isDestroyed()) return
    const action = rendererRecovery.recordCrash(windowId, Date.now())
    if (action === 'reload') {
      // 崩溃台账（crash-forensics D1 renderer 行）：reload 事件，reason 透传 Electron
      // RenderProcessGoneDetails 枚举（'oom' 真实存在——renderer OOM 可与普通崩溃
      // 'crashed' 在台账区分；评估器 #9 数 reload、#10 按 reason 分类）。
      crashJournal.append({ layer: 'renderer', event: 'reload', reason: details?.reason ?? null })
      reloadWindowAfterCrash(win, windowId, options?.sessionId, deps.isDev, details?.reason)
    } else {
      // 熔断转静态页事件（D1 renderer 行「熔断转静态页事件」；挂在 RecoveryPolicy
      // 决策的消费点——recovery-policy 本体保持零 IO 纯逻辑，见其文件头约束）。
      crashJournal.append({ layer: 'renderer', event: 'crash', reason: 'circuit-breaker' })
      showStaticErrorPage(win, windowId, options?.sessionId, deps.isDev)
    }
  })
  // 窗口关闭清熔断计数：windowId 条目不残留（长寿 main 进程 Map 泄漏防护）
  win.once('closed', () => {
    rendererRecovery.reset(windowId)
  })

  // renderer 假死台账（crash-forensics D1 renderer 行第三事件：unresponsive）。
  // 卡死是持续状态：记行后置位标记，'responsive'（恢复）复位——同一次持续卡死不
  // 重复记行，卡死↔恢复循环每次各记一行；窗口销毁后监听器与闭包标记随 webContents
  // 一起回收，无清理面。main 侧此前无 webContents unresponsive 处理器（C-proc-12
  // 只覆盖 render-process-gone 崩溃恢复链），本挂点为纯新增，不改变既有行为。
  let unresponsiveJournaled = false
  win.webContents.on('unresponsive', () => {
    if (unresponsiveJournaled) return
    unresponsiveJournaled = true
    crashJournal.append({ layer: 'renderer', event: 'unresponsive', reason: 'renderer-unresponsive' })
  })
  win.webContents.on('responsive', () => {
    unresponsiveJournaled = false
  })

  // Cmd/Ctrl+W 拦截：drawer 打开时优先关 drawer，而非关窗口。
  // before-input-event 在 Electron 默认菜单 accelerator（role:'close'）之前触发，
  // event.preventDefault() 可阻止默认的关窗口行为，让 renderer 决定关 drawer 还是关窗口。
  // renderer 收到 'shortcut' type='close' 后：drawer 开则关 drawer + 回传 consumed，
  // drawer 关则不 consumed（让默认关窗口行为继续）——但 before-input-event 是同步的，
  // 无法等 renderer 异步回传。故此处统一 preventDefault，由 renderer 决定：
  //   - drawer 开 → 关 drawer（不关窗口）
  //   - drawer 关 → 调 windowClose() IPC 主动关窗口
  // 跨平台：mac=metaKey(w)，win/linux=controlKey(w)。CmdOrCtrl 在 before-input-event 里
  // 需手动判断（event.input.modifiers 含 'control' 或 'meta'）。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key.toLowerCase() === 'w' && (input.control || input.meta)) {
      event.preventDefault()
      if (!win.isDestroyed()) {
        win.webContents.send('shortcut', 'close')
      }
    }
  })

  await loadWindowContent(win, windowId, options, deps)

  return { win, windowId }
}
