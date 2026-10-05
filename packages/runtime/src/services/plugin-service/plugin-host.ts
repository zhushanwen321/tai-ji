/**
 * Worker Thread 池管理器
 *
 * 负责创建/复用 Worker、加载插件、崩溃恢复和资源监控。
 * trusted 插件共享 Worker（最多 10 个），sandbox 插件独占 Worker。
 */

import { Worker } from 'node:worker_threads'
import { resolve, dirname } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { WorkerHandle, RpcRequest, RpcResponse } from './plugin-types.js'
import { PluginRpcServer } from './plugin-rpc-server.js'
import { PluginHostProcess, type PluginPoolOptions } from './plugin-host-process.js'
// [crash-resilience §3.3 D6-⑤] plugin worker 崩溃取证：stderr 全量落盘 plugin-crash-*.log
// + 崩溃时刻 runtime 内存快照（A8「plugin-crash log 有 worker stderr」断言的落盘出口）。
// 采集器本体在 worker-stderr-collector.ts（独立模块可单测，本文件 max-lines 预算内）。
import { writePluginCrashLog, captureMemorySnapshot } from '../../infra/logger.js'
import { createWorkerStderrCollector } from './worker-stderr-collector.js'

/**
 * 解析 plugin-host.ts 所在目录（即 dist/runtime/）。
 *
 * - CJS bundle（tsup 产物）: __dirname 是 Node.js CJS 模块变量，指向 bundle 所在目录
 * - ESM 源码（开发/测试 tsx）: import.meta.url 推导
 * - 均不可用时抛出清晰错误
 *
 * 关键：CJS 中 __dirname 是模块作用域变量，不在 globalThis 上。
 * tsup 用 esbuild 编译，__dirname 引用会原样保留到 CJS 输出。
 */
function resolvePluginHostDir(): string {
  // CJS: __dirname 是 Node.js 注入的模块局部变量，指向当前文件所在目录
  // tsup/esbuild 不转换 typeof 检查，CJS 运行时 typeof __dirname === 'string'
  const cjsDir = typeof __dirname !== 'undefined' ? __dirname : undefined
  if (cjsDir && cjsDir !== '.') {
    return cjsDir
  }

  // ESM 源码路径（开发/测试直跑 tsx）
  // 注意：tsup CJS 输出中 import.meta 被替换为 var import_meta = {}
  // 所以 import.meta.url 在生产 bundle 中为 undefined，不会误入此分支
  // fileURLToPath 用顶层 import：node:url 是内置模块，tsup platform:'node' 自动 external 化；
  // CJS bundle 编译为 require('node:url')（运行时可用），但本分支在 CJS 中不执行（import.meta.url 为 undefined）
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    try {
      return dirname(fileURLToPath(import.meta.url))
    // eslint-disable-next-line taste/no-silent-catch -- ESM path detection: fallthrough to CJS path is expected
    } catch (e: unknown) {
      console.debug('[plugin-host] ESM path resolution failed:', e)
    }
  }

  throw new Error(
    '[plugin-host] Cannot resolve plugin host directory: ' +
    'both __dirname and import.meta.url are unavailable. ' +
    'Ensure this module runs in Node.js (CJS bundle or ESM).',
  )
}

/**
 * 解析并验证 plugin-bootstrap.js 的路径。
 *
 * @param filename - 要查找的文件名（默认 'plugin-bootstrap.js'）
 * @returns 验证通过的绝对路径
 * @throws 包含期望路径和目录实际文件列表的清晰错误
 *
 * 同时供 PluginHostProcess（fork 版）复用——bootstrap 文件与 host 同目录的约定两处一致。
 */
export function resolveAndValidateFile(filename: string): string {
  const hostDir = resolvePluginHostDir()
  const filePath = resolve(hostDir, filename)

  if (existsSync(filePath)) return filePath

  // 收集诊断信息
  const diagnostics: string[] = [
    `Expected: ${filePath}`,
    `hostDir: ${hostDir}`,
  ]

  // 列出 hostDir 中的 .js 文件（帮助发现 dirname 多走一级等问题）
  try {
    const files = readdirSync(hostDir)
      .filter(f => f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.mjs'))
    diagnostics.push(
      files.length > 0
        ? `Available in hostDir: ${files.join(', ')}`
        : `No JS files in hostDir`,
    )
  } catch {
    diagnostics.push(`hostDir does not exist or is not readable`)
  }

  // 检查上一级目录（dirname 多走一级的常见错误）
  const parentDir = dirname(hostDir)
  try {
    const parentFile = resolve(parentDir, filename)
    if (existsSync(parentFile)) {
      diagnostics.push(`HINT: Found at parent directory: ${parentFile} (dirname may have gone one level too deep)`,
      )
    }
    // eslint-disable-next-line taste/no-silent-catch -- diagnostic hint: failure to check parent dir must not block validation
  } catch (e: unknown) {
    console.debug('[plugin-host] parent dir check failed:', e)
  }

  throw new Error(
    `[plugin-host] Required file not found: ${filename}\n${diagnostics.join('\n')}`,
  )
}

const MAX_PLUGINS_PER_TRUSTED_WORKER = 10

/**
 * Host 侧收到 Worker/子进程 `{type:'rpc'}` 消息后的统一分发（单一真相，Fix-3）。
 *
 * Worker 发来的 RPC 消息可能有三种格式：
 * 1. `{ type: 'rpc', response: RpcResponse }` — 对 invoke 的响应（plugin-bootstrap postRpcResponse）
 * 2. `{ type: 'rpc', request: RpcRequest }` — Worker 主动发来的请求
 * 3. 扁平格式 `{ type: 'rpc', method, params, id }` — PluginRpcClient
 *
 * 消费方：PluginHost（Worker 版）、PluginHostProcess（fork 版）、e2e 测试 hostMessagePump
 * ——三处复用同一实现，主线程分发链变更时 e2e 即时覆盖。
 * 非 rpc 消息（fatal_error / activated / deactivated / error）由各宿主自行处理
 * （crash / reply 回调在两宿主指向不同实现）。
 */
export function dispatchHostRpcMessage(
  rpcServer: Pick<PluginRpcServer, 'handleResponse' | 'dispatch'>,
  workerId: string,
  msg: Record<string, unknown>,
): void {
  if (msg.response && typeof (msg.response as Record<string, unknown>).id !== 'undefined') {
    // 嵌套 response 格式: { type: 'rpc', response: RpcResponse }
    rpcServer.handleResponse(msg.response as unknown as RpcResponse)
  } else if (('result' in msg || 'error' in msg) && typeof msg.id === 'number') {
    // 扁平 response 格式: { type: 'rpc', id, result/error }
    rpcServer.handleResponse(msg as unknown as RpcResponse)
  } else if (msg.request && typeof (msg.request as Record<string, unknown>).method === 'string') {
    // Incoming RPC request from Worker
    void rpcServer.dispatch(workerId, msg.request as unknown as RpcRequest)
  } else if (typeof msg.method === 'string') {
    // Direct RpcRequest-style message
    void rpcServer.dispatch(workerId, msg as unknown as RpcRequest)
  }
}

type CrashCallback = (workerId: string, pluginIds: string[], error: string) => void
type ReplyCallback = (msg: unknown) => void

/**
 * 判断消息是否为可分发的对象（非 null / typeof object / 非数组）。
 * Worker 线程与 fork IPC 的序列化边界只应送出对象；收到 null、原始值或数组
 * 说明对端异常（bootstrap 早退、恶意/损坏消息），入口直接丢弃。
 * 两宿主共用（plugin-host-process.ts 经 import 消费，loadPlugin 的
 * onMessage 过滤同样依赖）。
 */
export function isRecordMessage(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null && !Array.isArray(msg)
}

/** 畸形消息日志的截断长度（字符）：超大字符串/数字不能整段进日志，防日志被单条消息放大 */
const MALFORMED_MSG_TRUNCATE_CHARS = 120

function describeMalformedMessage(msg: unknown): string {
  const text = typeof msg === 'string' ? msg : String(msg)
  const limit = MALFORMED_MSG_TRUNCATE_CHARS
  return text.length > limit ? `${text.slice(0, limit)}…(${text.length} chars)` : text
}

/**
 * 两宿主（Worker 线程版 / fork 子进程版）消息回调的统一安全分发外壳（D6 入口防御）：
 * - 非对象/null 消息落 warning 丢弃：`m.type` 对 null 抛 TypeError → uncaughtException
 *   → 进程退出，单条脏消息的代价被放大为整个 runtime 崩溃
 * - 回调体 try/catch：单条消息的处理异常记日志不冒泡（EventEmitter 回调抛错
 *   同样升级为 uncaughtException；index.ts 的进程级兜底是最后防线，宿主层先挡一道，
 *   避免「可丢弃的坏消息」触发整机 shutdown）
 * rpc 分支复用 dispatchHostRpcMessage（单一真相）；fatal_error / 生命周期回复
 * 经 handlers 注入（两宿主的 crash/reply 实现不同）。
 */
export function safeDispatchHostMessage(
  label: string,
  workerId: string,
  msg: unknown,
  handlers: {
    rpc: (m: Record<string, unknown>) => void
    crash: (error: string) => void
    reply: (m: Record<string, unknown>) => void
  },
): void {
  if (!isRecordMessage(msg)) {
    console.warn(`[${label}] discarding malformed message from ${workerId}: ${describeMalformedMessage(msg)}`)
    return
  }
  const m = msg
  try {
    if (m.type === 'rpc') {
      handlers.rpc(m)
    } else if (m.type === 'fatal_error') {
      handlers.crash(String(m.error ?? 'unknown'))
    } else if (m.type === 'activated' || m.type === 'deactivated' || m.type === 'error') {
      handlers.reply(m)
    }
  } catch (e: unknown) {
    // best-effort 降级（入口防御设计目标）：单条消息的处理异常记日志不冒泡——
    // EventEmitter 回调抛错会升级为 uncaughtException 触发整机 shutdown（见上方注释）
    console.error(`[${label}] error handling message from ${workerId} (type=${String(m.type)}):`, e)
  }
}

/**
 * PluginHost 的最小接口契约（P8 收口）。
 *
 * 此前该接口定义在 plugin-activator.ts（消费方），由本类（供应商）实现，构成
 * 「消费方拥有供应商契约」的坏味道 + 仅类型层的循环依赖。现收口到供应商本文件，
 * 由实现者拥有自己的契约。plugin-activator.ts 通过 re-export 以 `PluginHost` 之名
 * 继续对外暴露，保持所有现有导入（NON-BREAKING）。
 */
export interface PluginHostContract {
  /**
   * 为插件分配 Worker。
   * @param pluginPath 插件入口文件绝对路径（descriptor.pluginPath；sandbox 经此派生
   *   沙箱目录——PluginHostProcess 在 fork env 注入处 dirname(pluginPath)，见该处
   *   S1-W3 修正注释；trusted 走 Worker 线程，忽略此参数）
   */
  assignWorker(pluginId: string, trustLevel: 'trusted' | 'sandbox', pluginPath?: string): Promise<string>
  /** pluginId 显式传入：load 消息的 pluginId 是子进程/Worker loadedModules 分区键，
   *  activate 按真实 pluginId 查找——从 pluginPath 推导在入口文件语义下会失配。 */
  loadPlugin(workerId: string, pluginId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void>
  terminateWorker(workerId: string): Promise<void>
  getWorkerHandle(pluginId: string): { workerId: string; postMessage(message: unknown): void } | undefined
}

export class PluginHost implements PluginHostContract {
  private workers = new Map<string, WorkerHandle>()
  private workerInstances = new Map<string, Worker>()
  private rpcServer: PluginRpcServer
  private onCrash: CrashCallback | null = null
  private onReply: ReplyCallback | null = null
  private trustedCounter = 0

  /**
   * pluginId → workerId 反向索引（D2-5：getWorkerHandle O(1)，替代全 worker 线性扫）。
   * assign/terminate/crash/shutdown 同步维护；sandbox 插件不进此索引
   * （getWorkerHandle 未命中时转调子进程宿主）。
   */
  private pluginToWorker = new Map<string, string>()

  /** sandbox 插件子进程宿主（fork 版，惰性创建；无 sandbox 插件时不创建） */
  private processHost: PluginHostProcess | null = null
  private readonly processHostOptions?: PluginPoolOptions
  /** trusted Worker bootstrap mock 注入口（测试专用，由 PluginPoolOptions.workerBootstrapOverride 传入；详见该接口注释） */
  private readonly workerBootstrapOverride?: string


  /**
   * per-worker stderr 采集器（D6-⑤）：createWorker 以 `stderr: true` 把 worker stderr
   * 从「继承父进程」改为 pipe，数据在此累积（同时转发 process.stderr 保持既有可见性），
   * 崩溃时 handleWorkerCrash 落盘 plugin-crash-*.log。生命周期与 worker 一致：
   * crash（take 后删）/ cleanExit / terminateWorker / shutdown 四路清理，防泄漏。
   */
  private workerStderrCollectors = new Map<string, ReturnType<typeof createWorkerStderrCollector>>()

  constructor(rpcServer: PluginRpcServer, processHostOptions?: PluginPoolOptions) {
    this.rpcServer = rpcServer
    this.processHostOptions = processHostOptions
    this.workerBootstrapOverride = processHostOptions?.workerBootstrapOverride
  }

  /** 设置 crash callback（含 Worker 重建后的重新加载） */
  setCrashCallback(cb: CrashCallback): void {
    this.onCrash = cb
  }

  /** 设置 Worker 生命周期回复的回调（activated/deactivated/error） */
  setReplyCallback(cb: ReplyCallback): void {
    this.onReply = cb
  }

  /**
   * 惰性创建子进程宿主（sandbox 插件首次分配时）。
   * crash/reply 回调转发到 PluginHost 自己的回调；幂等守卫在 PluginHostProcess 内部。
   */
  private ensureProcessHost(): PluginHostProcess {
    if (this.processHost) return this.processHost
    const host = new PluginHostProcess(this.rpcServer, this.processHostOptions)
    host.setCrashCallback((processId, pluginIds, error) => {
      this.onCrash?.(processId, pluginIds, error)
    })
    host.setReplyCallback((msg) => {
      this.onReply?.(msg)
    })
    this.processHost = host
    return host
  }

  /**
   * 为插件分配 Worker。
   *
   * - sandbox: 每个插件独占一个子进程（pluginPath 派生沙箱目录注入 fork env，
   *   ESM loader 边界判定依赖；dirname 在 PluginHostProcess env 注入处统一修正）
   * - trusted: 查找有空位的 trusted Worker（≤10），没有则新建（pluginPath 忽略）
   */
  async assignWorker(pluginId: string, trustLevel: 'trusted' | 'sandbox', pluginPath?: string): Promise<string> {
    if (trustLevel === 'sandbox') {
      // sandbox 插件走子进程宿主（fork 隔离），不进 workers Map。
      // 进程复用由 PluginHostProcess.assignProcess 内部处理（sandbox 独占进程）。
      // pluginPath 透传子进程宿主（env 注入处 dirname 成沙箱目录）。
      return this.ensureProcessHost().assignProcess(pluginId, 'sandbox', pluginPath)
    }

    // trusted: 复用空闲 Worker
    for (const [, handle] of this.workers) {
      if (
        handle.trustLevel === 'trusted' &&
        handle.status === 'active' &&
        handle.pluginIds.length < MAX_PLUGINS_PER_TRUSTED_WORKER
      ) {
        // 对称去重（Worker 版）：重复 push 会让 pluginIds 随重复分配轮次累积
        //（crash 回调收到重复 id）
        if (!handle.pluginIds.includes(pluginId)) {
          handle.pluginIds.push(pluginId)
        }
        this.pluginToWorker.set(pluginId, handle.workerId)
        return handle.workerId
      }
    }

    this.trustedCounter++
    const workerId = `trusted-${this.trustedCounter}`
    return this.createWorker(workerId, 'trusted', pluginId).workerId
  }

  /**
   * 向指定 Worker 发送 load 指令，等待 loaded/error 响应。
   * pluginId 显式传入（loadedModules 分区键，见 PluginHostContract.loadPlugin 注释）。
   * loadPlugin 墙钟超时（loadTimeoutMs 10s + terminate 回收链）已随 ADR-0112 防御机制
   * 清查退役（C-proc-19 控制面单请求粒度条款一并收窄）——插件顶层死循环 = loaded/error
   * 永不到达 = 本 Promise 悬挂，处置归用户（插件管理界面停用/卸载）。
   */
  async loadPlugin(workerId: string, pluginId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void> {
    if (workerId.startsWith('sandbox-')) {
      await this.ensureProcessHost().loadPlugin(workerId, pluginId, pluginPath, trustLevel ?? 'sandbox')
      return
    }
    const worker = this.workerInstances.get(workerId)
    if (!worker) throw new Error(`Worker not found: ${workerId}`)

    return new Promise<void>((resolve, reject) => {
      const onMessage = (msg: unknown) => {
        // D6 入口防御 + loadPlugin 过滤：trusted Worker 多插件共享（≤10），同宿主并发
        // 加载 N 插件时 loaded/error 回复必须按 pluginId 归属——只匹配 m.type 会命中
        // 其他插件的回复（张冠李戴，plugin-bootstrap 回消息本就带 pluginId）。
        // 畸形消息（null/非对象）静默忽略不抛错（主回调统一 warn；旧实现取 m.type
        // 即 TypeError）。
        if (!isRecordMessage(msg)) return
        const m = msg
        if ((m.type === 'loaded' || m.type === 'error') && m.pluginId === pluginId) {
          worker.off('message', onMessage)
          if (m.type === 'loaded') resolve()
          else reject(new Error(String(m.error ?? 'load failed')))
        }
      }
      worker.on('message', onMessage)
      worker.postMessage({
        type: 'load',
        pluginId,
        pluginPath,
        trustLevel: trustLevel ?? this.inferTrustLevel(workerId),
      })
    })
  }

  async terminateWorker(workerId: string): Promise<void> {
    if (workerId.startsWith('sandbox-')) {
      await this.ensureProcessHost().terminateProcess(workerId)
      return
    }
    const worker = this.workerInstances.get(workerId)
    if (!worker) return

    const handle = this.workers.get(workerId)
    // 预期终止先置状态：运行中 Worker 被 terminate() 时 exit code=1，
    // 不标记会被 exit handler 误判为崩溃（对齐 plugin-host-process 的 terminated 范式）
    if (handle) handle.status = 'terminated'
    if (handle) this.removeIndexEntries(workerId, handle.pluginIds)

    this.rpcServer.unregisterWorker(workerId)
    await worker.terminate()
    this.workerInstances.delete(workerId)
    this.workers.delete(workerId)
    // D6-⑤：预期终止非崩溃，采集器随 worker 一起丢弃（防 Map 泄漏）
    this.workerStderrCollectors.delete(workerId)
  }

  /**
   * 满足 PluginHostContract 接口：按 pluginId 查找 Worker，返回带 postMessage 的句柄。
   * 反向索引 O(1) 命中（D2-5）；未命中转调子进程宿主（sandbox 插件）。
   */
  getWorkerHandle(pluginId: string): { workerId: string; postMessage(message: unknown): void } | undefined {
    const workerId = this.pluginToWorker.get(pluginId)
    if (workerId !== undefined) {
      const worker = this.workerInstances.get(workerId)
      return {
        workerId,
        postMessage: (message: unknown) => worker?.postMessage(message),
      }
    }
    // sandbox 插件：转调子进程宿主（字段映射 processId → workerId，activator 消费 handle.workerId）
    const processHandle = this.processHost?.getProcessHandle(pluginId)
    if (processHandle) {
      return {
        workerId: processHandle.processId,
        postMessage: processHandle.postMessage,
      }
    }
    return undefined
  }

  /** 反向索引删除（带归属守卫：只删当前映射仍指向 workerId 的条目，防误删重建后的新映射） */
  private removeIndexEntries(workerId: string, pluginIds: string[]): void {
    for (const pid of pluginIds) {
      if (this.pluginToWorker.get(pid) === workerId) {
        this.pluginToWorker.delete(pid)
      }
    }
  }

  /** 按 workerId 查找 WorkerHandle（内部和测试用） */
  getWorkerHandleById(workerId: string): WorkerHandle | undefined {
    return this.workers.get(workerId)
  }

  getAllWorkers(): WorkerHandle[] {
    return [...this.workers.values()]
  }

  getWorkerInstance(workerId: string): Worker | undefined {
    return this.workerInstances.get(workerId)
  }

  async shutdown(): Promise<void> {
    // 子进程宿主先关（内部也 dispose rpcServer——dispose 幂等，重复调用无害）
    await this.processHost?.shutdown()
    // 同 terminateWorker：先统一置 terminated，terminate() 触发的 exit code=1 不误判崩溃
    for (const handle of this.workers.values()) handle.status = 'terminated'
    await Promise.allSettled(
      [...this.workerInstances.values()].map(w => w.terminate()),
    )
    this.workerInstances.clear()
    this.workers.clear()
    this.pluginToWorker.clear()
    // D6-⑤：关停非崩溃，全部 stderr 采集器一并丢弃（防 Map 泄漏）
    this.workerStderrCollectors.clear()
    this.rpcServer.dispose()
  }

  // ── Private ──────────────────────────────────────────────────────

  /** 从 workerId 推断 trustLevel（用于 loadPlugin 未显式指定时） */
  private inferTrustLevel(workerId: string): 'trusted' | 'sandbox' {
    const handle = this.workers.get(workerId)
    return handle?.trustLevel ?? 'sandbox'
  }

  private createWorker(
    workerId: string,
    trustLevel: 'trusted' | 'sandbox',
    pluginId: string,
  ): WorkerHandle {
    // 注意：本函数仅 trusted 路径调用（assignWorker 的 sandbox 分支已转调子进程宿主），
    // trustLevel 参数保留用于 handle 记录；sandbox 不会经过 new Worker。
    // plugin-bootstrap.js 与本文件（plugin-host）同目录
    // resolveAndValidateFile 在文件不存在时抛出含诊断信息的错误
    // 生产环境（CJS bundle）用 .cjs，开发/测试（JS 源码直跑）用 .js，
    // 测试场景经 workerBootstrapOverride 注入 mock（短路下方 resolve 链，不再写 src 目录）
    let bootstrapPath: string
    if (this.workerBootstrapOverride) {
      // 测试注入：短路 resolve 链，直接加载 mock（生产不传，走下方 .cjs → .js → .ts 链）
      bootstrapPath = this.workerBootstrapOverride
    } else {
      // 生产路径：.cjs（tsup bundle）命中首步；.js/.ts 为兜底——
      // .js 历史由测试 IO 写入（已移除），.ts Node Worker 无法直接加载，两者保留作兜底
      try {
        bootstrapPath = resolveAndValidateFile('plugin-bootstrap.cjs')
      } catch {
        try {
          bootstrapPath = resolveAndValidateFile('plugin-bootstrap.js')
        } catch {
          bootstrapPath = resolveAndValidateFile('plugin-bootstrap.ts')
        }
      }
    }

    let worker: Worker
    try {
      // D6-⑤：stderr: true 改 pipe（默认继承拿不到流引用），「trusted-1 exited with code 1」
      // 场景的崩溃打印从此可落盘；stdout 保持继承（行为面最小化）。
      worker = new Worker(bootstrapPath, {
        name: workerId,
        stderr: true,
      })
    } catch (err: unknown) {
      // 区分路径错误 vs Worker 创建错误
      if (err instanceof Error && err.message.startsWith('[plugin-host] Required file not found')) {
        throw err // 路径验证错误，已包含完整诊断信息
      }
      console.error(`[plugin-host] failed to create worker ${workerId}:`, err)
      throw err
    }

    const handle: WorkerHandle = {
      workerId,
      threadId: worker.threadId,
      trustLevel,
      pluginIds: [pluginId],
      status: 'active',
      lastActiveAt: Date.now(),
      memoryUsage: undefined,
    }

    this.workers.set(workerId, handle)
    this.workerInstances.set(workerId, worker)
    this.pluginToWorker.set(pluginId, workerId)
    // D1 通道身份：trusted Worker 多插件共享（≤10），无唯一归属 → worker 级身份
    // （鉴权按 trusted 放行，dispatch 不覆写 params.pluginId——trusted 插件间互不
    // 设防是设计语义，见 spec D1 信任模型澄清）。本函数仅 trusted 路径调用；
    // 若未来出现 sandbox Worker（当前不存在此路径），无 pluginId 的 sandbox 身份
    // 在 check() 走 fail-closed 拒绝，安全方向正确。
    this.rpcServer.registerWorker(workerId, worker, { trustLevel })

    worker.on('message', (msg: unknown) => {
      // D6 入口防御：safe-dispatch（非对象/null 落 warning 丢弃 + 回调体 try/catch）
      safeDispatchHostMessage('plugin-host', workerId, msg, {
        rpc: (m) => {
          // 三种 RPC 消息格式的统一分发（Fix-3：与 plugin-host-process / e2e 共享单一真相）
          dispatchHostRpcMessage(this.rpcServer, workerId, m)
        },
        crash: (error) => this.handleWorkerCrash(workerId, error),
        reply: (m) => {
          // 生命周期回复：转发给 Activator
          this.onReply?.(m)
          if (m.type === 'error') {
            console.error(`[plugin-host] plugin error: ${m.pluginId}: ${m.error}`)
          }
        },
      })
    })

    worker.on('error', (err: Error) => {
      console.error(`[plugin-host] worker ${workerId} error:`, err.message)
      this.handleWorkerCrash(workerId, err.message)
    })

    // D6-⑤：stderr pipe 消费——采集进崩溃取证缓冲 + 转发 process.stderr 保持既有可见性
    // （pipe 前输出直达 runtime fd 2，不转发 = 行为回归）；worker 无 pid，此流是崩溃现场唯一来源。
    const collector = createWorkerStderrCollector()
    this.workerStderrCollectors.set(workerId, collector)
    worker.stderr?.on('data', (chunk: Buffer) => {
      collector.feed(chunk)
      try {
        process.stderr.write(chunk)
      } catch (e) {
        // EPIPE 极端路径：转发失败不连坐采集与主链路（取证面 best-effort），debug 留痕
        console.debug('[plugin-host] worker stderr forward failed:', e)
      }
    })

    worker.on('exit', (code: number) => {
      if (code !== 0) {
        console.error(`[plugin-host] worker ${workerId} exited with code ${code}`)
        this.handleWorkerCrash(workerId, `Worker exited with code ${code}`)
        return
      }
      // D6/W4：exit code 0 是「正常退出」不是崩溃——不触发 crash 回调，但 handle、
      // 反向索引与 rpcServer 注册必须清理：残留 handle 会让
      // assignWorker 把新插件分配到已死 Worker（postMessage 落空），反向索引指向死线程。
      this.handleWorkerCleanExit(workerId)
    })

    return handle
  }

  /**
   * exit code 0 的 Worker 清理（D6/W4）：正常退出与崩溃分流——不报 crash。
   * 幂等守卫与 crash 路径同款（crashed/terminated 已处理过则跳过；terminateWorker /
   * shutdown 的 pre-mark 路径自带清理，不会重复到达这里）。
   */
  private handleWorkerCleanExit(workerId: string): void {
    const handle = this.workers.get(workerId)
    if (!handle || handle.status === 'crashed' || handle.status === 'terminated') return
    handle.status = 'terminated'
    const pluginIds = [...handle.pluginIds]
    this.rpcServer.unregisterWorker(workerId)
    this.removeIndexEntries(workerId, pluginIds)
    this.workerInstances.delete(workerId)
    this.workers.delete(workerId)
    // D6-⑤：正常退出非崩溃，stderr 采集器一并清理（collector 生命周期收敛在
    // crash/cleanExit/terminateWorker/shutdown 四路，全 worker 生命周期无泄漏窗口）
    this.workerStderrCollectors.delete(workerId)
    console.log(`[plugin-host] worker ${workerId} exited cleanly (code 0); handle cleaned up`)
  }

  private handleWorkerCrash(workerId: string, error: string): void {
    const handle = this.workers.get(workerId)
    if (!handle || handle.status === 'crashed' || handle.status === 'terminated') return

    handle.status = 'crashed'
    const pluginIds = [...handle.pluginIds]
    const trustLevel = handle.trustLevel

    // D6-⑤：崩溃 stderr 全量落盘 plugin-crash-*.log（形态对齐 pi-crash：首行摘要 +
    // truncated 标注 + [runtime-context] 头块 + stderr 原文）。三入口（error 事件 /
    // fatal_error 消息 / exit code≠0）都汇聚到本函数，幂等守卫（上方 status 检查）保证
    // 单次崩溃只写一份。时序注记：terminate→exit 间的残余 stderr 不进本份 log（collector
    // 已 take，仍转发 process.stderr），取证主体是崩溃前打印，该窗口丢失可接受。best-effort。
    try {
      const snapshot = this.workerStderrCollectors.get(workerId)?.take() ?? { text: '', truncated: false }
      this.workerStderrCollectors.delete(workerId)
      writePluginCrashLog(workerId, [
        `plugin worker crashed: ${error}`,
        `at ${new Date().toISOString()}`,
        snapshot.truncated ? '(stderr truncated: earliest lines dropped, worker crash buffer exceeded 1MB)' : '',
        '[runtime-context] ' + JSON.stringify({ workerId, threadId: handle.threadId, pluginIds, trustLevel, memory: captureMemorySnapshot() }),
        '',
        snapshot.text,
      ].filter(Boolean).join('\n'))
    } catch (e) {
      // 观测增强不得影响 crash 处置主流程（onCrash 通知链），console.error
      // 经 logger patch tee 进 runtime 主日志
      console.error(`[plugin-host] write plugin crash log failed for ${workerId}:`, e)
    }

    // 崩溃线程兜底终止（D6/W4 对称化）：fatal_error 消息路径线程发完消息仍存活
    //（对齐 plugin-host-process 的 kill 兜底），不 terminate = 线程泄漏。terminate 触发
    // 的 exit(code=1) 被 status='crashed' 幂等守卫拦截，不会二次进入本函数。
    const worker = this.workerInstances.get(workerId)
    if (worker) {
      void worker.terminate().catch((e: unknown) => {
        console.debug(`[plugin-host] terminate crashed worker ${workerId} failed:`, e)
      })
    }
    this.rpcServer.unregisterWorker(workerId)
    this.removeIndexEntries(workerId, pluginIds)

    if (trustLevel === 'trusted') {
      // ADR-0112：原「冷却后自动 rebuild + crash 计数上限/衰减」编排已退役——崩溃经
      // onCrash 显式上报（PluginService 置 CRASHED 态，前端可见），恢复决策归用户
      // （管理界面重新启用）。
      this.workerInstances.delete(workerId)
      this.workers.delete(workerId)
    }

    this.onCrash?.(workerId, pluginIds, error)
  }
}
