import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../test-guard/integration-gate.ts';
import { normalizePiToolResult as coreNormalize } from '../../core/src/domain/chat/apply-entry-utils.js';
import { compileIgnoreRules, matchPath, type IgnoreMatcher } from '../src/infra/fs/ignore-parser.js';
import { NpmInstallError, installDependencies, installPackage, isPrivateIp, uninstallPackage, validateNpmName, validateUrlHost } from '../src/infra/installers/npm-installer.js';
import { ModelConnectionTester } from '../src/infra/model-connection-tester.js';
import { getAgentDirs, getAgentPathScopes, getDiscoveryPath, getExtensionDirs, getExtensionPathScopes, getSkillDirs, getSkillPathScopes, invalidateDiscoveryCache, readDiscovery, setAgentDirs, setDiscoveryPath, setExtensionDirs, setSkillDirs, writeDiscovery } from '../src/infra/pi/discovery-store.js';
import { EventAdapter, translate } from '../src/infra/pi/event-adapter.js';
import { convertPiHistory, convertSinglePiMessage } from '../src/infra/pi/message-converter.js';
import { normalizePiToolResult, normalizePiToolResult as runtimeNormalize, stripAnsi } from '../src/infra/pi/normalize-tool-result.js';
import { getPiAgentDir, getSettingsPath } from '../src/infra/pi/pi-paths.js';
import type { PiEvent, PiHistoryContentPart } from '../src/infra/pi/pi-protocol.js';
import { getDefaultModel as piProviderGetDefaultModel, getSkillPaths, migrateSettingsSkillsToDiscovery, refreshModels, setModelsPath, setSkillPaths, writeModels } from '../src/infra/pi/pi-provider-store.js';
import { PiHistoryImagePart, PiHistoryToolResult, type PiHistoryMessage } from '../src/infra/pi/pi-session-data.js';
import { getActiveSettingsPath, readSettings, setSettingsPath } from '../src/infra/pi/pi-settings-store.js';
import type { PiMessage } from '../src/infra/pi/rpc-client.js';
import type { ScannedSessionMeta } from '../src/infra/pi/session-file-utils.js';
import { type IConfigService, IModelService, type IEventAdapter, type IMessageBroker, type ISessionService } from '../src/interfaces.js';
import { ConfigService } from '../src/services/config-service.js';
import { McpServersService } from '../src/services/mcp-servers-service.js';
import { MessageBus, type IMessageBus } from '../src/services/message-bus/message-bus.js';
import type { BusClient } from '../src/services/message-bus/types.js';
import { getNetworkProxyConfig, setNetworkProxyConfig, testNetworkProxyConnection } from '../src/services/network-proxy-config.js';
import { dispatchHandler, registerHandler } from '../src/services/plugin-service/handler-registry';
import { createHookApi, disposePluginHooks, executeHookRequest, registerHookRpcHandlers } from '../src/services/plugin-service/hook-api.js';
import { findPackageRootDir } from '../src/services/plugin-service/pkg-root.js';
import { createAgentAPI, disposePluginUiEventHandlers, handleMessage, registerToolHandler, setPostMessage, unregisterToolHandler, workerRpcClient } from '../src/services/plugin-service/plugin-bootstrap.js';
import { ENTRY_INVALIDATION_NOTIFY_METHOD, EntryInvalidationDispatch, type EntryInvalidationTarget } from '../src/services/plugin-service/plugin-entry-invalidation-dispatch.js';
import { dispatchHostRpcMessage } from '../src/services/plugin-service/plugin-host.js';
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js';
import type { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js';
import { PluginRpcServer, type WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js';
import { PLUGIN_EVENT_RPC_METHOD, PLUGIN_UI_EVENT_NOTIFY, registerOpenUrlRpcHandler, registerPluginEventRpcHandler } from '../src/services/plugin-service/plugin-rpc-setup.js';
import { BLOCKED_BUILTINS, createRequireInterceptor } from '../src/services/plugin-service/plugin-sandbox.js';
import { PluginService } from '../src/services/plugin-service/plugin-service.js';
import { HookContext, type HostToWorkerMessage, IPluginServiceDeps, PluginDescriptor, PluginRpcErrorCodes, RpcRequest, ToolEntry, ToolExecuteHandler, type HookEntry, type HookResult } from '../src/services/plugin-service/plugin-types.js';
import { registerToolRpcHandlers } from '../src/services/plugin-service/tool-api.js';
import type { IConfigStore } from '../src/services/ports/config.js';
import type { IModelConnectionTester } from '../src/services/ports/model-connection-tester.js';
import { IProcessManager, type IPiEngine, type PiEventListener } from '../src/services/ports/pi-engine.js';
import type { IProviderCredentialResolver } from '../src/services/ports/provider-credential-resolver.js';
import type { ISessionStore } from '../src/services/ports/session.js';
import { registerProviderWriteProxy, type ProviderWriteProxyDeps } from '../src/services/provider-write-proxy.js';
import { scanAgents } from '../src/services/scanners/agent-scanner.js';
import { parseSkillMd } from '../src/services/scanners/skill-scanner.js';
import { EventInterpreter, applySessionOccupancyTransition } from '../src/services/session/event-interpreter.js';
import { inflightMirror } from '../src/services/session/inflight-mirror.js';
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js';
import { createSessionDeliveryRegistry } from '../src/services/session/session-delivery-registry.js';
import { ILifecycleSessionOps, ISessionRegisterDeps, type IDispatcherSessionOps } from '../src/services/session/session-internal.js';
import { SessionLifecycle } from '../src/services/session/session-lifecycle.js';
import { SessionService } from '../src/services/session/session-service.js';
import { normalizeSubagentStatus } from '../src/services/session/subagent-status.js';
import { SessionOccupancyTransition, type IManagedSessionView, type SessionOccupancy } from '../src/services/session/types.js';
import { extractWorkflowsFromSessionFile } from '../src/services/session/workflow-extractor.js';
import { WorkflowRunEventsReader } from '../src/services/session/workflow-run-events-reader.js';
import { PRESET_AGENT_DIRS, PRESET_SKILL_DIRS, buildDirConfigs } from '../src/services/skill-dir-config.js';
import type { SkillRegistry } from '../src/services/skill-registry.js';
import type { RecentWorkspacesStore } from '../src/services/workspace/recent-workspaces-store.js';
import { WorkspaceService } from '../src/services/workspace/workspace-service.js';
import { ConnectionManager } from '../src/transport/connection-manager.js';
import { BrokerServices, ServerMessageBroker as BrokerType, type ClientPool } from '../src/transport/message-broker.js';
import { RuntimeServer } from '../src/transport/server.js';
import { SettingsMessageHandler, type SettingsHandlerContext } from '../src/transport/settings-message-handler.js';
import { RpcTimeoutError, errorWithCode, isEnoent, isNotFound, toErrorMessage } from '../src/utils/errors.js';
import { extractDescription, extractFrontmatter } from '../src/utils/frontmatter.js';
import { atomicWrite } from '../src/utils/fs-utils.js';
import { canonicalizePath, isStrictlyUnder, isUnderOrEqual } from '../src/utils/path-utils.js';
import { type WsSender, createEventAdapter, type EventAdapterOptions } from './helpers/event-adapter-test-fixture.js';
import { flushDelivery } from './helpers/flush-delivery.js';
import { createMockSessionServiceClass } from './helpers/service-mocks.js';
import { createTsxPathsTsconfig, type TsxPathsTsconfig } from './helpers/tsx-fork-tsconfig.js';
import { DEFAULT_DISCOVERY_CONFIG, DEFAULT_NETWORK_PROXY_CONFIG, PRESET_EXTENSION_DIRS, READ_PRECHECK_MAX_BYTES, type ServerMessage, ServerMessageUnion, type SkillDirConfig, WORKFLOW_RUN_EVENT_TRUNCATE_BYTES, WorkflowRunOutcome, WorkflowRunStatus, type ClientMessage, type NetworkProxyConfig, type PluginEventPayload, type WorkflowRunEventsReply, validateNetworkProxyConfig } from '@taiji/shared';
import { getDataDir } from '@taiji/shared/paths';
import { ASK_USER_MARKER, INFLIGHT_REPORT_ACK, SESSION_MANAGER_MARKER, SUBAGENT_INFLIGHT_MARKER, UI_FORM_MARKER } from '@zhushanwen/extension-protocol';
import { ALL_RUN_OUTCOMES, doneReasonToRunOutcome, noteRebuiltSettlement, runSummary, type DoneReason, type WorkflowRun } from '@zhushanwen/subagent-core';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, mkdtemp, mkdtempSync, readFileSync, realpathSync, rm, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net, { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← plugin-sandbox-bundle.test.ts
// ======================================================================

// ======================================================================
// ← test/plugin-sandbox-process-guards.test.ts
// ======================================================================

const __dirname = dirname(fileURLToPath(import.meta.url))


const FIXTURE = resolve(__dirname, 'fixtures/sandbox-process-guards.fixture.cjs')


interface GuardResult {  // oe-exempt:20261027:test:
  killBlocked: boolean
  killErrorCode?: string
  ppidMasked: boolean
  ppidValue?: unknown
}


/** 临时 tsconfig（fork env TSX_TSCONFIG_PATH）：绕开 extension-protocol exports 缺 require 条件，见 helper 注释 */
let tsxTsconfig: TsxPathsTsconfig | null = null


/**
 * 在隔离 CJS 子进程中运行 fixture，返回 stdout 解析的 GuardResult。
 *
 * execArgv ['--import','tsx'] 让 tsx 注册 CJS hook，fixture 得以 require() 加载
 * plugin-bootstrap.ts 源码（与生产 tsup CJS 产物 require 语义一致）。
 */
function runFixture(): Promise<GuardResult> {
  return new Promise((resolveP, reject) => {
    const child = fork(FIXTURE, [], {
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, TSX_TSCONFIG_PATH: tsxTsconfig?.tsconfigPath },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`fixture exited ${code}. stderr=${stderr}`))
        return
      }
      try {
        resolveP(JSON.parse(stdout) as GuardResult)
      } catch (e) {
        reject(new Error(`fixture did not emit JSON: ${(e as Error).message}. stdout=${stdout} stderr=${stderr}`))
      }
    })
  })
}


// ======================================================================
// ← test/plugin-api-hooks.test.ts
// ======================================================================

// ── Helper: mock WorkerPort ──────────────────────────────────────────────

function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}


function extractLastResponse(port: ReturnType<typeof createMockPort>): RpcResponse & { error?: { code: number; message: string } } {
  const last = port.messages[port.messages.length - 1] as { response: RpcResponse }
  return last.response as RpcResponse & { error?: { code: number; message: string } }
}


// ── Helper: mock PluginRpcClient ─────────────────────────────────────────

interface MockRpcClient { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  requestCalls: Array<{ method: string; params: Record<string, unknown> }>
  requestResults: Map<string, unknown>
  onNotificationHandlers: Map<string, (params: unknown) => void>
  // 暴露与 PluginRpcClient 相同的接口
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  onNotification: (method: string, handler: (params: unknown) => void) => () => void
  notify: (method: string, params: Record<string, unknown>) => void
}


function createMockRpcClient(): MockRpcClient & PluginRpcClient {
  const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const requestResults = new Map<string, unknown>()
  const onNotificationHandlers = new Map<string, (params: unknown) => void>()

  return {
    requestCalls,
    requestResults,
    onNotificationHandlers,

    request: (method: string, params: Record<string, unknown>) => {
      requestCalls.push({ method, params })
      const result = requestResults.get(method)
      return Promise.resolve(result !== undefined ? result : undefined)
    },

    onNotification: (method: string, handler: (params: unknown) => void) => {
      // 每个 method 只允许一个 handler（在当前测试场景中够用）
      onNotificationHandlers.set(method, handler)
      return () => {
        onNotificationHandlers.delete(method)
      }
    },

    notify: (_method: string, _params: Record<string, unknown>) => {
      // 测试中不需要
    },
  } as unknown as MockRpcClient & PluginRpcClient
}


// ======================================================================
// ← test/plugin-api-tools.test.ts
// ======================================================================

/** 创建 mock WorkerPort，记录所有 postMessage 消息 */
function createMockPort_m2(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}


/** 从 mock port 的消息列表中提取最后一个 RPC 响应 */
function extractLastResponse_m2(port: ReturnType<typeof createMockPort_m2>): RpcResponse & { error?: { code: number; message: string } } {
  const last = port.messages[port.messages.length - 1] as { response: RpcResponse }
  return last.response as RpcResponse & { error?: { code: number; message: string } }
}


// ======================================================================
// ← test/plugin-bootstrap-tool-execute.test.ts
// ======================================================================

interface RpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}


const postedMessages: Array<{ type: string; response: RpcResponse }> = []


const registeredToolKeys: string[] = []


/** 注册 tool handler 并登记 key 供清理 */
function registerToolHandlerTracked(toolKey: string, handler: ToolExecuteHandler): void {
  registerToolHandler(toolKey, handler)
  registeredToolKeys.push(toolKey)
}


/** 经真实 handleMessage 驱动 rpc request 分支（handleIncomingRequest 在其内 fire-and-forget，flush 后返回） */
async function dispatchRpcRequest(request: {
  jsonrpc: '2.0'
  id: number | string | null
  method: string
  params?: unknown
}): Promise<void> {
  await handleMessage({ type: 'rpc', request } as HostToWorkerMessage)
  await new Promise(resolve => setImmediate(resolve))
}


/** 最小 mock PluginRpcClient（createHookApi 注册 hook 时需要） */
function createMockRpcClient_m2(): PluginRpcClient {
  const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  return {
    request: (method: string, params: Record<string, unknown>) => {
      requestCalls.push({ method, params })
      return Promise.resolve(undefined)
    },
    onNotification: () => () => {},
    notify: () => {},
    attach: () => {},
    requestCalls,
  } as unknown as PluginRpcClient
}


/** 经 createHookApi 注册一个 onBeforeSendMessage 拦截器，返回其 handlerId */
async function registerTestInterceptor(
  handler: (ctx: unknown) => Promise<{ proceed: boolean; reason?: string; modifiedData?: unknown }>,
): Promise<string> {
  const mockClient = createMockRpcClient_m2()
  const hookApi = createHookApi(mockClient, 'bootstrap-test-plugin')
  await hookApi.onBeforeSendMessage(handler)
  const registerCall = (mockClient as unknown as { requestCalls: Array<{ method: string; params: Record<string, unknown> }> })
    .requestCalls.find(c => c.method === 'plugin.hooks.register')
  return registerCall!.params.handlerId as string
}


// ======================================================================
// ← test/plugin-provider-access-plugin-side.test.ts
// ======================================================================

const PLUGIN_ID = 'plugin-wool-workbuddy'

 // deriveNamespace → 'wool-workbuddy'
const NS_PROVIDER_ID = 'wool-workbuddy'


/** 伪 manifest（provider-write-proxy 身份/命名空间/能力判定的输入） */
function manifestDeps(overrides: Partial<ProviderWriteProxyDeps> = {}): ProviderWriteProxyDeps {
  return {
    setProvider: vi.fn(async () => ({})),
    deleteProvider: vi.fn(async () => ({ removed: true })),
    resolveProviderCredential: vi.fn(async () => ({ key: 'sk-test', source: 'models.json', kind: 'api_key' } as const)),
    readPluginManifest: () => ({ pkgName: PLUGIN_ID, capabilities: ['network.http'] }),
    notifyProvidersMutated: vi.fn(),
    ...overrides,
  }
}


/**
 * Worker ↔ 宿主 双向泵：workerRpcClient 出站请求喂 rpcServer.dispatch；server 回包 /
 * 通知转回 client。in-flight dispatch 收集在 settle 里排干（出口 promise 依赖回喂，
 * 先 await 出口再 settle 一次排掉余量）。
 */
function wireLoop(rpcServer: PluginRpcServer) {
  const inflight: Array<Promise<void>> = []
  const port = {
    postMessage(msg: unknown) {
      const m = msg as {
        response?: unknown
        notification?: unknown
        method?: string
        id?: number
        params?: Record<string, unknown>
      }
      if (m.response !== undefined) {
        workerRpcClient.handleResponse(m.response as Parameters<typeof workerRpcClient.handleResponse>[0])
        return
      }
      if (m.notification !== undefined) {
        workerRpcClient.handleNotification(m.notification as Parameters<typeof workerRpcClient.handleNotification>[0])
        return
      }
      if (typeof m.method === 'string') {
        inflight.push(
          rpcServer
            .dispatch('w1', { jsonrpc: '2.0', id: m.id ?? 0, method: m.method, params: m.params ?? {} })
            .then(() => {}),
        )
      }
    },
  } as unknown as WorkerPort
  rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: PLUGIN_ID })
  workerRpcClient.attach(port)
  return {
    async settle() {
      await Promise.all(inflight.splice(0))
    },
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-sandbox-bundle', () => {
describe('plugin-sandbox', () => {
// 本文件另为 plugin-sandbox 合并载体（plugin-sandbox-escape 折叠为分节）。
/**
 * Task 2 测试: Worker Sandbox (require 拦截)
 *
 * 验证 sandbox 模式下 require 拦截逻辑：
 * - trusted Worker 的 require 不受限
 * - sandbox Worker require 被拦截（blockedBuiltins）
 * - process.env 被替换为空 Proxy
 *
 * 不创建真实 Worker Thread，只单元测试拦截函数逻辑。
 */


describe('Task 2: Worker Sandbox (require 拦截)', () => {
  describe('createRequireInterceptor', () => {
    // fixture 目录 mkdtemp 自建自删且测试侧先 realpathSync 归一：生产码
    // createRequireInterceptor 内部对 pluginDir 做 realpathSync 归一后再 startsWith
    // 判界（macOS tmpdir 经 /var → /private/var symlink）——目录缺失会走生产码
    // realpath warn + fail-closed 分支，未归一则断言传入的 resolvedPath 字符串与
    // 归一后的判界前缀恒不匹配。
    let pluginDir = ''

    beforeAll(() => {
      pluginDir = realpathSync(mkdtempSync(join(tmpdir(), 'taiji-plugin-sandbox-')))
    })

    afterAll(() => {
      if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('allows relative paths within pluginDir', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 应该不抛异常
      const inside = join(pluginDir, 'utils.js')
      const result = interceptor('./utils', inside)
      expect(result).toBe(inside)
    })

    it('rejects relative paths outside pluginDir', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 第二形态：嵌套穿越（./../../ 前缀），宿主 resolve 后同样落在 pluginDir 外
      const cases = [
        { request: '../escape', resolved: join(dirname(pluginDir), 'escape.js') },
        { request: './../../etc/passwd', resolved: join(dirname(pluginDir), 'etc', 'passwd') },
      ] as const
      for (const { request, resolved } of cases) {
        try {
          interceptor(request, resolved)
          expect.unreachable('should have thrown')
        } catch (err) {
          expect(err).toBeInstanceOf(Error)
          expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
        }
      }
    })

    it('rejects blocked builtin modules', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 'module'：node:module 暴露 createRequire，是绕过链第一环（黑名单必含）
      for (const mod of ['fs', 'child_process', 'net', 'module']) {
        try {
          interceptor(mod, undefined)
          expect.unreachable('should have thrown')
        } catch (err) {
          expect(err).toBeInstanceOf(Error)
          expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
        }
      }
    })

    it('rejects node: prefixed builtins (M6a-01 bypass regression)', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // CJS 侧黑名单查 node: 前缀剥离后的裸名：node:fs / node:child_process / node:module
      // 均须拦截（node:module 的 createRequire 是绕过链第一环）
      for (const mod of ['node:fs', 'node:fs/promises', 'node:child_process', 'node:module']) {
        try {
          interceptor(mod, undefined)
          expect.unreachable(`should have thrown for ${mod}`)
        } catch (err) {
          expect(err).toBeInstanceOf(Error)
          expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
        }
      }
    })

    it('allows node: prefixed safe builtins', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      // 安全模块的 node: 形态放行（require('node:path') 与 require('path') 等价）
      for (const mod of ['node:path', 'node:util', 'node:events']) {
        expect(interceptor(mod, undefined)).toBe(mod)
      }
    })

    it('allows path, url, util, events', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      for (const mod of ['path', 'url', 'util', 'events']) {
        const result = interceptor(mod, undefined)
        expect(result).toBe(mod)
      }
    })
  })

  describe('F1-24: fs 系两态放行（CJS 通道只读代理接线）', () => {
    // fs.read-user-data 的 CJS 通道落地（2026-10-24 裁决）：拦截器对 fs / fs/promises
    // 按能力声明两态放行——声明含该名 → 放行（initSandbox 的 Module._load patch 返回
    // 只读代理对象，与 ESM 通道同语义）；未声明 → PERMISSION_DENIED（fail-closed）。
    // 放行行为面（代理对象读写正反例）由 plugin-esm-loader.test.ts 的 buildProxyObject
    // 组与 sandbox-escape 的 fork 门控组覆盖，这里锁定拦截器判定面。
    let pluginDir = ''

    beforeAll(() => {
      pluginDir = realpathSync(mkdtempSync(join(tmpdir(), 'taiji-plugin-sandbox-fs2-')))
    })

    afterAll(() => {
      if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('声明 fs.read-user-data（allowed=fs,fs/promises）→ fs / fs/promises 两态放行（含 node: 前缀形态，不抛）', () => {
      const interceptor = createRequireInterceptor(pluginDir, ['fs', 'fs/promises'])
      expect(interceptor('fs', 'node:fs')).toBe('fs')
      expect(interceptor('node:fs', 'node:fs')).toBe('node:fs')
      expect(interceptor('fs/promises', 'node:fs/promises')).toBe('fs/promises')
      expect(interceptor('node:fs/promises', 'node:fs/promises')).toBe('node:fs/promises')
    })

    it('未声明 → fs / fs/promises PERMISSION_DENIED（fail-closed；能力声明只放行映射集）', () => {
      const interceptor = createRequireInterceptor(pluginDir, ['http', 'https'])
      for (const mod of ['fs', 'fs/promises']) {
        try {
          interceptor(mod, `node:${mod}`)
          expect.unreachable(`should have thrown for ${mod}`)
        } catch (err) {
          expect(err).toBeInstanceOf(Error)
          expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
        }
      }
    })
  })
})
// ════════════════ 来源: plugin-sandbox-escape.test.ts ════════════════

describe('plugin-sandbox-escape', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const LOADER_PATH = join(__dirname, '../src/services/plugin-service/plugin-esm-loader.cjs')
  // 专用 runner：回传 results 后不 exit（插件 console.log 副作用需 flush stdout）
  const RUNNER_PATH = join(__dirname, 'fixtures/sandbox-escape-runner.cjs')
  const BLOCKED_BUILTINS_SOURCE = join(__dirname, '../src/services/plugin-service/plugin-blocked-builtins.cjs')

  const TIMEOUT_MS = 15_000

  /** 本用例存活中的 runner 进程（afterEach 统一回收） */
  let activeChild: ReturnType<typeof fork> | null = null

  interface ImportResult {  // oe-exempt:20261027:test:
    label: string
    ok: boolean
    error?: string
  }

  const collectResults = (child: ReturnType<typeof fork>): Promise<ImportResult[]> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture did not respond in time')), TIMEOUT_MS)
      child.on('message', (msg: unknown) => {
        const m = msg as { type?: string; results?: ImportResult[] }
        if (m?.type === 'results') {
          clearTimeout(timer)
          resolve(m.results ?? [])
        }
      })
      child.on('exit', (code: number | null) => {
        // runner 正常存活到宿主 kill（code null / SIGTERM）；非 kill 退出视为失败
        if (code !== 0 && code !== null) {
          clearTimeout(timer)
          reject(new Error(`fixture exited with code ${code}`))
        }
      })
      child.on('error', (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
    })

  /** fork runner：真实 ESM loader + env（目录形态 = 包根遍历，对齐宿主 S1-W3 + ⑤ 注入） */
  function runInSandbox(
    pluginEntry: string,
    items: Array<{ label: string; url: string }>,
    extraEnv: Record<string, string> = {},
  ): { child: ReturnType<typeof fork>; results: Promise<ImportResult[]> } {
    const child = fork(RUNNER_PATH, [], {
      execArgv: ['--import', LOADER_PATH],
      env: {
        ...process.env,
        // 宿主（plugin-host-process env 注入处）的注入形态：入口向上首个含 package.json
        // 的祖先（⑤ 包根修正——子目录入口下 dirname 会把边界错划成 <插件目录>/src）
        TAIJI_PLUGIN_SANDBOX_DIR: findPackageRootDir(pluginEntry),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    activeChild = child
    const results = collectResults(child)
    child.send({ type: 'run', items })
    return { child, results }
  }

  describe.skipIf(!INTEGRATION_TESTS_ENABLED)(`S1-W3: sandbox escape regression (real fork + real ESM loader)${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`, () => {
    let pluginDir = ''

    afterEach(() => {
      // runner 不主动 exit，用例结束时统一回收（幂等：已退出的 kill 是 no-op）
      activeChild?.kill()
      activeChild = null
      if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      // 向上逃逸的沙箱外 node_modules 放在 pluginDir 父目录（mktemp 工作目录），单独清理
      if (pluginDir) rmSync(join(dirname(pluginDir), 'node_modules'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('SEC-A1(单元): node:fs 被拒（静态/动态）+ 同入口合法相对 import 成功', async () => {
      pluginDir = mkdtempSync(join(tmpdir(), 'escape-plugin-'))
      writeFileSync(join(pluginDir, 'sibling.mjs'), 'console.log("[escape] sibling loaded")\nexport const v = 1\n')
      // 静态形态：link 阶段即被 resolve hook 拒绝 → 整个模块加载失败
      writeFileSync(join(pluginDir, 'evil-static.mjs'), "import 'node:fs'\n")
      // 动态形态：合法 sibling 先执行，node:fs 动态 import 被 catch（模块本体加载成功，
      // 两个标记都经 stdout 可观察——sibling 成功与 node:fs 被拒互不牵连）
      writeFileSync(
        join(pluginDir, 'evil-dynamic.mjs'),
        [
          "const s = await import('./sibling.mjs')",
          'console.log("[escape] sibling loaded")',
          'try {',
          "  await import('node:fs')",
          '  console.log("[escape] NODE:FS LEAKED")',
          '} catch (e) {',
          "  console.log('[escape] node:fs rejected: ' + (e && e.message))",
          '}',
          'export const loaded = s.v',
        ].join('\n'),
      )

      const stdoutChunks: string[] = []
      const { child, results } = runInSandbox(join(pluginDir, 'evil-dynamic.mjs'), [
        { label: 'evil-static', url: pathToFileURL(join(pluginDir, 'evil-static.mjs')).href },
        { label: 'evil-dynamic', url: pathToFileURL(join(pluginDir, 'evil-dynamic.mjs')).href },
      ])
      child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(String(d)))
      const all = await results
      const staticResult = all.find((r) => r.label === 'evil-static')
      const dynamicResult = all.find((r) => r.label === 'evil-dynamic')

      // 静态：拦截错误可定位（含被拒 specifier），code 语义为 PERMISSION_DENIED
      expect(staticResult?.ok).toBe(false)
      expect(staticResult?.error).toContain("Sandbox: import('node:fs') is blocked")
      expect(staticResult?.error).toContain('PERMISSION_DENIED')
      // 动态：模块本体加载成功（合法 import 不受牵连）
      expect(dynamicResult?.ok).toBe(true)

      const stdout = () => stdoutChunks.join('')
      await vi.waitFor(() => expect(stdout()).toContain('[escape] sibling loaded'), { timeout: 5000, interval: 100 })
      // node:fs 动态 import 同样被拒（错误文案含被拒 specifier），无泄漏标记
      await vi.waitFor(() => expect(stdout()).toContain("node:fs rejected: Sandbox: import('node:fs') is blocked"), {
        timeout: 5000,
        interval: 100,
      })
      expect(stdout()).not.toContain('NODE:FS LEAKED')
      child.kill()
    }, TIMEOUT_MS)

    it('SEC-A2(单元): 裸名 import 向上遍历命中沙箱外 node_modules 副本被拒', async () => {
      pluginDir = mkdtempSync(join(tmpdir(), 'escape-plugin-'))
      // 沙箱外副本：pluginDir 上层的 node_modules（Node 裸名解析会向上命中这里）
      const outsideModules = join(dirname(pluginDir), 'node_modules', 'escape-evil-pkg')
      mkdirSync(outsideModules, { recursive: true })
      writeFileSync(join(outsideModules, 'package.json'), JSON.stringify({ name: 'escape-evil-pkg', version: '1.0.0', main: 'index.mjs' }))
      writeFileSync(join(outsideModules, 'index.mjs'), 'console.log("[escape] EVIL PKG EXECUTED")\nexport const v = 1\n')
      // 界内合法依赖对照（pluginDir/node_modules 内 → 放行）
      const insideModules = join(pluginDir, 'node_modules', 'escape-ok-pkg')
      mkdirSync(insideModules, { recursive: true })
      writeFileSync(join(insideModules, 'package.json'), JSON.stringify({ name: 'escape-ok-pkg', version: '1.0.0', main: 'index.mjs' }))
      writeFileSync(join(insideModules, 'index.mjs'), 'export const v = 2\n')
      // 发起者文件必须在 pluginDir 内（loader 只拦插件代码发起的 import）
      writeFileSync(join(pluginDir, 'evil-bare.mjs'), "import 'escape-evil-pkg'\n")
      writeFileSync(join(pluginDir, 'ok-bare.mjs'), "import 'escape-ok-pkg'\n")

      const { child, results } = runInSandbox(join(pluginDir, 'entry.mjs'), [
        { label: 'evil-bare', url: pathToFileURL(join(pluginDir, 'evil-bare.mjs')).href },
        { label: 'ok-bare', url: pathToFileURL(join(pluginDir, 'ok-bare.mjs')).href },
      ])
      const all = await results
      child.kill()
      const evilBare = all.find((r) => r.label === 'evil-bare')
      const okBare = all.find((r) => r.label === 'ok-bare')

      // 出界裸名：解析结果在沙箱外 → 拒（修复前该 import 成功且后续 import 全绕过 hook）
      expect(evilBare?.ok).toBe(false)
      expect(evilBare?.error).toContain("Sandbox: import('escape-evil-pkg') resolves outside plugin directory")
      expect(evilBare?.error).toContain('PERMISSION_DENIED')
      // 界内 node_modules（合法依赖形态）：放行
      expect(okBare?.ok).toBe(true)
    }, TIMEOUT_MS)

    it('SEC-A3(单元): 子目录入口 + 包根内 node_modules 依赖放行（真实发布形态，⑤ 包根修正回归）', async () => {
      // 真实发布形态 fixture：manifest main = src/index.ts（此处以 src/index.mjs 承载），
      // 依赖装在 pluginDir/node_modules（④ 修复后的安装落点）。修复前宿主注入
      // dirname(entry) = <pluginDir>/src，界内依赖被判越界激活即炸（d3-r2 实测）；
      // 修复后 sandboxDir = 包根（向上首个含 package.json 的祖先），裸导入界内解析放行。
      pluginDir = mkdtempSync(join(tmpdir(), 'escape-plugin-'))
      writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
        name: '@fixture/plugin-sub-entry',
        version: '1.0.0',
        main: 'src/index.mjs',
      }))
      const insideModules = join(pluginDir, 'node_modules', 'escape-sub-dep')
      mkdirSync(insideModules, { recursive: true })
      writeFileSync(join(insideModules, 'package.json'), JSON.stringify({ name: 'escape-sub-dep', version: '1.0.0', main: 'index.mjs' }))
      writeFileSync(join(insideModules, 'index.mjs'), 'export const v = 3\n')
      mkdirSync(join(pluginDir, 'src'), { recursive: true })
      writeFileSync(join(pluginDir, 'src', 'index.mjs'), "import 'escape-sub-dep'\nexport const loaded = true\n")

      // findPackageRootDir 是宿主 env 注入处（plugin-host-process）的消费函数——
      // 本断言钉住「子目录入口 → 包根」的推导，env 注入即用推导值
      expect(findPackageRootDir(join(pluginDir, 'src', 'index.mjs'))).toBe(pluginDir)

      const { child, results } = runInSandbox(join(pluginDir, 'src', 'index.mjs'), [
        { label: 'sub-entry-bare', url: pathToFileURL(join(pluginDir, 'src', 'index.mjs')).href },
      ])
      const all = await results
      child.kill()
      const bare = all.find((r) => r.label === 'sub-entry-bare')
      expect(bare?.ok).toBe(true)
    }, TIMEOUT_MS)

    it('CAP-PERM(单元): 放行 network.http 后 import node:vm 仍被拒（永久封禁不受放行清单影响）', async () => {
      // provider-plugin-access D3：vm 属永久封禁 7 项，computeBlockedBuiltins 对
      // allowed 含 vm 免疫；本用例以 network.http 的放行集（http/https/net/dns/tls）
      // 注入 fork env，验证真 fork + 真 loader 下 https 放行生效、vm 仍拦。
      // fixture 必须复制进 sandbox（仓库路径的 parentURL 出界 → loader 整体放行，
      // 对齐 P-perm runFixture 的同款约束）。
      pluginDir = mkdtempSync(join(tmpdir(), 'escape-plugin-'))
      const fixtureEntry = join(pluginDir, 'vm-blocked.mjs')
      writeFileSync(fixtureEntry, readFileSync(join(__dirname, 'plugin-perm-fixtures', 'vm-blocked.mjs'), 'utf-8'))
      const { child, results } = runInSandbox(fixtureEntry, [
        { label: 'vm-blocked', url: pathToFileURL(fixtureEntry).href },
      ], {
        // 与宿主 buildPluginCapabilityForkEnv 同形态的 JSON 数组编码
        TAIJI_PLUGIN_ALLOWED_MODULES: JSON.stringify(['http', 'https', 'net', 'dns', 'tls']),
        TAIJI_PLUGIN_READ_PATHS: '[]',
      })
      // fixture 顶层执行后经 fork IPC 回传 perm-result（vm/https 两项判定）
      const permResult = await new Promise<{ label: string; out: Record<string, string | { ok: boolean }> }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('perm fixture did not respond in time')), TIMEOUT_MS)
        child.on('message', (msg: unknown) => {
          const m = msg as { type?: string; label?: string; out?: Record<string, string | { ok: boolean }> }
          if (m?.type === 'perm-result' && m.label === 'vm-blocked') {
            clearTimeout(timer)
            resolve(m as { label: string; out: Record<string, string | { ok: boolean }> })
          }
        })
      })
      const all = await results
      child.kill()
      // runner 的 import 完成回执（fixture 模块本体加载成功 = 两个动态 import 都被捕获）
      expect(all.find((r) => r.label === 'vm-blocked')?.ok).toBe(true)
      // 放行生效对照面：node:https import 成功
      expect(permResult.out.https).toBe('ok')
      // 新增断言（设计 §4）：network.http 放行后 node:vm 仍被拒（PERMISSION_DENIED）
      expect(permResult.out.vm).toBe('PERMISSION_DENIED')
    }, TIMEOUT_MS)
  })

  describe('S1-W3: CJS interceptor boundary (/, file:, bare-name resolved)', () => {
    // fixture 目录 mkdtemp 自建自删且测试侧先 realpathSync 归一：生产码
    // createRequireInterceptor 内部对 pluginDir 做 realpathSync 归一后再 startsWith 判界
    // （macOS tmpdir 经 /var → /private/var symlink）——目录缺失会走生产码 realpath warn
    // + fail-closed 分支（vitest 解析 warn 的 Error stack 会炸 sourcemap artifact），
    // 未归一则断言传入的 resolvedPath 字符串与归一后的判界前缀恒不匹配。
    let pluginDir = ''
    let outsideRoot = ''
    let outsideEntry = ''
    let interceptor: ReturnType<typeof createRequireInterceptor>

    beforeAll(() => {
      pluginDir = realpathSync(mkdtempSync(join(tmpdir(), 'taiji-plugin-sandbox-cjs-')))
      // 出界对照路径：mkdtemp 父目录下的兄弟路径必然不共享 pluginDir 前缀
      outsideRoot = dirname(pluginDir)
      outsideEntry = join(outsideRoot, 'sandbox-outside-evil.cjs')
      interceptor = createRequireInterceptor(pluginDir)
    })

    afterAll(() => {
      if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('rejects absolute path requests outside pluginDir (SEC-A2 CJS 通道)', () => {
      expect(() => interceptor(outsideEntry, outsideEntry)).toThrowError(
        `Sandbox: require('${outsideEntry}') resolves outside plugin directory`,
      )
    })

    it('rejects file: URL requests outside pluginDir', () => {
      const outsideUrl = pathToFileURL(outsideEntry).href
      expect(() => interceptor(outsideUrl, outsideUrl)).toThrowError(/resolves outside plugin directory/)
    })

    it('allows absolute path requests inside pluginDir', () => {
      const insideEntry = join(pluginDir, 'helper.cjs')
      expect(interceptor(insideEntry, insideEntry)).toBe(insideEntry)
    })

    it('rejects bare-name require resolving to node_modules outside pluginDir', () => {
      expect(() =>
        interceptor('escape-evil-pkg', join(outsideRoot, 'node_modules', 'escape-evil-pkg', 'index.js')),
      ).toThrowError(/resolves outside plugin directory/)
    })

    it('allows bare-name require resolving inside pluginDir/node_modules', () => {
      expect(interceptor('ok-pkg', join(pluginDir, 'node_modules', 'ok-pkg', 'index.js'))).toBe('ok-pkg')
    })

    it('still allows builtin bare names (resolvedPath 非文件形态)', () => {
      expect(interceptor('path', 'node:path')).toBe('path')
      expect(interceptor('node:util', 'node:util')).toBe('node:util')
    })
  })

  describe('F1-9: CJS require 拦截接入能力词表（computeBlockedBuiltins）', () => {
    // 探针四判定（F1-10 修复契约）：声明 network.http 后 https 由拒变放行、fs 未声明拒
    // （CJS 通道 fs 系只走 FS_PROXY_MODULES 两态放行——声明 fs.read-user-data 才放行，
    // 由 Module._load patch 返回只读代理对象）、vm 永久拒、os 免声明放行。
    // 与「CJS interceptor boundary」同层：拦截器纯函数 in-process，无进程无时钟。
    let pluginDir = ''

    beforeAll(() => {
      pluginDir = realpathSync(mkdtempSync(join(tmpdir(), 'taiji-plugin-sandbox-cjs-cap-')))
    })

    afterAll(() => {
      if (pluginDir) rmSync(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('声明 network.http（allowed=http,https,net,dns,tls）→ https 放行、fs 拒、vm 永久拒、os 免声明放行', () => {
      const interceptor = createRequireInterceptor(pluginDir, ['http', 'https', 'net', 'dns', 'tls'])
      // 正例：声明能力对应的模块放行（含 node: 前缀形态，M6a-01 剥离对称）
      expect(interceptor('https', 'node:https')).toBe('https')
      expect(interceptor('node:https', 'node:https')).toBe('node:https')
      // 反例：fs 未声明 → 拒（CJS 通道 fs 系只走只读代理放行——声明 fs.read-user-data
      // 才两态放行，由 Module._load patch 返回代理对象，见 F1-24 fork 组）
      expect(() => interceptor('fs', 'node:fs')).toThrowError(/is blocked/)
      expect(() => interceptor('fs/promises', 'node:fs/promises')).toThrowError(/is blocked/)
      // 反例：vm 永久封禁，allowed 注入也不放行（fail-closed 免疫）
      expect(() => interceptor('vm', 'node:vm')).toThrowError(/is blocked/)
      // 对照：os 不在基线黑名单，免声明放行（D3 裁决移出）
      expect(interceptor('os', 'node:os')).toBe('os')
      // 基线未放行的其余模块仍拦（能力声明只放行映射集）
      expect(() => interceptor('child_process', 'node:child_process')).toThrowError(/is blocked/)
    })

    it('未声明能力（allowed 缺省空集）→ https 拒（基线全拦，fail-closed 向后兼容）', () => {
      const interceptor = createRequireInterceptor(pluginDir)
      expect(() => interceptor('https', 'node:https')).toThrowError(/is blocked/)
      expect(() => interceptor('fs', 'node:fs')).toThrowError(/is blocked/)
      expect(interceptor('path', 'node:path')).toBe('path')
    })
  })

  describe('S1-W3: BLOCKED_BUILTINS SSOT 防退化', () => {
    it('plugin-sandbox.ts 导出与 plugin-blocked-builtins.cjs 数据源逐元素相等', () => {
      // 直接 require 真实 .cjs（绕过 plugin-sandbox.ts 的 import），抓「TS 侧改回内联」漂移
      const requireFromTest = createRequire(import.meta.url)
      const source = requireFromTest(BLOCKED_BUILTINS_SOURCE) as {
        BLOCKED_BUILTINS: readonly string[]
        PERMANENTLY_BLOCKED_BUILTINS: readonly string[]
        computeBlockedBuiltins: (allowed: readonly string[] | unknown) => readonly string[]
      }
      expect([...BLOCKED_BUILTINS]).toEqual([...source.BLOCKED_BUILTINS])
      // 数据源非空且含关键高危模块（空数组会让所有黑名单检查静默失效）
      expect(source.BLOCKED_BUILTINS.length).toBeGreaterThan(0)
      expect(source.BLOCKED_BUILTINS).toContain('fs')
      expect(source.BLOCKED_BUILTINS).toContain('child_process')
      expect(source.BLOCKED_BUILTINS).toContain('module')
      expect(source.BLOCKED_BUILTINS).toContain('cluster')
      expect(source.BLOCKED_BUILTINS).toContain('dgram')
      expect(source.BLOCKED_BUILTINS).toContain('dns')
      expect(source.BLOCKED_BUILTINS).toContain('net')
    })

    it('D3 基线形态：16 项（os 移出）+ 永久封禁 7 项恒在基线', () => {
      const requireFromTest = createRequire(import.meta.url)
      const source = requireFromTest(BLOCKED_BUILTINS_SOURCE) as {
        BLOCKED_BUILTINS: readonly string[]
        PERMANENTLY_BLOCKED_BUILTINS: readonly string[]
      }
      // provider-plugin-access D3：os 移出基线（17 → 16）——os 免声明可用是
      // fs.read-user-data 落地的前提（拼 IDE 配置路径需要 homedir()）
      expect(source.BLOCKED_BUILTINS).toHaveLength(16)
      expect(source.BLOCKED_BUILTINS).not.toContain('os')
      // 永久封禁 7 项（vm/worker_threads/module/cluster/dgram/readline/v8）任何
      // 能力词都不可放行——恒在基线
      expect(source.PERMANENTLY_BLOCKED_BUILTINS).toEqual([
        'cluster',
        'dgram',
        'readline',
        'v8',
        'vm',
        'worker_threads',
        'module',
      ])
      for (const name of source.PERMANENTLY_BLOCKED_BUILTINS) {
        expect(source.BLOCKED_BUILTINS, name).toContain(name)
      }
    })

    it('D3 放行计算：allowed 与基线交集放行；永久封禁对 allowed 免疫', () => {
      const requireFromTest = createRequire(import.meta.url)
      const source = requireFromTest(BLOCKED_BUILTINS_SOURCE) as {
        BLOCKED_BUILTINS: readonly string[]
        PERMANENTLY_BLOCKED_BUILTINS: readonly string[]
        computeBlockedBuiltins: (allowed: readonly string[] | unknown) => readonly string[]
      }
      const { computeBlockedBuiltins, BLOCKED_BUILTINS, PERMANENTLY_BLOCKED_BUILTINS } = source

      // 空放行 = 基线原样（无能力声明插件的 fail-closed 缺省）
      expect(computeBlockedBuiltins([])).toEqual([...BLOCKED_BUILTINS])
      expect(computeBlockedBuiltins(undefined)).toEqual([...BLOCKED_BUILTINS])

      // network.http 全集放行后：5 个网络模块移出黑名单，其余基线保持
      const httpAllowed = ['http', 'https', 'net', 'dns', 'tls']
      const afterHttp = computeBlockedBuiltins(httpAllowed)
      for (const name of httpAllowed) expect(afterHttp, name).not.toContain(name)
      expect(afterHttp).toContain('fs')
      expect(afterHttp).toContain('child_process')
      expect(afterHttp).toHaveLength(16 - httpAllowed.length)

      // 永久封禁免疫：allowed 注入 'vm' 也不放行（防 env 注入错误 / 词表演进误入）
      expect(computeBlockedBuiltins(['vm'])).toContain('vm')
      expect(computeBlockedBuiltins([...PERMANENTLY_BLOCKED_BUILTINS])).toEqual(
        expect.arrayContaining([...PERMANENTLY_BLOCKED_BUILTINS]),
      )
      // 全部可放行项（基线 − 永久封禁）声明后：黑名单只剩永久封禁 7 项
      const allReleasable = BLOCKED_BUILTINS.filter((n) => !PERMANENTLY_BLOCKED_BUILTINS.includes(n))
      expect(computeBlockedBuiltins(allReleasable)).toEqual([...PERMANENTLY_BLOCKED_BUILTINS])
    })

    it('D3 词表对账：shared 能力词映射的放行集并集 = 基线可放行项（9 项，两侧不漂移）', async () => {
      const requireFromTest = createRequire(import.meta.url)
      const source = requireFromTest(BLOCKED_BUILTINS_SOURCE) as {
        BLOCKED_BUILTINS: readonly string[]
        PERMANENTLY_BLOCKED_BUILTINS: readonly string[]
      }
      const { resolveAllowedModules, PLUGIN_CAPABILITIES } = await import(
        '@taiji/shared/plugin-capability-map'
      )
      const releasable = source.BLOCKED_BUILTINS.filter(
        (n) => !source.PERMANENTLY_BLOCKED_BUILTINS.includes(n),
      )
      const fromCapabilityMap = resolveAllowedModules([...PLUGIN_CAPABILITIES]).allowed
      expect([...fromCapabilityMap].sort()).toEqual([...releasable].sort())
    })

    it('ESM loader 消费同一数据源（源码含 require 引用，防回退为内联数组）', () => {
      const loaderSrc = readFileSync(LOADER_PATH, 'utf-8')
      expect(loaderSrc).toContain("require('./plugin-blocked-builtins.cjs')")
    })
  })

  // D6 B3 恢复（原 S-36 describe 内的 F1-9 接线用例，8a4439914 连带删除）：真实
  // initSandbox 消费 TAIJI_PLUGIN_ALLOWED_MODULES env（宿主 buildPluginCapabilityForkEnv
  // 注入形态）→ 声明 network.http 后 CJS require('https') 放行、require('fs') 未声明拒
  // （CJS 通道 fs 系只走只读代理放行）、require('vm') 永久拒。initSandbox 修改全局
  // process.env / Module._resolveFilename / Module._load，必须 fork 调用（进程退出即丢弃污染）。
  describe.skipIf(!INTEGRATION_TESTS_ENABLED)(`F1-9: CJS 通道能力词表 fork 级接线${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`, () => {
    const PLUGIN_BOOTSTRAP_TS = join(__dirname, '../src/services/plugin-service/plugin-bootstrap.ts')
    const RUNTIME_ROOT = join(__dirname, '..')

    it('initSandbox 读 TAIJI_PLUGIN_ALLOWED_MODULES → https 放行 / fs / vm 拒', async () => {
      const tsxTsconfig = createTsxPathsTsconfig()
      try {
        const workDir = mkdtempSync(join(tmpdir(), 'f19-cjs-cap-'))
        const pluginDir = join(workDir, 'plugin')
        mkdirSync(pluginDir)
        const fixturePath = join(workDir, 'fixture.cjs')
        writeFileSync(
          fixturePath,
          [
            "'use strict'",
            '// F1-9 fixture：initSandbox（env 已注入放行清单）→ 逐模块 try require 回传结果',
            `const { initSandbox } = require(${JSON.stringify(PLUGIN_BOOTSTRAP_TS)})`,
            `initSandbox(${JSON.stringify(pluginDir)})`,
            'const tryRequire = (name) => {',
            '  try { require(name); return "ok" }',
            '  catch (e) { return e && e.code === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "other:" + String(e && e.code) }',
            '}',
            'process.stdout.write("F19_RESULT:" + JSON.stringify({',
            '  https: tryRequire("https"),',
            '  fs: tryRequire("fs"),',
            '  vm: tryRequire("vm"),',
            '  os: tryRequire("os"),',
            '}))',
            '',
          ].join('\n'),
        )

        const result = await new Promise<Record<string, string>>((resolveP, reject) => {
          const child = fork(fixturePath, [], {
            execPath: process.execPath,
            execArgv: ['--import', 'tsx'],
            cwd: RUNTIME_ROOT,
            env: {
              ...process.env,
              TSX_TSCONFIG_PATH: tsxTsconfig.tsconfigPath,
              // 宿主注入形态：JSON 数组字符串（buildPluginCapabilityForkEnv 编码）
              TAIJI_PLUGIN_ALLOWED_MODULES: JSON.stringify(['http', 'https', 'net', 'dns', 'tls']),
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          })
          let stdout = ''
          let stderr = ''
          child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
          child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
          child.on('error', reject)
          child.on('close', (code) => {
            const line = stdout.split('\n').find((l) => l.startsWith('F19_RESULT:'))
            if (code !== 0 || !line) {
              reject(new Error(`fixture exited ${code}. stdout=${stdout} stderr=${stderr}`))
              return
            }
            try {
              resolveP(JSON.parse(line.slice('F19_RESULT:'.length)) as Record<string, string>)
            } catch (e) {
              reject(new Error(`fixture result parse failed: ${(e as Error).message}`))
            }
          })
        })
        rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

        expect(result.https).toBe('ok')
        expect(result.fs).toBe('PERMISSION_DENIED')
        expect(result.vm).toBe('PERMISSION_DENIED')
        expect(result.os).toBe('ok')
      } finally {
        tsxTsconfig.dispose()
      }
    }, 30_000)
  })

  // F1-24（2026-10-24 裁决落地）：CJS 通道 fs.read-user-data 真进程正反例。声明能力
  // 的插件 require('fs') / require('fs/promises') 拿到只读代理对象（读白名单成功 /
  // 白名单外拒 / 写改 API 拒 / open 写 flags 拒 / FileHandle 写方法拒 / promises 面同
  // 语义）；未声明的对照插件 require('fs') 直接 PERMISSION_DENIED（fail-closed）。
  // fixture 与 F1-9 同形态：隔离子进程 require 真实 plugin-bootstrap.ts 调 initSandbox
  // （全局污染随进程退出丢弃）。判定本质 = 拦截器 + Module._load patch + fs 代理对象
  // 在真实子进程链路下的组合行为，无进程内完成信号可等，本地默认跳过（e2e-map 规则
  // 按 on-diff 触发）；判定面已由 plugin-esm-loader.test.ts 的 buildProxyObject 组与
  // plugin-sandbox.test.ts 的两态组在 in-process 层覆盖。
  describe.skipIf(!INTEGRATION_TESTS_ENABLED)(`F1-24: CJS 通道 fs 只读代理 fork 级接线${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`, () => {
    const PLUGIN_BOOTSTRAP_TS = join(__dirname, '../src/services/plugin-service/plugin-bootstrap.ts')
    const RUNTIME_ROOT = join(__dirname, '..')

    /** 组装 fixture 源码（公共壳：先捕获目标路径 env → initSandbox → body 判定 → stdout 回传） */
    function buildF124Fixture(pluginDir: string, body: string): string {
      return [
        "'use strict'",
        `const { initSandbox } = require(${JSON.stringify(PLUGIN_BOOTSTRAP_TS)})`,
        '// initSandbox 会把 process.env 换成空 Proxy——目标路径必须在调用前捕获',
        'const TARGET = process.env.TAIJI_F124_TARGET',
        'const OUTSIDE = process.env.TAIJI_F124_OUTSIDE',
        `initSandbox(${JSON.stringify(pluginDir)})`,
        ';(async () => {',
        body,
        '})().catch((e) => {',
        "  process.stdout.write('F124_RESULT:' + JSON.stringify({ fatal: String((e && e.stack) || e) }))",
        '})',
        '',
      ].join('\n')
    }

    /**
     * fork 隔离子进程跑 fixture（tsx 装配 + 临时目录自建自删），解析 F124_RESULT 行。
     * setup（可选）在临时家目录内播种文件并返回 fork env（HOME / 能力 env / 目标路径——
     * 目标路径依赖 homeDir 实际值，故 env 在播种后构建）。
     */
    async function runF124(
      fixtureBody: string,
      setup?: (homeDir: string) => Record<string, string>,
    ): Promise<Record<string, string>> {
      const tsxTsconfig = createTsxPathsTsconfig()
      let workDir = ''
      let homeDir = ''
      let forkEnv: Record<string, string> = {}
      try {
        workDir = mkdtempSync(join(tmpdir(), 'f124-cjs-proxy-'))
        const pluginDir = join(workDir, 'plugin')
        mkdirSync(pluginDir)
        const fixturePath = join(workDir, 'fixture.cjs')
        writeFileSync(fixturePath, buildF124Fixture(pluginDir, fixtureBody))
        if (setup) {
          homeDir = mkdtempSync(join(tmpdir(), 'f124-home-'))
          forkEnv = setup(homeDir)
        }
        return await new Promise<Record<string, string>>((resolveP, reject) => {
          const child = fork(fixturePath, [], {
            execPath: process.execPath,
            execArgv: ['--import', 'tsx'],
            cwd: RUNTIME_ROOT,
            env: {
              ...process.env,
              TSX_TSCONFIG_PATH: tsxTsconfig.tsconfigPath,
              ...forkEnv,
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          })
          let stdout = ''
          let stderr = ''
          child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
          child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
          child.on('error', reject)
          child.on('close', (code) => {
            const line = stdout.split('\n').find((l) => l.startsWith('F124_RESULT:'))
            if (code !== 0 || !line) {
              reject(new Error(`fixture exited ${code}. stdout=${stdout} stderr=${stderr}`))
              return
            }
            try {
              resolveP(JSON.parse(line.slice('F124_RESULT:'.length)) as Record<string, string>)
            } catch (e) {
              reject(new Error(`fixture result parse failed: ${(e as Error).message}`))
            }
          })
        })
      } finally {
        tsxTsconfig.dispose()
        if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
        if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    }

    it("声明 fs.read-user-data → require('fs') / require('fs/promises') 为只读代理（读白名单成 / 白名单外拒 / 写改与写 flags 拒 / FileHandle 写拒）", async () => {
      const body = [
        'const out = {}',
        "const resultOf = (fn) => { try { return fn() } catch (e) { return (e && e.code) || 'ERR' } }",
        "const fs = require('fs')",
        'out.insideRead = resultOf(() => fs.readFileSync(TARGET, "utf-8"))',
        'out.outsideRead = resultOf(() => fs.readFileSync(OUTSIDE, "utf-8"))',
        'out.writeFileSync = resultOf(() => fs.writeFileSync(TARGET, "x"))',
        'out.openWriteFlags = resultOf(() => { const fd = fs.openSync(TARGET, "w"); fs.closeSync(fd) })',
        'out.openReadFlagsRead = resultOf(() => {',
        '  const fd = fs.openSync(TARGET, "r")',
        '  const buf = Buffer.alloc(14)',
        '  const bytes = fs.readSync(fd, buf, 0, 14, 0)',
        '  fs.closeSync(fd)',
        '  return buf.toString("utf-8", 0, bytes)',
        '})',
        "const fsp = require('fs/promises')",
        "out.promisesRead = await fsp.readFile(TARGET, 'utf-8').then((v) => v, (e) => (e && e.code) || 'ERR')",
        "out.promisesWrite = await fsp.writeFile(TARGET, 'x').then(() => 'LEAKED', (e) => (e && e.code) || 'ERR')",
        "out.handleWrite = await fsp.open(TARGET, 'r').then(async (h) => {",
        '  try {',
        "    await h.write('x')",
        "    return 'LEAKED'",
        '  } catch (e) {',
        "    return (e && e.code) || 'ERR'",
        '  } finally {',
        '    await h.close()',
        '  }',
        "}, (e) => 'OPEN_FAILED:' + ((e && e.code) || 'ERR'))",
        "process.stdout.write('F124_RESULT:' + JSON.stringify(out))",
      ].join('\n')
      // readPaths 家目录相对语义（'data/in.txt'）经 HOME 注入临时家目录（initSandbox
      // 的 fsGuard.configure 经 os.homedir() 推导），与 P-perm 门控组同款约束
      const result = await runF124(body, (homeDir) => {
        mkdirSync(join(homeDir, 'data'), { recursive: true })
        writeFileSync(join(homeDir, 'data', 'in.txt'), 'inside-content')
        writeFileSync(join(homeDir, 'data', 'out.txt'), 'outside-content')
        return {
          HOME: homeDir,
          TAIJI_PLUGIN_ALLOWED_MODULES: JSON.stringify(['fs', 'fs/promises']),
          TAIJI_PLUGIN_READ_PATHS: JSON.stringify(['data/in.txt']),
          TAIJI_F124_TARGET: join(homeDir, 'data', 'in.txt'),
          TAIJI_F124_OUTSIDE: join(homeDir, 'data', 'out.txt'),
        }
      })

      expect(result.insideRead).toBe('inside-content')
      expect(result.outsideRead).toBe('PERMISSION_DENIED')
      expect(result.writeFileSync).toBe('PERMISSION_DENIED')
      expect(result.openWriteFlags).toBe('PERMISSION_DENIED')
      // fd 族读 API（fd 只能来自受 flags 检查的 open）
      expect(result.openReadFlagsRead).toBe('inside-content')
      expect(result.promisesRead).toBe('inside-content')
      expect(result.promisesWrite).toBe('PERMISSION_DENIED')
      expect(result.handleWrite).toBe('PERMISSION_DENIED')
      expect(JSON.stringify(result)).not.toContain('LEAKED')
    }, 30_000)

    it("未声明能力的对照插件 → require('fs') / require('fs/promises') 直接 PERMISSION_DENIED（fail-closed）；os 免声明不误伤", async () => {
      const body = [
        'const out = {}',
        "try { require('fs'); out.fs = 'LEAKED' } catch (e) { out.fs = (e && e.code) || 'ERR' }",
        "try { require('fs/promises'); out.fsPromises = 'LEAKED' } catch (e) { out.fsPromises = (e && e.code) || 'ERR' }",
        "try { require('os'); out.os = 'ok' } catch (e) { out.os = (e && e.code) || 'ERR' }",
        "process.stdout.write('F124_RESULT:' + JSON.stringify(out))",
      ].join('\n')
      const result = await runF124(body, (homeDir) => ({
        HOME: homeDir,
        TAIJI_PLUGIN_ALLOWED_MODULES: JSON.stringify([]),
        TAIJI_PLUGIN_READ_PATHS: JSON.stringify([]),
      }))
      expect(result.fs).toBe('PERMISSION_DENIED')
      expect(result.fsPromises).toBe('PERMISSION_DENIED')
      expect(result.os).toBe('ok')
    }, 30_000)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-sandbox-process-guards', () => {
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `MF-1: initSandbox process 检查（process.kill / process.ppid）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`,
  () => {
  // 临时 tsconfig 生命周期 = describe 级（mkdtemp 自建自删，测试红线）
  beforeAll(() => {
    tsxTsconfig = createTsxPathsTsconfig()
  })
  afterAll(() => {
    tsxTsconfig?.dispose()
    tsxTsconfig = null
  })
  // 超时登记（用例级门控后仅集成组真跑时生效）：真实 fork 子进程 + execArgv
  // ['--import','tsx'] 注册链，CI 满并行下冷启可达数秒超 vitest 默认 5s testTimeout；
  // 本地实测 0.25s——15s 是 CI 负载余量非真实耗时，且只作用于门控开启后的集成组。
  it('process.kill 被封堵 → 抛 PERMISSION_DENIED（阻断 DoS 向量）', async () => {
    const result = await runFixture()
    // MF-2 核心防护：sandbox 插件 process.kill(process.ppid,'SIGKILL') 必须被拦截
    expect(result.killBlocked).toBe(true)
    expect(result.killErrorCode).toBe('PERMISSION_DENIED')
  }, 15000)

  // 超时登记同上（同一 fork + tsx 注册链，15s = CI 负载余量，本地实测 0.25s）
  it('process.ppid 被屏蔽 → undefined（阻断父进程 PID 定位）', async () => {
    const result = await runFixture()
    expect(result.ppidMasked).toBe(true)
    expect(result.ppidValue).toBeNull()
  }, 15000)
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-api-hooks', () => {
// ── 主线程侧：registerHookRpcHandlers ─────────────────────────────────

describe('Hook API — registerHookRpcHandlers', () => {
  let rpc: PluginRpcServer
  let hookRegistry: Map<string, HookEntry[]>
  let port: ReturnType<typeof createMockPort>

  /** mock getDescriptor：根据 source/trustLevel 返回不同优先级 */
  let mockDescriptors = new Map<string, PluginDescriptor>()

  beforeEach(() => {
    rpc = new PluginRpcServer()
    hookRegistry = new Map()
    mockDescriptors = new Map()

    registerHookRpcHandlers(rpc, {
      hookRegistry,
      getDescriptor: (pluginId) => mockDescriptors.get(pluginId),
    })

    port = createMockPort()
    rpc.registerWorker('w1', port)
  })

  // ── TC-HK-01: 注册成功 ──────────────────────────────────────────

  it('TC-HK-01: register hook → returns { registered: true }', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.hooks.register',
      params: {
        pluginId: 'my-plugin',
        hookType: 'onBeforeSendMessage',
        handlerId: 'hook_my-plugin_1',
      },
    })

    const resp = extractLastResponse(port)
    expect(resp.id).toBe(1)
    expect('result' in resp).toBeTruthy()
    expect((resp as { result: unknown }).result).toEqual({ registered: true })

    // 验证 registry
    const entries = hookRegistry.get('onBeforeSendMessage')!
    expect(entries).toBeTruthy()
    expect(entries.length).toBe(1)
    expect(entries[0].handlerId).toBe('hook_my-plugin_1')
    // 没有 descriptor → 默认 priority 200
    expect(entries[0].priority).toBe(200)
  })

  // ── TC-HK-02: 多个 handler 按优先级排序 ─────────────────────────

  it('TC-HK-02: multiple handlers sorted by priority (lowest first)', async () => {
    // 注册三个 handler，模拟不同 trustLevel
    mockDescriptors.set('plugin-builtin', {
      pluginId: 'plugin-builtin',
      version: '1.0.0',
      displayName: 'Built-in',
      description: '',
      main: 'index.js',
      activationEvents: [],
      trustLevel: 'trusted',
      status: 'ACTIVE',
      contributes: {},
      permissions: [],
      engines: { 'taiji': '*' },
      pluginPath: '/tmp/builtin',
      source: 'built-in',
      extensionDependencies: [],
    })
    mockDescriptors.set('plugin-trusted', {
      pluginId: 'plugin-trusted',
      version: '1.0.0',
      displayName: 'Trusted',
      description: '',
      main: 'index.js',
      activationEvents: [],
      trustLevel: 'trusted',
      status: 'ACTIVE',
      contributes: {},
      permissions: [],
      engines: { 'taiji': '*' },
      pluginPath: '/tmp/trusted',
      source: 'external',
      extensionDependencies: [],
    })
    mockDescriptors.set('plugin-sandboxed', {
      pluginId: 'plugin-sandboxed',
      version: '1.0.0',
      displayName: 'Sandboxed',
      description: '',
      main: 'index.js',
      activationEvents: [],
      trustLevel: 'sandbox',
      status: 'ACTIVE',
      contributes: {},
      permissions: [],
      engines: { 'taiji': '*' },
      pluginPath: '/tmp/sandbox',
      source: 'external',
      extensionDependencies: [],
    })

    // 按乱序注册 → 验证优先级排序结果
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 1, method: 'plugin.hooks.register',
      params: { pluginId: 'plugin-sandboxed', hookType: 'onBeforeSendMessage', handlerId: 'h_sandbox' },
    })
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 2, method: 'plugin.hooks.register',
      params: { pluginId: 'plugin-builtin', hookType: 'onBeforeSendMessage', handlerId: 'h_builtin' },
    })
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 3, method: 'plugin.hooks.register',
      params: { pluginId: 'plugin-trusted', hookType: 'onBeforeSendMessage', handlerId: 'h_trusted' },
    })

    const entries = hookRegistry.get('onBeforeSendMessage')!
    expect(entries).toBeTruthy()
    expect(entries.length).toBe(3)

    // 期望顺序: built-in (priority=0) → trusted (priority=100) → sandbox (priority=200)
    expect(entries[0].handlerId).toBe('h_builtin')
    expect(entries[0].priority).toBe(0)

    expect(entries[1].handlerId).toBe('h_trusted')
    expect(entries[1].priority).toBe(100)

    expect(entries[2].handlerId).toBe('h_sandbox')
    expect(entries[2].priority).toBe(200)
  })
})
// ── Worker 侧：createHookApi ──────────────────────────────────────────

describe('Hook API — createHookApi (Worker side)', () => {
  let mockClient: MockRpcClient & PluginRpcClient
  let invokedParams: unknown[]

  beforeEach(() => {
    mockClient = createMockRpcClient()
    invokedParams = []
  })

  // ── TC-HK-03: onPiEvent 注册并触发 ────────────────────────────

  it('TC-HK-03: onPiEvent registers handler and triggers via executeHookRequest', async () => {
    const hookApi = createHookApi(mockClient, 'test-plugin')

    // 注册 onPiEvent handler
    const collected: Array<{ eventName: string; data: unknown }> = []
    const disposable = await hookApi.onPiEvent('session:create', async (eventName, data) => {
      collected.push({ eventName, data })
    })

    // 验证注册请求已发送
    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')!
    expect(registerCall).toBeTruthy()
    expect(registerCall.params.pluginId).toBe('test-plugin')
    // D2-4：注册 key 统一泛型 'onPiEvent'（事件名经 context 传给 handler，插件自滤）
    expect(registerCall.params.hookType).toBe('onPiEvent')
    expect(typeof registerCall.params.handlerId === 'string').toBeTruthy()

    const handlerId = registerCall.params.handlerId as string

    // 模拟主线程的 plugin.hooks.invoke request（D2-1 request 直连执行入口）
    const result = await executeHookRequest({
      handlerId,
      context: { eventName: 'session:create', data: { sessionId: 's1' } },
    })

    // handler 被调用
    expect(collected.length).toBe(1)
    expect(collected[0].eventName).toBe('session:create')
    expect(collected[0].data).toEqual({ sessionId: 's1' })

    // observer 类 hook 不产拦截结果（invoke 包装器返回 undefined，主线程按放行处理）
    expect(result).toBeUndefined()

    // 清理
    disposable.dispose()
  })

  // ── TC-HK-04: onBeforeSendMessage 注册并触发 ───────────────────

  it('TC-HK-04: onBeforeSendMessage registers and intercepts via executeHookRequest', async () => {
    const hookApi = createHookApi(mockClient, 'test-plugin')

    const interceptorResult = { blocked: true, proceed: false, modifiedContent: 'SECRET' } as const
    const disposable = await hookApi.onBeforeSendMessage(async (ctx) => {
      invokedParams.push(ctx)
      return interceptorResult
    })

    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')!
    expect(registerCall).toBeTruthy()
    expect(registerCall.params.hookType).toBe('onBeforeSendMessage')

    const handlerId = registerCall.params.handlerId as string

    const result = await executeHookRequest({
      handlerId,
      context: { pluginId: 'test-plugin', hookType: 'onBeforeSendMessage', data: { text: 'hello' }, timestamp: Date.now() },
    })

    expect(invokedParams.length).toBe(1)
    expect((invokedParams[0] as Record<string, unknown>).hookType).toBe('onBeforeSendMessage')

    // InterceptorResult 原样回传（字段映射在主线程 HookPipeline，D2-3）
    expect(result).toEqual(interceptorResult)

    disposable.dispose()
  })

  // ── TC-HK-05: dispose 清理本地 handler ─────────────────────────

  it('TC-HK-05: dispose removes handler, executeHookRequest proceeds after dispose', async () => {
    const hookApi = createHookApi(mockClient, 'test-plugin')

    const collected: number[] = []
    const disposable = await hookApi.onBeforeToolCall(async (ctx) => {
      collected.push(1)
      return { blocked: false, proceed: true }
    })

    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')!
    expect(registerCall).toBeTruthy()
    const handlerId = registerCall.params.handlerId as string

    // dispose
    disposable.dispose()

    // 再次执行 invoke → 不触发 handler（已清除），返回放行
    const result = await executeHookRequest({ handlerId, context: {} })
    expect(collected.length).toBe(0) // handler should not be called after dispose
    expect(result).toEqual({ proceed: true })

    // 验证 unregister 请求已发送
    const unregisterCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.unregister')!
    expect(unregisterCall).toBeTruthy()
    expect(unregisterCall.params.handlerId).toBe(handlerId)
  })
})
// ── Fix-2: onPiEvent context 形状适配（三类调用方 payload/eventName 解析） ──

describe('onPiEvent context shape adaptation (Fix-2)', () => {
  let mockClient: MockRpcClient & PluginRpcClient

  beforeEach(() => {
    mockClient = createMockRpcClient()
  })

  /** 注册 onPiEvent 并返回（handlerId 采集器 + 收集到的 (eventName, data)） */
  async function registerObserver(registeredAs: string): Promise<{
    handlerId: () => string
    collected: Array<{ eventName: string; data: unknown }>
  }> {
    const hookApi = createHookApi(mockClient, 'shape-plugin')
    const collected: Array<{ eventName: string; data: unknown }> = []
    await hookApi.onPiEvent(registeredAs, async (eventName, data) => {
      collected.push({ eventName, data })
    })
    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')!
    return { handlerId: () => registerCall.params.handlerId as string, collected }
  }

  it('interpreter flat shape {event, ...payload}: data excludes the event field itself', async () => {
    const { handlerId, collected } = await registerObserver('agent_start')
    await executeHookRequest({
      handlerId: handlerId(),
      // event-interpreter 平铺形状（event-interpreter.ts:310 等）
      context: { event: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', input: { cmd: 'ls' } },
    })
    expect(collected).toEqual([{
      eventName: 'tool_execution_start',
      // handler 的 data 只含业务负载，不混入 event 元字段（Fix-2 主断言）
      data: { toolCallId: 'tc-1', toolName: 'bash', input: { cmd: 'ls' } },
    }])
  })

  it('interpreter flat shape with top-level data field: eventName stays the received event, not the registered one', async () => {
    const { handlerId, collected } = await registerObserver('agent_start')
    await executeHookRequest({
      handlerId: handlerId(),
      // 平铺 payload 恰含顶层 data 字段且其内无 eventName——不得用注册时事件名覆盖
      // 实际收到的 event 字段（Fix-2 错报边界）
      context: { event: 'tool_execution_end', toolCallId: 'tc-2', data: { output: 'ok' } },
    })
    expect(collected).toEqual([{
      eventName: 'tool_execution_end',
      data: { toolCallId: 'tc-2', data: { output: 'ok' } },
    }])
  })

  // [pi1-disposition-chat-flow D7①] bridge 包装形状用例随通路退役删除（适配层该分支已删）。

  it('flat variant {eventName, data} at top level: takes top-level data', async () => {
    const { handlerId, collected } = await registerObserver('agent_start')
    await executeHookRequest({
      handlerId: handlerId(),
      context: { eventName: 'session_tree', data: { nodes: 3 } },
    })
    expect(collected).toEqual([{
      eventName: 'session_tree',
      data: { nodes: 3 },
    }])
  })
})
// ── D2-1 request 直连：executeHookRequest 形态 ──────────────────────

describe('executeHookRequest (D2-1 request direct path)', () => {
  let mockClient: MockRpcClient & PluginRpcClient

  beforeEach(() => {
    mockClient = createMockRpcClient()
  })

  /** 注册一个 onBeforeSendMessage 拦截器并返回其 handlerId */
  async function registerInterceptor(
    handler: (ctx: unknown) => Promise<{ proceed: boolean; reason?: string; modifiedData?: unknown }>,
  ): Promise<{ handlerId: string; dispose: () => void }> {
    const hookApi = createHookApi(mockClient, 'direct-plugin')
    const disposable = await hookApi.onBeforeSendMessage(handler)
    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')!
    return { handlerId: registerCall.params.handlerId as string, dispose: () => disposable.dispose() }
  }

  // ── block 形态 ─────────────────────────────────────────────────

  it('returns block form when handler returns proceed:false', async () => {
    const { handlerId, dispose } = await registerInterceptor(async () => ({
      proceed: false,
      reason: 'API key detected',
    }))

    const result = await executeHookRequest({ handlerId, context: { data: 'x' } })

    expect(result).toEqual({ proceed: false, reason: 'API key detected' })
    dispose()
  })

  // ── transform 形态 ─────────────────────────────────────────────

  it('returns transform form when handler returns modifiedData', async () => {
    const { handlerId, dispose } = await registerInterceptor(async () => ({
      proceed: true,
      modifiedData: { content: 'IMPORTANT' },
    }))

    const result = await executeHookRequest({ handlerId, context: { data: { content: '!important' } } })

    expect(result).toEqual({ proceed: true, modifiedData: { content: 'IMPORTANT' } })
    dispose()
  })

  // ── 放行形态 ───────────────────────────────────────────────────

  it('returns { proceed: true } for unknown handlerId', async () => {
    await registerInterceptor(async () => ({ proceed: true }))
    const result = await executeHookRequest({ handlerId: 'hook_nobody_999', context: {} })
    expect(result).toEqual({ proceed: true })
  })

  it('returns { proceed: true } for malformed params (no handlerId)', async () => {
    const result = await executeHookRequest({})
    expect(result).toEqual({ proceed: true })
  })
})
// ── P-5: 多执行器互不串扰（NOT_CLAIMED 链式认领） ──────────────────────

describe('multiple hook executors (P-5)', () => {
  it('two createHookApi instances claim their own handlerIds without cross-talk', async () => {
    const clientA = createMockRpcClient()
    const clientB = createMockRpcClient()
    const apiA = createHookApi(clientA, 'plugin-a')
    const apiB = createHookApi(clientB, 'plugin-b')

    const callsA: string[] = []
    const callsB: string[] = []
    await apiA.onBeforeSendMessage(async () => {
      callsA.push('a')
      return { proceed: true, modifiedData: 'FROM_A' }
    })
    await apiB.onBeforeSendMessage(async () => {
      callsB.push('b')
      return { proceed: false, reason: 'FROM_B' }
    })

    const handlerIdA = (clientA.requestCalls.find(c => c.method === 'plugin.hooks.register')!).params.handlerId as string
    const handlerIdB = (clientB.requestCalls.find(c => c.method === 'plugin.hooks.register')!).params.handlerId as string
    expect(handlerIdA).not.toBe(handlerIdB)

    // 分别 invoke：各自 executor 认领，另一 executor 返回 {claimed:false} 链式跳过
    const resultA = await executeHookRequest({ handlerId: handlerIdA, context: {} })
    const resultB = await executeHookRequest({ handlerId: handlerIdB, context: {} })

    expect(resultA).toEqual({ proceed: true, modifiedData: 'FROM_A' })
    expect(resultB).toEqual({ proceed: false, reason: 'FROM_B' })
    expect(callsA).toEqual(['a'])
    expect(callsB).toEqual(['b'])
  })

  it('disposePluginHooks removes one plugin entirely; the other executor keeps working (P-1/P-2)', async () => {
    const clientA = createMockRpcClient()
    const clientB = createMockRpcClient()
    const apiA = createHookApi(clientA, 'stays-alive')
    const apiB = createHookApi(clientB, 'gets-deactivated')

    const callsA: number[] = []
    const callsB: number[] = []
    await apiA.onBeforeToolCall(async () => {
      callsA.push(1)
      return { proceed: true }
    })
    await apiB.onBeforeToolCall(async () => {
      callsB.push(1)
      return { proceed: true }
    })
    const handlerIdA = (clientA.requestCalls.find(c => c.method === 'plugin.hooks.register')!).params.handlerId as string
    const handlerIdB = (clientB.requestCalls.find(c => c.method === 'plugin.hooks.register')!).params.handlerId as string

    // 'deactivate'：plugin-b 的全部本地 handler 被清 + 执行器从 Set 摘除
    disposePluginHooks('gets-deactivated')

    const resultB = await executeHookRequest({ handlerId: handlerIdB, context: {} })
    expect(resultB).toEqual({ proceed: true }) // 未认领 → 放行
    expect(callsB).toEqual([]) // handler 不再执行（P-1：禁用插件的 hook 不再执行）

    // 另一插件的执行器不受影响
    const resultA = await executeHookRequest({ handlerId: handlerIdA, context: {} })
    expect(resultA).toEqual({ proceed: true })
    expect(callsA).toEqual([1])
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-api-tools', () => {
describe('Tool API — registerToolRpcHandlers', () => {
  let rpc: PluginRpcServer
  let toolRegistry: Map<string, ToolEntry>
  let port: ReturnType<typeof createMockPort_m2>

  beforeEach(() => {
    rpc = new PluginRpcServer()
    toolRegistry = new Map()
    registerToolRpcHandlers(rpc, {
      toolRegistry,
    })

    port = createMockPort_m2()
    rpc.registerWorker('w1', port)
  })

  // ── 注册成功 ──────────────────────────────────────────────────

  it('register tool → returns toolKey and stores in registry', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.tools.register',
      params: {
        pluginId: 'my-plugin',
        name: 'my-tool',
        description: 'A test tool',
        parameters: { type: 'object', properties: { input: { type: 'string' } } },
      },
    })

    const resp = extractLastResponse_m2(port)
    expect(resp.id).toBe(1)
    expect('result' in resp).toBeTruthy()
    expect((resp as { result: unknown }).result).toBe('my-plugin:my-tool')

    // 验证注册表
    expect(toolRegistry.size).toBe(1)
    const entry = toolRegistry.get('my-plugin:my-tool')!
    expect(entry).toBeTruthy()
    expect(entry.pluginId).toBe('my-plugin')
    expect(entry.schema.name).toBe('my-tool')
    expect(entry.schema.description).toBe('A test tool')

  })

  // ── 重复注册 ──────────────────────────────────────────────────

  // 生产实装（tool-api.ts 重名注册分支）无专用错误码，用 INTERNAL_ERROR（-32603）
  // 兜底；dispatch 对数值 code 原样透传，响应 error.code 可精确断言
  it('register duplicate tool name → 拒绝且 code=INTERNAL_ERROR，message 含 already registered', async () => {
    // 先注册一次
    toolRegistry.set('my-plugin:my-tool', {
      pluginId: 'my-plugin',
      handlerId: 'my-plugin:my-tool',
      schema: { name: 'my-tool', description: '', parameters: {} },
    })

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: 'plugin.tools.register',
      params: {
        pluginId: 'my-plugin',
        name: 'my-tool',
        description: 'Duplicate',
        parameters: {},
      },
    })

    const resp = extractLastResponse_m2(port)
    expect(resp.id).toBe(2)
    expect('error' in resp).toBeTruthy()
    expect(resp.error!.code).toBe(PluginRpcErrorCodes.INTERNAL_ERROR)
    expect(resp.error!.message.includes('already registered')).toBeTruthy()
    // 注册表大小不变
    expect(toolRegistry.size).toBe(1)
  })

  // ── 注销已注册工具 ────────────────────────────────────────────

  it('unregister existing tool → deletes from registry', async () => {
    // 预先注册
    toolRegistry.set('my-plugin:my-tool', {
      pluginId: 'my-plugin',
      handlerId: 'my-plugin:my-tool',
      schema: { name: 'my-tool', description: '', parameters: {} },
    })

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'plugin.tools.unregister',
      params: { pluginId: 'my-plugin', toolKey: 'my-plugin:my-tool' },
    })

    const resp = extractLastResponse_m2(port)
    expect(resp.id).toBe(3)
    expect('result' in resp).toBeTruthy()
    // unregister 不返回特定值，但应成功（无 error）
    expect(toolRegistry.size).toBe(0)
  })

  // ── 注销不存在工具 ────────────────────────────────────────────

  it('unregister non-existent tool → succeeds silently', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 4,
      method: 'plugin.tools.unregister',
      params: { pluginId: 'nonexistent', toolKey: 'nonexistent:tool' },
    })

    const resp = extractLastResponse_m2(port)
    expect(resp.id).toBe(4)
    expect('result' in resp).toBeTruthy()
  })

  // ── D7 归属隔离（MF-1）─────────────────────────────────

  it('unregister requires pluginId in params (缺省 → INVALID_PLUGIN_ID，他人工具不被删)', async () => {
    // D7 归属校验：pluginId 必填（fail-closed）——Worker 代理 createToolApi 恒携带，
    // 缺省只可能是绕过 SDK 的裸 RPC 调用，拒绝且不删除任何注册。
    toolRegistry.set('other:tool', {
      pluginId: 'other',
      handlerId: 'other:tool',
      schema: { name: 'tool', description: '', parameters: {} },
    })

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 5,
      method: 'plugin.tools.unregister',
      params: { toolKey: 'other:tool' },
    })

    const resp = extractLastResponse_m2(port)
    expect('error' in resp).toBeTruthy()
    expect(String(resp.error!.code)).toBe('INVALID_PLUGIN_ID')
    expect(toolRegistry.size).toBe(1)
  })

  it('unregister 跨插件 toolKey（B 传 A:xxx）→ no-op，A 的注册不受影响', async () => {
    toolRegistry.set('A:xxx', {
      pluginId: 'A',
      handlerId: 'A:xxx',
      schema: { name: 'xxx', description: '', parameters: {} },
    })

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 6,
      method: 'plugin.tools.unregister',
      params: { pluginId: 'B', toolKey: 'A:xxx' },
    })

    const resp = extractLastResponse_m2(port)
    expect('result' in resp).toBeTruthy()
    expect(toolRegistry.has('A:xxx')).toBe(true)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-bootstrap-tool-execute', () => {
beforeEach(() => {
  postedMessages.length = 0
  setPostMessage((msg: unknown) => {
    const m = msg as { type: string; response?: RpcResponse }
    if (m.type === 'rpc' && m.response) postedMessages.push({ type: 'rpc', response: m.response })
  })
})
afterEach(() => {
  for (const key of registeredToolKeys.splice(0)) {
    unregisterToolHandler(key)
  }
})
describe('plugin-bootstrap tool execute RPC handler', () => {
  it('executes registered handler and returns result', async () => {
    const handler: ToolExecuteHandler = vi.fn().mockResolvedValue({ content: 'ok' })
    registerToolHandlerTracked('p:t', handler)

    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 42,
      method: 'plugin.tool.execute',
      params: { pluginId: 'p', toolName: 't', arguments: { x: 1 } },
    })

    expect(handler).toHaveBeenCalledWith({
      arguments: { x: 1 },
      sessionId: undefined,
      toolCallId: undefined,
    })
    expect(postedMessages).toEqual([
      { type: 'rpc', response: { jsonrpc: '2.0', id: 42, result: { content: 'ok' } } },
    ])
  })

  it('returns error when handler not found', async () => {
    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 43,
      method: 'plugin.tool.execute',
      params: { pluginId: 'x', toolName: 'missing', arguments: {} },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 43,
          error: {
            code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
            message: 'Tool handler not found: x:missing',
          },
        },
      },
    ])
  })

  it('returns error when handler throws', async () => {
    const handler: ToolExecuteHandler = vi.fn().mockRejectedValue(new Error('boom'))
    registerToolHandlerTracked('e:f', handler)

    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 44,
      method: 'plugin.tool.execute',
      params: { pluginId: 'e', toolName: 'f', arguments: {} },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 44,
          error: {
            code: PluginRpcErrorCodes.INTERNAL_ERROR,
            message: 'Tool execution error: boom',
          },
        },
      },
    ])
  })

  it('returns error for unknown method', async () => {
    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 45,
      method: 'unknown.method',
      params: {},
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 45,
          error: {
            code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
            message: 'Unknown method: unknown.method',
          },
        },
      },
    ])
  })
})
describe('plugin-bootstrap plugin.hooks.invoke request branch (D2-1)', () => {
  it('responds with InterceptorResult when handler blocks', async () => {
    const handlerId = await registerTestInterceptor(async () => ({
      proceed: false,
      reason: 'API key detected',
    }))

    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 51,
      method: 'plugin.hooks.invoke',
      params: { handlerId, hookType: 'onBeforeSendMessage', context: { data: 'x' } },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 51,
          result: { proceed: false, reason: 'API key detected' },
        },
      },
    ])
  })

  it('responds with modifiedData when handler transforms', async () => {
    const handlerId = await registerTestInterceptor(async () => ({
      proceed: true,
      modifiedData: { content: 'IMPORTANT' },
    }))

    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 52,
      method: 'plugin.hooks.invoke',
      params: { handlerId, hookType: 'onBeforeSendMessage', context: { data: { content: '!important' } } },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 52,
          result: { proceed: true, modifiedData: { content: 'IMPORTANT' } },
        },
      },
    ])
  })

  it('responds with {proceed:true} when handler throws (异常放行)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const handlerId = await registerTestInterceptor(async () => {
        throw new Error('handler boom')
      })

      await dispatchRpcRequest({
        jsonrpc: '2.0',
        id: 53,
        method: 'plugin.hooks.invoke',
        params: { handlerId, hookType: 'onBeforeSendMessage', context: {} },
      })

      expect(postedMessages).toEqual([
        {
          type: 'rpc',
          response: {
            jsonrpc: '2.0',
            id: 53,
            result: { proceed: true },
          },
        },
      ])
      // 异常放行分支记 Worker 侧日志（对齐源码行为，P-3 消除漂移）
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('responds with {proceed:true} for unknown handlerId', async () => {
    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 54,
      method: 'plugin.hooks.invoke',
      params: { handlerId: 'hook_missing_0', hookType: 'onBeforeSendMessage', context: {} },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 54,
          result: { proceed: true },
        },
      },
    ])
  })

  it('D2-2 observe notification: plugin.hooks.invoke notification executes handler without response', async () => {
    // observe 快捷路径：无 id 通知 → handler 执行 → 不产生任何响应消息（fire-and-forget）
    const collected: Array<{ eventName: string; data: unknown }> = []
    const mockClient = createMockRpcClient_m2()
    const hookApi = createHookApi(mockClient, 'observe-plugin')
    await hookApi.onPiEvent('agent_start', async (eventName, data) => {
      collected.push({ eventName, data })
    })
    const registerCall = (mockClient as unknown as { requestCalls: Array<{ method: string; params: Record<string, unknown> }> })
      .requestCalls.find(c => c.method === 'plugin.hooks.register')!
    const handlerId = registerCall.params.handlerId as string

    await handleMessage({
      type: 'rpc',
      notification: {
        jsonrpc: '2.0',
        method: 'plugin.hooks.invoke',
        params: { handlerId, hookType: 'onPiEvent', context: { eventName: 'agent_start', data: { sessionId: 's1' } } },
      },
    } as HostToWorkerMessage)
    // executeHookRequest 在 notification 分支是 fire-and-forget 调用，flush 微任务
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(collected).toEqual([{ eventName: 'agent_start', data: { sessionId: 's1' } }])
    // 关键断言：通知不产生响应（postedMessages 为空——没有 postRpcResponse 调用）
    expect(postedMessages).toEqual([])
  })
})
// ── Fix-7: 'deactivate' 分支清理本地 tool handler（与主线程清 toolRegistry 对偶） ──

describe('plugin-bootstrap deactivate clears local tool handlers (Fix-7)', () => {
  it("deactivate removes the plugin's tool handlers; other plugins' handlers survive", async () => {
    const handlerP1: ToolExecuteHandler = vi.fn().mockResolvedValue({ content: 'p1' })
    const handlerP2: ToolExecuteHandler = vi.fn().mockResolvedValue({ content: 'p2' })
    registerToolHandlerTracked('p1:toolA', handlerP1)
    registerToolHandlerTracked('p2:toolB', handlerP2)

    // 'deactivate' 分支（无 loadedModule 时 mod?.deactivate 跳过，仍执行清理 + 回 deactivated）
    await handleMessage({ type: 'deactivate', pluginId: 'p1' } as HostToWorkerMessage)
    await new Promise(resolve => setImmediate(resolve))

    // p1 的 handler 摘除：tool.execute 落 METHOD_NOT_FOUND（迟到的工具调用不可达）
    postedMessages.length = 0
    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 51,
      method: 'plugin.tool.execute',
      params: { pluginId: 'p1', toolName: 'toolA', arguments: {} },
    })
    expect(postedMessages).toEqual([{
      type: 'rpc',
      response: {
        jsonrpc: '2.0',
        id: 51,
        error: {
          code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
          message: 'Tool handler not found: p1:toolA',
        },
      },
    }])
    expect(handlerP1).not.toHaveBeenCalled()

    // 其他插件的 handler 不受影响
    postedMessages.length = 0
    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 52,
      method: 'plugin.tool.execute',
      params: { pluginId: 'p2', toolName: 'toolB', arguments: {} },
    })
    expect(postedMessages).toEqual([{
      type: 'rpc',
      response: { jsonrpc: '2.0', id: 52, result: { content: 'p2' } },
    }])
  })
})
describe('plugin-bootstrap activate lifecycle branch (U09 重构前覆盖缺口补测)', () => {
  it("activate for a module that was never loaded → posts {type:'error', error:'Module not loaded'}", async () => {
    const errorPosts: Array<{ type: string; pluginId?: string; error?: string }> = []
    // 覆盖 beforeEach 注入的 rpc 收集器：本用例只关心 error 消息；
    // 下个用例的 beforeEach 会重新注入 rpc 收集器，无跨用例污染
    setPostMessage((msg: unknown) => {
      const m = msg as { type: string; pluginId?: string; error?: string }
      if (m.type === 'error') errorPosts.push(m)
    })

    await handleMessage({
      type: 'activate',
      pluginId: 'never-loaded-plugin',
      pluginDir: '/tmp/never-loaded-plugin',
      event: { type: 'onStartupFinished' },
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(errorPosts).toEqual([
      { type: 'error', pluginId: 'never-loaded-plugin', error: 'Module not loaded' },
    ])
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-provider-access-plugin-side', () => {
describe('providers.write 往返（D4 插件侧 → 宿主写策略链）', () => {
  it('命名空间内写入：SDK 出口载荷到达 setProvider，回执 {written,providerId} 回到插件侧', async () => {
    const deps = manifestDeps()
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const receipt = await api.providers.write({
      providerId: NS_PROVIDER_ID,
      apiKey: 'sk-test',
      displayName: 'Wool WorkBuddy',
      headers: { 'x-a': '1' },
      models: ['m1', { id: 'm2', name: 'Model Two' }],
    })
    await loop.settle()

    expect(receipt).toEqual({ written: true, providerId: NS_PROVIDER_ID })
    expect(deps.setProvider).toHaveBeenCalledTimes(1)
    // handleProviderWrite 对 models 对象条目只挡越形、不裁字段（结构细节交写策略链
    // 既有防线，provider-write-proxy.ts「本层只挡明显越形」）——断言与实装同形
    expect(deps.setProvider).toHaveBeenCalledWith(NS_PROVIDER_ID, {
      name: 'Wool WorkBuddy',
      apiKey: 'sk-test',
      headers: { 'x-a': '1' },
      models: ['m1', { id: 'm2', name: 'Model Two' }],
    })
  })

  it('越权 providerId：宿主 NAMESPACE_MISMATCH 拒绝经 RPC 错误回执回到插件侧可见', async () => {
    const deps = manifestDeps()
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    await expect(api.providers.write({ providerId: 'other-provider', apiKey: 'sk-x' })).rejects.toThrow(
      /NAMESPACE_MISMATCH/,
    )
    await loop.settle()
    expect(deps.setProvider).not.toHaveBeenCalled()
  })
})
describe('providers.credential 往返（D4 受控明文回读）', () => {
  it('已声明 network.http：唯一读通道回执直透插件侧（定向 reply）', async () => {
    const deps = manifestDeps()
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const reply = await api.providers.credential(NS_PROVIDER_ID)
    await loop.settle()

    expect(reply).toEqual({ providerId: NS_PROVIDER_ID, key: 'sk-test', source: 'models.json', kind: 'api_key' })
    expect(deps.resolveProviderCredential).toHaveBeenCalledWith(NS_PROVIDER_ID)
  })

  it('对象形态调用（wool 系插件自持契约 { providerId }）：代理归一为 wire 字符串形，回读命中同一明文（⑦）', async () => {
    const deps = manifestDeps()
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    // 修复前：对象直传使 wire 载荷 providerId 变成对象 → 宿主 INVALID_PAYLOAD →
    // 插件 catch 呈「未接入」且零留痕（真机 d3-r10 实测）。归一后两种形态同达。
    const reply = await api.providers.credential({ providerId: NS_PROVIDER_ID })
    await loop.settle()

    expect(reply).toEqual({ providerId: NS_PROVIDER_ID, key: 'sk-test', source: 'models.json', kind: 'api_key' })
    expect(deps.resolveProviderCredential).toHaveBeenCalledWith(NS_PROVIDER_ID)
  })

  it('未声明 network.http：宿主 PERMISSION_DENIED 拒绝回到插件侧（读通道不触达）+ 分级 warn 落 capability 环节', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = manifestDeps({ readPluginManifest: () => ({ pkgName: PLUGIN_ID, capabilities: [] }) })
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    await expect(api.providers.credential(NS_PROVIDER_ID)).rejects.toThrow(/PERMISSION_DENIED/)
    await loop.settle()
    expect(deps.resolveProviderCredential).not.toHaveBeenCalled()
    // ⑦ 分级诊断：warn 指名落空环节（capability），可从日志直接归因
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("link 'capability'"))
    warnSpy.mockRestore()
  })

  it('凭据源空：PROVIDER_CREDENTIAL_MISSING + 分级 warn 落 credential-source 环节（哪环落的空可归因）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = manifestDeps({ resolveProviderCredential: vi.fn(async () => undefined) })
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    await expect(api.providers.credential(NS_PROVIDER_ID)).rejects.toThrow(/PROVIDER_CREDENTIAL_MISSING/)
    await loop.settle()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("link 'credential-source'"))
    warnSpy.mockRestore()
  })
})
describe('providers.delete 往返（D4 卸载清理通道）', () => {
  it('命名空间内删除：deleteProvider 触达，回执 {deleted,providerId} 回到插件侧', async () => {
    const deps = manifestDeps()
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const receipt = await api.providers.delete(NS_PROVIDER_ID)
    await loop.settle()

    expect(receipt).toEqual({ deleted: true, providerId: NS_PROVIDER_ID })
    expect(deps.deleteProvider).toHaveBeenCalledWith(NS_PROVIDER_ID)
  })
})
describe('ui.openUrl 往返（D9 授权页打开）', () => {
  it('https URL：scheme 白名单放行，宿主唤起出口收到 URL，回执 {opened:true}', async () => {
    const openExternal = vi.fn()
    const server = new PluginRpcServer()
    registerOpenUrlRpcHandler(server, { openExternal })
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const receipt = await api.ui.openUrl('https://auth.example.com/oauth')
    await loop.settle()

    expect(receipt).toEqual({ opened: true })
    expect(openExternal).toHaveBeenCalledWith('https://auth.example.com/oauth')
  })

  it('file:// URL：入口拒绝（INVALID_URL_SCHEME 回到插件侧），唤起出口不触达', async () => {
    const openExternal = vi.fn()
    const server = new PluginRpcServer()
    registerOpenUrlRpcHandler(server, { openExternal })
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    await expect(api.ui.openUrl('file:///etc/passwd')).rejects.toThrow(/INVALID_URL_SCHEME/)
    await loop.settle()
    expect(openExternal).not.toHaveBeenCalled()
  })
})
describe('events.report 往返（D9 插件 → renderer 业务事件上报）', () => {
  it('上报经宿主 plugin.event handler 校验后广播，pluginId 取通道身份，回执 {forwarded:true}', async () => {
    const broadcasts: PluginEventPayload[] = []
    const server = new PluginRpcServer()
    registerPluginEventRpcHandler(server, {
      broadcast: (payload) => broadcasts.push(payload),
    })
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const receipt = await api.events.report('credential-status', { loggedIn: false, reason: 'upstream-401' })
    await loop.settle()

    expect(receipt).toEqual({ forwarded: true })
    expect(broadcasts).toEqual([
      {
        pluginId: PLUGIN_ID, // 通道身份（registerWorker 注册），非载荷自报
        channel: 'credential-status',
        payload: { loggedIn: false, reason: 'upstream-401' },
      },
    ])
  })

  it('payload 超 PLUGIN_EVENT_PAYLOAD_MAX_BYTES 在入口拒绝（C-comm-14 全局广播通路入口防线，D5 F1-23）', async () => {
    const broadcasts: PluginEventPayload[] = []
    const server = new PluginRpcServer()
    registerPluginEventRpcHandler(server, {
      broadcast: (payload) => broadcasts.push(payload),
    })
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const huge = 'x'.repeat(129 * 1024) // 129KB > 128KB 上限
    await expect(api.events.report('huge-payload', { blob: huge })).rejects.toMatchObject({
      code: 'PLUGIN_EVENT_PAYLOAD_TOO_LARGE',
    })
    await loop.settle()
    expect(broadcasts).toEqual([]) // 超限不进广播
  })
})
describe('events.emit 往返（D5 推补充通道，⑥ 接线）', () => {
  it('emit 与 report 同走 plugin.event：广播帧出线 + pluginId 取通道身份，回执 resolve undefined', async () => {
    const broadcasts: PluginEventPayload[] = []
    const server = new PluginRpcServer()
    registerPluginEventRpcHandler(server, {
      broadcast: (payload) => broadcasts.push(payload),
    })
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    // wool 系插件的调用形态：await api.events.emit(channel, payload)（plugin-kit emitStatusEvent）
    await api.events.emit('provider.credentialStatus', { providerId: NS_PROVIDER_ID, loggedIn: true })
    await loop.settle()

    expect(broadcasts).toEqual([
      {
        pluginId: PLUGIN_ID, // 通道身份（registerWorker 注册），非载荷自报
        channel: 'provider.credentialStatus',
        payload: { providerId: NS_PROVIDER_ID, loggedIn: true },
      },
    ])
  })

  it('payload 超限：错误以 rejection 回到插件侧可见（awaitable，不静默吞），广播零出线', async () => {
    const broadcasts: PluginEventPayload[] = []
    const server = new PluginRpcServer()
    registerPluginEventRpcHandler(server, {
      broadcast: (payload) => broadcasts.push(payload),
    })
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const huge = 'x'.repeat(129 * 1024)
    await expect(api.events.emit('huge-payload', { blob: huge })).rejects.toMatchObject({
      code: 'PLUGIN_EVENT_PAYLOAD_TOO_LARGE',
    })
    await loop.settle()
    expect(broadcasts).toEqual([])
  })
})
describe('views.onUiEvent 接收注册（D8 输入值回传）', () => {
  it('宿主 PLUGIN_UI_EVENT_NOTIFY 通知到达 Worker 后分发到插件 handler（载荷四字段透传）', async () => {
    const server = new PluginRpcServer()
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)
    const received: Array<{ viewId: string; componentId: string; event: string; value: unknown }> = []
    const disposable = api.views.onUiEvent((event) => received.push(event))

    server.notify('w1', PLUGIN_UI_EVENT_NOTIFY, {
      viewId: 'authorize-view',
      componentId: 'pat-input',
      event: 'change',
      value: 'token-123',
    })
    await loop.settle()

    expect(received).toEqual([
      { viewId: 'authorize-view', componentId: 'pat-input', event: 'change', value: 'token-123' },
    ])
    disposable.dispose()
  })

  it('handler dispose 后不再投递；deactivate 对偶清理（disposePluginUiEventHandlers）同效', async () => {
    const server = new PluginRpcServer()
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)
    const received: unknown[] = []
    const disposable = api.views.onUiEvent((event) => received.push(event))

    disposable.dispose()
    server.notify('w1', PLUGIN_UI_EVENT_NOTIFY, { viewId: 'v', componentId: 'c', event: 'change', value: 1 })
    await loop.settle()
    expect(received).toHaveLength(0)

    // deactivate 清理路径：重新注册后经模块级清理函数摘除（handleDeactivate 分支同款）
    api.views.onUiEvent((event) => received.push(event))
    disposePluginUiEventHandlers(PLUGIN_ID)
    server.notify('w1', PLUGIN_UI_EVENT_NOTIFY, { viewId: 'v', componentId: 'c', event: 'change', value: 2 })
    await loop.settle()
    expect(received).toHaveLength(0)
  })
})
});
});

// ======================================================================
// ← message-bus-bundle.test.ts
// ======================================================================

/** 构造一个 mock ws：readyState=OPEN，send 为 vi.fn（可配置抛错 / bufferedAmount）。 */
function makeMockWs(opts: { throws?: boolean; bufferedAmount?: number } = {}): WebSocket {
  const sendFn = opts.throws
    ? vi.fn(() => { throw new Error('connection closed (TOCTOU)') })
    : vi.fn()
  return {
    readyState: WebSocket.OPEN,
    send: sendFn,
    ...(opts.bufferedAmount !== undefined ? { bufferedAmount: opts.bufferedAmount } : {}),
  } as unknown as WebSocket
}


// ── Mock BrokerServices（broadcast 不读 services，但构造需要满足类型） ──

const mockServices = {
  sessionService: { listPersistedSessions: () => [] },
  configService: {
    listProviders: () => [],
    getDefaultModel: () => null,
    loadSkills: () => [],
    loadAgents: () => [],
    getSkillDirs: () => [],
    getAgentDirs: () => [],
  },
  modelService: { aggregateModels: () => [] },
  pluginService: undefined,
  extensionService: undefined,
  projectRoot: '/mock',
  appInfo: { appVersion: '0.0.0', piVersion: '0.0.0' },
} as unknown as BrokerServices


// ======================================================================
// ← test/message-bus-resolve-path.test.ts
// ======================================================================

const SMALL_OPTS = { warnBytes: 1024, truncateBytes: 4096 }


function makeClient(): BusClient & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as unknown as BusClient & { send: ReturnType<typeof vi.fn> }
}


function sentMessages(client: ReturnType<typeof makeClient>): ServerMessage[] {
  return client.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as ServerMessage)
}


// ======================================================================
// ← test/agent-scanner.test.ts
// ======================================================================

let root: string


function writeAgent(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), content, 'utf-8')
}


// ======================================================================
// ← test/discovery-store.test.ts
// ======================================================================

const mkdtempP = promisify(mkdtemp)


const rmP = promisify(rm)


/** v2 空配置（六字段全空）。迁移空 v1 的产物（非 ENOENT 默认态——后者是 preset 全勾）。 */
const EMPTY_V2 = {
  version: 2,
  skill: { projectPaths: [], globalPaths: [] },
  agent: { projectPaths: [], globalPaths: [] },
  extension: { projectPaths: [], globalPaths: [] },
}


/** ENOENT / 损坏回落默认态：全部 preset 目录默认勾选（pi + taiji，无 claude）。 */
const DEFAULTS_V2 = {
  version: 2,
  skill: { ...DEFAULT_DISCOVERY_CONFIG.skill },
  agent: { ...DEFAULT_DISCOVERY_CONFIG.agent },
  extension: { ...DEFAULT_DISCOVERY_CONFIG.extension },
}


/** 包装为 project scope 的 SkillDirConfig。 */
const proj = (path: string): SkillDirConfig => ({ path, enabled: true, scope: 'project' })


/** 包装为 global scope 的 SkillDirConfig。 */
const glob = (path: string): SkillDirConfig => ({ path, enabled: true, scope: 'global' })


let tmpDir: string


let discoveryPath: string

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('message-bus-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('message-broker', () => {
// ── Tests ──────────────────────────────────────────────────────────

describe('ServerMessageBroker W3 M6 (broadcast try-catch)', () => {
  it('U9: single ws.send throw does not interrupt broadcast to other clients', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const ws1 = makeMockWs({ throws: true })
    const ws2 = makeMockWs()
    const ws3 = makeMockWs()
    const pool: ClientPool = { clients: new Set([ws1, ws2, ws3]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    const msg = { type: 'session.list', id: 'push_1', payload: { groups: [] } } as unknown as Parameters<BrokerType['broadcast']>[0]

    // broadcast 不应抛错（即使 ws1.send 抛）
    expect(() => broker.broadcast(msg)).not.toThrow()

    // ws2/ws3 的 send 应被调用（未被 ws1 抛错中断）
    expect(vi.mocked(ws2.send)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ws3.send)).toHaveBeenCalledTimes(1)

    // ws1 也尝试调用了（只是抛错被吞）
    expect(vi.mocked(ws1.send)).toHaveBeenCalledTimes(1)

    // 验证传给 ws2 的 payload 是序列化后的 msg
    const sent2 = vi.mocked(ws2.send).mock.calls[0][0]
    expect(JSON.parse(sent2 as string)).toEqual(msg)
  })

  it('U9b: broadcast with all clients throwing completes without throwing', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const ws1 = makeMockWs({ throws: true })
    const ws2 = makeMockWs({ throws: true })
    const pool: ClientPool = { clients: new Set([ws1, ws2]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    const msg = { type: 'session.list', id: 'push_1', payload: { groups: [] } } as unknown as Parameters<BrokerType['broadcast']>[0]

    // 所有 client 都抛错，broadcast 自身不抛
    expect(() => broker.broadcast(msg)).not.toThrow()
  })
})
/**
 * L6（perf-quick-batch）：broadcast 单次 stringify。
 *
 * 现状缺陷：broadcast 循环内对每个 client 调 this.send → send 内 JSON.stringify(msg)，
 * N 个客户端 = N 次重复序列化同一对象。高并发广播 + 大 payload（如 session.list）
 * 下主线程被重复 stringify 阻塞。
 *
 * 修复目标：循环外 stringify 一次得 payload 字符串，循环内 ws.send(payload) 直接发送。
 * - stringify 调用次数恒为 1（与 N 无关）
 * - 单 client send 抛错仍不影响其余（复用 U9 的 try-catch 语义）
 * - 各客户端收到逐字节一致 payload
 *
 * [红灯] 当前实现循环内逐 client stringify，N=3 时 stringify 被调 3 次 ≠ 1 → fail。
 */
describe('ServerMessageBroker L6 (broadcast 单次 stringify)', () => {
  it('L6-1: N 客户端 broadcast 时 JSON.stringify 恒调用 1 次（与 N 无关）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const stringifySpy = vi.spyOn(JSON, 'stringify')

    const ws1 = makeMockWs()
    const ws2 = makeMockWs()
    const ws3 = makeMockWs()
    const pool: ClientPool = { clients: new Set([ws1, ws2, ws3]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    const msg = { type: 'session.list', id: 'push_l6', payload: { groups: [] } } as unknown as Parameters<BrokerType['broadcast']>[0]

    broker.broadcast(msg)

    // 核心断言：3 个客户端，stringify 只调 1 次（循环外提取）。当前实现调 3 次 → 红灯。
    expect(stringifySpy).toHaveBeenCalledTimes(1)

    stringifySpy.mockRestore()
  })

  it('L6-2: 单 client stringify 仍只 1 次（N=1 边界）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const stringifySpy = vi.spyOn(JSON, 'stringify')

    const ws1 = makeMockWs()
    const pool: ClientPool = { clients: new Set([ws1]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    const msg = { type: 'app.info', id: 'push_l6b', payload: { appVersion: '1.0.0', piVersion: '0.80.3' } } as unknown as Parameters<BrokerType['broadcast']>[0]

    broker.broadcast(msg)

    expect(stringifySpy).toHaveBeenCalledTimes(1)
    stringifySpy.mockRestore()
  })

  it('L6-3: 各客户端收到逐字节一致 payload（含中文/emoji）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')

    const ws1 = makeMockWs()
    const ws2 = makeMockWs()
    const pool: ClientPool = { clients: new Set([ws1, ws2]) }

    const broker = new ServerMessageBroker(pool, mockServices)
    // 含 Unicode 字符，验证序列化结果一致性（不是每客户端独立序列化导致潜在差异）
    const msg = { type: 'error', id: 'push_l6c', payload: { code: 'ERR_测试', message: '失败 emoji 🚀' } } as unknown as Parameters<BrokerType['broadcast']>[0]

    broker.broadcast(msg)

    const sent1 = vi.mocked(ws1.send).mock.calls[0][0]
    const sent2 = vi.mocked(ws2.send).mock.calls[0][0]
    // 两客户端收到完全相同的字符串
    expect(sent1).toBe(sent2)
    // 且可反序列化回原 msg
    expect(JSON.parse(sent1 as string)).toEqual(msg)
  })
})
describe('ServerMessageBroker broadcast 哨兵豁免清单（AP-2）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 构造单 client broker + console.warn spy */
  async function buildWithWarnSpy() {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeMockWs()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices)
    return { broker, ws, warnSpy }
  }

  it.each([
    'plugin:headerActionUpdate',
  ] as const)('豁免帧 %s：payload 带 sessionId 的全局广播不触发哨兵告警，帧照常下发', async (type) => {
    const { broker, ws, warnSpy } = await buildWithWarnSpy()
    const msg = {
      type,
      id: 'push_exempt',
      payload: { pluginId: 'p1', sessionId: 's1', state: 'open', epoch: 1 },
    } as unknown as Parameters<BrokerType['broadcast']>[0]

    expect(() => broker.broadcast(msg)).not.toThrow()

    expect(warnSpy).not.toHaveBeenCalled()
    expect(vi.mocked(ws.send)).toHaveBeenCalledTimes(1)
  })

  it('清单外帧 payload 带 sessionId 仍触发哨兵告警（豁免不漏放宽）', async () => {
    const { broker, warnSpy } = await buildWithWarnSpy()
    const msg = {
      type: 'session.list',
      id: 'push_guard',
      payload: { groups: [], sessionId: 's1' },
    } as unknown as Parameters<BrokerType['broadcast']>[0]

    broker.broadcast(msg)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('use IMessageBus.publish instead')
  })

  it('豁免帧 payload 无 sessionId（异常构造）不触发告警（哨兵本就只看 sessionId 存在性）', async () => {
    const { broker, warnSpy } = await buildWithWarnSpy()
    const msg = {
      type: 'plugin:headerActionUpdate',
      id: 'push_nosid',
      payload: { pluginId: 'p1', sessionId: 's1' },
    } as unknown as Parameters<BrokerType['broadcast']>[0]

    broker.broadcast(msg)

    expect(warnSpy).not.toHaveBeenCalled()
  })
})
/**
 * RT-1#8：send() 的 stringify 检查（照 reply :168-174 形态）。
 *
 * send 是 sendError 的最后手段路径（sendError → this.send(error envelope)）——
 * 序列化失败若直抛，异常沿调用方冒泡且 error envelope 无从发出。检查收敛为
 * error envelope：新 envelope 是受控构造的纯字符串 payload，序列化不再失败（结构上不递归）。
 */
describe('ServerMessageBroker RT-1#8 (send stringify 检查)', () => {
  it('循环引用 payload → send 不抛，改发 error envelope（code=send_serialization_failed）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ws = makeMockWs()
      const pool: ClientPool = { clients: new Set([ws]) }
      const broker = new ServerMessageBroker(pool, mockServices)

      const cyclic: Record<string, unknown> = { type: 'app.info', id: 'x' }
      cyclic.payload = { self: cyclic }
      const msg = cyclic as unknown as Parameters<BrokerType['send']>[1]

      // 修复前：JSON.stringify 抛 TypeError 直接冒泡给调用方（含 sendError 路径）
      expect(() => broker.send(ws, msg)).not.toThrow()

      // 原 msg 未发出；发出的唯一一帧是 error envelope
      expect(vi.mocked(ws.send)).toHaveBeenCalledTimes(1)
      const sent = JSON.parse(vi.mocked(ws.send).mock.calls[0][0] as string) as {
        type: string
        payload: { code: string; message: string }
      }
      expect(sent.type).toBe('error')
      expect(sent.payload.code).toBe('send_serialization_failed')
      // 检查留痕
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('send serialization failed'), expect.any(TypeError))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('正常 payload → send 原样序列化发送（检查零行为变化）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const ws = makeMockWs()
    const pool: ClientPool = { clients: new Set([ws]) }
    const broker = new ServerMessageBroker(pool, mockServices)

    const msg = { type: 'app.info', id: 'p1', payload: { appVersion: '1', piVersion: '2' } } as unknown as Parameters<BrokerType['send']>[1]
    broker.send(ws, msg)

    expect(vi.mocked(ws.send)).toHaveBeenCalledTimes(1)
    expect(JSON.parse(vi.mocked(ws.send).mock.calls[0][0] as string)).toEqual(msg)
  })
})
/**
 * RT-1#7：发送侧背压观测（bufferedAmount 超阈值 warn，每 socket 每次越限一条）。
 * 量级依据与去重语义见 src/utils/backpressure-warn.ts 模块注释。
 */
describe('ServerMessageBroker RT-1#7 (bufferedAmount 背压 warn)', () => {
  it('send 路径：bufferedAmount 超阈值 → warn 一条（含字节数）；持续超阈值不重复', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ws = makeMockWs({ bufferedAmount: 2 * 1024 * 1024 })
      const pool: ClientPool = { clients: new Set([ws]) }
      const broker = new ServerMessageBroker(pool, mockServices)
      const msg = { type: 'app.info', id: 'p1', payload: { appVersion: '1', piVersion: '2' } } as unknown as Parameters<BrokerType['send']>[1]

      broker.send(ws, msg)
      broker.send(ws, msg)
      broker.send(ws, msg)

      // 同一 socket 持续超阈值态：只 warn 一次
      const backpressureWarns = warnSpy.mock.calls.filter(([m]) => String(m).includes('[backpressure]'))
      expect(backpressureWarns).toHaveLength(1)
      expect(String(backpressureWarns[0][0])).toContain('channel=send')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('send 路径：水位降回阈值内后再次越限 → 再 warn（状态翻转去重）', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 可变 bufferedAmount 的 ws mock（模拟对端消费后水位回落）
      const ws = { readyState: WebSocket.OPEN, send: vi.fn(), bufferedAmount: 2 * 1024 * 1024 } as unknown as WebSocket
      const pool: ClientPool = { clients: new Set([ws]) }
      const broker = new ServerMessageBroker(pool, mockServices)
      const msg = { type: 'app.info', id: 'p1', payload: { appVersion: '1', piVersion: '2' } } as unknown as Parameters<BrokerType['send']>[1]

      broker.send(ws, msg) // 越限 → warn #1
      ;(ws as { bufferedAmount: number }).bufferedAmount = 0
      broker.send(ws, msg) // 回落 → 无 warn，状态复位
      ;(ws as { bufferedAmount: number }).bufferedAmount = 2 * 1024 * 1024
      broker.send(ws, msg) // 再次越限 → warn #2

      const backpressureWarns = warnSpy.mock.calls.filter(([m]) => String(m).includes('[backpressure]'))
      expect(backpressureWarns).toHaveLength(2)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('broadcast 路径：单个积压 client warn，不影响其余 client 收帧', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ws1 = makeMockWs({ bufferedAmount: 3 * 1024 * 1024 })
      const ws2 = makeMockWs()
      const pool: ClientPool = { clients: new Set([ws1, ws2]) }
      const broker = new ServerMessageBroker(pool, mockServices)
      const msg = { type: 'app.info', id: 'push_bp', payload: { appVersion: '1', piVersion: '2' } } as unknown as Parameters<BrokerType['broadcast']>[0]

      broker.broadcast(msg)

      // 积压 client 触发 warn，正常 client 照常收帧
      expect(warnSpy.mock.calls.some(([m]) => String(m).includes('[backpressure]') && String(m).includes('channel=broadcast'))).toBe(true)
      expect(vi.mocked(ws2.send)).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('bufferedAmount 缺省（mock/非 WS 契约）→ no-op，不 warn 不抛', async () => {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // makeMockWs 不传 bufferedAmount 时属性缺省
      const ws = makeMockWs()
      const pool: ClientPool = { clients: new Set([ws]) }
      const broker = new ServerMessageBroker(pool, mockServices)
      const msg = { type: 'app.info', id: 'p1', payload: { appVersion: '1', piVersion: '2' } } as unknown as Parameters<BrokerType['send']>[1]

      expect(() => broker.send(ws, msg)).not.toThrow()
      expect(warnSpy.mock.calls.some(([m]) => String(m).includes('[backpressure]'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('message-bus-resolve-path', () => {
afterEach(() => {
  vi.restoreAllMocks()
})
describe('D1 移交接线：MessageBus 第二参 resolveSessionFilePath', () => {
  it('注入 resolver 后，超限截断占位文案携带 session 文件实路径（订阅者视角）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bus = new MessageBus(1000, {
      ...SMALL_OPTS,
      resolveSessionFilePath: (sessionId) =>
        sessionId === 's1' ? '/data/agent/sessions/x/1_s1.jsonl' : null,
    })
    const ws = makeClient()
    bus.subscribe('s1', ws)
    // message.bashResult：LARGE_FIELD_REGISTRY 登记的 string 类大字段帧（u4a 穷举表）
    bus.publish('s1', {
      type: 'message.bashResult',
      payload: { sessionId: 's1', output: 'x'.repeat(5000), command: 'cat big.log', exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
    } as unknown as ServerMessage)
    const received = sentMessages(ws)
    expect(received).toHaveLength(1)
    const note = (received[0].payload as { output: string }).output
    expect(note).toContain('/data/agent/sessions/x/1_s1.jsonl')
    expect(note).not.toContain('（见 runtime 日志）')
    expect(warnSpy).toHaveBeenCalled() // 截断 warn 哨兵照常
  })

  it('resolver 返回 null / 抛错 → 占位退化为「（见 runtime 日志）」（resolvePathSafe 契约不回归）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new MessageBus(1000, {
      ...SMALL_OPTS,
      resolveSessionFilePath: (sessionId) => {
        if (sessionId === 'boom') throw new Error('resolver exploded')
        return undefined
      },
    })
    const ws = makeClient()
    bus.subscribe('s2', ws)
    const wsBoom = makeClient()
    bus.subscribe('boom', wsBoom)
    const mkFrame = (sid: string): ServerMessage =>
      ({
        type: 'message.bashResult',
        payload: { sessionId: sid, output: 'x'.repeat(5000), command: 'c', exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
      }) as unknown as ServerMessage
    bus.publish('s2', mkFrame('s2'))
    bus.publish('boom', mkFrame('boom'))
    for (const wsCase of [ws, wsBoom]) {
      const note = (sentMessages(wsCase)[0].payload as { output: string }).output
      expect(note).toContain('（见 runtime 日志）')
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('agent-scanner', () => {
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-scan-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('scanAgents', () => {
  it('候选优先级：agent.md 胜过同名 .md 与 SKILL.md', () => {
    const dir = join(root, 'myagent')
    writeAgent(dir, 'agent.md', '---\ndescription: from agent.md\n---\nbody')
    writeAgent(dir, 'myagent.md', '---\ndescription: from dir-name\n---\nbody')
    writeAgent(dir, 'SKILL.md', '---\ndescription: from skill\n---\nbody')

    const [agent] = scanAgents([root], new Set())
    expect(agent.description).toBe('from agent.md')
    expect(agent.sourcePath).toBe(join(dir, 'agent.md'))
  })

  it('无 agent.md 时回退目录名.md', () => {
    const dir = join(root, 'second')
    writeAgent(dir, 'second.md', '---\ndescription: dir-name fallback\n---\nbody')

    const [agent] = scanAgents([root], new Set())
    expect(agent.description).toBe('dir-name fallback')
    expect(agent.sourcePath).toBe(join(dir, 'second.md'))
  })

  it('无 agent.md / 目录名.md 时回退 SKILL.md', () => {
    const dir = join(root, 'third')
    writeAgent(dir, 'SKILL.md', '---\ndescription: skill fallback\n---\nbody')

    const [agent] = scanAgents([root], new Set())
    expect(agent.description).toBe('skill fallback')
  })

  it('无任何候选文件时跳过该目录', () => {
    mkdirSync(join(root, 'empty'), { recursive: true })
    writeFileSync(join(root, 'empty', 'readme.txt'), 'not an agent')

    expect(scanAgents([root], new Set())).toEqual([])
  })

  it('description 无 frontmatter 时正文 fallback（首非标题非空行）', () => {
    const dir = join(root, 'bodyagent')
    writeAgent(dir, 'agent.md', ['# Title', '', 'first body line', 'second'].join('\n'))

    const [agent] = scanAgents([root], new Set())
    expect(agent.description).toBe('first body line')
  })

  it('description 多行 >- 折叠块', () => {
    const dir = join(root, 'multi')
    writeAgent(dir, 'agent.md', ['---', 'description: >-', '  第一行', '  第二行', '---', 'body'].join('\n'))

    const [agent] = scanAgents([root], new Set())
    expect(agent.description).toBe('第一行 第二行')
  })

  it('tools 逗号分割并 trim', () => {
    const dir = join(root, 'toolsagent')
    writeAgent(dir, 'agent.md', ['---', 'description: d', 'tools: read , write, exec', '---', 'body'].join('\n'))

    const [agent] = scanAgents([root], new Set())
    expect(agent.tools).toEqual(['read', 'write', 'exec'])
  })

  it('alreadyImported：id 命中 existingAgentIds 时为 true', () => {
    const dir = join(root, 'imp')
    writeAgent(dir, 'agent.md', '---\ndescription: d\n---\nbody')

    // sourceType 对 tmpdir 推断为 'custom'，id = `custom-imp`
    const [imported] = scanAgents([root], new Set(['custom-imp']))
    expect(imported.alreadyImported).toBe(true)

    const [fresh] = scanAgents([root], new Set())
    expect(fresh.alreadyImported).toBe(false)
  })

  it('description 截断到 200 字', () => {
    const dir = join(root, 'long')
    const longDesc = '啊'.repeat(250)
    writeAgent(dir, 'agent.md', `---\ndescription: ${longDesc}\n---\nbody`)

    const [agent] = scanAgents([root], new Set())
    expect(agent.description.length).toBe(200)
  })

  it('icon 取目录名首字母大写', () => {
    const dir = join(root, 'lowercase')
    writeAgent(dir, 'agent.md', '---\ndescription: d\n---\nbody')

    const [agent] = scanAgents([root], new Set())
    expect(agent.icon).toBe('L')
  })

  it('多 agent 目录全部收集', () => {
    writeAgent(join(root, 'a1'), 'agent.md', '---\ndescription: a1d\n---\nbody')
    writeAgent(join(root, 'a2'), 'agent.md', '---\ndescription: a2d\n---\nbody')

    const agents = scanAgents([root], new Set())
    expect(agents).toHaveLength(2)
    expect(agents.map((a) => a.name).sort()).toEqual(['a1', 'a2'])
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('discovery-store', () => {
beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'discovery-store-test-'))
  discoveryPath = join(tmpDir, 'discovery.json')
  setDiscoveryPath(discoveryPath)
})
afterEach(async () => {
  await rmP(tmpDir, { recursive: true, force: true })
})
describe('discovery-store', () => {
  describe('readDiscovery', () => {
    it('returns default (preset-enabled) v2 config when file does not exist', () => {
      // 默认态 = preset 全勾（pi + taiji 相关目录），新装用户打开设置即见勾选态
      expect(readDiscovery()).toEqual(DEFAULTS_V2)
    })

    it('reads existing v2 config', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 2,
        skill: { projectPaths: ['.agents/skills'], globalPaths: ['~/.pi/agent/skills'] },
        agent: { projectPaths: [], globalPaths: ['~/.agents/agents'] },
        extension: { projectPaths: [], globalPaths: [] },
      }), 'utf-8')
      expect(getSkillDirs()).toEqual(['.agents/skills', '~/.pi/agent/skills'])
      expect(getAgentDirs()).toEqual(['~/.agents/agents'])
      expect(getSkillPathScopes()).toEqual({ projectPaths: ['.agents/skills'], globalPaths: ['~/.pi/agent/skills'] })
    })

    it('returns default on corrupt JSON', () => {
      writeFileSync(discoveryPath, '{ broken', 'utf-8')
      expect(readDiscovery()).toEqual(DEFAULTS_V2)
    })

    it('returns default on non-object JSON (e.g. array)', () => {
      writeFileSync(discoveryPath, '[1,2,3]', 'utf-8')
      expect(readDiscovery()).toEqual(DEFAULTS_V2)
    })

    it('filters non-string entries in v2 projectPaths/globalPaths', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 2,
        skill: { projectPaths: ['ok', 123, null, 'also-ok'], globalPaths: [true, 'glob-ok'] },
        agent: { projectPaths: [], globalPaths: [] },
        extension: { projectPaths: [], globalPaths: [] },
      }), 'utf-8')
      expect(getSkillDirs()).toEqual(['ok', 'also-ok', 'glob-ok'])
      expect(getSkillPathScopes()).toEqual({ projectPaths: ['ok', 'also-ok'], globalPaths: ['glob-ok'] })
    })
  })

  describe('v1→v2 migration on read', () => {
    it('全相对路径 → 全 projectPaths', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['.agents/skills', '.taiji/skills'],
        agentDirs: ['.agents/agents'],
        extensionDirs: [],
      }), 'utf-8')
      expect(getSkillPathScopes()).toEqual({ projectPaths: ['.agents/skills', '.taiji/skills'], globalPaths: [] })
      expect(getAgentDirs()).toEqual(['.agents/agents'])
    })

    it('全绝对/~ 路径 → 全 globalPaths', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['~/.pi/agent/skills', '/abs/skills'],
        agentDirs: [],
        extensionDirs: [],
      }), 'utf-8')
      expect(getSkillPathScopes()).toEqual({ projectPaths: [], globalPaths: ['~/.pi/agent/skills', '/abs/skills'] })
    })

    it('混合路径 → 按 isGlobalPath 分流（相对→project / 绝对/~→global）', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['~/.pi/agent/skills', '.agents/skills', '/abs/x', '.taiji/skills'],
        agentDirs: ['~/.agents/agents'],
        extensionDirs: ['.pi/extensions'],
      }), 'utf-8')
      expect(getSkillPathScopes()).toEqual({
        projectPaths: ['.agents/skills', '.taiji/skills'],
        globalPaths: ['~/.pi/agent/skills', '/abs/x'],
      })
      expect(getAgentDirs()).toEqual(['~/.agents/agents'])
      expect(getExtensionDirs()).toEqual(['.pi/extensions'])
      // 合并顺序：project 在前，global 在后（项目优先级 > 全局）
      expect(getSkillDirs()).toEqual(['.agents/skills', '.taiji/skills', '~/.pi/agent/skills', '/abs/x'])
    })

    it('空 v1 → 空 v2（六字段全空；迁移产物是空态而非 ENOENT 默认态）', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: [],
        agentDirs: [],
        extensionDirs: [],
      }), 'utf-8')
      expect(readDiscovery()).toEqual(EMPTY_V2)
    })

    it('v1 迁移后写回落盘为 v2（deserialize 迁移值经 writeDiscovery 持久化）', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['.agents/skills', '~/.pi/agent/skills'],
        agentDirs: [],
        extensionDirs: [],
      }), 'utf-8')
      // 触发读取（deserialize 迁移到 v2）
      expect(getSkillPathScopes()).toEqual({ projectPaths: ['.agents/skills'], globalPaths: ['~/.pi/agent/skills'] })
      // 一次写入把迁移结果落盘为 v2
      setSkillDirs([proj('.agents/skills'), glob('~/.pi/agent/skills')])
      invalidateDiscoveryCache()
      const onDisk = JSON.parse(readFileSync(discoveryPath, 'utf-8'))
      expect(onDisk.version).toBe(2)
      expect(onDisk.skill).toEqual({ projectPaths: ['.agents/skills'], globalPaths: ['~/.pi/agent/skills'] })
    })
  })

  describe('setSkillDirs / setAgentDirs / setExtensionDirs (SkillDirConfig[])', () => {
    it('按 scope 分发：project 路径进 projectPaths，global 路径进 globalPaths', () => {
      setSkillDirs([proj('.agents/skills'), glob('~/.pi/agent/skills')])
      expect(getSkillPathScopes()).toEqual({ projectPaths: ['.agents/skills'], globalPaths: ['~/.pi/agent/skills'] })
      // 合并：project 在前
      expect(getSkillDirs()).toEqual(['.agents/skills', '~/.pi/agent/skills'])
    })

    it('writes skillDirs and preserves existing agentDirs', () => {
      // 注：~/.claude/skills 已移出预设，不作为 preset 豁免用例（存在性过滤不确定性），改用 ~/.agents/skills
      setSkillDirs([glob('~/.pi/agent/skills'), glob('~/.agents/skills')])
      setAgentDirs([glob('~/.agents/agents')])
      expect(getSkillDirs()).toEqual(['~/.pi/agent/skills', '~/.agents/skills'])
      expect(getAgentDirs()).toEqual(['~/.agents/agents'])
    })

    it('overwrites in order (drag-to-reorder writes new array)', () => {
      setSkillDirs([glob('c'), glob('a'), glob('b')])
      expect(getSkillDirs()).toEqual(['c', 'a', 'b'])
    })

    it('persists to disk as v2 (re-read via fresh cache after invalidate)', () => {
      setSkillDirs([glob('~/.pi/agent/skills')])
      invalidateDiscoveryCache()
      const onDisk = JSON.parse(readFileSync(discoveryPath, 'utf-8'))
      expect(onDisk.version).toBe(2)
      expect(onDisk.skill).toEqual({ projectPaths: [], globalPaths: ['~/.pi/agent/skills'] })
    })

    it('keeps file when all six fields empty（全空 = 用户显式取消全部勾选，不被默认态复活）', () => {
      setSkillDirs([glob('~/.pi/agent/skills')])
      expect(existsSync(discoveryPath)).toBe(true)
      // 清空 → 六字段全空 → 文件保留（旧「空则删」已移除：删文件会让下次读回落默认态，
      // 用户关掉的目录在下次读取时「复活」为勾选）
      setSkillDirs([])
      setAgentDirs([])
      setExtensionDirs([])
      expect(existsSync(discoveryPath)).toBe(true)
      // 再读返回用户显式写入的全空态，而非 preset 默认勾选态
      expect(readDiscovery()).toEqual(EMPTY_V2)
    })
  })

  describe('setExtensionDirs', () => {
    it('writes extensionDirs and preserves existing skillDirs/agentDirs', () => {
      setSkillDirs([glob('~/.pi/agent/skills')])
      setAgentDirs([glob('~/.agents/agents')])
      setExtensionDirs([glob('~/.pi/agent/extensions')])
      expect(getExtensionDirs()).toEqual(['~/.pi/agent/extensions'])
      expect(getSkillDirs()).toEqual(['~/.pi/agent/skills'])
      expect(getAgentDirs()).toEqual(['~/.agents/agents'])
    })

    it('keeps file when extension emptied too（全空文件保留，不再删档）', () => {
      setSkillDirs([glob('~/.pi/agent/skills')])
      setSkillDirs([])
      setAgentDirs([])
      setExtensionDirs([glob('~/.pi/agent/extensions')])
      expect(existsSync(discoveryPath)).toBe(true)
      expect(getExtensionDirs()).toEqual(['~/.pi/agent/extensions'])
      setExtensionDirs([])
      expect(existsSync(discoveryPath)).toBe(true)
      expect(getExtensionDirs()).toEqual([])
    })
  })

  describe('writeDiscovery (full overwrite)', () => {
    it('writes full v2 config object', () => {
      writeDiscovery({
        version: 2,
        skill: { projectPaths: ['x'], globalPaths: ['y'] },
        agent: { projectPaths: [], globalPaths: ['z'] },
        extension: { projectPaths: [], globalPaths: [] },
      })
      expect(readDiscovery()).toEqual({
        version: 2,
        skill: { projectPaths: ['x'], globalPaths: ['y'] },
        agent: { projectPaths: [], globalPaths: ['z'] },
        extension: { projectPaths: [], globalPaths: [] },
      })
    })
  })

  describe('external change visibility (revision fingerprint)', () => {
    it('serves external file change on next read without invalidate; invalidate still forces reread', () => {
      setSkillDirs([glob('v1')])
      writeFileSync(discoveryPath, JSON.stringify({
        version: 2,
        skill: { projectPaths: [], globalPaths: ['v2-external'] },
        agent: { projectPaths: [], globalPaths: [] },
        extension: { projectPaths: [], globalPaths: [] },
      }), 'utf-8')
      // 指纹失配 → 重读：外部改动无需失效即下一次 read 可见
      expect(getSkillDirs()).toEqual(['v2-external'])
      // invalidate 显式失效路径保持可用
      writeFileSync(discoveryPath, JSON.stringify({
        version: 2,
        skill: { projectPaths: [], globalPaths: ['v3-external'] },
        agent: { projectPaths: [], globalPaths: [] },
        extension: { projectPaths: [], globalPaths: [] },
      }), 'utf-8')
      invalidateDiscoveryCache()
      expect(getSkillDirs()).toEqual(['v3-external'])
    })
  })
})
});
// ======================================================================
// ← test/errors.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('errors', () => {
describe('toErrorMessage', () => {
  it('extracts .message from an Error', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('stringifies a non-Error thrown value', () => {
    expect(toErrorMessage('plain string')).toBe('plain string')
    expect(toErrorMessage(42)).toBe('42')
    expect(toErrorMessage(null)).toBe('null')
    expect(toErrorMessage(undefined)).toBe('undefined')
  })

  it('stringifies an object (no [object Object] ambiguity for arrays)', () => {
    expect(toErrorMessage([1, 2])).toBe('1,2')
  })

  it('handles subclass of Error', () => {
    class MyError extends Error {
      constructor(msg: string) { super(msg); this.name = 'MyError' }
    }
    expect(toErrorMessage(new MyError('sub'))).toBe('sub')
  })

  it('returns the message even when .message is empty', () => {
    expect(toErrorMessage(new Error(''))).toBe('')
  })
})
describe('isEnoent', () => {
  it('returns true for an error with code ENOENT', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    expect(isEnoent(err)).toBe(true)
  })

  it('returns false for an error with a different code', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    expect(isEnoent(err)).toBe(false)
  })

  it('returns false for a plain Error without a code', () => {
    expect(isEnoent(new Error('no code'))).toBe(false)
  })

  it('returns false for non-object values', () => {
    expect(isEnoent(null)).toBe(false)
    expect(isEnoent(undefined)).toBe(false)
    expect(isEnoent('ENOENT')).toBe(false)
    expect(isEnoent(42)).toBe(false)
  })

  it('returns false for an object without a code property', () => {
    expect(isEnoent({ message: 'x' })).toBe(false)
  })

  it('returns false for an object whose code is a non-matching string', () => {
    expect(isEnoent({ code: 'ENOTDIR' })).toBe(false)
  })

  it('returns true for a plain object with code ENOENT (duck-typed)', () => {
    // NodeJS.ErrnoException is structural — a plain object with code works
    expect(isEnoent({ code: 'ENOENT' })).toBe(true)
  })
})
describe('isNotFound', () => {
  it('returns true when Error message contains "not found" (lowercase)', () => {
    expect(isNotFound(new Error('session not found'))).toBe(true)
    expect(isNotFound(new Error('the resource was not found in tree'))).toBe(true)
  })

  it('is case-sensitive: capitalized "Not Found" does NOT match', () => {
    // 生产代码用 `.includes('not found')`（区分大小写）；此处钉住该行为。
    expect(isNotFound(new Error('Session Not Found'))).toBe(false)
  })

  it('returns false when Error message does not contain "not found"', () => {
    expect(isNotFound(new Error('permission denied'))).toBe(false)
    expect(isNotFound(new Error('boom'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isNotFound('not found')).toBe(false)
    expect(isNotFound(42)).toBe(false)
    expect(isNotFound(null)).toBe(false)
    expect(isNotFound(undefined)).toBe(false)
    expect(isNotFound({ message: 'not found' })).toBe(false)
  })

  it('returns false for an Error with empty message', () => {
    expect(isNotFound(new Error(''))).toBe(false)
  })
})
describe('errorWithCode', () => {
  it('creates an Error with a string code', () => {
    const err = errorWithCode('denied', 'PERMISSION_DENIED')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('denied')
    expect(err.code).toBe('PERMISSION_DENIED')
  })

  it('creates an Error with a numeric code (JSON-RPC -32xxx)', () => {
    const err = errorWithCode('parse error', -32700)
    expect(err.message).toBe('parse error')
    expect(err.code).toBe(-32700)
  })

  it('exposes .code as a readable property', () => {
    const err = errorWithCode('x', 'E_FOO')
    expect(err.code).toBe('E_FOO')
    // code is a real own property, not undefined
    expect(Object.prototype.hasOwnProperty.call(err, 'code')).toBe(true)
  })
})
});
});

// ======================================================================
// ← plugin-hooks-bundle.test.ts
// ======================================================================

/**
 * FR-8 Hook Bridge tests.
 *
 * Covers:
 * 1. EventAdapter onHookExecute callback — blocked, transformedData, passthrough
 * 2. PluginService registerSendMessageHook — blocked returns { blocked, reason }, passthrough returns null
 */

type PiTestEvent = PiMessage & Record<string, unknown>


function piEvent(fields: PiTestEvent): PiTestEvent {
  return fields
}


// ── EventAdapter onHookExecute ────────────────────────────────

// 模块级测试 configDir：PluginService 的 configDir 缺省回退 process.cwd()（仅供单测的
// 兜底），不注入会在包目录 mkdirSync plugins 目录——vitest fs-guard 白名单外被拦。
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'plugin-hook-bridge-cfg-'))


// ======================================================================
// ← test/plugin-hooks-e2e.test.ts
// ======================================================================

// ── Helpers ────────────────────────────────────────────────────

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}


/**
 * e2e 装置：一个宿主实例的完整接线。
 *
 * Worker 侧（内存端口对 A 端）：post 通道 + 入站消息泵（驱动真实 handleMessage）+
 * workerRpcClient attach（插件 hook 注册走真实 RPC client）。
 * 主线程侧（B 端）：真实 PluginRpcServer（registerWorker + invoke/notify/handleResponse）+
 * registerHookRpcHandlers + PluginService（executeHooks 分流：observe 快捷路径 / execute）。
 */
interface E2eHarness {  // oe-exempt:20261027:test:
  service: PluginService
  hookRegistry: Map<string, HookEntry[]>
  /** 主线程侧收到的全部消息（observe「不产生响应」断言用） */
  hostReceived: Array<Record<string, unknown>>
  makeAgentApi(pluginId: string): ReturnType<typeof createAgentAPI>
  pluginId: string
}


/**
 * 主线程消息泵：等价 PluginHost 的 worker.on('message') rpc 分发逻辑（传输适配层）。
 * Fix-3：rpc 分支复用 plugin-host 导出的 dispatchHostRpcMessage——与
 * plugin-host / plugin-host-process 生产实现单一真相，主线程分发链变更即时覆盖。
 */
function hostMessagePump(
  port: MessagePort,
  workerId: string,
  service: PluginService,
  hostReceived: Array<Record<string, unknown>>,
): void {
  port.on('message', (m: Record<string, unknown>) => {
    hostReceived.push(m)
    if (m.type !== 'rpc') return
    dispatchHostRpcMessage(service.rpcServer, workerId, m)
  })
}


/** Worker 侧入站泵：等价 parentPort.on('message', m => handleMessage(m)) */
function workerMessagePump(port: MessagePort): void {
  port.on('message', (m: HostToWorkerMessage) => {
    // 对齐 plugin-bootstrap 顶层包装：错误经 post 通道回 fatal_error（post 已注入）
    handleMessage(m).catch(() => {})
  })
}


function createHarness(hostPort: MessagePort, workerId: string, pluginId: string): E2eHarness {
  const service = new PluginService({} as never, createMockBroker())
  const hookRegistry = (service as unknown as { hookPipeline: { registry: Map<string, HookEntry[]> } }).hookPipeline.registry
  const hostReceived: Array<Record<string, unknown>> = []

  // 主线程：RPC 方法 + worker 注册 + 消息泵
  registerHookRpcHandlers(service.rpcServer, {
    hookRegistry,
    getDescriptor: (pid) => ({ pluginId: pid } as PluginDescriptor),
  })
  service.rpcServer.registerWorker(workerId, {
    postMessage: (message: unknown) => hostPort.postMessage(message),
  })
  hostMessagePump(hostPort, workerId, service, hostReceived)

  // host stub：仅替代「线程/进程 spawn」层——把主线程出站消息导向 hostPort。
  // 注意 HookPipeline 在 PluginService 构造时捕获 host 引用（readonly 字段），
  // stub 必须写进 pipeline 内部引用，替换 service.host 属性对 execute 不生效
  ;((service as unknown as { hookPipeline: { host: unknown } }).hookPipeline).host = {
    getWorkerHandle: () => ({
      workerId,
      postMessage: (message: unknown) => hostPort.postMessage(message),
    }),
  }

  return {
    service,
    hookRegistry,
    hostReceived,
    makeAgentApi: (pid: string) => createAgentAPI(pid),
    pluginId,
  }
}


/** 等待条件成立（observe fire-and-forget 断言用） */
async function waitFor(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}


/** 等待消息流静默（无新消息到达，observe「不产生响应」断言用） */
async function settleQuiet(received: Array<unknown>, quietMs = 50): Promise<void> {
  let last = received.length
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, quietMs))
    if (received.length === last) return
    last = received.length
  }
}


// ======================================================================
// ← test/plugin-hooks-integration.test.ts
// ======================================================================

function createMockBroker_m2(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}


/** 获取 PluginService 内部注册表的便捷方法（hookRegistry 下沉到 HookPipeline） */
function serviceRegistry(service: PluginService) {
  const hookPipeline = (service as unknown as { hookPipeline: { registry: Map<string, HookEntry[]> } }).hookPipeline
  const toolRegistry = (service as unknown as { toolRegistry: Map<string, ToolEntry> }).toolRegistry
  const host = (service as unknown as { host: { getWorkerHandle: ReturnType<typeof vi.fn> } }).host
  const rpcServer = (service as unknown as { rpcServer: { broadcast: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn> } }).rpcServer
  return { hookRegistry: hookPipeline.registry, toolRegistry, rpcServer, host }
}


// ======================================================================
// ← test/plugin-hooks-serial.test.ts
// ======================================================================

// ── Helpers ────────────────────────────────────────────────────

function createMockBroker_m3(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}


/** Access PluginService internals for test setup（hookRegistry 下沉到 HookPipeline） */
function internals(service: PluginService) {
  const hookPipeline = (service as unknown as { hookPipeline: { registry: Map<string, HookEntry[]> } }).hookPipeline
  const host = (service as unknown as { host: { getWorkerHandle: ReturnType<typeof vi.fn> } }).host
  const rpcServer = (service as unknown as { rpcServer: {
    invoke: ReturnType<typeof vi.fn>
    notify: ReturnType<typeof vi.fn>
    broadcast: ReturnType<typeof vi.fn>
  } }).rpcServer
  return { hookRegistry: hookPipeline.registry, rpcServer, host }
}


function makeContext(data: unknown = {}): HookContext {
  return {
    pluginId: '',
    hookType: 'onBeforeSendMessage',
    data,
    timestamp: Date.now(),
  }
}


// ======================================================================
// ← test/plugin-entry-invalidation-dispatch.test.ts
// ======================================================================

// ══════════════════════════════════════════════════════════════════
// 共用测试基建（contract-hardening.test.ts 同款）
// ══════════════════════════════════════════════════════════════════

function createMockPort_m2_m2_m2_m2_m2_m2_m2_m2(): WorkerPort & { messages: Array<Record<string, unknown>> } {
  const messages: Array<Record<string, unknown>> = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg as Record<string, unknown>)
    },
  }
}


function createMockBroker_m4(): IMessageBroker {
  return { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
}


function notificationsOf(port: { messages: Array<Record<string, unknown>> }): Array<{ method: string; params: Record<string, unknown> }> {
  return port.messages
    .filter(m => m.type === 'rpc' && (m as { notification?: unknown }).notification)
    .map(m => {
      const n = (m as { notification: { method: string; params: Record<string, unknown> } }).notification
      return { method: n.method, params: n.params }
    })
}


/** 可变会话列表（模拟 listPersistedSessions 扁平 id 集） */
function makeSessionRegistry(initial: string[]): { exists: (id: string) => boolean; add(id: string): void } {
  const ids = new Set(initial)
  return { exists: id => ids.has(id), add: id => void ids.add(id) }
}


// ======================================================================
// ← test/plugin-extension-bus-publish.test.ts
// ======================================================================

// ── fixtures ──────────────────────────────────────────────────

/** message-bus.test.ts 同款 mock 订阅者：sent 捕获全部 send 调用。 */
function createMockClient(): BusClient & { sent: string[] } {
  const sent: string[] = []
  return {
    readyState: 1,
    send: (data: string) => {
      sent.push(data)
    },
    sent,
  }
}


function createMockBroker_m5(): IMessageBroker & { broadcasts: unknown[] } {
  const broadcasts: unknown[] = []
  return {
    broadcasts,
    send: vi.fn(),
    broadcast: vi.fn((msg) => {
      broadcasts.push(msg)
    }),
    sendError: vi.fn(),
  }
}


/** 活跃 session 桩：ActiveSessionResolver 经 listPersistedSessions 扫描 status==='active'。 */
function createActiveSessionStub(sessionId: string): ISessionService {
  return {
    listPersistedSessions: () => [{
      cwd: '/tmp',
      sessions: [{ id: sessionId, label: sessionId, cwd: '/tmp', status: 'active', lastActiveAt: 1, modelId: 'test-model' }],
    }],
  } as unknown as ISessionService
}


/** 记录 postMessage 的 mock WorkerPort（plugin-commands-views.test.ts 同款）。 */
function createMockPort_m2_m2_m2_m2_m2_m2_m2_m2_d1(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  } as unknown as WorkerPort & { messages: unknown[] }
}


/**
 * 构造已接线的 PluginService（registerRpcMethods + rpcServer 注册 mock worker），
 * 返回 service + rpcServer + 依赖注入点（bus / broadcastFn / broker）。
 */
function wiredPluginService(opts: { sessionService?: ISessionService } = {}) {
  const broker = createMockBroker_m5()
  const broadcastFn = vi.fn()
  const deps: IPluginServiceDeps = { broadcastFn, ...opts }
  const service = new PluginService(new PluginRegistry('/tmp/fake-project', '/tmp/fake-project'), broker, deps)
  ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
  const rpcServer = (service as unknown as { rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>>; registerWorker(w: string, p: WorkerPort): void; dispatch(w: string, message: RpcRequest): Promise<void> } }).rpcServer
  const port = createMockPort_m2_m2_m2_m2_m2_m2_m2_m2_d1()
  rpcServer.registerWorker('w1', port)
  const dispatch = (method: string, params: Record<string, unknown>) =>
    rpcServer.dispatch('w1', { jsonrpc: '2.0', id: 1, method, params })
  return { service, broker, broadcastFn, dispatch }
}


// ======================================================================
// ← test/plugin-ui-event-channel.test.ts
// ======================================================================

/** 记录 postMessage 收到的消息（plugin-commands-views.test.ts 同款） */
function createMockPort_m3<T extends { postMessage(msg: unknown): void }>(): T & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  } as T & { messages: unknown[] }
}


function createMockBroker_m6(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}


/** 可对 registry/host 定制的 PluginService 装配（真实 registerRpcMethods 接线） */
function wiredService(registryOverrides: {
  descriptors?: Record<string, PluginDescriptor>
  workerIds?: Record<string, string>
} = {}, deps?: { broadcastFn?: (type: string, payload: unknown) => void }) {
  const descriptors = registryOverrides.descriptors ?? {
    'wool-workbuddy': { pluginId: 'wool-workbuddy', pluginPath: '/tmp/wool-workbuddy' } as PluginDescriptor,
  }
  const registry = {
    getDescriptor: (pluginId: string) => descriptors[pluginId],
  }
  const service = new PluginService(registry as never, createMockBroker_m6(), deps)
  ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
  const rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer
  const host = (service as unknown as { host: { getWorkerHandle(id: string): { workerId: string } | undefined } }).host
  host.getWorkerHandle = (pluginId: string) =>
    registryOverrides.workerIds === undefined || registryOverrides.workerIds[pluginId] === undefined
      ? { workerId: 'w1' }
      : { workerId: registryOverrides.workerIds[pluginId] }
  const port = createMockPort_m3<WorkerPort>()
  rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'wool-workbuddy' })
  return { service, rpcServer, port }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-hooks-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-hook-bridge', () => {
describe('EventAdapter: onHookExecute callback', () => {
  let sent: ServerMessage[]
  let send: WsSender

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
  })

  it('calls onHookExecute with correct hookType and context for tool_execution_start', async () => {
    const hookFn = vi.fn().mockResolvedValue({ blocked: false }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-1', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-100',
          toolName: 'read_file',
          args: { path: '/tmp/a.txt' },
        }))
        return () => {}
      },
    })

    // Wait for async handleEvent
    await vi.waitFor(() => expect(hookFn).toHaveBeenCalled(), { interval: 1 })

    expect(hookFn).toHaveBeenCalledWith('onBeforeToolCall', {
      toolName: 'read_file',
      input: { path: '/tmp/a.txt' },
    })
  })

  it('calls onHookExecute for tool_execution_end with onAfterToolResult', async () => {
    const hookFn = vi.fn().mockResolvedValue({ blocked: false }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-2', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_end',
          toolCallId: 'tc-200',
          result: 'file contents here',
          isError: false,
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(hookFn).toHaveBeenCalled(), { interval: 1 })

    expect(hookFn).toHaveBeenCalledWith('onAfterToolResult', {
      toolCallId: 'tc-200',
      output: 'file contents here',
    })
  })

  it('blocks event when hookResult.blocked === true', async () => {
    const hookFn = vi.fn().mockResolvedValue({
      blocked: true,
      reason: 'Plugin blocked this tool',
    }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-3', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-blocked',
          toolName: 'dangerous_tool',
          args: {},
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(hookFn).toHaveBeenCalled(), { interval: 1 })

    // Event is blocked — no message forwarded to frontend
    expect(sent).toHaveLength(0)
  })

  it('replaces input with transformedData when hook returns it', async () => {
    const transformedInput = { path: '/safe/path.txt', sanitized: true }
    const hookFn = vi.fn().mockResolvedValue({
      blocked: false,
      transformedData: transformedInput,
    }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-4', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-transform',
          toolName: 'write_file',
          args: { path: '/unsafe/path.txt' },
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(sent).toHaveLength(1), { interval: 1 })

    expect(sent[0].type).toBe('message.tool_call_start')
    // [w21] hook 改写同步回 entry.arguments（payload 换 entry 形态）
    const payload = sent[0].payload as { entry: { arguments?: unknown } }
    expect(payload.entry.arguments).toEqual(transformedInput)
  })

  it('replaces output with transformedData for tool_execution_end', async () => {
    const hookFn = vi.fn().mockResolvedValue({
      blocked: false,
      transformedData: 'REDACTED OUTPUT',
    }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-5', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_end',
          toolCallId: 'tc-trans-end',
          result: 'sensitive data',
          isError: false,
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(sent).toHaveLength(1), { interval: 1 })

    expect(sent[0].type).toBe('message.tool_call_end')
    // [w21] hook 改写同步回 entry.message.content（text block 数组，pi 持久化形态）
    const payload = sent[0].payload as { entry: { message: { content?: unknown } } }
    expect(payload.entry.message.content).toEqual([{ type: 'text', text: 'REDACTED OUTPUT' }])
  })

  // ── type-safety 检查（interpreter handleToolCallStart / handleToolCallEnd 检查目标）──
  // hook 是第三方插件代码（不可信源）：畸形 transformedData 不得以谎报类型进 wire 帧 /
  // 持久化 entry 契约（arguments/content text block）。检查在「裸赋值透传」形态下会红。

  it('guards: onBeforeToolCall 返回非对象 transformedData → 丢弃改写保原始 input（不透传进 entry.arguments）', async () => {
    for (const bad of ['string-rewrite', 42, ['array']]) {
      sent = []
      const hookFn = vi.fn().mockResolvedValue({ blocked: false, transformedData: bad }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>
      const adapter = createEventAdapter('sess-guard-in', send, { onHookExecute: hookFn })
      const original = { path: '/original.txt' }

      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({ type: 'tool_execution_start', toolCallId: 'tc-g1', toolName: 'write_file', args: original }))
          return () => {}
        },
      })
      await vi.waitFor(() => expect(sent).toHaveLength(1), { interval: 1 })

      const payload = sent[0].payload as { entry: { arguments?: unknown } }
      expect(payload.entry.arguments).toEqual(original) // 原始 input 保留
    }
  })

  it('guards: onAfterToolResult 返回非字符串 transformedData → 丢弃改写保原始 output（content 契约 string）', async () => {
    for (const bad of [{ obj: 1 }, ['array'], 7]) {
      sent = []
      const hookFn = vi.fn().mockResolvedValue({ blocked: false, transformedData: bad }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>
      const adapter = createEventAdapter('sess-guard-out', send, { onHookExecute: hookFn })

      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({ type: 'tool_execution_end', toolCallId: 'tc-g2', result: 'original output', isError: false }))
          return () => {}
        },
      })
      await vi.waitFor(() => expect(sent).toHaveLength(1), { interval: 1 })

      const payload = sent[0].payload as { entry: { message: { content?: unknown } } }
      expect(payload.entry.message.content).toEqual([{ type: 'text', text: 'original output' }]) // 原始 output 保留
    }
  })

  it('guards: pi 契约外畸形 args（string）→ entry.arguments 归一 {}（wire 帧不携带谎报类型）', async () => {
    const hookFn = vi.fn().mockResolvedValue({ blocked: false }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>
    const adapter = createEventAdapter('sess-guard-args', send, { onHookExecute: hookFn })

    adapter.attach({
      onEvent: (listener) => {
        // pi 契约 args 恒为对象（ADR-0037）——畸形 string 经 isPlainRecord 检查归一 {}
        listener(piEvent({ type: 'tool_execution_start', toolCallId: 'tc-g3', toolName: 'bash', args: 'not-an-object' }))
        return () => {}
      },
    })
    await vi.waitFor(() => expect(sent).toHaveLength(1), { interval: 1 })

    const payload = sent[0].payload as { entry: { arguments?: unknown } }
    expect(payload.entry.arguments).toEqual({})
  })

  it('锚点补挂：toolcall_end 先到 → tool_call_start 帧的 entry 携带 contentIndex + messageId', async () => {
    // toolcall_end（顺序锚点，contentIndex=1）先于 tool_execution_start 到达——
    // interpreter 从缓存补进 entry（§11 检查点 3：contentBlocks 有序插入依据）
    const hookFn = vi.fn().mockResolvedValue({ blocked: false }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>
    const adapter = createEventAdapter('sess-anchor', send, { onHookExecute: hookFn })

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'message_start',
          message: undefined, // assistant turn 开始（无 role）→ turn-start 产 messageId
        }))
        listener(piEvent({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_end',
            contentIndex: 1,
            toolCall: { type: 'toolCall', id: 'tc-anchor', name: 'bash', arguments: {} },
          },
        }))
        listener(piEvent({ type: 'tool_execution_start', toolCallId: 'tc-anchor', toolName: 'bash', args: {} }))
        return () => {}
      },
    })
    await vi.waitFor(() => {
      const start = sent.find((m) => m.type === 'message.tool_call_start')
      expect(start).toBeDefined()
    }, { interval: 1 })

    const start = sent.find((m) => m.type === 'message.tool_call_start')!
    const payload = start.payload as { entry: { contentIndex?: number; messageId?: string } }
    expect(payload.entry.contentIndex).toBe(1)
    expect(payload.entry.messageId).toMatch(/^a-/)
  })

  it('forwards event normally when onHookExecute is undefined', async () => {
    const adapter = createEventAdapter('sess-6', send) // no options

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-no-hook',
          toolName: 'read_file',
          args: { path: '/tmp/x' },
        }))
        return () => {}
      },
    })

    // handleEvent is async even without hook — wait for it
    await vi.waitFor(() => expect(sent).toHaveLength(1), { interval: 1 })
    expect(sent[0].type).toBe('message.tool_call_start')
    expect((sent[0].payload as { entry: { toolName?: string } }).entry.toolName).toBe('read_file')
  })

  it('proceeds with original data when hook throws', async () => {
    const hookFn = vi.fn().mockRejectedValue(new Error('hook crash')) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-7', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-err',
          toolName: 'read_file',
          args: { path: '/tmp/y' },
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(sent).toHaveLength(1), { interval: 1 })

    // Hook error → proceed with original data
    expect(sent[0].type).toBe('message.tool_call_start')
    const payload = sent[0].payload as { entry: { arguments?: unknown } }
    expect(payload.entry.arguments).toEqual({ path: '/tmp/y' })
  })
})
// ── PluginService registerSendMessageHook ──────────────────────

describe('PluginService: registerSendMessageHook', () => {
  /** Minimal mock to construct PluginService without touching fs/workers */
  function createMocks() {
    const registry = {
      getAllDescriptors: vi.fn().mockReturnValue([]),
      scan: vi.fn().mockResolvedValue([]),
    } as unknown as PluginRegistry

    const broker = { broadcast: vi.fn() }
    const setSendMessageHook = vi.fn()
    const sessionService = {
      setSendMessageHook,
      listPersistedSessions: vi.fn().mockReturnValue([]),
      getSummary: vi.fn().mockReturnValue(undefined),
      sendMessage: vi.fn(),
      // S3-W2：session 生命周期事件接线（registerSendMessageHook 内挂）
      setOnSessionCreated: vi.fn(),
      setOnSessionDestroyed: vi.fn(),
      // u5a relay ③：激活回调注册（追加式列表）——mock 跟进接口侧
      onSessionActivated: vi.fn(),
    }

    return { registry, broker, sessionService, setSendMessageHook }
  }

  it('registers setSendMessageHook during initialize()', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never, configDir: TEST_CONFIG_DIR },
    )

    await service.initialize()

    expect(setSendMessageHook).toHaveBeenCalledTimes(1)
    expect(setSendMessageHook).toHaveBeenCalledWith(expect.any(Function))

    await service.shutdown()
  })

  it('hook returns { blocked: true, reason } when executeHooks blocks', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never, configDir: TEST_CONFIG_DIR },
    )

    // Mock executeHooks to return blocked
    const executeHooksSpy = vi.spyOn(service, 'executeHooks').mockResolvedValue({
      blocked: true,
      reason: 'Content policy violation',
      blockedBy: 'plugin-safety',
    })

    await service.initialize()

    // Extract the hook function that was registered
    const hookFn = setSendMessageHook.mock.calls[0][0] as (
      sessionId: string,
      content: string,
    ) => Promise<{ blocked: boolean; reason?: string } | null>

    const result = await hookFn('sess-1', 'some dangerous content')

    expect(executeHooksSpy).toHaveBeenCalledWith(
      'onBeforeSendMessage',
      expect.objectContaining({
        sessionId: 'sess-1',
        content: 'some dangerous content',
        hookType: 'onBeforeSendMessage',
      }),
    )

    expect(result).toEqual({ blocked: true, reason: 'Content policy violation' })

    await service.shutdown()
  })

  it('hook returns null when executeHooks does not block', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never, configDir: TEST_CONFIG_DIR },
    )

    // Mock executeHooks to return not blocked
    vi.spyOn(service, 'executeHooks').mockResolvedValue({ blocked: false })

    await service.initialize()

    const hookFn = setSendMessageHook.mock.calls[0][0] as (
      sessionId: string,
      content: string,
    ) => Promise<{ blocked: boolean; reason?: string } | null>

    const result = await hookFn('sess-2', 'normal message')

    expect(result).toBeNull()

    await service.shutdown()
  })

  // Fix-1：transform 语义透传——executeHooks 返回 transformedData（D2-3 映射层产出的
  // Worker modifiedData）时，hook 以 modifiedContent 出口交给 message-dispatcher 消费
  it('hook returns modifiedContent when executeHooks yields transformedData {content}', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never, configDir: TEST_CONFIG_DIR },
    )

    vi.spyOn(service, 'executeHooks').mockResolvedValue({
      blocked: false,
      transformedData: { content: 'hello IMPORTANT world' },
    })

    await service.initialize()

    const hookFn = setSendMessageHook.mock.calls[0][0] as (
      sessionId: string,
      content: string,
    ) => Promise<{ blocked: boolean; reason?: string; modifiedContent?: string } | null>

    const result = await hookFn('sess-3', 'hello !important world')

    expect(result).toEqual({ blocked: false, modifiedContent: 'hello IMPORTANT world' })

    await service.shutdown()
  })

  it('hook ignores transformedData whose content is not a string', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never, configDir: TEST_CONFIG_DIR },
    )

    vi.spyOn(service, 'executeHooks').mockResolvedValue({
      blocked: false,
      transformedData: { content: { nested: true } },
    })

    await service.initialize()

    const hookFn = setSendMessageHook.mock.calls[0][0] as (
      sessionId: string,
      content: string,
    ) => Promise<{ blocked: boolean; reason?: string; modifiedContent?: string } | null>

    const result = await hookFn('sess-4', 'plain')

    // 非字符串 content 不构成改写，按「无 hook 结果」透传（不猜形状）
    expect(result).toBeNull()

    await service.shutdown()
  })

  it('does not register hook when sessionService is absent', async () => {
    const { registry, broker } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      // No sessionService（configDir 注入 tmp，防包目录 mkdir plugins——fs-guard）
      { configDir: TEST_CONFIG_DIR },
    )

    await service.initialize()

    // setSendMessageHook was never called (no sessionService)
    expect(broker.broadcast).toHaveBeenCalled() // initialize still broadcasts plugin list

    await service.shutdown()
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-hooks-e2e', () => {
// ══════════════════════════════════════════════════════════════════
// 宿主 1：Worker Thread（plugin-bootstrap.handleMessage + parentPort 语义）
// ══════════════════════════════════════════════════════════════════

describe('plugin-hooks e2e — Worker host (plugin-bootstrap.handleMessage)', () => {
  const { port1: portA, port2: portB } = new MessageChannel()
  let harness: E2eHarness

  beforeAll(() => {
    // Worker 侧传输接线（对齐真实 Worker：post 通道 + 入站泵 + rpcClient attach）
    setPostMessage((msg: unknown) => {
      portA.postMessage(msg)
    })
    workerRpcClient.attach({ postMessage: (msg: unknown) => portA.postMessage(msg) })
    workerMessagePump(portA)
    harness = createHarness(portB, 'e2e-worker-1', 'e2e-plugin')
  })

  afterAll(() => {
    harness.hookRegistry.clear()
    disposePluginHooks('e2e-plugin')
    portA.close()
    portB.close()
  })

  it('registers hook via real RPC round-trip (plugin.hooks.register lands in main-thread registry)', async () => {
    const api = harness.makeAgentApi('e2e-plugin')
    await api.hooks.onBeforeSendMessage(async () => ({ proceed: true }))

    const entries = harness.hookRegistry.get('onBeforeSendMessage')
    expect(entries).toBeTruthy()
    expect(entries!.length).toBe(1)
    expect(entries![0].pluginId).toBe('e2e-plugin')
    expect(typeof entries![0].handlerId).toBe('string')
  })

  it('block semantics: handler proceed:false → executeHooks returns blocked with reason (request leg)', async () => {
    const api = harness.makeAgentApi('e2e-plugin')
    await api.hooks.onBeforeToolCall(async () => ({
      proceed: false,
      reason: 'API key detected',
    }))

    const result = await harness.service.executeHooks('onBeforeToolCall', {
      pluginId: '',
      hookType: 'onBeforeToolCall',
      data: { toolName: 'bash' },
      timestamp: Date.now(),
    })

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('e2e-plugin')
    expect(result.reason).toBe('API key detected')
  })

  it('transform semantics: handler modifiedData → HookResult.transformedData (D2-3 mapping, request leg)', async () => {
    const api = harness.makeAgentApi('e2e-plugin')
    await api.hooks.onBeforeSendMessage(async (ctx) => {
      const content = (ctx.data as { content?: string }).content ?? ''
      return { proceed: true, modifiedData: { content: content.replace('!important', 'IMPORTANT') } }
    })

    const result = await harness.service.executeHooks('onBeforeSendMessage', {
      pluginId: '',
      hookType: 'onBeforeSendMessage',
      data: { content: 'hello !important world' },
      timestamp: Date.now(),
    })

    expect(result.blocked).toBe(false)
    // D2-3：Worker 响应的 modifiedData 经主线程映射层暴露为 transformedData
    expect(result.transformedData).toEqual({ content: 'hello IMPORTANT world' })
  })

  it('observe semantics: onPiEvent dispatched via notify — handler fires, no response produced (D2-2)', async () => {
    const api = harness.makeAgentApi('e2e-plugin')
    const observed: Array<{ eventName: string; data: unknown }> = []
    await api.hooks.onPiEvent('agent_start', async (eventName, data) => {
      observed.push({ eventName, data })
    })
    // 注册 key 已统一泛型（D2-4）：registry 条目在 'onPiEvent' 而非 'onPiEvent:agent_start'
    expect(harness.hookRegistry.has('onPiEvent')).toBe(true)
    expect(harness.hookRegistry.has('onPiEvent:agent_start')).toBe(false)

    harness.hostReceived.length = 0
    const notifySpy = vi.spyOn(harness.service.rpcServer, 'notify')
    const invokeSpy = vi.spyOn(harness.service.rpcServer, 'invoke')
    // [pi1-disposition-chat-flow D7①] context 用 event-interpreter 平铺形态（bridge 包装
    // 形状分支已随退役删除；生产调用形态 = { event, ...payload }）
    // ExecuteHookFn 的 context 形参是宽松 Record（event-interpreter 生产路径传平铺对象，
    // 经组合根注入绕过 HookContext 严格注解）；直调 service 方法同形态，cast 对齐。
    const result = await harness.service.executeHooks('onPiEvent', {
      event: 'agent_start',
      sessionId: 's-e2e',
    } as unknown as HookContext)

    // observe 快捷路径：立即返回不 block；经 notify（无 id 通知）派发，不创建 invoke
    expect(result).toEqual({ blocked: false })
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy.mock.calls[0][1]).toBe('plugin.hooks.invoke')
    expect(invokeSpy).not.toHaveBeenCalled()
    notifySpy.mockRestore()
    invokeSpy.mockRestore()

    // Worker handler 收到通知并执行（事件名/负载形状经 hook-api 包装适配）
    await waitFor(() => observed.length === 1)
    expect(observed[0].eventName).toBe('agent_start')
    expect(observed[0].data).toEqual({ sessionId: 's-e2e' })

    // 关键断言：零往返——Worker 对通知不产生任何响应（hostReceived 只收 Worker 发回的
    // 消息，保持为空 = 无 postRpcResponse、无错误回包）
    await settleQuiet(harness.hostReceived)
    expect(harness.hostReceived.length).toBe(0)
  })
})
// ══════════════════════════════════════════════════════════════════
// 宿主 2：fork 子进程（plugin-bootstrap-process 顶层 wiring + process.send/on 语义）
// ══════════════════════════════════════════════════════════════════

describe('plugin-hooks e2e — process host (plugin-bootstrap-process)', () => {
  const { port1: portC, port2: portD } = new MessageChannel()
  let harness: E2eHarness
  let wiringLoaded = false

  beforeAll(async () => {
    // mock process.send → 指向端口 C（子进程宿主顶层 wiring 的闭包动态读 process.send，
    // defineProperty 后天然生效——等价 fork channel 的出站方向）
    Object.defineProperty(process, 'send', {
      value: (msg: unknown) => portC.postMessage(msg),
      configurable: true,
      writable: true,
    })

    // 动态 import 触发真实顶层 wiring：setPostMessage(process.send 包装) +
    // workerRpcClient.attach(process.send 包装) + process.on('message', ...)
    await import('../src/services/plugin-service/plugin-bootstrap-process.js')
    wiringLoaded = true

    // 入站方向：fork channel 收到消息触发 process.on('message') —— 内存对等价物是
    // 把到达 portC 的消息经 process.emit('message') 转投（pump 只做传输转接，处理仍是
    // plugin-bootstrap-process 顶层注册的真实 handler → 共享 handleMessage）。
    // process.emit 的 TS 重载不认 'message'（按 Signals 处理），经 EventEmitter 类型
    // 转换调用（运行时 process 就是 EventEmitter）
    portC.on('message', (m: HostToWorkerMessage) => {
      ;(process as unknown as NodeJS.EventEmitter).emit('message', m)
    })

    harness = createHarness(portD, 'e2e-process-1', 'e2e-process-plugin')
  })

  afterAll(() => {
    harness.hookRegistry.clear()
    disposePluginHooks('e2e-process-plugin')
    portC.close()
    portD.close()
    // 恢复 process.send（非 IPC 进程原值为 undefined）
    delete (process as { send?: unknown }).send
  })

  it('plugin-bootstrap-process top-level wiring is active (post + shared rpcClient on process.send)', () => {
    expect(wiringLoaded).toBe(true)
  })

  it('block semantics via process IPC channel (request leg)', async () => {
    const api = harness.makeAgentApi('e2e-process-plugin')
    await api.hooks.onBeforeToolCall(async () => ({
      proceed: false,
      reason: 'blocked by sandbox plugin',
    }))
    expect(harness.hookRegistry.get('onBeforeToolCall')!.length).toBe(1)

    const result = await harness.service.executeHooks('onBeforeToolCall', {
      pluginId: '',
      hookType: 'onBeforeToolCall',
      data: { toolName: 'fs.read' },
      timestamp: Date.now(),
    })

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('e2e-process-plugin')
    expect(result.reason).toBe('blocked by sandbox plugin')
  })

  it('transform semantics via process IPC channel (D2-3 mapping, request leg)', async () => {
    const api = harness.makeAgentApi('e2e-process-plugin')
    await api.hooks.onAfterToolResult(async (ctx) => {
      const output = (ctx.data as { output?: string }).output ?? ''
      return { proceed: true, modifiedData: { output: output.toUpperCase() } }
    })

    const result = await harness.service.executeHooks('onAfterToolResult', {
      pluginId: '',
      hookType: 'onAfterToolResult',
      data: { output: 'raw result' },
      timestamp: Date.now(),
    })

    expect(result.blocked).toBe(false)
    expect(result.transformedData).toEqual({ output: 'RAW RESULT' })
  })

  it('observe semantics via process IPC channel — no response (D2-2)', async () => {
    const api = harness.makeAgentApi('e2e-process-plugin')
    const observed: string[] = []
    await api.hooks.onPiEvent('session_start', async (eventName) => {
      observed.push(eventName)
    })

    harness.hostReceived.length = 0
    const notifySpy = vi.spyOn(harness.service.rpcServer, 'notify')
    const invokeSpy = vi.spyOn(harness.service.rpcServer, 'invoke')
    // [pi1-disposition-chat-flow D7①] 平铺形态（同上）
    await harness.service.executeHooks('onPiEvent', {
      event: 'session_start',
    } as unknown as HookContext)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(invokeSpy).not.toHaveBeenCalled()
    notifySpy.mockRestore()
    invokeSpy.mockRestore()

    await waitFor(() => observed.length === 1)
    expect(observed).toEqual(['session_start'])
    // 零往返：Worker 对通知不产生任何响应（hostReceived 只收 Worker 发回的消息）
    await settleQuiet(harness.hostReceived)
    expect(harness.hostReceived.length).toBe(0)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-hooks-integration', () => {
// ══════════════════════════════════════════════════════════════════
// executeHooks
// ══════════════════════════════════════════════════════════════════

describe('PluginService.executeHooks', () => {
  // ── TC-HKP-01: 无注册 handler 返回未阻塞 ─────────────────────────
  it('TC-HKP-01: no registered handlers returns { blocked: false }', async () => {
    const service = new PluginService({} as never, createMockBroker_m2())
    const result = await (service as any).executeHooks('onBeforeSendMessage', {
      pluginId: '',
      hookType: 'onBeforeSendMessage',
      data: { text: 'hello' },
      timestamp: Date.now(),
    })
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-HKP-02: 排序后 broadcast 通知 Worker ────────────────────
  it('TC-HKP-02: sorted handlers broadcast invoke notification', async () => {
    const broker = createMockBroker_m2()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    // 注册三个 handler（乱序 priority，验证排序）
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-sandbox', handlerId: 'h3', priority: 200 },
      { pluginId: 'p-builtin', handlerId: 'h1', priority: 0 },
      { pluginId: 'p-trusted', handlerId: 'h2', priority: 100 },
    ])

    const context: HookContext = {
      pluginId: '',
      hookType: 'onBeforeSendMessage',
      data: { text: 'test' },
      timestamp: 1000,
    }
    const result = await (service as any).executeHooks('onBeforeSendMessage', context)

    // 简化实现：不等待 Worker 结果，返回默认未阻塞
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-HKP-03: 不存在的 hookType 返回未阻塞 ────────────────────
  it('TC-HKP-03: unknown hookType returns { blocked: false }', async () => {
    const broker = createMockBroker_m2()
    const service = new PluginService({} as never, broker)

    const reg = serviceRegistry(service)
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p1', handlerId: 'h1', priority: 0 },
    ])

    const result = await (service as any).executeHooks('onNonExistentHook', {
      pluginId: '',
      hookType: 'onNonExistentHook' as any,
      data: {},
      timestamp: Date.now(),
    })
    expect(result).toEqual({ blocked: false })
  })

  // [2026-09 测试舰队审查 r2-15] TC-HKP-04「handlers are sorted by priority ascending」已删：
  // 测试内自行 [...entries].sort 后断言排序结果，验证的是 JS Array.sort 而非 SUT——恒真；
  // executeHooks 真实调用序由 plugin-api-hooks.test.ts TC-HK-02（乱序注册按优先级执行）锁定。
})
// [pi1-disposition-chat-flow D7①] handleBridgeEvent / handleBridgeIntercept describe 段
// 随 plugin-bridge 整体退役删除（service 两方法已删；经 hookType 直接触发的用例由
// plugin-hooks-serial / plugin-hook-bridge 承接）。

// ══════════════════════════════════════════════════════════════════
// sessionDataCache
// ══════════════════════════════════════════════════════════════════

describe('PluginService.sessionDataCache', () => {
  // ── TC-HKP-15: sessionDataCache 可读写单条 session ──────────────
  it('TC-HKP-15: can read and write session data', () => {
    const broker = createMockBroker_m2()
    const service = new PluginService({} as never, broker)
    const sds = (service as unknown as { sessionDataStore: { set(s: string, k: string, v: unknown): void; get(s: string, k: string): unknown } }).sessionDataStore

    // 创建 session 数据
    sds.set('session-1', 'key1', 'value1')
    sds.set('session-1', 'key2', 42)

    // 读取
    expect(sds.get('session-1', 'key1')).toBe('value1')
    expect(sds.get('session-1', 'key2')).toBe(42)
  })

  // ── TC-HKP-16: sessionDataCache 支持多 session 隔离 ────────────
  it('TC-HKP-16: multiple sessions are isolated', () => {
    const broker = createMockBroker_m2()
    const service = new PluginService({} as never, broker)
    const sds = (service as unknown as { sessionDataStore: { set(s: string, k: string, v: unknown): void; get(s: string, k: string): unknown } }).sessionDataStore

    sds.set('session-a', 'msg', 'hello')
    sds.set('session-b', 'msg', 'world')

    expect(sds.get('session-a', 'msg')).toBe('hello')
    expect(sds.get('session-b', 'msg')).toBe('world')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-hooks-serial', () => {
// ══════════════════════════════════════════════════════════════════
// executeHooks — serial await with block/transform
// ══════════════════════════════════════════════════════════════════

describe('PluginService.executeHooks (BG1 T2)', () => {
  // ── TC-SH-01: No handlers → immediate { blocked: false } ──────
  it('TC-SH-01: no handlers returns { blocked: false }', async () => {
    const service = new PluginService({} as never, createMockBroker_m3())
    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-SH-02: Single handler passes → { blocked: false } ──────
  it('TC-SH-02: single handler passes returns { blocked: false }', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p1', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      proceed: true,
    })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext({ text: 'hello' }))

    expect(result).toEqual({ blocked: false })
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(1)
    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-1',
      'plugin.hooks.invoke',
      expect.objectContaining({
        handlerId: 'h1',
        hookType: 'onBeforeSendMessage',
      }),
    )
  })

  // ── TC-SH-03: Single handler blocks → { blocked: true, blockedBy, reason } ──
  it('TC-SH-03: single handler blocks returns blocked result', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-blocker', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      proceed: false,
      reason: 'API key detected',
    })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('p-blocker')
    expect(result.reason).toBe('API key detected')
  })

  // ── TC-SH-04: Priority ordering — trusted before sandbox ──────
  it('TC-SH-04: handlers execute in priority order', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    // D2-5：执行侧不再排序（hook-pipeline.execute 直接遍历），排序职责在注册侧
    // （registerHookRpcHandlers 的 entries.sort，由 plugin-api-hooks.test.ts TC-HK-02 覆盖）。
    // 此处按注册产出的既定顺序（trusted 100 → sandbox 200）set registry。
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-trusted', handlerId: 'h-trusted', priority: 100 },
      { pluginId: 'p-sandbox', handlerId: 'h-sandbox', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn()
      .mockReturnValueOnce({ workerId: 'worker-trusted', postMessage: vi.fn() })
      .mockReturnValueOnce({ workerId: 'worker-sandbox', postMessage: vi.fn() })

    const invokeOrder: string[] = []
    reg.rpcServer.invoke = vi.fn().mockImplementation(async (_workerId: string, _method: string, params: Record<string, unknown>) => {
      invokeOrder.push(params.handlerId as string)
      return { proceed: true }
    })

    await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(invokeOrder).toEqual(['h-trusted', 'h-sandbox'])
  })

  // ── TC-SH-05: Blocked stops chain — second handler never invoked ──
  it('TC-SH-05: blocked handler stops chain', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-first', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-second', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn()
      .mockResolvedValueOnce({ proceed: false, reason: 'Blocked' })
      .mockResolvedValueOnce({ proceed: true })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(1) // second never called
  })

  // ── TC-SH-06: Transform passes — modifiedData flows to next handler ──
  it('TC-SH-06: modifiedData flows to next handler', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-transformer', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-observer', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    const capturedContexts: unknown[] = []
    reg.rpcServer.invoke = vi.fn().mockImplementation(async (_workerId: string, _method: string, params: Record<string, unknown>) => {
      capturedContexts.push(params.context)
      if (params.handlerId === 'h1') {
        return { proceed: true, modifiedData: 'MODIFIED' }
      }
      return { proceed: true }
    })

    await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext('ORIGINAL'))

    // First handler gets original data
    expect((capturedContexts[0] as HookContext).data).toBe('ORIGINAL')
    // Second handler gets modified data
    expect((capturedContexts[1] as HookContext).data).toBe('MODIFIED')
  })

  // ── TC-SH-07: Worker timeout → handler skipped, chain continues ──
  it('TC-SH-07: timeout skips handler, chain continues', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-slow', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-fast', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({ proceed: true })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result).toEqual({ blocked: false })
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(2)
  })

  // ── TC-SH-08: Worker crashed → handler skipped ──
  it('TC-SH-08: worker crashed skips handler, chain continues', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-crashed', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-alive', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn()
      .mockReturnValueOnce(undefined) // crashed worker
      .mockReturnValueOnce({ workerId: 'worker-2', postMessage: vi.fn() })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: true })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result).toEqual({ blocked: false })
    // Only second handler invoked
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(1)
    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-2',
      'plugin.hooks.invoke',
      expect.objectContaining({ handlerId: 'h2' }),
    )
  })

  // ── TC-SH-09: Mixed — trusted transforms, sandbox blocks ──────
  it('TC-SH-09: mixed scenario — transform then block', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-trusted', handlerId: 'h1', priority: 100 },
      { pluginId: 'p-sandbox', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn()
      .mockResolvedValueOnce({ proceed: true, modifiedData: 'TRANSFORMED' })
      .mockResolvedValueOnce({ proceed: false, reason: 'Sensitive data' })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('p-sandbox')
    expect(result.reason).toBe('Sensitive data')
  })

  // ── TC-SH-10: Generic error in invoke → handler skipped ──────
  it('TC-SH-10: generic invoke error skips handler', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-error', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockRejectedValue(new Error('Worker crashed'))

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    // Error → treated as pass-through
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-SH-11: Block without reason → default reason includes pluginId ──
  it('TC-SH-11: block without reason uses default message', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-blocker', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    // proceed=false without reason
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: false })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())

    expect(result.blocked).toBe(true)
    expect(result.blockedBy).toBe('p-blocker')
    expect(result.reason).toContain('p-blocker')
  })

  // ── TC-SH-12: Transform returns undefined modifiedData → no change ──
  it('TC-SH-12: undefined modifiedData does not change context', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p1', handlerId: 'h1', priority: 100 },
      { pluginId: 'p2', handlerId: 'h2', priority: 200 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    const capturedContexts: unknown[] = []
    reg.rpcServer.invoke = vi.fn().mockImplementation(async (_w: string, _m: string, params: Record<string, unknown>) => {
      capturedContexts.push(params.context)
      return { proceed: true } // no modifiedData
    })

    await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext('ORIGINAL'))

    // Second handler should still see ORIGINAL (not undefined)
    expect((capturedContexts[1] as HookContext).data).toBe('ORIGINAL')
  })

  // ── TC-SH-13: D2-3 映射层 — modifiedData → transformedData ──
  it('TC-SH-13: mapping layer exposes modifiedData as HookResult.transformedData', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onAfterToolResult', [
      { pluginId: 'p-transformer', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    const modifiedData = { output: 'REDACTED' }
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: true, modifiedData })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onAfterToolResult', makeContext({ output: 'secret' }))

    // Worker 响应的 modifiedData 经映射层暴露为 transformedData（引用恒等）
    expect(result.blocked).toBe(false)
    expect(result.transformedData).toBe(modifiedData)
  })

  // ── TC-SH-14: D2-3 映射层 — block 形态字段映射 ──
  it('TC-SH-14: mapping layer maps proceed:false/reason to blocked/blockedBy/reason', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onBeforeToolCall', [
      { pluginId: 'p-blocker', handlerId: 'h1', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    // Worker 响应 {proceed:false, reason} → HookResult {blocked:true, blockedBy, reason}
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: false, reason: 'not allowed' })

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeToolCall', makeContext())

    expect(result).toEqual({ blocked: true, blockedBy: 'p-blocker', reason: 'not allowed' })
  })

  // ── TC-SH-15: P-1 — togglePlugin(false) 清 hook 注册，禁用插件的 hook 不再执行 ──
  it('TC-SH-15: togglePlugin(false) removes hook entries; disabled plugin hooks stop executing (P-1)', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    // 两个插件各持一个 hook（同 hookType）+ 一个只属于 p-disabled 的 hookType
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-disabled', handlerId: 'h-dis', priority: 100 },
      { pluginId: 'p-alive', handlerId: 'h-alive', priority: 200 },
    ])
    reg.hookRegistry.set('onBeforeToolCall', [
      { pluginId: 'p-disabled', handlerId: 'h-dis-2', priority: 100 },
    ])

    // stub registry（getDescriptor）+ activator（deactivate/stopWatching），隔离生命周期细节
    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p-disabled', status: 'ACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      deactivatePlugin: vi.fn().mockResolvedValue(undefined),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('ACTIVE'),
    }

    await service.togglePlugin('p-disabled', false)

    // registry 中该 pluginId 的 entries 全部清除；其他插件的保留；清空的 hookType 整键删除
    expect(reg.hookRegistry.get('onBeforeSendMessage')).toEqual([
      { pluginId: 'p-alive', handlerId: 'h-alive', priority: 200 },
    ])
    expect(reg.hookRegistry.has('onBeforeToolCall')).toBe(false)

    // 禁用后 executeHooks 不再为 p-disabled 派发 invoke
    reg.host.getWorkerHandle = vi.fn().mockReturnValue({ workerId: 'worker-1', postMessage: vi.fn() })
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ proceed: true })
    await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      .executeHooks('onBeforeSendMessage', makeContext())
    expect(reg.rpcServer.invoke).toHaveBeenCalledTimes(1)
    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-1',
      'plugin.hooks.invoke',
      expect.objectContaining({ handlerId: 'h-alive' }),
    )
  })

  // ── TC-SH-16: D2-2 — observe 类 hookType（onPiEvent）走 notify 零往返快捷路径 ──
  it('TC-SH-16: observe hookType dispatches via rpcServer.notify without invoke (D2-2)', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.hookRegistry.set('onPiEvent', [
      { pluginId: 'p-observer', handlerId: 'h-obs', priority: 100 },
    ])

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({ workerId: 'worker-1', postMessage: vi.fn() })
    reg.rpcServer.notify = vi.fn()
    reg.rpcServer.invoke = vi.fn()

    const result = await (service as unknown as { executeHooks: (t: string, c: HookContext) => Promise<HookResult> })
      // [pi1-disposition-chat-flow D7①] 原经 bridge 包装形状 {eventName, data} 驱动（通路已
      // 退役），改 event-interpreter 平铺形状（stdout 单一通路的现役调用形态）
      .executeHooks('onPiEvent', makeContext({ event: 'agent_start' }))

    // notify 派发（无 pending/超时），不创建 invoke；返回恒不 block
    expect(reg.rpcServer.notify).toHaveBeenCalledTimes(1)
    expect(reg.rpcServer.notify).toHaveBeenCalledWith(
      'worker-1',
      'plugin.hooks.invoke',
      expect.objectContaining({ handlerId: 'h-obs', hookType: 'onPiEvent' }),
    )
    expect(reg.rpcServer.invoke).not.toHaveBeenCalled()
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-SH-17: Fix-7 — togglePlugin(false) 清 tool/command 注册 ──
  // [pi1-disposition-chat-flow D7①] bridge 工具调用断言段随通路退役删除（handleBridgeToolExecute 已删），
  // Fix-7 的注册清理核心语义保留。
  it('TC-SH-17: togglePlugin(false) removes tool/command entries (Fix-7)', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)
    const toolRegistry = (service as unknown as { toolRegistry: Map<string, import('../src/services/plugin-service/plugin-types.js').ToolEntry> }).toolRegistry
    const commandRegistry = (service as unknown as { commandRegistry: Map<string, import('../src/services/plugin-service/api/commands-api.js').CommandRegistration> }).commandRegistry

    // p-disabled 与 p-alive 各持一个工具 + 命令
    const schema = (name: string) => ({ name, description: '', parameters: {} })
    toolRegistry.set('p-disabled:toolA', { pluginId: 'p-disabled', handlerId: 'p-disabled:toolA', schema: schema('toolA') })
    toolRegistry.set('p-alive:toolB', { pluginId: 'p-alive', handlerId: 'p-alive:toolB', schema: schema('toolB') })
    commandRegistry.set('cmd-a', { pluginId: 'p-disabled', commandId: 'cmd-a', title: 'A' } as import('../src/services/plugin-service/api/commands-api.js').CommandRegistration)
    commandRegistry.set('cmd-b', { pluginId: 'p-alive', commandId: 'cmd-b', title: 'B' } as import('../src/services/plugin-service/api/commands-api.js').CommandRegistration)

    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p-disabled', status: 'ACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      deactivatePlugin: vi.fn().mockResolvedValue(undefined),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('ACTIVE'),
    }
    await service.togglePlugin('p-disabled', false)

    // 该插件的工具/命令条目清除；其他插件的保留
    expect([...toolRegistry.keys()]).toEqual(['p-alive:toolB'])
    expect([...commandRegistry.keys()]).toEqual(['cmd-b'])
  })

  // ── TC-SH-18: Fix-5 — uninstallPlugin 时 deactivate 抛错不阻断清理 ──
  it('TC-SH-18: uninstallPlugin continues cleanup when deactivatePlugin rejects (Fix-5)', async () => {
    const broker = createMockBroker_m3()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)
    const toolRegistry = (service as unknown as { toolRegistry: Map<string, import('../src/services/plugin-service/plugin-types.js').ToolEntry> }).toolRegistry
    toolRegistry.set('p-gone:toolX', { pluginId: 'p-gone', handlerId: 'p-gone:toolX', schema: { name: 'toolX', description: '', parameters: {} } })
    reg.hookRegistry.set('onBeforeToolCall', [
      { pluginId: 'p-gone', handlerId: 'h-gone', priority: 100 },
    ])

    ;(service as unknown as { registry: unknown }).registry = {
      getDescriptor: vi.fn().mockReturnValue({ pluginId: 'p-gone', status: 'ACTIVE' }),
      getAllDescriptors: vi.fn().mockReturnValue([]),
      removeDescriptor: vi.fn(),
    }
    ;(service as unknown as { activator: unknown }).activator = {
      deactivatePlugin: vi.fn().mockRejectedValue(new Error('deactivate timeout')),
      stopWatching: vi.fn(),
      getState: vi.fn().mockReturnValue('ACTIVE'),
      removeDescriptor: vi.fn(),
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      // 不抛错：清理是 uninstall 的核心语义，deactivate 失败仅记日志
      await expect(service.uninstallPlugin('p-gone')).resolves.toBeTruthy()
      expect(errorSpy).toHaveBeenCalled()
      // 清理全部完成：descriptor 移除 + tool/hook 注册清空
      expect((service as unknown as { registry: { removeDescriptor: ReturnType<typeof vi.fn> } }).registry.removeDescriptor).toHaveBeenCalledWith('p-gone')
      expect(toolRegistry.size).toBe(0)
      expect(reg.hookRegistry.has('onBeforeToolCall')).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-entry-invalidation-dispatch', () => {
// ══════════════════════════════════════════════════════════════════
// 注册表（纯类）
// ══════════════════════════════════════════════════════════════════

describe('EntryInvalidationDispatch 注册表', () => {
  let sessions: ReturnType<typeof makeSessionRegistry>
  let table: EntryInvalidationDispatch

  beforeEach(() => {
    sessions = makeSessionRegistry(['s1', 's2'])
    table = new EntryInvalidationDispatch({ sessionExists: sessions.exists })
  })

  function reg(handlerId: string, workerId: string, pluginId: string, sessionId: string, customType: string): boolean {
    const target: EntryInvalidationTarget = { workerId, pluginId, sessionId, customType }
    return table.register(handlerId, target)
  }

  it('双匹配命中：dispatch 按 (sessionId, customType) 返回投递意图（workerId + handlerId）', () => {
    expect(reg('h1', 'wA', 'pA', 's1', 'task')).toBe(true)

    expect(table.dispatch('s1', 'task')).toEqual([{ workerId: 'wA', handlerId: 'h1' }])
  })

  it('会话隔离：会话 A 的事件不唤醒只在会话 B 订阅的插件', () => {
    reg('hB', 'wB', 'pB', 's2', 'task')

    expect(table.dispatch('s1', 'task')).toEqual([])
    expect(table.dispatch('s2', 'task')).toEqual([{ workerId: 'wB', handlerId: 'hB' }])
  })

  it('类型隔离：同会话不同 customType 不互相命中', () => {
    reg('h1', 'wA', 'pA', 's1', 'task')

    expect(table.dispatch('s1', 'other-type')).toEqual([])
  })

  it('注册校验：sessionId 不存在于当前会话列表 → 拒绝（返回 false 且不产生条目）', () => {
    expect(reg('h1', 'wA', 'pA', 'ghost', 'task')).toBe(false)
    expect(table.size).toBe(0)
    expect(table.dispatch('ghost', 'task')).toEqual([])
  })

  it('重复注册同一 handlerId 幂等覆盖：旧位置摘除、只在新位置命中', () => {
    expect(reg('h1', 'wA', 'pA', 's1', 'task')).toBe(true)
    expect(reg('h1', 'wB', 'pB', 's1', 'plan')).toBe(true) // 同 handlerId 换 customType + worker

    expect(table.dispatch('s1', 'task')).toEqual([]) // 旧位置不再命中
    expect(table.dispatch('s1', 'plan')).toEqual([{ workerId: 'wB', handlerId: 'h1' }])
    expect(table.size).toBe(1)
  })

  it('unregister 后不再命中（幂等：重复注销 no-op）', () => {
    reg('h1', 'wA', 'pA', 's1', 'task')

    table.unregister('h1')
    expect(table.dispatch('s1', 'task')).toEqual([])

    table.unregister('h1') // 幂等
    expect(table.size).toBe(0)
  })

  it('clearForPlugin：清该插件全部订阅、其他插件保留（幂等）', () => {
    reg('hA1', 'wA', 'pA', 's1', 'task')
    reg('hA2', 'wA', 'pA', 's2', 'plan')
    reg('hB1', 'wB', 'pB', 's1', 'task')

    table.clearForPlugin('pA')
    expect(table.dispatch('s1', 'task')).toEqual([{ workerId: 'wB', handlerId: 'hB1' }])

    table.clearForPlugin('pA') // 幂等
    expect(table.size).toBe(1)
  })

  it('clearForSession：清该会话全部订阅、其他会话保留（幂等）', () => {
    reg('hA1', 'wA', 'pA', 's1', 'task')
    reg('hA2', 'wA', 'pA', 's1', 'plan')
    reg('hB1', 'wB', 'pB', 's2', 'task')

    table.clearForSession('s1')
    expect(table.dispatch('s1', 'task')).toEqual([])
    expect(table.dispatch('s1', 'plan')).toEqual([])
    expect(table.dispatch('s2', 'task')).toEqual([{ workerId: 'wB', handlerId: 'hB1' }])

    table.clearForSession('s1') // 幂等
    expect(table.size).toBe(1)
  })

  it('无订阅者 dispatch 返回空数组（零开销路径：不抛错、零命中）', () => {
    expect(table.dispatch('s1', 'task')).toEqual([])
  })

  it('会话销毁后重注册：clearForSession 后同 id 会话复活可重新订阅（B5 复活路径对偶）', () => {
    reg('h1', 'wA', 'pA', 's1', 'task')
    table.clearForSession('s1')

    sessions.add('s3')
    expect(reg('h1', 'wA', 'pA', 's3', 'task')).toBe(true)
    expect(table.dispatch('s3', 'task')).toEqual([{ workerId: 'wA', handlerId: 'h1' }])
  })
})
// ══════════════════════════════════════════════════════════════════
// notifyEntryInvalidation（PluginService 面，真实 rpcServer + mock Worker port）
// ══════════════════════════════════════════════════════════════════

describe('PluginService.notifyEntryInvalidation 定向投递', () => {
  let tmpDir: string
  let service: PluginService
  let table: EntryInvalidationDispatch
  let portA: ReturnType<typeof createMockPort_m2_m2_m2_m2_m2_m2_m2_m2>
  let portB: ReturnType<typeof createMockPort_m2_m2_m2_m2_m2_m2_m2_m2>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'entry-inval-'))
    const registryMock = {
      getDescriptor: vi.fn(() => ({ pluginId: 'pA', pluginPath: '/tmp/pA' })),
      getAllDescriptors: () => [],
    }
    // 会话存在性谓词走真实注入点（listPersistedSessions 扁平 id 集）——s1/s2 可注册
    const sessionServiceMock = {
      listPersistedSessions: () => [{ sessions: [{ id: 's1' }, { id: 's2' }] }],
    }
    service = new PluginService(registryMock as never, createMockBroker_m4(), {
      configDir: tmpDir,
      sessionService: sessionServiceMock as never,
    })
    const rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer
    table = (service as unknown as { entryInvalidationDispatch: EntryInvalidationDispatch }).entryInvalidationDispatch
    portA = createMockPort_m2_m2_m2_m2_m2_m2_m2_m2()
    portB = createMockPort_m2_m2_m2_m2_m2_m2_m2_m2()
    rpcServer.registerWorker('wA', portA)
    rpcServer.registerWorker('wB', portB)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('有订阅者：notify 以正确 (workerId, 方法名, payload) 定向投递到订阅 Worker', () => {
    table.register('h1', { workerId: 'wA', pluginId: 'pA', sessionId: 's1', customType: 'task' })

    service.notifyEntryInvalidation('s1', 'task')

    expect(notificationsOf(portA)).toHaveLength(1)
    expect(notificationsOf(portA)[0]!.method).toBe(ENTRY_INVALIDATION_NOTIFY_METHOD)
    expect(notificationsOf(portA)[0]!.method).toBe('plugin.sessions.entriesInvalidated')
    expect(notificationsOf(portA)[0]!.params).toEqual({ handlerId: 'h1', sessionId: 's1', customType: 'task' })
    expect(notificationsOf(portB)).toHaveLength(0) // 非订阅 Worker 不收（定向，非广播）
  })

  it('无订阅者：零 notify 调用（零开销路径）', () => {
    service.notifyEntryInvalidation('s1', 'task')

    expect(notificationsOf(portA)).toHaveLength(0)
    expect(notificationsOf(portB)).toHaveLength(0)
  })

  it('同 (sessionId, customType) 多订阅者全部命中；事件维度错配不投递', () => {
    table.register('h1', { workerId: 'wA', pluginId: 'pA', sessionId: 's1', customType: 'task' })
    table.register('h2', { workerId: 'wB', pluginId: 'pB', sessionId: 's1', customType: 'task' })

    service.notifyEntryInvalidation('s1', 'task')

    expect(notificationsOf(portA)).toHaveLength(1)
    expect(notificationsOf(portB)).toHaveLength(1)

    service.notifyEntryInvalidation('s1', 'other-type')
    expect(notificationsOf(portA)).toHaveLength(1) // 不增长
    expect(notificationsOf(portB)).toHaveLength(1)
  })
})
// ══════════════════════════════════════════════════════════════════
// 四路清理接线（crash / session-destroyed 行为级；disable / uninstall 源码级）
// ══════════════════════════════════════════════════════════════════

describe('Entry 失效订阅四路清理接线', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'entry-inval-wire-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('crash 路：Worker 崩溃回调触发后，崩溃插件的订阅被清、其他插件订阅保留', () => {
    const registryMock = {
      getDescriptor: vi.fn(() => undefined),
      getAllDescriptors: () => [],
    }
    const sessionServiceMock = {
      listPersistedSessions: () => [{ sessions: [{ id: 's1' }, { id: 's2' }] }],
    }
    const service = new PluginService(registryMock as never, createMockBroker_m4(), {
      configDir: tmpDir,
      sessionService: sessionServiceMock as never,
    })
    const table = (service as unknown as { entryInvalidationDispatch: EntryInvalidationDispatch }).entryInvalidationDispatch
    table.register('hA', { workerId: 'w1', pluginId: 'pA', sessionId: 's1', customType: 'task' })
    table.register('hB', { workerId: 'w2', pluginId: 'pB', sessionId: 's1', customType: 'task' })

    ;(service as unknown as { registerWorkerCallbacks(): void }).registerWorkerCallbacks()
    const host = (service as unknown as { host: { onCrash?: (workerId: string, pluginIds: string[], error: unknown) => void } }).host
    expect(host.onCrash).toBeTypeOf('function')
    host.onCrash!('w1', ['pA'], new Error('worker died'))

    expect(table.dispatch('s1', 'task')).toEqual([{ workerId: 'w2', handlerId: 'hB' }])
  })

  it('session-destroyed 路：销毁回调触发后该会话订阅被清，且 didDestroy 投递并存（追加式不挤占）', () => {
    const setOnSessionDestroyed = vi.fn()
    const sessionServiceMock = {
      setSendMessageHook: vi.fn(),
      setOnSessionCreated: vi.fn(),
      setOnSessionDestroyed,
      // u5a relay ③：registerSendMessageHook 现亦注册激活回调（追加式列表）——mock 跟进接口侧
      onSessionActivated: vi.fn(),
      listPersistedSessions: () => [{ sessions: [{ id: 's1' }, { id: 's2' }] }],
    }
    const registryMock = {
      getDescriptor: vi.fn(() => undefined),
      getAllDescriptors: () => [],
    }
    const service = new PluginService(registryMock as never, createMockBroker_m4(), {
      configDir: tmpDir,
      sessionService: sessionServiceMock as never,
    })
    const table = (service as unknown as { entryInvalidationDispatch: EntryInvalidationDispatch }).entryInvalidationDispatch
    table.register('h1', { workerId: 'w1', pluginId: 'pA', sessionId: 's1', customType: 'task' })
    table.register('h2', { workerId: 'w2', pluginId: 'pB', sessionId: 's2', customType: 'task' })

    ;(service as unknown as { registerSendMessageHook(): void }).registerSendMessageHook()
    expect(setOnSessionDestroyed).toHaveBeenCalledTimes(1)
    const destroyedHandler = setOnSessionDestroyed.mock.calls[0]![0] as (summary: { id: string }) => void
    destroyedHandler({ id: 's1' })

    expect(table.dispatch('s1', 'task')).toEqual([])
    expect(table.dispatch('s2', 'task')).toEqual([{ workerId: 'w2', handlerId: 'h2' }])
  })

  it('disable / uninstall 路：togglePlugin(false) 与 uninstallPlugin 各接一处 clearForPlugin（源码级检查）', () => {
    const source = readFileSync(new URL('../src/services/plugin-service/plugin-service.ts', import.meta.url), 'utf8')

    // crash / disable / uninstall 三路各恰好一处接线（crash 路另有行为级用例交叉验证）
    expect(source.match(/this\.entryInvalidationDispatch\.clearForPlugin\(pluginId\)/g)).toHaveLength(3)
    // disable 路：togglePlugin(false) 分支内（紧随 sessionEventDispatch 清理）
    expect(source).toMatch(/this\.sessionEventDispatch\.clearForPlugin\(pluginId\)\n\s+this\.entryInvalidationDispatch\.clearForPlugin\(pluginId\)/)
    // uninstall 路：uninstallPlugin 体内（紧随 sessionEventDispatch 清理、UI 快照清理之后、
    // broadcastPluginList 之前——三路清理集同形：session 事件 → entry 失效 → UI 快照）
    expect(source).toMatch(/this\.sessionEventDispatch\.clearForPlugin\(pluginId\)\n\s+this\.entryInvalidationDispatch\.clearForPlugin\(pluginId\)\n\s+this\.uiSnapshotStore\.clearForPlugin\(pluginId\)\n\n\s+this\.broadcastPluginList\(\)/)
    // session-destroyed 路：与 didDestroy 同址（追加式回调体内）
    expect(source).toMatch(/didDestroy\(sessionInfoFromSummary\(summary\)\)\n\s+[\s\S]*?clearForSession\(summary\.id\)/)
  })
})
// ══════════════════════════════════════════════════════════════════
// 组合根两路注入（源码级检查，index-composition-root-wiring 同范式）
// ══════════════════════════════════════════════════════════════════

describe('组合根 onRecordEntriesInvalidated 两路注入', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  it('session 路径保留：invalidateRecordEntries 仍在注入体内（record 三族行为不受扰）', () => {
    expect(source).toContain('sessionService.invalidateRecordEntries(sid, customType)')
  })

  it('plugin 路径接入：notifyEntryInvalidation 在同一回调体内（两路都收到回调）', () => {
    expect(source).toMatch(/onRecordEntriesInvalidated: \(sid, customType\) => \{\s+sessionService\.invalidateRecordEntries\(sid, customType\)\s+[\s\S]*?pluginService\.notifyEntryInvalidation\(sid, customType\)/s)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-extension-bus-publish', () => {
// ══════════════════════════════════════════════════════════════
// plugin:viewUpdate —— transient 类（不占 seq、不入 ring、直传订阅者）
// ══════════════════════════════════════════════════════════════

describe('W08: plugin:viewUpdate 经 bus publish（transient）', () => {
  it('bus 装配 + 活跃 session → 订阅者收到、无 seq、不入 ring、seq 计数不变、不再 broadcast', async () => {
    const bus = new MessageBus()
    const { service, broker, broadcastFn, dispatch } = wiredPluginService({ sessionService: createActiveSessionStub('s1') })
    service.setMessageBus(bus)

    const ws = createMockClient()
    bus.subscribe('s1', ws)

    // [D1/u5b] views.update 按显式 payload.sessionId 归属投递（旧「活跃会话」盖戳已删）
    await dispatch('plugin.views.update', { pluginId: 'p1', viewId: 'v1', guiTree: [], sessionId: 's1' })

    // 订阅者收到（直传）
    expect(ws.sent).toHaveLength(1)
    const parsed = JSON.parse(ws.sent[0]!) as { type: string; payload: { sessionId: string; viewId: string; pluginId: string }; seq?: number }
    expect(parsed.type).toBe('plugin:viewUpdate')
    expect(parsed.payload.sessionId).toBe('s1')
    expect(parsed.payload.viewId).toBe('v1')
    expect(parsed.payload.pluginId).toBe('p1')
    // transient：无 seq 字段
    expect(parsed.seq).toBeUndefined()

    // transient：不入 ring、seq 计数不推进（第二个订阅者回放视角）
    const ws2 = createMockClient()
    const snap = bus.subscribe('s1', ws2)
    expect(snap.snapshot).toHaveLength(0)
    expect(snap.lastSeq).toBe(0)

    // 不再 broadcast（02 D1-1：sid 为 string 时只 publish）
    expect(broadcastFn).not.toHaveBeenCalled()
    expect(broker.broadcast).not.toHaveBeenCalled()
  })

  it('bus 未装配 → 回退全局广播（broadcastFn），消息不丢', async () => {
    const { broadcastFn, dispatch } = wiredPluginService({ sessionService: createActiveSessionStub('s1') })

    await dispatch('plugin.views.update', { pluginId: 'p1', viewId: 'v1', guiTree: [], sessionId: 's1' })

    expect(broadcastFn).toHaveBeenCalledTimes(1)
    const [type, payload] = broadcastFn.mock.calls[0] as [string, { sessionId: string; viewId: string }]
    expect(type).toBe('plugin:viewUpdate')
    expect(payload.sessionId).toBe('s1')
    expect(payload.viewId).toBe('v1')
  })

  it('m3: 同 tick 连续 views.update → push id 单调递增不碰撞（原 vu_${Date.now()} 同毫秒碰撞）', async () => {
    const bus = new MessageBus()
    const { service } = wiredPluginService({ sessionService: createActiveSessionStub('s1') })
    service.setMessageBus(bus)
    const ws = createMockClient()
    bus.subscribe('s1', ws)

    // 直接调 publishViewUpdate 四次（rpc dispatch 路径等价，绕开 worker 回环更聚焦 id 语义）：
    // 同 viewId 旧 generation 重推 + 新 viewId 同毫秒混发——transient 类逐帧直传（无合并），
    // 4 连发 = 4 帧，m3 断言面 = 4 个 push id 在同一毫秒内互不碰撞。
    const mkPayload = (viewId: string, generation: number) => ({
      sessionId: 's1', viewId, pluginId: 'p1',
      // 空树字面量推断 never[]，可赋给 GuiComponent[]（原 `as unknown[]` 逃逸类型检查，tsc 报错）
      guiTree: [], updatedAt: Date.now(),
      // U2：payload = ViewSnapshotItem（generation 必填，全量替换代际）
      generation,
    })
    service.publishViewUpdate(mkPayload('v1', 1))
    service.publishViewUpdate(mkPayload('v2', 1))
    service.publishViewUpdate(mkPayload('v1', 2))
    service.publishViewUpdate(mkPayload('v2', 2))

    expect(ws.sent).toHaveLength(4)
    const ids = ws.sent.map((m) => (JSON.parse(m) as { id: string }).id)
    for (const id of ids) {
      expect(id).toMatch(/^vu_\d+$/)
    }
    // 单调计数器：同毫秒 4 连发 id 全不碰撞（原 Date.now() 形态在此必撞）
    expect(new Set(ids).size).toBe(4)
  })
})
// ══════════════════════════════════════════════════════════════
// plugin:uiRequest —— stream 类（分配 seq、入 ring 可回放）
// ══════════════════════════════════════════════════════════════

describe('W08: plugin:uiRequest 经 bus publish（stream）', () => {
  /** 触发一次 uiRequest：调 plugin.ui.showConfirm RPC，返回 confirm promise。 */
  function triggerUiRequest(service: PluginService): Promise<unknown> {
    const rpcServer = (service as unknown as { rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> } }).rpcServer
    return rpcServer.methods.get('plugin.ui.showConfirm')!({
      pluginId: 'test-plugin',
      title: 'Confirm?',
      message: 'Are you sure?',
    })
  }

  it('bus 装配 + 活跃 session → 订阅者收到、有 seq、入 ring；不再全局 broadcast', async () => {
    const bus = new MessageBus()
    const broker = createMockBroker_m5()
    const service = new PluginService(
      new PluginRegistry('/tmp/fake-project', '/tmp/fake-project'),
      broker,
      { broadcastFn: vi.fn(), sessionService: createActiveSessionStub('s1') },
    )
    service.setMessageBus(bus)
    ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()

    const ws = createMockClient()
    bus.subscribe('s1', ws)

    const confirmPromise = triggerUiRequest(service)

    // 订阅者收到（stream 类）
    expect(ws.sent).toHaveLength(1)
    const parsed = JSON.parse(ws.sent[0]!) as { type: string; payload: { sessionId: string; requestId: string }; seq?: number }
    expect(parsed.type).toBe('plugin:uiRequest')
    expect(parsed.payload.sessionId).toBe('s1')
    expect(parsed.payload.requestId).toBeTruthy()
    expect(parsed.seq).toBe(1)

    // 入 ring：第二个订阅者回放可见
    const ws2 = createMockClient()
    const snap = bus.subscribe('s1', ws2)
    expect(snap.snapshot).toHaveLength(1)
    expect(snap.snapshot[0]!.type).toBe('plugin:uiRequest')
    expect(snap.snapshot[0]!.seq).toBe(1)
    expect(snap.lastSeq).toBe(1)

    // sid 为 string 时不再全局 broadcast（02 D1-1）
    expect(broker.broadcast).not.toHaveBeenCalled()

    // 收尾：respond 避免悬挂 promise
    service.handleUiResponse(parsed.payload.requestId, true)
    await expect(confirmPromise).resolves.toBe(true)
  })

  it('无活跃 session（sid undefined）+ bus 装配 → 保持全局 broadcast，bus 零 publish', async () => {
    const bus = new MessageBus()
    const publishSpy = vi.spyOn(bus, 'publish')
    const broker = createMockBroker_m5()
    const service = new PluginService(
      new PluginRegistry('/tmp/fake-project', '/tmp/fake-project'),
      broker,
      { broadcastFn: (type, payload) => broker.broadcast({ type, payload } as never) },
    )
    service.setMessageBus(bus)
    ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()

    const confirmPromise = triggerUiRequest(service)

    // sid undefined：全局 broadcast 兜底（无活跃 session 的弹窗必达全部连接）
    expect(broker.broadcast).toHaveBeenCalledTimes(1)
    const bcast = broker.broadcasts[0] as { type: string; payload: { requestId: string; sessionId?: string } }
    expect(bcast.type).toBe('plugin:uiRequest')
    expect(bcast.payload.sessionId).toBeUndefined()
    expect(publishSpy).not.toHaveBeenCalled()

    service.handleUiResponse(bcast.payload.requestId, true)
    await expect(confirmPromise).resolves.toBe(true)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-ui-event-channel', () => {
describe('plugin.uiEvent 值回传投递（D8）', () => {
  let port: ReturnType<typeof createMockPort_m3<WorkerPort>>
  let service: PluginService

  beforeEach(() => {
    const wired = wiredService()
    port = wired.port
    service = wired.service
  })

  it('WS 帧 handler → deliverPluginUiEvent：单向通知发往插件 Worker（viewId/componentId/event/value 原样透传）', async () => {
    await service.deliverPluginUiEvent('wool-workbuddy', 'authorize-view', 'pat-input', 'change', 'token-123')

    expect(port.messages).toHaveLength(1)
    // rpcServer.notify 消息形态：{ type:'rpc', notification: { jsonrpc, method, params } }
    const envelope = port.messages[0] as { type?: string; notification?: { method?: string; params?: { viewId?: string; componentId?: string; event?: string; value?: unknown } } }
    expect(envelope.type).toBe('rpc')
    expect(envelope.notification?.method).toBe(PLUGIN_UI_EVENT_NOTIFY)
    expect(envelope.notification?.params).toEqual({
      viewId: 'authorize-view',
      componentId: 'pat-input',
      event: 'change',
      value: 'token-123',
    })
  })

  it('fire-and-forget：投递不等待插件回执即 resolve（无 pending 链）', async () => {
    // 通知下发后无回传通道——deliverPluginUiEvent 不悬挂即为本语义
    await expect(
      service.deliverPluginUiEvent('wool-workbuddy', 'v', 'c', 'change', 42),
    ).resolves.toBeUndefined()
  })

  it('插件不存在（卸载/禁用后迟到回传）→ warn 丢弃，不崩、不下发', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await service.deliverPluginUiEvent('ghost-plugin', 'v', 'c', 'change', 'x')
      expect(port.messages).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('plugin not found: ghost-plugin'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})
describe('plugin.event 业务事件上报（D9）', () => {
  it('Worker RPC plugin.event → 校验后广播 plugin:event 帧（payload 透传，宿主不解释）', async () => {
    const broadcasts: PluginEventPayload[] = []
    const { service } = wiredService({}, {
      broadcastFn: (type: string, payload: unknown) => {
        if (type === 'plugin:event') broadcasts.push(payload as PluginEventPayload)
      },
    })
    const rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer

    await rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: PLUGIN_EVENT_RPC_METHOD,
      params: { channel: 'credential-status', payload: { loggedIn: false, reason: 'upstream-401' } },
    })

    expect(broadcasts).toEqual([
      { pluginId: 'wool-workbuddy', channel: 'credential-status', payload: { loggedIn: false, reason: 'upstream-401' } },
    ])
  })

  it('sandbox 通道 pluginId 取通道身份（消息体自报不采信）：伪造他人 pluginId 被身份覆写', async () => {
    const broadcasts: PluginEventPayload[] = []
    const { service } = wiredService({}, {
      broadcastFn: (type: string, payload: unknown) => {
        if (type === 'plugin:event') broadcasts.push(payload as PluginEventPayload)
      },
    })
    const rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer

    // params 自报 pluginId='wool-trae'（通道身份是 wool-workbuddy）→ 身份优先
    await rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: PLUGIN_EVENT_RPC_METHOD,
      params: { pluginId: 'wool-trae', channel: 'status', payload: {} },
    })

    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]?.pluginId).toBe('wool-workbuddy')
  })

  it('channel 缺失/非字符串 → 结构化拒绝（error response 含字段名），不广播', async () => {
    const broadcasts: PluginEventPayload[] = []
    const { service, port } = wiredService({}, {
      broadcastFn: (type: string, payload: unknown) => {
        if (type === 'plugin:event') broadcasts.push(payload as PluginEventPayload)
      },
    })
    const rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer

    // dispatch 恒 resolve（handler 抛错转 error response 回 Worker）
    await rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 3,
      method: PLUGIN_EVENT_RPC_METHOD,
      params: { channel: 42, payload: {} },
    })

    expect(broadcasts).toHaveLength(0)
    expect(port.messages).toHaveLength(1)
    const errorResponse = port.messages[0] as { response?: { error?: { message?: string } } }
    expect(errorResponse.response?.error?.message).toContain('channel')
  })
})
});
});

// ======================================================================
// ← npm-skill-bundle.test.ts
// ======================================================================

let projectDir: string


// ======================================================================
// ← test/skill-dir-config.test.ts
// ======================================================================

/** 包装为 project scope。 */
const proj_m2 = (path: string): SkillDirConfig => ({ path, enabled: true, scope: 'project' })


/** 包装为 global scope。 */
const glob_m2 = (path: string): SkillDirConfig => ({ path, enabled: true, scope: 'global' })


// ======================================================================
// ← test/migrate-skills-discovery.test.ts
// ======================================================================

const mkdtempP_m2 = promisify(mkdtemp)


const rmP_m2 = promisify(rm)


let tmpDir_m2: string


let piAgentDir: string


/** 在 tmpDir_m2 下创建一个 skill 容器（含若干带 SKILL.md 的子目录）。 */
function createSkillContainer(parentDir: string, skillNames: string[]): string {
  mkdirSync(parentDir, { recursive: true })
  for (const name of skillNames) {
    const skillDir = join(parentDir, name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), `---\ndescription: ${name}\n---\n# ${name}`, 'utf-8')
  }
  return parentDir
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('npm-skill-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('npm-installer-deps-failed', () => {
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'taiji-deps-failed-'))
})
afterEach(() => {
  try {
    rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch { /* ignore */ }
})
describe('RT-8#4: installDependencies 失败聚合', () => {
  it('无 package.json → 空清单（合法 no-op，防回归：不得进 failed[]）', async () => {
    const result = await installDependencies(projectDir)
    expect(result.failed).toEqual([])
  })

  it('空 dependencies → 空清单', async () => {
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }), 'utf-8')
    const result = await installDependencies(projectDir)
    expect(result.failed).toEqual([])
  })

  it('package.json 解析失败 → failed 含 name="package.json" 与原因（此前静默 return）', async () => {
    writeFileSync(join(projectDir, 'package.json'), '{ not valid json !!', 'utf-8')
    const result = await installDependencies(projectDir)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.name).toBe('package.json')
    expect(result.failed[0]!.error.length).toBeGreaterThan(0)
  })

  it('单个依赖安装失败 → 进 failed[] 且其余依赖继续尝试（此前仅 warn 后吞掉）', async () => {
    // 两个非法包名：均在 fetchMetadata 顶部被 validateNpmName 拒绝（零网络），
    // 逐条进 failed[] 证明 for 循环未被首个失败短路
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      dependencies: {
        '../evil': '^1.0.0',
        'has space': '^1.0.0',
      },
    }), 'utf-8')

    const result = await installDependencies(projectDir)
    expect(result.failed.map(f => f.name)).toEqual(['../evil', 'has space'])
    expect(result.failed.every(f => f.error.includes('Invalid package name'))).toBe(true)
  })
})
});
// ======================================================================
// ← test/npm-installer-name-validation.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('npm-installer-name-validation', () => {
describe('RT-8#3: validateNpmName 白名单（非法名必抛，消息含恢复动作）', () => {
  it.each([
    ['../', '相对上跳'],
    ['../../x', '多级上跳'],
    ['/etc/passwd', '绝对路径'],
    ['a/../../b', '符号链接形态名（中段上跳）'],
    ['@scope/../pkg', '含 .. 的 scoped 名'],
    ['@scope/..', 'scoped 尾段为 ..（join 后 = nodeModulesDir 本身）'],
    ['..', '纯上跳段'],
    ['.', '当前段'],
    ['@scope/pkg/extra', 'scoped 多段斜杠'],
    ['@/pkg', '空 scope'],
    ['@scope/', '空包段'],
    ['@scope', '缺 / 的 scoped 前缀'],
    ['.hidden-pkg', '前导点'],
    ['_private', '前导下划线'],
    ['Upper-Case', '大写字母'],
    ['has space', '空格'],
    ['has~tilde', '非白名单字符 ~'],
    ['leading ', '尾随空格'],
  ])('拒绝 %s（%s）', (name) => {
    expect(() => validateNpmName(name)).toThrow(NpmInstallError)
    expect(() => validateNpmName(name)).toThrow(/Invalid package name/)
    expect(() => validateNpmName(name)).toThrow(/tampering|blocked/)
  })

  it('空名与超长名（>214）拒绝', () => {
    expect(() => validateNpmName('')).toThrow(/Invalid package name/)
    expect(() => validateNpmName('a'.repeat(215))).toThrow(/214/)
  })

  it.each([
    ['lodash', '普通包'],
    ['@scope/pkg', 'scoped 包'],
    ['@zhushanwen/pi-todo', '真实 scoped 包'],
    ['left-pad', '连字符'],
    ['a.b.c', '点分段'],
    ['a_b', '下划线中缀'],
    ['tiny', '短名'],
  ])('放行合法名 %s（%s）', (name) => {
    expect(() => validateNpmName(name)).not.toThrow()
  })
})
describe('RT-8#3: isUnderOrEqual 检查语义（node_modules 边界判定）', () => {
  const nodeModulesDir = '/proj/node_modules'

  it.each([
    ['../', '相对上跳'],
    ['../../x', '多级上跳'],
    ['a/../../b', '中段上跳'],
  ])('join(nodeModulesDir, %s) 逃出边界 → isUnderOrEqual false（%s）', (name) => {
    expect(isUnderOrEqual(nodeModulesDir, join(nodeModulesDir, name))).toBe(false)
  })

  it('绝对路径 child（边界外）→ isUnderOrEqual false', () => {
    expect(isUnderOrEqual(nodeModulesDir, '/etc/passwd')).toBe(false)
  })

  it.each([
    ['lodash', '普通包'],
    ['@scope/pkg', 'scoped 包'],
  ])('join(nodeModulesDir, %s) 在边界内 → isUnderOrEqual true（%s）', (name) => {
    expect(isUnderOrEqual(nodeModulesDir, join(nodeModulesDir, name))).toBe(true)
  })
})
describe('RT-8#3: 调用点接线（uninstall/install 在 rmSync 前拒绝越界名）', () => {
  let root: string
  let nodeModulesDir: string
  let outsideDir: string
  let outsideFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'npm-name-guard-'))
    nodeModulesDir = join(root, 'node_modules')
    mkdirSync(nodeModulesDir)
    // node_modules 之外的诱饵：非法名若穿透检查会被 rmSync 递归删除
    outsideDir = join(root, 'outside')
    mkdirSync(outsideDir)
    outsideFile = join(outsideDir, 'precious.txt')
    writeFileSync(outsideFile, 'must-survive', 'utf-8')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('uninstallPackage 遇 ../ 越界名：抛错 + node_modules 外目录原样保留', async () => {
    await expect(uninstallPackage('../../outside', nodeModulesDir)).rejects.toThrow(NpmInstallError)
    expect(existsSync(outsideFile)).toBe(true)
    expect(existsSync(outsideDir)).toBe(true)
  })

  it.each([
    ['a/../../outside', '中段上跳'],
    ['@scope/../outside', 'scoped 尾段上跳'],
  ])('uninstallPackage 遇 %s（%s）：抛错 + 外部目录保留', async (name) => {
    await expect(uninstallPackage(name, nodeModulesDir)).rejects.toThrow(/Invalid package name|escapes node_modules/)
    expect(existsSync(outsideFile)).toBe(true)
  })

  it('installPackage 遇越界名：在发起任何网络请求前即抛（validateNpmName 前置于 fetchMetadata）', async () => {
    await expect(installPackage('../../outside', nodeModulesDir)).rejects.toThrow(/Invalid package name/)
    expect(existsSync(outsideFile)).toBe(true)
  })

  it('uninstallPackage 合法名：不抛（目录不存在时安静返回）', async () => {
    await expect(uninstallPackage('lodash', nodeModulesDir)).resolves.toBeUndefined()
  })

  it('uninstallPackage 合法 scoped 名且目录存在：只删包目录，node_modules 本体保留', async () => {
    const pkgDir = join(nodeModulesDir, '@scope', 'pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'index.js'), 'x', 'utf-8')

    await expect(uninstallPackage('@scope/pkg', nodeModulesDir)).resolves.toBeUndefined()
    expect(existsSync(pkgDir)).toBe(false)
    expect(existsSync(nodeModulesDir)).toBe(true)
  })
})
});
// ======================================================================
// ← test/npm-installer-ssrf.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('npm-installer-ssrf', () => {
describe('isPrivateIp — 13 条内网/特殊用途段全部拦截', () => {
  it.each([
    ['0.0.0.0', '0.0.0.0/8'],
    ['10.1.2.3', '10.0.0.0/8'],
    ['127.0.0.1', '127.0.0.0/8 loopback'],
    ['169.254.1.1', '169.254.0.0/16 link-local'],
    ['172.16.0.1', '172.16.0.0/12 起始'],
    ['172.31.255.255', '172.16.0.0/12 结束'],
    ['192.0.2.1', '192.0.2.0/24 TEST-NET-1'],
    ['192.168.1.1', '192.168.0.0/16'],
    ['198.51.100.1', '198.51.100.0/24 TEST-NET-2'],
    ['203.0.113.1', '203.0.113.0/24 TEST-NET-3'],
    ['224.0.0.1', '224.0.0.0/4 multicast'],
    ['239.255.255.255', '239.0.0.0/8 multicast'],
    ['240.0.0.1', '240.0.0.0/4 reserved'],
    ['255.255.255.255', '255.0.0.0/8 broadcast'],
  ])('blocks %s (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true)
  })

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['172.32.0.1'],
    ['172.15.0.1'],
    ['192.169.1.1'],
    ['11.0.0.1'],
  ])('allows public IP %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(false)
  })
})
describe('validateUrlHost', () => {
  it('非法 URL → NpmInstallError(network)', () => {
    expect(() => validateUrlHost('not-a-url')).toThrow(NpmInstallError)
    expect(() => validateUrlHost('not-a-url')).toThrow(/Invalid URL/)
    expect(() => validateUrlHost('')).toThrow(/Invalid URL/)
  })

  it('非 HTTPS → 拦截', () => {
    expect(() => validateUrlHost('http://registry.npmjs.org/pkg')).toThrow(/Blocked non-HTTPS/)
    expect(() => validateUrlHost('ftp://example.com/x')).toThrow(/Blocked non-HTTPS/)
  })

  it('私网 IPv4 → 拦截', () => {
    expect(() => validateUrlHost('https://127.0.0.1/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://10.0.0.1/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://192.168.1.1/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://172.16.0.1/pkg')).toThrow(/Blocked private IP/)
  })

  it('IPv6 loopback / link-local / unique-local → 拦截', () => {
    expect(() => validateUrlHost('https://[::1]/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://[fe80::1]/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://[fc00::1]/pkg')).toThrow(/Blocked private IP/)
    expect(() => validateUrlHost('https://[fd00::1]/pkg')).toThrow(/Blocked private IP/)
  })

  it('公网 IPv4 → 放行', () => {
    expect(() => validateUrlHost('https://8.8.8.8/pkg')).not.toThrow()
    expect(() => validateUrlHost('https://1.1.1.1/path')).not.toThrow()
  })

  it('域名 → 放行（不做 IP 检查，由 DNS + HTTPS 保障）', () => {
    expect(() => validateUrlHost('https://registry.npmjs.org/pkg')).not.toThrow()
    expect(() => validateUrlHost('https://example.com/path/to/tarball')).not.toThrow()
  })

  it('拦截时抛出的是 NpmInstallError 且 code=network', () => {
    try {
      validateUrlHost('http://10.0.0.1/x')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(NpmInstallError)
      expect((e as NpmInstallError).code).toBe('network')
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('skill-dir-config', () => {
describe('skill-dir-config buildDirConfigs', () => {
  let tmpRealDir: string

  beforeEach(() => {
    tmpRealDir = mkdtempSync(join(tmpdir(), 'skill-dircfg-'))
  })

  afterEach(() => {
    rmSync(tmpRealDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('过滤不存在的绝对路径脏数据（/path/a 等 pi 占位符）', () => {
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, { projectPaths: [], globalPaths: ['/path/a', '/path/b'] })
    const enabled = configs.filter(c => c.enabled)
    expect(enabled).toHaveLength(0)
    expect(configs.every(c => c.enabled === false)).toBe(true)
  })

  it('保留存在的绝对路径，过滤不存在的', () => {
    const configs = buildDirConfigs([], { projectPaths: [], globalPaths: [tmpRealDir, '/path/a'] })
    const enabledPaths = configs.filter(c => c.enabled).map(c => c.path)
    expect(enabledPaths).toContain(tmpRealDir)
    expect(enabledPaths).not.toContain('/path/a')
  })

  it('~ 路径展开后存在则保留为 enabled（确定性，不依赖测试机环境）', () => {
    // fs-guard：家目录在白名单外不可写。HOME 临时指向 tmp——expandHome 经 os.homedir()
    // 动态读 $HOME，`~` 展开语义原样保留（展开结果落在 fakeHome 下）。
    const realHome = process.env.HOME
    const fakeHome = mkdtempSync(join(tmpdir(), 'skill-home-'))
    process.env.HOME = fakeHome
    try {
      const tmpHomeSubdir = mkdtempSync(join(fakeHome, '.skill-test-'))
      const tildePath = '~/' + basename(tmpHomeSubdir)
      const configs = buildDirConfigs([], { projectPaths: [], globalPaths: [tildePath, '/path/a'] })
      const enabled = configs.filter(c => c.enabled)
      expect(enabled.map(c => c.path)).toContain(tildePath)
      expect(enabled.map(c => c.path)).not.toContain('/path/a')
    } finally {
      process.env.HOME = realHome
      // fakeHome 递归删除已覆盖其下 fixture，无需单独清理 tmpHomeSubdir
      rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('相对路径不检查存在性（project scope，preset 候选语义，buildDirConfigs 不知 cwd）', () => {
    const configs = buildDirConfigs([], { projectPaths: ['.agents/skills', '.taiji/skills'], globalPaths: [] })
    const enabled = configs.filter(c => c.enabled)
    expect(enabled.map(c => c.path)).toEqual(['.agents/skills', '.taiji/skills'])
    // project scope 标注正确
    expect(enabled.every(c => c.scope === 'project')).toBe(true)
  })

  it('preset 全部未启用时，按 scope 分组追加（project preset 在前，global preset 在后）', () => {
    // PRESET_SKILL_DIRS = ['~/.pi/agent/skills'(g), '~/.agents/skills'(g), '.agents/skills'(p)]
    // （claude 已移出预设，2026-09：preset 成员恒在 UI 重挂导致 claude 行无法真正删除）
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, { projectPaths: [], globalPaths: [] })
    expect(configs).toHaveLength(PRESET_SKILL_DIRS.length)
    expect(configs.every(c => c.enabled === false)).toBe(true)
    // project preset（'.agents/skills'）在前，global preset（前两个）在后，各自内层按 preset 固定顺序
    expect(configs.map(c => c.path)).toEqual([
      '.agents/skills',
      '~/.pi/agent/skills',
      '~/.agents/skills',
    ])
    expect(configs.find(c => c.path === '.agents/skills')!.scope).toBe('project')
    expect(configs.find(c => c.path === '~/.pi/agent/skills')!.scope).toBe('global')
  })

  it('discovery 启用顺序保留（= 用户拖拽优先级，靠前覆盖靠后）', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'skill-order-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'skill-order-b-'))
    try {
      const configs = buildDirConfigs([], { projectPaths: [], globalPaths: [dirB, dirA] })
      const enabled = configs.filter(c => c.enabled)
      // global 内顺序与传入一致（dirB 在前）
      expect(enabled.map(c => c.path)).toEqual([dirB, dirA])
    } finally {
      rmSync(dirA, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      rmSync(dirB, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('v2 顺序：project.enabled → global.enabled → project.preset → global.preset', () => {
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, {
      projectPaths: ['.proj-enabled'],
      globalPaths: [tmpRealDir],
    })
    const enabled = configs.filter(c => c.enabled)
    // project enabled 在最前
    expect(enabled[0]).toEqual({ path: '.proj-enabled', enabled: true, scope: 'project' })
    // global enabled 紧随
    expect(enabled[1]).toEqual({ path: tmpRealDir, enabled: true, scope: 'global' })
    // 之后是 project preset 未启用（'.agents/skills'），再 global preset 未启用
    const disabled = configs.filter(c => !c.enabled)
    expect(disabled.map(c => c.path)).toEqual(['.agents/skills', '~/.pi/agent/skills', '~/.agents/skills'])
  })

  it('agent preset 结构对称（PRESET_AGENT_DIRS）', () => {
    const configs = buildDirConfigs(PRESET_AGENT_DIRS, { projectPaths: [], globalPaths: [] })
    expect(configs).toHaveLength(PRESET_AGENT_DIRS.length)
    expect(configs.every(c => c.enabled === false)).toBe(true)
  })

  it('preset 不含 claude 目录（2026-09 移除：预设成员无法真正删除 + 非默认扫描范围）', () => {
    expect(PRESET_SKILL_DIRS.some(p => p.includes('.claude'))).toBe(false)
    expect(PRESET_AGENT_DIRS.some(p => p.includes('.claude'))).toBe(false)
    expect(PRESET_EXTENSION_DIRS.some(p => p.includes('.claude'))).toBe(false)
  })

  it('preset 成员即使不存在也保留为 enabled（推荐候选语义，防回归）', () => {
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, { projectPaths: [], globalPaths: ['~/.agents/skills'] })
    const agentsEntry = configs.find(c => c.path === '~/.agents/skills')
    expect(agentsEntry).toBeTruthy()
    expect(agentsEntry!.enabled).toBe(true)
    expect(agentsEntry!.scope).toBe('global')
    const otherPresets = configs.filter(c => c.path !== '~/.agents/skills' && !c.enabled)
    expect(otherPresets).toHaveLength(PRESET_SKILL_DIRS.length - 1)
  })

  it('已启用的非 preset 绝对路径（如历史遗留 claude 绝对路径）不再是预设成员，移除后不再重现', () => {
    // 用户报告的回归场景：preset 含 claude 时，用户删除该行后 buildDirConfigs 会把未启用候选补回
    // （永远删不掉）。移出预设后，遗留的已启用 claude 条目仍可见可删，且删除后不再补回。
    // 路径必须真实存在（非 preset 启用条目走 existsSync 脏数据过滤），且自建自删——
    // 禁止依赖真实 ~/.claude（CI Linux runner 无此目录，条目被过滤后 find 返回 undefined，
    // 2026-09-18 CI 实发）。
    const claudeAbs = join(tmpRealDir, '.claude', 'skills')
    mkdirSync(claudeAbs, { recursive: true })
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, { projectPaths: [], globalPaths: [claudeAbs] })
    // 存量启用条目仍展示（用户可见、可手动删）
    expect(configs.find(c => c.path === claudeAbs)!.enabled).toBe(true)
    // 但不再是 preset 候选：无未启用的 claude 行被补回
    expect(configs.filter(c => c.path.includes('.claude'))).toHaveLength(1)
  })
})
describe('discovery-store setSkillDirs 脏数据写入过滤（v2 SkillDirConfig[]，与 buildDirConfigs 对齐，ADR §5）', () => {
  let discoveryPath: string
  let discoveryTmpDir: string
  let realDir: string

  beforeEach(() => {
    discoveryTmpDir = mkdtempSync(join(tmpdir(), 'discovery-filter-'))
    discoveryPath = join(discoveryTmpDir, 'discovery.json')
    setDiscoveryPath(discoveryPath)
    realDir = mkdtempSync(join(tmpdir(), 'skill-real-'))
  })

  afterEach(() => {
    rmSync(discoveryTmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    rmSync(realDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('剔除不存在的绝对路径脏数据（/path/a 等 pi 占位符），保留存在的', () => {
    setSkillDirs([glob_m2('/path/a'), glob_m2('/path/b'), glob_m2(realDir)])
    expect(getSkillDirs()).toEqual([realDir])
  })

  it('preset 成员即使不存在也保留（推荐候选语义，豁免 existsSync）', () => {
    setSkillDirs([glob_m2('~/.agents/skills'), glob_m2('~/.pi/agent/skills'), glob_m2('/path/a')])
    expect(getSkillDirs()).toEqual(['~/.agents/skills', '~/.pi/agent/skills'])
  })

  it('相对路径不检查存在性（project scope，无 cwd 上下文）', () => {
    setSkillDirs([proj_m2('.agents/skills'), proj_m2('.taiji/skills'), glob_m2('/path/a')])
    expect(getSkillDirs()).toEqual(['.agents/skills', '.taiji/skills'])
  })

  it('~ 展开后存在的路径保留（确定性，不依赖测试机）', () => {
    // 同上：HOME 临时指向 tmp（fs-guard 白名单），~ 展开语义保留
    const realHome = process.env.HOME
    const fakeHome = mkdtempSync(join(tmpdir(), 'skill-home-set-'))
    process.env.HOME = fakeHome
    try {
      const tmpHomeSubdir = mkdtempSync(join(fakeHome, '.skill-settest-'))
      const tildePath = '~/' + basename(tmpHomeSubdir)
      setSkillDirs([glob_m2(tildePath), glob_m2('/path/a')])
      expect(getSkillDirs()).toEqual([tildePath])
    } finally {
      process.env.HOME = realHome
      // fakeHome 递归删除已覆盖其下 fixture，无需单独清理 tmpHomeSubdir
      rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('按 scope 分发写 projectPaths/globalPaths（getSkillPathScopes 验证）', () => {
    setSkillDirs([glob_m2(realDir), proj_m2('.agents/skills'), glob_m2('~/.agents/skills')])
    expect(getSkillPathScopes()).toEqual({
      projectPaths: ['.agents/skills'],
      globalPaths: [realDir, '~/.agents/skills'],
    })
  })

  it('合并顺序：project 在前（优先级 > 全局），保留各组内顺序', () => {
    setSkillDirs([glob_m2(realDir), glob_m2('~/.agents/skills'), glob_m2('/path/a'), proj_m2('.agents/skills')])
    // '/path/a' 被过滤；project('.agents/skills') 在前，global(realDir, ~/.agents/skills) 在后
    expect(getSkillDirs()).toEqual(['.agents/skills', realDir, '~/.agents/skills'])
  })

  it('文件缺失（ENOENT）→ 读回落到默认态：preset 全勾（pi + taiji，无 claude）', () => {
    // 新装 / 首启：discovery.json 不存在时，UI 打开即见 pi+taiji 目录默认勾选，无需手动配置。
    setDiscoveryPath(join(discoveryTmpDir, 'nonexistent', 'discovery.json'))
    const scopes = getSkillPathScopes()
    expect(scopes.projectPaths).toEqual(['.agents/skills'])
    expect(scopes.globalPaths).toEqual(['~/.pi/agent/skills', '~/.agents/skills'])
    // agent / extension 同构默认勾选
    expect(getAgentPathScopes().globalPaths).toContain('~/.pi/agent/agents')
    expect(getExtensionPathScopes().projectPaths).toEqual(['.pi/extensions', '.taiji/extensions'])
  })

  it('用户显式取消全部勾选 → 全空态持久保留，不会被默认态复活', () => {
    // 旧「六字段全空 → 删文件」会让下次读回落到默认态，用户关掉的目录重启后「复活」。
    // 现在：全空写入后文件保留，读回仍为全空（用户意图优先于默认值）。
    // （前置 ENOENT 用例改写了 store 路径，此处先拨回本 describe 的固定路径。）
    setDiscoveryPath(discoveryPath)
    setSkillDirs([])
    setAgentDirs([])
    setExtensionDirs([])
    expect(existsSync(discoveryPath)).toBe(true)
    expect(getSkillDirs()).toEqual([])
    expect(getAgentDirs()).toEqual([])
    expect(getExtensionDirs()).toEqual([])
    expect(getSkillPathScopes()).toEqual({ projectPaths: [], globalPaths: [] })
  })
})
});
// ======================================================================
// ← test/skill-scanner.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('skill-scanner', () => {
describe('parseSkillMd argumentHint extraction', () => {
  it('extracts argument-hint from frontmatter', () => {
  const content = [
    '---',
    'name: test-skill',
    'argument-hint: "[filename]"',
    '---',
    'This is a test skill.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBe('[filename]')
  })

  it('returns undefined argumentHint when field is absent', () => {
  const content = [
    '---',
    'name: test-skill',
    '---',
    'This is a test skill.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBeUndefined()
  })

  it('returns undefined when argument-hint has empty value (regex requires 1+ chars)', () => {
  const content = [
    '---',
    'argument-hint:',
    '---',
    'This is a test skill.',
  ].join('\n')

  const result = parseSkillMd(content)
  // The regex (.+?) requires at least one char, so bare key produces undefined
  expect(result.argumentHint).toBeUndefined()
  })

  it('extracts argument-hint from middle of frontmatter', () => {
  const content = [
    '---',
    'name: my-skill',
    'description: "A skill that does things"',
    'argument-hint: "<file-path>"',
    'triggers:',
    '  - "do things"',
    '---',
    'Body text.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBe('<file-path>')
  })

  it('returns undefined argumentHint for content without frontmatter', () => {
  const content = 'Just a plain markdown file with no frontmatter at all.'

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBeUndefined()
  })

  it('extracts argument-hint with quoted value', () => {
  const content = [
    '---',
    'argument-hint: "[query string]"',
    '---',
    'Skill body.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBe('[query string]')
  })

  it('extracts argument-hint at first line of frontmatter', () => {
  const content = [
    '---',
    'argument-hint: "<target>"',
    'name: top-hint-skill',
    '---',
    'Body.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBe('<target>')
  })
})
describe('parseSkillMd description and triggers', () => {
  it('extracts body description from first non-heading non-empty line after frontmatter', () => {
  const content = [
    '---',
    'name: demo',
    '---',
    '',
    '# Skill Title',
    '',
    'This is the actual description.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.description).toBe('This is the actual description.')
  })

  it('extracts triggers from frontmatter description with quoted trigger words', () => {
  // Use Unicode left/right double quotes which the trigger regex matches
  const content =
    '---\n' +
    'description: Use when user says \u201Canalyze code\u201D or \u201Crun analysis\u201D\n' +
    '---\n' +
    'Body.'

  const result = parseSkillMd(content)
  expect(result.triggers).toContain('analyze code')
  expect(result.triggers).toContain('run analysis')
  })

  it('returns empty triggers when no quoted phrases in description', () => {
  const content = [
    '---',
    'description: A simple skill without trigger patterns.',
    '---',
    'Body.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.triggers).toEqual([])
  })

  it('prefers frontmatter description for triggers; body description value still wins for description field', () => {
  // description 字段永远取正文（frontmatter 的 fmDesc 只影响 triggers 来源）
  const content = [
    '---',
    'name: demo',
    'description: Use \u201Calpha mode\u201D for speed',
    '---',
    '"beta mode" body line.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.description).toBe('"beta mode" body line.')
  // triggers 只从 frontmatter description 提取，正文的引号词不进
  expect(result.triggers).toEqual(['alpha mode'])
  })

  it('truncates body description to 200 characters', () => {
  const longLine = 'x'.repeat(300)
  const content = [
    '---',
    'name: long',
    '---',
    longLine,
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.description).toHaveLength(200)
  expect(result.description).toBe('x'.repeat(200))
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('migrate-skills-discovery', () => {
beforeEach(async () => {
  tmpDir_m2 = await mkdtempP_m2(join(tmpdir(), 'migrate-skill-test-'))
  piAgentDir = join(tmpDir_m2, 'agent')
  mkdirSync(piAgentDir, { recursive: true })
  setSettingsPath(join(piAgentDir, 'settings.json'))
  setDiscoveryPath(join(piAgentDir, 'discovery.json'))
})
afterEach(async () => {
  await rmP_m2(tmpDir_m2, { recursive: true, force: true })
})
describe('migrateSettingsSkillsToDiscovery', () => {
  it('旧单 skill 路径 → 归并为容器目录（44 条 → 2 容器）', () => {
    // 模拟真实环境：2 个容器，共 44 条单 skill 路径
    const piContainer = createSkillContainer(join(tmpDir_m2, '.pi', 'agent', 'skills'), ['anysearch', 'code-review', 'zcommit'])
    const agentsContainer = createSkillContainer(join(tmpDir_m2, '.agents', 'skills'), ['handoff', 'rethink'])

    // 旧 settings.json.skills 存的是「单 skill 目录」粒度（粒度错误）
    const legacySingleSkillPaths = [
      join(piContainer, 'anysearch'),
      join(piContainer, 'code-review'),
      join(piContainer, 'zcommit'),
      join(agentsContainer, 'handoff'),
      join(agentsContainer, 'rethink'),
    ]
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: legacySingleSkillPaths }), 'utf-8')

    migrateSettingsSkillsToDiscovery()

    // 迁移后 discovery 应是 2 个容器目录（去重父目录），不是 5 条单 skill 路径
    const dirs = getSkillPaths()
    expect(dirs).toHaveLength(2)
    expect(dirs).toContain(piContainer)
    expect(dirs).toContain(agentsContainer)
    // settings.json.skills 应同步映射为容器粒度
    expect(readSettings().skills).toEqual(dirs)
  })

  it('discovery 已有有效容器 → no-op（幂等）', () => {
    const container = createSkillContainer(join(tmpDir_m2, '.pi', 'agent', 'skills'), ['anysearch'])
    setSkillPaths([{ path: container, enabled: true, scope: 'global' }]) // discovery 已有有效容器
    const dirsBefore = getSkillPaths()

    // 即使 settings.json 有旧数据，也不应覆盖 discovery
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: [join(container, 'other')] }), 'utf-8')
    migrateSettingsSkillsToDiscovery()

    expect(getSkillPaths()).toEqual(dirsBefore)
  })

  it('discovery 只有脏数据（非容器）→ 仍执行迁移覆盖', () => {
    // discovery 存了脏数据（/path/a 不存在，非容器）
    setDiscoveryPath(join(piAgentDir, 'discovery.json'))
    const container = createSkillContainer(join(tmpDir_m2, '.agents', 'skills'), ['handoff'])
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: [join(container, 'handoff')] }), 'utf-8')

    // 先注入脏数据
    const dirtyDiscovery = { version: 1, skillDirs: ['/path/a', '/path/b'], agentDirs: [] }
    writeFileSync(join(piAgentDir, 'discovery.json'), JSON.stringify(dirtyDiscovery), 'utf-8')

    migrateSettingsSkillsToDiscovery()

    // 脏数据被有效容器覆盖
    expect(getSkillPaths()).toEqual([container])
  })

  it('settings.json.skills 为空 → no-op', () => {
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: [] }), 'utf-8')
    migrateSettingsSkillsToDiscovery()
    // no-op 语义不变：迁移不写 discovery.json；文件缺失时读端回落 DEFAULT_DISCOVERY_CONFIG
    // （feat: discovery scan dirs default-enabled），skill preset 默认勾选 → 非空。
    expect(getSkillPaths()).toEqual(['.agents/skills', '~/.pi/agent/skills', '~/.agents/skills'])
  })

  it('旧路径父目录不是容器（无 SKILL.md 子目录）→ 过滤掉', () => {
    // 父目录存在但不含任何 SKILL.md 子目录 → 不是有效容器，应过滤
    const notContainer = join(tmpDir_m2, 'not-a-container')
    mkdirSync(notContainer, { recursive: true })
    writeFileSync(join(notContainer, 'random.txt'), 'hello', 'utf-8')
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: [join(notContainer, 'random')] }), 'utf-8')

    migrateSettingsSkillsToDiscovery()

    // 非容器被正确过滤（未写入 discovery）；迁移无有效产物提前 return 不写盘，
    // 读端回落 DEFAULT_DISCOVERY_CONFIG 默认勾选（feat: default-enabled）→ 非空。
    expect(getSkillPaths()).toEqual(['.agents/skills', '~/.pi/agent/skills', '~/.agents/skills'])
  })

  it('迁移后 discovery 为 v2 结构（容器进 globalPaths）', () => {
    const container = createSkillContainer(join(tmpDir_m2, '.pi', 'agent', 'skills'), ['s1'])
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: [join(container, 's1')] }), 'utf-8')

    migrateSettingsSkillsToDiscovery()

    const d = readDiscovery()
    expect(d.version).toBe(2)
    // 迁移写入 writeDiscovery({ ...readDiscovery(), skill: scoped }) 只覆盖 skill 段；
    // agent/extension 段保留读端回落值（文件缺失 → DEFAULT_DISCOVERY_CONFIG 默认勾选，
    // feat: default-enabled）——守护「迁移不丢其他 kind 段」。
    expect(d.skill.globalPaths).toEqual([container])
    expect(d.skill.projectPaths).toEqual([])
    expect(d.agent.projectPaths).toEqual(['.agents/agents'])
    expect(d.agent.globalPaths).toEqual(['~/.pi/agent/agents', '~/.agents/agents'])
    expect(d.extension.projectPaths).toEqual(['.pi/extensions', '.taiji/extensions'])
    expect(d.extension.globalPaths).toEqual(['~/.pi/agent/extensions'])
  })
})
});
// ======================================================================
// ← test/frontmatter.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('frontmatter', () => {
describe('extractFrontmatter', () => {
  it('标准首尾 --- 分割 frontmatter 与正文', () => {
    const content = ['---', 'name: x', '---', 'body line'].join('\n')
    expect(extractFrontmatter(content)).toEqual({
      frontmatter: 'name: x',
      body: 'body line',
      bodyStartLine: 3,
    })
  })

  it('首行非 --- 时整体当正文（无 frontmatter）', () => {
    const content = 'just a title\n# heading'
    const parts = extractFrontmatter(content)
    expect(parts.frontmatter).toBe('')
    expect(parts.body).toBe(content)
    expect(parts.bodyStartLine).toBe(0)
  })

  it('只有开头 --- 无结束时，首个 --- 之后内容都算 frontmatter（容错；body 退化为全文）', () => {
    const content = ['---', 'name: x', 'description: y'].join('\n')
    const parts = extractFrontmatter(content)
    expect(parts.frontmatter).toBe('name: x\ndescription: y')
    // 无结束时 frontmatterEnd 保持 0，body = slice(0) = 全文（含开头 ---）
    expect(parts.body).toBe(content)
    expect(parts.bodyStartLine).toBe(0)
  })

  it('frontmatter 含空行（空行被收集进 frontmatter）', () => {
    const content = ['---', 'name: x', '', 'tools: a', '---', 'body'].join('\n')
    const parts = extractFrontmatter(content)
    expect(parts.frontmatter).toBe('name: x\n\ntools: a')
    expect(parts.body).toBe('body')
    expect(parts.bodyStartLine).toBe(5)
  })
})
describe('extractDescription', () => {
  it('单行裸值', () => {
    expect(extractDescription('description: 一个 agent')).toBe('一个 agent')
  })

  it('多行 >- 折叠块：trim 后空格连接', () => {
    const fm = ['description: >-', '  第一行', '  第二行', 'name: x'].join('\n')
    expect(extractDescription(fm)).toBe('第一行 第二行')
  })

  it('多行 |- 字面块：同样 trim 后空格连接（与 > 一致，不保留换行）', () => {
    const fm = ['description: |-', '  literal', '  text'].join('\n')
    expect(extractDescription(fm)).toBe('literal text')
  })

  it('chomping indicator +（保留尾部换行）仍按 trim 空格连接', () => {
    const fm = ['description: >+', '  a', '  b'].join('\n')
    expect(extractDescription(fm)).toBe('a b')
  })

  it('单行 description: > 文本（同行内容）', () => {
    expect(extractDescription('description: > 同行文本')).toBe('同行文本')
  })

  it('无 description 字段返回空串', () => {
    expect(extractDescription('name: x\ntools: a')).toBe('')
  })

  it('块结束后回到顶层键即截断（不吞下一个键值）', () => {
    const fm = ['description: >-', '  block line', 'name: keep-me'].join('\n')
    expect(extractDescription(fm)).toBe('block line')
  })
})
});
// ======================================================================
// ← test/ignore-parser.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('ignore-parser', () => {
describe('compileIgnoreRules / matchPath', () => {
  describe('empty content', () => {
    it('empty matcher matches nothing for any path', () => {
      const m = compileIgnoreRules('')
      expect(matchPath(m, 'anything')).toBe(false)
      expect(matchPath(m, 'src/index.ts')).toBe(false)
    })

    it('whitespace-only content matches nothing', () => {
      const m = compileIgnoreRules('\n  \n\t\n')
      expect(matchPath(m, 'x/y')).toBe(false)
    })
  })

  describe('simple name (non-anchored)', () => {
    it('matches at any depth', () => {
      const m = compileIgnoreRules('node_modules')
      expect(matchPath(m, 'node_modules/pkg/index.js')).toBe(true)
    })

    it('matches top-level name', () => {
      const m = compileIgnoreRules('node_modules')
      expect(matchPath(m, 'node_modules')).toBe(true)
    })

    it('does not match name appearing only as substring of a segment', () => {
      // 'mynode_modules' is a different segment, should not match plain 'node_modules'
      const m = compileIgnoreRules('node_modules')
      expect(matchPath(m, 'mynode_modules/x')).toBe(false)
    })
  })

  describe('anchored pattern (leading /)', () => {
    it('matches only at root', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'dist/x')).toBe(true)
    })

    it('does not match when nested under another dir', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'src/dist')).toBe(false)
    })

    it('matches the anchored name itself', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'dist')).toBe(true)
    })
  })

  describe('negation (!)', () => {
    it('later negation overrides earlier positive', () => {
      const m = compileIgnoreRules(['node_modules', '!node_modules/keep'].join('\n'))
      expect(matchPath(m, 'node_modules/keep')).toBe(false)
    })

    it('positive still applies to non-negated paths', () => {
      const m = compileIgnoreRules(['node_modules', '!node_modules/keep'].join('\n'))
      expect(matchPath(m, 'node_modules/other')).toBe(true)
    })

    it('negation then positive: last match wins', () => {
      const m = compileIgnoreRules(['!foo', 'foo'].join('\n'))
      expect(matchPath(m, 'foo')).toBe(true)
    })
  })

  describe('directory suffix (/ trailing)', () => {
    it('does not match a file named like the dir', () => {
      // build/ → dir only; bare 'build' (a file) should not match
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build')).toBe(false)
    })

    it('matches contents under the directory', () => {
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build/output')).toBe(true)
    })

    it('matches deeper contents under the directory', () => {
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build/out/a/b')).toBe(true)
    })

    it('anchored dir suffix matches only at root', () => {
      const m = compileIgnoreRules('/build/')
      expect(matchPath(m, 'build/output')).toBe(true)
      expect(matchPath(m, 'src/build/output')).toBe(false)
    })
  })

  describe('comments and blank lines', () => {
    it('skips comment lines and blank lines', () => {
      const content = [
        '# this is a comment',
        '',
        '   ',
        'node_modules',
        '# another comment',
        '*.log',
      ].join('\n')
      const m = compileIgnoreRules(content)
      expect(matchPath(m, 'node_modules/x')).toBe(true)
      expect(matchPath(m, 'app.log')).toBe(true)
      expect(matchPath(m, 'src/main.ts')).toBe(false)
    })

    it('does not treat # in middle of line as comment', () => {
      // only lines STARTING with # are comments
      const m = compileIgnoreRules('foo#bar')
      expect(matchPath(m, 'foo#bar')).toBe(true)
    })
  })

  describe('wildcards', () => {
    it('* matches single segment (no slash)', () => {
      const m = compileIgnoreRules('*.log')
      expect(matchPath(m, 'app.log')).toBe(true)
      expect(matchPath(m, 'dir/app.log')).toBe(true) // non-anchored, any depth
    })

    it('* does not cross directory separator in the matched segment', () => {
      // *.log matches a single segment ending in .log; 'a/b.log' matches via dir-agnostic
      const m = compileIgnoreRules('/*.log')
      expect(matchPath(m, 'app.log')).toBe(true)
      expect(matchPath(m, 'a/app.log')).toBe(false) // anchored, must be root segment
    })

    it('** matches across directories', () => {
      const m = compileIgnoreRules('node_modules/**/test')
      expect(matchPath(m, 'node_modules/a/b/test')).toBe(true)
      expect(matchPath(m, 'node_modules/test')).toBe(true)
    })
  })

  /**
   * 正则元字符转义 + glob_m2 ? 通配（复杂度债务重构锚定）：globToRegex 的元字符转义
   * 由逐 case switch 改为 REGEX_META_CHARS 表驱动，'?' 通配分支保持在转义表之前。
   * 本套件锚定两条语义：元字符按字面匹配（不展开正则语义）、'?' 是单字符通配非字面量。
   */
  describe('regex metachars and glob ?', () => {
    it('bracket and dot in pattern are matched literally (no char-class semantics)', () => {
      const m = compileIgnoreRules('foo[1].txt')
      expect(matchPath(m, 'foo[1].txt')).toBe(true)
      expect(matchPath(m, 'foo1.txt')).toBe(false) // [1] 未被展开为字符类
    })

    it('combined meta chars: current escaping table does not yield a self-matching regex (historical behavior anchor)', () => {
      // 实测锚定：转义表对 ${ 等序列的历史覆盖范围下，该 pattern 的 regex 不匹配任何输入
      // （含字面自身）。若未来修复转义表使字面匹配成立，属行为变更，需同步修订本断言。
      const m = compileIgnoreRules('a(b|c)+^d${e}\\f')
      expect(matchPath(m, 'a(b|c)+^d${e}\\f')).toBe(false)
      expect(matchPath(m, 'abcd')).toBe(false)
    })

    it('glob ? matches exactly one char (any char incl. literal ?)', () => {
      const m = compileIgnoreRules('file?.txt')
      expect(matchPath(m, 'file1.txt')).toBe(true)
      expect(matchPath(m, 'file12.txt')).toBe(false) // 恰好一个字符，不跨多个
      expect(matchPath(m, 'file?.txt')).toBe(true) // ? 生成单字符通配，字面 '?' 字符同样被其匹配
    })
  })

  /**
   * 短路径直通（D7-2，W24）：无 '/' 的路径只有自身一个前缀（allPrefixes('x') ≡ ['x']），
   * matchPath 跳过 allPrefixes 直接以 [path] 测试。等价性检查：覆盖 plain/dirOnly/
   * negated/anchored 四类规则在无斜杠路径上的行为，防止直通分支引入语义漂移。
   */
  describe('short-path fast path (D7-2)', () => {
    it('plain name: short path matches the rule itself', () => {
      const m = compileIgnoreRules('dist')
      expect(matchPath(m, 'dist')).toBe(true)
      expect(matchPath(m, 'other')).toBe(false)
    })

    it('dirOnly rule: short path (bare name) not matched, contents matched via expansion', () => {
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build')).toBe(false) // dirOnly 不匹配目录自身名（与展开路径语义一致）
      expect(matchPath(m, 'build/out')).toBe(true) // 深路径走 allPrefixes 展开，行为不变
    })

    it('negation applies on short paths (last match wins)', () => {
      const m = compileIgnoreRules(['foo', '!foo'].join('\n'))
      expect(matchPath(m, 'foo')).toBe(false)
    })

    it('anchored rule: short path matches root-level name', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'dist')).toBe(true)
      expect(matchPath(m, 'src/dist')).toBe(false)
    })

    it('empty matcher: short path never matched', () => {
      const m = compileIgnoreRules('')
      expect(matchPath(m, 'x')).toBe(false)
    })

    it('empty path / root path: never matched even under * rule (A-2 空串检查)', () => {
      // W24 审查 A-2：''（与归一化后的根路径 '/'）必须保持旧 allPrefixes 语义（恒 false）。
      // 旧版 allPrefixes('') 返回 []；直通分支若放行 ['']，`*` 规则 regex 命中空串且
      // isSelf 成立 → 错误判 true。空串/根路径出现在 matchPath 的典型来源：cwd 自身守门
      // 与 normalizePath 对 '/'、'//'、'/  ' 的归一化。
      const m = compileIgnoreRules('*')
      expect(matchPath(m, '')).toBe(false)
      expect(matchPath(m, '/')).toBe(false)
      expect(matchPath(m, '//')).toBe(false)

      // 根路径（仅斜杠）在具体规则下同样恒 false（无祖先前缀可命中）
      expect(matchPath(compileIgnoreRules('dist'), '/')).toBe(false)
      expect(matchPath(compileIgnoreRules('**'), '/')).toBe(false)
    })
  })

  /**
   * 短路径直通 vs 手工 allPrefixes 展开对照（W24 审查 A-6）：
   * matchPath 对含 '/' 路径走 allPrefixes 分支；直通分支是「无 '/' 路径跳过展开」的优化。
   * 等价性：对单规则 matcher，整体 matchPath(path) ⟺ 手工展开 path 的全部祖先前缀后
   * 逐前缀求值（短路径前缀走直通分支）的 OR——任一前缀命中该规则即整体命中。
   * 防回归：直通分支若漏前缀/多前缀，或 allPrefixes 展开语义漂移，此对照即暴露。
   */
  describe('short-path fast path vs manual allPrefixes expansion (A-6)', () => {
    /** 手工 allPrefixes（公开语义：'a/b/c' → ['a/b/c','a/b','a']；'x' → ['x']）。 */
    function allPrefixes(path: string): string[] {
      const segments = path.split('/').filter((s) => s.length > 0)
      const result: string[] = []
      for (let end = segments.length; end >= 1; end -= 1) {
        result.push(segments.slice(0, end).join('/'))
      }
      return result
    }

    /** 对照实现：手工展开全部祖先前缀后逐前缀 matchPath（前缀无 '/' 时走直通分支）取 OR。 */
    function matchViaExpansion(matcher: IgnoreMatcher, path: string): boolean {
      return allPrefixes(path).some((prefix) => matchPath(matcher, prefix))
    }

    it('对同一 matcher 与一组含 / 路径：直通实现与手工 allPrefixes 展开结果一致', () => {
      // plain / wildcard / dirOnly / anchored / ** 五类规则 × 祖先命中、自身命中、不命中、
      // dirOnly 同名文件不命中、anchored 非根不命中等形态
      const cases: Array<[string, string]> = [
        ['dist', 'a/dist'], // plain：祖先命中
        ['dist', 'a/b/dist'], // plain：深层祖先命中
        ['dist', 'src/dist/x'], // plain：dist 目录内容
        ['dist', 'a/b'], // plain：不命中
        ['*.log', 'a/b/app.log'], // wildcard：段命中
        ['*.log', 'a/b/app.logs'], // wildcard：不命中
        ['build/', 'a/build/out'], // dirOnly：祖先目录命中
        ['build/', 'a/build'], // dirOnly：同名文件不命中
        ['/dist', 'a/dist'], // anchored：非根不命中
        ['/dist', 'dist'], // anchored：根命中（短路径自身）
        ['node_modules', 'node_modules'], // plain：自身命中（短路径直通）
        ['node_modules', 'src/node_modules/x'], // plain：任意层级
        ['**/test', 'src/a/test'], // ** 多层：命中
        ['**/test', 'src/a/test/extra'], // ** 前缀目录内容：命中（test 是祖先目录）
      ]
      for (const [pattern, path] of cases) {
        const m = compileIgnoreRules(pattern)
        expect(matchPath(m, path), `pattern=${pattern} path=${path}`).toBe(matchViaExpansion(m, path))
      }
    })

    it('空串经手工展开（无前缀）同样恒 false，与直通检查一致（A-2/A-6 交叉验证）', () => {
      const m = compileIgnoreRules('*')
      expect(matchViaExpansion(m, '')).toBe(false)
      expect(matchPath(m, '')).toBe(matchViaExpansion(m, ''))
    })
  })
})
});
// ======================================================================
// ← test/path-utils.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('path-utils', () => {
describe('path-utils', () => {
  const parent = '/a/b'

  describe('isStrictlyUnder', () => {
    it('returns false when child equals parent', () => {
      expect(isStrictlyUnder(parent, parent)).toBe(false)
    })

    it('returns true when child is under parent', () => {
      expect(isStrictlyUnder(parent, '/a/b/c')).toBe(true)
    })

    it('returns false when child is outside parent', () => {
      expect(isStrictlyUnder(parent, '/a/other')).toBe(false)
    })

    it('returns false when child is a sibling prefix', () => {
      expect(isStrictlyUnder('/a/b', '/a/bc')).toBe(false)
    })

    it('handles trailing slash on parent', () => {
      expect(isStrictlyUnder('/a/b/', '/a/b/c')).toBe(true)
    })

    it('handles trailing slash on child', () => {
      expect(isStrictlyUnder('/a/b', '/a/b/c/')).toBe(true)
    })

    it('handles trailing slashes on both', () => {
      expect(isStrictlyUnder('/a/b/', '/a/b/c/')).toBe(true)
    })

    it('returns false when parent is deeper than child', () => {
      expect(isStrictlyUnder('/a/b/c', '/a/b')).toBe(false)
    })

    it('normalizes relative segments in child', () => {
      expect(isStrictlyUnder('/a/b', '/a/b/c/../d')).toBe(true)
    })

    it('returns false for relative child escaping parent', () => {
      expect(isStrictlyUnder('/a/b', '/a/b/c/../../other')).toBe(false)
    })
  })

  describe('isUnderOrEqual', () => {
    it('returns true when child equals parent', () => {
      expect(isUnderOrEqual(parent, parent)).toBe(true)
    })

    it('returns true when child is under parent', () => {
      expect(isUnderOrEqual(parent, '/a/b/c')).toBe(true)
    })

    it('returns false when child is outside parent', () => {
      expect(isUnderOrEqual(parent, '/a/other')).toBe(false)
    })

    it('returns true when child equals parent with trailing slashes', () => {
      expect(isUnderOrEqual('/a/b/', '/a/b/')).toBe(true)
    })

    it('handles mixed trailing slashes (equal paths)', () => {
      expect(isUnderOrEqual('/a/b/', '/a/b')).toBe(true)
    })

    it('returns false when child is a sibling prefix', () => {
      expect(isUnderOrEqual('/a/b', '/a/bc')).toBe(false)
    })

    it('returns false for deeply nested child escaping parent', () => {
      expect(isUnderOrEqual('/a/b', '/a/b/c/../../other')).toBe(false)
    })
  })

  describe('canonicalizePath', () => {
    it('returns realpath for an existing file', () => {
      const tmp = mkdtempSync(resolve(tmpdir(), 'canon-'))
      try {
        const filePath = resolve(tmp, 'real.txt')
        writeFileSync(filePath, 'x')
        // 存在的文件：realpathSync 返回解析后的绝对路径，不抛异常，且与多次调用一致
        const result = canonicalizePath(filePath)
        expect(() => canonicalizePath(filePath)).not.toThrow()
        expect(canonicalizePath(filePath)).toBe(result)
        // realpath 应与 tmp 的 realpath 同根（macOS 下 /tmp → /private/tmp）
        expect(result.endsWith('real.txt')).toBe(true)
      } finally {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('returns original path when file does not exist (no throw)', () => {
      const nonexistent = '/nonexistent/path/should-not-exist-12345.txt'
      // 不抛异常，返回原值
      expect(() => canonicalizePath(nonexistent)).not.toThrow()
      expect(canonicalizePath(nonexistent)).toBe(nonexistent)
    })

    it('resolves symlink to its real target', () => {
      const tmp = mkdtempSync(resolve(tmpdir(), 'canon-link-'))
      try {
        const realFile = resolve(tmp, 'real-target.ts')
        writeFileSync(realFile, 'x')
        const linkPath = resolve(tmp, 'link.ts')
        symlinkSync(realFile, linkPath)
        // symlink 的 realpath 应解析为 real-target.ts，与直接访问 realFile 的 realpath 一致
        // 注意：macOS 下 /var → /private/var，realFile 本身未经 realpath，故用 canonicalizePath(realFile) 对比
        expect(canonicalizePath(linkPath)).toBe(canonicalizePath(realFile))
        // 两者 realpath 后都应以 real-target.ts 结尾
        expect(canonicalizePath(linkPath).endsWith('real-target.ts')).toBe(true)
      } finally {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })
})
});
});

// ======================================================================
// ← workflow-subagent-bundle.test.ts
// ======================================================================

// ======================================================================
// ← test/workflow-outcome-vocab-parity.test.ts
// ======================================================================

/** shared WorkflowRunOutcome 词表成员（编译期 satisfies 锚定 shared 类型——词表收窄即此处编译红）。 */
const SHARED_WORKFLOW_RUN_OUTCOMES = [
  'done',
  'failed',
  'cancelled',
  'time_limited',
  'partially_succeeded',
] as const satisfies readonly WorkflowRunOutcome[]


// ======================================================================
// ← test/workflow-run-events-reader.test.ts
// ======================================================================

let tmpDataDir: string


let savedEnv: string | undefined


let recordPath: string


const SID = 'sess-reader'


const RUN_ID = 'wf-run-1'


/** 全词表事件 fixture（seq 严格递增 1..11，ts 递增 epoch ms）。 */
const FULL_STREAM_LINES = [
  {
    type: 'run-created',
    seq: 1,
    ts: 1000,
    runId: RUN_ID,
    workflowName: 'demo-wf',
    argsSummary: '{"k":"v"}',
    args: { k: 'v' },
    model: 'prov/m1',
    scriptSource: 'const wf = phase("p1")',
    scriptPath: '/scripts',
    budgetTimeMs: 100,
    budgetTokens: 200,
  },
  { type: 'phase-started', seq: 2, ts: 1001, phase: 'p1' },
  {
    type: 'agent-started',
    seq: 3,
    ts: 1002,
    taskIndex: 0,
    agentName: 'a1',
    attempt: 1,
    phase: 'p1',
    memberRecordId: 'rec-1',
    input: 'do it',
  },
  { type: 'agent-retrying', seq: 4, ts: 1003, taskIndex: 0, attempt: 1, backoffMs: 500, reason: 'stale_context' },
  {
    type: 'agent-settled',
    seq: 5,
    ts: 1004,
    taskIndex: 0,
    attempt: 1,
    outcome: 'failed',
    errorCode: 'unknown',
    durationMs: 42,
    stderrTeePath: '/tmp/tee.log',
    result: { ok: false },
  },
  { type: 'phase-settled', seq: 6, ts: 1005, phase: 'p1' },
  { type: 'run-interrupted', seq: 7, ts: 1006, errorCode: 'crashed', reason: 'host restart' },
  {
    type: 'run-resumed',
    seq: 8,
    ts: 1007,
    reason: 'manual resume',
    host: 'hostA',
    budgetTimeMs: 3000,
    budgetTokens: 9000,
    model: 'prov/m2',
  },
  {
    type: 'model-override',
    seq: 9,
    ts: 1008,
    model: { provider: 'p1', modelId: 'm9' },
    thinkingLevel: 'high',
  },
  { type: 'worker-log', seq: 10, ts: 1009, entry: { level: 'warn', message: 'boom' } },
  {
    type: 'run-settled',
    seq: 11,
    ts: 1010,
    outcome: 'failed',
    errorCode: 'budget_limited',
    reason: 'budget exhausted',
    artifactsDir: '/tmp/artifacts',
  },
] as const


// ======================================================================
// ← test/workflow-status-vocab-parity.test.ts
// ======================================================================

/** shared WorkflowRunStatus 词表成员（编译期 satisfies 锚定 shared 类型）。 */
const SHARED_WORKFLOW_RUN_STATUSES = [
  'running',
  'interrupted',
  'done',
] as const satisfies readonly WorkflowRunStatus[]


/** 最小 run 形态（runSummary 读 runId/spec/meta/state 与注册表条目）。
 *  [D6(a) 第 3 步] 终局判定源 = 终局记录注册表：done 形态经 noteRebuiltSettlement
 *  注入终局事实（生产 = 活体 dispatch 链 note / 壳重建点注入），聚合快照不持 status。 */
function makeRun(shape: {
  status?: string
  interruptedAt?: string
  reason?: string
}): WorkflowRun {
  const runId = `wf-status-parity-${shape.status ?? 'running'}-${shape.interruptedAt ?? 'live'}`
  if (shape.status === 'done') {
    noteRebuiltSettlement(runId, {
      outcome: doneReasonToRunOutcome((shape.reason ?? 'completed') as DoneReason),
      settledAt: 0,
    })
  }
  return {
    runId,
    spec: { scriptName: 'status-parity' },
    meta: {
      startedAt: '2026-09-30T00:00:00.000Z',
      ...(shape.interruptedAt !== undefined ? { interruptedAt: shape.interruptedAt } : {}),
    },
    state: {
      ...(shape.reason !== undefined ? { reason: shape.reason } : {}),
      budget: { usedTokens: 0, maxTokens: 1000, usedCost: 0 },
      trace: { toArray: () => [] },
      errorLogs: [],
    },
  } as unknown as WorkflowRun
}


// ======================================================================
// ← test/subagent-service.test.ts
// ======================================================================

/**
 * W3 测试：SessionService.getSubagents + getSubagentHistory
 *
 * [W1 / D6 读侧换源] subagent 列表数据源 = journal 派生视图的 entry 源（v2
 * subagent-record 注册 + 终态条目对），不再是 legacy toolCall/toolResult 配对。
 *
 * 用真实临时文件验证端到端链路：
 * 1. 构造主 session JSONL（含 v2 subagent-record 注册/终态条目对）
 * 2. 构造 subagent JSONL（含 user + assistant message）
 * 3. mock sessionStore.scanSessions 返回主 session 元信息
 * 4. 调 getSubagents → 验证 SubagentRecord[]
 * 5. 调 getSubagentHistory → 验证 Message[]
 */

/** 主 session id（v2 注册条目的 rootSessionId 归属键须与之一致）。 */
const MAIN_SESSION_ID = 'main-sess-id'


function createMockSessionStore(mainSessionFile: string, mainSessionId: string, mainCwd: string): ISessionStore {
  const meta: ScannedSessionMeta = {
    id: mainSessionId,
    filePath: mainSessionFile,
    cwd: mainCwd,
    timestamp: new Date().toISOString(),
    name: null,
    lastModified: Date.now(),
    size: 0,
    outcome: null,
  }
  return {
    scanSessions: () => [meta],
    // W26（D9-1）：ISessionStore 接口新增目录 TTL 缓存失效成员
    invalidateScanCache: () => {},
    // u4c（D5⑤）：ISessionStore 新增流式归一化成员（本文件不触达，no-op 满足类型）
    normalizeSessionFileStreaming: () => {},
    refreshAll: () => {},
    persistSessionEnd: () => {},
    persistPresetBinding: () => {},
    persistProjectBinding: () => {},
    persistAgentBinding: () => {},
    extractSessionOutcome: () => null,
    invalidateMetaCache: () => {},
    convertHistory: (raw: unknown[]) => convertPiHistory(raw),
    rebuildHistoryFromEntries: () => ({ messages: [], clientUuidMap: new Map(), orphanToolResults: [] }),
    parseSessionHeader: () => null,
    // session-trace（A31/A32）：ISessionStore 接口新增 trace 读取成员（本测试不触达 trace 路径）
    readSessionHeaderLine: () => null,
    readSessionJsonlText: () => null,
    readSessionEndMeta: () => null,
    persistHandoffSidecar: () => {},
    // G4/u-h4：port trash 签名改 Promise<void>（失败保留文件并 reject），本测试不触删除路径
    trash: () => Promise.resolve(),
    // [session-store-layout-inversion D5] 目录级整树软删 port（本测试不触删除路径）
    trashDirectory: () => Promise.resolve(),
  }
}


/** Minimal pm mock — SessionService 构造函数需要 onSessionExit */
function createMockPm() {
  return {
    onSessionExit: () => {},
    getClient: () => undefined,
    hasClient: () => false,
  }
}


/**
 * v2 注册条目（W1 [D1] 身份域：id/agent/task/slug/origin/rootSessionId/depth/startedAt）。
 * 覆盖键经 overrides 传入（各用例身份不同）。
 */
function v2RegisteredEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: 'e-reg',
    parentId: null,
    timestamp: '2026-07-10T10:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id: 'bg-test-1-111',
      agent: 'reviewer',
      task: 'Review code',
      slug: 'review-code',
      origin: 'tool',
      rootSessionId: MAIN_SESSION_ID,
      depth: 0,
      startedAt: 1756000000000,
      ...overrides,
    },
  }
}


/**
 * v2 终态条目（W1 [D1] 终局域）：sessionFile/result/stopReason 的 v2 落点
 * （v2 注册条目只定身份，不承载会话文件锚点）。
 */
function v2SettledEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: 'e-settled',
    parentId: null,
    timestamp: '2026-07-10T10:01:00Z',
    data: {
      v: 2,
      kind: 'settled',
      id: 'bg-test-1-111',
      status: 'idle',
      stopReason: 'completed',
      endedAt: 1756000005000,
      turns: 2,
      totalTokens: 20,
      result: 'Review complete.',
      ...overrides,
    },
  }
}


// ======================================================================
// ← test/subagent-service-engine-route.test.ts
// ======================================================================

const MAIN_SESSION_ID_m2 = 'main-sess-id'


function createMockSessionStore_m2(mainSessionFile: string, mainSessionId: string): ISessionStore {
  const meta: ScannedSessionMeta = {
    id: mainSessionId,
    filePath: mainSessionFile,
    cwd: '/proj',
    timestamp: new Date().toISOString(),
    name: null,
    lastModified: Date.now(),
    size: 0,
    outcome: null,
  }
  return {
    scanSessions: () => [meta],
    // u4c（D5⑤）：ISessionStore 新增流式归一化成员（本文件不触达，no-op 满足类型）
    normalizeSessionFileStreaming: () => {},
    invalidateScanCache: () => {},
    refreshAll: () => {},
    persistSessionEnd: () => {},
    persistPresetBinding: () => {},
    persistProjectBinding: () => {},
    persistAgentBinding: () => {},
    extractSessionOutcome: () => null,
    invalidateMetaCache: () => {},
    convertHistory: (raw: unknown[]) => convertPiHistory(raw),
    rebuildHistoryFromEntries: () => ({ messages: [], clientUuidMap: new Map(), orphanToolResults: [] }),
    parseSessionHeader: () => null,
    readSessionHeaderLine: () => null,
    readSessionJsonlText: () => null,
    readSessionEndMeta: () => null,
    persistHandoffSidecar: () => {},
    // G4/u-h4：port trash 签名改 Promise<void>（失败保留文件并 reject），本测试不触删除路径
    trash: () => Promise.resolve(),
    // [session-store-layout-inversion D5] 目录级整树软删 port（本测试不触删除路径）
    trashDirectory: () => Promise.resolve(),
  }
}


function createSvc(tempDir: string): SessionService {
  return new SessionService(
    { onSessionExit: () => {}, getClient: () => undefined, hasClient: () => false } as never,
    {} as never, // broker
    {} as never, // adapterFactory
    '/tmp',
    {} as never, // extensionService
    {} as never, // configStore
    createMockSessionStore_m2(join(tempDir, 'main.jsonl'), MAIN_SESSION_ID_m2),
    {} as never, // gitInfoReader
    {} as never, // workspaceService
  )
}


/**
 * v2 注册条目 JSONL 行（W1 [D1] 身份域；rootSessionId 是派生视图摄入侧的会话归属键）。
 * engine/engineHandle 不在本条目——v2 契约把它们放在终态条目（settled 行）。
 */
function subagentRegisteredEntry(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'subagent-record',
    id: 'e-reg',
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 2,
      kind: 'registered',
      id: 'bg-route-1',
      agent: 'reviewer',
      task: 'routed task',
      slug: 'rev',
      origin: 'tool',
      rootSessionId: MAIN_SESSION_ID_m2,
      depth: 0,
      startedAt: 1756000000000,
      ...extra,
    },
  })
}


/** v2 终态条目 JSONL 行（W1 [D1] 终局域：engine/engineHandle/result 的 v2 落点）。 */
function subagentSettledEntry(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'subagent-record',
    id: 'e-settled',
    parentId: null,
    timestamp: '2026-08-19T00:01:00Z',
    data: {
      v: 2,
      kind: 'settled',
      id: 'bg-route-1',
      status: 'idle',
      stopReason: 'completed',
      endedAt: 1756000005000,
      turns: 1,
      totalTokens: 10,
      result: 'routed outcome',
      ...extra,
    },
  })
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('workflow-subagent-bundle', () => {
describe('workflow-extractor', () => {
/**
 * workflow-extractor 测试（[ADR-0095] v1 读侧删除后的骨架契约）。
 *
 * 提取器已不再从 entry 派生 WorkflowRunRecord（workflow 列表唯一数据源 =
 * events-projection 的 record 流 fold + v2 注册/终态条目）——本文件锚定
 * session-file-extraction 共享骨架的读失败分级与预检语义，以及「历史格式条目
 * （v1 快照 / v2 条目 / workflow-state-link 指针）恒不产出」的删除回归。
 */
describe('extractWorkflowsFromSessionFile', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'workflow-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('边界：主 session 文件不存在返回空数组', () => {
    const { records: result, oversize } = extractWorkflowsFromSessionFile(join(tempDir, 'no-such-file.jsonl'))
    expect(result).toEqual([])
    // ENOENT 走原读路径（stat 预检失败不引入新抛错/新标记）——非降级形态
    expect(oversize).toBe(false)
  })

  it('[G3] READ_PRECHECK 预检：>32MB 降级返回空列表 + oversize 标记（不读全文）', () => {
    const sessionFile = join(tempDir, 'oversize-main-session.jsonl')
    // 阈值 + 1B 超限（READ_PRECHECK_MAX_BYTES = 32MB，shared SSOT——导入引用而非写死，
    // 阈值调整时本用例跟随）
    writeFileSync(sessionFile, 'x'.repeat(READ_PRECHECK_MAX_BYTES + 1))

    const { records, oversize } = extractWorkflowsFromSessionFile(sessionFile)

    // 降级契约：不读全文 → 记录空列表 + oversize 正交标记（侧栏面板据此显示「会话过大」）
    expect(oversize).toBe(true)
    expect(records).toEqual([])
  })

  it('[G3] 预检阈值内（<32MB）正常读取：oversize=false', () => {
    const sessionFile = join(tempDir, 'normal-main-session.jsonl')
    writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'main-sess', cwd: '/proj' }) + '\n')

    const { records, oversize } = extractWorkflowsFromSessionFile(sessionFile)

    expect(oversize).toBe(false)
    expect(records).toEqual([])
  })

  // [ADR-0095] 删除回归：历史格式条目（workflow-record v1 全量快照 / v2 注册条目 /
  // workflow-state-link 指针）一律不派生 records——v1 读侧删除后冷路径恒空，
  // 历史 run 从本提取器数据范围退空即预期行为（列表数据源 = events-projection 派生视图）。
  it('历史格式条目（v1 快照 / v2 条目 / state-link 指针）恒不产出 records', () => {
    const snapshot = {
      v: 'wf-run-v2',
      runId: 'wf-hist',
      spec: { scriptName: 'hist-flow', description: 'test' },
      state: { status: 'running', budget: { usedTokens: 1, usedCost: 0, totalCallCount: 1 }, calls: [], trace: [] },
      meta: { startedAt: '2026-08-19T00:00:00Z' },
    }
    const entries = [
      { type: 'session', version: 3, id: 'main-sess', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'custom',
        customType: 'workflow-record',
        data: { v: 1, snapshot, updatedAt: '2026-08-19T00:00:01Z' },
      },
      {
        type: 'custom',
        customType: 'workflow-record',
        data: { v: 2, kind: 'registered', runId: 'wf-hist', recordPath: '/abs/wf-hist.record.jsonl' },
      },
      {
        type: 'custom',
        customType: 'workflow-state-link',
        data: { runId: 'wf-hist', path: '/abs/wf-hist.jsonl', updatedAt: '2026-07-10T10:01:00Z' },
      },
    ]
    const sessionFile = join(tempDir, 'main-session.jsonl')
    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    const { records } = extractWorkflowsFromSessionFile(sessionFile)
    expect(records).toEqual([])
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('workflow-outcome-vocab-parity', () => {
describe('outcome 词表双包值级等价（[W2 D5] core ≡ shared）', () => {
  it('core ALL_RUN_OUTCOMES 与 shared 词表成员逐成员一致（[D2] 四值 + [subagent-observability §3.3.8] 第五值）', () => {
    expect([...ALL_RUN_OUTCOMES].sort()).toEqual([...SHARED_WORKFLOW_RUN_OUTCOMES].sort())
    expect(ALL_RUN_OUTCOMES).toContain('time_limited')
    // [subagent-observability §3.3.8] partially_succeeded 双侧同批扩值（成员交付结算派生）
    expect(ALL_RUN_OUTCOMES).toContain('partially_succeeded')
    // [D2] interrupted 已移出 outcome（入 status 三态）——词表不含
    expect(ALL_RUN_OUTCOMES).not.toContain('interrupted')
  })

  it('五值全表快照（词表扩缩值时本用例红——两侧同步显式重审）', () => {
    expect([...ALL_RUN_OUTCOMES].sort()).toEqual([
      'cancelled',
      'done',
      'failed',
      'partially_succeeded',
      'time_limited',
    ])
    expect([...SHARED_WORKFLOW_RUN_OUTCOMES].sort()).toEqual([
      'cancelled',
      'done',
      'failed',
      'partially_succeeded',
      'time_limited',
    ])
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('workflow-run-events-reader', () => {
beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'wf-run-events-reader-'))
  savedEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir
  mkdirSync(getPiAgentDir(), { recursive: true })
  recordPath = join(getPiAgentDir(), 'wf-run-1.record.jsonl')
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
  rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('WorkflowRunEventsReader.readRunEvents 读侧派生视图', () => {
  it('全词表闭集：11 种事件逐型映射，载荷字段透传 + 信封 ts/seq 保留；坏行与空行跳过不计', () => {
    const body = FULL_STREAM_LINES.map((e) => JSON.stringify(e)).join('\n')
    writeFileSync(recordPath, `${body}\nnot-json\n\n`, 'utf-8')

    const reader = new WorkflowRunEventsReader()
    const reply = reader.readRunEvents(SID, RUN_ID, recordPath) as WorkflowRunEventsReply

    expect(reply.sessionId).toBe(SID)
    expect(reply.runId).toBe(RUN_ID)
    if (!('events' in reply)) throw new Error(`expected events reply, got ${JSON.stringify(reply)}`)
    // 坏行（非 JSON）与空行宽容跳过：11 帧全词表恰 11 条。
    expect(reply.events).toHaveLength(FULL_STREAM_LINES.length)

    const byType = (t: string) => reply.events.find((e) => e.type === t)

    // 以下五型此前无测试到达（映射函数体零覆盖）——逐字段钉住载荷透传形态。
    const retrying = byType('agent-retrying')
    expect(retrying).toMatchObject({ taskIndex: 0, attempt: 1, backoffMs: 500, reason: 'stale_context' })

    const phaseSettled = byType('phase-settled')
    expect(phaseSettled).toMatchObject({ phase: 'p1' })

    const interrupted = byType('run-interrupted')
    expect(interrupted).toMatchObject({ errorCode: 'crashed', reason: 'host restart' })

    const settled = byType('run-settled')
    expect(settled).toMatchObject({
      outcome: 'failed',
      errorCode: 'budget_limited',
      reason: 'budget exhausted',
      artifactsDir: '/tmp/artifacts',
    })

    const override = byType('model-override')
    expect(override).toMatchObject({ model: { provider: 'p1', modelId: 'm9' }, thinkingLevel: 'high' })

    // 信封透传（ts/seq）与其余已覆盖型的关键载荷抽检。
    const created = byType('run-created')
    expect(created).toMatchObject({ ts: 1000, seq: 1, runId: RUN_ID, workflowName: 'demo-wf' })
    expect(created && 'args' in created && typeof created.args === 'string' ? JSON.parse(created.args) : null).toEqual({ k: 'v' })
    expect(byType('phase-started')).toMatchObject({ ts: 1001, seq: 2, phase: 'p1' })
    expect(byType('agent-started')).toMatchObject({
      taskIndex: 0,
      agentName: 'a1',
      attempt: 1,
      phase: 'p1',
      memberRecordId: 'rec-1',
      input: 'do it',
    })
    expect(byType('agent-settled')).toMatchObject({
      taskIndex: 0,
      attempt: 1,
      outcome: 'failed',
      errorCode: 'unknown',
      durationMs: 42,
      stderrTeePath: '/tmp/tee.log',
    })
    expect(byType('run-resumed')).toMatchObject({
      reason: 'manual resume',
      host: 'hostA',
      budgetTimeMs: 3000,
      budgetTokens: 9000,
      model: 'prov/m2',
    })
    expect(byType('worker-log')).toMatchObject({ entry: { level: 'warn', message: 'boom' } })

    // 小载荷无截断 → truncatedFields 键不造。
    for (const entry of reply.events) {
      expect(entry.truncatedFields).toBeUndefined()
    }
  })

  it('大字段截断：args/scriptSource 按 WORKFLOW_RUN_EVENT_TRUNCATE_BYTES 字节上限截断并标注，多字节字符不切坏', () => {
    const bigSource = 'a'.repeat(WORKFLOW_RUN_EVENT_TRUNCATE_BYTES * 2)
    const cjkArgs = { k: '汉'.repeat(1000) } // 序列化后 ≈3KB > 2KB 上限，且全多字节
    const created = {
      type: 'run-created',
      seq: 1,
      ts: 1000,
      runId: RUN_ID,
      workflowName: 'big-wf',
      argsSummary: 's',
      args: cjkArgs,
      scriptSource: bigSource,
    }
    writeFileSync(recordPath, `${JSON.stringify(created)}\n`, 'utf-8')

    const reader = new WorkflowRunEventsReader()
    const reply = reader.readRunEvents(SID, RUN_ID, recordPath) as WorkflowRunEventsReply
    if (!('events' in reply)) throw new Error(`expected events reply, got ${JSON.stringify(reply)}`)
    const entry = reply.events[0]
    if (entry.type !== 'run-created') throw new Error('expected run-created entry')

    // 截断白名单标注：args 先于 scriptSource（projectRunCreated 截断序）。
    expect(entry.truncatedFields).toEqual(['args', 'scriptSource'])
    // scriptSource 为 ASCII：截断值 = 精确字节上限。
    expect(entry.scriptSource?.length).toBe(WORKFLOW_RUN_EVENT_TRUNCATE_BYTES)
    // args 多字节：截断值不超上限且不产非法 UTF-8（序列化不变 U+FFFD）。
    expect(entry.args).toBeDefined()
    const argsBytes = Buffer.byteLength(entry.args ?? '', 'utf8')
    expect(argsBytes).toBeLessThanOrEqual(WORKFLOW_RUN_EVENT_TRUNCATE_BYTES)
    expect(entry.args?.includes('\uFFFD')).toBe(false)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('workflow-status-vocab-parity', () => {
describe('status 词表双包值级等价（[§2.2] core 派生视图 ≡ shared）', () => {
  it('shared 词表快照（三值；扩缩值即本用例红——两侧同步显式重审）', () => {
    expect([...SHARED_WORKFLOW_RUN_STATUSES].sort()).toEqual(['done', 'interrupted', 'running'])
  })

  it('core runSummary 三形态逐一派生视图，恰好覆盖 shared 三成员', () => {
    const projected = [
      runSummary(makeRun({})).status,
      runSummary(makeRun({ interruptedAt: '2026-09-30T01:00:00.000Z' })).status,
      runSummary(makeRun({ status: 'done', reason: 'completed' })).status,
    ]
    expect(new Set(projected)).toEqual(new Set(SHARED_WORKFLOW_RUN_STATUSES))
  })

  it('映射值恒落在 shared 词表内（含终局原因各形态）', () => {
    const shapes = [
      {},
      { interruptedAt: '2026-09-30T01:00:00.000Z' },
      { status: 'done', reason: 'completed' },
      { status: 'done', reason: 'failed' },
      { status: 'done', reason: 'aborted' },
      { status: 'done', reason: 'budget_limited' },
      { status: 'done', reason: 'time_limited' },
    ]
    for (const shape of shapes) {
      const status = runSummary(makeRun(shape)).status
      expect(SHARED_WORKFLOW_RUN_STATUSES as readonly string[]).toContain(status)
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('subagent-service', () => {
describe('SessionService.getSubagents', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subagent-svc-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('extracts subagent list from main session JSONL', async () => {
    const mainSessionFile = join(tempDir, 'main.jsonl')
    const subagentFile = join(tempDir, 'sub1.jsonl')

    // 主 session JSONL（含一个 background subagent 的 v2 条目对）
    const mainEntries = [
      { type: 'session', id: MAIN_SESSION_ID, cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      v2RegisteredEntry(),
      v2SettledEntry({ sessionFile: subagentFile }),
    ]
    writeFileSync(mainSessionFile, mainEntries.map((e) => JSON.stringify(e)).join('\n'))

    // subagent JSONL
    const subEntries = [
      { type: 'session', id: 'sub-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:01:00Z' },
      {
        type: 'message',
        id: 'sub-msg-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Review this code' }],
          timestamp: Date.now(),
        },
      },
      {
        type: 'message',
        id: 'sub-msg-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I have reviewed the code.' }],
          timestamp: Date.now(),
        },
      },
    ]
    writeFileSync(subagentFile, subEntries.map((e) => JSON.stringify(e)).join('\n'))

    const sessionStore = createMockSessionStore(mainSessionFile, MAIN_SESSION_ID, '/proj')
    const svc = new SessionService(
      createMockPm() as never, // pm
      {} as never, // broker
      {} as never, // adapterFactory
      '/tmp',      // projectRoot
      {} as never, // extensionService
      {} as never, // configStore
      sessionStore,
      {} as never, // gitInfoReader
      {} as never, // workspaceService
    )

    const subagents = await svc.getSubagents(MAIN_SESSION_ID)
    expect(subagents.records).toHaveLength(1)
    expect(subagents.oversize).toBe(false)
    // [待裁决项 4] 会话在册 → found=true（正常路径，含空列表时的真实空语义）
    expect(subagents.found).toBe(true)
    expect(subagents.records[0].subagentId).toBe('bg-test-1-111')
    expect(subagents.records[0].agent).toBe('reviewer')
    expect(subagents.records[0].slug).toBe('review-code')
    // 终态条目在场 → status 收敛 idle（v2 两态：占用判据 = 终态条目缺席）
    expect(subagents.records[0].status).toBe('idle')
    expect(subagents.records[0].stopReason).toBe('completed')
    expect(subagents.records[0].result).toBe('Review complete.')
    expect(subagents.records[0].sessionFile).toBe(subagentFile)
  })

  it('returns empty array for unknown session', async () => {
    const sessionStore = createMockSessionStore('/nonexistent', 'unknown', '/proj')
    const svc = new SessionService(
      createMockPm() as never, {} as never, {} as never, '/tmp', {} as never, {} as never,
      sessionStore, {} as never, {} as never,
    )

    const subagents = await svc.getSubagents('nonexistent-id')
    expect(subagents.records).toHaveLength(0)
    // [待裁决项 4] 会话不在册（延迟落盘窗口 / 扫描竞态）→ found=false 显式分形，
    // 不与「会话存在但真空列表」共用同一空返回（renderer 据此保留分区不覆盖）
    expect(subagents.found).toBe(false)
  })
})
describe('SessionService.getSubagentHistory', () => {
  let tempDir: string
  let prevDataDir: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subagent-hist-'))
    // 隔离数据目录到 tempDir，使 getPiAgentDir() 返回 tempDir/agent —— 测试文件写入真实
    // piAgentDir 下（getSubagentHistory W-R1 路径穿越校验），又不污染真实 ~/.taiji。
    prevDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    if (prevDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = prevDataDir
  })

  it('reads subagent JSONL and converts to Message[]', async () => {
    const mainSessionFile = join(tempDir, 'main.jsonl')
    // subagent JSONL 必须落在 piAgentDir 下（getSubagentHistory W-R1 路径穿越校验）。
    // 真实 subagent 文件由 pi-subagent-workflow 写入 getSubagentSessionDir(mainCwd)，位于 piAgentDir 内。
    const subagentDir = join(getPiAgentDir(), 'subagents', 'mock-subagent-hist')
    mkdirSync(subagentDir, { recursive: true })
    const subagentFile = join(subagentDir, 'subagent.jsonl')

    // 主 session JSONL（v2 条目对：注册条目定身份，终态条目承载 sessionFile 锚点）
    const mainEntries = [
      { type: 'session', id: MAIN_SESSION_ID, cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      v2RegisteredEntry({ id: 'bg-hist-1-222', slug: 'review-hist', task: 'Review' }),
      v2SettledEntry({ id: 'bg-hist-1-222', sessionFile: subagentFile }),
    ]
    writeFileSync(mainSessionFile, mainEntries.map((e) => JSON.stringify(e)).join('\n'))

    // subagent JSONL（含 user + assistant 消息）
    const subEntries = [
      { type: 'session', id: 'sub-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:01:00Z' },
      {
        type: 'message',
        id: 'sub-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Please review this code file.' }],
          timestamp: Date.now(),
        },
      },
      {
        type: 'message',
        id: 'sub-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The code looks good. No issues found.' }],
          timestamp: Date.now(),
        },
      },
    ]
    writeFileSync(subagentFile, subEntries.map((e) => JSON.stringify(e)).join('\n'))

    const sessionStore = createMockSessionStore(mainSessionFile, MAIN_SESSION_ID, '/proj')
    const svc = new SessionService(
      createMockPm() as never, {} as never, {} as never, '/tmp', {} as never, {} as never,
      sessionStore, {} as never, {} as never,
    )

    const { messages } = await svc.getSubagentHistory(MAIN_SESSION_ID, 'bg-hist-1-222')

    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages.some((m) => m.role === 'user')).toBe(true)
    expect(messages.some((m) => m.role === 'assistant')).toBe(true)
  })

  it('returns empty array for unknown subagentId', async () => {
    const mainSessionFile = join(tempDir, 'main.jsonl')
    writeFileSync(mainSessionFile, JSON.stringify({ type: 'session', id: MAIN_SESSION_ID, cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' }) + '\n')

    const sessionStore = createMockSessionStore(mainSessionFile, MAIN_SESSION_ID, '/proj')
    const svc = new SessionService(
      createMockPm() as never, {} as never, {} as never, '/tmp', {} as never, {} as never,
      sessionStore, {} as never, {} as never,
    )

    const { messages } = await svc.getSubagentHistory(MAIN_SESSION_ID, 'nonexistent-subagent')
    expect(messages).toHaveLength(0)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('subagent-service-engine-route', () => {
describe('SessionService.getSubagentHistory engine routing (P5)', () => {
  let tempDir: string
  let prevDataDir: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sa-route-'))
    // session-service 的 getDataDir() 读 TAIJI_AGENT_DATA_DIR——隔离到 tempDir，
    // journal 前缀白名单按该 dataDir 推导
    prevDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tempDir
    writeFileSync(
      join(tempDir, 'main.jsonl'),
      `${JSON.stringify({ type: 'session', id: MAIN_SESSION_ID, cwd: '/proj' })}\n`,
    )
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    if (prevDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = prevDataDir
  })

  it('routes zcode record to the engine chain (tier3 outcome-only)', async () => {
    writeFileSync(
      join(tempDir, 'main.jsonl'),
      `${subagentRegisteredEntry()}\n${subagentSettledEntry({
        engine: 'zcode',
        engineHandle: { poolKey: 'reviewer', sessionRef: {} },
      })}\n`,
      { flag: 'a' },
    )

    const { messages } = await createSvc(tempDir).getSubagentHistory(MAIN_SESSION_ID_m2, 'bg-route-1')

    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toBe('routed task')
    expect(messages[1]?.content).toBe('routed outcome')
  })

  it('routes zcode record to journal tier when journal exists inside engines root', async () => {
    const poolDir = join(tempDir, 'engines', 'zcode', 'reviewer')
    mkdirSync(poolDir, { recursive: true })
    const eventsPath = join(poolDir, 'journal-bg-route-1.jsonl')
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({ v: 1, ts: 1, taskId: 'bg-route-1', engineId: 'zcode', seq: 0, event: { type: 'text_delta', delta: 'journal answer' } }),
        JSON.stringify({ v: 1, ts: 2, taskId: 'bg-route-1', engineId: 'zcode', seq: 1, event: { type: 'turn_end' } }),
      ].join('\n') + '\n',
      'utf-8',
    )
    writeFileSync(
      join(tempDir, 'main.jsonl'),
      `${subagentRegisteredEntry()}\n${subagentSettledEntry({
        engine: 'zcode',
        engineHandle: { poolKey: 'reviewer', sessionRef: { dbPath: '.zcode/cli/db/db.sqlite', sessionId: 's1' }, eventsPath },
      })}\n`,
      { flag: 'a' },
    )

    const { messages } = await createSvc(tempDir).getSubagentHistory(MAIN_SESSION_ID_m2, 'bg-route-1')

    expect(messages[1]?.role).toBe('assistant')
    expect(messages[1]?.content).toBe('journal answer')
  })

  it('keeps pi records on the existing JSONL chain (sessionFile missing → [])', async () => {
    // pi record（无 engine 字段）：路由段落回现有链——sessionFile 为 null 时现有行为 = []
    // （v2 终态条目缺席 ⇒ engine/sessionFile 均缺省）
    writeFileSync(join(tempDir, 'main.jsonl'), `${subagentRegisteredEntry()}\n`, { flag: 'a' })

    const svc = createSvc(tempDir)
    // 现有链路读取了主 session 文件（派生视图冷启动流式扫描定位 record）——路由前置
    // 数据范围真实经过了会话文件读取（record 命中即文件已读，路由确实落在 pi 分支）
    const subagents = await svc.getSubagents(MAIN_SESSION_ID_m2)
    expect(subagents.records.map((r) => r.subagentId)).toEqual(['bg-route-1'])
    expect(subagents.records[0]?.engine).toBeUndefined()

    const { messages } = await svc.getSubagentHistory(MAIN_SESSION_ID_m2, 'bg-route-1')
    expect(messages).toEqual([])
  })
})
});
// ======================================================================
// ← test/subagent-status.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('subagent-status', () => {
afterEach(() => {
  vi.restoreAllMocks()
})
/**
 * [two-state-convergence U6/D5] 契约收窄后归一器：两态直出 + legacy 值展示位合成。
 * 断言锚 = D5 归一映射表（done→idle+stopReason:'completed' / failed|crashed→idle+
 * stopReason:'failed' / cancelled→idle+stopReason:'cancelled' / closed→idle+
 * closedReason 保留 + deriveClosedDisplay 派生 stopReason）+ 第五归一（running &&
 * resumable===true → idle，存量桥接形态）。
 */
describe('normalizeSubagentStatus（[U6] 两态直出 + legacy 展示位合成）', () => {
  it('done / completed / success → idle + stopReason:completed + one-shot 形态位合成（§3.4 第 9 行「绿」的判据承载）', () => {
    for (const raw of ['done', 'completed', 'success']) {
      expect(normalizeSubagentStatus(raw), raw).toEqual({
        status: 'idle',
        derivedStopReason: 'completed',
      })
    }
  })

  it('failed / error / crashed → idle + stopReason:failed（crashed 同异常语义，D5 映射）', () => {
    for (const raw of ['failed', 'error', 'crashed']) {
      expect(normalizeSubagentStatus(raw), raw).toEqual({
        status: 'idle',
        derivedStopReason: 'failed',
      })
    }
  })

  it('cancelled / canceled → idle + stopReason:cancelled（interrupted 族灰点判据词）', () => {
    for (const raw of ['cancelled', 'canceled']) {
      expect(normalizeSubagentStatus(raw), raw).toEqual({
        status: 'idle',
        derivedStopReason: 'cancelled',
      })
    }
  })

  it('closed → idle + closedReason 保留 + deriveClosedDisplay 派生 stopReason（cancelled→cancelled）', () => {
    expect(
      normalizeSubagentStatus('closed', { closedReason: 'cancelled', error: 'aborted' }),
    ).toEqual({
      status: 'idle',
      derivedStopReason: 'cancelled',
      derivedClosedReason: 'cancelled',
    })
  })

  it('closed（gc + error）→ 派生 failed（deriveClosedDisplay gc+error → failed 映射，红点等价）', () => {
    expect(
      normalizeSubagentStatus('closed', { closedReason: 'gc', error: 'Model timeout' }),
    ).toEqual({
      status: 'idle',
      derivedStopReason: 'failed',
      derivedClosedReason: 'gc',
    })
  })

  it('closed（级联关闭，无 error）→ 派生 completed + one-shot 形态位（deriveClosedDisplay done → 绿点等价）', () => {
    expect(
      normalizeSubagentStatus('closed', { closedReason: 'parent-fork', error: 'closed due to parent-fork' }),
    ).toEqual({
      status: 'idle',
      derivedStopReason: 'completed',
      derivedClosedReason: 'parent-fork',
    })
  })

  it('running / pending / active → running（无 resumable 上下文）', () => {
    for (const raw of ['running', 'pending', 'active']) {
      expect(normalizeSubagentStatus(raw), raw).toEqual({ status: 'running' })
    }
  })

  it('[U6/D5 第五归一] running + resumable=true → idle（存量桥接形态——§3.4 第 2-5 行，不设 result 条件）', () => {
    expect(normalizeSubagentStatus('running', { resumable: true })).toEqual({ status: 'idle' })
    expect(normalizeSubagentStatus('pending', { resumable: true })).toEqual({ status: 'idle' })
    // resumable 非 true（含缺省 / U5 后新 entry 无此字段）不触发归一
    expect(normalizeSubagentStatus('running', { resumable: false })).toEqual({ status: 'running' })
    expect(normalizeSubagentStatus('running', {})).toEqual({ status: 'running' })
  })

  it('idle → idle（两态新词直投：无任务在途可续聊）', () => {
    expect(normalizeSubagentStatus('idle')).toEqual({ status: 'idle' })
  })

  it('undefined / 空串 → running（无状态信息，保持初始运行态）', () => {
    expect(normalizeSubagentStatus(undefined)).toEqual({ status: 'running' })
    expect(normalizeSubagentStatus('')).toEqual({ status: 'running' })
  })

  it('未知值 → idle（非占用方向兜底，不把已结束记录翻回运行中；[U6] 兜底词随收窄改 idle）', () => {
    expect(normalizeSubagentStatus('unknown')).toEqual({ status: 'idle' })
    expect(normalizeSubagentStatus('whatever')).toEqual({ status: 'idle' })
  })

  it('未知状态触发 console.warn 兜底告警（idle 属已知两态词，不触发）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    normalizeSubagentStatus('future-status')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[normalizeSubagentStatus] unknown status'),
    )
    // 已知状态不触发 warn
    warnSpy.mockClear()
    normalizeSubagentStatus('done')
    normalizeSubagentStatus('idle')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
});
});

// ======================================================================
// ← workspace-network-bundle.test.ts
// ======================================================================

/** setPinned/defaultSessionDir 用例共用的最小 store stub（record/list 透传已在上组覆盖） */
function storeStub(): RecentWorkspacesStore {
  return {
    record: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    setPinned: vi.fn().mockReturnValue(true),
    flushAll: vi.fn(),
  } as unknown as RecentWorkspacesStore
}


// ── T2.6: service 源码不含 setTimeout/setInterval ─────────────────
// 这是 grep 检查测试，运行时读源码验证

const SERVICE_SOURCE = readFileSync(
  new URL('../src/services/workspace/workspace-service.ts', import.meta.url),
  'utf-8',
)


// ======================================================================
// ← test/network-proxy-config.test.ts
// ======================================================================

let tmpDataDir_m2: string


let savedEnv_m2: string | undefined


function configPath(): string {
  return join(getPiAgentDir(), 'config', 'network-proxy-ext-config.json')
}


function validConfig(overrides: Partial<NetworkProxyConfig> = {}): NetworkProxyConfig {
  return {
    enabled: true,
    proxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
    noProxy: ['localhost'],
    rules: ['api.anthropic.com'],
    ipv4Only: [],
    ...overrides,
  }
}


// ======================================================================
// ← test/network-proxy-connection-test.test.ts
// ======================================================================

const SHORT_TIMEOUT_MS = 500


function proxyConfig(overrides: Partial<NetworkProxyConfig['proxy']> = {}, rules: string[] = ['target.example.test']): NetworkProxyConfig {
  return {
    enabled: true,
    proxy: { protocol: 'http', host: '127.0.0.1', port: 1, username: '', password: '', ...overrides },
    noProxy: [],
    rules,
    ipv4Only: [],
  }
}


interface MockServer { // oe-exempt:20261019:framework:探测单测的 mock 代理句柄形状（startMockHttpProxy/startMockSocks5 共用返回契约）

  port: number
  close: () => Promise<void>
  /** http 代理模式：收到的 CONNECT 请求头原文（凭据头断言用）。 */
  requests: string[]
}


function startMockHttpProxy(mode: 'accept' | 'reject' | 'silent'): Promise<MockServer> {
  return new Promise((resolve) => {
    const requests: string[] = []
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf-8')
        if (!text.startsWith('CONNECT')) return
        requests.push(text)
        if (mode === 'accept') socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
        else if (mode === 'reject') socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        // silent：不回（超时路径）
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}


type Socks5Mode = 'ok' | 'auth-ok' | 'auth-fail' | 'refuse-target' | 'reject-auth-method'


function startMockSocks5(mode: Socks5Mode): Promise<MockServer> {
  return new Promise((resolve) => {
    const requests: string[] = []
    const server = net.createServer((socket) => {
      let stage: 'greeting' | 'auth' | 'connect' = 'greeting'
      socket.on('data', (chunk) => {
        if (stage === 'greeting') {
          requests.push(`greeting:${chunk.toString('hex')}`)
          const wantsAuth = chunk[2] === 0x02
          if (wantsAuth) {
            if (mode === 'ok' || mode === 'refuse-target') {
              // 配了凭据但 mock 只支持无认证：拒绝方法选择
              socket.write(Buffer.from([0x05, 0xff]))
              socket.destroy()
              return
            }
            socket.write(Buffer.from([0x05, 0x02]))
            stage = 'auth'
          } else {
            if (mode === 'reject-auth-method') {
              socket.write(Buffer.from([0x05, 0xff]))
              socket.destroy()
              return
            }
            socket.write(Buffer.from([0x05, 0x00]))
            stage = 'connect'
          }
        } else if (stage === 'auth') {
          requests.push(`auth:${chunk.toString('hex')}`)
          socket.write(mode === 'auth-fail' ? Buffer.from([0x01, 0x01]) : Buffer.from([0x01, 0x00]))
          stage = 'connect'
        } else {
          requests.push(`connect:${chunk.toString('hex')}`)
          // BND.ADDR 固定 4 字节 IPv4 形态回复
          socket.write(
            mode === 'refuse-target'
              ? Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0x00, 0x00])
              : Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50]),
          )
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}


const cleanupQueue: Array<() => Promise<void>> = []


// ======================================================================
// ← test/network-proxy-message-handler.test.ts
// ======================================================================

function makeConfigService() {
  return {
    getNetworkProxyConfig: vi.fn().mockReturnValue({ enabled: false, proxy: {}, noProxy: [], rules: [] }),
    setNetworkProxyConfig: vi.fn().mockReturnValue({ ok: true }),
    testNetworkProxyConnection: vi.fn().mockResolvedValue({ ok: true, stage: 'done', message: 'ok', elapsedMs: 3 }),
    getNetworkProxyStats: vi.fn().mockReturnValue({ stats: [{ host: 'a.test', proxied: 1, direct: 2 }] }),
    resetNetworkProxyStats: vi.fn(),
  }
}


function makeHandler(configService = makeConfigService()) {
  const broadcasts: ServerMessage[] = []
  const replies: { id: string | undefined; type: string; payload: unknown }[] = []
  const sendErrorCalls: { id: string | undefined; code: string; message: string }[] = []
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      sendErrorCalls.push({ id, code, message })
    }),
    configService,
    sessionService: {},
    modelService: {},
    authService: {},
    skillRegistry: {},
    projectRoot: '/proj',
    nextPushId: vi.fn().mockReturnValue('push-1'),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
    connectionTester: {},
    mcpServersService: undefined,
  }
  const handler = new SettingsMessageHandler(ctx as unknown as SettingsHandlerContext)
  return { handler, broadcasts, replies, sendErrorCalls, configService }
}


function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


const config: NetworkProxyConfig = {
  enabled: true,
  proxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
  noProxy: ['localhost'],
  rules: ['api.anthropic.com'],
  ipv4Only: [],
}


// ======================================================================
// ← test/no-user-data-pollution.test.ts
// ======================================================================

const REAL_DATA_DIR = join(homedir(), '.taiji')

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('workspace-network-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('workspace-service', () => {
describe('WorkspaceService — grep guards', () => {
  it('T2.6: service source contains no setTimeout or setInterval (AC-2.4)', () => {
    // 排除注释行后再检查
    const codeLines = SERVICE_SOURCE
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .filter(line => !line.trimStart().startsWith('*'))
      .join('\n')

    expect(codeLines).not.toMatch(/\bsetTimeout\b/)
    expect(codeLines).not.toMatch(/\bsetInterval\b/)
  })

  it('T2.7: service source does not import session modules (AC-2.5)', () => {
    expect(SERVICE_SOURCE).not.toMatch(/from\s+['"].*session.*['"]/)
    expect(SERVICE_SOURCE).not.toMatch(/import.*session/i)
  })
})
describe('WorkspaceService — behavior', () => {
  let mockStore: RecentWorkspacesStore
  let service: WorkspaceService

  beforeEach(() => {
    mockStore = {
      record: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      flushAll: vi.fn(),
    } as unknown as RecentWorkspacesStore

    service = new WorkspaceService(mockStore)
  })

  it('record delegates to store.record', () => {
    service.record('/project/test')
    expect(mockStore.record).toHaveBeenCalledWith('/project/test')
  })

  it('record skips empty string (INV-1 primary guard)', () => {
    service.record('')
    expect(mockStore.record).not.toHaveBeenCalled()
  })

  // 方案 A homedir 检查（自 workspace-service-homedir.test.ts 并入）：
  // homedir 是失效 cwd 的兜底目标，作为「最近工作区」无记录价值——service 层堵死。
  it('record(homedir) → store.record 不被调用（方案A homedir 检查）', () => {
    service.record(homedir())
    expect(mockStore.record).not.toHaveBeenCalled()
  })

  it('record skips whitespace-only string (INV-1 primary guard)', () => {
    service.record('   ')
    expect(mockStore.record).not.toHaveBeenCalled()
  })

  it('record skips undefined (INV-1 primary guard)', () => {
    service.record(undefined as unknown as string)
    expect(mockStore.record).not.toHaveBeenCalled()
  })

  it('list delegates to store.list', () => {
    const records = [
      { cwd: '/project/a', lastUsedAt: 100, label: 'a' },
    ]
    vi.mocked(mockStore.list).mockReturnValue(records)

    const result = service.list()
    expect(result).toEqual(records)
    expect(mockStore.list).toHaveBeenCalled()
  })
})
// ── setPinned（INV-6 透传 + 上限拒绝降级，2026-10-22 pin 功能）──────────────

describe('WorkspaceService — setPinned', () => {
  let mockStore: RecentWorkspacesStore
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockStore = {
      record: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      setPinned: vi.fn().mockReturnValue(true),
      flushAll: vi.fn(),
    } as unknown as RecentWorkspacesStore
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('store 生效（true）→ 透传返回 true，不 warn', () => {
    const service = new WorkspaceService(mockStore)
    ;(mockStore.setPinned as ReturnType<typeof vi.fn>).mockReturnValue(true)
    expect(service.setPinned('/project/a', true)).toBe(true)
    expect(mockStore.setPinned).toHaveBeenCalledWith('/project/a', true)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('空串/whitespace → false 且不触 store（入参主检查）', () => {
    const service = new WorkspaceService(mockStore)
    expect(service.setPinned('', true)).toBe(false)
    expect(service.setPinned('   ', true)).toBe(false)
    expect(mockStore.setPinned).not.toHaveBeenCalled()
  })

  it('store 拒绝（false = 超 pin 上限）→ warn 留痕 + 返回 false（调用方 degraded 标记）', () => {
    const service = new WorkspaceService(mockStore)
    ;(mockStore.setPinned as ReturnType<typeof vi.fn>).mockReturnValue(false)
    expect(service.setPinned('/project/a', true)).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('setPinned rejected'))
  })
})
// ── defaultSessionDir（幂等 ensureDir + 失败返回空串，2026-10-22 默认会话入口）──

describe('WorkspaceService — defaultSessionDir', () => {
  it('provider 返回目录 → mkdirSync 后返回该目录（自愈兜底）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-service-default-'))
    const service = new WorkspaceService(storeStub(), () => dir)
    expect(service.defaultSessionDir()).toBe(dir)
    expect(existsSync(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('provider 返回空串 → 返回空串（入口隐藏判据），不触 fs', () => {
    const service = new WorkspaceService(storeStub(), () => '')
    expect(service.defaultSessionDir()).toBe('')
  })

  it('mkdirSync 抛错（路径父级是文件）→ 返回空串 + error 留痕（不向调用方抛）', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const tmp = mkdtempSync(join(tmpdir(), 'ws-service-blocker-'))
      // 以「已存在的文件」为父 → mkdirSync 必抛（ENOTDIR/EEXIST 族），真实触发 catch 分支
      const blockerFile = join(tmp, 'blocker')
      writeFileSync(blockerFile, 'x')
      const service = new WorkspaceService(storeStub(), () => join(blockerFile, 'sub'))
      expect(service.defaultSessionDir()).toBe('')
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ensure defaultSession dir failed'), expect.anything())
      rmSync(tmp, { recursive: true, force: true })
    } finally {
      errSpy.mockRestore()
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('network-proxy-config', () => {
beforeEach(() => {
  tmpDataDir_m2 = mkdtempSync(join(tmpdir(), 'network-proxy-config-test-'))
  mkdirSync(join(tmpDataDir_m2, 'agent'), { recursive: true })
  savedEnv_m2 = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir_m2
})
afterEach(() => {
  rmSync(tmpDataDir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
afterAll(() => {
  if (savedEnv_m2 === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv_m2
})
describe('getNetworkProxyConfig（读 + normalize + 缺失回默认）', () => {
  it('文件不存在 → 完整默认配置', () => {
    expect(getNetworkProxyConfig()).toEqual(DEFAULT_NETWORK_PROXY_CONFIG)
  })

  it('坏 JSON → 默认配置（读侧不抛错）', () => {
    mkdirSync(join(getPiAgentDir(), 'config'), { recursive: true })
    writeFileSync(configPath(), '{not json', 'utf-8')
    expect(getNetworkProxyConfig()).toEqual(DEFAULT_NETWORK_PROXY_CONFIG)
  })

  it('字段非法逐字段回默认（其余合法字段保留）', () => {
    mkdirSync(join(getPiAgentDir(), 'config'), { recursive: true })
    writeFileSync(configPath(), JSON.stringify({
      enabled: 'yes', // 非布尔 → 回默认 false
      proxy: { protocol: 'ftp', host: '', port: 70000, username: 'u' }, // 全非法 + 凭据单边 → 归一双清
      noProxy: 'not-array', // 非列表 → []
      rules: ['api.anthropic.com', '', 42], // 合法条目保留，空白/非字符串过滤
    }), 'utf-8')
    const config = getNetworkProxyConfig()
    expect(config.enabled).toBe(DEFAULT_NETWORK_PROXY_CONFIG.enabled)
    expect(config.proxy).toEqual({ protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' })
    expect(config.noProxy).toEqual([])
    expect(config.rules).toEqual(['api.anthropic.com'])
  })
})
describe('setNetworkProxyConfig（校验失败不落盘 / 成功 RMW 0600 / 序列化契约）', () => {
  it('校验失败（端口越界 + 凭据单边）返回错误清单且不落盘', () => {
    mkdirSync(join(getPiAgentDir(), 'config'), { recursive: true })
    writeFileSync(configPath(), 'ORIGINAL', 'utf-8')
    const bad = validConfig({
      proxy: { protocol: 'http', host: '127.0.0.1', port: 70000, username: 'u', password: '' },
    })
    const result = setNetworkProxyConfig(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
    expect(readFileSync(configPath(), 'utf-8')).toBe('ORIGINAL')
  })

  it('校验失败（文件尚不存在）不创建文件', () => {
    const result = setNetworkProxyConfig(validConfig({ noProxy: [''] })) // 空白条目非法
    expect(result.ok).toBe(false)
    expect(statSync(configPath(), { throwIfNoEntry: false })).toBeUndefined()
  })

  it('成功写入：mode 0600 + 2 空格缩进 + 尾换行（与 llm-shared saveConfig 序列化逐字一致）', () => {
    const result = setNetworkProxyConfig(validConfig())
    expect(result.ok).toBe(true)
    const stat = statSync(configPath())
    // 权限断言（POSIX 位；umask 不影响显式 mode）
    expect(stat.mode & 0o777).toBe(0o600)
    const content = readFileSync(configPath(), 'utf-8')
    expect(content.endsWith('\n')).toBe(true)
    expect(content).toBe(`${JSON.stringify(JSON.parse(content), null, 2)}\n`)
    expect(JSON.parse(content)).toEqual(validConfig())
  })

  it('RMW 保留文件内未知字段（extension 侧字段不丢）', () => {
    mkdirSync(join(getPiAgentDir(), 'config'), { recursive: true })
    const withExtra = { ...validConfig(), extensionFutureField: 'keep-me' }
    writeFileSync(configPath(), `${JSON.stringify(withExtra, null, 2)}\n`, 'utf-8')
    const result = setNetworkProxyConfig(validConfig({ rules: ['changed.example.test'] }))
    expect(result.ok).toBe(true)
    const parsed = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
    expect(parsed['extensionFutureField']).toBe('keep-me')
    expect(parsed['rules']).toEqual(['changed.example.test'])
  })

  it('共享 shared 校验函数（写侧与 settings 表单同一套语义）', () => {
    // sanity：service 直接复用 validateNetworkProxyConfig——同输入同结果
    const bad = { ...validConfig(), enabled: 'yes' } as unknown as NetworkProxyConfig
    expect(setNetworkProxyConfig(bad)).toEqual(validateNetworkProxyConfig(bad))
  })

  it('写侧去重（设计 §3.1 文件不变量「条目唯一」的保存侧执行点）：归一化同键保留首条', () => {
    mkdirSync(join(getPiAgentDir(), 'config'), { recursive: true })
    const duped = validConfig({
      rules: ['api.anthropic.com', 'API.Anthropic.com.', 'api.openai.com', 'api.anthropic.com'],
      noProxy: ['localhost', 'LocalHost', '127.0.0.1'],
    })
    const result = setNetworkProxyConfig(duped)
    expect(result.ok).toBe(true)
    const parsed = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
    // 大小写/末尾点变体算同一条（与匹配语义同一 normalizeHostname）；保留首条原样写法
    expect(parsed['rules']).toEqual(['api.anthropic.com', 'api.openai.com'])
    expect(parsed['noProxy']).toEqual(['localhost', '127.0.0.1'])
  })
})
describe('RMW 与 extension 侧锁协议互通（写后字段不丢）', () => {
  it('extension 形态全量写与 runtime RMW 字段写交错，双方字段共存', () => {
    mkdirSync(join(getPiAgentDir(), 'config'), { recursive: true })
    // 模拟 extension llm-shared saveConfig 全量写（带自身字段）
    writeFileSync(configPath(), `${JSON.stringify({ ...validConfig(), extensionCounter: 1 }, null, 2)}\n`, 'utf-8')
    // runtime RMW 覆盖四字段
    expect(setNetworkProxyConfig(validConfig({ enabled: false })).ok).toBe(true)
    // 模拟 extension 再次全量写（读-改-写：读当前文件、改自己字段、写回——同锁协议形态）
    const current = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
    current['extensionCounter'] = 2
    writeFileSync(configPath(), `${JSON.stringify(current, null, 2)}\n`, 'utf-8')
    const final = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
    // runtime 的四字段与 extension 的字段共存，后写不覆盖先写字段
    expect(final['enabled']).toBe(false)
    expect(final['extensionCounter']).toBe(2)
    expect(getNetworkProxyConfig().enabled).toBe(false)
  })
})
describe('atomicWrite mode 透传（默认路径回归）', () => {
  const tmpProbe = mkdtempSync(join(tmpdir(), 'network-proxy-atomic-'))
  afterAll(() => {
    rmSync(tmpProbe, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('不传 mode：权限 = 默认（0o666 & ~umask），与既有调用方行为一致', () => {
    const file = join(tmpProbe, 'default-mode.json')
    atomicWrite(file, 'x')
    expect(statSync(file).mode & 0o777).toBe(0o666 & ~process.umask())
  })

  it('传 mode 0o600：创建即 0600（rename 保留 tmp 权限位）', () => {
    const file = join(tmpProbe, 'restricted-mode.json')
    atomicWrite(file, 'secret', 'probe-suffix', 0o600)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('network-proxy-connection-test', () => {
afterEach(async () => {
  while (cleanupQueue.length > 0) {
    const close = cleanupQueue.pop()
    if (close) await close()
  }
})
describe('测试连接第一段（TCP 连代理，三协议同构）', () => {
  it('代理端口无监听 → ok=false stage=proxy，归因「代理不可达」+ 恢复指引', async () => {
    // 先 listen(0) 拿一个确定无监听的端口再关掉（connect 该端口 = ECONNREFUSED）
    const probe = await startMockHttpProxy('accept')
    const { port } = probe
    await probe.close()
    const result = await testNetworkProxyConnection(proxyConfig({ port }), SHORT_TIMEOUT_MS)
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('proxy')
    expect(result.message).toContain('无法连接代理')
    expect(result.message).toContain('连接被拒绝')
    expect(result.message).toContain('启动代理软件后重试')
    expect(result.message).toContain('关闭网络代理开关恢复直连')
  })

  it('规则为空 → 只测第一段即 done（message 说明未配置规则）', async () => {
    const mock = await startMockHttpProxy('accept')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(proxyConfig({ port: mock.port }, []), SHORT_TIMEOUT_MS)
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('done')
    expect(result.message).toContain('未配置代理规则')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(mock.requests).toEqual([]) // 未发起第二段
  })
})
describe('测试连接第二段（http/https 代理 = CONNECT 隧道探测）', () => {
  it('CONNECT 200 → ok=true stage=done，耗时取第一段', async () => {
    const mock = await startMockHttpProxy('accept')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(proxyConfig({ port: mock.port }), SHORT_TIMEOUT_MS)
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('done')
    expect(result.message).toContain('target.example.test:443')
    expect(result.message).toContain('经代理')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(mock.requests[0]).toContain('CONNECT target.example.test:443 HTTP/1.1')
  })

  it('CONNECT 502 → ok=false stage=outbound，「代理可达但经代理出站失败」归因 + 恢复指引', async () => {
    const mock = await startMockHttpProxy('reject')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(proxyConfig({ port: mock.port }), SHORT_TIMEOUT_MS)
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('outbound')
    expect(result.message).toContain('代理可达')
    expect(result.message).toContain('失败')
    expect(result.message).toContain('检查代理出口网络')
    expect(result.message).toContain('核对代理规则配置')
  })

  it('凭据非空 → CONNECT 带 Proxy-Authorization Basic 头', async () => {
    const mock = await startMockHttpProxy('accept')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ port: mock.port, username: 'user', password: 'pass' }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(true)
    const expected = Buffer.from('user:pass').toString('base64')
    expect(mock.requests[0]).toContain(`Proxy-Authorization: Basic ${expected}`)
  })

  it('代理收到 CONNECT 后不响应 → 超时归因（outbound 段）', async () => {
    const mock = await startMockHttpProxy('silent')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(proxyConfig({ port: mock.port }), 200)
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('outbound')
    expect(result.message).toContain('响应超时')
  })
})
describe('测试连接第二段（socks5 = RFC 1928 握手 + 连接请求）', () => {
  it('无认证握手 + CONNECT 成功 → ok=true stage=done', async () => {
    const mock = await startMockSocks5('ok')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ protocol: 'socks5', port: mock.port }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('done')
    expect(result.message).toContain('经代理访问 target.example.test:443')
    // 连接请求形态：ver=05 CMD=01 RSV=00 ATYP=03(domain) + len + host + port 0x01bb(443)
    const hostBuf = Buffer.from('target.example.test', 'utf-8')
    const expected = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
      hostBuf,
      Buffer.from([0x01, 0xbb]),
    ]).toString('hex')
    expect(mock.requests).toContain(`connect:${expected}`)
  })

  it('凭据非空 → RFC 1929 用户名密码认证通过（只提议 0x02 方法）', async () => {
    const mock = await startMockSocks5('auth-ok')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ protocol: 'socks5', port: mock.port, username: 'u', password: 'p' }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('done')
    expect(mock.requests[0]).toBe('greeting:050102')
    const user = Buffer.from('u', 'utf-8')
    const pass = Buffer.from('p', 'utf-8')
    const expectedAuth = Buffer.concat([
      Buffer.from([0x01, user.length]),
      user,
      Buffer.from([pass.length]),
      pass,
    ]).toString('hex')
    expect(mock.requests).toContain(`auth:${expectedAuth}`)
  })

  it('代理拒绝目标连接（rep=5）→ outbound 归因含「代理侧连接被拒绝」', async () => {
    const mock = await startMockSocks5('refuse-target')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ protocol: 'socks5', port: mock.port }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('outbound')
    expect(result.message).toContain('代理侧连接被拒绝')
    expect(result.message).toContain('检查代理出口网络')
  })

  it('认证失败（RFC 1929 status≠0）→ outbound 归因含「认证失败」', async () => {
    const mock = await startMockSocks5('auth-fail')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ protocol: 'socks5', port: mock.port, username: 'u', password: 'wrong' }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('outbound')
    expect(result.message).toContain('代理认证失败')
  })

  it('代理不接受任何提议方法（0xff）→ outbound 归因', async () => {
    const mock = await startMockSocks5('reject-auth-method')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ protocol: 'socks5', port: mock.port }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('outbound')
    expect(result.message).toContain('代理要求认证但未配置凭据')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('network-proxy-message-handler', () => {
describe('network-proxy 五条路由（经 SettingsMessageHandler 全链路）', () => {
  it('config.getNetworkProxy → reply config.networkProxy {config}', async () => {
    const { handler, replies, configService } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.getNetworkProxy', {}), {} as never)
    expect(handled).toBe(true)
    expect(configService.getNetworkProxyConfig).toHaveBeenCalledOnce()
    expect(replies).toEqual([
      { id: 'm1', type: 'config.networkProxy', payload: { config: { enabled: false, proxy: {}, noProxy: [], rules: [] } } },
    ])
  })

  it('config.setNetworkProxy 成功 → reply + broadcast config.networkProxy = 落盘终态（读回生效值）', async () => {
    const { handler, replies, broadcasts, configService } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.setNetworkProxy', { config }), {} as never)
    expect(handled).toBe(true)
    expect(configService.setNetworkProxyConfig).toHaveBeenCalledWith(config)
    // 写侧 dedupeHostList 是确定性变换（请求值 ≠ 生效值）：reply/broadcast 读回落盘终态，
    // 消费侧（ADR-0065 分支一）以服务端终态校准，禁乐观写请求值
    expect(configService.getNetworkProxyConfig).toHaveBeenCalledOnce()
    const effective = { enabled: false, proxy: {}, noProxy: [], rules: [] }
    expect(replies).toEqual([{ id: 'm1', type: 'config.networkProxy', payload: { config: effective } }])
    expect(broadcasts).toEqual([
      { type: 'config.networkProxy', id: 'push-1', payload: { config: effective } },
    ])
  })

  it('config.setNetworkProxy 校验失败 → 错误信封（不 reply 不 broadcast），service 返回错误清单', async () => {
    const failing = makeConfigService()
    failing.setNetworkProxyConfig.mockReturnValue({ ok: false, errors: ['代理端口必须是 1-65535 的整数: 70000，请填写正确的端口'] })
    const { handler, replies, broadcasts, sendErrorCalls } = makeHandler(failing)
    const handled = await handler.handleSettingsMessage(
      msg('config.setNetworkProxy', { config: { ...config, proxy: { ...config.proxy, port: 70000 } } }),
      {} as never,
    )
    expect(handled).toBe(true)
    expect(sendErrorCalls).toEqual([
      {
        id: 'm1',
        code: 'set_network_proxy_failed',
        message: '代理端口必须是 1-65535 的整数: 70000，请填写正确的端口',
      },
    ])
    expect(replies).toEqual([])
    expect(broadcasts).toEqual([])
  })

  it('config.testNetworkProxy → reply config.networkProxyTest（探测结果信封）', async () => {
    const { handler, replies, configService } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.testNetworkProxy', { config }), {} as never)
    expect(handled).toBe(true)
    expect(configService.testNetworkProxyConnection).toHaveBeenCalledWith(config)
    expect(replies).toEqual([
      { id: 'm1', type: 'config.networkProxyTest', payload: { ok: true, stage: 'done', message: 'ok', elapsedMs: 3 } },
    ])
  })

  it('config.getNetworkProxyStats → reply config.networkProxyStats {stats, truncatedNote?}', async () => {
    const { handler, replies, configService } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.getNetworkProxyStats', { range: '7d' }), {} as never)
    expect(handled).toBe(true)
    expect(configService.getNetworkProxyStats).toHaveBeenCalledWith('7d')
    expect(replies[0]?.type).toBe('config.networkProxyStats')
    expect(replies[0]?.payload).toEqual({ stats: [{ host: 'a.test', proxied: 1, direct: 2 }] })
  })

  it('config.resetNetworkProxyStats → 追加水位 + reply 清零后的统计（all 档）', async () => {
    const { handler, replies, configService } = makeHandler()
    const handled = await handler.handleSettingsMessage(msg('config.resetNetworkProxyStats', {}), {} as never)
    expect(handled).toBe(true)
    expect(configService.resetNetworkProxyStats).toHaveBeenCalledOnce()
    // reset 回清零后的统计（all 档，消费侧直接刷新视图——协议注释契约）
    expect(configService.getNetworkProxyStats).toHaveBeenCalledWith('all')
    expect(replies[0]?.type).toBe('config.networkProxyStats')
  })
})
describe('set 校验失败不落盘（service 层真实 fs）', () => {
  it('非法配置（端口越界）service 校验失败后文件不被创建', async () => {
    const { mkdtempSync, mkdirSync, rmSync, statSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const tmpDataDir_m2 = mkdtempSync(join(tmpdir(), 'network-proxy-handler-'))
    const savedEnv_m2 = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir_m2
    mkdirSync(join(tmpDataDir_m2, 'agent'), { recursive: true })
    try {
      const { setNetworkProxyConfig } = await import('../src/services/network-proxy-config.js')
      const { getPiAgentDir } = await import('../src/infra/pi/pi-paths.js')
      const configPath = join(getPiAgentDir(), 'config', 'network-proxy-ext-config.json')
      const bad: NetworkProxyConfig = { ...config, proxy: { ...config.proxy, port: 70000 } }
      expect(setNetworkProxyConfig(bad).ok).toBe(false)
      expect(statSync(configPath, { throwIfNoEntry: false })).toBeUndefined()
    } finally {
      if (savedEnv_m2 === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
      else process.env.TAIJI_AGENT_DATA_DIR = savedEnv_m2
      rmSync(tmpDataDir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('no-user-data-pollution', () => {
describe('[HISTORICAL] 用户数据污染防护 (2026-07-26 事故)', () => {
  it('process.env.TAIJI_AGENT_DATA_DIR 已被 globalSetup 重定向到 tmp', () => {
    const env = process.env.TAIJI_AGENT_DATA_DIR
    expect(env, 'TAIJI_AGENT_DATA_DIR 应被 globalSetup 设置').toBeTruthy()
    expect(env, 'TAIJI_AGENT_DATA_DIR 不能指向真实数据目录 ~/.taiji').not.toBe(REAL_DATA_DIR)
    expect(env?.endsWith('.taiji'), 'TAIJI_AGENT_DATA_DIR 不能是默认值 ~/.taiji').toBe(false)
  })

  it('getDataDir() 不返回真实数据目录', () => {
    expect(getDataDir()).not.toBe(REAL_DATA_DIR)
  })

  it('discovery-store eager 初始化路径不指向真实用户数据目录', () => {
    const p = getDiscoveryPath()
    expect(p, `discovery path 不能是 ~/.taiji 下: ${p}`).not.toContain(REAL_DATA_DIR)
    // 真实路径形如 <dataDir>/agent/discovery.json，断言不落到这里
    expect(p.endsWith('/.taiji/agent/discovery.json')).toBe(false)
  })

  it('settings-store eager 初始化路径不指向真实用户数据目录', () => {
    // pi-settings-store 的 settingsStore 在模块加载时初始化，getActiveSettingsPath 反映实际绑定路径
    // 注意：若其他测试调过 setSettingsPath 指向 tmp，此处返回的是该 tmp；但全局默认（未调过）应是 globalSetup 路径
    const p = getSettingsPath()
    expect(p, `settings path 不能是 ~/.taiji 下: ${p}`).not.toContain(REAL_DATA_DIR)
    expect(p.endsWith('/.taiji/agent/settings.json')).toBe(false)
  })

  it('getActiveSettingsPath 不指向真实用户数据目录', () => {
    const p = getActiveSettingsPath()
    // 此测试可能晚于其他测试执行，路径可能是某 tmp，但绝不能是真实路径
    expect(p.endsWith('/.taiji/agent/settings.json')).toBe(false)
  })
})
});
});

// ======================================================================
// ← server-envelope-bundle.test.ts
// ======================================================================

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← server-error-envelope.test.ts
// ======================================================================

/** 最小 mock services：setServices 装配只存引用，具体方法按需补。 */
function makeMockServices(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const sessionService = {
    listPersistedSessions: vi.fn().mockReturnValue([]),
    getRpcClient: vi.fn().mockReturnValue(undefined),
    setOnSessionDestroyed: vi.fn(),
    setOnPlanAborted: vi.fn(),
    restoreSession: vi.fn(),
    create: vi.fn(),
    ...overrides,
  } as unknown as ISessionService
  const configService = {
    listProviders: vi.fn().mockReturnValue([]),
  } as unknown as IConfigService
  const modelService = {} as IModelConnectionTester & IModelService
  return { sessionService, configService, modelService }
}


/** 构造已完成 setServices 装配的 server（ConnectionManager 不 listen，无端口占用）。 */
function makeServer(sessionOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const { sessionService, configService, modelService } = makeMockServices(sessionOverrides)
  const server = new RuntimeServer(0, '/mock-project-root', 'token')
  server.setServices(sessionService, configService, modelService, {
    skillRegistry: {} as SkillRegistry,
    providerCredentialResolver: {} as IProviderCredentialResolver,
    connectionTester: {} as IModelConnectionTester,
  })
  const handleMessage = (server as unknown as {
    handleMessage(msg: ClientMessage, ws: WebSocket): Promise<void>
  }).handleMessage.bind(server)
  return { handleMessage, sessionService }
}


function makeWs(opts: { sendThrows?: boolean } = {}): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: opts.sendThrows
      ? vi.fn(() => { throw new Error('ws closed (TOCTOU)') })
      : vi.fn(),
    // ConnectionManager.stop 的优雅关闭路径会调 close（mock no-op）
    close: vi.fn(),
  } as unknown as WebSocket
}


/** 畸形帧：payload 字段缺省（JSON.parse 层不校验形状，路由层此前假设必有 payload 对象）。
 * type 选 session.create：其 case handler 的 catch 对非 MODEL_NOT_CONFIGURED 异常原样
 * rethrow（区别于 session.restore 的内部 sendError 消费），异常直达 handleMessage 主漏斗。 */
function payloadlessMsg(): ClientMessage {
  return { type: 'session.create', id: 'req-1' } as unknown as ClientMessage
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('server-envelope-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('server-error-envelope', () => {
describe('RuntimeServer.handleMessage 异常漏斗（RT-1#3）', () => {
  it('T1: payload 缺省 + handler 抛错 → 不再二次抛 TypeError，error envelope 携带原异常信息', async () => {
    const { handleMessage, sessionService } = makeServer()
    const ws = makeWs()

    // 求值序：payload 缺省时 `msg.payload.cwd`（service 调用参数）先抛 TypeError(reading 'cwd')
    // → handler catch 原样 rethrow → 主漏斗。
    // 修复前：主漏斗 catch 里 `'sessionId' in msg.payload` 再抛 TypeError(reading 'payload')
    // 替换原异常 → handleMessage reject、信封丢失。修复后可选链消除二次抛。
    await expect(handleMessage(payloadlessMsg(), ws)).resolves.toBeUndefined()

    const sent = JSON.parse(vi.mocked(ws.send).mock.calls[0][0] as string) as {
      type: string
      id: string
      payload: { code: string; message: string }
    }
    expect(sent).toMatchObject({ type: 'error', id: 'req-1', payload: { code: 'handler_error' } })
    // 信封 message 是 handler 层的原 TypeError（reading 'cwd'），不是 catch 块的二次
    // TypeError（reading 'payload'）——原异常未被替换。
    expect(sent.payload.message).toContain("(reading 'cwd')")
    expect(sent.payload.message).not.toContain("(reading 'payload')")
    expect(sessionService.create).not.toHaveBeenCalled()
  })

  it('T2: error envelope 发送自身失败 → 上抛 Error 以 cause 保留原 handler 异常', async () => {
    const { handleMessage } = makeServer()
    const ws = makeWs({ sendThrows: true })

    // handler 抛 TypeError(reading 'cwd') → 主漏斗 → sendError → broker.send → ws.send
    // 抛（TOCTOU）→ 主漏斗以 cause 包装上抛
    const thrown = await handleMessage(payloadlessMsg(), ws).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('envelope send failed')
    expect((thrown as Error).message).toContain('ws closed (TOCTOU)')
    // cause 保留的是原 handler 异常（TypeError reading 'cwd'），而非 envelope 发送错误——归因链不断裂
    const cause = (thrown as Error & { cause?: unknown }).cause
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toContain("(reading 'cwd')")
    expect((cause as Error).message).not.toContain('ws closed')
  })

  it('T3: ConnectionManager 兜底信封透传 payload.sessionId（裁决 7 可归属）', async () => {
    const sendError = vi.fn()
    const conn = new ConnectionManager(0, {
      onConnect: () => {},
      onMessage: () => Promise.reject(new Error('funnel second throw')),
      sendError,
      onDisconnect: () => {},
    }, 'token')
    const ws = makeWs()
    // 窄化注入 authed 状态（绕过 auth 握手，直测 handleRawMessage 的兜底 catch）
    const connInternal = conn as unknown as {
      handleRawMessage(ws: WebSocket, data: unknown): void
      authedConnections: Set<WebSocket>
    }
    connInternal.authedConnections.add(ws)

    connInternal.handleRawMessage(ws, JSON.stringify({ type: 'session.restore', id: 'req-9', payload: { sessionId: 's9' } }))

    // catch 是异步链：等微任务flush后断言
    await vi.waitFor(() => {
      expect(sendError).toHaveBeenCalledTimes(1)
    }, { interval: 1 })
    expect(sendError).toHaveBeenCalledWith(
      ws,
      'handler_error',
      'funnel second throw',
      'req-9',
      { sessionId: 's9' },
    )
    // 清理：stop 清 heartbeat/auth 计时器并关 httpServer（防 45s 心跳 timer 挂住测试进程）
    await conn.stop()
  })
})
});
// ======================================================================
// ← handler-registry.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('handler-registry', () => {
describe('handler-registry', () => {
  describe('registerHandler', () => {
    it('stores handler in map by handlerId', () => {
      const map = new Map<string, () => void>()
      registerHandler(map, 'h1', () => {})
      expect(map.has('h1')).toBe(true)
    })

    it('dispose removes handler from map', () => {
      const map = new Map<string, () => void>()
      const { dispose } = registerHandler(map, 'h1', () => {})
      dispose()
      expect(map.has('h1')).toBe(false)
    })

    it('dispose calls optional onDispose callback', () => {
      const map = new Map<string, () => void>()
      const onDispose = vi.fn()
      const { dispose } = registerHandler(map, 'h1', () => {}, onDispose)
      dispose()
      expect(onDispose).toHaveBeenCalledOnce()
    })

    it('dispose works without onDispose (optional)', () => {
      const map = new Map<string, () => void>()
      const { dispose } = registerHandler(map, 'h1', () => {})
      expect(() => dispose()).not.toThrow()
    })
  })

  describe('dispatchHandler', () => {
    it('returns true and invokes handler when handlerId found', () => {
      const map = new Map<string, (x: number) => void>()
      const handler = vi.fn()
      registerHandler(map, 'h1', handler)
      const hit = dispatchHandler(map, { handlerId: 'h1' }, (h) => h(42))
      expect(hit).toBe(true)
      expect(handler).toHaveBeenCalledWith(42)
    })

    it('returns false when handlerId not in map', () => {
      const map = new Map<string, () => void>()
      const hit = dispatchHandler(map, { handlerId: 'missing' }, () => {})
      expect(hit).toBe(false)
    })
  })
})
});
});

// ======================================================================
// ← event-adapter-bundle.test.ts
// ======================================================================

// ======================================================================
// ← test/event-adapter-dialog-kind.test.ts
// ======================================================================

type PiTestEvent_m5 = Record<string, unknown>


const SID_m2 = 'sess-d6'


// ── stdout 单通路「恰一次」断言（interpreter 层）────────────────

/**
 * 装配最小 interpreter：只统计 executeHooks('onPiEvent', …) 触发与 WS 帧。
 */
function setup() {
  const hookCalls: Array<{ hookType: string; context: Record<string, unknown> }> = []
  const sent: ServerMessage[] = []
  const interpreter = new EventInterpreter(SID_m2, {
    send: (msg) => { sent.push(msg) },
    executeHooks: async (hookType: string, context: Record<string, unknown>) => {
      hookCalls.push({ hookType, context })
      return { blocked: false }
    },
  })
  return { interpreter, hookCalls, sent }
}


// ======================================================================
// ← test/event-adapter-inflight.test.ts
// ======================================================================

const SID_m3 = 'sess-inflight-1'


/** marker 通道帧形态（pi rpc-mode select：{method:'select', id, title, options}）。 */
function makeFrame(title: string | undefined, options: unknown[], id = 'req-inflight-1'): PiEvent {
  return { type: 'extension_ui_request', method: 'select', id, title, options } as PiEvent
}


/** 合法上报载荷（sessionId 在场 = 可归属；kind 字段已删——2026-09-13 oe-audit）。 */
function reportPayload(inFlight: number, sessionId: string = SID_m3): string {
  return JSON.stringify({ inFlight, sessionId, emittedAt: 1_700_000_000_000 })
}


/**
 * 挂一个 EventAdapter 到假 client（capture listener）。withAck=false 模拟旧形态 client
 * （无 sendExtensionUiResponse 能力——port 可选成员的现实缺省）。
 */
function attachAdapter(opts: { withAck?: boolean } = {}) {
  const interpret = vi.fn()
  const adapter = new EventAdapter(SID_m3, interpret)
  const ack = vi.fn()
  const unsub = vi.fn()
  let listener: PiEventListener = () => {}
  const onEvent = vi.fn((l: PiEventListener) => { listener = l; return unsub })
  if (opts.withAck === false) {
    adapter.attach({ onEvent })
  } else {
    adapter.attach({ onEvent, sendExtensionUiResponse: ack })
  }
  return { adapter, interpret, listener: listener as unknown as (event: unknown) => void, ack, unsub }
}


// ======================================================================
// ← test/occupancy-runtime.test.ts
// ======================================================================

// ── 共享 mock 工厂 ───────────────────────────────────────────────

function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
        bashRunToken: undefined,
    ...overrides,
  }
}


/** 测试视图占用写一律经转移原语（fixture 直写禁令；publish 传 null 不广播）。范式先例：src/transport/session-manager-send-queue.test.ts setBusy。 */
function driveOccupancy(
  session: IManagedSessionView,
  ...transitions: SessionOccupancyTransition[]
): IManagedSessionView {
  for (const t of transitions) applySessionOccupancyTransition(session, null, t)
  return session
}


/** 从 publish 调用记录里抽取全部 occupancy 帧的 payload（帧序）。 */
function occupancyFrames(publish: ReturnType<typeof vi.fn>): Array<SessionOccupancy & { sessionId: string }> {
  return publish.mock.calls
    .map((c: unknown[]) => (c[1] as ServerMessage))
    .filter((m) => m.type === 'session.occupancy')
    .map((m) => m.payload as SessionOccupancy & { sessionId: string })
}


function frameTypes(publish: ReturnType<typeof vi.fn>): string[] {
  return publish.mock.calls.map((c: unknown[]) => (c[1] as ServerMessage).type)
}


/** 按 type 取发布消息（错误范围断言用；无则 undefined）。 */
function publishedByType<T extends ServerMessage['type']>(
  publish: ReturnType<typeof vi.fn>,
  type: T,
): ServerMessage<T> | undefined {
  for (const call of publish.mock.calls) {
    const msg = call[1] as ServerMessage
    if (msg.type === type) return msg as ServerMessage<T>
  }
  return undefined
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('event-adapter-bundle', () => {
describe('event-adapter', () => {
describe('event-adapter-new-events', () => {
/**
 * Task 2 tests: EventAdapter new event translations (FR-1 through FR-6).
 *
 * Covers new pi → WS event mappings added in Phase 0 of the TUI Bridge:
 *  - FR-1: extension_ui_request additions (editor / set_editor_text / setTitle),
 *          extension_error field rename (extensionName ← extensionPath) + errorEvent
 *  - FR-2: message_start role-based routing (bashExecution / compactionSummary /
 *          branchSummary) and customType passthrough of details/display
 *  - FR-3: new event types (auto_retry_start, auto_retry_end, queue_update,
 *          session_info_changed, thinking_level_changed)
 *  - FR-4: tool_execution_end image extraction, tool_execution_update object detail,
 *          agent_end responseModel + diagnostics
 *  - FR-5: message_update error → message.stream_error
 *  - FR-6: extension_ui_request setTitle
 *
 * Each test sends a flat pi event to the adapter and asserts the resulting
 * ServerMessage via toMatchObject (existing fields like sessionId are preserved).
 */

/** Pi extension events carry extra fields not in PiMessage, so we widen for tests */
type PiTestEvent_m4_m4 = PiMessage & Record<string, unknown>

/** Helper to create event objects that satisfy PiMessage + extra pi fields */
function piEvent_m2_m2(fields: PiTestEvent_m4_m4): PiTestEvent_m4_m4 {
  return fields
}

function createAdapter_m4_m4(options?: EventAdapterOptions): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send, options)
  return { adapter, sent }
}

/** Wait for async handleEvent to flush */
const flushAsync_m4_m4 = () => new Promise<void>(r => setTimeout(r, 0))

/** Attach adapter and dispatch a single pi event through the listener */
function dispatchOne_m3_m3(adapter: EventAdapter, event: PiTestEvent_m4_m4): void {
  adapter.attach({
    onEvent: (listener) => {
      listener(piEvent_m2_m2(event))
      return () => {}
    },
  })
}

describe('EventAdapter: new event translations (FR-1~FR-6)', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const result = createAdapter_m4_m4()
    adapter = result.adapter
    sent = result.sent
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-1: extension_ui_request additions + extension_error field rename
  // ════════════════════════════════════════════════════════════════════

  describe('FR-1: extension_ui_request — editor method', () => {
    it('translates editor method to extension.dialog with prefill', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'extension_ui_request',
        method: 'editor',
        id: 'r1',
        title: 'Edit',
        prefill: 'hello',
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.dialog')
      expect(sent[0].payload).toMatchObject({
        dialogKind: 'editor',
        title: 'Edit',
        prefill: 'hello',
      })
    })
  })

  describe('FR-1: extension_ui_request — set_editor_text', () => {
    it('translates set_editor_text to extension:setEditorText', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'extension_ui_request',
        method: 'set_editor_text',
        text: 'new text',
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:setEditorText')
      expect(sent[0].payload).toMatchObject({
        text: 'new text',
      })
    })
  })

  describe('FR-1: extension_error — extensionPath field rename + errorEvent', () => {
    it('reads extensionPath (not extensionName) and forwards errorEvent', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'extension_error',
        extensionPath: 'a/b/c.ts',
        error: 'fail',
        event: 'tool_execution',
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.error')
      expect(sent[0].payload).toMatchObject({
        extensionName: 'a/b/c.ts',
        error: 'fail',
        errorEvent: 'tool_execution',
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-2: message_start role-based routing
  // [M5 删除] role=compactionSummary/branchSummary 的 message_start 分支已删（411608945）：
  // grep 历史 session JSONL 确认 pi 从不 emit 这两种 role（死分支）。压缩/分支摘要由
  // compaction_end 事件 + entry 树重建两条通路覆盖，不经 message_start。
  // ════════════════════════════════════════════════════════════════════

  describe('FR-2: message_start — customType with details/display', () => {
    it('passes through details and display for customType messages', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'message_start',
        message: {
          customType: 'info',
          content: 'hi',
          details: { k: 'v' },
          display: false,
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      // customType 消息用独立 type 'message.customStart'（区别于 assistant turn 的 message_start）
      expect(sent[0].type).toBe('message.customStart')
      expect(sent[0].payload).toMatchObject({
        customType: 'info',
        content: 'hi',
        details: { k: 'v' },
        display: false,
      })
    })
  })

  // [HISTORICAL] pi 0.80.3 agent-loop 在每个 turn 末尾 emit message_start{role:'user'}
  // （agent-loop.ts:112）。若不过滤，前端为 user prompt 再建空气泡（渲染撕裂 +
  // findLastAssistantIndex 错位）。切 upstream 0.80.3（ac83b578）后出现。与 toolResult 同语义。
  describe('FR-2: message_start — user/toolResult roles ignored (pi 0.80.3)', () => {
    it('ignores role=user message_start (no message_start WS sent)', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'message_start',
        message: { role: 'user', content: 'hi' },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(0)
    })

    it('ignores role=toolResult message_start (no message_start WS sent)', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'message_start',
        message: { role: 'toolResult', content: 'result' },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(0)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-3: new event types
  // ════════════════════════════════════════════════════════════════════

  describe('FR-3: auto_retry_start', () => {
    it('translates auto_retry_start to message.auto_retry_start', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'timeout',
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.auto_retry_start')
      expect(sent[0].payload).toMatchObject({
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'timeout',
      })
    })
  })

  describe('FR-3: auto_retry_end', () => {
    it('translates auto_retry_end to message.auto_retry_end', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'auto_retry_end',
        success: true,
        attempt: 3,
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.auto_retry_end')
      expect(sent[0].payload).toMatchObject({
        success: true,
        attempt: 3,
      })
    })
  })

  describe('FR-3: queue_update', () => {
    it('queue_update 已退役（u5a/R1-A5）→ NULL_EVENTS no-op，不出帧也不落 Unhandled warn', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'queue_update',
        steering: ['s1'],
        followUp: ['f1'],
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(0)
    })
  })

  describe('FR-3: session_info_changed', () => {
    it('translates session_info_changed to session.renamed', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'session_info_changed',
        name: 'new-name',
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('session.renamed')
      expect(sent[0].payload).toMatchObject({
        name: 'new-name',
      })
    })

    it('U-session-0：翻译产出中间事件 {kind:"session-renamed", name}（MF-3 ①，interpreter 回写链入口）', async () => {
      // 直接捕获 EventAdapter 的 PiTranslatedEvent[] 产出——钉住 session_info_changed
      // → session-renamed 中间事件翻译（label 回写链的第一段，丢失则 runtime 内存
      // label 过期覆盖前端 rename，即本批修复的核心 bug）
      const translated: Array<Record<string, unknown>> = []
      const rawAdapter = new EventAdapter('test-session-1', (events) => {
        translated.push(...(events as Array<Record<string, unknown>>))
      })
      dispatchOne_m3_m3(rawAdapter, { type: 'session_info_changed', name: 'new-name' })
      await flushAsync_m4_m4()

      expect(translated).toContainEqual({ kind: 'session-renamed', name: 'new-name' })
    })

    it('U-session-1：session_info_changed 触发 onSessionRenamed 回调并广播 session.renamed（MF-3 ②，对齐 thinking-level 模式）', async () => {
      const onSessionRenamed = vi.fn()
      const { adapter, sent } = createAdapter_m4_m4({ onSessionRenamed })
      dispatchOne_m3_m3(adapter, { type: 'session_info_changed', name: 'new-name' })
      await flushAsync_m4_m4()

      // 回调被调用，参数为 (sessionId, 'new-name')——组合根（index.ts）在此回写
      // sessionService.setLabelCache 同步内存态 label
      expect(onSessionRenamed).toHaveBeenCalledTimes(1)
      expect(onSessionRenamed).toHaveBeenCalledWith('test-session-1', 'new-name')
      // 产出 session.renamed 消息（前端侧栏改名）
      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('session.renamed')
      expect(sent[0].payload).toMatchObject({ name: 'new-name' })
    })
  })

  describe('FR-3: thinking_level_changed', () => {
    it('translates thinking_level_changed to session.thinkingLevelSet', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'thinking_level_changed',
        level: 'high',
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('session.thinkingLevelSet')
      expect(sent[0].payload).toMatchObject({
        level: 'high',
      })
    })

    it('U-adapter-1：thinking_level_changed 广播 session.thinkingLevelSet，无旧缓存回写回调（W9）', async () => {
      const { adapter, sent } = createAdapter_m4_m4()
      dispatchOne_m3_m3(adapter, { type: 'thinking_level_changed', level: 'high' })
      await flushAsync_m4_m4()

      // W9：onThinkingLevelChanged 旧缓存回写回调已删（事件只做实例 markDirty，实例解析器
      // 由组合根注入，fixture 不接线）——回归断言帧翻译路径不受回调删除影响。
      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('session.thinkingLevelSet')
      expect(sent[0].payload).toMatchObject({ level: 'high' })
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-4: image extraction + structured partialResult + agent_end extras
  // ════════════════════════════════════════════════════════════════════

  describe('FR-4: tool_execution_end — image extraction', () => {
    it('extracts image blocks alongside text into images array', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        result: {
          content: [
            { type: 'text', text: 'ok' },
            { type: 'image', data: 'base64', mimeType: 'image/png' },
          ],
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_end')
      // [w21] payload 换 toolResult message entry 形态：content 是原始 result（含 image 块，
      // 归一化 output/images 提取移到消费侧——adapter 中间事件仍 normalize 供 hook 上下文）。
      // image 块保留在 entry.message.content 中不丢（规则 #9）。
      const payload = sent[0].payload as { entry: { toolCallId?: string; message: { toolCallId?: unknown; content?: unknown } } }
      expect(payload.entry.message.toolCallId).toBe('tc1')
      // [w21] content 已归一为 pi 持久化数组形态（.content 数组透传，image 块保留不丢）
      expect(payload.entry.message.content).toEqual([
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'base64', mimeType: 'image/png' },
      ])
    })
  })

  describe('FR-4: tool_execution_update — structured partialResult', () => {
    it('extracts partialResult.details as detail (S5 fix: aligned with tool_execution_end)', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'tool_execution_update',
        toolCallId: 'tc1',
        partialResult: {
          content: 'running',
          details: { truncated: true },
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_update')
      // S5 修复：detail 提取 partialResult.details（与 tool_execution_end 路径对齐），
      // 不再透传整个 partialResult。无 details 时 fallback 用整个对象。
      expect(sent[0].payload).toMatchObject({
        toolCallId: 'tc1',
        detail: { truncated: true },
      })
    })

    it('falls back to whole object when partialResult has no details (subagent progress shape)', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'tool_execution_update',
        toolCallId: 'tc2',
        partialResult: {
          currentTool: 'bash',
          turnCount: 3,
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      // 无 details 字段时，detail fallback 到整个 partialResult（兼容 subagent 扁平 progress 形态）
      expect(sent[0].payload).toMatchObject({
        toolCallId: 'tc2',
        detail: { currentTool: 'bash', turnCount: 3 },
      })
    })
  })

  describe('FR-4: agent_end — responseModel + diagnostics', () => {
    it('forwards responseModel and diagnostics in message.complete', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'agent_end',
        messages: [
          {
            stopReason: 'stop',
            usage: { input: 100, output: 50 },
            responseModel: 'gpt-4o',
            diagnostics: { latency: 1.2 },
          },
        ],
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.complete')
      expect(sent[0].payload).toMatchObject({
        stopReason: 'end_turn',
        responseModel: 'gpt-4o',
        diagnostics: { latency: 1.2 },
      })
      // payload.usage 已随 chat-flow-consistency D3 规则 5 退役：usage 由 message_end(assistant)
      // 逐条载荷唯一承担（event-adapter-turn-usage-sum.test.ts 同口径锁定）。
      expect((sent[0].payload as Record<string, unknown>).usage).toBeUndefined()
    })
  })

  // 复杂度债务重构锚定：handleAgentEnd 的 errorMessage 条件透出与 finalContent 提取
  // 已提取为独立 helper（extractAgentEndFields / extractFinalContent），本套件锚定原分支语义。
  describe('FR-4: agent_end — errorMessage passthrough + finalContent extraction', () => {
    it('stopReason=error exposes errorMessage and joins text content blocks', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'agent_end',
        messages: [
          {
            stopReason: 'error',
            usage: { input: 10, output: 5, totalTokens: 15 },
            errorMessage: 'provider overloaded',
            content: [
              { type: 'text', text: 'part1 ' },
              { type: 'image', source: 'ignored' }, // 非 text block 被过滤
              { type: 'text', text: 'part2' },
            ],
          },
        ],
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.complete')
      expect(sent[0].payload).toMatchObject({
        stopReason: 'error',
        errorMessage: 'provider overloaded',
        content: 'part1 part2',
      })
      // 同上：payload.usage 退役（D3 规则 5），turn-end 顶层 totalTokens 仍 = 末次调用总量。
      expect((sent[0].payload as Record<string, unknown>).usage).toBeUndefined()
    })

    it('stopReason=stop drops errorMessage (field stays absent from payload)', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'agent_end',
        messages: [{ stopReason: 'stop', errorMessage: 'should be dropped' }],
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.complete')
      expect((sent[0].payload as Record<string, unknown>).errorMessage).toBeUndefined()
    })

    // W1 空消息防御（自 handle-agent-end-empty-messages.test.ts 并入）：
    // messages 为空数组/undefined 时旧实现取 messages[len-1] 访问 .stopReason 抛 TypeError，
    // 被整批 try-catch 吞掉 → agent_end 整批事件丢失 → isGenerating 永不复位。
    // 防御语义：降级为 turn-end { stopReason: 'error' }，保证 onTurnFinalize 仍能触发。
    it('AE1: agent_end with empty messages array → no throw, onTurnFinalize still fires', async () => {
      const onTurnFinalize = vi.fn()
      const defensive = createAdapter_m4_m4({ onTurnFinalize })

      expect(() =>
        dispatchOne_m3_m3(defensive.adapter, { type: 'agent_end', messages: [] }),
      ).not.toThrow()
      await flushAsync_m4_m4()

      expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    })

    it('AE2: agent_end with undefined messages → no throw, onTurnFinalize still fires', async () => {
      const onTurnFinalize = vi.fn()
      const defensive = createAdapter_m4_m4({ onTurnFinalize })

      expect(() =>
        dispatchOne_m3_m3(defensive.adapter, { type: 'agent_end', messages: undefined }),
      ).not.toThrow()
      await flushAsync_m4_m4()

      expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-4b: turn_end — 每 turn 用量更新（不转发 message.complete）
  // pi 0.80.3：1 agent 循环 = N 个 turn，每 turn_end 带 usage。
  // turn_end 经 handleTurnEndPi 提取 usage → turn-usage → onContextUpdate，
  // 不产 message.complete（避免每 turn 触发前端 setStreaming 闪烁）。
  // ════════════════════════════════════════════════════════════════════

  describe('FR-4b: turn_end — 每 turn 用量更新（不发 message.complete）', () => {
    it('turn_end 带 usage → 调 onContextUpdate，不发 message.complete', async () => {
      const onContextUpdate = vi.fn()
      const { adapter, sent } = createAdapter_m4_m4({ onContextUpdate })
      dispatchOne_m3_m3(adapter, {
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          usage: { input: 163418, output: 82, totalTokens: 163628 },
        },
        toolResults: [],
      })
      await flushAsync_m4_m4()

      // onContextUpdate 被调，带本 turn 的 context 占用（totalTokens，非单 turn 增量 input）
      expect(onContextUpdate).toHaveBeenCalledTimes(1)
      expect(onContextUpdate).toHaveBeenCalledWith('test-session-1', {
        inputTokens: 163628,
        totalTokens: 163628,
      })
      // 不转发 message.complete（避免每 turn 触发 setStreaming 闪烁）
      expect(sent.find(m => m.type === 'message.complete')).toBeUndefined()
    })

    it('turn_end 无 usage.totalTokens → 不触发 onContextUpdate（检查）', async () => {
      const onContextUpdate = vi.fn()
      const { adapter } = createAdapter_m4_m4({ onContextUpdate })
      dispatchOne_m3_m3(adapter, {
        type: 'turn_end',
        message: { role: 'assistant', stopReason: 'stop' }, // 无 usage
        toolResults: [],
      })
      await flushAsync_m4_m4()

      expect(onContextUpdate).not.toHaveBeenCalled()
    })

    it('多 turn 循环：每 turn_end 独立触发 onContextUpdate（用量逐 turn 更新）', async () => {
      const onContextUpdate = vi.fn()
      const { adapter } = createAdapter_m4_m4({ onContextUpdate })
      // 模拟 3 个 turn 的循环
      for (const input of [1000, 2000, 3000]) {
        adapter.attach({
          onEvent: (listener) => {
            listener(piEvent_m2_m2({
              type: 'turn_end',
              message: { role: 'assistant', usage: { input, output: 10, totalTokens: input + 10 } },
              toolResults: [],
            }))
            return () => {}
          },
        })
      }
      await flushAsync_m4_m4()

      expect(onContextUpdate).toHaveBeenCalledTimes(3)
      // 最后一次带最新用量（inputTokens = totalTokens，context 占用非增量 input）
      expect(onContextUpdate).toHaveBeenLastCalledWith('test-session-1', {
        inputTokens: 3010,
        totalTokens: 3010,
      })
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // FR-5 / RT-2#2: message_update error（pi wire 真实形状）
  // wire 实发 = {type:'error', reason:'aborted'|'error', error:AssistantMessage}
  // （权威源 pi-ai 0.84.4 dist/types.d.ts AssistantMessageEvent error 变体；json-event.js
  // 只剥 partial）。fixture 的 error 子对象只带 adapter 消费的 errorMessage 子集——完整
  // AssistantMessage 另有 role/content/usage 等字段（PiErrorSubEvent 局部形态同款取舍）。
  // reason 分流：error（provider 真错）→ message.stream_error；aborted（用户中止）→ noop
  // （中止由 message_end/agent_end 的 stopReason='aborted' 通路收尾，非 error 终态）。
  // [HISTORICAL] 旧 fixture `{type:'error', content:'...'}` 是 pi 从不发送的形状：生产读
  // sub.content 恒 undefined，测试绿而 provider 真错文本（401/限流/上下文溢出）永不显形。
  // ════════════════════════════════════════════════════════════════════

  describe('FR-5: message_update — error sub-type (real pi wire shape)', () => {
    it('error 分支：error.errorMessage 透传为 content，kind=error（provider 真错）', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'error',
          reason: 'error',
          error: { errorMessage: '401 Unauthorized: invalid api key' },
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.stream_error')
      // payload 形状与 shared/protocol 契约对齐：kind（分类）+ content（人类可读）
      expect(sent[0].payload).toMatchObject({
        kind: 'error',
        content: '401 Unauthorized: invalid api key',
      })
    })

    it('aborted 分支：降级 noop 不产 stream_error 帧（中止由 agent_end stopReason 通路收尾）', async () => {
      dispatchOne_m3_m3(adapter, {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'error',
          reason: 'aborted',
          error: {},
        },
      })
      await flushAsync_m4_m4()

      // 中止不是流错误：不产帧 = 前端不 finalizeSession('stream_error')（主动中止不翻 error
      // 红条），枚举串 'aborted' 也无从经 content 进用户可见错误文本
      expect(sent).toHaveLength(0)
    })
  })

  // ════════════════════════════════════════════════════════════════════
})
})
describe('event-adapter-extension', () => {
/**
 * Task 2 tests: EventAdapter extension event translation.
 *
 * Verifies that:
 * 1. extension_ui_request dialog 族（confirm/select/input/editor）→ extension.dialog 帧
 *    （pi1-disposition-chat-flow D6：载荷判别字段 dialogKind，taiji 词表）
 * 2. extension_ui_request with setStatus/setWidget → 各自独立帧（不进 dialog 族）
 * 3. extension_error → extension.error ServerMessage
 * 4. tool_execution_update → message.tool_call_update ServerMessage
 * 5. Original mapping of confirm/select to a tool-call-pending message is REMOVED
 *    (asserted positively: confirm/select produce ONLY extension.dialog, no other types)
 * 6. All ServerMessages include sessionId
 */

/** Pi extension events carry extra fields not in PiMessage, so we widen for tests */
type PiTestEvent_m4_m4 = PiMessage & Record<string, unknown>

/** Helper to create event objects that satisfy PiMessage + extra pi fields */
function piEvent_m2_m2(fields: PiTestEvent_m4_m4): PiTestEvent_m4_m4 {
  return fields
}

function createAdapter_m4_m4(): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send)
  return { adapter, sent }
}

/** Wait for async handleEvent to flush */
const flushAsync_m4_m4 = () => new Promise<void>(r => setTimeout(r, 0))

describe('EventAdapter: extension event translation', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const result = createAdapter_m4_m4()
    adapter = result.adapter
    sent = result.sent
  })

  // ── extension_ui_request → extension.dialog ──────────────

  describe('extension_ui_request (dialog family)', () => {
    it('translates confirm method to extension.dialog (dialogKind=confirm)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'extension_ui_request',
            method: 'confirm',
            id: 'req-1',
            title: 'Allow file access?',
            message: 'Extension wants to read /tmp/test.txt',
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.dialog')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        requestId: 'req-1',
        dialogKind: 'confirm',
        title: 'Allow file access?',
        message: 'Extension wants to read /tmp/test.txt',
      })
    })

    it('translates select method to extension.dialog (dialogKind=select)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'extension_ui_request',
            method: 'select',
            id: 'req-2',
            title: 'Pick an option',
            // pi select 严格传 string[]（types.ts select 签名 + rpc-mode.js 原样透传）
            options: ['A', 'B'],
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.dialog')
      const payload = sent[0].payload as Record<string, unknown>
      expect(payload.dialogKind).toBe('select')
      // options 透传 string[]（.map(String)，不再 .map(o=>o.label) 拍扁）
      expect(payload.options).toEqual(['A', 'B'])
    })

    it('translates input method to extension.dialog (dialogKind=input)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'extension_ui_request',
            method: 'input',
            id: 'req-3',
            title: 'Enter a value',
            default: 'placeholder text',
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.dialog')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        requestId: 'req-3',
        dialogKind: 'input',
        title: 'Enter a value',
        default: 'placeholder text',
      })
    })

    it('translates notify method to extension:notify (fire-and-forget, separate family)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'extension_ui_request',
            method: 'notify',
            id: 'req-4',
            message: 'Operation completed',
            notifyType: 'warning',
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      // notify 是 fire-and-forget（pi 不等回复），走独立 extension:notify WS 帧
      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:notify')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        message: 'Operation completed',
        level: 'warn',
      })
    })

    it('produces ONLY extension.dialog for confirm (no tool-call-pending mapping)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'extension_ui_request',
            method: 'confirm',
            id: 'req-5',
            title: 'Allow?',
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      // 正向断言：confirm 只产出 extension.dialog，不调染 tool-call 状态（旧 pending 映射已移除）
      expect(sent.map((m) => m.type)).toEqual(['extension.dialog'])
    })

    it('produces ONLY extension.dialog for select (no tool-call-pending mapping)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'extension_ui_request',
            method: 'select',
            id: 'req-6',
            options: [{ label: 'X', value: 'x' }],
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent.map((m) => m.type)).toEqual(['extension.dialog'])
    })
  })

  // ── extension_ui_request (fire-and-forget methods) ─────────────────────

  describe('extension_ui_request (fire-and-forget methods)', () => {
    it('ignores setStatus (status bar retired, silent noop, no WS frame)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'extension_ui_request',
            method: 'setStatus',
            id: 'req-d1',
            statusKey: 'status-key',
            statusText: 'some status',
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(0)
    })

    it('bridges setWidget to extension.widget WS event', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'extension_ui_request',
            method: 'setWidget',
            id: 'req-d2',
            widgetKey: 'widget-key',
            widgetLines: ['line1', 'line2'],
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:widget')
      const widgetPayload = sent[0].payload as { widgetKey: string; lines: string[] }
      expect(widgetPayload.widgetKey).toBe('widget-key')
      expect(widgetPayload.lines).toEqual(['line1', 'line2'])
    })
  })

  // ── extension_error → extension.error ─────────────────────────

  describe('extension_error', () => {
    it('translates extension_error to extension.error', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'extension_error',
            extensionPath: 'my-extension',
            error: 'Extension crashed unexpectedly',
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.error')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-1',
        extensionName: 'my-extension',
        error: 'Extension crashed unexpectedly',
      })
    })

    it('handles extension_error without sessionId in raw event', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'extension_error',
            extensionPath: 'ext-2',
            error: 'some error',
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        extensionName: 'ext-2',
      })
    })
  })

  // ── tool_execution_update → message.tool_call_update ──────────

  describe('tool_execution_update', () => {
    it('translates tool_execution_update to message.tool_call_update', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'tool_execution_update',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            partialResult: 'partial content here',
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_update')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-1',
        toolCallId: 'tc-1',
        detail: 'partial content here',
      })
    })

    it('handles tool_execution_update without partialResult', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'tool_execution_update',
            toolCallId: 'tc-2',
            toolName: 'search',
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_update')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        toolCallId: 'tc-2',
      })
    })
  })

  // ── SessionId injection ────────────────────────────────────────

  describe('sessionId injection', () => {
    it('injects constructor sessionId into all extension messages', async () => {
      const localSent: ServerMessage[] = []
      const localSend: WsSender = (msg) => { localSent.push(msg) }
      const localAdapter = createEventAdapter('custom-session-42', localSend)

      localAdapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({ type: 'extension_error', extensionPath: 'e', error: 'err' }))
          listener(piEvent_m2_m2({ type: 'extension_ui_request', method: 'confirm', id: 'r1' }))
          listener(piEvent_m2_m2({ type: 'tool_execution_update', toolCallId: 'tc1', toolName: 't' }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      for (const msg of localSent) {
        expect((msg.payload as Record<string, unknown>).sessionId).toBe('custom-session-42')
      }
    })
  })

  // ── Non-extension events unchanged ─────────────────────────────

  describe('non-extension events (regression)', () => {
    it('still translates tool_execution_start correctly', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'tool_execution_start',
            toolCallId: 'tc-reg',
            toolName: 'write_file',
            args: { path: '/tmp/x' },
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_start')
      // [w21] payload 换 toolCall entry 形态（event-adapter 翻译时重构）
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        entry: {
          type: 'toolCall',
          toolCallId: 'tc-reg',
          toolName: 'write_file',
        },
      })
    })

    it('still translates status events correctly', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent_m2_m2({
            type: 'status',
            status: 'thinking',
            detail: 'processing',
          }))
          return () => {}
        },
      })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.status')
    })
  })
})
})
describe('event-adapter-message-stream', () => {
/**
 * EventAdapter message_update / message_start / message_end 定向测试（CRAP 检查清单：
 * handleMessageUpdate / handleMessageStart / handleMessageEnd）。
 *
 * 已有覆盖：FR-5 error sub-type、FR-2 customType 透传、toolResult/user role 忽略、
 * toolcall_end 锚点（equivalence/tool-call-index）。本文件补齐 sub-type 翻译矩阵的
 * 其余分支与 message_start 的畸形字段检查（type-safety review：来源是 extension 第三方
 * 代码，畸形值不得以谎报类型进 wire 帧）：
 * - text_delta / thinking_delta：delta 缺省空串 + contentIndex 锚点透传（D-2 合帧依据）
 * - thinking_start / thinking_end：载荷形态（含 contentIndexAnchor 缺省不产字段）
 * - toolcall_start / toolcall_delta / text_start / text_end：noop（噪声抑制）
 * - 未知 sub-type：warn + noop（不崩）
 * - customStart 畸形检查：customType 非字符串不误入 custom 分支、details 数组/原始值 →
 *   undefined、content 非字符串 → undefined、display 非布尔 → undefined
 * - message_end role 白名单（R3 business-logic INFO）：allowed role 通过（user/assistant/
 *   toolResult 全量下发）、未建模 role（bashExecution 等）warn + 跳过（双计防线）、
 *   customType 判定优先于白名单（对齐 handleMessageStart）、畸形 message warn + 降级丢弃
 *
 * 运行：cd packages/runtime && npx vitest run test/event-adapter-message-stream.test.ts
 */
// 帧收窄：sent 元素是宽联合 ServerMessage（payload 全联合），按 type 断言到判别联合
// 成员后 payload 形状取自 protocol SSOT（ServerMessageMap），不手写字段形状。
type CustomStartFrame = Extract<ServerMessageUnion, { type: 'message.customStart' }>
type MessageStartFrame = Extract<ServerMessageUnion, { type: 'message.message_start' }>

type PiTestEvent_m4_m4 = PiMessage & Record<string, unknown>

function createAdapter_m4_m4(options?: EventAdapterOptions): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send, options)
  return { adapter, sent }
}

const flushAsync_m4_m4 = () => new Promise<void>(r => setTimeout(r, 0))

function dispatchOne_m3_m3(adapter: EventAdapter, event: PiTestEvent_m4_m4): void {
  adapter.attach({
    onEvent: (listener) => {
      listener(event)
      return () => {}
    },
  })
}

function messageUpdate(sub: Record<string, unknown>): PiTestEvent_m4_m4 {
  return { type: 'message_update', assistantMessageEvent: sub }
}

const SID_m2 = 'test-session-1'

describe('message_update sub-type 翻译矩阵（handleMessageUpdate）', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const r = createAdapter_m4_m4()
    adapter = r.adapter
    sent = r.sent
  })

  it('text_delta：delta 透传 + contentIndex 锚点透传（有序插入锚点）', async () => {
    dispatchOne_m3_m3(adapter, messageUpdate({ type: 'text_delta', delta: 'hel', contentIndex: 2 }))
    await flushAsync_m4_m4()
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.text_delta')
    expect(sent[0].payload).toEqual({ sessionId: SID_m2, delta: 'hel', contentIndex: 2 })
  })

  it('text_delta：delta 缺省空串 + 无 contentIndex 不产锚点字段（payload 形态稳定）', async () => {
    dispatchOne_m3_m3(adapter, messageUpdate({ type: 'text_delta' }))
    await flushAsync_m4_m4()
    expect(sent[0].payload).toEqual({ sessionId: SID_m2, delta: '' })
  })

  it('thinking_delta：delta + contentIndex 同构透传（W07 微项 1：与 text_delta 对齐）', async () => {
    dispatchOne_m3_m3(adapter, messageUpdate({ type: 'thinking_delta', delta: 'reason', contentIndex: 0 }))
    await flushAsync_m4_m4()
    expect(sent[0].type).toBe('message.thinking_delta')
    expect(sent[0].payload).toEqual({ sessionId: SID_m2, delta: 'reason', contentIndex: 0 })
  })

  it('thinking_start：contentIndex 有则透传、无则不产字段；thinking_end：无锚点字段', async () => {
    dispatchOne_m3_m3(adapter, messageUpdate({ type: 'thinking_start', contentIndex: 1 }))
    await flushAsync_m4_m4()
    expect(sent[0].type).toBe('message.thinking_start')
    expect(sent[0].payload).toEqual({ sessionId: SID_m2, contentIndex: 1 })

    const r2 = createAdapter_m4_m4()
    dispatchOne_m3_m3(r2.adapter, messageUpdate({ type: 'thinking_start' }))
    await flushAsync_m4_m4()
    expect(r2.sent[0].payload).toEqual({ sessionId: SID_m2 })

    const r3 = createAdapter_m4_m4()
    dispatchOne_m3_m3(r3.adapter, messageUpdate({ type: 'thinking_end' }))
    await flushAsync_m4_m4()
    expect(r3.sent[0].type).toBe('message.thinking_end')
    expect(r3.sent[0].payload).toEqual({ sessionId: SID_m2 })
  })

  it('噪声 sub-type（toolcall_start/delta、text_start/end）→ noop：零 WS 帧产出', async () => {
    for (const type of ['toolcall_start', 'toolcall_delta', 'text_start', 'text_end']) {
      dispatchOne_m3_m3(adapter, messageUpdate({ type }))
    }
    await flushAsync_m4_m4()
    expect(sent).toEqual([])
  })

  it('未知 sub-type → warn + noop（不崩、不断流）', async () => {
    expect(() => dispatchOne_m3_m3(adapter, messageUpdate({ type: 'future_subtype' }))).not.toThrow()
    await flushAsync_m4_m4()
    expect(sent).toEqual([])
  })

  it('assistantMessageEvent 缺失 → noop（防御：异常帧不产 WS 消息）', async () => {
    dispatchOne_m3_m3(adapter, { type: 'message_update' })
    await flushAsync_m4_m4()
    expect(sent).toEqual([])
  })
})

describe('message_start 畸形字段检查（handleMessageStart custom 分支）', () => {
  it('customType 非字符串（number / null）→ 不走 custom 分支，按 assistant turn 产 message_start', async () => {
    const { adapter, sent } = createAdapter_m4_m4()
    dispatchOne_m3_m3(adapter, { type: 'message_start', message: { customType: 123, content: 'x' } })
    await flushAsync_m4_m4()
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.message_start') // fallback 分支（非 customStart）
    const start = sent[0] as MessageStartFrame
    expect(start.payload.messageId).toMatch(/^a-/) // 生成 messageId 供 file_changes 挂载
  })

  it('details 畸形（数组 / 原始值）→ customStart 帧 details 缺省（不透传谎报类型）', async () => {
    for (const bad of [[1, 2], 'string-details', 42]) {
      const { adapter, sent } = createAdapter_m4_m4()
      dispatchOne_m3_m3(adapter, { type: 'message_start', message: { customType: 'subagent-bg-notify', details: bad } })
      await flushAsync_m4_m4()
      expect(sent[0].type).toBe('message.customStart')
      const custom = sent[0] as CustomStartFrame
      expect(custom.payload.details).toBeUndefined()
    }
  })

  it('content 非字符串 / display 非布尔 → 对应字段缺省（customType 合法仍走 custom 分支）', async () => {
    const { adapter, sent } = createAdapter_m4_m4()
    dispatchOne_m3_m3(adapter, {
      type: 'message_start',
      message: { customType: 'workflow-result', content: 99, display: 'yes' },
    })
    await flushAsync_m4_m4()
    expect(sent[0].type).toBe('message.customStart')
    const custom = sent[0] as CustomStartFrame
    expect(custom.payload.customType).toBe('workflow-result')
    expect(custom.payload.content).toBeUndefined()
    expect(custom.payload.display).toBeUndefined()
  })

  it('msg 有但无 role 且无 customType（assistant turn 变体）→ fallback messageId 路径', async () => {
    const { adapter, sent } = createAdapter_m4_m4()
    dispatchOne_m3_m3(adapter, { type: 'message_start', message: { summary: 'partial' } })
    await flushAsync_m4_m4()
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.message_start')
    const start = sent[0] as MessageStartFrame
    expect(start.payload.messageId).toMatch(/^a-/)
  })
})

// ── message_end role 白名单（R3 business-logic INFO：S2 双计防线直接断言）──
// pi 0.84.1 实证未建模 role（bashExecution/compactionSummary/branchSummary）不经 message_end，
// 但该假设此前只存在于注释——白名单把它升级为结构防线：若未来 pi 行为漂移补发这些 role，
// 未列 role 必须被跳过（否则 registry applyEntry 与 bashResultEffect 等既有 effect 双计）。

describe('message_end role 白名单（handleMessageEnd）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('allowed role（user/assistant/toolResult）→ message.message_end 帧（entry 实时 feed 载体）', async () => {
    for (const role of ['user', 'assistant', 'toolResult']) {
      const { adapter, sent } = createAdapter_m4_m4()
      const ts = 1_755_000_000_000
      const message = { role, content: 'hello', timestamp: ts }
      dispatchOne_m3_m3(adapter, { type: 'message_end', message })
      await flushAsync_m4_m4()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.message_end')
      // entry 形状：type message / parentId null / message 原样透传（reducer 输入 = 持久化
      // entry 同构）。timestamp = 到达时刻（live ≡ reload 同源语义，8e844eaa9）：pi message
      // 级 timestamp 是消息开始时刻，JSONL entry 级是追加时刻，合成 entry 镜像后者
      const payload = sent[0].payload as { sessionId: string; entry: { type: string; parentId: null; timestamp: string; message: unknown } }
      expect(payload).toEqual({
        sessionId: SID_m2,
        entry: { type: 'message', parentId: null, timestamp: expect.any(String), message },
      })
      expect(Math.abs(Date.parse(payload.entry.timestamp) - Date.now())).toBeLessThan(5000)
    }
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('未建模 role（bashExecution/compactionSummary）→ warn + 跳过：零 WS 帧（双计防线）', async () => {
    const { adapter, sent } = createAdapter_m4_m4()
    for (const role of ['bashExecution', 'compactionSummary', 'branchSummary']) {
      dispatchOne_m3_m3(adapter, { type: 'message_end', message: { role, content: 'x' } })
    }
    await flushAsync_m4_m4()

    expect(sent).toEqual([]) // 不产任何 WS 帧（含 noop 帧也不上 wire）
    for (const role of ['bashExecution', 'compactionSummary', 'branchSummary']) {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`message_end with unmodeled role '${role}', skipping (dual-count guard`),
      )
    }
  })

  it('customType 判定：role 不在白名单但 customType 存在 → 放行（custom 以 customType 为权威标识，对齐 handleMessageStart）', async () => {
    const { adapter, sent } = createAdapter_m4_m4()
    // pi custom message 的 role 形如 'custom'（不在白名单），权威标识是 customType 字段
    const message = { role: 'custom', customType: 'subagent-bg-notify', content: 'bg done' }
    dispatchOne_m3_m3(adapter, { type: 'message_end', message })
    await flushAsync_m4_m4()

    expect(sent).toHaveLength(1)
    const end = sent[0] as Extract<ServerMessageUnion, { type: 'message.message_end' }>
    expect(sent[0].type).toBe('message.message_end')
    expect(end.payload.entry.message).toEqual(message)
    expect(warnSpy).not.toHaveBeenCalled() // custom 放行不是告警路径
  })

  it('畸形 message（缺失 / role 非字符串）→ warn + noop 降级丢弃（不中断事件流）', async () => {
    const { adapter, sent } = createAdapter_m4_m4()
    dispatchOne_m3_m3(adapter, { type: 'message_end' }) // message 缺失（pi 契约外）
    dispatchOne_m3_m3(adapter, { type: 'message_end', message: { role: 42 } }) // role 非字符串
    await flushAsync_m4_m4()

    expect(sent).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('message_end without message or role, skipping'))
  })
})
})
describe('event-adapter-toolresult', () => {
/**
 * EventAdapter: toolResult message_start 语义修正测试。
 *
 * 根因：pi agent-core 每个工具执行完会 emit message_start{message:{role:'toolResult'}} +
 * message_end{message:{role:'toolResult'}}（agent-loop.js emitToolResultMessage）。
 * event-adapter 的 handleMessageStart 兜底分支把 toolResult 当 assistant turn 翻译，
 * 产出无意义的 message.message_start（前端建空 assistant message），
 * 干扰 findLastAssistantIndex 导致后续 tool_call_end 匹配错位。
 *
 * 修正：role==='toolResult' 不转发（return null）——前端已通过 tool_execution_end
 * 拿到 output，toolResult message_start 是 pi 内部记账，对前端是噪声。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/event-adapter-toolresult.test.ts
 */
type PiTestEvent_m4_m4 = PiMessage & Record<string, unknown>

function createAdapter_m4_m4(): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send)
  return { adapter, sent }
}

const flushAsync_m4_m4 = () => new Promise<void>(r => setTimeout(r, 0))

function dispatchOne_m3_m3(adapter: EventAdapter, event: PiTestEvent_m4_m4): void {
  adapter.attach({
    onEvent: (listener) => {
      listener(event)
      return () => {}
    },
  })
}

describe('EventAdapter: toolResult message_start 语义修正', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const result = createAdapter_m4_m4()
    adapter = result.adapter
    sent = result.sent
  })

  it('U1: role=toolResult 的 message_start 不转发到前端', async () => {
    dispatchOne_m3_m3(adapter, {
      type: 'message_start',
      message: {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: '文件内容' }],
        isError: false,
        timestamp: Date.now(),
      },
    })
    await flushAsync_m4_m4()

    // toolResult 是 pi 内部记账（agent-loop emitToolResultMessage），
    // 前端已通过 tool_execution_end 拿到 output，不应再建空 assistant message
    expect(sent).toHaveLength(0)
  })

  it('U2: 无 role 的 assistant turn message_start 仍正常产出（回归保护）', async () => {
    dispatchOne_m3_m3(adapter, {
      type: 'message_start',
      message: undefined,
    })
    await flushAsync_m4_m4()

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.message_start')
    expect(sent[0].payload).toHaveProperty('messageId')
  })

  it('U4: tool_execution_end → message_start(toolResult) → message_start(assistant) 序列', async () => {
    // 模拟 agent-loop.js:261-266 的真实事件序列：
    // tool_execution_end（带 output）→ message_start(toolResult) → message_start(assistant turn)
    dispatchOne_m3_m3(adapter, {
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'done' }] },
      isError: false,
    })
    dispatchOne_m3_m3(adapter, {
      type: 'message_start',
      message: {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      },
    })
    dispatchOne_m3_m3(adapter, {
      type: 'message_start',
      message: undefined, // 下一个 assistant turn
    })
    await flushAsync_m4_m4()

    // tool_execution_end 产出 message.tool_call_end（带 output，前端据此更新 toolCall）
    // toolResult message_start 不产出（噪声过滤）
    // assistant turn message_start 产出 message.message_start
    expect(sent).toHaveLength(2)
    expect(sent[0].type).toBe('message.tool_call_end')
    // [w21] payload 换 toolResult message entry 形态（isError:false ≡ status:'completed'）
    expect(sent[0].payload).toMatchObject({ entry: { type: 'message', message: { toolCallId: 'tc-1', isError: false } } })
    expect(sent[1].type).toBe('message.message_start')
  })
})
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('event-adapter-dialog-kind', () => {
// ── D6 映射表全覆盖（translate 纯函数层）────────────────────────

describe('D6 mapping table: dialog family → extension.dialog', () => {
  const dialogCases = [
    { method: 'select', extras: { options: ['a', 'b'] } },
    { method: 'confirm', extras: { message: 'sure?' } },
    { method: 'input', extras: { placeholder: 'type here' } },
    { method: 'editor', extras: { prefill: 'draft' } },
  ] as const

  for (const { method, extras } of dialogCases) {
    it(`${method} → extension.dialog with dialogKind='${method}' (no pi method name in frame)`, () => {
      const events = translate({ type: 'extension_ui_request', method, id: 'req-1', title: 'T', ...extras } as PiTestEvent_m5 as never, SID_m2)
      const frames = events.filter((e) => e.kind === 'message')
      expect(frames).toHaveLength(1)
      const msg = (frames[0] as { message: ServerMessage }).message
      expect(msg.type).toBe('extension.dialog')
      const payload = msg.payload as Record<string, unknown>
      expect(payload.dialogKind).toBe(method)
      // pi 词汇止点：帧载荷不携带 method 字段
      expect(payload).not.toHaveProperty('method')
      expect(payload.sessionId).toBe(SID_m2)
      expect(payload.requestId).toBe('req-1')
      // title 随帧透传（纯展示；marker 约定串不落在本用例——普通对话框 title 无路由职责）
      expect(payload.title).toBe('T')
    })
  }

  it('dialog frame pairs with the internal extension-ui routing event (dialogKind + method in sync)', () => {
    const events = translate({ type: 'extension_ui_request', method: 'confirm', id: 'req-2' } as PiTestEvent_m5 as never, SID_m2)
    const internal = events.find((e) => e.kind === 'extension-ui') as { method: string; payload: Record<string, unknown> }
    expect(internal).toBeTruthy()
    expect(internal.method).toBe('confirm') // runtime 内部回调参数（通用词）
    expect(internal.payload.dialogKind).toBe('confirm') // wire 帧字段（taiji 词表）
  })

  it('select + UI_FORM_MARKER → extension.dialog + form:true + dialogKind=select', () => {
    const formPayload = JSON.stringify({ formQuestions: [{ type: 'text', question: 'q1' }], allowCancel: false })
    const events = translate({ type: 'extension_ui_request', method: 'select', id: 'req-3', title: UI_FORM_MARKER, options: [formPayload] } as PiTestEvent_m5 as never, SID_m2)
    const frames = events.filter((e) => e.kind === 'message')
    expect(frames).toHaveLength(1)
    const msg = (frames[0] as { message: ServerMessage }).message
    expect(msg.type).toBe('extension.dialog')
    const payload = msg.payload as Record<string, unknown>
    expect(payload.form).toBe(true)
    expect(payload.dialogKind).toBe('select')
    expect(payload).not.toHaveProperty('method')
    expect(Array.isArray(payload.formQuestions)).toBe(true)
  })
})
describe('D6 mapping table: notify / setWidget / setStatus / set_editor_text / setTitle', () => {
  it('notify → extension:notify（出口与载荷零变化：sessionId/message/level，无 kind/dialogKind）', () => {
    const events = translate({ type: 'extension_ui_request', method: 'notify', id: 'req-n', message: 'hello', notifyType: 'warning' } as PiTestEvent_m5 as never, SID_m2)
    const frames = events.filter((e) => e.kind === 'message')
    expect(frames).toHaveLength(1)
    const msg = (frames[0] as { message: ServerMessage }).message
    expect(msg.type).toBe('extension:notify')
    expect(msg.payload).toEqual({ sessionId: SID_m2, message: 'hello', level: 'warn' })
  })

  it('setWidget（纯文本）→ extension:widget（载荷零变化：sessionId/widgetKey/lines，无 kind）', () => {
    const events = translate({ type: 'extension_ui_request', method: 'setWidget', id: 'req-w', widgetKey: 'k', widgetLines: ['l1'] } as PiTestEvent_m5 as never, SID_m2)
    const frames = events.filter((e) => e.kind === 'message')
    expect(frames).toHaveLength(1)
    const msg = (frames[0] as { message: ServerMessage }).message
    expect(msg.type).toBe('extension:widget')
    expect(msg.payload).toEqual({ sessionId: SID_m2, widgetKey: 'k', lines: ['l1'] })
  })

  it('setStatus → noop（状态栏退役，静默忽略不产帧）', () => {
    const events = translate({ type: 'extension_ui_request', method: 'setStatus', id: 'req-s', statusKey: 'model', statusText: 'gpt-x' } as PiTestEvent_m5 as never, SID_m2)
    expect(events).toEqual([{ kind: 'noop' }])
  })

  it('set_editor_text → extension:setEditorText（载荷零变化，无 kind）', () => {
    const events = translate({ type: 'extension_ui_request', method: 'set_editor_text', id: 'req-e', text: 'body' } as PiTestEvent_m5 as never, SID_m2)
    const frames = events.filter((e) => e.kind === 'message')
    expect(frames).toHaveLength(1)
    const msg = (frames[0] as { message: ServerMessage }).message
    expect(msg.type).toBe('extension:setEditorText')
    expect(msg.payload).toEqual({ sessionId: SID_m2, text: 'body' })
  })

  it('setTitle → warn + noop（宿主不实现，无出口）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events = translate({ type: 'extension_ui_request', method: 'setTitle', id: 'req-t', title: 'win title' } as PiTestEvent_m5 as never, SID_m2)
      expect(events).toEqual([{ kind: 'noop' }])
      expect(warnSpy).toHaveBeenCalledTimes(1)
      // warn 形态：前缀串 + method 值两参（保留 pi 升级语义可诊断）
      expect(warnSpy.mock.calls[0]?.slice(0, 2).join(' ')).toContain('setTitle')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('未知 method → warn + noop（兜底保持）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events = translate({ type: 'extension_ui_request', method: 'future_method', id: 'req-u' } as PiTestEvent_m5 as never, SID_m2)
      expect(events).toEqual([{ kind: 'noop' }])
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
describe('D6 mapping table: runtime-internal marker channels (no frontend broadcast)', () => {
  it('select + SESSION_MANAGER_MARKER → session-manager-ui 内部 kind，零 WS 帧', () => {
    const payload = JSON.stringify({ action: 'list', params: {} })
    const events = translate({ type: 'extension_ui_request', method: 'select', id: 'req-sm', title: SESSION_MANAGER_MARKER, options: [payload] } as PiTestEvent_m5 as never, SID_m2)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('session-manager-ui')
    expect(events.filter((e) => e.kind === 'message')).toHaveLength(0)
  })

  it('select + SUBAGENT_INFLIGHT_MARKER → 翻译层检查零输出（旁路消费）', () => {
    const payload = JSON.stringify({ sessionId: 'p1', records: [] })
    const events = translate({ type: 'extension_ui_request', method: 'select', id: 'req-inf', title: SUBAGENT_INFLIGHT_MARKER, options: [payload] } as PiTestEvent_m5 as never, SID_m2)
    expect(events).toEqual([])
  })
})
describe('stdout single-path exactly-once (six migrated event families)', () => {
  it('agent_start / agent_end / message_end / turn_end / tool_execution_start / tool_execution_end 各恰一次 onPiEvent', async () => {
    const { interpreter, hookCalls } = setup()
    const piEventNames = (ctx: Record<string, unknown>) => String(ctx.event)

    // 逐类投递单个事件（经 translate 全链路：构造 pi 原始事件形态 → interpreter.interpret）
    const feeds: PiTestEvent_m5[] = [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant' } }, // assistant turn 开始（产出 turn-start + message.message_start）
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
      { type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { cmd: 'ls' } },
      { type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() },
      },
      { type: 'turn_end', message: { usage: { input: 1, output: 1, totalTokens: 2 } } },
      {
        type: 'agent_end',
        willRetry: false,
        messages: [{ stopReason: 'stop', usage: { input: 1, output: 1, totalTokens: 3 }, content: [{ type: 'text', text: 'hi' }] }],
      },
    ]
    for (const ev of feeds) {
      // 直用 translate：与生产 EventAdapter.attach 同一翻译入口（纯函数，无旁路消费差异）
      interpreter.interpret(translate(ev as never, SID_m2))
    }
    // tool-call-* 的 hook 改写是异步 handler（void 调用）——flush microtasks 后断言
    await new Promise((r) => setTimeout(r, 0))

    const onPiCalls = hookCalls.filter((c) => c.hookType === 'onPiEvent')
    const byEvent = new Map<string, number>()
    for (const c of onPiCalls) {
      const name = piEventNames(c.context)
      byEvent.set(name, (byEvent.get(name) ?? 0) + 1)
    }

    // 六类迁移事件各自恰一次（bridge 曾转发 → 现在 stdout 单通路零重复）
    for (const name of ['agent_start', 'agent_end', 'message_end', 'turn_end', 'tool_execution_start', 'tool_execution_end']) {
      expect(byEvent.get(name)).toBe(1)
    }
    // 无其他事件名混入（六类迁移事件是本次断言全集；tool_execution_update 等不在迁移清单）
    expect(byEvent.size).toBe(6)
  })

  it('message_end 登记点载荷 = 帧携带的 entry（与 reload 同构）', async () => {
    const { interpreter, hookCalls } = setup()
    const entry = { type: 'message', parentId: null, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [] } }
    interpreter.interpret([
      { kind: 'message', message: { type: 'message.message_end', payload: { sessionId: SID_m2, entry } } } as never,
    ])
    const call = hookCalls.find((c) => c.hookType === 'onPiEvent' && c.context.event === 'message_end')
    expect(call).toBeTruthy()
    expect(call!.context.entry).toEqual(entry)
  })

  it('同一 pi 事件批次内 message_end 恰一次（batch 复投不双触发）', async () => {
    const { interpreter, hookCalls } = setup()
    const ev = { type: 'message_end', message: { role: 'assistant', content: [], timestamp: Date.now() } }
    interpreter.interpret(translate(ev as never, SID_m2))
    const count = hookCalls.filter((c) => c.hookType === 'onPiEvent' && c.context.event === 'message_end').length
    expect(count).toBe(1)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('event-adapter-inflight', () => {
beforeEach(() => {
  inflightMirror.dropSession(SID_m3)
})
describe('event-adapter: subagent 在途帧旁路（D5）', () => {
  it('合法初始帧（count=0）→ 镜像条目 + ack，零前端广播（interpret 零调用）', () => {
    const { interpret, listener, ack } = attachAdapter()
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(0)], 'req-ack-1'))

    // 镜像：hasEverReported=true + inFlight=0（「在场且无在途」已证事实 → errs 不再触发）
    const entry = inflightMirror.query(SID_m3)
    expect(entry).toEqual({ injected: false, hasEverReported: true, inFlight: 0 })
    expect(inflightMirror.errsShape(SID_m3)).toBeNull()

    // ack：resolve INFLIGHT_REPORT_ACK（第三参 select → rpc-client 序列化为 value 字符串）
    expect(ack).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledWith('req-ack-1', INFLIGHT_REPORT_ACK, 'select')

    // 无任何前端广播副作用（帧不进翻译 → interpret 不被调用）
    expect(interpret).not.toHaveBeenCalled()
  })

  it('合法后续帧 → 绝对计数覆盖镜像（非增量）', () => {
    const { interpret, listener, ack } = attachAdapter()
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(3)]))
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(1)], 'req-ack-2'))
    expect(inflightMirror.query(SID_m3)?.inFlight).toBe(1)
    expect(ack).toHaveBeenCalledTimes(2)
    expect(interpret).not.toHaveBeenCalled()
  })

  it('translate() 直调 marker 帧 → 空输出（检查分支：绝不广播前端）', () => {
    const events = translate(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(0)]), SID_m3)
    expect(events).toEqual([])
    // 不产任何 message / extension-ui 事件（无广播、无弹窗、无 pending）
    expect(events.some(e => e.kind === 'message' || e.kind === 'extension-ui')).toBe(false)
  })

  it('同一帧经 translate 不写镜像（检查纯化：镜像只由 EventAdapter 旁路写）', () => {
    translate(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(5)]), SID_m3)
    expect(inflightMirror.query(SID_m3)).toBeUndefined()
  })
})
describe('event-adapter: 坏帧静默丢弃（不抛不镜像不 ack）', () => {
  it.each([
    ['payload 非 JSON', ['{not json']],
    ['options 为空', []],
    ['payload 非对象', ['42']],
    ['inFlight 为负', [JSON.stringify({ inFlight: -1, sessionId: SID_m3, emittedAt: 1 })]],
    ['inFlight 非整数', [JSON.stringify({ inFlight: 1.5, sessionId: SID_m3, emittedAt: 1 })]],
    ['缺 emittedAt', [JSON.stringify({ inFlight: 0, sessionId: SID_m3 })]],
  ])('%s → 静默丢弃', (_label, options) => {
    const { interpret, listener, ack } = attachAdapter()
    expect(() => listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, options))).not.toThrow()
    expect(inflightMirror.query(SID_m3)).toBeUndefined()
    expect(ack).not.toHaveBeenCalled()
    expect(interpret).not.toHaveBeenCalled()
  })

  it('sessionId 缺席/空串 → 丢弃整帧（u7a 契约：无法归属不镜像；不 ack 待重试）', () => {
    const { interpret, listener, ack } = attachAdapter()
    // 缺席：JSON 无 sessionId 键（注意不能用默认参 undefined——默认参会回落 SID_m3）
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [JSON.stringify({ inFlight: 2, emittedAt: 1 })], 'req-absent'))
    // 空串
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [JSON.stringify({ inFlight: 2, sessionId: '', emittedAt: 1 })], 'req-empty'))
    expect(inflightMirror.query(SID_m3)).toBeUndefined()
    expect(ack).not.toHaveBeenCalled()
    expect(interpret).not.toHaveBeenCalled()
  })

  it('坏帧后通道保持存活：后续合法帧照常写镜像 + ack', () => {
    const { interpret, listener, ack } = attachAdapter()
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, ['{not json'], 'req-bad'))
    listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(2)], 'req-good'))
    expect(inflightMirror.query(SID_m3)?.inFlight).toBe(2)
    expect(ack).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledWith('req-good', INFLIGHT_REPORT_ACK, 'select')
    expect(interpret).not.toHaveBeenCalled()
  })
})
describe('event-adapter: 旁路不误伤既有 UI 通道', () => {
  it('普通 select（无 marker）→ 旁路不吞，extension-ui + message 照常翻译', () => {
    const { interpret, listener } = attachAdapter()
    listener(makeFrame('Pick one', ['a', 'b'], 'req-plain'))
    expect(interpret).toHaveBeenCalledTimes(1)
    const kinds = (interpret.mock.calls[0][0] as Array<{ kind: string }>).map(e => e.kind)
    expect(kinds).toContain('extension-ui')
    expect(kinds).toContain('message')
  })

  it('marker title 但 method 非 select → 不识别为在途帧（不写镜像），UI 翻译不变', () => {
    const { interpret, listener } = attachAdapter()
    const frame = { type: 'extension_ui_request', method: 'input', id: 'req-input', title: SUBAGENT_INFLIGHT_MARKER, options: [reportPayload(1)] }
    listener(frame)
    expect(inflightMirror.query(SID_m3)).toBeUndefined()
    expect(interpret).toHaveBeenCalledTimes(1)
  })
})
describe('event-adapter: ack 通道缺省/异常不干扰事件流', () => {
  it('client 无 sendExtensionUiResponse（port 可选成员缺省）→ 不抛，镜像仍更新', () => {
    const { interpret, listener } = attachAdapter({ withAck: false })
    expect(() => listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(4)]))).not.toThrow()
    expect(inflightMirror.query(SID_m3)?.inFlight).toBe(4)
    expect(interpret).not.toHaveBeenCalled()
  })

  it('ack 发送抛错 → 旁路吞掉不外泄（镜像已写），后续事件照常处理', () => {
    const interpret = vi.fn()
    const adapter = new EventAdapter(SID_m3, interpret)
    let listener: (event: unknown) => void = () => {}
    adapter.attach({
      onEvent: (l: PiEventListener) => { listener = l as unknown as (event: unknown) => void; return () => {} },
      sendExtensionUiResponse: () => { throw new Error('pipe dead') },
    })
    expect(() => listener(makeFrame(SUBAGENT_INFLIGHT_MARKER, [reportPayload(1)]))).not.toThrow()
    expect(inflightMirror.query(SID_m3)?.inFlight).toBe(1)
    // 事件流存活：后续普通 select 照常翻译
    listener(makeFrame('Pick one', ['a']))
    expect(interpret).toHaveBeenCalledTimes(1)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})
});
// ======================================================================
// ← test/event-adapter-record-reconcile.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('event-adapter-record-reconcile', () => {
describe('event-adapter：agent_settled → record-reconcile-trigger（组合注册）', () => {
  it('agent_settled 输出 = [agent-settled, trace-trigger, record-reconcile-trigger]（原 handler 在前、追加在后）', () => {
    const out = translate({ type: 'agent_settled' } as PiEvent, 's1')
    expect(out).toEqual([
      { kind: 'agent-settled' },
      { kind: 'trace-trigger', trigger: 'agent_settled' },
      { kind: 'record-reconcile-trigger' },
    ])
  })

  it('entry_appended（record 主信号）不追加对账触发（对账路径不挂 entry 级信号）', () => {
    const out = translate(
      { type: 'entry_appended', entry: { type: 'custom', customType: 'subagent-record' } } as unknown as PiEvent,
      's1',
    )
    expect(out).toContainEqual({ kind: 'record-entry-appended', customType: 'subagent-record' })
    expect(out).toContainEqual({ kind: 'trace-trigger', trigger: 'entry_appended' })
    expect(out.some((ev) => ev.kind === 'record-reconcile-trigger')).toBe(false)
  })

  it('message_end 只追加 trace-trigger（trace 路径与对账路径不串扰）', () => {
    const out = translate({
      type: 'message_end',
      message: { id: 'm1', role: 'assistant', content: [] },
    } as unknown as PiEvent, 's1')
    expect(out.some((ev) => ev.kind === 'trace-trigger')).toBe(true)
    expect(out.some((ev) => ev.kind === 'record-reconcile-trigger')).toBe(false)
  })
})
describe('event-interpreter：record-reconcile-trigger → onRecordReconcile', () => {
  it('恰好一次、参数 = interpreter 持有 sid（非事件 payload 自报——事件无 payload）', () => {
    const onRecordReconcile = vi.fn()
    const interpreter = new EventInterpreter('sid-rec', { send: () => {}, onRecordReconcile })

    interpreter.interpret([{ kind: 'record-reconcile-trigger' }])

    expect(onRecordReconcile).toHaveBeenCalledTimes(1)
    expect(onRecordReconcile).toHaveBeenCalledWith('sid-rec')
  })

  it('未注入回调 no-op（存量单测装配不受新增 opts 影响）', () => {
    const sent: ServerMessage[] = []
    const interpreter = new EventInterpreter('sid-rec-2', { send: (m) => { sent.push(m) } })

    expect(() => interpreter.interpret([{ kind: 'record-reconcile-trigger' }])).not.toThrow()
    expect(sent).toEqual([])
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('occupancy-runtime', () => {
// ── Part A：occupancy 写原语（幂等合并 + 去重，经转移原语驱动） ────
// [u3b 挂点迁移] 原直调 updateSessionOccupancy（现为原语内部机制）的用例等价改写为经
// applySessionOccupancyTransition 驱动——合并/去重/兜底/null-safe 语义由原语内部复用同一
// 机制，断言点不变；细粒度逐行派生断言见 test/session-occupancy-transition.test.ts（u2）。

describe('occupancy 写原语（经转移原语驱动）', () => {
  let publish: ReturnType<typeof vi.fn<(sessionId: string, msg: ServerMessage) => void>>
  let session: IManagedSessionView

  beforeEach(() => {
    publish = vi.fn<(sessionId: string, msg: ServerMessage) => void>()
    session = makeMockSession()
  })

  it('写入目标值并广播全量四维帧（payload 与 shared protocol 形状一致）', () => {
    applySessionOccupancyTransition(session, { publish }, 'dispatching')
    expect(session.occupancy).toEqual({ turn: 'dispatching', compacting: false, bash: false, handingOff: false })
    expect(publish).toHaveBeenCalledTimes(1)
    const msg = publish.mock.calls[0][1] as ServerMessage
    expect(msg.type).toBe('session.occupancy')
    expect(msg.payload).toEqual({ sessionId: 's1', turn: 'dispatching', compacting: false, bash: false, handingOff: false })
  })

  it('值未变化时不重复广播（④）：重复写同值零帧，跨维度变化才发帧', () => {
    applySessionOccupancyTransition(session, { publish }, 'generating')
    applySessionOccupancyTransition(session, { publish }, 'generating') // 重复
    expect(occupancyFrames(publish)).toHaveLength(1)
    applySessionOccupancyTransition(session, { publish }, 'bash-start') // 跨维度（bash）
    applySessionOccupancyTransition(session, { publish }, 'bash-start') // 重复
    const frames = occupancyFrames(publish)
    expect(frames).toHaveLength(2)
    expect(frames[1]).toMatchObject({ turn: 'generating', bash: true }) // 全量四维合并
  })

  it('幂等写（②）：乱序/回退事件直写目标值不产生中间态', () => {
    // settling 中再收 turn-end（乱序重复）→ 仍 settling；agent-settled 迟到 → idle
    applySessionOccupancyTransition(session, { publish }, 'settling')
    applySessionOccupancyTransition(session, { publish }, 'settling')
    applySessionOccupancyTransition(session, { publish }, 'idle')
    expect(session.occupancy?.turn).toBe('idle')
    // retry/followUp 续跑：settling 中收到 turn-start（正常应不可能，幂等写直接落 generating）
    applySessionOccupancyTransition(session, { publish }, 'generating')
    expect(session.occupancy?.turn).toBe('generating')
  })

  it('occupancy 字段缺省（undefined）按 idle 兜底合并（存量 mock/构造点零改动）', () => {
    expect(session.occupancy).toBeUndefined()
    applySessionOccupancyTransition(session, { publish }, 'compacting-start')
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: true, bash: false, handingOff: false })
  })

  it('publish 未注入（null/undefined）时状态照写、广播跳过（null-safe）', () => {
    expect(() => applySessionOccupancyTransition(session, undefined, 'dispatching')).not.toThrow()
    expect(session.occupancy?.turn).toBe('dispatching')
    expect(() => applySessionOccupancyTransition(session, null, 'generating')).not.toThrow()
    expect(session.occupancy?.turn).toBe('generating')
  })
})
// ── Part B：interpreter 挂点 #2-#6（成功路径）────────────────────

describe('EventInterpreter occupancy 挂点（#2-#6）', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void
  // [u3b 挂点迁移] 回调传封闭转移枚举值（D2），合并/派生在原语内——断言转移类型而非 patch。
  let onOccupancyTransition: ReturnType<typeof vi.fn<(transition: SessionOccupancyTransition) => void>>

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
    onOccupancyTransition = vi.fn<(transition: SessionOccupancyTransition) => void>()
  })

  const makeInterpreter = () => new EventInterpreter('s1', { send, onOccupancyTransition })

  it('#2 turn-start → generating', () => {
    makeInterpreter().interpret([{ kind: 'turn-start', messageId: 'm1' }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('generating')
  })

  it('#3 turn-end → settling（onTurnFinalize 同点）', () => {
    makeInterpreter().interpret([{
      kind: 'turn-end',
      message: { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } } as ServerMessage,
      stopReason: 'end_turn',
    }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('settling')
  })

  it('#3 兜底：turn-end handler 早段抛错（send 抛）仍写 settling（interpret per-event catch）', () => {
    const throwingSend = vi.fn(() => { throw new Error('ws down') })
    const onTurnFinalize = vi.fn()
    const interpreter = new EventInterpreter('s1', {
      send: throwingSend,
      onTurnFinalize,
      onOccupancyTransition,
    })
    expect(() => interpreter.interpret([{
      kind: 'turn-end',
      message: { type: 'message.complete', payload: { sessionId: 's1' } } as ServerMessage,
    }])).not.toThrow()
    expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    expect(onOccupancyTransition).toHaveBeenCalledWith('settling')
  })

  it('#4 agent-settled → idle', () => {
    makeInterpreter().interpret([{ kind: 'agent-settled' }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('idle')
  })

  it('#5 compaction-start → compacting-start；⑤ session.compacting 帧保留', () => {
    makeInterpreter().interpret([{ kind: 'compaction-start', reason: 'manual' }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('compacting-start')
    expect(sent.map((m) => m.type)).toContain('session.compacting')
  })

  it('#6 compaction-end 三路复位 → compacting-end；⑤ session.compacted 帧保留', () => {
    const interpreter = makeInterpreter()
    // aborted 路（无 errorMessage 真值）
    interpreter.interpret([{ kind: 'compaction-end', reason: 'manual', aborted: true }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('compacting-end')
    expect(sent.map((m) => m.type)).toContain('session.compacted')
    // failed 路（errorMessage 真值）同样复位
    sent = []
    onOccupancyTransition.mockClear()
    interpreter.interpret([{ kind: 'compaction-end', reason: 'manual', aborted: false, errorMessage: 'boom' }])
    expect(onOccupancyTransition).toHaveBeenCalledWith('compacting-end')
    expect(sent.map((m) => m.type)).toContain('session.compacted')
  })

  it('真实接线形态：onOccupancyTransition → applySessionOccupancyTransition，端到端帧序与最终四维正确（含乱序重复）', () => {
    const publish = vi.fn()
    const session = makeMockSession()
    const interpreter = new EventInterpreter('s1', {
      send,
      onOccupancyTransition: (transition) => applySessionOccupancyTransition(session, { publish }, transition),
    })
    const complete = { type: 'message.complete', payload: { sessionId: 's1' } } as ServerMessage
    interpreter.interpret([
      { kind: 'turn-start', messageId: 'm1' },
      { kind: 'turn-end', message: complete, stopReason: 'end_turn' },
      { kind: 'turn-end', message: complete, stopReason: 'end_turn' }, // 重复 turn-end（乱序）
      { kind: 'agent-settled' },
    ])
    const frames = occupancyFrames(publish)
    expect(frames.map((f) => f.turn)).toEqual(['generating', 'settling', 'idle']) // 重复 settling 去重为一帧
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: false, bash: false, handingOff: false })
  })
})
// ── Part C：dispatcher 挂点 #1/#7/#8/#9/#10/#11（含失败路径）─────

describe('MessageDispatcher occupancy 挂点', () => {
  // [u2 投递所有权内核] 出厂交接 async 链持有的 500ms 持有轮询 timer 在用例间清理
  let cleanupRegistry: (() => void) | undefined

  afterEach(() => {
    cleanupRegistry?.()
    cleanupRegistry = undefined
  })

  function makeDispatcher(opts: {
    session?: IManagedSessionView
    promptError?: Error
    abortBehavior?: 'ok' | 'error' | 'rpc-timeout'
    bashBehavior?: 'ok' | 'error'
    compactBehavior?: 'ok' | 'error'
  } = {}) {
    const session = opts.session ?? makeMockSession()
    /** 时序记录（D-18：受理先于置位的帧序断言用）。 */
    const seq: string[] = []
    const promptFn = opts.promptError
      ? vi.fn(async () => { seq.push('prompt'); throw opts.promptError! })
      : vi.fn(async () => { seq.push('prompt'); return {} as unknown as Awaited<ReturnType<IPiEngine['prompt']>> })
    const bashFn = opts.bashBehavior === 'error'
      ? vi.fn(async () => { throw new Error('bash transport exploded') })
      : vi.fn(async () => ({ output: 'ok', exitCode: 0, cancelled: false, truncated: false }))
    const abortFn = opts.abortBehavior === 'rpc-timeout'
      ? vi.fn(async () => { throw new RpcTimeoutError('abort', 60000) })
      : opts.abortBehavior === 'error'
        ? vi.fn(async () => { throw new Error('EPIPE') })
        : vi.fn(async () => {})
    const compactFn = opts.compactBehavior === 'error'
      ? vi.fn(async () => { throw new Error('compact transport exploded') })
      : vi.fn(async () => ({ summary: 's', tokensBefore: 1, estimatedTokensAfter: 1 }))
    const client = {
      prompt: promptFn, bash: bashFn, abort: abortFn,
      abortBash: vi.fn(async () => {}), steer: vi.fn(async () => {}), followUp: vi.fn(async () => {}),
      compact: compactFn,
      // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）——fake 补齐接口成员
      touchActivity: vi.fn(),
    } as unknown as IPiEngine

    const svc: IDispatcherSessionOps = {
      ensureActive: vi.fn(async () => client),
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      clearSessionOutcome: vi.fn(),
      getSession: vi.fn(() => session),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const pm = {
      getClient: vi.fn(() => client),
      destroySession: vi.fn(async () => {}),
    } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const publish = vi.fn((_sid: string, msg: ServerMessage) => { seq.push(`frame:${msg.type}`) })
    // [u2 投递所有权内核] 出站交接经内核适配层（dispatcher 只提交；交接异步）——fixture 按真实
    // 装配接内核（session 视图 / ensureActive / workspace.record 与组合根同源）
    const registry = createSessionDeliveryRegistry({
      getSession: (sid) => svc.getSession(sid),
      ensureActive: svc.ensureActive as (sid: string) => Promise<IPiEngine>,
      subscribeAgentSettled: () => () => {},
      recordWorkspace: (cwd) => workspace.record(cwd),
      getMessageBus: () => ({ publish } as unknown as IMessageBus),
    })
    cleanupRegistry = () => registry.disposeAll()
    const dispatcher = new MessageDispatcher(svc, pm, workspace, { publish } as unknown as IMessageBus)
    dispatcher.setDeliveryRegistry(registry)
    return { dispatcher, session, svc, pm, publish, promptFn, bashFn, abortFn, compactFn, client, seq, registry }
  }

  it('#1 sendMessage 受理后 → turn=dispatching（[RT-4#10] occupancy 置位先于 prompt）', async () => {
    const { dispatcher, publish, promptFn, seq } = makeDispatcher()
    await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery()
    expect(promptFn).toHaveBeenCalled()
    const frames = occupancyFrames(publish)
    expect(frames).toEqual([{ sessionId: 's1', turn: 'dispatching', compacting: false, bash: false, handingOff: false }])
    // 帧序（[RT-4#10] 合并收尾）：occupancy 置位先于 prompt——RPC 往返窗内对预检/回收豁免
    // 不再呈 idle；lastActiveAt/record 记账侧（D-18「成功才显示 working」）仍在 prompt
    // 受理成功后（markSessionActive 尾置，occupancy 同值转移去重不二播）
    expect(seq.indexOf('prompt')).toBeGreaterThanOrEqual(0)
    expect(seq.indexOf('frame:session.occupancy')).toBeLessThan(seq.indexOf('prompt'))
  })

  it('#1 busy（generating）不再预检拒绝：零 send.rejected + 按 lane=steer 承接投递（D5 排队取代拒绝）', async () => {
    const { dispatcher, publish, promptFn, registry } = makeDispatcher({
      session: driveOccupancy(makeMockSession(), 'generating'),
    })
    await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery()
    // 退役路径：原「预检拒绝（busy）不写 dispatching + 广播 send.rejected」——排队取代拒绝（D5）
    expect(frameTypes(publish)).not.toContain('send.rejected')
    // 迁移侧：内核按 lane=steer 即时投递（turn 边界注入 pi 队列），条目不丢
    expect(promptFn).toHaveBeenCalledTimes(1)
    expect((promptFn.mock.calls[0] as unknown[])[2]).toBe('steer')
    expect(registry.entries('s1')?.active[0]).toMatchObject({ lane: 'steer' })
    // [D3① pi1-disposition-chat-flow] 生成中出站不写 occupancy：置位前置 idle 门（保持
    // generating 不覆盖，原回合脉冲全程不错乱）——旧「受理后 dispatching 帧取代零帧」
    // 断言随 idle 门退役；occupancy 归 turn-start / agent_settled 事件驱动
    expect(occupancyFrames(publish)).toEqual([])
  })

  it('#8a prompt 撞 compacting 拒绝（TOCTOU）→ 零拒绝帧/零错误气泡 + 条目留守 queued（D6 持有等 compaction_end）', async () => {
    const { dispatcher, publish, registry, session } = makeDispatcher({
      promptError: new Error('Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.'),
    })
    const result = await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery()
    expect(result.blocked).toBe(false)
    // 退役路径：send.rejected 广播（排队取代拒绝，D5）
    expect(frameTypes(publish)).not.toContain('send.rejected')
    expect(frameTypes(publish)).not.toContain('message.error') // busy 类拒绝不进错误气泡
    // 迁移侧（§3.4 错误规格表「压缩中 direct 投递撞 Cannot submit...」行）：条目回 queued，
    // compaction_end 后再投——持有而非失败/丢弃（D6 适配器 catch 面处置）
    expect(registry.entries('s1')?.active[0]).toMatchObject({ state: 'queued' })
    // 帧序（[RT-4#10] 合并收尾）：投递路径起始写 dispatching → busy 类拒绝在 registry
    // promptAwaitingCompaction（classifyBusyRejection 分型）内复位 idle + 置
    // piCompactingBlocked（持有等 compaction_end）——显式收尾帧序列，而非旧的「零帧」
    expect(occupancyFrames(publish)).toEqual([
      { sessionId: 's1', turn: 'dispatching', compacting: false, bash: false, handingOff: false },
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false, handingOff: false },
    ])
    // 原断言意图保留（防卡 dispatching）：终态 turn 不得停留 dispatching
    expect(session.occupancy?.turn ?? 'idle').not.toBe('dispatching')
  })

  it('#8b prompt 抛非 busy 错（auth 失败）→ message.error 保留（受理失败出口）+ 零 dispatching 置位（D-18）', async () => {
    const { dispatcher, publish, session } = makeDispatcher({ promptError: new Error('auth failed') })
    const result = await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery()
    // 受理口径（D9⑤）：提交成功返回；失败经内核失败出口异步广播（原 result.blocked=true 失真）
    expect(result.blocked).toBe(false)
    expect(frameTypes(publish)).toContain('message.error')
    expect(String(publishedByType(publish, 'message.error')?.payload.message)).toContain('auth failed')
    // 帧序（[RT-4#10] 合并收尾）：投递路径起始写 dispatching → 非 busy 真失败由投递路径 catch 面
    // 收敛回 idle（不卡 dispatching）；原断言意图保留：终态不得停留 dispatching
    expect(occupancyFrames(publish)).toEqual([
      { sessionId: 's1', turn: 'dispatching', compacting: false, bash: false, handingOff: false },
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false, handingOff: false },
    ])
    expect(session.occupancy?.turn ?? 'idle').not.toBe('dispatching')
  })

  it('#9a abort 成功 → turn=idle；重复 abort 第二次零 occupancy 帧（④ 无变化不重复广播）', async () => {
    // 真实 abort 场景 = 生成中（occupancy generating）；pi 卡死时 agent_settled 不到达，
    // abort 是唯一复位来源（#9 失败路径语义）。
    const { dispatcher, publish } = makeDispatcher({
      session: driveOccupancy(makeMockSession(), 'generating'),
    })
    await dispatcher.abort('s1')
    expect(frameTypes(publish)).toContain('message.complete')
    expect(occupancyFrames(publish)).toEqual([{ sessionId: 's1', turn: 'idle', compacting: false, bash: false, handingOff: false }])
    await dispatcher.abort('s1') // 重复 abort：idle→idle 幂等，零帧
    expect(occupancyFrames(publish)).toHaveLength(1)
  })

  it('#9b abort RPC 失败（非超时）→ 兜底复位 turn=idle（pi 卡死 agent_settled 不到达）', async () => {
    const { dispatcher, publish } = makeDispatcher({
      session: driveOccupancy(makeMockSession(), 'generating'),
      abortBehavior: 'error',
    })
    await dispatcher.abort('s1')
    expect(frameTypes(publish)).toContain('message.error')
    expect(occupancyFrames(publish)).toEqual([{ sessionId: 's1', turn: 'idle', compacting: false, bash: false, handingOff: false }])
  })

  it('#10 forceQuit → 全复位帧 + session.exited 保留（占用中 pi 死亡链路）', async () => {
    const { dispatcher, publish } = makeDispatcher({
      // settling + compacting=true 双维前置：settling 归 turn 机器，compacting 归布尔维 patch。
      session: driveOccupancy(makeMockSession(), 'settling', 'compacting-start'),
    })
    await dispatcher.forceQuit('s1')
    const frames = occupancyFrames(publish)
    expect(frames).toEqual([{ sessionId: 's1', turn: 'idle', compacting: false, bash: false, handingOff: false }])
    expect(frameTypes(publish)).toContain('session.exited')
  })

  it('#7 sendBash 置位/复位：bash=true 帧 → bash=false 帧（finally 全路径）', async () => {
    const { dispatcher, publish } = makeDispatcher()
    await dispatcher.sendBash('s1', 'ls')
    const frames = occupancyFrames(publish)
    expect(frames).toEqual([
      { sessionId: 's1', turn: 'idle', compacting: false, bash: true, handingOff: false },
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false, handingOff: false },
    ])
  })

  it('#7 失败路径：bash transport 抛错 → finally 仍复位 bash=false（⑤ bashResult/message.error 保留）', async () => {
    const { dispatcher, publish } = makeDispatcher({ bashBehavior: 'error' })
    const result = await dispatcher.sendBash('s1', 'bad')
    expect(result.status).toBe('settled') // 已执行并收尾（回执携带执行状态）
    const frames = occupancyFrames(publish)
    expect(frames.at(-1)).toMatchObject({ bash: false })
    expect(frameTypes(publish)).toContain('message.bashResult')
    expect(frameTypes(publish)).toContain('message.error')
  })

  it('#7 streaming 并存：isGenerating 期间 bash 结果入待落列，occupancy 仍 bash=true→false（turn 不受影响）', async () => {
    const { dispatcher, publish, session } = makeDispatcher({
      session: driveOccupancy(makeMockSession(), 'generating'),
    })
    await dispatcher.sendBash('s1', 'ls')
    expect(session.pendingBashResults).toHaveLength(1) // 双分支延迟保留（存量）
    const frames = occupancyFrames(publish)
    expect(frames.map((f) => f.bash)).toEqual([true, false])
    expect(frames.every((f) => f.turn === 'generating')).toBe(true) // turn 维度不被 bash 挂点改写
  })

  it('#11 abortBash → bash=false（成败皆兜底，bashAborted 兜底终态帧保留）', async () => {
    const { dispatcher, publish } = makeDispatcher({
      // bash=true 前置：布尔维 patch（'bash-start' 不动 turn 维，turn 保持 idle）。
      session: driveOccupancy(makeMockSession({ bashRunToken: 'bash_1_abc' }), 'bash-start'),
    })
    await dispatcher.abortBash('s1')
    const frames = occupancyFrames(publish)
    expect(frames).toEqual([{ sessionId: 's1', turn: 'idle', compacting: false, bash: false, handingOff: false }])
    expect(frameTypes(publish)).toContain('message.bashAborted')
  })

  it('#6 兜底：compact transport 失败 → finally 复位 compacting=false（compaction_end 不到达时）', async () => {
    // 真实时序镜像：预检（isCompacting=false）通过 → compact RPC 发出 → compaction_start 到达
    //（interpreter 置 isCompacting + occupancy.compacting=true）→ transport 断 reject →
    // finally 兜底复位（interpreter 的 compaction_end #6 不到达）。
    const { dispatcher, publish, session, compactFn } = makeDispatcher({ compactBehavior: 'error' })
    compactFn.mockImplementation(async () => {
      // 模拟 compaction_start 已到达（interpreter #5 语义）：经原语置位（u3c readonly 收尾；
      // publish 传 null 与改前直写一致不广播）。
      // 注：RT-4#10 起 dispatcher 预检通过后自己先广播一帧 compacting=true（关重入窗口），
      // 故本用例应见「true → false」两帧：前者是预检后置位帧，后者是 finally 复位帧。
      applySessionOccupancyTransition(session, null, 'compacting-start')
      throw new Error('compact transport exploded')
    })
    await expect(dispatcher.compact('s1')).rejects.toThrow('compact transport exploded')
    expect(occupancyFrames(publish)).toEqual([
      { sessionId: 's1', turn: 'idle', compacting: true, bash: false, handingOff: false },
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false, handingOff: false },
    ])
  })

  it('messageBus 未注入 → 挂点 no-op 不抛（null-safety，存量语义：状态照写、广播跳过）', async () => {
    const session = makeMockSession()
    const client = {
      prompt: vi.fn(async () => ({})),
      abort: vi.fn(async () => {}),
      // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）——fake 补齐接口成员
      touchActivity: vi.fn(),
    } as unknown as IPiEngine
    const svc: IDispatcherSessionOps = {
      ensureActive: vi.fn(async () => client),
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      clearSessionOutcome: vi.fn(),
      getSession: vi.fn(() => session),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    // [u2] 内核装配（bus 缺省 → 广播跳过、occupancy 状态照写——原语 publish=null 分支）
    const registry = createSessionDeliveryRegistry({
      getSession: (sid) => svc.getSession(sid),
      ensureActive: svc.ensureActive as (sid: string) => Promise<IPiEngine>,
      subscribeAgentSettled: () => () => {},
      recordWorkspace: (cwd) => workspace.record(cwd),
      getMessageBus: () => null,
    })
    cleanupRegistry = () => registry.disposeAll()
    const dispatcher = new MessageDispatcher(svc, { getClient: vi.fn(() => client) } as unknown as IProcessManager, workspace, undefined)
    dispatcher.setDeliveryRegistry(registry)
    await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery()
    await dispatcher.abort('s1')
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: false, bash: false, handingOff: false }) // 状态照写
  })
})
// ── Part D：lifecycle registerSession 初值（#10 respawn 衔接）────

describe('SessionLifecycle.registerSession occupancy 初值（respawn 衔接）', () => {
  function makeLifecycle(bus: IMessageBus | null = null) {
    const svc: ILifecycleSessionOps = {
      getExtensionPaths: vi.fn(async () => []),
      getSkillPaths: vi.fn(() => []),
      getReplaceSystemPrompt: vi.fn(() => undefined),
      getLaunchPresetOptions: vi.fn(async () => undefined),
      toSummary: vi.fn(),
      notifySessionCreated: vi.fn(),
      findScannedSession: vi.fn(() => undefined),
      fetchAndBroadcastContext: vi.fn(async () => undefined),
      removeSessionEntry: vi.fn(),
      getActiveSummaries: vi.fn(() => []),
    }
    const registerDeps: ISessionRegisterDeps = {
      adapterFactory: vi.fn(() => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter),
      getMessageBus: () => bus,
      broadcastGlobal: vi.fn(),
    }
    const lifecycle = new SessionLifecycle(
      svc, {} as unknown as IProcessManager,
      { getDefaultModel: vi.fn(() => undefined) } as unknown as IConfigStore,
      {} as unknown as ISessionStore,
      {} as unknown as WorkspaceService,
      registerDeps,
    )
    return lifecycle
  }

  function makeWs() {
    return { readyState: 1, send: vi.fn() }
  }

  it('respawn（restore）/create/fork 共用注册汇聚点：occupancy 从 idle 起步', async () => {
    const lifecycle = makeLifecycle()
    const session = await lifecycle.registerSession('s1', {} as unknown as IPiEngine, '/repo', 'r')
    // pi 重 spawn 后无活跃 run → idle 起步（与四维全 false 同语义）；renderer 可观测性
    // 由宣告帧保证（下方用例），bus 未注入（null）时状态照写不抛（null-safe）。
    expect(session.occupancy).toEqual({ turn: 'idle', compacting: false, bash: false, handingOff: false })
  })

  it('Gate B V6b 回归：注册即写 occupancy idle 快照——restore 后重订阅回放 idle 帧修正 stale 分区', async () => {
    const bus = new MessageBus()
    // 复现 restore 前置态：压缩中死亡（compacting=true 曾写快照），onSessionExit 的
    // clearSession 清场（转移 #10 的 idle 帧在 renderer 侧被 exited-unsub 抢先丢弃——
    // renderer 分区 stale 只能靠 respawn 后的快照回放修正）。
    bus.publish('s1', {
      type: 'session.occupancy',
      payload: { sessionId: 's1', turn: 'generating', compacting: true, bash: false, handingOff: false },
    } as ServerMessage)
    bus.clearSession('s1')

    const lifecycle = makeLifecycle(bus)
    await lifecycle.registerSession('s1', {} as unknown as IPiEngine, '/repo', 'r')

    // renderer respawn 后 subscribeSession → stateSnapshot 回放必含 idle 帧：
    // setOccupancy(idle) 修正 stale + flush 触发条件（收到全 idle 帧）成立，队列可续投。
    const replay = bus.subscribe('s1', makeWs())
    const occ = replay.stateSnapshot.find((m) => m.type === 'session.occupancy')
    expect(occ?.payload).toEqual({ sessionId: 's1', turn: 'idle', compacting: false, bash: false, handingOff: false })
  })

  it('create（全新 sid）同样落 idle 快照：三入口汇聚点语义一致（renderer 缺省分区本就 idle，无行为变化）', async () => {
    const bus = new MessageBus()
    const lifecycle = makeLifecycle(bus)
    await lifecycle.registerSession('fresh', {} as unknown as IPiEngine, '/repo', 'r')

    const replay = bus.subscribe('fresh', makeWs())
    const occ = replay.stateSnapshot.find((m) => m.type === 'session.occupancy')
    expect(occ?.payload).toEqual({ sessionId: 'fresh', turn: 'idle', compacting: false, bash: false, handingOff: false })
  })

  it('宣告帧经 IMessageBus.publish 下发（payload 形状与 shared protocol 一致）', async () => {
    const publish = vi.fn()
    const lifecycle = makeLifecycle({ publish } as unknown as IMessageBus)
    await lifecycle.registerSession('s1', {} as unknown as IPiEngine, '/repo', 'r')

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0][0]).toBe('s1')
    expect(publish.mock.calls[0][1]).toMatchObject({
      type: 'session.occupancy',
      payload: { sessionId: 's1', turn: 'idle', compacting: false, bash: false },
    })
  })
})
});
// ======================================================================
// ← test/message-converter.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('message-converter', () => {
// 本文件另为 message-converter 合并载体（-bash / -order 折叠为分节）。

describe('convertPiHistory', () => {
  it('converts user and assistant text messages', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: 1000,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(raw)

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('user')
    expect((messages[0].content as Array<{ type: string; text?: string }>)
      .find((s) => s.type === 'text')?.text).toBe('Hello')
    expect(messages[0].timestamp).toBe(1000)
    expect(messages[1].role).toBe('assistant')
    expect(messages[1].content).toBe('Hi there')
    expect(messages[1].status).toBe('complete')
  })

  it('merges toolResult into parent assistant toolCall', () => {
    const raw: (PiHistoryMessage | PiHistoryToolResult)[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'readFile', arguments: { path: '/foo' } }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        content: [{ type: 'text', text: 'file contents here' }],
        timestamp: 2000,
        toolCallId: 'tc1',
        toolName: 'readFile',
      } satisfies PiHistoryToolResult,
    ]

    const messages = convertPiHistory(raw)

    // toolResult should be merged, not a separate message
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    expect(messages[0].toolCalls).toHaveLength(1)
    expect(messages[0].toolCalls![0].id).toBe('tc1')
    expect(messages[0].toolCalls![0].output).toBe('file contents here')
    expect(messages[0].toolCalls![0].status).toBe('completed')
  })

  it('marks toolCall as error when toolResult has isError', () => {
    const raw: (PiHistoryMessage | PiHistoryToolResult)[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc2', name: 'bash', arguments: { cmd: 'exit 1' } }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        content: [{ type: 'text', text: 'command failed' }],
        timestamp: 2000,
        toolCallId: 'tc2',
        toolName: 'bash',
        isError: true,
      } satisfies PiHistoryToolResult,
    ]

    const messages = convertPiHistory(raw)

    expect(messages).toHaveLength(1)
    expect(messages[0].toolCalls![0].status).toBe('error')
    expect(messages[0].toolCalls![0].output).toBe('command failed')
  })

  // [subagent 派生视图丢失修复] 历史 toolResult 的 image 块必须随 fill 保留（表驱动：纯 image /
  // 混合 content）——与 core reducer（computeToolCallFill）同源提取，此前漏取致重开后
  // 工具结果图片丢失。
  const imgPart: PiHistoryImagePart = { type: 'image', data: 'aGVsbG8taW1hZ2U=', mimeType: 'image/png' }
  it.each([
    ['image only', [imgPart]],
    [
      'mixed text + image',
      [
        { type: 'text', text: 'Script completed' },
        imgPart,
      ],
    ],
  ] as Array<[string, PiHistoryContentPart[]]>)('preserves toolResult images in history fill (%s)', (_label, content) => {
    const raw: (PiHistoryMessage | PiHistoryToolResult)[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc3', name: 'codemode', arguments: {} }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        content,
        timestamp: 2000,
        toolCallId: 'tc3',
        toolName: 'codemode',
      } satisfies PiHistoryToolResult,
    ]

    const messages = convertPiHistory(raw)

    const tc = messages[0].toolCalls![0]
    expect(tc.images).toEqual([{ data: 'aGVsbG8taW1hZ2U=', mimeType: 'image/png' }])
  })
})
describe('convertPiHistory - skill block parsing', () => {
  // user 消息中的 <skill name="..." location="...">...</skill> 块由 pi backend 注入，
  // convertPiHistory 应剖出 skillName/skillLocation 并只保留用户真实文本。
  const skillUser = (text: string) => [{
    role: 'user',
    content: [{ type: 'text' as const, text }],
    timestamp: 1000,
  } satisfies PiHistoryMessage]

  it('parses a skill block with location, leaves trailing user text', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="code-review" location="/abs/path/SKILL.md">skill body</skill>do the thing',
    ))
    const skillSeg = (messages[0].content as any[]).find((s) => s.type === 'skill')
    expect(skillSeg?.name).toBe('code-review')
    expect(skillSeg?.location).toBe('/abs/path/SKILL.md')
    expect((messages[0].content as any[]).find((s) => s.type === 'text')?.text).toBe('do the thing')
  })

  it('parses a skill block without location (skillLocation undefined)', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="merge">body</skill>ship it',
    ))
    const skillSeg = (messages[0].content as any[]).find((s) => s.type === 'skill')
    expect(skillSeg?.name).toBe('merge')
    expect(skillSeg?.location).toBeUndefined()
    expect((messages[0].content as any[]).find((s) => s.type === 'text')?.text).toBe('ship it')
  })

  it('leaves content as-is when skill block lacks name attribute (regex no match)', () => {
    const raw = '<skill location="/x">body</skill>keep me'
    const messages = convertPiHistory(skillUser(raw))
    const content = messages[0].content as any[]
    // 无 skill 匹配 → 整段包成单个 text segment，无 skill segment
    expect(content.find((s) => s.type === 'skill')).toBeUndefined()
    expect(content.find((s) => s.type === 'text')?.text).toBe(raw)
  })

  it('leaves content as-is when skill block is unclosed (regex no match)', () => {
    const raw = '<skill name="x">body without close'
    const messages = convertPiHistory(skillUser(raw))
    const content = messages[0].content as any[]
    expect(content.find((s) => s.type === 'skill')).toBeUndefined()
    expect(content.find((s) => s.type === 'text')?.text).toBe(raw)
  })

  it('restores every skill block (multi-block), keeps text between/after blocks', () => {
    // [行为变更登记 2026-09-06] 升级前正则捕获组锚定 $，此形态「只取首个」、第二个 block
    // 沦为字面文本（capture 副产物非契约）；D7 升级（composer-multi-skill-injection u3，
    // core parseSkillBlock SSOT 同步）为两形态全局反解析——多 block 全部还原为 skill
    // segment，block 间与尾部正文保留（G2 多 skill 生效的恢复路径前提）。
    const messages = convertPiHistory(skillUser(
      '<skill name="first">A</skill><skill name="second">B</skill>tail',
    ))
    const content = messages[0].content as any[]
    expect(content.filter((s) => s.type === 'skill').map((s) => s.name)).toEqual(['first', 'second'])
    // 两 block 紧邻无夹间正文 → 仅尾部 tail 一个 text segment
    expect(content.filter((s) => s.type === 'text').map((s) => s.text)).toEqual(['tail'])
  })

  it('drops whitespace-only trailing text after block (marker-strip trimEnd, delivery-baseline policy)', () => {
    const messages = convertPiHistory(skillUser(
      '<skill name="x">body</skill>   \n  ',
    ))
    const content = messages[0].content as any[]
    expect(content.find((s) => s.type === 'skill')?.name).toBe('x')
    // [语义变更登记 2026-09-07] D7 升级时本形态曾锁定「尾部纯空白保留为 text segment」
    // （preserve-content policy）；簇 A2（decf7d289，defer 队列标记确认通道）在 user 派生视图
    // 剥 defer marker 后统一 trimEnd（core convertMessageBody 单点）——剥后基线文本 =
    // confirmDelivery overlay 文本，mergeBaselineWithLive 文本去重命中不双计。本形态
    // trimEnd 后无剩余正文 → 不产 text segment，仅 skill（与 core e-user-pi2 形态一致）。
    // 正文保留语义对非空白内容不变（见上方 multi-block 用例）。
    expect(content.find((s) => s.type === 'text')).toBeUndefined()
  })
})
describe('convertPiHistory - contentBlocks 到达顺序（循环内 push）', () => {
  // U9：parts=[thinking, text, toolCall] → contentBlocks 按真实到达顺序
  it('U9: parts=[thinking, text, toolCall] → contentBlocks 顺序=[thinking, text, toolCall]', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先思考' },
          { type: 'text', text: '结论' },
          { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } },
        ],
        timestamp: 1000,
      },
    ]
    const messages = convertPiHistory(raw)
    const cb = messages[0].contentBlocks
    expect(cb).toBeDefined()
    expect(cb?.map((b) => b.type)).toEqual(['thinking', 'text', 'toolCall'])
    // text 块 refId 统一为 'text'，不再被强制置顶
    const textBlock = cb?.find((b) => b.type === 'text')
    expect(textBlock?.refId).toBe('text')
  })

  // U10：纯 text part → contentBlocks 仅一个 text 块
  it('U10: parts=[{type:text}] → contentBlocks=[{type:text,refId:text}]（仅一个）', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '纯文字回答' }],
        timestamp: 1000,
      },
    ]
    const messages = convertPiHistory(raw)
    // §11 检查点 3：contentBlocks 带 contentIndex（parts 下标），与 streaming 路径对称
    expect(messages[0].contentBlocks).toEqual([{ type: 'text', refId: 'text', contentIndex: 0 }])
  })

  // U10b：text part 在前（非末位）→ text 能落在 contentBlocks 非末位
  it('U10b: parts=[text, thinking] → contentBlocks=[text, thinking]（text 不被强制置顶）', () => {
    const raw: PiHistoryMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '先说话' },
          { type: 'thinking', thinking: '后思考' },
        ],
        timestamp: 1000,
      },
    ]
    const messages = convertPiHistory(raw)
    const cb = messages[0].contentBlocks
    expect(cb?.map((b) => b.type)).toEqual(['text', 'thinking'])
  })

  // ── custom message（pi CustomMessage，扩展经 sendMessage 注入）──
  describe('custom message（role:"custom"）', () => {
    it('subagent-bg-notify 单条 → system + customType + bgNotify(单条 record)', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'subagent-bg-notify',
          content: 'Subagent "coder" (job-1) completed. Result:\nDone.',
          details: {
            id: 'job-1',
            status: 'done',
            agent: 'coder',
            model: 'claude-4.5',
            result: 'Done.',
            startedAt: 1000,
            endedAt: 13000,
          },
          timestamp: 13000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      const m = messages[0]
      expect(m.role).toBe('system')
      expect(m.customType).toBe('subagent-bg-notify')
      expect(m.content).toContain('coder')
      // bgNotify 派生字段已删（§3.3.6，前端零消费）——details 原始透传保留
      expect(m.details).toEqual({
        id: 'job-1',
        status: 'done',
        agent: 'coder',
        model: 'claude-4.5',
        result: 'Done.',
        startedAt: 1000,
        endedAt: 13000,
      })
    })

    it('subagent-bg-notify 批量 → bgNotify = {batch, items}', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'subagent-bg-notify',
          content: 'batch content',
          details: {
            batch: true,
            items: [
              { id: 'j1', status: 'done', agent: 'a1', startedAt: 1000 },
              { id: 'j2', status: 'failed', agent: 'a2', startedAt: 2000, error: 'boom' },
            ],
          },
          timestamp: 5000,
        },
      ]
      const messages = convertPiHistory(raw)
      const m = messages[0]
      // bgNotify 派生字段已删（§3.3.6）——details 原始透传保留（含 batch 形态）
      expect(m.details).toEqual({
        batch: true,
        items: [
          { id: 'j1', status: 'done', agent: 'a1', startedAt: 1000 },
          { id: 'j2', status: 'failed', agent: 'a2', startedAt: 2000, error: 'boom' },
        ],
      })
    })

    it('其他 customType → system + customType，details 透传', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'some-other-extension',
          content: 'hello',
          details: { foo: 'bar' },
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      expect(messages[0].role).toBe('system')
      expect(messages[0].customType).toBe('some-other-extension')
      expect(messages[0].details).toEqual({ foo: 'bar' })
    })

    // ── display 字段透传（FR-3 / AC-6）──────────────────────────────────
    // pi CustomMessage.display 是必填 boolean（false=隐藏不渲染，true=渲染）。
    // convertPiHistory 此前转 custom → system 时丢了 display，本次修复透传。
    it('display:false 的 custom message → 透传到 msg.display（goal/todo context 类应隐藏）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'goal-context',
          content: '<goal_context>...</goal_context>',
          display: false,
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      expect(messages[0].display).toBe(false)
    })

    it('display:true 的 custom message → 透传到 msg.display（workflow-result/subagent-bg-notify 类应显示）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'workflow-result',
          content: 'done',
          display: true,
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].display).toBe(true)
    })

    it('display 缺失的旧 custom message → msg.display 为 undefined（渲染层按 !== false 判断，保留显示）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'legacy',
          content: 'old',
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].display).toBeUndefined()
    })

    it('display:false 的 custom message 仍进 result（converter 不丢消息，过滤在渲染层）', () => {
      // AC-3 / FR-7：chat store 保留完整 messages，filterDisplayableMessages 只在渲染层过滤。
      // converter 若丢消息会破坏关键规则 9（fork/compact/replay 需完整历史）。
      const raw = [
        { role: 'user', content: 'hi', timestamp: 1000 },
        {
          role: 'custom',
          customType: 'todo-context',
          content: '<todo_context>...</todo_context>',
          display: false,
          timestamp: 2000,
        },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 3000 },
      ]
      const messages = convertPiHistory(raw)
      // user + custom(system) + assistant = 3 条，display:false 的 custom 不丢
      expect(messages).toHaveLength(3)
      expect(messages[1].display).toBe(false)
    })

    it('subagent-bg-notify details 缺必需字段 → details 原样透传（不再解析校验，§3.3.6）', () => {
      const raw = [
        {
          role: 'custom',
          customType: 'subagent-bg-notify',
          content: 'partial',
          // 缺 id / agent / startedAt
          details: { status: 'done' },
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].details).toEqual({ status: 'done' })
      expect(messages[0].content).toBe('partial')
    })
  })

  describe('piEntryId（文件路径读取时注入的 entry id）', () => {
    it('__entryId 存在时填充到 Message.piEntryId', () => {
      const raw = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1000,
          __entryId: 'abc123',
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].piEntryId).toBe('abc123')
    })

    it('无 __entryId 时 piEntryId 为 undefined（RPC 路径）', () => {
      const raw = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1000,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].piEntryId).toBeUndefined()
    })

    it('__entryId 非字符串时不填充', () => {
      const raw = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1000,
          __entryId: 123,
        },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].piEntryId).toBeUndefined()
    })
  })

  describe('compactionSummary / branchSummary role', () => {
    it('compactionSummary → system + compactionSummary 字段', () => {
      const raw = [
        { role: 'compactionSummary', summary: '压缩摘要', tokensBefore: 10000, timestamp: 123 },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      const m = messages[0]
      expect(m.role).toBe('system')
      expect(m.content).toBe('压缩摘要')
      expect(m.compactionSummary).toEqual({ summary: '压缩摘要', tokensBefore: 10000, timestamp: 123 })
    })

    it('compactionSummary 字段缺失时 content fallback 为“上下文已压缩”', () => {
      const raw = [{ role: 'compactionSummary', timestamp: 100 }]
      const messages = convertPiHistory(raw)
      expect(messages[0].content).toBe('上下文已压缩')
      expect(messages[0].compactionSummary?.summary).toBeUndefined()
    })

    it('branchSummary → system + branchSummary 字段', () => {
      const raw = [
        { role: 'branchSummary', summary: '分支摘要', fromId: 'msg-abc', timestamp: 456 },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(1)
      const m = messages[0]
      expect(m.role).toBe('system')
      expect(m.content).toBe('分支摘要')
      expect(m.branchSummary).toEqual({ summary: '分支摘要', fromId: 'msg-abc', timestamp: 456 })
    })

    it('branchSummary 字段缺失时 content fallback 为空字符串', () => {
      const raw = [{ role: 'branchSummary', timestamp: 200 }]
      const messages = convertPiHistory(raw)
      expect(messages[0].content).toBe('')
      expect(messages[0].branchSummary?.summary).toBeUndefined()
    })

    it('compactionSummary/branchSummary display 未设（保留显示）', () => {
      const raw = [
        { role: 'compactionSummary', summary: '压缩', timestamp: 100 },
        { role: 'branchSummary', summary: '分支', timestamp: 200 },
      ]
      const messages = convertPiHistory(raw)
      expect(messages[0].display).toBeUndefined()
      expect(messages[1].display).toBeUndefined()
    })

    it('混合 user/assistant/compactionSummary 顺序不乱', () => {
      const raw = [
        { role: 'user', content: [{ type: 'text', text: '问题' }], timestamp: 100 },
        { role: 'compactionSummary', summary: '压缩摘要', timestamp: 200 },
        { role: 'assistant', content: [{ type: 'text', text: '回答' }], timestamp: 300 },
      ]
      const messages = convertPiHistory(raw)
      expect(messages).toHaveLength(3)
      expect(messages[0].role).toBe('user')
      expect(messages[1].role).toBe('system')
      expect(messages[1].compactionSummary).toBeDefined()
      expect(messages[2].role).toBe('assistant')
    })
  })
})
// ── F1 toolResult details 透传 + outputRaw 历史恢复（自 message-converter-gui.test.ts 并入）──
// details.__gui__ 透传：重开 session 后 GUI 卡片不丢（关键规则 9）；outputRaw 与实时路径对称。


describe('message-converter: F1 toolResult details 透传', () => {
  it('toolResult 含 details.__gui__ → toolCall.details 包含 __gui__', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'toolCall', id: 'tc-1', name: 'todo', arguments: { action: 'list' } },
        ],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'todo',
        isError: false,
        content: [{ type: 'text', text: 'Task list updated' }],
        details: {
          __gui__: {
            v: 1,
            component: { type: 'stats-line', props: { items: [{ value: '3 turns' }] } },
          },
          action: 'list',
          todos: [{ id: 1, text: 'test', status: 'completed' }],
        },
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)

    // 找到 assistant 消息
    const assistant = messages.find(m => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant!.toolCalls).toBeDefined()
    expect(assistant!.toolCalls).toHaveLength(1)

    const tc = assistant!.toolCalls![0]
    expect(tc.id).toBe('tc-1')
    expect(tc.output).toBe('Task list updated')
    // ★ 核心断言：details 透传，含 __gui__
    expect(tc.details).toBeDefined()
    expect(tc.details?.__gui__).toBeDefined()
    const gui = tc.details?.__gui__ as { v: number; component: { type: string } }
    expect(gui.v).toBe(1)
    expect(gui.component.type).toBe('stats-line')
    // extension 自身的 details 字段也保留
    expect(tc.details?.action).toBe('list')
  })

  it('toolResult 无 details → toolCall.details 不设置', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-2', name: 'bash', arguments: { command: 'ls' } },
        ],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-2',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'file1\nfile2' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const assistant = messages.find(m => m.role === 'assistant')
    const tc = assistant!.toolCalls![0]
    expect(tc.details).toBeUndefined()
  })

  it('toolResult details 为数组 → 不透传（防 Array 当 object）', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-3', name: 'test', arguments: {} },
        ],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-3',
        toolName: 'test',
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
        details: [{ unexpected: 'array' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const assistant = messages.find(m => m.role === 'assistant')
    const tc = assistant!.toolCalls![0]
    // 数组型 details 不透传（与 event-adapter handleToolExecutionEnd 的 !Array.isArray 约束一致）
    expect(tc.details).toBeUndefined()
  })
})
describe('message-converter: outputRaw 历史恢复（对称实时路径）', () => {
  it('toolResult content 含 ANSI → output 存 stripAnsi 版本，outputRaw 存原始', () => {
    const ansiText = '\x1b[32mgreen\x1b[0m text'
    const history = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-raw-1', name: 'bash', arguments: {} }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-raw-1',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: ansiText }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const tc = messages.find(m => m.role === 'assistant')!.toolCalls![0]
    // output 是 stripAnsi 后的纯文本
    expect(tc.output).toBe('green text')
    // outputRaw 保留原始 ANSI（对称实时路径，关键规则 9）
    expect(tc.outputRaw).toBe(ansiText)
  })

  it('toolResult content 不含 ANSI → outputRaw 不设置', () => {
    const history = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-raw-2', name: 'bash', arguments: {} }],
        timestamp: 1000,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-raw-2',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'plain text' }],
        timestamp: 2000,
      },
    ]

    const messages = convertPiHistory(history)
    const tc = messages.find(m => m.role === 'assistant')!.toolCalls![0]
    expect(tc.output).toBe('plain text')
    expect(tc.outputRaw).toBeUndefined()
  })
})
// ════════════════ 来源: message-converter-bash.test.ts ════════════════

describe('message-converter-bash', () => {
  // bashExecution entry 的最小结构（与 pi get_messages 返回结构对齐）
  interface PiBashExecutionEntry {  // oe-exempt:20261027:test:
    role: 'bashExecution'
    command: string
    output: string
    exitCode?: number
    cancelled: boolean
    truncated: boolean
    excludeFromContext?: boolean
    timestamp: number
  }

  describe('convertPiHistory —— bashExecution 分支（W1 持久化链路）', () => {
    // T9: 完整字段映射
    it('T9: bashExecution entry → 1 条 system Message，bashExecution 字段完整映射', () => {
      const entry: PiBashExecutionEntry = {
        role: 'bashExecution',
        command: 'ls',
        output: 'a\nb\n',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 123,
      }
      const messages = convertPiHistory([entry])

      expect(messages).toHaveLength(1)
      const msg = messages[0]
      expect(msg.role).toBe('system')
      expect(msg.content).toBe('')
      expect(msg.status).toBe('complete')
      // bashExecution 完整字段
      expect(msg.bashExecution).toBeDefined()
      expect(msg.bashExecution!.command).toBe('ls')
      expect(msg.bashExecution!.output).toBe('a\nb\n')
      expect(msg.bashExecution!.exitCode).toBe(0)
      expect(msg.bashExecution!.cancelled).toBe(false)
      expect(msg.bashExecution!.truncated).toBe(false)
      expect(msg.bashExecution!.timestamp).toBe(123)
    })

    // T10: exitCode undefined → null（防 JSON 丢值）
    it('T10: exitCode undefined → bashExecution.exitCode === null（不是 undefined，防 JSON 丢值）', () => {
      const entry: PiBashExecutionEntry = {
        role: 'bashExecution',
        command: 'x',
        output: '',
        exitCode: undefined,
        cancelled: true,
        truncated: false,
        timestamp: 1,
      }
      const messages = convertPiHistory([entry])
      expect(messages[0].bashExecution!.exitCode).toBeNull()
      // cancelled 仍透传
      expect(messages[0].bashExecution!.cancelled).toBe(true)
    })

    // T11: excludeFromContext=true 透传
    it('T11: excludeFromContext=true → bashExecution.excludeFromContext === true', () => {
      const entry: PiBashExecutionEntry = {
        role: 'bashExecution',
        command: 'secret',
        output: '',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 5,
      }
      const messages = convertPiHistory([entry])
      expect(messages[0].bashExecution!.excludeFromContext).toBe(true)
    })

    // T12: excludeFromContext 未提供（undefined）→ 归一为 false（!!bm.excludeFromContext）
    it('T12: excludeFromContext 未提供 → 归一为 false（默认）', () => {
      const entry = {
        role: 'bashExecution',
        command: 'pwd',
        output: '/x',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        // excludeFromContext 缺失
        timestamp: 9,
      } as PiBashExecutionEntry
      const messages = convertPiHistory([entry])
      expect(messages[0].bashExecution!.excludeFromContext).toBe(false)
    })

    // T13: bashExecution entry 与普通 user message 混合——顺序与互不干扰
    it('T13: bashExecution 与 user message 混合，各自转换不串扰', () => {
      const messages = convertPiHistory([
        {
          role: 'bashExecution',
          command: 'echo hi',
          output: 'hi\n',
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 100,
        } as PiBashExecutionEntry,
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          id: 'u1',
          timestamp: 101,
        },
      ])

      expect(messages).toHaveLength(2)
      // 第一条：bashExecution system 消息（W3 WC5：bash 是元信息非用户输入）
      expect(messages[0].role).toBe('system')
      expect(messages[0].bashExecution).toBeDefined()
      expect(messages[0].bashExecution!.command).toBe('echo hi')
      // 第二条：普通 user 文本消息，无 bashExecution
      expect(messages[1].role).toBe('user')
      expect(messages[1].bashExecution).toBeUndefined()
    })
  })

  /**
   * W5T2: pi flush 后 bash entry 在 assistant turn 之后的还原顺序（M3 回归）。
   *
   * 场景（spec M3 已知限制的「可还原部分」）：pi agent_end 正常 flush 后，JSONL 里
   * assistant turn entries（含 tool_use / tool_result）在前、bashExecution entry 在后。
   * 重开 session 读 JSONL 调 convertPiHistory 时，bash 消息必须排在 assistant 消息之后
   * （与实时链路 bash 消息 append 到对话流末尾的顺序对齐），且 bashExecution 字段完整还原。
   *
   * 不覆盖的已知限制：进程强杀时 pi 来不及 flush 致历史丢失（非 converter 职责，不测）。
   */
  describe('convertPiHistory —— pi flush 后 bash 在 assistant turn 之后（W5 M3 回归）', () => {
    it('W5T2: [assistant tool_use + tool_result, bashExecution] → assistant 在前、bash system 在后，字段完整还原', () => {
      const messages = convertPiHistory([
        // 1) assistant turn entry：含 tool_use（pi 历史 assistant message，content 数组带 toolCall）
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'running tests' },
            { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } },
          ],
          id: 'a1',
          timestamp: 200,
        },
        // 2) tool_result entry：合并进上面的 assistant message 的 toolCall（不产出独立 Message）
        {
          role: 'toolResult',
          toolCallId: 'tc-1',
          content: [{ type: 'text', text: 'all green' }],
          timestamp: 201,
        },
        // 3) bashExecution entry：composer 直接执行 bash 的元信息（非 LLM turn），排在 assistant turn 之后
        {
          role: 'bashExecution',
          command: 'git status',
          output: 'clean',
          exitCode: 0,
          cancelled: false,
          truncated: false,
          excludeFromContext: true,
          timestamp: 300,
        } as PiBashExecutionEntry,
      ])

      // 长度：assistant(1) + toolResult 合并不产出 + bash(1) = 2
      expect(messages).toHaveLength(2)

      // 顺序：assistant 在前（index 0），bash 在后（index 1）—— 锁定 M3「pi flush 后顺序正确」
      const [assistant, bash] = messages
      expect(assistant.role).toBe('assistant')
      expect(assistant.bashExecution).toBeUndefined()
      // assistant 的 tool_use 已合并 tool_result（output 填回 toolCall）
      expect(assistant.toolCalls).toHaveLength(1)
      expect(assistant.toolCalls![0]!.output).toBe('all green')

      expect(bash.role).toBe('system')
      expect(bash.bashExecution).toBeDefined()
      // bashExecution 完整字段还原（command/output/exitCode/excludeFromContext）
      expect(bash.bashExecution!.command).toBe('git status')
      expect(bash.bashExecution!.output).toBe('clean')
      expect(bash.bashExecution!.exitCode).toBe(0)
      expect(bash.bashExecution!.excludeFromContext).toBe(true)
      expect(bash.bashExecution!.cancelled).toBe(false)
      expect(bash.bashExecution!.truncated).toBe(false)
      expect(bash.bashExecution!.timestamp).toBe(300)
    })
  })
})
// ════════════════ 来源: message-converter-order.test.ts ════════════════

describe('message-converter-order', () => {
  function toMessage(parts: PiHistoryContentPart[]): { role: 'assistant'; content: PiHistoryContentPart[]; timestamp: number } {
    return { role: 'assistant', content: parts, timestamp: 123 }
  }

  describe('convertSinglePiMessage —— contentBlocks 顺序（§11 检查点 3 持久化路径）', () => {
    it('text 在 tool 之后：[thinking, toolCall, text] → 与 streaming 路径一致', () => {
      const m = toMessage([
        { type: 'thinking', thinking: 'reasoning' },
        { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } },
        { type: 'text', text: 'answer' },
      ])
      const msg = convertSinglePiMessage(m)
      expect(msg!.contentBlocks).toEqual([
        { type: 'thinking', refId: msg!.thinking![0].id, contentIndex: 0 },
        { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
        { type: 'text', refId: 'text', contentIndex: 2 },
      ])
    })

    it('text 在 tool 之前：[text, toolCall] → 与 streaming 路径一致', () => {
      const m = toMessage([
        { type: 'text', text: 'let me check' },
        { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } },
      ])
      const msg = convertSinglePiMessage(m)
      expect(msg!.contentBlocks).toEqual([
        { type: 'text', refId: 'text', contentIndex: 0 },
        { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
      ])
    })

    it('多 text part 不绕过单 text 检查（text 块只 push 一次，content 合并）', () => {
      const m = toMessage([
        { type: 'text', text: 'part1 ' },
        { type: 'toolCall', id: 'tc1', name: 'read', arguments: {} },
        { type: 'text', text: 'part2' },
      ])
      const msg = convertSinglePiMessage(m)
      expect(msg!.content).toBe('part1 part2')
      expect(msg!.contentBlocks).toEqual([
        { type: 'text', refId: 'text', contentIndex: 0 },
        { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
      ])
    })

    it('多 tool 交错：[thinking, tool, text, tool] → 与 streaming 路径一致', () => {
      const m = toMessage([
        { type: 'thinking', thinking: 'r' },
        { type: 'toolCall', id: 'tc1', name: 'read', arguments: {} },
        { type: 'text', text: 'mid' },
        { type: 'toolCall', id: 'tc2', name: 'grep', arguments: {} },
      ])
      const msg = convertSinglePiMessage(m)
      expect(msg!.contentBlocks).toEqual([
        { type: 'thinking', refId: msg!.thinking![0].id, contentIndex: 0 },
        { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
        { type: 'text', refId: 'text', contentIndex: 2 },
        { type: 'toolCall', refId: 'tc2', contentIndex: 3 },
      ])
    })
  })
})
});
// ======================================================================
// ← test/normalize-tool-result.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('normalize-tool-result', () => {
/**
 * normalize-tool-result 单元测试（W1）。
 *
 * 目的：把 event-adapter.handleToolExecutionEnd 和 message-converter toolResult 分支里
 * 重复的「pi tool-result 数据归一」逻辑（三态判定 + stripAnsi + images/details 提取）
 * 提取到一个深模块，本测试覆盖其契约（plan.json U1/U2/U3）。
 *
 * 运行：npx vitest run test/normalize-tool-result.test.ts
 */

describe('stripAnsi', () => {
  it('剥离 ANSI 转义序列（来自 event-adapter / message-converter 原共享逻辑）', () => {
    expect(stripAnsi('\x1b[31mhello\x1b[0m')).toBe('hello')
    expect(stripAnsi('\x1b[1;32mgreen bold\x1b[0m')).toBe('green bold')
  })

  it('不含 ANSI 时原样返回', () => {
    expect(stripAnsi('plain text')).toBe('plain text')
    expect(stripAnsi('')).toBe('')
  })
})
describe('normalizePiToolResult — U1: 三种 raw 形态', () => {
  describe('形态 A: string', () => {
    it('含 ANSI → output 已剥离，outputRaw 保留原始', () => {
      const raw = '\x1b[31mhello\x1b[0m world'
      const r = normalizePiToolResult(raw)
      expect(r.output).toBe('hello world')
      expect(r.outputRaw).toBe(raw)
      expect(r.images).toBeUndefined()
      expect(r.details).toBeUndefined()
    })

    it('不含 ANSI → output 等于原文，outputRaw 为 undefined', () => {
      const raw = 'plain output'
      const r = normalizePiToolResult(raw)
      expect(r.output).toBe('plain output')
      expect(r.outputRaw).toBeUndefined()
    })

    it('空字符串 → output 为空，outputRaw 为 undefined', () => {
      const r = normalizePiToolResult('')
      expect(r.output).toBe('')
      expect(r.outputRaw).toBeUndefined()
    })
  })

  describe('形态 B: object 含 content 数组', () => {
    it('单 text 块 → output 为该文本', () => {
      const r = normalizePiToolResult({ content: [{ type: 'text', text: 'foo' }] })
      expect(r.output).toBe('foo')
      expect(r.outputRaw).toBeUndefined()
    })

    it('多 text 块 → output 以 \\n 连接', () => {
      const r = normalizePiToolResult({
        content: [
          { type: 'text', text: 'foo' },
          { type: 'text', text: 'bar' },
        ],
      })
      expect(r.output).toBe('foo\nbar')
    })

    it('text 块含 ANSI → output 剥离，outputRaw 保留原始拼接文本', () => {
      const r = normalizePiToolResult({
        content: [{ type: 'text', text: '\x1b[32mgreen\x1b[0m' }],
      })
      expect(r.output).toBe('green')
      expect(r.outputRaw).toBe('\x1b[32mgreen\x1b[0m')
    })

    it('含 image 块 → images 提取 {data, mimeType}（过滤空 data）', () => {
      const r = normalizePiToolResult({
        content: [
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
          { type: 'image', data: '', mimeType: '' }, // 空 → 被过滤
        ],
      })
      expect(r.images).toEqual([{ data: 'base64data', mimeType: 'image/png' }])
    })

    it('text + image 混合 → 同时产出 output 和 images', () => {
      const r = normalizePiToolResult({
        content: [
          { type: 'text', text: 'screenshot below' },
          { type: 'image', data: 'd1', mimeType: 'image/png' },
        ],
      })
      expect(r.output).toBe('screenshot below')
      expect(r.images).toEqual([{ data: 'd1', mimeType: 'image/png' }])
    })

    it('无 text 块只有 image → output 为空字符串', () => {
      const r = normalizePiToolResult({
        content: [{ type: 'image', data: 'd1', mimeType: 'image/png' }],
      })
      expect(r.output).toBe('')
      expect(r.images).toEqual([{ data: 'd1', mimeType: 'image/png' }])
    })

    it('content 为空数组 → output 为空，images 为 undefined', () => {
      const r = normalizePiToolResult({ content: [] })
      expect(r.output).toBe('')
      expect(r.images).toBeUndefined()
    })

    it('非 text/image 类型的块被忽略', () => {
      const r = normalizePiToolResult({
        content: [
          { type: 'tool_use', name: 'x' },
          { type: 'text', text: 'keep' },
        ],
      })
      expect(r.output).toBe('keep')
    })
  })

  describe('形态 C: 非 null 对象（非 content 形态）', () => {
    it('→ output 为 JSON.stringify', () => {
      const r = normalizePiToolResult({ foo: 'bar', n: 1 })
      expect(r.output).toBe(JSON.stringify({ foo: 'bar', n: 1 }))
      expect(r.outputRaw).toBeUndefined()
    })

    it('数组 → output 为 JSON.stringify', () => {
      const r = normalizePiToolResult([1, 2, 3])
      expect(r.output).toBe('[1,2,3]')
    })
  })

  describe('形态 D: null / undefined', () => {
    it('null → output 为空字符串', () => {
      const r = normalizePiToolResult(null)
      expect(r.output).toBe('')
      expect(r.outputRaw).toBeUndefined()
    })

    it('undefined → output 为空字符串', () => {
      const r = normalizePiToolResult(undefined)
      expect(r.output).toBe('')
      expect(r.outputRaw).toBeUndefined()
    })
  })

  describe('details 提取（raw 内 details，实时路语义）', () => {
    it('raw.details 是对象 → 透传 details', () => {
      const details = { __gui__: { type: 'progress', value: 0.5 } }
      const r = normalizePiToolResult({ content: [{ type: 'text', text: 'x' }], details })
      expect(r.details).toEqual(details)
    })

    it('raw.details 是数组 → 不提取（details 为 undefined）', () => {
      const r = normalizePiToolResult({ content: [], details: [1, 2, 3] })
      expect(r.details).toBeUndefined()
    })

    it('raw.details 是原始值 → 不提取', () => {
      const r = normalizePiToolResult({ content: [], details: 'string-not-object' })
      expect(r.details).toBeUndefined()
    })

    it('raw 是 string → details 为 undefined', () => {
      const r = normalizePiToolResult('hello')
      expect(r.details).toBeUndefined()
    })
  })
})
describe('normalizePiToolResult — U2: 对称回归', () => {
  // 同一 fixture 经 normalizePiToolResult 后，output 与 outputRaw 的关系
  // 必须满足「仅当含 ANSI 时 outputRaw !== output 且 outputRaw 非空」的不变量。
  const fixtures = [
    { name: 'string-no-ansi', raw: 'plain' },
    { name: 'string-ansi', raw: '\x1b[31mred\x1b[0m' },
    { name: 'content-text-no-ansi', raw: { content: [{ type: 'text', text: 'hi' }] } },
    { name: 'content-text-ansi', raw: { content: [{ type: 'text', text: '\x1b[33myellow\x1b[0m' }] } },
    { name: 'content-multi-text', raw: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } },
    { name: 'object', raw: { k: 'v' } },
    { name: 'null', raw: null },
  ]

  for (const f of fixtures) {
    it(`${f.name}: outputRaw 仅在含 ANSI 时出现且 !== output`, () => {
      const r = normalizePiToolResult(f.raw)
      if (r.outputRaw !== undefined) {
        // 含 ANSI 时不变量：outputRaw 必含 ANSI 而 output 已剥离 → 二者必不同
        expect(r.outputRaw).not.toBe(r.output)
        // output 不应再含 ANSI 转义
        expect(r.output).not.toMatch(/\x1b\[/)
      } else {
        // 无 ANSI 时 outputRaw 必为 undefined（而非空串或等于 output）
        expect(r.outputRaw).toBeUndefined()
      }
    })
  }
})
describe('normalizePiToolResult — U3: ANSI_REGEX 单一定义点', () => {
  // ANSI_REGEX / stripAnsi 只应存在于 normalize-tool-result.ts。
  // 这里通过 import 确认 stripAnsi 来自本模块（event-adapter / message-converter 改造后应 re-import）。
  it('stripAnsi 从 normalize-tool-result 导出且为函数', () => {
    expect(typeof stripAnsi).toBe('function')
  })

  it('stripAnsi 与 normalizePiToolResult 行为一致（内部使用同一正则）', () => {
    // 含 ANSI 的 string 走 normalize，output 应等于直接调 stripAnsi 的结果
    const raw = '\x1b[36mcyan\x1b[0m'
    expect(normalizePiToolResult(raw).output).toBe(stripAnsi(raw))
  })
})
// ════════════════ 来源: normalize-tool-result-parity.test.ts ════════════════

describe('normalize-tool-result-parity', () => {
  /** 共同契约字段抽取：双侧输出收敛到 { output, outputRaw, images } 后 deep equal。
   *  runtime 版额外产 details（raw.details 提取）——core 消费路径的 details 由 handler
   *  直接读 entry.message.details（registry tool_call_end），不属归一契约，不参与 parity。 */
  function commonFields(r: { output: string; outputRaw?: string; images?: Array<{ data: string; mimeType: string }> }) {
    return { output: r.output, outputRaw: r.outputRaw, images: r.images }
  }

  describe('normalizePiToolResult parity（runtime 实时路径 ↔ core reducer 路径）', () => {
    // 任务点名的四个输入组 + 边界补充，覆盖三态判定全分支
    const cases: Array<{ name: string; raw: unknown }> = [
      // 组 1：ANSI 转义序列（string 形态）
      { name: 'string 含 ANSI（outputRaw 保留原始）', raw: '\x1b[31mhello\x1b[0m world' },
      { name: 'string 含复合 ANSI（1;32m）', raw: '\x1b[1;32mgreen bold\x1b[0m' },
      { name: 'string 纯文本（无 outputRaw）', raw: 'plain output' },
      { name: 'string 空串', raw: '' },
      // 组 2：content-array 含图片块
      { name: 'content text + image 混合', raw: { content: [
        { type: 'text', text: 'screenshot below' },
        { type: 'image', data: 'dGVzdA==', mimeType: 'image/png' },
      ] } },
      { name: 'content 双空 image 块过滤（data 与 mimeType 均空）', raw: { content: [
        { type: 'image', data: '', mimeType: '' },
        { type: 'image', data: 'keep', mimeType: 'image/jpeg' },
      ] } },
      { name: 'content text 块含 ANSI', raw: { content: [{ type: 'text', text: '\x1b[32mgreen\x1b[0m' }] } },
      { name: 'content 多 text 块 join', raw: { content: [
        { type: 'text', text: 'foo' },
        { type: 'text', text: 'bar' },
      ] } },
      { name: 'content text 缺 text 字段（畸形块按空串）', raw: { content: [{ type: 'text' }, { type: 'text', text: 'ok' }] } },
      { name: 'content 非识别类型块忽略', raw: { content: [{ type: 'tool_use', name: 'x' }, { type: 'text', text: 'keep' }] } },
      // 组 3：非对象 raw（原始值形态）
      { name: 'number', raw: 42 },
      { name: 'boolean', raw: true },
      { name: 'null', raw: null },
      { name: 'undefined', raw: undefined },
      // 组 4：空 content
      { name: '空 content 数组', raw: { content: [] } },
      // 补充：非 content 形态对象（JSON.stringify 分支）与数组
      { name: '普通对象 JSON.stringify', raw: { foo: 'bar', n: 1 } },
      { name: '数组 JSON.stringify', raw: [1, 2, 3] },
      // 补充：runtime 版独有 details 携带时共同字段不漂移
      { name: 'content + details（runtime 提取 details，共同字段不受影响）', raw: {
        content: [{ type: 'text', text: 'x' }],
        details: { __gui__: { v: 1 } },
      } },
    ]

    for (const c of cases) {
      it(`${c.name}：双侧 output/outputRaw/images deep equal`, () => {
        expect(commonFields(coreNormalize(c.raw))).toEqual(commonFields(runtimeNormalize(c.raw)))
      })
    }

    it('core 版不产 details 字段（details 归 handler 直读 entry.message.details，非归一契约）', () => {
      const raw = { content: [{ type: 'text', text: 'x' }], details: { __gui__: { v: 1 } } }
      expect('details' in coreNormalize(raw)).toBe(false)
      // runtime 版照常提取（形态差异锚定，防未来「顺手对齐」抹掉语义差异）
      expect(runtimeNormalize(raw).details).toEqual({ __gui__: { v: 1 } })
    })

    it('双侧 outputRaw 不变量：仅在含 ANSI 时出现且 !== output（对称回归在双侧同构成立）', () => {
      const ansiCases: unknown[] = ['\x1b[31mred\x1b[0m', { content: [{ type: 'text', text: '\x1b[33myellow\x1b[0m' }] }]
      for (const raw of ansiCases) {
        for (const fn of [coreNormalize, runtimeNormalize]) {
          const r = fn(raw)
          expect(r.outputRaw).toBeDefined()
          expect(r.outputRaw).not.toBe(r.output)
        }
      }
    })
  })
})
});
});

// ======================================================================
// ← settings-systemprompt-bundle.test.ts
// ======================================================================

const mkdtempP_m2_d1 = promisify(mkdtemp)


const rmP_m2_d1 = promisify(rm)


function makeHandler_m2(overrides: { setProvider?: ReturnType<typeof vi.fn>; deleteProvider?: ReturnType<typeof vi.fn>; toggleProviderEnabled?: ReturnType<typeof vi.fn>; removeProviderByKind?: ReturnType<typeof vi.fn>; getDefaultModel?: ReturnType<typeof vi.fn>; setDefaultModel?: ReturnType<typeof vi.fn>; listProviders?: ReturnType<typeof vi.fn>; applyImportProviders?: ReturnType<typeof vi.fn>; discover?: ReturnType<typeof vi.fn>; aggregate?: ReturnType<typeof vi.fn>; oauthLogin?: ReturnType<typeof vi.fn>; oauthCancel?: ReturnType<typeof vi.fn>; oauthLogout?: ReturnType<typeof vi.fn>; modifyScopedModels?: ReturnType<typeof vi.fn>; resolver?: unknown; testProviderConnections?: ReturnType<typeof vi.fn> } = {}) {
  const broadcasts: ServerMessage[] = []
  const replies: { id: string; type: string; payload: Record<string, unknown> }[] = []
  const sendErrorCalls: { code: string; message: string }[] = []
  const configService = {
    listProviders: overrides.listProviders ?? vi.fn().mockReturnValue([{ id: 'p1' }]),
    checkEnvVars: vi.fn().mockReturnValue({}),
    setProvider: overrides.setProvider ?? vi.fn().mockReturnValue({}),
    deleteProvider: overrides.deleteProvider ?? vi.fn().mockResolvedValue({}),
    toggleProviderEnabled: overrides.toggleProviderEnabled ?? vi.fn().mockReturnValue({}),
    removeProviderByKind: overrides.removeProviderByKind ?? vi.fn().mockResolvedValue({}),
    setDefaultModel: overrides.setDefaultModel ?? vi.fn(),
    getDefaultModel: overrides.getDefaultModel ?? vi.fn().mockReturnValue(null),
    getScopedModels: vi.fn(() => []),
    // config.setScopedModels 写入口（scoped-model design）：默认执行 handler 传入的写入函数
    modifyScopedModels: overrides.modifyScopedModels ?? vi.fn(async (fn: (current: string[]) => string[]) => fn([])),
    applyImportProviders: overrides.applyImportProviders ?? vi.fn().mockResolvedValue({ result: {} }),
    // D9：applyImportProviders 成功路径 fire-and-forget 调 refreshProviderCatalogs（完成后二次
    // 广播 provider 列表）。mock 缺失会在成功分支同步 TypeError 中断 handler（Gate A 曾 3 failed）。
    // 返回形态对齐真实 configService.refreshProviderCatalogs（CatalogRefreshResult）。
    refreshProviderCatalogs: vi.fn().mockResolvedValue({ refreshed: [], failed: [] }),
    getProvider: vi.fn().mockReturnValue(undefined),
    // M4/RT-3#4：config.getProviders reply 携带 models.json 降级态标志
    isModelsStoreCorrupted: vi.fn().mockReturnValue(false),
    // M4/RT-7#1：updateToolPermissions 返回 {ok}（config.json 损坏降级态拒绝覆写）
    updateToolPermissions: vi.fn().mockReturnValue({ ok: true }),
    loadSkills: vi.fn().mockReturnValue([]),
    scanSkills: vi.fn().mockReturnValue([]),
    upsertSkill: vi.fn(),
    deleteSkill: vi.fn(),
    setSkillDirs: vi.fn(),
    getSkillDirs: vi.fn().mockReturnValue([]),
    migrateSettingsSkillsToDiscovery: vi.fn(),
    loadAgents: vi.fn().mockReturnValue([]),
    scanAgents: vi.fn().mockReturnValue([]),
    upsertAgent: vi.fn(),
    deleteAgent: vi.fn(),
    setAgentDirs: vi.fn(),
    getAgentDirs: vi.fn().mockReturnValue([]),
  }
  const modelService = {
    aggregateModels: overrides.aggregate ?? vi.fn().mockReturnValue([{ id: 'm1' }]),
    switchModel: vi.fn().mockResolvedValue('p1/m1'),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    discoverModelsFromApi: overrides.discover ?? vi.fn().mockResolvedValue([{ id: 'm1' }]),
    // M3a test 模式编排侧（可选交集）：缺省不装配——未注入时 handler 走 test_unavailable 防御分支
    ...(overrides.testProviderConnections ? { testProviderConnections: overrides.testProviderConnections } : {}),
  }
  const skillRegistry = {
    getGlobalSkills: vi.fn().mockReturnValue([]),
    getProjectSkills: vi.fn().mockResolvedValue([]),
    rebuildGlobal: vi.fn().mockResolvedValue(undefined),
    invalidateAllProjects: vi.fn(),
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string, type: string, payload: Record<string, unknown>) => replies.push({ id, type, payload })),
    sendError: vi.fn((_ws: unknown, code: string, message: string) => sendErrorCalls.push({ code, message })),
    configService,
    sessionService: {},
    modelService,
    authService: {
      login: overrides.oauthLogin ?? vi.fn().mockReturnValue({ started: true }),
      cancel: overrides.oauthCancel ?? vi.fn().mockReturnValue({ cancelled: false }),
      hasOAuth: vi.fn().mockResolvedValue(false),
      logout: overrides.oauthLogout ?? vi.fn().mockResolvedValue(undefined),
      getCredential: vi.fn().mockResolvedValue(undefined),
      saveCredential: vi.fn().mockResolvedValue(undefined),
    },
    // D3 链 2（M2fg 恒注入形态）：ctx resolver 构造必需——缺省注入 miss 形态替身
    // （resolve 返回 undefined = 「无凭据」），需要命中场景的用例经 overrides.resolver 传入。
    providerCredentialResolver: overrides.resolver ?? {
      resolveProviderCredential: vi.fn().mockResolvedValue(undefined),
    },
    // D-21 端口化：ctx connectionTester 构造必需（恒注入形态，原 handler 自建实例迁组合根）——
    // 注入真实例保持 M3a mode=test 用例对第 3 参 tester（.test 为函数）的断言等价。
    connectionTester: new ModelConnectionTester(),
    skillRegistry,
    projectRoot: '/proj',
    nextPushId: vi.fn().mockReturnValue('p1'),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
  }
  const handler = new SettingsMessageHandler(ctx as unknown as ConstructorParameters<typeof SettingsMessageHandler>[0])
  return { ctx, replies, broadcasts, handler, sendErrorCalls }
}


function msg_m2(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


const WS = {} as never


// ======================================================================
// ← test/settings-message-handler-dispatch.test.ts
// ======================================================================

function makeHandler_m2_d1(configOverrides: Record<string, ReturnType<typeof vi.fn>> = {}, modelOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const broadcasts: ServerMessage[] = []
  const replies: { id: string; type: string; payload: Record<string, unknown> }[] = []
  const sendErrorCalls: { id: string | undefined; code: string; message: string }[] = []
  const configService = {
    listProviders: vi.fn().mockReturnValue([{ id: 'p1' }]),
    getScopedModels: vi.fn().mockReturnValue([]),
    modifyScopedModels: vi.fn(async (fn: (current: string[]) => string[]) => fn([])),
    applyImportProviders: vi.fn().mockResolvedValue({ result: {} }),
    refreshProviderCatalogs: vi.fn().mockResolvedValue({ refreshed: [], failed: [] }),
    getProvider: vi.fn().mockReturnValue(undefined),
    isModelsStoreCorrupted: vi.fn().mockReturnValue(false),
    // M4/RT-7#1：updateToolPermissions 返回 {ok}（config.json 损坏降级态拒绝覆写）
    updateToolPermissions: vi.fn().mockReturnValue({ ok: true }),
    loadSkills: vi.fn().mockReturnValue([]),
    scanSkills: vi.fn().mockReturnValue([]),
    upsertSkill: vi.fn(),
    deleteSkill: vi.fn(),
    setSkillDirs: vi.fn(),
    loadAgents: vi.fn().mockReturnValue([]),
    scanAgents: vi.fn().mockReturnValue([]),
    upsertAgent: vi.fn(),
    deleteAgent: vi.fn(),
    setAgentDirs: vi.fn(),
    setExtensionDirs: vi.fn(),
    listBuiltinProviders: vi.fn().mockReturnValue([]),
    setDefaultModel: vi.fn(),
    getDefaultModel: vi.fn().mockReturnValue(null),
    getSystemPromptConfig: vi.fn().mockReturnValue({ config: {}, corrupted: false }),
    setSystemPromptConfig: vi.fn().mockReturnValue({ ok: true }),
    getTerminalConfig: vi.fn().mockReturnValue({ config: {}, corrupted: false }),
    setTerminalConfig: vi.fn().mockReturnValue({ ok: true }),
    getAutoRenameEnabled: vi.fn().mockReturnValue(false),
    setAutoRenameEnabled: vi.fn(),
    getRenameModel: vi.fn().mockReturnValue('p/m'),
    setRenameModel: vi.fn(),
    getSmartContextConfig: vi.fn().mockReturnValue({ enabled: false, compactModel: '', reminderThresholds: {}, excludedModels: [] }),
    setSmartContextEnabled: vi.fn(),
    setSmartContextThresholds: vi.fn(),
    ...configOverrides,
  }
  const modelService = {
    aggregateModels: vi.fn().mockReturnValue([]),
    switchModel: vi.fn().mockResolvedValue('p1/m1'),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    discoverModelsFromApi: vi.fn().mockResolvedValue([]),
    ...modelOverrides,
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string, type: string, payload: Record<string, unknown>) => replies.push({ id, type, payload })),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => sendErrorCalls.push({ id, code, message })),
    configService,
    sessionService: {},
    modelService,
    authService: {
      login: vi.fn().mockReturnValue({ started: true }),
      cancel: vi.fn().mockReturnValue({ cancelled: false }),
      hasOAuth: vi.fn().mockResolvedValue(false),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    skillRegistry: {
      getGlobalSkills: vi.fn().mockReturnValue([]),
      getProjectSkills: vi.fn().mockResolvedValue([]),
      rebuildGlobal: vi.fn().mockResolvedValue(undefined),
      invalidateAllProjects: vi.fn(),
    },
    projectRoot: '/proj',
    nextPushId: vi.fn().mockReturnValue('push-1'),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
    connectionTester: new ModelConnectionTester(),
  }
  const handler = new SettingsMessageHandler(ctx as unknown as SettingsHandlerContext)
  return { ctx, replies, broadcasts, sendErrorCalls, handler }
}


function msg_m2_d1(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


const WS_m2 = {} as never


// ======================================================================
// ← test/settings-message-handler-system-prompt.test.ts
// ======================================================================

interface SystemPromptConfig {  // oe-exempt:20261027:test:
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
}


const DEFAULT_CONFIG: SystemPromptConfig = {
  version: 1,
  replace: { enabled: false, prompt: '' },
  append: { enabled: false, prompt: '' },
}


function makeHandler_m3() {
  const broadcasts: ServerMessage[] = []
  const replies: { id: string | undefined; type: string; payload: unknown }[] = []
  const sendErrorCalls: { code: string; message: string; id?: string }[] = []

  const configService = {
    listProviders: vi.fn().mockReturnValue([]),
    setProvider: vi.fn().mockReturnValue({}),
    deleteProvider: vi.fn().mockResolvedValue({ removed: false }),
    setDefaultModel: vi.fn(),
    getProvider: vi.fn().mockReturnValue(undefined),
    updateToolPermissions: vi.fn(),
    loadSkills: vi.fn().mockReturnValue([]),
    scanSkills: vi.fn().mockReturnValue([]),
    upsertSkill: vi.fn(),
    deleteSkill: vi.fn(),
    setSkillDirs: vi.fn(),
    getSkillDirs: vi.fn().mockReturnValue([]),
    migrateSettingsSkillsToDiscovery: vi.fn(),
    loadAgents: vi.fn().mockReturnValue([]),
    scanAgents: vi.fn().mockReturnValue([]),
    upsertAgent: vi.fn(),
    deleteAgent: vi.fn(),
    setAgentDirs: vi.fn(),
    getAgentDirs: vi.fn().mockReturnValue([]),
    getSystemPromptConfig: vi.fn().mockReturnValue({ config: DEFAULT_CONFIG, corrupted: false }),
    setSystemPromptConfig: vi.fn().mockReturnValue({ ok: true }),
  }

  const modelService: IModelService = {
    aggregateModels: vi.fn().mockReturnValue([]),
    aggregateModelsWithScoped: vi.fn().mockReturnValue([]),
    switchModel: vi.fn().mockResolvedValue('provider/model'),
    setThinkingLevel: vi.fn().mockResolvedValue('high'),
    discoverModelsFromApi: vi.fn().mockResolvedValue([]),
    attachSupportedLevels: vi.fn((providers) => providers),
    reconcileModelCapabilities: vi.fn().mockResolvedValue([]),
    setCapabilityDriftSink: vi.fn(),
  }

  const ctx = {
    send: vi.fn(),
    // payload 用 unknown（非 Record<string, unknown>）：reply<T> 泛型让 payload 收窄为
    // ServerMessageMap[T] union，组 A 把无 index signature 的 SkillCacheInvalidatedPayload 加进 union 后，
    // 该 union 不再可赋值给 Record<string, unknown>（tsc 报 index signature 缺失）。unknown 类型安全
    // （不假装知道 payload 形状），replies.push 不受影响（数组元素类型含 unknown）。
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      sendErrorCalls.push({ code, message, id })
    }),
    configService: configService as unknown as IConfigService,
    sessionService: {} as unknown as ISessionService,
    modelService,
    authService: { login: vi.fn(), cancel: vi.fn(), hasOAuth: vi.fn(), getCredential: vi.fn(), saveCredential: vi.fn(), logout: vi.fn() },
    // D3 链 2（M2fg 恒注入形态）：ctx resolver 构造必需，本文件用例不涉凭据——miss 替身
    providerCredentialResolver: {
      hasProviderCredential: vi.fn().mockReturnValue(false),
      listCredentialBackedProviderIds: vi.fn().mockReturnValue(new Set<string>()),
      resolveProviderCredential: vi.fn().mockResolvedValue(undefined),
      resolveProviderApiKeyRaw: async () => undefined,
      resolveProviderBaseUrl: vi.fn().mockReturnValue(undefined),
    },
    skillRegistry: { getGlobalSkills: () => [], getProjectSkills: vi.fn().mockResolvedValue([]) } as unknown as SettingsHandlerContext['skillRegistry'],
    // D-21 端口化：ctx connectionTester 构造必需（本文件直接传 ctx 无 cast，缺字段 tsc 红）
    connectionTester: new ModelConnectionTester(),
    // pi-mcp-management：ctx mcpServersService 构造必需（本文件用例不涉 mcp 域——miss 替身，
    // fake port 不触碰文件系统，形态同上方 providerCredentialResolver 替身先例）
    mcpServersService: new McpServersService({
      list: () => ({ servers: [], corruption: null, agentDir: '/miss/agent' }),
      add: () => ({ ok: false, error: 'miss stub' }),
      update: () => ({ ok: false, error: 'miss stub' }),
      setEnabled: () => ({ ok: false, error: 'miss stub' }),
      remove: () => ({ ok: false, error: 'miss stub' }),
      test: () => ({ testId: 'miss-stub' }),
      testCancel: () => false,
    }),
    projectRoot: '/proj',
    nextPushId: vi.fn().mockReturnValue('push-1'),
    broadcast: vi.fn((m: ServerMessage) => broadcasts.push(m)),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
  }

  const handler = new SettingsMessageHandler(ctx)
  return { handler, ctx, configService, replies, broadcasts, sendErrorCalls }
}


function msg_m3(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


const WS_m3 = {} as never


// ======================================================================
// ← test/system-prompt-config.test.ts
// ======================================================================

/** 契约常量：replace.prompt 最大长度。 */
const SYSTEM_PROMPT_MAX_LENGTH = 16000


/** 将实现的契约类型（本地定义，避免引用尚不存在的 shared 导出导致编译失败）。 */
interface SystemPromptConfig_m2 {  // oe-exempt:20261027:test:
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
  capability?: { enabled: boolean }
}


const DEFAULT_SYSTEM_PROMPT_CONFIG: SystemPromptConfig_m2 = {
  version: 1,
  replace: { enabled: false, prompt: '' },
  append: { enabled: false, prompt: '' },
  capability: { enabled: true },
}


/** 只暴露 getConfigDir 的最小假 configStore。 */
function makeFakeConfigStore(configDir: string) {
  return {
    getConfigDir: () => configDir,
  }
}


/** 把 ConfigService 强转成「将拥有 system-prompt 方法」的形状，让调用在运行时自然失败。 */
type SystemPromptSvc = {
  getSystemPromptConfig(): { config: SystemPromptConfig_m2; corrupted: boolean }
  setSystemPromptConfig(config: SystemPromptConfig_m2): { ok: boolean; error?: string }
  getReplaceSystemPrompt(): string | undefined
}


let tmpDir_m2_m2: string


let configDir: string


let rawService: ConfigService


let service: SystemPromptSvc


function systemPromptPath(): string {
  return join(configDir, 'system-prompt.json')
}


// ======================================================================
// ← test/system-prompt-extension.test.ts
// ======================================================================

interface SystemPromptConfig_m3 {  // oe-exempt:20261027:test:
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
  capability?: { enabled: boolean }
}


/** 既有用例隔离关注点用的「capability 显式关闭」片段（保持原精确断言） */
const CAP_OFF: { capability: { enabled: boolean } } = { capability: { enabled: false } }


/** capability 段 header 锚（与扩展源码 renderCapabilitySection 渲染段的 header 一致） */
const CAP_HEADER = '# TaiJi capabilities'


const PLUGIN_PATH = new URL('../../../extensions/taiji/system-prompt/index.ts', import.meta.url).pathname


function writeConfig(dataDir: string, config: SystemPromptConfig_m3): void {
  writeFileSync(join(dataDir, 'system-prompt.json'), JSON.stringify(config), 'utf-8')
}


/** 写入全局指令候选文件，返回其路径。 */
function writeGlobalAgents(content: string, name = 'AGENTS.md'): string {
  const p = join(agentsDir, name)
  writeFileSync(p, content, 'utf-8')
  return p
}


/** 期望的全局指令注入段（头部 + 内容）。 */
function globalSegment(p: string, content: string): string {
  return `\n\n# Global instructions (${p})\n\n${content}`
}


let tmpDir_m2_m2_d1: string


let dataDir: string


let piAgentDir_m2: string


let agentsDir: string


let originalDataDir: string | undefined


let originalPiAgentDir: string | undefined


let originalGlobalAgentsDir: string | undefined


async function loadPlugin(): Promise<(pi: unknown) => void> {
  const mod = await import(PLUGIN_PATH) as unknown as { default?: (pi: unknown) => void }
  if (!mod.default) throw new Error('plugin default export missing')
  return mod.default
}


type PiLike = { on: ReturnType<typeof vi.fn> }


type Handler = (event: { systemPrompt: string }) => { systemPrompt?: string } | undefined


function installPlugin(factory: (pi: unknown) => void): { pi: PiLike; handler: Handler } {
  const pi: PiLike = { on: vi.fn() }
  factory(pi)
  const call = pi.on.mock.calls.find((c) => c?.[0] === 'before_agent_start')
  expect(call).toBeDefined()
  return { pi, handler: call![1] as Handler }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('settings-systemprompt-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('settings-message-handler', () => {
describe('SettingsMessageHandler', () => {
  describe('provider 副作用广播（最该补）', () => {
    it('setProvider 无 newDefault → 仅 reply + broadcastProviderList，不广播 config.defaults', async () => {
      const { ctx, broadcasts, handler } = makeHandler_m2({ setProvider: vi.fn().mockReturnValue({}) })
      await handler.handleSettingsMessage(msg_m2('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      expect(ctx.broadcastProviderList).toHaveBeenCalledOnce()
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('setProvider 有 newDefault → 广播 config.defaults (source=provider-updated)', async () => {
      const { broadcasts, handler } = makeHandler_m2({
        setProvider: vi.fn().mockReturnValue({ newDefault: { provider: 'p1', modelId: 'm1' } }),
      })
      await handler.handleSettingsMessage(msg_m2('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d).toBeDefined()
      expect(d?.payload).toMatchObject({ defaultModel: 'p1/m1', source: 'provider-updated' })
    })

    it('deleteProvider 有 newDefault → 广播 config.defaults (source=provider-deleted)', async () => {
      const { broadcasts, handler } = makeHandler_m2({
        deleteProvider: vi.fn().mockResolvedValue({ newDefault: { provider: 'p2', modelId: 'm2' } }),
      })
      await handler.handleSettingsMessage(msg_m2('config.deleteProvider', { providerId: 'p1' }), WS)
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d?.payload).toMatchObject({ defaultModel: 'p2/m2', source: 'provider-deleted' })
    })
  })

  describe('config.setDefaultModel（W3 默认模型持久化）', () => {
    it('调 configService.setDefaultModel(provider, modelId) + reply config.defaults + 广播给所有 panel', async () => {
      // W3：前端设置默认模型。handler 路由到 configService.setDefaultModel（已存在，写 settings.json），
      // 回发起端 reply config.defaults，并广播给所有 panel（与 setProvider/deleteProvider 的
      // newDefault 广播同构），让其它打开的设置面板同步默认模型下拉。
      const { ctx, replies, broadcasts, handler } = makeHandler_m2_d1()
      await handler.handleSettingsMessage(msg_m2('config.setDefaultModel', { provider: 'p1', modelId: 'm1' }), WS)
      expect(ctx.configService.setDefaultModel).toHaveBeenCalledWith('p1', 'm1')
      // reply：回发起端，defaultModel 形如 "provider/modelId"
      expect(replies[0]).toMatchObject({ type: 'config.defaults', payload: { defaultModel: 'p1/m1' } })
      // 广播：推给所有 panel
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d).toBeDefined()
      expect(d?.payload).toMatchObject({ defaultModel: 'p1/m1' })
    })
  })

  describe('基础路由', () => {
    it('config.getProviders → reply config.providers（含 scopedModels 透传，design §3.3 D7）', async () => {
      const { ctx, replies, handler } = makeHandler_m2_d1()
      // mock 非空数组验证透传（默认 mock 返回 []，空值断言无区分力）
      ;(ctx.configService.getScopedModels as ReturnType<typeof vi.fn>).mockReturnValue(['p1/m1', 'p2/m2'])
      await handler.handleSettingsMessage(msg_m2('config.getProviders', {}), WS)
      expect(replies[0]).toMatchObject({ type: 'config.providers', payload: { providers: [{ id: 'p1' }], scopedModels: ['p1/m1', 'p2/m2'] } })
    })
    it('model.list → aggregateModels + reply', async () => {
      // 本用例原属 settings-message-handler.test.ts（工厂带 m1 默认模型表）；合并去重时
      // 被错绑到 dispatch 源的 makeHandler_m2_d1（默认空表）导致断言空 models——改回原工厂。
      const { replies, handler } = makeHandler_m2()
      await handler.handleSettingsMessage(msg_m2('model.list', {}), WS)
      expect(replies[0]).toMatchObject({ type: 'model.list', payload: { models: [{ id: 'm1' }] } })
    })
    it('model.switch → switchModel 调用 + reply model.switched', async () => {
      const { ctx, replies, handler } = makeHandler_m2_d1()
      await handler.handleSettingsMessage(msg_m2('model.switch', { sessionId: 's1', provider: 'p1', modelId: 'm1' }), WS)
      expect(ctx.modelService.switchModel).toHaveBeenCalledWith('s1', 'p1', 'm1')
      expect(replies[0]).toMatchObject({ type: 'model.switched' })
    })
    it('config.scanSkills → reply scannedSkills + 广播 config.skills（修裂缝①）', async () => {
      const { replies, ctx, handler } = makeHandler_m2_d1()
      await handler.handleSettingsMessage(msg_m2('config.scanSkills', { sources: ['/x'] }), WS)
      expect(replies[0]).toMatchObject({ type: 'config.scannedSkills', payload: { success: true } })
      // 裂缝①核心修复：扫描后必须广播，让前端 onSkills 订阅推回
      expect(ctx.broadcastSkillList).toHaveBeenCalledOnce()
    })

    // ── W2（cw-2026-07-21-scan-project-agents-skills）：config.scanSessionSkills RPC ──
    // 按 session cwd 拉 project skill（.agents/skills + .taiji/skills 扫描结果）。
    // 与 config.scanSkills 区分：scanSkills 扫 sources 数组候选加入 discovery + 广播；
    // scanSessionSkills 扫某 cwd 的已生效目录 + 不广播（按需 RPC）。
    it('W2: config.scanSessionSkills → loadSkills(cwd) + reply config.sessionSkills，不广播', async () => {
      const { replies, ctx, handler } = makeHandler_m2_d1()
      // mock loadSkills 返回项目 skill
      ;(ctx.configService.loadSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 's1', name: 'proj-skill', description: 'proj', enabled: true, source: 'agents', effective: true },
      ])

      await handler.handleSettingsMessage(msg_m2('config.scanSessionSkills', { cwd: '/user-project' }), WS)

      // 关键：loadSkills 用传入的 cwd 调用（非全局 projectRoot）
      expect(ctx.configService.loadSkills).toHaveBeenCalledWith('/user-project')
      // reply 类型 config.sessionSkills（与 config.skills 区分，后者是全局广播）
      expect(replies[0]).toMatchObject({ type: 'config.sessionSkills', payload: { skills: expect.any(Array) } })
      // 不广播（按需 RPC，不污染全局 config.skills）
      expect(ctx.broadcastSkillList).not.toHaveBeenCalled()
    })
    it('config.scanAgents → 广播 config.agents（修裂缝①）', async () => {
      const { ctx, handler } = makeHandler_m2_d1()
      await handler.handleSettingsMessage(msg_m2('config.scanAgents', { sources: ['/x'] }), WS)
      expect(ctx.broadcastAgentList).toHaveBeenCalledOnce()
    })
    it('config.setSkillDirs → 写 discovery + 广播 skill 列表 + 目录配置', async () => {
      const { replies, ctx, handler } = makeHandler_m2_d1()
      await handler.handleSettingsMessage(msg_m2('config.setSkillDirs', { dirs: ['~/.pi/agent/skills', '~/.claude/skills'] }), WS)
      expect(ctx.configService.setSkillDirs).toHaveBeenCalledWith(['~/.pi/agent/skills', '~/.claude/skills'])
      expect(replies[0]).toMatchObject({ type: 'config.skillDirs' })
      expect(ctx.broadcastSkillList).toHaveBeenCalledOnce()
      expect(ctx.broadcastSkillDirs).toHaveBeenCalledOnce()
    })
    it('config.setSkillDirs + rebuildGlobal 成功 → 失效广播仅 project（global 走 notifyGlobalChange 正常链，不重复补发）', async () => {
      const { ctx, handler } = makeHandler_m2_d1()
      await handler.handleSettingsMessage(msg_m2('config.setSkillDirs', { dirs: ['/x'] }), WS)
      // rebuildGlobal 是 fire-and-forget Promise 链，flush 微任务后断言
      await new Promise((resolve) => setImmediate(resolve))
      expect(ctx.skillRegistry.rebuildGlobal).toHaveBeenCalledOnce()
      expect(ctx.skillRegistry.invalidateAllProjects).toHaveBeenCalledOnce()
      expect(ctx.broadcastSkillCacheInvalidated).toHaveBeenCalledTimes(1)
      expect(ctx.broadcastSkillCacheInvalidated).toHaveBeenCalledWith('project')
    })
    it('config.setSkillDirs + rebuildGlobal 失败（RT-1#9）→ 补发 global 失效（partial:true）+ project 广播照发（通知对称）', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const { ctx, handler } = makeHandler_m2_d1()
        ;(ctx.skillRegistry.rebuildGlobal as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('notify chain broken'))
        await handler.handleSettingsMessage(msg_m2('config.setSkillDirs', { dirs: ['/x'] }), WS)
        await vi.waitFor(() => {
          expect(ctx.broadcastSkillCacheInvalidated).toHaveBeenCalledTimes(2)
        }, { interval: 1 })
        // 失败分支先补发 global（partial=true 标注降级），finally 再发 project——
        // 修复前 global 失效广播随通知链一起丢失，前端 global 派生视图陈旧无信号。
        const invalidations = (ctx.broadcastSkillCacheInvalidated as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[string, ...(undefined | boolean)[]]>
        expect(invalidations[0]).toEqual(['global', undefined, true])
        expect(invalidations[1]?.[0]).toBe('project')
        // 失败留痕（旧实现已有，锚定不回退）
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rebuildGlobal failed'), expect.any(Error))
      } finally {
        errorSpy.mockRestore()
      }
    })
    it('config.setAgentDirs → 写 discovery + 广播 agent 列表 + 目录配置', async () => {
      const { ctx, handler } = makeHandler_m2_d1()
      await handler.handleSettingsMessage(msg_m2('config.setAgentDirs', { dirs: ['~/.agents/agents'] }), WS)
      expect(ctx.configService.setAgentDirs).toHaveBeenCalledWith(['~/.agents/agents'])
      expect(ctx.broadcastAgentList).toHaveBeenCalledOnce()
      expect(ctx.broadcastAgentDirs).toHaveBeenCalledOnce()
    })
    it('tool.approve/deny/always_allow → 落入 default return false（no-op 已移除，由 server unknown_type 兜底）', async () => {
      // 工具审批实际走 pi extension_ui_request (confirm) 流 + config.setToolPermissions，
      // 这些 type 无真实 handler，故 return false → server 发 unknown_type（对未知 type 的正确兜底）。
      const { handler } = makeHandler_m2_d1()
      const okApprove = await handler.handleSettingsMessage(msg_m2('tool.approve', {}), WS)
      const okDeny = await handler.handleSettingsMessage(msg_m2('tool.deny', {}), WS)
      const okAlways = await handler.handleSettingsMessage(msg_m2('tool.always_allow', {}), WS)
      expect(okApprove).toBe(false)
      expect(okDeny).toBe(false)
      expect(okAlways).toBe(false)
    })
  })

  describe('discoverModels（handler 只 reply，错误翻译已下沉 model-service）', () => {
    it('成功 → reply discoveredModels success:true', async () => {
      const { replies, handler } = makeHandler_m2({ discover: vi.fn().mockResolvedValue([{ id: 'm1' }]) })
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: 'http://x', apiKey: 'k' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(replies[0].payload).toMatchObject({ success: true, models: [{ id: 'm1' }] })
    })
    it('service 抛错 → handler 透传 error.message（不再做翻译）', async () => {
      // model-service 已把 ByteString/fetch failed 翻译成中文文案（见 model-service.test.ts）；
      // handler 只 reply service 给的 message，不硬编码中文。
      const { replies, handler } = makeHandler_m2({ discover: vi.fn().mockRejectedValue(new Error('请求失败：Base URL 或 API Key 包含 HTTP 不支持的字符')) })
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: 'http://x' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(replies[0].payload.success).toBe(false)
      expect(replies[0].payload.error).toContain('不支持的字符')
    })
    it('其他错误 → 原始消息透传', async () => {
      const { replies, handler } = makeHandler_m2({ discover: vi.fn().mockRejectedValue(new Error('rate limited')) })
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: 'http://x' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(replies[0].payload.error).toBe('rate limited')
    })
    it('providerId 解析 apiKey（resolvedApiKey 传给 service）', async () => {
      // M2fg 恒注入形态：凭据回查经 ctx 构造必需的 resolver（models.json 直查回退已删除）
      const { ctx, replies, handler } = makeHandler_m2({
        resolver: { resolveProviderCredential: vi.fn().mockResolvedValue({ key: 'resolved-key', source: 'models.json' }) },
      })
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: 'http://x', providerId: 'p1' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledWith('http://x', 'resolved-key', undefined)
    })
    it('注入 resolver：凭据只在 auth.json（models.json 无 apiKey）时命中（链 2 断链修复）', async () => {
      // 旧实现只查 configService.getProvider(providerId)?.apiKey（models.json），对 catalog
      // provider 恒 miss；resolver 命中 auth.json → discover 能拿到凭据
      const resolver = {
        resolveProviderCredential: vi.fn().mockResolvedValue({ key: 'auth-json-key', source: 'auth.json' }),
      }
      const { ctx, replies, handler } = makeHandler_m2({ resolver })
      // models.json 无该 provider（旧路径必 miss 的可证伪信号）
      ctx.configService.getProvider = vi.fn().mockReturnValue(undefined) as never
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: 'http://x', providerId: 'anthropic' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(resolver.resolveProviderCredential).toHaveBeenCalledWith('anthropic')
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledWith('http://x', 'auth-json-key', undefined)
    })
    it('payload 自带 apiKey → 不走 resolver（表单值优先）', async () => {
      const resolver = { resolveProviderCredential: vi.fn().mockResolvedValue({ key: 'ignored', source: 'auth.json' }) }
      const { ctx, replies, handler } = makeHandler_m2({ resolver })
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: 'http://x', apiKey: 'form-key', providerId: 'p1' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(resolver.resolveProviderCredential).not.toHaveBeenCalled()
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledWith('http://x', 'form-key', undefined)
    })
    it('resolver 未命中（auth.json/models.json 两段全 miss）→ 凭据 undefined', async () => {
      // M2fg：默认 miss 形态 resolver → resolvedApiKey undefined（降级链已删除，恒注入可证伪）
      // 原属 settings-message-handler.test.ts；错绑 m2_d1（ctx 无 providerCredentialResolver，
      // discover 链走防御分支不调 discoverModelsFromApi）——改回原工厂。
      const { ctx, replies, handler } = makeHandler_m2()
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: 'http://x', providerId: 'anthropic' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(ctx.configService.getProvider).not.toHaveBeenCalled()
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledWith('http://x', undefined, undefined)
    })
  })

  // ── M3a：mode === 'test' 分支（per-协议真实最小请求；缺省 discover 向后兼容）──
  describe('discoverModels mode=test（per-协议真实连接测试）', () => {
    it('mode=test → 走 testProviderConnections（不再走 GET /v1/models），reply results 原样', async () => {
      const testProviderConnections = vi.fn().mockResolvedValue({
        success: true,
        results: [
          { api: 'anthropic-messages', modelId: 'k3', ok: true },
          { api: 'openai-completions', modelId: 'qwen3.8-flash', ok: false, error: 'http_error|401|unauthorized' },
        ],
      })
      const { ctx, replies, handler } = makeHandler_m2({ testProviderConnections })
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: '', providerId: 'opencode-go', mode: 'test' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(ctx.modelService.discoverModelsFromApi).not.toHaveBeenCalled()
      expect(replies[0].type).toBe('config.discoveredModels')
      expect(replies[0].payload).toEqual({
        models: [],
        success: true,
        results: [
          { api: 'anthropic-messages', modelId: 'k3', ok: true },
          { api: 'openai-completions', modelId: 'qwen3.8-flash', ok: false, error: 'http_error|401|unauthorized' },
        ],
      })
    })

    it('mode=test + providerId → 凭据经 resolver 唯一通道取（payload apiKey 被忽略）', async () => {
      const resolver = { resolveProviderCredential: vi.fn().mockResolvedValue({ key: 'auth-key', source: 'auth.json' }) }
      const testProviderConnections = vi.fn().mockResolvedValue({ success: true, results: [] })
      const { ctx, handler } = makeHandler_m2({ resolver, testProviderConnections })
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: '', providerId: 'anthropic', apiKey: 'form-key', mode: 'test' }), WS)
      await vi.waitFor(() => expect(testProviderConnections).toHaveBeenCalled(), { interval: 1 })
      expect(resolver.resolveProviderCredential).toHaveBeenCalledWith('anthropic')
      // 第 1 参 providerId、第 2 参 = resolver 明文、第 3 参 = infra tester（组合点）
      expect(testProviderConnections.mock.calls[0][0]).toBe('anthropic')
      expect(testProviderConnections.mock.calls[0][1]).toBe('auth-key')
      expect(typeof (testProviderConnections.mock.calls[0][2] as { test?: unknown }).test).toBe('function')
      expect(ctx.modelService.discoverModelsFromApi).not.toHaveBeenCalled()
    })

    it('mode=test 缺 providerId → provider_not_found（不发任何请求）', async () => {
      const testProviderConnections = vi.fn()
      const { replies, handler } = makeHandler_m2({ testProviderConnections })
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: '', mode: 'test' }), WS)
      expect(replies[0].payload).toEqual({ models: [], success: false, error: 'provider_not_found', results: [] })
      expect(testProviderConnections).not.toHaveBeenCalled()
    })

    it('modelService 未装配 testProviderConnections → test_unavailable 防御分支', async () => {
      const { replies, handler } = makeHandler_m2_d1()
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: '', providerId: 'p1', mode: 'test' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(replies[0].payload).toMatchObject({ success: false, error: 'test_unavailable' })
    })

    it('以 ctx.modelService 为 this 调用编排侧（真实实现方法体依赖 this.configService）', async () => {
      let seenThis: unknown
      const testProviderConnections = vi.fn(function (this: unknown) {
        seenThis = this
        return Promise.resolve({ success: true, results: [] })
      })
      const { ctx, replies, handler } = makeHandler_m2({ testProviderConnections })
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: '', providerId: 'p1', mode: 'test' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(seenThis).toBe(ctx.modelService)
    })

    it('mode 缺省 → 走既有 discover 路径（向后兼容：CLI / 旧调用方零改动）', async () => {
      const testProviderConnections = vi.fn()
      const discover = vi.fn().mockResolvedValue([{ id: 'm1' }])
      const { ctx, replies, handler } = makeHandler_m2({ discover, testProviderConnections })
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: 'http://x', apiKey: 'k' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(testProviderConnections).not.toHaveBeenCalled()
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledWith('http://x', 'k', undefined)
      expect(replies[0].payload).toMatchObject({ success: true, models: [{ id: 'm1' }] })
    })

    it("mode='discover' 显式传入 → 同缺省（走 GET /v1/models）", async () => {
      const testProviderConnections = vi.fn()
      const { ctx, replies, handler } = makeHandler_m2({ testProviderConnections })
      await handler.handleSettingsMessage(msg_m2('config.discoverModels', { baseUrl: 'http://x', apiKey: 'k', mode: 'discover' }), WS)
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { interval: 1 })
      expect(testProviderConnections).not.toHaveBeenCalled()
      expect(ctx.modelService.discoverModelsFromApi).toHaveBeenCalledOnce()
    })
  })

  // ── W2：config.setSkillDirs 触发 SkillRegistry 重建链 + 广播失效信号 ──
  // TC5 等效渲染 gate：断言广播消息被构造（broadcastSkillCacheInvalidated('project') 被调用）
  //   + rebuildGlobal/invalidateAllProjects 被调（重建链触发）+ broadcastSkillDirs/SkillList 仍服务 settings 弹窗。
  describe('config.setSkillDirs（W2 重建链 + 广播失效信号）', () => {
    it('TC5: 触发 rebuildGlobal → invalidateAllProjects → broadcastSkillCacheInvalidated("project")，并保留 broadcastSkillDirs/SkillList', async () => {
      const { ctx, replies, handler } = makeHandler_m2_d1()
      await handler.handleSettingsMessage(msg_m2('config.setSkillDirs', { dirs: ['~/.pi/agent/skills', '~/.claude/skills'] }), WS)
      // rebuildGlobal 是 fire-and-forget（.then 微任务），用 waitFor 等链路完成
      await vi.waitFor(() => expect(ctx.skillRegistry.invalidateAllProjects).toHaveBeenCalled(), { interval: 1 })

      // 写 discovery.skillDirs
      expect(ctx.configService.setSkillDirs).toHaveBeenCalledWith(['~/.pi/agent/skills', '~/.claude/skills'])
      // reply 配置回执
      expect(replies[0]).toMatchObject({ type: 'config.skillDirs' })
      // 重建链：rebuildGlobal（重扫 globalCache + 重挂 watcher）+ invalidateAllProjects（清 projectCache）
      expect(ctx.skillRegistry.rebuildGlobal).toHaveBeenCalledOnce()
      expect(ctx.skillRegistry.invalidateAllProjects).toHaveBeenCalledOnce()
      // 渲染 gate：广播失效信号（'project' scope，让前端 useProjectSkills 失效重新拉取）
      expect(ctx.broadcastSkillCacheInvalidated).toHaveBeenCalledWith('project')
      // settings 弹窗链路保留：broadcastSkillDirs + broadcastSkillList（服务 settingsStore）
      expect(ctx.broadcastSkillDirs).toHaveBeenCalledOnce()
      expect(ctx.broadcastSkillList).toHaveBeenCalledOnce()
    })
  })

  // ── OAuth Login（路径 B，T6）：config.oauthLogin / config.oauthCancel 路由 ──
  describe('config.oauthLogin / config.oauthCancel（OAuth 路径 B RPC）', () => {    it('oauthLogin 成功 → reply config.oauthLoginReply { started: true }', async () => {
      const { replies, handler } = makeHandler_m2_d1()
      const handled = await handler.handleSettingsMessage(msg_m2('config.oauthLogin', { providerId: 'anthropic' }), WS)
      expect(handled).toBe(true)
      expect(replies[0]).toMatchObject({ type: 'config.oauthLoginReply', payload: { started: true } })
    })

    it('oauthLogin 失败（无 oauthConfig / 已有 flow）→ reply { started: false, error }', async () => {
      const { replies, handler } = makeHandler_m2({ oauthLogin: vi.fn().mockReturnValue({ started: false, error: 'provider "openai" 不支持 OAuth' }) })
      await handler.handleSettingsMessage(msg_m2('config.oauthLogin', { providerId: 'openai' }), WS)
      expect(replies[0]).toMatchObject({ type: 'config.oauthLoginReply', payload: { started: false, error: 'provider "openai" 不支持 OAuth' } })
    })

    it('oauthCancel → reply config.oauthCancelReply，幂等（无 flow 返回 cancelled:false 不报错）', async () => {
      const { replies, handler } = makeHandler_m2({ oauthCancel: vi.fn().mockReturnValue({ cancelled: false }) })
      const handled = await handler.handleSettingsMessage(msg_m2('config.oauthCancel', { providerId: 'xai' }), WS)
      expect(handled).toBe(true)
      expect(replies[0]).toMatchObject({ type: 'config.oauthCancelReply', payload: { cancelled: false } })
    })
  })

  // ── B-1 场景 C：config.oauthLogout 路由（try/catch 双分支）──
  describe('config.oauthLogout（B-1 场景 C RPC）', () => {
    it('oauthLogout 成功 → reply config.oauthLogoutReply { ok: true }，logout 以 providerId 调用一次', async () => {
      const oauthLogout = vi.fn().mockResolvedValue(undefined)
      const { replies, handler } = makeHandler_m2({ oauthLogout })
      const handled = await handler.handleSettingsMessage(msg_m2('config.oauthLogout', { providerId: 'anthropic' }), WS)
      expect(handled).toBe(true)
      expect(oauthLogout).toHaveBeenCalledTimes(1)
      expect(oauthLogout).toHaveBeenCalledWith('anthropic')
      expect(replies[0]).toMatchObject({ id: 'm1', type: 'config.oauthLogoutReply', payload: { ok: true } })
    })

    it('oauthLogout reject → reply { ok: false, error 含「退出登录失败」与底层原因 }，不上抛', async () => {
      const oauthLogout = vi.fn().mockRejectedValue(new Error('EACCES: permission denied, open auth.json'))
      const { replies, handler } = makeHandler_m2({ oauthLogout })
      const handled = await handler.handleSettingsMessage(msg_m2('config.oauthLogout', { providerId: 'anthropic' }), WS)
      expect(handled).toBe(true)
      expect(replies[0]).toMatchObject({ type: 'config.oauthLogoutReply', payload: { ok: false } })
      // 错误文案可操作：含失败语义 + 底层原因 + 重试指引
      expect(replies[0].payload.error).toEqual(expect.stringContaining('退出登录失败'))
      expect(replies[0].payload.error).toEqual(expect.stringContaining('EACCES: permission denied'))
      expect(replies[0].payload.error).toEqual(expect.stringContaining('请重试'))
    })
  })

  // ── 环境变量检测（I3，wave-env-check TC3）：config.checkEnvVars 路由 ──
  describe('config.checkEnvVars（I3 RPC）', () => {
    it('合法 payload → reply config.envVarsChecked { results }', async () => {
      const { replies, ctx, handler } = makeHandler_m2()
      ctx.configService.checkEnvVars = vi.fn().mockReturnValue({ OPENAI_API_KEY: true, AWS_PROFILE: false })
      const handled = await handler.handleSettingsMessage(msg_m2('config.checkEnvVars', { names: ['OPENAI_API_KEY', 'AWS_PROFILE'] }), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.checkEnvVars).toHaveBeenCalledWith(['OPENAI_API_KEY', 'AWS_PROFILE'])
      expect(replies[0]).toMatchObject({ type: 'config.envVarsChecked', payload: { results: { OPENAI_API_KEY: true, AWS_PROFILE: false } } })
    })

    it('非法 payload（names 非字符串数组）→ sendError invalid_payload，不调 configService', async () => {
      const { ctx, handler, sendErrorCalls } = makeHandler_m2()
      const handled = await handler.handleSettingsMessage(msg_m2('config.checkEnvVars', { names: ['ok', 42] }), WS)
      expect(handled).toBe(true)
      expect(ctx.configService.checkEnvVars).not.toHaveBeenCalled()
      expect(sendErrorCalls[0]).toMatchObject({ code: 'invalid_payload' })
    })
  })

  // ── Phase 3 reconcile：defaultModel 维护统一收敛（P1 无双重广播 + source 统一）──
  // 设计 provider-arch-hardening §3.3 D3 / §5 Phase 3：5 handler 的 config.defaults 广播
  // 收敛到 reconcileDefaultModelAfterProviderChange，消除分散编排的遗漏根因。
  describe('Phase 3 reconcile：defaultModel 维护统一收敛（P1 无双重广播）', () => {
    it('setProvider 有 newDefault → 广播恰好 1 次，有 newDefault 时 ?? 短路不调 getDefaultModel', async () => {
      const { ctx, broadcasts, handler } = makeHandler_m2({
        setProvider: vi.fn().mockReturnValue({ newDefault: { provider: 'p1', modelId: 'm1' } }),
      })
      await handler.handleSettingsMessage(msg_m2('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
      // 有 newDefault 时 ?? 短路，不读盘 getDefaultModel（避免二次写回）
      expect(ctx.configService.getDefaultModel).not.toHaveBeenCalled()
    })

    it('setProvider 无 newDefault + getDefaultModel 有值 → 兜底广播 1 次', async () => {
      const { ctx, broadcasts, handler } = makeHandler_m2({
        setProvider: vi.fn().mockReturnValue({}),
        getDefaultModel: vi.fn().mockReturnValue({ provider: 'p1', modelId: 'm1' }),
      })
      await handler.handleSettingsMessage(msg_m2('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      expect(ctx.configService.getDefaultModel).toHaveBeenCalledOnce()
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('setProvider 无 newDefault + getDefaultModel 无值 → 不广播', async () => {
      const { broadcasts, handler } = makeHandler_m2({
        setProvider: vi.fn().mockReturnValue({}),
        getDefaultModel: vi.fn().mockReturnValue(null),
      })
      await handler.handleSettingsMessage(msg_m2('config.setProvider', { providerId: 'p1', name: 'x' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('deleteProvider 有 newDefault → 广播 1 次', async () => {
      const { broadcasts, handler } = makeHandler_m2({
        deleteProvider: vi.fn().mockResolvedValue({ removed: true, newDefault: { provider: 'p2', modelId: 'm2' } }),
      })
      await handler.handleSettingsMessage(msg_m2('config.deleteProvider', { providerId: 'p1' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('deleteProvider 无 newDefault + getDefaultModel 无值 → 不广播', async () => {
      const { broadcasts, handler } = makeHandler_m2({
        deleteProvider: vi.fn().mockResolvedValue({ removed: true }),
        getDefaultModel: vi.fn().mockReturnValue(null),
      })
      await handler.handleSettingsMessage(msg_m2('config.deleteProvider', { providerId: 'p1' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('toggleProviderEnabled 有 newDefault → 广播 1 次', async () => {
      const { broadcasts, handler } = makeHandler_m2({
        toggleProviderEnabled: vi.fn().mockReturnValue({ newDefault: { provider: 'p1', modelId: 'm1' } }),
      })
      await handler.handleSettingsMessage(msg_m2('config.toggleProviderEnabled', { providerId: 'p1', enabled: true }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('toggleProviderEnabled 无 newDefault + getDefaultModel 兜底 → 广播 1 次', async () => {
      const { broadcasts, handler } = makeHandler_m2({
        toggleProviderEnabled: vi.fn().mockReturnValue({}),
        getDefaultModel: vi.fn().mockReturnValue({ provider: 'p2', modelId: 'm2' }),
      })
      await handler.handleSettingsMessage(msg_m2('config.toggleProviderEnabled', { providerId: 'p1', enabled: false }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('removeProviderByKind 有 newDefault → 广播 1 次', async () => {
      const { broadcasts, handler } = makeHandler_m2({
        removeProviderByKind: vi.fn().mockResolvedValue({ removed: true, newDefault: { provider: 'p2', modelId: 'm2' } }),
      })
      await handler.handleSettingsMessage(msg_m2('config.removeProviderByKind', { providerId: 'p1', kind: 'custom' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('removeProviderByKind 无 newDefault + getDefaultModel 无值 → 不广播', async () => {
      const { broadcasts, handler } = makeHandler_m2({
        removeProviderByKind: vi.fn().mockResolvedValue({ removed: true }),
        getDefaultModel: vi.fn().mockReturnValue(null),
      })
      await handler.handleSettingsMessage(msg_m2('config.removeProviderByKind', { providerId: 'p1', kind: 'custom' }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('applyImportProviders 成功 → 不传 newDefault，getDefaultModel 兜底广播 1 次', async () => {
      const { ctx, broadcasts, handler } = makeHandler_m2({
        applyImportProviders: vi.fn().mockResolvedValue({ result: { imported: ['p1'] } }),
        getDefaultModel: vi.fn().mockReturnValue({ provider: 'p1', modelId: 'm1' }),
      })
      await handler.handleSettingsMessage(msg_m2('config.applyImportProviders', { importId: 'imp1', selectedIds: ['p1'] }), WS)
      expect(ctx.configService.getDefaultModel).toHaveBeenCalledOnce()
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('applyImportProviders 成功 + getDefaultModel 无值 → 不广播', async () => {
      const { broadcasts, handler } = makeHandler_m2({
        applyImportProviders: vi.fn().mockResolvedValue({ result: {} }),
        getDefaultModel: vi.fn().mockReturnValue(null),
      })
      await handler.handleSettingsMessage(msg_m2('config.applyImportProviders', { importId: 'imp1', selectedIds: ['p1'] }), WS)
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('applyImportProviders 失败（error）→ 不广播 provider 列表也不 reconcile', async () => {
      const { ctx, broadcasts, handler } = makeHandler_m2({
        applyImportProviders: vi.fn().mockResolvedValue({ error: { code: 'PREVIEW_EXPIRED', message: 'expired' } }),
      })
      await handler.handleSettingsMessage(msg_m2('config.applyImportProviders', { importId: 'imp1', selectedIds: ['p1'] }), WS)
      expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
    })

    it('广播内容：source 用合法枚举（setProvider → provider-updated），defaultModel 复合串 provider/modelId', async () => {
      const { broadcasts, handler } = makeHandler_m2({
        setProvider: vi.fn().mockReturnValue({ newDefault: { provider: 'anthropic', modelId: 'claude-opus' } }),
      })
      await handler.handleSettingsMessage(msg_m2('config.setProvider', { providerId: 'anthropic', name: 'x' }), WS)
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d?.payload).toMatchObject({ defaultModel: 'anthropic/claude-opus', source: 'provider-updated' })
    })
  })

  // ── Phase 3 P4：applyImportProviders 后 defaultModel 写盘 ──
  // reconcile 兜底分支调 getDefaultModel，后者 wasFixed:true 时写回 settings.json。
  // 用真实 pi-provider-store.getDefaultModel（tmpdir 隔离）验证端到端写盘。
  describe('Phase 3 P4：applyImportProviders 后 defaultModel 写盘（reconcile 兜底 + getDefaultModel wasFixed）', () => {
    let p4TmpDir: string
    beforeEach(async () => {
      p4TmpDir = await mkdtempP_m2(join(tmpdir(), 'p4-reconcile-'))
      mkdirSync(join(p4TmpDir, 'agent'), { recursive: true })
      setSettingsPath(join(p4TmpDir, 'agent', 'settings.json'))
      setModelsPath(join(p4TmpDir, 'agent', 'models.json'))
      refreshModels()
    })
    afterEach(async () => {
      await rmP_m2(p4TmpDir, { recursive: true, force: true })
    })

    it('applyImportProviders 成功 → reconcile 调 getDefaultModel → wasFixed 写回 settings.json.defaultProvider', async () => {
      // 场景：models.json 有 provider，settings.json 无 defaultProvider
      // → findValidDefaultModel 走 pickFirstModelProvider fallback，wasFixed:true
      // → getDefaultModel 写回 settings.json（设 defaultProvider/defaultModel）
      writeModels({
        providers: {
          'p1': { apiKey: 'sk-x', enabled: true, models: [{ id: 'm1', name: 'M1' }] },
        },
      })
      refreshModels()

      // getDefaultModel 走真实 pi-provider-store.getDefaultModel（tmpdir 隔离）
      const { broadcasts, handler } = makeHandler_m2({
        applyImportProviders: vi.fn().mockResolvedValue({ result: { imported: ['p1'] } }),
        getDefaultModel: vi.fn(() => piProviderGetDefaultModel()),
      })
      await handler.handleSettingsMessage(
        msg_m2('config.applyImportProviders', { importId: 'imp1', selectedIds: ['p1'] }),
        WS,
      )

      // P4 核心：settings.json.defaultProvider 被写入（getDefaultModel wasFixed 写回生效）
      const settings = readSettings()
      expect(settings.defaultProvider).toBe('p1')
      expect(settings.defaultModel).toBe('m1')
      // 且 reconcile 广播了 config.defaults（收尾后统一入口）
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })
  })

  // ── scoped model（design §4.1 A5/A7/A9）：config.setScopedModels 路由 ──
  // 校验（非法整单拒绝）→ 去重保序写入 → defaultModel 同步 scoped[0] → 广播 + reply。
  describe('A5: config.setScopedModels 默认模型联动（scoped[0] 写 default）', () => {
    it('A5 setScopedModels 后 defaultModel 同步写为 scoped[0] + 广播 config.defaults (source=default-set)', async () => {
      const { ctx, replies, broadcasts, handler } = makeHandler_m2({
        // R3-2：default 同步前置校验 scoped[0] 的 provider 可用（存在且 enabled）
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: true }]),
        modifyScopedModels: vi.fn(async () => ['p/m1', 'p/m2']),
        getDefaultModel: vi.fn().mockReturnValue(null),
      })

      await handler.handleSettingsMessage(msg_m2('config.setScopedModels', { models: ['p/m1', 'p/m2'] }), WS)

      // 列表非空且 scoped[0] ≠ 当前 default → 写 default 为 scoped[0]
      expect(ctx.configService.setDefaultModel).toHaveBeenCalledWith('p', 'm1')
      const d = broadcasts.find(b => b.type === 'config.defaults')
      expect(d?.payload).toMatchObject({ defaultModel: 'p/m1', source: 'default-set' })
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: ['p/m1', 'p/m2'] } })
    })

    it('scoped[0] 已是当前 default 时不重写 setDefaultModel（config.defaults 幂等广播仍触发）', async () => {
      const { ctx, broadcasts, handler } = makeHandler_m2({
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: true }]),
        modifyScopedModels: vi.fn(async () => ['p/m1']),
        getDefaultModel: vi.fn().mockReturnValue({ provider: 'p', modelId: 'm1' }),
      })

      await handler.handleSettingsMessage(msg_m2('config.setScopedModels', { models: ['p/m1'] }), WS)

      expect(ctx.configService.setDefaultModel).not.toHaveBeenCalled()
      // 已是 default → defaultSynced=true，广播幂等值（与旧行为一致）
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(1)
    })

    it('S7 空列表 → default 不变（不调 setDefaultModel、不广播 config.defaults），reply scopedModels:[]，broadcastProviderList 仍触发', async () => {
      // 设计 §4.1 S7：清空白名单不动默认模型。实现依据 handler 的 `if (result.length > 0)` 检查
      //（settings-message-handler.ts）——空列表两段（写 default / 广播 defaults）都跳过，
      // provider 列表广播仍触发（前端需刷新 scopedModels 视图）。
      const { ctx, replies, broadcasts, handler } = makeHandler_m2({
        modifyScopedModels: vi.fn(async () => []),
      })

      await handler.handleSettingsMessage(msg_m2('config.setScopedModels', { models: [] }), WS)

      // ① 不调 setDefaultModel（连带 getDefaultModel 也不读——检查短路）
      expect(ctx.configService.setDefaultModel).not.toHaveBeenCalled()
      expect(ctx.configService.getDefaultModel).not.toHaveBeenCalled()
      // ② 不广播 config.defaults
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
      // ③ reply 含写入结果 scopedModels: []
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: [] } })
      // ④ broadcastProviderList 仍触发
      expect(ctx.broadcastProviderList).toHaveBeenCalledOnce()
    })

    it('R3-1 setDefaultModel 抛错 → warn 降级不阻断主语义：reply 仍返回新 scopedModels，broadcastProviderList 仍触发', async () => {
      // 三方撕裂修复：providers.json 已写入（modifyScopedModels 成功）但 setDefaultModel
      // 抛错时，广播与 reply 必须继续（scoped 写入是主语义，default 同步是附带操作）。
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { ctx, replies, broadcasts, handler } = makeHandler_m2({
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: true }]),
        modifyScopedModels: vi.fn(async () => ['p/m1', 'p/m2']),
        getDefaultModel: vi.fn().mockReturnValue(null),
        setDefaultModel: vi.fn(() => { throw new Error('settings.json 写入失败') }),
      })

      const handled = await handler.handleSettingsMessage(msg_m2('config.setScopedModels', { models: ['p/m1', 'p/m2'] }), WS)

      expect(handled).toBe(true)
      // reply 仍返回写入结果（renderer 不回滚 UI）
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: ['p/m1', 'p/m2'] } })
      // provider 列表广播仍触发（model.list 白名单刷新依赖它）
      expect(ctx.broadcastProviderList).toHaveBeenCalledOnce()
      // 降级可定位：warn 带 scoped[0] 与「已写入」上下文；default 未同步成功 → 不广播假默认
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('p/m1'), expect.anything())
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
      warnSpy.mockRestore()
    })

    it('R3-2 scoped[0] 属 disabled provider → 跳过 default 同步（不调 setDefaultModel/getDefaultModel，不广播假默认），reply/广播不受影响', async () => {
      // 用户把已 toggle OFF 的 provider 模型置首：无条件同步会被 findValidDefaultModel
      // 随后冲掉（静默破坏「第一位即默认」），前置校验后跳过同步、保留现有 default。
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { ctx, replies, broadcasts, handler } = makeHandler_m2({
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: false }]),
        modifyScopedModels: vi.fn(async () => ['p/m1', 'p/m2']),
        getDefaultModel: vi.fn().mockReturnValue({ provider: 'other', modelId: 'keep' }),
      })

      await handler.handleSettingsMessage(msg_m2('config.setScopedModels', { models: ['p/m1', 'p/m2'] }), WS)

      // 不调 setDefaultModel（provider 检查失败短路，连 getDefaultModel 也不读）
      expect(ctx.configService.setDefaultModel).not.toHaveBeenCalled()
      expect(ctx.configService.getDefaultModel).not.toHaveBeenCalled()
      // 不广播 config.defaults（现有 default 保留，不广播未落盘的 scoped[0]）
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
      // scoped 主语义不受影响：广播 + reply 正常
      expect(ctx.broadcastProviderList).toHaveBeenCalledOnce()
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: ['p/m1', 'p/m2'] } })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('p/m1'))
      warnSpy.mockRestore()
    })
  })

  describe('A7: setScopedModels 广播后模型列表只含 scoped 且有序', () => {
    it('A7 setScopedModels 触发 broadcastProviderList + reply 按写入序；随后 model.list reply aggregateModels 结果', async () => {
      // aggregateModels 的 scoped 过滤/排序在 model-service.test.ts（A1/A3）覆盖，
      // 此处验证 handler 链路：setScopedModels 后广播 provider 列表（含 scopedModels），
      // model.list 的 reply 透传 aggregateModels（scoped 过滤后）结果。
      const aggregate = vi.fn().mockReturnValue([{ id: 'C' }, { id: 'A' }])
      const { ctx, replies, handler } = makeHandler_m2({
        // R3-2：provider 可用性校验需要列表含 provider 'p'（enabled），否则 default 同步被跳过
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: true }]),
        modifyScopedModels: vi.fn(async () => ['p/C', 'p/A']),
        aggregate,
      })

      await handler.handleSettingsMessage(msg_m2('config.setScopedModels', { models: ['p/C', 'p/A'] }), WS)
      expect(ctx.broadcastProviderList).toHaveBeenCalledOnce()
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: ['p/C', 'p/A'] } })

      await handler.handleSettingsMessage(msg_m2('model.list', {}), WS)
      expect(aggregate).toHaveBeenCalledOnce()
      expect(replies[1]).toMatchObject({ type: 'model.list', payload: { models: [{ id: 'C' }, { id: 'A' }] } })
    })
  })

  describe('A9: config.setScopedModels 格式校验与去重', () => {
    it('A9 非法条目（无斜杠）→ sendError invalid_scoped_models，整单拒绝（不写入不广播不 reply）', async () => {
      const modifyScopedModels = vi.fn(async (fn: (c: string[]) => string[]) => fn([]))
      const { ctx, replies, broadcasts, sendErrorCalls, handler } = makeHandler_m2({ modifyScopedModels })

      await handler.handleSettingsMessage(msg_m2('config.setScopedModels', { models: ['p/m1', 'gpt-4'] }), WS)

      expect(sendErrorCalls[0]).toMatchObject({ code: 'invalid_scoped_models' })
      expect(modifyScopedModels).not.toHaveBeenCalled()
      expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
      expect(broadcasts.filter(b => b.type === 'config.defaults')).toHaveLength(0)
      expect(replies).toHaveLength(0)
    })

    it('A9 空 provider 前缀（/gpt-4）同样整单拒绝', async () => {
      const { sendErrorCalls, handler } = makeHandler_m2_d1()
      await handler.handleSettingsMessage(msg_m2('config.setScopedModels', { models: ['/gpt-4'] }), WS)
      expect(sendErrorCalls[0]).toMatchObject({ code: 'invalid_scoped_models' })
    })

    it('A9 models 非数组 / 元素非字符串 → sendError invalid_payload', async () => {
      const { sendErrorCalls, handler } = makeHandler_m2_d1()
      await handler.handleSettingsMessage(msg_m2('config.setScopedModels', { models: 'not-array' }), WS)
      expect(sendErrorCalls[0]).toMatchObject({ code: 'invalid_payload' })
    })

    it('A9 合法条目去重保序写入（写入函数整单替换为去重序，reply 同步返回）', async () => {
      // handler 传 () => deduped：忽略 current（整单替换），写入值为去重保序结果
      const written: string[][] = []
      const modifyScopedModels = vi.fn(async (fn: (c: string[]) => string[]) => {
        const out = fn(['old/x'])
        written.push(out)
        return out
      })
      const { replies, handler } = makeHandler_m2({
        listProviders: vi.fn().mockReturnValue([{ id: 'p', enabled: true }]),
        modifyScopedModels,
      })

      await handler.handleSettingsMessage(
        msg_m2('config.setScopedModels', { models: ['p/m1', 'p/m2', 'p/m1', 'p/m3', 'p/m2'] }),
        WS,
      )

      expect(written[0]).toEqual(['p/m1', 'p/m2', 'p/m3'])
      expect(replies[0]).toMatchObject({ type: 'config.scopedModels', payload: { scopedModels: ['p/m1', 'p/m2', 'p/m3'] } })
    })
  })
})
// ── M2c：D3 链 2 接线（RuntimeServer.setServices → handler ctx → resolver）────────────
// 「装配点真的传了」的落点 = RuntimeServer.setServices 的 optional 对象（组合根 index.ts
// 经此传入）与 assembleCoreHandlers 的 ctx 透传。本组不用手搓 ctx，而是经真实 RuntimeServer
// 装配后取真实 handler——证明 resolver 沿 server 装配链路到达消费点，且 discover 真的用它
// 取凭据（不再降级回 configService.getProvider 的 models.json 单源）。
describe('M2c: RuntimeServer.setServices 透传 providerCredentialResolver（D3 链 2 装配点）', () => {
  function assembleWithResolver() {
    const MockSvc = createMockSessionServiceClass()
    const sessionService = new MockSvc() as unknown as ISessionService
    const resolveProviderCredential = vi.fn(async () => ({ key: 'resolved-by-resolver', source: 'auth.json' as const, kind: 'api_key' as const }))
    const resolver = {
      hasProviderCredential: vi.fn(() => true),
      listCredentialBackedProviderIds: vi.fn(() => new Set<string>()),
      resolveProviderCredential,
      resolveProviderApiKeyRaw: async () => undefined,
      resolveProviderBaseUrl: () => undefined,
    }
    const discoverModelsFromApi = vi.fn(async () => [{ id: 'm1' }])
    // 降级回查的诱饵：resolver 生效时不得被触碰
    const getProvider = vi.fn(() => ({ apiKey: 'models-json-key' }))
    const server = new RuntimeServer(0, '/tmp/m2c-server-wiring')
    server.setServices(sessionService, { getProvider } as never, { discoverModelsFromApi } as never, {
      providerCredentialResolver: resolver,
    })
    return { server, resolver, resolveProviderCredential, discoverModelsFromApi, getProvider }
  }

  it('server 装配的 handler ctx 持有同一 resolver 实例', () => {
    const { server, resolver } = assembleWithResolver()
    const handler = (server as unknown as { settingsHandler: SettingsMessageHandler }).settingsHandler
    const ctx = (handler as unknown as { ctx: { providerCredentialResolver?: unknown } }).ctx

    expect(ctx.providerCredentialResolver).toBe(resolver)
  })

  it('config.discoverModels 经该 resolver 取凭据（不落 models.json 降级回查），reply 走真实 broker', async () => {
    const { server, resolveProviderCredential, discoverModelsFromApi, getProvider } = assembleWithResolver()
    const handler = (server as unknown as { settingsHandler: SettingsMessageHandler }).settingsHandler
    const ws = { readyState: 1, send: vi.fn() }

    await handler.handleSettingsMessage(
      msg_m2('config.discoverModels', { baseUrl: 'https://api.example', providerId: 'p1' }),
      ws as never,
    )

    await vi.waitFor(() => expect(discoverModelsFromApi).toHaveBeenCalledTimes(1), { interval: 1 })
    expect(resolveProviderCredential).toHaveBeenCalledWith('p1')
    expect(discoverModelsFromApi).toHaveBeenCalledWith('https://api.example', 'resolved-by-resolver', undefined)
    expect(getProvider).not.toHaveBeenCalled()
    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toMatchObject({
      type: 'config.discoveredModels',
      payload: { success: true },
    })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('settings-message-handler-dispatch', () => {
describe('SettingsMessageHandler 分发路由（W1 表驱动重构回归锚定）', () => {
  it('session.setThinkingLevel → reply session.thinkingLevelSet 回传生效值（P3：非请求值）', async () => {
    const setThinkingLevel = vi.fn().mockResolvedValue('high')
    const { ctx, replies, handler } = makeHandler_m2_d1({}, { setThinkingLevel })
    const handled = await handler.handleSettingsMessage(msg_m2('session.setThinkingLevel', { sessionId: 's1', level: 'max' }), WS_m2)
    expect(handled).toBe(true)
    expect(ctx.modelService.setThinkingLevel).toHaveBeenCalledWith('s1', 'max')
    // 生效值（钳制后）而非请求值
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'session.thinkingLevelSet', payload: { sessionId: 's1', level: 'high' } })
  })

  describe('config.getTerminalConfig / setTerminalConfig（system-prompt 同构，此前无 handler 层测试）', () => {
    it('getTerminalConfig → reply config.terminalConfig { config, corrupted } 透传', async () => {
      const getTerminalConfig = vi.fn().mockReturnValue({ config: { fontSize: 12 }, corrupted: true })
      const { ctx, replies, handler } = makeHandler_m2_d1({ getTerminalConfig })
      const handled = await handler.handleSettingsMessage(msg_m2('config.getTerminalConfig', {}), WS_m2)
      expect(handled).toBe(true)
      expect(ctx.configService.getTerminalConfig).toHaveBeenCalledOnce()
      expect(replies[0]).toMatchObject({ id: 'm1', type: 'config.terminalConfig', payload: { config: { fontSize: 12 }, corrupted: true } })
    })

    it('setTerminalConfig 成功 → reply + broadcast config.terminalConfig（corrupted=false）', async () => {
      const { ctx, replies, broadcasts, handler } = makeHandler_m2_d1()
      const handled = await handler.handleSettingsMessage(msg_m2('config.setTerminalConfig', { config: { fontSize: 14 } }), WS_m2)
      expect(handled).toBe(true)
      expect(ctx.configService.setTerminalConfig).toHaveBeenCalledWith({ fontSize: 14 })
      expect(replies[0]).toMatchObject({ type: 'config.terminalConfig', payload: { config: { fontSize: 14 }, corrupted: false } })
      const b = broadcasts.find(m => m.type === 'config.terminalConfig')
      expect(b).toBeDefined()
      expect(b?.payload).toMatchObject({ config: { fontSize: 14 }, corrupted: false })
    })

    it('setTerminalConfig 失败 → sendError(set_terminal_config_failed)，不 reply 不广播', async () => {
      const { ctx, replies, broadcasts, sendErrorCalls, handler } = makeHandler_m2_d1({
        setTerminalConfig: vi.fn().mockReturnValue({ ok: false, error: 'timeout out of range' }),
      })
      const handled = await handler.handleSettingsMessage(msg_m2('config.setTerminalConfig', { config: {} }), WS_m2)
      expect(handled).toBe(true)
      expect(sendErrorCalls[0]).toMatchObject({ id: 'm1', code: 'set_terminal_config_failed', message: 'timeout out of range' })
      expect(replies).toHaveLength(0)
      expect(broadcasts.filter(b => b.type === 'config.terminalConfig')).toHaveLength(0)
    })
  })

  describe('auto-rename / rename-model 简单读写转发', () => {
    it('config.setAutoRenameEnabled → 写 + reply 回读值', async () => {
      const setAutoRenameEnabled = vi.fn()
      const { ctx, replies, handler } = makeHandler_m2_d1({ setAutoRenameEnabled, getAutoRenameEnabled: vi.fn().mockReturnValue(true) })
      const handled = await handler.handleSettingsMessage(msg_m2('config.setAutoRenameEnabled', { enabled: true }), WS_m2)
      expect(handled).toBe(true)
      expect(ctx.configService.setAutoRenameEnabled).toHaveBeenCalledWith(true)
      expect(replies[0]).toMatchObject({ type: 'config.autoRenameEnabled', payload: { enabled: true } })
    })

    it('config.setRenameModel → 写 + reply 回读值', async () => {
      const setRenameModel = vi.fn()
      const { ctx, replies, handler } = makeHandler_m2_d1({ setRenameModel, getRenameModel: vi.fn().mockReturnValue('p/new') })
      const handled = await handler.handleSettingsMessage(msg_m2('config.setRenameModel', { model: 'p/new' }), WS_m2)
      expect(handled).toBe(true)
      expect(ctx.configService.setRenameModel).toHaveBeenCalledWith('p/new')
      expect(replies[0]).toMatchObject({ type: 'config.renameModel', payload: { model: 'p/new' } })
    })
  })

  describe('smart-context 配置组抽样', () => {
    it('config.setSmartContextEnabled → 写 + reply smartContextEnabled 回读 enabled', async () => {
      const { ctx, replies, handler } = makeHandler_m2_d1({
        setSmartContextEnabled: vi.fn(),
        getSmartContextConfig: vi.fn().mockReturnValue({ enabled: true, compactModel: 'p/m', reminderThresholds: {}, excludedModels: [] }),
      })
      const handled = await handler.handleSettingsMessage(msg_m2('config.setSmartContextEnabled', { enabled: true }), WS_m2)
      expect(handled).toBe(true)
      expect(ctx.configService.setSmartContextEnabled).toHaveBeenCalledWith(true)
      expect(replies[0]).toMatchObject({ type: 'config.smartContextEnabled', payload: { enabled: true } })
    })

    it('config.setSmartContextThresholds → reply smartContextThresholds 回读 reminderThresholds', async () => {
      const thresholds = { warn: 0.7 }
      const { ctx, replies, handler } = makeHandler_m2_d1({
        getSmartContextConfig: vi.fn().mockReturnValue({ enabled: true, compactModel: '', reminderThresholds: thresholds, excludedModels: [] }),
      })
      const handled = await handler.handleSettingsMessage(msg_m2('config.setSmartContextThresholds', { thresholds }), WS_m2)
      expect(handled).toBe(true)
      expect(ctx.configService.setSmartContextThresholds).toHaveBeenCalledWith(thresholds)
      expect(replies[0]).toMatchObject({ type: 'config.smartContextThresholds', payload: { thresholds } })
    })
  })

  it('config.setExtensionDirs → 写 + reply config.extensionDirs + broadcastExtensionDirs', async () => {
    const { ctx, replies, handler } = makeHandler_m2_d1()
    const handled = await handler.handleSettingsMessage(msg_m2('config.setExtensionDirs', { dirs: ['/a', '/b'] }), WS_m2)
    expect(handled).toBe(true)
    expect(ctx.configService.setExtensionDirs).toHaveBeenCalledWith(['/a', '/b'])
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'config.extensionDirs', payload: { dirs: ['/a', '/b'] } })
    expect(ctx.broadcastExtensionDirs).toHaveBeenCalledOnce()
  })

  describe('@deprecated agent 兼容路径（ADR-0021 §5 兼容期，仍须活）', () => {
    it('config.setAgent → upsertAgent + reply config.agentUpdated + broadcastAgentList', async () => {
      const agent = { id: 'a1', name: 'A' }
      const { ctx, replies, handler } = makeHandler_m2_d1()
      const handled = await handler.handleSettingsMessage(msg_m2('config.setAgent', { agent }), WS_m2)
      expect(handled).toBe(true)
      expect(ctx.configService.upsertAgent).toHaveBeenCalledWith(agent)
      expect(replies[0]).toMatchObject({ type: 'config.agentUpdated', payload: { agent, success: true } })
      expect(ctx.broadcastAgentList).toHaveBeenCalledOnce()
    })

    it('config.deleteAgent → deleteAgent + reply config.agentDeleted + broadcastAgentList', async () => {
      const { ctx, replies, handler } = makeHandler_m2_d1()
      const handled = await handler.handleSettingsMessage(msg_m2('config.deleteAgent', { agentId: 'a1' }), WS_m2)
      expect(handled).toBe(true)
      expect(ctx.configService.deleteAgent).toHaveBeenCalledWith('a1')
      expect(replies[0]).toMatchObject({ type: 'config.agentDeleted', payload: { agentId: 'a1', success: true } })
      expect(ctx.broadcastAgentList).toHaveBeenCalledOnce()
    })
  })

  it('config.listBuiltinProviders → reply config.builtinProviders（只读无广播）', async () => {
    const listBuiltinProviders = vi.fn().mockReturnValue([{ id: 'b1' }])
    const { ctx, replies, broadcasts, handler } = makeHandler_m2_d1({ listBuiltinProviders })
    const handled = await handler.handleSettingsMessage(msg_m2('config.listBuiltinProviders', {}), WS_m2)
    expect(handled).toBe(true)
    expect(replies[0]).toMatchObject({ type: 'config.builtinProviders', payload: { providers: [{ id: 'b1' }] } })
    expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
  })

  it('config.setToolPermissions → updateToolPermissions + reply config.toolPermissionsSaved { saved: true }', async () => {
    const { ctx, replies, handler } = makeHandler_m2_d1()
    const handled = await handler.handleSettingsMessage(msg_m2('config.setToolPermissions', { permissions: { bash: 'allow' } }), WS_m2)
    expect(handled).toBe(true)
    expect(ctx.configService.updateToolPermissions).toHaveBeenCalledWith({ bash: 'allow' })
    expect(replies[0]).toMatchObject({ type: 'config.toolPermissionsSaved', payload: { saved: true } })
  })

  it('未知 type（非 tool.* 占位）→ 查表落空返回 false（server 发 unknown_type 兜底）', async () => {
    const { handler } = makeHandler_m2_d1()
    const handled = await handler.handleSettingsMessage(msg_m2('config.nonexistent', {}), WS_m2)
    expect(handled).toBe(false)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('settings-message-handler-system-prompt', () => {
describe('SettingsMessageHandler system-prompt routes', () => {
  it('config.getSystemPrompt → reply config.systemPrompt { config, corrupted }', async () => {
    const { handler, ctx, configService, replies } = makeHandler_m3()
    configService.getSystemPromptConfig.mockReturnValue({ config: DEFAULT_CONFIG, corrupted: false })

    const handled = await handler.handleSettingsMessage(msg_m3('config.getSystemPrompt', {}), WS_m3)

    expect(handled).toBe(true)
    expect(configService.getSystemPromptConfig).toHaveBeenCalledTimes(1)
    expect(replies[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { config: DEFAULT_CONFIG, corrupted: false },
    })
    // 失败路径不应触发 error envelope
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('config.getSystemPrompt 读取损坏时 corrupted=true 仍正常回复', async () => {
    const { handler, configService, replies } = makeHandler_m3()
    configService.getSystemPromptConfig.mockReturnValue({ config: DEFAULT_CONFIG, corrupted: true })

    await handler.handleSettingsMessage(msg_m3('config.getSystemPrompt', {}), WS_m3)

    expect(replies[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { corrupted: true },
    })
  })

  it('config.setSystemPrompt 成功 → 写盘 + reply + broadcast config.systemPrompt', async () => {
    const { handler, configService, replies, broadcasts } = makeHandler_m3()
    const cfg: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: 'replace core' },
      append: { enabled: true, prompt: 'append extra' },
    }
    configService.setSystemPromptConfig.mockReturnValue({ ok: true })

    const handled = await handler.handleSettingsMessage(msg_m3('config.setSystemPrompt', { config: cfg }), WS_m3)

    expect(handled).toBe(true)
    expect(configService.setSystemPromptConfig).toHaveBeenCalledExactlyOnceWith(cfg)
    expect(replies[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { config: cfg, corrupted: false },
    })
    expect(broadcasts[0]).toMatchObject({
      type: 'config.systemPrompt',
      payload: { config: cfg, corrupted: false },
    })
  })

  it('config.setSystemPrompt 失败 → 按 D10 错误信封回复，不广播', async () => {
    const { handler, configService, replies, broadcasts, sendErrorCalls } = makeHandler_m3()
    const cfg: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: 'x'.repeat(16001) },
      append: { enabled: false, prompt: '' },
    }
    configService.setSystemPromptConfig.mockReturnValue({ ok: false, error: 'replace prompt exceeds max length' })

    const handled = await handler.handleSettingsMessage(msg_m3('config.setSystemPrompt', { config: cfg }), WS_m3)

    expect(handled).toBe(true)
    expect(configService.setSystemPromptConfig).toHaveBeenCalledExactlyOnceWith(cfg)
    expect(sendErrorCalls[0]).toMatchObject({
      code: 'set_system_prompt_failed',
      message: 'replace prompt exceeds max length',
      id: 'm1',
    })
    expect(replies).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('system-prompt-config', () => {
beforeEach(() => {
  tmpDir_m2_m2_d1 = mkdtempSync(join(tmpdir(), 'system-prompt-cfg-'))
  configDir = join(tmpDir_m2_m2_d1, 'config')
  mkdirSync(configDir, { recursive: true })

  const store = makeFakeConfigStore(configDir)
  rawService = new ConfigService(
    tmpDir_m2_m2_d1,
    store as unknown as ConstructorParameters<typeof ConfigService>[1],
  )
  service = rawService as unknown as SystemPromptSvc
})
afterEach(() => {
  rmSync(tmpDir_m2_m2_d1, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('ConfigService system-prompt', () => {
  it('set 后再 get 返回相同配置且 corrupted=false', () => {
    const cfg: SystemPromptConfig_m2 = {
      version: 1,
      replace: { enabled: true, prompt: 'replace-me' },
      append: { enabled: true, prompt: 'append-me' },
      capability: { enabled: false },
    }

    const setResult = service.setSystemPromptConfig(cfg)
    expect(setResult.ok).toBe(true)

    const got = service.getSystemPromptConfig()
    expect(got.corrupted).toBe(false)
    expect(got.config).toEqual(cfg)
  })

  it('配置文件缺失时返回默认配置且 corrupted=false', () => {
    expect(existsSync(systemPromptPath())).toBe(false)

    const got = service.getSystemPromptConfig()
    expect(got.corrupted).toBe(false)
    expect(got.config).toEqual(DEFAULT_SYSTEM_PROMPT_CONFIG)
  })

  it('配置文件 JSON 损坏时返回默认配置且 corrupted=true', () => {
    writeFileSync(systemPromptPath(), '{ not valid json', 'utf-8')

    const got = service.getSystemPromptConfig()
    expect(got.corrupted).toBe(true)
    expect(got.config).toEqual(DEFAULT_SYSTEM_PROMPT_CONFIG)
  })

  it('replace.prompt 超长时返回 ok:false 且不写盘', () => {
    const cfg: SystemPromptConfig_m2 = {
      version: 1,
      replace: { enabled: true, prompt: 'x'.repeat(SYSTEM_PROMPT_MAX_LENGTH + 1) },
      append: { enabled: false, prompt: '' },
    }

    const setResult = service.setSystemPromptConfig(cfg)
    expect(setResult.ok).toBe(false)
    expect(setResult.error).toBeTruthy()
    expect(existsSync(systemPromptPath())).toBe(false)
  })

  it('getReplaceSystemPrompt：enabled + 非空时返回原文', () => {
    const cfg: SystemPromptConfig_m2 = {
      version: 1,
      replace: { enabled: true, prompt: 'custom core prompt' },
      append: { enabled: false, prompt: '' },
    }
    service.setSystemPromptConfig(cfg)

    expect(service.getReplaceSystemPrompt()).toBe('custom core prompt')
  })

  it('getReplaceSystemPrompt：enabled + 纯空白时视为未启用返回 undefined', () => {
    const cfg: SystemPromptConfig_m2 = {
      version: 1,
      replace: { enabled: true, prompt: '   \t\n  ' },
      append: { enabled: false, prompt: '' },
    }
    service.setSystemPromptConfig(cfg)

    expect(service.getReplaceSystemPrompt()).toBeUndefined()
  })

  it('getReplaceSystemPrompt：disabled 时返回 undefined', () => {
    const cfg: SystemPromptConfig_m2 = {
      version: 1,
      replace: { enabled: false, prompt: 'ignored' },
      append: { enabled: false, prompt: '' },
    }
    service.setSystemPromptConfig(cfg)

    expect(service.getReplaceSystemPrompt()).toBeUndefined()
  })

  it('setSystemPromptConfig 超长拒绝时不会覆盖已有的合法配置', () => {
    const valid: SystemPromptConfig_m2 = {
      version: 1,
      replace: { enabled: true, prompt: 'valid' },
      append: { enabled: false, prompt: '' },
    }
    service.setSystemPromptConfig(valid)
    const before = readFileSync(systemPromptPath(), 'utf-8')

    const invalid: SystemPromptConfig_m2 = {
      version: 1,
      replace: { enabled: true, prompt: 'x'.repeat(SYSTEM_PROMPT_MAX_LENGTH + 1) },
      append: { enabled: false, prompt: '' },
    }
    service.setSystemPromptConfig(invalid)

    const after = readFileSync(systemPromptPath(), 'utf-8')
    expect(after).toBe(before)
  })

  it('capability 透传：磁盘 v2 json 的 enabled 布尔原样读回（merge 不剥字段）', () => {
    writeFileSync(
      systemPromptPath(),
      JSON.stringify({
        version: 2,
        replace: { enabled: false, prompt: '' },
        append: { enabled: false, prompt: '' },
        capability: { enabled: false },
      }),
      'utf-8',
    )
    // 关闭态回读不丢失：若 merge 层剥字段，UI 重开设置页会误显「开」并误开写回
    expect(service.getSystemPromptConfig().config.capability).toEqual({ enabled: false })
  })

  it('capability 非布尔 / 缺字段 / 非对象 → 回退 enabled true（默认开，D6 解析方向）', () => {
    const bads: unknown[] = [
      // v1 存量 json：无 capability 字段
      { version: 1, replace: { enabled: false, prompt: '' }, append: { enabled: false, prompt: '' } },
      // 损坏形态：enabled 为字符串 "false"（非布尔）
      { capability: { enabled: 'false' } },
      // 损坏形态：capability 字段非对象
      { capability: 'off' },
    ]
    for (const bad of bads) {
      writeFileSync(systemPromptPath(), JSON.stringify(bad), 'utf-8')
      expect(service.getSystemPromptConfig().config.capability).toEqual({ enabled: true })
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('system-prompt-extension', () => {
beforeEach(() => {
  tmpDir_m2_m2_d1 = mkdtempSync(join(tmpdir(), 'system-prompt-ext-'))
  dataDir = tmpDir_m2_m2_d1
  // 新布局形态（方案 B）：agentDir = <dataDir>/agent，插件回退推导 1 层上溯得 dataDir
  piAgentDir_m2 = join(tmpDir_m2_m2_d1, 'agent')
  mkdirSync(piAgentDir_m2, { recursive: true })
  agentsDir = join(tmpDir_m2_m2_d1, 'agents')
  mkdirSync(agentsDir, { recursive: true })
  originalDataDir = process.env.TAIJI_AGENT_DATA_DIR
  originalPiAgentDir = process.env.PI_CODING_AGENT_DIR
  originalGlobalAgentsDir = process.env.TAIJI_GLOBAL_AGENTS_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dataDir
  delete process.env.PI_CODING_AGENT_DIR
  process.env.TAIJI_GLOBAL_AGENTS_DIR = agentsDir
})
afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.TAIJI_AGENT_DATA_DIR
  } else {
    process.env.TAIJI_AGENT_DATA_DIR = originalDataDir
  }
  if (originalPiAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR
  } else {
    process.env.PI_CODING_AGENT_DIR = originalPiAgentDir
  }
  if (originalGlobalAgentsDir === undefined) {
    delete process.env.TAIJI_GLOBAL_AGENTS_DIR
  } else {
    process.env.TAIJI_GLOBAL_AGENTS_DIR = originalGlobalAgentsDir
  }
  rmSync(tmpDir_m2_m2_d1, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('@zhushanwen/pi-system-prompt', () => {
  it('append 开启且非空 → 返回 BASE + "\\n\\n" + EXTRA', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'EXTRA' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    const result = handler({ systemPrompt: 'BASE' })
    expect(result).toEqual({ systemPrompt: 'BASE\n\nEXTRA' })
  })

  it('append 关闭 → 返回 undefined', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: 'ignored' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined()
  })

  it('配置文件缺失 → capability 默认开，仅注入 capability 段（D6：缺字段 → true）', async () => {
    const factory = await loadPlugin()
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt: expect.stringContaining(CAP_HEADER),
    })
  })

  it('配置文件 JSON 损坏 → 同缺省语义，capability 默认开', async () => {
    const factory = await loadPlugin()
    writeFileSync(join(dataDir, 'system-prompt.json'), '{ not json', 'utf-8')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt: expect.stringContaining(CAP_HEADER),
    })
  })

  it('capability 段含 M0 正/负面清单文案（设计 D1 ①②）', async () => {
    const factory = await loadPlugin()
    const { handler } = installPlugin(factory)

    const result = handler({ systemPrompt: 'BASE' })
    const prompt = result!.systemPrompt as string
    const capability = prompt.slice(prompt.indexOf(CAP_HEADER))
    // ① 正面清单（标签族 + 呈现属性）与 ② 负面清单均在真实注入文本里
    expect(capability).toContain('You may use these tags: ')
    expect(capability).toContain('Presentational attributes allowed: ')
    expect(capability).toContain('Do not use these tags (they are stripped before rendering): ')
    expect(capability).toContain('Do not use these attributes (they are stripped and have no effect): ')
    expect(capability).toContain('table')
    expect(capability).toContain('colspan')
    expect(capability).toContain('svg')
    expect(capability).toContain('data-*')
  })

  it('append.prompt 纯空白 → 返回 undefined', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: '   \t\n  ' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined()
  })

  it('未设 TAIJI_AGENT_DATA_DIR 时可用 PI_CODING_AGENT_DIR 回退定位配置', async () => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    process.env.PI_CODING_AGENT_DIR = piAgentDir_m2

    const factory = await loadPlugin()
    // PI_CODING_AGENT_DIR/.. === tmpDir_m2_m2 === dataDir（<dataDir>/agent 1 层上溯）
    writeConfig(tmpDir_m2_m2_d1, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'FALLBACK' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({ systemPrompt: 'BASE\n\nFALLBACK' })
  })

  it('全局 AGENTS.md 存在 → 追加带头部的内容', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: '' },
      ...CAP_OFF,
    })
    const p = writeGlobalAgents('GLOBAL_RULES')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt: 'BASE' + globalSegment(p, 'GLOBAL_RULES'),
    })
  })

  it('全局 AGENTS.md + append 配置 → 全局在前、append 在后', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'EXTRA' },
      ...CAP_OFF,
    })
    const p = writeGlobalAgents('GLOBAL_RULES')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt: 'BASE' + globalSegment(p, 'GLOBAL_RULES') + '\n\nEXTRA',
    })
  })

  it('全局文件内容纯空白 → 不注入（返回 undefined）', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: '' },
      ...CAP_OFF,
    })
    writeGlobalAgents('   \n\t  ')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined()
  })

  it('AGENTS.md 是目录（非文件）→ 跳过该候选，不注入', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: '' },
      ...CAP_OFF,
    })
    // 同名目录：existsSync 为真但 isFile 为假 → 跳过。其余候选（AGENTS.MD）与本
    // 目录在大小写不敏感文件系统（macOS 默认）上冲突，无法共存，故断言跳过后不注入；
    // 「首候选不可用 → 落下一候选」的 fall-through 由扩展单测（内存 mock FS）覆盖。
    mkdirSync(join(agentsDir, 'AGENTS.md'))
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined()
  })

  it('AGENTS.MD（大写变体）被识别为全局指令文件', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: '' },
      ...CAP_OFF,
    })
    const p = writeGlobalAgents('UPPER_RULES', 'AGENTS.MD')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt: 'BASE' + globalSegment(p, 'UPPER_RULES'),
    })
  })

  it('--no-context-files 在 argv → 全局不注入，append 仍生效', async () => {
    const factory = await loadPlugin()
    writeGlobalAgents('GLOBAL_RULES')
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'EXTRA' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    process.argv.push('--no-context-files')
    try {
      expect(handler({ systemPrompt: 'BASE' })).toEqual({ systemPrompt: 'BASE\n\nEXTRA' })
    } finally {
      const idx = process.argv.lastIndexOf('--no-context-files')
      if (idx >= 0) process.argv.splice(idx, 1)
    }
  })

  // [review 修复 R4] pi CLI 的 -nc 是 --no-context-files 的等价短形式（cli/args.ts），
  // 检查须双形式命中——只匹配长形式时手动以 -nc 启动 pi 的用户绕过 opt-out。
  it('-nc 短形式在 argv → 全局同样不注入，append 仍生效', async () => {
    const factory = await loadPlugin()
    writeGlobalAgents('GLOBAL_RULES')
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'EXTRA' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    process.argv.push('-nc')
    try {
      expect(handler({ systemPrompt: 'BASE' })).toEqual({ systemPrompt: 'BASE\n\nEXTRA' })
    } finally {
      const idx = process.argv.lastIndexOf('-nc')
      if (idx >= 0) process.argv.splice(idx, 1)
    }
  })
})
});
});
