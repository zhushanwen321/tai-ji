/**
 * LAN 地址枚举（remote-access D6）。
 *
 * 面板「连接入口」候选列表的数据源：枚举本机网卡（os.networkInterfaces）过滤出
 * 可供手机直连的 IPv4 地址，产 `http://<ip>:<port>` 候选。
 *
 * 过滤规则：
 * - 仅 IPv4（手机浏览器直连形态；IPv6 link-local/global 不进候选——D6 v1 是 LAN 直连）；
 * - 排除 internal 接口（回环 127.0.0.1/lo0——手机连的是主机自身地址，回环不可达）；
 * - Tailscale 的 100.x 地址是普通非 internal 接口，自然进候选（D6 跨网指引的实测入口）。
 *
 * 纯函数：interfaces 结果与端口经参数注入（测试 mock networkInterfaces，零真实网络依赖）。
 */

/** 单个地址候选：`http://<ip>:<port>`。 */
export type LanAddress = string

/**
 * 从网卡枚举结果过滤出 LAN 直连候选列表。
 *
 * @param interfaces os.networkInterfaces() 的返回（接口名 → 地址信息数组；值可 undefined，Dict 语义）
 * @param port runtime 监听端口；null（runtime 未启动）或非法值 → 空列表
 * @returns `http://<ip>:<port>` 候选数组（按接口枚举顺序，不去重——同名地址罕见且无副作用）
 */
export function enumerateLanAddresses(
  interfaces: Record<string, readonly unknown[] | undefined>,
  port: number | null,
): LanAddress[] {
  if (port === null || !Number.isInteger(port) || port <= 0) return []
  const addresses: LanAddress[] = []
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      const record = info as Record<string, unknown>
      // family：Node 18+ 为字符串 'IPv4'（IPv6 信息跳过）
      if (record.family !== 'IPv4') continue
      // internal：回环接口（lo0/127.0.0.1）对手机不可达，排除
      if (record.internal === true) continue
      if (typeof record.address !== 'string') continue
      addresses.push(`http://${record.address}:${port}`)
    }
  }
  return addresses
}
