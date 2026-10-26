// api-port.test.ts —— core C31 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/session/api-port.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/assembly/__tests__/assembly-check.test.ts（14 用例，skip 0）
//   - src/domain/session/__tests__/api-port.test.ts（2 用例，skip 0）

import { describe, expect, it } from 'vitest'
import { checkSessionEntryAssembly, checkInboundEffectsAssembly, REQUIRED_SESSION_ENTRY_MEMBERS, EXEMPT_SESSION_ENTRY_MEMBERS, REQUIRED_EFFECT_CALLBACKS } from '../assembly-check'
import { type SessionEntryPort, type SessionApiPort } from '../../domain/session/api-port'
import { type InboundEffects } from '../../coordination/route-inbound'
import { type SessionGroup, type SessionSummary, type BatchDeleteResult, type SessionArchiveReply } from '@taiji/shared'

// ======== 来源：assembly-check.test.ts ========
describe("assembly-check", () => {
  /** 真实现样例（非空函数体——helper 判「非 no-op」的正面形态） */
  const wiredSessionEntry: SessionEntryPort = {
    ensureStreamSubscription: (sid) => void sid,
    touchRecency: (sid) => void sid,
    evictLru: (panelSessionId) => void panelSessionId,
  }

  /** D9② 合法缺省成员的全键样例（类型标注 Required：接口加成员时此处编译红，强制显式归边） */
  const allSessionEntryMembers: Required<SessionEntryPort> = {
    cancelActiveFlow: () => {},
    clearUnread: () => {},
    ensureStreamSubscription: () => {},
    touchRecency: () => {},
    preloadFileTree: () => {},
    evictLru: () => {},
  }

  describe('checkSessionEntryAssembly（D9① sessionEntry 端口束断言）', () => {
    it('三成员真实现 → 问题清单为空（装配完成态）', () => {
      expect(checkSessionEntryAssembly(wiredSessionEntry).problems).toEqual([])
    })

    it('整束缺失（undefined）→ 单条入口级 missing（壳未注入端口束）', () => {
      const { ok, problems } = checkSessionEntryAssembly(undefined)
      expect(ok).toBe(false)
      expect(problems).toEqual([{ member: 'sessionEntry', reason: 'missing' }])
    })

    it('成员缺键（evictLru 未注入）→ 该成员 missing（core 链内 ?? noop 静默退化的前置形态）', () => {
      const partial: SessionEntryPort = { ensureStreamSubscription: (sid) => void sid, touchRecency: (sid) => void sid }
      const { problems } = checkSessionEntryAssembly(partial)
      expect(problems).toEqual([{ member: 'evictLru', reason: 'missing' }])
    })

    it('成员显式空实现（箭头空体）→ 该成员 noop（键存在但静默退化的注入形态）', () => {
      const hollow: SessionEntryPort = { ...wiredSessionEntry, ensureStreamSubscription: () => {} }
      const { problems } = checkSessionEntryAssembly(hollow)
      expect(problems).toEqual([{ member: 'ensureStreamSubscription', reason: 'noop' }])
    })

    it('成员空实现（function 声明空体）→ 该成员 noop（多形态空体启发式）', () => {
      const hollow = {
        ...wiredSessionEntry,
        touchRecency: function noop(): void {},
      }
      const { problems } = checkSessionEntryAssembly(hollow)
      expect(problems).toEqual([{ member: 'touchRecency', reason: 'noop' }])
    })

    it('多问题一次全报（缺失与空实现并行呈报，不短路）', () => {
      const partial: SessionEntryPort = { ensureStreamSubscription: () => {}, touchRecency: (sid) => void sid }
      const { problems } = checkSessionEntryAssembly(partial)
      expect(problems).toEqual([
        { member: 'ensureStreamSubscription', reason: 'noop' },
        { member: 'evictLru', reason: 'missing' },
      ])
    })

    it('D9② 合法缺省成员（cancelActiveFlow/preloadFileTree/clearUnread）不在断言清单——空实现不算问题', () => {
      const mobileShape: SessionEntryPort = {
        ...wiredSessionEntry,
        cancelActiveFlow: () => {},
        preloadFileTree: () => {},
        clearUnread: () => {},
      }
      expect(checkSessionEntryAssembly(mobileShape).problems).toEqual([])
    })
  })

  describe('checkInboundEffectsAssembly（D9① effects 最小集断言）', () => {
    const wiredEffects: InboundEffects = {
      onSessionExited: (sessionId) => void sessionId,
      onSessionRestored: (sessionId) => void sessionId,
      onSessionRestoreFailed: (sessionId) => void sessionId,
    }

    it('三生命周期回调已接 → 问题清单为空（D5 factory 最小语义装配完成态）', () => {
      expect(checkInboundEffectsAssembly(wiredEffects).problems).toEqual([])
    })

    it('整集缺失（undefined）→ 单条入口级 missing（壳未接线 effects）', () => {
      const { ok, problems } = checkInboundEffectsAssembly(undefined)
      expect(ok).toBe(false)
      expect(problems).toEqual([{ member: 'effects', reason: 'missing' }])
    })

    it('回调缺接（onSessionRestored 未接）→ 该回调 missing（S6「无恢复提示无重订阅」回归的检出形态）', () => {
      const partial: InboundEffects = { onSessionExited: (sessionId) => void sessionId }
      const { problems } = checkInboundEffectsAssembly(partial)
      expect(problems).toEqual([
        { member: 'onSessionRestored', reason: 'missing' },
        { member: 'onSessionRestoreFailed', reason: 'missing' },
      ])
    })

    it('回调显式空实现 → 该回调 noop', () => {
      const hollow: InboundEffects = { ...wiredEffects, onSessionRestoreFailed: () => {} }
      const { problems } = checkInboundEffectsAssembly(hollow)
      expect(problems).toEqual([{ member: 'onSessionRestoreFailed', reason: 'noop' }])
    })
  })

  describe('成员清单互斥覆盖（D9① 清单 × D9② 白名单的对齐守护）', () => {
    it('REQUIRED ∪ EXEMPT 恰好覆盖 SessionEntryPort 全成员（样例对象 Required 类型锁键集）', () => {
      const covered = new Set([...REQUIRED_SESSION_ENTRY_MEMBERS, ...EXEMPT_SESSION_ENTRY_MEMBERS])
      expect([...covered].sort()).toEqual(Object.keys(allSessionEntryMembers).sort())
    })

    it('REQUIRED 与 EXEMPT 不相交（同一成员不得既属断言清单又属合法缺省）', () => {
      const required = new Set<string>(REQUIRED_SESSION_ENTRY_MEMBERS)
      const overlap = EXEMPT_SESSION_ENTRY_MEMBERS.filter((m) => required.has(m))
      expect(overlap).toEqual([])
    })

    it('effects 最小集非空（守护清单本身不被清空）', () => {
      expect(REQUIRED_EFFECT_CALLBACKS.length).toBeGreaterThan(0)
    })
  })
});

// ======== 来源：api-port.test.ts ========
describe("api-port", () => {
  describe('SessionApiPort 类型契约', () => {
    it('TC-7 fake 对象满足 SessionApiPort 形状（编译期验证）', () => {
      const fake: SessionApiPort = {
        list: async (): Promise<SessionGroup[]> => [],
        switchSession: async (): Promise<void> => {},
        create: async (cwd: string, label: string): Promise<SessionSummary> =>
          ({ id: 's1', cwd, label, status: 'idle' }) as SessionSummary,
        rename: async (): Promise<void> => {},
        remove: async (): Promise<void> => {},
        archive: async (): Promise<SessionArchiveReply> => ({ sessionId: 's1' }),
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
        archive: async () => ({ sessionId: 's1' }),
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
});
