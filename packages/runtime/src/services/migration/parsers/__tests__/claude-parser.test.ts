/**
 * claude-parser 测试（W3）。
 *
 * 测试策略：临时目录 + 真实 fixture JSON 写文件（避免 mock fs）。
 * 运行：cd packages/runtime && npx vitest run src/services/migration/parsers/__tests__/claude-parser.test.ts
 *
 * 覆盖：
 *   - T6：正常解析（1 占位 provider），api=anthropic-messages，apiKeyExtracted 恒 false，warning 含 keychain 提示。
 *   - T7：settings.json 损坏 → parseError。
 *   - T8：源目录不存在 → null。
 *   - T9：安全红线——settings.json 含 apiKeyHelper 字段，绝不被执行（不读 keychain）。
 *   - T10：model 缺失 → 用默认 claude-default。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseClaudeProviders } from '../claude-parser.js'
import claudeSettingsFixture from './fixtures/claude-settings.json' with { type: 'json' }

describe('parseClaudeProviders', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'claude-parser-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 把 settings.json 写到 <home>/.claude/settings.json。 */
  function writeClaudeSettings(content: string): string {
    const claudeDir = join(home, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    const dest = join(claudeDir, 'settings.json')
    writeFileSync(dest, content)
    return dest
  }

  // ── T6：正常解析（1 占位 provider）─────────────────────────────────
  it('T6: 解析 1 占位 provider，api=anthropic-messages，apiKeyExtracted 恒 false', () => {
    writeClaudeSettings(JSON.stringify(claudeSettingsFixture))

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    expect(result!.parseError).toBeUndefined()

    const provider = result!.providers[0]
    expect(provider.api).toBe('anthropic-messages')
    expect(provider.name).toBe('Claude Code (imported)')
    expect(provider._sourceName).toBe('claude-imported')
    // 安全红线：恒不提取 key
    expect(provider._apiKeyExtracted).toBe(false)
    expect(provider.apiKey).toBeUndefined()
    // baseUrl / model 从 settings.json 提取
    expect(provider.baseUrl).toBe('http://test.example.com')
    expect(provider.models).toHaveLength(1)
    expect(provider.models![0].id).toBe('claude-haiku')
    // warning 含 keychain 提示
    expect(provider._warnings.some((w) => w.toLowerCase().includes('keychain'))).toBe(true)
    expect(provider._warnings.some((w) => w.toLowerCase().includes('manually'))).toBe(true)
  })

  // ── T7：settings.json 损坏 → parseError ────────────────────────────
  it('T7: settings.json JSON 损坏 → parseError 含 cannot parse', () => {
    writeClaudeSettings('{ broken')

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(0)
    expect(result!.parseError).toMatch(/cannot parse claude settings\.json/)
  })

  // ── T8：源目录不存在 → null ────────────────────────────────────────
  it('T8: ~/.claude/settings.json 不存在 → 返回 null', () => {
    expect(existsSync(join(home, '.claude'))).toBe(false)

    const result = parseClaudeProviders(home)

    expect(result).toBeNull()
  })

  // ── T9：安全红线——apiKeyHelper 绝不执行 ────────────────────────────
  it('T9: settings.json 含 apiKeyHelper，解析不执行它（apiKeyExtracted 恒 false，无 crash）', () => {
    // fixture 已含 apiKeyHelper 字段（指向 /Users/testuser/.claude/get-key.sh）
    writeClaudeSettings(JSON.stringify(claudeSettingsFixture))

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    // 即使有 apiKeyHelper，也不执行，apiKeyExtracted 恒 false
    expect(provider._apiKeyExtracted).toBe(false)
    expect(provider.apiKey).toBeUndefined()
    expect(result!.parseError).toBeUndefined() // 未尝试执行脚本所以无错
  })

  // ── T10：model 缺失 → 默认 claude-default ──────────────────────────
  it('T10: settings.json 无 model 字段 → 用默认 claude-default', () => {
    writeClaudeSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.x.com' } }))

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider.models![0].id).toBe('claude-default')
    expect(provider.baseUrl).toBe('https://api.x.com')
  })

  // ── T11：env 缺失 → baseUrl undefined，不 crash ────────────────────
  it('T11: settings.json 无 env 字段 → baseUrl undefined，不 crash', () => {
    writeClaudeSettings(JSON.stringify({ model: 'claude-sonnet-4-5' }))

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    const provider = result!.providers[0]
    expect(provider.baseUrl).toBeUndefined()
    expect(provider.models![0].id).toBe('claude-sonnet-4-5')
  })

  // ── B1：settings.json 内容为 null（JSON.parse('null') 成功）→ 不 crash ──
  it('B1: settings.json 内容为 null → 不 crash，仍产出 1 个占位 provider（用默认 model）', () => {
    writeClaudeSettings('null')

    const result = parseClaudeProviders(home)

    expect(result).not.toBeNull()
    expect(result!.providers).toHaveLength(1)
    const provider = result!.providers[0]
    expect(provider.models![0].id).toBe('claude-default')
    expect(provider.baseUrl).toBeUndefined()
  })
})
