/**
 * SessionApiPort 接口编译期契约（TC-7）。
 *
 * 接口是纯类型契约无运行时行为，测试方式是类型断言：
 * fake 对象满足接口形状 + shared 类型导入可解析（tsc --noEmit 是门禁）。
 */
import { describe, it, expect } from 'vitest'
import type { SessionApiPort } from '../api-port'
import type { SessionGroup, SessionSummary, BatchDeleteResult } from '@taiji/shared'

describe('SessionApiPort 类型契约', () => {
  it('TC-7 fake 对象满足 SessionApiPort 形状（编译期验证）', () => {
    const fake: SessionApiPort = {
      list: async (): Promise<SessionGroup[]> => [],
      switchSession: async (): Promise<void> => {},
      create: async (cwd: string, label: string): Promise<SessionSummary> =>
        ({ id: 's1', cwd, label, status: 'idle' }) as SessionSummary,
      rename: async (): Promise<void> => {},
      remove: async (): Promise<void> => {},
      removeByCwd: async (): Promise<BatchDeleteResult> => ({ cwd: '/a', deleted: [], failed: [] }),
      migrateImage: async (): Promise<{ path: string }> => ({ path: '/data/x.png' }),
      onConfigSessions: (): (() => void) => () => {},
    }
    expect(fake).toBeDefined()
  })

  it('migrateImage 参数形状：{fromPath, sessionId, fileName} → {path}', () => {
    const received: unknown = undefined
    const fake: SessionApiPort = {
      list: async () => [],
      switchSession: async () => {},
      create: async (): Promise<SessionSummary> => ({ id: 's1' }) as SessionSummary,
      rename: async () => {},
      remove: async () => {},
      removeByCwd: async (): Promise<BatchDeleteResult> => ({ cwd: '/a', deleted: [], failed: [] }),
      migrateImage: async (p: { fromPath: string; sessionId: string; fileName: string }): Promise<{ path: string }> => {
        void p
        return { path: '/data/x.png' }
      },
      onConfigSessions: (): (() => void) => () => {},
    }
    expect(received).toBeUndefined()
    expect(typeof fake.migrateImage).toBe('function')
  })
})
