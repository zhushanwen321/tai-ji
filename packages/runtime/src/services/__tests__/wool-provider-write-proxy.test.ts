/**
 * providers.* 三 RPC 代理测试（provider-plugin-access D4；S20/S21 宿主侧断言）。
 *
 * 覆盖：S20 正向回读（命名空间内 + network.http 已声明 → 定向 reply 携明文）；
 * S21 越权两态拒绝（跨命名空间 NAMESPACE_MISMATCH / 未声明 network.http
 * PERMISSION_DENIED，两者 resolver 均零调用——无凭据外泄）；write/delete 的命名空间
 * 前缀边界；帧审计（明文只出现在发起 worker 的定向 reply——广播通道 / 第二 worker /
 * 控制台三通道零命中）；createPluginManifestReader 的包根定位（entry 在子目录形态）。
 *
 * 走真实 PluginRpcServer dispatch 链（wire response 形态即插件侧所见），依赖 stub 注入。
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run wool
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRpcServer } from '../plugin-service/plugin-rpc-server.js'
import type { RpcRequest } from '../plugin-service/plugin-types.js'
import {
  registerProviderWriteProxy,
  createPluginManifestReader,
  PROVIDERS_WRITE_METHOD,
  PROVIDERS_DELETE_METHOD,
  PROVIDERS_CREDENTIAL_METHOD,
  WRITE_BROADCAST_DEBOUNCE_MS,
  type ProviderWriteProxyDeps,
} from '../provider-write-proxy.js'

/** 羊毛形态插件清单：WorkBuddy 插件（ns=wool-workbuddy，含 network.http）。 */
const WORKBUDDY_MANIFEST = { pkgName: '@zhushanwen/plugin-wool-workbuddy', capabilities: ['network.http'] as const }

function makeDeps(overrides: Partial<ProviderWriteProxyDeps> = {}): ProviderWriteProxyDeps {
  const deps: ProviderWriteProxyDeps = {
    setProvider: vi.fn(async () => ({ newDefault: undefined })),
    deleteProvider: vi.fn(async () => ({ removed: true })),
    resolveProviderCredential: vi.fn(async () => ({
      key: 'sk-wool-secret-key',
      source: 'models.json' as const,
      kind: 'api_key' as const,
    })),
    readPluginManifest: vi.fn((pluginId: string) => (pluginId === 'plugin-wool-workbuddy' ? { ...WORKBUDDY_MANIFEST } : undefined)),
    notifyProvidersMutated: vi.fn(),
  }
  return { ...deps, ...overrides }
}

/** 收集定向 response 的 worker port stub。 */
function makeWorkerPort() {
  const responses: Array<Record<string, unknown>> = []
  return {
    port: { postMessage: (msg: unknown) => { responses.push(msg as Record<string, unknown>) } },
    responses,
  }
}

async function dispatch(rpcServer: PluginRpcServer, workerId: string, method: string, params: Record<string, unknown>): Promise<void> {
  const request: RpcRequest = { jsonrpc: '2.0', id: 1, method, params }
  await rpcServer.dispatch(workerId, request)
}

/** 从 worker port 收集的 response 提取 plugin 域字符串错误码（replyHandlerError 透传到 error.code）。 */
function errorCodeOf(responses: Array<Record<string, unknown>>): string | undefined {
  const response = responses[responses.length - 1]?.response as { error?: { code?: unknown } } | undefined
  const raw = response?.error?.code
  return typeof raw === 'string' ? raw : undefined
}

describe('providers.* 代理（provider-plugin-access D4）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('S20 正向：network.http 已声明 + 命名空间内 → credential 定向 reply 携本命名空间明文', async () => {
    const rpcServer = new PluginRpcServer()
    const deps = makeDeps()
    registerProviderWriteProxy(rpcServer, deps)
    const { port, responses } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })

    await dispatch(rpcServer, 'w1', PROVIDERS_CREDENTIAL_METHOD, { providerId: 'wool-workbuddy' })

    expect(vi.mocked(deps.resolveProviderCredential)).toHaveBeenCalledWith('wool-workbuddy')
    const response = responses[0]?.response as { result?: { key?: string; source?: string; kind?: string; providerId?: string } }
    expect(response.result).toEqual({
      providerId: 'wool-workbuddy',
      key: 'sk-wool-secret-key',
      source: 'models.json',
      kind: 'api_key',
    })
  })

  it('S21-① 越权：请求他插件命名空间的 providerId → NAMESPACE_MISMATCH，resolver 零调用（无凭据外泄）', async () => {
    const rpcServer = new PluginRpcServer()
    const deps = makeDeps()
    registerProviderWriteProxy(rpcServer, deps)
    const { port, responses } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })

    await dispatch(rpcServer, 'w1', PROVIDERS_CREDENTIAL_METHOD, { providerId: 'wool-trae' })

    expect(errorCodeOf(responses)).toBe('NAMESPACE_MISMATCH')
    expect(vi.mocked(deps.resolveProviderCredential)).not.toHaveBeenCalled()
  })

  it('S21-② 未声明 network.http → PERMISSION_DENIED，resolver 零调用', async () => {
    const rpcServer = new PluginRpcServer()
    const deps = makeDeps({
      readPluginManifest: vi.fn(() => ({ pkgName: '@zhushanwen/plugin-wool-workbuddy', capabilities: [] })),
    })
    registerProviderWriteProxy(rpcServer, deps)
    const { port, responses } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })

    await dispatch(rpcServer, 'w1', PROVIDERS_CREDENTIAL_METHOD, { providerId: 'wool-workbuddy' })

    expect(errorCodeOf(responses)).toBe('PERMISSION_DENIED')
    expect(vi.mocked(deps.resolveProviderCredential)).not.toHaveBeenCalled()
  })

  it('凭据 resolver 走 unsupported 形态时如实透传（不猜明文）', async () => {
    const rpcServer = new PluginRpcServer()
    const deps = makeDeps({
      resolveProviderCredential: vi.fn(async () => ({ unsupported: 'command' as const })),
    })
    registerProviderWriteProxy(rpcServer, deps)
    const { port, responses } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })

    await dispatch(rpcServer, 'w1', PROVIDERS_CREDENTIAL_METHOD, { providerId: 'wool-workbuddy' })

    const response = responses[0]?.response as { result?: { unsupported?: string } }
    expect(response.result).toEqual({ providerId: 'wool-workbuddy', unsupported: 'command' })
  })

  it('write 正向：载荷映射进 setProvider 写策略链（displayName→name、headers/models 透传）', async () => {
    const rpcServer = new PluginRpcServer()
    const deps = makeDeps()
    registerProviderWriteProxy(rpcServer, deps)
    const { port, responses } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })

    await dispatch(rpcServer, 'w1', PROVIDERS_WRITE_METHOD, {
      providerId: 'wool-workbuddy',
      apiKey: 'sk-new',
      displayName: 'WorkBuddy',
      headers: { 'x-wool-refresh-token': 'rt-1' },
      models: [{ id: 'deepseek-v4.1', name: 'DeepSeek' }, 'glm-5.3'],
    })

    expect(vi.mocked(deps.setProvider)).toHaveBeenCalledWith('wool-workbuddy', {
      name: 'WorkBuddy',
      apiKey: 'sk-new',
      headers: { 'x-wool-refresh-token': 'rt-1' },
      models: [{ id: 'deepseek-v4.1', name: 'DeepSeek' }, 'glm-5.3'],
    })
    const response = responses[0]?.response as { result?: { written?: boolean } }
    expect(response.result?.written).toBe(true)
  })

  it('write 载荷校验：headers 值非字符串 → INVALID_PAYLOAD 显式拒绝（与 models 元素同款），setProvider 零调用', async () => {
    const rpcServer = new PluginRpcServer()
    const deps = makeDeps()
    registerProviderWriteProxy(rpcServer, deps)
    const { port, responses } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })

    // 2026-10-25 审查回写：修复前该形态被 filter 静默丢弃（写入侧与插件预期静默漂移）
    await dispatch(rpcServer, 'w1', PROVIDERS_WRITE_METHOD, {
      providerId: 'wool-workbuddy',
      apiKey: 'sk-new',
      headers: { 'x-wool-refresh-token': 'rt-1', bad: 42 },
    })

    expect(errorCodeOf(responses)).toBe('INVALID_PAYLOAD')
    expect(vi.mocked(deps.setProvider)).not.toHaveBeenCalled()
  })

  it('write 越权：ns 前缀边界外（无连字符粘尾）→ NAMESPACE_MISMATCH，setProvider 零调用', async () => {
    const rpcServer = new PluginRpcServer()
    const deps = makeDeps()
    registerProviderWriteProxy(rpcServer, deps)
    const { port, responses } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })

    await dispatch(rpcServer, 'w1', PROVIDERS_WRITE_METHOD, { providerId: 'wool-workbuddy2', apiKey: 'sk-x' })

    expect(errorCodeOf(responses)).toBe('NAMESPACE_MISMATCH')
    expect(vi.mocked(deps.setProvider)).not.toHaveBeenCalled()
  })

  it('write 前缀边界内：ns-<suffix> 形态放行', async () => {
    const rpcServer = new PluginRpcServer()
    const deps = makeDeps()
    registerProviderWriteProxy(rpcServer, deps)
    const { port } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })

    await dispatch(rpcServer, 'w1', PROVIDERS_WRITE_METHOD, { providerId: 'wool-workbuddy-extra', apiKey: 'sk-x' })

    expect(vi.mocked(deps.setProvider)).toHaveBeenCalledWith('wool-workbuddy-extra', { apiKey: 'sk-x' })
  })

  it('delete：命名空间内放行走既有删除链；越权拒绝', async () => {
    const rpcServer = new PluginRpcServer()
    const deps = makeDeps()
    registerProviderWriteProxy(rpcServer, deps)
    const { port, responses } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })

    await dispatch(rpcServer, 'w1', PROVIDERS_DELETE_METHOD, { providerId: 'wool-workbuddy' })
    expect(vi.mocked(deps.deleteProvider)).toHaveBeenCalledWith('wool-workbuddy')
    const ok = responses[0]?.response as { result?: { deleted?: boolean } }
    expect(ok.result?.deleted).toBe(true)

    await dispatch(rpcServer, 'w1', PROVIDERS_DELETE_METHOD, { providerId: 'wool-qoder' })
    expect(errorCodeOf(responses)).toBe('NAMESPACE_MISMATCH')
  })

  it('trusted 共享 Worker（无唯一身份）fail-closed 拒绝', async () => {
    const rpcServer = new PluginRpcServer()
    const deps = makeDeps()
    registerProviderWriteProxy(rpcServer, deps)
    const { port, responses } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'trusted' })

    await dispatch(rpcServer, 'w1', PROVIDERS_CREDENTIAL_METHOD, { providerId: 'wool-workbuddy' })

    expect(errorCodeOf(responses)).toBe('PERMISSION_DENIED')
    expect(vi.mocked(deps.resolveProviderCredential)).not.toHaveBeenCalled()
  })

  it('帧审计：明文只出现在发起 worker 的定向 reply——第二 worker、notify 广播通道、console 三通道零命中', async () => {
    const rpcServer = new PluginRpcServer()
    const deps = makeDeps()
    registerProviderWriteProxy(rpcServer, deps)
    const initiator = makeWorkerPort()
    const bystander = makeWorkerPort()
    rpcServer.registerWorker('w-init', initiator.port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })
    rpcServer.registerWorker('w-other', bystander.port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-qoder' })
    const notifySpy = vi.spyOn(rpcServer, 'notify')
    const consoleSpy = vi.spyOn(console, 'log')
    const consoleWarnSpy = vi.spyOn(console, 'warn')
    const consoleErrorSpy = vi.spyOn(console, 'error')

    await dispatch(rpcServer, 'w-init', PROVIDERS_CREDENTIAL_METHOD, { providerId: 'wool-workbuddy' })

    // 定向 reply：发起 worker 收到明文
    expect(JSON.stringify(initiator.responses)).toContain('sk-wool-secret-key')
    // 非发起插件：零消息
    expect(bystander.responses).toEqual([])
    // 广播通道：零调用
    expect(notifySpy).not.toHaveBeenCalled()
    // 控制台：零命中
    for (const spy of [consoleSpy, consoleWarnSpy, consoleErrorSpy]) {
      expect(spy.mock.calls.map((call) => call.join(' ')).join('\n')).not.toContain('sk-wool-secret-key')
    }
  })
})

describe('写落点广播（ISSUES-2 ⑧：write/delete 成功 → 去抖合并后 notify 一次）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** 带去抖时钟推进的装配：write 派发后 advance 一个去抖窗口，notify 兑现在窗口尾部。 */
  async function setupWithWorker(deps: ProviderWriteProxyDeps) {
    const rpcServer = new PluginRpcServer()
    registerProviderWriteProxy(rpcServer, deps)
    const { port } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })
    return rpcServer
  }

  it('write 成功 → 去抖窗口后 notify 恰一次（窗口内零调用 = 广播延后到窗口尾部）', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const rpcServer = await setupWithWorker(deps)

    await dispatch(rpcServer, 'w1', PROVIDERS_WRITE_METHOD, { providerId: 'wool-workbuddy', apiKey: 'sk-x' })
    expect(deps.notifyProvidersMutated).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(WRITE_BROADCAST_DEBOUNCE_MS)
    expect(deps.notifyProvidersMutated).toHaveBeenCalledTimes(1)
  })

  it('连续两次 write（writeCredentials + writeCatalog 批量形态）→ 合并为一次广播', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const rpcServer = await setupWithWorker(deps)

    await dispatch(rpcServer, 'w1', PROVIDERS_WRITE_METHOD, { providerId: 'wool-workbuddy', apiKey: 'sk-x' })
    await dispatch(rpcServer, 'w1', PROVIDERS_WRITE_METHOD, { providerId: 'wool-workbuddy', models: ['m1'] })

    await vi.advanceTimersByTimeAsync(WRITE_BROADCAST_DEBOUNCE_MS)
    expect(deps.notifyProvidersMutated).toHaveBeenCalledTimes(1)
  })

  it('delete 成功 → 同样触发一次广播', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const rpcServer = await setupWithWorker(deps)

    await dispatch(rpcServer, 'w1', PROVIDERS_DELETE_METHOD, { providerId: 'wool-workbuddy' })
    await vi.advanceTimersByTimeAsync(WRITE_BROADCAST_DEBOUNCE_MS)
    expect(deps.notifyProvidersMutated).toHaveBeenCalledTimes(1)
  })

  it('providers.credential 只读 → 零广播', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const rpcServer = await setupWithWorker(deps)

    await dispatch(rpcServer, 'w1', PROVIDERS_CREDENTIAL_METHOD, { providerId: 'wool-workbuddy' })
    await vi.advanceTimersByTimeAsync(WRITE_BROADCAST_DEBOUNCE_MS)
    expect(deps.notifyProvidersMutated).not.toHaveBeenCalled()
  })

  it('write 被拒（NAMESPACE_MISMATCH，写未发生）→ 零广播', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const rpcServer = await setupWithWorker(deps)

    await dispatch(rpcServer, 'w1', PROVIDERS_WRITE_METHOD, { providerId: 'wool-trae', apiKey: 'sk-x' })
    await vi.advanceTimersByTimeAsync(WRITE_BROADCAST_DEBOUNCE_MS)
    expect(deps.notifyProvidersMutated).not.toHaveBeenCalled()
  })
})

describe('S20/S21 磁盘断言（唯一权威落盘 + 拒绝路径零副作用）', () => {
  let dataDir: string | undefined

  afterEach(() => {
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    dataDir = undefined
  })

  /** fixture 数据目录全量快照（相对路径 → 内容）：拒绝路径「零新增 / 零改动」的逐字节比对源。 */
  function snapshotDataDir(dir: string): Array<[string, string]> {
    const out: Array<[string, string]> = []
    const walk = (abs: string, rel: string): void => {
      for (const name of readdirSync(abs)) {
        const childAbs = join(abs, name)
        const childRel = rel === '' ? name : `${rel}/${name}`
        if (statSync(childAbs).isDirectory()) walk(childAbs, childRel)
        else out.push([childRel, readFileSync(childAbs, 'utf8')])
      }
    }
    walk(dir, '')
    return out.sort(([a], [b]) => a.localeCompare(b))
  }

  /** models.json 写入通道 fixture（代理注入面 = setProvider；生产实现 = ConfigService 写策略链）。 */
  function diskDeps(dir: string): ProviderWriteProxyDeps {
    const modelsPath = join(dir, 'models.json')
    const readStore = (): { providers: Record<string, Record<string, unknown>> } =>
      JSON.parse(readFileSync(modelsPath, 'utf8')) as { providers: Record<string, Record<string, unknown>> }
    return {
      setProvider: vi.fn(async (providerId, data) => {
        const store = readStore()
        store.providers[providerId] = { ...store.providers[providerId], ...data }
        writeFileSync(modelsPath, JSON.stringify(store, null, 2), 'utf8')
        return {}
      }),
      deleteProvider: vi.fn(async (providerId) => {
        const store = readStore()
        const existed = providerId in store.providers
        delete store.providers[providerId]
        writeFileSync(modelsPath, JSON.stringify(store, null, 2), 'utf8')
        return { removed: existed }
      }),
      resolveProviderCredential: vi.fn(async (providerId: string) => {
        const entry = readStore().providers[providerId]
        const key = entry?.apiKey
        return typeof key === 'string'
          ? { key, source: 'models.json' as const, kind: 'api_key' as const }
          : undefined
      }),
      readPluginManifest: vi.fn((pluginId: string) => (pluginId === 'plugin-wool-workbuddy' ? { ...WORKBUDDY_MANIFEST } : undefined)),
      notifyProvidersMutated: vi.fn(),
    }
  }

  it('S20 磁盘：providers.write 落盘后明文只出现在 models.json 一处（插件侧/宿主侧无第二落点）', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wool-proxy-disk-'))
    writeFileSync(join(dataDir, 'models.json'), JSON.stringify({ providers: {} }), 'utf8')
    const rpcServer = new PluginRpcServer()
    registerProviderWriteProxy(rpcServer, diskDeps(dataDir))
    const { port } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })

    await dispatch(rpcServer, 'w1', PROVIDERS_WRITE_METHOD, { providerId: 'wool-workbuddy', apiKey: 'sk-disk-secret' })

    const files = snapshotDataDir(dataDir)
    // 目录增量：只有 models.json（代理自身不落任何其它文件——无插件 sidecar、无凭据缓存）
    expect(files.map(([rel]) => rel)).toEqual(['models.json'])
    // 唯一权威承载明文
    expect(files[0]?.[1]).toContain('sk-disk-secret')
    const carriers = files.filter(([, content]) => content.includes('sk-disk-secret'))
    expect(carriers.map(([rel]) => rel)).toEqual(['models.json'])
  })

  it('S21 磁盘：越权拒绝（write + credential 跨命名空间）前后数据目录逐字节相同', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wool-proxy-disk-'))
    writeFileSync(
      join(dataDir, 'models.json'),
      JSON.stringify({ providers: { 'wool-trae': { apiKey: 'sk-trae-other-ns' } } }, null, 2),
      'utf8',
    )
    const rpcServer = new PluginRpcServer()
    registerProviderWriteProxy(rpcServer, diskDeps(dataDir))
    const { port } = makeWorkerPort()
    rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'plugin-wool-workbuddy' })
    const before = snapshotDataDir(dataDir)

    await dispatch(rpcServer, 'w1', PROVIDERS_WRITE_METHOD, { providerId: 'wool-trae', apiKey: 'sk-attacker' })
    await dispatch(rpcServer, 'w1', PROVIDERS_CREDENTIAL_METHOD, { providerId: 'wool-trae' })

    expect(snapshotDataDir(dataDir)).toEqual(before)
    expect(JSON.stringify(snapshotDataDir(dataDir))).not.toContain('sk-attacker')
  })
})

describe('createPluginManifestReader（包根定位：entry 在子目录形态）', () => {
  let tmpDir: string | undefined
  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    tmpDir = undefined
  })

  it('从 entry 文件目录向上找 package.json 命中包根（dist/index.js 形态）', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wool-proxy-reader-'))
    const pkgDir = join(tmpDir, 'plugin-wool-x')
    mkdirSync(join(pkgDir, 'dist'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@zhushanwen/plugin-wool-x',
      taijiPlugin: { capabilities: ['network.http', 'crypto'] },
    }), 'utf8')
    const entryPath = join(pkgDir, 'dist', 'index.js')

    const read = createPluginManifestReader({ getDescriptor: (id) => (id === 'plugin-wool-x' ? { pluginPath: entryPath } : undefined) })

    expect(read('plugin-wool-x')).toEqual({
      pkgName: '@zhushanwen/plugin-wool-x',
      capabilities: ['network.http', 'crypto'],
    })
    expect(read('unknown-plugin')).toBeUndefined()
  })

  it('包清单缺 name → undefined（fail-closed 输入）', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wool-proxy-reader-'))
    const pkgDir = join(tmpDir, 'plugin-bad')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ taijiPlugin: {} }), 'utf8')

    const read = createPluginManifestReader({ getDescriptor: () => ({ pluginPath: join(pkgDir, 'index.js') }) })
    expect(read('plugin-bad')).toBeUndefined()
  })
})
