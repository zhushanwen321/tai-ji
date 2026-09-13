#!/usr/bin/env node
/**
 * check-pi-semantics.mjs —— pi 语义依赖登记表（docs/pi-semantics.json）漂移守卫（D6 守卫层，U7a）。
 *
 * 背景：xyz-agent 对 pi 私有语义的依赖此前只有人读登记（troubleshooting 观察项），
 * pi 升级后假设批量过期无人知（2026-08-20 登记思考钳制、8-27 照样出事的实证）。
 * 本脚本把登记表变成机器防线，三段检查：
 *
 * 1. registry schema 合法：docs/pi-semantics.json 为条目数组，逐条校验
 *    id（PS-xx 格式且唯一）/ claim / piAnchor[]（pkg ∈ pi 三包、distPath、symbol）/
 *    guard（probe 须带 test 路径；observe 须带 note）/ verifiedWith。
 * 2. 探针存在性：每条 guard.type === "probe" 的 test 路径必须真实存在（相对仓库根）。
 * 3. 四包版本门禁：pi-coding-agent 实装 === pi-ai 实装 === pi-agent-core 实装
 *    === packages/runtime/package.json 的 pi-ai pin（多包一致性是防分裂必选项：
 *    pnpm 允许多版本共存且 frozen-lockfile 不报错，pi bump 漏改 runtime pin 时
 *    离线计算与探针 import 旧版 pi-ai、pi 子进程已是新版，单包门禁全程绿灯）。
 *    - runtime pin 缺失：WARN 不 fail（U5 能力注册表未合入时属预期；合入后自动纳入门禁）。
 *    - 四者一致但 ≠ 条目 verifiedWith：fail 并列出待重验条目与重验命令。
 *
 * 用法：node scripts/check-pi-semantics.mjs [--root <dir>]
 *   --root 指向一个含 docs/pi-semantics.json / packages/runtime/package.json /
 *   node_modules/@earendil-works/* 的目录结构（默认仓库根；fixture 自测用）。
 *
 * 零第三方依赖（node:fs/node:path/node:child_process）。退出码：0 = 通过（允许含 WARN）；1 = 违规。
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = join(__dirname, '..')

// ── --root 参数解析（fixture 自测入口）────────────────────────────────
let ROOT = DEFAULT_ROOT
const rootIdx = process.argv.indexOf('--root')
if (rootIdx !== -1) {
  const val = process.argv[rootIdx + 1]
  if (!val || val.startsWith('--')) {
    console.error('用法: node scripts/check-pi-semantics.mjs [--root <dir>]（--root 须带目录参数）')
    process.exit(1)
  }
  ROOT = val
}

const REGISTRY_FILE = join(ROOT, 'docs', 'pi-semantics.json')
const RUNTIME_PKG_FILE = join(ROOT, 'packages', 'runtime', 'package.json')
const PI_SCOPE = '@earendil-works'
const PI_PKGS = ['pi-coding-agent', 'pi-ai', 'pi-agent-core']
const RUNTIME_PIN_NAME = `${PI_SCOPE}/pi-ai`

let failed = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failed = 1
}
const warn = (msg) => console.warn(`  ⚠ ${msg}`)

// ── 0. registry 可读 ─────────────────────────────────────────────────
if (!existsSync(REGISTRY_FILE)) {
  fail(`登记表不存在: ${REGISTRY_FILE}（U7a 交付物缺失）——恢复动作：从 docs/architecture/pi-boundary-reliability.md 附录 A 恢复 pi-semantics.json 后重跑 node scripts/check-pi-semantics.mjs`)
  process.exit(1)
}
let entries
try {
  entries = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'))
} catch (e) {
  fail(`登记表 JSON 解析失败: ${e.message}——恢复动作：修正 docs/pi-semantics.json 语法后重跑`)
  process.exit(1)
}

// ── 1. schema 合法性 ─────────────────────────────────────────────────
const isNonEmptyStr = (v) => typeof v === 'string' && v.trim() !== ''
const ID_RE = /^PS-\d{2,3}$/
const seenIds = new Set()

if (!Array.isArray(entries) || entries.length === 0) {
  fail(`登记表必须是条目数组（当前 ${Array.isArray(entries) ? `仅 ${entries.length} 条` : typeof entries}）——恢复动作：按附录 A（docs/architecture/pi-boundary-reliability.md）补齐 PS 条目后重跑`)
  process.exit(1)
}

for (const entry of entries) {
  const id = entry?.id ?? '(缺 id 字段)'
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    fail(`条目 ${id} 必须是对象——恢复动作：对照附录 A 修正该条目结构`)
    continue
  }
  if (!isNonEmptyStr(entry.id) || !ID_RE.test(entry.id)) {
    fail(`条目 ${JSON.stringify(entry.id)} 的 id 必须匹配 ${ID_RE}——恢复动作：按 PS-xx 两位编号修正 id`)
    continue
  }
  if (seenIds.has(entry.id)) {
    fail(`条目 ${entry.id} 重复登记——恢复动作：合并或改编号，一个语义断言一个条目`)
  }
  seenIds.add(entry.id)

  if (!isNonEmptyStr(entry.claim)) {
    fail(`条目 ${entry.id} 缺非空 claim（语义断言正文）——恢复动作：从附录 A 表格「语义断言」列补齐`)
  }

  if (!Array.isArray(entry.piAnchor) || entry.piAnchor.length === 0) {
    fail(`条目 ${entry.id} 缺 piAnchor（非空数组）——恢复动作：从附录 A「pi 锚点」列补齐 {pkg, distPath, symbol}`)
  } else {
    for (const anchor of entry.piAnchor) {
      if (typeof anchor !== 'object' || anchor === null) {
        fail(`条目 ${entry.id} 的 piAnchor 项必须是对象`)
        continue
      }
      if (!PI_PKGS.includes(anchor.pkg)) {
        fail(`条目 ${entry.id} 的 piAnchor.pkg 必须是 ${PI_PKGS.join(' / ')} 之一（当前 ${JSON.stringify(anchor.pkg)}）——恢复动作：修正 pkg 名`)
      }
      if (!isNonEmptyStr(anchor.distPath) || anchor.distPath.startsWith('/')) {
        fail(`条目 ${entry.id} 的 piAnchor.distPath 必须是包内相对路径（当前 ${JSON.stringify(anchor.distPath)}）——恢复动作：改为 dist/ 开头的相对路径`)
      }
      if (!isNonEmptyStr(anchor.symbol)) {
        fail(`条目 ${entry.id} 的 piAnchor.symbol 缺失——恢复动作：补齐锚点符号名（函数/分支/字段）`)
      }
    }
  }

  const guard = entry.guard
  if (typeof guard !== 'object' || guard === null) {
    fail(`条目 ${entry.id} 缺 guard 对象——恢复动作：按附录 A「守卫」列补 {type:"probe",test} 或 {type:"observe",note}`)
  } else if (guard.type === 'probe') {
    if (!isNonEmptyStr(guard.test) || !guard.test.endsWith('.test.ts')) {
      fail(`条目 ${entry.id} 的 guard.type=probe 必须带 .test.ts 测试路径（当前 ${JSON.stringify(guard.test)}）——恢复动作：补齐探针测试路径`)
    }
  } else if (guard.type === 'observe') {
    if (!isNonEmptyStr(guard.note)) {
      fail(`条目 ${entry.id} 的 guard.type=observe 必须带 note（处置说明）——恢复动作：补齐观察项处置建议`)
    }
  } else {
    fail(`条目 ${entry.id} 的 guard.type 必须是 probe / observe（当前 ${JSON.stringify(guard.type)}）——恢复动作：按附录 A 守卫列修正分型`)
  }

  if (!isNonEmptyStr(entry.verifiedWith) || !/^\d+\.\d+\.\d+/.test(entry.verifiedWith)) {
    fail(`条目 ${entry.id} 的 verifiedWith 必须是版本号字符串（当前 ${JSON.stringify(entry.verifiedWith)}）——恢复动作：填实装 pi 版本（npm ls ${PI_SCOPE}/pi-coding-agent）`)
  }
}

// ── 2. probe 探针文件存在性 ─────────────────────────────────────────
let probeCount = 0
for (const entry of entries) {
  if (typeof entry === 'object' && entry?.guard?.type === 'probe') {
    probeCount++
    const testPath = entry.guard.test
    if (isNonEmptyStr(testPath)) {
      if (!existsSync(join(ROOT, testPath))) {
        fail(`条目 ${entry.id} 的探针测试不存在: ${testPath}——恢复动作：补建该探针文件，或修正 guard.test 指向真实路径（探针范式见 packages/runtime/src/infra/pi/__tests__/pi-paths-config-dir-contract.test.ts）`)
      }
    }
  }
}

// ── 3. 四包版本门禁 ─────────────────────────────────────────────────
/** 读 <root>/node_modules/@earendil-works/<pkg>/package.json 的 version（缺失返回 undefined）。 */
function installedVersion(pkg) {
  const file = join(ROOT, 'node_modules', PI_SCOPE, pkg, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')).version
  } catch {
    return `(不可解析: ${file})`
  }
}

const installed = {}
for (const pkg of PI_PKGS) installed[pkg] = installedVersion(pkg)

const missingPkgs = PI_PKGS.filter((p) => installed[p] === undefined)
if (missingPkgs.length > 0) {
  fail(
    `node_modules 缺 pi 实装: ${missingPkgs.map((p) => `${PI_SCOPE}/${p}`).join(', ')}——恢复动作：在仓库根执行 pnpm install 后重跑 node scripts/check-pi-semantics.mjs`,
  )
} else {
  const versions = new Set(Object.values(installed))
  if (versions.size > 1) {
    const detail = PI_PKGS.map((p) => `${PI_SCOPE}/${p}=${installed[p]}`).join('，')
    const ids = entries.map((e) => e?.id).filter(Boolean).join('、')
    fail(
      `pi 三包实装版本不一致: ${detail}——恢复动作：同步 bump 各声明（根 package.json + packages/runtime/package.json pin）到同一版本后 pnpm install 重装，并重跑 node scripts/check-pi-semantics.mjs 与探针族（分裂波及登记表全部 ${entries.length} 条：${ids}）`,
    )
  } else {
    const common = [...versions][0]

    // runtime 的 pi-ai pin：U5 未合入时缺失属预期 → WARN 不 fail
    let runtimePin
    if (existsSync(RUNTIME_PKG_FILE)) {
      try {
        const pkg = JSON.parse(readFileSync(RUNTIME_PKG_FILE, 'utf-8'))
        runtimePin = pkg.dependencies?.[RUNTIME_PIN_NAME] ?? pkg.devDependencies?.[RUNTIME_PIN_NAME]
      } catch (e) {
        fail(`packages/runtime/package.json 不可解析: ${e.message}——恢复动作：修正 JSON 语法后重跑`)
      }
    } else {
      fail(`packages/runtime/package.json 不存在: ${RUNTIME_PKG_FILE}——恢复动作：确认 --root 指向仓库根`)
    }
    if (runtimePin === undefined) {
      warn(
        `packages/runtime/package.json 缺 ${RUNTIME_PIN_NAME} pin（实装三包为 ${common}）——U5（能力注册表）未合入时属预期，此处仅提示不拦截；恢复动作：等 U5 合入，或在 dependencies 手动补 "${RUNTIME_PIN_NAME}": "${common}" 使其纳入四包一致性门禁`,
      )
    } else if (runtimePin !== common) {
      fail(
        `runtime pin 与实装分裂: packages/runtime/package.json 的 ${RUNTIME_PIN_NAME}=${runtimePin}，实装三包=${common}——恢复动作：把 pin 同步到 ${common} 后 pnpm install 重装（离线计算与探针 import 的 pi-ai 必须与 pi 子进程同版本），重跑 node scripts/check-pi-semantics.mjs`,
      )
    }

    // verifiedWith 比对（提醒机制；机器防线是探针族，与本值无关地红）
    const stale = entries.filter(
      (e) => typeof e === 'object' && e !== null && isNonEmptyStr(e.verifiedWith) && e.verifiedWith !== common,
    )
    if (stale.length > 0) {
      fail(
        `pi 实装为 ${common}，但 ${stale.length} 条语义登记的 verifiedWith 过期: ${stale.map((e) => `${e.id}(${e.verifiedWith})`).join('、')}——恢复动作：先重跑探针族验证语义仍成立（runtime 侧探针：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics；ext-guards 侧探针（PS-30 stale 文案）：cd extensions/shared/ext-guards && npx vitest run src/__tests__/pi-semantics-stale-ctx-wording.test.ts），全绿后把 docs/pi-semantics.json 对应条目 verifiedWith 更新为 "${common}"；任一探针红 = pi 语义漂移，先按报错复核锚点再更新`,
      )
    }
  }
}

// ── 4. D6 软门禁（可选）：staged verifiedWith 批量变更无探针陪跑 → WARN ────
// 本地 pre-commit 语境读 git staged diff；CI 全仓 checkout 无 staged 内容（输出空 →
// 不触发），--root fixture 非 git 目录（git 失败）则跳过不报错。仅提醒不拦截
//（exit 0）——机器防线是探针族本身，本层只提醒「批量改 verifiedWith 时先跑探针」。
try {
  const stagedRegistry = execFileSync('git', ['-C', ROOT, 'diff', '--cached', '--', 'docs/pi-semantics.json'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const vwChangedLines = stagedRegistry
    .split('\n')
    .filter((line) => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---') && line.includes('verifiedWith'))
    .length
  if (vwChangedLines > 3) {
    const stagedNames = execFileSync('git', ['-C', ROOT, 'diff', '--cached', '--name-only'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const probeTouched = stagedNames
      .split('\n')
      .some((f) => /pi-semantics-[^/]*\.test\.ts$/.test(f) || f.endsWith('thinking-level-effective-e2e.test.ts'))
    if (!probeTouched) {
      warn(
        `staged 的 docs/pi-semantics.json 有 ${vwChangedLines} 行 verifiedWith 变更，但无任何探针测试文件（pi-semantics-*.test.ts / thinking-level-effective-e2e.test.ts）陪跑——D6 软门禁仅提醒不拦截；恢复动作：先跑探针族确认语义仍成立（runtime 侧探针：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics；ext-guards 侧探针（PS-30 stale 文案）：cd extensions/shared/ext-guards && npx vitest run src/__tests__/pi-semantics-stale-ctx-wording.test.ts），全绿再更新 verifiedWith`,
      )
    }
  }
} catch {
  // git / staged diff 不可用（--root fixture 非 git 目录、无 index 等）：CI 全仓模式跳过，不报错
}

// ── 汇总 ────────────────────────────────────────────────────────────
if (failed === 0) {
  const observeCount = entries.length - probeCount
  console.log(`✓ pi-semantics.json 守卫通过（${entries.length} 条 = probe ${probeCount} + observe ${observeCount}；schema/探针存在性/版本门禁${ROOT !== DEFAULT_ROOT ? `，fixture root=${ROOT}` : ''}）`)
  process.exit(0)
}
console.error('pi-semantics 守卫未通过，按上方 ✗ 明细修复后重跑（每条报错自带恢复动作）')
process.exit(1)
