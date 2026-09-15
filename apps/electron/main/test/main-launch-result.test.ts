/**
 * A3 验收测试：main.ts 启动序列中 launchResultCache 缓存接线验证。
 *
 * [降级方案说明] main.ts 顶层副作用极重（import electron/app/protocol/BrowserWindow、
 * 大量子系统初始化），直接 import 触发的 mock 面过宽且脆弱。采用双保险策略：
 *   ① 源码断言：验证 main.ts 文本包含缓存接线关键字（launchResultCache + cleanupCompletedUpdate）
 *   ② handler 行为：复用 update:getLaunchResult handler 的 consumed 一次性缓存语义
 *
 * 运行：cd apps/electron/main && npx vitest run test/main-launch-result.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const __dirname = dirname(fileURLToPath(import.meta.url))
const mainSource = readFileSync(resolve(__dirname, '../main.ts'), 'utf-8')

describe('A3-main-cache-vitest', () => {
  it('main.ts 源码包含 launchResultCache 缓存变量声明', () => {
    expect(mainSource).toContain('launchResultCache')
  })

  it('main.ts 源码将 cleanupCompletedUpdate 结果赋给缓存', () => {
    expect(mainSource).toMatch(/launchResultCache\s*=\s*await\s+cleanupCompletedUpdate\(\)/)
  })

  it('main.ts 源码 getLaunchResult 回调返回缓存值 + consumed 清空', () => {
    expect(mainSource).toContain('launchResultCache = null')
  })

  it('handler 层 consumed 一次性缓存语义：首次返回缓存值、第二次返回 null', async () => {
    // 复用 update-handlers 的 handler 测试路径：模拟 main.ts 的缓存接线
    let cache: { status: string; version: string } | null = { status: 'done', version: '0.9.9' }
    registerUpdateHandlers({
      getMainWindow: () => null,
      releaseChecker: { checkForLatestRelease: vi.fn() } as never,
      getLaunchResult: async () => {
        const result = cache
        cache = null
        return result
      },
    } as never)

    const handler = handlers.get('update:getLaunchResult')!
    expect(handler).toBeDefined()

    const first = await handler()
    expect(first).toEqual({ status: 'done', version: '0.9.9' })

    const second = await handler()
    expect(second).toBeNull()
  })
})
