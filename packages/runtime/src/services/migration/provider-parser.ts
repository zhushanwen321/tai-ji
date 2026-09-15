/**
 * Provider 解析器（DM4）—— 从其他 agent 的源配置解析出 ParsedProvider[]。
 *
 * W3：真实解析器实现位于 ./parsers/（pi-parser / zcode-parser / claude-parser / codex-parser），
 * 本文件只保留类型定义 + dispatcher 路由（薄转发层）。W2 的 Mock fixture 已移除。
 *
 * 安全约束（DM1）：
 *   - 解析出的 apiKey 明文只存在返回的 ParsedProvider[]（runtime 内存），经 preview-cache 暂存，
 *     apply 时写 models.json，**绝不返回前端**（preview 只暴露 apiKeyExtracted 布尔）。
 *   - 源目录不存在返回 null（前端据此显示「源未安装」）。
 *
 * ParsedProvider 结构：
 *   - 继承 PiProviderConfig（models.json provider 配置形状，含 apiKey 明文）。
 *   - 加 5 个 _ 前缀元数据字段（apply 时剥离，不写 models.json）：_sourceName / _apiKeyExtracted /
 *     _credentialType / _envVarName / _warnings（字段语义详见下方 ParsedProvider 接口 JSDoc）。
 */
import type { ProviderSource } from '@taiji/shared'
import type { PiProviderConfig } from '../../infra/pi/pi-provider-store.js'
// 真实解析器（W3）—— 各源配置解析在 ./parsers/ 下
import { parsePiProviders as parsePiProvidersImpl } from './parsers/pi-parser.js'
import { parseZcodeProviders as parseZcodeProvidersImpl } from './parsers/zcode-parser.js'
import { parseCodexProviders as parseCodexProvidersImpl } from './parsers/codex-parser.js'
import { parseClaudeProviders as parseClaudeProvidersImpl } from './parsers/claude-parser.js'

// ── DM4 — 解析器输出（含元数据，apply 时剥离）──────────────────────

/**
 * 解析后的单个 provider（含元数据）。
 *
 * extends PiProviderConfig 以便 apply 时直接透传给 upsertProvider（剥离 _ 字段后）。
 * _ 前缀字段是 runtime 内部元数据，apply 时解构剥离，不写 models.json。
 */
export interface ParsedProvider extends PiProviderConfig {
  /** 源里的 provider 名（如 Pi 的 'deepseek-router'），导入后作 taiji models.json 的 provider id。 */
  _sourceName: string
  /** computed 布尔：_credentialType ∈ plaintext/env/command 时 true（脱敏布尔，preview 用）。 */
  _apiKeyExtracted: boolean
  /** 凭据形态六态（wave 4 import-credential-types，真相源）：
   * - plaintext：明文 key 已提取。
   * - env：$VAR / ${VAR} 占位，_envVarName 记变量名。
   * - env-bundle：api_key 带 env 包，有凭据但 Phase 1 不支持落盘，apiKey 不写。
   * - command：!command 前缀（shell 命令取值，命令注入面）。
   * - oauth：type==='oauth'，Phase 1 不支持。
   * - missing：无任何 key 线索，apiKey 不写。
   */
  _credentialType: 'plaintext' | 'env' | 'env-bundle' | 'missing' | 'oauth' | 'command'
  /** _credentialType==='env' 时的环境变量名（已去 $ / ${} 前缀），其他态为 undefined。 */
  _envVarName?: string
  /** 解析期警告（如「env_key 未设置」「!command 命令注入」「OAuth Phase 2」），preview 逐条展示。 */
  _warnings: string[]
}

/**
 * 单个源解析结果。
 *
 * - providers：解析出的 provider 列表（含 apiKey 明文 + _ 元数据）。
 * - orphanCredentials：孤儿凭据（auth.json 有、models.json 无定义的 providerId，含明文 apiKey，
 *   sa3 F1 · 内置 Provider 模板衔接）。只进 runtime 内存（preview-cache），preview 脱敏。
 * - parseError：解析期致命错误（如文件格式损坏）。有 parseError 时 providers 可能为空或部分。
 * - warnings：顶层警告（如「N 个 provider 因协议不支持被丢弃」「provider X 因格式错误跳过」），
 *   preview 阶段整体展示给用户，与 per-provider `_warnings`（单 provider 维度）区分。
 */
export interface ParseResult {
  providers: ParsedProvider[]
  /**
   * 孤儿凭据：auth.json 里存在、models.json 未定义的 providerId（pi 内置 provider 的凭据）。
   * 含 apiKey 明文（runtime 内部），apply 时匹配内置模板补全定义（B4：不写 models）。
   * 仅 pi-parser 产出；其他源解析器无此概念，省略。
   */
  orphanCredentials?: ParsedOrphanCredential[]
  parseError?: string
  /** 顶层警告（如「N 个 provider 因协议不支持被丢弃」），preview 阶段展示给用户。 */
  warnings?: string[]
}

/**
 * 孤儿凭据（sa3 F1）：auth.json 有、models.json 无定义的 provider 凭据。
 *
 * 安全红线（B.5/DM1）：apiKey 明文只活在 runtime 内存（ParseResult → preview-cache），
 * 与 ParsedProvider 同模式——preview 只暴露 credentialType/envVarName/占位信息，不含 key 值。
 * 六态判定与 ParsedProvider._credentialType 同源（pi-parser 的 classifyCredential 共享函数）。
 */
export interface ParsedOrphanCredential {
  /** auth.json 的 providerId（如 'openai'），导入后作 taiji models.json 的 provider id。 */
  providerId: string
  /** 凭据形态六态（与 ParsedProvider._credentialType 同枚举）。 */
  credentialType: 'plaintext' | 'env' | 'env-bundle' | 'missing' | 'oauth' | 'command'
  /** credentialType==='env' 时的环境变量名（已去 $ / ${} 前缀），其他态为 undefined。 */
  envVarName?: string
  /**
   * 明文 key / $ENV 占位串 / !command 原文（apply 时写 models.json apiKey；
   * env-bundle/oauth/missing 态不写）。绝不进 preview 序列化。
   */
  apiKey?: string
  /** 解析期警告（如「OAuth Phase 2」「!command 命令注入」「env bundle Phase 1 不支持」）。 */
  warnings: string[]
}

// ══════════════════════════════════════════════════════════════════
// 各源解析（W3：薄转发到 ./parsers/ 下的真实实现）
// ══════════════════════════════════════════════════════════════════

/**
 * 解析 Pi 源（~/.pi/agent/models.json + ~/.pi/agent/auth.json）。
 * @see ./parsers/pi-parser.ts
 */
export function parsePiProviders(homeDir: string): ParseResult | null {
  return parsePiProvidersImpl(homeDir)
}

/**
 * 解析 ZCode 源（~/.zcode/v2/config.json）。
 * @see ./parsers/zcode-parser.ts
 */
export function parseZcodeProviders(homeDir: string): ParseResult | null {
  return parseZcodeProvidersImpl(homeDir)
}

/**
 * 解析 Codex 源（~/.codex/config.toml + 可选 auth.json）。
 * @see ./parsers/codex-parser.ts
 */
export function parseCodexProviders(homeDir: string): ParseResult | null {
  return parseCodexProvidersImpl(homeDir)
}

/**
 * 解析 Claude 源（~/.claude/settings.json）。
 * @see ./parsers/claude-parser.ts
 */
export function parseClaudeProviders(homeDir: string): ParseResult | null {
  return parseClaudeProvidersImpl(homeDir)
}

/**
 * 解析器 dispatcher：按 source 路由到对应的解析器。
 *
 * B1：try/catch 兜底——任何 parser 抛异常都转为 `{ providers: [], parseError }` 而非中断
 * 调用方（preview/apply）。未知 source 返回 null（与「源未安装」同处理，前端显示提示）。
 *
 * @param source 迁移源（pi/zcode/codex/claude）。
 * @param homeDir 用户主目录（绝对路径）。
 * @returns 解析结果；源目录不存在返回 null（前端据此显示「源未安装」）。
 */
export function parseProviders(source: ProviderSource, homeDir: string): ParseResult | null {
  try {
    switch (source) {
      case 'pi': return parsePiProviders(homeDir)
      case 'zcode': return parseZcodeProviders(homeDir)
      case 'codex': return parseCodexProviders(homeDir)
      case 'claude': return parseClaudeProviders(homeDir)
      default: return null // 未知 source 返回 null（与「源未安装」同处理，前端显示提示）
    }
  } catch (e) {
    return {
      providers: [],
      parseError: `failed to parse ${source}: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
