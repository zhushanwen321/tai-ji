/**
 * Composer 工具区浮层 + progress-zone 的纯内存 fixture。
 *
 * 对应设计稿：
 * - draft-composer-states.html §2a–§2f（上下文容量 / 模型分组 / 思考 6 级 /
 *   @ 引用 / # 文件 / / 命令 / 已附上下文条目）
 * - draft-companion-zones.html §1（progress-zone idle / running / done 三态）
 *
 * 纯数据：不依赖 vue/runtime，无副作用。全部 named export，无 default export。
 * token 数用原始数值（如 69000），不用字符串。
 */
import type { ModelInfo, ProviderId } from '@taiji/shared'

// ── 1. 模型列表（provider 分组，平铺单层） ──────────────────────────────
export interface MockModel {
  id: string
  name: string
  /** provider 显示名（与 providerId 区分，模拟 runtime 的 providerName）。 */
  provider: string
  /** provider 机器标识（小写，模拟 runtime 的 providerId）。 */
  providerId: string
  providerColor: string
  tag?: string
}

/** MockModel → shared ModelInfo（runtime aggregateModels 生产的 providerId/providerName 版）。
 *  mock 显式区分 providerId（机器标识，小写）与 provider（显示名），与 runtime 真实数据一致——
 *  避免旧实现把显示名同时赋给两者，掩盖 id/name 混淆（G4）。
 *  providerColor/tag 是纯 UI 关注点（runtime 不下发），由组件侧本地映射，不进 ModelInfo。 */
export function mockModelToInfo(m: MockModel): ModelInfo {
  return {
    id: m.id,
    name: m.name,
    // mock 数据为可信 fixture（类比反序列化边界，design D5）→ as ProviderId
    providerId: m.providerId as ProviderId,
    providerName: m.provider,
    reasoning: false,
    enabled: true,
  }
}

export const MOCK_MODELS: MockModel[] = [
  // Anthropic
  { id: 'claude-sonnet-4.5', name: 'claude-sonnet-4.5', provider: 'Anthropic', providerId: 'anthropic', providerColor: '#d97757', tag: '推荐' },
  { id: 'claude-opus-4.1', name: 'claude-opus-4.1', provider: 'Anthropic', providerId: 'anthropic', providerColor: '#d97757' },
  { id: 'claude-haiku-4.5', name: 'claude-haiku-4.5', provider: 'Anthropic', providerId: 'anthropic', providerColor: '#d97757' },
  // OpenAI
  { id: 'gpt-5', name: 'gpt-5', provider: 'OpenAI', providerId: 'openai', providerColor: '#10a37f' },
  { id: 'gpt-5-mini', name: 'gpt-5-mini', provider: 'OpenAI', providerId: 'openai', providerColor: '#10a37f' },
  // Google
  { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', provider: 'Google', providerId: 'google', providerColor: '#4285f4' },
]

// ── 2. 思考等级 6 级 ───────────────────────────────────────────────────
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface MockThinkingLevel {
  level: ThinkingLevel
  label: string
  en: string
  available: boolean
}

export const MOCK_THINKING_LEVELS: MockThinkingLevel[] = [
  { level: 'off', label: '关', en: 'off', available: true },
  { level: 'low', label: '低', en: 'low', available: true },
  { level: 'medium', label: '中', en: 'medium', available: true },
  { level: 'high', label: '高', en: 'high', available: true },
  { level: 'xhigh', label: '极高', en: 'xhigh', available: true },
  { level: 'max', label: '最高', en: 'max', available: true },
]

// ── 3. 上下文容量统计（§2a） ────────────────────────────────────────────
export interface MockContextStats {
  used: number
  total: number
  percent: number
  cacheHit: number
  modelId: string
}

export const MOCK_CONTEXT_STATS: MockContextStats = {
  used: 69000,
  total: 1000000,
  percent: 6.9,
  cacheHit: 98.7,
  modelId: 'claude-sonnet-4.5',
}

// ── 4. @ 引用候选（文件 / 符号 / 技能）（§2d @） ────────────────────────
export interface MentionCandidate {
  id: string
  name: string
  kind: string
  icon: string
  path?: string
}

export const MENTION_CANDIDATES: MentionCandidate[] = [
  { id: 'mention-auth-service', name: 'AuthService.ts', kind: '文件', icon: 'file', path: 'src/auth/AuthService.ts' },
  { id: 'mention-token-validator', name: 'TokenValidator', kind: '符号', icon: 'symbol' },
  { id: 'mention-form-validation', name: '表单校验规范', kind: '技能', icon: 'skill' },
  { id: 'mention-token-file', name: 'token.ts', kind: '文件', icon: 'file', path: 'src/auth/token.ts' },
]

// ── 5. # 文件候选（文件 / 目录）（§2d #） ───────────────────────────────
export interface FileCandidate {
  id: string
  name: string
  kind: string
  path?: string
}

export const FILE_CANDIDATES: FileCandidate[] = [
  { id: 'file-src-auth', name: 'src/auth/', kind: '目录', path: 'src/auth/' },
  { id: 'file-auth-service', name: 'AuthService.ts', kind: '文件', path: 'src/auth/AuthService.ts' },
  { id: 'file-token', name: 'token.ts', kind: '文件', path: 'src/auth/token.ts' },
]

// 保留旧名兼容（避免改动所有引用方），指向新名
export type MockMentionItem = MentionCandidate
export type MockFileItem = FileCandidate
export const MOCK_MENTIONS = MENTION_CANDIDATES
export const MOCK_FILES = FILE_CANDIDATES

// ── 6. / 斜杠命令候选（§2d /） ──────────────────────────────────────────
export interface MockSlashCommand {
  id: string
  name: string
  kind: string
  icon: 'terminal' | 'star' | 'wrench'
}

export const MOCK_SLASH_COMMANDS: MockSlashCommand[] = [
  { id: 'cmd-commit', name: '/commit', kind: '提交', icon: 'terminal' },
  { id: 'cmd-review', name: '/review', kind: '审查', icon: 'star' },
  { id: 'cmd-fix', name: '/fix', kind: '修复', icon: 'wrench' },
]

// ── 7. 已附上下文条目（§2f） ───────────────────────────────────────────
export interface MockAttachedContext {
  id: string
  name: string
  type: '@' | '#' | 'image'
  meta: string
  icon: 'file' | 'image'
}

export const MOCK_ATTACHED_CONTEXT: MockAttachedContext[] = [
  { id: 'ctx-auth-service', name: 'AuthService.ts', type: '@', meta: '1.2万', icon: 'file' },
  { id: 'ctx-token', name: 'src/auth/token.ts', type: '#', meta: '0.8万', icon: 'file' },
  { id: 'ctx-login-flow', name: 'login-flow.png', type: 'image', meta: '4.9万', icon: 'image' },
]

// ── 8. progress-zone todo 列表（三态各一份，draft-companion-zones §1） ─
export type TodoStatus = 'pending' | 'active' | 'done'

export interface MockTodo {
  id: string
  label: string
  status: TodoStatus
  pct?: number
}

export interface MockProgressState {
  phase: 'idle' | 'running' | 'done'
  title: string
  step: string
  summaryPct: number
  todos: MockTodo[]
}

const PROGRESS_TITLE = '重构 auth 模块'

export const MOCK_PROGRESS_STATES: {
  idle: MockProgressState
  running: MockProgressState
  done: MockProgressState
} = {
  idle: {
    phase: 'idle',
    title: PROGRESS_TITLE,
    step: '待开始 · 0/5 步',
    summaryPct: 0,
    todos: [
      { id: 'todo-1', label: '抽离 UserRepository', status: 'pending' },
      { id: 'todo-2', label: '拆分 TokenValidator', status: 'pending' },
      { id: 'todo-3', label: '重构 token 验证逻辑', status: 'pending' },
    ],
  },
  running: {
    phase: 'running',
    title: PROGRESS_TITLE,
    step: '第 3/5 步',
    summaryPct: 60,
    todos: [
      { id: 'todo-1', label: '抽离 UserRepository', status: 'done' },
      { id: 'todo-2', label: '重构 token 验证逻辑', status: 'active', pct: 60 },
      { id: 'todo-3', label: '更新所有调用方', status: 'pending' },
    ],
  },
  done: {
    phase: 'done',
    title: PROGRESS_TITLE,
    step: '已完成 · 5/5 步',
    summaryPct: 100,
    todos: [
      { id: 'todo-1', label: '抽离 UserRepository', status: 'done' },
      { id: 'todo-2', label: '重构 token 验证逻辑', status: 'done' },
      { id: 'todo-3', label: '跑全量测试', status: 'done' },
    ],
  },
}
