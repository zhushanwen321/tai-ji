/**
 * 模态表面聚合运行时注册（§6.7 模态共存守卫的数据源）——各表面挂载点注册开/关，
 * 单一事实源；编排器（Esc 层级序 / ⌘W 让位）与 view 遮蔽联动（§5.1 规则 6②）都读本模块。
 *
 * 语义要点（§6.7）：
 * - **旗标组不随注册传入**：yieldsEsc / yieldsCmdW / shieldsView 从登记表（manifest.ts）按
 *   surface id 取——注册方无权自带旗标，防「新表面自说自话声明让位」绕过登记表审查。
 * - **开合态读点 = 动作时刻直读**（isOpen getter）：真实输入（人手/CDP）的相邻按键跨宏任务，
 *   Vue 响应式 flush（微任务）必先完成（§6.7 R4 时序前提）——第一次 Esc 时注册仍开着 ⇒
 *   编排器让位；flush 后注册随挂载点注销/状态翻新 ⇒ 第二次 Esc 时聚合已是「已关」的正确态。
 *   唯一顺序前提 = 编排器 window keydown 监听注册于 AppShell 根 setup（FIFO 同相位下编排器
 *   先执行让位判定）+ 编排器不在 flush 后的异步回调中重评同一事件。
 * - **refCount 防重复注册**（同规则 2——事件总线 listener 去重同款）：同一 key 重复注册
 *   只计数，注销到 0 才移除；防挂载点重复接线/HMR 时「注册被提前摘除」。
 * - **后行档消费方的开合态必须绑状态本体**（如 SessionList 绑删除确认态），禁绑广播计数器。
 *
 * 注意：本模块不做几何求交——shieldsView='intersecting' 成员与 view 显示矩形的双阈值空间
 * 滞回判定（§6.7 抖动面缓冲裁决）归 view 链（useBrowserRectSync 侧），本模块只报
 * 「哪些开着的表面声称遮蔽 view、按哪一档」。
 */
import { modalSurfaceFlags, type ModalSurfaceId } from './manifest'

/** 单个表面实例的注册描述 */
export interface ModalSurfaceRegistration { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  /** 登记表内的表面 id（manifest.ts；未登记 id 直接抛错） */
  surface: ModalSurfaceId
  /** 实例级去重键（同 key 重复注册走 refCount；同表面多实例各用独立 key） */
  key: string
  /** 开合态读点（动作时刻直读，禁缓存） */
  isOpen: () => boolean
}

interface RegistryEntry { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面 // oe-exempt:20261003:framework:聚合注册表数据契约，消费面为编排器与各表面单元
  surface: ModalSurfaceId
  isOpen: () => boolean
  refCount: number
}

// taste:allow-no-data-owner W24-EX-A（模态表面聚合注册基建，登记草稿——同事件总线 handler
// 注册表形态：refCount 保护的表面开合态注册表，非 GUI 数据、非持久、无单一 owner；
// 待并入 docs/architecture/data-source-registry.md §4 ⑧ 豁免清单计数）
const entries = new Map<string, RegistryEntry>()

/** 注册一个表面实例；返回注销函数（幂等——重复调用只生效一次） */
export function registerModalSurface(registration: ModalSurfaceRegistration): () => void {
  // 登记红线：id 必须在登记表（manifest.ts）——未登记表面没有旗标组可读，直接拒（
  // 与 z-surface-baseline 全等断言同源的运行时保险；类型层 ModalSurfaceId 已先拦一道）
  modalSurfaceFlags(registration.surface)
  const existing = entries.get(registration.key)
  if (existing) {
    if (existing.surface !== registration.surface) {
      throw new Error(
        `modal-surface-registry: key '${registration.key}' 已被表面 '${existing.surface}' 占用，不能改注册为 '${registration.surface}'`,
      )
    }
    existing.refCount += 1
  } else {
    entries.set(registration.key, {
      surface: registration.surface,
      isOpen: registration.isOpen,
      refCount: 1,
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const entry = entries.get(registration.key)
    if (!entry) return
    entry.refCount -= 1
    if (entry.refCount <= 0) entries.delete(registration.key)
  }
}

/** 当前开着的成员条目（读点直读——动作时刻新鲜度语义见文件头） */
function openEntries(): RegistryEntry[] {
  const open: RegistryEntry[] = []
  for (const entry of entries.values()) {
    if (entry.isOpen()) open.push(entry)
  }
  return open
}

/** 让位旗标族（Esc）：任一开着的成员 yieldsEsc ⇒ 栈序编排器 Esc 不动作（§6.7 模态共存守卫②） */
export function anyModalSurfaceYieldsEsc(): boolean {
  return openEntries().some((entry) => modalSurfaceFlags(entry.surface).yieldsEsc)
}

/** 让位旗标族（⌘W）：任一开着的成员 yieldsCmdW ⇒ ⌘W 不动作（模态族让位、弹出层族不让） */
export function anyModalSurfaceYieldsCmdW(): boolean {
  return openEntries().some((entry) => modalSurfaceFlags(entry.surface).yieldsCmdW)
}

/** view 遮蔽报告：开着且 shieldsView≠'none' 的成员及档位（几何求交/滞回归 view 链，见文件头） */
export function openShieldingSurfaces(): Array<{ id: ModalSurfaceId; mode: 'unconditional' | 'intersecting' }> {
  const report: Array<{ id: ModalSurfaceId; mode: 'unconditional' | 'intersecting' }> = []
  for (const entry of openEntries()) {
    const mode = modalSurfaceFlags(entry.surface).shieldsView
    if (mode !== 'none') report.push({ id: entry.surface, mode })
  }
  return report
}

/** 某表面是否有实例开着（诊断/测试用） */
export function isModalSurfaceOpen(id: ModalSurfaceId): boolean {
  for (const entry of entries.values()) {
    if (entry.surface === id && entry.isOpen()) return true
  }
  return false
}

/**
 * 清空全部注册（**仅测试用**——注册是模块级单例，用例间必须复位；生产代码禁调）。
 * 各挂载点的注销函数不受影响（幂等注销对空表安全）。
 */
export function resetModalSurfaceRegistry(): void {
  entries.clear()
}
