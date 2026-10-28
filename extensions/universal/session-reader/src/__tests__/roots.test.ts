// roots.test.ts —— session-reader C02 簇合并产物（round5-G）。
// 共同被测业务模块：`src/discovery/roots.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/execution-tree.test.ts（14 用例，skip 0）
//   - src/__tests__/roots.test.ts（21 用例，skip 0）
//   - src/__tests__/subagents.test.ts（21 用例，skip 0）

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { buildExecutionTree, formatExecutionTreeText, type ExecutionTreeNode } from '../core/execution-tree.js'
import { resolveStoreSubagentSessionsDir, resolveStoreSubagentRecordsDir, resolveSessionRoots, resolveSessionStoreRoot, normalizeLiveSessionDir, type SessionRoot, type SessionRootSignals } from '../discovery/roots.js'
import { buildFamilyFromFs, listRecordManifests, extractSessionIdFromFilename, type RecordManifest } from '../discovery/subagents.js'
import { FIX_E6 } from './fixtures.js'
import { parseSessionHeader, readSessionHeaderFirstLine } from '../discovery/session-header.js'

// ======== 来源：execution-tree.test.ts ========
describe("execution-tree", () => {
  /**
 * M3b U7 buildExecutionTree 单测（design m3b 6 testCases）。
 *
 * 测试框架 vitest（禁止 node:test/tsx）。fixture 自包含（mkdtemp 临时目录），复用
 * subagents.test.ts 验证过的 fixture 拓扑（main session + subagent session + records manifest
 * + workflow-state 文件 + workflow-state-link）。
 *
 * 覆盖：
 * - TC-m3b-nested-tree：任意深度 subagent↔workflow-call 相互嵌套（parentRecordId 精确链）
 * - TC-m3b-flat-fallback：旧机制扁平回退（全无 parentRecordId）
 * - TC-m3b-cycle-detection：workflow 指针环（A→B→A），visited Set 防环
 * - TC-m3b-single-node：单节点树（无后代，ES5）
 * - TC-m3b-source-priority：parentRecordId 三级数据源优先级（manifest>identity>flat，DM4）
 * - TC-m3b-real-data-guard：真实形态数据检查（合成 fixture）：mkdtemp 临时目录仿真真实
 *   agentDir 布局（时间戳前缀文件名 / 新旧机制混合 / 孤儿 manifest / 坏 manifest / 外来
 *   家族），guard 语义断言——解析不抛错 / 树非空 / 结构自洽，不锁 sourceMode 具体值
 */

  // ---- fixture 常量（uuid 特征，互不为子串，满足 extractSessionIdFromFilename）----
  const MAIN = '0aaaaaaa-bbbb-7ccc-dddd-000000000001'
  const A_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000002'
  const B_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000003'
  const C_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000004'
  const D_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000005'
  const X_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000006'
  // workflow-state-link runId
  const RUN_A = 'wf-1786121304924-runA'
  const RUN_B = 'wf-1786121304924-runB'

  // ---- fixture helpers（自包含，拓扑同 subagents.test.ts）----

  async function makeAgentDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'exec-tree-test-'))
  }

  /** 写 main session 文件（首行 header）。 */
  async function writeMainSession(dir: string, slug: string, id: string): Promise<string> {
    const sessionDir = join(dir, 'sessions', slug)
    await mkdir(sessionDir, { recursive: true })
    const path = join(sessionDir, `${id}.jsonl`)
    await writeFile(path, JSON.stringify({ type: 'session', id, cwd: `/proj/${slug}` }) + '\n')
    return path
  }

  /**
 * 写 subagent session 文件：首行 header（真实 id）+ 占位 message + 尾行 identity。
 * identity 尾行含 rootSessionId/slug/agent，可选 parentRecordId（数据源 ② 测试用）。
 * fileName 可选：默认 `<realId>.jsonl`；真实形态检查用例传时间戳前缀名（<ts>_<id>.jsonl）。
 */
  async function writeSubagentSession(
    dir: string,
    rootSessionId: string,
    realId: string,
    identity: {
      rootSessionId: string
      slug: string
      agent?: string
      parentRecordId?: string
      task?: string
    },
    fileName: string = `${realId}.jsonl`,
  ): Promise<string> {
    const sessionDir = resolveStoreSubagentSessionsDir(dir, rootSessionId)
    await mkdir(sessionDir, { recursive: true })
    const path = join(sessionDir, fileName)
    const data: Record<string, unknown> = {
      id: `sa-${realId.slice(0, 8)}`,
      rootSessionId: identity.rootSessionId,
      slug: identity.slug,
      agent: identity.agent ?? 'explorer',
      mode: 'sync',
      task: identity.task ?? 'do work',
      startedAt: 1,
    }
    if (identity.parentRecordId !== undefined) data.parentRecordId = identity.parentRecordId
    const lines = [
      JSON.stringify({ type: 'session', id: realId, cwd: `/proj/${rootSessionId}` }),
      JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: realId,
        message: { role: 'user', content: 'do work' },
      }),
      JSON.stringify({ type: 'custom', customType: 'subagent-identity', data }),
    ]
    await writeFile(path, lines.join('\n') + '\n')
    return path
  }

  /** 写 records manifest。fields 含必填 + 可选 parentRecordId（数据源 ①）。 */
  async function writeRecordManifest(
    dir: string,
    rootSessionId: string,
    id: string,
    fields: {
      rootSessionId: string
      agentName?: string
      sessionFile: string
      task?: string
      slug?: string
      model?: string
      status?: string
      parentRecordId?: string
    },
  ): Promise<void> {
    const recordsDir = resolveStoreSubagentRecordsDir(dir, rootSessionId)
    await mkdir(recordsDir, { recursive: true })
    await writeFile(join(recordsDir, `${id}.json`), JSON.stringify({ id, ...fields }))
  }

  /** [ADR-0095] v2 单档 fixture：写 record 流（agent-settled 帧提 calls）并向 session 文件
 *  追加 v2 注册条目——替代已删除的 wf-state 快照 + workflow-state-link 组合。 */
  async function writeWfV2Run(
    dir: string,
    cwdSlug: string,
    sessionPath: string,
    sessionId: string,
    runId: string,
    callSessionFiles: string[],
  ): Promise<string> {
    const wfDir = join(dir, 'sessions', cwdSlug, 'workflow-state')
    await mkdir(wfDir, { recursive: true })
    const recordPath = join(wfDir, `${runId}.record.jsonl`)
    const lines = [
      JSON.stringify({ type: 'run-created', seq: 1, ts: 1758000000000, runId, workflowName: 'tree-flow', argsSummary: '{}' }),
      ...callSessionFiles.map((sf, i) =>
        JSON.stringify({ type: 'agent-settled', seq: 2 + i, ts: 1758000001000 + i, taskIndex: i, attempt: 1, outcome: 'done', durationMs: 100, result: { content: 'ok', sessionFile: sf } }),
      ),
    ]
    await writeFile(recordPath, lines.join('\n') + '\n')
    const line = JSON.stringify({
      type: 'custom',
      id: `wf-reg-${runId}`,
      parentId: sessionId,
      customType: 'workflow-record',
      data: {
        v: 2,
        kind: 'registered',
        runId,
        workflowName: 'tree-flow',
        scriptName: 'tree-flow',
        slug: 'tree',
        startedAt: 1758000000000,
        recordPath,
      },
      timestamp: '2026-09-28T00:00:00Z',
    })
    await writeFile(sessionPath, line + '\n', { flag: 'a' })
    return recordPath
  }

  /** 在节点树里按 type+sessionId 查找节点（DFS）。 */
  function findNode(
    node: ExecutionTreeNode,
    type: string,
    sidPrefix: string,
  ): ExecutionTreeNode | undefined {
    if (node.type === type && node.sessionId.startsWith(sidPrefix)) return node
    for (const c of node.children) {
      const found = findNode(c, type, sidPrefix)
      if (found) return found
    }
    return undefined
  }

  // ============================================================
  // fixture 用例
  // ============================================================

  describe('buildExecutionTree - fixture', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻）

    beforeEach(async () => {
      dataDir = await makeAgentDir()
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('TC-m3b-nested-tree：main→subagent A→{workflow-call B, subagent C} 相互嵌套（parentRecordId 精确链）', async () => {
      await writeMainSession(dir, '--main-cwd--', MAIN)
      // subagent A（顶层，parentRecordId=undefined），sessionFile 含 workflow-state-link → call session B
      const saA = await writeSubagentSession(dir, MAIN, A_REAL, {
        rootSessionId: MAIN,
        slug: 'sub-a',
      })
      const recAId = 'sa-record-A'
      await writeRecordManifest(dir, MAIN, recAId, {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saA,
        status: 'completed',
        parentRecordId: undefined,
      })
      // subagent C（A 的后代，parentRecordId=recAId，精确链）
      const saC = await writeSubagentSession(dir, MAIN, C_REAL, {
        rootSessionId: MAIN,
        slug: 'sub-c',
      })
      await writeRecordManifest(dir, MAIN, 'sa-record-C', {
        rootSessionId: MAIN,
        agentName: 'worker',
        sessionFile: saC,
        status: 'completed',
        parentRecordId: recAId,
      })
      // workflow-call B：A 的 sessionFile 的 v2 注册条目 → record 流 → calls[].sessionFile = SB
      const sbB = join(
        resolveStoreSubagentSessionsDir(dir, MAIN),
        `2026-08-07T16-49-48-393Z_${B_REAL}.jsonl`,
      )
      // B call session 文件需存在（resolveWorkflows 读 call sessionFile；这里只需路径，不读内容建树）
      await mkdir(resolveStoreSubagentSessionsDir(dir, MAIN), { recursive: true })
      await writeFile(sbB, JSON.stringify({ type: 'session', id: B_REAL, cwd: '/proj/wf' }) + '\n')
      await writeWfV2Run(dir, '--main-cwd--', saA, A_REAL, RUN_A, [sbB])

      const tree = await buildExecutionTree(MAIN, dir)

      // 根节点
      expect(tree.root.type).toBe('main')
      expect(tree.root.sessionId).toBe(MAIN)
      // root.children 含 A（subagent）
      const nodeA = findNode(tree.root, 'subagent', A_REAL)
      expect(nodeA).toBeDefined()
      expect(tree.root.children.some((c) => c === nodeA)).toBe(true)
      // A.children 含 B（workflow-call，runId/stateFile）
      const nodeB = findNode(tree.root, 'workflow-call', B_REAL)
      expect(nodeB).toBeDefined()
      expect(nodeA!.children.some((c) => c === nodeB)).toBe(true)
      expect(nodeB!.runId).toBe(RUN_A)
      // A.children 含 C（subagent，parentRecordId=recAId，严格 parentRecordId 链挂 A 下）
      const nodeC = findNode(tree.root, 'subagent', C_REAL)
      expect(nodeC).toBeDefined()
      expect(nodeA!.children.some((c) => c === nodeC)).toBe(true)
      expect(nodeC!.parentRecordId).toBe(recAId)
      // 树规模与精度
      expect(tree.totalNodes).toBe(4) // main + A + B + C
      expect(tree.maxDepth).toBe(2) // root=0, A=1, B/C=2
      expect(tree.sourceMode).toBe('precise')
      expect(tree.truncated).toBe(false)
    })

    it('TC-m3b-flat-fallback：旧机制全无 parentRecordId → 全挂 main（扁平）+ flat-fallback', async () => {
      await writeMainSession(dir, '--main-cwd--', MAIN)
      // 3 个顶层 subagent，全无 parentRecordId（旧机制）
      const saA = await writeSubagentSession(dir, MAIN, A_REAL, {
        rootSessionId: MAIN,
        slug: 'a',
      })
      await writeRecordManifest(dir, MAIN, 'sa-A', {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saA,
      })
      const saB = await writeSubagentSession(dir, MAIN, B_REAL, {
        rootSessionId: MAIN,
        slug: 'b',
      })
      await writeRecordManifest(dir, MAIN, 'sa-B', {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saB,
      })
      const saC = await writeSubagentSession(dir, MAIN, C_REAL, {
        rootSessionId: MAIN,
        slug: 'c',
      })
      await writeRecordManifest(dir, MAIN, 'sa-C', {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saC,
      })

      const tree = await buildExecutionTree(MAIN, dir)

      // 全挂 main（flat）
      expect(tree.root.children).toHaveLength(3)
      expect(tree.root.children.every((c) => c.type === 'subagent')).toBe(true)
      // 不丢弃任何 record
      expect(tree.totalNodes).toBe(4) // main + 3 subagent
      expect(tree.sourceMode).toBe('flat-fallback')
      expect(tree.truncated).toBe(false)
    })

    it('TC-m3b-cycle-detection：workflow 指针环 A→B→A，visited Set 防环 + truncated', async () => {
      await writeMainSession(dir, '--main-cwd--', MAIN)
      // A（顶层），A 的 workflow call → SB
      const saA = await writeSubagentSession(dir, MAIN, A_REAL, {
        rootSessionId: MAIN,
        slug: 'a',
      })
      await writeRecordManifest(dir, MAIN, 'sa-A', {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saA,
      })
      // B（顶层），B 的 workflow call → SA（指回 A，成环）
      const saB = await writeSubagentSession(dir, MAIN, B_REAL, {
        rootSessionId: MAIN,
        slug: 'b',
      })
      await writeRecordManifest(dir, MAIN, 'sa-B', {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saB,
      })
      await writeWfV2Run(dir, '--main-cwd--', saA, A_REAL, RUN_A, [saB])
      await writeWfV2Run(dir, '--main-cwd--', saB, B_REAL, RUN_B, [saA])

      const tree = await buildExecutionTree(MAIN, dir)

      // 环检测：truncated=true，不抛错
      expect(tree.truncated).toBe(true)
      // root.children 含 A, B（正常分支继续建树）
      expect(tree.root.children).toHaveLength(2)
      // A 下有 workflow-call 指向 B session；B 的 workflow 指回 A 被 visited 跳过（不无限递归）
      const nodeA = findNode(tree.root, 'subagent', A_REAL)
      expect(nodeA).toBeDefined()
      // A 至少展开了 workflow-call（B session 的 call）
      expect(nodeA!.children.some((c) => c.type === 'workflow-call')).toBe(true)
    })

    it('TC-m3b-single-node：无 subagent record、无 workflow → 单节点树（ES5）', async () => {
      await writeMainSession(dir, '--main-cwd--', MAIN)

      const tree = await buildExecutionTree(MAIN, dir)

      expect(tree.root.type).toBe('main')
      expect(tree.root.sessionId).toBe(MAIN)
      expect(tree.root.children).toEqual([])
      expect(tree.totalNodes).toBe(1)
      expect(tree.maxDepth).toBe(0)
      expect(tree.sourceMode).toBe('precise') // 无 record → 确定无后代（非回退），ES5
      expect(tree.truncated).toBe(false)
    })

    it('TC-m3b-source-priority：parentRecordId 三级数据源 manifest>identity>flat（DM4）', async () => {
      await writeMainSession(dir, '--main-cwd--', MAIN)
      // X：顶层 subagent（挂 main）
      const saX = await writeSubagentSession(dir, MAIN, A_REAL, {
        rootSessionId: MAIN,
        slug: 'x',
      })
      await writeRecordManifest(dir, MAIN, 'sa-X', {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saX,
      })
      // Y：manifest.parentRecordId=sa-X（数据源 ①，精确挂 X）
      const saY = await writeSubagentSession(dir, MAIN, B_REAL, {
        rootSessionId: MAIN,
        slug: 'y',
      })
      await writeRecordManifest(dir, MAIN, 'sa-Y', {
        rootSessionId: MAIN,
        agentName: 'worker',
        sessionFile: saY,
        parentRecordId: 'sa-X',
      })
      // Z：manifest 无 parentRecordId，但 identity.data.parentRecordId=sa-X（数据源 ②，精确挂 X）
      const saZ = await writeSubagentSession(dir, MAIN, C_REAL, {
        rootSessionId: MAIN,
        slug: 'z',
        parentRecordId: 'sa-X', // 写入 identity.data.parentRecordId
      })
      await writeRecordManifest(dir, MAIN, 'sa-Z', {
        rootSessionId: MAIN,
        agentName: 'worker',
        sessionFile: saZ,
        // manifest 无 parentRecordId → 走 ② identity
      })
      // W：manifest + identity 都无 parentRecordId（数据源 ③，flat 挂 main）
      const saW = await writeSubagentSession(dir, MAIN, '000000000005', {
        rootSessionId: MAIN,
        slug: 'w',
      })
      await writeRecordManifest(dir, MAIN, 'sa-W', {
        rootSessionId: MAIN,
        agentName: 'worker',
        sessionFile: saW,
      })

      const tree = await buildExecutionTree(MAIN, dir)

      // sourceMode=precise（Y/Z 有精确链）
      expect(tree.sourceMode).toBe('precise')
      // X 挂 main（顶层）
      const nodeX = findNode(tree.root, 'subagent', A_REAL)
      expect(nodeX).toBeDefined()
      expect(tree.root.children.some((c) => c === nodeX)).toBe(true)
      // Y 挂 X（manifest.parentRecordId=sa-X，①）
      const nodeY = findNode(tree.root, 'subagent', B_REAL)
      expect(nodeY).toBeDefined()
      expect(nodeX!.children.some((c) => c === nodeY)).toBe(true)
      expect(nodeY!.parentRecordId).toBe('sa-X')
      // Z 挂 X（identity.data.parentRecordId=sa-X，②）
      const nodeZ = findNode(tree.root, 'subagent', C_REAL)
      expect(nodeZ).toBeDefined()
      expect(nodeX!.children.some((c) => c === nodeZ)).toBe(true)
      expect(nodeZ!.parentRecordId).toBe('sa-X')
      // W 挂 main（flat，③）
      const nodeW = findNode(tree.root, 'subagent', '000000000005')
      expect(nodeW).toBeDefined()
      expect(tree.root.children.some((c) => c === nodeW)).toBe(true)
      expect(nodeW!.parentRecordId).toBeUndefined()
    })

    it('TC-m3b-mf1-dedup：call session 有 manifest（parentRecordId 链 + wf 指针双命中）只出现一次（MF-1）', async () => {
      await writeMainSession(dir, '--main-cwd--', MAIN)
      // A（顶层，parentRecordId=undefined），sessionFile 含 workflow-state-link → call session B
      const saA = await writeSubagentSession(dir, MAIN, A_REAL, {
        rootSessionId: MAIN,
        slug: 'sub-a',
      })
      const recAId = 'sa-record-A'
      await writeRecordManifest(dir, MAIN, recAId, {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saA,
        status: 'completed',
        parentRecordId: undefined,
      })
      // B：A 的 subagent 后代（parentRecordId=recA）+ A 的 workflow call 目标（双命中，MF-1 场景）
      const sbB = join(
        resolveStoreSubagentSessionsDir(dir, MAIN),
        `2026-08-07T16-49-48-393Z_${B_REAL}.jsonl`,
      )
      await mkdir(resolveStoreSubagentSessionsDir(dir, MAIN), { recursive: true })
      await writeFile(sbB, JSON.stringify({ type: 'session', id: B_REAL, cwd: '/proj/wf' }) + '\n')
      const recBId = 'sa-record-B'
      await writeRecordManifest(dir, MAIN, recBId, {
        rootSessionId: MAIN,
        agentName: 'worker',
        sessionFile: sbB,
        status: 'completed',
        parentRecordId: recAId,
      })
      // D：B 的 subagent 后代（验证 call session 内派生的嵌套 sub-subagent 仍正确挂到 B 下）
      const saD = await writeSubagentSession(dir, MAIN, D_REAL, {
        rootSessionId: MAIN,
        slug: 'sub-d',
      })
      await writeRecordManifest(dir, MAIN, 'sa-record-D', {
        rootSessionId: MAIN,
        agentName: 'worker',
        sessionFile: saD,
        status: 'completed',
        parentRecordId: recBId,
      })
      // A 的 v2 注册条目 → record 流 → calls[0].sessionFile = sbB
      await writeWfV2Run(dir, '--main-cwd--', saA, A_REAL, RUN_A, [sbB])

      const tree = await buildExecutionTree(MAIN, dir)

      // B 作为 subagent 出现一次（parentRecordId 链命中）
      const nodeBSub = findNode(tree.root, 'subagent', B_REAL)
      expect(nodeBSub).toBeDefined()
      expect(nodeBSub!.parentRecordId).toBe(recAId)
      // B 不作为 workflow-call 重复出现（MF-1 dedup）
      const nodeBWf = findNode(tree.root, 'workflow-call', B_REAL)
      expect(nodeBWf).toBeUndefined()
      // B 挂在 A 下；A 下不应有指向 B 的 workflow-call
      const nodeA = findNode(tree.root, 'subagent', A_REAL)
      expect(nodeA).toBeDefined()
      expect(nodeA!.children.some((c) => c === nodeBSub)).toBe(true)
      expect(
        nodeA!.children.some((c) => c.type === 'workflow-call' && c.sessionId === B_REAL),
      ).toBe(false)
      // B 的嵌套后代 D 仍挂在 B 下（caution：call 节点内派生的 sub-subagent 不丢失）
      const nodeD = findNode(tree.root, 'subagent', D_REAL)
      expect(nodeD).toBeDefined()
      expect(nodeBSub!.children.some((c) => c === nodeD)).toBe(true)
      // 树规模：main + A + B + D = 4（B 不重复计数）
      expect(tree.totalNodes).toBe(4)
      expect(tree.truncated).toBe(false)
    })

    it('TC-m3b-mf2-subtree：buildExecutionTree(subagentId) 切该 subagent 子树（MF-2，§5.5）', async () => {
      await writeMainSession(dir, '--main-cwd--', MAIN)
      // A（顶层）+ X（顶层，A 的兄弟，不应进 A 的子树）
      const saA = await writeSubagentSession(dir, MAIN, A_REAL, {
        rootSessionId: MAIN,
        slug: 'sub-a',
      })
      const recAId = 'sa-record-A'
      await writeRecordManifest(dir, MAIN, recAId, {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saA,
        status: 'completed',
        parentRecordId: undefined,
      })
      const saX = await writeSubagentSession(dir, MAIN, X_REAL, {
        rootSessionId: MAIN,
        slug: 'sub-x',
      })
      await writeRecordManifest(dir, MAIN, 'sa-record-X', {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saX,
        status: 'completed',
        parentRecordId: undefined,
      })
      // B（A 的后代），C（B 的后代）
      const saB = await writeSubagentSession(dir, MAIN, B_REAL, {
        rootSessionId: MAIN,
        slug: 'sub-b',
      })
      const recBId = 'sa-record-B'
      await writeRecordManifest(dir, MAIN, recBId, {
        rootSessionId: MAIN,
        agentName: 'worker',
        sessionFile: saB,
        status: 'completed',
        parentRecordId: recAId,
      })
      const saC = await writeSubagentSession(dir, MAIN, C_REAL, {
        rootSessionId: MAIN,
        slug: 'sub-c',
      })
      await writeRecordManifest(dir, MAIN, 'sa-record-C', {
        rootSessionId: MAIN,
        agentName: 'worker',
        sessionFile: saC,
        status: 'completed',
        parentRecordId: recBId,
      })

      // 切 A 的子树（subagent root）
      const tree = await buildExecutionTree(A_REAL, dir)

      // root 是 A（subagent 节点，携带 manifest 元数据）
      expect(tree.root.type).toBe('subagent')
      expect(tree.root.sessionId).toBe(A_REAL)
      expect(tree.root.agentName).toBe('explorer')
      // A 的子树含 B→C，不含兄弟 X
      const nodeB = findNode(tree.root, 'subagent', B_REAL)
      expect(nodeB).toBeDefined()
      expect(tree.root.children.some((c) => c === nodeB)).toBe(true)
      const nodeC = findNode(tree.root, 'subagent', C_REAL)
      expect(nodeC).toBeDefined()
      expect(nodeB!.children.some((c) => c === nodeC)).toBe(true)
      // 兄弟 X 不在 A 的子树
      const nodeX = findNode(tree.root, 'subagent', X_REAL)
      expect(nodeX).toBeUndefined()
      // 树规模：A + B + C = 3
      expect(tree.totalNodes).toBe(3)
      expect(tree.sourceMode).toBe('precise')
      expect(tree.truncated).toBe(false)
    })

    it('TC-m3b-mf1-main-root：main root 填 sessionFile 后 main 自身发起的 workflow run 入树（MF-1）', async () => {
      const mainPath = await writeMainSession(dir, '--main-cwd--', MAIN)
      // main 的 v2 注册条目 → record 流 → call session B
      const sbB = join(
        resolveStoreSubagentSessionsDir(dir, MAIN),
        `2026-08-07T16-49-48-393Z_${B_REAL}.jsonl`,
      )
      await mkdir(resolveStoreSubagentSessionsDir(dir, MAIN), { recursive: true })
      await writeFile(sbB, JSON.stringify({ type: 'session', id: B_REAL, cwd: '/proj/wf' }) + '\n')
      await writeWfV2Run(dir, '--main-cwd--', mainPath, MAIN, RUN_A, [sbB])

      const tree = await buildExecutionTree(MAIN, dir, mainPath)

      // main root 携带 sessionFile，v2 注册条目被读取 → wf-call 子节点入树
      expect(tree.root.type).toBe('main')
      expect(tree.root.sessionFile).toBe(mainPath)
      const nodeB = findNode(tree.root, 'workflow-call', B_REAL)
      expect(nodeB).toBeDefined()
      expect(tree.root.children.some((c) => c === nodeB)).toBe(true)
      expect(nodeB!.runId).toBe(RUN_A)
      expect(tree.totalNodes).toBe(2) // main + wf-call B
      expect(tree.maxDepth).toBe(1)
      expect(tree.truncated).toBe(false)

      // 差分检查：不传 mainSessionFile（旧行为）→ main root 无 sessionFile → workflow run 不可达
      const tree2 = await buildExecutionTree(MAIN, dir)
      expect(tree2.root.sessionFile).toBeUndefined()
      expect(tree2.totalNodes).toBe(1)

      // 空串哨兵归一：mainSessionFile=''（zcode family 路由反查未命中的降级形态）与
      // 不传等价——root 节点 details 不携带 sessionFile:"" 这类非路径占位值
      const tree3 = await buildExecutionTree(MAIN, dir, '')
      expect(tree3.root.sessionFile).toBeUndefined()
      expect(tree3.totalNodes).toBe(1)
    })

    it('TC-m3b-max-depth：21+ 层 parentRecordId 链在 MAX_DEPTH(20) 截断，truncated=true 不抛错（MF-4）', async () => {
      await writeMainSession(dir, '--main-cwd--', MAIN)
      // 循环生成 25 层链：R1 顶层（parentRecordId=undefined），R(i+1).parentRecordId=Ri.id
      // 深度计数：root=0，R1=1，…，R20=20（attachSubagentChildren 在 node.depth>=20 截断，R21+ 不挂）
      const CHAIN_RECORDS = 25
      // 链 id 用独立前缀（0bbbbb…，与 MAIN 的 0aaaa… 不撞——否则 sidOf(1)===MAIN 会被
      // rootManifest 探测误判为 subagent root，深度计数整体偏移 1）
      const sidOf = (n: number): string =>
        `0bbbbbbb-cccc-7ddd-eeee-0000000000${String(n).padStart(2, '0')}`
      const recIdOf = (n: number): string => `sa-chain-${String(n).padStart(2, '0')}`
      let prevRecId: string | undefined
      for (let i = 1; i <= CHAIN_RECORDS; i++) {
        const saPath = await writeSubagentSession(dir, MAIN, sidOf(i), {
          rootSessionId: MAIN,
          slug: `chain-${i}`,
        })
        await writeRecordManifest(dir, MAIN, recIdOf(i), {
          rootSessionId: MAIN,
          agentName: 'explorer',
          sessionFile: saPath,
          parentRecordId: prevRecId,
        })
        prevRecId = recIdOf(i)
      }

      const tree = await buildExecutionTree(MAIN, dir)

      // 深度截断契约：MAX_DEPTH=20 → main + 20 层 subagent = 21 节点，R21+ 被截断
      expect(tree.truncated).toBe(true)
      expect(tree.maxDepth).toBe(20)
      expect(tree.totalNodes).toBe(21)
      // R20 是最后挂载的节点，其下无后代（R21 被截断）
      const deepest = findNode(tree.root, 'subagent', sidOf(20))
      expect(deepest).toBeDefined()
      expect(deepest!.children).toEqual([])
      // R21 不在树中
      expect(findNode(tree.root, 'subagent', sidOf(21))).toBeUndefined()
      expect(tree.root.children).toHaveLength(1)
      expect(tree.sourceMode).toBe('precise')
    })

    it('TC-m3b-bfs-spread：旧机制嵌套形态 rootSessionId=父 session id，BFS 扩散收集不丢 record（MF-5）', async () => {
      await writeMainSession(dir, '--main-cwd--', MAIN)
      // A：顶层（rootSessionId=MAIN，无 parentRecordId——旧机制）
      const saA = await writeSubagentSession(dir, MAIN, A_REAL, {
        rootSessionId: MAIN,
        slug: 'a',
      })
      await writeRecordManifest(dir, MAIN, 'sa-A', {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saA,
      })
      // B：旧机制嵌套形态——rootSessionId=A 的 session id（非 MAIN），A 无 manifest.parentRecordId
      const saB = await writeSubagentSession(dir, '--main-cwd--', B_REAL, {
        rootSessionId: A_REAL,
        slug: 'b',
      })
      await writeRecordManifest(dir, MAIN, 'sa-B', {
        rootSessionId: A_REAL,
        agentName: 'explorer',
        sessionFile: saB,
      })

      const tree = await buildExecutionTree(MAIN, dir)

      // BFS 扩散：queue 从 MAIN → A 的 session id 入队 → 第二轮收 B。B 不被丢弃（ES3）
      expect(tree.totalNodes).toBe(3) // main + A + B
      expect(tree.sourceMode).toBe('flat-fallback')
      const nodeA = findNode(tree.root, 'subagent', A_REAL)
      expect(nodeA).toBeDefined()
      const nodeB = findNode(tree.root, 'subagent', B_REAL)
      expect(nodeB).toBeDefined()
      // 旧机制无 parentRecordId → B 与 A 都 flat 挂 main（flat-fallback 语义）
      expect(tree.root.children.some((c) => c === nodeA)).toBe(true)
      expect(tree.root.children.some((c) => c === nodeB)).toBe(true)
      expect(tree.truncated).toBe(false)
    })
  })

  // ============================================================
  // 真实形态数据检查（合成 fixture）：mkdtemp 临时目录仿真真实 agentDir 布局，
  // guard 语义断言（解析不抛错 / 树非空 / 结构自洽 / sourceMode 值域），不触碰真实数据目录。
  // ============================================================

  describe('buildExecutionTree - 真实形态数据守卫（合成）', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻）

    beforeEach(async () => {
      dataDir = await makeAgentDir()
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('TC-m3b-real-data-guard：真实形态布局（时间戳文件名/新旧机制混合/孤儿 manifest/坏 manifest/外来家族）解析不抛错，树非空且结构自洽', async () => {
      // 仿真真实 agentDir 数据形态（全部 mkdtemp 自建自删，确定性可重跑）：
      // - session 文件名带时间戳前缀（<ISO 时间戳>_<sessionId>.jsonl，真实 pi 落盘形态）
      // - 混合新旧机制：A 顶层（无 parentRecordId）→ B 嵌套（manifest.parentRecordId 精确链）；
      //   C 旧机制顶层（manifest/identity 均无 parentRecordId → flat 挂 main）
      // - 孤儿 manifest D：sessionFile 已被 30 天 GC、manifest 残留（真实数据常态）
      // - 坏 manifest（JSON 损坏）不中断扫描（ES4）
      // - 外来家族 X（同 agentDir 其他 main 的 record）不应泄漏进目标树
      const CWD = '--guard-cwd--'
      const TS = '2026-09-11T10-00-00-000Z'
      const OTHER_MAIN = '0aaaaaaa-bbbb-7ccc-dddd-000000000009'
      const prefixed = (id: string): string => `${TS}_${id}.jsonl`

      await writeMainSession(dir, CWD, MAIN)
      // A：顶层 subagent（identity 尾行走数据源 ② 读路径，无 parentRecordId → 顶层挂 main）
      const saA = await writeSubagentSession(
        dir,
        MAIN,
        A_REAL,
        { rootSessionId: MAIN, slug: 'guard-a' },
        prefixed(A_REAL),
      )
      await writeRecordManifest(dir, MAIN, 'rec-ga', {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saA,
        slug: 'guard-a',
        status: 'completed',
      })
      // B：A 的嵌套后代（manifest.parentRecordId 精确链，新机制）
      const saB = await writeSubagentSession(
        dir,
        MAIN,
        B_REAL,
        { rootSessionId: MAIN, slug: 'guard-b' },
        prefixed(B_REAL),
      )
      await writeRecordManifest(dir, MAIN, 'rec-gb', {
        rootSessionId: MAIN,
        agentName: 'worker',
        sessionFile: saB,
        slug: 'guard-b',
        status: 'completed',
        parentRecordId: 'rec-ga',
      })
      // C：旧机制顶层 subagent（manifest/identity 均无 parentRecordId → flat 挂 main）
      const saC = await writeSubagentSession(
        dir,
        MAIN,
        C_REAL,
        { rootSessionId: MAIN, slug: 'guard-c' },
        prefixed(C_REAL),
      )
      await writeRecordManifest(dir, MAIN, 'rec-gc', {
        rootSessionId: MAIN,
        agentName: 'explorer',
        sessionFile: saC,
        slug: 'guard-c',
        status: 'completed',
      })
      // D：孤儿 manifest（sessionFile 指向已被 GC 的不存在文件——manifest 残留形态）
      await writeRecordManifest(dir, MAIN, 'rec-gd', {
        rootSessionId: MAIN,
        agentName: 'worker',
        sessionFile: join(resolveStoreSubagentSessionsDir(dir, MAIN), prefixed(D_REAL)),
        status: 'completed',
      })
      // 坏 manifest（JSON 损坏，listRecordManifests 容错跳过不中断）
      await mkdir(resolveStoreSubagentRecordsDir(dir, MAIN), { recursive: true })
      await writeFile(join(resolveStoreSubagentRecordsDir(dir, MAIN), 'broken.json'), '{oops')
      // 外来家族 X：同 agentDir 内其他 main（OTHER_MAIN）的 subagent，不应泄漏进 MAIN 的树
      const saX = await writeSubagentSession(
        dir,
        OTHER_MAIN,
        X_REAL,
        { rootSessionId: OTHER_MAIN, slug: 'foreign-x' },
        prefixed(X_REAL),
      )
      await writeRecordManifest(dir, MAIN, 'rec-gx', {
        rootSessionId: OTHER_MAIN,
        agentName: 'explorer',
        sessionFile: saX,
        status: 'completed',
      })

      const tree = await buildExecutionTree(MAIN, dir)

      // 契约值域：sourceMode 只能是两种精度模式之一（record 含 parentRecordId → precise，
      // 全无 → flat-fallback），不锁具体值
      expect(['precise', 'flat-fallback']).toContain(tree.sourceMode)
      // 家族树非空：main + 顶层 A/C/D + A 的嵌套后代 B = 5；外来 X 不泄漏（合成数据确定性
      // 可数，精确计数即非泄漏检查）
      expect(tree.totalNodes).toBe(5)
      expect(tree.root.type).toBe('main')
      expect(tree.root.sessionId).toBe(MAIN)
      expect(findNode(tree.root, 'subagent', X_REAL)).toBeUndefined()
      // 孤儿 D 仍入树（sessionFile 残留路径，不因文件缺失抛错/丢弃 record——原真实数据检查
      // 独有覆盖范围，合成化后保留）
      const nodeD = findNode(tree.root, 'subagent', D_REAL)
      expect(nodeD).toBeDefined()
      expect(nodeD!.sessionFile).toBe(join(resolveStoreSubagentSessionsDir(dir, MAIN), prefixed(D_REAL)))
      // 树结构自洽（ExecutionTreeNode 契约，与具体数据形态无关）：DFS 实际节点数 ===
      // totalNodes；子节点 depth = 父 depth + 1；全树 rootSessionId 共享同一顶层 main
      let count = 0
      const walk = (node: ExecutionTreeNode): void => {
        count++
        expect(node.rootSessionId).toBe(tree.root.rootSessionId)
        for (const c of node.children) {
          expect(c.depth).toBe(node.depth + 1)
          walk(c)
        }
      }
      walk(tree.root)
      expect(count).toBe(tree.totalNodes)
      // 不抛错（已隐含：到这行说明成功）
    })
  })

  // ============================================================
  // formatExecutionTreeText 渲染（IF5）
  // ============================================================

  describe('formatExecutionTreeText', () => {
    it('渲染头部摘要 + 树形 + 尾部 👉 指引', () => {
      const tree = {
        root: {
          type: 'main' as const,
          sessionId: MAIN,
          depth: 0,
          rootSessionId: MAIN,
          children: [
            {
              type: 'subagent' as const,
              sessionId: A_REAL,
              depth: 1,
              rootSessionId: MAIN,
              status: 'completed',
              slug: 'sub-a',
              task: 'do something',
              children: [],
            },
          ],
        },
        totalNodes: 2,
        maxDepth: 1,
        truncated: false,
        sourceMode: 'precise' as const,
      }
      const text = formatExecutionTreeText(tree)
      // 头部摘要
      expect(text).toContain('2 node(s)')
      expect(text).toContain('maxDepth 1')
      expect(text).toContain('precise')
      // 树形：type + sessionId 截断 + status + slug + task
      expect(text).toContain('main')
      expect(text).toContain('subagent')
      expect(text).toContain(A_REAL.slice(0, 8))
      expect(text).toContain('[completed]')
      expect(text).toContain('slug=sub-a')
      expect(text).toContain('do something')
      // 尾部 👉 指引
      expect(text).toContain('👉')
      expect(text).toContain("outline")
    })

    it('flat-fallback 模式注明精度限制', () => {
      const tree = {
        root: {
          type: 'main' as const,
          sessionId: MAIN,
          depth: 0,
          rootSessionId: MAIN,
          children: [],
        },
        totalNodes: 1,
        maxDepth: 0,
        truncated: false,
        sourceMode: 'flat-fallback' as const,
      }
      const text = formatExecutionTreeText(tree)
      expect(text).toContain('flat-fallback')
      expect(text).toContain('旧机制')
    })

    it('truncated 模式标注截断', () => {
      const tree = {
        root: {
          type: 'main' as const,
          sessionId: MAIN,
          depth: 0,
          rootSessionId: MAIN,
          children: [],
        },
        totalNodes: 1,
        maxDepth: 0,
        truncated: true,
        sourceMode: 'precise' as const,
      }
      const text = formatExecutionTreeText(tree)
      expect(text).toContain('truncated')
    })
  })
});

// ======== 来源：roots.test.ts ========
describe("roots", () => {
  // ============================================================
  // A3（ext-simplify-04 U4）：listMainSessions/listSubagentSessions 薄包装已删除，
  // subagents.ts 直调 resolveSessionRoots+filter。以下 describe 用同一等价式作入口，
  // 保过滤语义覆盖（.finalized 排除 / workflow-state 跳过 / 递归 / 根选择 / 空目录容错）。
  // ============================================================

  /** 原 listMainSessions 等价式：agentDir 信号包下未去重 main 根的文件并集 */
  async function mainSessionFiles(agentDir: string) {
    return (await resolveSessionRoots({ agentDir }))
      .filter((r) => r.source === 'main' && r.dedupedInto === undefined)
      .flatMap((r) => r.files)
  }

  /** 原 listSubagentSessions 等价式：agentDir 信号包下 [subagent] 根文件集 */
  async function subagentSessionFiles(agentDir: string) {
    return (await resolveSessionRoots({ agentDir })).find((r) => r.kind === 'subagent')?.files ?? []
  }

  /** 写 .jsonl fixture（父目录不存在则自建），内容默认合法 session header */
  async function writeJsonl(path: string, content = '{"type":"session","id":"x"}\n') {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }

  /** 真实形态的 cwd 编码目录名（encodeCwd：`--` 开头 `--` 结尾） */
  const SLUG = '--Users-foo--'

  /** taiji 用例的存储树分区 sid fixture（合法 pi sid 形态）。 */
  const TAIJI_SID = '0aaaaaaa-bbbb-7ccc-dddd-0000000000t1'

  describe('main 根过滤（原 listMainSessions 等价式，A3 退役后保覆盖）', () => {
    let dir: string

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'roots-test-'))
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('扫描 sessions/<slug>/*.jsonl，排除 *.jsonl.finalized', async () => {
      const slug = '--Users-foo--'
      await mkdir(join(dir, 'sessions', slug), { recursive: true })
      await writeFile(join(dir, 'sessions', slug, 'a.jsonl'), '{"type":"session","id":"a"}\n')
      await writeFile(join(dir, 'sessions', slug, 'b.jsonl.finalized'), '{"type":"session","id":"b"}\n')

      const result = await mainSessionFiles(dir)
      expect(result).toHaveLength(1)
      expect(result[0].path.endsWith('a.jsonl')).toBe(true)
      expect(result[0].path.endsWith('.finalized')).toBe(false)
      expect(result[0].mtime).toBeTypeOf('number')
      expect(result[0].mtime).toBeGreaterThan(0)
      expect(result[0].size).toBeTypeOf('number')
      expect(result[0].size).toBeGreaterThan(0)
    })

    it('嵌套子目录正确递归（sessions/<slug>/deep/nested/d.jsonl）', async () => {
      await mkdir(join(dir, 'sessions', 'slug', 'deep', 'nested'), { recursive: true })
      await writeFile(join(dir, 'sessions', 'slug', 'deep', 'nested', 'd.jsonl'), '{}\n')
      // 同 slug 直接层也放一个，验证同一 slug 下平铺与嵌套并存
      await writeFile(join(dir, 'sessions', 'slug', 'top.jsonl'), '{}\n')

      const result = await mainSessionFiles(dir)
      const names = result.map((m) => m.path.split('/').pop()!)
      expect(names).toContain('d.jsonl')
      expect(names).toContain('top.jsonl')
      expect(result).toHaveLength(2)
    })

    it('跳过 workflow-state 子目录（wf-*.jsonl 非 session 文件）', async () => {
      const slug = '--Users-x--'
      await mkdir(join(dir, 'sessions', slug, 'workflow-state'), { recursive: true })
      await writeFile(join(dir, 'sessions', slug, 'real.jsonl'), '{"type":"session"}\n')
      await writeFile(
        join(dir, 'sessions', slug, 'workflow-state', 'wf-abc.jsonl'),
        '{"v":"wf-run-v1"}\n',
      )

      const result = await mainSessionFiles(dir)
      expect(result).toHaveLength(1)
      expect(result[0].path.endsWith('real.jsonl')).toBe(true)
      expect(result.every((m) => !m.path.includes('workflow-state'))).toBe(true)
    })

    it('空 agentDir（无 sessions 目录）返回 []，不抛错', async () => {
      await expect(mainSessionFiles(dir)).resolves.toEqual([])
    })

    it('不存在的 agentDir 返回 []，不抛错', async () => {
      await expect(mainSessionFiles(join(dir, 'no-such-dir'))).resolves.toEqual([])
    })

    it('扫描 sessions/：含目标 session，排除 .finalized 与 workflow-state 目录（019e6c96 锚）', async () => {
      // wf-state 文件（wf-*.jsonl）经 workflow-state 目录跳过排除——main 根无独立的
      // wf- 文件名前缀过滤，slug 顶层放 wf-*.jsonl 会被收进候选集（该形态不在真实
      // 落盘布局中出现：wf-state 恒在 workflow-state/ 目录内）
      const slug = '--Users-foo--'
      const slugDir = join(dir, 'sessions', slug)
      await mkdir(join(slugDir, 'workflow-state'), { recursive: true })
      await writeFile(join(slugDir, `${FIX_E6}.jsonl`), `{"type":"session","id":"${FIX_E6}"}\n`)
      await writeFile(join(slugDir, 'b.jsonl.finalized'), '{"type":"session","id":"b"}\n')
      await writeFile(join(slugDir, 'workflow-state', 'wf-inner.jsonl'), '{"v":"wf-run-v1"}\n')

      const result = await mainSessionFiles(dir)
      expect(result.length).toBeGreaterThan(0)
      // 含目标 session
      expect(result.some((m) => m.path.includes('019e6c96'))).toBe(true)
      // 排除 finalized
      expect(result.every((m) => !m.path.endsWith('.finalized'))).toBe(true)
      // 排除 workflow-state 目录
      expect(result.every((m) => !m.path.includes('workflow-state'))).toBe(true)
      // mtime/size 真实
      expect(result.every((m) => m.mtime > 0 && m.size > 0)).toBe(true)
    })
  })

  describe('subagent 根选择（原 listSubagentSessions 等价式，A3 退役后保覆盖；[session-store-layout-inversion] 单新根）', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻）

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'roots-sub-test-'))
      dir = join(dataDir, 'agent')
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    /** 存储树分区 sid fixture（合法 pi sid 形态）。 */
    const SID_P = '0aaaaaaa-bbbb-7ccc-dddd-0000000000p1'

    it('扫描存储树 <root>/<sid>/subagents/sessions/*.jsonl，排除 .finalized', async () => {
      const sessionsDir = resolveStoreSubagentSessionsDir(dir, SID_P)
      await mkdir(sessionsDir, { recursive: true })
      await writeFile(join(sessionsDir, 'c.jsonl'), '{"type":"session"}\n')
      await writeFile(join(sessionsDir, 'c.jsonl.finalized'), '{"type":"session"}\n')

      const result = await subagentSessionFiles(dir)
      expect(result).toHaveLength(1)
      expect(result[0].path.endsWith('c.jsonl')).toBe(true)
      expect(result[0].path.endsWith('.finalized')).toBe(false)
    })

    it('records/ 子目录（.json manifest）不被误收（同分区固定位置只探 sessions/）', async () => {
      const { resolveStoreSubagentRecordsDir } = await import('../discovery/roots.js')
      await mkdir(resolveStoreSubagentRecordsDir(dir, SID_P), { recursive: true })
      const sessionsDir = resolveStoreSubagentSessionsDir(dir, SID_P)
      await mkdir(sessionsDir, { recursive: true })
      await writeFile(join(resolveStoreSubagentRecordsDir(dir, SID_P), 'manifest.json'), '{}\n')
      await writeFile(join(sessionsDir, 'sub.jsonl'), '{"type":"session"}\n')

      const result = await subagentSessionFiles(dir)
      expect(result).toHaveLength(1)
      expect(result[0].path.endsWith('sub.jsonl')).toBe(true)
    })

    it('非会话分区目录（isPiSessionId 不过）剪枝跳过，不进 subagent 根候选', async () => {
      // 非法分区名（前导 - 违反首字符规则；btw 虚拟 id 冒号形态同拒）
      for (const bogus of ['-bogus', 'btw:0aaa']) {
        const bogusDir = join(resolveSessionStoreRoot(dir), bogus, 'subagents', 'sessions')
        await mkdir(bogusDir, { recursive: true })
        await writeFile(join(bogusDir, 'x.jsonl'), '{"type":"session"}\n')
      }
      const okDir = resolveStoreSubagentSessionsDir(dir, SID_P)
      await mkdir(okDir, { recursive: true })
      await writeFile(join(okDir, 'ok.jsonl'), '{"type":"session"}\n')

      const result = await subagentSessionFiles(dir)
      expect(result).toHaveLength(1)
      expect(result[0]!.path.endsWith('ok.jsonl')).toBe(true)
    })

    it('无存储树目录返回 []，不抛错', async () => {
      await expect(subagentSessionFiles(dir)).resolves.toEqual([])
    })

    it('D6 单新根锚定：旧布局 <agentDir>/subagents 造会话文件不被扫描（存量不可见）', async () => {
      // 旧布局存量原位保留（D6 裁决：不迁移、不再读写）
      const legacyDir = join(dir, 'subagents', '--legacy-cwd--', 'sessions')
      await mkdir(legacyDir, { recursive: true })
      await writeFile(join(legacyDir, 'legacy.jsonl'), '{"type":"session"}\n')

      expect(await subagentSessionFiles(dir)).toEqual([])
    })
  })

  // ============================================================
  // U1 resolveSessionRoots（design 2026-09-10 §6.1 / §7B 要点 2/3/4/6/7；B 收缩无 [env]）
  // ============================================================

  /** 三宿主信号包用例的行内校验上下文 */
  interface HostCaseCtx {
    tmp: string
    agentDir: string
  }

  interface HostCase {
    name: string
    build: (tmp: string) => Promise<{ agentDir: string; signals: SessionRootSignals }>
    verify: (ctx: HostCaseCtx, roots: SessionRoot[]) => void
  }

  const HOST_CASES: HostCase[] = [
    {
      name: '纯 pi：live=encodeCwd 子目录，剥层后与 default 同路径去重，保留 live 标签',
      async build(tmp) {
        const agentDir = join(tmp, 'agent')
        await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'))
        return {
          agentDir,
          signals: { agentDir, liveSessionDir: join(agentDir, 'sessions', SLUG) },
        }
      },
      verify({ agentDir }, roots) {
        // kind 序 = 优先级序（live > default > legacy > subagent；B 收缩无 env）
        expect(roots.map((r) => r.kind)).toEqual(['live', 'default', 'legacy', 'subagent'])
        const live = roots.find((r) => r.kind === 'live')!
        // 剥层（§7B 要点 3）：父目录名为 sessions 的真实形态 → dirname
        expect(live.path).toBe(join(agentDir, 'sessions'))
        expect(live.exists).toBe(true)
        expect(live.fileCount).toBe(1)
        const def = roots.find((r) => r.kind === 'default')!
        expect(def.path).toBe(join(agentDir, 'sessions'))
        // realpath 去重（§7B 要点 4）：同路径只扫一次，保留最高优先级 kind
        expect(def.dedupedInto).toBe('live')
        expect(def.files).toHaveLength(0)
        expect(def.fileCount).toBeUndefined()
        // 该路径在全列表中只被一个根实扫（文件不重复计入）
        const scannedAtSamePath = roots.filter(
          (r) => r.path === join(agentDir, 'sessions') && r.dedupedInto === undefined,
        )
        expect(scannedAtSamePath).toHaveLength(1)
        expect(roots.reduce((n, r) => n + r.files.length, 0)).toBe(1)
      },
    },
    {
      name: 'taiji：live=根本身（RPC 覆盖态），default 去重，legacy 残留与 subagent 独立列出',
      async build(tmp) {
        const dataDir = join(tmp, 'data')
        const agentDir = join(dataDir, 'agent')
        await writeJsonl(join(agentDir, 'sessions', SLUG, 'x.jsonl'))
        await writeJsonl(join(dataDir, 'sessions', 'old.jsonl')) // 旧旧布局迁移残留（§6.13 U1 行）
        // [session-store-layout-inversion] subagent 会话在新布局存储树（生产同源推导落盘）
        await writeJsonl(join(resolveStoreSubagentSessionsDir(agentDir, TAIJI_SID), 's.jsonl'))
        return { agentDir, signals: { agentDir, liveSessionDir: join(agentDir, 'sessions') } }
      },
      verify({ agentDir, tmp }, roots) {
        expect(roots.map((r) => r.kind)).toEqual(['live', 'default', 'legacy', 'subagent'])
        // live=根本身（basename 非 encodeCwd 形态）→ 取自身，与 default 同字面路径 → 去重
        const scanned = roots.filter((r) => r.dedupedInto === undefined)
        expect(scanned.map((r) => r.kind)).toEqual(['live', 'legacy', 'subagent'])
        const live = scanned[0]!
        expect(live.path).toBe(join(agentDir, 'sessions'))
        expect(live.fileCount).toBe(1) // 递归扫到 encodeCwd 子目录内的文件
        const def = roots.find((r) => r.kind === 'default')!
        expect(def.dedupedInto).toBe('live')
        // legacy（<dataDir>/sessions 残留）非空即纳入候选，独立成根
        const legacy = roots.find((r) => r.kind === 'legacy')!
        expect(legacy.path).toBe(join(tmp, 'data', 'sessions'))
        expect(legacy.exists).toBe(true)
        expect(legacy.fileCount).toBe(1)
        const sub = roots.find((r) => r.kind === 'subagent')!
        expect(sub.exists).toBe(true)
        expect(sub.fileCount).toBe(1)
        expect(sub.files[0]!.path.endsWith('s.jsonl')).toBe(true)
      },
    },
    {
      name: 'liveSessionDir 缺失降级：default/legacy/subagent 三根仍可用，无 live 根',
      async build(tmp) {
        const agentDir = join(tmp, 'agent')
        await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'))
        return { agentDir, signals: { agentDir } }
      },
      verify({ agentDir, tmp }, roots) {
        expect(roots.map((r) => r.kind)).toEqual(['default', 'legacy', 'subagent'])
        const def = roots.find((r) => r.kind === 'default')!
        expect(def.path).toBe(join(agentDir, 'sessions'))
        expect(def.exists).toBe(true)
        expect(def.fileCount).toBe(1)
        expect(roots.find((r) => r.kind === 'legacy')!.path).toBe(join(tmp, 'sessions'))
        // live 缺席 → 无去重发生
        expect(roots.every((r) => r.dedupedInto === undefined)).toBe(true)
      },
    },
  ]

  describe('resolveSessionRoots', () => {
    it.each(HOST_CASES)('$name', async ({ build, verify }) => {
      const tmp = await mkdtemp(join(tmpdir(), 'roots-resolve-'))
      try {
        const { agentDir, signals } = await build(tmp)
        const roots = await resolveSessionRoots(signals)

        // ④ subagent 根恒在（常量推导，不来自任何信号，§6.1 信号 5）；
        // [session-store-layout-inversion] 根 = session 存储树（dirname(agentDir)/ext-sessions）
        const sub = roots.find((r) => r.kind === 'subagent')
        expect(sub).toBeDefined()
        expect(sub!.source).toBe('subagent')
        expect(sub!.path).toBe(resolveSessionStoreRoot(agentDir))

        // ⑤ 已扫描根 fileCount/scanMs 恒填充且与 files 一致；被去重根不产生扫描统计
        for (const r of roots) {
          if (r.dedupedInto !== undefined) {
            expect(r.fileCount).toBeUndefined()
            expect(r.scanMs).toBeUndefined()
          } else {
            expect(typeof r.fileCount).toBe('number')
            expect(r.fileCount).toBe(r.files.length)
            expect(typeof r.scanMs).toBe('number')
            expect(r.scanMs!).toBeGreaterThanOrEqual(0)
          }
        }

        verify({ tmp, agentDir }, roots)
      } finally {
        await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('[live] 规范化第二形态：普通目录（basename 非 encodeCwd 形态）取自身，不剥层', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'roots-live-plain-'))
      try {
        const agentDir = join(tmp, 'agent')
        const liveDir = join(tmp, 'live-sessions')
        await writeJsonl(join(liveDir, 'b.jsonl'))

        const roots = await resolveSessionRoots({ agentDir, liveSessionDir: liveDir })
        const live = roots.find((r) => r.kind === 'live')!
        expect(live.path).toBe(liveDir)
        expect(live.exists).toBe(true)
        expect(live.fileCount).toBe(1)
        // default/legacy 独立列出，互不干扰
        expect(roots.find((r) => r.kind === 'default')!.path).toBe(join(agentDir, 'sessions'))
        expect(roots.every((r) => r.dedupedInto === undefined)).toBe(true)
      } finally {
        await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('空 agentDir 防御：不派生任何根（避免扫到进程 cwd 相对路径）', async () => {
      await expect(resolveSessionRoots({ agentDir: '' })).resolves.toEqual([])
    })

    it('encodeCwd 判据自洽：--xx-- 形态子目录剥层到 sessions 根，普通名子目录取自身', async () => {
      // 两种目录形态各造一个：encodeCwd 编码目录（剥层分支）与普通目录名（取自身分支）
      const tmp = await mkdtemp(join(tmpdir(), 'roots-encode-'))
      try {
        const sessionsDir = join(tmp, 'agent', 'sessions')
        const encoded = join(sessionsDir, '--Users-foo--')
        const plain = join(sessionsDir, 'permission-forwarding')
        await writeJsonl(join(encoded, 'a.jsonl'))
        await writeJsonl(join(plain, 'p.jsonl'))
        // 判据自洽：匹配 encodeCwd 形态 → 剥层到父目录；不匹配（如 permission-forwarding/）→ 取自身
        expect(normalizeLiveSessionDir(encoded)).toBe(sessionsDir)
        expect(normalizeLiveSessionDir(plain)).toBe(plain)
      } finally {
        await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })

  describe('buildFamilyFromFs not-found 文案（U1 并入：列实际扫描候选根）', () => {
    let tmp: string

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'roots-notfound-'))
    })
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('错误信息含各候选根路径、kind 标签与文件数（default/legacy），保留 findSessions 指引', async () => {
      const agentDir = join(tmp, 'data', 'agent')
      await writeJsonl(
        join(agentDir, 'sessions', SLUG, 'known.jsonl'),
        '{"type":"session","id":"known-id"}\n',
      )

      const msg = await buildFamilyFromFs('missing-id', agentDir).then(
        () => {
          throw new Error('buildFamilyFromFs should reject for unknown sessionId')
        },
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
      expect(msg).toContain('not found')
      expect(msg).toContain(join(agentDir, 'sessions'))
      expect(msg).toContain('[default]')
      expect(msg).toContain('1 file(s)')
      expect(msg).toContain(join(tmp, 'data', 'sessions'))
      expect(msg).toContain('[legacy]')
      expect(msg).toContain('not exists')
      // 只列 main 候选根（collectMainSessions 实扫集合），不含 subagent 根
      expect(msg).not.toContain('[subagent]')
      expect(msg).toContain('findSessions')
    })
  })

  // ============================================================
  // u8 追加：resolveSessionRoots options（doctor 统一数据源，design §6.3「同一数据源
  // 两处渲染，不重复实现探测」——subagent 扫描模式经 options 由调用方驱动；原 u8 的
  // 注入式缓存面已删除，ext-simplify-04 U3，每次调用实扫）
  // ============================================================

  describe('resolveSessionRoots options（u8：subagents 模式）', () => {
    /** 最小 fixture：default 根 1 文件 + subagent 根 1 文件（legacy 不存在） */
    async function buildMinimalFixture(): Promise<{ tmp: string; agentDir: string }> {
      const tmp = await mkdtemp(join(tmpdir(), 'roots-opts-'))
      const agentDir = join(tmp, 'agent')
      await mkdir(join(agentDir, 'sessions', SLUG), { recursive: true })
      await writeFile(join(agentDir, 'sessions', SLUG, 'a.jsonl'), '{"type":"session"}\n')
      await mkdir(resolveStoreSubagentSessionsDir(agentDir, '0aaaaaaa-bbbb-7ccc-dddd-0000000000o1'), { recursive: true })
      await writeFile(
        join(resolveStoreSubagentSessionsDir(agentDir, '0aaaaaaa-bbbb-7ccc-dddd-0000000000o1'), 's.jsonl'),
        '{"type":"session"}\n',
      )
      return { tmp, agentDir }
    }

    it("subagents:'stat'：subagent 根只 stat（无计数/耗时/files 空），main 根照常实扫", async () => {
      const { tmp, agentDir } = await buildMinimalFixture()
      try {
        const roots = await resolveSessionRoots({ agentDir }, { subagents: 'stat' })
        const sub = roots.find((r) => r.kind === 'subagent')!
        expect(sub.exists).toBe(true)
        expect(sub.fileCount).toBeUndefined()
        expect(sub.scanMs).toBeUndefined()
        expect(sub.files).toEqual([])
        expect(sub.dedupedInto).toBeUndefined()
        // main 根不受影响：照常实扫
        const def = roots.find((r) => r.kind === 'default')!
        expect(def.fileCount).toBe(1)
        expect(def.files).toHaveLength(1)
      } finally {
        await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it("options 缺省与 subagents:'scan'：subagent 根照旧全扫（现有调用方零破坏）", async () => {
      const { tmp, agentDir } = await buildMinimalFixture()
      try {
        for (const options of [undefined, { subagents: 'scan' as const }]) {
          const roots = await resolveSessionRoots({ agentDir }, options)
          const sub = roots.find((r) => r.kind === 'subagent')!
          expect(sub.fileCount).toBe(1)
          expect(sub.files).toHaveLength(1)
        }
      } finally {
        await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('重复调用每次实扫（无缓存）：两次结果独立完整，files 恒非空实扫值', async () => {
      // 原三个 cache 用例（set 回写 / 命中优先 / stat × cache）随缓存注入点删除
      // （ext-simplify-04 U3）；本用例固定删除后契约——不存在任何缓存层
      const { tmp, agentDir } = await buildMinimalFixture()
      try {
        const first = await resolveSessionRoots({ agentDir })
        const second = await resolveSessionRoots({ agentDir })
        for (const roots of [first, second]) {
          const def = roots.find((r) => r.kind === 'default')!
          expect(def.fileCount).toBe(1)
          expect(def.files).toHaveLength(1)
          const sub = roots.find((r) => r.kind === 'subagent')!
          expect(sub.fileCount).toBe(1)
          expect(sub.files).toHaveLength(1)
        }
      } finally {
        await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })
});

// ======== 来源：subagents.test.ts ========
describe("subagents", () => {
  // ---- fixture 常量（uuid 特征，满足 extractSessionIdFromFilename + 互不为子串）----
  const ROOT = '0aaaaaaa-bbbb-7ccc-dddd-000000000001'
  const FORK = '0aaaaaaa-bbbb-7ccc-dddd-000000000002'
  const SUB_REAL = '0aaaaaaa-bbbb-7ccc-dddd-000000000003'

  // ---- fixture helpers ----

  /**
 * 建 mkdtemp dataDir 根（生产拓扑复刻，[session-store-layout-inversion] 布局 B）：
 * agentDir = `<dataDir>/agent`（调用方经 agentDirOf 推导并传入被测函数），存储树 =
 * `<dataDir>/ext-sessions`（fixture 经 roots.ts 生产同源推导函数落盘，禁手拼树根段字面量）。
 */
  async function makeAgentDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'subagents-test-'))
  }

  /** agentDir 推导（生产拓扑：agentDir = <dataDir>/agent，session-reader 的 agentDir 语义）。 */
  function agentDirOf(dataDir: string): string {
    return join(dataDir, 'agent')
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
 * 写 subagent session 文件（新布局存储树：`<root>/<rootSessionId>/subagents/sessions/`，
 * 分区键 = identity.rootSessionId，生产同源 resolveStoreSubagentSessionsDir 推导）：
 * 首行 header（真实 id）+ 占位 message + 尾行 identity。
 * identity 在尾行（实测 pi 行为；subagent-identity 由 session-runner 在 session 创建后写）。
 * U4 扩展：identity.task/agent 可定制（P-fallback 测试用，默认 't'/'explorer'）。
 */
  async function writeSubagentSession(
    dir: string,
    realId: string,
    identity: { rootSessionId: string; slug: string; dataId?: string; task?: string; agent?: string },
  ): Promise<string> {
    const sessionDir = resolveStoreSubagentSessionsDir(dir, identity.rootSessionId)
    await mkdir(sessionDir, { recursive: true })
    const path = join(sessionDir, `${realId}.jsonl`)
    const lines = [
      JSON.stringify({ type: 'session', id: realId, cwd: `/proj/${identity.slug}` }),
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
    rootSessionId: string,
    realId: string,
  ): Promise<string> {
    const sessionDir = resolveStoreSubagentSessionsDir(dir, rootSessionId)
    await mkdir(sessionDir, { recursive: true })
    const path = join(sessionDir, `${realId}.jsonl`)
    const lines = [
      JSON.stringify({ type: 'session', id: realId, cwd: '/proj/root' }),
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

  /**
 * 写 records manifest（孤儿源；新布局 `<root>/<rootSessionId>/subagents/records/`，
 * 分区键 = fields.rootSessionId，生产同源 resolveStoreSubagentRecordsDir 推导）。
 * U4 扩展：fields 支持富字段 task/slug/model/status。
 */
  async function writeRecordManifest(
    dir: string,
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
    const recordsDir = resolveStoreSubagentRecordsDir(dir, fields.rootSessionId)
    await mkdir(recordsDir, { recursive: true })
    await writeFile(join(recordsDir, `${id}.json`), JSON.stringify({ id, ...fields }))
  }

  // ============================================================
  // fixture 测试
  // ============================================================

  describe('buildFamilyFromFs - fixture', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻，见 makeAgentDir 注释）

    beforeEach(async () => {
      dataDir = await makeAgentDir()
      dir = agentDirOf(dataDir)
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('基础 family：root + fork + 隔代 subagent，SubagentRef.sessionId 是真实 id（非 sa-xxx）', async () => {
      const rootPath = await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
      // fork 在不同 cwd slug（模拟跨 cwd fork）
      await writeMainSession(dir, '--fork-cwd--', FORK, {
        cwd: '/proj/fork',
        parentSession: rootPath,
      })
      // subagent 挂在 fork 子代下（rootSessionId=FORK，非 ROOT）→ 隔代
      await writeSubagentSession(dir, SUB_REAL, {
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
      await writeSubagentSession(dir, SUB_REAL, { rootSessionId: FORK, slug: 's' })

      const family = await buildFamilyFromFs(FORK, dir)
      expect(family.subagents.some((s) => s.sessionId === SUB_REAL)).toBe(true)
    })

    it('cleanedUp：manifest 孤儿（.jsonl 不存在）→ cleanedUp=true', async () => {
      await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
      // 孤儿 manifest：rootSessionId=ROOT，sessionFile 指向不存在路径（模拟 .jsonl 被 GC）
      await writeRecordManifest(dir, 'sa-ghost-id', {
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
      const subPath = await writeSubagentSession(dir, SUB_REAL, {
        rootSessionId: FORK,
        slug: 'dup-test',
      })
      // manifest 指向真实文件路径（alive）→ 应被跳过，不产生孤儿副本
      await writeRecordManifest(dir, `sa-${SUB_REAL}`, {
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
      const subPath = await writeSubagentSession(dir, SUB_REAL, {
        rootSessionId: ROOT,
        slug: 'wf-sub',
      })
      // GC'd 路径（文件不存在 → pathToRef 未命中 → sessionRefFromPath 最小 ref）；
      // 新布局 subagent 会话路径形态（存储树分区，生产同源推导）
      const gced = join(
        resolveStoreSubagentSessionsDir(dir, ROOT),
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
      expect(wf.calls[0].cwd).toBe('/proj/wf-sub') // cwd 从 subagent 文件首行 header 透传（fixture header.cwd = /proj/<identity.slug>）
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
      const subDir = resolveStoreSubagentSessionsDir(dir, ROOT)
      await mkdir(subDir, { recursive: true })
      const subPath = join(subDir, SUB_REAL + '.jsonl')
      await writeFile(
        subPath,
        JSON.stringify({ type: 'session', id: SUB_REAL, cwd: '/proj/root' }) + '\n',
      )
      await writeRecordManifest(dir, `sa-${SUB_REAL}`, {
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
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻，见 makeAgentDir 注释）

    beforeEach(async () => {
      dataDir = await makeAgentDir()
      dir = agentDirOf(dataDir)
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('导出生效：import + 调用返回 RecordManifest[]，字段完整', async () => {
      await writeRecordManifest(dir, 'sa-tc1', {
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

    it('D6 单新根锚定：旧布局 <agentDir>/subagents 造 record + 新根不造 → 不返回（存量不可见，防回归双根扫描）', async () => {
      // 旧布局存量原位保留（D6 裁决：不迁移、不再读写）——旧根造一份合法 manifest
      const legacyRecordsDir = join(dir, 'subagents', '--legacy-cwd--', 'records')
      await mkdir(legacyRecordsDir, { recursive: true })
      await writeFile(
        join(legacyRecordsDir, 'sa-legacy.json'),
        JSON.stringify({ id: 'sa-legacy', rootSessionId: 'root-legacy', sessionFile: '/nonexistent/legacy.jsonl' }),
      )
      // 单新根语义：旧根 manifest 不进结果集（result/find 面旧记录不可见是 D6 取舍清单明示项）
      expect(await listRecordManifests(dir)).toHaveLength(0)
    })

    it('D6 单新根锚定：非会话分区目录（isPiSessionId 不过）剪枝跳过，合法分区正常读', async () => {
      const { resolveSessionStoreRoot } = await import('../discovery/roots.js')
      const storeRoot = resolveSessionStoreRoot(dir)
      // 非法分区名（前导 - 违反 isPiSessionId 首字符规则）下的 records 不扫
      const bogus = join(storeRoot, '-bogus-partition', 'subagents', 'records')
      await mkdir(bogus, { recursive: true })
      await writeFile(
        join(bogus, 'sa-bogus.json'),
        JSON.stringify({ id: 'sa-bogus', rootSessionId: '-bogus-partition', sessionFile: '/nonexistent/b.jsonl' }),
      )
      // 合法分区在场
      await writeRecordManifest(dir, 'sa-ok', {
        rootSessionId: 'root-ok',
        agentName: 'explorer',
        sessionFile: '/tmp/sa-ok.jsonl',
      })
      const manifests = await listRecordManifests(dir)
      expect(manifests.map((m) => m.id)).toEqual(['sa-ok'])
    })
  })

  // ============================================================
  // U4 端到端：buildFamilyFromFs 富化（manifest 主 / P-fallback identity 回退 / orphan / compat）
  // 验证数据流重组：manifest 索引命中透全字段，未命中读尾行 identity 回退，孤儿 manifest 富字段+cleanedUp
  // ============================================================

  describe('U4 buildFamilyFromFs 富化（manifest 主 / P-fallback）', () => {
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻，见 makeAgentDir 注释）

    beforeEach(async () => {
      dataDir = await makeAgentDir()
      dir = agentDirOf(dataDir)
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('TC-u4-manifest-enrich: alive + manifest 全字段 → SubagentRef 富字段全透传', async () => {
      await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
      const subPath = await writeSubagentSession(dir, SUB_REAL, {
        rootSessionId: ROOT,
        slug: 'identity-slug', // identity.slug，manifest 主时被 manifest.slug 覆盖
        task: 'identity-task', // identity.task，manifest 主时被 manifest.task 覆盖
        agent: 'worker', // identity.agent，manifest 主时被 manifest.agentName 覆盖
      })
      // manifest 全字段（命中 meta.path 索引 → 走 manifest 主路径，覆盖 identity 值）
      await writeRecordManifest(dir, `sa-${SUB_REAL}`, {
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
      const subPath = await writeSubagentSession(dir, SUB_REAL, {
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
      await writeAliveSubagentNoIdentity(dir, ROOT, SUB_REAL)

      // 核心断言：buildFamilyFromFs 不抛错、不崩溃
      const family = await buildFamilyFromFs(ROOT, dir)

      // 无 manifest 无 identity → 无法确定 rootSessionId → 不入 family.subagents
      const sub = family.subagents.find((s) => s.sessionId === SUB_REAL)
      expect(sub).toBeUndefined()
    })

    it('TC-u4-orphan-manifest: manifest 全字段 + sessionFile 指向不存在路径 → 孤儿 cleanedUp=true，富字段透传', async () => {
      await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
      const ghostPath = '/nonexistent/gc-ghost.jsonl' // .jsonl 已被 GC（不写该文件）
      await writeRecordManifest(dir, 'sa-ghost-id', {
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
      await writeRecordManifest(dir, 'sa-old', {
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
    let dataDir: string
    let dir: string // agentDir = <dataDir>/agent（生产拓扑复刻，见 makeAgentDir 注释）

    beforeEach(async () => {
      dataDir = await makeAgentDir()
      dir = agentDirOf(dataDir)
    })
    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    /** 写 record 事件文件（首行头行 + 事件行集，形态对齐写侧 record-events.ts）。 */
    async function writeEventsFile(saId: string): Promise<string> {
      const recordsDir = resolveStoreSubagentRecordsDir(dir, ROOT)
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
      const subPath = await writeSubagentSession(dir, SUB_REAL, {
        rootSessionId: ROOT,
        slug: 'ev-sibling',
      })
      await writeEventsFile('sa-ev-1')

      const roots = await resolveSessionRoots({ agentDir: dir })
      const subRoot = roots.find((r) => r.kind === 'subagent')

      expect(subRoot).toBeDefined()
      expect(subRoot!.files.map((f) => f.path)).toContain(subPath)
      expect(subRoot!.files.some((f) => f.path.endsWith('.events'))).toBe(false)
    })

    it('首行头行命中非 session header 即忽略：record-journal 头行 → parseSessionHeader 返回 null', async () => {
      const eventsPath = await writeEventsFile('sa-ev-1')
      // 检查点④形态：session-reader 对未知文件读首行判 header，非 session 行 → null
      //（即使未来通配规则把 .events 收进候选集，该文件也不会被误认成 session）
      const firstLine = await readSessionHeaderFirstLine(eventsPath)
      expect(firstLine).toBeDefined()
      expect(parseSessionHeader(firstLine)).toBeNull()
    })

    it('家族扫描：.events 与正常 subagent 同目录共存 → 家族正常、不产幻影 subagent 节点', async () => {
      await writeMainSession(dir, '--root-cwd--', ROOT, { cwd: '/proj/root' })
      await writeSubagentSession(dir, SUB_REAL, {
        rootSessionId: ROOT,
        slug: 'ev-coexist',
      })
      await writeEventsFile('sa-ev-1')

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
});
