#!/usr/bin/env node
/**
 * check-test-suite-wiring.mjs — 测试族清单对账器（SUITES ↔ ci.yml ↔ 测试文件全集）。
 *
 * 「测试套件清单」曾七处定义、零对账：ci.yml 逐文件文本是事实唯一载体，但没人
 * 校验它与本地门禁（quality-gates）和测试文件全集一致——漂移形态包括清单漏登记
 * （v0.11.16 实测 6 个测试文件不在任何执行点，连 CI 都不跑）与 ci.yml 命令与清单
 * 各自演化。本对账器把三类漂移全变红灯：
 *
 * 断言①（ci.yml ↔ SUITES）：SUITES 每个 ci 挂载族的步骤 run 文本与 SUITES.cmd
 *   精确一致（空白归一后比对）——清单是数据源，ci.yml 是被校验副本，改一侧漏
 *   另一侧 = 红，不是静默漂移。
 * 断言②（文件全集 ↔ 引用）：scripts/__tests__/*.test.mjs 全集 − SUITES 引用 −
 *   豁免登记 = 空；反向（引用了不存在的文件）也红。孤儿测试（零执行点）自此
 *   结构性不可再发生。
 *
 * 挂载：ci.yml Invariants job + pre-commit 触发式（命中 ci.yml / test-suites.mjs /
 * 本脚本 / 其单测才跑，接线 = .githooks/install-hooks.sh）。
 * 用法：node scripts/check-test-suite-wiring.mjs [--root <dir>]
 * 退出码：0 = 全部一致；1 = 有漂移（输出逐条 + 恢复动作）；2 = 工具错误
 */
import { readdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SUITES, NON_CI_EXEMPT } from './test-suites.mjs'

/** 空白归一：多空格/换行折叠为单空格（ci.yml 块标量与单行 run 的等价比对基准）。 */
export function normCmd(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/**
 * ci.yml 文本 → Map<步骤名, {cmd, line}>。name: 与紧随其后的 run: 配对
 * （中间允许 uses/with/env 行；块标量 run: | 逐行拼接、行间以空格连接——与
 * normCmd 归一口径一致）。
 */
export function extractStepRuns(yamlText) {
  const out = new Map()
  const lines = yamlText.split('\n')
  let currentName = null
  let pendingRun = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const nm = line.match(/^\s*-\s+name:\s*(.+)$/)
    if (nm) {
      currentName = nm[1].trim()
      pendingRun = true
      continue
    }
    if (!currentName || !pendingRun) continue
    if (/^\s*-\s/.test(line)) {
      pendingRun = false // 下一个列表项开始，name 与 run 配对失效
      continue
    }
    const rm = line.match(/^(\s*)run:\s*(.*)$/)
    if (!rm) continue
    const indent = rm[1].length
    const rhs = rm[2].trim()
    if (/^[|>][+-]?$/.test(rhs)) {
      const parts = []
      let j = i + 1
      while (j < lines.length) {
        const l = lines[j]
        if (l.trim() === '') {
          j += 1
          continue
        }
        if (l.match(/^\s*/)[0].length <= indent) break
        parts.push(l.trim())
        j += 1
      }
      out.set(currentName, { cmd: parts.join(' '), line: i + 1 })
      i = j - 1
    } else {
      out.set(currentName, { cmd: rhs, line: i + 1 })
    }
    pendingRun = false
  }
  return out
}

/**
 * 对账核心（纯函数，全注入）。返回 failures: [{ kind, message }]。
 * kind: 'ci-cmd-drift'（断言①）/ 'orphan-test' / 'missing-ref'（断言②两向）。
 */
export function wiringFailures({ suites, exempt, stepRuns, filesOnDisk }) {
  const failures = []
  // 断言①：ci.yml ↔ SUITES
  for (const suite of suites) {
    const hit = stepRuns.get(suite.ci.step)
    if (!hit) {
      failures.push({
        kind: 'ci-cmd-drift',
        message: `SUITES 族「${suite.id}」登记的 ci 步骤「${suite.ci.step}」在 ci.yml 中不存在`,
      })
      continue
    }
    if (normCmd(hit.cmd) !== normCmd(suite.cmd)) {
      failures.push({
        kind: 'ci-cmd-drift',
        message: `SUITES 族「${suite.id}」与 ci.yml 步骤「${suite.ci.step}」(line ${String(hit.line)}) 命令不一致：\n    清单: ${normCmd(suite.cmd)}\n    ci.yml: ${normCmd(hit.cmd)}`,
      })
    }
  }
  // 断言②：文件全集 ↔ 引用（双向）
  const exemptFiles = new Set(exempt.map((e) => e.file))
  const referenced = new Set(suites.flatMap((s) => s.files ?? []))
  const onDisk = new Set(filesOnDisk)
  for (const f of [...onDisk].sort()) {
    if (!referenced.has(f) && !exemptFiles.has(f)) {
      failures.push({
        kind: 'orphan-test',
        message: `测试文件零执行点：${f} 不在任何 SUITES 族，也无豁免登记`,
      })
    }
  }
  for (const f of [...referenced].sort()) {
    if (!onDisk.has(f)) {
      failures.push({
        kind: 'missing-ref',
        message: `SUITES 引用了不存在的测试文件：${f}`,
      })
    }
  }
  return failures
}

function listScriptTests(root) {
  const dir = join(root, 'scripts', '__tests__')
  return readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => `scripts/__tests__/${f}`).sort()
}

function main(argv) {
  const rootArg = argv.find((a) => a === '--root')
  const root = rootArg && argv[argv.indexOf(rootArg) + 1] ? argv[argv.indexOf(rootArg) + 1] : process.cwd()
  let yamlText
  let filesOnDisk
  try {
    yamlText = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf-8')
    filesOnDisk = listScriptTests(root)
  } catch (e) {
    console.error(`[check-test-suite-wiring] 工具错误：${e.message}`)
    process.exit(2)
  }
  const failures = wiringFailures({
    suites: SUITES,
    exempt: NON_CI_EXEMPT,
    stepRuns: extractStepRuns(yamlText),
    filesOnDisk,
  })
  if (failures.length === 0) {
    const n = new Set(SUITES.flatMap((s) => s.files ?? [])).size
    console.log(`[check-test-suite-wiring] OK：${String(SUITES.length)} 个族命令与 ci.yml 一致；${String(n)} 个测试文件全部有执行点（豁免 ${String(NON_CI_EXEMPT.length)}）`)
    process.exit(0)
  }
  console.error(`[check-test-suite-wiring] 漂移 ${String(failures.length)} 处：`)
  for (const f of failures) console.error(`  - [${f.kind}] ${f.message}`)
  console.error('恢复动作：命令不一致 → 同步 scripts/test-suites.mjs 与 ci.yml 对应步骤（两处一起改）；')
  console.error('  孤儿测试 → 加入 test-suites.mjs 对应族的 files（并同步 ci.yml 命令），或在 NON_CI_EXEMPT 登记豁免与理由；')
  console.error('  引用缺失 → 从 files 清单删除该文件。修完重跑 node scripts/check-test-suite-wiring.mjs')
  process.exit(1)
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main(process.argv.slice(2))
}
