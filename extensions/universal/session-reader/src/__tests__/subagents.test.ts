import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import {
  buildFamilyFromFs,
  listRecordManifests,
  extractSessionIdFromFilename,
  type RecordManifest,
} from '../discovery/subagents.js'
import { REAL_DATA_TIMEOUT_MS } from './real-data.js'

// ---- fixture 常量（uuid 特征，满足 extractSessionIdFromFilename + 互不为子串）----
const ROOT = '0aaaaaaa-bbbb-7ccc-dddd-000000000001'
const FORK = '0aaaaaaa-bbbb-7ccc-dddd-000000000002'
const SUB_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000003'

/** 真实 pi agent 目录（本机），用于集成测试。 */
const REAL_AGENT_DIR = '/Users/zhushanwen/.pi/agent'

// 同步探测真实 session 是否存在（不存在则 skip，避免在无该数据的机器上硬失败）
function hasRealSession(sid: string): boolean {
  try {
    return (
      execSync(
        `find ${REAL_AGENT_DIR}/sessions -name '*${sid}*' -name '*.jsonl' ! -name '*.finalized' 2>/dev/null | head -1`,
        { encoding: 'utf8' },
      ).trim().length > 0
    )
  } catch {
    return false
  }
}

// 双目录版探测：subagent session 文件在 subagents/ 下，hasRealSession 扫不到。
// 用于对活跃数据目录中具体文件（fork 子代/隔代 subagent）存在性的守卫。
function hasAnyRealSession(fragment: string): boolean {
  try {
    return (
      execSync(
        `find ${REAL_AGENT_DIR}/sessions ${REAL_AGENT_DIR}/subagents -name '*${fragment}*' -name '*.jsonl' ! -name '*.finalized' 2>/dev/null | head -1`,
        { encoding: 'utf8' },
      ).trim().length > 0
    )
  } catch {
    return false
  }
}
const HAS_REAL_ROOT = hasRealSession('019fe620-8ae1-78a7-b76a-43a1ba4cc3c7')
const HAS_REAL_WF = hasRealSession('019fdcda-75c7-74b7-a160-f67f6bf88384')

// ---- fixture helpers ----

async function makeAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'subagents-test-'))
}

/** 写主 session 文件（首行 header）。返回绝对路径（供 fork 的 parentSession 指向）。 */
async function writeMainSession(
  dir: string,
  slug: string,
  id: string,
  opts?: { cwd?: string; parentSession?: string },
): Promise<string> {
  const sessionDir = join(dir, 'sessions', slug)
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, `${id}.jsonl`)
  const header: Record<string, unknown> = { type: 'session', id, cwd: opts?.cwd ?? `/proj/${slug}` }
  if (opts?.parentSession) header.parentSession = opts.parentSession
  await writeFile(path, JSON.stringify(header) + '\n')
  return path
}

/**
 * 写 subagent session 文件：首行 header（真实 id）+ 占位 message + 尾行 identity。
 * identity 在尾行（实测 pi 行为；subagent-identity 由 session-runner 在 session 创建后写）。
 * U4 扩展：identity.task/agent 可定制（P-fallback 测试用，默认 't'/'explorer'）。
 */
async function writeSubagentSession(
  dir: string,
  slug: string,
 realId: string,
  identity: { rootSessionId: string; slug: string; dataId?: string; task?: string; agent?: string },
): Promise<string> {
  const sessionDir = join(dir, 'subagents', slug, 'sessions')
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, `${realId}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'session', id: realId, cwd: `/proj/${slug}` }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      parentId: realId,
      message: { role: 'user', content: 'do work' },
    }),
    JSON.stringify({
      type: 'custom',
      customType: 'subagent-identity',
      data: {
        id: identity.dataId ?? `sa-${realId.slice(0, 8)}`,
        rootSessionId: identity.rootSessionId,
        slug: identity.slug,
        agent: identity.agent ?? 'explorer',
        mode: 'sync',
        task: identity.task ?? 't',
        startedAt: 1,
      },
    }),
  ]
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

/**
 * 写 alive subagent 文件但**无 identity 尾行**（运行中/异常，尾行是 message）。
 * TC-u4-pfallback-no-identity 场景：header 有效、无 manifest、无 identity → buildFamilyFromFs 跳过。
 */
async function writeAliveSubagentNoIdentity(
  dir: string,
  slug: string,
  realId: string,
): Promise<string> {
  const sessionDir = join(dir, 'subagents', slug, 'sessions')
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, `${realId}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'session', id: realId, cwd: `/proj/${slug}` }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      parentId: realId,
      message: { role: 'user', content: 'still running' },
    }),
  ]
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

/** 写 wf-state 文件（每行一个快照；字符串按原样写入，可注入坏行）。返回绝对路径。 */
async function writeWfState(dir: string, slug: string, lines: string[]): Promise<string> {
  const wfDir = join(dir, 'sessions', slug, 'workflow-state')
  await mkdir(wfDir, { recursive: true })
  const path = join(wfDir, 'wf-test.jsonl')
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

/** 向主 session 文件追加 workflow-state-link custom entry（resolveWorkflows 的输入）。 */
async function writeWfLink(
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
    data: { runId: link.runId, path: link.path, updatedAt: '2026-08-07T16:48:24.933Z' },
    timestamp: '2026-08-07T16:48:24.933Z',
  })
  await writeFile(sessionPath, line + '\n', { flag: 'a' })
}

/** 写 records manifest（孤儿源）。U4 扩展：fields 支持富字段 task/slug/model/status。 */
async function writeRecordManifest(
  dir: string,
  slug: string,
  id: string,
  fields: {
    rootSessionId: string
    agentName?: string
    sessionFile: string
    task?: string
    slug?: string
    model?: string
    status?: string
  },
): Promise<void> {
  const recordsDir = join(dir, 'subagents', slug, 'records')
  await mkdir(recordsDir, { recursive: true })
  await writeFile(join(recordsDir, `${id}.json`), JSON.stringify({ id, ...fields }))
}

// ============================================================
// fixture 测试
// ============================================================

describe('buildFamilyFromFs - fixture', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeAgentDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('基础 family：root + fork + 隔代 subagent，SubagentRef.sessionId 是真实 id（非 sa-xxx）', async () => {
    const rootPath = await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    // fork 在不同 cwd slug（模拟跨 cwd fork）
    await writeMainSession(dir, '--fork-cwd--', FORK, {
      cwd: '/proj/fork',
      parentSession: rootPath,
    })
    // subagent 挂在 fork 子代下（rootSessionId=FORK，非 ROOT）→ 隔代
    await writeSubagentSession(dir, '--fork-cwd--', SUB_REAL, {
      rootSessionId: FORK,
      slug: 'test-sub',
      dataId: 'sa-placeholder-1',
    })

    const family = await buildFamilyFromFs(ROOT, dir)

    expect(family.root.sessionId).toBe(ROOT)
    // fork：parentSession 含 ROOT id → childrenOf[ROOT] = [FORK]
    expect(family.forks.some((f) => f.sessionId === FORK)).toBe(true)
    // Q1 隔代：subagent rootSessionId=FORK（fork 子代），从 ROOT resolve 能关联
    const sub = family.subagents.find((s) => s.sessionId === SUB_REAL)
    expect(sub).toBeDefined()
    // id 修正核心断言：sessionId 是 subagent 文件首行 header.id（真实），非 identity.data.id 的 sa-xxx
    expect(sub!.sessionId).toBe(SUB_REAL)
    expect(sub!.sessionId.startsWith('sa-')).toBe(false)
    expect(sub!.rootSessionId).toBe(FORK)
    expect(sub!.slug).toBe('test-sub')
    expect(sub!.cleanedUp).toBe(false)
    // enrichRefs 已删除（ext-simplify-04 U4/E2）：family 路径 fileName/cwd 维持 core 占位空串
    //（SessionRef 与 find 路径共享，find 侧有真实消费者；workflow calls 反查走 pathToRef 不受影响）
    expect(sub!.fileName).toBe('')
    expect(sub!.cwd).toBe('')
  })

  it('从 fork 子代 resolve 也能关联到挂在其下的 subagent', async () => {
    const rootPath = await writeMainSession(dir, '--root-cwd--', ROOT)
    await writeMainSession(dir, '--fork-cwd--', FORK, { parentSession: rootPath })
    await writeSubagentSession(dir, '--fork-cwd--', SUB_REAL, { rootSessionId: FORK, slug: 's' })

    const family = await buildFamilyFromFs(FORK, dir)
    expect(family.subagents.some((s) => s.sessionId === SUB_REAL)).toBe(true)
  })

  it('cleanedUp：manifest 孤儿（.jsonl 不存在）→ cleanedUp=true', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    // 孤儿 manifest：rootSessionId=ROOT，sessionFile 指向不存在路径（模拟 .jsonl 被 GC）
    await writeRecordManifest(dir, '--root-cwd--', 'sa-ghost-id', {
      rootSessionId: ROOT,
      agentName: 'explorer',
      sessionFile: '/nonexistent/ghost.jsonl',
    })

    const family = await buildFamilyFromFs(ROOT, dir)

    const ghost = family.subagents.find((s) => s.sessionId === 'sa-ghost-id')
    expect(ghost).toBeDefined()
    expect(ghost!.cleanedUp).toBe(true)
    expect(ghost!.rootSessionId).toBe(ROOT)
    // 孤儿无文件 → mtime/size 占位 0
    expect(ghost!.mtime).toBe(0)
    expect(ghost!.sizeBytes).toBe(0)
  })

  it('alive subagent 同时有 manifest → 不重复计数（manifest 跳过 alive）', async () => {
    const rootPath = await writeMainSession(dir, '--root-cwd--', ROOT)
    await writeMainSession(dir, '--fork-cwd--', FORK, { parentSession: rootPath })
    const subPath = await writeSubagentSession(dir, '--fork-cwd--', SUB_REAL, {
      rootSessionId: FORK,
      slug: 'dup-test',
    })
    // manifest 指向真实文件路径（alive）→ 应被跳过，不产生孤儿副本
    await writeRecordManifest(dir, '--fork-cwd--', `sa-${SUB_REAL}`, {
      rootSessionId: FORK,
      agentName: 'explorer',
      sessionFile: subPath,
    })

    const family = await buildFamilyFromFs(ROOT, dir)
    // 只有一个 SUB_REAL（真实 id），无 sa- 副本
    const realOnes = family.subagents.filter((s) => s.sessionId === SUB_REAL)
    expect(realOnes).toHaveLength(1)
    expect(realOnes[0].cleanedUp).toBe(false)
    const orphans = family.subagents.filter((s) => s.sessionId.startsWith('sa-'))
    expect(orphans).toHaveLength(0)
  })

  it('sessionId 不在任意 main header → 抛 Error', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    await expect(buildFamilyFromFs('nonexistent-session-id', dir)).rejects.toThrow(/not found/)
  })

  it('workflows：NEW 格式（v=wf-run-v1）state.calls 解析；命中 pathToRef 取完整 ref，GC\'d 路径回退最小 ref', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    // 真实存在的 subagent（步骤 2 扫到 → pathToRef 命中 → 完整 SessionRef）
    const subPath = await writeSubagentSession(dir, '--root-cwd--', SUB_REAL, {
      rootSessionId: ROOT,
      slug: 'wf-sub',
    })
    // GC\'d 路径（文件不存在 → pathToRef 未命中 → sessionRefFromPath 最小 ref）
    const gced = join(
      dir,
      'subagents',
      '--root-cwd--',
      'sessions',
      '2026-08-07T16-49-48-393Z_019fdd21-8169-7a02-8f11-eef6c9ca11cc.jsonl',
    )
    const wfPath = await writeWfState(dir, '--root-cwd--', [
      JSON.stringify({
        v: 'wf-run-v1',
        runId: 'wf-1786121304924-r7vgov',
        state: {
          status: 'done',
          calls: [
            { id: 0, status: 'done', sessionFile: subPath, sessionId: 'sa-x' },
            { id: 1, status: 'done', result: { sessionFile: gced, durationMs: 1 } },
          ],
        },
      }),
    ])
    await writeWfLink(dir, '--root-cwd--', ROOT, { runId: 'wf-1786121304924-r7vgov', path: wfPath })

    const family = await buildFamilyFromFs(ROOT, dir)

    expect(family.workflows).toHaveLength(1)
    const wf = family.workflows[0]
    expect(wf.runId).toBe('wf-1786121304924-r7vgov')
    expect(wf.stateFile).toBe(wfPath)
    expect(wf.calls).toHaveLength(2)
    // 命中 pathToRef：完整 ref（真实 id / mtime / size / cwd）
    expect(wf.calls[0].fileName).toBe(subPath)
    expect(wf.calls[0].sessionId).toBe(SUB_REAL)
    expect(wf.calls[0].mtime).toBeGreaterThan(0)
    expect(wf.calls[0].sizeBytes).toBeGreaterThan(0)
    expect(wf.calls[0].cwd).toBe('/proj/--root-cwd--')
    // GC\'d 未命中：fileName-only 最小 ref（sessionId 从文件名提取，mtime/size/cwd 占位）
    expect(wf.calls[1].fileName).toBe(gced)
    expect(wf.calls[1].sessionId).toBe('019fdd21-8169-7a02-8f11-eef6c9ca11cc')
    expect(wf.calls[1].mtime).toBe(0)
    expect(wf.calls[1].sizeBytes).toBe(0)
    expect(wf.calls[1].cwd).toBe('')
  })

  it('workflows：NEW 格式坏尾行回退上一快照；顶层 sessionFile 优先于 result.sessionFile', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    const topLevel = join(
      dir,
      'subagents',
      '--root-cwd--',
      'sessions',
      '2026-08-01T00-00-00-000Z_019fdd11-1111-1111-1111-111111111111.jsonl',
    )
    const inResult = join(
      dir,
      'subagents',
      '--root-cwd--',
      'sessions',
      '2026-08-02T00-00-00-000Z_019fdd22-2222-2222-2222-222222222222.jsonl',
    )
    const snap = JSON.stringify({
      v: 'wf-run-v1',
      runId: 'wf-x',
      state: { calls: [{ id: 0, sessionFile: topLevel, result: { sessionFile: inResult } }] },
    })
    // 尾行坏 JSON → readWorkflowCallSessionFiles 从尾向头回退到上一有效快照
    const wfPath = await writeWfState(dir, '--root-cwd--', [snap, '{broken json'])
    await writeWfLink(dir, '--root-cwd--', ROOT, { runId: 'wf-x', path: wfPath })

    const family = await buildFamilyFromFs(ROOT, dir)

    expect(family.workflows).toHaveLength(1)
    expect(family.workflows[0].calls).toHaveLength(1)
    // 顶层 sessionFile 优先（result.sessionFile 不覆盖）
    expect(family.workflows[0].calls[0].fileName).toBe(topLevel)
  })

  it('workflows：OLD 格式（无 v）callCache [{key,value}] → value.sessionFile + value.result.sessionFile 回退；无 sessionFile 的 call 不产出', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    const viaValue = join(
      dir,
      'subagents',
      '--root-cwd--',
      'sessions',
      '2026-08-03T00-00-00-000Z_019fdd33-3333-3333-3333-333333333333.jsonl',
    )
    const viaResult = join(
      dir,
      'subagents',
      '--root-cwd--',
      'sessions',
      '2026-08-04T00-00-00-000Z_019fdd44-4444-4444-4444-444444444444.jsonl',
    )
    const wfPath = await writeWfState(dir, '--root-cwd--', [
      JSON.stringify({
        runId: 'wf-old-1',
        name: 'old-wf',
        status: 'done',
        callCache: [
          // 真实 OLD 数据形态：value 无 sessionFile（旧 pi 不持久化）→ 不产出
          { key: 1, value: { content: 'PASS', durationMs: 100 } },
          // value.sessionFile（源码注释 OLD 分支读取点）
          { key: 2, value: { sessionFile: viaValue, content: 'ok' } },
          // value.result.sessionFile 回退
          { key: 3, value: { result: { sessionFile: viaResult, durationMs: 1 } } },
          // value 非对象 → 整项兜底（无 sessionFile → 不产出）
          { key: 4, value: 'str' },
        ],
      }),
    ])
    await writeWfLink(dir, '--root-cwd--', ROOT, { runId: 'wf-old-1', path: wfPath })

    const family = await buildFamilyFromFs(ROOT, dir)

    expect(family.workflows).toHaveLength(1)
    expect(family.workflows[0].calls.map((c) => c.fileName)).toEqual([viaValue, viaResult])
    // 未命中 pathToRef → 最小 ref：sessionId 从文件名提取，mtime 占位 0
    expect(family.workflows[0].calls[0].sessionId).toBe('019fdd33-3333-3333-3333-333333333333')
    expect(family.workflows[0].calls[0].mtime).toBe(0)
  })

  it('MF-3 回归：alive 但无 identity 的 subagent（运行中）不被收编为 cleanedUp——U4 后 manifest 主路径建族', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    // 运行中 subagent：有效 header、无 identity 尾行（identity 完成时才写入），manifest 已存在
    const subDir = join(dir, 'subagents', '--root-cwd--', 'sessions')
    await mkdir(subDir, { recursive: true })
    const subPath = join(subDir, SUB_REAL + '.jsonl')
    await writeFile(
      subPath,
      JSON.stringify({ type: 'session', id: SUB_REAL, cwd: '/proj/root' }) + '\n',
    )
    await writeRecordManifest(dir, '--root-cwd--', `sa-${SUB_REAL}`, {
      rootSessionId: ROOT,
      agentName: 'explorer',
      sessionFile: subPath,
    })

    const family = await buildFamilyFromFs(ROOT, dir)
    // U4 语义变化（TC-manifest-source）：m0 时 alive 无 identity → 完全丢弃（无数据源建族）。
    // U4 manifest 主路径：manifest 命中即建族（manifest 有 rootSessionId），不再依赖 identity。
    // MF-3 核心保护仍生效：不被收编为 cleanedUp（fileStats 有 realId → cleanedUp=false）。
    const sub = family.subagents.find((s) => s.sessionId === SUB_REAL)
    expect(sub).toBeDefined()
    expect(sub!.cleanedUp).toBe(false) // 核心：运行中不被当孤儿
    expect(sub!.rootSessionId).toBe(ROOT) // manifest 主：rootSessionId 从 manifest 透传
    expect(sub!.agentName).toBe('explorer') // manifest.agentName → agentName
    // 无 identity 尾行 → task/model/status 取决于 manifest（本 fixture manifest 未写这些 → undefined）
    expect(sub!.task).toBeUndefined()
    expect(sub!.model).toBeUndefined()
    expect(family.subagents.every((s) => s.cleanedUp === false)).toBe(true)
  })
})

// ============================================================
// 真实数据集成测试（~/.pi/agent）
// ============================================================

describe.skipIf(!HAS_REAL_ROOT)('buildFamilyFromFs - 真实数据 ~/.pi/agent', () => {
  it('019fe620 family：fork 019fe632（跨 cwd）+ 隔代 subagent 019fe635（真实 id）', async () => {
    // 数据守卫：019fe632（sessions/）与 019fe635（subagents/）位于活跃数据目录，
    // 被 GC/重命名时跳过而非失败（同 TC14-TC18 守卫模式），避免偶发红。
    if (!hasAnyRealSession('019fe632') || !hasAnyRealSession('019fe635')) return
    const family = await buildFamilyFromFs(
      '019fe620-8ae1-78a7-b76a-43a1ba4cc3c7',
      REAL_AGENT_DIR,
    )
    // fork 019fe632（cwd feat-optimize-todo-goal，与 root 的 fix-cw-tool-wroktree 不同）
    const fork = family.forks.find((f) => f.sessionId.startsWith('019fe632'))
    expect(fork).toBeDefined()
    // 隔代 subagent：rootSessionId=019fe632（fork 子代），sessionId 真实（019fe635 开头，非 sa-）
    const sub = family.subagents.find(
      (s) => s.rootSessionId.startsWith('019fe632') && s.sessionId.startsWith('019fe635'),
    )
    expect(sub).toBeDefined()
    expect(sub!.sessionId.startsWith('sa-')).toBe(false)
  }, REAL_DATA_TIMEOUT_MS)
})

describe.skipIf(!HAS_REAL_WF)('buildFamilyFromFs - 真实 workflow 数据', () => {
  it('019fdcda：workflows 非空，至少一个 workflow calls>=4', async () => {
    // 数据守卫：workflow-state 快照文件可能被清理（wf-state 是会话运行产物），
    // 019fdcda 的 workflow-state-link 指向的快照不存在时跳过而非失败。
    const wfFile = execSync(
      `find ${REAL_AGENT_DIR}/sessions -name '*019fdcda*' -name '*.jsonl' ! -name '*.finalized' 2>/dev/null | head -1`,
      { encoding: 'utf8' },
    ).trim()
    if (!wfFile) return
    const raw = execSync(`grep -c 'workflow-state-link' '${wfFile}' 2>/dev/null || true`, {
      encoding: 'utf8',
    }).trim()
    if (raw === '0' || raw === '') return
    const family = await buildFamilyFromFs(
      '019fdcda-75c7-74b7-a160-f67f6bf88384',
      REAL_AGENT_DIR,
    )
    expect(family.workflows.length).toBeGreaterThan(0)
    // wf-1786121387659-5voqzc 有 4 个 agent() calls（sessionFile 持久化）
    const rich = family.workflows.find((w) => w.calls.length >= 4)
    expect(rich).toBeDefined()
    // calls 的 sessionFile 路径已落入 fileName（sessionRefFromPath）
    expect(rich!.calls.every((c) => c.fileName.length > 0)).toBe(true)
    // stateFile 是 wf-state 文件绝对路径
    expect(rich!.stateFile.endsWith('.jsonl')).toBe(true)
    expect(rich!.runId.startsWith('wf-')).toBe(true)
  }, REAL_DATA_TIMEOUT_MS)
})

// ============================================================
// w2 TC1：listRecordManifests + RecordManifest 导出（IF2/DM2，行为零变更验证）
// ============================================================

describe('listRecordManifests 导出（w2 TC1）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeAgentDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('导出生效：import + 调用返回 RecordManifest[]，字段完整', async () => {
    await writeRecordManifest(dir, '--demo-cwd--', 'sa-tc1', {
      rootSessionId: 'root-1',
      agentName: 'explorer',
      sessionFile: '/tmp/sa-tc1.jsonl',
    })
    const manifests: RecordManifest[] = await listRecordManifests(dir)
    expect(manifests).toHaveLength(1)
    const m = manifests[0]
    expect(m.id).toBe('sa-tc1')
    expect(m.rootSessionId).toBe('root-1')
    expect(m.agentName).toBe('explorer')
    expect(m.sessionFile).toBe('/tmp/sa-tc1.jsonl')
  })
})

// ============================================================
// U4 端到端：buildFamilyFromFs 富化（manifest 主 / P-fallback identity 回退 / orphan / compat）
// 验证数据流重组：manifest 索引命中透全字段，未命中读尾行 identity 回退，孤儿 manifest 富字段+cleanedUp
// ============================================================

describe('U4 buildFamilyFromFs 富化（manifest 主 / P-fallback）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeAgentDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('TC-u4-manifest-enrich: alive + manifest 全字段 → SubagentRef 富字段全透传', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    const subPath = await writeSubagentSession(dir, '--root-cwd--', SUB_REAL, {
      rootSessionId: ROOT,
      slug: 'identity-slug', // identity.slug，manifest 主时被 manifest.slug 覆盖
      task: 'identity-task', // identity.task，manifest 主时被 manifest.task 覆盖
      agent: 'worker', // identity.agent，manifest 主时被 manifest.agentName 覆盖
    })
    // manifest 全字段（命中 meta.path 索引 → 走 manifest 主路径，覆盖 identity 值）
    await writeRecordManifest(dir, '--root-cwd--', `sa-${SUB_REAL}`, {
      rootSessionId: ROOT,
      agentName: 'explorer',
      sessionFile: subPath,
      task: '调研 codex',
      slug: 'codex-ask-user-research',
      model: 'glm-5.2',
      status: 'completed',
    })

    const family = await buildFamilyFromFs(ROOT, dir)
    const sub = family.subagents.find((s) => s.sessionId === SUB_REAL)

    expect(sub).toBeDefined()
    // manifest 主：富字段从 manifest 透传（覆盖 identity 的值）
    expect(sub!.task).toBe('调研 codex')
    expect(sub!.slug).toBe('codex-ask-user-research')
    expect(sub!.agentName).toBe('explorer') // manifest.agentName → agentName
    expect(sub!.model).toBe('glm-5.2')
    expect(sub!.status).toBe('completed')
    expect(sub!.sessionFile).toBe(subPath)
    expect(sub!.cleanedUp).toBe(false)
    expect(sub!.rootSessionId).toBe(ROOT)
  })

  it('TC-u4-pfallback-identity: alive 无 manifest + identity 含 task/agent → 回退 identity，model/status undefined', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    // 只写 alive session（含 identity 尾行），不写 manifest → P-fallback 路径
    const subPath = await writeSubagentSession(dir, '--root-cwd--', SUB_REAL, {
      rootSessionId: ROOT,
      slug: 'fix',
      task: 'fix bug',
      agent: 'worker',
    })

    const family = await buildFamilyFromFs(ROOT, dir)
    const sub = family.subagents.find((s) => s.sessionId === SUB_REAL)

    expect(sub).toBeDefined()
    // P-fallback：task/agent/sessionFile 从 identity 回退
    expect(sub!.task).toBe('fix bug')
    expect(sub!.slug).toBe('fix')
    expect(sub!.agentName).toBe('worker') // identity.data.agent → agentName
    expect(sub!.sessionFile).toBe(subPath) // P-fallback sessionFile=alive meta.path
    // P-fallback 核心断言：model/status 不可回退，必 undefined
    expect(sub!.model).toBeUndefined()
    expect(sub!.status).toBeUndefined()
    expect(sub!.cleanedUp).toBe(false)
  })

  it('TC-u4-pfallback-no-identity: alive 无 manifest 无 identity（运行中）→ 不入 family.subagents，不抛错', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    // alive 文件无 identity 尾行（运行中/异常），无 manifest
    await writeAliveSubagentNoIdentity(dir, '--root-cwd--', SUB_REAL)

    // 核心断言：buildFamilyFromFs 不抛错、不崩溃
    const family = await buildFamilyFromFs(ROOT, dir)

    // 无 manifest 无 identity → 无法确定 rootSessionId → 不入 family.subagents
    const sub = family.subagents.find((s) => s.sessionId === SUB_REAL)
    expect(sub).toBeUndefined()
  })

  it('TC-u4-orphan-manifest: manifest 全字段 + sessionFile 指向不存在路径 → 孤儿 cleanedUp=true，富字段透传', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    const ghostPath = '/nonexistent/gc-ghost.jsonl' // .jsonl 已被 GC（不写该文件）
    await writeRecordManifest(dir, '--root-cwd--', 'sa-ghost-id', {
      rootSessionId: ROOT,
      agentName: 'worker',
      sessionFile: ghostPath,
      task: 'ghost task',
      slug: 'ghost-slug',
      model: 'gpt-4',
      status: 'completed',
    })

    const family = await buildFamilyFromFs(ROOT, dir)
    const ghost = family.subagents.find((s) => s.sessionId === 'sa-ghost-id')

    expect(ghost).toBeDefined()
    expect(ghost!.cleanedUp).toBe(true) // 文件 GC → cleanedUp
    // 孤儿用 manifest 完整富字段
    expect(ghost!.task).toBe('ghost task')
    expect(ghost!.slug).toBe('ghost-slug')
    expect(ghost!.agentName).toBe('worker')
    expect(ghost!.model).toBe('gpt-4')
    expect(ghost!.status).toBe('completed')
    expect(ghost!.sessionFile).toBe(ghostPath) // GC 路径保留（不置空）
    expect(ghost!.rootSessionId).toBe(ROOT)
  })

  it('TC-u4-recordmanifest-compat: 旧 manifest（仅 id/rootSessionId/sessionFile）→ 富字段 undefined，不抛错', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    // 旧格式 manifest：无 task/slug/model/status/agentName
    await writeRecordManifest(dir, '--root-cwd--', 'sa-old', {
      rootSessionId: ROOT,
      sessionFile: '/nonexistent/old.jsonl',
    })

    // listRecordManifests 兼容：返回该 manifest，富字段 undefined
    const manifests = await listRecordManifests(dir)
    expect(manifests).toHaveLength(1)
    const m = manifests[0]
    expect(m.id).toBe('sa-old')
    expect(m.rootSessionId).toBe(ROOT)
    expect(m.task).toBeUndefined()
    expect(m.slug).toBeUndefined()
    expect(m.model).toBeUndefined()
    expect(m.status).toBeUndefined()
    expect(m.agentName).toBeUndefined()

    // buildFamilyFromFs 消费旧 manifest（孤儿路径）不抛错，富字段 undefined
    const family = await buildFamilyFromFs(ROOT, dir)
    const ghost = family.subagents.find((s) => s.sessionId === 'sa-old')
    expect(ghost).toBeDefined()
    expect(ghost!.cleanedUp).toBe(true)
    expect(ghost!.task).toBeUndefined()
    expect(ghost!.model).toBeUndefined()
    // 旧 manifest slug 缺失 → 回退 agentName（也缺）→ 空串兜底
    expect(ghost!.slug).toBe('')
  })
})

// ============================================================
// U4 C4 契约：extractSessionIdFromFilename 导出（仅加 export，不改逻辑，供 w4 复用）
// ============================================================

describe('U4 extractSessionIdFromFilename 导出（C4 契约）', () => {
  it('导出生效：从 <timestamp>_<sessionId>.jsonl 提取 sessionId', () => {
    expect(
      extractSessionIdFromFilename('2026-08-07T16-49-48-393Z_019fdd21-8169-7a02-8f11-eef6c9ca11cc.jsonl'),
    ).toBe('019fdd21-8169-7a02-8f11-eef6c9ca11cc')
  })

  it('非 uuid 特征文件名 → 空串（行为不变）', () => {
    expect(extractSessionIdFromFilename('not-a-uuid.jsonl')).toBe('')
    expect(extractSessionIdFromFilename('readme.txt')).toBe('')
  })

  it('无下划线的纯 uuid 文件名 → 返回 uuid（兼容简化场景）', () => {
    expect(extractSessionIdFromFilename('019fdd21-8169-7a02-8f11-eef6c9ca11cc.jsonl')).toBe(
      '019fdd21-8169-7a02-8f11-eef6c9ca11cc',
    )
  })
})

// ============================================================
// U4 真实数据守卫（TC-u4-real-data-guard）：~/.pi/agent 富字段从 manifest 正确透传
// ============================================================

const HAS_REAL_SUBAGENTS_DIR = existsSync(join(REAL_AGENT_DIR, 'subagents'))

describe.skipIf(!HAS_REAL_ROOT || !HAS_REAL_SUBAGENTS_DIR)('U4 真实数据守卫：~/.pi/agent', () => {
  it('TC-u4-real-data-guard: 019fe620 subagents 富字段透传（manifest 主 task 非空率 > 80%）', async () => {
    // 数据守卫：019fe635 是 019fe620 家族已知的隔代 subagent（含 task 富字段的锚点），
    // 被 GC 后跳过富字段验证（manifest 数据不可复现，跳过比失败合理）。
    if (!hasAnyRealSession('019fe635')) return
    const family = await buildFamilyFromFs(
      '019fe620-8ae1-78a7-b76a-43a1ba4cc3c7',
      REAL_AGENT_DIR,
    )
    // 有 subagent 才验证富字段（019fe620 确有隔代 subagent，见既有真实数据测试）
    expect(family.subagents.length).toBeGreaterThan(0)

    // manifest 主的 subagent（model !== undefined 近似判定，探针 manifest 20/20 有 model）：
    // task 非空率应 > 80%（探针 20/20 manifest 全有 task）
    const manifestSourced = family.subagents.filter((s) => s.model !== undefined)
    if (manifestSourced.length > 0) {
      const withTask = manifestSourced.filter((s) => s.task !== undefined && s.task !== '')
      expect(withTask.length / manifestSourced.length).toBeGreaterThan(0.8)
    }

    // P-fallback 的 subagent（model === undefined）：status 必 undefined（identity 不可回退 status）
    const pfallback = family.subagents.filter((s) => s.model === undefined)
    expect(pfallback.every((s) => s.status === undefined)).toBe(true)

    // 所有 subagent 的 sessionFile 非空（manifest.sessionFile 或 alive meta.path）
    expect(family.subagents.every((s) => typeof s.sessionFile === 'string' && s.sessionFile.length > 0)).toBe(true)
  }, REAL_DATA_TIMEOUT_MS)
})
