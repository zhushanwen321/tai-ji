/**
 * mock 门面 + mock file/git domain 单测 —— VITE_MOCK 演示轨道的行为契约：
 * fixture 快照隔离（深拷贝）、session CRUD + 不存在抛错、config/extension/composer/
 * search/workspace/quota/project/preset 各域签名同构（facade 三元）、
 * chat 流式闭环（send → complete）、queue（steer/followUp drain）、bash 四态分流。
 * 时序：setMockTiming 全键压至 1ms（mock 默认节奏面向人眼演示 40ms～2s/步，真实等待
 * 无契约价值——阶段经历顺序不变，只消墙钟），afterAll 还原默认。
 */
import type { ProviderId, ImportSourceKind } from '@taiji/shared'
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import type { ServerMessageUnion } from '@taiji/shared'
import * as events from '../../api/events'
import * as mock from '../index'
import { __clearTimers, setMockE2E, setMockTiming, resetMockTiming, session, chat, config, model, extension, plugin, composer, search, settings, workspace, quota, project, preset } from '../index'
import type { Timing } from '../run-send-stream'
import { file } from '../file'
import { git, fixtureGitStatus } from '../git'
import { e2eTestSession } from '../data'

/** 测试压缩时序：全键 1ms/步（file/git 的 ack 由 setMockTiming 同步压缩） */
const FAST_TIMING: Timing = {
  ack: 1, startGap: 1, chunk: 1, done: 1, switchCmd: 1, thinkingGap: 1,
  toolGap: 1, fileChangesGap: 1, retryGap: 1, steerDrain: 1, bashDelay: 1,
}

/** 轮询等待条件成立（mock 异步推送节奏用，超时 fail） */
async function waitFor(cond: () => boolean, timeoutMs = 10_000, stepMs = 20): Promise<void> {
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

  it('create/fork override 生效面（G4 锚定后 mock 补齐）：override 落 summary 可断言 + fork 血缘/继承', async () => {
    // create 四参 override：presetId→launchPresetId / projectId / modelOverride→modelId / thinkingOverride→thinkingLevel
    const created = await session.create('/tmp/ov', 'ov-src', 'preset-x', 'proj-x', 'test/model-x', 'high')
    expect(created.launchPresetId).toBe('preset-x')
    expect(created.projectId).toBe('proj-x')
    expect(created.modelId).toBe('test/model-x')
    expect(created.thinkingLevel).toBe('high')
    // server-push 同源的 list 快照可断言（fixture 已带 override）
    const groups = await session.list()
    const found = groups.flatMap((g) => g.sessions).find((s) => s.id === created.id)
    expect(found).toMatchObject({ modelId: 'test/model-x', projectId: 'proj-x', launchPresetId: 'preset-x', thinkingLevel: 'high' })
    // fork：override 覆盖（ADR-0056 Staging Mode）+ projectId 继承父归属 + 血缘键
    // parentSession 用源 sessionId（FR-20 fallback 键形态：mock 无 sessionFile）+ forkEntryId
    const forked = await session.fork(created.id, {
      label: 'ov-fork',
      modelOverride: 'test/model-y',
      thinkingOverride: 'low',
      piEntryId: 'pi-entry-1',
    })
    expect(forked.modelId).toBe('test/model-y')
    expect(forked.thinkingLevel).toBe('low')
    expect(forked.projectId).toBe('proj-x')
    expect(forked.parentSession).toBe(created.id)
    expect(forked.forkEntryId).toBe('pi-entry-1')
    await session.remove(created.id)
    await session.remove(forked.id)
  })

  it('getCommands / getContext / getSubagents(s3 fixture) / getWorkflows / 空历史与 stub 动作', async () => {
    const cmds = await session.getCommands('s1')
    expect(cmds.commands.length).toBeGreaterThan(0)
    expect((await session.getContext('s1')).usagePercent).toBeDefined()
    expect((await session.getSubagents('s3')).length).toBeGreaterThan(0)
    expect(await session.getSubagents('other')).toEqual([])
    expect(await session.getSubagentHistory('s1', 'a1')).toEqual([])
    expect(await session.getAgentCallHistory('s1', 'ac1')).toEqual([])
    expect((await session.getWorkflows('s3')).length).toBeGreaterThan(0)
    expect(await session.getWorkflows('other')).toEqual([])
    // [G4 锚定补齐] 缺失成员 stub：引擎配置视图 / 默认引擎回执回显 / agent call 路径恒空串
    expect(await session.getSubagentEngineConfig()).toEqual({ engines: [], defaultEngine: '' })
    expect(await session.setSubagentDefaultEngine('eng-x')).toEqual({ engineId: 'eng-x' })
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

  it('send：完整流式闭环（message_start → … → complete(usage)）', async () => {
    const frames: ServerMessageUnion[] = []
    const un = chat.streamSubscribe('s-send', (m) => frames.push(m))
    await chat.send('s-send', 'hello')
    await waitFor(() => frames.some((m) => m.type === 'message.complete'), 20_000)
    un()
    const types = frames.map((m) => m.type)
    expect(types[0]).toBe('message.message_start')
    expect(types).toContain('message.thinking_start')
    expect(types).toContain('message.tool_call_start')
    expect(types).toContain('message.file_changes')
    expect(types[types.length - 1]).toBe('message.complete')
  })

  it('bash：happy path exitCode 0 + abortBash 推 cancelled', async () => {
    const frames: ServerMessageUnion[] = []
    const un = chat.streamSubscribe('s-bash', (m) => frames.push(m))
    await chat.bash('s-bash', 'ls')
    await waitFor(() => frames.some((m) => m.type === 'message.bashResult'), 10_000)
    const result = frames.find((m) => m.type === 'message.bashResult')?.payload as { output: string; exitCode: number }
    expect(result.output).toBe('(mock) ls')
    expect(result.exitCode).toBe(0)
    await chat.abortBash('s-bash')
    await waitFor(() => frames.filter((m) => m.type === 'message.bashResult').length >= 2)
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

  // 压缩时序下 steer/followUp drain 全链 ~ms 级；30s timeout 保留为宽松上界（防御回归，非真实耗时）
  it('steer/followUp：入队 queue_update → drain（队列清空 + assistant 补发）', { timeout: 30_000 }, async () => {
    const queue: Array<{ steering?: string[]; followUp?: string[] }> = []
    let completes = 0
    const un = chat.streamSubscribe('s-queue', (m) => {
      if (m.type === 'message.queue_update') {
        queue.push(m.payload as { steering?: string[]; followUp?: string[] })
      }
      if (m.type === 'message.complete') completes += 1
    })
    await chat.steer('s-queue', 'steer-text')
    await waitFor(() => completes >= 1, 20_000)
    // 入队帧含 steering，drain 帧（队列清空）两键皆空
    expect(queue.some((q) => q.steering?.includes('steer-text'))).toBe(true)
    expect(queue.some((q) => !q.steering && !q.followUp)).toBe(true)
    queue.length = 0
    completes = 0
    await chat.followUp('s-queue', 'fu-text')
    await waitFor(() => completes >= 1, 20_000)
    expect(queue.some((q) => q.followUp?.includes('fu-text'))).toBe(true)
    expect(queue.some((q) => !q.steering && !q.followUp)).toBe(true)
    un()
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
    expect(await config.refreshProviderCatalogs()).toEqual({ refreshed: [], failed: [] })
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
    // [G4 锚定补齐] 权限审批/回收 stub：mock 无插件运行时，ack resolve 即可
    await expect(plugin.approvePermissions('p1', ['fs.read'])).resolves.toBeUndefined()
    await expect(plugin.revokePermissions('p1')).resolves.toBeUndefined()
    expect(typeof settings.onProviders).toBe('function')
    expect(settings.listProviders).toBe(config.listProviders)
    // getMentionCandidates 对齐 real 已废弃语义（恒 []）；getFileCandidates 与 real 同签名（sessionId）
    expect(await composer.getMentionCandidates()).toEqual([])
    const files = await composer.getFileCandidates('s1')
    expect(files.every((f) => f.type === 'dir' || f.type === 'file')).toBe(true)
    // landing cwd 路 stub（现消费方直连 real domain，mock 保持签名同构）
    expect(await composer.getFileCandidatesByCwd('/any')).toEqual({ files: [], truncated: false })
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
  it('workspace：listRecent/record 同源 + detectBare 非 bare + detect not-repo', async () => {
    const recent = await workspace.listRecent()
    expect(recent).toHaveLength(3)
    // lastUsedAt 按调用时刻取 Date.now()（ms 级漂移），比对 cwd 序列而非全等
    expect((await workspace.record('/any')).map((r) => r.cwd)).toEqual(recent.map((r) => r.cwd))
    expect(await workspace.detectBare('/any')).toMatchObject({ isBare: false })
    expect(await workspace.detect('/any')).toMatchObject({ mode: 'not-repo' })
  })

  it('quota：缓存/刷新/配置 stub', async () => {
    expect(await quota.getCached('p')).toEqual({ data: null, lastFetchAt: null })
    expect(await quota.fetchQuota('p')).toEqual({ data: null, lastFetchAt: null })
    expect(await quota.refreshQuota('p')).toEqual({ data: null, lastFetchAt: null })
    expect(await quota.configure({ providerId: 'p', enabled: true })).toEqual({ ok: true })
  })

  it('project：load 空态 + save ack（[G4 锚定] 对齐 real void 契约，原返回透传偏差已收口）', async () => {
    expect(await project.load()).toEqual({ projects: [], activeProjectId: '' })
    const state = { projects: [], activeProjectId: 'p1' }
    await expect(project.save(state)).resolves.toBeUndefined()
  })

  it('preset：内置目录非空 + CRUD + default', async () => {
    // [u7a] 由「返回空列表」收口为返回内置模式目录：空列表与「未加载」不可区分，会让非默认模式
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
    for (const key of ['session', 'chat', 'config', 'model', 'extension', 'plugin', 'composer', 'search', 'settings', 'workspace', 'quota', 'project', 'preset'] as const) {
      expect(mock[key]).toBeDefined()
    }
    expect(typeof mock.setMockE2E).toBe('function')
  })
})
