/**
 * 模态表面聚合模块（display-containers §6.7 模态共存守卫 + §5.1 规则 6② view 遮蔽族）。
 *
 * - manifest.ts：登记表（家族旗标组 + 每表面一行 + z 基线锚）——新增表面先登记再接线；
 * - registry.ts：运行时开合态注册与编排器查询（yieldsEsc / yieldsCmdW / shieldsView 报告）；
 * - local-esc-consumers.ts：局部表面 Esc 消费方两档对照基线（先行档 preventDefault 约定 /
 *   后行档聚合让位）。
 */
export {
  MODAL_SURFACE_FAMILY_FLAGS,
  MODAL_SURFACE_MANIFEST,
  modalSurfaceEntry,
  modalSurfaceFlags,
  isModalSurfaceId,
  type ModalSurfaceFamily,
  type ModalSurfaceId,
  type ModalSurfaceManifestEntry,
  type ModalSurfaceZAnchor,
} from './manifest'
export {
  registerModalSurface,
  anyModalSurfaceYieldsEsc,
  anyModalSurfaceYieldsCmdW,
  openShieldingSurfaces,
  isModalSurfaceOpen,
  resetModalSurfaceRegistry,
  type ModalSurfaceRegistration,
} from './registry'
export { LOCAL_ESC_CONSUMERS, type LocalEscConsumerEntry } from './local-esc-consumers'
export type { ModalSurfaceFlags, ShieldsViewMode } from '@taiji/core/domain/overlay'
