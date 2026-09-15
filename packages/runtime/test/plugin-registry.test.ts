import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { registerToolRpcHandlers, createToolApi } from '../src/services/plugin-service/tool-api.js'
import { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'
import type { ToolEntry, RpcResponse } from '../src/services/plugin-service/plugin-types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(__dirname, 'fixtures/plugins')

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-registry-test-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/**
 * 在 <tmpDir>/.taiji/plugins/ 下创建指定名称的插件子目录，
 * 并写入 package.json。
 */
async function createPluginDir(pluginName: string, packageJson: Record<string, unknown>): Promise<string> {
  const pluginDir = join(tmpDir, '.taiji', 'plugins', pluginName)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf-8')
  return pluginDir
}

describe('PluginRegistry', () => {
  // ── TC-1-01: scan() discovers valid plugin from fixture dir ────
  it('TC-1-01: scan() discovers valid plugin from fixture dir', async () => {
    // 复制 fixture 到 temp dir
    const pluginDir = join(tmpDir, '.taiji', 'plugins', 'hello-world')
    await mkdir(pluginDir, { recursive: true })
    await cp(join(FIXTURES_DIR, 'hello-world'), pluginDir, { recursive: true })

    const registry = new PluginRegistry(tmpDir, tmpDir)
    const descriptors = await registry.scan()

    expect(descriptors.length >= 1).toBeTruthy()
    const hw = descriptors.find(d => d.pluginId === 'hello-world')!
    expect(hw).toBeTruthy()
    // Version comes from fixture package.json; don't hardcode to avoid CI flakiness
    expect(hw.version).toBeTruthy()
    expect(hw.displayName).toBe('Hello World')
    expect(hw.description).toBe('A test plugin for taiji')
    expect(hw.main).toBe('index.js')
    // S1-W4（D3）新语义：external 插件 trustLevel 由宿主按 source 强制判定（sandbox），
    // manifest 自报 "trusted" 不再生效（回归防护见 plugin-registry-trust.test.ts）
    expect(hw.trustLevel).toBe('sandbox')
    expect(hw.activationEvents.includes('onStartupFinished')).toBeTruthy()
    expect(hw.activationEvents.includes('onSlashCommand:hello')).toBeTruthy()
  })

  // ── TC-1-02: scan() skips invalid manifest (no taijiPlugin field) ─
  it('TC-1-02: scan() skips invalid manifest (no taijiPlugin field)', async () => {
    const noAgent = join(tmpDir, '.taiji', 'plugins', 'no-agent')
    await mkdir(noAgent, { recursive: true })
    await writeFile(
      join(noAgent, 'package.json'),
      JSON.stringify({ name: 'no-agent', version: '1.0.0' }),
      'utf-8',
    )

    const registry = new PluginRegistry(join(tmpDir, 'scan-no-agent'), join(tmpDir, 'scan-no-agent'))
    const descriptors = await registry.scan()
    const found = descriptors.find(d => d.pluginId === 'no-agent')
    expect(found).toBe(undefined)
  })

  // ── TC-1-03: scan() auto-infers activationEvents from contributes ─
  it('TC-1-03: scan() auto-infers activationEvents from contributes', async () => {
    await createPluginDir('infer-test', {
      name: 'infer-test',
      version: '1.0.0',
      taijiPlugin: {
        manifestVersion: 1,
        main: 'index.js',
        // 不声明 onSlashCommand:foo —— 应从 contributes 自动推断
        activationEvents: ['onStartupFinished'],
        contributes: {
          slashCommands: [
            { name: 'foo', description: 'Foo command' },
            { name: 'bar', description: 'Bar command' },
          ],
        },
      },
    })

    const registry = new PluginRegistry(tmpDir, tmpDir)
    await registry.scan()
    const desc = registry.getDescriptor('infer-test')!

    expect(desc).toBeTruthy()
    expect(desc.activationEvents.includes('onStartupFinished')).toBeTruthy()
    expect(
      desc.activationEvents.includes('onSlashCommand:foo'),
    ).toBeTruthy()
    expect(
      desc.activationEvents.includes('onSlashCommand:bar'),
    ).toBeTruthy()
  })

  // ── TC-1-04: cacheDescriptors / getDescriptor / getAllDescriptors ─
  it('TC-1-04: cacheDescriptors / getDescriptor / getAllDescriptors', async () => {
    const registry = new PluginRegistry(tmpDir, tmpDir)

    const descA = {
      pluginId: 'plugin-a',
      version: '1.0.0',
      displayName: 'Plugin A',
      description: '',
      main: 'index.js',
      activationEvents: ['onStartupFinished'],
      trustLevel: 'sandbox' as const,
      status: 'UNLOADED' as const,
      contributes: {},
      permissions: [],
      engines: { 'taiji': '*' },
      pluginPath: '/tmp/plugin-a',
      source: 'external' as const,
      extensionDependencies: [],
    }
    const descB = {
      pluginId: 'plugin-b',
      version: '2.0.0',
      displayName: 'Plugin B',
      description: 'Second plugin',
      main: 'main.js',
      activationEvents: ['onSlashCommand:test'],
      trustLevel: 'trusted' as const,
      status: 'UNLOADED' as const,
      contributes: {},
      permissions: [],
      engines: { 'taiji': '*' },
      pluginPath: '/tmp/plugin-b',
      source: 'external' as const,
      extensionDependencies: [],
    }

    registry.cacheDescriptors([descA, descB])

    expect(registry.getDescriptor('plugin-a')).toEqual(descA)
    expect(registry.getDescriptor('plugin-b')).toEqual(descB)
    expect(registry.getDescriptor('nonexistent')).toBe(undefined)

    const all = registry.getAllDescriptors()
    expect(all.length).toBe(2)
    const ids = all.map(d => d.pluginId).sort()
    expect(ids).toEqual(['plugin-a', 'plugin-b'])
  })

  // ── TC-1-05: reload() re-scans ────────────────────────────────
  it('TC-1-05: reload() re-scans', async () => {
    // 先扫描，此时应包含 hello-world
    const registry = new PluginRegistry(tmpDir, tmpDir)
    const first = await registry.scan()
    expect(first.some(d => d.pluginId === 'hello-world')).toBeTruthy()

    // 添加新插件
    await createPluginDir('late-plugin', {
      name: 'late-plugin',
      version: '1.0.0',
      taijiPlugin: { manifestVersion: 1, main: 'index.js', activationEvents: [] },
    })

    const reloaded = await registry.reload()
    expect(reloaded.some(d => d.pluginId === 'late-plugin')).toBeTruthy()
    expect(reloaded.some(d => d.pluginId === 'hello-world')).toBeTruthy()
  })

  // ── TC-1-06: pluginPath 指向 main 入口文件而非插件目录 ──────────
  // 回归防护：ESM 禁止目录导入（ERR_UNSUPPORTED_DIR_IMPORT），plugin-bootstrap 的
  // load 分支直接 import(pluginPath)，pluginPath 存目录会导致激活必炸
  // （built-in statusline 曾因此从未激活成功）
  it('TC-1-06: pluginPath resolves to main entry file, not plugin directory', async () => {
    const pluginDir = join(tmpDir, '.taiji', 'plugins', 'entry-plugin')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
      name: 'entry-plugin',
      version: '1.0.0',
      taijiPlugin: { manifestVersion: 1, main: 'dist/entry.js', activationEvents: [] },
    }), 'utf-8')

    const registry = new PluginRegistry(tmpDir, tmpDir)
    await registry.scan()
    const desc = registry.getDescriptor('entry-plugin')!

    expect(desc).toBeTruthy()
    expect(desc.pluginPath).toBe(join(pluginDir, 'dist', 'entry.js'))
    expect(desc.main).toBe('dist/entry.js')
  })

  // ── TC-1-07: main 缺省时 fallback index.js（向后兼容）──────────
  it('TC-1-07: main falls back to index.js when manifest omits it', async () => {
    const pluginDir = join(tmpDir, '.taiji', 'plugins', 'default-main')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
      name: 'default-main',
      version: '1.0.0',
      taijiPlugin: { manifestVersion: 1, activationEvents: [] },
    }), 'utf-8')

    const registry = new PluginRegistry(tmpDir, tmpDir)
    await registry.scan()
    const desc = registry.getDescriptor('default-main')!

    expect(desc).toBeTruthy()
    expect(desc.main).toBe('index.js')
    expect(desc.pluginPath).toBe(join(pluginDir, 'index.js'))
  })

  // ── TC-1-08: main 越权路径（../ 逃逸 / 绝对路径）被拒 ──────────
  it('TC-1-08: main escaping plugin directory is rejected', async () => {
    await createPluginDir('escape-plugin', {
      name: 'escape-plugin',
      version: '1.0.0',
      taijiPlugin: { manifestVersion: 1, main: '../../outside.js', activationEvents: [] },
    })
    await createPluginDir('absolute-plugin', {
      name: 'absolute-plugin',
      version: '1.0.0',
      taijiPlugin: { manifestVersion: 1, main: '/etc/passwd', activationEvents: [] },
    })

    const registry = new PluginRegistry(tmpDir, tmpDir)
    const descriptors = await registry.scan()

    expect(descriptors.find(d => d.pluginId === 'escape-plugin')).toBe(undefined)
    expect(descriptors.find(d => d.pluginId === 'absolute-plugin')).toBe(undefined)
  })

  // ── built-in 扫描路径两形态（F4 dev 缺口回归防护）────────────────
  // 布局辅助：在 <root>/resources/plugins/<name>/ 下造一个最小 built-in 插件
  async function createBuiltinPlugin(root: string, name: string): Promise<string> {
    const pluginDir = join(root, 'resources', 'plugins', name)
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
      name,
      version: '1.0.0',
      taijiPlugin: { manifestVersion: 1, main: 'index.js', activationEvents: ['onStartupFinished'] },
    }), 'utf-8')
    return pluginDir
  }

  // TC-1-09: dev 形态（pnpm dev，cwd=apps/electron，仓库根在上两层）
  it('TC-1-09: built-in dir resolves via ../.. when cwd is apps/electron (dev form)', async () => {
    const root = join(tmpDir, 'builtin-dev-form')
    await createBuiltinPlugin(root, 'builtin-dev')
    // projectRoot 模拟 pnpm dev 的 runtime cwd：<root>/apps/electron
    const projectRoot = join(root, 'apps', 'electron')
    await mkdir(projectRoot, { recursive: true })

    const registry = new PluginRegistry(projectRoot, join(root, 'config'))
    const descriptors = await registry.scan()

    const desc = descriptors.find(d => d.pluginId === 'builtin-dev')
    expect(desc).toBeTruthy()
    expect(desc!.source).toBe('built-in')
    expect(desc!.pluginPath).toBe(join(root, 'resources', 'plugins', 'builtin-dev', 'index.js'))
  })

  // TC-1-10: 仓库根形态（隔离 tsx / 本地 dist / 打包 cwd=Resources，resources 就在 cwd 下）
  it('TC-1-10: built-in dir resolves directly under projectRoot (repo-root/packaged form)', async () => {
    const root = join(tmpDir, 'builtin-root-form')
    await createBuiltinPlugin(root, 'builtin-root')

    const registry = new PluginRegistry(root, join(root, 'config'))
    const descriptors = await registry.scan()

    const desc = descriptors.find(d => d.pluginId === 'builtin-root')
    expect(desc).toBeTruthy()
    expect(desc!.source).toBe('built-in')
    expect(desc!.pluginPath).toBe(join(root, 'resources', 'plugins', 'builtin-root', 'index.js'))
  })

  // TC-1-11: 两候选同时存在时 projectRoot 本地目录优先（候选顺序锁定）
  it('TC-1-11: local resources/plugins wins over ../.. candidate when both exist', async () => {
    const root = join(tmpDir, 'builtin-prio-form')
    await createBuiltinPlugin(root, 'up-level-builtin')
    const projectRoot = join(root, 'apps', 'electron')
    // projectRoot 本地也放一个 built-in
    await createBuiltinPlugin(projectRoot, 'local-builtin')

    const registry = new PluginRegistry(projectRoot, join(root, 'config'))
    const descriptors = await registry.scan()

    expect(descriptors.find(d => d.pluginId === 'local-builtin')).toBeTruthy()
    expect(descriptors.find(d => d.pluginId === 'up-level-builtin')).toBe(undefined)
  })

  // TC-1-12: package.json 非法 JSON → 落 warning 并跳过（U09 重构前覆盖缺口补测）
  it('TC-1-12: scan() skips plugin with unparseable package.json and warns', async () => {
    const badJson = join(tmpDir, '.taiji', 'plugins', 'bad-json')
    await mkdir(badJson, { recursive: true })
    await writeFile(join(badJson, 'package.json'), '{ not valid json', 'utf-8')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const registry = new PluginRegistry(tmpDir, tmpDir, join(tmpDir, 'builtin-none'))
      const descriptors = await registry.scan()
      expect(descriptors.find(d => d.pluginId === 'bad-json')).toBe(undefined)
      expect(
        warnSpy.mock.calls.some(args => args[0] === `[plugin-registry] invalid JSON in ${join(badJson, 'package.json')}, skipping`),
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  // TC-1-13: taijiPlugin.manifestVersion !== 1 → 落 warning 并跳过（U09 重构前覆盖缺口补测）
  it('TC-1-13: scan() skips plugin with unsupported manifestVersion and warns', async () => {
    await createPluginDir('bad-manifest-version', {
      name: 'bad-manifest-version',
      version: '1.0.0',
      taijiPlugin: { manifestVersion: 2 },
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const registry = new PluginRegistry(tmpDir, tmpDir, join(tmpDir, 'builtin-none'))
      const descriptors = await registry.scan()
      expect(descriptors.find(d => d.pluginId === 'bad-manifest-version')).toBe(undefined)
      expect(
        warnSpy.mock.calls.some(args => args[0] === '[plugin-registry] bad-manifest-version: missing or invalid taijiPlugin manifest, skipping'),
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ── U2（timeout-plugin-service-granularity）：ToolRegistration.timeoutMs 声明通道 ──
//
// 覆盖 tool-api.ts 注册入口的窄校验与透传（设计 §6.1 D1 / §7 文件地图 / 错误规格表
// 「声明值非法」行）：
// - 合法正数 → 透传存储（运行时语义归 bridge-interop resolveToolTimeoutMs，U1 领地）
// - 非 number / NaN → 注册入口 fail-fast（INVALID_TIMEOUT_MS，对齐 ui-api INVALID_* 风格）
// - 0 / 负数 / Infinity → 合法声明（显式 opt-out），不抛、透传
// - 缺省 → 不落键，现状注册行为不变（兼容用例）
describe('ToolRegistration.timeoutMs — register 入口校验与透传 (U2)', () => {
  interface MockPort extends WorkerPort { messages: unknown[] }

  function createMockPort(): MockPort {
    const messages: unknown[] = []
    return { messages, postMessage(msg: unknown) { messages.push(msg) } }
  }

  function extractLastResponse(port: MockPort): RpcResponse & { error?: { code: string | number; message: string } } {
    const last = port.messages[port.messages.length - 1] as { response: RpcResponse }
    return last.response as RpcResponse & { error?: { code: string | number; message: string } }
  }

  interface Harness {
    rpc: PluginRpcServer
    toolRegistry: Map<string, ToolEntry>
    syncCalls: () => number
    dispatchRegister: (params: Record<string, unknown>) => Promise<RpcResponse & { error?: { code: string | number; message: string } }>
  }

  /** 搭一个带 registerToolRpcHandlers 的最小 RPC 环境，dispatch 后返回最后一个响应 */
  function setup(): Harness {
    const rpc = new PluginRpcServer()
    const toolRegistry = new Map<string, ToolEntry>()
    let syncCount = 0
    registerToolRpcHandlers(rpc, {
      toolRegistry,
      syncToolsToBridge: async () => { syncCount++ },
    })
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    let nextId = 1
    return {
      rpc,
      toolRegistry,
      syncCalls: () => syncCount,
      dispatchRegister: async (params) => {
        const id = nextId++
        await rpc.dispatch('w1', { jsonrpc: '2.0', id, method: 'plugin.tools.register', params })
        const resp = extractLastResponse(port)
        expect(resp.id).toBe(id)
        return resp
      },
    }
  }

  const baseParams = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    pluginId: 'my-plugin',
    name: 'my-tool',
    description: 'A test tool',
    parameters: {},
    ...extra,
  })

  it('合法正数 timeoutMs → 注册成功且透传到 registry schema', async () => {
    const h = setup()
    const resp = await h.dispatchRegister(baseParams({ timeoutMs: 600_000 }))

    expect('result' in resp).toBeTruthy()
    expect(h.toolRegistry.get('my-plugin:my-tool')!.schema.timeoutMs).toBe(600_000)
    expect(h.syncCalls()).toBe(1)
  })

  it('timeoutMs 为字符串 → 抛 INVALID_TIMEOUT_MS，不落 registry、不 sync', async () => {
    const h = setup()
    const resp = await h.dispatchRegister(baseParams({ timeoutMs: '600000' }))

    expect('error' in resp).toBeTruthy()
    expect(String(resp.error!.code)).toBe('INVALID_TIMEOUT_MS')
    expect(resp.error!.message.includes('timeoutMs')).toBeTruthy()
    expect(h.toolRegistry.size).toBe(0)
    expect(h.syncCalls()).toBe(0)
  })

  it('timeoutMs 为 NaN → 抛 INVALID_TIMEOUT_MS，不落 registry、不 sync', async () => {
    const h = setup()
    const resp = await h.dispatchRegister(baseParams({ timeoutMs: Number.NaN }))

    expect('error' in resp).toBeTruthy()
    expect(String(resp.error!.code)).toBe('INVALID_TIMEOUT_MS')
    expect(h.toolRegistry.size).toBe(0)
    expect(h.syncCalls()).toBe(0)
  })

  it('不传 timeoutMs → 注册成功且 schema 不落键（现状兼容，缺省回落语义归 U1）', async () => {
    const h = setup()
    const resp = await h.dispatchRegister(baseParams())

    expect('result' in resp).toBeTruthy()
    const schema = h.toolRegistry.get('my-plugin:my-tool')!.schema
    expect('timeoutMs' in schema).toBe(false)
    expect(schema.timeoutMs).toBe(undefined)
  })

  it.each([0, -1, Number.POSITIVE_INFINITY] as const)('timeoutMs = %p（显式 opt-out）→ 注册成功且透传', async (declared) => {
    const h = setup()
    const resp = await h.dispatchRegister(baseParams({ timeoutMs: declared }))

    expect('result' in resp).toBeTruthy()
    expect(h.toolRegistry.get('my-plugin:my-tool')!.schema.timeoutMs).toBe(declared)
  })

  it('Worker 侧 createToolApi → timeoutMs 随 RPC 载荷透传主线程', async () => {
    const client = new PluginRpcClient()
    const port = createMockPort()
    client.attach(port)

    const api = createToolApi(client, 'my-plugin')
    const pending = api.register({ name: 'my-tool', description: '', parameters: {}, timeoutMs: 600_000 })

    // 取 Worker 发出的 register 请求，回放成功响应完成往返
    const last = port.messages[port.messages.length - 1] as { id: number; params: Record<string, unknown> }
    expect(last.params.timeoutMs).toBe(600_000)
    client.handleResponse({ jsonrpc: '2.0', id: last.id, result: 'my-plugin:my-tool' })

    const toolKey = await pending
    expect(toolKey).toBe('my-plugin:my-tool')
  })

  it('Worker 侧 createToolApi → 缺省 timeoutMs 不发键（现状兼容）', async () => {
    const client = new PluginRpcClient()
    const port = createMockPort()
    client.attach(port)

    const api = createToolApi(client, 'my-plugin')
    const pending = api.register({ name: 'my-tool', description: '', parameters: {} })

    const last = port.messages[port.messages.length - 1] as { id: number; params: Record<string, unknown> }
    expect('timeoutMs' in last.params).toBe(false)
    client.handleResponse({ jsonrpc: '2.0', id: last.id, result: 'my-plugin:my-tool' })

    await pending
  })
})
