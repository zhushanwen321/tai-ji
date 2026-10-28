import { extractSessionName, extractSessionOutcome, scanPiSessions, invalidateScanDirCache, _resetSessionMetaCacheForTest } from '../src/infra/pi/session-file-utils.js';
import type { IGitInfoReader } from '../src/services/ports/git-info.js';
import { type ISessionStore, ScannedSessionMeta } from '../src/services/ports/session.js';
import { expandHome, inferSourceType } from '../src/services/scanners/scanner-base.js';
import { createForkedSessionFile, resolveEntryIdByTimestamp } from '../src/services/session/session-fork.js';
import type { IScannerSessionOps } from '../src/services/session/session-internal.js';
import { SessionScanner } from '../src/services/session/session-scanner.js';
import { READ_TAIL_BYTES, parseJsonl, parseJsonlWarnOnMalformed, readTailEntries } from '../src/utils/jsonl.js';
import { _resetWarnOnceForTest } from '../src/utils/warn-once.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← session-fork.test.ts
// ======================================================================

/** 读 fork 后的文件，返回解析后的 entry 数组（文件级共享，多 describe 复用） */
async function readForked(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, 'utf-8')
  return parseJsonl(raw) as Record<string, unknown>[]
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-fork', () => {
describe('createForkedSessionFile', () => {
  let sourceDir: string
  let targetDir: string
  let sourceFile: string

  beforeEach(async () => {
    sourceDir = await mkdtemp(join(tmpdir(), 'fork-src-'))
    targetDir = await mkdtemp(join(tmpdir(), 'fork-tgt-'))
    sourceFile = join(sourceDir, 'source.jsonl')
  })

  afterEach(async () => {
    await Promise.all([rm(sourceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }), rm(targetDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })])
  })

  /** 构建测试 JSONL：session header + 3 turn（user/assistant/toolResult）。
   * [W1 语义变更] cwd 用真实存在的 sourceDir——createForkedSessionFile 生成 header 时
   * 对继承 cwd 做存活兜底（死路径 → homedir），fixture 必须用活路径才能锁定「继承源 cwd」。 */
  async function writeSourceJSONL(cwd: string = sourceDir): Promise<void> {
    const lines = [
      { type: 'session', version: 3, id: 'src-session-id', timestamp: '2026-07-07T01:00:00.000Z', cwd },
      { type: 'model_change', id: 'mc1', parentId: null, timestamp: '2026-07-07T01:00:00.100Z', provider: 'p', modelId: 'm' },
      // turn 1
      { type: 'message', id: 'u1', parentId: 'mc1', timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      // turn 2
      { type: 'message', id: 'u2', parentId: 'a1', timestamp: '2026-07-07T01:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: 'do work' }] } },
      { type: 'message', id: 'a2', parentId: 'u2', timestamp: '2026-07-07T01:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      // turn 3
      { type: 'message', id: 'u3', parentId: 'a2', timestamp: '2026-07-07T01:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'more' }] } },
      { type: 'message', id: 'a3', parentId: 'u3', timestamp: '2026-07-07T01:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]
    await writeFile(sourceFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  it('includeFrom=true：保留到 fork 点（含），兄弟分支丢弃', async () => {
    await writeSourceJSONL()
    // fork 到 a2（turn 2 assistant，含）→ 保留 u1/a1/u2/a2 + mc1，丢弃 u3/a3
    const { filePath } = await createForkedSessionFile(sourceFile, 'a2', true, targetDir)

    const entries = await readForked(filePath)
    const ids = entries.filter((e) => typeof e.id === 'string').map((e) => e.id as string)

    // session header（新 id）+ mc1 + u1 + a1 + u2 + a2
    expect(ids).toHaveLength(6)
    expect(ids).toContain('mc1')
    expect(ids).toContain('u1')
    expect(ids).toContain('a1')
    expect(ids).toContain('u2')
    expect(ids).toContain('a2')
    expect(ids).not.toContain('u3')
    expect(ids).not.toContain('a3')
  })

  it('includeFrom=false：保留到 fork 点前（不含 fork 点）', async () => {
    await writeSourceJSONL()
    // fork 到 u3（不含）→ 保留到 u3 前 = mc1/u1/a1/u2/a2，丢弃 u3/a3
    const { filePath } = await createForkedSessionFile(sourceFile, 'u3', false, targetDir)

    const entries = await readForked(filePath)
    const ids = entries.filter((e) => typeof e.id === 'string').map((e) => e.id as string)

    expect(ids).toContain('mc1')
    expect(ids).toContain('u1')
    expect(ids).toContain('a1')
    expect(ids).toContain('u2')
    expect(ids).toContain('a2')
    expect(ids).not.toContain('u3')
    expect(ids).not.toContain('a3')
  })

  it('session header 重建：新 id + parentSession 指回源文件', async () => {
    await writeSourceJSONL()
    const { filePath, sessionId } = await createForkedSessionFile(sourceFile, 'a1', true, targetDir)

    const entries = await readForked(filePath)
    const header = entries[0]
    expect(header.type).toBe('session')
    expect(header.id).toBe(sessionId) // 新 session id
    expect(header.id).not.toBe('src-session-id') // 不是源 id
    expect(header.cwd).toBe(sourceDir) // 继承源 cwd（活路径原样保留）
    expect(header.parentSession).toBe(sourceFile) // 指回源文件
  })

  // [W1 语义变更：直附着正式文件] restore-fork-attach-fix F1/MF2——fork 直附着后 pi 加载
  // header cwd，死路径必 throw MissingSessionCwdError，故 newHeader 生成时兜底（C7）。
  it('源 header cwd 为死路径时，fork 产物 header cwd 兜底 homedir', async () => {
    const deadCwd = join(sourceDir, 'deleted-worktree')
    await writeSourceJSONL(deadCwd)

    const { filePath } = await createForkedSessionFile(sourceFile, 'a1', true, targetDir)

    const entries = await readForked(filePath)
    const header = entries[0]
    expect(header.cwd).toBe(homedir()) // 兜底为存活路径
    expect(header.cwd).not.toBe(deadCwd)
  })

  it('源文件不存在时报错', async () => {
    const missing = join(sourceDir, 'no-such.jsonl')
    await expect(createForkedSessionFile(missing, 'a1', true, targetDir))
      .rejects.toThrow(/source session file not found/)
  })

  it('源文件无 session header 时报错', async () => {
    // 只有 message entry，没有 session header
    await writeFile(sourceFile, JSON.stringify({ type: 'message', id: 'x', parentId: null, message: { role: 'user', content: [] } }) + '\n')
    await expect(createForkedSessionFile(sourceFile, 'x', true, targetDir))
      .rejects.toThrow(/no valid session header/)
  })

  it('forkEntryId 在树中找不到时报错', async () => {
    await writeSourceJSONL()
    await expect(createForkedSessionFile(sourceFile, 'nonexistent-id', true, targetDir))
      .rejects.toThrow(/not found in session tree/)
  })

  it('保留 fork 点是 root 链头（mc1）时正确截断', async () => {
    await writeSourceJSONL()
    // fork 到 mc1（最早的 entry，includeFrom=true）→ 只保留 mc1（header 的 id 是新 session id，不算 entry）
    const { filePath } = await createForkedSessionFile(sourceFile, 'mc1', true, targetDir)
    const entries = await readForked(filePath)
    // 排除 session header（type==='session'），只看业务 entry id
    const ids = entries.filter((e) => e.type !== 'session' && typeof e.id === 'string').map((e) => e.id as string)
    expect(ids).toEqual(['mc1'])
  })
})
// ── 盲区 1：streaming 中 fork 的 JSONL 竞态 ──────────────────────────────
// 场景：源 session 正在 streaming，pi 增量写入 JSONL 时末行可能不完整（JSON 被截断）。
// 若此刻触发 fork（用户在 streaming 中点 fork），createForkedSessionFile 读到的源文件
// 末行是残行。parseJsonl 静默跳过残行（不崩溃），但残行对应的 entry 不进 fork 结果。
// 验证：fork 成功（不抛错）+ 残行 entry 静默丢失（不出现在 fork 文件中）。
// 回归防护：若某天 parseJsonl 改成抛错或 createForkedSessionFile 加严格校验，此用例会 fail 提示。
describe('createForkedSessionFile · streaming JSONL 竞态（末行残行静默丢失）', () => {
  let srcDir: string
  let tgtDir: string
  let src: string

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), 'fork-race-src-'))
    tgtDir = await mkdtemp(join(tmpdir(), 'fork-race-tgt-'))
    src = join(srcDir, 'streaming.jsonl')
  })
  afterEach(async () => {
    await Promise.all([rm(srcDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }), rm(tgtDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })])
  })

  it('末行 JSON 被截断时 fork 不崩溃，截断的 entry 不出现在 fork 文件中', async () => {
    // 模拟 streaming：前 3 条完整行（header + u1 + a1）+ 第 4 行残行（a2 的 JSON 被切断，缺右花括号）。
    // 残行 a2 是 a1 的下一条 assistant（不在 fork 路径上——fork 点是 a1）。
    const fullLines = [
      { type: 'session', version: 3, id: 'src-stream', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    ].map((l) => JSON.stringify(l)).join('\n')
    // 残行：a2 的 JSON 写到一半被切断（合法 JSON 前缀，但缺结束括号 → parse 失败）
    const truncatedLine = '\n{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-07-07T01:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"streaming'
    await writeFile(src, fullLines + truncatedLine)

    // fork 到 a1（含）——残行 a2 不在路径上，应静默丢失，不崩溃
    const { filePath } = await createForkedSessionFile(src, 'a1', true, tgtDir)

    const entries = await readForked(filePath)
    const ids = entries.filter((e) => typeof e.id === 'string').map((e) => e.id as string)

    // 保留 header（新 id）+ u1 + a1
    expect(ids).toContain('u1')
    expect(ids).toContain('a1')
    // 残行 a2 不在 fork 结果（静默丢失验证）
    expect(ids).not.toContain('a2')
  })

  it('残行是 fork 点的直接子且不在路径上时不阻断 fork（路径截断于 fork 点）', async () => {
    // 变体：残行 a2 的 parentId 指向 a1（fork 点），但因残行被跳过，a2 不进 entryById。
    // fork 点 a1 的 parentId=u1 正常回溯（与 a2 无关），fork 仍成功含 u1/a1。
    const fullLines = [
      { type: 'session', version: 3, id: 'src-stream2', timestamp: '2026-07-07T02:00:00.000Z', cwd: '/test' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T02:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T02:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
    ].map((l) => JSON.stringify(l)).join('\n')
    // 残行：a2 parent 指向 a1，JSON 截断（缺右括号）
    const truncated = '\n{"type":"message","id":"a2","parentId":"a1","timestamp":"x"'
    await writeFile(src, fullLines + truncated)

    const { filePath } = await createForkedSessionFile(src, 'a1', true, tgtDir)
    const entries = await readForked(filePath)
    const ids = entries.filter((e) => typeof e.id === 'string').map((e) => e.id as string)
    expect(ids).toContain('a1')
    expect(ids).not.toContain('a2')
  })
})
// ── 盲区 2（runtime 部分）：fork 失败路径 ────────────────────────────────
// 源文件不存在 / forkEntryId 在源中不存在 → createForkedSessionFile 抛错。
// 上层 forkSession 据此抛错，调用方 catch 做 toast（renderer 侧 fork-entry-behavior 补 W2 路径）。
describe('createForkedSessionFile · 失败路径（源缺失 / fork 点不存在）', () => {
  let srcDir: string
  let tgtDir: string

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), 'fork-fail-src-'))
    tgtDir = await mkdtemp(join(tmpdir(), 'fork-fail-tgt-'))
  })
  afterEach(async () => {
    await Promise.all([rm(srcDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }), rm(tgtDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })])
  })

  it('源文件不存在 → 抛错（含 source session file not found）', async () => {
    const missing = join(srcDir, 'no-such.jsonl')
    await expect(createForkedSessionFile(missing, 'a1', true, tgtDir))
      .rejects.toThrow(/source session file not found/)
  })

  it('forkEntryId 在源 session 树中不存在 → 抛错（含 not found in session tree）', async () => {
    const src = join(srcDir, 'has-messages.jsonl')
    await writeFile(src, [
      { type: 'session', version: 3, id: 'src', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    // ghost-id 不在树中
    await expect(createForkedSessionFile(src, 'ghost-id', true, tgtDir))
      .rejects.toThrow(/not found in session tree/)
  })
})
// ── 盲区 3：多级 fork parentSession 透传（W3 修复回归防护） ───────────────
// 场景：A → B → C 三级 fork。
//   B 由 A fork 出：B.header.parentSession = A.path（直接父级 = A）
//   C 由 B fork 出：C.header.parentSession 应 = B.path（直接父级 = B），不能透传成 A.path（祖父）。
// W3 修复：parentSession 指向直接父级（源文件路径），不透传源 header 的 parentSession（那是祖父）。
// 回归防护：若 W3 回退（透传源的 parentSession），C.parentSession 会错误指向 A.path，此用例 fail。
describe('createForkedSessionFile · 多级 fork parentSession 指向直接父级（W3）', () => {
  let dir: string

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fork-multi-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })

  it('A→B→C 三级 fork：C.parentSession = B.path（直接父级），不透传成 A.path', async () => {
    // ── A：顶层 session（无 parentSession）──
    const aFile = join(dir, 'A.jsonl')
    await writeFile(aFile, [
      { type: 'session', version: 3, id: 'sess-A', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'A 的提问' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'A 的回复' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')

    // ── B：从 A fork（fork 点 a1）──
    const { filePath: bFile } = await createForkedSessionFile(aFile, 'a1', true, dir)
    // B.parentSession 应 = A.path（直接父级）
    const bEntries = await readForked(bFile)
    const bHeader = bEntries[0]
    expect(bHeader.parentSession).toBe(aFile)

    // ── C：从 B fork（fork 点 B 内的 a1，被透传保留）──
    const { filePath: cFile } = await createForkedSessionFile(bFile, 'a1', true, dir)
    const cEntries = await readForked(cFile)
    const cHeader = cEntries[0]
    // 关键断言（W3）：C.parentSession = B.path（直接父级），不是 A.path（祖父）
    expect(cHeader.parentSession).toBe(bFile)
    expect(cHeader.parentSession).not.toBe(aFile)
  })
})
// ── resolveEntryIdByTimestamp（S6 迁入 fork 域；纯函数直测，tmp JSONL 真跑）──

describe('resolveEntryIdByTimestamp', () => {
  /** 写多行 message entry 的 JSONL，返回文件路径。 */
  async function writeMessages(dir: string, msgs: Array<{ id: string; ts: number; role: string }>): Promise<string> {
    const filePath = join(dir, `fork-resolve-${randomish()}.jsonl`)
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'root-1', timestamp: '2026-08-19T00:00:00Z', cwd: dir }),
      ...msgs.map((m) => JSON.stringify({
        type: 'message',
        id: m.id,
        parentId: 'root-1',
        timestamp: new Date(m.ts).toISOString(),
        message: { role: m.role, content: [], timestamp: new Date(m.ts).toISOString() },
      })),
    ]
    await writeFile(filePath, lines.join('\n') + '\n', 'utf-8')
    return filePath
  }

  let seq = 0
  function randomish(): string {
    seq += 1
    return `f${seq}`
  }

  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fork-resolve-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  const T0 = 1700000000000

  it('timestamp 容差命中：秒级精度历史 session（±1000ms 内）匹配成功', async () => {
    const filePath = await writeMessages(dir, [
      { id: 'e1', ts: T0, role: 'user' },
      { id: 'e2', ts: T0 + 500, role: 'assistant' },
    ])
    // 前端 timestamp 与 entry 差 800ms（秒级精度典型偏移），1000ms 容差内命中 e2
    await expect(resolveEntryIdByTimestamp(filePath, T0 + 1300, 'assistant')).resolves.toBe('e2')
  })

  it('精确匹配优先：完全相等时命中该 entry（容差不引入歧义）', async () => {
    const filePath = await writeMessages(dir, [
      { id: 'e1', ts: T0, role: 'user' },
      { id: 'e2', ts: T0, role: 'assistant' },
    ])
    await expect(resolveEntryIdByTimestamp(filePath, T0, 'user')).resolves.toBe('e1')
  })

  it('role 限定消歧：同 timestamp 不同 role 时只匹配指定 role', async () => {
    const filePath = await writeMessages(dir, [
      { id: 'e1', ts: T0, role: 'user' },
      { id: 'e2', ts: T0, role: 'assistant' },
    ])
    await expect(resolveEntryIdByTimestamp(filePath, T0, 'assistant')).resolves.toBe('e2')
  })

  it('无匹配 fallback：warn 后取最后一条 message entry（不 throw）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const filePath = await writeMessages(dir, [
        { id: 'e1', ts: T0, role: 'user' },
        { id: 'e2', ts: T0 + 100, role: 'assistant' },
      ])
      // 距离全部 entry 超出容差 → fallback 最后一条
      await expect(resolveEntryIdByTimestamp(filePath, T0 + 60000)).resolves.toBe('e2')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to last entry'))
    } finally {
      warn.mockRestore()
    }
  })

  it('容差内多条同 role：取 |diff| 最小者而非首个命中（r1-S3，fork 点不错位）', async () => {
    const filePath = await writeMessages(dir, [
      { id: 'e1', ts: T0, role: 'user' },
      { id: 'e2', ts: T0, role: 'assistant' },
      { id: 'e3', ts: T0 + 800, role: 'assistant' },
    ])
    // 目标 timestamp 距 e3 仅 100ms、距 e2 900ms——两者均在 1000ms 容差内，
    // 修复前取首个命中（e2）致 fork 点错位；应取 |diff| 最小的 e3
    await expect(resolveEntryIdByTimestamp(filePath, T0 + 900, 'assistant')).resolves.toBe('e3')
  })

  it('报错路径：源文件不存在 → throw（带路径，ENOENT 分支）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const missing = join(dir, 'no-such.jsonl')
      await expect(resolveEntryIdByTimestamp(missing, T0)).rejects.toThrow(`fork: source session file missing for resolve: ${missing}`)
    } finally {
      warn.mockRestore()
    }
  })

  it('报错路径：无 message entry → throw', async () => {
    const filePath = join(dir, 'empty.jsonl')
    await writeFile(filePath, JSON.stringify({ type: 'session', version: 3, id: 'root-1', timestamp: '2026-08-19T00:00:00Z', cwd: dir }) + '\n', 'utf-8')
    await expect(resolveEntryIdByTimestamp(filePath, T0)).rejects.toThrow('fork: source session has no message entries')
  })
})
});

// ======================================================================
// ← session-scanner-bad-header.test.ts
// ======================================================================

const realFs = createRequire(import.meta.url)('fs') as typeof import('node:fs')


const pathsMock = vi.hoisted(() => ({ getSessionsDir: vi.fn(() => '/fake/sessions') }))

vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: pathsMock.getSessionsDir,
  }
})


// detectBareWorkspaceCached 经 workspace-detector，mock 避免真实 cwd 探测
vi.mock('../src/services/worktree/workspace-detector.js', () => ({
  detectBareWorkspaceCached: () => false,
}))
/** 构造一个 scanSessions 委托给真实 scanPiSessions 的 sessionStore mock（避免 PiSessionStore 的 provider-store 链）。 */
function makeSessionStore(): ISessionStore {
  return {
    scanSessions: () => scanPiSessions(),
    refreshAll: () => undefined,
    persistSessionEnd: () => undefined,
    persistPresetBinding: () => undefined,
    extractSessionOutcome: () => null,
    invalidateMetaCache: () => undefined,
    convertHistory: () => [],
    trash: () => Promise.resolve(),
  } as unknown as ISessionStore
}


/** S2 ISP 化：结构性满足 scanner 窄接口（2 方法 = 消费方实际用到的全部），无强转。 */
function makeSvc(): IScannerSessionOps {
  return {
    getActiveSummaries: vi.fn(() => []),
    getActiveFilePaths: vi.fn(() => new Set<string>()),
  }
}


function makeGitReader(): IGitInfoReader {
  return {
    readGitInfo: vi.fn(() => undefined),
    pruneStaleCache: vi.fn(),
  } as unknown as IGitInfoReader
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-scanner-bad-header', () => {
describe('RT-3#1: 坏 header（缺 id/cwd）不毒死会话列表', () => {
  let tmpSessionsDir: string

  beforeEach(() => {
    tmpSessionsDir = realFs.mkdtempSync(join(tmpdir(), 'scanner-bad-header-'))
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
  })

  afterEach(() => {
    realFs.rmSync(tmpSessionsDir, { recursive: true, force: true })
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
  })

  /** 造 session JSONL 文件（header 字段可缺省，模拟坏数据）。 */
  function makeSessionFile(id: string, opts: { omitCwd?: boolean; omitId?: boolean } = {}): string {
    const dir = join(tmpSessionsDir, 'encodedCwd')
    if (!realFs.existsSync(dir)) realFs.mkdirSync(dir)
    const filePath = join(dir, `${id}.jsonl`)
    const header: Record<string, unknown> = { type: 'session', timestamp: '2025-01-01T00:00:00Z', cwd: '/proj' }
    if (!opts.omitId) header.id = id
    if (opts.omitCwd) delete header.cwd
    realFs.writeFileSync(filePath, `${JSON.stringify(header)}\n`, 'utf-8')
    return filePath
  }

  it('缺 cwd 的坏 header：listPersistedSessions 不抛、其余会话照常返回、warn 带路径 + degraded 计数显形', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const badPath = makeSessionFile('bad-no-cwd', { omitCwd: true })
      makeSessionFile('good-session')
      const scanner = new SessionScanner(makeSvc(), makeSessionStore(), makeGitReader())

      // 修复前：scannedToSummary 的 basename(undefined) TypeError 让整列消失
      const groups = scanner.listPersistedSessions()

      // 其余会话照常返回（坏条目被扫描出口 fail-fast，不进列表）
      const allIds = groups.flatMap((g) => g.sessions.map((s) => s.id))
      expect(allIds).toEqual(['good-session'])
      expect(groups[0].cwd).toBe('/proj')

      // 留痕：per-file warn 带文件路径（恢复动作 = 修/删该文件）
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session header missing/empty id or cwd'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(badPath))
      // degraded 计数显形：扫描轮末汇总打点
      // RT-3#2：轮末汇总升级为全家族统一格式（badHeader=<n> 计数进 degraded 汇总行）
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scanPiSessions degraded: badHeader=1'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('缺 id 的坏 header：同样 fail-fast 不进列表、不毒列表', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      makeSessionFile('bad-no-id', { omitId: true })
      makeSessionFile('good-session')
      const scanner = new SessionScanner(makeSvc(), makeSessionStore(), makeGitReader())

      const groups = scanner.listPersistedSessions()
      const allIds = groups.flatMap((g) => g.sessions.map((s) => s.id))
      expect(allIds).toEqual(['good-session'])
      // RT-3#2：轮末汇总升级为全家族统一格式（badHeader=<n> 计数进 degraded 汇总行）
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scanPiSessions degraded: badHeader=1'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('消费侧兜底：meta.cwd 类型破约（undefined）时 basename 退化为空串而非 TypeError 毒死列表', () => {
    // 扫描出口已拦缺 cwd 条目，本用例锁纵深第二层（scannedToSummary 的 basename 兜底）：
    // 其它 ScannedSession 生产者破约时列表组装仍不抛。
    const brokenMeta = {
      id: 'broken-cwd',
      filePath: '/fake/broken.jsonl',
      cwd: undefined,
      timestamp: '2025-01-01T00:00:00Z',
      name: null,
      outcome: null,
      lastModified: 1_700_000_000_000,
      size: 10,
    } as unknown as ScannedSessionMeta
    const store = {
      ...makeSessionStore(),
      scanSessions: () => [brokenMeta],
    } as unknown as ISessionStore
    const scanner = new SessionScanner(makeSvc(), store, makeGitReader())

    expect(() => scanner.listPersistedSessions()).not.toThrow()
    const groups = scanner.listPersistedSessions()
    const summary = groups.flatMap((g) => g.sessions).find((s) => s.id === 'broken-cwd')
    expect(summary).toBeDefined()
    // label 兜底：basename('') = ''（优于整列消失）
    expect(summary!.label).toBe('')
  })
})
});

// ======================================================================
// ← jsonl-tail.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('jsonl-tail', () => {
describe('jsonl-tail', () => {
/**
 * W1 红灯测试：jsonl.ts 尾读工具（readTail / readTailEntries）。
 *
 * 对应 FR-tail-read 的基础设施层（AC-tail-1/4/5）：
 * - readTailEntries：用 openSync+readSync 从 offset=max(0,size-NKB) 读尾部，
 *   丢首行残行（offset≠0 时），返回解析出的 entry 数组。
 *
 * [红灯说明] readTail / readTailEntries / READ_TAIL_BYTES 尚未实现 → import 失败 → 红灯。
 * 实现后（W1 dev）应转绿。
 *
 * 运行：cd packages/runtime && npx vitest run test/jsonl-tail.test.ts
 */
// 以下 import 在 W1 实现前会失败（符号不存在）→ 红灯
describe('W1 jsonl readTailEntries', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-tail-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 造一个 JSONL 文件，entries 为对象数组，逐行 JSON.stringify + \n 连接 */
  function makeFile(entries: object[]): string {
    const path = join(tmpDir, `test-${Math.random().toString(36).slice(2)}.jsonl`)
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
    return path
  }

  it('AC-tail-1: 尾窗内的 entry 被正确解析返回', () => {
    // 文件远小于 READ_TAIL_BYTES（32KB），offset=0 读全文件
    const entries = [
      { type: 'session', id: 's1' },
      { type: 'message', role: 'user' },
      { type: 'session_info', name: '尾部名字' },
    ]
    const path = makeFile(entries)
    const result = readTailEntries(path)
    if (!result) throw new Error('readTailEntries returned null')
    // offset=0 时无残行丢弃，全部 entry 返回
    expect(result).toHaveLength(3)
    expect(result[2]).toEqual({ type: 'session_info', name: '尾部名字' })
  })

  it('AC-tail-4: offset≠0 时首行残行被丢弃（含多字节 UTF-8 切断）', () => {
    // 构造文件 > READ_TAIL_BYTES，使 offset 落在中间某行
    // 用一个超长首行撑过 32KB，尾部放目标 entry
    const longLine = { type: 'padding', data: 'x'.repeat(READ_TAIL_BYTES + 1000) }
    const tailEntry = { type: 'session_end', outcome: 'done' as const }
    const path = makeFile([longLine, tailEntry])
    const result = readTailEntries(path)
    if (!result) throw new Error('readTailEntries returned null')
    // 首行残行（padding 被切断的部分）必须被丢弃，不参与 parse
    // 只返回完整的 session_end（残行要么 parse 失败被跳，要么即使侥幸 parse 成功也不应出现）
    const outcomes = result.filter((e) => (e as { type?: string }).type === 'session_end')
    expect(outcomes).toHaveLength(1)
    // 残行不应产生 padding 类型的假 entry
    const paddings = result.filter((e) => (e as { type?: string }).type === 'padding')
    expect(paddings).toHaveLength(0)
  })

  it('AC-tail-4: 多字节 UTF-8 字符在 offset 处切断不产生乱码抛错', () => {
    // emoji 占 4 字节，CJK 占 3 字节。构造内容使 offset 切在多字节字符中间
    const emoji = '🌐' // U+1F310, 4 bytes in UTF-8
    const cjk = '中文测试' // 每字 3 bytes
    // 首行大量 emoji 撑过 32KB，offset 大概率切在某个 emoji 中间
    const paddingLine = { type: 'pad', text: emoji.repeat(READ_TAIL_BYTES / 2) }
    const target = { type: 'session_info', name: cjk + '结束' }
    const path = makeFile([paddingLine, target])
    // 不应抛错（残行被丢弃，不因乱码崩溃）
    expect(() => readTailEntries(path)).not.toThrow()
    const result = readTailEntries(path)
    if (!result) throw new Error('readTailEntries returned null')
    const found = result.find((e) => (e as { type?: string }).type === 'session_info')
    expect(found).toEqual(target)
  })

  it('AC-tail-5: 文件不存在返回 null 不抛', () => {
    const path = join(tmpDir, 'nonexistent.jsonl')
    expect(() => readTailEntries(path)).not.toThrow()
    expect(readTailEntries(path)).toBeNull()
  })

  it('AC-tail-5: 文件小于 READ_TAIL_BYTES 退化为读全文件', () => {
    const entries = [
      { type: 'session', id: 'x' },
      { type: 'session_info', name: '小文件' },
    ]
    const path = makeFile(entries)
    const result = readTailEntries(path)
    // size < NKB → offset=0 → 无残行 → 全部返回
    expect(result).toHaveLength(2)
  })

  it('空文件返回空数组', () => {
    const path = join(tmpDir, 'empty.jsonl')
    writeFileSync(path, '', 'utf-8')
    const result = readTailEntries(path)
    expect(result).toEqual([])
  })
})
})
describe('extract-tail-read', () => {
/**
 * W2 红灯测试：extractSessionName / extractSessionOutcome 尾读改造 + fallback。
 *
 * 对应 FR-tail-read（AC-tail-1/2/3）+ INVAR-tail-2 fallback 全量（SR1 核心修复）。
 *
 * 核心防的 bug：
 * - SR1：session_info 在文件头部（早期命名 + 长对话追加），尾窗找不到 → 若返回 null 则丢名字。
 *   修复：尾读未命中 → fallback 全量读。
 * - 回归：无 session_info/session_end 的文件返回 null（与现状一致）。
 *
 * [红灯说明] 当前 extractSessionName/extractSessionOutcome 仍是全量读（W1 readTail 工具已实现但
 * extract 尚未改用）。本测试断言"fallback 触发"和"尾读命中"——实现前部分会 fail（无法观测 fallback）。
 * W2 实现后（extract 改用 readTailEntries + fallback）应转绿。
 *
 * 运行：cd packages/runtime && npx vitest run test/extract-tail-read.test.ts
 */
describe('W2 extractSessionName 尾读 + fallback', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'extract-name-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function makeFile(lines: string[]): string {
    const path = join(tmpDir, `s-${Math.random().toString(36).slice(2)}.jsonl`)
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8')
    return path
  }

  it('AC-tail-1: session_info 在尾窗内 → 返回正确 name', () => {
    const path = makeFile([
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'session_info', name: '我的名字' }),
    ])
    expect(extractSessionName(path)).toBe('我的名字')
  })

  it('AC-tail-1: 多条 session_info 取最后一条', () => {
    const path = makeFile([
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'session_info', name: '旧名字' }),
      JSON.stringify({ type: 'session_info', name: '新名字' }),
    ])
    expect(extractSessionName(path)).toBe('新名字')
  })

  /**
   * SR1 核心防回归：session_info 在文件头部（早期命名 + 长对话）。
   * 尾读找不到 → 必须 fallback 全量读 → 返回正确名字，不能返回 null。
   */
  it('AC-tail-2: session_info 在文件头部（>32KB）→ fallback 全量返回正确 name（非 null）', () => {
    // session_info 在第 2 行，之后追加大量 message 撑过 32KB 尾窗
    const lines = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'session_info', name: '早期命名的名字' }),
    ]
    // 追加大量 message 把 session_info 推出尾窗
    for (let i = 0; i < 500; i++) {
      lines.push(JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'x'.repeat(200) } }))
    }
    const path = makeFile(lines)
    // 文件大小 >> 32KB，session_info 在头部，尾窗全是 message
    const name = extractSessionName(path)
    // 核心：不能因尾读找不到就返回 null（丢名字）。必须 fallback 全量读到 '早期命名的名字'
    expect(name).toBe('早期命名的名字')
  })

  it('AC-tail-3: 文件无 session_info → 返回 null', () => {
    const path = makeFile([
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
    ])
    expect(extractSessionName(path)).toBeNull()
  })

  it('文件不存在 → 返回 null 不抛', () => {
    const path = join(tmpDir, 'nope.jsonl')
    expect(() => extractSessionName(path)).not.toThrow()
    expect(extractSessionName(path)).toBeNull()
  })
})

describe('W2 extractSessionOutcome 尾读 + fallback', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'extract-outcome-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function makeFile(lines: string[]): string {
    const path = join(tmpDir, `s-${Math.random().toString(36).slice(2)}.jsonl`)
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8')
    return path
  }

  it('AC-tail-1: session_end 在尾部 → 返回正确 outcome', () => {
    const path = makeFile([
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'session_end', outcome: 'done', timestamp: 't2' }),
    ])
    expect(extractSessionOutcome(path)).toBe('done')
  })

  it('AC-tail-1: session_end outcome=error/stopped 各正确', () => {
    for (const outcome of ['error', 'stopped'] as const) {
      const path = makeFile([
        JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
        JSON.stringify({ type: 'session_end', outcome, timestamp: 't2' }),
      ])
      expect(extractSessionOutcome(path)).toBe(outcome)
    }
  })

  it('AC-tail-2: session_end 被大量 message 推出尾窗 → fallback 全量返回正确 outcome', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
      JSON.stringify({ type: 'session_end', outcome: 'stopped', timestamp: 't2' }),
    ]
    for (let i = 0; i < 500; i++) {
      lines.push(JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'y'.repeat(200) } }))
    }
    const path = makeFile(lines)
    expect(extractSessionOutcome(path)).toBe('stopped')
  })

  it('AC-tail-3: 文件无 session_end → 返回 null', () => {
    const path = makeFile([
      JSON.stringify({ type: 'session', id: 's1', cwd: '/p', timestamp: 't' }),
    ])
    expect(extractSessionOutcome(path)).toBeNull()
  })

  it('文件不存在 → 返回 null 不抛', () => {
    const path = join(tmpDir, 'nope.jsonl')
    expect(() => extractSessionOutcome(path)).not.toThrow()
    expect(extractSessionOutcome(path)).toBeNull()
  })
})
})
});

// ======================================================================
// ← jsonl.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('jsonl', () => {
describe('parseJsonl', () => {
  it('空字符串返回空数组', () => {
    expect(parseJsonl('')).toEqual([])
  })

  it('单行合法 JSON 返回单元素数组', () => {
    expect(parseJsonl('{"type":"user"}')).toEqual([{ type: 'user' }])
  })

  it('跳过空行与空白行，保留合法行顺序', () => {
    const raw = ['{"a":1}', '', '   ', '{"b":2}', ''].join('\n')
    expect(parseJsonl(raw)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('跳过畸形行，不中断后续合法行解析', () => {
    const raw = ['{"a":1}', 'not json', '{bad', '{"b":2}', '}'].join('\n')
    expect(parseJsonl(raw)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('保留 Unicode 与转义字符', () => {
    const raw = '{"text":"你好\\n世界","q":"含\\"引号"}'
    expect(parseJsonl(raw)).toEqual([{ text: '你好\n世界', q: '含"引号' }])
  })

  it('trim 后解析（行首尾空白不影响）', () => {
    expect(parseJsonl('  {"x":1}  ')).toEqual([{ x: 1 }])
  })

  it('全畸形行返回空数组', () => {
    expect(parseJsonl(['foo', 'bar', '{'].join('\n'))).toEqual([])
  })
})
describe('parseJsonlWarnOnMalformed（RT-8#13 可观测性）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetWarnOnceForTest()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    _resetWarnOnceForTest()
  })

  it('畸形行 → warn 恰一次，文案含 filePath 与丢弃计数；合法行按序保留', () => {
    const fp = '/tmp/fake/sessions/s1.jsonl'
    const raw = ['{"a":1}', 'not json', '{bad', '{"b":2}'].join('\n')
    expect(parseJsonlWarnOnMalformed(raw, fp)).toEqual([{ a: 1 }, { b: 2 }])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = String(warnSpy.mock.calls[0]?.[0])
    expect(msg).toContain(fp)
    expect(msg).toContain('2 行畸形 JSON')
  })

  it('无畸形行（含空行/空白行）→ 不 warn', () => {
    const raw = ['{"a":1}', '', '   ', '{"b":2}'].join('\n')
    expect(parseJsonlWarnOnMalformed(raw, '/tmp/fake/clean.jsonl')).toEqual([{ a: 1 }, { b: 2 }])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('同一 filePath 重复解析 → warn-once 去重，仍只出声一次', () => {
    const fp = '/tmp/fake/dup.jsonl'
    parseJsonlWarnOnMalformed('bad line', fp)
    parseJsonlWarnOnMalformed('bad line', fp)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('不同 filePath 各自出声一次（去重键 = jsonl:<filePath>）', () => {
    parseJsonlWarnOnMalformed('bad', '/tmp/fake/a.jsonl')
    parseJsonlWarnOnMalformed('bad', '/tmp/fake/b.jsonl')
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })
})
});

// ======================================================================
// ← scanner-base.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('scanner-base', () => {
describe('inferSourceType', () => {
  it('识别 .taiji 为 pi', () => {
    expect(inferSourceType('/home/u/.taiji/agents')).toBe('pi')
    expect(inferSourceType(join(homedir(), '.taiji'))).toBe('pi')
  })

  it('识别 .taiji 变体（-dev / -v2）为 pi', () => {
    expect(inferSourceType('/home/u/.taiji-dev/agents')).toBe('pi')
    expect(inferSourceType('/home/u/.taiji-v2/skills')).toBe('pi')
  })

  it('不把 .taijiator 误判为 pi（注释点名的回归风险）', () => {
    // startWith('.taiji') 会误命中，必须用 === / startsWith('.taiji-') 精确匹配
    expect(inferSourceType('/home/u/.taijiator/foo')).toBe('custom')
    expect(inferSourceType('/home/u/.taijis')).toBe('custom')
  })

  it('识别 .pi / .claude / .agents', () => {
    expect(inferSourceType('/home/u/.pi/agents')).toBe('pi')
    expect(inferSourceType('/home/u/.claude/agents')).toBe('claude')
    expect(inferSourceType('/home/u/.agents/skills')).toBe('agents')
  })

  it('不把 .pi-backup / .claude-old 误判（后缀变体）', () => {
    expect(inferSourceType('/home/u/.pi-backup/agents')).toBe('custom')
    expect(inferSourceType('/home/u/.claude-old/agents')).toBe('custom')
    expect(inferSourceType('/home/u/.agents-backup')).toBe('custom')
  })

  it('未知路径与自定义目录落回 custom', () => {
    expect(inferSourceType('/home/u/my-tools/agents')).toBe('custom')
    expect(inferSourceType('/opt/custom-skills')).toBe('custom')
  })

  it('空串落回 custom（不抛）', () => {
    expect(inferSourceType('')).toBe('custom')
  })

  it('Windows 风格反斜杠路径也能按段切分', () => {
    expect(inferSourceType('C:\\Users\\foo\\.claude\\agents')).toBe('claude')
    expect(inferSourceType('C:\\Users\\foo\\.taiji-dev\\agents')).toBe('pi')
  })
})
describe('expandHome', () => {
  it('把 ~/ 前缀展开到 homedir', () => {
    expect(expandHome('~/foo/bar')).toBe(join(homedir(), 'foo/bar'))
  })

  it('单独 ~ 展开为 homedir', () => {
    expect(expandHome('~')).toBe(homedir())
  })

  it('无 ~ 前缀原样返回', () => {
    expect(expandHome('/abs/path')).toBe('/abs/path')
    expect(expandHome('relative/path')).toBe('relative/path')
  })

  it('空串原样返回（不抛）', () => {
    expect(expandHome('')).toBe('')
  })
})
});
