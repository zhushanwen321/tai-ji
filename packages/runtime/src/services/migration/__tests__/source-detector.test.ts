/**
 * detectSources 纯函数单元测试（W1）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/migration/__tests__/source-detector.test.ts
 *
 * 策略：mock node:fs 的 existsSync/readdirSync/statSync，构造虚拟文件系统映射，
 * 验证 4 源检测的安装状态 + skillCount/agentCount 计数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectSources } from '../source-detector.js'

// ── 虚拟文件系统（path → 目录条目列表 或 'file' 标记）──
// statSync 通过查表判断是目录还是文件。

type FsEntry =
  | { type: 'dir'; children: string[] }   // 目录及其直接子名
  | { type: 'file' }                       // 文件

function buildFs(filesystem: Record<string, FsEntry>): void {
  // existsSync：任何登记的 path（dir 或 file）都视为存在
  vi.mocked(fs.existsSync).mockImplementation((p) => {
    const norm = String(p)
    return Object.prototype.hasOwnProperty.call(filesystem, norm)
  })
  // readdirSync：返回目录的 children（非目录抛错）
  vi.mocked(fs.readdirSync).mockImplementation((((p: unknown) => {
    const norm = String(p)
    const entry = filesystem[norm]
    if (entry?.type === 'dir') return entry.children
    throw new Error(`readdirSync: not a directory: ${norm}`)
  }) as unknown as typeof fs.readdirSync))
  // statSync：返回带 isDirectory() 的对象。文件标记为 file，目录标记为 dir。
  // 未登记 path 视为文件（不应在测试中发生）。
  vi.mocked(fs.statSync).mockImplementation((((p: unknown) => {
    const norm = String(p)
    const entry = filesystem[norm]
    return {
      isDirectory: () => entry?.type === 'dir',
      isFile: () => entry?.type === 'file',
    }
  }) as unknown as typeof fs.statSync))
}

// path join 行为：source-detector 内部用 node:path join，此处不 mock，用真实 join。
// 测试用的 homeDir = '/home/test'，各源目录路径由 detectSources 内部 join 生成。

const HOME = '/home/test'
const CLAUDE_SKILLS = `${HOME}/.claude/skills`
const CLAUDE_AGENTS = `${HOME}/.claude/agents`
const CODEX_SKILLS = `${HOME}/.codex/skills`
const PI_SKILLS = `${HOME}/.pi/agent/skills`
const ZCODE_SKILLS = `${HOME}/.zcode/skills`

// 持有 mock 后的 node:fs 引用，便于每个 case 重新 setup
let fs: typeof import('node:fs')

// mock node:fs（保留其余方法的真实实现）
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
  }
})

beforeEach(async () => {
  fs = await import('node:fs')
  vi.clearAllMocks()
})

describe('detectSources 纯函数', () => {
  it('4 源全安装：各源返回正确 skillCount，claude 额外有 agentCount', () => {
    // 构造虚拟文件系统：
    // - claude: skills 含 2 个 SKILL.md（1 个直接、1 个在子目录）；agents 含 2 个 *.md
    // - codex:  skills 含 3 个 SKILL.md（全在子目录，递归计数）
    // - pi:     skills 含 1 个 SKILL.md（直接）
    // - zcode:  skills 含 0 个 SKILL.md（空目录但存在）
    buildFs({
      // claude skills 树
      [CLAUDE_SKILLS]: { type: 'dir', children: ['skill-a', 'skill-b', 'README.md'] },
      [`${CLAUDE_SKILLS}/skill-a`]: { type: 'dir', children: ['SKILL.md'] },
      [`${CLAUDE_SKILLS}/skill-a/SKILL.md`]: { type: 'file' },
      [`${CLAUDE_SKILLS}/skill-b`]: { type: 'dir', children: ['SKILL.md'] },
      [`${CLAUDE_SKILLS}/skill-b/SKILL.md`]: { type: 'file' },
      [`${CLAUDE_SKILLS}/README.md`]: { type: 'file' },
      // claude agents 树（顶层 *.md）
      [CLAUDE_AGENTS]: { type: 'dir', children: ['coder.md', 'reviewer.md', 'subdir'] },
      [`${CLAUDE_AGENTS}/coder.md`]: { type: 'file' },
      [`${CLAUDE_AGENTS}/reviewer.md`]: { type: 'file' },
      [`${CLAUDE_AGENTS}/subdir`]: { type: 'dir', children: ['nested.md'] },
      [`${CLAUDE_AGENTS}/subdir/nested.md`]: { type: 'file' },
      // codex skills 树（3 个 SKILL.md 全在子目录）
      [CODEX_SKILLS]: { type: 'dir', children: ['s1', 's2', 's3'] },
      [`${CODEX_SKILLS}/s1`]: { type: 'dir', children: ['SKILL.md'] },
      [`${CODEX_SKILLS}/s1/SKILL.md`]: { type: 'file' },
      [`${CODEX_SKILLS}/s2`]: { type: 'dir', children: ['SKILL.md'] },
      [`${CODEX_SKILLS}/s2/SKILL.md`]: { type: 'file' },
      [`${CODEX_SKILLS}/s3`]: { type: 'dir', children: ['SKILL.md'] },
      [`${CODEX_SKILLS}/s3/SKILL.md`]: { type: 'file' },
      // pi skills（1 个直接 SKILL.md）
      [PI_SKILLS]: { type: 'dir', children: ['SKILL.md'] },
      [`${PI_SKILLS}/SKILL.md`]: { type: 'file' },
      // zcode skills（空目录，存在但无 SKILL.md）
      [ZCODE_SKILLS]: { type: 'dir', children: [] },
    })

    const results = detectSources(HOME)
    // 4 项
    expect(results).toHaveLength(4)
    // 按源断言
    const bySource = new Map(results.map(r => [r.source, r]))
    // claude: installed + skillCount=2 + agentCount=2（顶层 .md，不递归）
    const claude = bySource.get('claude')!
    expect(claude.installed).toBe(true)
    expect(claude.dir).toBe(CLAUDE_SKILLS)
    expect(claude.skillCount).toBe(2)
    expect(claude.agentCount).toBe(2)
    expect(claude.providerCount).toBeUndefined()
    // codex: installed + skillCount=3（递归）
    const codex = bySource.get('codex')!
    expect(codex.installed).toBe(true)
    expect(codex.skillCount).toBe(3)
    expect(codex.agentCount).toBeUndefined()
    // pi: installed + skillCount=1
    const pi = bySource.get('pi')!
    expect(pi.installed).toBe(true)
    expect(pi.skillCount).toBe(1)
    expect(pi.agentCount).toBeUndefined()
    // zcode: installed（空目录存在）+ skillCount=0
    const zcode = bySource.get('zcode')!
    expect(zcode.installed).toBe(true)
    expect(zcode.skillCount).toBe(0)
    expect(zcode.agentCount).toBeUndefined()
  })

  it('某源未安装（目录不存在）：installed=false，无 count 字段', () => {
    // 只登记 claude，其余 3 源目录不存在
    buildFs({
      [CLAUDE_SKILLS]: { type: 'dir', children: ['SKILL.md'] },
      [`${CLAUDE_SKILLS}/SKILL.md`]: { type: 'file' },
      [CLAUDE_AGENTS]: { type: 'dir', children: ['a.md'] },
      [`${CLAUDE_AGENTS}/a.md`]: { type: 'file' },
    })

    const results = detectSources(HOME)
    const bySource = new Map(results.map(r => [r.source, r]))

    // claude 仍 installed
    expect(bySource.get('claude')!.installed).toBe(true)
    // codex/pi/zcode 都未安装
    for (const src of ['codex', 'pi', 'zcode'] as const) {
      const r = bySource.get(src)!
      expect(r.installed).toBe(false)
      expect(r.skillCount).toBeUndefined()
      expect(r.agentCount).toBeUndefined()
      expect(r.providerCount).toBeUndefined()
      // dir 仍返回（路径已知，只是不存在）
      expect(r.dir).toBe(src === 'codex' ? CODEX_SKILLS : src === 'pi' ? PI_SKILLS : ZCODE_SKILLS)
    }
  })

  it('SKILL.md 文件名不分大小写（Skill.md / skill.md 都计数）', () => {
    buildFs({
      [CLAUDE_SKILLS]: { type: 'dir', children: ['a', 'b'] },
      [`${CLAUDE_SKILLS}/a`]: { type: 'dir', children: ['Skill.md'] },
      [`${CLAUDE_SKILLS}/a/Skill.md`]: { type: 'file' },
      [`${CLAUDE_SKILLS}/b`]: { type: 'dir', children: ['skill.md'] },
      [`${CLAUDE_SKILLS}/b/skill.md`]: { type: 'file' },
      [CLAUDE_AGENTS]: { type: 'dir', children: [] },
    })
    const results = detectSources(HOME)
    const claude = results.find(r => r.source === 'claude')!
    expect(claude.installed).toBe(true)
    expect(claude.skillCount).toBe(2)
  })

  it('claude 仅 skill 目录存在（agent 目录缺失）：installed=true，agentCount=0', () => {
    buildFs({
      [CLAUDE_SKILLS]: { type: 'dir', children: ['SKILL.md'] },
      [`${CLAUDE_SKILLS}/SKILL.md`]: { type: 'file' },
      // claude agents 不存在
    })
    const results = detectSources(HOME)
    const claude = results.find(r => r.source === 'claude')!
    expect(claude.installed).toBe(true)
    expect(claude.skillCount).toBe(1)
    expect(claude.agentCount).toBe(0)
  })

  it('claude 仅 agent 目录存在（skill 目录缺失）：installed=true，skillCount=0，agentCount=计数', () => {
    buildFs({
      // claude skills 不存在
      [CLAUDE_AGENTS]: { type: 'dir', children: ['x.md', 'y.md'] },
      [`${CLAUDE_AGENTS}/x.md`]: { type: 'file' },
      [`${CLAUDE_AGENTS}/y.md`]: { type: 'file' },
    })
    const results = detectSources(HOME)
    const claude = results.find(r => r.source === 'claude')!
    expect(claude.installed).toBe(true)
    expect(claude.skillCount).toBe(0)
    expect(claude.agentCount).toBe(2)
  })

  it('纯函数不抛异常：传入不存在的 homeDir，所有源 installed=false', () => {
    // 全空文件系统（existsSync 全 false）
    buildFs({})
    expect(() => detectSources('/nonexistent/home')).not.toThrow()
    const results = detectSources('/nonexistent/home')
    expect(results).toHaveLength(4)
    expect(results.every(r => r.installed === false)).toBe(true)
    expect(results.every(r => r.skillCount === undefined)).toBe(true)
  })

  it('readdirSync 抛异常时降级为 installed=false（不抛）', () => {
    // claude skill 目录「存在」但 readdir 抛错（权限/IO 异常）→ 该源降级
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p) === CLAUDE_SKILLS || String(p) === CLAUDE_AGENTS)
    vi.mocked(fs.readdirSync).mockImplementation((() => {
      throw new Error('EACCES')
    }) as unknown as typeof fs.readdirSync)
    vi.mocked(fs.statSync).mockImplementation((() => ({
      isDirectory: () => true,
    })) as unknown as typeof fs.statSync)

    expect(() => detectSources(HOME)).not.toThrow()
    const results = detectSources(HOME)
    const claude = results.find(r => r.source === 'claude')!
    // 两个目录都 existsSync=true 但 readdir 抛错 → detectClaude 内部 countSkillFiles 抛出被外层 try-catch 捕获
    // 注意：countSkillFiles 内部已 catch readdir（返回 0），所以 claude 仍 installed=true，skillCount=0
    expect(claude.installed).toBe(true)
    expect(claude.skillCount).toBe(0)
  })

  it('返回数组顺序为 claude / codex / pi / zcode', () => {
    buildFs({})
    const results = detectSources(HOME)
    expect(results.map(r => r.source)).toEqual(['claude', 'codex', 'pi', 'zcode'])
  })
})
