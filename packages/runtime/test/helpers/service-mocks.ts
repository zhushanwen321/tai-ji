/**
 * 共享 service mock 工厂。
 *
 * [背景] runtime 测试中多个 server/bridge 集成测试文件需要 mock 一整套
 * SessionService / ConfigService / ModelService / ProcessManager 等 service。
 * 这些 mock 定义（每个 30+ 方法）在 6+ 测试文件里 copy-paste，维护成本高。
 * 本模块导出创建 mock 对象的工厂函数，消除重复。
 *
 * [两种 API]
 * 1. `createMockXxxClass(options)`：返回一个 mock class，直接用于 vi.mock factory。
 *    生产代码以 `new XxxService(...)` 构造实例，mock class 的字段就是 vi.fn()，
 *    每个 `new` 都得到一组独立的 mock。这是绝大多数 service 的用法：
 *
 *    ```ts
 *    import { createMockConfigServiceClass } from './helpers/service-mocks.js'
 *    vi.mock('../src/services/config-service.js', () => ({
 *      ConfigService: createMockConfigServiceClass(),
 *    }))
 *    ```
 *
 * 2. `createMockSessionServiceInstance(options)`：返回 mock instance（字段集合）+
 *    需要测试断言的 mock ref。仅 SessionService 的 message.send 转发测试用——因为
 *    测试需持有 sendMessageMock ref 断言转发原文。用法见 server-subagent.test.ts：
 *    在 vi.mock 外创建 instance，再把字段铺到手写的 class 上。
 *
 * [vitest hoisting 约束 —— 重要]
 * `vi.mock('path', factory)` 会被 hoist 到文件顶部。factory（第二个参数）有两种
 * 陷阱会触发 TDZ（ReferenceError: Cannot access 'xxx' before initialization）：
 *   a. 直接传导入的函数引用：`vi.mock(p, importedFn)` —— hoist 时 import 还没初始化。
 *   b. 直接传调用导入函数的结果：`vi.mock(p, importedFn())` —— 同理。
 *
 * 正确做法：用「内联箭头」包住调用。内联箭头的 body 在模块首次被 import 时才
 * 执行（此时所有 import 已初始化），所以 body 内调用导入的工厂函数是安全的：
 *   - class 工厂：`vi.mock(p, () => ({ Xxx: createMockXxxClass() }))`  ✅
 *     （() => ({...}) 本身就是内联箭头，body 内调工厂安全）
 *   - module 工厂：`vi.mock(p, () => createMockXxxModule())`  ✅
 *   - async importOriginal 工厂：必须内联箭头，body 内调 mockXxxModule：
 *     `vi.mock(p, async (o) => mockXxxModule(await o()))`  ✅
 *     （不能写 `vi.mock(p, createFactory())` —— 会 TDZ）
 *
 * SessionService 的 sessionId/getRpcClientImpl options 引用文件级变量是安全的：
 * class 字段在 `new` 时才求值（运行期），此时文件级变量已初始化。
 */
import { vi } from 'vitest'

// ── SessionService ────────────────────────────────────────────────

/**
 * 创建 mock sendMessage（测试经返回的 ref 断言 message.send 的转发原文）。
 *
 * 返回的 mock 函数同时挂在 instance 字段上，测试可通过返回的 refs 做断言。
 * [HISTORICAL] sendSubagentMessage / controlSubagent 选项已随 marker 通道废弃删除
 * （composer 四符号设计 D2）——message.send 现在是纯主 agent 转发。
 */
export interface SessionServiceMockOptions {
  /**
   * create / restoreSession 返回的 session id。默认 'test-session-id'。
   * 不同文件用不同 id 便于区分（如 'bridge-test-session'）。
   */
  sessionId?: string
  /**
   * 可选的 getRpcClient 实现。bridge / extension 测试需要返回带 sendCommand /
   * sendExtensionUiResponse / sendRaw 的 mock client。
   * 若提供，会覆盖默认的 vi.fn()。
   */
  getRpcClientImpl?: (...args: unknown[]) => unknown
}

/** create / restoreSession 默认返回的 session 对象。 */
function defaultSession(sessionId: string) {
  return { id: sessionId, cwd: '/tmp', status: 'active' }
}

/**
 * 创建一个 SessionService mock instance（字段集合）。
 *
 * 返回的对象每个字段都是 vi.fn()，可直接作为 class 字段。
 * 同时把需要测试断言的 mock 函数挂到 `_refs` 上返回，方便测试引用。
 */
export function createMockSessionServiceInstance(options: SessionServiceMockOptions = {}) {
  const { sessionId = 'test-session-id', getRpcClientImpl } = options

  const sendMessageMock = vi.fn().mockResolvedValue(undefined)

  const instance = {
    sendMessage: sendMessageMock,
    listPersistedSessions: vi.fn().mockReturnValue([]),
    getSummary: vi.fn().mockReturnValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(defaultSession(sessionId)),
    delete: vi.fn().mockResolvedValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    restoreSession: vi.fn().mockResolvedValue(defaultSession(sessionId)),
    hasActiveSession: vi.fn().mockReturnValue(true),
    compact: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    switchModel: vi.fn().mockResolvedValue(undefined),
    getRpcClient: getRpcClientImpl ? vi.fn().mockImplementation(getRpcClientImpl) : vi.fn(),
    // D6a：server.setServices 装配时注册挂起 UI 请求汇聚清理（onSessionDestroyed 回调），
    // mock 缺此方法会在 setServices 内抛 TypeError。
    setOnSessionDestroyed: vi.fn(),
  }

  return { instance, sendMessageMock }
}

/**
 * 创建 SessionService mock class（用于 vi.mock factory）。
 *
 * 注意：需要断言 sendMessage 的测试（message.send 转发）无法从 class 外部获取
 * mock ref（hoisting 限制），应改用 createMockSessionServiceInstance + 手写 class
 * （见 server-subagent.test.ts 的用法）。
 *
 * 不需要断言 sendMessage 的测试（bridge/extension/data-flow）可直接用本函数生成的 class。
 */
export function createMockSessionServiceClass(options: SessionServiceMockOptions = {}) {
  const { sessionId = 'test-session-id', getRpcClientImpl } = options

  return class MockSessionService {
    sendMessage = vi.fn().mockResolvedValue(undefined)
    listPersistedSessions = vi.fn().mockReturnValue([])
    getSummary = vi.fn().mockReturnValue(undefined)
    getHistory = vi.fn().mockResolvedValue([])
    create = vi.fn().mockResolvedValue(defaultSession(sessionId))
    delete = vi.fn().mockResolvedValue(undefined)
    destroyAll = vi.fn().mockResolvedValue(undefined)
    clear = vi.fn().mockResolvedValue(undefined)
    renameSession = vi.fn().mockResolvedValue(undefined)
    restoreSession = vi.fn().mockResolvedValue(defaultSession(sessionId))
    hasActiveSession = vi.fn().mockReturnValue(true)
    compact = vi.fn().mockResolvedValue(undefined)
    abort = vi.fn().mockResolvedValue(undefined)
    switchModel = vi.fn().mockResolvedValue(undefined)
    getRpcClient = getRpcClientImpl ? vi.fn().mockImplementation(getRpcClientImpl) : vi.fn()
    // D6a：server.setServices 装配时注册挂起 UI 请求汇聚清理（onSessionDestroyed 回调），
    // mock 缺此方法会在 setServices 内抛 TypeError。
    setOnSessionDestroyed = vi.fn()
  }
}

// ── ConfigService ─────────────────────────────────────────────────

/** ConfigService mock class（用于 vi.mock factory）。6+ 文件完全一致。 */
export function createMockConfigServiceClass() {
  return class MockConfigService {
    listProviders = vi.fn().mockReturnValue([])
    setProvider = vi.fn()
    deleteProvider = vi.fn().mockReturnValue({ removed: true })
    getProvider = vi.fn().mockReturnValue(undefined)
    updateToolPermissions = vi.fn()
    loadSkills = vi.fn().mockReturnValue([])
    saveSkills = vi.fn()
    loadAgents = vi.fn().mockReturnValue([])
    saveAgents = vi.fn()
    scanSkills = vi.fn().mockReturnValue([])
    scanAgents = vi.fn().mockReturnValue([])
  }
}

// ── ModelService ──────────────────────────────────────────────────

export function createMockModelServiceClass() {
  return class MockModelService {
    aggregateModels = vi.fn().mockReturnValue([])
    discoverModelsFromApi = vi.fn().mockResolvedValue([])
  }
}

// ── ProcessManager ────────────────────────────────────────────────

export function createMockProcessManagerClass() {
  return class MockProcessManager {
    createSession = vi.fn()
    destroySession = vi.fn().mockResolvedValue(undefined)
    getClient = vi.fn()
    hasClient = vi.fn().mockReturnValue(false)
    destroyAll = vi.fn().mockResolvedValue(undefined)
    onSessionExit = vi.fn()
    rekey = vi.fn()
    getSessionIdByClient = vi.fn()
  }
}

// ── EventAdapter ──────────────────────────────────────────────────

export function createMockEventAdapterClass() {
  return class MockEventAdapter {
    attach = vi.fn()
    detach = vi.fn()
  }
}

// ── Scanners (skill-scanner / agent-scanner) ──────────────────────

/** skill-scanner.js mock 模块对象：{ scanSkills: vi.fn() } */
export function createMockSkillScannerModule() {
  return { scanSkills: vi.fn().mockReturnValue([]) }
}

/** agent-scanner.js mock 模块对象：{ scanAgents: vi.fn() } */
export function createMockAgentScannerModule() {
  return { scanAgents: vi.fn().mockReturnValue([]) }
}

// ── pi-config trio (pi-provider-store / session-file-utils / pi-paths) ──
//
// 这三个 mock 用 `async (importOriginal)` 风格：保留原模块其余实现，
// 只覆盖几个读取函数返回固定的空/桩值。
//
// [hoisting 约束] vi.mock 第二个参数不能直接传「导入的函数引用」也不能
// 直接传「调用导入函数的返回值」——两者都会在 hoist 时触发 TDZ（imports 还没初始化）。
// 正确用法：测试文件用「内联箭头」包住本辅助函数的调用：
//   vi.mock('../src/infra/pi/pi-provider-store.js', async (o) => mockPiProviderStoreModule(await o()))
// 内联箭头的 body 在模块首次被 import 时才执行（此时 imports 已初始化），
// 所以 body 内调用导入的辅助函数是安全的。参考 server-subagent.test.ts。
//
// server-extension.test.ts 有额外路径覆盖（getConfigDir/getPiAgentDir），保留自己的 override。
// skill-paths.test.ts 不在这批共享范围（值差异大），保留自己的 mock。

/** pi-provider-store.js mock：保留 actual，覆盖 5 个读取函数。返回模块对象。 */
export function mockPiProviderStoreModule(actual: Record<string, unknown>) {
  return {
    ...actual,
    getDefaultModel: () => ({ provider: 'test', modelId: 'provider-model' }),
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
    refreshAll: () => {},
  }
}

/** session-file-utils.js mock：保留 actual，覆盖 scanPiSessions。返回模块对象。 */
export function mockSessionFileUtilsModule(actual: Record<string, unknown>) {
  return { ...actual, scanPiSessions: () => [] }
}

/** pi-paths.js mock：保留 actual，覆盖 getSessionsDir。返回模块对象。 */
export function mockPiPathsModule(actual: Record<string, unknown>) {
  return { ...actual, getSessionsDir: () => '/mock/sessions' }
}

// ── trash ─────────────────────────────────────────────────────────

/** system/trash.js mock 模块对象：{ trash: vi.fn() } */
export function createMockTrashModule() {
  return { trash: vi.fn() }
}
