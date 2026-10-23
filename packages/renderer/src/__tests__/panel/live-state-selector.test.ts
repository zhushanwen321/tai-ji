/**
 * 状态层选择器测试（会话架构四层分离 W0/W1：composer 读状态层，缺失即显式未知）。
 *
 * 覆盖设计 §7 验收项 2/3/7 的渲染层半边：
 * - 项 2：侧栏列表之外的会话 id（btw 线 vid / 任意不在列表的 id）写入状态层后，
 *   composer 的选择器 `createSessionLiveStateSelector` 立即可读到；
 * - 项 3：整表刷新 / 归档 / 项目过滤（导航列表变化）不影响选择器输出；
 * - 项 7：线内切换不影响主会话、主会话切换不影响线（按 id 隔离，无回退合并）；
 * - 显式未知：缓存缺失返回 undefined（不回退主会话值——设计 §2.4 I5 / §6 明确否决）。
 *
 * 纯逻辑测试（core factory + 选择器纯函数），不 mount DOM：
 * 选择器与 composer-shell 的 `getSessionState` 共用同一实现（`liveStateOf(sid) ?? null`），
 * DOM 侧消费链（useComposerModelThinking）已有 model-thinking.test.ts 覆盖。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/live-state-selector.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import { createSessionLiveState, createSessionLiveStateSelector, createSessionStore } from '@taiji/core'

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

const MAIN = 'main-s1'
const LINE = 'btw:pi-line-1'

function makeFixture() {
  const live = createSessionLiveState()
  const nav = createSessionStore()
  nav.applySnapshot({
    groups: [
      group('/work/a', [makeSession({ id: MAIN, modelId: 'seed/main' })]),
    ],
  })
  const getSessionState = createSessionLiveStateSelector(live)
  return { live, nav, getSessionState }
}

describe('composer 状态层选择器（验收项 2：列表外会话状态写入后 composer 可见）', () => {
  it('列表外会话 id 写入状态层 → 选择器可读（与主会话同一入口）', () => {
    const f = makeFixture()
    f.live.applyLiveState(LINE, { modelId: 'p/line', thinkingLevel: 'low' })

    expect(f.getSessionState(LINE)).toEqual({ modelId: 'p/line', thinkingLevel: 'low' })
    // 侧栏列表不含该 id（列表是导航视图，不因状态写入变化）
    expect(f.nav.list.value.map((s) => s.id)).toEqual([MAIN])
  })

  it('缓存缺失 → undefined（显式未知，禁止回退到主会话值）', () => {
    const f = makeFixture()
    f.live.applyLiveState(MAIN, { modelId: 'p/main', thinkingLevel: 'high' })

    // 线未写入任何状态：不得拿主会话当前值猜（设计 §2.4 I5）
    expect(f.getSessionState(LINE)).toBeUndefined()
  })

  it('线内切换不影响主会话，主会话切换不影响线（验收项 7）', () => {
    const f = makeFixture()
    f.live.applyLiveState(MAIN, { modelId: 'p/main-a', thinkingLevel: 'high' })
    f.live.applyLiveState(LINE, { modelId: 'p/line-a', thinkingLevel: 'low' })

    // 线内切换
    f.live.applyLiveState(LINE, { modelId: 'p/line-b' })
    expect(f.getSessionState(MAIN)).toEqual({ modelId: 'p/main-a', thinkingLevel: 'high' })
    expect(f.getSessionState(LINE)).toEqual({ modelId: 'p/line-b', thinkingLevel: 'low' })

    // 主会话切换
    f.live.applyLiveState(MAIN, { modelId: 'p/main-b', thinkingLevel: 'max' })
    expect(f.getSessionState(LINE)).toEqual({ modelId: 'p/line-b', thinkingLevel: 'low' })
    expect(f.getSessionState(MAIN)).toEqual({ modelId: 'p/main-b', thinkingLevel: 'max' })
  })
})

describe('导航列表变化不触碰状态层（验收项 3）', () => {
  it('整表刷新 / 归档 / 项目过滤后选择器输出不变', () => {
    const f = makeFixture()
    const other = makeSession({ id: 'other', cwd: '/work/b' })
    f.live.applyLiveState(MAIN, { modelId: 'p/main', thinkingLevel: 'high' })
    f.live.applyLiveState('other', { modelId: 'p/other' })

    // 整表刷新（加入 other）
    f.nav.applySnapshot({ groups: [group('/work/a', [makeSession({ id: MAIN })]), group('/work/b', [other])] })
    expect(f.getSessionState(MAIN)).toEqual({ modelId: 'p/main', thinkingLevel: 'high' })
    expect(f.getSessionState('other')).toEqual({ modelId: 'p/other' })

    // 归档（other 从列表消失）
    f.nav.applySnapshot({ groups: [group('/work/a', [makeSession({ id: MAIN })])] })
    expect(f.nav.list.value.map((s) => s.id)).toEqual([MAIN])
    expect(f.getSessionState('other')).toEqual({ modelId: 'p/other' })

    // 项目过滤（只剩 b 组：main 不在列表）
    f.nav.applySnapshot({ groups: [group('/work/b', [other])] })
    expect(f.getSessionState(MAIN)).toEqual({ modelId: 'p/main', thinkingLevel: 'high' })
  })
})
