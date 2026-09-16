/**
 * Main 进程类型契约源（source of truth）。
 *
 * 职责：
 * - 定义各子系统的 Facade 接口（DI 契约），gateway 依赖接口而非具体类
 * - 定义 MainContext：main.ts 持有的全局状态容器
 *
 * 依赖规则（spec §4.2 Main 内部依赖图）：
 * - gateway/ 只 import interfaces（不 import 具体类）
 * - 子模块不反向 import Facade
 * - main.ts 不直接调子模块（经 Facade）
 * - 渲染进程对 preload 的 type-only 依赖不经过此文件
 *
 * @see docs/architecture/design.md §4.2 M1–M5
 */
import type { BrowserWindow } from 'electron'
import type { WindowState, LatestReleaseInfo, LaunchResult, UpdateSource } from '@taiji/shared'
import type { BrowserViewManager } from './browser/browser-view-manager.js'
import type { IUpdateOrchestrator } from './update/orchestrator.js'

// ── M3 Process Supervisor ──────────────────────────────────────────

/**
 * Runtime 子进程监管者 Facade。
 *
 * 对应 spec §4.2 M2「Process Supervisor」的 4 个子职责：
 * 端口探测 / spawn·kill / 健康检查 / 端口持久化。
 *
 * [HISTORICAL] 不变量：
 * - `start()` 幂等：已有活进程则复用，不重复 spawn
 * - spawn 用 `process.execPath + ELECTRON_RUN_AS_NODE=1`
 * - stop 先 SIGTERM 等 200ms 再 SIGKILL，杀整棵进程树
 * - SIGTERM 前必须预记录后代 PID（pi PPID 会在 runtime 退出后变 1）
 */
export interface IRuntimeSupervisor {
  /**
   * 启动 runtime（幂等）：找端口 → spawn → 健康检查 → 写端口文件。
   * 已有活进程则复用，返回其端口。
   * @returns 实际监听的端口号
   */
  start(): Promise<number>

  /**
   * 启动 runtime 并把端口通知给渲染进程（消除 main.ts whenReady/activate 重复）。
   * 失败时发 'runtime-error' 事件而非抛出。
   * @returns 实际监听的端口号
   */
  startAndNotify(win: BrowserWindow): Promise<number>

  /**
   * 手动重启 runtime（用户从「runtime 不可用」状态条点击重试时调）。
   * 重置策略计数后走 start()，成功广播 runtime-port，失败广播 runtime-failed。
   * runtime 已存活时幂等（直接广播端口）。
   */
  restartRuntime(): Promise<void>

  /**
   * 停止 runtime 子进程及其整棵进程树（包括 pi），等待退出或超时。
   * @param timeoutMs SIGTERM 后等待 exit 的超时，超时则 SIGKILL 进程树
   */
  stop(timeoutMs?: number): Promise<void>

  /** 当前监听端口（未启动为 null） */
  readonly port: number | null

  /**
   * 当前 runtime 的 WS auth token（S1-W1，spec §3.3 D4；未启动为 null）。
   * renderer 经 get-runtime-token IPC 读取后作为 WS 首条 auth 消息发送。
   */
  readonly token: string | null

  /** 端口偏移量（dev 模式 +DEV_PORT_OFFSET） */
  readonly portOffset: number
}

// ── M2 Window Manager ──────────────────────────────────────────────

/**
 * 窗口管理器 Facade。
 *
 * 对应 spec §4.2 M3「Window Manager」：窗口注册表 + 跨窗口 session 查询。
 *
 * [HISTORICAL] 不变量：
 * - 单 panel 投影（v2 移除 split 后简化），window-manager 内部构造初始 state
 * - 不直接创建 BrowserWindow（创建由 window-factory 负责）
 */
export interface IWindowManager {
  generateId(): string
  register(windowId: string, win: BrowserWindow): void
  unregister(windowId: string): void
  get(windowId: string): BrowserWindow | undefined
  getAll(): WindowState[]
  focus(windowId: string): void
  close(windowId: string): void
  setOnWindowListChanged(cb: () => void): void
  readonly windowCount: number
}

// ── M5 Shortcut Registry ───────────────────────────────────────────

/**
 * 快捷键注册器 Facade。
 *
 * 对应 spec §4.2 M5：区分全局快捷键与窗口快捷键。
 *
 * [HISTORICAL] 不变量：
 * - globalShortcut.register 对已占用的组合会静默失败 → 注册前判断 globalShortcut.isRegistered（去重）
 * - 全局快捷键注册一次且不绑窗口；窗口快捷键随窗口生灭
 * - unregisterAll 必须幂等
 */
export interface IShortcutRegistry {
  /** 注册全局快捷键（唤起 app 等），通过 win.webContents.send 转发到渲染进程 */
  registerGlobal(win: BrowserWindow): void
  /** 注销所有已注册的快捷键（幂等） */
  unregisterAll(): void
}

// ── MainContext ────────────────────────────────────────────────────

/**
 * Main 进程全局状态容器。
 *
 * 替代 main.ts 历史上散落的 `let mainWindow` / `let settingsWindow` 等模块级全局变量。
 * main.ts 只持有一个 MainContext 实例，所有子系统通过它访问共享状态。
 *
 * 设计目的（spec §4.2 M1「main.ts 是纯编排脚本」）：
 * - main.ts 只做 ① 注册子系统 ② 串联生命周期事件
 * - 具体能力委托给 M2/M3/M4/M5
 */
export interface MainContext {
  /** Runtime 子进程监管者 */
  readonly runtime: IRuntimeSupervisor
  /** 窗口管理器 */
  readonly windows: IWindowManager
  /** 快捷键注册器 */
  readonly shortcuts: IShortcutRegistry
  /** 主窗口（可能被关闭后置 null，activate 时重建） */
  mainWindow: BrowserWindow | null
  /** 是否为开发模式（!app.isPackaged） */
  readonly isDev: boolean
}

/** 创建窗口的工厂签名（window-factory 实现，main.ts/gateway 消费） */
export type CreateWindowFn = (options?: WindowOptions) => Promise<BrowserWindow>

/** 窗口工厂参数 */
export interface WindowOptions {
  windowId?: string
  sessionId?: string
}

// ── Release Checker ────────────────────────────────────────────────

/**
 * Release 检测器 Facade（自动升级检测后端）。
 *
 * 对应 slice auto-update-and-install：按源顺序逐源调 /releases/latest API 检测新版，
 * 三重 prerelease 过滤后用 compare-versions 比较，按平台分流 asset。
 *
 * [HISTORICAL] 不变量：
 * - 失败一律返回 null（不抛、不缓存失败），调用方降级为「无新版」
 * - 1h 缓存命中时直接返回，不再次 fetch
 * - force=true 绕过缓存强制刷新
 * - sha256 优先 asset.digest，缺失时经 manifest.json lazy fallback 回填（仅目标 asset
 *   缺 sha256 时 fetch 一次；GitCode 源 sha256/size 唯一来源为 manifest，
 *   见 docs/design/update-multi-source.md §6.2）
 */
export interface IReleaseChecker {
  /**
   * 检测最新可用版本。
   *
   * @param currentVersion 当前版本号（如 '0.8.14'，无前导 v）
   * @param opts.force 强制刷新缓存
   * @returns 有新版返回 LatestReleaseInfo，无新版/失败返回 null
   */
  checkForLatestRelease(
    currentVersion: string,
    opts?: { force?: boolean },
  ): Promise<LatestReleaseInfo | null>

  /**
   * 按 tag 从指定源精确查询 release（多源改造新增）。
   *
   * 透传式语义：源由调用方显式指定（对侧源推导在 orchestrator——从
   * release.source 取补集），checker 保持无状态透传，不记忆「当前源」，
   * 与 D1 门面定位一致。返回 normalize 后的 release 结构（含 assets）。
   *
   * @param source 查询的来源渠道
   * @param tag 原始 tag（如 'v0.9.14'）
   * @returns 命中返回 release 结构；该源无此 tag 返回 null
   */
  fetchReleaseByTag(source: UpdateSource, tag: string): Promise<LatestReleaseInfo | null>

  /**
   * 限流退避截止时刻（epoch ms，0 = 未限流）。可选：checker 不支持限额语义时不实现。
   *
   * 批次 4 RM2.3 信号透传（2026-08 一致性审查补齐）：update:check handler 在
   * checkForLatestRelease 返回 null 后读此值，区分「确认无新版」与「限额退避中」，
   * 经 UpdateCheckResult.rateLimited 透传给 renderer（显示非侵入提示而非假阴性）。
   */
  getRateLimitedUntil?(): number
}

// ── Gateway 依赖契约 ───────────────────────────────────────────────

/**
 * gateway/ipc-handlers 的依赖注入契约。
 *
 * [HISTORICAL]：原 ipc-handlers.ts:17-26 的 deps 参数是内联匿名类型，
 * 本次重构提升为显式 interface，便于 M4「按特权/桥接分类」审计。
 */
export interface IpcHandlerDeps {
  /** 读取主窗口（供 privileged handler 发送事件） */
  getMainWindow: () => BrowserWindow | null
  /** Runtime 监管者（桥接 handler 读 port/portOffset） */
  runtime: IRuntimeSupervisor
  /** 是否开发模式（决定 createWindow 加载 URL） */
  isDev: boolean
  /** 窗口工厂（privileged handler 创建窗口） */
  createWindow: CreateWindowFn
  /** 窗口管理器（桥接 handler 读窗口状态） */
  windowManager: IWindowManager
  /** Browser view 管理器（drawer 嵌入式浏览器） */
  browserViewManager: BrowserViewManager
  /** Release 检测器（自动升级；可选，未注入时 update:check 返回 null） */
  releaseChecker?: IReleaseChecker
  /** 升级编排器（自动升级执行后端；可选，未注入时 update:download/install 抛错） */
  updateOrchestrator?: IUpdateOrchestrator
  /**
   * 读取启动结果缓存（cleanupCompletedUpdate 的返回值）。
   * renderer 启动时调用一次（update:getLaunchResult），consumed 一次性语义。
   */
  getLaunchResult?: () => Promise<LaunchResult | null>
}
