/**
 * bottom-drawer layout 单测 —— display-containers u-w1-core 验收①「全局单键持久化 + clamp」。
 *
 * 覆盖：heightPct 全局单键（taiji:bottom-drawer-height）读写与重载恢复 / 默认 35 /
 * 损坏值回落 / 载入 clamp / 加载窗口守卫（在途快照不覆写窗口内新写）/
 * 拖拽 clamp（写侧 15%–70%）/ 显示期 clamp（读侧纯函数、**不写回**持久值）。
 *
 * 三视角：构建者白盒（KVSlot 生命周期 + 窗口守卫）、使用者黑盒（「拖到 50% 刷新后还是 50%；
 * 矮窗显示变矮但拉回窗口高度后回到 50%」的用户可见语义）、观察者形态（KV 落盘值形状）。
 *
 * 策略：KV 用内存 stub 实现 KVStorage（model-thinking-memory.test.ts 同款），platform 经
 * providePlatform 注入；无 timer（异步仅微任务链），await flush() 即可全部落地，无需 fake timers。
 *
 * 运行：cd packages/core && npx vitest run src/domain/bottom-drawer/__tests__/layout.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  providePlatform,
  __resetPlatformForTesting,
  type KVStorage,
  type PlatformPort,
} from '../../../platform/port'
import {
  BOTTOM_DRAWER_HEIGHT_KEY,
  BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT,
  BOTTOM_DRAWER_HEIGHT_MAX_PCT,
  BOTTOM_DRAWER_HEIGHT_MIN_PCT,
} from '../types'
import {
  clampBottomDrawerHeightPct,
  resolveBottomDrawerDisplayPct,
  getBottomDrawerHeightPct,
  loadBottomDrawerHeightOnce,
  setBottomDrawerHeightPct,
  useBottomDrawerLayout,
  _resetBottomDrawerLayoutForTest,
} from '../layout'

/** KV 内存 stub：peek 看落盘值，setWrites 记录每次写穿（model-thinking-memory.test.ts 同款） */
class StubKV implements KVStorage {
  private map = new Map<string, string>()
  /** 非 undefined 时 get 直接返回该原始串（注入损坏 JSON / 越界值场景） */
  rawGet: string | undefined
  setWrites: Array<[string, string]> = []
  private gate: Promise<void> | null = null
  private open: (() => void) | null = null

  /** initialRaw：预置在权威 key 下的原始串（模拟已持久化的高度值） */
  constructor(initialRaw?: string) {
    if (initialRaw !== undefined) this.map.set(BOTTOM_DRAWER_HEIGHT_KEY, initialRaw)
  }

  /** 关闸：之后的 get 挂起直到 openGateNow（控制预载完成时点，测加载窗口守卫） */
  closeGate(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve
    })
  }

  openGateNow(): void {
    this.open?.()
    this.open = null
  }

  peek(): string | undefined {
    return this.map.get(BOTTOM_DRAWER_HEIGHT_KEY)
  }

  async get(key: string): Promise<string | null> {
    if (this.gate) await this.gate
    if (this.rawGet !== undefined) return this.rawGet
    return this.map.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.setWrites.push([key, value])
    this.map.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
}

/** 微任务链全部落地（KV 读 + 写穿串行链），无 timer 故免 fake timers */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

let kv: StubKV

function useKv(initialRaw?: string): StubKV {
  kv = new StubKV(initialRaw)
  providePlatform({ kind: 'mock', storage: kv, webSocket: { create: () => { throw new Error('unused') } } } as PlatformPort)
  return kv
}

beforeEach(() => {
  _resetBottomDrawerLayoutForTest()
})

afterEach(() => {
  __resetPlatformForTesting()
})

describe('heightPct 全局单键持久化（taiji:bottom-drawer-height）', () => {
  it('拖拽写入 50 → 内存 50 + 落盘单键 "50"；重载（刷新）后恢复 50（用户可见：刷新后高度保持）', async () => {
    useKv()
    setBottomDrawerHeightPct(50)
    expect(getBottomDrawerHeightPct()).toBe(50)
    await flush()
    expect(kv.setWrites).toEqual([[BOTTOM_DRAWER_HEIGHT_KEY, '50']])
    expect(kv.peek()).toBe('50')
    // 模拟刷新：模块状态复位（内存回默认）后重新预载，从 KV 恢复
    _resetBottomDrawerLayoutForTest()
    expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)
    loadBottomDrawerHeightOnce()
    await flush()
    expect(getBottomDrawerHeightPct()).toBe(50)
  })

  it('无持久值 / 损坏值 / 形状不符 → 默认 35 启动（E1 空启动回落）', async () => {
    for (const raw of [undefined, 'oops', '"50"', 'null']) {
      _resetBottomDrawerLayoutForTest()
      __resetPlatformForTesting()
      useKv(raw)
      loadBottomDrawerHeightOnce()
      await flush()
      expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)
    }
  })

  it('越界持久值载入即 clamp 回区间（99→70 / 3→15）——载入 clamp 不落盘、不改写权威值', async () => {
    useKv('99')
    loadBottomDrawerHeightOnce()
    await flush()
    expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_MAX_PCT)
    expect(kv.setWrites).toEqual([]) // 读侧 clamp 不写回（S2「clamp 未写回」同语义）
  })

  it('加载窗口守卫：预载在途时的拖拽新值不被在途旧快照覆写，且补写收敛到新值', async () => {
    useKv('40')
    kv.closeGate()
    loadBottomDrawerHeightOnce() // get 挂起（加载窗口内）
    setBottomDrawerHeightPct(60) // 窗口内写入（deferred 写穿）
    expect(getBottomDrawerHeightPct()).toBe(60)

    kv.openGateNow()
    await flush()

    // 在途旧快照 40 不覆写窗口内新写 60；deferred 补写把 60 收敛落盘（不双丢）
    expect(getBottomDrawerHeightPct()).toBe(60)
    expect(kv.peek()).toBe('60')
  })

  it('useBottomDrawerLayout 触发惰性预载（首个消费方组装点）+ 响应式读出', async () => {
    useKv('45')
    const layout = useBottomDrawerLayout()
    await flush()
    expect(layout.heightPct.value).toBe(45)
  })
})

describe('clamp 两形态（§7.1 拖拽 clamp 15%–70% / 显示期 clamp 不写回）', () => {
  it('拖拽 clamp（写侧）：越界写入钳到区间端点，NaN 防御回落默认', () => {
    expect(clampBottomDrawerHeightPct(90)).toBe(BOTTOM_DRAWER_HEIGHT_MAX_PCT)
    expect(clampBottomDrawerHeightPct(0)).toBe(BOTTOM_DRAWER_HEIGHT_MIN_PCT)
    expect(clampBottomDrawerHeightPct(35)).toBe(35)
    expect(clampBottomDrawerHeightPct(Number.NaN)).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)
    expect(clampBottomDrawerHeightPct(Number.POSITIVE_INFINITY)).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)
  })

  it('setBottomDrawerHeightPct 先 clamp 再落值（用户可见：拖到头即停在 15%/70%）', async () => {
    useKv()
    setBottomDrawerHeightPct(90)
    expect(getBottomDrawerHeightPct()).toBe(70)
    setBottomDrawerHeightPct(-3)
    expect(getBottomDrawerHeightPct()).toBe(15)
    await flush()
    // 写穿是整键快照（KVSlot 串行链）：连写合并收敛为最新全量态
    expect(kv.peek()).toBe('15')
  })

  it('非有限输入整条丢弃（边界：不落脏值、不写穿）', async () => {
    useKv()
    setBottomDrawerHeightPct(50)
    setBottomDrawerHeightPct(Number.NaN)
    expect(getBottomDrawerHeightPct()).toBe(50)
    await flush()
    expect(kv.setWrites).toEqual([[BOTTOM_DRAWER_HEIGHT_KEY, '50']])
  })

  it('显示期 clamp：矮窗按「对话流+composer 最小可视区」上限钳制（用户可见：矮窗对话区不被挤没）', () => {
    // 1000px 窗、主区至少 300px → 上限 70%，35% 不受影响
    expect(resolveBottomDrawerDisplayPct(35, 1000, 300)).toBe(35)
    // 800px 窗、主区至少 600px → 上限 25%，35% 被钳到 25%
    expect(resolveBottomDrawerDisplayPct(35, 800, 600)).toBe(25)
    // 极矮窗（主区下限已超窗高）→ 显示高趋 0（主区保证优先于 15% 下限，§11-1 校准点）
    expect(resolveBottomDrawerDisplayPct(35, 300, 400)).toBe(0)
    // 布局未就绪（viewport ≤ 0）→ 回目标值，不除零
    expect(resolveBottomDrawerDisplayPct(35, 0, 300)).toBe(35)
    // 目标值本身先过拖拽 clamp（外部写脏 90 → 显示侧同界 70）
    expect(resolveBottomDrawerDisplayPct(90, 1000, 0)).toBe(70)
  })

  it('显示期 clamp 不写回：求值后内存值与 KV 落盘均不变（恢复窗口高度回到拖拽持久值）', async () => {
    useKv()
    setBottomDrawerHeightPct(50)
    await flush()
    kv.setWrites.length = 0

    resolveBottomDrawerDisplayPct(50, 800, 600) // 矮窗显示钳到 25%

    expect(getBottomDrawerHeightPct()).toBe(50) // 内存值未被显示钳制污染
    expect(kv.setWrites).toEqual([]) // 零写穿（S2「clamp 未写回」机器锚）
  })
})
