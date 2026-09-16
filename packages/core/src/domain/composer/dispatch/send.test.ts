/**
 * useComposerSend 单元测试（u5b D6 统一分发器 → 投递所有权内核 u3b/D1 收敛统一 submit）。
 *
 * 被测对象：domain/composer/dispatch/send.ts —— Composer onSend 统一分发入口
 * （Enter / Alt+Enter / 发送按钮共用）。
 * 职责：staging > canSend 守卫 > staging.send > landing > bash > /compact > send
 * （统一 submit）+ 失败 restoreSegments 回滚。
 *
 * [u3b/D1 改造] getSendRoute / steer / enqueueCompact 三 deps 退役（lane 判定收归 runtime
 * 内核，renderer 不再判定车道）：steer 路由与 defer 入队两分支删除，终端统一 deps.send
 * （useChat.send：乐观气泡 + delivery.submit）。canSend 守卫语义收窄为「可提交」
 * （hasInput ∧ ¬isSending——占用不再拦截，内核排队取代拦截/拒绝）；busy 期命令拒绝退役。
 *
 * 发送位预测表六行的纯函数断言见 ./send-route.test.ts；本文件锁定分发器行为。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/send.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useComposerSend, type ComposerSendDeps } from './send'
import type { BashCommandExtract } from '../types'
import type { StagingAction, StagingConfig } from '../types'
import type { Segment } from '@taiji/shared'

interface DepsControl {
  canSend: boolean
  hasInput: boolean
  hasActiveStaging: boolean
  activeStagingAllowsEmpty: boolean
  variant: 'panel' | 'landing'
  draft: string
  sessionId: string | null
  stagingSendReturn: boolean
  bashTryReturn: boolean
  bashExtract: BashCommandExtract
  localThinkingLevel: string | undefined
}

// 各 spy = 真实签名（ComposerSendDeps 对应成员类型）& vi.fn 能力：
// 裸 vi.fn 推导 Mock<Procedure> 无法赋给具体签名字段
type Spy<T> = T & ReturnType<typeof vi.fn>

interface Spies {
  stagingSend: Spy<(text: string, staging: StagingConfig) => Promise<boolean>>
  getStagingConfig: Spy<() => StagingConfig>
  clearInput: Spy<() => void>
  restoreSegments: Spy<(segments: Segment[]) => void>
  submitFirstMessage: Spy<ComposerSendDeps['flow']['submitFirstMessage']>
  send: Spy<(sessionId: string, segments: Segment[]) => Promise<void>>
  compact: Spy<(sessionId: string, customInstructions?: string) => Promise<void>>
  toastError: Spy<(msg: string) => void>
  trySendBash: Spy<(rawText: string) => Promise<boolean>>
  extractBashCommand: Spy<(text: string) => BashCommandExtract>
  getSegments: Spy<() => Segment[]>
}

const SEGMENTS: Segment[] = [{ type: 'text', text: 'hello' }] as unknown as Segment[]

function setup(initial?: Partial<DepsControl>): { deps: ComposerSendDeps; spies: Spies; ctrl: DepsControl } {
  const ctrl: DepsControl = {
    canSend: true,
    hasInput: true,
    hasActiveStaging: false,
    activeStagingAllowsEmpty: false,
    variant: 'panel',
    draft: 'hello',
    sessionId: 's1',
    stagingSendReturn: false,
    bashTryReturn: false,
    bashExtract: { type: 'not-bash' },
    localThinkingLevel: undefined,
    ...initial,
  }
  const spies: Spies = {
    stagingSend: vi.fn(async () => ctrl.stagingSendReturn) as unknown as Spies['stagingSend'],
    getStagingConfig: vi.fn((): StagingConfig => ({})),
    clearInput: vi.fn(() => {}),
    restoreSegments: vi.fn((_segments: Segment[]) => {}),
    submitFirstMessage: vi.fn(async () => {}) as unknown as Spies['submitFirstMessage'],
    send: vi.fn(async (_sessionId: string, _segments: Segment[]) => {}),
    compact: vi.fn(async (_sessionId: string, _customInstructions?: string) => {}),
    toastError: vi.fn((_msg: string) => {}),
    trySendBash: vi.fn(async (_rawText: string) => ctrl.bashTryReturn),
    extractBashCommand: vi.fn((_text: string) => ctrl.bashExtract),
    getSegments: vi.fn((): Segment[] => SEGMENTS),
  }
  const isSending = ref(false)
  const deps: ComposerSendDeps = {
    staging: {
      hasActiveStaging: computed(() => ctrl.hasActiveStaging),
      send: spies.stagingSend,
      activeStaging: computed(() =>
        ctrl.hasActiveStaging
          ? ({ allowsEmptySend: ctrl.activeStagingAllowsEmpty } as unknown as StagingAction)
          : null,
      ),
    },
    getStagingConfig: spies.getStagingConfig,
    canSend: computed(() => ctrl.canSend),
    hasInput: computed(() => ctrl.hasInput),
    draft: computed(() => ctrl.draft),
    inputRef: computed(() => ({ getSegments: spies.getSegments })) as unknown as ComposerSendDeps['inputRef'],
    sessionIdRef: computed(() => ctrl.sessionId),
    variantRef: computed(() => ctrl.variant),
    composerBash: {
      extractBashCommand: spies.extractBashCommand,
      trySendBash: spies.trySendBash,
    },
    clearInput: spies.clearInput,
    restoreSegments: spies.restoreSegments,
    isSending,
    flow: { submitFirstMessage: spies.submitFirstMessage },
    localThinkingLevel: ref(ctrl.localThinkingLevel),
    send: spies.send,
    compact: spies.compact,
    toastError: spies.toastError,
    t: ((k: string) => k) as ComposerSendDeps['t'],
  }
  return { deps, spies, ctrl }
}

describe('useComposerSend.onSend', () => {
  it('① 守卫拦截：canSend=false + 非 staging 活跃 → return，不调任何发送', async () => {
    const { deps, spies } = setup({ canSend: false, hasActiveStaging: false })
    await useComposerSend(deps).onSend()
    expect(spies.stagingSend).not.toHaveBeenCalled()
    expect(spies.send).not.toHaveBeenCalled()
    expect(spies.compact).not.toHaveBeenCalled()
  })

  it('①b [GUI 快修④] blocked 不再静默：有输入被拦 → toast「占用中」反馈（区分空输入）', async () => {
    // [u3b] canSend=false 语义 = 双发锁期（isSending）——占用期发送已合法（内核排队），
    // 守卫只剩双发锁一类「有输入被拦」形态。
    const { deps, spies } = setup({ canSend: false, hasActiveStaging: false, hasInput: true })
    await useComposerSend(deps).onSend()
    expect(spies.toastError).toHaveBeenCalledTimes(1)
    expect(spies.toastError).toHaveBeenCalledWith('panel.composer.sendBusy')
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('①c [GUI 快修④] 空输入被拦 → toast「请输入内容」反馈（不再无响应）', async () => {
    const { deps, spies } = setup({ canSend: false, hasActiveStaging: false, hasInput: false, draft: '' })
    await useComposerSend(deps).onSend()
    expect(spies.toastError).toHaveBeenCalledWith('panel.composer.sendEmptyHint')
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('② staging.hasActiveStaging + send 返回 true → 消费 staging，不走普通 send', async () => {
    const { deps, spies } = setup({ hasActiveStaging: true, stagingSendReturn: true })
    await useComposerSend(deps).onSend()
    expect(spies.stagingSend).toHaveBeenCalledWith('hello', {})
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('②b staging 活跃 + isSending=true（双发锁）→ 拦截，不调 staging.send', async () => {
    // isSending 是 staging 发送唯一忙锁：fork/handoff 发送自身置位期间禁止重入。
    // 真实链路 isSending=true → canSend 必为 false（canSend=hasInput∧¬isSending），mock 同组合。
    const { deps, spies } = setup({ canSend: false, hasActiveStaging: true, stagingSendReturn: true })
    ;(deps.isSending as unknown as { value: boolean }).value = true
    await useComposerSend(deps).onSend()
    expect(spies.stagingSend).not.toHaveBeenCalled()
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('②c staging 活跃 + canSend=false + allowsEmptySend=false → 拦截（fork 空文本不允许）', async () => {
    const { deps, spies } = setup({ canSend: false, hasActiveStaging: true, activeStagingAllowsEmpty: false })
    await useComposerSend(deps).onSend()
    expect(spies.stagingSend).not.toHaveBeenCalled()
  })

  // ── [u3b/D1] 统一 submit：车道判定退役，终端收敛 deps.send ──

  it('②d RET: steer/defer 路由退役——不分车道，终端统一 send（统一 submit，D1）', async () => {
    // 前身：sendRoute='steer' → deps.steer / sendRoute='defer' → enqueueCompact。
    // 收敛后 onSend 不再有车道分支——调度器层不存在「按车道走不同终端」的输入。
    const { deps, spies } = setup({ draft: '普通消息' })
    await useComposerSend(deps).onSend()
    expect(spies.send).toHaveBeenCalledWith('s1', SEGMENTS)
    expect(spies.toastError).not.toHaveBeenCalled()
  })

  it('②i [D4-c] staging 提交载荷 = segmentsToPrompt(segments)——命令 chip 在中部时归位产物以 /cmd 开首', async () => {
    // 载荷必须用 segmentsToPrompt（slash 段归位提首 + 边界空格）——防止 fork/handoff
    // staged prompt 中 /cmd 不在行首被 pi 当字面文本（命令静默失效）。
    // [轮 3 注释校正] fixture 的 draft: '任务描述/compact' 是**构造值，生产不可达**：真实
    // getText() 走 segmentsToText，产出（已归位 + 边界空格）'/compact 任务描述'。此构造值
    // 专门锁定「判定源不得退回 draft.value」。
    const midSlashSegments: Segment[] = [
      { type: 'text', text: '任务描述' },
      { type: 'slash', name: 'compact' },
    ]
    const { deps, spies } = setup({
      hasActiveStaging: true,
      stagingSendReturn: true,
      draft: '任务描述/compact',
    })
    spies.getSegments.mockReturnValue(midSlashSegments)
    await useComposerSend(deps).onSend()
    const payload = spies.stagingSend.mock.calls[0]![0]
    expect(payload.startsWith('/compact')).toBe(true)
    expect(spies.send).not.toHaveBeenCalled()
  })

  // ── [u3b/D1] 占用期发送 = 统一 submit 的常态路径（busy 拦截/命令拒绝退役）──

  it('③ RET: 命令拒绝退役——`/` 前缀命令文本占用期照常统一 submit（与 idle 态同语义）', async () => {
    // 前身：defer 路由对 `/` 前缀 toast commandQueuedRejected（命令无法延迟重放）。
    // 内核化后命令文本作为普通消息提交（内核排队/入槽，pi 侧处理），与 idle 态行为对齐。
    // 非 /compact 命令（/review）不经 compact 拦截（⑨ 系锁定）→ 终端统一 send。
    const { deps, spies } = setup({ draft: '/review later' })
    spies.getSegments.mockReturnValue([
      { type: 'slash', name: 'review' },
      { type: 'text', text: 'later' },
    ])
    await useComposerSend(deps).onSend()
    expect(spies.send).toHaveBeenCalledTimes(1)
    expect(spies.toastError).not.toHaveBeenCalled()
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
  })

  it('④ bash 分流不动：`!` 前缀占用期仍走 trySendBash（bash/slash 守卫不动，§3.1 终态图首行）', async () => {
    const { deps, spies } = setup({ draft: '!ls', bashTryReturn: true })
    await useComposerSend(deps).onSend()
    expect(spies.trySendBash).toHaveBeenCalledWith('!ls')
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('⑥ landing + bash empty → return，不提交', async () => {
    const { deps, spies } = setup({ variant: 'landing', bashExtract: { type: 'empty' } })
    await useComposerSend(deps).onSend()
    expect(spies.submitFirstMessage).not.toHaveBeenCalled()
    expect(spies.clearInput).not.toHaveBeenCalled()
  })

  it('⑦ landing + 普通首发 → submitFirstMessage(segments, thinkingLevel, undefined)', async () => {
    const { deps, spies } = setup({
      variant: 'landing',
      localThinkingLevel: 'high',
      bashExtract: { type: 'not-bash' },
    })
    await useComposerSend(deps).onSend()
    expect(spies.submitFirstMessage).toHaveBeenCalledWith(SEGMENTS, 'high', undefined)
    expect(spies.clearInput).toHaveBeenCalledTimes(1)
  })

  it('⑦b landing + bash command → submitFirstMessage 传 bashExtract（结构含 command/exclude）', async () => {
    // 源码：bashCommand = bashExtract.type === 'command' ? bashExtract : undefined
    // 直接传整个 bashExtract 对象（含 type 字段，结构上满足 {command, excludeFromContext} 契约）
    const bashExtract: BashCommandExtract = { type: 'command', command: 'ls', excludeFromContext: false }
    const { deps, spies } = setup({ variant: 'landing', bashExtract })
    await useComposerSend(deps).onSend()
    expect(spies.submitFirstMessage).toHaveBeenCalledWith(SEGMENTS, undefined, bashExtract)
  })

  it('⑧ direct + trySendBash 命中 → return，普通 send 不调', async () => {
    const { deps, spies } = setup({ variant: 'panel', bashTryReturn: true, draft: '!ls' })
    await useComposerSend(deps).onSend()
    expect(spies.trySendBash).toHaveBeenCalledWith('!ls')
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('⑨c [D4-c] 命令 chip 在中部的 /compact → segmentsToPrompt 归位后仍拦截（DOM 序文本不以 /compact 起头）', async () => {
    // 判定源 = segmentsToPrompt（slash 段归位提首）：产物以 '/compact ' 起首 → 拦截命中，
    // args = 命令后剩余全部文本（D4-e：维持现状协议语义，args 恒为命令后的剩余全部文本含
    // 命令 chip 之前的正文）。
    // [轮 3 注释校正] fixture 的 draft: '整理一下/compact focus on auth' 是**构造值，生产
    // 不可达**：真实 getText() 走 segmentsToText，产出（已归位）'/compact 整理一下focus on auth'。
    const midSlashSegments: Segment[] = [
      { type: 'text', text: '整理一下' },
      { type: 'slash', name: 'compact' },
      { type: 'text', text: 'focus on auth' },
    ]
    const { deps, spies } = setup({
      variant: 'panel',
      draft: '整理一下/compact focus on auth',
    })
    spies.getSegments.mockReturnValue(midSlashSegments)
    await useComposerSend(deps).onSend()
    // 归位产物 = '/compact 整理一下focus on auth'（slash→text 补边界空格，text→text 不补），
    // args（slice 后）= 命令后剩余全部文本。
    expect(spies.compact).toHaveBeenCalledWith('s1', '整理一下focus on auth')
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('⑨ `/compact` 命令 → compact(sessionId, undefined)（slash 守卫不动）', async () => {
    // [D4-c] 判定源已迁 segmentsToPrompt：mock segments 提供对应 slash 段保持语义真实。
    const { deps, spies } = setup({ variant: 'panel', draft: '/compact' })
    spies.getSegments.mockReturnValue([{ type: 'slash', name: 'compact' }])
    await useComposerSend(deps).onSend()
    expect(spies.compact).toHaveBeenCalledWith('s1', undefined)
    expect(spies.send).not.toHaveBeenCalled()
  })

  it('⑨b `/compact x` 带参数 → compact 传 customInstructions', async () => {
    const { deps, spies } = setup({ variant: 'panel', draft: '/compact focus on auth' })
    spies.getSegments.mockReturnValue([
      { type: 'slash', name: 'compact' },
      { type: 'text', text: 'focus on auth' },
    ])
    await useComposerSend(deps).onSend()
    expect(spies.compact).toHaveBeenCalledWith('s1', 'focus on auth')
  })

  it('⑩ 普通发送 → send(sessionId, segments)（统一 submit 终端）', async () => {
    const { deps, spies } = setup({ variant: 'panel', draft: 'hello' })
    await useComposerSend(deps).onSend()
    expect(spies.send).toHaveBeenCalledWith('s1', SEGMENTS)
    expect(spies.compact).not.toHaveBeenCalled()
  })

  it('⑪ 普通发送失败 → restoreSegments + toastError 回滚', async () => {
    const { deps, spies } = setup({ variant: 'panel', draft: 'hello' })
    spies.send.mockRejectedValueOnce(new Error('boom'))
    await useComposerSend(deps).onSend()
    expect(spies.restoreSegments).toHaveBeenCalledWith(SEGMENTS)
    expect(spies.toastError).toHaveBeenCalledWith('panel.panel.sendFailed')
  })

  it('⑫ landing 首发失败 → restoreSegments + toastError', async () => {
    const { deps, spies } = setup({ variant: 'landing' })
    spies.submitFirstMessage.mockRejectedValueOnce(new Error('landing fail'))
    await useComposerSend(deps).onSend()
    expect(spies.restoreSegments).toHaveBeenCalledWith(SEGMENTS)
    expect(spies.toastError).toHaveBeenCalledWith('panel.panel.taskFailed')
  })
})
