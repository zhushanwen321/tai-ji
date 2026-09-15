// select-rpc.test.ts — D8：select+marker 通道 RPC 原语（传输核 + 失败折叠契约）
// + 错误回包形状单源化（ChannelErrorResult / 两 alias）。
//
// 设计权威源：docs/architecture/ext-simplify-17-shared-extraction.md §3.3 D8（v7 冻结形态）。
// 经 barrel（../index）导入：单测同时锚定新增导出面。

import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import {
  callMarkerRpc,
  isChannelErrorResult,
  formatChannelErrorText,
  type ChannelErrorResult,
  type GuiContext,
  type MarkerRpcResult,
  type SessionManagerErrorResult,
  type BridgeErrorResponse,
} from '../index'

const MARKER = '\x00TEST_MARKER'

type SelectImpl = (
  marker: string,
  options: string[],
  opts?: { signal?: AbortSignal; timeout?: number },
) => Promise<string | undefined>

/** mock ctx：select 实现由用例注入（缺省 resolve undefined） */
function makeCtx(impl?: SelectImpl): { ctx: GuiContext; selectMock: ReturnType<typeof vi.fn> } {
  const selectMock = vi.fn(impl ?? (async () => undefined))
  const ctx: GuiContext = { mode: 'rpc', hasUI: true, ui: { select: selectMock } }
  return { ctx, selectMock }
}

describe('callMarkerRpc 传输核', () => {
  it('成功：value 恒 raw string（不 parse 消费）+ select 参数透传（marker / [payload] / signal+timeout）', async () => {
    const raw = '{"queued":true}'
    const signal = new AbortController().signal
    const { ctx, selectMock } = makeCtx(async () => raw)

    const result = await callMarkerRpc(ctx, MARKER, '{"action":"send"}', { signal, timeout: 3_000 })

    expect(result).toEqual({ ok: true, value: raw })
    expect(selectMock).toHaveBeenCalledTimes(1)
    expect(selectMock).toHaveBeenCalledWith(MARKER, ['{"action":"send"}'], { signal, timeout: 3_000 })
  })

  it('回包 undefined + signal 已 abort → cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx } = makeCtx(async () => undefined)

    const result: MarkerRpcResult = await callMarkerRpc(ctx, MARKER, 'p', { signal: controller.signal })

    expect(result).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('回包 undefined 无 signal → timeout（pi 四路不可区分，其余折叠 timeout）', async () => {
    const { ctx } = makeCtx(async () => undefined)
    const result = await callMarkerRpc(ctx, MARKER, 'p')
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('回包 undefined + signal 在场未 abort → timeout', async () => {
    const signal = new AbortController().signal
    const { ctx } = makeCtx(async () => undefined)
    const result = await callMarkerRpc(ctx, MARKER, 'p', { signal })
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('回包 null → timeout（null 与 undefined 同折叠）', async () => {
    const { ctx } = makeCtx(async () => null as unknown as undefined)
    const result = await callMarkerRpc(ctx, MARKER, 'p')
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('select throw → channel-error + log 留痕（msg + reason detail）', async () => {
    const log = vi.fn()
    const { ctx } = makeCtx(async () => {
      throw new Error('channel closed')
    })

    const result = await callMarkerRpc(ctx, MARKER, 'p', { log })

    expect(result).toEqual({ ok: false, reason: 'channel-error' })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('threw')
    expect(log.mock.calls[0][1]).toMatchObject({ reason: 'channel closed' })
  })

  it('select throw 非 Error → reason 折叠为 String', async () => {
    const log = vi.fn()
    const { ctx } = makeCtx(async () => {
      throw 'string error'
    })

    const result = await callMarkerRpc(ctx, MARKER, 'p', { log })

    expect(result).toEqual({ ok: false, reason: 'channel-error' })
    expect(log.mock.calls[0][1]).toMatchObject({ reason: 'string error' })
  })

  it('非 JSON 回包 → non-json + log 留痕（responseHead 预览）', async () => {
    const log = vi.fn()
    const { ctx } = makeCtx(async () => 'plain text response')

    const result = await callMarkerRpc(ctx, MARKER, 'p', { log })

    expect(result).toEqual({ ok: false, reason: 'non-json' })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('non-JSON')
    expect(log.mock.calls[0][1]).toMatchObject({ responseHead: 'plain text response' })
  })

  it('非 JSON 回包超长 → responseHead 截断到 200（防大 payload 刷屏）', async () => {
    const log = vi.fn()
    const long = 'x'.repeat(500)
    const { ctx } = makeCtx(async () => long)

    await callMarkerRpc(ctx, MARKER, 'p', { log })

    expect((log.mock.calls[0][1] as { responseHead: string }).responseHead).toHaveLength(200)
  })

  it('合法 JSON 原始字符串（含对象/数字字面量形态）→ ok:true 恒 raw', async () => {
    const { ctx } = makeCtx(async () => '123')
    const result = await callMarkerRpc(ctx, MARKER, 'p')
    expect(result).toEqual({ ok: true, value: '123' })
  })

  it('回包非 string（pi 契约外形态）→ channel-error + log 留痕', async () => {
    const log = vi.fn()
    const { ctx } = makeCtx(async () => 42 as unknown as string)

    const result = await callMarkerRpc(ctx, MARKER, 'p', { log })

    expect(result).toEqual({ ok: false, reason: 'channel-error' })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('non-string')
  })

  it('ui.select 缺席 → throw 明确错误（前置判定归调用方，沿 ask-user 先例）', async () => {
    const ctx: GuiContext = { mode: 'rpc', hasUI: true }
    await expect(callMarkerRpc(ctx, MARKER, 'p')).rejects.toThrow(/ctx\.ui\.select/)
  })

  it('失败态不传 log → 不留痕也不抛（日志策略归调用方）', async () => {
    const { ctx } = makeCtx(async () => undefined)
    const result = await callMarkerRpc(ctx, MARKER, 'p')
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })
})

describe('D8 错误回包形状单源化', () => {
  describe('isChannelErrorResult', () => {
    it('{error: string} → true', () => {
      expect(isChannelErrorResult({ error: 'boom' })).toBe(true)
    })
    it('{error, hint} → true（hint 可选不校验类型）', () => {
      expect(isChannelErrorResult({ error: 'boom', hint: 'retry later' })).toBe(true)
    })
    it('error 非 string → false', () => {
      expect(isChannelErrorResult({ error: 42 })).toBe(false)
    })
    it('无 error 字段 → false', () => {
      expect(isChannelErrorResult({})).toBe(false)
      expect(isChannelErrorResult({ hint: 'only hint' })).toBe(false)
    })
    it('null / 非对象 → false', () => {
      expect(isChannelErrorResult(null)).toBe(false)
      expect(isChannelErrorResult('error')).toBe(false)
      expect(isChannelErrorResult(undefined)).toBe(false)
    })
    it('数组 → false（排数组，与 isRecord 语义对齐）', () => {
      expect(isChannelErrorResult([{ error: 'x' }])).toBe(false)
    })
    it('SessionManagerErrorResult 交集扩展（含 sessionId）→ true', () => {
      expect(isChannelErrorResult({ error: 'send failed', sessionId: 's1', hint: 'h' })).toBe(true)
    })
  })

  describe('formatChannelErrorText', () => {
    it('hint 缺席 → 只回 error', () => {
      expect(formatChannelErrorText({ error: 'boom' })).toBe('boom')
    })
    it('hint 在场 → error + hint 两行拼接', () => {
      expect(formatChannelErrorText({ error: 'boom', hint: 'check status' })).toBe('boom\nhint: check status')
    })
  })

  describe('两 alias 的 public API 兼容（导出名与文件位置不变，零破坏）', () => {
    it('SessionManagerErrorResult 构造赋值：runtime session-manager-handler 活构造形态', () => {
      // 对应 packages/runtime/src/transport/session-manager-handler.ts 的构造序列：
      // const errorResult: SessionManagerErrorResult = { error: toErrorMessage(e) }
      // if (createdId) { errorResult.sessionId = createdId; errorResult.hint = '...' }
      const errorResult: SessionManagerErrorResult = { error: 'spawn failed' }
      const createdId = (new Error('later step failed') as { sessionId?: string }).sessionId
      if (createdId) {
        errorResult.sessionId = createdId
        errorResult.hint = 'use send_to_session to retry'
      }
      expect(errorResult.error).toBe('spawn failed')
      // 交集扩展命中共享守卫；sessionId 字段不进错误文本（session-manager 现状语义）
      expect(isChannelErrorResult(errorResult)).toBe(true)
      expect(formatChannelErrorText(errorResult)).toBe('spawn failed')
    })

    it('BridgeErrorResponse = ChannelErrorResult alias：值与文本拼接互通', () => {
      const base: ChannelErrorResult = { error: 'plugin down', hint: 'check runtime logs' }
      const bridge: BridgeErrorResponse = base
      expect(isChannelErrorResult(bridge)).toBe(true)
      expect(formatChannelErrorText(bridge)).toBe('plugin down\nhint: check runtime logs')
    })
  })

  describe('GuiContext select opts 类型声明', () => {
    it('opts 类型含 timeout（协议声明补齐 = pi ExtensionUIDialogOptions 实装，typecheck 即证）', async () => {
      const ctx: GuiContext = {
        mode: 'rpc',
        hasUI: true,
        ui: {
          select: (_header, _options, opts) => {
            expectTypeOf(opts).toEqualTypeOf<{ signal?: AbortSignal; timeout?: number } | undefined>()
            return Promise.resolve(undefined)
          },
        },
      }
      await expect(callMarkerRpc(ctx, MARKER, 'p')).resolves.toEqual({ ok: false, reason: 'timeout' })
    })
  })
})
