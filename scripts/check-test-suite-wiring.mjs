#!/usr/bin/env node
/**
 * check-test-suite-wiring.mjs — 测试族清单对账器（SUITES ↔ ci.yml ↔ 测试文件全集
 * + continue-on-error ↔ 聚合步）。
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
 * 断言③（continue-on-error ↔ 聚合步）：每个带 continue-on-error: true 的步骤 id
 *   必须被同 job 内 if:always() 聚合步的 steps.<id>.outcome 引用（单向；反向幽灵
 *   引用不掩蔽任何 continue-on-error 步骤——掩蔽必伴随未被引用的 coe 步骤，正向
 *   断言必红，故不对账反向；残余形态仅 = "failure" 聚合步中恒假、永不生效的静默
 *   判断行）。漏登记方向的失败被静默吞、job 恒绿——解掩蔽改造消灭的形态的复发
 *   通道，自此有机器红灯。
 *
 * 挂载：ci.yml Invariants job + pre-commit 触发式（命中 ci.yml / test-suites.mjs /
 * lib/ci-yaml-runs.mjs / 本脚本 / 其单测才跑，接线 = .githooks/install-hooks.sh）。
 * 用法：node scripts/check-test-suite-wiring.mjs [--root <dir>]
 * 退出码：0 = 全部一致；1 = 有漂移（输出逐条 + 恢复动作）；2 = 工具错误
 */
import { readdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SUITES, NON_CI_EXEMPT } from './test-suites.mjs'
import { extractStepRuns, extractJobStepOutcomes } from './lib/ci-yaml-runs.mjs'

// 再导出维持既有测试导入路径（scripts/__tests__/check-test-suite-wiring.test.mjs）
export { extractStepRuns }

/** 空白归一：多空格/换行折叠为单空格（ci.yml 块标量与单行 run 的等价比对基准）。 */
export function normCmd(text) {
  return String(text).replace(/\s+/g, ' ').trim()
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
  // 豁免登记同样要对账磁盘：豁免文件被删除后登记残留 = 腐烂清单，红灯提示清理
  for (const e of exempt) {
    if (!onDisk.has(e.file)) {
      failures.push({
        kind: 'missing-ref',
        message: `豁免登记指向不存在的测试文件：${e.file}（删除该豁免条目）`,
      })
    }
  }
  return failures
}

/**
 * 断言③（continue-on-error ↔ 聚合步，纯函数，全注入）。返回 failures: [{ kind, message }]。
 * kind: 'agg-unwired'——continue-on-error 步骤未被同 job 的 if:always() 聚合步
 * steps.<id>.outcome 引用（或步骤无 id 根本无法被引用）。单向断言：聚合步引用了
 * 不存在的步骤 id（幽灵引用）不掩蔽任何 continue-on-error 步骤——掩蔽必伴随未被
 * 引用的 coe 步骤，正向断言必红，故不对账反向；残余形态仅 = "failure" 聚合步中
 * 恒假、永不生效的静默判断行（不存在的 steps.<id>.outcome 求值为空串，空串与
 * "failure" 比较恒假，CI 不红）。
 * 入参形态 = lib/ci-yaml-runs.mjs 的 extractJobStepOutcomes 输出。
 */
export function aggregateFailures(jobOutcomes) {
  const failures = []
  for (const [job, info] of jobOutcomes) {
    for (const s of info.continueOnError) {
      if (!s.id) {
        failures.push({
          kind: 'agg-unwired',
          message: `job「${job}」步骤「${s.name ?? '(未命名)'}」(line ${String(s.line)}) 设 continue-on-error 但无 id——聚合步无法引用其 outcome，失败必被吞`,
        })
        continue
      }
      if (!info.outcomeRefs.has(s.id)) {
        failures.push({
          kind: 'agg-unwired',
          message: `job「${job}」步骤 id「${s.id}」(line ${String(s.line)}) 设 continue-on-error: true，但同 job 的 if:always() 聚合步未引用 steps.${s.id}.outcome——该步失败会被静默吞、job 恒绿`,
        })
      }
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
  const jobOutcomes = extractJobStepOutcomes(yamlText)
  const failures = [
    ...wiringFailures({
      suites: SUITES,
      exempt: NON_CI_EXEMPT,
      stepRuns: extractStepRuns(yamlText),
      filesOnDisk,
    }),
    ...aggregateFailures(jobOutcomes),
  ]
  if (failures.length === 0) {
    const n = new Set(SUITES.flatMap((s) => s.files ?? [])).size
    const coeTotal = [...jobOutcomes.values()].reduce((acc, j) => acc + j.continueOnError.length, 0)
    console.log(`[check-test-suite-wiring] OK：${String(SUITES.length)} 个族命令与 ci.yml 一致；${String(n)} 个测试文件全部有执行点（豁免 ${String(NON_CI_EXEMPT.length)}）；${String(coeTotal)} 个 continue-on-error 步骤全部被同 job 聚合步引用`)
    process.exit(0)
  }
  console.error(`[check-test-suite-wiring] 漂移 ${String(failures.length)} 处：`)
  for (const f of failures) console.error(`  - [${f.kind}] ${f.message}`)
  console.error('恢复动作：命令不一致 → 同步 scripts/test-suites.mjs 与 ci.yml 对应步骤（两处一起改）；')
  console.error('  孤儿测试 → 加入 test-suites.mjs 对应族的 files（并同步 ci.yml 命令），或在 NON_CI_EXEMPT 登记豁免与理由；')
  console.error('  引用缺失 → 从 files 清单删除该文件；')
  console.error('  聚合漏接线 → 在同 job 的 if:always() 聚合步补 steps.<id>.outcome 引用行（新 continue-on-error 步骤必须同时登记聚合行）。修完重跑 node scripts/check-test-suite-wiring.mjs')
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
