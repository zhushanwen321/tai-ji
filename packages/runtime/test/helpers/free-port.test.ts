/**
 * free-port helper 单测：EADDRINUSE 重试逻辑的注入式验证。
 *
 * 不 mock getFreePort 本身（同模块内部绑定无法经 vi.mock 拦截，为此改产品结构不值）——
 * 重试语义用注入 fake instance 的行为计划驱动：start 前两次抛 EADDRINUSE、第三次成功。
 */
import { describe, expect, it, vi } from 'vitest'
import { getFreePort, startOnFreePort } from './free-port.js'

type Plan = 'ok' | 'eaddrinuse' | 'other'

function fakeInstance(plan: Plan) {
  const err = plan === 'eaddrinuse'
    ? Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:1000'), { code: 'EADDRINUSE' })
    : new Error('boom: config error')
  return {
    start: plan === 'ok' ? vi.fn().mockResolvedValue(undefined) : vi.fn().mockRejectedValue(err),
    stop: vi.fn().mockResolvedValue(undefined),
  }
}

describe('startOnFreePort EADDRINUSE 重试', () => {
  it('前 2 次撞端口、第 3 次成功 → 返回成功实例，失败实例被清理，重试换了端口', async () => {
    const plans: Plan[] = ['eaddrinuse', 'eaddrinuse', 'ok']
    const created: Array<ReturnType<typeof fakeInstance>> = []
    const portsGiven: number[] = []

    const result = await startOnFreePort((p) => {
      const inst = fakeInstance(plans[created.length] ?? 'ok')
      created.push(inst)
      portsGiven.push(p)
      return inst
    }, { maxAttempts: 5 })

    // 重试了 2 次、第 3 次成功
    expect(created).toHaveLength(3)
    expect(result.instance).toBe(created[2])
    expect(result.port).toBe(portsGiven[2])
    // 失败实例被 best-effort 清理，成功实例未被误停
    expect(created[0].stop).toHaveBeenCalledOnce()
    expect(created[1].stop).toHaveBeenCalledOnce()
    expect(created[2].stop).not.toHaveBeenCalled()
    // 每轮重取端口：成功端口至少与某次失败尝试的端口不同
    expect(portsGiven[2] !== portsGiven[0] || portsGiven[2] !== portsGiven[1]).toBe(true)
  })

  it('全部撞端口 → 耗尽后抛含尝试次数与最后错误的清晰错误', async () => {
    const created: Array<ReturnType<typeof fakeInstance>> = []
    await expect(startOnFreePort(() => {
      const inst = fakeInstance('eaddrinuse')
      created.push(inst)
      return inst
    }, { maxAttempts: 2 })).rejects.toThrow(/2 次尝试全部 EADDRINUSE.*listen EADDRINUSE/s)
    expect(created).toHaveLength(2)
    // 耗尽前每个失败实例都做过清理
    expect(created[0].stop).toHaveBeenCalledOnce()
    expect(created[1].stop).toHaveBeenCalledOnce()
  })

  it('非 EADDRINUSE 错误 → 立即抛出不重试（换端口救不了代码/配置错误）', async () => {
    const created: Array<ReturnType<typeof fakeInstance>> = []
    await expect(startOnFreePort(() => {
      const inst = fakeInstance('other')
      created.push(inst)
      return inst
    })).rejects.toThrow('boom: config error')
    expect(created).toHaveLength(1)
  })
})

describe('getFreePort', () => {
  it('返回有效临时端口（0 < port ≤ 65535）', async () => {
    const port = await getFreePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })
})
