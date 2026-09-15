/**
 * Worker Thread 入口脚本
 *
 * 在独立 Worker Thread 中运行，负责：
 * 1. 动态 import 插件模块（load）
 * 2. 调用插件的 activate / deactivate 生命周期
 * 3. 通过 PluginRpcClient 转发插件 RPC 请求到主线程
 *
 * 通信协议：通过 parentPort 收发 HostToWorkerMessage / WorkerToHostMessage
 */

import { parentPort } from 'node:worker_threads'
import { Module } from 'node:module'
import { dirname as pathDirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  HostToWorkerMessage,
  PluginModule,
  PluginContext,
  Phase2AgentAPI,
  PluginStateStorage,
  Disposable,
  RpcRequest,
  ToolExecuteHandler,
} from './plugin-types.js'
import { PluginRpcErrorCodes } from './plugin-types.js'
import { PluginRpcClient } from './plugin-rpc-client.js'
import { createRequireInterceptor, createEnvProxy } from './plugin-sandbox.js'
import { errorWithCode } from '../../utils/errors.js'
import { createToolApi } from './tool-api.js'
import { createHookApi, executeHookRequest, disposePluginHooks } from './hook-api.js'
import { createSessionApi } from './api/session-api.js'
import { createConfigApi } from './api/config-api.js'
import { createSessionDataApi } from './api/session-data-api.js'
import { createUiApi } from './api/ui-api.js'
import { createAgentApi } from './api/agent-api.js'
import { createWorkspaceApi } from './api/workspace-api.js'
import { createStorageApi } from './api/storage-api.js'
import { createNotifyApi } from './api/notify-api.js'
import { createCommandsApi } from './api/commands-api.js'
import { createViewsApi } from './api/views-api.js'
import { freezeApiSurface } from './plugin-api-freeze.js'
import { toErrorMessage } from '../../utils/errors.js'

const rpcClient = new PluginRpcClient()
const loadedModules = new Map<string, PluginModule>()

/**
 * Worker 侧 RPC client（模块级单例）。
 *
 * 导出供子进程宿主（plugin-bootstrap-process.ts）attach process IPC——它在自己的
 * 模块作用域里无法触达本实例；同时供 e2e 测试 attach 内存端口。两个宿主共用同一
 * client（消息路由单一真相：handleMessage 的 rpc 分支收到的 response 也路由到这里）。
 */
export const workerRpcClient = rpcClient

/**
 * post 通道（模块级注入）：Worker 版默认 parentPort.postMessage，
 * 子进程版（plugin-bootstrap-process.ts）经 setPostMessage 注入 process.send。
 * handleMessage 只经 post() 发消息，与传输解耦——单一真相，零复制。
 */
let post: (msg: unknown) => void = (msg) => {
  parentPort?.postMessage(msg)
}

/** 注入 post 通道（子进程版 bootstrap 用；Worker 版无需调用，默认 parentPort） */
export function setPostMessage(fn: (msg: unknown) => void): void {
  post = fn
}


/** Worker 本地 tool handler 注册表 */
const toolHandlers = new Map<string, ToolExecuteHandler>()

/** 注册 tool handler（由 tool-api.ts 调用） */
export function registerToolHandler(toolKey: string, handler: ToolExecuteHandler): void {
  toolHandlers.set(toolKey, handler)
}

/** 注销 tool handler（由 tool-api.ts 调用） */
export function unregisterToolHandler(toolKey: string): void {
  toolHandlers.delete(toolKey)
}

/**
 * 清理指定插件的全部本地 tool handler（Fix-7，'deactivate' 消息分支消费）。
 *
 * toolKey 约定 `${pluginId}:${toolName}`（tool-api.ts），按前缀整组清除——与主线程
 * togglePlugin(false)/uninstallPlugin 清 toolRegistry 对偶：插件禁用后主线程不再路由
 * 该插件的 plugin.tool.execute，Worker 侧残留 handler 也一并摘除（禁用插件不可达）。
 */
export function disposePluginTools(pluginId: string): void {
  const prefix = `${pluginId}:`
  for (const toolKey of toolHandlers.keys()) {
    if (toolKey.startsWith(prefix)) {
      toolHandlers.delete(toolKey)
    }
  }
}

if (parentPort) {
  rpcClient.attach(parentPort)

  parentPort.on('message', (msg: HostToWorkerMessage) => {
    handleMessage(msg).catch((e: unknown) => {
      post({
        type: 'fatal_error',
        error: String(e),
        stack: e instanceof Error ? e.stack : undefined,
      })
    })
  })
}

export async function handleMessage(msg: HostToWorkerMessage): Promise<void> {
  switch (msg.type) {
    case 'load':
      return handleLoad(msg)
    case 'activate':
      return handleActivate(msg)
    case 'deactivate':
      return handleDeactivate(msg)
    case 'rpc':
      return handleRpcMessage(msg)
  }
}

async function handleLoad(msg: Extract<HostToWorkerMessage, { type: 'load' }>): Promise<void> {
  try {
    // sandbox 模式下初始化 require 拦截（S1-W3：msg.pluginPath 是入口文件路径，
    // CJS 拦截器的边界判定需要插件根目录——与 fork env 注入处（plugin-host-process）
    // 同款 dirname 修正，两处各自在「宿主传入点→边界判定消费点」的转换处完成）
    if (msg.trustLevel === 'sandbox') {
      initSandbox(pathDirname(msg.pluginPath))
    }

    const moduleUrl = pathToFileURL(msg.pluginPath).href
    const mod = (await import(moduleUrl)) as PluginModule
    loadedModules.set(msg.pluginId, mod)
    post({ type: 'loaded', pluginId: msg.pluginId })
  } catch (e: unknown) {
    post({ type: 'error', pluginId: msg.pluginId, error: String(e) })
  }
}

async function handleActivate(msg: Extract<HostToWorkerMessage, { type: 'activate' }>): Promise<void> {
  const mod = loadedModules.get(msg.pluginId)
  if (!mod) {
    post({ type: 'error', pluginId: msg.pluginId, error: 'Module not loaded' })
    return
  }
  try {
    const context = createPluginContext(msg.pluginId, msg.pluginDir)
    await mod.activate(context)
    post({ type: 'activated', pluginId: msg.pluginId })
  } catch (e: unknown) {
    post({ type: 'error', pluginId: msg.pluginId, error: String(e) })
  }
}

async function handleDeactivate(msg: Extract<HostToWorkerMessage, { type: 'deactivate' }>): Promise<void> {
  const mod = loadedModules.get(msg.pluginId)
  if (mod?.deactivate) {
    try {
      await mod.deactivate()
    } catch (e: unknown) {
      // deactivate 失败时发送 error 而非 deactivated
      post({ type: 'error', pluginId: msg.pluginId, error: String(e) })
      return
    }
  }
  // P-1：deactivate 成功后清理该插件全部本地 hook handler + 摘除执行器——
  // 与主线程 togglePlugin(false) 清 hookRegistry 对偶，禁用插件的 hook 不再执行
  disposePluginHooks(msg.pluginId)
  // Fix-7：对偶清理本地 tool handler——与主线程清 toolRegistry 对称，
  // 禁用插件的工具 handler 不残留（迟到的 tool.execute 落「handler not found」）
  disposePluginTools(msg.pluginId)
  post({ type: 'deactivated', pluginId: msg.pluginId })
}

function handleRpcMessage(msg: Extract<HostToWorkerMessage, { type: 'rpc' }>): void {
  if (msg.response) {
    rpcClient.handleResponse(msg.response)
  }
  if (msg.notification) {
    rpcClient.handleNotification(msg.notification)
    // D2-2 observe 快捷路径：主线程 observe 类 hook 经无 id 通知到达，直接执行
    // handler，fire-and-forget（不产生响应，零往返）。handler 抛错按「异常放行」
    // 语义记 Worker 侧日志丢弃。
    if (msg.notification.method === 'plugin.hooks.invoke') {
      executeHookRequest(msg.notification.params).catch((e: unknown) => {
        console.error('[plugin-bootstrap] hook notification handler error:', toErrorMessage(e))
      })
    }
  }
  if (msg.request) {
    // P-8：handleIncomingRequest 分支内已逐分支兜底，这里再挂一层 catch 防御
    // 未来新增分支遗漏导致的 unhandled rejection
    handleIncomingRequest(msg.request).catch((e: unknown) => {
      console.error('[plugin-bootstrap] incoming request failed:', toErrorMessage(e))
    })
  }
}

async function handleIncomingRequest(request: RpcRequest): Promise<void> {
  if (request.method === 'plugin.tool.execute') {
    const { pluginId, toolName, arguments: args, sessionId, toolCallId } = request.params as Record<string, unknown>
    const toolKey = `${pluginId}:${toolName}`
    const handler = toolHandlers.get(toolKey)
    if (!handler) {
      postRpcResponse(request.id, undefined, {
        code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
        message: `Tool handler not found: ${toolKey}`,
      })
      return
    }
    try {
      const result = await handler({
        arguments: args as Record<string, unknown>,
        sessionId: sessionId as string | undefined,
        toolCallId: toolCallId as string | undefined,
      })
      postRpcResponse(request.id, result, undefined)
    } catch (e: unknown) {
      const msg = toErrorMessage(e)
      postRpcResponse(request.id, undefined, {
        code: PluginRpcErrorCodes.INTERNAL_ERROR,
        message: `Tool execution error: ${msg}`,
      })
    }
  } else if (request.method === 'plugin.hooks.invoke') {
    // D2-1 request 直连：查 hook handler Map → 调 handler → 结果作为 RPC 响应原样回传。
    // handler 抛错 → 回 {proceed:true}（异常放行语义，与主线程超时/异常放行一致），
    // 错误记 Worker 侧日志；字段到 HookResult 的映射在主线程 HookPipeline（D2-3）。
    try {
      const result = await executeHookRequest(request.params)
      postRpcResponse(request.id, result, undefined)
    } catch (e: unknown) {
      console.error('[plugin-bootstrap] hook handler error:', toErrorMessage(e))
      postRpcResponse(request.id, { proceed: true }, undefined)
    }
  } else {
    postRpcResponse(request.id, undefined, {
      code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
      message: `Unknown method: ${request.method}`,
    })
  }
}

function postRpcResponse(
  id: number | string | null,
  result: unknown,
  error: { code: number; message: string } | undefined,
): void {
  if (id === null) return
  // JSON-RPC id: 项目内约定为 number，RpcResponse.id 类型为 number
  const numericId = typeof id === 'number' ? id : Number(id)
  if (error) {
    post({
      type: 'rpc',
      response: { jsonrpc: '2.0', id: numericId, error },
    })
  } else {
    post({
      type: 'rpc',
      response: { jsonrpc: '2.0', id: numericId, result },
    })
  }
}

function createPluginContext(pluginId: string, pluginDir: string): PluginContext {
  const subscriptions: Disposable[] = []
  const api = createAgentAPI(pluginId)
  return {
    pluginId,
    pluginPath: pluginDir,
    globalState: createStateStorageProxy(pluginId, 'global'),
    workspaceState: createStateStorageProxy(pluginId, 'workspace'),
    api,
    subscriptions,
  }
}

export function createAgentAPI(pluginId: string): Phase2AgentAPI {
  const api: Phase2AgentAPI = {
    storage: {
      global: createStorageApi(rpcClient, pluginId, 'global'),
      workspace: createStorageApi(rpcClient, pluginId, 'workspace'),
    },
    notify: createNotifyApi(rpcClient, pluginId),
    sessions: createSessionApi(rpcClient, pluginId),
    // S3-W2 events 显式降级：插件间事件总线从未实现（plugin.event.* 通知全仓无
    // 生产方），SDK 已从 @stable 移到 @experimental。调用即抛 NOT_IMPLEMENTED
    //（带 issue 指引）——显式失败优于静默失效（G4：SDK 允诺的能力全部真实可用或显式报错）。
    // 需要订阅 session 生命周期的插件请用 api.sessions.onDidCreateSession（已实现）。
    events: {
      on: (event: string, _handler: (data: unknown) => void): Disposable => {
        throw errorWithCode(
          `NOT_IMPLEMENTED: api.events.on('${event}') — plugin-to-plugin event bus is not implemented. ` +
          'This API is experimental (removed from the stable SDK surface). ' +
          'Use specific APIs (e.g. api.sessions.onDidCreateSession) instead. ' +
          'If you need the bus, open an issue at https://github.com/zhushanwen321/tai-ji/issues so a real consumer drives the design.',
          PluginRpcErrorCodes.METHOD_NOT_FOUND,
        )
      },
      emit: (event: string, _data: unknown): void => {
        throw errorWithCode(
          `NOT_IMPLEMENTED: api.events.emit('${event}', ...) — plugin-to-plugin event bus is not implemented. ` +
          'This API is experimental (removed from the stable SDK surface). ' +
          'Open an issue at https://github.com/zhushanwen321/tai-ji/issues if you need it.',
          PluginRpcErrorCodes.METHOD_NOT_FOUND,
        )
      },
    },
    tools: createToolApi(rpcClient, pluginId),
    hooks: createHookApi(rpcClient, pluginId),
    config: createConfigApi(rpcClient, pluginId),
    sessionData: createSessionDataApi(rpcClient, pluginId),
    ui: createUiApi(rpcClient, pluginId),
    agent: createAgentApi(rpcClient, pluginId),
    workspace: createWorkspaceApi(rpcClient, pluginId),
    // commands/views 两域（IF3）：handler 驻留 worker（commands），RPC 转发主线程（views）
    commands: createCommandsApi(rpcClient, pluginId),
    views: createViewsApi(rpcClient, pluginId),
  }
  return freezeApiSurface(api)
}

/**
 * 创建 PluginStateStorage 的 RPC proxy（PluginContext.globalState/workspaceState 用）。
 *
 * P6 后委托给 api/storage-api.ts 的 createStorageApi——storage proxy 实现单一真相源。
 * scope 仅可为 'global' | 'workspace'（调用方保证）。
 */
function createStateStorageProxy(
  pluginId: string,
  scope: 'global' | 'workspace',
): PluginStateStorage {
  return createStorageApi(rpcClient, pluginId, scope)
}

/**
 * 初始化 sandbox 环境：拦截 require 调用和替换 process.env。
 *
 * 在 sandbox 模式的 Worker/子进程中于 load 阶段调用（handleMessage load 分支），
 * 确保后续插件代码的 require 受到 BLOCKED_BUILTINS 和路径边界约束。
 * 导出供 plugin-bootstrap-process.ts 复用（子进程版与 Worker 版同一实现）。
 */
/**
 * Node 文档外 API 的局部类型补全：CJS resolver 钩子 `_resolveFilename`
 * （@types/node 未声明，自 Node 0.x 起稳定存在；原实现经 require('node:module')
 * 的 any 返回值隐式使用，此处显式声明收敛类型）。
 */
type ModuleWithResolveFilename = typeof Module & {
  _resolveFilename: (this: unknown, request: string, ...args: unknown[]) => string
}

export function initSandbox(pluginDir: string): void {
  const interceptor = createRequireInterceptor(pluginDir)

  // F1 配套：dev 模式（tsx）下本模块经 ESM 加载（fork 子进程无全局 require），
  // 改为顶层 `import { Module } from 'node:module'` 获取构造器——node:module 的
  // ESM 入口 re-export 同一 CJS 类对象，_resolveFilename monkey-patch 语义不变；
  // 生产 CJS bundle 中 esbuild 将该 import 编译为 require('node:module') 解构，等价。
  const ModuleApi = Module as ModuleWithResolveFilename
  const _originalResolveFilename = ModuleApi._resolveFilename
  // S-36（spec §5 待验证检查点）：CJS 混用路径的真实存在性未证实——sandbox 插件
  // 加载主通路走 ESM loader 边界，尚未观察到插件代码走 CJS require。保留拦截器但
  // 加一次性监控日志作观察信号：首次有 CJS require 经过本 patch（无论 interceptor
  // 放行还是拒绝）即输出，之后静默。观察期至 ~2026-11，无命中再删除拦截器（减法）。
  // fork 子进程的 console 输出经 stdio 管道进 runtime 日志，可见性足够。
  let interceptionLogged = false
  ModuleApi._resolveFilename = function (
    request: string,
    ...args: unknown[]
  ): string {
    const resolved = _originalResolveFilename.call(this, request, ...args) as string
    if (!interceptionLogged) {
      interceptionLogged = true
      console.log(
        `[plugin-sandbox] CJS require interception active for plugin dir: ${pluginDir} — spec gate S1-W3 usage monitor (observation window ends ~2026-11)`,
      )
    }
    interceptor(request, resolved)
    return resolved
  }

  // 替换 process.env 为空 Proxy
  process.env = createEnvProxy()

  // MF-2：封堵 process 上的父进程 DoS 向量。sandbox 仅 V8/模块级隔离，子进程仍可经全局
  // process 对象向宿主发信号（process.kill(process.ppid, 'SIGKILL') 即崩溃整个 runtime）。
  // CJS/ESM blocklist 只拦 require/import 通道，拦不住全局 process。sandbox 插件已被
  // BLOCKED_BUILTINS 禁用 child_process，无合法子进程需要管理，故封堵 process.kill 不影响
  // 合法用途。同时屏蔽 process.ppid（防止定位父进程 PID）。
  try {
    ;(process as { kill?: unknown }).kill = function sandboxBlockedKill() {
      throw errorWithCode('Sandbox: process.kill is blocked', 'PERMISSION_DENIED')
    }
  } catch (e: unknown) {
    // best-effort：process.kill 不可写时跳过（不影响其它 sandbox 防护）
    console.debug('[plugin-bootstrap] failed to override process.kill in sandbox:', e)
  }
  try {
    Object.defineProperty(process, 'ppid', {
      value: undefined,
      configurable: true,
      writable: true,
    })
  } catch (e: unknown) {
    // best-effort：ppid 不可重定义时跳过（process.kill 已封堵，ppid 泄露无法独立造成 DoS）
    console.debug('[plugin-bootstrap] failed to mask process.ppid in sandbox:', e)
  }
}
