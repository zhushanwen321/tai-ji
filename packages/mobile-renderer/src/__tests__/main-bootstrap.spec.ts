// main.ts bootstrap 失败兜底呈现（code-harden 观测项 1）：bootstrap 任一环 reject 时
// #app 呈现极简错误信息（重试指引），不白屏、不静默；全局错误留痕监听随 main 装配。
//
// 单独成文件的原因：mobile-shell.spec 的 TC-5 消费真实 bootstrap（注入链路断言），
// vi.mock 是模块级替换，两者不能共存于同一 spec 文件。
//
// 从 vitest 导入（禁 node:test / tsx --test）。运行：npx vitest run。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const bootstrapMock = vi.hoisted(() => vi.fn())

vi.mock('../bootstrap', () => ({ bootstrap: bootstrapMock }))

// 每用例重置模块缓存后动态 import：main.ts 在模块体执行 bootstrap().catch(...) 编排，
// fresh module 求值即驱动每条用例
async function importFreshMain(): Promise<void> {
  vi.resetModules()
  await import('../main')
}

function mountAppContainer(): void {
  const app = document.createElement('div')
  app.id = 'app'
  document.body.appendChild(app)
}

describe('main.ts bootstrap 失败兜底呈现', () => {
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    bootstrapMock.mockReset()
    document.body.innerHTML = ''
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    document.body.innerHTML = ''
    errSpy.mockRestore()
  })

  it('bootstrap reject：#app 写入错误信息 + 刷新重试指引 + 失败详情，console.error 留痕', async () => {
    mountAppContainer()
    bootstrapMock.mockRejectedValueOnce(new Error('initConnection exploded'))
    await importFreshMain()
    await vi.waitFor(() => {
      expect(document.getElementById('app')?.textContent).toContain('应用启动失败')
    })

    const container = document.getElementById('app')
    expect(container).not.toBeNull()
    expect(container!.textContent).toContain('刷新页面重试')
    expect(container!.textContent).toContain('initConnection exploded')
    expect(errSpy).toHaveBeenCalledWith('[mobile-shell] bootstrap failed:', expect.any(Error))
  })

  it('错误详情含 HTML 特殊字符时转义呈现（不注入标记）', async () => {
    mountAppContainer()
    bootstrapMock.mockRejectedValueOnce(new Error('<img src=x onerror=alert(1)>'))
    await importFreshMain()
    await vi.waitFor(() => {
      expect(document.getElementById('app')?.textContent).toContain('应用启动失败')
    })

    const container = document.getElementById('app')!
    // 原文以文本形态在场（转义后），未产生真实 img 元素
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it('bootstrap resolve：#app 保持空，不注入兜底错误信息，无 console.error', async () => {
    mountAppContainer()
    bootstrapMock.mockResolvedValueOnce(undefined)
    await importFreshMain()
    await vi.waitFor(() => {
      expect(bootstrapMock).toHaveBeenCalled()
    })
    expect(document.getElementById('app')!.innerHTML).toBe('')
    expect(errSpy).not.toHaveBeenCalled()
  })
})

// ── 全局错误留痕监听（main.ts 模块体注册的 window 'error' / 'unhandledrejection' 两面）──
// 断言按调用参数不按次数：监听器随每次 fresh import 叠加注册（闭包引用无法 remove），
// 泄漏的旧监听器与本次注册的产出相同参数的调用，次数断言会假红。
describe('main.ts 全局错误留痕监听', () => {
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    bootstrapMock.mockReset()
    document.body.innerHTML = ''
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    document.body.innerHTML = ''
    errSpy.mockRestore()
  })

  it("window 'error' 事件（携带 error/message）→ console.error 以 uncaught error 标记留痕", async () => {
    mountAppContainer()
    bootstrapMock.mockResolvedValue(undefined)
    await importFreshMain()
    errSpy.mockClear()

    const boom = new Error('render exploded')
    window.dispatchEvent(new ErrorEvent('error', { error: boom, message: 'Uncaught Error: render exploded' }))

    expect(errSpy).toHaveBeenCalledWith('[mobile-shell] uncaught error:', boom)
  })

  it("资源加载型 'error' 事件（无 error 无 message）跳过留痕", async () => {
    mountAppContainer()
    bootstrapMock.mockResolvedValue(undefined)
    await importFreshMain()
    errSpy.mockClear()

    window.dispatchEvent(new ErrorEvent('error'))

    expect(errSpy).not.toHaveBeenCalledWith('[mobile-shell] uncaught error:', expect.anything())
    expect(errSpy).not.toHaveBeenCalledWith('[mobile-shell] unhandled rejection:', expect.anything())
  })

  it("'unhandledrejection' 事件 → console.error 以 unhandled rejection 标记留痕 reason", async () => {
    mountAppContainer()
    bootstrapMock.mockResolvedValue(undefined)
    await importFreshMain()
    errSpy.mockClear()

    // happy-dom 无 PromiseRejectionEvent 构造器：监听器只读 e.reason / e.promise，
    // 用 Event + 同形字段派发等价驱动
    const rejection = new Event('unhandledrejection') as Event & {
      promise: Promise<unknown>
      reason: unknown
    }
    rejection.promise = Promise.resolve()
    rejection.reason = 'socket closed'
    window.dispatchEvent(rejection)

    expect(errSpy).toHaveBeenCalledWith('[mobile-shell] unhandled rejection:', 'socket closed')
  })
})
