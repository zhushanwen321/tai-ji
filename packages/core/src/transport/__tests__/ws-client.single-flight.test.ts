// ws-client 单飞防并存测试（移动端「同页多 WS 连接并存（半死）」复验问题的防回归）。
//
// 根因（修复前）：connect() 幂等守卫只拦 OPEN/CONNECTING——CLOSING（close 握手未完成，
// 移动弱网下可悬挂数秒~分钟）的旧 socket 会被模块变量直接覆盖并开新连接；且 connect() /
// scheduleReconnect 均不清挂起的退避定时器，三个重连入场口（退避定时器 / visibility 切
// 前台 / token 重试）在 CLOSING 窗口与定时器窗口交错即叠出多个并存 socket（半死 = CLOSING
// 悬挂）。
//
// 修复后不变量（本文件锁定）：
// 1. 单飞守卫：存在非 CLOSED socket 时 connect() 一律 no-op（新连接建立前旧连接必须 closed）。
// 2. 单一定时器：connect() 放行时清挂起重连定时器；scheduleReconnect 覆盖前清旧 handle。
// 3. close 配对：任意驱动序列的任意时点，非 CLOSED socket 至多一个（create 与 close 配对收敛）。
//
// 运行：cd packages/core && npx vitest run src/transport/__tests__/ws-client.single-flight.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { providePlatform, WS_READY_STATE } from '../../platform/port'
import { connect, disconnect, getState, setFailed } from '../ws-client'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

// ── 测试平台注入（fake websocket factory，每次 create 产出新 fake 并登记）──
let fakes: FakeWebSocket[]

function installTestPlatform(): void {
  fakes = []
  providePlatform({
    kind: 'mock',
    storage: {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    webSocket: {
      create: () => {
        const f = createFakeWebSocket()
        fakes.push(f)
        return f
      },
    },
  })
}

function latestFake(): FakeWebSocket {
  expect(fakes.length).toBeGreaterThan(0)
  return fakes[fakes.length - 1]
}

/** close 配对不变量：任意时点非 CLOSED（存活/悬挂）socket 至多一个。 */
function expectAtMostOneAlive(): void {
  const alive = fakes.filter((f) => f.readyState !== WS_READY_STATE.CLOSED)
  expect(alive.length).toBeLessThanOrEqual(1)
}

describe('ws-client 单飞防并存', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect() // 重置模块级单例状态（上轮残留连接/定时器）
  })
  afterEach(() => {
    disconnect()
    // setFailed 复位重连簿记（reconnectAttempts / reconnectStartedAt——disconnect 刻意不重置，
    // 仅 markConnected / setFailed 复位），防用例间泄漏使退避时值依赖执行历史
    setFailed()
    vi.useRealTimers()
  })

  it('旧 socket CLOSING（close 握手未完成）时 connect 不放行；onclose 到达后由退避链接力建新连接', () => {
    // 复现路径：token 模式 open → auth 5s 超时 → close() 发出但 close 事件未送达（弱网悬挂）
    connect('ws://test', { auth: 'token', token: 'tok-sf1' })
    const f1 = latestFake()
    f1.triggerOpen() // auth 帧已发，authTimer(5s) 已挂
    vi.advanceTimersByTime(5_000) // auth 超时 → ws.close()（fake 置 CLOSED；此处再改回 CLOSING 模拟 close 事件未送达）
    expect(f1.closeCalls).toBe(1)
    f1.setReadyState(WS_READY_STATE.CLOSING)
    expect(getState().value).toBe('connecting') // auth 超时不置态，仍处握手期

    // 外部 connect（visibility 切前台 / token 重试等价入场）：CLOSING 悬挂期不放行
    connect('ws://test', { auth: 'token', token: 'tok-sf1' })
    expect(fakes.length).toBe(1) // 未创建新 WS
    expectAtMostOneAlive()

    // close 事件最终送达 → onclose → 退避链接力 → 新连接（且唯一）
    f1.triggerClose()
    expect(getState().value).toBe('reconnecting')
    vi.advanceTimersByTime(1_000)
    expect(fakes.length).toBe(2)
    expect(f1.readyState).toBe(WS_READY_STATE.CLOSED) // 旧 socket 已死透
    expectAtMostOneAlive()
  })

  it('connect() 放行时清挂起的退避定时器：外部 connect 与退避链不叠成双链双建连', () => {
    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()
    latestFake().triggerClose() // onclose → 退避 T1@1s
    expect(getState().value).toBe('reconnecting')

    // 外部 connect（visibility 等价）：旧 socket 已 CLOSED → 放行建 #2，T1 应被清
    connect('ws://test', { auth: 'skip' })
    expect(fakes.length).toBe(2)
    const f2 = latestFake()

    // #2 立即失败 → onclose → 退避 T2@2s（attempts=2）
    f2.triggerClose()
    expect(getState().value).toBe('reconnecting')

    // T1 原到期点（1s）：定时器已清，无提前建连（修复前 T1 在此放行建 #3）
    vi.advanceTimersByTime(1_000)
    expect(fakes.length).toBe(2)
    expectAtMostOneAlive()

    // T2 到期（2s）：退避链接力建 #3（正常收敛，唯一活跃）
    vi.advanceTimersByTime(1_000)
    expect(fakes.length).toBe(3)
    expectAtMostOneAlive()
  })

  it('CONNECTING 期间重复 connect（重复 init 等价）不新建 WS', () => {
    connect('ws://test', { auth: 'skip' })
    expect(fakes.length).toBe(1)
    connect('ws://test', { auth: 'skip' })
    expect(fakes.length).toBe(1)
    expect(getState().value).toBe('connecting')
    expectAtMostOneAlive()
  })

  it('failed 后重试（connect 再入场）：旧 socket 已 CLOSED → 放行重建，重连预算已重置', () => {
    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()
    // 驱动至 failed（重连时长上限 60s，循环模式对齐 invariants ⑤）
    let guard = 0
    while (getState().value !== 'failed' && guard < 30) {
      latestFake().triggerClose()
      vi.advanceTimersByTime(30_000)
      guard++
    }
    expect(getState().value).toBe('failed')
    const lenAtFail = fakes.length
    expectAtMostOneAlive()

    // 用户重试 / 重复 init 再入场：ws CLOSED → 放行，state 离开 failed
    connect('ws://test', { auth: 'skip' })
    expect(fakes.length).toBe(lenAtFail + 1)
    expect(getState().value).toBe('connecting')
    expectAtMostOneAlive()
  })

  it('混合驱动序列不变量：open/close/重连/外部 connect 任意交错后非 CLOSED socket 至多一个', () => {
    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()
    expectAtMostOneAlive()

    // 已连接时重复 connect（外部入场口）→ 拦
    connect('ws://test', { auth: 'skip' })
    expect(fakes.length).toBe(1)

    latestFake().triggerClose() // 断线 → 退避
    connect('ws://test', { auth: 'skip' }) // 外部提前重连（旧 CLOSED → 放行 + 清 T1）
    expect(fakes.length).toBe(2)
    expectAtMostOneAlive()

    vi.advanceTimersByTime(5_000) // 被清的 T1 不会建连；#2 仍 CONNECTING
    expect(fakes.length).toBe(2)

    latestFake().triggerClose() // #2 失败 → 退避（attempts=2 → delay 4s）
    vi.advanceTimersByTime(4_000) // 退避链建 #3
    expect(fakes.length).toBe(3)
    expectAtMostOneAlive()

    // 主动断开后重复 connect（disconnect 置 ws=null → 放行）
    disconnect()
    connect('ws://test', { auth: 'skip' })
    expect(fakes.length).toBe(4)
    expectAtMostOneAlive()
  })
})
