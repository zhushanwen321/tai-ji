/**
 * LLM 网络代理测试连接两段探测测试（mock 代理 / mock SOCKS5 服务；TCP 可达 + CONNECT 隧道
 * + RFC 1928/1929 握手；两段归因文案区分 + 恢复指引）。
 *
 * llm-network-proxy 设计 §3.1 卡 1；探测超时经第二参注入小值（控制面单请求，缺省 5s 不在
 * 测试路径等待）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'

import { testNetworkProxyConnection } from '../src/services/network-proxy-config.js'
import type { NetworkProxyConfig } from '@taiji/shared'

const SHORT_TIMEOUT_MS = 500

function proxyConfig(overrides: Partial<NetworkProxyConfig['proxy']> = {}, rules: string[] = ['target.example.test']): NetworkProxyConfig {
  return {
    enabled: true,
    proxy: { protocol: 'http', host: '127.0.0.1', port: 1, username: '', password: '', ...overrides },
    noProxy: [],
    rules,
    ipv4Only: [],
  }
}

interface MockServer { // oe-exempt:20261019:framework:探测单测的 mock 代理句柄形状（startMockHttpProxy/startMockSocks5 共用返回契约）

  port: number
  close: () => Promise<void>
  /** http 代理模式：收到的 CONNECT 请求头原文（凭据头断言用）。 */
  requests: string[]
}

function startMockHttpProxy(mode: 'accept' | 'reject' | 'silent'): Promise<MockServer> {
  return new Promise((resolve) => {
    const requests: string[] = []
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf-8')
        if (!text.startsWith('CONNECT')) return
        requests.push(text)
        if (mode === 'accept') socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
        else if (mode === 'reject') socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        // silent：不回（超时路径）
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

type Socks5Mode = 'ok' | 'auth-ok' | 'auth-fail' | 'refuse-target' | 'reject-auth-method'

function startMockSocks5(mode: Socks5Mode): Promise<MockServer> {
  return new Promise((resolve) => {
    const requests: string[] = []
    const server = net.createServer((socket) => {
      let stage: 'greeting' | 'auth' | 'connect' = 'greeting'
      socket.on('data', (chunk) => {
        if (stage === 'greeting') {
          requests.push(`greeting:${chunk.toString('hex')}`)
          const wantsAuth = chunk[2] === 0x02
          if (wantsAuth) {
            if (mode === 'ok' || mode === 'refuse-target') {
              // 配了凭据但 mock 只支持无认证：拒绝方法选择
              socket.write(Buffer.from([0x05, 0xff]))
              socket.destroy()
              return
            }
            socket.write(Buffer.from([0x05, 0x02]))
            stage = 'auth'
          } else {
            if (mode === 'reject-auth-method') {
              socket.write(Buffer.from([0x05, 0xff]))
              socket.destroy()
              return
            }
            socket.write(Buffer.from([0x05, 0x00]))
            stage = 'connect'
          }
        } else if (stage === 'auth') {
          requests.push(`auth:${chunk.toString('hex')}`)
          socket.write(mode === 'auth-fail' ? Buffer.from([0x01, 0x01]) : Buffer.from([0x01, 0x00]))
          stage = 'connect'
        } else {
          requests.push(`connect:${chunk.toString('hex')}`)
          // BND.ADDR 固定 4 字节 IPv4 形态回复
          socket.write(
            mode === 'refuse-target'
              ? Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0x00, 0x00])
              : Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50]),
          )
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

const cleanupQueue: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanupQueue.length > 0) {
    const close = cleanupQueue.pop()
    if (close) await close()
  }
})

describe('测试连接第一段（TCP 连代理，三协议同构）', () => {
  it('代理端口无监听 → ok=false stage=proxy，归因「代理不可达」+ 恢复指引', async () => {
    // 先 listen(0) 拿一个确定无监听的端口再关掉（connect 该端口 = ECONNREFUSED）
    const probe = await startMockHttpProxy('accept')
    const { port } = probe
    await probe.close()
    const result = await testNetworkProxyConnection(proxyConfig({ port }), SHORT_TIMEOUT_MS)
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('proxy')
    expect(result.message).toContain('无法连接代理')
    expect(result.message).toContain('连接被拒绝')
    expect(result.message).toContain('启动代理软件后重试')
    expect(result.message).toContain('关闭网络代理开关恢复直连')
  })

  it('规则为空 → 只测第一段即 done（message 说明未配置规则）', async () => {
    const mock = await startMockHttpProxy('accept')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(proxyConfig({ port: mock.port }, []), SHORT_TIMEOUT_MS)
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('done')
    expect(result.message).toContain('未配置代理规则')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(mock.requests).toEqual([]) // 未发起第二段
  })
})

describe('测试连接第二段（http/https 代理 = CONNECT 隧道探测）', () => {
  it('CONNECT 200 → ok=true stage=done，耗时取第一段', async () => {
    const mock = await startMockHttpProxy('accept')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(proxyConfig({ port: mock.port }), SHORT_TIMEOUT_MS)
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('done')
    expect(result.message).toContain('target.example.test:443')
    expect(result.message).toContain('经代理')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(mock.requests[0]).toContain('CONNECT target.example.test:443 HTTP/1.1')
  })

  it('CONNECT 502 → ok=false stage=outbound，「代理可达但经代理出站失败」归因 + 恢复指引', async () => {
    const mock = await startMockHttpProxy('reject')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(proxyConfig({ port: mock.port }), SHORT_TIMEOUT_MS)
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('outbound')
    expect(result.message).toContain('代理可达')
    expect(result.message).toContain('失败')
    expect(result.message).toContain('检查代理出口网络')
    expect(result.message).toContain('核对代理规则配置')
  })

  it('凭据非空 → CONNECT 带 Proxy-Authorization Basic 头', async () => {
    const mock = await startMockHttpProxy('accept')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ port: mock.port, username: 'user', password: 'pass' }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(true)
    const expected = Buffer.from('user:pass').toString('base64')
    expect(mock.requests[0]).toContain(`Proxy-Authorization: Basic ${expected}`)
  })

  it('代理收到 CONNECT 后不响应 → 超时归因（outbound 段）', async () => {
    const mock = await startMockHttpProxy('silent')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(proxyConfig({ port: mock.port }), 200)
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('outbound')
    expect(result.message).toContain('响应超时')
  })
})

describe('测试连接第二段（socks5 = RFC 1928 握手 + 连接请求）', () => {
  it('无认证握手 + CONNECT 成功 → ok=true stage=done', async () => {
    const mock = await startMockSocks5('ok')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ protocol: 'socks5', port: mock.port }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('done')
    expect(result.message).toContain('经代理访问 target.example.test:443')
    // 连接请求形态：ver=05 CMD=01 RSV=00 ATYP=03(domain) + len + host + port 0x01bb(443)
    const hostBuf = Buffer.from('target.example.test', 'utf-8')
    const expected = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
      hostBuf,
      Buffer.from([0x01, 0xbb]),
    ]).toString('hex')
    expect(mock.requests).toContain(`connect:${expected}`)
  })

  it('凭据非空 → RFC 1929 用户名密码认证通过（只提议 0x02 方法）', async () => {
    const mock = await startMockSocks5('auth-ok')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ protocol: 'socks5', port: mock.port, username: 'u', password: 'p' }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('done')
    expect(mock.requests[0]).toBe('greeting:050102')
    const user = Buffer.from('u', 'utf-8')
    const pass = Buffer.from('p', 'utf-8')
    const expectedAuth = Buffer.concat([
      Buffer.from([0x01, user.length]),
      user,
      Buffer.from([pass.length]),
      pass,
    ]).toString('hex')
    expect(mock.requests).toContain(`auth:${expectedAuth}`)
  })

  it('代理拒绝目标连接（rep=5）→ outbound 归因含「代理侧连接被拒绝」', async () => {
    const mock = await startMockSocks5('refuse-target')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ protocol: 'socks5', port: mock.port }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('outbound')
    expect(result.message).toContain('代理侧连接被拒绝')
    expect(result.message).toContain('检查代理出口网络')
  })

  it('认证失败（RFC 1929 status≠0）→ outbound 归因含「认证失败」', async () => {
    const mock = await startMockSocks5('auth-fail')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ protocol: 'socks5', port: mock.port, username: 'u', password: 'wrong' }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('outbound')
    expect(result.message).toContain('代理认证失败')
  })

  it('代理不接受任何提议方法（0xff）→ outbound 归因', async () => {
    const mock = await startMockSocks5('reject-auth-method')
    cleanupQueue.push(mock.close)
    const result = await testNetworkProxyConnection(
      proxyConfig({ protocol: 'socks5', port: mock.port }),
      SHORT_TIMEOUT_MS,
    )
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('outbound')
    expect(result.message).toContain('代理要求认证但未配置凭据')
  })
})
