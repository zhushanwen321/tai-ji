/**
 * LLM 网络代理配置域（类型 + 校验 + 匹配语义纯函数）。
 * 校验与匹配定在 shared：runtime 写入侧校验、settings 展示与 extension 分流匹配共用同一套语义，
 * 杜绝两端漂移（llm-retry 域同款纪律）。
 * extension 侧因 bundle 隔离会复制同语义实现（normalizeHostname / matchesHostPattern），
 * 本模块是匹配语义 SSOT——复制体漂移时以本文件为准。
 * 设计依据：.tmp/tech-design/llm-network-proxy.md §3.1（配置 schema 与匹配语义）。
 */

/** 代理协议词表：http / https 走 undici ProxyAgent，socks5 走 Socks5ProxyAgent。 */
export type NetworkProxyProtocol = 'http' | 'https' | 'socks5'

export const NETWORK_PROXY_PROTOCOLS: readonly NetworkProxyProtocol[] = ['http', 'https', 'socks5']

/** TCP 端口合法上界（校验下界固定 1）。 */
const NETWORK_PROXY_PORT_MAX = 65535

/** 代理服务器连接参数。username/password 成对（非空时拼入代理 URL 发认证头，单边无意义）。 */
export interface NetworkProxyServer { // oe-exempt:20261019:framework:shared 协议契约类型，runtime 写侧 / settings 展示侧多包消费，单实现为常态

  protocol: NetworkProxyProtocol
  host: string
  port: number
  username: string
  password: string
}

/**
 * 网络代理配置（ext-config 文件单一权威 schema）。
 * noProxy 优先级高于 rules（先排除再匹配）；rules/noProxy 条目统一 suffix 匹配（同一匹配函数）。
 */
export interface NetworkProxyConfig { // oe-exempt:20261019:framework:ext-config 文件单一权威 schema，runtime/extension/settings 三端消费
  enabled: boolean
  proxy: NetworkProxyServer
  /** 直连排除清单（主机名条目），命中即不经代理 */
  noProxy: string[]
  /** 代理规则（主机名条目），命中即经代理 */
  rules: string[]
}

/** 默认配置：禁用态 + 常见本地代理地址占位 + 保护本地回环。 */
export const DEFAULT_NETWORK_PROXY_CONFIG: NetworkProxyConfig = {
  enabled: false,
  proxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
  noProxy: ['localhost', '127.0.0.1'],
  rules: [],
}

/** 校验结果信封：ok 或面向用户的错误清单（每条含修复动作，逐项收集不短路）。 */
export type NetworkProxyValidationResult = { ok: true } | { ok: false; errors: string[] }

/** 统计时间范围词表：24h / 7d 为读侧时间过滤档，all = 截断保尾窗口内累计。 */
export type NetworkProxyStatsRange = '24h' | '7d' | 'all'

/** 按主机名聚合的单行计数（proxied = 经代理出站次数，direct = 直连次数；请求发起时计数）。 */
export interface NetworkProxyStats { // oe-exempt:20261019:framework:统计聚合契约类型，runtime 读侧 / settings 展示侧消费
  host: string
  proxied: number
  direct: number
}

/**
 * 测试连接两段探测的阶段词表（设计 §3.1 卡 1）：
 * proxy = 第一段 TCP 连接代理服务器本身；outbound = 第二段经代理向规则首条主机名 443 出站探测；
 * done = 两段全部通过。
 */
export type NetworkProxyTestStage = 'proxy' | 'outbound' | 'done'

/** 测试连接结果：阶段（失败段 / 成功 done）+ 面向用户的归因文案（含恢复指引）+ 耗时。 */
export interface NetworkProxyTestResult { // oe-exempt:20261019:framework:测试连接结果契约类型，runtime 探测侧 / settings 展示侧消费
  ok: boolean
  /** 失败时 = 失败所在段（proxy / outbound）；成功时 = 'done' */
  stage: NetworkProxyTestStage
  /** 归因文案：区分「代理不可达」与「代理可达但经代理出站失败」，附恢复指引 */
  message: string
  /** 往返耗时 ms（取第一段 TCP 连接代理的耗时） */
  elapsedMs: number
}

/**
 * 主机名归一化（匹配语义 SSOT）：转小写、去末尾点（FQDN 根点形态与裸主机名同义）。
 * 刻意不 trim 首尾空白：带空白的条目由校验层显式拒绝（collectHostEntryErrors，
 * 失败显式上报优于匹配层静默容忍），匹配层保持严格、带空白 pattern 恒不命中。
 */
export function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '')
}

/**
 * suffix 语义匹配（与 noProxy/rules 条目同一匹配函数）：主机名等于 pattern 或以 `.pattern` 结尾，
 * 点边界必须对齐——`xapi.anthropic.com` 不命中 pattern `api.anthropic.com`（无点前缀拼接），
 * `api-anthropic.com.evil.com` 不命中（恶意后缀）。空主机名 / 空 pattern 不命中任何条目。
 */
export function matchesHostPattern(host: string, pattern: string): boolean {
  const h = normalizeHostname(host)
  const p = normalizeHostname(pattern)
  if (h === '' || p === '') return false
  return h === p || h.endsWith(`.${p}`)
}

/** noProxy/rules 条目校验：数组 + 每条为非空且不含空白字符的主机名字符串；重复条目不报错（去重语义，匹配天然幂等）。 */
function collectHostEntryErrors(entries: unknown, label: string): string[] {
  if (!Array.isArray(entries)) {
    return [`${label} 必须是主机名列表（当前不是列表），请恢复为每行一个主机名的形式`]
  }
  const errors: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (typeof entry !== 'string' || entry.trim() === '') {
      errors.push(`${label} 第 ${i + 1} 条为空，请填写主机名或删除该条`)
    } else if (/\s/.test(entry)) {
      // 归一化不 trim，含空白字符的条目（首尾或内部）对真实主机名恒不匹配（静默不生效）——校验层显式拒绝并给出修复动作
      errors.push(`${label} 第 ${i + 1} 条含空白字符，请删除空白后保存`)
    }
  }
  return errors
}

/** proxy 对象字段校验（validateNetworkProxyConfig 的子步骤）：协议白名单 / 地址 / 端口 / 凭据成对，逐项收集。 */
function collectProxyServerErrors(proxy: unknown): string[] {
  if (proxy === null || typeof proxy !== 'object' || Array.isArray(proxy)) {
    return ['代理服务器配置必须是对象（协议 + 地址 + 端口），请重新填写代理服务器信息']
  }
  const errors: string[] = []
  const { protocol, host, port, username, password } = proxy as Record<string, unknown>
  if (typeof protocol !== 'string' || !NETWORK_PROXY_PROTOCOLS.includes(protocol as NetworkProxyProtocol)) {
    errors.push(`代理协议必须是 http / https / socks5 之一: ${String(protocol)}，请重新选择协议`)
  }
  if (typeof host !== 'string' || host.trim() === '') {
    errors.push('代理服务器地址不能为空，请填写代理地址（如 127.0.0.1）')
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > NETWORK_PROXY_PORT_MAX) {
    errors.push(`代理端口必须是 1-${NETWORK_PROXY_PORT_MAX} 的整数: ${String(port)}，请填写正确的端口`)
  }
  if (typeof username !== 'string' || typeof password !== 'string') {
    errors.push('认证用户名与密码必须是文本，请检查认证输入框内容')
  } else if ((username !== '') !== (password !== '')) {
    errors.push('认证用户名与密码必须同时填写或同时留空（代理认证要求两者成对），请补全另一项或清空两项')
  }
  return errors
}

/**
 * 网络代理配置校验（runtime 写入侧与 settings 表单共用）：
 * 协议白名单 http/https/socks5、端口 1-65535 整数、凭据成对（username/password 同空或同非空）、
 * noProxy/rules 条目非空主机名且不含空白字符（归一化不 trim，带空白恒不匹配故显式拒绝）、重复条目去重不报错。
 * 错误逐项收集（errors 复数，不短路），文案面向用户且含修复动作。
 * 对象性守卫（llm-retry 同款）：null/数组解构会抛 TypeError 或静默得 undefined，
 * 写路径校验须以错误信封逃逸而非异常。
 */
export function validateNetworkProxyConfig(config: NetworkProxyConfig): NetworkProxyValidationResult {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, errors: [`网络代理配置必须是对象: ${String(config)}`] }
  }
  const errors: string[] = []
  const { enabled, proxy, noProxy, rules } = config
  if (typeof enabled !== 'boolean') {
    errors.push(`网络代理开关必须是开或关: ${JSON.stringify(enabled) ?? String(enabled)}，请重新切换一次开关后保存`)
  }
  errors.push(...collectProxyServerErrors(proxy))
  errors.push(...collectHostEntryErrors(noProxy, '直连排除清单（noProxy）'))
  errors.push(...collectHostEntryErrors(rules, '代理规则（rules）'))
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
