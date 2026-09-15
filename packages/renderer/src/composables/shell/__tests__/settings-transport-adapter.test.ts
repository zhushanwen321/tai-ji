/**
 * settings-transport-adapter 测试（两支合并）：
 *
 * 1. 三元装配 + V8 mock 接回（过度设计审计修复 u17 · 验收 V8）：
 *    adapter import 源 = @/api 门面三元（VITE_MOCK 感知）。锁定两个不变量：
 *    装配不变量（方法转发目标 = @/api 门面，防回退 core 直连）+ V8 行为不变量
 *    （VITE_MOCK=true 下 settings transport 返回 mock fixture，不打真实 WS）。
 * 2. discoverModels 模式感知 guard（S-13 补口，原版直 mock core transport 域；
 *    adapter 收编门面后改经 @/api config spy 断言，场景与断言语义不变）：
 *    discover 模式缺 baseUrl 短路 success:false 且不调 discoverModels（不做 silent
 *    cast）；test 模式透传不校验 baseUrl（端点回落链归 runtime）。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/shell/__tests__/settings-transport-adapter.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

/** 与被测 mock 域 fixture 的对照锚（composer-data MOCK_MODELS 首条） */
const MOCK_ANCHOR_MODEL_ID = 'claude-sonnet-4.5'

afterEach(() => {
  vi.doUnmock('@/api')
  vi.resetModules()
  vi.unstubAllEnvs()
})

describe('settings-transport-adapter · @/api 门面三元装配（u17）', () => {
  it('19 方法转发目标 = @/api 门面导出（spy 断言，防回退 core/transport 直连）', async () => {
    const listProviders = vi.fn().mockResolvedValue({ providers: [], scopedModels: [] })
    const listModels = vi.fn().mockResolvedValue([])
    const onModels = vi.fn().mockReturnValue(() => {})
    const onExtensions = vi.fn().mockReturnValue(() => {})
    const noop = (): ReturnType<typeof vi.fn> => vi.fn()
    vi.resetModules()
    vi.doMock('@/api', () => ({
      config: {
        listProviders,
        setProvider: noop(),
        setScopedModels: noop(),
        discoverModels: noop(),
        setSkillDirs: noop(),
        setAgentDirs: noop(),
        setExtensionDirs: noop(),
        onProviders: noop(),
        onSkills: noop(),
        onAgents: noop(),
        onSkillDirs: noop(),
        onAgentDirs: noop(),
        onExtensionDirs: noop(),
        onDefaults: noop(),
        onSystemPrompt: noop(),
        onTerminalConfig: noop(),
      },
      model: { listModels, onModels },
      extension: { onExtensions },
    }))
    const { createSettingsTransport } = await import('../settings-transport-adapter')
    const transport = createSettingsTransport()

    await transport.listProviders()
    await transport.listModels()
    transport.onModels(() => {})
    transport.onExtensions(() => {})

    expect(listProviders).toHaveBeenCalledTimes(1)
    expect(listModels).toHaveBeenCalledTimes(1)
    expect(onModels).toHaveBeenCalledTimes(1)
    expect(onExtensions).toHaveBeenCalledTimes(1)
  })
})

describe('settings-transport-adapter · V8 mock 模式接回（裁决 3）', () => {
  it('VITE_MOCK=true：settings 域方法解析到 mockApi（请求/订阅均返回 mock fixture，不打真实 WS）', async () => {
    vi.stubEnv('VITE_MOCK', 'true')
    vi.resetModules()
    const { createSettingsTransport } = await import('../settings-transport-adapter')
    const transport = createSettingsTransport()

    // 请求通路：listModels / listProviders 返回 mock fixture 数据。
    // 证据力：real 域走 ws-client RPC，单测环境无 WS 连接必失败/挂起——能同步返回
    // fixture 即证明解析到了 mockApi（门面三元 isMock 分支生效）。
    const models = await transport.listModels()
    expect(models.map((m) => m.id)).toContain(MOCK_ANCHOR_MODEL_ID)

    const providersReply = await transport.listProviders()
    expect(providersReply.providers.length).toBeGreaterThan(0)
    expect(Array.isArray(providersReply.scopedModels)).toBe(true)

    // 订阅通路：onModels 注册后微任务收到 mock fixture 首推（makeMockSubscription 语义）
    const pushed: number[] = []
    const off = transport.onModels((models) => pushed.push(models.length))
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    off()
  })
})

describe('settings-transport-adapter · discoverModels 模式感知 guard（S-13，经 @/api 门面 spy）', () => {
  async function makeTransportWithDiscoverSpy() {
    const discoverModels = vi.fn()
    vi.resetModules()
    vi.doMock('@/api', () => ({
      config: {
        listProviders: vi.fn(),
        setProvider: vi.fn(),
        setScopedModels: vi.fn(),
        discoverModels,
        setSkillDirs: vi.fn(),
        setAgentDirs: vi.fn(),
        setExtensionDirs: vi.fn(),
        onProviders: vi.fn(() => () => {}),
        onSkills: vi.fn(() => () => {}),
        onAgents: vi.fn(() => () => {}),
        onSkillDirs: vi.fn(() => () => {}),
        onAgentDirs: vi.fn(() => () => {}),
        onExtensionDirs: vi.fn(() => () => {}),
        onDefaults: vi.fn(() => () => {}),
        onSystemPrompt: vi.fn(() => () => {}),
        onTerminalConfig: vi.fn(() => () => {}),
      },
      model: { listModels: vi.fn(), onModels: vi.fn(() => () => {}) },
      extension: { onExtensions: vi.fn(() => () => {}) },
    }))
    const { createSettingsTransport } = await import('../settings-transport-adapter')
    return { transport: createSettingsTransport(), discoverModels }
  }

  it('discover 模式缺 baseUrl：短路返回 success:false 且不调 discoverModels', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    const reply = await transport.discoverModels({ mode: 'discover' })

    expect(reply).toEqual({ success: false, error: 'baseUrl is required for model discovery' })
    expect(discoverModels).not.toHaveBeenCalled()
  })

  it('mode 缺省按 discover 处理：缺 baseUrl 同样短路', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    const reply = await transport.discoverModels({})

    expect(reply.success).toBe(false)
    expect(discoverModels).not.toHaveBeenCalled()
  })

  it('test 模式缺 baseUrl：照常透传（端点回落链归 runtime，不校验 baseUrl）', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    discoverModels.mockResolvedValue({ success: true })
    const req = { mode: 'test' as const, providerId: 'p1' }
    const reply = await transport.discoverModels(req)

    expect(reply).toEqual({ success: true })
    expect(discoverModels).toHaveBeenCalledTimes(1)
    expect(discoverModels).toHaveBeenCalledWith({ ...req, mode: 'test' })
  })

  it('discover 模式带 baseUrl：正常透传（mode 缺省补全）', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    discoverModels.mockResolvedValue({ success: true, models: [] })
    const reply = await transport.discoverModels({ baseUrl: 'https://api.example.com' })

    expect(reply).toEqual({ success: true, models: [] })
    expect(discoverModels).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com',
      mode: 'discover',
    })
  })
})
