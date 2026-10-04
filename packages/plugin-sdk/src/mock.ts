/**
 * taiji Plugin SDK — Mock utilities for testing
 *
 * 提供 createMockAgentAPI() 生成所有方法返回安全默认值的 mock 对象，
 * 用于插件单元测试。
 */
import type { Phase2AgentAPI } from './types.js'

/**
 * 创建 mock AgentAPI，所有方法为 no-op 并返回 undefined/空数组。
 * 用于插件测试时注入到 PluginContext.api。
 *
 * 如果需要断言调用参数或控制返回值，可在测试中覆盖单个方法：
 * ```ts
 * const api = createMockAgentAPI()
 * api.sessions.list = vi.fn().mockResolvedValue([{ id: 's1', ... }])
 * ```
 */
export function createMockAgentAPI(): Phase2AgentAPI {
  const noop = () => Promise.resolve(undefined as never)
  const noopVoid = () => Promise.resolve()
  const noopArr = () => Promise.resolve([] as never[])

  const mockStorage = {
    get: noop,
    set: noopVoid,
    delete: noopVoid,
    keys: () => Promise.resolve([]),
  }

  const mockDisposable = { dispose: () => {} }

  return {
    // Phase1
    storage: {
      global: mockStorage,
      workspace: mockStorage,
    },
    notify: {
      info: noopVoid,
      warning: noopVoid,
      error: noopVoid,
    },
    sessions: {
      list: noopArr,
      get: noop,
      getActive: noop,
      sendMessage: () => Promise.resolve({ accepted: true }),
      readEntries: () => Promise.resolve({ entries: [] }),
      getCommands: noopArr,
      onDidCreateSession: () => mockDisposable,
      onDidDestroySession: () => mockDisposable,
      onDidActivateSession: () => mockDisposable,
      onEntriesInvalidated: () => mockDisposable,
    },
    events: {
      on: () => mockDisposable,
      emit: () => {},
    },
    // Phase2
    tools: {
      register: () => Promise.resolve('mock-tool-key'),
      unregister: noopVoid,
    },
    hooks: {
      onBeforeSendMessage: () => Promise.resolve(mockDisposable),
      onBeforeToolCall: () => Promise.resolve(mockDisposable),
      onBeforeAgentStart: () => Promise.resolve(mockDisposable),
      onAfterToolResult: () => Promise.resolve(mockDisposable),
      onPiEvent: () => Promise.resolve(mockDisposable),
    },
    config: {
      get: noop,
      getAll: () => Promise.resolve({}),
      set: noopVoid,
    },
    sessionData: {
      get: noop,
      set: noopVoid,
      delete: noopVoid,
      keys: () => Promise.resolve([]),
    },
    ui: {
      showSelect: () => Promise.resolve(undefined),
      showConfirm: () => Promise.resolve(false),
      showInput: () => Promise.resolve(undefined),
      notify: noopVoid,
      updateStatusBarItem: noopVoid,
      showModal: () => Promise.resolve({ opened: true, epoch: 1 }),
      hideModal: () => Promise.resolve({ closed: false }),
      updateHeaderAction: () => Promise.resolve({ updated: true }),
      onModalClosed: () => mockDisposable,
    },
    agent: {
      setModel: () => Promise.resolve('mock-model'),
      getModel: () => Promise.resolve('mock-model'),
      getThinkingLevel: () => Promise.resolve('high'),
      setThinkingLevel: () => Promise.resolve('high'),
      getActiveTools: () => Promise.resolve([]),
    },
    workspace: {
      rootPath: '/mock/workspace',
      name: 'mock-workspace',
      findFiles: () => Promise.resolve([]),
    },
    commands: {
      register: () => Promise.resolve(mockDisposable),
      unregister: noopVoid,
    },
    views: {
      update: () => Promise.resolve(),
      listMountPoints: () => Promise.resolve([]),
    },
  }
}
