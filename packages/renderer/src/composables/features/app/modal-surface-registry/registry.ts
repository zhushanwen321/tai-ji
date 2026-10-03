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
 * - **refCount 计数 + 最新注册者 wins**（同规则 2——事件总线 listener 去重同款）：同一 key
 *   重复注册继续计数，注销到 0 才移除（防挂载点重复接线/HMR 时「注册被提前摘除」）；同时
 *   条目的 isOpen/rect 读点**覆盖为最新注册者**——同 key 前后实例交接（如 ToastContainer
 *   在 App.vue connecting 态 → PanelContainer/MainPanel 三挂载点交接）时读点必须指向
 *   活实例：保留首注册者 getters 会把 rect 读点留在已卸载实例上（containerRef=null ⇒
 *   rect 恒 null ⇒ main 侧保守恒相交，§5.1 规则 6② 几何相交判定失效）。
 *   「挂载⇔开」语义不变：实例挂载即注册、卸载即注销，条目只在 refCount 归零时摘除。
 * - **后行档消费方的开合态必须绑状态本体**（如 SessionList 绑删除确认态），禁绑广播计数器。
 *
 * 注意：本模块不做几何求交——shieldsView='intersecting' 成员与 view 显示矩形的双阈值空间
 * 滞回判定（§6.7 抖动面缓冲裁决）归 main 侧 view 收口链（browser gateway display-gate），
 * 本模块只报「哪些开着的表面声称遮蔽 view、按哪一档、开态几何是多少」（rect 读点）。
 */
import { shallowRef } from 'vue'
import { modalSurfaceFlags, type ModalSurfaceId } from './manifest'

/** 表面几何矩形（视口坐标 CSS px，getBoundingClientRect 同空间；view rect 链同一坐标系） */
export interface ModalSurfaceRect {
  x: number
  y: number
  width: number
  height: number
}

/** 单个表面实例的注册描述 */
export interface ModalSurfaceRegistration { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  /** 登记表内的表面 id（manifest.ts；未登记 id 直接抛错） */
  surface: ModalSurfaceId
  /** 实例级去重键（同 key 重复注册走 refCount 计数 + 读点覆盖为最新注册者；
   *  同表面多实例并存各用独立 key——同 key 语义 = 同一挂载点的前后实例交接） */
  key: string
  /** 开合态读点（动作时刻直读，禁缓存） */
  isOpen: () => boolean
  /** 开态几何读点（view 遮蔽族 'intersecting' 成员上报用，§5.1 规则 6②）：读点直读 DOM
   *  实测（getBoundingClientRect）；缺省/返回 null = 不带 rect 上报（main 侧保守按相交处理）。
   *  全屏阻塞面（unconditional）无需提供——fullscreen 上报不带 rect。 */
  rect?: () => ModalSurfaceRect | null
}

interface RegistryEntry { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面 // oe-exempt:20261003:framework:聚合注册表数据契约，消费面为编排器与各表面单元
  surface: ModalSurfaceId
  isOpen: () => boolean
  rect?: () => ModalSurfaceRect | null
  refCount: number
}

/** 成员表版本号（membership 变更信号源）：注册新条目 / 覆盖既有条目读点（挂载点交接，
 *  读点集合变更需让消费方改绑依赖）/ 注销摘除条目时递增。view 遮蔽
 *  联动（useShieldsViewSync）的反应式触发面依赖它——成员表的增删本身不是 Vue 响应式
 *  变更（Map 非响应式），查询方必须在读点消费本版本号才能追踪「挂载⇔开」型成员
 *  （isOpen 不读任何响应式 ref，卸载即注销）的开合翻转。
 *  taste:allow-no-data-owner W24-EX-A（同 entries——注册基建的成员表变更计数器，
 *  派生信号非独立数据源，owner 归属同一登记例外） */
const membershipVersion = shallowRef(0)

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
    // 最新注册者 wins（D3 S9 真机实锤修复）：同 key 重复注册 = 同一挂载点的前后实例交接，
    // 读点立即切到最新活实例——refCount 只保证「注销不提前摘条目」，不决定读点归属。
    existing.isOpen = registration.isOpen
    existing.rect = registration.rect
    // 覆盖读点 = 条目有效读点集合变更：递增版本号让响应式消费方（useShieldsViewSync 的
    // watchEffect）重跑并改绑新 getter 读到的状态本体依赖——旧实例的依赖已随卸载失效，
    // 不重绑会让开合翻转对消费方不可见。
    membershipVersion.value += 1
  } else {
    entries.set(registration.key, {
      surface: registration.surface,
      isOpen: registration.isOpen,
      rect: registration.rect,
      refCount: 1,
    })
    membershipVersion.value += 1
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const entry = entries.get(registration.key)
    if (!entry) return
    entry.refCount -= 1
    if (entry.refCount <= 0) {
      entries.delete(registration.key)
      membershipVersion.value += 1
    }
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

/**
 * view 遮蔽报告：开着且 shieldsView≠'none' 的成员及档位（几何求交/滞回归 main 侧 view 链，
 * 本模块只报「哪些开着的表面声称遮蔽 view、按哪一档、开态几何是多少」）。
 *
 * 响应式语义（useShieldsViewSync 触发面契约）：本函数内部读 membershipVersion（成员表
 * 增删可追踪）+ 逐条目 isOpen getter（各成员绑定的响应式状态本体可追踪）——在 Vue
 * 响应式作用域（watchEffect/computed）内调用时自动建立依赖；rect getter 的 DOM 实测
 * 不响应（几何在每次重算时直读 DOM，由调用方的重算触发面保证新鲜度）。
 */
export function openShieldingSurfaces(): Array<{
  id: ModalSurfaceId
  mode: 'unconditional' | 'intersecting'
  rect?: ModalSurfaceRect
}> {
  // 成员表版本号：读点消费 ⇒ 「挂载⇔开」型成员（卸载即注销）的开合翻转可追踪
  void membershipVersion.value
  const report: Array<{
    id: ModalSurfaceId
    mode: 'unconditional' | 'intersecting'
    rect?: ModalSurfaceRect
  }> = []
  for (const entry of entries.values()) {
    if (!entry.isOpen()) continue
    const mode = modalSurfaceFlags(entry.surface).shieldsView
    if (mode === 'none') continue
    const rect = entry.rect?.() ?? null
    report.push(rect !== null ? { id: entry.surface, mode, rect } : { id: entry.surface, mode })
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
  membershipVersion.value += 1
}
