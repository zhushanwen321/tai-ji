// apps/electron/preload/preload.ts
import { contextBridge, ipcRenderer } from 'electron'
import type { LatestReleaseInfo, UpdateStage, UpdateSettings, UpdateErrorPayload, ProxyTestResult, LaunchResult, UpdateCheckResult, UpdateInstallResult, RendererLogPayload, ImageCacheWritePayload, ImageCacheWriteResult, DebugRunLogRetentionResult, DiagnosticExportBundlePayload, DiagnosticExportBundleResult } from '@taiji/shared'
import { RENDERER_LOG, IMAGE_CACHE_WRITE, DEBUG_RUN_LOG_RETENTION, DIAGNOSTICS_EXPORT_BUNDLE } from '@taiji/shared'

export interface ElectronAPI {
  /** 监听 runtime 端口事件 */
  onRuntimePort(callback: (port: number) => void): () => void
  /** 监听 runtime 启动失败事件 */
  onRuntimeError(callback: (error: { message: string }) => void): () => void
  /**
   * 获取最近一次 runtime 启动失败原因（RD-3#2；null = 无已知失败，成功启动后清除）。
   * onRuntimeError 推送可能早于 renderer 订阅安装（boot 竞态，webContents.send 静默丢失），
   * 连接编排 init 时经此拉取兜底——对齐「时序竞争必须主动拉取」既有规则。
   */
  getRuntimeStartError(): Promise<string | null>
  /** 监听 runtime 崩溃后重启中事件（supervisor 正在拉起新实例） */
  onRuntimeRestarting(callback: (payload: { attempt: number }) => void): () => void
  /** 监听 runtime 重启用尽事件（需用户手动重试） */
  onRuntimeFailed(callback: (payload: { attempts: number; message: string }) => void): () => void
  /** 请求手动重启 runtime（用户从「runtime 不可用」状态条点重试触发） */
  restartRuntime(): Promise<void>
  /** 监听快捷键事件（替代 @tauri-apps/api/event 的 listen('shortcut')） */
  onShortcut(callback: (type: string) => void): () => void
  /** 获取 runtime 端口 */
  getRuntimePort(): Promise<number>
  /** 获取 runtime 端口偏移（dev 模式 +100） */
  getRuntimePortOffset(): Promise<number>
  /**
   * 获取当前 runtime 的 WS auth token（S1-W1）：连接 open 后作首条 auth 消息发送。
   * runtime 重启后 token 刷新（supervisor 每次 spawn 重新生成），重连时需重新获取。
   * 未启动（无 IPC / mock）时由调用方兜底 undefined。
   */
  getRuntimeToken(): Promise<string | null>
  // ── 窗口管理 ──────────────────────────────────────────────────
  /** 创建新窗口，可选携带 sessionId 迁移 */
  createWindow(sessionId?: string): Promise<{ windowId: string }>
  /** 获取所有窗口状态列表 */
  getWindows(): Promise<import('@taiji/shared').WindowState[]>
  /** 聚焦指定窗口 */
  focusWindow(windowId: string): Promise<void>
  /** 监听窗口列表变化事件（创建/关闭/更新） */
  onWindowListUpdated(callback: () => void): () => void
  /** 打开目录选择对话框（defaultPath 失效时主进程自动回退到 ~） */
  pickDirectory(options?: { title?: string; defaultPath?: string }): Promise<{
    canceled: boolean
    path: string | null
  }>
  /** 打开文件选择对话框（filters 控制文件类型过滤，defaultPath 失效时主进程自动回退到 ~） */
  pickFile(options?: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<{
    canceled: boolean
    path: string | null
  }>
  /** 在默认浏览器中打开外部链接 */
  openExternal(url: string): Promise<void>
  /** 在文件管理器中显示文件（trace MALFORMED 行「打开所在目录」；main 校验绝对路径后
   *  shell.showItemInFolder，返回是否放行） */
  revealInFolder(filePath: string): Promise<boolean>
  /** 监听 macOS 全屏状态变化 */
  onFullscreenChanged(callback: (payload: { isFullscreen: boolean }) => void): () => void
  // ── 窗口控制（win/linux 自绘圆点点击）─────────────────────────
  /** 最小化当前窗口 */
  windowMinimize(): Promise<void>
  /** 最大化/还原切换 */
  windowToggleMaximize(): Promise<void>
  /** 关闭当前窗口 */
  windowClose(): Promise<void>
  // ── Browser drawer（嵌入式浏览器）─────────────────────────────
  /** 创建 WebContentsView 并 attach 到指定窗口（初始隐藏） */
  browserCreate(sessionId: string, windowId: string): Promise<void>
  /** 导航到指定 URL */
  browserNavigate(sessionId: string, url: string): Promise<void>
  /** 隐藏 view（keep-alive，不销毁） */
  browserHide(sessionId: string): Promise<void>
  /** 显示 view（恢复最近 rect） */
  browserShow(sessionId: string): Promise<void>
  /** 切换可见 view 到指定 session（Wave 4：隐藏其他可见 view，显示 target；用于切 session 时 swap） */
  browserFocus(sessionId: string): Promise<void>
  /** 设置 view 位置/尺寸（CSS px = DIP，不乘 dpr；renderer 经 getBoundingClientRect 推送） */
  browserSetRect(sessionId: string, rect: { x: number; y: number; width: number; height: number }): Promise<void>
  /** 销毁 view（removeChildView + webContents.destroy） */
  browserDestroy(sessionId: string): Promise<void>
  /** 后退（Wave 5 历史；sessionId 不存在或无法后退时无操作） */
  browserBack(sessionId: string): Promise<void>
  /** 前进（Wave 5 历史；sessionId 不存在或无法前进时无操作） */
  browserForward(sessionId: string): Promise<void>
  /** 设置缩放因子（1.0=100%；Wave 5） */
  browserSetZoom(sessionId: string, factor: number): Promise<void>
  /** 读取当前缩放因子（Wave 5；sessionId 不存在返回 1.0） */
  browserGetZoom(sessionId: string): Promise<number>
  /** 读取 WebContentsView 内当前选区文本 + URL（二期扩展点，Wave 6 预留） */
  browserGetSelection(sessionId: string): Promise<{ text: string; url: string }>
  /** 监听 browser 状态变化（url/isLoading/error/canGoBack/canGoForward/zoomFactor，主进程 did-navigate 等事件推送），返回取消订阅函数 */
  onBrowserState(callback: (state: {
    sessionId: string
    currentUrl: string
    isLoading: boolean
    error: { errorCode: number; errorDescription: string; validatedURL: string } | null
    canGoBack: boolean
    canGoForward: boolean
    zoomFactor: number
  }) => void): () => void
  // ── 自动升级检测 ──────────────────────────────────────────────
  /**
   * 检测最新可用版本。
   * @param opts.force 强制刷新缓存（默认走 1h 缓存）
   * @returns UpdateCheckResult：info 为新版信息（无新版/失败/未注入为 null）；
   *   rateLimited=true 表示限额退避中（RM2.3 信号透传，renderer 显示非侵入提示）
   */
  checkForUpdate(opts?: { force?: boolean }): Promise<UpdateCheckResult>
  // ── 自动升级执行（w3）──────────────────────────────────────────
  /**
   * 拆分升级流程的下载阶段：版本解析（main 权威）+ 下载 + 校验 + 写入预下载产物元信息。
   * 下载成功后状态进入 'downloaded'，前端可调 updateInstall 触发安装。
   * @param version 请求的目标版本号（renderer 只传意图，release 数据由 main 权威解析）
   * @returns downloaded=true 表示下载完成
   */
  updateDownload(version: string): Promise<{ downloaded: boolean }>
  /**
   * 拆分升级流程的安装阶段：从预下载产物读取 release + filePath，执行替换 + 触发重启。
   * install 权威源是预下载产物（不信任前端传入的 release，堵装错版本漏洞）。
   * @returns UpdateInstallResult：triggerRestart=true 表示升级已触发、app 即将退出重启；
   *   version 为实装版本（手动认领与后台预下载并发覆写时可能与 UI 确认版本不一致，
   *   renderer 进入 restarting 态前据此对齐 state.latestRelease——update-network-resilience D2）
   */
  updateInstall(): Promise<UpdateInstallResult>
  /**
   * 读取预下载产物信息（供前端判断是否已下载完成）。
   * @returns 有效的 { release, filePath }，无预下载产物/损坏返回 null
   */
  getPreloaded(): Promise<{ release: LatestReleaseInfo; filePath: string } | null>
  /**
   * 读取启动结果（升级成功/失败/回滚通知）。
   * main 侧一次性缓存：首次调用返回结果并清空，后续调用返回 null。
   */
  getLaunchResult(): Promise<LaunchResult | null>
  /** 监听升级进度事件（stage + percent 0-100），返回取消订阅函数 */
  onUpdateProgress(callback: (payload: { stage: UpdateStage; percent: number }) => void): () => void
  /** 监听升级错误事件（stage + message + errorCode + suggestion），返回取消订阅函数 */
  onUpdateError(callback: (payload: UpdateErrorPayload) => void): () => void
  /** 不支持当前平台时，打开备用下载页（release 页面） */
  openUpdateFallbackUrl(url: string): Promise<void>
  /**
   * 打开手动升级产物目录（update-network-resilience D9 设置页手动通道）。
   * main 侧先幂等建目录（用户无需手动创建）再 shell.openPath 打开；打开失败时 reject
   * （Error.message 含 openPath 返回的错误字符串）。
   */
  openUpdateManualDir(): Promise<{ success: boolean }>
  // ── 代理配置 ────────────────────────────────────────────────────
  /** 获取当前代理配置 */
  /**
   * 获取数据目录（~ 缩写展示路径）。dev=~/.taiji-dev，prod=~/.taiji。
   * Settings 强制目录展示动态化用（避免硬编码 ~/.taiji 误导 dev 排查）。
   */
  getDataDir(): Promise<string>
  /**
   * 目录选择 dialog（v2 §3 LoadPaths 注入用）：返回选中目录路径，取消/无聚焦窗口返回 null。
   * 复用 pick-directory handler（dialog.showOpenDialog openDirectory），封装为 string|null 形态
   * 对齐 ui 层 ChooseDirectoryFn 契约（LoadPaths onChooseDirectory 消费）。
   */
  chooseDirectory(): Promise<string | null>
  getProxyConfig(): Promise<import('@taiji/shared').IProxyConfig>
  /** 保存代理配置 */
  setProxyConfig(config: import('@taiji/shared').IProxyConfig): Promise<void>
  /** 测试代理连接 */
  testProxy(config: import('@taiji/shared').IProxyConfig): Promise<ProxyTestResult>
  // ── 升级提醒持久化标志（功能 1：常驻提醒）──────────────────────────
  /**
   * 读取升级提醒持久化标志（app 启动时调用以恢复「可升级」提醒）。
   * @returns 仍有效的 pending release（有新版待升级），无新版/已升级/失败返回 null
   */
  getPendingUpdate(): Promise<LatestReleaseInfo | null>
  // ── 升级设置（功能 2：预下载开关）──────────────────────────────
  /** 读取升级设置（预下载开关等） */
  getUpdateSettings(): Promise<UpdateSettings>
  /** 保存升级设置（局部更新：只传要修改的字段） */
  setUpdateSettings(settings: Partial<UpdateSettings>): Promise<{ success: boolean }>
  // ── 系统提示音（跨平台：mac afplay / linux paplay / win 返 wav base64）──
  /** 列出当前平台可用的系统提示音（existsSync 过滤后的精选清单） */
  listSystemSounds(): Promise<{ platform: string; sounds: Array<{ id: string; name: string }> }>
  /**
   * 播放系统提示音。mac/linux 由 main spawn 命令播放；win 返回 wav base64
   * 由 renderer 用 new Audio() 播（wav 是 Chromium 原生格式）。
   * 失败静默 resolve（提示音失败不阻塞对话流）。
   *
   * @param name 声音 id；不在当前平台精选清单内时，若提供 kind 则回落到平台默认（W3 跨平台失效兜底）
   * @param kind 逻辑分类（成功/失败），用于跨平台失效时回落到对应默认；试听已知声音可不传
   */
  playSystemSound(name: string, kind?: 'success' | 'error'): Promise<{ audioData?: string; mimeType?: string }>
  // ── renderer 错误上报（D2）─────────────────
  /**
   * 上报 renderer 全局错误（三件套：app.config.errorHandler / window error /
   * unhandledrejection 捕获后经此落盘 main 侧 renderer-error-<date>.log）。
   * main 按 windowId 限流（每窗口每分钟 100 条）；windowId 由 main 从 event 权威读取，
   * 不在 payload 内（不信任 renderer 自报）。失败时 invoke reject——调用方（error-reporter）
   * 必须静默消化，日志通道故障不得再炸 renderer。
   */
  reportRendererLog(payload: RendererLogPayload): Promise<void>
  // ── toolResult 图片落盘（D6-⑨ / u7）─────────────────
  /**
   * 委托 main 落盘 toolResult base64 图片（renderer 无 fs）。images 数组序 = 落盘序
   * （hydrate 批量为新→旧，live 单图为单元素）；main 幂等（sha256 命中跳过写）+ 单
   * session 64MB size 帽（超帽即停，quota-full 由 core 编排层记账渲染占位）。
   * 失败/畸形 payload 不 reject（main handler 零抛错，返回逐图 invalid/quota-full 结果）。
   */
  imageCacheWrite(payload: ImageCacheWritePayload): Promise<ImageCacheWriteResult>
  // ── 验收调试口（A9②；无鉴权面，不进产品 UI）─────────────────
  /**
   * 手动触发 main 侧 logs/ 保留期清理扫描一次（runLogRetentionNow，与 main-logger init
   * / 每日定时器同一函数）。**验收调试入口，仅 dev 调试用途，renderer 产品代码不得调用**。
   * 返回本次扫描统计 {scanned, removed}；永不 reject（清理扫描自身零抛错语义）。
   */
  debugRunLogRetention(): Promise<DebugRunLogRetentionResult>
  // ── 诊断包导出（crash-forensics §3.3 D6 / u3a）─────────────────
  /**
   * 导出诊断包：main 先弹保存对话框（用户自选保存位置；payload.defaultPath 为初始目录），
   * 打包双台账 + 日志尾部 + 水位摘录 + 触发状态表 + summary.md 为 zip。永不 reject——
   * 返回三态（exported 携带产物路径与摘要含知情文案 privacyNotice / canceled 用户取消
   * / error 携带具体 errno），调用方（u3b）按 status 分支展示。
   */
  exportDiagnosticBundle(payload?: DiagnosticExportBundlePayload): Promise<DiagnosticExportBundleResult>
}

contextBridge.exposeInMainWorld('electronAPI', {
  onRuntimePort: (callback: (port: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, port: number) => callback(port)
    ipcRenderer.on('runtime-port', handler)
    return () => ipcRenderer.removeListener('runtime-port', handler)
  },
  onRuntimeError: (callback: (error: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: { message: string }) => callback(error)
    ipcRenderer.on('runtime-error', handler)
    return () => ipcRenderer.removeListener('runtime-error', handler)
  },
  // RD-3#2：启动失败真因拉取（boot 竞态兜底，main 侧 get-runtime-start-error 只读 handler）
  getRuntimeStartError: () => ipcRenderer.invoke('get-runtime-start-error'),
  onRuntimeRestarting: (callback: (payload: { attempt: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { attempt: number }) => callback(payload)
    ipcRenderer.on('runtime-restarting', handler)
    return () => ipcRenderer.removeListener('runtime-restarting', handler)
  },
  onRuntimeFailed: (callback: (payload: { attempts: number; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { attempts: number; message: string }) => callback(payload)
    ipcRenderer.on('runtime-failed', handler)
    return () => ipcRenderer.removeListener('runtime-failed', handler)
  },
  restartRuntime: () => ipcRenderer.invoke('runtime-restart'),
  onShortcut: (callback: (type: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, type: string) => callback(type)
    ipcRenderer.on('shortcut', handler)
    return () => ipcRenderer.removeListener('shortcut', handler)
  },
  getRuntimePort: () => ipcRenderer.invoke('get-runtime-port'),
  getRuntimePortOffset: () => ipcRenderer.invoke('get-runtime-port-offset'),
  getRuntimeToken: () => ipcRenderer.invoke('get-runtime-token'),

  // ── 窗口管理 ──────────────────────────────────────────────────
  createWindow: (sessionId?: string) => ipcRenderer.invoke('create-window', { sessionId }),
  getWindows: () => ipcRenderer.invoke('get-windows'),
  focusWindow: (windowId: string) => ipcRenderer.invoke('focus-window', windowId),
  onWindowListUpdated: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('window-list-updated', handler)
    return () => ipcRenderer.removeListener('window-list-updated', handler)
  },
  pickDirectory: (options?: { title?: string; defaultPath?: string }) =>
    ipcRenderer.invoke('pick-directory', options),
  pickFile: (options?: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => ipcRenderer.invoke('pick-file', options),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  revealInFolder: (filePath: string) => ipcRenderer.invoke('reveal-in-folder', filePath),
  onFullscreenChanged: (callback: (payload: { isFullscreen: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { isFullscreen: boolean }) => callback(payload)
    ipcRenderer.on('fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('fullscreen-changed', handler)
  },
  // ── 窗口控制（win/linux 自绘圆点点击）─────────────────────────
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window-toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  // ── Browser drawer（嵌入式浏览器）─────────────────────────────
  browserCreate: (sessionId: string, windowId: string) => ipcRenderer.invoke('browser:create', { sessionId, windowId }),
  browserNavigate: (sessionId: string, url: string) => ipcRenderer.invoke('browser:navigate', { sessionId, url }),
  browserHide: (sessionId: string) => ipcRenderer.invoke('browser:hide', sessionId),
  browserShow: (sessionId: string) => ipcRenderer.invoke('browser:show', sessionId),
  browserFocus: (sessionId: string) => ipcRenderer.invoke('browser:focus', sessionId),
  browserSetRect: (sessionId: string, rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('browser:set-rect', { sessionId, rect }),
  browserDestroy: (sessionId: string) => ipcRenderer.invoke('browser:destroy', sessionId),
  browserBack: (sessionId: string) => ipcRenderer.invoke('browser:back', sessionId),
  browserForward: (sessionId: string) => ipcRenderer.invoke('browser:forward', sessionId),
  browserSetZoom: (sessionId: string, factor: number) => ipcRenderer.invoke('browser:set-zoom', { sessionId, factor }),
  browserGetZoom: (sessionId: string) => ipcRenderer.invoke('browser:get-zoom', sessionId),
  browserGetSelection: (sessionId: string) => ipcRenderer.invoke('browser:get-selection', sessionId),
  onBrowserState: (callback: (state: {
    sessionId: string
    currentUrl: string
    isLoading: boolean
    error: { errorCode: number; errorDescription: string; validatedURL: string } | null
    canGoBack: boolean
    canGoForward: boolean
    zoomFactor: number
  }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: {
      sessionId: string
      currentUrl: string
      isLoading: boolean
      error: { errorCode: number; errorDescription: string; validatedURL: string } | null
      canGoBack: boolean
      canGoForward: boolean
      zoomFactor: number
    }) => callback(state)
    ipcRenderer.on('browser:state', handler)
    return () => ipcRenderer.removeListener('browser:state', handler)
  },
  // ── 自动升级检测 ──────────────────────────────────────────────
  checkForUpdate: (opts?: { force?: boolean }) =>
    ipcRenderer.invoke('update:check', { force: opts?.force }),
  // ── 自动升级执行（w3）──────────────────────────────────────
  updateDownload: (version: string) =>
    ipcRenderer.invoke('update:download', { version }),
  // ── 自动升级拆分流程（download → install）──────────────────────
  updateInstall: () => ipcRenderer.invoke('update:install'),
  getPreloaded: () => ipcRenderer.invoke('update:getPreloaded'),
  getLaunchResult: () => ipcRenderer.invoke('update:getLaunchResult'),
  onUpdateProgress: (callback: (payload: { stage: UpdateStage; percent: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { stage: UpdateStage; percent: number }) => callback(payload)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.removeListener('update:progress', handler)
  },
  onUpdateError: (callback: (payload: UpdateErrorPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: UpdateErrorPayload) => callback(payload)
    ipcRenderer.on('update:error', handler)
    return () => ipcRenderer.removeListener('update:error', handler)
  },
  openUpdateFallbackUrl: (url: string) => ipcRenderer.invoke('open-external', url),
  openUpdateManualDir: () => ipcRenderer.invoke('update:openManualDir'),
  // ── 代理配置 ────────────────────────────────────────────────────
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),
  // v2 §3：chooseDirectory 薄包装 pick-directory handler，返回 path（canceled→null），对齐 ui ChooseDirectoryFn 契约
  chooseDirectory: () =>
    ipcRenderer.invoke('pick-directory').then((r: { canceled: boolean; path: string | null }) => r.path),
  getProxyConfig: () => ipcRenderer.invoke('update:getProxyConfig'),
  setProxyConfig: (config) => ipcRenderer.invoke('update:setProxyConfig', config),
  testProxy: (config) => ipcRenderer.invoke('update:testProxy', config),
  // ── 升级提醒持久化标志 + 升级设置 ────────────────────────────────
  getPendingUpdate: () => ipcRenderer.invoke('update:getPending'),
  getUpdateSettings: () => ipcRenderer.invoke('update:getSettings'),
  setUpdateSettings: (settings: Partial<UpdateSettings>) => ipcRenderer.invoke('update:setSettings', settings),
  // ── 系统提示音 ──────────────────────────────────────────────
  listSystemSounds: () => ipcRenderer.invoke('sound:list'),
  playSystemSound: (name: string, kind?: 'success' | 'error') => ipcRenderer.invoke('sound:play', name, kind),
  // ── renderer 错误上报（D2；通道名经 shared SSOT 常量，禁字面量分叉）──
  reportRendererLog: (payload: RendererLogPayload) => ipcRenderer.invoke(RENDERER_LOG, payload),
  // ── toolResult 图片落盘（D6-⑨；通道名经 shared SSOT 常量）──
  imageCacheWrite: (payload: ImageCacheWritePayload) => ipcRenderer.invoke(IMAGE_CACHE_WRITE, payload),
  // ── 验收调试口（A9②；通道名经 shared SSOT 常量，不进产品 UI）──
  debugRunLogRetention: () => ipcRenderer.invoke(DEBUG_RUN_LOG_RETENTION),
  // ── 诊断包导出（crash-forensics §3.3 D6；通道名经 shared SSOT 常量）──
  exportDiagnosticBundle: (payload?: DiagnosticExportBundlePayload) =>
    ipcRenderer.invoke(DIAGNOSTICS_EXPORT_BUNDLE, payload),
} satisfies ElectronAPI)
