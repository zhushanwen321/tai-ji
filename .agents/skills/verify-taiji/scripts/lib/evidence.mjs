/**
 * 取证原语（lib 层）：summary.jsonl / assertions.jsonl / 截图 / 附件 / report.md / verdict.json。
 *
 * 目录约定：`~/.agents/skill-data/verify-taiji/<worktree>/<runId>/<feature>/`（runDir 由调用方给）。
 * 机读文件字段名冻结（API-CONTRACT §5.7）：summary.jsonl 行 = step/command/exitCode/stats/channel/at；
 * verdict.json 顶层只写 verdict / deviations / blockers / notProvable（+ meta 子对象）。
 *
 * 证据绝不落实例数据目录（清理会删掉）。
 */
import fs from 'node:fs'
import path from 'node:path'

export function createEvidence({ runDir, feature, meta = {} } = {}) {
  if (!runDir) throw new Error('createEvidence 需要 runDir')
  const dir = path.resolve(runDir)
  fs.mkdirSync(dir, { recursive: true })

  const summaryFile = path.join(dir, 'summary.jsonl')
  const assertionsFile = path.join(dir, 'assertions.jsonl')
  const steps = []
  const assertions = []
  let ok = true
  let assertionFailures = 0

  function appendJsonl(file, obj) {
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8')
  }

  function safeName(name) {
    return String(name)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120)
  }

  const ev = {
    runDir: dir,
    feature,

    get ok() {
      return ok
    },
    get steps() {
      return steps
    },
    get assertions() {
      return assertions
    },

    /** 追加一行 step 到 summary.jsonl（同时保留内存副本供 report）。 */
    step({ step, command, exitCode = 0, stats, channel, ...rest } = {}) {
      const line = {
        step,
        ...(command !== undefined ? { command } : {}),
        exitCode,
        ...(stats !== undefined ? { stats } : {}),
        ...(channel !== undefined ? { channel } : {}),
        at: new Date().toISOString(),
        ...(Object.keys(rest).length > 0 ? { meta: rest } : {}),
      }
      appendJsonl(summaryFile, line)
      steps.push(line)
      return line
    },

    /** 断言记录（内存 + assertions.jsonl）。ok=false 会让 evidence.ok=false。 */
    assert(name, passed, { channel, expected, actual } = {}) {
      const record = {
        name,
        ok: Boolean(passed),
        ...(channel !== undefined ? { channel } : {}),
        ...(expected !== undefined ? { expected } : {}),
        ...(actual !== undefined ? { actual } : {}),
        at: new Date().toISOString(),
      }
      appendJsonl(assertionsFile, record)
      assertions.push(record)
      if (!record.ok) {
        ok = false
        assertionFailures += 1
      }
      return record.ok
    },

    /** 截图落 <runDir>/<name>.png。 */
    async shot(page, name, opts = {}) {
      const file = path.join(dir, `${safeName(name)}.png`)
      if (opts.selector) {
        const { resolveSelector } = await import('./ui.mjs')
        const loc = resolveSelector(page, opts.selector)
        await loc.first().screenshot({ path: file })
      } else {
        await page.screenshot({ path: file })
      }
      return file
    },

    /** 文本附件（DOM 片段 / grep 行 / 目录树）。 */
    attach(name, content) {
      const base = safeName(name)
      const file = path.join(dir, base.includes('.') ? base : `${base}.txt`)
      fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')
      return file
    },

    /** 人读报告：期望 vs 实际 + 未覆盖项 + 坑。 */
    report({ title, steps: reportSteps, uncovered = [], gotchas = [], summary } = {}) {
      const lines = []
      lines.push(`# ${title ?? feature ?? 'verify-taiji run'}`)
      lines.push('')
      lines.push(`- 生成时间：${new Date().toISOString()}`)
      lines.push(`- 证据目录：\`${dir}\``)
      if (meta && Object.keys(meta).length > 0) {
        lines.push(`- meta：\`${JSON.stringify(meta)}\``)
      }
      lines.push('')
      lines.push('## 结论')
      lines.push('')
      lines.push(`- 断言：${assertions.length - assertionFailures}/${assertions.length} 通过`)
      lines.push(`- evidence.ok：${ok}`)
      if (summary) lines.push('')
      if (summary) lines.push(summary)
      lines.push('')
      lines.push('## 步骤（summary.jsonl）')
      lines.push('')
      lines.push('| # | step | channel | exitCode | 备注 |')
      lines.push('|---|------|---------|----------|------|')
      const allSteps = reportSteps ?? steps
      allSteps.forEach((s, i) => {
        const note = s.stats ? JSON.stringify(s.stats).slice(0, 220) : s.command ? String(s.command).slice(0, 120) : ''
        lines.push(`| ${i + 1} | ${s.step ?? ''} | ${s.channel ?? ''} | ${s.exitCode ?? ''} | ${note.replace(/\|/g, '\\|')} |`)
      })
      lines.push('')
      lines.push('## 断言（期望 vs 实际）')
      lines.push('')
      if (assertions.length === 0) {
        lines.push('（无断言记录）')
      } else {
        lines.push('| 结果 | 断言 | 通道 | 期望 | 实际 |')
        lines.push('|------|------|------|------|------|')
        for (const a of assertions) {
          const cell = (v) => (v === undefined ? '' : String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\|/g, '\\|').slice(0, 400))
          lines.push(`| ${a.ok ? 'PASS' : 'FAIL'} | ${a.name} | ${a.channel ?? ''} | ${cell(a.expected)} | ${cell(a.actual)} |`)
        }
      }
      lines.push('')
      lines.push('## 未覆盖项')
      lines.push('')
      if (uncovered.length === 0) lines.push('（无）')
      else for (const u of uncovered) lines.push(`- ${u}`)
      lines.push('')
      lines.push('## 坑 / Gotchas')
      lines.push('')
      if (gotchas.length === 0) lines.push('（无）')
      else for (const g of gotchas) lines.push(`- ${g}`)
      lines.push('')
      lines.push('## 附件')
      lines.push('')
      for (const f of fs.readdirSync(dir).sort()) {
        const st = fs.statSync(path.join(dir, f))
        if (st.isFile() && f !== 'report.md') lines.push(`- \`${f}\`（${st.size} B）`)
      }
      lines.push('')
      const file = path.join(dir, 'report.md')
      fs.writeFileSync(file, lines.join('\n'), 'utf8')
      return file
    },

    /** 写 verdict.json（verdict ∈ pass|fail|degraded，禁写 status）。 */
    verdict({ verdict, deviations = [], blockers = [], notProvable = [] } = {}) {
      if (!['pass', 'fail', 'degraded'].includes(verdict)) {
        throw new Error(`verdict 取值必须是 pass|fail|degraded，收到 ${String(verdict)}`)
      }
      const payload = {
        verdict,
        deviations,
        blockers,
        notProvable,
        meta: {
          feature,
          runDir: dir,
          generatedAt: new Date().toISOString(),
          assertions: { total: assertions.length, failed: assertionFailures },
          evidenceOk: ok,
          ...meta,
        },
      }
      const file = path.join(dir, 'verdict.json')
      fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      return file
    },
  }

  return ev
}
