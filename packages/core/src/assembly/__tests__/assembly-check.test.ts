// 装配检查 helper 契约测试（remote-use D9①）。
//
// helper 本体是纯断言原语：输入壳装配产物（sessionEntry 端口束 / InboundEffects 回调集），
// 返回问题清单（计算器/裁判分层——helper 忠实映射，通过判定由测试断言承担）。本文件锁
// helper 自身的判定契约：缺失/空实现两类问题的检出 + 双清单互斥覆盖（新成员加进
// SessionEntryPort 时必须显式归入 REQUIRED 或 EXEMPT，样例对象类型标注使漏归编译红）。
// 双壳装配态（真壳产物调同一 helper）在 packages/mobile-renderer 与 packages/renderer 的
// assembly-check.test.ts。
//
// 运行：cd packages/core && npx vitest run src/assembly/__tests__/assembly-check.test.ts
import { describe, expect, it } from 'vitest'
import {
  checkSessionEntryAssembly,
  checkInboundEffectsAssembly,
  REQUIRED_SESSION_ENTRY_MEMBERS,
  EXEMPT_SESSION_ENTRY_MEMBERS,
  REQUIRED_EFFECT_CALLBACKS,
} from '../assembly-check'
import type { SessionEntryPort } from '../../domain/session/api-port'
import type { InboundEffects } from '../../coordination/route-inbound'

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
