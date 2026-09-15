/**
 * CommandPopover registry 合并源 单测（wave slash-command-unify TC2）。
 *
 * W3 收编（D1 归一）后 CommandPopover 两态数据源切换为 merged 结果：
 * registry 声明（contributes.slashCommands，builtin tasks goal/todo）∪ commandStore pi 真源，
 * 经壳注入的 SLASH_COMMAND_SOURCE_KEY（CommandRegistry.resolveSlashCommands 适配）消费。
 *
 * 覆盖（TC2）：
 * - panel 态：注入真 CommandRegistry（goal/todo 声明）+ commandStore 推 goal →
 *   /goal 显示且 description 元数据来自声明、/todo 被存在性交叉校验隐藏（pi 未装不显示）、
 *   /compact 前端注入保留
 * - landing 态（无 session 真源）：registry 声明即显示（slice TC2 裁决：交叉校验仅在
 *   有真源可对照时生效）+ skills 合并保留
 * - 无注入源时降级 pi-only（独立使用/测试兼容，既有 L5/U7 用例覆盖该路径）
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/command-popover-registry-merge.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage, SkillInfo } from '@taiji/shared'
import * as events from '@taiji/core/transport/api'
import { ActivationManager, CommandRegistry, InternalEventBus, type SlashCommandLike } from '@taiji/core'
import { __resetCommandStoreForTesting } from '@/composables/features/command/useCommandStore'
import CommandPopover from '@/components/panel/CommandPopover.vue'
import { SLASH_COMMAND_SOURCE_KEY } from '@/components/panel/command-popover-source'

// useCommandSync 挂载即拉 session.getCommands：mock 掉避免依赖真实 api 通道
// （全量套跑时 mock 模式标志被其他文件污染，真实 '@/api' 会解析出 MOCK_COMMANDS
// 并覆盖本测试 pushCommands 写入的受控 store 状态——单跑无症状，全量必炸）。
vi.mock('@/api', () => ({
  session: { getCommands: vi.fn().mockResolvedValue({ sessionId: '', commands: [] }) },
}))

/** 真 CommandRegistry（headless，零副作用）→ shell 注入同款 source 适配。 */
function createSlashSource(): { resolveSlashCommands: (pi: SlashCommandLike[]) => ReturnType<CommandRegistry['resolveSlashCommands']> } {
  const bus = new InternalEventBus()
  const activationManager = new ActivationManager({ trigger: { ensureActivated: async () => {} } })
  const registry = new CommandRegistry({ bus, activationManager, executor: { execute: async () => {} } })
  // builtin tasks 声明（builtin-contributions.ts 同款：goal/todo，name 无前导 /）
  registry.registerFromContribution({
    pluginId: 'tasks', contributionId: 'goal', type: 'slashCommand', placement: 'slash', available: true,
    slashCommand: { name: 'goal', description: '创建目标' },
  })
  registry.registerFromContribution({
    pluginId: 'tasks', contributionId: 'todo', type: 'slashCommand', placement: 'slash', available: true,
    slashCommand: { name: 'todo', description: '创建任务' },
  })
  return { resolveSlashCommands: (pi) => registry.resolveSlashCommands(pi) }
}

/** reka-ui PopoverContent teleport 到 body：在 body 内找命令项行（v-for 渲染为 .cmd-row div）。 */
function bodyItemButtons(): HTMLElement[] {
  const list = document.body.querySelector('.max-h-\\[180px\\]')
  return Array.from((list ?? document.body).querySelectorAll('.cmd-row'))
}

const GLOBAL_SKILLS: SkillInfo[] = [
  { id: 'sk-code-review', name: 'code-review', description: '审查代码变更', enabled: true, source: 'agents', triggers: ['review'], effective: true },
  { id: 'sk-diagnose', name: 'diagnose', description: '诊断 bug', enabled: true, source: 'agents', triggers: ['diagnose'], effective: true },
]

beforeEach(() => {
  setActivePinia(createPinia())
  __resetCommandStoreForTesting()
})

describe('CommandPopover registry 合并源（TC2）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  function mountWithSource(props: Record<string, unknown>): void {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: props as never,
      global: { provide: { [SLASH_COMMAND_SOURCE_KEY as symbol]: createSlashSource() } },
    })
  }

  /** 推 session.commands 到 commandStore（pi 真源存在性信息，保留订阅链路）。 */
  function pushCommands(sessionId: string, commands: Array<{ name: string; description?: string; source?: string }>): void {
    const msg = { type: 'session.commands', payload: { sessionId, commands } } as ServerMessage<'session.commands'>
    events.dispatchSession(sessionId, msg)
  }

  it('TC2a: panel 态 merged 源——commandStore 推 goal（缺 todo）→ 显示 /goal（description 取声明）+ /todo 交叉校验隐藏 + /compact 保留', async () => {
    mountWithSource({ open: true, type: 'slash', variant: 'panel', sessionId: 's1', query: '' })
    await flushPromises()
    // pi 真源：有 goal 无 todo（模拟 pi-goal 已装、pi-todo 未装）
    pushCommands('s1', [{ name: 'goal', description: 'pi 侧 goal 描述', source: 'extension' }])
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // compact + goal = 2 项（todo 声明侧存在但 pi 无 → 隐藏）
    expect(btns).toHaveLength(2)
    // /goal 显示且 description 元数据来自声明（'创建目标' 非 'pi 侧 goal 描述'）
    const goalRow = btns.find((b) => b.textContent?.includes('/goal'))
    expect(goalRow).toBeTruthy()
    expect(goalRow!.textContent).toContain('创建目标')
    expect(goalRow!.textContent).not.toContain('pi 侧 goal 描述')
    // /todo 不显示（交叉校验：仅声明侧存在 → 隐藏）
    expect(btns.some((b) => b.textContent?.includes('todo'))).toBe(false)
    // /compact 前端注入保留
    expect(btns.some((b) => b.textContent?.includes('/compact'))).toBe(true)
  })

  it('TC2b: landing 态（无 session 真源）→ registry 声明即显示（/goal /todo）+ skills 合并保留', async () => {
    mountWithSource({ open: true, type: 'slash', variant: 'landing', sessionId: undefined, query: '', globalSkills: GLOBAL_SKILLS })
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // goal + todo（声明即显示，slice TC2 裁决）+ 2 skills = 4 项
    expect(btns).toHaveLength(4)
    const texts = btns.map((b) => b.textContent ?? '')
    expect(texts.some((t) => t.includes('goal'))).toBe(true)
    expect(texts.some((t) => t.includes('todo'))).toBe(true)
    // description 元数据来自声明
    expect(texts.some((t) => t.includes('创建目标'))).toBe(true)
    // skills 合并保留（显示名去 /skill: 前缀）
    expect(texts.some((t) => t.includes('code-review'))).toBe(true)
    expect(texts.some((t) => t.includes('diagnose'))).toBe(true)
  })

  it('TC2c: landing 态有 session 真源且含 goal → merged（goal 去重元数据取声明）+ skills 合并', async () => {
    mountWithSource({ open: true, type: 'slash', variant: 'landing', sessionId: 'pub', query: '', globalSkills: GLOBAL_SKILLS })
    await flushPromises()
    pushCommands('pub', [{ name: 'goal', description: 'pi desc', source: 'extension' }])
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // goal（both，去重 1 项）+ todo（声明侧，pi 有真源可对照 → 隐藏）+ 2 skills = 3 项
    expect(btns).toHaveLength(3)
    const texts = btns.map((b) => b.textContent ?? '')
    // goal 只出现一次（声明 ∪ pi 去重）
    expect(texts.filter((t) => t.includes('goal')).length).toBe(1)
    // 元数据取声明
    expect(texts.some((t) => t.includes('创建目标'))).toBe(true)
    expect(texts.some((t) => t.includes('code-review'))).toBe(true)
  })
})
