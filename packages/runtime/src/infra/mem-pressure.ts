/**
 * os 级内存压力即时查询（crash-forensics-and-watchdog.md §3.3 D3 高水位延迟 / D4 采样
 * 形态裁决，实施单元 u5 交付、u7c 滚动重启硬升级后续消费）。
 *
 * **即时查询语义（D4 采样形态裁决）**：memPressure 本质是系统级信号，判定时刻一拍即得、
 * 无历史依赖——本模块不持有任何采样环/缓存，每次调用重新读 os。消费方（u5 reattach 高水位
 * 延迟、u7c 硬升级）冷启动零数据即可判定；若依赖 D4 采样环历史，新 runtime 冷启动时环零
 * 数据 = 恒空转（D3 原文裁决）。
 *
 * 平台面（设计 §5 待验证检查点「memPressure 跨平台 API 差异」的落地口径）：
 * - 物理内存：node:os freemem/totalmem（跨平台同步）；
 * - swap：node:os 不暴露——Linux 读 /proc/meminfo（SwapTotal/SwapFree，kB），macOS
 *   `sysctl -n vm.swapusage`（execFile 数组参数不经 shell，带超时），其余平台 null（未知）。
 *   swap 未知时 swap 判据不命中、物理空闲判据仍在（判定面收窄，不阻塞恢复）。
 *
 * 高压判据（初值，设计 D3「阈值随 Gate W 校准」——调用方可注入覆盖）：
 * - swap 近耗尽：swapUsed/swapTotal ≥ swapUsedRatio（swap 是「物理内存已耗尽后溢出」的
 *   直接信号，比 free pages 更接近真实死法——架构 D3 系统级归因论证）；
 * - 物理空闲下限：free/total ≤ freeRatioFloor（兜底 swap 不可得的平台）。
 * errs 方向声明：阈值偏高 = 高压漏判 → 集中 spawn 有二次崩溃敞口；阈值偏低 = 判定过敏 →
 * 恢复推迟走 lazy 兜底（设计 D3「宁 lazy 不双持 / 宁推迟不二次崩溃」选安全向，故初值取
 * 极端档——常态 macOS free pages 偏低（缓存策略）不误触发，详见 DEFAULT_* 注释）。
 *
 * 查询永不 reject（best-effort 契约，对齐 crash-journal：单源失败降级 null，旁路设施
 * 故障不得放大为调用链故障）。
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
// C-proc-09（env-propagation-boundary）：本文件含进程创建调用点（sysctl swap 探针），
// 子 env 须经出站契约构建器组装（白名单前缀过滤保 PATH 可解析 sysctl + deny 清单剥
// TAIJI_AGENT_PACKAGED / TAIJI_RUNTIME_TOKEN，防止 runtime 凭据随探针进程外泄）。
import { buildOutboundChildEnv } from './spawn-env.js'
// 字节 → MB 换算基数单点（结构收敛批：本地 1_048_576 常量收编到 shared，与
// trace-sync / restore-seeding / extractor 骨架共用同一换算口径）
import { BYTES_PER_MB } from '@taiji/shared'

/** /proc/meminfo 的 kB 字段 → MB 换算基数。 */
const KB_PER_MB = 1024

/** swap 探针超时（sysctl 是毫秒级本地调用，超时只为防假死悬挂判定时刻）。 */
const SWAP_PROBE_TIMEOUT_MS = 2_000

/** /proc/meminfo 权威路径（Linux）。 */
const LINUX_MEMINFO_PATH = '/proc/meminfo'

/** 单源 swap 压力样本（MB）。 */
export interface MemPressureSwapSample {
  /** 已用 swap（MB）。 */
  swapUsedMB: number
  /** swap 总量（MB）。 */
  swapTotalMB: number
}

/**
 * os 级内存压力样本（即时查询的返回形态；字段可 null = 平台不可得，「不知道 ≠ 没打点」
 * 同源原则——schema CrashJournalMemPressure 的 swapUsedMB/freeMB 与本形态同名字段直通）。
 */
export interface MemPressureSample {
  /** 已用 swap（MB）；平台不可得 = null。 */
  swapUsedMB: number | null
  /** swap 总量（MB）；平台不可得 = null。 */
  swapTotalMB: number | null
  /** 物理空闲内存（MB）（os.freemem()）。 */
  freeMB: number
  /** 物理总内存（MB）（os.totalmem()）。 */
  totalMB: number
}

/** 高压判定阈值（初值随 Gate W 校准；注入可覆盖，见 isMemPressureHigh）。 */
export interface MemPressureThresholds {
  /** swap 使用占比 ≥ 此值判高压（swap 近耗尽）。 */
  swapUsedRatio: number
  /** 物理空闲占比 ≤ 此值判高压（空闲下限）。 */
  freeRatioFloor: number
}

/**
 * 默认阈值（初值，设计 D3「阈值随 Gate W 校准」）：
 * - swap 95%：swap 用满前最后一段才是「近耗尽」——取极端档避免常态多 swap 配置误触发；
 * - 空闲 1%：物理空闲下限兜底 swap 不可得平台；macOS 缓存策略使 free pages 常态偏低，
 *   1% 极端档保证正常机器零误触发（高压恢复推迟本身有 lazy 兜底，误触发代价 = 推迟）。
 */
export const DEFAULT_MEM_PRESSURE_THRESHOLDS: MemPressureThresholds = {
  swapUsedRatio: 0.95,
  freeRatioFloor: 0.01,
}

/**
 * 解析 /proc/meminfo 文本中的 swap 字段（纯函数；Linux）。
 * 形态：`SwapTotal: 2097148 kB` / `SwapFree: 2097148 kB`。字段缺失或非数字 → null
 * （unknown ≠ 0——把解析失败当 0 会伪造「无 swap」）。
 */
export function parseLinuxMemInfoSwap(text: string): MemPressureSwapSample | null {
  const totalKB = Number(text.match(/^SwapTotal:\s+(\d+)\s+kB/m)?.[1])
  const freeKB = Number(text.match(/^SwapFree:\s+(\d+)\s+kB/m)?.[1])
  if (!Number.isFinite(totalKB) || !Number.isFinite(freeKB)) return null
  const swapTotalMB = totalKB / KB_PER_MB
  return { swapUsedMB: Math.max(0, swapTotalMB - freeKB / KB_PER_MB), swapTotalMB }
}

/**
 * 解析 macOS `sysctl -n vm.swapusage` 输出（纯函数）。
 * 形态：`total: 2048.00M used: 512.00M free: 1536.00M (encrypted)`。解析失败 → null。
 */
export function parseMacSwapUsage(text: string): MemPressureSwapSample | null {
  const m = text.match(/total:\s+([\d.]+)M\s+used:\s+([\d.]+)M/)
  if (!m) return null
  const swapTotalMB = Number(m[1])
  const swapUsedMB = Number(m[2])
  if (!Number.isFinite(swapTotalMB) || !Number.isFinite(swapUsedMB)) return null
  return { swapUsedMB, swapTotalMB }
}

function execSysctlSwapUsage(): Promise<string> {
  return new Promise((resolve, reject) => {
    // env 经出站契约构建器（C-proc-09，check_spawn_env_boundary 判定模型模式 1）：
    // 只读 OS 探针同样不继承父 env 全量——白名单基座保 PATH（execvp 按 child env 解析
    // PATH，缺它则 'sysctl' 解析失败），deny 兜底剥 runtime 凭据。
    execFile('sysctl', ['-n', 'vm.swapusage'], {
      encoding: 'utf8',
      timeout: SWAP_PROBE_TIMEOUT_MS,
      env: buildOutboundChildEnv({ parentEnv: process.env }),
    }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/**
 * 平台 swap 探针（best-effort）：Linux /proc/meminfo 同步读；macOS sysctl 异步探；
 * 其余平台 / 单源失败 → null（判定面收窄不抛错）。独立导出供测试与调用方 DI。
 */
export async function probeSwapPressure(): Promise<MemPressureSwapSample | null> {
  try {
    if (process.platform === 'linux') {
      return parseLinuxMemInfoSwap(readFileSync(LINUX_MEMINFO_PATH, 'utf8'))
    }
    if (process.platform === 'darwin') {
      return parseMacSwapUsage(await execSysctlSwapUsage())
    }
    return null
  } catch {
    return null // best-effort 探针：单源失败降级 null（unknown），查询契约永不 reject
  }
}

/**
 * 即时查询 os 级内存压力（判定时刻一拍即得，无历史依赖，永不 reject）。
 *
 * @param options.probeSwap swap 探针注入（测试替身/调用方覆盖）；缺省 probeSwapPressure
 */
export async function queryMemPressure(
  options: { probeSwap?: () => Promise<MemPressureSwapSample | null> } = {},
): Promise<MemPressureSample> {
  const probe = options.probeSwap ?? probeSwapPressure
  let swap: MemPressureSwapSample | null = null
  try {
    swap = await probe()
  } catch {
    swap = null // 注入探针抛错同样降级 null（查询契约永不 reject）
  }
  return {
    swapUsedMB: swap?.swapUsedMB ?? null,
    swapTotalMB: swap?.swapTotalMB ?? null,
    freeMB: os.freemem() / BYTES_PER_MB,
    totalMB: os.totalmem() / BYTES_PER_MB,
  }
}

/**
 * 高压判定（纯函数，无历史依赖——冷启动单样本即可判定，A4 验收语义）。
 *
 * swap 判据只在「总量已知且 > 0 且用量已知」时参与（unknown ≠ 0：null 不伪造命中或不
 * 命中）；物理空闲判据在 totalMB > 0 时恒参与。两判据任一命中即高压。
 */
export function isMemPressureHigh(
  sample: MemPressureSample,
  thresholds: MemPressureThresholds = DEFAULT_MEM_PRESSURE_THRESHOLDS,
): boolean {
  if (
    sample.swapTotalMB !== null
    && sample.swapTotalMB > 0
    && sample.swapUsedMB !== null
    && sample.swapUsedMB / sample.swapTotalMB >= thresholds.swapUsedRatio
  ) {
    return true
  }
  if (sample.totalMB > 0 && sample.freeMB / sample.totalMB <= thresholds.freeRatioFloor) {
    return true
  }
  return false
}
