/**
 * cold-switch-lib —— 会话冷切换性能优化（dev-0.12.1-cfcbd4bd）验收剧本共享库。
 *
 * 服务三个场景剧本（设计 §4.1 场景表）：cold-switch-primary（A1/A2/A6）、
 * warmup-resilience（A3/A7）、warmup-longrun-stability（A4）。只提供机制原语
 * （生产样本 fixture 采集 / 侧栏切换驱动与计时 / pi 置换注入 / 预热槽进程取证 /
 * smoke 模式参数），不定义业务断言。
 *
 * 关键事实（源码/磁盘核对，勿凭示例硬写）：
 * - 侧栏会话行根 = `.session-item`（role=button，aria-label = 会话 label），无 per-session
 *   testid（capabilities/session.md Gotchas 3）；项目组根 = `[data-testid="project-group"]`
 *   带 `data-project-id`，组头 = `project-group-toggle`（lib-conn-datasync readSidebarGroups 同源）。
 * - 切换失败分支（现状语义，设计 §4.1 场景 6②）：selectSession 抛错 →
 *   toast `sidebar.switchSessionFailed` = 「切换会话失败：{msg}」（zh-CN/sidebar.ts:11）；
 *   toast 容器 = `[data-testid="toast-container"]`，单条 = `toast-session-<id>` / `toast-message-<id>`
 *   （packages/renderer/src/components/ui/ToastContainer.vue）。
 * - 首屏对话流：`turn-<index>` 回合容器（packages/ui Turn.vue），user 气泡文本 = 用户输入原文
 *   （docs/testing/01-chat-panel-composer.md §3）；composer 容器 = `[data-testid="composer-box"]`。
 * - 历史截断条（「加载更早」）= `[data-testid="load-more-history"]`（TruncatedHistoryBar.vue）。
 * - dev 模式 pi 可执行文件定位链（packages/runtime/src/infra/pi/find-pi-executable.ts）：
 *   优先 `<repo>/apps/electron/resources/pi/pi-<plat>-<arch>`（workspace 缓存逐文件 symlink 产物），
 *   缺失才 fallback 系统 PATH/nvm/common locations。场景 6 的 spawn 失败注入 = 文件级置换
 *   resources/pi 下该二进制（SKILL.md §1.3 同款手法）；置换走 rename 备份（symlink 场景 =
 *   移动链接本身，缓存实体不动），恢复走逆向 rename。
 * - pi 会话 jsonl 行形态：首行 `{type:'session', id, cwd, ...}`；消息行
 *   `{type:'message', message:{role, content:[{type:'text',text}...]}, id, timestamp}`。
 * - 协议：`session.list {} → session.listed {groups}`（SessionGroup.sessions[].id/label/projectId，
 *   packages/shared/src/protocol.ts:2946）；`session.switch {sessionId} → session.switched`；
 *   `session.history {sessionId} → session.history`（reply 带 messages/cursor）。
 * - 预热槽（u2 warmup-pi-slot.ts，本单元组装时实现可能未落地）：消费路径一行结构化日志，
 *   四态 = 命中/参数不匹配/槽空/进程死（设计 §5 检查点⑤）；槽进程 = runtime 进程的 pi 子进程。
 *   日志具体格式未冻结——findWarmupPid 用宽匹配（/warmup/i 行内 pid 数字），实跑若不符再按
 *   实际格式收紧（剧本维护轨）。
 *
 * smoke 模式（env `COLD_SWITCH_SMOKE=1`）：等时步长缩短（30 分钟长跑 → 默认 60s，可再被
 * `COLD_SWITCH_LONGRUN_MS` 覆盖）+ 目标行为断言由剧本侧降级为 uncovered 登记（实现未落地时
 * 这些断言原理上不可判，D3 实跑不带该 env 时全量执行）。结构断言（现状即真的部分）照常执行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export class ColdSwitchLibError extends Error {
  constructor(message, { hint, evidence } = {}) {
    super(message)
    this.name = 'ColdSwitchLibError'
    this.hint = hint
    this.evidence = evidence
  }
}

// ── 轮询（lib/ 子目录自包含先例：mobile-drive/plugin-provider-fixture 各自带 pollUntil） ──

/** 条件轮询；超时抛带 label 的错（禁「固定 sleep 后断言」）。 */
export async function pollUntil(predicate, { timeoutMs = 30_000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new ColdSwitchLibError(`轮询超时（${timeoutMs}ms）：${label}`, {
    hint: '看 runDir 证据与 <dataDir>/logs/ 归因',
    evidence: { label, timeoutMs },
  })
}

// ── smoke 模式参数 ──────────────────────────────────────────────────

/** smoke 短模式开关（D1 组装期对样本数据实跑用；D3 实跑不带此 env = 全量断言）。 */
export function isSmokeMode() {
  return process.env.COLD_SWITCH_SMOKE === '1'
}

/** A4 长跑等时时长：env 显式覆盖 > smoke 60s > 设计值 30 分钟。 */
export function longrunHoldMs() {
  const explicit = Number(process.env.COLD_SWITCH_LONGRUN_MS)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return isSmokeMode() ? 60_000 : 30 * 60_000
}

/** 长跑期间的槽探活间隔。 */
export function warmupProbeIntervalMs() {
  return isSmokeMode() ? 5_000 : 15_000
}

/**
 * 首屏判据等待上限。实跑（尾读交付）下首屏预算 500ms 量级，30s 上限已宽；
 * smoke 跑的是现状全量恢复路径（42MB 会话可能数十秒），放宽到 240s。
 */
export function firstScreenTimeoutMs() {
  return isSmokeMode() ? 240_000 : 30_000
}

/** 输入框可用等待上限（实跑断言口径 1.5s；smoke 放宽跑通现状路径）。 */
export function composerReadyTimeoutMs() {
  return isSmokeMode() ? 240_000 : 15_000
}

// ── fixture 采集（生产样本 → 实例数据目录） ─────────────────────────

export const PROD_DATA_DIR = path.join(process.env.HOME ?? '', '.taiji')

// runtime 历史预算常量精确镜像（packages/shared/src/constants.ts 的 HISTORY_BUDGET 与
// READ_PRECHECK_MAX_BYTES；scenarios 独立于 packages 运行不 import @taiji/shared，
// 两处同步靠本注释锚定——runtime 改值时此处跟随）：
// HISTORY_BUDGET = { RECENT_TURNS: 20, MAX_BYTES: 640 * 1024 }，READ_PRECHECK_MAX_BYTES = 32MB。
const HISTORY_BUDGET_RECENT_TURNS = 20
const HISTORY_BUDGET_MAX_BYTES = 640 * 1024
const TAIL_SCAN_MAX_BYTES = 32 * 1024 * 1024

/** usable 消息文本判定（extractSessionSignatures 的签名判据专用）：渲染后精确子串匹配要求——太短、含 markdown/HTML 结构字符（渲染失真）、taiji:msg 内部标记行均不可用。预算窗口 needle 不复用它（needle 走渲染归一化，见 extractBudgetWindowNeedles 注释）。 */
function isUsableMessageText(text) {
  return typeof text === 'string' && text.length >= 8 && !/[*_`#[\]<>\\|]/.test(text) && !text.includes('taiji:msg')
}

/** message content 数组 → 纯文本（text 段空格连接；与 DOM 侧 readStreamText 同款 \\s+ 归一前的原始形态）。 */
function flattenMessageText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join(' ')
    .trim()
}

/** 递归列举文件。 */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/**
 * 读 jsonl 首行的 header.id（runtime 的权威 sessionId）。
 * 文件名 = `<timestamp>_<uuid>.jsonl` 而 session.id = 纯 uuid（首行 type=session 的 id 字段）
 * ——sessionId 必须取自首行，用文件名派生会与 session.list/协议侧 id 永远对不上。
 */
function readHeaderId(jsonlFile) {
  try {
    const fh = fs.openSync(jsonlFile, 'r')
    try {
      const buf = Buffer.alloc(4096)
      const n = fs.readSync(fh, buf, 0, buf.length, 0)
      const firstLine = buf.toString('utf8', 0, n).split('\n')[0]
      const row = JSON.parse(firstLine)
      return typeof row?.id === 'string' ? row.id : null
    } finally {
      fs.closeSync(fh)
    }
  } catch {
    return null
  }
}

/** 读 projects.json 活跃项目 id 集合（种子会话必须归属其中，否则侧栏不显示）。 */
export function loadActiveProjectIds(prodRoot = PROD_DATA_DIR) {
  const file = path.join(prodRoot, 'projects.json')
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  return new Set((json.projects ?? []).map((p) => p.id).filter((id) => typeof id === 'string' && id))
}

/**
 * 扫描生产会话池：绑定 projects.json 活跃项目的真实会话（jsonl + sidecar 家族）。
 * 排除 workflow-state（workflow record 非会话）与无 sidecar 绑定的孤儿。
 */
export function scanSessionPool(prodRoot = PROD_DATA_DIR, { activeProjectIds } = {}) {
  const sessionsRoot = path.join(prodRoot, 'agent', 'sessions')
  if (!fs.existsSync(sessionsRoot)) return []
  const projectIds = activeProjectIds ?? loadActiveProjectIds(prodRoot)
  const pool = []
  for (const file of walk(sessionsRoot)) {
    if (!file.endsWith('.jsonl') || file.includes(`${path.sep}workflow-state${path.sep}`)) continue
    const sidecar = `${file}.project.json`
    if (!fs.existsSync(sidecar)) continue
    let projectId
    try {
      projectId = JSON.parse(fs.readFileSync(sidecar, 'utf8'))?.projectId
    } catch {
      continue
    }
    if (typeof projectId !== 'string' || !projectIds.has(projectId)) continue
    const headerId = readHeaderId(file)
    if (!headerId) continue // 无 header.id 的文件进不了 runtime 扫描（fail-fast 同语义），不入选
    pool.push({
      sessionFile: file,
      sidecars: walk(path.dirname(file)).filter((f) => f.startsWith(file) && f !== file),
      projectId,
      bytes: fs.statSync(file).size,
      sessionId: headerId,
    })
  }
  return pool
}

/** 挑最大样本（设计「42MB 会话」）：≥ minBytes 中取字节最大者。找不到返回 null。 */
export function pickLargestSession(pool, { minBytes = 32_000_000 } = {}) {
  return pool.filter((s) => s.bytes >= minBytes).sort((a, b) => b.bytes - a.bytes)[0] ?? null
}

/** 挑 N 个小会话（≤ maxBytes，互不重复，可选排除集），字节升序。 */
export function pickSmallSessions(pool, { count, maxBytes = 2_000_000, exclude = new Set() }) {
  const picked = []
  for (const s of [...pool].sort((a, b) => a.bytes - b.bytes)) {
    if (picked.length >= count) break
    if (exclude.has(s.sessionFile) || s.bytes > maxBytes) continue
    picked.push(s)
  }
  return picked
}

/**
 * 把「生产数据目录形态」种子进实例数据目录：
 * - projects.json 字节副本（会话扫描按 projectId 归属 projects.json 过滤——不拷则种子会话
 *   全部不可见；覆盖写语义，须在 stop 实例后调用，与 a1 seedRealisticDataDir 同款）；
 * - 会话 jsonl + sidecar 家族（幂等：已存在跳过）。
 */
export function seedSessions(dataDir, prodRoot, picked) {
  const prodProjects = path.join(prodRoot, 'projects.json')
  if (!fs.existsSync(prodProjects)) {
    throw new ColdSwitchLibError(`生产 projects.json 不存在：${prodProjects}`, {
      hint: '本机无 ~/.taiji 生产数据时无法采集真实样本 fixture',
    })
  }
  fs.copyFileSync(prodProjects, path.join(dataDir, 'projects.json'))
  const destRoot = path.join(dataDir, 'agent', 'sessions')
  const prodRel = (file) => path.relative(path.join(prodRoot, 'agent', 'sessions'), file)
  const summary = []
  for (const s of picked) {
    const dest = path.join(destRoot, prodRel(s.sessionFile))
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(s.sessionFile, dest)
    }
    for (const sc of s.sidecars ?? []) {
      const destSc = path.join(destRoot, prodRel(sc))
      if (!fs.existsSync(destSc)) {
        fs.mkdirSync(path.dirname(destSc), { recursive: true })
        fs.copyFileSync(sc, destSc)
      }
    }
    summary.push({ sessionId: s.sessionId, projectId: s.projectId, bytes: s.bytes, rel: prodRel(s.sessionFile) })
  }
  return summary
}

/**
 * 从会话 jsonl 提取「归属/串话判据」签名对：头部（首窗口第一条可直接做 DOM 子串匹配的
 * user/assistant 文本）与尾部（渐进窗口内最后一条）。头尾双锚的原因：现状 getHistory
 * 首屏 = 头部窗口（游标在开头），尾读交付首屏 = 尾部窗口——断言「流含本会话独有内容」
 * 须两态兼容（头部或尾部命中即归属正确），依赖尾读语义的强断言由剧本按 smoke/实跑分流。
 * 跳过含 markdown/HTML 结构字符的消息（渲染后子串判据会失真）与 taiji:msg 内部标记行。
 */
export function extractSessionSignatures(sessionFile, { tailInitialBytes = 1_048_576, tailMaxBytes = 8_388_608, headBytes = 262_144 } = {}) {
  const size = fs.statSync(sessionFile).size
  const readWindow = (start, length) => {
    const buf = Buffer.alloc(length)
    const fh = fs.openSync(sessionFile, 'r')
    try {
      fs.readSync(fh, buf, 0, length, start)
    } finally {
      fs.closeSync(fh)
    }
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim())
    if (start > 0) lines.shift() // 窗口首行大概率被截断
    return lines
  }
  // 头部：顺序扫首窗口，取第一条 usable user / assistant
  let firstUser = null
  let firstAssistant = null
  for (const line of readWindow(0, Math.min(headBytes, size))) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.type !== 'message' || !row.message) continue
    const text = flattenMessageText(row.message.content)
    if (!isUsableMessageText(text)) continue
    const normalized = text.replace(/\s+/g, ' ')
    if (row.message.role === 'user' && !firstUser) firstUser = normalized.slice(0, 120)
    if (row.message.role === 'assistant' && !firstAssistant) firstAssistant = normalized.slice(0, 120)
    if (firstUser && firstAssistant) break
  }
  // 尾部：渐进扩大窗口（大事件流尾部可能很长没有 message 行），双签名齐或上限即停
  const scanTail = (scanBytes) => {
    const start = Math.max(0, size - scanBytes)
    let lastUser = null
    let lastAssistant = null
    for (const line of readWindow(start, size - start)) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row?.type !== 'message' || !row.message) continue
      const text = flattenMessageText(row.message.content)
      if (!isUsableMessageText(text)) continue
      const normalized = text.replace(/\s+/g, ' ')
      if (row.message.role === 'user' && !lastUser) lastUser = normalized.slice(0, 120)
      if (row.message.role === 'assistant' && !lastAssistant) lastAssistant = normalized.slice(0, 120)
      if (lastUser && lastAssistant) break
    }
    return { lastUser, lastAssistant }
  }
  let scanBytes = Math.min(tailInitialBytes, size)
  let tail = scanTail(scanBytes)
  while (!(tail.lastUser && tail.lastAssistant) && scanBytes < Math.min(tailMaxBytes, size)) {
    scanBytes = Math.min(tailMaxBytes, size, scanBytes * 4)
    tail = scanTail(scanBytes)
  }
  return {
    firstUser,
    firstAssistant,
    lastUser: tail.lastUser,
    lastAssistant: tail.lastAssistant,
    sessionId: readHeaderId(sessionFile),
  }
}

/** 签名对的任一命中文本（头部优先——现状首屏即头部窗口；尾读交付下尾部命中）。 */
export function anySignatureText(sig) {
  return sig?.lastUser ?? sig?.lastAssistant ?? sig?.firstUser ?? sig?.firstAssistant ?? null
}

/** 签名对的全部命中文本（他方泄漏检测用：头尾都不得出现在流中）。 */
export function allSignatureTexts(sig) {
  return [sig?.lastUser, sig?.lastAssistant, sig?.firstUser, sig?.firstAssistant].filter(
    (t) => typeof t === 'string' && t.length > 0,
  )
}

/**
 * 模拟 runtime 尾读预算窗口，提取「窗口内必含」的首屏判据文本（needle 候选集）。
 *
 * 为什么需要它：u1 尾读交付的首屏窗口受 HISTORY_BUDGET 字节帽截断（truncated=true +
 * 「加载更早」入口是设计内语义；锚：packages/runtime/src/services/session-history.ts
 * getHistoryFromFilePath / collectRecentTurnEntriesFromTail——离线尾读默认预算
 * HISTORY_BUDGET.RECENT_TURNS=20 turns 叠加 HISTORY_BUDGET.MAX_BYTES=640KB 字节帽）。
 * 尾部 turn 含截图工作流时体积巨大，物理尾签名（extractSessionSignatures 的
 * lastUser/lastAssistant，usable 过滤后可能在距尾很远的更早历史里）会落在被截部分，
 * 「签名入流」轮询永不满足——首屏判据 needle 必须取自「预算窗口内必含」的文本。
 *
 * 窗口语义对齐 runtime（session-history.ts 同名机制简化镜像，无 cursor 语义）：
 * - 从文件尾逆序按行分块读（1MB 块 + 跨块行拼接，禁全量 readFileSync——42MB 载体）；
 * - turn 边界 = user message entry（isTurnBoundary 同语义：type==='message' &&
 *   message.role==='user'）；
 * - 字节预算在 turn 边界处判定（hitsByteBudgetCap 同判：首个 turn 豁免完整放行，
 *   后续超界不入窗——turnCount>1 时回退最后收集的 turn）；凑满 maxTurns 即停；
 * - 总读取量上限 TAIL_SCAN_MAX_BYTES=32MB（READ_PRECHECK_MAX_BYTES 同值）；
 * - 窗口起点对齐最早收集的 turn 边界行（残段丢弃，entry 原子性；扫到文件头时头部
 *   孤儿段保留——runtime 同款）。
 *
 * 返回窗口内全部 message 文本的「渲染归一化」前 40 字符（去重保序）。为什么不用签名判据
 * 的 usable 精确子串过滤：DOM textContent 是**渲染后**文本——HTML 注释（taiji:msg 内部
 * 标记）渲染后不进 textContent，markdown/HTML 结构字符渲染后不保留原样；而物理尾 turn
 * 常整段污染（user 消息带 taiji:msg 注释、assistant 带 markdown，42MB 样本实测尾部 5 turn
 * 无一条 usable），照搬 usable 过滤会把窗口内文本全灭，判据载体错误只是从「签名落窗外」
 * 变形为「窗口内无可匹配文本」。故 needle 取渲染归一化形态（剥 HTML 注释 + 结构标记字符
 * + \\s 归一，≥8 字符），与 DOM 同构。分支会话被撤子树行会在 renderer 侧被滤除
 * （computeActivePathEntries），此类 needle 不命中流——调用方判据为 some 语义，无害。
 * 与签名组取并集使用（expectTexts），不单独作判据。
 */
export function extractBudgetWindowNeedles(sessionFile, { maxTurns = HISTORY_BUDGET_RECENT_TURNS, maxBytes = HISTORY_BUDGET_MAX_BYTES } = {}) {
  const size = fs.statSync(sessionFile).size
  const isTurnRow = (row) => row?.type === 'message' && row?.message?.role === 'user'
  // 逆序收集态（session-history.ts TailWindowScan 简化镜像）：行与 turn 标记平行（新→旧）
  const linesDesc = []
  const turnFlagsDesc = []
  const turnStartStack = []
  let accBytes = 0
  let turnCount = 0
  let stop = false
  const rollbackLastTurn = () => {
    const popped = turnStartStack.pop()
    if (!popped) return
    const keepLen = turnStartStack.length > 0 ? turnStartStack[turnStartStack.length - 1].idx + 1 : 0
    linesDesc.length = keepLen
    turnFlagsDesc.length = keepLen
    accBytes = popped.accBefore
    turnCount--
  }
  const visit = (line) => {
    if (stop) return
    const trimmed = line.trim()
    if (!trimmed) return
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      return
    }
    const isTurn = isTurnRow(row)
    // 字节预算超界（hitsByteBudgetCap 同判：边界处判已收集字节；首个 turn 豁免——
    // turnCount===1 时直接停但保留已收的完整 turn）
    if (isTurn && turnCount > 0 && accBytes > maxBytes) {
      if (turnCount > 1) rollbackLastTurn()
      stop = true
      return
    }
    if (isTurn) turnStartStack.push({ idx: linesDesc.length, accBefore: accBytes })
    linesDesc.push(trimmed)
    turnFlagsDesc.push(isTurn)
    accBytes += Buffer.byteLength(trimmed, 'utf8')
    if (isTurn) turnCount++
    if (turnCount >= maxTurns) stop = true
  }
  // 逆序分块读：carry = 跨块行的首段（归更靠前的一块拼接）；块首 UTF-8 continuation
  // 残字节留给下一块完整解码，防多字节字符被块边界劈成乱码
  const CHUNK = 1024 * 1024
  let carry = ''
  let scannedBytes = 0
  let reachedHead = false
  let end = size
  while (end > 0 && !stop) {
    const start = Math.max(0, end - CHUNK)
    const buf = Buffer.alloc(end - start)
    const fh = fs.openSync(sessionFile, 'r')
    let n
    try {
      n = fs.readSync(fh, buf, 0, buf.length, start)
    } finally {
      fs.closeSync(fh)
    }
    scannedBytes += n
    let skip = 0
    if (start > 0) while (skip < n && (buf[skip] & 0xc0) === 0x80) skip++
    const lines = buf.toString('utf8', skip, n).split('\n')
    const tail = lines.pop() ?? ''
    const head = lines.shift() ?? ''
    visit(tail + carry)
    for (let i = lines.length - 1; i >= 0; i--) visit(lines[i])
    if (!stop && start === 0) visit(head)
    carry = head
    if (start === 0) reachedHead = true
    end = start
    if (scannedBytes >= TAIL_SCAN_MAX_BYTES) break // 总读取量上限（READ_PRECHECK_MAX_BYTES 同值），未到头 = 非全文件扫描
  }
  // 窗口起点对齐 turn 边界（残段丢弃；扫到文件头时头部孤儿段保留——runtime 同款）
  let startIdx = 0
  if (!reachedHead) {
    const firstTurn = turnFlagsDesc.indexOf(true)
    startIdx = firstTurn === -1 ? linesDesc.length : firstTurn
  }
  const needles = []
  const seen = new Set()
  for (let i = startIdx; i < linesDesc.length; i++) {
    let row
    try {
      row = JSON.parse(linesDesc[i])
    } catch {
      continue
    }
    if (row?.type !== 'message' || !row.message) continue
    const text = flattenMessageText(row.message.content)
    if (!text) continue
    // 渲染归一化：剥 HTML 注释（taiji:msg 内部标记，渲染后不进 textContent）+ markdown/HTML
    // 结构字符（渲染后不保留原样）+ \\s 归一（DOM 侧 readStreamText 同款），≥8 字符取前 40
    const needle = text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/[*_`#[\]<>\\|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
    if (needle.length < 8 || seen.has(needle)) continue
    seen.add(needle)
    needles.push(needle)
  }
  return needles
}

/**
 * 挑选「带签名判据」的会话序列：候选由 picker 产出（超额），逐个提取尾部签名，
 * 只保留签名命中者（串话断言的强判据覆盖；尾部无可匹配文本的会话会退化成弱判据）。
 * @param {(pool) => Array} picker 候选挑选器（各剧本按实跑/smoke 给不同字节口径）
 */
export function pickSessionsWithSignatures(pool, { count, picker }) {
  const out = []
  const signatures = new Map()
  for (const s of picker(pool)) {
    if (out.length >= count) break
    const sig = extractSessionSignatures(s.sessionFile)
    if (!anySignatureText(sig)) continue
    out.push(s)
    signatures.set(s.sessionId, sig)
  }
  return { picked: out, signatures }
}

// ── 侧栏驱动与计时（A 通道：真实用户路径，testid/aria 锚点） ───────────

/**
 * 从 session.list reply 展平 id↔label↔projectId 映射（种子后侧栏与扫描同数据源，
 * label 由此取得，不预知不硬编码）。
 */
export function flattenSessionList(listReply) {
  const rows = []
  for (const g of listReply?.groups ?? []) {
    for (const s of g.sessions ?? []) {
      rows.push({ id: s.id, label: s.label ?? '', projectId: s.projectId ?? g.projectId ?? '', status: s.status })
    }
  }
  return rows
}

/**
 * 预定位会话行（展开折叠组、等行可见）并返回 row locator——与点击分离，保证
 * 计时口径（measureFirstPaint 的 t0 → row.click()）不含定位耗时。
 */
export async function locateSidebarSession(page, { projectId, label, timeoutMs = 20_000 }) {
  const group = page.locator(`[data-testid="project-group"][data-project-id="${projectId}"]`)
  await group.waitFor({ state: 'attached', timeout: timeoutMs })
  const toggle = group.locator('[data-testid="project-group-toggle"]')
  const row = group.locator(`.session-item[aria-label="${label.replace(/"/g, '\\"')}"]`)
  if ((await row.count()) === 0) {
    // 组折叠时会话行不在 DOM：先点组头展开再等行渲染
    if ((await toggle.count()) > 0) await toggle.click()
    await row.waitFor({ state: 'visible', timeout: timeoutMs })
  }
  return row
}

/** 预定位后直接点击（不计时的驱动入口）。 */
export async function clickSidebarSession(page, targets) {
  const row = await locateSidebarSession(page, targets)
  await row.click()
}

/**
 * 首屏判据（「最近消息可见」）：最后一个 turn 容器与视口相交且含非空文本。
 * 返回该 turn 的文本（供尾部签名核对）；未出现返回 null。
 */
export async function readLatestTurn(page) {
  return page.evaluate(() => {
    const turns = document.querySelectorAll('[data-testid^="turn-"]')
    const last = turns[turns.length - 1]
    if (!last) return null
    const rect = last.getBoundingClientRect()
    const inViewport = rect.top < window.innerHeight && rect.bottom > 0 && rect.height > 0
    const text = (last.textContent ?? '').replace(/\s+/g, ' ').trim()
    return { inViewport, text, turnCount: turns.length }
  })
}

/**
 * 首屏判据（「最近消息可见」）等待。expectTexts（本会话签名组）传入时判据收紧为
 * 「流含任一签名且最后 turn 非空在视口」——不传时旧流未清空的恢复窗口会把「最后
 * turn 非空」误判成新会话已渲染（假阳性：切换请求已发出、restore 进行中，流还是
 * 前一会话内容），凡调用方持有所切会话的签名就必须传入。
 * needle 命中用 needleHitInStream（DOM 渲染折叠容忍）——精确 includes 会在长消息
 * 被折叠为「前缀 + …」时永不满足，把渲染成功的轮询拖到超时。
 */
export async function waitForLatestTurnVisible(page, { timeoutMs = 30_000, expectTexts } = {}) {
  const needles = (expectTexts ?? []).filter((t) => typeof t === 'string' && t.length > 0).map((t) => t.slice(0, 40))
  return pollUntil(async () => {
    const t = await readLatestTurn(page)
    if (!t?.inViewport || !t.text) return null
    if (needles.length > 0) {
      const stream = await readStreamText(page)
      if (!needles.some((n) => needleHitInStream(stream, n))) return null
    }
    return t
  }, { timeoutMs, label: needles.length > 0 ? '本会话签名入流且最近消息可见' : '最近消息 turn 渲染可见' })
}

/**
 * 首屏计时（A1/A2 断言载体）：t0 → clickFn() → 首屏判据轮询 → elapsed。
 * clickFn 内部只做定位与点击（不轮询等待业务态）。
 * expectTexts 语义同 waitForLatestTurnVisible（持有所切会话签名时必传，防旧流假阳性）。
 */
export async function measureFirstPaint(page, clickFn, { timeoutMs = 30_000, expectTexts } = {}) {
  const t0 = Date.now()
  await clickFn()
  const seen = await waitForLatestTurnVisible(page, { timeoutMs, expectTexts })
  return { elapsedMs: Date.now() - t0, ...seen }
}

/**
 * 首屏计时的容忍版：轮询超时不一律抛错，按超时瞬间的流观测分流归因——
 * - 流非空且最后 turn 可见（渲染已发生）但 needle 判据全灭（判据与 DOM 渲染不同构，
 *   如长消息折叠「前缀 + …」后 needle 无一命中）：返回 { rendered:true, needleMiss:true }
 *   交调用方降级 uncovered（归属判定原理上不可判；串话断言不依赖本会话 needle，照常
 *   执行），text 带全流快照供裁决——比把判据资产缺陷报成 30s 超时 fail 诚实；
 * - 流空 / 无 turn（切换渲染真失败）：smoke 返回 { rendered:false }（调用方登记
 *   uncovered），实跑（D3）照抛 = fail。
 * smoke 下调用方应以更短的 timeoutMs 调用（如 45s），避免对必然超时的现状基线空等。
 */
export async function firstPaintTolerant(page, clickFn, { timeoutMs = 30_000, expectTexts } = {}) {
  try {
    const seen = await measureFirstPaint(page, clickFn, { timeoutMs, expectTexts })
    return { ...seen, rendered: true }
  } catch (e) {
    if (!(e instanceof ColdSwitchLibError && /轮询超时/.test(e.message))) throw e
    const probe = await readLatestTurn(page).catch(() => null)
    if (probe?.inViewport && probe.text) {
      const stream = await readStreamText(page).catch(() => '')
      return { elapsedMs: timeoutMs, text: stream || probe.text, turnCount: probe.turnCount, rendered: true, needleMiss: true }
    }
    if (isSmokeMode()) return { elapsedMs: timeoutMs, text: '', turnCount: 0, rendered: false }
    throw e
  }
}

/** 输入框可用判据：composer-box 可见且未禁用。 */
export async function waitForComposerReady(page, { timeoutMs = 15_000 } = {}) {
  return pollUntil(
    () =>
      page
        .evaluate(() => {
          const box = document.querySelector('[data-testid="composer-box"]')
          if (!box) return null
          const rect = box.getBoundingClientRect()
          const disabled = box.getAttribute('aria-disabled') === 'true' || box.querySelector('[contenteditable][disabled]') !== null
          return rect.height > 0 && !disabled ? { ready: true } : null
        })
        .catch(() => null),
    { timeoutMs, label: 'composer-box 可用' },
  )
}

/**
 * 等待 toast-container 内出现匹配文本的 toast 并返回其文本。
 * toast 会自动消失，须即时轮询抓取；超时抛专用错（toast 消失快，报错要带最后观测文本）。
 */
export async function waitForToast(page, { textPattern, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastText = ''
  while (Date.now() < deadline) {
    lastText = await page
      .evaluate(() => {
        const container = document.querySelector('[data-testid="toast-container"]')
        return container ? container.textContent ?? '' : ''
      })
      .catch(() => '')
    const hit = textPattern instanceof RegExp ? textPattern.test(lastText) : lastText.includes(String(textPattern))
    if (hit) return lastText
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new ColdSwitchLibError(`toast 未在 ${timeoutMs}ms 内出现（匹配 ${textPattern}）`, {
    hint: '确认切换失败分支是否触发 toastError；renderer console 日志（logs/renderer-console-*.log）为第二证据',
    evidence: { lastToastText: lastText.slice(0, 300) },
  })
}

/** 读取对话流全部 turn 文本（串话断言的 A 通道证据面）。 */
export async function readStreamText(page) {
  return page.evaluate(() => {
    const turns = document.querySelectorAll('[data-testid^="turn-"]')
    const parts = []
    for (const t of turns) parts.push((t.textContent ?? '').replace(/\s+/g, ' '))
    return parts.join(' ')
  })
}

/**
 * needle 在流文本中的命中判定（DOM 渲染折叠容忍）。
 *
 * 为什么不是 stream.includes(needle)：DOM 渲染会把长消息折叠为「前缀 + …」——省略号
 * 进 textContent，截断点后的原文不进，needle 前 40 全串精确子串在折叠流中永不命中
 * （D3 实测 A7[2]：needle「为什么用 pro ？谁让你用 pro 的？系统提示词怎么说？」在流中
 * 是「为什么用 pro ？谁让你用 pro …」，includes 不中、轮询 other needle 假成功）。
 * 判定两级：①needle 全串子串命中；②needle 的某前缀（≥minPrefix 字符）在流中出现且
 * 紧跟省略号（…/⋯/...）——省略号截断证据把「折叠截断」与「短前缀巧合」区分开，
 * minPrefix 下限压误报（12 字符连续中文子串 + 省略号，在无关流中按序出现可忽略）。
 * 串话缺席断言同用本函数：放宽方向是多报泄漏（fail-safe 方向），不是漏报。
 */
export function needleHitInStream(streamText, needle, { maxLen = 40, minPrefix = 12 } = {}) {
  const n = (needle ?? '').slice(0, maxLen)
  if (!streamText || n.length === 0) return false
  if (streamText.includes(n)) return true
  for (let k = minPrefix; k <= n.length; k++) {
    const prefix = n.slice(0, k)
    const at = streamText.indexOf(prefix)
    if (at === -1) continue
    const after = streamText.slice(at + prefix.length, at + prefix.length + 3)
    if (after.startsWith('…') || after.startsWith('⋯') || after.startsWith('...')) return true
  }
  return false
}

// ── 进程取证（C 通道：预热槽 / pi 子进程） ───────────────────────────

/**
 * runtime 进程 PID：LISTEN 状态持有者 + cmdline 运行时指纹二次核对
 * （--builtin-plugins-dir 标记；不筛会把 renderer 的 ESTABLISHED 连接当 runtime）。
 */
export function runtimePidOf(dataDir) {
  const port = readRuntimePort(dataDir)
  if (!port) return null
  let pids = []
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`, '-P', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 10_000 })
    pids = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return null
  }
  for (const pid of pids) {
    try {
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10_000 })
      if (cmd.includes('--builtin-plugins-dir=')) return pid
    } catch {
      /* 进程已退出：看下一个候选 */
    }
  }
  return pids.length > 0 ? pids[0] : null
}

/** 读 <dataDir>/runtime.port（stop/launch 循环后端口可能重写，协议连接须按最新值自建）。 */
export function readRuntimePort(dataDir) {
  try {
    const n = Number.parseInt(fs.readFileSync(path.join(dataDir, 'runtime.port'), 'utf8').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/** runtime 自身日志全文（logs/runtime-*.log 最新一份；无则空串）。 */
export function readRuntimeLog(dataDir) {
  const dir = path.join(dataDir, 'logs')
  if (!fs.existsSync(dir)) return ''
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('runtime-'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return files.length > 0 ? fs.readFileSync(path.join(dir, files[0].f), 'utf8') : ''
}

/** runtime 进程的 pi 子进程集合（cmdline 含 pi 二进制名，排除 runtime 自身）。 */
export function piChildPids(runtimePid, { binaryMarker = 'pi-darwin-arm64' } = {}) {
  let out = ''
  try {
    out = execFileSync('pgrep', ['-P', String(runtimePid)], { encoding: 'utf8', timeout: 10_000 })
  } catch {
    return []
  }
  const pids = out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
  const result = []
  for (const pid of pids) {
    try {
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10_000 })
      if (cmd.includes(binaryMarker)) result.push({ pid, command: cmd.trim() })
    } catch {
      /* 进程已退出：跳过 */
    }
  }
  return result
}

/** runtime 日志中解析预热槽 pid（宽匹配：/warmup/i 行内 pid 数字）。格式冻结后应收紧。 */
export function findWarmupPidFromLog(runtimeLogText) {
  for (const line of runtimeLogText.split('\n')) {
    if (!/warmup/i.test(line)) continue
    const m = line.match(/pid[=:\s]+(\d+)/i)
    if (m) return Number(m[1])
  }
  return null
}

/** 进程存活判定（EPERM 视为存活）。 */
export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

// ── pi 置换注入（A6：spawn 失败注入，SKILL.md §1.3 同款文件级置换） ──

/** dev 实例 runtime 实际解析的 pi 二进制路径（find-pi-executable.ts dev 首选路径）。 */
export function piResourcePath(repo, { platform = process.platform, arch = process.arch } = {}) {
  const name = platform === 'win32' ? `pi-windows-${arch}.exe` : `pi-${platform}-${arch}`
  return path.join(repo, 'apps', 'electron', 'resources', 'pi', name)
}

const SWAP_MARKER = '#!/bin/sh\nexit 1\n'

/**
 * 置换 pi 二进制为必败脚本（rename 备份原文件——symlink 场景 = 移动链接本身，缓存实体不动）。
 * 返回 {swapped, originalBytes, wasSymlink, path}；资源二进制缺失时 swapped=false（实例会
 * fallback 系统 PATH，注入前提不成立，调用方降级 uncovered，禁止动 PATH 上的生产 pi）。
 */
export function swapPiBinary(repo) {
  const piPath = piResourcePath(repo)
  if (!fs.existsSync(piPath)) {
    return { swapped: false, path: piPath, reason: 'resources/pi 二进制缺失（find-pi-executable 会 fallback PATH，不注入）' }
  }
  const stat = fs.lstatSync(piPath)
  const backup = `${piPath}.cold-switch-bak`
  if (fs.existsSync(backup)) fs.rmSync(backup, { force: true })
  fs.renameSync(piPath, backup)
  fs.writeFileSync(piPath, SWAP_MARKER, { mode: 0o755 })
  return { swapped: true, path: piPath, backup, originalBytes: stat.size, wasSymlink: stat.isSymbolicLink() }
}

/** 逆向恢复 pi 二进制并核对（内容字节数一致 / symlink 形态一致）。 */
export function restorePiBinary(repo, swapInfo) {
  const piPath = swapInfo?.path ?? piResourcePath(repo)
  const backup = swapInfo?.backup ?? `${piPath}.cold-switch-bak`
  if (!swapInfo?.swapped) return { restored: true, path: piPath, note: '未置换过，无需恢复' }
  fs.rmSync(piPath, { force: true })
  fs.renameSync(backup, piPath)
  const stat = fs.lstatSync(piPath)
  const sizeOk = stat.isSymbolicLink() ? swapInfo.wasSymlink : stat.size === swapInfo.originalBytes
  return { restored: sizeOk, path: piPath, bytes: stat.isSymbolicLink() ? null : stat.size, symlink: stat.isSymbolicLink() }
}
