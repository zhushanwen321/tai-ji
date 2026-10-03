/**
 * 孤儿 pi 进程收殓（docs/architecture/integrity-hardening.md §3.4 D4a/D4b，修 M6 / G4；
 * 判据 v2：方案 B 布局对齐后的 spawn 清单四条合取，设计 2026-09-10 §6.12 / 实施计划 U17）。
 *
 * 背景：runtime 被 SIGKILL/OOM 后，它 spawn 的 pi 子进程与 supervisor 拉起的新 runtime
 * 不再是父子关系，无人回收——挂住的 pi 持有 API key、长 turn 继续烧 token（失败模式 F）。
 * pi 自身的 stdin-EOF 自杀链有两个挂起点（dispose handler 串行 await 无超时 /
 * flushRawStdout 遇 EPIPE throw 跳过 exit），均在 pi 源码侧、taiji 不可修，因此需要不依赖
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
 *   ② argv 含 `--no-extensions`——主判别位：taiji spawn 恒带（pi-rpc
 *      buildPiMainAgentArgs 首行，U1 收敛后 rpc-client 经公共包构造），用户裸 pi 与
 *      AGENTS.md 实测命令模板均不带，机器可判的硬分界；
 *   ③ argv 中任一 `--extension`/`--skill` 值与 spawn 清单中某项精确相等。清单 =
 *      `<dataDir>/run/pi-spawn-markers.json`（写侧 spawn-markers.ts，每次 spawn 全量
 *      覆盖写，仅登记 taiji staged 专属路径；用户配置来源 ~/.pi/、项目 .pi/、~/.agents/
 *      一律不进清单——登记它们 = 为误杀用户进程开门，v5 原案被活体证据否决）；
 *   ④ ppid === 1（防线②，见下）。
 *
 * 原理性极限（设计 §6.12 已声明接受）：四条合取全部是 argv/ppid 可观测量的函数，等价类
 * = 「与 taiji spawn 同形的 argv」。用户排障时从 ps 完整复制 taiji pi 的 argv 重跑并孤儿化，
 * 与真孤儿在判据维度完全同形，原理上不可区分——接受该极限，不为此加机制。
 *
 * 误杀三重防线（D4b，缺一不可）：
 * ① 判据 v2 四条合取（上）；值匹配只走 === 整 token 比较，禁止子串/前缀命中
 *   （/a/b 不得匹配 /a/bc）；
 * ② ppid === 1（reparent 证据，跨实例保护的关键防线）。taiji 直接 spawn pi、无 wrapper，
 *   父 runtime 活着时 pi 的 ppid 恒等于该 runtime pid；父死后内核把孤儿 reparent 到
 *   init/launchd（pid 1）。因此「argv 匹配 + ppid=1」= 原父已死 = 真孤儿。为什么不用
 *   「ppid ≠ 本 runtime pid」排除法：dev 自动隔离 userData 与数据目录（main.ts dev 分支
 *   setPath，TAIJI_AGENT_DATA_DIR 缺省 ~/.taiji-dev），dev/prod 默认并存已天然不同
 *   目录；跨实例误杀的真实场景是 TAIJI_AGENT_DATA_DIR 显式指向同一目录双开，该场景下
 *   两实例可同时合法并存，对方的活跃 pi（ppid=对方 runtime pid）必须不杀（本机实测
 *   形态：打包版 runtime 40842 名下 3 个活跃 pi，ppid=40842）。已知边界：Linux
 *   subreaper 场景（用户级 systemd 等）孤儿 reparent 到 subreaper 而非 1，此时漏收
 *   （fail-safe 方向，宁漏不误杀）。
 * ③ Electron 单实例锁（W0 已落地 requestSingleInstanceLock）：只排除同 userData 的
 *   第二实例；dev/prod userData 不同、并存合法，「另一合法实例的 pi」由防线②的
 *   ppid=1 判据保护，单实例锁不承担该职责。
 *
 * 收殓范围（方案 B 显式声明，设计 §6.12）：v1 判据下孤儿 subagent/relay pi 不被
 * 收殓（其 --session-dir 指向 subagents/… ≠ 主 session 目录）；v2 下 subagent/relay pi
 * 的 argv 由 pi-subagent-cli buildSpawnArgs 构造——恒定 --no-extensions 基座 +
 * --extension 白名单集（宿主自主 pi argv 的 staged 集按 structured-output 白名单收窄，
 * 经 wire ctx.extensionPaths 下发，structured-output 属 mandatory builtin 恒在 staged
 * 集即恒在清单；relay 路径同 argv 经握手帧交 runtime 受托 spawn）→ 四条合取①②③
 * 全过，开始被收殓。方向是修复 v1 漏收（孤儿 subagent 同样烧 token），属预期改进。
 * 活跃 subagent/relay pi 的 ppid ≠ 1（直spawn 形态父为引擎 CLI 进程、relay 受托形态
 * 父为 runtime），不满足④，不受影响。孤儿收殓时序：pi 的直接父进程退出使其 reparent
 * 到 ppid=1 后，下一轮 reap 收。
 *
 * 清单缺失 fail-safe（宁漏不误杀，方向对齐 D4b）：清单文件缺失/读不到/坏 JSON → 跳过
 * 本轮收殓并记日志。清单读取经组合根注入（readSpawnMarkers，D6c port 纪律——清单文件
 * io 归 infra/spawn-markers.ts 读写两侧 SSOT，services 层不 import infra），注入函数
 * 返回 null 即触发本降级。写侧每次 spawn 全量覆盖写、mandatory builtin 恒传保证清单常态
 * 存在且非空（§11.11）；本降级只覆盖异常态（首启前 / 磁盘故障 / 人为删除）。
 *
 * 处置：SIGTERM → 宽限（默认 2s，对齐 destroy 链 KILL_TIMEOUT_MS 惯例）→ 仍活则
 * SIGKILL；每条记日志，失败仅记日志 + 崩溃台账 reap-failed 事件不抛（收殓是 best-effort
 * 兜底，不允许阻塞或击穿启动）。幂等：重复执行只是再扫一遍进程表。
 *
 * 后代顺链清理（孤儿 shell 收口，2026-10）：孤儿 pi 名下挂着前台 bash（pi bash 工具
 * spawn，SIGTERM pi 时其 handler 只能清 tracked 在册者；pi 已被 SIGKILL/挂起时全部
 * 无人认领）与 detached 后台任务（sh，unref 故意脱离 pi 生命周期）——只杀 pi 本体
 * 会把整棵 shell 子树留成永久孤儿（收割判据只认 pi argv，shell 进程永远不匹配）。
 * 因此处置每个孤儿前先 pgrep -P BFS 快照其后代树（必须在 SIGTERM 前采集：pi 死后
 * 后代 reparent 到 1，树形即失——对齐 process-control stopRuntimeProcess 的 T0
 * 快照不变量），SIGTERM pi（让 pi 自身 handler 先跑优雅清理）→ SIGTERM 后代 →
 * 统一宽限 → pi 补 SIGKILL（含 lstart 复验）→ 幸存后代补 SIGKILL。pi 在 SIGTERM
 * 即已自退（ESRCH）时后代照扫不误——快照在信号前完成，后代仍可处置。残余极限：
 * 快照之后新 spawn 的后代逃逸（与 process-control 同款 T0 竞态，接受）；pi 处置起点
 * 之前已死（快照即空）时其后代早已 reparent 无法顺链，漏收（宁漏不误杀方向）。
 */
import { execFile } from 'node:child_process'
import type { CrashJournalEvent } from '@taiji/shared'
import { getCrashJournal } from '../infra/crash-journal.js'
import { redactArgvLine } from '../infra/pi/argv-redact.js'

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
 * 一并退役——taiji argv 里 --extension/--skill 不处尾部，兜底无对应物）。
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
 * 判定 ps 行是否「taiji spawn 的 pi RPC 进程」——判据 v2 四条合取的前三条（第四条
 * ppid===1 在 findOrphanPiRows）：
 *
 * ① `--mode rpc`：必要条件——用户在终端手工跑的交互式 pi 不带它，没有这条会误杀
 *   用户自己的调试进程；
 * ② argv 含独立 token `--no-extensions`（主判别位）：taiji spawn 恒带（pi-rpc
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
  /**
   * 进程启动时间读取注入（SIGKILL 前 pid 复用复验的防线依赖）；缺省真实执行
   * `ps -p <pid> -o lstart=`。返回 null = ps 不可用/解析失败——防线尽力而为，
   * 调用方按现状继续（不因防线缺席放弃处置）。
   */
  readProcessStartTime?: (pid: number) => Promise<number | null>
  /**
   * 后代枚举注入（孤儿 shell 顺链清扫）；缺省真实执行 pgrep -P BFS。返回空数组 =
   * 无后代/枚举降级（不阻断 pi 本体处置）。调用时序：必须在向 pi 发 SIGTERM 之前——
   * pi 死后后代 reparent 到 1，树形即失（T0 快照不变量）。
   */
  getDescendantPids?: (pid: number) => Promise<number[]>
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
  /**
   * 顺链清理的后代 pid（bash/sh/zsh 等 shell 子树，孤儿 shell 收口）。仅实际清扫过
   * 后代时赋值（空树/降级路径保持 undefined——toEqual 断言兼容既有用例形状）。
   * 只收 SIGKILL **发送成功**的 pid（sweepDescendants 的 swept 收集面）；SIGTERM
   * 阶段的发送不计入（那阶段只起宽限作用，真正收口在补杀 SIGKILL）。
   */
  reapedDescendants?: number[]
}

/** ESRCH = 目标 pid 不存在（扫描到处置之间自行退出，或探活确认已死）。 */
function isProcessGone(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ESRCH'
}

/** argv 日志摘要截断长度：防 ps 极端长 command 刷屏，保留头部（pi 路径 + --mode rpc 可辨识）。 */
const ARGV_SUMMARY_MAX = 200

/**
 * argv 摘要：先经共享脱敏（设计 `mode-system-composer-density` §7.2
 * argv 日志脱敏 / §7.6 写入面 / 探针 P15）再做长度封顶——两处回显（本处与 rpc-client spawn
 * 日志）必须共用同一实现，只堵一条等于没堵。脱敏保留非值 token，故 `--mode rpc` 等诊断串
 * 与 `detailDigest` 既有断言不受影响；提示词 flag 的值只记 `<N chars>`。
 */
function argvSummary(command: string): string {
  return redactArgvLine(command, ARGV_SUMMARY_MAX)
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
 * 读进程启动时间（epoch ms）；ps 失败/目标不存在/解析失败返回 null（防线尽力而为）。
 * 单目标查询是毫秒级本地操作，10s 只是无 ps/假死兜底。SIGKILL 前 pid 复用复验的
 * 数据源（killOrphan 内两时点比对），与 relay-registry 同名私有的探针语义一致。
 */
/** pgrep 缺失只 warn 一次（BFS 每层一次调用，逐层刷屏无意义；缺 pgrep = 后代清扫降级为不扫）。 */
let pgrepMissingWarned = false

/**
 * 查询单个 pid 的直接子进程（pgrep -P，defaultGetDescendantPids 的 BFS 单步）。
 * 退出码 1 = 无子进程（常态，返回空数组）；ENOENT = 无 pgrep（warn 一次）；其余错误
 * warn 后按空数组继续——后代清扫是顺链加固位，任何枚举失败都降级为「不扫」而非失败
 * （宁漏不误杀方向：枚举不到就不杀，绝不放宽目标面）。
 */
async function queryChildPids(pid: number): Promise<number[]> {
  let stdout = ''
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS }, (err, out) => {
        if (err) {
          // pgrep 退出码 1 = 无匹配子进程（常态）——放行为空结果，不进降级分支。
          // execFile 回调错误的 code 运行时是数字退出码（ErrnoException 类型声明为 string，
          // 经 unknown 中转比对）。
          if ((err as NodeJS.ErrnoException).code === (1 as unknown)) {
            resolve('')
            return
          }
          reject(err)
          return
        }
        resolve(String(out ?? ''))
      })
    })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (!pgrepMissingWarned) {
        pgrepMissingWarned = true
        console.warn('[orphan-reap] pgrep not available, descendant sweep disabled (shells under orphan pi will not be reaped)')
      }
      return []
    }
    console.warn(`[orphan-reap] pgrep -P ${pid} failed, descendants of this pi will not be swept:`, e instanceof Error ? e.message : e)
    return []
  }
  return stdout.split('\n').map(l => Number(l.trim())).filter(n => Number.isInteger(n) && n > 0)
}

/**
 * 收集指定 pid 的全部后代（BFS，含 visited 环防护）。必须在向该 pid 发任何信号之前
 * 调用——pi 死后后代 reparent 到 1，父子关系即失（对齐 process-control T0 快照不变量）。
 */
async function defaultGetDescendantPids(rootPid: number): Promise<number[]> {
  const result: number[] = []
  const visited = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const children = await queryChildPids(queue.shift()!)
    for (const c of children) {
      if (visited.has(c)) continue // 环防护：异常 pgrep 输出不至于死循环
      visited.add(c)
      result.push(c)
      queue.push(c)
    }
  }
  return result
}

function defaultReadProcessStartTime(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      const parsed = Date.parse(String(stdout).trim())
      resolve(Number.isNaN(parsed) ? null : parsed)
    })
  })
}

/**
 * 后代快照（首个信号之前，T0 不变量）。枚举失败/无 pgrep → 空表降级：pi 本体处置照旧，
 * 仅 shell 顺链清扫缺席（宁漏不误杀），warn 留痕。
 */
async function snapshotDescendants(
  row: PsRow,
  getDescendantPids: (pid: number) => Promise<number[]>,
): Promise<number[]> {
  try {
    return await getDescendantPids(row.pid)
  } catch (e) {
    console.warn(`[orphan-reap] descendant enumeration failed for pi pid=${row.pid}, shells will not be swept:`, e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * 宽限后探活：signal 0 只验证存在性不实际发信号。EPERM 等其他错误按「活着」处理
 * （走 SIGKILL 兜底，宁可多一发强杀信号也不漏收）。
 */
function probeAliveAfterGrace(
  signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => void,
  pid: number,
): boolean {
  try {
    signal(pid, 0)
    return true
  } catch (e) {
    return !isProcessGone(e)
  }
}

/**
 * 执行一次孤儿收殓：枚举 → 读清单 → 筛选 → 逐个 SIGTERM → 宽限 → 仍活则 SIGKILL。
 * 清单缺失/坏（readSpawnMarkers 返回 null）→ 跳过本轮（fail-safe，宁漏不误杀）。
 * 本函数不抛（全路径 catch 或降级返回），调用方可安全 fire-and-forget。
 */
/** killOrphan 依赖簇（信号面 + 宽限 + 后代枚举），逐 pid 处置循环与主流程解包共享。 */
interface OrphanKillDeps {
  killGraceMs: number
  signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => void
  delay: (ms: number) => Promise<void>
  readProcessStartTime: (pid: number) => Promise<number | null>
  getDescendantPids: (pid: number) => Promise<number[]>
}

/**
 * 依赖解析：注入项缺省回落真实实现（options → OrphanKillDeps + ps 枚举）。`??` 回落链
 * 集中在一个纯函数（复杂度门禁：分支大户与主流程编排解耦），主流程只消费解析结果。
 */
function resolveReapDeps(options: ReapOrphanOptions): OrphanKillDeps & { listProcesses: () => Promise<string> } {
  return {
    killGraceMs: options.killGraceMs ?? ORPHAN_KILL_GRACE_MS,
    listProcesses: options.listProcesses ?? defaultListProcesses,
    signal: options.signal ?? defaultSignal,
    delay: options.delay ?? defaultDelay,
    readProcessStartTime: options.readProcessStartTime ?? defaultReadProcessStartTime,
    getDescendantPids: options.getDescendantPids ?? defaultGetDescendantPids,
  }
}

/**
 * 逐孤儿处置 + 台账双写（crash-forensics §3.3 D1）：SIGTERM → 宽限 → SIGKILL 链
 * 逐 pid 执行（含后代顺链清扫，见文件头「后代顺链清理」段），reaped / reap-failed
 * 两类事件挂处置结果处（事件名语义 = 已收殓 / 处置失败，防误记）。台账 best-effort
 * （writer append 自吞错不向收殓链传播）。返回值含顺链清扫的后代 pid（供结果汇总）。
 */
async function reapOrphansWithJournal(
  orphans: PsRow[],
  deps: OrphanKillDeps,
): Promise<{ reaped: number[]; failed: number[]; reapedDescendants: number[] }> {
  const reaped: number[] = []
  const failed: number[] = []
  const reapedDescendants: number[] = []
  for (const row of orphans) {
    const { ok, descendantsSwept } = await killOrphan(row, deps)
    // 后代清扫结果不分 ok/failed 都收集（shell 收口独立于 pi 本体处置成败），但两
    // 条 failed 子路径的清扫语义不同，观测面必须如实区分：
    // - SIGTERM 硬失败（signal throw 非 ESRCH，如 EPERM）：直接返回空表、**不清扫**
    //   ——pi 尚存活，此时杀其 shell 会留下「pi 还活着、shell 已死」的半处置态；
    // - SIGKILL 硬失败：catch 内已顺链清扫幸存后代（彼时 pi 处置已尽力，shell 收
    //   口照常），reapedDescendants 收到真实清扫集。
    reapedDescendants.push(...descendantsSwept)
    if (ok) {
      reaped.push(row.pid)
      // 台账双写（crash-forensics §3.3 D1 reaped 行：杀链判据命中处置成功处，与既有
      // 逐 pid 处置日志同点）。挂在 ok 分支而非发现处：事件名语义 = 已收殓，处置失败
      // 进 failed 不记 reaped（防误记）。best-effort：writer append 自吞错不向收殓链传播。
      // 经中间变量传入（扩展字段过 schema 闭接口的 excess property check）。
      const journalEvent: CrashJournalEvent = {
        layer: 'pi',
        event: 'reaped',
        pid: row.pid,
        ppid: row.ppid,
        detailDigest: `argv matches spawn marker list (--mode rpc + --no-extensions + staged extension/skill value) AND ppid=1; descendants swept: ${descendantsSwept.length}; argv: ${argvSummary(row.command)}`,
      }
      getCrashJournal().append(journalEvent)
    } else {
      failed.push(row.pid)
      // 台账双写（reap-failed 行，与 reaped 同 schema 同挂点阶段）：处置失败率可机器
      // 对账（评估器按 event 计数），失败原因进 detailDigest。best-effort 同 reaped 行。
      const journalEvent: CrashJournalEvent = {
        layer: 'pi',
        event: 'reap-failed',
        pid: row.pid,
        ppid: row.ppid,
        detailDigest: `orphan matched spawn marker list + ppid=1 but disposal failed (signal error, non-ESRCH); descendants swept: ${descendantsSwept.length}; argv: ${argvSummary(row.command)}`,
      }
      getCrashJournal().append(journalEvent)
    }
  }
  return { reaped, failed, reapedDescendants }
}

export async function reapOrphanPiProcesses(options: ReapOrphanOptions): Promise<ReapOrphanResult> {
  const { dataDir, ownPid, readSpawnMarkers } = options
  const { listProcesses, ...killDeps } = resolveReapDeps(options)
  const { killGraceMs } = killDeps

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
  if (markerPaths.length === 0) {
    // 合法空数组（写侧零 staged 值也写文件）：判据③「任一值 ∈ 清单」对任何 argv 恒
    // false——本轮收殓结构性全局失效。与「文件缺失/坏」（null 路径，读侧已 warn）区分：
    // 清单在但为空通常是最近一次 spawn 的 staged 集为空（或登记规则收窄），须可诊断。
    console.warn('[orphan-reap] spawn marker list is empty — orphan criterion 3 (marker value match) can never hit, reaping is ineffective this run; check the staged extension/skill set of the most recent spawn')
  }
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
  const { reaped, failed, reapedDescendants } = await reapOrphansWithJournal(orphans, killDeps)
  result.reaped = reaped
  result.failed = failed
  if (reapedDescendants.length > 0) result.reapedDescendants = reapedDescendants
  // 收殓结果汇总（D6-⑥ 配套：决策 → 结果闭环，failed 非空时归因有据）
  console.log('[orphan-reap] reap result', {
    action: 'reap_orphan_pi_result',
    trigger: options.trigger ?? 'unspecified',
    reaped: result.reaped,
    failed: result.failed,
    reapedDescendants,
  })
  return result
}

/**
 * 单个孤儿的处置序列（含后代顺链清扫）。返回 ok = pi 本体处置成败（调用方记入
 * reaped/failed），descendantsSwept = 实际发过信号的快照后代（bash/sh/zsh 等孤儿
 * shell 收口的观测面，供日志与结果汇总）。
 *
 * 时序：锚定 lstart → 【SIGTERM 前】快照后代树（T0 不变量：pi 死后 reparent，树形即失）
 * → SIGTERM pi（自身 handler 先跑优雅清理）→ SIGTERM 后代 → 统一宽限 → pi 探活 /
 * lstart 复验 / 补 SIGKILL（既有链不动）→ 幸存后代补 SIGKILL。pi 在 SIGTERM 即已
 * 自退（ESRCH）时后代照扫——快照已在前完成。
 *
 * SIGKILL 前 pid 复用复验（防线尽力而为，仅 pi 本体）：处置起点锚定一次 ps lstart，
 * SIGKILL 发射前复读比对——lstart 变化 = 原孤儿已死、pid 已被无关进程复用（pid 复用必
 * 经原进程退出），跳过 SIGKILL 防「杀链延迟窗口内误杀复用者」。任一时点 ps 失败（null）
 * → 按现状继续，不因防线缺席放弃处置。原孤儿已随 pid 复用确定死亡，按已回收计（对齐
 * 「exited before SIGTERM」语义），warn 留痕供归因。后代不发 lstart 复验（快照→补杀
 * 同处置内秒级窗口，对齐 process-control stopRuntimeProcess 对后代的同款风险接受）。
 */
/**
 * 向 pi 本体发一次信号的结果三分类：delivered = 送达；exited = ESRCH（处置窗口内已自行
 * 退出，幂等按已回收计）；failed = 其他错误（warn 留痕后归失败）。
 */
type OrphanSignalOutcome = "delivered" | "exited" | "failed";

/**
 * 单次信号发射 + ESRCH 归类（SIGTERM/SIGKILL 两处 try/catch 共形提取）：ESRCH 按
 * 「已退出」归类，其余错误 warn 留痕（消息形态与原两处一致）。
 */
function signalOrphanPi(row: PsRow, sig: 'SIGTERM' | 'SIGKILL', signal: OrphanKillDeps['signal']): OrphanSignalOutcome {
  try {
    signal(row.pid, sig)
    return 'delivered'
  } catch (e) {
    if (!isProcessGone(e)) {
      console.warn(`[orphan-reap] ${sig} failed for orphan pi pid=${row.pid}:`, e instanceof Error ? e.message : e)
      return 'failed'
    }
    return 'exited'
  }
}

async function killOrphan(
  row: PsRow,
  deps: OrphanKillDeps,
): Promise<{ ok: boolean; descendantsSwept: number[] }> {
  const { killGraceMs, signal, delay, readProcessStartTime, getDescendantPids } = deps
  const summary = argvSummary(row.command)
  const startLstart = await readProcessStartTime(row.pid)
  // 后代快照必须在首个信号之前（T0 不变量）。枚举失败/无 pgrep → 空表降级：pi 本体
  // 处置照旧，仅 shell 顺链清扫缺席（宁漏不误杀）。
  const descendants = await snapshotDescendants(row, getDescendantPids)

  // 后代补杀（幸存者 SIGKILL）。快照后已自然退出的（含被 pi 自身 handler 清理的）
  // ESRCH 直接跳过；其余盲杀——秒级窗口内 pid 复用风险与 process-control 同款接受。
  const sweepDescendants = (): number[] => {
    const swept: number[] = []
    for (const pid of descendants) {
      try {
        signal(pid, 'SIGKILL')
        swept.push(pid)
      } catch (e) {
        if (!isProcessGone(e)) {
          console.warn(`[orphan-reap] SIGKILL failed for descendant pid=${pid} (of orphan pi ${row.pid}):`, e instanceof Error ? e.message : e)
        }
      }
    }
    if (swept.length > 0) {
      console.log(`[orphan-reap] swept ${swept.length} descendant shell(s) of orphan pi pid=${row.pid}: [${swept.join(', ')}]`)
    }
    return swept
  }

  // 成功收殓出口（后代清扫 + 结果日志；note = 处置路径留痕，进观测面）。
  const finishReaped = (note: string): { ok: boolean; descendantsSwept: number[] } => {
    const swept = sweepDescendants()
    console.log(`[orphan-reap] reaped orphan pi pid=${row.pid} (${note}) ${summary}`)
    return { ok: true, descendantsSwept: swept }
  }

  // pi 本体 SIGTERM。ESRCH = 扫描到处置之间已自行退出（stdin-EOF 自杀链赶到前面）——按已
  // 回收计，幂等。杀链不对称的接受理由：exited 分支直接对后代 SIGKILL、跳过「SIGTERM →
  // 宽限 → SIGKILL」升级链——方向是宁漏不误杀（后代已随 pi 退出孤儿化，快照时点最新，
  // 直杀不比升级链更危险），省掉对已无父 shell 的多余宽限等待。后代快照仍有效（信号前
  // 采集）：pi 死前 spawn 的 shell 照扫，不留永久孤儿。
  const termOutcome = signalOrphanPi(row, 'SIGTERM', signal)
  if (termOutcome === 'exited') return finishReaped('exited before SIGTERM')
  if (termOutcome === 'failed') return { ok: false, descendantsSwept: [] }

  // pi 自身 SIGTERM 后，快照后代同步 SIGTERM（多数 shell 对 SIGTERM 默认即退；
  // 与 pi 宽限共用同一窗口，不额外等待）。
  for (const pid of descendants) {
    // eslint-disable-next-line taste/no-silent-catch -- 已自然退出/被 pi handler 清理的后代 ESRCH 属预期，补杀阶段幂等跳过
    try { signal(pid, 'SIGTERM') } catch { /* ESRCH = 已退出，补杀阶段探活兜底 */ }
  }

  await delay(killGraceMs)

  // 宽限后探活（signal 0 存在性探测，EPERM 等按「活着」走 SIGKILL 兜底——probeAliveAfterGrace）。
  if (!probeAliveAfterGrace(signal, row.pid)) return finishReaped('SIGTERM')

  // SIGKILL 发射前的身份复验：lstart 与处置起点不同 = pid 已复用（原孤儿确定已死），
  // 跳过 SIGKILL——误杀复用者的代价高于少收一个已死孤儿。复验失败（null）不阻断。
  // 后代清扫独立于本复验：快照后代身份不受 pi pid 复用影响，照扫。
  if (startLstart !== null) {
    const currentLstart = await readProcessStartTime(row.pid)
    if (currentLstart !== null && currentLstart !== startLstart) {
      const swept = sweepDescendants()
      console.warn(`[orphan-reap] pid ${row.pid} reused between scan and SIGKILL (process start time changed), skipping SIGKILL — original orphan already exited ${summary}`)
      return { ok: true, descendantsSwept: swept }
    }
  }

  const killOutcome = signalOrphanPi(row, 'SIGKILL', signal)
  if (killOutcome === 'delivered') return finishReaped(`SIGKILL after ${killGraceMs}ms grace`)
  if (killOutcome === 'exited') return finishReaped('exited during grace')
  // pi 本体处置失败不阻断后代清扫（shell 收口独立于 pi 处置成败）。
  const swept = sweepDescendants()
  return { ok: false, descendantsSwept: swept }
}
