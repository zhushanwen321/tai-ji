/**
 * subagent-control 基建路径解析（M3，设计 relay-spawn-transport §3.4.3 / §3.4.5）。
 *
 * 为什么独立模块：socket / 引擎 pid 文件两类路径被 control-server（listen / spawn 登记）、
 * sweep（跨代扫描）与 process-manager（env 注入侧 getActiveControlSocketPath）三方消费，
 * 统一从 getDataDir() 动态推导（排查规则：路径白名单禁止写死绝对路径）。dataDir 经参数
 * 注入、缺省走 SSOT——测试需要隔离目录（同进程多实例不能共用 pid 命名的 socket）。
 *
 * 布局（§3.4.5 状态写入点表）：
 * - `<dataDir>/run/subagent-<pid>.sock`     control socket（win32 为 named pipe，无文件残留）
 * - `<dataDir>/run/subagent-engines/*.pid`  引擎通道 pid 文件
 */
import { join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'

/** 引擎 pid 文件目录名（<dataDir>/run/subagent-engines/，D7）。 */
export const CONTROL_ENGINES_DIR_NAME = 'subagent-engines'

/** control socket 父目录（<dataDir>/run/）。 */
export function getControlRunDir(dataDir: string = getDataDir()): string {
  return join(dataDir, 'run')
}

/** 引擎通道 pid 文件目录。 */
export function getControlEnginesDir(dataDir: string = getDataDir()): string {
  return join(getControlRunDir(dataDir), CONTROL_ENGINES_DIR_NAME)
}

/**
 * control socket 监听路径：per-runtime-instance 唯一（路径含 pid——多 app 实例共存互不
 * 串扰，崩溃残留可识别归属；前缀 subagent- 区分族）。
 * win32 用 named pipe（node:net 同 API 形态传 pipe 名，无文件系统残留，故启动探活跳过）。
 */
export function getControlSocketPath(dataDir: string = getDataDir()): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\taiji-subagent-${process.pid}`
  }
  return join(getControlRunDir(dataDir), `subagent-${process.pid}.sock`)
}

/**
 * socket 路径长度门禁（D4）：macOS unix domain socket 路径上限 104 字节，dataDir 过深
 * 时 listen 静默失败/报 ENAMETOOLONG 类错——fail-fast 并给「缩短 dataDir」恢复指引
 * （win32 named pipe 是内核对象名，不受此限）。
 */
export const UNIX_SOCKET_PATH_MAX_BYTES = 104

export function assertSocketPathLength(socketPath: string): void {
  if (process.platform === 'win32') return
  const bytes = Buffer.byteLength(socketPath, 'utf8')
  if (bytes > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `[subagent-control] socket path too long for unix domain socket: ${socketPath} `
      + `(${bytes} bytes > ${UNIX_SOCKET_PATH_MAX_BYTES}). `
      + 'Recovery: 缩短数据目录路径（TAIJI_AGENT_DATA_DIR）后重启。',
    )
  }
}

/**
 * 引擎通道 pid 文件路径：<enginesDir>/<rootSessionId>-<engineId>-<channelId>.pid（D7）。
 * 三段组件经 sanitize（防路径穿越/异常字符撑爆文件名）——组件来源是帧字段（外部输入），
 * 不做语义校验但做文件名安全收窄；channelId 是 runtime 自生成（天然安全），双保险仍过
 * 同一清洗。
 */
const PID_FILE_COMPONENT_MAX_CHARS = 64
const PID_COMPONENT_SAFE_RE = /[^a-zA-Z0-9._-]/g

function sanitizeComponent(raw: string): string {
  const cleaned = raw.replace(PID_COMPONENT_SAFE_RE, '_').slice(0, PID_FILE_COMPONENT_MAX_CHARS)
  return cleaned.length > 0 ? cleaned : '_'
}

export function getEnginePidFilePath(
  rootSessionId: string,
  engineId: string,
  channelId: string,
  dataDir: string = getDataDir(),
): string {
  return join(
    getControlEnginesDir(dataDir),
    `${sanitizeComponent(rootSessionId)}-${sanitizeComponent(engineId)}-${sanitizeComponent(channelId)}.pid`,
  )
}
