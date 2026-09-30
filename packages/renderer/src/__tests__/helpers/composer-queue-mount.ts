/**
 * queue 族 Composer 集成测试 harness（compact-queue / dispatch-route 共用，
 * 范式同 app-update-mount 的 setupAppUpdateLifecycle：hook 注册式装配）。
 *
 * 本模块 import 即注册（副作用）：'@/api'（chat 组增量 = composerApiModuleWithChat，
 * queue.flush 真实路径的提交编排依赖）+ '@/composables/useToast'（toastSpyModule）；
 * useChat / useNewTaskFlow / stores/session 经 './composer-shell-mount' 转注册。
 * 为什么注册不留在测试文件：queue 两文件的 mock 注册行 + beforeEach 块逐字趋同
 * （≥50 归一化 token），留在文件内时该克隆组结构性无法消除。
 *
 * setupComposerQueueHarness：ComposerInput mock + 壳 stub 组合 + 逐用例重置（pinia
 * 重建 + mock 清零 + 输入捕获清空 + queue 单例 scope 隔离 + resetChatModuleState）
 * 一并装配。时序注意：本模块自身的 import 链会触发 '@/api' mock 工厂执行，故
 * './composer-mount' 必须先行 import（工厂引用其导出，vi.mock 只 hoist 注册不重排
 * import）；消费文件的 useCompactQueue import 亦须排在本模块之后。
 */
import { beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import './composer-shell-mount'
import { composerApiModuleWithChat, makeComposerInputMock, composerChildStubs, resetComposerMountState } from './composer-mount'
import { toastSpyModule } from './i18n-toast-mock'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import { resetChatModuleState } from '@/composables/features/chat/useChat'

export { composerChatApiSpy } from './composer-mount'
export { toastSpyMock } from './i18n-toast-mock'

vi.mock('@/api', () => composerApiModuleWithChat())
vi.mock('@/composables/useToast', () => toastSpyModule())

/** queue 族逐用例重置：基础复位（resetComposerMountState）+ queue 单例隔离 + reset。 */
export function setupComposerQueueHarness() {
  const { lastInputText, ComposerInputMock } = makeComposerInputMock()
  const otherStubs = { ComposerInput: ComposerInputMock, ...composerChildStubs }
  beforeEach(() => {
    resetComposerMountState(lastInputText)
    // 单例首次创建放 active effect scope（onScopeDispose 注册 cleanup，对齐 W1 测试契约）
    effectScope().run(() => {
      useCompactQueue()
    })
    // 单例跨用例共享，不 reset 会泄漏到下一用例
    useCompactQueue()._clearAllForTest()
    resetChatModuleState()
  })
  return { ComposerInputMock, otherStubs }
}
