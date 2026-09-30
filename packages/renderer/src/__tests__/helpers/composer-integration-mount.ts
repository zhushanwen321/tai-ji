/**
 * Composer 集成测试单源（chat-integration-send / chat-send-rejected 双文件装配形态）：
 * 真实 useChat + 真实 store 走全链路（mock 只到系统边界）——'@/api'（chat 组转发
 * chatStreamApiSpy 断言锚，session/config/file 取 api-facade-mock mount 链基线）+
 * useNewTaskFlow / useToast 两个 setup 期深依赖工厂 + ComposerInput mock / 兄弟 stub /
 * 逐用例重置 / mountComposer 装配。
 *
 * import 本文件即完成三个 vi.mock 注册（message-stream-shell-mount.ts 先例），注册须早于
 * 被测组件 import——本文件自身 import 顺序同理：api-facade-mock / composer-mount 必须排在
 * Composer.vue 之前（Composer 的 import 链会触发 '@/api' 工厂执行，彼时前端位的 helper
 * import 若未求值即 TDZ）。vitest 按测试文件隔离模块图：本文件注册与工厂产物在每个
 * 测试文件内是独立实例。
 */
import { beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  apiConfigSkillsDomainMock,
  apiProjectMock,
  chatApiStreamGroup,
  chatStreamApiSpy,
  sessionMountChainMock,
} from './api-facade-mock'
import { composerChildStubs, makeComposerInputMock, resetComposerMountState } from './composer-mount'
import Composer from '@/components/panel/Composer.vue'

/** '@/api' mock 工厂（Composer 集成五域形态；chat 组 = chatStreamApiSpy 转发供测试断言）。 */
function composerIntegrationApiModule() {
  return {
    project: apiProjectMock(),
    chat: chatApiStreamGroup(),
    file: {
      read: vi.fn(() => Promise.resolve({ content: '', truncated: false })),
    },
    session: sessionMountChainMock(),
    config: apiConfigSkillsDomainMock(),
  }
}

/** '@/composables/features/new-task/useNewTaskFlow' mock 工厂（集成 4 键窄面，resetNewTaskFlow 超集）。 */
function composerIntegrationFlowModule() {
  return {
    useNewTaskFlow: () => ({
      submitFirstMessage: vi.fn(),
      currentModel: { value: null },
      currentCwd: { value: null },
      setPendingModel: vi.fn(),
    }),
    resetNewTaskFlow: vi.fn(),
  }
}

/** '@/composables/useToast' mock 工厂（集成形态：toasts 空数组 ref 面 + error/remove）。 */
function composerToastModule() {
  return {
    useToast: () => ({ toasts: { value: [] }, error: vi.fn(), remove: vi.fn() }),
  }
}

// import 即注册（须早于被测组件 import，见文件头注释）。工厂为自包含函数声明：vi.mock 工厂
// 在 import 求值期（被测组件 import 链首次触达对应模块时）执行，彼时模块体 const 尚未初始化
//（TDZ），仅函数声明的提升形态 + import 绑定引用可安全解引用。
// 注：不注册 '@/composables/panel/useComposerModelThinking'——该路径是磁盘上不存在的虚拟
// 模块（真实实现经 composer-shell 聚合模块进 Composer），旧文件内的这条 vi.mock 是从未
// 生效的死注册，产品代码走真实实现即原测试的既有行为。
vi.mock('@/api', () => composerIntegrationApiModule())
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerIntegrationFlowModule())
vi.mock('@/composables/useToast', () => composerToastModule())

/**
 * Composer 集成装配：ComposerInput mock + 兄弟 stub + 逐用例四重置（pinia 重建 / mock
 * 调用清零 / 输入捕获清空 / chatStreamApiSpy holder 复位——setupComposerBaseHarness 同款
 * 前三样 + 集成文件增量的流回调复位）+ mountComposer 工厂（sessionId props 形），测试文件
 * 不再自写 beforeEach 块。
 */
export function setupComposerChatIntegrationHarness() {
  const { lastInputText, ComposerInputMock } = makeComposerInputMock()
  const otherStubs = { ComposerInput: ComposerInputMock, ...composerChildStubs }
  beforeEach(() => {
    resetComposerMountState(lastInputText)
    chatStreamApiSpy.holder.current = null
  })
  const mountComposer = (sessionId: string) =>
    mount(Composer, { props: { sessionId }, global: { stubs: otherStubs } })
  return { ComposerInputMock, otherStubs, mountComposer }
}
