/**
 * passthrough 深合并与保留键剥离（ai-voice-tts 设计 D2 护栏的 driver 侧承载）。
 *
 * 顺序语义（护栏②）：passthrough 先深合并为请求体底，核心字段映射按键深合并后写覆盖到
 * 精确叶子路径——核心叶子恒核心值，同嵌套对象内其余叶子由 passthrough 保留（如 MiniMax
 * voice_setting 下核心的 voice_id+speed 与私有的 vol+emotion 共存）。不整键替换，
 * 无「受保护键清单」可维护（整键保护会把嵌套在保护键内的私有字段静默剥掉）。
 *
 * 剥离（护栏③⑤，merge 前生效）：鉴权与端点类键（authorization / api-key / url 等，
 * passthrough 只进请求体，不碰 header 与 URL）与协议行为类键（本家由 taiji 内部固定，
 * 如 StepFun return_url / stream_format）从 passthrough 顶层剥离，大小写不敏感。
 * 仅剥顶层：嵌套位置的 vendor 私有字段（词典条目内容等）不含注入面，不得误伤。
 *
 * 零字段名知识（护栏①的合并侧）：merge 对 passthrough 键恒等搬运，不做本家字段白名单
 * 过滤——「只消费本家 key」由 service 打包侧结构保证（passthrough = 本家 vendor 子树恒等
 * 搬运，设计 D2），driver 侧外来键原样进请求体、由厂商 4xx 暴露。
 */

/** passthrough 合并策略：每家 driver 一份（保留键全集按家声明）。 */
export interface PassthroughPolicy {
  /** 鉴权与端点类保留键（护栏③；通用全集 + 本家补充，大小写不敏感）。 */
  readonly reservedKeys: readonly string[]
  /** 协议行为类保留键（护栏⑤；本家由 taiji 内部固定，出现即剥离）。 */
  readonly protocolKeys?: readonly string[]
}

/** 鉴权与端点类通用保留键（三家请求体顶层字段均与之无交集，误伤面为零）。 */
export const AUTH_RESERVED_PASSTHROUGH_KEYS = [
  'authorization',
  'api-key',
  'api_key',
  'apikey',
  'base_url',
  'baseurl',
  'url',
  'endpoint',
  'headers',
  'token',
] as const

/** 出厂 policy：仅鉴权保留键（无协议行为键的家直用；有协议键的家自行展开另声明）。 */
export const AUTH_RESERVED_POLICY: PassthroughPolicy = {
  reservedKeys: AUTH_RESERVED_PASSTHROUGH_KEYS,
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** merge 前剥离 passthrough 顶层保留键（护栏③⑤；返回副本，不改动入参）。 */
export function sanitizePassthrough(
  passthrough: Record<string, unknown> | undefined,
  policy: PassthroughPolicy,
): Record<string, unknown> {
  if (!passthrough) return {}
  const reserved = new Set(
    [...policy.reservedKeys, ...(policy.protocolKeys ?? [])].map((key) => key.toLowerCase()),
  )
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(passthrough)) {
    if (reserved.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

/** 按键深合并：override 叶子写覆盖 base，对象键递归共存（数组整体替换，视为叶子值）。 */
export function deepMergeLeaves(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = out[key]
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMergeLeaves(current, value) : value
  }
  return out
}

/**
 * 请求体组装（护栏②顺序语义）：passthrough（已剥离保留键）深合并为底，
 * 核心字段映射按键深合并后写覆盖——核心叶子路径恒核心值，同对象私有叶子保留。
 * 两输入均不被改动（sanitize 与 merge 均产副本）。
 */
export function mergeRequestBody(
  core: Record<string, unknown>,
  passthrough: Record<string, unknown> | undefined,
  policy: PassthroughPolicy,
): Record<string, unknown> {
  return deepMergeLeaves(sanitizePassthrough(passthrough, policy), core)
}
