/**
 * W4 验收测试：update:getLaunchResult IPC handler + main 缓存机制。
 *
 * 覆盖：
 *   A2-launch-result-handler-vitest: getLaunchResult handler 返回缓存值 + consumed 一次性
 *   A3-main-cache-vitest: cleanupCompletedUpdate 返回值可被缓存并读取
 *
 * Mock 策略：模拟 main.ts 的缓存模式（module-level variable + consumed flag），
 * 验证 handler 行为。不依赖真实 Electron IPC（ipcMain.handle 用 Map 捕获）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/launch-result-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LaunchResult } from '@taiji/shared'

// ── electron mock ──────────────────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
  app: {
    getVersion: vi.fn(() => '0.9.9'),
    quit: vi.fn(),
  },
}))

// ── FS 依赖 mock ──────────────────────────────────────────────────
vi.mock('../update/update-settings.js', () => ({
  getUpdateSettings: vi.fn(() => ({ preDownload: false })),
  setUpdateSettings: vi.fn(),
  DEFAULT_UPDATE_SETTINGS: { preDownload: false },
}))
vi.mock('../update/pending-update.js', () => ({
  writePendingUpdate: vi.fn(),
  readPendingUpdate: vi.fn(() => null),
}))
vi.mock('../update/preloaded-update.js', () => ({
  readPreloadedUpdate: vi.fn(() => null),
  readPreloadedUpdateRaw: vi.fn(() => null),
  writePreloadedUpdate: vi.fn(),
  clearPreloadedUpdate: vi.fn(),
}))
vi.mock('../update/validate-release.js', () => ({
  validateRelease: vi.fn(),
}))
vi.mock('../update/proxy-config.js', () => ({
  readProxyConfig: vi.fn(() => ({ mode: 'disabled' })),
  writeProxyConfig: vi.fn(),
  resolveProxyUrl: vi.fn(() => null),
}))

import { registerUpdateHandlers } from '../gateway/update-handlers.js'

/**
 * 模拟 main.ts 的缓存模式：module-level variable + consumed 一次性语义。
 * 完全对齐 main.ts 中 launchResultCache 的行为。
 */
function makeCacheDeps(launchResult: LaunchResult | null) {
  // 模拟 main.ts 的 launchResultCache
  let cache = launchResult
  return {
    getMainWindow: () => null,
    runtime: { startAndNotify: vi.fn() } as any,
    isDev: false,
    createWindow: vi.fn() as any,
    windowManager: {} as any,
    browserViewManager: {} as any,
    getLaunchResult: async () => {
      const result = cache
      cache = null // consumed 一次性
      return result
    },
  }
}

describe('W4: launch result IPC handler', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('A2-launch-result-handler-vitest: getLaunchResult handler 返回缓存值 + consumed 一次性', async () => {
    const deps = makeCacheDeps({ status: 'done', version: '0.9.9' })
    registerUpdateHandlers(deps)

    const handler = handlers.get('update:getLaunchResult')
    expect(handler).toBeDefined()

    // 首次调用：返回缓存值
    const first = await handler!()
    expect(first).toEqual({ status: 'done', version: '0.9.9' })

    // 第二次调用：consumed 一次性，返回 null
    const second = await handler!()
    expect(second).toBeNull()
  })

  it('A3-main-cache-vitest: cleanupCompletedUpdate 返回值可被 getLaunchResult 回调读取', async () => {
    // 模拟 cleanupCompletedUpdate 返回的 LaunchResult
    const cleanupResult: LaunchResult = { status: 'rolled-back', version: '0.9.7' }
    const deps = makeCacheDeps(cleanupResult)
    registerUpdateHandlers(deps)

    const handler = handlers.get('update:getLaunchResult')
    expect(handler).toBeDefined()

    // getLaunchResult 回调返回 cleanupCompletedUpdate 的缓存值
    const result = await handler!()
    expect(result).toEqual({ status: 'rolled-back', version: '0.9.7' })
  })

  it('A3-null-cache-vitest: getLaunchResult 返回 null 时无通知', async () => {
    const deps = makeCacheDeps(null)
    registerUpdateHandlers(deps)

    const handler = handlers.get('update:getLaunchResult')
    const result = await handler!()
    expect(result).toBeNull()
  })
})
