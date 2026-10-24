/**
 * retry-rules 域单测（remote-config 域 3，subagent-observability §3.3.12）：
 * 内置层合并视图（基线 ⊕ 远程）、ext-config RMW 写侧（customRules 全量替换 +
 * effectiveRules 合并持久段重算）、远程生效落盘、读侧坏文件回落、校验拒绝路径。
 * 策略同 remote-provider-sync.test.ts（tmp dataDir + fetch mock + resetModules）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RetryableErrorRule } from '@taiji/shared'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rrr-test-'))
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

const EXT_CONFIG_PATH = () => join(dataDir, 'agent', 'config', 'retry-rules-ext-config.json')

async function loadFresh() {
  vi.resetModules()
  return import('../remote-retry-rules.js')
}

/** mock 远程拉取：body 为远程域 payload；记调用供断言。 */
function mockRemoteFetch(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { etag: '"t1"' } })))
}

function builtinRule(id: string, verdict: RetryableErrorRule['verdict'] = 'retryable'): RetryableErrorRule {
  return {
    id,
    name: `基线 ${id}`,
    verdict,
    match: [{ kind: 'pattern', pattern: `marker-${id}` }],
    class: 'provider',
    source: 'builtin',
  }
}

function writeExtConfig(content: unknown): void {
  mkdirSync(join(dataDir, 'agent', 'config'), { recursive: true })
  writeFileSync(EXT_CONFIG_PATH(), JSON.stringify(content, null, 2), 'utf-8')
}

describe('getBuiltinRetryRules 合并视图', () => {
  it('无远程缓存 = 编译期基线原样（source 恒 builtin，非空——基线随包在场）', async () => {
    const mod = await loadFresh()
    const rules = mod.getBuiltinRetryRules()
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.every((r: RetryableErrorRule) => r.source === 'builtin')).toBe(true)
  })

  it('远程覆盖：同 id 覆盖（source 归一 remote）+ 新 id 追加到尾部', async () => {
    mockRemoteFetch({
      version: 1,
      rules: [
        { ...builtinRule('generic-429'), verdict: 'conditional', name: '远程修正版' },
        builtinRule('remote-new'),
      ],
    })
    const mod = await loadFresh()
    // 先拉取落缓存（fetch mock）
    await mod.syncRetryRulesRemote()
    const rules = mod.getBuiltinRetryRules()
    const overridden = rules.find((r: RetryableErrorRule) => r.id === 'generic-429')
    expect(overridden?.source).toBe('remote')
    expect(overridden?.verdict).toBe('conditional')
    const appended = rules.find((r: RetryableErrorRule) => r.id === 'remote-new')
    expect(appended?.source).toBe('remote')
    // 基线其余条目保持原位原样
    const untouched = rules.find((r: RetryableErrorRule) => r.id === 'generic-5xx')
    expect(untouched?.source).toBe('builtin')
  })
})

describe('setRetryRulesCustom 写侧（唯一写方）', () => {
  it('合法保存：customRules 全量落盘 + effectiveRules = 内置层 ⊕ custom（source 归一）', async () => {
    const mod = await loadFresh()
    const custom: RetryableErrorRule = { ...builtinRule('my-rule'), source: 'custom' }
    const result = mod.setRetryRulesCustom([custom])
    expect(result).toEqual({ ok: true })
    const raw = JSON.parse(readFileSync(EXT_CONFIG_PATH(), 'utf-8'))
    expect(raw.customRules).toHaveLength(1)
    expect(raw.customRules[0].source).toBe('custom')
    const ids = raw.effectiveRules.map((r: RetryableErrorRule) => `${r.id}:${r.source}`)
    expect(ids).toContain('my-rule:custom')
    expect(ids.some((s: string) => s.startsWith('generic-429:builtin'))).toBe(true)
  })

  it('校验失败不写盘（verdict 词表外）', async () => {
    const mod = await loadFresh()
    const result = mod.setRetryRulesCustom([{ ...builtinRule('bad'), verdict: 'bogus' as never, source: 'custom' }])
    expect(result.ok).toBe(false)
    expect(existsSync(EXT_CONFIG_PATH())).toBe(false)
  })

  it('自定义 id 与内置层重叠拒绝（错误信息含恢复动作）', async () => {
    const mod = await loadFresh()
    const result = mod.setRetryRulesCustom([{ ...builtinRule('generic-429'), source: 'custom' }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(';')).toContain('内置预设')
  })

  it('保存合并远程覆盖层：远程缓存有内容时 effectiveRules 含 remote 条目', async () => {
    mockRemoteFetch({ version: 1, rules: [builtinRule('remote-only')] })
    const mod = await loadFresh()
    await mod.syncRetryRulesRemote()
    mod.setRetryRulesCustom([])
    const raw = JSON.parse(readFileSync(EXT_CONFIG_PATH(), 'utf-8'))
    expect(raw.effectiveRules.map((r: RetryableErrorRule) => r.id)).toContain('remote-only')
  })
})

describe('syncRetryRulesRemote 远程生效落盘', () => {
  it('ext-config 不在场：补写基线落盘（§3.3.12 G1 基线默认生效——缺席不等于功能缺席）', async () => {
    mockRemoteFetch({ version: 1, rules: [builtinRule('remote-a')] })
    const mod = await loadFresh()
    const result = await mod.syncRetryRulesRemote()
    expect(result.refreshed).toBe(true)
    expect(existsSync(EXT_CONFIG_PATH())).toBe(true)
    const raw = JSON.parse(readFileSync(EXT_CONFIG_PATH(), 'utf-8'))
    expect(raw.customRules).toEqual([])
    // 基线规则在场（编译期基线 ⊕ 本次远程覆盖）
    expect(raw.effectiveRules.length).toBeGreaterThan(0)
    expect(raw.effectiveRules.map((r: RetryableErrorRule) => r.id)).toContain('remote-a')
  })

  it('[G1b] extension startupConfig 占位文件（空 effectiveRules）→ 同步无条件重算补基线', async () => {
    // 真实启动顺序：extension taiji.startupConfig 在 t<2s 先建占位（空 effectiveRules）
    writeExtConfig({ version: 1, customRules: [], effectiveRules: [] })
    mockRemoteFetch({ version: 1, rules: [builtinRule('remote-b')] })
    const mod = await loadFresh()
    await mod.syncRetryRulesRemote()
    const raw = JSON.parse(readFileSync(EXT_CONFIG_PATH(), 'utf-8'))
    expect(raw.customRules).toEqual([])
    expect(raw.effectiveRules.length).toBeGreaterThan(0) // 占位被派生段覆盖
    expect(raw.effectiveRules.map((r: RetryableErrorRule) => r.id)).toContain('remote-b')
  })

  it('ext-config 在场：refreshed 时 effectiveRules 重算落盘，customRules 保留', async () => {
    writeExtConfig({
      version: 1,
      customRules: [{ ...builtinRule('keep-me'), source: 'custom' }],
      effectiveRules: [{ ...builtinRule('stale') }],
    })
    mockRemoteFetch({ version: 1, rules: [builtinRule('fresh-remote')] })
    const mod = await loadFresh()
    const result = await mod.syncRetryRulesRemote()
    expect(result.refreshed).toBe(true)
    const raw = JSON.parse(readFileSync(EXT_CONFIG_PATH(), 'utf-8'))
    expect(raw.customRules.map((r: RetryableErrorRule) => r.id)).toEqual(['keep-me'])
    expect(raw.effectiveRules.map((r: RetryableErrorRule) => r.id)).toContain('fresh-remote')
    expect(raw.effectiveRules.map((r: RetryableErrorRule) => r.id)).not.toContain('stale')
  })
})

describe('readRetryRulesExtConfig 读侧', () => {
  it('缺失回落空集', async () => {
    const mod = await loadFresh()
    expect(mod.readRetryRulesExtConfig()).toEqual({ version: 1, customRules: [], effectiveRules: [] })
  })

  it('坏 JSON / 形状非法回落空集（不抛错）', async () => {
    mkdirSync(join(dataDir, 'agent', 'config'), { recursive: true })
    writeFileSync(EXT_CONFIG_PATH(), '{not json', 'utf-8')
    const mod = await loadFresh()
    expect(mod.readRetryRulesExtConfig()).toEqual({ version: 1, customRules: [], effectiveRules: [] })
    writeFileSync(EXT_CONFIG_PATH(), JSON.stringify({ version: 2 }), 'utf-8')
    expect(mod.readRetryRulesExtConfig()).toEqual({ version: 1, customRules: [], effectiveRules: [] })
  })
})
