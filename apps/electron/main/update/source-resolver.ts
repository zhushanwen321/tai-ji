/**
 * auto 模式源顺序解析器（update-multi-source D4）。
 *
 * 设计：docs/design/update-multi-source.md §6.4（决策 D4）/ §4.2②（检查流中的位置）/
 * §7.2（source-resolver.ts 行）。消费方：ReleaseChecker 构造注入 `{ resolveSourceOrder }`。
 *
 * 决策表（settings 来源偏好 → 源优先级序列）：
 *   - 显式偏好 github/atomgit → [该源, 对侧]（偏好语义 = 优先级而非独占，D3：
 *     降级到对侧的能力恒在，本模块只决定顺序）
 *   - auto + 解析出代理 URL → [github, atomgit]（代理短路：能配代理 = github 可达
 *     概率高，跳过探测省一次网络往返，目标 2「代理用户零额外延迟」）
 *   - auto + 无代理 → 并行探测两主域，可达者排前、均可达 github 优先（tie-break）、
 *     均不可达回退 [github, atomgit]（= 现状单源行为，不比现状差）
 *
 * 探测方法与判定语义（D4 关键细节）：
 *   - 不用 HEAD——本仓 sync 脚本实测「GitCode 禁 HEAD，用 GET Range 206」，HEAD 对
 *     gitcode.com 可能 405/拒绝；GET + `Range: bytes=0-0` 是两主域通用验证形态
 *   - 可达判定 = 任何完成的 HTTP 响应即可达（含非 2xx——探测目的是「链路通」而非
 *     「内容对」），对齐 testProxyConnection 既有准绳（gateway/update-handlers.ts）：
 *     undici 引擎任何 resolve 即成功；curl 引擎携带 httpStatusCode 的 CurlFetchError
 *     同样算可达（isCurlHttpStatusError），双引擎判定等价；其余失败（超时/连接错误）
 *     = 不可达
 *   - 探测必须传 disableFlagPersistence: true（对齐 testProxy D5 先例）——探测失败
 *     不得翻转进程级下载引擎偏好，污染后续真实下载编排
 *
 * 探测结果进程内 TTL 缓存 1h（与检查缓存同量级），缓存命中不重复探测；显式偏好与
 * 代理短路路径不消费缓存（零网络成本直接映射，偏好/代理状态变化即时生效——偏好
 * 切换的完整生效时延由 checker 层检查缓存决定，§6.3，不在本模块）。
 *
 * S2 验收观测面：getLastProbeOutcome() 暴露最近一次排序决策的探测详情（三态：null /
 * proxy-short-circuit / probe），供 checker 透传登记 source-selection 日志（R1-U1a）。
 *
 * 依赖方向：update 层内聚（proxy-config / upgrade-fetch / release-sources 同层），
 * 不依赖 electron。
 */
import type { UpdateSource, UpdateSourcePref } from '@taiji/shared'
import { readProxyConfig, resolveProxyUrl } from './proxy-config.js'
import { upgradeFetch, isCurlHttpStatusError } from './upgrade-fetch.js'
import { RELEASE_SOURCE_HOSTS } from './release-sources.js'

/**
 * 源优先级序列（main 侧内部类型，不进 shared——renderer 无消费，设计 §7.1）。
 * 定义并导出于本模块，供 release-checker 构造注入消费。
 */
export type SourceOrder = UpdateSource[]

/**
 * 两主域探测 URL（域值消费 release-sources 单一来源导出，D1 防漂移）。
 * 取主域下载域而非 API 域：D4 被否谱系 b——探测是域名级链路判定，不打真实 API 端点。
 */
const GITHUB_PROBE_URL = `https://${RELEASE_SOURCE_HOSTS.githubDownload}`
const GITCODE_PROBE_URL = `https://${RELEASE_SOURCE_HOSTS.atomgitDownload}`

/** 单位换算常量（消 no-magic-numbers，对齐 update-self-healer.ts 命名先例）。 */
const MS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

/** 单域探测超时（毫秒）。设计定值 3s：探测时长入账为 auto+无代理用户每次缓存过期后的固定代价。 */
const PROBE_TIMEOUT_MS = 3_000

/** 探测结果缓存 TTL（毫秒，1h——与检查缓存同量级，D4）。 */
const PROBE_CACHE_TTL_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND

/** 探测请求头：1 字节 Range 请求（GET 而非 HEAD 的原因见模块头注释）。 */
const PROBE_RANGE_HEADER = 'bytes=0-0'

/** 单域探测结果（S2 验收观测面字段：链路可达性布尔）。 */
export interface ProbeSourceOutcome {
  reachable: boolean
}

/**
 * 最近一次源排序决策的探测详情（S2 验收观测面，checker 透传登记 source-selection 用）。
 *
 * results 域键缺失 = 该域可达性在本次决策通道下无推断依据（代理短路仅能推断 github，
 * gitcode 不捏造值）；via='probe' 时两域键恒齐。
 */
export interface ProbeOutcome {
  results: Partial<Record<UpdateSource, ProbeSourceOutcome>>
  via: 'probe' | 'proxy-short-circuit'
  /** 决策时刻（epoch ms）。TTL 缓存命中沿用原探测决策时刻，不刷新（不捏造新探测）。 */
  decidedAt: number
}

/**
 * 探测缓存（模块级进程内，与检查缓存同量级；仅 auto+无代理路径读写）。
 * 携带决策详情：缓存窗口内的后续 auto 轮次排序仍源自该次探测，观测面恢复用。
 */
interface ProbeCacheEntry {
  order: SourceOrder
  outcome: ProbeOutcome
}
let cachedProbe: ProbeCacheEntry | null = null
let cachedProbeAt = 0

/**
 * 最近一次排序决策的探测详情（R1-U1a，进程内单值）。
 * 维护口径：每次 resolveSourceOrder 后读取 getLastProbeOutcome() 均对应当次调用的
 * 排序依据——显式偏好路径重置为 null（显式偏好不是探测决策，checker 对显式偏好
 * 自有 reason 口径，残留旧详情会被误登记为本次依据）；代理短路写短路记录；
 * 真实探测写探测记录；TTL 缓存命中恢复缓存中的原决策详情（decidedAt 不刷新）。
 */
let lastProbeOutcome: ProbeOutcome | null = null

/** 深拷贝决策详情（调用方 / 缓存 / 单值三者互不共享可突变引用）。 */
function snapshotOutcome(outcome: ProbeOutcome): ProbeOutcome {
  const results: Partial<Record<UpdateSource, ProbeSourceOutcome>> = {}
  for (const [source, entry] of Object.entries(outcome.results)) {
    results[source as UpdateSource] = { ...entry }
  }
  return { via: outcome.via, decidedAt: outcome.decidedAt, results }
}

/**
 * 读取最近一次源排序决策的探测详情（供 checker 透传登记，S2 观测面）。
 *
 * 返回 null 的情形：本进程尚未做过任何决策、或最近一次调用走显式偏好路径。
 * 返回值为快照副本，调用方突变不影响内部状态。
 */
export function getLastProbeOutcome(): ProbeOutcome | null {
  return lastProbeOutcome ? snapshotOutcome(lastProbeOutcome) : null
}

/** 测试隔离入口（对齐 upgrade-fetch resetEnginePreferenceForTest 先例）。 */
export function resetSourceOrderCacheForTest(): void {
  cachedProbe = null
  cachedProbeAt = 0
  lastProbeOutcome = null
}

/**
 * 单域可达性探测：任何完成的 HTTP 响应即可达（含非 2xx），其余失败 = 不可达。
 *
 * 返回 true 的两种形态（双引擎等价）：
 *   - upgradeFetch resolve（undici 引擎不看 ok/status；curl 引擎 -f 对 2xx resolve）
 *   - reject 的是携带 httpStatusCode 的 CurlFetchError（curl -f exit 22：服务器已
 *     返回 HTTP 状态 = 链路通）
 * 超时 / 连接错误 / 无状态码的 CurlFetchError → false。
 */
async function probeReachable(url: string): Promise<boolean> {
  try {
    await upgradeFetch(url, {
      method: 'GET',
      headers: { Range: PROBE_RANGE_HEADER },
      timeoutMs: PROBE_TIMEOUT_MS,
      disableFlagPersistence: true,
    })
    return true
  } catch (err) {
    return isCurlHttpStatusError(err)
  }
}

/**
 * 解析源优先级序列（设计 §4.2② `resolveSourceOrder(settings)` 签名）。
 *
 * @param pref settings 来源偏好（UpdateSettings.updateSource）；缺省按 auto
 *   （老 settings 文件无此字段 = auto，§6.3 向后兼容）
 */
export async function resolveSourceOrder(pref: UpdateSourcePref = 'auto'): Promise<SourceOrder> {
  // 显式偏好直接映射（未知值经类型收窄后落入 auto 分支 = 非法值回退 auto，§6.3 语义）；
  // 同时重置决策记录——显式偏好不是探测决策（见 lastProbeOutcome 维护口径）
  if (pref === 'github') {
    lastProbeOutcome = null
    return ['github', 'atomgit']
  }
  if (pref === 'atomgit') {
    lastProbeOutcome = null
    return ['atomgit', 'github']
  }

  // auto：代理短路（readProxyConfig + resolveProxyUrl 现有 SSOT，proxy-config.ts）
  const proxyUrl = resolveProxyUrl(readProxyConfig())
  if (proxyUrl) {
    lastProbeOutcome = {
      via: 'proxy-short-circuit',
      // 推断依据仅 github（能配代理 = github 可达概率高，D4）；gitcode 可达性无推断依据，不填不捏造
      results: { github: { reachable: true } },
      decidedAt: Date.now(),
    }
    return ['github', 'atomgit']
  }

  // auto + 无代理：探测结果 TTL 缓存命中 → 不重复探测，决策详情恢复自缓存
  // （排序仍源自该次探测，decidedAt 保持原决策时刻，S2 观测面不因缓存轮次失真）
  const now = Date.now()
  if (cachedProbe && now - cachedProbeAt < PROBE_CACHE_TTL_MS) {
    lastProbeOutcome = snapshotOutcome(cachedProbe.outcome)
    return [...cachedProbe.order]
  }

  // 并行探测两主域（无先后依赖，最坏代价 = 单域 3s 超时而非串行 6s）。
  // allSettled 对齐项目「独立数据源」规范；probeReachable 内部已吞异常实际恒 fulfilled，
  // rejected 分支按不可达保守归类（防御 probeReachable 未来演化出上抛路径）。
  const [githubProbe, gitcodeProbe] = await Promise.allSettled([
    probeReachable(GITHUB_PROBE_URL),
    probeReachable(GITCODE_PROBE_URL),
  ])
  const githubReachable = githubProbe.status === 'fulfilled' && githubProbe.value
  const gitcodeReachable = gitcodeProbe.status === 'fulfilled' && gitcodeProbe.value

  // 排序：github 可达恒排前（仅 github 可达 / 均可达 tie-break / 双败回退均落此分支）；
  // 仅 gitcode 可达 → gitcode 排前（目标 1：国内自动落 AtomGit）
  const order: SourceOrder =
    githubReachable || !gitcodeReachable ? ['github', 'atomgit'] : ['atomgit', 'github']

  const outcome: ProbeOutcome = {
    via: 'probe',
    results: {
      github: { reachable: githubReachable },
      atomgit: { reachable: gitcodeReachable },
    },
    decidedAt: now,
  }
  lastProbeOutcome = snapshotOutcome(outcome)

  cachedProbe = { order: [...order], outcome: snapshotOutcome(outcome) }
  cachedProbeAt = now
  return order
}
