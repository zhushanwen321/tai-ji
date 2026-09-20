/**
 * HeaderActionsHost 测试（plugin-header-action-modal-points u4b，AP-1 渲染契约）。
 *
 * 覆盖（三视角 TEST-STRATEGY §3：每条至少一个用户可见 DOM 断言）：
 * - 声明渲染 N 按钮 + testid 形态（header-action-<pluginId>-<id 段>，设计场景 1 契约）
 * - order 升序排序（缺省排后）
 * - badge ≤4 字符宿主截断 + 全文进 tooltip（AP-1 徽标契约）
 * - E13 三态：registered 可点 / unregistered 灰置 / unknown 首次缺省可点 + 保持上次值
 * - 运行时镜像 entry.disabled：true 灰置（插件业务态）/ false / undefined 不灰置；
 *   disabled=true 缺 tooltip → 「暂不可用」泛化文案（场景 12，与 unregistered 的
 *   「本会话未加载所需扩展」文案分叉），插件显式 tooltip 优先
 * - E3 点击 → executeCommand(commandId)；命令缺失（返回 false）→ 本地置灰（禁静默 no-op）；
 *   宿主重判 registered（命令重注册回来）→ 置灰让位、按钮恢复可点（F5）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/extension/HeaderActionsHost.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import HeaderActionsHost from '@/components/extension/HeaderActionsHost.vue'
import {
  HEADER_ACTIONS_SOURCE_KEY,
  type HeaderActionsSource,
  type HeaderActionCommandAvailability,
} from '@/composables/shell/useExtensionHostBridge'
import type { ContributionRecord, HeaderActionEntry } from '@taiji/core'

// ── 测试数据 ──
const schedulerAction: ContributionRecord = {
  pluginId: 'scheduler-manager',
  contributionId: 'scheduler-manager.open',
  type: 'headerAction',
  placement: 'panel.header',
  available: true,
  headerAction: { title: '定时任务', icon: 'clock', commandId: 'scheduler-manager.open', order: 20 },
}

function makeSource(overrides: Partial<HeaderActionsSource> = {}): HeaderActionsSource {
  return {
    getDeclarations: () => [schedulerAction],
    getRuntimeState: () => undefined,
    resolveCommandAvailability: () => 'registered',
    executeCommand: vi.fn(() => true),
    ...overrides,
  }
}

function mountHost(source: HeaderActionsSource, sessionId = 's1') {
  return mount(HeaderActionsHost, {
    props: { sessionId },
    global: { provide: { [HEADER_ACTIONS_SOURCE_KEY]: source } },
  })
}

describe('HeaderActionsHost', () => {
  it('按声明渲染按钮，testid 形态 = header-action-<pluginId>-<id 段>', () => {
    const wrapper = mountHost(makeSource())
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.exists()).toBe(true)
    // 用户可见断言：与内置按钮同规格 + 声明 title 兜底 tooltip
    expect(btn.classes()).toContain('size-[22px]')
    expect(btn.attributes('title')).toBe('定时任务')
    // 无 badge 时不渲染徽标
    expect(btn.find('span').exists()).toBe(false)
  })

  it('多条声明按 order 升序排序（缺省排后）', () => {
    const second: ContributionRecord = {
      pluginId: 'demo-echo',
      contributionId: 'demo-echo.ping',
      type: 'headerAction',
      placement: 'panel.header',
      available: true,
      headerAction: { title: 'Ping', icon: 'bell', commandId: 'demo-echo.ping', order: 5 },
    }
    const appended: ContributionRecord = {
      pluginId: 'late',
      contributionId: 'late.last',
      type: 'headerAction',
      placement: 'panel.header',
      available: true,
      headerAction: { title: 'Last', icon: 'bell', commandId: 'late.last' },
    }
    const source = makeSource({ getDeclarations: () => [schedulerAction, appended, second] })
    const wrapper = mountHost(source)
    const testids = wrapper.findAll('button').map((b) => b.attributes('data-testid'))
    expect(testids).toEqual([
      'header-action-demo-echo-ping',
      'header-action-scheduler-manager-open',
      'header-action-late-last',
    ])
  })

  it('badge 超过 4 字符截断显示，全文进 tooltip', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      badge: '12345',
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.text()).toBe('1234')
    expect(btn.attributes('title')).toContain('12345')
  })

  it('E13 unregistered：按钮灰置 + tooltip「本会话未加载所需扩展」', () => {
    const source = makeSource({ resolveCommandAvailability: () => 'unregistered' })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('本会话未加载所需扩展')
  })

  it('E13 unknown：首次缺省可点，tooltip「会话恢复中，暂无法判定」', () => {
    const source = makeSource({ resolveCommandAvailability: () => 'unknown' })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.attributes('title')).toBe('会话恢复中，暂无法判定')
  })

  it('E13 unknown：保持上一次 disabled 值（恢复窗口不翻转判定）', async () => {
    const availability = ref<HeaderActionCommandAvailability>('unregistered')
    const source = makeSource({ resolveCommandAvailability: () => availability.value })
    const wrapper = mountHost(source)
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeDefined()
    availability.value = 'unknown'
    await nextTick()
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeDefined()
    // 恢复后重判（registered → 可点）
    availability.value = 'registered'
    await nextTick()
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeUndefined()
  })

  it('E13 registered：运行时 tooltip 优先于声明 title', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      tooltip: '3 个启用任务',
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    expect(wrapper.find('[data-testid=header-action-scheduler-manager-open]').attributes('title')).toBe('3 个启用任务')
  })

  it('运行时镜像 entry.disabled=true 且无 tooltip：灰置 + tooltip「暂不可用」（场景 12，F6 泛化 key）', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      disabled: true,
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeDefined()
    // 灰置按钮缺插件文案时落 disabled 态泛化提示，不得落到声明 title（误导可点语义）
    expect(btn.attributes('title')).toBe('暂不可用')
  })

  it('F6 文案分叉：unregistered →「本会话未加载所需扩展」≠ 业务 disabled 缺 tooltip →「暂不可用」', () => {
    const unregistered = mountHost(makeSource({ resolveCommandAvailability: () => 'unregistered' }))
    expect(unregistered.find('[data-testid=header-action-scheduler-manager-open]').attributes('title')).toBe('本会话未加载所需扩展')

    const businessDisabled: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      disabled: true,
      updatedAt: 1,
    }
    const disabledHost = mountHost(makeSource({ getRuntimeState: () => businessDisabled }))
    expect(disabledHost.find('[data-testid=header-action-scheduler-manager-open]').attributes('title')).toBe('暂不可用')
  })

  it('运行时镜像 entry.disabled=true 且插件推了 tooltip：插件文案优先于泛化提示', () => {
    const entry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      disabled: true,
      tooltip: '调度器运行中不可配置',
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => entry })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('调度器运行中不可配置')
  })

  it('运行时镜像 entry.disabled=false：不灰置且 tooltip 仍落声明 title（现状不变）', () => {
    const disabledEntry: HeaderActionEntry = {
      headerActionId: 'scheduler-manager.open',
      pluginId: 'scheduler-manager',
      disabled: false,
      updatedAt: 1,
    }
    const source = makeSource({ getRuntimeState: () => disabledEntry })
    const wrapper = mountHost(source)
    const btn = wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.attributes('title')).toBe('定时任务')
    // 未推送运行时帧（getRuntimeState → undefined）：E13 registered 主路径可点
    const noEntry = mountHost(makeSource({ getRuntimeState: () => undefined }))
    expect(noEntry.find('[data-testid=header-action-scheduler-manager-open]').attributes('disabled')).toBeUndefined()
  })

  it('点击 → executeCommand(commandId)（执行器收到命令 id）', async () => {
    const executeCommand = vi.fn(() => true)
    const source = makeSource({ executeCommand })
    const wrapper = mountHost(source)
    await wrapper.find('[data-testid=header-action-scheduler-manager-open]').trigger('click')
    expect(executeCommand).toHaveBeenCalledWith('scheduler-manager.open')
  })

  it('E3 命令缺失（executeCommand 返回 false）→ 按钮置灰，禁静默 no-op', async () => {
    // 生产语境约束：executeCommand 返回 false ⟺ 注册表查无此命令 ⟹ availability 必为
    // unknown/unregistered（bridge 两判定同源同步）。真实可达的失败语境 = unknown
    // （会话命令分区为空），此处按 unknown 构造。
    const executeCommand = vi.fn(() => false)
    const source = makeSource({
      executeCommand,
      resolveCommandAvailability: () => 'unknown',
    })
    const wrapper = mountHost(source)
    const btn = () => wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    expect(btn().attributes('disabled')).toBeUndefined() // unknown 首次缺省可点
    await btn().trigger('click')
    expect(btn().attributes('disabled')).toBeDefined()
  })

  it('F5 E3 恢复：宿主重判 registered（命令重注册回来）→ missing 让位，按钮恢复可点', async () => {
    const availability = ref<HeaderActionCommandAvailability>('unknown')
    const source = makeSource({
      executeCommand: vi.fn(() => false),
      resolveCommandAvailability: () => availability.value,
    })
    const wrapper = mountHost(source)
    const btn = () => wrapper.find('[data-testid=header-action-scheduler-manager-open]')
    // unknown 语境点击失败 → 本地置灰
    await btn().trigger('click')
    expect(btn().attributes('disabled')).toBeDefined()
    // 命令重注册（宿主判 registered）→ 一次性失败让位于重注册事实
    availability.value = 'registered'
    await nextTick()
    expect(btn().attributes('disabled')).toBeUndefined()
    // 恢复后可正常再点击（executeCommand 收到命令 id）
    await btn().trigger('click')
    expect(source.executeCommand).toHaveBeenCalledWith('scheduler-manager.open')
  })

  it('无声明时整组件零 DOM（不挤压内置按钮）', () => {
    const source = makeSource({ getDeclarations: () => [] })
    const wrapper = mountHost(source)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('sessionId 为空（landing）不渲染', () => {
    const wrapper = mountHost(makeSource(), '')
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
