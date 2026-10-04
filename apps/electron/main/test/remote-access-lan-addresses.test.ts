/**
 * LAN 地址枚举单测（remote-access D6）。
 *
 * 覆盖：IPv4 过滤（IPv6 排除）、回环（internal）排除、Tailscale 100.x 保留、
 * 端口注入（null / 非法端口 → 空列表）、URL 拼接形态。
 * interfaces 结果经参数注入（mock os.networkInterfaces 返回值，零真实网络依赖）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/remote-access-lan-addresses.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { NetworkInterfaceInfo, NetworkInterfaceInfoIPv4, NetworkInterfaceInfoIPv6 } from 'node:os'
import { enumerateLanAddresses } from '../remote-access/lan-addresses.js'

/** 造 IPv4 地址信息（形态对齐 os.networkInterfaces 的返回成员，与产物类型对齐免 cast）。 */
function ipv4(overrides: Partial<NetworkInterfaceInfoIPv4> = {}): NetworkInterfaceInfo {
  return {
    address: '0.0.0.0',
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: '0.0.0.0/24',
    ...overrides,
  }
}

/** 造 IPv6 地址信息（scopeid 为该形态必填字段）。 */
function ipv6(overrides: Partial<NetworkInterfaceInfoIPv6> = {}): NetworkInterfaceInfo {
  return {
    address: '::',
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
    scopeid: 0,
    ...overrides,
  }
}

describe('enumerateLanAddresses', () => {
  it('仅保留非 internal 的 IPv4 地址，产 http://<ip>:<port> 候选', () => {
    const interfaces = {
      en0: [ipv4({ address: '192.168.1.5' })],
      lo0: [ipv4({ address: '127.0.0.1', internal: true })],
    }
    expect(enumerateLanAddresses(interfaces, 3310)).toEqual(['http://192.168.1.5:3310'])
  })

  it('排除回环（lo0 127.0.0.1）与 IPv6（fe80 link-local / fd00 global）', () => {
    const interfaces = {
      lo0: [
        ipv4({ address: '127.0.0.1', internal: true }),
        ipv6({ address: '::1', internal: true }),
        ipv6({ address: 'fe80::1' }),
      ],
      en0: [
        ipv4({ address: '192.168.1.5' }),
        ipv6({ address: 'fd00::5' }),
      ],
    }
    expect(enumerateLanAddresses(interfaces, 3310)).toEqual(['http://192.168.1.5:3310'])
  })

  it('Tailscale 100.x 地址是普通非 internal 接口，进候选（D6 跨网入口）', () => {
    const interfaces = {
      'utun100': [ipv4({ address: '100.64.0.3' })],
    }
    expect(enumerateLanAddresses(interfaces, 3310)).toEqual(['http://100.64.0.3:3310'])
  })

  it('多网卡多地址按枚举顺序全部返回', () => {
    const interfaces = {
      en0: [ipv4({ address: '192.168.1.5' })],
      en1: [ipv4({ address: '10.0.0.7' })],
    }
    expect(enumerateLanAddresses(interfaces, 3310)).toEqual([
      'http://192.168.1.5:3310',
      'http://10.0.0.7:3310',
    ])
  })

  it('端口 null（runtime 未启动）→ 空列表（面板不产死链接）', () => {
    const interfaces = { en0: [ipv4({ address: '192.168.1.5' })] }
    expect(enumerateLanAddresses(interfaces, null)).toEqual([])
  })

  it.each([0, -1, 1.5, Number.NaN])('非法端口 %p → 空列表', (port) => {
    const interfaces = { en0: [ipv4({ address: '192.168.1.5' })] }
    expect(enumerateLanAddresses(interfaces, port)).toEqual([])
  })

  it('空接口表 → 空列表', () => {
    expect(enumerateLanAddresses({}, 3310)).toEqual([])
  })
})
