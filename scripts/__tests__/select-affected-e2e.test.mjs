/**
 * select-affected-e2e.mjs 单测：diff→rules 匹配逻辑。
 *
 * fixture 场景（内联 map，不依赖真实 e2e-map.json 的内容漂移）：
 *   - scope 命中 / 不命中（prefix/** startsWith 语义与精确路径全等）
 *   - 多 rule 同文件命中（目录 glob rule + 精确路径 rule 并存）
 *   - 删除文件（diff --name-only 含已删除路径——删除同样要触发受影响面）
 *   - always rule 恒入选、--layer 过滤、--release 触发面选择
 *   - --check 防漏登记：watched root 下未覆盖文件 / 已覆盖文件 / 看护域外文件
 * 末组烟测加载真实 docs/testing/e2e-map.json，防 map 与脚本结构漂移无信号。
 */
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  scopeCovers,
  ruleCovers,
  watchedRoots,
  unregisteredWatchedFiles,
  selectRules,
  releaseRules,
} from '../select-affected-e2e.mjs'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

/** 内联 fixture：覆盖匹配语义所需的最小形态（glob / 精确路径 / always / on-pi-bump / 多层） */
function fixtureMap() {
  return {
    rules: [
      {
        id: 'E2E-FAKE-01',
        summary: '目录 glob rule',
        scope: ['packages/runtime/src/infra/pi/**'],
        layer: 'L2.5',
        assets: [{ kind: 'spec', ref: 'packages/runtime/src/__tests__/equivalence/pi-protocol-contract.test.ts' }],
        trigger: 'on-diff',
        serial: false,
        run: 'echo fake-01',
        owner: 'packages/runtime',
        authority: 'docs/TEST-STRATEGY.md',
      },
      {
        id: 'E2E-FAKE-02',
        summary: '精确路径 rule（与 FAKE-01 同文件多 rule 命中）',
        scope: ['packages/runtime/src/infra/pi/pi-protocol.ts'],
        layer: 'L2',
        assets: [{ kind: 'script', ref: 'e2e/workspace-real.spec.ts' }],
        trigger: 'on-diff',
        serial: true,
        run: 'echo fake-02',
        owner: 'packages/runtime',
        authority: 'docs/TEST-STRATEGY.md',
      },
      {
        id: 'E2E-FAKE-03',
        summary: 'always rule',
        scope: ['packages/renderer/src/**'],
        layer: 'L1',
        assets: [{ kind: 'spec', ref: 'e2e/state-tearing.spec.ts' }],
        trigger: 'always',
        serial: false,
        run: 'echo fake-03',
        owner: 'packages/renderer',
        authority: 'docs/TEST-STRATEGY.md',
      },
      {
        id: 'E2E-FAKE-04',
        summary: 'pi-bump rule',
        scope: ['e2e/models-json-sanitize-real.spec.ts'],
        layer: 'L3',
        assets: [{ kind: 'spec', ref: 'e2e/models-json-sanitize-real.spec.ts' }],
        trigger: 'on-pi-bump',
        serial: true,
        run: 'echo fake-04',
        owner: 'packages/runtime',
        authority: 'docs/TEST-STRATEGY.md',
      },
    ],
  }
}

describe('scopeCovers', () => {
  it('prefix/** 命中目录下任意深度文件', () => {
    const scope = ['packages/runtime/src/infra/pi/**']
    expect(scopeCovers(scope, 'packages/runtime/src/infra/pi/pi-protocol.ts')).toBe(true)
    expect(scopeCovers(scope, 'packages/runtime/src/infra/pi/sub/dir/x.ts')).toBe(true)
  })

  it('prefix/** 不命中兄弟路径与前缀相似路径', () => {
    const scope = ['packages/runtime/src/infra/pi/**']
    expect(scopeCovers(scope, 'packages/runtime/src/infra/pi-other/x.ts')).toBe(false)
    expect(scopeCovers(scope, 'packages/core/src/domain/chat/apply-entry.ts')).toBe(false)
  })

  it('精确路径只全等命中', () => {
    const scope = ['e2e/workspace-real.spec.ts']
    expect(scopeCovers(scope, 'e2e/workspace-real.spec.ts')).toBe(true)
    expect(scopeCovers(scope, 'e2e/workspace.spec.ts')).toBe(false)
  })
})

describe('ruleCovers', () => {
  it('scope 不中但 asset ref 精等也算覆盖', () => {
    const rule = fixtureMap().rules[3]
    expect(ruleCovers(rule, 'e2e/models-json-sanitize-real.spec.ts')).toBe(true)
    expect(ruleCovers(rule, 'e2e/other.spec.ts')).toBe(false)
  })
})

describe('selectRules（diff → rules）', () => {
  it('命中：scope 命中的 on-diff rule 被选出（always rule 恒在前列）', () => {
    const map = fixtureMap()
    const rules = selectRules(map, ['packages/runtime/src/infra/pi/event-adapter.ts'])
    expect(rules.map((r) => r.id)).toEqual(['E2E-FAKE-03', 'E2E-FAKE-01'])
  })

  it('不命中：diff 未触任何 scope 时只返回 always rule', () => {
    const map = fixtureMap()
    const rules = selectRules(map, ['docs/unrelated.md'])
    expect(rules.map((r) => r.id)).toEqual(['E2E-FAKE-03'])
  })

  it('多 glob：同文件命中多条 rule（目录 glob + 精确路径）', () => {
    const map = fixtureMap()
    const rules = selectRules(map, ['packages/runtime/src/infra/pi/pi-protocol.ts'])
    expect(rules.map((r) => r.id).sort()).toEqual(['E2E-FAKE-01', 'E2E-FAKE-02', 'E2E-FAKE-03'])
  })

  it('删除文件：diff 里的已删除路径同样触发命中（--name-only 无存在性要求）', () => {
    const map = fixtureMap()
    const rules = selectRules(map, ['packages/runtime/src/infra/pi/pi-protocol.ts.deleted-on-branch'])
    // 目录 glob prefix 命中（文件已删，路径仍落在看护前缀内）+ 精确路径不命中
    expect(rules.map((r) => r.id)).toEqual(['E2E-FAKE-03', 'E2E-FAKE-01'])
  })

  it('always rule 恒入选且不重复（同时命中 scope 时去重）', () => {
    const map = fixtureMap()
    const rules = selectRules(map, ['packages/renderer/src/App.vue'])
    expect(rules.map((r) => r.id)).toEqual(['E2E-FAKE-03'])
  })

  it('--layer 过滤：L3 只留 L3 rule', () => {
    const map = fixtureMap()
    const rules = selectRules(map, ['e2e/models-json-sanitize-real.spec.ts'], { layer: 'L3' })
    // FAKE-04 是 on-pi-bump 不参与 diff 选择；命中的 L2/L2.5 被 layer 滤掉 → 空
    expect(rules).toEqual([])
  })
})

describe('releaseRules（--release）', () => {
  it('只返回 on-release / on-pi-bump 面', () => {
    const rules = releaseRules(fixtureMap())
    expect(rules.map((r) => r.id)).toEqual(['E2E-FAKE-04'])
  })

  it('--layer 可叠加过滤', () => {
    expect(releaseRules(fixtureMap(), { layer: 'L1' })).toEqual([])
  })
})

describe('watchedRoots + unregisteredWatchedFiles（--check）', () => {
  it('watched roots = scope 前缀目录 ∪ 资产族目录（≥2 asset 才整目录看护）', () => {
    // fixture 资产分布：e2e/ 聚合 3 个 asset（资产族，看护）；equivalence/ 仅 1 个（孤资产，不看护）
    expect(watchedRoots(fixtureMap())).toEqual([
      'e2e/',
      'packages/renderer/src/',
      'packages/runtime/src/infra/pi/',
    ])
  })

  it('孤资产落在共享目录不把整目录变成看护根（scripts/ 泛化回归）', () => {
    const map = fixtureMap()
    map.rules.push({
      id: 'E2E-FAKE-05',
      summary: '孤资产在共享目录',
      scope: ['scripts/verify-scheduler-e2e.cjs'],
      layer: 'L2.5',
      assets: [{ kind: 'script', ref: 'scripts/verify-scheduler-e2e.cjs' }],
      trigger: 'on-diff',
      serial: true,
      run: 'echo fake-05',
      owner: 'scripts',
      authority: 'docs/TEST-STRATEGY.md',
    })
    const roots = watchedRoots(map)
    expect(roots).not.toContain('scripts/')
    // 共享目录下的无关新文件不被逼登记
    expect(unregisteredWatchedFiles(map, ['scripts/some-unrelated-tool.mjs'])).toEqual([])
  })

  it('watched root 下未覆盖文件被检出（防漏登记）', () => {
    const map = fixtureMap()
    // e2e/ 是 asset 所在目录（watched），新 spec 不匹配任何 scope → 未登记
    const uncovered = unregisteredWatchedFiles(map, ['e2e/brand-new.spec.ts'])
    expect(uncovered).toEqual(['e2e/brand-new.spec.ts'])
  })

  it('已覆盖文件不误报', () => {
    const map = fixtureMap()
    const uncovered = unregisteredWatchedFiles(map, [
      'e2e/workspace-real.spec.ts', // FAKE-02 asset 精等
      'packages/runtime/src/infra/pi/pi-protocol.ts', // FAKE-01/02 scope
      'packages/runtime/src/__tests__/equivalence/pi-protocol-contract.test.ts', // FAKE-01 asset
    ])
    expect(uncovered).toEqual([])
  })

  it('看护域外文件不参与该门', () => {
    const map = fixtureMap()
    const uncovered = unregisteredWatchedFiles(map, ['random-top-dir/new-file.ts'])
    expect(uncovered).toEqual([])
  })
})

describe('真实 e2e-map.json 烟测（防 map 与脚本结构漂移无信号）', () => {
  const realMap = JSON.parse(readFileSync(join(SCRIPT_DIR, '../../docs/testing/e2e-map.json'), 'utf-8'))

  it('rules 非空且每条可被匹配语义消费（scope/assets/trigger/layer 结构完整）', () => {
    expect(realMap.rules.length).toBeGreaterThanOrEqual(10)
    for (const rule of realMap.rules) {
      expect(Array.isArray(rule.scope) && rule.scope.length > 0, rule.id).toBe(true)
      expect(Array.isArray(rule.assets) && rule.assets.length > 0, rule.id).toBe(true)
      expect(['on-diff', 'always', 'on-release', 'on-pi-bump'], rule.id).toContain(rule.trigger)
      expect(['L1', 'L2', 'L2.5', 'L3'], rule.id).toContain(rule.layer)
    }
  })

  it('watched roots 全部为 / 结尾目录形态（startsWith 语义的前提）', () => {
    for (const root of watchedRoots(realMap)) {
      expect(root.endsWith('/'), root).toBe(true)
    }
  })
})
