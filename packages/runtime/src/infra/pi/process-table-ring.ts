/**
 * 进程表采样环（signal-forensics 的采样原语半边，2026-10-13 01a132f3 外部 SIGTERM
 * 事故的归因面）。
 *
 * 职责：以固定间隔枚举全进程表（`ps -axo pid=,ppid=,command=`）并维持有界滚动历史，
 * 供 signal-forensics 在受管 pi 意外退出时 diff 出候选信号发送方。采样侧与取证侧
 * 拆两个文件：采样是无策略的 OS 原语（ps 执行体 + 环缓冲），取证是策略（分类/记录/
 * 落盘）——两边演化节奏不同（如未来接入 /proc 或换枚举方式只动本文件）。
 *
 * ps 执行体本地持有、不与 services/reap-orphan-pi 共享：那边的枚举是误杀安全面
 * （ppid=1 + argv 四条合取），两边语义与失败处置各异，跨层共享执行体只会互相绑死；
 * 解析各自持有 ~8 行同构逻辑，刻意重复。
 *
 * 失败语义（best-effort，宁漏不误报）：ps 失败跳过本次采样并累计 failures（仅计数
 * 不刷屏）；上一次采样未回不重叠（防 ps 卡死时定时器叠加）；本模块不向任何进程发
 * 信号，纯读。
 */
import { execFile } from 'node:child_process'

import { buildOutboundChildEnv } from '../spawn-env.js'

/** 采样环默认间隔（ms）。1.5s 与 get_session_stats 轮询粒度同量级，代价可吸收。 */
const DEFAULT_INTERVAL_MS = 1_500
/** 采样环默认容量（样本数）。40 × 1.5s ≈ 60s 历史。 */
const DEFAULT_CAPACITY = 40
/** env 覆盖键（0 = 关闭采样环；取证退化为仅死亡即时快照）。 */
const ENV_INTERVAL_MS = 'TAIJI_SIGNAL_WATCH_INTERVAL_MS'
const ENV_CAPACITY = 'TAIJI_SIGNAL_WATCH_CAPACITY'

// ─────────────────────────────────────────────────────────────────────────────
// ps 解析与执行体
// ─────────────────────────────────────────────────────────────────────────────

/** ps 单行：pid + ppid + command（command 含空格原样保留）。 */
export interface ProcessRow { // oe-exempt:20261014:framework:ps 采样行数据模型（采样器与取证 diff 共用的单一进程表面契约）
  pid: number
  ppid: number
  command: string
}

/** ps 行正则（`列名=` 抑制表头后的数据行；非数字行自然不匹配被跳过）。 */
const PS_ROW_RE = /^(\d+)\s+(\d+)\s+(.+)$/

/** 解析 `ps -axo pid=,ppid=,command=` 输出为进程行（macOS/Linux 通用）。 */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(PS_ROW_RE)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] })
  }
  return rows
}

/** ps 全量枚举（execFile 不经 shell，对齐 reap-orphan-pi 惯例）。 */
export function listAllProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', env: buildOutboundChildEnv({ parentEnv: process.env }) }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/**
 * 读进程启动时刻（epoch ms）；ps 失败/目标不存在/解析失败返回 null（防线尽力而为）。
 * 与 reap-orphan-pi 的 pid 复用复验探针同语义，signal-forensics 用于候选发送方的
 * 「生灭时刻」补采。
 */
export function readProcessStartTime(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: buildOutboundChildEnv({ parentEnv: process.env }) }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      const parsed = Date.parse(String(stdout).trim())
      resolve(Number.isNaN(parsed) ? null : parsed)
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 滚动进程表环
// ─────────────────────────────────────────────────────────────────────────────

/** 环内一帧样本：时刻 + pid → 进程行索引（diff 用 Map，O(1) 反查）。 */
export interface RingSample { // oe-exempt:20261014:framework:环缓冲样本数据模型（有界环的单一数据契约）
  at: number
  rows: ReadonlyMap<number, ProcessRow>
}

export interface ProcessTableRingOptions { // oe-exempt:20261014:framework:构造 options 注入面（间隔/容量/env 覆盖，测试注入用，单实现常态）
  /** 采样间隔（ms）；0 = 禁用采样环（start 为 no-op）。env TAIJI_SIGNAL_WATCH_INTERVAL_MS 可调。 */
  intervalMs?: number
  /** 环容量（样本数；超出丢最旧）。env TAIJI_SIGNAL_WATCH_CAPACITY 可调。 */
  capacity?: number
  /** 进程枚举注入（测试替身）；缺省真实执行 ps。 */
  listProcesses?: () => Promise<string>
  /** 时钟注入（测试替身）；缺省 Date.now。 */
  now?: () => number
}

/** env 整数读取（非法/缺失回落缺省；负值视同非法）。 */
function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * 有界滚动进程表环。生命周期由 ProcessManager 驱动：首个受管 pi spawn 前 start()，
 * 受管 pi 清零（全部 destroy / destroyAll）时 stop()——采样成本只发生在「有 pi 在跑」
 * 的窗口内，空闲 runtime 零开销。
 *
 * 定时器 unref（不持事件循环）；stop 不清样本（死亡转储在 stop 后仍可消费历史）。
 */
export class ProcessTableRing {
  private readonly samples: RingSample[] = []
  private readonly intervalMs: number
  private readonly capacity: number
  private readonly listProcesses: () => Promise<string>
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  /** 上一次 sample() 未回标志（防 ps 卡死时定时器叠加）。 */
  private inFlight = false
  /** 连续 ps 失败次数（诊断面；任一成功采样清零）。 */
  private failureCount = 0

  constructor(opts: ProcessTableRingOptions = {}) {
    this.intervalMs = opts.intervalMs ?? readEnvInt(ENV_INTERVAL_MS, DEFAULT_INTERVAL_MS)
    this.capacity = Math.max(1, opts.capacity ?? readEnvInt(ENV_CAPACITY, DEFAULT_CAPACITY))
    this.listProcesses = opts.listProcesses ?? listAllProcesses
    this.now = opts.now ?? Date.now
  }

  /** 当前样本数。 */
  get size(): number {
    return this.samples.length
  }

  /** 采样定时器是否在转。 */
  get running(): boolean {
    return this.timer !== null
  }

  /** 连续失败次数（观测面；成功即清零）。 */
  get failures(): number {
    return this.failureCount
  }

  /** 采样间隔（ms）；0 = 已禁用。 */
  get interval(): number {
    return this.intervalMs
  }

  /** 注入一帧原始 ps 输出（测试/一次性采样入口；解析异常由调用方处置）。 */
  push(stdout: string, at: number = this.now()): void {
    const rows = parseProcessTable(stdout)
    this.samples.push({ at, rows: new Map(rows.map(r => [r.pid, r])) })
    while (this.samples.length > this.capacity) this.samples.shift()
    this.failureCount = 0
  }

  /** 采一帧（listProcesses 失败/在途重叠时返回 false，绝不抛）。 */
  async sample(): Promise<boolean> {
    if (this.inFlight) return false
    this.inFlight = true
    try {
      this.push(await this.listProcesses())
      return true
    } catch {
      this.failureCount += 1
      return false
    } finally {
      this.inFlight = false
    }
  }

  /** 启动采样（幂等；intervalMs=0 时 no-op = 机制关闭）。启动即采一帧，缩短空窗。 */
  start(): void {
    if (this.timer !== null || this.intervalMs <= 0) return
    this.timer = setInterval(() => {
      void this.sample()
    }, this.intervalMs)
    // unref：采样定时器不得成为 runtime 事件循环的保活项（shutdown 链不等它）
    this.timer.unref?.()
    void this.sample()
  }

  /** 停止采样（幂等；样本保留供死亡转储消费）。 */
  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** 窗口内样本（[fromAt, toAt] 闭区间）的同步副本——stop 后/并发 push 下消费安全。 */
  samplesInWindow(fromAt: number, toAt: number): RingSample[] {
    return this.samples
      .filter(s => s.at >= fromAt && s.at <= toAt)
      .map(s => ({ at: s.at, rows: new Map(s.rows) }))
  }
}
