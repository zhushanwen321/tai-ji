/**
 * 能力放行宿主接线测试（provider-plugin-access D3 宿主 wiring 段）。
 *
 * 断裂面：P-perm 既有测试（plugin-sandbox-escape / plugin-esm-loader）只覆盖
 * 「loader 收到 env 之后」的行为——env 由测试手工注入；descriptor → 激活链登记 →
 * fork env 的接线段此前零覆盖（setPluginCapabilityEnv 全仓零调用，sandbox fork
 * 恒无放行清单，ESM loader 按基线黑名单全拦 fail-closed）。本文件锁定接线三段：
 * ① 激活链登记：sandbox descriptor（manifest capabilities/readPaths 透传）激活时在
 *    assignWorker 之前调 host.setPluginCapabilityEnv；trusted 不登记（Worker 线程无
 *    ESM loader）；宿主未实现该方法（mock/Worker 版语义）时激活不炸（fail-closed
 *    降级不阻塞激活主流程）；每次激活重登记（进程回收清除后由激活链恢复）。
 * ② PluginHost 转发：登记经真实 PluginHost 落到子进程宿主 capabilityEnvInputs。
 * ③ fork env 注入：登记后的 sandbox fork options.env 含 TAIJI_PLUGIN_ALLOWED_MODULES
 *    （能力词解析的模块集）与 TAIJI_PLUGIN_READ_PATHS；未登记插件 env 无能力键。
 *
 * 形态：fork 桩（假子进程捕获 fork options.env，零真进程，plugin-host-process-journal
 * 测试同款先例）；激活链 mock 宿主形态同 plugin-activator.test.ts 的 createMockHost。
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-capability-wiring.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginHost as ActivatorHost } from '../src/services/plugin-service/plugin-activator.js'
import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { PluginCapabilityForkEnvInput } from '../src/services/plugin-service/plugin-fs-guard.js'
import type { PluginDescriptor, WorkerToHostMessage } from '../src/services/plugin-service/plugin-types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// fork env 键 SSOT（plugin-fs-guard.cjs 的 ENV_* 常量，编码侧 buildPluginCapabilityForkEnv 同源）
const nodeRequire = createRequire(import.meta.url)
const fsGuard = nodeRequire(join(__dirname, '../src/services/plugin-service/plugin-fs-guard.cjs')) as {
  ENV_ALLOWED_MODULES_KEY: string
  ENV_READ_PATHS_KEY: string
}

/** network.http 的放行模块集（D3 表） */
const NETWORK_HTTP_MODULES = ['http', 'https', 'net', 'dns', 'tls']

// ── fork 桩：假子进程 + fork options.env 捕获（零真进程）─────────────
const forkSlot = vi.hoisted(() => ({
  child: null as unknown,
  env: null as Record<string, string | undefined> | null,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    fork: (_path: unknown, _args: unknown, options: { env?: Record<string, string | undefined> }): ChildProcess => {
      forkSlot.env = options?.env ?? null
      if (forkSlot.child) return forkSlot.child as ChildProcess
      throw new Error('fork stub: 未装入假子进程（用例须先 installFakeChild）')
    },
  }
})

/**
 * 假 fork 子进程：PluginHostProcess 消费的成员面；load/activate 生命周期握手
 * 自动回复（真实子进程由 bootstrap 驱动，桩按消息类型镜像回复，端到端用例消费）。
 */
class FakeForkChild extends EventEmitter {
  readonly pid = 4321
  exitCode: number | null = null
  signalCode: string | null = null
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly sent: unknown[] = []

  kill(): void {
    this.emitExit(null, 'SIGKILL')
  }

  send(message: unknown): boolean {
    this.sent.push(message)
    const m = message as { type?: string; pluginId?: string }
    if (m?.type === 'load' && m.pluginId) {
      queueMicrotask(() => this.emit('message', { type: 'loaded', pluginId: m.pluginId }))
    }
    if (m?.type === 'activate' && m.pluginId) {
      queueMicrotask(() => this.emit('message', { type: 'activated', pluginId: m.pluginId }))
    }
    return true
  }

  emitExit(code: number | null, signal: string | null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

function installFakeChild(): FakeForkChild {
  const child = new FakeForkChild()
  forkSlot.child = child as unknown
  return child
}

// ── 激活链用例共享形态（同 plugin-activator.test.ts）─────────────────

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'cap-wired',
    version: '1.0.0',
    displayName: 'cap-wired',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/cap-wired/index.js',
    source: 'built-in',
    extensionDependencies: [],
    ...overrides,
  }
}

interface WiringMockHost { // oe-exempt:20261024:test:本测试的 mock 宿主形态描述，单实现为测试天然形态（非 ports/SDK 契约抽象）
  host: ActivatorHost
  setCapabilityEnv: ReturnType<typeof vi.fn>
  assignWorker: ReturnType<typeof vi.fn>
}

/**
 * mock 激活宿主：postMessage 后 microtask 内模拟 Worker 回复（激活成功路径）。
 * withCapabilityMethod=false 构造「宿主未实现 setPluginCapabilityEnv」的降级形态
 * （旧 mock 宿主/Worker 版语义——契约方法为可选的原因）。
 */
function createWiringMockHost(
  activator: PluginActivator,
  replyType: 'activated' | 'deactivated' = 'activated',
  withCapabilityMethod = true,
): WiringMockHost {
  const setCapabilityEnv = vi.fn((_pluginId: string, _input: PluginCapabilityForkEnvInput) => {})
  const assignWorker = vi.fn((_pluginId: string, _trustLevel: 'trusted' | 'sandbox') => Promise.resolve('worker-1'))
  const host: ActivatorHost = {
    assignWorker,
    loadPlugin: vi.fn(() => Promise.resolve()),
    getWorkerHandle: vi.fn((pluginId: string) => ({
      workerId: 'worker-1',
      postMessage: vi.fn(() => {
        queueMicrotask(() => {
          activator.handleWorkerReply({ type: replyType, pluginId })
        })
      }),
    })),
    terminateWorker: vi.fn(() => Promise.resolve()),
    ...(withCapabilityMethod ? { setPluginCapabilityEnv: setCapabilityEnv } : {}),
  }
  return { host, setCapabilityEnv, assignWorker }
}

// ── ① 激活链登记 ────────────────────────────────────────────────────

describe('激活链登记（descriptor → host.setPluginCapabilityEnv）', () => {
  it('sandbox descriptor：assignWorker 之前登记 manifest capabilities/readPaths', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({
      pluginId: 'cap-sandbox',
      capabilities: ['network.http', 'fs.read-user-data'],
      readPaths: ['Library/App/storage.json'],
    })
    activator.registerDescriptors([desc])
    const { host, setCapabilityEnv, assignWorker } = createWiringMockHost(activator)

    await activator.activatePlugin('cap-sandbox', { type: 'onStartupFinished' }, host)

    expect(activator.getState('cap-sandbox')).toBe('ACTIVE')
    expect(setCapabilityEnv).toHaveBeenCalledTimes(1)
    expect(setCapabilityEnv).toHaveBeenCalledWith('cap-sandbox', {
      capabilities: ['network.http', 'fs.read-user-data'],
      readPaths: ['Library/App/storage.json'],
    })
    // 登记必须先于 assignWorker（fork 只发生在 assignProcess 内，后登记不生效）
    expect(setCapabilityEnv.mock.invocationCallOrder[0]).toBeLessThan(assignWorker.mock.invocationCallOrder[0])
  })

  it('trusted descriptor：不登记（Worker 线程无 ESM loader，无 fork env 语义）', async () => {
    const activator = new PluginActivator()
    activator.registerDescriptors([makeDescriptor({ pluginId: 'cap-trusted', trustLevel: 'trusted' })])
    const { host, setCapabilityEnv } = createWiringMockHost(activator)

    await activator.activatePlugin('cap-trusted', { type: 'onStartupFinished' }, host)

    expect(activator.getState('cap-trusted')).toBe('ACTIVE')
    expect(setCapabilityEnv).not.toHaveBeenCalled()
  })

  it('宿主未实现该方法（mock/Worker 版语义）：激活不炸（fail-closed 降级）', async () => {
    const activator = new PluginActivator()
    activator.registerDescriptors([makeDescriptor({ pluginId: 'cap-degrade' })])
    const { host } = createWiringMockHost(activator, 'activated', false)

    await activator.activatePlugin('cap-degrade', { type: 'onStartupFinished' }, host)

    expect(activator.getState('cap-degrade')).toBe('ACTIVE')
  })

  it('每次激活重登记：deactivate 后再激活，登记再次发生（进程回收清除后由激活链恢复）', async () => {
    const activator = new PluginActivator()
    activator.registerDescriptors([
      makeDescriptor({ pluginId: 'cap-recycle', capabilities: ['crypto'] }),
    ])
    const first = createWiringMockHost(activator, 'activated')
    await activator.activatePlugin('cap-recycle', { type: 'onStartupFinished' }, first.host)
    expect(first.setCapabilityEnv).toHaveBeenCalledTimes(1)

    const deact = createWiringMockHost(activator, 'deactivated')
    await activator.deactivatePlugin('cap-recycle', deact.host)
    expect(activator.getState('cap-recycle')).toBe('UNLOADED')

    const second = createWiringMockHost(activator, 'activated')
    await activator.activatePlugin('cap-recycle', { type: 'onStartupFinished' }, second.host)
    expect(second.setCapabilityEnv).toHaveBeenCalledTimes(1)
    expect(second.setCapabilityEnv).toHaveBeenCalledWith('cap-recycle', { capabilities: ['crypto'] })
  })
})

// ── ② + ③ 真实宿主链：PluginHost 转发 → 子进程宿主 → fork env ────────

describe('真实宿主链 fork env 注入（PluginHost → PluginHostProcess）', () => {
  let dataDir = ''
  const createdDirs: string[] = []

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cap-wiring-'))
    createdDirs.push(dataDir)
  })

  afterEach(() => {
    forkSlot.child = null
    forkSlot.env = null
  })

  afterAll(() => {
    // maxRetries+retryDelay：teardown 递归删除 ENOTEMPTY 瞬态重试（pre-commit flake 卫生硬要求）
    for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 真实 PluginHost（fork 已桩化；bootstrap 占位路径仅短路 resolveAndValidateFile 链） */
  function makeRealHost(): PluginHost {
    return new PluginHost(new PluginRpcServer(), {
      bootstrapPathOverride: join(dataDir, 'bootstrap-not-executed.cjs'),
      // sandbox fork 前断言 execArgv 含 --import（MF-1 fail-closed 守护）；fork 已桩化，
      // loader 路径不实际加载，占位即可
      execArgv: ['--import', 'cap-wiring-stub-loader.cjs'],
    })
  }

  it('③ 登记 → sandbox fork env 含放行清单与 readPaths（D3 注入点）', async () => {
    const host = makeRealHost()
    installFakeChild()
    const pluginPath = join(dataDir, 'cap-fork', 'index.js')

    host.setPluginCapabilityEnv('cap-fork', {
      capabilities: ['network.http'],
      readPaths: ['Library/App/storage.json'],
    })
    await host.assignWorker('cap-fork', 'sandbox', pluginPath)

    expect(forkSlot.env?.[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBe(JSON.stringify(NETWORK_HTTP_MODULES))
    expect(forkSlot.env?.[fsGuard.ENV_READ_PATHS_KEY]).toBe(JSON.stringify(['Library/App/storage.json']))
    // sandbox 目录注入不受能力登记影响（fork env 双通道并存）
    expect(forkSlot.env?.TAIJI_PLUGIN_SANDBOX_DIR).toBe(dirname(pluginPath))
    await host.shutdown()
  })

  it('③ 未登记插件：fork env 无能力键（fail-closed 基线）', async () => {
    const host = makeRealHost()
    installFakeChild()

    await host.assignWorker('cap-none', 'sandbox', join(dataDir, 'cap-none', 'index.js'))

    expect(forkSlot.env?.[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBeUndefined()
    expect(forkSlot.env?.[fsGuard.ENV_READ_PATHS_KEY]).toBeUndefined()
    await host.shutdown()
  })

  it('③ 进程回收清除登记 → 重登记后再 fork 重新生效（重建链前提）', async () => {
    const host = makeRealHost()
    installFakeChild()
    const pluginPath = join(dataDir, 'cap-cycle', 'index.js')

    host.setPluginCapabilityEnv('cap-cycle', { capabilities: ['network.http'] })
    const workerId = await host.assignWorker('cap-cycle', 'sandbox', pluginPath)

    // terminateWorker 回收进程并清除登记（capabilityEnvInputs 随 removeIndexEntries 删除）
    await host.terminateWorker(workerId)

    // 重激活链重登记后再 fork，放行清单重新注入
    host.setPluginCapabilityEnv('cap-cycle', { capabilities: ['network.http'] })
    installFakeChild()
    await host.assignWorker('cap-cycle', 'sandbox', pluginPath)
    expect(forkSlot.env?.[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBe(JSON.stringify(NETWORK_HTTP_MODULES))
    await host.shutdown()
  })

  it('端到端：activatePlugin → 真 PluginHost → fork options.env 含放行清单（S9 接线段）', async () => {
    const host = makeRealHost()
    installFakeChild()
    const pluginPath = join(dataDir, 'cap-e2e', 'index.js')
    const activator = new PluginActivator()
    // reply 接线对齐生产装配（plugin-service.registerWorkerCallbacks）
    host.setReplyCallback((msg) => activator.handleWorkerReply(msg as WorkerToHostMessage))
    activator.registerDescriptors([
      makeDescriptor({
        pluginId: 'cap-e2e',
        pluginPath,
        capabilities: ['network.http'],
        readPaths: ['data/in.txt'],
      }),
    ])

    await activator.activatePlugin('cap-e2e', { type: 'onStartupFinished' }, host)

    expect(activator.getState('cap-e2e')).toBe('ACTIVE')
    expect(forkSlot.env?.[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBe(JSON.stringify(NETWORK_HTTP_MODULES))
    expect(forkSlot.env?.[fsGuard.ENV_READ_PATHS_KEY]).toBe(JSON.stringify(['data/in.txt']))
    await host.shutdown()
  })
})
