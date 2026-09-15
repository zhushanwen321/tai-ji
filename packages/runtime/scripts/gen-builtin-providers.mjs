// prebuild 提取脚本：从 pi-ai catalog 提取 37 个内置 provider 元数据，
// 生成 packages/runtime/src/generated/builtin-providers.json 供运行时零 pi-ai 依赖消费。
//
// 关键 import 路径（已实测）：
// - getBuiltinProviders / getBuiltinModels / builtinProviders → @earendil-works/pi-ai/providers/all
// - findEnvKeys → @earendil-works/pi-ai/compat（providers/all 不导出 findEnvKeys；
//   ./env-api-keys 子路径被 package.json exports 封锁 ERR_PACKAGE_PATH_NOT_EXPORTED，
//   compat 是唯一通过 exports 校验且 re-export findEnvKeys 的入口，见 dist/compat.js:22）

import {
  getBuiltinProviders,
  getBuiltinModels,
  builtinProviders,
  getBuiltinModelDataGeneratedAt,
} from '@earendil-works/pi-ai/providers/all'
import { findEnvKeys } from '@earendil-works/pi-ai/compat'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// re-export 供 scripts/check-pi-sync.mjs S4 快照新鲜度比对调用：守卫必须与 main() 落盘
// 走同一函数，否则守卫侧 `gen.getBuiltinModelDataGeneratedAt?.() ?? snapshot.catalogGeneratedAt`
// 退化为快照自比（恒真死分支），S4 声称的比对失效。
export { getBuiltinModelDataGeneratedAt }

// pi-ai exports 封锁 './package.json' 子路径且仅定义 import 条件（无 "." 主入口、
// createRequire 的 require 条件解析均实测失败），用与头部 import 同语义的
// import.meta.resolve 定位子路径入口，再向上爬包根；校验 name 防止爬出包读到 workspace 根的版本。
// piAiVersion 必须动态取实装版本：写死会在 pi 升级后失真，快照元数据与 catalog 脱节。
// export 供 t10 测试断言「快照 piAiVersion == node_modules 实装版本」，测试不重复实现爬包根逻辑。
export function readPiAiVersion() {
  let dir = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/providers/all')))
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
      if (pkg.name === '@earendil-works/pi-ai') return pkg.version
    } catch {
      // 当前目录无 package.json，继续向上
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error('未定位到 @earendil-works/pi-ai 的 package.json')
    dir = parent
  }
}

// 镜像 pi-ai 0.82.1 dist/env-api-keys.js 的 getApiKeyEnvVars 映射。
// 升级 pi-ai 后 verifyEnvVars() 做双向守卫校验（镜像表 ⊆ pi-ai 且 pi-ai ⊆ 镜像表），
// 任一方向不一致则报错 exit 1。
// 特殊标注：google-vertex 有显式 API key 路径（GOOGLE_CLOUD_API_KEY，envMap 有条目），
// 但主要凭据是 ADC 云凭证，故 authMode 仍为 ambient；amazon-bedrock 纯 ambient（AWS profile/IAM，
// envMap 无条目）为 []；openai-codex 是 oauth-only（envMap 无条目）为 []。
const PROVIDER_ENV_VARS = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  'amazon-bedrock': [],
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  'openai-codex': [],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  'ant-ling': ['ANT_LING_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  huggingface: ['HF_TOKEN'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  baseten: ['BASETEN_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
}

// ambient provider：走云凭证（Google ADC / AWS profile），不消费 env var。
// 显式硬编码为 {google-vertex, amazon-bedrock} 两个云 provider。
// 注意：不能靠 PROVIDER_ENV_VARS[id].length === 0 推断 —— openai-codex 虽 envVars=[]
// 但它是 oauth-only（走 OAuth 流程），不是云凭证，authMode 应为 'oauth'。
const AMBIENT_PROVIDERS = new Set(['google-vertex', 'amazon-bedrock'])

// ============ OAuth config 提取（dist/auth/oauth/<id>.js 源码字符串） ============
//
// pi-ai 的 provider 元数据（catalog）只含 auth.oauth.name，clientId/flow/endpoints/scopes/callbackPort
// 硬编码在各 oauth 实现文件的源码里，本脚本用正则从源码提取（pi-ai 升级后靠
// scripts/gen-builtin-providers.test.ts 回归守卫）。已核实的 6 个 oauth provider 常量名（0.82.1）：
// - anthropic:      CLIENT_ID(base64 混淆)/AUTHORIZE_URL/TOKEN_URL/CALLBACK_PORT/SCOPES
// - github-copilot: CLIENT_ID(base64 混淆)；端点在 getUrls() 函数内模板（domain 默认 github.com）
// - kimi-coding:    CLIENT_ID(明文)/DEFAULT_OAUTH_HOST；端点在函数内模板（oauthHost 默认 DEFAULT_OAUTH_HOST）
// - xai:            XAI_CLIENT_ID/XAI_SCOPE/XAI_DEVICE_CODE_URL/XAI_TOKEN_URL
// - openai-codex:   CLIENT_ID(明文)/AUTH_BASE_URL+AUTHORIZE_URL/TOKEN_URL/DEVICE_USER_CODE_URL/
//                   DEVICE_VERIFICATION_URI 模板字面量；REDIRECT_URI 明文含端口 1455；无 CALLBACK_PORT 常量
// - openrouter:     无 client_id（公开 PKCE flow，token 交换不发送）；listen(0) 动态端口
//
// 定位 dist 目录：package.json 子路径被 exports 封锁（见文件头注释），
// 但 providers/all 是可导入入口（exports 仅含 import 条件，故用 import.meta.resolve 而非 require.resolve），
// 从其解析路径回退两级即 dist/。
export const OAUTH_DIR = join(
  dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/providers/all')))),
  'auth/oauth',
)

// 已知无 client_id 的 oauth provider：公开 PKCE flow，token 交换只发 code/verifier，
// 服务端不校验 client_id。新增此类 provider 必须在此登记，否则缺 clientId 会被 E6 阻断误报。
const NO_CLIENT_ID_PROVIDERS = new Set(['openrouter'])

function extractClientId(src) {
  // ① base64 混淆（`const CLIENT_ID = decode("...")`，decode = atob）
  const b64 = src.match(/const CLIENT_ID = decode\("([^"]+)"\)/)
  if (b64) return Buffer.from(b64[1], 'base64').toString('utf8')
  // ② 明文 CLIENT_ID
  const plain = src.match(/const CLIENT_ID = "([^"]+)"/)
  if (plain) return plain[1]
  // ③ xai 常量名特例（XAI_CLIENT_ID 而非 CLIENT_ID）
  const xai = src.match(/const XAI_CLIENT_ID = "([^"]+)"/)
  if (xai) return xai[1]
  return undefined
}

// 解析模板字面量端点 `${VAR}...`：VAR 的顶层 const 定义优先；
// oauthHost/domain 是函数内变量，特判默认值（kimi 的 DEFAULT_OAUTH_HOST、copilot 的 github.com）。
function resolveTemplateVar(src, varName, prefix, suffix) {
  const def = src.match(new RegExp(`const ${varName} = "([^"]+)"`))
  if (def) return prefix + def[1] + suffix
  if (varName === 'oauthHost') {
    const host = src.match(/const DEFAULT_OAUTH_HOST = "([^"]+)"/)
    if (host) return prefix + host[1] + suffix
  }
  if (varName === 'domain') return prefix + 'https://github.com' + suffix
  return undefined
}

// 按常量名列表提取端点：先纯字符串字面量，再模板字面量（`${VAR}/path`）。
function extractEndpoint(src, constNames) {
  for (const name of constNames) {
    const plain = src.match(new RegExp(`const ${name} = "([^"]+)"`))
    if (plain) return plain[1]
    const tmpl = src.match(new RegExp(`const ${name} = \`([^\`]*)\\$\{([A-Za-z_][A-Za-z0-9_]*)\}([^\`]*)\``))
    if (tmpl) {
      const resolved = resolveTemplateVar(src, tmpl[2], tmpl[1], tmpl[3])
      if (resolved) return resolved
    }
  }
  return undefined
}

// token 端点：常量优先；copilot/kimi 的端点在函数内模板（无顶层 const），特判路径模式 + 默认 host。
function extractTokenUrl(src) {
  const fromConst = extractEndpoint(src, ['TOKEN_URL', 'XAI_TOKEN_URL'])
  if (fromConst) return fromConst
  const copilot = src.match(/`https:\/\/\$\{domain\}\/login\/oauth\/access_token`/)
  if (copilot) return 'https://github.com/login/oauth/access_token'
  const kimi = src.match(/`\$\{oauthHost\}\/api\/oauth\/token`/)
  if (kimi) {
    const host = src.match(/const DEFAULT_OAUTH_HOST = "([^"]+)"/)
    if (host) return `${host[1]}/api/oauth/token`
  }
  return undefined
}

// deviceCode 端点：同上，常量优先 + copilot/kimi 函数内模板特判。
function extractDeviceCode(src) {
  const fromConst = extractEndpoint(src, ['XAI_DEVICE_CODE_URL', 'DEVICE_USER_CODE_URL', 'DEVICE_CODE_URL'])
  if (fromConst) return fromConst
  const copilot = src.match(/`https:\/\/\$\{domain\}\/login\/device\/code`/)
  if (copilot) return 'https://github.com/login/device/code'
  const kimi = src.match(/`\$\{oauthHost\}\/api\/oauth\/device_authorization`/)
  if (kimi) {
    const host = src.match(/const DEFAULT_OAUTH_HOST = "([^"]+)"/)
    if (host) return `${host[1]}/api/oauth/device_authorization`
  }
  return undefined
}

function extractEndpoints(src) {
  const endpoints = {}
  const authorize = extractEndpoint(src, ['AUTHORIZE_URL'])
  if (authorize) endpoints.authorize = authorize
  const token = extractTokenUrl(src)
  if (token) endpoints.token = token
  const deviceCode = extractDeviceCode(src)
  if (deviceCode) endpoints.deviceCode = deviceCode
  const verify = extractEndpoint(src, ['DEVICE_VERIFICATION_URI', 'VERIFICATION_URL'])
  if (verify) endpoints.verify = verify
  return endpoints
}

// scopes 提取（缺失回退 [] 不阻断）：数组字面量 → 字符串常量 → body 字面量（copilot 的 `scope: "read:user"`）。
function extractScopes(src) {
  const arr = src.match(/const (?:SCOPES|SCOPE|XAI_SCOPE) = \[([^\]]*)\]/)
  if (arr) {
    const items = [...arr[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    if (items.length > 0) return items
  }
  const str = src.match(/const (?:SCOPES|SCOPE|XAI_SCOPE) = "([^"]+)"/)
  if (str) return str[1].split(/\s+/).filter(Boolean)
  const body = src.match(/scope: "([^"]+)"/)
  if (body) return body[1].split(/\s+/).filter(Boolean)
  return []
}

// flow 判定：device（import 共享 device-code 流）与 callback（AUTHORIZE_URL 常量）特征组合。
function detectFlow(src) {
  const hasDevice = src.includes('pollOAuthDeviceCodeFlow')
  const hasCallback = src.includes('AUTHORIZE_URL')
  if (hasDevice && hasCallback) return 'both'
  if (hasDevice) return 'device'
  if (hasCallback) return 'callback'
  return undefined
}

// callbackPort 三级提取：① CALLBACK_PORT 常量 ② REDIRECT_URI 字面量 localhost:<port> ③ listen(<port>)。
// ③ 的 0 = 动态端口（openrouter listen(0)），无固定值 → undefined。
function extractCallbackPort(src) {
  const constPort = src.match(/CALLBACK_PORT\s*=\s*(\d+)/)
  if (constPort) return Number(constPort[1])
  const uriPort = src.match(/REDIRECT_URI[^\n]*localhost:(\d+)/)
  if (uriPort) return Number(uriPort[1])
  const listenPort = src.match(/listen\((\d+)\)/)
  if (listenPort) {
    const port = Number(listenPort[1])
    return port === 0 ? undefined : port
  }
  return undefined
}

/**
 * 从 oauth 实现文件源码提取 oauthConfig。纯函数（src 注入），测试用真实文件内容直接断言。
 * 关键字段缺失即 throw：oauth provider 无 clientId（未登记无 clientId）或无 flow ——
 * main() 捕获后 console.error + exit 1（E6 CI 阻断铁律）。
 * scopes/endpoints 缺失是可降级字段，回退不阻断（由调用方按 flow 记 warning）。
 */
export function extractOAuthConfig(id, src) {
  const clientId = extractClientId(src)
  const flow = detectFlow(src)
  if (!clientId && !NO_CLIENT_ID_PROVIDERS.has(id)) {
    throw new Error(
      `[extractOAuthConfig] provider '${id}' 是 oauth provider 但源码中提取不到 clientId（dist/auth/oauth/${id}.js）`,
    )
  }
  if (!flow) {
    throw new Error(
      `[extractOAuthConfig] provider '${id}' 无法判定 oauth flow：源码既无 device 也无 callback 特征（dist/auth/oauth/${id}.js）`,
    )
  }
  return {
    clientId: clientId ?? '',
    noClientId: !clientId,
    flow,
    endpoints: extractEndpoints(src),
    scopes: extractScopes(src),
    callbackPort: extractCallbackPort(src),
  }
}

// 读取实现文件 + 提取；文件缺失同样 throw（oauth provider 必须能提取出配置）。
function extractOAuthConfigFromFile(id) {
  const filePath = join(OAUTH_DIR, `${id}.js`)
  let src
  try {
    src = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(
      `[extractOAuthConfig] provider '${id}' 是 oauth provider 但实现文件缺失：${filePath}（${err.code}）`,
    )
  }
  return extractOAuthConfig(id, src)
}

function deriveAuthMode(provider) {
  if (AMBIENT_PROVIDERS.has(provider.id)) return 'ambient'
  const hasApiKey = !!provider.auth?.apiKey
  const hasOAuth = !!provider.auth?.oauth
  if (hasApiKey && hasOAuth) return 'both'
  if (hasApiKey && !hasOAuth) return 'api_key'
  if (!hasApiKey && hasOAuth) return 'oauth'
  // 理论上不可达：catalog provider 至少有一种 auth 方式
  return 'api_key'
}

// 提取 model 的 11 个字段（design §4.2 / 附录 A.4；pi-ai Model 类型见 dist/types.d.ts:637）。
// id/name/api/baseUrl/reasoning/input/cost/contextWindow/maxTokens 在 pi-ai 是必填；
// thinkingLevelMap/compat 可选——缺省时置 null（保持 11 键恒定，前端契约简单）。
function summarizeModel(m) {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    baseUrl: m.baseUrl ?? '',
    reasoning: m.reasoning,
    input: Array.isArray(m.input) ? m.input : [],
    cost: m.cost ?? null,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens ?? null,
    thinkingLevelMap: m.thinkingLevelMap ?? null,
    compat: m.compat ?? null,
  }
}

/**
 * 从 pi-ai catalog 提取 37 个内置 provider 元数据。纯函数无副作用，供测试与 main 共用。
 * @returns {Array<object>} provider 模板数组（见 contract c1）
 */
export function generateBuiltinProviders() {
  // getBuiltinProviders() 返回 MODELS 的 keys（37 个，自然排除 radius——radius 是 dynamic provider 无静态 catalog）
  const catalogIds = getBuiltinProviders()
  // builtinProviders() 返回完整 provider 对象数组（含 auth/baseUrl，但含 radius 共 38 个），
  // 建立 id -> provider 映射供按需取对象字段
  const providerMap = new Map(builtinProviders().map((p) => [p.id, p]))

  return catalogIds.map((id) => {
    const provider = providerMap.get(id)
    if (!provider) {
      throw new Error(
        `provider '${id}' in catalog (getBuiltinProviders) but missing from builtinProviders() — pi-ai 版本不一致?`,
      )
    }
    const models = getBuiltinModels(id)
    const oauthConfig = provider.auth?.oauth ? extractOAuthConfigFromFile(provider.id) : undefined
    if (oauthConfig) {
      // 端点缺失是可降级字段：warning 不阻断（clientId/flow 缺失已在 extractOAuthConfig throw）
      const expected =
        oauthConfig.flow === 'device'
          ? ['deviceCode', 'token']
          : oauthConfig.flow === 'callback'
            ? ['authorize', 'token']
            : ['authorize', 'token', 'deviceCode']
      const missing = expected.filter((e) => !oauthConfig.endpoints[e])
      if (missing.length > 0) {
        console.warn(
          `[gen-builtin-providers] provider '${id}' oauthConfig 缺端点 ${missing.join('/')}（flow=${oauthConfig.flow}）—— 需调用方运行时发现`,
        )
      }
    }
    return {
      id: provider.id,
      name: provider.name,
      api: models[0]?.api ?? '',
      baseUrl: provider.baseUrl ?? '',
      authMode: deriveAuthMode(provider),
      envVars: PROVIDER_ENV_VARS[id] ?? [],
      oauthSupported: !!provider.auth?.oauth,
      apiKeyName: provider.auth?.apiKey?.name,
      oauthName: provider.auth?.oauth?.name,
      oauthConfig,
      modelCount: models.length,
      models: models.map(summarizeModel),
      logoUrl: '',
    }
  })
}

/**
 * 双向守卫校验 PROVIDER_ENV_VARS 镜像表与 pi-ai findEnvKeys 一致。
 *
 * 方向 1（pi-ai → 镜像表）：对 catalog 每个 provider 调 findEnvKeys，得到 pi-ai 实际识别的
 * 全部 env var 名（probeEnv 用 Proxy——任意属性读都返回真值，等价于「所有变量均已设置」，
 * 见 dist/utils/provider-env.js getProviderEnvValue 的 env?.[name] 访问），镜像表漏配即 M-1 类遗漏。
 * 方向 2（镜像表 → pi-ai）：镜像表有、findEnvKeys 不认识的 = 镜像表错配（pi-ai 改名/删除后残留）。
 * 额外：镜像表条目不在 catalog（孤儿条目）也报错（pi-ai provider 改名后旧条目残留）。
 * 任一不一致 console.error 明确报错 + exit 1（阻断 build）。
 */
export function verifyEnvVars() {
  const catalogIds = getBuiltinProviders()
  const failures = []
  // Proxy env：任意属性读返回真值 → findEnvKeys 返回该 provider 的完整 env var 列表
  const probeEnv = new Proxy({}, { get: () => 'x' })
  for (const id of catalogIds) {
    const actual = findEnvKeys(id, probeEnv) ?? []
    const mirror = PROVIDER_ENV_VARS[id] ?? []
    const missing = actual.filter((v) => !mirror.includes(v)) // pi-ai 有、镜像表漏（M-1 类遗漏）
    const extra = mirror.filter((v) => !actual.includes(v)) // 镜像表有、pi-ai 无（错配）
    if (missing.length > 0 || extra.length > 0) {
      failures.push({ provider: id, missing, extra, actual, mirror })
    }
  }
  // 镜像表条目不在 pi-ai catalog（孤儿）：provider 改名/删除后旧条目残留，同样阻断
  for (const id of Object.keys(PROVIDER_ENV_VARS)) {
    if (!catalogIds.includes(id)) {
      failures.push({ provider: id, orphan: true })
    }
  }
  if (failures.length > 0) {
    for (const f of failures) {
      if (f.orphan) {
        console.error(
          `[verifyEnvVars] provider '${f.provider}' 在镜像表但不在 pi-ai catalog —— 镜像表残留孤儿条目，请移除`,
        )
      } else {
        console.error(
          `[verifyEnvVars] provider '${f.provider}' 镜像表与 pi-ai 不一致：` +
            `镜像表漏配=${JSON.stringify(f.missing)} 镜像表错配=${JSON.stringify(f.extra)} ` +
            `(pi-ai 实际=${JSON.stringify(f.actual)} 镜像表=${JSON.stringify(f.mirror)})`,
        )
      }
    }
    console.error(
      `[verifyEnvVars] ${failures.length} 处不一致 —— PROVIDER_ENV_VARS 镜像表与 pi-ai findEnvKeys 不匹配，` +
        `请确认 pi-ai 实装版本（当前 ${readPiAiVersion()}）是否升级并同步镜像表`,
    )
    process.exit(1)
  }
}

function main() {
  verifyEnvVars()
  let providers
  try {
    providers = generateBuiltinProviders()
  } catch (err) {
    console.error(`[gen-builtin-providers] 提取失败（E6 阻断）：`, err.message ?? err)
    process.exit(1)
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    piAiVersion: readPiAiVersion(),
    // pi-ai 内置 catalog 数据的构建时刻（ms，非本脚本提取时刻）。远程目录 overlay 的
    // lastModified 保护基准：remote lastModified <= 此值 → 内置已更新，忽略该 overlay 条目。
    // 误用 generatedAt（提取时刻恒新）会导致 overlay 永远被忽略。
    catalogGeneratedAt: getBuiltinModelDataGeneratedAt(),
    // 自包含指纹（D3 决策）：由生成端写入，t10 测试断言「快照 providers 内容 == header 指纹」
    // 即可自洽，替代手写基线数字——pi 升级后重生成快照即自洽，测试基线不再是需要人工同步的
    // 第三份数据（0.84.1→0.84.4 升级时 1220→1290 基线失守的直接教训）。
    providerCount: providers.length,
    totalModels: providers.reduce((s, p) => s + p.models.length, 0),
    providers,
  }
  const outPath = fileURLToPath(new URL('../src/generated/builtin-providers.json', import.meta.url))
  mkdirSync(dirname(outPath), { recursive: true })
  // 内容无变化时跳过写入：generatedAt 时间戳随每次运行变化，无条件重写会把
  // prebuild 后的 git status 永久弄脏（merge 流程「未提交变更」gate 永远不过）。
  // providers/piAiVersion/catalogGeneratedAt/指纹 深度相等 → 保留磁盘文件（含旧 generatedAt）不动。
  // 指纹纳入比对：providers 深度相等时指纹必然相等，显式比对是防御——旧格式快照（无指纹字段）
  // 或指纹被破坏的产物不会被误判 same，保证磁盘快照恒满足「内容 == header 指纹」自洽契约。
  try {
    const existing = JSON.parse(readFileSync(outPath, 'utf-8'))
    const sameProviders =
      JSON.stringify(existing.providers) === JSON.stringify(payload.providers) &&
      existing.piAiVersion === payload.piAiVersion &&
      existing.catalogGeneratedAt === payload.catalogGeneratedAt &&
      existing.providerCount === payload.providerCount &&
      existing.totalModels === payload.totalModels
    if (sameProviders) {
      console.log(
        `[gen-builtin-providers] ${providers.length} providers / ${payload.totalModels} models unchanged, skip rewrite -> ${outPath}`,
      )
      return
    }
  } catch {
    // 文件不存在或损坏 → 走写入路径
  }
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
  console.log(`[gen-builtin-providers] wrote ${providers.length} providers -> ${outPath}`)
}

// 仅当直接执行时运行 main（import 时不触发写文件，保证测试可安全 import）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
