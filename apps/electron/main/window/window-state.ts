/**
 * 窗口尺寸持久化（cross-platform-window-chrome 设计 §6.4，仅非 mac 平台生效——
 * 平台裁剪在调用方 window-factory，本模块自身不判平台）。
 *
 * 职责（impl-plan u-window-state）：
 * - 非 mac 默认尺寸工作区比例取值纯函数（defaultSizeFor / pickInitialSize，可单测）
 * - window-state.json 持久化引擎：字段恰 {width, height, isMaximized}——**不含 x/y**
 *   （位置不持久化，D-1-14 裁决；恢复用 Electron 默认居中 + clamp）
 *
 * 语义（设计 §6.4 逐条）：
 * - 持久化/恢复仅主窗口（bootstrap 创建的窗口挂载；create-window IPC 迁移窗口不挂
 *   监听不恢复）——window-state.json 全局单写者，last-writer-wins 互踩被结构性消除
 * - resize/move 防抖 500ms 合并写；最大化/全屏态事件**跳过**（字段恒记最近一次正常态尺寸）
 * - close **同步 flush**：取消防抖 timer，isMaximized 取退出时刻 win.isMaximized() 实际值
 *   （「最大化→直接关闭」序列必须恢复最大化，否则 flush 落 isMaximized=false 旧值）
 * - 启动读取：文件缺失/损坏/字段非法 → null + warn 日志（调用方回默认尺寸，不阻断启动）
 * - 恢复尺寸 clamp：上限当前屏 workArea（拔外接屏场景）、下限 minWidth/minHeight
 *   （800×600，clamp 实现保证上限优先——工作区比下限还小时不超屏）
 *
 * 写入走仓内 atomicWrite 先例（packages/runtime/src/utils/fs-utils.ts 的 tmp+rename
 * 语义同构实装于此）：main 进程不依赖 runtime 包（依赖方向 main → @taiji/shared，
 * 设计 §7「无新包」核对），原子写是 20 行叶子工具不跨包引依赖。
 *
 * 不 import electron：窗口以 StateTrackedWindow 最小结构接口注入（BrowserWindow
 * 结构子集），单测零 electron mock、零真实窗口。
 * 日志经 deps.logger 注入（生产装配 mainLogger 落盘 <getDataDir()>/logs/，§5.2
 * 失败路径 warn 落 logs；单测注 spy 断言）。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { mainLogger } from '../logs/main-logger.js'

/** window-state.json 持久化字段（恰三件，禁止扩 x/y——D-1-14 裁决） */
export interface WindowState {
  width: number
  height: number
  isMaximized: boolean
}

/** 尺寸二元组（BrowserWindow bounds / workArea 共用形态，均 DIP） */
export interface Size {
  width: number
  height: number
}

/** 非 mac 默认/恢复尺寸下限 = BrowserWindow minWidth/minHeight（既有约束，守住） */
export const WINDOW_MIN_WIDTH = 800
export const WINDOW_MIN_HEIGHT = 600

/**
 * 比例取值 cap（设计 §6.4 cap 取值依据）：
 * - 宽 1440：锚定固定像素侧栏 300px 的密度底线 20%（1440 时约 20.8%）——工作区宽
 *   >≈2323 DIP（如 4K@100%/125%）以上触发；1080p～4K/175% 主路径不触发
 * - 高 960：与现状 800 同比例放大（×1.2），与宽 cap 保持观感一致
 */
const CAP_WIDTH = 1440
const CAP_HEIGHT = 960
const WIDTH_RATIO = 0.62
const HEIGHT_RATIO = 0.75

/** clamp 区间 [lo, hi]；hi < lo 时 hi 优先（屏幕上限压过下限，tiny workArea 不超屏） */
function clampBetween(lo: number, hi: number, value: number): number {
  return Math.min(Math.max(value, lo), hi)
}

/**
 * 非 mac 默认窗口尺寸：主屏工作区比例取值（§6.4 采用项 1）。
 * width = min(1440, round(workArea.width × 0.62))、height = min(960, round(workArea.height × 0.75))，
 * 下限 800×600 守住 minWidth/minHeight。1080p（1920×1040 工作区）≈ 1190×780 ≈ 现状 1200×800。
 */
export function defaultSizeFor(workArea: Size): Size {
  return {
    width: clampBetween(WINDOW_MIN_WIDTH, CAP_WIDTH, Math.round(workArea.width * WIDTH_RATIO)),
    height: clampBetween(WINDOW_MIN_HEIGHT, CAP_HEIGHT, Math.round(workArea.height * HEIGHT_RATIO)),
  }
}

/**
 * 启动初始尺寸决策（§6.4 采用项 2 恢复半边）：有合法持久化态 → clamp 后恢复
 * （上限 workArea、下限 min 尺寸）；无 → 工作区比例默认尺寸。
 * isMaximized 不在此消费——调用方 show 后按其决定 win.maximize()。
 */
export function pickInitialSize(workArea: Size, persisted: WindowState | null): Size {
  if (!persisted) return defaultSizeFor(workArea)
  return {
    width: clampBetween(WINDOW_MIN_WIDTH, workArea.width, Math.round(persisted.width)),
    height: clampBetween(WINDOW_MIN_HEIGHT, workArea.height, Math.round(persisted.height)),
  }
}

/**
 * 持久化引擎感知的最小窗口接口（BrowserWindow 结构子集）。
 * 只取本模块语义所需五员：bounds / 最大化 / 全屏 / 存活 / 事件挂载。
 */
export interface StateTrackedWindow {
  getBounds(): Size
  isMaximized(): boolean
  isFullScreen(): boolean
  isDestroyed(): boolean
  on(event: string, listener: () => void): unknown
  once(event: string, listener: () => void): unknown
}

/** 日志出口（生产装配 mainLogger——落 <getDataDir()>/logs/；单测注 spy） */
export interface WindowStateLogger {
  warn(message: string, meta?: Record<string, unknown>): void
}

/** 防抖窗口（设计定值 500ms）：快速连续 resize/move 合并为一次写 */
export const WINDOW_STATE_DEBOUNCE_MS = 500

/** 持久化文件名（<getDataDir()>/window-state.json） */
export const WINDOW_STATE_FILENAME = 'window-state.json'

export interface WindowStatePersistenceDeps {
  /** 持久化文件绝对路径（生产 = getWindowStateFilePath()；单测 = mkdtemp tmp 路径） */
  statePath: string
  logger: WindowStateLogger
  /** 防抖毫秒（默认 500；单测可注小值，本仓测试用 fake timers 不依赖此项） */
  debounceMs?: number
}

/**
 * window-state.json 持久化引擎（§6.4 采用项 2）。
 *
 * 单实例绑定一个被跟踪窗口（attach 换挂先拆旧：取消防抖 timer + 引用替换）。
 * 挂载方约束 = 仅 bootstrap 主窗口（结构性单写者），见 window-factory 的
 * isMainWindow 门。
 */
export class WindowStatePersistence {
  private readonly statePath: string
  private readonly logger: WindowStateLogger
  private readonly debounceMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 最近一次正常态尺寸（最大化/全屏态事件不更新——字段恒记正常态，§6.4） */
  private lastNormalSize: Size | null = null
  private win: StateTrackedWindow | null = null

  constructor(deps: WindowStatePersistenceDeps) {
    this.statePath = deps.statePath
    this.logger = deps.logger
    this.debounceMs = deps.debounceMs ?? WINDOW_STATE_DEBOUNCE_MS
  }

  /**
   * 启动读取（§6.4 采用项 2 启动半边）：文件缺失（首启常态）/ JSON 损坏 / 字段非法
   * → null + warn（不阻断启动，调用方 pickInitialSize 回默认尺寸）；合法 → 原样返回
   * （clamp 不在此做——需要 workArea，归 pickInitialSize 纯函数）。
   */
  load(): WindowState | null {
    let raw: string
    try {
      raw = readFileSync(this.statePath, 'utf-8')
    } catch (err) {
      this.logger.warn('[window-state] no readable window-state file, using default size', {
        statePath: this.statePath,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (
        parsed === null || typeof parsed !== 'object' ||
        typeof (parsed as Partial<WindowState>).width !== 'number' ||
        !Number.isFinite((parsed as Partial<WindowState>).width) ||
        typeof (parsed as Partial<WindowState>).height !== 'number' ||
        !Number.isFinite((parsed as Partial<WindowState>).height)
      ) {
        throw new Error('invalid window-state fields')
      }
      const state = parsed as Partial<WindowState>
      return { width: state.width as number, height: state.height as number, isMaximized: state.isMaximized === true }
    } catch (err) {
      this.logger.warn('[window-state] corrupt window-state file, discarding and using default size', {
        statePath: this.statePath,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  /**
   * 挂载窗口事件（resize/move → 防抖写；close → 同步 flush；closed → 清理）。
   * attach 时窗口处于创建初始正常态（show:false 创建），lastNormalSize 取当前 bounds。
   * 重复 attach（主窗口重建场景）先拆旧挂载：取消防抖 timer，防旧窗口残留写入。
   */
  attach(win: StateTrackedWindow): void {
    this.detach()
    this.win = win
    this.lastNormalSize = win.getBounds()
    win.on('resize', () => this.handleLayoutEvent())
    win.on('move', () => this.handleLayoutEvent())
    win.on('close', () => this.flushOnClose())
    win.once('closed', () => {
      this.clearTimer()
      if (this.win === win) {
        this.win = null
        this.lastNormalSize = null
      }
    })
  }

  /** 拆除挂载态（取消防抖 timer + 断开窗口引用）；监听器随窗口销毁自然回收 */
  detach(): void {
    this.clearTimer()
    this.win = null
    this.lastNormalSize = null
  }

  /** resize/move 事件入口：最大化/全屏态跳过（无新增尺寸语义，字段恒记正常态） */
  private handleLayoutEvent(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (win.isMaximized() || win.isFullScreen()) return
    this.lastNormalSize = win.getBounds()
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.writeCurrentState()
    }, this.debounceMs)
  }

  /**
   * close 同步 flush（§6.4）：取消防抖 timer + 立即落盘，isMaximized = 退出时刻
   * win.isMaximized() 实际值——「最大化→直接关闭」序列（最大化期间跳过写、无新防抖
   * 数据）必须以当前状态落 isMaximized:true，重启才按正常态尺寸 show 后 maximize；
   * 同时消除 500ms 退出竞态（不等防抖，同步落盘）。
   */
  private flushOnClose(): void {
    this.clearTimer()
    this.writeCurrentState()
  }

  /** 落盘当前窗口态：尺寸 = 最近正常态；isMaximized = 调用时刻 win 实际值 */
  private writeCurrentState(): void {
    const win = this.win
    if (!win || win.isDestroyed() || !this.lastNormalSize) return
    this.writeStateFile({
      width: this.lastNormalSize.width,
      height: this.lastNormalSize.height,
      isMaximized: win.isMaximized(),
    })
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 原子写 + 失败 warn 不抛（§5.2：写失败不影响窗口行为、不阻断关闭流程） */
  private writeStateFile(state: WindowState): void {
    try {
      mkdirSync(path.dirname(this.statePath), { recursive: true })
      atomicWriteFile(this.statePath, JSON.stringify(state))
    } catch (err) {
      this.logger.warn('[window-state] failed to persist window state (non-blocking)', {
        statePath: this.statePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

// ── tmp+rename 原子写（语义对齐 packages/runtime/src/utils/fs-utils.ts atomicWrite）──

/** 进程内 tmp 序号：与 pid 组合保证同进程多次写、跨进程并发写的 tmp 名互不碰撞 */
let tmpSeq = 0

function atomicWriteFile(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp_${process.pid}-${tmpSeq++}`
  try {
    writeFileSync(tmpPath, data, 'utf-8')
    renameSync(tmpPath, filePath)
  } catch (e) {
    try {
      unlinkSync(tmpPath)
    // eslint-disable-next-line taste/no-silent-catch -- 清理失败不掩盖原错误（对齐 runtime fs-utils atomicWrite 同型；残留 tmp 无害）
    } catch {
      // 清理失败不掩盖原错误；残留 tmp 无害
    }
    throw e
  }
}

// ── 生产装配（mainLogger + getDataDir；单测不经过这里，直接 new 注入 tmp 路径）────

/** window-state.json 绝对路径（动态推导，禁硬编码数据目录——AGENTS.md 路径白名单规则） */
export function getWindowStateFilePath(): string {
  return path.join(getDataDir(), WINDOW_STATE_FILENAME)
}

/** 主窗口持久化实例工厂（window-factory 唯一消费：load → createWindow → attach） */
export function createMainWindowStatePersistence(): WindowStatePersistence {
  return new WindowStatePersistence({ statePath: getWindowStateFilePath(), logger: mainLogger })
}
