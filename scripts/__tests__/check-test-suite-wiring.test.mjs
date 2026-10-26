/**
 * check-test-suite-wiring.mjs 单测：对账器判定语义（ci.yml 步骤解析 + 三类漂移判定）。
 * 真实仓库全量对账 = 脚本本体（CI Invariants + pre-commit 挂载），此处锁定纯函数语义。
 */
import { describe, it, expect } from 'vitest'
import { normCmd, extractStepRuns, wiringFailures } from '../check-test-suite-wiring.mjs'

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
