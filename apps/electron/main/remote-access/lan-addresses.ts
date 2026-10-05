/**
 * LAN 地址枚举（remote-access D6）。
 *
 * 面板「连接入口」候选列表的数据源：枚举本机网卡（os.networkInterfaces）过滤出
 * 可供手机直连的 IPv4 地址，产 `http://<ip>:<port>` 候选（附地址类型标注）。
 *
 * 过滤规则：
 * - 仅 IPv4（手机浏览器直连形态；IPv6 link-local/global 不进候选——D6 v1 是 LAN 直连）；
 * - 排除 internal 接口（回环 127.0.0.1/lo0——手机连的是主机自身地址，回环不可达）；
 * - Tailscale 的 100.x 地址是普通非 internal 接口，进候选（D6 跨网指引的实测入口）。
 *
 * 排序语义（跨网优先）：Tailscale（CGNAT 段）候选排前、局域网候选排后，组内保持
 * 接口枚举顺序（单遍分区，稳定）——面板默认选中数组首项，跨网使用为主时默认即
 * 展示 Tailscale 地址（用户裁决：该能力以跨网使用优先）。
 *
 * 纯函数：interfaces 结果与端口经参数注入（测试 mock networkInterfaces，零真实网络依赖）。
 */
import type { NetworkInterfaceInfo } from 'node:os'
import type { RemoteAccessUrl } from '@taiji/shared'

/** 点分四段 IPv4 地址的段数（os.networkInterfaces 的 IPv4 address 形态）。 */
const IPV4_OCTET_COUNT = 4
/** CGNAT 保留段 100.64.0.0/10：第一段恒 100，第二段边界（Tailscale 分配区间）。 */
const CGNAT_FIRST_OCTET = '100'
const CGNAT_SECOND_OCTET_MIN = 64
const CGNAT_SECOND_OCTET_MAX = 127

/**
 * Tailscale 地址判别：100.64.0.0/10（CGNAT 保留段，100.64.0.0 – 100.127.255.255）。
 * 入参来自 os.networkInterfaces 的 IPv4 address（点分四段，形态可信）；
 * 第二段非数字时比较结果为 false（NaN 不落在边界内），天然拒非法形态。
 * 已知误报源：Cloudflare WARP 等少数 VPN 同用 CGNAT 段——误报后果仅是候选
 * 标注偏差（用户试连不可达），无安全面，可接受。
 */
function isTailscaleAddress(address: string): boolean {
  const octets = address.split('.')
  if (octets.length !== IPV4_OCTET_COUNT) return false
  const second = Number(octets[1])
  return octets[0] === CGNAT_FIRST_OCTET && second >= CGNAT_SECOND_OCTET_MIN && second <= CGNAT_SECOND_OCTET_MAX
}

/**
 * 从网卡枚举结果过滤出连接候选列表（Tailscale 优先排序）。
 *
 * @param interfaces os.networkInterfaces() 的返回（接口名 → 地址信息数组；值可 undefined，Dict 语义）
 * @param port runtime 监听端口；null（runtime 未启动）或非法值 → 空列表
 * @returns 候选数组：Tailscale 候选在前、局域网在后，组内按接口枚举顺序（不去重——同名地址罕见且无副作用）
 */
export function enumerateLanAddresses(
  interfaces: Record<string, readonly NetworkInterfaceInfo[] | undefined>,
  port: number | null,
): RemoteAccessUrl[] {
  if (port === null || !Number.isInteger(port) || port <= 0) return []
  const tailscale: RemoteAccessUrl[] = []
  const lan: RemoteAccessUrl[] = []
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      // 判别联合按 family 收窄：仅 'IPv4' 分支参与（IPv6 信息跳过），address 直接按类型访问
      if (info.family !== 'IPv4') continue
      // internal：回环接口（lo0/127.0.0.1）对手机不可达，排除
      if (info.internal) continue
      const candidate: RemoteAccessUrl = {
        url: `http://${info.address}:${port}`,
        kind: isTailscaleAddress(info.address) ? 'tailscale' : 'lan',
      }
      ;(candidate.kind === 'tailscale' ? tailscale : lan).push(candidate)
    }
  }
  return [...tailscale, ...lan]
}
