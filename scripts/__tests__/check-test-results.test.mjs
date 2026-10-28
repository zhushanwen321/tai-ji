import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-test-results.mjs')
const RESULT_DIRS = [
  'packages/core/test-results',
  'apps/desktop/test-results',
  'apps/electron/main/test-results',
  'extensions/universal/todo/test-results',
]
let tmpRoots = []

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'test-results-'))
  tmpRoots.push(root)
  for (const dir of RESULT_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(
      join(root, dir, 'vitest-junit.xml'),
      '<testsuite name="ok" tests="1" failures="0" errors="0"><testcase name="pass"/></testsuite>',
    )
  }
  return root
}

function run(root, ...flags) {
  const result = spawnSync('node', [SCRIPT, '--root', root, ...flags], { encoding: 'utf8' })
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` }
}

afterEach(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  tmpRoots = []
})

describe('全量 junit 聚合', () => {
  it('收集一级包、应用、Electron 主进程与扩展包', () => {
    const result = run(makeRepo())
    expect(result.status).toBe(0)
    expect(result.out).toContain('4 份 junit 零失败')
  })

  it('扩展包失败会传导为根调度失败', () => {
    const root = makeRepo()
    writeFileSync(
      join(root, 'extensions/universal/todo/test-results/vitest-junit.xml'),
      '<testsuite name="todo" tests="1" failures="1" errors="0"><testcase name="fail"/></testsuite>',
    )
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.out).toContain('extensions/universal/todo/test-results/vitest-junit.xml :: todo (1 failed)')
  })

  it('--clean 同时清理扩展包结果', () => {
    const root = makeRepo()
    const result = run(root, '--clean')
    expect(result.status).toBe(0)
    expect(result.out).toContain('cleaned 4 test-results dirs')
    for (const dir of RESULT_DIRS) expect(existsSync(join(root, dir))).toBe(false)
  })
})
