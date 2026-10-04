/**
 * bottom-drawer 类型契约单测 —— display-containers u-foundation（§7.1 控制态粒度裁决 + 单键/clamp 锚值）。
 *
 * 三视角：构建者白盒（两个状态类型分粒度的结构）、使用者黑盒（开合默认关、默认高 35% 的
 * 用户可见锚——W1 实装后生效，本测锁定契约值防漂移）、观察者形态（纯数据契约形态）。
 * 类型级断言由 tsc 系执行（esbuild 转译不校验类型），运行期用例验证锚值与边界序。
 *
 * 运行：cd packages/core && npx vitest run src/domain/bottom-drawer/__tests__/types.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  BOTTOM_DRAWER_HEIGHT_KEY,
  BOTTOM_DRAWER_HEIGHT_MIN_PCT,
  BOTTOM_DRAWER_HEIGHT_MAX_PCT,
  BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT,
} from '../types'
import type { BottomDrawerControlState, BottomDrawerLayoutState } from '../types'

// ── 编译期断言（tsc 系执行）──

// 开合控制态零加员（per-session 分区形态锚：若未来加全局字段到本接口，粒度裁决被破坏须重审）
const minimalControlState: BottomDrawerControlState = { isOpen: false }

// 布局值独立成类型（per-session / 全局两粒度不得混入同一状态对象）
const defaultLayoutState: BottomDrawerLayoutState = { heightPct: BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT }

describe('bottom-drawer 类型契约（§7.1 粒度裁决）', () => {
  it('开合态默认关（用户可见：刷新后底抽屉关闭——isOpen 不持久化语义的锚值）', () => {
    expect(minimalControlState.isOpen).toBe(false)
  })

  it('heightPct 全局单键 = taiji:bottom-drawer-height（对齐 taiji:drawer-width 先例）', () => {
    expect(BOTTOM_DRAWER_HEIGHT_KEY).toBe('taiji:bottom-drawer-height')
    expect(BOTTOM_DRAWER_HEIGHT_KEY).not.toBe('taiji:drawer-width')
  })

  it('clamp 区间边界（15%–70%）与默认值（35%）逐字锚', () => {
    expect(BOTTOM_DRAWER_HEIGHT_MIN_PCT).toBe(15)
    expect(BOTTOM_DRAWER_HEIGHT_MAX_PCT).toBe(70)
    expect(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT).toBe(35)
  })

  it('边界用例：min < default < max 且默认值在 clamp 区间内（拖拽 clamp 判定的常量前提）', () => {
    expect(BOTTOM_DRAWER_HEIGHT_MIN_PCT).toBeLessThan(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)
    expect(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT).toBeLessThan(BOTTOM_DRAWER_HEIGHT_MAX_PCT)
    expect(defaultLayoutState.heightPct).toBeGreaterThanOrEqual(BOTTOM_DRAWER_HEIGHT_MIN_PCT)
    expect(defaultLayoutState.heightPct).toBeLessThanOrEqual(BOTTOM_DRAWER_HEIGHT_MAX_PCT)
    // 区间非退化（min === max 会让拖拽手柄不可动）
    expect(BOTTOM_DRAWER_HEIGHT_MAX_PCT - BOTTOM_DRAWER_HEIGHT_MIN_PCT).toBeGreaterThan(0)
  })
})
