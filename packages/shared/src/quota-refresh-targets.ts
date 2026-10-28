/**
 * cookie 类 provider 的额度查询登录态刷新目标（隐藏窗口刷新器导航信息 SSOT）。
 *
 * cookie 类 provider（mimo / opencode-go 等）的服务端登录态换发必须走真实浏览器环境
 * （页面 JS + SSO 跳转），Electron main 进程的「隐藏窗口 cookie 刷新器」按本配置创建
 * 独立 persist partition 的隐藏 BrowserWindow、加载 pageUrl 让平台续期循环跑起来、
 * 轮询 apiUrl 直到 HTTP 200，再导出该 session 的 cookie 串经 IPC 回 renderer（落盘由
 * renderer 续期链走 quota.configure 保存链，main 不写 secrets 文件）。
 *
 * 与 runtime 包 baseline-fetchers.json 的分工（防双源）：本配置只含**刷新导航信息**
 * （去哪个页面、轮询哪个 API、登录页长什么样），不含额度请求解析规则（响应字段映射、
 * 归一化窗口逻辑仍在 runtime fetcher 一侧）。
 *
 * loginUrlPatterns 是正则字符串数组（new RegExp(pattern, 'i') 对完整 URL test），
 * 两个消费点语义不同：
 * - 登录页检测（main 刷新器轮询 getURL）：任一 pattern 命中即视为在登录页
 * - 导航白名单的账号域推导（main 刷新器 will-navigate 拦截）：仅取不含 '/' 的
 *   host 形态 pattern（如 'account.xiaomi.com'）作域匹配——路径形态（'/login'）
 *   会匹配任意域的同路径（evil.com/login），不能作放行依据。host 形态按**字面域**
 *   书写（点不转义）：裸域（'account.xiaomi.com'）匹配等值与子域后缀；尾点前缀
 *   （'auth.'）匹配子域前缀（auth.opencode.ai）。正则消费侧点的通配属宽松方向
 *   （多判一次登录页无害），字面消费侧无通配（伪装域不放行）。
 */
import type { QuotaPreset } from './quota-presets'
import { matchQuotaPreset } from './quota-presets'

export type QuotaRefreshTarget = {
  /** 平台控制台页面（隐藏窗口加载入口，续期循环在此页面上跑） */
  pageUrl: string
  /** 额度查询 API（轮询目标；同源页面上下文内 fetch，HTTP 200 即完成信号） */
  apiUrl: string
  /** 探测请求方法（缺省 GET）。POST 端点（connect RPC 形态，如 stepfun）对 GET 回
   *  405——探测必须与真实额度请求同方法，否则登录态健康也会被误判为探测失败 */
  apiMethod?: 'GET' | 'POST'
  /** apiMethod=POST 时的请求体（静态 JSON 字符串） */
  apiBody?: string
  /** 登录页 URL 特征（正则字符串，大小写不敏感；命中即视为登录态失效需要用户登录） */
  loginUrlPatterns: string[]
}

/**
 * 内置刷新目标注册表（键 = fetcher id，匹配 ProviderQuotaFetcher.id / QuotaPreset.fetcher）。
 * 只有 cookie 类且登录态可经页面续期的 fetcher 在册——api-key 类无登录态可刷，
 * 不登记（getQuotaRefreshTarget 返回 undefined，IPC 层拒绝）。
 */
export const QUOTA_REFRESH_TARGETS: Record<string, QuotaRefreshTarget> = {
  mimo: {
    pageUrl: 'https://platform.xiaomimimo.com/console/plan-manage',
    apiUrl: 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage',
    // 保守枚举：小米账号 SSO 域（host 形态，字面域）+ 平台自身登录路径（路径形态）。
    // SSO 跳转链路上的兜底域（i.mi.com 等）不确定的不写——宁可在登录页停留触发
    // 转可见，不放宽导航白名单
    loginUrlPatterns: [
      'account.xiaomi.com',
      'platform.xiaomimimo.com/login',
      'platform.xiaomimimo.com/signin',
    ],
  },
  'opencode-go': {
    pageUrl: 'https://opencode.ai/console',
    apiUrl: 'https://opencode.ai/console/api/go/status',
    // '/login' '/signin' 是路径形态（仅登录页检测用，不参与导航白名单）；
    // 'auth.' 是 host 形态尾点前缀（better-auth 登录子域，参与导航白名单）
    loginUrlPatterns: ['/login', '/signin', 'auth.'],
  },
  stepfun: {
    pageUrl: 'https://platform.stepfun.com/account-overview',
    apiUrl: 'https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit',
    // connect RPC 端点只收 POST（GET 回 405），探测与真实额度请求同方法同体
    apiMethod: 'POST',
    apiBody: '{}',
    // 账号域（host 形态，参与导航白名单——登录态换发源）+ 平台自身登录路径（路径形态）
    loginUrlPatterns: [
      'account.stepfun.com',
      'platform.stepfun.com/login',
      'platform.stepfun.com/signin',
    ],
  },
}

/**
 * 查询 fetcher 的刷新目标。
 *
 * @returns 在册返回目标配置；不在册（非 cookie 类 / 未知 fetcher）返回 undefined，
 *   调用方（main IPC 层）按输入校验拒绝
 */
export function getQuotaRefreshTarget(fetcherId: string): QuotaRefreshTarget | undefined {
  return QUOTA_REFRESH_TARGETS[fetcherId]
}

/** resolveQuotaFetcherId 的 provider 侧最小结构（baseUrl/name + 手动 fetcher 指定）。 */
export interface QuotaFetcherProviderLike {
  baseUrl?: string
  name?: string
  /** 用户手动指定的 fetcher id（优先于 preset 自动匹配）。 */
  quota?: { fetcher?: string } | undefined
}

/**
 * provider → quota fetcher id 的两级解析（单源，双实现归并产物）：
 * 1. 手动指定的 quota.fetcher 且在册（hasFetcher 判定）→ 该 id；
 * 2. 否则经 baseUrl/name 调 matchQuotaPreset 匹配 → preset.fetcher（**在册与否不在本
 *    函数判定**——preset 命中即返回 id，消费方按各自策略收尾，见下）。
 *
 * 消费方（规则单源、在册语义各自声明）：
 * - runtime QuotaService.getFetcherForProvider：hasFetcher = fetcher 注册表可执行查询；
 *   两级返回的 id 再查注册表取对象——preset 命中但 fetcher 已下线时得 null = 显式失败，
 *   不落第三级 providerId 兜底（远程下线的 fetcher 不得静默换源）。
 * - renderer useQuotaQuery（cookie 自动续期目标解析）：hasFetcher = QUOTA_REFRESH_TARGETS
 *   在册；两级结果再过一次刷新目标在册判定（不在册 → undefined 不触发续期）。
 *
 * presets 作形参传入（调用方决定权威来源）：runtime 传 listQuotaPresets() 合并视图，
 * renderer 传 RPC 下发副本经 resolveQuotaPresets 空态回落——两侧判定读同一规则，
 * 数据源差异由调用方显式声明。
 *
 * @returns 解析到的 fetcher id；两级都未命中返回 undefined
 */
export function resolveQuotaFetcherId(
  provider: QuotaFetcherProviderLike,
  presets: readonly QuotaPreset[],
  hasFetcher: (fetcherId: string) => boolean,
): string | undefined {
  const manual = provider.quota?.fetcher
  if (manual !== undefined && hasFetcher(manual)) return manual
  return matchQuotaPreset({ baseUrl: provider.baseUrl, name: provider.name }, presets)?.fetcher
}
