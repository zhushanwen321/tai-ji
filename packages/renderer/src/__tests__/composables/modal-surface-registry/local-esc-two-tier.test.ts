/**
 * 局部表面两档对照基线（display-containers §6.7 局部表面 Esc 消费方登记 / §8.2 验收条款 2）。
 *
 * 对账语义（§6.7 R6 判据轴：按相对编排器执行序分档）：
 * - **先行档五成员**（CommandPopover / AmbiguousFilePopover / ScheduleForm / PlanCommentPopover /
 *   useFlatListNav）：消费即 preventDefault（defaultPrevented 约定）——逐成员真实事件驱动断言；
 * - **后行档 SessionList**（window bubble 注册晚于编排器，preventDefault 不可达）：入聚合让位
 *   （yieldsEsc ✓），开合态绑定**删除确认态本体**（SessionItem 后代确认态 ∪ folderConfirmingCwd）
 *   ——反向断言 escCount 广播计数器不参与聚合（误绑 = 全局 Esc 死键）。
 *
 * 三视角：构建者白盒（登记清单全等 + 执行序断言）+ 使用者黑盒（每用例 DOM 断言：浮条/浮层/
 * 确认态按钮的可见性与文案翻转）+ 观察者形态（真实事件序 yield→act 递进）。
 *
 * 测试框架：vitest + @vue/test-utils（真实 KeyboardEvent/MouseEvent，无 fake timer）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/modal-surface-registry/local-esc-two-tier.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref } from 'vue'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionGroup } from '@taiji/shared'
import type { ScheduleDraft, ScheduleQuestion } from '@zhushanwen/extension-protocol'

import {
  LOCAL_ESC_CONSUMERS,
  registerModalSurface,
  anyModalSurfaceYieldsEsc,
  resetModalSurfaceRegistry,
} from '@/composables/features/app/modal-surface-registry'
import { AmbiguousFilePopover, useFlatListNav } from '@taiji/ui'
import { useCommandPopoverKeyboard } from '@/composables/panel/command-popover-keyboard'
import ScheduleForm from '@/components/extension/form/ScheduleForm.vue'
import PlanCommentPopover from '@/components/panel/plan/PlanCommentPopover.vue'
import SessionList from '@/components/sidebar/SessionList.vue'
import { findRepoRoot } from './z-scan-helper'

function escEvent(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
}

// ── 对照基线登记（§6.7 扫描清单固化）────────────────────────────────────────

const EXPECTED_IDS = [
  'ambiguous-file-popover',
  'command-popover',
  'flat-list-nav',
  'plan-comment-popover',
  'schedule-form',
  'session-list-confirm',
]

describe('两档登记清单 ↔ §6.7 扫描清单全等（守卫类）', () => {
  it('六成员基线全等：五先行档 prevent-default + 一后行档 aggregate-yield', () => {
    expect(LOCAL_ESC_CONSUMERS.map((e) => e.id).sort()).toEqual(EXPECTED_IDS)
    expect(LOCAL_ESC_CONSUMERS.filter((e) => e.tier === 'first')).toHaveLength(5)
    expect(LOCAL_ESC_CONSUMERS.filter((e) => e.tier === 'second')).toHaveLength(1)
    for (const entry of LOCAL_ESC_CONSUMERS) {
      expect(entry.contract).toBe(entry.tier === 'first' ? 'prevent-default' : 'aggregate-yield')
    }
  })

  it('登记文件在盘且含 Esc 消费点（后行档另含确认态本体注册键）', () => {
    const root = findRepoRoot()
    for (const entry of LOCAL_ESC_CONSUMERS) {
      const full = join(root, entry.file)
      expect(existsSync(full), entry.file).toBe(true)
      const text = readFileSync(full, 'utf8')
      expect(text, entry.file).toContain('Escape')
      if (entry.tier === 'second') expect(text, entry.file).toContain('session-delete-confirm')
    }
  })
})

// ── 先行档：消费即 preventDefault（真实事件驱动）───────────────────────────

describe('先行档契约：消费 Esc 即 preventDefault（defaultPrevented 约定）', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('useFlatListNav（元素级）：Esc 放出 onEscape 回调且置位 defaultPrevented（DOM 计数）', async () => {
    const escaped = ref(0)
    const wrapper = mount(defineComponent({
      setup() {
        const nav = useFlatListNav({
          getTotal: () => 3,
          onActivate: () => {},
          onEscape: () => {
            escaped.value += 1
          },
        })
        return () =>
          h('div', { 'data-testid': 'navbox', onKeydown: nav.onKeydown }, [
            h('span', { 'data-testid': 'escaped' }, `esc:${escaped.value}`),
          ])
      },
    }))

    const evt = escEvent()
    wrapper.get('[data-testid="navbox"]').element.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
    await nextTick()
    expect(wrapper.get('[data-testid="escaped"]').text()).toBe('esc:1')
    wrapper.unmount()
  })

  it('AmbiguousFilePopover（window capture）：浮层候选可见 → Esc 关浮层 + defaultPrevented', async () => {
    const wrapper = mount(AmbiguousFilePopover, {
      props: {
        open: true,
        basename: 'design.md',
        candidates: [{ path: 'docs/design.md', name: 'design.md', type: 'file' }],
      },
      attachTo: document.body,
    })
    await nextTick()
    expect(document.body.textContent).toContain('design.md')

    const evt = escEvent()
    window.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
    expect(wrapper.emitted('update:open')).toContainEqual([false])
    wrapper.unmount()
  })

  it('CommandPopover 键盘层（window capture）：候选非空 Esc 关浮层 + defaultPrevented；空态按注记放行', async () => {
    const items = ref([{ name: '/deploy' }])
    const closes = ref(0)
    const wrapper = mount(defineComponent({
      setup() {
        const kb = useCommandPopoverKeyboard<{ name: string }>({
          open: () => true,
          items: () => items.value,
          onSelect: () => {},
          close: () => {
            closes.value += 1
          },
          resetKeys: () => [],
          query: () => 'deploy',
          type: () => 'slash',
          onSelectAndSend: () => {},
        })
        return () =>
          h('div', [
            h('span', { 'data-testid': 'cmd-idx' }, `idx:${kb.activeIndex.value}`),
            h('span', { 'data-testid': 'cmd-closes' }, `closes:${closes.value}`),
          ])
      },
    }))
    expect(wrapper.get('[data-testid="cmd-idx"]').text()).toBe('idx:0')

    const evt = escEvent()
    window.dispatchEvent(evt)
    expect(evt.defaultPrevented, '有候选开着 = 消费').toBe(true)
    await nextTick()
    expect(wrapper.get('[data-testid="cmd-closes"]').text()).toBe('closes:1')

    // §6.7 空态路径注记：候选为空时监听放行 Esc 交 reka 兜底（空态 = 未开无消费）
    items.value = []
    await nextTick()
    const emptyEvt = escEvent()
    window.dispatchEvent(emptyEvt)
    expect(emptyEvt.defaultPrevented, '空态放行').toBe(false)
    await nextTick()
    expect(wrapper.get('[data-testid="cmd-closes"]').text()).toBe('closes:1')
    wrapper.unmount()
  })

  it('ScheduleForm（document capture）：表单可见 → Esc 取消 + defaultPrevented', async () => {
    const draft: ScheduleDraft = {
      kind: 'recurring',
      schedule: '0 9 * * *',
      prompt: '总结昨天的工作进展',
      models: ['m-1'],
      currentModel: 'm-1',
    }
    const question: ScheduleQuestion = { type: 'schedule', question: '确认创建定时任务', initial: draft }
    const wrapper = mount(ScheduleForm, { props: { question }, attachTo: document.body })
    await nextTick()
    expect(wrapper.find('[data-testid="schedule-create-cron-chip-0 9 * * *"]').exists()).toBe(true)

    const evt = escEvent()
    document.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
    expect(wrapper.emitted('cancel')).toBeTruthy()
    wrapper.unmount()
  })

  it('PlanCommentPopover（document 级）：划选浮条可见 → Esc 关闭 + defaultPrevented（R6 回先行档锚）', async () => {
    const target = document.createElement('div')
    target.innerHTML = '<p>token 在过期前自动刷新，业务零感知</p>'
    document.body.appendChild(target)
    const wrapper: VueWrapper = mount(PlanCommentPopover, {
      props: { target, disabled: false },
      attachTo: document.body,
    })

    const para = target.querySelector('p')!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: para,
      anchorOffset: 0,
      focusNode: para,
      focusOffset: 4,
      toString: () => 'token',
      removeAllRanges: vi.fn(),
      getRangeAt: () => ({
        startContainer: para,
        endContainer: para,
        commonAncestorContainer: para,
        getBoundingClientRect: () => ({ left: 100, top: 200, width: 120, height: 20 }),
      }),
    } as unknown as Selection)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('[data-testid="plan-comment-popover"]'), '划选浮条可见').not.toBeNull()

    const evt = escEvent()
    document.dispatchEvent(evt)
    expect(evt.defaultPrevented, '消费即 preventDefault').toBe(true)
    await nextTick()
    expect(document.querySelector('[data-testid="plan-comment-popover"]'), '浮条已关').toBeNull()
    wrapper.unmount()
  })
})

// ── 后行档：SessionList 入聚合绑删除确认态本体 ─────────────────────────────

function makeGroups(): SessionGroup[] {
  return [
    {
      cwd: '/p',
      sessions: [
        { id: 's1', label: '会话 1', cwd: '/p', status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0 } as SessionGroup['sessions'][number],
      ],
    },
  ]
}

function mountList(): VueWrapper {
  return mount(SessionList, {
    props: { groups: makeGroups(), activeId: 's1', statusOf: () => 'done' as never },
    attachTo: document.body,
  })
}

describe('后行档契约：SessionList 确认态本体入聚合（yieldsEsc 让位）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetModalSurfaceRegistry()
    document.body.innerHTML = ''
  })

  it('folder 确认态开着 → 聚合让位；无确认态时 escCount 广播不误绑（反向断言）', async () => {
    const wrapper = mountList()
    await nextTick()
    expect(anyModalSurfaceYieldsEsc(), '挂载未确认 ⇒ 不让位').toBe(false)

    // 反向断言：Esc 广播计数器自增（无确认态）不得触发让位——误绑计数器 = 全局 Esc 死键
    window.dispatchEvent(escEvent())
    await nextTick()
    expect(anyModalSurfaceYieldsEsc(), 'escCount 广播与聚合解耦').toBe(false)

    const btn = wrapper.find('[data-testid="folder-delete-btn"]')
    await btn.trigger('click')
    expect(wrapper.find('[data-testid="folder-delete-btn"]').attributes('title')).toBe('确认删除此文件夹下所有会话？')
    expect(anyModalSurfaceYieldsEsc(), '确认态本体开着 ⇒ 让位').toBe(true)
    wrapper.unmount()
  })

  it('SessionItem 后代删除确认态开着 → 聚合让位（N 后代确认态聚合谓词）', async () => {
    const wrapper = mountList()
    await nextTick()
    const itemDelete = wrapper.find('.session-item button[title="删除"]')
    expect(itemDelete.exists(), 'session 删除按钮在 DOM').toBe(true)

    await itemDelete.trigger('click')
    expect(wrapper.find('.session-item button[title="确认删除？"]').exists(), '确认态 DOM').toBe(true)
    expect(anyModalSurfaceYieldsEsc(), '后代确认态 ⇒ 让位').toBe(true)

    await wrapper.find('.session-item').trigger('mouseleave')
    await nextTick()
    expect(wrapper.find('.session-item button[title="删除"]').exists(), '确认态已复位').toBe(true)
    expect(anyModalSurfaceYieldsEsc(), '确认态清 ⇒ 让位解除').toBe(false)
    wrapper.unmount()
  })

  it('真实事件序：Esc#1 只清确认态（编排器让位）→ Esc#2 才走层级序', async () => {
    // 编排器模拟（window bubble 首位注册 = AppShell 根 setup 位次，先于 SessionList 挂载）
    const decisions: string[] = []
    const onOrchestratorKeydown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) {
        decisions.push('skip-prevented')
        return
      }
      if (anyModalSurfaceYieldsEsc()) {
        decisions.push('yield')
        return
      }
      decisions.push('act')
    }
    window.addEventListener('keydown', onOrchestratorKeydown)

    const wrapper = mountList()
    await nextTick()
    await wrapper.find('[data-testid="folder-delete-btn"]').trigger('click')
    expect(wrapper.find('[data-testid="folder-delete-btn"]').attributes('title')).toBe('确认删除此文件夹下所有会话？')

    window.dispatchEvent(escEvent())
    expect(decisions, '第一次 Esc：让位（只清确认态）').toEqual(['yield'])

    await nextTick()
    expect(wrapper.find('[data-testid="folder-delete-btn"]').attributes('title'), '确认态已清').toBe('删除')
    expect(anyModalSurfaceYieldsEsc(), 'flush 后聚合已关').toBe(false)

    window.dispatchEvent(escEvent())
    expect(decisions, '第二次 Esc：层级序剥层').toEqual(['yield', 'act'])

    window.removeEventListener('keydown', onOrchestratorKeydown)
    wrapper.unmount()
  })
})
