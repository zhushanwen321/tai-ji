/**
 * form-hang-fix U2：P-fh4 快照分流矩阵（设计 D2 v3——调用方侧输入不丢失防御）。
 *
 * 被测对象：domain/composer/dispatch/send.ts（routeSteer / sendActiveMessage /
 * sendLandingFirstMessage）与 submit.ts（onSteer 防御性对齐）。
 *
 * 矩阵结构（三早退 × 快照有效性 × 调用方）在调用方视角的化简：
 * - steer 三早退与 RPC 失败对调用方同格（统一表现为 steer 返回 false）——早退本体
 *   断言见 chat/__tests__/steer-input-retention.test.ts；此处 mock deps.steer 返回
 *   false 覆盖「false → 恢复」半边，返回 true 覆盖「不恢复」半边。
 * - 快照有效性两格：非空 → 现状范式（clearInput 先行 + false 时 restoreSegments）；
 *   空 + hasInput=true（inputRef 失联格）→ v3 短路（不 clearInput、不消费、原地保留）。
 * - 短路不变量独立格：sendActiveMessage 纯直发 / sendLandingFirstMessage 两落点。
 *
 * 断言以输入状态（ctrl.draft——clearInput/restoreSegments mock 联动维护）为主体，
 * 函数调用断言为辅（状态断言优先 = 「输入非空可见保留或已真投递」的直接表达）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/__tests__/steer-snapshot-short-circuit.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, ref } from 'vue'
import { segmentsToPrompt } from '@taiji/shared'
import type { Segment } from '@taiji/shared'
import { useComposerSend, type ComposerSendDeps } from '../send'
import { useComposerSubmit } from '../submit'
import type { SendRoute } from '../send-route'
import type { BashCommandExtract, StagingConfig } from '../../types'

const SEGMENTS: Segment[] = [{ type: 'text', text: 'hello' }]
const DETACHED_DRAFT = '失联窗口的输入'

/** console.warn 首参中含 key 的首行（拦截 warn 断言辅助；spy 类型宽化后参数显式收窄） */
function warnLinesOf(spy: ReturnType<typeof vi.spyOn>, key: string): string | undefined {
  return spy.mock.calls.map((c: unknown[]) => String(c[0])).find((s: string) => s.includes(key))
}

// spy = 真实签名 & vi.fn 能力（同 ../send.test.ts 斡旋模式：裸 vi.fn 推导 Mock<Procedure>
// 无法赋给具体签名字段）
type Spy<T> = T & ReturnType<typeof vi.fn>

interface Ctrl {
  canSend: boolean
  hasInput: boolean
  sendRoute: SendRoute
  variant: 'panel' | 'landing'
  draft: string
  sessionId: string | null
  inputLinked: boolean
  steerReturn: boolean
  sendReturn: boolean
}

interface Spies {
  getSegments: Spy<() => Segment[]>
  clearInput: Spy<() => void>
  restoreSegments: Spy<(segments: Segment[]) => void>
  steer: Spy<(sessionId: string, segments: Segment[]) => Promise<boolean>>
  send: Spy<(sessionId: string, segments: Segment[]) => Promise<boolean>>
  submitFirstMessage: Spy<
    (
      segments: Segment[],
      thinkingLevel?: string,
      bashCommand?: { command: string; excludeFromContext: boolean },
    ) => Promise<void>
  >
  compact: Spy<(sessionId: string, customInstructions?: string) => Promise<void>>
}

/**
 * deps 装配（参照同目录 send.test.ts setup 精简）：clearInput/restoreSegments mock
 * 联动 ctrl.draft，使「输入是否保留/恢复」可用状态断言（非函数被调）。
 */
function setupSendDeps(initial?: Partial<Ctrl>): { deps: ComposerSendDeps; spies: Spies; ctrl: Ctrl } {
  const ctrl: Ctrl = {
    canSend: false,
    hasInput: true,
    sendRoute: 'steer',
    variant: 'panel',
    draft: DETACHED_DRAFT,
    sessionId: 's1',
    inputLinked: true,
    steerReturn: true,
    sendReturn: true,
    ...initial,
  }
  const spies: Spies = {
    getSegments: vi.fn((): Segment[] => (ctrl.inputLinked ? SEGMENTS : [])) as unknown as Spies['getSegments'],
    clearInput: vi.fn(() => {
      ctrl.draft = ''
    }) as unknown as Spies['clearInput'],
    restoreSegments: vi.fn((segments: Segment[]) => {
      ctrl.draft = segmentsToPrompt(segments)
    }) as unknown as Spies['restoreSegments'],
    steer: vi.fn(async (_sessionId: string, _segments: Segment[]) => ctrl.steerReturn) as unknown as Spies['steer'],
    send: vi.fn(async (_sessionId: string, _segments: Segment[]) => ctrl.sendReturn) as unknown as Spies['send'],
    submitFirstMessage: vi.fn(
      async (
        _segments: Segment[],
        _thinkingLevel?: string,
        _bashCommand?: { command: string; excludeFromContext: boolean },
      ) => {},
    ) as unknown as Spies['submitFirstMessage'],
    compact: vi.fn(async (_sessionId: string, _customInstructions?: string) => {}) as unknown as Spies['compact'],
  }
  const deps: ComposerSendDeps = {
    staging: {
      hasActiveStaging: computed(() => false),
      send: vi.fn(async () => false),
      activeStaging: computed(() => null),
    },
    getStagingConfig: vi.fn((): StagingConfig => ({})),
    canSend: computed(() => ctrl.canSend),
    hasInput: computed(() => ctrl.hasInput),
    getSendRoute: () => ctrl.sendRoute,
    draft: computed(() => ctrl.draft),
    inputRef: computed(() =>
      ctrl.inputLinked ? { getSegments: spies.getSegments } : null,
    ) as unknown as ComposerSendDeps['inputRef'],
    sessionIdRef: computed(() => ctrl.sessionId),
    variantRef: computed(() => ctrl.variant),
    composerBash: {
      extractBashCommand: vi.fn((_t: string): BashCommandExtract => ({ type: 'not-bash' })),
      trySendBash: vi.fn(async () => false),
    },
    clearInput: spies.clearInput,
    restoreSegments: spies.restoreSegments,
    isSending: ref(false),
    flow: { submitFirstMessage: spies.submitFirstMessage },
    localThinkingLevel: ref(undefined),
    send: spies.send,
    steer: spies.steer,
    compact: spies.compact,
    enqueueCompact: vi.fn(),
    toastError: vi.fn((_msg: string) => {}),
    t: (k: string) => k,
  }
  return { deps, spies, ctrl }
}

describe('routeSteer 快照分流（B 条：steer 路由终端）', () => {
  it('快照空 + hasInput=true（inputRef 失联）→ 短路：不 clearInput 不调 steer，输入原地保留', async () => {
    // 失联格 = inputRef.value 为 null 而 draft 非空（hasInput=true）——旧范式唯一丢输入的格子
    const { deps, spies, ctrl } = setupSendDeps({ inputLinked: false })
    await useComposerSend(deps).onSend()
    expect(ctrl.draft).toBe(DETACHED_DRAFT)
    expect(spies.clearInput).not.toHaveBeenCalled()
    expect(spies.steer).not.toHaveBeenCalled()
  })

  it('快照非空 + steer false（早退/RPC 失败同格）→ restoreSegments(非空快照)：draft 可见恢复', async () => {
    const { deps, spies, ctrl } = setupSendDeps({ steerReturn: false, draft: '补充说明' })
    await useComposerSend(deps).onSend()
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
    expect(spies.restoreSegments).toHaveBeenCalledWith(SEGMENTS)
    expect(SEGMENTS.length).toBeGreaterThan(0)
    expect(ctrl.draft).toBe('hello')
  })

  it('快照非空 + steer true（真投递）→ 不恢复，draft 保持已清', async () => {
    const { deps, spies, ctrl } = setupSendDeps({ steerReturn: true, draft: '补充说明' })
    await useComposerSend(deps).onSend()
    expect(spies.steer).toHaveBeenCalledWith('s1', SEGMENTS)
    expect(spies.restoreSegments).not.toHaveBeenCalled()
    expect(ctrl.draft).toBe('')
  })
})

describe('sendActiveMessage 短路不变量 + B 策略 false 消费（C/D 条）', () => {
  it('快照空 + hasInput=true（纯直发路径）→ 短路：不 clearInput 不调 send，输入原地保留', async () => {
    // direct 路由（canSend=true）+ inputRef 失联——短路不变量第二落点
    const { deps, spies, ctrl } = setupSendDeps({
      sendRoute: 'direct',
      canSend: true,
      inputLinked: false,
    })
    await useComposerSend(deps).onSend()
    expect(ctrl.draft).toBe(DETACHED_DRAFT)
    expect(spies.clearInput).not.toHaveBeenCalled()
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('send 返回 false（B 策略转 steer 未消费）→ restoreSegments 恢复草稿', async () => {
    // send 内部 isActive → steer → 早退/RPC 失败 → false；此处经 deps.send mock 该信号
    const { deps, spies, ctrl } = setupSendDeps({ sendRoute: 'direct', canSend: true, sendReturn: false })
    await useComposerSend(deps).onSend()
    expect(spies.send).toHaveBeenCalledWith('s1', SEGMENTS)
    expect(spies.restoreSegments).toHaveBeenCalledWith(SEGMENTS)
    expect(ctrl.draft).toBe('hello')
  })

  it('send 返回 true（正常路径）→ 不恢复', async () => {
    const { deps, spies } = setupSendDeps({ sendRoute: 'direct', canSend: true, sendReturn: true })
    await useComposerSend(deps).onSend()
    expect(spies.restoreSegments).not.toHaveBeenCalled()
  })
})

describe('sendLandingFirstMessage 短路不变量（C 条第三落点）', () => {
  it('快照空 + hasInput=true（landing 态）→ 短路：不 clearInput 不调 submitFirstMessage，输入原地保留', async () => {
    // landing 态该格可达：routeStaging 非消费 pass 后 inputRef 失联而 draft 非空
    const { deps, spies, ctrl } = setupSendDeps({
      sendRoute: 'direct',
      canSend: true,
      variant: 'landing',
      inputLinked: false,
    })
    await useComposerSend(deps).onSend()
    expect(ctrl.draft).toBe(DETACHED_DRAFT)
    expect(spies.clearInput).not.toHaveBeenCalled()
    expect(spies.submitFirstMessage).not.toHaveBeenCalled()
  })
})

describe('发送拦截常驻 warn（§5 埋点去留裁决：toast 给用户、warn 给日志）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('routeStaging blocked（busy：有输入被 canSend 拦）→ warn 含 gate/route/reason/sid', async () => {
    const { deps } = setupSendDeps({ sendRoute: 'direct', canSend: false, hasInput: true })
    await useComposerSend(deps).onSend()
    const line = warnLinesOf(warnSpy, 'send blocked')
    expect(line).toContain('gate=staging-gate')
    expect(line).toContain('route=direct')
    expect(line).toContain('reason=busy')
    expect(line).toContain('sid=s1')
  })

  it('routeStaging blocked（empty-input：无输入被拦）→ warn reason=empty-input', async () => {
    const { deps } = setupSendDeps({ sendRoute: 'direct', canSend: false, hasInput: false })
    await useComposerSend(deps).onSend()
    const line = warnLinesOf(warnSpy, 'send blocked')
    expect(line).toContain('gate=staging-gate')
    expect(line).toContain('reason=empty-input')
  })

  it('routeSteer 拦截（steer 行空输入）→ warn 含 gate=steer-route/reason=empty-input', async () => {
    const { deps } = setupSendDeps({ sendRoute: 'steer', canSend: false, hasInput: false })
    await useComposerSend(deps).onSend()
    const line = warnLinesOf(warnSpy, 'send blocked')
    expect(line).toContain('gate=steer-route')
    expect(line).toContain('route=steer')
    expect(line).toContain('reason=empty-input')
  })

  it('routeSteer 拦截（isSending 双发锁）→ warn reason=double-send', async () => {
    const { deps } = setupSendDeps({ sendRoute: 'steer', canSend: false, hasInput: true })
    deps.isSending.value = true
    await useComposerSend(deps).onSend()
    const line = warnLinesOf(warnSpy, 'send blocked')
    expect(line).toContain('gate=steer-route')
    expect(line).toContain('reason=double-send')
  })

  it('正常路径无拦截 warn（false 反向：防误报噪音）', async () => {
    const { deps } = setupSendDeps({ sendRoute: 'steer', canSend: false, hasInput: true })
    await useComposerSend(deps).onSend()
    expect(warnLinesOf(warnSpy, 'send blocked')).toBeUndefined()
  })
})

describe('onSteer 防御性对齐（E 条：现状死代码，契约一致性）', () => {
  function setupSubmit(over: Partial<{ hasInput: boolean; isActive: boolean; inputLinked: boolean; steerReturn: boolean }> = {}) {
    const ctrl = { hasInput: true, isActive: true, inputLinked: true, steerReturn: true, ...over }
    // draft 先建：clearInput/restoreSegments mock 联动 draft ref（状态断言主体）
    const draft = ref(DETACHED_DRAFT)
    const spies = {
      getSegments: vi.fn((): Segment[] => (ctrl.inputLinked ? SEGMENTS : [])),
      clearInput: vi.fn(() => {
        draft.value = ''
      }),
      restoreInput: vi.fn((_text: string) => {}),
      restoreSegments: vi.fn((segments: Segment[]) => {
        draft.value = segmentsToPrompt(segments)
      }),
      steer: vi.fn(async () => ctrl.steerReturn),
      followUp: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    }
    const submit = useComposerSubmit({
      hasInput: computed(() => ctrl.hasInput),
      isActive: computed(() => ctrl.isActive),
      draft,
      inputRef: computed(() => (ctrl.inputLinked ? { getSegments: spies.getSegments } : null)),
      sessionIdRef: computed(() => 's1'),
      clearInput: spies.clearInput,
      restoreInput: spies.restoreInput,
      restoreSegments: spies.restoreSegments,
      steer: spies.steer,
      followUp: spies.followUp,
      abort: spies.abort,
    })
    return { submit, spies, ctrl, draft }
  }

  it('快照空 + hasInput=true（失联格）→ 短路：不 clearInput 不调 steer，输入原地保留', async () => {
    const { submit, spies, draft } = setupSubmit({ inputLinked: false })
    await submit.onSteer()
    expect(draft.value).toBe(DETACHED_DRAFT)
    expect(spies.clearInput).not.toHaveBeenCalled()
    expect(spies.steer).not.toHaveBeenCalled()
  })

  it('快照非空 + steer false → restoreSegments(非空快照)：draft 可见恢复', async () => {
    const { submit, spies, draft } = setupSubmit({ steerReturn: false })
    await submit.onSteer()
    expect(spies.restoreSegments).toHaveBeenCalledWith(SEGMENTS)
    expect(draft.value).toBe('hello')
  })
})
