import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * check-test-extremes.mjs 黑盒自测：四类信号（X1 真子进程未挂门控 / X2 显式大
 * timeout / X3 waitFor 长 timeout / X4 performance.now）的正反例 + 豁免表 + e2e 层
 * 排除。独立模式（显式路径参数）驱动，不依赖 staged 状态。判据权威 =
 * docs/TEST-STRATEGY.md「新写测试判据」节。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHECKER = join(REPO_ROOT, '.githooks', 'check-test-extremes.mjs')

let fixtureRoot

function runChecker(files) {
  try {
    const stdout = execFileSync('node', [CHECKER, ...files], { encoding: 'utf8' })
    return { status: 0, out: stdout }
  } catch (e) {
    // 检查器违规明细走 stderr（console.error），成功摘要走 stdout
    return { status: e.status ?? 1, out: `${String(e.stdout ?? '')}${String(e.stderr ?? '')}` }
  }
}

function writeFixture(name, lines) {
  const p = join(fixtureRoot, name)
  writeFileSync(p, lines.join('\n'))
  return p
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'check-test-extremes-selftest-'))
})

afterAll(() => {
  // maxRetries：teardown 递归删除与在途写竞争（满载 ENOTEMPTY flake，教训 d9ad39cb8）
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('check-test-extremes 判定行为', () => {
  it('X1 正例：import node:child_process + spawn 调用且未挂门控 → exit 1', () => {
    const f = writeFixture('x1-hit.test.ts', [
      "import { spawn } from 'node:child_process'",
      "import { describe, it } from 'vitest'",
      "describe('x', () => { it('spawns', () => { spawn('node', ['-e', '']) }) })",
    ])
    const r = runChecker([f])
    expect(r.status).toBe(1)
    expect(r.out).toContain('X1')
  })

  it('X1 反例：同形态但文件 import INTEGRATION_TESTS_ENABLED → 放行', () => {
    const f = writeFixture('x1-gated.test.ts', [
      "import { spawn } from 'node:child_process'",
      "import { INTEGRATION_TESTS_ENABLED } from '../../test-guard/integration-gate.ts'",
      "import { describe, it } from 'vitest'",
      'void INTEGRATION_TESTS_ENABLED void spawn',
    ])
    const r = runChecker([f])
    expect(r.status).toBe(0)
  })

  it('X2 正例：显式 timeout 30_000 → exit 1；4000 放行', () => {
    const hit = writeFixture('x2-hit.test.ts', [
      "import { describe, it } from 'vitest'",
      "describe('x', () => { it('slow', { timeout: 30_000 }, () => {}) })",
    ])
    expect(runChecker([hit]).status).toBe(1)

    const ok = writeFixture('x2-ok.test.ts', [
      "import { describe, it } from 'vitest'",
      "describe('x', () => { it('fast', { timeout: 4000 }, () => {}) })",
    ])
    expect(runChecker([ok]).status).toBe(0)
  })

  it('X3 正例：waitFor 显式 timeout 2000 → exit 1；500 放行', () => {
    const hit = writeFixture('x3-hit.test.ts', [
      "import { waitFor } from '@vue/test-utils'",
      "import { describe, it } from 'vitest'",
      "describe('x', () => { it('waits', async () => { await waitFor(() => {}, { timeout: 2000 }) }) })",
    ])
    expect(runChecker([hit]).status).toBe(1)

    const ok = writeFixture('x3-ok.test.ts', [
      "import { waitFor } from '@vue/test-utils'",
      "import { describe, it } from 'vitest'",
      "describe('x', () => { it('waits', async () => { await waitFor(() => {}, { timeout: 500 }) }) })",
    ])
    expect(runChecker([ok]).status).toBe(0)
  })

  it('X4 正例：performance.now() 断言素材 → exit 1', () => {
    const f = writeFixture('x4-hit.test.ts', [
      "import { describe, it, expect } from 'vitest'",
      "describe('x', () => { it('p', () => { expect(performance.now()).toBeGreaterThan(0) }) })",
    ])
    const r = runChecker([f])
    expect(r.status).toBe(1)
    expect(r.out).toContain('X4')
  })

  it('豁免表生效：登记路径（quality-gates）跳过全部信号', () => {
    const r = runChecker([join(REPO_ROOT, 'scripts/__tests__/quality-gates.test.mjs')])
    expect(r.status).toBe(0)
  })

  it('e2e 层排除：e2e/ 下 spec 不受单测判据拦', () => {
    const r = runChecker([join(REPO_ROOT, 'e2e/composer.spec.ts')])
    expect(r.status).toBe(0)
  })

  it('非测试文件不扫（fixture helper）', () => {
    const f = writeFixture('helper.ts', [
      "import { spawnSync } from 'node:child_process'",
      'export const probe = () => spawnSync("node", ["-e", ""])',
    ])
    expect(runChecker([f]).status).toBe(0)
  })
})
