#!/usr/bin/env node
/**
 * check-ci-vitest-targets.mjs — CI vitest 目标非空守卫（G2）。
 *
 * 动机：ci.yml 的 vitest 步骤若目标收集为空，`vitest run <target>` 以
 * "No test files found, exiting with code 1" 空跑收场——2026-09 实发：lint job 的
 * `vitest run taste-lint` 在根 vitest.config.ts 把 taste-lint/** 收进 exclude 后恒空，
 * 每轮 CI 烧到该步骤才红。守卫把「每个 vitest run 调用的目标收集非空」变成机检：
 * 把 run 机械重写为 `vitest list --filesOnly` 干跑（只收集不执行），以 stdout 文件行
 * 数断言非空（实测 list 空收集 exit 0 零输出，与 run 的 exit 1 行为不同，不能只看退出码）。
 *
 * 检查范围（声明边界）：
 *   1. .github/workflows/ci.yml 中字面 `vitest run` 调用（pnpm exec / pnpm --filter X
 *      exec / npx 前缀）；
 *   2. 经 package.json script 一层间接的形态（`pnpm run <name>` / `pnpm --filter <pkg>
 *      run <name>` / `pnpm <name>`）：对应 scripts 展开后含 `vitest run` 才断言；
 *      展开 -r 递归形态（如 extensions:test）静态不可达，显式登记跳过。
 *   pre-commit 内的 vitest 调用、playwright 步骤不在范围。
 *
 * 干跑重写规则：
 *   - 先剥 GitHub Actions 模板字面量（${{ … }}，如 --shard=${{ matrix.shard-index }}/
 *     ${{ matrix.shard-total }}——模板内含空格，必须先剥再 token 化）；
 *   - `vitest run` → `vitest list --filesOnly`；仅保留位置目标与 --config 值，其余
 *     flag（--shard= 残片、--silent 等）丢弃——list 只做收集断言，run 专属 flag 无意义；
 *   - 间接形态在对应包目录（--filter 解析自 pnpm-workspace.yaml globs）bash -c 执行。
 *
 * 用法：node scripts/check-ci-vitest-targets.mjs [ci.yml 路径]（缺省 = 仓库根 ci.yml；
 * 位置参数仅供 fixture 自测。干跑经 pnpm exec/--filter 原语义执行，需 node_modules 就绪）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_CI_YML = join(ROOT, '.github/workflows/ci.yml')
const WORKSPACE_YAML = join(ROOT, 'pnpm-workspace.yaml')

/** 单个干跑的超时上限（防挂死；正常 list 收集秒级，全包 glob 形态数十秒） */
const DRY_RUN_TIMEOUT_MS = 300_000

// ── 纯函数（单测面：scripts/__tests__/check-ci-vitest-targets.test.mjs） ──────

/** 剥 GitHub Actions 模板字面量（${{ … }} 不嵌套，非贪婪到首个 }}） */
export function stripGithubTemplates(text) {
  return text.replace(/\$\{\{[^}]*\}\}/g, '')
}

/**
 * 从 ci.yml 文本提取全部 run 值（命令文本），返回 [{ line, cmd }]。
 * 覆盖单行 `run: <cmd>` 与块 `run: |` / `run: >`（收集缩进大于声明行的后续行，
 * 按行拼接）。行号 1-based，供违规定位。
 */
export function extractRunValues(yamlText) {
  const lines = yamlText.split('\n')
  const runs = []
  const DECL_RE = /^(\s*)(?:-\s+)?run:\s*(.*)$/
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DECL_RE)
    if (!m) continue
    const indent = m[1].length
    const rhs = m[2].trim()
    if (/^[|>][+-]?$/.test(rhs)) {
      const parts = []
      let j = i + 1
      while (j < lines.length) {
        const l = lines[j]
        if (l.trim() === '') {
          j++
          continue
        }
        const lead = l.match(/^\s*/)[0].length
        if (lead <= indent) break
        parts.push(l.trim())
        j++
      }
      runs.push({ line: i + 1, cmd: parts.join(' && ') })
      i = j - 1
    } else {
      runs.push({ line: i + 1, cmd: rhs })
    }
  }
  return runs
}

/** 解析 pnpm-workspace.yaml 的 packages globs → [{ base, glob }]（仅一级 /* 形态） */
export function parseWorkspaceGlobs(yamlText) {
  const globs = []
  let inPackages = false
  for (const line of yamlText.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      if (/^\S/.test(line)) {
        inPackages = false
        continue
      }
      const m = line.match(/^\s*-\s*'?([^'\s]+)'?\s*$/)
      if (m) globs.push(m[1])
    }
  }
  return globs
}

/** 由 pnpm-workspace.yaml globs 构建包名 → 目录（相对仓库根）映射 */
export function buildPackageNameMap(root, yamlText) {
  const map = new Map()
  for (const glob of parseWorkspaceGlobs(yamlText)) {
    const m = glob.match(/^(.+?)\/\*$/)
    if (!m) continue
    const base = join(root, m[1])
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base)) {
      const pkgJson = join(base, entry, 'package.json')
      if (!existsSync(pkgJson)) continue
      try {
        const name = JSON.parse(readFileSync(pkgJson, 'utf-8')).name
        if (typeof name === 'string') map.set(name, join(m[1], entry))
      } catch {
        // 包 manifest 损坏不是本守卫的职责面，跳过该目录（其构建链会报）
      }
    }
  }
  return map
}

/**
 * 命令分类。返回：
 *   { kind: 'direct', runner, filterPkg, rest } —— 字面 vitest run（runner = 干跑前缀）
 *   { kind: 'script', filterPkg, scriptName, args } —— pnpm [–filter X] [run] <name>；
 *     args = name 之后的残余 token（null = 无）。带参 script 引用是否放行由主流程结合
 *     scripts 表裁决（表 miss = pnpm 内建如 install，放行；表命中 = 未知形态，fail loud）
 *   { kind: 'unrecognized', text }              —— vitest run 出现但形态不认识（fail loud）
 *   null                                        —— 与 vitest run 无关
 */
export function classifyCommand(cmd) {
  const text = stripGithubTemplates(cmd).trim()
  if (/\bvitest\s+run\b/.test(text)) {
    const m = text.match(/^(pnpm\s+(?:--filter\s+(\S+)\s+)?exec|npx)\s+vitest\s+run\b(.*)$/)
    if (m) {
      const filterPkg = m[2] ?? null
      // runner 从捕获组重建（多空格输入折叠后同值）；npx 无 filter，取折叠后的原前缀
      const runner = filterPkg ? `pnpm --filter ${filterPkg} exec` : m[1].replace(/\s+/g, ' ')
      return { kind: 'direct', runner, filterPkg, rest: m[3] }
    }
    return { kind: 'unrecognized', text }
  }
  // 复合命令（&& / ; / |）非单 script 引用：无 vitest run → 放行；含 vitest run 的
  // 复合形态已被上方 unrecognized 覆盖（fail loud），不会走到这里
  if (/[;&|]/.test(text)) return null
  const m = text.match(/^pnpm\s+(?:--filter\s+(\S+)\s+)?(?:run\s+)?(\S+)(?:\s+(.+))?$/)
  if (m) {
    const filterPkg = m[1] ?? null
    return { kind: 'script', filterPkg, scriptName: m[2], args: m[3] ?? null }
  }
  return null
}

/** 从 direct 形态 rest 中提取干跑参数：位置目标 + --config 值（其余 flag 丢弃） */
export function pickDryRunArgs(rest) {
  const tokens = stripGithubTemplates(rest).trim().split(/\s+/).filter(Boolean)
  const targets = []
  const flags = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--config') {
      const value = tokens[i + 1]
      if (value && !value.startsWith('-')) {
        flags.push(`--config ${value}`)
        i++
      }
      continue
    }
    if (t.startsWith('--config=')) {
      flags.push(`--config ${t.slice('--config='.length)}`)
      continue
    }
    if (!t.startsWith('-')) targets.push(t)
  }
  return { targets, flags }
}

/** direct 形态 → 干跑命令文本 */
export function buildDirectDryRun({ runner, rest }) {
  const { targets, flags } = pickDryRunArgs(rest)
  return `${runner} vitest list --filesOnly${flags.map((f) => ` ${f}`).join('')}${targets.map((t) => ` ${t}`).join('')}`
}

/**
 * script 展开 → 干跑信息。返回：
 *   { action: 'assert', cmd }   —— script 含 vitest run 且非递归，替换为 list 干跑
 *   { action: 'skip', reason }  —— workspace 递归形态（如 extensions:test），显式登记跳过
 *   { action: 'ignore' }        —— script 与 vitest 无关，静默放行（不在守卫范围）
 */
export function buildScriptDryRun(scriptText) {
  const text = stripGithubTemplates(scriptText)
  // 递归转发 = pnpm -r 或二次 pnpm/npm/yarn run（脚本里再调 run 才静态不可达）；
  // `pnpm exec vitest …` 是可整条重写直跑的形态，不算转发
  const recursive = /(?:^|\s)-r(?:\s|$)/.test(text) || /\b(?:pnpm|npm|yarn)\s+(?:--filter\s+\S+\s+)?run\b/.test(text)
  if (!/\bvitest\s+run\b/.test(text)) {
    return recursive
      ? { action: 'skip', reason: 'workspace 递归形态（pnpm -r），内部 vitest 静态不可达，不在断言范围' }
      : { action: 'ignore' }
  }
  if (recursive) {
    return { action: 'skip', reason: 'workspace 递归形态（二次 run 转发），静态不可达单调用，不在断言范围' }
  }
  return { action: 'assert', cmd: text.replace(/\bvitest\s+run\b/g, 'vitest list --filesOnly') }
}

// ── 主流程 ────────────────────────────────────────────────────────────────

/**
 * 单条已分类命令的干跑裁决。返回：
 *   { dryCmd, cwd }                 —— 待干跑的命令与工作目录
 *   'silent'                        —— 静默放行，不记账（与 vitest run 无关的形态）
 *   { skip: string }                —— 显式登记跳过
 *   { failure: { message, fix } }   —— 拒绝静默放行
 */
function resolveDryRunTarget(classified, pkgMap, line, cmd) {
  if (classified.kind === 'unrecognized') {
    return {
      failure: {
        message: `ci.yml:${line} 出现 vitest run 但形态不被识别，拒绝静默放行：${classified.text}`,
        fix: '改用 pnpm exec / pnpm --filter <pkg> exec / npx 前缀，或在守卫 classifyCommand 登记该形态',
      },
    }
  }

  let cwd = ROOT
  let dryCmd

  if (classified.kind === 'direct') {
    dryCmd = buildDirectDryRun(classified)
  } else {
    const pkgJson = classified.filterPkg
      ? join(ROOT, pkgMap.get(classified.filterPkg) ?? '<unresolved>', 'package.json')
      : join(ROOT, 'package.json')
    if (classified.filterPkg && !pkgMap.has(classified.filterPkg)) {
      return {
        failure: {
          message: `ci.yml:${line} 引用包 ${classified.filterPkg} 但 pnpm-workspace.yaml 扫描不到该包`,
          fix: '核对包名或更新守卫的 workspace glob 解析',
        },
      }
    }
    let scripts
    try {
      scripts = JSON.parse(readFileSync(pkgJson, 'utf-8')).scripts ?? {}
    } catch {
      return { failure: { message: `ci.yml:${line} 的 script 归属包 manifest 不可读：${pkgJson}`, fix: '修复 package.json' } }
    }
    const scriptText = scripts[classified.scriptName]
    if (typeof scriptText !== 'string') return 'silent' // pnpm 内建命令（install 等），非 script 引用
    if (classified.args !== null) {
      return {
        failure: {
          message: `ci.yml:${line} 的 script 引用带额外参数，干跑重写无法保证等价：${cmd.trim()}`,
          fix: '拆成独立步骤，或在本守卫显式登记该形态后再放行',
        },
      }
    }
    const outcome = buildScriptDryRun(scriptText)
    if (outcome.action === 'ignore') return 'silent'
    if (outcome.action === 'skip') return { skip: `ci.yml:${line} ${cmd.trim()} → ${outcome.reason}` }
    dryCmd = outcome.cmd
    if (classified.filterPkg) cwd = join(ROOT, pkgMap.get(classified.filterPkg))
  }

  return { dryCmd, cwd }
}

/** 干跑一条已裁决命令，返回判定素材（stdout 文件行数 / 尾部输出 / 退出码裁决文案 / 展示用 cwd） */
function runDryRun(dryCmd, cwd) {
  // pnpm run/exec 会把 workspace bin 目录注入 PATH（hoisted 布局 → 根 node_modules/.bin；
  // 包内 bin → <pkg>/node_modules/.bin），裸 `bash -c` 只继承守卫进程的 PATH——CI runner
  // 无全局 vitest 时 script 展开形态（如 test:main = `cd main && vitest run`）在裸 PATH 下
  // exit 127（2026-09-18 CI Invariants 实发）。干跑补齐 pnpm 同款 bin 前缀，保证与被验证
  // 命令在 CI 里的真实解析语义一致。
  const binPrepend = `${join(cwd, 'node_modules', '.bin')}:${join(ROOT, 'node_modules', '.bin')}:`
  const result = spawnSync('bash', ['-c', dryCmd], {
    cwd,
    timeout: DRY_RUN_TIMEOUT_MS,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${binPrepend}${process.env.PATH ?? ''}` },
  })
  const where = cwd === ROOT ? '<repo-root>' : cwd.replace(ROOT, '<repo-root>/')
  // 判定以 stdout 文件行数为准，不能只看 exit code：实测 vitest list 空收集时
  // exit 0 且零输出（与 run 的 "No test files found" exit 1 行为不同）
  const collectedCount = (result.stdout ?? '').split('\n').filter((l) => l.trim() !== '').length
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n')
  const verdict = result.status === 0 ? '收集为空（0 个测试文件）' : `干跑失败（exit ${result.status ?? 'signal'}）`
  return { ok: result.status === 0 && collectedCount > 0, collectedCount, output, verdict, where }
}

/** 输出三段报告；有违规时以 exit 1 收场（pre-commit/CI 只吃退出码与 stderr 文本） */
function report(assertions, skipped, failures) {
  for (const s of skipped) console.log(`[skip] ${s}`)
  for (const a of assertions) console.log(`[ok] ${a}`)
  if (failures.length > 0) {
    console.error(`\n[ci-vitest-targets] 守卫拦截：${failures.length} 项违规\n`)
    for (const f of failures) {
      console.error(`  ✗ ${f.message}`)
      console.error(`    [FIX] ${f.fix}\n`)
    }
    process.exit(1)
  }
  console.log(
    `\n[ci-vitest-targets] OK：ci.yml 全部 vitest run 目标收集非空（断言 ${assertions.length} 处` +
      `${skipped.length > 0 ? `，显式跳过 ${skipped.length} 处` : ''}）`,
  )
}

function main(ciYmlPath = DEFAULT_CI_YML) {
  const ciText = readFileSync(ciYmlPath, 'utf-8')
  const pkgMap = buildPackageNameMap(ROOT, readFileSync(WORKSPACE_YAML, 'utf-8'))

  const assertions = []
  const skipped = []
  const failures = []

  for (const { line, cmd } of extractRunValues(ciText)) {
    const classified = classifyCommand(cmd)
    if (!classified) continue

    const target = resolveDryRunTarget(classified, pkgMap, line, cmd)
    if (target === 'silent') continue
    if (target.skip !== undefined) {
      skipped.push(target.skip)
      continue
    }
    if (target.failure !== undefined) {
      failures.push({ line, ...target.failure })
      continue
    }

    const { dryCmd, cwd } = target
    const { ok, collectedCount, output, verdict, where } = runDryRun(dryCmd, cwd)
    if (ok) {
      assertions.push(`ci.yml:${line} ${dryCmd}（cwd: ${where}）→ 收集 ${collectedCount} 个测试文件 ✓`)
    } else {
      failures.push({
        line,
        message:
          `ci.yml:${line} 的 vitest run 目标${verdict}：${cmd.trim()}\n` +
          `    干跑：${dryCmd}（cwd: ${where}）\n${output.split('\n').map((l) => `    | ${l}`).join('\n')}`,
        fix: '核对目标路径与对应 vitest config 的 include/exclude——目标文件存在但被 exclude 也是空收集（taste-lint 事故形态）',
      })
    }
  }

  report(assertions, skipped, failures)
}

// 缺省 ci.yml 由脚本位置推导（不依赖 cwd）；位置参数仅供 fixture 自测覆盖目标
// （check-vitest-guard.mjs 同款惯例）。import 消费纯函数时不触发干跑主流程。
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_CI_YML)
}
