/**
 * Main 进程入口（纯编排脚本）。
 *
 * 对应 spec §4.2 M1「应用生命周期编排」。重构后 main.ts 只做两件事：
 *   ① 注册子系统（构造 MainContext + registerIpcHandlers）
 *   ② 串联 Electron 生命周期事件（whenReady / window-all-closed / activate / before-quit）
 *
 * 所有具体能力委托给 M2/M3/M4/M5。全局状态下沉到 MainContext（替代散落的 let）。
 *
 * [HISTORICAL] 不变量（必须在实现中守护）：
 *
 * 1. EPIPE 兜底：concurrently/终端关闭后 pipe 断开，console 写入触发 uncaught exception
 *    → process.stdout/stderr.on('error', EPIPE → destroy())
 *
 * 2. Dev 模式隔离：
 *    - TAIJI_AGENT_DATA_DIR = resolveDevDataDir(...)（受控采信：外部值仅当解析后
 *      位于 ~/.taiji-dev 树内才采信——装配器 per-worktree 实例目录；其余钉死
 *      ~/.taiji-dev，2026-09-08 泄漏事故防线语义保留）
 *    - TAIJI_AGENT_PORT_OFFSET ?? DEV_PORT_OFFSET（无泄漏风险面，保持兜底语义）
 *    - app.setPath('userData', 隔离目录)  ← 防 Chromium LevelDB LOCK 竞争
 *
 * 3. local-file:// 协议路径白名单 = computeLocalFilePrefixes 纯函数
 *    （app.getAppPath/getDataDir/tmpdir/用户内容子目录 + path.sep 后缀；dev 含 cwd，打包态剔除）
 *
 * 4. Runtime 启动时序（D1 决策）：createWindow 先于 spawn runtime
 *    - whenReady: createWindow → register → registerShortcuts → runtime.startAndNotify
 *    - activate: 同上（window-all-closed 在 macOS 不 stop runtime，activate 复用）
 *
 * 5. before-quit 二段式：event.preventDefault() → stop runtime → app.quit()
 *    （isQuitting flag 防第二次进入死循环）
 *
 * 6. window-all-closed：macOS 不 quit（activate 会复用 runtime），其他平台 stop+quit
 *
 * 生命周期时序：
 * ```
 *   app.whenReady:
 *     1. protocol.handle('local-file', 路径白名单校验)
 *     2. mainWindow = createWindow({windowId:'win-1'})
 *     3. windowManager.register('win-1', mainWindow)
 *     4. shortcutRegistry.registerGlobal(mainWindow)
 *     5. if !mock: runtime.startAndNotify(mainWindow)
 *
 *   app.window-all-closed:
 *     - darwin: 保留（不 quit，activate 复用 runtime）
 *     - 其他:   runtime.stop() → shortcuts.unregisterAll() → app.quit()
 *
 *   app.activate (darwin):
 *     - 若无窗口: 重复 whenReady 的 2-5 步
 *
 *   app.before-quit:
 *     - if isQuitting: 放行
 *     - else: preventDefault → runtime.stop().finally(unregisterAll + quit)
 * ```
 *
 * 依赖方向：main.ts → context + interfaces + gateway + window-factory + 三个 Facade 实现
 */
import path from 'node:path'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { app, protocol, net, BrowserWindow } from 'electron'
import { DEV_PORT_OFFSET } from '@taiji/shared'
import type { CrashJournalWriter, LaunchResult } from '@taiji/shared'
import { RUN_CHECKPOINT_FAILED_PREFIX, RUN_CHECKPOINT_FAILED_RETENTION, getRunStatePaths, getDataDir } from '@taiji/shared/paths'
import { createMainContext } from './context.js'
import type { MainContext } from './interfaces.js'
import { RuntimeSupervisor } from './supervisor/runtime-supervisor.js'
import { WindowManager } from './window/window-manager.js'
import { createWindow } from './window/window-factory.js'
import { ShortcutRegistry } from './shortcuts/shortcut-registry.js'
import { BrowserViewManager } from './browser/browser-view-manager.js'
import { ReleaseChecker } from './release-checker.js'
import { resolveSourceOrder } from './update/source-resolver.js'
import { MockReleaseChecker, DEV_MOCK_UPDATE_ENABLED } from './dev/mock-release-checker.js'
import { updateOrchestrator } from './update/orchestrator.js'
import { maybeRollbackInterruptedUpdate, cleanupCompletedUpdate } from './update/update-self-healer.js'
import { killActiveCurlDownloads } from './update/curl-download.js'
import { registerIpcHandlers } from './gateway/ipc-handlers.js'
import { isPathInAllowedPrefixes } from './gateway/input-validators.js'
import { fixPathEnv } from './supervisor/shell-env.js'
import { flushStderrSink } from './supervisor/process-control.js'
import { initMainLogger, closeMainLogger, mainLogger } from './logs/main-logger.js'
import { initCrashJournal, crashJournal } from './logs/crash-journal.js'
import { startTriggerPatrol } from './diagnostics/trigger-patrol.js'
import { expandLocalFilePath } from './utils/path.js'
import { computeLocalFilePrefixes } from './utils/local-file-prefixes.js'
import { resolveDevDataDir } from './utils/dev-data-dir.js'

// ── PATH 修复（GUI 启动时补全用户级 bin 目录）──────────────────────
// macOS LaunchServices 给 GUI 进程的 PATH 是最小值（/usr/bin:/bin:...），
// 缺 ~/.local/bin、~/.cargo/bin、/opt/homebrew/bin 等。此处从登录 shell 读取
// 完整 PATH 补全，后续 buildSafeEnv 自然传递到 pi，pi 的 bash 工具才能找到 uv 等用户 CLI。
// 必须在 buildSafeEnv / spawn 之前执行。
fixPathEnv()

// ── EPIPE 兜底 ───────────────────────────────────────────────────
// concurrently/终端关闭后 pipe 断开，console 写入触发 uncaught exception
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.stdout.destroy()
})
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.stderr.destroy()
})

// ── 进程级兜底（unhandledRejection / uncaughtException）────────
// [HISTORICAL] E1/W2：main 进程绝不能因一个未捕获异常退出。
// 选择「log + 不 exit」而非 process.exit：
//   - exit 会让 supervisor 启动的 runtime 子进程成孤儿（PPID 变 1），
//     runtime 失去监管继续运行但无人能 stop，资源泄漏更危险
//   - 仅记录日志，状态可能不一致，但靠后续 supervisor/liveness 兜底；
//     日志已落盘供事后诊断。
// 注意：uncaughtException 后 Node 默认行为已改为不退出（Node 15+），
//       此处显式注册仅为统一日志格式、避免 stderr 被默认 handler 抢占。
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err)
  // dev 模式（!app.isPackaged）直接 exit(1) 暴露问题——dev 下没有 supervisor/liveness 兜底，
  // 静默吞会让开发者在不知不觉中带病继续开发。prod 保持「不 exit，靠 supervisor/liveness 兜底」
  // （exit 会让 runtime 子进程成孤儿，资源泄漏更危险）。
  if (!app.isPackaged) process.exit(1)
})

// ── 路径 & 模式 ──────────────────────────────────────────────────
const isDev = !app.isPackaged

// getDataDir（shared SSOT）：读 TAIJI_AGENT_DATA_DIR，缺省 ~/.taiji。
// dev 模式下方块会经 resolveDevDataDir 受控解析（树内采信 / 树外钉死 ~/.taiji-dev）。

// Dev 模式：自动隔离数据目录和端口，防止与 prod 实例冲突。
// TAIJI_AGENT_DATA_DIR 受控采信（R-13 修复）：外部值仅当解析后位于 ~/.taiji-dev
// 目录树内才采信（装配器 dev-instance.mjs 注入的 instances/<worktree> per-worktree
// 实例目录——多 worktree 并行 dev 的数据隔离权威来源）；其余（未设 / 泄漏值如
// ~/.taiji / 任意树外路径）一律钉死回 ~/.taiji-dev，防宿主环境泄漏使 dev 读到
// prod 数据。解析序（e2e 豁免 → 树内采信 → 钉死）与 [HISTORICAL] 事故背景见
// utils/dev-data-dir.ts。
// PORT_OFFSET 无数据泄漏风险面，刻意保留 `??` 外部覆盖语义（不动）。
if (isDev) {
  process.env.TAIJI_AGENT_DATA_DIR = resolveDevDataDir(process.env, homedir())
  process.env.TAIJI_AGENT_PORT_OFFSET = process.env.TAIJI_AGENT_PORT_OFFSET ?? String(DEV_PORT_OFFSET)
  // 隔离 Electron userData，防止与 prod 实例共享 Chromium 存储（LevelDB LOCK 竞争）。
  // 从 TAIJI_AGENT_DATA_DIR 派生（而非硬编码 .taiji-dev）：多 worktree 并行 dev 时
  // 各实例用独立数据目录，userData 隔离随之成立——否则单实例锁互斥导致第二个 dev
  // 实例静默退出（subagent-drawer-blank 设计 §8.2 验收场景实测发现）。
  app.setPath('userData', path.join(process.env.TAIJI_AGENT_DATA_DIR ?? path.join(homedir(), '.taiji-dev'), 'electron'))
}

// ── main 日志落盘（D6-①）────────────────────────
// initMainLogger：建 <dataDir>/logs/ + 启动保留期清理（一次 + 每日复扫定时器）+
// 内存水位定时器（5min）。必须晚于上面 isDev 块的 TAIJI_AGENT_DATA_DIR 隔离
// （getDataDir() 动态推导，dev 实例日志须落 ~/.taiji-dev 而非 prod 目录）；
// 早于一切业务初始化（render-process-gone / 启动期异常的落盘通道先于消费者就绪）。
// writer 未 init 时 no-op，这里失败（磁盘满/权限）不阻断 app 启动。
initMainLogger({ isPackaged: app.isPackaged })

// ── 崩溃台账 writer init（crash-forensics §3.3 D1）────────────────
// main 写 <dataDir>/logs/crashes/main.jsonl（main 自身 + renderer 事件；runtime 侧
// 事件也经本文件写入——main 侧事件接线单元 u1f 的挂点在 supervisor/window-factory）。
// initMainLogger 之后（同读 getDataDir() 动态推导）+ 早于一切业务挂接；纯惰性 IO
// 零副作用，未 init 时各挂点 append 为 no-op（writer 契约）。
initCrashJournal()

// ── 单实例锁（integrity-hardening §3.2 D2d）───────────────────────
// 双开 = 两个实例并发 spawn runtime、并发读写同一数据目录，会命中「pi session 文件
// EEXIST 永久卡死」历史事故区（AGENTS.md 规则 6）。锁必须晚于上面 isDev 块的
// app.setPath('userData')：Electron 单实例锁按 userData 路径区分，dev 隔离目录
// 让 dev 实例与 prod 实例互不误伤。第二实例 app.quit() 后模块级代码仍会同步执行
// （quit 流程触发 before-quit，其清理链对未启动状态幂等），whenReady guard
// 阻止其创建窗口 / spawn runtime。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

// ── run 目录运行态：marker + checkpoint 常量（D1 marker 行 / D3）──────────────
// 常量必须在下方启动块求值之前初始化（模块级 const 无提升）；落点 `<dataDir>/run/`，
// run 目录文件名族 SSOT = @taiji/shared/paths RUN_* 常量族（【oe-audit C8】：原
// 此处与 runtime-checkpoint.ts / export-diagnostic-bundle.ts 三处手抄字面量收敛为单点，
// 「双胞胎显式对齐」的漂移面构造性消失）。
/** 本进程是否已为陈旧 checkpoint 记过 reattach-skipped（D3：重复失败不重复记事件）。 */
let staleCheckpointReported = false

// ── main 存活 marker + checkpoint 冷启动判定（crash-forensics D1 marker 行 / D3）──
// marker 语义 = 「main 存活」：启动写（本块）、正常退出清（will-quit）、下次启动发现残留
// 即上次 unclean（补记 layer=main/event=crash/reason=unclean-exit）。同一份设施两个消费者：
// ① main 自身崩溃自记（D1 防漏设计②）；② checkpoint 冷启动可信度判定（D3：unclean 才可信）。
// 三步顺序不可换：消费上次残留（读旧 marker）→ 判 checkpoint 可信度 → 写本实例 marker
// （先写后消费会把本实例的 marker 当残留消费掉）。
// 只在获锁实例执行：第二实例（未获锁）随后经 will-quit 清 marker——若它也写，会抹掉正在
// 运行的主实例的存活标记（marker 语义 = 主实例存活，不是「某个 main 进程启动过」）。
const runStatePaths = resolveRunStatePaths()
if (gotSingleInstanceLock) {
  // ① 上次残留一次性消费：unclean = 上次 main 未走完退出链（kill -9 / 崩溃 / 断电）
  const unclean = consumeResidualRunMarker(runStatePaths, crashJournal)
  // ② checkpoint 可信度判定（D3 真值表）：clean exit 但 checkpoint 残留（删除被 killed
  //    短路跳过 / 删除失败）→ 忽略 + 隔离残留（重命名进失败现场家族）+ 记 reattach-skipped，
  //    冷启动维持 lazy（不 eager spawn，A3b 反向验收语义）。unclean → 可信，留给随后启动的
  //    runtime 的 reattach 编排（u5）消费，本块零动作。
  if (resolveColdStartTrust({
    unclean,
    checkpointExists: existsSync(runStatePaths.checkpointPath),
  }) === 'stale-residual') {
    isolateStaleCheckpoint(runStatePaths, crashJournal)
  }
  // ③ 写本实例存活 marker（覆盖式：本实例是唯一主实例，旧残留已在 ① 消费）
  writeRunningMarker(runStatePaths)
}

// ── 全局状态容器 ─────────────────────────────────────────────────
// 构造三个 Facade + MainContext（替代旧代码散落的 let mainWindow / let settingsWindow）
const runtime = new RuntimeSupervisor()
const windows = new WindowManager()
const shortcuts = new ShortcutRegistry()
const ctx: MainContext = createMainContext({ runtime, windows, shortcuts, isDev })
/**
 * 启动结果缓存（D5 决策）：cleanupCompletedUpdate 返回的终态上下文，
 * renderer 启动时通过 update:getLaunchResult 一次性读取后清空（consumed 语义）。
 * 生命周期 = 进程内一次性（app 不重启则不再重复 toast）。
 */
let launchResultCache: LaunchResult | null = null
// Browser drawer 的 WebContentsView 管理器（依赖 windows Facade 取窗口引用）。
// W2：注入 onStateChange 回调，webContents 事件触发时把 state 推给主窗口 renderer（BrowserPane），
// 用于地址栏回填真实 URL（防钓鱼）+ loading/error 态切换。win 在 ctx.mainWindow 设置后才有值，
// 故此处读 ctx.mainWindow（bootstrap 后非 null）。
const browserViewManager = new BrowserViewManager(windows, (sid, state) => {
  const win = ctx.mainWindow
  if (win && !win.isDestroyed()) {
    win.webContents.send('browser:state', { sessionId: sid, ...state })
  }
})

/** createWindow 适配器：把 ctx.windows.generateId 注入 window-factory */
const createWindowFn = (options?: { windowId?: string; sessionId?: string }) =>
  createWindow(options, { isDev, generateId: () => ctx.windows.generateId() })
    .then(({ win }) => win)

// ── 注册 IPC ─────────────────────────────────────────────────────
// Release 检测器（自动升级检测后端）：多源逐源检查（update-multi-source §4.2①-⑥）
// dev mock 注入（TAIJI_DEV_MOCK_UPDATE=1）：P2 半 E2E 验证用。
// 返回伪造 LatestReleaseInfo，让前端 UpdateButton 显示「可升级」态供 Playwright 截图。
// isDev && 双重保护：prod 构建即使环境变量被误设也永不实例化 mock（MockReleaseChecker 永不实例化）。
const releaseChecker = isDev && DEV_MOCK_UPDATE_ENABLED
  ? new MockReleaseChecker()
  : new ReleaseChecker({ resolveSourceOrder })
registerIpcHandlers({
  getMainWindow: () => ctx.mainWindow,
  runtime: ctx.runtime,
  isDev,
  createWindow: createWindowFn,
  windowManager: ctx.windows,
  browserViewManager,
  releaseChecker,
  updateOrchestrator,
  getLaunchResult: async () => {
    const result = launchResultCache
    launchResultCache = null // consumed 一次性
    return result
  },
})

// ── App 生命周期编排 ─────────────────────────────────────────────

// D2d：主实例收到 second-instance（Windows/Linux 双击图标再次启动；macOS `open -n`）
// 时聚焦既有主窗口——用户意图是「把 app 带到前台」而非开新实例。
if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    const win = ctx.mainWindow
    if (win && !win.isDestroyed()) {
      // 最小化（Windows 常见）先还原再聚焦，Electron 官方 second-instance 模板语义
      if (win.isMinimized()) win.restore()
      win.focus()
      return
    }
    // macOS 窗口全关但 app 存活的边角（open -n 触发）：重建主窗口，对齐 activate 行为
    if (BrowserWindow.getAllWindows().length === 0) {
      void bootstrapMainWindow()
    }
  })
}

/**
 * 初始化主窗口 + 快捷键 + runtime（mock 模式跳过 runtime）。
 * whenReady 和 activate 共用此逻辑（消除重复）。
 */
async function bootstrapMainWindow(): Promise<void> {
  // bootstrap 也走 generateId() 并用返回值注册，避免与后续 renderer 调 create-window IPC
  // 时 generateId() 首返值 'win-1' 冲突导致 Map 覆盖、跟踪条目丢失。
  const windowId = ctx.windows.generateId()
  const win = await createWindowFn({ windowId })
  win.on('closed', () => { ctx.mainWindow = null })
  ctx.mainWindow = win
  ctx.windows.register(windowId, win)

  // 注册全局快捷键
  shortcuts.registerGlobal(win)

  // 启动 runtime（mock 模式跳过）
  if (process.env.TAIJI_MOCK === '1') {
    console.log('[main] Mock mode — skipping runtime start')
  } else {
    await ctx.runtime.startAndNotify(win)
  }
}

app.whenReady().then(async () => {
  // D2d 第二实例退出路径：app.quit() 已在模块加载期触发，不再初始化任何子系统
  if (!gotSingleInstanceLock) return
  // dev 模式 Dock 图标：未打包的 Electron 运行时用内置默认图标（蓝色 Electron logo），
  // 不读 electron-builder 的 build/icon.*（那只在打包产物生效）。macOS dock 图标跟随
  // app bundle——dev 无 bundle，必须显式 setIcon 才有新 LOGO（双鱼太极）。
  // 打包版无需此调用：bundle 的 Info.plist + Contents/Resources/icon.icns 自动生效。
  //
  // 跳过条件：dev-electron.mjs 已用自制 Taiji.app bundle（改了 Info.plist 的
  // CFBundleIconFile）启动，dock 启动即显示太极图标，无需再 setIcon（且避免重设闪烁）。
  // 此时 main 进程会收到 TAIJI_DEV_BUNDLE_ICON=1 环境变量。fallback 到默认 electron 时
  // 无此变量，走 setIcon 兜底（会闪但至少有图标）。
  if (isDev && process.platform === 'darwin' && !process.env.TAIJI_DEV_BUNDLE_ICON) {
    const dockIcon = path.join(app.getAppPath(), 'build', 'icon-1024.png')
    if (existsSync(dockIcon)) {
      app.dock?.setIcon(dockIcon)
    }
  }
  // dev 实例 Dock 角标：与 prod 并存时一眼可辨（app.dock 非 mac 为 undefined）
  if (isDev) app.dock?.setBadge('dev')
  // 注册 local-file:// 协议，用于渲染进程加载本地文件（如图片）
  protocol.handle('local-file', (request) => {
    const rawPath = decodeURIComponent(new URL(request.url).pathname)
    // 渲染进程无法安全展开 ~，主进程统一处理（图片 URL 可能含 ~/）
    const filePath = expandLocalFilePath(rawPath)
    // [HISTORICAL] W3 → D2a：白名单构造收敛到 computeLocalFilePrefixes 纯函数。
    // 打包态剔除 process.cwd()——macOS 打包版从 Finder/Dock 启动时 cwd 是 /，
    // 前缀匹配 startsWith('/') 对任意绝对路径恒真，白名单塌缩为全盘，「绝不放行
    // ~ 本身（含 ~/.ssh）」的注释护栏曾被该运行时环境击穿。不变量守护已移到单测：
    // main/test/local-file-prefixes.test.ts（打包态不含文件系统根 / 不含 homedir 本身）。
    // 各成员的取舍理由见 utils/local-file-prefixes.ts 文件头。
    // projectRoot：仅 dev + dev-instance.mjs 装配器注入 TAIJI_DEV_PROJECT_ROOT 时生效
    // （dev 装配的 electron cwd/appPath 都指向 apps/electron，白名单需要 worktree 根
    // 成员才能放行 session cwd 下的用户文件）。打包态 env 不会被装配器注入，isDev
    // 判断再显式防一层泄漏（isPackaged 时不传）。
    const allowedPrefixes = computeLocalFilePrefixes({
      isPackaged: app.isPackaged,
      cwd: process.cwd(),
      appPath: app.getAppPath(),
      dataDir: getDataDir(),
      tmpdir: tmpdir(),
      ...(isDev && process.env.TAIJI_DEV_PROJECT_ROOT
        ? { projectRoot: process.env.TAIJI_DEV_PROJECT_ROOT }
        : {}),
    })
    const resolved = path.resolve(filePath)
    // 校验逻辑集中到 input-validators，拒绝不在白名单前缀内的路径（防目录穿越）
    if (!isPathInAllowedPrefixes(resolved, allowedPrefixes)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(`file://${resolved}`)
  })

  // W3：启动自愈——检测上次中断的升级并回滚，必须在 bootstrapMainWindow 之前
  // （确保 .app bundle 已恢复到可用态再创建窗口，避免加载半截 app 崩溃）
  await maybeRollbackInterruptedUpdate()

  // 清理已完成/失败的升级产物（done/failed/rolled-back/no-op 终态）：删除残留的 170MB zip、
  // preloaded/pending 元信息、updater 脚本日志等，避免磁盘占用与下次启动误恢复「已下载」态。
  // 必须在 maybeRollbackInterruptedUpdate 之后（replacing 回滚完成转入终态后再清理）。
  // 返回值缓存供 renderer 启动时通过 update:getLaunchResult 一次性读取（D5 决策：
  // invoke 有构造性送达保证，consumed 标志由 main 单点保证去重）。
  launchResultCache = await cleanupCompletedUpdate()

  await bootstrapMainWindow()

  // u2（crash-forensics D2 出口①）：触发条件每日巡检（启动评估一次 + 24h 间隔，
  // log-retention 同款形态）——任一条件越线 → main 日志 WARN + 台账 trigger-review 事件
  startTriggerPatrol()
})

/**
 * 本实例是否已在 before-quit **之外**发起过 runtime 终止（非 darwin window-all-closed 腿）。
 *
 * 用途 = checkpoint 删除属主的「成功段」判据之一（D3 删除实现语义钉死）：window-all-closed
 * 先调 stop() 使 child.killed 置位，随后 before-quit 的第二次 stop() 在 `child.killed`
 * 检查处**立即 resolve 而不等真退出**（killed 短路）——此时删 checkpoint 是在 runtime 可能
 * 仍在写盘的窗口里动手，必须跳过（残留交下次启动「clean exit 但残留」分支隔离兜底）。
 */
let runtimeStopInitiatedOutsideAppExit = false

app.on('window-all-closed', () => {
  // macOS 保留 runtime：activate 会复用它，避免不必要的重启
  if (process.platform !== 'darwin') {
    runtimeStopInitiatedOutsideAppExit = true
    void ctx.runtime.stop()
    shortcuts.unregisterAll()
    app.quit()
  }
})

// macOS: 点击 dock 图标时重建窗口
app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await bootstrapMainWindow()
  }
})

let isQuitting = false
// 应用退出前清理：确保 runtime 子进程完全退出再 quit。
// async handler：Electron 支持 event.preventDefault() + 异步操作 + 延迟 app.quit()。
// 必须等 flushStderrSink 的 'finish' 事件（WriteStream 落盘完成）再 quit，否则丢尾部 stderr。
app.on('before-quit', (event) => {
  if (isQuitting) return // 第二次进入（app.quit() 触发），放行
  isQuitting = true
  // 崩溃台账 before-quit 上下文（crash-forensics D1 shutdown 行）：app 级正常退出
  // 的 shutdown 行在此写，runtime 随后的 exit 落 supervisor stopping 早退分支零写入
  // （stopping 被 stop() 全部调用方置位，按 stopping 写行会把正常退出记假事件——
  // 判别式详见 classifyRuntimeExit）。markAppQuitting 无条件（退出上下文是事实）；
  // shutdown 行仅在 runtime 子进程在场时写——mock 模式 / 已崩溃 / 第二实例等形态
  // runtime 并未发生「关闭」，写行即假事件。
  runtime.markAppQuitting()
  if (runtime.isRunning) {
    crashJournal.append({ layer: 'runtime', event: 'shutdown', reason: 'planned' })
  }
  // checkpoint 删除属主（D3 契约 1「删除属主双轨」的 main 侧）：**必须挂在本 handler 的
  // 专属 await 链成功段**，不得挂 stop() 内部——stop() 被 liveness 假死强杀共用（那里删
  // 会把该保留的恢复依据删掉）。成功段判据 = 本 handler 是 runtime 终止的唯一发起者
  // （runtimeStopInitiatedOutsideAppExit 为假，排除 window-all-closed 的 killed 短路）
  // 且 child 在场（isRunning，mock 模式 / 已崩死 / 第二实例形态无「关闭」可确认）。
  const ownsRuntimeShutdown = runtime.isRunning && !runtimeStopInitiatedOutsideAppExit
  // D6：curl 子进程非 detached，退出前同步清杀防孤儿进程继续占用带宽
  // （无活跃下载时 no-op；半下载产物由 .downloading 后缀 + sha256 校验兜底）
  killActiveCurlDownloads()
  event.preventDefault()
  // W-Proc2 + W2：runtime stop 已 end() stderrSink；此处 flush 等 'finish' 落盘后再 quit。
  // stop() 路径未触发（runtime 自然退出）时此 flush 是落盘的唯一保障。
  void ctx.runtime.stop()
    .then(() => {
      // 成功段第一步：stop() resolve（runtime child 已确认退出）后删 checkpoint——app 级
      // 正常退出不留恢复依据（A3b：clean shutdown 冷启动零 eager spawn + checkpoint 不存在）。
      // stop() reject / killed 短路（ownsRuntimeShutdown 为假）→ 跳过，残留交下次启动
      // 「clean exit 但残留」分支隔离（不冒险在 runtime 可能仍写盘的窗口里删文件）。
      if (!ownsRuntimeShutdown) return
      removeRuntimeCheckpoint(runStatePaths)
    })
    .then(() => flushStderrSink())
    .then(() => closeMainLogger()) // flush main 日志写流（writer 缓冲尾部落盘后再 quit）
    .finally(() => {
      shortcuts.unregisterAll()
      app.quit()
    })
})

// marker 清除与 checkpoint 删除**解耦**（D3 / marker 生命周期契约）：marker 语义 = 「main
// 存活」，清除挂 will-quit 且与 stop() 成败无关——否则非 darwin 的 killed 短路会同时跳过
// marker 清除与 checkpoint 删除，下次启动「marker 残留」误判 unclean 走 eager 恢复
// （违反 A3b）。清除属主 = 获锁的主实例（第二实例不写不清，防抹掉主实例标记）。
app.on('will-quit', () => {
  if (gotSingleInstanceLock) clearRunningMarker(runStatePaths)
})

// ─────────────────────────────────────────────────────────────────────────────
// run 目录运行态设施：main 存活 marker + runtime checkpoint 属主（D1 marker 行 / D3）
// ─────────────────────────────────────────────────────────────────────────────
// 常量与状态在文件上半部（启动块求值前初始化——模块级 const/let 无提升）；
// 此处为类型与函数（函数声明有提升，位置无关）。

/** run 目录三个权威路径（注入 dataDir 供测试指定 tmp 目录）。 */
export interface RunStatePaths {
  runDir: string
  markerPath: string
  checkpointPath: string
}

/** 解析 run 目录路径组（缺省 getDataDir() 动态推导）。【oe-audit C8】委托 shared getRunStatePaths 单点。 */
export function resolveRunStatePaths(dataDir: string = getDataDir()): RunStatePaths {
  return getRunStatePaths(dataDir)
}

/**
 * 写本实例的「main 存活」marker（启动序列：单实例锁判定后、旧残留消费之后）。
 * 内容 = pid + 时刻（纯诊断辅助，判定只看存在性）。写失败 best-effort（marker 是旁路
 * 取证设施，磁盘满/权限不得阻断 app 启动）。
 */
export function writeRunningMarker(paths: RunStatePaths): void {
  try {
    mkdirSync(paths.runDir, { recursive: true })
    writeFileSync(paths.markerPath, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8')
  } catch (e: unknown) {
    mainLogger.warn(`[main] running marker write failed (${paths.markerPath}): ${errorText(e)}`)
  }
}

/** 清「main 存活」marker（will-quit 调用）。best-effort：残留由下次启动按 unclean 消费。 */
export function clearRunningMarker(paths: RunStatePaths): void {
  try {
    rmSync(paths.markerPath, { force: true })
  // eslint-disable-next-line taste/no-silent-catch -- ENOENT（force 已覆盖）之外的删除失败不阻断退出链；残留由下次启动消费
  } catch {
    // no-op
  }
}

/**
 * 一次性消费上次运行的 marker 残留（启动序列最早处调用，写本实例 marker 之前）。
 *
 * 残留 ⟺ 上次 main 未走完退出链（will-quit 未执行）：kill -9 / 崩溃 / 断电。命中即补记
 * `layer=main, event=crash, reason=unclean-exit`（unclean-exit 是 reason 值不是 event 值，
 * D1 v8 枚举裁决）并清除残留。
 *
 * 顺序 = 先记后删：记完崩掉最多产生重复 crash 行（可数偏多，可人工归因），删完崩掉则
 * 该次崩溃永久无台账（归因不可恢复）——宁可多记不可丢失（D1「不知道 ≠ 没打点」同向）。
 *
 * @returns true = 上次 unclean（checkpoint 因此可信，D3 冷启动判定输入）
 */
export function consumeResidualRunMarker(paths: RunStatePaths, journal: CrashJournalWriter): boolean {
  if (!existsSync(paths.markerPath)) return false
  journal.append({ layer: 'main', event: 'crash', reason: 'unclean-exit' })
  clearRunningMarker(paths)
  return true
}

/** 冷启动可信度（D3 真值表；消费方 = 本文件启动块的 stale-residual 分支）。 */
export type ColdStartTrust =
  /** 无 checkpoint 残留：无需判定（clean exit 已删 / 首次启动）。 */
  | 'no-checkpoint'
  /** marker 残留（上次 unclean）→ checkpoint 可信，留给新 runtime 的 reattach 编排消费。 */
  | 'trusted-unclean'
  /** clean exit 但 checkpoint 残留 → 忽略 + 隔离 + 记 reattach-skipped（冷启动维持 lazy）。 */
  | 'stale-residual'

/**
 * checkpoint 冷启动可信度纯函数（D3）：**只有 unclean 才可信**——clean exit 之后仍有
 * checkpoint 残留说明删除被短路跳过或失败，其清单可能与用户已删除的 session 误配对，
 * 必须忽略并隔离（文件存在就可能被后续真 unclean 误配对复活旧 session，D3 隔离裁决）。
 */
export function resolveColdStartTrust(input: { unclean: boolean; checkpointExists: boolean }): ColdStartTrust {
  if (!input.checkpointExists) return 'no-checkpoint'
  return input.unclean ? 'trusted-unclean' : 'stale-residual'
}

/** 残留隔离结果（与 runtime 侧同名语义：ENOENT = 已隔离；EACCES 等 = 原地残留静默）。 */
export type CheckpointIsolationOutcome = 'isolated' | 'already-absent' | 'residual'

/**
 * 隔离陈旧 checkpoint（D3 clean-exit 残留分支）：重命名进失败现场家族（保留最近 N 份）
 * + 记一条 `reattach-skipped`（语义 = 「本次冷启动忽略了这份残留、不恢复」——与 rename
 * 成败无关：rename 失败原地残留同样不恢复、同样要留痕）。
 *
 * rename 幂等（同域失败声明）：ENOENT = 并发删除路径已处理（视为已隔离，仍补记事件
 * 除非本进程已记过）；EACCES 等 = rename 与 unlink 同域失败，接受**原地残留**，静默
 * 不重试不升级——收敛双通道 = 下次启动重试隔离 + 后续真 unclean 崩溃的覆写接管。
 */
export function isolateStaleCheckpoint(
  paths: RunStatePaths,
  journal: CrashJournalWriter,
  now: number = Date.now(),
): CheckpointIsolationOutcome {
  const target = path.join(paths.runDir, `${RUN_CHECKPOINT_FAILED_PREFIX}${formatRunTimestamp(now)}.json`)
  let outcome: CheckpointIsolationOutcome
  try {
    renameSync(paths.checkpointPath, target)
    outcome = 'isolated'
  } catch (e: unknown) {
    outcome = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'already-absent' : 'residual'
  }
  if (outcome === 'isolated') pruneFailedCheckpoints(paths.runDir)
  if (!staleCheckpointReported) {
    staleCheckpointReported = true
    journal.append({
      layer: 'main',
      event: 'reattach-skipped',
      reason: 'stale-checkpoint-after-clean-exit',
      detailDigest: `previous run exited cleanly but left a checkpoint; ignored (isolation=${outcome})`,
      detailPath: paths.checkpointPath,
    })
  }
  return outcome
}

/**
 * 删除 checkpoint 主文件（D3 契约 1 的 main 侧属主入口）。
 *
 * **只在 before-quit 专属 await 链成功段调用**（stop() resolve 且 runtime child 已确认退出）。
 * runtime 自身任何退出路径都不删（SIGINT/SIGTERM/uncaughtException 三源共用 shutdown 序、
 * app 级退出与 liveness 强杀共用 supervisor 同一停止链 → 「app 级识别信号」不存在）。
 *
 * @returns true = 确实删除；false = 文件不存在或删除失败（残留交下次启动隔离兜底）
 */
export function removeRuntimeCheckpoint(paths: RunStatePaths): boolean {
  try {
    unlinkSync(paths.checkpointPath)
    return true
  } catch {
    return false
  }
}

/** 失败现场裁剪：保留最近 N 份（文件名 ts 定宽 ISO，字典序 = 时间序，从头删多余份数）。 */
function pruneFailedCheckpoints(runDir: string): void {
  let names: string[]
  try {
    names = readdirSync(runDir).filter((n) => n.startsWith(RUN_CHECKPOINT_FAILED_PREFIX))
  } catch {
    return // 目录不可读（权限）→ 不裁剪（隔离自身已 best-effort）
  }
  names.sort()
  for (let i = 0; i < names.length - RUN_CHECKPOINT_FAILED_RETENTION; i++) {
    try {
      rmSync(path.join(runDir, names[i]!), { force: true })
    // eslint-disable-next-line taste/no-silent-catch -- 裁剪是卫生动作，单份删除失败不改变隔离主结果
    } catch {
      // no-op
    }
  }
}

/** 文件名安全的时间戳（固定宽度 ISO，跨平台无 `:`/`.`；与 runtime 侧 formatTimestamp 同形）。 */
function formatRunTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[:.]/g, '-')
}

/** 错误文本归一（日志用；非 Error 抛出物不吞）。 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
