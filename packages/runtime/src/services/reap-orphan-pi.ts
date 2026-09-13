/**
 * 孤儿 pi 进程收殓（docs/architecture/integrity-hardening.md §3.4 D4a/D4b，修 M6 / G4；
 * 判据 v2：方案 B 布局对齐后的 spawn 清单四条合取，设计 2026-09-10 §6.12 / 实施计划 U17）。
 *
 * 背景：runtime 被 SIGKILL/OOM 后，它 spawn 的 pi 子进程与 supervisor 拉起的新 runtime
 * 不再是父子关系，无人回收——挂住的 pi 持有 API key、长 turn 继续烧 token（失败模式 F）。
 * pi 自身的 stdin-EOF 自杀链有两个挂起点（dispose handler 串行 await 无超时 /
 * flushRawStdout 遇 EPIPE throw 跳过 exit），均在 pi 源码侧、xyz 不可修，因此需要不依赖
 * 父进程存活的自救兜底：新 runtime 启动后延迟数秒（调用方控制，见
 * startup-background-init.ts 的 5s 定时器）扫描并回收残留 pi。
 *
 * 孤儿判据沿革（argv，跨平台统一）：
 * - env 判据（PI_CODING_AGENT_DIR，D4a 原案）被本机探针在案否决：macOS 的 `ps eww` 与
 *   `launchctl procinfo` 均因 SIP 拿不到其他进程的 env（Linux 才有 /proc/<pid>/environ
 *   可用），env 判据无法跨平台——已死，不重开。
 * - v1 argv 判据「--session-dir 值 ≡ getSessionsDir() 精确相等」已死：方案 B（数据布局
 *   完整对齐 pi 0.84.x 默认布局，设计 §6.10-§6.12）删除了 --session-dir argv（pi 走
 *   默认派生），v1 判据失去判别位。
 * - v2（现行）= 四条合取，缺一不可（实现见 matchesOwnPiArgv / findOrphanPiRows）：
 *   ① `--mode rpc`（防误杀用户手跑的交互式 pi）；
 *   ② argv 含 `--no-extensions`——主判别位：xyz spawn 恒带（pi-rpc
 *      buildPiMainAgentArgs 首行，U1 收敛后 rpc-client 经公共包构造），用户裸 pi 与
 *      AGENTS.md 实测命令模板均不带，机器可判的硬分界；
 *   ③ argv 中任一 `--extension`/`--skill` 值与 spawn 清单中某项精确相等。清单 =
 *      `<dataDir>/run/pi-spawn-markers.json`（写侧 spawn-markers.ts，每次 spawn 全量
 *      覆盖写，仅登记 xyz staged 专属路径；用户配置来源 ~/.pi/、项目 .pi/、~/.agents/
 *      一律不进清单——登记它们 = 为误杀用户进程开门，v5 原案被活体证据否决）；
 *   ④ ppid === 1（防线②，见下）。
 *
 * 原理性极限（设计 §6.12 已声明接受）：四条合取全部是 argv/ppid 可观测量的函数，等价类
 * = 「与 xyz spawn 同形的 argv」。用户排障时从 ps 完整复制 xyz pi 的 argv 重跑并孤儿化，
 * 与真孤儿在判据维度完全同形，原理上不可区分——接受该极限，不为此加机制。
 *
 * 误杀三重防线（D4b，缺一不可）：
 * ① 判据 v2 四条合取（上）；值匹配只走 === 整 token 比较，禁止子串/前缀命中
 *   （/a/b 不得匹配 /a/bc）；
 * ② ppid === 1（reparent 证据，跨实例保护的关键防线）。xyz 直接 spawn pi、无 wrapper，
 *   父 runtime 活着时 pi 的 ppid 恒等于该 runtime pid；父死后内核把孤儿 reparent 到
 *   init/launchd（pid 1）。因此「argv 匹配 + ppid=1」= 原父已死 = 真孤儿。为什么不用
 *   「ppid ≠ 本 runtime pid」排除法：dev 自动隔离 userData 与数据目录（main.ts dev 分支
 *   setPath，XYZ_AGENT_DATA_DIR 缺省 ~/.xyz-agent-dev），dev/prod 默认并存已天然不同
 *   目录；跨实例误杀的真实场景是 XYZ_AGENT_DATA_DIR 显式指向同一目录双开，该场景下
 *   两实例可同时合法并存，对方的活跃 pi（ppid=对方 runtime pid）必须不杀（本机实测
 *   形态：打包版 runtime 40842 名下 3 个活跃 pi，ppid=40842）。已知边界：Linux
 *   subreaper 场景（用户级 systemd 等）孤儿 reparent 到 subreaper 而非 1，此时漏收
 *   （fail-safe 方向，宁漏不误杀）。
 * ③ Electron 单实例锁（W0 已落地 requestSingleInstanceLock）：只排除同 userData 的
 *   第二实例；dev/prod userData 不同、并存合法，「另一合法实例的 pi」由防线②的
 *   ppid=1 判据保护，单实例锁不承担该职责。
 *
 * 收殓范围变化（方案 B 显式声明，设计 §6.12）：v1 判据下孤儿 subagent/relay pi 不被
 * 收殓（其 --session-dir 指向 subagents/… ≠ 主 session 目录）；v2 下 subagent/relay pi
 * 由 mirrorFlags 镜像主进程的 staged --extension 与 --no-extensions（session-runner.ts +
 * argv-mirror.ts，数据源是主 pi 进程的 process.argv——subagent 由主 pi 进程内的
 * extension spawn，其父是主 pi）→ 四条合取①②③全过，开始被收殓。方向是修复 v1 漏收
 * （孤儿 subagent 同样烧 token），属预期改进。活跃 subagent 的 ppid = 主 pi pid（非
 * runtime pid），不满足④，不受影响。孤儿 subagent 的收殓时序是两轮：主 pi 先被收殓/
 * 死亡 → subagent reparent 到 ppid=1 → 下一轮 reap 收。
 *
 * 清单缺失 fail-safe（宁漏不误杀，方向对齐 D4b）：清单文件缺失/读不到/坏 JSON → 跳过
 * 本轮收殓并记日志。清单读取经组合根注入（readSpawnMarkers，D6c port 纪律——清单文件
 * io 归 infra/spawn-markers.ts 读写两侧 SSOT，services 层不 import infra），注入函数
 * 返回 null 即触发本降级。写侧每次 spawn 全量覆盖写、mandatory 18 包恒传保证清单常态
 * 存在且非空（§11.11）；本降级只覆盖异常态（首启前 / 磁盘故障 / 人为删除）。
 *
 * 处置：SIGTERM → 宽限（默认 2s，对齐 destroy 链 KILL_TIMEOUT_MS 惯例）→ 仍活则
 * SIGKILL；每条记日志，失败仅记日志不抛（收殓是 best-effort 兜底，不允许阻塞或击穿
 * 启动）。幂等：重复执行只是再扫一遍进程表。
 */
import { execFile } from 'node:child_process'
import type { CrashJournalEvent } from '@xyz-agent/shared'
import { getCrashJournal } from '../infra/crash-journal.js'

/**
 * reaped 台账行使用 schema 登记的扩展字段 pid/ppid（偏差 #32③：扩展字段登记 SSOT =
 * shared crash-journal-schema.ts CrashJournalEvent，本地不再重复声明）。设计 D1 矩阵
 * reaped 行验收要求「pid + argv/ppid 判据摘要」可机器消费——pid/ppid 走结构化字段
 * （评估器计数与归因不解析文本），argv 摘要走既有 detailDigest（≤2KB 内嵌，schema 无
 * argv 对应字段）。writer 以 spread 序列化，扩展字段原样落盘 JSONL。
 */

/** ps 枚举超时：全量进程表是毫秒级本地操作，10s 只是无 ps/假死兜底，防启动链悬挂。 */
const PS_TIMEOUT_MS = 10_000

/** SIGTERM 后等 pi 优雅退出的宽限，对齐 rpc-client kill 链的 KILL_TIMEOUT_MS（2s）。 */
export const ORPHAN_KILL_GRACE_MS = 2_000

/**
 * 启动后延迟多久执行收殓（挂载方 startup-background-init.ts 使用）。初值 5s：给 pi
 * stdin-EOF 自杀链留优雅退出时间（设计 D4a ⛔实施期门：宽限值待 S6 真机实测调整）。
 */
export const ORPHAN_REAP_DELAY_MS = 5_000

/** ps 单行解析结果（`ps -axo pid=,ppid=,command=` 的一行）。 */
export interface PsRow {
  pid: number
  ppid: number
  /** command 列原始文本（argv 空白连接，个别环境可能保留引号形态）。 */
  command: string
}

/**
 * 解析 `ps -axo pid=,ppid=,command=` 输出（macOS/Linux 通用，`列名=` 抑制表头）。
 * 非数字 pid/ppid 的行（空行、异常输出）跳过——fail-open 只影响扫描覆盖面，不影响精确性。
 */
export function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] })
  }
  return rows
}

/**
 * 引号感知的 argv 分词（纯函数）。
 *
 * 真实 macOS/Linux ps 的 command 列不保留引号、只用空格连接，但测试与个别环境会以
 * 带引号形态呈现——分词按 POSIX 近似规则处理（引号内空格不分词，引号本身剥离）。
 * 真实 ps 不加引号时含空格的路径会被拆碎：v2 判据③要求值级精确相等，拆碎即不匹配，
 * 该进程漏收（fail-safe 方向 = 宁漏不误杀，v1 的尾部整串兜底随 --session-dir 判据
 * 一并退役——xyz argv 里 --extension/--skill 不处尾部，兜底无对应物）。
 *
 * 实现为单字符状态机（consumeArgvChar 转移 + flushArgvToken 截断）。
 */
export function tokenizeArgv(command: string): string[] {
  const st: ArgvTokenizerState = { tokens: [], cur: '', quote: null, hasToken: false }
  for (const ch of command) {
    consumeArgvChar(st, ch)
  }
  flushArgvToken(st)
  return st.tokens
}

/** argv 分词状态机的可变态（tokenizeArgv 局部持有，转移逻辑拆到 consumeArgvChar）。 */
interface ArgvTokenizerState {
  tokens: string[]
  cur: string
  quote: '"' | "'" | null
  hasToken: boolean
}

/** 截断当前 token（hasToken 时入列并复位累积态；连续空白不多产空 token）。 */
function flushArgvToken(st: ArgvTokenizerState): void {
  if (st.hasToken) {
    st.tokens.push(st.cur)
    st.cur = ''
    st.hasToken = false
  }
}

/** 单字符状态转移：引号内累积 / 引号开闭 / 空白截断 / 普通字符累积。 */
function consumeArgvChar(st: ArgvTokenizerState, ch: string): void {
  if (st.quote !== null) {
    // 引号内：同款引号闭合，其余字符（含空白）原样累积
    if (ch === st.quote) st.quote = null
    else st.cur += ch
    return
  }
  if (ch === '"' || ch === "'") {
    st.quote = ch
    st.hasToken = true
    return
  }
  if (ch === ' ' || ch === '\t') {
    flushArgvToken(st)
    return
  }
  st.cur += ch
  st.hasToken = true
}

/**
 * 收集 flag 的全部值（`--flag value` 与 `--flag=value` 两形态，全 argv 扫描、顺序无关）。
 * spawn 的 argv 可重复传同一 flag（`--extension p1 --extension p2 …`，pi-rpc
 * appendSkillArgs / appendExtensionArgs 逐路径 push），判据③「任一值 ∈ 清单」必须遍历全部出现。
 */
function collectFlagValues(tokens: string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === flag) {
      if (tokens[i + 1] !== undefined) values.push(tokens[i + 1])
    } else if (tokens[i].startsWith(flag + '=')) {
      values.push(tokens[i].slice(flag.length + 1))
    }
  }
  return values
}

/** 取 flag 第一个值（collectFlagValues 薄包装，单值语义消费点：--mode）。 */
function flagValue(tokens: string[], flag: string): string | null {
  return collectFlagValues(tokens, flag)[0] ?? null
}

/** 参与清单匹配的两个值承载 flag（pi-rpc appendSkillArgs / appendExtensionArgs 的注入段）。 */
const MARKER_FLAGS = ['--extension', '--skill'] as const

/**
 * 判定 ps 行是否「xyz spawn 的 pi RPC 进程」——判据 v2 四条合取的前三条（第四条
 * ppid===1 在 findOrphanPiRows）：
 *
 * ① `--mode rpc`：必要条件——用户在终端手工跑的交互式 pi 不带它，没有这条会误杀
 *   用户自己的调试进程；
 * ② argv 含独立 token `--no-extensions`（主判别位）：xyz spawn 恒带（pi-rpc
 *   buildPiMainAgentArgs 首行），用户裸 pi / AGENTS.md 实测命令模板不带。boolean
 *   flag 只判 token 存在性（精确整
 *   token，`--no-extensions-x` 之类前缀延伸不算）；
 * ③ 任一 `--extension`/`--skill` 值与 markerPaths 中某项【精确相等】（=== 整串，禁
 *   子串/前缀：/a/b 不得匹配 /a/bc）。空清单恒 false（防御：调用方在清单缺失时已
 *   跳过收殓，此处不依赖该前置）。
 */
export function matchesOwnPiArgv(row: PsRow, markerPaths: readonly string[]): boolean {
  const tokens = tokenizeArgv(row.command)
  if (flagValue(tokens, '--mode') !== 'rpc') return false
  if (!tokens.includes('--no-extensions')) return false
  if (markerPaths.length === 0) return false
  const markers = new Set(markerPaths)
  return MARKER_FLAGS.some(flag => collectFlagValues(tokens, flag).some(v => markers.has(v)))
}

/** init/launchd 的 pid——内核 reparent 孤儿的默认归宿（macOS launchd / Linux systemd）。 */
const INIT_PID = 1

/**
 * 从 ps 行集合筛出可处置孤儿：判据 v2（防线①，matchesOwnPiArgv 四条合取前三条）且
 * ppid=1（防线②，reparent 证据：原父 runtime 已死）。pid/ppid 等于 ownPid 的行一并
 * 排除——正常场景 runtime pid ≠ 1，该检查恒被 ppid=1 蕴含，仅为 pid namespace 容器内
 * runtime 自身即 pid 1 的异形兜底。返回 PsRow（含 command 供日志摘要）而非裸 pid。
 */
export function findOrphanPiRows(rows: PsRow[], markerPaths: readonly string[], ownPid: number): PsRow[] {
  return rows.filter(
    r => r.pid !== ownPid && r.ppid !== ownPid && r.ppid === INIT_PID && matchesOwnPiArgv(r, markerPaths),
  )
}

export interface ReapOrphanOptions {
  /**
   * 本实例数据目录（getDataDir()）——spawn 清单 <dataDir>/run/pi-spawn-markers.json 的
   * 读取根与收殓日志标识。u17 改名自 sessionsDir：v1 判据的 --session-dir 等值目标已随
   * 方案 B 消亡。
   */
  dataDir: string
  /** 本 runtime 进程 pid（排除其活跃子进程，防线②）。 */
  ownPid: number
  /** SIGTERM→SIGKILL 宽限 ms，默认 ORPHAN_KILL_GRACE_MS。 */
  killGraceMs?: number
  /**
   * 杀链决策日志的「谁触发」（crash-resilience §3.3 D6-⑥，E2 归因缺口修复）：
   * 调用方自述（如 'startup-sweep'）。可选，缺省 'unspecified'——不强制改动既有
   * 调用方（startup-background-init），新调用方应显式传入。
   */
  trigger?: string
  /** 进程枚举注入（测试替身）；缺省真实执行 ps。返回 ps stdout 原文。 */
  listProcesses?: () => Promise<string>
  /** 信号注入（测试替身）；缺省 process.kill。signal 0 = 仅探活不实际发信号。 */
  signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => void
  /** 延时注入（测试替身，避免真实等待宽限）。 */
  delay?: (ms: number) => Promise<void>
  /**
   * spawn 清单读取（必填，D6c port 纪律）：组合根注入 infra/spawn-markers 的
   * readSpawnMarkerList(getDataDir()) 闭包，测试注入替身。返回 null = 清单缺失/读不到/
   * 坏 JSON/格式坏（原因已由 infra 读侧记 warn 日志）→ 本轮跳过收殓（宁漏不误杀）。
   */
  readSpawnMarkers: () => string[] | null
}

export interface ReapOrphanResult {
  /** 扫描到的进程行数（诊断用）。 */
  scanned: number
  /** 成功回收（SIGTERM 退出 / 已自行退出 / SIGKILL 兜底）的孤儿 pid。 */
  reaped: number[]
  /** 处置失败的孤儿 pid（仅日志，不抛）。 */
  failed: number[]
  /** 平台不支持（Windows / ps 不可用）时为 true——已知边界，非错误。 */
  unsupported: boolean
}

/** ESRCH = 目标 pid 不存在（扫描到处置之间自行退出，或探活确认已死）。 */
function isProcessGone(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ESRCH'
}

/** argv 日志摘要截断长度：防 ps 极端长 command 刷屏，保留头部（pi 路径 + --mode rpc 可辨识）。 */
const ARGV_SUMMARY_MAX = 200

/** argv 摘要：截断防 ps 极端长 command 刷屏，保留头部（pi 路径 + --mode rpc 可辨识）。 */
function argvSummary(command: string): string {
  return command.length > ARGV_SUMMARY_MAX ? command.slice(0, ARGV_SUMMARY_MAX) + '…' : command
}

function defaultListProcesses(): Promise<string> {
  // -axo 全量进程；列名后缀 `=` 抑制表头；输出走 pipe（非 TTY）时 command 列不按
  // 终端宽度截断。数组参数经 execFile 不经 shell（对齐 git-executor 惯例）。
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,command='],
      { encoding: 'utf8', timeout: PS_TIMEOUT_MS },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      },
    )
  })
}

function defaultSignal(pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0): void {
  process.kill(pid, signal)
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/**
 * 执行一次孤儿收殓：枚举 → 读清单 → 筛选 → 逐个 SIGTERM → 宽限 → 仍活则 SIGKILL。
 * 清单缺失/坏（readSpawnMarkers 返回 null）→ 跳过本轮（fail-safe，宁漏不误杀）。
 * 本函数不抛（全路径 catch 或降级返回），调用方可安全 fire-and-forget。
 */
export async function reapOrphanPiProcesses(options: ReapOrphanOptions): Promise<ReapOrphanResult> {
  const { dataDir, ownPid, readSpawnMarkers } = options
  const killGraceMs = options.killGraceMs ?? ORPHAN_KILL_GRACE_MS
  const listProcesses = options.listProcesses ?? defaultListProcesses
  const signal = options.signal ?? defaultSignal
  const delay = options.delay ?? defaultDelay

  const result: ReapOrphanResult = { scanned: 0, reaped: [], failed: [], unsupported: false }

  // 平台边界：Windows 无 ps（也无 /proc）。降级为单条 warn 的已知边界，不阻塞启动。
  if (process.platform === 'win32') {
    console.warn('[orphan-reap] platform does not support orphan pi reaping (no ps on Windows); known limitation, skipped')
    result.unsupported = true
    return result
  }

  let stdout: string
  try {
    stdout = await listProcesses()
  } catch (e) {
    // ps 缺失/不可执行：与 Windows 同级的已知边界，warn 一次即返回（不重试、不上抛）。
    console.warn('[orphan-reap] process enumeration unavailable, orphan pi reaping skipped (known limitation):', e instanceof Error ? e.message : e)
    result.unsupported = true
    return result
  }

  const rows = parsePsOutput(stdout)
  result.scanned = rows.length
  // 清单缺失/读不到/坏 JSON → 跳过本轮收殓（原因已由注入的读侧——infra readSpawnMarkerList
  // 记 warn 日志；fail-safe 方向 = 宁漏不误杀，绝不回到无清单的宽匹配）。
  const markerPaths = readSpawnMarkers()
  if (markerPaths === null) return result
  const orphans = findOrphanPiRows(rows, markerPaths, ownPid)
  if (orphans.length === 0) return result

  // D5①（session-dead-structural-fixes）：kill 路径全量日志 K7——收殓决策点升级 warn 含
  // 调用源与信号链（下各 pid 级明细 log 保持既有粒度不动）；u17 后判据为 spawn markers，
  // 清单条目数与数据目录一并记入。
  console.warn(`[orphan-reap] found ${orphans.length} orphan pi process(es) matching spawn markers (${markerPaths.length} entries, dataDir=${dataDir}), reaping (kill_source=reap_orphan | who: runtime startup delayed reap, previous runtime died leaving unparented pi | chain: ps scan -> argv + ppid=1 orphan match -> SIGTERM -> ${killGraceMs}ms grace -> SIGKILL if alive)`)
  // 杀链决策日志（crash-resilience §3.3 D6-⑥，E2 归因缺口的直接修复）：一条结构化
  // 行回答「谁触发 / 杀哪些 pid / 为什么」——动作/目标/原因字段化（console patch 的
  // meta 走 JSON.stringify 单行落盘 runtime 主日志），与下方逐 pid 处置行互为索引。
  console.log('[orphan-reap] kill decision', {
    action: 'reap_orphan_pi',
    trigger: options.trigger ?? 'unspecified',
    scanned: result.scanned,
    targets: orphans.map(r => ({ pid: r.pid, ppid: r.ppid })),
    reason: 'argv matches spawn marker list (--mode rpc + --no-extensions + staged extension/skill value) AND ppid=1 (parent runtime dead, orphan reparented to init)',
    graceMs: killGraceMs,
  })
  for (const row of orphans) {
    const ok = await killOrphan(row, killGraceMs, signal, delay)
    if (ok) {
      result.reaped.push(row.pid)
      // 台账双写（crash-forensics §3.3 D1 reaped 行：杀链判据命中处置成功处，与既有
      // 逐 pid 处置日志同点）。挂在 ok 分支而非发现处：事件名语义 = 已收殓，处置失败
      // 进 failed 不记 reaped（防误记）。best-effort：writer append 自吞错不向收殓链传播。
      // 经中间变量传入（扩展字段过 schema 闭接口的 excess property check）。
      const journalEvent: CrashJournalEvent = {
        layer: 'pi',
        event: 'reaped',
        pid: row.pid,
        ppid: row.ppid,
        detailDigest: `argv matches spawn marker list (--mode rpc + --no-extensions + staged extension/skill value) AND ppid=1; argv: ${argvSummary(row.command)}`,
      }
      getCrashJournal().append(journalEvent)
    } else {
      result.failed.push(row.pid)
    }
  }
  // 收殓结果汇总（D6-⑥ 配套：决策 → 结果闭环，failed 非空时归因有据）
  console.log('[orphan-reap] reap result', {
    action: 'reap_orphan_pi_result',
    trigger: options.trigger ?? 'unspecified',
    reaped: result.reaped,
    failed: result.failed,
  })
  return result
}

/** 单个孤儿的处置序列。返回 false = 处置失败（调用方记入 failed，仅日志不抛）。 */
async function killOrphan(
  row: PsRow,
  killGraceMs: number,
  signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => void,
  delay: (ms: number) => Promise<void>,
): Promise<boolean> {
  const summary = argvSummary(row.command)
  try {
    signal(row.pid, 'SIGTERM')
  } catch (e) {
    if (isProcessGone(e)) {
      // 扫描到处置之间已自行退出（stdin-EOF 自杀链赶到前面）——按已回收计，幂等。
      console.log(`[orphan-reap] reaped orphan pi pid=${row.pid} (exited before SIGTERM) ${summary}`)
      return true
    }
    console.warn(`[orphan-reap] SIGTERM failed for orphan pi pid=${row.pid}:`, e instanceof Error ? e.message : e)
    return false
  }

  await delay(killGraceMs)

  // 宽限后探活：signal 0 只验证存在性不实际发信号。EPERM 等其他错误按「活着」处理
  // （走 SIGKILL 兜底，宁可多一发强杀信号也不漏收）。
  let alive = true
  try {
    signal(row.pid, 0)
  } catch (e) {
    if (isProcessGone(e)) alive = false
  }
  if (!alive) {
    console.log(`[orphan-reap] reaped orphan pi pid=${row.pid} (SIGTERM) ${summary}`)
    return true
  }

  try {
    signal(row.pid, 'SIGKILL')
    console.log(`[orphan-reap] reaped orphan pi pid=${row.pid} (SIGKILL after ${killGraceMs}ms grace) ${summary}`)
    return true
  } catch (e) {
    if (isProcessGone(e)) {
      console.log(`[orphan-reap] reaped orphan pi pid=${row.pid} (exited during grace) ${summary}`)
      return true
    }
    console.warn(`[orphan-reap] SIGKILL failed for orphan pi pid=${row.pid}:`, e instanceof Error ? e.message : e)
    return false
  }
}
