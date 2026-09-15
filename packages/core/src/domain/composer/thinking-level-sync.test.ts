/**
 * useThinkingLevelSync 单元测试。
 *
 * 被测对象：domain/composer/thinking-level-sync.ts —— 思考等级与模型同步 composable。
 * 职责：currentThinkingLevelMap 派生（经 deps.getThinkingLevelMap）+ 切模型后按体系对齐思考等级
 * + [u2] watch 回调顶部 armed 记忆恢复消费（设计 D3 规则 1/2/3 / D4 / D5）。
 *
 * 策略：mock deps.getThinkingLevelMap 为 vi.fn，按 modelId 返回可控 map；
 * currentModelId / currentThinkingLevel 用 ref 驱动；onReset 用 vi.fn 记录调用。
 * armed 套件（见下）经 deps 注入 fake armed / in-flight / 记忆表，时序对齐生产：
 * 先建 composable（immediate 触发时 armed 必为 null）→ 再设 armed → 切模型 → nextTick。
 *
 * watch 配置 `{ immediate: true }`，默认 flush 'pre'（异步）：
 * - immediate 首次回调在 useThinkingLevelSync 调用时同步执行（断言无需 await）
 * - 后续 currentModelId 变化触发的回调异步（await nextTick 等待 flush）
 *
 * 运行：cd packages/core && pnpm vitest run src/domain/composer/thinking-level-sync.test.ts
 */
import type { ThinkingLevel } from './thinking-levels'
import { describe, it, expect, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import {
  useThinkingLevelSync,
  type ArmedModelSwitchIntent,
  type ThinkingLevelSyncDeps,
} from './thinking-level-sync'

// 体系 A：off+high 两档（supportedLevels = pi 同源计算下发）
const mapA = { off: 'o', high: 'h' }
const supportedA = ['off', 'high']
// 体系 A'：同档位集（off+high），value 不同 —— 与 A 同体系
const mapASame = { off: 'o2', high: 'h2' }
// 体系 B：low+medium 两档 —— 与 A 跨体系（可用集归一后为五档）
const mapB = { low: 'l', medium: 'm' }
const supportedDefault = ['off', 'minimal', 'low', 'medium', 'high']

describe('useThinkingLevelSync', () => {
  it('case1: currentThinkingLevel 无值 + armed 显式切换 → 设新模型最高可用档（immediate 同步）', () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>(undefined)
    const onReset = vi.fn()
    // [U5/D5] 分支 2 门禁后，无档位设最高档只挂显式切换——用 armed 解锁分支（记忆未命中回落）
    const fake = fakeArmedState({ modelId: 'p/m1', at: Date.now() })
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn((id: string) => (id === 'p/m1' ? mapA : undefined)),
      getSupportedLevels: vi.fn((id: string) => (id === 'p/m1' ? supportedA : undefined)),
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    // highestAvailableLevel(supportedA) = 'high'；resolveThinkingValue('high', mapA) = 'h'
    expect(onReset).toHaveBeenCalledWith('h')
  })

  it('case2: 同体系切换（armed 显式切换）→ 映射迁移当前档位 value', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>(undefined)
    const onReset = vi.fn()
    // [U5/D5] 分支 2/4 门禁后，两阶段各需 armed 解锁
    const fake = fakeArmedState({ modelId: 'p/m1', at: Date.now() })
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn((id: string) => {
        if (id === 'p/m1') return mapA
        if (id === 'p/m2') return mapASame
        return undefined
      }),
      getSupportedLevels: vi.fn(() => supportedA),
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    // immediate：current undefined → onReset('h')
    expect(onReset).toHaveBeenCalledWith('h')

    // 模拟 session 载入/用户选档 → current 有值
    currentThinkingLevel.value = 'h'
    // 显式切到同体系模型 → map: mapA → mapASame
    fake.setArmed({ modelId: 'p/m2', at: Date.now() })
    currentModelId.value = 'p/m2'
    await nextTick()
    // isSameThinkingScheme(mapA, mapASame) = true（key 集合相同）
    // currentKey = resolveThinkingKey('h', mapA) = 'high'
    // newValue = resolveThinkingValue('high', mapASame) = 'h2'；'h2' !== 'h' → onReset('h2')
    expect(onReset).toHaveBeenCalledWith('h2')
  })

  it('case3: 跨体系切换 → 重置到新模型最高可用档', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn((id: string) => {
        if (id === 'p/m1') return mapA
        if (id === 'p/m3') return mapB
        return undefined
      }),
      getSupportedLevels: vi.fn((id: string) => (id === 'p/m1' ? supportedA : supportedDefault)),
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    // immediate：current 'h' 有值，oldMap undefined → 分支 3 可用性检查
    // resolveThinkingKey('h', mapA) = 'high'；available(mapA) = ['off','high'] includes 'high' → 不重置
    expect(onReset).not.toHaveBeenCalled()

    // [U5/D5] 显式切到跨体系模型（armed 解锁分支 5）
    const fake = fakeArmedState()
    deps.getArmed = fake.getArmed
    deps.clearArmed = fake.clearArmed
    fake.setArmed({ modelId: 'p/m3', at: Date.now() })
    currentModelId.value = 'p/m3'
    await nextTick()
    // isSameThinkingScheme(mapA, mapB) = false（新语义可用集：['off','high'] vs 五档）
    // 跨体系：highestAvailableLevel(mapB) = 'high'（叠加规则 off..high）；
    // resolveThinkingValue('high', mapB) = 'high'（mapB 无 high key 回退 key 自身）
    // 'high' !== 'h' → onReset('high')
    expect(onReset).toHaveBeenCalledWith('high')
  })

  it('case4: 无 newMap（getThinkingLevelMap 返回 undefined）+ current 有值 → 不重置', () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('high')
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn(() => undefined),
      getSupportedLevels: vi.fn(() => undefined),
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    // immediate：current 'high' 有值，oldMap undefined → 分支 3
    // resolveThinkingKey('high', undefined) = 'high'（isThinkingLevel 直接命中）
    // normalizeSupportedLevels(undefined) = 默认五档 includes 'high' → true → 不重置
    expect(onReset).not.toHaveBeenCalled()
  })

  it('currentThinkingLevelMap 派生：返回 deps.getThinkingLevelMap 结果', () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>(undefined)
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn(() => mapA),
      getSupportedLevels: vi.fn(() => supportedA),
    }
    const currentThinkingLevelMap = useThinkingLevelSync(
      currentModelId,
      computed(() => currentThinkingLevel.value),
      onReset,
      deps,
    )
    expect(currentThinkingLevelMap.value).toBe(mapA)
    // 切 modelId 后派生刷新
    currentModelId.value = 'p/m9'
    expect(currentThinkingLevelMap.value).toBe(mapA) // mock 恒返回 mapA
    expect(deps.getThinkingLevelMap).toHaveBeenCalledWith('p/m9')
  })

  it('U11: 切到 non-reasoning 模型（getSupportedLevels 返回 ["off"]）→ 重置到 off', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn((id: string) => (id === 'p/m1' ? mapA : undefined)),
      // non-reasoning 模型的 supportedLevels = ['off']（pi 同源计算两级门控产物）
      getSupportedLevels: vi.fn((id: string) => (id === 'p/nonreasoning' ? ['off'] : supportedA)),
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    // [U5/D5] 显式切到 non-reasoning 模型（armed 解锁对齐分支）：可用档只有 ['off']，当前 'h' 不可用
    const fake = fakeArmedState()
    deps.getArmed = fake.getArmed
    deps.clearArmed = fake.clearArmed
    fake.setArmed({ modelId: 'p/nonreasoning', at: Date.now() })
    currentModelId.value = 'p/nonreasoning'
    await nextTick()
    // highestAvailableLevel(['off']) = 'off'；resolveThinkingValue('off', undefined) = 'off'
    expect(onReset).toHaveBeenCalledWith('off')
  })

  it('U12: 首次触发（oldMap undefined）+ non-reasoning 模型 + 当前档不可用 → 重置到 off（漏传 reasoning 会落到 high/max）', () => {
    const currentModelId = ref('p/nonreasoning')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn(() => ({ off: 'off', high: 'h', max: 'm' })),
      // non-reasoning：pi 同源计算产物 = ['off']（map 写得再多也压不过两级门控）
      getSupportedLevels: vi.fn(() => ['off']),
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    // immediate 首次触发：oldMap === undefined，current 'h' 有值
    // currentKey = resolveThinkingKey('h', map) = 'high'；
    // normalizeSupportedLevels(['off']) 不含 'high' → 重置
    // highestAvailableLevel(['off']) = 'off' → resolveThinkingValue('off', map) = 'off'
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('off')
  })

  it('U11b: 切到 map 缺失模型（pi 默认五档）→ 当前不可用档重置到 high 而非 max', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('xhigh') // mimo 无此档
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn(() => undefined), // xiaomi-token-plan-cn/mimo-v2.5-pro 场景
      getSupportedLevels: vi.fn(() => supportedDefault),
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    currentModelId.value = 'p/mimo'
    await nextTick()
    // 可用集五档（无 max），最高可用档 = high → onReset('high')
    expect(onReset).toHaveBeenCalledWith('high')
  })
})

// ══════════ [u2] armed 记忆恢复消费（D3 规则 1/2/3 / D4 / D5）══════════
//
// 公共模型对（跨体系）：m1 = mapA/supportedA（体系 A），m2 = mapB/supportedDefault（体系 B）。
// m1→m2 切换时既有分支（跨体系重置）会 onReset('high')；记忆恢复值
// resolveThinkingValue('low', mapB) = 'l'——两个值不同，用 onReset 收到的值即可
// 断言「走的是记忆恢复还是既有分支」，无需额外探针。
//
// 时序对齐生产：armed 由 u3 在用户显式选模型时设立，必然晚于 composable 创建
// （immediate 触发时 armed 为 null），故每例先建 composable 再设 armed。

/** armed 记账：getArmed 读闭包变量、clearArmed 置 null 并计数（模拟 u3 的一次性标志语义） */
function fakeArmedState(initial: ArmedModelSwitchIntent | null = null) {
  let armed = initial
  const clearArmed = vi.fn(() => {
    armed = null
  })
  const getArmed = vi.fn(() => armed)
  return {
    getArmed,
    clearArmed,
    setArmed: (a: ArmedModelSwitchIntent | null) => (armed = a),
  }
}

/** 组装跨体系模型对的 deps，extra 覆盖注入 armed / in-flight / 记忆表 */
function crossDeps(extra: Partial<ThinkingLevelSyncDeps> = {}): ThinkingLevelSyncDeps {
  return {
    getThinkingLevelMap: vi.fn((id: string) => (id === 'p/m1' ? mapA : mapB)),
    getSupportedLevels: vi.fn((id: string) => (id === 'p/m1' ? supportedA : supportedDefault)),
    ...extra,
  }
}

describe('useThinkingLevelSync · armed 记忆恢复消费', () => {
  it('规则 1：armed 过期（>5s）且 in-flight 为零 → 清 armed 走既有分支，不消费记忆', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const fake = fakeArmedState()
    const deps = crossDeps({
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
      getInFlightCount: () => 0,
      // 记忆存在且可用——若过期 token 被误消费会 onReset('l') 而非既有分支的 'high'
      getRememberedLevel: vi.fn((): ThinkingLevel | undefined => 'low'),
    })
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    expect(onReset).not.toHaveBeenCalled() // immediate：armed null 零副作用

    fake.setArmed({ modelId: 'p/m2', at: Date.now() - 6000 }) // 已过期 6s
    currentModelId.value = 'p/m2'
    await nextTick()
    // 过期 token 只清不消费（陈旧 token 消费 = chip 突跳伪恢复，D3 被否②a）
    expect(fake.clearArmed).toHaveBeenCalledTimes(1)
    // 落到既有跨体系分支：onReset('high')，且全程只有这一次（非记忆值 'l'）
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('high')
  })

  it('规则 1 · E10 豁免：armed 过期但 in-flight > 0 → 不清，匹配消费照常进行', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const fake = fakeArmedState()
    const deps = crossDeps({
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
      getInFlightCount: () => 1, // 慢 RPC 在途：finally 撤销计数晚于本次 flush（E10 豁免窗）
      getRememberedLevel: vi.fn((): ThinkingLevel | undefined => 'low'),
    })
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    fake.setArmed({ modelId: 'p/m2', at: Date.now() - 6000 })
    currentModelId.value = 'p/m2'
    await nextTick()
    // 豁免窗内不按过期清；匹配 + 命中 + 可用 + 'l' !== 'h' → 恢复消费
    expect(fake.clearArmed).toHaveBeenCalledTimes(1) // 消费即清（非过期清）
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('l')
  })

  it('规则 2 命中恢复：onReset 收到记忆 key 经新 map 换算的 value，且 return 跳过既有分支', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const fake = fakeArmedState()
    const deps = crossDeps({
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
      getInFlightCount: () => 0,
      getRememberedLevel: vi.fn((id: string) => (id === 'p/m2' ? 'low' : undefined)),
    })
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    fake.setArmed({ modelId: 'p/m2', at: Date.now() })
    currentModelId.value = 'p/m2'
    await nextTick()
    // 'low' ∈ 默认五档（可用）；resolveThinkingValue('low', mapB) = 'l' ≠ 'h' → 恢复
    expect(fake.clearArmed).toHaveBeenCalledTimes(1)
    // 「跳过既有分支」断言：若无 return，跨体系分支会再发一次 onReset('high')——
    // 总调用次数恰为 1 且值为 'l'，证明既有分支副作用未触发（D4 防双重 onReset）
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('l')
  })

  it('规则 2 幂等：换算后 value === 当前档位 → 不发 onReset，清 armed 走既有分支', async () => {
    const currentModelId = ref('p/plain1')
    const currentThinkingLevel = ref<string | undefined>('high')
    const onReset = vi.fn()
    const fake = fakeArmedState()
    // 无 map 模型对（all-levels，value = key）：恢复值与当前值天然相等
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn(() => undefined),
      getSupportedLevels: vi.fn(() => supportedDefault),
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
      getInFlightCount: () => 0,
      getRememberedLevel: vi.fn((id: string) => (id === 'p/plain2' ? 'high' : undefined)),
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    fake.setArmed({ modelId: 'p/plain2', at: Date.now() })
    currentModelId.value = 'p/plain2'
    await nextTick()
    // 幂等：resolveThinkingValue('high', undefined) = 'high' === current → 不发恢复 onReset；
    // 既有同体系分支自身也是 value 未变不 RPC → 全程零 onReset
    expect(fake.clearArmed).toHaveBeenCalledTimes(1)
    expect(onReset).not.toHaveBeenCalled()
  })

  it('规则 2 未命中（记忆无该模型条目）→ 清 armed 回落既有分支', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const fake = fakeArmedState()
    const getRememberedLevel = vi.fn(() => undefined)
    const deps = crossDeps({
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
      getRememberedLevel,
    })
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    fake.setArmed({ modelId: 'p/m2', at: Date.now() })
    currentModelId.value = 'p/m2'
    await nextTick()
    expect(getRememberedLevel).toHaveBeenCalledWith('p/m2')
    expect(fake.clearArmed).toHaveBeenCalledTimes(1)
    // 回落既有跨体系分支 onReset('high')
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('high')
  })

  it('规则 2 记忆依赖未注入（getRememberedLevel 缺省）→ 视为未命中回落既有分支', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const fake = fakeArmedState()
    const deps = crossDeps({ getArmed: fake.getArmed, clearArmed: fake.clearArmed })
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    fake.setArmed({ modelId: 'p/m2', at: Date.now() })
    currentModelId.value = 'p/m2'
    await nextTick()
    expect(fake.clearArmed).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('high')
  })

  it('规则 2 不可用（D5）：记忆 key 不在新模型可用集 → 清 armed 回落既有分支，不发非法档', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const fake = fakeArmedState()
    const deps = crossDeps({
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
      // m2 可用集为默认五档（无 max），记忆值 'max' 不可用
      getRememberedLevel: vi.fn((): ThinkingLevel | undefined => 'max'),
    })
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    fake.setArmed({ modelId: 'p/m2', at: Date.now() })
    currentModelId.value = 'p/m2'
    await nextTick()
    expect(fake.clearArmed).toHaveBeenCalledTimes(1)
    // 回落既有分支 onReset('high')；绝未把不可用的 'max' 发出去（D5）
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('high')
    expect(onReset).not.toHaveBeenCalledWith('max')
  })

  it('规则 3：模型不匹配 → 保留 armed 且既有分支正常跑；token 存活至匹配触发才消费', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const fake = fakeArmedState()
    // m3 = mapASame/supportedA（与 m2 不同 map，保证 m2→m3 watch 会触发）
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn((id: string) => {
        if (id === 'p/m1') return mapA
        if (id === 'p/m2') return mapB
        if (id === 'p/m3') return mapASame
        return undefined
      }),
      getSupportedLevels: vi.fn((id: string) => (id === 'p/m2' ? supportedDefault : supportedA)),
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
      getRememberedLevel: vi.fn((id: string) => (id === 'p/m3' ? 'high' : undefined)),
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)

    // 阶段 1：armed 目标是 m3，但先切到 m2（RPC 在途换目标等价形态）→ 不匹配
    fake.setArmed({ modelId: 'p/m3', at: Date.now() })
    currentModelId.value = 'p/m2'
    await nextTick()
    // 规则 3：不动 armed，既有跨体系分支照常 onReset('high')
    expect(fake.clearArmed).not.toHaveBeenCalled()
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('high')

    // 阶段 2：到达目标 m3 → 匹配消费（token 在阶段 1 存活未被误清）
    // 'high' ∈ supportedA；resolveThinkingValue('high', mapASame) = 'h2' ≠ 'h' → 恢复
    currentModelId.value = 'p/m3'
    await nextTick()
    expect(fake.clearArmed).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledTimes(2)
    expect(onReset).toHaveBeenLastCalledWith('h2')
  })

  it('回归基线：getArmed 注入但返回 null → 消费块零副作用 + [U5/D5] 对齐分支全被门禁', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const fake = fakeArmedState() // armed 恒 null
    const getRememberedLevel = vi.fn((): ThinkingLevel | undefined => 'low')
    const deps = crossDeps({
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
      getRememberedLevel,
    })
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    currentModelId.value = 'p/m2'
    await nextTick()
    // 消费块零副作用：armed null 早退，记忆查询从未发起
    expect(fake.getArmed).toHaveBeenCalled()
    expect(getRememberedLevel).not.toHaveBeenCalled()
    expect(fake.clearArmed).not.toHaveBeenCalled()
    // [U5/D5] 无入口快照 → 跨体系重置分支被门禁，全程零 onReset（不发生 setThinkingLevel）
    expect(onReset).not.toHaveBeenCalled()
  })
})

// ══════════ [U5/D5] armed 入口快照门禁 ══════════
//
// 设计 composer-model-session-isolation D5：对齐只挂「用户显式切模型」。门禁判据 =
// 回调入口 armed 快照（consumeArmedRestore 执行前捕获）——分支 2/4/5 无快照一律跳过，
// 分支 3（可用性校验）保持不门禁。

describe('useThinkingLevelSync · U5 D5 门禁', () => {
  it('a) armed null + 换绑触发（oldMap 有值、模型变化）→ 不发 onReset（分支 4/5 被门禁，探针 A1 单测层）', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    // 换绑形态：getArmed 未注入（消费块零副作用）等价于 armed 恒 null
    const deps = crossDeps()
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    // immediate：oldMap undefined → 分支 3（不门禁），'h' 可用 → 不重置
    expect(onReset).not.toHaveBeenCalled()

    currentModelId.value = 'p/m2' // 跨体系，oldMap 有值
    await nextTick()
    expect(onReset).not.toHaveBeenCalled() // 分支 5 被门禁，无 setThinkingLevel
  })

  it('b) armed 非 null + 记忆未命中 → 对齐分支照常执行（同体系映射 onReset 一次）', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const fake = fakeArmedState()
    // m2 = mapASame（与 m1 同体系）：命中对齐分支 4
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn((id: string) => (id === 'p/m1' ? mapA : mapASame)),
      getSupportedLevels: vi.fn(() => supportedA),
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
      getRememberedLevel: vi.fn(() => undefined), // 记忆未命中
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    fake.setArmed({ modelId: 'p/m2', at: Date.now() })
    currentModelId.value = 'p/m2'
    await nextTick()
    // consume 回落清 armed，但入口快照非 null → 分支 4 放行：'h' → 'h2' 恰一次
    expect(fake.clearArmed).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('h2')
  })

  it('c) armed 非 null + 记忆命中 → consume 路径 onReset(记忆换算值)，既有分支不二次触发', async () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const fake = fakeArmedState()
    const deps = crossDeps({
      getArmed: fake.getArmed,
      clearArmed: fake.clearArmed,
      getRememberedLevel: vi.fn((id: string) => (id === 'p/m2' ? 'low' : undefined)),
    })
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    fake.setArmed({ modelId: 'p/m2', at: Date.now() })
    currentModelId.value = 'p/m2'
    await nextTick()
    // 恢复值 resolveThinkingValue('low', mapB) = 'l'；若无 D4 return，分支 5 会再发 'high'
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('l')
  })

  it('d) armed null + 挂载首触发（oldMap undefined）+ 当前档位不可用 → 分支 3 照常 onReset 最高档（不门禁）', () => {
    const currentModelId = ref('p/nonreasoning')
    const currentThinkingLevel = ref<string | undefined>('h')
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn(() => ({ off: 'off', high: 'h' })),
      getSupportedLevels: vi.fn(() => ['off']),
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    // immediate：oldMap undefined → 分支 3 可用性安全网（D5 明确不门禁）
    // 'high' ∉ ['off'] → onReset('off') 恰一次
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledWith('off')
  })

  it('e) armed null + current 无值（landing 形态）→ 不发 onReset（分支 2 被门禁）', () => {
    const currentModelId = ref('p/m1')
    const currentThinkingLevel = ref<string | undefined>(undefined)
    const onReset = vi.fn()
    const deps: ThinkingLevelSyncDeps = {
      getThinkingLevelMap: vi.fn(() => mapA),
      getSupportedLevels: vi.fn(() => supportedA),
    }
    useThinkingLevelSync(currentModelId, computed(() => currentThinkingLevel.value), onReset, deps)
    // landing 初值由 resolveLaunchConfig 解析链给出（authored-only，U2a 后无 follow watch）
    expect(onReset).not.toHaveBeenCalled()
  })
})
