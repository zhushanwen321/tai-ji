/**
 * usePlanDrawerSync 单测 —— drawer「计划产物」tab 自动打开接线（plan 模式重设计
 * u1-drawer-tab + plan-mode-ux-refactor §3.2 门控修复，ADR-0053 per-session pendingOpen 语义）。
 *
 * 覆盖（impl-plan u-drawer-gate 验收条款「isActive 翻转不开窗」「docs 0→1 开窗」）：
 * - isActive false→true：不开窗（§3.2 删 activated 触发——激活时 docs 尚空，开窗只见
 *   pending 占位，P-C「激活即空弹」根除）
 * - docs 0→1：发；docs 1→2 不发（仅首份产物边界）
 * - 切走不发：非焦点 session 的迟到首份产物帧不触发（applyFrame 写非焦点分区，焦点视图不变）
 * - 切回不重复打开：切走再切回、无新翻转 → 不发
 * - 已开不重发：drawer 打开中不发（不动用户当前 tab）；关闭后的新翻转仍发
 * - 挂载即有状态不触发（重开 session 恢复 isActive=true / docs 已有）；退出不触发
 *
 * mock 策略：drawer 控制态通道 mock（openDrawerTab spy + useDrawerControl.isOpen 可控 ref）；
 * planStore 用真实 store（pinia），syncFocus + applyFrame 驱动 watch 源。宿主组件形态对齐
 * use-plan-sync.test.ts（unmount 自动停 watch）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-plan-drawer-sync.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { mount, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import type { PlanStateView } from '@taiji/shared'
import { usePlanStore } from '@/stores/plan-store'
import { usePlanDrawerSync } from '@/composables/use-plan-drawer-sync'

// ── mock 边界：drawer 控制态通道（openDrawerTab spy + isOpen 可控 ref）──
const drawerMock = vi.hoisted(() => {
  const state: {
    openDrawerTab: ReturnType<typeof vi.fn>
    setIsOpen: ((v: boolean) => void) | null
  } = { openDrawerTab: vi.fn(), setIsOpen: null }
  return state
})

vi.mock('@taiji/core/domain/drawer', async () => {
  const { ref } = await import('vue')
  const isOpen = ref(false)
  drawerMock.setIsOpen = (v: boolean) => {
    isOpen.value = v
  }
  return {
    openDrawerTab: drawerMock.openDrawerTab,
    useDrawerControl: () => ({ isOpen }),
  }
})

// ── 测试基建 ─────────────────────────────────────────────────

/** 帧工厂（四必填字段基线，用例按需覆写 plan 新字段——D4 optional） */
function planStateOf(overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: false,
    planFilePath: null,
    requirement: null,
    templateName: null,
    ...overrides,
  }
}

const mountedWrappers: VueWrapper[] = []

/** 宿主组件：setup 内调 usePlanDrawerSync（与 PanelContainer 同形态），unmount 自动停 watch */
function mountHost(): void {
  const Host = defineComponent({
    name: 'PlanDrawerSyncHost',
    setup() {
      usePlanDrawerSync()
      return () => h('div')
    },
  })
  mountedWrappers.push(mount(Host))
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  drawerMock.openDrawerTab.mockClear()
  drawerMock.setIsOpen?.(false)
})

enableAutoUnmount(afterEach)

describe('usePlanDrawerSync（u-drawer-gate：门控修复后仅 docs 0→1 触发）', () => {
  it('isActive 翻转不开窗（§3.2 删 activated 触发；激活即空弹已删）', async () => {
    const store = usePlanStore()
    mountHost()
    store.syncFocus('sess-a')
    store.applyFrame('sess-a', planStateOf({ isActive: false }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    // false→true：不开窗（docs 仍空，无内容可看）
    store.applyFrame('sess-a', planStateOf({ isActive: true }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    // true→false（退出）：同样不开窗
    store.applyFrame('sess-a', planStateOf({ isActive: false }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()
  })

  it('docs 0→1：发；docs 1→2 不发（仅首份产物边界）', async () => {
    const store = usePlanStore()
    mountHost()
    store.syncFocus('sess-doc')
    // 激活基线（isActive 翻转不再消耗打开请求——触发只剩 docs 边界）
    store.applyFrame('sess-doc', planStateOf({ isActive: true, docs: [] }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    const doc = { fileName: 'design.md', absPath: '/d/design.md', sourceSkill: 'tech-design', version: 1 }
    store.applyFrame('sess-doc', planStateOf({ isActive: true, docs: [doc] }))
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
    expect(drawerMock.openDrawerTab).toHaveBeenCalledWith('plan')

    // 1→2：tab 已在，L2 清单由 u1-docs-panel 响应式驱动，不重开
    drawerMock.openDrawerTab.mockClear()
    store.applyFrame('sess-doc', planStateOf({ isActive: true, docs: [doc, { ...doc, fileName: 'impl-plan.md' }] }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()
  })

  it('已开不重发：docs 0→1 时 drawer 已开不发（不动用户当前 tab）；关闭后的新一轮翻转仍发', async () => {
    const store = usePlanStore()
    mountHost()
    store.syncFocus('sess-open')
    store.applyFrame('sess-open', planStateOf({ isActive: true, docs: [] }))
    await flush()

    // 首份产物就绪，但 drawer 已开（用户在看其他 tab）→ 不拽回
    drawerMock.setIsOpen?.(true)
    store.applyFrame('sess-open', planStateOf({ isActive: true, docs: [{ fileName: 'a.md', absPath: '/d/a.md', sourceSkill: 's', version: 1 }] }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    // drawer 关闭后的新事件（新一轮 docs 重置后 0→1）是新提示
    drawerMock.setIsOpen?.(false)
    store.applyFrame('sess-open', planStateOf({ isActive: true, docs: [] }))
    await flush()
    store.applyFrame('sess-open', planStateOf({ isActive: true, docs: [{ fileName: 'b.md', absPath: '/d/b.md', sourceSkill: 's', version: 1 }] }))
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
  })

  it('切走不发：非焦点 session 的首份产物帧不触发（焦点视图不受非焦点分区写入影响）', async () => {
    const store = usePlanStore()
    mountHost()
    store.syncFocus('sess-focus')
    store.applyFrame('sess-focus', planStateOf({ isActive: true, docs: [] }))
    await flush()

    // 用户切到另一 session
    store.syncFocus('sess-other')
    await flush()
    // 原 session 的首份产物帧迟到到达（写入的是非焦点分区）→ 不开窗
    store.applyFrame('sess-focus', planStateOf({ isActive: true, docs: [{ fileName: 'a.md', absPath: '/d/a.md', sourceSkill: 's', version: 1 }] }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    // 焦点 session 自身跨越 docs 边界仍发
    store.applyFrame('sess-other', planStateOf({ isActive: true, docs: [{ fileName: 'b.md', absPath: '/d/b.md', sourceSkill: 's', version: 1 }] }))
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
    expect(drawerMock.openDrawerTab).toHaveBeenCalledWith('plan')
  })

  it('切回不重复打开：切走再切回、无新翻转 → 不发', async () => {
    const store = usePlanStore()
    mountHost()
    store.syncFocus('sess-back')
    store.applyFrame('sess-back', planStateOf({ isActive: true, docs: [] }))
    await flush()
    store.applyFrame('sess-back', planStateOf({ isActive: true, docs: [{ fileName: 'a.md', absPath: '/d/a.md', sourceSkill: 's', version: 1 }] }))
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)

    // 切走再切回：无新翻转，不重发
    store.syncFocus('sess-back-b')
    await flush()
    store.syncFocus('sess-back')
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
  })

  it('挂载即有状态不触发（重开恢复 isActive=true / docs 已有）；重进后 docs 0→1 触发', async () => {
    const store = usePlanStore()
    // 挂载前先置激活态（重开 session 恢复 isActive=true 的形态）——watch 非 immediate，
    // 挂载态是基线，不打开
    store.syncFocus('sess-reenter')
    store.applyFrame('sess-reenter', planStateOf({ isActive: true }))
    mountHost()
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    // 重进（true→false→true）本身不触发——触发只剩 docs 边界
    store.applyFrame('sess-reenter', planStateOf({ isActive: false }))
    await flush()
    store.applyFrame('sess-reenter', planStateOf({ isActive: true, docs: [] }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    // 首份产物就绪才开窗
    store.applyFrame('sess-reenter', planStateOf({ isActive: true, docs: [{ fileName: 'a.md', absPath: '/d/a.md', sourceSkill: 's', version: 1 }] }))
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
    expect(drawerMock.openDrawerTab).toHaveBeenCalledWith('plan')
  })
})
