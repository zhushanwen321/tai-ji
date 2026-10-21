/**
 * 网络代理页草稿模型（llm-network-proxy U4）——NetworkPage 三卡共用的纯逻辑层：
 * config ↔ 表单草稿双向映射（输入形态适配：noProxy 逗号串 / port 字符串承载）+
 * provider baseUrl 主机名解析（快速添加 chips 数据源与统计行服务商名反查共用一套解析）。
 * 校验与匹配语义直接消费 shared network-proxy SSOT（禁另写一套，llm-retry 同款纪律）。
 */
import type { NetworkProxyConfig, NetworkProxyProtocol, ProviderInfo } from '@taiji/shared'
import { normalizeHostname } from '@taiji/shared'

/**
 * 页面级草稿编辑态。port / noProxy / ipv4Only 与 config 形态不同：port 用字符串承载
 * （number input 空值 = ''，保存时 Number 化交由 shared 校验拦截）；noProxy 与 ipv4Only
 * 用逗号分隔串承载（输入形态，保存时拆分 trim）。rules 条目与 config 同形态
 * （主机名字符串数组，行内直接编辑——它需要逐条开关 chip 的交互）。
 */
export interface NetworkProxyDraft { // oe-exempt:20261019:framework:页面视图模型契约形状（draftFromConfig/buildConfigFromDraft 双向映射锚点）
  enabled: boolean
  protocol: NetworkProxyProtocol
  host: string
  port: string
  username: string
  password: string
  noProxyInput: string
  rules: string[]
  ipv4OnlyInput: string
}

/** config → 草稿（加载回填与保存失败回滚共用；数组条目独立副本）。 */
export function draftFromConfig(config: NetworkProxyConfig): NetworkProxyDraft {
  return {
    enabled: config.enabled,
    protocol: config.proxy.protocol,
    host: config.proxy.host,
    port: String(config.proxy.port),
    username: config.proxy.username,
    password: config.proxy.password,
    noProxyInput: config.noProxy.join(', '),
    rules: [...config.rules],
    // 旧配置文件无此字段（normalize 已补空数组，这里再防御一次 undefined）
    ipv4OnlyInput: (config.ipv4Only ?? []).join(', '),
  }
}

/**
 * 草稿 → config（保存载荷组装）：noProxy / ipv4Only 按逗号拆分 + trim + 去空条目；host trim；
 * port Number 化（空/非法产 0/NaN，由 shared validateNetworkProxyConfig 拦截并给可操作文案）。
 */
export function buildConfigFromDraft(draft: NetworkProxyDraft): NetworkProxyConfig {
  return {
    enabled: draft.enabled,
    proxy: {
      protocol: draft.protocol,
      host: draft.host.trim(),
      port: Number(draft.port.trim()),
      username: draft.username,
      password: draft.password,
    },
    noProxy: draft.noProxyInput
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
    rules: draft.rules.map((rule) => rule.trim()),
    ipv4Only: draft.ipv4OnlyInput
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  }
}

/** 单个 provider 的请求端点主机名（baseUrl 取值优先级：provider 级 → 任一 model 级）。 */
export function providerBaseHost(provider: ProviderInfo): string | null {
  if (provider.baseUrl) {
    const host = hostnameOf(provider.baseUrl)
    if (host !== null) return host
  }
  for (const model of provider.models) {
    if (model.baseUrl) {
      const host = hostnameOf(model.baseUrl)
      if (host !== null) return host
    }
  }
  return null
}

/** provider 全部请求端点主机名（provider 级 + model 级去重保序；统计行服务商名反查用全集）。 */
export function providerHosts(provider: ProviderInfo): string[] {
  const hosts: string[] = []
  const push = (url: string | undefined): void => {
    if (!url) return
    const host = hostnameOf(url)
    if (host !== null && !hosts.includes(host)) hosts.push(host)
  }
  push(provider.baseUrl)
  for (const model of provider.models) push(model.baseUrl)
  return hosts
}

/** URL → 主机名（归一化复用 shared normalizeHostname）；无协议/解析失败返回 null。 */
function hostnameOf(url: string): string | null {
  try {
    return normalizeHostname(new URL(url).hostname)
  } catch {
    return null
  }
}

/** 快速添加 chip 数据源（provider 清单投影；host=null = 无可用 baseURL，chip 禁用态）。 */
export interface ProviderChip { // oe-exempt:20261019:framework:快速添加 chip 的数据源投影形状（UI 与 model 层共用）
  id: string
  name: string
  host: string | null
}

export function buildProviderChips(providers: ProviderInfo[]): ProviderChip[] {
  return providers.map((p) => ({ id: p.id, name: p.name, host: providerBaseHost(p) }))
}

/** chip 已添加态判定（设计 §3.1：判定键 = 主机名条目，归一化后相等即同一条规则）。 */
export function rulesContainHost(rules: string[], host: string): boolean {
  return rules.some((rule) => normalizeHostname(rule) === normalizeHostname(host))
}

/**
 * 统计行主机名 → 服务商名反查：provider 全部端点主机名归一化匹配；查不到返回 null
 * （消费侧显示裸主机名，设计 §3.1 卡 3）。
 */
export function providerNameForHost(host: string, providers: ProviderInfo[]): string | null {
  const normalized = normalizeHostname(host)
  for (const p of providers) {
    if (providerHosts(p).some((h) => normalizeHostname(h) === normalized)) return p.name
  }
  return null
}
