/**
 * workflow-viz overlay 派生视图（容器扩展点统一 §6.8/§7.3 浮层行，U7）——
 * 浮层标签条分段与壳承载判定的注册表派生单点。
 *
 * 派生源 = core 容器位注册表的内置浮层转换器（builtinOverlayTypeViews(OVERLAY_REGISTRY)，
 * §6.1 内置项不经声明通道）：标签条三段的存在性与元数据（文案 key / 图标名 / 可打开性）
 * 从转换器产出读取，壳不再自持字面量表。runs 段（workflow kind）保留显式内置渲染分支
 * （§6.8「切标签不改内容 kind」不对称的保留面）：标签文案与标题/内容渲染不经本模块派生
 * （workflow 注册表条目的 labelKey 是浮层标题键而非 tab 标签键，条目语义 = 条目文本）。
 *
 * 插件内容（声明侧）不进标签条（§6.8：插件内容作为独立浮层内容显示，不进 workflow 壳的
 * 「同一会话三种视角」条）——构造性保证：声明侧不是 deriveOverlayTabSegments 的输入。
 */
import { builtinOverlayTypeViews } from '@taiji/core/extension-host'
import type { OverlayContentTypeView } from '@taiji/core/extension-host'
import { OVERLAY_REGISTRY } from '@taiji/core/domain/drawer'
import type { OverlayKind } from '@taiji/core/domain/overlay'
import type { OverlayTab } from './workflow-viz-overlay'

/** 内置浮层内容视图（OVERLAY_REGISTRY 序 = 派生序 = 标签条呈现序；注册表与转换器均纯数据，模块级求值安全）。 */
const BUILTIN_OVERLAY_VIEWS: readonly OverlayContentTypeView[] = builtinOverlayTypeViews(OVERLAY_REGISTRY)

/**
 * workflow 壳承载的内置内容 kind 判定：三类三视角（workflow/scheduler/canvas，§6.8）。
 * browser 由 BrowserOverlay 专属壳承载（display-containers §7.4，两壳互斥）——域归属
 * 决策（真差异），不属可派生数据；plugin 载体由 Host 的独立浮层内容位承载（§6.8）。
 */
function isWorkflowShellKind(kind: OverlayKind): boolean {
  return kind === 'workflow' || kind === 'scheduler' || kind === 'canvas'
}

/** 内容 kind → 标签条 tab 位（「切标签不改内容 kind」不对称的唯一映射点：workflow 内容的 tab 位名为 runs）。 */
const TAB_VALUE_BY_KIND: Partial<Record<OverlayKind, OverlayTab>> = {
  workflow: 'runs',
  scheduler: 'scheduler',
  canvas: 'canvas',
}

/** 标签条分段（注册表派生形状）：元数据来自内置内容视图，壳不自持字面量。 */
export interface OverlayTabSegment { // oe-exempt:20261025:framework:标签条分段数据契约（类型契约先行，非抽象接口单实现）
  /** tab 位（受控 tab 展示维度的取值；runs = workflow 内容三视角的主段） */
  value: OverlayTab
  /** 内容 kind（切 tab 不改的维度——§6.8 不对称保留面） */
  kind: OverlayKind
  /** 文案 i18n key（内置项恒走 key，§6.16④；runs 段壳侧显式覆盖——见模块头注释） */
  labelKey: string
  /** 图标名（kebab-case lucide 名；壳内白名单解析，§6.13 单一函数收敛归 U13） */
  icon: string
  /** 无数据时可进入（§6.15：workflow 段显式 false——既有「运行」禁用规则的数据驱动形态） */
  openableWithoutData: boolean
}

/**
 * 标签条分段派生（§7.3 浮层标签条行）：内置内容视图 → workflow 壳标签条段集。
 * browser（专属壳）排除；插件内容不进标签条（§6.8，声明侧非本函数输入）。
 * 段外 tab 值（未知 tab 位）零渲染——壳不做 v-else 兜底（§7.3）。
 */
export function deriveOverlayTabSegments(): OverlayTabSegment[] {
  const segments: OverlayTabSegment[] = []
  for (const view of BUILTIN_OVERLAY_VIEWS) {
    const value = TAB_VALUE_BY_KIND[view.kind]
    if (!isWorkflowShellKind(view.kind) || value === undefined) continue
    segments.push({
      value,
      kind: view.kind,
      labelKey: view.labelKey ?? '',
      icon: view.icon ?? '',
      openableWithoutData: view.openableWithoutData,
    })
  }
  return segments
}

/**
 * workflow 壳承载的内容 kind 集（Host「是否打开」判定的派生源，§7.3 浮层宿主行）：
 * 内置三类经注册表转换器产出（member 序 = OVERLAY_REGISTRY 序，集合语义无序）。
 */
export function deriveOverlayHostedKinds(): ReadonlySet<OverlayKind> {
  return new Set(BUILTIN_OVERLAY_VIEWS.filter((v) => isWorkflowShellKind(v.kind)).map((v) => v.kind))
}
