/**
 * turn-index-lib —— turn 边界索引交付（turn-boundary-index）验收剧本共享库。
 *
 * 服务 scenarios/turn-index-*.mjs 七个剧本（设计 §4.1 V1-V8/V10 + §4.2 RL1/RL4/RL7，
 * impl-plan §4.2 A1-A10/A19）。只提供机制原语（fixture 采集 / session.history 计时与
 * 翻页 / 文件注入 / turns.json 读取 / V5 对照快照 / 基线采集模式），不定义业务断言。
 *
 * 与 cold-switch-lib 的关系：生产样本采集（scanSessionPool / seedSessions）、runtime
 * 端口读取（readRuntimePort）复用该库，不在本文件复制；本文件只新增 turn 索引域原语。
 *
 * 关键事实（源码核对）：
 * - turn 边界语义 = type==='message' && message.role==='user'（session-history.ts
 *   isTurnBoundary 同语义，设计 §3.1）。
 * - session.history 请求 {sessionId, cursor?, limitTurns?, maxBytes?}，reply
 *   {sessionId, session?, messages, truncated, loadedTurns, totalTurnsEstimate,
 *   interrupted?}——cursor = 当前窗口最早消息的 piEntryId（protocol.ts D4 分页协议）。
 * - 索引 sidecar 落 session 存储树 <dataDir>/ext-sessions/<sessionId>/history-index/
 *   turns.json（设计 D1；getSessionHistoryIndexFile 具名路径）。
 * - pi 追加形态：每 entry 一行 JSONL；崩溃残尾 = 无换行结尾的半行（设计 SI3）。
 *
 * 基线采集模式（env TURN_INDEX_BASELINE_COLLECT=1）：改造前（commit 494436875）
 * 采集首屏/翻页计时与 V5 对照快照——只记录数据不做终态断言（索引尚不存在，终态
 * 断言原理上不可判）；改造后实跑不带此 env，全量断言。采集产物落
 * ~/.agents/skill-data/verify-taiji/assets/turn-index-baseline/（ASSETS.md 登记）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scanSessionPool, seedSessions, PROD_DATA_DIR } from './cold-switch-lib.mjs'

/** 探针参考会话门槛：设计「41MB 参考会话」（实际样本 42.4MB）。 */
export const PROBE_MIN_BYTES = 32_000_000

/** 连续翻页页数（设计 V1：10 页）。 */
export const PROBE_PAGES = 10

/** 索引就绪后单页预算（设计 V1：<50ms）。 */
export const READY_PAGE_BUDGET_MS = 50

/** 10 页总预算（设计 V1：<500ms）。 */
export const PROBE_PAGES_BUDGET_MS = 500

/** 首次建索引总耗时目标（设计 V2/D2：<1000ms，实测单独报告不混算）。 */
export const FIRST_BUILD_TARGET_MS = 1_000

/** 基线采集产物根（ASSETS.md 边界：资产实体落 skill-data，不进 git）。 */
export const BASELINE_ASSET_DIR = path.join(os.homedir(), '.agents', 'skill-data', 'verify-taiji', 'assets', 'turn-index-baseline')

/** 基线采集模式开关。 */
export function isBaselineCollectMode() {
  return process.env.TURN_INDEX_BASELINE_COLLECT === '1'
}

// ── fixture 采集 ─────────────────────────────────────────────────────

/**
 * 采集探针 fixture：生产池 ≥PROBE_MIN_BYTES 最大会话的隔离副本信息（不复制——
 * 种子落盘由 seedProbeSession 做）。返回 null = 本机无足量样本，调用方按 uncovered 登记。
 */
export function pickProbeSession(prodRoot = PROD_DATA_DIR) {
  const pool = scanSessionPool(prodRoot)
  return pool.filter((s) => s.bytes >= PROBE_MIN_BYTES).sort((a, b) => b.bytes - a.bytes)[0] ?? null
}

/** 把探针会话种子进实例数据目录（cold-switch-lib.seedSessions 直通）。 */
export function seedProbeSession(dataDir, prodRoot, picked) {
  return seedSessions(dataDir, prodRoot, [picked])
}

/**
 * 离线统计 user turn 边界数（isTurnBoundary 同语义，流式逐行——41MB 载体禁全量
 * readFileSync）。同时返回文件字节数与 entry 行数：基线采集第 1 项（设计 §5.1
 * U1 检查点「41MB 参考会话的 turn 总数与文件字节数」）。
 */
export function countUserTurns(jsonlFile) {
  const size = fs.statSync(jsonlFile).size
  let bytes = 0
  let lines = 0
  let turns = 0
  let carry = ''
  const CHUNK = 4 * 1024 * 1024
  const fh = fs.openSync(jsonlFile, 'r')
  try {
    while (bytes < size) {
      const n = Math.min(CHUNK, size - bytes)
      const buf = Buffer.alloc(n)
      fs.readSync(fh, buf, 0, n, bytes)
      const text = carry + buf.toString('utf8')
      const linesArr = text.split('\n')
      carry = linesArr.pop() ?? ''
      for (const line of linesArr) {
        if (!line.trim()) continue
        lines++
        let row
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        if (row?.type === 'message' && row?.message?.role === 'user') turns++
      }
      bytes += n
    }
  } finally {
    fs.closeSync(fh)
  }
  return { fileBytes: size, entryLines: lines, userTurns: turns, hasResidualTail: carry.trim().length > 0 }
}

// ── session.history 计时与翻页 ───────────────────────────────────────

/**
 * 计时的 session.history 调用（RPC 层计量，不含 WS 传输抖动外的东西——同连接同序）。
 * 返回 {elapsedMs, reply}；RPC 抛错时 elapsedMs 照返回、reply 为 {error}。
 */
export async function timedHistory(proto, sessionId, opts = {}) {
  const t0 = Date.now()
  try {
    const reply = await proto.call('session.history', { sessionId, ...opts }, { replyType: 'session.history', timeoutMs: opts.timeoutMs ?? 120_000 })
    return { elapsedMs: Date.now() - t0, reply }
  } catch (e) {
    return { elapsedMs: Date.now() - t0, reply: { error: e instanceof Error ? e.message : String(e) } }
  }
}

/** reply 中窗口最早消息的 piEntryId（翻页 cursor；协议字段 Message.piEntryId）。 */
export function oldestCursor(historyReply) {
  const msgs = historyReply?.messages ?? []
  for (const m of msgs) {
    if (typeof m?.piEntryId === 'string' && m.piEntryId) return m.piEntryId
  }
  return null
}

/**
 * 连续翻页 PROBE_PAGES 页：每页 cursor = 上页最早消息 piEntryId；空页（truncated=false
 * 且无消息）即到头，提前停。返回逐页 {elapsedMs, messages, truncated, loadedTurns,
 * totalTurnsEstimate} + 总耗时 + 页数。
 */
export async function pageThroughHistory(proto, sessionId, { pages = PROBE_PAGES, limitTurns } = {}) {
  const results = []
  let cursor = undefined
  for (let i = 0; i < pages; i++) {
    const payload = { sessionId }
    if (cursor) payload.cursor = cursor
    if (limitTurns) payload.limitTurns = limitTurns
    const { elapsedMs, reply } = await timedHistory(proto, sessionId, payload)
    results.push({
      page: i + 1,
      elapsedMs,
      messages: (reply?.messages ?? []).length,
      truncated: reply?.truncated ?? null,
      loadedTurns: reply?.loadedTurns ?? null,
      totalTurnsEstimate: reply?.totalTurnsEstimate ?? null,
      reply,
    })
    const next = oldestCursor(reply)
    if (!next || (reply?.messages ?? []).length === 0 || reply?.truncated === false) break
    cursor = next
  }
  const totalMs = results.reduce((acc, r) => acc + r.elapsedMs, 0)
  return { pages: results, totalMs, pageCount: results.length }
}

/**
 * 窗口消息重复/丢失判据：逐页 piEntryId 序列拼接后不得有重复（连续翻页不重不漏，
 * 设计 V1「消息无重复或丢失」）。返回重复的 entryId 清单。
 */
export function duplicateEntryIds(paged) {
  const seen = new Set()
  const dup = []
  for (const p of paged) {
    for (const m of p.reply?.messages ?? []) {
      const id = m?.piEntryId
      if (typeof id !== 'string' || !id) continue
      if (seen.has(id)) dup.push(id)
      seen.add(id)
    }
  }
  return dup
}

// ── 文件注入（A3 追加/残尾、A4 同尺寸重写） ─────────────────────────

/** 生成一条合法 pi JSONL message entry（8 位 hex id；user 边界或 assistant 尾随）。 */
export function makeMessageEntry(role, text, id) {
  return {
    type: 'message',
    id: id ?? randomEntryId(),
    timestamp: Date.now(),
    message: { role, content: [{ type: 'text', text }] },
  }
}

export function randomEntryId() {
  // pi generateId 同形态：randomUUID().slice(0, 8)（设计 §3.1 entryId 实际实现形态核实）
  return crypto.randomUUID().replaceAll('-', '').slice(0, 8)
}

/** 追加一条完整 entry（带换行）到 jsonl 尾部。 */
export function appendEntry(jsonlFile, entry) {
  fs.appendFileSync(jsonlFile, `${JSON.stringify(entry)}\n`)
}

/** 把文件截断在最后一个换行处 + 追加半截 JSON 行（崩溃残尾形态，SI3）。返回残尾原文。 */
export function injectTruncatedTail(jsonlFile, entry) {
  const buf = fs.readFileSync(jsonlFile)
  const lastNewline = buf.lastIndexOf(10)
  const kept = lastNewline >= 0 ? buf.subarray(0, lastNewline + 1) : buf
  const half = JSON.stringify(entry).slice(0, Math.max(8, Math.floor(JSON.stringify(entry).length / 2)))
  fs.writeFileSync(jsonlFile, Buffer.concat([kept, Buffer.from(half, 'utf8')]))
  return half
}

/**
 * 同尺寸重写一个真实 user turn 的文本内容并恢复 mtime（A4：攻击只信 stat 的旧索引）。
 * 做法：定位最后一个完整 user message entry 行，等长替换其 text（截断/填充保持字节数），
 * mtime 用原值回写（fs.utimesSync）。返回 {rewrote, bytesBefore, bytesAfter}。
 */
export function rewriteTurnInPlaceKeepStat(jsonlFile) {
  const size = fs.statSync(jsonlFile).size
  const { mtimeMs, atimeMs } = fs.statSync(jsonlFile)
  // 逆序找最后一个 user message 行（1MB 窗口足够；41MB 尾部 turn 密度足够）
  const windowStart = Math.max(0, size - 1024 * 1024)
  const fh = fs.openSync(jsonlFile, 'r')
  let head
  try {
    const buf = Buffer.alloc(size - windowStart)
    fs.readSync(fh, buf, 0, buf.length, windowStart)
    head = buf.toString('utf8')
  } finally {
    fs.closeSync(fh)
  }
  const lines = head.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.type !== 'message' || row?.message?.role !== 'user') continue
    const content = row.message.content?.[0]
    if (content?.type !== 'text' || typeof content.text !== 'string') continue
    const marker = 'rewrite-probe-'
    let next = content.text
    if (next.includes(marker)) {
      // 二次改写：递增尾号保持字节数
      next = next.replace(/rewrite-probe-(\d+)/, (_, n) => marker + String(Number(n) + 1).padStart(n.length, '0'))
    } else if (content.text.length >= marker.length + 2) {
      next = marker + content.text.slice(marker.length)
    } else {
      continue // 文本太短无法等长改写
    }
    if (Buffer.byteLength(next, 'utf8') !== Buffer.byteLength(content.text, 'utf8')) continue
    row.message.content[0].text = next
    const newLine = JSON.stringify(row)
    if (Buffer.byteLength(newLine, 'utf8') !== Buffer.byteLength(line, 'utf8')) continue
    lines[i] = newLine
    const out = lines.join('\n')
    const patch = Buffer.from(out, 'utf8')
    const fd = fs.openSync(jsonlFile, 'r+')
    try {
      fs.writeSync(fd, patch, 0, patch.length, windowStart)
      fs.ftruncateSync(fd, windowStart + patch.length)
    } finally {
      fs.closeSync(fd)
    }
    fs.utimesSync(jsonlFile, new Date(atimeMs), new Date(mtimeMs))
    return { rewrote: true, bytesBefore: size, bytesAfter: fs.statSync(jsonlFile).size }
  }
  return { rewrote: false, bytesBefore: size, bytesAfter: size }
}

// ── turns.json 读取（A2 输出项） ─────────────────────────────────────

/** 读会话索引 sidecar（不存在返回 null）。 */
export function readTurnsJson(dataDir, sessionId) {
  const file = path.join(dataDir, 'ext-sessions', sessionId, 'history-index', 'turns.json')
  if (!fs.existsSync(file)) return null
  const raw = fs.readFileSync(file, 'utf8')
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* 损坏索引也是观测形态，返回 raw 供断言 */
  }
  return { file, bytes: Buffer.byteLength(raw, 'utf8'), turns: Array.isArray(parsed?.turns) ? parsed.turns.length : null, parsed, raw }
}

// ── V5 对照快照（新旧 runtime differential） ─────────────────────────

/**
 * 历史窗口稳定快照（V5 对照形状）：reply 顶层契约字段 + 逐条 message 的白名单字段
 * 深拷贝（role / piEntryId / toolCalls / segments / endedAt / content 摘要）。
 * totalTurnsEstimate 语义在索引路径改为精确值（设计 §3.1），对照时单独解释。
 */
export function snapshotHistoryWindow(historyReply) {
  const msgs = (historyReply?.messages ?? []).map((m) => {
    const out = {}
    for (const key of ['role', 'piEntryId', 'toolCalls', 'segments', 'endedAt', 'interrupted', 'isError']) {
      if (m && key in m) out[key] = structuredClone(m[key])
    }
    const content = m?.content
    out.contentDigest = typeof content === 'string' ? content : JSON.stringify(content ?? null)
    return out
  })
  return {
    sessionId: historyReply?.sessionId ?? null,
    messageCount: msgs.length,
    truncated: historyReply?.truncated ?? null,
    loadedTurns: historyReply?.loadedTurns ?? null,
    totalTurnsEstimate: historyReply?.totalTurnsEstimate ?? null,
    interrupted: historyReply?.interrupted ?? null,
    messages: msgs,
  }
}

/** 基线快照文件路径（ASSETS.md 登记；固定窗口与 cursor 窗口各一）。 */
export function baselineSnapshotFile(kind) {
  return path.join(BASELINE_ASSET_DIR, `v5-window-${kind}.json`)
}

/** 落盘基线快照（采集模式）。 */
export function writeBaselineSnapshot(kind, payload) {
  fs.mkdirSync(BASELINE_ASSET_DIR, { recursive: true })
  fs.writeFileSync(baselineSnapshotFile(kind), `${JSON.stringify(payload, null, 1)}\n`, 'utf8')
}

/** 读基线快照（改造后对照消费；缺失返回 null，调用方 uncovered 登记）。 */
export function readBaselineSnapshot(kind) {
  const file = baselineSnapshotFile(kind)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * 逐字段对照两份窗口快照：返回差异清单（字段路径 + 两侧值摘要）。
 * totalTurnsEstimate 的「下界 → 精确值」变化是设计内语义升级，不进差异清单
 *（调用方单独断言新旧值关系）；其余字段差异必须先归因（V5 通过标准）。
 */
export function diffHistorySnapshots(baseline, current) {
  const diffs = []
  const push = (pathStr, a, b) => diffs.push(`${pathStr}: 基线=${JSON.stringify(a)?.slice(0, 120)} 当前=${JSON.stringify(b)?.slice(0, 120)}`)
  for (const key of ['messageCount', 'truncated', 'loadedTurns', 'interrupted']) {
    if (JSON.stringify(baseline?.[key]) !== JSON.stringify(current?.[key])) push(key, baseline?.[key], current?.[key])
  }
  const n = Math.max(baseline?.messages?.length ?? 0, current?.messages?.length ?? 0)
  for (let i = 0; i < n; i++) {
    const a = baseline?.messages?.[i]
    const b = current?.messages?.[i]
    if (!a || !b) {
      push(`messages[${i}]`, a ? '存在' : '缺失', b ? '存在' : '缺失')
      continue
    }
    for (const key of ['role', 'piEntryId', 'contentDigest', 'toolCalls', 'segments', 'endedAt', 'interrupted', 'isError']) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) push(`messages[${i}].${key}`, a[key], b[key])
    }
  }
  return diffs
}

// ── V5 载体会话挑选（含工具调用 / compaction / 撤回 label 的真实会话） ──

/**
 * 扫描生产池挑 V5 对照载体：按 jsonl 内容特征打分（toolCalls / toolCall entry /
 * compaction entry / label 撤回 entry），命中特征最多者优先、体量适中（≤8MB，对照
 * 采集与复跑成本可控）。返回 {session, features} 或 null。
 */
export function pickDiffCarrierSession(prodRoot = PROD_DATA_DIR, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const pool = scanSessionPool(prodRoot).filter((s) => s.bytes <= maxBytes && s.bytes >= 200_000)
  const scored = []
  for (const s of pool) {
    const features = detectSessionFeatures(s.sessionFile)
    const score = Object.values(features).filter(Boolean).length
    if (score >= 2) scored.push({ session: s, features, score })
  }
  scored.sort((a, b) => b.score - a.score || b.session.bytes - a.session.bytes)
  return scored[0] ?? null
}

/** 会话特征探测（流式扫描，只读）。 */
export function detectSessionFeatures(jsonlFile) {
  const features = { toolCalls: false, compaction: false, revokedLabel: false, segments: false }
  let remaining = 32 * 1024 * 1024
  let carry = ''
  const CHUNK = 4 * 1024 * 1024
  const fh = fs.openSync(jsonlFile, 'r')
  try {
    while (remaining > 0 && (features.toolCalls === false || features.compaction === false || features.revokedLabel === false)) {
      const buf = Buffer.alloc(Math.min(CHUNK, remaining))
      const n = fs.readSync(fh, buf, 0, buf.length, null)
      if (n <= 0) break
      remaining -= n
      const text = carry + buf.toString('utf8')
      const lines = text.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        if (line.includes('"toolCall"') || line.includes('"tool_use"') || line.includes('"toolCalls"')) features.toolCalls = true
        if (line.includes('"compaction"') || line.includes('"compact"')) features.compaction = true
        if (line.includes('"label"')) features.revokedLabel = true
        if (line.includes('"segment"')) features.segments = true
      }
    }
  } finally {
    fs.closeSync(fh)
  }
  return features
}

// ── pi 子进程观测（A7：pi 退出不取消读取） ──────────────────────────

export { scanSessionPool, seedSessions, readRuntimePort, PROD_DATA_DIR } from './cold-switch-lib.mjs'
