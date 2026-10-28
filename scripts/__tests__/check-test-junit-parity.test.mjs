import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-test-junit-parity.mjs')
let tmpRoots = []

function writeCases(root, cases, classname = 'src/a.test.ts') {
  const dir = join(root, 'packages/core/test-results')
  mkdirSync(dir, { recursive: true })
  const body = cases
    .map((name) => `<testcase classname="${classname}" name="${name}" time="0.001"></testcase>`)
    .join('\n')
  writeFileSync(join(dir, 'vitest-junit.xml'), `<testsuites><testsuite>${body}</testsuite></testsuites>`)
}

function makePair(before, after, afterClassname) {
  const root = mkdtempSync(join(tmpdir(), 'junit-parity-'))
  tmpRoots.push(root)
  const baseline = join(root, 'baseline')
  const current = join(root, 'current')
  writeCases(baseline, before)
  writeCases(current, after, afterClassname)
  return { baseline, current }
}

function run(pair, ...flags) {
  const result = spawnSync(
    'node',
    [SCRIPT, '--baseline', pair.baseline, '--current', pair.current, ...flags],
    { encoding: 'utf8' },
  )
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` }
}

afterEach(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  tmpRoots = []
})

describe('JUnit 用例多重集对拍', () => {
  it('完整身份一致时允许重复用例名并解码 XML 实体', () => {
    const pair = makePair(['suite &gt; same', 'suite &gt; same'], ['suite &gt; same', 'suite &gt; same'])
    const result = run(pair)
    expect(result.status).toBe(0)
    expect(result.out).toContain('baseline=2 current=2 exact=2')
  })

  it('总数相同但改名仍报 missing/extra', () => {
    const result = run(makePair(['old name'], ['new name']))
    expect(result.status).toBe(1)
    expect(result.out).toContain('MISSING packages/core/src/a.test.ts :: old name')
    expect(result.out).toContain('EXTRA packages/core/src/a.test.ts :: new name')
  })

  it('文件迁移只在显式允许后通过', () => {
    const pair = makePair(['same'], ['same'], 'src/merged.test.ts')
    expect(run(pair).status).toBe(1)
    expect(run(pair, '--allow-relocation').status).toBe(0)
  })

  it('新增外层 describe 可与文件迁移组合配对', () => {
    const pair = makePair(['suite &gt; case'], ['merged &gt; suite &gt; case'], 'src/merged.test.ts')
    const result = run(pair, '--allow-relocation', '--allow-describe-prefix')
    expect(result.status).toBe(0)
    expect(result.out).toContain('describe-prefix=1 missing=0 extra=0')

    const nested = makePair(['case'], ['first &gt; second &gt; case'], 'src/merged.test.ts')
    expect(run(nested, '--allow-relocation', '--allow-describe-prefix').status).toBe(1)
  })

  it('重复计数减少与有歧义的前缀配对都失败', () => {
    const missing = run(makePair(['same', 'same'], ['same']))
    expect(missing.status).toBe(1)
    expect(missing.out).toContain('missing=1 extra=0')

    const ambiguous = run(
      makePair(['same', 'same'], ['merged &gt; same', 'merged &gt; same']),
      '--allow-relocation',
      '--allow-describe-prefix',
    )
    expect(ambiguous.status).toBe(1)
    expect(ambiguous.out).toContain('missing=2 extra=2')
  })
})
