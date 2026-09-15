/**
 * Agent 加载 / CRUD helper（从 config-service.ts 抽出，控 max-lines 500）。
 *
 * 职责：扫描已加载 agent（强制目录 ∪ discovery.json.agentDirs）+ agent 文件读写
 *（deprecated 向后兼容）+ agent 扫描委托。强制目录含 pi 实际路径 <piAgentDir>/agents
 *（pi 重定向后的真实扫描位置）+ ADR 项目/全局逻辑路径。
 *
 * 抽出原因：config-service.ts 超 ESLint max-lines(500)。本模块含 agent 相关方法，
 * 移到本模块后 ConfigService 仅保留单行委托，行为 / 签名 / import 路径零变化
 *（复用 worktree-config-helper 的 accessors 注入模式，依赖经 configStore 参数注入）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentInfo, ScannedAgentInfo } from '@taiji/shared'
import type { IConfigStore } from './ports/config.js'
import { extractFrontmatter, extractDescription } from '../utils/frontmatter.js'
import { expandHome } from '../utils/path-utils.js'
import { scanAgents as scanAgentsImpl } from './scanners/agent-scanner.js'
import { getConfigDir } from '../infra/pi/pi-paths.js'

// ── ADR-0021 §1.1 强制目录（桥接层硬编码注入，不进 discovery.json）──
// 强制·项目（最高优先）> 强制·全局 > 可选（discovery 数组顺序）。
//
// ⚠️ 路径修正：ADR 文档写的逻辑路径是 ~/.taiji/agents 等，但 pi 桥接层把 agentDir
// 重定向到 <dataDir>/agent/（getPiAgentDir SSOT），pi 实际扫的是 <piAgentDir>/agents。故强制目录用 pi
// 实际路径（loadAgents 内 join(configStore.getPiAgentDir(),'agents')），而项目级强制目录
//（.taiji/agents）保留 ADR 逻辑路径（项目相对路径，存在则扫）。
//
// W1：全局强制目录用 getConfigDir() 在 loadAgents 调用时求值——不能是模块加载时的常量：
// 测试在 beforeEach 设 TAIJI_AGENT_DATA_DIR，模块导入早于 beforeEach，模块加载时求值
// 会捕获到缺省 ~/.taiji（env 未设）。getConfigDir 委托 getDataDir 读 env，调用时求值
// 才能跟随实例隔离 / 自定义数据目录切换。
const FORCED_PROJECT_AGENT_DIR = '.taiji/agents'
/** 全局强制 agent 目录：<configDir>/agents（configDir = getConfigDir()，读 env）。 */
const forcedGlobalAgentDir = (): string => join(getConfigDir(), 'agents')

/** Extract name and description from agent markdown frontmatter. */
function parseAgentMd(content: string): { name: string; description: string } {
  const { frontmatter } = extractFrontmatter(content)
  // name 是简单单行键值，inline 提取（不进通用 helper——name 是 agent 专属字段）
  let name = ''
  for (const fl of frontmatter.split('\n')) {
    if (fl.startsWith('name:')) name = fl.slice('name:'.length).trim()
  }
  const description = extractDescription(frontmatter)
  return { name, description }
}

/**
 * 扫描已加载 agent：强制目录（§1.1 层 1-2）∪ discovery.json.agentDirs（层 3）。
 * 多目录扫描经 IConfigStore.listAgentFiles(dirs)（同名按数组顺序去重），转 AgentInfo（目录在 = 启用，ADR §5）。
 *
 * 强制目录含 pi 实际路径 <piAgentDir>/agents（pi 重定向后的真实扫描位置）+ ADR 项目/全局逻辑路径。
 * 纯函数：configStore 经参数注入（原 ConfigService.loadAgents 逐字搬迁）。
 */
export function loadAgents(configStore: IConfigStore, _projectRoot: string): AgentInfo[] {
  const orderedDirs = [
    join(configStore.getPiAgentDir(), 'agents'), // pi 实际路径（最高优先，真实 agent 落点）
    FORCED_PROJECT_AGENT_DIR,
    forcedGlobalAgentDir(),
    ...configStore.getAgentDirs(),
  ].map(expandHome).filter(d => existsSync(d))

  // listAgentFiles(dirs) 已按数组顺序去重（靠前胜出），单来源即生效无需额外 sources
  const files = configStore.listAgentFiles(orderedDirs)
  return files.map(f => {
    const { name, description } = parseAgentMd(f.content)
    // W1：sourceType 从 agent-crud 推断结果读（按 discovered 目录推断，如 ~/.claude/agents → 'claude'），
    // 不再恒 'pi'——否则 Settings Agent 页按 Claude/Agents tab 过滤永远空。
    // ?? 'pi' 兜底：向上兼容旧 entry 无 sourceType 字段。
    const sourceType = f.sourceType ?? 'pi'
    return {
      id: f.name,
      name: name || f.name,
      description: description || '',
      enabled: true, // ADR §5：目录在 = 启用，恒 true
      modelStrategy: 'auto',
      source: sourceType,
      sourceType,
      content: f.content,
      tools: [],
      effective: true,
    }
  })
}

/** No-op: agents are discovered from discovery.json + forced dirs, not independently persisted. */
export function saveAgents(_projectRoot: string, _agents: AgentInfo[]): void {
  // no-op — agent persistence is managed as .md files + discovery.json SSOT (ADR-0021 §1)
}

/** @deprecated ADR-0021 §5 目录级管道：文件级写入已废弃，保留兼容期。新代码用 setAgentDirs。 */
export function upsertAgent(configStore: IConfigStore, agent: AgentInfo): void {
  console.warn('[config-service] upsertAgent is deprecated (ADR-0021 §5). Use setAgentDirs for directory-level config.')
  if (agent.content) {
    configStore.writeAgentFile(agent.name || agent.id, agent.content)
  }
}

/** @deprecated ADR-0021 §5 目录级管道：文件级删除已废弃，保留兼容期。新代码用 setAgentDirs。 */
export function deleteAgent(configStore: IConfigStore, agentId: string): void {
  console.warn('[config-service] deleteAgent is deprecated (ADR-0021 §5). Use setAgentDirs for directory-level config.')
  configStore.deleteAgentFile(agentId)
}

/** 委托 agent-scanner 扫描候选目录（原 ConfigService.scanAgents 逐字搬迁）。 */
export function scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[] {
  return scanAgentsImpl(sources, existingIds)
}
