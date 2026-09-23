/**
 * SkillInjector 单测（composer-multi-skill-injection P1，R4 D11 末尾块形态；
 * skill-reload-nondestructive A1 / D7 切源后映射权威 = taiji SkillRegistry）。
 *
 * 覆盖：无标记零改动 / 正常形态逐字（正文标记保留 + 末尾 `<taiji-skill-data>` 包裹块，
 * 块内 block 与 pi 模板逐字一致）/ 降级形态逐字（块内标记清单 + 块内指引行，无全文）/
 * 同 name 去重（出现序首个归并，location 恒取映射结果）/ contextWindow fail-safe /
 * 阈值边界 / 三类失效透传+提示（标记留正文、不进块）/ mapping_unavailable 无块 /
 * location 缺省补路径；D7 切源面（registry 映射来源 / 异常降级 / 不信任 marker 自带
 * location / cwd 接线与缺省边界 / LateBound 绑定语义）见文末 describe。
 * legacy get_commands 路径已随 D7 接线收口删除；其专属断言面（`skill:` 前缀剥离 /
 * sourceInfo.path 缺失 / get_commands 整体失败 / sourceInfo.baseDir 不可消费）由
 * registry 等价面承接：裸名映射（①类）/ sourcePath 缺失（④）/ registry 扫描异常（②）/
 * References 行恒 dirname(sourcePath)（expectedBlock 逐字断言）。
 * SKILL.md fixture 用 mkdtempSync 自建自删（测试禁区红线：不触碰真实数据目录）；
 * get_session_stats 以 fake client 注入，SkillRegistry 以内存 stub 注入（真实链路由
 * 验收阶段 Gate B 覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSkillMarker,
  CODE_DENSE_NON_CJK_CHARS_PER_TOKEN,
  SKILL_DATA_BLOCK_TAG,
  SKILL_FALLBACK_GUIDANCE,
  type SkillInfo,
} from '@taiji/shared'
import { LateBoundSkillSource, SkillInjector, type SkillMappingSource } from '../skill-injector.js'
import { encodeDirectiveText } from '../session-records.js'
import type { IPiEngine } from '../../ports/pi-engine.js'

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

// ── fake client（D6 预检数据源：get_session_stats；getCommands 仅为「映射不经 pi RPC」的 not-called 断言留桩）──

interface ClientOverrides {
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

interface RegistryOverrides {
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
      '\n</skill>'.length + // block 闭合
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

  it('无 frontmatter 闭合 ---：镜像 pi 行为原文保留（不剥），块内展开正文为全文 trim', async () => {
    writeFileSync(skillAPath, '---\nname: skill-a\n没有闭合行')
    const raw = '---\nname: skill-a\n没有闭合行'
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
    // 注入形态与主链逐字一致（同一 injector，无第二实现面）
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

  it('④ LateBoundSkillSource bind 后透传真源（构造顺序环收口形态）', async () => {
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
