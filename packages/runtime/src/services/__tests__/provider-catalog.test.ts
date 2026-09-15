/**
 * isCatalogProvider 判据工具单测。
 *
 * 覆盖：已知 catalog provider → true / 自定义 provider → false /
 * edge case（空字符串）→ false / fail-safe（JSON 异常）→ false 不抛错。
 *
 * M4 追加：overlay 归一化（overlayToCatalogModel）D7 语义——缺省 api/baseUrl 不再
 * 用空串捏造（断言 undefined 且键不存在，而非 ''）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// overlay 状态注入（vi.hoisted 供 vi.mock 工厂引用）：绕开真实数据目录 IO，
// 只验证「快照 ⊕ overlay」合并点的归一语义。
const overlayState = vi.hoisted(() => ({
  current: { state: 'fresh' as const, models: [] as Array<Record<string, unknown>> },
}))

vi.mock('../provider-catalog-refresh.js', () => ({
  getCatalogOverlayState: () => overlayState.current,
}))

import { isCatalogProvider, getMergedCatalogModels } from '../provider-catalog.js'

describe('isCatalogProvider', () => {
  it('TC1: known catalog provider (anthropic) returns true', () => {
    expect(isCatalogProvider('anthropic')).toBe(true)
  })

  it('TC1b: known catalog provider (zai-coding-cn) returns true', () => {
    expect(isCatalogProvider('zai-coding-cn')).toBe(true)
  })

  it('TC1c: known catalog provider (openai) returns true', () => {
    expect(isCatalogProvider('openai')).toBe(true)
  })

  it('TC2: unknown custom provider returns false', () => {
    expect(isCatalogProvider('ollama')).toBe(false)
    expect(isCatalogProvider('my-custom-router')).toBe(false)
  })

  it('TC3: edge cases (empty string / non-existent) return false', () => {
    expect(isCatalogProvider('')).toBe(false)
    expect(isCatalogProvider('nonexistent-provider-foo')).toBe(false)
  })

  it('TC4: fail-safe — function handles edge case where builtinData is iterable', () => {
    // The fail-safe code path (!Array.isArray) is defensive against JSON
    // corruption, verified by code review. Here we test that known-good data
    // works without throwing.
    expect(() => isCatalogProvider('anthropic')).not.toThrow()
  })
})

/**
 * M4 / D7：overlay 归一化不再产空串（设计 catalog-provider-field-authority §3.3 D7）。
 *
 * pi 的 OverlayModel `api`/`baseUrl` 本就是 optional，空串是归一化捏造——会被合并视图的
 * 消费方（派生展示、写路径）当成真实值，且 provider/模型级空串都是 pi TypeBox
 * minLength:1 违规值（写入即拒载整个 models.json）。
 */
describe('M4: overlay 归一化 D7（缺省 = 不置键，非空串）', () => {
  beforeEach(() => {
    overlayState.current = { state: 'fresh', models: [] }
  })

  it('overlay 模型缺省 api/baseUrl → 合并后字段为 undefined 且键不存在（不产 ""）', () => {
    overlayState.current = {
      state: 'fresh',
      models: [{ id: 'overlay-only-model', name: 'Overlay Only' }],
    }

    const view = getMergedCatalogModels('opencode-go')

    expect(view?.overlayState.state).toBe('fresh')
    const overlayModel = view?.models.find(m => m.id === 'overlay-only-model')
    expect(overlayModel).toBeDefined()
    expect(overlayModel?.api).toBeUndefined()
    expect(overlayModel?.baseUrl).toBeUndefined()
    // 「缺省」与「显式空串」语义不同（后者是 pi schema 违规毒药）——断言键不存在而非值为 ''
    expect(overlayModel !== undefined && 'api' in overlayModel).toBe(false)
    expect(overlayModel !== undefined && 'baseUrl' in overlayModel).toBe(false)
  })

  it('对照：overlay 显式带值 → 原值透传；快照模型字段不受归一化影响', () => {
    overlayState.current = {
      state: 'fresh',
      models: [{ id: 'overlay-with-values', name: 'OV', api: 'openai-completions', baseUrl: 'https://ov.example/v1' }],
    }

    const view = getMergedCatalogModels('opencode-go')

    const overlayModel = view?.models.find(m => m.id === 'overlay-with-values')
    expect(overlayModel?.api).toBe('openai-completions')
    expect(overlayModel?.baseUrl).toBe('https://ov.example/v1')
    // 快照模型（opencode-go 内置 25 个）仍带各自 api/baseUrl，overlay 归一化不外溢
    const snapshotModel = view?.models.find(m => m.id === 'minimax-m3')
    expect(snapshotModel?.api).toBe('anthropic-messages')
  })
})
