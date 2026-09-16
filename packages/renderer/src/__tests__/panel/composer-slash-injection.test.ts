/**
 * Composer slash 注入集成测试（Wave C，U12-U16/U18）。
 *
 * 验证 W3 引入的 `watch(() => commandStore.pendingSlash, ...)` 行为：
 *  - U12 匹配时注入 + 注入顺序（insertSlashChip 先于 clearPendingSlash）
 *  - U13 不匹配时不消费（不误清留给其他 Composer 的 pendingSlash）
 *  - U14 landing 态匹配（双方 null）
 *  - U15 watch 非 immediate（挂载时残留值不误注入）
 *  - U16 重复点击同命令触发（ts 变化驱动）
 *  - U18 split 双 Composer 竞争消费（仅目标 session 的 Composer 消费）
 *  - U19/U20 SearchModal 注入按 isSkill 分流（skill 项 → insertSkillChip；缺省 → insertSlashChip）
 *
 * 策略：
 *  - 真 pinia + 真 commandStore（需观察 pendingSlash 真实值 / clearPendingSlash 真实副作用）
 *  - mock chat/session/settings store（最小 stub，Composer 构造期读取不报错）
 *  - mock useChat / useNewTaskFlow / @/api（与现有 composer-slash-trigger 范式一致）
 *  - ComposerInput 用真实组件 vs stub：真实组件需要 contenteditable DOM，注入 spy 难以挂。
 *    改用「mock './ComposerInput.vue' factory 返回带 defineExpose(insertSlashChip: vi.fn) 的组件」，
 *    这样 Composer 的 inputRef.value.insertSlashChip 即可控 spy。其余子组件用 global.stubs 空 div。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/composer-slash-injection.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock：composable / api（与现有 Composer 测试范式一致，防真依赖构造报错）──
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    send: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    editAndResend: vi.fn(),
    hydrateHistory: vi.fn(),
  }),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, currentCwd: { value: null }, setPendingModel: vi.fn() }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })) },
  composer: {
    getMentionCandidates: vi.fn().mockResolvedValue([]),
    getFileCandidates: vi.fn().mockResolvedValue([]),
  },
  config: {
    getGlobalSkills: vi.fn().mockResolvedValue([]),
    getProjectSkills: vi.fn().mockResolvedValue([]),
    onSkillCacheInvalidated: () => () => {},
  },
}))

// ── mock chat/session/settings store：最小 stub（Composer 构造期读取 active/isStreaming 等不报错）──
// command store 保持真实（ setActivePinia 后 useCommandStore() ），便于观察 pendingSlash。
// 注意：isActive（合并态）驱动 Composer 停止按钮/steer guard，mock 返回 false（非活跃）。
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    isStreaming: ref(false),
    isActive: () => false,
    getRetryState: () => undefined,
    getQueueState: () => undefined,
    isCompacting: () => false,
    // [u6b] 发送位四态渲染即读 occupancy 投影（sendButtonState ← effectivePhase），mock 需提供
    sessionPhase: () => ({ turn: 'idle', compacting: false, bash: false }),
    getMessages: () => [],
    getOccupancy: () => ({ turn: 'idle', compacting: false, bash: false }),
  }),
}))
vi.mock('@/stores/session', () => ({
  // applySnapshot：features/useModel 乐观更新调用（切模型/思考等级后立即同步）。
  // 本测试关注 slash 注入，store 更新为 no-op 即可。
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

// ── ComposerInput mock：defineExpose 暴露 insertSlashChip / insertSkillChip 为独立 vi.fn() spy ──
// 每个测试 mount 前重新生成 spy：通过 factory 读取最新 spy 引用。
// insertSkillChip 供 pendingSlash.isSkill 分流断言（搜索注入的 skill 项不走 insertSlashChip）。
let composerInputSpies: Array<{
  insertSlashChip: ReturnType<typeof vi.fn>
  insertSkillChip: ReturnType<typeof vi.fn>
}> = []
// W4：ComposerInput 迁 ui 包（@taiji/ui/features/composer），mock 目标改 ui 包路径
vi.mock('@taiji/ui/features/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/ui/features/composer')>()
  return {
    ...actual,
    ComposerInput: defineComponent({
    name: 'ComposerInput',
    emits: ['input', 'keydown', 'slash-trigger', 'file-trigger'],
    setup() {
      const insertSlashChip = vi.fn()
      const insertSkillChip = vi.fn()
      const spy = { insertSlashChip, insertSkillChip }
      composerInputSpies.push(spy)
      return { insertSlashChip, insertSkillChip }
    },
    template: '<div data-testid="composer-input" />',
    }),
  }
})

import Composer from '@/components/panel/Composer.vue'
import { useCommandStore, __resetCommandStoreForTesting } from '@/composables/features/command/useCommandStore'

beforeEach(() => {
  setActivePinia(createPinia())
  composerInputSpies = []
  // [w5] 壳单例跨测试共享：reset 让每个用例拿到全新实例（旧 Composer watch 订阅旧实例，不再干扰）
  __resetCommandStoreForTesting()
})

/** 其他子组件空 stub（CommandPopover/AddMenuPopover/各 popover/指示位） */
const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const otherStubs = {
  CommandPopover: defineComponent({
    name: 'CommandPopover',
    template: '<div><slot /></div>',
  }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

/** mount Composer，返回 wrapper + 最近一次 ComposerInput 的 insertSlashChip / insertSkillChip spy */
function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  const wrapper = mount(Composer, {
    props,
    global: { stubs: otherStubs },
  })
  const spy = composerInputSpies.at(-1)?.insertSlashChip
  const skillSpy = composerInputSpies.at(-1)?.insertSkillChip
  if (!spy || !skillSpy) throw new Error('ComposerInput spy 未生成')
  return { wrapper, spy, skillSpy }
}

// ───────────────────────── U12 匹配时注入 + 注入顺序 ─────────────────────────

describe('Composer slash 注入 watch（Wave C）', () => {
  it('U12 匹配时注入并按序先 insert 后 clear（含 icon 透传）', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: 's1' })
    const commandStore = useCommandStore()
    const clearSpy = vi.spyOn(commandStore, 'clearPendingSlash')

    commandStore.requestSlashInjection({
      command: '/goal',
      icon: 'star',
      sessionId: 's1',
    })
    await nextTick()

    // insertSlashChip 收到 command + icon（透传）
    expect(insertSpy).toHaveBeenCalledOnce()
    expect(insertSpy).toHaveBeenCalledWith('/goal', 'star')
    // pendingSlash 被消费清空
    expect(commandStore.pendingSlash.value).toBeNull()
    expect(clearSpy).toHaveBeenCalledOnce()
    // 注入顺序：先 insertSlashChip 后 clearPendingSlash（防先清后注入读到 null）
    expect(insertSpy).toHaveBeenCalledBefore(clearSpy)
  })

  // ───────────────────────── U13 不匹配时不消费（不误清）─────────────────────────

  it('U13 不匹配 sessionId 时不消费（不误清留给其他 Composer 的请求）', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: 's1' })
    const commandStore = useCommandStore()
    const clearSpy = vi.spyOn(commandStore, 'clearPendingSlash')

    commandStore.requestSlashInjection({ command: '/x', sessionId: 's2' })
    await nextTick()

    // 不注入
    expect(insertSpy).not.toHaveBeenCalled()
    // 不清空（显式断言调用次数 0，防「无论匹配都 clear」误实现清掉 s2 的请求）
    expect(clearSpy).not.toHaveBeenCalled()
    // pendingSlash 仍非 null（留给 sid=s2 的 Composer 消费）
    expect(commandStore.pendingSlash.value).not.toBeNull()
    expect(commandStore.pendingSlash.value?.sessionId).toBe('s2')
  })

  // ───────────────────────── U14 landing 态匹配（双方 null）─────────────────────────

  it('U14 landing 态（sessionId=null）匹配 null 请求时注入', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: null, variant: 'landing' })
    const commandStore = useCommandStore()

    commandStore.requestSlashInjection({
      command: '/goal',
      icon: 'star',
      sessionId: null,
    })
    await nextTick()

    expect(insertSpy).toHaveBeenCalledOnce()
    expect(insertSpy).toHaveBeenCalledWith('/goal', 'star')
    expect(commandStore.pendingSlash.value).toBeNull()
  })

  // ───────────────────────── U15 watch 非 immediate（残留值不误注入）─────────────────────────

  it('U15 watch 非 immediate（挂载前残留 pendingSlash 不误注入）', async () => {
    const commandStore = useCommandStore()
    // 挂载前预设 pendingSlash（模拟 store 残留前一个 Composer 的请求）
    commandStore.requestSlashInjection({
      command: '/goal',
      icon: 'star',
      sessionId: 's1',
    })
    expect(commandStore.pendingSlash.value).not.toBeNull() // 预设存在

    // 然后才 mount Composer（非 immediate：初始值不应触发 watch）
    const { spy: insertSpy } = mountComposer({ sessionId: 's1' })
    await nextTick()
    await flushPromises()

    expect(insertSpy).not.toHaveBeenCalled()
    // 残留值未被本 Composer 误消费（应留给真正触发的消费时机）
    expect(commandStore.pendingSlash.value).not.toBeNull()
  })

  // ───────────────────────── U16 重复点击同命令触发（ts 变化）─────────────────────────

  it('U16 重复点击同命令（ts 变化）→ insertSlashChip 调用 2 次', async () => {
    const { spy: insertSpy } = mountComposer({ sessionId: 's1' })
    const commandStore = useCommandStore()

    // 第一次请求 → watch 触发 → insertSlashChip + clearPendingSlash（pendingSlash 变 null）
    commandStore.requestSlashInjection({ command: '/goal', icon: 'star', sessionId: 's1' })
    await nextTick()
    expect(insertSpy).toHaveBeenCalledOnce()

    // 第二次请求（ts 不同）→ pendingSlash 从 null 变非 null → watch 再触发
    // 两次请求间隔需让第一次的 watch 执行完（clearPendingSlash 已将值置 null）
    await nextTick()
    commandStore.requestSlashInjection({ command: '/goal', icon: 'star', sessionId: 's1' })
    await nextTick()

    expect(insertSpy).toHaveBeenCalledTimes(2)
    expect(commandStore.pendingSlash.value).toBeNull()
  })

  // ───────────────────────── U18 split 双 Composer 竞争消费 ─────────────────────────

  it('U18 split 双 Composer：仅目标 session 的 Composer 消费（竞争不重复注入）', async () => {
    // 同一 pinia 下 mount 两个 Composer（s1 + s2），各自 ComposerInput mock spy 独立
    const { spy: spy1 } = mountComposer({ sessionId: 's1' })
    const { spy: spy2 } = mountComposer({ sessionId: 's2' })
    const commandStore = useCommandStore()

    // 注入目标 s1
    commandStore.requestSlashInjection({ command: '/goal', sessionId: 's1' })
    await nextTick()
    await flushPromises()

    // 仅 s1 的 Composer 注入（1 次），s2 不被调
    expect(spy1).toHaveBeenCalledOnce()
    expect(spy1).toHaveBeenCalledWith('/goal', undefined)
    expect(spy2).not.toHaveBeenCalled()

    // 全局注入总次数 === 1（无重复/广播消费）
    expect(spy1.mock.calls.length + spy2.mock.calls.length).toBe(1)
    // pendingSlash 最终为 null（被 s1 消费方清一次）
    expect(commandStore.pendingSlash.value).toBeNull()
  })
})

// ───────────────── U19/U20 SearchModal 注入按 isSkill 分流（第三条 skill 入口合流）─────────────────
// pi 的 skill 命令名是裸 `skill:<name>`（无前导 /），命令通路（insertSlashChip）内 `/skill:` 前缀
// 判定为假 ⇒ 不分流会落成命令 chip。本组锁：isSkill 真 → insertSkillChip(裸名, location, icon)；
// 缺省 → 维持 insertSlashChip(命令通路回归锁)。

describe('Composer pendingSlash 按 isSkill 分流（SearchModal ⌘K 注入）', () => {
  it('U19 isSkill:true → insertSkillChip(裸名, location, icon)，不走 insertSlashChip，通道被清', async () => {
    const { spy: slashSpy, skillSpy } = mountComposer({ sessionId: 's1' })
    const commandStore = useCommandStore()

    commandStore.requestSlashInjection({
      command: 'skill:code-review',
      icon: 'star',
      sessionId: 's1',
      isSkill: true,
      location: '/skills/code-review/SKILL.md',
    })
    await nextTick()

    // 裸名（剥 `skill:` 前缀）+ location + icon 透传
    expect(skillSpy).toHaveBeenCalledOnce()
    expect(skillSpy).toHaveBeenCalledWith('code-review', '/skills/code-review/SKILL.md', 'star')
    // 命令通路未被调用（不落命令 chip）
    expect(slashSpy).not.toHaveBeenCalled()
    expect(commandStore.pendingSlash.value).toBeNull()
  })

  it('U20 回归锁：isSkill 缺省/false → 仍走 insertSlashChip，不调 insertSkillChip', async () => {
    const { spy: slashSpy, skillSpy } = mountComposer({ sessionId: 's1' })
    const commandStore = useCommandStore()

    commandStore.requestSlashInjection({ command: 'goal', icon: 'goal', sessionId: 's1', isSkill: false })
    await nextTick()

    expect(slashSpy).toHaveBeenCalledOnce()
    expect(slashSpy).toHaveBeenCalledWith('goal', 'goal')
    expect(skillSpy).not.toHaveBeenCalled()
    expect(commandStore.pendingSlash.value).toBeNull()
  })

  it('U19b isSkill:true 且 location 缺省 → insertSkillChip(裸名, undefined, icon)（不兜底不报错）', async () => {
    const { skillSpy } = mountComposer({ sessionId: 's1' })
    const commandStore = useCommandStore()

    commandStore.requestSlashInjection({
      command: 'skill:code-review',
      icon: 'star',
      sessionId: 's1',
      isSkill: true,
    })
    await nextTick()

    expect(skillSpy).toHaveBeenCalledWith('code-review', undefined, 'star')
  })
})
