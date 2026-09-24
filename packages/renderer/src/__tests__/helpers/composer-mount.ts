/**
 * Composer 集成测试共享 mock 工厂（范式同 sidebar-mount.ts / chat-stream-mount.ts）。
 *
 * 用法契约：vi.mock 注册留在测试文件（mock 是文件作用域），测试文件以
 * `vi.mock(mod, () => composerXxxModule())` 顶层转发本 helper 导出——同 sidebar-mount.ts
 * 先例。工厂每次调用返回新对象；composerChatModule 的 api 对象在工厂体内创建一次
 * （vi.mock factory 每模块图只执行一次）：测试经 `import { useChat }` 拿到与组件同一
 * 实例的 spy 做断言（每调用新建 = 断言空转假绿）。
 *
 * 现役消费文件与形态：
 * - composer-fork-mode：useChat 委托 composerChatModule + composerChildStubs
 * - composer-slash-injection：stores/chat + stores/session 委托工厂 + composerChildStubs
 * - composer-history-cache：仅 composerChildStubs
 * - composer-file-injection / composer-session-injection / force-quit-draft-recovery-dom：
 *   仅 composerChildStubs，mock 段各自内联（见下方差异化清单）
 *
 * W4：useNewTaskFlow 的 currentCwd 必须是真实 Vue ref（Composer 的
 * useProjectSkills(flow.currentCwd) 对它 watch，裸 { value } 对象触发 Vue warn）——
 * composerFlowModule 与各文件内联 flow mock 的 currentCwd 都必须给真 ref。
 *
 * vitest 按测试文件隔离模块图：本 helper 导出在每个测试文件内是独立实例（文件内 mock
 * 工厂与断言共享同一批 vi.fn）。
 *
 * 差异化部分（有意不收敛，各测试文件自留）：
 * - ComposerInput mock：各文件 expose 的 spy 面不同（insertFileChip / insertSessionChip /
 *   insertSlashChip+insertSkillChip / 完整 expose 面带 insertTextAtCursor）
 * - composer-session-injection：sessionStore 需可变 active（vi.hoisted sessionState），
 *   保留本地；本 helper 只提供静态 active: undefined 版
 * - composer-file-injection：flow mock 带 pendingPreset（landing 态 launchConfigView
 *   解析消费），相对 composerFlowModule 为超集，内联自足
 */
import { ref } from 'vue'
import { vi } from 'vitest'
import { defineComponent } from 'vue'

/** '@/composables/features/chat/useChat' mock 工厂（Composer 消费面 7 键全量）。
 *  api 对象在工厂内创建一次（vi.mock factory 每模块图只执行一次）：测试经
 *  `import { useChat }` 拿到与组件同一实例的 spy 做断言（每调用新建 = 断言空转假绿）。 */
export function composerChatModule() {
  const api = {
    send: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    editAndResend: vi.fn(),
    hydrateHistory: vi.fn(),
  }
  return { useChat: () => api }
}

/**
 * '@/composables/features/new-task/useNewTaskFlow' mock 工厂（四文件消费面并集超集，
 * 多余键为无害 vi.fn / ref）。W4：currentCwd 统一真 ref 形态（见文件头注释）。
 */
export function composerFlowModule() {
  return {
    useNewTaskFlow: () => ({
      startFlow: vi.fn(),
      submitFirstMessage: vi.fn(),
      currentModel: ref<string | null>(null),
      setPendingModel: vi.fn(),
      state: ref('idle'),
      currentSessionId: ref<string | null>(null),
      currentCwd: ref<string | null>(null),
    }),
    resetNewTaskFlow: vi.fn(),
  }
}

/** '@/api' mock 工厂（project/model/session/composer/config 五组；config 供 W4 skill 加载）。 */
export function composerApiModule() {
  return {
    project: {
      load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    model: { switchModel: vi.fn() },
    session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })) },
    composer: {
      getMentionCandidates: vi.fn().mockResolvedValue([]),
      getFileCandidates: vi.fn().mockResolvedValue([]),
    },
    config: {
      // W4：useGlobalSkills/useProjectSkills 调用
      getGlobalSkills: vi.fn().mockResolvedValue([]),
      getProjectSkills: vi.fn().mockResolvedValue([]),
      onSkillCacheInvalidated: () => () => {},
    },
  }
}

/**
 * '@/stores/chat' mock 工厂（Composer 构造期读取不报错的最小 stub）。
 * isActive（合并态）驱动停止按钮/steer guard，恒 false（非活跃）。
 */
export function composerChatStoreModule() {
  return {
    useChatStore: () => ({
      isStreaming: ref(false),
      isActive: () => false,
      getRetryState: () => undefined,
      isCompacting: () => false,
      // [u6b] 发送位四态渲染即读 occupancy 投影（sendButtonState ← effectivePhase），mock 需提供
      sessionPhase: () => ({ turn: 'idle', compacting: false, bash: false }),
      getMessages: () => [],
      getOccupancy: () => ({ turn: 'idle', compacting: false, bash: false }),
    }),
  }
}

/** '@/stores/session' mock 工厂（静态无活跃态；applySnapshot 供 features/useModel 回执写）。 */
export function composerSessionStoreModule() {
  return {
    useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
  }
}

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })

/** Composer 兄弟子组件空 stub（四文件逐字相同；CommandPopover 需透传 slot）。 */
export const composerChildStubs = {
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}
