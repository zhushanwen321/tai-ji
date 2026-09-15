/**
 * lib/ipc 封装单测（update 方法族 + pickFile + revealInFolder，同 SUT 单文件；
 * 原 ipc-update.test.ts / ipc-pick-file.test.ts / ipc-reveal-in-folder.test.ts 并入，
 * 共享同一 resetModules + 动态 import + electronAPI stub 脚手架）。
 *
 * 覆盖：
 * - update 方法族（W4TC11 / RM2.3）：web/mock 环境优雅降级形状 + electronAPI 转发透传
 *   （[批次 3] performUpdate 一键封装已删（m17）；updateDownload 改传意图 version 字符串）
 * - pickFile（TC1，slice5 attach-dragdrop-menu）：无 preload 降级 {canceled:true, path:null}
 *   + 转发透传（TC1a-variant「electronAPI 存在但无 pickFile」与 TC1a 同一 `!api?.pickFile`
 *   分支，已省略）
 * - revealInFolder（C2 trace MALFORMED 行「打开所在目录」）：降级静默 resolve + 透传
 *
 * 关键：ipc.ts 顶层 `const api = window.electronAPI` 在模块加载时捕获，
 * 故每个用例需 vi.resetModules() + 动态 import 以新 module 实例读取新 stub。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/lib/ipc.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { LatestReleaseInfo } from '@xyz-agent/shared'

/** 测试用 LatestReleaseInfo（openUpdateFallbackUrl/getPreloaded 透传） */
const release: LatestReleaseInfo = {
  version: '0.9.0',
  tagName: 'v0.9.0',
  releaseNotes: '## new',
  publishedAt: '2026-07-01T00:00:00Z',
  htmlUrl: 'https://example.com/release',
  assets: {},
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  // 还原 window.electronAPI（避免污染其他测试）
  delete (window as { electronAPI?: unknown }).electronAPI
})

describe('lib/ipc update 方法 · web/mock 降级（electronAPI=undefined）', () => {
  beforeEach(() => {
    // 确保 electronAPI 不存在（web/mock 环境无 preload）
    delete (window as { electronAPI?: unknown }).electronAPI
  })

  it('checkForUpdate → { info: null, rateLimited: false }（RM2.3 形状）', async () => {
    const ipc = await import('@/lib/ipc')
    await expect(ipc.checkForUpdate()).resolves.toEqual({ info: null, rateLimited: false })
    await expect(ipc.checkForUpdate({ force: true })).resolves.toEqual({ info: null, rateLimited: false })
  })

  it('onUpdateProgress → 返回 no-op 取消函数', async () => {
    const ipc = await import('@/lib/ipc')
    const off = ipc.onUpdateProgress(() => {})
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
  })

  it('onUpdateError → 返回 no-op 取消函数', async () => {
    const ipc = await import('@/lib/ipc')
    const off = ipc.onUpdateError(() => {})
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
  })

  it('openUpdateFallbackUrl → resolve（不抛错）', async () => {
    const ipc = await import('@/lib/ipc')
    await expect(ipc.openUpdateFallbackUrl('https://example.com')).resolves.toBeUndefined()
  })

  it('updateDownload → { downloaded: false }（传意图：version 字符串）', async () => {
    const ipc = await import('@/lib/ipc')
    await expect(ipc.updateDownload('0.9.0')).resolves.toEqual({ downloaded: false })
  })

  it('updateInstall → { triggerRestart: false }', async () => {
    const ipc = await import('@/lib/ipc')
    await expect(ipc.updateInstall()).resolves.toEqual({ triggerRestart: false })
  })

  it('getPreloaded → null', async () => {
    const ipc = await import('@/lib/ipc')
    await expect(ipc.getPreloaded()).resolves.toBeNull()
  })
})

describe('lib/ipc update 方法 · 转发到 electronAPI', () => {
  it('checkForUpdate 转发 opts 并透传 UpdateCheckResult', async () => {
    const spy = vi.fn((opts?: { force?: boolean }) =>
      Promise.resolve(
        opts?.force
          ? { info: release, rateLimited: false }
          : { info: null, rateLimited: true },
      ),
    )
    ;(window as { electronAPI?: unknown }).electronAPI = { checkForUpdate: spy }
    const ipc = await import('@/lib/ipc')

    // force=true → 透传 { info: release }
    await expect(ipc.checkForUpdate({ force: true })).resolves.toEqual({ info: release, rateLimited: false })
    expect(spy).toHaveBeenLastCalledWith({ force: true })

    // 无 force → 透传限额退避信号（rateLimited=true）
    await expect(ipc.checkForUpdate()).resolves.toEqual({ info: null, rateLimited: true })
    expect(spy).toHaveBeenLastCalledWith(undefined)
  })

  it('onUpdateProgress 转发 callback 并返回其 unsubscribe', async () => {
    const realOff = vi.fn()
    const spy = vi.fn((cb: (p: { stage: 'downloading'; percent: number }) => void) => {
      // 立即触发一次回调验证透传
      cb({ stage: 'downloading', percent: 50 })
      return realOff
    })
    ;(window as { electronAPI?: unknown }).electronAPI = { onUpdateProgress: spy }
    const ipc = await import('@/lib/ipc')

    const received: { stage: string; percent: number }[] = []
    const off = ipc.onUpdateProgress((p) => received.push(p))
    expect(spy).toHaveBeenCalled()
    expect(received).toEqual([{ stage: 'downloading', percent: 50 }])
    // 调返回的取消函数 → 应转发到 realOff
    off()
    expect(realOff).toHaveBeenCalled()
  })

  it('onUpdateError 转发 callback 并返回其 unsubscribe', async () => {
    const realOff = vi.fn()
    const spy = vi.fn(
      (cb: (e: { stage: string; message: string; errorCode?: string }) => void) => {
        cb({ stage: 'downloading', message: 'fail', errorCode: 'X' })
        return realOff
      },
    )
    ;(window as { electronAPI?: unknown }).electronAPI = { onUpdateError: spy }
    const ipc = await import('@/lib/ipc')

    const received: { stage: string; message: string; errorCode?: string }[] = []
    const off = ipc.onUpdateError((e) => received.push(e))
    expect(received).toEqual([{ stage: 'downloading', message: 'fail', errorCode: 'X' }])
    off()
    expect(realOff).toHaveBeenCalled()
  })

  it('openUpdateFallbackUrl 转发 url', async () => {
    const spy = vi.fn((url: string) => Promise.resolve())
    ;(window as { electronAPI?: unknown }).electronAPI = { openUpdateFallbackUrl: spy }
    const ipc = await import('@/lib/ipc')

    await ipc.openUpdateFallbackUrl('https://example.com/x')
    expect(spy).toHaveBeenCalledWith('https://example.com/x')
  })

  it('updateDownload 转发 version 字符串并透传返回值（批次 3 契约）', async () => {
    const spy = vi.fn((v: string) => Promise.resolve({ downloaded: v === '0.9.0' }))
    ;(window as { electronAPI?: unknown }).electronAPI = { updateDownload: spy }
    const ipc = await import('@/lib/ipc')

    await expect(ipc.updateDownload('0.9.0')).resolves.toEqual({ downloaded: true })
    expect(spy).toHaveBeenCalledWith('0.9.0')
  })

  it('updateInstall 转发（无参）并透传返回值', async () => {
    const spy = vi.fn(() => Promise.resolve({ triggerRestart: true }))
    ;(window as { electronAPI?: unknown }).electronAPI = { updateInstall: spy }
    const ipc = await import('@/lib/ipc')

    await expect(ipc.updateInstall()).resolves.toEqual({ triggerRestart: true })
    expect(spy).toHaveBeenCalledWith()
  })

  it('getPreloaded 转发（无参）并透传返回值', async () => {
    const preloaded = { release, filePath: '/tmp/preloaded.zip' }
    const spy = vi.fn(() => Promise.resolve(preloaded))
    ;(window as { electronAPI?: unknown }).electronAPI = { getPreloaded: spy }
    const ipc = await import('@/lib/ipc')

    await expect(ipc.getPreloaded()).resolves.toEqual(preloaded)
    expect(spy).toHaveBeenCalledWith()
  })
})

describe('lib/ipc pickFile 封装（TC1，原 ipc-pick-file.test.ts 并入）', () => {
  it('TC1a: 无 preload（api.pickFile 不存在）→ 返回 {canceled:true, path:null}，不 throw', async () => {
    // 不设置 window.electronAPI（模拟 web/mock 环境）
    const { pickFile } = await import('@/lib/ipc')
    const result = await pickFile()
    expect(result).toEqual({ canceled: true, path: null })
  })

  it('TC1b: api.pickFile 存在 → 透传 options 并返回其结果', async () => {
    const pickFileImpl = vi.fn().mockResolvedValue({ canceled: false, path: '/a/b.png' })
    ;(window as { electronAPI?: unknown }).electronAPI = { pickFile: pickFileImpl }
    const { pickFile } = await import('@/lib/ipc')
    const options = { filters: [{ name: 'Images', extensions: ['png', 'jpg'] }] }
    const result = await pickFile(options)
    expect(result).toEqual({ canceled: false, path: '/a/b.png' })
    expect(pickFileImpl).toHaveBeenCalledWith(options)
  })

  it('TC1b-default: 不传 options → pickFile 以 undefined 调用', async () => {
    const pickFileImpl = vi.fn().mockResolvedValue({ canceled: false, path: '/x.txt' })
    ;(window as { electronAPI?: unknown }).electronAPI = { pickFile: pickFileImpl }
    const { pickFile } = await import('@/lib/ipc')
    await pickFile()
    expect(pickFileImpl).toHaveBeenCalledWith(undefined)
  })
})

describe('lib/ipc revealInFolder 封装（原 ipc-reveal-in-folder.test.ts 并入）', () => {
  it('无 preload（electronAPI 不存在）→ 静默 resolve，不 throw', async () => {
    // 不设置 window.electronAPI（模拟 web/mock 环境）
    const { revealInFolder } = await import('@/lib/ipc')
    await expect(revealInFolder('/a/b.jsonl')).resolves.toBeUndefined()
  })

  it('electronAPI 存在但无 revealInFolder（旧 preload）→ 同样降级', async () => {
    ;(window as { electronAPI?: unknown }).electronAPI = {}
    const { revealInFolder } = await import('@/lib/ipc')
    await expect(revealInFolder('/a/b.jsonl')).resolves.toBeUndefined()
  })

  it('revealInFolder 存在 → 透传绝对路径并返回其结果', async () => {
    const impl = vi.fn().mockResolvedValue(true)
    ;(window as { electronAPI?: unknown }).electronAPI = { revealInFolder: impl }
    const { revealInFolder } = await import('@/lib/ipc')
    const result = await revealInFolder('/data/agent/sessions/s1.jsonl')
    expect(result).toBe(true)
    expect(impl).toHaveBeenCalledWith('/data/agent/sessions/s1.jsonl')
  })
})
