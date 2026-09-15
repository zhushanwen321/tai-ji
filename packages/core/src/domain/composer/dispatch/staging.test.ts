/**
 * useComposerStaging 单元测试。
 *
 * 被测对象：domain/composer/dispatch/staging.ts —— Composer Staging 策略模式的
 * 聚合 + 路由层（ADR-0057）。职责：注册表 + activeStagingType 派生 + 互斥编排 + 路由分发。
 *
 * 策略：轻量 mock StagingAction 对象（不引入真实 useComposerForkMode/useComposerHandoffMode，
 * 后者依赖 pinia/channel/i18n 过重）。每个 mock action 持有自己的 activeRef / inProgressRef
 * + 各方法 spy。测试通过「翻转 ref 验证派生」+「检查 spy 被调验证路由」两条路径覆盖。
 *
 * useComposerStaging 只依赖 vue + types（纯类型），因此：
 * - 无需 vi.mock 依赖模块。
 * - activeStagingType 派生自 isActive 的 ComputedRef（同步求值），改变 activeRef.value
 *   后立即读 activeStagingType.value 即反映新值，无需 nextTick。
 *
 * [W3 迁移] 迁自 renderer __tests__/composables/use-composer-staging.test.ts。改动：
 * - import 路径 renderer staging-types/useComposerStaging → core 相对路径 ../types + ./staging
 * - handleEsc mock 参数：new KeyboardEvent(...) → {code, key} 对象字面量（KeyboardEventLike，
 *   core 零 DOM 约束；真实 KeyboardEvent 结构兼容 KeyboardEventLike，断言语义不变）
 * 逻辑与断言 byte-level 保持。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/staging.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, effectScope, ref, type Ref } from 'vue'
import type {
  KeyboardEventLike,
  StagingAction,
  StagingConfig,
  StagingSource,
  StagingType,
} from '../types'
import { useComposerStaging } from './staging'

// ── mock StagingAction 构造器 ─────────────────────────────────────────────────
//
// 每个 mock action 自带可翻转的 activeRef / inProgressRef（驱动 isActive / isInProgress 派生）
// 与所有方法的 spy（验证路由）。默认 isInProgress=false、hasAbort=true，调用方可按场景覆写。

interface MockSpies {
  activeRef: Ref<boolean>
  inProgressRef: Ref<boolean>
  enterSpy: ReturnType<typeof vi.fn>
  exitSpy: ReturnType<typeof vi.fn>
  sendSpy: ReturnType<typeof vi.fn<(text: string, staging: StagingConfig) => Promise<void>>>
  handleEscSpy: ReturnType<typeof vi.fn<(e: KeyboardEventLike) => boolean>>
  abortSpy?: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>
}

interface MakeMockOpts {
  isInProgress?: boolean
  hasAbort?: boolean
  allowsEmptySend?: boolean
}

function makeMockAction(
  type: StagingType,
  opts?: MakeMockOpts,
): { action: StagingAction; spies: MockSpies } {
  const activeRef = ref(false)
  const inProgressRef = ref(opts?.isInProgress ?? false)
  const enterSpy = vi.fn()
  const exitSpy = vi.fn()
  const sendSpy = vi
    .fn<(text: string, staging: StagingConfig) => Promise<void>>()
    .mockResolvedValue(undefined)
  const handleEscSpy = vi.fn<(e: KeyboardEventLike) => boolean>().mockReturnValue(false)

  const spies: MockSpies = {
    activeRef,
    inProgressRef,
    enterSpy,
    exitSpy,
    sendSpy,
    handleEscSpy,
  }

  if (opts?.hasAbort !== false) {
    const abortSpy = vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined)
    spies.abortSpy = abortSpy
  }

  const action: StagingAction = {
    type,
    isActive: computed(() => activeRef.value),
    enter: enterSpy as StagingAction['enter'],
    exit: exitSpy,
    send: sendSpy,
    allowsEmptySend: opts?.allowsEmptySend ?? false,
    handleEsc: handleEscSpy,
    isInProgress: computed(() => inProgressRef.value),
    ...(spies.abortSpy ? { abort: spies.abortSpy } : {}),
    visual: {
      boxClass: computed(() => ''),
      placeholder: computed(() => null),
      chipLabelKey: type === 'fork' ? 'panel.composer.forkChip' : 'panel.composer.handoffChip',
      chipIcon: {} as never,
    },
  }

  return { action, spies }
}

/** fork + handoff 各一个 mock action，包 effectScope 起一个被测实例。返回 spies 便于断言。 */
function setup(opts?: {
  fork?: MakeMockOpts
  handoff?: MakeMockOpts
}): {
  scope: ReturnType<typeof effectScope>
  api: ReturnType<typeof useComposerStaging>
  fork: MockSpies
  handoff: MockSpies
} {
  const forkMock = makeMockAction('fork', opts?.fork)
  const handoffMock = makeMockAction('handoff', opts?.handoff)
  const scope = effectScope()
  const api = scope.run(() =>
    useComposerStaging({ fork: forkMock.action, handoff: handoffMock.action }),
  )!
  return { scope, api, fork: forkMock.spies, handoff: handoffMock.spies }
}

/** fork source（带 fromMessageId） */
function forkSource(): StagingSource {
  return { type: 'fork', srcSessionId: 's1', fromMessageId: 'm1' }
}

/** handoff source */
function handoffSource(): StagingSource {
  return { type: 'handoff', srcSessionId: 's1' }
}

/** KeyboardEventLike 工厂（替代 renderer 测试的 new KeyboardEvent，core 零 DOM） */
function keyEvent(key: string): KeyboardEventLike {
  return { code: key, key }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── activeStaging 派生 ────────────────────────────────────────────────────────
describe('activeStaging / activeStagingType 派生', () => {
  it('初始：activeStaging=null、activeStagingType=null、hasActiveStaging=false', () => {
    const { api } = setup()

    expect(api.activeStaging.value).toBeNull()
    expect(api.activeStagingType.value).toBeNull()
    expect(api.hasActiveStaging.value).toBe(false)
  })

  it('fork.isActive=true → activeStaging=fork action，activeStagingType=fork', () => {
    const { api, fork } = setup()
    fork.activeRef.value = true

    expect(api.activeStagingType.value).toBe('fork')
    expect(api.activeStaging.value).not.toBeNull()
    expect(api.activeStaging.value!.type).toBe('fork')
    expect(api.hasActiveStaging.value).toBe(true)
  })

  it('handoff.isActive=true（fork 仍 false）→ activeStaging=handoff action', () => {
    const { api, handoff } = setup()
    handoff.activeRef.value = true

    expect(api.activeStagingType.value).toBe('handoff')
    expect(api.activeStaging.value!.type).toBe('handoff')
    expect(api.hasActiveStaging.value).toBe(true)
  })

  it('fork 优先于 handoff（两者 isActive 都 true → activeStaging 是 fork，对齐 fork 优先派生）', () => {
    const { api, fork, handoff } = setup()
    fork.activeRef.value = true
    handoff.activeRef.value = true

    expect(api.activeStagingType.value).toBe('fork')
    expect(api.activeStaging.value!.type).toBe('fork')
  })

  it('isActive 翻回 false 后派生立即回 null（ComputedRef 同步求值）', () => {
    const { api, fork } = setup()
    fork.activeRef.value = true
    expect(api.activeStagingType.value).toBe('fork')

    fork.activeRef.value = false
    expect(api.activeStagingType.value).toBeNull()
    expect(api.hasActiveStaging.value).toBe(false)
  })
})

// ── enter 互斥编排 ────────────────────────────────────────────────────────────
describe('enter 互斥编排', () => {
  it("enter('fork', source) → fork.enter 被调（收到 source），handoff 不被调", () => {
    const { api, fork, handoff } = setup()
    const source = forkSource()

    api.enter('fork', source)

    expect(fork.enterSpy).toHaveBeenCalledTimes(1)
    expect(fork.enterSpy).toHaveBeenCalledWith(source)
    expect(handoff.enterSpy).not.toHaveBeenCalled()
  })

  it('enter 同一 type 不会先 exit 自己（无活跃时不触发任何 exit）', () => {
    const { api, fork } = setup()

    api.enter('fork', forkSource())

    expect(fork.exitSpy).not.toHaveBeenCalled()
  })

  it('先 enter(fork) 再 enter(handoff) → 互斥退旧：fork.exit 被调 + handoff.enter 被调', () => {
    const { api, fork, handoff } = setup()
    // 先让 fork 活跃（enter 本身不翻转 ref，模拟底层 enter 翻转后的状态）
    fork.activeRef.value = true

    api.enter('handoff', handoffSource())

    expect(fork.exitSpy).toHaveBeenCalledTimes(1)
    expect(handoff.enterSpy).toHaveBeenCalledTimes(1)
  })

  it('反方向：先 handoff 活跃，enter(fork) → handoff.exit 被调 + fork.enter 被调', () => {
    const { api, fork, handoff } = setup()
    handoff.activeRef.value = true

    api.enter('fork', forkSource())

    expect(handoff.exitSpy).toHaveBeenCalledTimes(1)
    expect(fork.enterSpy).toHaveBeenCalledTimes(1)
  })

  it('enter 与当前同 type（已在 fork 中再 enter fork）→ 不调 fork.exit，只调 fork.enter', () => {
    const { api, fork } = setup()
    fork.activeRef.value = true

    api.enter('fork', forkSource())

    expect(fork.exitSpy).not.toHaveBeenCalled()
    expect(fork.enterSpy).toHaveBeenCalledTimes(1)
  })

  it('enter 的 source 透传（handoff source 同样原样传给 handoff.enter）', () => {
    const { api, handoff } = setup()
    const source = handoffSource()

    api.enter('handoff', source)

    expect(handoff.enterSpy).toHaveBeenCalledWith(source)
  })
})

// ── exit ──────────────────────────────────────────────────────────────────────
describe('exit', () => {
  it('有活跃 action → exit() 调当前 active action 的 exit', () => {
    const { api, fork, handoff } = setup()
    fork.activeRef.value = true

    api.exit()

    expect(fork.exitSpy).toHaveBeenCalledTimes(1)
    expect(handoff.exitSpy).not.toHaveBeenCalled()
  })

  it('active 是 handoff 时 exit() 调 handoff.exit', () => {
    const { api, fork, handoff } = setup()
    handoff.activeRef.value = true

    api.exit()

    expect(handoff.exitSpy).toHaveBeenCalledTimes(1)
    expect(fork.exitSpy).not.toHaveBeenCalled()
  })

  it('无 active 时 exit() no-op（不抛错、不调任何 exit）', () => {
    const { api, fork, handoff } = setup()

    expect(() => api.exit()).not.toThrow()
    expect(fork.exitSpy).not.toHaveBeenCalled()
    expect(handoff.exitSpy).not.toHaveBeenCalled()
  })
})

// ── send 路由 ─────────────────────────────────────────────────────────────────
describe('send 路由', () => {
  it('无 active staging → send 返回 false，不调任何 action.send', async () => {
    const { api, fork, handoff } = setup()

    const consumed = await api.send('hi', {})

    expect(consumed).toBe(false)
    expect(fork.sendSpy).not.toHaveBeenCalled()
    expect(handoff.sendSpy).not.toHaveBeenCalled()
  })

  it('fork active → send 调 fork.send，返回 true', async () => {
    const { api, fork, handoff } = setup()
    fork.activeRef.value = true

    const consumed = await api.send('hello', {})

    expect(consumed).toBe(true)
    expect(fork.sendSpy).toHaveBeenCalledTimes(1)
    expect(fork.sendSpy).toHaveBeenCalledWith('hello', {})
    expect(handoff.sendSpy).not.toHaveBeenCalled()
  })

  it('handoff active → send 调 handoff.send，返回 true', async () => {
    const { api, fork, handoff } = setup()
    handoff.activeRef.value = true

    const consumed = await api.send('hi', {})

    expect(consumed).toBe(true)
    expect(handoff.sendSpy).toHaveBeenCalledTimes(1)
    expect(handoff.sendSpy).toHaveBeenCalledWith('hi', {})
    expect(fork.sendSpy).not.toHaveBeenCalled()
  })

  it('stagingConfig 透传：send(text, {modelOverride}) → action.send 收到相同对象', async () => {
    const { api, fork } = setup()
    fork.activeRef.value = true
    const staging: StagingConfig = { modelOverride: 'p/m', thinkingOverride: 'high' }

    await api.send('text', staging)

    expect(fork.sendSpy).toHaveBeenCalledWith('text', staging)
  })

  it('send action.send reject 时仍由 action 处理（这里 mock reject，send 仍 await 不吞错）', async () => {
    const { api, fork } = setup()
    fork.activeRef.value = true
    fork.sendSpy.mockRejectedValueOnce(new Error('boom'))

    // useComposerStaging.send 直接 await action.send，reject 会向上抛
    await expect(api.send('x', {})).rejects.toThrow('boom')
  })
})

// ── handleEsc 路由 ────────────────────────────────────────────────────────────
describe('handleEsc 路由', () => {
  it('无 active → 返回 false', () => {
    const { api, fork, handoff } = setup()
    const e = keyEvent('Escape')

    expect(api.handleEsc(e)).toBe(false)
    expect(fork.handleEscSpy).not.toHaveBeenCalled()
    expect(handoff.handleEscSpy).not.toHaveBeenCalled()
  })

  it('fork active → 委托 fork.handleEsc，返回其返回值', () => {
    const { api, fork } = setup()
    fork.activeRef.value = true
    fork.handleEscSpy.mockReturnValue(true)
    const e = keyEvent('Escape')

    expect(api.handleEsc(e)).toBe(true)
    expect(fork.handleEscSpy).toHaveBeenCalledTimes(1)
    expect(fork.handleEscSpy).toHaveBeenCalledWith(e)
  })

  it('非 Escape 键时由 action.handleEsc 决定（mock 返回 false 则路由层返回 false）', () => {
    const { api, fork } = setup()
    fork.activeRef.value = true
    fork.handleEscSpy.mockReturnValue(false)
    const e = keyEvent('Enter')

    expect(api.handleEsc(e)).toBe(false)
    expect(fork.handleEscSpy).toHaveBeenCalledWith(e)
  })

  it('handoff active 时委托 handoff.handleEsc', () => {
    const { api, handoff } = setup()
    handoff.activeRef.value = true
    handoff.handleEscSpy.mockReturnValue(true)

    expect(api.handleEsc(keyEvent('Escape'))).toBe(true)
    expect(handoff.handleEscSpy).toHaveBeenCalledTimes(1)
  })
})

// ── abortIfInProgress 路由 ─────────────────────────────────────────────────────
describe('abortIfInProgress 路由', () => {
  it('无进行中（都 isInProgress=false）→ 返回 false，不调任何 abort', async () => {
    const { api, fork, handoff } = setup()

    const consumed = await api.abortIfInProgress('s1')

    expect(consumed).toBe(false)
    expect(fork.abortSpy).not.toHaveBeenCalled()
    expect(handoff.abortSpy).not.toHaveBeenCalled()
  })

  it('handoff isInProgress=true → 调 handoff.abort（收到 sessionId），返回 true', async () => {
    const { api, fork, handoff } = setup()
    handoff.inProgressRef.value = true

    const consumed = await api.abortIfInProgress('s1')

    expect(consumed).toBe(true)
    expect(handoff.abortSpy).toHaveBeenCalledTimes(1)
    expect(handoff.abortSpy).toHaveBeenCalledWith('s1')
    expect(fork.abortSpy).not.toHaveBeenCalled()
  })

  it('fork isInProgress=true 但无 abort 方法 → 不抛错，继续找下一个，最终返回 false', async () => {
    // fork 无 abort（hasAbort:false），但 isInProgress=true；handoff 不在进行中
    const { api, fork, handoff } = setup({ fork: { hasAbort: false } })
    fork.inProgressRef.value = true

    const consumed = await api.abortIfInProgress('s1')

    expect(consumed).toBe(false)
    // fork 无 abort 方法，跳过
    expect(handoff.abortSpy).not.toHaveBeenCalled()
  })

  it('多 action 遍历：fork false + handoff true → 调 handoff.abort，返回 true', async () => {
    const { api, fork, handoff } = setup()
    handoff.inProgressRef.value = true

    const consumed = await api.abortIfInProgress('s1')

    expect(consumed).toBe(true)
    expect(handoff.abortSpy).toHaveBeenCalledWith('s1')
    expect(fork.abortSpy).not.toHaveBeenCalled()
  })

  it('fork 在前：fork isInProgress=true 且有 abort → 命中第一个并返回 true，不再遍历 handoff', async () => {
    const { api, fork, handoff } = setup()
    fork.inProgressRef.value = true
    handoff.inProgressRef.value = true

    const consumed = await api.abortIfInProgress('s1')

    expect(consumed).toBe(true)
    expect(fork.abortSpy).toHaveBeenCalledTimes(1)
    expect(handoff.abortSpy).not.toHaveBeenCalled()
  })

  it('sessionId 透传：abort 收到调用方传入的 sessionId', async () => {
    const { api, handoff } = setup()
    handoff.inProgressRef.value = true

    await api.abortIfInProgress('session-foo')

    expect(handoff.abortSpy).toHaveBeenCalledWith('session-foo')
  })
})

// ── hasStagingInProgress 派生 ──────────────────────────────────────────────────
describe('hasStagingInProgress 派生', () => {
  it('所有 action isInProgress=false → hasStagingInProgress=false', () => {
    const { api } = setup()
    expect(api.hasStagingInProgress.value).toBe(false)
  })

  it('任一 action isInProgress=true → hasStagingInProgress=true（fork）', () => {
    const { api, fork } = setup()
    fork.inProgressRef.value = true
    expect(api.hasStagingInProgress.value).toBe(true)
  })

  it('任一 action isInProgress=true → hasStagingInProgress=true（handoff）', () => {
    const { api, handoff } = setup()
    handoff.inProgressRef.value = true
    expect(api.hasStagingInProgress.value).toBe(true)
  })

  it('翻回 false 后立即回到 false（ComputedRef 同步求值）', () => {
    const { api, handoff } = setup()
    handoff.inProgressRef.value = true
    expect(api.hasStagingInProgress.value).toBe(true)

    handoff.inProgressRef.value = false
    expect(api.hasStagingInProgress.value).toBe(false)
  })
})
