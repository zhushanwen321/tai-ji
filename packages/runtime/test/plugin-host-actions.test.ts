/**
 * plugin-host-actions 宿主动作原语直测（provider-plugin-access D8/D9 拆出件；
 * 通道级集成见 plugin-ui-event-channel.test.ts / plugin-openurl-scheme.test.ts）：
 *
 * - deliverUiEventToPlugin 的 Worker 不可用分支（插件在册但 Worker 未起 → warn 丢弃）；
 * - openUrlInSystemBrowser 真出口：execFile mock 捕获（平台命令 + 数组参数不经 shell
 *   + 出站 env + 10s 超时），失败回调 warn 留痕（fire-and-forget）；
 * - createPluginEventIdGenerator 单调计数（同毫秒碰撞面消解）。
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-host-actions.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile as execFileMock } from 'node:child_process'

const execFile = vi.mocked(execFileMock)

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import {
  createPluginEventIdGenerator,
  deliverUiEventToPlugin,
  openUrlInSystemBrowser,
} from '../src/services/plugin-service/plugin-host-actions.js'
import type { UiEventDeliveryDeps } from '../src/services/plugin-service/plugin-host-actions.js'
import { PLUGIN_UI_EVENT_NOTIFY } from '../src/services/plugin-service/plugin-rpc-setup.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'

function makeDeps(overrides: Partial<UiEventDeliveryDeps> = {}): UiEventDeliveryDeps {
  return {
    getDescriptor: (pluginId: string) =>
      pluginId === 'wool-workbuddy' ? ({ pluginId } as PluginDescriptor) : undefined,
    getWorkerHandle: () => ({ workerId: 'w1' }),
    notify: vi.fn(),
    ...overrides,
  }
}

describe('deliverUiEventToPlugin · Worker 不可用分支（D8）', () => {
  it('插件在册但 Worker 未起 → warn 丢弃，不 notify、不崩', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const notify = vi.fn()
      const deps = makeDeps({ getWorkerHandle: () => undefined, notify })
      deliverUiEventToPlugin(deps, 'wool-workbuddy', 'v', 'c', 'change', 1)
      expect(notify).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('plugin worker not available: wool-workbuddy'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('正常路径透传字段到 PLUGIN_UI_EVENT_NOTIFY（对照锚：通道级集成外的直测）', () => {
    const notify = vi.fn()
    deliverUiEventToPlugin(makeDeps({ notify }), 'wool-workbuddy', 'authorize-view', 'pat-input', 'change', 'tok')
    expect(notify).toHaveBeenCalledWith('w1', PLUGIN_UI_EVENT_NOTIFY, {
      viewId: 'authorize-view',
      componentId: 'pat-input',
      event: 'change',
      value: 'tok',
    })
  })
})

describe('openUrlInSystemBrowser · 宿主系统浏览器出口（D9）', () => {
  beforeEach(() => {
    execFile.mockReset()
  })
  afterEach(() => {
    execFile.mockReset()
  })

  it('平台打开命令 + URL 数组参数（不经 shell）+ 出站 env + 10s 超时；成功静默', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      openUrlInSystemBrowser('https://auth.example.com/cb')
      expect(execFile).toHaveBeenCalledTimes(1)
      const [command, args, options] = execFile.mock.calls[0] as unknown as [
        string, string[], { env: NodeJS.ProcessEnv; timeout: number },
      ]
      // 平台分支与实现三平台对齐（darwin: open / win32: rundll32 + url.dll 前参 / 其余: xdg-open），
      // 断言按当前运行平台取对应分支——写死 darwin 会在 Linux CI 红（2026-10-29 实发）
      const expectOpen = process.platform === 'win32'
        ? { command: 'rundll32', args: ['url.dll,FileProtocolHandler', 'https://auth.example.com/cb'] }
        : process.platform === 'darwin'
          ? { command: 'open', args: ['https://auth.example.com/cb'] }
          : { command: 'xdg-open', args: ['https://auth.example.com/cb'] }
      expect(command).toBe(expectOpen.command)
      expect(args).toEqual(expectOpen.args)
      expect(options.timeout).toBe(10_000)
      // 出站 env 经 buildOutboundChildEnv（C-proc-09 出站契约）：仍是对象且带 PATH
      expect(options.env).toBeTypeOf('object')
      expect(Object.keys(options.env ?? {}).length).toBeGreaterThan(0)
      // 成功回调：无 warn
      const cb = execFile.mock.calls[0]?.[3] as (err: Error | null) => void
      cb(null)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('打开失败 → warn 留痕（fire-and-forget，尽力动作不抛）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      openUrlInSystemBrowser('https://auth.example.com/cb')
      const cb = execFile.mock.calls[0]?.[3] as (err: Error | null) => void
      cb(new Error('spawn ENOENT'))
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('openExternal failed for https://auth.example.com/cb'),
        'spawn ENOENT',
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('createPluginEventIdGenerator · 广播 id 单调计数（D9）', () => {
  it('同毫秒内多次上报 id 互不相同且单调（pe_1、pe_2、…）', () => {
    const gen = createPluginEventIdGenerator()
    expect([gen(), gen(), gen()]).toEqual(['pe_1', 'pe_2', 'pe_3'])
    // 独立生成器各自计数
    expect(createPluginEventIdGenerator()()).toBe('pe_1')
  })
})
