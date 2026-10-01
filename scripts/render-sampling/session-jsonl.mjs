// session JSONL 采样/断言辅助（渲染采样管道 ④⑤ 环节的新等待信号与断言面）。
//
// 定位：真机 LLM 节奏不可控，DOM 信号（eventually）之外的第二等待信号 = pi session JSONL
// 的 entry 命中/计数（如 submit-review 挂起出现、details.action 分源落盘）。同时承载
// 「计数 / 文案分源 / JSON 路径」三类机器断言的读取面（plan-state entry、tool details、
// 合成 user 消息等）。场景专属断言谓词由验收脚本自带，本库只做通用读取/搜索/等待。
//
// 纪律：
// - 只读。禁止任何写/触碰 session 文件（AGENTS 关键规则 #6——pi 首条 flush 前文件可能
//   不存在，读取侧必须容忍 ENOENT，等待循环而非创建文件）。
// - 真实数据目录禁触（fail-safe：解析后位于 ~/.taiji 树内（非 ~/.taiji-dev 树）即抛错）。
// - entry 解析容错：坏行跳过并留证（badLines），不 throw——pi append 中途读到半行属常态。
//
// 资产纪律见 docs/testing/render-sampling.md（closeout 回写/删减规则）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** 真实数据目录守卫：路径解析后落在 ~/.taiji 树内（~/.taiji-dev 树除外）即抛错。 */
export function assertNotRealDataDir(path) { // oe-exempt:20261001:wip:render-sampling ④⑤ 在册组件（docs/testing/render-sampling.md 等待信号+断言读取面），验收脚本接线 wip
  const real = join(homedir(), '.taiji')
  const abs = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path)
  if (abs === real || abs.startsWith(real + sep)) {
    throw new Error(`session-jsonl: 拒绝读取真实数据目录 ${abs}（AGENTS 测试/采样禁触 ~/.taiji）`)
  }
  return abs
}

/**
 * 读单个 session JSONL → { entries, badLines }。文件不存在返回空集（不创建文件）。
 * 每行一个 JSON entry；坏行（半行/损坏）记入 badLines 供断言留证。
 */
export function readSessionFile(path) { // oe-exempt:20261001:wip:render-sampling ④⑤ 在册组件（docs/testing/render-sampling.md 等待信号+断言读取面），验收脚本接线 wip
  const abs = assertNotRealDataDir(path)
  if (!existsSync(abs)) return { entries: [], badLines: [], missing: true }
  const entries = []
  const badLines = []
  const lines = readFileSync(abs, 'utf-8').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      badLines.push({ lineNo: i + 1, head: line.slice(0, 120) })
    }
  }
  return { entries, badLines, missing: false }
}

/** 枚举目录下 .jsonl（默认递归——pi 按 cwd 子目录布局）。返回 [{path, mtimeMs}] 按 mtime 降序。 */
export function sessionFiles(dir, { recursive = true } = {}) {
  const abs = assertNotRealDataDir(dir)
  if (!existsSync(abs)) return []
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        if (recursive) walk(p)
      } else if (name.endsWith('.jsonl')) {
        out.push({ path: p, mtimeMs: st.mtimeMs })
      }
    }
  }
  walk(abs)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 最新 session 文件（断言方在操作前后取同一 path 锁定会话，防跨会话串读）。 */
export function newestSessionFile(dir, opts) { // oe-exempt:20261001:wip:render-sampling ④⑤ 在册组件（docs/testing/render-sampling.md 等待信号+断言读取面），验收脚本接线 wip
  const files = sessionFiles(dir, opts)
  return files[0]?.path ?? null
}

/**
 * 深度搜索 JSON 值。pred(value, pathString) 命中返回 {path, value} 列表。
 * pathString 形如 `details.action` / `content[0].text`——JSON 路径断言的证据形态。
 */
export function deepFind(value, pred, path = '$') { // oe-exempt:20261001:wip:render-sampling ④⑤ 在册组件（docs/testing/render-sampling.md 等待信号+断言读取面），验收脚本接线 wip
  const hits = []
  const visit = (v, p) => {
    if (pred(v, p)) hits.push({ path: p, value: v })
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${p}[${i}]`))
    } else if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) visit(item, `${p}.${k}`)
    }
  }
  visit(value, path)
  return hits
}

/** 抽取 entry 内全部字符串（工具 result 文本 / 消息文本 / steer 文案的分源 grep 面）。 */
export function collectText(value) { // oe-exempt:20261001:wip:render-sampling ④⑤ 在册组件（docs/testing/render-sampling.md 等待信号+断言读取面），验收脚本接线 wip
  return deepFind(value, (v) => typeof v === 'string')
    .map((h) => h.value)
    .join('\n')
}

/**
 * 通用 match（机器断言的模式面）：
 *   { customType }      — custom entry 类型（plan-state 等）
 *   { deepAction }      — details.action 值（complete-later / complete-cancelled / abort / …）
 *   { deepSource }      — details.source 值（reset | external）；与 deepAction 联用做分源断言
 *   { textIncludes }    — entry 全文包含（文案分源）
 *   { textRegex }       — entry 全文正则（计数/模板文案）
 *   { where(entry) }    — 自定义谓词（场景脚本自带）
 * 多键 AND。
 */
export function matches(entry, match = {}) {
  if (match.customType !== undefined) {
    const hits = deepFind(entry, (v) => v === match.customType && typeof v === 'string')
    if (!hits.some((h) => h.path.endsWith('.customType'))) return false
  }
  if (match.deepAction !== undefined) {
    const hits = deepFind(entry, (v) => v && v.action === match.deepAction)
    if (hits.length === 0) return false
  }
  if (match.deepSource !== undefined) {
    const hits = deepFind(entry, (v) => v && v.source === match.deepSource)
    if (hits.length === 0) return false
  }
  if (match.textIncludes !== undefined && !collectText(entry).includes(match.textIncludes)) return false
  if (match.textRegex !== undefined && !new RegExp(match.textRegex).test(collectText(entry))) return false
  if (typeof match.where === 'function' && !match.where(entry)) return false
  return true
}

/** 命中 entry 列表。 */
export function findMatches(entries, match) { // oe-exempt:20261001:wip:render-sampling ④⑤ 在册组件（docs/testing/render-sampling.md 等待信号+断言读取面），验收脚本接线 wip
  return entries.filter((e) => matches(e, match))
}

/** 命中计数（计数断言口径）。 */
export function countMatches(entries, match) { // oe-exempt:20261001:wip:render-sampling ④⑤ 在册组件（docs/testing/render-sampling.md 等待信号+断言读取面），验收脚本接线 wip
  return findMatches(entries, match).length
}

/** 命中项的 JSON 路径证据（如 details 所在路径 + 值），断言报告留证用。 */
export function matchEvidence(entries, match, limit = 5) { // oe-exempt:20261001:wip:render-sampling ④⑤ 在册组件（docs/testing/render-sampling.md 等待信号+断言读取面），验收脚本接线 wip
  return findMatches(entries, match).slice(0, limit).map((e) => {
    const actionHits = deepFind(e, (v) => v && typeof v === 'object' && typeof v.action === 'string')
    return {
      actionPaths: actionHits.map((h) => `${h.path}.action=${h.value.action}`),
      textHead: collectText(e).slice(0, 160),
    }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 等待信号（管道 ④ 环节新姿势）：轮询 session JSONL 直到 match 计数 ≥ minCount。
 * 文件不存在/不足均视为未就绪继续等（pi 延迟写入纪律）；超时返回末态计数，由断言方判定。
 */
export async function waitForMatch({ file, match, minCount = 1, timeoutMs = 600000, pollMs = 1000 }) { // oe-exempt:20261001:wip:render-sampling ④⑤ 在册组件（docs/testing/render-sampling.md 等待信号+断言读取面），验收脚本接线 wip
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { entries, badLines } = readSessionFile(file)
    const found = findMatches(entries, match)
    if (found.length >= minCount) return { ok: true, count: found.length, entries: entries.length, badLines }
    if (Date.now() > deadline) return { ok: false, count: found.length, entries: entries.length, badLines }
    await sleep(pollMs)
  }
}
