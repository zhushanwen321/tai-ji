/**
 * remote-access 连接信息 IPC 单测（bridge-handlers 域）。
 *
 * 覆盖：
 * - get-remote-access-info：配置 + LAN 候选（端口来自 supervisor 既有端口发现；null → 空列表）
 * - rotate-remote-access-token：轮换重写文件，返回新 token
 * - set-remote-access-enabled：
 *   - 开关状态变化且 runtime 在跑 → 触发 stop + start（既有 supervisor 重启链公开步骤）
 *     并广播 runtime-restarting / runtime-port 到全部窗口
 *   - 开关状态不变 → 不重启（幂等）
 *   - runtime 未跑（port=null，mock 模式）→ 只落盘不重启，下次启动自然生效
 *   - 非 boolean 输入 → 拒绝（isValidRemoteAccessEnabled guard）
 *
 * Mock 策略：mock electron（ipcMain.handle 捕获 handler + BrowserWindow.getAllWindows
 * 广播断言）+ node:os.networkInterfaces（LAN 枚举确定性）；数据目录经
 * TAIJI_AGENT_DATA_DIR 注入 mkdtemp tmp 自建自删（红线：禁触真实数据目录）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/remote-access-handlers.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOTE_ACCESS_FILENAME } from '@taiji/shared'

// electron mock：ipcMain.handle 捕获 handler 供直接调用；getAllWindows 可控
const handlers = new Map<string, (...args: unknown[]) => unknown>()
// 返回类型放宽为 unknown[]：window 桩（makeWindow）作为广播目标注入
const getAllWindowsMock = vi.hoisted(() => vi.fn((): unknown[] => []))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: getAllWindowsMock }),
}))

// networkInterfaces mock（LAN 枚举确定性；homedir 等保留真实实现）
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  networkInterfaces: vi.fn(() => ({
    en0: [
      {
        address: '192.168.1.5',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: false,
        cidr: '192.168.1.5/24',
      },
    ],
  })),
}))

import { registerBridgeHandlers } from '../gateway/bridge-handlers.js'
import type { IpcHandlerDeps } from '../interfaces.js'

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), 'remote-access-handlers-'))
const CONFIG_PATH = join(TMP_DATA_DIR, REMOTE_ACCESS_FILENAME)

function seedConfig(enabled: boolean, token = 'a'.repeat(64)): void {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ enabled, token, createdAt: '2026-01-01T00:00:00.000Z' }),
    'utf-8',
  )
}

function readConfigRaw(): string {
  return readFileSync(CONFIG_PATH, 'utf-8')
}

/** 构造 IpcHandlerDeps（只实现 remote-access 域触达面；其余为 no-op 桩）。 */
function makeDeps(overrides: { port?: number | null } = {}): IpcHandlerDeps {
  return {
    getMainWindow: () => null,
    isDev: true,
    createWindow: (async () => {
      throw new Error('not used')
    }) as unknown as IpcHandlerDeps['createWindow'],
    windowManager: {
      generateId: () => 'win-test',
      register: () => {},
      unregister: () => {},
      get: () => undefined,
      getAll: () => [],
      focus: () => {},
      close: () => {},
      setOnWindowListChanged: () => {},
      windowCount: 0,
    },
    browserViewManager: {} as IpcHandlerDeps['browserViewManager'],
    runtime: {
      port: overrides.port ?? null,
      token: 'spawn-token',
      portOffset: 0,
      start: vi.fn(async () => 43111),
      stop: vi.fn(async () => undefined),
      restartRuntime: vi.fn(async () => undefined),
      startAndNotify: vi.fn(async () => 43111),
    } as unknown as IpcHandlerDeps['runtime'],
  }
}

/** 窗口桩（webContents.send 捕获广播断言）。 */
function makeWindow(): { isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } } {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } }
}

async function loadHandlers(deps: IpcHandlerDeps = makeDeps()): Promise<void> {
  // 动态注册：确保 vi.mock 工厂与 TAIJI_AGENT_DATA_DIR 前置生效后重复注册 handler；
  // handler 闭包捕获传入的 deps——用例须传入自己的 deps 才能断言 supervisor 交互
  registerBridgeHandlers(deps)
}

describe('remote-access 连接信息 IPC', () => {
  beforeEach(async () => {
    // 数据目录钉 env（store 经 getDataDir() 读）；文件在每用例前重写/清除
    process.env.TAIJI_AGENT_DATA_DIR = TMP_DATA_DIR
    rmSync(CONFIG_PATH, { force: true })
    handlers.clear()
    getAllWindowsMock.mockReturnValue([])
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
  })

  afterAll(() => {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('get-remote-access-info：返回配置 + LAN 候选（端口来自 supervisor）', async () => {
    seedConfig(true, 'c'.repeat(64))
    const deps = makeDeps({ port: 3310 })
    await loadHandlers(deps)

    const info = (await handlers.get('get-remote-access-info')!()) as {
      enabled: boolean
      token: string
      createdAt: string
      urls: string[]
    }

    expect(info.enabled).toBe(true)
    expect(info.token).toBe('c'.repeat(64))
    expect(info.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(info.urls).toEqual(['http://192.168.1.5:3310'])
  })

  it('get-remote-access-info：runtime 未启动（port=null）→ urls 空列表', async () => {
    seedConfig(true)
    await loadHandlers(makeDeps({ port: null }))

    const info = (await handlers.get('get-remote-access-info')!()) as { urls: string[] }
    expect(info.urls).toEqual([])
  })

  it('rotate-remote-access-token：重写文件返回新 token，enabled 保留', async () => {
    seedConfig(true, 'd'.repeat(64))
    await loadHandlers(makeDeps({ port: 3310 }))

    const info = (await handlers.get('rotate-remote-access-token')!()) as { token: string; enabled: boolean }

    expect(info.enabled).toBe(true)
    expect(info.token).toMatch(/^[0-9a-f]{64}$/)
    expect(info.token).not.toBe('d'.repeat(64))
    // 落盘与新 token 一致（runtime 下次握手热读生效）
    expect(JSON.parse(readConfigRaw()).token).toBe(info.token)
  })

  it('set-remote-access-enabled：true 且 runtime 在跑 → stop + start + 广播 restarting/port', async () => {
    seedConfig(false)
    const deps = makeDeps({ port: 3310 })
    await loadHandlers(deps)
    const win = makeWindow()
    getAllWindowsMock.mockReturnValue([win])

    const result = (await handlers.get('set-remote-access-enabled')!(undefined, true)) as {
      enabled: boolean
      restarted: boolean
    }

    expect(result.enabled).toBe(true)
    expect(result.restarted).toBe(true)
    expect(deps.runtime.stop).toHaveBeenCalledTimes(1)
    expect(deps.runtime.start).toHaveBeenCalledTimes(1)
    // 广播顺序：先 restarting（进重连等待态）后 port（新端口重连）
    expect(win.webContents.send).toHaveBeenNthCalledWith(1, 'runtime-restarting', { attempt: 0 })
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, 'runtime-port', 43111)
    // 落盘生效
    expect(JSON.parse(readConfigRaw()).enabled).toBe(true)
  })

  it('set-remote-access-enabled：关闭且 runtime 在跑 → 同样触发重启（回纯回环）', async () => {
    seedConfig(true)
    const deps = makeDeps({ port: 3310 })
    await loadHandlers(deps)

    const result = (await handlers.get('set-remote-access-enabled')!(undefined, false)) as { restarted: boolean }

    expect(result.restarted).toBe(true)
    expect(deps.runtime.stop).toHaveBeenCalledTimes(1)
    expect(deps.runtime.start).toHaveBeenCalledTimes(1)
  })

  it('set-remote-access-enabled：状态不变（false→false）→ 不重启', async () => {
    seedConfig(false)
    const deps = makeDeps({ port: 3310 })
    await loadHandlers(deps)

    const result = (await handlers.get('set-remote-access-enabled')!(undefined, false)) as { restarted: boolean }

    expect(result.restarted).toBe(false)
    expect(deps.runtime.stop).not.toHaveBeenCalled()
    expect(deps.runtime.start).not.toHaveBeenCalled()
  })

  it('set-remote-access-enabled：runtime 未跑（port=null）→ 只落盘不重启', async () => {
    seedConfig(false)
    const deps = makeDeps({ port: null })
    await loadHandlers(deps)

    const result = (await handlers.get('set-remote-access-enabled')!(undefined, true)) as { restarted: boolean }

    expect(result.restarted).toBe(false)
    expect(deps.runtime.stop).not.toHaveBeenCalled()
    expect(deps.runtime.start).not.toHaveBeenCalled()
    expect(JSON.parse(readConfigRaw()).enabled).toBe(true)
  })

  it('set-remote-access-enabled：非 boolean 输入 → 抛错且不落盘', async () => {
    seedConfig(false)
    const deps = makeDeps({ port: 3310 })
    await loadHandlers(deps)

    await expect(handlers.get('set-remote-access-enabled')!(undefined, 'true')).rejects.toThrow('must be a boolean')
    await expect(handlers.get('set-remote-access-enabled')!(undefined, 1)).rejects.toThrow('must be a boolean')
    expect(deps.runtime.stop).not.toHaveBeenCalled()
    // 缺文件场景未落盘（guard 在写之前拒绝）
    expect(existsSync(CONFIG_PATH)).toBe(true) // seed 过，未被改写
    expect(JSON.parse(readConfigRaw()).enabled).toBe(false)
  })
})
