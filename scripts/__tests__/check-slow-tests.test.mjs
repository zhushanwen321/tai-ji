import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { STAGED_TEST_RE, findJunitFiles, packageForTestFile } from '../check-slow-tests.mjs'

let tmpRoots = []

afterEach(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  tmpRoots = []
})

describe('staged 测试文件识别', () => {
  it('覆盖注册表约定的四种后缀', () => {
    for (const file of ['a.test.ts', 'a.test.tsx', 'a.spec.ts', 'a.test.mjs']) {
      expect(STAGED_TEST_RE.test(file), file).toBe(true)
    }
    for (const file of ['a.ts', 'a.spec.tsx', 'a.test.js']) {
      expect(STAGED_TEST_RE.test(file), file).toBe(false)
    }
  })

  it('映射到实际 junit 落点所属包', () => {
    expect(packageForTestFile('packages/core/src/a.test.ts')).toBe('packages/core')
    expect(packageForTestFile('apps/desktop/src/a.spec.ts')).toBe('apps/desktop')
    expect(packageForTestFile('apps/electron/main/src/a.test.ts')).toBe('apps/electron/main')
    expect(packageForTestFile('extensions/universal/todo/src/a.test.mjs')).toBe('extensions/universal/todo')
    expect(packageForTestFile('scripts/__tests__/guard.test.mjs')).toBeNull()
  })
})

describe('junit 收集', () => {
  it('不把 .tmp 中的修改前基线当成当前结果', () => {
    const root = mkdtempSync(join(tmpdir(), 'slow-tests-'))
    tmpRoots.push(root)
    const current = join(root, 'packages/core/test-results/vitest-junit.xml')
    const baseline = join(root, '.tmp/baseline/test-results/vitest-junit.xml')
    for (const file of [current, baseline]) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '<testsuite/>')
    }
    expect(findJunitFiles(root, [])).toEqual([current])
  })
})
