// family.test.ts —— session-reader C05 簇合并产物（round5-G）。
// 共同被测业务模块：`src/core/family.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/family-zcode.test.ts（9 用例，skip 0）
//   - src/__tests__/family.test.ts（20 用例，skip 0）

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildFamilyIndex, resolveFamily, buildZcodeSubagentsByRoot, type Entry as FamilyEntry, type ZcodeFamilyNode } from '../core/family.js'
import { listZcodeManifests } from '../discovery/zcode-manifest.js'
import { type Entry } from '@zhushanwen/session-core'

// ======== 来源：family-zcode.test.ts ========
describe("family-zcode", () => {
  // ============================================================
  // family zcode 分支（design session-reader-shared-core §3.3 D5-1 / §4 场景 2）。
  //
  // 判据（两项、不开库）：锚可解析（枚举谓词已过）∧ 库文件存在（stat）→ cleanedUp=false；
  // 缺一 → true（GC 语义，不报错不抛异常）。刻意不含「库内 session 查询」第三项——
  // 静息态 CANTOPEN 会误判活会话 + 列表视图不开库；反向断言（库文件在但库内 session
  // 行被删 → 仍 false）即「列表视图不开库」的分工声明断言。
  //
  // 与 pi 判据不同构（D5-1 显式声明）：pi = fileStats JSONL 存在性；zcode 节点无
  // JSONL 文件，按「库可达」判。pi 侧既有 fixture 行为零变化由 family.test.ts 全绿检查
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

  function header(id: string): FamilyEntry {
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

  /** 在存储树分区 <root>/<rootSessionId>/subagents/records/ 下写 zcode manifest（F21 磁盘真实形态：无 sessionFile 键；[session-store-layout-inversion D6/单新根] 读侧已换存储树） */
  function writeZcodeManifest(
    agentDir: string,
    saId: string,
    sessionRef: Record<string, string>,
  ): void {
    const recordsDir = join(dirname(agentDir), 'ext-sessions', ROOT, 'subagents', 'records')
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
      const piIdent: FamilyEntry = {
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
      const piOrphan: FamilyEntry = {
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
      // agentDir 两层化（<mkdtemp>/agent）：存储树推导 = dirname(agentDir)/ext-sessions，
      // 单层直接当 agentDir 会把扫描根泄到 tmpdir 公共层（跨测试污染——先例 reaper 同修）
      const agentDir = join(dir, 'agent')
      mkdirSync(agentDir, { recursive: true })
      const dbPath = join(dir, 'isolated.sqlite')
      createFixtureDb(dbPath, 'sess_live')
      writeZcodeManifest(agentDir, 'sa-live', { sessionId: 'sess_live', dbPath })

      const nodes = await listZcodeManifests(agentDir)
      expect(nodes).toHaveLength(1)
      expect(nodes[0]?.dbFileExists).toBe(true)

      const family = resolveFamily(ROOT, buildFamilyIndex([header(ROOT)], [], new Map(), nodes))
      const sub = family.subagents.find((s) => s.sessionId === 'sa-live')
      expect(sub?.cleanedUp).toBe(false)
    })

    it('库不存在态（dbPath 指向不存在路径）→ cleanedUp=true（GC 语义，不报错）', async () => {
      const agentDir = join(dir, 'agent')
      mkdirSync(agentDir, { recursive: true })
      writeZcodeManifest(agentDir, 'sa-gone', {
        sessionId: 'sess_gone',
        dbPath: join(dir, 'subagents', 'proj-a', 'missing.sqlite'),
      })

      const nodes = await listZcodeManifests(agentDir)
      expect(nodes[0]?.dbFileExists).toBe(false)

      const family = resolveFamily(ROOT, buildFamilyIndex([header(ROOT)], [], new Map(), nodes))
      expect(family.subagents.find((s) => s.sessionId === 'sa-gone')?.cleanedUp).toBe(true)
    })

    it('反向断言：库文件在但库内 session 行被删 → 仍 cleanedUp=false（列表视图不开库的分工声明）', async () => {
      // 分工（D5-1）：库内 session 已被 zcode GC 的情形由 read 路径 zcode_session_not_found
      // 权威承接；family 只 stat 文件存在性。本用例删行留文件，断言 family 不受库内容影响。
      const agentDir = join(dir, 'agent')
      mkdirSync(agentDir, { recursive: true })
      const dbPath = join(dir, 'gc.sqlite')
      createFixtureDb(dbPath, 'sess_victim')
      writeZcodeManifest(agentDir, 'sa-gced', { sessionId: 'sess_victim', dbPath })

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

      const nodes = await listZcodeManifests(agentDir)
      expect(nodes[0]?.dbFileExists).toBe(true) // 只 stat：文件在即 true，不看内容

      const family = resolveFamily(ROOT, buildFamilyIndex([header(ROOT)], [], new Map(), nodes))
      expect(family.subagents.find((s) => s.sessionId === 'sa-gced')?.cleanedUp).toBe(false)
    })

    it('坏 manifest 与缺库节点混排 → 好节点照常输出（单节点不可达不炸整屏）', async () => {
      const dbPath = join(dir, 'ok.sqlite')
      createFixtureDb(dbPath, 'sess_ok')
      const agentDir = join(dir, 'agent')
      mkdirSync(agentDir, { recursive: true })
      writeZcodeManifest(agentDir, 'sa-ok', { sessionId: 'sess_ok', dbPath })
      // 缺库节点：合法 zcode 形态（dbFileExists=false，不抛错），不剔除出列表
      writeZcodeManifest(agentDir, 'sa-broken-manifest', { sessionId: 'sess_x', dbPath: '/nonexistent/x.sqlite' })
      // 坏 JSON manifest：枚举跳过（不中断）
      writeFileSync(
        join(dirname(agentDir), 'ext-sessions', ROOT, 'subagents', 'records', 'sa-corrupt.json'),
        '{{{broken',
        'utf8',
      )

      const nodes = await listZcodeManifests(agentDir)
      expect(nodes.map((n) => n.id).sort()).toEqual(['sa-broken-manifest', 'sa-ok'])

      const family = resolveFamily(ROOT, buildFamilyIndex([header(ROOT)], [], new Map(), nodes))
      expect(family.subagents.find((s) => s.sessionId === 'sa-ok')?.cleanedUp).toBe(false)
      expect(family.subagents.find((s) => s.sessionId === 'sa-broken-manifest')?.cleanedUp).toBe(true)
    })
  })
});

// ======== 来源：family.test.ts ========
describe("family", () => {
  // ---- fixture 常量（映射 design §3.3 D-7 Q1 真实场景）----
  const ROOT = '019fe620' // 家族根（无 parentSession）
  const FORK = '019fe632' // fork 子代（parentSession 指向 ROOT 的文件）
  const SUB = '019fe635' // subagent（rootSessionId=FORK，挂在 fork 子代下，非家族根）
  const SUB2 = '019fe636' // U4 第二个 subagent（多 subagent 场景）

  // ---- fixture helpers ----

  /** 构造 session header entry（type=session，含 id/cwd，可选 parentSession） */
  function header(id: string, opts?: { parentSession?: string; cwd?: string }): Entry {
    const e: Entry = { type: 'session', id, parentId: null, cwd: opts?.cwd ?? '/proj' }
    if (opts?.parentSession) e.parentSession = opts.parentSession
    return e
  }

  /** 模拟真实文件路径：含 sessionId 的 jsonl 路径（resolveParentSessionId 靠 includes 反查） */
  function sessionFile(id: string): string {
    return `/sessions/2026-08-09T10-45-20Z_${id}.jsonl`
  }

  /** 构造 subagent-identity custom entry（data.rootSessionId/slug） */
  function subagentIdentity(id: string, rootSessionId: string, slug: string): Entry {
    return {
      type: 'custom',
      id,
      parentId: null,
      customType: 'subagent-identity',
      data: { rootSessionId, slug },
    }
  }

  /** U4 富字段（可选，模拟 manifest 主/P-fallback identity 回退组装的 data） */
  interface SubagentRichFields {
    task?: string
    agent?: string
    model?: string
    status?: string
    sessionFile?: string
  }

  /** 构造带 U4 富字段的 subagent-identity custom entry（manifest 主/P-fallback 两种 data 形态） */
  function subagentIdentityRich(
    id: string,
    rootSessionId: string,
    slug: string,
    rich?: SubagentRichFields,
  ): Entry {
    const data: Record<string, unknown> = { rootSessionId, slug }
    if (rich?.task !== undefined) data.task = rich.task
    if (rich?.agent !== undefined) data.agent = rich.agent
    if (rich?.model !== undefined) data.model = rich.model
    if (rich?.status !== undefined) data.status = rich.status
    if (rich?.sessionFile !== undefined) data.sessionFile = rich.sessionFile
    return { type: 'custom', id, parentId: null, customType: 'subagent-identity', data }
  }

  /** 构造 fileStats Map（M1 key=sessionId） */
  function makeStats(
    keys: string[],
    opts: { mtime?: number; size?: number } = {},
  ): Map<string, { mtime: number; size: number }> {
    const { mtime = 1000, size = 5000 } = opts
    const m = new Map<string, { mtime: number; size: number }>()
    for (const k of keys) m.set(k, { mtime, size })
    return m
  }

  /** Q1 核心 fixture：ROOT ← fork ← FORK；subagent SUB 挂在 fork 子代 FORK 下 */
  function q1Fixture(aliveKeys: string[] = [ROOT, FORK, SUB]) {
    return {
      headers: [header(ROOT), header(FORK, { parentSession: sessionFile(ROOT) })],
      identities: [subagentIdentity(SUB, FORK, 'deep-survey')],
      fileStats: makeStats(aliveKeys),
    }
  }

  describe('buildFamilyIndex', () => {
    it('byId / childrenOf / subagentsByRoot 结构正确', () => {
      const { headers, identities, fileStats } = q1Fixture()
      const index = buildFamilyIndex(headers, identities, fileStats)

      expect(index.byId.has(ROOT)).toBe(true)
      expect(index.byId.has(FORK)).toBe(true)
      expect(index.byId.get(ROOT)?.cwd).toBe('/proj')

      // childrenOf key 是父 sessionId（经 parentSession 文件路径反查）
      expect(index.childrenOf.get(ROOT)).toHaveLength(1)
      expect(index.childrenOf.get(ROOT)?.[0].sessionId).toBe(FORK)

      // subagentsByRoot key 是 rootSessionId
      expect(index.subagentsByRoot.get(FORK)).toHaveLength(1)
      expect(index.subagentsByRoot.get(FORK)?.[0].sessionId).toBe(SUB)
      expect(index.subagentsByRoot.get(FORK)?.[0].slug).toBe('deep-survey')
    })

    it('parentSession 是文件路径：经 sessionId 子串反查建 childrenOf', () => {
      const headers = [
        header('aaa'),
        header('bbb', { parentSession: '/some/dir/2026-01-01T00-00-00Z_aaa.jsonl' }),
      ]
      const index = buildFamilyIndex(headers, [], new Map())

      expect(index.childrenOf.get('aaa')?.[0].sessionId).toBe('bbb')
    })

    it('parentSession 反查不到父 → 该 entry 不进 childrenOf（不报错）', () => {
      const headers = [header('bbb', { parentSession: '/missing.jsonl' })]
      const index = buildFamilyIndex(headers, [], new Map())

      expect(index.childrenOf.size).toBe(0)
    })

    it('identity 缺 rootSessionId/slug → 跳过（坏数据容错）', () => {
      const bad: Entry = {
        type: 'custom',
        id: 'x',
        parentId: null,
        customType: 'subagent-identity',
        data: { slug: 'no-root' },
      }
      const index = buildFamilyIndex([], [bad], new Map())

      expect(index.subagentsByRoot.size).toBe(0)
    })

    it('fileStats 原样存入 index（供 cleanedUp 判断用）', () => {
      const fileStats = makeStats(['s1'])
      const index = buildFamilyIndex([], [], fileStats)

      expect(index.fileStats).toBe(fileStats)
    })
  })

  describe('resolveFamily - 隔代关联（design §3.3 D-7 Q1 核心断言）', () => {
    it('从家族根 resolve 能关联到挂在 fork 子代下的隔代 subagent', () => {
      const { headers, identities, fileStats } = q1Fixture()
      const index = buildFamilyIndex(headers, identities, fileStats)

      const family = resolveFamily(ROOT, index)

      // Q1 核心：subagent SUB 的 rootSessionId 是 fork 子代 FORK，不是 root ROOT。
      // 只查 root 的 subagentsByRoot 会漏；必须对 fork 链每个节点（含 forks）查。
      expect(family.subagents.some((s) => s.sessionId === SUB)).toBe(true)
      expect(family.subagents.find((s) => s.sessionId === SUB)?.slug).toBe('deep-survey')
    })

    it('从 fork 子代 resolve 也能关联到直接挂在其下的 subagent', () => {
      const { headers, identities, fileStats } = q1Fixture()
      const index = buildFamilyIndex(headers, identities, fileStats)

      const family = resolveFamily(FORK, index)
      expect(family.subagents.some((s) => s.sessionId === SUB)).toBe(true)
    })
  })

  describe('resolveFamily - fork 链', () => {
    it('fork 子代的 parents 含 root；root 的 forks 含 fork 子代', () => {
      const { headers, identities, fileStats } = q1Fixture()
      const index = buildFamilyIndex(headers, identities, fileStats)

      expect(resolveFamily(FORK, index).parents.some((p) => p.sessionId === ROOT)).toBe(true)
      expect(resolveFamily(ROOT, index).forks.some((f) => f.sessionId === FORK)).toBe(true)
    })

    it('root 无 parentSession → parents 空、forks 取 childrenOf', () => {
      const { headers, identities, fileStats } = q1Fixture()
      const index = buildFamilyIndex(headers, identities, fileStats)

      const family = resolveFamily(ROOT, index)
      expect(family.parents).toEqual([])
      expect(family.forks.map((f) => f.sessionId)).toEqual([FORK])
    })

    it('线性多级 fork 链：C←B←A，resolveFamily(C).parents=[B,A]', () => {
      const headers = [
        header('A'),
        header('B', { parentSession: sessionFile('A') }),
        header('C', { parentSession: sessionFile('B') }),
      ]
      const index = buildFamilyIndex(headers, [], new Map())

      const family = resolveFamily('C', index)
      expect(family.parents.map((p) => p.sessionId)).toEqual(['B', 'A'])
      // forks 只含直接子代（孙代 C 是 B 的子代，不是 A 的直接子代）
      expect(resolveFamily('A', index).forks.map((f) => f.sessionId)).toEqual(['B'])
      expect(resolveFamily('B', index).forks.map((f) => f.sessionId)).toEqual(['C'])
    })

    it('workflows 恒为空数组（M1，接口字段保留供 M2）', () => {
      const { headers, identities, fileStats } = q1Fixture()
      const index = buildFamilyIndex(headers, identities, fileStats)

      expect(resolveFamily(ROOT, index).workflows).toEqual([])
    })
  })

  describe('resolveFamily - cleanedUp（subagent 文件被 GC）', () => {
    it('identity 在但 fileStats 不含其 sessionId → cleanedUp=true', () => {
      const { headers, identities, fileStats } = q1Fixture([ROOT, FORK]) // SUB 不在 fileStats（已 GC）
      const index = buildFamilyIndex(headers, identities, fileStats)

      const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
      expect(sub?.cleanedUp).toBe(true)
    })

    it('identity 在且 fileStats 含其 sessionId → cleanedUp=false', () => {
      const { headers, identities, fileStats } = q1Fixture() // 默认 [ROOT,FORK,SUB]，SUB 存活
      const index = buildFamilyIndex(headers, identities, fileStats)

      const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
      expect(sub?.cleanedUp).toBe(false)
    })
  })

  describe('resolveFamily - 错误', () => {
    it('sessionId 不在 index → 抛 Error', () => {
      const { headers, identities, fileStats } = q1Fixture()
      const index = buildFamilyIndex(headers, identities, fileStats)

      expect(() => resolveFamily('unknown-session', index)).toThrow(/not found in family index/)
    })
  })

  // ============================================================
  // U4: SubagentRef 富字段（manifest 主 / P-fallback identity 回退）
  // 验证 buildFamilyIndex 从 identity entry.data 读 task/agent/model/status/sessionFile
  // 填 SubagentRef，异名映射（data.agent → agentName），检查放宽（只校验 rootSessionId+slug）。
  // ============================================================

  describe('U4: SubagentRef 富字段（buildFamilyIndex 透传）', () => {
    it('TC-u4-manifest-enrich: manifest 主路径，富字段全透传到 SubagentRef', () => {
      const identities = [
        subagentIdentityRich(SUB, ROOT, 'codex-research', {
          task: '调研 codex',
          agent: 'explorer',
          model: 'glm-5.2',
          status: 'completed',
          sessionFile: '/path/to/sub.jsonl',
        }),
      ]
      const index = buildFamilyIndex([header(ROOT)], identities, makeStats([ROOT, SUB]))

      const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
      expect(sub?.task).toBe('调研 codex')
      expect(sub?.slug).toBe('codex-research')
      // 异名映射核心断言：identity.data.agent → SubagentRef.agentName
      expect(sub?.agentName).toBe('explorer')
      expect(sub?.model).toBe('glm-5.2')
      expect(sub?.status).toBe('completed')
      expect(sub?.sessionFile).toBe('/path/to/sub.jsonl')
      expect(sub?.cleanedUp).toBe(false)
    })

    it('TC-u4-pfallback-identity: P-fallback（有 identity 无 model/status），task/agent/sessionFile 透传', () => {
      const identities = [
        subagentIdentityRich(SUB, ROOT, 'fix', {
          task: 'fix bug',
          agent: 'worker',
          sessionFile: '/alive/sub.jsonl',
          // 无 model/status（P-fallback identity 不含这两项，探针 15/15 确认）
        }),
      ]
      const index = buildFamilyIndex([header(ROOT)], identities, makeStats([ROOT, SUB]))

      const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
      expect(sub?.task).toBe('fix bug')
      expect(sub?.slug).toBe('fix')
      expect(sub?.agentName).toBe('worker')
      expect(sub?.sessionFile).toBe('/alive/sub.jsonl')
      // P-fallback 核心断言：model/status 必 undefined（identity 不可回退）
      expect(sub?.model).toBeUndefined()
      expect(sub?.status).toBeUndefined()
    })

    it('TC-u4-pfallback-no-identity: data 缺 rootSessionId → 检查拒掉，不入 subagentsByRoot，不抛错', () => {
      // 模拟无 identity（运行中/异常，尾行是 message 非 identity）：data 只有 slug 无 rootSessionId
      const noRoot: Entry = {
        type: 'custom',
        id: 'no-root',
        parentId: null,
        customType: 'subagent-identity',
        data: { slug: 'dangling', task: 't' }, // 缺 rootSessionId
      }
      const index = buildFamilyIndex([header(ROOT)], [noRoot], makeStats([ROOT]))

      // 检查拒掉 → 不入 subagentsByRoot
      expect(index.subagentsByRoot.size).toBe(0)
      // resolveFamily 不抛错，subagents 空
      const family = resolveFamily(ROOT, index)
      expect(family.subagents).toHaveLength(0)
    })

    it('TC-u4-orphan-manifest: fileStats 不含 id → cleanedUp=true，富字段仍透传（GC 路径保留）', () => {
      const identities = [
        subagentIdentityRich('sa-ghost', ROOT, 'ghost-slug', {
          task: 'ghost task',
          agent: 'worker',
          model: 'gpt-4',
          status: 'completed',
          sessionFile: '/gc/ghost.jsonl',
        }),
      ]
      // fileStats 不含 'sa-ghost'（模拟 .jsonl 被 GC，manifest 残留）→ cleanedUp=true
      const index = buildFamilyIndex([header(ROOT)], identities, makeStats([ROOT]))

      const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === 'sa-ghost')
      expect(sub?.cleanedUp).toBe(true)
      expect(sub?.task).toBe('ghost task')
      expect(sub?.agentName).toBe('worker')
      expect(sub?.model).toBe('gpt-4')
      expect(sub?.status).toBe('completed')
      expect(sub?.sessionFile).toBe('/gc/ghost.jsonl') // GC 路径保留（不置空）
    })

    it('TC-u4-recordmanifest-compat: 最小 identity（仅 rootSessionId+slug）→ 富字段全 undefined，不抛错', () => {
      // 模拟旧 manifest（无 task/slug/model/status/agentName）经 buildFamilyFromFs 转成的最小 identity
      const identities = [subagentIdentity(SUB, ROOT, 'legacy')]
      const index = buildFamilyIndex([header(ROOT)], identities, makeStats([ROOT, SUB]))

      const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
      expect(sub?.slug).toBe('legacy')
      expect(sub?.rootSessionId).toBe(ROOT)
      expect(sub?.task).toBeUndefined()
      expect(sub?.agentName).toBeUndefined()
      expect(sub?.model).toBeUndefined()
      expect(sub?.status).toBeUndefined()
      expect(sub?.sessionFile).toBeUndefined()
    })

    it('isSubagentIdentityData 检查放宽：富字段部分缺失/全缺都通过（只校验 rootSessionId+slug）', () => {
      const identities = [
        subagentIdentityRich(SUB, ROOT, 's1', { task: 'only-task' }), // 部分富字段
        subagentIdentity(SUB2, ROOT, 's2'), // 完全无富字段（旧 manifest 形态）
      ]
      const index = buildFamilyIndex([header(ROOT)], identities, makeStats([ROOT, SUB, SUB2]))

      const family = resolveFamily(ROOT, index)
      expect(family.subagents).toHaveLength(2)
      const s1 = family.subagents.find((s) => s.sessionId === SUB)
      expect(s1?.task).toBe('only-task')
      expect(s1?.model).toBeUndefined()
      const s2 = family.subagents.find((s) => s.sessionId === SUB2)
      expect(s2?.task).toBeUndefined()
      expect(s2?.agentName).toBeUndefined()
    })
  })
});
