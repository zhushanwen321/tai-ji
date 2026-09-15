/**
 * Codex 源真实解析器（W3）—— 读 ~/.codex/config.toml + ~/.codex/auth.json。
 *
 * 数据流：
 *   - config.toml：顶层 model（占位 model id）+ [model_providers.<id>] 表，每表含
 *     name / base_url / env_key / wire_api（responses|chat）/ http_headers。
 *   - auth.json（可选）：{ OPENAI_API_KEY }，作为默认 openai provider 的 key 回退。
 *   合并后构造 ParsedProvider[]，apiKey 明文只进 ParsedProvider（runtime 内存），不进日志。
 *
 * 协议映射（wire_api → pi 终值）：
 *   - wire_api='responses' → openai-responses。
 *   - wire_api='chat'      → openai-completions（chat 已废弃，warning 提示）。
 *   - 其余/缺失            → openai-completions（warning 提示 defaulted）。
 *
 * 安全红线（DM1 / ES5）：
 *   - env_key 只从 process.env 静态查（不执行任何脚本，不读 keychain）。
 *   - apiKey 明文只存在返回的 ParsedProvider[]，绝不进日志/preview 序列化。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as TOML from '@iarna/toml'
import type { PiModelDefinition } from '../../../infra/pi/pi-provider-store.js'
import { logger } from '../../../infra/logger.js'
import type { ParseResult, ParsedProvider } from '../provider-parser.js'
import { assertProviderEntryObject, malformedEntryWarning, warningsOrUndefined } from './parser-entry-helpers.js'

/**
 * Codex config.toml 中 [model_providers.<id>] 表的形状（只取已知字段，未知容忍）。
 */
interface CodexModelProvider {
  name?: string
  base_url?: string
  /** provider 级环境变量名（如 ROUTER_KEY），运行时从 process.env 取值。 */
  env_key?: string
  /** 'responses' | 'chat'（chat 已废弃）。其余值视为未知。 */
  wire_api?: string
  http_headers?: Record<string, string>
}

/** Codex auth.json 形状（可选，仅消费 OPENAI_API_KEY 作为 openai provider 的默认 key）。 */
interface CodexAuthJson {
  OPENAI_API_KEY?: string
}

/** Codex config.toml 顶层形状（只取已知字段，未知容忍）。 */
interface CodexConfig {
  /** 顶层单 model 字段，作为占位 model id（Codex 在 config 里只暴露一个当前 model）。 */
  model?: string
  model_provider?: string
  model_providers?: Record<string, CodexModelProvider>
}

/** 单条目处理上下文（显式传参，无隐式共享状态）。 */
interface CodexEntryContext {
  /** 顶层单 model 字段（占位 model id）。 */
  topModel: string | undefined
  /** auth.json 解析结果（可选文件，缺失时 {}）。 */
  authData: CodexAuthJson
  /** auth.json 解析失败提示（进每个保留 provider 的 _warnings）。 */
  authParseWarning: string | undefined
}

/** wire_api 映射结果：pi 终值协议 + 该条目的映射警告。 */
interface CodexWireApiMapping {
  api: string
  warnings: string[]
}

/**
 * wire_api → pi 终值协议映射（codex 专属文案，逐字节保持）。
 */
function resolveCodexWireApi(wireApi: string | undefined): CodexWireApiMapping {
  if (wireApi === 'responses') {
    return { api: 'openai-responses', warnings: [] }
  }
  if (wireApi === 'chat') {
    return {
      api: 'openai-completions',
      warnings: ['wire_api=chat is deprecated, mapped to openai-completions'],
    }
  }
  return {
    api: 'openai-completions',
    warnings: [`unknown wire_api ${wireApi ?? '(undefined)'}, defaulted to openai-completions`],
  }
}

/** env_key / auth.json 回退的 key 提取结果。 */
interface CodexKeyExtraction {
  apiKey: string | undefined
  apiKeyExtracted: boolean
  warnings: string[]
}

/**
 * env_key 解析 + auth.json OPENAI_API_KEY 回退（codex 安全边界：只静态查 process.env）。
 */
function extractCodexApiKey(
  mp: CodexModelProvider,
  id: string,
  authData: CodexAuthJson,
): CodexKeyExtraction {
  let apiKey: string | undefined
  let apiKeyExtracted = false
  const warnings: string[] = []
  if (mp.env_key) {
    const envValue = process.env[mp.env_key]
    if (envValue) {
      apiKey = envValue
      apiKeyExtracted = true
    } else {
      warnings.push(`env_key ${mp.env_key} not set in environment, apiKey not extracted`)
    }
  }
  // auth.json 的 OPENAI_API_KEY 作为默认 openai provider 的 key（id 含 'openai' 且无 env_key 提取到值）
  if (!apiKey && id.toLowerCase().includes('openai') && authData.OPENAI_API_KEY) {
    apiKey = authData.OPENAI_API_KEY
    apiKeyExtracted = true
  }
  return { apiKey, apiKeyExtracted, warnings }
}

/**
 * 读可选 auth.json（B1 null 兜底；解析失败不阻断 config.toml 解析，返回警告文案）。
 *
 * 安全红线（DM1/ES5）：只记错误消息本身（JSON parse error 是语法错误，不含 key 内容），
 * 绝不记 auth 文件内容 / 解析对象 / 任何 key 值。
 */
function readCodexAuth(codexDir: string): { authData: CodexAuthJson; authParseWarning: string | undefined } {
  let authData: CodexAuthJson = {}
  const authPath = join(codexDir, 'auth.json')
  if (!existsSync(authPath)) return { authData, authParseWarning: undefined }
  try {
    // B1：JSON.parse('null') 成功返回 null，需用 ?? {} 兜底（否则 authData.OPENAI_API_KEY 崩）
    authData = (JSON.parse(readFileSync(authPath, 'utf8')) as CodexAuthJson | null) ?? {}
    return { authData, authParseWarning: undefined }
  } catch (e) {
    // auth.json 解析失败不阻断 config.toml 解析（auth 仅作 openai provider 的 key 回退）。
    // 与 logger.warn 并存，前端可见（W3：模仿 pi-parser 对同类失败的处理）。
    logger.warn('[migration:codex] auth.json parse failed, skipping', {
      error: e instanceof Error ? e.message : String(e),
    })
    return { authData, authParseWarning: 'auth.json parse failed, OPENAI key fallback unavailable' }
  }
}

/**
 * 解析单个 [model_providers.<id>] 条目。
 *
 * null/非对象条目经 assertProviderEntryObject 抛错，由调用方 catch 以同一文案模板
 * 生成顶层警告（与原实现 push-后-continue 的文案逐字节一致）。
 */
function parseCodexProviderEntry(id: string, mpRaw: unknown, ctx: CodexEntryContext): ParsedProvider {
  // B1：null/非对象条目显式跳过（?? {} 仅防 crash，但空对象会走 unknown wire_api 路径污染 warnings）
  assertProviderEntryObject(mpRaw)
  const mp = (mpRaw as CodexModelProvider) ?? {}
  const warnings: string[] = []

  // W3：auth.json 解析失败时把 warning 附加到每个保留的 provider
  if (ctx.authParseWarning) warnings.push(ctx.authParseWarning)

  // wire_api 映射到 pi 终值协议
  const wire = resolveCodexWireApi(mp.wire_api)
  warnings.push(...wire.warnings)

  // env_key 解析 + auth.json 回退（只从 process.env 静态查，不执行任何脚本）
  const key = extractCodexApiKey(mp, id, ctx.authData)
  warnings.push(...key.warnings)

  // 占位 model：Codex config 只暴露顶层单 model 字段，model 列表不完整
  const models: PiModelDefinition[] = []
  if (ctx.topModel) {
    models.push({ id: ctx.topModel, name: ctx.topModel })
    warnings.push('Codex model list incomplete (only top-level model field), please add models manually')
  }

  return {
    name: mp.name ?? id,
    api: wire.api,
    baseUrl: mp.base_url,
    apiKey: key.apiKey,
    headers: mp.http_headers,
    models,
    _sourceName: id,
    _apiKeyExtracted: key.apiKeyExtracted,
    // wave 4：codex 源暂只识别 plaintext/missing 二态（$ENV/!command/oauth 留给后续 wave）
    _credentialType: key.apiKey ? 'plaintext' : 'missing',
    _warnings: warnings,
  }
}

/**
 * 解析 Codex 源（~/.codex/config.toml + 可选 ~/.codex/auth.json）。
 *
 * @param homeDir 用户主目录（绝对路径）。
 * @returns 解析结果；源目录不存在返回 null（前端据此显示「源未安装」）。
 *          parseError 仅在整体性错误（目录存在但 config.toml 缺失 / TOML 损坏）时设置。
 */
export function parseCodexProviders(homeDir: string): ParseResult | null {
  const codexDir = join(homeDir, '.codex')
  if (!existsSync(codexDir)) return null // 源未安装

  const configPath = join(codexDir, 'config.toml')
  if (!existsSync(configPath)) {
    return { providers: [], parseError: 'config.toml not found in ~/.codex' }
  }

  let config: CodexConfig
  try {
    // B1：TOML.parse 一般返回对象，但为防御性编程，用 ?? {} 兜底
    config = (TOML.parse(readFileSync(configPath, 'utf8')) as unknown as CodexConfig | null) ?? {}
  } catch (e) {
    return {
      providers: [],
      parseError: `cannot parse config.toml: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // 读 auth.json（可选，可能不存在；解析失败不阻断整体解析）
  const { authData, authParseWarning } = readCodexAuth(codexDir)

  const topModel = config.model // 顶层单 model 字段
  const providers: ParsedProvider[] = []
  // S5：顶层 warnings 收集器——坏条目的提示进 topWarnings
  const topWarnings: string[] = []
  const entryContext: CodexEntryContext = { topModel, authData, authParseWarning }

  for (const [id, mpRaw] of Object.entries(config.model_providers ?? {})) {
    // B1：单条目 try/catch，单个坏条目（null/非对象）不中断整体解析
    try {
      providers.push(parseCodexProviderEntry(id, mpRaw, entryContext))
    } catch (e) {
      topWarnings.push(malformedEntryWarning(id, e))
    }
  }

  return {
    providers,
    warnings: warningsOrUndefined(topWarnings),
  }
}
