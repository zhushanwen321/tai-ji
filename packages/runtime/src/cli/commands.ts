/**
 * CLI 命令实现：参数解析 + WS 消息构造 + 响应格式化。
 * 每个命令映射一个 runtime config.* 消息，逻辑单一真值源在 ConfigService。
 */
import { readFileSync } from 'node:fs'
import type { ConnectionTestResultRow } from '@taiji/shared'
import { getSettingsPath } from '../infra/pi/pi-paths.js'
import { rpc } from './ws-client.js'

/** CLI flag 前缀 `--` 的长度，parseArgs slice 剥离它得到 flag 名。 */
const FLAG_PREFIX_LEN = 2
/** `--json` 输出时的 JSON 序列化缩进（沿用全仓 JSON_INDENT = 2 约定）。 */
const JSON_INDENT = 2
/** session id 在 CLI 回显中的截断长度（短前缀便于人眼识别）。 */
const SESSION_ID_DISPLAY_LEN = 8

// ── 参数解析 ──────────────────────────────────

export interface ParsedArgs {
  command: string
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? ''
  const flags: Record<string, string | boolean> = {}

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(FLAG_PREFIX_LEN)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    }
  }

  return { command, flags }
}

// ── 格式化 ────────────────────────────────────

export function formatProviders(
  providers: Array<Record<string, unknown>>,
  options?: { json?: boolean }
): string {
  if (options?.json) {
    return JSON.stringify(providers, null, JSON_INDENT)
  }
  return providers
    .map((p) => {
      const models = (p.models as Array<{ id: string }> | undefined) ?? []
      const modelIds = models.map((m) => m.id).join(', ')
      const keyStatus = p.apiKeySet ? 'key:set' : 'key:none'
      return `  ${p.id}  ${keyStatus}  models: [${modelIds}]`
    })
    .join('\n')
}

export function formatDefaultModel(provider: string, modelId: string): string {
  return `${provider}/${modelId}`
}

// ── 各命令实现（executeCommand case 提取：参数解析 + WS 消息构造 + 响应格式化，
//    错误/成功文案与调用时序逐字节保持）──────────────────────

async function runListProviders(json: boolean): Promise<string> {
  const reply = await rpc<{ providers?: Array<Record<string, unknown>> }>(
    'config.getProviders',
    {}
  )
  const providers = reply.providers ?? []
  if (json) return JSON.stringify(providers, null, JSON_INDENT)
  return formatProviders(providers)
}

function runGetDefaultModel(): string {
  // config.getProviders reply 是 { providers }，不含 defaultModel。
  // defaultModel 只通过 config.defaults 订阅推送（CLI 无订阅），故直接读 settings.json。
  // settings.json 在 getPiAgentDir()（<dataDir>/agent/settings.json），由 getSettingsPath() 返回；
  // 磁盘格式是 { defaultProvider: string, defaultModel: string } 两个独立字符串字段（见 pi-provider-store.ts updateSettingsFields）。
  try {
    const raw = readFileSync(getSettingsPath(), 'utf-8')
    const settings = JSON.parse(raw) as { defaultProvider?: string; defaultModel?: string }
    const dp = settings.defaultProvider
    const dm = settings.defaultModel
    return dp && dm ? `${dp}/${dm}` : 'not set'
  } catch {
    // settings.json 不存在或解析失败 → 未设置默认模型
    return 'not set'
  }
}

async function runSetDefaultModel(flags: Record<string, string | boolean>): Promise<string> {
  const provider = flags.provider as string
  const model = flags.model as string
  if (!provider || !model) {
    throw new Error('Usage: taiji-settings set-default-model --provider <p> --model <m>')
  }
  await rpc('config.setDefaultModel', { provider, modelId: model })
  return `default_model = ${formatDefaultModel(provider, model)}`
}

async function runSwitchSessionModel(flags: Record<string, string | boolean>): Promise<string> {
  const session = flags.session as string
  const provider = flags.provider as string
  const model = flags.model as string
  if (!session || !provider || !model) {
    throw new Error('Usage: taiji-settings switch-session-model --session <id> --provider <p> --model <m>')
  }
  await rpc('model.switch', { sessionId: session, provider, modelId: model })
  return `session ${session.slice(0, SESSION_ID_DISPLAY_LEN)}... model = ${formatDefaultModel(provider, model)}`
}

async function runSetThinking(flags: Record<string, string | boolean>): Promise<string> {
  const session = flags.session as string
  const level = flags.level as string
  if (!session || !level) {
    throw new Error('Usage: taiji-settings set-thinking --session <id> --level <off|minimal|low|medium|high|xhigh>')
  }
  await rpc('session.setThinkingLevel', { sessionId: session, level })
  return `session ${session.slice(0, SESSION_ID_DISPLAY_LEN)}... thinking = ${level}`
}

// ── Phase 2：高危写命令 ──────────────────────────

async function runSetProvider(flags: Record<string, string | boolean>): Promise<string> {
  const name = flags.name as string
  const provider = flags.provider as string
  if (!name || !provider) {
    throw new Error('Usage: taiji-settings set-provider --name <id> --provider <openai|anthropic|google|openrouter>')
  }
  // apiKey 从 stdin 或环境变量读取，禁止 CLI 参数（安全）
  const apiKey = flags['api-key-stdin']
    ? await readStdin()
    : (process.env.TAIJI_AGENT_API_KEY ?? '')
  // 协议（protocol.ts:138）：config.setProvider payload = { providerId } & SetProviderData。
  // SetProviderData（protocol.ts:58）含 apiKey/name/baseUrl/models 等字段；provider 类型走 type 字段。
  const payload: Record<string, unknown> = { providerId: name, type: provider }
  if (apiKey) payload.apiKey = apiKey
  await rpc('config.setProvider', payload)
  return `provider ${name} (${provider}) configured` + (apiKey ? ' [apiKey:set]' : ' [apiKey:unchanged]')
}

async function runSetSkillDirs(flags: Record<string, string | boolean>): Promise<string> {
  const skillDirs = flags['skill-dirs'] as string
  if (!skillDirs) {
    throw new Error('Usage: taiji-settings set-skill-dirs --skill-dirs <path1,path2,...>')
  }
  await rpc('config.setSkillDirs', { dirs: skillDirs.split(',').map(s => s.trim()) })
  return `skill_dirs = ${skillDirs}`
}

async function runSetAgentDirs(flags: Record<string, string | boolean>): Promise<string> {
  const agentDirs = flags['agent-dirs'] as string
  if (!agentDirs) {
    throw new Error('Usage: taiji-settings set-agent-dirs --agent-dirs <path1,path2,...>')
  }
  await rpc('config.setAgentDirs', { dirs: agentDirs.split(',').map(s => s.trim()) })
  return `agent_dirs = ${agentDirs}`
}

async function runDeleteProvider(flags: Record<string, string | boolean>): Promise<string> {
  const name = flags.name as string
  if (!name) {
    throw new Error('Usage: taiji-settings delete-provider --name <id>')
  }
  await rpc('config.deleteProvider', { providerId: name })
  return `provider ${name} deleted`
}

async function runDiscoverModels(flags: Record<string, string | boolean>, json: boolean): Promise<string> {
  // 协议（protocol.ts:453 config.discoverModels）：{ baseUrl, apiKey?, providerType?, providerId?, mode? }。
  // mode 缺省 'discover'（GET /v1/models，向后兼容旧调用方）；`--mode test` = per-协议真实最小
  // 请求（design catalog-provider-field-authority §3.3 D4，排障用），此时只需 --name <providerId>。
  const mode = flags.mode === 'test' ? 'test' : undefined
  if (mode === 'test') return runTestConnections(flags, json)
  // handler（settings-message-handler.ts handleDiscoverModels）把 baseUrl 作为位置参数传给
  // modelService.discoverModelsFromApi(baseUrl, ...)，必填；apiKey 缺省时用 providerId 查已配置 provider。
  const baseUrl = flags['base-url'] as string
  if (!baseUrl) {
    throw new Error(
      'Usage: taiji-settings discover-models --base-url <url> [--name <provider-id>] [--provider <type>] [--api-key-stdin]',
    )
  }
  const providerId = (flags.name as string) || undefined
  const providerType = (flags.provider as string) || undefined
  const apiKey = flags['api-key-stdin']
    ? await readStdin()
    : (process.env.TAIJI_AGENT_API_KEY ?? undefined)
  const payload: Record<string, unknown> = { baseUrl }
  if (providerId) payload.providerId = providerId
  if (providerType) payload.providerType = providerType
  if (apiKey) payload.apiKey = apiKey
  const reply = await rpc<{ models?: Array<{ id: string }>; success?: boolean; error?: string }>(
    'config.discoverModels',
    payload,
  )
  if (reply.success === false) {
    throw new Error(reply.error ?? 'discover failed')
  }
  const models = reply.models ?? []
  if (json) return JSON.stringify(models, null, JSON_INDENT)
  return models.map(m => `  ${m.id}`).join('\n')
}

/** `discover-models --mode test --name <provider-id>`：per-协议真实最小请求结果（排障入口）。 */
async function runTestConnections(flags: Record<string, string | boolean>, json: boolean): Promise<string> {
  // flags 值类型是 string | boolean：--name 缺值时是 true，显式收窄为空串走下方 Usage 报错
  // （比 as string 断言准确 —— true 透传进 RPC payload 的误导性错误信息不会出现）
  const providerId = typeof flags.name === 'string' ? flags.name : ''
  if (!providerId) {
    throw new Error('Usage: taiji-settings discover-models --mode test --name <provider-id> [--json]')
  }
  // baseUrl 在 test 模式被 runtime 忽略（端点走模型级/provider 级回落链），协议类型要求必填故送空串。
  const reply = await rpc<{
    success?: boolean
    error?: string
    results?: ConnectionTestResultRow[]
  }>('config.discoverModels', { baseUrl: '', providerId, mode: 'test' })
  if (reply.success === false) {
    throw new Error(reply.error ?? 'connection test failed')
  }
  const results = reply.results ?? []
  if (json) return JSON.stringify(results, null, JSON_INDENT)
  return results
    .map(r => `  ${r.ok ? 'ok  ' : 'FAIL'} ${r.api}${r.modelId ? `/${r.modelId}` : ''}${r.error ? `  ${r.error}` : ''}`)
    .join('\n')
}

// ── 命令执行 ──────────────────────────────────

export async function executeCommand(args: ParsedArgs): Promise<string> {
  const { command, flags } = args
  const json = flags.json === true

  switch (command) {
    case 'list-providers':
      return runListProviders(json)

    case 'get-default-model':
      return runGetDefaultModel()

    case 'set-default-model':
      return runSetDefaultModel(flags)

    case 'switch-session-model':
      return runSwitchSessionModel(flags)

    case 'set-thinking':
      return runSetThinking(flags)

    case 'set-provider':
      return runSetProvider(flags)

    case 'set-skill-dirs':
      return runSetSkillDirs(flags)

    case 'set-agent-dirs':
      return runSetAgentDirs(flags)

    case 'delete-provider':
      return runDeleteProvider(flags)

    case 'discover-models':
      return runDiscoverModels(flags, json)

    default:
      throw new Error(
        `Unknown command: ${command}\n\nAvailable commands:\n` +
        `  list-providers\n  get-default-model\n  set-default-model\n` +
        `  switch-session-model\n  set-thinking\n` +
        `  set-provider\n  set-skill-dirs\n  set-agent-dirs\n` +
        `  delete-provider\n  discover-models\n` +
        `\ndiscover-models requires --base-url; see --help for details`,
      )
  }
}

/** 从 stdin 读取一行（用于 --api-key-stdin） */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8').trim()
}
