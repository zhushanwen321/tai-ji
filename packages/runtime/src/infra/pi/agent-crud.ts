/**
 * Agent 文件 CRUD —— 扫描 / 写入 / 删除 agent .md 文件
 *
 * 从 pi-config-bridge.ts 提取（pi-config-bridge 已删除）。
 * 强制写入目录是 getAgentsDir()（pi-paths），多目录扫描支持 discovery.json.agentDirs。
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { atomicWrite } from '../../utils/fs-utils.js'
import { getAgentsDir } from './pi-paths.js'
import { logger } from '../logger.js'
// W1：按 discovered 目录推断 sourceType（claude/agents/pi/custom），
// 让 loadAgents 不再恒 pi——否则 Settings Agent 页按 tab 过滤失效。
import { inferSourceType } from '../../services/scanners/scanner-base.js'
import type { ScanSourceType } from '@taiji/shared'

/**
 * RT-3#11 单段校验：name（用户可编辑的 agent.name||id，经
 * resources-message-handler → config-service 链路进入）必须是纯文件名——
 * basename 自等、非 `..`/`.`、不含任何路径分隔符。`../` 可越界写/删 agents
 * 目录之外的任意 *.md，写删两侧对称守卫；fileName = name[.md] 由追加后缀
 * 派生，不引入分隔符，故校验 name 即覆盖 join 的实际操作数。
 */
function assertSingleSegment(name: string): void {
  if (
    basename(name) !== name ||
    name === '..' || name === '.' ||
    name.includes('/') || name.includes('\\')
  ) {
    throw new Error(
      `非法的 agent 名称（含路径片段，已拒绝）：${name}。👉 agent 名称必须是单段文件名（不含 /、\\、..），请修改 agent 名称后重试。`,
    )
  }
}

/** 非 ENOENT 的 fs 错误才值得留痕（目录/文件不存在属正常竞态，保持安静）。 */
function isENOENT(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'ENOENT'
}

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
    } catch (e) {
      // RT-3#11 收口：目录读失败静默 continue → agent 从列表消失且零痕迹；
      // ENOENT 是正常竞态保持安静，其余（权限等）留痕供排查
      if (!isENOENT(e)) {
        logger.warn('[agent-crud] failed to read agent directory, its agents are not listed', {
          dir: rawDir,
          error: e instanceof Error ? e.message : String(e),
        })
      }
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
      } catch (e) {
        // scanning: skip unreadable agent files（ENOENT 竞态保持安静，其余留痕）
        if (!isENOENT(e)) {
          logger.warn('[agent-crud] failed to read agent file, skipped from listing', {
            file: filePath,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
    }
  }

  return [...seen.values()]
}

export function writeAgentFile(name: string, content: string): void {
  const agentsDir = getAgentsDir()
  assertSingleSegment(name)
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true })
  const fileName = name.endsWith('.md') ? name : `${name}.md`
  const filePath = join(agentsDir, fileName)
  atomicWrite(filePath, content)
}

export function deleteAgentFile(name: string): boolean {
  const agentsDir = getAgentsDir()
  assertSingleSegment(name)
  const fileName = name.endsWith('.md') ? name : `${name}.md`
  const filePath = join(agentsDir, fileName)
  if (!existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    return true
  } catch (e) {
    // RT-3#11 收口：裸 return false 让删除失败与「不存在」不可区分；
    // ENOENT 竞态安静返 false，其余留痕（含路径与原因）
    if (!isENOENT(e)) {
      logger.warn('[agent-crud] failed to delete agent file', {
        file: filePath,
        error: e instanceof Error ? e.message : String(e),
      })
    }
    return false
  }
}
