import { describe, expect, it } from 'vitest'
import { PermissionConstants, PluginRpcErrorCodes } from '../../plugin-sdk/src/types'
import { freezeApiSurface } from '../src/services/plugin-service/plugin-api-freeze.js'
import type { Phase2AgentAPI } from '../src/services/plugin-service/plugin-types.js'

describe('plugin-sdk freeze 分层（AC12 前半：const 冻结）', () => {
  it('PermissionConstants 已冻结（Object.isFrozen === true）', () => {
    expect(Object.isFrozen(PermissionConstants)).toBe(true)
  })

  it('PluginRpcErrorCodes 已冻结（Object.isFrozen === true）', () => {
    expect(Object.isFrozen(PluginRpcErrorCodes)).toBe(true)
  })

  it('PermissionConstants 字面量值完整（冻结不丢字段）', () => {
    expect(PermissionConstants).toEqual({
      TOOLS_REGISTER: 'tools.register',
      HOOKS_REGISTER: 'hooks.register',
      SESSIONS_SEND_MESSAGE: 'sessions.sendMessage',
      SESSIONS_READ_STATE: 'sessions.readState',
      STORAGE_ACCESS: 'storage.access',
      NOTIFY: 'notify',
    })
  })

  it('PluginRpcErrorCodes 错误码值完整（冻结不丢字段）', () => {
    expect(PluginRpcErrorCodes).toEqual({
      RPC_TIMEOUT: -32000,
      PERMISSION_DENIED: -32001,
      PLUGIN_NOT_FOUND: -32010,
      PLUGIN_NOT_ACTIVE: -32011,
      STORAGE_FULL: -32040,
      PAYLOAD_TOO_LARGE: -32021,
      METHOD_NOT_FOUND: -32601,
      INTERNAL_ERROR: -32603,
    })
  })

  it('strict 模式修改 PermissionConstants 抛 TypeError', () => {
    // Object.freeze 对象在 strict 模式下赋值/defineProperty 均抛 TypeError
    expect(() => {
      Object.defineProperty(PermissionConstants, 'EXTRA_PERMISSION', { value: 'x.y', enumerable: true })
    }).toThrow(TypeError)
  })

  it('strict 模式修改 PluginRpcErrorCodes 抛 TypeError', () => {
    expect(() => {
      Object.defineProperty(PluginRpcErrorCodes, 'NEW_ERROR_CODE', { value: -99999, enumerable: true })
    }).toThrow(TypeError)
  })

  it('SDK 侧冻结与 runtime 源一致（sync 传播验证）', () => {
    // runtime 源经 sync-types.sh 传播：SDK 的 const 就是 runtime 的 const（同一字面量）
    expect(PermissionConstants.TOOLS_REGISTER).toBe('tools.register')
    expect(PluginRpcErrorCodes.INTERNAL_ERROR).toBe(-32603)
  })
})

describe('plugin-sdk freeze 运行时侧（AC12 后半：runtime api 对象冻结）', () => {
  function buildTestApi(): Phase2AgentAPI {
    // 构造与 createAgentAPI 返回同构的 Phase2AgentAPI 形状对象（freeze 前置形状）
    return {
      storage: {
        global: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
        workspace: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
      },
      notify: { info: async () => undefined, warning: async () => undefined, error: async () => undefined },
      sessions: {
        list: async () => [],
        get: async () => undefined,
        getActive: async () => undefined,
        sendMessage: async () => undefined,
        onDidCreateSession: () => ({ dispose: () => undefined }),
        onDidDestroySession: () => ({ dispose: () => undefined }),
      },
      events: { on: () => ({ dispose: () => undefined }), emit: () => undefined },
      tools: { register: async () => '', unregister: async () => undefined },
      hooks: {
        onBeforeSendMessage: async () => ({ dispose: () => undefined }),
        onBeforeToolCall: async () => ({ dispose: () => undefined }),
        onBeforeAgentStart: async () => ({ dispose: () => undefined }),
        onAfterToolResult: async () => ({ dispose: () => undefined }),
        onPiEvent: async () => ({ dispose: () => undefined }),
      },
      config: { get: async () => undefined, getAll: async () => ({}), set: async () => undefined },
      sessionData: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
      ui: {
        showSelect: async () => undefined,
        showConfirm: async () => false,
        showInput: async () => undefined,
        notify: async () => undefined,
        updateStatusBarItem: async () => undefined,
      },
      agent: {
        setModel: async () => '',
        getModel: async () => '',
        getThinkingLevel: async () => '',
        setThinkingLevel: async () => '',
        getActiveTools: async () => [],
      },
      workspace: { rootPath: '', name: '', findFiles: async () => [] },
      commands: { register: async () => ({ dispose: () => undefined }), unregister: async () => undefined },
      views: { update: async () => undefined, listMountPoints: async () => [] },
    }
  }

  it('freezeApiSurface 后顶层已冻结', () => {
    const api = freezeApiSurface(buildTestApi())
    expect(Object.isFrozen(api)).toBe(true)
  })

  it('全部一级子对象已冻结（storage/notify/sessions/events/tools/hooks/config/sessionData/ui/agent/workspace）', () => {
    const api = freezeApiSurface(buildTestApi())
    const subObjects = [
      api.storage,
      api.notify,
      api.sessions,
      api.events,
      api.tools,
      api.hooks,
      api.config,
      api.sessionData,
      api.ui,
      api.agent,
      api.workspace,
    ]
    for (const sub of subObjects) {
      expect(Object.isFrozen(sub)).toBe(true)
    }
  })

  it('storage 二级子对象已冻结（global/workspace）', () => {
    const api = freezeApiSurface(buildTestApi())
    expect(Object.isFrozen(api.storage.global)).toBe(true)
    expect(Object.isFrozen(api.storage.workspace)).toBe(true)
  })

  it('freeze 后顶层写入被拒（strict 抛 TypeError，结构不变）', () => {
    const api = freezeApiSurface(buildTestApi())
    expect(() => {
      Object.defineProperty(api, 'newField', { value: 1, enumerable: true })
    }).toThrow(TypeError)
    // 结构不变：newField 未写入
    expect('newField' in api).toBe(false)
  })

  it('freeze 后子对象写入被拒（strict 抛 TypeError，结构不变）', () => {
    const api = freezeApiSurface(buildTestApi())
    expect(() => {
      Object.defineProperty(api.storage, 'newField', { value: 1, enumerable: true })
    }).toThrow(TypeError)
    expect('newField' in api.storage).toBe(false)
  })

  it('freeze 不破坏方法调用语义（函数引用可用）', () => {
    const api = freezeApiSurface(buildTestApi())
    expect(typeof api.notify.info).toBe('function')
    expect(typeof api.tools.register).toBe('function')
    expect(typeof api.events.on).toBe('function')
  })
})
