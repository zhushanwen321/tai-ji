/**
 * runtime 侧 relay env 注入。
 *
 * 注入链：runtime（本模块算出 3 个基础设施 env）→ process-manager createSession 的
 * RpcClient env（与 TAIJI_AGENT_DATA_DIR 同点）→ buildSafeEnv 显式 extras（TAIJI_ 前缀
 * 同时在白名单，双保险）→ 主 pi 进程 → extension buildChildEnv 自动继承 → 代理进程。
 *
 * 全有或全无：socket 未监听 / staged 脚本缺失 / 执行器探针失败任一命中 → 返回空对象
 * （relay 整体不激活，extension 侧 isRelayActive 判定三 env 缺失回落直连 spawn 真实
 * pi，行为与现状逐字节一致，E-TUI 零回归）。
 *
 * env 名常量从 @zhushanwen/subagent-core/relay-env（E-0 产物，D8 复用链切换后
 * runtime 直接依赖 core）import——纯常量无状态模块，符合引擎抽象 §3.3.1 贯穿纪律④
 * 的双端复用例外；禁在此手写字符串镜像。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  RELAY_ENV_SOCKET,
  RELAY_ENV_NODE,
  RELAY_ENV_SCRIPT,
} from '@zhushanwen/subagent-core/relay-env'
import { getRelayScriptPath } from './relay-paths.js'
import { isRelayServerActive, getActiveRelaySocketPath } from './relay-server.js'
import { warnOnce } from '../../utils/warn-once.js'

/** 探针超时（§10-1：spawn 执行器跑 --eval "process.exit(0)" 的完成上限）。 */
const PROBE_TIMEOUT_MS = 5_000

/** getRelaySpawnEnv 的可注入项（测试隔离用；生产全部走缺省推导）。 */
export interface RelaySpawnEnvOptions {
  /** 代理执行器路径；缺省 process.execPath。 */
  execPath?: string
  /** 执行器是否为 Electron 二进制；缺省按当前进程判定（打包态 sidecar 为 true）。 */
  isElectron?: boolean
  /** staged relay.mjs 路径；缺省按 projectRoot 双形态推导。 */
  scriptPath?: string
}

/**
 * §10-1 探针：验证执行器能以纯 node 语义执行 JS。
 *
 * 为什么需要：打包态 runtime 的 process.execPath 是 Electron 二进制（sidecar 由主进程
 * ELECTRON_RUN_AS_NODE=1 spawn），直接当 node 用会拉起 GUI——必须同 env 注入
 * ELECTRON_RUN_AS_NODE=1 才是纯 node 模式。探针被证伪则切形态 A（SEA，设计 §3.2 退路），
 * 本实现先降级为 relay 不激活。
 */
export function probeNodeExecutor(execPath: string, isElectron: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn> | null = null
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child?.kill('SIGKILL')
      } catch {
        // 已退出，正常路径
        void 0
      }
      resolve(ok)
    }
    const env: Record<string, string> = {}
    if (process.env.PATH !== undefined) env.PATH = process.env.PATH
    if (process.env.HOME !== undefined) env.HOME = process.env.HOME
    if (isElectron) env.ELECTRON_RUN_AS_NODE = '1'

    try {
      child = spawn(execPath, ['--eval', 'process.exit(0)'], { env, stdio: 'ignore', windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS)
    timer.unref()
    child.on('error', () => finish(false))
    child.on('exit', (code) => finish(code === 0))
  })
}

/** 探针结果缓存（key = execPath:isElectron）。失败也缓存——重试窗口留给下次 runtime 重启。 */
const probeCache = new Map<string, Promise<boolean>>()

function probeCached(execPath: string, isElectron: boolean): Promise<boolean> {
  const key = `${execPath}:${isElectron}`
  let p = probeCache.get(key)
  if (!p) {
    p = probeNodeExecutor(execPath, isElectron)
    probeCache.set(key, p)
  }
  return p
}

/** 测试钩子：清探针缓存（生产无调用方）。 */
export function resetRelayNodeProbeCache(): void {
  probeCache.clear()
}

/**
 * 计算注入主 pi 进程的 relay env（socket/执行器/脚本 + Electron 执行器的 RUN_AS_NODE）。
 *
 * 降级语义（返回 {}）：relay server 未激活 / staged 脚本不存在（并行任务 bundle 登记
 * 未就绪属预期，不报错）/ 探针失败。ELECTRON_RUN_AS_NODE 与三 env 同点注入——extension
 * spawn 代理经 {...process.env} 继承，代理执行器为 Electron 时必需；node 执行器忽略它，
 * 主 pi（bun binary）与 bash 工具同样忽略，无污染面（terminal 走 TerminalService 独立
 * env 构造，不经此链）。
 */
export async function getRelaySpawnEnv(projectRoot: string, opts?: RelaySpawnEnvOptions): Promise<Record<string, string>> {
  const socketPath = getActiveRelaySocketPath()
  if (!isRelayServerActive() || socketPath === undefined) return {}
  const scriptPath = opts?.scriptPath ?? getRelayScriptPath(projectRoot)
  // staged 脚本缺失只降级不激活——并行任务（bundle 登记拷贝）未就绪是常态路径。
  // RT-8#11：常态路径也不该零留痕（「relay 从未激活」不可观测——探针失败同款有 warn，
  // 此处此前静默）。warn-once 按路径去重：拷贝就绪后不再出声，长期缺失每次进程重启各提示一次。
  if (!existsSync(scriptPath)) {
    warnOnce(
      `relay-script:${scriptPath}`,
      `[relay] staged 脚本缺失，relay 未激活（extension 进程将直 spawn，不经代理）: ${scriptPath}。` +
        '若长期持续：重启 runtime 让 bundle 重新登记拷贝，或检查 apps/electron/resources/ 产物完整性',
    )
    return {}
  }

  const execPath = opts?.execPath ?? process.execPath
  const isElectron = opts?.isElectron ?? process.versions.electron !== undefined
  const probeOk = await probeCached(execPath, isElectron)
  if (!probeOk) {
    console.warn(`[relay] node executor probe failed for ${execPath} (isElectron=${isElectron}) — relay deactivated, spawning direct`)
    return {}
  }
  const env: Record<string, string> = {
    [RELAY_ENV_SOCKET]: socketPath,
    [RELAY_ENV_NODE]: execPath,
    [RELAY_ENV_SCRIPT]: scriptPath,
  }
  if (isElectron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}
