/**
 * model-thinking-memory 单元测试。
 *
 * 被测对象：domain/composer/model-thinking-memory.ts —— 模型档位记忆存储原语
 * （reactive Map + 惰性预载 + KV 写穿）。
 *
 * 策略：KV 用内存 stub 实现 KVStorage 接口（get/set/remove），可注入——
 * 读失败（failGetError）/ 写失败（failSetError）/ 损坏原始值（rawGet）/
 * 慢读（closeGate 挂起 get，openGateNow 控制加载完成时点）。
 * platform 经 providePlatform 注入 stub（模块经 getPlatform().storage 读 KV）。
 *
 * 时序：模块无 timer，异步只有微任务链（KV promise / 写穿链），
 * 一个 setTimeout(0) 宏任务边界即可全部落地，无需 fake timers。
 *
 * 运行：cd packages/core && pnpm vitest run src/domain/composer/model-thinking-memory.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  providePlatform,
  __resetPlatformForTesting,
  type KVStorage,
  type PlatformPort,
} from '../../platform/port'
import {
  MODEL_THINKING_MEMORY_KEY,
  __resetModelThinkingMemoryForTesting,
  loadOnce,
  lookup,
  onLoaded,
  record,
} from './model-thinking-memory'

/** KV 内存 stub：peek 看落盘值，setWrites 记录每次写穿（key + 序列化值）。 */
class StubKV implements KVStorage {
  private map = new Map<string, string>()
  /** 非 undefined 时 get 直接返回该原始串（注入损坏 JSON / 非对象 JSON 场景） */
  rawGet: string | undefined
  failGetError: Error | null = null
  failSetError: Error | null = null
  getCalls = 0
  setWrites: Array<[string, string]> = []
  private gate: Promise<void> | null = null
  private open: (() => void) | null = null

  /** initialTable：预置在权威 key 下的整表数据（构造时即序列化，模拟已持久化的记忆） */
  constructor(initialTable?: Record<string, string>) {
    if (initialTable) {
      this.map.set(MODEL_THINKING_MEMORY_KEY, JSON.stringify(initialTable))
    }
  }

  /** 关闸：之后的 get 挂起直到 openGateNow（控制预载完成时点） */
  closeGate(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve
    })
  }

  openGateNow(): void {
    this.open?.()
    this.open = null
  }

  async get(key: string): Promise<string | null> {
    this.getCalls++
    if (this.gate) await this.gate
    if (this.failGetError) throw this.failGetError
    if (this.rawGet !== undefined) return this.rawGet
    return this.map.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.setWrites.push([key, value])
    if (this.failSetError) throw this.failSetError
    this.map.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }

  /** 同步看当前落盘值（测试断言用） */
  peek(key: string): string | null {
    return this.map.get(key) ?? null
  }
}

function provideStubKV(stub: KVStorage): void {
  const port: PlatformPort = {
    kind: 'mock',
    storage: stub,
    // 本模块测试只走 storage 端口；webSocket 若被触达即测试写错，直接抛错暴露
    webSocket: {
      create: () => {
        throw new Error('stub: WebSocketFactory 未在本测试使用')
      },
    },
  }
  providePlatform(port)
}

/** 冲一个宏任务边界：挂起的 KV promise / 微任务链（含写穿链）全部落地 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** 解析落盘的整表（断言 KV 值格式：Record<复合串, ThinkingLevel>） */
function persistedTable(stub: StubKV): Record<string, string> {
  const raw = stub.peek(MODEL_THINKING_MEMORY_KEY)
  return raw ? (JSON.parse(raw) as Record<string, string>) : {}
}

describe('model-thinking-memory', () => {
  beforeEach(() => {
    __resetModelThinkingMemoryForTesting()
  })

  afterEach(() => {
    __resetPlatformForTesting()
    vi.restoreAllMocks()
  })

  it('round-trip：record 写穿 KV → 重置内存态重载 → lookup 读回（G2 持久化语义）', async () => {
    const stub = new StubKV()
    provideStubKV(stub)
    // 生产时序：u4 组装时先触发预载，record 随后到达（加载前 record 只写内存，写穿挂起）
    loadOnce()
    await flushAsync()
    record('builtin:bigmodel-coding-plan/GLM-5.3', 'max')
    record('builtin:bigmodel-coding-plan/GLM-5.3-Flash', 'high')
    await flushAsync()
    // key 值格式校验：权威 localStorage key + Record<复合串 key, ThinkingLevel value>
    // 两次 record（loaded 态）各写穿一次，链序保证最终落盘为最新全量表
    expect(stub.setWrites).toHaveLength(2)
    expect(stub.setWrites[0][0]).toBe('taiji:model-thinking-memory')
    expect(stub.setWrites[0][0]).toBe(MODEL_THINKING_MEMORY_KEY)
    expect(persistedTable(stub)).toEqual({
      'builtin:bigmodel-coding-plan/GLM-5.3': 'max',
      'builtin:bigmodel-coding-plan/GLM-5.3-Flash': 'high',
    })
    // 模拟重启：内存态重置（KV 保留），预载后记忆完整读回
    __resetModelThinkingMemoryForTesting()
    expect(lookup('builtin:bigmodel-coding-plan/GLM-5.3')).toBeUndefined()
    loadOnce()
    await flushAsync()
    expect(lookup('builtin:bigmodel-coding-plan/GLM-5.3')).toBe('max')
    expect(lookup('builtin:bigmodel-coding-plan/GLM-5.3-Flash')).toBe('high')
  })

  it('E1：KV JSON 损坏 → 空表启动（不抛不吞），record 仍可写穿自愈', async () => {
    const stub = new StubKV()
    stub.rawGet = '{"p/m1": "max",'
    provideStubKV(stub)
    const cb = vi.fn()
    onLoaded(cb)
    loadOnce()
    await flushAsync()
    expect(lookup('p/m1')).toBeUndefined()
    // 空表启动也是有效加载：回调照常触发（下游补重设依赖此语义）
    expect(cb).toHaveBeenCalledTimes(1)
    // 损坏不阻断后续写穿
    record('p/m1', 'low')
    await flushAsync()
    expect(persistedTable(stub)).toEqual({ 'p/m1': 'low' })
  })

  it('E1（补充）：KV 值为合法 JSON 但非对象（数组/字符串/null/数字）→ 按空表处理', async () => {
    for (const raw of ['["p/m1","max"]', '"p/m1"', 'null', '42']) {
      __resetModelThinkingMemoryForTesting()
      const stub = new StubKV()
      stub.rawGet = raw
      provideStubKV(stub)
      loadOnce()
      await flushAsync()
      expect(lookup('p/m1')).toBeUndefined()
    }
  })

  it('E1：KV get 抛错 → 空表启动，加载状态正常推进（完成后注册的回调立即触发）', async () => {
    const stub = new StubKV({ 'p/m1': 'max' })
    stub.failGetError = new Error('kv read boom')
    provideStubKV(stub)
    loadOnce()
    await flushAsync()
    expect(lookup('p/m1')).toBeUndefined()
    const cb = vi.fn()
    onLoaded(cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('E6：record 非法档位值 → 拦截，内存与 KV 均无写入', async () => {
    const stub = new StubKV()
    provideStubKV(stub)
    loadOnce()
    await flushAsync()
    record('p/m1', 'ultra')
    record('p/m1', '')
    record('p/m1', 'MAX') // 枚举值大小写敏感
    await flushAsync()
    expect(lookup('p/m1')).toBeUndefined()
    expect(stub.setWrites).toHaveLength(0)
  })

  it('E6：KV 含非法档位条目 → 加载时丢弃该条，合法条目保留', async () => {
    const stub = new StubKV({ 'p/ok': 'max', 'p/bad-str': 'quantum', 'p/bad-num': '3' })
    provideStubKV(stub)
    loadOnce()
    await flushAsync()
    expect(lookup('p/ok')).toBe('max')
    expect(lookup('p/bad-str')).toBeUndefined()
    expect(lookup('p/bad-num')).toBeUndefined()
  })

  it('E2：KV 写失败 → console.warn，内存表继续生效（不回滚）', async () => {
    const stub = new StubKV()
    stub.failSetError = new Error('kv write boom')
    provideStubKV(stub)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadOnce()
    await flushAsync()
    record('p/m1', 'high')
    await flushAsync()
    expect(lookup('p/m1')).toBe('high')
    expect(stub.setWrites).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(stub.peek(MODEL_THINKING_MEMORY_KEY)).toBeNull()
  })

  it('E7②：onLoaded 加载前注册 → 完成后触发一次；加载在途时 lookup 返回 undefined（E7①）', async () => {
    const stub = new StubKV({ 'p/m1': 'max' })
    stub.closeGate()
    provideStubKV(stub)
    const cb = vi.fn()
    onLoaded(cb)
    loadOnce()
    expect(cb).not.toHaveBeenCalled()
    expect(lookup('p/m1')).toBeUndefined()
    stub.openGateNow()
    await flushAsync()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(lookup('p/m1')).toBe('max')
  })

  it('E7②：onLoaded 加载完成后注册 → 立即同步触发（无需 await）', async () => {
    const stub = new StubKV()
    provideStubKV(stub)
    loadOnce()
    await flushAsync()
    const cb = vi.fn()
    onLoaded(cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('loadOnce 幂等：重复调用（含加载完成后）不重复读 KV', async () => {
    const stub = new StubKV({ 'p/m1': 'max' })
    provideStubKV(stub)
    loadOnce()
    loadOnce()
    await flushAsync()
    loadOnce()
    await flushAsync()
    expect(stub.getCalls).toBe(1)
    expect(lookup('p/m1')).toBe('max')
  })

  it('加载窗口内 record：内存值优先不被 KV 旧快照覆写，加载完成后补写收敛 KV', async () => {
    const stub = new StubKV({ 'p/m1': 'low', 'p/m2': 'high' })
    stub.closeGate()
    provideStubKV(stub)
    loadOnce()
    // KV 快照在途（旧值 low）时 record 新值——挂起写穿，不能拿局部表覆写整表
    record('p/m1', 'max')
    stub.openGateNow()
    await flushAsync()
    expect(lookup('p/m1')).toBe('max')
    expect(lookup('p/m2')).toBe('high')
    // 补写收敛：落盘为合并后的完整表（而非只有 p/m1 的局部快照）
    expect(persistedTable(stub)).toEqual({ 'p/m1': 'max', 'p/m2': 'high' })
  })

  it('重置隔离：__reset 后内存清空、状态回 idle、遗留回调与挂起写被丢弃', async () => {
    const stub = new StubKV({ 'p/m1': 'max' })
    provideStubKV(stub)
    const stale = vi.fn()
    onLoaded(stale)
    // idle 期 record：挂起写穿，重置后该挂起被丢弃（KV 不落局部快照）
    record('p/m2', 'low')
    __resetModelThinkingMemoryForTesting()
    expect(lookup('p/m2')).toBeUndefined()
    expect(stub.setWrites).toHaveLength(0)
    loadOnce()
    await flushAsync()
    // 未消费回调已清；重新预载只读回 KV 既有条目
    expect(stale).not.toHaveBeenCalled()
    expect(lookup('p/m1')).toBe('max')
    expect(lookup('p/m2')).toBeUndefined()
  })
})
