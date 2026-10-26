/**
 * 键盘编排器快捷键族合并文件（簇 3-9 B 组，2 源合一，DOM 环境）：
 * - find-surface-shortcut.test.ts —— Ctrl+F 表面内查找 + Esc 先关查找框（零 mock）
 * - cmdw-shortcut.test.ts —— ⌘W 双键让位 + 层级序 + 全关后关窗（@/lib/ipc mock）
 *
 * @/lib/ipc 窄 mock（onShortcut 占位 + windowClose spy）覆盖图内全部消费名
 * （orchestrator.ts 仅 windowClose，见 3-4 同款核实）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useFindInSurface } from '@/composables/features/find/useFindInSurface'
import { registerModalSurface, resetModalSurfaceRegistry } from '@/composables/features/app/modal-surface-registry'
import { handleCmdWShortcut } from '@/composables/features/app/key-orchestrator'
import {
  bindTestSession,
  containerStates,
  keyEvent,
  openBottom,
  openRight,
  openWorkflowOverlay,
  resetOrchestratorFixtures,
  startOrchestrator,
} from './helpers'

// ── cmdw-shortcut 节 mock：windowClose IPC spy（onShortcut 占位）──
const windowClose = vi.fn(() => Promise.resolve())
vi.mock('@/lib/ipc', () => ({
  onShortcut: () => () => {},
  windowClose: () => windowClose(),
}))

// ═══ 来源节：find-surface-shortcut.test.ts —— Ctrl+F 表面内查找 + Esc 先关查找框 ═══
describe('find-surface-shortcut', () => {
  beforeEach(() => {
    resetOrchestratorFixtures()
    bindTestSession()
  })

  afterEach(() => {
    resetOrchestratorFixtures()
    useFindInSurface().close()
    document.body.innerHTML = ''
  })


  /** 「触发查找快捷键 → 消费 + 开面 + 表面类型」断言单源（返回事件与 find 句柄供补断言）。 */
  function expectFindShortcutTriggered(init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }, kind: string) {
    const e = keyEvent(init.key, init)
    window.dispatchEvent(e)
    const find = useFindInSurface()
    expect(e.defaultPrevented).toBe(true)
    expect(find.isOpen.value).toBe(true)
    expect(find.surfaceKind.value).toBe(kind)
    return find
  }

  /** 可搜表面桩（OverlayShell/PanelContainer 同款属性值；归属判定读该标记） */
  function appendSurface(kind: string): void {
    const el = document.createElement('div')
    el.setAttribute('data-find-surface', kind)
    document.body.appendChild(el)
  }

  function pressEsc(): KeyboardEvent {
    const e = keyEvent('Escape')
    window.dispatchEvent(e)
    return e
  }

  describe('Ctrl+F 表面内查找（find-in-surface 接线）', () => {
    it('Cmd+F：悬停缺省走回退栈序开最上层可搜表面（overlay）+ 消费事件 + 送达聚焦意图', () => {
      openWorkflowOverlay()
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      const find = expectFindShortcutTriggered({ key: 'f', metaKey: true }, 'overlay')
      expect(find.focusTick.value, 'focusTick 自增 = FindBar 聚焦意图已送达').toBe(1)
      stop()
    })

    it('Ctrl+F：同款触发（双平台同触，metaKey||ctrlKey 无平台分支）', () => {
      appendSurface('bottom-drawer')
      const { stop } = startOrchestrator()

      expectFindShortcutTriggered({ key: 'f', ctrlKey: true }, 'bottom-drawer')
      stop()
    })

    // 大写 'F' 回归：Shift 按下时 e.key 为大写，键名判定须大小写不敏感（漏判即快捷键失灵）
    it('Shift+Cmd+F（大写 F）：触发查找', () => {
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      expectFindShortcutTriggered({ key: 'F', metaKey: true, shiftKey: true }, 'overlay')
      stop()
    })

    it('Ctrl+Shift+F（大写 F）：同款触发', () => {
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      expectFindShortcutTriggered({ key: 'F', ctrlKey: true, shiftKey: true }, 'overlay')
      stop()
    })

    it('先行档已消费（defaultPrevented）→ 不动作（不重复开查找）', () => {
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      const e = keyEvent('f', { metaKey: true })
      e.preventDefault()
      window.dispatchEvent(e)

      const find = useFindInSurface()
      expect(find.isOpen.value).toBe(false)
      stop()
    })

    it('无修饰键的 f：纯文本输入键不触发查找、不吞事件', () => {
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      const e = keyEvent('f')
      window.dispatchEvent(e)

      expect(e.defaultPrevented).toBe(false)
      expect(useFindInSurface().isOpen.value).toBe(false)
      stop()
    })

    it('IME 组合态：检查统一前置，Ctrl+F 不动作', () => {
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      window.dispatchEvent(keyEvent('f', { metaKey: true, isComposing: true }))

      expect(useFindInSurface().isOpen.value).toBe(false)
      stop()
    })
  })

  describe('Esc：查找框是临时覆盖层，先于容器剥层', () => {
    it('查找框开着：Esc 先关查找框（消费事件），容器层不被穿透关闭；再按 Esc 才剥层', () => {
      openBottom()
      const find = useFindInSurface()
      find.open('bottom-drawer')
      const { stop } = startOrchestrator()

      const e1 = pressEsc()
      expect(e1.defaultPrevented).toBe(true)
      expect(find.isOpen.value, 'Esc 先关查找框').toBe(false)
      expect(find.surfaceKind.value).toBe('')
      expect(containerStates().bottom, '容器层不随第一次 Esc 关闭').toBe(true)

      pressEsc()
      expect(containerStates().bottom, '查找框已关，第二次 Esc 正常剥容器层').toBe(false)
      stop()
    })

    it('查找框关态基线：Esc 照常剥层（不吞无查找现场的事件）', () => {
      openBottom()
      const { stop } = startOrchestrator()

      const e = pressEsc()
      expect(e.defaultPrevented).toBe(true)
      expect(containerStates().bottom).toBe(false)
      stop()
    })
  })
})

// ═══ 来源节：cmdw-shortcut.test.ts —— ⌘W 双键让位 + 层级序 + 全关后关窗 ═══
describe('cmdw-shortcut', () => {
  beforeEach(() => {
    resetOrchestratorFixtures()
    bindTestSession()
    windowClose.mockClear()
  })

  afterEach(() => {
    resetOrchestratorFixtures()
    resetModalSurfaceRegistry()
  })

  describe('⌘W：yields⌘W 让位 + 层级序逐层关 + 全关后关窗', () => {
    it('全关后 ⌘W 才关窗（不多关不早关）', () => {
      openRight()
      handleCmdWShortcut()
      expect(windowClose, '容器开着时 ⌘W 关容器不关窗').not.toHaveBeenCalled()
      expect(containerStates().right).toBe(false)

      handleCmdWShortcut()
      expect(windowClose, '全关后再 ⌘W 才关窗').toHaveBeenCalledTimes(1)
    })

    it('三容器全开：⌘W 沿同一层级序逐层关（浮层 → 底抽屉 → 右抽屉），全关后关窗', () => {
      openBottom()
      openRight()
      openWorkflowOverlay()

      handleCmdWShortcut()
      expect(containerStates()).toEqual({ overlay: false, bottom: true, right: true })
      handleCmdWShortcut()
      expect(containerStates()).toEqual({ overlay: false, bottom: false, right: true })
      handleCmdWShortcut()
      expect(containerStates()).toEqual({ overlay: false, bottom: false, right: false })
      expect(windowClose).not.toHaveBeenCalled()

      handleCmdWShortcut()
      expect(windowClose).toHaveBeenCalledTimes(1)
    })

    it('设置页（yieldsCmdW ✓）开着：⌘W 无动作——窗口不关、容器不动、模态不动（S7 让位检查）', () => {
      const dispose = registerModalSurface({
        surface: 'settings-modal',
        key: 'cmdw-settings',
        isOpen: () => true,
      })
      openBottom()
      openRight()

      handleCmdWShortcut()
      expect(windowClose).not.toHaveBeenCalled()
      expect(containerStates(), '两个容器原样保持').toEqual({ overlay: false, bottom: true, right: true })
      dispose()
    })

    it('Select 下拉（弹出层族 yieldsCmdW ✗）开着：⌘W 照常按层级序关最外层容器（非死键，R4 双键拆分）', () => {
      const dispose = registerModalSurface({
        surface: 'select-content',
        key: 'cmdw-select',
        isOpen: () => true,
      })
      openBottom()

      handleCmdWShortcut()
      expect(containerStates().bottom, '弹层族不让 ⌘W——照常关底抽屉').toBe(false)
      expect(windowClose).not.toHaveBeenCalled()
      dispose()
    })

    it('双键拆分对照（§6.7 R4）：同一弹出层族开着 Esc 让位而 ⌘W 动作', () => {
      const dispose = registerModalSurface({
        surface: 'popover-content',
        key: 'cmdw-popover',
        isOpen: () => true,
      })
      openBottom()
      const { stop } = startOrchestrator()

      window.dispatchEvent(keyEvent('Escape'))
      expect(containerStates().bottom, 'Esc 让位（弹层是视觉最外层，Esc 先关弹层）').toBe(true)

      handleCmdWShortcut()
      expect(containerStates().bottom, '⌘W 不让位（防弹层开态 ⌘W 死键）').toBe(false)
      stop()
      dispose()
    })
  })
})
