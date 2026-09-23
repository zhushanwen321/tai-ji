import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rpc } from '../ws-client.js'
import { _resetWarnOnceForTest } from '../../utils/warn-once.js'

vi.mock('../port-discovery.js', () => ({
  discoverPort: vi.fn(() => 3210),
}))

/** S1-W1：rpc 现在要求 <dataDir>/runtime-token 存在（token 分发通道②），测试注入临时数据目录 */
const TEST_TOKEN = 'cli-test-token-0123456789abcdef'
let testDataDir = ''

beforeAll(() => {
  testDataDir = mkdtempSync(join(tmpdir(), 'taiji-cli-ws-test.'))
  mkdirSync(testDataDir, { recursive: true })
  writeFileSync(join(testDataDir, 'runtime-token'), TEST_TOKEN)
  process.env.TAIJI_AGENT_DATA_DIR = testDataDir
})

afterAll(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  if (testDataDir) rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** mock WebSocket：EventEmitter 桩（手动 emit open/message 驱动 rpc 状态机） */
let lastMockWs: InstanceType<typeof import('ws').WebSocket> & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }

vi.mock('ws', () => {
  const EventEmitter = require('events')
  return {
    WebSocket: class extends EventEmitter {
      send = vi.fn()
      close = vi.fn()
      constructor(..._args: unknown[]) {
        super()
        lastMockWs = this as never
      }
    },
  }
})

describe('rpc', () => {
  // [2026-09 测试舰队审查 r2-27] 首用例「sends message with correct type and payload」已删：
  // 只断言 `toBeInstanceOf(Promise)` 且不 emit open——零交互恒真占位（红灯期遗迹）；
  // auth 握手与命令发送语义由 S1-W1 系用例承担。

  it('S1-W1: open 后首条消息是 auth（携带 token 文件内容），auth ok 后才发实际命令', async () => {
    const promise = rpc('config.getProviders', { extra: 1 })
    // open 触发首条消息
    lastMockWs.emit('open')
    // 首条消息必须是 auth + token 文件内容
    expect(lastMockWs.send).toHaveBeenCalledTimes(1)
    const firstMsg = JSON.parse(String((lastMockWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0]))
    expect(firstMsg).toEqual({ type: 'auth', payload: { token: TEST_TOKEN } })
    // auth.result ok 之前不发实际命令
    lastMockWs.emit('message', Buffer.from(JSON.stringify({ type: 'auth.result', payload: { ok: true } })))
    expect(lastMockWs.send).toHaveBeenCalledTimes(2)
    const secondMsg = JSON.parse(String((lastMockWs.send as ReturnType<typeof vi.fn>).mock.calls[1][0]))
    expect(secondMsg.type).toBe('config.getProviders')
    expect(secondMsg.payload).toEqual({ extra: 1 })
    // reply 到达 → resolve（信封解包后的 payload）+ close——调用方按 payload 字段读取
    // （reply.providers / reply.models…），信封字段（id/type）不外泄
    const replyId = secondMsg.id
    lastMockWs.emit('message', Buffer.from(JSON.stringify({ id: replyId, payload: { providers: [] } })))
    await expect(promise).resolves.toEqual({ providers: [] })
    expect(lastMockWs.close).toHaveBeenCalled()
  })

  it('S1-W1: auth 失败（ok=false）时 reject 且不发实际命令', async () => {
    const promise = rpc('config.getProviders', {})
    lastMockWs.emit('open')
    lastMockWs.emit('message', Buffer.from(JSON.stringify({ type: 'auth.result', payload: { ok: false, reason: 'bad_token' } })))
    await expect(promise).rejects.toThrow(/auth failed/)
    // 只发过 auth 一条，业务命令未发出
    expect(lastMockWs.send).toHaveBeenCalledTimes(1)
  })

  it('RT-8#1: error envelope（type=error 复用请求 id）→ reject 带 code+message，不得 resolve', async () => {
    const promise = rpc('config.deleteProvider', { providerId: 'ghost' })
    lastMockWs.emit('open')
    lastMockWs.emit('message', Buffer.from(JSON.stringify({ type: 'auth.result', payload: { ok: true } })))
    const secondMsg = JSON.parse(String((lastMockWs.send as ReturnType<typeof vi.fn>).mock.calls[1][0]))
    // broker sendError 的 wire 形状：{ type:'error', id, payload:{ code, message } }（同 id 复用）
    lastMockWs.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      id: secondMsg.id,
      payload: { code: 'PROVIDER_NOT_FOUND', message: 'Provider "ghost" not found' },
    })))
    // 此前此处 resolve {code,message} payload → 调用方按字段读 undefined → 假成功
    const err = await promise.then(
      () => { throw new Error('expected reject, got resolve') },
      (e: Error & { code?: string }) => e,
    )
    expect(err.message).toContain('PROVIDER_NOT_FOUND')
    expect(err.message).toContain('Provider "ghost" not found')
    expect(err.code).toBe('PROVIDER_NOT_FOUND')
    expect(lastMockWs.close).toHaveBeenCalled()
  })

  it('RT-8#13: 非 JSON 帧（心跳/半帧）不打断 RPC，但 warn-once 出声（附帧样本 + dropCount）', async () => {
    _resetWarnOnceForTest()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const promise = rpc('config.getProviders', {})
      lastMockWs.emit('open')
      lastMockWs.emit('message', Buffer.from(JSON.stringify({ type: 'auth.result', payload: { ok: true } })))
      const secondMsg = JSON.parse(String((lastMockWs.send as ReturnType<typeof vi.fn>).mock.calls[1][0]))
      // 非 JSON 帧：此前静默 ignore（零留痕）；随后正常 reply 必须仍能 resolve（不被打断）
      lastMockWs.emit('message', Buffer.from('\x00\x01not-json-at-all'))
      lastMockWs.emit('message', Buffer.from(JSON.stringify({ id: secondMsg.id, payload: { providers: [] } })))
      await expect(promise).resolves.toEqual({ providers: [] })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const warned = String(warnSpy.mock.calls[0]![0])
      expect(warned).toContain('丢弃 1 帧')
      expect(warned).toContain('config.getProviders')
      expect(warned).toContain('not-json-at-all')
    } finally {
      warnSpy.mockRestore()
      _resetWarnOnceForTest()
    }
  })

  it('rejects on timeout', async () => {
    // verify 5s timeout behavior
    await expect(
      rpc('config.getProviders', {}, { timeoutMs: 100 })
    ).rejects.toThrow(/timeout/)
  })
})
