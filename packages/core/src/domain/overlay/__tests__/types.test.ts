/**
 * overlay 类型契约单测 —— display-containers u-foundation（§7.1 开合态 kind/payload 单例 +
 * §6.7 模态表面聚合双键旗标）。
 *
 * 三视角：构建者白盒（判别联合/旗标结构）、使用者黑盒（浮层开合/换内容的用户可见语义锚——
 * W1 实装后生效）、观察者形态（纯类型契约形态）。类型级断言由 tsc 系执行，
 * 负向断言用条件类型锚（不依赖 @ts-expect-error）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/overlay/__tests__/types.test.ts
 */
import { describe, it, expect } from 'vitest'
import type {
  OverlayKind,
  OverlayContent,
  OverlayControlState,
  ModalSurfaceFlags,
  ShieldsViewMode,
} from '../types'

// ── 编译期断言（tsc 系执行）──

// kind 双员（browser / workflow）
const overlayKinds: OverlayKind[] = ['browser', 'workflow']

// 判别联合：browser 载荷 url / workflow 载荷 sessionId+runId（与 overlayCurrent 现状同构）
const browserContent: OverlayContent = { kind: 'browser', payload: { url: 'http://127.0.0.1:5173/' } }
const workflowContent: OverlayContent = { kind: 'workflow', payload: { sessionId: 'sess-1', runId: 'run-1' } }

// 开合态：关 = current 复位 null；开 = 单例 current
const closedState: OverlayControlState = { isOpen: false, current: null }
const openState: OverlayControlState = { isOpen: true, current: workflowContent }

// 旗标组三档样本（§6.7 登记表行——u-w1-agg 聚合成员登记的形态锚）：
// 模态族（有未提交输入）：双键均让位 + 全屏阻塞无条件遮蔽
const modalFamilyFlags: ModalSurfaceFlags = { yieldsEsc: true, yieldsCmdW: true, shieldsView: 'unconditional' }
// 弹出层族（锚定局部）：Esc 让位、⌘W 不让位（R4 双键拆分）+ 几何相交才遮蔽
const popoverFamilyFlags: ModalSurfaceFlags = { yieldsEsc: true, yieldsCmdW: false, shieldsView: 'intersecting' }
// Toast/横幅族：不消费 Esc/⌘W，仅几何相交遮蔽
const bannerFamilyFlags: ModalSurfaceFlags = { yieldsEsc: false, yieldsCmdW: false, shieldsView: 'intersecting' }

// 负向锚：shieldsView 只认三档枚举（若放宽为 string/boolean，本类型塌缩为 false、赋值 tsc 红）
type InvalidShieldsViewRejected = 'always' extends ShieldsViewMode ? false : true
const shieldsViewNegativeAnchor: InvalidShieldsViewRejected = true

describe('overlay 开合态类型契约（§7.1 单例 kind/payload 换内容）', () => {
  it('kind 双员 = browser / workflow（浮层 2 条目锚）', () => {
    expect(overlayKinds).toEqual(['browser', 'workflow'])
  })

  it('关态 current 复位 null；开态持单例 current（用户可见：关浮层无残留内容、开新内容替换旧内容）', () => {
    expect(closedState.isOpen).toBe(false)
    expect(closedState.current).toBeNull()
    expect(openState.isOpen).toBe(true)
    expect(openState.current).toBe(workflowContent)
  })

  it('payload 形状：browser=URL 注入链 / workflow=与 overlayCurrent 现状同构（SSOT 迁移对账锚）', () => {
    expect(browserContent).toEqual({ kind: 'browser', payload: { url: 'http://127.0.0.1:5173/' } })
    expect(workflowContent).toEqual({ kind: 'workflow', payload: { sessionId: 'sess-1', runId: 'run-1' } })
  })
})

describe('聚合双键旗标类型（§6.7 yieldsEsc / yields⌘W / shieldsView）', () => {
  it('模态族：双键均让位 + 无条件遮蔽（Esc/⌘W 不动作、view 无条件 hide 的契约锚）', () => {
    expect(modalFamilyFlags).toEqual({ yieldsEsc: true, yieldsCmdW: true, shieldsView: 'unconditional' })
  })

  it('弹出层族：Esc 让位、⌘W 不让位（R4 双键拆分——弹层开着 ⌘W 照常走容器层级序，不死键）', () => {
    expect(popoverFamilyFlags.yieldsEsc).toBe(true)
    expect(popoverFamilyFlags.yieldsCmdW).toBe(false)
    expect(popoverFamilyFlags.shieldsView).toBe('intersecting')
  })

  it('横幅族：双键均不让位；shieldsView 三档枚举封闭（非法档位被类型层拒绝）', () => {
    expect(bannerFamilyFlags).toEqual({ yieldsEsc: false, yieldsCmdW: false, shieldsView: 'intersecting' })
    expect(shieldsViewNegativeAnchor).toBe(true)
  })
})
