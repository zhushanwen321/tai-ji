/**
 * check-domain-slices.mjs 单测：注册表健康度校验管线。
 *
 * 形态沿 check-domain-type-path.test.mjs 先例：临时目录组装夹具仓（注册表数据取自
 * scripts/__tests__/fixtures/domain-slices/{ok,bad}/，测试文件本体在 tmp 生成——不把
 * .test.ts 夹具提交进仓，防根级 vitest 误收集），经 --root 注入子进程执行：
 *   - 干净树 PASS（--stats/--uncovered 输出形态）
 *   - 互斥反例（双归属，fixtures/bad/overlap.json）
 *   - 漂移反例（死精确路径 + 死 glob 前缀，fixtures/bad/drift.json）
 *   - W2-B 交叉核对（挂载文件缺收 / status 与 tests 空非空不一致 / 非 W2-B 域携带声明）
 *   - sharedBy 键不在 owner 域展开 / 注记域不存在
 *   - contracts carrier 未被 scope 覆盖 / on 域不存在
 *   - e2eRules 引用不存在 / uncategorized glob 禁用与棘轮 / name≠文件名
 *   - coverageEnforced 硬验收开关
 * 纯函数（expandTestGlobs / readRegistry / pkgOf）直测；末组对真实仓库根跑全量校验。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandTestGlobs, readRegistry, pkgOf } from '../check-domain-slices.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(SCRIPT_DIR, '..', 'check-domain-slices.mjs')
const FIXTURE = join(SCRIPT_DIR, 'fixtures', 'domain-slices')

/** 夹具仓的全部测试/源文件（存在性校验的对象；node_modules 子目录验证展开跳过）。 */
const TREE_FILES = [
  'packages/core/src/domain/chat/__tests__/chat-flow.test.ts',
  'packages/core/src/domain/chat/__tests__/chat-turn.test.ts',
  'packages/core/src/domain/chat/__tests__/node_modules/skip.test.ts',
  'packages/core/src/domain/chat/contract.ts',
  'packages/core/src/domain/archive/__tests__/archive-store.test.ts',
  'packages/runtime/src/services/mixed/__tests__/mixed-bundle.test.ts',
  'packages/runtime/test/root-bundle.test.ts',
  'apps/electron/main/main-window.test.ts',
  'extensions/universal/todo/src/__tests__/todo.test.ts',
  'packages/shared/src/protocol.ts',
]

let tmpRoots = []

/** 组装夹具仓：ok/ 注册表 + domain-map/e2e-map + 测试文件树；overrides 逐域覆写。 */
function makeRepo({ registry = {}, meta } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'domain-slices-'))
  tmpRoots.push(root)
  const regDir = join(root, 'docs/testing/domain-slices')
  mkdirSync(regDir, { recursive: true })
  for (const f of ['_meta.json', 'chat.json', 'archive.json', 'uncategorized.json']) {
    cpSync(join(FIXTURE, 'ok', f), join(regDir, f))
  }
  for (const [name, doc] of Object.entries(registry)) {
    writeFileSync(join(regDir, `${name}.json`), JSON.stringify(doc, null, 2))
  }
  if (meta) writeFileSync(join(regDir, '_meta.json'), JSON.stringify(meta, null, 2))
  cpSync(join(FIXTURE, 'ok/domain-map.json'), join(root, 'docs/testing/domain-map.json'))
  cpSync(join(FIXTURE, 'ok/e2e-map.json'), join(root, 'docs/testing/e2e-map.json'))
  for (const f of TREE_FILES) {
    mkdirSync(dirname(join(root, f)), { recursive: true })
    writeFileSync(join(root, f), '')
  }
  return root
}

/** bad/ 反例 JSON 覆写指定域后再校验。 */
function overlay(root, name, badFile) {
  cpSync(join(FIXTURE, 'bad', badFile), join(root, 'docs/testing/domain-slices', `${name}.json`))
}

function run(root, ...flags) {
  const r = spawnSync('node', [SCRIPT, '--root', root, ...flags], { encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

afterEach(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  tmpRoots = []
})

describe('干净夹具仓（基线 PASS）', () => {
  it('结构/存在性/唯一归属/W2-B 交叉核对/sharedBy/contracts/e2eRules 全通过', () => {
    const r = run(makeRepo())
    expect(r.status).toBe(0)
    expect(r.out).toContain('[domain-slices] OK：3 域')
    expect(r.out).toContain('未覆盖 3') // root-bundle / main-window / todo 未登记（coverageEnforced=false 仅报告）
  })

  it('--stats 输出每域文件数与包分布，--uncovered 输出完整未覆盖清单', () => {
    const root = makeRepo()
    const r = run(root, '--stats', '--uncovered')
    expect(r.status).toBe(0)
    expect(r.out).toContain('| 域 | 状态 | 文件数 | 包分布 |')
    expect(r.out).toContain('| chat | filled | 2 | packages/core: 2 |')
    expect(r.out).toContain('packages/runtime/test/root-bundle.test.ts')
    expect(r.out).toContain('apps/electron/main/main-window.test.ts')
  })
})

describe('互斥反例（唯一归属）', () => {
  it('两域 tests 展开重叠 → 双归属红灯', () => {
    const root = makeRepo()
    overlay(root, 'archive', 'overlap.json')
    const r = run(root)
    expect(r.status).toBe(1)
    expect(r.out).toContain('双归属')
    expect(r.out).toContain('chat-flow.test.ts')
  })
})

describe('漂移反例（登记与磁盘不一致）', () => {
  it('死精确路径 + 死 glob 前缀目录 → 红灯', () => {
    const root = makeRepo()
    overlay(root, 'chat', 'drift.json')
    const r = run(root)
    expect(r.status).toBe(1)
    expect(r.out).toContain('精确路径 "packages/core/src/domain/chat/__tests__/gone.test.ts" 不在盘上')
    expect(r.out).toContain('前缀目录不在盘上')
    // 展开为空后 W2-B 交叉核对同步红灯（挂载文件未被收录）
    expect(r.out).toContain('domain-map.json 挂载文件')
  })
})

describe('W2-B 交叉核对（domain-map.json ⊆ 同名切片域展开）', () => {
  it('enforced 但挂载文件未收录 → 红灯', () => {
    const chat = JSON.parse(readFileSync(join(FIXTURE, 'ok/chat.json'), 'utf-8'))
    chat.tests = ['packages/core/src/domain/chat/__tests__/chat-turn.test.ts'] // 缺 chat-flow（domain-map 登记）
    const r = run(makeRepo({ registry: { chat } }))
    expect(r.status).toBe(1)
    expect(r.out).toContain('domain-map.json 挂载文件 "packages/core/src/domain/chat/__tests__/chat-flow.test.ts" 未被本切片域')
  })

  it('tests 已填但 status=pending → 声明过期红灯；tests 空但 enforced → 红灯', () => {
    const chat = JSON.parse(readFileSync(join(FIXTURE, 'ok/chat.json'), 'utf-8'))
    chat.w2bMountCompat.status = 'pending'
    expect(run(makeRepo({ registry: { chat } })).out).toContain('仍为 pending')

    const archive = JSON.parse(readFileSync(join(FIXTURE, 'ok/archive.json'), 'utf-8'))
    archive.tests = []
    archive.w2bMountCompat.status = 'enforced'
    expect(run(makeRepo({ registry: { archive } })).out).toContain('status=enforced 但 tests 为空')
  })

  it('非 W2-B 域携带 w2bMountCompat → 红灯', () => {
    const uncat = JSON.parse(readFileSync(join(FIXTURE, 'ok/uncategorized.json'), 'utf-8'))
    uncat.w2bMountCompat = { mountSource: 'docs/testing/domain-map.json', status: 'pending' }
    const r = run(makeRepo({ registry: { uncategorized: uncat } }))
    expect(r.status).toBe(1)
    expect(r.out).toContain('非 W2-B 域携带 w2bMountCompat')
  })

  it('domain-map 域在切片注册表缺同名文件 → 红灯', () => {
    const root = makeRepo()
    rmSync(join(root, 'docs/testing/domain-slices/archive.json'))
    const r = run(root)
    expect(r.status).toBe(1)
    expect(r.out).toContain('W2-B 域 "archive" 在切片注册表无同名文件')
  })
})

describe('sharedBy / contracts / e2eRules / uncategorized 纪律', () => {
  it('sharedBy 键不在 owner 域展开 → 红灯；注记域不存在 → 红灯', () => {
    const uncat = JSON.parse(readFileSync(join(FIXTURE, 'ok/uncategorized.json'), 'utf-8'))
    uncat.sharedBy = { 'packages/core/src/domain/chat/__tests__/chat-flow.test.ts': ['chat'] } // 键不是本域文件
    const r1 = run(makeRepo({ registry: { uncategorized: uncat } }))
    expect(r1.status).toBe(1)
    expect(r1.out).toContain('不在本域 tests 展开中')

    const uncat2 = JSON.parse(readFileSync(join(FIXTURE, 'ok/uncategorized.json'), 'utf-8'))
    uncat2.sharedBy = { 'packages/runtime/src/services/mixed/__tests__/mixed-bundle.test.ts': ['nope'] }
    const r2 = run(makeRepo({ registry: { uncategorized: uncat2 } }))
    expect(r2.status).toBe(1)
    expect(r2.out).toContain('注记的域 "nope" 不存在')
  })

  it('contracts carrier 未被本域 scope 覆盖 / on 域不存在 → 红灯', () => {
    const chat = JSON.parse(readFileSync(join(FIXTURE, 'ok/chat.json'), 'utf-8'))
    chat.contracts = [{ carrier: 'packages/runtime/src/services/mixed/x.ts', on: ['archive'] }]
    const r1 = run(makeRepo({ registry: { chat } }))
    expect(r1.status).toBe(1)
    expect(r1.out).toContain('未被本域 scope 覆盖')

    const chat2 = JSON.parse(readFileSync(join(FIXTURE, 'ok/chat.json'), 'utf-8'))
    chat2.contracts = [{ carrier: 'packages/core/src/domain/chat/contract.ts', on: ['nope'] }]
    const r2 = run(makeRepo({ registry: { chat: chat2 } }))
    expect(r2.status).toBe(1)
    expect(r2.out).toContain('contracts.on 引用的域 "nope" 不存在')
  })

  it('e2eRules 引用不存在的 rule id → 红灯', () => {
    const chat = JSON.parse(readFileSync(join(FIXTURE, 'ok/chat.json'), 'utf-8'))
    chat.e2eRules = ['E2E-NOPE-99']
    const r = run(makeRepo({ registry: { chat } }))
    expect(r.status).toBe(1)
    expect(r.out).toContain('E2E-NOPE-99')
  })

  it('uncategorized 用 /** glob → 红灯；展开数超棘轮基线 → 红灯', () => {
    const uncat = JSON.parse(readFileSync(join(FIXTURE, 'ok/uncategorized.json'), 'utf-8'))
    uncat.tests = ['packages/runtime/test/**']
    const r1 = run(makeRepo({ registry: { uncategorized: uncat } }))
    expect(r1.status).toBe(1)
    expect(r1.out).toContain('禁 /** glob')

    const r2 = run(makeRepo({ meta: { broadcastCarriers: [], uncategorizedBaseline: 0, coverageEnforced: false } }))
    expect(r2.status).toBe(1)
    expect(r2.out).toContain('棘轮基线')
  })
})

describe('结构与覆盖完备开关', () => {
  it('name 与文件名不一致 → 红灯', () => {
    const root = makeRepo()
    const doc = JSON.parse(readFileSync(join(root, 'docs/testing/domain-slices/archive.json'), 'utf-8'))
    doc.name = 'other'
    writeFileSync(join(root, 'docs/testing/domain-slices/archive.json'), JSON.stringify(doc))
    const r = run(root)
    expect(r.status).toBe(1)
    expect(r.out).toContain('name 与文件名不一致')
  })

  it('coverageEnforced=true 时未覆盖文件非空 → 红灯', () => {
    const meta = { broadcastCarriers: [], uncategorizedBaseline: 1, coverageEnforced: true }
    const r = run(makeRepo({ meta }))
    expect(r.status).toBe(1)
    expect(r.out).toContain('覆盖不完备')
  })
})

describe('纯函数', () => {
  it('expandTestGlobs：glob 展开 + node_modules 跳过 + 死 glob/死路径 problems', () => {
    const root = makeRepo()
    const ok = expandTestGlobs(root, ['packages/core/src/domain/chat/__tests__/**'])
    expect(ok.files).toEqual([
      'packages/core/src/domain/chat/__tests__/chat-flow.test.ts',
      'packages/core/src/domain/chat/__tests__/chat-turn.test.ts',
    ]) // node_modules/skip.test.ts 被跳过
    expect(ok.problems).toEqual([])

    const bad = expandTestGlobs(root, ['packages/core/src/gone/**', 'packages/core/src/domain/chat/contract.ts'])
    expect(bad.problems).toEqual([
      'glob "packages/core/src/gone/**" 前缀目录不在盘上',
      '精确路径 "packages/core/src/domain/chat/contract.ts" 不是测试文件（.test.ts / .test.tsx / .spec.ts / .test.mjs）',
    ])
  })

  it('pkgOf：packages/apps/extensions 包归属分组', () => {
    expect(pkgOf('packages/core/src/a.test.ts')).toBe('packages/core')
    expect(pkgOf('apps/electron/main/a.test.ts')).toBe('apps/electron')
    expect(pkgOf('extensions/universal/todo/src/a.test.ts')).toBe('extensions/universal/todo')
    expect(pkgOf('other/a/b.test.ts')).toBe('other/a')
  })

  it('readRegistry：_meta 剥离、逐文件解析、坏 JSON 入 errors', () => {
    const root = makeRepo()
    const { slices, meta, errors } = readRegistry(join(root, 'docs/testing/domain-slices'))
    expect(errors).toEqual([])
    expect(slices.map((s) => s.name).sort()).toEqual(['archive', 'chat', 'uncategorized'])
    expect(meta.broadcastCarriers).toEqual(['packages/shared/src/protocol.ts'])

    writeFileSync(join(root, 'docs/testing/domain-slices/broken.json'), '{oops')
    expect(readRegistry(join(root, 'docs/testing/domain-slices')).errors.length).toBe(1)
  })
})

describe('真实仓库全量校验（全域注册终态）', () => {
  it('38 域全部 filled 且 W2-B 14 域全部 enforced（未覆盖仅报告）', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', cwd: SCRIPT_DIR })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('[domain-slices] OK：38 域（filled 38 / pending 0）')
    expect(r.stdout).toContain('W2-B 交叉核对 enforced 14 / pending 0')
  }, 120_000)
})
