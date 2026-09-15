/**
 * 权限审批超时取消语义测试（timeout-plugin-service D3 / 实施单元 U5）
 *
 * 锁定契约：
 *  a. 审批等待到期（'timeout' 结局）≠ 用户拒绝：warn（含等待时长 + 恢复指引）
 *     + onPermissionRequestExpired 广播（前端撤窗）+ 置 UNLOADED（未装载态，
 *     状态机允许重触发 activation event 重新激活 + 重新弹审批）
 *  b. 显式 false（用户真点拒绝 / 挂起期清理唤醒）行为不变：UNLOADED、无 expired 广播
 *  c. 迟到批准 noop 不炸（pending 已删，debug 留痕）
 *  d. 等待期间状态被外部改写 → 既有作废分支优先于 'timeout' 分流：无 expired 广播、
 *     无幽灵状态回写
 *  e. 生产装配接线：TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS env 合法值生效 / 非法值 warn
 *     回落默认 30min / 缺失回落默认（readEnvPermissionTimeoutMs，lifecycle-manager
 *     getEnvIdleTimeoutMs 同形态）
 *  f. V5 端到端重触发链路（设计 §6.3 条款 2 重触发精确语义）：超时取消（UNLOADED）
 *     后重触发 activation event 不被 handleEvent 候选过滤拦截（仅排除 ACTIVE/
 *     ACTIVATING）→ 重新弹审批（新 pending 挂起），本次批准走完整激活链 → ACTIVE
 *
 * 运行命令: cd packages/runtime && npx vitest run test/plugin-permission-timeout.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginActivator, PERMISSION_TIMEOUT_MS } from '../src/services/plugin-service/plugin-activator.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'
import type { IMessageBroker } from '../src/interfaces.js'

/** 权限审批只对 sandbox + 非 built-in 生效（PermissionChecker 对 trusted/built-in 返回空） */
function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'timeout-plugin',
    version: '1.0.0',
    displayName: 'Timeout Plugin',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: ['plugin.hooks.register'],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/does-not-exist/timeout-plugin/index.js',
    source: 'external',
    extensionDependencies: [],
    ...overrides,
  }
}

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/** mock host：postMessage 后微任务回 activated（超时场景不走到这里，防御性齐备） */
function createMockHost(activator: PluginActivator): PluginHost {
  return {
    assignWorker: vi.fn(() => Promise.resolve('worker-timeout')),
    loadPlugin: vi.fn(() => Promise.resolve()),
    getWorkerHandle: vi.fn((pluginId: string) => ({
      workerId: 'worker-timeout',
      postMessage: vi.fn(() => {
        queueMicrotask(() => {
          activator.handleWorkerReply({ type: 'activated', pluginId })
        })
      }),
    })),
    terminateWorker: vi.fn(() => Promise.resolve()),
  } as unknown as PluginHost
}

function makeActivator(overrides: {
  permissionTimeoutMs?: number
  onPermissionRequestExpired?: (payload: { pluginId: string }) => void
  /** 传入 spy 以断言审批弹窗触发次数/时点（缺省 no-op「无人作答」） */
  onPermissionRequest?: (payload: { pluginId: string; permissions: string[] }) => void
}): PluginActivator {
  return new PluginActivator({
    permissionChecker: { getUnapproved: () => ['plugin.hooks.register'] },
    onPermissionRequest: () => { /* 无人作答 */ },
    ...overrides,
  })
}

/**
 * 触发激活并推进到「挂在权限等待」稳定点。返回包裹对象防调用方误 await 挂起激活
 *（plugin-permission-approval-wake.test.ts 同模式）。
 */
async function startPendingActivation(
  activator: PluginActivator,
  host: PluginHost,
): Promise<{ activation: Promise<void> }> {
  const activation = activator.activatePlugin('timeout-plugin', { type: 'onStartupFinished' }, host)
  await vi.advanceTimersByTimeAsync(0)
  expect(activator.getState('timeout-plugin')).toBe('ACTIVATING')
  return { activation }
}

describe('审批等待到期取消语义（activator 层分流）', () => {
  let descriptor: PluginDescriptor

  beforeEach(() => {
    vi.useFakeTimers()
    descriptor = makeDescriptor()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ── a. timeout 分流：取消非判拒 ─────────────────────────────────
  it("到期 resolve 'timeout' → warn 恢复指引 + expired 广播 + UNLOADED，不分配 Worker", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const expiredSpy = vi.fn()
    const activator = makeActivator({ permissionTimeoutMs: 100, onPermissionRequestExpired: expiredSpy })
    activator.registerDescriptors([descriptor])
    const host = createMockHost(activator)
    const { activation } = await startPendingActivation(activator, host)

    await vi.advanceTimersByTimeAsync(200)
    await activation

    expect(activator.getState('timeout-plugin')).toBe('UNLOADED')
    expect(expiredSpy).toHaveBeenCalledTimes(1)
    expect(expiredSpy).toHaveBeenCalledWith({ pluginId: 'timeout-plugin' })
    const warnText = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(warnText).toContain('timed out after 100ms')
    expect(warnText).toContain('re-trigger the activation event')
    expect(warnText).toContain('TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS')
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  // ── b. 显式 false 分流：行为不变，无 expired 广播 ────────────────
  it('用户显式拒绝 → UNLOADED、无 expired 广播（超时与拒绝可区分）', async () => {
    const expiredSpy = vi.fn()
    const activator = makeActivator({ permissionTimeoutMs: 100, onPermissionRequestExpired: expiredSpy })
    activator.registerDescriptors([descriptor])
    const host = createMockHost(activator)
    const { activation } = await startPendingActivation(activator, host)

    activator.resolvePermissionApproval('timeout-plugin', false)
    await activation
    // 拒绝即时收敛，等待窗口内不推进到超时
    expect(activator.getState('timeout-plugin')).toBe('UNLOADED')
    expect(expiredSpy).not.toHaveBeenCalled()
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  // ── c. 迟到批准 noop 不炸 ───────────────────────────────────────
  it('超时取消后迟到批准 → 不抛异常、状态仍 UNLOADED、debug 留痕', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const activator = makeActivator({ permissionTimeoutMs: 100 })
    activator.registerDescriptors([descriptor])
    const host = createMockHost(activator)
    const { activation } = await startPendingActivation(activator, host)

    await vi.advanceTimersByTimeAsync(200)
    await activation
    expect(activator.getState('timeout-plugin')).toBe('UNLOADED')

    expect(() => activator.resolvePermissionApproval('timeout-plugin', true)).not.toThrow()
    expect(activator.getState('timeout-plugin')).toBe('UNLOADED')
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
    expect(debugSpy.mock.calls.some((args) => args.join(' ').includes('late response ignored'))).toBe(true)
  })

  // ── d1. 作废分支优先于 timeout 分流（pending 未消费的超时）────────
  it('等待期间状态被外部改写（crash 形态）且超时到点 → 作废 return，无 expired 广播、无幽灵回写', async () => {
    const expiredSpy = vi.fn()
    const activator = makeActivator({ permissionTimeoutMs: 100, onPermissionRequestExpired: expiredSpy })
    activator.registerDescriptors([descriptor])
    const host = createMockHost(activator)
    const { activation } = await startPendingActivation(activator, host)

    // 模拟 crash：只改写状态、不消 pending（markCrashed 语义）——醒来的激活必须在
    // 'timeout' 分流之前经 ACTIVATING 检查作废
    ;(activator as unknown as { pluginStates: Map<string, string> }).pluginStates.set('timeout-plugin', 'CRASHED')

    await vi.advanceTimersByTimeAsync(200)
    await activation

    // 作废路径不回写状态（CRASHED 保持，不被 timeout 分流的 setState('UNLOADED') 覆盖）
    expect(activator.getState('timeout-plugin')).toBe('CRASHED')
    expect(expiredSpy).not.toHaveBeenCalled()
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  // ── d2. 作废分支回归：deactivate 拒绝唤醒路径（既有语义 + 无 expired）──
  it('等待期间 deactivatePlugin 停用 → 激活作废收敛 UNLOADED、无 expired 广播', async () => {
    const expiredSpy = vi.fn()
    const activator = makeActivator({ permissionTimeoutMs: 100, onPermissionRequestExpired: expiredSpy })
    activator.registerDescriptors([descriptor])
    const host = createMockHost(activator)
    const { activation } = await startPendingActivation(activator, host)

    await activator.deactivatePlugin('timeout-plugin', host)
    // 推进越过原超时点：作废早已收敛，超时 timer 已被消费清理，不得二次裁决
    await vi.advanceTimersByTimeAsync(200)
    await activation

    expect(activator.getState('timeout-plugin')).toBe('UNLOADED')
    expect(expiredSpy).not.toHaveBeenCalled()
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  // ── f. V5 端到端重触发链路（设计 §6.3 条款 2）：超时取消 ≠ 终局——UNLOADED ──
  // 重触发 activation event → 新审批 pending → 本次批准 → ACTIVE
  it('超时取消（UNLOADED）后重触发 activation event → 重新弹审批，本次批准生效 → ACTIVE', async () => {
    const requestSpy = vi.fn()
    const expiredSpy = vi.fn()
    const activator = makeActivator({
      permissionTimeoutMs: 100,
      onPermissionRequest: requestSpy,
      onPermissionRequestExpired: expiredSpy,
    })
    activator.registerDescriptors([descriptor])
    const host = createMockHost(activator)

    // 第一次激活：挂审批 → 到期取消 → UNLOADED + expired 广播
    const firstActivation = activator.activatePlugin('timeout-plugin', { type: 'onStartupFinished' }, host)
    await vi.advanceTimersByTimeAsync(0)
    expect(activator.getState('timeout-plugin')).toBe('ACTIVATING')
    expect(requestSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(200)
    await firstActivation
    expect(activator.getState('timeout-plugin')).toBe('UNLOADED')
    expect(expiredSpy).toHaveBeenCalledTimes(1)

    // 重触发 activation event（handleEvent 候选过滤仅排除 ACTIVE/ACTIVATING，
    // UNLOADED 放行）→ 新审批 pending 挂起（第二个弹窗）
    const secondActivation = activator.handleEvent({ type: 'onStartupFinished' }, host)
    await vi.advanceTimersByTimeAsync(0)
    expect(requestSpy).toHaveBeenCalledTimes(2)
    expect(requestSpy).toHaveBeenLastCalledWith({ pluginId: 'timeout-plugin', permissions: ['plugin.hooks.register'] })
    expect(activator.getState('timeout-plugin')).toBe('ACTIVATING')

    // 本次批准 → 激活链走完（assignWorker → loadPlugin → activated 回复）→ ACTIVE
    activator.resolvePermissionApproval('timeout-plugin', true)
    await vi.advanceTimersByTimeAsync(0)
    await secondActivation
    expect(activator.getState('timeout-plugin')).toBe('ACTIVE')
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    // 批准路径不再产生第二次 expired 广播
    expect(expiredSpy).toHaveBeenCalledTimes(1)
  })
})

describe('审批超时生产装配接线（TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS）', () => {
  let tmpDir: string
  let descriptor: PluginDescriptor
  let broker: ReturnType<typeof createMockBroker>

  beforeEach(async () => {
    vi.useFakeTimers()
    tmpDir = await mkdtemp(join(tmpdir(), 'plugin-perm-timeout-'))
    descriptor = makeDescriptor()
    broker = createMockBroker()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    vi.restoreAllMocks()
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function buildService(): PluginService {
    const registryMock = {
      getDescriptor: vi.fn(() => descriptor),
      getAllDescriptors: vi.fn(() => [descriptor]),
      removeDescriptor: vi.fn(() => true),
    }
    return new PluginService(registryMock as unknown as PluginRegistry, broker, { configDir: tmpDir })
  }

  /** 经 service.activator 走完整激活挂起点（验证装配参数真实生效于超时行为） */
  async function startPending(service: PluginService): Promise<{ activator: PluginActivator; activation: Promise<void> }> {
    const activator = service.activator
    activator.registerDescriptors([descriptor])
    const host = createMockHost(activator)
    const activation = activator.activatePlugin('timeout-plugin', { type: 'onStartupFinished' }, host)
    await vi.advanceTimersByTimeAsync(0)
    expect(activator.getState('timeout-plugin')).toBe('ACTIVATING')
    return { activator, activation }
  }

  it('env 合法值生效：超时行为按 env 值裁决（非默认非旧 30s）', async () => {
    vi.stubEnv('TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS', '12345')
    const { activator, activation } = await startPending(buildService())

    await vi.advanceTimersByTimeAsync(12344)
    expect(activator.getState('timeout-plugin')).toBe('ACTIVATING')
    await vi.advanceTimersByTimeAsync(1)
    await activation
    expect(activator.getState('timeout-plugin')).toBe('UNLOADED')
  })

  it('env 非法值（非数字）→ warn 回落默认 30min（且不是旧 30s）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS', 'abc')
    const { activator, activation } = await startPending(buildService())

    expect(warnSpy.mock.calls.some((args) => args.join(' ').includes('is invalid'))).toBe(true)
    expect(warnSpy.mock.calls.some((args) => args.join(' ').includes(String(PERMISSION_TIMEOUT_MS)))).toBe(true)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(activator.getState('timeout-plugin')).toBe('ACTIVATING')
    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS - 30_000)
    await activation
    expect(activator.getState('timeout-plugin')).toBe('UNLOADED')
  })

  it('env 非法值（<=0）→ warn 回落默认 30min', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS', '0')
    const service = buildService()
    expect(warnSpy.mock.calls.some((args) => args.join(' ').includes('is invalid'))).toBe(true)
    // 回落值经行为面复核（默认 30min 不被 0/负值语义穿透）
    const { activator, activation } = await startPending(service)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(activator.getState('timeout-plugin')).toBe('ACTIVATING')
    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS - 30_000)
    await activation
    expect(activator.getState('timeout-plugin')).toBe('UNLOADED')
  })

  it('env 缺失 → 默认 30min 生效（非旧 30s），且装配注入 expired 广播经 broker 发出', async () => {
    const { activator, activation } = await startPending(buildService())

    await vi.advanceTimersByTimeAsync(30_000)
    expect(activator.getState('timeout-plugin')).toBe('ACTIVATING')
    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS - 30_000)
    await activation
    expect(activator.getState('timeout-plugin')).toBe('UNLOADED')

    // 装配的 onPermissionRequestExpired → broadcastOrBroker → broker.broadcast
    //（无 bus 注入时回退全局广播，帧 type 为 shared 新增的 ServerMessageType）
    const broadcastCalls = (broker.broadcast as ReturnType<typeof vi.fn>).mock.calls
    expect(
      broadcastCalls.some((c) => (c[0] as { type: string }).type === 'plugin:permissionRequestExpired'),
    ).toBe(true)
  })
})
