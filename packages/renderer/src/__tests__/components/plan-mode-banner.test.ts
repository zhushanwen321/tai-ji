/**
 * PlanModeBanner 组件单测 —— plan 模式重设计 u1-banner（M1 横幅，设计 §3.1/D5/G1 + E9）。
 *
 * 覆盖（impl-plan u1-banner 验收条款）：
 * - isActive 驱动显示（分支：无 view / isActive=false 不渲染；isActive=true 渲染标题）
 * - 技能名只读显示 + D4 降级（旧 entry 无 skills → 「（未指定）」；多技能「a · b」join）
 * - 阶段推导三态渲染（① exploring 无文档 / ② writing 有文档 / ③ reviewing 审阅态）
 * - 退出按钮 emit session.abortPlan WS 命令 + reply 失败走错误呈现（E9 恢复指引，横幅保持原状）
 * - 首拉失败 loadError 呈现（view 保留旧值，横幅照旧 + 错误行）
 *
 * mock 形态照抄 plan-store.test.ts（spread actual 保真实 events 通道，只换 command）；
 * 状态驱动用 store.applyFrame（真实 WS 帧路径，不绕被测消费链）。
 * i18n 经 vitest-i18n-setup 全局 mock，t() 取 zh-CN 文案。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/plan-mode-banner.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { PlanStateView } from '@taiji/shared'

// ── mock 边界：command 换 mock（spread actual 保留 events 真实通道——usePlanState 订阅用）──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})

import PlanModeBanner from '@/components/panel/plan/PlanModeBanner.vue'
import { usePlanStore } from '@/stores/plan-store'
import { RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'

const SID = 'sess-banner'

function viewOf(overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: true,
    planFilePath: '/data/A/.taiji-harness/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'default',
    ...overrides,
  }
}

async function mountBanner(): Promise<VueWrapper> {
  const wrapper = mount(PlanModeBanner, { props: { sessionId: SID } })
  // usePlanState watch immediate → loadPlanState RPC（command mock）microtask 排空
  await flushAsync()
  return wrapper
}

async function flushAsync(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  commandMock.mockReset()
  // 默认首拉成功返回激活 view（用例覆写）
  commandMock.mockResolvedValue({ sessionId: SID, planState: viewOf() })
})

describe('PlanModeBanner isActive 驱动显示', () => {
  it('首拉返回 isActive=true → 渲染横幅，标题与只读约束文案可见', async () => {
    const wrapper = await mountBanner()
    const banner = wrapper.find('[data-testid="plan-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('计划模式')
    expect(banner.text()).toContain('不修改源码')
  })

  it('首拉返回 isActive=false → 不渲染横幅（退出/执行后消失）', async () => {
    commandMock.mockResolvedValue({ sessionId: SID, planState: viewOf({ isActive: false }) })
    const wrapper = await mountBanner()
    expect(wrapper.find('[data-testid="plan-banner"]').exists()).toBe(false)
  })

  it('首拉返回无 plan 状态（planState null）→ 不渲染横幅', async () => {
    commandMock.mockResolvedValue({ sessionId: SID, planState: null })
    const wrapper = await mountBanner()
    expect(wrapper.find('[data-testid="plan-banner"]').exists()).toBe(false)
  })

  it('WS 帧驱动 isActive 翻转 → 横幅随之消失（approve/abort 后投影链广播路径）', async () => {
    const wrapper = await mountBanner()
    expect(wrapper.find('[data-testid="plan-banner"]').exists()).toBe(true)

    usePlanStore().applyFrame(SID, viewOf({ isActive: false }))
    await nextTick()
    expect(wrapper.find('[data-testid="plan-banner"]').exists()).toBe(false)
  })
})

describe('PlanModeBanner 技能名只读显示（D4 降级）', () => {
  it('旧 entry 无 skills 字段 → 降级显示「（未指定）」', async () => {
    commandMock.mockResolvedValue({ sessionId: SID, planState: viewOf() })
    const wrapper = await mountBanner()
    const skills = wrapper.find('[data-testid="plan-banner-skills"]')
    expect(skills.text()).toContain('技能')
    expect(skills.text()).toContain('（未指定）')
  })

  it('多技能显示「a · b」join（GUI 只读，无增删入口）', async () => {
    commandMock.mockResolvedValue({
      sessionId: SID,
      planState: viewOf({ skills: ['tech-design', 'dev-flow'] }),
    })
    const wrapper = await mountBanner()
    expect(wrapper.find('[data-testid="plan-banner-skills"]').text()).toContain('tech-design · dev-flow')
  })
})

describe('PlanModeBanner 三步阶段推导渲染（D1 推导三元组）', () => {
  async function mountWithStage(view: PlanStateView): Promise<VueWrapper> {
    commandMock.mockResolvedValue({ sessionId: SID, planState: view })
    return mountBanner()
  }

  it('① 需求探索：isActive 无文档 → 第一步高亮（cur）', async () => {
    const wrapper = await mountWithStage(viewOf())
    const stage = wrapper.find('[data-testid="plan-banner-stage"]')
    expect(stage.text()).toContain('需求探索')
    expect(stage.text()).toContain('文档撰写')
    expect(stage.text()).toContain('审阅确认')
    // cur 步 = 高亮 class（text-accent）所在步骤 span
    const cur = stage.findAll('span').filter((s) => s.classes().some((c) => c.includes('text-accent')))
    expect(cur.map((s) => s.text())).toContain('需求探索')
  })

  it('② 文档撰写：有文档无审阅态 → 第二步高亮、第一步标记完成', async () => {
    const wrapper = await mountWithStage(
      viewOf({ skills: ['tech-design'], docs: [{ fileName: 'design.md', absPath: '/d/design.md', sourceSkill: 'tech-design', version: 1 }] }),
    )
    const stage = wrapper.find('[data-testid="plan-banner-stage"]')
    const cur = stage.findAll('span').filter((s) => s.classes().some((c) => c.includes('text-accent')))
    expect(cur.map((s) => s.text())).toContain('文档撰写')
    const done = stage.findAll('span').filter((s) => s.classes().includes('text-neutral-mid'))
    expect(done.map((s) => s.text())).toContain('需求探索')
  })

  it('③ 审阅确认：reviewState=awaiting → 第三步高亮（优先于 docs 判定）', async () => {
    const wrapper = await mountWithStage(
      viewOf({
        reviewState: 'awaiting',
        docs: [{ fileName: 'design.md', absPath: '/d/design.md', sourceSkill: 'tech-design', version: 1 }],
      }),
    )
    const stage = wrapper.find('[data-testid="plan-banner-stage"]')
    const cur = stage.findAll('span').filter((s) => s.classes().some((c) => c.includes('text-accent')))
    expect(cur.map((s) => s.text())).toContain('审阅确认')
  })
})

describe('PlanModeBanner 退出通道（session.abortPlan + E9）', () => {
  it('点击退出 → 发 session.abortPlan WS 命令（sessionId 入参 + backstop 超时）', async () => {
    const wrapper = await mountBanner()
    await wrapper.find('[data-testid="plan-banner-exit"]').trigger('click')
    await flushAsync()

    expect(commandMock).toHaveBeenCalledWith('session.abortPlan', { sessionId: SID }, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('命令失败（reply success=false → reject）→ E9 错误呈现含恢复指引，横幅保持原状', async () => {
    const wrapper = await mountBanner()
    commandMock.mockRejectedValueOnce(new Error('pi respawn failed'))
    await wrapper.find('[data-testid="plan-banner-exit"]').trigger('click')
    await flushAsync()

    const errorLine = wrapper.find('[data-testid="plan-banner-error"]')
    expect(errorLine.exists()).toBe(true)
    expect(errorLine.text()).toContain('退出失败')
    expect(errorLine.text()).toContain('pi respawn failed')
    // E9 恢复指引：手动 /plan abort 兜底通道写入错误文案
    expect(errorLine.text()).toContain('/plan abort')
    // 横幅保持原状（isActive 未变，不本地消失）
    expect(wrapper.find('[data-testid="plan-banner"]').exists()).toBe(true)
  })

  it('命令成功 → 无错误行（横幅消失由投影链 isActive 广播驱动，非本地隐藏）', async () => {
    const wrapper = await mountBanner()
    await wrapper.find('[data-testid="plan-banner-exit"]').trigger('click')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-banner-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-banner"]').exists()).toBe(true)
  })

  it('首拉失败（loadError）→ view 保留旧值横幅照旧显示 + 错误行呈现（不覆盖 view）', async () => {
    // 第一轮：首拉成功落分区（view 存在，切走不清）
    const first = await mountBanner()
    first.unmount()

    // 第二轮：同 sid 切回首拉失败 → loadError 落分区，view 保留
    commandMock.mockRejectedValueOnce(new Error('rpc timeout'))
    const second = await mountBanner()
    expect(second.find('[data-testid="plan-banner"]').exists()).toBe(true)
    const loadErrorLine = second.find('[data-testid="plan-banner-load-error"]')
    expect(loadErrorLine.exists()).toBe(true)
    expect(loadErrorLine.text()).toContain('rpc timeout')
  })
})
