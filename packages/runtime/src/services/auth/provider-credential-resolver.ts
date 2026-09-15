/**
 * Provider 凭据解析唯一通道（D3 收口）——接口见 services/ports/provider-credential-resolver.ts。
 *
 * 源优先级单点声明（三形态共享，见本文件 ProviderCredentialResolver 构造器里的 sources 数组，
 * 数组顺序即优先级）：
 *   1. auth.json（经 AuthService / AuthStorage 通道，catalog 凭据所在）
 *   2. models.json providers[id].apiKey（custom 凭据所在）
 *
 * 构造无 IO：全部读取懒发生（hasProviderCredential / listCredentialBackedProviderIds /
 * resolveProviderCredential 被调用时才读盘）——这是组合根装配时序的前提：init 注入先于
 * 任何 findValidDefaultModel 调用时，装配期触发读取不会有「文件尚未就绪」的时序风险。
 *
 * $ENV_VAR / command 配置值形态（探针 P-cred，设计 §3.6）：
 * - taiji 侧 AuthStorage 不展开配置值（auth-storage.ts:126-128 原样返回 JSON 解析结果，
 *   与 models.json 同）——探针实测见 __tests__/provider-credential-resolver.test.ts。
 * - 故本模块按降级路径自行展开 `$ENV_VAR` / `${ENV_VAR}`，与 pi 实装
 *   dist/core/resolve-config-value.js:123-129 resolveConfigValue 的模板分支同语义
 *   （pi auth-storage.js:213-216 读 auth.json 时经该函数解析）。
 * - command 配置值（`!` 前缀）首版不支持：**不执行 shell**（执行任意命令是副作用面），
 *   原样返回——`!` 前缀即「该形态」标记，消费方据此报「该凭据形态暂不支持」。
 */
import type { IConfigStore } from '../ports/config.js'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'
import type { AuthService } from './auth-service.js'
import type { AuthStorage, Credential } from './auth-storage.js'

/** 凭据源标识（与接口返回的 source 同域）。 */
type CredentialSourceId = 'auth.json' | 'models.json'

/**
 * 单个凭据源的三种读取形态。
 * 三形态集中在同一对象上，使「源优先级」只需在 sources 数组里声明一次顺序。
 */
interface CredentialSource {
  readonly id: CredentialSourceId
  /** 同步存在性判定（单 provider）。 */
  hasSync(providerId: string): boolean
  /** 同步批量列出该源的 providerId（实现须单次读盘）。 */
  listIdsSync(): Set<string>
  /** 异步取明文 key（未命中 / 不可解析 → undefined）。 */
  readKey(providerId: string): Promise<string | undefined>
}

/**
 * 实现依赖：auth.json 读通道（async 经 AuthService 收口通道 + sync 经 AuthStorage 同步原语）
 * 与 models.json 读通道（IConfigStore port，不直接碰文件）。
 * 注意：这里取的都不是「裸读文件」实例，而是既有通道——本模块存在的意义正是消灭裸读。
 */
export interface ProviderCredentialResolverDeps {
  /** auth.json 异步读（AuthService 收口通道，OAuth 刷新写回后能立即读到新值） */
  authService: Pick<AuthService, 'getCredential'>
  /** auth.json 同步原语（hasCredentialSync / listCredentialIds，auth-storage.ts:166/:178） */
  authStorage: Pick<AuthStorage, 'hasCredentialSync' | 'listCredentialIds'>
  /** models.json 读（readModels 批量单次读 / getProviderConfig 单点） */
  configStore: Pick<IConfigStore, 'readModels' | 'getProviderConfig'>
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `$` 之后的引用前缀长度：`$$` / `$!` 转义对与 `${` 花括号引用都是 2 个字符。 */
const DOLLAR_PREFIX_LENGTH = 2

/**
 * 单点环境变量取值（与 pi resolve-config-value.js:71-73 resolveEnvConfigValue 同语义）：
 * credential.env 优先，其次 process.env，都没有返回 undefined。
 */
function resolveEnvValue(name: string, env?: Record<string, string>): string | undefined {
  return env?.[name] || process.env[name] || undefined
}

/**
 * `$ENV_VAR` / `${ENV_VAR}` 模板展开（pi resolve-config-value.js:83-95 resolveTemplate 同语义）：
 * `$$` 转义字面 `$`、`$!` 转义字面 `!`、任一引用未定义则整值 undefined（pi 同：凭据不可用）。
 */
function resolveTemplate(template: string, env?: Record<string, string>): string | undefined {
  let resolved = ''
  let index = 0
  while (index < template.length) {
    const dollarIndex = template.indexOf('$', index)
    if (dollarIndex < 0) {
      resolved += template.slice(index)
      break
    }
    resolved += template.slice(index, dollarIndex)
    const nextChar = template[dollarIndex + 1]
    if (nextChar === '$' || nextChar === '!') {
      resolved += nextChar
      index = dollarIndex + DOLLAR_PREFIX_LENGTH
      continue
    }
    if (nextChar === '{') {
      const endIndex = template.indexOf('}', dollarIndex + DOLLAR_PREFIX_LENGTH)
      if (endIndex < 0) {
        resolved += '$'
        index = dollarIndex + 1
        continue
      }
      const name = template.slice(dollarIndex + DOLLAR_PREFIX_LENGTH, endIndex)
      if (!ENV_VAR_NAME_RE.test(name)) {
        resolved += template.slice(dollarIndex, endIndex + 1)
      } else {
        const value = resolveEnvValue(name, env)
        if (value === undefined) return undefined
        resolved += value
      }
      index = endIndex + 1
      continue
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(template.slice(dollarIndex + 1))
    if (match) {
      const value = resolveEnvValue(match[0], env)
      if (value === undefined) return undefined
      resolved += value
      index = dollarIndex + 1 + match[0].length
      continue
    }
    resolved += '$'
    index = dollarIndex + 1
  }
  return resolved
}

/**
 * 配置值解析（pi resolve-config-value.js:123-129 resolveConfigValue 的简化版）：
 * command（`!`）不执行、原样返回（形态标记）；其余走模板展开。
 */
function resolveCredentialValue(config: string, env?: Record<string, string>): string | undefined {
  if (config.startsWith('!')) return config
  return resolveTemplate(config, env)
}

/** auth.json 条目 → 生效明文（api_key 走配置值解析；oauth 取 access，pi 对 oauth 不做配置值解析）。 */
function readAuthCredentialKey(credential: Credential): string | undefined {
  if (credential.type === 'api_key') {
    if (typeof credential.key !== 'string' || credential.key === '') return undefined
    return resolveCredentialValue(credential.key, credential.env)
  }
  const access = credential.access
  return typeof access === 'string' && access !== '' ? access : undefined
}

/** models.json apiKey 是否是可用的非空串（'' 是 schema 违规值，等同无凭据）。 */
function isUsableApiKey(apiKey: unknown): apiKey is string {
  return typeof apiKey === 'string' && apiKey !== ''
}

function createAuthJsonSource(deps: ProviderCredentialResolverDeps): CredentialSource {
  return {
    id: 'auth.json',
    hasSync: (providerId) => deps.authStorage.hasCredentialSync(providerId),
    listIdsSync: () => new Set(deps.authStorage.listCredentialIds()),
    readKey: async (providerId) => {
      const credential = await deps.authService.getCredential(providerId)
      return credential ? readAuthCredentialKey(credential) : undefined
    },
  }
}

function createModelsJsonSource(deps: ProviderCredentialResolverDeps): CredentialSource {
  return {
    id: 'models.json',
    hasSync: (providerId) => isUsableApiKey(deps.configStore.getProviderConfig(providerId)?.apiKey),
    listIdsSync: () => {
      // 批量形态单次读（B3 先例：N 个 provider 不做 N 次读盘）
      const providers = deps.configStore.readModels().providers
      const ids = new Set<string>()
      for (const [providerId, config] of Object.entries(providers)) {
        if (isUsableApiKey(config.apiKey)) ids.add(providerId)
      }
      return ids
    },
    readKey: async (providerId) => {
      const apiKey = deps.configStore.getProviderConfig(providerId)?.apiKey
      return isUsableApiKey(apiKey) ? resolveCredentialValue(apiKey) : undefined
    },
  }
}

export class ProviderCredentialResolver implements IProviderCredentialResolver {
  /**
   * 源优先级单点声明：数组顺序即解析优先级，async 明文 / sync 布尔 / 批量三形态共用本数组。
   * 禁止在别处再写一遍链（这是读路径收口的全部意义）。
   */
  private readonly sources: readonly CredentialSource[]

  constructor(deps: ProviderCredentialResolverDeps) {
    this.sources = [createAuthJsonSource(deps), createModelsJsonSource(deps)]
  }

  hasProviderCredential(providerId: string): boolean {
    return this.sources.some((source) => source.hasSync(providerId))
  }

  listCredentialBackedProviderIds(): Set<string> {
    const ids = new Set<string>()
    for (const source of this.sources) {
      for (const id of source.listIdsSync()) ids.add(id)
    }
    return ids
  }

  async resolveProviderCredential(
    providerId: string,
  ): Promise<{ key: string; source: CredentialSourceId } | undefined> {
    for (const source of this.sources) {
      const key = await source.readKey(providerId)
      if (key !== undefined) return { key, source: source.id }
    }
    return undefined
  }
}
