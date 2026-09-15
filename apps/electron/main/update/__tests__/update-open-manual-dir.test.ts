/**
 * u7b-open-manual-dir 验收测试：gateway update-handlers 的 update:openManualDir
 * （设计 docs/design/update-network-resilience.md §3.3 D9「设置页手动通道：首次点击
 * 先 mkdirSync 确保目录存在，再 shell.openPath(manualDir)」）。
 *
 * 覆盖：
 *   - 首次点击幂等建目录：目录不存在 → mkdirSync(recursive) 创建 + openPath 打开
 *   - 幂等：目录已存在时重复调用不抛错（recursive 语义）
 *   - openPath 失败（返回非空错误字符串非 null）→ throw Error 含该字符串
 *
 * Mock 策略（对齐本目录 update-handlers-local.test.ts 的 electron 捕获范式）：
 *   - electron：ipcMain.handle 捕获 handler 到 Map + shell.openPath 桩
 *   - manual-claim：MANUAL_ASSET_DIR 指向 tmpdir 隔离目录（不碰真实数据目录）
 *   - mkdirSync **保留真实实现**（落 tmpdir）——验证幂等语义本身而非 mock 自证
 *
 * 运行：cd apps/electron/main && npx vitest run update/__tests__/update-open-manual-dir.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'

// ── 捕获注册的 handler（key=channel, value=handler fn）──────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>()

const openPathMock = vi.hoisted(() => vi.fn<(target: string) => Promise<string>>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
  app: {
    getVersion: vi.fn(() => '0.8.14'),
    quit: vi.fn(),
  },
  shell: {
    openPath: openPathMock,
  },
}))

// getManualAssetDir 隔离到 tmpdir（handler 内真实 mkdirSync 会创建它）。
// factory 内动态 import node:os/path：vi.mock 工厂执行先于测试文件 import 初始化。
vi.mock('../manual-claim.js', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  return {
    tryClaimManualAsset: vi.fn(async () => null),
    getManualAssetDir: () => path.join(os.tmpdir(), 'taiji-open-manual-dir-test'),
  }
})

import { registerUpdateHandlers } from '../../gateway/update-handlers.js'
// 读 mock 后的 getManualAssetDir（与 handler 内 import 同一模块实例）
import { getManualAssetDir } from '../manual-claim.js'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  // 每用例从「目录不存在」起步（幂等用例内部自建再复调验证 recursive 语义）
  rmSync(getManualAssetDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  // openPath 成功语义：返回空字符串（Electron 契约：'' = 成功，非空 = 错误描述）
  openPathMock.mockResolvedValue('')
  registerUpdateHandlers({ getMainWindow: () => null } as never)
})

afterEach(() => {
  rmSync(getManualAssetDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('u7b D9: update:openManualDir', () => {
  it('首次点击：幂等建目录（不存在 → 创建）+ openPath 打开 + 返回 { success: true }', async () => {
    expect(existsSync(getManualAssetDir())).toBe(false)

    const handler = handlers.get('update:openManualDir')!
    const result = await handler()

    expect(result).toEqual({ success: true })
    // 目录已真实创建（mkdirSync recursive）
    expect(existsSync(getManualAssetDir())).toBe(true)
    // openPath 收到 getManualAssetDir()（与 manual-claim 路径函数同源）
    expect(openPathMock).toHaveBeenCalledTimes(1)
    expect(openPathMock).toHaveBeenCalledWith(getManualAssetDir())
  })

  it('幂等：目录已存在时重复调用不抛错（recursive 语义）', async () => {
    const handler = handlers.get('update:openManualDir')!

    // 第一次：创建目录
    await expect(handler()).resolves.toEqual({ success: true })
    expect(existsSync(getManualAssetDir())).toBe(true)

    // 第二次：目录已存在，recursive mkdir 不抛 EEXIST，正常打开
    await expect(handler()).resolves.toEqual({ success: true })
    expect(openPathMock).toHaveBeenCalledTimes(2)
    expect(openPathMock).toHaveBeenNthCalledWith(2, getManualAssetDir())
  })

  it('openPath 失败（返回非空错误字符串）→ throw Error 含该字符串', async () => {
    openPathMock.mockResolvedValue('Failed to open path (no access)')

    const handler = handlers.get('update:openManualDir')!
    // 目录仍会先建好（建目录成功 + 打开失败两步独立）
    await expect(handler()).rejects.toThrow('Failed to open path (no access)')
    expect(existsSync(getManualAssetDir())).toBe(true)
  })
})
