/**
 * ci.yml 的 run: 步骤值提取（共享解析原语；发现 13：此前 check-ci-vitest-targets 与
 * check-test-suite-wiring 各自手写一份、块标量拼接细节不同，YAML 形态演进时会各自
 * 静默失效——收敛为单实现双口径）。
 *
 * 两个消费方的语义差异只在块标量（run: | / run: >）多行命令的拼接方式：
 *   blockJoin: ' && '（默认）——每行视作独立命令（check-ci-vitest-targets 的目标清点口径）
 *   blockJoin: ' '            ——归一为连续文本（check-test-suite-wiring 与 SUITES.cmd
 *                               文本比对前的归一口径）
 */

/** 提取全部 run 值 → [{ line(1-based 声明行), cmd }]；块标量收集缩进大于声明行的后续行。 */
export function extractRunValues(yamlText, { blockJoin = ' && ' } = {}) {
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
      runs.push({ line: i + 1, cmd: parts.join(blockJoin) })
      i = j - 1
    } else {
      runs.push({ line: i + 1, cmd: rhs })
    }
  }
  return runs
}

/**
 * ci.yml 文本 → Map<步骤名, {cmd, line}>。name: 与紧随其后的 run: 配对
 * （中间允许 uses/with/env 行；块标量以空格拼接——与 normCmd 归一口径一致；
 * 下一个列表项开始则配对失效）。
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
