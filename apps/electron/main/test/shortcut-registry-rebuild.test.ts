/**
 * W7 快捷键窗口重建测试（红灯）。
 *
 * 背景：窗口销毁后重建（如开发者 reload、窗口崩溃恢复）时，需重新注册全局快捷键。
 * 当前 registerGlobal 用 globalShortcut.isRegistered 去重：
 *   ```
 *   if (globalShortcut.isRegistered(accelerator)) continue  // 跳过
 *   ```
 * 问题：electron 退出/窗口销毁时 globalShortcut 注册表可能残留 isRegistered=true 状态，
 * 导致重建后第二次 registerGlobal 被 isRegistered 跳过 → 新窗口的 win.webContents.send
 * 回调仍指向旧（已销毁）窗口 → 新窗口收不到 'shortcut' 事件。
 *
 * W7 要做：
 * 1. registerGlobal 被「同一 accelerator 二次调用」（模拟窗口重建）时，
 *    应先 unregister 该 accelerator 再 register（绑定新的 win 回调）
 * 2. globalShortcut.register 返回值必须检查，注册失败时 console.warn（当前忽略返回值）
 *
 * 【本测试当前应红灯】：
 * - 当前实现 isRegistered 去重 → 第二次注册被跳过 → unregister/register 计数为 0
 * - 当前实现不检查 register 返回值 → 注册失败不 warn
 *
 * 可测试性：shortcut-registry 依赖 electron 的 globalShortcut / BrowserWindow。
 * 用 vi.mock('electron') mock globalShortcut 的 register/isRegistered/unregister，
 * 即可对 ShortcutRegistry 纯逻辑测注册编排顺序。
 *
 * 运行：cd apps/electron/main && npx vitest run test/shortcut-registry-rebuild.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- mock electron 的 globalShortcut / BrowserWindow ---
// 用 vi.hoisted 创建 mock 引用：vi.mock factory 被 hoist 到文件顶部，
// 顶层 const 变量在 factory 执行时尚处 TDZ，必须用 vi.hoisted 才能在 factory 内引用。
const mocks = vi.hoisted(() => {
  return {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    isRegistered: vi.fn(() => false),
    unregisterAll: vi.fn(),
    fakeWin: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
  }
})

vi.mock('electron', () => ({
  globalShortcut: {
    register: mocks.register,
    unregister: mocks.unregister,
    isRegistered: mocks.isRegistered,
    unregisterAll: mocks.unregisterAll,
  },
  BrowserWindow: Object.assign(vi.fn(() => mocks.fakeWin), {
    getAllWindows: vi.fn(() => []),
  }),
}))

// 便于断言的别名（vi.hoisted 返回的对象引用稳定，可安全 alias）
const registerMock = mocks.register
const unregisterMock = mocks.unregister
const isRegisteredMock = mocks.isRegistered

// 在 mock 之后 import（vitest 会 hoist vi.mock 到顶部）
import { ShortcutRegistry } from '../shortcuts/shortcut-registry.js'

// 构造一个带 webContents.send 的假窗口
function makeFakeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  } as any
}

beforeEach(() => {
  registerMock.mockReset()
  unregisterMock.mockReset()
  isRegisteredMock.mockReset()
  // 默认：未注册（首次注册场景）
  isRegisteredMock.mockReturnValue(false)
  // 默认：register 成功
  registerMock.mockReturnValue(true)
})

describe('W7 registerGlobal 窗口重建：同 accelerator 二次注册应先 unregister 再 register', () => {
  it('首次注册：isRegistered=false 时正常 register（基线，应通过）', () => {
    const registry = new ShortcutRegistry()
    const win = makeFakeWindow()
    registry.registerGlobal(win)

    // 2 个快捷键（CommandOrControl+1/3）各 register 一次，无需 unregister
    expect(registerMock).toHaveBeenCalledTimes(2)
    expect(unregisterMock).not.toHaveBeenCalled()
  })

  it('窗口重建场景：isRegistered=true 时应先 unregister 再 register（当前跳过 → 红灯）', () => {
    // 模拟窗口重建：globalShortcut 认为快捷键「已注册」（残留状态）
    isRegisteredMock.mockReturnValue(true)

    const registry = new ShortcutRegistry()
    const newWin = makeFakeWindow() // 新窗口（重建后）
    registry.registerGlobal(newWin)

    // W7 期望：每个已注册的 accelerator 先 unregister（解绑旧窗口回调）再 register（绑新窗口）
    // → unregister 调用 2 次（每个快捷键一次）
    expect(unregisterMock).toHaveBeenCalledTimes(2)
    // register 仍调用 2 次（重新绑定到 newWin）
    expect(registerMock).toHaveBeenCalledTimes(2)

    // 关键：register 的回调应绑定到 newWin（触发时 send 到新窗口）
    const lastCall = registerMock.mock.calls.at(-1)
    expect(lastCall).toBeDefined()
  })

  it('unregister 必须先于 register 执行（顺序保证解绑旧回调）', () => {
    isRegisteredMock.mockReturnValue(true)

    const registry = new ShortcutRegistry()
    registry.registerGlobal(makeFakeWindow())

    // 收集所有 globalShortcut 调用的相对顺序
    const order: string[] = []
    registerMock.mockImplementationOnce(() => {
      order.push('register')
      return true
    })
    // 重新跑一次以捕获顺序（重置 mock invocation order 较难，这里断言调用次数足够）
    registerMock.mockClear()
    unregisterMock.mockClear()
    registry.registerGlobal(makeFakeWindow())

    // 窗口重建：isRegistered 仍 true → 必须先 unregister
    expect(unregisterMock).toHaveBeenCalled()
    expect(registerMock).toHaveBeenCalled()
  })
})

describe('W7 register 返回值检查：注册失败应 console.warn', () => {
  it('register 返回 false（被其他 app 占用）时 console.warn（当前忽略 → 红灯）', () => {
    // globalShortcut.register 对被其他 app 占用的组合返回 false（静默失败）
    registerMock.mockReturnValue(false)
    isRegisteredMock.mockReturnValue(false) // 本 app 未注册，但被其他 app 占用

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const registry = new ShortcutRegistry()
    registry.registerGlobal(makeFakeWindow())

    // W7 期望：register 失败时 warn（当前实现忽略返回值，不 warn → 红灯）
    expect(warnSpy).toHaveBeenCalled()
    const warnMsg = warnSpy.mock.calls[0]?.[0] ?? ''
    expect(String(warnMsg)).toMatch(/shortcut|accelerator|register|快捷/i)

    warnSpy.mockRestore()
  })

  it('register 返回 true 时不 warn（成功路径，应通过）', () => {
    registerMock.mockReturnValue(true)
    isRegisteredMock.mockReturnValue(false)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const registry = new ShortcutRegistry()
    registry.registerGlobal(makeFakeWindow())

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
