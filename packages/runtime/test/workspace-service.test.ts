/**
 * WorkspaceService 测试
 *
 * 覆盖 execution-plan test-matrix T2.6-T2.7：
 * - T2.6: AC-2.4 service 零 setTimeout/setInterval（grep 检查）
 * - T2.7: AC-2.5 service 不 import session（grep 检查）
 *
 * 以及 WorkspaceService 的行为验证：
 * - record 透传到 store
 * - list 透传到 store
 * - INV-1 主检查：空串/undefined 静默跳过
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { RecentWorkspacesStore } from '../src/services/workspace/recent-workspaces-store.js'

/** setPinned/defaultSessionDir 用例共用的最小 store stub（record/list 透传已在上组覆盖） */
function storeStub(): RecentWorkspacesStore {
  return {
    record: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    setPinned: vi.fn().mockReturnValue(true),
    flushAll: vi.fn(),
  } as unknown as RecentWorkspacesStore
}

// ── T2.6: service 源码不含 setTimeout/setInterval ─────────────────
// 这是 grep 检查测试，运行时读源码验证

const SERVICE_SOURCE = readFileSync(
  new URL('../src/services/workspace/workspace-service.ts', import.meta.url),
  'utf-8',
)

describe('WorkspaceService — grep guards', () => {
  it('T2.6: service source contains no setTimeout or setInterval (AC-2.4)', () => {
    // 排除注释行后再检查
    const codeLines = SERVICE_SOURCE
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .filter(line => !line.trimStart().startsWith('*'))
      .join('\n')

    expect(codeLines).not.toMatch(/\bsetTimeout\b/)
    expect(codeLines).not.toMatch(/\bsetInterval\b/)
  })

  it('T2.7: service source does not import session modules (AC-2.5)', () => {
    expect(SERVICE_SOURCE).not.toMatch(/from\s+['"].*session.*['"]/)
    expect(SERVICE_SOURCE).not.toMatch(/import.*session/i)
  })
})

describe('WorkspaceService — behavior', () => {
  let mockStore: RecentWorkspacesStore
  let service: WorkspaceService

  beforeEach(() => {
    mockStore = {
      record: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      flushAll: vi.fn(),
    } as unknown as RecentWorkspacesStore

    service = new WorkspaceService(mockStore)
  })

  it('record delegates to store.record', () => {
    service.record('/project/test')
    expect(mockStore.record).toHaveBeenCalledWith('/project/test')
  })

  it('record skips empty string (INV-1 primary guard)', () => {
    service.record('')
    expect(mockStore.record).not.toHaveBeenCalled()
  })

  // 方案 A homedir 检查（自 workspace-service-homedir.test.ts 并入）：
  // homedir 是失效 cwd 的兜底目标，作为「最近工作区」无记录价值——service 层堵死。
  it('record(homedir) → store.record 不被调用（方案A homedir 检查）', () => {
    service.record(homedir())
    expect(mockStore.record).not.toHaveBeenCalled()
  })

  it('record skips whitespace-only string (INV-1 primary guard)', () => {
    service.record('   ')
    expect(mockStore.record).not.toHaveBeenCalled()
  })

  it('record skips undefined (INV-1 primary guard)', () => {
    service.record(undefined as unknown as string)
    expect(mockStore.record).not.toHaveBeenCalled()
  })

  it('list delegates to store.list', () => {
    const records = [
      { cwd: '/project/a', lastUsedAt: 100, label: 'a' },
    ]
    vi.mocked(mockStore.list).mockReturnValue(records)

    const result = service.list()
    expect(result).toEqual(records)
    expect(mockStore.list).toHaveBeenCalled()
  })
})

// ── setPinned（INV-6 透传 + 上限拒绝降级，2026-10-22 pin 功能）──────────────

describe('WorkspaceService — setPinned', () => {
  let mockStore: RecentWorkspacesStore
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockStore = {
      record: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      setPinned: vi.fn().mockReturnValue(true),
      flushAll: vi.fn(),
    } as unknown as RecentWorkspacesStore
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('store 生效（true）→ 透传返回 true，不 warn', () => {
    const service = new WorkspaceService(mockStore)
    ;(mockStore.setPinned as ReturnType<typeof vi.fn>).mockReturnValue(true)
    expect(service.setPinned('/project/a', true)).toBe(true)
    expect(mockStore.setPinned).toHaveBeenCalledWith('/project/a', true)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('空串/whitespace → false 且不触 store（入参主检查）', () => {
    const service = new WorkspaceService(mockStore)
    expect(service.setPinned('', true)).toBe(false)
    expect(service.setPinned('   ', true)).toBe(false)
    expect(mockStore.setPinned).not.toHaveBeenCalled()
  })

  it('store 拒绝（false = 超 pin 上限）→ warn 留痕 + 返回 false（调用方 degraded 标记）', () => {
    const service = new WorkspaceService(mockStore)
    ;(mockStore.setPinned as ReturnType<typeof vi.fn>).mockReturnValue(false)
    expect(service.setPinned('/project/a', true)).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('setPinned rejected'))
  })
})

// ── defaultSessionDir（幂等 ensureDir + 失败返回空串，2026-10-22 默认会话入口）──

describe('WorkspaceService — defaultSessionDir', () => {
  it('provider 返回目录 → mkdirSync 后返回该目录（自愈兜底）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-service-default-'))
    const service = new WorkspaceService(storeStub(), () => dir)
    expect(service.defaultSessionDir()).toBe(dir)
    expect(existsSync(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('provider 返回空串 → 返回空串（入口隐藏判据），不触 fs', () => {
    const service = new WorkspaceService(storeStub(), () => '')
    expect(service.defaultSessionDir()).toBe('')
  })

  it('mkdirSync 抛错（路径父级是文件）→ 返回空串 + error 留痕（不向调用方抛）', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const tmp = mkdtempSync(join(tmpdir(), 'ws-service-blocker-'))
      // 以「已存在的文件」为父 → mkdirSync 必抛（ENOTDIR/EEXIST 族），真实触发 catch 分支
      const blockerFile = join(tmp, 'blocker')
      writeFileSync(blockerFile, 'x')
      const service = new WorkspaceService(storeStub(), () => join(blockerFile, 'sub'))
      expect(service.defaultSessionDir()).toBe('')
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ensure defaultSession dir failed'), expect.anything())
      rmSync(tmp, { recursive: true, force: true })
    } finally {
      errSpy.mockRestore()
    }
  })
})
