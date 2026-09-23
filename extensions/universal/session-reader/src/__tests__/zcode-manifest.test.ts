import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { readZcodeManifest, listZcodeManifests } from '../discovery/zcode-manifest.js'
import { findZcodeEntryAnchor } from '../discovery/entry-anchor.js'

// ============================================================
// 变体 M（设计 §4 场景 1a）：zcode manifest 直读（§3.1 第①步主路径）+ 枚举（family 用）。
//
// fixture 对齐 F21 磁盘真实形态：zcode manifest **无 sessionFile 键**
// （投影函数照写 sessionFile: undefined，JSON.stringify 丢键）、engine:'zcode'、
// engineHandle.sessionRef 双键齐。
//
// 单元边界：只测「认出 zcode manifest + 提取锚」；白名单闸 / 错误码映射（U9）、
// entry 兜底定位语义（U7 已交付）不在本文件展开。
// ============================================================

const DB_PATH = '/data/agent/engines/zcode/session-db/db.sqlite'

let agentDir: string

/** 在 <agentDir>/subagents/<slug>/records/ 下写一个 manifest 文件（手写 JSON 字符串，忠实控制键） */
function writeManifest(slug: string, name: string, content: string): string {
  const recordsDir = join(agentDir, 'subagents', slug, 'records')
  mkdirSync(recordsDir, { recursive: true })
  const file = join(recordsDir, name)
  writeFileSync(file, content, 'utf8')
  return file
}

/** 磁盘真实形态的 zcode manifest（无 sessionFile 键——F21） */
function zcodeManifestJson(opts: {
  id: string
  sessionId?: string
  dbPath?: string
  withEngineHandle?: boolean
  engine?: string
  rich?: Record<string, unknown>
}): string {
  const m: Record<string, unknown> = {
    id: opts.id,
    rootSessionId: 'root-1',
    agentName: 'worker',
    status: 'running',
    ...opts.rich,
  }
  // 缺省 zcode（F21 磁盘真实形态）；显式传 'pi' 可覆盖
  m.engine = opts.engine ?? 'zcode'
  if (opts.withEngineHandle !== false) {
    m.engineHandle = {
      sessionRef: { sessionId: opts.sessionId ?? 'sess-1', dbPath: opts.dbPath ?? DB_PATH },
      poolKey: 'shared',
    }
  }
  // 刻意不写 sessionFile 键（F21：JSON.stringify 丢 undefined 键的产物形态）
  return JSON.stringify(m)
}

/** 变体 M instrument 用：主 session 文件里的 subagent-record entry 行（U7 recordLine 同款） */
function recordLine(saId: string, sessionRef: Record<string, string>): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'subagent-record',
    id: `e-${saId}`,
    parentId: null,
    data: { v: 1, id: saId, engine: 'zcode', engineHandle: { sessionRef, poolKey: 'shared' } },
  })
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'zcode-manifest-test-'))
})
afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('readZcodeManifest 直读：有锚 manifest → 取到 sessionRef', () => {
  it('engine zcode + sessionRef 双键齐 → kind=zcode，锚字段正确', async () => {
    writeManifest(
      'proj-a',
      'sa-abc.json',
      zcodeManifestJson({ id: 'sa-abc', sessionId: 'sess_5f3c', dbPath: DB_PATH }),
    )

    const lookup = await readZcodeManifest(agentDir, 'sa-abc')

    expect(lookup.kind).toBe('zcode')
    if (lookup.kind !== 'zcode') return
    expect(lookup.anchor.sessionId).toBe('sess_5f3c')
    expect(lookup.anchor.dbPath).toBe(DB_PATH)
  })

  it('多 cwd 目录窄 walk：目标不在第一个目录 → 后续目录命中（命中即止）', async () => {
    writeManifest('proj-empty', 'sa-other.json', zcodeManifestJson({ id: 'sa-other' }))
    writeManifest(
      'proj-deep',
      'sa-target.json',
      zcodeManifestJson({ id: 'sa-target', sessionId: 'sess-deep', dbPath: DB_PATH }),
    )

    const lookup = await readZcodeManifest(agentDir, 'sa-target')

    expect(lookup.kind).toBe('zcode')
    if (lookup.kind === 'zcode') expect(lookup.anchor.sessionId).toBe('sess-deep')
  })

  it('同目录存在坏 JSON manifest 不影响直读（不解析其他 manifest）', async () => {
    writeManifest('proj-a', 'sa-broken.json', '{"id":"sa-broken", truncated')
    writeManifest(
      'proj-a',
      'sa-good.json',
      zcodeManifestJson({ id: 'sa-good', sessionId: 'sess-good', dbPath: DB_PATH }),
    )

    const lookup = await readZcodeManifest(agentDir, 'sa-good')

    expect(lookup.kind).toBe('zcode')
    if (lookup.kind === 'zcode') expect(lookup.anchor.sessionId).toBe('sess-good')
  })
})

describe('readZcodeManifest 直读：失败信号（U9 错误码映射的归因输入）', () => {
  it('文件不存在（未知 sa-id）→ not-zcode', async () => {
    writeManifest('proj-a', 'sa-abc.json', zcodeManifestJson({ id: 'sa-abc' }))

    expect((await readZcodeManifest(agentDir, 'sa-missing')).kind).toBe('not-zcode')
  })

  it('坏 JSON → not-zcode（残缺 manifest 与今天的 tryReadManifest 丢弃行为等价）', async () => {
    writeManifest('proj-a', 'sa-abc.json', 'not-json-at-all{{{')

    expect((await readZcodeManifest(agentDir, 'sa-abc')).kind).toBe('not-zcode')
  })

  it('engine 缺省（pi 存量形态：有 sessionFile 无 engine）→ not-zcode', async () => {
    writeManifest(
      'proj-a',
      'sa-abc.json',
      JSON.stringify({
        id: 'sa-abc',
        rootSessionId: 'root-1',
        sessionFile: '/sessions/sub.jsonl',
      }),
    )

    expect((await readZcodeManifest(agentDir, 'sa-abc')).kind).toBe('not-zcode')
  })

  it("engine 显式 'pi' → not-zcode", async () => {
    writeManifest(
      'proj-a',
      'sa-abc.json',
      zcodeManifestJson({
        id: 'sa-abc',
        engine: 'pi',
        rich: { sessionFile: '/sessions/sub.jsonl' },
      }),
    )

    expect((await readZcodeManifest(agentDir, 'sa-abc')).kind).toBe('not-zcode')
  })

  it('engineHandle 整体缺席 → anchor-missing + reason=missing-engineHandle（旧版本产物 / 孤儿 manifest）', async () => {
    writeManifest(
      'proj-a',
      'sa-abc.json',
      zcodeManifestJson({ id: 'sa-abc', engine: 'zcode', withEngineHandle: false }),
    )

    const lookup = await readZcodeManifest(agentDir, 'sa-abc')
    expect(lookup.kind).toBe('anchor-missing')
    if (lookup.kind === 'anchor-missing') expect(lookup.reason).toBe('missing-engineHandle')
  })

  it('sessionRef 整体缺席 → anchor-missing + reason=missing-sessionRef', async () => {
    writeManifest(
      'proj-a',
      'sa-abc.json',
      JSON.stringify({ id: 'sa-abc', rootSessionId: 'root-1', engine: 'zcode', engineHandle: { poolKey: 'shared' } }),
    )

    const lookup = await readZcodeManifest(agentDir, 'sa-abc')
    expect(lookup.kind).toBe('anchor-missing')
    if (lookup.kind === 'anchor-missing') expect(lookup.reason).toBe('missing-sessionRef')
  })

  it('sessionRef 缺 dbPath 键 → anchor-missing + reason=missing-dbPath（部分回填的残余形态）', async () => {
    // 手写 JSON：sessionRef 只有 sessionId 单键（zcodeManifestJson 的 ?? 兜底不适用此形态）
    writeManifest(
      'proj-a',
      'sa-abc.json',
      JSON.stringify({
        id: 'sa-abc',
        rootSessionId: 'root-1',
        engine: 'zcode',
        engineHandle: { sessionRef: { sessionId: 'sess-1' }, poolKey: 'shared' },
      }),
    )

    const lookup = await readZcodeManifest(agentDir, 'sa-abc')
    expect(lookup.kind).toBe('anchor-missing')
    if (lookup.kind === 'anchor-missing') expect(lookup.reason).toBe('missing-dbPath')
  })

  it('sessionRef 键为空串 → anchor-missing + reason=missing-sessionId（非空 string 才算锚）', async () => {
    writeManifest(
      'proj-a',
      'sa-abc.json',
      zcodeManifestJson({ id: 'sa-abc', sessionId: '', dbPath: DB_PATH }),
    )

    const lookup = await readZcodeManifest(agentDir, 'sa-abc')
    expect(lookup.kind).toBe('anchor-missing')
    if (lookup.kind === 'anchor-missing') expect(lookup.reason).toBe('missing-sessionId')
  })

  it('subagents 根目录不存在 → not-zcode（不抛异常）', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'zcode-manifest-bare-'))
    try {
      expect((await readZcodeManifest(bareDir, 'sa-abc')).kind).toBe('not-zcode')
    } finally {
      rmSync(bareDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('变体 M 定位分支 instrument：manifest 主路径命中（结果来源标记）', () => {
  it('manifest 与 entry 同 sa-id 各持不同锚 → 直读返回 manifest 的锚（entry 兜底来源未被采信）', async () => {
    // 结果来源标记：两来源锚值刻意不同——若实现（未来的路由编排）错误地跳过主路径
    // 落到 entry 兜底，将得到 'sess-from-entry'，本断言即失败（走对路而非碰巧对）。
    writeManifest(
      'proj-a',
      'sa-inst.json',
      zcodeManifestJson({ id: 'sa-inst', sessionId: 'sess-from-manifest', dbPath: DB_PATH }),
    )
    const mainFile = join(agentDir, 'main.jsonl')
    writeFileSync(
      mainFile,
      [
        JSON.stringify({ type: 'session', id: 'main-1', cwd: '/proj' }),
        recordLine('sa-inst', { sessionId: 'sess-from-entry', dbPath: DB_PATH }),
      ].join('\n') + '\n',
      'utf8',
    )

    // 主路径命中：锚来自 manifest
    const lookup = await readZcodeManifest(agentDir, 'sa-inst')
    expect(lookup.kind).toBe('zcode')
    if (lookup.kind === 'zcode') {
      expect(lookup.anchor.sessionId).toBe('sess-from-manifest')
      expect(lookup.anchor.sessionId).not.toBe('sess-from-entry')
    }

    // 标记有效性自证：entry 兜底（U7 函数）在同 fixture 上返回的是 entry 来源的锚——
    // 两来源可区分，主路径断言非平凡
    const entryAnchor = await findZcodeEntryAnchor([mainFile], 'sa-inst')
    expect(entryAnchor?.sessionId).toBe('sess-from-entry')
  })

  it('manifest 缺位 → not-zcode（此情形才需要 entry 兜底介入——定位链分支边界）', async () => {
    expect((await readZcodeManifest(agentDir, 'sa-none')).kind).toBe('not-zcode')
  })
})

describe('listZcodeManifests 枚举（family 节点列表来源）', () => {
  it('混排目录只返回 zcode 形态：pi manifest / 坏 JSON / 无锚 zcode 全部跳过', async () => {
    writeManifest(
      'proj-a',
      'sa-z1.json',
      zcodeManifestJson({ id: 'sa-z1', sessionId: 'sess-z1', dbPath: DB_PATH }),
    )
    // pi 存量形态（无 engine、有 sessionFile）——枚举不吸入（isRecordManifest 链零改动）
    writeManifest(
      'proj-a',
      'sa-pi.json',
      JSON.stringify({
        id: 'sa-pi',
        rootSessionId: 'root-1',
        sessionFile: '/sessions/pi-sub.jsonl',
        agentName: 'explorer',
      }),
    )
    // engine:'pi' 显式
    writeManifest(
      'proj-a',
      'sa-pi2.json',
      zcodeManifestJson({ id: 'sa-pi2', engine: 'pi', rich: { sessionFile: '/s.jsonl' } }),
    )
    // zcode 但无锚 → 不产出（直读侧归 anchor-missing，枚举侧无节点可建）
    writeManifest(
      'proj-a',
      'sa-noanchor.json',
      zcodeManifestJson({ id: 'sa-noanchor', engine: 'zcode', withEngineHandle: false }),
    )
    // 坏 JSON → 跳过不中断
    writeManifest('proj-a', 'sa-bad.json', '{{{broken')
    // 第二目录的 zcode manifest → 跨目录枚举
    writeManifest(
      'proj-b',
      'sa-z2.json',
      zcodeManifestJson({ id: 'sa-z2', sessionId: 'sess-z2', dbPath: DB_PATH }),
    )

    const manifests = await listZcodeManifests(agentDir)

    expect(manifests.map((m) => m.id).sort()).toEqual(['sa-z1', 'sa-z2'])
    const z1 = manifests.find((m) => m.id === 'sa-z1')
    expect(z1?.engine).toBe('zcode')
    expect(z1?.dbPath).toBe(DB_PATH)
    expect(z1?.rootSessionId).toBe('root-1')
  })

  it('dbFileExists 预计算：dbPath 指向真实文件 → true；不存在路径 → false（stat 不开库）', async () => {
    const realDb = join(agentDir, 'real-db.sqlite')
    writeFileSync(realDb, 'SQLite format 3 stub', 'utf8')
    writeManifest(
      'proj-a',
      'sa-alive.json',
      zcodeManifestJson({ id: 'sa-alive', sessionId: 'sess-a', dbPath: realDb }),
    )
    writeManifest(
      'proj-a',
      'sa-gone.json',
      zcodeManifestJson({ id: 'sa-gone', sessionId: 'sess-g', dbPath: join(agentDir, 'missing-db.sqlite') }),
    )

    const manifests = await listZcodeManifests(agentDir)

    expect(manifests.find((m) => m.id === 'sa-alive')?.dbFileExists).toBe(true)
    expect(manifests.find((m) => m.id === 'sa-gone')?.dbFileExists).toBe(false)
  })

  it('slug 兜底 m.slug ?? m.agentName ?? ""（与 pi 孤儿链同款）', async () => {
    writeManifest(
      'proj-a',
      'sa-s1.json',
      zcodeManifestJson({ id: 'sa-s1', sessionId: 'sess-1', rich: { slug: 'explicit-slug' } }),
    )
    writeManifest(
      'proj-a',
      'sa-s2.json',
      zcodeManifestJson({ id: 'sa-s2', sessionId: 'sess-2' }), // 无 slug → 回退 agentName
    )

    const manifests = await listZcodeManifests(agentDir)

    expect(manifests.find((m) => m.id === 'sa-s1')?.slug).toBe('explicit-slug')
    expect(manifests.find((m) => m.id === 'sa-s2')?.slug).toBe('worker') // agentName 兜底
  })

  it('subagents 根不存在 → 空数组（不报错；单节点不可达不炸整屏）', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'zcode-manifest-bare-'))
    try {
      expect(await listZcodeManifests(bareDir)).toEqual([])
    } finally {
      rmSync(bareDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
