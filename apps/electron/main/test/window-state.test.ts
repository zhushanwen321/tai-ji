/**
 * window-state 单测（u-window-state，设计 §6.4 + §8.3）。
 *
 * 覆盖两层：
 * - 纯函数期望值表：defaultSizeFor（62%/75% 比例 + cap 1440×960 + 下限 800×600）、
 *   pickInitialSize（恢复 clamp：上限 workArea、下限 min、上限优先）
 * - 持久化语义表（§8.2 S4/S7 的单测化路径）：防抖合并写 / 最大化·全屏态跳过写 /
 *   close flush 取退出时刻实际 isMaximized（最大化→直接关闭序列恢复最大化）/
 *   损坏 JSON → null + warn / 写失败 warn 不阻断
 *
 * 防抖用 vitest fake timers；文件 IO 全部落 mkdtemp 临时目录自建自删（AGENTS.md
 * 测试红线：禁触真实数据目录；本文件挂 vitest guarded 池，fs-guard 切面兜底）。
 * window-state.ts 不 import electron——窗口以 StateTrackedWindow 结构注入，零 electron mock。
 *
 * 运行：cd apps/electron && pnpm run test:main -- window-state
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WINDOW_STATE_FILENAME,
  WindowStatePersistence,
  defaultSizeFor,
  pickInitialSize,
  type Size,
  type StateTrackedWindow,
  type WindowState,
  type WindowStateLogger,
} from '../window/window-state.js'

// ── 夹具：可控假窗口 + logger spy ─────────────────────────────────────

/** 可控假窗口：属性直改（bounds/maximized/fullscreen/destroyed）+ 事件手动 fire */
interface MockWindow extends StateTrackedWindow {
  bounds: Size
  maximized: boolean
  fullscreen: boolean
  destroyed: boolean
  fire(event: 'resize' | 'move' | 'close' | 'closed'): void
}

function createMockWindow(initial?: Partial<Pick<MockWindow, 'bounds' | 'maximized' | 'fullscreen'>>): MockWindow {
  const listeners: Record<string, Array<() => void>> = {}
  const win: MockWindow = {
    bounds: { width: initial?.bounds?.width ?? 1000, height: initial?.bounds?.height ?? 700 },
    maximized: initial?.maximized ?? false,
    fullscreen: initial?.fullscreen ?? false,
    destroyed: false,
    getBounds() { return { ...this.bounds } },
    isMaximized() { return this.maximized },
    isFullScreen() { return this.fullscreen },
    isDestroyed() { return this.destroyed },
    on(event, listener) { (listeners[event] ??= []).push(listener); return win },
    once(event, listener) { (listeners[event] ??= []).push(listener); return win },
    fire(event) {
      for (const listener of listeners[event] ?? []) listener()
    },
  }
  return win
}

function createLoggerSpy(): { logger: WindowStateLogger; warns: Array<{ message: string; meta?: Record<string, unknown> }> } {
  const warns: Array<{ message: string; meta?: Record<string, unknown> }> = []
  return {
    warns,
    logger: {
      warn(message, meta) { warns.push({ message, meta }) },
    },
  }
}

function readWindowStateFile(statePath: string): WindowState {
  return JSON.parse(readFileSync(statePath, 'utf-8')) as WindowState
}

// ── 纯函数：公式期望值表（§8.3：cap 分支由公式单测固化）──────────────────

describe('defaultSizeFor 公式期望值表（§6.4：62%/75%，cap 1440×960，下限 800×600）', () => {
  it('1080p 工作区 1920×1040 → 1190×780（≈现状 1200×800，主路径不触 cap）', () => {
    expect(defaultSizeFor({ width: 1920, height: 1040 })).toEqual({ width: 1190, height: 780 })
  })

  it('4K/175% 工作区 2194×1234 → 1360×926（设计表述 ≈1360×925；round(925.5)=926）', () => {
    expect(defaultSizeFor({ width: 2194, height: 1234 })).toEqual({ width: 1360, height: 926 })
  })

  it('超宽工作区 2560×1400（>≈2323 DIP，如 4K@100%）→ cap 1440×960（300px 侧栏密度底线 20%）', () => {
    expect(defaultSizeFor({ width: 2560, height: 1400 })).toEqual({ width: 1440, height: 960 })
  })

  it('极小工作区 500×400 → 下限 800×600（守住 minWidth/minHeight）', () => {
    expect(defaultSizeFor({ width: 500, height: 400 })).toEqual({ width: 800, height: 600 })
  })
})

describe('pickInitialSize（启动尺寸决策：恢复 clamp / 缺省回公式）', () => {
  const workArea: Size = { width: 1920, height: 1040 }

  it('无持久化态 → 工作区比例默认尺寸（首启路径）', () => {
    expect(pickInitialSize(workArea, null)).toEqual({ width: 1190, height: 780 })
  })

  it('持久化尺寸超当前工作区（拔外接屏换小屏）→ clamp 到 workArea（§5.2 超界路径）', () => {
    expect(pickInitialSize(workArea, { width: 3000, height: 2000, isMaximized: false }))
      .toEqual({ width: 1920, height: 1040 })
  })

  it('持久化尺寸低于下限 → clamp 到 800×600', () => {
    expect(pickInitialSize(workArea, { width: 400, height: 300, isMaximized: false }))
      .toEqual({ width: 800, height: 600 })
  })

  it('工作区比下限还小 → 上限优先（clamp 实现保证不超屏）', () => {
    expect(pickInitialSize({ width: 640, height: 480 }, { width: 3000, height: 2000, isMaximized: true }))
      .toEqual({ width: 640, height: 480 })
  })
})

// ── 持久化语义表（fake timers 管防抖；文件 IO 全落 mkdtemp tmp）──────────────

describe('WindowStatePersistence 持久化语义', () => {
  let dir: string
  let statePath: string
  let loggerSpy: ReturnType<typeof createLoggerSpy>
  let persistence: WindowStatePersistence

  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'taiji-window-state-test-'))
    statePath = join(dir, WINDOW_STATE_FILENAME)
    loggerSpy = createLoggerSpy()
    persistence = new WindowStatePersistence({ statePath, logger: loggerSpy.logger })
  })

  afterEach(() => {
    persistence.detach()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('防抖 500ms 合并写：连续 resize 只落一次盘，内容 = 最近正常态尺寸', () => {
    const win = createMockWindow()
    persistence.attach(win)

    win.bounds = { width: 1100, height: 720 }
    win.fire('resize')
    vi.advanceTimersByTime(200)
    win.bounds = { width: 1200, height: 760 }
    win.fire('resize')
    vi.advanceTimersByTime(400) // 距末次 resize 400ms，防抖未到
    expect(existsSync(statePath)).toBe(false)

    vi.advanceTimersByTime(100)
    expect(readWindowStateFile(statePath)).toEqual({ width: 1200, height: 760, isMaximized: false })
  })

  it('move 事件同样进入防抖写；字段恰三件 {width,height,isMaximized}——不含 x/y（D-1-14）', () => {
    const win = createMockWindow()
    persistence.attach(win)
    win.fire('move')
    vi.advanceTimersByTime(500)

    const state = readWindowStateFile(statePath)
    expect(Object.keys(state).sort()).toEqual(['height', 'isMaximized', 'width'])
    expect(state).toEqual({ width: 1000, height: 700, isMaximized: false })
  })

  it('最大化态的 resize 跳过防抖写：文件保持最近正常态，不被最大化尺寸污染', () => {
    const win = createMockWindow()
    persistence.attach(win)
    win.bounds = { width: 1100, height: 720 }
    win.fire('resize')
    vi.advanceTimersByTime(500)
    expect(readWindowStateFile(statePath)).toEqual({ width: 1100, height: 720, isMaximized: false })

    win.maximized = true
    win.bounds = { width: 1920, height: 1040 }
    win.fire('resize')
    vi.advanceTimersByTime(1000)
    expect(readWindowStateFile(statePath)).toEqual({ width: 1100, height: 720, isMaximized: false })
  })

  it('全屏态的 resize 同样跳过（最大化/全屏一并豁免）', () => {
    const win = createMockWindow()
    persistence.attach(win)
    win.fullscreen = true
    win.bounds = { width: 1920, height: 1040 }
    win.fire('resize')
    vi.advanceTimersByTime(1000)
    expect(existsSync(statePath)).toBe(false)
  })

  it('close 同步 flush：「最大化→直接关闭」序列 → isMaximized 取退出时刻实际值 true，尺寸 = 最近正常态', () => {
    const win = createMockWindow()
    persistence.attach(win)
    win.bounds = { width: 1150, height: 730 }
    win.fire('resize') // 防抖 timer 已排，尚未到 500ms
    win.maximized = true
    win.bounds = { width: 1920, height: 1040 }
    win.fire('resize') // 最大化态：跳过（不重排 timer、不更新 lastNormalSize）
    win.fire('close') // 直接关闭：同步 flush，不等防抖

    expect(readWindowStateFile(statePath)).toEqual({ width: 1150, height: 730, isMaximized: true })
  })

  it('close 同步 flush：正常态关闭 → isMaximized=false；防抖 timer 被取消（不二次写）', () => {
    const win = createMockWindow()
    persistence.attach(win)
    win.bounds = { width: 1150, height: 730 }
    win.fire('resize')
    win.fire('close')

    expect(readWindowStateFile(statePath)).toEqual({ width: 1150, height: 730, isMaximized: false })
    const before = readFileSync(statePath, 'utf-8')
    vi.advanceTimersByTime(1000)
    expect(readFileSync(statePath, 'utf-8')).toBe(before)
  })

  it('窗口销毁后防抖 timer 触发 → 不写（destroyed 守卫，closed 后零写入）', () => {
    const win = createMockWindow()
    persistence.attach(win)
    win.fire('resize')
    win.destroyed = true
    vi.advanceTimersByTime(500)
    expect(existsSync(statePath)).toBe(false)
  })

  it('attach 换挂（主窗口重建场景）→ 旧窗口防抖 timer 取消，仅新窗口态落盘（单写者语义）', () => {
    const w1 = createMockWindow()
    persistence.attach(w1)
    w1.bounds = { width: 1100, height: 720 }
    w1.fire('resize') // w1 的防抖 timer 已排

    const w2 = createMockWindow()
    persistence.attach(w2) // 换挂：清旧 timer + lastNormalSize 重取自 w2
    vi.advanceTimersByTime(1000)
    expect(existsSync(statePath)).toBe(false)

    w2.bounds = { width: 1300, height: 850 }
    w2.fire('resize')
    vi.advanceTimersByTime(500)
    expect(readWindowStateFile(statePath)).toEqual({ width: 1300, height: 850, isMaximized: false })
  })

  it('写入失败（父路径为文件，目录不可建）→ warn 不抛，不阻断调用方（§5.2 失败路径）', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf-8')
    const bad = new WindowStatePersistence({
      statePath: join(blocker, WINDOW_STATE_FILENAME),
      logger: loggerSpy.logger,
    })
    const win = createMockWindow()
    bad.attach(win)
    expect(() => {
      win.fire('resize')
      vi.advanceTimersByTime(500)
    }).not.toThrow()
    expect(loggerSpy.warns.length).toBe(1)
    expect(loggerSpy.warns[0]?.message).toContain('failed to persist window state')
    bad.detach()
  })
})

describe('WindowStatePersistence.load 启动读取校验（§5.2 失败路径）', () => {
  let dir: string
  let statePath: string
  let loggerSpy: ReturnType<typeof createLoggerSpy>
  let persistence: WindowStatePersistence

  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'taiji-window-state-test-'))
    statePath = join(dir, WINDOW_STATE_FILENAME)
    loggerSpy = createLoggerSpy()
    persistence = new WindowStatePersistence({ statePath, logger: loggerSpy.logger })
  })

  afterEach(() => {
    persistence.detach()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('文件缺失（首启常态）→ null + warn，不抛不阻断', () => {
    expect(persistence.load()).toBeNull()
    expect(loggerSpy.warns.length).toBe(1)
    expect(loggerSpy.warns[0]?.message).toContain('no readable window-state file')
  })

  it('损坏 JSON → null + warn（回默认尺寸的决策在调用方 pickInitialSize）', () => {
    writeFileSync(statePath, '{not valid json', 'utf-8')
    expect(persistence.load()).toBeNull()
    expect(loggerSpy.warns.length).toBe(1)
    expect(loggerSpy.warns[0]?.message).toContain('corrupt window-state file')
  })

  it('字段非法（width 非有限数）→ null + warn', () => {
    writeFileSync(statePath, JSON.stringify({ width: 'big', height: 800, isMaximized: false }), 'utf-8')
    expect(persistence.load()).toBeNull()
    expect(loggerSpy.warns.length).toBe(1)
  })

  it('合法 → 原样返回（clamp 归 pickInitialSize；isMaximized 严格 true 判定）', () => {
    writeFileSync(statePath, JSON.stringify({ width: 1360, height: 926, isMaximized: true }), 'utf-8')
    expect(persistence.load()).toEqual({ width: 1360, height: 926, isMaximized: true })
  })

  it('isMaximized 非布尔（缺省/异型）→ 宽容归 false，不拒整个文件', () => {
    writeFileSync(statePath, JSON.stringify({ width: 1200, height: 800 }), 'utf-8')
    expect(persistence.load()).toEqual({ width: 1200, height: 800, isMaximized: false })
  })
})
