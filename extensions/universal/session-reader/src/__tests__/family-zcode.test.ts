import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { buildFamilyIndex, resolveFamily, buildZcodeSubagentsByRoot } from '../core/family.js'
import type { Entry, ZcodeFamilyNode } from '../core/family.js'
import { listZcodeManifests } from '../discovery/zcode-manifest.js'

// ============================================================
// family zcode 分支（design session-reader-shared-core §3.3 D5-1 / §4 场景 2）。
//
// 判据（两项、不开库）：锚可解析（枚举谓词已过）∧ 库文件存在（stat）→ cleanedUp=false；
// 缺一 → true（GC 语义，不报错不抛异常）。刻意不含「库内 session 查询」第三项——
// 静息态 CANTOPEN 会误判活会话 + 列表视图不开库；反向断言（库文件在但库内 session
// 行被删 → 仍 false）即「列表视图不开库」的分工声明断言。
//
// 与 pi 判据不同构（D5-1 显式声明）：pi = fileStats JSONL 存在性；zcode 节点无
// JSONL 文件，按「库可达」判。pi 侧既有 fixture 行为零变化由 family.test.ts 全绿守卫
// （本文件零改动 family.test.ts——更强的零涟漪证据）。
// ============================================================

const ROOT = 'root-session-1'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'family-zcode-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function header(id: string): Entry {
  return { type: 'session', id, parentId: null, cwd: '/proj' }
}

/** zcode 节点（core 层判据输入，与 ZcodeManifestRecord 结构兼容） */
function zcodeNode(opts: Partial<ZcodeFamilyNode> & { id: string }): ZcodeFamilyNode {
  return {
    rootSessionId: ROOT,
    slug: 'worker',
    dbPath: join(dir, 'db.sqlite'),
    dbFileExists: false,
    ...opts,
  }
}

/** 在 <agentDir>/subagents/<slug>/records/ 下写 zcode manifest（F21 磁盘真实形态：无 sessionFile 键） */
function writeZcodeManifest(
  agentDir: string,
  saId: string,
  sessionRef: Record<string, string>,
): void {
  const recordsDir = join(agentDir, 'subagents', 'proj-a', 'records')
  mkdirSync(recordsDir, { recursive: true })
  writeFileSync(
    join(recordsDir, `${saId}.json`),
    JSON.stringify({
      id: saId,
      rootSessionId: ROOT,
      agentName: 'worker',
      status: 'running',
      engine: 'zcode',
      engineHandle: { sessionRef, poolKey: 'shared' },
    }),
    'utf8',
  )
}

/** 造一个真实 sqlite 库（session/message/part 三级表先例形态）并插入 sess 行 */
function createFixtureDb(dbPath: string, sessionId: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER)')
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT)')
    db.prepare('INSERT INTO session (id, title) VALUES (?, ?)').run(sessionId, 'fixture')
  } finally {
    db.close()
  }
}

describe('core：buildZcodeSubagentsByRoot / buildFamilyIndex 的 zcode 分支（D5-1 两态）', () => {
  it('库文件存在 → cleanedUp=false；库文件缺席 → cleanedUp=true（缺一即 true，不抛错）', () => {
    const index = buildFamilyIndex([header(ROOT)], [], new Map(), [
      zcodeNode({ id: 'sa-alive', dbFileExists: true }),
      zcodeNode({ id: 'sa-gone', dbFileExists: false }),
    ])
    const family = resolveFamily(ROOT, index)

    const alive = family.subagents.find((s) => s.sessionId === 'sa-alive')
    const gone = family.subagents.find((s) => s.sessionId === 'sa-gone')
    expect(alive?.cleanedUp).toBe(false)
    expect(gone?.cleanedUp).toBe(true)
  })

  it('zcode 节点按 rootSessionId 挂载，隔代场景与 pi 同链合并（resolveFamily 消费同一 subagentsByRoot）', () => {
    const FORK = 'fork-session-1'
    const headers = [header(ROOT), { ...header(FORK), parentSession: `/s/_${ROOT}.jsonl` }]
    const index = buildFamilyIndex(headers, [], new Map(), [
      zcodeNode({ id: 'sa-deep', rootSessionId: FORK }),
    ])
    // Q1 隔代：zcode subagent 挂在 fork 子代下，从 ROOT resolve 仍可见
    expect(resolveFamily(ROOT, index).subagents.map((s) => s.sessionId)).toContain('sa-deep')
  })

  it('不传 zcodeNodes / 传空数组 → pi 行为不变（零涟漪等价）', () => {
    const piIdent: Entry = {
      type: 'custom',
      id: 'sa-pi',
      parentId: null,
      customType: 'subagent-identity',
      data: { rootSessionId: ROOT, slug: 'pi-sub' },
    }
    const stats = new Map([[ROOT, { mtime: 1, size: 2 }], ['sa-pi', { mtime: 3, size: 4 }]])
    const without = buildFamilyIndex([header(ROOT)], [piIdent], stats)
    const withEmpty = buildFamilyIndex([header(ROOT)], [piIdent], stats, [])
    const a = resolveFamily(ROOT, without)
    const b = resolveFamily(ROOT, withEmpty)
    expect(b.subagents).toEqual(a.subagents)
    expect(b.subagents[0]?.cleanedUp).toBe(false) // pi 判据：fileStats 命中
  })

  it('zcode 节点与 pi 孤儿节点并存：判据互不污染（不同构声明断言）', () => {
    // pi 孤儿：identity 在但 fileStats 不含 → cleanedUp=true（JSONL GC）
    const piOrphan: Entry = {
      type: 'custom',
      id: 'sa-pi-orphan',
      parentId: null,
      customType: 'subagent-identity',
      data: { rootSessionId: ROOT, slug: 'orphan' },
    }
    const index = buildFamilyIndex([header(ROOT)], [piOrphan], new Map(), [
      zcodeNode({ id: 'sa-zcode-gone', dbFileExists: false }),
    ])
    const subs = resolveFamily(ROOT, index).subagents
    // 两节点都 cleanedUp=true，但判据来源不同：pi 走 fileStats，zcode 走 dbFileExists
    expect(subs.find((s) => s.sessionId === 'sa-pi-orphan')?.cleanedUp).toBe(true)
    expect(subs.find((s) => s.sessionId === 'sa-zcode-gone')?.cleanedUp).toBe(true)
  })

  it('SubagentRef 字段映射：富字段透传、sessionFile 不设、mtime/sizeBytes 占位 0', () => {
    const byRoot = buildZcodeSubagentsByRoot([
      zcodeNode({
        id: 'sa-rich',
        slug: 'rich-slug',
        agentName: 'explorer',
        task: 'do research',
        model: 'glm-5.3',
        status: 'closed',
        dbFileExists: true,
      }),
    ])
    const ref = byRoot.get(ROOT)?.[0]
    expect(ref?.slug).toBe('rich-slug')
    expect(ref?.agentName).toBe('explorer')
    expect(ref?.task).toBe('do research')
    expect(ref?.model).toBe('glm-5.3')
    expect(ref?.status).toBe('closed')
    expect(ref?.sessionFile).toBeUndefined() // zcode 无 session.jsonl
    expect(ref?.mtime).toBe(0)
    expect(ref?.sizeBytes).toBe(0)
  })
})

describe('集成：listZcodeManifests → buildFamilyIndex → resolveFamily（场景 2 两态 + 反向断言）', () => {
  it('库可达态（dbPath 指向真实 fixture 库）→ cleanedUp=false', async () => {
    const dbPath = join(dir, 'isolated.sqlite')
    createFixtureDb(dbPath, 'sess_live')
    writeZcodeManifest(dir, 'sa-live', { sessionId: 'sess_live', dbPath })

    const nodes = await listZcodeManifests(dir)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.dbFileExists).toBe(true)

    const family = resolveFamily(ROOT, buildFamilyIndex([header(ROOT)], [], new Map(), nodes))
    const sub = family.subagents.find((s) => s.sessionId === 'sa-live')
    expect(sub?.cleanedUp).toBe(false)
  })

  it('库不存在态（dbPath 指向不存在路径）→ cleanedUp=true（GC 语义，不报错）', async () => {
    writeZcodeManifest(dir, 'sa-gone', {
      sessionId: 'sess_gone',
      dbPath: join(dir, 'subagents', 'proj-a', 'missing.sqlite'),
    })

    const nodes = await listZcodeManifests(dir)
    expect(nodes[0]?.dbFileExists).toBe(false)

    const family = resolveFamily(ROOT, buildFamilyIndex([header(ROOT)], [], new Map(), nodes))
    expect(family.subagents.find((s) => s.sessionId === 'sa-gone')?.cleanedUp).toBe(true)
  })

  it('反向断言：库文件在但库内 session 行被删 → 仍 cleanedUp=false（列表视图不开库的分工声明）', async () => {
    // 分工（D5-1）：库内 session 已被 zcode GC 的情形由 read 路径 zcode_session_not_found
    // 权威承接；family 只 stat 文件存在性。本用例删行留文件，断言 family 不受库内容影响。
    const dbPath = join(dir, 'gc.sqlite')
    createFixtureDb(dbPath, 'sess_victim')
    writeZcodeManifest(dir, 'sa-gced', { sessionId: 'sess_victim', dbPath })

    // 前置核实：fixture 库里确实有该 session 行（反向断言的非平凡性前提）
    {
      const db = new DatabaseSync(dbPath)
      try {
        const row = db.prepare('SELECT COUNT(*) AS c FROM session WHERE id = ?').get('sess_victim') as
          | { c: number }
          | undefined
        expect(row?.c).toBe(1)
      } finally {
        db.close()
      }
    }

    // 删库内 session 行（含 message/part 级联），db 文件保留
    {
      const db = new DatabaseSync(dbPath)
      try {
        db.prepare('DELETE FROM part WHERE session_id = ?').run('sess_victim')
        db.prepare('DELETE FROM message WHERE session_id = ?').run('sess_victim')
        db.prepare('DELETE FROM session WHERE id = ?').run('sess_victim')
      } finally {
        db.close()
      }
    }

    const nodes = await listZcodeManifests(dir)
    expect(nodes[0]?.dbFileExists).toBe(true) // 只 stat：文件在即 true，不看内容

    const family = resolveFamily(ROOT, buildFamilyIndex([header(ROOT)], [], new Map(), nodes))
    expect(family.subagents.find((s) => s.sessionId === 'sa-gced')?.cleanedUp).toBe(false)
  })

  it('坏 manifest 与缺库节点混排 → 好节点照常输出（单节点不可达不炸整屏）', async () => {
    const dbPath = join(dir, 'ok.sqlite')
    createFixtureDb(dbPath, 'sess_ok')
    writeZcodeManifest(dir, 'sa-ok', { sessionId: 'sess_ok', dbPath })
    // 缺库节点：合法 zcode 形态（dbFileExists=false，不抛错），不剔除出列表
    writeZcodeManifest(dir, 'sa-broken-manifest', { sessionId: 'sess_x', dbPath: '/nonexistent/x.sqlite' })
    // 坏 JSON manifest：枚举跳过（不中断）
    writeFileSync(
      join(dir, 'subagents', 'proj-a', 'records', 'sa-corrupt.json'),
      '{{{broken',
      'utf8',
    )

    const nodes = await listZcodeManifests(dir)
    expect(nodes.map((n) => n.id).sort()).toEqual(['sa-broken-manifest', 'sa-ok'])

    const family = resolveFamily(ROOT, buildFamilyIndex([header(ROOT)], [], new Map(), nodes))
    expect(family.subagents.find((s) => s.sessionId === 'sa-ok')?.cleanedUp).toBe(false)
    expect(family.subagents.find((s) => s.sessionId === 'sa-broken-manifest')?.cleanedUp).toBe(true)
  })
})
