#!/usr/bin/env node
/**
 * verify-doctor —— capabilities/ 与 scripts/ 的一致性守卫（零依赖，可进 pre-commit 之外的本地自检）。
 *
 * 检查项（每条独立、可定位到文件与行）：
 *  1. 契约 id 全覆盖：`capabilities/API-CONTRACT.md §6` 的每个 id 必须在某个 `capabilities/*.md` 里作为
 *     `# <id> ·` 或 `## <id> ·` 标题出现（文档存在性）。
 *  2. 文档无野 id：capabilities 文档里的 capability 标题必须都在契约 §6 里。
 *  3. 覆盖矩阵引用有效：`P0-P1-COVERAGE.md` 里出现的每个反引号 capability id 必须存在。
 *  4. faux 剧本可解析：`fixtures/faux-responses/*.json` 必须 JSON.parse 成功，且形状合规
 *     （数组或 model-keyed 对象；元素含 text/thinking/toolCalls 至少一项）。
 *  5. ask-user schema：任何 `name: "ask_user"` 的 toolCall，其每题 `options` 长度必须 ∈ [2,4]
 *     （`extensions/universal/ask-user/src/types.ts` 的 QuestionSchema 约束）。
 *  6. scenario 契约：`scenarios/*.mjs` 必须有 `export const meta`（含 id/priority/covers/requires）
 *     与 `export async function run`；`covers` 里的 id 必须都在契约里。
 *  7. run.mjs evidence 字段名冻结：`evidence.mjs` 的 summary 行必须含
 *     step/command/exitCode/stats/channel/at 六个键名（防私自改名破坏 dev-flow 消费）。
 *  8. 脚本语法：所有 .mjs 通过 `node --check`。
 *
 * 用法：
 *   node scripts/verify-doctor.mjs                    # 人类可读输出
 *   node scripts/verify-doctor.mjs --json             # 机读
 *   node scripts/verify-doctor.mjs --quiet            # 只输出 FAIL 行 + 汇总（CI/钩子用）
 * 退出码：0 = 全过；1 = 有 FAIL。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..')
const CAP_DIR = path.join(SKILL_DIR, 'capabilities')

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const quiet = argv.includes('--quiet')

const results = []
const ok = (name, detail = '') => results.push({ name, status: 'PASS', detail })
const bad = (name, detail, hint = '') => results.push({ name, status: 'FAIL', detail, hint })
const warn = (name, detail, hint = '') => results.push({ name, status: 'WARN', detail, hint })

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

// ── 契约 id 提取（§6 到 § "CLI 别名" 之前） ─────────────────────────
const contractPath = path.join(CAP_DIR, 'API-CONTRACT.md')
const contract = readIfExists(contractPath)
if (!contract) {
  bad('契约文件存在', contractPath)
} else {
  ok('契约文件存在', contractPath)
}

const contractIds = (() => {
  if (!contract) return []
  const start = contract.indexOf('## 6.')
  if (start === -1) return []
  const tail = contract.slice(start)
  // 到下一个顶层 `## ` 标题之前（§6 内含多个 `###` 子段，全部计入——v1.1 衍生 id 段也在其中）
  const end = tail.search(/\n## /)
  const body = end === -1 ? tail : tail.slice(0, end)
  // 只收「纯 id 列表行」（形如 `` `a.b` · `c.d` · ... ``）：散文里提到的
  // 文件名/脚本名（vp.mjs / model.md / shell.grep 等）不是契约 id，不能污染清单。
  const ids = []
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('`')) continue
    if (!/^(`[^`]+`)( · `[^`]+`)*$/.test(t)) continue
    for (const m of t.matchAll(/`([^`]+)`/g)) {
      if (/^[a-z][a-z-]*\.[a-z-]+$/.test(m[1])) ids.push(m[1])
    }
  }
  return [...new Set(ids)]
})()

// ── 1/2. 文档在 ↔ 契约 ───────────────────────────────────────────
const capDocFiles = fs.existsSync(CAP_DIR)
  ? fs.readdirSync(CAP_DIR).filter((f) => f.endsWith('.md') && !/^(API-CONTRACT|P0-P1-COVERAGE|README)\.md$/.test(f))
  : []
const capDocs = capDocFiles.map((f) => ({ file: f, text: readIfExists(path.join(CAP_DIR, f)) ?? '' }))

const docTitles = []
for (const d of capDocs) {
  for (const m of d.text.matchAll(/^#{1,2} ([a-z][a-z-]*\.[a-z-]+) ·/gm)) {
    docTitles.push({ id: m[1], file: d.file })
  }
}
const documentedIds = new Set(docTitles.map((t) => t.id))

const missingDocs = contractIds.filter((id) => !documentedIds.has(id))
if (missingDocs.length === 0) {
  ok('契约 id 全部有 capability 文档', `${contractIds.length} 个 id / ${capDocFiles.length} 份文档`)
} else {
  bad('契约 id 全部有 capability 文档', `缺少 ${missingDocs.length} 个：${missingDocs.join(', ')}`, '为每个 id 在对应域文档里补 `# <id> · <中文名>` 段落')
}

const wildIds = docTitles.filter((t) => !contractIds.includes(t.id))
if (wildIds.length === 0) {
  ok('文档无契约外 id')
} else {
  bad('文档无契约外 id', wildIds.map((w) => `${w.file}: ${w.id}`).join(', '), '先改 API-CONTRACT.md §6 登记，再写文档')
}

// ── 3. 覆盖矩阵引用有效（只验收矩阵表的「capability 列」= 第 3 个单元格） ────────
const coveragePath = path.join(CAP_DIR, 'P0-P1-COVERAGE.md')
const coverage = readIfExists(coveragePath)
if (!coverage) {
  bad('覆盖矩阵存在', coveragePath)
} else {
  // 表格行解析：`| # | 功能面 | capability id | 剧本 | 状态 | 备注 |` —— 取第 3 列
  // （不要把备注里提到的 RPC 名 / 文件名当 capability id：只收 capability 列）
  const rows = coverage
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.split('|').map((c) => c.trim()))
  const referenced = []
  for (const cells of rows) {
    if (cells.length < 4) continue
    const capCell = cells[3]
    if (!capCell || /^-+$/.test(capCell)) continue
    for (const m of capCell.matchAll(/`([a-z][a-z-]*\.[a-z-]+)`/g)) referenced.push(m[1])
  }
  const uniqReferenced = [...new Set(referenced)]
  const invalid = uniqReferenced.filter((id) => !contractIds.includes(id))
  if (invalid.length === 0) {
    ok('覆盖矩阵 capability 列引用有效', `${uniqReferenced.length} 个引用`)
  } else {
    bad(
      '覆盖矩阵 capability 列引用有效',
      `契约外引用：${invalid.join(', ')}`,
      '覆盖矩阵的 capability 列只能引用契约已登记的 id（未登记的先改 API-CONTRACT §6）',
    )
  }
  // 状态枚举：只认状态列（第 5 列）里的 **`xxx`**
  const allowedStates = new Set(['scenario', 'capability-only', 'reuse-e2e', 'unreachable'])
  const strayStates = []
  for (const cells of rows) {
    if (cells.length < 6) continue
    const stateCell = cells[5]
    if (!stateCell || /^-+$/.test(stateCell)) continue
    // 状态列可能是 `**`scenario`**` 或 `**`scenario`**（...）`
    const m = stateCell.match(/\*\*`([^`]+)`\*\*/)
    if (!m) continue
    if (!allowedStates.has(m[1])) strayStates.push(m[1])
  }
  if (strayStates.length === 0) {
    ok('覆盖矩阵状态枚举合规', '状态列只用了冻结枚举')
  } else {
    bad(
      '覆盖矩阵状态枚举合规',
      `出现枚举外状态：${[...new Set(strayStates)].join(', ')}`,
      '状态只允许 scenario / capability-only / reuse-e2e / unreachable',
    )
  }
  // 反向对账：契约里的 P0/P1 相关 id 必须至少在矩阵里出现一次（防空行）
  const coverageSet = new Set(uniqReferenced)
  const criticalIds = contractIds.filter((id) => !/^evidence\.|^protocol\./.test(id))
  const notInMatrix = criticalIds.filter((id) => !coverageSet.has(id))
  // 注意：覆盖矩阵按「功能面」聚合（一行可含多个 id），所以不要求一 id 一行——
  // 这里只做 WARN 提示（不判 FAIL），真正的判定是「P0/P1 每一行都有 capability 归属」。
  if (notInMatrix.length === 0) {
    ok('契约 id 均在覆盖矩阵出现', `${criticalIds.length} 个（已排除 evidence/protocol 基础层）`)
  } else {
    warn(
      '契约 id 未出现在覆盖矩阵',
      `${notInMatrix.length} 个：${notInMatrix.join(', ')}`,
      '若它们是被某个功能面聚合覆盖（属正常），忽略；若是新功能面，补进 P0-P1-COVERAGE.md',
    )
  }
}

// ── 4/5. faux 剧本 ───────────────────────────────────────────────
const fixturesDir = path.join(SKILL_DIR, 'fixtures', 'faux-responses')
if (!fs.existsSync(fixturesDir)) {
  bad('faux 剧本目录存在', fixturesDir)
} else {
  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))
  const parseErrors = []
  const shapeErrors = []
  const askUserErrors = []
  for (const f of files) {
    const raw = readIfExists(path.join(fixturesDir, f))
    let parsed
    try {
      parsed = JSON.parse(raw ?? '')
    } catch (e) {
      parseErrors.push(`${f}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const isQueue = Array.isArray(parsed)
    const isKeyed = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    if (!isQueue && !isKeyed) {
      shapeErrors.push(`${f}: 既不是数组也不是 model-keyed 对象`)
      continue
    }
    // model-keyed 形态允许 `_note` 元数据键（非模型键，不参与步骤校验）
    const steps = isQueue ? parsed : Object.entries(parsed).filter(([k]) => !k.startsWith('_')).flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    if (!Array.isArray(steps) || steps.length === 0) {
      shapeErrors.push(`${f}: 步骤为空`)
      continue
    }
    steps.forEach((s, i) => {
      if (!s || typeof s !== 'object') {
        shapeErrors.push(`${f}[${i}]: 不是对象`)
        return
      }
      if (s.text === undefined && s.thinking === undefined && s.toolCalls === undefined) {
        shapeErrors.push(`${f}[${i}]: 缺 text/thinking/toolCalls`)
      }
      for (const tc of s.toolCalls ?? []) {
        if (tc.name !== 'ask_user') continue
        const questions = tc.args?.questions ?? []
        if (questions.length === 0) {
          askUserErrors.push(`${f}[${i}]: ask_user 无 questions`)
        }
        questions.forEach((q, qi) => {
          const n = Array.isArray(q.options) ? q.options.length : 0
          if (n < 2 || n > 4) {
            askUserErrors.push(`${f}[${i}].q${qi}「${q.header ?? '?'}」options=${n}（schema 要求 2..4）`)
          }
          if (questions.length > 1 && !q.header) {
            askUserErrors.push(`${f}[${i}].q${qi}: 多题时每题必须带 header`)
          }
        })
      }
    })
  }
  if (parseErrors.length === 0) ok('faux 剧本 JSON 可解析', `${files.length} 个文件`)
  else bad('faux 剧本 JSON 可解析', parseErrors.join('; '), 'JSON 不允许注释')

  if (shapeErrors.length === 0) ok('faux 剧本形状合规')
  else bad('faux 剧本形状合规', shapeErrors.join('; '), 'step 需含 text / thinking / toolCalls 至少一项')

  if (askUserErrors.length === 0) ok('faux ask_user schema 合规', 'options ∈ [2,4]、多题带 header')
  else bad('faux ask_user schema 合规', askUserErrors.join('; '), '见 extensions/universal/ask-user/src/types.ts QuestionSchema')
}

// ── 6. scenario 契约 ─────────────────────────────────────────────
const scenDir = path.join(SKILL_DIR, 'scenarios')
if (!fs.existsSync(scenDir)) {
  bad('scenarios 目录存在', scenDir)
} else {
  const scenFiles = fs.readdirSync(scenDir).filter((f) => f.endsWith('.mjs'))
  const problems = []
  for (const f of scenFiles) {
    const text = readIfExists(path.join(scenDir, f)) ?? ''
    if (!/export const meta\s*=/.test(text)) problems.push(`${f}: 缺 export const meta`)
    if (!/export async function run\s*\(/.test(text)) problems.push(`${f}: 缺 export async function run`)
    const idMatch = text.match(/id:\s*'([^']+)'/)
    if (!idMatch) problems.push(`${f}: meta.id 缺失`)
    const coversMatch = text.match(/covers:\s*\[([^\]]*)\]/)
    if (!coversMatch) {
      problems.push(`${f}: meta.covers 缺失`)
    } else {
      const covers = [...coversMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
      const unknown = covers.filter((c) => !contractIds.includes(c))
      if (unknown.length) problems.push(`${f}: covers 含契约外 id ${unknown.join(',')}`)
    }
    if (!/requires:\s*\[/.test(text)) problems.push(`${f}: meta.requires 缺失`)
  }
  if (problems.length === 0) ok('scenario 契约合规', `${scenFiles.length} 个剧本`)
  else bad('scenario 契约合规', problems.join('; '), '按 API-CONTRACT §3 的 meta 形状补齐')
}

// ── 7. evidence 字段名冻结 ───────────────────────────────────────
const evPath = path.join(SCRIPT_DIR, 'lib', 'evidence.mjs')
const evText = readIfExists(evPath)
if (!evText) {
  bad('evidence.mjs 存在', evPath)
} else {
  const required = ['step', 'command', 'exitCode', 'stats', 'channel', 'at']
  const missingKeys = required.filter((k) => !new RegExp(`\\b${k}\\b`).test(evText))
  if (missingKeys.length === 0) ok('summary.jsonl 字段名冻结', required.join('/'))
  else bad('summary.jsonl 字段名冻结', `缺键名：${missingKeys.join(', ')}`, 'dev-flow D3 消费这六个键，改名会静默破坏对接')
  if (/verdict\s*[:=]\s*['"]?(status)/.test(evText)) {
    bad('verdict 不写 status 字段', 'evidence.mjs 出现 status 承载', 'dev-flow 契约要求 verdict ∈ pass|fail|degraded，禁写 status')
  } else {
    ok('verdict 不写 status 字段')
  }
}

// ── 8. 语法检查 ──────────────────────────────────────────────────
const mjsFiles = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (e.name.endsWith('.mjs')) mjsFiles.push(full)
  }
}
walk(SCRIPT_DIR)
const syntaxFails = []
for (const f of mjsFiles) {
  const r = spawnSync('node', ['--check', f], { encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) syntaxFails.push(`${path.relative(SKILL_DIR, f)}: ${(r.stderr || '').split('\n')[0]}`)
}
if (syntaxFails.length === 0) ok('脚本语法', `${mjsFiles.length} 个 .mjs`)
else bad('脚本语法', syntaxFails.join('; '))

// ── 汇总 ─────────────────────────────────────────────────────────
const fails = results.filter((r) => r.status === 'FAIL')
const warns = results.filter((r) => r.status === 'WARN')
const summary = { ok: fails.length === 0, total: results.length, failed: fails.length, warned: warns.length, checks: results }

if (asJson) {
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} else {
  for (const r of results) {
    if (quiet && r.status === 'PASS') continue
    process.stdout.write(`${r.status}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}\n`)
    if (r.status === 'FAIL' && r.hint) process.stdout.write(`      [FIX] ${r.hint}\n`)
    if (r.status === 'WARN' && r.hint) process.stdout.write(`      [NOTE] ${r.hint}\n`)
  }
  process.stdout.write(
    `\n${fails.length === 0 ? 'GREEN' : 'RED'}  ${results.length - fails.length - warns.length}/${results.length} 通过` +
      `${warns.length ? `，${warns.length} 提示` : ''}\n`,
  )
}
process.exit(fails.length === 0 ? 0 : 1)
