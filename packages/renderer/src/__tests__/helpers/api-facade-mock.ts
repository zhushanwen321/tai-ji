/**
 * '@/api' 门面 mock 共享工厂（fork-keymap / launch-config-shell-wiring /
 * use-chat-compacted-flush / use-compact-queue 等测试文件的 '@/api' 挂载前置段单源；
 * 范式同 composer-mount.ts——vi.mock 注册留在测试文件（mock 是文件作用域），
 * 工厂经顶层 import 转发本 helper 导出。
 *
 * 收敛两类逐字重复：
 * - project 域空载基座（load/save resolve 空项目）——Sidebar/Composer mount 链
 *   onMounted 消费 project.load，缺则 unhandled rejection 崩 mount
 * - chat 域方法 resolve 基线（send/steer/followUp/abort/compact 五方法）——文件专属
 *   方法（bash/abortBash/getHistory/editAndResend/...）由调用方展开后追加
 *
 * 断言需要引用具体 spy 的测试（flush 编排 / 集成链路类）经 chatStreamApiSpy 单例：
 * 流订阅捕获 holder + chat 域方法断言锚，替代各文件自建 vi.hoisted apiMock。
 *
 * vitest 按测试文件隔离模块图：每个测试文件经 vi.mock 工厂各自取一份新实例（单例
 * chatStreamApiSpy 同理——每文件一份独立实例）。
 */
import type { ServerMessage } from '@taiji/shared'
import { vi } from 'vitest'

/** project 域 mock（空项目基座，load/save 均 resolve）。 */
export function apiProjectMock() {
  return {
    load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
    save: vi.fn().mockResolvedValue(undefined),
  }
}

/** chat 域方法 mock 基线（五方法 resolve 基线；追加面见文件头注释）。 */
export function chatApiMethodsMock() {
  const resolveFn = () => vi.fn(() => Promise.resolve())
  return {
    send: resolveFn(),
    steer: resolveFn(),
    followUp: resolveFn(),
    abort: resolveFn(),
    compact: resolveFn(),
  }
}

/** chat.streamSubscribe 回调宽形态（type + payload: unknown）：ServerMessage 与测试手搓帧均可赋值。 */
export type ChatStreamCb = (msg: { type: string; payload: unknown }) => void

/**
 * chat 域流订阅 spy 单例（「vi.hoisted apiMock」脚手架的单源替代）：holder 捕获
 * streamSubscribe 注册的回调（退订即清空），send/getHistory/abort/compact/steer/followUp
 * 为 resolve 基线，断言直接引用本单例（toHaveBeenCalledWith / mockRejectedValueOnce 等）。
 * 必须驻本文件做模块级单例——vi.mock('@/api') 工厂执行期（import 链上）就要解引用，
 * 测试文件本地 const 彼时 TDZ（同 composer-mount.ts composerChatApiSpy 先例）。
 * beforeEach 复位：vi.clearAllMocks() + holder.current = null。
 * 文件专属键（subagentAction / bash / send 定制签名）由调用方经 vi.hoisted 或工厂内追加。
 */
export const chatStreamApiSpy = (() => {
  const holder: { current: ChatStreamCb | null } = { current: null }
  return {
    holder,
    streamSubscribe: vi.fn((_sid: string, cb: ChatStreamCb) => {
      holder.current = cb
      return () => {
        holder.current = null
      }
    }),
    send: vi.fn(() => Promise.resolve()),
    getHistory: vi.fn(() => Promise.resolve([])),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    steer: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
  }
})()

/** '@/api' mock 工厂的 chat 域组（单例转发形态，七键与 chatStreamApiSpy 一一映射）。 */
export function chatApiStreamGroup() {
  const spy = chatStreamApiSpy
  return {
    streamSubscribe: spy.streamSubscribe,
    send: spy.send,
    getHistory: spy.getHistory,
    abort: spy.abort,
    compact: spy.compact,
    steer: spy.steer,
    followUp: spy.followUp,
  }
}

/**
 * session 域订阅基线 mock：subscribe 空快照回放 + unsubscribe/writeSegments resolve
 * （useChat 薄包装 import session.writeSegments 写 segments sidecar，
 * useMessageBusSubscription 调 session.subscribe，缺键即 not-a-function）。
 * 需要追加键（setThinkingLevel / subagentAction 等）的调用方展开后追加。
 */
export function sessionSubscribeBaselineMock() {
  return {
    subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    writeSegments: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * session 域 mount 链 mock（订阅基线超集）：加 setThinkingLevel——thinking-level-sync
 * watch 在 Composer mount 时触发，缺键即崩（chat-integration / send-rejected 集成形态）。
 */
export function sessionMountChainMock() {
  return {
    ...sessionSubscribeBaselineMock(),
    // useModel.setThinkingLevel 依赖（thinking-level-sync watch 在 mount 时触发）
    setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })),
  }
}

/** config 域 skills 三键 mock（getGlobalSkills / getProjectSkills + 缓存失效退订），Composer mount 链消费。 */
export function apiConfigSkillsDomainMock() {
  return {
    getGlobalSkills: vi.fn().mockResolvedValue([]),
    getProjectSkills: vi.fn().mockResolvedValue([]),
    onSkillCacheInvalidated: () => () => {},
  }
}

/**
 * workspace / worktree 域空载基座 mock（detect not-repo + worktree.list 空数组）：new-task
 * 流程（submitFirstMessage / initApp 的 cwd 预填）前置消费面。解析函数形态刻意区别于
 * 存量逐字内联副本（mockResolvedValue 链式）——同 apiConfigDomainMock 先例，避免与未迁移
 * 副本构成逐字克隆窗。
 */
export function apiWorkspaceDomainsMock() {
  const detectPayload = { mode: 'not-repo' as const, isBareMode: false, wsRoot: '', repoRoot: '' }
  return {
    workspace: {
      detect: vi.fn(() => Promise.resolve(detectPayload)),
    },
    worktree: {
      list: vi.fn(() => Promise.resolve([])),
    },
  }
}

/** 向被测代码订阅的 streamSubscribe handler 注入一条服务端消息（holder 空则忽略）。 */
export function emitChatStreamMessage(msg: ServerMessage): void {
  chatStreamApiSpy.holder.current?.(msg)
}

/** on* 订阅成员族 stub（键列表 → { onX: vi.fn(() => () => {}) }：注册即返回 disposer 的
 *  no-op 订阅）；'@/api' 各域订阅段的键参数化单源，apiConfigDomainMock 基座亦由它生成。 */
export function subscriptionStubs(keys: readonly string[]) {
  return Object.fromEntries(keys.map((k) => [k, vi.fn(() => () => {})]))
}

/**
 * config 域 mock 基线（on* 订阅家族全部返回退订函数 + terminal 配置读写 resolve 基线）：
 * mount 链组件 setup 期批量挂订阅，缺键即崩；消费形态同 apiProjectMock。
 *
 * on* 家族经 subscriptionStubs 键参数化生成（每键独立 vi.fn 实例）：基座 9 键覆盖
 * SettingsModal / 面板类 mount 链的公共订阅面，域特有订阅键（onModels / onExtensions /
 * onAuth* 等）经 extraSubscriptionKeys 追加，不重复登记进基座键表。
 */
export function apiConfigDomainMock(extraSubscriptionKeys: readonly string[] = []) {
  const onKeys = [
    'onProviders',
    'onSkills',
    'onAgents',
    'onSkillDirs',
    'onAgentDirs',
    'onExtensionDirs',
    'onDefaults',
    'onSystemPrompt',
    'onTerminalConfig',
    ...extraSubscriptionKeys,
  ]
  return {
    ...subscriptionStubs(onKeys),
    getTerminalConfig: vi.fn(async () => ({ config: { version: 1, shell: '', shellArgs: [], fontSize: 14, fontFamily: '', scrollback: 1000, cursorStyle: 'block' as const, bell: false }, corrupted: false })),
    setTerminalConfig: vi.fn(async () => ({ config: { version: 1, shell: '', shellArgs: [], fontSize: 14, fontFamily: '', scrollback: 1000, cursorStyle: 'block' as const, bell: false }, corrupted: false })),
  }
}
