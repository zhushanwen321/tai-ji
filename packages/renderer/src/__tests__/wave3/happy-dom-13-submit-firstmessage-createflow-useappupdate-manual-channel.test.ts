import { markdownStubModule } from '@/__tests__/helpers/app-update-markdown-stub';
import { ipc, controller, setupAppUpdateLifecycle, type AppUpdateControllerInternal } from '@/__tests__/helpers/app-update-mount';
import { session as sessionApi } from '@/api';
import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow';
import { createSessionFlow, transition, useNewTaskFlowController } from '@taiji/core';
import { textToSegments, type SessionSummary, type LatestReleaseInfo, type UpdateInstallResult } from '@taiji/shared';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { effectScope } from 'vue';

// wave3 簇 [renderer/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/composables/submit-firstmessage-createflow.test.ts
 * - __tests__/composables/useAppUpdate.manual-channel.test.ts
 */

// ======================================================================
// ← __tests__/composables/submit-firstmessage-createflow.test.ts
// ======================================================================

// mock core.createSessionFlow（被测对象：壳改调此原语，断言调/不调 + 消费返回形状）
vi.mock('@taiji/core', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core')>()
  return {
    ...actual,
    createSessionFlow: vi.fn(),
  }
})

// session api 门面（createSessionFlow ctx.api 注入用，但壳内 buildSessionApiPort 代理这些）
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  create: vi.fn(),
  removeByCwd: vi.fn(),
  migrateImage: vi.fn(),
  writeSegments: vi.fn(),
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getSubagents: vi.fn().mockResolvedValue([]),
  getWorkflows: vi.fn().mockResolvedValue([]),
  getAgentCallHistory: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})
vi.mock('@taiji/core/transport/api', () => ({
  on: vi.fn(() => () => {}),
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))
vi.mock('@taiji/core/transport/api/domains/file', () => ({ tree: vi.fn().mockResolvedValue({}) }))
vi.mock('@taiji/core/transport/api/domains/git', () => ({ status: vi.fn().mockResolvedValue({}) }))

// useChat：stub send/sendBash 为 spy，断言调/不调 + 参数
const sendMock = vi.fn().mockResolvedValue(undefined)
const sendBashMock = vi.fn().mockResolvedValue(undefined)
const setThinkingLevelMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: vi.fn(() => ({
    send: sendMock,
    sendBash: sendBashMock,
    disposeSession: vi.fn(),
    touchLru: vi.fn(),
    evictIfNeeded: vi.fn(),
  })),
  ensureStreamSubscription: vi.fn(),
}))
// useModel：setThinkingLevel spy（C-W4-3 留壳 apply）
vi.mock('@/composables/features/model/useModel', () => ({
  useModel: vi.fn(() => ({ switchModel: vi.fn().mockResolvedValue(undefined), setThinkingLevel: setThinkingLevelMock })),
}))
vi.mock('@/composables/features/file-tree/useFileTree', () => ({ useFileTree: vi.fn(() => ({ loadTree: vi.fn() })) }))

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 'ns', label: 'L', cwd: '/x', status: 'idle', lastActiveAt: 1, ...over }
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  vi.clearAllMocks()
})

describe('submitFirstMessage 改调 createSessionFlow（TC-5 / FU-1）', () => {
  it('null 分支（空 content guard）→ abort：不 create 不 send，直接 return', async () => {
    vi.mocked(createSessionFlow).mockResolvedValue(null)
    const flow = useNewTaskFlow()
    await flow.startFlow()
    // segments 非空但 createSessionFlow 返回 null（模拟 core guard 命中）
    await flow.submitFirstMessage(textToSegments('hi'))
    expect(createSessionFlow).toHaveBeenCalledTimes(1)
    expect(sendMock).not.toHaveBeenCalled()
    expect(setThinkingLevelMock).not.toHaveBeenCalled()
  })

  it('非 null 分支→ create 快照化透传 resolve 终值 + send(migratedSegments)', async () => {
    const migrated = [{ type: 'text' as const, text: 'hi' }]
    vi.mocked(createSessionFlow).mockResolvedValue({
      session: summary({ id: 'ns' }),
      migratedSegments: migrated,
    })
    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('hi'), 'high')
    expect(createSessionFlow).toHaveBeenCalledTimes(1)
    // [D5] thinkingLevel 经 create 入参一次到位（explicit authored 'high' → resolve 终值 'high'）；
    // U2d 已接 ports.launchConfig，本测试 mock 面下基座数据全空（preset 列表空 + settings
    // 空）→ model 全链空 null、presetId null。
    // mock 的是 core createSessionFlow(ctx, input) 原函数——终值断言定位第二参 input
    expect(createSessionFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pendingThinkingLevel: 'high', pendingModel: null, presetId: null }),
    )
    // [D5] C-W4-3 已删：post-create setThinkingLevel 补 apply 恒不调
    expect(setThinkingLevelMock).not.toHaveBeenCalled()
    // send 用 result.migratedSegments（createSessionFlow 返回的迁移后段）
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('ns', migrated)
  })

  it('retry 分支（currentSession 已绑定 + state 回 landing）→ 不调 createSessionFlow，直接 send', async () => {
    // 首次提交绑定 session（createSessionFlow 返回非 null）
    vi.mocked(createSessionFlow).mockResolvedValue({
      session: summary({ id: 'ns' }),
      migratedSegments: textToSegments('hi'),
    })
    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('hi')) // 首次→create+send
    expect(createSessionFlow).toHaveBeenCalledTimes(1)
    sendMock.mockClear()

    // 模拟 retry：send 失败后 state 回 landing（editAndResend 流程；completed 是终态无出口，
    // 测试内经 resetNewTaskFlow 回 idle 后重新 transition，等价于应用层重新 startFlow 的重建路径），
    // currentSession 仍绑定 → 再提交走 !currentSession 检查的 else 分支（不 create 直接 send）。
    resetNewTaskFlow()
    const controller = useNewTaskFlowController()
    controller.bindCurrentSession(summary({ id: 'ns' }))
    transition('landing')
    await flow.submitFirstMessage(textToSegments('again'))
    expect(createSessionFlow).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('ns', textToSegments('again'))
  })
})

describe('wave:remove-bandaids: submitFirstMessage 不再主动拉 subagent/workflow/commands（原 submit-firstmessage-pull.test.ts 并入）', () => {
  /** 预设 NewTaskFlow 到 landing 态并绑定 fake session（跳过 create 路径） */
  function setupLandingWithSession(): SessionSummary {
    const controller = useNewTaskFlowController()
    const fakeSession: SessionSummary = {
      id: 'sess-new-001',
      label: 'test',
      cwd: '/tmp',
    }
    transition('landing')
    controller.bindCurrentSession(fakeSession)
    return fakeSession
  }

  it('submitFirstMessage 不调 getSubagents（subagents 经 subscribe stateSnapshot 提供）', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()

    await flow.submitFirstMessage(textToSegments('hello'))

    expect(sessionApi.getSubagents).not.toHaveBeenCalled()
  })

  it('submitFirstMessage 不调 getWorkflows（workflows 经 streamRing workflowUpdate 增量信号→RPC 闭环）', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()

    await flow.submitFirstMessage(textToSegments('hello'))

    expect(sessionApi.getWorkflows).not.toHaveBeenCalled()
  })

  it('submitFirstMessage 不调 getCommands（commands 经 subscribe stateSnapshot 提供）', async () => {
    setupLandingWithSession()
    const flow = useNewTaskFlow()

    await flow.submitFirstMessage(textToSegments('hello'))

    expect(sessionApi.getCommands).not.toHaveBeenCalled()
  })
})

// ======================================================================
// ← __tests__/composables/useAppUpdate.manual-channel.test.ts
// ======================================================================

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('@taiji/ui/features/chat/markdown', () => markdownStubModule())

// mock t 返回 key：追加段断言 key 本身（真实文案断言在 update-manual-channel.test.ts）
vi.mock('@/i18n', () => ({
  getLocale: vi.fn(() => 'zh-CN'),
  default: { global: { t: (key: string) => key } },
}))

setupAppUpdateLifecycle({ markdownHtml: '<p>test</p>' })

beforeEach(() => {
  vi.clearAllMocks()
})

/** 在独立 effectScope 内执行用例体（subscribeProgress/onScopeDispose 需活跃 scope），完跑统一 stop */
async function inUpdateScope(body: (controller: AppUpdateControllerInternal) => Promise<void>): Promise<void> {
  const scope = effectScope()
  await scope.run(() => body(controller))
  scope.stop()
}

/** 构造带完整字段的 release（断言「其他字段保留」用；notes/url 与族级 fixture 不同，留本文件） */
function makeRelease(version: string): LatestReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: `notes for ${version}`,
    publishedAt: '2026-08-30T00:00:00Z',
    htmlUrl: `https://github.com/zhushanwen321/tai-ji/releases/tag/v${version}`,
    assets: {},
  }
}

/** D2 公共断言：latestRelease 显示 version、htmlUrl 指向 urlVersion（对齐后其他字段保留的读回核对） */
function expectReleaseShown(state: AppUpdateControllerInternal['state'], version: string, urlVersion: string): void {
  expect(state.latestRelease?.version).toBe(version)
  expect(state.latestRelease?.htmlUrl).toContain(`v${urlVersion}`)
}

/**
 * D2 公共执行体：mock updateInstall 返回 installResult → 认领 0.9.11 → 执行安装 →
 * 断言终态 restarting 与版本显示（url 指向认领版：对齐只覆 version/url，其余字段不动）；
 * then 在 scope 内追加断言（交错场景「其他字段保留」的读回核对）。
 */
async function installClaimedRelease(
  installResult: UpdateInstallResult,
  shownVersion: string,
  then?: (state: AppUpdateControllerInternal['state']) => void,
): Promise<void> {
  ipc.updateInstall.mockResolvedValue(installResult)
  await inUpdateScope(async ({ state, performInstall }) => {
    state.latestRelease = makeRelease('0.9.11')
    await performInstall()
    expect(state.state).toBe('restarting')
    expectReleaseShown(state, shownVersion, '0.9.11')
    then?.(state)
  })
}

describe('D9 suggestion 追加手动下载指引', () => {
  it.each([
    'UPDATE_PROXY_UNREACHABLE',
    'UPDATE_PROXY_ERROR',
    'UPDATE_NETWORK_FAILED',
    'UPDATE_NETWORK_TIMEOUT',
  ])(
    '%s → errorSuggestion 末尾追加手动下载指引',
    async (code) => {
      await inUpdateScope(async (c) => {
        c.subscribeProgress()
        const { state } = c
        ipc.fireError({
          stage: 'downloading',
          message: '下载失败',
          errorCode: code,
          suggestion: '基础恢复指引',
        })
        expect(state.state).toBe('error')
        expect(state.errorSuggestion).toBe('基础恢复指引\nsidebar.update.manualDownloadHint')
      })
    },
  )

  it('网络类错误无 suggestion → errorSuggestion 仅含手动下载指引（无前导换行）', async () => {
    await inUpdateScope(async (c) => {
      c.subscribeProgress()
      const { state } = c
      ipc.fireError({ stage: 'downloading', message: '下载失败', errorCode: 'UPDATE_NETWORK_TIMEOUT' })
      expect(state.errorSuggestion).toBe('sidebar.update.manualDownloadHint')
    })
  })

  it('非网络类错误码（UPDATE_INTEGRITY_FAILED）→ 不追加', async () => {
    await inUpdateScope(async (c) => {
      c.subscribeProgress()
      const { state } = c
      ipc.fireError({
        stage: 'downloading',
        message: '校验失败',
        errorCode: 'UPDATE_INTEGRITY_FAILED',
        suggestion: '重新下载更新',
      })
      expect(state.errorSuggestion).toBe('重新下载更新')
    })
  })

  it('无 errorCode → 不追加', async () => {
    await inUpdateScope(async (c) => {
      c.subscribeProgress()
      const { state } = c
      ipc.fireError({ stage: 'downloading', message: '未知错误', suggestion: '基础指引' })
      expect(state.errorSuggestion).toBe('基础指引')
    })
  })
})

describe('D2 performInstall 实装版本对齐', () => {
  it('install 返回 version ≠ latestRelease.version → 版本显示对齐且其他字段保留', async () => {
    // 实装 0.9.12 覆写显示（认领 0.9.11 → 后台预下载 0.9.12 交错场景）；
    // 其他字段保留（旧 release 的 notes，app 即将重启，生命周期以秒计）
    await installClaimedRelease({ triggerRestart: true, version: '0.9.12' }, '0.9.12', (state) => {
      expect(state.latestRelease?.releaseNotes).toBe('notes for 0.9.11')
    })
  })

  it('install 返回 version 与显示一致 → 不触发对齐（版本保持不变）', async () => {
    ipc.updateInstall.mockResolvedValue({ triggerRestart: true, version: '0.9.11' })
    await inUpdateScope(async ({ state, performInstall }) => {
      state.latestRelease = makeRelease('0.9.11')
      await performInstall()
      // reactive 读回是 proxy，引用断言不可用；版本未变即证明对齐分支未执行
      expectReleaseShown(state, '0.9.11', '0.9.11')
    })
  })

  it('install 返回无 version（读取失败容错）→ latestRelease 不动', async () => {
    await installClaimedRelease({ triggerRestart: true }, '0.9.11')
  })
})
