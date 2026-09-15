/**
 * relay socket server（E 方案，subagent-realtime-channel.md §4.1）。
 *
 * runtime 启动即 listen（早建早发现权限问题），socket 路径 per-instance 唯一（含 pid）。
 * 生命周期：initRelayServer（残留探活 + listen + 孤儿扫描）↔ deinitRelayServer（全部
 * 注册子进程杀链 + 删 socket 文件）。模块级单例——组合根（index.ts）唯一装配点，
 * relay-env 注入侧经 isRelayServerActive 联动（server 未激活则 env 不注入，relay
 * 整体不激活，回落现状直连）。
 */
import * as net from 'node:net'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { getDataDir } from '@taiji/shared/paths'
import type { ServerMessage } from '@taiji/shared'
import { RelayRegistry } from './relay-registry.js'
import { getRelayChildrenDir, getRelayRunDir, getRelaySocketPath } from './relay-paths.js'

/** 残留 socket 探活的连接超时（连得上=实例冲突；超时视为不可连=旧实例已死）。 */
const STALE_PROBE_TIMEOUT_MS = 1_000
/** server.close 等全部连接断开的兜底上限（destroyAll 已 destroy 连接，防御性）。 */
const SERVER_CLOSE_SETTLE_MS = 500

export interface RelayServerOptions {
  /** pi 二进制定位锚点（dev = apps/electron），透传 registry。 */
  projectRoot: string
  /** 数据目录（测试隔离注入；缺省 getDataDir()）。 */
  dataDir?: string
  /** tee 产出的 WS 帧发布（组合根注入 messageBus.publish）。 */
  publish: (sessionId: string, msg: ServerMessage) => void
  /** spawn 命令覆盖（测试注入假 pi）。 */
  piCommand?: string
}

interface RelayServerState {
  server: net.Server
  registry: RelayRegistry
  socketPath: string
  isUnixSocket: boolean
}

let state: RelayServerState | null = null

/** relay server 是否已初始化并监听（relay-env 注入的联动开关）。 */
export function isRelayServerActive(): boolean {
  return state !== null && state.server.listening
}

/** 当前 socket 监听路径（env 注入值；未激活时 undefined）。 */
export function getActiveRelaySocketPath(): string | undefined {
  return state?.socketPath
}

/**
 * 残留 socket 探活（§4.1）：上次崩溃残留的 socket 文件——connect 试探。
 * 连不上（ECONNREFUSED/超时）= 旧 runtime 已死，删除重建；连得上 = 实例冲突
 * （另一活实例在听同名 socket，pid 复用碰撞），报错退出防误杀他人注册表。
 */
function probeStaleSocket(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = net.connect({ path: socketPath })
    let settled = false
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      probe.destroy()
      clearTimeout(timer)
      if (!reachable) {
        // 连不上：旧实例已死，删除残留文件继续启动
        try {
          if (existsSync(socketPath)) unlinkSync(socketPath)
        } catch (e) {
          reject(new Error(`[relay] failed to remove stale socket ${socketPath}: ${String(e)}`))
          return
        }
        resolve()
        return
      }
      // 连得上：活实例在听——覆盖会劫持/误杀它的注册表，必须拒绝启动
      const stalePid = socketPath.match(/relay-(\d+)\.sock$/)?.[1] ?? 'unknown'
      reject(new Error(
        `[relay] socket ${socketPath} is held by a live runtime instance `
        + `(stale pid in name: ${stalePid}, this pid: ${process.pid}). `
        + `Recovery: 关闭另一个 taiji 实例后重启（lsof ${socketPath} 查看占用）。`,
      ))
    }
    const timer = setTimeout(() => finish(false), STALE_PROBE_TIMEOUT_MS)
    probe.once('connect', () => finish(true))
    probe.once('error', () => finish(false))
  })
}

/**
 * 初始化 relay server：目录创建 → 残留探活 → listen → 孤儿扫描兜底。
 *
 * 抛错（实例冲突 / listen 失败 / 目录权限）由组合根决定进程命运（fatal）——「早建早
 * 发现权限问题」。孤儿扫描是后台兜底（fire-and-forget），失败不阻塞启动。
 */
export async function initRelayServer(opts: RelayServerOptions): Promise<void> {
  if (state !== null) throw new Error('[relay] server already initialized')
  const dataDir = opts.dataDir ?? getDataDir()
  mkdirSync(getRelayRunDir(dataDir), { recursive: true })
  mkdirSync(getRelayChildrenDir(dataDir), { recursive: true })

  const socketPath = getRelaySocketPath(dataDir)
  const isUnixSocket = process.platform !== 'win32'
  // win32 named pipe 是内核对象无文件残留，探活跳过（pipe 名含本 pid 不会撞活实例）
  if (isUnixSocket && existsSync(socketPath)) {
    await probeStaleSocket(socketPath)
  }

  const registry = new RelayRegistry({
    projectRoot: opts.projectRoot,
    dataDir,
    publish: opts.publish,
    piCommand: opts.piCommand,
  })

  const server = net.createServer((conn) => {
    registry.handleConnection(conn)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // listen(path)：unix socket 文件路径 / win32 named pipe 名（node:net 同 API 形态）
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  state = { server, registry, socketPath, isUnixSocket }
  console.log(`[relay] server listening at ${socketPath}`)

  // 重启残留孤儿收割（§3.3-② 兜底腿；主腿是进程组传播）
  void registry.sweepOrphanChildren().catch((e) => {
    console.warn('[relay] orphan sweep failed (non-fatal):', e)
  })
}

/**
 * 关停：全部注册子进程杀链 → server close → 删 socket 文件（unix）。
 * 未初始化时 no-op（幂等——shutdown 序列与测试 afterEach 都可安全调用）。
 */
export async function deinitRelayServer(): Promise<void> {
  const s = state
  if (s === null) return
  state = null
  try {
    await s.registry.destroyAll()
  // eslint-disable-next-line taste/no-silent-catch -- 关停 best-effort：失败不阻塞 socket 清理与进程退出（子进程随进程组收割兜底）
  } catch (e) {
    console.warn('[relay] registry destroyAll failed during deinit:', e)
  }
  await new Promise<void>((resolve) => {
    s.server.close(() => resolve())
    // close 回调等全部连接断开；destroyAll 已 conn.destroy，无悬挂等待
    setTimeout(resolve, SERVER_CLOSE_SETTLE_MS).unref()
  })
  if (s.isUnixSocket) {
    try {
      if (existsSync(s.socketPath)) unlinkSync(s.socketPath)
    // eslint-disable-next-line taste/no-silent-catch -- 关停 best-effort：残留 socket 文件由下次启动 probeStaleSocket 删死文件
    } catch (e) {
      console.warn(`[relay] failed to remove socket file ${s.socketPath}:`, e)
    }
  }
  console.log('[relay] server deinitialized')
}

/** 测试钩子：读当前 registry 实例（断言注册数等）。生产无调用方。 */
export function getActiveRelayRegistry(): RelayRegistry | undefined {
  return state?.registry
}
