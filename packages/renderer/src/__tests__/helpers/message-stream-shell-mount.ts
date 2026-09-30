/**
 * MessageStream 测试壳依赖装配（import 即注册的副作用模块）。
 *
 * 顶层注册三连壳 mock：useChatViewDeps / useChat / useSidebar（工厂转发
 * chat-stream-mount.ts 单源）。为什么不沿用「vi.mock 注册留在测试文件」的既有约定
 * （chat-stream-mount / sidebar-mount / update-card-mock 先例）：三连注册行本身
 * ≈36 个归一化 token，MessageStream 装配族文件两两之间再共享 ≥14 个 token 就越过
 * fallow 克隆阈值（minTokens=50），而装配族的主题词（globalStubs / name: 'Turn' /
 * mount 装配）天然满足——注册行逐字留在文件内时该克隆组结构性无法消除。
 *
 * 时序依据（探针验证）：本模块被测试文件 import 后、同文件后续 import 的组件加载前
 * 完成 mock 注册，vi.mock 工厂惰性执行时本模块的 import 绑定已初始化。前提：本模块
 * 的依赖链（chat-stream-mount.ts）不得引入被测组件——见该文件头注释的约束。
 *
 * 使用约束：
 * - 仅 MessageStream 装配型测试文件使用；import 本模块即注册壳 mock，消费文件不得
 *   再 vi.mock 同一目标（同路径后注册者生效，静默覆盖）；
 * - 本模块不注册 virtua/vue mock——MessageStream-kind.test.ts 用带收集器的复杂版，
 *   顶层注册会经注册时序覆盖它；简化版消费方在文件内自行
 *   vi.mock('virtua/vue', () => virtuaVueMockModule())；
 * - 只需单个导出（如 NoopResizeObserver）而不装配壳 mock 的测试，从
 *   chat-stream-mount.ts 导入。
 */
import { vi } from 'vitest'
import { chatViewDepsModule, useChatMockModule, useSidebarMockModule } from './chat-stream-mount'

vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())
vi.mock('@/composables/features/chat/useChat', () => useChatMockModule())
vi.mock('@/composables/features/sidebar/useSidebar', () => useSidebarMockModule())
