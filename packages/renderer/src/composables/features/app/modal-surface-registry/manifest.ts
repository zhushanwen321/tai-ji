/**
 * 模态表面聚合登记表（§6.7 登记表 + z 基线对账锚）——「基线内每个表面在登记表有一行、
 * 新增表面不登记即测试红」的单一事实源。
 *
 * 两层结构：
 * - **家族旗标组**（MODAL_SURFACE_FAMILY_FLAGS）：§6.7 登记表每行的双键让位族（yieldsEsc /
 *   yieldsCmdW，R4 拆分）与 view 遮蔽族（shieldsView，§5.1 规则 6② 读同一旗标）；
 * - **表面条目**（MODAL_SURFACE_MANIFEST）：每个表面一行（§6.7 完备性判据），携带
 *   z 基线锚（file + 字面形态 + 字面量 + 出现次数）供 z-surface-baseline.test.ts 与
 *   全仓扫描**全等**对账；无 z≥1000 字面量的成员（FormOverlay 面板内覆盖 / SessionList
 *   删除确认态本体）zAnchors 为空数组。
 *
 * z 基线口径（§6.7 完备性判据）：全仓 z 值 ≥ 1000 的表面清单，三类字面形态都枚举——
 * ① class-token：`z-[var(--z-modal)]` 形（token 值按 packages/renderer/src/style.css 的
 *    `--z-*` 表解析，--z-modal:1000 / --z-dialog:1100 入基线，--z-overlay:20 不入）；
 * ② class-raw：裸数字 class 形（z-[1000] / z-[1100] / z-[9999] / z-[10000]）；
 * ③ inline-style：inline `zIndex:` 形（CompanionBand expanded 分支 var(--z-dialog)）；
 * ④ css-decl：样式表 `z-index:` 声明形（现存 0 处，防新增漏登记）。
 * 指针驱动瞬态面（HoverCard z-[90]）< 1000 结构性不入基线（§6.7 R4 carve-out 豁免双旗标）。
 *
 * kind 语义：'member' = 入聚合让位族（编排器/⌘W 守卫与 view 遮蔽读此表）；'excluded' =
 * 仅入 z 基线登记、**不入聚合**——浮层壳是容器不是模态（§6.7 末段：Esc 由编排器层级序管理，
 * view 可见性受浮层内容切换/错误态支配，见 §7.4）。
 *
 * 运行时开合态注册见 registry.ts（各表面挂载点 registerModalSurface）。本文件纯声明、
 * 零运行时状态，禁止在此写任何行为逻辑。
 */
import type { ModalSurfaceFlags } from '@taiji/core/domain/overlay'

// ── 家族旗标组（§6.7 登记表逐行，行序与设计表一致）──────────────────────────────

/** §6.7 登记表家族行（同家族多表面共用旗标组） */
export type ModalSurfaceFamily =
  /** 全屏阻塞模态族（token z 形）：SettingsModal / PluginModalHost / AsyncErrorFallback overlay 态 */
  | 'modal-token-z'
  /** 全屏阻塞模态族（裸数字 z 形）：SearchModal / DialogContent 确认框族（遮罩+面板） */
  | 'modal-dialog'
  /** CompanionBand expanded 待决确认（inline z 高于 modal，阻塞交互） */
  | 'companion-band'
  /** FormOverlay（插件表单 Panel 内覆盖，可能带未提交输入） */
  | 'form-overlay'
  /** 弹出层族（PopoverContent / SelectContent / SessionItemContextMenu / ProjectSwitcher） */
  | 'popover-layer'
  /** ToastContainer（非阻塞通知，不消费 Esc） */
  | 'toast'
  /** 可编程横幅（memory pressure bar，显示到 dismiss 或 level 变化） */
  | 'program-banner'
  /** 可编程横幅（RollingRestartBanner，滚动重启） */
  | 'rolling-banner'
  /** SessionList 删除确认态本体（§6.7 局部表面后行档入聚合，确认态聚合谓词开合） */
  | 'session-delete-confirm'
  /** 浮层壳（容器非模态，不入聚合——kind='excluded' 专用，旗标恒不参与） */
  | 'overlay-shell'

/**
 * 家族旗标组（§6.7 登记表「yieldsEsc / yields⌘W / shieldsView」三列）。
 * 命名注记：§6.7 原记 'yields⌘W'——⌘ 非 JS 标识符合法字符，字段名 ASCII 化 yieldsCmdW
 * （u-foundation 裁决，类型契约在 @taiji/core/domain/overlay）。
 */
export const MODAL_SURFACE_FAMILY_FLAGS: Record<ModalSurfaceFamily, ModalSurfaceFlags> = {
  // 全屏阻塞面（遮罩盖满视口）：双键均让位（有未提交输入/阻塞交互）、无条件遮蔽 view
  'modal-token-z': { yieldsEsc: true, yieldsCmdW: true, shieldsView: 'unconditional' },
  'modal-dialog': { yieldsEsc: true, yieldsCmdW: true, shieldsView: 'unconditional' },
  'companion-band': { yieldsEsc: true, yieldsCmdW: true, shieldsView: 'unconditional' },
  'form-overlay': { yieldsEsc: true, yieldsCmdW: true, shieldsView: 'unconditional' },
  // 弹出层族：Esc 让位（reka 自行 dismiss，视觉最外层有递进）；⌘W 不让位（R4 双键拆分——
  // 弹层瞬态、reka 不以 ⌘W dismiss，让位即死键）；锚定弹出层按几何相交遮蔽 view
  'popover-layer': { yieldsEsc: true, yieldsCmdW: false, shieldsView: 'intersecting' },
  // 非阻塞横幅/通知：不消费 Esc（显示期 Esc 照常走层级序），仅几何相交时遮蔽 view
  'toast': { yieldsEsc: false, yieldsCmdW: false, shieldsView: 'intersecting' },
  'program-banner': { yieldsEsc: false, yieldsCmdW: false, shieldsView: 'intersecting' },
  'rolling-banner': { yieldsEsc: false, yieldsCmdW: false, shieldsView: 'intersecting' },
  // 行内两段确认态（§6.7 局部表面后行档）：Esc 让位（escCount 消费方在编排器后注册，
  // preventDefault 不可达，只能靠让位达成「Esc 只清确认态不动容器」）；⌘W 不让位
  // （无未提交输入、行内瞬态，让位即死键）；行内小面积不覆盖 view 显示矩形（'none'）
  'session-delete-confirm': { yieldsEsc: true, yieldsCmdW: false, shieldsView: 'none' },
  'overlay-shell': { yieldsEsc: false, yieldsCmdW: false, shieldsView: 'none' },
}

// ── 表面条目（§6.7 完备性判据：每个表面一行）────────────────────────────────────

/** z 基线锚：登记表 ↔ 全仓扫描的对账键（多重集按 (file, form, literal) → count 全等） */
export interface ModalSurfaceZAnchor { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面 // oe-exempt:20261003:framework:聚合注册表契约——modal surface registry 数据契约，消费面为编排器与各表面单元
  /** 仓库根相对路径 */
  file: string
  /** z 字面形态（§6.7 三类字面形态 + CSS 声明形） */
  form: 'class-token' | 'class-raw' | 'inline-style' | 'css-decl'
  /** 字面量：token 名（'var(--z-modal)'）或裸数字（'1000'） */
  literal: string
  /** 同文件同字面量出现次数（AsyncErrorFallback overlay 态两分支同 class = 2） */
  count: number
}

export interface ModalSurfaceManifestEntry { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  /** 表面 id（运行时注册键，registry.ts 校验） */
  id: string
  /** §6.7 登记表家族行（旗标组由此取，注册方不得自带旗标） */
  family: ModalSurfaceFamily
  /** 'member' 入聚合；'excluded' 仅登记不入聚合 */
  kind: 'member' | 'excluded'
  /** z 基线锚（无 z≥1000 字面量 = 空数组） */
  zAnchors: readonly ModalSurfaceZAnchor[]
  /** §6.7 登记依据（人读） */
  basis: string
}

export const MODAL_SURFACE_MANIFEST = [
  {
    id: 'settings-modal',
    family: 'modal-token-z',
    kind: 'member',
    zAnchors: [
      { file: 'packages/renderer/src/components/settings/SettingsModal.vue', form: 'class-token', literal: 'var(--z-modal)', count: 1 },
    ],
    basis: '§6.7 表：全屏阻塞面；既有 window 级 Esc 兜底（defaultPrevented 先检后 preventDefault）',
  },
  {
    id: 'plugin-modal-host',
    family: 'modal-token-z',
    kind: 'member',
    zAnchors: [
      { file: 'packages/renderer/src/components/extension/PluginModalHost.vue', form: 'class-token', literal: 'var(--z-modal)', count: 1 },
    ],
    basis: '§6.7 表：全屏阻塞面（插件 modal 挂载面）',
  },
  {
    id: 'async-error-fallback-overlay',
    family: 'modal-token-z',
    kind: 'member',
    zAnchors: [
      { file: 'packages/renderer/src/components/ui/AsyncErrorFallback.vue', form: 'class-token', literal: 'var(--z-modal)', count: 2 },
    ],
    basis: '§6.7 表：AsyncErrorFallback overlay 态（两分支同 class 字面量，count=2）',
  },
  {
    id: 'search-modal',
    family: 'modal-dialog',
    kind: 'member',
    zAnchors: [
      { file: 'packages/ui/src/overlays/SearchModal.vue', form: 'class-raw', literal: '1000', count: 1 },
    ],
    basis: '§6.7 表：SearchModal（遮罩+面板全屏阻塞面）',
  },
  {
    id: 'dialog-confirm',
    family: 'modal-dialog',
    kind: 'member',
    zAnchors: [
      { file: 'packages/renderer/src/components/ui/dialog/DialogContent.vue', form: 'class-raw', literal: '1000', count: 2 },
      { file: 'packages/ui/src/primitives/dialog/DialogContent.vue', form: 'class-raw', literal: '1000', count: 2 },
    ],
    basis: '§6.7 表：DialogContent 确认框族（遮罩 + 面板各一 z 字面量；renderer/ui 双副本各 count=2）',
  },
  {
    id: 'companion-band',
    family: 'companion-band',
    kind: 'member',
    zAnchors: [
      { file: 'packages/ui/src/extension-host/CompanionBand.vue', form: 'inline-style', literal: 'var(--z-dialog)', count: 1 },
    ],
    basis: '§6.7 表：CompanionBand expanded 待决确认（inline zIndex: var(--z-dialog) 高于 modal）',
  },
  {
    id: 'form-overlay',
    family: 'form-overlay',
    kind: 'member',
    zAnchors: [],
    basis: '§6.7 表：FormOverlay（插件表单 Panel 内覆盖，无 z≥1000 字面量，可能带未提交输入）',
  },
  {
    id: 'popover-content',
    family: 'popover-layer',
    kind: 'member',
    zAnchors: [
      { file: 'packages/renderer/src/components/ui/popover/PopoverContent.vue', form: 'class-raw', literal: '1100', count: 1 },
      { file: 'packages/ui/src/primitives/popover/PopoverContent.vue', form: 'class-raw', literal: '1100', count: 1 },
    ],
    basis: '§6.7 表：弹出层族（reka DismissableLayer——Esc 让位、⌘W 不让位）',
  },
  {
    id: 'select-content',
    family: 'popover-layer',
    kind: 'member',
    zAnchors: [
      { file: 'packages/renderer/src/components/ui/select/SelectContent.vue', form: 'class-raw', literal: '1100', count: 1 },
      { file: 'packages/ui/src/primitives/select/SelectContent.vue', form: 'class-raw', literal: '1100', count: 1 },
    ],
    basis: '§6.7 表：弹出层族（Select 下拉）',
  },
  {
    id: 'session-item-context-menu',
    family: 'popover-layer',
    kind: 'member',
    zAnchors: [
      { file: 'packages/renderer/src/components/sidebar/session-item/SessionItemContextMenu.vue', form: 'class-raw', literal: '1100', count: 1 },
    ],
    basis: '§6.7 表：弹出层族（右键菜单）',
  },
  {
    id: 'project-switcher-menu',
    family: 'popover-layer',
    kind: 'member',
    zAnchors: [
      { file: 'packages/renderer/src/components/sidebar/ProjectSwitcher.vue', form: 'class-raw', literal: '1100', count: 1 },
    ],
    basis: '§6.7 表：弹出层族（项目切换菜单）',
  },
  {
    id: 'toast-container',
    family: 'toast',
    kind: 'member',
    zAnchors: [
      { file: 'packages/renderer/src/components/ui/ToastContainer.vue', form: 'class-raw', literal: '9999', count: 1 },
    ],
    basis: '§6.7 表：ToastContainer（非阻塞通知，不入让位族、只入 view 遮蔽族）',
  },
  {
    id: 'memory-pressure-bar',
    family: 'program-banner',
    kind: 'member',
    zAnchors: [
      { file: 'packages/renderer/src/App.vue', form: 'class-raw', literal: '9999', count: 1 },
    ],
    basis: '§6.7 表：memory pressure bar（可编程横幅，显示到 dismiss 或 level 变化）',
  },
  {
    id: 'rolling-restart-banner',
    family: 'rolling-banner',
    kind: 'member',
    zAnchors: [
      { file: 'packages/renderer/src/components/ui/RollingRestartBanner.vue', form: 'class-raw', literal: '10000', count: 1 },
    ],
    basis: '§6.7 表：RollingRestartBanner（可编程横幅，滚动重启）',
  },
  {
    id: 'overlay-shell',
    family: 'overlay-shell',
    kind: 'excluded',
    zAnchors: [
      { file: 'packages/renderer/src/components/panel/workflow-viz/overlay/OverlayShell.vue', form: 'class-token', literal: 'var(--z-modal)', count: 1 },
    ],
    basis: '§6.7 末段：浮层壳自身不入聚合——它是容器不是模态，Esc 由编排器层级序管理，view 可见性受浮层内容切换/错误态支配（§7.4）；z 锤点随 u-w2-shell 壳抽取落位 OverlayShell.vue（原 WorkflowVizOverlay.vue 同字面量随迁移清空）',
  },
  {
    id: 'session-delete-confirm',
    family: 'session-delete-confirm',
    kind: 'member',
    zAnchors: [],
    basis: '§6.7 局部表面后行档：SessionList 删除确认态本体（N 个 SessionItem 后代确认态 / folderConfirmingCwd 聚合谓词）入聚合让位；禁绑 escCount 广播计数器',
  },
] as const satisfies readonly ModalSurfaceManifestEntry[]

/** 表面 id 联合类型（登记表即词表——新增表面先在本表登记再写注册代码） */
export type ModalSurfaceId = (typeof MODAL_SURFACE_MANIFEST)[number]['id']

const MANIFEST_BY_ID = new Map<string, ModalSurfaceManifestEntry>(
  MODAL_SURFACE_MANIFEST.map((entry) => [entry.id, entry as ModalSurfaceManifestEntry]),
)

/** 按 id 取旗标组（运行时注册校验与编排器查询共用；未登记 id 抛错——新增表面必须先入登记表） */
export function modalSurfaceFlags(id: ModalSurfaceId): ModalSurfaceFlags {
  const entry = MANIFEST_BY_ID.get(id)
  if (!entry) throw new Error(`modal-surface-registry: 未登记的表面 id '${id}'——先在 manifest.ts 登记（§6.7 完备性判据）`)
  return MODAL_SURFACE_FAMILY_FLAGS[entry.family]
}

/** 按 id 取登记条目（z 基线对账与编排器诊断共用） */
export function modalSurfaceEntry(id: ModalSurfaceId): ModalSurfaceManifestEntry {
  const entry = MANIFEST_BY_ID.get(id)
  if (!entry) throw new Error(`modal-surface-registry: 未登记的表面 id '${id}'——先在 manifest.ts 登记（§6.7 完备性判据）`)
  return entry as ModalSurfaceManifestEntry
}

/** 登记表是否收录该 id（运行时注册用布尔形态，抛错语义由 modalSurfaceFlags/Entry 承担） */
export function isModalSurfaceId(id: string): id is ModalSurfaceId {
  return MANIFEST_BY_ID.has(id)
}
