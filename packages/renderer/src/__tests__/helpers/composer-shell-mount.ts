/**
 * Composer 集成测试壳 mock 装配（import 即注册的副作用模块，范式同
 * message-stream-shell-mount.ts）。
 *
 * 顶层注册三枚壳 mock：useChat（composerChatApiSpy 单例转发 + resetChatModuleState
 * 超集键）/ useNewTaskFlow / stores/session（工厂转发 composer-mount.ts 单源）。
 * 为什么注册不留在测试文件：spy 化四文件（bash-mode / compact-queue /
 * dispatch-route / btw-button）的注册行两两之间再共享十来个归一化 token 就越过
 * fallow 克隆阈值（minLines=5 / minTokens=50），注册行逐字留在文件内时该克隆组
 * 结构性无法消除。
 *
 * 不在本模块注册的目标（各文件增量组不同，且同路径后注册者生效，本模块注册会
 * 静默覆盖文件内变体——vi.mock hoisting 使文件内注册先于本模块 import 执行）：
 * - '@/api'：bash-mode 基础五组（文件内注册）/ btw-button 的 chat+btw 组（文件内注册）/
 *   compact-queue·dispatch-route 的 chat 组（composer-queue-mount.ts 顶层注册）
 * - '@/composables/useToast'：仅 queue 链路两文件 mock（composer-queue-mount.ts 注册），
 *   bash / btw 文件保持真实 useToast
 *
 * 时序依据（同 message-stream-shell-mount 探针先例）：本模块被测试文件 import 后、
 * 同文件后续 import 的组件加载前完成 mock 注册，vi.mock 工厂惰性执行时本模块的
 * import 绑定已初始化。前提：依赖链（composer-mount.ts）不得引入被测组件——该文件
 * 只 import vue / vitest / @taiji/shared。
 *
 * 使用约束：
 * - import 本模块即注册壳 mock，消费文件不得再 vi.mock 同一目标（后注册者生效，
 *   静默覆盖）；
 * - 断言用 spy 从 composer-mount.ts 直接 import（composerChatApiSpy 单例，模块图按
 *   测试文件隔离，文件内与工厂共享同一批 vi.fn）。
 */
import { vi } from 'vitest'
import { composerChatSpyModule, composerFlowModule, composerSessionStoreModule } from './composer-mount'

vi.mock('@/composables/features/chat/useChat', () => composerChatSpyModule())
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerFlowModule())
vi.mock('@/stores/session', () => composerSessionStoreModule())
