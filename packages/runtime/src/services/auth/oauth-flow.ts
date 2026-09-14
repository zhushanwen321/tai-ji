/**
 * OAuth login flow 编排（路径 B 自实现，slice design I1/T5）。
 *
 * 按 builtin-providers.json 的 oauthConfig 参数化驱动，不手维护 provider 静态数据：
 * - device flow：起始 POST /device/code → 推 deviceCode 事件 → RFC 8628 轮询 → token
 * - callback flow：本地 http server → 推 authUrl → 收 code → PKCE exchange → token
 *
 * provider 差异（expires 公式 / 非标协议 / 两段式）内聚在本文件的 PROVIDER_RULES
 * 表 + 特判分支，语义对齐 pi-ai 0.82.1 dist/auth/oauth/*.js（skew / openai-codex
 * device_auth_id 协议 / github-copilot 两段式 / openrouter 永久 key）。
 *
 * 安全红线：access/refresh token 禁止 console.log / 进错误消息（auth.json 是 0600
 * 凭据文件，runtime 日志会落盘，泄露即凭据泄露）。
 */
import { randomUUID } from 'node:crypto'
import { generateChallenge, generateVerifier } from './pkce.js'
import { runDeviceCodeFlow, type DevicePollResult } from './device-code-flow.js'
import { startCallbackServer } from './callback-server.js'
import type { OAuthCredential } from './auth-storage.js'
import type { BuiltinOAuthConfig } from '@xyz-agent/shared'

// ── 事件钩子：flow 中间态经此推给调用方（AuthService 转 WS 事件）──

export interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn?: number
  interval?: number
}

export interface OAuthFlowHooks {
  onDeviceCode?: (info: DeviceCodeInfo) => void
  onAuthUrl?: (info: { url: string; callbackPort?: number }) => void
}

// ── provider 差异表 ────────────────────────────────────────────
// expires 公式：expires = Date.now() + expiresIn*1000 - skewMs（毫秒 epoch，pi resolveStoredOAuth
// 比较 Date.now() >= expires）。skew 提前 5min 刷新，避免 token 在请求中途死亡。

/** 秒 → 毫秒换算（token 响应的 expires_in / expires_at 均为 epoch 秒） */
const MS_PER_SECOND = 1_000
/** token 到期前 5min（5 * 60s）提前视为过期的刷新窗口：见上方 skew 语义说明 */
const TOKEN_REFRESH_SKEW_MS = 300_000

interface ExpiresRule {
  /** token 到期前提前多少 ms 视为过期（刷新窗口） */
  skewMs: number
  /** 响应缺 expires_in 时的兜底秒数（xai 实测不返回） */
  defaultExpiresIn?: number
  /** true 时 expires 来自响应字段 expires_at（epoch 秒），如 github-copilot */
  epochSeconds?: boolean
}

const PROVIDER_RULES: Record<string, ExpiresRule> = {
  anthropic: { skewMs: TOKEN_REFRESH_SKEW_MS },
  xai: { skewMs: TOKEN_REFRESH_SKEW_MS, defaultExpiresIn: 3_600 },
  'kimi-coding': { skewMs: 0 },
  'openai-codex': { skewMs: 0 },
  'github-copilot': { skewMs: TOKEN_REFRESH_SKEW_MS, epochSeconds: true },
}

const DEFAULT_RULE: ExpiresRule = { skewMs: 0 }

/** 授权窗口兜底秒数：device 响应缺 expires_in 时（RFC 8628 允许） */
const DEFAULT_DEVICE_TIMEOUT_SECONDS = 900

// ── HTTP 工具 ──────────────────────────────────────────────────

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/** form 编码 POST，返回解析后的 JSON 对象（非 2xx 不抛——调用方读 status 分支） */
async function postForm(url: string, fields: Record<string, string>, signal: AbortSignal, timeoutMs?: number): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields),
    signal: timeoutMs !== undefined ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal,
  })
  return parseJsonResponse(response)
}

/** JSON 编码 POST */
async function postJson(url: string, body: unknown, signal: AbortSignal, timeoutMs?: number): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: timeoutMs !== undefined ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal,
  })
  return parseJsonResponse(response)
}

async function parseJsonResponse(response: Response): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  let body: Record<string, unknown> = {}
  try {
    const parsed = (await response.json()) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch {
    // 非 JSON 响应（HTML 错误页等）：body 保持空，调用方按 status 处理。
    // debug 级（prod info 过滤）：降级路径不刷屏，dev 排查网关错误页时可见
    console.debug(`[oauth-flow] non-JSON response body (HTTP ${response.status}), treating as empty`)
  }
  return { ok: response.ok, status: response.status, body }
}

function requireString(body: Record<string, unknown>, field: string, what: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${what} response missing field: ${field}`)
  }
  return value
}

function requirePositiveNumber(body: Record<string, unknown>, field: string, what: string): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${what} response missing field: ${field}`)
  }
  return value
}

/** 验证 URI 只允许 http(s)——防恶意响应让「打开浏览器」启动任意协议 */
function trustedHttpUrl(raw: string, what: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Untrusted ${what} in OAuth response`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Untrusted ${what} in OAuth response`)
  }
  return url.href
}

// ── 标准 device flow（xai / kimi-coding）────────────────────────

interface DeviceAuthInfo {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  intervalSeconds?: number
  expiresInSeconds?: number
}

/**
 * RFC 8628 §3.1 device authorization 起始请求。
 * xai 特判：请求体带 referrer:"pi"（服务端要求，缺失返回 400）。
 */
async function startDeviceAuthorization(providerId: string, config: BuiltinOAuthConfig, signal: AbortSignal): Promise<DeviceAuthInfo> {
  const fields: Record<string, string> = { client_id: config.clientId }
  if (config.scopes.length > 0) fields.scope = config.scopes.join(' ')
  if (providerId === 'xai') fields.referrer = 'pi'
  const { ok, status, body } = await postForm(config.endpoints.deviceCode!, fields, signal, TOKEN_EXCHANGE_TIMEOUT_MS)
  if (!ok) {
    throw new Error(`OAuth device authorization failed (HTTP ${status})`)
  }
  const interval = body.interval
  const expiresIn = body.expires_in
  return {
    deviceCode: requireString(body, 'device_code', 'device authorization'),
    userCode: requireString(body, 'user_code', 'device authorization'),
    verificationUri: trustedHttpUrl(requireString(body, 'verification_uri', 'device authorization'), 'verification URI'),
    verificationUriComplete: typeof body.verification_uri_complete === 'string' && body.verification_uri_complete.length > 0
      ? trustedHttpUrl(body.verification_uri_complete, 'verification URI')
      : undefined,
    intervalSeconds: typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : undefined,
    expiresInSeconds: typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : undefined,
  }
}

/** RFC 8628 §3.3 token 轮询的通用 poll 实现（form 编码，标准错误码分支） */
function standardDevicePoll(
  tokenUrl: string,
  clientId: string,
  deviceCode: string,
  signal: AbortSignal,
): (attempt: number) => Promise<DevicePollResult> {
  return async () => {
    // device flow 单次请求超时（MF-3）：fetch 挂起/网络错误时转结构化 failed，避免穿透成裸 throw
    let tokenRes: { ok: boolean; status: number; body: Record<string, unknown> }
    try {
      tokenRes = await postForm(tokenUrl, {
        grant_type: DEVICE_GRANT,
        client_id: clientId,
        device_code: deviceCode,
      }, signal, TOKEN_EXCHANGE_TIMEOUT_MS)
    } catch (err) {
      if (signal.aborted) throw err
      return { status: 'failed', message: 'OAuth device token request timed out' }
    }
    const { ok, body } = tokenRes
    if (ok) {
      return { status: 'complete', value: body }
    }
    const error = typeof body.error === 'string' ? body.error : undefined
    if (error === 'authorization_pending') return { status: 'pending' }
    if (error === 'slow_down') {
      const interval = body.interval
      return { status: 'slow_down', intervalSeconds: typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : undefined }
    }
    if (error === 'access_denied' || error === 'authorization_denied') {
      return { status: 'failed', message: 'OAuth device authorization was denied' }
    }
    if (error === 'expired_token') {
      return { status: 'failed', message: 'OAuth device code expired' }
    }
    const description = typeof body.error_description === 'string' ? `: ${body.error_description}` : ''
    return { status: 'failed', message: `OAuth device token request failed (HTTP ${error ? `${error}${description}` : 'unknown error'})` }
  }
}

/** 从 token 响应构造 credential（expires 公式按 PROVIDER_RULES） */
function credentialFromTokenResponse(providerId: string, body: Record<string, unknown>, previousRefreshToken?: string): OAuthCredential {
  const access = requireString(body, 'access_token', 'token')
  // 部分 provider（xai）refresh 时可能不轮换 refresh_token——缺失时沿用旧值
  const refresh = body.refresh_token === undefined && previousRefreshToken
    ? previousRefreshToken
    : requireString(body, 'refresh_token', 'token')
  return credentialFromTokenFields(providerId, body, access, refresh)
}

function credentialFromTokenFields(
  providerId: string,
  body: Record<string, unknown>,
  accessToken: string | undefined,
  refreshToken: string | undefined,
): OAuthCredential {
  const rule = PROVIDER_RULES[providerId] ?? DEFAULT_RULE
  const access = accessToken ?? requireString(body, 'access_token', 'token')
  const refresh = refreshToken ?? requireString(body, 'refresh_token', 'token')
  let expires: number
  if (rule.epochSeconds) {
    expires = requirePositiveNumber(body, 'expires_at', 'token') * MS_PER_SECOND - rule.skewMs
  } else {
    const expiresIn = body.expires_in === undefined ? rule.defaultExpiresIn : (body.expires_in as number)
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('token response missing field: expires_in')
    }
    expires = Date.now() + expiresIn * MS_PER_SECOND - rule.skewMs
  }
  return { type: 'oauth', access, refresh, expires }
}

/**
 * 标准 RFC 8628 device flow（xai / kimi-coding）。
 * waitBeforeFirstPoll：浏览器授权页打开需要时间，先等一轮再轮询。
 */
/** 轮询节奏注入（测试用：小值免真实睡眠；生产不传走 RFC 8628 缺省） */
export interface OAuthPollTuning {
  /** 轮询间隔下限 ms（device-code-flow 缺省 1_000，RFC 8628 §3.2） */
  minIntervalMs?: number
  /** slow_down 且服务器无 interval 时的增量 ms（缺省 5_000，RFC 8628 §3.5） */
  slowDownIncrementMs?: number
}

async function runStandardDeviceFlow(providerId: string, config: BuiltinOAuthConfig, hooks: OAuthFlowHooks, signal: AbortSignal, tuning?: OAuthPollTuning): Promise<OAuthCredential> {
  const device = await startDeviceAuthorization(providerId, config, signal)
  hooks.onDeviceCode?.({
    userCode: device.userCode,
    verificationUri: device.verificationUriComplete ?? device.verificationUri,
    verificationUriComplete: device.verificationUriComplete,
    expiresIn: device.expiresInSeconds,
    interval: device.intervalSeconds,
  })
  const result = await runDeviceCodeFlow({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds ?? DEFAULT_DEVICE_TIMEOUT_SECONDS,
    waitBeforeFirstPoll: true,
    signal,
    minIntervalMs: tuning?.minIntervalMs,
    slowDownIncrementMs: tuning?.slowDownIncrementMs,
    poll: standardDevicePoll(config.endpoints.token!, config.clientId, device.deviceCode, signal),
  })
  if (!result.ok) {
    throw new Error(result.reason === 'timeout' ? 'OAuth device code expired' : (result.message ?? 'OAuth login cancelled'))
  }
  return credentialFromTokenResponse(providerId, result.value as Record<string, unknown>)
}

// ── github-copilot 两段式 device flow ──────────────────────────
// 第一段：RFC 8628 换 GitHub access_token；第二段：用 GitHub token 换 Copilot token
// （api.github.com/copilot_internal/v2/token），expires_at 是 epoch 秒。

// GitHub Copilot API 要求的伪浏览器 UA 头（pi-ai 同款，缺失返回 401）
const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
}

async function runCopilotDeviceFlow(config: BuiltinOAuthConfig, hooks: OAuthFlowHooks, signal: AbortSignal, tuning?: OAuthPollTuning): Promise<OAuthCredential> {
  // 起始请求带 UA（GitHub 对裸请求返回 422）
  const device = await (async () => {
    const fields: Record<string, string> = { client_id: config.clientId, scope: 'read:user' }
    const response = await fetch(config.endpoints.deviceCode!, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...COPILOT_HEADERS,
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]),
    })
    const { ok, status, body } = await parseJsonResponse(response)
    if (!ok) {
      throw new Error(`OAuth device authorization failed (HTTP ${status})`)
    }
    const interval = body.interval
    return {
      deviceCode: requireString(body, 'device_code', 'device authorization'),
      userCode: requireString(body, 'user_code', 'device authorization'),
      verificationUri: trustedHttpUrl(requireString(body, 'verification_uri', 'device authorization'), 'verification URI'),
      intervalSeconds: typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : undefined,
      expiresInSeconds: typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0 ? (body.expires_in as number) : undefined,
    }
  })()

  hooks.onDeviceCode?.({
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    expiresIn: device.expiresInSeconds,
    interval: device.intervalSeconds,
  })

  // 第一段轮询：GitHub access_token
  const githubResult = await runDeviceCodeFlow({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds ?? DEFAULT_DEVICE_TIMEOUT_SECONDS,
    waitBeforeFirstPoll: true,
    signal,
    minIntervalMs: tuning?.minIntervalMs,
    slowDownIncrementMs: tuning?.slowDownIncrementMs,
    poll: async () => {
      // device flow 单次请求超时（MF-3）：fetch 挂起/网络错误时转结构化 failed
      let response: Response
      try {
        response = await fetch(config.endpoints.token!, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            ...COPILOT_HEADERS,
          },
          body: new URLSearchParams({
            client_id: config.clientId,
            device_code: device.deviceCode,
            grant_type: DEVICE_GRANT,
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]),
        })
      } catch (err) {
        if (signal.aborted) throw err
        return { status: 'failed', message: 'OAuth device token request timed out' }
      }
      const { ok, status, body } = await parseJsonResponse(response)
      if (ok && typeof body.access_token === 'string') {
        return { status: 'complete', value: body.access_token }
      }
      const error = typeof body.error === 'string' ? body.error : undefined
      if (error === 'authorization_pending') return { status: 'pending' }
      if (error === 'slow_down') {
        const interval = body.interval
        return { status: 'slow_down', intervalSeconds: typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : undefined }
      }
      const description = typeof body.error_description === 'string' ? `: ${body.error_description}` : ''
      return { status: 'failed', message: `OAuth device token request failed (HTTP ${status})${error ? `: ${error}${description}` : ''}` }
    },
  })
  if (!githubResult.ok) {
    throw new Error(githubResult.reason === 'timeout' ? 'OAuth device code expired' : (githubResult.message ?? 'OAuth login cancelled'))
  }

  // 第二段：GitHub token → Copilot token
  const copilotResponse = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${String(githubResult.value)}`,
      ...COPILOT_HEADERS,
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]),
  })
  const { ok, status, body } = await parseJsonResponse(copilotResponse)
  if (!ok) {
    throw new Error(`Copilot token exchange failed (HTTP ${status})`)
  }
  const token = requireString(body, 'token', 'Copilot token')
  const expiresAt = requirePositiveNumber(body, 'expires_at', 'Copilot token')
  return {
    type: 'oauth',
    access: token,
    // refresh 存 GitHub token：pi 侧 refresh 用它在 copilot_internal/v2/token 换新 copilot token
    refresh: String(githubResult.value),
    expires: expiresAt * MS_PER_SECOND - (PROVIDER_RULES['github-copilot']?.skewMs ?? 0),
  }
}

// ── openai-codex 非标 device 协议 ───────────────────────────────
// 与 RFC 8628 不同：起始返回 device_auth_id（非 device_code），轮询返回
// { authorization_code, code_verifier }（非直接 token），需二次 exchange。
// 403/404 视为 pending（用户尚未完成授权时服务端返回 403）。

// eslint-disable-next-line no-magic-numbers -- openai-codex 授权窗口 15min（pi-ai DEVICE_CODE_TIMEOUT_SECONDS 同款）
const OPENAI_CODEX_TIMEOUT_SECONDS = 15 * 60
/** 单次 OAuth HTTP 请求超时（pi-ai TOKEN_EXCHANGE_TIMEOUT_MS 同款）：device flow 各出网点 + callback exchange，远端挂起时兜底防无限等待 */
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000

async function runOpenAICodexDeviceFlow(config: BuiltinOAuthConfig, hooks: OAuthFlowHooks, signal: AbortSignal, tuning?: OAuthPollTuning): Promise<OAuthCredential> {
  // 1. 起始：device_auth_id + user_code
  const start = await postJson(config.endpoints.deviceCode!, { client_id: config.clientId }, signal, TOKEN_EXCHANGE_TIMEOUT_MS)
  if (!start.ok) {
    throw new Error(`OAuth device authorization failed (HTTP ${start.status})`)
  }
  const intervalRaw = start.body.interval
  const intervalSeconds = typeof intervalRaw === 'string'
    ? Number(intervalRaw.trim())
    : (typeof intervalRaw === 'number' ? intervalRaw : undefined)
  if (typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error('device authorization response missing field: interval')
  }
  const deviceAuthId = requireString(start.body, 'device_auth_id', 'device authorization')
  const userCode = requireString(start.body, 'user_code', 'device authorization')

  hooks.onDeviceCode?.({
    userCode,
    verificationUri: config.endpoints.verify ?? 'https://auth.openai.com/codex/device',
    expiresIn: OPENAI_CODEX_TIMEOUT_SECONDS,
    interval: intervalSeconds,
  })

  // 2. 轮询：完成时返回 { authorization_code, code_verifier }
  //    轮询端点是 deviceauth/token（与 exchange 端点 oauth/token 不同），
  //    oauthConfig 只提取了 token(exchange) + deviceCode(起始)，轮询端点由
  //    deviceCode 端点同目录派生（/usercode → /token）
  const deviceTokenUrl = new URL(config.endpoints.deviceCode!)
  deviceTokenUrl.pathname = deviceTokenUrl.pathname.replace(/\/[^/]+$/, '/token')
  const pollResult = await runDeviceCodeFlow({
    intervalSeconds,
    expiresInSeconds: OPENAI_CODEX_TIMEOUT_SECONDS,
    signal,
    minIntervalMs: tuning?.minIntervalMs,
    slowDownIncrementMs: tuning?.slowDownIncrementMs,
    poll: async () => {
      // device flow 单次请求超时（MF-3）：fetch 挂起/网络错误时转结构化 failed
      let pollRes: { ok: boolean; status: number; body: Record<string, unknown> }
      try {
        pollRes = await postJson(deviceTokenUrl.toString(), {
          device_auth_id: deviceAuthId,
          user_code: userCode,
        }, signal, TOKEN_EXCHANGE_TIMEOUT_MS)
      } catch (err) {
        if (signal.aborted) throw err
        return { status: 'failed', message: 'OAuth device token request timed out' }
      }
      const { ok, status, body } = pollRes
      if (ok) {
        if (typeof body.authorization_code !== 'string' || typeof body.code_verifier !== 'string') {
          return { status: 'failed', message: 'Invalid device auth token response' }
        }
        return { status: 'complete', value: body }
      }
      // eslint-disable-next-line no-magic-numbers -- 403/404 = 未完成授权（服务端语义），继续轮询
      if (status === 403 || status === 404) return { status: 'pending' }
      const error = typeof body.error === 'object' && body.error !== null
        ? (body.error as Record<string, unknown>).code
        : body.error
      if (error === 'deviceauth_authorization_pending') return { status: 'pending' }
      if (error === 'slow_down') return { status: 'slow_down' }
      return { status: 'failed', message: `OAuth device auth failed with status ${status}` }
    },
  })
  if (!pollResult.ok) {
    throw new Error(pollResult.reason === 'timeout' ? 'OAuth device code expired' : (pollResult.message ?? 'OAuth login cancelled'))
  }

  // 3. 二次 exchange：authorization_code + code_verifier → 正式 token
  //    redirect_uri 固定为 deviceauth/callback（与 client_id 绑定，服务端校验）
  const exchange = await postForm(config.endpoints.token!, {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: String((pollResult.value as Record<string, unknown>).authorization_code),
    code_verifier: String((pollResult.value as Record<string, unknown>).code_verifier),
    redirect_uri: new URL(config.endpoints.deviceCode!).origin + '/deviceauth/callback',
  }, signal, TOKEN_EXCHANGE_TIMEOUT_MS)
  if (!exchange.ok) {
    throw new Error(`OAuth token exchange failed (HTTP ${exchange.status})`)
  }
  return credentialFromTokenResponse('openai-codex', exchange.body)
}

// ── callback flow（anthropic / openrouter）──────────────────────

async function runCallbackFlow(providerId: string, config: BuiltinOAuthConfig, hooks: OAuthFlowHooks, signal: AbortSignal): Promise<OAuthCredential> {
  const verifier = generateVerifier()
  const challenge = await generateChallenge(verifier)

  if (providerId === 'openrouter') {
    // openrouter：无 clientId（noClientId），动态端口 + 一次性路径，token 端点返回永久 key
    const callbackPath = `/oauth/callback/${randomUUID()}`
    const server = await startCallbackServer({ port: 0, path: callbackPath, signal })
    const authorizeUrl = new URL(config.endpoints.authorize!)
    authorizeUrl.search = new URLSearchParams({
      callback_url: server.url,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()
    hooks.onAuthUrl?.({ url: authorizeUrl.toString() })
    try {
      const callback = await server.waitForCallback()
      // token exchange 带 30s 超时（pi-ai openrouter TOKEN_EXCHANGE_TIMEOUT_MS 同款）：
      // 回调已到达但远端 API 挂起时不能无限转圈（本地 loopback 无兜底超时）
      const exchange = await postJson(config.endpoints.token!, {
        code: callback.code,
        code_verifier: verifier,
        code_challenge_method: 'S256',
      }, AbortSignal.any([signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]))
      if (!exchange.ok) {
        throw new Error(`OAuth key exchange failed (HTTP ${exchange.status})`)
      }
      const key = requireString(exchange.body, 'key', 'OAuth key exchange')
      return { type: 'oauth', access: key, refresh: '', expires: Number.MAX_SAFE_INTEGER }
    } finally {
      server.close()
    }
  }

  // anthropic（及默认 callback provider）：固定端口（callbackPort，provider 后台预注册 redirect_uri）。
  // state 用独立随机值（不复用 PKCE verifier）：避免 code+verifier 同现于明文 loopback 回调 URL
  //（浏览器历史/本地代理可记录，泄露 code+verifier 即可兑换 token）。服务端只回显 state，不校验其值。
  const state = randomUUID()
  const server = await startCallbackServer({
    port: config.callbackPort ?? 0,
    path: '/callback',
    expectedState: state,
    signal,
  })
  // redirect_uri 用 localhost（与 pi-ai 参考实现预注册值 http://localhost:53692/callback 一致）：
  // anthropic 授权端点按注册值校验 redirect_uri（RFC 6749 §3.1.2.3），127.0.0.1 未注册会被拒。
  // 监听地址保持 127.0.0.1（不暴露局域网），浏览器 localhost → 127.0.0.1 回环等价可达。
  const redirectUri = new URL(server.url)
  redirectUri.hostname = 'localhost'
  const authParams = new URLSearchParams({
    code: 'true',
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri.toString(),
    scope: config.scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  hooks.onAuthUrl?.({ url: `${config.endpoints.authorize!}?${authParams.toString()}`, callbackPort: server.port })
  try {
    const callback = await server.waitForCallback()
    // token exchange 带 30s 超时（与 openrouter 分支同款）：
    // 回调已到达但远端 API 挂起时不能无限转圈（本地 loopback 无兜底超时）
    const exchange = await postJson(config.endpoints.token!, {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code: callback.code,
      state: callback.state,
      redirect_uri: redirectUri.toString(),
      code_verifier: verifier,
    }, AbortSignal.any([signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]))
    if (!exchange.ok) {
      throw new Error(`OAuth token exchange failed (HTTP ${exchange.status})`)
    }
    return credentialFromTokenResponse(providerId, exchange.body)
  } finally {
    server.close()
  }
}

/**
 * 按 oauthConfig 编排 OAuth login flow，返回可写入 auth.json 的 credential。
 *
 * @param providerId provider id（决定 expires 公式与特判协议分支）
 * @param config 来自 builtin-providers.json 的 oauthConfig
 * @param hooks flow 中间态回调（deviceCode / authUrl）
 * @param signal 取消信号（abort → 停轮询/关 server/抛 Login cancelled）
 */
export async function runOAuthLogin(
  providerId: string,
  config: BuiltinOAuthConfig,
  hooks: OAuthFlowHooks,
  signal: AbortSignal,
  tuning?: OAuthPollTuning,
): Promise<OAuthCredential> {
  // flow='both'（openai-codex）：优先 device（headless 友好，无固定端口占用风险）
  if (providerId === 'openai-codex') {
    return runOpenAICodexDeviceFlow(config, hooks, signal, tuning)
  }
  if (providerId === 'github-copilot') {
    return runCopilotDeviceFlow(config, hooks, signal, tuning)
  }
  if (config.flow === 'device') {
    return runStandardDeviceFlow(providerId, config, hooks, signal, tuning)
  }
  return runCallbackFlow(providerId, config, hooks, signal)
}
