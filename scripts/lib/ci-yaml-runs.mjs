/**
 * ci.yml 的 run: 步骤值提取（共享解析原语；发现 13：此前 check-ci-vitest-targets 与
 * check-test-suite-wiring 各自手写一份、块标量拼接细节不同，YAML 形态演进时会各自
 * 静默失效——收敛为单实现双口径）。
 *
 * 两个消费方的语义差异只在块标量（run: | / run: >）多行命令的拼接方式：
 *   blockJoin: ' && '（默认）——每行视作独立命令（check-ci-vitest-targets 的目标清点口径）
 *   blockJoin: ' '            ——归一为连续文本（check-test-suite-wiring 与 SUITES.cmd
 *                               文本比对前的归一口径）
 *
 * extractJobStepOutcomes 是第三个消费原语：按 job 提取「continue-on-error 步骤清单」
 * 与「if:always() 聚合步引用的 outcome id 集合」，供 continue-on-error ↔ 聚合步对账
 * （漏登记方向的失败会被静默吞、job 恒绿——两份平行手写清单的机器对账原语）。
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

/**
 * ci.yml 文本 → Map<job名, { continueOnError: [{id, name, line}], outcomeRefs: Set<string> }>。
 * 按 job 分层提取（jobs: 下二级缩进为 job 边界、六空格 `- ` 为步骤边界——步骤首个键
 * 可内联在短横线行（- id:/- name:/- continue-on-error: 等）、八空格为步骤属性）：
 *   continueOnError = 带 continue-on-error: true 的步骤（id/name/line 供报错定位）；
 *   outcomeRefs     = 同 job 内 if:always() 步骤的 run 文本中 steps.<id>.outcome /
 *                     steps['<id>'].outcome（dot 与 bracket 两形态度识别，conclusion 同计）
 *                     引用到的 id 集合。
 * 无 continue-on-error 步骤与无聚合引用的 job 不产出条目（空 job 不入 Map）。
 */
export function extractJobStepOutcomes(yamlText) {
  const lines = yamlText.split('\n')
  const out = new Map()
  let jobsSeen = false
  let curJob = null
  let curStep = null
  const finishStep = () => {
    if (!curStep || curJob === null) {
      curStep = null
      return
    }
    if (curStep.continueOnError || (curStep.aggregate && curStep.run)) {
      if (!out.has(curJob)) out.set(curJob, { continueOnError: [], outcomeRefs: new Set() })
      const info = out.get(curJob)
      if (curStep.continueOnError) {
        info.continueOnError.push({ id: curStep.id, name: curStep.name, line: curStep.line })
      }
      if (curStep.aggregate && curStep.run) {
        for (const m of curStep.run.matchAll(
          /steps(?:\.([A-Za-z0-9_-]+)|\[\s*['"]([^'"]+)['"]\s*\])\.(?:outcome|conclusion)/g,
        )) {
          info.outcomeRefs.add(m[1] ?? m[2])
        }
      }
    }
    curStep = null
  }
  /** 步骤属性赋值（8 空格独立行与短横线行内联键共用；run 需块标量收集，不在此列）。 */
  const setStepProp = (step, key, val) => {
    if (key === 'id') step.id = val
    else if (key === 'name') step.name = val
    else if (key === 'continue-on-error') step.continueOnError = val === 'true'
    else if (key === 'if') step.aggregate = val.includes('always()')
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^jobs:\s*$/.test(line)) {
      jobsSeen = true
      finishStep()
      curJob = null
      continue
    }
    if (!jobsSeen) continue
    const jm = line.match(/^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/)
    if (jm) {
      finishStep()
      curJob = jm[1]
      continue
    }
    if (/^      - /.test(line)) {
      finishStep()
      curStep = { line: i + 1, name: undefined, id: undefined, continueOnError: false, aggregate: false, run: '' }
      // 步骤首个键可内联在短横线行（- id:/- continue-on-error: 等），与 8 空格独立行同语义；
      // 内联 run: 不在此处理（块标量收集口径不同），缺失只导致聚合引用漏收的失败安全红灯
      const im = line.match(/^      - ([A-Za-z0-9_-]+):\s*(.*)$/)
      if (im) setStepProp(curStep, im[1], im[2].trim())
      continue
    }
    if (!curStep) continue
    const pm = line.match(/^        ([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!pm) continue // 块标量内容 / with:/env: 子行等，不是步骤属性
    const [, key, rhs] = pm
    if (key === 'run') {
      const val = rhs.trim()
      if (/^[|>][+-]?$/.test(val)) {
        const parts = []
        let j = i + 1
        while (j < lines.length) {
          const l = lines[j]
          if (l.trim() === '') {
            j += 1
            continue
          }
          if (l.match(/^\s*/)[0].length <= 8) break
          parts.push(l.trim())
          j += 1
        }
        curStep.run = parts.join(' ')
        i = j - 1
      } else {
        curStep.run = val
      }
    } else {
      setStepProp(curStep, key, rhs.trim())
    }
  }
  finishStep()
  return out
}
