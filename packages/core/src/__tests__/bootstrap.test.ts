import { describe, it, expect, vi, beforeEach } from 'vitest'
// namespace import：vi.spyOn(portNs, 'providePlatform') 需 namespace 可写（vitest 支持）。
import * as portNs from '../platform/port'
import {
  bootstrap,
  bootstrapSteps,
  initConnection,
  restoreSessions,
  registerMountPoints,
  scanContributions,
  setExtensionRegistries,
  type BootstrapOptions,
} from '../bootstrap'
import { createFakeWebSocket } from '../transport/__tests__/helpers/fake-websocket'

// initConnection 真实现 import use-connection（连带端口装配依赖链）——模块级拦截为无副作用
// stub。步骤调用面经 bootstrapSteps spy 拦截（下方用例全覆盖），此处 mock 防 spy 未覆盖的
// 调用路径意外触发真实连接编排。
vi.mock('../transport/use-connection', () => ({
  useConnection: () => ({ init: async () => {} }),
}))

// 最小 mock PlatformPort（满足 BootstrapOptions.platform 类型；webSocket stub 返回合法 WebSocketLike）
function makeOptions(): BootstrapOptions {
  return {
    platform: {
      kind: 'mock',
      storage: {
        get: async () => null,
        set: async () => {},
        remove: async () => {},
      },
      webSocket: { create: () => createFakeWebSocket() },
    },
  }
}

describe('AC6: bootstrap 五步显式 await 编排', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('按严格顺序调用 [providePlatform, initConnection, restoreSessions, registerMountPoints, scanContributions]', async () => {
    const callOrder: string[] = []
    vi.spyOn(portNs, 'providePlatform').mockImplementation(() => {
      callOrder.push('providePlatform')
      return Promise.resolve()
    })
    vi.spyOn(bootstrapSteps, 'initConnection').mockImplementation(() => {
      callOrder.push('initConnection')
      return Promise.resolve()
    })
    vi.spyOn(bootstrapSteps, 'restoreSessions').mockImplementation(() => {
      callOrder.push('restoreSessions')
      return Promise.resolve()
    })
    vi.spyOn(bootstrapSteps, 'registerMountPoints').mockImplementation(() => {
      callOrder.push('registerMountPoints')
      return Promise.resolve()
    })
    vi.spyOn(bootstrapSteps, 'scanContributions').mockImplementation(() => {
      callOrder.push('scanContributions')
      return Promise.resolve()
    })

    await bootstrap(makeOptions())

    expect(callOrder).toEqual([
      'providePlatform',
      'initConnection',
      'restoreSessions',
      'registerMountPoints',
      'scanContributions',
    ])
  })
})

describe('ES1: 任一步 reject 中断后续步骤', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // 默认全部 resolve，单个 it 注入 reject
    vi.spyOn(portNs, 'providePlatform').mockResolvedValue(undefined)
    vi.spyOn(bootstrapSteps, 'initConnection').mockResolvedValue(undefined)
    vi.spyOn(bootstrapSteps, 'restoreSessions').mockResolvedValue(undefined)
    vi.spyOn(bootstrapSteps, 'registerMountPoints').mockResolvedValue(undefined)
    vi.spyOn(bootstrapSteps, 'scanContributions').mockResolvedValue(undefined)
  })

  it('providePlatform reject → initConnection 不调用', async () => {
    vi.mocked(portNs.providePlatform).mockRejectedValueOnce(new Error('pp boom'))
    await expect(bootstrap(makeOptions())).rejects.toThrow('pp boom')
    expect(vi.mocked(bootstrapSteps.initConnection)).not.toHaveBeenCalled()
  })

  it('initConnection reject → restoreSessions 不调用', async () => {
    vi.mocked(bootstrapSteps.initConnection).mockRejectedValueOnce(new Error('ic boom'))
    await expect(bootstrap(makeOptions())).rejects.toThrow('ic boom')
    expect(vi.mocked(bootstrapSteps.restoreSessions)).not.toHaveBeenCalled()
  })

  it('restoreSessions reject → registerMountPoints 不调用', async () => {
    vi.mocked(bootstrapSteps.restoreSessions).mockRejectedValueOnce(new Error('rs boom'))
    await expect(bootstrap(makeOptions())).rejects.toThrow('rs boom')
    expect(vi.mocked(bootstrapSteps.registerMountPoints)).not.toHaveBeenCalled()
  })

  it('registerMountPoints reject → scanContributions 不调用', async () => {
    vi.mocked(bootstrapSteps.registerMountPoints).mockRejectedValueOnce(new Error('rmp boom'))
    await expect(bootstrap(makeOptions())).rejects.toThrow('rmp boom')
    expect(vi.mocked(bootstrapSteps.scanContributions)).not.toHaveBeenCalled()
  })
})

// ── 步骤真实现（bootstrap 编排用例全部 spyOn 步骤函数，真函数体未被调用）──────────
// 覆盖 initConnection / restoreSessions / registerMountPoints / scanContributions
// 的真实实现体（注入 registry 后的注册/扫描行为；未注入 warn 降级分支无 unset API，
// 模块级单例注入后不可回退，不强行重建）。
describe('步骤真实现（非 spyOn 路径）', () => {
  it('initConnection 真实现：调 useConnection().init（模块级 mock）', async () => {
    await expect(initConnection()).resolves.toBeUndefined()
  })

  it('restoreSessions 真实现：no-op resolve（R3 减法占位）', async () => {
    await expect(restoreSessions()).resolves.toBeUndefined()
  })

  it('registerMountPoints 注入 registry 后注册 4 个 Tier 1 挂载点', async () => {
    const register = vi.fn()
    setExtensionRegistries({
      mountPoints: { register } as never,
      contributions: { registerBuiltin: vi.fn(), loadExternal: vi.fn() } as never,
    })

    await registerMountPoints()

    expect(register.mock.calls.map((c) => c[0])).toEqual([
      'sidebar.tab',
      'panel.header',
      'composer.toolbar',
      'statusbar',
    ])
  })

  it('scanContributions 注入 registry 后 registerBuiltin + loadExternal([])', async () => {
    const registerBuiltin = vi.fn()
    const loadExternal = vi.fn()
    setExtensionRegistries({
      mountPoints: { register: vi.fn() } as never,
      contributions: { registerBuiltin, loadExternal } as never,
    })

    await scanContributions()

    expect(registerBuiltin).toHaveBeenCalledTimes(1)
    expect(loadExternal).toHaveBeenCalledWith([])
  })
})
