/**
 * GenStats 挂载点测试 mock 装配（import 即注册的副作用模块，范式同
 * composer-shell-mount.ts）。
 *
 * 顶层注册四枚 mock：useChat / useNewTaskFlow / '@/api' / stores/session（工厂转发
 * composer-mount.ts 单源，useChat 走每调用新对象的 composerChatModule 基线——非
 * shell-mount 的 spy 单例转发形态）。为什么注册不留在测试文件：gen-stats-composer-mount
 * 与 composer 注入族四文件（file/session/slash-injection + force-quit-draft-recovery-dom）
 * 的注册行两两之间再共享少量归一化 token 就越过 fallow 克隆阈值（minTokens=50），
 * 注册行逐字留在文件内时该克隆组结构性无法消除。
 *
 * 时序依据（同 composer-shell-mount）：本模块被测试文件 import 后、同文件后续 import
 * 的组件加载前完成 mock 注册，vi.mock 工厂惰性执行时本模块的 import 绑定已初始化。
 * 前提：依赖链（composer-mount.ts）不得引入被测组件——该文件只 import vue / vitest /
 * @taiji/shared。
 *
 * 使用约束：import 本模块即注册四枚 mock，消费文件不得再 vi.mock 同一目标
 * （同路径后注册者生效，静默覆盖）。
 */
import { vi } from 'vitest'
import {
  composerChatModule,
  composerFlowModule,
  composerApiModule,
  composerSessionStoreModule,
} from './composer-mount'

vi.mock('@/composables/features/chat/useChat', () => composerChatModule())
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerFlowModule())
vi.mock('@/api', () => composerApiModule())
vi.mock('@/stores/session', () => composerSessionStoreModule())
