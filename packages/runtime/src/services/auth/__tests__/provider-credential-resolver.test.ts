/**
 * ProviderCredentialResolver（双源优先级 / 回显原值 / 批量 sync / ENV 形态 / resolveProviderBaseUrl）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - provider-credential-resolver.test.ts
 * - provider-credential-resolver-base-url.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/services/auth/__tests__/provider-credential-resolver.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConfigModelsConfig, ConfigProviderConfig } from '../../ports/config.js'
import type { Credential } from '../auth-storage.js'
import { AuthStorage } from '../auth-storage.js'
import type { ProviderCredentialResolverDeps } from '../provider-credential-resolver.js'
import { ProviderCredentialResolver } from '../provider-credential-resolver.js'

describe('provider-credential-resolver', () => {
/**
 * Provider 凭据解析唯一通道单测（tmp 目录真实文件，全程不碰真实数据目录）。
 *
 * 覆盖：双源优先级（auth.json 命中优先于 models.json）/ 单源命中 / 双源皆无 /
 * 同步存在性判定 / 批量并集且单次读（spy 计数，非 N+1）/ oauth 取 access 且 kind='oauth'
 * （短时 token 形态判别，MF-2）/ P-cred 探针（`$ENV_VAR` 配置值形态的实测输出与采取分支）。
 *
 * ── P-cred 探针结论（设计 §3.6 实施期门，实测 2026-09-10）──
 * ① taiji 侧「不展开」：AuthStorage.get 原样返回 auth.json 的 JSON 解析结果，无任何配置值
 *    解析（packages/runtime/src/services/auth/auth-storage.ts:126-128；既有用例
 *    auth-storage.test.ts:155-159「api_key key 字段保留原形态」是同事实的旁证）。
 *    models.json 侧同理（IConfigStore.getProviderConfig 直接返回落盘值）。
 * ② pi 侧「展开」：pi 读 auth.json api_key 时经 resolveConfigValue 解析
 *    （node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js:213-216 调用，
 *    实现在 dist/core/resolve-config-value.js:123-129）——`$ENV`/`${ENV}` 模板展开、
 *    `!` 前缀当 shell 命令执行、`$$`/`$!` 转义；任一 env 引用缺失则整值 undefined。
 * ③ 采取分支（降级路径）：resolver 对 `$ENV_VAR` / `${ENV_VAR}` 自行用 process.env 展开
 *    （credential.env 优先，与 pi resolve-config-value.js:71-73 同语义）；command（`!` 前缀）
 *    首版不支持且**不执行 shell**，与「env 引用缺失」一起返回 { unsupported } 判别结构
 *    （RT-7#4），由消费方报「该凭据形态暂不支持」且禁止把形态标记当 key 下发外部请求。
 *    下方 "P-cred" 用例组即该分支的回归断言。
 */
let dir: string
let authPath: string
let modelsPath: string
let storage: AuthStorage

function writeAuthFile(credentials: Record<string, Credential>): void {
  writeFileSync(authPath, JSON.stringify(credentials, null, 2))
}

function writeModelsFile(providers: Record<string, { apiKey?: string }>): void {
  writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2))
}

function readModelsFile(): ConfigModelsConfig {
  return JSON.parse(readFileSync(modelsPath, 'utf-8')) as ConfigModelsConfig
}

/** deps 工厂：auth.json 走真实 AuthStorage（async 经 AuthService 收敛通道 + sync 同步原语），
 * models.json 走计数 fake（断言批量形态单次读）。 */
function makeDeps(): ProviderCredentialResolverDeps & { readModels: ReturnType<typeof vi.fn> } {
  const readModels = vi.fn((): ConfigModelsConfig => readModelsFile())
  return {
    authService: { getCredential: (providerId: string) => storage.get(providerId) },
    authStorage: storage,
    configStore: {
      readModels,
      getProviderConfig: (providerId: string) => readModelsFile().providers[providerId],
    },
    readModels,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-credential-resolver-'))
  authPath = join(dir, 'auth.json')
  modelsPath = join(dir, 'models.json')
  storage = new AuthStorage(authPath)
  writeAuthFile({})
  writeModelsFile({})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('ProviderCredentialResolver 双源优先级', () => {
  it('两源同时存在：返回 auth.json 的 key 且 source === "auth.json"（优先级断言）', async () => {
    writeAuthFile({ 'catalog-prov': { type: 'api_key', key: 'sk-from-auth' } })
    writeModelsFile({ 'catalog-prov': { apiKey: 'sk-from-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('catalog-prov')).toEqual({
      key: 'sk-from-auth',
      source: 'auth.json',
      kind: 'api_key',
    })
  })

  it('仅 models.json 有：source === "models.json"（custom 凭据源）', async () => {
    writeModelsFile({ 'custom-prov': { apiKey: 'sk-custom' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('custom-prov')).toEqual({
      key: 'sk-custom',
      source: 'models.json',
      kind: 'api_key',
    })
  })

  it('两源皆无：resolve 返回 undefined、hasProviderCredential 返回 false', async () => {
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('nowhere')).toBeUndefined()
    expect(resolver.hasProviderCredential('nowhere')).toBe(false)
  })

  it('hasProviderCredential：两源任一命中即 true（存在性判定，含 oauth 条目）', async () => {
    writeAuthFile({ 'oauth-prov': { type: 'oauth', access: 'tok', expires: 1_000 } })
    writeModelsFile({ 'custom-prov': { apiKey: 'sk-custom' }, 'empty-prov': { apiKey: '' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(resolver.hasProviderCredential('oauth-prov')).toBe(true)
    expect(resolver.hasProviderCredential('custom-prov')).toBe(true)
    // 空串是 pi schema 违规值（等同无凭据），不计入
    expect(resolver.hasProviderCredential('empty-prov')).toBe(false)
  })

  it('oauth 凭据取 access 明文 + kind="oauth"（不带配置值解析，与 pi 对 oauth 的处置一致）', async () => {
    writeAuthFile({ 'oauth-prov': { type: 'oauth', access: '$NOT_AN_ENV_REF', expires: 1_000 } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('oauth-prov')).toEqual({
      key: '$NOT_AN_ENV_REF',
      source: 'auth.json',
      kind: 'oauth',
    })
  })
})

describe('ProviderCredentialResolver 回显原值（resolveProviderApiKeyRaw）', () => {
  it('auth.json api_key：返回所存原值，$ENV 引用不展开（回显语义 = 用户所存值）', async () => {
    vi.stubEnv('REVEAL_KEY_ENV', 'sk-resolved-from-env')
    writeAuthFile({ 'auth-prov': { type: 'api_key', key: '$REVEAL_KEY_ENV' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderApiKeyRaw('auth-prov')).toEqual({
      apiKey: '$REVEAL_KEY_ENV',
      source: 'auth.json',
    })
  })

  it('两源同时有 api_key：auth.json 优先（与 resolveProviderCredential 同一优先级）', async () => {
    writeAuthFile({ both: { type: 'api_key', key: 'sk-auth' } })
    writeModelsFile({ both: { apiKey: 'sk-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderApiKeyRaw('both')).toEqual({ apiKey: 'sk-auth', source: 'auth.json' })
  })

  it('auth.json 是 oauth + models.json 有 apiKey：不回落（不显示低优先源的历史残留值）', async () => {
    writeAuthFile({ mixed: { type: 'oauth', access: 'oauth-access-token', expires: 1_000 } })
    writeModelsFile({ mixed: { apiKey: 'sk-stale-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    // resolveProviderCredential 会返回 oauth 的 access（另一消费面），回显面结构性排除
    expect(await resolver.resolveProviderCredential('mixed')).toEqual({
      key: 'oauth-access-token',
      kind: 'oauth',
      source: 'auth.json',
    })
    expect(await resolver.resolveProviderApiKeyRaw('mixed')).toBeUndefined()
  })

  it('oauth-only / 两源皆无：undefined（available:false 的判定锚）', async () => {
    writeAuthFile({ 'oauth-only': { type: 'oauth', access: 'tok', expires: 1_000 } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderApiKeyRaw('oauth-only')).toBeUndefined()
    expect(await resolver.resolveProviderApiKeyRaw('nowhere')).toBeUndefined()
  })

  it('models.json apiKey：原值透传（custom 定义权威，不展开 $ENV）', async () => {
    writeModelsFile({ custom: { apiKey: '${CUSTOM_KEY}' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderApiKeyRaw('custom')).toEqual({
      apiKey: '${CUSTOM_KEY}',
      source: 'models.json',
    })
  })

  it('`!cmd` 形态：回显返回原串（不执行 shell），常规解析返回 unsupported=command（SG-9）', async () => {
    writeAuthFile({ cmd: { type: 'api_key', key: '!printf sk-auth' } })
    writeModelsFile({ 'cmd-models': { apiKey: '!echo sk-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    // 回显面 = 用户所存配置串，原样展示；常规解析面拒绝执行并报形态不支持
    expect(await resolver.resolveProviderApiKeyRaw('cmd')).toEqual({
      apiKey: '!printf sk-auth',
      source: 'auth.json',
    })
    expect(await resolver.resolveProviderCredential('cmd')).toEqual({ unsupported: 'command' })
    expect(await resolver.resolveProviderApiKeyRaw('cmd-models')).toEqual({
      apiKey: '!echo sk-models',
      source: 'models.json',
    })
    expect(await resolver.resolveProviderCredential('cmd-models')).toEqual({ unsupported: 'command' })
  })
})

describe('ProviderCredentialResolver 批量 sync 形态', () => {
  it('listCredentialBackedProviderIds 返回两源并集且各自只读一次（非 N+1 读盘）', () => {
    writeAuthFile({
      catalogA: { type: 'api_key', key: 'k1' },
      oauthB: { type: 'oauth', access: 'tok', expires: 1_000 },
    })
    writeModelsFile({ customC: { apiKey: 'k2' }, customD: { apiKey: '' }, customE: {} })
    const listIdsSpy = vi.spyOn(storage, 'listCredentialIds')
    const deps = makeDeps()
    const resolver = new ProviderCredentialResolver(deps)

    const ids = resolver.listCredentialBackedProviderIds()

    expect(ids).toEqual(new Set(['catalogA', 'oauthB', 'customC']))
    // 单次读断言：auth.json 一次 listCredentialIds、models.json 一次 readModels
    expect(listIdsSpy).toHaveBeenCalledTimes(1)
    expect(deps.readModels).toHaveBeenCalledTimes(1)
  })
})

describe('P-cred 探针：$ENV_VAR / command 配置值形态的解析行为', () => {
  it('auth.json 内 $ENV_VAR 原样保留（taiji 侧不展开，探针①），resolver 用 process.env 展开（采取分支）', async () => {
    vi.stubEnv('TAIJI_CRED_PROBE_KEY', 'sk-probe-123')
    writeAuthFile({ 'env-prov': { type: 'api_key', key: '$TAIJI_CRED_PROBE_KEY' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    // 探针①复现：AuthStorage 通道读到的是未展开的原文
    expect(await storage.get('env-prov')).toMatchObject({ key: '$TAIJI_CRED_PROBE_KEY' })
    // 降级路径实测输出：resolver 展开为明文
    expect(await resolver.resolveProviderCredential('env-prov')).toEqual({
      key: 'sk-probe-123',
      source: 'auth.json',
      kind: 'api_key',
    })
  })

  it('${ENV_VAR} 形态同样展开，且 credential.env 优先于 process.env（pi 同语义）', async () => {
    vi.stubEnv('TAIJI_CRED_PROBE_KEY', 'sk-from-process')
    writeAuthFile({
      'env-prov': { type: 'api_key', key: '${TAIJI_CRED_PROBE_KEY}-suffix', env: { TAIJI_CRED_PROBE_KEY: 'sk-from-cred' } },
    })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('env-prov')).toEqual({
      key: 'sk-from-cred-suffix',
      source: 'auth.json',
      kind: 'api_key',
    })
  })

  it('env 引用缺失 → { unsupported: "unresolved-env" }（RT-7#4：不再与「无凭据」的 undefined 混同）', async () => {
    writeAuthFile({ 'env-prov': { type: 'api_key', key: '$TAIJI_CRED_PROBE_MISSING' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('env-prov')).toEqual({ unsupported: 'unresolved-env' })
  })

  it('非变量的字面 $ 不作展开（如 $1abc 保持字面）', async () => {
    writeAuthFile({ literal: { type: 'api_key', key: '$1abc' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('literal')).toEqual({ key: '$1abc', source: 'auth.json', kind: 'api_key' })
  })

  it('command 形态（! 前缀）不执行 shell，返回 { unsupported: "command" } 判别结构', async () => {
    writeAuthFile({ 'cmd-prov': { type: 'api_key', key: '!echo sk-from-command' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('cmd-prov')).toEqual({ unsupported: 'command' })
  })

  it('command 形态命中即不降级 models.json（高优先源显式配置错误不被低优先源静默接住，RT-7#4）', async () => {
    writeAuthFile({ 'cmd-prov': { type: 'api_key', key: '!echo sk' } })
    writeModelsFile({ 'cmd-prov': { apiKey: 'sk-plaintext-in-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('cmd-prov')).toEqual({ unsupported: 'command' })
  })

  it('unresolved-env 同样不降级 models.json', async () => {
    writeAuthFile({ 'env-prov': { type: 'api_key', key: '$TAIJI_CRED_PROBE_MISSING' } })
    writeModelsFile({ 'env-prov': { apiKey: 'sk-plaintext-in-models' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('env-prov')).toEqual({ unsupported: 'unresolved-env' })
  })

  it('models.json 侧 apiKey 的 command 形态同样返回 unsupported（两源共享同一份配置值解析）', async () => {
    writeModelsFile({ 'custom-cmd': { apiKey: '!cat /run/secrets/key' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('custom-cmd')).toEqual({ unsupported: 'command' })
  })

  it('models.json 侧 apiKey 的 $ENV_VAR 同样展开（两源共享同一份配置值解析）', async () => {
    vi.stubEnv('TAIJI_CRED_PROBE_KEY', 'sk-probe-models')
    writeModelsFile({ 'custom-prov': { apiKey: '$TAIJI_CRED_PROBE_KEY' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('custom-prov')).toEqual({
      key: 'sk-probe-models',
      source: 'models.json',
      kind: 'api_key',
    })
  })

  // resolveTemplate 的 ${} 深边界分支（Gate-1.6 补口）：apiKey 含 $ 字面量的 provider
  // 若被错误展开 → 鉴权失败；三例断言均与实装逐行核对（provider-credential-resolver.ts
  // resolveTemplate 转义对 / `${` 缺结束花括号 / ENV_VAR_NAME_RE 拒绝分支）。
  it('转义对：$$ → 字面 $，$! → 字面 !（各只消费 $ 后 1 字符，! 前缀形态标记不受影响）', async () => {
    writeAuthFile({
      esc: { type: 'api_key', key: 'sk-$$-literal' },
      'esc-bang': { type: 'api_key', key: '$!cmd-rest' },
    })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('esc')).toEqual({ key: 'sk-$-literal', source: 'auth.json', kind: 'api_key' })
    expect(await resolver.resolveProviderCredential('esc-bang')).toEqual({ key: '!cmd-rest', source: 'auth.json', kind: 'api_key' })
  })

  it('`${` 缺结束花括号：$ 按字面输出 + 后续原样追加（不查 env、不判 undefined、不抛）', async () => {
    writeAuthFile({ unclosed: { type: 'api_key', key: '${UNCLOSED' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('unclosed')).toEqual({
      key: '${UNCLOSED',
      source: 'auth.json',
      kind: 'api_key',
    })
  })

  it('${非法名} 原样保留（ENV_VAR_NAME_RE 拒绝分支，含首字符数字形态）', async () => {
    writeAuthFile({ 'bad-name': { type: 'api_key', key: 'pre-${1BAD}-post' } })
    const resolver = new ProviderCredentialResolver(makeDeps())

    expect(await resolver.resolveProviderCredential('bad-name')).toEqual({
      key: 'pre-${1BAD}-post',
      source: 'auth.json',
      kind: 'api_key',
    })
  })
})
})

describe('provider-credential-resolver-base-url', () => {
/**
 * resolveProviderBaseUrl 两级数据源单测（ai-voice-tts D4「baseUrl 读取通道」的 port 扩展）。
 *
 * 既有 port 测试在 services/auth/__tests__/provider-credential-resolver.test.ts（本单元
 * 领地外），按任务书处置规则另立本文件；本方法不走 auth.json 凭据源链（auth.json 无
 * baseUrl 概念），deps 的凭据通道给恒空 stub 即可，用例聚焦两级 baseUrl 语义：
 *
 * ① models.json providers[id].baseUrl（provider 级网关值）——pi-provider-store 启动归一化
 *    （stripCatalogProviderLevelKeys）后仅在用户显式配网关（extras.gatewayBaseUrl 标记）时
 *    保留，此级读到的必是用户网关实际值，优先级最高；
 * ② 第一级无值时回退内置 catalog（generated/builtin-providers.json）该 provider 的
 *    provider 级 baseUrl——未配网关的内置 provider，此值即 pi 实际生效值（pi 行为锚点：
 *    @earendil-works/pi-coding-agent@0.84.4 dist/core/provider-composer.js:98
 *    `config.baseUrl ?? model.baseUrl` 覆盖式网关语义）；
 * ③ 两级皆无值 → undefined。
 */
/** deps 工厂：models.json 走内存 fake（本方法唯一走真实数据的通道）；凭据通道恒空 stub。 */
function makeResolver(providers: Record<string, ConfigProviderConfig>): ProviderCredentialResolver {
  const models: ConfigModelsConfig = { providers }
  const deps: ProviderCredentialResolverDeps = {
    authService: { getCredential: async () => undefined },
    authStorage: { hasCredentialSync: () => false, listCredentialIds: () => [] },
    configStore: {
      readModels: () => models,
      getProviderConfig: (providerId: string) => providers[providerId],
    },
  }
  return new ProviderCredentialResolver(deps)
}

describe('resolveProviderBaseUrl 两级数据源', () => {
  it('第一级命中：models.json provider 级 baseUrl（用户网关值）优先返回', () => {
    const resolver = makeResolver({
      'xiaomi-token-plan-cn': { baseUrl: 'https://my-gateway.example.com/v1' },
    })

    expect(resolver.resolveProviderBaseUrl('xiaomi-token-plan-cn')).toBe('https://my-gateway.example.com/v1')
  })

  it('第一级无值回退第二级：models.json 条目无 baseUrl 时返回内置 catalog 的 provider 级 baseUrl', () => {
    // 未配网关的内置 provider 主力形态：models.json 只有 apiKey（联动只带 Key 的场景此级无 baseUrl）
    const resolver = makeResolver({
      'xiaomi-token-plan-cn': { apiKey: 'sk-plan-key' },
      minimax: {},
    })

    expect(resolver.resolveProviderBaseUrl('xiaomi-token-plan-cn')).toBe('https://token-plan-cn.xiaomimimo.com/v1')
    expect(resolver.resolveProviderBaseUrl('minimax')).toBe('https://api.minimax.io/anthropic')
  })

  it('两级皆无值返回 undefined：models.json 无条目且 catalog 无此 id（自定义 provider 无 baseUrl）', () => {
    const resolver = makeResolver({})

    expect(resolver.resolveProviderBaseUrl('my-custom-provider')).toBeUndefined()
  })

  it('models.json baseUrl 为空白串同视未设置（对齐 resolveCatalogDisplayFields 口径），回退 catalog', () => {
    const resolver = makeResolver({
      xiaomi: { baseUrl: '  ' },
    })

    expect(resolver.resolveProviderBaseUrl('xiaomi')).toBe('https://api.xiaomimimo.com/v1')
  })

  it('catalog 该 provider 的 provider 级 baseUrl 为空串（ambient 类）不当生效值，返回 undefined', () => {
    // amazon-bedrock 快照 provider.baseUrl === ""（ambient 鉴权，无单一端点）
    const resolver = makeResolver({ 'amazon-bedrock': {} })

    expect(resolver.resolveProviderBaseUrl('amazon-bedrock')).toBeUndefined()
  })
})
})
