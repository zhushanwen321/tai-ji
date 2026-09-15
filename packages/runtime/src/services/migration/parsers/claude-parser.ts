/**
 * Claude 源真实解析器（W3）—— 读 ~/.claude/settings.json，建占位 provider。
 *
 * Claude Code 的 key 存储位置：
 *   - OS keychain（macOS Keychain / Linux secret service / Windows Credential Manager）。
 *   - apiKeyHelper 脚本（settings.json 里配置，运行时执行取 key）。
 *   - OAuth token（登录态）。
 *
 * 安全红线（DM1 / ES5，恒不提取 key）：
 *   - 不执行 apiKeyHelper（脚本执行 = 任意代码执行，禁止）。
 *   - 不查 keychain（跨平台 + 权限）。
 *   - 不读 .zhipu_auth_token 等本地 token 文件。
 *   - _apiKeyExtracted 恒 false，warning 提示用户导入后手动填。
 *
 * 只提取非敏感元信息：baseUrl（env.ANTHROPIC_BASE_URL）、model（settings.model）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ParseResult, ParsedProvider } from '../provider-parser.js'

/**
 * Claude settings.json 形状（只取已知字段，未知容忍）。
 */
interface ClaudeSettings {
  model?: string
  env?: Record<string, string>
  // apiKeyHelper 存在但绝不执行（安全红线）
  apiKeyHelper?: string
}

/** warning 文案：所有 Claude provider 都带（恒不提取 key 的用户提示）。 */
const KEYCHAIN_WARNING =
  'Claude Code API key is stored in OS keychain, apiKeyHelper script, or OAuth token — cannot extract safely. Please fill the API key manually after import.'

/**
 * 解析 Claude 源（~/.claude/settings.json）。
 *
 * @param homeDir 用户主目录（绝对路径）。
 * @returns 解析结果；源目录不存在返回 null。恒返回 1 个占位 provider。
 */
export function parseClaudeProviders(homeDir: string): ParseResult | null {
  const settingsPath = join(homeDir, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return null

  let settings: ClaudeSettings
  try {
    // B1：JSON.parse('null') 成功返回 null，需用 ?? {} 兜底（否则 settings.env 崩）
    settings = ((JSON.parse(readFileSync(settingsPath, 'utf8')) as ClaudeSettings | null) ?? {}) as ClaudeSettings
  } catch (e) {
    return {
      providers: [],
      parseError: `cannot parse claude settings.json: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const baseUrl = settings.env?.ANTHROPIC_BASE_URL
  const modelId = settings.model ?? 'claude-default'

  // 占位 provider：协议恒 anthropic-messages，apiKey 留空（恒不提取）
  const provider: ParsedProvider = {
    name: 'Claude Code (imported)',
    api: 'anthropic-messages',
    baseUrl,
    // apiKey 不设置（占位，导入后用户手动填）
    models: [{ id: modelId, name: modelId }],
    _sourceName: 'claude-imported',
    _apiKeyExtracted: false, // 恒 false（安全红线 ES5）
    // wave 4：claude 源恒为占位 provider（无 apiKey），credentialType 恒 missing。
    // claude 源暂不识别 $ENV/!command/oauth（Phase 1 范围），留给后续 wave。
    _credentialType: 'missing',
    _warnings: [KEYCHAIN_WARNING],
  }

  return { providers: [provider] }
}
