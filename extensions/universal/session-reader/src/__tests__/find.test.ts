import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { findSessions } from '../discovery/find.js'
import { REAL_AGENT_DIR, HAS_E6, HAS_REAL_SUBAGENTS_DIR, REAL_DATA_TIMEOUT_MS } from './real-data.js'

/**
 * 建一个假 session 文件：首行 header（type=session，含 id/cwd/parentSession），
 * 可选第二条 user message（用于名称关键词匹配 + firstMessagePreview）。返回绝对路径。
 */
async function makeSession(
  dir: string,
  opts: {
    name: string
    id: string
    cwd?: string
    parentSession?: string
    firstUserText?: string
  },
): Promise<string> {
  const header: Record<string, unknown> = {
    type: 'session',
    id: opts.id,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
  if (opts.cwd) header.cwd = opts.cwd
  if (opts.parentSession) header.parentSession = opts.parentSession
  const lines = [JSON.stringify(header)]
  if (opts.firstUserText) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: opts.id + '-m1',
        message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
      }),
    )
  }
  await mkdir(dir, { recursive: true })
  const path = join(dir, opts.name)
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

/**
 * 建 records manifest（U5 fixture）。manifest 由终态 finalize 或 sync 批落标出口写入
 * records/<sa-id>.json（创建时不写），sessionFile 指向 alive subagent session 的绝对路径
 * （find 用 extractSessionIdFromFilename 从该路径提取 sessionId 建索引）。
 */
async function makeRecordManifest(
  recordsDir: string,
  opts: {
    id: string
    rootSessionId: string
    sessionFile: string
    agentName?: string
    task?: string
    slug?: string
    model?: string
    status?: string
  },
): Promise<void> {
  const m: Record<string, unknown> = {
    id: opts.id,
    rootSessionId: opts.rootSessionId,
    sessionFile: opts.sessionFile,
  }
  if (opts.agentName !== undefined) m.agentName = opts.agentName
  if (opts.task !== undefined) m.task = opts.task
  if (opts.slug !== undefined) m.slug = opts.slug
  if (opts.model !== undefined) m.model = opts.model
  if (opts.status !== undefined) m.status = opts.status
  await mkdir(recordsDir, { recursive: true })
  await writeFile(join(recordsDir, `${opts.id}.json`), JSON.stringify(m))
}

/**
 * 建 subagent session 文件（header + 可选首消息 + 可选尾行 identity）。返回绝对路径。
 *
 * 文件名用 `<ts>_<sessionId>.jsonl` 格式（满足 extractSessionIdFromFilename）。传 rootSessionId
 * 时追加尾行 subagent-identity custom entry（P-fallback fixture 用）；不传则只有 header（manifest 主 fixture 用）。
 */
async function makeSubagentSession(
  dir: string,
  opts: {
    name: string
    id: string
    cwd?: string
    rootSessionId?: string
    slug?: string
    task?: string
    agent?: string
    firstUserText?: string
  },
): Promise<string> {
  const header: Record<string, unknown> = {
    type: 'session',
    id: opts.id,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
  if (opts.cwd) header.cwd = opts.cwd
  const lines: string[] = [JSON.stringify(header)]
  if (opts.firstUserText) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: opts.id + '-m1',
        message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
      }),
    )
  }
  if (opts.rootSessionId !== undefined) {
    const data: Record<string, unknown> = {
      id: 'sa-' + opts.id,
      agent: opts.agent ?? 'worker',
      mode: 'background',
      task: opts.task ?? '',
      slug: opts.slug ?? '',
      startedAt: Date.now(),
      rootSessionId: opts.rootSessionId,
      depth: 1,
    }
    lines.push(
      JSON.stringify({ type: 'custom', id: opts.id, customType: 'subagent-identity', data }),
    )
  }
  await mkdir(dir, { recursive: true })
  const path = join(dir, opts.name)
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

describe('findSessions', () => {
  let agentDir: string
  let slugDir: string
  /** subagent fixture 目录（模拟 subagents/<cwd编码>/sessions/ 结构，resolveSessionRoots [subagent] 根扫描路径） */
  let saDir: string

  let recordsDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'find-test-'))
    slugDir = join(agentDir, 'sessions', '--Users-demo--')
    saDir = join(agentDir, 'subagents', '--Users-demo--', 'sessions')
    recordsDir = join(agentDir, 'subagents', '--Users-demo--', 'records')
  })
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('uuid 片段匹配正确的 session（sessionId 含 query）', async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
    await makeSession(slugDir, { name: 'b.jsonl', id: '019fffff-cccc-dddd', cwd: '/demo' })

    const { matches } = await findSessions('e6c96', agentDir)
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('019e6c96-aaaa-bbbb')
  })

  it('uuid 片段匹配：文件路径含 query（query 出现在文件名）', async () => {
    // sessionId 不含 query，但文件名含 → path.includes(query) 命中
    await makeSession(slugDir, { name: '2026-special-name.jsonl', id: 'sid-no-query', cwd: '/demo' })
    const { matches } = await findSessions('special', agentDir)
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('sid-no-query')
  })

  it('fileName 填完整绝对路径，mtime/sizeBytes/cwd 为真实值', async () => {
    const path = await makeSession(slugDir, { name: 'a.jsonl', id: 'sid-fullpath', cwd: '/demo' })
    const { matches } = await findSessions('sid-fullpath', agentDir)
    expect(matches).toHaveLength(1)
    expect(matches[0].fileName).toBe(path)
    expect(matches[0].mtime).toBeGreaterThan(0)
    expect(matches[0].sizeBytes).toBeGreaterThan(0)
    expect(matches[0].cwd).toBe('/demo')
  })

  it('cwd 过滤：只留 header.cwd === opts.cwd 的', async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: 'aaa-shared', cwd: '/proj-a' })
    await makeSession(slugDir, { name: 'b.jsonl', id: 'bbb-shared', cwd: '/proj-b' })

    // query 'shared' 同时命中两个 id，cwd 过滤后只留 /proj-a
    const { matches } = await findSessions('shared', agentDir, { cwd: '/proj-a' })
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('aaa-shared')
    expect(matches[0].cwd).toBe('/proj-a')
  })

  it('limit 截断：truncated 标记正确', async () => {
    // 5 个文件 id 都含 "common"，uuid 片段 "common" 全匹配
    for (let i = 0; i < 5; i++) {
      await makeSession(slugDir, { name: `f${i}.jsonl`, id: `common-${i}`, cwd: '/demo' })
    }
    const { matches, truncated } = await findSessions('common', agentDir, { limit: 2 })
    expect(matches).toHaveLength(2)
    expect(truncated).toBe(true)

    // limit >= 总数时 truncated=false
    const all = await findSessions('common', agentDir, { limit: 10 })
    expect(all.matches).toHaveLength(5)
    expect(all.truncated).toBe(false)
  })

  it("query='recent' 按 mtime 倒序", async () => {
    const paths: string[] = []
    for (let i = 0; i < 3; i++) {
      paths.push(await makeSession(slugDir, { name: `r${i}.jsonl`, id: `recent-${i}`, cwd: '/demo' }))
    }
    // 设递增 mtime：r0 最旧，r2 最新
    const base = Math.floor(Date.now() / 1000)
    await utimes(paths[0], base, base)
    await utimes(paths[1], base + 100, base + 100)
    await utimes(paths[2], base + 200, base + 200)

    const { matches } = await findSessions('recent', agentDir)
    expect(matches).toHaveLength(3)
    expect(matches[0].sessionId).toBe('recent-2') // mtime 最大排前
    expect(matches[1].sessionId).toBe('recent-1')
    expect(matches[2].sessionId).toBe('recent-0')
  })

  it("recent 也尊重 cwd 过滤", async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: 'r-a', cwd: '/proj-a' })
    await makeSession(slugDir, { name: 'b.jsonl', id: 'r-b', cwd: '/proj-b' })

    const { matches } = await findSessions('recent', agentDir, { cwd: '/proj-a' })
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('r-a')
  })

  it('名称关键词匹配：uuid 无匹配时读首消息预览含 query', async () => {
    // query 'plugin' 含 p/l/u/g/i/n（p/l/u 非十六进制）→ 非 uuid 特征，走首消息 fallback
    await makeSession(slugDir, {
      name: 'a.jsonl',
      id: 'kw-aaaa',
      cwd: '/demo',
      firstUserText: '重构插件架构 plugin architecture review',
    })
    await makeSession(slugDir, {
      name: 'b.jsonl',
      id: 'kw-bbbb',
      cwd: '/demo',
      firstUserText: '完全无关的内容 unrelated content',
    })

    const { matches } = await findSessions('plugin', agentDir)
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('kw-aaaa')
    expect(matches[0].firstMessagePreview).toContain('plugin')
  })

  it('无匹配返回 { matches: [], truncated: false }', async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: '019abcd', cwd: '/demo' })
    // query 非 uuid 特征（z 非十六进制），走首消息 fallback 仍无匹配
    const result = await findSessions('zzznotexist', agentDir)
    expect(result).toEqual({ matches: [], truncated: false })
  })

  it('uuid 片段命中路径的 firstMessagePreview 补读（命中时未读首消息，第 5 步补）', async () => {
    // uuid 片段直接命中 → 不走关键词层（preview 未读），最终结果仍应补读出首消息预览
    await makeSession(slugDir, {
      name: 'a.jsonl',
      id: '019cafe0-aaaa-bbbb',
      cwd: '/demo',
      firstUserText: 'uuid 命中后补读的预览文本',
    })
    const { matches } = await findSessions('019cafe0', agentDir)
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('019cafe0-aaaa-bbbb')
    expect(matches[0].firstMessagePreview).toBe('uuid 命中后补读的预览文本')
  })

  it('firstMessagePreview 截断到 80 字符', async () => {
    const longText = 'X'.repeat(200)
    await makeSession(slugDir, {
      name: 'a.jsonl',
      id: 'prev-len',
      cwd: '/demo',
      firstUserText: longText,
    })
    const { matches } = await findSessions('prev-len', agentDir)
    expect(matches).toHaveLength(1)
    expect(matches[0].firstMessagePreview).toBeDefined()
    expect(matches[0].firstMessagePreview!.length).toBeLessThanOrEqual(80)
  })

  it('纯十六进制 query 无 uuid 匹配时不走首消息 fallback（uuid 特征短路）', async () => {
    // 'deadbeef' 全十六进制 → uuid 特征；sessionId 不含、首消息也不会含 → matched=[]
    await makeSession(slugDir, {
      name: 'a.jsonl',
      id: '019aaaa',
      cwd: '/demo',
      firstUserText: 'deadbeef 出现在首消息里也不该匹配',
    })
    const result = await findSessions('deadbeef', agentDir)
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('缺省合并：main + subagent 候选都返回，source 标记正确（DM1）', async () => {
    await makeSession(slugDir, { name: 'm.jsonl', id: 'main-shared', cwd: '/demo' })
    await makeSession(saDir, { name: 's.jsonl', id: 'sub-shared', cwd: '/demo' })

    const { matches } = await findSessions('shared', agentDir)
    expect(matches).toHaveLength(2)
    // source 必填标记（DM1）+ 集合为 {main, subagent}
    const sources = matches.map((m) => m.source).sort()
    expect(sources).toEqual(['main', 'subagent'])
    // fileName 指向各自目录
    const mainHit = matches.find((m) => m.source === 'main')!
    const subHit = matches.find((m) => m.source === 'subagent')!
    expect(mainHit.sessionId).toBe('main-shared')
    expect(mainHit.fileName).not.toContain('subagents')
    expect(subHit.sessionId).toBe('sub-shared')
    expect(subHit.fileName).toContain('subagents')
  })

  it("source:'main' 只含 main 候选（subagent 被过滤）", async () => {
    await makeSession(slugDir, { name: 'm.jsonl', id: 'main-shared', cwd: '/demo' })
    await makeSession(saDir, { name: 's.jsonl', id: 'sub-shared', cwd: '/demo' })

    const { matches } = await findSessions('shared', agentDir, { source: 'main' })
    expect(matches).toHaveLength(1)
    expect(matches[0].source).toBe('main')
    expect(matches[0].sessionId).toBe('main-shared')
  })

  it("source:'subagent' 只含 subagent 候选（main 被过滤）", async () => {
    await makeSession(slugDir, { name: 'm.jsonl', id: 'main-shared', cwd: '/demo' })
    await makeSession(saDir, { name: 's.jsonl', id: 'sub-shared', cwd: '/demo' })

    const { matches } = await findSessions('shared', agentDir, { source: 'subagent' })
    expect(matches).toHaveLength(1)
    expect(matches[0].source).toBe('subagent')
    expect(matches[0].sessionId).toBe('sub-shared')
    expect(matches[0].fileName).toContain('subagents')
  })

  it("recent 也尊重 source 过滤（含不传 source 时两侧按 mtime 混合倒序）", async () => {
    const mainPath = await makeSession(slugDir, { name: 'm.jsonl', id: 'r-main', cwd: '/demo' })
    const subPath = await makeSession(saDir, { name: 's.jsonl', id: 'r-sub', cwd: '/demo' })
    // subagent mtime 更新
    const base = Math.floor(Date.now() / 1000)
    await utimes(mainPath, base, base)
    await utimes(subPath, base + 100, base + 100)

    // source:'main' → 只 main 侧，subagent 被过滤
    const mainOnly = await findSessions('recent', agentDir, { source: 'main' })
    expect(mainOnly.matches).toHaveLength(1)
    expect(mainOnly.matches[0].source).toBe('main')
    expect(mainOnly.matches[0].sessionId).toBe('r-main')

    // 不传 source → 两侧合并按 mtime 倒序（subagent 更新排前）
    const merged = await findSessions('recent', agentDir)
    expect(merged.matches).toHaveLength(2)
    expect(merged.matches[0].sessionId).toBe('r-sub')
    expect(merged.matches[0].source).toBe('subagent')
    expect(merged.matches[1].sessionId).toBe('r-main')
    expect(merged.matches[1].source).toBe('main')
  })

  // ============================================================
  // U5：subagent task/slug/agentName 匹配（manifest 索引 + P-fallback identity 回退）
  // ============================================================
  describe('U5 task/slug/agentName 匹配', () => {
    it('TC-u5-find-task：manifest.task 含 query 入选（main 首消息不含 query 不入选）', async () => {
      const subId = '0aaaaaaa-bbbb-cccc-dddd-000000000001'
      const subPath = await makeSubagentSession(saDir, {
        name: `1234567890_${subId}.jsonl`,
        id: subId,
        cwd: '/demo',
      })
      await makeRecordManifest(recordsDir, {
        id: `sa-${subId}`,
        rootSessionId: 'root-1',
        sessionFile: subPath,
        task: '调研 codex CLI 的功能',
      })
      // main 首消息不含 codex → 关键词层不命中
      await makeSession(slugDir, {
        name: 'main.jsonl',
        id: 'main-no-task-match',
        cwd: '/demo',
        firstUserText: '完全无关的对话内容',
      })

      const { matches } = await findSessions('codex', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].source).toBe('subagent')
      expect(matches[0].sessionId).toBe(subId)
    })

    it('TC-u5-find-slug：manifest.slug 子串命中入选', async () => {
      const subId = '0aaaaaaa-bbbb-cccc-dddd-000000000002'
      const subPath = await makeSubagentSession(saDir, {
        name: `1234567890_${subId}.jsonl`,
        id: subId,
        cwd: '/demo',
      })
      await makeRecordManifest(recordsDir, {
        id: `sa-${subId}`,
        rootSessionId: 'root-2',
        sessionFile: subPath,
        slug: 'codex-ask-user-research',
        task: '其他不含 ask-user 的任务文本',
      })

      const { matches } = await findSessions('ask-user', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].source).toBe('subagent')
      expect(matches[0].sessionId).toBe(subId)
    })

    it('TC-u5-find-agentname：manifest.agentName 命中入选', async () => {
      const subId = '0aaaaaaa-bbbb-cccc-dddd-000000000003'
      const subPath = await makeSubagentSession(saDir, {
        name: `1234567890_${subId}.jsonl`,
        id: subId,
        cwd: '/demo',
      })
      await makeRecordManifest(recordsDir, {
        id: `sa-${subId}`,
        rootSessionId: 'root-3',
        sessionFile: subPath,
        agentName: 'explorer',
        task: '不含 explorer 的任务',
        slug: '不含-explorer-的-slug',
      })

      const { matches } = await findSessions('explorer', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].source).toBe('subagent')
      expect(matches[0].sessionId).toBe(subId)
    })

    it('TC-u5-find-source-task-combo：source:subagent 过滤 + task 匹配正交（与 m0 U1 source 过滤组合）', async () => {
      // main：首消息含 codex，但 source:'subagent' 在文件列表层排除 sessions/ 目录（不扫 main）
      await makeSession(slugDir, {
        name: 'main.jsonl',
        id: 'main-with-codex',
        cwd: '/demo',
        firstUserText: '讨论 codex 工具的使用',
      })
      // subagent：task 含 codex
      const subId = '0aaaaaaa-bbbb-cccc-dddd-000000000004'
      const subPath = await makeSubagentSession(saDir, {
        name: `1234567890_${subId}.jsonl`,
        id: subId,
        cwd: '/demo',
      })
      await makeRecordManifest(recordsDir, {
        id: `sa-${subId}`,
        rootSessionId: 'root-4',
        sessionFile: subPath,
        task: '用 codex 完成任务',
      })

      const { matches } = await findSessions('codex', agentDir, { source: 'subagent' })
      expect(matches.length).toBeGreaterThanOrEqual(1)
      expect(matches.every((m) => m.source === 'subagent')).toBe(true)
      expect(matches.some((m) => m.sessionId === subId)).toBe(true)
      // main 被 source 过滤排除（文件列表层不扫 sessions/）
      expect(matches.some((m) => m.source === 'main')).toBe(false)
    })

    it('TC-u5-find-pfallback：无 manifest，读尾行 identity.task 回退匹配（场景 A）', async () => {
      // subagent：无 manifest（P-fallback），但 session 文件尾行 identity.task 含 'resolve-bug'
      const subId = '0aaaaaaa-bbbb-cccc-dddd-000000000005'
      await makeSubagentSession(saDir, {
        name: `1234567890_${subId}.jsonl`,
        id: subId,
        cwd: '/demo',
        rootSessionId: 'root-5',
        task: '修复 resolve-bug 这个问题',
        slug: 'fix',
        agent: 'worker',
      })

      const { matches } = await findSessions('resolve', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].source).toBe('subagent')
      expect(matches[0].sessionId).toBe(subId)
    })

    it('TC-u5-find-uuid-priority：uuid 片段命中后短路，不走 task 匹配（TC-find-match-priority）', async () => {
      // subagent A：sessionId 含 'abc123'（uuid 片段命中）
      const idA = 'aabc123e-0000-0000-0000-000000000001'
      await makeSubagentSession(saDir, {
        name: `1111111111_${idA}.jsonl`,
        id: idA,
        cwd: '/demo',
      })
      // subagent B：sessionId 不含 abc123，但 manifest.task 含 abc123
      const idB = '0aaaaaaa-bbbb-cccc-dddd-000000000006'
      const subPathB = await makeSubagentSession(saDir, {
        name: `2222222222_${idB}.jsonl`,
        id: idB,
        cwd: '/demo',
      })
      await makeRecordManifest(recordsDir, {
        id: `sa-${idB}`,
        rootSessionId: 'root-6',
        sessionFile: subPathB,
        task: '任务包含 abc123 关键词',
      })

      // 'abc123' 全十六进制 → uuid 特征；A 的 sessionId 含 abc123 → uuid 片段命中 → 短路
      const { matches } = await findSessions('abc123', agentDir)
      expect(matches).toHaveLength(1)
      expect(matches[0].sessionId).toBe(idA)
      // B 不入选（uuid 命中短路，不走 task 匹配）
      expect(matches.some((m) => m.sessionId === idB)).toBe(false)
    })

    it.skipIf(!HAS_REAL_SUBAGENTS_DIR)(
      'TC-u5-real-data-guard：find codex source:subagent 命中（本机有 codex 相关 subagent task）',
      async () => {
        const { matches, truncated } = await findSessions('codex', REAL_AGENT_DIR, {
          source: 'subagent',
          limit: 50,
        })
        expect(matches.length).toBeGreaterThan(0)
        expect(matches.every((m) => m.source === 'subagent')).toBe(true)
        expect(typeof truncated).toBe('boolean')
      },
      REAL_DATA_TIMEOUT_MS,
    )
  })

  it.skipIf(!HAS_E6)('真实数据：e6c96 匹配 019e6c96 开头的 session', async () => {
    const { matches } = await findSessions('e6c96', REAL_AGENT_DIR)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.some((m) => m.sessionId.startsWith('019e6c96'))).toBe(true)
    // 真实值校验
    const hit = matches.find((m) => m.sessionId.startsWith('019e6c96'))!
    expect(hit.fileName).toContain('019e6c96')
    expect(hit.mtime).toBeGreaterThan(0)
    expect(hit.sizeBytes).toBeGreaterThan(0)
  }, REAL_DATA_TIMEOUT_MS)

  it.skipIf(!HAS_E6)("真实数据：recent 返回最近 N 个，mtime 倒序，truncated=true", async () => {
    const { matches, truncated } = await findSessions('recent', REAL_AGENT_DIR, { limit: 5 })
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.length).toBeLessThanOrEqual(5)
    // mtime 倒序
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].mtime).toBeGreaterThanOrEqual(matches[i].mtime)
    }
    // 真实 session 文件远多于 5 → 截断
    expect(truncated).toBe(true)
  }, REAL_DATA_TIMEOUT_MS)

  it.skipIf(!HAS_REAL_SUBAGENTS_DIR)(
    "真实数据：source:'subagent' 能找到 completed subagent（§7 场景 1 find 部分）",
    async () => {
      const { matches } = await findSessions('recent', REAL_AGENT_DIR, {
        source: 'subagent',
        limit: 5,
      })
      expect(matches.length).toBeGreaterThan(0)
      // 全部 source==='subagent'，fileName 在 subagents/ 目录下
      for (const m of matches) {
        expect(m.source).toBe('subagent')
        expect(m.fileName).toContain('subagents')
      }
    },
    REAL_DATA_TIMEOUT_MS,
  )
})

// ============================================================
// u11：标题元数据 metadataProvider 注入（design 2026-09-10 §6.6）
// 覆盖三条调用策略中的 ①惰性 ②窄化（TTL 缓存句柄在 tool-handler 注入侧，
// 见 tool-handler.test.ts u11 段）+ 两条 guard + §11.3b 多目录合并语义
// + 纯 TS 首条 user 降级路径保留。
// provider 一律注入替身（不真调 pi SessionManager）。
// ============================================================
describe('u11 标题元数据（metadataProvider 注入，§6.6）', () => {
  let root: string
  let agentDir: string
  /** 平铺 main 根（xyz-agent 形态：session 直在 sessions/ 下，[default] 根无子目录） */
  let flatMain: string
  /** legacy 根（dirname(agentDir)/sessions） */
  let legacyDir: string

  async function writeSession(
    dir: string,
    opts: { name: string; id: string; cwd?: string; firstUserText?: string },
  ): Promise<string> {
    await mkdir(dir, { recursive: true })
    const lines = [JSON.stringify({ type: 'session', id: opts.id, cwd: opts.cwd ?? '/demo' })]
    if (opts.firstUserText !== undefined) {
      lines.push(
        JSON.stringify({
          type: 'message',
          id: `${opts.id}-m1`,
          message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
        }),
      )
    }
    const path = join(dir, opts.name)
    await writeFile(path, lines.join('\n') + '\n')
    return path
  }

  beforeEach(async () => {
    // agentDir 挂在 mkdtemp 子目录下，legacy 根（dirname(agentDir)/sessions）仍在
    // 自建 tmp 树内，不污染共享 tmpdir（也不受其他用例残留影响）
    root = await mkdtemp(join(tmpdir(), 'find-u11-'))
    agentDir = join(root, 'agent')
    flatMain = join(agentDir, 'sessions')
    legacyDir = join(root, 'sessions')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('① 惰性触发：uuid 精确/归一化路径不调 provider（spy 计数 0）', async () => {
    await writeSession(flatMain, { name: 'a.jsonl', id: '019cafe00001', firstUserText: '无关' })
    const provider = vi.fn(async () => [])
    // 精确子串层命中
    await findSessions('019cafe00001', agentDir, { metadataProvider: provider })
    expect(provider).not.toHaveBeenCalled()
    // 归一化层命中（大写变体：精确层大小写敏感 0 命中，norm 层命中后短路）
    await findSessions('019CAFE00001', agentDir, { metadataProvider: provider })
    expect(provider).not.toHaveBeenCalled()
  })

  it('② keyword 路径调用 provider 且标题进匹配（name 命中，preview 取元数据首消息免深读）', async () => {
    const pathA = await writeSession(flatMain, {
      name: 'a.jsonl',
      id: 'title-aaaa',
      firstUserText: '首消息完全无关',
    })
    await writeSession(flatMain, { name: 'b.jsonl', id: 'title-bbbb', firstUserText: '另一个无关会话' })
    const provider = vi.fn(async (dir: string) =>
      dir === flatMain
        ? [
            {
              path: pathA,
              id: 'title-aaaa',
              cwd: '/demo',
              name: '福耀玻璃深度研究',
              modified: new Date('2026-09-01'),
              firstMessage: '首消息完全无关',
            },
          ]
        : [],
    )
    const { matches } = await findSessions('福耀玻璃', agentDir, { metadataProvider: provider })
    // 平铺存在的 [default] 根被调用，且永传非空串
    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider.mock.calls[0][0]).toBe(flatMain)
    expect(provider.mock.calls[0][0].length).toBeGreaterThan(0)
    // 标题命中：name 透传 + preview 取元数据 firstMessage
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('title-aaaa')
    expect(matches[0].name).toBe('福耀玻璃深度研究')
    expect(matches[0].firstMessagePreview).toBe('首消息完全无关')
  })

  it('③ 窄化：含子目录根跳过 provider，候选不退出 keyword 匹配（回退首条 user，标题留空）', async () => {
    // 纯 pi 形态：文件在 encodeCwd 子目录 → [default] 根含子目录 → listAll 跳过
    await writeSession(join(flatMain, '--Users-demo--'), {
      name: 'a.jsonl',
      id: 'nested-aaaa',
      firstUserText: '重构插件架构 plugin review',
    })
    const provider = vi.fn(async () => [])
    const { matches } = await findSessions('plugin', agentDir, { metadataProvider: provider })
    expect(provider).not.toHaveBeenCalled()
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('nested-aaaa')
    expect(matches[0].firstMessagePreview).toContain('plugin')
    // 标题维度降级留空：「能找到 session」不受影响（§6.6 降级路径）
    expect(matches[0].name).toBeUndefined()
  })

  it('④ guard：provider 抛错降级（标题留空 + 不抛，回退首条 user 匹配）', async () => {
    await writeSession(flatMain, {
      name: 'a.jsonl',
      id: 'err-aaaa',
      firstUserText: '按首条消息命中的文本',
    })
    const provider = vi.fn(async () => {
      throw new Error('listAll boom')
    })
    const { matches } = await findSessions('按首条消息命中', agentDir, {
      metadataProvider: provider,
    })
    expect(provider).toHaveBeenCalledTimes(1) // 调用了但抛错
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('err-aaaa')
    expect(matches[0].name).toBeUndefined()
    expect(matches[0].firstMessagePreview).toContain('按首条消息命中')
  })

  it('⑤ 多目录结果合并：按 id 去重、重复取新 modified（§11.3b）', async () => {
    const pathA = await writeSession(flatMain, {
      name: 'a.jsonl',
      id: 'dup-id-0001',
      firstUserText: '无关',
    })
    // legacy 根平铺存在（0 文件也算存在根，isFlatRoot 空集恒真）
    await mkdir(legacyDir, { recursive: true })
    const provider = vi.fn(async (dir: string) =>
      dir === flatMain
        ? [{ path: pathA, id: 'dup-id-0001', cwd: '/demo', name: '旧标题', modified: new Date(1000) }]
        : [{ path: pathA, id: 'dup-id-0001', cwd: '/demo', name: '新标题', modified: new Date(2000) }],
    )
    const { matches } = await findSessions('新标题', agentDir, { metadataProvider: provider })
    expect(provider).toHaveBeenCalledTimes(2) // 两个平铺存在的根各一次
    expect(matches).toHaveLength(1)
    expect(matches[0].name).toBe('新标题') // 同 id 重复 → 取新 modified 的条目
    const miss = await findSessions('旧标题', agentDir, { metadataProvider: provider })
    expect(miss.matches).toHaveLength(0) // 旧条目已按合并规则丢弃
  })

  it('⑥ guard：仅对存在的根调用且永传非空串（不存在根 / 不存在 liveSessionDir 不调）', async () => {
    await writeSession(flatMain, { name: 'a.jsonl', id: 'guard-aaaa', firstUserText: '无关' })
    const provider = vi.fn(async () => [])
    await findSessions('zzznohit9q', agentDir, {
      liveSessionDir: join(agentDir, 'no-such-dir'),
      metadataProvider: provider,
    })
    // 仅平铺存在的 [default] 根被调；不存在的 liveSessionDir 与 [legacy] 根均被排除
    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider.mock.calls[0][0]).toBe(flatMain)
    expect(provider.mock.calls.every((c) => typeof c[0] === 'string' && c[0].length > 0)).toBe(true)
  })

  it('⑥b liveSessionDir 与平铺根同字面路径 → 同目录只调一次（字面路径去重）', async () => {
    await writeSession(flatMain, { name: 'a.jsonl', id: 'dedup-aaaa', firstUserText: '无关' })
    const provider = vi.fn(async () => [])
    await findSessions('zzznohit9q', agentDir, {
      liveSessionDir: flatMain,
      metadataProvider: provider,
    })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider.mock.calls[0][0]).toBe(flatMain)
  })

  it('⑦ recent：仅对 limit 截断后的少数候选补元数据（旧候选所在根不调）', async () => {
    const pNew1 = await writeSession(flatMain, { name: 'n1.jsonl', id: 'recent-new-1' })
    const pNew2 = await writeSession(flatMain, { name: 'n2.jsonl', id: 'recent-new-2' })
    await writeSession(legacyDir, { name: 'o1.jsonl', id: 'recent-old-1' })
    await writeSession(legacyDir, { name: 'o2.jsonl', id: 'recent-old-2' })
    const base = Math.floor(Date.now() / 1000)
    await utimes(pNew1, base + 300, base + 300)
    await utimes(pNew2, base + 200, base + 200)
    await utimes(join(legacyDir, 'o1.jsonl'), base + 100, base + 100)
    await utimes(join(legacyDir, 'o2.jsonl'), base + 50, base + 50)
    const provider = vi.fn(async (dir: string) =>
      dir === flatMain
        ? [
            { path: pNew1, id: 'recent-new-1', cwd: '/demo', name: '最新标题一', modified: new Date((base + 300) * 1000) },
            { path: pNew2, id: 'recent-new-2', cwd: '/demo', name: '最新标题二', modified: new Date((base + 200) * 1000) },
          ]
        : [],
    )
    const { matches, truncated } = await findSessions('recent', agentDir, {
      limit: 2,
      metadataProvider: provider,
    })
    expect(truncated).toBe(true)
    expect(matches.map((m) => m.sessionId)).toEqual(['recent-new-1', 'recent-new-2'])
    // provider 只调最新两个候选所在的平铺根；被截断的 legacy 根候选不触发补元数据
    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider.mock.calls[0][0]).toBe(flatMain)
    // 截断后少数候选补到标题
    expect(matches[0].name).toBe('最新标题一')
    expect(matches[1].name).toBe('最新标题二')
  })
})
