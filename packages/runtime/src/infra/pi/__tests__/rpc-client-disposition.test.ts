/**
 * RpcClient disposition 出口挂载测试（pi 1.0.0 B3「解析与传递」）。
 *
 * 锁定：sendCommand 统一出口解析响应 data.disposition 并挂到 PiMessage.disposition
 * 透传上层——prompt/steer/follow_up 三命令的响应带值（'handled'/'queued'/'started'），
 * 其余命令响应与 pi < 1.0.0（无该字段）保持无键；非法值（协议漂移）解析为 undefined
 * + warn 可观测，不影响 resolve。
 *
 * 策略：共享 mock 骨架（test/helpers/rpc-client-mock.ts 工厂转发），响应帧经
 * emitPiLine 注入（LF-only 读取器分帧），请求 id 取 lastWrittenJson() 配对。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/rpc-client-disposition.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RpcClient } from '../rpc-client.js'
import { emitPiLine, lastWrittenJson, resetRpcClientMock } from '../../../../test/helpers/rpc-client-mock.js'

// ── Mocks（工厂转发模式，见 test/helpers/rpc-client-mock.ts 使用说明）──

vi.mock('node:child_process', async () =>
  (await import('../../../../test/helpers/rpc-client-mock.js')).childProcessModule())

vi.mock('@taiji/shared', async () =>
  (await import('../../../../test/helpers/rpc-client-mock.js')).sharedModule())

vi.mock('@taiji/shared/paths', async () =>
  (await import('../../../../test/helpers/rpc-client-mock.js')).sharedPathsModule())

vi.mock('node:os', async () =>
  (await import('../../../../test/helpers/rpc-client-mock.js')).osModule())

vi.mock('../pi-paths.js', async () =>
  (await import('../../../../test/helpers/rpc-client-mock.js')).piPathsModule())

vi.mock('../pi-provider-store.js', async () =>
  (await import('../../../../test/helpers/rpc-client-mock.js')).piProviderStoreModule())

vi.mock('../../logger.js', async () => {
  const m = await import('../../../../test/helpers/rpc-client-mock.js')
  // 补 writePiCrashLog：本套件不触发 crash 路径，缺导出时 import 为 undefined 也不炸，
  // 与 bash-timeout 内联骨架保持同面以防后续用例误触
  return { ...m.loggerModule(), writePiCrashLog: vi.fn() }
})

async function startClient(): Promise<RpcClient> {
  const client = new RpcClient()
  const startP = client.start()
  await vi.advanceTimersByTimeAsync(0)
  await startP
  return client
}

/** 注入 prompt 响应帧（id 与最后一条请求配对，形态对齐 pi rpc-mode success 构造）。 */
function emitResponse(data: Record<string, unknown>): void {
  const { id } = lastWrittenJson()
  emitPiLine({ type: 'response', id, command: 'prompt', success: true, data })
}

describe('RpcClient disposition 出口挂载（B3 传递）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRpcClientMock()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // steer/followUp 是 sendCommand 薄包装（rpc-client 直通），与 prompt 共享同一出口挂载
  // ——参数化 (method, disposition) 单表覆盖三命令，失败消息可定位具体命令与值
  it.each<[method: 'prompt' | 'steer' | 'followUp', disposition: string]>([
    ['prompt', 'handled'],
    ['prompt', 'queued'],
    ['prompt', 'started'],
    ['steer', 'queued'],
    ['steer', 'handled'],
    ['followUp', 'queued'],
    ['followUp', 'handled'],
  ])('%s 响应 data.disposition=%s → msg.disposition（data 原样保留）', async (method, disposition) => {
    const client = await startClient()
    const p = client[method]('hello')
    emitResponse({ disposition, sessionId: 's1' })
    const msg = await p
    expect(msg.disposition).toBe(disposition)
    expect(msg.data).toEqual({ disposition, sessionId: 's1' })
    await client.kill()
  })

  it('响应无 disposition（pi 1.0.0 前 / 其余命令）：无键挂载，行为与现状一致', async () => {
    const client = await startClient()
    const p = client.prompt('hello')
    emitResponse({ sessionId: 's1' })
    const msg = await p
    expect(msg.disposition).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(msg, 'disposition')).toBe(false)
    await client.kill()
  })

  it('非法值（协议漂移）：解析 undefined + warn，不 reject 不挂键', async () => {
    const warnSpy = vi.mocked(console.warn)
    const client = await startClient()
    const p = client.prompt('hello')
    emitResponse({ disposition: 'maybe' })
    const msg = await p
    expect(msg.disposition).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(msg, 'disposition')).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('disposition 非法值'))
    await client.kill()
  })
})
