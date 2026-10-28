// types.test.ts —— core C07 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/composer/types.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/composer/dispatch/fork-mode.test.ts（9 用例，skip 0）
//   - src/domain/composer/dispatch/handoff-mode.test.ts（40 用例，skip 0）
//   - src/domain/composer/dispatch/staging-mode.test.ts（24 用例，skip 0）
//   - src/domain/composer/dispatch/staging.test.ts（33 用例，skip 0）

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { computed, effectScope, nextTick, ref, type Ref, type Component } from 'vue'
import { type KeyboardEventLike, type StagingConfig, type StagingAction, type StagingSource, type StagingType } from '../types'
import { useComposerForkMode } from './fork-mode'
import { useComposerHandoffMode } from './handoff-mode'
import { createStagingMode, type StagingModeConfig, type StagingModeDeps, type StagingModeInstance, type StagingModeSource } from './staging-mode'
import { useComposerStaging } from './staging'

// ======== 来源：fork-mode.test.ts ========
describe("fork-mode", () => {
  function makeDeps() {
    return {
      inputRef: ref<{ focus?: () => void } | null>(null),
      setSending: vi.fn(),
      clearInput: vi.fn(),
      restoreInput: vi.fn(),
      enterStagingMode: vi.fn(),
      exitStagingMode: vi.fn(),
      getStagingConfig: vi.fn(() => ({}) as never),
      t: vi.fn((key: string) => key),
      forkChipIcon: {} as never,
      forkSessionAsk: vi.fn(() => Promise.resolve()),
      toastError: vi.fn(),
      forkEnterSignal: ref<{ srcSessionId: string; fromMessageId: string } | null>(null),
    }
  }

  function setup(sessionIdValue: string | null = 's1') {
    const sessionIdSource = ref<string | null>(sessionIdValue)
    const sessionId = computed(() => sessionIdSource.value)
    const deps = makeDeps()
    const scope = effectScope()
    const api = scope.run(() =>
      useComposerForkMode(
        sessionId,
        deps as unknown as Parameters<typeof useComposerForkMode>[1],
      ),
    )!
    return { sessionIdSource, deps, scope, api }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('useComposerForkMode 公开返回结构', () => {
    it('enterForkMode：mode 置 true + 记录来源 + 进入暂存态 + 聚焦', () => {
      const { deps, api } = setup()
      const focusSpy = vi.fn()
      deps.inputRef.value = { focus: focusSpy }

      api.enterForkMode('src-1', 'msg-9')

      expect(api.forkMode.value).toBe(true)
      expect(deps.enterStagingMode).toHaveBeenCalledTimes(1)
      expect(focusSpy).toHaveBeenCalledTimes(1)
      expect(api.forkBoxClass.value).toContain('fork-mode')
      expect(api.forkPlaceholder.value).toBe('panel.composer.forkHint')
    })

    it('exitForkMode：复位 + 退出暂存态 + 派生视图复位', () => {
      const { deps, api } = setup()
      api.enterForkMode('src-1', 'msg-9')
      api.exitForkMode()
      expect(api.forkMode.value).toBe(false)
      expect(deps.exitStagingMode).toHaveBeenCalledTimes(1)
      expect(api.forkBoxClass.value).toBe('')
      expect(api.forkPlaceholder.value).toBeNull()
    })

    it('handleForkEsc：fork 模式 Escape 消费（清空 + 退出），非 fork 不消费', () => {
      const { deps, api } = setup()
      const esc: KeyboardEventLike = { code: 'Escape', key: 'Escape', preventDefault: vi.fn() }
      expect(api.handleForkEsc(esc)).toBe(false)
      api.enterForkMode('src-1', 'msg-9')
      expect(api.handleForkEsc(esc)).toBe(true)
      expect(deps.clearInput).toHaveBeenCalledTimes(1)
      expect(api.forkMode.value).toBe(false)
    })

    it('handleForkSend：调 forkSessionAsk(src, fromMessageId, text, staging) 并退出', async () => {
      const { deps, api } = setup()
      api.enterForkMode('src-1', 'msg-9')

      const consumed = await api.handleForkSend('分支问题')
      expect(consumed).toBe(true)
      expect(deps.forkSessionAsk).toHaveBeenCalledWith('src-1', 'msg-9', '分支问题', expect.anything())
      expect(deps.setSending).toHaveBeenCalledWith(true)
      expect(deps.clearInput).toHaveBeenCalledTimes(1)
      expect(api.forkMode.value).toBe(false)
    })

    it('handleForkSend 空文本也消费（allowsEmptySend：纯 fork 不发首条 user）', async () => {
      const { deps, api } = setup()
      api.enterForkMode('src-1', 'msg-9')

      expect(await api.handleForkSend('')).toBe(true)
      expect(deps.forkSessionAsk).toHaveBeenCalledWith('src-1', 'msg-9', '', expect.anything())
    })

    it('handleForkSend 非 fork 模式不消费（返回 false 零副作用）', async () => {
      const { deps, api } = setup()
      expect(await api.handleForkSend('x')).toBe(false)
      expect(deps.forkSessionAsk).not.toHaveBeenCalled()
    })

    it('handleForkSend 失败：restoreInput + toastError + 退出暂存态', async () => {
      const { deps, api } = setup()
      ;(deps.forkSessionAsk as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
      api.enterForkMode('src-1', 'msg-9')

      expect(await api.handleForkSend('文本')).toBe(true)
      expect(deps.restoreInput).toHaveBeenCalledWith('文本')
      expect(deps.toastError).toHaveBeenCalledWith('panel.panel.sendFailed')
      expect(deps.exitStagingMode).toHaveBeenCalled()
    })

    it('forkEnterSignal 命中本 session 才触发 enter（跨组件通道检查）', async () => {
      const { deps, api } = setup('s1')
      deps.forkEnterSignal.value = { srcSessionId: 'other', fromMessageId: 'm' }
      await nextTick()
      expect(api.forkMode.value).toBe(false)

      deps.forkEnterSignal.value = { srcSessionId: 's1', fromMessageId: 'm' }
      await nextTick()
      expect(api.forkMode.value).toBe(true)
    })

    it('asStagingAction：type=fork + isActive 派生 + 无 abort（B 阶段缺省）', () => {
      const { api } = setup()
      const action = api.asStagingAction()
      expect(action.type).toBe('fork')
      expect(action.isActive.value).toBe(false)
      api.enterForkMode('src-1', 'msg-9')
      expect(action.isActive.value).toBe(true)
      expect(action.isInProgress.value ?? false).toBe(false)
      expect(action.abort).toBeUndefined()
    })
  })
});

// ======== 来源：handoff-mode.test.ts ========
describe("handoff-mode", () => {
  /** 构造注入的 deps（全部 spy），inputRef 默认 null，可按需注入 focus spy */
  interface DepsSpies { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
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
    /** 源 session 是否活跃（streaming/派发中）——handoff 入口/发送检查，默认 false */
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

    it('inputRef 为 null 时不抛错（可选链检查）', () => {
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

    it('send(text) 调 handleHandoffSend（内部自取 getStagingConfig，审计候选 10 后无 staging 透传参）', async () => {
      const { deps, api } = setup()
      api.enterHandoffMode('src-1')

      await api.asStagingAction().send('hello')

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

  // ── streaming 检查（isSessionActive：入口拦截 + 发送兜底）─────────────────
  describe('streaming 检查（isSessionActive）', () => {
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

    it('发送兜底：进入模式后 session 变 streaming → handleHandoffSend 拦截，不清草稿不退模式不打 handoff', async () => {
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
});

// ======== 来源：staging-mode.test.ts ========
describe("staging-mode", () => {
  // ── 测试基建：全 spy deps + 副作用序列日志 ──────────────────────────────────

  /** fork source 形状（与生产 fork-mode.ts 的 ForkSourceShape 同构） */
  interface ForkSourceShape { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    srcSessionId: string
    fromMessageId: string
  }

  /** handoff source 形状（与生产 handoff-mode.ts 的 HandoffSourceShape 同构） */
  interface HandoffSourceShape { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    srcSessionId: string
  }

  // 各 spy = 真实签名 & vi.fn 能力（裸 Mock<Procedure> 无法赋给 StagingModeDeps 具体签名）
  type Spy<T> = T & ReturnType<typeof vi.fn>

  interface DepsSpies extends Omit<StagingModeDeps, // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    'inputRef' | 'setSending' | 'clearInput' | 'restoreInput' | 'enterStagingMode' | 'exitStagingMode' | 'getStagingConfig' | 't' | 'toastError'
  > {
    toastError: Spy<StagingModeDeps['toastError']>
    /** 副作用序列日志（每 spy 记录一次标签；序列等价的核心断言对象） */
    log: string[]
    inputRef: StagingModeDeps['inputRef']
    setSending: Spy<StagingModeDeps['setSending']>
    clearInput: Spy<StagingModeDeps['clearInput']>
    restoreInput: Spy<StagingModeDeps['restoreInput']>
    enterStagingMode: Spy<StagingModeDeps['enterStagingMode']>
    exitStagingMode: Spy<StagingModeDeps['exitStagingMode']>
    getStagingConfig: Spy<StagingModeDeps['getStagingConfig']>
    t: Spy<StagingModeDeps['t']>
  }

  /** 全 spy deps：每个副作用 push 标签到 log（与骨架/检查触达的副作用一一对应） */
  function makeDeps(): DepsSpies {
    const log: string[] = []
    const inputRef: StagingModeDeps['inputRef'] = ref(null)
    return {
      log,
      inputRef,
      setSending: vi.fn((v: boolean) => log.push(`setSending:${v}`)),
      clearInput: vi.fn(() => log.push('clearInput')),
      restoreInput: vi.fn(() => log.push('restoreInput')),
      enterStagingMode: vi.fn(() => log.push('enterStagingMode')),
      exitStagingMode: vi.fn(() => log.push('exitStagingMode')),
      getStagingConfig: vi.fn((): StagingConfig => {
        log.push('getStagingConfig')
        return {}
      }),
      // t mock：handoffFailed 做 error 插值（对齐 handoff-mode.test.ts），其他返回 key 本身
      t: vi.fn((key: string, params?: Record<string, unknown>) => {
        if (key === 'panel.message.handoffFailed' && params?.error != null) {
          return `交接失败：${params.error}`
        }
        return key
      }),
      toastError: vi.fn((msg: string) => log.push(`toast:${msg}`)),
      // inputRef.focus 经 logger 包装（enter 聚焦路径进 log）
    }
  }

  /** 包 effectScope 起一个骨架实例（watch 需 active scope；scope 供 afterEach stop） */
  function setup<S extends StagingModeSource>(
    makeConfig: (sessionId: Ref<string | null>, deps: DepsSpies) => StagingModeConfig<S>,
    sessionIdValue: string | null = 's1',
  ): { sessionIdSource: Ref<string | null>; scope: ReturnType<typeof effectScope>; deps: DepsSpies; instance: StagingModeInstance<S> } {
    const sessionIdSource = ref<string | null>(sessionIdValue)
    const deps = makeDeps()
    const scope = effectScope()
    const instance = scope.run(() => createStagingMode(makeConfig(sessionIdSource, deps)))!
    return { sessionIdSource, scope, deps, instance }
  }

  // ── 与生产同构的 fork 形配置（字段值 = fork-mode.ts 生产配置逐字段复制）────────

  function makeForkConfig(
    sessionId: Ref<string | null>,
    deps: StagingModeDeps,
    extras: {
      forkSessionAsk: Spy<(srcSessionId: string, fromMessageId: string, text: string, staging: StagingConfig) => Promise<void>>
      signal: Ref<ForkSourceShape | null>
    },
  ): StagingModeConfig<ForkSourceShape> {
    return {
      sessionId: computed(() => sessionId.value),
      deps,
      type: 'fork',
      signal: extras.signal,
      sendAction: (source, text, staging) =>
        extras.forkSessionAsk(source.srcSessionId, source.fromMessageId, text, staging),
      sendFailedKey: 'panel.panel.sendFailed',
      allowsEmptySend: true,
      activeBoxClass:
        'fork-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring,rgba(79,142,247,0.45))] bg-[var(--accent-soft)]',
      placeholderKey: 'panel.composer.forkHint',
      chipLabelKey: 'panel.composer.forkChip',
      chipIcon: {} as Component,
    }
  }

  // ── 与生产同构的 handoff 形配置（字段值 = handoff-mode.ts 生产配置逐字段复制）────

  function makeHandoffConfig(
    sessionId: Ref<string | null>,
    deps: StagingModeDeps,
    extras: {
      signal: Ref<HandoffSourceShape | null>
      exitForkMode: Spy<() => void>
      handoff: Spy<(srcSessionId: string, reply: string | undefined, staging: StagingConfig) => Promise<void>>
      abortHandoff: Spy<(srcSessionId: string) => Promise<void>>
      isHandingOff: Spy<(srcSessionId: string) => boolean>
      isSessionActive: Spy<(srcSessionId: string) => boolean>
    },
  ): StagingModeConfig<HandoffSourceShape> {
    return {
      sessionId: computed(() => sessionId.value),
      deps,
      type: 'handoff',
      signal: extras.signal,
      enterGuard: (source) => {
        if (extras.isSessionActive(source.srcSessionId)) {
          deps.toastError(deps.t('panel.composer.handoffBusy'))
          return false
        }
        return true
      },
      beforeEnter: () => {
        extras.exitForkMode()
      },
      beforeSend: (text, source) => {
        if (extras.isSessionActive(source.srcSessionId)) {
          deps.toastError(deps.t('panel.composer.handoffBusy'))
          return true
        }
        return false
      },
      sendAction: (source, text, staging) => {
        const reply = text.trim() || undefined
        return extras.handoff(source.srcSessionId, reply, staging)
      },
      sendFailedKey: 'panel.message.handoffFailed',
      allowsEmptySend: true,
      isInProgress: (source) => extras.isHandingOff(source.srcSessionId),
      abort: extras.abortHandoff,
      activeBoxClass:
        'handoff-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring,rgba(79,142,247,0.45))] bg-[var(--accent-soft)]',
      placeholderKey: 'panel.composer.handoffHint',
      chipLabelKey: 'panel.composer.handoffChip',
      chipIcon: {} as Component,
    }
  }

  /** KeyboardEventLike 工厂（core 零 DOM，对齐 handoff-mode.test.ts） */
  function escEvent(): KeyboardEventLike {
    return { code: 'Escape', key: 'Escape' }
  }

  const scopes: Array<ReturnType<typeof effectScope>> = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    const s = scopes.pop()
    s?.stop()
  })

  /** setup + scope 登记（afterEach 统一 stop 清 watch） */
  function setupFork(sessionIdValue?: string | null) {
    const forkSessionAsk = vi.fn(() => Promise.resolve())
    const signal = ref<ForkSourceShape | null>(null)
    const r = setup((sid, deps) => makeForkConfig(sid, deps, { forkSessionAsk, signal }), sessionIdValue)
    scopes.push(r.scope)
    return { ...r, forkSessionAsk, signal }
  }

  function setupHandoff(sessionIdValue?: string | null) {
    const signal = ref<HandoffSourceShape | null>(null)
    // exitForkMode 是 extras spy（不在 StagingModeDeps 公共范围），经闭包引用 deps 也记入序列日志
    let depsRef: DepsSpies | undefined
    const handoffExtras = {
      signal,
      exitForkMode: vi.fn(() => depsRef?.log.push('exitForkMode')),
      handoff: vi.fn(() => Promise.resolve()),
      abortHandoff: vi.fn(() => Promise.resolve()),
      isHandingOff: vi.fn(() => false),
      isSessionActive: vi.fn(() => false),
    }
    const r = setup(
      (sid, deps) => {
        depsRef = deps
        return makeHandoffConfig(sid, deps, handoffExtras)
      },
      sessionIdValue,
    )
    scopes.push(r.scope)
    return { ...r, ...handoffExtras }
  }

  // ── fork 形：enter / esc / send 行为与泛化前 fork-mode.ts 一致 ───────────────

  describe('fork 形配置：enter', () => {
    it('enter 序列 = enterStagingMode → focus（fork 无检查/互斥），mode 置 true', () => {
      const { deps, instance } = setupFork()
      deps.inputRef.value = { focus: () => {} }

      instance.enter({ srcSessionId: 'src-1', fromMessageId: 'm1' })

      expect(deps.log).toEqual(['enterStagingMode'])
      expect(instance.mode.value).toBe(true)
    })

    it('enter 聚焦经 inputRef.focus 可选链（null 不抛错）', () => {
      const { instance } = setupFork()
      expect(() => instance.enter({ srcSessionId: 'src-1', fromMessageId: 'm1' })).not.toThrow()
    })
  })

  describe('fork 形配置：handleEsc', () => {
    it('活跃 + Escape：preventDefault + clearInput + 退出 + 返回 true（序列与泛化前一致）', () => {
      const { deps, instance } = setupFork()
      instance.enter({ srcSessionId: 'src-1', fromMessageId: 'm1' })
      deps.log.length = 0
      const preventDefault = vi.fn()

      const consumed = instance.handleEsc({ code: 'Escape', key: 'Escape', preventDefault })

      expect(consumed).toBe(true)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(deps.log).toEqual(['clearInput', 'exitStagingMode'])
      expect(instance.mode.value).toBe(false)
    })

    it('非活跃或非 Escape：返回 false 零副作用', () => {
      const { deps, instance } = setupFork()
      expect(instance.handleEsc(escEvent())).toBe(false)
      instance.enter({ srcSessionId: 'src-1', fromMessageId: 'm1' })
      expect(instance.handleEsc({ code: 'Enter', key: 'Enter' })).toBe(false)
      expect(deps.log).toEqual(['enterStagingMode'])
    })
  })

  describe('fork 形配置：handleSend', () => {
    it('非活跃返回 false（零副作用）', async () => {
      const { deps, instance, forkSessionAsk } = setupFork()
      expect(await instance.handleSend('hi')).toBe(false)
      expect(forkSessionAsk).not.toHaveBeenCalled()
      expect(deps.log).toEqual([])
    })

    it('成功全序列与泛化前 handleForkSend 一致 + forkSessionAsk 透传 staging', async () => {
      const { deps, instance, forkSessionAsk } = setupFork()
      instance.enter({ srcSessionId: 'src-1', fromMessageId: 'm1' })
      deps.log.length = 0

      expect(await instance.handleSend('hi')).toBe(true)

      // 泛化前序列：clearInput → setSending(true) → getStagingConfig → forkSessionAsk → setSending(false) → exit
      expect(deps.log).toEqual([
        'clearInput',
        'setSending:true',
        'getStagingConfig',
        'setSending:false',
        'exitStagingMode',
      ])
      expect(forkSessionAsk).toHaveBeenCalledWith('src-1', 'm1', 'hi', {})
      expect(instance.mode.value).toBe(false)
    })

    it('失败：restoreInput(原 text) + toast(t(sendFailedKey,{error})) + 仍退出', async () => {
      const { deps, instance, forkSessionAsk } = setupFork()
      instance.enter({ srcSessionId: 'src-1', fromMessageId: 'm1' })
      forkSessionAsk.mockRejectedValueOnce(new Error('boom'))
      deps.log.length = 0

      expect(await instance.handleSend('my draft')).toBe(true)

      // 泛化前顺序：catch{restoreInput → toastError} → finally{setSending(false) → exit}
      expect(deps.log).toEqual([
        'clearInput',
        'setSending:true',
        'getStagingConfig',
        'restoreInput',
        'toast:panel.panel.sendFailed',
        'setSending:false',
        'exitStagingMode',
      ])
      expect(deps.restoreInput).toHaveBeenCalledWith('my draft')
      expect(deps.toastError).toHaveBeenCalledWith('panel.panel.sendFailed')
      expect(deps.t).toHaveBeenCalledWith('panel.panel.sendFailed', { error: 'boom' })
      expect(instance.mode.value).toBe(false)
    })
  })

  describe('fork 形配置：signal watch 检查（三条件与泛化前一致）', () => {
    it('命中本 session → enter（source 克隆自 signal）', async () => {
      const { deps, instance, signal } = setupFork('s1')
      signal.value = { srcSessionId: 's1', fromMessageId: 'm1' }
      await nextTick()
      expect(instance.mode.value).toBe(true)
      expect(deps.log).toEqual(['enterStagingMode'])
    })

    it('不命中本 session / signal 为 null / landing 态 → 均不触发', async () => {
      const a = setupFork('s1')
      a.signal.value = { srcSessionId: 'other', fromMessageId: 'm1' }
      await nextTick()
      expect(a.instance.mode.value).toBe(false)

      a.signal.value = null
      await nextTick()
      expect(a.instance.mode.value).toBe(false)

      const b = setupFork(null)
      b.signal.value = { srcSessionId: 's1', fromMessageId: 'm1' }
      await nextTick()
      expect(b.instance.mode.value).toBe(false)
      expect(b.deps.log).toEqual([])
    })
  })

  describe('fork 形配置：asStagingAction（B 阶段缺省形态）', () => {
    it('type/isActive/allowsEmptySend/visual 与泛化前 fork 实现一致', () => {
      const { deps, instance } = setupFork()
      const action = instance.asStagingAction()

      expect(action.type).toBe('fork')
      expect(action.isActive.value).toBe(false)
      expect(action.allowsEmptySend).toBe(true)
      // fork 无 B 阶段：isInProgress 恒 false（config 未传 isInProgress）、abort undefined
      expect(action.isInProgress.value).toBe(false)
      expect(action.abort).toBeUndefined()

      instance.enter({ srcSessionId: 'src-1', fromMessageId: 'm1' })
      expect(action.isActive.value).toBe(true)
      expect(action.visual.boxClass.value).toContain('fork-mode')
      expect(action.visual.placeholder.value).toBe('panel.composer.forkHint')
      expect(action.visual.chipLabelKey).toBe('panel.composer.forkChip')
      expect(action.visual.boxClass.value).toBe(
        'fork-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring,rgba(79,142,247,0.45))] bg-[var(--accent-soft)]',
      )
    })

    it('enter 接受带 type 判别的 StagingSource 形状（cast 收窄路径）', () => {
      const { instance } = setupFork()
      instance.asStagingAction().enter({ type: 'fork', srcSessionId: 'src-1', fromMessageId: 'm9' })
      expect(instance.mode.value).toBe(true)
    })

    it('send 委托 handleSend（返回后 mode 复位）', async () => {
      const { instance, forkSessionAsk } = setupFork()
      instance.enter({ srcSessionId: 'src-1', fromMessageId: 'm1' })

      await instance.asStagingAction().send('hi')

      expect(forkSessionAsk).toHaveBeenCalledWith('src-1', 'm1', 'hi', {})
      expect(instance.mode.value).toBe(false)
    })
  })

  // ── handoff 形：检查 / 归一化 / B 阶段与泛化前 handoff-mode.ts 一致 ──────────

  describe('handoff 形配置：enter（guard + 互斥）', () => {
    it('enterGuard 命中（isSessionActive）→ toast handoffBusy + 不进入（序列零副作用）', () => {
      const { deps, instance, isSessionActive } = setupHandoff()
      isSessionActive.mockReturnValue(true)

      instance.enter({ srcSessionId: 'src-1' })

      expect(instance.mode.value).toBe(false)
      expect(deps.toastError).toHaveBeenCalledWith('panel.composer.handoffBusy')
      expect(deps.log).toEqual(['toast:panel.composer.handoffBusy'])
    })

    it('正常 enter 序列 = exitForkMode → enterStagingMode（与泛化前顺序一致：检查先于互斥）', () => {
      const { deps, instance, exitForkMode } = setupHandoff()
      deps.inputRef.value = { focus: () => {} }

      instance.enter({ srcSessionId: 'src-1' })

      expect(exitForkMode).toHaveBeenCalledTimes(1)
      expect(deps.log).toEqual(['exitForkMode', 'enterStagingMode'])
      expect(instance.mode.value).toBe(true)
    })

    it('signal 入口同样被 guard 拦截（streaming 中不进模式）', async () => {
      const { deps, instance, signal, isSessionActive } = setupHandoff('s1')
      isSessionActive.mockReturnValue(true)

      signal.value = { srcSessionId: 's1' }
      await nextTick()

      expect(instance.mode.value).toBe(false)
      expect(deps.toastError).toHaveBeenCalledWith('panel.composer.handoffBusy')
    })
  })

  describe('handoff 形配置：handleSend（兜底检查 + reply 归一化）', () => {
    it('beforeSend 兜底命中：返回 true 已消费，不清草稿不退模式不打 handoff', async () => {
      const { deps, instance, handoff, isSessionActive } = setupHandoff()
      instance.enter({ srcSessionId: 'src-1' })
      // 进入后才变 streaming（竞态窗口）
      isSessionActive.mockReturnValue(true)
      deps.log.length = 0

      expect(await instance.handleSend('备注')).toBe(true)

      expect(handoff).not.toHaveBeenCalled()
      expect(deps.log).toEqual(['toast:panel.composer.handoffBusy'])
      expect(instance.mode.value).toBe(true)
    })

    it('成功：reply = text.trim() || undefined（空文本 → undefined 不传 reply）', async () => {
      const a = setupHandoff()
      a.instance.enter({ srcSessionId: 'src-1' })
      await a.instance.handleSend('  trimmed  ')
      expect(a.handoff).toHaveBeenCalledWith('src-1', 'trimmed', {})

      const b = setupHandoff()
      b.instance.enter({ srcSessionId: 'src-1' })
      await b.instance.handleSend('   ')
      expect(b.handoff).toHaveBeenCalledWith('src-1', undefined, {})
    })

    it('失败：restoreInput 恢复原始 draft（未 trim）+ toast 交接失败 + 仍退出', async () => {
      const { deps, instance, handoff } = setupHandoff()
      instance.enter({ srcSessionId: 'src-1' })
      handoff.mockRejectedValueOnce(new Error('boom'))

      expect(await instance.handleSend('  my draft  ')).toBe(true)

      expect(deps.restoreInput).toHaveBeenCalledWith('  my draft  ')
      expect(deps.toastError).toHaveBeenCalledWith('交接失败：boom')
      expect(deps.t).toHaveBeenCalledWith('panel.message.handoffFailed', { error: 'boom' })
      expect(instance.mode.value).toBe(false)
    })

    it('成功全序列与泛化前 handleHandoffSend 一致', async () => {
      const { deps, instance } = setupHandoff()
      instance.enter({ srcSessionId: 'src-1' })
      deps.log.length = 0

      await instance.handleSend('x')

      expect(deps.log).toEqual([
        'clearInput',
        'setSending:true',
        'getStagingConfig',
        'setSending:false',
        'exitStagingMode',
      ])
    })
  })

  describe('handoff 形配置：asStagingAction（B 阶段派生）', () => {
    it('isInProgress：未进入时恒 false（不读 isHandingOff）；进入后派生自 isHandingOff(srcSessionId)', () => {
      const { instance, isHandingOff } = setupHandoff()
      isHandingOff.mockReturnValue(true)
      const action = instance.asStagingAction()

      expect(action.isInProgress.value).toBe(false)
      expect(isHandingOff).not.toHaveBeenCalled()

      instance.enter({ srcSessionId: 'src-1' })
      expect(action.isInProgress.value).toBe(true)
      expect(isHandingOff).toHaveBeenCalledWith('src-1')

      instance.exit()
      isHandingOff.mockClear()
      expect(action.isInProgress.value).toBe(false)
      expect(isHandingOff).not.toHaveBeenCalled()
    })

    it('abort 引用 = 配置注入的 abortHandoff', async () => {
      const { instance, abortHandoff } = setupHandoff()
      const action = instance.asStagingAction()
      expect(action.abort).toBe(abortHandoff)
      await action.abort!('src-1')
      expect(abortHandoff).toHaveBeenCalledWith('src-1')
    })

    it('visual/文案 key 与泛化前 handoff 实现一致', () => {
      const { instance } = setupHandoff()
      const v = instance.asStagingAction().visual

      expect(v.chipLabelKey).toBe('panel.composer.handoffChip')
      expect(v.placeholder.value).toBeNull()
      instance.enter({ srcSessionId: 'src-1' })
      expect(v.boxClass.value).toContain('handoff-mode')
      expect(v.placeholder.value).toBe('panel.composer.handoffHint')
    })
  })

  // ── 序列等价总验：fork 形与 handoff 形在同一骨架上的全链行为 ─────────────────

  describe('全链序列等价（enter → watch → esc / send）', () => {
    it('fork 形全链 log = 泛化前 fork-mode.ts 已知副作用序列', async () => {
      const { deps, instance, signal } = setupFork('s1')
      deps.inputRef.value = { focus: () => {} }

      // signal 命中进入 → esc 退出 → 再进入 → send
      signal.value = { srcSessionId: 's1', fromMessageId: 'm1' }
      await nextTick()
      expect(instance.handleEsc(escEvent())).toBe(true)
      instance.enter({ srcSessionId: 's1', fromMessageId: 'm2' })
      expect(await instance.handleSend('ask')).toBe(true)

      expect(deps.log).toEqual([
        'enterStagingMode', // signal → enter
        'clearInput', // esc
        'exitStagingMode', // esc
        'enterStagingMode', // 再进入
        'clearInput', // send
        'setSending:true',
        'getStagingConfig',
        'setSending:false',
        'exitStagingMode',
      ])
    })

    it('handoff 形全链 log = 泛化前 handoff-mode.ts 已知副作用序列（含检查与互斥）', async () => {
      const { deps, instance, signal, isSessionActive } = setupHandoff('s1')
      deps.inputRef.value = { focus: () => {} }

      // streaming 拦截 → 正常 signal 进入 → send 兜底拦截 → 再 send 成功
      isSessionActive.mockReturnValue(true)
      signal.value = { srcSessionId: 's1' }
      await nextTick()
      expect(instance.mode.value).toBe(false)

      isSessionActive.mockReturnValue(false)
      signal.value = { srcSessionId: 's1' }
      await nextTick()
      expect(instance.mode.value).toBe(true)

      isSessionActive.mockReturnValue(true)
      expect(await instance.handleSend('备注')).toBe(true)
      expect(instance.mode.value).toBe(true)

      isSessionActive.mockReturnValue(false)
      expect(await instance.handleSend('备注')).toBe(true)
      expect(instance.mode.value).toBe(false)

      expect(deps.log).toEqual([
        'toast:panel.composer.handoffBusy', // enterGuard 拦截
        'exitForkMode', // 正常 enter：互斥
        'enterStagingMode',
        'toast:panel.composer.handoffBusy', // beforeSend 兜底拦截（不清草稿不退模式）
        'clearInput', // send 成功
        'setSending:true',
        'getStagingConfig',
        'setSending:false',
        'exitStagingMode',
      ])
    })
  })
});

// ======== 来源：staging.test.ts ========
describe("staging", () => {
  // ── mock StagingAction 构造器 ─────────────────────────────────────────────────
  //
  // 每个 mock action 自带可翻转的 activeRef / inProgressRef（驱动 isActive / isInProgress 派生）
  // 与所有方法的 spy（验证路由）。默认 isInProgress=false、hasAbort=true，调用方可按场景覆写。

  interface MockSpies { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    activeRef: Ref<boolean>
    inProgressRef: Ref<boolean>
    enterSpy: ReturnType<typeof vi.fn>
    exitSpy: ReturnType<typeof vi.fn>
    sendSpy: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>
    handleEscSpy: ReturnType<typeof vi.fn<(e: KeyboardEventLike) => boolean>>
    abortSpy?: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>
  }

  interface MakeMockOpts { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
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
      .fn<(text: string) => Promise<void>>()
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

      const consumed = await api.send('hi')

      expect(consumed).toBe(false)
      expect(fork.sendSpy).not.toHaveBeenCalled()
      expect(handoff.sendSpy).not.toHaveBeenCalled()
    })

    it('fork active → send 调 fork.send，返回 true', async () => {
      const { api, fork, handoff } = setup()
      fork.activeRef.value = true

      const consumed = await api.send('hello')

      expect(consumed).toBe(true)
      expect(fork.sendSpy).toHaveBeenCalledTimes(1)
      expect(fork.sendSpy).toHaveBeenCalledWith('hello')
      expect(handoff.sendSpy).not.toHaveBeenCalled()
    })

    it('handoff active → send 调 handoff.send，返回 true', async () => {
      const { api, fork, handoff } = setup()
      handoff.activeRef.value = true

      const consumed = await api.send('hi')

      expect(consumed).toBe(true)
      expect(handoff.sendSpy).toHaveBeenCalledTimes(1)
      expect(handoff.sendSpy).toHaveBeenCalledWith('hi')
      expect(fork.sendSpy).not.toHaveBeenCalled()
    })

    // [审计候选 10] stagingConfig 三层死透传已删：useComposerStaging.send 只透传 text，
    // 暂存配置由 action 实现内部自取 getStagingConfig（staging-mode handleSend）。
    it('send 只透传 text：action.send 收到 (text) 单参（暂存配置由 action 内部自取）', async () => {
      const { api, fork } = setup()
      fork.activeRef.value = true

      await api.send('text')

      expect(fork.sendSpy).toHaveBeenCalledWith('text')
    })

    it('send action.send reject 时仍由 action 处理（这里 mock reject，send 仍 await 不吞错）', async () => {
      const { api, fork } = setup()
      fork.activeRef.value = true
      fork.sendSpy.mockRejectedValueOnce(new Error('boom'))

      // useComposerStaging.send 直接 await action.send，reject 会向上抛
      await expect(api.send('x')).rejects.toThrow('boom')
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
});
