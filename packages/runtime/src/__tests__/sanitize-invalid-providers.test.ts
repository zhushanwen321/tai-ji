import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInvalidProvider, sanitizeInvalidProviders, setModelsPath, type PiProviderConfig } from '../infra/pi/pi-provider-store.js'

let tmpDir: string
let modelsPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sanitize-providers-'))
  modelsPath = join(tmpDir, 'models.json')
  setModelsPath(modelsPath)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function writeModelsFixture(providers: Record<string, unknown>): void {
  writeFileSync(modelsPath, JSON.stringify({ providers }))
}

function readModelsProviders(): Record<string, unknown> {
  return (JSON.parse(readFileSync(modelsPath, 'utf-8'))).providers
}

describe('isInvalidProvider', () => {
  // [W1b 语义变更] 判定对齐 pi 0.84.1 applyModelsJson 八字段抛错条件
  // （provider-composer.js:86-93）：models/baseUrl/headers/compat/modelOverrides/
  //  apiKey/oauth/authHeader 任一在场即合法，全空才算无效。

  it('W1b-T1 [W1b 语义变更]: 只配 apiKey 的 provider 合法（旧五字段判定误判无效 → 误删数据丢失 bug）', () => {
    // 旧判定（0.80.3 五字段）把 {apiKey, name} 判为空壳 → sanitize 物理删除
    expect(isInvalidProvider({ apiKey: 'sk-x', name: 'Verify A' })).toBe(false)
  })

  it('W1b-T2 [W1b 语义变更]: 只配 oauth 的 provider 合法（pi 端字段，宽松键检查不遗漏）', () => {
    // oauth 是 pi 端 provider 级字段（zod Type.Literal("radius")），taiji
    // PiProviderConfig 未声明。模拟脏数据：Object.assign 绕过 excess property check
    const provider: PiProviderConfig = { name: 'Radius' }
    Object.assign(provider, { oauth: 'radius' })
    expect(isInvalidProvider(provider)).toBe(false)
  })

  it('W1b-T3 [W1b 语义变更]: 只配 authHeader 的 provider 合法（显式 false 也算在场）', () => {
    // pi 检查 `config.authHeader === undefined`（非 falsiness）——false 是"在场"即不触发
    // must specify 抛错。同构用 === undefined，禁改 falsiness。
    expect(isInvalidProvider({ authHeader: true, name: 'X' })).toBe(false)
    expect(isInvalidProvider({ authHeader: false, name: 'X' })).toBe(false)
  })

  it('W1b-T4: 八字段全缺的真空壳判定无效', () => {
    // concurrency-verify-A 场景：外部脚本写入的 fixture 空壳（无任何八字段）
    expect(isInvalidProvider({ name: 'Verify A' })).toBe(true)
    expect(isInvalidProvider({})).toBe(true)
  })

  it('W1b-T5: apiKey 空串视同未 specify（pi falsiness 同构），八字段全缺判定无效', () => {
    expect(isInvalidProvider({ apiKey: '', name: 'X' })).toBe(true)
  })

  it('WTC2: 有 baseUrl 的 provider 合法', () => {
    expect(isInvalidProvider({ baseUrl: 'https://api.x.com', apiKey: 'sk' })).toBe(false)
  })

  it('WTC3: models 非空的 provider 合法', () => {
    expect(isInvalidProvider({ models: [{ id: 'm1', name: 'M1' }] })).toBe(false)
  })

  it('WTC4: models 空数组视为未 specify，判定无效', () => {
    // 空数组无法提供任何模型，与 undefined 等效（pi `!config.models?.length`）
    expect(isInvalidProvider({ models: [] })).toBe(true)
  })

  it('WTC5: 有 headers 的 provider 合法（cookie provider 不误杀）', () => {
    expect(isInvalidProvider({ headers: { Cookie: 'session=x' } })).toBe(false)
  })

  it('WTC6: 有 modelOverrides 的 provider 合法', () => {
    expect(isInvalidProvider({ modelOverrides: { 'gpt-4': { contextWindow: 8192 } } })).toBe(false)
  })

  it('WTC7: 有 compat（pi 端脏数据 raw 键）的 provider 合法', () => {
    // compat 是 pi 端 provider 级字段，taiji PiProviderConfig 未声明但运行时脏数据可能含。
    // 模拟脏数据：构造合法对象后注入未声明字段（Object.assign 绕过 excess property check，无类型断言）
    const provider: PiProviderConfig = { apiKey: 'sk' }
    Object.assign(provider, { compat: { foo: 1 } })
    expect(isInvalidProvider(provider)).toBe(false)
  })

  it('WTC13 [W1b 语义变更]: baseUrl 空串 + apiKey 在场 → 合法（apiKey 满足八字字段任一）', () => {
    // 旧判定：baseUrl 空串（falsiness）+ 五字段全缺 → 无效。0.84.1：apiKey 在场即不触发
    // must specify 抛错（baseUrl 空串被 zod minLength:1 拒绝是 schema 层，不归 sanitize 管）
    expect(isInvalidProvider({ baseUrl: '', apiKey: 'sk' })).toBe(false)
  })

  it('WTC14: modelOverrides 空对象判定无效（pi applyModelsJson 要求 Object.keys().length>0）', () => {
    expect(isInvalidProvider({ modelOverrides: {} })).toBe(true)
  })

  it('WTC15: provider 值为 null 判定无效（zod ProviderConfigSchema 拒绝非对象值）', () => {
    expect(isInvalidProvider(null as unknown as PiProviderConfig)).toBe(true)
  })
})

describe('sanitizeInvalidProviders', () => {
  it('W1b-V2 [W1b 语义变更]: 只配 apiKey / oauth / authHeader 的合法 provider 全部完好，真空壳被清', () => {
    // W1b 主验收（V2「provider 零丢失」）：真实文件系统 round-trip。旧五字段判定会把
    // key-only 判为空壳物理删除（数据丢失）；oauth / authHeader-only 同理是 0.84.1 新合法态。
    writeModelsFixture({
      'key-only': { apiKey: 'sk-key-only', name: 'Key Only' },
      'oauth-only': { name: 'OAuth Only', oauth: 'radius' },
      'authheader-only': { name: 'AuthHeader Only', authHeader: true },
      'empty-shell': { name: 'Shell' },
    })
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual(['empty-shell'])
    expect(result.repaired).toEqual([])
    const remaining = readModelsProviders()
    expect(Object.keys(remaining).sort())
      .toEqual(['authheader-only', 'key-only', 'oauth-only'])
    // 三个合法条目逐字段原样保留（未被触碰/重写丢失字段）
    expect(remaining['key-only']).toEqual({ apiKey: 'sk-key-only', name: 'Key Only' })
    expect(remaining['oauth-only']).toEqual({ name: 'OAuth Only', oauth: 'radius' })
    expect(remaining['authheader-only']).toEqual({ name: 'AuthHeader Only', authHeader: true })
  })

  it('WTC8: 剔除空壳 provider，保留合法 provider', () => {
    // [W1b 语义变更] 空壳 fixture 从 {apiKey, name} 改为无 apiKey 纯空壳（旧形态已合法）
    writeModelsFixture({
      legal1: { baseUrl: 'x' },
      legal2: { models: [{ id: 'm1' }] },
      'concurrency-verify-A': { name: 'Verify A' },
    })
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual(['concurrency-verify-A'])
    const remaining = readModelsProviders()
    expect(Object.keys(remaining).sort()).toEqual(['legal1', 'legal2'])
  })

  it('WTC9: 无无效 provider 时幂等不触发写（mtime 不变 + 内容不变）', () => {
    writeModelsFixture({
      legal1: { baseUrl: 'x' },
      legal2: { models: [{ id: 'm' }] },
    })
    const mtimeBefore = statSync(modelsPath).mtimeMs
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual([])
    // 主断言：mtime 不变（未触发写）。内容断言作为 mtime 精度不足（旧 HFS+ 1s）的兜底。
    expect(statSync(modelsPath).mtimeMs).toBe(mtimeBefore)
    expect(readModelsProviders()).toEqual({
      legal1: { baseUrl: 'x' },
      legal2: { models: [{ id: 'm' }] },
    })
  })

  it('WTC10: models.json 不存在时不创建文件', () => {
    // tmp 目录空，不写 models.json
    expect(existsSync(modelsPath)).toBe(false)
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual([])
    expect(existsSync(modelsPath)).toBe(false)
  })

  it('WTC11: 全部无效时全部剔除，文件保留为空 providers 对象', () => {
    // [W1b 语义变更] bad1 旧为 {apiKey:'sk'}（现合法），改为八字段全缺纯空壳
    writeModelsFixture({
      bad1: { name: 'B1' },
      bad2: { name: 'X' },
    })
    const result = sanitizeInvalidProviders()
    expect(result.removed.sort()).toEqual(['bad1', 'bad2'])
    // providers 空对象，文件仍存在（非删除）
    expect(readModelsProviders()).toEqual({})
    expect(existsSync(modelsPath)).toBe(true)
  })

  it('WTC12: 连续调用幂等（第二次 removed 为空，缓存未污染）', () => {
    // [W1b 语义变更] bad 旧为 {apiKey:'sk'}（现合法），改为纯空壳
    writeModelsFixture({
      bad: { name: 'bad' },
      legal: { baseUrl: 'x' },
    })
    const first = sanitizeInvalidProviders()
    expect(first.removed).toEqual(['bad'])
    const second = sanitizeInvalidProviders()
    expect(second.removed).toEqual([])
    // 第二次后文件状态与第一次后一致
    expect(Object.keys(readModelsProviders()).sort()).toEqual(['legal'])
  })

  it('WTC16: 脏数据含 null provider 不崩溃，null 被剔除且合法 provider 保留', () => {
    // M2 回归：provider 值为 null 时旧实现整个 sanitize 崩溃 → 外层 catch 吞掉 → {removed:[]}
    // 同文件后续合法空壳 provider 不被剔除，"Model not found" 复发。
    // [W1b 语义变更] 空壳 fixture 从 {apiKey, name} 改为无 apiKey 纯空壳
    writeModelsFixture({
      'p-null': null,
      'concurrency-verify-A': { name: 'Verify A' },
      legal1: { baseUrl: 'x' },
    })
    const result = sanitizeInvalidProviders()
    expect(result.removed.sort()).toEqual(['concurrency-verify-A', 'p-null'])
    expect(readModelsProviders()).toEqual({ legal1: { baseUrl: 'x' } })
  })

  it('WTC17a [W1b 语义变更]: 只配 apiKey 的 catalog provider（opencode）原样保留，不修复不删除', () => {
    // W1b 主验收核心：QuickSetup 保存的 {apiKey, name, authMethod} 条目（无 baseUrl/models）
    // 直接合法——0.84.1 八字段判定 apiKey 在场即不触发 must specify 抛错。
    // 旧五字段判定把它判为空壳（MF-5 时代走 catalog 修复救回），更早版本直接删除。
    const fixture = { apiKey: 'sk-opencode', name: 'OpenCode Zen', authMethod: 'api_key' }
    writeModelsFixture({ opencode: fixture })
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual([])
    expect(result.repaired).toEqual([])
    // 逐字段原样保留（未被 catalog models 合并改写，apiKey 未丢）
    expect(readModelsProviders()).toEqual({ opencode: fixture })
  })

  it('WTC17b (MF-5 回归，[W1b 语义变更]): 无 apiKey 的 catalog 空壳被修复而非删除（models 合并，authMethod 保留）', () => {
    // 修复路径现仅覆盖八字段全缺（连 apiKey 都无）的 catalog 空壳——含 apiKey 条目已直接
    // 合法（见 WTC17a），不再进此路径。
    writeModelsFixture({
      opencode: { name: 'OpenCode Zen', authMethod: 'api_key' },
      'concurrency-verify-A': { name: 'Verify A' },
    })
    const result = sanitizeInvalidProviders()
    // 非 catalog 空壳仍删除，catalog 已知空壳修复
    expect(result.removed).toEqual(['concurrency-verify-A'])
    expect(result.repaired).toEqual(['opencode'])
    const remaining = readModelsProviders()
    expect(Object.keys(remaining).sort()).toEqual(['opencode'])
    const repaired = remaining.opencode as Record<string, unknown>
    // authMethod 保留（不丢用户字段）
    expect(repaired.authMethod).toBe('api_key')
    // models 从 catalog 合并（模型级 baseUrl 由 catalog 提供）
    expect(Array.isArray(repaired.models)).toBe(true)
    const models = repaired.models as Array<{ id: string; baseUrl?: string }>
    expect(models.length).toBeGreaterThan(0)
    expect(models[0].id).toBe('claude-fable-5')
    expect(models[0].baseUrl).toBe('https://opencode.ai/zen')
    // 修复后不再无效（pi 0.84.1 组合层可通过）
    expect(isInvalidProvider(repaired as PiProviderConfig)).toBe(false)
    // 幂等：第二次调用不再修复/删除（修复结果已是合法条目）
    const second = sanitizeInvalidProviders()
    expect(second.removed).toEqual([])
    expect(second.repaired).toEqual([])
  })

  it('WTC18 (MF-6 回归，[W1b 语义变更]): catalog models 全空 baseUrl 的 provider（azure-openai-responses）维持删除而非修复', () => {
    // MF-6 回归：azure-openai-responses 的 38 个 catalog models 全为空串 baseUrl 且无
    // provider 级 baseUrl——合并后 pi modelFromJson 对每个自定义模型强制非空 baseUrl
    // （空串非 nullish）直接 throw，pi 回退 builtin base，apiKey 静默失效，
    // 且毒化条目 isInvalidProvider===false 无自愈路径。此类 provider 排除出修复名单（删除）。
    // [W1b 语义变更] fixture 去掉 apiKey（含 apiKey 条目已直接合法，见 WTC17a）。
    writeModelsFixture({
      'azure-openai-responses': { name: 'Azure OpenAI', authMethod: 'api_key' },
      opencode: { name: 'OpenCode Zen', authMethod: 'api_key' },
    })
    const result = sanitizeInvalidProviders()
    // azure 删除（catalog 无可用 baseUrl 数据），opencode 仍修复（模型级 baseUrl 齐全）
    expect(result.removed).toEqual(['azure-openai-responses'])
    expect(result.repaired).toEqual(['opencode'])
    const remaining = readModelsProviders()
    expect(Object.keys(remaining).sort()).toEqual(['opencode'])
    // 修复条目不存在任何空 baseUrl 模型（pi 组合层不抛错）
    const models = (remaining.opencode as { models: Array<{ baseUrl?: string }> }).models
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(m => !!m.baseUrl)).toBe(true)
    // 幂等：第二次调用不再修复/删除
    const second = sanitizeInvalidProviders()
    expect(second.removed).toEqual([])
    expect(second.repaired).toEqual([])
  })
})

describe('U6③ 存量自愈：id 缺失/non-string 模型项（写侧同口径）', () => {
  it('id 缺失（undefined）的模型项被清洗剔除，provider 其余模型保留（pi 可加载）', () => {
    writeModelsFixture({
      keep: {
        baseUrl: 'https://api.example.com',
        models: [{ id: 'good-1' }, { name: 'no-id-model' }],
      },
    })
    sanitizeInvalidProviders()
    // outcome 形状 = { removed, repaired, staleGatewayMarkers }（无 changed 字段）；
    // 变更效果以盘上内容为准（U6③ 的判别位：id 缺失项被剔除）
    const models = (readModelsProviders().keep as { models: Array<Record<string, unknown>> }).models
    expect(models.map((m) => m.id)).toEqual(['good-1'])
  })

  it('可强转 id（number）被就地写回字符串形式（不丢条目，与写侧同口径）', () => {
    writeModelsFixture({
      keep: {
        baseUrl: 'https://api.example.com',
        models: [{ id: 456 }],
      },
    })
    sanitizeInvalidProviders()
    const models = (readModelsProviders().keep as { models: Array<Record<string, unknown>> }).models
    expect(models).toEqual([{ id: '456' }])
  })
})
