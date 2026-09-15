/**
 * RPC 鉴权通道反查行为测试（D1：身份由通道绑定）
 *
 * 真实 PluginRpcServer + 真实 PluginPermissionChecker + mock worker 通道：
 * - sandbox 伪冒 trusted/built-in id → PERMISSION_DENIED（含 identity mismatch 语义）；
 *   旧版漏洞（plugin-permission 按消息体 pluginId 判定，trusted/built-in 一律放行）回归防护
 * - 已授权方法 + 伪冒他人 pluginId → 放行但分区键覆写为通道真实身份
 *   （storage/sessionData 分区安全依赖覆写，spec A3 验收）
 * - trusted worker → 放行（worker 级语义，params 不覆写）
 * - 未知 workerId / 未注册身份 → fail-closed 拒绝
 *
 * host 级接线（真实 fork + 真实 Worker 线程，fixture 复用 plugin-host.test.ts）：
 * - assignWorker 注册的通道身份可经 resolveIdentity 反查（trusted / sandbox 两形态）
 * - terminateWorker / crash 清理后身份同步注销
 *
 * 运行命令: cd packages/runtime && npx vitest run test/plugin-identity-auth.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginRpcServer, type WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { RpcResponse } from '../src/services/plugin-service/plugin-types.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'
import { PluginPermissionChecker } from '../src/services/plugin-service/plugin-permission.js'
import { PermissionStorage } from '../src/services/plugin-service/plugin-permission-storage.js'
import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import type { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER_MOCK = resolve(__dirname, 'fixtures/mock-bootstrap.cjs')
const PROCESS_MOCK_SOURCE = resolve(__dirname, 'fixtures/plugin-bootstrap-process.mock.cjs')
const NOOP_ESM_LOADER = resolve(__dirname, 'fixtures/noop-esm-loader.cjs')

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-identity-auth-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 记录 postMessage 收到的消息（mock worker 通道） */
function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

/** 空 registry mock（check 路径不消费 registry，仅构造 checker 需要） */
function emptyRegistry(): PluginRegistry {
  return { getDescriptor: () => undefined } as unknown as PluginRegistry
}

/** 真实 server + 真实 checker 组合（与 plugin-lifecycle 3c 步同构接线） */
function createAuthedServer(): { rpc: PluginRpcServer; checker: PluginPermissionChecker } {
  const rpc = new PluginRpcServer()
  const checker = new PluginPermissionChecker(emptyRegistry(), new PermissionStorage(tmpDir))
  rpc.setPermissionChecker((identity, method) => checker.check(identity, method))
  return { rpc, checker }
}

/** 从 mock port 提取第一条 RPC 响应 */
function firstResponse(port: { messages: unknown[] }): RpcResponse {
  const wrapper = port.messages[0] as { type: string; response: RpcResponse }
  expect(wrapper?.type).toBe('rpc')
  return wrapper.response
}

/** 捕获 handler 收到的 params（对象属性跨闭包不被 TS 收窄，断言时无需 double-cast） */
function createParamsCapture(): { current: Record<string, unknown> | null } {
  return { current: null }
}

describe('dispatch 鉴权（通道身份，非消息体自报）', () => {
  it('sandbox 伪冒 trusted id 调未授权方法 → PERMISSION_DENIED 且文案含 identity mismatch', async () => {
    const { rpc } = createAuthedServer()
    // 恶意 sandbox 插件 'evil'：无任何授权
    const port = createMockPort()
    rpc.registerWorker('sandbox-evil', port, { trustLevel: 'sandbox', pluginId: 'evil' })

    const captured = createParamsCapture()
    rpc.registerMethod('plugin.agent.setModel', async (params) => {
      captured.current = params
      return { ok: true }
    })

    // 伪冒 built-in 插件 id 'statusline'（旧版：trusted/built-in 一律放行的漏洞）
    await rpc.dispatch('sandbox-evil', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.agent.setModel',
      params: { pluginId: 'statusline', model: 'evil-model' },
    })

    const resp = firstResponse(port)
    expect('error' in resp).toBeTruthy()
    const error = (resp as { error: { code: number; message: string } }).error
    expect(error.code).toBe(PluginRpcErrorCodes.PERMISSION_DENIED)
    // identity mismatch 语义：直接指出消息自报 id 与通道身份不符
    expect(error.message).toContain('identity mismatch')
    expect(error.message).toContain('statusline')
    expect(error.message).toContain('evil')
    // handler 未执行
    expect(captured.current).toBeNull()
  })

  it('sandbox 已授权方法 + 伪冒他人 pluginId → 放行且 params.pluginId 覆写为通道真实身份', async () => {
    const { rpc, checker } = createAuthedServer()
    // evil 声明并获批 storage 写权限（完整方法名口径 grant）
    checker.grant('evil', ['plugin.storage.global.set'])

    const port = createMockPort()
    rpc.registerWorker('sandbox-evil', port, { trustLevel: 'sandbox', pluginId: 'evil' })

    const captured = createParamsCapture()
    rpc.registerMethod('plugin.storage.global.set', async (params) => {
      captured.current = params
      return { ok: true }
    })

    // 方法在授权集内（鉴权按通道身份 evil 查 granted → 放行），
    // 但 params.pluginId 伪冒 'statusline' → 分区键必须被覆写为 evil
    await rpc.dispatch('sandbox-evil', {
      jsonrpc: '2.0',
      id: 2,
      method: 'plugin.storage.global.set',
      params: { pluginId: 'statusline', key: 'k', value: 'v' },
    })

    const resp = firstResponse(port)
    expect('result' in resp).toBeTruthy()
    expect(captured.current).not.toBeNull()
    expect(captured.current!.pluginId).toBe('evil')
    expect(captured.current!.key).toBe('k')
  })

  it('trusted worker → 放行且 params 不覆写（worker 级语义，trusted 间互不设防）', async () => {
    const { rpc } = createAuthedServer()
    const port = createMockPort()
    rpc.registerWorker('trusted-1', port, { trustLevel: 'trusted' })

    const captured = createParamsCapture()
    rpc.registerMethod('plugin.agent.setModel', async (params) => {
      captured.current = params
      return { ok: true }
    })

    // trusted 无需任何 grant；自报 pluginId 为任意值（含伪冒 sandbox id）均放行
    await rpc.dispatch('trusted-1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'plugin.agent.setModel',
      params: { pluginId: 'some-sandbox-plugin', model: 'm' },
    })

    const resp = firstResponse(port)
    expect('result' in resp).toBeTruthy()
    // trusted 通道多插件共享，无唯一归属 → 不覆写（插件自身分区由它自报，
    // trusted 互不设防是设计语义而非漏洞）
    expect(captured.current!.pluginId).toBe('some-sandbox-plugin')
  })

  it('已注册端口但无身份（identity 缺失）→ fail-closed PERMISSION_DENIED', async () => {
    const { rpc } = createAuthedServer()
    const port = createMockPort()
    // registerWorker 未传 identity（身份缺失的 Worker：宿主接线异常或旧代码路径）
    rpc.registerWorker('w-legacy', port)

    rpc.registerMethod('plugin.notify', async () => ({ ok: true }))

    await rpc.dispatch('w-legacy', {
      jsonrpc: '2.0',
      id: 4,
      method: 'plugin.notify',
      params: { pluginId: 'x' },
    })

    const resp = firstResponse(port)
    expect('error' in resp).toBeTruthy()
    const error = (resp as { error: { code: number; message: string } }).error
    expect(error.code).toBe(PluginRpcErrorCodes.PERMISSION_DENIED)
    expect(error.message).toContain('cannot resolve worker identity')
    expect(error.message).toContain('w-legacy')
  })

  it('完全未注册的 workerId → 无回包（fail-closed，不执行 handler）', async () => {
    const { rpc } = createAuthedServer()
    const port = createMockPort()
    rpc.registerWorker('w-real', port, { trustLevel: 'sandbox', pluginId: 'real' })

    let called = false
    rpc.registerMethod('plugin.notify', async () => {
      called = true
      return { ok: true }
    })

    // 未知来源：dispatch 直接 no-op（无端口可回），handler 不执行
    await rpc.dispatch('w-forged', {
      jsonrpc: '2.0',
      id: 5,
      method: 'plugin.notify',
      params: { pluginId: 'real' },
    })

    expect(port.messages.length).toBe(0)
    expect(called).toBe(false)
  })

  it('unregisterWorker 后身份同步注销 → dispatch 无回包、resolveIdentity undefined', async () => {
    const { rpc } = createAuthedServer()
    const port = createMockPort()
    rpc.registerWorker('sandbox-gone', port, { trustLevel: 'sandbox', pluginId: 'gone' })
    expect(rpc.resolveIdentity('sandbox-gone')).toEqual({ trustLevel: 'sandbox', pluginId: 'gone' })

    rpc.unregisterWorker('sandbox-gone')
    expect(rpc.resolveIdentity('sandbox-gone')).toBeUndefined()

    await rpc.dispatch('sandbox-gone', {
      jsonrpc: '2.0',
      id: 6,
      method: 'plugin.notify',
      params: { pluginId: 'gone' },
    })
    expect(port.messages.length).toBe(0)
  })
})

describe('host 级身份接线（registerWorker 传身份元数据）', () => {
  it('trusted Worker：assignWorker 注册 worker 级 trusted 身份（无 pluginId 归属）', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })

    const workerId1 = await host.assignWorker('tp-1', 'trusted')
    const workerId2 = await host.assignWorker('tp-2', 'trusted')

    // 共享 Worker → 同一通道身份；多插件共享无唯一归属（pluginId undefined）
    expect(workerId1).toBe(workerId2)
    expect(rpc.resolveIdentity(workerId1)).toEqual({ trustLevel: 'trusted' })

    await host.shutdown()
  })

  it('sandbox fork 子进程：assignWorker 注册一对一 sandbox 身份（含 pluginId）', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, {
      bootstrapPathOverride: PROCESS_MOCK_SOURCE,
      execArgv: ['--import', NOOP_ESM_LOADER],
    })

    const processId = await host.assignWorker('external-plugin', 'sandbox', tmpDir)
    expect(processId).toBe('sandbox-external-plugin')
    expect(rpc.resolveIdentity(processId)).toEqual({
      trustLevel: 'sandbox',
      pluginId: 'external-plugin',
    })

    // terminate 清理：端口与身份同生共死
    await host.terminateWorker(processId)
    expect(rpc.resolveIdentity(processId)).toBeUndefined()

    await host.shutdown()
  })
})
