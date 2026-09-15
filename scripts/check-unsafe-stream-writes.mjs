#!/usr/bin/env node
/**
 * check-unsafe-stream-writes.mjs —— 流写逃逸静态护栏（2026-09-04 runtime 整机崩溃事故护栏）。
 *
 * 事故：relay 对端半关闭后 `conn.write` 在 child stdout 'data' 回调里同步抛 EPIPE →
 * uncaughtException → 整机 graceful shutdown（全部 session 中断）。三层护栏：
 *   ① 源头修复：relay-registry writeFrame/endConn try 包裹 + conn error listener
 *   ② 运行时分级：index.ts uncaughtException 对流级错误码 log-continue（uncaught-policy）
 *   ③ 本脚本：防新增代码引入同类裸写点（静态扫描，pre-commit / CI 拦截）
 *
 * 规则（刻意保守——宁可漏报不误报，误报会逼人加豁免瓦解护栏）：
 *
 * R1 裸流写检测：packages/runtime/src 中流变量上的 `.write(`/`.end(` 调用必须被
 *    try 包裹（命中行向上 8 行窗口内存在 try 即视为已防护；窗口判定是保守近似，
 *    try 在窗口内但不包裹命中行时会漏放——接受，护栏方向是拦截"完全没想过防护"的新代码）。
 *    - 流变量清单：conn / socket / sock / probe / stdin / stdout / stderr（含 ?./!. 可选链形态）
 *      ⚠ 漏报面 = 本清单的命名约定：命名 ws / client / stream 等的流变量不在 R1 覆盖内
 *      （reviewer 心中留数，不要因本护栏绿而认定该类变量已防护）。
 *    - 排除：注释行；allowlist 文件豁免（相对路径 @ 行号）
 *
 * R2 socket 接收入口 error 挂载：文件定义 `handleXxxConnection(<var>: Socket)` 形态的
 *    方法/函数时，同文件必须存在 `<var>.on('error'`——socket 'error' 无 listener 时
 *    EventEmitter emit 直接 throw 成 uncaughtException（与 R1 同族，对端 RST 即触发）。
 *
 * R4 readline 转发逃逸：readline 会把 input 流的 'error' 转发到 interface 实例上
 *    re-emit（Node 文档 Interface 'error'）——文件中 `const <x> = createInterface(`
 *    时必须存在 `<x>.on('error'` / `<x>.once('error'`，否则转发成为独立 uncaughtException
 *    逃逸路径（conn 层 listener 挡不住，2026-09-04 事故审计实测发现）。
 *
 * 退出码：0 = 通过；1 = 违规（打印 文件:行 + 原因 + 恢复动作）。
 * allowlist 未命中条目打 ⚠ 告警（已失效/笔误/漂移，提示清理），不影响退出码。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 纯检测函数导出面（scripts/__tests__/check-unsafe-stream-writes.test.mjs 单测——
// S14：误报会污染 allowlist 治理，检测核心须机器锁定）。仅 CLI 直跑时执行 main()
export { scanFileLines, collectTsFiles, isCommentLine }

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const RUNTIME_SRC = join(ROOT, 'packages/runtime/src')

/** 行级豁免（相对路径@行号）。唯一权威源 = 同目录 allowlist 文件（随 git 跟踪，
 *  pre-commit / CI 无参调用自动读取；不存在 CLI 传参入口——双入口会导致
 *  「传参绿了但忘写文件 → CI 仍红」的登记断裂）。扫描结束对未命中条目打
 *  ⚠ 告警（已失效/笔误/漂移，请清理；不改退出码）。 */
const ALLOWLIST_FILE = join(__dirname, 'check-unsafe-stream-writes.allowlist.txt')
const allowlist = new Set()
const allowlistHits = new Set()
try {
  for (const line of readFileSync(ALLOWLIST_FILE, 'utf-8').split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('#')) allowlist.add(t)
  }
} catch {
  // allowlist 文件不存在 = 无豁免条目，属正常形态
}

/** 流变量写调用：conn.write( / stdin?.write( / sock!.end( 等形态。 */
const STREAM_WRITE_RE = /\b(conn|socket|sock|probe|stdin|stdout|stderr)[?!]?\.(write|end)\s*\(/
/** socket 接收入口定义：handleConnection(conn: Socket) 等形态。 */
const CONN_ENTRY_RE = /(\w+)\((\w+):\s*(?:net\.)?Socket\b/
/** try 开块（R1 豁免窗口；逐行测试，跨行注释形态不参与匹配）。 */
const TRY_RE = /^\s*try\s*\{/
/** readline interface 创建：const rl = createInterface( 形态。 */
const CREATE_INTERFACE_RE = /\b(?:const|let)\s+(\w+)\s*=\s*createInterface\s*\(/

/** 收集 .ts 文件（递归，排除 __tests__ / *.test.ts / .d.ts）。 */
function collectTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      collectTsFiles(full, out)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

/** 非注释行判定（strip 后以 // 、* 、/* 开头视为注释）。 */
function isCommentLine(line) {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** 文件内存在 `<var>.on('error'` listener 的判定（R2/R4 共用；acceptOnce 时同认
 *  `.once('error'`——R2 现行不认 once，该不对称是显式参数而非藏着的形态差异）。 */
function fileHasErrorListener(lines, varName, { acceptOnce = false } = {}) {
  return lines.some((l) => !isCommentLine(l) && (l.includes(`${varName}.on('error'`) || (acceptOnce && l.includes(`${varName}.once('error'`))))
}

const violations = []

/**
 * 单文件 R1/R2/R4 检测（纯函数：输入行数组与豁免集合，输出违规串数组）——
 * allowlistHits 命中回写由调用方容器承担（S14 抽出供单测）。
 */
function scanFileLines(rel, lines, allowlistSet, hitsOut) {
  const found = []
  // R1：裸流写检测
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return
    const m = line.match(STREAM_WRITE_RE)
    if (!m) return
    const loc = `${rel}@${i + 1}`
    if (allowlistSet.has(loc)) {
      hitsOut?.add(loc)
      return
    }
    // 豁免：向上 8 行窗口内有 try 开块
    const windowStart = Math.max(0, i - 8)
    for (let j = i; j >= windowStart; j--) {
      if (TRY_RE.test(lines[j])) return
    }
    found.push(
      `${loc}：流变量 \`${m[1]}.${m[2]}\` 裸调用无 try 防护——半关闭/destroyed 流上同步抛 EPIPE/ERR_STREAM_DESTROYED，事件回调中逃逸即 uncaughtException → 整机 shutdown（2026-09-04 事故形态）。恢复动作：try-catch 包裹（参照 relay-registry writeFrame/endConn）；确属 best-effort 误报形态则编辑 scripts/check-unsafe-stream-writes.allowlist.txt 登记 \`${loc}\` 并随本次 commit 提交`,
    )
  })

  // R2：socket 接收入口必须挂 error listener
  const entryDefs = new Set()
  lines.forEach((line) => {
    if (isCommentLine(line)) return
    const m = line.match(CONN_ENTRY_RE)
    if (!m) return
    if (!/Connection/i.test(m[1])) return
    entryDefs.add(m[2])
  })
  for (const varName of entryDefs) {
    const hasErrorListener = fileHasErrorListener(lines, varName)
    if (!hasErrorListener) {
      found.push(
        `${rel}：定义了 socket 接收入口但未挂 \`${varName}.on('error'\`——对端 RST（ECONNRESET）时 EventEmitter 无 listener 直接 throw → uncaughtException → 整机 shutdown。恢复动作：入口首行挂 error listener（destroy + warn，清理由 close 路径兜底，参照 relay-registry handleConnection）`,
      )
    }
  }

  // R4：readline 转发逃逸（input 流 error 被 re-emit 到 interface 实例上）
  const rlVars = new Set()
  for (const line of lines) {
    if (isCommentLine(line)) continue
    const m = line.match(CREATE_INTERFACE_RE)
    if (m) rlVars.add(m[1])
  }
  for (const rlVar of rlVars) {
    const hasErrorListener = fileHasErrorListener(lines, rlVar, { acceptOnce: true })
    if (!hasErrorListener) {
      found.push(
        `${rel}：\`const ${rlVar} = createInterface(...)\` 但未挂 \`${rlVar}.on('error'\`——readline 把 input 流 error 转发到 interface 实例 re-emit，无 listener 直接 throw → uncaughtException（conn 层 listener 挡不住，2026-09-04 事故审计实测）。恢复动作：\`${rlVar}.on('error', () => {})\` 吞转发（真实处置归 conn 层 listener）`,
      )
    }
  }
  return found
}

function main() {
  const files = collectTsFiles(RUNTIME_SRC)

  for (const file of files) {
    const rel = relative(ROOT, file)
    const lines = readFileSync(file, 'utf-8').split('\n')
    violations.push(...scanFileLines(rel, lines, allowlist, allowlistHits))
  }

  // allowlist 豁免命中提示（检测核心保持纯函数——命中回写 allowlistHits，观测输出归 CLI 层）
  for (const loc of allowlistHits) {
    console.log(`ℹ ${loc}：allowlist 豁免命中（流变量裸写，确认仍在 best-effort 形态）`)
  }

  // allowlist 生命周期告警：未命中条目 = 已失效（代码修复/删除）或登记笔误，提示清理。
  // 不改退出码——僵尸条目是审计噪声而非漏洞；漂移条目错误附着到同文件同行号新违规的
  // 窗口由「豁免命中提示行」承载观测（两路合起来覆盖条目全生命周期）。
  const staleEntries = [...allowlist].filter((e) => !allowlistHits.has(e))
  if (staleEntries.length > 0) {
    console.warn(`⚠ check-unsafe-stream-writes：${staleEntries.length} 条 allowlist 条目本次扫描未命中（已失效或笔误，请清理；allowlist 仅对 R1 生效，R2/R4 违规无豁免通道，须直接修复代码）：`)
    for (const e of staleEntries) console.warn(`  ⚠ ${e}`)
  }

  if (violations.length > 0) {
    console.error(`✗ check-unsafe-stream-writes：${violations.length} 处流写逃逸风险\n`)
    for (const v of violations) console.error(`  ✗ ${v}`)
    console.error('\n恢复动作：逐条加防护后重跑 node scripts/check-unsafe-stream-writes.mjs；确认误报/豁免形态时编辑 scripts/check-unsafe-stream-writes.allowlist.txt 登记 路径@行号（随 commit 提交，传参登记不生效）')
    process.exit(1)
  }

  console.log(`✓ check-unsafe-stream-writes：${files.length} 个文件扫描通过（R1 裸流写 / R2 socket error 挂载 / R4 readline 转发吞咽）`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(join(process.argv[1])).href
if (isMain) main()
