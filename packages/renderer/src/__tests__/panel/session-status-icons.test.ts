
/**
 * Session status icons 扩展状态回归测试。
 *
 * 覆盖 cw-2026-07-15-session-status-icons 新增状态：
 * - streaming / pending / compacting / waiting / retrying 派生正确
 * - DOT_CLASS / STATUS_ICON 映射完整
 * - SessionItem 列表主行按状态渲染左侧 7px icon（单一 icon 范式）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/session-status-icons.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import { useChatStore } from '@/stores/chat'
import { DOT_CLASS, deriveStatus, STATUS_ICON } from '@/composables/logic/sessionStatus'
import type { DerivedStatus } from '@/types'

describe('session status icons extended states', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('DOT_CLASS 包含所有扩展状态', () => {
    const statuses: DerivedStatus[] = [
      'streaming',
      'pending',
      'compacting',
      'waiting',
      'retrying',
      'working',
      'done',
      'stopped',
      'error',
    ]
    for (const s of statuses) {
      expect(DOT_CLASS[s]).toBeDefined()
    }
  })

  it('STATUS_ICON 包含所有扩展状态', () => {
    const statuses: DerivedStatus[] = [
      'streaming',
      'pending',
      'compacting',
      'waiting',
      'retrying',
      'working',
      'done',
      'stopped',
      'error',
    ]
    for (const s of statuses) {
      expect(STATUS_ICON[s]).toBeDefined()
      expect(STATUS_ICON[s].icon).toBeDefined()
      expect(STATUS_ICON[s].color).toBeDefined()
    }
  })

  it('pendingSend 派生为 pending', () => {
    const chat = useChatStore()
    chat.addPendingSend('sid')
    expect(deriveStatus('sid', chat, true)).toBe('pending')
  })

  it('compacting 派生为 compacting', () => {
    const chat = useChatStore()
    chat.setOccupancy('sid', { turn: 'idle', compacting: true, bash: false })
    expect(deriveStatus('sid', chat, false, true)).toBe('compacting')
  })

  it('hasBackgroundWork=true 且非活跃 派生为 working', () => {
    const chat = useChatStore()
    expect(deriveStatus('sid', chat, false, false, true)).toBe('working')
  })

  it('streaming 优先于 working（主 turn 流式时不被 working 抢占）', () => {
    const chat = useChatStore()
    // isGenerating 经 messages 含 status='streaming' 派生（无 setter），构造 streaming 消息触发
    chat.setMessages('sid', [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, status: 'streaming' },
    ])
    expect(deriveStatus('sid', chat, true, false, true)).toBe('streaming')
  })

  it('working 优先于 pending（isActive 但非 streaming 时 working 抢先）', () => {
    const chat = useChatStore()
    // pendingSend → isActive=true，但非 isGenerating 非 streaming；hasBackgroundWork=true → working 先于 pending
    chat.addPendingSend('sid')
    expect(deriveStatus('sid', chat, true, false, true)).toBe('working')
  })

  it('streaming 状态 SessionItem 渲染 running badge（spec §5.6A D12 列表主行范式）', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: { id: '1', label: 'x', cwd: '/a', lastActiveAt: 0, status: 'active' },
        active: false,
        status: 'streaming',
      },
    })
    // streaming → 左侧 spinning icon（旋转箭头）
    const icon = wrapper.find('[data-testid="session-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.find('.animate-spin').exists()).toBe(true)
  })

  it('waiting 状态 SessionItem 渲染 waiting … badge', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: { id: '1', label: 'x', cwd: '/a', lastActiveAt: 0, status: 'active' },
        active: false,
        status: 'waiting',
      },
    })
    const icon = wrapper.find('[data-testid="session-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.find('.bg-warn').exists()).toBe(true)
  })

  it('error 状态 SessionItem 渲染 ! 胶囊 badge（danger，需用户介入）', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: { id: '1', label: 'x', cwd: '/a', lastActiveAt: 0, status: 'active' },
        active: false,
        status: 'error',
      },
    })
    // error → danger 实心圆 icon
    const icon = wrapper.find('[data-testid="session-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.find('.bg-danger').exists()).toBe(true)
  })

  it('done / stopped 状态 SessionItem 无 badge（仅耗时文字）', () => {
    for (const status of ['done', 'stopped'] as const) {
      const wrapper = mount(SessionItem, {
        props: {
          session: { id: '1', label: 'x', cwd: '/a', lastActiveAt: 0, status: 'active' },
          active: false,
          status,
        },
      })
      // 终态：左侧显示 success icon（done）或 neutral-dim icon（stopped），右侧仅时间文字
      expect(wrapper.find('[data-testid="session-icon"]').exists()).toBe(true)
      if (status === 'done') {
        expect(wrapper.find('.bg-success').exists()).toBe(true)
      } else {
        expect(wrapper.find('.border-neutral-dim').exists()).toBe(true)
      }
    }
  })

  it('dead 状态 isDead 抑制 badge（整行 opacity-50 表达，无任何状态 badge）', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: { id: '1', label: 'x', cwd: '/a', lastActiveAt: 0, status: 'dead' },
        active: false,
        status: 'dead',
      },
    })
    // dead → 左侧 neutral-dim 实心圆 50%，整行 opacity-50
    const icon = wrapper.find('[data-testid="session-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.find('.bg-neutral-dim').exists()).toBe(true)
    expect(icon.find('.opacity-50').exists()).toBe(true)
    expect(wrapper.find('.session-item').classes()).toContain('opacity-50')
  })
})
