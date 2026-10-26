// port.test.ts —— core C11 簇合并产物（round5-G）。
// 共同被测业务模块：`src/platform/port.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/composer/last-used-model.test.ts（14 用例，skip 0）
//   - src/domain/composer/model-thinking-memory.test.ts（12 用例，skip 0）
//   - src/domain/new-task-search/__tests__/command-registry.test.ts（4 用例，skip 0）
//   - src/domain/new-task-search/__tests__/command-store.test.ts（8 用例，skip 0）
//   - src/domain/new-task-search/__tests__/recents.test.ts（8 用例，skip 0）
//   - src/domain/new-task-search/__tests__/search-jump.test.ts（16 用例，skip 0）
//   - src/domain/new-task-search/__tests__/search.test.ts（18 用例，skip 0）
//   - src/foundation/create-kv-slot.test.ts（14 用例，skip 0）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LAST_USED_MODEL_KEY, loadOnce, lookup, record, onLoaded, __resetLastUsedModelForTesting } from '../../composer/last-used-model'
import { providePlatform, __resetPlatformForTesting, type KVStorage, type PlatformPort } from '../../../platform/port'
import { MODEL_THINKING_MEMORY_KEY, __resetModelThinkingMemoryForTesting, loadOnce as mtmLoadOnce, lookup as mtmLookup, onLoaded as mtmOnLoaded, record as mtmRecord } from '../../composer/model-thinking-memory'
import { ref } from 'vue'
import { createCommandStore, type RawCommand, type SessionCommand } from '../command-store'
import { useCommandRegistry } from '../command-registry'
import { useRecents } from '../recents'
import { type RecentEntry, type AppCommand, type SearchItem, type Section } from '../types'
import { type ArchiveSummary, type FileNode, type SessionGroup } from '@taiji/shared'
import { useSearchJump } from '../search-jump'
import { type SearchDeps } from '../search-ports'
import { useSearch } from '../search'
import { createKVSlot, type KVSlot, type KVSlotOptions } from '../../../foundation/create-kv-slot'

// ======== 来源：last-used-model.test.ts ========
describe("last-used-model", () => {
  /** 平面 KV stub */
  class MemKV implements KVStorage {
    private map = new Map<string, string>()
    async get(key: string): Promise<string | null> {
      return this.map.get(key) ?? null
    }
    async set(key: string, value: string): Promise<void> {
      this.map.set(key, value)
    }
    async remove(key: string): Promise<void> {
      this.map.delete(key)
    }
  }

  /** 可控时序 KV：closeGate 挂起 get、openGateNow 放行 */
  class GatedKV extends MemKV {
    private gate: Promise<void> | null = null
    private open: (() => void) | null = null
    closeGate(): void {
      this.gate = new Promise((resolve) => {
        this.open = resolve
      })
    }
    openGateNow(): void {
      this.open?.()
      this.open = null
    }
    override async get(key: string): Promise<string | null> {
      if (this.gate) await this.gate
      return super.get(key)
    }
  }

  /** 写失败 KV：set 抛错 */
  class FailWriteKV extends MemKV {
    override async set(_key: string, _value: string): Promise<void> {
      throw new Error('disk full')
    }
  }

  function provideMockPlatform(storage: KVStorage): void {
    const port: PlatformPort = {
      kind: 'mock',
      storage,
      webSocket: {
        create: () => { throw new Error('stub') },
      },
    }
    providePlatform(port)
  }

  beforeEach(() => {
    provideMockPlatform(new MemKV())
    __resetLastUsedModelForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetPlatformForTesting()
    __resetLastUsedModelForTesting()
  })

  describe('last-used-model · 基本 lookup/record', () => {
    it('未加载时 lookup 返回 undefined', () => {
      expect(lookup()).toBeUndefined()
    })

    it('record 后 lookup 返回记录值', () => {
      record('provider/model')
      expect(lookup()).toBe('provider/model')
    })

    it('多次 record 以最后一次为准', () => {
      record('provider/model-A')
      record('provider/model-B')
      expect(lookup()).toBe('provider/model-B')
    })
  })

  describe('last-used-model · loadOnce 预载', () => {
    it('loadOnce 从 KV 加载已有值', async () => {
      // 预置 KV
      const kv = new MemKV()
      await kv.set(LAST_USED_MODEL_KEY, JSON.stringify('provider/saved'))
      provideMockPlatform(kv)
      __resetLastUsedModelForTesting()

      loadOnce()
      // 等异步加载完成
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(lookup()).toBe('provider/saved')
    })

    it('loadOnce 幂等：重复调用不重复读', async () => {
      const kv = new MemKV()
      const spy = vi.spyOn(kv, 'get')
      provideMockPlatform(kv)
      __resetLastUsedModelForTesting()

      loadOnce()
      loadOnce() // 第二次不应再读
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(spy).toHaveBeenCalledTimes(1) // 只调一次 get
    })

    it('onLoaded 回调：加载完成后注册立即触发', async () => {
      const kv = new MemKV()
      await kv.set(LAST_USED_MODEL_KEY, JSON.stringify('provider/saved'))
      provideMockPlatform(kv)
      __resetLastUsedModelForTesting()

      loadOnce()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      // 加载完成后注册 → 立即触发
      const cb = vi.fn()
      onLoaded(cb)
      expect(cb).toHaveBeenCalledTimes(1)
    })

    it('onLoaded 回调：加载前注册，加载完成后触发', async () => {
      const gated = new GatedKV()
      gated.closeGate()
      provideMockPlatform(gated)
      __resetLastUsedModelForTesting()

      loadOnce()
      const cb = vi.fn()
      onLoaded(cb)
      expect(cb).not.toHaveBeenCalled()

      gated.openGateNow()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(cb).toHaveBeenCalledTimes(1)
    })
  })

  describe('last-used-model · E4 错误规格', () => {
    it('KV 读失败 → undefined（不抛）', async () => {
      const kv = new MemKV()
      vi.spyOn(kv, 'get').mockRejectedValue(new Error('read error'))
      provideMockPlatform(kv)
      __resetLastUsedModelForTesting()

      loadOnce()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(lookup()).toBeUndefined()
    })

    it('KV JSON 损坏 → undefined（不抛）', async () => {
      const kv = new MemKV()
      await kv.set(LAST_USED_MODEL_KEY, 'not-valid-json{{{')
      provideMockPlatform(kv)
      __resetLastUsedModelForTesting()

      loadOnce()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(lookup()).toBeUndefined()
    })

    it('KV JSON 非字符串（数组）→ undefined', async () => {
      const kv = new MemKV()
      await kv.set(LAST_USED_MODEL_KEY, JSON.stringify(['a', 'b']))
      provideMockPlatform(kv)
      __resetLastUsedModelForTesting()

      loadOnce()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(lookup()).toBeUndefined()
    })

    it('KV 写失败 → console.warn，内存值不回滚', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const kv = new FailWriteKV()
      provideMockPlatform(kv)
      __resetLastUsedModelForTesting()

      // 先加载完成（无 KV 数据）
      loadOnce()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      record('provider/model')
      // 内存值保持
      expect(lookup()).toBe('provider/model')
      // 写失败触发 warn
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('last-used-model · deferred persist', () => {
    it('loadOnce 期间 record → 加载完成后补写', async () => {
      const kv = new MemKV()
      const setSpy = vi.spyOn(kv, 'set')
      provideMockPlatform(kv)
      __resetLastUsedModelForTesting()

      loadOnce() // 状态 → loading
      record('provider/deferred') // deferred persist
      expect(lookup()).toBe('provider/deferred') // 内存立即可读

      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      // 加载完成后补写
      expect(setSpy).toHaveBeenCalledWith(
        LAST_USED_MODEL_KEY,
        JSON.stringify('provider/deferred'),
      )
    })

    it('加载窗口内 record 的新值不被在途 KV 旧值覆写（内存 + 最终落盘均为新值）', async () => {
      // KV 已有旧值；record 发生在 KV get 在途时
      const gated = new GatedKV()
      await gated.set(LAST_USED_MODEL_KEY, JSON.stringify('provider/stale'))
      const setSpy = vi.spyOn(gated, 'set')
      gated.closeGate()
      provideMockPlatform(gated)
      __resetLastUsedModelForTesting()

      loadOnce() // get 挂起（loading 窗口）
      record('provider/fresh') // 加载窗口内的显式选择
      gated.openGateNow()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      // 内存：KV 旧快照不覆写 record 新值
      expect(lookup()).toBe('provider/fresh')
      // 落盘：deferred 补写收敛的也是新值（非旧值回写）
      expect(setSpy).toHaveBeenCalledWith(
        LAST_USED_MODEL_KEY,
        JSON.stringify('provider/fresh'),
      )
      expect(await gated.get(LAST_USED_MODEL_KEY)).toBe(JSON.stringify('provider/fresh'))
    })

    it('加载窗口内 record 新值后 KV 读失败 → 内存新值保留', async () => {
      const gated = new GatedKV()
      vi.spyOn(gated, 'get').mockRejectedValue(new Error('read error'))
      gated.closeGate()
      provideMockPlatform(gated)
      __resetLastUsedModelForTesting()

      loadOnce()
      record('provider/fresh')
      gated.openGateNow()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      expect(lookup()).toBe('provider/fresh')
    })
  })
});

// ======== 来源：model-thinking-memory.test.ts ========
describe("model-thinking-memory", () => {
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
      mtmLoadOnce()
      await flushAsync()
      mtmRecord('builtin:bigmodel-coding-plan/GLM-5.3', 'max')
      mtmRecord('builtin:bigmodel-coding-plan/GLM-5.3-Flash', 'high')
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
      expect(mtmLookup('builtin:bigmodel-coding-plan/GLM-5.3')).toBeUndefined()
      mtmLoadOnce()
      await flushAsync()
      expect(mtmLookup('builtin:bigmodel-coding-plan/GLM-5.3')).toBe('max')
      expect(mtmLookup('builtin:bigmodel-coding-plan/GLM-5.3-Flash')).toBe('high')
    })

    it('E1：KV JSON 损坏 → 空表启动（不抛不吞），record 仍可写穿自愈', async () => {
      const stub = new StubKV()
      stub.rawGet = '{"p/m1": "max",'
      provideStubKV(stub)
      const cb = vi.fn()
      mtmOnLoaded(cb)
      mtmLoadOnce()
      await flushAsync()
      expect(mtmLookup('p/m1')).toBeUndefined()
      // 空表启动也是有效加载：回调照常触发（下游补重设依赖此语义）
      expect(cb).toHaveBeenCalledTimes(1)
      // 损坏不阻断后续写穿
      mtmRecord('p/m1', 'low')
      await flushAsync()
      expect(persistedTable(stub)).toEqual({ 'p/m1': 'low' })
    })

    it('E1（补充）：KV 值为合法 JSON 但非对象（数组/字符串/null/数字）→ 按空表处理', async () => {
      for (const raw of ['["p/m1","max"]', '"p/m1"', 'null', '42']) {
        __resetModelThinkingMemoryForTesting()
        const stub = new StubKV()
        stub.rawGet = raw
        provideStubKV(stub)
        mtmLoadOnce()
        await flushAsync()
        expect(mtmLookup('p/m1')).toBeUndefined()
      }
    })

    it('E1：KV get 抛错 → 空表启动，加载状态正常推进（完成后注册的回调立即触发）', async () => {
      const stub = new StubKV({ 'p/m1': 'max' })
      stub.failGetError = new Error('kv read boom')
      provideStubKV(stub)
      mtmLoadOnce()
      await flushAsync()
      expect(mtmLookup('p/m1')).toBeUndefined()
      const cb = vi.fn()
      mtmOnLoaded(cb)
      expect(cb).toHaveBeenCalledTimes(1)
    })

    it('E6：record 非法档位值 → 拦截，内存与 KV 均无写入', async () => {
      const stub = new StubKV()
      provideStubKV(stub)
      mtmLoadOnce()
      await flushAsync()
      mtmRecord('p/m1', 'ultra')
      mtmRecord('p/m1', '')
      mtmRecord('p/m1', 'MAX') // 枚举值大小写敏感
      await flushAsync()
      expect(mtmLookup('p/m1')).toBeUndefined()
      expect(stub.setWrites).toHaveLength(0)
    })

    it('E6：KV 含非法档位条目 → 加载时丢弃该条，合法条目保留', async () => {
      const stub = new StubKV({ 'p/ok': 'max', 'p/bad-str': 'quantum', 'p/bad-num': '3' })
      provideStubKV(stub)
      mtmLoadOnce()
      await flushAsync()
      expect(mtmLookup('p/ok')).toBe('max')
      expect(mtmLookup('p/bad-str')).toBeUndefined()
      expect(mtmLookup('p/bad-num')).toBeUndefined()
    })

    it('E2：KV 写失败 → console.warn，内存表继续生效（不回滚）', async () => {
      const stub = new StubKV()
      stub.failSetError = new Error('kv write boom')
      provideStubKV(stub)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mtmLoadOnce()
      await flushAsync()
      mtmRecord('p/m1', 'high')
      await flushAsync()
      expect(mtmLookup('p/m1')).toBe('high')
      expect(stub.setWrites).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(stub.peek(MODEL_THINKING_MEMORY_KEY)).toBeNull()
    })

    it('E7②：onLoaded 加载前注册 → 完成后触发一次；加载在途时 lookup 返回 undefined（E7①）', async () => {
      const stub = new StubKV({ 'p/m1': 'max' })
      stub.closeGate()
      provideStubKV(stub)
      const cb = vi.fn()
      mtmOnLoaded(cb)
      mtmLoadOnce()
      expect(cb).not.toHaveBeenCalled()
      expect(mtmLookup('p/m1')).toBeUndefined()
      stub.openGateNow()
      await flushAsync()
      expect(cb).toHaveBeenCalledTimes(1)
      expect(mtmLookup('p/m1')).toBe('max')
    })

    it('E7②：onLoaded 加载完成后注册 → 立即同步触发（无需 await）', async () => {
      const stub = new StubKV()
      provideStubKV(stub)
      mtmLoadOnce()
      await flushAsync()
      const cb = vi.fn()
      mtmOnLoaded(cb)
      expect(cb).toHaveBeenCalledTimes(1)
    })

    it('loadOnce 幂等：重复调用（含加载完成后）不重复读 KV', async () => {
      const stub = new StubKV({ 'p/m1': 'max' })
      provideStubKV(stub)
      mtmLoadOnce()
      mtmLoadOnce()
      await flushAsync()
      mtmLoadOnce()
      await flushAsync()
      expect(stub.getCalls).toBe(1)
      expect(mtmLookup('p/m1')).toBe('max')
    })

    it('加载窗口内 record：内存值优先不被 KV 旧快照覆写，加载完成后补写收敛 KV', async () => {
      const stub = new StubKV({ 'p/m1': 'low', 'p/m2': 'high' })
      stub.closeGate()
      provideStubKV(stub)
      mtmLoadOnce()
      // KV 快照在途（旧值 low）时 record 新值——挂起写穿，不能拿局部表覆写整表
      mtmRecord('p/m1', 'max')
      stub.openGateNow()
      await flushAsync()
      expect(mtmLookup('p/m1')).toBe('max')
      expect(mtmLookup('p/m2')).toBe('high')
      // 补写收敛：落盘为合并后的完整表（而非只有 p/m1 的局部快照）
      expect(persistedTable(stub)).toEqual({ 'p/m1': 'max', 'p/m2': 'high' })
    })

    it('重置隔离：__reset 后内存清空、状态回 idle、遗留回调与挂起写被丢弃', async () => {
      const stub = new StubKV({ 'p/m1': 'max' })
      provideStubKV(stub)
      const stale = vi.fn()
      mtmOnLoaded(stale)
      // idle 期 record：挂起写穿，重置后该挂起被丢弃（KV 不落局部快照）
      mtmRecord('p/m2', 'low')
      __resetModelThinkingMemoryForTesting()
      expect(mtmLookup('p/m2')).toBeUndefined()
      expect(stub.setWrites).toHaveLength(0)
      mtmLoadOnce()
      await flushAsync()
      // 未消费回调已清；重新预载只读回 KV 既有条目
      expect(stale).not.toHaveBeenCalled()
      expect(mtmLookup('p/m1')).toBe('max')
      expect(mtmLookup('p/m2')).toBeUndefined()
    })
  })
});

// ======== 来源：command-registry.test.ts ========
describe("command-registry", () => {
  function makeMockStorage(): KVStorage {
    const store = new Map<string, string>()
    return {
      async get(key: string) {
        return store.get(key) ?? null
      },
      async set(key: string, value: string) {
        store.set(key, value)
      },
      async remove(key: string) {
        store.delete(key)
      },
    }
  }

  describe('TC-15: commandRegistry 聚合', () => {
    it('list 聚合 appCommands + slash（activeSessionId 非 null）', () => {
      const store = createCommandStore(makeMockStorage())
      store.registerApp([{ id: 'n', name: '新建', action: () => {} }])
      store.applyCommands('s1', [{ name: 'review', source: 'skill' }])

      const registry = useCommandRegistry(ref<string | null>('s1'), store)
      const names = registry.list().value.map((c) => c.name)
      expect(names).toEqual(['新建', 'review'])
    })

    it('activeSessionId null → slash 空，仅 appCommands（AC-4.8）', () => {
      const store = createCommandStore(makeMockStorage())
      store.registerApp([{ id: 'n', name: '新建', action: () => {} }])
      store.applyCommands('s1', [{ name: 'review', source: 'skill' }])

      const registry = useCommandRegistry(ref<string | null>(null), store)
      const names = registry.list().value.map((c) => c.name)
      expect(names).toEqual(['新建'])
    })

    it('appCommands 物理隔离：session 切换不重算 app 区（AC-2.2）', () => {
      const store = createCommandStore(makeMockStorage())
      store.registerApp([{ id: 'n', name: '新建', action: () => {} }])
      store.applyCommands('s1', [{ name: 'goal', source: 'extension' }])
      store.applyCommands('s2', [{ name: 'todo', source: 'extension' }])

      const sid = ref<string | null>('s1')
      const registry = useCommandRegistry(sid, store)
      expect(registry.list().value.map((c) => c.name)).toEqual(['新建', 'goal'])

      sid.value = 's2'
      expect(registry.list().value.map((c) => c.name)).toEqual(['新建', 'todo'])
      // app 区独立 ref（D-016 物理隔离），未随 session 切换重算
      expect(store.appCommands.value).toHaveLength(1)
    })

    it('registerApp 幂等覆盖（AC-2.4）', () => {
      const store = createCommandStore(makeMockStorage())
      const registry = useCommandRegistry(ref<string | null>(null), store)
      registry.registerApp([{ id: 'a', name: 'A', action: () => {} }])
      registry.registerApp([{ id: 'b', name: 'B', action: () => {} }])

      expect(store.appCommands.value).toHaveLength(1) // 覆盖非累加
      expect(store.appCommands.value[0].name).toBe('B')
    })
  })
});

// ======== 来源：command-store.test.ts ========
describe("command-store", () => {
  /** Map 实现 KVStorage（async 语义对齐 PlatformPort.storage 契约） */
  function makeMockStorage(initial?: Record<string, string>): KVStorage & { store: Map<string, string> } {
    const store = new Map<string, string>(Object.entries(initial ?? {}))
    return {
      store,
      async get(key: string) {
        return store.get(key) ?? null
      },
      async set(key: string, value: string) {
        store.set(key, value)
      },
      async remove(key: string) {
        store.delete(key)
      },
    }
  }

  /** 构造 RawCommand 的辅助函数 */
  function raw(name: string, source: string, extra?: Partial<RawCommand>): RawCommand {
    return { name, source, ...extra }
  }

  describe('createCommandStore', () => {
    it('TC-1: applyCommands 归一化（builtin 命令名优先 → 专属 icon key，否则 source 泛化）', () => {
      const store = createCommandStore(makeMockStorage())
      store.applyCommands('s1', [
        raw('goal', 'extension'),
        raw('skill:code-review', 'skill'),
        raw('plain', 'other'),
      ])

      const cmds = store.getCommands('s1')
      // goal 命中 builtin（专属 Target 图标）→ 返回命令名 'goal'，不再是泛化 'terminal'
      // skill:code-review 未命中 builtin → 走 source fallback 'star'
      // plain 未命中 builtin 且 source='other' → 默认 'wrench'
      expect(cmds.map((c) => c.icon)).toEqual(['goal', 'star', 'wrench'])
      expect(cmds.map((c) => c.name)).toEqual(['goal', 'skill:code-review', 'plain'])
      // id = name，kind = source
      expect(cmds[0]).toMatchObject({ id: 'goal', kind: 'extension' })
      expect(cmds[1]).toMatchObject({ id: 'skill:code-review', kind: 'skill' })
      // description / sourceInfo 透传
      store.applyCommands('s1', [raw('doc', 'extension', { description: 'desc', sourceInfo: { path: '/x/SKILL.md', source: 'skill' } })])
      expect(store.getCommands('s1')[0]).toMatchObject({
        description: 'desc',
        sourceInfo: { path: '/x/SKILL.md', source: 'skill' },
      })
    })

    it('TC-1b: builtin 命令名归一化（剥 / 与 skill: 前缀后命中）', () => {
      const store = createCommandStore(makeMockStorage())
      store.applyCommands('s1', [
        raw('/compact', 'builtin'),
        raw('/skill:commit', 'skill'),
        raw('todos', 'extension'),
        raw('unknown-cmd', 'extension'),
      ])
      const cmds = store.getCommands('s1')
      // /compact → 剥前缀 'compact' 命中 builtin → 'compact'（专属 Layers 图标）
      // /skill:commit → 剥 skill: 后 'commit' 命中 builtin → 'commit'（专属 Wand 图标）
      // todos → 命中 builtin → 'todos'（专属 ListChecks）
      // unknown-cmd → 未命中，source='extension' → 'terminal'
      expect(cmds.map((c) => c.icon)).toEqual(['compact', 'commit', 'todos', 'terminal'])
    })

    it('TC-2: commandsBySession per-session 分区隔离', () => {
      const store = createCommandStore(makeMockStorage())
      store.applyCommands('s1', [raw('a', 'extension')])
      store.applyCommands('s2', [raw('b', 'skill')])

      expect(store.getCommands('s1').map((c) => c.name)).toEqual(['a'])
      expect(store.getCommands('s2').map((c) => c.name)).toEqual(['b'])
      // 未写入的 session 返回空数组且不落键
      expect(store.getCommands('s3')).toEqual([])
      expect(store.commandsBySession.value.has('s3')).toBe(false)
      // 响应式视图按 session 隔离
      expect(store.slashCommandsOf('s1').value.map((c) => c.name)).toEqual(['a'])
      expect(store.slashCommandsOf('s2').value.map((c) => c.name)).toEqual(['b'])
    })

    it('TC-3: clearCommands 删除分区（幂等）', () => {
      const store = createCommandStore(makeMockStorage())
      store.applyCommands('s1', [raw('a', 'extension')])
      store.clearCommands('s1')

      expect(store.getCommands('s1')).toEqual([])
      expect(store.commandsBySession.value.has('s1')).toBe(false)
      // 对不存在 session 调用无副作用不抛错
      expect(() => store.clearCommands('nope')).not.toThrow()
    })

    it('TC-4: registerApp 幂等覆盖（不碰 commandsBySession）', () => {
      const store = createCommandStore(makeMockStorage())
      const cmdA = { id: 'a', name: 'A', action: () => {} }
      const cmdB = { id: 'b', name: 'B', action: () => {} }
      const cmdC = { id: 'c', name: 'C', action: () => {} }

      store.registerApp([cmdA, cmdB])
      expect(store.appCommands.value).toEqual([cmdA, cmdB])

      // 覆盖非累加
      store.registerApp([cmdC])
      expect(store.appCommands.value).toEqual([cmdC])

      // D-016 物理隔离：registerApp 不写 commandsBySession
      store.applyCommands('s1', [raw('x', 'extension')])
      store.registerApp([cmdA])
      expect(store.getCommands('s1').map((c) => c.name)).toEqual(['x'])
    })

    it('TC-5: pendingSlash 写-消费-清（一次性通道 + 覆盖更新 ts）', () => {
      const store = createCommandStore(makeMockStorage())
      expect(store.pendingSlash.value).toBeNull()

      store.requestSlashInjection({ command: '/goal', sessionId: 's1' })
      expect(store.pendingSlash.value).toMatchObject({ command: '/goal', sessionId: 's1' })
      expect(typeof store.pendingSlash.value?.ts).toBe('number')

      const ts1 = store.pendingSlash.value!.ts
      store.requestSlashInjection({ command: '/todo', sessionId: 's1' })
      expect(store.pendingSlash.value?.command).toBe('/todo')
      // ts 更新（覆盖旧值，非累加）
      expect(store.pendingSlash.value!.ts).toBeGreaterThanOrEqual(ts1)

      store.clearPendingSlash()
      expect(store.pendingSlash.value).toBeNull()
    })

    it('TC-6: shortcutOverrides 经 mock storage 持久化（async 读写 + 失败降级）', async () => {
      const storage = makeMockStorage({ 'taiji-shortcut-overrides': '{"new-session":"j"}' })
      const store = createCommandStore(storage)

      // 初始化从 storage 回填
      await store.initShortcutOverrides()
      expect(store.shortcutOverrides.value).toEqual({ 'new-session': 'j' })

      // 写：内存态立即更新 + 异步持久化
      await store.setShortcutOverride('new-session', 'k')
      expect(store.shortcutOverrides.value).toEqual({ 'new-session': 'k' })
      expect(storage.store.get('taiji-shortcut-overrides')).toBe('{"new-session":"k"}')

      // null 清除自定义键
      await store.setShortcutOverride('new-session', null)
      expect(store.shortcutOverrides.value).toEqual({})
      expect(storage.store.get('taiji-shortcut-overrides')).toBe('{}')

      // 写入失败（配额满）降级内存态，不抛出
      const failingStorage = makeMockStorage()
      failingStorage.set = async () => {
        throw new Error('QuotaExceededError')
      }
      const store2 = createCommandStore(failingStorage)
      await expect(store2.setShortcutOverride('a', '1')).resolves.toBeUndefined()
      expect(store2.shortcutOverrides.value).toEqual({ a: '1' })
    })

    it('TC-6b: initShortcutOverrides 解析失败/异常降级空对象', async () => {
      // 非法 JSON → {}
      const badJson = makeMockStorage({ 'taiji-shortcut-overrides': 'not-json{' })
      const store1 = createCommandStore(badJson)
      await store1.initShortcutOverrides()
      expect(store1.shortcutOverrides.value).toEqual({})

      // storage.get 抛错 → {}
      const failing = makeMockStorage()
      failing.get = async () => {
        throw new Error('storage unavailable')
      }
      const store2 = createCommandStore(failing)
      await store2.initShortcutOverrides()
      expect(store2.shortcutOverrides.value).toEqual({})
    })
  })
});

// ======== 来源：recents.test.ts ========
describe("recents", () => {
  /** Map 实现 KVStorage（get 可注入失败场景） */
  function makeMockStorage(initial?: Record<string, string>): KVStorage & { store: Map<string, string> } {
    const store = new Map<string, string>(Object.entries(initial ?? {}))
    return {
      store,
      async get(key: string) {
        return store.get(key) ?? null
      },
      async set(key: string, value: string) {
        store.set(key, value)
      },
      async remove(key: string) {
        store.delete(key)
      },
    }
  }

  function entry(over: Partial<RecentEntry>): RecentEntry {
    return { type: 'file', key: 'file:x', timestamp: Date.now(), title: 'x', sub: 'src', ...over }
  }

  describe('TC-11: FIFO + 幂等 + 兜底', () => {
    it('写后读回：每类 ≤RECENTS_PER_TYPE（5）', async () => {
      const storage = makeMockStorage()
      const recents = useRecents(storage)

      // 同类型写 7 条（timestamp 递增由 write 内部 Math.max+1 兜底）
      for (let i = 0; i < 7; i++) {
        await recents.write(entry({ type: 'file', key: `file:k${i}`, title: `k${i}` }))
      }

      const list = await recents.read()
      expect(list).toHaveLength(5) // 每类 ≤5
      // FIFO 倒序：最新在前
      expect(list[0].key).toBe('file:k6')
      expect(list[4].key).toBe('file:k2')
    })

    it('同 key 幂等：更新 timestamp 不新增（AC-3.5）', async () => {
      const storage = makeMockStorage()
      const recents = useRecents(storage)
      await recents.write(entry({ key: 'file:x', title: 'x' }))
      await recents.write(entry({ key: 'file:x', title: 'x' }))

      const list = await recents.read()
      expect(list).toHaveLength(1)
      expect(list[0].key).toBe('file:x')
    })

    it('Math.max+1 时间戳兜底：同毫秒连续 write 仍有序（AC-3.6）', async () => {
      const storage = makeMockStorage()
      const recents = useRecents(storage)
      const now = Date.now()
      const e1 = entry({ type: 'file', key: 'file:a', timestamp: now, title: 'a' })
      const e2 = entry({ type: 'file', key: 'file:b', timestamp: now, title: 'b' })
      await recents.write(e1)
      await recents.write(e2)

      const list = await recents.read()
      expect(list[0].key).toBe('file:b') // 后写优先
      expect(list[0].timestamp).toBeGreaterThan(list[1].timestamp)
    })

    it('跨类型独立 FIFO（各自 ≤5）', async () => {
      const storage = makeMockStorage()
      const recents = useRecents(storage)
      for (let i = 0; i < 6; i++) {
        await recents.write(entry({ type: 'file', key: `file:k${i}` }))
        await recents.write(entry({ type: 'session', key: `session:k${i}`, title: `s${i}` }))
      }

      const list = await recents.read()
      const files = list.filter((e) => e.type === 'file')
      const sessions = list.filter((e) => e.type === 'session')
      expect(files).toHaveLength(5)
      expect(sessions).toHaveLength(5)
    })

    it('首用（storage 无 key）read → []（AC-3.3）', async () => {
      const recents = useRecents(makeMockStorage())
      expect(await recents.read()).toEqual([])
    })
  })

  describe('TC-12: 失败降级', () => {
    it('JSON 脏数据 read → []（MR-3.1 不崩溃）', async () => {
      const storage = makeMockStorage({ 'taiji:search-recents': '{invalid json' })
      const recents = useRecents(storage)
      expect(await recents.read()).toEqual([])
    })

    it('storage.set 抛错 → write 返 false 内存态保留（MR-3.3 不抛）', async () => {
      const storage = makeMockStorage()
      const failing: KVStorage = {
        ...storage,
        async set() {
          throw new Error('QuotaExceededError')
        },
      }
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const recents = useRecents(failing)
        const ok = await recents.write(entry({ key: 'file:x' }))
        expect(ok).toBe(false)
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('storage.get 抛错 → read → []（不抛）', async () => {
      const storage = makeMockStorage()
      const failing: KVStorage = {
        ...storage,
        async get() {
          throw new Error('read failed')
        },
      }
      const recents = useRecents(failing)
      expect(await recents.read()).toEqual([])
    })
  })
});

// ======== 来源：search-jump.test.ts ========
describe("search-jump", () => {
  /** Map 实现 KVStorage */
  function makeMockStorage(initial?: Record<string, string>): KVStorage & { store: Map<string, string> } {
    const store = new Map<string, string>(Object.entries(initial ?? {}))
    return {
      store,
      async get(key: string) {
        return store.get(key) ?? null
      },
      async set(key: string, value: string) {
        store.set(key, value)
      },
      async remove(key: string) {
        store.delete(key)
      },
    }
  }

  /** 构造 mock SearchDeps */
  function makeDeps(overrides?: Partial<SearchDeps>): SearchDeps {
    const commandStore = createCommandStore(makeMockStorage())
    const deps: SearchDeps = {
      ports: {
        isMock: false,
        isMac: false,
        searchMock: vi.fn(async () => []),
        fileRead: vi.fn(async () => {}),
        fileCandidates: vi.fn(async () => [] as FileNode[]),
        sessionList: vi.fn(async () => [] as SessionGroup[]),
        selectSession: vi.fn(async () => {}),
        archiveList: vi.fn(async () => [] as ArchiveSummary[]),
        archiveJump: vi.fn(),
        t: vi.fn((key: string) => key),
      },
      commandStore,
      storage: makeMockStorage(),
      fileTree: { loadTree: vi.fn(async () => {}), selectFile: vi.fn() },
      appCommandActions: {
        newSession: vi.fn(),
        toggleSidebar: vi.fn(),
        requestPresetOpen: vi.fn(),
      },
    }
    if (overrides) {
      if (overrides.ports) deps.ports = { ...deps.ports, ...overrides.ports }
      if (overrides.storage) deps.storage = overrides.storage
      if (overrides.fileTree) deps.fileTree = { ...deps.fileTree, ...overrides.fileTree }
      if (overrides.commandStore) deps.commandStore = overrides.commandStore
    }
    return deps
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('TC-7: app 命令执行 + recents', () => {
    it('confirm({type:command, commandKind:app}) → action 调 + recents 写 + {ok:true}', async () => {
      const deps = makeDeps()
      const action = vi.fn()
      deps.commandStore.registerApp([{ id: 'n', name: '新建', action }])

      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'command', title: '新建', sub: '⌘N', commandKind: 'app' }
      const result = await confirm(item, { activeSessionId: 's1' })

      expect(result).toEqual({ ok: true })
      expect(action).toHaveBeenCalledTimes(1)
      // recents 写入（storage 已持久化）
      const raw = await deps.storage.get('taiji:search-recents')
      expect(raw).toContain('"command:新建"')
    })
  })

  describe('TC-8: slash 注入 pendingSlash', () => {
    it('confirm(slash 带 icon) → pendingSlash 写入（icon 透传 + sessionId 透传）+ {ok:true}', async () => {
      const deps = makeDeps()
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'command', title: 'commit', sub: '提交改动', icon: 'wrench', commandKind: 'slash' }
      const result = await confirm(item, { activeSessionId: 's1' })

      expect(result).toEqual({ ok: true })
      expect(deps.commandStore.pendingSlash.value).not.toBeNull()
      expect(deps.commandStore.pendingSlash.value).toMatchObject({ command: 'commit', icon: 'wrench', sessionId: 's1' })
    })

    it('landing 态（activeSessionId=null）slash 注入放行，sessionId 透传 null', async () => {
      const deps = makeDeps()
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'command', title: 'review', sub: '代码评审', commandKind: 'slash' }
      const result = await confirm(item, { activeSessionId: null })

      expect(result).toEqual({ ok: true })
      expect(deps.commandStore.pendingSlash.value!.sessionId).toBeNull()
    })

    it('skill 命令项（isSkill:true + location）→ 两字段透传进 pendingSlash（消费侧据此分流 skill 通路）', async () => {
      const deps = makeDeps()
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = {
        type: 'command',
        title: 'skill:code-review',
        sub: '代码评审',
        icon: 'star',
        commandKind: 'slash',
        isSkill: true,
        location: '/skills/code-review/SKILL.md',
      }
      const result = await confirm(item, { activeSessionId: 's1' })

      expect(result).toEqual({ ok: true })
      expect(deps.commandStore.pendingSlash.value).toMatchObject({
        command: 'skill:code-review',
        icon: 'star',
        sessionId: 's1',
        isSkill: true,
        location: '/skills/code-review/SKILL.md',
      })
    })

    it('普通命令项（无 isSkill/location）→ pendingSlash 两字段 undefined（命令通路回归锁）', async () => {
      const deps = makeDeps()
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'command', title: 'goal', sub: '目标', icon: 'goal', commandKind: 'slash' }
      await confirm(item, { activeSessionId: 's1' })

      const pending = deps.commandStore.pendingSlash.value!
      expect(pending.isSkill).toBeUndefined()
      expect(pending.location).toBeUndefined()
    })

    it('command action 抛错 → {ok:false,error}（AC-6.8）', async () => {
      const deps = makeDeps()
      deps.commandStore.registerApp([{ id: 'n', name: '抛错', action: () => { throw new Error('boom') } }])
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'command', title: '抛错', sub: 'x', commandKind: 'app' }
      const result = await confirm(item, { activeSessionId: 's1' })

      expect(result.ok).toBe(false)
      expect((result as { error: string }).error).toBe('boom')
    })

    it('app 命令未注册 → {ok:false,error}（search.commandNotFound）', async () => {
      const deps = makeDeps()
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'command', title: '不存在的命令', sub: 'x', commandKind: 'app' }
      const result = await confirm(item, { activeSessionId: 's1' })

      expect(result.ok).toBe(false)
      expect((result as { error: string }).error).toBe('search.commandNotFound')
    })
  })

  describe('TC-9: file 分支（AC-6.5/6.9）', () => {
    it('file.read 成功 → selectFile 调 + {ok:true, drawerTab:detail} + recents 写', async () => {
      const deps = makeDeps()
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'file', title: 'a.ts', sub: 'src/a.ts' }
      const result = await confirm(item, { activeSessionId: 's1' })

      expect(result).toEqual({ ok: true, drawerTab: 'detail' })
      expect(deps.ports.fileRead).toHaveBeenCalledWith('src/a.ts', 's1')
      expect(deps.fileTree.selectFile).toHaveBeenCalledWith('src/a.ts')
      const raw = await deps.storage.get('taiji:search-recents')
      expect(raw).toContain('"file:a.ts"')
    })

    it('file.read reject → {ok:false} + selectFile 不调（直调不吞错）', async () => {
      const deps = makeDeps()
      ;(deps.ports.fileRead as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EACCES'))
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'file', title: 'a.ts', sub: 'src/a.ts' }
      const result = await confirm(item, { activeSessionId: 's1' })

      expect(result.ok).toBe(false)
      expect((result as { error: string }).error).toBe('EACCES')
      expect(deps.fileTree.selectFile).not.toHaveBeenCalled()
    })
  })

  describe('TC-10: session 分支（AC-6.6）', () => {
    it('session 反查命中 → selectSession(id) + {ok:true}', async () => {
      const deps = makeDeps()
      const groups: SessionGroup[] = [
        { cwd: '/tmp/x', sessions: [{ id: 's1', cwd: '/tmp/x', label: '测试会话' } as never] },
      ]
      ;(deps.ports.sessionList as ReturnType<typeof vi.fn>).mockResolvedValue(groups)
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'session', title: '测试会话', sub: '/tmp/x' }
      const result = await confirm(item, { activeSessionId: null })

      expect(result).toEqual({ ok: true })
      expect(deps.ports.selectSession).toHaveBeenCalledWith('s1')
    })

    it('session 反查未命中 → {ok:false} + selectSession 不调', async () => {
      const deps = makeDeps()
      ;(deps.ports.sessionList as ReturnType<typeof vi.fn>).mockResolvedValue([])
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'session', title: '不存在', sub: '/tmp' }
      const result = await confirm(item, { activeSessionId: null })

      expect(result.ok).toBe(false)
      expect((result as { error: string }).error).toBe('search.sessionNotFound')
      expect(deps.ports.selectSession).not.toHaveBeenCalled()
    })

    it('selectSession reject → {ok:false}（AC-6.6）', async () => {
      const deps = makeDeps()
      const groups: SessionGroup[] = [
        { cwd: '/tmp/x', sessions: [{ id: 's1', cwd: '/tmp/x', label: '测试会话' } as never] },
      ]
      ;(deps.ports.sessionList as ReturnType<typeof vi.fn>).mockResolvedValue(groups)
      ;(deps.ports.selectSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('switch failed'))
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'session', title: '测试会话', sub: '/tmp/x' }
      const result = await confirm(item, { activeSessionId: null })

      expect(result.ok).toBe(false)
      expect((result as { error: string }).error).toBe('switch failed')
    })
  })

  describe('symbol 占位（D-001）', () => {
    it('confirm({type:symbol}) → {ok:false} 不调 domain/store', async () => {
      const deps = makeDeps()
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'symbol', title: 'sym()', sub: 'a.ts:42' }
      const result = await confirm(item, { activeSessionId: 's1' })

      expect(result.ok).toBe(false)
      expect((result as { error: string }).error).toBe('search.symbolUnavailable')
      expect(deps.ports.fileRead).not.toHaveBeenCalled()
      expect(deps.ports.selectSession).not.toHaveBeenCalled()
      expect(deps.commandStore.pendingSlash.value).toBeNull()
    })
  })

  describe('TC-11: 归档分支（选中归档项 → 主区摘要视图）', () => {
    function makeArchive(): ArchiveSummary {
      return {
        sessionId: 'arc-1',
        name: 'v0.10 renderer 重构',
        originalFile: '2026-10-20T00-00-00-000Z_arc-1.jsonl',
        cwd: '/proj/x',
        archivedAt: '2026-10-20T00:00:00.000Z',
        rawBytes: 1024,
        status: 'archived',
        codec: 'zstd-3',
        compressedBytes: 256,
        sha256: 'a'.repeat(64),
        summary: { turns: [{ user: 'renderer 重构开始', agent: '六层分层方案' }] },
      }
    }

    it('带载荷 → archiveJump 调（载荷原样透传）+ {ok:true}', async () => {
      const deps = makeDeps()
      const archive = makeArchive()
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'archive', title: 'v0.10 renderer 重构', sub: 'renderer 重构开始', archive }

      const result = await confirm(item, { activeSessionId: null })

      expect(result).toEqual({ ok: true })
      expect(deps.ports.archiveJump).toHaveBeenCalledWith(archive)
    })

    it('无载荷（recents 回填项只存 title/sub）→ {ok:false, archiveOpenFailed} + archiveJump 不调', async () => {
      const deps = makeDeps()
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'archive', title: 'v0.10 renderer 重构', sub: 'renderer 重构开始' }

      const result = await confirm(item, { activeSessionId: null })

      expect(result.ok).toBe(false)
      expect(deps.ports.archiveJump).not.toHaveBeenCalled()
    })

    it('archiveJump 抛错 → {ok:false} 错误消息透传（浮层保持打开，用户可重新搜索）', async () => {
      const deps = makeDeps()
      ;(deps.ports.archiveJump as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('open failed') })
      const archive = makeArchive()
      const { confirm } = useSearchJump(deps)
      const item: SearchItem = { type: 'archive', title: 'v0.10 renderer 重构', sub: 'renderer 重构开始', archive }

      const result = await confirm(item, { activeSessionId: null })

      expect(result.ok).toBe(false)
      expect((result as { error: string }).error).toBe('open failed')
    })
  })
});

// ======== 来源：search.test.ts ========
describe("search", () => {
  /** Map 实现 KVStorage（对齐 command-store.test.ts 的 makeMockStorage 模式） */
  function makeMockStorage(initial?: Record<string, string>): KVStorage & { store: Map<string, string> } {
    const store = new Map<string, string>(Object.entries(initial ?? {}))
    return {
      store,
      async get(key: string) {
        return store.get(key) ?? null
      },
      async set(key: string, value: string) {
        store.set(key, value)
      },
      async remove(key: string) {
        store.delete(key)
      },
    }
  }

  /** 构造 mock SearchDeps（每测试独立实例，断言 per-test） */
  function makeDeps(overrides?: Partial<SearchDeps>): SearchDeps {
    const commandStore = createCommandStore(makeMockStorage())
    const deps: SearchDeps = {
      ports: {
        isMock: false,
        isMac: false,
        searchMock: vi.fn(async () => [] as Section[]),
        fileRead: vi.fn(async () => {}),
        fileCandidates: vi.fn(async () => [] as FileNode[]),
        sessionList: vi.fn(async () => [] as SessionGroup[]),
        selectSession: vi.fn(async () => {}),
        archiveList: vi.fn(async () => [] as ArchiveSummary[]),
        archiveJump: vi.fn(),
        // t 返回实际本地化标签（mock fixture 用中文标签，与 真实进程层 i18n 行为一致）
        t: vi.fn((key: string) => {
          const labels: Record<string, string> = {
            'search.sectionSymbol': '符号',
            'search.recent': '最近',
            'search.suggestedCommand': '建议命令',
            'search.sectionCommand': '命令',
            'search.sectionFile': '文件',
            'search.sectionSession': '会话',
            'search.sectionArchive': '归档',
            // archive 域词条（renderer zh-CN/archive.ts 同值）：归档条目状态标注经 t 通道取词
            'archive.summary.compressing': '压缩中',
            'archive.summary.empty': '（无对话记录）',
          }
          return labels[key] ?? key
        }),
      },
      commandStore,
      storage: makeMockStorage(),
      fileTree: { loadTree: vi.fn(async () => {}), selectFile: vi.fn() },
      appCommandActions: {
        newSession: vi.fn(),
        toggleSidebar: vi.fn(),
        requestPresetOpen: vi.fn(),
      },
    }
    if (overrides) {
      if (overrides.ports) deps.ports = { ...deps.ports, ...overrides.ports }
      if (overrides.commandStore) deps.commandStore = overrides.commandStore
      if (overrides.storage) deps.storage = overrides.storage
      if (overrides.fileTree) deps.fileTree = { ...deps.fileTree, ...overrides.fileTree }
      if (overrides.appCommandActions) deps.appCommandActions = { ...deps.appCommandActions, ...overrides.appCommandActions }
    }
    return deps
  }

  /** 构造一个 file FileNode */
  function fileNode(path: string, name?: string): FileNode {
    return { path, name: name ?? path.split('/').pop() ?? path, type: 'file' }
  }

  /** 从 sections 找指定 kind 的 section */
  function findSection(sections: Section[], kind: Section['kind']): Section | undefined {
    return sections.find((s) => s.kind === kind)
  }

  describe('TC-1: mock 层 4 类型合并 + 符号占位', () => {
    it('isMock=true + searchMock 返 3 section → 补 symbol 占位，返回 4 section', async () => {
      const deps = makeDeps()
      deps.ports.isMock = true
      const mockSections: Section[] = [
        { kind: 'command', label: '命令', items: [{ type: 'command', title: 'c1', sub: 's', commandKind: 'app' }] },
        { kind: 'file', label: '文件', items: [{ type: 'file', title: 'f1', sub: 'p' }] },
        { kind: 'session', label: '会话', items: [{ type: 'session', title: 'se1', sub: 'cwd' }] },
      ]
      ;(deps.ports.searchMock as ReturnType<typeof vi.fn>).mockResolvedValue(mockSections)

      const sid = ref<string | null>('s1')
      const { query } = useSearch(sid, deps)
      const sections = await query('x', { activeSessionId: 's1' })

      expect(sections.map((s) => s.kind)).toEqual(['command', 'file', 'session', 'symbol'])
      const symbol = findSection(sections, 'symbol')
      expect(symbol).toBeTruthy()
      expect(symbol!.items).toEqual([])
    })

    it('mock fixture 已含 symbol section → 不重复补', async () => {
      const deps = makeDeps()
      deps.ports.isMock = true
      const mockSections: Section[] = [
        { kind: 'symbol', label: '符号', items: [] },
        { kind: 'command', label: '命令', items: [] },
      ]
      ;(deps.ports.searchMock as ReturnType<typeof vi.fn>).mockResolvedValue(mockSections)

      const { query } = useSearch(ref<string | null>('s1'), deps)
      const sections = await query('x', { activeSessionId: 's1' })
      expect(sections.filter((s) => s.kind === 'symbol')).toHaveLength(1)
    })
  })

  describe('TC-2: loadSeq 乱序检查', () => {
    it('第一次查询慢（永不 resolve），第二次快速：旧结果不覆盖第二次', async () => {
      const deps = makeDeps()
      const slowPending = new Promise<FileNode[]>(() => {}) // 永不 settle
      ;(deps.ports.fileCandidates as ReturnType<typeof vi.fn>).mockReturnValueOnce(slowPending)
      ;(deps.ports.fileCandidates as ReturnType<typeof vi.fn>).mockReturnValueOnce(Promise.resolve([fileNode('b.ts')]))

      const { query } = useSearch(ref<string | null>('s1'), deps)

      const firstP = query('a', { activeSessionId: 's1' })
      const secondSections = await query('b', { activeSessionId: 's1' })

      // 第二次命中文件 b.ts
      const fileSection = findSection(secondSections, 'file')
      expect(fileSection).toBeTruthy()
      expect(fileSection!.items.some((it) => it.title === 'b.ts')).toBe(true)

      // 第一次的 promise 仍 pending（永不 settle），不会 resolve 出旧结果覆盖
      const settled = await Promise.race([
        firstP.then(() => 'resolved'),
        Promise.resolve('pending'),
      ])
      expect(settled).toBe('pending')
    })
  })

  describe('TC-5: 双源 reject 静默（MR-4.2）', () => {
    it('fileCandidates reject + sessionList reject → file/session 分组空，命令分组仍工作，不抛', async () => {
      const deps = makeDeps()
      ;(deps.ports.fileCandidates as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('file down'))
      ;(deps.ports.sessionList as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('session down'))
      deps.commandStore.registerApp([{ id: 'n', name: '新建', action: vi.fn() }])

      const { query } = useSearch(ref<string | null>('s1'), deps)
      const sections = await query('新', { activeSessionId: 's1' })

      const fileSection = findSection(sections, 'file')
      expect(fileSection).toBeUndefined() // file 分组空（被过滤）
      expect(findSection(sections, 'session')).toBeUndefined()
      expect(findSection(sections, 'command')).toBeTruthy() // 命令仍工作
    })
  })

  describe('TC-6: WS 超时 race 不挂死', () => {
    it('fileCandidates 返永不 settle promise → fake timers 推进 10s → file 分组空（不永久 pending）', async () => {
      vi.useFakeTimers()
      try {
        const deps = makeDeps()
        ;(deps.ports.fileCandidates as ReturnType<typeof vi.fn>).mockReturnValue(new Promise<FileNode[]>(() => {}))
        deps.commandStore.registerApp([{ id: 'n', name: '新建', action: vi.fn() }])

        const { query } = useSearch(ref<string | null>('s1'), deps)
        const queryP = query('x', { activeSessionId: 's1' })
        await vi.advanceTimersByTimeAsync(10_000 + 100) // 超时 race 触发

        const sections = await queryP
        expect(sections).toBeDefined()
        expect(findSection(sections, 'file')).toBeUndefined() // 超时 reject → file 分组空
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('DTO 映射', () => {
    it('AppCommand 映射无 icon + commandKind:app', async () => {
      const deps = makeDeps()
      deps.commandStore.registerApp([{ id: 'n', name: '新建', shortcut: '⌘N', action: vi.fn() }])

      const { query } = useSearch(ref<string | null>('s1'), deps)
      const sections = await query('新', { activeSessionId: 's1' })
      const cmd = findSection(sections, 'command')!.items[0]
      expect(cmd).toMatchObject({ type: 'command', title: '新建', sub: '⌘N', commandKind: 'app' })
      expect('icon' in cmd ? cmd.icon : undefined).toBeUndefined()
    })

    it('SessionCommand 映射带 icon（star）+ commandKind:slash', async () => {
      const deps = makeDeps()
      const raw = { name: 'review', source: 'skill', description: '代码评审' }
      deps.commandStore.applyCommands('s1', [raw])

      const { query } = useSearch(ref<string | null>('s1'), deps)
      const sections = await query('review', { activeSessionId: 's1' })
      const cmd = findSection(sections, 'command')!.items[0]
      expect(cmd).toMatchObject({
        type: 'command',
        title: 'review',
        sub: '代码评审',
        icon: 'star',
        commandKind: 'slash',
      })
    })

    it('skill 命令（source=skill + sourceInfo.path）→ isSkill:true + location 带出（判据同 buildPanelSlashCandidates）', async () => {
      const deps = makeDeps()
      deps.commandStore.applyCommands('s1', [
        {
          name: 'skill:code-review',
          description: '代码评审',
          source: 'skill',
          sourceInfo: { path: '/skills/code-review/SKILL.md', source: 'skill' },
        },
      ])

      const { query } = useSearch(ref<string | null>('s1'), deps)
      const sections = await query('code', { activeSessionId: 's1' })
      const cmd = findSection(sections, 'command')!.items[0]
      // isSkill 判据 = SessionCommand.kind === 'skill'（applyCommands 把 pi source 归一化进 kind）
      expect(cmd.isSkill).toBe(true)
      // SKILL.md 路径从 sourceInfo.path 带出（搜索注入侧据此落 chip dataset）
      expect(cmd.location).toBe('/skills/code-review/SKILL.md')
    })

    it('非 skill 命令（source=extension）→ isSkill:false 且无 location（命令分支零变化）', async () => {
      const deps = makeDeps()
      deps.commandStore.applyCommands('s1', [
        { name: 'commit', description: '提交', source: 'extension' },
      ])

      const { query } = useSearch(ref<string | null>('s1'), deps)
      const sections = await query('commit', { activeSessionId: 's1' })
      const cmd = findSection(sections, 'command')!.items[0]
      expect(cmd.isSkill).toBe(false)
      expect(cmd.location).toBeUndefined()
    })

    it('AppCommand 映射不带 isSkill/location（应用命令分支零变化）', async () => {
      const deps = makeDeps()
      deps.commandStore.registerApp([{ id: 'n', name: '新建', shortcut: '⌘N', action: vi.fn() }])

      const { query } = useSearch(ref<string | null>('s1'), deps)
      const sections = await query('新', { activeSessionId: 's1' })
      const cmd = findSection(sections, 'command')!.items[0]
      expect(cmd.isSkill).toBeUndefined()
      expect(cmd.location).toBeUndefined()
    })

    it('SessionSummary 无 gitBranch → sub 不含 "undefined"', async () => {
      const deps = makeDeps()
      const groups: SessionGroup[] = [
        {
          cwd: '/tmp/x',
          sessions: [
            { id: 's1', cwd: '/tmp/x', label: '测试会话' } as never,
          ],
        },
      ]
      ;(deps.ports.sessionList as ReturnType<typeof vi.fn>).mockResolvedValue(groups)

      const { query } = useSearch(ref<string | null>('s1'), deps)
      const sections = await query('测试', { activeSessionId: 's1' })
      const session = findSection(sections, 'session')!.items[0]
      expect(session.sub).toBe('/tmp/x')
      expect(session.sub.includes('undefined')).toBe(false)
    })
  })

  describe('空查询：recents + 建议命令', () => {
    it('空查询返回 recent + suggested 分组（recents 来自 storage）', async () => {
      const deps = makeDeps()
      // 预置 storage recents + 注册 app 命令（suggested 来源）
      deps.storage.set(
        'taiji:search-recents',
        JSON.stringify([{ type: 'file', key: 'file:a', timestamp: 1, title: 'a.ts', sub: 'src' }]),
      )
      deps.commandStore.registerApp([
        { id: 'n1', name: '新建', action: vi.fn() },
        { id: 'n2', name: '概览', action: vi.fn() },
        { id: 'n3', name: '收起侧栏', action: vi.fn() },
        { id: 'n4', name: '预设', action: vi.fn() },
      ])

      const { query } = useSearch(ref<string | null>('s1'), deps)
      const sections = await query('', { activeSessionId: 's1' })

      const recent = findSection(sections, 'recent')
      expect(recent).toBeTruthy()
      expect(recent!.items[0]?.title).toBe('a.ts')
      const suggested = findSection(sections, 'suggested')
      expect(suggested!.items.length).toBeLessThanOrEqual(3) // SUGGESTED_COMMAND_COUNT=3
    })
  })

  describe('mock 端口检查（tc u3/D4-②：isMock=true 而未装配 searchMock 显式抛错）', () => {
    it('isMock=true + searchMock 未装配 → reject 并指向恢复动作（不静默返空）', async () => {
      const deps = makeDeps()
      deps.ports.isMock = true
      deps.ports.searchMock = undefined

      const { query } = useSearch(ref<string | null>('s1'), deps)

      await expect(query('a', { activeSessionId: 's1' })).rejects.toThrow('SearchPorts.searchMock 未装配')
    })
  })

  describe('归档源（名称 + 摘要全文匹配，载荷透传）', () => {
    function makeArchivedArchive(): ArchiveSummary {
      return {
        sessionId: 'arc-1',
        name: 'v0.10 renderer 重构',
        originalFile: '2026-10-20T00-00-00-000Z_arc-1.jsonl',
        cwd: '/proj/x',
        archivedAt: '2026-10-20T00:00:00.000Z',
        rawBytes: 1024,
        status: 'archived',
        codec: 'zstd-3',
        compressedBytes: 256,
        sha256: 'a'.repeat(64),
        summary: { turns: [{ user: 'renderer 重构开始，先出分层方案', agent: '六层分层：Shell / Workspace' }] },
      }
    }

    function makeStagingArchive(): ArchiveSummary {
      return {
        sessionId: 'arc-2',
        name: '压缩中的会话',
        originalFile: '2026-10-20T00-00-00-000Z_arc-2.jsonl',
        cwd: '/proj/x',
        archivedAt: '2026-10-20T00:00:00.000Z',
        rawBytes: 1024,
        status: 'staging',
        summary: null,
      }
    }

    it('按名称命中 → 归档分组带载荷（archive 透传供跳转）', async () => {
      const deps = makeDeps()
      ;(deps.ports.archiveList as ReturnType<typeof vi.fn>).mockResolvedValue([makeArchivedArchive()])

      const { query } = useSearch(ref<string | null>(null), deps)
      const sections = await query('renderer', { activeSessionId: null })

      const archiveSection = findSection(sections, 'archive')
      expect(archiveSection).toBeTruthy()
      expect(archiveSection!.items[0]).toMatchObject({ type: 'archive', title: 'v0.10 renderer 重构' })
      expect(archiveSection!.items[0]!.archive?.sessionId).toBe('arc-1')
    })

    it('按摘要内容命中（名称不含查询词）→ 归档分组出现（「摘要进搜索」的落点）', async () => {
      const deps = makeDeps()
      ;(deps.ports.archiveList as ReturnType<typeof vi.fn>).mockResolvedValue([makeArchivedArchive()])

      const { query } = useSearch(ref<string | null>(null), deps)
      const sections = await query('六层分层', { activeSessionId: null })

      expect(findSection(sections, 'archive')).toBeTruthy()
    })

    it('staging 态只匹配名称（summary 为 null 无摘要可匹配），sub 标注「压缩中」', async () => {
      const deps = makeDeps()
      ;(deps.ports.archiveList as ReturnType<typeof vi.fn>).mockResolvedValue([makeStagingArchive()])

      const { query } = useSearch(ref<string | null>(null), deps)
      const byName = await query('压缩中', { activeSessionId: null })
      expect(findSection(byName, 'archive')?.items[0]?.sub).toBe('压缩中')
      // 状态标注必须经 i18n 通道取词（archive 域词条单源）——硬编码中文绕过 ports.t 的回归在此拦截
      expect(deps.ports.t).toHaveBeenCalledWith('archive.summary.compressing')

      const bySummary = await query('六层分层', { activeSessionId: null })
      expect(findSection(bySummary, 'archive')).toBeUndefined()
    })

    it('archived 态 turns 空数组 → sub 走 archive.summary.empty 词条（i18n 通道，不硬编码）', async () => {
      const deps = makeDeps()
      const emptyTurns = { ...makeArchivedArchive(), summary: { turns: [] } }
      ;(deps.ports.archiveList as ReturnType<typeof vi.fn>).mockResolvedValue([emptyTurns])

      const { query } = useSearch(ref<string | null>(null), deps)
      const sections = await query('renderer', { activeSessionId: null })

      expect(findSection(sections, 'archive')?.items[0]?.sub).toBe('（无对话记录）')
      expect(deps.ports.t).toHaveBeenCalledWith('archive.summary.empty')
    })

    it('archiveList reject → 归档分组空，其他源不阻断（MR-4.2 同款）', async () => {
      const deps = makeDeps()
      ;(deps.ports.archiveList as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('archive down'))
      deps.commandStore.registerApp([{ id: 'n', name: '新建', action: vi.fn() }])

      const { query } = useSearch(ref<string | null>(null), deps)
      const sections = await query('新', { activeSessionId: null })

      expect(findSection(sections, 'archive')).toBeUndefined()
      expect(findSection(sections, 'command')).toBeTruthy()
    })
  })
});

// ======== 来源：create-kv-slot.test.ts ========
describe("create-kv-slot", () => {
  /** KV 内存 stub：可控时序（读门禁 loadGate / 写门禁 setGate）+ 读/写失败注入 + 落盘观测。 */
  class StubKV implements KVStorage {
    private map = new Map<string, string>()
    /** 非 undefined 时 get 直接返回该原始串（注入损坏 JSON / 非对象 JSON 场景） */
    rawGet: string | undefined
    failGetError: Error | null = null
    failSetError: Error | null = null
    getCalls = 0
    setWrites: Array<[string, string]> = []
    /** 读门禁：非 null 时 get 挂起直到 releaseLoadGate（控制预载完成时点） */
    private loadGate: Promise<void> | null = null
    private openLoad: (() => void) | null = null
    /** 写门禁：armed 后的下一次 set 挂起直到 releaseSetGate（写串行链用例观测交错） */
    private setGate: Promise<void> | null = null
    private openSet: (() => void) | null = null

    /** initial：预置在 KV 的键值对（value 为已序列化字符串，模拟已持久化数据） */
    constructor(initial?: Record<string, string>) {
      if (initial) {
        for (const [k, v] of Object.entries(initial)) this.map.set(k, v)
      }
    }

    /** 关读门禁：之后的 get 挂起直到 releaseLoadGate */
    closeLoadGate(): void {
      this.loadGate = new Promise((resolve) => {
        this.openLoad = resolve
      })
    }

    releaseLoadGate(): void {
      this.openLoad?.()
      this.openLoad = null
    }

    /** armed 写门禁：下一次 set 先记录调用再挂起（可断言「已开始未完成」） */
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
 * merge 内建「内存已有值优先」加载窗口检查。
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

  describe('createKVSlot · 加载窗口检查（Map 值形态）', () => {
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
      // 窗口检查：KV 旧快照的 m1:'old' 不覆写内存新值；快照其余条目正常并入
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
      await flushAsync() // KV get 仍挂起（门禁未开）
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
});
