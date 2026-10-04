// sessionEntry 端口束装配断言（remote-use D2/U5）+ core toast 通道装配断言（remote-use
// A7/U14）。
//
// 锁定移动壳切入链装配对齐桌面的三件事（验收口径 = 装配面，非 12 步链本体——链编排在
// core use-session.test.ts 既有覆盖）：
//   1. 三成员（ensureStreamSubscription/touchRecency/evictLru）非 no-op——以行为证明：
//      no-op 调用零可观测效果，真实接线各有确定的可观测投影（events 订阅 / LRU recency
//      写入 / 驱逐退订 RPC）
//   2. cancelActiveFlow/preloadFileTree 保持缺省 no-op（headless 形态契约，D2 采用段：
//      移动壳无 new-task flow 活跃取消面与文件树；clearUnread 同批缺省——未读体系属 W4）。
//      可判定形式 = 端口束对象无这些键（use-session 链内 ?? noop 解析缺省）——比「调了没
//      效果」更强，防止空函数注入假装缺省
//   3. evictLru 接 core 驱逐+退订复合入口（evictLruWithUnsubscribe）：超阈值驱逐时被驱逐
//      会话收到 session.unsubscribe RPC，保留区零 RPC
//
// U14（A7）：core toast 通道（coreChannelDeps + subDeps 两处注入）= 错误条通道（error-bar
// 单槽单例），非 console——core 失败面（revoke/stop/bash/compact 等 RPC 失败）对用户可见。
//
// mock 策略：仅 transport 出口（streamSubscribe/unsubscribe）模块级 vi.mock 隔离 WS，
// app-runtime 组装与 core 链保持全真实（对齐 mobile-new-task.spec「mock 组件层会变成
// 断言 mock 自身」的同款立场）。断言入口 = __testing 命名空间（对齐 companion-bridge
// __testing 先例：生产代码禁止消费，仅测试 import——不扩大 API 面常驻语义）。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  _lruSizeForTest,
  _resetLruForTest,
  resetChatModuleStateForTest,
} from '@taiji/core'
// app-runtime 组装在 vi.mock 注册（hoist 先于全部 import 生效）后解析——transport 出口
// 已是替身，组装链其余保持真实
import { __testing, chatStore } from '../app-runtime'
import { errorBarMessage, resetErrorBarForTest } from '../error-bar'

const { mockStreamSubscribe, mockUnsubscribe } = vi.hoisted(() => ({
  mockStreamSubscribe: vi.fn(() => vi.fn()),
  mockUnsubscribe: vi.fn(() => Promise.resolve()),
}))

vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/chat')>()
  return { ...actual, streamSubscribe: mockStreamSubscribe }
})
vi.mock('@taiji/core/transport/api/domains/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/session')>()
  return { ...actual, unsubscribe: mockUnsubscribe }
})

const sessionEntry = __testing.sessionEntry

/** 构造 count 个分区（hydrate 内部 lruTouch 记 recency），插入序 = recency 旧→新 */
function seedPartitions(count: number): string[] {
  const sids = Array.from({ length: count }, (_, i) => `u5-evt-${i}`)
  for (const sid of sids) chatStore.hydrate(sid, [])
  return sids
}

describe('sessionEntry 端口束装配（D2/U5）', () => {
  beforeEach(() => {
    _resetLruForTest()
    resetChatModuleStateForTest()
    mockStreamSubscribe.mockClear()
    mockUnsubscribe.mockClear()
  })

  it('结构：三成员齐备为函数；cancelActiveFlow/preloadFileTree/clearUnread 无键（缺省 no-op 契约）', () => {
    expect(typeof sessionEntry.ensureStreamSubscription).toBe('function')
    expect(typeof sessionEntry.touchRecency).toBe('function')
    expect(typeof sessionEntry.evictLru).toBe('function')
    // headless 形态契约（D2 采用段）：三成员不注入，use-session 链内 ?? noop 解析——
    // 键缺失断言防止空函数注入假装缺省
    expect('cancelActiveFlow' in sessionEntry).toBe(false)
    expect('preloadFileTree' in sessionEntry).toBe(false)
    expect('clearUnread' in sessionEntry).toBe(false)
  })

  it('ensureStreamSubscription 非 no-op：调用即建立 events 订阅（streamSubscribe 出口命中）', () => {
    sessionEntry.ensureStreamSubscription!('u5-sub-sid')
    expect(mockStreamSubscribe).toHaveBeenCalledTimes(1)
    expect(mockStreamSubscribe).toHaveBeenCalledWith('u5-sub-sid', expect.any(Function))
  })

  it('touchRecency 非 no-op：调用即写入 LRU recency（时序表非空）', () => {
    sessionEntry.touchRecency!('u5-touch-sid')
    expect(_lruSizeForTest()).toBeGreaterThanOrEqual(1)
  })

  it('evictLru 非 no-op：超阈值驱逐时被驱逐会话收到 unsubscribe RPC，保留区零 RPC', () => {
    // 9 分区 > LRU_MAX_SESSIONS(8)：插入序最前的 u5-evt-0 被驱逐（同毫秒时间戳稳定排序保留插入序）
    const sids = seedPartitions(9)

    // panelSessionId 透传形态对齐 core 链步 12（null = 无焦点 panel；实现侧执行驱逐本体）
    sessionEntry.evictLru!(null)

    // 复合入口语义（core lru-unsubscribe.test.ts 全量覆盖，此处锁装配接线正确）：
    // 被驱逐会话发 session.unsubscribe；保留区 8 个零 RPC
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
    expect(mockUnsubscribe).toHaveBeenCalledWith(sids[0])
    // 驱逐本体生效（分区 + hydrated 同删）
    expect(chatStore.isHydrated(sids[0]!)).toBe(false)
    expect(chatStore.isHydrated(sids[1]!)).toBe(true)
  })

  it('evictLru 未超阈值：零驱逐零 RPC（幂等安全）', () => {
    seedPartitions(8)

    sessionEntry.evictLru!(null)

    expect(mockUnsubscribe).not.toHaveBeenCalled()
  })
})

describe('core toast 通道装配（A7/U14）', () => {
  beforeEach(() => {
    resetErrorBarForTest()
  })

  it('toast 注入 = 错误条通道（非 console）：error 调用即写入错误条单槽', () => {
    // core 失败面形态实调（useChat 侧 deps.toast.error(deps.t(...)) 的翻译后文案直入）
    __testing.errorBarToast.error('composable.revokeFailed 文案')

    expect(errorBarMessage.value).toBe('composable.revokeFailed 文案')
  })

  it('warning 同入错误条单槽（移动壳无分级 toast 组件，error/warning 同一出口）', () => {
    __testing.errorBarToast.warning('需用户处置的信号')

    expect(errorBarMessage.value).toBe('需用户处置的信号')
  })

  it('单槽覆盖式（core 通道与错误条既有形态一致）：后到覆盖前条', () => {
    __testing.errorBarToast.error('first')
    __testing.errorBarToast.error('second')

    expect(errorBarMessage.value).toBe('second')
  })
})
