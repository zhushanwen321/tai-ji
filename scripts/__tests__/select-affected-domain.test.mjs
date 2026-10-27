/**
 * select-affected-domain.mjs 单测：diff → 域 匹配/闭包/广播/门禁逻辑。
 *
 * fixture 场景（scripts/__tests__/fixtures/domain-slices/ok/ 的注册表数据 + 内联 slices）：
 *   - 选择：scope（层 glob）/ tests glob / sharedBy 反查三类命中与零命中
 *   - 闭包：契约附加对侧域 + A→B→C 级联 fixpoint
 *   - 广播：broadcastCarriers 精确/前缀命中（宁全勿缺）
 *   - 门禁：watched root 下未归域文件检出 / 三类覆盖不误报 / 看护域外不参与
 *   - watchedRoots 推导：目录结构事实（packages/<pkg>/src、packages/runtime/test、apps/<app>/main、
 *     extensions/<group>/<ext>/src；无 src/main 的包不产生看护根）
 * 末组烟测加载真实 docs/testing/domain-slices/ 注册表，防注册表与脚本结构漂移无信号。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  globCovers,
  sliceCovers,
  sharedByDomains,
  selectAffectedDomains,
  unregisteredWatchedFiles,
  watchedRoots,
  loadRegistry,
} from '../select-affected-domain.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE_OK = join(SCRIPT_DIR, 'fixtures', 'domain-slices', 'ok')

function fixtureSlices({ stripContracts = false } = {}) {
  const slices = ['chat.json', 'archive.json', 'uncategorized.json'].map((f) =>
    JSON.parse(readFileSync(join(FIXTURE_OK, f), 'utf-8')),
  )
  return stripContracts ? slices.map((s) => ({ ...s, contracts: [] })) : slices
}

const fixtureMeta = JSON.parse(readFileSync(join(FIXTURE_OK, '_meta.json'), 'utf-8'))

describe('globCovers', () => {
  it('prefix/** 命中目录下任意深度文件与目录本体，不命中兄弟前缀', () => {
    const globs = ['packages/core/src/domain/chat/**']
    expect(globCovers(globs, 'packages/core/src/domain/chat/contract.ts')).toBe(true)
    expect(globCovers(globs, 'packages/core/src/domain/chat/__tests__/deep/a.test.ts')).toBe(true)
    expect(globCovers(globs, 'packages/core/src/domain/chat')).toBe(true)
    expect(globCovers(globs, 'packages/core/src/domain/chat-other/x.ts')).toBe(false)
  })

  it('精确路径只全等命中', () => {
    expect(globCovers(['packages/shared/src/protocol.ts'], 'packages/shared/src/protocol.ts')).toBe(true)
    expect(globCovers(['packages/shared/src/protocol.ts'], 'packages/shared/src/protocol.ts.bak')).toBe(false)
  })
})

describe('sliceCovers', () => {
  it('scope 层 glob 与 tests glob 并集覆盖', () => {
    const chat = fixtureSlices()[0]
    expect(sliceCovers(chat, 'packages/core/src/domain/chat/contract.ts')).toBe(true) // scope.core
    expect(sliceCovers(chat, 'packages/core/src/domain/chat/__tests__/chat-flow.test.ts')).toBe(true) // tests
    expect(sliceCovers(chat, 'packages/core/src/domain/archive/__tests__/archive-store.test.ts')).toBe(false)
  })
})

describe('sharedByDomains（owner 唯一、触发集合可多）', () => {
  it('混合 bundle 文件反查出注记域，不含 owner 自身', () => {
    const slices = fixtureSlices()
    expect(sharedByDomains(slices, 'packages/runtime/src/services/mixed/__tests__/mixed-bundle.test.ts')).toEqual(['chat'])
  })

  it('未注记文件反查为空', () => {
    expect(sharedByDomains(fixtureSlices(), 'packages/core/src/domain/chat/contract.ts')).toEqual([])
  })
})

describe('selectAffectedDomains（选择 + 契约闭包 + 广播）', () => {
  it('选择：scope/tests/sharedBy 三类命中各归域，无命中返回空', () => {
    const slices = fixtureSlices({ stripContracts: true })
    expect(selectAffectedDomains(slices, [], ['packages/core/src/domain/chat/contract.ts']).affected).toEqual(['chat'])
    expect(selectAffectedDomains(slices, [], ['packages/core/src/domain/chat/__tests__/chat-turn.test.ts']).affected).toEqual(['chat'])
    expect(
      selectAffectedDomains(slices, [], ['packages/runtime/src/services/mixed/__tests__/mixed-bundle.test.ts']).affected,
    ).toEqual(['chat', 'uncategorized'])
    expect(selectAffectedDomains(slices, [], ['docs/unrelated.md']).affected).toEqual([])
  })

  it('闭包：受影响域的 contracts 附加对侧域（chat → archive）', () => {
    const { affected, reasons } = selectAffectedDomains(fixtureSlices(), [], [
      'packages/core/src/domain/chat/contract.ts',
    ])
    expect(affected).toEqual(['archive', 'chat'])
    const archiveReasons = reasons.get('archive')
    expect(archiveReasons.some((r) => r.via === 'contracts' && r.glob === 'contracts:chat→archive')).toBe(true)
  })

  it('闭包：A→B→C 契约级联至 fixpoint', () => {
    const slices = [
      { name: 'a', summary: 'a', tests: ['pkg/a.test.ts'], contracts: [{ carrier: 'pkg/a.test.ts', on: ['b'] }] },
      { name: 'b', summary: 'b', tests: ['pkg/b.test.ts'], contracts: [{ carrier: 'pkg/b.test.ts', on: ['c'] }] },
      { name: 'c', summary: 'c', tests: ['pkg/c.test.ts'] },
    ]
    expect(selectAffectedDomains(slices, [], ['pkg/a.test.ts']).affected).toEqual(['a', 'b', 'c'])
  })

  it('广播：diff 命中 broadcastCarriers（精确或前缀 glob）→ 建议全量', () => {
    const r1 = selectAffectedDomains(fixtureSlices({ stripContracts: true }), fixtureMeta.broadcastCarriers, [
      'packages/shared/src/protocol.ts',
    ])
    expect(r1.broadcastHits).toEqual(['packages/shared/src/protocol.ts'])
    const r2 = selectAffectedDomains([], ['packages/shared/src/**'], ['packages/shared/src/other.ts'])
    expect(r2.broadcastHits).toEqual(['packages/shared/src/other.ts'])
    expect(selectAffectedDomains([], ['packages/shared/src/protocol.ts'], ['docs/x.md']).broadcastHits).toEqual([])
  })

  it('一文件命中多域（不同域 scope 重叠）时多域齐入选（超集方向，不漏跑）', () => {
    const slices = [
      { name: 'x', summary: 'x', scope: { core: ['pkg/shared/**'] } },
      { name: 'y', summary: 'y', tests: ['pkg/shared/a.test.ts'] },
    ]
    expect(selectAffectedDomains(slices, [], ['pkg/shared/a.test.ts']).affected).toEqual(['x', 'y'])
  })
})

describe('unregisteredWatchedFiles（--check/--staged 门禁）', () => {
  const roots = ['packages/runtime/test/', 'packages/core/src/']

  it('watched root 下不被任何域覆盖的文件被检出（防漏归域）', () => {
    expect(unregisteredWatchedFiles(fixtureSlices(), roots, ['packages/runtime/test/root-bundle.test.ts'])).toEqual([
      'packages/runtime/test/root-bundle.test.ts',
    ])
  })

  it('scope/tests/sharedBy 键覆盖的文件不误报', () => {
    expect(
      unregisteredWatchedFiles(fixtureSlices(), roots, [
        'packages/core/src/domain/chat/contract.ts', // scope
        'packages/core/src/domain/chat/__tests__/chat-flow.test.ts', // tests
        'packages/runtime/src/services/mixed/__tests__/mixed-bundle.test.ts', // sharedBy 键（owner=uncategorized tests）
      ]),
    ).toEqual([])
  })

  it('看护域外文件不参与该门', () => {
    expect(unregisteredWatchedFiles(fixtureSlices(), roots, ['docs/testing/domain-slices/new.json'])).toEqual([])
  })
})

describe('watchedRoots（目录结构推导）', () => {
  it('packages/*/src、packages/runtime/test、apps/*/main、extensions/<group>/<ext>/src 各成看护根', () => {
    const root = mkdtempSync(join(tmpdir(), 'watched-roots-'))
    try {
      for (const d of [
        'packages/x/src',
        'packages/y', // 无 src：不看护
        'packages/runtime/test',
        'apps/electron/main',
        'apps/other', // 无 main：不看护
        'extensions/universal/todo/src',
        'docs/testing',
      ]) {
        mkdirSync(join(root, d), { recursive: true })
      }
      expect(watchedRoots(root)).toEqual([
        'apps/electron/main/',
        'extensions/universal/todo/src/',
        'packages/runtime/test/',
        'packages/x/src/',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('真实注册表烟测（防注册表与脚本结构漂移无信号）', () => {
  const W2B_14 = [
    'app-shell', 'archive', 'btw', 'canvas', 'chat', 'new-task', 'panel', 'plan',
    'settings', 'shell', 'sidebar', 'subagent', 'terminal', 'tray',
  ]

  it('38 域（35 功能域 + foundation/host/uncategorized）全部在册且域名唯一', () => {
    const { slices, meta } = loadRegistry()
    expect(slices.length).toBe(38)
    expect(new Set(slices.map((s) => s.name)).size).toBe(38)
    expect(meta).toBeTruthy()
    for (const pool of ['foundation', 'host', 'uncategorized']) {
      expect(slices.some((s) => s.name === pool), pool).toBe(true)
    }
  })

  it('W2-B 14 域全部携带前向兼容声明（批 A 骨架态 = pending）', () => {
    const { slices } = loadRegistry()
    const byName = new Map(slices.map((s) => [s.name, s]))
    for (const name of W2B_14) {
      expect(byName.get(name)?.w2bMountCompat?.status, name).toBe('pending')
    }
  })

  it('goal 示例域为完整形态（scope/tests 非空，整包单域一条 glob）', () => {
    const { slices } = loadRegistry()
    const goal = slices.find((s) => s.name === 'goal')
    expect(goal?.scope?.extension).toEqual(['extensions/universal/goal/**'])
    expect(goal?.tests?.length).toBeGreaterThan(0)
  })
})
