/**
 * createStagingMode 单元测试 —— fork/handoff 泛化骨架的行为等价验证（D8 / P2）。
 *
 * 被测对象：domain/composer/dispatch/staging-mode.ts（fork-mode.ts × handoff-mode.ts
 * 约 75% 逐字镜像段收敛出的共享行为骨架）。
 *
 * 等价性证明结构（两层）：
 * 1. 本文件：用与生产 fork-mode.ts / handoff-mode.ts 逐字段同构的两份配置
 *    （同 key 字面量 / 同守卫逻辑 / 同 class 串）直接驱动骨架，以「副作用调用序列日志」
 *    断言 enter → signal watch → esc / send 全链行为序列与泛化前实现一致
 *    （预期序列从泛化前 fork-mode.ts / handoff-mode.ts 源码逐行提炼，断言方式复用
 *    handoff-mode.test.ts 的 spy + toHaveBeenCalledWith 范式）。
 * 2. 既有测试不改断言直接跑绿：handoff-mode.test.ts（41 用例，测 useComposerHandoffMode
 *    包装公共 API）+ renderer composer-fork-mode.test.ts（13 用例，测 useComposerForkMode
 *    包装面）——包装层等价的黑盒证据。
 *
 * 范式参照 handoff-mode.test.ts：直接 import composable（不 mount），全 deps mock，
 * effectScope 包裹（watch 需 active scope 以便 stop 清理）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/staging-mode.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, type Ref } from 'vue'
import type { Component } from 'vue'
import type { KeyboardEventLike, StagingConfig } from '../types'
import {
  createStagingMode,
  type StagingModeConfig,
  type StagingModeDeps,
  type StagingModeInstance,
  type StagingModeSource,
} from './staging-mode'

// ── 测试基建：全 spy deps + 副作用序列日志 ──────────────────────────────────

/** fork source 形状（与生产 fork-mode.ts 的 ForkSourceShape 同构） */
interface ForkSourceShape {
  srcSessionId: string
  fromMessageId: string
}

/** handoff source 形状（与生产 handoff-mode.ts 的 HandoffSourceShape 同构） */
interface HandoffSourceShape {
  srcSessionId: string
}

// 各 spy = 真实签名 & vi.fn 能力（裸 Mock<Procedure> 无法赋给 StagingModeDeps 具体签名）
type Spy<T> = T & ReturnType<typeof vi.fn>

interface DepsSpies extends Omit<StagingModeDeps,
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

/** 全 spy deps：每个副作用 push 标签到 log（与骨架/守卫触达的副作用一一对应） */
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
  // exitForkMode 是 extras spy（不在 StagingModeDeps 公共面），经闭包引用 deps 也记入序列日志
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
  it('enter 序列 = enterStagingMode → focus（fork 无守卫/互斥），mode 置 true', () => {
    const { deps, instance } = setupFork()
    deps.inputRef.value = { focus: () => {} }

    instance.enter({ srcSessionId: 'src-1', fromMessageId: 'm1' })

    expect(deps.log).toEqual(['enterStagingMode'])
    expect(instance.mode.value).toBe(true)
    expect(instance.modeRef.value).toBe(true)
  })

  it('enter 聚焦经 inputRef.focus 可选链（null 不抛错）', () => {
    const { instance } = setupFork()
    expect(() => instance.enter({ srcSessionId: 'src-1', fromMessageId: 'm1' })).not.toThrow()
  })

  it('modeRef getter 代理 mode ref（enter/exit 联动）', () => {
    const { instance } = setupFork()
    expect(instance.modeRef.value).toBe(false)
    instance.enter({ srcSessionId: 'src-1', fromMessageId: 'm1' })
    expect(instance.modeRef.value).toBe(true)
    instance.exit()
    expect(instance.modeRef.value).toBe(false)
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

describe('fork 形配置：signal watch 守卫（三条件与泛化前一致）', () => {
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

    await instance.asStagingAction().send('hi', { modelOverride: 'ignored' })

    expect(forkSessionAsk).toHaveBeenCalledWith('src-1', 'm1', 'hi', {})
    expect(instance.mode.value).toBe(false)
  })
})

// ── handoff 形：守卫 / 归一化 / B 阶段与泛化前 handoff-mode.ts 一致 ──────────

describe('handoff 形配置：enter（guard + 互斥）', () => {
  it('enterGuard 命中（isSessionActive）→ toast handoffBusy + 不进入（序列零副作用）', () => {
    const { deps, instance, isSessionActive } = setupHandoff()
    isSessionActive.mockReturnValue(true)

    instance.enter({ srcSessionId: 'src-1' })

    expect(instance.mode.value).toBe(false)
    expect(deps.toastError).toHaveBeenCalledWith('panel.composer.handoffBusy')
    expect(deps.log).toEqual(['toast:panel.composer.handoffBusy'])
  })

  it('正常 enter 序列 = exitForkMode → enterStagingMode（与泛化前顺序一致：守卫先于互斥）', () => {
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

describe('handoff 形配置：handleSend（兑底守卫 + reply 归一化）', () => {
  it('beforeSend 兑底命中：返回 true 已消费，不清草稿不退模式不打 handoff', async () => {
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

  it('handoff 形全链 log = 泛化前 handoff-mode.ts 已知副作用序列（含守卫与互斥）', async () => {
    const { deps, instance, signal, isSessionActive } = setupHandoff('s1')
    deps.inputRef.value = { focus: () => {} }

    // streaming 拦截 → 正常 signal 进入 → send 兑底拦截 → 再 send 成功
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
      'toast:panel.composer.handoffBusy', // beforeSend 兑底拦截（不清草稿不退模式）
      'clearInput', // send 成功
      'setSending:true',
      'getStagingConfig',
      'setSending:false',
      'exitStagingMode',
    ])
  })
})
