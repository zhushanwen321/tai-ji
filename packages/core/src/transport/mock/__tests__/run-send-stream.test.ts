// run-send-stream.test.ts —— core C30 簇合并产物（round5-G）。
// 共同被测业务模块：`src/transport/mock/run-send-stream.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/transport/mock/__tests__/mock-domains.test.ts（54 用例，skip 0）
//   - src/transport/mock/__tests__/mock-settings-system-fields.test.ts（7 用例，skip 0）
//   - src/transport/mock/__tests__/run-send-stream.test.ts（9 用例，skip 0）

import { type ProviderId, type ImportSourceKind, type RetryableErrorRule, QUOTA_PRESETS, type ServerMessageUnion } from '@taiji/shared'
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import * as events from '../../api/events'
import { __clearTimers, setMockE2E, setMockTiming, resetMockTiming, session, chat, config, model, extension, plugin, composer, search, settings, workspace, quota, project, preset, btw, tts, usage } from '../index'
import * as mock from '../index'
import { type Timing, runSendStream, type SendStreamDeps } from '../run-send-stream'
import { file } from '../file'
import { git, fixtureGitStatus } from '../git'
import { e2eTestSession } from '../data'
import { detectBranch } from '../run-send-stream-branches'

// ======== 来源：mock-domains.test.ts ========
describe("mock-domains", () => {
  /** 测试压缩时序：全键 1ms/步（file/git 的 ack 由 setMockTiming 同步压缩） */
  const FAST_TIMING: Timing = {
    ack: 1, startGap: 1, chunk: 1, done: 1, switchCmd: 1, thinkingGap: 1,
    toolGap: 1, fileChangesGap: 1, retryGap: 1, bashDelay: 1,
  }

  /** 轮询等待条件成立（mock 异步推送节奏用，超时 fail）。默认预算 2s：FAST_TIMING 全键
 *  1ms 下绿路 <0.2s，2s 已是 10 倍余量——超时是失败信号（回归/卡死），不用更长预算掩盖 */
  async function waitFor(cond: () => boolean, timeoutMs = 2_000, stepMs = 20): Promise<void> {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
      await new Promise((r) => setTimeout(r, stepMs))
    }
  }

  beforeAll(() => {
    setMockTiming(FAST_TIMING)
  })

  afterAll(() => {
    resetMockTiming()
  })

  afterEach(() => {
    __clearTimers()
    setMockE2E(false)
  })

  // ── mock file domain ────────────────────────────────────────────────────────
  describe('mock file domain', () => {
    it('tree：fixture 节点 + ignored 节点（ignored=true 始终返回）', async () => {
      const nodes = await file.tree('s1')
      const paths = nodes.map((n) => n.path)
      expect(paths).toContain('src')
      expect(paths).toContain('README.md')
      const ignored = nodes.filter((n) => n.ignored)
      expect(ignored.map((n) => n.path)).toEqual(['node_modules', 'dist', '.env'])
    })

    it('expand：已知目录返回子节点，未知目录空数组', async () => {
      const known = await file.expand('s1', 'src/utils')
      expect(known.map((n) => n.name)).toEqual(['format.ts', 'helpers.ts'])
      expect(await file.expand('s1', 'no/such/dir')).toEqual([])
    })

    it('read：按扩展名差异化 + xss 路径返回原始 <script>（转义责任在渲染层）', async () => {
      expect((await file.read('a.ts', 's1')).content).toContain('export function main')
      expect((await file.read('a.json', 's1')).content).toContain('"name": "sample"')
      expect((await file.read('a.md', 's1')).content).toContain('# a.md')
      expect((await file.read('a.txt', 's1')).content).toContain('// mock content')
      expect((await file.read('evil<xss>.ts', 's1')).content).toContain('<script>')
    })
  })

  // ── mock git domain ─────────────────────────────────────────────────────────
  describe('mock git domain', () => {
    it('status：fixture 深拷贝 + 注入 sessionId', async () => {
      const r = await git.status('s9')
      expect(r.sessionId).toBe('s9')
      expect(r.branch).toBe(fixtureGitStatus.branch)
      expect(r.hasConflict).toBe(true)
      expect(r.files).toHaveLength(fixtureGitStatus.files.length)
    })

    it('getDiff：改动文件有 patch / untracked 空 / 图片 binary / 未知空 / xss 原样', async () => {
      expect((await git.getDiff('s1', 'src/existing.ts')).patch).toContain('diff --git')
      expect((await git.getDiff('s1', 'untracked.log')).patch).toBe('')
      expect(await git.getDiff('s1', 'logo.png')).toEqual({ patch: '', binary: true })
      expect((await git.getDiff('s1', 'clean.ts')).patch).toBe('')
      expect((await git.getDiff('s1', 'evil-script.ts')).patch).toContain('<script>')
    })

    it('stage/unstage/commit/checkout/checkoutByCwd/createBranch：ack 型 resolve', async () => {
      await expect(git.stage('s1', ['a.ts'])).resolves.toBeUndefined()
      await expect(git.unstage('s1')).resolves.toBeUndefined()
      await expect(git.commit('s1', 'msg')).resolves.toBeUndefined()
      await expect(git.checkout('s1', 'main')).resolves.toBeUndefined()
      await expect(git.checkoutByCwd('/ws', 'main')).resolves.toBeUndefined()
      await expect(git.createBranch('s1', 'feat')).resolves.toBeUndefined()
    })
  })

  // ── mock session domain ─────────────────────────────────────────────────────
  describe('mock session domain', () => {
    it('list：按 cwd 聚合为 SessionGroup[]', async () => {
      const groups = await session.list()
      expect(groups.length).toBeGreaterThan(0)
      for (const g of groups) {
        expect(g.sessions.length).toBeGreaterThan(0)
        expect(g.sessions.every((s) => s.cwd === g.cwd)).toBe(true)
      }
    })

    it('create → switchSession/restoreSession → remove 全链路；不存在 id 抛错', async () => {
      const created = await session.create('/tmp/x', 'label-x')
      expect(created.cwd).toBe('/tmp/x')
      // switchSession 后推 session.commands + context.update（session 通道）
      const got: string[] = []
      const un = events.on(created.id, (m) => got.push(m.type))
      await session.switchSession(created.id)
      await waitFor(() => got.includes('session.commands') && got.includes('context.update'))
      un()
      const restored = await session.restoreSession(created.id)
      expect(restored.id).toBe(created.id)
      await expect(session.switchSession('ghost-id')).rejects.toThrow('不存在')
      await expect(session.restoreSession('ghost-id')).rejects.toThrow('不存在')
      await session.remove(created.id)
      await expect(session.remove(created.id)).rejects.toThrow('不存在')
    })

    it('create clientUuid 幂等（发现 B，mock 面行为对齐 runtime）：同 uuid 复用已建 session，不同 uuid 独立创建', async () => {
      const a = await session.create('/tmp/idem', 'idem', undefined, undefined, undefined, undefined, 'u-mock-1')
      const b = await session.create('/tmp/idem', 'idem-retry', undefined, undefined, undefined, undefined, 'u-mock-1')
      // 同 uuid 重试 → 同一 session（不重复建号；label 也复用首次创建值）
      expect(b.id).toBe(a.id)
      expect(b.label).toBe(a.label)
      // 不同 uuid → 独立创建
      const c = await session.create('/tmp/idem', 'idem-2', undefined, undefined, undefined, undefined, 'u-mock-2')
      expect(c.id).not.toBe(a.id)
      // 无 uuid → 每次独立创建（旧行为回归）
      const d1 = await session.create('/tmp/idem', 'n1')
      const d2 = await session.create('/tmp/idem', 'n2')
      expect(d2.id).not.toBe(d1.id)
    })

    it('fork / rename / setProject / removeByCwd / setThinkingLevel', async () => {
      const src = await session.create('/tmp/y', 'src')
      const forked = await session.fork(src.id, { label: 'forked' })
      expect(forked.id).not.toBe(src.id)
      expect(forked.cwd).toBe('/tmp/y')
      await session.rename(src.id, 'renamed')
      await session.setProject(src.id, 'p1')
      const receipt = await session.setThinkingLevel(src.id, 'high')
      expect(receipt).toEqual({ sessionId: src.id, level: 'high' })
      const r = await session.removeByCwd('/tmp/y')
      expect(r.failed).toEqual([])
      expect(r.deleted).toContain(src.id)
      expect(r.deleted).toContain(forked.id)
    })

    it('create/fork override 生效范围（G4 锚定后 mock 补齐）：描述类 override 落 summary + fork 血缘/继承', async () => {
      // [W3] modelOverride / thinkingOverride 两参保留签名全等（G4 参数契约）但不再落
      // SessionSummary——三状态字段（modelId/thinkingLevel/tokenCount）已从 SessionSummary
      // 删除（状态归 live-state 状态层，列表只承载导航；mock 无状态层，override 终值经
      // composer launchConfig 解析链呈现）。描述类 override 照常落 summary 可断言。
      const created = await session.create('/tmp/ov', 'ov-src', 'preset-x', 'proj-x', 'test/model-x', 'high')
      expect(created.launchPresetId).toBe('preset-x')
      expect(created.projectId).toBe('proj-x')
      expect(created).not.toHaveProperty('modelId')
      expect(created).not.toHaveProperty('thinkingLevel')
      // server-push 同源的 list 快照可断言（fixture 已带 override）
      const groups = await session.list()
      const found = groups.flatMap((g) => g.sessions).find((s) => s.id === created.id)
      expect(found).toMatchObject({ projectId: 'proj-x', launchPresetId: 'preset-x' })
      expect(found).not.toHaveProperty('modelId')
      expect(found).not.toHaveProperty('thinkingLevel')
      // fork：projectId 继承父归属 + 血缘键（parentSession 用源 sessionId——FR-20
      // fallback 键形态：mock 无 sessionFile）+ forkEntryId；状态类 override 不落条目
      const forked = await session.fork(created.id, {
        label: 'ov-fork',
        modelOverride: 'test/model-y',
        thinkingOverride: 'low',
        piEntryId: 'pi-entry-1',
      })
      expect(forked).not.toHaveProperty('modelId')
      expect(forked).not.toHaveProperty('thinkingLevel')
      expect(forked.projectId).toBe('proj-x')
      expect(forked.parentSession).toBe(created.id)
      expect(forked.forkEntryId).toBe('pi-entry-1')
      await session.remove(created.id)
      await session.remove(forked.id)
    })

    it('归档域四函数：archive → listArchives → unarchive → purgeArchive 全链路 + 不存在 id 抛错', async () => {
      const created = await session.create('/tmp/arc', 'arc-src')

      // archive：fixtureSessions 移除 + mockArchives 落 archived 态条目（形状对齐 real）
      await expect(session.archive(created.id)).resolves.toEqual({ sessionId: created.id })
      const archives = await session.listArchives()
      const entry = archives.find((a) => a.sessionId === created.id)
      expect(entry).toMatchObject({ sessionId: created.id, name: 'arc-src', status: 'archived', codec: 'zstd-3' })
      // ArchiveSummary 是 staging|archived 可辨识联合（列表可含压缩未完成的 staging 条目，
      // real listArchiveEntries 只滤 restoring）——sha256 只在 archived 分支，先按判别字段收窄
      if (!entry || entry.status !== 'archived') {
        throw new Error(`expected archived ledger entry, got ${JSON.stringify(entry)}`)
      }
      expect(entry.sha256).toHaveLength(64)
      // 列表快照隔离：调用方突变不污染源数组
      archives[0]!.name = 'mutated'
      expect((await session.listArchives()).find((a) => a.sessionId === created.id)!.name).toBe('arc-src')
      // 不存在 session 归档 → 抛错
      await expect(session.archive('ghost-id')).rejects.toThrow('不存在')

      // unarchive：预备表 session 放回 fixtureSessions + reply 形状对齐 real（{ sessionId, session } 解包后）
      const restored = await session.unarchive(created.id)
      expect(restored.id).toBe(created.id)
      expect(await session.listArchives()).toEqual([])
      // 不存在归档记录恢复 → 抛错
      await expect(session.unarchive('ghost-id')).rejects.toThrow('不存在')

      // purgeArchive：重新归档后彻底删除（mock 无 keep-all 分支，恒干净删除）——
      // 终态 session 不在 fixtureSessions（archive 已移除、purge 不放回），无需收尾清理
      await session.archive(created.id)
      await expect(session.purgeArchive(created.id)).resolves.toEqual({ sessionId: created.id })
      expect(await session.listArchives()).toEqual([])
      await expect(session.purgeArchive('ghost-id')).rejects.toThrow('不存在')
    })

    it('getCommands / getContext / getSubagents(s3 fixture) / getWorkflows / 空历史与 stub 动作', async () => {
      const cmds = await session.getCommands('s1')
      expect(cmds.commands.length).toBeGreaterThan(0)
      expect((await session.getContext('s1')).usagePercent).toBeDefined()
      expect((await session.getSubagents('s3')).subagents.length).toBeGreaterThan(0)
      // [RT-4#8] 结构化返回（records/oversize 语义同 real 域；mock 恒非 oversize）
      // [待裁决项 4] found: true = mock 的 session 恒在册（「不在册」形态无 mock 数据源）
      expect(await session.getSubagents('other')).toEqual({ subagents: [], oversize: undefined, found: true })
      expect(await session.getSubagentHistory('s1', 'a1')).toEqual([])
      expect(await session.getAgentCallHistory('s1', 'ac1')).toEqual([])
      expect((await session.getWorkflows('s3')).workflows.length).toBeGreaterThan(0)
      expect(await session.getWorkflows('other')).toEqual({ workflows: [], oversize: undefined, found: true })
      // workflow 可视化拉取（G4 锚定补齐成员）：两通道按 runId 查预置表分发（[D8]
      // workflow-overlay-refine §3.3——事件流与 DAG 均为演员预置成品，mock 内不跑解析器）；
      // 未登记 runId 恒 record_not_found 负例；两臂恒带 sessionId（C-comm-05，形态对齐 real）
      const runEvents = await session.getWorkflowRunEvents('s3', 'wf-mock-001')
      expect(runEvents.runId).toBe('wf-mock-001')
      expect(runEvents.sessionId).toBe('s3')
      expect('events' in runEvents && runEvents.events.length).toBeGreaterThan(0)
      expect(await session.getWorkflowRunEvents('s3', 'other-run')).toEqual({ sessionId: 's3', runId: 'other-run', code: 'record_not_found', message: 'mock 无 record 事件流记录' })
      // [D8 定稿①] wf-mock-001 同批接 DAG 通道：返回预置成品 DAG（原「DAG 恒 record_not_found」
      // 断言按新分发改写——降级断言的数据载体移 parse_failed 演员，定稿③）
      const dag001 = await session.getWorkflowDag('s3', 'wf-mock-001')
      expect(dag001.sessionId).toBe('s3')
      expect('dag' in dag001 && dag001.dag.nodes.map((n) => n.templateName)).toEqual(['dev-W1', 'review-W1'])
      // [D8 定稿③] parse_failed 演员承载降级断言：错误臂原样透出（原因码 + message）
      expect(await session.getWorkflowDag('s3', 'wf-mock-parse-failed')).toEqual({ sessionId: 's3', runId: 'wf-mock-parse-failed', code: 'parse_failed', message: 'Unexpected token (3:5)' })
      // 未登记 runId 的 DAG 负例（record_not_found 负例覆盖保留，不随通道分支化改写）
      expect(await session.getWorkflowDag('s3', 'other-run')).toEqual({ sessionId: 's3', runId: 'other-run', code: 'record_not_found', message: 'mock 无 record 文件基建' })
      // [D8] 十演员两通道可达对账（冻结清单 = workflow-data.ts 头注释 + runlog 首条；
      // u-wf-e2e 按该清单 runId 写断言）——事件流逐演员成功回执、DAG 成功臂或 parse_failed 错误臂
      const actorRunIds = ['wf-mock-running', 'wf-mock-pending', 'wf-mock-failed', 'wf-mock-retrying', 'wf-mock-interrupted', 'wf-mock-stopped-time-limited', 'wf-mock-parse-failed', 'wf-mock-empty-dag', 'wf-mock-wide-phase', 'wf-mock-mismatched-calls']
      for (const actorId of actorRunIds) {
        const events = await session.getWorkflowRunEvents('s3', actorId)
        expect('events' in events, `${actorId} 事件流可达`).toBe(true)
        const dag = await session.getWorkflowDag('s3', actorId)
        expect('dag' in dag || dag.code === 'parse_failed', `${actorId} DAG 回执可达（成功臂或 parse_failed 错误臂）`).toBe(true)
      }
      // [G4 锚定补齐] 缺失成员 stub：引擎配置视图 / 默认引擎回执回显 / agent call 路径恒空串
      //（engineModels/engineDefaults = engine-provider-unification D5 扩展键，mock 层空表/空偏好）
      expect(await session.getSubagentEngineConfig()).toEqual({ engines: [], defaultEngine: '', engineModels: {}, engineDefaults: {} })
      expect(await session.setSubagentDefaultEngine('eng-x')).toEqual({ engineId: 'eng-x' })
      // D5 per-engine 默认模型写入：回执 = 请求值回显（setSubagentDefaultEngine mock 同模式）
      expect(await session.setSubagentEngineDefaultModel('eng-x', 'prov-a/m-1')).toEqual({ engineId: 'eng-x', modelRef: 'prov-a/m-1' })
      expect(await session.getAgentCallFilePath('s1', 'ac1')).toBe('')
      // workflowAction 仅 'abort'（pause/resume 已随扩展 D-2 移除，real 域参数为 'abort' 字面量）
      await expect(session.workflowAction('s3', 'abort', 'r1')).resolves.toBeUndefined()
      await expect(session.subagentAction('s3', 'message', { text: 'hi' })).resolves.toBeUndefined()
      await expect(session.handoff('s1', 'ok')).resolves.toBeUndefined()
      // options（modelOverride/thinkingOverride）mock 不仿真（无 HandoffService），签名对齐 resolve
      await expect(session.handoff('s1', 'ok', { modelOverride: 'x/m', thinkingOverride: 'high' })).resolves.toBeUndefined()
      await expect(session.abortHandoff('s1')).resolves.toBeUndefined()
      await expect(session.forceQuit('s1')).resolves.toBeUndefined()
    })

    it('subscribe/unsubscribe（空快照）+ trace / systemPrompt 失败路径 + ipc-converge 写 stub', async () => {
      expect(await session.subscribe('s1')).toEqual({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
      await expect(session.unsubscribe('s1')).resolves.toBeUndefined()
      const trace = await session.getTraceEntries('s1')
      expect(trace.source).toBe('empty')
      await expect(session.fetchCurrentSystemPrompt('s1')).rejects.toMatchObject({ code: 'session_not_active' })
      const img = await session.writeImage({ sessionId: 's1', base64: 'x', mimeType: 'image/png', name: 'n.png' })
      expect(img.persisted).toBe(true)
      expect((await session.migrateImage({ fromPath: '/a', sessionId: 's1', fileName: 'a' })).path).toBe('/a')
      await expect(session.writeSegments({ sessionId: 's1', entry: {} as never })).resolves.toBeUndefined()
      const cand = await session.importCandidates({} as never)
      expect(cand.total).toBe(0)
      await expect(session.importSession({} as never)).rejects.toMatchObject({ code: 'import_source_missing' })
    })

    it('importCandidates/importSession source 路由（sess-session-import u-foundation）：zcode sess_ 形态候选 + 归一化 reply；缺省/pi 空集，未知 source 两侧同构抛 import_source_missing', async () => {
      // zcode 分支：sessionId 带 sess_ 前缀（原始源 id 形态）+ dirLabel = basename(cwd)
      // + sourcePath 为 db 路径结构占位（候选间共享同源，不参与 zcode query 匹配）
      const zc = await session.importCandidates({ source: 'zcode' })
      expect(zc.items.length).toBeGreaterThan(0)
      expect(zc.total).toBe(zc.items.length)
      for (const item of zc.items) {
        expect(item.sessionId).toMatch(/^sess_[0-9a-f-]{36}$/)
        expect(item.dirLabel).toBe(item.cwd.split('/').pop())
        expect(item.sourcePath).toBe(zc.items[0].sourcePath)
      }
      // lastModified 降序（契约排序键）+ dirs 按 dirLabel 聚合 count
      const times = zc.items.map((i) => i.lastModified)
      expect([...times].sort((a, b) => b - a)).toEqual(times)
      for (const d of zc.dirs) {
        expect(d.count).toBe(zc.items.filter((i) => i.dirLabel === d.label).length)
      }
      // zcode import 固定 reply：reply.sessionId = T1 归一化形态（剥 sess_ 前缀 + '_'→'-'，
      // 与侧边栏/扫描集同域——非请求传入的原始 sess_ 形态）
      const first = zc.items[0]
      const imported = await session.importSession({ source: 'zcode', sessionId: first.sessionId, sourcePath: first.sourcePath, projectId: 'p1' })
      expect(imported.sessionId).not.toMatch(/^sess_/)
      expect(imported.sessionId).not.toContain('_')
      expect(imported.targetPath).toContain(imported.sessionId)
      // 缺省（向后兼容）/ 显式 pi：pi 分支空候选集（mock 无外部目录可扫）
      const emptyReply = { total: 0, items: [], dirs: [] }
      expect(await session.importCandidates({})).toEqual(emptyReply)
      expect(await session.importCandidates({ source: 'pi' })).toEqual(emptyReply)
      // 类型外未知 source（JS 调用方运行时值）：importCandidates 与 importSession 同构抛
      // import_source_missing（对齐 real 侧 resolveSource 缺项行为）
      await expect(session.importCandidates({ source: 'ghost' as ImportSourceKind })).rejects.toMatchObject({ code: 'import_source_missing' })
      await expect(session.importSession({ sourcePath: '/x.jsonl', projectId: 'p1' })).rejects.toMatchObject({ code: 'import_source_missing' })
    })

    it('setMockE2E(true)：cwd 注入时 e2eTestSession 并入 list / switch / restore 放行；cwd 空串不注入', async () => {
      setMockE2E(true)
      const groups = await session.list()
      const all = groups.flatMap((g) => g.sessions)
      const found = all.find((s) => s.id === e2eTestSession.id)
      if (e2eTestSession.cwd) {
        expect(found).toBeDefined()
        await expect(session.switchSession(e2eTestSession.id)).resolves.toBeUndefined()
        await expect(session.restoreSession(e2eTestSession.id)).resolves.toMatchObject({ id: e2eTestSession.id })
      } else {
        // 非 E2E 构建（cwd 为 define 注入的空串）：不注入，且按 id 直查仍放行（isE2E 分支）
        expect(found).toBeUndefined()
        await expect(session.switchSession(e2eTestSession.id)).resolves.toBeUndefined()
      }
    })
  })

  // ── mock chat domain ────────────────────────────────────────────────────────
  describe('mock chat domain', () => {
    it('getHistory（[u6] 窗口契约三字段，getFullHistory 已退役）：未知 session 空数组；abort 推 complete(aborted)', async () => {
      expect(await chat.getHistory('no-such')).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      const got: string[] = []
      const un = chat.streamSubscribe('s-abort', (m) => got.push(m.type))
      await chat.abort('s-abort')
      await waitFor(() => got.includes('message.complete'))
      un()
    })

    // [R3-b03-1 降 stub 连带] chat.send 已降 ack stub（u3b 后生产零调用，协议镜像保留），
    // 流式闭环断言改从 submitDelivery 驱动（同一 runSendStream 流，覆盖不缩水）。
    // submitDelivery 先广播一条 session.delivery 快照帧，序列断言过滤该帧保持原语义。
    it('submitDelivery：完整流式闭环（message_start → … → complete(usage)）', async () => {
      const frames: ServerMessageUnion[] = []
      const un = chat.streamSubscribe('s-send', (m) => frames.push(m))
      await chat.submitDelivery('s-send', 'hello', 'u-send-1')
      await waitFor(() => frames.some((m) => m.type === 'message.complete'))
      un()
      const types = frames.filter((m) => m.type !== 'session.delivery').map((m) => m.type)
      expect(types[0]).toBe('message.message_start')
      expect(types).toContain('message.thinking_start')
      expect(types).toContain('message.tool_call_start')
      expect(types).toContain('message.file_changes')
      expect(types[types.length - 1]).toBe('message.complete')
    })

    it('bash：happy path exitCode 0 + abortBash 推 message.bashAborted 兜底终态', async () => {
      const frames: ServerMessageUnion[] = []
      const un = chat.streamSubscribe('s-bash', (m) => frames.push(m))
      await chat.bash('s-bash', 'ls')
      await waitFor(() => frames.some((m) => m.type === 'message.bashResult'))
      const result = frames.find((m) => m.type === 'message.bashResult')?.payload as { output: string; exitCode: number }
      expect(result.output).toBe('(mock) ls')
      expect(result.exitCode).toBe(0)
      await chat.abortBash('s-bash')
      // 兜底终态走独立帧 message.bashAborted（msg-pipeline-debloat D4-3，与 runtime abortBash 同形）
      await waitFor(() => frames.some((m) => m.type === 'message.bashAborted'))
      un()
    })

    it('compact：compacting → compacted 生命周期', async () => {
      const frames: string[] = []
      const un = chat.streamSubscribe('s-compact', (m) => frames.push(m.type))
      await chat.compact('s-compact')
      await waitFor(() => frames.includes('session.compacted'))
      expect(frames.indexOf('session.compacting')).toBeLessThan(frames.indexOf('session.compacted'))
      un()
    })

    // [u5a 退役] 前身用例「steer/followUp：入队 queue_update → drain（队列清空 + assistant 补发）」
    // 已删：mock 的 steer/followUp 镜像与其唯一职责（喂 queue_update 快照）整体退役——u3b 退役
    // queue_update 消费路径、u3c 队列区转 session.delivery 单源后该链零消费方（mock-domains 与
    // dbg-steer 是仅存的消费方，属测试对被测机制的自证，非回归防线）。
    it('submitDelivery：提交 → session.delivery 快照帧（in-flight/direct）+ 流式闭环', async () => {
      const frames: ServerMessageUnion[] = []
      const un = chat.streamSubscribe('s-queue', (m) => frames.push(m))
      const reply = await chat.submitDelivery('s-queue', 'queue-text', 'u-queue-1')
      expect(reply).toEqual({ clientUuid: 'u-queue-1', state: 'in-flight', lane: 'direct' })
      const snapshot = frames.find((m) => m.type === 'session.delivery')
      expect(snapshot, 'submitDelivery 应广播 session.delivery 快照帧').toBeTruthy()
      const entries = (snapshot!.payload as { entries: Array<{ clientUuid: string; preview: string; state: string; lane: string }> }).entries
      expect(entries).toEqual([{ clientUuid: 'u-queue-1', preview: 'queue-text', state: 'in-flight', lane: 'direct' }])
      await waitFor(() => frames.some((m) => m.type === 'message.complete'))
      un()
    })

    // [u5a 收编] cancel/drain/resync 三方法（前身由 renderer delivery 门面的自建 mock 分支承担，
    // core mock 补齐后回归门面范式）——断言「协议合法最小响应，不伪造投递事实」。
    it('cancelDelivery/drainDelivery/resyncDelivery：协议合法最小响应（不伪造投递事实）', async () => {
      const cancelled = await chat.cancelDelivery('s-del', 'u-del-1')
      expect(cancelled).toEqual({
        clientUuid: 'u-del-1',
        cancelled: false,
        reason: 'mock: no kernel backing for s-del',
      })
      expect(await chat.drainDelivery('s-del')).toEqual({ sessionId: 's-del', entries: [] })
      expect(await chat.resyncDelivery('s-del', [])).toEqual({ sessionId: 's-del', deduped: [] })
    })
  })

  // ── mock config / model / extension / plugin / composer / search ───────────
  describe('mock config domain', () => {
    it('listProviders / 订阅初始推 / setProvider 合并字段 + 广播', async () => {
      const r = await config.listProviders()
      expect(r.providers.length).toBeGreaterThan(0)
      const seen: Array<{ providers: unknown[]; scopedModels?: string[] }> = []
      const un = config.onProviders((providers, scopedModels) => seen.push({ providers, scopedModels }))
      await waitFor(() => seen.length > 0)
      const first = r.providers[0]
      if (first) {
        await config.setProvider(first.id, { name: 'renamed', enabled: true })
        await waitFor(() => seen.some((s) => (s.providers[0] as { name?: string })?.name === 'renamed'))
      }
      un()
    })

    it('空签名同构 stub：builtin/refresh/checkEnv/oauth/discover/detectSources', async () => {
      expect(await config.listBuiltinProviders()).toEqual([])
      expect(await config.refreshProviderCatalogs()).toEqual({ refreshed: [], failed: [], corrupt: [] })
      // W3c/W1 新增 config.*：mock 无网络/落盘层，签名同构 ack（presets 返编译期基线，
      // 与 runtime listQuotaPresets() 的「远程 ?? 基线」同口径——mock 层额度类型下拉非空）
      expect(await config.listQuotaPresets()).toEqual(QUOTA_PRESETS)
      await expect(config.setProviderCatalogWatch(true)).resolves.toBeUndefined()
      expect(await config.checkEnvVars(['PATH'])).toEqual({ PATH: true })
      expect(await config.oauthLogin('p')).toMatchObject({ started: false })
      expect(await config.oauthCancel('p')).toEqual({ cancelled: false })
      expect(await config.oauthLogout('p')).toEqual({ ok: true })
      expect(await config.hasOAuth('p')).toBe(false)
      for (const k of ['onAuthDeviceCode', 'onAuthAuthUrl', 'onAuthSuccess', 'onAuthError'] as const) {
        const unsub = config[k](() => {})
        expect(typeof unsub).toBe('function')
        unsub()
      }
      expect(await config.discoverModels({ baseUrl: 'x' })).toEqual({ success: true, models: [], error: undefined })
      expect(await config.detectSources()).toEqual([])
    })

    it('provider 增删/启停：deleteProvider / toggleProviderEnabled / removeProviderByKind', async () => {
      const created = await session.create('/tmp/cfg')
      void created
      const before = (await config.listProviders()).providers
      const victim = before[0]
      if (victim) {
        await config.toggleProviderEnabled(victim.id, false)
        await config.deleteProvider(victim.id)
        await config.removeProviderByKind(victim.id, 'custom')
        const after = (await config.listProviders()).providers
        expect(after.some((p) => p.id === victim.id)).toBe(false)
      }
    })

    it('setDefaultModel / setScopedModels（去重 + default 联动）', async () => {
      const defaults: string[] = []
      const un = config.onDefaults((m) => defaults.push(m))
      await waitFor(() => defaults.length > 0)
      await config.setDefaultModel('prov' as ProviderId, 'm1')
      await waitFor(() => defaults.includes('prov/m1'))
      const scoped = await config.setScopedModels(['a/1', 'a/1', 'a/2'])
      expect(scoped).toEqual(['a/1', 'a/2'])
      await waitFor(() => defaults.includes('a/1'))
      const empty = await config.setScopedModels([])
      expect(empty).toEqual([])
      un()
    })

    it('revealProviderApiKey：apiKeySet=true 的 fixture 返回占位明文；未设置 → available:false', async () => {
      // mock 无真实凭据文件：apiKeySet=true 的 fixture 返回占位明文（保 UI 可演示）。
      // 不用 anthropic：同文件前面的删除用例会摘掉 fixture 首项（测试共享可变 fixture）
      await expect(config.revealProviderApiKey('openai' as ProviderId)).resolves.toEqual({
        available: true,
        apiKey: 'sk-mock-openai',
        source: 'models.json',
      })
      // 未设置凭据的 provider 同实机语义：无可回显内容
      await expect(config.revealProviderApiKey('ollama-local' as ProviderId)).resolves.toEqual({ available: false })
      // 未知 provider 同样不报错（眼睛按钮只在 apiKeySet=true 时渲染，未知 id 属防御分支）
      await expect(config.revealProviderApiKey('no-such-provider' as ProviderId)).resolves.toEqual({ available: false })
    })

    it('skills/agents 订阅 + scan/set/delete + 目录管道 setSkillDirs/setAgentDirs/setExtensionDirs', async () => {
      const skills: unknown[][] = []
      const agents: unknown[][] = []
      const skillDirs: unknown[][] = []
      const agentDirs: unknown[][] = []
      const extDirs: unknown[][] = []
      const unS = config.onSkills((s) => skills.push(s))
      const unA = config.onAgents((a) => agents.push(a))
      const unSd = config.onSkillDirs((d) => skillDirs.push(d))
      const unAd = config.onAgentDirs((d) => agentDirs.push(d))
      const unEd = config.onExtensionDirs((d) => extDirs.push(d))
      await waitFor(() => skills.length > 0 && agents.length > 0 && skillDirs.length > 0 && agentDirs.length > 0 && extDirs.length > 0)
      await config.scanSkills(['x'])
      await config.scanAgents(['x'])
      // [G4 锚定] 返回类型补齐：real 返回扫描结果，mock 无文件系统扫描恒 []
      expect(await config.scanSkills(['x'])).toEqual([])
      expect(await config.scanAgents(['x'])).toEqual([])
      await config.scanSessionSkills('/cwd')
      expect(await config.getGlobalSkills()).toEqual(skills[0])
      expect(await config.getProjectSkills('/cwd')).toEqual([])
      const firstSkill = skills[0]?.[0] as { id: string } | undefined
      if (firstSkill) {
        await config.setSkill(firstSkill as unknown as Parameters<typeof config.setSkill>[0])
        await config.deleteSkill(firstSkill.id)
      }
      const firstAgent = agents[0]?.[0] as { id: string } | undefined
      if (firstAgent) {
        await config.setAgent(firstAgent as unknown as Parameters<typeof config.setAgent>[0])
        await config.deleteAgent(firstAgent.id)
      }
      await config.setSkillDirs([{ path: '.agents/skills', enabled: true, scope: 'project' }])
      await config.setAgentDirs([{ path: '~/.agents/agents', enabled: true, scope: 'global' }])
      await config.setExtensionDirs([])
      await config.onSkillCacheInvalidated(() => {})()
      unS(); unA(); unSd(); unAd(); unEd()
    })

    it('provider 导入预览/应用 + onDefaultsWithSource + systemPrompt/terminal 配置', async () => {
      const defaults: Array<{ defaultModel: string; source?: string }> = []
      const un1 = config.onDefaultsWithSource((p) => defaults.push(p))
      await config.setDefaultModel('p2' as ProviderId, 'm')
      await waitFor(() => defaults.some((d) => d.defaultModel === 'p2/m'))
      un1()
      // real 域返回成功/错误联合（错误以 envelope 返回）；mock 恒成功，断言前按 discriminant 收窄
      const imported = await config.previewImportProviders('pi')
      if (!('preview' in imported)) throw new Error('mock previewImportProviders 恒成功，不应返回 error')
      expect(imported.preview.providers).toHaveLength(1)
      const applied = await config.applyImportProviders('id', ['demo-provider'])
      if (!('result' in applied)) throw new Error('mock applyImportProviders 恒成功，不应返回 error')
      expect(applied.result.imported).toHaveLength(1)
      const sp = await config.getSystemPrompt()
      expect(sp.corrupted).toBe(false)
      const spSeen: unknown[] = []
      const un2 = config.onSystemPrompt(() => spSeen.push(1))
      await config.setSystemPrompt({ version: 1, replace: { enabled: false, prompt: '' }, append: { enabled: true, prompt: 'x' } })
      await waitFor(() => spSeen.length > 0)
      un2()
      const tc = await config.getTerminalConfig()
      expect(tc.corrupted).toBe(false)
      const tcSeen: unknown[] = []
      const un3 = config.onTerminalConfig(() => tcSeen.push(1))
      await config.setTerminalConfig({ ...tc.config, fontSize: 16 })
      await waitFor(() => tcSeen.length > 0)
      un3()
      // retry 配置 stub（[G4 锚定补齐]）：set 回显 configured=true；get 恒 configured=false
      //（mock 不持久化不广播，保真度登记 docs/TEST-STRATEGY.md §5）
      const rcSet = await config.setRetryConfig({ enabled: false, maxRetries: 5, baseDelayMs: 100 })
      expect(rcSet).toEqual({ config: { enabled: false, maxRetries: 5, baseDelayMs: 100 }, configured: true })
      const rc = await config.getRetryConfig()
      expect(rc.configured).toBe(false)
      expect(typeof config.onRetryConfig(() => {})).toBe('function')
    })

    it('网络代理 stub（llm-network-proxy U4）：get 内存态 / set 深拷贝广播 / test 恒成功 / stats 演示行 + reset 清空', async () => {
      // get 初始 = 禁用态默认（mock 模块级内存态，此前用例未触碰）
      const np0 = await config.getNetworkProxyConfig()
      expect(np0.config.enabled).toBe(false)
      // set 深拷贝后广播 + 回执同形；调用方原地改写不影响 mock 内存态
      const next = {
        enabled: true,
        proxy: { protocol: 'http' as const, host: '127.0.0.1', port: 7891, username: '', password: '' },
        noProxy: ['localhost'],
        rules: ['api.anthropic.com'],
        ipv4Only: [],
      }
      const npSeen: unknown[] = []
      const unNp = config.onNetworkProxyConfig((c) => npSeen.push(c))
      const npSet = await config.setNetworkProxyConfig(next)
      expect(npSet.config.enabled).toBe(true)
      await waitFor(() => npSeen.some((c) => (c as { enabled?: boolean }).enabled === true))
      // 订阅注册即触发初始推送（mock 订阅型惯例）——set 后广播的是最后一条
      expect(npSeen[npSeen.length - 1]).toEqual(next)
      next.proxy.port = 9999
      const np1 = await config.getNetworkProxyConfig()
      expect(np1.config.proxy.port).toBe(7891)
      // test 恒成功（演示值）；stats 非空演示行、reset 清空
      const testReply = await config.testNetworkProxy(np1.config)
      expect(testReply.ok).toBe(true)
      expect(testReply.stage).toBe('done')
      const stats = await config.getNetworkProxyStats('24h')
      expect(stats.stats.length).toBeGreaterThan(0)
      const afterReset = await config.resetNetworkProxyStats()
      expect(afterReset.stats).toEqual([])
      unNp()
    })

    it('重试规则 stub（subagent-observability §3.3.12）：get 回基线+内存态 / set 深拷贝广播 / 订阅注册即推初始', async () => {
      // get 初始：custom 空（mock 模块级内存态，此前用例未触碰）；builtin = shared 基线快照非空
      const rr0 = await config.getRetryRules()
      expect(rr0.customRules).toEqual([])
      expect(rr0.builtinRules.length).toBeGreaterThan(0)
      // set 深拷贝后广播 + 回执同形；调用方原地改写不影响 mock 内存态
      const custom: RetryableErrorRule[] = [
        { id: 'probe-rr', name: 'probe', verdict: 'retryable', class: 'provider', source: 'custom', match: [{ kind: 'pattern', pattern: 'x' }] },
      ]
      const rrSeen: Array<{ builtinRules: unknown[]; customRules: unknown[] }> = []
      const un = config.onRetryRules((p) => rrSeen.push(p))
      await waitFor(() => rrSeen.length > 0) // 订阅注册即触发初始推送（mock 订阅型惯例）
      const rrSet = await config.setRetryRules(custom)
      expect(rrSet.customRules).toHaveLength(1)
      await waitFor(() => rrSeen.length > 1)
      expect(rrSeen[rrSeen.length - 1]!.customRules).toHaveLength(1)
      custom[0]!.id = 'mutated'
      const rr1 = await config.getRetryRules()
      expect(rr1.customRules[0]!.id).toBe('probe-rr')
      un()
    })
  })

  describe('mock model / extension / plugin / composer / search domain', () => {
    it('model.onModels 初始推 + switchModel 回执回显', async () => {
      const models: unknown[] = []
      const un = model.onModels((m) => models.push(m))
      await waitFor(() => models.length > 0)
      expect(await model.switchModel('s1', 'prov' as ProviderId, 'm1')).toEqual({ sessionId: 's1', provider: 'prov', modelId: 'm1' })
      un()
    })

    it('extension：scan/toggle/install(npm: 前缀剥离)/uninstall/多步安装/推荐列表/升级', async () => {
      const list: Array<{ name: string; enabled: boolean }>[] = []
      const un = extension.onExtensions((e) => list.push(e as Array<{ name: string; enabled: boolean }>))
      await waitFor(() => list.length > 0)
      await extension.scan()
      const current = list[list.length - 1] ?? []
      const target = current[0]
      if (target) {
        const r = await extension.toggle(target.name, false)
        expect(r.extensions.some((e) => e.name === target.name)).toBe(true)
      }
      await extension.install('npm:@demo/pkg')
      await waitFor(() => (list[list.length - 1] ?? []).some((e) => e.name === '@demo/pkg'))
      await extension.uninstall('@demo/pkg')
      const dir = await extension.installDir('/some/dir')
      expect(dir.candidates).toBeDefined()
      const git = await extension.installGitRepository('https://x')
      expect(git.tempDir).toContain('/mock/tmp/')
      await extension.finishInstall(dir.tempDir, [])
      await extension.cancelInstall(dir.tempDir)
      const rec = await extension.fetchRecommended()
      expect(Array.isArray(rec)).toBe(true)
      for (const r of rec) {
        expect(typeof r.installed).toBe('boolean')
      }
      await extension.upgrade('x')
      await extension.setAutoUpgrade('x', true)
      un()
    })

    it('plugin.onPlugins 空订阅 + 权限 stub + settings 转发 + composer 候选', async () => {
      const plugins: unknown[][] = []
      const un = plugin.onPlugins((p) => plugins.push(p))
      await waitFor(() => plugins.length > 0)
      expect(plugins[0]).toEqual([])
      un()
      // [G4 锚定补齐] 权限审批/回收/拒绝 stub：mock 无插件运行时，ack resolve 即可
      await expect(plugin.approvePermissions('p1', ['fs.read'])).resolves.toBeUndefined()
      await expect(plugin.revokePermissions('p1')).resolves.toBeUndefined()
      await expect(plugin.denyPermissions('p1')).resolves.toBeUndefined()
      expect(typeof settings.onProviders).toBe('function')
      expect(settings.listProviders).toBe(config.listProviders)
      // getMentionCandidates 对齐 real 已废弃语义（恒 []）；getFileCandidates 与 real 同签名（sessionId）
      expect(await composer.getMentionCandidates()).toEqual([])
      const files = await composer.getFileCandidates('s1')
      expect(files.every((f) => f.type === 'dir' || f.type === 'file')).toBe(true)
      // landing cwd 路 stub（现消费方直连 real domain，mock 保持签名同构）
      expect(await composer.getFileCandidatesByCwd('/any')).toEqual({ files: [], truncated: false })
    })

    it('plugin 运行态/清单/两段式安装 stub（S13 + provider-plugin-access D9/D8/U5/U4：mock 无插件运行时的显式降级形态）', async () => {
      // 运行态：list/toggle 恒空列表（与 onPlugins 恒空同形态）
      await expect(plugin.listPlugins()).resolves.toEqual([])
      await expect(plugin.togglePlugin('p1', true)).resolves.toEqual([])
      // invoke/uiEvent/executeCommand：ack 型 stub，invoke 返回 undefined（无插件业务方法可调）
      await expect(plugin.invokePlugin('p1', 'getStatus')).resolves.toBeUndefined()
      await expect(
        plugin.sendPluginUiEvent({ pluginId: 'p1', viewId: 'v', componentId: 'c', event: 'change', value: 1 }),
      ).resolves.toBeUndefined()
      await expect(plugin.executePluginCommand({ pluginId: 'p1', commandId: 'cmd' })).resolves.toBeUndefined()
      // 清单域：恒空清单（mock 无远程清单基建）
      await expect(plugin.listAvailablePlugins()).resolves.toEqual({ plugins: [] })
      await expect(plugin.getPluginCatalog()).resolves.toEqual({ entries: [] })
      // 两段式安装：prepare 返回最小知情面（pluginId = packageSpec 占位形态）、confirm 演示成功
      const preview = await plugin.preparePluginInstall('@acme/plugin-x')
      expect(preview).toMatchObject({ pluginId: '@acme/plugin-x', packageName: '@acme/plugin-x', version: '0.0.0' })
      await expect(plugin.confirmPluginInstall('p1')).resolves.toEqual({ success: true })
      await expect(plugin.cancelPluginInstall('p1')).resolves.toBeUndefined()
      // 挂载位分区清理：ack 型 stub
      await expect(plugin.clearPluginMountUi('mount-1')).resolves.toBeUndefined()
      // UI 快照拉取（U2 scope 二选一）：mock 无插件运行时恒返空快照
      await expect(plugin.getPluginUiSnapshot({ mountId: 'mount-1', pluginId: 'p1' })).resolves.toEqual({ headerActions: [], views: [] })
      await expect(plugin.getPluginUiSnapshot()).resolves.toEqual({ headerActions: [], views: [] })
    })

    it('plugin 崩溃/事件订阅骨架：mock 无生产方，仅订阅时初始推空骨架值（与 onPlugins 同款订阅形态）', async () => {
      const crashed: unknown[] = []
      const pluginEvents: unknown[] = []
      const offCrashed = plugin.onPluginCrashed((p) => crashed.push(p))
      const offEvents = plugin.onPluginEvent((p) => pluginEvents.push(p))
      await waitFor(() => crashed.length > 0 && pluginEvents.length > 0)
      // 初始推 = fixture 工厂返回的空骨架（makeMockSubscription 订阅即推惯例）；此后无生产方不再有帧
      expect(crashed).toEqual([{ pluginId: '' }])
      expect(pluginEvents).toEqual([{ pluginId: '', channel: '', payload: null }])
      offCrashed()
      offEvents()
    })

    it('search：空查询返回 recent+suggested；有查询按四类过滤', async () => {
      const empty = await search.query('  ')
      expect(empty.map((s) => s.kind)).toEqual(['recent', 'suggested'])
      const hit = await search.query('zzz-no-match-foo')
      expect(hit).toEqual([])
      const all = await search.query('')
      expect(all.length).toBe(2)
    })
  })

  // ── mock workspace / quota / project / preset ───────────────────────────────
  describe('mock workspace / quota / project / preset domain', () => {
    it('workspace：listRecent/record 同源 + detect not-repo', async () => {
      const recent = await workspace.listRecent()
      expect(recent).toHaveLength(3)
      // lastUsedAt 按调用时刻取 Date.now()（ms 级漂移），比对 cwd 序列而非全等
      expect((await workspace.record('/any')).map((r) => r.cwd)).toEqual(recent.map((r) => r.cwd))
      expect(await workspace.detect('/any')).toMatchObject({ mode: 'not-repo' })
      // pin（mock 无持久化，恒 applied）/ 默认会话目录（固定演示路径，真实路径 runtime 动态推导）
      // setPinned 返回的 records 同样按调用时刻取 Date.now()（同上行 lastUsedAt 漂移口径），比对 cwd 序列而非全等
      expect((await workspace.setPinned('/any', true)).records.map((r) => r.cwd)).toEqual(recent.map((r) => r.cwd))
      expect(await workspace.defaultSessionDir()).toBe('/tmp/taiji-mock/defaultSession')
    })

    it('quota：缓存/刷新/配置 stub', async () => {
      expect(await quota.getCached('p')).toEqual({ data: null, lastFetchAt: null })
      expect(await quota.fetchQuota('p')).toEqual({ data: null, lastFetchAt: null })
      expect(await quota.refreshQuota('p')).toEqual({ data: null, lastFetchAt: null })
      expect(await quota.configure({ providerId: 'p', enabled: true })).toEqual({ ok: true })
    })

    it('project：load 默认项基态 + 命令通道内存运转（connection-datasync-ssot u6a 对齐 real）', async () => {
      // load 基态 = 默认项兜底 + revision 水位（real 的 runtime ProjectStore 读时归一化同语义）
      expect(await project.load()).toEqual({
        projects: [{ id: 'proj-default', name: '', lastUsedAt: 0 }],
        activeProjectId: 'proj-default',
        revision: 0,
      })
      // 命令通道（§6.6）：revision 校验 + 执行后 +1，回执完整新状态
      const created = await project.createProject('mock-proj', 0)
      expect(created.revision).toBe(1)
      expect(created.state.projects.some((p) => p.name === 'mock-proj')).toBe(true)
      await expect(project.createProject('x', 0)).rejects.toMatchObject({ code: 'project_revision_mismatch' })
    })

    it('project：rename/remove/setActive 命令通道 + 保护分支（connection-datasync-ssot u6a 对齐 real）', async () => {
      // 自包含建项（不依赖上一用例副作用，it.only 单跑亦稳）
      const base = await project.load()
      const created = await project.createProject('proj-cmd-target', base.revision)
      const target = created.state.projects.find((p) => p.name === 'proj-cmd-target')!
      expect(target.id).not.toBe('proj-default')

      // rename 成功臂：改名生效 + revision 前进
      let st = await project.load()
      const renamed = await project.renameProject(target.id, 'proj-renamed', st.revision)
      expect(renamed.state.projects.find((p) => p.id === target.id)?.name).toBe('proj-renamed')
      expect(renamed.revision).toBe(st.revision + 1)
      // rename 错误臂：revision 失配 / 空名 / 不存在 / 默认项目保护（错误码对齐 real ProjectStore）
      await expect(project.renameProject(target.id, 'x', st.revision + 99)).rejects.toMatchObject({ code: 'project_revision_mismatch' })
      st = await project.load()
      await expect(project.renameProject(target.id, '   ', st.revision)).rejects.toMatchObject({ code: 'project_invalid_name' })
      await expect(project.renameProject('proj-nope', 'x', st.revision)).rejects.toMatchObject({ code: 'project_not_found' })
      await expect(project.renameProject('proj-default', 'x', st.revision)).rejects.toMatchObject({ code: 'project_default_protected' })

      // setActive 成功臂 + 不存在臂
      st = await project.load()
      const activated = await project.setActiveProject('proj-default', st.revision)
      expect(activated.state.activeProjectId).toBe('proj-default')
      await expect(project.setActiveProject('proj-nope', activated.revision)).rejects.toMatchObject({ code: 'project_not_found' })

      // remove 错误臂：默认项目保护 + 不存在
      st = await project.load()
      await expect(project.removeProject('proj-default', st.revision)).rejects.toMatchObject({ code: 'project_default_protected' })
      await expect(project.removeProject('proj-nope', st.revision)).rejects.toMatchObject({ code: 'project_not_found' })
      // remove 成功臂：删除 active 项目 → active 回落默认（先切回 target 再删，覆盖回落分支）
      await project.setActiveProject(target.id, st.revision)
      st = await project.load()
      const removed = await project.removeProject(target.id, st.revision)
      expect(removed.state.projects.some((p) => p.id === target.id)).toBe(false)
      expect(removed.state.activeProjectId).toBe('proj-default')
    })

    it('preset：内置目录非空 + CRUD + default', async () => {
      // [u7a] 由「返回空列表」收尾为返回内置模式目录：空列表与「未加载」不可区分，会让非默认模式
      // 会话的 chip / 声明行永远落不到正常分支（见 mock/index.ts 的 mockPresets 注释）。
      const builtins = await preset.list()
      expect(builtins.map((x) => x.id)).toEqual([
        'builtin:full',
        'builtin:orchestrator',
        'builtin:readonly',
        'builtin:session-dispatch',
      ])
      expect(await preset.getDefault()).toBe('builtin:full')
      const p = { id: 'p1', name: 'n', tools: [] } as never
      const created = await preset.create(p)
      expect(created.id).toBe('p1')
      expect((await preset.list())).toHaveLength(builtins.length + 1)
      await preset.setDefault('p1')
      await preset.update({ ...created, name: 'n2' } as never)
      expect((await preset.list()).find((x) => x.id === 'p1')?.name).toBe('n2')
      await preset.remove('p1')
      expect((await preset.list()).map((x) => x.id)).toEqual(builtins.map((x) => x.id))
    })
  })

  // ── 门面导出与 real/whats 通道 ──────────────────────────────────────────────
  describe('mock 门面导出', () => {
    it('导出齐备（facade 三元消费方逐项存在）', () => {
      for (const key of ['session', 'chat', 'config', 'model', 'extension', 'plugin', 'composer', 'search', 'settings', 'workspace', 'quota', 'project', 'preset', 'btw', 'tts', 'subagent'] as const) {
        expect(mock[key]).toBeDefined()
      }
      expect(typeof mock.setMockE2E).toBe('function')
    })
  })

  // ── mock btw 域（btw-question D6，M2-a；线枚举随 W4b 退役，改走 session.listSessions）──
  /** SessionGroup[] → SessionSummary[] 扁平（保序；本文件 W4b 组共用） */
  function flattenBtwGroups(groups: Awaited<ReturnType<typeof session.listSessions>>): Array<{ id: string; label: string; cwd: string; surface?: string }> {
    return groups.flatMap((g) => g.sessions)
  }

  describe('mock btw 域（D6 控制帧）', () => {
    it('create：sessionId 形态（W4a 后 = pi 真实 id 形态 mock-btw-N）+ mainSid 回显 + forkState 恒 full（mock 无 fork 面，显式登记偏差）', async () => {
      const r = await btw.create('btw-main-a')
      expect(r.sessionId).toMatch(/^mock-btw-/)
      expect(r.mainSid).toBe('btw-main-a')
      expect(r.forkState).toBe('full')
    })

    it('remove 后即出册 + 未命中 id no-op（线枚举经 session.list {surface:"btw"} 断言，见下组）', async () => {
      const line = await btw.create('btw-main-remove')
      // 建线即在 session.list 的 btw 口径内
      const before = flattenBtwGroups(await session.listSessions({ surface: 'btw' }))
      expect(before.map((s) => s.id)).toContain(line.sessionId)
      await btw.remove(line.sessionId)
      const after = flattenBtwGroups(await session.listSessions({ surface: 'btw' }))
      expect(after.map((s) => s.id)).not.toContain(line.sessionId)
      // 未命中 id 不抛（mock v1 不模拟失败口径）
      await expect(btw.remove('ghost-line')).resolves.toBeUndefined()
    })
  })

  // ── mock session.list 通用查询（W4b，设计 §5-W4b mock 侧合成方向）────────────────────
  describe('mock session.list 通用查询（W4b btw 进通用列表）', () => {
    it('{surface:"btw", mainSessionId} 只返回该主会话名下的线（含负例：他主会话的线不得混入）', async () => {
      const mainA = 'btw-query-main-a'
      const mainB = 'btw-query-main-b'
      const a1 = await btw.create(mainA)
      const a2 = await btw.create(mainA)
      const b1 = await btw.create(mainB)

      const lines = flattenBtwGroups(await session.listSessions({ surface: 'btw', mainSessionId: mainA }))
      expect(lines.map((s) => s.id)).toEqual([a1.sessionId, a2.sessionId])
      // 负例：B 主会话的线不得出现在 A 的查询结果里（过滤参数写反时全绿的兜底断言）
      expect(lines.map((s) => s.id)).not.toContain(b1.sessionId)
      // 全部条目 surface 恒 'btw'（侧栏条目不得混入）
      expect(lines.every((s) => s.surface === 'btw')).toBe(true)
    })

    it('线条目合成：label = btw-<序号>（§3.4.3）+ cwd = 主会话 fixture cwd；孤儿 mainSid 取占位不留空', async () => {
      // fixture 主会话（s1 cwd = /Users/dev/Code/taiji）：cwd 取所属主会话 fixture 值
      const f1 = await btw.create('s1')
      const f2 = await btw.create('s1')
      const fixtureLines = flattenBtwGroups(await session.listSessions({ surface: 'btw', mainSessionId: 's1' }))
        .filter((s) => s.id === f1.sessionId || s.id === f2.sessionId)
      expect(fixtureLines.map((s) => [s.id, s.label, s.cwd])).toEqual([
        [f1.sessionId, 'btw-1', '/Users/dev/Code/taiji'],
        [f2.sessionId, 'btw-2', '/Users/dev/Code/taiji'],
      ])

      // 孤儿 mainSid（fixture 无该主会话）：cwd = 约定占位 `<mock>/btw-<线 sessionId>`，不留空
      const orphan = await btw.create('btw-query-orphan-main')
      const orphanEntry = flattenBtwGroups(await session.listSessions({ surface: 'btw', mainSessionId: 'btw-query-orphan-main' }))[0]
      expect(orphanEntry.id).toBe(orphan.sessionId)
      expect(orphanEntry.cwd).toBe(`<mock>/btw-${orphan.sessionId}`)
      expect(orphanEntry.label).toBe('btw-1')
    })

    it('{surface:"sidebar"} 与 config.sessions 查询/广播口径逐条一致（项 12② 的 mock 侧镜像）', async () => {
      const viaList = await session.list()
      const viaSidebarQuery = await session.listSessions({ surface: 'sidebar' })
      expect(viaSidebarQuery).toEqual(viaList)
      // 侧栏口径不含任何 btw 线条目
      expect(flattenBtwGroups(viaSidebarQuery).some((s) => s.surface === 'btw')).toBe(false)
    })

    it('无参 = 全量：侧栏条目 + 全部线条目并存', async () => {
      const all = flattenBtwGroups(await session.listSessions({}))
      const sidebarCount = flattenBtwGroups(await session.listSessions({ surface: 'sidebar' })).length
      const btwCount = flattenBtwGroups(await session.listSessions({ surface: 'btw' })).length
      expect(all.length).toBe(sidebarCount + btwCount)
    })

    it('抑制类成员判别唯一来源（收编落地）：session.list{surface:"btw"} 的 id 集合 = 注册表线全集，create/remove 同拍收敛', async () => {
      // W4b 收编（§5-W4b 四步之①③）已落地：renderer 抑制类判别（btw-line-membership 模块）
      // 唯一读 session.list {surface:'btw'} 拉取缓存——原 session.surfaces 广播帧与其
      // 只读派生表已按协议收缩删除（mock pushSurfaces 同批删）。数据层判据 = 该查询返回的
      // 线成员集合与 mock 线注册表（mockBtwThreads，create/remove 唯一写入口）逐条一致：
      // 建线即入、关线即出（成员一致 ⇒ 抑制判别结果一致）。
      const a1 = await btw.create('btw-equiv-main-a')
      const a2 = await btw.create('btw-equiv-main-a')
      const b1 = await btw.create('btw-equiv-main-b')

      const inScope = (id: string): boolean => id === a1.sessionId || id === a2.sessionId || id === b1.sessionId
      const listBtwIds = () => session.listSessions({ surface: 'btw' }).then((groups) =>
        new Set(flattenBtwGroups(groups).map((s) => s.id).filter(inScope)),
      )

      // 建线同拍入册：三源（两个主会话）全部在线
      expect(await listBtwIds()).toEqual(new Set([a1.sessionId, a2.sessionId, b1.sessionId]))

      await btw.remove(b1.sessionId) // 关线出册
      // b1 已 remove：查询结果同拍不再含它
      expect(await listBtwIds()).toEqual(new Set([a1.sessionId, a2.sessionId]))
    })
  })

  // ── mock tts 域（ai-voice-tts 设计 §7.5，M0）────────────────────────────────
  describe('mock tts 域', () => {
    it('getConfig：默认骨架（三家齐备、hasApiKey 全 false、脱敏无 Key 字段）', async () => {
      const { config: sanitized } = await tts.getConfig()
      for (const pid of ['stepfun', 'minimax', 'mimo'] as const) {
        const entry = sanitized.providers[pid]
        expect(entry.hasApiKey).toBe(false)
        expect(entry.providerKeyAvailable).toBe(false)
        expect(entry.config.baseUrl).not.toContain('apikey')
        expect(Object.keys(entry.config.vendor)).toEqual([])
      }
      expect(sanitized.activeProvider).toBe('minimax')
    })

    it('configure：写入内存态后 getConfig 回读一致（u4 往返单测的 mock 通道）+ apiKeys 语义', async () => {
      const next = { baseUrl: 'https://api.minimax.cn/v1', model: 'speech-2.8-hd', voice: 'male-qn-qingse', vendor: { voice_setting: { vol: 2 } } }
      const r = await tts.configure({
        providerId: 'minimax',
        config: next,
        apiKeys: { minimax: 'sk-test', mimo: null },
      })
      expect(r.ok).toBe(true)
      expect(r.config?.activeProvider).toBe('minimax')
      expect(r.config?.providers.minimax.hasApiKey).toBe(true)
      expect(r.config?.providers.mimo.hasApiKey).toBe(false)
      const readback = await tts.getConfig()
      expect(readback.config.providers.minimax.config).toEqual(next)
    })

    it('getCapabilities：三家派生视图齐备且形状关键位符合控件存在性三分支（MiMo 语速 null 置灰 / MiniMax 情感非空 / StepFun 情感空数组）', async () => {
      const { forms } = await tts.getCapabilities()
      expect(Object.keys(forms).sort()).toEqual(['mimo', 'minimax', 'stepfun'])
      expect(forms.mimo.capabilities.speedRange).toBeNull()
      expect(forms.minimax.emotions.length).toBeGreaterThan(0)
      expect(forms.stepfun.emotions).toEqual([])
      expect(forms.minimax.capabilities.supportsInstructions).toBe(false)
      expect(forms.mimo.capabilities.authHeader).toBe('api-key')
    })

    it('speak：恒以 tts_not_configured 失败（错误路径驱动按钮/toast 状态机）', async () => {
      await expect(tts.speak({ sessionId: 's1', text: '你好' })).rejects.toMatchObject({ code: 'tts_not_configured' })
    })
  })

  // ── mock subagent 域（subagent-model-switch §7.1 入口层，U1）────────────────
  describe('mock subagent 域', () => {
    it('setModel：恒回已记账型应答（mock 无宿主编排/活进程链，不虚构生效值）', async () => {
      await expect(
        mock.subagent.setModel({ recordId: 'rec-1', provider: 'prov' as ProviderId, modelId: 'm1' }),
      ).resolves.toEqual({ kind: 'recorded', note: '已记录，下次执行生效（mock）' })
      await expect(
        mock.subagent.setModel({ runId: 'run-1', provider: 'prov' as ProviderId, modelId: 'm1', thinkingLevel: 'high' }),
      ).resolves.toEqual({ kind: 'recorded', note: '已记录，下次执行生效（mock）' })
    })
  })
});

// ======== 来源：mock-settings-system-fields.test.ts ========
describe("mock-settings-system-fields", () => {
  const FAST_TIMING: Timing = {
    ack: 1, startGap: 1, chunk: 1, done: 1, switchCmd: 1, thinkingGap: 1,
    toolGap: 1, fileChangesGap: 1, retryGap: 1, bashDelay: 1,
  }

  setMockTiming(FAST_TIMING)

  afterAll(() => {
    resetMockTiming()
  })

  describe('mock settings system 字段（worktree）：set 回显 + 写后读回', () => {
    it('rootDir / setupScript / bareSetupScript：字符串回显与读回', async () => {
      expect(await settings.setWorktreeRootDir('/tmp/wt-root')).toEqual({ dir: '/tmp/wt-root' })
      expect(await settings.getWorktreeRootDir()).toEqual({ dir: '/tmp/wt-root' })

      expect(await settings.setSetupScript('echo setup')).toEqual({ script: 'echo setup' })
      expect(await settings.getSetupScript()).toEqual({ script: 'echo setup' })

      expect(await settings.setBareSetupScript('echo bare')).toEqual({ script: 'echo bare' })
      expect(await settings.getBareSetupScript()).toEqual({ script: 'echo bare' })
    })

    it('timeout / defaultBaseBranch：数值与分支名回显与读回', async () => {
      expect(await settings.setWorktreeTimeout(120)).toEqual({ timeout: 120 })
      expect(await settings.getWorktreeTimeout()).toEqual({ timeout: 120 })

      expect(await settings.setDefaultBaseBranch('develop')).toEqual({ baseBranch: 'develop' })
      expect(await settings.getDefaultBaseBranch()).toEqual({ baseBranch: 'develop' })
    })
  })

  describe('mock settings system 字段（自动重命名）：set 回显 + 写后读回', () => {
    it('enabled / mode / model 三字段', async () => {
      expect(await settings.setAutoRenameEnabled(true)).toEqual({ enabled: true })
      expect(await settings.getAutoRenameEnabled()).toEqual({ enabled: true })

      expect(await settings.setRenameMode('first-stop')).toEqual({ mode: 'first-stop' })
      expect(await settings.getRenameMode()).toEqual({ mode: 'first-stop' })

      expect(await settings.setRenameModel('claude-sonnet-4.5')).toEqual({ model: 'claude-sonnet-4.5' })
      expect(await settings.getRenameModel()).toEqual({ model: 'claude-sonnet-4.5' })
    })

    it('style / instruction / maxLength 三字段（rename 标题提示词配置）', async () => {
      expect(await settings.setRenamePrompt('emoji', '🔥 probe')).toEqual({
        style: 'emoji',
        instruction: '🔥 probe',
        corrupted: false,
      })
      expect(await settings.getRenamePrompt()).toEqual({ style: 'emoji', instruction: '🔥 probe', corrupted: false })

      expect(await settings.setRenameMaxLength(80)).toEqual({ maxLength: 80 })
      expect(await settings.getRenameMaxLength()).toEqual({ maxLength: 80 })
    })
  })

  describe('mock settings system 字段（智能上下文）：set 回显 + 写后读回 + 拷贝隔离', () => {
    it('enabled / compactModel / thresholds / excludedModels', async () => {
      expect(await settings.setSmartContextEnabled(true)).toEqual({ enabled: true })
      expect(await settings.setSmartContextCompactModel('glm-flash')).toEqual({ model: 'glm-flash' })

      expect(await settings.setSmartContextThresholds([80, 92])).toEqual({ thresholds: [80, 92] })
      expect(await settings.setSmartContextExcludedModels(['a/b', 'c/d'])).toEqual({ models: ['a/b', 'c/d'] })

      const cfg = await settings.getSmartContextConfig()
      expect(cfg).toEqual({
        enabled: true,
        compactModel: 'glm-flash',
        reminderThresholds: [80, 92],
        excludedModels: ['a/b', 'c/d'],
      })
    })

    it('thresholds 入参拷贝隔离：外部数组后续修改不渗入 mock 内存态', async () => {
      const input = [50, 75]
      await settings.setSmartContextThresholds(input)
      input.push(999)
      expect((await settings.getSmartContextConfig()).reminderThresholds).toEqual([50, 75])
    })
  })

  describe('mock usage 域（[C3] getUsageStats fixture）', () => {
    it('返回 2 条日级用量行 fixture（演示链路完整），sessionCount=2、skippedLines=0', async () => {
      const r = await usage.getUsageStats()
      expect(r.rows).toHaveLength(2)
      expect(r.rows.map((x) => x.date)).toEqual(['2026-09-24', '2026-09-23'])
      expect(r.sessionCount).toBe(2)
      expect(r.skippedLines).toBe(0)
      expect(r.scannedAt).toBeGreaterThan(0)
      // 首行六项指标与 mock 常量对齐（anthropic 主模型行）
      expect(r.rows[0]).toMatchObject({
        provider: 'anthropic',
        model: 'claude-sonnet-4.5',
        project: 'mock-project',
        input: 12_000,
        output: 3_400,
        cacheRead: 8_000,
        cacheWrite: 500,
        costUSD: 0.42,
        messages: 26,
      })
      // 次行 compaction 摘要行（聚合自压缩摘要的同形行）
      expect(r.rows[1]).toMatchObject({ provider: 'compaction', model: 'compaction' })
    })
  })
});

// ======== 来源：run-send-stream.test.ts ========
describe("run-send-stream", () => {
  const ZERO_TIMING: Timing = {
    ack: 0, startGap: 0, chunk: 0, done: 0, switchCmd: 0,
    thinkingGap: 0, toolGap: 0, fileChangesGap: 0, retryGap: 0, bashDelay: 0,
  }

  interface Harness { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    deps: SendStreamDeps
    emitted: ServerMessageUnion[]
    pushed: ServerMessageUnion[]
  }

  function makeHarness(cancelled = false): Harness {
    const emitted: ServerMessageUnion[] = []
    const pushed: ServerMessageUnion[] = []
    let seq = 0
    const deps: SendStreamDeps = {
      nextId: (prefix: string) => `${prefix}-${++seq}`,
      emit: (_sid, msg) => {
        emitted.push(msg)
      },
      sleep: async () => {},
      pushSession: (_sid, msg) => {
        pushed.push(msg)
      },
      isCancelled: () => cancelled,
      TIMING: ZERO_TIMING,
    }
    return { deps, emitted, pushed }
  }

  const types = (msgs: Array<{ type: string }>) => msgs.map((m) => m.type)

  describe('detectBranch 关键词分发', () => {
    it('todo / goal / 默认 read', () => {
      expect(detectBranch('please update the TODO list')).toBe('todo')
      expect(detectBranch('管理任务')).toBe('todo')
      expect(detectBranch('set a goal')).toBe('goal')
      expect(detectBranch('设定目标')).toBe('goal')
      expect(detectBranch('read this file')).toBe('read')
    })
  })

  describe('run-send-stream 默认（read）分支', () => {
    it('完整生命周期：thinking → read tool_call → text → file_changes → complete', async () => {
      const h = makeHarness()
      await runSendStream('s1', 'hello', h.deps)
      const seq = types(h.emitted)
      expect(seq[0]).toBe('message.message_start')
      // thinking 块
      expect(seq).toContain('message.thinking_start')
      expect(seq.filter((t) => t === 'message.thinking_delta').length).toBeGreaterThan(0)
      expect(seq).toContain('message.thinking_end')
      // read 分支 tool_call：start/end 帧存在性（GUI card 细节归 e2e 分工，本测试不展开）
      const startIdx = seq.indexOf('message.tool_call_start')
      expect(startIdx).toBeGreaterThan(-1)
      const endFrame = h.emitted.find((m) => m.type === 'message.tool_call_end')
      expect(endFrame).toBeDefined()
      // 文本流式 + file_changes 两态 + complete（usage 回填）
      expect(seq.filter((t) => t === 'message.text_delta').length).toBeGreaterThan(0)
      const fcFrames = h.emitted.filter((m) => m.type === 'message.file_changes')
      expect(fcFrames.map((f) => (f.payload as { changeSetStatus: string }).changeSetStatus)).toEqual([
        'accumulating',
        'ready',
      ])
      const ready = fcFrames[1]?.payload as { fileChanges: Array<{ status: string }> }
      expect(ready.fileChanges.map((f) => f.status)).toEqual(['modified', 'added', 'unmerged'])
      const complete = h.emitted.find((m) => m.type === 'message.complete')
      expect((complete?.payload as { usage?: { totalTokens: number } }).usage).toMatchObject({ totalTokens: 1922 })
      // 默认分支推 session 通道 widget/widgetGui ×2
      const pushedTypes = types(h.pushed)
      expect(pushedTypes).toContain('extension:widget')
      expect(pushedTypes.filter((t) => t === 'extension:widgetGui')).toHaveLength(2)
    })

    it('取消（isCancelled 恒 true）：仅 message_start 后提前返回', async () => {
      const h = makeHarness(true)
      await runSendStream('s1', 'hello', h.deps)
      expect(types(h.emitted)).toEqual(['message.message_start'])
      expect(h.pushed).toHaveLength(0)
    })
  })

  describe('run-send-stream 关键词触发帧', () => {
    it("含 'retry'：auto_retry_start → auto_retry_end", async () => {
      const h = makeHarness()
      await runSendStream('s1', 'retry please', h.deps)
      const seq = types(h.emitted)
      expect(seq).toContain('message.auto_retry_start')
      expect(seq.indexOf('message.auto_retry_end')).toBeGreaterThan(seq.indexOf('message.auto_retry_start'))
    })

    it("含 'todo'：todo tool_call 序列（details.todos + list-tree GUI），不推 extension widget", async () => {
      const h = makeHarness()
      await runSendStream('s1', 'update todo', h.deps)
      const start = h.emitted.find((m) => m.type === 'message.tool_call_start')
      const entry = (start?.payload as { entry?: { toolName?: string } }).entry
      expect(entry?.toolName).toBe('todo')
      expect(h.pushed).toHaveLength(0)
    })

    it("含 'goal'：goal_control tool_call + goal ANSI widget", async () => {
      const h = makeHarness()
      await runSendStream('s1', 'set goal', h.deps)
      const start = h.emitted.find((m) => m.type === 'message.tool_call_start')
      const entry = (start?.payload as { entry?: { toolName?: string } }).entry
      expect(entry?.toolName).toBe('goal_control')
      const widget = h.pushed.find((m) => m.type === 'extension:widget')
      expect((widget?.payload as { widgetKey?: string }).widgetKey).toBe('goal')
    })

    it("含 'ui-select'：complete 前推 extension.dialog（select 变体 + 选项）", async () => {
      const h = makeHarness()
      await runSendStream('s1', 'ui-select deploy', h.deps)
      const req = h.pushed.find((m) => m.type === 'extension.dialog')
      expect((req?.payload as { dialogKind?: string }).dialogKind).toBe('select')
      expect(((req?.payload as { options?: string[] }).options ?? []).length).toBe(3)
    })

    it("含 'md-table'：text_delta 拼回 markdown 宽表（列宽地板 e2e 检查数据源）", async () => {
      const h = makeHarness()
      await runSendStream('s1', 'md-table', h.deps)
      const text = h.emitted
        .filter((m) => m.type === 'message.text_delta')
        .map((m) => (m.payload as { delta: string }).delta)
        .join('')
      // 表头 + 分隔行 + 数据行齐全（GFM 表格三要素，缺一 markdown-it 不建表）
      expect(text).toContain('| 维度 | pi | zcode | 风险 |')
      expect(text).toContain('| --- | --- | --- | --- |')
      expect(text).toContain('| 报告目录 |')
      expect(text).toContain('| 参数面 |')
      // 管道行数 = 表头 + 分隔 + 2 数据行（trim 后的检查数据源，勿加行——每 CJK 字一个
      //   text_delta 帧 ×70ms，行数直接决定 L1 smoke 用例耗时）
      expect(text.split('\n').filter((l) => l.startsWith('|')).length).toBe(4)
      // 哨兵词只换回复体：生命周期其余帧不变（complete 含 usage 回填）
      expect(types(h.emitted)).toContain('message.complete')
      const complete = h.emitted.find((m) => m.type === 'message.complete')
      expect((complete?.payload as { usage?: { totalTokens: number } }).usage).toMatchObject({ totalTokens: 1922 })
    })

    it("不含哨兵词：回复体仍是固定前缀（md-table 分支不污染普通输入）", async () => {
      const h = makeHarness()
      await runSendStream('s1', '普通输入', h.deps)
      const text = h.emitted
        .filter((m) => m.type === 'message.text_delta')
        .map((m) => (m.payload as { delta: string }).delta)
        .join('')
      expect(text).toContain('好的，我来处理这个请求。（mock 模拟回复）')
      expect(text).not.toContain('| 维度 |')
    })
  })
});
