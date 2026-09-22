/**
 * useGenStats 单测 —— composer-gen-stats P4 层 1
 * （验收条款：帧写入分区 / model 不匹配丢弃 / model 缺省丢弃 / 恢复腿 in-flight 去重 / cleanup）。
 *
 * 范式照抄 use-context-usage.test.ts（五件套蓝本的层 1 测试形态）：
 * - mock 边界：session.getGenStats RPC 经 '@taiji/core/transport/api' command 部分mock
 *   掉（spread actual 保留 events 真实通道，transport 层不在本层职责）；事件分发走真实
 *   events.dispatchSession 通道；
 * - 宿主组件：useSessionEvents 的 getCurrentInstance 守卫要求组件 setup 上下文，mount 宿主
 *   expose composable 返回值；
 * - timer：实现内无 timer（恢复腿去重靠 Promise 原语），in-flight 窗口用受控 deferred +
 *   setTimeout(0) macrotask 排空微任务链驱动（与蓝本同款，无 timer 依赖故无需 fake timers）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/gen-stats-composable.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import * as events from '@taiji/core/transport/api'
import { RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'
import {
  useGenStats,
  genStatsModelMatches,
  __clearInFlightGenStatsForTest,
  type UseGenStatsReturn,
} from '@/composables/features/model/useGenStats'
import type { GenStatsFrame } from '@taiji/shared'

// ── mock 边界：getGenStats RPC mock 掉（u3 未接线，恢复腿用受控 deferred 驱动）──
// mock 目标 = 实现 import 的权威路径（u5 re-anchor 删除 @/api/request bridge 后）；
// spread actual 只换 command/超时常量：useSessionEvents 经主模块 events.on 订阅，须保留
// 真实 events 通道（测试侧 dispatchSession 与实现侧订阅经同一真实 events 模块实例，注册表
// 共享），否则帧链路断
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})

// ── 共享测试基建 ─────────────────────────────────────────────

/** 帧工厂：合法全量帧为基线（含 ttft，composer-genstats-ttft U4），用例按需覆写 */
function genFrame(sessionId: string, overrides: Partial<GenStatsFrame> = {}): GenStatsFrame {
  return {
    sessionId,
    speed: { current: 35, day: 28, d7: 22, d30: 19 },
    cacheRatio: { current: 91, day: 87 },
    ttft: { current: 820, day: 900, d7: 1100, d30: 1300 },
    model: 'm1',
    ...overrides,
  }
}

/** 真实 events.dispatchSession 通道派发 session.stats_update 帧 */
function dispatchFrame(sid: string, frame: GenStatsFrame): void {
  events.dispatchSession(sid, { type: 'session.stats_update', payload: frame })
}

/** 在途 RPC 的受控 deferred（mock 发起时登记） */
interface PendingRpc {
  sid: string
  resolve: (v: GenStatsFrame) => void
  reject: (e: unknown) => void
}

let pendingRpcs: PendingRpc[] = []
const mountedWrappers: VueWrapper[] = []

interface HostHandle {
  sidRef: ReturnType<typeof ref<string | null>>
  modelIdRef: ReturnType<typeof ref<string | undefined>>
  gen: UseGenStatsReturn
}

/**
 * 测试宿主组件：在 setup 内调 useGenStats（useSessionEvents 的 getCurrentInstance
 * 守卫要求组件 setup 上下文），expose 返回值（对齐 use-context-usage.test.ts 形态）。
 */
function mountHost(initialSid: string | null, initialModel?: string): HostHandle {
  const sidRef = ref<string | null>(initialSid)
  const modelIdRef = ref<string | undefined>(initialModel)
  const wrapper = mount(
    defineComponent({
      setup() {
        const gen = useGenStats(sidRef, modelIdRef)
        return { gen }
      },
      render: () => h('div'),
    }),
  )
  mountedWrappers.push(wrapper)
  // vm 属性经 test-utils 暴露为宽类型；断言前运行时守卫收缩（禁裸 as）
  const candidate = (wrapper.vm as { gen?: unknown }).gen
  if (!candidate || typeof candidate !== 'object' || !('current' in candidate)) {
    throw new Error('host 组件未暴露 gen')
  }
  return { sidRef, modelIdRef, gen: candidate as UseGenStatsReturn }
}

/**
 * 排空在途异步链。setTimeout(0) 是 macrotask：事件循环保证其回调执行前，所有已排队
 * 微任务（promise 链 → 写分区，以及 Vue 调度器 flush）全部跑完。
 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

/** resolve 指定 sid 的最早已登记在途 RPC（无则测试编排错误） */
function resolveForSid(sid: string, reply: GenStatsFrame): void {
  const idx = pendingRpcs.findIndex((e) => e.sid === sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.resolve(reply)
}

/** reject 指定 sid 的最早已登记在途 RPC */
function rejectForSid(sid: string, err: unknown): void {
  const idx = pendingRpcs.findIndex((e) => e.sid === sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.reject(err)
}

beforeEach(() => {
  pendingRpcs = []
  commandMock.mockReset()
  commandMock.mockImplementation(
    (_type: string, payload: { sessionId: string }) =>
      new Promise<GenStatsFrame>((resolve, reject) => {
        pendingRpcs.push({ sid: payload.sessionId, resolve, reject })
      }),
  )
  __clearSessionCleanupRegistryForTest()
  __clearInFlightGenStatsForTest()
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
})

// ── 帧 handler（订阅 + model 校验兜底）──────────────────────

describe('帧 handler：写入分区与 model 校验兜底', () => {
  it('合法帧（model 与当前 modelId 匹配）→ 写入分区，current 反映帧内容（含 ttft 透传，composer-genstats-ttft U4）', async () => {
    const host = mountHost('A', 'prov-a/m1')
    await settle()

    dispatchFrame('A', genFrame('A', { model: 'm1' }))
    await settle()

    expect(host.gen.current.value).not.toBeNull()
    expect(host.gen.current.value?.speed.current).toBe(35)
    expect(host.gen.current.value?.cacheRatio.current).toBe(91)
    expect(host.gen.current.value?.model).toBe('m1')
    // useGenStats 零改动（帧本体直存分区）→ frame.ttft 随帧自动透传，null 编码不打折扣
    expect(host.gen.current.value?.ttft).toEqual({ current: 820, day: 900, d7: 1100, d30: 1300 })
  })

  it('帧内 model 与当前 modelId 不匹配 → 丢弃（分区保持 null）', async () => {
    const host = mountHost('A', 'prov-a/m1')
    await settle()

    // 脏映射空窗的脏帧：session 已切 m2，旧模型 m1 的帧到达 → 无害丢弃
    dispatchFrame('A', genFrame('A', { model: 'prov-b/m2' }))
    await settle()

    expect(host.gen.current.value).toBeNull()
  })

  it('帧内 model 缺省 → 丢弃（live 推帧路径均有 model，缺省即异常）', async () => {
    const host = mountHost('A', 'prov-a/m1')
    await settle()

    const noModel = genFrame('A')
    delete noModel.model
    dispatchFrame('A', noModel)
    await settle()

    expect(host.gen.current.value).toBeNull()
  })

  it('帧内 model 为裸 id、当前 modelId 为复合 id（后缀段相等）→ 接受（帧 model 格式待验证检查点的双形态兼容）', async () => {
    const host = mountHost('A', 'prov-a/m1')
    await settle()

    dispatchFrame('A', genFrame('A', { model: 'm1' }))
    await settle()

    expect(host.gen.current.value?.model).toBe('m1')
  })

  it('renderer 侧 modelId 未知（undefined）→ 无法判定不匹配，放行（保守丢弃会误杀合法帧）', async () => {
    const host = mountHost('A', undefined)
    await settle()

    dispatchFrame('A', genFrame('A', { model: 'prov-b/m2' }))
    await settle()

    expect(host.gen.current.value?.model).toBe('prov-b/m2')
  })

  it('genStatsModelMatches：精确相等 / 复合后缀相等 / 其余不匹配', () => {
    expect(genStatsModelMatches('prov-a/m1', 'prov-a/m1')).toBe(true)
    expect(genStatsModelMatches('m1', 'prov-a/m1')).toBe(true)
    expect(genStatsModelMatches('prov-a/m1', 'prov-a/m2')).toBe(false)
    expect(genStatsModelMatches('m2', 'prov-a/m1')).toBe(false)
    expect(genStatsModelMatches('m1', 'm1-extra')).toBe(false)
  })
})

// ── 恢复腿（RPC + in-flight 去重 + recency 守卫）────────────

describe('恢复腿：getGenStats RPC', () => {
  it('挂载即触发恢复腿，reply（含全 null 帧）写入分区且不经 model 校验', async () => {
    const host = mountHost('A', 'prov-a/m1')
    await settle()
    expect(commandMock).toHaveBeenCalledWith(
      'session.getGenStats',
      { sessionId: 'A' },
      RPC_BACKSTOP_TIMEOUT_MS,
    )

    // runtime 降级链④回的全 null + model 缺省帧：RPC 主动拉取语义，不经前端帧校验
    const reply = genFrame('A', {
      speed: { current: null, day: null, d7: null, d30: null },
      cacheRatio: { current: null, day: null },
    })
    delete reply.model
    resolveForSid('A', reply)
    await settle()

    expect(host.gen.current.value).toEqual(reply)
  })

  it('in-flight 去重：多实例切入同一 sid 复用同一次 RPC，resolve 后各写各分区', async () => {
    const host1 = mountHost('A', 'prov-a/m1')
    const host2 = mountHost('A', 'prov-a/m1')
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(1)

    resolveForSid('A', genFrame('A'))
    await settle()

    expect(host1.gen.current.value?.speed.current).toBe(35)
    expect(host2.gen.current.value?.speed.current).toBe(35)
  })

  it('settle 即清条目：resolve 后重新切入同一 sid 重拉（无条件恢复腿）', async () => {
    const host = mountHost('A', 'prov-a/m1')
    await settle()
    resolveForSid('A', genFrame('A', { speed: { current: 10, day: null, d7: null, d30: null } }))
    await settle()

    // 切走再切回：第二次进入视图重新发起 RPC（不依赖分区缓存时效）
    host.sidRef.value = null
    await settle()
    host.sidRef.value = 'A'
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(2)

    resolveForSid('A', genFrame('A', { speed: { current: 20, day: null, d7: null, d30: null } }))
    await settle()
    expect(host.gen.current.value?.speed.current).toBe(20)
  })

  it('recency 守卫：RPC 发起后已有更新 live 帧落地 → 陈旧 reply 跳过写入（不回滚 newer 帧）', async () => {
    const host = mountHost('A', 'prov-a/m1')
    await settle()

    // RPC 在途期间，live 帧先落地
    dispatchFrame('A', genFrame('A', { speed: { current: 99, day: null, d7: null, d30: null } }))
    await settle()
    expect(host.gen.current.value?.speed.current).toBe(99)

    // 陈旧 reply（RPC 发起时尚无帧）后到：跳过写入
    resolveForSid('A', genFrame('A', { speed: { current: 1, day: null, d7: null, d30: null } }))
    await settle()
    expect(host.gen.current.value?.speed.current).toBe(99)
  })

  it('RPC 失败：保留分区缓存不降级，下次切入重拉自愈', async () => {
    const host = mountHost('A', 'prov-a/m1')
    await settle()
    dispatchFrame('A', genFrame('A'))
    await settle()
    expect(host.gen.current.value?.speed.current).toBe(35)

    // 切走再切回，第二次 RPC 失败
    host.sidRef.value = null
    await settle()
    host.sidRef.value = 'A'
    await settle()
    rejectForSid('A', new Error('transport unavailable'))
    await settle()

    // 分区缓存仍在（失败兜底显示）
    expect(host.gen.current.value?.speed.current).toBe(35)
  })
})

// ── cleanup（deleteSession 编排 + 抑制表生命周期）────────────

describe('cleanup：分区清理与抑制表', () => {
  it('triggerSessionCleanups → 分区移除（current 重新惰性 init 为 null）', async () => {
    const host = mountHost('A', 'prov-a/m1')
    await settle()
    dispatchFrame('A', genFrame('A'))
    await settle()
    expect(host.gen.current.value?.speed.current).toBe(35)

    triggerSessionCleanups('A')
    await nextTick()
    expect(host.gen.current.value).toBeNull()
  })

  it('cleanup 后迟到帧 / 在途 reply 不得僵尸式写回；重新进入视图解除抑制', async () => {
    const host = mountHost('A', 'prov-a/m1')
    await settle()

    // 清理后：迟到帧被抑制
    triggerSessionCleanups('A')
    await nextTick()
    dispatchFrame('A', genFrame('A'))
    await settle()
    expect(host.gen.current.value).toBeNull()

    // 重新进入视图 = 新生命周期：抑制解除，帧恢复写入
    host.sidRef.value = null
    await settle()
    host.sidRef.value = 'A'
    await settle()
    dispatchFrame('A', genFrame('A', { speed: { current: 42, day: null, d7: null, d30: null } }))
    await settle()
    expect(host.gen.current.value?.speed.current).toBe(42)
  })

  it('cleanup 后在途 RPC resolve 不写回（抑制优先于 recency）', async () => {
    const host = mountHost('A', 'prov-a/m1')
    await settle()

    triggerSessionCleanups('A')
    await nextTick()
    resolveForSid('A', genFrame('A'))
    await settle()
    expect(host.gen.current.value).toBeNull()
  })
})
