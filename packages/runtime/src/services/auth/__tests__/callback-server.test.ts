/**
 * 本地回调服务器单测（真实 node:http，port 0 动态端口）。
 *
 * 覆盖：完整成功路径（200 + resolve {code, state}）/ state 不匹配 400 /
 * error query 400 / 缺 code|state 400 / 超时（短 timeoutMs 真实等待）/
 * abort 中断 / 二次请求 409 claimed / 非回调路径 404。
 */
import { describe, it, expect } from 'vitest'
import { startCallbackServer } from '../callback-server.js'

describe('startCallbackServer', () => {
  it('完整成功路径：200 + resolve { code, state }', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback', expectedState: 's1' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url}?code=AUTH_CODE&state=s1`)
      expect(res.status).toBe(200)
      await expect(p).resolves.toEqual({ code: 'AUTH_CODE', state: 's1' })
    } finally {
      server.close()
    }
  })

  it('state 不匹配：400 + reject state_mismatch，不 resolve', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback', expectedState: 's1' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url}?code=AUTH_CODE&state=wrong`)
      expect(res.status).toBe(400)
      await expect(p).rejects.toMatchObject({ code: 'state_mismatch' })
    } finally {
      server.close()
    }
  })

  it('error query：400 + reject provider_error', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url}?error=access_denied`)
      expect(res.status).toBe(400)
      await expect(p).rejects.toMatchObject({ code: 'provider_error' })
    } finally {
      server.close()
    }
  })

  it('缺 code：400 + reject', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url}?state=s1`)
      expect(res.status).toBe(400)
      await expect(p).rejects.toMatchObject({ code: 'missing_params' })
    } finally {
      server.close()
    }
  })

  it('expectedState 未传：code-only 回调（无 state）放行 200（openrouter 场景）', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url}?code=ONLY_CODE`)
      expect(res.status).toBe(200)
      await expect(p).resolves.toEqual({ code: 'ONLY_CODE', state: undefined })
    } finally {
      server.close()
    }
  })

  it('非回调路径：404，不影响 waitForCallback 继续等待', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback', expectedState: 's1' })
    try {
      const p = server.waitForCallback()
      const res = await fetch(`${server.url.replace('/callback', '/other')}?code=X&state=s1`)
      expect(res.status).toBe(404)

      // 路径错误不消费回调，正确路径仍可成功
      const res2 = await fetch(`${server.url}?code=OK&state=s1`)
      expect(res2.status).toBe(200)
      await expect(p).resolves.toEqual({ code: 'OK', state: 's1' })
    } finally {
      server.close()
    }
  })

  it('超时：timeoutMs 到期 reject { code: timeout }', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback', timeoutMs: 80 })
    try {
      const p = server.waitForCallback()
      await expect(p).rejects.toMatchObject({ code: 'timeout' })
    } finally {
      server.close()
    }
  })

  it('abort：signal 中断 reject { code: aborted }', async () => {
    const ac = new AbortController()
    const server = await startCallbackServer({ port: 0, path: '/callback', signal: ac.signal })
    try {
      const p = server.waitForCallback()
      ac.abort()
      await expect(p).rejects.toMatchObject({ code: 'aborted' })
    } finally {
      server.close()
    }
  })

  it('单次消费：第二个请求返回 409 claimed', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback', expectedState: 's1' })
    try {
      const p = server.waitForCallback()
      const res1 = await fetch(`${server.url}?code=FIRST&state=s1`)
      expect(res1.status).toBe(200)
      await expect(p).resolves.toEqual({ code: 'FIRST', state: 's1' })

      const res2 = await fetch(`${server.url}?code=SECOND&state=s1`)
      expect(res2.status).toBe(409)
    } finally {
      server.close()
    }
  })

  it('close() 幂等，可重复调用', async () => {
    const server = await startCallbackServer({ port: 0, path: '/callback' })
    server.close()
    expect(() => server.close()).not.toThrow()
  })

  it('M4-03: listen EADDRINUSE → reject listen_failed + 可操作文案（端口被占提示）', async () => {
    // 先占住一个端口，再同端口 listen 必然 EADDRINUSE
    const blocker = await startCallbackServer({ port: 0, path: '/block' })
    const ac = new AbortController()
    try {
      await expect(startCallbackServer({ port: blocker.port, path: '/callback', signal: ac.signal }))
        .rejects.toMatchObject({
          code: 'listen_failed',
          message: expect.stringMatching(/端口 \d+ 被占用，请关闭另一个 TaiJi 实例后重试/),
        })
      // reject 后 abort 不抛（监听已摘除）；timer 已清不留悬挂
      ac.abort()
    } finally {
      blocker.close()
    }
  })
})
