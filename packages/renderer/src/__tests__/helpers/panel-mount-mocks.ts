/**
 * Panel 挂载测试壳依赖装配（import 即注册的副作用模块）。
 *
 * 顶层注册三连 Panel 挂载 mock：useSidebar / useToast / useExtensionUI（工厂转发本文件
 * 导出 + i18n-toast-mock.ts 的 toastSpyModule）。为什么不沿用「vi.mock 注册留在测试文件」
 * 的既有约定（sidebar-mount / i18n-toast-mock 先例）：三连注册行本身 ≈30 个归一化 token，
 * Panel 挂载测试文件两两之间再共享 useNewTaskFlow mock 尾部就越过 fallow 克隆阈值
 * （minTokens=50）——注册行逐字留在文件内时该克隆组结构性无法消除
 * （message-stream-shell-mount.ts 同款问题）。
 *
 * 时序依据：本模块被测试文件 import 后、同文件后续 import 的组件（Panel.vue）加载前
 * 完成 mock 注册，vi.mock 工厂惰性执行时本模块的 import 绑定已初始化（useToast 工厂
 * 绑定 TDZ 坑的约束由本 import 的位置承担）。前提：本文件不得 import 被测组件——
 * 同 message-stream-shell-mount.ts 的约束。
 *
 * 使用约束：
 * - 仅 Panel.vue 挂载型测试文件使用；import 本模块即注册壳 mock，消费文件不得再
 *   vi.mock 同一目标（同路径后注册者生效，静默覆盖）；
 * - toast 断言经 i18n-toast-mock.ts 的 toastSpyMock 单例取（本模块注册的 useToast
 *   工厂即返回该单例）。
 */
import { defineComponent, h } from 'vue'
import { vi } from 'vitest'
import { toastSpyModule } from './i18n-toast-mock'

/** '@/composables/features/sidebar/useSidebar' mock 工厂（Panel 挂载窄面：三 async 动作键；
 *  与 chat-stream-mount 的 useSidebarMockModule 是不同消费面，不合并——键集与 async 语义都不同）。 */
function panelSidebarMockModule() {
  return {
    useSidebar: () => ({
      restoreSession: vi.fn(async () => {}),
      retryHistory: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => {}),
    }),
  }
}

/** '@/composables/useExtensionUI' mock 工厂（Panel 挂载窄面 + PanelModeBar 的过滤导出）。 */
function panelExtensionUIMockModule() {
  return {
    useExtensionUI: () => ({
      currentFormRequest: { value: undefined as unknown },
      respond: vi.fn(),
      cancel: vi.fn(),
    }),
    formFilter: () => true,
    // PanelModeBar（Panel composer 上方常驻挂载）setup 消费 planReviewFilter——窄 mock 需补齐该导出面
    planReviewFilter: () => true,
  }
}

/** MessageStream 占位 stub（Panel 挂载测试把 MessageStream stub 成 marker div，聚焦 Panel 自身分支）。 */
export const MessageStreamStub = defineComponent({
  name: 'MessageStream',
  render: () => h('div', { 'data-testid': 'message-stream-stub' }),
})

// 顶层注册三连（vitest 将 vi.mock 调用提升到模块顶部，工厂惰性执行时上方绑定已初始化）
vi.mock('@/composables/features/sidebar/useSidebar', () => panelSidebarMockModule())
vi.mock('@/composables/useToast', () => toastSpyModule())
vi.mock('@/composables/useExtensionUI', () => panelExtensionUIMockModule())
