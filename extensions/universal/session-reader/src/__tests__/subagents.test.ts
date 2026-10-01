import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildFamilyFromFs,
  listRecordManifests,
  extractSessionIdFromFilename,
  type RecordManifest,
} from '../discovery/subagents.js'
import { resolveSessionRoots } from '../discovery/roots.js'
import { parseSessionHeader, readSessionHeaderFirstLine } from '../discovery/session-header.js'

// ---- fixture 常量（uuid 特征，满足 extractSessionIdFromFilename + 互不为子串）----
const ROOT = '0aaaaaaa-bbbb-7ccc-dddd-000000000001'
const FORK = '0aaaaaaa-bbbb-7ccc-dddd-000000000002'
const SUB_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000003'

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

  it('workflows：v2 注册条目 record 流直读提 calls；命中 pathToRef 取完整 ref，GC\'d 路径回退最小 ref', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    // 真实存在的 subagent（步骤 2 扫到 → pathToRef 命中 → 完整 SessionRef）
    const subPath = await writeSubagentSession(dir, '--root-cwd--', SUB_REAL, {
      rootSessionId: ROOT,
      slug: 'wf-sub',
    })
    // GC'd 路径（文件不存在 → pathToRef 未命中 → sessionRefFromPath 最小 ref）
    const gced = join(
      dir,
      'subagents',
      '--root-cwd--',
      'sessions',
      '2026-08-07T16-49-48-393Z_019fdd21-8169-7a02-8f11-eef6c9ca11cc.jsonl',
    )
    // record 流：agent-settled 帧携带 result.sessionFile（两 call：命中 + GC 各一）
    const wfDir = join(dir, 'sessions', '--root-cwd--', 'workflow-state')
    await mkdir(wfDir, { recursive: true })
    const recordPath = join(wfDir, 'wf-v2-rich.record.jsonl')
    await writeFile(
      recordPath,
      [
        JSON.stringify({ type: 'run-created', seq: 1, ts: 1000, runId: 'wf-v2-rich', workflowName: 'rich', argsSummary: '{}' }),
        JSON.stringify({ type: 'agent-settled', seq: 2, ts: 1100, taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 1, result: { content: 'ok', sessionFile: subPath } }),
        JSON.stringify({ type: 'agent-settled', seq: 3, ts: 1200, taskIndex: 1, attempt: 1, outcome: 'done', durationMs: 1, result: { content: 'ok', sessionFile: gced } }),
      ].join('\n') + '\n',
    )
    const line = JSON.stringify({
      type: 'custom',
      id: 'wf-record-wf-v2-rich',
      parentId: ROOT,
      customType: 'workflow-record',
      data: {
        v: 2,
        kind: 'registered',
        runId: 'wf-v2-rich',
        workflowName: 'rich',
        scriptName: 'rich',
        slug: 'rich',
        startedAt: 1,
        recordPath,
      },
      timestamp: '2026-08-07T16:48:24.933Z',
    })
    await writeFile(join(dir, 'sessions', '--root-cwd--', `${ROOT}.jsonl`), line + '\n', { flag: 'a' })

    const family = await buildFamilyFromFs(ROOT, dir)

    expect(family.workflows).toHaveLength(1)
    const wf = family.workflows[0]
    expect(wf.runId).toBe('wf-v2-rich')
    expect(wf.stateFile).toBe(recordPath)
    expect(wf.calls).toHaveLength(2)
    // 命中 pathToRef：完整 ref（真实 id / mtime / size / cwd）
    expect(wf.calls[0].fileName).toBe(subPath)
    expect(wf.calls[0].sessionId).toBe(SUB_REAL)
    expect(wf.calls[0].mtime).toBeGreaterThan(0)
    expect(wf.calls[0].sizeBytes).toBeGreaterThan(0)
    expect(wf.calls[0].cwd).toBe('/proj/--root-cwd--')
    // GC'd 未命中：fileName-only 最小 ref（sessionId 从文件名提取，mtime/size/cwd 占位）
    expect(wf.calls[1].fileName).toBe(gced)
    expect(wf.calls[1].sessionId).toBe('019fdd21-8169-7a02-8f11-eef6c9ca11cc')
    expect(wf.calls[1].mtime).toBe(0)
    expect(wf.calls[1].sizeBytes).toBe(0)
    expect(wf.calls[1].cwd).toBe('')
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
// .events 文件族结构性忽略（W1 D3 落点裁决 + 设计检查点④）
// ============================================================
//
// record 事件文件族（<recordsDir>/<sa-id>.events，无 .jsonl 后缀）与 manifest 同目录
// 同主名。session-reader 的两层兼容形态在此断言：
// ① 结构性忽略——subagents 树扫描只收 .jsonl，.events 天然不进候选集（D3「无后缀
//    的结构性收益」：被忽略或被误读两类风险一次排空）；
// ② 首行头行读者兼容——.events 首行是自描述头行 {"type":"record-journal","id":...}
//    （写侧 record-events.ts toRecordEventHeader 契约），session-reader 对未知文件
//    读首行判 header 时命中非 session header 即忽略（检查点④：零成本兼容——不改
//    扫描器即可与该文件族共存）。

describe('.events 文件族结构性忽略（W1 D3 / 检查点④）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeAgentDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 写 record 事件文件（首行头行 + 事件行集，形态对齐写侧 record-events.ts）。 */
  async function writeEventsFile(slug: string, saId: string): Promise<string> {
    const recordsDir = join(dir, 'subagents', slug, 'records')
    await mkdir(recordsDir, { recursive: true })
    const path = join(recordsDir, `${saId}.events`)
    const lines = [
      JSON.stringify({ type: 'record-journal', id: saId }),
      JSON.stringify({ type: 'record-created', seq: 1, ts: 1, agent: 'dev', task: 't', slug: 's', origin: 'tool', rootSessionId: ROOT, depth: 0, mode: 'sync', startedAt: 1 }),
      JSON.stringify({ type: 'record-settled', seq: 2, ts: 2, stopReason: 'end_turn', endedAt: 2, turns: 1, totalTokens: 5 }),
    ]
    await writeFile(path, lines.join('\n') + '\n')
    return path
  }

  it('subagent 树扫描不收 .events：resolveSessionRoots 的 subagent 根 files 含 .jsonl 不含 .events', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    const subPath = await writeSubagentSession(dir, '--root-cwd--', SUB_REAL, {
      rootSessionId: ROOT,
      slug: 'ev-sibling',
    })
    await writeEventsFile('--root-cwd--', 'sa-ev-1')

    const roots = await resolveSessionRoots({ agentDir: dir })
    const subRoot = roots.find((r) => r.kind === 'subagent')

    expect(subRoot).toBeDefined()
    expect(subRoot!.files.map((f) => f.path)).toContain(subPath)
    expect(subRoot!.files.some((f) => f.path.endsWith('.events'))).toBe(false)
  })

  it('首行头行命中非 session header 即忽略：record-journal 头行 → parseSessionHeader 返回 null', async () => {
    const eventsPath = await writeEventsFile('--root-cwd--', 'sa-ev-1')
    // 检查点④形态：session-reader 对未知文件读首行判 header，非 session 行 → null
    //（即使未来通配规则把 .events 收进候选集，该文件也不会被误认成 session）
    const firstLine = await readSessionHeaderFirstLine(eventsPath)
    expect(firstLine).toBeDefined()
    expect(parseSessionHeader(firstLine)).toBeNull()
  })

  it('家族扫描：.events 与正常 subagent 同目录共存 → 家族正常、不产幻影 subagent 节点', async () => {
    await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
    await writeSubagentSession(dir, '--root-cwd--', SUB_REAL, {
      rootSessionId: ROOT,
      slug: 'ev-coexist',
    })
    await writeEventsFile('--root-cwd--', 'sa-ev-1')

    const family = await buildFamilyFromFs(ROOT, dir)

    // 正常 subagent 在场
    expect(family.subagents.some((s) => s.sessionId === SUB_REAL)).toBe(true)
    // .events 的 record id 不进任何集合（无幻影）
    expect(family.subagents.some((s) => s.sessionId === 'sa-ev-1')).toBe(false)
    expect(family.subagents.some((s) => s.sessionId.startsWith('sa-ev'))).toBe(false)
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

// U4 富字段透传契约由 fixture 侧逐条覆盖：manifest 主（TC-u4-manifest-enrich，task/slug/
// model/status 全字段 + sessionFile 非空）、P-fallback（TC-u4-pfallback-identity，status 必
// undefined）、孤儿（TC-u4-orphan-manifest）、旧 manifest 兼容（TC-u4-recordmanifest-compat）。
