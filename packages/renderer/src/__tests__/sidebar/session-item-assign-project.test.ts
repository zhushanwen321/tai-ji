/**
 * SessionItem 归入项目菜单测试（review MF-7）+ 未读圆点（S-5）。
 *
 * 覆盖（D14 语义修正 2026-08-04 新交互 + 新 emit 契约 setProject）：
 *  - 菜单项 = 「默认项目」（id=''）+ 全部命名 project（空名 project 不出现，按 p.name 过滤）
 *  - 点击选项 emit setProject {sessionId, projectId} 且菜单关闭（归类可逆，无两段确认）
 *  - 当前归属项 accent 高亮：命名归属 → 对应项；未归类（projectId undefined）→ 默认项目项
 *    （review S-2：默认项 id='' 与 undefined 归一匹配）
 *  - 未读标记：unread → session-unread-dot（7px accent 圆点叠在 icon 右上角）；非未读 → 无标记
 *
 * 菜单经 reka PopoverPortal teleport 到 body（同 command-popover-landing 范式：
 * attachTo: document.body + document.body 查询）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-item-assign-project.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'

function mountItem(sessionOverrides: Record<string, unknown> = {}, projectId?: string) {
  return mount(SessionItem, {
    attachTo: document.body,
    props: {
      session: {
        id: 's1',
        label: '会话 1',
        cwd: '/p',
        lastActiveAt: 0,
        ...sessionOverrides,
        ...(projectId !== undefined ? { projectId } : {}),
      },
      active: false,
      status: 'done' as never,
    },
  })
}

/** 打开归入项目菜单并返回 body 中的选项元素数组（可指定 session 归属 projectId） */
async function openAssignMenu(projectId?: string): Promise<HTMLElement[]> {
  const wrapper = mountItem({}, projectId)
  await wrapper.find('[data-testid="assign-project-btn"]').trigger('click')
  await nextTick()
  return Array.from(document.body.querySelectorAll('[data-testid="assign-project-option"]'))
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SessionItem 未读圆点（review S-5）', () => {
  it('unread=true → 渲染 session-unread-dot（bg-accent 实心）', () => {
    localStorage.setItem('taiji:session-markers', JSON.stringify({ s1: { unread: true } }))
    const wrapper = mountItem()
    const dot = wrapper.find('[data-testid="session-unread-dot"]')
    expect(dot.exists()).toBe(true)
    expect(dot.classes()).toContain('bg-accent')
  })

  it('unread=false → 不渲染 unread dot，7px 状态 icon 存在', () => {
    // 注意：markers 模块级 cache 只 hydrate 一次（首查即定），此用例用另一 session id 避免读到上例缓存
    const wrapper = mountItem({ id: 's2' })
    expect(wrapper.find('[data-testid="session-unread-dot"]').exists()).toBe(false)
    // 新范式：状态 icon 始终存在（7px 单一 icon 范式），无透明占位 span
    expect(wrapper.find('[data-testid="session-icon"]').exists()).toBe(true)
  })
})

describe('SessionItem 归入项目菜单（review MF-7）', () => {
  it('菜单项 = 「默认项目」+ 全部命名 project（空名 project 不出现）', async () => {
    const store = useProjectStore()
    store.projects = [
      { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
      { id: 'p1', name: 'Alpha', lastUsedAt: 0 },
      { id: 'p2', name: 'Beta', lastUsedAt: 0 },
      // 非规范 id 的空名 project：assignTargets 按 p.name 过滤，不应出现
      { id: 'p-empty', name: '', lastUsedAt: 0 },
    ]
    store.activeProjectId = 'p1'

    const options = await openAssignMenu()
    expect(options.map((o) => o.textContent)).toEqual(['默认项目', 'Alpha', 'Beta'])
  })

  it('点选项 emit setProject {sessionId, projectId} 且菜单关闭', async () => {
    const store = useProjectStore()
    store.projects = [
      { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
      { id: 'p1', name: 'Alpha', lastUsedAt: 0 },
    ]
    store.activeProjectId = 'p1'

    const wrapper = mountItem({}, 'p1')
    await wrapper.find('[data-testid="assign-project-btn"]').trigger('click')
    await nextTick()

    // 归回默认项目（id=''）
    const defaultOption = Array.from(
      document.body.querySelectorAll('[data-testid="assign-project-option"]'),
    ).find((o) => o.textContent === '默认项目')!
    defaultOption.dispatchEvent(new MouseEvent('click'))
    await nextTick()

    expect(wrapper.emitted('setProject')).toEqual([[{ sessionId: 's1', projectId: '' }]])
    // 菜单关闭语义：reka PopoverContent data-state=closed（exit 动画依赖 transitionend，
    // happy-dom 不触发，内容不会卸载——以 state 断言关闭而非 DOM 消失）
    expect(document.body.querySelector('[data-state="closed"]')).not.toBeNull()
  })

  it('当前归属项 accent 高亮：命名归属 → 对应项；未归类（undefined）→ 默认项目项（review S-2）', async () => {
    const store = useProjectStore()
    store.projects = [
      { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
      { id: 'p1', name: 'Alpha', lastUsedAt: 0 },
    ]
    store.activeProjectId = 'p1'

    // 归属 p1 → Alpha 项 accent
    let options = await openAssignMenu('p1')
    const alpha = options.find((o) => o.textContent === 'Alpha')!
    const def = options.find((o) => o.textContent === '默认项目')!
    expect(alpha.className).toContain('text-accent')
    expect(def.className).not.toContain('text-accent')
    document.body.innerHTML = ''

    // 未归类（无 projectId）→ 默认项目项 accent（(undefined || '') === '' 命中）
    options = await openAssignMenu()
    const def2 = options.find((o) => o.textContent === '默认项目')!
    expect(def2.className).toContain('text-accent')
  })
})
