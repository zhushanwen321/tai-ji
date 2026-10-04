/**
 * useShieldsViewSync 单测族 —— shieldsView 遮蔽面全量上报（display-containers §5.1 规则 6② /
 * §6.7 view 遮蔽族 / §7.4 谓词重算触发面）。
 *
 * 对账锚：
 * - **faces payload 形状**（§7.4 / main display-gate ShieldFace 契约）：全屏阻塞面
 *   {id, fullscreen:true} 不带 rect；非全屏面 {id, fullscreen:false, rect}（视口坐标）；
 *   成员未提供几何读点 → rect 键省略（主进程保守按相交）。
 * - **开关触发上报——真实事件序**（禁 mock 时序）：成员开合态经响应式 ref 翻转 +
 *   nextTick flush（flush 'post' = 重渲染后 DOM 定形再实测 rect）驱动上报；无 debounce、
 *   无定时兜底——ref 翻转后第一个 flush 点即出报。
 * - **变化才上报**（内容比较收敛）：payload 无变化的重算（overlay 内容切换等触发面）
 *   不产生等值 IPC。
 * - **resize 触发面**（§6.7）：window resize 事件直推重测（无防抖）。
 * - **卸载对称**：composable 宿主卸载上报空 faces 复位；重挂后首报必达。
 *
 * 三视角：构建者白盒（mock IPC 捕获调用序列）+ 使用者黑盒（挂载宿主组件 + 开表面 →
 * 上报事实翻转）+ 观察者形态（上报序列逐条可判别）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/features/browser/shields-view-sync.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, h, nextTick, onScopeDispose, ref } from 'vue'
import { _resetOverlayForTest, openOverlay } from '@taiji/core/domain/overlay'

// ── mock lib/ipc：browserSetShields 捕获（web 环境 electronAPI 缺席的等价形态）──
const mockBrowserSetShields = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/ipc', () => ({
  browserSetShields: (payload: {
    faces: Array<{ id: string; fullscreen: boolean; rect?: { x: number; y: number; width: number; height: number } }>
  }) => mockBrowserSetShields(payload),
}))

import { registerModalSurface, resetModalSurfaceRegistry } from '@/composables/features/app/modal-surface-registry'
import { useShieldsViewSync } from '@/composables/features/browser/useShieldsViewSync'

type Rect = { x: number; y: number; width: number; height: number }
type FacesCall = { faces: Array<{ id: string; fullscreen: boolean; rect?: Rect }> }

function sentCalls(): FacesCall[] {
  return mockBrowserSetShields.mock.calls.map((call) => call[0] as FacesCall)
}

/** 常驻宿主（useShieldsViewSync 挂载要求：不随表面开合卸载） */
function mountSyncHost() {
  return mount(defineComponent({
    setup() {
      useShieldsViewSync()
      return () => h('div', { 'data-testid': 'sync-host' })
    },
  }))
}

/** 开合可翻的表面宿主（挂载即注册，isOpen 读注入 ref——SessionList 同款参考模式） */
function mountSurface(surface: 'search-modal' | 'rolling-restart-banner', key: string, options: { rect?: () => Rect | null } = {}) {
  const open = ref(false)
  const wrapper = mount(defineComponent({
    setup() {
      const dispose = registerModalSurface({ surface, key, isOpen: () => open.value, ...options })
      onScopeDispose(dispose)
      return () => h('div')
    },
  }))
  return { wrapper, open }
}

/** 恒开表面（挂载⇔开形态：isOpen 不读任何响应式 ref，卸载即注销） */
function mountAlwaysOpenSurface(surface: 'form-overlay' | 'toast-container', key: string) {
  return mount(defineComponent({
    setup() {
      const dispose = registerModalSurface({ surface, key, isOpen: () => true })
      onScopeDispose(dispose)
      return () => h('div')
    },
  }))
}

beforeEach(() => {
  resetModalSurfaceRegistry()
  _resetOverlayForTest()
  mockBrowserSetShields.mockClear()
})

afterEach(() => {
  _resetOverlayForTest()
})

enableAutoUnmount(afterEach)

describe('faces payload 形状（§7.4 ShieldFace 契约）', () => {
  it('全屏阻塞面 = {id, fullscreen:true} 不带 rect；非全屏面带实测 rect；未提供几何读点省略 rect 键', async () => {
    mountSyncHost()
    const unconditional = mountSurface('search-modal', 'sm')
    const intersecting = mountSurface('rolling-restart-banner', 'rr', {
      rect: () => ({ x: 10, y: 20, width: 300, height: 40 }),
    })
    mountAlwaysOpenSurface('toast-container', 'tc') // 非全屏族但无 rect 读点

    unconditional.open.value = true
    intersecting.open.value = true
    await nextTick()
    await nextTick()

    const last = sentCalls().at(-1)!
    const faces = [...last.faces].sort((a, b) => (a.id < b.id ? -1 : 1))
    expect(faces).toEqual([
      { id: 'rolling-restart-banner', fullscreen: false, rect: { x: 10, y: 20, width: 300, height: 40 } },
      { id: 'search-modal', fullscreen: true },
      { id: 'toast-container', fullscreen: false },
    ])
    expect(faces[1]).not.toHaveProperty('rect')
    expect(faces[2]).not.toHaveProperty('rect')
  })
})

describe('开关触发上报（真实事件序：ref 翻转 → flush 即报，无 debounce）', () => {
  it('成员开 → flush 后上报含该面；关 → 上报空集；重开 → 再报', async () => {
    mountSyncHost()
    const surface = mountSurface('search-modal', 'sm')
    expect(sentCalls()).toEqual([{ faces: [] }])

    surface.open.value = true
    await nextTick()
    await nextTick()
    expect(sentCalls().at(-1)).toEqual({ faces: [{ id: 'search-modal', fullscreen: true }] })

    surface.open.value = false
    await nextTick()
    await nextTick()
    expect(sentCalls().at(-1)).toEqual({ faces: [] })

    surface.open.value = true
    await nextTick()
    await nextTick()
    expect(sentCalls()).toHaveLength(4)
    expect(sentCalls().at(-1)).toEqual({ faces: [{ id: 'search-modal', fullscreen: true }] })
  })

  it('挂载⇔开型成员（isOpen 不读响应式 ref）：卸载注销经成员表版本号触发重报', async () => {
    mountSyncHost()
    const surface = mountAlwaysOpenSurface('form-overlay', 'fo')
    await nextTick()
    await nextTick()
    expect(sentCalls().at(-1)).toEqual({ faces: [{ id: 'form-overlay', fullscreen: true }] })

    surface.unmount()
    await nextTick()
    await nextTick()
    expect(sentCalls().at(-1)).toEqual({ faces: [] })
  })

  it('overlay 内容切换触发面：faces 无变化时重算不上报（变化才上报，内容比较收敛）', async () => {
    mountSyncHost()
    const surface = mountSurface('search-modal', 'sm')
    surface.open.value = true
    await nextTick()
    await nextTick()
    const callsAfterOpen = mockBrowserSetShields.mock.calls.length

    // overlay 开/换内容——faces 全集不变 ⇒ 重算等值 ⇒ 不产生新 IPC
    openOverlay({ kind: 'browser', payload: { sessionId: 'sess-a', url: 'http://localhost:1420/' } })
    await nextTick()
    await nextTick()
    expect(mockBrowserSetShields.mock.calls.length).toBe(callsAfterOpen)
  })
})

describe('resize 触发面（§6.7：事件直推重测，无防抖）', () => {
  it('开态内几何变化 + window resize 事件 → 立即重报新 rect（不依赖响应式依赖）', async () => {
    mountSyncHost()
    const currentRect = { x: 10, y: 10, width: 200, height: 30 }
    const surface = mountSurface('rolling-restart-banner', 'rr', { rect: () => ({ ...currentRect }) })
    surface.open.value = true
    await nextTick()
    await nextTick()
    expect(sentCalls().at(-1)).toEqual({
      faces: [{ id: 'rolling-restart-banner', fullscreen: false, rect: { x: 10, y: 10, width: 200, height: 30 } }],
    })

    // 横幅改宽（真实场景：memory bar 文案随 level 切换）——DOM 几何非响应式，resize 事件直推
    currentRect.width = 320
    window.dispatchEvent(new Event('resize'))
    expect(sentCalls().at(-1)).toEqual({
      faces: [{ id: 'rolling-restart-banner', fullscreen: false, rect: { x: 10, y: 10, width: 320, height: 30 } }],
    })
  })
})

describe('卸载对称（composable 宿主卸载 → 空 faces 复位）', () => {
  it('宿主卸载上报空 faces；重挂后首报必达（lastSent 复位）', async () => {
    const host = mountSyncHost()
    const surface = mountSurface('search-modal', 'sm')
    surface.open.value = true
    await nextTick()
    await nextTick()
    expect(sentCalls().at(-1)).toEqual({ faces: [{ id: 'search-modal', fullscreen: true }] })

    host.unmount()
    await nextTick()
    expect(sentCalls().at(-1)).toEqual({ faces: [] })

    mountSyncHost()
    await nextTick()
    await nextTick()
    expect(sentCalls().at(-1)).toEqual({ faces: [{ id: 'search-modal', fullscreen: true }] })
  })
})
