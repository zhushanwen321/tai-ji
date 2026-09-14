import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, utimes, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  handleSessionRead,
  METADATA_CACHE_TTL_MS,
  type SessionReadParams,
  type SessionReadSignals,
} from '../tool-handler.js'
import { type DoctorDetails } from '../doctor.js'
import { levenshtein } from '../no-match.js'
import {
  MULTI_SEARCH_MAX_SESSIONS,
  SEARCH_SCAN_BYTE_BUDGET,
  searchAcrossSessions,
} from '../search-across.js'
import { renderExtractItems } from '../extract.js'
import { listRecordManifests } from '../discovery/subagents.js'
import type { SessionMetadataProvider } from '../discovery/find.js'
import {
  REAL_AGENT_DIR as REAL,
  E6,
  FAM,
  HAS_E6,
  HAS_REAL,
  HAS_REAL_SUBAGENTS_DIR,
  hasAnyRealSession,
  hasRealSession,
} from './real-data.js'

/**
 * M3 tool-handler 集成测试。
 *
 * 测试框架 vitest（禁止 node:test/tsx）。直接调 handleSessionRead（纯逻辑，agentDir 注入），
 * 传真实 `/Users/zhushanwen/.pi/agent` 作 agentDir——用本机真实历史 session 数据，无需 mock。
 *
 * 覆盖全 11 action 主路径 + F1(find 零匹配)/F4(turn 越界)/F5(缺参)/resolveSessionId 片段等价，
 * 以及 u8 doctor / u9 归一化 / u10 find 分组 / u11 metadataProvider 缓存 / u12 跨会话检索（各见对应 describe）。
 *
 * 真实数据用例全部带 skipIf 守卫（CI 无本机 ~/.pi/agent → skip，不硬失败）；
 * renderExtractItems F9 截断是纯 fixture，无条件跑。
 */

// 真实数据套件 timeout 说明：find 全扫描 + 5.6MB 文件解析在并发/高负载下可能超过
// vitest 默认 5s（pnpm extensions:test 全量跑时多包集成测试并发 IO），显式放宽到 60s。
describe.skipIf(!HAS_REAL)('handleSessionRead', () => {
  it('1. find by uuid fragment returns matching session', async () => {
    const r = await handleSessionRead({ action: 'find', query: 'e6c96' }, { agentDir: REAL })
    const d = r.details as { matches: Array<{ sessionId: string }> }
    expect(d.matches.some((m) => m.sessionId.startsWith('019e6c96'))).toBe(true)
    expect(r.content[0]).toEqual({ type: 'text', text: expect.any(String) })
  })

  it('2. outline yields 32 turns within token budget (v2 O1: <=1500)', async () => {
    const r = await handleSessionRead({ action: 'outline', session: E6 }, { agentDir: REAL })
    const d = r.details as { turns: unknown[]; tokenEstimate: number }
    expect(d.turns.length).toBe(32)
    // v2 O1：加 assistantBrief + 修 toolSummary bug 后阈值 600→1500（design §3.3 D4）
    expect(d.tokenEstimate).toBeLessThanOrEqual(1500)
  })

  it('3. detail single turn returns toolResult summary by default (v2 O3)', async () => {
    const r = await handleSessionRead({ action: 'detail', session: E6, turns: 'T001' }, { agentDir: REAL })
    const d = r.details as { entries: Array<{ type: string; message?: { role?: string } }> }
    expect(d.entries.length).toBeGreaterThan(0)
    // v2 O3：默认 toolResult 变摘要态（type=toolResultSummary），条目不消失
    expect(d.entries.some((e) => e.type === 'toolResultSummary')).toBe(true)
    // 不再有 role=toolResult 的原文 entry（除非 includeToolResult:true）
    expect(d.entries.some((e) => e.message?.role === 'toolResult')).toBe(false)
  })

  it('4. family lists fork children and隔代 subagents', async () => {
    // 数据守卫：fork 子代 019fe632（sessions/）与隔代 subagent 019fe635（subagents/）
    // 位于活跃数据目录（subagents 目录随 GC/新建持续变化），文件被清理/重命名时跳过
    // 而非失败——与 TC14-TC18 的「数据不存在则 return」守卫模式一致，避免偶发红。
    // 注意必须用 hasAnyRealSession（双目录），hasRealSession 只扫 sessions/ 扫不到 019fe635。
    if (!hasAnyRealSession('019fe632') || !hasAnyRealSession('019fe635')) return
    const r = await handleSessionRead({ action: 'family', session: FAM }, { agentDir: REAL })
    const d = r.details as {
      forks: Array<{ sessionId: string }>
      subagents: Array<{ sessionId: string }>
    }
    expect(d.forks.some((f) => f.sessionId.startsWith('019fe632'))).toBe(true)
    // 隔代：019fe635.rootSessionId=019fe632（fork 子代），从家族根 FAM 出发仍能关联
    expect(d.subagents.some((s) => s.sessionId.startsWith('019fe635'))).toBe(true)
  })

  it('5. search pattern returns hits', async () => {
    const r = await handleSessionRead({ action: 'search', session: E6, pattern: 'plugin' }, { agentDir: REAL })
    const d = r.details as { hits: Array<{ turnIndex: number; matchSnippet: string }> }
    expect(d.hits.length).toBeGreaterThan(0)
    expect(typeof d.hits[0].matchSnippet).toBe('string')
  })

  it('6. export outline materializes a .md file', async () => {
    const r = await handleSessionRead(
      { action: 'export', session: E6, format: 'outline' },
      { agentDir: REAL },
    )
    const d = r.details as { path: string; sizeBytes: number }
    expect(d.path).toMatch(/\.md$/)
    expect(existsSync(d.path)).toBe(true)
    expect(d.sizeBytes).toBeGreaterThan(0)
  })

  // w1 合并 subagent 候选后，本机 subagent task 文本（含本用例 query 字符串本身，因当前
  // wave 的 subagent task 引用了它）会触发 name-keyword fallback 命中 → 零匹配断言失败。
  // w2 实现 handler source 透传后，用 source:'main' 收窄到 main 侧避开 subagent 干扰
  //（w1 test 注释原预言的修复路径），同时恢复默认 timeout（main 单侧扫描快）。
  it('7. F1 find zero match returns empty matches + fact-based self-check (no throw)', async () => {
    const r = await handleSessionRead(
      { action: 'find', query: 'zzz-nonexistent-session-9q8x2', source: 'main' },
      { agentDir: REAL },
    )
    const d = r.details as { matches: unknown[]; truncated: boolean }
    expect(d.matches).toEqual([])
    expect(d.truncated).toBe(false)
    // u9 F1 重写（§5.2）：事实型自检 + 无归因断言 + 无「recent 看全量」误导
    expect(r.content[0].text).toContain('无匹配 session')
    expect(r.content[0].text).toContain('自检（发现层，只陈述事实）')
    expect(r.content[0].text).not.toContain('真的没有')
    expect(r.content[0].text).not.toContain('recent')
  })

  it('8. F4 detail turn out of range throws with 越界', async () => {
    await expect(
      handleSessionRead({ action: 'detail', session: E6, turns: 'T999' }, { agentDir: REAL }),
    ).rejects.toThrow(/越界/)
  })

  it('9. F5 outline missing session throws naming session', async () => {
    await expect(handleSessionRead({ action: 'outline' }, { agentDir: REAL })).rejects.toThrow(/session/)
  })

  it('10. resolveSessionId fragment equivalent to full id', async () => {
    const rFull = await handleSessionRead({ action: 'outline', session: E6 }, { agentDir: REAL })
    const rFrag = await handleSessionRead({ action: 'outline', session: 'e6c96' }, { agentDir: REAL })
    const dFull = rFull.details as { turns: unknown[] }
    const dFrag = rFrag.details as { turns: unknown[] }
    expect(dFrag.turns.length).toBe(dFull.turns.length)
  })
}, 60000)

describe.skipIf(!HAS_E6)('extract (v2 O4)', () => {
  it('user-messages returns 26 user entries with turn + full text', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'user-messages' },
      { agentDir: REAL },
    )
    const d = r.details as {
      what: string
      count: number
      shown: number
      truncated: boolean
      items: Array<{ turn: number; text: string }>
    }
    expect(d.what).toBe('user-messages')
    expect(d.count).toBe(26) // 全量 user entry 数（design §1：26 user）
    // F9 预算可能截断：items 是 shown 子集，shown <= count
    expect(d.shown).toBeLessThanOrEqual(d.count)
    expect(d.items.length).toBe(d.shown)
    expect(d.items.length).toBeGreaterThan(0)
    expect(
      d.items.every((it) => typeof it.turn === 'number' && typeof it.text === 'string'),
    ).toBe(true)
  })

  it('commands (no filter) returns 519 tool calls with name + summary', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'commands' },
      { agentDir: REAL },
    )
    const d = r.details as {
      count: number
      shown: number
      items: Array<{ name: string; summary: string }>
    }
    expect(d.count).toBe(519) // 全量 toolCall（design §2.3：519）
    expect(d.shown).toBeLessThanOrEqual(d.count)
    expect(d.items.length).toBe(d.shown)
    expect(
      d.items.every((it) => typeof it.name === 'string' && typeof it.summary === 'string'),
    ).toBe(true)
    // 抽查 bash summary 含 "bash: "（D1 映射）
    const bashItem = d.items.find((it) => it.name === 'bash')
    if (bashItem !== undefined) {
      expect(bashItem.summary).toContain('bash: ')
    }
  })

  it('commands tool=bash returns 309 all bash', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'commands', tool: 'bash' },
      { agentDir: REAL },
    )
    const d = r.details as {
      count: number
      shown: number
      items: Array<{ name: string }>
    }
    expect(d.count).toBe(309) // bash toolCall 全量（F9 可能截断 shown 子集）
    expect(d.items.every((it) => it.name === 'bash')).toBe(true)
  })

  it('commands tool=nonexist triggers F8 with tool distribution (no throw)', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'commands', tool: 'nonexist' },
      { agentDir: REAL },
    )
    const d = r.details as {
      toolDistribution: Array<{ name: string; count: number }>
    }
    expect(r.content[0].text).toContain('无匹配')
    expect(r.content[0].text).toContain('bash×309')
    expect(r.content[0].text).toContain('👉')
    expect(d.toolDistribution.some((t) => t.name === 'bash' && t.count === 309)).toBe(true)
  })

  it('files returns deduped paths with op (read/edit/write/head)', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'files' },
      { agentDir: REAL },
    )
    const d = r.details as {
      count: number
      items: Array<{ path: string; basename: string; op: string; turns: number[] }>
    }
    expect(d.count).toBeGreaterThan(0) // 开发 session 有大量文件操作
    expect(d.items.length).toBeGreaterThan(0)
    // 抽查含 .ts 或 .md 文件
    expect(
      d.items.some((it) => it.path.endsWith('.ts') || it.path.endsWith('.md')),
    ).toBe(true)
    // op 含 read/edit/write/head 之一
    expect(d.items.some((it) => /read|edit|write|head/.test(it.op))).toBe(true)
    // turns 是数组（去重后出现过的轮次）
    expect(d.items.every((it) => Array.isArray(it.turns))).toBe(true)
  })

  it('commits returns hash list with 7-8 hex + source turn', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'commits' },
      { agentDir: REAL },
    )
    const d = r.details as {
      count: number
      items: Array<{ hash: string; turn: number; source: string; context: string }>
    }
    // 真实开发 session 有 git log/show 操作 → git-cmd 主路径应取到 hash
    expect(d.count).toBeGreaterThan(0)
    // commits 已知会误匹配/漏报（D6），只验每条格式
    for (const it of d.items) {
      expect(it.hash).toMatch(/^[0-9a-f]{7,8}$/)
      expect(typeof it.turn).toBe('number')
      expect(['git-cmd', 'commit-context']).toContain(it.source)
    }
  })

  it('tool-results (no filter) returns 515 results with toolName + text', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'tool-results' },
      { agentDir: REAL },
    )
    const d = r.details as {
      count: number
      shown: number
      items: Array<{ toolName: string; text: string }>
    }
    expect(d.count).toBe(515) // 全量 toolResult（design §1：515 toolResult）
    expect(d.shown).toBeLessThanOrEqual(d.count)
    expect(
      d.items.every((it) => typeof it.toolName === 'string' && typeof it.text === 'string'),
    ).toBe(true)
  })

  it('tool-results tool=bash returns 309 all bash', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'tool-results', tool: 'bash' },
      { agentDir: REAL },
    )
    const d = r.details as { count: number; items: Array<{ toolName: string }> }
    expect(d.count).toBe(309)
    expect(d.items.every((it) => it.toolName === 'bash')).toBe(true)
  })

  it('tool-results tool=nonexist triggers F8 (no throw)', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'tool-results', tool: 'nonexist' },
      { agentDir: REAL },
    )
    expect(r.content[0].text).toContain('无匹配')
    expect(r.content[0].text).toContain('bash×309')
  })

  it('F7 missing what throws with 无效 + valid values', async () => {
    // what 缺失是合法 SessionReadParams（optional），handler 层 F7 防御校验。
    // isExtractWhat 对 undefined 返 false → 同一 throw 路径，覆盖非法值场景。
    const params: SessionReadParams = { action: 'extract', session: E6 }
    await expect(handleSessionRead(params, { agentDir: REAL })).rejects.toThrow(/无效/)
    await expect(handleSessionRead(params, { agentDir: REAL })).rejects.toThrow(
      /user-messages\/commands\/files\/commits\/tool-results/,
    )
  })

  it('S2: extract turns 越界文案说明 extract turn 体系（不指向 outline）', async () => {
    // extract 用全量 entry 分段（含 compaction/旁支），turn index 与 outline leaf 视图不对齐
    let msg = ''
    try {
      await handleSessionRead(
        { action: 'extract', session: E6, what: 'user-messages', turns: 'T999' },
        { agentDir: REAL },
      )
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('extract 的 turn 范围与 outline 不同')
    expect(msg).not.toContain('用 outline 重看有效范围')
    expect(msg).toContain('该 session extract 共')
  })
}, 60000)

// ---- fixture 工具（tmpdir 造最小 session 文件，供 F2/MF-5 用例）----

async function makeFixtureSession(
  dir: string,
  id: string,
  firstUserText: string,
): Promise<void> {
  const slug = '--demo-cwd--'
  await mkdir(join(dir, 'sessions', slug), { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', id, cwd: '/demo' }),
    JSON.stringify({
      type: 'message',
      id: id + '-m1',
      parentId: id,
      message: { role: 'user', content: [{ type: 'text', text: firstUserText }] },
    }),
  ]
  await writeFile(join(dir, 'sessions', slug, id + '.jsonl'), lines.join('\n') + '\n')
}

describe('F2 多匹配消歧（fixture，MF-9）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-f2-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('共享 uuid 片段 → 不抛错，content 含两候选 + 👉，details.ambiguous=true', async () => {
    const ID1 = '019e6c96-aaaa-bbbb-cccc-000000000001'
    const ID2 = '019e6c96-aaaa-bbbb-cccc-000000000002'
    await makeFixtureSession(dir, ID1, '第一段内容')
    await makeFixtureSession(dir, ID2, '第二段内容')

    // outline 走 resolveSessionId → 2 匹配 → F2 消歧（不抛错）
    const r = await handleSessionRead({ action: 'outline', session: '019e6c96-aaaa' }, { agentDir: dir })
    const d = r.details as { ambiguous: boolean; candidates: Array<{ sessionId: string }> }
    expect(d.ambiguous).toBe(true)
    expect(d.candidates).toHaveLength(2)
    expect(d.candidates.some((c) => c.sessionId === ID1)).toBe(true)
    expect(d.candidates.some((c) => c.sessionId === ID2)).toBe(true)
    const text = r.content[0].text
    expect(text).toContain(ID1)
    expect(text).toContain(ID2)
    expect(text).toContain('👉')
  })

  it('search/detail/expand/extract 同样走 F2 消歧（不抛错）', async () => {
    const ID1 = '019e6c96-aaaa-bbbb-cccc-000000000001'
    const ID2 = '019e6c96-aaaa-bbbb-cccc-000000000002'
    await makeFixtureSession(dir, ID1, '第一段内容')
    await makeFixtureSession(dir, ID2, '第二段内容')

    for (const action of ['detail', 'expand', 'search', 'export', 'extract'] as const) {
      const params: SessionReadParams = { action, session: '019e6c96-aaaa' }
      if (action === 'detail') params.turns = 'T001'
      if (action === 'expand') params.turn = 'T001'
      if (action === 'search') params.pattern = 'x'
      if (action === 'extract') params.what = 'user-messages'
      const r = await handleSessionRead(params, { agentDir: dir })
      const d = r.details as { ambiguous: boolean }
      expect(d.ambiguous, `action=${action}`).toBe(true)
      expect(r.content[0].text).toContain('👉')
    }
  })
})

describe('outline skippedLines 报告（fixture，D8d 有检测必有报告）', () => {
  let dir: string
  const SID = '019e6c96-bbbb-cccc-dddd-00000000000b'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-skipped-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('坏行计入 stats.skippedLines 且文本尾部可见（不静默跳过）', async () => {
    // 中间注入 1 行坏 JSON（半截对象）：parser 计 skippedLines=1，outline 必须报告
    const slug = '--demo-cwd--'
    await mkdir(join(dir, 'sessions', slug), { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', id: SID, cwd: '/demo' }),
      JSON.stringify({
        type: 'message',
        id: SID + '-m1',
        parentId: SID,
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      }),
      '{"broken json line',
    ]
    await writeFile(join(dir, 'sessions', slug, SID + '.jsonl'), lines.join('\n') + '\n')

    const r = await handleSessionRead({ action: 'outline', session: SID }, { agentDir: dir })
    const d = r.details as { stats: { skippedLines: number } }
    expect(d.stats.skippedLines).toBe(1)
    expect(r.content[0].text).toContain('1 skipped lines')
  })

  it('无坏行时不输出 skipped 片段（正常 session 零噪音）', async () => {
    await makeFixtureSession(dir, SID, 'clean session')
    const r = await handleSessionRead({ action: 'outline', session: SID }, { agentDir: dir })
    const d = r.details as { stats: { skippedLines: number } }
    expect(d.stats.skippedLines).toBe(0)
    expect(r.content[0].text).not.toContain('skipped lines')
  })
})

// ============================================================
// E7：行渲染统一（ext-simplify-04 U5，design D3）。outline 与 export {format:"outline"}
// 共用 renderOutline 返回的渲染行（OutlineResult.lines）+ 同一尾段拼装——预算度量 =
// 展示 by construction；旁支标记统一为 `[旁支 N entries]`（改前 handler 侧第二份行
// 格式知识输出裸 `[旁支]`，已随 formatOutlineText 删除）。
// ============================================================
describe('E7 行渲染统一（outline 与 export outline 同一渲染行）', () => {
  let dir: string
  const SID = '019e6c96-bbbb-cccc-dddd-00000000000e'

  /** 写含 fork 旁支的 session：主链 R→m1(user)→m2(assistant)，b1/b2 挂 m1 下成
   * 旁支子树（buildTreeView：branches[m1]=2；segmentTurns：单 turn [m1, m2]，
   * 旁支 entry 不进 leaf 视图）。 */
  async function writeForkSession(): Promise<void> {
    await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
    const msg = (id: string, parentId: string, role: 'user' | 'assistant', text: string) =>
      JSON.stringify({
        type: 'message',
        id: `${SID}-${id}`,
        parentId,
        message: { role, content: [{ type: 'text', text }] },
      })
    const lines = [
      JSON.stringify({ type: 'session', id: SID, cwd: '/demo' }),
      msg('m1', SID, 'user', 'fork point turn'),
      msg('b1', `${SID}-m1`, 'assistant', 'branch one'),
      msg('b2', `${SID}-m1`, 'assistant', 'branch two'),
      msg('m2', `${SID}-m1`, 'assistant', 'main line answer'),
    ]
    await writeFile(join(dir, 'sessions', '--demo-cwd--', `${SID}.jsonl`), lines.join('\n') + '\n')
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-e7-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('① allBranches:true → 旁支行标记 `[旁支 N entries]`（N=forkPoint 旁支子树 entry 数）+ 尾段同改前语义', async () => {
    await writeForkSession()
    const r = await handleSessionRead(
      { action: 'outline', session: SID, allBranches: true },
      { agentDir: dir },
    )
    const text = r.content[0].text
    // 旁支标记带 entry 数；裸 `[旁支]` 旧形态零出现（'[旁支]' 与 '[旁支 2 entries]' 互不为子串）
    expect(text).toContain('T000 · fork point turn · → main line answer · [旁支 2 entries]')
    expect(text).not.toContain('[旁支]')
    // stats 尾段与改前语义一致（totalEntries = leaf 2 + 旁支 2）
    expect(text).toContain('1 turns · 4 entries · ')
  })

  it('② 两 action 一致性：export {format:"outline"} 物化全文 === outline content 文本（旁支行同形态）', async () => {
    await writeForkSession()
    const outline = await handleSessionRead(
      { action: 'outline', session: SID, allBranches: true },
      { agentDir: dir },
    )
    const exp = await handleSessionRead(
      { action: 'export', session: SID, format: 'outline', allBranches: true },
      { agentDir: dir },
    )
    const d = exp.details as { path: string }
    const exported = await readFile(d.path, 'utf8')
    // 干净 session（无坏行）下两 action 全文逐字节一致——同一 result.lines + 同一尾段拼装
    expect(exported).toBe(outline.content[0].text)
    expect(exported).toContain('[旁支 2 entries]')
  })
})

describe('search 灾难性正则降级 + abort（fixture，MF-5 回归）', () => {
  let dir: string
  const SID = '019e6c96-bbbb-cccc-dddd-00000000000a'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-search-'))
    await makeFixtureSession(dir, SID, 'aaa plugin 内容')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('嵌套量词 pattern (a+)+ → 降级字面子串（不挂死，零命中）', async () => {
    const r = await handleSessionRead({ action: 'search', session: SID, pattern: '(a+)+' }, { agentDir: dir })
    const d = r.details as { hits: unknown[] }
    // 字面量 '(a+)+' 不在内容里 → 0 命中（若按正则执行会命中 'aaa' 且可能指数回溯）
    expect(d.hits).toHaveLength(0)
  })

  it('普通正则仍按正则匹配', async () => {
    const r = await handleSessionRead({ action: 'search', session: SID, pattern: 'a+' }, { agentDir: dir })
    const d = r.details as { hits: unknown[] }
    expect(d.hits.length).toBeGreaterThan(0)
  })

  it('范围量词 {m,n} 形态 → 降级字面子串（(a{1,3})*、(a{0,2})*、(a{1,3}){2,}，MF-1 回归）', async () => {
    for (const pattern of ['(a{1,3})*', '(a{0,2})*', '(a{1,3}){2,}']) {
      const r = await handleSessionRead({ action: 'search', session: SID, pattern }, { agentDir: dir })
      const d = r.details as { hits: unknown[] }
      // 字面量不含这些 pattern → 0 命中；若按正则执行会指数回溯挂死
      expect(d.hits, `pattern=${pattern}`).toHaveLength(0)
    }
  })

  it('alternation/嵌套量词分支 (a|aa)+、(a*)* → 降级字面子串（MF-5 分支回归）', async () => {
    for (const pattern of ['(a|aa)+', '(a*)*']) {
      const r = await handleSessionRead({ action: 'search', session: SID, pattern }, { agentDir: dir })
      const d = r.details as { hits: unknown[] }
      expect(d.hits, `pattern=${pattern}`).toHaveLength(0)
    }
  })

  it('(a{1,3}) 单独使用不被降级（组后无尾随量词，仍按正则执行）', async () => {
    const r = await handleSessionRead(
      { action: 'search', session: SID, pattern: '(a{1,3})' },
      { agentDir: dir },
    )
    const d = r.details as { hits: unknown[] }
    // 按正则执行命中 'aaa' → >0 命中（若被降级为字面量则 0 命中）
    expect(d.hits.length).toBeGreaterThan(0)
  })

  it('降级标注：header 含「已降级为字面子串匹配」（S-3）', async () => {
    const r = await handleSessionRead({ action: 'search', session: SID, pattern: '(a+)+' }, { agentDir: dir })
    expect(r.content[0].text).toContain('已降级为字面子串匹配')
  })

  it('非法正则 pattern → 字面子串兜底不抛错（零命中，S-6）', async () => {
    const r = await handleSessionRead({ action: 'search', session: SID, pattern: '[unclosed' }, { agentDir: dir })
    const d = r.details as { hits: unknown[] }
    expect(d.hits).toHaveLength(0)
  })

  it('scope 过滤：scope=assistant 零命中（fixture 仅 user 角色，S-6）', async () => {
    const r = await handleSessionRead(
      { action: 'search', session: SID, pattern: 'aaa', scope: 'assistant' },
      { agentDir: dir },
    )
    const d = r.details as { hits: unknown[] }
    expect(d.hits).toHaveLength(0)
  })

  it('limit 截断 → truncated=true + hits 限长（3 条命中 limit=2，S-6）', async () => {
    const sid2 = '019e6c96-bbbb-cccc-dddd-00000000000b'
    // message 链式 parentId（与真实 pi session 一致）：m0→session 根，m1→m0，m2→m1，
    // 否则 buildTreeView 只回溯最后一条的父链，前两条被当旁支过滤
    const lines = [
      JSON.stringify({ type: 'session', id: sid2, cwd: '/demo' }),
      ...['aa1', 'aa2', 'aa3'].map((t, i) =>
        JSON.stringify({
          type: 'message',
          id: `${sid2}-m${i}`,
          parentId: i === 0 ? sid2 : `${sid2}-m${i - 1}`,
          message: { role: 'user', content: [{ type: 'text', text: t }] },
        }),
      ),
    ]
    await writeFile(
      join(dir, 'sessions', '--demo-cwd--', `${sid2}.jsonl`),
      lines.join('\n') + '\n',
    )
    const r = await handleSessionRead(
      { action: 'search', session: sid2, pattern: 'aa', limit: 2 },
      { agentDir: dir },
    )
    const d = r.details as { hits: unknown[]; truncated: boolean }
    expect(d.truncated).toBe(true)
    expect(d.hits).toHaveLength(2)
  })

  it('aborted signal → search 抛中断错误（不继续扫描）', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      handleSessionRead({ action: 'search', session: SID, pattern: 'x' }, { agentDir: dir }, ac.signal),
    ).rejects.toThrow(/中断/)
  })
})

describe('extract commits 双路径（fixture：git-cmd 主路径 + commit-context 次路径 + 去重）', () => {
  let dir: string
  const SID = '019e6c96-bbbb-cccc-dddd-00000000000c'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-commits-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 写单个 session JSONL（commits 用例行内联传入）。 */
  async function writeCommitsSession(id: string, lines: string[]): Promise<void> {
    await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
    await writeFile(
      join(dir, 'sessions', '--demo-cwd--', `${id}.jsonl`),
      lines.join('\n') + '\n',
    )
  }

  it('commit-context 次路径：非 git bash 的 toolResult，hash 邻近含关键词才收（D6）', async () => {
    await writeCommitsSession(SID, [
      JSON.stringify({ type: 'session', id: SID, cwd: '/demo' }),
      JSON.stringify({
        type: 'message',
        id: `${SID}-m1`,
        parentId: SID,
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc-read-1', name: 'read', arguments: { path: '/tmp/log.txt' } },
          ],
        },
      }),
      // read 结果：hash 邻近 30 字符窗口含 'feat:' → commit-context 次路径纳入
      JSON.stringify({
        type: 'message',
        id: `${SID}-m2`,
        parentId: `${SID}-m1`,
        message: {
          role: 'toolResult',
          toolName: 'read',
          toolCallId: 'tc-read-1',
          content: [{ type: 'text', text: 'deploy abc1234f done\nfeat: add login' }],
        },
      }),
      // read 结果：hash 无关键词邻近 → 两路径都不收（过滤分支）
      JSON.stringify({
        type: 'message',
        id: `${SID}-m3`,
        parentId: `${SID}-m2`,
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc-read-2', name: 'read', arguments: { path: '/tmp/out.txt' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: `${SID}-m4`,
        parentId: `${SID}-m3`,
        message: {
          role: 'toolResult',
          toolName: 'read',
          toolCallId: 'tc-read-2',
          content: [{ type: 'text', text: 'output 9998887 plain text' }],
        },
      }),
    ])
    const r = await handleSessionRead({ action: 'extract', session: SID, what: 'commits' }, { agentDir: dir })
    const d = r.details as { count: number; items: Array<{ hash: string; source: string }> }
    const hashes = d.items.map((it) => it.hash)
    expect(hashes).toContain('abc1234f')
    expect(hashes).not.toContain('9998887')
    expect(d.items.find((it) => it.hash === 'abc1234f')?.source).toBe('commit-context')
  })

  it('去重高置信优先：同 hash 同时命中 git-cmd 与 commit-context → 保留 git-cmd 一条', async () => {
    await writeCommitsSession(SID, [
      JSON.stringify({ type: 'session', id: SID, cwd: '/demo' }),
      JSON.stringify({
        type: 'message',
        id: `${SID}-m1`,
        parentId: SID,
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc-bash-1', name: 'bash', arguments: { command: 'git log --oneline -3' } },
          ],
        },
      }),
      // bash + git log → git-cmd 高置信（含 def5678a）
      JSON.stringify({
        type: 'message',
        id: `${SID}-m2`,
        parentId: `${SID}-m1`,
        message: {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc-bash-1',
          content: [{ type: 'text', text: 'def5678a feat: fix crash' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: `${SID}-m3`,
        parentId: `${SID}-m2`,
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc-read-1', name: 'read', arguments: { path: '/tmp/deploy.txt' } },
          ],
        },
      }),
      // read 结果同 hash def5678a + 关键词 merged → low 候选，去重后丢弃
      JSON.stringify({
        type: 'message',
        id: `${SID}-m4`,
        parentId: `${SID}-m3`,
        message: {
          role: 'toolResult',
          toolName: 'read',
          toolCallId: 'tc-read-1',
          content: [{ type: 'text', text: 'deploy def5678a merged' }],
        },
      }),
    ])
    const r = await handleSessionRead({ action: 'extract', session: SID, what: 'commits' }, { agentDir: dir })
    const d = r.details as { count: number; items: Array<{ hash: string; source: string }> }
    const dupes = d.items.filter((it) => it.hash === 'def5678a')
    expect(dupes).toHaveLength(1)
    expect(dupes[0].source).toBe('git-cmd')
    expect(d.count).toBe(1)
  })
})

describe('renderExtractItems F9 截断（S3 首项超大 + S4 文案）', () => {
  it('S3: 首项超大内部截断 → body 不超预算，shown<count + truncated=true', () => {
    // 首项 10000 字符 >> EXTRACT_BUDGET_BYTES(8000)；旧逻辑放行首项致 body≈10KB
    const longText = 'x'.repeat(10000)
    const items = [
      { turn: 5, text: longText },
      { turn: 6, text: 'short6' },
      { turn: 7, text: 'short7' },
    ]
    const r = renderExtractItems(
      'user-messages',
      items,
      (it) => `T${String(it.turn).padStart(3, '0')}: ${it.text}`,
      (it) => [it.turn],
    )
    const d = r.details as { what: string; count: number; shown: number; truncated: boolean }
    expect(d.truncated).toBe(true)
    expect(d.count).toBe(3)
    expect(d.shown).toBe(1) // 首项截断后保留，后续项因预算用未加入
    // body（含文案行）字节数远小于 3 项全量（30000+ 字节），≤ 预算 + 合理余量
    const bodyBytes = Buffer.byteLength(r.content[0].text, 'utf8')
    expect(bodyBytes).toBeLessThan(8000 * 1.5)
    // 截断标记存在（首项被内部 slice + 省略号）
    expect(r.content[0].text).toContain('…')
    // 完整 longText 不在输出里（已被截断）
    expect(r.content[0].text).not.toContain(longText)
  })

  it('S4: F9 文案含实际 turn 范围 + 实际 token（非固定 2000）', () => {
    // 3 项各 ~3000 字节，累计超 8000 → 第 3 项触发截断（文案报 shown turn 范围）
    const items = [
      { turn: 10, text: 'a'.repeat(3000) },
      { turn: 20, text: 'b'.repeat(3000) },
      { turn: 30, text: 'c'.repeat(3000) },
    ]
    const r = renderExtractItems(
      'user-messages',
      items,
      (it) => `T${String(it.turn).padStart(3, '0')}: ${it.text}`,
      (it) => [it.turn],
    )
    const text = r.content[0].text
    // 文案含 turn 范围（shown 的 min-max turn）
    expect(text).toMatch(/T010-T0\d{2}/)
    // 文案含实际 token（从 body 实际字节算），不再是固定 2000
    expect(text).toContain('token 达预算上限')
    expect(text).not.toContain('≈2000 token')
    // 文案含 shown/count
    expect(text).toMatch(/已显示 \d+\/\d+ 项/)
  })
})

// ============================================================
// w2 新增：resolveSessionId 三形态（① 绝对路径 / ② sa-id / ③ findSessions 透传 source）
// + ES1/ES2 错误契约 + source 透传 + 真实数据守卫（design TC2-TC18）
// ============================================================

/**
 * 造 subagent manifest + session 文件（TC7/TC8/TC10/CQ3 用）。
 * sessionFileExists:false 模拟 GC（manifest 存在但 session 文件不存在 → ES1）。
 * 返回 session 文件绝对路径（= manifest.sessionFile）。
 */
async function makeFixtureSubagent(
  dir: string,
  saId: string,
  opts: {
    realSessionId: string
    rootSessionId?: string
    agentName?: string
    sessionFileExists?: boolean
    firstUserText?: string
  },
): Promise<string> {
  const slug = '--demo-cwd--'
  const sessionFile = join(dir, 'subagents', slug, 'sessions', `${opts.realSessionId}.jsonl`)
  if (opts.sessionFileExists !== false) {
    await mkdir(join(dir, 'subagents', slug, 'sessions'), { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', id: opts.realSessionId, cwd: '/demo' }),
      JSON.stringify({
        type: 'message',
        id: opts.realSessionId + '-m1',
        parentId: opts.realSessionId,
        message: {
          role: 'user',
          content: [{ type: 'text', text: opts.firstUserText ?? 'subagent work' }],
        },
      }),
    ]
    await writeFile(sessionFile, lines.join('\n') + '\n')
  }
  const recordsDir = join(dir, 'subagents', slug, 'records')
  await mkdir(recordsDir, { recursive: true })
  await writeFile(
    join(recordsDir, `${saId}.json`),
    JSON.stringify({
      id: saId,
      rootSessionId: opts.rootSessionId ?? 'root-session-1',
      agentName: opts.agentName ?? 'explorer',
      sessionFile,
    }),
  )
  return sessionFile
}

describe('resolveSessionId ① 绝对路径形态（w2 TC2-TC6）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-path-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('TC2: 绝对路径 outline → sessionId=header 真实 id（非文件名）', async () => {
    const fileId = '019e6c96-dddd-eeee-ffff-000000000b1'
    // 文件名 arbitrary-name 与 header id 不同，验 sessionId 取 header id
    const filePath = join(dir, 'sessions', '--demo-cwd--', 'arbitrary-name.jsonl')
    await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', id: fileId, cwd: '/demo' }),
      JSON.stringify({
        type: 'message',
        id: fileId + '-m1',
        parentId: fileId,
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      }),
    ]
    await writeFile(filePath, lines.join('\n') + '\n')
    // export 的 details.path = session-view-<sessionId>.md，含 header 真实 id，不含文件名
    const r = await handleSessionRead(
      { action: 'export', session: filePath, format: 'outline' },
      { agentDir: dir },
    )
    const d = r.details as { path: string }
    expect(d.path).toContain(fileId)
    expect(d.path).not.toContain('arbitrary-name')
  })

  it('TC3: 绝对路径文件不存在 → F6 风格错误（含 👉）', async () => {
    const filePath = join(
      dir,
      'sessions',
      '--demo-cwd--',
      `not-exist-${Date.now()}.jsonl`,
    )
    await expect(
      handleSessionRead({ action: 'outline', session: filePath }, { agentDir: dir }),
    ).rejects.toThrow(/读取失败.*文件不存在/)
    await expect(
      handleSessionRead({ action: 'outline', session: filePath }, { agentDir: dir }),
    ).rejects.toThrow('👉')
  })

  it('TC4: 绝对路径非 .jsonl → F6 风格错误', async () => {
    const filePath = join(dir, 'sessions', '--demo-cwd--', 'x.txt')
    await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
    await writeFile(filePath, 'not jsonl')
    await expect(
      handleSessionRead({ action: 'outline', session: filePath }, { agentDir: dir }),
    ).rejects.toThrow(/读取失败.*非 \.jsonl/)
  })

  it('TC5: 绝对路径 header 读不出（首行非 session header）→ F6 风格错误', async () => {
    const filePath = join(dir, 'sessions', '--demo-cwd--', 'bad.jsonl')
    await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
    await writeFile(filePath, JSON.stringify({ type: 'custom', customType: 'x' }) + '\n')
    await expect(
      handleSessionRead({ action: 'outline', session: filePath }, { agentDir: dir }),
    ).rejects.toThrow(/读取失败.*首行非合法 session header/)
  })

  it('TC5 变体: 绝对路径空文件 → F6 风格错误', async () => {
    const filePath = join(dir, 'sessions', '--demo-cwd--', 'empty.jsonl')
    await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
    await writeFile(filePath, '')
    await expect(
      handleSessionRead({ action: 'outline', session: filePath }, { agentDir: dir }),
    ).rejects.toThrow(/读取失败.*首行非合法 session header/)
  })

  it('TC6: ~ 前缀展开到 homedir（文件实际在 homedir 下）', async () => {
    const home = homedir()
    const tmpUnderHome = await mkdtemp(join(home, '.sr-w2-test-'))
    try {
      const fileId = '019e6c96-dddd-eeee-ffff-0000000006c1'
      const sessionFile = join(tmpUnderHome, 's.jsonl')
      await writeFile(
        sessionFile,
        JSON.stringify({ type: 'session', id: fileId, cwd: '/demo' }) + '\n',
      )
      // ~/开头的相对 homedir 路径
      const tildePath = '~/' + sessionFile.slice(home.length + 1)
      const r = await handleSessionRead(
        { action: 'export', session: tildePath, format: 'outline' },
        { agentDir: dir },
      )
      expect((r.details as { path: string }).path).toContain(fileId)
    } finally {
      await rm(tmpUnderHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('resolveSessionId ② sa-id 形态（w2 TC7-TC10 + CQ3）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-said-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('TC7: sa-id 恰 1 命中 + sessionFile 存在 → 成功，sessionId=header 真实 id（非 sa-）', async () => {
    const realId = '019e6c96-dddd-eeee-ffff-0000000007a1'
    await makeFixtureSubagent(dir, 'sa-aaa', { realSessionId: realId, firstUserText: 'do task' })
    const r = await handleSessionRead(
      { action: 'export', session: 'sa-aaa', format: 'outline' },
      { agentDir: dir },
    )
    const d = r.details as { path: string }
    expect(d.path).toContain(realId)
    expect(d.path).not.toContain('sa-aaa')
  })

  it('TC8: sa-id 命中但 sessionFile 不存在（GC/未写入）→ ES1（含 manifest 元数据 + 👉）', async () => {
    await makeFixtureSubagent(dir, 'sa-gc', {
      realSessionId: '019e6c96-dddd-eeee-ffff-0000000008a2',
      rootSessionId: 'root-1',
      agentName: 'explorer',
      sessionFileExists: false,
    })
    await expect(
      handleSessionRead({ action: 'outline', session: 'sa-gc' }, { agentDir: dir }),
    ).rejects.toThrow('session 文件不存在')
    // 错误含 manifest 全部元数据 + 👉
    try {
      await handleSessionRead({ action: 'outline', session: 'sa-gc' }, { agentDir: dir })
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('sa-gc')
      expect(msg).toContain('root-1')
      expect(msg).toContain('explorer')
      expect(msg).toContain('sessionFile:')
      expect(msg).toContain('👉')
      expect(msg).toContain('action:"family"')
    }
  })

  it('TC9: sa-id 0 命中（可能 running）→ ES2（含 family 指引 + 完整 id 提示 + 👉）', async () => {
    await expect(
      handleSessionRead({ action: 'outline', session: 'sa-nonexist-9999' }, { agentDir: dir }),
    ).rejects.toThrow('无匹配 record')
    try {
      await handleSessionRead({ action: 'outline', session: 'sa-nonexist-9999' }, { agentDir: dir })
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('可能尚未落盘')
      expect(msg).toContain('action:"family"')
      expect(msg).toContain('👉')
    }
  })

  it('TC10: sa-id 片段输入（精确相等不命中）→ ES2', async () => {
    await makeFixtureSubagent(dir, 'sa-c8c8dfa8', {
      realSessionId: '019e6c96-dddd-eeee-ffff-0000000010a3',
    })
    // 片段 sa-c8c8 不等于完整 sa-c8c8dfa8 → 精确相等不命中 → ES2
    await expect(
      handleSessionRead({ action: 'outline', session: 'sa-c8c8' }, { agentDir: dir }),
    ).rejects.toThrow('无匹配 record')
  })

  it('sa-id 多 manifest 命中（数据异常）→ ES2 ambiguous（C4）', async () => {
    // 同 sa-id 的两个 manifest（不同 cwd slug 目录，模拟数据异常）
    for (const [slug, realId] of [
      ['--demo-cwd--', '019e6c96-dddd-eeee-ffff-0000000004a4'],
      ['--other-cwd--', '019e6c96-dddd-eeee-ffff-0000000004a5'],
    ] as const) {
      const sessionFile = join(dir, 'subagents', slug, 'sessions', `${realId}.jsonl`)
      await mkdir(join(dir, 'subagents', slug, 'sessions'), { recursive: true })
      await writeFile(
        sessionFile,
        JSON.stringify({ type: 'session', id: realId, cwd: '/demo' }) + '\n',
      )
      const recordsDir = join(dir, 'subagents', slug, 'records')
      await mkdir(recordsDir, { recursive: true })
      await writeFile(
        join(recordsDir, 'sa-dup.json'),
        JSON.stringify({
          id: 'sa-dup',
          rootSessionId: 'r',
          agentName: 'a',
          sessionFile,
        }),
      )
    }
    await expect(
      handleSessionRead({ action: 'outline', session: 'sa-dup' }, { agentDir: dir }),
    ).rejects.toThrow(/匹配 2 个 record.*数据异常/)
  })

  it('CQ3: sa-id 命中但 sessionFile header 读不出 → F6 风格（不降级 record.id 当 sessionId）', async () => {
    // sessionFile 存在但首行非 session header → readSessionHeaderIdSync 返 undefined
    const slug = '--demo-cwd--'
    const sessionFile = join(dir, 'subagents', slug, 'sessions', 'bad.jsonl')
    await mkdir(join(dir, 'subagents', slug, 'sessions'), { recursive: true })
    await writeFile(sessionFile, JSON.stringify({ type: 'custom', customType: 'x' }) + '\n')
    const recordsDir = join(dir, 'subagents', slug, 'records')
    await mkdir(recordsDir, { recursive: true })
    await writeFile(
      join(recordsDir, 'sa-bad.json'),
      JSON.stringify({
        id: 'sa-bad',
        rootSessionId: 'r',
        agentName: 'a',
        sessionFile,
      }),
    )
    // 抛 F6 风格（读取失败 + 首行非合法 session header），不降级返回 sa-bad 当 sessionId
    await expect(
      handleSessionRead({ action: 'outline', session: 'sa-bad' }, { agentDir: dir }),
    ).rejects.toThrow(/读取失败.*首行非合法 session header/)
  })
})

describe('source 透传（w2 TC12-TC13，依赖 w1 findSessions opts.source）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-src-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('TC12: find source 过滤——subagent 只返回 subagent 候选，main 只返回 main', async () => {
    const sharedFragment = '019e6c96'
    const mainId = `${sharedFragment}-aaaa-bbbb-cccc-0000000012d1`
    const subId = `${sharedFragment}-aaaa-bbbb-cccc-0000000012d2`
    await makeFixtureSession(dir, mainId, 'main content')
    await makeFixtureSubagent(dir, 'sa-sub12', { realSessionId: subId, firstUserText: 'sub content' })

    // 无 source → 两者
    const rBoth = await handleSessionRead(
      { action: 'find', query: sharedFragment },
      { agentDir: dir },
    )
    const dBoth = rBoth.details as {
      matches: Array<{ source: string; sessionId: string }>
    }
    expect(dBoth.matches.some((m) => m.sessionId === mainId)).toBe(true)
    expect(dBoth.matches.some((m) => m.sessionId === subId)).toBe(true)

    // source:subagent → 只 sub
    const rSub = await handleSessionRead(
      { action: 'find', query: sharedFragment, source: 'subagent' },
      { agentDir: dir },
    )
    const dSub = rSub.details as {
      matches: Array<{ source: string; sessionId: string }>
    }
    expect(dSub.matches.every((m) => m.source === 'subagent')).toBe(true)
    expect(dSub.matches.some((m) => m.sessionId === subId)).toBe(true)
    expect(dSub.matches.some((m) => m.sessionId === mainId)).toBe(false)

    // source:main → 只 main
    const rMain = await handleSessionRead(
      { action: 'find', query: sharedFragment, source: 'main' },
      { agentDir: dir },
    )
    const dMain = rMain.details as {
      matches: Array<{ source: string; sessionId: string }>
    }
    expect(dMain.matches.every((m) => m.source === 'main')).toBe(true)
    expect(dMain.matches.some((m) => m.sessionId === mainId)).toBe(true)
    expect(dMain.matches.some((m) => m.sessionId === subId)).toBe(false)
  })

  it('TC13: outline source:main → resolveSessionId ③ 收窄到 main 候选（无 source 时多匹配 F2）', async () => {
    const sharedFragment = '019e6c96'
    const mainId = `${sharedFragment}-aaaa-bbbb-cccc-0000000013e1`
    const subId = `${sharedFragment}-aaaa-bbbb-cccc-0000000013e2`
    await makeFixtureSession(dir, mainId, 'main content')
    await makeFixtureSubagent(dir, 'sa-sub13', { realSessionId: subId, firstUserText: 'sub content' })

    // 无 source → main+sub 共享片段 → 2 匹配 → F2 消歧
    const rMulti = await handleSessionRead(
      { action: 'outline', session: sharedFragment },
      { agentDir: dir },
    )
    expect((rMulti.details as { ambiguous: boolean }).ambiguous).toBe(true)

    // source:main → 收窄到 main → 唯一匹配 → outline 成功，且是 main（export path 含 mainId）
    const rExp = await handleSessionRead(
      { action: 'export', session: sharedFragment, source: 'main', format: 'outline' },
      { agentDir: dir },
    )
    expect((rExp.details as { path: string }).path).toContain(mainId)
  })
})

describe.skipIf(!HAS_REAL_SUBAGENTS_DIR)('真实数据：subagent sa-id（w2 TC14-TC18）', () => {
  it('TC14: completed subagent sa-id outline 成功（场景 1，sessionId=header 真实 id）', async () => {
    const manifests = await listRecordManifests(REAL)
    const alive = manifests.filter((m) => existsSync(m.sessionFile))
    if (alive.length === 0) return // 本机无存活 manifest 则跳过（skipIf 只守卫目录存在）
    const r = await handleSessionRead({ action: 'outline', session: alive[0].id }, { agentDir: REAL })
    const d = r.details as { turns: unknown[] }
    expect(d.turns.length).toBeGreaterThan(0)
  })

  it('TC15: worktree 编码目录 subagent 读取（场景 1b，递归扫描覆盖）', async () => {
    const manifests = await listRecordManifests(REAL)
    const wt = manifests.filter(
      (m) => m.sessionFile.includes('--private-var-folders-') && existsSync(m.sessionFile),
    )
    if (wt.length === 0) return // 本机无 worktree 编码目录数据则跳过
    const r = await handleSessionRead({ action: 'outline', session: wt[0].id }, { agentDir: REAL })
    expect(((r.details as { turns: unknown[] }).turns).length).toBeGreaterThan(0)
  })

  it('TC16: 嵌套后代直接 outline（场景 1c，绝对路径形态读任意节点）', async () => {
    const manifests = await listRecordManifests(REAL)
    const alive = manifests.filter((m) => existsSync(m.sessionFile))
    if (alive.length === 0) return
    // 绝对路径形态直接读（M0 入口不依赖 findSessions）
    const r = await handleSessionRead(
      { action: 'outline', session: alive[0].sessionFile },
      { agentDir: REAL },
    )
    expect(((r.details as { turns: unknown[] }).turns).length).toBeGreaterThan(0)
  })

  it('TC17: GC/failed manifest → ES1（场景 4，sessionFile 不存在）', async () => {
    const manifests = await listRecordManifests(REAL)
    const gc = manifests.filter((m) => !existsSync(m.sessionFile))
    if (gc.length === 0) return // 本机无 GC 数据则跳过
    await expect(
      handleSessionRead({ action: 'outline', session: gc[0].id }, { agentDir: REAL }),
    ).rejects.toThrow('session 文件不存在')
  })

  it('TC18: 不存在 sa-id → ES2（场景 4，可能 running 指引）', async () => {
    const fakeId = `sa-nonexist-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`
    await expect(
      handleSessionRead({ action: 'outline', session: fakeId }, { agentDir: REAL }),
    ).rejects.toThrow('无匹配 record')
  })
}, 60000)

// ============================================================
// w6: doWorkflow action（TC-w6-single-run/multi-run/runid-filter/runid-not-found/no-runs/snapshot-skip/call-jump）
// ============================================================

// ---- workflow fixture 常量（uuid 特征，互不为子串）----
const WF_ROOT = '019w6aaa-0000-7000-b000-000000000001' // 发起 workflow 的 main session
const WF_CALL = '019w6bbb-0000-7000-b000-000000000002' // workflow call 的目标 session（call-jump）
const SUB_WF_ROOT = '019w6ccc-0000-7000-b000-000000000003' // 发起 workflow 的 subagent session（MF-2）

/** 写 main session（header + 1 条 user message，让 outline 有 turn）。返回绝对路径。 */
async function wfMainSession(
  dir: string,
  slug: string,
  id: string,
  opts?: { cwd?: string },
): Promise<string> {
  const sessionDir = join(dir, 'sessions', slug)
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, `${id}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'session', id, cwd: opts?.cwd ?? `/proj/${slug}` }),
    JSON.stringify({
      type: 'message',
      id: `${id}-m1`,
      parentId: id,
      message: { role: 'user', content: [{ type: 'text', text: 'run workflow' }] },
    }),
  ]
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

/** 写 wf-state 文件（每行一个快照 JSON）。返回绝对路径。 */
async function wfStateFile(
  dir: string,
  slug: string,
  fileName: string,
  lines: string[],
): Promise<string> {
  const wfDir = join(dir, 'sessions', slug, 'workflow-state')
  await mkdir(wfDir, { recursive: true })
  const path = join(wfDir, fileName)
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

/** 向 main session 追加 workflow-state-link custom entry（resolveWorkflows 的输入）。 */
async function wfLink(
  dir: string,
  slug: string,
  id: string,
  link: { runId: string; path: string },
): Promise<void> {
  const sessionPath = join(dir, 'sessions', slug, `${id}.jsonl`)
  const line = JSON.stringify({
    type: 'custom',
    id: `wf-link-${link.runId}`,
    parentId: id,
    customType: 'workflow-state-link',
    data: { runId: link.runId, path: link.path, updatedAt: '2026-08-12T00:00:00Z' },
    timestamp: '2026-08-12T00:00:00Z',
  })
  await writeFile(sessionPath, line + '\n', { flag: 'a' })
}

/** 构造 NEW 格式 wf-state 快照 JSON 行（calls 含 sessionId/sessionFile，parseRunSnapshot 透传）。 */
function wfSnapshotNew(
  runId: string,
  calls: Array<{ sessionId: string; sessionFile: string; description?: string }>,
): string {
  return JSON.stringify({
    v: 'wf-run-v1',
    runId,
    spec: { scriptName: 'test-wf', name: 'Test' },
    state: {
      status: 'done',
      reason: 'completed',
      budget: {
        usedTokens: 100,
        usedCost: 0,
        totalCallCount: calls.length,
        maxTokens: 10000,
      },
      calls: calls.map((c, i) => ({
        id: i,
        opts: {
          prompt: 'do work',
          model: 'test-model',
          description: c.description ?? `step-${i}`,
        },
        status: 'done',
        attempts: 1,
        result: {
          content: 'ok',
          durationMs: 100,
          sessionId: c.sessionId,
          sessionFile: c.sessionFile,
        },
        sessionId: c.sessionId,
        sessionFile: c.sessionFile,
      })),
    },
    meta: { startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z' },
  })
}

describe('doWorkflow（w6，fixture）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-wf-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('TC-w6-single-run：单 run 概览，content 含 run 头行/budget/step，details.runs/runIds 非空', async () => {
    const slug = '--wf-single--'
    await wfMainSession(dir, slug, WF_ROOT)
    const callSession = join(dir, 'sessions', slug, `${WF_CALL}.jsonl`)
    const wfPath = await wfStateFile(dir, slug, 'wf-single.jsonl', [
      wfSnapshotNew('wf-single-1', [
        { sessionId: WF_CALL, sessionFile: callSession, description: 'probe-step' },
      ]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-single-1', path: wfPath })

    const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
    const d = r.details as {
      runs: Array<{
        runId: string
        status: string
        steps: Array<{ sessionId: string; sessionFile: string }>
      }>
      runIds: string[]
    }
    expect(d.runs).toHaveLength(1)
    expect(d.runs[0].runId).toBe('wf-single-1')
    expect(d.runs[0].status).toBe('done')
    expect(d.runs[0].steps).toHaveLength(1)
    expect(d.runs[0].steps[0].sessionId).toBe(WF_CALL)
    expect(d.runs[0].steps[0].sessionFile).toBe(callSession)
    expect(d.runIds).toEqual(['wf-single-1'])
    // content 含 renderWorkflowOverview 输出
    const text = r.content[0].text
    expect(text).toContain('run: wf-single-1')
    expect(text).toContain('[done]')
    expect(text).toContain('budget:')
    expect(text).toContain('#0')
    expect(text).toContain('call=' + WF_CALL.slice(0, 12))
    expect(text).toContain(callSession)
  })

  it('TC-w6-multi-run：多 run 拼接，content 含两段 overview，runs.length===2', async () => {
    const slug = '--wf-multi--'
    await wfMainSession(dir, slug, WF_ROOT)
    const wf1 = await wfStateFile(dir, slug, 'wf-1.jsonl', [
      wfSnapshotNew('wf-multi-1', [{ sessionId: WF_CALL, sessionFile: '/abs/a.jsonl' }]),
    ])
    const wf2 = await wfStateFile(dir, slug, 'wf-2.jsonl', [
      wfSnapshotNew('wf-multi-2', [{ sessionId: WF_CALL, sessionFile: '/abs/b.jsonl' }]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-multi-1', path: wf1 })
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-multi-2', path: wf2 })

    const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
    const d = r.details as { runs: Array<{ runId: string }>; runIds: string[] }
    expect(d.runs).toHaveLength(2)
    expect(d.runIds).toHaveLength(2)
    expect(d.runIds).toContain('wf-multi-1')
    expect(d.runIds).toContain('wf-multi-2')
    const text = r.content[0].text
    expect(text).toContain('run: wf-multi-1')
    expect(text).toContain('run: wf-multi-2')
  })

  it('TC-w6-runid-filter：runId 过滤命中单 run', async () => {
    const slug = '--wf-filter--'
    await wfMainSession(dir, slug, WF_ROOT)
    const wf1 = await wfStateFile(dir, slug, 'wf-1.jsonl', [
      wfSnapshotNew('wf-filter-1', [{ sessionId: WF_CALL, sessionFile: '/abs/a.jsonl' }]),
    ])
    const wf2 = await wfStateFile(dir, slug, 'wf-2.jsonl', [
      wfSnapshotNew('wf-filter-2', [{ sessionId: WF_CALL, sessionFile: '/abs/b.jsonl' }]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-filter-1', path: wf1 })
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-filter-2', path: wf2 })

    const r = await handleSessionRead(
      { action: 'workflow', session: WF_ROOT, runId: 'wf-filter-1' },
      { agentDir: dir },
    )
    const d = r.details as {
      runs: Array<{ runId: string }>
      runIds: string[]
      requestedRunId?: string
    }
    expect(d.runs).toHaveLength(1)
    expect(d.runIds).toEqual(['wf-filter-1'])
    expect(d.requestedRunId).toBe('wf-filter-1')
    const text = r.content[0].text
    expect(text).toContain('run: wf-filter-1')
    expect(text).not.toContain('run: wf-filter-2')
  })

  it('TC-w6-runid-not-found：runId 无匹配→ES-wf-runid-not-found（列候选+👉，不抛错）', async () => {
    const slug = '--wf-notfound--'
    await wfMainSession(dir, slug, WF_ROOT)
    const wf1 = await wfStateFile(dir, slug, 'wf-1.jsonl', [
      wfSnapshotNew('wf-nf-1', [{ sessionId: WF_CALL, sessionFile: '/abs/a.jsonl' }]),
    ])
    const wf2 = await wfStateFile(dir, slug, 'wf-2.jsonl', [
      wfSnapshotNew('wf-nf-2', [{ sessionId: WF_CALL, sessionFile: '/abs/b.jsonl' }]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-nf-1', path: wf1 })
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-nf-2', path: wf2 })

    const r = await handleSessionRead(
      { action: 'workflow', session: WF_ROOT, runId: 'wf-nonexist' },
      { agentDir: dir },
    )
    const d = r.details as { runs: unknown[]; runIds: string[]; requestedRunId?: string }
    expect(d.runs).toEqual([])
    expect(d.runIds).toContain('wf-nf-1')
    expect(d.runIds).toContain('wf-nf-2')
    expect(d.requestedRunId).toBe('wf-nonexist')
    const text = r.content[0].text
    expect(text).toContain('wf-nonexist')
    expect(text).toContain('wf-nf-1')
    expect(text).toContain('wf-nf-2')
    expect(text).toContain('👉')
  })

  it('TC-w6-no-runs：无 workflow run→ES-wf-no-runs（提示+👉family，不抛错）', async () => {
    const slug = '--wf-noruns--'
    await wfMainSession(dir, slug, WF_ROOT)
    // 无 wf-link（session 存在但未发起 workflow）

    const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
    const d = r.details as { runs: unknown[]; runIds: unknown[]; sessionId?: string }
    expect(d.runs).toEqual([])
    expect(d.runIds).toEqual([])
    expect(d.sessionId).toBe(WF_ROOT)
    const text = r.content[0].text
    expect(text).toContain('无 workflow run')
    expect(text).toContain('👉')
    expect(text).toContain('family')
  })

  it('TC-w6-snapshot-skip：run1 wf-state 不存在→跳过，run2 正常（ES-wf-snapshot-read-fail）', async () => {
    const slug = '--wf-skip--'
    await wfMainSession(dir, slug, WF_ROOT)
    // run1 的 wf-state 文件不存在（link 指向不存在路径，模拟 GC）
    const ghostPath = join(dir, 'sessions', slug, 'workflow-state', 'wf-ghost.jsonl')
    const wf2 = await wfStateFile(dir, slug, 'wf-2.jsonl', [
      wfSnapshotNew('wf-skip-2', [{ sessionId: WF_CALL, sessionFile: '/abs/b.jsonl' }]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-skip-1', path: ghostPath })
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-skip-2', path: wf2 })

    const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
    const d = r.details as {
      runs: Array<{ runId: string }>
      runIds: string[]
      skippedRuns?: Array<{ runId: string; stateFile: string; reason: string }>
    }
    expect(d.runs).toHaveLength(1)
    expect(d.runs[0].runId).toBe('wf-skip-2')
    expect(d.runIds).toEqual(['wf-skip-2'])
    expect(d.skippedRuns).toBeDefined()
    expect(d.skippedRuns).toHaveLength(1)
    expect(d.skippedRuns![0].runId).toBe('wf-skip-1')
    expect(d.skippedRuns![0].reason).toBe('snapshot-unreadable')
    const text = r.content[0].text
    expect(text).toContain('wf-skip-1')
    expect(text).toContain('已跳过')
    expect(text).toContain('run: wf-skip-2')
  })

  it('TC-w6-call-jump：workflow 概览 call sessionId 可被 resolveSessionId 深读（outline 跳转，§7 场景 2）', async () => {
    const slug = '--wf-jump--'
    await wfMainSession(dir, slug, WF_ROOT)
    // 真实存在的 call session（main session 形态，findSessions 可匹配）
    const callPath = await wfMainSession(dir, slug, WF_CALL, { cwd: '/proj/call' })
    const wfPath = await wfStateFile(dir, slug, 'wf-jump.jsonl', [
      wfSnapshotNew('wf-jump-1', [{ sessionId: WF_CALL, sessionFile: callPath }]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-jump-1', path: wfPath })

    // 第一次：workflow 概览，拿 call sessionId
    const rWf = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, { agentDir: dir })
    const dWf = rWf.details as {
      runs: Array<{ steps: Array<{ sessionId: string; sessionFile: string }> }>
    }
    expect(dWf.runs).toHaveLength(1)
    const callSessionId = dWf.runs[0].steps[0].sessionId
    expect(callSessionId).toBe(WF_CALL)

    // 第二次：用 call sessionId 调 outline（m0 resolveSessionId 三形态复用）
    const rOutline = await handleSessionRead(
      { action: 'outline', session: callSessionId },
      { agentDir: dir },
    )
    const dOutline = rOutline.details as { turns: unknown[] }
    expect(dOutline.turns.length).toBeGreaterThan(0)
  })

  it('TC-w6-subagent-session：workflow action 对 subagent session 直读 wf-link 不抛错（MF-2）', async () => {
    const slug = '--wf-subagent--'
    // subagent session 放 subagents/ 下（不在 sessions/——buildFamilyFromFs 的 main byId
    // 索引外，旧实现 resolveFamily 找不到会抛「session not found in family index」）
    const subDir = join(dir, 'subagents', slug, 'sessions')
    await mkdir(subDir, { recursive: true })
    const subPath = join(subDir, `${SUB_WF_ROOT}.jsonl`)
    await writeFile(
      subPath,
      JSON.stringify({ type: 'session', id: SUB_WF_ROOT, cwd: `/proj/${slug}` }) + '\n',
    )
    const callSession = join(dir, 'sessions', slug, `${WF_CALL}.jsonl`)
    const wfPath = await wfStateFile(dir, slug, 'wf-sub.jsonl', [
      wfSnapshotNew('wf-sub-1', [
        { sessionId: WF_CALL, sessionFile: callSession, description: 'sub-step' },
      ]),
    ])
    // subagent session 的 workflow-state-link（wfLink helper 只写 sessions/，此处直接追加）
    await writeFile(
      subPath,
      JSON.stringify({
        type: 'custom',
        id: 'wf-link-wf-sub-1',
        parentId: SUB_WF_ROOT,
        customType: 'workflow-state-link',
        data: { runId: 'wf-sub-1', path: wfPath, updatedAt: '2026-08-12T00:00:00Z' },
        timestamp: '2026-08-12T00:00:00Z',
      }) + '\n',
      { flag: 'a' },
    )

    const r = await handleSessionRead({ action: 'workflow', session: SUB_WF_ROOT }, { agentDir: dir })
    const d = r.details as { runs: Array<{ runId: string }>; runIds: string[] }
    expect(d.runs).toHaveLength(1)
    expect(d.runs[0].runId).toBe('wf-sub-1')
    expect(d.runIds).toEqual(['wf-sub-1'])
    expect(r.content[0].text).toContain('run: wf-sub-1')
    expect(r.content[0].text).toContain('call=')
  })
})

// ============================================================
// 真实数据守卫：doWorkflow（CI 无本机数据时 skipIf 跳过）
// ============================================================

const REAL_WF_SESSION = '019fdcda-75c7-74b7-a160-f67f6bf88384'
const HAS_REAL_WF_SESSION = HAS_REAL && hasRealSession(REAL_WF_SESSION)

describe.skipIf(!HAS_REAL_WF_SESSION)('doWorkflow - 真实数据守卫', () => {
  it('TC-w6-real-data-guard：真实 workflow session doWorkflow 返回 run 概览', async () => {
    const r = await handleSessionRead(
      { action: 'workflow', session: REAL_WF_SESSION },
      { agentDir: REAL },
    )
    const d = r.details as {
      runs: Array<{ runId: string; status: string; steps: unknown[] }>
      runIds: string[]
    }
    expect(d.runs.length).toBeGreaterThan(0)
    expect(d.runIds.length).toBe(d.runs.length)
    // content 含 run 头行 + budget 行
    expect(r.content[0].text).toContain('run:')
    expect(r.content[0].text).toContain('budget:')
  }, 30000)
}, 60000)

// ============================================================
// m3b：doFamily recursive false/true（TC-m3b-dofamily-recursive-false/true）
// ============================================================

describe('doFamily recursive（m3b U8 接入）', () => {
  let dir: string
  const MAIN = '019e6c96-cccc-dddd-eeee-000000000001'
  const SUB = '019e6c96-cccc-dddd-eeee-000000000002'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-recursive-'))
    await makeFixtureSession(dir, MAIN, 'main session 内容')
    // 顶层 subagent（rootSessionId=MAIN，无 parentRecordId → flat 回退）
    await makeFixtureSubagent(dir, `sa-${SUB.slice(0, 8)}`, {
      realSessionId: SUB,
      rootSessionId: MAIN,
      agentName: 'explorer',
      firstUserText: 'subagent task',
    })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('TC-m3b-dofamily-recursive-false：不传 recursive → flat family（m0-m2 零回归）', async () => {
    const r = await handleSessionRead({ action: 'family', session: MAIN }, { agentDir: dir })
    // details 是 Family 对象（root/subagents/workflows），非 { tree }
    const d = r.details as {
      root: { sessionId: string }
      subagents: Array<{ sessionId: string; rootSessionId: string }>
      workflows: unknown[]
    }
    expect(d.root.sessionId).toBe(MAIN)
    expect(d.subagents.some((s) => s.sessionId === SUB)).toBe(true)
    expect(Array.isArray(d.workflows)).toBe(true)
    // content 是 formatFamilyText（非 formatExecutionTreeText）
    expect(r.content[0].text).toContain('root:')
    expect(r.content[0].text).not.toContain('execution tree')
  })

  it('TC-m3b-dofamily-recursive-true：recursive=true → ExecutionTree（details.tree）', async () => {
    const r = await handleSessionRead(
      { action: 'family', session: MAIN, recursive: true },
      { agentDir: dir },
    )
    const d = r.details as {
      tree: {
        root: { type: string; sessionId: string; children: unknown[] }
        totalNodes: number
        maxDepth: number
        sourceMode: string
        truncated: boolean
      }
    }
    expect(d.tree).toBeDefined()
    expect(d.tree.root.type).toBe('main')
    expect(d.tree.root.sessionId).toBe(MAIN)
    // subagent 挂 root（flat 回退，无 parentRecordId）
    expect(d.tree.root.children).toHaveLength(1)
    expect(d.tree.totalNodes).toBe(2) // main + subagent
    expect(d.tree.sourceMode).toBe('flat-fallback') // 旧机制无 parentRecordId
    expect(d.tree.truncated).toBe(false)
    // content 是 formatExecutionTreeText（含 execution tree 头部）
    expect(r.content[0].text).toContain('execution tree')
    expect(r.content[0].text).toContain('node(s)')
    expect(r.content[0].text).toContain('👉')
  })
})

// ===========================================================================
// ext-simplify-04 U4/E2（D2②）：formatFamilyText subagents 行富字段展示
// status 终态短标签 + agent 名 + task 截 60 摘要；孤儿只标 [已清理]；P4 输出量级守卫。
// ===========================================================================

describe('formatFamilyText subagents 行富字段（ext-simplify-04 U4 / E2）', () => {
  const MAIN = '0aaaaaaa-bbbb-7ccc-dddd-0000000000f1'
  const SUB = '0aaaaaaa-bbbb-7ccc-dddd-0000000000f2'
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-family-rich-'))
    await makeFixtureSession(dir, MAIN, 'main session')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** alive subagent：session 文件（header + 可选 identity 尾行）+ 可选 manifest 富字段 */
  async function writeSubagent(
    realId: string,
    opts: {
      manifest?: { agentName?: string; task?: string; slug?: string; model?: string; status?: string }
      identityTask?: string
      identityAgent?: string
    } = {},
  ): Promise<void> {
    const sessionDir = join(dir, 'subagents', '--demo-cwd--', 'sessions')
    await mkdir(sessionDir, { recursive: true })
    const subPath = join(sessionDir, `${realId}.jsonl`)
    const lines = [JSON.stringify({ type: 'session', id: realId, cwd: '/demo' })]
    if (opts.identityTask !== undefined || opts.identityAgent !== undefined) {
      lines.push(
        JSON.stringify({
          type: 'custom',
          customType: 'subagent-identity',
          data: {
            id: `sa-${realId.slice(0, 8)}`,
            rootSessionId: MAIN,
            slug: 'identity-slug',
            agent: opts.identityAgent ?? 'explorer',
            task: opts.identityTask ?? 't',
          },
        }),
      )
    }
    await writeFile(subPath, lines.join('\n') + '\n')
    if (opts.manifest) {
      const recordsDir = join(dir, 'subagents', '--demo-cwd--', 'records')
      await mkdir(recordsDir, { recursive: true })
      await writeFile(
        join(recordsDir, `sa-${realId}.json`),
        JSON.stringify({
          id: `sa-${realId}`,
          rootSessionId: MAIN,
          sessionFile: subPath,
          ...opts.manifest,
        }),
      )
    }
  }

  /** 孤儿 manifest：sessionFile 指向不存在路径（模拟 .jsonl 被 GC） */
  async function writeOrphanManifest(
    saId: string,
    fields: { agentName?: string; task?: string; slug?: string; status?: string } = {},
  ): Promise<void> {
    const recordsDir = join(dir, 'subagents', '--demo-cwd--', 'records')
    await mkdir(recordsDir, { recursive: true })
    await writeFile(
      join(recordsDir, `${saId}.json`),
      JSON.stringify({ id: saId, rootSessionId: MAIN, sessionFile: '/nonexistent/gc.jsonl', ...fields }),
    )
  }

  it('manifest 主路径：subagents 行含 [status] agent 名 · task 摘要；root 段不变', async () => {
    await writeSubagent(SUB, {
      manifest: { agentName: 'coder', task: '修复登录表单校验并补测试', slug: 'fix-login', status: 'completed' },
    })
    const r = await handleSessionRead({ action: 'family', session: MAIN }, { agentDir: dir })
    const text = r.content[0].text
    // 富字段行形态（设计 §3.1）：slug 后接 [status] agent · task 摘要
    expect(text).toContain('slug=fix-login [completed] coder · 修复登录表单校验并补测试')
    // root/parents/forks/workflows 段不变（root 行含完整 id + 日期括号）
    expect(text).toContain(`root: ${MAIN} (`)
  })

  it('P4 输出量级：task 截 60 字符（超出加省略号），换行压平不破坏行结构', async () => {
    const SUB2 = '0aaaaaaa-bbbb-7ccc-dddd-0000000000f3'
    await writeSubagent(SUB, {
      manifest: { agentName: 'coder', task: 'A'.repeat(100), slug: 'long-task', status: 'running' },
    })
    await writeSubagent(SUB2, {
      manifest: { agentName: 'worker', task: 'line1\nline2\ttabbed', slug: 'nl-task', status: 'failed' },
    })
    const r = await handleSessionRead({ action: 'family', session: MAIN }, { agentDir: dir })
    const text = r.content[0].text
    // 截断：恰 60 字符 + 省略号，原文 61+ 连续段不出现
    expect(text).toContain(`${'A'.repeat(60)}…`)
    expect(text).not.toContain('A'.repeat(61))
    // 换行/制表压平为单空格
    expect(text).toContain('slug=nl-task [failed] worker · line1 line2 tabbed')
    // 行结构：subagents 段 = 头行 + 每 subagent 恰一行（换行未折叠出额外行）
    const lines = text.split('\n')
    const headIdx = lines.indexOf('subagents:')
    const subLines = lines.slice(headIdx + 1)
    expect(subLines).toHaveLength(2)
    expect(subLines.every((l) => l.startsWith('  ') && l.trim().length > 0)).toBe(true)
  })

  it('孤儿（cleanedUp）：仍标 [已清理]，不展开 status/agent/task 摘要', async () => {
    await writeOrphanManifest('sa-ghost-id', {
      agentName: 'worker',
      task: 'ghost task',
      slug: 'ghost-slug',
      status: 'completed',
    })
    const r = await handleSessionRead({ action: 'family', session: MAIN }, { agentDir: dir })
    const text = r.content[0].text
    expect(text).toContain('slug=ghost-slug [已清理]')
    // 已清理即终局：manifest 富字段不进文本（无深读入口，摘要无消费价值）
    expect(text).not.toContain('ghost task')
    expect(text).not.toContain('[completed]')
  })

  it('P-fallback（无 manifest）：identity 回退 task/agent 仍展示，status 无则无标签', async () => {
    await writeSubagent(SUB, { identityTask: 'fix bug', identityAgent: 'worker' })
    const r = await handleSessionRead({ action: 'family', session: MAIN }, { agentDir: dir })
    const text = r.content[0].text
    // P-fallback：task/agent 从 identity 回退（slug 取 identity.slug），status 不可回退 → 无 [x] 标签
    expect(text).toContain('slug=identity-slug worker · fix bug')
    expect(text).not.toContain('[completed]')
    expect(text).not.toContain('[running]')
  })
})

// ===========================================================================
// doctor action（u8：design 2026-09-10 §6.3/§6.4/§7B 要点 2/4/5/8 + §6.11 U14b 段）
// 全部 mkdtemp fixture 自建自删，不触碰真实数据目录。
// ===========================================================================

// doctor details 契约直用 doctor.ts 导出的 DoctorDetails（不再自建局部镜像——生产侧
// 形状漂移由编译期捕捉，S-R2 同步）

describe('doctor action（u8：环境判定 + 根表 + 告警 + 残留 glob）', () => {
  let tmp: string

  const SLUG = '--Users-foo--'

  /** 写 .jsonl fixture（父目录自建），内容合法 session header */
  async function writeJsonl(path: string, id = 'x'): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `{"type":"session","id":"${id}"}\n`)
  }

  /**
   * xyz-agent 形态四根 fixture：dataDir 目录名带 .xyz-agent 前缀（detectEnvironment 的
   * PI_CODING_AGENT_DIR 形态判据 `<*>/.xyz-agent*\/agent` 可命中，托管判定走正态）。
   * live=agent/sessions 与 default 同字面路径（default 去重）、legacy 独立非空、subagent 独立。
   */
  async function buildFourRootFixture(): Promise<{
    dataDir: string
    agentDir: string
    signals: SessionReadSignals
  }> {
    const dataDir = join(tmp, '.xyz-agent-fixture')
    const agentDir = join(dataDir, 'agent')
    await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'), 'aaaaaaaa')
    await writeJsonl(join(agentDir, 'sessions', SLUG, 'b.jsonl'), 'bbbbbbbb')
    await writeJsonl(join(dataDir, 'sessions', 'old.jsonl'), 'cccccccc') // legacy 非空
    await writeJsonl(join(agentDir, 'subagents', SLUG, 'sessions', 's.jsonl'), 'dddddddd')
    return {
      dataDir,
      agentDir,
      signals: {
        agentDir,
        liveSessionDir: join(agentDir, 'sessions'),
        env: {
          XYZ_AGENT_EXT_LOG: '1',
          PI_CODING_AGENT_DIR: agentDir,
          XYZ_AGENT_DATA_DIR: dataDir,
        },
      },
    }
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tool-handler-doctor-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('四根表渲染：优先级序 + 去重注记 + 文件数/耗时 + 托管判定行 + 事实型诊断（无归因断言）', async () => {
    const { dataDir, agentDir, signals } = await buildFourRootFixture()
    const r = await handleSessionRead({ action: 'doctor' }, signals)
    const text = r.content[0].text

    // 环境判定行：双信号合取 → xyz-agent（托管）+ 数据目录 + evidence 正态
    expect(text).toContain('环境判定：xyz-agent（托管）')
    expect(text).toContain(`数据目录：${dataDir}`)
    expect(text).toContain('依据：')
    expect(text).toContain(`PI_CODING_AGENT_DIR='${agentDir}' → 形态匹配`)

    // 四根按优先级序渲染
    const liveIdx = text.indexOf('[live]')
    const defIdx = text.indexOf('[default]')
    const legacyIdx = text.indexOf('[legacy]')
    const subIdx = text.indexOf('[subagent]')
    expect(liveIdx).toBeGreaterThan(-1)
    expect(defIdx).toBeGreaterThan(liveIdx)
    expect(legacyIdx).toBeGreaterThan(defIdx)
    expect(subIdx).toBeGreaterThan(legacyIdx)

    // 去重注记（§7B 要点 4）：default 与第 1 行（live）同路径，已去重
    expect(text).toContain('与 1 同路径，已去重')

    // 事实型诊断：只陈述最高优先级 main 根 N 文件；禁止归因断言（§7B 要点 5）
    expect(text).toContain(
      `诊断：最高优先级 main 根 [live] ${join(agentDir, 'sessions')}：2 文件。`,
    )
    expect(text).not.toContain('真的没有')

    // details 程序化形态
    const d = r.details as DoctorDetails
    expect(d.roots.map((x) => x.kind)).toEqual(['live', 'default', 'legacy', 'subagent'])
    expect(d.roots[0].fileCount).toBe(2)
    expect(typeof d.roots[0].scanMs).toBe('number')
    expect(d.roots[1].dedupedInto).toBe('live')
    expect(d.roots[1].fileCount).toBeUndefined()
    expect(d.roots[2].fileCount).toBe(1) // legacy 独立实扫
    // subagent 默认 stat 模式：只列路径与可扫性，无计数
    expect(d.roots[3].exists).toBe(true)
    expect(d.roots[3].fileCount).toBeUndefined()
    expect(d.roots[3].scanMs).toBeUndefined()
  })

  it('legacy 非空告警：独立非空 → 告警；不存在 → 无告警；与 live 同路径被去重 → 不告警（§5.1）', async () => {
    // 正态：legacy 独立且非空
    const { signals } = await buildFourRootFixture()
    const positive = await handleSessionRead({ action: 'doctor' }, signals)
    expect(positive.content[0].text).toContain(
      `告警：[legacy] 根 ${join(tmp, '.xyz-agent-fixture', 'sessions')} 非空（1 文件）`,
    )

    // 反态：legacy 目录不存在
    const agentDir2 = join(tmp, 'data2', 'agent')
    await writeJsonl(join(agentDir2, 'sessions', SLUG, 'a.jsonl'))
    const negative = await handleSessionRead({ action: 'doctor' }, { agentDir: agentDir2 })
    expect(negative.content[0].text).not.toContain('告警：')

    // 去重态：live 与 legacy 同路径（文件非空）→ 已去重不告警
    const dataDir3 = join(tmp, 'data3')
    const agentDir3 = join(dataDir3, 'agent')
    await writeJsonl(join(dataDir3, 'sessions', SLUG, 'a.jsonl'))
    const deduped = await handleSessionRead(
      { action: 'doctor' },
      { agentDir: agentDir3, liveSessionDir: join(dataDir3, 'sessions') },
    )
    expect(deduped.content[0].text).not.toContain('告警：')
    expect(deduped.content[0].text).toContain('已去重')
  })

  it('独立 glob 残留探测：pi/ 含 agent|sessions 形态列出 + 迁移指引；pi.backup-v2-* 备份列出；基点 = dirname(agentDir)', async () => {
    const dataDir = join(tmp, 'data')
    const agentDir = join(dataDir, 'agent')
    await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'))
    // 未迁移旧布局 pi/（含 agent/ 形态）
    await mkdir(join(dataDir, 'pi', 'agent'), { recursive: true })
    await writeJsonl(join(dataDir, 'pi', 'agent', 'sessions', 'old.jsonl'), 'old-id')
    // 迁移备份（含 sessions/ 形态——备份即原 pi/ 改名）
    const backup = join(dataDir, 'pi.backup-v2-1725900000000')
    await mkdir(join(backup, 'sessions'), { recursive: true })
    await writeJsonl(join(backup, 'sessions', 'bak.jsonl'), 'bak-id')

    const r = await handleSessionRead({ action: 'doctor' }, { agentDir })
    const text = r.content[0].text
    expect(text).toContain(`旧布局残留探测（基点 ${dataDir}）`)
    expect(text).toContain(`  - ${join(dataDir, 'pi')}（未迁移旧布局 pi/）`)
    expect(text).toContain(`  - ${backup}（迁移备份 pi.backup-v2-*）`)
    // 同一迁移指引（§6.11：doctor 与 u14b 启动探测同指引）
    expect(text).toContain('👉 关闭应用后运行 scripts/migrate-pi-layout-v2.mjs 完成迁移。')

    const d = r.details as DoctorDetails
    expect(d.globBase).toBe(dataDir)
    expect(d.leftovers.map((l) => l.kind).sort()).toEqual(['backup', 'unmigrated'])
  })

  it('残留探测反态：pi/ 空壳（无 agent|sessions 子目录）不报——防纯 pi 宿主 ~/.pi/pi/ 误报（§6.11 v9.1）', async () => {
    const dataDir = join(tmp, 'data')
    const agentDir = join(dataDir, 'agent')
    await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'))
    // 纯 pi 宿主下任意来源的 pi/ 目录：只有无关子目录，无 agent/ 与 sessions/ 形态
    await mkdir(join(dataDir, 'pi', 'extensions'), { recursive: true })

    const r = await handleSessionRead({ action: 'doctor' }, { agentDir })
    expect(r.content[0].text).not.toContain('旧布局残留')
    expect((r.details as DoctorDetails).leftovers).toEqual([])
  })

  it('subagent 根默认不扫（只列路径与可扫性）；includeSubagents:true 才扫出文件数（§6.3）', async () => {
    const { agentDir, signals } = await buildFourRootFixture()

    const def = await handleSessionRead({ action: 'doctor' }, signals)
    const defSub = (def.details as DoctorDetails).roots.find((x) => x.kind === 'subagent')
    expect(defSub?.fileCount).toBeUndefined()
    expect(defSub?.scanMs).toBeUndefined()
    expect(defSub?.exists).toBe(true)
    expect(def.content[0].text).toContain('未扫描（subagent 根默认不扫')

    const full = await handleSessionRead({ action: 'doctor', includeSubagents: true }, signals)
    const fullSub = (full.details as DoctorDetails).roots.find((x) => x.kind === 'subagent')
    expect(fullSub?.fileCount).toBe(1)
    expect(fullSub?.exists).toBe(true)
  })

  it('无缓存形态（ext-simplify-04 U3）：重复调用输出一致（每次实扫），新落盘文件立即可见', async () => {
    // 原三个用例（缓存命中不重扫 / TTL 到期失效 / find 不读 doctor 缓存 PS-14）随
    // doctor 缓存机删除而合并为本用例——无缓存层后「find/doctor 读到旧计数」的形态
    // 在结构上不存在，守卫点收敛为：输出无「缓存命中」行 + 每次调用实扫（新增文件
    // 下一次调用即见，反而更实时）
    const agentDir = join(tmp, 'agent')
    await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'))
    const signals: SessionReadSignals = { agentDir }

    const first = (await handleSessionRead({ action: 'doctor' }, signals)).details as DoctorDetails
    const firstDef = first.roots.find((x) => x.kind === 'default')!
    expect(firstDef.fileCount).toBe(1)

    const second = await handleSessionRead({ action: 'doctor' }, signals)
    const secondDef = (second.details as DoctorDetails).roots.find((x) => x.kind === 'default')!
    expect(secondDef.fileCount).toBe(1) // 两次输出一致（同目录无变化）
    expect(second.content[0].text).not.toContain('缓存命中')

    // 新 session 落盘 → 下一次 doctor / find 均立即可见（无缓存层，每次实扫）
    await writeJsonl(join(agentDir, 'sessions', SLUG, 'b.jsonl'), 'bbbbbbbb')
    const third = (await handleSessionRead({ action: 'doctor' }, signals)).details as DoctorDetails
    expect(third.roots.find((x) => x.kind === 'default')!.fileCount).toBe(2)
    const r = await handleSessionRead({ action: 'find', query: 'bbbbbbbb' }, { agentDir })
    const d = r.details as { matches: Array<{ sessionId: string }> }
    expect(d.matches.some((m) => m.sessionId.includes('bbbbbbbb'))).toBe(true)
  })

  it('env/bundleUrl 信号缺失降级：仍出环境判定行（standalone-pi · 未知）+ 完整根表，不抛错', async () => {
    const agentDir = join(tmp, 'agent')
    await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'))
    // signals 无 env/bundleUrl 字段（u3 旧信号包形态）
    const r = await handleSessionRead({ action: 'doctor' }, { agentDir })
    const text = r.content[0].text
    expect(text).toContain('环境判定：standalone-pi · 发行形态：未知（不猜）')
    expect(text).toContain('XYZ_AGENT_EXT_LOG=<未设置> → 未命中')
    expect(text).toContain('会话根（按优先级）')
    expect(text).toContain('[default]')
    expect(text).toContain(
      `诊断：最高优先级 main 根 [default] ${join(agentDir, 'sessions')}：1 文件。`,
    )
  })

  it('空 agentDir 防御：无根表、诊断「无候选根」，残留探测不触发（不扫 cwd 相对路径）', async () => {
    const r = await handleSessionRead({ action: 'doctor' }, { agentDir: '' })
    const text = r.content[0].text
    expect(text).toContain('诊断：无候选根')
    expect(text).not.toContain('[default]')
    expect((r.details as DoctorDetails).roots).toEqual([])
    expect((r.details as DoctorDetails).leftovers).toEqual([])
  })
})

// ============================================================
// u9：F1 重写（§5.2 事实型自检 + 编辑距离 top-3 + 四条做法 + 禁止项）
// + uuid 归一化两级匹配（§6.7 子决策 1 + §11.5 对比基线）
// ============================================================

describe('u9 F1 重写 + uuid 归一化（fixture，§5.2 / §6.7 / §11.5）', () => {
  let tmp: string
  const SLUG = '--demo-cwd--'
  const ID1 = '019e6c96-aaaa-bbbb-cccc-000000000001'
  const ID2 = '019e6c96-aaaa-bbbb-cccc-000000000002'

  /**
   * 写 session 文件（文件名 = `${id}.jsonl`，extractSessionIdFromFilename 可提取——
   * F1 编辑距离候选的 id 来源）。subagent:true 写入 subagent 根。
   */
  async function writeSession(
    id: string,
    opts?: { subagent?: boolean; firstUserText?: string },
  ): Promise<void> {
    const dir = opts?.subagent
      ? join(tmp, 'agent', 'subagents', SLUG, 'sessions')
      : join(tmp, 'agent', 'sessions', SLUG)
    await mkdir(dir, { recursive: true })
    const lines = [JSON.stringify({ type: 'session', id, cwd: '/demo' })]
    if (opts?.firstUserText !== undefined) {
      lines.push(
        JSON.stringify({
          type: 'message',
          id: `${id}-m1`,
          message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
        }),
      )
    }
    await writeFile(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
  }

  /** find action 便捷调用（agentDir = tmp/agent）。 */
  function find(query: string, extra?: Partial<SessionReadParams>): Promise<ToolResultLike> {
    return handleSessionRead({ action: 'find', query, ...extra }, { agentDir: join(tmp, 'agent') })
  }

  interface ToolResultLike {
    content: Array<{ type: string; text: string }>
    details: unknown
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tool-handler-f1-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('① 大写 uuid 片段命中（§3.3 盲区：String.includes 大小写敏感）', async () => {
    await writeSession(ID1, { firstUserText: '无关内容' })
    const r = await find('019E6C96-AAAA')
    const d = r.details as { matches: Array<{ sessionId: string }> }
    expect(d.matches).toHaveLength(1)
    expect(d.matches[0].sessionId).toBe(ID1)
  })

  it('② 去连字符完整 uuid 命中（§3.3 盲区：与带连字符 id 不构成子串）', async () => {
    await writeSession(ID1, { firstUserText: '无关内容' })
    // 去连字符形态与 sessionId/path 均不构成精确子串，只能走归一化层
    const r = await find('019e6c96aaaabbbbcccc000000000001')
    const d = r.details as { matches: Array<{ sessionId: string }> }
    expect(d.matches).toHaveLength(1)
    expect(d.matches[0].sessionId).toBe(ID1)
  })

  it('③ F1 文案四要素 + 负向断言（无 recent 误导指引、无「真的没有」归因）', async () => {
    await writeSession(ID1, { firstUserText: '无关内容' })
    const r = await find('zzz-no-hit-9q8x')
    const text = r.content[0].text

    // 首行 + ①事实型自检行（根计数 / 候选集判定 / 归一化声明）
    expect(text).toContain('无匹配 session："zzz-no-hit-9q8x"')
    expect(text).toContain('自检（发现层，只陈述事实）')
    expect(text).toContain('[default]')
    expect(text).toContain('候选集非空（共 1 文件），根解析正常')
    expect(text).toContain('查询已做 uuid 归一化匹配（小写 + 去连字符）后仍无命中')
    // ②编辑距离候选段存在
    expect(text).toContain('最接近的候选（编辑距离）')
    // ③「正确做法」四条
    expect(text).toContain('正确做法')
    expect(text).toContain('改用标题/keyword')
    expect(text).toContain('直接传绝对路径')
    expect(text).toContain('更短前缀')
    expect(text).toContain('action:"doctor"')
    // ④最后一行封死 shell 绕行
    expect(text).toContain('不要用 shell find/ls/rg 搜 session 目录，不要 cat/read 原始 .jsonl')
    // 负向：无「recent 看全量」误导、无归因断言
    expect(text).not.toContain('recent')
    expect(text).not.toContain('真的没有')
    // details 程序化契约保持（零匹配形态不变）
    expect(r.details).toEqual({ matches: [], truncated: false })
  })

  it('④ 编辑距离 top-3：近似 id 入选（标注 source 与差异位），远 id 被挤出', async () => {
    const near1 = '019aaabc-0000-7000-8000-00000000000a'
    const near2 = '019aaabc-0000-7000-8000-00000000000b'
    const near3 = '019aaabc-0000-7000-8000-00000000000c'
    const far = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    await writeSession(near1)
    await writeSession(near2)
    await writeSession(near3, { subagent: true })
    await writeSession(far)
    // 手算锚点：query 与 near* 前 33 字符相同，第 34 位起 z→0/z→0/z→a，距离 3
    expect(levenshtein('019aaabc-0000-7000-8000-000000000zzz', near1)).toBe(3)
    expect(levenshtein('kitten', 'sitting')).toBe(3)

    const r = await find('019aaabc-0000-7000-8000-000000000zzz')
    const text = r.content[0].text
    // top-3 恰为三个近似候选（far 距离约 36，第 4 名被上限挤掉）
    expect(text).toContain(near1)
    expect(text).toContain(near2)
    expect(text).toContain(near3)
    expect(text).not.toContain(far)
    // 差异位标注（首个差异字符，1-based）
    expect(text).toContain('差异在第 34 位：z → 0')
    // source 标注：near3 在 subagent 根，标注透传
    expect(text).toContain(`${near3}  subagent`)
  })

  it('⑤ §11.5 归一化对比基线：增量仅限大小写/连字符变体，非 uuid 乱串不被 norm 误吸', async () => {
    const idHit = '019cafe0-1234-7000-8000-deadbeef0001'
    await writeSession(idHit, { firstUserText: '福耀玻璃深度研究' })
    await writeSession(ID2, { firstUserText: '完全不同的另一个会话' })

    // 现状基线：精确小写片段命中 1
    const base = await find('019cafe0')
    expect((base.details as { matches: unknown[] }).matches).toHaveLength(1)
    // 大写变体：增量 = 同一 id（大小写变体），无新对象
    const upper = await find('019CAFE0')
    expect((upper.details as { matches: Array<{ sessionId: string }> }).matches.map((m) => m.sessionId)).toEqual([idHit])
    // 去连字符变体：增量 = 同一 id（连字符变体），无新对象
    const noDash = await find('019cafe0123470008000deadbeef0001')
    expect((noDash.details as { matches: Array<{ sessionId: string }> }).matches.map((m) => m.sessionId)).toEqual([idHit])
    // 'deadbeef' 段是带连字符 id 的连续子串——现状精确匹配已命中，norm 后命中数不变（无增量）
    const deadbeef = await find('deadbeef')
    expect((deadbeef.details as { matches: Array<{ sessionId: string }> }).matches.map((m) => m.sessionId)).toEqual([idHit])
    // keyword 路径不受 norm 影响（非 uuid 特征照常回退首消息）
    const kw = await find('福耀玻璃')
    expect((kw.details as { matches: Array<{ sessionId: string }> }).matches.map((m) => m.sessionId)).toEqual([idHit])
    // 非 uuid 乱串：0 命中（norm 不把乱串吸进 uuid 匹配）
    const junk = await find('zzznotexist9q')
    expect((junk.details as { matches: unknown[] }).matches).toHaveLength(0)
    // hex 乱串（uuid 特征但非任何 id 子串）：两级均 0 → 短路不回退（与现状一致，无召回回归）
    const hexJunk = await find('0123456789abcdef')
    expect((hexJunk.details as { matches: unknown[] }).matches).toHaveLength(0)
  })

  it('⑥ 自检行计数 = 本次实扫结果 + 去重根注记', async () => {
    const agentDir = join(tmp, 'agent')
    // 根扫描无缓存（doctor 缓存机已删，ext-simplify-04 U3）——doctor 首跑后落盘的
    // 文件，find 自检行照实扫计数（原 PS-14「doctor 缓存 0 文件」形态结构性不存在）
    await mkdir(join(agentDir, 'sessions'), { recursive: true })
    await handleSessionRead({ action: 'doctor' }, { agentDir })
    // 之后 session 落盘（main 2 + subagent 1）
    await writeSession(ID1)
    await writeSession(ID2)
    await writeSession('019e6c96-aaaa-bbbb-cccc-000000000003', { subagent: true })

    const r = await handleSessionRead(
      { action: 'find', query: 'zzz-no-hit-9q8x' },
      { agentDir },
    )
    const text = r.content[0].text
    expect(text).toContain(`${join(agentDir, 'sessions')}：2 文件`)
    expect(text).toContain(`${join(agentDir, 'subagents')}：1 文件`)
    expect(text).toContain('候选集非空（共 3 文件）')

    // 完整信号包（live 与 default 同路径）→ 去重根注记，不重复计数
    const deduped = await handleSessionRead(
      { action: 'find', query: 'zzz-no-hit-9q8x' },
      { agentDir, liveSessionDir: join(agentDir, 'sessions') },
    )
    expect(deduped.content[0].text).toContain('同路径，已去重')
    expect(deduped.content[0].text).toContain('候选集非空（共 3 文件）')
  })
})

// ============================================================
// 片段解析接通 [live] 根（同一 roots 契约）：resolveByFragment/doXxx 透传
// liveSessionDir——[live]≠[default] 环境（纯 pi + 显式 --session-dir）下，find
// 能列出的 session 在 outline/result 等解析路径同样可达；F1 自检行含 [live] 根行。
// 全部 mkdtemp fixture 自建自删，不触碰真实数据目录。
// ============================================================

describe('片段解析接通 [live] 根（fixture，同一 roots 契约）', () => {
  let tmp: string
  const SLUG = '--live-cwd--'
  const ID = '019e6c96-aaaa-bbbb-cccc-0000000000aa'
  const FRAGMENT = '0000000000aa'
  let agentDir: string
  /** liveSessionDir 信号（encodeCwd 形态，normalizeLiveSessionDir 剥层到 sessions/ 根）。 */
  let liveDir: string
  /** 剥层后的 [live] 根路径（F1 自检行的显示形态）。 */
  let liveRoot: string

  /** 在指定目录写 session 文件（header + user 消息，extraLines 追加 assistant 等条目）。 */
  async function writeSessionAt(dir: string, id: string, extraLines: string[] = []): Promise<void> {
    await mkdir(dir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', id, cwd: '/demo' }),
      JSON.stringify({
        type: 'message',
        id: `${id}-m1`,
        parentId: id,
        message: { role: 'user', content: [{ type: 'text', text: 'live 根里的会话' }] },
      }),
      ...extraLines,
    ]
    await writeFile(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tool-handler-live-'))
    agentDir = join(tmp, 'agent')
    await mkdir(join(agentDir, 'sessions'), { recursive: true }) // [default] 空根
    liveDir = join(tmp, 'pi-live', 'sessions', SLUG)
    liveRoot = join(tmp, 'pi-live', 'sessions')
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('① [live]≠[default]：outline 片段解析到 [live] 根 session；不传信号则 F1（负向对照）', async () => {
    await writeSessionAt(liveDir, ID)
    // 接通后：片段解析可达 [live] 根，outline 正常产出
    const r = await handleSessionRead(
      { action: 'outline', session: FRAGMENT },
      { agentDir, liveSessionDir: liveDir },
    )
    const d = r.details as { stats: { totalTurns: number } }
    expect(d.stats.totalTurns).toBeGreaterThanOrEqual(1)
    // 负向对照：不传 liveSessionDir（三根降级）→ 同一片段 F1 零匹配
    //（[default]/[legacy]/[subagent] 均无此文件——证明命中确实来自 [live] 根）
    await expect(
      handleSessionRead({ action: 'outline', session: FRAGMENT }, { agentDir }),
    ).rejects.toThrow(/无匹配 session/)
  })

  it('② F1 自检行含 [live] 根行（剥层路径 + 实扫计数），与 [default] 空根同表可见', async () => {
    await writeSessionAt(liveDir, ID)
    const caught = await handleSessionRead(
      { action: 'outline', session: 'zzz-no-hit-9q8x' },
      { agentDir, liveSessionDir: liveDir },
    ).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(Error)
    const text = (caught as Error).message
    expect(text).toContain('无匹配 session："zzz-no-hit-9q8x"')
    expect(text).toContain('自检（发现层，只陈述事实）')
    // [live] 根行：encodeCwd 已剥层到 sessions/ 根，计数 = 本次实扫
    expect(text).toContain(`${liveRoot}：1 文件`)
    // [default] 空根同表可见（同一 roots 契约的全貌）
    expect(text).toContain(`${join(agentDir, 'sessions')}：0 文件`)
  })

  it('③ result 片段形态同样可达 [live] 根（per-call deps 接线）', async () => {
    await writeSessionAt(liveDir, ID, [
      JSON.stringify({
        type: 'message',
        id: `${ID}-a1`,
        parentId: `${ID}-m1`,
        message: { role: 'assistant', content: [{ type: 'text', text: '最终结论正文' }] },
      }),
    ])
    const r = await handleSessionRead(
      { action: 'result', session: FRAGMENT },
      { agentDir, liveSessionDir: liveDir },
    )
    expect(r.content[0].text).toContain('最终结论正文')
  })
})

// ============================================================
// u10：find 分组输出（design 2026-09-10 §5.1 形态 / §6.7 子决策 2/3 / §8.2 回归基线）
// ============================================================

describe('u10 find 分组输出（fixture，§6.7 子决策 2/3 + §8.2 回归基线）', () => {
  let tmp: string
  const SLUG = '--demo-cwd--'
  // uuidv7 同毫秒时间前缀碰撞是现网「34 条 subagent」形态的成因（§3.4），fixture 沿用共享前缀
  const PREFIX = '019e6c96'
  const mainId = (n: number) => `${PREFIX}-aaaa-bbbb-cccc-d${String(n).padStart(11, '0')}`
  const subId = (n: number) => `${PREFIX}-aaaa-bbbb-cccc-e${String(n).padStart(11, '0')}`

  /** 写 session 文件（subagent:true 写入 subagent 根），形态同 u9 段 writeSession。 */
  async function writeSession(
    id: string,
    opts?: { subagent?: boolean; firstUserText?: string },
  ): Promise<void> {
    const dir = opts?.subagent
      ? join(tmp, 'agent', 'subagents', SLUG, 'sessions')
      : join(tmp, 'agent', 'sessions', SLUG)
    await mkdir(dir, { recursive: true })
    const lines = [JSON.stringify({ type: 'session', id, cwd: '/demo' })]
    if (opts?.firstUserText !== undefined) {
      lines.push(
        JSON.stringify({
          type: 'message',
          id: `${id}-m1`,
          message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
        }),
      )
    }
    await writeFile(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
  }

  /**
   * 写带 assistant 正文的 subagent（manifest + session 文件三行形态），
   * 供 result action 批量调用（回归基线：批量头行 8 字符短 id 不受 u10 影响）。
   */
  async function writeSubagentWithResult(saId: string, id: string, body: string): Promise<void> {
    const sessionFile = join(tmp, 'agent', 'subagents', SLUG, 'sessions', `${id}.jsonl`)
    await mkdir(dirname(sessionFile), { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', id, cwd: '/demo' }),
      JSON.stringify({
        type: 'message',
        id: `${id}-m1`,
        message: { role: 'user', content: [{ type: 'text', text: 'task' }] },
      }),
      JSON.stringify({
        type: 'message',
        id: `${id}-a1`,
        message: { role: 'assistant', content: [{ type: 'text', text: body }] },
      }),
    ]
    await writeFile(sessionFile, lines.join('\n') + '\n')
    const recordsDir = join(tmp, 'agent', 'subagents', SLUG, 'records')
    await mkdir(recordsDir, { recursive: true })
    await writeFile(
      join(recordsDir, `${saId}.json`),
      JSON.stringify({ id: saId, rootSessionId: 'root-u10', agentName: 'explorer', sessionFile }),
    )
  }

  function find(
    query: string,
    extra?: Partial<SessionReadParams>,
  ): ReturnType<typeof handleSessionRead> {
    return handleSessionRead({ action: 'find', query, ...extra }, { agentDir: join(tmp, 'agent') })
  }

  interface FindDetails {
    matches: Array<{ source: string; sessionId: string }>
    truncated: boolean
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tool-handler-u10-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('① main 置顶 + 全 id + ↳ 可复制调用串 + 编号跨组连续（§5.1 全列出形态）', async () => {
    const M1 = mainId(1)
    const S1 = subId(1)
    const S2 = subId(2)
    await writeSession(M1, { firstUserText: 'main content' })
    await writeSession(S1, { subagent: true, firstUserText: 'sub content one' })
    await writeSession(S2, { subagent: true, firstUserText: 'sub content two' })

    const r = await find(PREFIX)
    const text = r.content[0].text
    // main 段置顶：main 组头与 main id 均先于 subagent 出现
    expect(text.indexOf('main（')).toBeLessThan(text.indexOf('subagent（'))
    expect(text.indexOf(M1)).toBeLessThan(text.indexOf(S1))
    expect(text).toContain('main（1 条命中）：')
    expect(text).toContain('subagent（2 条命中）：')
    // 全 id：36 字符完整出现，8 字符截断形态消失（§6.7 子决策 3）
    expect(text).toContain(M1)
    expect(text).not.toContain(`${M1.slice(0, 8)}…`)
    // ↳ 可复制调用串只附 main 候选（subagent 噪声不配指针）
    expect(text).toContain(`↳ session_read { action:"outline", session:"${M1}" }`)
    expect(text).not.toContain(`session:"${S1}"`)
    // 编号跨组连续：main 是 1 号，subagent 段续 2 号（组内 mtime 序不固定，用正则）
    expect(text).toContain(`  1. ${M1}`)
    expect(text).toMatch(/  2\. 019e6c96-aaaa-bbbb-cccc-e0000000000[12]/)
    // details 合并列表：main 首位、集合完整、无截断
    const d = r.details as FindDetails
    expect(d.truncated).toBe(false)
    expect(d.matches[0]).toMatchObject({ source: 'main', sessionId: M1 })
    expect(new Set(d.matches.map((m) => m.sessionId))).toEqual(new Set([M1, S1, S2]))
  })

  it('② subagent 超剩余配额 → 折叠计数行 + 加 source:"subagent" 提示（§6.7 子决策 2）', async () => {
    const M1 = mainId(1)
    await writeSession(M1)
    for (let i = 1; i <= 3; i++) await writeSession(subId(i), { subagent: true })

    // limit 2：main 1 条（无溢出）→ 剩余配额 1 → subagent 展示 1 条 + 溢出折叠
    const r = await find(PREFIX, { limit: 2 })
    const text = r.content[0].text
    expect(text).toContain('main（1 条命中）：')
    expect(text).toContain('subagent（>1 条命中，显示前 1 条）：')
    expect(text).toContain('… 另有 subagent 命中未显示。👉 加 source:"subagent" 查看')
    const d = r.details as FindDetails
    expect(d.truncated).toBe(true)
    expect(d.matches).toHaveLength(2)
    expect(d.matches[0].source).toBe('main')
    expect(d.matches.filter((m) => m.source === 'subagent')).toHaveLength(1)
  })

  it('③ main 命中占满 limit → subagent 段 0 条仅显示计数（§6.7：main 优先占满）', async () => {
    for (let i = 1; i <= 3; i++) await writeSession(mainId(i))
    for (let i = 1; i <= 2; i++) await writeSession(subId(i), { subagent: true })

    const r = await find(PREFIX, { limit: 3 })
    const text = r.content[0].text
    expect(text).toContain('main（3 条命中）：')
    expect(text).toContain('subagent（有命中未显示——展示配额已被 main 占满）：')
    expect(text).toContain('👉 加 source:"subagent" 查看')
    // subagent 条目与调用串不出现（0 条展示）
    expect(text).not.toContain(subId(1))
    const d = r.details as FindDetails
    expect(d.matches).toHaveLength(3)
    expect(d.matches.every((m) => m.source === 'main')).toBe(true)
    // 合并总量：命中 3 main + 2 sub > 展示 3 → truncated=true
    expect(d.truncated).toBe(true)
  })

  it('④ truncated 按合并总量计算（命中总数 vs 实际输出数，含 main 恰满边界）', async () => {
    for (let i = 1; i <= 2; i++) await writeSession(mainId(i))
    for (let i = 1; i <= 2; i++) await writeSession(subId(i), { subagent: true })

    // a) 全列出（4 ≤ 20）：truncated=false
    const all = (await find(PREFIX)).details as FindDetails
    expect(all.matches).toHaveLength(4)
    expect(all.truncated).toBe(false)

    // b) main 恰好占满 limit（2/2）+ subagent 有命中 → 仍截断（防 main 恰满漏探测 subagent）
    const exact = (await find(PREFIX, { limit: 2 })).details as FindDetails
    expect(exact.matches).toHaveLength(2)
    expect(exact.matches.every((m) => m.source === 'main')).toBe(true)
    expect(exact.truncated).toBe(true)

    // c) 混合截断：展示 3（2 main + 1 sub）< 命中 4 → truncated=true
    const mixed = (await find(PREFIX, { limit: 3 })).details as FindDetails
    expect(mixed.matches).toHaveLength(3)
    expect(mixed.matches.filter((m) => m.source === 'main')).toHaveLength(2)
    expect(mixed.matches.filter((m) => m.source === 'subagent')).toHaveLength(1)
    expect(mixed.truncated).toBe(true)
  })

  it('⑤a 回归基线：find{query:<前缀>, limit:100} main 0 条 + subagent 全列（现网 34 条形态）', async () => {
    for (let i = 1; i <= 34; i++) await writeSession(subId(i), { subagent: true })

    const r = await find(PREFIX, { limit: 100 })
    const d = r.details as FindDetails
    expect(d.matches).toHaveLength(34)
    expect(d.matches.every((m) => m.source === 'subagent')).toBe(true)
    expect(d.truncated).toBe(false)
    const text = r.content[0].text
    // main 段 0 条可辨识（防「全是 subagent」被误读），subagent 段全列不折叠
    expect(text).toContain('main（0 条命中）：')
    expect(text).toContain('subagent（34 条命中）：')
    expect(text).not.toContain('加 source:"subagent"')
  })

  it('⑤b 回归基线：result 批量头行仍 8 字符短 id（SESSION_ID_PREFIX_LEN 通路不动）', async () => {
    const R1 = `${PREFIX}-aaaa-bbbb-cccc-f00000000001`
    const R2 = `${PREFIX}-aaaa-bbbb-cccc-f00000000002`
    await writeSubagentWithResult('sa-u10-r1', R1, 'alpha body')
    await writeSubagentWithResult('sa-u10-r2', R2, 'beta body')

    const res = await handleSessionRead(
      { action: 'result', session: 'sa-u10-r1,sa-u10-r2' },
      { agentDir: join(tmp, 'agent') },
    )
    const text = res.content[0].text
    expect(text).toContain(`(session ${R1.slice(0, 8)}…)`)
    expect(text).toContain(`(session ${R2.slice(0, 8)}…)`)
  })

  it('⑤c 回归基线：recent 查询 main 段置顶可辨识', async () => {
    for (let i = 1; i <= 2; i++) await writeSession(mainId(i))
    for (let i = 1; i <= 2; i++) await writeSession(subId(i), { subagent: true })

    const r = await find('recent')
    const text = r.content[0].text
    expect(text.indexOf('main（2 条命中）：')).toBeLessThan(text.indexOf('subagent（2 条命中）：'))
    const d = r.details as FindDetails
    expect(d.matches).toHaveLength(4)
    // 分组价值：main/subagent 的 mtime 交错也被 main 段置顶（§8.2「main 段置顶后可辨识」）
    expect(d.matches.slice(0, 2).every((m) => m.source === 'main')).toBe(true)
    expect(d.truncated).toBe(false)
  })

  it('⑥ resolveByFragment 独立无分组语义：outline 片段多匹配 → F2 全量候选（不被配额截断）', async () => {
    for (let i = 1; i <= 2; i++) await writeSession(mainId(i))
    for (let i = 1; i <= 3; i++) await writeSession(subId(i), { subagent: true })

    // 解析路径（resolveByFragment → findSessions limit:10 无 source）保持 mtime 排序 +
    // limit 截断原语义：5 命中全进 F2 消歧候选，无 main 置顶/配额分组介入（§6.7 末条）
    const r = await handleSessionRead({ action: 'outline', session: PREFIX }, { agentDir: join(tmp, 'agent') })
    const d = r.details as { ambiguous: boolean; candidates: Array<{ sessionId: string }> }
    expect(d.ambiguous).toBe(true)
    expect(d.candidates).toHaveLength(5)
    expect(new Set(d.candidates.map((c) => c.sessionId))).toEqual(
      new Set([mainId(1), mainId(2), subId(1), subId(2), subId(3)]),
    )
  })

  it('⑥b 显式 source 查询走单组原语义：不折叠、保持 mtime+limit 截断', async () => {
    for (let i = 1; i <= 3; i++) await writeSession(subId(i), { subagent: true })

    // 显式 source 本身就是折叠提示所指的展开动作，不再折叠
    const r = await find(PREFIX, { source: 'subagent', limit: 1 })
    const text = r.content[0].text
    expect(text).toContain('subagent（1 条命中）：')
    expect(text).not.toContain('加 source:"subagent"')
    const d = r.details as FindDetails
    expect(d.matches).toHaveLength(1)
    expect(d.matches[0].source).toBe('subagent')
    expect(d.truncated).toBe(true)
  })
})

// ============================================================
// E1：find 单次根解析（ext-simplify-04 U2，探针 P1）。spy 打在 roots 模块命名空间
// 上跨模块拦截（find.ts / findNoMatch 渲染链的消费点全走同一入口），断言 doFind
// 全路径（分组 / 显式 source / 零匹配）resolveSessionRoots 恰调用 1 次——改前分组
// 2 次、零匹配 3 次（impl-plan D-15④ 登记的分组双倍实扫债），预解析根复用后恒 1 次。
// ============================================================
describe('E1 find 单次根解析（探针 P1：resolveSessionRoots 恰 1 次）', () => {
  let tmp: string
  const SLUG = '--e1-cwd--'
  const PREFIX = '019e7e10'
  const mainId = (n: number) => `${PREFIX}-aaaa-bbbb-cccc-d${String(n).padStart(11, '0')}`
  const subId = (n: number) => `${PREFIX}-aaaa-bbbb-cccc-e${String(n).padStart(11, '0')}`

  /** 写 session 文件（subagent:true 写入 subagent 根），形态同 u10 段 writeSession。 */
  async function writeSession(id: string, opts?: { subagent?: boolean }): Promise<void> {
    const dir = opts?.subagent
      ? join(tmp, 'agent', 'subagents', SLUG, 'sessions')
      : join(tmp, 'agent', 'sessions', SLUG)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${id}.jsonl`),
      JSON.stringify({ type: 'session', id, cwd: '/e1' }) + '\n',
    )
  }

  function find(
    query: string,
    extra?: Partial<SessionReadParams>,
  ): ReturnType<typeof handleSessionRead> {
    return handleSessionRead({ action: 'find', query, ...extra }, { agentDir: join(tmp, 'agent') })
  }

  /** spy 计数器 + 断言 helper：包装一段 find 调用，返回 { 结果, 调用次数 }。 */
  async function findCounting(
    query: string,
    extra?: Partial<SessionReadParams>,
  ): Promise<{ result: Awaited<ReturnType<typeof handleSessionRead>>; resolveCalls: number }> {
    const rootsModule = await import('../discovery/roots.js')
    const spy = vi.spyOn(rootsModule, 'resolveSessionRoots')
    try {
      const result = await find(query, extra)
      return { result, resolveCalls: spy.mock.calls.length }
    } finally {
      spy.mockRestore()
    }
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tool-handler-e1-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('① 分组路径（main + subagent 两段查询，有命中）：恰 1 次', async () => {
    await writeSession(mainId(1))
    await writeSession(subId(1), { subagent: true })
    const { result, resolveCalls } = await findCounting(PREFIX)
    const d = result.details as { matches: Array<{ source: string }>; truncated: boolean }
    // 前置：两段确实各自命中（分组语义不变），再断言扫描收敛
    expect(d.matches).toHaveLength(2)
    expect(new Set(d.matches.map((m) => m.source))).toEqual(new Set(['main', 'subagent']))
    expect(d.truncated).toBe(false)
    expect(resolveCalls).toBe(1)
  })

  it('② 显式 source 路径（单组查询，有命中）：恰 1 次', async () => {
    await writeSession(mainId(1))
    await writeSession(subId(1), { subagent: true })
    const { result, resolveCalls } = await findCounting(PREFIX, { source: 'subagent' })
    const d = result.details as { matches: Array<{ source: string }> }
    expect(d.matches).toHaveLength(1)
    expect(d.matches[0].source).toBe('subagent')
    expect(resolveCalls).toBe(1)
  })

  it('③ 分组零匹配 → F1 自检行：恰 1 次（改前 3 次）且根表仍进渲染', async () => {
    await writeSession(mainId(1))
    const { result, resolveCalls } = await findCounting('zzz-e1-no-hit-9q8x')
    const d = result.details as { matches: unknown[]; truncated: boolean }
    expect(d.matches).toEqual([])
    expect(d.truncated).toBe(false)
    // F1 自检行消费预解析根表（非空根计数可见 = roots 确实传入而非空列表）
    expect(result.content[0].text).toContain('自检（发现层，只陈述事实）')
    expect(result.content[0].text).toContain('候选集非空')
    expect(resolveCalls).toBe(1)
  })

  it('④ 显式 source 零匹配 → F1 自检行：恰 1 次（改前 2 次）', async () => {
    await writeSession(subId(1), { subagent: true })
    const { result, resolveCalls } = await findCounting('zzz-e1-no-hit-9q8x', { source: 'main' })
    expect(result.content[0].text).toContain('无匹配 session')
    expect(result.content[0].text).toContain('自检（发现层，只陈述事实）')
    expect(resolveCalls).toBe(1)
  })
})

// ============================================================
// u11：metadataProvider 注入 + TTL 缓存（design 2026-09-10 §6.6）
// handler 级集成：注入包装（metadata 缓存独立实例——根扫描无缓存，doctor 缓存机
// 已删除，ext-simplify-04 U3，不存在串扰面）
// + 标题渲染（§5.1 候选行标题优先）+ provider 抛错降级不外抛。
// 策略①惰性/②窄化/合并语义在 find.test.ts u11 段覆盖。
// ============================================================
describe('u11 metadataProvider 注入 + TTL 缓存（fixture，§6.6）', () => {
  let tmp: string
  /** 平铺 main 根（xyz-agent 形态），同时作 liveSessionDir（与 [default] 根同字面路径） */
  let flatMain: string

  async function writeSession(
    id: string,
    opts?: { firstUserText?: string },
  ): Promise<string> {
    await mkdir(flatMain, { recursive: true })
    const lines = [JSON.stringify({ type: 'session', id, cwd: '/demo' })]
    if (opts?.firstUserText !== undefined) {
      lines.push(
        JSON.stringify({
          type: 'message',
          id: `${id}-m1`,
          message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
        }),
      )
    }
    const path = join(flatMain, `${id}.jsonl`)
    await writeFile(path, lines.join('\n') + '\n')
    return path
  }

  function findWithProvider(
    query: string,
    provider: SessionMetadataProvider,
  ): ReturnType<typeof handleSessionRead> {
    return handleSessionRead(
      { action: 'find', query },
      { agentDir: join(tmp, 'agent'), liveSessionDir: flatMain },
      undefined,
      provider,
    )
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tool-handler-u11-'))
    flatMain = join(tmp, 'agent', 'sessions')
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('② 标题进匹配与渲染：keyword 命中 name → 候选行标题优先展示 + details.matches[].name 透传', async () => {
    const id = 'm-title-0001'
    const p = await writeSession(id, { firstUserText: '首消息无关' })
    const provider = vi.fn(async (dir: string) =>
      dir === flatMain
        ? [
            {
              path: p,
              id,
              cwd: '/demo',
              name: '太保寿险深度研究攻坚',
              modified: new Date(),
              firstMessage: '首消息无关',
            },
          ]
        : [],
    )
    const r = await findWithProvider('太保寿险', provider)
    const text = r.content[0].text
    // §5.1 形态：候选行末段为标题（name 优先于首消息预览）
    expect(text).toContain('太保寿险深度研究攻坚')
    const d = r.details as { matches: Array<{ sessionId: string; name?: string }> }
    expect(d.matches[0].sessionId).toBe(id)
    expect(d.matches[0].name).toBe('太保寿险深度研究攻坚')
    // 注入边界生效：provider 被 TTL 包装调用且实参非空串
    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider.mock.calls[0][0]).toBe(flatMain)
  })

  it('④ provider 抛错 → handler 不抛，降级首条 user 匹配（标题留空，错误不外泄）', async () => {
    const id = 'err-handler-01'
    await writeSession(id, { firstUserText: 'handler 降级命中文本' })
    const provider = vi.fn(async () => {
      throw new Error('listAll secret boom')
    })
    const r = await findWithProvider('handler 降级命中', provider)
    const d = r.details as { matches: Array<{ sessionId: string; name?: string }> }
    expect(d.matches).toHaveLength(1)
    expect(d.matches[0].sessionId).toBe(id)
    expect(d.matches[0].name).toBeUndefined()
    // 错误细节不进工具输出（降级不是错误）
    expect(r.content[0].text).not.toContain('boom')
  })

  it('⑤ TTL 缓存（fake timers）：TTL 内不重调、过期重调、目录 mtime 变化失效', async () => {
    const id = 'ttl-00000001'
    const p = await writeSession(id, { firstUserText: '无关' })
    const provider = vi.fn(async (dir: string) =>
      dir === flatMain
        ? [{ path: p, id, cwd: '/demo', name: '标题', modified: new Date() }]
        : [],
    )
    // 仅 fake Date（缓存 TTL 判定用），fs/performance 走真实实现
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // 首查：cache miss → 调 1 次
      await findWithProvider('zzznohit9q', provider)
      expect(provider).toHaveBeenCalledTimes(1)
      // TTL 内二查：命中缓存不重调
      await findWithProvider('zzznohit9q', provider)
      expect(provider).toHaveBeenCalledTimes(1)
      // TTL 过期 → 重调
      vi.setSystemTime(Date.now() + METADATA_CACHE_TTL_MS + 1)
      await findWithProvider('zzznohit9q', provider)
      expect(provider).toHaveBeenCalledTimes(2)
      // TTL 内但目录 mtime 变化 → 失效重调
      const bumped = new Date(Date.now() + 60_000)
      await utimes(flatMain, bumped, bumped)
      await findWithProvider('zzznohit9q', provider)
      expect(provider).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// u12 跨会话内容检索（fixture，§2 目标 5 / §8.2 V8：窄化前置 + 字节上限 + 渲染）
// 全部 mkdtemp fixture 自建自删，不触碰真实数据目录。
// ---------------------------------------------------------------------------

describe('u12 跨会话内容检索（fixture，V8）', () => {
  let tmp: string
  /** main 根（平铺，[default] 根直扫）与 subagent 根 */
  let mainDir: string
  const SLUG = '--demo-cwd--'
  // uuidv7 风格形态（find 输出的完整 id 即此形态；u12 索引按 header id，不依赖文件名反推）
  const mainId = (n: number) => `019e6c96-aaaa-bbbb-cccc-d${String(n).padStart(11, '0')}`
  const subId = (n: number) => `019e6c96-aaaa-bbbb-cccc-e${String(n).padStart(11, '0')}`

  /**
   * 写多 turn session（链式 parentId——buildTreeView leaf 回溯需要，无链的后行 entry
   * 会被当旁支过滤，MF-5 段同款教训）。turn 分段：user 开新 turn，assistant 并入当前。
   */
  async function writeSession(
    id: string,
    turns: Array<{ role: 'user' | 'assistant'; text: string }>,
    opts?: { subagent?: boolean },
  ): Promise<void> {
    const dir = opts?.subagent
      ? join(tmp, 'agent', 'subagents', SLUG, 'sessions')
      : join(tmp, 'agent', 'sessions')
    await mkdir(dir, { recursive: true })
    const lines = [JSON.stringify({ type: 'session', id, cwd: '/demo' })]
    turns.forEach((t, i) => {
      lines.push(
        JSON.stringify({
          type: 'message',
          id: `${id}-m${i}`,
          parentId: i === 0 ? id : `${id}-m${i - 1}`,
          message: { role: t.role, content: [{ type: 'text', text: t.text }] },
        }),
      )
    })
    await writeFile(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
  }

  /** 造大文件：追加一条 2KB filler 文本（字节上限用例用，pattern 避开 filler 字符）。 */
  async function writeFatSession(id: string): Promise<void> {
    await writeSession(id, [
      { role: 'user', text: `filler ${'x'.repeat(2048)}` },
      { role: 'assistant', text: 'done' },
    ])
  }

  interface CrossDetails {
    rejected?: boolean
    candidateCount?: number
    pattern: string
    scope: string
    degraded: boolean
    byteBudget: number
    scannedBytes: number
    scanned: Array<{
      sessionId: string
      source: string
      name?: string
      hits: Array<{ turnIndex: number; entryIndex: number; role: string; matchSnippet: string }>
      hitsTotal?: number
    }>
    skipped: Array<{ sessionId: string; reason: string; sizeBytes?: number }>
    truncated: boolean
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tool-handler-u12-'))
    mainDir = join(tmp, 'agent', 'sessions')
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('① 窄化拒绝：候选超上限 → 拒绝文案 + 先 find 指引，不深扫（V8）', async () => {
    // 库中放一个真实可命中的 session——拒绝路径不得把它扫出来
    await writeSession(mainId(1), [
      { role: 'user', text: '讨论 adj_factor 的历史数据' },
      { role: 'assistant', text: 'adj_factor 表在 dws 库' },
    ])
    const ids = Array.from({ length: MULTI_SEARCH_MAX_SESSIONS + 1 }, (_, i) => mainId(i + 10))
    const r = await handleSessionRead(
      { action: 'search', session: ids.join(','), pattern: 'adj_factor' },
      { agentDir: join(tmp, 'agent') },
    )
    const text = r.content[0].text
    expect(text).toContain('跨会话检索已拒绝')
    expect(text).toContain(`超出单次上限 ${MULTI_SEARCH_MAX_SESSIONS} 个`)
    expect(text).toContain('先窄化')
    expect(text).toContain('action:"find"')
    expect(text).toContain('action:"search", session:"<id1>,<id2>"')
    const d = r.details as Partial<CrossDetails>
    expect(d.rejected).toBe(true)
    expect(d.candidateCount).toBe(MULTI_SEARCH_MAX_SESSIONS + 1)
    // 不深扫：可命中内容与命中结构都不出现
    expect(text).not.toContain('adj_factor 表在 dws 库')
    expect(text).not.toContain('hits:')
    expect(d.scanned).toBeUndefined()
  })

  it('②a 字节上限截断：预算按序消耗，放不下的文件起整段停止并报告已扫范围', async () => {
    const A = mainId(1)
    const B = mainId(2)
    await writeSession(A, [
      { role: 'user', text: 'small session' },
      { role: 'assistant', text: 'ok' },
    ])
    await writeFatSession(B)
    // 直接调导出函数注入小预算（工具路径走默认 64MB，fixture 不构造 64MB 文件）
    const r = await searchAcrossSessions([A, B], 'zzzkw', { agentDir: join(tmp, 'agent') }, {
      byteBudget: 1024,
    })
    const d = r.details as CrossDetails
    // A 扫完（无命中也入 scanned），B 放不下 → byte-budget，且其 sizeBytes 有报告
    expect(d.scanned).toHaveLength(1)
    expect(d.scanned[0].sessionId).toBe(A)
    expect(d.scannedBytes).toBeGreaterThan(0)
    expect(d.scannedBytes).toBeLessThanOrEqual(1024)
    expect(d.skipped).toHaveLength(1)
    expect(d.skipped[0]).toMatchObject({ sessionId: B, reason: 'byte-budget' })
    expect(d.skipped[0].sizeBytes).toBeGreaterThan(1024)
    const text = r.content[0].text
    expect(text).toContain('not scanned')
    expect(text).toContain(B)
    expect(text).toContain(A)
    // 未扫 id 附单独检索指引
    expect(text).toContain(`action:"search", session:"${B}", pattern:"zzzkw"`)
  })

  it('②b 首个文件即超预算 → 0 扫描，整段未扫报告（不突破上限）', async () => {
    const B = mainId(2)
    await writeFatSession(B)
    const r = await searchAcrossSessions([B], 'zzzkw', { agentDir: join(tmp, 'agent') }, {
      byteBudget: 512,
    })
    const d = r.details as CrossDetails
    expect(d.scanned).toHaveLength(0)
    expect(d.scannedBytes).toBe(0)
    expect(d.skipped).toEqual([{ sessionId: B, reason: 'byte-budget', sizeBytes: expect.any(Number) }])
    expect(r.content[0].text).toContain('not scanned')
  })

  it('③ 命中渲染：session 列表（完整 id+source+标题）+ turn 索引/角色/片段 + 可执行调用串', async () => {
    const A = mainId(1)
    const B = subId(1)
    const C = mainId(2)
    // A：T000 两命中（user+assistant）+ T001 一命中（assistant）
    await writeSession(A, [
      { role: 'user', text: '查询 adj_factor 的历史数据' },
      { role: 'assistant', text: 'adj_factor 表在 dws 库' },
      { role: 'user', text: '换一个话题' },
      { role: 'assistant', text: '再看 adj_factor 的最新分区' },
    ])
    await writeSession(B, [
      { role: 'user', text: 'subagent task 无关键词' },
      { role: 'assistant', text: '结果里含 adj_factor 字样' },
    ], { subagent: true })
    await writeSession(C, [
      { role: 'user', text: '完全没有关键词的内容' },
    ])
    const provider: SessionMetadataProvider = async (dir) =>
      dir === mainDir
        ? [{ path: join(mainDir, `${A}.jsonl`), id: A, cwd: '/demo', name: '太保寿险深度研究', modified: new Date() }]
        : []
    const r = await handleSessionRead(
      { action: 'search', session: `${A},${B},${C}`, pattern: 'adj_factor' },
      { agentDir: join(tmp, 'agent'), liveSessionDir: mainDir },
      undefined,
      provider,
    )
    const text = r.content[0].text
    // header：命中/已扫计数 + 默认预算标注（handleSessionRead 路径走 SEARCH_SCAN_BYTE_BUDGET，
    // formatScanBytes 的 MB 形态恒 1 位小数）
    expect(text).toContain('2/3 session(s) hit for /adj_factor/')
    expect(text).toContain(`${(SEARCH_SCAN_BYTE_BUDGET / (1024 * 1024)).toFixed(1)}MB budget`)
    // 命中块：完整 id + source + 标题（provider 注入）+ 命中数，列表序 = 传入序
    expect(text).toContain(`1. ${A} · main · 太保寿险深度研究（3 hits）`)
    expect(text).toContain(`2. ${B} · subagent（1 hit）`)
    // turn 索引 + entry 序号 + 角色 + 片段
    expect(text).toContain('     T000 #0 user: ')
    expect(text).toContain('     T000 #1 assistant: ')
    expect(text).toContain('     T001 #1 assistant: ')
    // 可直接执行的调用串（真实参数 = pattern）
    expect(text).toContain(`↳ session_read { action:"search", session:"${A}", pattern:"adj_factor" }`)
    expect(text).toContain(`↳ session_read { action:"search", session:"${B}", pattern:"adj_factor" }`)
    // 已扫无命中段
    expect(text).toContain('scanned, no hit:')
    expect(text).toContain(`${C} · main`)
    const d = r.details as CrossDetails
    expect(d.rejected).toBeUndefined()
    expect(d.truncated).toBe(false)
    expect(d.degraded).toBe(false)
    expect(d.byteBudget).toBe(SEARCH_SCAN_BYTE_BUDGET)
    expect(d.skipped).toEqual([])
    expect(d.scanned.map((s) => s.sessionId)).toEqual([A, B, C])
    expect(d.scanned[0].hits).toHaveLength(3)
    expect(d.scanned[0].name).toBe('太保寿险深度研究')
    expect(d.scanned[1].hits).toHaveLength(1)
    // B 只有一条 user → 单 turn，assistant 命中在 T000 #1
    expect(d.scanned[1].hits[0]).toMatchObject({
      turnIndex: 0,
      entryIndex: 1,
      role: 'assistant',
    })
    expect(d.scanned[2].hits).toHaveLength(0)
  })

  it('④ 无命中形态 + not-found 报告（不在库中的 id 不中断整体）', async () => {
    const A = mainId(1)
    const GHOST = mainId(99)
    await writeSession(A, [{ role: 'user', text: '普通内容' }])
    const r = await handleSessionRead(
      { action: 'search', session: `${A},${GHOST}`, pattern: 'zzznothing' },
      { agentDir: join(tmp, 'agent') },
    )
    const text = r.content[0].text
    expect(text).toContain('0/1 session(s) hit for /zzznothing/')
    expect(text).toContain('scanned, no hit:')
    expect(text).toContain(`${A} · main`)
    expect(text).toContain('换更精确 pattern')
    expect(text).toContain('not found in library')
    expect(text).toContain(`- ${GHOST}`)
    const d = r.details as CrossDetails
    expect(d.scanned).toHaveLength(1)
    expect(d.scanned[0].hits).toHaveLength(0)
    expect(d.skipped).toEqual([{ sessionId: GHOST, reason: 'not-found' }])
  })

  it('⑤ 单会话语义无回归：无逗号 session 走原路径（hits 结构），pattern 含逗号不误分流', async () => {
    const A = mainId(1)
    await writeSession(A, [
      { role: 'user', text: 'aaa plugin 内容' },
      { role: 'assistant', text: 'bbb' },
    ])
    // 单 id：原 details.hits 结构与 header 形态不变
    const r = await handleSessionRead(
      { action: 'search', session: A, pattern: 'plugin' },
      { agentDir: join(tmp, 'agent') },
    )
    expect(r.content[0].text).toContain('1 hit(s) for /plugin/')
    const d = r.details as { hits: unknown[]; truncated: boolean; scanned?: unknown }
    expect(d.hits).toHaveLength(1)
    expect(d.truncated).toBe(false)
    expect(d.scanned).toBeUndefined()
    // pattern 含逗号不触发跨会话（分流只看 session）
    const r2 = await handleSessionRead(
      { action: 'search', session: A, pattern: 'aaa,bbb' },
      { agentDir: join(tmp, 'agent') },
    )
    expect((r2.details as { hits: unknown[] }).hits).toHaveLength(0)
    expect((r2.details as { scanned?: unknown }).scanned).toBeUndefined()
    expect(r2.content[0].text).not.toContain('session(s) hit')
  })

  it('⑥ per-session limit 截断：超限 session 标注 >N hits，truncated=true', async () => {
    const A = mainId(1)
    await writeSession(A, [
      { role: 'user', text: 'kw one' },
      { role: 'assistant', text: 'kw two' },
      { role: 'user', text: 'kw three' },
    ])
    const r = await searchAcrossSessions([A], 'kw', { agentDir: join(tmp, 'agent') }, { limit: 2 })
    const d = r.details as CrossDetails
    expect(d.truncated).toBe(true)
    expect(d.scanned[0].hits).toHaveLength(2)
    expect(d.scanned[0].hitsTotal).toBe(3)
    expect(r.content[0].text).toContain('（>3 hits, showing first 2）')
  })

  it('⑦ abort 信号透传：跨会话扫描中断抛错（与单会话 MF-5 语义一致）', async () => {
    const A = mainId(1)
    await writeSession(A, [{ role: 'user', text: 'content' }])
    const ac = new AbortController()
    ac.abort()
    await expect(
      searchAcrossSessions([A], 'kw', { agentDir: join(tmp, 'agent') }, { signal: ac.signal }),
    ).rejects.toThrow(/中断/)
  })
})
