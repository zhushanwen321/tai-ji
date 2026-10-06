/**
 * 键盘编排器单测族共享装配（display-containers §8.2 编排器单测族：键序矩阵 / 双键让位 /
 * 聚合让位真实事件序 / isComposing）。
 *
 * 装配口径：**真实 core 三域状态 + 真实聚合注册表 + 真实 KeyboardEvent**（不 mock 时序、
 * 不 mock 容器状态）——仅 '@/lib/ipc'（windowClose / onShortcut IPC 面）由各测试文件 mock。
 */
import { effectScope, ref, type EffectScope } from 'vue'
import {
  bindDrawerSessionId,
  getDrawerControlState,
  openDrawerTab,
  _resetDrawerForTest,
  type RightDrawerTab,
} from '@taiji/core/domain/drawer'
import {
  bindBottomDrawerSessionId,
  getBottomDrawerControlState,
  openBottomDrawer,
  _resetBottomDrawerForTest,
} from '@taiji/core/domain/bottom-drawer'
import { openOverlay, _resetOverlayForTest, getOverlayControlState } from '@taiji/core/domain/overlay'
import { resetModalSurfaceRegistry } from '@/composables/features/app/modal-surface-registry'
import {
  _resetKeyOrchestratorForTest,
  registerOverlayFocusTrapPanel,
  useKeyOrchestrator,
} from '@/composables/features/app/key-orchestrator'

export const TEST_SID = 'sess-orchestrator'

/** 绑定三域分区键（core headless 不读 pinia——测试直绑常量 sid） */
export function bindTestSession(): void {
  bindDrawerSessionId(ref(TEST_SID))
  bindBottomDrawerSessionId(ref(TEST_SID))
}

/** 容器开合态读点（动作时刻直读，与编排器同源） */
export function containerStates(): { overlay: boolean; bottom: boolean; right: boolean } {
  return {
    overlay: getOverlayControlState().isOpen,
    bottom: getBottomDrawerControlState().isOpen,
    right: getDrawerControlState().isOpen,
  }
}

export function openWorkflowOverlay(): void {
  openOverlay({ kind: 'workflow', payload: { sessionId: TEST_SID, runId: 'run-orch' } })
}

export function openBottom(): void {
  openBottomDrawer()
}

export function openRight(tab: RightDrawerTab = 'git'): void {
  openDrawerTab(tab)
}

/** 挂编排器（AppShell 根 setup 位次的等价装配；effectScope 承载 onScopeDispose） */
export function startOrchestrator(): { stop: () => void } {
  const scope: EffectScope = effectScope()
  scope.run(() => {
    useKeyOrchestrator()
  })
  return { stop: () => scope.stop() }
}

/** 真实 KeyboardEvent（cancelable——preventDefault 断言需要） */
export function keyEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
}

/** 组合态事件（IPC 键路守卫的信号源） */
export function compositionEvent(type: 'compositionstart' | 'compositionend'): void {
  window.dispatchEvent(new Event(type))
}

/** 用例间复位（三域状态 / 聚合注册表 / 编排器 listener / 浮层陷阱面板） */
export function resetOrchestratorFixtures(): void {
  _resetDrawerForTest()
  _resetBottomDrawerForTest()
  _resetOverlayForTest()
  resetModalSurfaceRegistry()
  _resetKeyOrchestratorForTest()
  registerOverlayFocusTrapPanel(null)
}
