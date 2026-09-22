/**
 * 同数据目录单实例互斥守卫（唯一「拒绝双 runtime」判定点）。
 *
 * 背景 [HISTORICAL] 2026-09-22 批量 subagent exit 143 事故：独立 runtime 进程
 * （`pnpm --filter @taiji/runtime start` 形态，验收脚本「重启 runtime」场景）与安装版
 * runtime 以同一数据目录 `~/.taiji` 并行双跑（端口不同不互抢）——新实例把旧实例的
 * session 当自己的 reattach + reaping orphan 杀幸存 subagent，退出时 destroyAll +
 * relay kill-on-disconnect 屠杀全部主 pi 与 subagent，单日 17 轮。根因 = 「同数据
 * 目录已有活实例」零互斥；端口探活互斥从根断链（fail-fast 早于任何子进程 spawn）。
 *
 * 判定模型（端口活性为权威，文件只是候选来源）：
 * - probe：读 `<dataDir>/runtime-instance.json`（本机制登记）与
 *   `<dataDir>/runtime.port`（Electron supervisor 通道——兼容未写本文件的旧版实例，
 *   如安装版），对候选端口做 127.0.0.1 TCP 探活。任一可达 = 活实例在场 → 拒绝启动；
 *   全部不可达 = stale 残留（正常退出/崩溃后未清理）→ 放行接管。
 * - register：listen 成功后原子写 runtime-instance.json（tmp + rename）。
 *   刻意不做退出清理：SIGKILL 等无清理钩子的骤死残留由端口判活天然判 stale。
 *
 * 探活为纯 TCP connect，不做 token/协议校验：数据目录同源已是强信号，误判方向
 * 取保守侧（拒绝双跑）；文件缺失/损坏不阻塞启动（文件非权威）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/** 本机制登记文件名（置于数据目录根，与 runtime.port / runtime-token 并排）。 */
export const RUNTIME_INSTANCE_FILE = 'runtime-instance.json'

/** supervisor 写的端口文件名（候选来源②，只读不写——写入权归 Electron 侧）。 */
const SUPERVISOR_PORT_FILE = 'runtime.port'

/** 候选端口合法上界（下界 1 与非法 NaN/非整数一并由 isValidPort 判弃）。 */
const MAX_VALID_PORT = 65535

/** runtime-instance.json 内容（registerRuntimeInstance 写入）。 */
export interface RuntimeInstanceRecord {
  pid: number
  port: number
  startedAt: string
}

/** probe 结果：blocked=true 时 holder 必在（拒绝信息需要 pid/port/source）。 */
export interface InstanceGuardProbeResult {
  blocked: boolean
  holder?: { port: number; pid?: number; source: 'runtime-instance.json' | 'runtime.port' }
}

/** 依赖注入（测试替换探活/时钟；生产用默认实现）。 */
export interface InstanceGuardDeps {
  isPortReachable?: (port: number, timeoutMs: number) => Promise<boolean>
}

/** 候选端口合法性：1-65535（0/NaN/越界的损坏文件值直接丢弃）。 */
function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= MAX_VALID_PORT
}

/**
 * 探活同数据目录是否已有活 runtime 实例。
 *
 * @param dataDir 数据目录（getDataDir() 结果）
 * @param deps 可注入探活实现
 * @returns blocked=true 表示活实例在场，调用方应 fail-fast（含 holder 定位信息）
 */
export async function probeSingleInstance(
  dataDir: string,
  deps: InstanceGuardDeps = {},
): Promise<InstanceGuardProbeResult> {
  const isReachable = deps.isPortReachable ?? defaultIsPortReachable
  // 候选按优先级收集（instance.json 优先——含 pid 可直接定位持有者）；同端口去重。
  const candidates = new Map<number, { pid?: number; source: 'runtime-instance.json' | 'runtime.port' }>()
  try {
    const raw = JSON.parse(readFileSync(path.join(dataDir, RUNTIME_INSTANCE_FILE), 'utf-8')) as Partial<RuntimeInstanceRecord>
    if (isValidPort(raw.port)) candidates.set(raw.port, { pid: typeof raw.pid === 'number' ? raw.pid : undefined, source: 'runtime-instance.json' })
  } catch (error) {
    // 降级策略：文件不存在/损坏是常态（正常退出不清理），debug 级留痕后按无候选继续——文件非权威
    console.debug('[runtime] single-instance guard: read runtime-instance.json failed (treated as absent):', error)
  }
  try {
    const parsed = parseInt(readFileSync(path.join(dataDir, SUPERVISOR_PORT_FILE), 'utf-8').trim(), 10)
    if (isValidPort(parsed) && !candidates.has(parsed)) candidates.set(parsed, { source: 'runtime.port' })
  } catch (error) {
    // 同上：文件非权威，缺失/损坏不阻塞启动
    console.debug('[runtime] single-instance guard: read runtime.port failed (treated as absent):', error)
  }
  for (const [port, meta] of candidates) {
    if (await isReachable(port, INSTANCE_PROBE_TIMEOUT_MS)) {
      return { blocked: true, holder: { port, pid: meta.pid, source: meta.source } }
    }
  }
  return { blocked: false }
}

/** 探活超时：localhost TCP connect 的宽松上界（真实连接 <10ms，给降载机器留余量）。 */
const INSTANCE_PROBE_TIMEOUT_MS = 500

/**
 * 登记本实例（listen 成功后调用）。原子写（tmp + rename）避免半写文件被下轮 probe
 * 读到。写失败仅记录不阻塞：文件是 probe 的候选来源之一而非权威，且 supervisor 的
 * runtime.port 通道仍在，双通道全失效才会退化为无互斥。
 */
export function registerRuntimeInstance(dataDir: string, port: number): void {
  const record: RuntimeInstanceRecord = { pid: process.pid, port, startedAt: new Date().toISOString() }
  const file = path.join(dataDir, RUNTIME_INSTANCE_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dataDir, { recursive: true })
    // 0600 对齐 runtime-token 先例（supervisor spawn 时 0600 写入）
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    // 降级策略：best-effort 登记——文件是 probe 候选来源之一而非权威（supervisor 的
    // runtime.port 通道仍在），写失败不阻塞启动；双通道全失效才退化为无互斥。
    console.error('[runtime] single-instance guard: failed to write runtime-instance.json (non-fatal):', err)
  }
}

/** 默认探活：127.0.0.1 TCP connect，连接建立即可达（不发送数据——对 runtime WS 端口无副作用）。 */
async function defaultIsPortReachable(port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const finish = (reachable: boolean): void => {
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}
