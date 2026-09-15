/**
 * Settings mock fixture —— 5 菜单的预制数据。
 * 严格镜像 shared/src 类型（ProviderInfo / SkillInfo / AgentInfo）。
 */
import type { ProviderInfo, SkillInfo, AgentInfo, ProviderId } from '@taiji/shared'

/* ── Provider ── */

export const fixtureProviders: ProviderInfo[] = [
  {
    id: 'anthropic' as ProviderId,
    name: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', reasoning: true, contextWindow: 200_000, input: ['text', 'image'] },
      { id: 'claude-opus-4', name: 'Claude Opus 4', reasoning: true, contextWindow: 200_000, input: ['text', 'image'] },
      { id: 'claude-haiku-3.5', name: 'Claude 3.5 Haiku', contextWindow: 200_000, input: ['text', 'image'] },
    ],
  },
  {
    id: 'openai' as ProviderId,
    name: 'OpenAI Compatible',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000, input: ['text', 'image'] },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128_000, input: ['text', 'image'] },
    ],
  },
  {
    id: 'deepseek' as ProviderId,
    name: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [
      { id: 'deepseek-v3', name: 'DeepSeek V3', reasoning: true, contextWindow: 64_000, input: ['text'] },
      { id: 'deepseek-r1', name: 'DeepSeek R1', reasoning: true, contextWindow: 64_000, input: ['text'] },
    ],
  },
  {
    // 本地推理示例（Ollama 等）。pi 不支持 'ollama' 作为 api 标识，
    // 本地模型走 openai-completions + baseUrl 指向本地端点（11434 是 ollama 的 OpenAI 兼容端口）。
    id: 'ollama-local' as ProviderId,
    name: 'Ollama (Local)',
    api: 'openai-completions',
    baseUrl: 'http://localhost:11434/v1',
    apiKeySet: false,
    status: 'not_configured',
    enabled: false,
    models: [],
  },
]

/* ── Skill ── */
// ADR-0021 §5：目录在 = 启用，enabled 恒 true（前端不再渲染文件级开关）。
// effective 标生效（多来源时最高优先那条）；sources 是多来源 badge 链（单来源可省略）。

export const fixtureSkills: SkillInfo[] = [
  { id: 'sk-code-review', name: 'code-review', description: '审查代码变更', enabled: true, source: 'agents', triggers: ['review', '审查代码'], sourcePath: '~/.agents/skills/code-review/SKILL.md', effective: true },
  { id: 'sk-diagnose', name: 'diagnose', description: '诊断 bug 和性能问题', enabled: true, source: 'agents', triggers: ['diagnose', 'debug'], sourcePath: '~/.agents/skills/diagnose/SKILL.md', effective: true },
  { id: 'sk-impeccable', name: 'impeccable', description: '前端界面设计与优化', enabled: true, source: 'claude', triggers: ['impeccable'], sourcePath: '~/.claude/skills/impeccable/SKILL.md', effective: true },
  { id: 'sk-fallow', name: 'fallow', description: '代码库健康分析', enabled: true, source: 'pi', triggers: ['fallow'], sourcePath: '~/.pi/agent/skills/fallow/SKILL.md', effective: true },
  { id: 'sk-tavily', name: 'tavily-web-search', description: '网络搜索', enabled: true, source: 'agents', triggers: ['搜索', 'search'], sourcePath: '~/.agents/skills/tavily-web-search/SKILL.md', effective: true },
  { id: 'sk-batch-tracer', name: 'batch-tracer', description: '批量代码分析', enabled: true, source: 'agents', triggers: ['批量分析'], sourcePath: '~/.agents/skills/batch-tracer/SKILL.md', effective: true },
  { id: 'sk-pi-goal', name: 'pi-goal', description: '目标驱动的任务管理', enabled: true, source: 'piinstall', triggers: ['goal'], sourcePath: '~/.pi/agent/skills/pi-goal/', effective: true },
]

/* ── Agent ── */

export const fixtureAgents: AgentInfo[] = [
  { id: 'ag-worker', name: 'worker', description: '轻量实现 agent，继承父模型', enabled: true, modelStrategy: 'inherit', source: 'agents', effective: true },
  { id: 'ag-reviewer', name: 'reviewer', description: '通用代码审查专家', enabled: true, modelStrategy: 'inherit', source: 'agents', effective: true },
  { id: 'ag-planner', name: 'planner', description: '从上下文和需求创建实施计划', enabled: true, modelStrategy: 'inherit', source: 'agents', effective: true },
  { id: 'ag-oracle', name: 'oracle', description: '高上下文决策一致性守护者', enabled: true, modelStrategy: 'inherit', source: 'claude', effective: true },
  { id: 'ag-scout', name: 'scout', description: '快速代码侦察', enabled: true, modelStrategy: 'inherit', source: 'agents', effective: true },
]

/* ── Extension (MCP) ── */

export interface FixtureExtension {
  name: string
  version: string
  description: string
  enabled: boolean
  tools: string[]
}

export const fixtureExtensions: FixtureExtension[] = [
  { name: 'filesystem', version: '1.0.2', description: 'File system operations via MCP', enabled: true, tools: ['read_file', 'write_file', 'list_directory'] },
  { name: 'github', version: '0.8.1', description: 'GitHub API integration', enabled: true, tools: ['create_issue', 'list_prs', 'get_file_contents'] },
  { name: 'memory', version: '0.6.0', description: 'Persistent memory store', enabled: false, tools: ['save_memory', 'search_memory'] },
]

/** 候选 → ExtensionInfo 形状（mock 模式补全 dirName/path/source，对齐 shared 契约） */
export function toCandidate(c: FixtureExtension) {
  return {
    name: c.name,
    displayName: c.name,
    dirName: c.name,
    version: c.version,
    description: c.description,
    path: `/mock/tmp/${c.name}`,
    enabled: c.enabled,
    source: 'user-installed' as const,
    tools: c.tools,
  }
}

/* ── System (应用偏好) ── */

export interface FixtureSystemSettings {
  locale: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
  themePreset: string
}

export const fixtureSystem: FixtureSystemSettings = {
  locale: 'zh-CN',
  theme: 'dark',
  themePreset: 'cold-blue',
}
