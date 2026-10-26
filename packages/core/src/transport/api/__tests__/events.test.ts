// events.test.ts —— core C29 簇合并产物（round5-G）。
// 共同被测业务模块：`src/transport/api/events.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/transport/api/__tests__/events.test.ts（13 用例，skip 0）
//   - src/transport/api/__tests__/plugin-domain-events.test.ts（5 用例，skip 0）

import { describe, it, expect, vi, afterEach } from 'vitest'
import { type ServerMessage } from '@taiji/shared'
import { on, off, dispatchSession, onGlobal, onGlobalType, dispatchGlobal, onCrossSession, dispatchCrossSession, _probeSessionHandlerEntryCount } from '../events'
import * as events from '../events'
import { onPluginEvent, onPluginCrashed } from '../domains/plugin'

// ======== 来源：events.test.ts ========
describe("events", () => {
  function msg(type: string, payload: Record<string, unknown> = {}): ServerMessage {
    return { type: type as ServerMessage['type'], payload } as ServerMessage
  }

  // 模块级 handler 注册表会跨用例残留：每个用例结束后无法批量清理（无公开 API），
  // 用「取消函数收尾」保证每条用例自己注册的 handler 不影响后续断言（计数基于各自 spy）
  const unsubscribers: Array<() => void> = []

  afterEach(() => {
    for (const u of unsubscribers.splice(0)) u()
  })

  describe('events session 通道', () => {
    it('on → dispatchSession 按 sessionId 路由，其他 sid 收不到', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      unsubscribers.push(on('s1', h1))
      unsubscribers.push(on('s2', h2))
      dispatchSession('s1', msg('message.text_delta', { sessionId: 's1' }))
      expect(h1).toHaveBeenCalledTimes(1)
      expect(h2).not.toHaveBeenCalled()
    })

    it('off / 取消函数后不再接收', () => {
      const h = vi.fn()
      const un = on('s1', h)
      un()
      dispatchSession('s1', msg('message.text_delta'))
      expect(h).not.toHaveBeenCalled()
      // off 对已移除 handler no-op 不抛
      expect(() => off('s1', h)).not.toThrow()
    })

    it('同 sid 多 handler 全部收到；handler 抛错不中断其余（M4）', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const ok = vi.fn()
      const boom = () => {
        throw new Error('boom')
      }
      unsubscribers.push(on('s1', boom))
      unsubscribers.push(on('s1', ok))
      dispatchSession('s1', msg('message.text_delta'))
      expect(ok).toHaveBeenCalledTimes(1)
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })

    it('dispatchSession 无订阅者 no-op 不抛', () => {
      expect(() => dispatchSession('ghost', msg('message.text_delta'))).not.toThrow()
    })
  })

  describe('events session 通道 off 删空 Set（B2 / 2026-09-14 内存审计 §2.3）', () => {
    it('最后一个 handler 退订后 Map 无残留条目；非空 Set 保留；on 可重建（语义不变）', () => {
      // 探针日志已降级 debug 级（memory-leak-remediation §4 验收收尾），spy 目标同步对齐
      const logSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      const before = _probeSessionHandlerEntryCount()
      const h1 = vi.fn()
      const h2 = vi.fn()
      const un1 = on('leak-check', h1)
      on('leak-check', h2)
      // 订阅建立条目
      expect(_probeSessionHandlerEntryCount()).toBe(before + 1)
      // 退一个：Set 非空 → 条目保留（h2 仍可收）
      un1()
      expect(_probeSessionHandlerEntryCount()).toBe(before + 1)
      dispatchSession('leak-check', msg('message.text_delta'))
      expect(h2).toHaveBeenCalledTimes(1)
      // 退最后一个：Set 空 → Map 条目删除（无空 Set 永久残留）
      off('leak-check', h2)
      expect(_probeSessionHandlerEntryCount()).toBe(before)
      // on 会重建——再次订阅可正常接收
      const h3 = vi.fn()
      unsubscribers.push(on('leak-check', h3))
      dispatchSession('leak-check', msg('message.text_delta'))
      expect(h3).toHaveBeenCalledTimes(1)
      logSpy.mockRestore()
    })

    it('off 对不存在的 sessionId no-op（不创建空条目）', () => {
      const before = _probeSessionHandlerEntryCount()
      expect(() => off('ghost-sid', vi.fn())).not.toThrow()
      expect(_probeSessionHandlerEntryCount()).toBe(before)
    })
  })

  describe('events global 通道', () => {
    it('onGlobal 收所有全局消息；取消后不收', () => {
      const h = vi.fn()
      const un = onGlobal(h)
      dispatchGlobal(msg('config.providers', { providers: [] }))
      expect(h).toHaveBeenCalledTimes(1)
      un()
      dispatchGlobal(msg('config.providers'))
      expect(h).toHaveBeenCalledTimes(1)
    })

    it('onGlobalType 按 type 路由，其他 type 收不到；取消后不收', () => {
      const h = vi.fn()
      const un = onGlobalType('model.list', h)
      dispatchGlobal(msg('model.list', { models: [] }))
      dispatchGlobal(msg('config.providers'))
      expect(h).toHaveBeenCalledTimes(1)
      un()
      dispatchGlobal(msg('model.list'))
      expect(h).toHaveBeenCalledTimes(1)
    })

    it('dispatchGlobal 同时触达 all-handler 与匹配 type 的 handler', () => {
      const all = vi.fn()
      const typed = vi.fn()
      unsubscribers.push(onGlobal(all))
      unsubscribers.push(onGlobalType('config.skills', typed))
      dispatchGlobal(msg('config.skills', { skills: [] }))
      expect(all).toHaveBeenCalledTimes(1)
      expect(typed).toHaveBeenCalledTimes(1)
    })

    it('global type handler 抛错被隔离（M4），all-handler 仍执行', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const all = vi.fn()
      const un = onGlobalType('config.plugins', () => {
        throw new Error('boom')
      })
      unsubscribers.push(un, onGlobal(all))
      expect(() => dispatchGlobal(msg('config.plugins'))).not.toThrow()
      expect(all).toHaveBeenCalledTimes(1)
      errSpy.mockRestore()
    })
  })

  describe('events crossSession 通道（ADR-0060）', () => {
    it('onCrossSession → dispatchCrossSession 闭环；取消后不收', () => {
      const h = vi.fn()
      const un = onCrossSession(h)
      dispatchCrossSession(msg('extension:widget', { sessionId: 's1' }))
      expect(h).toHaveBeenCalledTimes(1)
      un()
      dispatchCrossSession(msg('extension:widget'))
      expect(h).toHaveBeenCalledTimes(1)
    })

    it('crossSession handler 抛错被隔离（M4）', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const ok = vi.fn()
      const un = onCrossSession(() => {
        throw new Error('boom')
      })
      unsubscribers.push(un, onCrossSession(ok))
      expect(() => dispatchCrossSession(msg('extension:widget'))).not.toThrow()
      expect(ok).toHaveBeenCalledTimes(1)
      errSpy.mockRestore()
    })

    it('无订阅者 dispatchCrossSession no-op 不抛', () => {
      expect(() => dispatchCrossSession(msg('extension:widget'))).not.toThrow()
    })
  })
});

// ======== 来源：plugin-domain-events.test.ts ========
describe("plugin-domain-events", () => {
  describe('onPluginEvent 订阅（D9 renderer 接收段）', () => {
    it("global 帧 'plugin:event' → 订阅回调收到 payload（pluginId/channel/payload 透传）", () => {
      const handler = vi.fn()
      const off = onPluginEvent(handler)

      events.dispatchGlobal({
        type: 'plugin:event',
        payload: { pluginId: 'wool-workbuddy', channel: 'credential-status', payload: { loggedIn: false } },
      } as never)

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({
        pluginId: 'wool-workbuddy',
        channel: 'credential-status',
        payload: { loggedIn: false },
      })
      off()
    })

    it('取消订阅后不再接收（off 生效）', () => {
      const handler = vi.fn()
      const off = onPluginEvent(handler)
      off()

      events.dispatchGlobal({
        type: 'plugin:event',
        payload: { pluginId: 'p', channel: 'c', payload: null },
      } as never)

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('onPluginCrashed 订阅（S13 崩溃广播，payload 窄化）', () => {
    it("global 帧 'plugin:crashed' → handler 收到窄化 payload（pluginId 必带，workerId/error 字符串时展开）", () => {
      const handler = vi.fn()
      const off = onPluginCrashed(handler)

      events.dispatchGlobal({
        type: 'plugin:crashed',
        payload: { pluginId: 'wool-workbuddy', workerId: 'worker-1', error: 'oom' },
      } as never)

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ pluginId: 'wool-workbuddy', workerId: 'worker-1', error: 'oom' })
      off()
    })

    it('workerId/error 非字符串时不带对应键（wire payload 未契约化的防御窄化）', () => {
      const handler = vi.fn()
      const off = onPluginCrashed(handler)

      events.dispatchGlobal({
        type: 'plugin:crashed',
        payload: { pluginId: 'wool-workbuddy', workerId: 42, error: null },
      } as never)

      expect(handler).toHaveBeenCalledWith({ pluginId: 'wool-workbuddy' })
      off()
    })

    it('pluginId 缺失或空串 → 帧被丢弃（handler 不触发）', () => {
      const handler = vi.fn()
      const off = onPluginCrashed(handler)

      events.dispatchGlobal({ type: 'plugin:crashed', payload: { workerId: 'w' } } as never)
      events.dispatchGlobal({ type: 'plugin:crashed', payload: { pluginId: '' } } as never)

      expect(handler).not.toHaveBeenCalled()
      off()
    })
  })
});
