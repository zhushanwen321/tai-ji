/**
 * useComposerHandoffMode 单元测试。
 *
 * 被测对象：domain/composer/dispatch/handoff-mode.ts（从 Composer.vue 拆出的
 * handoff「交接」模式状态 + 行为 composable）。
 *
 * 覆盖全部公共 API：
 * - handoffMode / handoffModeRef（状态真源 + defineExpose 包装）
 * - enterHandoffMode / exitHandoffMode（互斥退出 fork + staging 进入/退出 + 聚焦）
 * - handleHandoffEsc（Esc 退出消费契约）
 * - handleHandoffSend（发送消费契约：成功/失败/staging 透传/空文本）
 * - handoffBoxClass / handoffPlaceholder（派生视图）
 * - 跨组件通道 handoffEnterSignal（signal 命中本 session 才触发）
 * - asStagingAction（isActive/isInProgress=deps.isHandingOff 派生/abort/visual）
 *
 * 范式参照 staging.test.ts：直接 import composable（不 mount），全 deps mock（W3 迁移后
 * 跨域能力 i18n/toast/isHandingOff/channel signal 改 deps 注入，不再 vi.mock renderer 模块，
 * 也不需 pinia）。effectScope 包裹（watch 需 active scope 以便 stop 清理）。
 *
 * [W3 迁移] 迁自 renderer __tests__/composables/use-composer-handoff-mode.test.ts。改动：
 * - import 路径 renderer useComposerHandoffMode → core ./handoff-mode
 * - 去掉 pinia（isHandingOff 改 deps.isHandingOff，不再 useChatStore）
 * - 去掉 vi.mock useToast / useHandoffModeChannel（toastError / handoffEnterSignal 改 deps）
 * - handleEsc mock 参数：new KeyboardEvent(...) → {code, key} 对象字面量（KeyboardEventLike，
 *   core 零 DOM 约束；真实 KeyboardEvent 结构兼容 KeyboardEventLike，断言语义不变）
 * - t mock：对 panel.message.handoffFailed 做 error 插值（保持 toast 断言 byte-level），
 *   其他 key 返回 key 本身（placeholder 断言适配为 key 串——core 无 i18n setup，无法复现长文案）
 * - signal 赋值去 id（dep 类型只需 {srcSessionId}）
 * - 新增 asStagingAction 覆盖块（源测试未覆盖；迁移后 isInProgress 改 dep 派生值得验证）
 * 逻辑与断言 byte-level 保持（mock 适配 deps 注入范式即可）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/handoff-mode.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, type Ref } from 'vue'
import type { KeyboardEventLike } from '../types'
import { useComposerHandoffMode } from './handoff-mode'

/** 构造注入的 deps（全部 spy），inputRef 默认 null，可按需注入 focus spy */
interface DepsSpies {
  inputRef: Ref<{ focus?: () => void } | null>
  setSending: ReturnType<typeof vi.fn>
  clearInput: ReturnType<typeof vi.fn>
  restoreInput: ReturnType<typeof vi.fn>
  exitForkMode: ReturnType<typeof vi.fn>
  handoff: ReturnType<typeof vi.fn>
  abortHandoff: ReturnType<typeof vi.fn>
  enterStagingMode: ReturnType<typeof vi.fn>
  exitStagingMode: ReturnType<typeof vi.fn>
  getStagingConfig: ReturnType<typeof vi.fn>
  /** i18n t（对 handoffFailed 做 error 插值，其他返回 key） */
  t: ReturnType<typeof vi.fn>
  /** handoff mode-chip 图标 mock */
  handoffChipIcon: object
  toastError: ReturnType<typeof vi.fn>
  isHandingOff: ReturnType<typeof vi.fn>
  /** 源 session 是否活跃（streaming/派发中）——handoff 入口/发送守卫，默认 false */
  isSessionActive: ReturnType<typeof vi.fn>
  /** 跨组件触发通道 signal（每测试独立 ref，天然隔离，无需 beforeEach reset） */
  handoffEnterSignal: Ref<{ srcSessionId: string } | null>
}

function makeDeps(): DepsSpies {
  const inputRef = ref<{ focus?: () => void } | null>(null)
  const handoffEnterSignal = ref<{ srcSessionId: string } | null>(null)
  return {
    inputRef,
    setSending: vi.fn(),
    clearInput: vi.fn(),
    restoreInput: vi.fn(),
    exitForkMode: vi.fn(),
    handoff: vi.fn(() => Promise.resolve()),
    abortHandoff: vi.fn(() => Promise.resolve()),
    enterStagingMode: vi.fn(),
    exitStagingMode: vi.fn(),
    getStagingConfig: vi.fn(() => ({})),
    // t mock：handoffFailed 做 error 插值（保持 toast 断言 byte-level），其他返回 key 本身
    t: vi.fn((key: string, params?: Record<string, unknown>) => {
      if (key === 'panel.message.handoffFailed' && params?.error != null) {
        return `交接失败：${params.error}`
      }
      return key
    }),
    handoffChipIcon: {} as never,
    toastError: vi.fn(),
    isHandingOff: vi.fn(() => false),
    isSessionActive: vi.fn(() => false),
    handoffEnterSignal,
  }
}

/** 包 effectScope 起一个被测实例；返回 scope 便于测试结束 stop（清 watch） */
function setup(sessionIdValue: string | null = 's1') {
  const sessionIdSource = ref<string | null>(sessionIdValue)
  const sessionId = computed(() => sessionIdSource.value)
  const deps = makeDeps()
  const scope = effectScope()
  const api = scope.run(() =>
    useComposerHandoffMode(
      sessionId,
      deps as unknown as Parameters<typeof useComposerHandoffMode>[1],
    ),
  )!
  return { sessionIdSource, sessionId, scope, deps, api }
}

beforeEach(() => {
  vi.clearAllMocks()
})

/** KeyboardEventLike 工厂（替代 renderer 测试的 new KeyboardEvent，core 零 DOM） */
function escEvent(): KeyboardEventLike {
  return { code: 'Escape', key: 'Escape' }
}

// ── enterHandoffMode ───────────────────────────────────────────────────────
describe('enterHandoffMode', () => {
  it('互斥退出 fork + 进入暂存态 + handoffMode 置 true', () => {
    const { deps, api } = setup()

    api.enterHandoffMode('src-1')

    expect(deps.exitForkMode).toHaveBeenCalledTimes(1)
    expect(deps.enterStagingMode).toHaveBeenCalledTimes(1)
    expect(api.handoffMode.value).toBe(true)
  })

  it('inputRef 有值时聚焦输入框', () => {
    const { deps, api } = setup()
    const focusSpy = vi.fn()
    deps.inputRef.value = { focus: focusSpy }

    api.enterHandoffMode('src-1')

    expect(focusSpy).toHaveBeenCalledTimes(1)
  })

  it('inputRef 为 null 时不抛错（可选链守卫）', () => {
    const { api } = setup()
    // inputRef.value 默认 null
    expect(() => api.enterHandoffMode('src-1')).not.toThrow()
    expect(api.handoffMode.value).toBe(true)
  })
})

// ── exitHandoffMode ────────────────────────────────────────────────────────
describe('exitHandoffMode', () => {
  it('handoffMode 置 false + 退出暂存态', () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    expect(api.handoffMode.value).toBe(true)

    api.exitHandoffMode()

    expect(api.handoffMode.value).toBe(false)
    expect(deps.exitStagingMode).toHaveBeenCalledTimes(1)
  })

  it('未进入 handoff 也可直接 exit（幂等）', () => {
    const { deps, api } = setup()
    api.exitHandoffMode()
    expect(api.handoffMode.value).toBe(false)
    expect(deps.exitStagingMode).toHaveBeenCalledTimes(1)
  })
})

// ── handoffModeRef（defineExpose 包装）──────────────────────────────────────
describe('handoffModeRef', () => {
  it('value 跟随 handoffMode ref（getter 代理）', () => {
    const { api } = setup()
    expect(api.handoffModeRef.value).toBe(false)

    api.enterHandoffMode('src-1')
    expect(api.handoffModeRef.value).toBe(true)

    api.exitHandoffMode()
    expect(api.handoffModeRef.value).toBe(false)
  })
})

// ── handoffBoxClass ─────────────────────────────────────────────────────────
describe('handoffBoxClass', () => {
  it('handoff 模式返回含 handoff-mode 的 accent class', () => {
    const { api } = setup()
    api.enterHandoffMode('src-1')

    expect(api.handoffBoxClass.value).toContain('handoff-mode')
  })

  it('非 handoff 模式返回空串', () => {
    const { api } = setup()
    expect(api.handoffBoxClass.value).toBe('')
  })
})

// ── handoffPlaceholder ──────────────────────────────────────────────────────
describe('handoffPlaceholder', () => {
  it('handoff 模式返回 t(panel.composer.handoffHint) 的结果', () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')

    // core 测试无 i18n setup，t mock 返回 key 本身（见 makeDeps）
    expect(api.handoffPlaceholder.value).toBe('panel.composer.handoffHint')
    expect(deps.t).toHaveBeenCalledWith('panel.composer.handoffHint')
  })

  it('非 handoff 模式返回 null', () => {
    const { api } = setup()
    expect(api.handoffPlaceholder.value).toBeNull()
  })
})

// ── handleHandoffEsc ────────────────────────────────────────────────────────
describe('handleHandoffEsc', () => {
  it('非 handoff 模式返回 false（不消费）', () => {
    const { deps, api } = setup()
    const e = escEvent()
    expect(api.handleHandoffEsc(e)).toBe(false)
    // 不应 clearInput / 不应 exit
    expect(deps.clearInput).not.toHaveBeenCalled()
    expect(deps.exitStagingMode).not.toHaveBeenCalled()
  })

  it('handoff 模式但非 Escape 键返回 false（不消费）', () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    const e: KeyboardEventLike = { code: 'Enter', key: 'Enter' }

    expect(api.handleHandoffEsc(e)).toBe(false)
    expect(deps.clearInput).not.toHaveBeenCalled()
    expect(api.handoffMode.value).toBe(true)
  })

  it('handoff + Escape：preventDefault + clearInput + 退出 + 返回 true', () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    const preventDefault = vi.fn()
    const e: KeyboardEventLike = { code: 'Escape', key: 'Escape', preventDefault }

    const consumed = api.handleHandoffEsc(e)

    expect(consumed).toBe(true)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(deps.clearInput).toHaveBeenCalledTimes(1)
    expect(api.handoffMode.value).toBe(false)
    // exit 走 exitHandoffMode → exitStagingMode
    expect(deps.exitStagingMode).toHaveBeenCalledTimes(1)
  })
})

// ── handleHandoffSend ───────────────────────────────────────────────────────
describe('handleHandoffSend', () => {
  it('非 handoff 模式返回 false（不消费，不走 handoff 流程）', async () => {
    const { deps, api } = setup()
    const consumed = await api.handleHandoffSend('hi')
    expect(consumed).toBe(false)
    expect(deps.handoff).not.toHaveBeenCalled()
    expect(deps.setSending).not.toHaveBeenCalled()
    expect(deps.clearInput).not.toHaveBeenCalled()
  })

  it('成功 + 非空文本：reply=text，clearInput + setSending(1→0) + 退出，返回 true', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')

    const consumed = await api.handleHandoffSend('hello world')

    expect(consumed).toBe(true)
    expect(deps.clearInput).toHaveBeenCalledTimes(1)
    // setSending 先 true 后 false
    expect(deps.setSending).toHaveBeenNthCalledWith(1, true)
    expect(deps.setSending).toHaveBeenNthCalledWith(2, false)
    expect(deps.setSending).toHaveBeenCalledTimes(2)
    // reply 透传 = trim 后的非空文本
    expect(deps.handoff).toHaveBeenCalledWith('src-1', 'hello world', {})
    // 成功后退出 handoff
    expect(api.handoffMode.value).toBe(false)
  })

  it('成功 + 空文本：reply=undefined（允许空发送），仍消费', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')

    const consumed = await api.handleHandoffSend('   ')

    expect(consumed).toBe(true)
    expect(deps.handoff).toHaveBeenCalledWith('src-1', undefined, {})
  })

  it('trim 文本：前后空白被裁掉再作 reply', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')

    await api.handleHandoffSend('  trimmed  ')

    expect(deps.handoff).toHaveBeenCalledWith('src-1', 'trimmed', {})
  })

  it('staging config 透传：getStagingConfig 返回值原样传给 handoff action', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    const staging = { modelOverride: 'p/m', thinkingOverride: 'high' }
    deps.getStagingConfig.mockReturnValue(staging)

    await api.handleHandoffSend('text')

    expect(deps.handoff).toHaveBeenCalledWith('src-1', 'text', staging)
  })

  it('失败（handoff action reject）：restoreInput + toastError + setSending(false) + 退出，返回 true', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    deps.handoff.mockRejectedValueOnce(new Error('boom'))

    const consumed = await api.handleHandoffSend('my draft')

    expect(consumed).toBe(true)
    // 失败 → 恢复草稿（原 text）
    expect(deps.restoreInput).toHaveBeenCalledWith('my draft')
    // toast 上报：t mock 对 handoffFailed 做 error 插值 → '交接失败：boom'
    expect(deps.toastError).toHaveBeenCalledTimes(1)
    expect(deps.toastError).toHaveBeenCalledWith('交接失败：boom')
    // setSending 仍复位 false
    expect(deps.setSending).toHaveBeenLastCalledWith(false)
    // 失败也退出 handoff
    expect(api.handoffMode.value).toBe(false)
  })

  it('失败（非 Error 抛出值）：toast 文案兜底为 String(e)', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    deps.handoff.mockRejectedValueOnce('string error')

    await api.handleHandoffSend('draft')

    expect(deps.toastError).toHaveBeenCalledWith('交接失败：string error')
  })

  it('失败分支也调了 clearInput + setSending(true)（发送流程一致前置）', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    deps.handoff.mockRejectedValueOnce(new Error('x'))

    await api.handleHandoffSend('draft')

    expect(deps.clearInput).toHaveBeenCalledTimes(1)
    expect(deps.setSending).toHaveBeenCalledWith(true)
  })
})

// ── 跨组件通道 handoffEnterSignal ────────────────────────────────────────────
describe('跨组件通道：signal 命中本 session 才触发 enterHandoffMode', () => {
  it('signal 命中本 session（srcSessionId === sessionId.value）→ enterHandoffMode', async () => {
    const { deps, api } = setup('s1')

    deps.handoffEnterSignal.value = { srcSessionId: 's1' }
    await nextTick()

    expect(api.handoffMode.value).toBe(true)
    expect(deps.exitForkMode).toHaveBeenCalledTimes(1)
    expect(deps.enterStagingMode).toHaveBeenCalledTimes(1)
  })

  it('signal 不命中本 session（srcSessionId !== sessionId.value）→ 不触发', async () => {
    const { deps, api } = setup('s1')

    deps.handoffEnterSignal.value = { srcSessionId: 'other' }
    await nextTick()

    expect(api.handoffMode.value).toBe(false)
    expect(deps.exitForkMode).not.toHaveBeenCalled()
    expect(deps.enterStagingMode).not.toHaveBeenCalled()
  })

  it('sessionId 为 null（landing 态）→ 即使 srcSessionId 非空也不触发', async () => {
    const { deps, api } = setup(null)

    deps.handoffEnterSignal.value = { srcSessionId: 's1' }
    await nextTick()

    expect(api.handoffMode.value).toBe(false)
    expect(deps.enterStagingMode).not.toHaveBeenCalled()
  })

  it('signal 为 null → 不触发', async () => {
    const { deps, api } = setup('s1')

    deps.handoffEnterSignal.value = null
    await nextTick()

    expect(api.handoffMode.value).toBe(false)
    expect(deps.enterStagingMode).not.toHaveBeenCalled()
  })

  it('切换 sessionId 后，新 signal 按新 sessionId 判定命中', async () => {
    const { sessionIdSource, deps, api } = setup('s1')

    // 先发一个不命中的 signal（其他 session）
    deps.handoffEnterSignal.value = { srcSessionId: 's2' }
    await nextTick()
    expect(api.handoffMode.value).toBe(false)

    // 切到 s2 后，针对 s2 的 signal 命中
    sessionIdSource.value = 's2'
    deps.handoffEnterSignal.value = { srcSessionId: 's2' }
    await nextTick()

    expect(api.handoffMode.value).toBe(true)
    expect(deps.enterStagingMode).toHaveBeenCalledTimes(1)
  })
})

// ── asStagingAction（StagingAction adapter，ADR-0057）─────────────────────────
describe('asStagingAction', () => {
  it('type=handoff，isActive 派生自 handoffMode ref', () => {
    const { api } = setup()
    const action = api.asStagingAction()

    expect(action.type).toBe('handoff')
    expect(action.isActive.value).toBe(false)

    api.enterHandoffMode('src-1')
    expect(action.isActive.value).toBe(true)

    api.exitHandoffMode()
    expect(action.isActive.value).toBe(false)
  })

  it('allowsEmptySend=true（handoff 允许空 reply）', () => {
    const { api } = setup()
    expect(api.asStagingAction().allowsEmptySend).toBe(true)
  })

  it('isInProgress：未进入 handoff 时恒 false（handoffSource null，不读 deps.isHandingOff）', () => {
    const { deps, api } = setup()
    // 即使 isHandingOff mock 返回 true，未进入时 handoffSource=null → isInProgress 恒 false
    deps.isHandingOff.mockReturnValue(true)

    expect(api.asStagingAction().isInProgress.value).toBe(false)
    expect(deps.isHandingOff).not.toHaveBeenCalled()
  })

  it('isInProgress：进入后派生自 deps.isHandingOff(srcSessionId)', () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')

    deps.isHandingOff.mockReturnValue(false)
    expect(api.asStagingAction().isInProgress.value).toBe(false)

    deps.isHandingOff.mockReturnValue(true)
    expect(api.asStagingAction().isInProgress.value).toBe(true)

    // 读的是进入时记录的 srcSessionId
    expect(deps.isHandingOff).toHaveBeenCalledWith('src-1')
  })

  it('isInProgress：exit 后 handoffSource 清空 → 回 false（不再读 isHandingOff）', () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    deps.isHandingOff.mockReturnValue(true)
    expect(api.asStagingAction().isInProgress.value).toBe(true)

    api.exitHandoffMode()
    deps.isHandingOff.mockClear()
    expect(api.asStagingAction().isInProgress.value).toBe(false)
    expect(deps.isHandingOff).not.toHaveBeenCalled()
  })

  it('abort = deps.abortHandoff（引用相等 + 可调）', async () => {
    const { deps, api } = setup()
    const action = api.asStagingAction()

    expect(action.abort).toBe(deps.abortHandoff)
    await action.abort!('src-1')
    expect(deps.abortHandoff).toHaveBeenCalledWith('src-1')
  })

  it('enter(source) 收窄 srcSessionId 调 enterHandoffMode', () => {
    const { deps, api } = setup()
    api.asStagingAction().enter({ type: 'handoff', srcSessionId: 'src-9' })

    expect(deps.exitForkMode).toHaveBeenCalledTimes(1)
    expect(deps.enterStagingMode).toHaveBeenCalledTimes(1)
    expect(api.handoffMode.value).toBe(true)
  })

  it('exit() 调 exitHandoffMode', () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    api.asStagingAction().exit()

    expect(api.handoffMode.value).toBe(false)
    expect(deps.exitStagingMode).toHaveBeenCalledTimes(1)
  })

  it('send(text) 调 handleHandoffSend（忽略传入的 staging 参数，内部自取 getStagingConfig）', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')

    // 传入 staging 参数应被忽略（handleHandoffSend 内部调 deps.getStagingConfig）
    await api.asStagingAction().send('hello', { modelOverride: 'ignored' })

    expect(deps.handoff).toHaveBeenCalledWith('src-1', 'hello', {})
    expect(deps.getStagingConfig).toHaveBeenCalled()
  })

  it('handleEsc 委托 handleHandoffEsc（活跃时消费 Escape）', () => {
    const { api } = setup()
    const action = api.asStagingAction()

    // 未进入 → 不消费
    expect(action.handleEsc({ code: 'Escape', key: 'Escape' })).toBe(false)

    api.enterHandoffMode('src-1')
    // 进入 + Escape → 消费
    expect(action.handleEsc({ code: 'Escape', key: 'Escape' })).toBe(true)
    expect(api.handoffMode.value).toBe(false)
  })

  it('visual：boxClass / placeholder / chipLabelKey / chipIcon', () => {
    const { deps, api } = setup()
    const v = api.asStagingAction().visual

    // 非活跃态
    expect(v.boxClass.value).toBe('')
    expect(v.placeholder.value).toBeNull()
    expect(v.chipLabelKey).toBe('panel.composer.handoffChip')
    expect(v.chipIcon).toBe(deps.handoffChipIcon)

    // 活跃态
    api.enterHandoffMode('src-1')
    expect(v.boxClass.value).toContain('handoff-mode')
    expect(v.placeholder.value).toBe('panel.composer.handoffHint')
  })
})

// ── streaming 守卫（isSessionActive：入口拦截 + 发送兑底）─────────────────
describe('streaming 守卫（isSessionActive）', () => {
  it('源 session streaming 中 enterHandoffMode 拦截：toast + 不进入模式', () => {
    const { deps, api } = setup()
    deps.isSessionActive.mockReturnValue(true)

    api.enterHandoffMode('src-1')

    expect(api.handoffMode.value).toBe(false)
    expect(deps.toastError).toHaveBeenCalledWith('panel.composer.handoffBusy')
    expect(deps.enterStagingMode).not.toHaveBeenCalled()
    expect(deps.exitForkMode).not.toHaveBeenCalled()
  })

  it('signal 入口同样被拦截（streaming 中 ⌘J / 消息工具栏不进模式）', async () => {
    const { deps, api } = setup('s1')
    deps.isSessionActive.mockReturnValue(true)

    deps.handoffEnterSignal.value = { srcSessionId: 's1' }
    await nextTick()

    expect(api.handoffMode.value).toBe(false)
    expect(deps.toastError).toHaveBeenCalledWith('panel.composer.handoffBusy')
  })

  it('非 streaming 时入口正常进入（isSessionActive=false 不影响）', () => {
    const { deps, api } = setup()
    deps.isSessionActive.mockReturnValue(false)

    api.enterHandoffMode('src-1')

    expect(api.handoffMode.value).toBe(true)
    expect(deps.toastError).not.toHaveBeenCalled()
  })

  it('发送兑底：进入模式后 session 变 streaming → handleHandoffSend 拦截，不清草稿不退模式不打 handoff', async () => {
    const { deps, api } = setup()
    api.enterHandoffMode('src-1')
    // 进入后才变 streaming（竞态窗口）
    deps.isSessionActive.mockReturnValue(true)

    const consumed = await api.handleHandoffSend('备注')

    expect(consumed).toBe(true) // 已消费（不走普通 send）
    expect(deps.handoff).not.toHaveBeenCalled()
    expect(deps.clearInput).not.toHaveBeenCalled() // 草稿保留，回复结束后可重发
    expect(deps.toastError).toHaveBeenCalledWith('panel.composer.handoffBusy')
    expect(api.handoffMode.value).toBe(true) // 不退模式
  })
})
