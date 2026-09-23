import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ScannedAgentInfo } from '@taiji/shared'
import { forEachScannedDir } from './scanner-base.js'
import { extractFrontmatter, extractDescription } from '../../utils/frontmatter.js'
import { warnOnce } from '../../utils/warn-once.js'

const DESCRIPTION_MAX_LENGTH = 200

// 从 frontmatter 提取 description + tools，正文 fallback 取第一个非标题非空行。
// frontmatter 分割 + 多行 description 解析走通用 helper（D1），tools 是 agent 专属字段 inline 提取。
function parseAgentMd(content: string): { description: string; tools: string[] } {
  const { frontmatter, body, bodyStartLine } = extractFrontmatter(content)

  // description：优先 frontmatter（支持多行 > 或 |），否则正文 fallback
  let description = extractDescription(frontmatter).slice(0, DESCRIPTION_MAX_LENGTH)
  if (!description) {
    const lines = content.split('\n')
    for (let i = bodyStartLine; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      if (line.startsWith('#')) continue
      description = line.slice(0, DESCRIPTION_MAX_LENGTH)
      break
    }
  }

  // tools 是 agent 专属字段（逗号分隔），inline 提取
  const tools: string[] = []
  const toolsMatch = frontmatter.match(/^tools:\s*(.+)$/m)?.[1]
  if (toolsMatch) {
    for (const t of toolsMatch.split(',')) {
      const trimmed = t.trim()
      if (trimmed) tools.push(trimmed)
    }
  }

  // body 暂未直接使用（正文 fallback 走 bodyStartLine 重切，保持与原实现逐行一致）
  void body

  return { description, tools }
}

export function scanAgents(sources: string[], existingAgentIds: Set<string>): ScannedAgentInfo[] {
  const results: ScannedAgentInfo[] = []

  forEachScannedDir(sources, (dirPath, entryName, sourceType) => {
    // 查找主配置文件：优先 agent.md，备选目录名.md 或 SKILL.md
    const candidates = ['agent.md', `${entryName}.md`, 'SKILL.md']
    let configPath: string | null = null
    let content = ''

    for (const c of candidates) {
      const p = join(dirPath, c)
      if (existsSync(p)) {
        configPath = p
        try {
          content = readFileSync(p, 'utf-8')
        } catch (e: unknown) {
          // RT-8#11 同族：配置文件存在但不可读（权限/半损坏）→ 该 agent 从列表无声消失，
          // 「防线从未生效」不可观测。warn-once 按文件路径去重——每次扫描都会重读，
          // 逐次 warn 会刷屏。
          warnOnce(
            `agent-config:${p}`,
            `[agent-scanner] agent 配置文件读取失败，该 agent 被跳过（不会出现在列表）: ${p}。` +
              '恢复动作：修复该文件的读权限或内容后重扫',
            e,
          )
          return
        }
        break
      }
    }

    if (!configPath) return

    try {
      const { description, tools } = parseAgentMd(content)
      const id = `${sourceType}-${entryName}`
      const alreadyImported = existingAgentIds.has(id)

      results.push({
        id,
        name: entryName,
        description,
        sourceType,
        sourcePath: configPath,
        content,
        icon: entryName.charAt(0).toUpperCase(),
        tools,
        alreadyImported,
      })
    // eslint-disable-next-line taste/no-silent-catch -- intentional: skip unreadable agents, continue scanning
    } catch (e) {
      console.error(`[agent-scanner] error reading ${dirPath}:`, e)
    }
  })

  return results
}
