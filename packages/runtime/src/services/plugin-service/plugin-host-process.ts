/**
 * 子进程池管理器（fork 版，PluginHostProcess）
 *
 * 负责创建/复用子进程（child_process.fork）、加载插件、崩溃检测与清理。
 * 与 PluginHost（Worker 版）职责同构，接口对齐 PluginHostContract（wiring 层无痛切换）：
 * - sandbox 插件独占子进程；trusted 插件共享（≤10 插件/进程）
 * - IPC 走 fork 默认 channel（child.send/process.on('message')），经 WorkerPort 适配
 *   （{ postMessage: child.send }）注册进 PluginRpcServer——HostToWorkerMessage 消息族零改动复用
 * - 崩溃检测：exit（非 0）/ error / fatal_error 消息 → crash 回调（status 幂等守卫）；
 *   exit(0) → clean exit 清理不报 crash（L-5，对齐 Worker 版 handleWorkerCleanExit）；
 *   disconnect → grace 延迟分流（exit 事件权威裁决，仅存活进程断开才报 crash）
 *
 * 打包约束（AGENTS.md #12）：
 * - fork 必须用 process.execPath + env ELECTRON_RUN_AS_NODE='1'（打包后无独立 node）
 * - bootstrap 路径经 resolveAndValidateFile 验证（与 plugin-bootstrap.cjs 同目录约定）
 */

import { fork, type ChildProcess, type Serializable } from 'node:child_process'
import { dirname as pathDirname } from 'node:path'
import type { CrashJournalEvent } from '@xyz-agent/shared'
import { buildOutboundChildEnv } from '../../infra/spawn-env.js'
import { getCrashJournal } from '../../infra/crash-journal.js'
import type { ProcessHandle } from './plugin-types.js'
import { PluginRpcServer, type RpcIdentity } from './plugin-rpc-server.js'
import { resolveAndValidateFile, dispatchHostRpcMessage, safeDispatchHostMessage, isRecordMessage } from './plugin-host.js'

/**
 * plugin-worker crash 台账行使用 schema 登记的扩展字段 processId/pid/signal/pluginIds
 * （偏差 #32③：扩展字段登记 SSOT = shared crash-journal-schema.ts CrashJournalEvent，
 * 本地不再重复声明；crash-forensics §3.3 D1 plugin-worker crash 行：fork 宿主崩溃身份
 * 与致死信号）。writer 以 spread 序列化原样落盘 JSONL；exitCode 走 schema 既有字段。
 */

const MAX_PLUGINS_PER_TRUSTED_PROCESS = 10
const LOAD_PLUGIN_TIMEOUT_MS = 10_000
/** shutdown 等待子进程退出的上限（超过则 SIGKILL） */
const SHUTDOWN_KILL_TIMEOUT_MS = 2000
/**
 * disconnect 后等待 exit 事件的兜底窗口（L-5）。
 * 实测探针：子进程退出时父进程事件序为 disconnect → exit，且 exit 事件晚于
 * disconnect 约一个事件循环圈（SIGCHLD 传播 ms 级）——窗口取 25 倍余量，既让
 * 伴随进程退出的 disconnect 稳稳等到 exit 权威分流，又不让真异常（存活进程断开
 * IPC）的 crash 上报推迟过久。
 */
const DISCONNECT_GRACE_MS = 250

type CrashCallback = (processId: string, pluginIds: string[], error: string) => void
type ReplyCallback = (msg: unknown) => void

/**
 * 构建插件宿主 fork 子进程 env（唯一组装点，导出供单测直验）。
 *
 * D6（docs/architecture/env-propagation-boundary.md §5-U4）：{...process.env} 全量拷贝拓扑
 * 不动（trusted/sandbox 插件兼容性属有意设计）——pass-all 前缀 '' 承载拷贝语义
 * （构建器步骤 1 对任意 key 放行，副本操作绝不 mutate 父对象，R1），仅在输出上叠加
 * 出站 deny 两键剔除（构建器末步兜底）+ 既有 ELECTRON_RUN_AS_NODE=1 注入。
 */
export function buildPluginHostChildEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildOutboundChildEnv({
    parentEnv,
    prefixes: [''],
    extras: {
      // 打包约束（AGENTS.md #12）：必须 process.execPath + ELECTRON_RUN_AS_NODE=1
      // （打包后无独立 node；node 环境该 env 无害被忽略）
      ELECTRON_RUN_AS_NODE: '1',
    },
  })
}

/**
 * PluginHostProcess 的最小接口契约（对齐 PluginHostContract，wiring 层无痛接入）。
 * 由本文件拥有契约，plugin-lifecycle/plugin-service 通过 re-export 消费。
 */
export interface PluginHostProcessContract {
  /**
   * 为插件分配子进程。
   * @param pluginPath 插件入口文件绝对路径（descriptor.pluginPath，`<dir>/index.js` 形态；
   *   sandbox 经此派生沙箱目录——本宿主在 fork env 注入处 dirname(pluginPath) 一次
   *   （S1-W3 修正落点，spec §3.3 D2-①：此前原样注入文件路径，ESM loader 的
   *   `startsWith(sandboxDir + sep)` 恒 false，边界检查 0% 命中）；
   *   ESM loader 的 initialize() 在进程启动时读该 env，缺失 fail-closed throw，
   *   故 sandbox 进程必须在 fork 前拿到 pluginPath——loadPlugin 时机太晚）。
   */
  assignProcess(pluginId: string, trustLevel: 'trusted' | 'sandbox', pluginPath?: string): Promise<string>
  loadPlugin(processId: string, pluginId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void>
  terminateProcess(processId: string): Promise<void>
  getProcessHandle(pluginId: string): { processId: string; postMessage(message: unknown): void } | undefined
}

/**
 * PluginHost / PluginHostProcess 共享的构造选项（插件池统一配置）。
 *
 * 此接口同时被两个宿主消费：
 *   - PluginHost（Worker 线程版）读 workerBootstrapOverride（trusted Worker bootstrap 注入口）
 *   - PluginHostProcess（fork 子进程版）读 bootstrapPathOverride（fork 子进程 bootstrap 注入口）
 * 两者互不影响。production 构造任一宿主时不传任何 override，各自走 resolveAndValidateFile（.cjs → .js → .ts）链。
 */
export interface PluginPoolOptions {
  /** 测试注入：fork 子进程 bootstrap 目标文件绝对路径（默认走 resolveAndValidateFile 链）。由 PluginHostProcess 消费 */
  bootstrapPathOverride?: string
  /**
   * 测试注入：trusted Worker 线程 bootstrap 的 mock 注入口，与 bootstrapPathOverride（fork 子进程 mock
   * 注入）对偶；由 PluginHost 消费。生产不传——createWorker 走原 resolveAndValidateFile
   * （'.cjs' → '.js' → '.ts'）链：生产 .cjs bundle 命中首步，测试环境（无 bundle）fallback 至 .ts
   * 但 Node Worker 不能加载 .ts，故测试场景 trusted 必须传 override 短路 resolve 链加载 mock。
   */
  workerBootstrapOverride?: string
  /** fork execArgv（ESM loader 经 --import 注入点；默认空，不继承父进程 flags） */
  execArgv?: string[]
  /** loadPlugin 超时（测试注入短超时用；默认 10s） */
  loadTimeoutMs?: number
}

export class PluginHostProcess implements PluginHostProcessContract {
  private processes = new Map<string, ProcessHandle>()
  private processInstances = new Map<string, ChildProcess>()
  private rpcServer: PluginRpcServer
  private onCrash: CrashCallback | null = null
  private onReply: ReplyCallback | null = null
  private trustedCounter = 0
  private readonly bootstrapPathOverride?: string
  private readonly execArgv: string[]
  private readonly loadTimeoutMs: number

  /** pluginId → processId 反向索引（D2-5：getProcessHandle O(1)，替代全进程线性扫） */
  private pluginToProcess = new Map<string, string>()

  constructor(rpcServer: PluginRpcServer, options?: PluginPoolOptions) {
    this.rpcServer = rpcServer
    this.bootstrapPathOverride = options?.bootstrapPathOverride
    this.execArgv = options?.execArgv ?? []
    this.loadTimeoutMs = options?.loadTimeoutMs ?? LOAD_PLUGIN_TIMEOUT_MS
  }

  /** 设置 crash callback（子进程崩溃时触发，含 pluginIds） */
  setCrashCallback(cb: CrashCallback): void {
    this.onCrash = cb
  }

  /** 设置生命周期回复的回调（activated/deactivated/error） */
  setReplyCallback(cb: ReplyCallback): void {
    this.onReply = cb
  }

  /**
   * 为插件分配子进程。
   *
   * - sandbox: 每个插件独占一个子进程（pluginPath 派生的沙箱目录注入 fork env
   *   XYZ_PLUGIN_SANDBOX_DIR，供 ESM loader initialize() 在进程启动时读取——
   *   晚于 fork 的 loadPlugin 时机无法注入）
   * - trusted: 查找有空位的 trusted 子进程（≤10），没有则新建
   */
  async assignProcess(pluginId: string, trustLevel: 'trusted' | 'sandbox', pluginPath?: string): Promise<string> {
    if (trustLevel === 'sandbox') {
      const processId = `sandbox-${pluginId}`
      const existing = this.processes.get(processId)
      if (existing && existing.status === 'active') {
        // M6a-06：复用分支去重——deactivate 不 terminate 进程，每次重激活都会命中
        // 此分支，重复 push 会让 pluginIds 随激活次数累积（崩溃回调收到重复 id）
        if (!existing.pluginIds.includes(pluginId)) {
          existing.pluginIds.push(pluginId)
        }
        this.pluginToProcess.set(pluginId, processId)
        return processId
      }
      return this.createProcess(processId, 'sandbox', pluginId, pluginPath).processId
    }

    // trusted: 复用空闲子进程
    for (const [, handle] of this.processes) {
      if (
        handle.trustLevel === 'trusted' &&
        handle.status === 'active' &&
        handle.pluginIds.length < MAX_PLUGINS_PER_TRUSTED_PROCESS
      ) {
        handle.pluginIds.push(pluginId)
        this.pluginToProcess.set(pluginId, handle.processId)
        return handle.processId
      }
    }

    this.trustedCounter++
    const processId = `trusted-${this.trustedCounter}`
    return this.createProcess(processId, 'trusted', pluginId).processId
  }

  /**
   * 向指定子进程发送 load 指令，等待 loaded/error 响应。
   *
   * pluginId 必须显式传入（F1 修复链路）：load 消息的 pluginId 是子进程
   * loadedModules 的分区键，activate 消息按真实 pluginId 查找。旧实现从
   * pluginPath 末段推导（目录时代假设），pluginPath 改为入口文件后 pop 出
   * 'index.js' 之类文件名 → loadedModules 键失配 → activate 报 Module not loaded。
   * 超时（loadTimeoutMs）后 reject 并清理该子进程（E2：宿主清理）。
   */
  async loadPlugin(processId: string, pluginId: string, pluginPath: string, trustLevel?: 'trusted' | 'sandbox'): Promise<void> {
    const child = this.processInstances.get(processId)
    if (!child) throw new Error(`Process not found: ${processId}`)

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`loadPlugin timeout for process ${processId}`))
        // E2: 超时后宿主清理该子进程（kill + unregister）
        this.terminateProcess(processId).catch((e: unknown) => {
          console.debug(`[plugin-host-process] cleanup after load timeout failed for ${processId}:`, e)
        })
      }, this.loadTimeoutMs)

      const onMessage = (msg: unknown) => {
        // D6 入口防御 + loadPlugin 过滤：trusted 子进程多插件共享（≤10），loaded/error
        // 回复必须按 pluginId 归属——只匹配 m.type 会命中并发加载的其他插件的回复
        //（张冠李戴；bootstrap 回消息本就带 pluginId）。畸形消息（null/非对象）静默
        // 忽略不抛错（主回调统一 warn；旧实现取 m.type 即 TypeError）。
        if (!isRecordMessage(msg)) return
        const m = msg
        if ((m.type === 'loaded' || m.type === 'error') && m.pluginId === pluginId) {
          clearTimeout(timeout)
          child.off('message', onMessage)
          if (m.type === 'loaded') resolve()
          else reject(new Error(String(m.error ?? 'load failed')))
        }
      }
      child.on('message', onMessage)
      child.send({
        type: 'load',
        pluginId,
        pluginPath,
        trustLevel: trustLevel ?? this.inferTrustLevel(processId),
      })
    })
  }

  /**
   * 终止子进程并清理注册。
   * 先置 status='terminated' 再 graceful kill（SIGTERM→SHUTDOWN_KILL_TIMEOUT_MS→SIGKILL），
   * 与 shutdown() 升级链对称——避免恶意/卡死子进程抵抗 SIGTERM 导致 orphan 泄漏
   *（MF-3：hot-reload/deactivate 路径的旧版子进程残留）。kill 后 exit/disconnect 事件
   * 到达时被幂等守卫拦截，不会误触发 crash 回调（R3）。
   */
  async terminateProcess(processId: string): Promise<void> {
    const child = this.processInstances.get(processId)
    if (!child) return

    const handle = this.processes.get(processId)
    if (handle) {
      handle.status = 'terminated'
      this.removeIndexEntries(processId, handle.pluginIds)
    }

    this.rpcServer.unregisterWorker(processId)
    this.processInstances.delete(processId)
    this.processes.delete(processId)

    await this.killChildGracefully(child)
  }

  /**
   * 满足 PluginHostProcessContract：按 pluginId 查找子进程，返回带 postMessage 的句柄。
   * 反向索引 O(1) 命中（D2-5），索引与 processes Map 同步维护。
   */
  getProcessHandle(pluginId: string): { processId: string; postMessage(message: unknown): void } | undefined {
    const processId = this.pluginToProcess.get(pluginId)
    if (processId === undefined) return undefined
    const child = this.processInstances.get(processId)
    return {
      processId,
      postMessage: (message: unknown) => {
        try {
          child?.send(message as Serializable)
        } catch (e: unknown) {
          // IPC channel 已关闭（子进程崩溃/terminated 后的 in-flight 消息）不抛
          console.debug(`[plugin-host-process] send failed for ${processId}:`, e)
        }
      },
    }
  }

  /** 反向索引删除（带归属守卫：只删当前映射仍指向 processId 的条目，防误删重建后的新映射） */
  private removeIndexEntries(processId: string, pluginIds: string[]): void {
    for (const pid of pluginIds) {
      if (this.pluginToProcess.get(pid) === processId) {
        this.pluginToProcess.delete(pid)
      }
    }
  }

  /** 按 processId 查找 ProcessHandle（内部和测试用） */
  getProcessHandleById(processId: string): ProcessHandle | undefined {
    return this.processes.get(processId)
  }

  getAllProcesses(): ProcessHandle[] {
    return [...this.processes.values()]
  }

  /** 关闭所有子进程并释放 rpcServer */
  async shutdown(): Promise<void> {
    // 对齐 terminateProcess 的 pre-mark（与 Worker 版 plugin-host.shutdown 同款）：
    // SIGTERM kill 触发的 exit(code=null)/disconnect 先到时，status='terminated'
    // 幂等守卫拦截，不把正常关停误报为崩溃
    for (const handle of this.processes.values()) handle.status = 'terminated'
    const children = [...this.processInstances.values()]
    await Promise.allSettled(
      children.map((child) => this.killChildGracefully(child)),
    )
    this.processInstances.clear()
    this.processes.clear()
    this.pluginToProcess.clear()
    this.rpcServer.dispose()
  }

  /**
   * 优雅终止子进程：SIGTERM → 等待 exit（最多 SHUTDOWN_KILL_TIMEOUT_MS）→ SIGKILL 兜底。
   *
   * terminateProcess 与 shutdown 共用此升级链（MF-3：消除不对称，防 SIGTERM 抵抗导致 orphan）。
   * timer.unref() 避免兜底定时器阻塞 runtime 退出。
   */
  private killChildGracefully(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch (e: unknown) {
          // best-effort：进程可能刚退出，kill 抛错不阻塞清理
          console.debug(`[plugin-host-process] SIGKILL escalation failed:`, e)
        }
        resolve()
      }, SHUTDOWN_KILL_TIMEOUT_MS)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.kill()
      } catch (e: unknown) {
        // best-effort：进程可能已退出，kill 抛错不阻塞清理
        console.debug(`[plugin-host-process] kill failed:`, e)
      }
    })
  }

  // ── Private ──────────────────────────────────────────────────────

  /** 从 processId 推断 trustLevel（用于 loadPlugin 未显式指定时） */
  private inferTrustLevel(processId: string): 'trusted' | 'sandbox' {
    const handle = this.processes.get(processId)
    return handle?.trustLevel ?? 'sandbox'
  }

  private createProcess(
    processId: string,
    trustLevel: 'trusted' | 'sandbox',
    pluginId: string,
    pluginPath?: string,
  ): ProcessHandle {
    // M6a-03：覆盖同 processId 前先清理残留句柄（崩溃→重建竞态防护）。
    // 崩溃（handleProcessCrash 不 kill 不删 map）后重激活走 createProcess 直接 set 覆盖，
    // 旧 child 的 exit/disconnect/error/message 监听全部残留——旧 child 晚到的 exit（code≠0）
    // 会命中新 handle，健康进程被误标 crashed + RPC 反注册。此处 kill 旧 child + off 全部
    // 监听 + 删 map + 反注册，使旧进程的任何晚到事件都无法再触碰新 handle。
    const staleChild = this.processInstances.get(processId)
    if (staleChild) {
      const staleHandle = this.processes.get(processId)
      if (staleHandle) this.removeIndexEntries(processId, staleHandle.pluginIds)
      this.processInstances.delete(processId)
      this.processes.delete(processId)
      staleChild.removeAllListeners()
      try {
        staleChild.kill()
      } catch (e: unknown) {
        // kill 失败（进程已死/权限）不阻塞重建
        console.debug(`[plugin-host-process] kill stale child failed for ${processId}:`, e)
      }
      // rpcServer 反注册旧 worker（下方 createProcess 会重新注册新 worker）
      this.rpcServer.unregisterWorker(processId)
    }

    // bootstrap 路径：测试 override 优先；生产走 resolveAndValidateFile 链
    // （plugin-bootstrap-process.cjs → .js → .ts，与 plugin-host 的 .cjs/.js/.ts 同约定）
    let bootstrapPath: string
    if (this.bootstrapPathOverride) {
      bootstrapPath = this.bootstrapPathOverride
    } else {
      try {
        bootstrapPath = resolveAndValidateFile('plugin-bootstrap-process.cjs')
      } catch {
        try {
          bootstrapPath = resolveAndValidateFile('plugin-bootstrap-process.js')
        } catch {
          bootstrapPath = resolveAndValidateFile('plugin-bootstrap-process.ts')
        }
      }
    }

    // MF-1：sandbox fork 前断言 execArgv 含 --import（ESM loader 注入口）。loader 缺失时
    // resolveEsmLoaderExecArgv 返回 undefined → execArgv 为空 → 此处 fail-closed throw，
    // 拒绝创建无 ESM 防护的 sandbox 进程（否则外部插件 await import('node:fs') 即 RCE）。
    // trusted 不受影响（走 Worker 线程不经此路径，不需要 ESM loader）。
    if (trustLevel === 'sandbox' && !this.execArgv.includes('--import')) {
      throw new Error(
        `[plugin-host-process] SANDBOX_LOADER_MISSING: cannot fork sandbox process without ESM loader ` +
        `(execArgv missing --import; resolveEsmLoaderExecArgv returned no loader). ` +
        `Refusing to create sandbox process without ESM import guard (RCE risk).`,
      )
    }

    // sandbox 子进程 env：注入 XYZ_PLUGIN_SANDBOX_DIR = dirname(pluginPath)（S1-W3
    // dirname 修正落点，spec §3.3 D2-①：ESM loader 以 startsWith(sandboxDir + sep)
    // 判界，目录必须传插件根目录形态。此前把入口文件路径原样注入，任何真实模块
    // 都不可能以 `<dir>/index.js/` 开头 → 边界/黑名单/scheme 检查 0% 命中）。
    // dirname 修正只在本宿主 env 注入处一处（activator 继续传 pluginPath 原语义），
    // loader 的 fail-closed 语义不变（env 缺失仍 initialize throw）。
    // trusted 不需要（ESM loader 仅 sandbox 进程经 execArgv --import 注入；
    // trusted 走 Worker 线程不经此 fork 路径）。
    // D6（docs/architecture/env-propagation-boundary.md §5-U4）：{...process.env} 全量拷贝对
    // trusted/sandbox 插件的兼容性属有意设计，拷贝拓扑不动——pass-all 前缀承载拷贝语义，
    // 仅经构建器叠加 deny 两键剔除（副本上删，R1）。
    const env: NodeJS.ProcessEnv = buildPluginHostChildEnv(process.env)
    if (trustLevel === 'sandbox' && pluginPath) {
      env.XYZ_PLUGIN_SANDBOX_DIR = pathDirname(pluginPath)
    }

    let child: ChildProcess
    try {
      child = fork(bootstrapPath, [], {
        // 打包约束（AGENTS.md #12）：必须 process.execPath + ELECTRON_RUN_AS_NODE=1
        // （打包后无独立 node；node 环境该 env 无害被忽略）
        execPath: process.execPath,
        env,
        // R2：stdout/stderr 显式 pipe 接管（防污染 runtime JSONL 事件流），数据转发 logger 落盘
        // 注意：fork 要求 stdio 含 'ipc'（默认自动追加，显式覆盖时必须保留）
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // C3：ESM loader 经 --import 注入点（默认空，不继承父进程 flags 保持子进程干净）
        execArgv: this.execArgv,
      })
    } catch (err: unknown) {
      console.error(`[plugin-host-process] failed to fork process ${processId}:`, err)
      throw new Error(`FORK_FAILED for ${processId}: ${String(err)}`)
    }

    // 子进程输出转发 runtime logger（console 已由 logger monkey-patch 落盘）
    child.stdout?.on('data', (d: Buffer) => {
      const line = String(d).trimEnd()
      if (line) console.log(`[plugin-process:${processId}] ${line}`)
    })
    child.stderr?.on('data', (d: Buffer) => {
      const line = String(d).trimEnd()
      if (line) console.error(`[plugin-process:${processId}] ${line}`)
    })

    const handle: ProcessHandle = {
      processId,
      pid: child.pid ?? -1,
      trustLevel,
      pluginIds: [pluginId],
      status: 'active',
      lastActiveAt: Date.now(),
    }

    this.processes.set(processId, handle)
    this.processInstances.set(processId, child)
    this.pluginToProcess.set(pluginId, processId)
    // D1 通道身份：sandbox 进程与插件一对一（processId = sandbox-<pluginId>），
    // 身份携带唯一 pluginId（鉴权按它查 granted，dispatch 覆写 params.pluginId）；
    // trusted 进程多插件共享（≤10）→ worker 级身份，无唯一归属。
    const identity: RpcIdentity =
      trustLevel === 'sandbox' ? { trustLevel: 'sandbox', pluginId } : { trustLevel: 'trusted' }
    // WorkerPort 适配：child.send → postMessage（IPC channel 与 Worker postMessage 语义同构）
    this.rpcServer.registerWorker(processId, {
      postMessage: (message: unknown) => {
        try {
          child.send(message as Serializable)
        } catch (e: unknown) {
          // best-effort：子进程已崩溃/terminated 时 IPC channel 关闭，send 抛错属预期，不传播
          console.debug(`[plugin-host-process] send failed for ${processId}:`, e)
        }
      },
    }, identity)

    child.on('message', (msg: unknown) => {
      // D6 入口防御：safe-dispatch（非对象/null 落 warning 丢弃 + 回调体 try/catch）
      safeDispatchHostMessage('plugin-host-process', processId, msg, {
        rpc: (m) => {
          // 子进程发来的 RPC 消息格式与 Worker 版一致——统一分发单一真相（Fix-3，
          // 原 TR1「分发逻辑复制，独立维护」改为与 plugin-host / e2e 共享实现）
          dispatchHostRpcMessage(this.rpcServer, processId, m)
        },
        crash: (error) => this.handleProcessCrash(processId, error),
        reply: (m) => {
          // 生命周期回复：转发给 Activator
          this.onReply?.(m)
          if (m.type === 'error') {
            console.error(`[plugin-host-process] plugin error: ${m.pluginId}: ${m.error}`)
          }
        },
      })
    })

    child.on('error', (err: Error) => {
      console.error(`[plugin-host-process] process ${processId} error:`, err.message)
      this.handleProcessCrash(processId, err.message)
    })

    // disconnect 先于 exit 到达（L-5 实测探针：子进程退出时父进程事件序为
    // disconnect → exit，且 exit 晚约一个事件循环圈，setImmediate 回调里
    // child.exitCode 仍为 null，占实测 49/50）。此刻无法同步区分「进程退出伴随的
    // 断开」与「存活进程主动断开 IPC」，立即判死会把 exit(0) 的正常退出误报为
    // crash（假崩溃 toast + CRASHED 标记 + crashCounts 累积）。故 disconnect 不做
    // 即时裁决，只挂 grace 兜底，权威分流交给 exit handler：
    // - exit 随后到达 → clean exit（code 0）/ crash（code≠0）已完成清理，grace
    //   到期时 handle 已删/已标记，幂等守卫直接返回
    // - grace 窗口内 exit 未到（进程仍存活）→ IPC 单方面断开的真异常 → 报 crash
    // - 窗口内 rebuild 已换新 child（processId 是 `sandbox-<pluginId>` 确定值，重建
    //   不换 id）→ 本定时器捕获的是旧 child 实例，必须按实例归属放行：旧 child 的
    //   迟到 disconnect/exit 不归新 handle 管（TC13：stale child late exit 不得
    //   crash 新 handle；removeAllListeners 只摘旧 child 的监听器，摘不掉已在飞的
    //   本定时器）
    child.on('disconnect', () => {
      const graceTimer = setTimeout(() => {
        if (this.processInstances.get(processId) !== child) return
        const handle = this.processes.get(processId)
        if (!handle || handle.status === 'crashed' || handle.status === 'terminated') return
        // exit 已到但 handle 尚未被清理的窄窗防御：code 0 的分流归 exit handler
        if (child.exitCode === 0) return
        this.handleProcessCrash(processId, 'Child process IPC channel disconnected while process alive')
      }, DISCONNECT_GRACE_MS)
      // 兜底定时器不得阻塞 runtime 退出（进程退出场景 exit 已分流，timer 到期即空转）
      graceTimer.unref?.()
    })

    child.on('exit', (code: number | null, signal: string | null) => {
      if (code === 0) {
        // L-5：exit code 0 是「正常退出」不是崩溃——不触发 onCrash、不进 crash 链
        // （假崩溃 toast / CRASHED 标记 / crashCounts 累积），但 handle、反向索引与
        // rpcServer 注册必须清理：残留 handle 会让 assignProcess 把插件分配到已死
        // 进程（child.send 落空），反向索引指向死进程
        this.handleProcessCleanExit(processId)
        return
      }
      console.error(`[plugin-host-process] process ${processId} exited with code ${code} signal ${signal}`)
      this.handleProcessCrash(processId, `Child process exited with code ${code}`, { exitCode: code, signal })
    })

    return handle
  }

  /**
   * exit code 0 的子进程清理（L-5，对齐 Worker 版 handleWorkerCleanExit）：正常退出
   * 与崩溃分流——不报 crash（onCrash 不触发、不进上层 crashCounts/rebuild 链）。
   * 幂等守卫与 crash 路径同款（crashed/terminated 已处理过则跳过；terminateProcess /
   * shutdown 的 pre-mark 路径自带清理，不会重复到达这里）。
   */
  private handleProcessCleanExit(processId: string): void {
    const handle = this.processes.get(processId)
    if (!handle || handle.status === 'crashed' || handle.status === 'terminated') return
    handle.status = 'terminated'
    const pluginIds = [...handle.pluginIds]
    this.rpcServer.unregisterWorker(processId)
    this.removeIndexEntries(processId, pluginIds)
    this.processInstances.delete(processId)
    this.processes.delete(processId)
    console.log(`[plugin-host-process] process ${processId} exited cleanly (code 0); handle cleaned up`)
  }

  /**
   * 崩溃统一处理：status 幂等守卫（crashed/terminated 不重复触发）。
   * 对齐 handleWorkerCrash 语义；重启 outOfScope（C5，由上层 wiring 决定）。
   *
   * exitMeta 仅 exit 事件路径携带（退出码/信号权威源）；error/disconnect/fatal_error
   * 路径无退出语义，台账行落显式 null（「不知道 ≠ 没打点」）。计划内终止（terminate
   * / shutdown 的 pre-mark）被幂等守卫先拦，不产生 crash 事件。
   */
  private handleProcessCrash(
    processId: string,
    error: string,
    exitMeta?: { exitCode: number | null; signal: string | null },
  ): void {
    const handle = this.processes.get(processId)
    if (!handle || handle.status === 'crashed' || handle.status === 'terminated') return

    handle.status = 'crashed'
    const pluginIds = [...handle.pluginIds]
    this.rpcServer.unregisterWorker(processId)
    this.removeIndexEntries(processId, pluginIds)

    // 台账双写（crash-forensics §3.3 D1 plugin-worker crash 行：worker 退出计数器驱动
    // 点/崩溃统一处理汇聚点补台账行，与 status 幂等守卫同点——同一进程不重复记）。
    // best-effort：writer append 自吞错不向崩溃链传播。code 0 正常退出走
    // handleProcessCleanExit，不经此处（正常退出不产生事件）。经中间变量传入
    // （扩展字段过 schema 闭接口的 excess property check）。
    const journalEvent: CrashJournalEvent = {
      layer: 'plugin-worker',
      event: 'crash',
      processId,
      pid: handle.pid,
      exitCode: exitMeta ? exitMeta.exitCode : null,
      signal: exitMeta ? exitMeta.signal : null,
      pluginIds,
      detailDigest: error,
    }
    getCrashJournal().append(journalEvent)

    // M6a-03：kill 兜底——fatal_error 消息路径子进程可能仍存活（发完消息不退出 = 进程
    // 泄漏）。崩溃时强制终止。kill 后晚到的 exit 被上方 status='crashed' 幂等守卫拦截，
    // 且重建时 createProcess 的残留清理会 removeAllListeners，不会命中新 handle。
    const child = this.processInstances.get(processId)
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill()
      } catch (e: unknown) {
        // best-effort：进程可能已退出，kill 抛错不阻塞崩溃通知
        console.debug(`[plugin-host-process] kill failed for crashed process ${processId}:`, e)
      }
    }

    this.onCrash?.(processId, pluginIds, error)
  }
}
