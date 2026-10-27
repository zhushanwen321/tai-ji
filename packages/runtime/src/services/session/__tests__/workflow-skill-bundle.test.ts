import type { IPiEngine } from '../../ports/pi-engine.js';
import { FORCED_PROJECT_SKILL_DIR, resolveGlobalSkillDirs, resolveProjectSkillDirs, type SkillDirConfigSource } from '../../skill-dirs.js';
import { BOGUS_DURATION_THRESHOLD_MS, BOGUS_OUTPUT_THRESHOLD, CACHE_TTL_MS, PAIR_RECORD_TUPLE_LENGTH, SPEED_RETENTION_DAYS, TTFT_RECORD_TUPLE_LENGTH, aggregateCacheRatio, aggregateSpeed, aggregateTtft, cacheRatioFilePath, classifyCacheMiss, getCacheRatioDir, getGenStatsDir, getSpeedDir, getTtftDir, hasReportedCacheFields, isBogusSpeedSample, isDisplayedZeroCacheRatio, localDayKey, pruneExpiredDays, readDayRecords, safeModelFileName, speedFilePath, ttftFilePath, type CacheRatioRecord, type GenStatsDayRecords, type SpeedRecord, type TtftRecord, writeDayRecords } from '../gen-stats-store.js';
import { INACTIVE_PLAN_STATE_VIEW, extractPlanStateFromSessionFile, scanPlanStateEntries } from '../plan-state-extractor.js';
import { encodeDirectiveText } from '../session-records.js';
import { LateBoundSkillSource, SkillInjector, type SkillMappingSource } from '../skill-injector.js';
import { projectSubagentModelDetailIntoRuns } from '../workflow-record-projection.js';
import { WorkflowRunEventsReader } from '../workflow-run-events-reader.js';
import { CODE_DENSE_NON_CJK_CHARS_PER_TOKEN, READ_PRECHECK_MAX_BYTES, SKILL_DATA_BLOCK_TAG, SKILL_FALLBACK_GUIDANCE, WorkflowRunRecord, buildSkillMarker, type SkillInfo, type SubagentRecord } from '@taiji/shared';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/session/__tests__/workflow-agent-call-member-key.test.ts
// ======================================================================

function memberRecord(over: Partial<SubagentRecord> & Pick<SubagentRecord, 'subagentId' | 'parentRunId' | 'stepIndex'>): SubagentRecord {
  return {
    sessionFile: null,
    agent: 'dev-W1',
    slug: 'dev',
    task: 'do work',
    status: 'running',
    startedAt: 1000,
    ...over,
  }
}


function runRecord(agentCalls: WorkflowRunRecord['agentCalls']): WorkflowRunRecord {
  return {
    runId: 'wf-1',
    scriptName: 'demo',
    status: 'running',
    startedAt: '2026-10-07T00:00:00.000Z',
    stateFilePath: '/tmp/wf-1.record.jsonl',
    agentCalls,
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('workflow-agent-call-member-key', () => {
describe('projectSubagentModelDetailIntoRuns — agentCall.memberRecordId 透出（成员键单源）', () => {
  it('权威成员在场 → agentCall.memberRecordId = 成员 record id（无覆盖/生效值也透出——回执态读取键在首次切换前就位）', () => {
    const runs = [runRecord([{ id: 0, agent: 'dev-W1', status: 'running' }])]
    const subagents = [
      memberRecord({ subagentId: 'rec-member-1', parentRunId: 'wf-1', stepIndex: 0 }),
    ]

    const [projected] = projectSubagentModelDetailIntoRuns('main-1', runs, subagents, undefined)

    expect(projected?.agentCalls[0]?.memberRecordId).toBe('rec-member-1')
    // 覆盖/生效值缺席时不造这两键（成员标识是唯一恒透出字段）
    expect(projected?.agentCalls[0]?.modelOverride).toBeUndefined()
    expect(projected?.agentCalls[0]?.recentEffectiveModel).toBeUndefined()
  })

  it('成员圈定全 miss（无成员 record / parentRunId·stepIndex 缺席）→ 不造键（原引用返回）', () => {
    const run = runRecord([{ id: 0, agent: 'dev-W1', status: 'running' }])
    const runs = [run]

    expect(projectSubagentModelDetailIntoRuns('main-1', runs, [], undefined)).toBe(runs)
    expect(
      projectSubagentModelDetailIntoRuns(
        'main-1',
        runs,
        [memberRecord({ subagentId: 'rec-x', parentRunId: undefined, stepIndex: 0 })],
        undefined,
      ),
    ).toBe(runs)
    expect(run.agentCalls[0]?.memberRecordId).toBeUndefined()
  })

  it('一键多 attempt：权威成员（running 优先）的 record id 透出——显示权威与步骤行一致', () => {
    const runs = [runRecord([{ id: 0, agent: 'dev-W1', status: 'running' }])]
    const subagents = [
      memberRecord({ subagentId: 'rec-attempt-1', parentRunId: 'wf-1', stepIndex: 0, status: 'idle', startedAt: 900 }),
      memberRecord({ subagentId: 'rec-attempt-2', parentRunId: 'wf-1', stepIndex: 0, status: 'running', startedAt: 1100 }),
    ]

    const [projected] = projectSubagentModelDetailIntoRuns('main-1', runs, subagents, undefined)

    expect(projected?.agentCalls[0]?.memberRecordId).toBe('rec-attempt-2')
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/workflow-run-events-reader.test.ts
// ======================================================================

const allowDirs = vi.hoisted(() => ({ piAgentDir: '', storeDir: '' }))


vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => allowDirs.piAgentDir }
})


vi.mock('@taiji/shared/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared/paths')>()
  return { ...actual, getSessionStoreDir: () => allowDirs.storeDir }
})


let root: string

let storeDir: string

const SID = '0aaaaaaa-bbbb-7ccc-dddd-000000000001'


/** 写一个最小 run journal（单 run-created 行）。 */
function writeJournal(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'run-created', seq: 1, ts: 1000, runId: 'run-1', workflowName: 'flow', argsSummary: '{}' })}\n`,
    'utf8',
  )
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('workflow-run-events-reader', () => {
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wf-events-reader-'))
  allowDirs.piAgentDir = join(root, 'agent')
  allowDirs.storeDir = join(root, 'ext-sessions')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('WorkflowRunEventsReader 路径白名单双域', () => {
  it('新树路径（存储树 workflow/runs/）放行：events 正常读出', () => {
    const recordPath = join(allowDirs.storeDir, SID, 'workflow', 'runs', 'run-1.record.jsonl')
    writeJournal(recordPath)
    const reader = new WorkflowRunEventsReader()
    const reply = reader.readRunEvents(SID, 'run-1', recordPath)
    if (!('events' in reply)) throw new Error(`expected events arm, got ${JSON.stringify(reply)}`)
    expect(reply.events).toHaveLength(1)
    expect(reply.events[0]?.type).toBe('run-created')
  })

  it('piAgentDir 路径放行：pi 宿主树域保持放行（存量旧布局 run journal 域）', () => {
    const recordPath = join(allowDirs.piAgentDir, 'sessions', '--demo--', 'workflow-state', 'run-1.record.jsonl')
    writeJournal(recordPath)
    const reader = new WorkflowRunEventsReader()
    const reply = reader.readRunEvents(SID, 'run-1', recordPath)
    if (!('events' in reply)) throw new Error(`expected events arm, got ${JSON.stringify(reply)}`)
    expect(reply.events).toHaveLength(1)
  })

  it('树外路径拒绝：事件流归并 record_not_found（白名单文案留痕），DAG 闭集 path_rejected', () => {
    const outside = mkdtempSync(join(tmpdir(), 'wf-events-reader-outside-'))
    try {
      const recordPath = join(outside, 'run-1.record.jsonl')
      writeJournal(recordPath)
      const reader = new WorkflowRunEventsReader()
      const reply = reader.readRunEvents(SID, 'run-1', recordPath)
      if ('events' in reply) throw new Error(`expected error arm, got ${JSON.stringify(reply)}`)
      expect(reply.code).toBe('record_not_found')
      expect(reply.message).toContain('rejected by allowlist')
      const dag = reader.readDag(SID, 'run-dag-reject', recordPath)
      if ('dag' in dag) throw new Error(`expected error arm, got ${JSON.stringify(dag)}`)
      expect(dag.code).toBe('path_rejected')
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('穿越形态（../ resolve 后逃出双域）拒绝', () => {
    // 四级 .. 恰好逃出存储树分区（join 消解后 = <root>/escape.record.jsonl，树外）
    const recordPath = join(
      allowDirs.storeDir, SID, 'workflow', 'runs', '..', '..', '..', '..', 'escape.record.jsonl',
    )
    const reader = new WorkflowRunEventsReader()
    // resolve 后逃出双域 → 白名单拒绝（语义等价 record_not_found + 留痕文案）
    const reply = reader.readRunEvents(SID, 'run-1', recordPath)
    if ('events' in reply) throw new Error(`expected error arm, got ${JSON.stringify(reply)}`)
    expect(reply.code).toBe('record_not_found')
    expect(reply.message).toContain('rejected by allowlist')
    const dag = reader.readDag(SID, 'run-dag-traversal', recordPath)
    if ('dag' in dag) throw new Error(`expected error arm, got ${JSON.stringify(dag)}`)
    expect(dag.code).toBe('path_rejected')
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/skill-dirs.test.ts
// ======================================================================

const makeConfigStore = (scopes: { projectPaths?: string[]; globalPaths?: string[] } = {}): SkillDirConfigSource => ({
  getPiAgentDir: () => '/data/agent',
  getSkillPathScopes: () => ({
    projectPaths: scopes.projectPaths ?? [],
    globalPaths: scopes.globalPaths ?? [],
  }),
})

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('skill-dirs', () => {
describe('resolveProjectSkillDirs（D7 扫描集对账）', () => {
  it('project 扫描集含强制目录 .taiji/skills 与 pi 原生项目目录 cwd/.pi/skills（对账新增项）', () => {
    const dirs = resolveProjectSkillDirs('/proj', makeConfigStore())
    expect(dirs).toContain(resolve('/proj', FORCED_PROJECT_SKILL_DIR))
    expect(dirs).toContain(resolve('/proj', '.pi/skills'))
  })

  it('顺序：强制目录（.taiji/skills、.pi/skills）在前，discovery 用户配置在后（对齐 pi defaults 先于 skillPaths 的装载序）', () => {
    const dirs = resolveProjectSkillDirs('/proj', makeConfigStore({ projectPaths: ['.agents/skills'] }))
    expect(dirs).toEqual([
      resolve('/proj', '.taiji/skills'),
      resolve('/proj', '.pi/skills'),
      resolve('/proj', '.agents/skills'),
    ])
  })

  it('discovery 相对路径按 projectRoot resolve，绝对路径原样保留（v2 显式 scope 语义不变）', () => {
    const dirs = resolveProjectSkillDirs('/proj', makeConfigStore({ projectPaths: ['rel/skills', '/abs/skills'] }))
    expect(dirs).toContain(resolve('/proj', 'rel/skills'))
    expect(dirs).toContain('/abs/skills')
  })
})
describe('resolveGlobalSkillDirs（对账不回归）', () => {
  it('global 扫描集不受影响：.pi/skills 只进 project 集，global 仍为 piAgentDir/skills + configDir/skills + discovery globalPaths（~ 展开）', () => {
    const dirs = resolveGlobalSkillDirs(makeConfigStore({ globalPaths: ['~/extra/skills'] }), '/cfg')
    expect(dirs).toEqual([join('/data/agent', 'skills'), join('/cfg', 'skills'), join(homedir(), '/extra/skills')])
    expect(dirs.every((d) => !d.includes('.pi'))).toBe(true)
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/skill-injector.test.ts
// ======================================================================

// ── fixture：tmp 下自建两个 skill 目录 ──

let tmpRoot: string

let skillADir: string

let skillBDir: string

let skillAPath: string

let skillBPath: string


const SKILL_A_MD = [
  '---',
  'name: skill-a',
  'description: test skill a',
  '---',
  '# Skill A',
  '',
  'Body line one.',
  '',
].join('\n')


const SKILL_B_MD = ['## Skill B', '', 'No frontmatter body.', ''].join('\n')


/** skill-a 剥 frontmatter 后的 body（trim 后，展开 block 的黄金正文）。 */
const SKILL_A_BODY = '# Skill A\n\nBody line one.'

const SKILL_B_BODY = '## Skill B\n\nNo frontmatter body.'


// ── fake client（D6 预检数据源：get_session_stats；getCommands 仅为「映射不经 pi RPC」的 not-called 断言留桩）──

interface ClientOverrides {  // oe-exempt:20261027:test:
  stats?: { contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } }
  statsError?: Error
}


function makeClient(overrides: ClientOverrides = {}): { client: IPiEngine; getCommands: ReturnType<typeof vi.fn>; getSessionStats: ReturnType<typeof vi.fn> } {
  const getCommands = vi.fn(async () => [] as never[])
  const getSessionStats = vi.fn(async () => {
    if (overrides.statsError) throw overrides.statsError
    return overrides.stats ?? {}
  })
  return { client: { getCommands, getSessionStats } as unknown as IPiEngine, getCommands, getSessionStats }
}


// ── SkillRegistry stub（A1 / D7 切源：映射权威 = taiji registry 扫描）──

/** registry 条目 fake：SkillInfo 必填字段 + sourcePath（映射的权威路径源）。 */
const registrySkill = (name: string, sourcePath?: string): SkillInfo => ({
  id: `reg-${name}`,
  name,
  description: `${name} from registry`,
  enabled: true,
  source: 'taiji',
  triggers: [],
  ...(sourcePath !== undefined ? { sourcePath } : {}),
})


interface RegistryOverrides {  // oe-exempt:20261027:test:
  global?: SkillInfo[]
  project?: SkillInfo[]
  globalError?: Error
  projectError?: Error
}


function makeRegistry(overrides: RegistryOverrides = {}): {
  registry: SkillMappingSource
  getGlobalSkills: ReturnType<typeof vi.fn<() => SkillInfo[]>>
  getProjectSkills: ReturnType<typeof vi.fn<(cwd: string) => Promise<SkillInfo[]>>>
} {
  const getGlobalSkills = vi.fn((): SkillInfo[] => {
    if (overrides.globalError) throw overrides.globalError
    return overrides.global ?? []
  })
  const getProjectSkills = vi.fn(async (_cwd: string): Promise<SkillInfo[]> => {
    if (overrides.projectError) throw overrides.projectError
    return overrides.project ?? []
  })
  return { registry: { getGlobalSkills, getProjectSkills }, getGlobalSkills, getProjectSkills }
}


/** global-only 映射源的快捷构造（多数用例不涉 project 扫描，cwd 缺省 = 不触发）。 */
const globalOnlySource = (skills: SkillInfo[]): SkillMappingSource => ({
  getGlobalSkills: () => skills,
  getProjectSkills: async () => [],
})


/** 与 pi 实装模板逐字同构的 block 期望构造（path/baseDir 为 fixture 真实路径；baseDir = dirname(sourcePath)）。 */
const expectedBlock = (name: string, path: string, baseDir: string, body: string): string =>
  `<skill name="${name}" location="${path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`


/** 期望正常形态包裹块（D11）：`<taiji-skill-data>` 首行开标签、每个 block 独立一行、末行闭标签。 */
const expectedDataBlock = (...expansions: string[]): string =>
  [`<${SKILL_DATA_BLOCK_TAG}>`, ...expansions, `</${SKILL_DATA_BLOCK_TAG}>`].join('\n')


/** 期望降级形态包裹块（D11）：块内标记清单 + 块内指引行（指引行在闭标签前一行）。 */
const expectedFallbackBlock = (...skills: Array<{ name: string; location?: string }>): string =>
  [`<${SKILL_DATA_BLOCK_TAG}>`, ...skills.map((s) => buildSkillMarker(s.name, s.location)), SKILL_FALLBACK_GUIDANCE, `</${SKILL_DATA_BLOCK_TAG}>`].join('\n')

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('skill-injector', () => {
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'skill-injector-test-'))
  skillADir = join(tmpRoot, 'skill-a')
  skillBDir = join(tmpRoot, 'skill-b')
  mkdirSync(skillADir)
  mkdirSync(skillBDir)
  skillAPath = join(skillADir, 'SKILL.md')
  skillBPath = join(skillBDir, 'SKILL.md')
  writeFileSync(skillAPath, SKILL_A_MD)
  writeFileSync(skillBPath, SKILL_B_MD)
})
afterEach(() => {
  // maxRetries：teardown 递归删除与在途异步写竞争（满载 ENOTEMPTY flake，教训 d9ad39cb8）
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('SkillInjector.inject', () => {
  it('① 单标记：正文标记逐字保留 + 末尾块内 block 与 pi 模板逐字一致（正文与块空行分隔）', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const text = `帮我 ${marker} 处理问题`
    const { client } = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const result = await injector.inject(client, text)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    expect(result.text).toBe(`${text}\n\n${expectedDataBlock(block)}`)
    expect(result.notices).toEqual([])
  })

  it('① 多标记：正文两个标记原样保留，块内两个 block 按标记出现序', async () => {
    const mA = buildSkillMarker('skill-a', skillAPath)
    const mB = buildSkillMarker('skill-b', skillBPath)
    const text = `开头 ${mA} 中间 ${mB} 结尾`
    const { client } = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath), registrySkill('skill-b', skillBPath)]))
    const result = await injector.inject(client, text)
    const blockA = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    const blockB = expectedBlock('skill-b', skillBPath, skillBDir, SKILL_B_BODY)
    expect(result.text).toBe(`${text}\n\n${expectedDataBlock(blockA, blockB)}`)
  })

  it('① 标记位于两端：正文零改动（无原位替换），块统一追加末尾', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const { client } = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    // 标记开头
    const head = await injector.inject(client, `${marker} 后续正文`)
    expect(head.text).toBe(`${marker} 后续正文\n\n${expectedDataBlock(block)}`)
    // 标记结尾
    const tail = await injector.inject(client, `前置正文 ${marker}`)
    expect(tail.text).toBe(`前置正文 ${marker}\n\n${expectedDataBlock(block)}`)
  })

  it('② 无标记文本零改动且不发起任何 RPC / 映射读取', async () => {
    const text = '普通文本 /skill:skill-a 手打命令不处理'
    const { client, getCommands, getSessionStats } = makeClient()
    const { getGlobalSkills } = makeRegistry()
    const inj = new SkillInjector({ getGlobalSkills, getProjectSkills: async () => [] })
    const result = await inj.inject(client, text)
    expect(result.text).toBe(text)
    expect(result.notices).toEqual([])
    expect(getGlobalSkills).not.toHaveBeenCalled()
    expect(getCommands).not.toHaveBeenCalled()
    expect(getSessionStats).not.toHaveBeenCalled()
  })

  it('③ 超阈值：正文标记保留 + 降级形态逐字（<taiji-skill-data> 块内清单 + 块内指引行，无全文）', async () => {
    // 大 CJK body：估算 ≈ 1000+ token > 0.8 × 100 = 80
    const bigBody = '很'.repeat(1000)
    writeFileSync(skillAPath, `---\nname: skill-a\ndescription: big\n---\n${bigBody}`)
    const marker = buildSkillMarker('skill-a', skillAPath)
    const text = `正文在前 ${marker}`
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const { client } = makeClient({ stats: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } } })
    const result = await injector.inject(client, text)
    // 正文逐字保留 + 空行 + 降级包裹块（标记清单与指引行都在块内，D11）
    expect(result.text).toBe(`${text}\n\n${expectedFallbackBlock({ name: 'skill-a', location: skillAPath })}`)
    expect(result.text).not.toContain(bigBody)
    expect(result.text).toContain(SKILL_FALLBACK_GUIDANCE)
    expect(result.text).toContain(skillAPath)
    expect(result.notices).toEqual([{ reason: 'budget_exceeded', skills: ['skill-a'] }])
  })

  it('③ 多 skill 超阈值：降级清单归拢全部 name/location（按出现顺序、块内清单形态）', async () => {
    const bigBody = '很'.repeat(600)
    writeFileSync(skillAPath, bigBody)
    writeFileSync(skillBPath, bigBody)
    const mA = buildSkillMarker('skill-a', skillAPath)
    const mB = buildSkillMarker('skill-b', skillBPath)
    const text = `${mA} ${mB}`
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath), registrySkill('skill-b', skillBPath)]))
    const { client } = makeClient({ stats: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } } })
    const result = await injector.inject(client, text)
    expect(result.text).toBe(`${text}\n\n${expectedFallbackBlock({ name: 'skill-a', location: skillAPath }, { name: 'skill-b', location: skillBPath })}`)
    expect(result.notices).toEqual([{ reason: 'budget_exceeded', skills: ['skill-a', 'skill-b'] }])
  })

  it('④ get_session_stats 抛错：fail-safe 降级（reason=context_window_unavailable），不放行全文', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const { client } = makeClient({ statsError: new Error('rpc timeout') })
    const result = await injector.inject(client, `正文 ${marker}`)
    expect(result.text).toBe(`正文 ${marker}\n\n${expectedFallbackBlock({ name: 'skill-a', location: skillAPath })}`)
    expect(result.text).not.toContain(SKILL_A_BODY)
    expect(result.notices).toEqual([{ reason: 'context_window_unavailable', skills: ['skill-a'] }])
  })

  it('④ contextUsage 缺失 / contextWindow 非法：同样 fail-safe 降级', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const noUsage = makeClient({ stats: {} })
    const resultNoUsage = await injector.inject(noUsage.client, `正文 ${marker}`)
    expect(resultNoUsage.text).toContain(`<${SKILL_DATA_BLOCK_TAG}>`)
    expect(resultNoUsage.text).not.toContain(SKILL_A_BODY)
    expect(resultNoUsage.notices[0]?.reason).toBe('context_window_unavailable')

    const zeroWindow = makeClient({ stats: { contextUsage: { tokens: 0, contextWindow: 0, percent: null } } })
    const resultZero = await injector.inject(zeroWindow.client, `正文 ${marker}`)
    expect(resultZero.notices[0]?.reason).toBe('context_window_unavailable')
  })

  it('⑤ 阈值边界：恰好等于阈值 / 略低不降级，略超降级（纯英文字符构造精确估算值）', async () => {
    // 纯 ASCII（非 CJK 占比 100% > 70%）按 B2 收紧公式 chars/3：估算 = 整条消息字符数 / 3。
    // 估算对象（D6/R4 同口径）= 正文 + '\n\n' + 正常形态末尾包裹块的整条消息。
    // window=400 → 阈值 320 token；构造 body 长度使整条消息恰 960 字符 = 320 token。
    const window = 400
    const marker = buildSkillMarker('skill-a', skillAPath)
    const text = `x ${marker}`
    const blockPrefix = `<skill name="skill-a" location="${skillAPath}">\nReferences are relative to ${skillADir}.\n\n`
    const fixedLen =
      text.length +
      '\n\n'.length + // 正文与块间空行
      `<${SKILL_DATA_BLOCK_TAG}>\n`.length + // 块开标签行
      blockPrefix.length +
      '\n</skill>'.length + // block 结束标记
      `\n</${SKILL_DATA_BLOCK_TAG}>`.length // 块闭标签行
    const nExact = 320 * CODE_DENSE_NON_CJK_CHARS_PER_TOKEN - fixedLen
    const bodyOf = (n: number) => 'a'.repeat(n)
    const writeBody = (n: number) => writeFileSync(skillAPath, `---\nname: skill-a\ndescription: t\n---\n${bodyOf(n)}`)

    // 略低（估算 317 < 320）：不降级，正常形态全文注入
    writeBody(nExact - 9)
    const lowInjector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const low = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: window, percent: 1 } } })
    const lowResult = await lowInjector.inject(low.client, text)
    expect(lowResult.text).toBe(`${text}\n\n${expectedDataBlock(expectedBlock('skill-a', skillAPath, skillADir, bodyOf(nExact - 9)))}`)
    expect(lowResult.text).not.toContain(SKILL_FALLBACK_GUIDANCE)
    expect(lowResult.notices).toEqual([])

    // 恰好等于阈值（320 > 320 为 false）：不降级
    writeBody(nExact)
    const exactInjector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const exact = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: window, percent: 1 } } })
    const exactResult = await exactInjector.inject(exact.client, text)
    expect(exactResult.text).toBe(`${text}\n\n${expectedDataBlock(expectedBlock('skill-a', skillAPath, skillADir, bodyOf(nExact)))}`)
    expect(exactResult.notices).toEqual([])

    // 略超（估算 323 > 320）：降级
    writeBody(nExact + 9)
    const overInjector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const over = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: window, percent: 1 } } })
    const overResult = await overInjector.inject(over.client, text)
    expect(overResult.text).toBe(`${text}\n\n${expectedFallbackBlock({ name: 'skill-a', location: skillAPath })}`)
    expect(overResult.notices[0]?.reason).toBe('budget_exceeded')
  })

  it('⑥ name 无映射：标记原样透传 + skill_missing 提示（无 valid 时跳过预检 RPC）', async () => {
    const marker = buildSkillMarker('ghost', '/nonexistent/SKILL.md')
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const { client, getSessionStats } = makeClient()
    const result = await injector.inject(client, `正文 ${marker} 结束`)
    expect(result.text).toBe(`正文 ${marker} 结束`)
    expect(result.text).not.toContain(`<${SKILL_DATA_BLOCK_TAG}>`)
    expect(result.notices).toEqual([{ reason: 'skill_missing', skills: ['ghost'] }])
    expect(getSessionStats).not.toHaveBeenCalled()
  })

  it('失效分路：无映射标记留正文 + notice，其余正常进块（部分失效不阻断整条注入）', async () => {
    const valid = buildSkillMarker('skill-a', skillAPath)
    const ghost = buildSkillMarker('ghost')
    const text = `前 ${valid} 中 ${ghost} 后`
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const { client, getSessionStats } = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, text)
    // 失效标记逐字保留在正文，不进块；有效标记照常展开进块
    expect(result.text).toBe(`${text}\n\n${expectedDataBlock(expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY))}`)
    expect(result.text).toContain(ghost)
    expect(result.text.split('<skill name=').length - 1).toBe(1)
    expect(result.notices).toEqual([{ reason: 'skill_missing', skills: ['ghost'] }])
    expect(getSessionStats).toHaveBeenCalledTimes(1)
  })

  it('⑦ SKILL.md 读取失败：标记原样透传 + skill_read_failed 提示', async () => {
    const missingPath = join(skillADir, 'missing', 'SKILL.md')
    const marker = buildSkillMarker('skill-a', missingPath)
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', missingPath)]))
    const { client } = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, `正文 ${marker}`)
    expect(result.text).toBe(`正文 ${marker}`)
    expect(result.notices).toEqual([{ reason: 'skill_read_failed', skills: ['skill-a'] }])
  })

  it('⑧ 标记残缺（hook 改写破坏）：残缺部分透传 + marker_malformed 提示，不发起任何 RPC / 映射读取', async () => {
    const text = `帮我 <taiji-skill name="skill-a" loc 这段`
    const { client } = makeClient()
    const { getGlobalSkills } = makeRegistry()
    const inj = new SkillInjector({ getGlobalSkills, getProjectSkills: async () => [] })
    const result = await inj.inject(client, text)
    expect(result.text).toBe(text)
    expect(result.notices).toEqual([{ reason: 'marker_malformed', skills: ['skill-a'] }])
    expect(getGlobalSkills).not.toHaveBeenCalled()
  })

  it('⑨ location 缺省标记：registry 映射补路径，正常展开进块', async () => {
    const marker = buildSkillMarker('skill-a')
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const { client } = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, marker)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    expect(result.text).toBe(`${marker}\n\n${expectedDataBlock(block)}`)
    expect(result.notices).toEqual([])
  })

  it('失效与降级共存：降级清单只含可展开者，失效标记保留正文 + 双 notice', async () => {
    writeFileSync(skillAPath, '很'.repeat(1000))
    const valid = buildSkillMarker('skill-a', skillAPath)
    const invalid = buildSkillMarker('ghost')
    const text = `前 ${valid} 中 ${invalid} 后`
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const { client } = makeClient({ stats: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } } })
    const result = await injector.inject(client, text)
    expect(result.text).toBe(`${text}\n\n${expectedFallbackBlock({ name: 'skill-a', location: skillAPath })}`)
    expect(result.text).toContain(invalid)
    expect(result.text).not.toContain('很'.repeat(1000))
    expect(result.notices).toEqual([
      { reason: 'budget_exceeded', skills: ['skill-a'] },
      { reason: 'skill_missing', skills: ['ghost'] },
    ])
  })

  it('无 frontmatter 结束 --- 行：镜像 pi 行为原文保留（不剥），块内展开正文为全文 trim', async () => {
    writeFileSync(skillAPath, '---\nname: skill-a\n没有结束标记行')
    const raw = '---\nname: skill-a\n没有结束标记行'
    const marker = buildSkillMarker('skill-a', skillAPath)
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const { client } = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, marker)
    expect(result.text).toBe(`${marker}\n\n${expectedDataBlock(expectedBlock('skill-a', skillAPath, skillADir, raw))}`)
  })
})
describe('SkillInjector.inject 同 name 去重（R4 D11）', () => {
  it('正文两个同名标记：块内一个 <skill>（按出现序首个归并），重复不发 notice', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const text = `${marker} 正文 ${marker}`
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const { client } = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, text)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    // 整条形态 = 标记正文逐字保留 + 空行 + 恰含一个 block 的包裹块
    expect(result.text).toBe(`${text}\n\n${expectedDataBlock(block)}`)
    // 显式去重断言：pi 形态 <skill name= 恰一次（<taiji-skill 前缀不误计）
    expect(result.text.split('<skill name=').length - 1).toBe(1)
    expect(result.text.split(SKILL_A_BODY).length - 1).toBe(1)
    expect(result.notices).toEqual([])
  })

  it('不同自带 location 的同名标记：块内 location 恒取映射结果（首个），不信任标记自带值', async () => {
    // 过时路径场景：标记自带 location 与映射不一致（skill 移动后），块内 location 必须
    // 是 registry 权威映射的当前路径（D4/D7 数据源澄清）
    const stalePath = '/stale/old-place/SKILL.md'
    const text = `${buildSkillMarker('skill-a', stalePath)} 正文 ${buildSkillMarker('skill-a', skillAPath)}`
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const { client } = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, text)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    expect(result.text).toBe(`${text}\n\n${expectedDataBlock(block)}`)
    // pi 形态 <skill> 块恰一个，且 location 为映射路径（正文标记自带的过时值仅存于正文）
    expect(result.text.split('<skill name=').length - 1).toBe(1)
    expect(result.text).toContain(`<skill name="skill-a" location="${skillAPath}">`)
  })
})
// ─── A2（adversarial-review-fixes MF-B）：@ 定向消息路径文本的注入等价性 ───
//
// 定向链路：subagentAction 的 text/task 经 injector.inject 展开后，还要过
// encodeDirectiveText（换行 → 字面 \n 保持 /subagents 命令单行，extension 侧
// decodeNewlineEscapes 解回）。此处锁定两件事：①注入产物（正文 + 末尾块含真实换行）
// 经 encode 后不含真实换行——命令单行契约不因注入而破；②定向文本的注入形态与主链
// （dispatcher sendPrompt）逐字一致——同一 injector 无第二实现。

describe('SkillInjector.inject × encodeDirectiveText（A2 定向链路）', () => {
  it('含 skill 标记的定向文本：末尾块形态与主链逐字一致，encode 后保持命令单行', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const text = `帮我 ${marker} 处理这个任务`
    const injector = new SkillInjector(globalOnlySource([registrySkill('skill-a', skillAPath)]))
    const { client } = makeClient({ stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, text)
    // 注入形态与主链逐字一致（同一 injector，无第二实现侧）
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    expect(result.text).toBe(`${text}\n\n${expectedDataBlock(block)}`)
    // encode 后单行：注入产物含真实换行（正文换行 + 块行结构），命令单行性由 encode 兜底
    const encoded = encodeDirectiveText(result.text)
    expect(encoded.includes('\n')).toBe(false)
    // 块关键内容存活（name/location 原样——encode 只转义反斜杠与换行）
    expect(encoded).toContain('<skill name="skill-a"')
    expect(encoded).toContain(`location="${skillAPath}"`)
  })

  it('无标记定向文本：no-op 原文返回且零 RPC / 零映射读取', async () => {
    const text = '纯文本定向消息，无任何 skill 标记'
    const { client, getSessionStats } = makeClient()
    const { getGlobalSkills } = makeRegistry()
    const inj = new SkillInjector({ getGlobalSkills, getProjectSkills: async () => [] })
    const result = await inj.inject(client, text)
    expect(result.text).toBe(text)
    expect(result.notices).toEqual([])
    expect(getGlobalSkills).not.toHaveBeenCalled()
    expect(getSessionStats).not.toHaveBeenCalled()
  })
})
// ─── skill-reload-nondestructive A1（D7 注入映射切源）───
//
// 映射权威从 pi get_commands（reload 才刷新的滞后快照）切到 taiji SkillRegistry 扫描
// （getGlobalSkills() ∪ getProjectSkills(sessionCwd)，取 SkillInfo.sourcePath）。四组断言：
// ①映射来自 registry（含同名 global 覆盖 project 的重名语义与现状一致）②registry 扫描
// 异常 → 同形态 mapping_unavailable ③不信任 marker 自带 location（路径唯一来自权威扫描）
// ④registry 条目缺 sourcePath / sessionCwd 缺省 / LateBound 绑定边界。

describe('SkillInjector.inject 注入映射切源（A1 / D7：SkillRegistry 为权威）', () => {
  const STATS_OK = { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } }
  const SESSION_CWD = '/fake/session/cwd'

  it('① global + project 独有 skill 均经 registry 映射到 sourcePath，不发起 get_commands（双源并读被 D7 否决）', async () => {
    const { client, getCommands } = makeClient({ stats: STATS_OK })
    const { registry, getProjectSkills } = makeRegistry({
      global: [registrySkill('skill-a', skillAPath)],
      project: [registrySkill('skill-b', skillBPath)],
    })
    const injector = new SkillInjector(registry)
    const mA = buildSkillMarker('skill-a')
    const mB = buildSkillMarker('skill-b')
    const text = `开头 ${mA} 中间 ${mB} 结尾`
    const result = await injector.inject(client, text, SESSION_CWD)
    const blockA = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    const blockB = expectedBlock('skill-b', skillBPath, skillBDir, SKILL_B_BODY)
    expect(result.text).toBe(`${text}\n\n${expectedDataBlock(blockA, blockB)}`)
    expect(result.notices).toEqual([])
    // 映射只来自 registry：不回退 get_commands（双源并读被 D7 否决）
    expect(getCommands).not.toHaveBeenCalled()
    // project 扫描基准 = 调用方传入的 session cwd（cwd 接线形态）
    expect(getProjectSkills).toHaveBeenCalledWith(SESSION_CWD)
  })

  it('① 同名 skill：global 覆盖 project（先入为主）——与现状一致（pi loadSkills user 先载且 first-set-wins / taiji loadSkills 全局目录靠前 / landing 合并序同款）', async () => {
    // 两个同名 skill 的 SKILL.md（body 可区分），分别登记在 global / project 扫描集
    const globalSharedDir = join(tmpRoot, 'shared-global')
    const projectSharedDir = join(tmpRoot, 'shared-project')
    mkdirSync(globalSharedDir)
    mkdirSync(projectSharedDir)
    const globalPath = join(globalSharedDir, 'SKILL.md')
    const projectPath = join(projectSharedDir, 'SKILL.md')
    writeFileSync(globalPath, '---\nname: shared\ndescription: g\n---\nGlobal body.')
    writeFileSync(projectPath, '---\nname: shared\ndescription: p\n---\nProject body.')
    const { client } = makeClient({ stats: STATS_OK })
    const { registry } = makeRegistry({
      global: [registrySkill('shared', globalPath)],
      project: [registrySkill('shared', projectPath)],
    })
    const injector = new SkillInjector(registry)
    const marker = buildSkillMarker('shared')
    const result = await injector.inject(client, `正文 ${marker}`, SESSION_CWD)
    // 块内 location 与正文都取 global 的 sourcePath（global 赢，project 同名条目不生效）
    expect(result.text).toContain(`<skill name="shared" location="${globalPath}">`)
    expect(result.text).toContain('Global body.')
    expect(result.text).not.toContain(projectPath)
    expect(result.text).not.toContain('Project body.')
  })

  it('② registry 扫描异常（getProjectSkills rejects）→ 全部透传 + mapping_unavailable（与 get_commands 失败同形态，不 panic 不静默）', async () => {
    const { client, getSessionStats } = makeClient({ stats: STATS_OK })
    const { registry } = makeRegistry({
      global: [registrySkill('skill-a', skillAPath)],
      projectError: new Error('scan blew up'),
    })
    const injector = new SkillInjector(registry)
    const mA = buildSkillMarker('skill-a', skillAPath)
    const mGhost = buildSkillMarker('ghost')
    const text = `${mA} 正文 ${mGhost}`
    const result = await injector.inject(client, text, SESSION_CWD)
    expect(result.text).toBe(text)
    expect(result.text).not.toContain(`<${SKILL_DATA_BLOCK_TAG}>`)
    expect(result.notices).toEqual([{ reason: 'mapping_unavailable', skills: ['skill-a', 'ghost'] }])
    expect(getSessionStats).not.toHaveBeenCalled()
  })

  it('② getGlobalSkills 同步抛错 → 同形态 mapping_unavailable（两入口失败形态一致）', async () => {
    const { client } = makeClient({ stats: STATS_OK })
    const { registry } = makeRegistry({ globalError: new Error('cache poisoned') })
    const injector = new SkillInjector(registry)
    const marker = buildSkillMarker('skill-a')
    const result = await injector.inject(client, `正文 ${marker}`, SESSION_CWD)
    expect(result.text).toBe(`正文 ${marker}`)
    expect(result.text).not.toContain(`<${SKILL_DATA_BLOCK_TAG}>`)
    expect(result.notices).toEqual([{ reason: 'mapping_unavailable', skills: ['skill-a'] }])
  })

  it('③ 不信任 marker 自带 location：registry 路径下块内 location 恒为 sourcePath（假 location 不被采信为 read 路径）', async () => {
    const stalePath = '/stale/old-place/SKILL.md'
    const { client } = makeClient({ stats: STATS_OK })
    const { registry } = makeRegistry({ global: [registrySkill('skill-a', skillAPath)] })
    const injector = new SkillInjector(registry)
    const text = `正文 ${buildSkillMarker('skill-a', stalePath)} 结束`
    const result = await injector.inject(client, text, SESSION_CWD)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    expect(result.text).toBe(`${text}\n\n${expectedDataBlock(block)}`)
    // 块内恰一个 <skill>，location = 权威扫描路径；过时值仅存于正文保留的标记原文里
    //（标记逐字保留是 R4 D11 形态），不进块（未被采信为 read 路径/块内 location）
    expect(result.text.split('<skill name=').length - 1).toBe(1)
    expect(result.text).toContain(`<skill name="skill-a" location="${skillAPath}">`)
    const [bodyPart, dataBlockPart] = result.text.split(`<${SKILL_DATA_BLOCK_TAG}>`)
    expect(bodyPart).toContain(`location="${stalePath}"`)
    expect(dataBlockPart).not.toContain(stalePath)
  })

  it('④ registry 条目缺 sourcePath：映射存在但无路径，按读取失败处理（skill_read_failed）', async () => {
    const { client } = makeClient({ stats: STATS_OK })
    const { registry } = makeRegistry({ global: [registrySkill('skill-a')] })
    const injector = new SkillInjector(registry)
    const marker = buildSkillMarker('skill-a', skillAPath)
    const result = await injector.inject(client, `正文 ${marker}`, SESSION_CWD)
    expect(result.text).toBe(`正文 ${marker}`)
    expect(result.text).not.toContain(`<${SKILL_DATA_BLOCK_TAG}>`)
    expect(result.notices).toEqual([{ reason: 'skill_read_failed', skills: ['skill-a'] }])
  })

  it('④ sessionCwd 缺省：只 global 映射、不发起 project 扫描（宁缺毋错——不以 process.cwd() 猜项目根）', async () => {
    const { client } = makeClient({ stats: STATS_OK })
    const { registry, getProjectSkills } = makeRegistry({
      global: [registrySkill('skill-a', skillAPath)],
      project: [registrySkill('skill-b', skillBPath)],
    })
    const injector = new SkillInjector(registry)
    const mA = buildSkillMarker('skill-a')
    const mB = buildSkillMarker('skill-b')
    const result = await injector.inject(client, `${mA} ${mB}`)
    // global 照常展开；project 独有 skill 不进映射（skill_missing 透传可见）
    const blockA = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    expect(result.text).toBe(`${mA} ${mB}\n\n${expectedDataBlock(blockA)}`)
    expect(result.notices).toEqual([{ reason: 'skill_missing', skills: ['skill-b'] }])
    expect(getProjectSkills).not.toHaveBeenCalled()
  })

  it('④ 未绑定的 LateBoundSkillSource：mapping_unavailable 可见降级（组合根漏 bind 不静默错数据）', async () => {
    const { client } = makeClient({ stats: STATS_OK })
    const injector = new SkillInjector(new LateBoundSkillSource())
    const marker = buildSkillMarker('skill-a', skillAPath)
    const result = await injector.inject(client, `正文 ${marker}`, SESSION_CWD)
    expect(result.text).toBe(`正文 ${marker}`)
    expect(result.text).not.toContain(`<${SKILL_DATA_BLOCK_TAG}>`)
    expect(result.notices).toEqual([{ reason: 'mapping_unavailable', skills: ['skill-a'] }])
  })

  it('④ LateBoundSkillSource bind 后透传真源（构造顺序环收尾形态）', async () => {
    const source = new LateBoundSkillSource()
    const injector = new SkillInjector(source)
    const marker = buildSkillMarker('skill-a')
    // bind 后同 injector 实例解析到真源（构造期占位、组合根后绑的生产接线形态）
    source.bind({ getGlobalSkills: () => [registrySkill('skill-a', skillAPath)], getProjectSkills: async () => [] })
    const { client } = makeClient({ stats: STATS_OK })
    const result = await injector.inject(client, `正文 ${marker}`, SESSION_CWD)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    expect(result.text).toBe(`正文 ${marker}\n\n${expectedDataBlock(block)}`)
    expect(result.notices).toEqual([])
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/plan-state-extractor.test.ts
// ======================================================================

/** plan-state entry fixture（照 session-records.test.ts entry helper 形态；data 无 v 字段——D4 否决版本轴）。 */
function planStateEntry(data: Record<string, unknown>, entryId: string): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'plan-state',
    id: entryId,
    parentId: null,
    timestamp: '2026-09-18T00:00:00Z',
    data,
  }
}


/** 旧四字段 schema（schema v1 现状，extension state.ts persistPlanState 现行产物）。 */
function legacyData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isActive: true,
    planFilePath: '/tmp/taiji-plan/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'tech-design',
    ...extra,
  }
}


/** 新七字段 schema（D1/D4 扩展：三 optional 平铺字段）。 */
function extendedData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...legacyData(),
    skills: ['tech-design', 'dev-flow'],
    docs: [
      { fileName: 'design.md', absPath: '/tmp/taiji-plan/auth/design.md', sourceSkill: 'tech-design', version: 2 },
      { fileName: 'impl-plan.md', absPath: '/tmp/taiji-plan/auth/impl-plan.md', sourceSkill: 'dev-flow', version: 1 },
    ],
    reviewState: 'awaiting',
    ...extra,
  }
}


let tmpDirs: string[] = []

function makeTmpJsonl(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-state-extractor-'))
  tmpDirs.push(dir)
  const filePath = join(dir, 'session.jsonl')
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8')
  return filePath
}


// ════════════════════════════════════════════════════════════════════
// 活跃路径裁剪（message-revoke U6d）：G2 二分的未来状态随树路径——plan 状态 =
// 当前状态，被撤子树的 plan-state entry 不进派生态
// ════════════════════════════════════════════════════════════════════

/** 树节点 fixture（带 id/parentId 链——真实 pi entry 形态；RPC getEntries 排除 header）。 */
function treeEntry(id: string, parentId: string | null, extra: Record<string, unknown>): Record<string, unknown> {
  return { id, parentId, timestamp: '2026-09-24T00:00:00Z', ...extra }
}


/** 链上 plan-state entry（plan-state-extractor 写侧经 pi appendCustomEntry 进树，parentId=当时叶子）。 */
function chainedPlanEntry(id: string, parentId: string, requirement: string): Record<string, unknown> {
  return treeEntry(id, parentId, {
    type: 'custom',
    customType: 'plan-state',
    data: { ...legacyData(), requirement },
  })
}


/** 真实撤回形态的分支文件 entries（header 由文件用例单独加）：q → p1（活跃）→ [m → p2] / [lbl 锚]。 */
function branchedTreeEntries(): Array<Record<string, unknown>> {
  return [
    treeEntry('q', null, { type: 'message', message: { role: 'user', content: '问题' } }),
    chainedPlanEntry('p1', 'q', '活跃路径上的 plan'),
    treeEntry('m', 'p1', { type: 'message', message: { role: 'user', content: '发错的消息' } }),
    chainedPlanEntry('p2', 'm', '被撤子树的 plan'),
    treeEntry('lbl', 'p1', { type: 'label', label: 'taiji:revoked', targetId: 'm' }),
  ]
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plan-state-extractor', () => {
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  tmpDirs = []
})
describe('scanPlanStateEntries：派生', () => {
  it('旧四字段 entry：四必填派生正确 + state 归一（无 reviewState → planning 按 isActive），optional 缺省不设键', () => {
    const view = scanPlanStateEntries([planStateEntry(legacyData(), 'e1')])
    expect(view).not.toBeNull()
    expect(view!.isActive).toBe(true)
    expect(view!.planFilePath).toBe('/tmp/taiji-plan/auth/plan.md')
    expect(view!.requirement).toBe('重构 auth 模块')
    expect(view!.templateName).toBe('tech-design')
    expect(view!.state).toBe('planning')
    expect('skills' in view!).toBe(false)
    expect('docs' in view!).toBe(false)
    expect('reviewState' in view!).toBe(false)
    expect('reviewStateSource' in view!).toBe(false)
  })

  it('新七字段 entry：skills/docs 透传 + reviewState 归一为 state（awaiting→reviewing），旧字段不透出', () => {
    const view = scanPlanStateEntries([planStateEntry(extendedData(), 'e1')])!
    expect(view.skills).toEqual(['tech-design', 'dev-flow'])
    expect(view.state).toBe('reviewing')
    expect('reviewState' in view).toBe(false)
    expect(view.docs).toEqual([
      { fileName: 'design.md', absPath: '/tmp/taiji-plan/auth/design.md', sourceSkill: 'tech-design', version: 2 },
      { fileName: 'impl-plan.md', absPath: '/tmp/taiji-plan/auth/impl-plan.md', sourceSkill: 'dev-flow', version: 1 },
    ])
  })

  it('多 entry 取最后一条（单例状态，后者覆盖）', () => {
    const view = scanPlanStateEntries([
      planStateEntry(legacyData(), 'e1'),
      planStateEntry(extendedData({ reviewState: 'revising' }), 'e2'),
      planStateEntry(extendedData({ reviewState: 'awaiting' }), 'e3'),
    ])!
    expect(view.state).toBe('reviewing')
  })

  it('reset entry：isActive=false + skills/reviewState 清空 + docs 保留（终态矩阵派生）', () => {
    const resetData = {
      isActive: false,
      planFilePath: '/tmp/taiji-plan/auth/plan.md',
      requirement: '',
      templateName: '',
      docs: [{ fileName: 'design.md', absPath: '/x/design.md', sourceSkill: 'tech-design', version: 3 }],
    }
    const view = scanPlanStateEntries([
      planStateEntry(extendedData(), 'e1'),
      planStateEntry(resetData, 'e2'),
    ])!
    expect(view.isActive).toBe(false)
    expect('skills' in view).toBe(false)
    expect('reviewState' in view).toBe(false)
    expect(view.state).toBe('idle')
    expect(view.docs).toEqual(resetData.docs)
  })

  it('空串归一 null：View 域「无」单一表达（entry 域历史空串形态不外泄）', () => {
    const view = scanPlanStateEntries([planStateEntry(legacyData({ planFilePath: '', requirement: '', templateName: '' }), 'e1')])!
    expect(view.planFilePath).toBeNull()
    expect(view.requirement).toBeNull()
    expect(view.templateName).toBeNull()
  })

  it('坏 entry 跳过继续向前：坏 data 不终止扫描，派生最后一条合法 entry', () => {
    const view = scanPlanStateEntries([
      planStateEntry(legacyData(), 'e1'),
      planStateEntry(extendedData({ reviewState: 'revising' }), 'e2'),
      { type: 'custom', customType: 'plan-state', id: 'e3', data: 'corrupted' },
      { type: 'message', id: 'e4' },
    ])!
    expect(view.state).toBe('revising')
  })

  it('字段级检查：非法 reviewState 归 isActive 推断 / 非 string[] skills / docs 坏元素过滤（防御式消费）', () => {
    const view = scanPlanStateEntries([planStateEntry(extendedData({
      reviewState: 'approved',
      skills: ['ok', 42],
      docs: [
        { fileName: 'good.md', absPath: '/x/good.md', sourceSkill: 's', version: 1 },
        { fileName: 42, absPath: '/x/bad.md', sourceSkill: 's', version: '1' },
      ],
    }), 'e1')])!
    expect('reviewState' in view).toBe(false)
    expect(view.state).toBe('planning')
    expect('skills' in view).toBe(false)
    expect(view.docs).toEqual([{ fileName: 'good.md', absPath: '/x/good.md', sourceSkill: 's', version: 1 }])
  })

  it("resumeHint 归一（D2 读方②）：reviewStateSource:'resubmit' → resumeHint:'resubmit'（旧字段不透出）；'explain' 存量值归无值", () => {
    const legacyExplain = scanPlanStateEntries([planStateEntry(extendedData({ reviewStateSource: 'explain' }), 'e1')])!
    expect(legacyExplain.state).toBe('reviewing')
    expect('resumeHint' in legacyExplain).toBe(false)
    expect('reviewStateSource' in legacyExplain).toBe(false)
    const resubmit = scanPlanStateEntries([planStateEntry(extendedData({ reviewStateSource: 'resubmit' }), 'e2')])!
    expect(resubmit.resumeHint).toBe('resubmit')
    expect('reviewStateSource' in resubmit).toBe(false)
  })

  it('resumeHint 值域检查：非法 reviewStateSource / 非法 resumeHint 不设键（防御式消费，同 reviewState 纪律）', () => {
    const bogusSource = scanPlanStateEntries([planStateEntry(extendedData({ reviewStateSource: 'bogus' }), 'e1')])!
    expect('resumeHint' in bogusSource).toBe(false)
    const bogusHint = scanPlanStateEntries([planStateEntry({ ...legacyData(), state: 'reviewing', resumeHint: 'bogus' }, 'e2')])!
    expect('resumeHint' in bogusHint).toBe(false)
  })

  it("resumeHint 直读：新 entry 合法 'resubmit' 原样落 View（reviewState 映射只服务旧 entry）", () => {
    const view = scanPlanStateEntries([planStateEntry({ ...legacyData(), state: 'reviewing', resumeHint: 'resubmit' }, 'e1')])!
    expect(view.state).toBe('reviewing')
    expect(view.resumeHint).toBe('resubmit')
  })

  it('新 entry state 直读：合法八值原样落 View', () => {
    const view = scanPlanStateEntries([planStateEntry({ ...legacyData(), state: 'dispatching' }, 'e1')])!
    expect(view.state).toBe('dispatching')
  })

  it('非法 state 值防御式降级：走 reviewState 映射 / isActive 推断（不信任外部写入）', () => {
    const mapped = scanPlanStateEntries([planStateEntry(extendedData({ state: 'bogus', reviewState: 'revising' }), 'e1')])!
    expect(mapped.state).toBe('revising')
    const inferred = scanPlanStateEntries([planStateEntry({ ...legacyData(), state: 42 }, 'e2')])!
    expect(inferred.state).toBe('planning')
  })

  it('selfReview 不映射（D9③）：entry 携带 selfReview 不透出进 View（派生视图止于审批请求帧）', () => {
    const view = scanPlanStateEntries([planStateEntry(extendedData({ selfReview: '自审结论（不映射进 planState 帧）' }), 'e1')])!
    expect('selfReview' in view).toBe(false)
    expect(view.state).toBe('reviewing')
  })

  it('旧 entry（升级前落盘）无 reviewStateSource/resumeHint 键：View 无 resumeHint（缺省不占位——renderer 据此渲染通用降级文案）', () => {
    // extendedData() 不含 reviewStateSource/resumeHint = 状态机显式化前的完整写侧
    const view = scanPlanStateEntries([planStateEntry(extendedData(), 'e1')])!
    expect(view.state).toBe('reviewing')
    expect('resumeHint' in view).toBe(false)
  })

  it('无 plan-state entry 返回 null（publish 侧跳过 / 冷路径归一缺省 View）', () => {
    expect(scanPlanStateEntries([{ type: 'message', id: 'e1' }, { type: 'custom', customType: 'other', data: {} }])).toBeNull()
  })
})
describe('extractPlanStateFromSessionFile：冷路径', () => {
  it('ENOENT（session 文件延迟写入）→ 未激活缺省 View', () => {
    expect(extractPlanStateFromSessionFile(join(tmpdir(), 'plan-state-extractor-nonexistent.jsonl')))
      .toEqual(INACTIVE_PLAN_STATE_VIEW)
  })

  it('真实临时 JSONL：与 scanPlanStateEntries 派生一致（冷热同一份派生代码）', () => {
    const filePath = makeTmpJsonl([
      { type: 'message', id: 'm1' },
      planStateEntry(legacyData(), 'e1'),
      planStateEntry(extendedData({ reviewState: 'revising' }), 'e2'),
    ])
    const view = extractPlanStateFromSessionFile(filePath)
    expect(view.isActive).toBe(true)
    expect(view.state).toBe('revising')
    expect('reviewState' in view).toBe(false)
    expect(view.skills).toEqual(['tech-design', 'dev-flow'])
  })

  it('空 JSONL（无任何 plan entry）→ 未激活缺省 View', () => {
    const filePath = makeTmpJsonl([{ type: 'message', id: 'm1' }])
    expect(extractPlanStateFromSessionFile(filePath)).toEqual(INACTIVE_PLAN_STATE_VIEW)
  })

  // [MF-12] G3 峰值治理冷路径降级契约：oversize 不全文扫描、不 throw、不部分提取——
  // 回归为 throw 会把 getPlanState RPC 打成 error envelope，回归为漏 warn 则静默吞失败。
  it('oversize（> READ_PRECHECK_MAX_BYTES）：warn 留痕 + 降级未激活缺省 View（不全文扫描）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-state-extractor-oversize-'))
    tmpDirs.push(dir)
    const filePath = join(dir, 'session.jsonl')
    // 稀疏文件（ftruncate 只拉长度不写数据块，APFS/ext4 秒级）——绕开 32MB 物理写入
    const fd = openSync(filePath, 'w')
    try {
      ftruncateSync(fd, READ_PRECHECK_MAX_BYTES + 1)
    } finally {
      closeSync(fd)
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(extractPlanStateFromSessionFile(filePath)).toEqual({
        isActive: false,
        planFilePath: null,
        requirement: null,
        templateName: null,
      })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]![0])).toContain('oversize')
    } finally {
      warnSpy.mockRestore()
    }
  })

  // 错误契约：非 ENOENT 读错误原样上抛（RPC 报错），不降级缺省 View（会把「读失败」
  // 与「从未进过 plan」混淆）。
  it('路径为目录：statSync 预检通过（目录项非 oversize），EISDIR 经 readFileSync 原样上抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-state-extractor-dir-'))
    tmpDirs.push(dir)
    expect(() => extractPlanStateFromSessionFile(dir)).toThrowError(/EISDIR/)
  })

  it('statSync 预检失败 fall-through：文件名超 NAME_MAX（ENAMETOOLONG）双抛，仍经 readFileSync 原样上抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-state-extractor-statfail-'))
    tmpDirs.push(dir)
    // > NAME_MAX 255：statSync 与 readFileSync 均拒——预检 catch（fileSize = -1）
    // fall-through 到读路径后错误契约不变（非 ENOENT 不吞）
    const longPath = join(dir, 'x'.repeat(300))
    expect(() => extractPlanStateFromSessionFile(longPath)).toThrowError(/ENAMETOOLONG/)
  })
})
describe('scanPlanStateEntries：leafId 活跃路径裁剪', () => {
  it('传 leafId（全量重建调用点）：被撤子树的 plan-state entry 不进派生，取活跃路径内最后一条', () => {
    const view = scanPlanStateEntries(branchedTreeEntries(), 'lbl')!
    expect(view.requirement).toBe('活跃路径上的 plan')
  })

  it('leafId 缺省 = 现行为回归：全文件逆序取首（物理最后一条命中——增量合并路径不裁剪的契约范围）', () => {
    const view = scanPlanStateEntries(branchedTreeEntries())!
    expect(view.requirement).toBe('被撤子树的 plan')
  })

  it('leafId 不在 id 集合 → 纯函数 fail-safe 原样返回（物理最后一条命中）+ warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const view = scanPlanStateEntries(branchedTreeEntries(), 'ghost-leaf')!
      expect(view.requirement).toBe('被撤子树的 plan')
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('活跃路径无任何 plan-state entry（撤回带走唯一 plan entry）→ null（publish 侧收敛由水位承接）', () => {
    const entries = [
      treeEntry('q', null, { type: 'message', message: { role: 'user', content: 'hi' } }),
      chainedPlanEntry('p2', 'q', '被撤子树的 plan'),
      treeEntry('lbl', 'q', { type: 'label', label: 'taiji:revoked', targetId: 'p2' }),
    ]
    expect(scanPlanStateEntries(entries, 'lbl')).toBeNull()
  })
})
describe('extractPlanStateFromSessionFile：文件读路径的活跃路径裁剪（冷启动）', () => {
  /** 真实 pi 文件首行 header（有 id 无 parentId——pi getEntries() 排除、文件直读包含）。 */
  function sessionHeaderLine(): Record<string, unknown> {
    return { type: 'session', version: 1, id: 'sid-branched', timestamp: '2026-09-24T00:00:00Z', cwd: '/tmp' }
  }

  it('有分支真实文件形态（header + 撤回分支 + label 锚落文件尾）→ 派生不含被撤子树 entry', () => {
    const filePath = makeTmpJsonl([sessionHeaderLine(), ...branchedTreeEntries()])
    const view = extractPlanStateFromSessionFile(filePath)
    expect(view.isActive).toBe(true)
    expect(view.requirement).toBe('活跃路径上的 plan')
  })

  it('撤回带走唯一 plan entry → 「未激活」缺省 View（活跃路径空收敛的冷路径形态）', () => {
    const filePath = makeTmpJsonl([
      sessionHeaderLine(),
      treeEntry('q', null, { type: 'message', message: { role: 'user', content: 'hi' } }),
      chainedPlanEntry('p2', 'q', '被撤子树的 plan'),
      treeEntry('lbl', 'q', { type: 'label', label: 'taiji:revoked', targetId: 'p2' }),
    ])
    expect(extractPlanStateFromSessionFile(filePath)).toEqual(INACTIVE_PLAN_STATE_VIEW)
  })

  it('无分支真实文件形态（header + 链式 entries）→ 现行为：最后一条 plan entry 生效（回归）', () => {
    const filePath = makeTmpJsonl([
      sessionHeaderLine(),
      treeEntry('q', null, { type: 'message', message: { role: 'user', content: 'hi' } }),
      chainedPlanEntry('p1', 'q', '第一条 plan'),
      chainedPlanEntry('p3', 'p1', '第二条 plan'),
    ])
    const view = extractPlanStateFromSessionFile(filePath)
    expect(view.requirement).toBe('第二条 plan')
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/gen-stats-store.test.ts
// ======================================================================

// ── fixture：mkdtemp + TAIJI_AGENT_DATA_DIR 注入（测试文件独立 worker，env 改动文件级隔离）──

let dataDir: string

let prevDataDirEnv: string | undefined


/** 从 store 公开 API 取 speed 文件路径（保证测的是真实落盘位置） */
function speedPath(provider = 'prov', model = 'mdl'): string {
  return speedFilePath(provider, model)
}


/** 损坏注入用：裸写原始内容（模拟「文件已存在后被外部写坏」——先补父目录） */
function writeRawFile(p: string, content: string): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('gen-stats-store', () => {
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'taiji-gen-stats-'))
  prevDataDirEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dataDir
})
afterEach(() => {
  if (prevDataDirEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = prevDataDirEnv
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('aggregateSpeed（D6 加权平均 Σtokens÷Σduration×1000）', () => {
  it('已知样本：加权平均 = 100/2s 与 300/3s → 400/5000ms×1000 = 80 t/s', () => {
    const records: SpeedRecord[] = [
      [100, 2000],
      [300, 3000],
    ]
    expect(aggregateSpeed(records)).toBe(80)
  })

  it('单样本即 current 口径（会话槽/模型末条均按单条加权平均 = 样本本身）', () => {
    expect(aggregateSpeed([[50, 1000]] as SpeedRecord[])).toBe(50)
  })

  it('加权而非算术平均：100 t/s×1s 与 1 t/s×10s → 10 t/s（算术平均会是 51）', () => {
    const records: SpeedRecord[] = [
      [100, 1000],
      [10, 10000],
    ]
    expect(aggregateSpeed(records)).toBe(10)
  })

  it('四舍五入取整（蓝本 Math.round 口径）', () => {
    expect(aggregateSpeed([[1, 3]] as SpeedRecord[])).toBe(333)
  })

  it('空数组 → null（无有效样本，D4 纪律禁止 0 充数）', () => {
    expect(aggregateSpeed([])).toBeNull()
  })

  it('ΣdurationMs=0 → null', () => {
    expect(aggregateSpeed([[10, 0], [20, 0]] as SpeedRecord[])).toBeNull()
  })
})
describe('aggregateCacheRatio（D6 加权 Σread÷ΣpromptTotal×100）', () => {
  it('已知样本：80%×100 与 90%×100 → 170/200 = 85%', () => {
    const records: CacheRatioRecord[] = [
      [80, 100],
      [90, 100],
    ]
    expect(aggregateCacheRatio(records)).toBe(85)
  })

  it('加权而非算术平均：大 promptTotal 样本权重更大（100/100 与 0/300 → 25%，算术是 50）', () => {
    const records: CacheRatioRecord[] = [
      [100, 100],
      [0, 300],
    ]
    expect(aggregateCacheRatio(records)).toBe(25)
  })

  it('空数组 → null', () => {
    expect(aggregateCacheRatio([])).toBeNull()
  })

  it('ΣpromptTotal=0 → null（非 cache 模型常态，显「—」非 0%）', () => {
    expect(aggregateCacheRatio([[0, 0]] as CacheRatioRecord[])).toBeNull()
  })

  it('全 miss = 真实 0 值（非 null——D4：0 只作真实测量值）', () => {
    expect(aggregateCacheRatio([[0, 50]] as CacheRatioRecord[])).toBe(0)
  })

  it('四舍五入取整', () => {
    expect(aggregateCacheRatio([[1, 3]] as CacheRatioRecord[])).toBe(33)
  })
})
describe('aggregateTtft（composer-genstats-ttft §3.3：p50 中位数，重尾稳健）', () => {
  it('奇数样本取中位元素（乱序输入不敏感）', () => {
    expect(aggregateTtft([[300], [100], [200]])).toBe(200)
  })

  it('偶数样本取双中位均值：[100,300,200,400] → (200+300)/2 = 250', () => {
    expect(aggregateTtft([[100], [300], [200], [400]])).toBe(250)
  })

  it('偶数双中位均值四舍五入：[100,201] → 150.5 → 151', () => {
    expect(aggregateTtft([[100], [201]])).toBe(151)
  })

  it('空记录 → null（无值纪律 D4，禁 0 充数）', () => {
    expect(aggregateTtft([])).toBeNull()
  })

  it('单样本 → 原值（current 槽口径 = aggregateTtft([单条])）', () => {
    expect(aggregateTtft([[820]])).toBe(820)
  })

  it('0 是合法真实测量值（非 null 充数）：[0,100] p50 = 50', () => {
    expect(aggregateTtft([[0], [100]])).toBe(50)
  })

  it('重尾稳健：[100,110,120,9000] → p50=115（均值 2332 被偶发慢请求拉飞，否决方案 D 不用均值）', () => {
    expect(aggregateTtft([[100], [110], [120], [9000]])).toBe(115)
  })
})
describe('isBogusSpeedSample（D7 bogus guard，阈值照抄蓝本 50/100）', () => {
  it('阈值常量锁值（无证据不放宽——蓝本 index.ts:61-62）', () => {
    expect(BOGUS_OUTPUT_THRESHOLD).toBe(50)
    expect(BOGUS_DURATION_THRESHOLD_MS).toBe(100)
  })

  it('output>50 且 duration<100 → bogus（缓存回放型异常）', () => {
    expect(isBogusSpeedSample(51, 99)).toBe(true)
    expect(isBogusSpeedSample(1000, 50)).toBe(true)
  })

  it('边界严格不等：output=50 非 bogus（> 严格）', () => {
    expect(isBogusSpeedSample(50, 99)).toBe(false)
  })

  it('边界严格不等：duration=100ms 非 bogus（< 严格）', () => {
    expect(isBogusSpeedSample(51, 100)).toBe(false)
    expect(isBogusSpeedSample(50, 100)).toBe(false)
  })

  it('小样本短耗时合法（真实快速响应），大样本长耗时合法', () => {
    expect(isBogusSpeedSample(30, 50)).toBe(false)
    expect(isBogusSpeedSample(200, 1000)).toBe(false)
  })
})
describe('归因降噪纯函数（2026-09-19 D-A，缓存命中率归因分类 SSOT）', () => {
  it('isDisplayedZeroCacheRatio：与 UI 显示口径同源（四舍五入后为 0 才算「展示 0%」）', () => {
    expect(isDisplayedZeroCacheRatio(0, 1000)).toBe(true)
    expect(isDisplayedZeroCacheRatio(4, 1000)).toBe(true) // 0.4% → round 0（极小命中同样刺眼，一并归因）
    expect(isDisplayedZeroCacheRatio(5, 1000)).toBe(false) // 0.5% → round 1（UI 显示 1%）
    expect(isDisplayedZeroCacheRatio(999, 1000)).toBe(false)
  })

  it('isDisplayedZeroCacheRatio：promptTotal ≤ 0 → false（不是测量值，无归因对象）', () => {
    expect(isDisplayedZeroCacheRatio(0, 0)).toBe(false)
    expect(isDisplayedZeroCacheRatio(0, -5)).toBe(false)
  })

  it('hasReportedCacheFields：两字段全缺省 → 无计量；任一有值（含显式 0）→ 有计量', () => {
    expect(hasReportedCacheFields(null, null)).toBe(false)
    expect(hasReportedCacheFields(0, null)).toBe(true)
    expect(hasReportedCacheFields(null, 0)).toBe(true)
    expect(hasReportedCacheFields(120, 0)).toBe(true)
  })

  it('classifyCacheMiss：无前序请求 → cold-start（新会话首条，无 idleMs）', () => {
    expect(classifyCacheMiss({ hasPreviousRequest: false, idleMs: null, contextRewritten: true })).toEqual({
      reason: 'cold-start',
    })
  })

  it('classifyCacheMiss：compaction 标记优先于空闲超时（前缀重写是结构性成因）', () => {
    expect(
      classifyCacheMiss({ hasPreviousRequest: true, idleMs: CACHE_TTL_MS * 10, contextRewritten: true }),
    ).toEqual({ reason: 'context-rewrite' })
  })

  it('classifyCacheMiss：空闲严格大于 TTL → idle-expiry（携带实际空闲；恰好 TTL 不归因）', () => {
    expect(classifyCacheMiss({ hasPreviousRequest: true, idleMs: CACHE_TTL_MS + 1, contextRewritten: false })).toEqual(
      { reason: 'idle-expiry', idleMs: CACHE_TTL_MS + 1 },
    )
    expect(classifyCacheMiss({ hasPreviousRequest: true, idleMs: CACHE_TTL_MS, contextRewritten: false })).toBeUndefined()
    expect(classifyCacheMiss({ hasPreviousRequest: true, idleMs: CACHE_TTL_MS - 1, contextRewritten: false })).toBeUndefined()
  })

  it('classifyCacheMiss：无标记不超 TTL → undefined（未知成因的真实 miss 保留裸 0%，不降噪）', () => {
    expect(classifyCacheMiss({ hasPreviousRequest: true, idleMs: 7_000, contextRewritten: false })).toBeUndefined()
    expect(classifyCacheMiss({ hasPreviousRequest: true, idleMs: null, contextRewritten: false })).toBeUndefined()
  })

  it('CACHE_TTL_MS 锁值：5 分钟（对齐 pi cache-stats 参考值）', () => {
    expect(CACHE_TTL_MS).toBe(5 * 60 * 1000)
  })
})
describe('localDayKey（本地时区日 key，D3 有意偏离蓝本 UTC）', () => {
  it('按本地日期分量格式化', () => {
    expect(localDayKey(new Date(2026, 1, 9))).toBe('2026-02-09')
  })

  it('月/日补零', () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('当地 0:30 仍属当日（UTC 口径实现会回退一天——本断言在 UTC+ 时区机器上使 toISOString 实现失败）', () => {
    expect(localDayKey(new Date(2026, 1, 9, 0, 30))).toBe('2026-02-09')
  })

  it('缺省参数取当前时刻', () => {
    const now = new Date()
    expect(localDayKey()).toBe(localDayKey(now))
  })
})
describe('safeModelFileName（safeBase 截断 64 + hash8，单射）', () => {
  it('同输入确定性输出（跨重启落盘一致的前提）', () => {
    expect(safeModelFileName('zai', 'glm-5.3')).toBe(safeModelFileName('zai', 'glm-5.3'))
  })

  it('`a b` 与 `a_b`：safeBase 同为替换结果，hash8 不同 → 文件名不碰撞', () => {
    const withSpace = safeModelFileName('p', 'a b')
    const withUnderscore = safeModelFileName('p', 'a_b')
    expect(withSpace).not.toBe(withUnderscore)
    // 替换生效：两者 safeBase 段相同（碰撞风险确实存在，由 hash 消解）
    expect(withSpace.replace(/-[0-9a-f]{8}$/, '')).toBe(withUnderscore.replace(/-[0-9a-f]{8}$/, ''))
  })

  it('大小写变体（macOS 大小写不敏感 FS）：文件名不同（hash hex 小写，hash 段亦无大小写碰撞）', () => {
    const mixed = safeModelFileName('p', 'Glm')
    const upper = safeModelFileName('p', 'GLM')
    expect(mixed).not.toBe(upper)
    expect(upper).toMatch(/-[0-9a-f]{8}$/)
  })

  it('超长 model id 截断 64 后 hash 不碰撞；文件名长度有界（64+1+8）', () => {
    const longA = safeModelFileName('p', 'x'.repeat(200) + 'AAA')
    const longB = safeModelFileName('p', 'x'.repeat(200) + 'BBB')
    expect(longA).not.toBe(longB)
    for (const name of [longA, longB]) {
      const base = name.replace(/-[0-9a-f]{8}$/, '')
      expect(base.length).toBeLessThanOrEqual(64)
      expect(name.length).toBeLessThanOrEqual(64 + 1 + 8)
    }
  })

  it('文件名不含路径/空白/冒号字符（provider 含 `openai/gpt` 类复合 id 也安全）', () => {
    const name = safeModelFileName('openai/gpt', 'o3: high speed mode')
    expect(name).not.toMatch(/[/\\:\s]/)
  })

  it('不同 provider 同 model 不碰撞（raw key 含 provider 段）', () => {
    expect(safeModelFileName('provA', 'mdl')).not.toBe(safeModelFileName('provB', 'mdl'))
  })
})
describe('pruneExpiredDays（GC 30d，本地时区）', () => {
  it('过期日键删除、近期与当日保留', () => {
    const recent = localDayKey(new Date(Date.now() - 29 * 86_400_000))
    const today = localDayKey()
    const records: GenStatsDayRecords = { '2000-01-01': [[1, 1]], [recent]: [[2, 2]], [today]: [[3, 3]] }
    const pruned = pruneExpiredDays(records)
    expect(Object.keys(pruned).sort()).toEqual([recent, today].sort())
  })

  it('恰好 cutoff 当天键保留（>= 边界）', () => {
    const now = new Date()
    const cutoffKey = localDayKey(new Date(now.getTime() - SPEED_RETENTION_DAYS * 86_400_000))
    const pruned = pruneExpiredDays({ [cutoffKey]: [[1, 1]] }, now)
    expect(pruned[cutoffKey]).toEqual([[1, 1]])
  })

  it('纯函数：不改入参', () => {
    const records: GenStatsDayRecords = { '2000-01-01': [[1, 1]] }
    pruneExpiredDays(records)
    expect(records['2000-01-01']).toEqual([[1, 1]])
  })
})
describe('readDayRecords / writeDayRecords（同步原子写 + 损坏自愈，D3/D8）', () => {
  it('写→读 round-trip 保真', () => {
    const p = speedPath()
    const records: GenStatsDayRecords = { [localDayKey()]: [[100, 2000], [300, 3000]] }
    writeDayRecords(p, records)
    expect(readDayRecords(p)).toEqual(records)
  })

  it('write 递归创建父目录；写后无 .tmp 残留（tmp+rename 原子写）', () => {
    const p = speedPath('deep', 'nested')
    expect(existsSync(p)).toBe(false)
    writeDayRecords(p, { [localDayKey()]: [[1, 1000]] })
    expect(existsSync(p)).toBe(true)
    expect(readdirSync(getSpeedDir()).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('write 顺带清扫同目录 .tmp 孤儿（D6 #3：崩溃落在 write→rename 窗口的残留，含他模型文件名）', () => {
    // 预置两个孤儿：本文件同名的 tmp + 另一模型文件的 tmp（换模型后永不重写的那类）
    const p = speedPath('prov', 'mdl')
    mkdirSync(getSpeedDir(), { recursive: true })
    writeFileSync(`${p}.tmp`, 'orphan-half-written', 'utf8')
    writeFileSync(join(getSpeedDir(), `${safeModelFileName('prov', 'gone')}.json.tmp`), 'orphan-other-model', 'utf8')

    writeDayRecords(p, { [localDayKey()]: [[1, 1000]] })

    expect(readdirSync(getSpeedDir()).filter((f) => f.endsWith('.tmp'))).toEqual([])
    // 正常数据文件不受清扫误伤
    expect(existsSync(p)).toBe(true)
    expect(readDayRecords(p)).toEqual({ [localDayKey()]: [[1, 1000]] })
  })

  it('write 时顺带 GC：过期日键不落盘（D3「写入时顺带清理」）', () => {
    const p = speedPath()
    const records: GenStatsDayRecords = { '2000-01-01': [[1, 1]], [localDayKey()]: [[2, 2]] }
    writeDayRecords(p, records)
    const onDisk = readDayRecords(p)
    expect(onDisk['2000-01-01']).toBeUndefined()
    expect(Object.keys(onDisk)).toEqual([localDayKey()])
  })

  it('cache-ratio 路径独立落盘、与 speed 文件互不干扰', () => {
    const p = cacheRatioFilePath('prov', 'mdl')
    writeDayRecords(p, { [localDayKey()]: [[80, 100]] })
    expect(readDayRecords(p)).toEqual({ [localDayKey()]: [[80, 100]] })
    expect(existsSync(speedPath('prov', 'mdl'))).toBe(false)
  })

  it('读不存在文件 → 空（不抛、不创建文件）', () => {
    const p = speedPath('ghost', 'model')
    expect(readDayRecords(p)).toEqual({})
    expect(existsSync(p)).toBe(false)
  })

  it('文件损坏（JSON 截断）→ 空 + 不抛（§3.5 损坏自愈）', () => {
    const p = speedPath()
    writeRawFile(p, '{corrupted')
    expect(readDayRecords(p)).toEqual({})
  })

  it('顶层形状非法（数组 / 字符串）→ 空 + 不抛', () => {
    const p = speedPath()
    writeRawFile(p, '[1,2,3]')
    expect(readDayRecords(p)).toEqual({})
    writeRawFile(p, '"junk"')
    expect(readDayRecords(p)).toEqual({})
  })

  it('部分畸形自愈：畸形条目/键被丢弃，合法数据照常返回（不抛）', () => {
    const p = speedPath()
    const today = localDayKey()
    writeRawFile(p, JSON.stringify({ [today]: [[10, 1000], 'junk', [5]], 'not-a-day': [[1, 1]], [today + '-extra']: 'nope' }))
    expect(readDayRecords(p)).toEqual({ [today]: [[10, 1000]] })
  })

  it('损坏文件在下一次 write 后重建为合法 JSON（自愈闭环，§4 场景 5b 存储层语义）', () => {
    const p = speedPath()
    writeRawFile(p, '{corrupted')
    writeDayRecords(p, { [localDayKey()]: [[42, 1000]] })
    expect(readDayRecords(p)).toEqual({ [localDayKey()]: [[42, 1000]] })
    expect(() => JSON.parse(readFileSync(p, 'utf-8'))).not.toThrow()
  })
})
describe('S8 存储校验双向（元组长度参数化，composer-genstats-ttft §3.3）', () => {
  it('ttft 单元素组经 readDayRecords(len=1) 全量保留（不被当畸形丢弃——不参数化则聚合恒空）', () => {
    const p = ttftFilePath('prov', 'mdl')
    writeDayRecords<TtftRecord>(p, { [localDayKey()]: [[820], [1000]] })
    expect(readDayRecords<TtftRecord>(p, TTFT_RECORD_TUPLE_LENGTH)).toEqual({ [localDayKey()]: [[820], [1000]] })
  })

  it('ttft 文件按 len=1 读：二元组条目反成畸形被丢（长度不匹配即畸形，双向一致）', () => {
    const p = ttftFilePath('prov', 'mdl')
    writeRawFile(p, JSON.stringify({ [localDayKey()]: [[820], [1, 2], 'junk'] }))
    expect(readDayRecords<TtftRecord>(p, TTFT_RECORD_TUPLE_LENGTH)).toEqual({ [localDayKey()]: [[820]] })
  })

  it('speed 默认校验强度不变：单元素畸形条目仍被丢、二元组合法保留（既有文件回归钉）', () => {
    const p = speedPath()
    writeRawFile(p, JSON.stringify({ [localDayKey()]: [[10, 1000], [5], 'junk'] }))
    expect(readDayRecords(p)).toEqual({ [localDayKey()]: [[10, 1000]] })
  })

  it('长度常量锁值（PAIR=2 / TTFT=1；显式 2 与缺省等价）', () => {
    expect(PAIR_RECORD_TUPLE_LENGTH).toBe(2)
    expect(TTFT_RECORD_TUPLE_LENGTH).toBe(1)
    const p = speedPath()
    writeRawFile(p, JSON.stringify({ [localDayKey()]: [[10, 1000], [5]] }))
    expect(readDayRecords(p, PAIR_RECORD_TUPLE_LENGTH)).toEqual({ [localDayKey()]: [[10, 1000]] })
  })

  it('ttft 路径独立落盘：与 speed / cache-ratio 三文件互不干扰 + 写后无 .tmp 残留', () => {
    const p = ttftFilePath('prov', 'mdl')
    writeDayRecords<TtftRecord>(p, { [localDayKey()]: [[300]] })
    expect(readDayRecords<TtftRecord>(p, TTFT_RECORD_TUPLE_LENGTH)).toEqual({ [localDayKey()]: [[300]] })
    expect(existsSync(speedPath('prov', 'mdl'))).toBe(false)
    expect(existsSync(cacheRatioFilePath('prov', 'mdl'))).toBe(false)
    expect(readdirSync(getTtftDir()).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('ttft 文件损坏自愈同款：JSON 截断 → 空 + 不抛；写后重建', () => {
    const p = ttftFilePath('prov', 'mdl')
    writeRawFile(p, '{corrupted')
    expect(readDayRecords<TtftRecord>(p, TTFT_RECORD_TUPLE_LENGTH)).toEqual({})
    writeDayRecords<TtftRecord>(p, { [localDayKey()]: [[42]] })
    expect(readDayRecords<TtftRecord>(p, TTFT_RECORD_TUPLE_LENGTH)).toEqual({ [localDayKey()]: [[42]] })
  })
})
describe('路径派生（getDataDir 动态推导，零硬编码）', () => {
  it('gen-stats 根目录 = <TAIJI_AGENT_DATA_DIR>/gen-stats', () => {
    expect(getGenStatsDir()).toBe(join(dataDir, 'gen-stats'))
  })

  it('speed / cache-ratio / ttft 子目录', () => {
    expect(getSpeedDir()).toBe(join(dataDir, 'gen-stats', 'speed'))
    expect(getCacheRatioDir()).toBe(join(dataDir, 'gen-stats', 'cache-ratio'))
    expect(getTtftDir()).toBe(join(dataDir, 'gen-stats', 'ttft'))
  })

  it('文件路径 = <子目录>/<safeModelFileName>.json（含 ttft 同款布局）', () => {
    expect(speedFilePath('a', 'b')).toBe(join(getSpeedDir(), `${safeModelFileName('a', 'b')}.json`))
    expect(cacheRatioFilePath('a', 'b')).toBe(join(getCacheRatioDir(), `${safeModelFileName('a', 'b')}.json`))
    expect(ttftFilePath('a', 'b')).toBe(join(getTtftDir(), `${safeModelFileName('a', 'b')}.json`))
  })

  it('env 参数注入优先于 process.env（路径随注入隔离）', () => {
    const injected = mkdtempSync(join(tmpdir(), 'taiji-gen-stats-env-'))
    try {
      expect(getGenStatsDir({ TAIJI_AGENT_DATA_DIR: injected })).toBe(join(injected, 'gen-stats'))
      expect(getGenStatsDir()).toBe(join(dataDir, 'gen-stats'))
    } finally {
      rmSync(injected, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
});
