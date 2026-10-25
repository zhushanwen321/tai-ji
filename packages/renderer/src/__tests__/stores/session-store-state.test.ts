// @vitest-environment node

/**
 * sessionStore 状态单测（applySnapshot 快照合并 + markDead/revive dead 态管理；
 * 原 session-store-dead-revive.test.ts 已并入本文件——同 SUT 同 seed 模式）。
 *
 * applySnapshot（W13 起唯一写入口，W3 用例迁移；[W1 会话架构四层分离] 起收敛为**描述字段**：
 * label / status 等，状态字段 modelId / thinkingLevel / tokenCount 已迁状态层
 * domain/session/live-state，列表不再承载）。不含订阅路由（见 session-renamed-sync.test.ts）。
 *
 * markDead / revive：进程退出后的 dead 态管理（R7——退出的 session 仍可点击，
 * 触发 restore→再崩溃循环）。dead 置灰 / revive 仅 dead→idle / 未知 sid no-op。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/stores/session-store-state.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionGroup } from '@taiji/shared'

import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
})

function seedSession(): ReturnType<typeof useSessionStore> {
  const store = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 's1', label: 'test', cwd: '/repo', status: 'idle', lastActiveAt: 100 },
      { id: 's2', label: 'other', cwd: '/repo', status: 'idle', lastActiveAt: 100 },
    ],
  }
  store.applySnapshot({ groups: [group] })
  return store
}

describe('sessionStore.applySnapshot（单 session 快照合并）', () => {
  it('U11: 更新 label，其余字段不变', () => {
    const store = seedSession()
    store.applySnapshot('s1', { label: '新名' })
    const s1 = store.list.find((s) => s.id === 's1')
    expect(s1?.label).toBe('新名')
    expect(s1?.status).toBe('idle') // 不变
    expect(s1?.cwd).toBe('/repo') // 其余描述字段不动
  })

  it('U12: 未知 sessionId 不抛错，groups 不变', () => {
    const store = seedSession()
    expect(() => store.applySnapshot('ghost', { label: 'x' })).not.toThrow()
    expect(store.list.length).toBe(2)
    expect(store.list.find((s) => s.id === 's1')?.label).toBe('test')
  })

  it('U13: 只更新 status，label 不变', () => {
    const store = seedSession()
    store.applySnapshot('s1', { status: 'active' })
    const s1 = store.list.find((s) => s.id === 's1')
    expect(s1?.status).toBe('active')
    expect(s1?.label).toBe('test') // 不变
  })

  it('label 为 undefined 时不更新（保留旧值）', () => {
    const store = seedSession()
    store.applySnapshot('s1', { label: undefined, status: 'done' })
    const s1 = store.list.find((s) => s.id === 's1')
    expect(s1?.status).toBe('done')
    expect(s1?.label).toBe('test') // undefined 跳过，保留旧值
  })

  // ── [W1 会话架构四层分离] 状态字段不再由列表承载（反向锁定；W3 起三字段已不在
  //    SessionSummary 上，写入分支同批删除——本用例锁定无人把它们加回列表条目）────────
  it('W1: 单条快照的状态字段（modelId/thinkingLevel/tokenCount）不写入列表条目', () => {
    const store = seedSession()
    store.applySnapshot('s1', { modelId: 'anthropic/claude-4', thinkingLevel: 'max', tokenCount: 999 })
    const s1 = store.list.find((s) => s.id === 's1')
    // 列表条目只持描述字段；状态字段即使随快照传入也不落列表（W3 起类型上已无这三字段）
    expect(s1).toMatchObject({ id: 's1', label: 'test', status: 'idle' })
    expect(s1).not.toHaveProperty('modelId')
    expect(s1).not.toHaveProperty('thinkingLevel')
    expect(s1).not.toHaveProperty('tokenCount')
  })
})

function seedIdleStore(): ReturnType<typeof useSessionStore> {
  const store = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 's1', label: 'idle-session', cwd: '/repo', status: 'idle', lastActiveAt: 100 },
      { id: 's2', label: 'active-session', cwd: '/repo', status: 'active', lastActiveAt: 200 },
    ],
  }
  store.applySnapshot({ groups: [group] })
  return store
}

describe('sessionStore.markDead', () => {
  it('idle session 标记为 dead', () => {
    const store = seedIdleStore()
    store.markDead('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('dead')
  })

  it('active session 标记为 dead（流式中进程崩溃的场景）', () => {
    const store = seedIdleStore()
    store.markDead('s2')
    expect(store.list.find((s) => s.id === 's2')?.status).toBe('dead')
  })

  it('未知 sessionId 为 no-op（不抛错，列表不变）', () => {
    const store = seedIdleStore()
    expect(() => store.markDead('ghost')).not.toThrow()
    expect(store.list.length).toBe(2)
    expect(store.list.every((s) => s.status !== 'dead')).toBe(true)
  })

  it('只改目标 session，其余 session 状态不变', () => {
    const store = seedIdleStore()
    store.markDead('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('dead')
    expect(store.list.find((s) => s.id === 's2')?.status).toBe('active')
  })
})

describe('sessionStore.revive', () => {
  it('dead session 重置为 idle', () => {
    const store = seedIdleStore()
    store.markDead('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('dead')

    store.revive('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('idle')
  })

  it('非 dead 态不受 revive 影响（防止误改 active）', () => {
    const store = seedIdleStore()
    // s2 是 active，revive 应 no-op
    store.revive('s2')
    expect(store.list.find((s) => s.id === 's2')?.status).toBe('active')
  })

  it('未知 sessionId 为 no-op', () => {
    const store = seedIdleStore()
    expect(() => store.revive('ghost')).not.toThrow()
    expect(store.list.length).toBe(2)
  })
})
