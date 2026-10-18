/**
 * 引擎进程 launch env 构建（M3，设计 relay-spawn-transport §3.3 D4「runtime 构建引擎
 * env 的单一函数」）。
 *
 * 基座不是裸 process.env，而是「runtime env + 显式 L0 注入」：runtimeEnv 经 SDK
 * buildEngineChildEnv 三层契约（L1 deny 剥 TAIJI_AGENT_PACKAGED/TAIJI_RUNTIME_TOKEN/
 * 凭证键 → L2 manifest envPrefixes 放行 → L0 基础设施键注入）过滤后再叠加 runtime 宿主
 * 特有注入。local transport（extension 直 spawn，经 buildEngineChildEnv）与 runtime
 * transport（本函数）的 task pi env 必须等价——等价性由
 * __tests__/subagent-control/engine-launch-env.test.ts 的键集合锚定（u-foundation 冻结
 * 清单：ENGINE_ENV_L0_INFRA_KEYS / ENGINE_ENV_DENY_LIST）。
 *
 * 注入键 × 依据（D4 env 键 × spawn 点矩阵的 engine 行）：
 * - PI_CODING_AGENT_DIR：runtime 显式注入 getPiAgentDir()（runtime 进程 env 无此键，
 *   local 形态经主 pi ambient 继承；runtime 直接 spawn 引擎必须补齐，嵌套 task pi 才
 *   能继承同一 agent 目录隔离）；
 * - PATH：findPiExecutable 所在目录前缀（引擎 spawn pi 子进程按名字解析 pi 时可达）；
 * - TAIJI_SUBAGENT_CONTROL_SOCKET / _ROOT_SESSION_ID：control 两键（SDK L0 基础设施
 *   键登记位；不进任何 deny——嵌套 extension 是合法读者，task pi 经引擎出站 env 继承）；
 * - TAIJI_ENGINE_RAW_MIRROR='1'：只给引擎（fd3 镜像通道宣告，u-m3-mirror 消费）；只在
 *   shared 出站 deny（剥 task pi 直 spawn 形态）登记、不在 SDK ENGINE_ENV_DENY_LIST——
 *   本函数在 buildEngineChildEnv 之后显式注入即不受影响，引擎再出站时的剥除归引擎侧
 *   出站构建器与 shared deny 的消费方（本单元不做该剥除——task pi 的 env 由引擎构建）。
 */
import { delimiter as pathDelimiter } from 'node:path'
import {
  buildEngineChildEnv,
  CONTROL_ENV_SOCKET,
  CONTROL_ENV_ROOT_SESSION_ID,
} from '@zhushanwen/subagent-engine-sdk'

/** 引擎 manifest 私有 env（launch 候选；未声明 envPrefixes 前缀不放行——SDK L2 判据）。 */
export type EngineProcessEnv = Record<string, string | undefined>

export type EngineLaunchEnvOptions = {
  /** runtime 进程 env 快照（组合根传 process.env；测试注入受控快照）。 */
  runtimeEnv: NodeJS.ProcessEnv
  /** 引擎数据根（SDK L0：TAIJI_AGENT_DATA_DIR）。 */
  dataDir: string
  /** 嵌套引擎执行器（SDK L0：TAIJI_AGENT_ENGINE_NODE；打包态 from getEngineRootsSpawnEnv）。 */
  engineNode?: string
  /** 执行器为 Electron 二进制（SDK L0：ELECTRON_RUN_AS_NODE=1；随 resolveEngineNodeLaunch 结果）。 */
  electronRunAsNode?: boolean
  /** 引擎 manifest 声明的放行前缀（launch spec 携带；SDK L2 判据输入）。 */
  envPrefixes?: readonly string[]
  /** 引擎 manifest 私有 env 候选（runtime 形态缺省 undefined——manifest 由 extension 侧读取）。 */
  processEnv?: EngineProcessEnv
  /** taiji 托管 pi agent 目录（getPiAgentDir()）。 */
  piAgentDir: string
  /** pi 可执行文件所在目录（PATH 前缀；findPiExecutable 的 dirname）。 */
  piDir?: string
  /** control socket 路径（control server 激活时必传）。 */
  controlSocket?: string
  /** 主会话根 id（engine_open 的 rootSessionId；嵌套 task pi 共享同一根）。 */
  rootSessionId?: string
  /** fd3 raw mirror 宣告（u-m3-mirror 消费；runtime 宿主恒 true）。 */
  rawMirror?: boolean
}

/** raw mirror 宣告值（布尔开关语义，引擎侧只判存在性/==='1'）。 */
const RAW_MIRROR_VALUE = '1'

/**
 * 构建引擎进程 spawn env（buildEngineLaunchEnv，D4 单一函数）。
 * 纯函数：不读写 process.env 本体，不 mutate 入参。
 */
export function buildEngineLaunchEnv(opts: EngineLaunchEnvOptions): Record<string, string> {
  // 基座拷贝（undefined 值不进 env——Node spawn 的 env 值须是 string）
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(opts.runtimeEnv)) {
    if (value !== undefined) base[key] = value
  }

  // SDK 三层契约：L1 deny → L2 manifest 放行 → L0 基础设施键
  const env = buildEngineChildEnv(base, {
    dataDir: opts.dataDir,
    engineNode: opts.engineNode,
    electronRunAsNode: opts.electronRunAsNode,
    envPrefixes: opts.envPrefixes,
    processEnv: opts.processEnv,
  })

  // runtime 宿主特有注入（顺序即覆盖优先级；control 两键后写——防 manifest 宽前缀
  // 借 L2 通道带入同 名旧值）
  env.PI_CODING_AGENT_DIR = opts.piAgentDir
  if (opts.piDir !== undefined && opts.piDir.length > 0) {
    env.PATH = `${opts.piDir}${pathDelimiter}${env.PATH ?? ''}`
  }
  if (opts.controlSocket !== undefined && opts.controlSocket.length > 0) {
    env[CONTROL_ENV_SOCKET] = opts.controlSocket
  } else {
    delete env[CONTROL_ENV_SOCKET]
  }
  if (opts.rootSessionId !== undefined && opts.rootSessionId.length > 0) {
    env[CONTROL_ENV_ROOT_SESSION_ID] = opts.rootSessionId
  } else {
    delete env[CONTROL_ENV_ROOT_SESSION_ID]
  }
  if (opts.rawMirror === true) {
    env.TAIJI_ENGINE_RAW_MIRROR = RAW_MIRROR_VALUE
  } else {
    delete env.TAIJI_ENGINE_RAW_MIRROR
  }
  return env
}
