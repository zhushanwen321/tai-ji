/**
 * SkillInjector 单测（composer-multi-skill-injection P1，R4 D11 末尾块形态）。
 *
 * 覆盖：无标记零改动 / 正常形态逐字（正文标记保留 + 末尾 `<xyz-skill-data>` 包裹块，
 * 块内 block 与 pi 模板逐字一致）/ 降级形态逐字（块内标记清单 + 块内指引行，无全文）/
 * 同 name 去重（出现序首个归并，location 恒取映射结果）/ contextWindow fail-safe /
 * 阈值边界 / 三类失效透传+提示（标记留正文、不进块）/ mapping_unavailable 无块 /
 * location 缺省补路径。
 * SKILL.md fixture 用 mkdtempSync 自建自删（测试禁区红线：不触碰真实数据目录）；
 * get_commands / get_session_stats 以 fake client 注入（真实链路由验收阶段 Gate B 覆盖）。
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
} from '@xyz-agent/shared'
import { SkillInjector } from '../skill-injector.js'
import { encodeDirectiveText } from '../session-records.js'
import type { IPiEngine, PiCommandInfo } from '../../ports/pi-engine.js'

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

// ── fake client ──

/**
 * skill 命令 fake：name 带 `skill:` 前缀（对齐 pi 实装 agent-session.js :1996
 * `name: \`skill:${skill.name}\``）——mock 与实装不同形会掩盖生产错位（PS-24 教训）。
 * 不设 sourceInfo.baseDir：注入器 References 行取 dirname(path)（skill.baseDir 实装语义），
 * 不消费 sourceInfo.baseDir。
 */
const skillCmd = (name: string, path: string): PiCommandInfo => ({
  name: `skill:${name}`,
  source: 'skill',
  sourceInfo: { path, source: 'skill' },
})

interface ClientOverrides {
  commands?: PiCommandInfo[]
  commandsError?: Error
  stats?: { contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } }
  statsError?: Error
}

function makeClient(overrides: ClientOverrides = {}): { client: IPiEngine; getCommands: ReturnType<typeof vi.fn>; getSessionStats: ReturnType<typeof vi.fn> } {
  const getCommands = vi.fn(async () => {
    if (overrides.commandsError) throw overrides.commandsError
    return overrides.commands ?? []
  })
  const getSessionStats = vi.fn(async () => {
    if (overrides.statsError) throw overrides.statsError
    return overrides.stats ?? {}
  })
  return { client: { getCommands, getSessionStats } as unknown as IPiEngine, getCommands, getSessionStats }
}

/** 与 pi 实装模板逐字同构的 block 期望构造（path/baseDir 为 fixture 真实路径）。 */
const expectedBlock = (name: string, path: string, baseDir: string, body: string): string =>
  `<skill name="${name}" location="${path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`

/** 期望正常形态包裹块（D11）：`<xyz-skill-data>` 首行开标签、每个 block 独立一行、末行闭标签。 */
const expectedDataBlock = (...expansions: string[]): string =>
  [`<${SKILL_DATA_BLOCK_TAG}>`, ...expansions, `</${SKILL_DATA_BLOCK_TAG}>`].join('\n')

/** 期望降级形态包裹块（D11）：块内标记清单 + 块内指引行（指引行在闭标签前一行）。 */
const expectedFallbackBlock = (...skills: Array<{ name: string; location?: string }>): string =>
  [`<${SKILL_DATA_BLOCK_TAG}>`, ...skills.map((s) => buildSkillMarker(s.name, s.location)), SKILL_FALLBACK_GUIDANCE, `</${SKILL_DATA_BLOCK_TAG}>`].join('\n')

describe('SkillInjector.inject', () => {
  let injector: SkillInjector
  beforeEach(() => {
    injector = new SkillInjector()
  })

  it('① 单标记：正文标记逐字保留 + 末尾块内 block 与 pi 模板逐字一致（正文与块空行分隔）', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const text = `帮我 ${marker} 处理问题`
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, text)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    expect(result.text).toBe(`${text}\n\n${expectedDataBlock(block)}`)
    expect(result.notices).toEqual([])
  })

  it('① 多标记：正文两个标记原样保留，块内两个 block 按标记出现序', async () => {
    const mA = buildSkillMarker('skill-a', skillAPath)
    const mB = buildSkillMarker('skill-b', skillBPath)
    const text = `开头 ${mA} 中间 ${mB} 结尾`
    const { client } = makeClient({
      commands: [skillCmd('skill-a', skillAPath), skillCmd('skill-b', skillBPath)],
      stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } },
    })
    const result = await injector.inject(client, text)
    const blockA = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    const blockB = expectedBlock('skill-b', skillBPath, skillBDir, SKILL_B_BODY)
    expect(result.text).toBe(`${text}\n\n${expectedDataBlock(blockA, blockB)}`)
  })

  it('① 标记位于两端：正文零改动（无原位替换），块统一追加末尾', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    // 标记开头
    const head = await injector.inject(client, `${marker} 后续正文`)
    expect(head.text).toBe(`${marker} 后续正文\n\n${expectedDataBlock(block)}`)
    // 标记结尾
    const tail = await injector.inject(client, `前置正文 ${marker}`)
    expect(tail.text).toBe(`前置正文 ${marker}\n\n${expectedDataBlock(block)}`)
  })

  it('② 无标记文本零改动且不发起任何 RPC', async () => {
    const text = '普通文本 /skill:skill-a 手打命令不处理'
    const { client, getCommands, getSessionStats } = makeClient()
    const result = await injector.inject(client, text)
    expect(result.text).toBe(text)
    expect(result.notices).toEqual([])
    expect(getCommands).not.toHaveBeenCalled()
    expect(getSessionStats).not.toHaveBeenCalled()
  })

  it('③ 超阈值：正文标记保留 + 降级形态逐字（<xyz-skill-data> 块内清单 + 块内指引行，无全文）', async () => {
    // 大 CJK body：估算 ≈ 1000+ token > 0.8 × 100 = 80
    const bigBody = '很'.repeat(1000)
    writeFileSync(skillAPath, `---\nname: skill-a\ndescription: big\n---\n${bigBody}`)
    const marker = buildSkillMarker('skill-a', skillAPath)
    const text = `正文在前 ${marker}`
    const { client, getCommands } = makeClient({
      commands: [skillCmd('skill-a', skillAPath)],
      stats: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } },
    })
    const result = await injector.inject(client, text)
    // 正文逐字保留 + 空行 + 降级包裹块（标记清单与指引行都在块内，D11）
    expect(result.text).toBe(`${text}\n\n${expectedFallbackBlock({ name: 'skill-a', location: skillAPath })}`)
    expect(result.text).not.toContain(bigBody)
    expect(result.text).toContain(SKILL_FALLBACK_GUIDANCE)
    expect(result.text).toContain(skillAPath)
    expect(result.notices).toEqual([{ reason: 'budget_exceeded', skills: ['skill-a'] }])
    expect(getCommands).toHaveBeenCalledTimes(1)
  })

  it('③ 多 skill 超阈值：降级清单归拢全部 name/location（按出现顺序、块内清单形态）', async () => {
    const bigBody = '很'.repeat(600)
    writeFileSync(skillAPath, bigBody)
    writeFileSync(skillBPath, bigBody)
    const mA = buildSkillMarker('skill-a', skillAPath)
    const mB = buildSkillMarker('skill-b', skillBPath)
    const text = `${mA} ${mB}`
    const { client } = makeClient({
      commands: [skillCmd('skill-a', skillAPath), skillCmd('skill-b', skillBPath)],
      stats: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } },
    })
    const result = await injector.inject(client, text)
    expect(result.text).toBe(`${text}\n\n${expectedFallbackBlock({ name: 'skill-a', location: skillAPath }, { name: 'skill-b', location: skillBPath })}`)
    expect(result.notices).toEqual([{ reason: 'budget_exceeded', skills: ['skill-a', 'skill-b'] }])
  })

  it('④ get_session_stats 抛错：fail-safe 降级（reason=context_window_unavailable），不放行全文', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const { client } = makeClient({
      commands: [skillCmd('skill-a', skillAPath)],
      statsError: new Error('rpc timeout'),
    })
    const result = await injector.inject(client, `正文 ${marker}`)
    expect(result.text).toBe(`正文 ${marker}\n\n${expectedFallbackBlock({ name: 'skill-a', location: skillAPath })}`)
    expect(result.text).not.toContain(SKILL_A_BODY)
    expect(result.notices).toEqual([{ reason: 'context_window_unavailable', skills: ['skill-a'] }])
  })

  it('④ contextUsage 缺失 / contextWindow 非法：同样 fail-safe 降级', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const noUsage = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: {} })
    const resultNoUsage = await injector.inject(noUsage.client, `正文 ${marker}`)
    expect(resultNoUsage.text).toContain(`<${SKILL_DATA_BLOCK_TAG}>`)
    expect(resultNoUsage.text).not.toContain(SKILL_A_BODY)
    expect(resultNoUsage.notices[0]?.reason).toBe('context_window_unavailable')

    const zeroWindow = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 0, contextWindow: 0, percent: null } } })
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
    const low = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: window, percent: 1 } } })
    const lowResult = await injector.inject(low.client, text)
    expect(lowResult.text).toBe(`${text}\n\n${expectedDataBlock(expectedBlock('skill-a', skillAPath, skillADir, bodyOf(nExact - 9)))}`)
    expect(lowResult.text).not.toContain(SKILL_FALLBACK_GUIDANCE)
    expect(lowResult.notices).toEqual([])

    // 恰好等于阈值（320 > 320 为 false）：不降级
    writeBody(nExact)
    const exact = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: window, percent: 1 } } })
    const exactResult = await injector.inject(exact.client, text)
    expect(exactResult.text).toBe(`${text}\n\n${expectedDataBlock(expectedBlock('skill-a', skillAPath, skillADir, bodyOf(nExact)))}`)
    expect(exactResult.notices).toEqual([])

    // 略超（估算 323 > 320）：降级
    writeBody(nExact + 9)
    const over = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: window, percent: 1 } } })
    const overResult = await injector.inject(over.client, text)
    expect(overResult.text).toBe(`${text}\n\n${expectedFallbackBlock({ name: 'skill-a', location: skillAPath })}`)
    expect(overResult.notices[0]?.reason).toBe('budget_exceeded')
  })

  it('⑥ name 无映射：标记原样透传 + skill_missing 提示（无 valid 时跳过预检 RPC）', async () => {
    const marker = buildSkillMarker('ghost', '/nonexistent/SKILL.md')
    const { client, getCommands, getSessionStats } = makeClient({ commands: [skillCmd('skill-a', skillAPath)] })
    const result = await injector.inject(client, `正文 ${marker} 结束`)
    expect(result.text).toBe(`正文 ${marker} 结束`)
    expect(result.text).not.toContain(`<${SKILL_DATA_BLOCK_TAG}>`)
    expect(result.notices).toEqual([{ reason: 'skill_missing', skills: ['ghost'] }])
    expect(getCommands).toHaveBeenCalledTimes(1)
    expect(getSessionStats).not.toHaveBeenCalled()
  })

  it('失效分路：无映射标记留正文 + notice，其余正常进块（部分失效不阻断整条注入）', async () => {
    const valid = buildSkillMarker('skill-a', skillAPath)
    const ghost = buildSkillMarker('ghost')
    const text = `前 ${valid} 中 ${ghost} 后`
    const { client, getSessionStats } = makeClient({
      commands: [skillCmd('skill-a', skillAPath)],
      stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } },
    })
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
    const { client } = makeClient({ commands: [skillCmd('skill-a', missingPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, `正文 ${marker}`)
    expect(result.text).toBe(`正文 ${marker}`)
    expect(result.notices).toEqual([{ reason: 'skill_read_failed', skills: ['skill-a'] }])
  })

  it('⑦ 映射缺 sourceInfo.path：无法定位文件，按读取失败处理', async () => {
    const marker = buildSkillMarker('skill-a', '')
    const { client } = makeClient({
      commands: [{ name: 'skill:skill-a', source: 'skill' }],
      stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } },
    })
    const result = await injector.inject(client, `正文 ${marker}`)
    expect(result.text).toBe(`正文 ${marker}`)
    expect(result.notices).toEqual([{ reason: 'skill_read_failed', skills: ['skill-a'] }])
  })

  it('⑧ 标记残缺（hook 改写破坏）：残缺部分透传 + marker_malformed 提示，不发起 RPC', async () => {
    const text = `帮我 <xyz-skill name="skill-a" loc 这段`
    const { client, getCommands } = makeClient()
    const result = await injector.inject(client, text)
    expect(result.text).toBe(text)
    expect(result.notices).toEqual([{ reason: 'marker_malformed', skills: ['skill-a'] }])
    expect(getCommands).not.toHaveBeenCalled()
  })

  it('⑨ location 缺省标记：get_commands 映射补路径，正常展开进块', async () => {
    const marker = buildSkillMarker('skill-a')
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, marker)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    expect(result.text).toBe(`${marker}\n\n${expectedDataBlock(block)}`)
    expect(result.notices).toEqual([])
  })

  it('PS-24：get_commands name 带 skill: 前缀（实装形态）——映射可命中且块内 block name 无前缀', async () => {
    // 实装 get_commands 的 skill 项 name 恒带 `skill:` 前缀（agent-session.js :1996）；
    // 私有标记 name 是裸名——映射按裸名命中、block name 插值剥前缀，两端都对齐 pi。
    const marker = buildSkillMarker('skill-a', skillAPath)
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, `帮我 ${marker}`)
    // 显式断言：不误报 skill_missing + 块内 block name 无前缀（pi 原生展开形态）
    expect(result.notices).toEqual([])
    expect(result.text).toContain(`<skill name="skill-a" location="${skillAPath}">`)
    expect(result.text).not.toContain('name="skill:')
  })

  it('get_commands 整体失败：全部标记透传 + mapping_unavailable（正文留标记、不追加块）', async () => {
    const m1 = buildSkillMarker('skill-a', skillAPath)
    const m2 = buildSkillMarker('ghost')
    const { client, getSessionStats } = makeClient({ commandsError: new Error('rpc closed') })
    const result = await injector.inject(client, `${m1} 正文 ${m2}`)
    expect(result.text).toBe(`${m1} 正文 ${m2}`)
    expect(result.text).not.toContain(`<${SKILL_DATA_BLOCK_TAG}>`)
    expect(result.notices).toEqual([{ reason: 'mapping_unavailable', skills: ['skill-a', 'ghost'] }])
    expect(getSessionStats).not.toHaveBeenCalled()
  })

  it('失效与降级共存：降级清单只含可展开者，失效标记保留正文 + 双 notice', async () => {
    writeFileSync(skillAPath, '很'.repeat(1000))
    const valid = buildSkillMarker('skill-a', skillAPath)
    const invalid = buildSkillMarker('ghost')
    const text = `前 ${valid} 中 ${invalid} 后`
    const { client } = makeClient({
      commands: [skillCmd('skill-a', skillAPath)],
      stats: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } },
    })
    const result = await injector.inject(client, text)
    expect(result.text).toBe(`${text}\n\n${expectedFallbackBlock({ name: 'skill-a', location: skillAPath })}`)
    expect(result.text).toContain(invalid)
    expect(result.text).not.toContain('很'.repeat(1000))
    expect(result.notices).toEqual([
      { reason: 'budget_exceeded', skills: ['skill-a'] },
      { reason: 'skill_missing', skills: ['ghost'] },
    ])
  })

  it('baseDir：sourceInfo.baseDir 不保证是 SKILL.md 所在目录，References 行仍用 dirname(path)', async () => {
    // PS-24 真实 pi 探针实证：pi 展开的 References baseDir = skill.baseDir = dirname(filePath)
    //（skills.js :236/:260）；而 get_commands 的 sourceInfo.baseDir 经 resource-loader.js
    // :514-518 extension 覆盖链（findSourceInfoForPath 命中时 createSourceInfo 直接采用
    // extension metadata.baseDir，可为 skill 提供方给的任意目录）与 :612 兜底
    //（getDefaultSourceInfoForPath 的 `<...>` 形态返回对象无 baseDir 字段）装载，不可消费。
    const marker = buildSkillMarker('skill-a', skillAPath)
    const scanRoot = join(tmpRoot, 'skills-root')
    const { client } = makeClient({
      commands: [{ name: 'skill:skill-a', source: 'skill', sourceInfo: { path: skillAPath, source: 'local', scope: 'user', baseDir: scanRoot } }],
      stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } },
    })
    const result = await injector.inject(client, marker)
    expect(result.text).toContain(`References are relative to ${skillADir}.`)
    expect(result.text).not.toContain(`References are relative to ${scanRoot}`)
  })

  it('无 frontmatter 闭合 ---：镜像 pi 行为原文保留（不剥），块内展开正文为全文 trim', async () => {
    writeFileSync(skillAPath, '---\nname: skill-a\n没有闭合行')
    const raw = '---\nname: skill-a\n没有闭合行'
    const marker = buildSkillMarker('skill-a', skillAPath)
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, marker)
    expect(result.text).toBe(`${marker}\n\n${expectedDataBlock(expectedBlock('skill-a', skillAPath, skillADir, raw))}`)
  })
})

describe('SkillInjector.inject 同 name 去重（R4 D11）', () => {
  let injector: SkillInjector
  beforeEach(() => {
    injector = new SkillInjector()
  })

  it('正文两个同名标记：块内一个 <skill>（按出现序首个归并），重复不发 notice', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const text = `${marker} 正文 ${marker}`
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
    const result = await injector.inject(client, text)
    const block = expectedBlock('skill-a', skillAPath, skillADir, SKILL_A_BODY)
    // 整条形态 = 标记正文逐字保留 + 空行 + 恰含一个 block 的包裹块
    expect(result.text).toBe(`${text}\n\n${expectedDataBlock(block)}`)
    // 显式去重断言：pi 形态 <skill name= 恰一次（<xyz-skill 前缀不误计）
    expect(result.text.split('<skill name=').length - 1).toBe(1)
    expect(result.text.split(SKILL_A_BODY).length - 1).toBe(1)
    expect(result.notices).toEqual([])
  })

  it('不同自带 location 的同名标记：块内 location 恒取映射结果（首个），不信任标记自带值', async () => {
    // 过时路径场景：标记自带 location 与映射不一致（skill 移动后），块内 location 必须
    // 是 get_commands 权威映射的当前路径（D4/D11 数据源澄清）
    const stalePath = '/stale/old-place/SKILL.md'
    const text = `${buildSkillMarker('skill-a', stalePath)} 正文 ${buildSkillMarker('skill-a', skillAPath)}`
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
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
  let injector: SkillInjector
  beforeEach(() => {
    injector = new SkillInjector()
  })

  it('含 skill 标记的定向文本：末尾块形态与主链逐字一致，encode 后保持命令单行', async () => {
    const marker = buildSkillMarker('skill-a', skillAPath)
    const text = `帮我 ${marker} 处理这个任务`
    const { client } = makeClient({ commands: [skillCmd('skill-a', skillAPath)], stats: { contextUsage: { tokens: 1, contextWindow: 100000, percent: 1 } } })
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

  it('无标记定向文本：no-op 原文返回且零 RPC（fake client 无命令映射可用也不发起请求）', async () => {
    const text = '纯文本定向消息，无任何 skill 标记'
    const { client, getCommands, getSessionStats } = makeClient()
    const result = await injector.inject(client, text)
    expect(result.text).toBe(text)
    expect(result.notices).toEqual([])
    expect(getCommands).not.toHaveBeenCalled()
    expect(getSessionStats).not.toHaveBeenCalled()
  })
})
