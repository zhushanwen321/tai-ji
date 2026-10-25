/**
 * providers.write → providers.credential 真链路 roundtrip（⑦ 读写对称回归）。
 *
 * 既有 wool-provider-write-proxy.test.ts 全部 mock resolveProviderCredential——
 * 「真实 setProvider 写策略链 → 真实 ProviderCredentialResolver」的读写对称从未被
 * 体外覆盖（ISSUES-2 ⑦ 曾据此怀疑读写源不对称；本文件实测证明生产链在写后回读
 * 命中同一 key——真机落空的根因在插件侧调用形态，见 plugin-provider-access-
 * plugin-side.test.ts 的对象形态用例）。本文件用真实 pi-provider-store（setModelsPath
 * 指向 tmp）+ 真实 setProvider + 真实 resolver 走完整 dispatch 链钉住该对称。
 *
 * 运行：cd packages/runtime && npx vitest run provider-credential-roundtrip
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRpcServer } from '../plugin-service/plugin-rpc-server.js'
import type { RpcRequest, RpcResponse } from '../plugin-service/plugin-types.js'
import { AuthStorage } from '../auth/auth-storage.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import { setProvider as setProviderImpl } from '../provider-config-helper.js'
import {
  setModelsPath,
  readModels,
  getProviderConfig,
  upsertProvider,
  ensureProviderInWhitelist,
} from '../../infra/pi/pi-provider-store.js'
import { registerProviderWriteProxy } from '../provider-write-proxy.js'

let dir: string

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 真实生产装配的最小复刻：pi-provider-store 模块单例 + AuthStorage + 真实 resolver。 */
function wireProduction() {
  dir = mkdtempSync(join(tmpdir(), 'provider-cred-roundtrip-'))
  setModelsPath(join(dir, 'models.json'))
  const authStorage = new AuthStorage(join(dir, 'auth.json'))
  const configStore = {
    readModels: () => readModels(),
    getProviderConfig: (providerId: string) => getProviderConfig(providerId),
    upsertProvider: (providerId: string, config: Record<string, unknown>) => upsertProvider(providerId, config as never),
    ensureProviderInWhitelist: (providerId: string) => ensureProviderInWhitelist(providerId),
  }
  const resolver = new ProviderCredentialResolver({
    authService: { getCredential: (providerId: string) => authStorage.get(providerId) },
    authStorage,
    configStore,
  })
  return { authStorage, configStore, resolver }
}

async function dispatch(rpcServer: PluginRpcServer, method: string, params: Record<string, unknown>): Promise<RpcResponse> {
  const responses: RpcResponse[] = []
  rpcServer.registerWorker('w1', { postMessage: (msg) => { responses.push((msg as { response: RpcResponse }).response) } }, {
    trustLevel: 'sandbox',
    pluginId: 'zhushanwen__plugin-wool-qoder',
  })
  const request: RpcRequest = { jsonrpc: '2.0', id: 1, method, params }
  await rpcServer.dispatch('w1', request)
  expect(responses.length).toBe(1)
  return responses[0]
}

describe('providers.write → providers.credential 真链路 roundtrip（⑦ 读写对称）', () => {
  it('插件条目（custom 通道落 models.json）写入后 credential 回读命中同一 key', async () => {
    const { authStorage, configStore, resolver } = wireProduction()
    const apiKey = 'dt-' + 'k'.repeat(24) // wool-qoder 真实发布形态的长度锚（dt- + 24）
    const rpcServer = new PluginRpcServer()
    registerProviderWriteProxy(rpcServer, {
      setProvider: (providerId, data) => setProviderImpl(configStore as never, authStorage, undefined, undefined, providerId, data as never),
      deleteProvider: async () => ({ removed: true }),
      resolveProviderCredential: (providerId) => resolver.resolveProviderCredential(providerId),
      readPluginManifest: () => ({ pkgName: '@zhushanwen/plugin-wool-qoder', capabilities: ['network.http'] }),
    })

    const writeReply = await dispatch(rpcServer, 'providers.write', {
      providerId: 'wool-qoder',
      apiKey,
      models: [{ id: 'wool-qoder/basic', api: 'wool-qoder', baseUrl: 'https://example.invalid' }],
    })
    expect('result' in writeReply && (writeReply.result as { written?: boolean }).written).toBe(true)

    const credReply = await dispatch(rpcServer, 'providers.credential', { providerId: 'wool-qoder' })
    expect('result' in credReply ? credReply.result : undefined).toEqual({
      providerId: 'wool-qoder',
      key: apiKey,
      source: 'models.json',
      kind: 'api_key',
    })
  })
})
