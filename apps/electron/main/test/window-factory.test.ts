/**
 * window-factory 窗口级拓扑配置源码断言（review MF-5）。
 *
 * D-6 拓扑回填的窗口级配置（BrowserWindow options）零单测，且创建 BrowserWindow
 * 需要 electron 运行时（vitest 无法实例化）。改用源码断言（fork-keymap.test.ts 同款
 * readFileSync 模式）：断言配置常量存在且数值正确，防止回填被后续改动静默退化。
 *
 * 覆盖：
 *  - title：prod 'TaiJi' / dev 'TaiJi dev'（dev 实例区分，见 window-factory createWindow）
 *  - mac titleBarStyle 'hidden' + trafficLightPosition {x:8,y:8}（红黄绿原生左上角，
 *    圆点中线 ≈y15.75，与 AppNavControls / PanelHeader 22px 行共线对齐——刻意调整形态，非 v6 demo）
 *  - win/linux frame:false（renderer TrafficLight 自绘圆点 mimic mac）
 *
 * 运行：cd apps/electron/main && npx vitest run test/window-factory.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

// ── showInactive env 矩阵（S10：mock BrowserWindow 运行时行为断言）────────
// 源码断言（下方）验证配置文本存在；本组用 runtime mock 验证行为：
// TAIJI_E2E=1 / TAIJI_DEV_BACKGROUND=1 → showInactive（不抢前台焦点）；均未置 → show。
const { showSpy, showInactiveSpy, captureOnce } = vi.hoisted(() => ({
  showSpy: vi.fn(),
  showInactiveSpy: vi.fn(),
  // 按事件名捕获：merge 后 window-factory 还有 once('closed')（crash-resilience 的
  // windows Map 清理钩）注册在 ready-to-show 之后，单一 cb 槽会被覆盖——S10 必须取
  // ready-to-show 自己的回调，不能拿“最后一个 once”。
  captureOnce: { cbs: {} as Record<string, () => void> },
}))

vi.mock('electron', () => {
  class MockBrowserWindow {
    show = showSpy
    showInactive = showInactiveSpy
    on = vi.fn()
    once = (event: string, cb: () => void) => { captureOnce.cbs[event] = cb }
    isDestroyed = () => false
    destroy = vi.fn()
    loadFile = vi.fn().mockResolvedValue(undefined)
    loadURL = vi.fn()
    setWindowOpenHandler = vi.fn()
    webContents = { on: vi.fn(), send: vi.fn(), openDevTools: vi.fn(), setWindowOpenHandler: vi.fn() }
  }
  return {
    app: { getAppPath: () => '/mock-app-root' },
    shell: { openExternal: vi.fn() },
    BrowserWindow: MockBrowserWindow,
  }
})

const { createWindow } = await import('../window/window-factory.ts')

const sourcePath = new URL('../window/window-factory.ts', import.meta.url)
const source = readFileSync(sourcePath, 'utf-8')

describe('window-factory: D-6 窗口级拓扑配置', () => {
  it('title：prod 为 TaiJi，dev 为 TaiJi dev（dev 实例区分）', () => {
    expect(source).toContain("title: deps.isDev ? 'TaiJi dev' : 'TaiJi'")
  })

  it('mac：titleBarStyle hidden + trafficLightPosition {x:8,y:8}（红黄绿与 22px header 行共线）', () => {
    expect(source).toContain("titleBarStyle: 'hidden' as const")
    expect(source).toContain('trafficLightPosition: { x: 8, y: 8 }')
  })

  it('win/linux：frame:false（renderer TrafficLight 自绘圆点 mimic mac）', () => {
    expect(source).toContain(': { frame: false }')
  })
})

describe('window-factory: ready-to-show 焦点策略 env 矩阵（S10）', () => {
  beforeEach(() => {
    showSpy.mockClear()
    showInactiveSpy.mockClear()
    captureOnce.cbs = {}
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function createAndFireReadyToShow() {
    const { win } = await createWindow(undefined, { isDev: false, generateId: () => 'w-test' })
    const readyToShow = captureOnce.cbs['ready-to-show']
    expect(readyToShow).toBeTypeOf('function')
    readyToShow!()
    return win
  }

  it('TAIJI_E2E=1 → showInactive（E2E 构建产物形态，不抢焦点）', async () => {
    vi.stubEnv('TAIJI_E2E', '1')
    await createAndFireReadyToShow()
    expect(showInactiveSpy).toHaveBeenCalledTimes(1)
    expect(showSpy).not.toHaveBeenCalled()
  })

  it('TAIJI_DEV_BACKGROUND=1 → showInactive（dev 实例 AI 验收，不抢焦点）', async () => {
    vi.stubEnv('TAIJI_DEV_BACKGROUND', '1')
    await createAndFireReadyToShow()
    expect(showInactiveSpy).toHaveBeenCalledTimes(1)
    expect(showSpy).not.toHaveBeenCalled()
  })

  it('两 env 均未置 → show（前台正常形态）', async () => {
    vi.stubEnv('TAIJI_E2E', '')
    vi.stubEnv('TAIJI_DEV_BACKGROUND', '')
    await createAndFireReadyToShow()
    expect(showSpy).toHaveBeenCalledTimes(1)
    expect(showInactiveSpy).not.toHaveBeenCalled()
  })
})
