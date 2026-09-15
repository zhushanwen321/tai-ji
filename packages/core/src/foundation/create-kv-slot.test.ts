/**
 * createKVSlot 单元测试。
 *
 * 被测对象：foundation/create-kv-slot.ts —— KV 单键槽位工厂（state-truth-sync
 * §3.3 D9 KV 单键族收编：三态惰性预载 / 加载窗口守卫 / deferred 补写 / 写穿串行链 /
 * 容错 warn / validate 钩子）。
 *
 * 策略：KV 用内存 stub 实现 KVStorage 接口，经 providePlatform 注入（工厂经
 * getPlatform().storage 读写 KV）——同 model-thinking-memory.test.ts 既有先例。
 * 双形态覆盖：单值形态（last-used-model 镜像）与整表 Map 形态（model-thinking-memory
 * 镜像）各建一套「容器 + 钩子」组装，验证工厂对值形态参数化中立。
 *
 * 时序：工厂无 timer，异步只有微任务链（KV promise / 写穿链），一个 setTimeout(0)
 * 宏任务边界即可全部落地，无需 fake timers。
 *
 * 运行：cd packages/core && pnpm vitest run src/foundation/create-kv-slot.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  providePlatform,
  __resetPlatformForTesting,
  type KVStorage,
  type PlatformPort,
} from '../platform/port'
import { createKVSlot, type KVSlot, type KVSlotOptions } from './create-kv-slot'

/** KV 内存 stub：可控时序（读闸门 loadGate / 写闸门 setGate）+ 读/写失败注入 + 落盘观测。 */
class StubKV implements KVStorage {
  private map = new Map<string, string>()
  /** 非 undefined 时 get 直接返回该原始串（注入损坏 JSON / 非对象 JSON 场景） */
  rawGet: string | undefined
  failGetError: Error | null = null
  failSetError: Error | null = null
  getCalls = 0
  setWrites: Array<[string, string]> = []
  /** 读闸门：非 null 时 get 挂起直到 releaseLoadGate（控制预载完成时点） */
  private loadGate: Promise<void> | null = null
  private openLoad: (() => void) | null = null
  /** 写闸门：armed 后的下一次 set 挂起直到 releaseSetGate（写串行链用例观测交错） */
  private setGate: Promise<void> | null = null
  private openSet: (() => void) | null = null

  /** initial：预置在 KV 的键值对（value 为已序列化字符串，模拟已持久化数据） */
  constructor(initial?: Record<string, string>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) this.map.set(k, v)
    }
  }

  /** 关读闸门：之后的 get 挂起直到 releaseLoadGate */
  closeLoadGate(): void {
    this.loadGate = new Promise((resolve) => {
      this.openLoad = resolve
    })
  }

  releaseLoadGate(): void {
    this.openLoad?.()
    this.openLoad = null
  }

  /** armed 写闸门：下一次 set 先记录调用再挂起（可断言「已开始未完成」） */
  armSetGate(): void {
    this.setGate = new Promise((resolve) => {
      this.openSet = resolve
    })
  }

  releaseSetGate(): void {
    this.openSet?.()
    this.openSet = null
  }

  async get(key: string): Promise<string | null> {
    this.getCalls++
    if (this.loadGate) await this.loadGate
    if (this.failGetError) throw this.failGetError
    if (this.rawGet !== undefined) return this.rawGet
    return this.map.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.setWrites.push([key, value])
    if (this.setGate) {
      const gate = this.setGate
      this.setGate = null
      await gate
    }
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
    // 本工厂测试只走 storage 端口；webSocket 若被触达即测试写错，直接抛错暴露
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 单值形态组装（last-used-model 镜像）：容器 = 普通局部变量（工厂不依赖容器响应式——
 * 响应式是调用侧关注点，此处用 plain 容器验证工厂中立）。
 */
function assembleSingleValueSlot(
  key: string,
  overrides?: Partial<KVSlotOptions<string>>,
): { get: () => string | undefined; write: (v: string) => void; reset: () => void } & KVSlot {
  let value: string | undefined
  const slot = createKVSlot<string>(key, {
    tag: 'test-single',
    parseSnapshot: (parsed) => (typeof parsed === 'string' ? parsed : undefined),
    mergeSnapshot: (v) => {
      if (value === undefined) value = v
    },
    serialize: () => JSON.stringify(value),
    ...overrides,
  })
  return {
    ...slot,
    get: () => value,
    write: (v: string) => slot.record(v, () => { value = v }),
    reset: () => {
      value = undefined
      slot.__resetForTesting()
    },
  }
}

/**
 * 整表 Map 形态组装（model-thinking-memory 镜像）：容器 = plain Map（KV 单键存整个表），
 * merge 内建「内存已有值优先」加载窗口守卫。
 */
function assembleMapSlot(
  key: string,
  overrides?: Partial<KVSlotOptions<Record<string, string>>>,
): { map: Map<string, string>; writeEntry: (k: string, v: string) => void; reset: () => void } & KVSlot {
  const map = new Map<string, string>()
  const slot = createKVSlot<Record<string, string>>(key, {
    tag: 'test-map',
    parseSnapshot: (parsed) => (isPlainObject(parsed) ? (parsed as Record<string, string>) : undefined),
    mergeSnapshot: (table) => {
      for (const [k, v] of Object.entries(table)) {
        if (!map.has(k)) map.set(k, v)
      }
    },
    serialize: () => JSON.stringify(Object.fromEntries(map)),
    ...overrides,
  })
  return {
    ...slot,
    map,
    writeEntry: (k: string, v: string) => slot.record(v, () => map.set(k, v)),
    reset: () => {
      map.clear()
      slot.__resetForTesting()
    },
  }
}

describe('createKVSlot · 加载窗口守卫（Map 值形态）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    __resetPlatformForTesting()
    vi.restoreAllMocks()
  })

  it('未加载时 record 不丢：在途 KV 旧快照不覆写内存新值，加载完成后补写落盘完整收敛', async () => {
    const stub = new StubKV({ sk: JSON.stringify({ m1: 'old', m2: 'keep' }) })
    stub.closeLoadGate()
    provideStubKV(stub)
    const slot = assembleMapSlot('sk')

    slot.loadOnce() // KV get 在途
    slot.writeEntry('m1', 'new') // 加载窗口内 record——内存立即可见，写穿挂起
    expect(slot.map.get('m1')).toBe('new')

    stub.releaseLoadGate()
    await flushAsync()
    // 窗口守卫：KV 旧快照的 m1:'old' 不覆写内存新值；快照其余条目正常并入
    expect(slot.map.get('m1')).toBe('new')
    expect(slot.map.get('m2')).toBe('keep')
    // deferred 补写收敛：落盘为合并后的完整表（而非只有 m1 的局部快照）
    expect(stub.peek('sk')).toBe(JSON.stringify({ m1: 'new', m2: 'keep' }))
  })

  it('加载完成前 record 零写穿——补写只在加载完成后发生', async () => {
    const stub = new StubKV({ sk: JSON.stringify({ m1: 'old' }) })
    stub.closeLoadGate()
    provideStubKV(stub)
    const slot = assembleMapSlot('sk')

    slot.loadOnce()
    slot.writeEntry('m2', 'v2')
    await flushAsync() // KV get 仍挂起（闸门未开）
    expect(stub.setWrites).toHaveLength(0)

    stub.releaseLoadGate()
    await flushAsync()
    expect(stub.setWrites).toHaveLength(1)
    // 断言解析后的表（JSON 键序随 Map 插入序，非语义）
    expect(JSON.parse(stub.setWrites[0][1])).toEqual({ m1: 'old', m2: 'v2' })
  })
})

describe('createKVSlot · 写串行链', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    __resetPlatformForTesting()
    vi.restoreAllMocks()
  })

  it('前一次 set 未完成时后一次写不交错：链序串行，最终落盘为最新值', async () => {
    const stub = new StubKV()
    provideStubKV(stub)
    const slot = assembleSingleValueSlot('sk')
    slot.loadOnce()
    await flushAsync() // loaded

    stub.armSetGate() // 第一次 set 挂起
    slot.write('a')
    await flushAsync() // persist#1 已开始：set('"a"') 记录在案但未完成
    slot.write('b') // persist#2 入链——必须等 persist#1 完成
    await flushAsync()
    // 串行证明：第一次写「已开始未完成」期间，第二次写不启动
    expect(stub.setWrites).toEqual([['sk', JSON.stringify('a')]])

    stub.releaseSetGate()
    await flushAsync()
    expect(stub.setWrites).toEqual([
      ['sk', JSON.stringify('a')],
      ['sk', JSON.stringify('b')],
    ])
    expect(stub.peek('sk')).toBe(JSON.stringify('b'))
  })

  it('写失败不毒化链：catch 吞错后后续写穿继续执行', async () => {
    const stub = new StubKV()
    stub.failSetError = new Error('kv write boom')
    provideStubKV(stub)
    const slot = assembleSingleValueSlot('sk')
    slot.loadOnce()
    await flushAsync()

    slot.write('a')
    await flushAsync()
    expect(stub.setWrites).toHaveLength(1)

    stub.failSetError = null // 第二次写恢复成功——链未被上一次失败卡死
    slot.write('b')
    await flushAsync()
    expect(stub.peek('sk')).toBe(JSON.stringify('b'))
    expect(slot.get()).toBe('b')
  })
})

describe('createKVSlot · deferred persist（idle 窗口）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    __resetPlatformForTesting()
    vi.restoreAllMocks()
  })

  it('loadOnce 未调用时 record → 加载完成后补写（idle 窗口与 loading 窗口同等挂起）', async () => {
    const stub = new StubKV()
    provideStubKV(stub)
    const slot = assembleSingleValueSlot('sk')

    slot.write('early') // loadState=idle：挂起写穿
    expect(stub.setWrites).toHaveLength(0)

    slot.loadOnce()
    await flushAsync()
    expect(stub.setWrites).toEqual([['sk', JSON.stringify('early')]])
  })

  it('加载完成后 record 直接入链写穿（非 deferred）', async () => {
    const stub = new StubKV()
    provideStubKV(stub)
    const slot = assembleSingleValueSlot('sk')
    slot.loadOnce()
    await flushAsync()

    slot.write('direct')
    await flushAsync()
    expect(stub.setWrites).toEqual([['sk', JSON.stringify('direct')]])
  })
})

describe('createKVSlot · 容错 warn', () => {
  afterEach(() => {
    __resetPlatformForTesting()
    vi.restoreAllMocks()
  })

  it('KV 写失败 → console.warn 带 [tag] 前缀，内存不回滚（本次运行内仍生效）', async () => {
    const stub = new StubKV()
    stub.failSetError = new Error('disk full')
    provideStubKV(stub)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const slot = assembleSingleValueSlot('sk')
    slot.loadOnce()
    await flushAsync()

    slot.write('kept')
    await flushAsync()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[test-single] KV write-through failed:', expect.any(Error))
    expect(slot.get()).toBe('kept') // 内存值不回滚
    expect(stub.peek('sk')).toBeNull() // KV 未落盘（重启后丢——best-effort 语义）
  })
})

describe('createKVSlot · validate 钩子', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    __resetPlatformForTesting()
    vi.restoreAllMocks()
  })

  it('validate 拒绝 → write 不执行、不写穿（内存与 KV 均无写入）', async () => {
    const stub = new StubKV()
    provideStubKV(stub)
    const writeSpy = vi.fn()
    const slot = createKVSlot<string>('sk', {
      tag: 'test-validate',
      parseSnapshot: (parsed) => (typeof parsed === 'string' ? parsed : undefined),
      mergeSnapshot: () => {},
      serialize: () => '""',
      validate: (v) => v === 'ok',
    })

    slot.loadOnce()
    await flushAsync()
    slot.record('bad', writeSpy)
    await flushAsync()
    expect(writeSpy).not.toHaveBeenCalled()
    expect(stub.setWrites).toHaveLength(0)

    slot.record('ok', writeSpy) // 合法值正常通过
    await flushAsync()
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(stub.setWrites).toHaveLength(1)
  })

  it('缺省 validate（last-used 形态）→ 任意值全收', async () => {
    const stub = new StubKV()
    provideStubKV(stub)
    const slot = assembleSingleValueSlot('sk')
    slot.loadOnce()
    await flushAsync()

    slot.write('') // 空串也收（无值域门）
    await flushAsync()
    expect(slot.get()).toBe('')
    expect(stub.peek('sk')).toBe(JSON.stringify(''))
  })
})

describe('createKVSlot · 加载容错（E1/E4 吸收语义）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    __resetPlatformForTesting()
    vi.restoreAllMocks()
  })

  it('KV 读失败 → 空启动：加载状态推进 loaded，回调照常触发，内存不被触碰', async () => {
    const stub = new StubKV({ sk: JSON.stringify('saved') })
    stub.failGetError = new Error('kv read boom')
    provideStubKV(stub)
    const slot = assembleSingleValueSlot('sk')
    const cb = vi.fn()
    slot.onLoaded(cb)

    slot.loadOnce()
    await flushAsync()
    expect(slot.get()).toBeUndefined() // 空启动
    expect(cb).toHaveBeenCalledTimes(1) // 失败也是有效加载

    const lateCb = vi.fn()
    slot.onLoaded(lateCb)
    expect(lateCb).toHaveBeenCalledTimes(1) // 完成后注册立即触发
  })

  it('JSON 损坏 / 形状不符（parseSnapshot 返回 undefined）→ 按空启动', async () => {
    for (const raw of ['{"a":1,', '["a","b"]', 'null', '42']) {
      const stub = new StubKV()
      stub.rawGet = raw
      provideStubKV(stub)
      const single = assembleSingleValueSlot('sk-single') // 形状门：非字符串 → undefined
      single.loadOnce()
      await flushAsync()
      expect(single.get()).toBeUndefined()

      __resetPlatformForTesting()
      const stub2 = new StubKV()
      stub2.rawGet = raw
      provideStubKV(stub2)
      const mapSlot = assembleMapSlot('sk-map') // 形状门：非 plain object → undefined
      mapSlot.loadOnce()
      await flushAsync()
      expect(mapSlot.map.size).toBe(0)
      __resetPlatformForTesting()
    }
  })
})

describe('createKVSlot · loadOnce 幂等 / onLoaded / __resetForTesting', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    __resetPlatformForTesting()
    vi.restoreAllMocks()
  })

  it('重复 loadOnce（含加载完成后）不重复读 KV', async () => {
    const stub = new StubKV({ sk: JSON.stringify({ m1: 'v1' }) })
    provideStubKV(stub)
    const slot = assembleMapSlot('sk')

    slot.loadOnce()
    slot.loadOnce()
    await flushAsync()
    slot.loadOnce()
    await flushAsync()
    expect(stub.getCalls).toBe(1)
    expect(slot.map.get('m1')).toBe('v1')
  })

  it('onLoaded 加载前注册 → 完成触发一次（未完成不触发）', async () => {
    const stub = new StubKV()
    stub.closeLoadGate()
    provideStubKV(stub)
    const slot = assembleSingleValueSlot('sk')
    const cb = vi.fn()
    slot.onLoaded(cb)

    slot.loadOnce()
    await flushAsync()
    expect(cb).not.toHaveBeenCalled()
    stub.releaseLoadGate()
    await flushAsync()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('__resetForTesting：挂起写丢弃、遗留回调清空、槽位可重新加载', async () => {
    const stub = new StubKV({ sk: JSON.stringify({ m1: 'v1' }) })
    provideStubKV(stub)
    const slot = assembleMapSlot('sk')
    const stale = vi.fn()
    slot.onLoaded(stale)
    slot.writeEntry('m2', 'v2') // idle 期 record：挂起写穿

    slot.reset() // 容器清理 + 槽位生命周期重置（模块 __reset 组合形态）
    expect(stub.setWrites).toHaveLength(0) // 挂起写被丢弃（KV 不落局部快照）

    slot.loadOnce()
    await flushAsync()
    expect(stale).not.toHaveBeenCalled() // 未消费回调已清
    expect(slot.map.get('m1')).toBe('v1') // 重新预载读回 KV 既有条目
    expect(slot.map.get('m2')).toBeUndefined()
  })
})
