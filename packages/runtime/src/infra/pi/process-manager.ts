import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter as pathDelimiter, dirname, join } from 'node:path'
import { execSync } from 'node:child_process'
import { RpcClient, type RpcClientOptions } from './rpc-client.js'
import { getConfigDir } from './pi-paths.js'
import { assertPiSessionFile } from './session-attach-assert.js'
import type { IProcessManager } from '../../services/ports/pi-engine.js'
import { toErrorMessage } from '../../utils/errors.js'
import { isPackaged } from '../../utils/runtime-env.js'
import { buildOutboundChildEnv } from '../spawn-env.js'
// E-2（subagent-realtime-channel §4.2/§4.4）：findPiExecutable 抽出为共享函数
// （relay-registry 受托 spawn 真实 pi 复用同一决策链），原调用点行为零变化。
import { findPiExecutable } from './find-pi-executable.js'
import { getRelaySpawnEnv } from '../relay/relay-env.js'
import { getCrashJournal } from '../crash-journal.js'
// W9（设计 §3.7 Electron 打包态）：staged 引擎根推导 + pi 子进程注入（ROOTS +
// 打包态执行器两键）；构造期补齐 runtime 自身发现面的 L1 env（打包态无 node_modules）
import {
  ensureRuntimeEngineRootsEnv,
  getEngineRootsSpawnEnv,
} from '../../services/session/engine-roots.js'

interface ManagedProcess {
  client: RpcClient
  cwd: string
  createdAt: number
}

/**
 * 短命 pi 附着就绪上限（W11）：spawn 冷启动中位数 ~500ms（P0.5 探针，瓶颈在 Node
 * 冷启动）+ switchSession RPC（<1ms），端到端预算 ~600ms；5s 上限覆盖慢机/首次冷缓存。
 */
const EPHEMERAL_READY_TIMEOUT_MS = 5_000

/**
 * 给 promise 套一层超时（短命 pi 就绪等待专用）。
 *
 * 超时后底层 promise 仍可能 pending（switchSession 自身 SLOW_TIMEOUT_MS 120s）——
 * withEphemeralPi 的 finally destroySession 会 kill 进程 → RpcClient.rejectAll 让其
 * settle，本包装的 then/catch 已就位，不产生 unhandled rejection。
 */
function raceReadyTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Manages pi subprocess lifecycles. Each session gets its own
 * isolated pi process spawned via `pi --mode rpc`.
 */
export class ProcessManager implements IProcessManager {
  private processes = new Map<string, ManagedProcess>()
  private clientToId = new Map<RpcClient, string>()
  private exitCallbacks = new Set<(sessionId: string, code: number | null, stderr: string) => void>()
  private piPath: string | null = null
  private piPathPromise: Promise<string> | null = null
  private piVersionCache: string | null = null

  constructor(private readonly projectRoot: string) {
    // 懒初始化：不在构造函数中执行同步 I/O，避免阻塞事件循环
    // piPath 在首次 createSession 时才解析
    // W9：runtime 自身发现面 env 补齐（幂等；staged 引擎根存在才写）——打包态无
    // node_modules（L2 空），不补齐则 runtime ①级读引擎零命中。唯一的构造期 I/O =
    // existsSync 一次 stat（engine-roots 推导），量级远低于「懒初始化」要规避的
    // pi 路径扫描，且必须早于任何引擎发现调用点。
    ensureRuntimeEngineRootsEnv(projectRoot)
  }

  /** 获取或解析 pi 可执行文件路径（只执行一次） */
  private getPiPath(): Promise<string> {
    if (this.piPath) return Promise.resolve(this.piPath)
    if (this.piPathPromise) return this.piPathPromise
    this.piPathPromise = Promise.resolve().then(() => {
      const resolved = findPiExecutable(this.projectRoot)
      this.piPath = resolved
      if (resolved !== 'pi') {
        console.log(`[process-manager] using pi at: ${resolved}`)
      } else {
        console.warn('[process-manager] pi not found in common locations, relying on PATH')
      }
      return resolved
    })
    return this.piPathPromise
  }

  /** 探测 pi 版本（首次调用 execSync，后续读缓存）。失败返回 'unknown'。 */
  async getPiVersion(): Promise<string> {
    if (this.piVersionCache) return this.piVersionCache
    try {
      const piPath = await this.getPiPath()
      const cmd = piPath !== 'pi' ? `"${piPath}" --version` : 'pi --version'
      const version = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 5_000,
        // C-proc-09：出站契约构建器组装 env（pi --version 只读探测，白名单基座保留 PATH/HOME）
        env: buildOutboundChildEnv({ parentEnv: process.env }),
      }).trim()
      this.piVersionCache = version || 'unknown'
    } catch (e) {
      console.warn('[process-manager] failed to detect pi version:', e)
      this.piVersionCache = 'unknown'
    }
    return this.piVersionCache
  }

  /**
   * Spawn a new pi subprocess for the given session.
   * If a process already exists for this sessionId it is killed first.
   */
  async createSession(sessionId: string, cwd: string, options?: RpcClientOptions): Promise<RpcClient> {
    if (this.processes.has(sessionId)) {
      await this.destroySession(sessionId)
    }

    const piPath = await this.getPiPath()

    // Inject discovered pi directory into PATH so spawn('pi', ...) resolves
    const piDir = piPath !== 'pi' ? join(piPath, '..') : undefined
    const pathEnv: Record<string, string> = {}
    if (piDir) {
      pathEnv.PATH = `${piDir}${pathDelimiter}${process.env.PATH ?? ''}`
    }

    // XYZ_AGENT_DATA_DIR 显式注入：pi 主会话进程内的 extension（subagent-workflow
    // engine 层 journal/隔离池）需要与 runtime 同源的 dataDir。dev 模式下 Electron
    // 已设置该 env、经 XYZ_ 白名单透传成立；prod 默认路径（~/.xyz-agent）下 runtime
    // 进程 env 没有该变量（shared getDataDir 缺省时不写 env），透传链断——故此处
    // 用 getConfigDir()（读同一 env + 同一缺省）显式补齐。放 spread 首位，
    // options?.env 仍可覆盖。
    // E-2 relay env（subagent-realtime-channel §2.2）：注入 SOCKET/NODE/SCRIPT 三个
    // 基础设施 env，extension 侧 isRelayActive 判定齐备后经代理转交 spawn。降级语义：
    // relay server 未激活 / staged 脚本缺失 / 执行器探针失败 → 空对象（spread 无副作用，
    // 行为与现状逐字节一致）；首次调用含探针 spawn（之后 Promise 缓存，无重复开销）。
    const relayEnv = await getRelaySpawnEnv(this.projectRoot)
    // W9 引擎 env（设计 §3.7 路径传递）：staged 引擎根绝对路径显式注入（不 cwd 探测）
    // + 打包态执行器 XYZ_AGENT_ENGINE_NODE/ELECTRON_RUN_AS_NODE（pi 扩展宿主的
    // process.execPath 是 pi binary，矩阵① 必须用注入执行器）。键序在 DATA_DIR 之后、
    // options.env 之前（调用方显式配置仍可覆盖）。
    const engineRootsEnv = getEngineRootsSpawnEnv(this.projectRoot)
    // B3 出站注入组（docs/architecture/env-propagation-boundary.md §5-U3）：本对象经
    // RpcClientOptions.env 传入，由 rpc-client start() 的 buildOutboundChildEnv 作为
    // extras 在过滤基座之上整体覆盖；下方 spread 键序即覆盖优先级
    // （DATA_DIR < PATH 补齐 < relay 三件套 < 调用方 options.env），与组装迁入构建器前
    // 逐键一致。PI_CODING_AGENT_DIR 由 rpc-client 在构建器输出之上追加（同迁移前）。
    const injectionEnv: Record<string, string> = {
      XYZ_AGENT_DATA_DIR: getConfigDir(),
      ...pathEnv,
      ...relayEnv,
      ...engineRootsEnv,
    }
    const client = new RpcClient({ cwd, sessionId, ...options, env: { ...injectionEnv, ...options?.env }, piCommand: piPath !== 'pi' ? piPath : undefined })
    try {
      await client.start()
    } catch (e) {
      const msg = toErrorMessage(e)
      // 刻意用字符串匹配（非 isEnoent）：这里要同时捕获 spawn ENOENT 与子进程 spawn
      // 失败两类错误（后者不一定是带 .code 的 errno），D20 的结构化 isEnoent 不适用。
      if (msg.includes('spawn') || msg.includes('ENOENT')) {
        if (isPackaged()) {
          throw new Error(
            `Failed to start bundled pi process. The application installation may be corrupted. `
            + `Attempted binary: ${piPath}. Original error: ${msg}`,
          )
        }
        throw new Error(
          `Failed to start pi process. Ensure pi is installed globally (npm i -g @earendil-works/pi-coding-agent). `
          + `Searched: PATH, ~/.nvm/versions/*/bin/pi, /usr/local/bin/pi. `
          + `Original error: ${msg}`,
        )
      }
      throw e
    }

    // Listen for unexpected exits to notify upper layer.
    // onExit 返回的 unsubscribe 刻意不持有：client 生命周期与 Map 条目一致，
    // intentional destroy 由下方 clientToId 无条目守卫覆盖，无需显式解绑。
    client.onExit((code, stderr) => {
      // 反查当前 id：闭包捕获的 sessionId 在 rekey 后过期（create 路径 tempId → piSessionId），
      // 用 has(capturedId) 守卫会在 rekey 后误判「已被清理」→ 死亡通知整条丢失（僵尸 session 根因）。
      // clientToId 与 processes 由 createSession/destroySession/rekey 成对维护，执行时反查天然同步。
      const currentId = this.clientToId.get(client)
      // clientToId 无条目 = 已被 destroySession 清理（intentional destroy），跳过通知
      if (currentId === undefined) return
      // D5①（session-dead-structural-fixes）：kill 路径全量日志 K8——异常退出收敛的观测点：
      // 走到此处 = pi 进程自发退出（intentional destroy 已被上方 clientToId 无条目守卫拦截），
      // 记录退出码与收敛链，供事后从 exit 143 类死亡回溯发起方。
      console.warn(`[process-manager] session ${currentId} process exited unexpectedly (code: ${code}) (kill_source=exit_converge | who: pi exited on its own (crash / external kill), not an intentional destroy | chain: exit event -> exitCallbacks -> upper onSessionExit convergence (persist stopped + occupancy reset + session.exited))`)
      this.processes.delete(currentId)
      this.clientToId.delete(client)
      // 命名消歧：this.exitCallbacks 是 ProcessManager 的 Set<(sessionId, code, stderr) => void>
      // （上层多播，process-manager.ts:123），与 RpcClient.exitCallbacks（Set<(code, stderr) => void>）
      // 是不同类、不同签名的同名字段
      for (const cb of this.exitCallbacks) {
        cb(currentId, code, stderr)
      }
    })

    this.processes.set(sessionId, {
      client,
      cwd,
      createdAt: Date.now(),
    })
    this.clientToId.set(client, sessionId)

    return client
  }

  /**
   * W11（数据源治理）：短命 pi 附着指定 session 文件执行一次性 RPC，用后即毁。
   *
   * 形态（探针场景 B 定型，逐次冷起——父文档 D2 裁决禁 warm pi）：复用 createSession
   * spawn `pi --mode rpc` → `switchSession(sessionFile)` 附着该文件（就绪上限 5s）→
   * fn(client) → destroySession。session JSONL 本体的唯一写方是 pi：fn 内的 RPC
   * （如 setSessionName）由 pi 自身 appendFileSync 落盘，xyz 不触碰文件。
   *
   * 附着经 switchSession RPC 而非 `pi --session <file>` CLI flag——RpcClient 的 spawn
   * 参数面（rpc-client.ts）不在本 wave 改动范围，switchSession 是既有附着原语
   * （restoreSession 同款）。spawn 时 pi 先建内存新 session（首条 assistant 前不落盘，
   * 规则 #6），switchSession 切走后即弃，sessions 目录零残留。
   *
   * 失败语义：spawn 失败 / 就绪超时 / fn 抛错一律 rethrow（进程在 finally 销毁），
   * 调用方（如 renameSession 非活跃分支）按既有失败路径报错、保留旧值可重试。
   *
   * @param sessionFile 目标 session JSONL 绝对路径（须已存在；不存在时 switchSession
   *                    由 pi 报错，走同一失败路径）
   * @param fn          就绪后在附着 client 上执行的一次性操作
   */
  async withEphemeralPi<T>(sessionFile: string, fn: (client: RpcClient) => Promise<T>): Promise<T> {
    // spawn cwd 只影响 pi 初始（弃用）session 的上下文，不影响 switchSession 后的目标
    // session；取 sessions 目录（文件所在处，扫描结果保证存在）——目标 session 自身
    // header 的 cwd 死路径场景由调用方处理（renameSession 非活跃分支附着前 F3 归一化
    // cwd fallback，p1p4-closure W1；restoreSession 同款），与本入口无关。目录竞态消失时
    // 兜底 homedir，让失败落在 switchSession（pi 报「文件不存在」）而非 spawn ENOENT。
    const spawnCwd = existsSync(dirname(sessionFile)) ? dirname(sessionFile) : homedir()
    const ephemeralId = `ephemeral-${Date.now()}-${crypto.randomUUID()}`
    const client = await this.createSession(ephemeralId, spawnCwd)
    try {
      await raceReadyTimeout(
        client.switchSession(sessionFile),
        EPHEMERAL_READY_TIMEOUT_MS,
        `Ephemeral pi attach timed out after ${EPHEMERAL_READY_TIMEOUT_MS}ms (sessionFile: ${sessionFile})`,
      )
      // W2（restore-fork-attach-fix F4）：附着必断言（I1）。withEphemeralPi 附着本就是
      // 真实文件、天然通过；接线它使「附着必断言」成为无例外结构（设计文档 D4），
      // 新附着调用点照抄即得守卫。
      await assertPiSessionFile(client, sessionFile, `withEphemeralPi(${sessionFile})`)
      return await fn(client)
    } finally {
      await this.destroySession(ephemeralId)
    }
  }

  /**
   * Kill the pi subprocess for a session.
   */
  async destroySession(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId)
    if (!proc) return
    // D1 台账（crash-forensics §3.3 D1 写入点矩阵 shutdown 行）：pi 计划内终止在杀链发起处
    // 与杀链动作同点双写（reason=planned——附录 A #16 以这些 kill 发起事件的时间窗排除
    // 计划内 SIGTERM）。不能挂 exit handler：本方法已先行删 processes/clientToId，exit 回调
    // 反查无条目静默返回（抑制语义），挂错点事件永不产生（与 deleted 行同机理）。
    // `!proc` 守卫天然幂等去重：重复调用/无条目不产生事件。destroyAll 逐 session 经本方法
    // 到达同一挂点，无需单独双写。append 为 fire-and-forget，不阻塞杀链。
    getCrashJournal().append({ layer: 'pi', event: 'shutdown', reason: 'planned', sessionId })
    // Remove from maps first to prevent exitCallback from triggering,
    // but keep a reference so we can kill after removal.
    // kill() is guaranteed to resolve (SIGCONT → SIGTERM → 2s → SIGKILL).
    // 幂等：Map 无条目时（并发 deleteSession / 强杀分支已先行）静默跳过，不重复 kill。
    this.processes.delete(sessionId)
    this.clientToId.delete(proc.client)
    try {
      await proc.client.kill()
    // eslint-disable-next-line taste/no-silent-catch -- kill() has internal SIGTERM→SIGKILL fallback; orphan risk logged
    } catch (e) {
      console.warn(`[process-manager] [PROCESS-LEAK-RISK] kill failed for session ${sessionId}:`, toErrorMessage(e))
    }
  }

  /**
   * Get the RpcClient for a session (or undefined if not running).
   */
  getClient(sessionId: string): RpcClient | undefined {
    return this.processes.get(sessionId)?.client
  }

  /** Get session ID by client instance (O(1) reverse lookup). */
  getSessionIdByClient(client: RpcClient): string | undefined {
    return this.clientToId.get(client)
  }

  hasClient(sessionId: string): boolean {
    return this.processes.has(sessionId)
  }

  /**
   * Kill all managed subprocesses.
   */
  async destroyAll(): Promise<void> {
    const ids = Array.from(this.processes.keys())
    // D5①（session-dead-structural-fixes）：kill 路径全量日志 K6——批量销毁含调用源与信号链
    //（仅实际有进程时打，空表 shutdown 空转零信息量不打）。
    if (ids.length > 0) {
      console.warn(`[process-manager] destroyAll killing ${ids.length} session(s) [${ids.join(', ')}] (kill_source=destroy_all | who: runtime shutdown / sessionService.destroyAll | chain: fan-out per-session SIGTERM destroy)`)
    }
    await Promise.allSettled(ids.map(id => this.destroySession(id)))
  }

  /** Check if the subprocess for a session is still running. */
  isAlive(sessionId: string): boolean {
    const proc = this.processes.get(sessionId)
    return !!proc && !proc.client.exited
  }

  /** Rekey a process entry after learning the real session ID. */
  rekey(oldId: string, newId: string): void {
    const entry = this.processes.get(oldId)
    if (!entry) return
    this.processes.delete(oldId)
    this.processes.set(newId, entry)
    this.clientToId.set(entry.client, newId)
  }

  /** Register a callback for when a session's process exits unexpectedly. Returns unsubscribe function. */
  onSessionExit(callback: (sessionId: string, code: number | null, stderr: string) => void): () => void {
    this.exitCallbacks.add(callback)
    return () => { this.exitCallbacks.delete(callback) }
  }

  /** Number of active processes. */
  get size(): number {
    return this.processes.size
  }
}
