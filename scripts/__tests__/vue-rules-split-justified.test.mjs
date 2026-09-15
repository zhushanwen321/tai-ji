/**
 * vue_rules_checker.py split-justified 豁免通道自测（R4 门禁自测固化）。
 *
 * 背景（renderer 过度设计审计候选 3 / 用户裁决 1，处置设计 R4）：豁免通道落地后
 * 零生产使用（CommandPopover 合并后 267 行未触发），通道本体存在「生锈」风险——
 * 正则边界回归要等首个真实用户踩上才暴露。本套件把 stage-5 u19 的 7 场景正反验证
 * 固化为机器用例，通道每次改动可回归。
 *
 * 锁定的行为（与 .githooks/vue_rules_checker.py 实现逐条对应）：
 *   R4-1 无登记 299 行     → 放行（原 300 行门禁行为不变）
 *   R4-2 无登记 310 行     → 拦截，文案含「超出上限 300 行」
 *   R4-3 HTML 注释登记 310 → 放行 + stderr 打 INFO（豁免不静默），文案含登记域
 *   R4-4 `//` 行注释登记 310 → 同 R4-3（script 内登记形态）
 *   R4-5 登记 501 / 520 行 → 拦截，文案含「超出豁免上限 500 行」（豁免不无限膨胀）
 *   R4-6 登记无效四形态（空语义域 / 超出前 30 行窗口 / 非注释语境 / HTML 注释未同行闭合）
 *          均视为未登记：310 行 → 拦截
 *   R4-7 登记 299 行       → 放行（登记不改变未超行文件的判定）
 *
 * 运行：pnpm exec vitest run scripts/__tests__/vue-rules-split-justified.test.mjs
 * （CI 在 .github/workflows/ci.yml 的 scripts vitest 批次中运行）
 */
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const CHECKER = join(ROOT, '.githooks', 'vue_rules_checker.py')

const tmp = mkdtempSync(join(tmpdir(), 'split-justified-selftest-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

/** 构造最小合法 .vue（模板用 @taiji/ui 映射组件，不触原生 HTML/Emoji/Tab/v-model 检查） */
function makeVue({ scriptLines, marker = null, markerLineOffset = null }) {
  const lines = []
  if (marker && markerLineOffset === null) lines.push(marker)
  lines.push('<template>')
  lines.push('  <Button>ok</Button>')
  lines.push('</template>')
  lines.push('<script setup lang="ts">')
  for (let i = 0; i < scriptLines; i++) lines.push(`const v${i} = ${i}`)
  lines.push('</script>')
  if (marker && markerLineOffset !== null) {
    // 在模板结束后、script 起始行之后插入（行号 > 30 的场景用更多 filler）
    while (lines.length < markerLineOffset - 1) lines.push('// filler')
    lines.push(marker)
  }
  return lines.join('\n')
}

function runChecker(content, relName = 'src/fixtures/SplitJustifiedFixture.vue') {
  const abs = join(tmp, relName.replace(/[^\w.]/g, '_'))
  writeFileSync(abs, content)
  // spawnSync 返回失败退出码是被检行为本身，不抛异常
  const r = spawnSync('python3', [CHECKER, abs, relName], { encoding: 'utf-8', timeout: 30_000 })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('vue_rules_checker split-justified 豁免通道', () => {
  it('R4-1 无登记 299 行：放行（300 行门禁原行为不变）', () => {
    const r = runChecker(makeVue({ scriptLines: 299 }))
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain('split-justified')
  })

  it('R4-2 无登记 310 行：拦截，文案含 300 行上限', () => {
    const r = runChecker(makeVue({ scriptLines: 310 }))
    expect(r.code).not.toBe(0)
    expect(r.stderr + r.stdout).toContain('超出上限 300 行')
  })

  it('R4-3 HTML 注释登记 310 行：放行 + stderr INFO 含登记域（豁免不静默）', () => {
    const r = runChecker(
      makeVue({ scriptLines: 310, marker: '<!-- split-justified: test-domain -->' }),
    )
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('INFO')
    expect(r.stderr).toContain('test-domain')
  })

  it('R4-4 script 内 // 行注释登记 310 行：同样放行', () => {
    const r = runChecker(
      makeVue({ scriptLines: 310, marker: '// split-justified: script-domain' }),
    )
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('script-domain')
  })

  it.each([501, 520])('R4-5 登记 %s 行：拦截（豁免绝对上限 500 不膨胀）', (n) => {
    const r = runChecker(makeVue({ scriptLines: n, marker: '<!-- split-justified: test-domain -->' }))
    expect(r.code).not.toBe(0)
    expect(r.stderr + r.stdout).toContain('超出豁免上限 500 行')
  })

  it.each([
    ['空语义域', '<!-- split-justified: -->', null],
    ['超出前 30 行窗口', '<!-- split-justified: late-domain -->', 35],
    ['非注释语境', 'split-justified: bare-domain', null],
    ['HTML 注释未同行闭合', '<!-- split-justified: unclosed-domain', null],
  ])('R4-6 登记无效（%s）：310 行视为未登记 → 拦截', (_name, marker, offset) => {
    const r = runChecker(makeVue({ scriptLines: 310, marker, markerLineOffset: offset }))
    expect(r.code).not.toBe(0)
    expect(r.stderr + r.stdout).toContain('超出上限 300 行')
  })

  it('R4-7 登记 299 行：放行（登记不影响未超行判定）', () => {
    const r = runChecker(makeVue({ scriptLines: 299, marker: '<!-- split-justified: test-domain -->' }))
    expect(r.code).toBe(0)
  })
})
