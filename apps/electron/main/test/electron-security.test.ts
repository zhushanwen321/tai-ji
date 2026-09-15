/**
 * Electron 安全守卫源码断言（integrity-hardening §3.2 D2b 导航拦截 / D2d 单实例锁）。
 *
 * 挂载行为需要 electron 运行时（vitest 无法实例化 BrowserWindow），改用源码断言
 * （window-factory.test.ts 同款 readFileSync 模式）：断言守卫代码存在且关键语义
 * （preventDefault / deny / quit）不被后续改动静默移除。判定逻辑本身可测的部分
 * 在纯函数单测：input-validators.test.ts（isAllowedAppNavigation）、
 * local-file-prefixes.test.ts（computeLocalFilePrefixes）。
 *
 * 覆盖：
 *  - window-factory.ts：主窗口 will-navigate 拦截 + setWindowOpenHandler 默认 deny
 *  - browser-view-manager.ts：嵌入 view setWindowOpenHandler（导航三层校验之外的新窗口分支）
 *  - main.ts：requestSingleInstanceLock 失败即 quit + second-instance 聚焦主窗口
 *
 * 运行：cd apps/electron/main && npx vitest run test/electron-security.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const readSource = (relPath: string): string =>
  readFileSync(new URL(relPath, import.meta.url), 'utf-8')

const windowFactorySource = readSource('../window/window-factory.ts')
const browserViewManagerSource = readSource('../browser/browser-view-manager.ts')
const mainSource = readSource('../main.ts')

describe('D2b: window-factory 主窗口导航拦截', () => {
  it('挂 will-navigate：非应用自身源 preventDefault', () => {
    expect(windowFactorySource).toContain("win.webContents.on('will-navigate'")
    expect(windowFactorySource).toContain('isAllowedAppNavigation(event.url')
    expect(windowFactorySource).toContain('event.preventDefault()')
  })

  it('挂 setWindowOpenHandler：默认 deny，http/https 经白名单转系统浏览器', () => {
    expect(windowFactorySource).toContain('win.webContents.setWindowOpenHandler')
    expect(windowFactorySource).toContain('isValidExternalUrl(url)')
    expect(windowFactorySource).toContain('shell.openExternal(url)')
    expect(windowFactorySource).toContain("{ action: 'deny' }")
  })
})

describe('D2b: browser-view-manager 嵌入 view 新窗口分支', () => {
  it('挂 setWindowOpenHandler：默认 deny，http/https 经白名单转系统浏览器', () => {
    expect(browserViewManagerSource).toContain('view.webContents.setWindowOpenHandler')
    expect(browserViewManagerSource).toContain('isValidExternalUrl(url)')
    expect(browserViewManagerSource).toContain('shell.openExternal(url)')
    expect(browserViewManagerSource).toContain("{ action: 'deny' }")
  })
})

describe('D2d: main 入口单实例锁', () => {
  it('requestSingleInstanceLock 失败即 app.quit()', () => {
    expect(mainSource).toContain('app.requestSingleInstanceLock()')
    expect(mainSource).toContain('gotSingleInstanceLock')
    // 第二实例退出路径：whenReady 内不再初始化子系统
    expect(mainSource).toContain('if (!gotSingleInstanceLock) return')
  })

  it('second-instance 聚焦既有主窗口（restore + focus），无窗口时重建', () => {
    expect(mainSource).toContain("'second-instance'")
    expect(mainSource).toContain('win.isMinimized()')
    expect(mainSource).toContain('win.restore()')
    expect(mainSource).toContain('win.focus()')
    expect(mainSource).toContain('bootstrapMainWindow()')
  })
})
