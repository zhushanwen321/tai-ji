/**
 * Provider 写代理（provider-plugin-access D4）：插件向 models.json 写凭据与模型目录的
 * 受控通道（providers.write / providers.delete / providers.credential 三 RPC）。
 *
 * 边界模型（D4 采纳形态）：
 * - 命名空间边界：ns 由插件 npm 包名纯函数推导（deriveNamespace，shared 单源），插件
 *   只能触达 `ns` 或 `ns-<suffix>` 前缀的 providerId——安装期已做 manifest 声明与推导值
 *   的绑定校验（NAMESPACE_MISMATCH 拒装），本通道按同一规则运行期复核，不落盘 ns。
 * - 写侧（C-proc-15）：写入复用既有 setProvider 写策略链（applyProviderWritePolicy /
 *   credentialWriter 载体），本模块零直调 upsertProvider——代理只做身份收窄与载荷校验。
 * - 读侧（C-proc-14）：providers.credential 经 provider-credential-resolver 唯一读通道
 *   取生效凭据，定向返回给发起调用的插件（JSON-RPC reply 只回发起 worker）——不广播、
 *   不落日志、不进快照。明文回读的能力前提 = manifest 已声明 network.http（凭据只服务
 *   联网动作；未声明直接 PERMISSION_DENIED）。
 * - 身份来源：ctx.identity.pluginId（宿主 registerWorker 注册的通道权威身份，fork 与
 *   pluginId 一对一）；消息体 params.pluginId 是自报值，任何判定不引用。trusted Worker
 *   可共享多插件、无唯一归属 → 无法定位 ns → fail-closed 拒绝（羊毛系 external 插件
 *   一律 sandbox，正常路径恒有身份）。
 *
 * 错误形态：结构化字符串码（errorWithCode，plugin 域自有码原样透传先例）——
 * NAMESPACE_MISMATCH（越权触达）/ PERMISSION_DENIED（身份缺失 / 能力未声明）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deriveNamespace, NAMESPACE_MISMATCH } from '@taiji/shared/plugin-namespace'
import type { PluginRpcServer, RpcDispatchContext } from './plugin-service/plugin-rpc-server.js'
import { errorWithCode } from '../utils/errors.js'

/** 三方法的 wire 方法名（插件 RPC 线协议，自由 method 字符串）。 */
export const PROVIDERS_WRITE_METHOD = 'providers.write'
export const PROVIDERS_DELETE_METHOD = 'providers.delete'
export const PROVIDERS_CREDENTIAL_METHOD = 'providers.credential'

/** providers.write 请求载荷（D4）：凭据与模型目录一并交给宿主写策略链。 */
export interface ProviderWritePayload { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  providerId: string
  apiKey: string
  displayName?: string
  headers?: Record<string, string>
  models?: Array<string | { id: string; name?: string; api?: string; reasoning?: boolean; contextWindow?: number; enabled?: boolean }>
}

/** providers.credential 成功回执：明文 key + 命中源 + 形态判别（resolver 通道直透）。 */
export type ProviderCredentialReply =
  | { providerId: string; key: string; source: 'auth.json' | 'models.json'; kind: 'api_key' | 'oauth' }
  | { providerId: string; unsupported: 'command' | 'unresolved-env' }

/** 插件包清单读取结果（命名空间与能力判定的输入）。 */
export interface PluginManifestInfo { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  /** npm 包名（ns 推导唯一事实源，D4）。 */
  pkgName: string
  /** manifest taijiPlugin.capabilities 声明（network.http 判定）。 */
  capabilities: readonly string[]
}

/**
 * provider-write-proxy 窄依赖（services 层不 import infra / plugin-service 内部实现，
 * 组合根闭包装配；测试用对象字面量即可装配）。
 */
export interface ProviderWriteProxyDeps { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  /** setProvider 写策略链（C-proc-15 唯一写入口，ConfigService 同签名子集）。 */
  setProvider: (providerId: string, data: {
    name?: string
    apiKey?: string
    headers?: Record<string, string>
    models?: ProviderWritePayload['models']
    enabled?: boolean
  }) => Promise<unknown>
  /** 条目删除（providers.delete 的落点，ConfigService.deleteProvider 同签名子集）。 */
  deleteProvider: (providerId: string) => Promise<unknown>
  /** 凭据唯一读通道（C-proc-14，IProviderCredentialResolver 同签名子集）。 */
  resolveProviderCredential: (providerId: string) => Promise<
    | { key: string; source: 'auth.json' | 'models.json'; kind: 'api_key' | 'oauth' }
    | { unsupported: 'command' | 'unresolved-env' }
    | undefined
  >
  /** 插件包清单读取（包名 + capabilities；未装/清单不可读 = undefined → fail-closed）。 */
  readPluginManifest: (pluginId: string) => PluginManifestInfo | undefined
}

/** 包根定位的祖先遍历深度上界（entry → 包根通常 ≤3 层；上界防病态路径无限上溯）。 */
const MAX_PACKAGE_ROOT_WALK_DEPTH = 8

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 命名空间前缀校验（D4）：providerId 必须等于 ns 或以 `ns-` 开头。ns 自包名推导；
 * 推导空串（包名形态异常）按 NAMESPACE_MISMATCH 处置——空 ns 无法构成前缀边界。
 */
function assertInNamespace(pluginId: string, pkgName: string, providerId: string): string {
  const ns = deriveNamespace(pkgName)
  if (ns.length === 0 || (providerId !== ns && !providerId.startsWith(`${ns}-`))) {
    throw errorWithCode(
      `NAMESPACE_MISMATCH: provider '${providerId}' is outside the declaring plugin's namespace ` +
        `(plugin '${pluginId}' derives namespace '${ns || '(empty)'}'). ` +
        `Recovery: write only '${ns}-*' provider ids, or reinstall a plugin whose package name matches its manifest namespace.`,
      NAMESPACE_MISMATCH,
    )
  }
  return ns
}

/** 通道身份收窄：无身份（trusted 共享 Worker）= 无法定位 ns，fail-closed。 */
function requireSandboxPluginId(ctx: RpcDispatchContext): string {
  const pluginId = ctx.identity?.pluginId
  if (pluginId === undefined) {
    throw errorWithCode(
      'PERMISSION_DENIED: providers.* requires a sandbox channel with a unique plugin identity ' +
        '(trusted workers are shared across plugins and cannot be scoped to a namespace).',
      'PERMISSION_DENIED',
    )
  }
  return pluginId
}

/** providers.write：身份 → 清单 → 命名空间 → 载荷校验 → setProvider 写策略链。 */
async function handleProviderWrite(deps: ProviderWriteProxyDeps, params: Record<string, unknown>, ctx: RpcDispatchContext): Promise<{ written: true; providerId: string }> {
  const pluginId = requireSandboxPluginId(ctx)
  const providerId = asNonEmptyString(params.providerId)
  const apiKey = asNonEmptyString(params.apiKey)
  if (providerId === undefined || apiKey === undefined) {
    throw errorWithCode(
      'INVALID_PAYLOAD: providers.write requires non-empty string fields providerId and apiKey.',
      'INVALID_PAYLOAD',
    )
  }
  const manifest = deps.readPluginManifest(pluginId)
  if (manifest === undefined) {
    throw errorWithCode(
      `PERMISSION_DENIED: cannot read installed manifest for plugin '${pluginId}' — ` +
        `providers.write is only available to installed plugins (fail-closed).`,
      'PERMISSION_DENIED',
    )
  }
  assertInNamespace(pluginId, manifest.pkgName, providerId)

  // 载荷收窄（读侧不信任插件）：models 元素必须是字符串或带字符串 id 的对象——
  // 结构细节交给 setProvider 写策略链既有 sanitize/policy 防线，本层只挡明显越形。
  const rawModels = params.models
  let models: ProviderWritePayload['models'] | undefined
  if (rawModels !== undefined) {
    if (!Array.isArray(rawModels)) {
      throw errorWithCode('INVALID_PAYLOAD: providers.write models must be an array.', 'INVALID_PAYLOAD')
    }
    models = rawModels.map((entry) => {
      if (typeof entry === 'string') return entry
      if (typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string') {
        return entry as { id: string }
      }
      throw errorWithCode('INVALID_PAYLOAD: providers.write models entries must be strings or objects with a string id.', 'INVALID_PAYLOAD')
    })
  }
  const rawHeaders = params.headers
  if (rawHeaders !== undefined && (typeof rawHeaders !== 'object' || rawHeaders === null || Array.isArray(rawHeaders))) {
    throw errorWithCode('INVALID_PAYLOAD: providers.write headers must be a flat string record.', 'INVALID_PAYLOAD')
  }
  const headers = rawHeaders === undefined ? undefined : Object.fromEntries(
    Object.entries(rawHeaders as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

  await deps.setProvider(providerId, {
    ...(asNonEmptyString(params.displayName) !== undefined ? { name: asNonEmptyString(params.displayName) } : {}),
    apiKey,
    ...(headers !== undefined ? { headers } : {}),
    ...(models !== undefined ? { models } : {}),
  })
  return { written: true, providerId }
}

/** providers.delete：身份 → 清单 → 命名空间 → 既有删除链（卸载编排消费）。 */
async function handleProviderDelete(deps: ProviderWriteProxyDeps, params: Record<string, unknown>, ctx: RpcDispatchContext): Promise<{ deleted: boolean; providerId: string }> {
  const pluginId = requireSandboxPluginId(ctx)
  const providerId = asNonEmptyString(params.providerId)
  if (providerId === undefined) {
    throw errorWithCode('INVALID_PAYLOAD: providers.delete requires a non-empty string field providerId.', 'INVALID_PAYLOAD')
  }
  const manifest = deps.readPluginManifest(pluginId)
  if (manifest === undefined) {
    throw errorWithCode(
      `PERMISSION_DENIED: cannot read installed manifest for plugin '${pluginId}' — ` +
        `providers.delete is only available to installed plugins (fail-closed).`,
      'PERMISSION_DENIED',
    )
  }
  assertInNamespace(pluginId, manifest.pkgName, providerId)
  const outcome = await deps.deleteProvider(providerId) as { removed?: boolean } | undefined
  return { deleted: outcome?.removed !== false, providerId }
}

/**
 * providers.credential：身份 → 清单 → 能力前提（network.http）→ 命名空间 → 唯一读通道
 * 定向回读。明文只进本 reply（JSON-RPC 定向响应），无广播/快照/日志路径——帧审计
 * 断言的结构性依据（S20）。
 */
async function handleProviderCredential(deps: ProviderWriteProxyDeps, params: Record<string, unknown>, ctx: RpcDispatchContext): Promise<ProviderCredentialReply> {
  const pluginId = requireSandboxPluginId(ctx)
  const providerId = asNonEmptyString(params.providerId)
  if (providerId === undefined) {
    throw errorWithCode('INVALID_PAYLOAD: providers.credential requires a non-empty string field providerId.', 'INVALID_PAYLOAD')
  }
  const manifest = deps.readPluginManifest(pluginId)
  if (manifest === undefined) {
    throw errorWithCode(
      `PERMISSION_DENIED: cannot read installed manifest for plugin '${pluginId}' — ` +
        `providers.credential is only available to installed plugins (fail-closed).`,
      'PERMISSION_DENIED',
    )
  }
  if (!manifest.capabilities.includes('network.http')) {
    throw errorWithCode(
      `PERMISSION_DENIED: providers.credential requires the 'network.http' capability in the ` +
        `plugin manifest (plaintext credentials only serve network actions). ` +
        `Recovery: declare network.http in taijiPlugin.capabilities and reinstall.`,
      'PERMISSION_DENIED',
    )
  }
  assertInNamespace(pluginId, manifest.pkgName, providerId)
  const resolved = await deps.resolveProviderCredential(providerId)
  if (resolved === undefined) {
    throw errorWithCode(
      `PROVIDER_CREDENTIAL_MISSING: no credential entry found for '${providerId}' — ` +
        `the provider has not been authorized yet (providers.write first).`,
      'PROVIDER_CREDENTIAL_MISSING',
    )
  }
  if ('unsupported' in resolved) {
    return { providerId, unsupported: resolved.unsupported }
  }
  return { providerId, key: resolved.key, source: resolved.source, kind: resolved.kind }
}

/**
 * 注册三方法（组合根在 PluginService 构造后装配：pluginService.rpcServer 直注）。
 * 与 registerAllRpcMethods（plugin-rpc-setup，U3 范围）并列的独立注册点——providers.*
 * 是羊毛/插件域的宿主服务通道，归属本模块自包含。
 */
export function registerProviderWriteProxy(rpcServer: PluginRpcServer, deps: ProviderWriteProxyDeps): void {
  rpcServer.registerMethod(PROVIDERS_WRITE_METHOD, (params, ctx) => handleProviderWrite(deps, params, ctx))
  rpcServer.registerMethod(PROVIDERS_DELETE_METHOD, (params, ctx) => handleProviderDelete(deps, params, ctx))
  rpcServer.registerMethod(PROVIDERS_CREDENTIAL_METHOD, (params, ctx) => handleProviderCredential(deps, params, ctx))
}

/**
 * 组合根装配的插件清单读取器：descriptor.pluginPath 是 entry 文件（可能在 dist/ 子目录），
 * 包根 = 自 entry 目录向上第一个含 package.json 的祖先（npm 生态通用语义）。
 * registry 以窄接口注入（{ getDescriptor } 子集），本模块不 import PluginRegistry 类型。
 */
export function createPluginManifestReader(
  registry: { getDescriptor(pluginId: string): { pluginPath: string } | undefined },
): (pluginId: string) => PluginManifestInfo | undefined {
  return (pluginId: string) => {
    const descriptor = registry.getDescriptor(pluginId)
    if (descriptor === undefined) return undefined
    let dir = dirname(descriptor.pluginPath)
    for (let depth = 0; depth < MAX_PACKAGE_ROOT_WALK_DEPTH; depth++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        try {
          const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
            name?: unknown
            taijiPlugin?: { capabilities?: unknown }
          }
          if (typeof raw.name !== 'string' || raw.name.length === 0) return undefined
          const capabilities = raw.taijiPlugin?.capabilities
          return {
            pkgName: raw.name,
            capabilities: Array.isArray(capabilities)
              ? capabilities.filter((entry): entry is string => typeof entry === 'string')
              : [],
          }
        } catch {
          return undefined
        }
      }
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
    return undefined
  }
}
