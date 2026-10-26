/**
 * check-test-suite-wiring.mjs 单测：对账器判定语义（ci.yml 步骤解析 + 断言①②③判定）。
 * 真实仓库全量对账 = 脚本本体（CI Invariants + pre-commit 挂载），此处锁定纯函数语义。
 */
import { describe, it, expect } from 'vitest'
import { normCmd, extractStepRuns, wiringFailures, aggregateFailures } from '../check-test-suite-wiring.mjs'
import { extractJobStepOutcomes } from '../lib/ci-yaml-runs.mjs'

const suite = (over = {}) => ({
  id: 'demo',
  cmd: 'pnpm exec vitest run a.test.mjs',
  files: ['scripts/__tests__/a.test.mjs'],
  needs: [],
  devGate: true,
  ci: { step: 'Test - demo' },
  ...over,
})

describe('normCmd：空白归一', () => {
  it('多空格/换行折叠为单空格（块标量与单行 run 的等价比对）', () => {
    expect(normCmd('pnpm exec  vitest run\n   a.test.mjs  b.test.mjs')).toBe('pnpm exec vitest run a.test.mjs b.test.mjs')
  })
})

describe('extractStepRuns：ci.yml 步骤名 → run 命令', () => {
  it('name 与紧随 run 配对；中间 uses/env 行不影响', () => {
    const yaml = [
      'jobs:',
      '  test:',
      '    steps:',
      '      - name: Test - demo',
      '        uses: actions/checkout@v4',
      '        run: pnpm exec vitest run a.test.mjs',
      '      - name: Build',
      '        run: pnpm build',
    ].join('\n')
    const m = extractStepRuns(yaml)
    expect(m.get('Test - demo').cmd).toBe('pnpm exec vitest run a.test.mjs')
    expect(m.get('Build').cmd).toBe('pnpm build')
  })
  it('块标量 run: | 逐行拼接', () => {
    const yaml = ['  steps:', '      - name: Multi', '        run: |', '          echo a', '          echo b'].join('\n')
    expect(extractStepRuns(yaml).get('Multi').cmd).toBe('echo a echo b')
  })
  it('name 后无 run（纯 uses 步骤）不产出条目；新列表项开始后配对失效', () => {
    const yaml = ['  steps:', '      - name: OnlyUses', '        uses: x/y@v1', '      - name: Next', '        run: ok'].join('\n')
    const m = extractStepRuns(yaml)
    expect(m.has('OnlyUses')).toBe(false)
    expect(m.get('Next').cmd).toBe('ok')
  })
})

describe('wiringFailures：三类漂移判定', () => {
  const yamlOk = '  steps:\n      - name: Test - demo\n        run: pnpm exec vitest run a.test.mjs\n'
  const okDeps = () => ({
    suites: [suite()],
    exempt: [],
    stepRuns: extractStepRuns(yamlOk),
    filesOnDisk: ['scripts/__tests__/a.test.mjs'],
  })

  it('全一致 → 零漂移', () => {
    expect(wiringFailures(okDeps())).toEqual([])
  })
  it('命令文本漂移（空白差异外的实质差异）→ ci-cmd-drift', () => {
    const d = okDeps()
    d.stepRuns = extractStepRuns('  steps:\n      - name: Test - demo\n        run: pnpm exec vitest run a.test.mjs c.test.mjs\n')
    const f = wiringFailures(d)
    expect(f).toHaveLength(1)
    expect(f[0].kind).toBe('ci-cmd-drift')
  })
  it('ci.yml 缺登记步骤 → ci-cmd-drift', () => {
    const d = okDeps()
    d.stepRuns = new Map()
    expect(wiringFailures(d)[0].kind).toBe('ci-cmd-drift')
  })
  it('磁盘测试文件无引用无豁免 → orphan-test；豁免登记抑制', () => {
    const d = okDeps()
    d.filesOnDisk = ['scripts/__tests__/a.test.mjs', 'scripts/__tests__/orphan.test.mjs']
    expect(wiringFailures(d).map((x) => x.kind)).toEqual(['orphan-test'])
    d.exempt = [{ file: 'scripts/__tests__/orphan.test.mjs', reason: 'x' }]
    expect(wiringFailures(d)).toEqual([])
  })
  it('引用了不存在的文件 → missing-ref（双向对账）', () => {
    const d = okDeps()
    d.filesOnDisk = []
    expect(wiringFailures(d).map((x) => x.kind)).toEqual(['missing-ref'])
  })
  it('豁免登记指向不存在的文件 → missing-ref（豁免清单同样对账磁盘）', () => {
    const d = okDeps()
    d.exempt = [{ file: 'scripts/__tests__/gone.test.mjs', reason: 'x' }]
    const f = wiringFailures(d)
    expect(f.map((x) => x.kind)).toEqual(['missing-ref'])
    expect(f[0].message).toContain('豁免登记')
  })
})

describe('extractJobStepOutcomes：continue-on-error 与聚合步引用提取', () => {
  const yaml = [
    'name: CI',
    'on:',
    '  push:',
    '    branches: [main]',
    'jobs:',
    '  lint:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: ESLint',
    '        id: eslint',
    '        continue-on-error: true',
    '        run: pnpm run lint',
    '      - name: Guards',
    '        id: scripts-guards',
    '        continue-on-error: true',
    '        run: pnpm exec vitest run scripts/__tests__/a.test.mjs',
    '      - name: Upload',
    '        if: always()',
    '        uses: actions/upload-artifact@v4',
    '      - name: Aggregate test results',
    '        if: always()',
    '        run: |',
    '          failed=0',
    "          if [ \"${{ steps.eslint.outcome }}\" = \"failure\" ]; then failed=1; fi",
    "          if [ \"${{ steps['scripts-guards'].outcome }}\" = \"failure\" ]; then failed=1; fi",
    '          exit $failed',
    '  other:',
    '    steps:',
    '      - name: Orphan guard',
    '        id: orphan-guard',
    '        continue-on-error: true',
    '        run: node scripts/check-orphan.mjs',
  ].join('\n')

  it('按 job 提取 continue-on-error 步骤；聚合步 run 内 dot 与 bracket 两形态引用都入集合；纯 uses 的 if:always() 步不产出引用', () => {
    const m = extractJobStepOutcomes(yaml)
    expect([...m.keys()]).toEqual(['lint', 'other'])
    const lint = m.get('lint')
    expect(lint.continueOnError.map((s) => s.id)).toEqual(['eslint', 'scripts-guards'])
    expect(lint.continueOnError[0]).toMatchObject({ id: 'eslint', name: 'ESLint' })
    expect(lint.outcomeRefs).toEqual(new Set(['eslint', 'scripts-guards']))
    // other job 无聚合步 → 只有 continueOnError 侧，无引用
    expect(m.get('other').outcomeRefs).toEqual(new Set())
  })

  it('无 continue-on-error 且无聚合引用的 job 不入 Map；jobs: 之前的块不误判', () => {
    const pre = 'name: CI\non:\n  push:\n    branches: [main]\n'
    const m = extractJobStepOutcomes(pre + yaml)
    expect([...m.keys()]).toEqual(['lint', 'other'])
  })

  it('短横线行内联键（- id:/- continue-on-error:）与 8 空格独立行同语义提取', () => {
    const y = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - id: inline-coe',
      '        continue-on-error: true',
      '        run: pnpm run lint',
      '      - continue-on-error: true',
      '        id: dash-coe',
      '        run: node x.mjs',
    ].join('\n')
    const m = extractJobStepOutcomes(y)
    expect(m.get('lint').continueOnError).toEqual([
      { id: 'inline-coe', name: undefined, line: 4 },
      { id: 'dash-coe', name: undefined, line: 7 },
    ])
  })
})

describe('aggregateFailures：断言③（continue-on-error ↔ 聚合步）判定', () => {
  const build = (yaml) => aggregateFailures(extractJobStepOutcomes(yaml))

  it('全部被同 job 聚合步引用 → 零漂移', () => {
    const yaml = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - name: ESLint',
      '        id: eslint',
      '        continue-on-error: true',
      '        run: pnpm run lint',
      '      - name: Aggregate test results',
      '        if: always()',
      '        run: |',
      "          if [ \"${{ steps.eslint.outcome }}\" = \"failure\" ]; then failed=1; fi",
    ].join('\n')
    expect(build(yaml)).toEqual([])
  })

  it('continue-on-error 步骤未被同 job 聚合步引用 → agg-unwired（跨 job 引用不掩护）', () => {
    const yaml = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - name: ESLint',
      '        id: eslint',
      '        continue-on-error: true',
      '        run: pnpm run lint',
      '  other:',
      '    steps:',
      '      - name: Aggregate',
      '        if: always()',
      '        run: |',
      "          if [ \"${{ steps.eslint.outcome }}\" = \"failure\" ]; then failed=1; fi",
    ].join('\n')
    const f = build(yaml)
    expect(f).toHaveLength(1)
    expect(f[0].kind).toBe('agg-unwired')
    expect(f[0].message).toContain('eslint')
    expect(f[0].message).toContain('lint')
  })

  it('continue-on-error 步骤无 id → agg-unwired（聚合步无法引用）', () => {
    const yaml = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - name: ESLint',
      '        continue-on-error: true',
      '        run: pnpm run lint',
    ].join('\n')
    const f = build(yaml)
    expect(f).toHaveLength(1)
    expect(f[0].kind).toBe('agg-unwired')
    expect(f[0].message).toContain('无 id')
  })

  it('反向幽灵引用（聚合步引用不存在的 id）不报——不掩蔽任何 coe 步骤（掩蔽必伴随未被引用的 coe 步骤，正向断言必红），单向断言', () => {
    const yaml = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - name: Aggregate',
      '        if: always()',
      '        run: |',
      "          if [ \"${{ steps.ghost.outcome }}\" = \"failure\" ]; then failed=1; fi",
    ].join('\n')
    expect(build(yaml)).toEqual([])
  })

  it('内联 - id: 的 coe 步骤被同 job 聚合步引用 → 零漂移（不误报「无 id」）', () => {
    const yaml = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - id: inline-coe',
      '        continue-on-error: true',
      '        run: pnpm run lint',
      '      - name: Aggregate',
      '        if: always()',
      '        run: |',
      "          if [ \"${{ steps.inline-coe.outcome }}\" = \"failure\" ]; then failed=1; fi",
    ].join('\n')
    expect(build(yaml)).toEqual([])
  })

  it('内联 - id: 的 coe 步骤未被引用 → 报「未引用 steps.<id>.outcome」而非「无 id」', () => {
    const yaml = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - id: inline-coe',
      '        continue-on-error: true',
      '        run: pnpm run lint',
    ].join('\n')
    const f = build(yaml)
    expect(f).toHaveLength(1)
    expect(f[0].kind).toBe('agg-unwired')
    expect(f[0].message).toContain('steps.inline-coe.outcome')
    expect(f[0].message).not.toContain('无 id')
  })
})
