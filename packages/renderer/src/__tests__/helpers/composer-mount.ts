/**
 * Composer 集成测试共享 mock 骨架（composer-file/session/slash-injection +
 * force-quit-draft-recovery-dom 四文件，范式同 sidebar-mount.ts / chat-stream-mount.ts）。
 *
 * 收敛四文件逐字重复的 mock 段（质量审查 C-2 测试脚手架重复收敛批）：useChat /
 * useNewTaskFlow / @/api / stores/chat / stores/session 五个 mock 模块工厂 + Composer
 * 兄弟子组件空 stub 收敛到本 helper 单源；vi.mock 注册留在测试文件（mock 是文件作用域，
 * 工厂经顶层 import 转发本 helper 导出——同 sidebar-mount.ts 先例）。
 *
 * W4：useNewTaskFlow 的 currentCwd 必须是真实 Vue ref（Composer 的
 * useProjectSkills(flow.currentCwd) 对它 watch，裸 { value } 对象触发 Vue warn）——
 * 修复单点落在本 helper 的 composerFlowModule（composer-smoke 的 hoisted 超集另在工厂内联真 ref）。
 *
 * vitest 按测试文件隔离模块图：本 helper 导出在每个测试文件内是独立实例（文件内 mock
 * 工厂与断言共享同一批 vi.fn）。
 *
 * 差异化部分（有意不收敛，各测试文件自留）：
 * - ComposerInput mock：各文件 expose 的 spy 面不同（insertFileChip / insertSessionChip /
 *   insertSlashChip+insertSkillChip / 完整 expose 面带 insertTextAtCursor）
 * - composer-session-injection：sessionStore 需可变 active（vi.hoisted sessionState），
 *   保留本地；本 helper 只提供静态 active: undefined 版
 * - composer-smoke：flow mock 是 hoisted 超集（断言引用字段），只在工厂内联真 ref
 *   修 currentCwd，不整体换 composerFlowModule
 */
import { ref } from 'vue'
import { vi } from 'vitest'
import { defineComponent } from 'vue'

/** '@/composables/features/chat/useChat' mock 工厂（Composer 消费面 7 键全量）。 */
export function composerChatModule() {
  return {
    useChat: () => ({
      send: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
      editAndResend: vi.fn(),
      hydrateHistory: vi.fn(),
    }),
  }
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
      getQueueState: () => undefined,
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
