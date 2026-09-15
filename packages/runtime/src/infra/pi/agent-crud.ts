/**
 * Agent 文件 CRUD —— 扫描 / 写入 / 删除 agent .md 文件
 *
 * 从 pi-config-bridge.ts 提取（pi-config-bridge 已删除）。
 * 强制写入目录是 getAgentsDir()（pi-paths），多目录扫描支持 discovery.json.agentDirs。
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from '../../utils/fs-utils.js'
import { getAgentsDir } from './pi-paths.js'
// W1：按 discovered 目录推断 sourceType（claude/agents/pi/custom），
// 让 loadAgents 不再恒 pi——否则 Settings Agent 页按 tab 过滤失效。
import { inferSourceType } from '../../services/scanners/scanner-base.js'
import type { ScanSourceType } from '@taiji/shared'

/** Agent 文件扫描结果（单目录版，保持向后兼容）。 */
export interface AgentFileEntry {
  name: string
  path: string
  content: string
  /** 来源目录推断结果（W1），由 inferSourceType(rawDir) 填充。 */
  sourceType?: ScanSourceType
}

/**
 * 扫描 agent .md 文件。
 * - 不带参：扫默认强制目录 getAgentsDir()（向后兼容，旧调用方）。
 * - 带 dirs：扫多目录（ADR-0021 §1.1 层 3），同名按数组顺序去重（靠前覆盖靠后）。
 *   dirs 数组顺序 = 优先级（与 discovery.json.agentDirs 顺序一致）。
 */
export function listAgentFiles(dirs?: string[]): AgentFileEntry[] {
  const scanDirs = dirs ?? [getAgentsDir()]
  const seen = new Map<string, AgentFileEntry>() // name → entry，先到先得（靠前胜出）

  for (const rawDir of scanDirs) {
    if (!rawDir) continue
    if (!existsSync(rawDir)) continue
    let files: string[]
    try {
      files = readdirSync(rawDir).filter(f => f.endsWith('.md'))
    } catch {
      continue
    }
    for (const file of files) {
      const filePath = join(rawDir, file)
      const name = file.replace(/\.md$/, '')
      if (seen.has(name)) continue // 同名去重，靠前目录胜出
      try {
        const content = readFileSync(filePath, 'utf-8')
        // W1：用 discovered 目录推断 sourceType（如 ~/.claude/agents → 'claude'），
        // 透传到 loadAgents → AgentInfo.sourceType，供 Settings 按 tab 过滤。
        seen.set(name, { name, path: filePath, content, sourceType: inferSourceType(rawDir) })
      // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable agent files
      } catch {
        // skip unreadable files
      }
    }
  }

  return [...seen.values()]
}

export function writeAgentFile(name: string, content: string): void {
  const agentsDir = getAgentsDir()
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true })
  const fileName = name.endsWith('.md') ? name : `${name}.md`
  const filePath = join(agentsDir, fileName)
  atomicWrite(filePath, content)
}

export function deleteAgentFile(name: string): boolean {
  const agentsDir = getAgentsDir()
  const fileName = name.endsWith('.md') ? name : `${name}.md`
  const filePath = join(agentsDir, fileName)
  if (!existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}
