/**
 * surface-by-session —— session.surfaces 派生表语义测试（W4a 判别器通道，设计 §3.3.6）。
 *
 * 锁定：整表替换（无差减/无单条目移除）、表外查找判非线（失败方向 = 偶发全局通知）、
 * 坏形状帧不落半截表、抑制查询 isBtwSession 只认 'btw'。
 *
 * 运行：cd packages/core && npx vitest run src/domain/session/__tests__/surface-by-session.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  applySurfacesFrame,
  isBtwSession,
  surfaceBySessionId,
  surfaceOfSession,
  __resetSurfaceTableForTest,
} from '../surface-by-session.js'

beforeEach(() => {
  __resetSurfaceTableForTest()
})

describe('surface-by-session：派生表语义（W4a）', () => {
  it('整表替换：第二帧覆盖第一帧（无差减、无单条目移除）', () => {
    applySurfacesFrame({ entries: [{ sessionId: 'a', surface: 'sidebar' }, { sessionId: 'b', surface: 'btw' }] })
    expect([...surfaceBySessionId.value.entries()]).toEqual([['a', 'sidebar'], ['b', 'btw']])
    applySurfacesFrame({ entries: [{ sessionId: 'c', surface: 'btw' }] })
    expect([...surfaceBySessionId.value.entries()]).toEqual([['c', 'btw']])
    expect(surfaceOfSession('a')).toBeUndefined() // 旧帧条目随整表替换消失
  })

  it('集合一致性：派生表与注册表逐条一致（帧内全量条目）', () => {
    const registry = [
      { sessionId: 'main-1', surface: 'sidebar' as const },
      { sessionId: 'line-1', surface: 'btw' as const },
      { sessionId: 'line-2', surface: 'btw' as const },
    ]
    applySurfacesFrame({ entries: registry })
    expect(new Set(surfaceBySessionId.value.keys())).toEqual(new Set(registry.map((e) => e.sessionId)))
    for (const e of registry) expect(surfaceOfSession(e.sessionId)).toBe(e.surface)
  })

  it('表外查找 = 非线（未覆盖会话 id 不猜成线）', () => {
    applySurfacesFrame({ entries: [{ sessionId: 'a', surface: 'sidebar' }] })
    expect(isBtwSession('never-seen')).toBe(false)
    expect(isBtwSession('a')).toBe(false)
    expect(isBtwSession('line-1')).toBe(false) // 空表默认
  })

  it('isBtwSession 只认 btw 条目', () => {
    applySurfacesFrame({ entries: [{ sessionId: 'line-1', surface: 'btw' }, { sessionId: 'main-1', surface: 'sidebar' }] })
    expect(isBtwSession('line-1')).toBe(true)
    expect(isBtwSession('main-1')).toBe(false)
  })

  it('坏形状帧不落表：entries 非数组 → 保持原表', () => {
    applySurfacesFrame({ entries: [{ sessionId: 'a', surface: 'btw' }] })
    applySurfacesFrame({ entries: 'nope' })
    expect(isBtwSession('a')).toBe(true) // 原表未被清空
  })

  it('坏形状帧不落半截表：条目缺字段/非法 surface → 整帧作废', () => {
    applySurfacesFrame({ entries: [{ sessionId: 'a', surface: 'btw' }] })
    applySurfacesFrame({ entries: [{ sessionId: 'b', surface: 'btw' }, { sessionId: 'c', surface: 'drawer' }] })
    expect(surfaceBySessionId.value.has('b')).toBe(false) // 半截不落
    expect(surfaceOfSession('a')).toBe('btw') // 上一张全量表保持
  })
})
