import { PermissionConstants, PluginRpcErrorCodes } from '../../plugin-sdk/src/types.js';
import type { IMessageBroker } from '../src/interfaces.js';
import { PluginActivator, type PluginHost as ActivatorHost } from '../src/services/plugin-service/plugin-activator.js';
import { freezeApiSurface } from '../src/services/plugin-service/plugin-api-freeze.js';
import type { PluginHost } from '../src/services/plugin-service/plugin-host.js';
import { PermissionStorage } from '../src/services/plugin-service/plugin-permission-storage.js';
import { PluginPermissionChecker } from '../src/services/plugin-service/plugin-permission.js';
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js';
import { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js';
import { PluginRpcServer, RpcIdentity, WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js';
import { EXTERNAL_PLUGIN_DISABLED, EXTERNAL_PLUGIN_DISABLED_MESSAGE, EXTERNAL_PLUGIN_ENABLED } from '../src/services/plugin-service/plugin-security.js';
import { PluginService } from '../src/services/plugin-service/plugin-service.js';
import { PluginStorage } from '../src/services/plugin-service/plugin-storage.js';
import { RpcResponse, type Phase2AgentAPI, type PluginDescriptor, type ToolEntry } from '../src/services/plugin-service/plugin-types.js';
import type { SessionDataStore } from '../src/services/plugin-service/session-data-store.js';
import { createToolApi, registerToolRpcHandlers } from '../src/services/plugin-service/tool-api.js';
import { InstallResult, type IPluginInstaller, type PreparedPluginInstall } from '../src/services/ports/plugin-installer.js';
import { registerProviderWriteProxy } from '../src/services/provider-write-proxy.js';
import { getSessionPluginDataPath } from '@taiji/shared/paths';
import { PLUGIN_RPC_METHODS, normalizePermissionInput } from '@taiji/shared/plugin-permission-map';
import { existsSync } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/plugin-registry.test.ts
// ======================================================================

const __dirname = dirname(fileURLToPath(import.meta.url))

const FIXTURES_DIR = resolve(__dirname, 'fixtures/plugins')


let tmpDir: string


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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-registry', () => {
beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-registry-test-'))
})
afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
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
    // fixture package.json 是仓库内静态目录，版本恒定——精确断言可抓「读错字段」回归
    expect(hw.version).toBe('0.3.14')
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
  // （built-in 插件目录缺编译产物时曾因此从未激活成功）
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
// - 合法正数 → 透传存储（运行时语义归 tool-timeout resolveToolTimeoutMs，U1 领地）
// - 非 number / NaN → 注册入口 fail-fast（INVALID_TIMEOUT_MS，对齐 ui-api INVALID_* 风格）
// - 0 / 负数 / Infinity → 合法声明（显式 opt-out），不抛、透传
// - 缺省 → 不落键，现状注册行为不变（兼容用例）
describe('ToolRegistration.timeoutMs — register 入口校验与透传 (U2)', () => {
  interface MockPort extends WorkerPort { messages: unknown[] }  // oe-exempt:20261027:test:

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
    dispatchRegister: (params: Record<string, unknown>) => Promise<RpcResponse & { error?: { code: string | number; message: string } }>
  }

  /** 搭一个带 registerToolRpcHandlers 的最小 RPC 环境，dispatch 后返回最后一个响应 */
  function setup(): Harness {
    const rpc = new PluginRpcServer()
    const toolRegistry = new Map<string, ToolEntry>()
      registerToolRpcHandlers(rpc, {
      toolRegistry,
    })
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    let nextId = 1
    return {
      rpc,
      toolRegistry,
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
  })

  it('timeoutMs 为字符串 → 抛 INVALID_TIMEOUT_MS，不落 registry', async () => {
    const h = setup()
    const resp = await h.dispatchRegister(baseParams({ timeoutMs: '600000' }))

    expect('error' in resp).toBeTruthy()
    expect(String(resp.error!.code)).toBe('INVALID_TIMEOUT_MS')
    expect(resp.error!.message.includes('timeoutMs')).toBeTruthy()
    expect(h.toolRegistry.size).toBe(0)
  })

  it('timeoutMs 为 NaN → 抛 INVALID_TIMEOUT_MS，不落 registry', async () => {
    const h = setup()
    const resp = await h.dispatchRegister(baseParams({ timeoutMs: Number.NaN }))

    expect('error' in resp).toBeTruthy()
    expect(String(resp.error!.code)).toBe('INVALID_TIMEOUT_MS')
    expect(h.toolRegistry.size).toBe(0)
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
});

// ======================================================================
// ← test/plugin-installer.test.ts
// ======================================================================

// Mock downloadPackageTarball（infra 的纯 Node 下载函数），由测试控制成功/失败 +
// 在 targetDir 写入自定义 package.json。installPackage 等其他导出保留 no-op 占位
// 以防 NpmPluginInstaller 误调。
vi.mock('../src/infra/installers/npm-installer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/installers/npm-installer.js')>()
  return { ...actual, downloadPackageTarball: vi.fn(),
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
  installDependencies: vi.fn(),
  fetchLatestVersion: vi.fn(),
  NpmInstallError: class extends Error {
    code: 'not_found' | 'network' | 'extract' | 'integrity'
    constructor(code: 'not_found' | 'network' | 'extract' | 'integrity', message: string) {
      super(message)
      this.code = code
      this.name = 'NpmInstallError'
    }
  }, }
})


// Mock remote-config 清单链（U7 双产物接线后 confirmPluginInstall 会查 v2-plugins 清单）：
// 默认回「无缓存且未刷新」（fail-safe 链尾 → config undefined → 跳过扩展安装），防既有
// 用例触真实网络/真实 ~/.taiji 缓存；双产物用例经 refreshRemoteConfigMock 注入 fixture 清单。
const refreshRemoteConfigMock = vi.fn()

vi.mock('../src/services/remote-config/remote-config-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/remote-config/remote-config-fetch.js')>()
  return { ...actual, refreshRemoteConfig: (...args: unknown[]) => refreshRemoteConfigMock(...args),
  loadRemoteConfig: vi.fn(), }
})


// 延迟 import：vi.mock 会被提升到 import 之前，故此处能拿到 mocked 版本。
const { downloadPackageTarball, installDependencies } = await import('../src/infra/installers/npm-installer.js')

const { NpmPluginInstaller } = await import('../src/infra/installers/plugin-installer-adapter.js')

const { InstalledStore } = await import('../src/services/plugin-service/installed-store.js')

const { PluginRegistry: PluginRegistry_dyn } = await import('../src/services/plugin-service/plugin-registry.js')

const { PluginService: PluginService_dyn, PLUGIN_PREPARE_FAILED } = await import('../src/services/plugin-service/plugin-service.js')

const { NAMESPACE_MISMATCH } = await import('@taiji/shared/plugin-namespace')
const mockDownload = vi.mocked(downloadPackageTarball)


let tmpDir_m2_m2_m2_m2_m2_z2: string

let pluginsDir: string


/** 构造插件 package.json 内容（taijiPlugin manifest 字段按 opts 展开）。 */
function pkgJson(name: string, opts?: {
  version?: string
  manifestVersion?: number
  namespace?: string
  capabilities?: string[]
  readPaths?: string[]
  permissions?: string[]
  withMain?: boolean
}): string {
  const taijiPlugin: Record<string, unknown> = { manifestVersion: opts?.manifestVersion ?? 1 }
  if (opts?.namespace !== undefined) taijiPlugin.namespace = opts.namespace
  if (opts?.capabilities !== undefined) taijiPlugin.capabilities = opts.capabilities
  if (opts?.readPaths !== undefined) taijiPlugin.readPaths = opts.readPaths
  if (opts?.permissions !== undefined) taijiPlugin.permissions = opts.permissions
  return JSON.stringify(
    {
      name,
      version: opts?.version ?? '1.0.0',
      ...(opts?.withMain === false ? {} : { main: 'index.js' }),
      taijiPlugin,
    },
    null,
    2,
  )
}


/** mockDownload 变体：在 targetDir 写入给定 fixture（strip=1 解压后包内容落根）。 */
function mockDownloadWrites(pkg: string): void {
  mockDownload.mockImplementation(async (_spec: string, targetDir: string) => {
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'package.json'), pkg, 'utf-8')
    const parsed = JSON.parse(pkg) as { name: string; version?: string }
    return { name: parsed.name, version: parsed.version ?? '0.0.0' }
  })
}


/** 直接在 pluginsDir 下放置插件目录（预置已安装形态用）。 */
async function writePluginDir(dirName: string, pkg: string): Promise<string> {
  const dir = join(pluginsDir, dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), pkg, 'utf-8')
  await writeFile(join(dir, 'index.js'), 'export default {}', 'utf-8')
  return dir
}


function newInstaller(): InstanceType<typeof NpmPluginInstaller> {
  return new NpmPluginInstaller(pluginsDir)
}


function newRegistry(): InstanceType<typeof PluginRegistry_dyn> {
  return new PluginRegistry_dyn(tmpDir_m2_m2_m2_m2_m2_z2, tmpDir_m2_m2_m2_m2_m2_z2, join(tmpDir_m2_m2_m2_m2_m2_z2, 'no-builtin-dir'))
}


interface ProviderEntriesFake {  // oe-exempt:20261027:test:
  listIds: ReturnType<typeof vi.fn<() => Promise<string[]>>>
  delete: ReturnType<typeof vi.fn<(providerId: string) => Promise<void>>>
}


function makeProviderEntries(ids: string[]): ProviderEntriesFake {
  return {
    listIds: vi.fn(async () => [...ids]),
    delete: vi.fn(async () => {}),
  }
}


/** piExtensionInstaller port fake（U7/U4 双产物接线用例）：记录 install/uninstall 入参。 */
function makePiExtensionInstaller(): {
  installForCatalogEntry: ReturnType<typeof vi.fn<(entry: { packageName: string; piExtensionVersion: string }) => Promise<{ installedVersion: string }>>>
  uninstallForCatalogEntry: ReturnType<typeof vi.fn<(packageName: string) => Promise<void>>>
} {
  return {
    installForCatalogEntry: vi.fn(async () => ({ installedVersion: '0.2.0' })),
    uninstallForCatalogEntry: vi.fn(async () => {}),
  }
}


function buildService(opts?: {
  providerEntries?: ProviderEntriesFake
  piExtensionInstaller?: ReturnType<typeof makePiExtensionInstaller>
}): {
  service: InstanceType<typeof PluginService_dyn>
  registry: InstanceType<typeof PluginRegistry_dyn>
  broker: { send: ReturnType<typeof vi.fn>; broadcast: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
} {
  const registry = newRegistry()
  const broker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
  const service = new PluginService_dyn(registry, broker, {
    configDir: tmpDir_m2_m2_m2_m2_m2_z2,
    pluginInstaller: newInstaller(),
    ...(opts?.providerEntries ? { providerEntries: opts.providerEntries } : {}),
    ...(opts?.piExtensionInstaller ? { piExtensionInstaller: opts.piExtensionInstaller } : {}),
  })
  return { service, registry, broker }
}


/** spy 激活链：activatePlugin 吞错不抛，成败以 getState 终态判定（实现同款判据）。 */
function mockActivation(service: InstanceType<typeof PluginService_dyn>, outcome: 'ACTIVE' | 'CRASHED'): void {
  vi.spyOn(service.activator, 'activatePlugin').mockResolvedValue(undefined)
  vi.spyOn(service.activator, 'getState').mockReturnValue(outcome)
}


async function readInstalledJson(): Promise<Record<string, unknown>> {
  // 登记文件可能尚未创建（安装未发生过 = 无残留的断言形态），缺失按空表
  try {
    const raw = await readFile(join(pluginsDir, 'installed.json'), 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}


async function stagingEntries(): Promise<string[]> {
  try {
    return await readdir(join(pluginsDir, '.staging'))
  } catch {
    return []
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-installer', () => {
beforeEach(async () => {
  vi.clearAllMocks()
  refreshRemoteConfigMock.mockResolvedValue({ data: undefined, refreshed: false, reason: 'network' })
  // 安装/卸载编排会落 warn（激活失败回滚、清理跳过等），测试不依赖控制台输出
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  tmpDir_m2_m2_m2_m2_m2_z2 = await mkdtemp(join(tmpdir(), 'npm-plugin-installer-test-'))
  pluginsDir = join(tmpDir_m2_m2_m2_m2_m2_z2, 'plugins')
})
afterEach(async () => {
  await rm(tmpDir_m2_m2_m2_m2_m2_z2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {})
  vi.restoreAllMocks()
})
// ── NpmPluginInstaller：prepareInstall（第一段）─────────────────────

describe('NpmPluginInstaller.prepareInstall', () => {
  it('scoped 包解压至暂存，dirName 为 scope__pkg 安全化形态', async () => {
    const installer = newInstaller()
    mockDownloadWrites(pkgJson('@scope/test-plugin', { namespace: 'test-plugin' }))

    const result = await installer.prepareInstall('@scope/test-plugin@1.0.0')

    expect(result.success).toBe(true)
    const prepared = result.prepared!
    expect(prepared.dirName).toBe('scope__test-plugin')
    expect(prepared.stagingPath).toBe(join(pluginsDir, '.staging', 'scope__test-plugin'))
    expect(prepared.packageName).toBe('@scope/test-plugin')
    expect(prepared.version).toBe('1.0.0')
    expect(existsSync(join(prepared.stagingPath, 'package.json'))).toBe(true)
  })

  it('manifest 知情面全量透传（capabilities / readPaths / permissions / namespace）', async () => {
    const installer = newInstaller()
    mockDownloadWrites(pkgJson('plugin-wool-workbuddy', {
      namespace: 'wool-workbuddy',
      capabilities: ['network.http', 'crypto'],
      readPaths: ['Library/Application Support/WorkBuddy'],
      permissions: ['providers.write'],
    }))

    const result = await installer.prepareInstall('plugin-wool-workbuddy')

    expect(result.success).toBe(true)
    expect(result.prepared!.capabilities).toEqual(['network.http', 'crypto'])
    expect(result.prepared!.readPaths).toEqual(['Library/Application Support/WorkBuddy'])
    expect(result.prepared!.permissions).toEqual(['providers.write'])
    expect(result.prepared!.namespace).toBe('wool-workbuddy')
  })

  it('manifestVersion ≠ 1 → 拒装且暂存无残留', async () => {
    const installer = newInstaller()
    mockDownloadWrites(pkgJson('bad-plugin', { manifestVersion: 2 }))

    const result = await installer.prepareInstall('bad-plugin')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Not a valid taiji plugin')
    expect(existsSync(join(pluginsDir, '.staging', 'bad-plugin'))).toBe(false)
  })

  it('manifest 未声明 namespace → prepared.namespace 为 undefined（非 provider 插件常态）', async () => {
    const installer = newInstaller()
    mockDownloadWrites(pkgJson('plain-plugin'))

    const result = await installer.prepareInstall('plain-plugin')

    expect(result.success).toBe(true)
    expect(result.prepared!.namespace).toBeUndefined()
    expect(result.prepared!.capabilities).toEqual([])
  })

  it('下载失败 → success:false 且无暂存残留', async () => {
    const installer = newInstaller()
    mockDownload.mockRejectedValue(new Error('registry network error'))

    const result = await installer.prepareInstall('some-package')

    expect(result.success).toBe(false)
    expect(result.error).toContain('registry network error')
    expect(existsSync(join(pluginsDir, '.staging', 'some-package'))).toBe(false)
  })

  it('同插件重复 prepare 先清旧暂存（幂等重下）', async () => {
    const installer = newInstaller()
    const staleMarker = join(pluginsDir, '.staging', 'my-plugin', 'stale.txt')
    await mkdir(join(pluginsDir, '.staging', 'my-plugin'), { recursive: true })
    await writeFile(staleMarker, 'leftover', 'utf-8')
    mockDownloadWrites(pkgJson('my-plugin'))

    const result = await installer.prepareInstall('my-plugin')

    expect(result.success).toBe(true)
    expect(existsSync(staleMarker)).toBe(false)
    expect(existsSync(join(result.prepared!.stagingPath, 'package.json'))).toBe(true)
  })

  it('④ 声明 dependencies：prepare 段装依赖进暂存（随 commit 换入 pluginDir/node_modules）', async () => {
    const installer = newInstaller()
    const pkg = JSON.parse(pkgJson('@scope/test-plugin', { namespace: 'test-plugin' })) as Record<string, unknown>
    pkg.dependencies = { '@scope/shared-lib': '^1.0.0' }
    mockDownloadWrites(JSON.stringify(pkg))
    vi.mocked(installDependencies).mockResolvedValue({ failed: [] })

    const result = await installer.prepareInstall('@scope/test-plugin@1.0.0')

    expect(result.success).toBe(true)
    // 依赖落暂存目录 node_modules——暂存整体 rename 提交后即 pluginDir/node_modules
    //（sandbox 裸导入解析边界内），暂存/回滚语义不变
    expect(vi.mocked(installDependencies)).toHaveBeenCalledWith(result.prepared!.stagingPath)
  })

  it('④ 依赖安装失败：整体废弃暂存 + 结构化错误（fail-fast 在安装确认前）', async () => {
    const installer = newInstaller()
    const pkg = JSON.parse(pkgJson('my-plugin')) as Record<string, unknown>
    pkg.dependencies = { 'missing-dep': '^1.0.0' }
    mockDownloadWrites(JSON.stringify(pkg))
    vi.mocked(installDependencies).mockResolvedValue({
      failed: [{ name: 'missing-dep', error: 'Package not found (404)' }],
    })

    const result = await installer.prepareInstall('my-plugin')

    expect(result.success).toBe(false)
    expect(result.error).toContain('PLUGIN_DEPENDENCIES_INSTALL_FAILED')
    expect(result.error).toContain('missing-dep')
    expect(existsSync(join(pluginsDir, '.staging', 'my-plugin'))).toBe(false)
  })

  it('④ 零依赖插件：不触发依赖安装（零开销路径）', async () => {
    const installer = newInstaller()
    mockDownloadWrites(pkgJson('plain-plugin'))

    const result = await installer.prepareInstall('plain-plugin')

    expect(result.success).toBe(true)
    expect(vi.mocked(installDependencies)).not.toHaveBeenCalled()
  })
})
// ── NpmPluginInstaller：commitInstall / rollbackInstall（第二段与回滚）──

describe('NpmPluginInstaller.commitInstall', () => {
  function preparedOf(dirName: string): PreparedPluginInstall {
    return {
      dirName,
      packageName: `@scope/${dirName.replace('__', '/')}`,
      version: '1.0.0',
      stagingPath: join(pluginsDir, '.staging', dirName),
      capabilities: [],
      readPaths: [],
      permissions: [],
    }
  }

  it('首次提交：暂存单步换入正式目录，暂存消失', async () => {
    const installer = newInstaller()
    const dirName = 'scope__app'
    await mkdir(join(pluginsDir, '.staging', dirName), { recursive: true })
    await writeFile(join(pluginsDir, '.staging', dirName, 'package.json'), pkgJson('pkg'), 'utf-8')

    const result = await installer.commitInstall(preparedOf(dirName))

    expect(result.success).toBe(true)
    expect(result.pluginId).toBe(dirName)
    expect(result.path).toBe(join(pluginsDir, dirName))
    expect(existsSync(join(pluginsDir, dirName, 'package.json'))).toBe(true)
    expect(await stagingEntries()).toEqual([])
  })

  it('更新提交：旧版本被替换入 replacing 位（保留至激活终局清理），新版入位', async () => {
    const installer = newInstaller()
    const dirName = 'my-plugin'
    await writePluginDir(dirName, pkgJson('my-plugin', { version: '1.0.0' }))
    await mkdir(join(pluginsDir, '.staging', dirName), { recursive: true })
    await writeFile(join(pluginsDir, '.staging', dirName, 'package.json'), pkgJson('my-plugin', { version: '2.0.0' }), 'utf-8')

    const result = await installer.commitInstall(preparedOf(dirName))

    expect(result.success).toBe(true)
    const newPkg = JSON.parse(await readFile(join(pluginsDir, dirName, 'package.json'), 'utf-8')) as { version: string }
    expect(newPkg.version).toBe('2.0.0')
    // replacing 位保留（提交后激活失败的回滚仍需旧版本），激活成功后由 discardReplaced 清理
    const replacingPkg = JSON.parse(
      await readFile(join(pluginsDir, '.staging', `.replacing-${dirName}`, 'package.json'), 'utf-8'),
    ) as { version: string }
    expect(replacingPkg.version).toBe('1.0.0')

    await installer.discardReplaced(preparedOf(dirName))
    expect(await stagingEntries()).toEqual([])
  })

  it('换入失败（暂存缺失）→ success:false 且旧版本目录幸存、内容不变', async () => {
    const installer = newInstaller()
    const dirName = 'my-plugin'
    await writePluginDir(dirName, pkgJson('my-plugin', { version: '1.0.0' }))
    // prepared.stagingPath 指向不存在的暂存 → rename 必败（ENOENT）

    const result = await installer.commitInstall(preparedOf(dirName))

    expect(result.success).toBe(false)
    const oldPkg = JSON.parse(await readFile(join(pluginsDir, dirName, 'package.json'), 'utf-8')) as { version: string }
    expect(oldPkg.version).toBe('1.0.0')
  })
})
describe('NpmPluginInstaller.rollbackInstall', () => {
  async function preparedWithStaging(dirName: string, stagingVersion: string): Promise<PreparedPluginInstall> {
    await mkdir(join(pluginsDir, '.staging', dirName), { recursive: true })
    await writeFile(join(pluginsDir, '.staging', dirName, 'package.json'), pkgJson(dirName, { version: stagingVersion }), 'utf-8')
    return {
      dirName,
      packageName: dirName,
      version: stagingVersion,
      stagingPath: join(pluginsDir, '.staging', dirName),
      capabilities: [],
      readPaths: [],
      permissions: [],
    }
  }

  it('无旧版本：删除刚提交的新版目录', async () => {
    const installer = newInstaller()
    const prepared = await preparedWithStaging('my-plugin', '2.0.0')
    await installer.commitInstall(prepared)
    expect(existsSync(join(pluginsDir, 'my-plugin'))).toBe(true)

    await installer.rollbackInstall(prepared)

    expect(existsSync(join(pluginsDir, 'my-plugin'))).toBe(false)
  })

  it('更新场景：新版删除、旧版本从替换位恢复（旧版本幸存）', async () => {
    const installer = newInstaller()
    const dirName = 'my-plugin'
    await writePluginDir(dirName, pkgJson('my-plugin', { version: '1.0.0' }))
    const prepared = await preparedWithStaging(dirName, '2.0.0')
    await installer.commitInstall(prepared)
    // 模拟提交完成、激活失败的现场：replacing 位留有旧版 1.0.0
    const replacingPath = join(pluginsDir, '.staging', `.replacing-${dirName}`)
    await mkdir(join(pluginsDir, '.staging'), { recursive: true })
    await rm(replacingPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    await mkdir(replacingPath, { recursive: true })
    await writeFile(join(replacingPath, 'package.json'), pkgJson(dirName, { version: '1.0.0' }), 'utf-8')

    await installer.rollbackInstall(prepared)

    expect(existsSync(join(pluginsDir, dirName, 'package.json'))).toBe(true)
    const restoredPkg = JSON.parse(await readFile(join(pluginsDir, dirName, 'package.json'), 'utf-8')) as { version: string }
    expect(restoredPkg.version).toBe('1.0.0')
    expect(await stagingEntries()).toEqual([])
  })
})
describe('NpmPluginInstaller.sweepStaging（启动清扫，恢复类）', () => {
  it('正常暂存残留 → 删除', async () => {
    const installer = newInstaller()
    await mkdir(join(pluginsDir, '.staging', 'half-installed'), { recursive: true })
    await writeFile(join(pluginsDir, '.staging', 'half-installed', 'package.json'), '{}', 'utf-8')

    await installer.sweepStaging()

    expect(existsSync(join(pluginsDir, '.staging', 'half-installed'))).toBe(false)
  })

  it('替换位残留 + 正式位缺失 → 旧版本恢复为正式目录', async () => {
    const installer = newInstaller()
    const replacingPath = join(pluginsDir, '.staging', '.replacing-my-plugin')
    await mkdir(replacingPath, { recursive: true })
    await writeFile(join(replacingPath, 'package.json'), pkgJson('my-plugin', { version: '1.0.0' }), 'utf-8')

    await installer.sweepStaging()

    expect(existsSync(join(pluginsDir, 'my-plugin', 'package.json'))).toBe(true)
    expect(await stagingEntries()).toEqual([])
  })

  it('替换位残留 + 正式位存在（新版已入位）→ 替换位删除', async () => {
    const installer = newInstaller()
    await writePluginDir('my-plugin', pkgJson('my-plugin', { version: '2.0.0' }))
    const replacingPath = join(pluginsDir, '.staging', '.replacing-my-plugin')
    await mkdir(replacingPath, { recursive: true })
    await writeFile(join(replacingPath, 'package.json'), pkgJson('my-plugin', { version: '1.0.0' }), 'utf-8')

    await installer.sweepStaging()

    const curPkg = JSON.parse(await readFile(join(pluginsDir, 'my-plugin', 'package.json'), 'utf-8')) as { version: string }
    expect(curPkg.version).toBe('2.0.0')
    expect(await stagingEntries()).toEqual([])
  })

  it('暂存区不存在 → no-op 不抛', async () => {
    const installer = newInstaller()
    await expect(installer.sweepStaging()).resolves.toBeUndefined()
  })
})
describe('NpmPluginInstaller.uninstall', () => {
  it('删除插件目录', async () => {
    const dir = await writePluginDir('test-plugin', pkgJson('test-plugin'))
    const installer = newInstaller()

    await installer.uninstall('test-plugin', dir)

    await expect(readFile(join(dir, 'package.json'), 'utf-8')).rejects.toThrow()
  })
})
// ── InstalledStore：installed.json（只记安装时间，D11）──────────────

describe('InstalledStore', () => {
  function newStore(): InstanceType<typeof InstalledStore> {
    return new InstalledStore(pluginsDir)
  }

  it('recordInstalled 后 schema 只含 installedAt（版本与命名空间不落盘）', async () => {
    const store = newStore()

    await store.recordInstalled('my-plugin', '2026-10-24T00:00:00.000Z')

    const file = await readInstalledJson()
    expect(file).toEqual({ 'my-plugin': { installedAt: '2026-10-24T00:00:00.000Z' } })
    const entry = file['my-plugin'] as Record<string, unknown>
    expect(Object.keys(entry)).toEqual(['installedAt'])
  })

  it('recordUninstalled 移除条目', async () => {
    const store = newStore()
    await store.recordInstalled('a')
    await store.recordInstalled('b')

    await store.recordUninstalled('a')

    const file = await readInstalledJson()
    expect(Object.keys(file)).toEqual(['b'])
  })

  it('load：文件缺失 → 空表；损坏 JSON → 空表（容错不抛）', async () => {
    const store = newStore()
    expect(await store.load()).toEqual({})

    await mkdir(pluginsDir, { recursive: true })
    await writeFile(join(pluginsDir, 'installed.json'), '{ not json', 'utf-8')
    expect(await store.load()).toEqual({})
  })
})
// ── PluginRegistry：扫描口径与安装目录名对齐（S8）──────────────────

describe('PluginRegistry 扫描口径', () => {
  it('scope__pkg 目录形态被发现，pluginId 即目录名，version 读包内 package.json', async () => {
    await writePluginDir('scope__test-plugin', pkgJson('@scope/test-plugin', { version: '3.2.1' }))
    const registry = newRegistry()

    const descriptors = await registry.scan()

    const found = descriptors.find(d => d.pluginId === 'scope__test-plugin')
    expect(found).toBeDefined()
    expect(found!.version).toBe('3.2.1')
  })

  it('.staging 等辅助目录不作为插件扫描', async () => {
    await writePluginDir('real-plugin', pkgJson('real-plugin'))
    await mkdir(join(pluginsDir, '.staging', 'half-installed'), { recursive: true })
    await writeFile(join(pluginsDir, '.staging', 'half-installed', 'package.json'), pkgJson('half-installed'), 'utf-8')
    const registry = newRegistry()

    const descriptors = await registry.scan()

    expect(descriptors.map(d => d.pluginId)).toEqual(['real-plugin'])
  })
})
// ── PluginService：两段式编排 + 回滚 + 卸载清理（S8 / S18 / S22）────

describe('PluginService 两段式安装编排', () => {
  it('prepare → 确认卡知情面；confirm → 提交落盘 + 注册 + installed.json 登记 + 广播（S27/S8）', async () => {
    const { service, registry, broker } = buildService()
    mockDownloadWrites(pkgJson('@scope/test-plugin', {
      namespace: 'test-plugin',
      capabilities: ['network.http'],
      readPaths: ['some/path'],
    }))
    mockActivation(service, 'ACTIVE')

    const preview = await service.preparePluginInstall('@scope/test-plugin@1.0.0')
    expect(preview.pluginId).toBe('scope__test-plugin')
    expect(preview.packageName).toBe('@scope/test-plugin')
    expect(preview.capabilities).toEqual(['network.http'])
    expect(preview.readPaths).toEqual(['some/path'])
    expect(preview.namespace).toBe('test-plugin')
    // 未确认不落盘：只有暂存，正式目录未触及
    expect(existsSync(join(pluginsDir, 'scope__test-plugin'))).toBe(false)

    const result = await service.confirmPluginInstall('scope__test-plugin')

    expect(result.success).toBe(true)
    expect(result.pluginId).toBe('scope__test-plugin')
    expect(existsSync(join(pluginsDir, 'scope__test-plugin', 'package.json'))).toBe(true)
    expect(registry.getDescriptor('scope__test-plugin')).toBeDefined()
    const installed = await readInstalledJson()
    expect(Object.keys(installed)).toEqual(['scope__test-plugin'])
    expect(broker.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'config.plugins' }))
  })

  it('cancel → 暂存清理，再 confirm 报无 pending（未确认不发生安装落盘）', async () => {
    const { service } = buildService()
    mockDownloadWrites(pkgJson('cancel-me'))
    mockActivation(service, 'ACTIVE')

    await service.preparePluginInstall('cancel-me')
    expect(existsSync(join(pluginsDir, '.staging', 'cancel-me'))).toBe(true)

    await service.cancelPluginInstall('cancel-me')

    expect(existsSync(join(pluginsDir, '.staging', 'cancel-me'))).toBe(false)
    const result = await service.confirmPluginInstall('cancel-me')
    expect(result.success).toBe(false)
    expect(existsSync(join(pluginsDir, 'cancel-me'))).toBe(false)
  })

  it('confirm 无 pending 登记 → success:false', async () => {
    const { service } = buildService()
    const result = await service.confirmPluginInstall('never-prepared')
    expect(result.success).toBe(false)
  })

  it('S22：namespace 不匹配 → prepare 抛 NAMESPACE_MISMATCH 且列表/目录/暂存无残留', async () => {
    const { service, registry } = buildService()
    mockDownloadWrites(pkgJson('@scope/test-plugin', { namespace: 'totally-different' }))

    const err = await service.preparePluginInstall('@scope/test-plugin@1.0.0').catch((e: unknown) => e)

    expect((err as Error).message).toContain('NAMESPACE_MISMATCH')
    expect((err as { code?: string }).code).toBe(NAMESPACE_MISMATCH)
    expect(registry.getAllDescriptors()).toEqual([])
    expect(existsSync(join(pluginsDir, 'scope__test-plugin'))).toBe(false)
    expect(await stagingEntries()).toEqual([])
  })

  it('S22 反例：namespace 声明与包名推导一致 → prepare 成功且 namespace 为推导值', async () => {
    const { service } = buildService()
    mockDownloadWrites(pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    mockActivation(service, 'ACTIVE')

    const preview = await service.preparePluginInstall('@zhushanwen/plugin-wool-workbuddy')

    expect(preview.namespace).toBe('wool-workbuddy')
  })

  it('S18 档 1：manifest 校验失败 → 五处无残留 + 后续正常安装成功', async () => {
    const { service, registry } = buildService()
    mockDownloadWrites(pkgJson('broken-plugin', { manifestVersion: 2 }))
    mockActivation(service, 'ACTIVE')

    const result = await service.installPlugin('broken-plugin')

    expect(result.success).toBe(false)
    // 五处无残留：列表 / 注册表 / 插件目录 / 暂存 / installed.json
    expect(service.getDiscoveredPlugins().map(p => p.pluginId)).not.toContain('broken-plugin')
    expect(registry.getDescriptor('broken-plugin')).toBeUndefined()
    expect(existsSync(join(pluginsDir, 'broken-plugin'))).toBe(false)
    expect(await stagingEntries()).toEqual([])
    expect(await readInstalledJson()).toEqual({})

    // 后续正常安装成功
    mockDownloadWrites(pkgJson('good-plugin'))
    const second = await service.installPlugin('good-plugin')
    expect(second.success).toBe(true)
    expect(existsSync(join(pluginsDir, 'good-plugin', 'package.json'))).toBe(true)
  })

  it('S18 档 2：激活失败 → 五处无残留、旧版本幸存（更新场景）+ 后续正常安装成功', async () => {
    const { service, registry } = buildService()
    // 预置已安装旧版本 1.0.0
    await writePluginDir('upgradable', pkgJson('upgradable', { version: '1.0.0' }))
    const registryBefore = await registry.scan()
    expect(registryBefore.find(d => d.pluginId === 'upgradable')).toBeDefined()

    // 更新到 2.0.0，激活失败（getState = CRASHED）
    mockDownloadWrites(pkgJson('upgradable', { version: '2.0.0' }))
    mockActivation(service, 'CRASHED')

    const result = await service.installPlugin('upgradable')

    expect(result.success).toBe(false)
    expect(result.error).toContain('rolled back')
    // 五处无残留（新版）
    expect(existsSync(join(pluginsDir, '.staging', 'upgradable'))).toBe(false)
    expect(await stagingEntries()).toEqual([])
    const installed = await readInstalledJson()
    expect(Object.keys(installed)).not.toContain('upgradable')
    // 旧版本幸存：目录内容回到 1.0.0，注册表重扫后仍是旧版
    const oldPkg = JSON.parse(await readFile(join(pluginsDir, 'upgradable', 'package.json'), 'utf-8')) as { version: string }
    expect(oldPkg.version).toBe('1.0.0')
    const after = await registry.scan()
    expect(after.find(d => d.pluginId === 'upgradable')?.version).toBe('1.0.0')

    // 后续正常安装成功（激活恢复）
    mockActivation(service, 'ACTIVE')
    mockDownloadWrites(pkgJson('fresh-after-rollback'))
    const second = await service.installPlugin('fresh-after-rollback')
    expect(second.success).toBe(true)
    expect(Object.keys(await readInstalledJson())).toContain('fresh-after-rollback')
  })

  it('两段式激活失败回滚 → pending 随失败清理，重试 confirm 报可操作错误（非原始 ENOENT）', async () => {
    const { service } = buildService()
    mockDownloadWrites(pkgJson('activate-fail-plugin'))
    mockActivation(service, 'CRASHED')

    await service.preparePluginInstall('activate-fail-plugin')
    const first = await service.confirmPluginInstall('activate-fail-plugin')

    expect(first.success).toBe(false)
    expect(first.error).toContain('rolled back')
    expect(first.error).toContain('请重新发起安装')
    // staging 已被 commit rename 消费、正式目录被 rollback 删除
    expect(await stagingEntries()).toEqual([])
    expect(existsSync(join(pluginsDir, 'activate-fail-plugin'))).toBe(false)

    // 重试确认：pending 已随失败清理 → 指向恢复动作的可操作错误；
    // 若 pending 残留，此处是对缺失 staging rename 的原始 ENOENT 文案
    const retry = await service.confirmPluginInstall('activate-fail-plugin')
    expect(retry.success).toBe(false)
    expect(retry.error).toContain('call preparePluginInstall first')
  })

  it('直通 installPlugin（旧通道）：prepare + commit 一次完成，含激活与登记', async () => {
    const { service, registry, broker } = buildService()
    mockDownloadWrites(pkgJson('direct-plugin'))
    mockActivation(service, 'ACTIVE')

    const result = await service.installPlugin('direct-plugin')

    expect(result.success).toBe(true)
    expect(result.pluginId).toBe('direct-plugin')
    expect(registry.getDescriptor('direct-plugin')).toBeDefined()
    expect(Object.keys(await readInstalledJson())).toEqual(['direct-plugin'])
    expect(broker.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'config.plugins' }))
  })

  // ── R-1（2026-10-24 裁决）：更新链先 terminate 旧沙箱进程再激活（进程即模块边界）──
  // 单测层断言机制（terminate 先于 activatePlugin 的调用顺序 + trusted 跳过 + 回滚
  // 重激活）；真 fork 的「新代码生效 / PID 变化」终验归真机 a26 剧本（本层不 spawn）。

  it('R-1：已激活插件更新 → commit 后、activatePlugin 前 terminate 旧 sandbox fork', async () => {
    const { service } = buildService()
    await writePluginDir('upgradable', pkgJson('upgradable', { version: '1.0.0' }))
    mockDownloadWrites(pkgJson('upgradable', { version: '2.0.0' }))
    mockActivation(service, 'ACTIVE')
    const terminate = vi.spyOn(service.host, 'terminateWorker').mockResolvedValue(undefined)
    vi.spyOn(service.host, 'getWorkerHandle').mockReturnValue({ workerId: 'sandbox-42', postMessage: vi.fn() })

    const result = await service.installPlugin('upgradable')

    expect(result.success).toBe(true)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledWith('sandbox-42')
    // 顺序 = 缺陷本体：terminate 必须先于激活（否则 assignProcess 复用旧 fork + ESM
    // 模块缓存，更新后仍跑旧代码）
    expect(terminate.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(service.activator.activatePlugin).mock.invocationCallOrder[0]!,
    )
  })

  it('R-1：trusted 共享 Worker（非 sandbox- 前缀）→ 不 terminate（镜像卸载侧跳过判定）', async () => {
    const { service } = buildService()
    mockDownloadWrites(pkgJson('trusted-plugin'))
    mockActivation(service, 'ACTIVE')
    const terminate = vi.spyOn(service.host, 'terminateWorker').mockResolvedValue(undefined)
    vi.spyOn(service.host, 'getWorkerHandle').mockReturnValue({ workerId: 'worker-7', postMessage: vi.fn() })

    const result = await service.installPlugin('trusted-plugin')

    expect(result.success).toBe(true)
    expect(terminate).not.toHaveBeenCalled()
  })

  it('R-1：必败包更新（激活失败）→ 旧沙箱终结 + 回滚可达 + 旧版本重激活', async () => {
    const { service } = buildService()
    await writePluginDir('upgradable', pkgJson('upgradable', { version: '1.0.0' }))
    mockDownloadWrites(pkgJson('upgradable', { version: '2.0.0' }))
    mockActivation(service, 'CRASHED')
    const terminate = vi.spyOn(service.host, 'terminateWorker').mockResolvedValue(undefined)
    vi.spyOn(service.host, 'getWorkerHandle').mockReturnValue({ workerId: 'sandbox-9', postMessage: vi.fn() })

    const result = await service.installPlugin('upgradable')

    expect(result.success).toBe(false)
    expect(result.error).toContain('rolled back')
    expect(terminate).toHaveBeenCalledWith('sandbox-9')
    // 回滚分支对恢复的旧版本 best-effort 重激活（S26「旧版本幸存可用」的进程态语义：
    // 旧沙箱已终结，旧代码在新 fork 中重新激活，而非依赖被终结的旧进程）
    expect(vi.mocked(service.activator.activatePlugin)).toHaveBeenCalledTimes(2)
    // D6 问题 3：新版激活段起的坏 fork 在回滚重激活前也要终结（不终结则重激活复用
    // 坏进程 + ESM 缓存重放必抛错代码，停 discovered——与提交段 terminate 对称）
    expect(terminate).toHaveBeenCalledTimes(2)
    // D6 B1：回滚分支 removeDescriptor 后必须 registerDescriptors 回填（reload 恢复的
    // 旧版 descriptor），否则 activatePlugin 开头 descriptor 缺失静默 no-op = 重激活死路径。
    // 行为判据 = 回滚后 descriptors 表含本插件（activatePlugin 的 no-op 前置不再成立）
    expect(service.activator.getState('upgradable')).toBe('CRASHED') // mock 终态可达 = descriptor 在表内（真实实现不再 no-op）
    expect(service.registry.getDescriptor('upgradable')).toBeDefined()
    const oldPkg = JSON.parse(await readFile(join(pluginsDir, 'upgradable', 'package.json'), 'utf-8')) as { version: string }
    expect(oldPkg.version).toBe('1.0.0')
  })

  it('串行锁：并发两次安装严格串行（第二次等待第一次完成才开始下载）', async () => {
    const { service } = buildService()
    mockActivation(service, 'ACTIVE')
    const events: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    mockDownload.mockImplementation(async (spec: string, targetDir: string) => {
      events.push(`start:${spec}`)
      if (spec === 'first-plugin') await gate
      events.push(`end:${spec}`)
      await mkdir(targetDir, { recursive: true })
      await writeFile(join(targetDir, 'package.json'), pkgJson(spec), 'utf-8')
      return { name: spec, version: '1.0.0' }
    })

    const p1 = service.installPlugin('first-plugin')
    const p2 = service.installPlugin('second-plugin')
    releaseFirst()
    await Promise.all([p1, p2])

    // 有锁：first 完成后 second 才开始；无锁时 two start 会插在 first end 之前
    expect(events[0]).toBe('start:first-plugin')
    expect(events.indexOf('start:second-plugin')).toBeGreaterThan(events.indexOf('end:first-plugin'))
  })
})
describe('PluginService 双产物安装编排（U7/D6：confirm 成功后接 pi 扩展成员安装）', () => {
  const WOOL_ENTRY = {
    packageName: '@zhushanwen/plugin-wool-workbuddy',
    pluginId: 'zhushanwen__plugin-wool-workbuddy',
    displayName: 'WorkBuddy',
    pluginVersion: '1.0.0',
    piExtensionVersion: '0.2.0',
  }

  function mockCatalog(entries: unknown[]): void {
    refreshRemoteConfigMock.mockResolvedValue({ data: { version: 1, plugins: entries }, refreshed: true })
  }

  it('清单条目携带 piExtensionVersion（双产物）→ confirm 成功后调 piExtensionInstaller 安装扩展成员', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    const { service } = buildService({ piExtensionInstaller })
    mockCatalog([WOOL_ENTRY])
    mockDownloadWrites(pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    mockActivation(service, 'ACTIVE')

    await service.preparePluginInstall('@zhushanwen/plugin-wool-workbuddy')
    const result = await service.confirmPluginInstall('zhushanwen__plugin-wool-workbuddy')

    expect(result.success).toBe(true)
    expect(piExtensionInstaller.installForCatalogEntry).toHaveBeenCalledWith({
      packageName: '@zhushanwen/plugin-wool-workbuddy',
      piExtensionVersion: '0.2.0',
    })
  })

  it('单产物条目（无 piExtensionVersion）→ 跳过扩展安装，confirm 成功', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    const { service } = buildService({ piExtensionInstaller })
    mockCatalog([{ ...WOOL_ENTRY, piExtensionVersion: undefined }])
    mockDownloadWrites(pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    mockActivation(service, 'ACTIVE')

    await service.preparePluginInstall('@zhushanwen/plugin-wool-workbuddy')
    const result = await service.confirmPluginInstall('zhushanwen__plugin-wool-workbuddy')

    expect(result.success).toBe(true)
    expect(piExtensionInstaller.installForCatalogEntry).not.toHaveBeenCalled()
  })

  it('清单不可得（fail-safe 链尾）→ 跳过扩展安装不误伤（warn 留痕），confirm 成功', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    const { service } = buildService({ piExtensionInstaller })
    // 默认 refreshRemoteConfigMock = { data: undefined }（beforeEach 设置）
    mockDownloadWrites(pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    mockActivation(service, 'ACTIVE')

    await service.preparePluginInstall('@zhushanwen/plugin-wool-workbuddy')
    const result = await service.confirmPluginInstall('zhushanwen__plugin-wool-workbuddy')

    expect(result.success).toBe(true)
    expect(piExtensionInstaller.installForCatalogEntry).not.toHaveBeenCalled()
  })

  it('扩展成员安装失败 → confirm 整体报失败（插件已落盘事实保留），错误含恢复指引', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    piExtensionInstaller.installForCatalogEntry.mockRejectedValue(
      new Error('资产清单不可达。请检查网络后重试'),
    )
    const { service } = buildService({ piExtensionInstaller })
    mockCatalog([WOOL_ENTRY])
    mockDownloadWrites(pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    mockActivation(service, 'ACTIVE')

    await service.preparePluginInstall('@zhushanwen/plugin-wool-workbuddy')
    const result = await service.confirmPluginInstall('zhushanwen__plugin-wool-workbuddy')

    expect(result.success).toBe(false)
    expect(result.error).toContain('pi 扩展成员')
    expect(result.error).toContain('重试安装')
    // 插件侧已落盘事实保留（不回滚——重试安装幂等覆盖）
    expect(existsSync(join(pluginsDir, 'zhushanwen__plugin-wool-workbuddy', 'package.json'))).toBe(true)
  })
})
describe('PluginService 卸载编排', () => {
  it('provider 插件卸载：命名空间前缀扫描派生清理集 → 逐条 delete（含 apiKey 条目），非匹配条目不动', async () => {
    const providerEntries = makeProviderEntries([
      'wool-workbuddy',
      'wool-workbuddy-extra',
      'wool-workbuddy-alt-model',
      'other-provider',
    ])
    const { service, registry } = buildService({ providerEntries })
    // scoped provider 插件：包名 @x/plugin-wool-workbuddy → ns wool-workbuddy
    await writePluginDir('x__wool-workbuddy', pkgJson('@x/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    await registry.scan()
    // 预置安装登记（卸载后应一并移除）
    const store = new InstalledStore(pluginsDir)
    await store.recordInstalled('x__wool-workbuddy')

    await service.uninstallPlugin('x__wool-workbuddy')

    // 前缀匹配三条全部逐条 delete（'wool-workbuddy' 可为含 apiKey 的凭据条目——
    // delete 通道按 id 整条移除，凭据字段随条目消失）
    expect(providerEntries.delete).toHaveBeenCalledTimes(3)
    expect(providerEntries.delete).toHaveBeenCalledWith('wool-workbuddy')
    expect(providerEntries.delete).toHaveBeenCalledWith('wool-workbuddy-extra')
    expect(providerEntries.delete).toHaveBeenCalledWith('wool-workbuddy-alt-model')
    // 非匹配条目不触碰
    expect(providerEntries.listIds).toHaveBeenCalledTimes(1)
    // 插件目录拆除 + 注册表移除 + installed.json 条目移除
    expect(existsSync(join(pluginsDir, 'x__wool-workbuddy'))).toBe(false)
    expect(registry.getDescriptor('x__wool-workbuddy')).toBeUndefined()
    expect(Object.keys(await readInstalledJson())).not.toContain('x__wool-workbuddy')
  })

  it('非 provider 插件（manifest 未声明 namespace）卸载 → 不触碰 provider 条目', async () => {
    const providerEntries = makeProviderEntries(['wool-workbuddy', 'plain-plugin-something'])
    const { service, registry } = buildService({ providerEntries })
    await writePluginDir('plain-plugin', pkgJson('plain-plugin'))
    await registry.scan()

    await service.uninstallPlugin('plain-plugin')

    expect(providerEntries.delete).not.toHaveBeenCalled()
    expect(existsSync(join(pluginsDir, 'plain-plugin'))).toBe(false)
  })

  it('deps 未接 providerEntries port → 卸载照常完成（provider 清理跳过 warn）', async () => {
    const { service, registry } = buildService()
    await writePluginDir('no-port-plugin', pkgJson('no-port-plugin', { namespace: 'some-ns' }))
    await registry.scan()

    const result = await service.uninstallPlugin('no-port-plugin')

    expect(result.map(p => p.pluginId)).not.toContain('no-port-plugin')
    expect(existsSync(join(pluginsDir, 'no-port-plugin'))).toBe(false)
  })

  it('命名空间声明与包名推导不一致（手工放置的坏包）→ 不按错误声明清理', async () => {
    const providerEntries = makeProviderEntries(['victim-provider', 'victim-provider-x'])
    const { service } = buildService({ providerEntries })
    await writePluginDir('evil-plugin', pkgJson('@x/plugin-evil', { namespace: 'victim-provider' }))
    const registry = newRegistry()
    await registry.scan()

    await service.uninstallPlugin('evil-plugin')

    expect(providerEntries.delete).not.toHaveBeenCalled()
    expect(providerEntries.listIds).not.toHaveBeenCalled()
  })

  it('卸载与安装共用串行锁（与安装编排互斥）', async () => {
    const providerEntries = makeProviderEntries([])
    const { service } = buildService({ providerEntries })
    mockActivation(service, 'ACTIVE')
    const events: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    mockDownload.mockImplementation(async (spec: string, targetDir: string) => {
      events.push(`install-start:${spec}`)
      if (spec === 'locking-plugin') await gate
      events.push(`install-end:${spec}`)
      await mkdir(targetDir, { recursive: true })
      await writeFile(join(targetDir, 'package.json'), pkgJson(spec), 'utf-8')
      return { name: spec, version: '1.0.0' }
    })
    // provider 插件 fixture：卸载编排进入 provider 清理段时调 listIds（卸载开始标记）
    providerEntries.listIds.mockImplementation(async () => {
      events.push('uninstall-provider-cleanup')
      return []
    })
    await writePluginDir('concurrent-plugin', pkgJson('@x/plugin-concurrent', { namespace: 'concurrent' }))
    const registry = newRegistry()
    await registry.scan()

    const installP = service.installPlugin('locking-plugin')
    const uninstallP = service.uninstallPlugin('concurrent-plugin')
    releaseFirst()
    await Promise.all([installP, uninstallP])

    // 卸载编排等第一次安装完成才开始（同一把锁）
    expect(events.indexOf('uninstall-provider-cleanup')).toBeGreaterThan(events.indexOf('install-end:locking-plugin'))
  })

  it('双产物插件卸载：条目清理与 pi 扩展成员卸载一并执行（S23「卸载后扩展与条目一并清理」）', async () => {
    const providerEntries = makeProviderEntries(['wool-workbuddy', 'wool-workbuddy-extra'])
    const piExtensionInstaller = makePiExtensionInstaller()
    const { service, registry } = buildService({ providerEntries, piExtensionInstaller })
    await writePluginDir('zhushanwen__plugin-wool-workbuddy', pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    await registry.scan()

    await service.uninstallPlugin('zhushanwen__plugin-wool-workbuddy')

    // 扩展侧：包名交端口（家族推导在实现内——pi-wool-workbuddy 由 wool 域单测覆盖）
    expect(piExtensionInstaller.uninstallForCatalogEntry).toHaveBeenCalledWith('@zhushanwen/plugin-wool-workbuddy')
    // 条目侧：命名空间前缀扫描清理照旧
    expect(providerEntries.delete).toHaveBeenCalledWith('wool-workbuddy')
    // 插件侧：目录拆除 + 注册表移除
    expect(existsSync(join(pluginsDir, 'zhushanwen__plugin-wool-workbuddy'))).toBe(false)
    expect(registry.getDescriptor('zhushanwen__plugin-wool-workbuddy')).toBeUndefined()
  })

  it('pi 扩展成员卸载失败 → warn 不阻断：插件目录与注册表照常清理（卸载不抛）', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    piExtensionInstaller.uninstallForCatalogEntry.mockRejectedValue(
      new Error('扩展卸载失败：npm uninstall failed。请到扩展管理页重试卸载'),
    )
    const { service, registry } = buildService({ piExtensionInstaller })
    await writePluginDir('zhushanwen__plugin-wool-qoder', pkgJson('@zhushanwen/plugin-wool-qoder', { namespace: 'wool-qoder' }))
    await registry.scan()

    await expect(service.uninstallPlugin('zhushanwen__plugin-wool-qoder')).resolves.toBeDefined()

    expect(piExtensionInstaller.uninstallForCatalogEntry).toHaveBeenCalledWith('@zhushanwen/plugin-wool-qoder')
    // 插件侧清理完成（扩展残留走扩展管理页手动移除的恢复路径）
    expect(existsSync(join(pluginsDir, 'zhushanwen__plugin-wool-qoder'))).toBe(false)
    expect(registry.getDescriptor('zhushanwen__plugin-wool-qoder')).toBeUndefined()
  })

  it('包内 package.json 缺 name（异常包）→ 跳过扩展卸载，卸载照常完成', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    const { service, registry } = buildService({ piExtensionInstaller })
    // parseManifest 只校验 taijiPlugin manifest 不校验 name——name 缺失的包可入注册表
    await writePluginDir('nameless-plugin', JSON.stringify({
      version: '1.0.0',
      main: 'index.js',
      taijiPlugin: { manifestVersion: 1, namespace: 'wool-qoder' },
    }))
    await writeFile(join(pluginsDir, 'nameless-plugin', 'index.js'), 'export default {}', 'utf-8')
    await registry.scan()
    expect(registry.getDescriptor('nameless-plugin')).toBeDefined()

    await service.uninstallPlugin('nameless-plugin')

    expect(piExtensionInstaller.uninstallForCatalogEntry).not.toHaveBeenCalled()
    expect(existsSync(join(pluginsDir, 'nameless-plugin'))).toBe(false)
  })
})
});

// ======================================================================
// ← test/plugin-dependencies.test.ts
// ======================================================================

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'test',
    version: '1.0.0',
    displayName: 'Test Plugin',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/test-plugin',
    // 默认 built-in：依赖排序机制测试与激活锁（IF3）正交，锁只拦 external。
    source: 'built-in',
    extensionDependencies: [],
    ...overrides,
  }
}


function createMockHost(
  activator: PluginActivator,
  replyType: 'activated' | 'deactivated' = 'activated',
): ActivatorHost {
  return {
    assignWorker: vi.fn((_pluginId: string, _trustLevel: 'trusted' | 'sandbox') => {
      return Promise.resolve('worker-1')
    }),
    loadPlugin: vi.fn((_workerId: string, _pluginPath: string) => {
      return Promise.resolve()
    }),
    getWorkerHandle: vi.fn((pluginId: string) => ({
      workerId: 'worker-1',
      postMessage: vi.fn(() => {
        queueMicrotask(() => {
          activator.handleWorkerReply({
            type: replyType,
            pluginId,
          })
        })
      }),
    })),
    terminateWorker: vi.fn(() => Promise.resolve()),
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-dependencies', () => {
// ══════════════════════════════════════════════════════════════════
// Topological Sort
// ══════════════════════════════════════════════════════════════════

describe('PluginActivator.topologicalSort', () => {
  // ── TC-DEP-01: 空列表返回空 ─────────────────────────────────────
  it('TC-DEP-01: empty list returns empty array', () => {
    const activator = new PluginActivator()
    expect(activator.topologicalSort([])).toEqual([])
  })

  // ── TC-DEP-02: 无依赖返回相同长度 ───────────────────────────────
  it('TC-DEP-02: plugins without dependencies all included in result', () => {
    const activator = new PluginActivator()
    const p1 = makeDescriptor({ pluginId: 'a' })
    const p2 = makeDescriptor({ pluginId: 'b' })
    const p3 = makeDescriptor({ pluginId: 'c' })
    const sorted = activator.topologicalSort([p3, p1, p2])
    expect(sorted).toHaveLength(3)
    const ids = sorted.map(p => p.pluginId)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).toContain('c')
  })

  // ── TC-DEP-03: 简单链式依赖 ─────────────────────────────────────
  it('TC-DEP-03: simple dependency chain (a ← b ← c)', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: [] })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['a'] })
    const c = makeDescriptor({ pluginId: 'c', extensionDependencies: ['b'] })
    const sorted = activator.topologicalSort([c, a, b])
    expect(sorted).toHaveLength(3)
    const ids = sorted.map(p => p.pluginId)
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'))
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'))
  })

  // ── TC-DEP-04: 多重依赖 ────────────────────────────────────────
  it('TC-DEP-04: multiple dependencies (db ← auth, db ← api, auth ← api)', () => {
    const activator = new PluginActivator()
    const db = makeDescriptor({ pluginId: 'db' })
    const auth = makeDescriptor({ pluginId: 'auth', extensionDependencies: ['db'] })
    const api = makeDescriptor({ pluginId: 'api', extensionDependencies: ['auth', 'db'] })
    const sorted = activator.topologicalSort([api, auth, db])
    expect(sorted).toHaveLength(3)
    const ids = sorted.map(p => p.pluginId)
    expect(ids.indexOf('db')).toBeLessThan(ids.indexOf('auth'))
    expect(ids.indexOf('auth')).toBeLessThan(ids.indexOf('api'))
  })

  // ── TC-DEP-05: fan-out 依赖 ─────────────────────────────────────
  it('TC-DEP-05: fan-out (common dep)', () => {
    const activator = new PluginActivator()
    const core = makeDescriptor({ pluginId: 'core' })
    const ext1 = makeDescriptor({ pluginId: 'ext1', extensionDependencies: ['core'] })
    const ext2 = makeDescriptor({ pluginId: 'ext2', extensionDependencies: ['core'] })
    const sorted = activator.topologicalSort([ext2, core, ext1])
    expect(sorted).toHaveLength(3)
    const ids = sorted.map(p => p.pluginId)
    expect(ids.indexOf('core')).toBeLessThan(ids.indexOf('ext1'))
    expect(ids.indexOf('core')).toBeLessThan(ids.indexOf('ext2'))
  })

  // ── TC-DEP-06: 单个插件 ─────────────────────────────────────────
  it('TC-DEP-06: single plugin returns itself', () => {
    const activator = new PluginActivator()
    const p = makeDescriptor({ pluginId: 'solo' })
    const sorted = activator.topologicalSort([p])
    expect(sorted).toHaveLength(1)
    expect(sorted[0].pluginId).toBe('solo')
  })
})
// ══════════════════════════════════════════════════════════════════
// Cycle Detection
// ══════════════════════════════════════════════════════════════════

describe('PluginActivator.detectCycle', () => {
  // ── TC-DEP-07: 无循环返回 null ──────────────────────────────────
  it('TC-DEP-07: no circle returns null', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a' })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['a'] })
    expect(activator.detectCycle([a, b])).toBeNull()
  })

  // ── TC-DEP-08: 简单双向循环 ─────────────────────────────────────
  it('TC-DEP-08: simple bidirectional cycle (a ↔ b)', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['b'] })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['a'] })
    const cycled = activator.detectCycle([a, b])
    expect(cycled).not.toBeNull()
    expect(cycled!.length).toBeGreaterThan(0)
    // 循环中的插件 ID 应被返回
    expect(cycled).toContain('a')
    expect(cycled).toContain('b')
  })

  // ── TC-DEP-09: 自依赖循环 ──────────────────────────────────────
  it('TC-DEP-09: self-dependency cycle (a → a)', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['a'] })
    const cycled = activator.detectCycle([a])
    expect(cycled).not.toBeNull()
    expect(cycled).toContain('a')
  })

  // ── TC-DEP-10: 间接循环 ─────────────────────────────────────────
  it('TC-DEP-10: indirect cycle (a → b → c → a)', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['b'] })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['c'] })
    const c = makeDescriptor({ pluginId: 'c', extensionDependencies: ['a'] })
    const cycled = activator.detectCycle([a, b, c])
    expect(cycled).not.toBeNull()
    expect(cycled).toContain('a')
    expect(cycled).toContain('b')
    expect(cycled).toContain('c')
  })

  // ── TC-DEP-11: 空列表返回 null ──────────────────────────────────
  it('TC-DEP-11: empty list returns null', () => {
    const activator = new PluginActivator()
    expect(activator.detectCycle([])).toBeNull()
  })

  // ── TC-DEP-12: 无依赖但有子集循环 ──────────────────────────────
  it('TC-DEP-12: partial cycle — some plugins have dependencies, some cycle', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a' })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['c'] })
    const c = makeDescriptor({ pluginId: 'c', extensionDependencies: ['b'] })
    const cycled = activator.detectCycle([a, b, c])
    expect(cycled).not.toBeNull()
    expect(cycled).toContain('b')
    expect(cycled).toContain('c')
    // 'a' 不在循环中
    expect(cycled).not.toContain('a')
  })
})
// ══════════════════════════════════════════════════════════════════
// activateWithDeps
// ══════════════════════════════════════════════════════════════════

describe('PluginActivator.activateWithDeps', () => {
  let activator: PluginActivator
  let host: ActivatorHost

  beforeEach(() => {
    activator = new PluginActivator()
    host = createMockHost(activator, 'activated')
  })

  // ── TC-DEP-13: 无依赖正常激活 ──────────────────────────────────
  it('TC-DEP-13: activates plugins in dependency order', async () => {
    const a = makeDescriptor({ pluginId: 'a' })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['a'] })
    const c = makeDescriptor({ pluginId: 'c', extensionDependencies: ['b'] })

    await activator.activateWithDeps([c, a, b], host)

    expect(activator.getState('a')).toBe('ACTIVE')
    expect(activator.getState('b')).toBe('ACTIVE')
    expect(activator.getState('c')).toBe('ACTIVE')
    expect(activator.getActivePlugins()).toHaveLength(3)
  })

  // ── TC-DEP-14: 缺失依赖抛出错误 ────────────────────────────────
  it('TC-DEP-14: missing dependency throws error', async () => {
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['missing-dep'] })

    await expect(activator.activateWithDeps([a], host))
      .rejects
      .toThrow(/Missing plugin dependencies/)
  })

  // ── TC-DEP-15: 循环依赖抛出错误 ────────────────────────────────
  it('TC-DEP-15: circular dependency throws error', async () => {
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['b'] })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['a'] })

    await expect(activator.activateWithDeps([a, b], host))
      .rejects
      .toThrow(/Circular dependencies/)
  })

  // ── TC-DEP-16: 空列表不激活任何插件 ────────────────────────────
  it('TC-DEP-16: empty descriptors list activates nothing', async () => {
    await activator.activateWithDeps([], host)
    expect(activator.getActivePlugins()).toHaveLength(0)
  })

  // ── TC-DEP-17: 多个缺失依赖 ────────────────────────────────────
  it('TC-DEP-17: multiple missing dependencies reported together', async () => {
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['missing1', 'missing2'] })

    try {
      await activator.activateWithDeps([a], host)
      expect.unreachable('Should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('missing1')
      expect(msg).toContain('missing2')
    }
  })

  // ── TC-DEP-18: 激活顺序遵循拓扑排序 ─────────────────────────────
  it('TC-DEP-18: activation order follows topological sort', async () => {
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['core'] })
    const core = makeDescriptor({ pluginId: 'core' })

    // core 应先于 a 激活
    await activator.activateWithDeps([a, core], host)

    expect(activator.getState('core')).toBe('ACTIVE')
    expect(activator.getState('a')).toBe('ACTIVE')
  })
})
});

// ======================================================================
// ← test/plugin-uninstall-shutdown.test.ts
// ======================================================================

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}


function makeDescriptor_m2_m2_z2(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'uninstall-plugin',
    version: '1.0.0',
    displayName: 'Uninstall Plugin',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'sandbox',
    status: 'ACTIVE',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/plugins/uninstall-plugin/index.js',
    source: 'external',
    extensionDependencies: [],
    ...overrides,
  }
}


/** PluginService 测试视图：私有协作者注入缝（与 plugin-tool-execution.test.ts 的 internals 同模式） */
interface ServiceInternals {  // oe-exempt:20261027:test:
  activator: PluginActivator
  host: PluginHost
  sessionDataStore: SessionDataStore
  storage: PluginStorage
  initialized: boolean
}


function internals(service: PluginService): ServiceInternals {
  return service as unknown as ServiceInternals
}


/** 全方法 IPluginInstaller mock（U4 两段式接口；本文件卸载语境只消费 uninstall）。 */
function makeInstaller(overrides: Partial<IPluginInstaller> = {}): IPluginInstaller {
  return {
    prepareInstall: vi.fn(),
    commitInstall: vi.fn(),
    rollbackInstall: vi.fn(),
    discardReplaced: vi.fn(),
    sweepStaging: vi.fn(),
    uninstall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}


function createService(opts: {
  descriptor?: PluginDescriptor
  installer?: IPluginInstaller
  configDir?: string
} = {}) {
  const broker = createMockBroker()
  const registryMock = {
    getDescriptor: vi.fn(() => opts.descriptor ?? undefined),
    getAllDescriptors: vi.fn(() => (opts.descriptor ? [opts.descriptor] : [])),
    removeDescriptor: vi.fn(() => true),
  }
  const service = new PluginService(registryMock as unknown as PluginRegistry, broker, {
    pluginInstaller: opts.installer,
    ...(opts.configDir ? { configDir: opts.configDir } : {}),
  })
  return { service, reg: internals(service), registryMock }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-uninstall-shutdown', () => {
describe('uninstallPlugin 四缺处置（F2）', () => {
  it('F2-①: uninstall 停止该插件的 fs.watch 热重载监听', async () => {
    const installer: IPluginInstaller = makeInstaller()
    const { service, reg } = createService({ descriptor: makeDescriptor_m2_m2_z2(), installer })
    const stopWatching = vi.spyOn(reg.activator, 'stopWatching')

    await service.uninstallPlugin('uninstall-plugin')

    expect(stopWatching).toHaveBeenCalledWith('uninstall-plugin')
  })

  it('F2-②: external 插件 uninstall 调 installer.uninstall(pluginId, pluginDir) 删除磁盘插件目录', async () => {
    const installer: IPluginInstaller = makeInstaller()
    const descriptor = makeDescriptor_m2_m2_z2({ source: 'external', pluginPath: '/tmp/plugins/uninstall-plugin/index.js' })
    const { service } = createService({ descriptor, installer })

    await service.uninstallPlugin('uninstall-plugin')

    expect(installer.uninstall).toHaveBeenCalledTimes(1)
    // 删除靶 = 插件目录（pluginDirOf 按 main 后缀截取；按入口文件删会留目录残壳复活）
    expect(installer.uninstall).toHaveBeenCalledWith('uninstall-plugin', '/tmp/plugins/uninstall-plugin')
  })

  it('F2-②检查: builtin 插件（source=built-in）不删磁盘（防破坏随应用分发的资源）', async () => {
    const installer: IPluginInstaller = makeInstaller()
    const descriptor = makeDescriptor_m2_m2_z2({ source: 'built-in' })
    const { service, registryMock } = createService({ descriptor, installer })

    await service.uninstallPlugin('uninstall-plugin')

    expect(installer.uninstall).not.toHaveBeenCalled()
    // 内存清理仍完成（builtin 的卸载语义是移除注册）
    expect(registryMock.removeDescriptor).toHaveBeenCalledWith('uninstall-plugin')
  })

  it('F2-②容错: installer.uninstall 抛错不中断内存清理（registry/activator 拆除仍完成），收尾抛错（RT-6#6）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const installer: IPluginInstaller = makeInstaller({
      uninstall: vi.fn().mockRejectedValue(new Error('rm -rf failed: EPERM')),
    })
    const descriptor = makeDescriptor_m2_m2_z2({ source: 'external' })
    const { service, registryMock, reg } = createService({ descriptor, installer })
    const removeDescriptor = vi.spyOn(reg.activator, 'removeDescriptor')

    // RT-6#6：磁盘删除失败不再「只 log 仍回成功形状」——内存清理照旧完成后抛带 code 的
    // 领域错误（否则残留目录重启后被 scan 扫回 = 卸载静默复活，用户零反馈）。
    await expect(service.uninstallPlugin('uninstall-plugin')).rejects.toThrow(
      /on-disk files could not be deleted.*rm -rf failed: EPERM/,
    )
    await service.uninstallPlugin('uninstall-plugin').catch((e: unknown) => {
      expect((e as { code?: string }).code).toBe('PLUGIN_UNINSTALL_PARTIAL')
    })

    // 磁盘删除失败仅记日志（toErrorMessage 已把 Error 归一为 message 字符串）
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('on-disk removal'),
      'rm -rf failed: EPERM',
    )
    // 内存清理不被阻断
    expect(registryMock.removeDescriptor).toHaveBeenCalledWith('uninstall-plugin')
    expect(removeDescriptor).toHaveBeenCalledWith('uninstall-plugin')
    consoleError.mockRestore()
  })

  it('F2-③: sandbox 插件 uninstall 时 terminate 其独占子进程（SIGTERM→SIGKILL 升级链入口）', async () => {
    const installer: IPluginInstaller = makeInstaller()
    const { service, reg } = createService({ descriptor: makeDescriptor_m2_m2_z2(), installer })
    const terminateWorker = vi.fn().mockResolvedValue(undefined)
    // sandbox 句柄：workerId sandbox- 前缀（PluginHost.getWorkerHandle 从子进程宿主转调所得）
    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'sandbox-uninstall-plugin',
      postMessage: vi.fn(),
    })
    reg.host.terminateWorker = terminateWorker

    await service.uninstallPlugin('uninstall-plugin')

    expect(terminateWorker).toHaveBeenCalledTimes(1)
    expect(terminateWorker).toHaveBeenCalledWith('sandbox-uninstall-plugin')
  })

  it('F2-③检查: trusted 共享 Worker 不 terminate（防误杀同线程其他插件）；无句柄时 no-op', async () => {
    const installer: IPluginInstaller = makeInstaller()

    // trusted 场景
    const trusted = createService({ descriptor: makeDescriptor_m2_m2_z2({ trustLevel: 'trusted' }), installer })
    const trustedTerminate = vi.fn().mockResolvedValue(undefined)
    trusted.reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'trusted-1',
      postMessage: vi.fn(),
    })
    trusted.reg.host.terminateWorker = trustedTerminate
    await trusted.service.uninstallPlugin('uninstall-plugin')
    expect(trustedTerminate).not.toHaveBeenCalled()

    // 未激活/无进程场景（getWorkerHandle undefined）：不抛
    const idle = createService({ descriptor: makeDescriptor_m2_m2_z2(), installer })
    idle.reg.host.getWorkerHandle = vi.fn().mockReturnValue(undefined)
    await expect(idle.service.uninstallPlugin('uninstall-plugin')).resolves.toBeDefined()
  })

  it('F2-④: uninstall 后 activator 侧描述符/状态清空（防幽灵重激活）', async () => {
    const installer: IPluginInstaller = makeInstaller()
    const descriptor = makeDescriptor_m2_m2_z2({ activationEvents: ['onStartupFinished'] })
    const { service, reg } = createService({ descriptor, installer })

    // 注册描述符（模拟 initialize 装配），卸载后状态与 eventMap 索引应一并清理
    reg.activator.registerDescriptors([descriptor])
    expect(reg.activator.getState('uninstall-plugin')).toBe('ACTIVE')

    await service.uninstallPlugin('uninstall-plugin')

    expect(reg.activator.getState('uninstall-plugin')).toBeUndefined()
    // eventMap 幽灵索引清理：onStartupFinished 触发时不再命中已卸载插件
    const activateSpy = vi.spyOn(reg.activator, 'activatePlugin')
    await reg.activator.handleEvent({ type: 'onStartupFinished' }, reg.host)
    expect(activateSpy).not.toHaveBeenCalled()
  })
})
describe('PluginService.shutdown flush 时序（F5）', () => {
  let tmpConfigDir: string

  beforeEach(async () => {
    tmpConfigDir = await mkdtemp(join(tmpdir(), 'plugin-shutdown-flush-'))
  })

  afterEach(async () => {
    await rm(tmpConfigDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('F5-①: flushAll 在 dispose 之前完成（清 debounce 定时器前冲刷 dirty 数据）', async () => {
    const { service, reg } = createService({ configDir: tmpConfigDir })
    reg.initialized = true

    const order: string[] = []
    reg.sessionDataStore.flushAll = vi.fn(() => { order.push('sessionData.flushAll') })
    reg.sessionDataStore.dispose = vi.fn(() => { order.push('sessionData.dispose') })
    // storage 未 init（cache null 会 NPE），stub 掉——F5 断言对象是 sessionDataStore
    reg.storage.flushAll = vi.fn(() => { order.push('storage.flushAll') })

    await service.shutdown()

    expect(order).toEqual([
      'sessionData.flushAll',
      'sessionData.dispose',
      'storage.flushAll',
    ])
  })

  it('F5-②: shutdown 前 500ms debounce 窗口内的 sessionData 落盘（用户可见：文件存在且内容正确）', async () => {
    const { service, reg } = createService({ configDir: tmpConfigDir })
    reg.initialized = true
    reg.storage.flushAll = vi.fn(() => {})

    // 写入后立即 shutdown——不 flush 的话 per-write 500ms debounce 内的写入会丢
    reg.sessionDataStore.set('session-1', 'lastKey', 'lastValue')

    await service.shutdown()

    // [session-store-layout-inversion 域 4] 插件 KV 落点 = 存储树 `<root>/<sid>/plugin-data.json`
    //（生产同源 getSessionPluginDataPath；原旧布局 `<configDir>/session-data/<sid>.json` 已退役）
    const flushed = JSON.parse(
      await readFile(getSessionPluginDataPath('session-1', tmpConfigDir), 'utf-8'),
    ) as Record<string, unknown>
    expect(flushed['lastKey']).toBe('lastValue')
  })
})
});

// ======================================================================
// ← test/plugin-storage.test.ts
// ======================================================================

let tmpDir_m2_m2_m2_m2_m2_z3: string

let storage: PluginStorage

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-storage', () => {
beforeAll(async () => {
  tmpDir_m2_m2_m2_m2_m2_z3 = await mkdtemp(join(tmpdir(), 'plugin-storage-test-'))
  storage = new PluginStorage()
  storage.init(tmpDir_m2_m2_m2_m2_m2_z3, '/test/project')
})
afterAll(async () => {
  storage.flushAll()
  storage.dispose()
  await rm(tmpDir_m2_m2_m2_m2_m2_z3, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('PluginStorage', () => {
  // ── TC-5-01: get/set basic KV operations ──────────────────────
  it('TC-5-01: get/set basic KV operations', () => {
    const pluginId = 'test-getset'

    // get 对不存在的 key 返回 undefined
    const missing = storage.get(pluginId, 'nonexistent')
    expect(missing).toBe(undefined)

    // set → get
    storage.set(pluginId, 'name', 'hello')
    const val = storage.get(pluginId, 'name')
    expect(val).toBe('hello')

    // 覆盖写入
    storage.set(pluginId, 'name', 'world')
    const updated = storage.get(pluginId, 'name')
    expect(updated).toBe('world')
  })

  // ── TC-5-02: delete key ───────────────────────────────────────
  it('TC-5-02: delete key', () => {
    const pluginId = 'test-delete'

    storage.set(pluginId, 'toDelete', 42)
    const before = storage.get(pluginId, 'toDelete')
    expect(before).toBe(42)

    storage.delete(pluginId, 'toDelete')
    const after = storage.get(pluginId, 'toDelete')
    expect(after).toBe(undefined)
  })

  // ── TC-5-03: keys() returns all keys ──────────────────────────
  it('TC-5-03: keys() returns all keys', () => {
    const pluginId = 'test-keys'

    storage.set(pluginId, 'a', 1)
    storage.set(pluginId, 'b', 2)
    storage.set(pluginId, 'c', 3)

    const allKeys = storage.keys(pluginId)
    allKeys.sort()
    expect(allKeys).toEqual(['a', 'b', 'c'])
  })

  // ── TC-5-04: flush persists to disk, readable after restart ───
  it('TC-5-04: flush persists to disk, readable after restart', async () => {
    const pluginId = 'test-persist'

    storage.set(pluginId, 'persistent', 'value-123')
    storage.flush(pluginId)

    // 验证文件已写入
    const filePath = join(tmpDir_m2_m2_m2_m2_m2_z3, 'plugins', pluginId, 'globalState.json')
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, string>
    expect(parsed.persistent).toBe('value-123')

    // 新实例读取应能恢复数据
    const storage2 = new PluginStorage()
    storage2.init(tmpDir_m2_m2_m2_m2_m2_z3, '/test/project')
    const restored = storage2.get(pluginId, 'persistent')
    expect(restored).toBe('value-123')
  })

  // ── TC-5-05: rejects writes exceeding limit ───────────────────
  it('TC-5-05: rejects writes exceeding value size limit (1MB)', () => {
    const pluginId = 'test-limit'
    // JSON.stringify 会给字符串加引号，所以实际 > 1MB
    const bigValue = 'x'.repeat(1024 * 1024 + 2)

    try {
      storage.set(pluginId, 'big', bigValue)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as unknown as { code: number }).code).toBe(-32021)
    }
  })

  // ── D1c 对齐（P2#4）：损坏文件加载 → quarantine 隔离（非静默空 Map 覆写） ──
  it('corrupt JSON on load → quarantined to .corrupt-<ts> copy, then set/flush rebuilds clean file', async () => {
    const pluginId = 'test-corrupt-quarantine'
    const filePath = join(tmpDir_m2_m2_m2_m2_m2_z3, 'plugins', pluginId, 'globalState.json')
    await mkdir(join(tmpDir_m2_m2_m2_m2_m2_z3, 'plugins', pluginId), { recursive: true })
    const corruptContent = '{"broken": tru' // 半截 JSON（模拟崩溃窗口）
    await (await import('node:fs/promises')).writeFile(filePath, corruptContent, 'utf-8')

    const storageQ = new PluginStorage()
    storageQ.init(tmpDir_m2_m2_m2_m2_m2_z3, '/test/project')
    try {
      // 触发 lazy loadPartition：损坏 → quarantine rename + 空 Map 降级（get 返回 undefined）
      expect(storageQ.get(pluginId, 'anyKey')).toBe(undefined)

      // 原路径文件已被隔离移走；.corrupt-<ts> 副本保留损坏内容供人工恢复
      const dirEntries = await (await import('node:fs/promises')).readdir(join(tmpDir_m2_m2_m2_m2_m2_z3, 'plugins', pluginId))
      expect(dirEntries).not.toContain('globalState.json')
      const quarantineCopy = dirEntries.find((n) => /^globalState\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{9}Z$/.test(n))
      expect(quarantineCopy).toBeDefined()
      const quarantined = await readFile(join(tmpDir_m2_m2_m2_m2_m2_z3, 'plugins', pluginId, quarantineCopy!), 'utf-8')
      expect(quarantined).toBe(corruptContent)

      // set + flush：原路径重建干净文件（无冲突备份噪音——quarantine 后 stat ENOENT 放行重建）
      storageQ.set(pluginId, 'fresh', 'value')
      storageQ.flush(pluginId)
      const rebuilt = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, string>
      expect(rebuilt.fresh).toBe('value')
    } finally {
      storageQ.dispose()
    }
  })
})
});

// ======================================================================
// ← test/plugin-sdk-freeze.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-sdk-freeze', () => {
describe('plugin-sdk freeze 分层（AC12 前半：const 冻结）', () => {
  it('PermissionConstants 已冻结（Object.isFrozen === true）', () => {
    expect(Object.isFrozen(PermissionConstants)).toBe(true)
  })

  it('PluginRpcErrorCodes 已冻结（Object.isFrozen === true）', () => {
    expect(Object.isFrozen(PluginRpcErrorCodes)).toBe(true)
  })

  it('PermissionConstants 字面量值完整（冻结不丢字段）', () => {
    expect(PermissionConstants).toEqual({
      TOOLS_REGISTER: 'tools.register',
      HOOKS_REGISTER: 'hooks.register',
      SESSIONS_SEND_MESSAGE: 'sessions.sendMessage',
      SESSIONS_READ_STATE: 'sessions.readState',
      STORAGE_ACCESS: 'storage.access',
      NOTIFY: 'notify',
    })
  })

  it('PluginRpcErrorCodes 错误码值完整（冻结不丢字段）', () => {
    expect(PluginRpcErrorCodes).toEqual({
      RPC_TIMEOUT: -32000,
      PERMISSION_DENIED: -32001,
      PLUGIN_NOT_FOUND: -32010,
      PLUGIN_NOT_ACTIVE: -32011,
      STORAGE_FULL: -32040,
      PAYLOAD_TOO_LARGE: -32021,
      METHOD_NOT_FOUND: -32601,
      INTERNAL_ERROR: -32603,
    })
  })

  it('strict 模式修改 PermissionConstants 抛 TypeError', () => {
    // Object.freeze 对象在 strict 模式下赋值/defineProperty 均抛 TypeError
    expect(() => {
      Object.defineProperty(PermissionConstants, 'EXTRA_PERMISSION', { value: 'x.y', enumerable: true })
    }).toThrow(TypeError)
  })

  it('strict 模式修改 PluginRpcErrorCodes 抛 TypeError', () => {
    expect(() => {
      Object.defineProperty(PluginRpcErrorCodes, 'NEW_ERROR_CODE', { value: -99999, enumerable: true })
    }).toThrow(TypeError)
  })

  it('SDK 侧冻结与 runtime 源一致（sync 传播验证）', () => {
    // runtime 源经 sync-types.sh 传播：SDK 的 const 就是 runtime 的 const（同一字面量）
    expect(PermissionConstants.TOOLS_REGISTER).toBe('tools.register')
    expect(PluginRpcErrorCodes.INTERNAL_ERROR).toBe(-32603)
  })
})
describe('plugin-sdk freeze 运行时侧（AC12 后半：runtime api 对象冻结）', () => {
  function buildTestApi(): Phase2AgentAPI {
    // 构造与 createAgentAPI 返回同构的 Phase2AgentAPI 形状对象（freeze 前置形状）
    return {
      storage: {
        global: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
        workspace: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
      },
      notify: { info: async () => undefined, warning: async () => undefined, error: async () => undefined },
      sessions: {
        list: async () => [],
        get: async () => undefined,
        getActive: async () => undefined,
        sendMessage: async () => ({ accepted: true }),
        readEntries: async () => ({ entries: [] }),
        getCommands: async () => [],
        onDidCreateSession: () => ({ dispose: () => undefined }),
        onDidDestroySession: () => ({ dispose: () => undefined }),
        onDidActivateSession: () => ({ dispose: () => undefined }),
        onEntriesInvalidated: () => ({ dispose: () => undefined }),
      },
      events: { on: () => ({ dispose: () => undefined }), emit: async () => undefined, report: async () => ({ forwarded: true }) },
      tools: { register: async () => '', unregister: async () => undefined },
      hooks: {
        onBeforeSendMessage: async () => ({ dispose: () => undefined }),
        onBeforeToolCall: async () => ({ dispose: () => undefined }),
        onAfterToolResult: async () => ({ dispose: () => undefined }),
        onPiEvent: async () => ({ dispose: () => undefined }),
      },
      config: { get: async () => undefined, getAll: async () => ({}), set: async () => undefined },
      sessionData: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
      ui: {
        showSelect: async () => undefined,
        showConfirm: async () => false,
        showInput: async () => undefined,
        notify: async () => undefined,
        updateHeaderAction: async () => ({ updated: true }),
        openUrl: async () => ({ opened: true }),
      },
      agent: {
        setModel: async () => '',
        getModel: async () => '',
        getThinkingLevel: async () => '',
        setThinkingLevel: async () => '',
        getActiveTools: async () => [],
      },
      workspace: { rootPath: '', name: '', findFiles: async () => [] },
      commands: { register: async () => ({ dispose: () => undefined }), unregister: async () => undefined },
      views: { update: async () => undefined, listMountPoints: async () => [], onUiEvent: () => ({ dispose: () => undefined }) },
      providers: {
        write: async () => ({ written: true as const, providerId: 'p' }),
        delete: async () => ({ deleted: false, providerId: 'p' }),
        credential: async () => ({ providerId: 'p', unsupported: 'command' } as const),
      },
    }
  }

  it('freezeApiSurface 后顶层已冻结', () => {
    const api = freezeApiSurface(buildTestApi())
    expect(Object.isFrozen(api)).toBe(true)
  })

  it('全部一级子对象已冻结（storage/notify/sessions/events/tools/hooks/config/sessionData/ui/agent/workspace/providers）', () => {
    const api = freezeApiSurface(buildTestApi())
    const subObjects = [
      api.storage,
      api.notify,
      api.sessions,
      api.events,
      api.tools,
      api.hooks,
      api.config,
      api.sessionData,
      api.ui,
      api.agent,
      api.workspace,
      // provider-plugin-access D4 凭据安全面：providers 域方法引用不可被插件替换，
      // 冻结与冻结断言同口径登记（plugin-api-freeze.ts freeze 清单同步面）
      api.providers,
    ]
    for (const sub of subObjects) {
      expect(Object.isFrozen(sub)).toBe(true)
    }
  })

  it('storage 二级子对象已冻结（global/workspace）', () => {
    const api = freezeApiSurface(buildTestApi())
    expect(Object.isFrozen(api.storage.global)).toBe(true)
    expect(Object.isFrozen(api.storage.workspace)).toBe(true)
  })

  it('freeze 后顶层写入被拒（strict 抛 TypeError，结构不变）', () => {
    const api = freezeApiSurface(buildTestApi())
    expect(() => {
      Object.defineProperty(api, 'newField', { value: 1, enumerable: true })
    }).toThrow(TypeError)
    // 结构不变：newField 未写入
    expect('newField' in api).toBe(false)
  })

  it('freeze 后子对象写入被拒（strict 抛 TypeError，结构不变）', () => {
    const api = freezeApiSurface(buildTestApi())
    expect(() => {
      Object.defineProperty(api.storage, 'newField', { value: 1, enumerable: true })
    }).toThrow(TypeError)
    expect('newField' in api.storage).toBe(false)
  })

  it('freeze 不破坏方法调用语义（函数引用可用）', () => {
    const api = freezeApiSurface(buildTestApi())
    expect(typeof api.notify.info).toBe('function')
    expect(typeof api.tools.register).toBe('function')
    expect(typeof api.events.on).toBe('function')
  })
})
});

// ======================================================================
// ← test/plugin-security.test.ts
// ======================================================================

function createMockBroker_m2(): IMessageBroker {
  return {
    broadcast: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  } as unknown as IMessageBroker
}


function createService_m2(installer: IPluginInstaller): PluginService {
  const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
  return new PluginService(registry, createMockBroker_m2(), { pluginInstaller: installer })
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-security', () => {
describe('external plugin install hard lock（§6.6 排期硬锁）', () => {
  it('TC-1: EXTERNAL_PLUGIN_ENABLED=true（sandbox 闭环已落地）时 installPlugin 放行到 installer', async () => {
    // U4 两段式：直通 installPlugin = prepareInstall → commitInstall（+ 激活终态判定）
    const installer: IPluginInstaller = {
      prepareInstall: vi.fn().mockResolvedValue({
        success: true,
        prepared: {
          dirName: 'scope__pkg',
          packageName: '@scope/pkg',
          version: '1.0.0',
          stagingPath: '/tmp/.staging/scope__pkg',
          capabilities: [],
          readPaths: [],
          permissions: [],
        },
      }),
      commitInstall: vi.fn().mockResolvedValue({ success: true, pluginId: 'scope__pkg', path: '/tmp' }),
      rollbackInstall: vi.fn().mockResolvedValue(undefined),
      discardReplaced: vi.fn().mockResolvedValue(undefined),
      sweepStaging: vi.fn().mockResolvedValue(undefined),
      uninstall: vi.fn().mockResolvedValue(undefined),
    }
    const service = createService_m2(installer)
    // 激活链 mock：activatePlugin 对无 descriptor 插件 no-op resolve；getState 恒 ACTIVE；
    // registry 空（/tmp/fake-project 不存在）→ descriptor mock 供提交段存在性检查
    vi.spyOn(service.activator, 'activatePlugin').mockResolvedValue(undefined)
    vi.spyOn(service.activator, 'getState').mockReturnValue('ACTIVE')
    vi.spyOn(service.registry, 'getDescriptor').mockReturnValue({
      pluginId: 'scope__pkg',
      version: '1.0.0',
      displayName: 'scope__pkg',
      description: '',
      main: 'index.js',
      activationEvents: [],
      trustLevel: 'sandbox',
      status: 'ACTIVE',
      contributes: {},
      permissions: [],
      engines: { taiji: '*' },
      pluginPath: '/tmp/scope__pkg/index.js',
      source: 'external',
      extensionDependencies: [],
    })

    const result: InstallResult = await service.installPlugin('any-npm-pkg')

    // 翻转后契约：安装放行到 installer port（sandbox 子进程 + ESM loader 兜底隔离）
    expect(result.success).toBe(true)
    expect(installer.prepareInstall).toHaveBeenCalledTimes(1)
    expect(installer.commitInstall).toHaveBeenCalledTimes(1)
    // 硬锁文案常量仍导出（开关回退 false 时复用）
    expect(EXTERNAL_PLUGIN_DISABLED).toBe('EXTERNAL_PLUGIN_DISABLED')
    expect(EXTERNAL_PLUGIN_DISABLED_MESSAGE).toContain(EXTERNAL_PLUGIN_DISABLED)
  })

  it('TC-2: 常量契约 —— EXTERNAL_PLUGIN_ENABLED 已翻转 true（sandbox 真隔离闭环）、错误码与文案常量导出', () => {
    // 翻转记录见 plugin-security.ts [翻转记录]：fork 子进程 + ESM loader 注入 + env 边界判定
    // + postbuild 产物校验四环齐备，external 安装放行。任一环节回退须同步翻回 false。
    expect(EXTERNAL_PLUGIN_ENABLED).toBe(true)
    expect(EXTERNAL_PLUGIN_DISABLED).toBe('EXTERNAL_PLUGIN_DISABLED')
    expect(EXTERNAL_PLUGIN_DISABLED_MESSAGE).toContain(EXTERNAL_PLUGIN_DISABLED)
    expect(EXTERNAL_PLUGIN_DISABLED_MESSAGE).toContain('sandbox isolation')
  })
})
});

// ======================================================================
// ← test/plugin-permission.test.ts
// ======================================================================

let tmpDir_m2: string


/** trusted 通道身份（Worker 级，多插件共享，无唯一归属） */
const TRUSTED: RpcIdentity = { trustLevel: 'trusted' }

/** sandbox 通道身份（processId = sandbox-<pluginId> 一对一） */
function sandbox(pluginId: string): RpcIdentity {
  return { trustLevel: 'sandbox', pluginId }
}


function makeDescriptor_m2_m2_z3(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'test-plugin',
    version: '1.0.0',
    displayName: 'Test',
    description: '',
    main: 'index.js',
    activationEvents: [],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/test',
    source: 'external',
    extensionDependencies: [],
    ...overrides,
  }
}


function createMockRegistry(descriptors: PluginDescriptor[]): PluginRegistry {
  const map = new Map(descriptors.map(d => [d.pluginId, d]))
  return {
    getDescriptor: (id: string) => map.get(id),
  } as unknown as PluginRegistry
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-permission', () => {
beforeAll(async () => {
  tmpDir_m2 = await mkdtemp(join(tmpdir(), 'plugin-permission-test-'))
})
afterAll(async () => {
  await rm(tmpDir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('PermissionChecker（通道身份鉴权）', () => {
  describe('trusted 通道', () => {
    it('trusted 身份 check() 全放行（worker 级语义，消息体自报 id 不参与）', () => {
      const registry = createMockRegistry([
        makeDescriptor_m2_m2_z3({ pluginId: 'scheduler-manager', trustLevel: 'trusted', source: 'built-in' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))

      // 未 grant 任何权限，trusted 通道身份仍全放行
      expect(checker.check(TRUSTED, 'plugin.tools.register')).toBe(true)
      expect(checker.check(TRUSTED, 'plugin.hooks.register')).toBe(true)
      expect(checker.check(TRUSTED, 'any.method')).toBe(true)
    })
  })

  describe('sandbox 通道', () => {
    it('未授权方法 check() 拒绝', () => {
      const registry = createMockRegistry([
        makeDescriptor_m2_m2_z3({ pluginId: 'sandbox-1', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))

      expect(checker.check(sandbox('sandbox-1'), 'plugin.tools.register')).toBe(false)
    })

    it('sandbox 身份缺 pluginId → fail-closed 拒绝（通道注册异常）', () => {
      const registry = createMockRegistry([])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))

      expect(checker.check({ trustLevel: 'sandbox' }, 'plugin.notify')).toBe(false)
    })

    it('grant() 完整方法名后 check() 命中（granted 集与 check 同口径）', () => {
      const registry = createMockRegistry([
        makeDescriptor_m2_m2_z3({ pluginId: 'sandbox-2', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))

      checker.grant('sandbox-2', ['plugin.tools.register', 'plugin.hooks.register'])
      expect(checker.check(sandbox('sandbox-2'), 'plugin.tools.register')).toBe(true)
      expect(checker.check(sandbox('sandbox-2'), 'plugin.hooks.register')).toBe(true)
    })

    it('grant() 任意口径归一化：SDK 常量 / 短形 / legacy / 完整名同集生效', () => {
      const registry = createMockRegistry([
        makeDescriptor_m2_m2_z3({ pluginId: 'norm', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))

      checker.grant('norm', [
        'storage.access',          // SDK 常量（8 个 storage 方法全集）
        'hooks.register',          // manifest 短形（连带 unregister）
        'workspace:file:search',   // demo legacy 形
        'plugin.sessions.sendMessage', // 已是完整方法名（幂等透传）
      ])

      // storage.access → 8 个 storage 方法
      for (const m of [
        'plugin.storage.global.get', 'plugin.storage.global.set',
        'plugin.storage.global.delete', 'plugin.storage.global.keys',
        'plugin.storage.workspace.get', 'plugin.storage.workspace.set',
        'plugin.storage.workspace.delete', 'plugin.storage.workspace.keys',
      ]) {
        expect(checker.check(sandbox('norm'), m)).toBe(true)
      }
      // hooks.register → register + unregister 成对授予
      expect(checker.check(sandbox('norm'), 'plugin.hooks.register')).toBe(true)
      expect(checker.check(sandbox('norm'), 'plugin.hooks.unregister')).toBe(true)
      // legacy 形 → workspace.findFiles
      expect(checker.check(sandbox('norm'), 'plugin.workspace.findFiles')).toBe(true)
      // 完整方法名透传
      expect(checker.check(sandbox('norm'), 'plugin.sessions.sendMessage')).toBe(true)
      // 未授权方法仍拒
      expect(checker.check(sandbox('norm'), 'plugin.agent.setModel')).toBe(false)
    })

    it('check() 语义按 identity.pluginId 分区：他人授权不串门', () => {
      const registry = createMockRegistry([
        makeDescriptor_m2_m2_z3({ pluginId: 'a', trustLevel: 'sandbox' }),
        makeDescriptor_m2_m2_z3({ pluginId: 'b', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))

      checker.grant('a', ['plugin.notify'])
      // a 的通道身份可调；b 的通道身份不可调（即使 b 伪冒 params.pluginId='a'，
      // 鉴权也不看消息体——check 只收通道身份）
      expect(checker.check(sandbox('a'), 'plugin.notify')).toBe(true)
      expect(checker.check(sandbox('b'), 'plugin.notify')).toBe(false)
    })

    it('未授权插件（granted 无条目）check() 拒绝', () => {
      const registry = createMockRegistry([])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))

      expect(checker.check(sandbox('nonexistent'), 'plugin.tools.register')).toBe(false)
    })

    it('grant() 追加不覆盖已有权限', () => {
      const registry = createMockRegistry([
        makeDescriptor_m2_m2_z3({ pluginId: 'sandbox-5', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))

      checker.grant('sandbox-5', ['plugin.tools.register'])
      checker.grant('sandbox-5', ['plugin.hooks.register'])

      expect(checker.check(sandbox('sandbox-5'), 'plugin.tools.register')).toBe(true)
      expect(checker.check(sandbox('sandbox-5'), 'plugin.hooks.register')).toBe(true)
    })

    it('revoke() 后 check() 拒绝；未知 pluginId revoke() no-op', () => {
      const registry = createMockRegistry([
        makeDescriptor_m2_m2_z3({ pluginId: 'sandbox-4', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))

      checker.grant('sandbox-4', ['plugin.tools.register'])
      expect(checker.check(sandbox('sandbox-4'), 'plugin.tools.register')).toBe(true)

      checker.revoke('sandbox-4')
      expect(checker.check(sandbox('sandbox-4'), 'plugin.tools.register')).toBe(false)
      expect(() => checker.revoke('nonexistent')).not.toThrow()
    })
  })

  describe('getUnapproved（声明侧归一化对齐）', () => {
    it('trusted / built-in 插件不需审批', () => {
      const registry = createMockRegistry([
        makeDescriptor_m2_m2_z3({ pluginId: 'builtin-x', trustLevel: 'trusted', source: 'built-in' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))
      expect(checker.getUnapproved('builtin-x', ['plugin.notify'])).toEqual([])
    })

    it('声明的权限词映射方法全部已 grant → 空列表；部分未 grant → 原词返回', () => {
      const registry = createMockRegistry([
        makeDescriptor_m2_m2_z3({ pluginId: 'g', trustLevel: 'sandbox', source: 'external' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))

      checker.grant('g', ['plugin.notify'])
      // notify 常量映射 [plugin.notify, plugin.ui.notify]，只 grant 了 plugin.notify
      // → 未全部覆盖，仍视为未批准
      expect(checker.getUnapproved('g', ['notify'])).toEqual(['notify'])
      checker.grant('g', ['plugin.ui.notify'])
      expect(checker.getUnapproved('g', ['notify'])).toEqual([])
    })

    it('未知权限词（归一化为空）不进入未批准列表——无从审批，执法点在 RPC 层', () => {
      const registry = createMockRegistry([
        makeDescriptor_m2_m2_z3({ pluginId: 'u', trustLevel: 'sandbox', source: 'external' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir_m2))
      expect(checker.getUnapproved('u', ['totally.unknown.permission'])).toEqual([])
    })
  })
})
describe('PermissionStorage', () => {
  it('load() initializes empty map when file does not exist', async () => {
    const storage = new PermissionStorage(join(tmpDir_m2, 'nonexistent-dir'))
    const map = await storage.load()

    expect(map instanceof Map).toBeTruthy()
    expect(map.size).toBe(0)
  })

  it('save() + load() round-trip: 完整方法名幂等透传', async () => {
    const dir = join(tmpDir_m2, 'perm-storage')
    await mkdir(dir, { recursive: true })
    const storage = new PermissionStorage(dir)

    const data = new Map<string, string[]>()
    data.set('plugin-a', ['plugin.tools.register', 'plugin.hooks.register'])
    data.set('plugin-b', ['plugin.sessions.sendMessage'])

    await storage.save(data)

    const loaded = await storage.load()
    expect(loaded.size).toBe(2)
    expect(loaded.get('plugin-a')).toEqual(['plugin.tools.register', 'plugin.hooks.register'])
    expect(loaded.get('plugin-b')).toEqual(['plugin.sessions.sendMessage'])
  })

  it('save() overwrites previous data', async () => {
    const dir = join(tmpDir_m2, 'perm-storage-2')
    await mkdir(dir, { recursive: true })
    const storage = new PermissionStorage(dir)

    const data1 = new Map<string, string[]>()
    data1.set('plugin-a', ['plugin.tools.register'])
    await storage.save(data1)

    const data2 = new Map<string, string[]>()
    data2.set('plugin-b', ['plugin.hooks.register'])
    await storage.save(data2)

    const loaded = await storage.load()
    expect(loaded.size).toBe(1)
    expect(loaded.get('plugin-b')).toEqual(['plugin.hooks.register'])
    expect(loaded.get('plugin-a')).toBe(undefined)
  })

  it('load() 旧声明形数据归一化迁移（SDK 常量 / 短形 → 完整方法名，去重保序）', async () => {
    const dir = join(tmpDir_m2, 'perm-storage-migrate')
    await mkdir(dir, { recursive: true })
    // 手写历史格式的 permissions.json（声明形口径 + 重复词）
    await writeFile(
      join(dir, 'permissions.json'),
      JSON.stringify({
        legacy: ['storage.access', 'storage.set', 'storage.access', 'hooks.register'],
        modern: ['plugin.notify'],
      }),
      'utf-8',
    )

    const storage = new PermissionStorage(dir)
    const loaded = await storage.load()

    // storage.access 全集 ∪ storage.set 短形（global+workspace.set）去重合并
    expect(new Set(loaded.get('legacy'))).toEqual(new Set([
      'plugin.storage.global.get', 'plugin.storage.global.set',
      'plugin.storage.global.delete', 'plugin.storage.global.keys',
      'plugin.storage.workspace.get', 'plugin.storage.workspace.set',
      'plugin.storage.workspace.delete', 'plugin.storage.workspace.keys',
      'plugin.hooks.register', 'plugin.hooks.unregister',
    ]))
    // 已是完整方法名的数据不变形
    expect(loaded.get('modern')).toEqual(['plugin.notify'])
  })

  it('load() handles corrupted JSON gracefully', async () => {
    const dir = join(tmpDir_m2, 'perm-storage-3')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'permissions.json'), 'not valid json{{{', 'utf-8')

    const storage = new PermissionStorage(dir)
    const map = await storage.load()
    expect(map instanceof Map).toBeTruthy()
    expect(map.size).toBe(0)
  })
})
});

// ======================================================================
// ← test/plugin-permission-map.test.ts
// ======================================================================

/** PluginService 测试视图：私有协作者注入缝（approval-wake / uninstall-shutdown 同模式） */
interface ServiceInternals_m2 {  // oe-exempt:20261027:test:
  rpcServer: PluginRpcServer
  registerRpcMethods: () => void
}


/**
 * SSOT 已登记、RPC handler 尚未实装的方法豁免表（u2d 批次建立）。[u5b 已清空]：
 * activate 订阅族（session-api 六点扩表）与 ui 命令式点位（ui-api updateHeaderAction）
 * handler 均已落地——豁免表保留空集形态供后续批次复用（登记即债务，落地即关闭）。
 */
const PENDING_U5B_METHODS: ReadonlySet<string> = new Set<string>([])

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-permission-map', () => {
describe('plugin-permission-map SSOT（AC-I6）', () => {
  let tmpDir: string
  /** 真实 PluginRpcServer 注册表全量（registerAllRpcMethods 产物） */
  let registeredMethods: Set<string>

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'plugin-perm-map-'))
    const registryMock = {
      getDescriptor: () => undefined,
      getAllDescriptors: () => [],
    }
    const broker: IMessageBroker = { send: () => {}, broadcast: () => {}, sendError: () => {} }
    const service = new PluginService(registryMock as unknown as PluginRegistry, broker, {
      configDir: tmpDir,
    })
    const internals = service as unknown as ServiceInternals_m2
    internals.registerRpcMethods()
    // provider-plugin-access D4：providers.* 三 RPC 注册点在组合根（index.ts →
    // registerProviderWriteProxy），不在 PluginService.registerRpcMethods 内——
    // 按生产注册链路真实装配一次，注册表集合才完整（否则三方法被判「孤儿」）。
    registerProviderWriteProxy(internals.rpcServer, {
      setProvider: async () => ({}),
      deleteProvider: async () => ({ removed: true }),
      resolveProviderCredential: async () => undefined,
      readPluginManifest: () => undefined,
      notifyProvidersMutated: () => {},
    })
    registeredMethods = new Set(internals.rpcServer.listMethods())
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('AC-I6: SDK PermissionConstants 全量常量归一非空（新常量未收录映射表时红）', () => {
    const values = Object.values(PermissionConstants)
    // 前置：常量表非空（防御 SDK 常量表被清空导致用例空转假绿）
    expect(values.length).toBeGreaterThan(0)
    for (const v of values) {
      const methods = normalizePermissionInput(v)
      expect(methods.length, `constant '${v}' must normalize to non-empty method set`).toBeGreaterThan(0)
      for (const m of methods) {
        expect(typeof m).toBe('string')
      }
    }
  })

  it('AC-I6: PLUGIN_RPC_METHODS 与真实 rpcServer 注册表集合相等（双向防漂移）', () => {
    // SSOT 表 ⊆ 真实注册表：表里的方法都真实存在（无幽灵方法）。
    // PENDING_U5B_METHODS 例外反向锁定：登记在案但 handler 随 U5 落地——
    // 若已实装（should be false 变红）说明 U5 已交付，须从豁免表移除并更新 size 锚点。
    for (const m of PLUGIN_RPC_METHODS) {
      if (PENDING_U5B_METHODS.has(m)) {
        expect(registeredMethods.has(m), `pending method '${m}' is now registered on PluginRpcServer — remove it from PENDING_U5B_METHODS and bump the size anchor`).toBe(false)
        continue
      }
      expect(registeredMethods.has(m), `SSOT method '${m}' not registered on real PluginRpcServer`).toBe(true)
    }
    // 真实注册表 ⊆ SSOT 表：新增 RPC 方法未收录进 SSOT 表时红（孤儿方法，
    // 任何权限词汇都映射不到它 → sandbox 插件永远无法获得授权）
    const ssot = new Set<string>(PLUGIN_RPC_METHODS)
    const orphans = [...registeredMethods].filter(m => !ssot.has(m))
    expect(orphans, `methods registered but missing from PLUGIN_RPC_METHODS: ${orphans.join(', ')}`).toEqual([])
    // 数量级回归锚点：46（agent5 commands3 config3 hooks2 notify1 sessionData4
    // sessions8 storage8 tools2 ui5 views2 workspace3）+ AP-4 读侧 6（readEntries/
    // getCommands/register+unregisterEntryInvalidation 4 + activate 族 2）+ ui 命令式
    // 点位 1（updateHeaderAction，[u5b] handler 已落地转正）= 53 + provider-plugin-access
    // D9 两项（plugin.event 上报 + plugin.ui.openUrl 服务调用）= 55 + D4 三项
    // （providers.write / providers.delete / providers.credential，组合根注册）= 58。
    // registeredMethods.size 同步锚点：58/58。
    expect(PLUGIN_RPC_METHODS.length).toBe(58)
    expect(registeredMethods.size).toBe(58)
  })

  it('AC-I6: 全部口径归一化产物无孤儿（每个产出方法名都在真实注册表）', () => {
    // 三口径全集：SDK 常量 + manifest 常用短形 + demo legacy 形 + 完整方法名样本
    const inputs = [
      ...Object.values(PermissionConstants),
      'storage.get', 'storage.set', 'storage.delete', 'storage.keys',
      'workspace:file:search',
      'plugin.hooks.register', 'plugin.storage.global.set',
    ]
    for (const input of inputs) {
      const methods = normalizePermissionInput(input)
      expect(methods.length, `input '${input}' must map to non-empty set`).toBeGreaterThan(0)
      for (const m of methods) {
        // 豁免表（PENDING_U5B_METHODS）当前为空：全部登记方法均已实装
        expect(registeredMethods.has(m) || PENDING_U5B_METHODS.has(m), `mapped method '${m}' (from '${input}') not on real PluginRpcServer`).toBe(true)
      }
    }
  })

  it('AC-I6: 短形 / SDK 常量 / legacy 形归一化正确（能力 → 方法集映射语义）', () => {
    // SDK 常量 → 能力全集
    expect(normalizePermissionInput('storage.access')).toEqual([
      'plugin.storage.global.get', 'plugin.storage.global.set',
      'plugin.storage.global.delete', 'plugin.storage.global.keys',
      'plugin.storage.workspace.get', 'plugin.storage.workspace.set',
      'plugin.storage.workspace.delete', 'plugin.storage.workspace.keys',
    ])
    expect(normalizePermissionInput('sessions.readState')).toEqual([
      'plugin.sessions.list', 'plugin.sessions.get', 'plugin.sessions.getActive',
      'plugin.sessions.registerCreate', 'plugin.sessions.registerDestroy',
      'plugin.sessions.unregisterCreate', 'plugin.sessions.unregisterDestroy',
      // AP-4 读侧（U2）：数据读 + entry 失效订阅族 + 激活订阅族（[u5b] handler 均已实装）
      'plugin.sessions.readEntries', 'plugin.sessions.getCommands',
      'plugin.sessions.registerEntryInvalidation', 'plugin.sessions.unregisterEntryInvalidation',
      'plugin.sessions.registerActivate', 'plugin.sessions.unregisterActivate',
    ])
    // 注册类能力连带 unregister（成对授予避免「能注册不能注销」）
    expect(normalizePermissionInput('tools.register')).toEqual(['plugin.tools.register', 'plugin.tools.unregister'])
    expect(normalizePermissionInput('hooks.register')).toEqual(['plugin.hooks.register', 'plugin.hooks.unregister'])
    expect(normalizePermissionInput('notify')).toEqual(['plugin.notify', 'plugin.ui.notify'])
    expect(normalizePermissionInput('sessions.sendMessage')).toEqual(['plugin.sessions.sendMessage'])

    // manifest 短形 → global + workspace 双 scope
    expect(normalizePermissionInput('storage.set')).toEqual(['plugin.storage.global.set', 'plugin.storage.workspace.set'])

    // legacy 形（demo 插件 workspace:file:search）
    expect(normalizePermissionInput('workspace:file:search')).toEqual(['plugin.workspace.findFiles'])

    // 完整方法名幂等透传（二次归一不变形）
    expect(normalizePermissionInput('plugin.config.get')).toEqual(['plugin.config.get'])
    // 未收录进 alias 表的去前缀形经 plugin. 前缀补全命中
    expect(normalizePermissionInput('sessions.list')).toEqual(['plugin.sessions.list'])
  })

  it('AC-I6: 未知词 / 空白 / 非字符串归一为空数组（fail-closed）', () => {
    expect(normalizePermissionInput('totally.unknown')).toEqual([])
    expect(normalizePermissionInput('workspace:file:write')).toEqual([])
    expect(normalizePermissionInput('')).toEqual([])
    expect(normalizePermissionInput('   ')).toEqual([])
    // @ts-expect-error 运行时防御：非字符串输入（磁盘旧数据可能是任意 JSON 值）
    expect(normalizePermissionInput(undefined)).toEqual([])
    // @ts-expect-error 运行时防御
    expect(normalizePermissionInput(42)).toEqual([])
  })
})
});
