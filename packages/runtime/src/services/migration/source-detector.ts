/**
 * 迁移源检测器（W1）——纯函数，检测本机其他 agent 的 skill/agent 配置目录。
 *
 * 安全约束：
 * - 只统计文件数量，不读取文件内容（不提取任何 API key、不解析配置正文）。
 * - skillCount 递归统计名为 SKILL.md（不分大小写）的文件。
 * - agentCount 仅统计目录顶层 *.md（agent 文件位于根目录，不递归子目录）。
 * - 不写日志（不泄露目录结构到日志）。
 *
 * 纯函数语义：对任何输入（含不存在的 homeDir）都返回数组、不抛异常。
 * 目录不存在 → installed=false；目录存在但不可读（EACCES 等）→ installed=true +
 * error='unreadable' + 计数缺省（RT-5#5：「不可读」不降级为「未安装」，三态可区分）。
 * 子树级读失败（嵌套子目录 stat/readdir）按该子树计数 0 的局部降级处理。
 *
 * 源 → 配置目录映射：
 * - Claude Code: <home>/.claude/skills（skill）、<home>/.claude/agents（agent）
 * - Codex:       <home>/.codex/skills
 * - Pi:          <home>/.pi/agent/skills（agent 目录 W1 不做 Pi）
 * - ZCode:       <home>/.zcode/skills（无标准 agent 目录）
 *
 * 返回扁平数组（每个源一项）。claude 项既有 skillCount 又有 agentCount；
 * codex/pi/zcode 项只有 skillCount。所有项的 providerCount 在 W1 留 undefined。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderSource, AgentSource, SourceDetectResult } from '@taiji/shared'

/** skill 文件名（不分大小写匹配）。 */
const SKILL_FILE_NAME_LOWER = 'skill.md'

/**
 * 检测 4 个 agent 的 skill/agent 配置目录，返回每个源的安装状态 + 资源计数。
 *
 * @param homeDir 用户主目录（绝对路径）。检测器在其下拼接各 agent 的标准配置目录。
 * @returns 每个源一项的扁平数组；顺序为 claude / codex / pi / zcode。
 */
export function detectSources(homeDir: string): SourceDetectResult[] {
  // 每个源独立 try-catch：单个源检测异常不影响其他源，整体绝不抛异常。
  const results: SourceDetectResult[] = []

  // ── Claude Code：skill 目录 + agent 目录 ──
  const claudeSkillDir = join(homeDir, '.claude', 'skills')
  const claudeAgentDir = join(homeDir, '.claude', 'agents')
  results.push(detectClaude(claudeSkillDir, claudeAgentDir))

  // ── Codex：仅 skill 目录 ──
  const codexSkillDir = join(homeDir, '.codex', 'skills')
  results.push(detectSkillOnlySource('codex', codexSkillDir))

  // ── Pi：仅 skill 目录（agent 目录 W1 不做）──
  const piSkillDir = join(homeDir, '.pi', 'agent', 'skills')
  results.push(detectSkillOnlySource('pi', piSkillDir))

  // ── ZCode：仅 skill 目录 ──
  const zcodeSkillDir = join(homeDir, '.zcode', 'skills')
  results.push(detectSkillOnlySource('zcode', zcodeSkillDir))

  return results
}

/**
 * 检测 Claude Code 源（skill + agent 双目录）。
 * installed = skill 目录或 agent 目录任一存在即视为安装。
 * skillCount/agentCount 分别统计（仅存在的目录才计数）。
 * RT-5#5：目录存在但顶层不可读（EACCES 等）保留 installed=true + error 字段显形
 * 「不可读」——不再整体降级为 installed:false（「不可读」与「未安装」同形会误导用户
 * 以为源里没有内容）。
 */
function detectClaude(skillDir: string, agentDir: string): SourceDetectResult {
  const source: ProviderSource | AgentSource = 'claude'
  const skillExists = existsSync(skillDir)
  const agentExists = existsSync(agentDir)
  if (!skillExists && !agentExists) {
    return { source, installed: false, dir: skillDir }
  }
  const result: SourceDetectResult = { source, installed: true, dir: skillDir }
  let errored = false
  // skillCount 仅在 skill 目录存在时统计（不存在时省略字段，符合「installed=false 省略」语义延伸）。
  try {
    result.skillCount = skillExists ? countSkillFiles(skillDir) : 0
  } catch {
    // 顶层不可读：该计数缺省（不填 0 假数据），error 显形
    errored = true
  }
  try {
    result.agentCount = agentExists ? countAgentFiles(agentDir) : 0
  } catch {
    errored = true
  }
  if (errored) result.error = 'unreadable'
  return result
}

/**
 * 检测仅有 skill 目录的源（codex / pi / zcode）。
 * installed = skill 目录存在。目录存在但不可读 → error 显形（同 detectClaude）。
 */
function detectSkillOnlySource(source: ProviderSource, skillDir: string): SourceDetectResult {
  if (!existsSync(skillDir)) {
    return { source, installed: false, dir: skillDir }
  }
  const result: SourceDetectResult = { source, installed: true, dir: skillDir }
  try {
    result.skillCount = countSkillFiles(skillDir)
  } catch {
    result.error = 'unreadable'
  }
  return result
}

/**
 * 递归统计 dir 下名为 SKILL.md（不分大小写）的文件数。
 * 目录不存在返回 0；**顶层不可读上抛**（detect 层转 error 字段——「不可读」≠「0 个」）。
 */
function countSkillFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  const names = readdirSync(dir)
  let count = 0
  for (const name of names) {
    count += countSkillEntry(join(dir, name), name)
  }
  return count
}

/** 单条目计数：子目录走递归（子树内部降级 0）、skill.md 计 1、stat 失败跳过。 */
function countSkillEntry(child: string, name: string): number {
  try {
    if (statSync(child).isDirectory()) return countSkillFilesRecursive(child)
  } catch {
    // 符号链接断裂/权限等，跳过该条目
    return 0
  }
  return name.toLowerCase() === SKILL_FILE_NAME_LOWER ? 1 : 0
}

/** countSkillFiles 的子树递归实现（子目录层级）：任何 readdir/stat 异常按 0 处理该子树
 *  （局部降级——子树不可读只影响该子树计数，不掩盖顶层不可读）。 */
function countSkillFilesRecursive(dir: string): number {
  let count = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    const child = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(child).isDirectory()
    } catch {
      // stat 失败（符号链接断裂/权限等）按跳过处理。
      continue
    }
    if (isDir) {
      count += countSkillFilesRecursive(child)
    } else if (name.toLowerCase() === SKILL_FILE_NAME_LOWER) {
      count += 1
    }
  }
  return count
}

/**
 * 统计 dir 顶层 *.md 文件数（不递归子目录）。
 * 目录不存在返回 0；**顶层不可读上抛**（detect 层转 error 字段）；单条目 stat 失败跳过。
 */
function countAgentFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  const names = readdirSync(dir)
  let count = 0
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue
    const child = join(dir, name)
    try {
      // 只统计文件，不统计名为 *.md 的目录。
      if (!statSync(child).isDirectory()) count += 1
    } catch {
      // stat 失败按跳过处理。
      continue
    }
  }
  return count
}
