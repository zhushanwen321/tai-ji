/**
 * SessionList N8 A/C 双模式测试（ui-optimize-unified 决策 9 / 设计 §4 场景 8）。
 *
 * 覆盖验收条款：
 * - 默认平铺：无持久化值时 A 平铺模式生效（无组头/目录操作按钮），会话按 runtime 组序展平
 * - 切换：双段图标开关点击 → 模式翻转 + localStorage 持久化键写入
 * - 持久化：预置 'groups' 挂载 → 直接恢复 C 分组模式（重开应用模式保持语义）
 * - 选中同步：activeId 对应行的高亮在两种模式下一致
 * - hover 详情卡：分支 + 完整目录（无消息数），portal 渲染（不被侧栏滚动容器裁剪的形态前提）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-list-dual-mode.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'

import SessionList from '@/components/sidebar/SessionList.vue'
import SessionItem from '@/components/sidebar/SessionItem.vue'

const SESSION_MODE_KEY = 'taiji:sidebar-session-mode'

function makeSession(id: string, cwd: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    label: `会话 ${id}`,
    cwd,
    status: 'idle',
    lastActiveAt: 1,
    modelId: 'm',
    tokenCount: 0,
    ...over,
  }
}

/** 两组各两条（组间/组内可区分），验证平铺序 = runtime 组序展平（组序恒等，零重排） */
function makeGroups(): SessionGroup[] {
  return [
    { cwd: '/alpha', sessions: [makeSession('a1', '/alpha'), makeSession('a2', '/alpha')] },
    { cwd: '/beta', sessions: [makeSession('b1', '/beta')] },
  ]
}

function mountList(groups: SessionGroup[] = makeGroups(), activeId: string | null = null) {
  return mount(SessionList, {
    props: {
      groups,
      activeId,
      statusOf: () => 'done' as never,
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem(SESSION_MODE_KEY)
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('N8 默认平铺（A 模式）', () => {
  it('无持久化值挂载 → 平铺开关选中 + 无组头目录操作按钮', () => {
    const wrapper = mountList()
    expect(wrapper.find('[data-testid="session-mode-flat"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="session-mode-groups"]').attributes('aria-pressed')).toBe('false')
    // 目录操作（组内新建/目录删除）只由 C 分组模式组头承载，A 平铺不提供
    expect(wrapper.find('[data-testid="folder-new-session-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="folder-delete-btn"]').exists()).toBe(false)
  })

  it('会话行按 runtime 组序展平（fixture 输入序与 cwd 字典序相反：sort / 按 cwd 重排类回归即红）', () => {
    // 组序 zulu → alpha（与 cwd 字典序相反）：若实现按 cwd 排序或任何重排，序列断言即红
    const crossed: SessionGroup[] = [
      { cwd: '/zulu', sessions: [makeSession('z1', '/zulu'), makeSession('z2', '/zulu')] },
      { cwd: '/alpha', sessions: [makeSession('a1', '/alpha')] },
    ]
    const wrapper = mountList(crossed)
    // flatSessions = groups.flatMap(g => g.sessions)：z1, z2, a1（组序恒等，零重排）
    const texts = wrapper.findAll('.session-item').map((w) => w.text())
    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain('会话 z1')
    expect(texts[1]).toContain('会话 z2')
    expect(texts[2]).toContain('会话 a1')
  })

  it('区头显示「项目与会话」标题 + 全量会话计数', () => {
    const wrapper = mountList()
    const header = wrapper.find('[data-testid="session-list-header"]')
    expect(header.exists()).toBe(true)
    expect(header.text()).toContain('项目与会话')
    expect(header.text()).toContain('3')
  })
})

describe('N8 模式切换与持久化', () => {
  it('点击分组开关 → 进入 C 模式（组头 + 目录操作按钮出现）+ localStorage 写入', async () => {
    const wrapper = mountList()
    await wrapper.find('[data-testid="session-mode-groups"]').trigger('click')

    expect(wrapper.find('[data-testid="session-mode-groups"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="folder-new-session-btn"]').exists()).toBe(true)
    expect(localStorage.getItem(SESSION_MODE_KEY)).toBe('groups')
  })

  it('预置持久化值 groups 挂载 → 直接恢复 C 分组模式（刷新后模式保持）', () => {
    localStorage.setItem(SESSION_MODE_KEY, 'groups')
    const wrapper = mountList()
    expect(wrapper.find('[data-testid="session-mode-groups"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="folder-new-session-btn"]').exists()).toBe(true)
  })

  it('C 模式再切回平铺 → localStorage 写回 flat，目录操作按钮消失', async () => {
    localStorage.setItem(SESSION_MODE_KEY, 'groups')
    const wrapper = mountList()
    await wrapper.find('[data-testid="session-mode-flat"]').trigger('click')

    expect(wrapper.find('[data-testid="folder-new-session-btn"]').exists()).toBe(false)
    expect(localStorage.getItem(SESSION_MODE_KEY)).toBe('flat')
  })
})

describe('N8 选中态同步（两模式一致，demo .si.on Tier B：仅文字提亮无选中底）', () => {
  it('A 平铺模式：activeId 对应行无选中底，行文字提亮 text-neutral-fg', () => {
    const wrapper = mountList(makeGroups(), 'a2')
    const items = wrapper.findAll('.session-item')
    const activeRow = items.find((w) => w.text().includes('会话 a2'))
    expect(activeRow?.classes()).not.toContain('bg-bg-elevated')
    expect(activeRow?.classes()).toContain('text-neutral-fg')
  })

  it('C 分组模式：同一 activeId 对应行同样仅文字提亮', () => {
    localStorage.setItem(SESSION_MODE_KEY, 'groups')
    const wrapper = mountList(makeGroups(), 'b1')
    const activeRow = wrapper.findAll('.session-item').find((w) => w.text().includes('会话 b1'))
    expect(activeRow?.classes()).not.toContain('bg-bg-elevated')
    expect(activeRow?.classes()).toContain('text-neutral-fg')
  })
})

describe('N8 hover 详情卡（demo .sess-pop：行首图标 + 立即开 + 末行时间 meta）', () => {
  function mountItem(over: Partial<SessionSummary> = {}) {
    return mount(SessionItem, {
      attachTo: document.body,
      props: {
        session: makeSession('d1', '/repo/deep/dir', { gitBranch: 'feat/detail-card', ...over }),
        active: false,
        status: 'done' as never,
      },
    })
  }

  it('pointerenter 立即开 → portal 详情卡渲染分支 + 完整目录（行首图标形态）', async () => {
    const wrapper = mountItem()
    // demo @mouseenter=openCard 无延迟定时，pointerenter 后同步渲染
    await wrapper.find('.session-item').trigger('pointerenter')
    await nextTick()

    const card = document.body.querySelector('[data-testid="session-detail-card"]')
    expect(card).not.toBeNull()
    // demo .pr 形态：行首图标（分支/目录各一）+ mono 值，无文字标签
    expect(card?.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
    expect(card?.textContent).toContain('feat/detail-card')
    expect(card?.textContent).toContain('/repo/deep/dir')
    wrapper.unmount()
  })

  it('无 gitBranch 时详情卡只显目录行（缺失字段不渲染空图标行）', async () => {
    const wrapper = mountItem({ gitBranch: undefined })
    await wrapper.find('.session-item').trigger('pointerenter')
    await nextTick()

    const card = document.body.querySelector('[data-testid="session-detail-card"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('/repo/deep/dir')
    expect(card?.querySelectorAll('svg')).toHaveLength(1)
    wrapper.unmount()
  })
})

// ── 顶缘渐焦（spec sidebar §3.1：三视图滚动容器接 EdgeFade，滚动离顶才启用）──
describe('N8 EdgeFade 顶缘渐焦接线', () => {
  it('EdgeFade 在滚动视口内且 scroller 解析命中真滚动元素（reka 内部 wrapper 之下仍可达；离顶渐焦激活）', async () => {
    const wrapper = mountList()
    const fade = wrapper.find('[data-testid="edge-fade"]')
    expect(fade.exists()).toBe(true)
    // 渐焦带必须挂在滚动视口内部（sticky 钉顶 + scroller 解析的前提；挪出滚动容器即红）
    const viewport = fade.element.closest('[data-reka-scroll-area-viewport]') as HTMLElement | null
    expect(viewport).not.toBeNull()
    // 滚动事件驱动显隐 + 容器 mask：滚动宿主（scrollerEl prop）经 SessionList onMounted
    // → EdgeFade watch 补绑，先 flush 再派发
    await nextTick()
    viewport!.scrollTop = 20
    viewport!.dispatchEvent(new Event('scroll'))
    expect(viewport!.style.maskImage).toContain('linear-gradient')
    wrapper.unmount()
  })
})
