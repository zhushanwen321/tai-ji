/**
 * usePlanDrawerSync 单测 —— drawer「计划产物」tab 自动打开接线（plan 模式重设计
 * u1-drawer-tab，ADR-0053 per-session pendingOpen 语义）。
 *
 * 覆盖（impl-plan u1-drawer-tab 验收条款「自动打开触发」）：
 * - isActive false→true：发 drawer 打开请求（mock 控制态通道 called with 'plan'）
 * - docs 0→1：发；docs 1→2 不发（仅首份产物边界）
 * - 切走不发：非焦点 session 的迟到激活帧不触发（applyFrame 写非焦点分区，焦点视图不变）
 * - 切回不重复打开：切走再切回、无新翻转 → 不发
 * - 已开不重发：drawer 打开中不发（不动用户当前 tab）
 * - 退出重进（true→false→true）：第二次翻转边界触发
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

describe('usePlanDrawerSync（u1-drawer-tab：ADR-0053 pendingOpen 语义）', () => {
  it('isActive false→true：发 drawer 打开请求（openDrawerTab("plan")）', async () => {
    const store = usePlanStore()
    mountHost()
    store.syncFocus('sess-a')
    store.applyFrame('sess-a', planStateOf({ isActive: false }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    store.applyFrame('sess-a', planStateOf({ isActive: true }))
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
    expect(drawerMock.openDrawerTab).toHaveBeenCalledWith('plan')
  })

  it('docs 0→1：发；docs 1→2 不发（仅首份产物边界）', async () => {
    const store = usePlanStore()
    mountHost()
    store.syncFocus('sess-doc')
    // 先建立激活基线（空分区 → isActive:true 本身是激活翻转，会消耗一次打开请求）
    store.applyFrame('sess-doc', planStateOf({ isActive: true, docs: [] }))
    await flush()
    drawerMock.openDrawerTab.mockClear()

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

  it('已开不重发：drawer 打开中不发（不动用户当前 tab）；关闭后的新翻转仍发', async () => {
    const store = usePlanStore()
    mountHost()
    store.syncFocus('sess-open')
    store.applyFrame('sess-open', planStateOf({ isActive: false }))
    await flush()

    drawerMock.setIsOpen?.(true)
    store.applyFrame('sess-open', planStateOf({ isActive: true }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    // drawer 关闭后的新事件（docs 0→1）是新提示
    drawerMock.setIsOpen?.(false)
    store.applyFrame('sess-open', planStateOf({ isActive: true, docs: [{ fileName: 'a.md', absPath: '/d/a.md', sourceSkill: 's', version: 1 }] }))
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
  })

  it('切走不发：非焦点 session 的迟到激活帧不触发（焦点视图不受非焦点分区写入影响）', async () => {
    const store = usePlanStore()
    mountHost()
    store.syncFocus('sess-focus')
    store.applyFrame('sess-focus', planStateOf({ isActive: false }))
    await flush()

    // 用户切到另一 session
    store.syncFocus('sess-other')
    await flush()
    // 原 session 的 plan 激活帧迟到到达（写入的是非焦点分区）
    store.applyFrame('sess-focus', planStateOf({ isActive: true }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    // 焦点 session 自身跨越激活边界仍发（B 分区 null→isActive true）
    store.applyFrame('sess-other', planStateOf({ isActive: true }))
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
    expect(drawerMock.openDrawerTab).toHaveBeenCalledWith('plan')
  })

  it('切回不重复打开：切走再切回、无新翻转 → 不发', async () => {
    const store = usePlanStore()
    mountHost()
    store.syncFocus('sess-back')
    store.applyFrame('sess-back', planStateOf({ isActive: false }))
    await flush()
    store.applyFrame('sess-back', planStateOf({ isActive: true }))
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)

    // 切走再切回：无新翻转，不重发
    store.syncFocus('sess-back-b')
    await flush()
    store.syncFocus('sess-back')
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
  })

  it('挂载即激活不触发（重开恢复）；退出不触发；重进第二次翻转边界触发', async () => {
    const store = usePlanStore()
    // 挂载前先置激活态（重开 session 恢复 isActive=true 的形态）——watch 非 immediate，
    // 挂载态是基线，不打开
    store.syncFocus('sess-reenter')
    store.applyFrame('sess-reenter', planStateOf({ isActive: true }))
    mountHost()
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    // 退出：true→false 不触发
    store.applyFrame('sess-reenter', planStateOf({ isActive: false }))
    await flush()
    expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

    // 重进：false→true 触发
    store.applyFrame('sess-reenter', planStateOf({ isActive: true }))
    await flush()
    expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
    expect(drawerMock.openDrawerTab).toHaveBeenCalledWith('plan')
  })
})
