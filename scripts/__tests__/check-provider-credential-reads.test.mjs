/**
 * check-provider-credential-reads.mjs 双守卫单测（C-proc-14 / C-proc-15）。
 *
 * 正则过宽阻塞正常代码 / 过窄防线静默失效都必须回归捕捉——五组行为机器锁定：
 *   R1 守卫 A 三模式命中（getApiKeyForProvider / readAuthCredentials / getProviderConfig(...).apiKey）
 *   R2 守卫 A 白名单放行（唯一通道本体）+ 白名单收口计数（size===1，膨胀 = 收口失效信号）
 *   R3 守卫 B upsertProvider 直调命中 + 白名单（接口签名声明同形）放行 + 白名单结构完整性
 *   R4 词边界与注释剔除（readAuthCredentialKey 近形不误伤 / 行内注释提及不违规）
 *   R5 扫描范围边界（*.test.ts / __tests__/ / *.d.ts 不扫——测试文件允许引用符号做防回归断言）
 *
 * 全部用 mkdtemp 自建自删的 fixture 目录验证，不对真实仓库跑正则（真实仓库仅脚本
 * 主流程自身 pre-commit 扫描；本测试禁碰共享路径，对齐 fs-guard 纪律）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  scanDir,
  IDENTIFIER_RES,
  GET_CONFIG_APIKEY_RE,
  UPSERT_CALL_RE,
  GUARD_A_ALLOWLIST,
  GUARD_B_ALLOWLIST,
} from '../check-provider-credential-reads.mjs'

// 本测试位于 scripts/__tests__/，仓库根需上跳两级（白名单条目存在性校验用）
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

// ---------- fixture 工具 ----------

const tmpDirs = []
function makeFixture(relFiles) {
  const root = mkdtempSync(join(tmpdir(), 'pcred-guard-test-'))
  tmpDirs.push(root)
  for (const [rel, content] of Object.entries(relFiles)) {
    const full = join(root, rel)
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function violationsOf(root) {
  return scanDir(root).violations
}

// ---------- R1 守卫 A 三模式命中 ----------

describe('R1 守卫 A 三模式（白名单外生产代码）', () => {
  it('标识符 getApiKeyForProvider 命中（模式 1）', () => {
    const root = makeFixture({ 'svc/a.ts': "const k = getApiKeyForProvider(id)\n" })
    expect(violationsOf(root)).toEqual([
      { file: 'svc/a.ts', line: 1, guard: 'A', hit: 'getApiKeyForProvider' },
    ])
  })
  it('标识符 readAuthCredentials 命中（模式 2）', () => {
    const root = makeFixture({ 'svc/b.ts': "const c = readAuthCredentials(p)\n" })
    expect(violationsOf(root)).toEqual([
      { file: 'svc/b.ts', line: 1, guard: 'A', hit: 'readAuthCredentials' },
    ])
  })
  it('getProviderConfig(...).apiKey 的 ?. 与 . 两形态都命中（模式 3）', () => {
    const root = makeFixture({
      'svc/c.ts': "const k = getProviderConfig(id)?.apiKey\nconst j = getProviderConfig(id).apiKey\n",
    })
    const hits = violationsOf(root)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ file: 'svc/c.ts', line: 1, guard: 'A', hit: 'getProviderConfig(...).apiKey' })
    expect(hits[1]).toMatchObject({ file: 'svc/c.ts', line: 2, guard: 'A' })
  })
  it('白名单外同名内容（同 resolver 本体读取形态）报红——放行只认白名单文件', () => {
    const root = makeFixture({
      'svc/copycat.ts': "const k = getProviderConfig(id)?.apiKey\n",
    })
    expect(violationsOf(root)).toHaveLength(1)
  })
})

// ---------- R2 守卫 A 白名单 ----------

describe('R2 守卫 A 白名单放行 + 收口计数', () => {
  it('唯一白名单文件（resolver 本体）同形态读取放行', () => {
    expect([...GUARD_A_ALLOWLIST]).toEqual(['services/auth/provider-credential-resolver.ts'])
    const root = makeFixture({
      'services/auth/provider-credential-resolver.ts': "const k = getProviderConfig(id)?.apiKey\nconst s = readAuthCredentials\n",
    })
    expect(violationsOf(root)).toEqual([])
  })
  it('白名单 size===1（清零/膨胀都是收口失效信号，脚本头注释 D3）', () => {
    expect(GUARD_A_ALLOWLIST.size).toBe(1)
  })
})

// ---------- R3 守卫 B ----------

describe('R3 守卫 B upsertProvider 直调', () => {
  it('直调与成员调用都命中', () => {
    const root = makeFixture({
      'svc/d.ts': "upsertProvider(cfg)\nstore.upsertProvider(cfg)\n",
    })
    const hits = violationsOf(root)
    expect(hits).toHaveLength(2)
    for (const h of hits) expect(h).toMatchObject({ guard: 'B', hit: 'upsertProvider(' })
  })
  it('白名单文件（接口签名声明等）放行', () => {
    expect(GUARD_B_ALLOWLIST.has('services/ports/config.ts')).toBe(true)
    const root = makeFixture({
      'services/ports/config.ts': "  upsertProvider(provider: PiProviderConfig): void\n",
    })
    expect(violationsOf(root)).toEqual([])
  })
  it('白名单结构完整性：每个条目文件真实存在（豁免表漂移 = 防线假死，对齐 layout-literals R2 先例）', () => {
    for (const rel of GUARD_B_ALLOWLIST) {
      expect(existsSync(join(ROOT, 'packages/runtime/src', rel)), `白名单条目不存在：${rel}`).toBe(true)
    }
  })
  it('白名单上限 8（脚本恢复动作：>8 = 收口失效信号）', () => {
    expect(GUARD_B_ALLOWLIST.size).toBeLessThanOrEqual(8)
  })
})

// ---------- R4 词边界与注释剔除 ----------

describe('R4 词边界与注释剔除', () => {
  it('readAuthCredentialKey 近形名不误伤（\\b 词边界）', () => {
    const root = makeFixture({ 'svc/e.ts': "const k = readAuthCredentialKey(c)\n" })
    expect(violationsOf(root)).toEqual([])
  })
  it('行内注释提及守卫符号不违规（历史说明先例）', () => {
    const root = makeFixture({
      'svc/f.ts': "// 历史说明：readAuthCredentials 与 getApiKeyForProvider 已删除\nconst x = 1\n",
    })
    expect(violationsOf(root)).toEqual([])
  })
  it('正则对象词边界直测（导出面冒烟）', () => {
    expect(IDENTIFIER_RES.readAuthCredentials.test('x readAuthCredentials y')).toBe(true)
    expect(IDENTIFIER_RES.readAuthCredentials.test('readAuthCredentialsKey')).toBe(false)
    expect(GET_CONFIG_APIKEY_RE.test('getProviderConfig(id)?.apiKey')).toBe(true)
    expect(UPSERT_CALL_RE.test('store.upsertProvider(cfg)')).toBe(true)
  })
})

// ---------- R5 扫描范围边界 ----------

describe('R5 扫描范围边界', () => {
  it('*.test.ts 与 __tests__/ 目录不扫描（测试允许引用符号做防回归断言）', () => {
    const root = makeFixture({
      'svc/g.test.ts': "expect(src).not.toContain('readAuthCredentials')\n",
      'svc/__tests__/h.ts': "const k = getApiKeyForProvider(id)\n",
    })
    expect(violationsOf(root)).toEqual([])
  })
  it('*.d.ts 不扫描', () => {
    const root = makeFixture({ 'svc/types.d.ts': "declare function upsertProvider(c: unknown): void\n" })
    expect(violationsOf(root)).toEqual([])
  })
  it('非 .ts 文件不扫描', () => {
    const root = makeFixture({ 'svc/notes.md': 'readAuthCredentials mention\n' })
    expect(violationsOf(root)).toEqual([])
  })
})
