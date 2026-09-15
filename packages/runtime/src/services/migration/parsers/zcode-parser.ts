/**
 * ZCode 源真实解析器（W3）—— 读 ~/.zcode/v2/config.json 的 provider 对象。
 *
 * 数据流：
 *   - config.json：provider id → { name, kind, options: { apiKey, baseURL }, models }。
 *   - kind 映射到 pi 协议：anthropic → anthropic-messages；openai* → openai-completions。
 *   - apiKey：只读 config.json 明文（不读 credentials.json，加密 ES5）。
 *
 * 安全红线（DM1 / ES5）：
 *   - 不读 credentials.json（enc:v1: 加密，不解密）。
 *   - apiKey 明文只存在返回的 ParsedProvider[]，不进日志/preview 序列化。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PiModelDefinition } from '../../../infra/pi/pi-provider-store.js'
import type { ParseResult, ParsedProvider } from '../provider-parser.js'
import { assertProviderEntryObject, malformedEntryWarning, warningsOrUndefined, type ProviderEntryOutcome } from './parser-entry-helpers.js'

/**
 * ZCode config.json 中 provider 条目的形状（只取已知字段，未知容忍）。
 */
interface ZcodeModelDef {
  name?: string
  reasoning?: { enabled?: boolean; variants?: string[]; defaultVariant?: string }
  limit?: { context?: number; output?: number }
  modalities?: { input?: Array<'text' | 'image'>; output?: string[] }
}

interface ZcodeProviderEntry {
  name?: string
  /** 'anthropic' | 'openai' | 'openai-compatible' | 其他 */
  kind?: string
  enabled?: boolean
  options?: { apiKey?: string; baseURL?: string }
  models?: Record<string, ZcodeModelDef>
}

interface ZcodeConfigJson {
  provider?: Record<string, ZcodeProviderEntry>
}

/**
 * 从 ZCode model 的 reasoning.variants 推断 thinkingLevelMap。
 *
 * ZCode 用 variants 数组表示思维级别（如 ['low','medium','high']），与 pi 的
 * thinkingLevelMap（key → value 映射）形状不同。这里做简化直传：variant → variant。
 * 真实场景若需 mapping 由后续 provider-importer / 用户手动调整。
 */
function inferThinkingLevelMap(
  reasoning: ZcodeModelDef['reasoning'],
): Record<string, string | null> | undefined {
  if (!reasoning?.variants || reasoning.variants.length === 0) return undefined
  const map: Record<string, string | null> = {}
  for (const v of reasoning.variants) map[v] = v
  return map
}

/**
 * kind 映射结果（三态互斥）：
 * - anthropic / openai*：api 有值（openai* 附 per-provider 映射提示）。
 * - 未知/缺失 kind：skipWarning 有值，条目被跳过（避免产出无法路由的 provider）。
 */
type ZcodeKindMapping =
  | { api: 'anthropic-messages' | 'openai-completions'; warning?: string }
  | { api: undefined; skipWarning: string }

/**
 * kind → pi 协议映射（zcode 专属文案，逐字节保持）。
 */
function resolveZcodeKind(id: string, kind: string | undefined): ZcodeKindMapping {
  if (kind === 'anthropic') {
    return { api: 'anthropic-messages' }
  }
  if (kind && kind.startsWith('openai')) {
    // openai / openai-compatible 都映射到 openai-completions。
    // 注：openai-compatible 可能实际是 responses 协议，但无法从 kind 区分，默认 completions + warning。
    return {
      api: 'openai-completions',
      warning: `kind=${kind} mapped to openai-completions, verify if responses protocol is needed`,
    }
  }
  // S5：warning 进 topWarnings（原局部 warnings + continue 会丢字符串，用户无感知）
  return { api: undefined, skipWarning: `provider ${id}: unknown kind ${kind ?? '(undefined)'}, skipped` }
}

/**
 * ZCode model defs → PiModelDefinition[]（for...of 风格，与同文件一致）。
 */
function convertZcodeModels(models: Record<string, ZcodeModelDef> | undefined): PiModelDefinition[] {
  const result: PiModelDefinition[] = []
  for (const [modelId, mRaw] of Object.entries(models ?? {})) {
    // B1：model 条目 null/非对象用 ?? {} 兜底
    const m = (mRaw as ZcodeModelDef | null) ?? {}
    result.push({
      id: modelId,
      name: m.name ?? modelId,
      contextWindow: m.limit?.context,
      maxTokens: m.limit?.output,
      reasoning: m.reasoning?.enabled,
      thinkingLevelMap: inferThinkingLevelMap(m.reasoning),
      // S8：modalities.input 映射到 PiModelDefinition.input（直传 ['text','image'] 数组）
      input: m.modalities?.input,
    })
  }
  return result
}

/**
 * 解析 config.json 的单个 provider 条目。
 *
 * null/非对象条目经 assertProviderEntryObject 抛错，由调用方 catch 以同一文案模板
 * 生成顶层警告（与原实现 push-后-continue 的文案逐字节一致）。
 */
function parseZcodeProviderEntry(id: string, entryRaw: unknown): ProviderEntryOutcome<ParsedProvider> {
  // B1：null/非对象条目显式跳过（?? {} 仅防 crash，但空对象会走 unknown kind 路径污染 warnings）
  assertProviderEntryObject(entryRaw)
  const entry = (entryRaw as ZcodeProviderEntry) ?? {}

  const kind = resolveZcodeKind(id, entry.kind)
  if (kind.api === undefined) {
    return { action: 'skip', warning: kind.skipWarning }
  }
  const warnings: string[] = []
  if (kind.warning) warnings.push(kind.warning)

  // key 提取：只 config.json 明文（不读 credentials.json）
  const apiKey = entry.options?.apiKey

  return {
    action: 'keep',
    provider: {
      name: entry.name ?? id,
      api: kind.api,
      baseUrl: entry.options?.baseURL,
      apiKey,
      // S7：传播 enabled 字段（ZCode 禁用的 provider 导入后保持禁用；undefined 原样透传）
      enabled: entry.enabled,
      models: convertZcodeModels(entry.models),
      _sourceName: id,
      _apiKeyExtracted: !!apiKey,
      // wave 4：zcode 源暂只识别 plaintext/missing 二态（$ENV/!command/oauth 留给后续 wave）
      _credentialType: apiKey ? 'plaintext' : 'missing',
      _warnings: warnings,
    },
  }
}

/**
 * 解析 ZCode 源（~/.zcode/v2/config.json）。
 *
 * @param homeDir 用户主目录（绝对路径）。
 * @returns 解析结果；源目录不存在返回 null。parseError 仅在整体性错误时设置。
 */
export function parseZcodeProviders(homeDir: string): ParseResult | null {
  const configPath = join(homeDir, '.zcode', 'v2', 'config.json')
  if (!existsSync(configPath)) return null

  let config: ZcodeConfigJson
  try {
    // B1：JSON.parse('null') 成功返回 null，需用 ?? {} 兜底（否则下方 .provider 崩）
    config = (JSON.parse(readFileSync(configPath, 'utf8')) as ZcodeConfigJson | null) ?? {}
  } catch (e) {
    return {
      providers: [],
      parseError: `cannot parse zcode config.json: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const providers: ParsedProvider[] = []
  // S5：顶层 warnings 收集器——丢弃的 provider（未知 kind / 坏条目）的提示进 topWarnings
  const topWarnings: string[] = []
  for (const [id, entryRaw] of Object.entries(config.provider ?? {})) {
    // B1：单条目 try/catch，单个坏条目（null/非对象）不中断整体解析
    try {
      const outcome = parseZcodeProviderEntry(id, entryRaw)
      if (outcome.action === 'skip') {
        topWarnings.push(outcome.warning)
      } else {
        providers.push(outcome.provider)
      }
    } catch (e) {
      topWarnings.push(malformedEntryWarning(id, e))
    }
  }

  return {
    providers,
    warnings: warningsOrUndefined(topWarnings),
  }
}
