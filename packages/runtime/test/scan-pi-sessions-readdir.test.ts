/**
 * W1 / L8: scanPiSessions readdirSync 未保护 → 进程级未捕获异常。
 *
 * 背景：sessions 目录存在但因权限/IO 故障不可读时，readdirSync 抛 EACCES 等异常，
 * 原实现未 try/catch，异常向上冒泡到调用方（SessionScanner / startup）→ 进程崩溃。
 * 修复：readdirSync 失败时 console.error + 返回空数组（scan 是扫描，容忍失败）。
 *
 * 运行：cd packages/runtime && npx vitest run test/scan-pi-sessions-readdir.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// readdirSync / existsSync 由本测试控制（existsSync=true 跳过 L163 守卫，触发 readdirSync）
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  readdirSync: vi.fn(() => [] as string[]),
}))
vi.mock('node:fs', () => ({
  existsSync: fsMock.existsSync,
  readdirSync: fsMock.readdirSync,
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}))

// getSessionsDir 返回固定路径（存在性由 existsSync mock 控制，不碰真文件系统）
const pathsMock = vi.hoisted(() => ({ getSessionsDir: vi.fn(() => '/fake/sessions') }))
vi.mock('../src/infra/pi/pi-paths.js', () => ({
  getSessionsDir: pathsMock.getSessionsDir,
}))

import { scanPiSessions, invalidateScanDirCache } from '../src/infra/pi/session-file-utils.js'

describe('W1/L8: scanPiSessions readdirSync 保护', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // W26（D9-1）：scanPiSessions 目录列举层 1s TTL 缓存——测试间必须显式失效，
    // 否则上一用例写入的缓存快照（EACCES 空结果 / 空目录）会让本用例 readdirSync
    // 不再触发（缓存命中），断言失真的同时掩盖被测行为。
    invalidateScanDirCache()
    fsMock.existsSync.mockReturnValue(true)
    fsMock.readdirSync.mockReturnValue([])
    pathsMock.getSessionsDir.mockReturnValue('/fake/sessions')
  })

  it('readdirSync 抛 EACCES → 返回空数组（不向上抛出进程级异常）', () => {
    const accessError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    fsMock.readdirSync.mockImplementation(() => {
      throw accessError
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // 关键断言：不抛错，优雅返回 []
    const result = scanPiSessions()
    expect(result).toEqual([])

    errSpy.mockRestore()
  })

  it('readdirSync 抛错时 console.error 记录失败路径（诊断价值）', () => {
    const accessError = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    fsMock.readdirSync.mockImplementation(() => {
      throw accessError
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    scanPiSessions()

    expect(errSpy).toHaveBeenCalledTimes(1)
    const logged = errSpy.mock.calls[0].join(' ')
    expect(logged).toContain('/fake/sessions')
    errSpy.mockRestore()
  })

  it('目录不存在 → 仍返回空数组（既有守卫不变）', () => {
    fsMock.existsSync.mockReturnValue(false)
    expect(scanPiSessions()).toEqual([])
    // existsSync=false 时不应走到 readdirSync
    expect(fsMock.readdirSync).not.toHaveBeenCalled()
  })
})
