/**
 * MainContext：Main 进程全局状态容器。
 *
 * 持有 runtime/windows/shortcuts 三个 Facade + mainWindow 引用。
 * main.ts 构造后注入给 gateway，gateway 经接口访问，不反向引用具体类。
 *
 * 依赖方向：main.ts → context.ts → interfaces.ts（type-only）
 *
 * @see docs/architecture/design.md §4.2 M1（main.ts 是纯编排脚本）
 */
import type { BrowserWindow } from 'electron'
import type { MainContext, IRuntimeSupervisor, IWindowManager, IShortcutRegistry } from './interfaces.js'

/**
 * 构造 MainContext。
 *
 * 三个子系统 Facade 由各自模块构造后传入，context 只负责聚合持有。
 * mainWindow 初始为 null，由 main.ts 在生命周期事件中赋值。
 *
 * @param params.subsystems 已构造好的三个 Facade 实例
 * @param params.isDev 是否开发模式
 */
export function createMainContext(params: {
  runtime: IRuntimeSupervisor
  windows: IWindowManager
  shortcuts: IShortcutRegistry
  isDev: boolean
}): MainContext {
  const { runtime, windows, shortcuts, isDev } = params
  // mainWindow 为可变引用，闭包持有；通过返回对象的 getter/setter 访问
  let mainWindow: BrowserWindow | null = null

  return {
    runtime,
    windows,
    shortcuts,
    isDev,
    get mainWindow(): BrowserWindow | null {
      return mainWindow
    },
    set mainWindow(win: BrowserWindow | null) {
      mainWindow = win
    },
  }
}
