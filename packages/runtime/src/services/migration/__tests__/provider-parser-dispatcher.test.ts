/**
 * provider-parser dispatcher 测试（W3）。
 *
 * 测试 parseProviders(source, homeDir) 的路由逻辑：
 *   - T9：对每个 source 调用，验证路由到对应解析器（spy 各解析器模块，断言被调用且返回值透传）。
 *   - T8：mock existsSync 让某源目录返回 false → parseProviders 返回 null。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/migration/__tests__/provider-parser-dispatcher.test.ts
 *
 * 策略：vi.mock 各真实解析器模块，控制其返回值；验证 dispatcher 调用了对应解析器（参数 + 返回值透传）。
 * 不 mock provider-parser.ts 本身（被测对象）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.mock 各解析器模块（在 import 前，vitest hoist）──────────────
// 每个 mock 默认返回 null（源未安装），spy 形态便于断言被调用。
vi.mock('../parsers/pi-parser.js', () => ({
  parsePiProviders: vi.fn(() => null),
}))
vi.mock('../parsers/zcode-parser.js', () => ({
  parseZcodeProviders: vi.fn(() => null),
}))
vi.mock('../parsers/codex-parser.js', () => ({
  parseCodexProviders: vi.fn(() => null),
}))
vi.mock('../parsers/claude-parser.js', () => ({
  parseClaudeProviders: vi.fn(() => null),
}))

// ── import（在 mock 之后，拿到 mock 版本）──────────────────────────
import { parseProviders } from '../provider-parser.js'
import { parsePiProviders } from '../parsers/pi-parser.js'
import { parseZcodeProviders } from '../parsers/zcode-parser.js'
import { parseCodexProviders } from '../parsers/codex-parser.js'
import { parseClaudeProviders } from '../parsers/claude-parser.js'
import type { ParseResult } from '../provider-parser.js'

// ── fixture ──────────────────────────────────────────────────

/** 构造一个可识别的 ParseResult（用于验证返回值透传）。 */
function fakeResult(tag: string): ParseResult {
  return {
    providers: [
      {
        _sourceName: tag,
        _apiKeyExtracted: false,
        _credentialType: 'missing',
        _warnings: [],
        api: 'openai-completions',
        models: [{ id: 'm', name: 'm' }],
      },
    ],
  }
}

describe('parseProviders dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 重置默认 mock 行为：返回 null（源未安装）
    vi.mocked(parsePiProviders).mockReturnValue(null)
    vi.mocked(parseZcodeProviders).mockReturnValue(null)
    vi.mocked(parseCodexProviders).mockReturnValue(null)
    vi.mocked(parseClaudeProviders).mockReturnValue(null)
  })

  // ── T9：每个 source 路由到对应解析器（参数 + 返回值透传）──────────
  it('T9: source=pi → 调 parsePiProviders 并透传返回值', () => {
    vi.mocked(parsePiProviders).mockReturnValue(fakeResult('pi-result'))

    const out = parseProviders('pi', '/home/test')

    expect(parsePiProviders).toHaveBeenCalledWith('/home/test')
    expect(parseZcodeProviders).not.toHaveBeenCalled()
    expect(parseCodexProviders).not.toHaveBeenCalled()
    expect(parseClaudeProviders).not.toHaveBeenCalled()
    expect(out).not.toBeNull()
    expect(out!.providers[0]._sourceName).toBe('pi-result')
  })

  it('T9: source=zcode → 调 parseZcodeProviders 并透传返回值', () => {
    vi.mocked(parseZcodeProviders).mockReturnValue(fakeResult('zcode-result'))

    const out = parseProviders('zcode', '/home/test')

    expect(parseZcodeProviders).toHaveBeenCalledWith('/home/test')
    expect(parsePiProviders).not.toHaveBeenCalled()
    expect(out!.providers[0]._sourceName).toBe('zcode-result')
  })

  it('T9: source=codex → 调 parseCodexProviders 并透传返回值', () => {
    vi.mocked(parseCodexProviders).mockReturnValue(fakeResult('codex-result'))

    const out = parseProviders('codex', '/home/test')

    expect(parseCodexProviders).toHaveBeenCalledWith('/home/test')
    expect(parsePiProviders).not.toHaveBeenCalled()
    expect(out!.providers[0]._sourceName).toBe('codex-result')
  })

  it('T9: source=claude → 调 parseClaudeProviders 并透传返回值', () => {
    vi.mocked(parseClaudeProviders).mockReturnValue(fakeResult('claude-result'))

    const out = parseProviders('claude', '/home/test')

    expect(parseClaudeProviders).toHaveBeenCalledWith('/home/test')
    expect(parsePiProviders).not.toHaveBeenCalled()
    expect(out!.providers[0]._sourceName).toBe('claude-result')
  })

  // ── T9b：null 透传（源未安装）──────────────────────────────────
  it('T9b: 解析器返回 null → parseProviders 也返回 null', () => {
    vi.mocked(parseCodexProviders).mockReturnValue(null)

    const out = parseProviders('codex', '/home/test')

    expect(parseCodexProviders).toHaveBeenCalledWith('/home/test')
    expect(out).toBeNull()
  })

  // ── T8：解析器返回 null 即「源未安装」（dispatcher 不查 existsSync）──
  // 注：parseProviders 是薄转发层——源目录存在性由各解析器内部 existsSync 判定，
  // 返回 null 表示「源未安装」。这里验证 dispatcher 正确把 null 传出去（不抛错、不兜底）。
  it('T8: 各解析器（mock existsSync 让源目录返回 false）返回 null → dispatcher 返回 null', () => {
    // 这里直接用 mock 返回 null 模拟「源目录不存在」场景（真实解析器内部 existsSync 判定）。
    // 各解析器的 existsSync→null 行为已由各自单元测试覆盖（pi-parser T8 / codex-parser T8 等）。
    for (const source of ['pi', 'zcode', 'codex', 'claude'] as const) {
      const out = parseProviders(source, '/nonexistent/home')
      expect(out).toBeNull()
    }
  })

  // ── B1：parser 抛异常时 dispatcher 转为 { providers: [], parseError }，不中断调用方 ──
  it('B1: 解析器抛异常 → dispatcher 兜底返回 { providers: [], parseError }，不向上抛', () => {
    vi.mocked(parsePiProviders).mockImplementation(() => {
      throw new Error('unexpected parser crash')
    })

    const out = parseProviders('pi', '/home/test')

    expect(out).not.toBeNull()
    expect(out!.providers).toEqual([])
    expect(out!.parseError).toMatch(/failed to parse pi/)
    expect(out!.parseError).toContain('unexpected parser crash')
  })

  // ── B1b：未知 source → null（与「源未安装」同处理）────────────────
  it('B1b: 未知 source（编译期 union 之外）→ 返回 null', () => {
    // 用 as any 模拟运行时非法 source（WS 异常 payload 场景）
    const out = parseProviders('unknown' as never, '/home/test')
    expect(out).toBeNull()
  })
})
