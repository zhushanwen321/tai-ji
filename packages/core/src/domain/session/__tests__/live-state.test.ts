/**
 * createSessionLiveState 单测（会话架构四层分离 W0/W1：状态层按会话 id 寄存）。
 *
 * 锁定设计 §2.4 不变量与 §7 验收项 2/3/5：
 * - I3 状态按 id 寄存，条目生命周期独立于导航列表：整表刷新 / 归档（条目消失）/
 *   项目过滤（分组变化）都不得触碰状态层；
 * - I4 单一写入口 applyLiveState 字段级合并；
 * - 显式 removeLiveState 才移除条目；
 * - 写入无任何 sid 类别判据（侧栏列表之外 / btw 线 / 未知 id 同一条路径）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/session/__tests__/live-state.test.ts
 */
import { describe, expect, it } from 'vitest'
import { computed, effectScope, nextTick } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import { createSessionLiveState } from '../live-state'
import { createSessionStore } from '../store'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    label: overrides.id,
    cwd: '/work/a',
    status: 'idle',
    lastActiveAt: 0,
    modelId: '',
    tokenCount: 0,
    ...overrides,
  }
}

function group(cwd: string, sessions: SessionSummary[]): SessionGroup {
  return { cwd, sessions }
}

describe('createSessionLiveState（状态层按会话 id 寄存，ADR-0049 分区范式）', () => {
  it('applyLiveState 字段级合并：patch 未提供的维度保留现值', () => {
    const live = createSessionLiveState()

    live.applyLiveState('s1', { modelId: 'p/a' })
    expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/a' })

    live.applyLiveState('s1', { thinkingLevel: 'high' })
    expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/a', thinkingLevel: 'high' })

    // 只改 modelId，thinkingLevel 保留
    live.applyLiveState('s1', { modelId: 'p/b' })
    expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/b', thinkingLevel: 'high' })
  })

  it('侧栏列表之外的会话 id 同样写入：写入路径无 hidden / 列表成员判据（验收项 5）', () => {
    const live = createSessionLiveState()

    // btw 线（runtime hidden 注册）与任意不在侧栏列表的 id 走同一入口、同一形状
    live.applyLiveState('btw:line-1', { modelId: 'p/line', thinkingLevel: 'low' })
    live.applyLiveState('not-in-sidebar', { modelId: 'p/ghost' })
    live.applyLiveState('main-1', { modelId: 'p/main' })

    expect(live.liveStateOf('btw:line-1')).toEqual({ modelId: 'p/line', thinkingLevel: 'low' })
    expect(live.liveStateOf('not-in-sidebar')).toEqual({ modelId: 'p/ghost' })
    expect(live.liveStateOf('main-1')).toEqual({ modelId: 'p/main' })
  })

  it('缓存缺失 → undefined（显式未知，不回退其他会话的值）', () => {
    const live = createSessionLiveState()
    live.applyLiveState('s1', { modelId: 'p/a', thinkingLevel: 'high' })

    expect(live.liveStateOf('s2')).toBeUndefined()
    // 值不串台：不同 id 各自独立
    expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/a', thinkingLevel: 'high' })
  })

  it('整表刷新 / 归档 / 项目过滤后，已缓存状态仍在（验收项 3）', () => {
    const live = createSessionLiveState()
    const nav = createSessionStore()

    const s1 = makeSession({ id: 's1', modelId: '', cwd: '/a', projectId: 'p1' })
    const s2 = makeSession({ id: 's2', cwd: '/b' })
    nav.applySnapshot({ groups: [group('/a', [s1]), group('/b', [s2])] })

    live.applyLiveState('s1', { modelId: 'p/a', thinkingLevel: 'high' })
    live.applyLiveState('s2', { modelId: 'p/b' })

    // ① 整表刷新（同内容重放）
    nav.applySnapshot({ groups: [group('/a', [s1]), group('/b', [s2])] })
    expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/a', thinkingLevel: 'high' })
    expect(live.liveStateOf('s2')).toEqual({ modelId: 'p/b' })

    // ② 归档 / 删除后条目从列表消失（列表只剩 s1）
    nav.applySnapshot({ groups: [group('/a', [s1])] })
    expect(nav.list.value.map((s) => s.id)).toEqual(['s1'])
    expect(live.liveStateOf('s2')).toEqual({ modelId: 'p/b' })

    // ③ 项目过滤（分组集合变化，s1 归属被过滤掉）
    nav.applySnapshot({ groups: [group('/b', [s2])] })
    expect(nav.list.value.map((s) => s.id)).toEqual(['s2'])
    expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/a', thinkingLevel: 'high' })
    expect(live.liveStateOf('s2')).toEqual({ modelId: 'p/b' })
  })

  it('removeLiveState 只移除显式请求的条目（会话删除时唯一清退口）', () => {
    const live = createSessionLiveState()
    live.applyLiveState('s1', { modelId: 'p/a' })
    live.applyLiveState('s2', { modelId: 'p/b' })

    live.removeLiveState('s1')
    expect(live.liveStateOf('s1')).toBeUndefined()
    expect(live.liveStateOf('s2')).toEqual({ modelId: 'p/b' })

    // 幂等：重复移除不抛
    expect(() => live.removeLiveState('s1')).not.toThrow()
  })

  it('响应式：liveStateOf 在状态写入后驱动 Vue computed 重算', async () => {
    const scope = effectScope()
    const live = createSessionLiveState()
    const value = scope.run(() => computed(() => live.liveStateOf('s1')))!

    expect(value.value).toBeUndefined()
    live.applyLiveState('s1', { modelId: 'p/a' })
    await nextTick()
    expect(value.value).toEqual({ modelId: 'p/a' })

    live.applyLiveState('s1', { thinkingLevel: 'max' })
    await nextTick()
    expect(value.value).toEqual({ modelId: 'p/a', thinkingLevel: 'max' })

    live.removeLiveState('s1')
    await nextTick()
    expect(value.value).toBeUndefined()
    scope.stop()
  })
})
