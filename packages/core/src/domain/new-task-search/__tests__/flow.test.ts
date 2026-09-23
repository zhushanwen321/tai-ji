/**
 * useNewTaskFlow 编排器单测（IF5）。
 *
 * 覆盖 plan TC-4..TC-8：startFlow 不变量/幂等/终态重建、submitFirstMessage 主链路
 * （D1 单一解析层：ensure 数据就绪 → resolve 终值 → create；P5② 窗口语义）/bash 分支/
 * null guard/非 landing 抛错/createInFlight 守卫/send reject 交接定格/retry 迁移、closeOverlay 幂等。
 * 全部端口 mock 注入（vi.fn()）；模块级状态 beforeEach resetNewTaskFlow + KV 单例 reset 隔离。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PiLaunchPreset, ProviderId, ProviderInfo, Segment, SessionSummary } from '@taiji/shared'
import { resetNewTaskFlow, useNewTaskFlowState } from '../flow-state'
import { useNewTaskFlow } from '../flow'
import { resolveLaunchConfig } from '../launch-config'
import type { LaunchConfigInput } from '../launch-config'
import { __resetLastUsedModelForTesting } from '../../composer/last-used-model'
import { __resetModelThinkingMemoryForTesting } from '../../composer/model-thinking-memory'
import type { NewTaskFlowDeps } from '../ports'
import type { LaunchConfigPort } from '../flow'

/** makeDeps 的覆盖参数：ports 支持部分覆盖 + U2b 扩展端口 launchConfig。 */
type FlowDepsOverrides = Partial<Omit<NewTaskFlowDeps, 'ports'>> & {
  ports?: Partial<NewTaskFlowDeps['ports']> & { launchConfig?: LaunchConfigPort }
}

/** 构造 mock 端口集（每个测试独立实例，断言 per-test）。launchConfig 端口默认不注入（回落 core 单例基座路径）。 */
function makeDeps(overrides?: FlowDepsOverrides): NewTaskFlowDeps {
  const deps: NewTaskFlowDeps = {
    ports: {
      createSessionFlow: {
        createSession: vi.fn(),
      },
      chat: {
        send: vi.fn(),
        sendBash: vi.fn(),
      },
      navigation: {
        activePanelId: vi.fn(() => 'p1'),
        loadPanel: vi.fn(),
        clearActiveSession: vi.fn(),
        setActiveSession: vi.fn(),
        pushChat: vi.fn(),
        defaultCwd: vi.fn(() => '/default'),
      },
      toast: { error: vi.fn(), warning: vi.fn() },
      fileTree: { loadTree: vi.fn(), selectFile: vi.fn() },
      t: vi.fn((key: string) => key),
      migrateImage: { migrateImage: vi.fn() },
    },
    gitApi: {
      checkout: vi.fn(),
      checkoutByCwd: vi.fn(),
      createBranch: vi.fn(),
    },
    directoryPicker: { pickDirectory: vi.fn() },
    workspaceApi: {
      detect: vi.fn().mockResolvedValue({ mode: 'not-repo' }),
      listWorktrees: vi.fn().mockResolvedValue({ items: [] }),
    },
    workspaceState: {
      defaultCwd: vi.fn(() => '/default'),
      record: vi.fn(),
    },
  }
  if (overrides) {
    // 浅合并 ports 子对象（测试覆盖个别方法；launchConfig 为 U2b 扩展端口，运行时随合并带入）
    if (overrides.ports) {
      deps.ports = { ...deps.ports, ...overrides.ports } as NewTaskFlowDeps['ports']
    }
    if (overrides.gitApi) deps.gitApi = { ...deps.gitApi, ...overrides.gitApi }
    if (overrides.directoryPicker) deps.directoryPicker = { ...deps.directoryPicker, ...overrides.directoryPicker }
    if (overrides.workspaceApi) deps.workspaceApi = { ...deps.workspaceApi, ...overrides.workspaceApi }
    if (overrides.workspaceState) deps.workspaceState = { ...deps.workspaceState, ...overrides.workspaceState }
  }
  return deps
}

// ── launch-config fixture（对齐 launch-config.test.ts 同款形态）─────────

function makePreset(p: Partial<PiLaunchPreset> = {}): PiLaunchPreset {
  return {
    id: 'custom-1',
    name: 'Custom',
    builtin: false,
    order: 10,
    toolMode: 'all',
    extensionMode: 'all',
    ...p,
  }
}

function makeProvider(p: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'prov-a' as ProviderId,
    name: 'Provider A',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [{ id: 'model-x', supportedLevels: ['off', 'low', 'high'] }],
    ...p,
  }
}

/** 微任务排空（P5② 窗口断言：ensureReady 未完成时 create 不发生） */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

const textSeg = (text: string): Segment => ({ type: 'text', text })
const imageSeg = (path: string, needsMigrate = true): Segment => ({
  type: 'image',
  id: `img-${path}`,
  path,
  fileName: 'a.png',
  displayName: 'a.png',
  needsMigrate,
})
const mockSession = {
  id: 's1',
  cwd: '/tmp/x',
  modelId: 'provider/model',
  label: 'hello',
  createdAt: 0,
  updatedAt: 0,
} as unknown as SessionSummary

/** 进 landing（startFlow 是主链路前置） */
async function enterLanding(flow: ReturnType<typeof useNewTaskFlow>): Promise<void> {
  await flow.startFlow()
}

describe('useNewTaskFlow', () => {
  beforeEach(() => {
    resetNewTaskFlow()
    // KV 单例隔离：submit 路径 ensureLaunchDataReady 会触发 loadOnce（node 环境
    // platform 未注入 → E1/E4 收敛到 loaded），reset 防跨用例状态泄漏
    __resetLastUsedModelForTesting()
    __resetModelThinkingMemoryForTesting()
  })

  it('TC-4: startFlow 不变量——landing 态 activeId 清空 + panel 解绑 + presetCwd 回灌', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await flow.startFlow('preset-cwd')

    expect(deps.ports.navigation.clearActiveSession).toHaveBeenCalled()
    expect(deps.ports.navigation.loadPanel).toHaveBeenCalledWith('p1', null)
    expect(useNewTaskFlowState().pendingCwd.value).toBe('preset-cwd')
    expect(useNewTaskFlowState().currentSession.value).toBeNull()
    expect(useNewTaskFlowState().state.value).toBe('landing')
  })

  it('TC-4b: startFlow 幂等——landing 再 startFlow 不抛、不重复翻 state', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await flow.startFlow()
    const clearCalls = (deps.ports.navigation.clearActiveSession as ReturnType<typeof vi.fn>).mock.calls.length
    await flow.startFlow() // landing→landing 非法，幂等分支不 transition
    expect(useNewTaskFlowState().state.value).toBe('landing')
    expect((deps.ports.navigation.clearActiveSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(clearCalls + 1)
  })

  it('TC-4c: startFlow completed 终态重建（transitionUnchecked 回 idle 再进 landing）', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    // 直接置 completed（模拟已提交过）
    ;(useNewTaskFlowState().state as { value: string }).value = 'completed'
    await flow.startFlow()
    expect(useNewTaskFlowState().state.value).toBe('landing')
  })

  it('TC-5: submit 在数据源就绪后 create 入参 = 加载后 resolve 输出（P5② 窗口语义）+ C-W4-3 已删不补 apply', async () => {
    // 门闩：ensureReady 完成前 preset store 是占位空表（默认预设不可解析），完成后注入
    // 终值数据——若 submit 未 await 就 resolve，create 入参会固化加载前占位解析值
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    let presetsLoaded = false
    // 占位/终值两态数据：加载后默认预设 p-default 生效（modelOverride 压过 lastUsed 档）
    const loadedInput = (): LaunchConfigInput => ({
      presets: presetsLoaded
        ? [makePreset({ id: 'p-default', name: '默认预设', modelOverride: 'prov-a/model-preset' })]
        : [],
      defaultPresetId: 'p-default',
      lastUsedModel: 'prov-a/model-x',
      providers: [makeProvider()],
    })
    const deps = makeDeps({
      ports: {
        launchConfig: {
          getInput: () => loadedInput(),
          ensureReady: () => gate.then(() => {
            presetsLoaded = true
          }),
        },
      },
    })
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    const migratedSegments = [textSeg('hello')]
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: mockSession,
      migratedSegments,
    })

    const pending = flow.submitFirstMessage([textSeg('hello')], 'high')
    // P5② 窗口断言：ensureReady 未完成 → create 不发生（加载窗口内的占位值不固化进新 session）
    await flushMicrotasks()
    expect(deps.ports.createSessionFlow.createSession).not.toHaveBeenCalled()
    openGate()
    await pending

    // 等价断言本体：create 入参 = 加载后 resolve 输出（同一 resolveLaunchConfig 计算期望值）
    const expected = resolveLaunchConfig({
      ...loadedInput(),
      pendingModel: null,
      pendingPreset: null,
      pendingCwd: null,
      pendingThinkingLevel: 'high',
    })
    // 加载后数据真正生效（防断言空转：非出厂默认预设透传 = D3，preset 模型压过 lastUsed = D2）
    expect(expected.presetId).toBe('p-default')
    expect(expected.model).toBe('prov-a/model-preset')
    expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith({
      cwd: null,
      presetId: expected.presetId ?? null,
      pendingModel: expected.model || null,
      segments: [textSeg('hello')],
      bashCommand: null,
      pendingThinkingLevel: expected.thinkingLevel,
    })
    // 主链路不变：载入 panel + activeId + 导航 + 文件树 + send(migratedSegments) + completed
    expect(deps.ports.navigation.setActiveSession).toHaveBeenCalledWith('s1')
    expect(deps.ports.navigation.loadPanel).toHaveBeenCalledWith('p1', 's1')
    expect(deps.ports.navigation.pushChat).toHaveBeenCalledWith('s1')
    expect(deps.ports.fileTree.loadTree).toHaveBeenCalledWith('s1')
    expect(deps.ports.chat.send).toHaveBeenCalledWith('s1', migratedSegments)
    expect(deps.ports.chat.sendBash).not.toHaveBeenCalled()
    expect(useNewTaskFlowState().state.value).toBe('completed')
  })

  it('TC-5b: launchConfig 端口未注入 → 回落 core 单例基座（preset 档不可达，explicit 档仍生效）', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: mockSession,
      migratedSegments: [textSeg('hello')],
    })

    // 不传 thinkingLevel（无 authored 档）：resolve 落最高可用档兜底
    await flow.submitFirstMessage([textSeg('hello')])

    // 无壳数据源：无 explicit / 无 preset / KV 空（beforeEach reset）→ model 全链空 '' 不上线
    // （null → wire undefined → runtime 全局默认），thinking 落最高可用档（无能力表归一默认五档 → high）
    expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith({
      cwd: null,
      presetId: null,
      pendingModel: null,
      segments: [textSeg('hello')],
      bashCommand: null,
      pendingThinkingLevel: 'high',
    })
  })

  it('TC-5c: ensureReady reject → E1/E4 收敛不阻塞发送（create 仍执行）', async () => {
    const deps = makeDeps({
      ports: {
        launchConfig: {
          getInput: () => ({}),
          ensureReady: () => Promise.reject(new Error('preset rpc down')),
        },
      },
    })
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: mockSession,
      migratedSegments: [textSeg('hello')],
    })

    // 加载失败回落默认继续（不 reject 不阻塞发送）
    await flow.submitFirstMessage([textSeg('hello')])
    expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledTimes(1)
    expect(deps.ports.chat.send).toHaveBeenCalledTimes(1)
  })

  it('TC-6a: bash 分支——bashCommand 传入走 sendBash + createSessionFlow 收 bashCommand', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    const migratedSegments = [textSeg('')]
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: mockSession,
      migratedSegments,
    })

    await flow.submitFirstMessage([textSeg('ls')], undefined, { command: 'ls', excludeFromContext: true })

    // thinkingLevel 未传（无 authored 档）→ D5 恒传 resolve 终值：落最高可用档（无数据源归一
    // 默认五档 → high），不再透传 null（快照化后 create 即带正确等级）
    expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith({
      cwd: null,
      presetId: null,
      pendingModel: null,
      segments: [textSeg('ls')],
      bashCommand: { command: 'ls', excludeFromContext: true },
      pendingThinkingLevel: 'high',
    })
    expect(deps.ports.chat.sendBash).toHaveBeenCalledWith('s1', 'ls', true)
    expect(deps.ports.chat.send).not.toHaveBeenCalled()
  })

  it('TC-6b: createSessionFlow 返回 null（空 content guard）→ abort send', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    await flow.submitFirstMessage([textSeg('hello')])

    expect(deps.ports.chat.send).not.toHaveBeenCalled()
    expect(useNewTaskFlowState().state.value).toBe('landing') // 不变
  })

  it('TC-6c: 非 landing 态 submitFirstMessage 抛错', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    // 未进 landing（state=idle）
    await expect(flow.submitFirstMessage([textSeg('hello')])).rejects.toThrow('非 landing 态')
  })

  it('TC-6d: createInFlight 守卫——飞行中重复 submitFirstMessage 幂等返回（端口零调用）', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    // 模拟飞行中：直接经 controller setCreateInFlight(true)（模块级 ref）
    useNewTaskFlowController_setCreateInFlight(true)

    await flow.submitFirstMessage([textSeg('hello')])

    expect(deps.ports.createSessionFlow.createSession).not.toHaveBeenCalled()
    expect(deps.ports.chat.send).not.toHaveBeenCalled()
    useNewTaskFlowController_setCreateInFlight(false)
  })

  it('TC-6e: send reject → 交接点已定格 completed + createInFlight 清理（D3 交接原子化探针）', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: mockSession,
      migratedSegments: [textSeg('hello')],
    })
    // 探针（设计 §3.3 D3）：真实 useChat.send 内部吞错（W2 策略，不 throw），
    // mock 层面直接返回 rejected promise 锁定语义——flow 终态与 send 成败解耦，
    // 交接（setActiveSession + loadPanel + pushChat）完成即 completed，send 链路
    // 未来任何演化（恢复 throw、新增前置抛错点）都不影响 flow 终态
    ;(deps.ports.chat.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('send failed'))

    // submitFirstMessage 对 send 的 await 未吞错，reject 向上抛
    await expect(flow.submitFirstMessage([textSeg('hello')])).rejects.toThrow('send failed')

    // 交接已完成且 transition('completed') 在 send 之前执行（若仍在 send 后，
    // send reject 会让 state 卡 landing——此断言即探针本体）
    expect(deps.ports.navigation.setActiveSession).toHaveBeenCalledWith('s1')
    expect(deps.ports.navigation.pushChat).toHaveBeenCalledWith('s1')
    expect(deps.ports.chat.send).toHaveBeenCalledTimes(1)
    expect(useNewTaskFlowState().state.value).toBe('completed')
    // finally 语义：异常路径 createInFlight 也必须清理
    expect(flow.isInflight.value).toBe(false)
  })

  it('TC-7: retry 分支——session 已绑定走 migrateImage 迁移 + 部分失败 toast 不阻断', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    // 绑定已有 session（重试场景）——经真实 controller 写模块级 ref（currentSession 只读视图不可直写）
    bindSession(mockSession)
    const imgSeg = imageSeg('/tmp/a.png', true)
    // 迁移成功 1 个
    ;(deps.ports.migrateImage.migrateImage as ReturnType<typeof vi.fn>).mockResolvedValue({ path: '/attachments/s1/a.png' })

    await flow.submitFirstMessage([imgSeg])

    expect(deps.ports.createSessionFlow.createSession).not.toHaveBeenCalled() // 不重复 create
    expect(deps.ports.migrateImage.migrateImage).toHaveBeenCalledWith({
      fromPath: '/tmp/a.png',
      sessionId: 's1',
      fileName: 'a.png',
    })
    // send 用迁移后的段（path 更新 + needsMigrate=false）
    expect(deps.ports.chat.send).toHaveBeenCalledWith('s1', [
      expect.objectContaining({ type: 'image', path: '/attachments/s1/a.png', needsMigrate: false }),
    ])
    // 全部迁移成功 → 无 warning toast
    expect(deps.ports.toast.warning).not.toHaveBeenCalled()
  })

  it('TC-7b: retry 分支部分迁移失败 → toastWarning + send 仍执行', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    bindSession(mockSession)
    const imgA = imageSeg('/tmp/a.png', true)
    const imgB = imageSeg('/tmp/b.png', true)
    // a 成功、b 失败
    ;(deps.ports.migrateImage.migrateImage as ReturnType<typeof vi.fn>).mockImplementation((p: { fromPath: string }) =>
      p.fromPath === '/tmp/a.png' ? Promise.resolve({ path: '/attachments/s1/a.png' }) : Promise.reject(new Error('gone')),
    )

    await flow.submitFirstMessage([imgA, imgB])

    // t 收到 key + count 参数（i18n 解析在壳侧，mock 直接返回 key）
    expect(deps.ports.t).toHaveBeenCalledWith('composable.imageMigratePartialFailed', { count: 1 })
    expect(deps.ports.toast.warning).toHaveBeenCalledTimes(1)
    // send 仍执行（b 段 path 保留原样）
    expect(deps.ports.chat.send).toHaveBeenCalledTimes(1)
  })

  it('TC-8: closeOverlay 幂等——landing 态 noop 不抛、overlay 态归 landing', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    // landing 态 closeOverlay → noop（不抛、state 不变）
    flow.closeOverlay()
    expect(useNewTaskFlowState().state.value).toBe('landing')
    // overlay 态 closeOverlay → 归 landing
    flow.openDirPopover()
    expect(useNewTaskFlowState().state.value).toBe('dir-popover')
    flow.closeOverlay()
    expect(useNewTaskFlowState().state.value).toBe('landing')
  })

  it('TC-8b: 薄转换封装——cancelFlow/reenterFlow/completeFlow', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    flow.cancelFlow()
    expect(useNewTaskFlowState().state.value).toBe('cancelled')
    flow.reenterFlow()
    expect(useNewTaskFlowState().state.value).toBe('landing')
    flow.completeFlow()
    expect(useNewTaskFlowState().state.value).toBe('completed')
  })

  it('presetCwd/setPendingModel/setPendingPreset——仅 landing 态生效', async () => {
    const deps = makeDeps({
      ports: {
        // preset 数据经 launchConfig 端口注入（D1）：显式选定的 preset-1 需在列表内可解析才透传
        launchConfig: {
          getInput: () => ({ presets: [makePreset({ id: 'preset-1' })] }),
          ensureReady: async () => {},
        },
      },
    })
    const flow = useNewTaskFlow(deps)
    // 非 landing（idle）→ noop
    flow.setPendingModel('p/m')
    expect(useNewTaskFlowState().pendingModel.value).toBeNull()
    await enterLanding(flow)
    flow.presetCwd('/preset')
    expect(useNewTaskFlowState().pendingCwd.value).toBe('/preset')
    flow.setPendingModel('p/m')
    expect(useNewTaskFlowState().pendingModel.value).toBe('p/m')
    flow.setPendingPreset('preset-1')
    // 通过 submitFirstMessage 的 createSessionFlow input 验证 resolve 终值透传
    // （pendingModel/pendingPreset 作 explicit 输入 → resolve 输出原样透传）
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: mockSession,
      migratedSegments: [textSeg('hello')],
    })
    await flow.submitFirstMessage([textSeg('hello')])
    expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: 'preset-1', cwd: '/preset', pendingModel: 'p/m' }),
    )
  })

  it('preset-popover 打开时 setPendingPreset 成功写入——模式选择在 overlay 内完成，不阻断透传', async () => {
    // [HISTORICAL] 缺陷回归：用户在 landing 点 PresetSelectChip 展开模式 popover（state 进
    // preset-popover），再点列表项时守卫 `state !== 'landing'` 把真实选择静默丢弃——
    // pendingPreset 恒 null → chip 文案不回显（props.modeName 源自 pendingPreset）、
    // 建出的 session launchPresetId=undefined。本用例复现「点击时的真实态 = preset-popover」。
    const deps = makeDeps({
      ports: {
        launchConfig: {
          getInput: () => ({ presets: [makePreset({ id: 'builtin:session-dispatch' })] }),
          ensureReady: async () => {},
        },
      },
    })
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    // 点 chip 展开模式 popover（openPresetPopover 是 Landing 的 isPresetOpen setter 调用点）
    flow.openPresetPopover()
    expect(useNewTaskFlowState().state.value).toBe('preset-popover')
    // 用户点列表项 → Landing.onPresetSelect → setPendingPreset（此时 state 是 preset-popover）
    flow.setPendingPreset('builtin:session-dispatch')
    // 修复前：pendingPreset 恒 null（chip 显示 / submit 透传双链断裂）
    expect(flow.pendingPreset.value).toBe('builtin:session-dispatch')
    // 关闭 popover 回 landing（用户点空白/Esc 关）后提交：透传所选模式（显示 ≡ 生效）
    flow.closeOverlay()
    expect(useNewTaskFlowState().state.value).toBe('landing')
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: mockSession,
      migratedSegments: [textSeg('hello')],
    })
    await flow.submitFirstMessage([textSeg('hello')])
    expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: 'builtin:session-dispatch' }),
    )
  })
})

/** 测试辅助：直置模块级 createInFlight ref（controller 的 setCreateInFlight 语义） */
import { useNewTaskFlowController } from '../flow-state'
function useNewTaskFlowController_setCreateInFlight(v: boolean): void {
  useNewTaskFlowController().setCreateInFlight(v)
}

/** 测试辅助：绑定 session（真实 controller 写模块级 ref） */
function bindSession(s: SessionSummary): void {
  useNewTaskFlowController().bindCurrentSession(s)
}
