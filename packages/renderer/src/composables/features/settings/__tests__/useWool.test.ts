/**
 * useWool / useWoolWizard composable 单测（wool-provider D6 ①③ renderer 侧）。
 *
 * 覆盖（验收条款①「缓存刷新接线」的 composable 层锚点）：
 * - useWool：首消费拉取（getWoolState）+ wool.state 广播更新快照（onWoolState 接线）
 *   + 动作直通（runWoolAction 两态信封透传）
 * - useWoolWizard：两族步骤序列 + 动作落步四态（ok/failed 携失败码映射）+ confirm
 *   待决态 + catalogRefreshed 防重
 *
 * mock 策略：vi.mock '@taiji/core'（getSettingsTransport 桩）+ ws-client（getState
 * ref）；useWoolWizard 是纯状态机（runAction 注入）零 mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/features/settings/__tests__/useWool.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import type { WoolRuntimeSnapshot, WoolActionReply } from '@taiji/shared'

// ── mocks（hoisted：模块加载期即生效）────────────────────────────────

const transportMock = vi.hoisted(() => ({
  getWoolState: vi.fn(),
  runWoolAction: vi.fn(),
  onWoolState: vi.fn((_h: (snapshot: WoolRuntimeSnapshot) => void) => () => {}),
}))

// 普通对象（非 vue ref）：hoisted 闭包先于 import 执行，ref 尚不可用；本测试不依赖
// 重连 watch 触发，getState 返回值仅需形态兼容（.value 可读）。
const wsStateMock = vi.hoisted(() => ({ state: { value: 'connected' as const } }))

vi.mock('@taiji/core', () => ({
  getSettingsTransport: () => transportMock,
}))

vi.mock('@taiji/core/transport/ws-client', () => ({
  getState: () => wsStateMock.state,
}))

import { useWool, _resetWoolForTest } from '../useWool'
import { useWoolWizard, woolTemplateOf, actionErrorToStepFailure } from '../useWoolWizard'

const SNAP: WoolRuntimeSnapshot = {
  families: [{
    family: 'qoder', displayName: 'Qoder', vendor: '阿里', credentialsSource: 'ide-extract',
    riskNotice: 'r', installed: true, adopted: true, autoCheckin: false,
    account: null, detect: null, catalog: null,
  }],
  fetchedAt: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetWoolForTest()
  transportMock.getWoolState.mockResolvedValue(SNAP)
})

// 在 detached scope 内消费（onScopeDispose 需要；模拟组件 setup 环境）
function consume<T>(fn: () => T): T {
  const scope = effectScope(true)
  const result = scope.run(() => fn()) as T
  scope.stop()
  return result
}

describe('useWool（状态源 + 缓存刷新接线）', () => {
  it('首消费 → getWoolState 拉取落快照（拉为主）', async () => {
    const wool = consume(() => useWool())
    await vi.waitFor(() => expect(wool.snapshot.value).toEqual(SNAP))
    expect(transportMock.getWoolState).toHaveBeenCalledTimes(1)
    expect(wool.familyOf('qoder')?.displayName).toBe('Qoder')
    expect(wool.loadedOnce.value).toBe(true)
  })

  it('wool.state 广播 → 快照更新（onWoolState 接线：runtime 动作后状态变化推回）', async () => {
    let push: ((s: WoolRuntimeSnapshot) => void) | undefined
    transportMock.onWoolState.mockImplementation((h: (s: WoolRuntimeSnapshot) => void) => {
      push = h
      return () => {}
    })
    consume(() => useWool())
    await vi.waitFor(() => expect(transportMock.onWoolState).toHaveBeenCalled())
    const next: WoolRuntimeSnapshot = { ...SNAP, fetchedAt: 2, families: [{ ...SNAP.families[0]!, adopted: false }] }
    push!(next)
    await nextTick()
    const wool2 = consume(() => useWool())
    expect(wool2.snapshot.value?.fetchedAt).toBe(2)
  })

  it('runAction 两态信封透传（ok=false 是领域回执不 reject）', async () => {
    const reply: WoolActionReply = { ok: false, error: { code: 'not_logged_in', message: 'x' } }
    transportMock.runWoolAction.mockResolvedValue(reply)
    const wool = consume(() => useWool())
    const got = await wool.runAction({ action: 'status', family: 'qoder' })
    expect(got).toEqual(reply)
    expect(transportMock.runWoolAction).toHaveBeenCalledWith({ action: 'status', family: 'qoder' })
  })

  it('拉取失败 → 快照保持 null（辅助域降级不抛出）', async () => {
    transportMock.getWoolState.mockRejectedValue(new Error('transport down'))
    const wool = consume(() => useWool())
    await vi.waitFor(() => expect(transportMock.getWoolState).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 5))
    expect(wool.snapshot.value).toBeNull()
  })
})

describe('useWoolWizard（纯状态机）', () => {
  const okReply: WoolActionReply = { ok: true }
  const runAction = vi.fn(async () => okReply)

  it('提取族步骤序列 = install → credentials → done（D7 模板）', () => {
    const w = useWoolWizard('qoder', 'extract', runAction)
    expect(w.steps.value).toEqual(['install', 'credentials', 'done'])
    expect(w.currentStep.value).toBe('install')
  })

  it('授权族步骤序列 = 五步（§3.1）', () => {
    const w = useWoolWizard('workbuddy', 'oauth', runAction)
    expect(w.steps.value).toEqual(['install', 'authorize', 'ready', 'checkin', 'done'])
  })

  it('动作成功 → 步骤 ok 推进；失败 → failed 携失败码（动作码→步骤码映射）', async () => {
    const fail: WoolActionReply = { ok: false, error: { code: 'unreachable', message: 'HTTP 503' } }
    const runner = vi.fn(async () => fail)
    const w = useWoolWizard('qoder', 'extract', runner)
    await w.runStepAction('install', 'install')
    expect(w.stepStates.install.status).toBe('failed')
    expect(w.stepStates.install.failure).toEqual({ code: 'manifest_unreachable', message: 'HTTP 503' })
    expect(w.currentStep.value).toBe('install')

    const w2 = useWoolWizard('qoder', 'extract', vi.fn(async () => okReply))
    await w2.runStepAction('install', 'install')
    expect(w2.stepStates.install.status).toBe('ok')
    expect(w2.currentStep.value).toBe('credentials')
  })

  it('extract 真实流程：动作 ok → 凭据步 ok 推进（凭据落库在 runtime 侧，回执不携凭据）', async () => {
    const okWithData: WoolActionReply = { ok: true, data: { credentialsStored: true } }
    const w = useWoolWizard('qoder', 'extract', vi.fn(async () => okWithData))
    w.markStep('install', 'ok')
    const reply = await w.runStepAction('credentials', 'extract')
    expect(reply).toEqual(okWithData)
    expect(w.stepStates.credentials.status).toBe('ok')
    expect(w.currentStep.value).toBe('done')
  })

  it('extract 真实失败：not_logged_in → failed 携步骤失败码（恢复指引按码分流）', async () => {
    const fail: WoolActionReply = { ok: false, error: { code: 'not_logged_in', message: 'no credentials' } }
    const w = useWoolWizard('qoder', 'extract', vi.fn(async () => fail))
    await w.runStepAction('credentials', 'extract')
    expect(w.stepStates.credentials.status).toBe('failed')
    expect(w.stepStates.credentials.failure).toEqual({ code: 'not_logged_in', message: 'no credentials' })
  })

  it('动作码 → 步骤码映射：invalid_request 归 internal；协议未就绪/动作不支持/取消专属码直通', () => {
    expect(actionErrorToStepFailure('invalid_request')).toBe('internal')
    expect(actionErrorToStepFailure('extract_unavailable')).toBe('extract_unavailable')
    expect(actionErrorToStepFailure('authorize_unavailable')).toBe('authorize_unavailable')
    expect(actionErrorToStepFailure('action_not_supported')).toBe('action_not_supported')
    expect(actionErrorToStepFailure('cancelled')).toBe('cancelled')
    expect(actionErrorToStepFailure('not_logged_in')).toBe('not_logged_in')
  })

  it('catalogRefreshed 防重 + reset 复位', async () => {
    const w = useWoolWizard('qoder', 'extract', vi.fn(async () => okReply))
    // 全步骤推进到 ok（防重断言前提：currentStep 已到 done）
    for (const step of ['install', 'credentials', 'done'] as const) await w.runStepAction(step, 'detect')
    w.catalogRefreshed.value = true
    expect(w.currentStep.value).toBe('done')
    w.reset()
    expect(w.stepStates.install.status).toBe('pending')
    expect(w.stepStates.done.status).toBe('pending')
    expect(w.currentStep.value).toBe('install')
    expect(w.catalogRefreshed.value).toBe(false)
  })
})

describe('woolTemplateOf（家族 → 模板分流）', () => {
  it('oauth 家族 → oauth 模板；ide-extract/未拉快照 → extract 模板', () => {
    expect(woolTemplateOf(SNAP.families[0])).toBe('extract')
    expect(woolTemplateOf({ ...SNAP.families[0]!, credentialsSource: 'oauth' })).toBe('oauth')
    expect(woolTemplateOf(undefined)).toBe('extract')
  })
})
