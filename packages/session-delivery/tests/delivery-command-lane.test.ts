/**
 * 命令条目内核豁免测试（pi1-disposition-chat-flow D14③②/D14⑥，§4.1 验收条款 6/7）：
 * - G3 闸②：port.send settle 兜底对命令条目不武装（命令 handler await 用户交互属任务
 *   正常路径，60s 墙钟是跨粒级挪用）+ 普通条目兜底仍武装（对照）
 * - D14⑥：非 checked 通路（send()）命令条目首败即停、不进 backoff（「失败 = 可能已
 *   执行」，重试买不到安全性）+ 普通条目失败仍有限重试（对照）
 *
 * 运行：cd packages/session-delivery && npx vitest run tests/delivery-command-lane.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryMessage } from '../src/types.js'
import { makeMockPort } from './helpers.js'

/** port.send 悬挂兜底阈值（与 delivery.ts PORT_SEND_SETTLE_TIMEOUT_MS 同值——测试推进量级锚定；模块私有故本处同值镜像）。 */
const PORT_SEND_SETTLE_TIMEOUT_MS = 60_000

function msg(content: string): DeliveryMessage {
  return { payload: { kind: 'text', content } }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('G3 闸②：settle 兜底按命令条目豁免（D14③②）', () => {
  it('命令条目：port.send 永不 settle → 60s 兜底不强制失败（挂起语义成立）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const port = makeMockPort({
        send: () => new Promise(() => {}), // 永不 settle（模拟命令 handler 内 await 用户交互）
      })
      const handle = createDelivery(port)
      const checked = handle.sendChecked(msg('/permission rule'), { id: 'cmd-1', isCommand: true })
      // 越过兜底阈值（60s）+ 余量：命令条目不被墙钟切成失败形态（条目仍留守 active——
      // sendChecked 受理前条目态为 queued，强制失败会把它从内核移除）
      await vi.advanceTimersByTimeAsync(120_000)
      expect(handle.entriesFull().active.some((e) => e.id === 'cmd-1')).toBe(true)
      expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('port.send hung'))).toBe(false)
      // 收口（防悬挂泄漏）：dispose reject 挂账
      handle.dispose()
      await expect(checked).rejects.toThrow()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('对照：普通条目同形态 → 60s 兜底强制失败（极端形态照旧收口，不因豁免失效）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const port = makeMockPort({
        send: () => new Promise(() => {}),
      })
      const handle = createDelivery(port)
      handle.send(msg('普通消息'))
      await vi.advanceTimersByTimeAsync(PORT_SEND_SETTLE_TIMEOUT_MS + 1_000)
      // 强制失败 → backoff 重试链（默认 max=50 未到 → 条目留守 queued 重试）
      expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('port.send hung'))).toBe(true)
      expect(handle.entriesFull().active.length).toBeGreaterThan(0)
      handle.dispose()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('D14⑥：非 checked 通路命令条目首败即停', () => {
  it('send() 通路命令条目：首败从内核移除，不进 backoff（port.send 恰一次）', async () => {
    let calls = 0
    const port = makeMockPort({
      send: () => {
        calls += 1
        return Promise.reject(new Error('port rejected'))
      },
    })
    const handle = createDelivery(port)
    // 非 checked 提交（send()）的命令条目：isCommand 经 opts 随条目下发（D14⑥）
    handle.send(msg('/todos'), { isCommand: true })
    await vi.advanceTimersByTimeAsync(1_000) // 越过默认 backoff.ms=100 若干倍
    await Promise.resolve()
    // 首败即停：条目已移除（无 tombstone——未进通道无判重语义），无重试
    expect(calls).toBe(1)
    expect(handle.entriesFull().active.some((e) => e.payload.kind === 'text' && e.payload.content === '/todos')).toBe(false)
    expect(handle.entriesFull().tombstones.length).toBe(0)
  })

  it('对照：普通条目失败进有限重试（backoff 到点重发，行为不变）', async () => {
    let calls = 0
    const port = makeMockPort({
      send: () => {
        calls += 1
        if (calls === 1) return Promise.reject(new Error('transient'))
        return Promise.resolve()
      },
    })
    const handle = createDelivery(port)
    handle.send(msg('普通消息'))
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    // backoff 到点重试成功：条目受理转 in-flight
    expect(calls).toBe(2)
    expect(handle.entriesFull().active.some((e) => e.state === 'in-flight')).toBe(true)
  })

  it('checked 命令条目：首败 reject 即停（入口即拦语义，与普通 checked 同形态）', async () => {
    const port = makeMockPort({
      send: () => Promise.reject(new Error('port down')),
    })
    const handle = createDelivery(port)
    const checked = handle.sendChecked(msg('/plan'), { id: 'cmd-2', isCommand: true })
    await expect(checked).rejects.toThrow('port down')
    await Promise.resolve()
    expect(handle.entriesFull().active.some((e) => e.id === 'cmd-2')).toBe(false)
    handle.dispose()
  })
})
