/**
 * agent-scanner 单测 — 真实文件系统下验证 scanAgents / parseAgentMd 逻辑。
 *
 * 覆盖（report #6）：
 * - 候选文件优先级：agent.md → 目录名.md → SKILL.md
 * - description：frontmatter 多行 >- + 正文 fallback（无 frontmatter / 首行标题跳过）
 * - tools 逗号分割
 * - alreadyImported 标志
 * - 200 字截断
 *
 * 参考 skill-scanner.test.ts 结构，但走 scanAgents（含 fs 读取）而非仅 parseAgentMd。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/agent-scanner.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanAgents } from '../src/services/scanners/agent-scanner.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-scan-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function writeAgent(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), content, 'utf-8')
}

describe('scanAgents', () => {
  it('候选优先级：agent.md 胜过同名 .md 与 SKILL.md', () => {
    const dir = join(root, 'myagent')
    writeAgent(dir, 'agent.md', '---\ndescription: from agent.md\n---\nbody')
    writeAgent(dir, 'myagent.md', '---\ndescription: from dir-name\n---\nbody')
    writeAgent(dir, 'SKILL.md', '---\ndescription: from skill\n---\nbody')

    const [agent] = scanAgents([root], new Set())
    expect(agent.description).toBe('from agent.md')
    expect(agent.sourcePath).toBe(join(dir, 'agent.md'))
  })

  it('无 agent.md 时回退目录名.md', () => {
    const dir = join(root, 'second')
    writeAgent(dir, 'second.md', '---\ndescription: dir-name fallback\n---\nbody')

    const [agent] = scanAgents([root], new Set())
    expect(agent.description).toBe('dir-name fallback')
    expect(agent.sourcePath).toBe(join(dir, 'second.md'))
  })

  it('无 agent.md / 目录名.md 时回退 SKILL.md', () => {
    const dir = join(root, 'third')
    writeAgent(dir, 'SKILL.md', '---\ndescription: skill fallback\n---\nbody')

    const [agent] = scanAgents([root], new Set())
    expect(agent.description).toBe('skill fallback')
  })

  it('无任何候选文件时跳过该目录', () => {
    mkdirSync(join(root, 'empty'), { recursive: true })
    writeFileSync(join(root, 'empty', 'readme.txt'), 'not an agent')

    expect(scanAgents([root], new Set())).toEqual([])
  })

  it('description 无 frontmatter 时正文 fallback（首非标题非空行）', () => {
    const dir = join(root, 'bodyagent')
    writeAgent(dir, 'agent.md', ['# Title', '', 'first body line', 'second'].join('\n'))

    const [agent] = scanAgents([root], new Set())
    expect(agent.description).toBe('first body line')
  })

  it('description 多行 >- 折叠块', () => {
    const dir = join(root, 'multi')
    writeAgent(dir, 'agent.md', ['---', 'description: >-', '  第一行', '  第二行', '---', 'body'].join('\n'))

    const [agent] = scanAgents([root], new Set())
    expect(agent.description).toBe('第一行 第二行')
  })

  it('tools 逗号分割并 trim', () => {
    const dir = join(root, 'toolsagent')
    writeAgent(dir, 'agent.md', ['---', 'description: d', 'tools: read , write, exec', '---', 'body'].join('\n'))

    const [agent] = scanAgents([root], new Set())
    expect(agent.tools).toEqual(['read', 'write', 'exec'])
  })

  it('alreadyImported：id 命中 existingAgentIds 时为 true', () => {
    const dir = join(root, 'imp')
    writeAgent(dir, 'agent.md', '---\ndescription: d\n---\nbody')

    // sourceType 对 tmpdir 推断为 'custom'，id = `custom-imp`
    const [imported] = scanAgents([root], new Set(['custom-imp']))
    expect(imported.alreadyImported).toBe(true)

    const [fresh] = scanAgents([root], new Set())
    expect(fresh.alreadyImported).toBe(false)
  })

  it('description 截断到 200 字', () => {
    const dir = join(root, 'long')
    const longDesc = '啊'.repeat(250)
    writeAgent(dir, 'agent.md', `---\ndescription: ${longDesc}\n---\nbody`)

    const [agent] = scanAgents([root], new Set())
    expect(agent.description.length).toBe(200)
  })

  it('icon 取目录名首字母大写', () => {
    const dir = join(root, 'lowercase')
    writeAgent(dir, 'agent.md', '---\ndescription: d\n---\nbody')

    const [agent] = scanAgents([root], new Set())
    expect(agent.icon).toBe('L')
  })

  it('多 agent 目录全部收集', () => {
    writeAgent(join(root, 'a1'), 'agent.md', '---\ndescription: a1d\n---\nbody')
    writeAgent(join(root, 'a2'), 'agent.md', '---\ndescription: a2d\n---\nbody')

    const agents = scanAgents([root], new Set())
    expect(agents).toHaveLength(2)
    expect(agents.map((a) => a.name).sort()).toEqual(['a1', 'a2'])
  })
})
