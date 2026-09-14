/**
 * WorkspaceService 测试
 *
 * 覆盖 execution-plan test-matrix T2.6-T2.7：
 * - T2.6: AC-2.4 service 零 setTimeout/setInterval（grep 守卫）
 * - T2.7: AC-2.5 service 不 import session（grep 守卫）
 *
 * 以及 WorkspaceService 的行为验证：
 * - record 透传到 store
 * - list 透传到 store
 * - INV-1 主守卫：空串/undefined 静默跳过
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { RecentWorkspacesStore } from '../src/services/workspace/recent-workspaces-store.js'

// ── T2.6: service 源码不含 setTimeout/setInterval ─────────────────
// 这是 grep 守卫测试，运行时读源码验证

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

    service = new WorkspaceService(mockStore, { detect: () => ({ isBareMode: false, wsRoot: '', barePath: '' }) } as never)
  })

  it('record delegates to store.record', () => {
    service.record('/project/test')
    expect(mockStore.record).toHaveBeenCalledWith('/project/test')
  })

  it('record skips empty string (INV-1 primary guard)', () => {
    service.record('')
    expect(mockStore.record).not.toHaveBeenCalled()
  })

  // 方案 A homedir 守卫（自 workspace-service-homedir.test.ts 并入）：
  // homedir 是失效 cwd 的兜底目标，作为「最近工作区」无记录价值——service 层堵死。
  it('record(homedir) → store.record 不被调用（方案A homedir 守卫）', () => {
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
