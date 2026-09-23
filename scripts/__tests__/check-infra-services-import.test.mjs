/**
 * check_infra_services_import.py 守卫自身测试（2026-09-20 R1 评审补 MF-1-15：守卫已接线
 * pre-commit（install-hooks.sh CONSTRAINT_CHECKER 循环）而无测试——失效即假绿放行
 * infra→services 反向依赖，三层单向 transport→services←infra 的补向拦截形同虚设）。
 *
 * 模式 = check-guide-contract-projection.test.mjs 同款「tmp mirror + spawnSync」：守卫以
 * `Path(__file__).resolve().parent.parent` 求 PROJECT_ROOT，把脚本复制进 <tmp>/.githooks/
 * 后 ROOT 即 <tmp>，infra fixture 全部落 <tmp>/packages/runtime/src/infra/（mkdtemp 自建
 * 自删，同 scripts/__tests__ 既有惯例，不触真实仓库文件）。锁定行为：
 *   R1 白名单 value import + type-only services import → exit 0
 *   R2 白名单外 value import → exit 2 + 汇总头 + 文件/模块定位 + 修复方向
 *   R3 export re-export from services → exit 2 + 定位（VALUE_FROM_RE 的 export 分支）
 *   R4 排除面：违规仅出现在 *.test.ts 与 __tests__/ → exit 0
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.githooks', 'check_infra_services_import.py')

/** 组装 tmp mirror：<tmp>/.githooks/ 放守卫副本（PROJECT_ROOT 解析即 <tmp>），
 *  files 为 { infra 相对路径: 内容 }，落 <tmp>/packages/runtime/src/infra/ 下。 */
function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'isi-guard-'))
  mkdirSync(join(root, '.githooks'), { recursive: true })
  copyFileSync(SCRIPT_SRC, join(root, '.githooks', 'check_infra_services_import.py'))
  const infraRoot = join(root, 'packages/runtime/src/infra')
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(infraRoot, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const run = () =>
    spawnSync('python3', [join(root, '.githooks', 'check_infra_services_import.py')], {
      encoding: 'utf-8',
      timeout: 30_000,
    })
  return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) }
}

describe('check_infra_services_import（tmp mirror × spawnSync）', () => {
  it('R1 白名单 value import + type-only services import → exit 0 静默通过', () => {
    const fx = makeFixture({
      'event-adapter/adapter.ts': `import type { PlanState } from '../services/plan-state-extractor.js'
import { deriveEnabled } from '../services/provider-catalog.js'
import { readFile } from 'node:fs/promises'

export const ready = () => deriveEnabled() !== null
`,
    })
    try {
      const r = fx.run()
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
      expect(r.stdout).toBe('')
    } finally {
      fx.cleanup()
    }
  })

  it('R2 白名单外 value import → exit 2 + 汇总头 + 文件/模块定位 + 修复方向', () => {
    const fx = makeFixture({
      'event-adapter/adapter.ts': `import { EXTRACT_LIMIT } from '../services/plan-state-extractor.js'

export const limit = EXTRACT_LIMIT
`,
    })
    try {
      const r = fx.run()
      expect(r.status).toBe(2)
      expect(r.stdout).toContain('[check_infra_services_import]')
      expect(r.stdout).toContain('packages/runtime/src/infra/event-adapter/adapter.ts')
      expect(r.stdout).toContain('services/plan-state-extractor')
      expect(r.stdout).toContain('修复方向')
    } finally {
      fx.cleanup()
    }
  })

  it('R3 export re-export from services → exit 2 + 定位（export 分支同样拦截）', () => {
    const fx = makeFixture({
      'shell-runner/index.ts': `export { SOME_CONST } from '../services/plan-state-extractor.js'
`,
    })
    try {
      const r = fx.run()
      expect(r.status).toBe(2)
      expect(r.stdout).toContain('packages/runtime/src/infra/shell-runner/index.ts')
      expect(r.stdout).toContain('services/plan-state-extractor')
    } finally {
      fx.cleanup()
    }
  })

  it('R4 排除面：违规仅出现在 *.test.ts 与 __tests__/ → exit 0', () => {
    const violating = `import { EXTRACT_LIMIT } from '../services/plan-state-extractor.js'
export const limit = EXTRACT_LIMIT
`
    const fx = makeFixture({
      'scanner-base/index.test.ts': violating,
      '__tests__/helper.ts': violating,
    })
    try {
      const r = fx.run()
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    } finally {
      fx.cleanup()
    }
  })
})
