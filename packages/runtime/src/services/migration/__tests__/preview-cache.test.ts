/**
 * preview-cache 测试（W2，cw-2026-07-26-migration-other-agents）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach/afterEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/migration/__tests__/preview-cache.test.ts
 *
 * 覆盖：
 *   - T1：5min TTL（vi.useFakeTimers）。299999ms 内 consumePreview 非 null，300001ms 后返回 null。
 *   - T2：consumePreview 不删（apply 成功才 deletePreview）。create → consume(非null) →
 *         再 consume(仍非null) → delete → consume(null)。
 *
 * 每个 test 前 _resetCacheForTest() 清缓存（vi.useFakeTimers 场景避免跨用例污染）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createPreview,
  consumePreview,
  deletePreview,
  _resetCacheForTest,
} from '../preview-cache.js'
import type { ParsedProvider } from '../provider-parser.js'

// ── fixture ──────────────────────────────────────────────────

/** 最小 ParsedProvider fixture（含 apiKey 明文，测试 TTL 语义不关心字段细节）。 */
function fixtureProvider(overrides: Partial<ParsedProvider> = {}): ParsedProvider {
  return {
    _sourceName: 'test-provider',
    _apiKeyExtracted: true,
    _credentialType: 'plaintext',
    _warnings: [],
    api: 'anthropic-messages',
    models: [{ id: 'm1', name: 'M1' }],
    apiKey: 'sk-test',
    ...overrides,
  }
}

// ── tests ────────────────────────────────────────────────────

describe('preview-cache (TTL + consume/delete 语义)', () => {
  beforeEach(() => {
    _resetCacheForTest()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('T1: 5min TTL 内 consumePreview 返回条目，超时后返回 null', () => {
    const importId = createPreview('pi', [fixtureProvider()])

    // 299999ms（< 5min）仍有效
    vi.advanceTimersByTime(299_999)
    expect(consumePreview(importId)).not.toBeNull()

    // 再前进 300001ms（累计超过 5min TTL）→ pruneExpired 清理 → null
    vi.advanceTimersByTime(300_001)
    expect(consumePreview(importId)).toBeNull()
  })

  it('T1b: 恰好 300000ms（边界）后仍有效（now - createdAt > TTL_MS 才过期）', () => {
    const importId = createPreview('zcode', [fixtureProvider({ _sourceName: 'b' })])

    // advanceTimersByTime 推进的是 Date.now()。createPreview 时记录 createdAt = 当前 fake now。
    // 推进 300000ms 后 now - createdAt === TTL_MS，不满足 > TTL_MS，故未过期。
    vi.advanceTimersByTime(300_000)
    expect(consumePreview(importId)).not.toBeNull()
  })

  it('T2: consumePreview 不删——多次 consume 都返回同一非 null 条目；deletePreview 后才 null', () => {
    const providers = [fixtureProvider({ _sourceName: 'a' }), fixtureProvider({ _sourceName: 'b' })]
    const importId = createPreview('codex', providers)

    // 第一次 consume（apply 流程取数据）——不删
    const first = consumePreview(importId)
    expect(first).not.toBeNull()
    expect(first?.providers).toHaveLength(2)
    expect(first?.source).toBe('codex')

    // 第二次 consume 仍非 null（apply 失败可重试，缓存不丢）
    const second = consumePreview(importId)
    expect(second).not.toBeNull()
    expect(second?.providers).toBe(first?.providers)

    // deletePreview 后（apply 成功）才 null
    deletePreview(importId)
    expect(consumePreview(importId)).toBeNull()
  })

  it('consumePreview 对不存在的 importId 返回 null', () => {
    expect(consumePreview('nonexistent-id')).toBeNull()
  })

  it('deletePreview 对不存在的 importId 不抛异常（幂等）', () => {
    expect(() => deletePreview('nonexistent-id')).not.toThrow()
  })
})
