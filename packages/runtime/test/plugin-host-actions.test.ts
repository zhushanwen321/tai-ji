/**
 * plugin-host-actions 直接单测（provider-plugin-access D8/D9 宿主侧出口族）：此前仅经
 * plugin-service 集成路径间接覆盖（单文件增量 < 60% 触发 file gate），本文件对三动作
 * 逐一直测——deliverUiEventToPlugin 的三分支（插件缺 / worker 缺 / 正常投递）、
 * 事件 id 生成器单调性、openUrlInSystemBrowser 的平台命令分派（execFile mock）。
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-host-actions.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecFile = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

import {
  deliverUiEventToPlugin,
  createPluginEventIdGenerator,
  openUrlInSystemBrowser,
  type UiEventDeliveryDeps,
} from '../src/services/plugin-service/plugin-host-actions.js'
import { PLUGIN_UI_EVENT_NOTIFY } from '../src/services/plugin-service/plugin-rpc-setup.js'

describe('deliverUiEventToPlugin（D8 输入回传投递）', () => {
  let notify: UiEventDeliveryDeps['notify']
  let deps: UiEventDeliveryDeps

  beforeEach(() => {
    notify = vi.fn()
    deps = {
      getDescriptor: vi.fn(() => ({ pluginId: 'p1' } as never)),
      getWorkerHandle: vi.fn(() => ({ workerId: 'w-1' })),
      notify,
    }
  })

  it('插件不存在（已卸载/禁用）→ warn 丢弃，不触 notify', () => {
    deps.getDescriptor = vi.fn(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    deliverUiEventToPlugin(deps, 'p1', 'view', 'comp', 'change', 1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plugin not found: p1'))
    expect(notify).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('worker 不可用 → warn 丢弃，不触 notify', () => {
    deps.getWorkerHandle = vi.fn(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    deliverUiEventToPlugin(deps, 'p1', 'view', 'comp', 'change', 1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('worker not available: p1'))
    expect(notify).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('正常路径 → notify(workerId, plugin.ui.event, { viewId, componentId, event, value })', () => {
    deliverUiEventToPlugin(deps, 'p1', 'view-1', 'comp-1', 'change', 'val')
    expect(deps.getDescriptor).toHaveBeenCalledWith('p1')
    expect(deps.getWorkerHandle).toHaveBeenCalledWith('p1')
    expect(notify).toHaveBeenCalledWith('w-1', PLUGIN_UI_EVENT_NOTIFY, {
      viewId: 'view-1',
      componentId: 'comp-1',
      event: 'change',
      value: 'val',
    })
  })
})

describe('createPluginEventIdGenerator（D9 广播 id）', () => {
  it('同实例单调递增，不同实例互不影响（无同毫秒碰撞）', () => {
    const gen = createPluginEventIdGenerator()
    expect(gen()).toBe('pe_1')
    expect(gen()).toBe('pe_2')
    expect(createPluginEventIdGenerator()()).toBe('pe_1')
  })
})

describe('openUrlInSystemBrowser（D9 宿主出口）', () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  it('execFile 数组参数直传（不经 shell）：平台命令 + [url]，env 走出站契约、10s 超时', () => {
    openUrlInSystemBrowser('https://example.com')
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const [command, args, opts, callback] = mockExecFile.mock.calls[0] as [string, string[], Record<string, unknown>, (e: Error | null) => void]
    expect(args).toEqual(['https://example.com'])
    expect(opts).toMatchObject({ timeout: 10_000 })
    expect(typeof callback).toBe('function')
    // 平台命令按当前进程平台取（darwin=open / win32=rundll32 / 其他=xdg-open）
    const expected = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open'
    expect(command).toBe(expected)
  })

  it('fire-and-forget：execFile 失败仅 warn 留痕不抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    openUrlInSystemBrowser('https://example.com')
    const callback = mockExecFile.mock.calls[0][3] as (e: Error | null) => void
    expect(() => callback(new Error('spawn failed'))).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('openExternal failed'), 'spawn failed')
    warn.mockRestore()
  })
})
