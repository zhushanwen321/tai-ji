/**
 * 模态表面注册桥（display-containers §6.7 模态表面聚合的 ui 包接入面）。
 *
 * 层级方向：模态表面注册表（modal-surface-registry）实装在 renderer（@/composables/
 * features/app/modal-surface-registry），@taiji/ui 是更底层的设计系统包、不能反向依赖
 * renderer——本桥以 provide/inject 反转依赖：**renderer 在应用根（App.vue）provide 注册
 * 函数，ui 包内表面宿主（SearchModal / CompanionBand / primitives 弹层族）inject 后自注册**。
 * 未 provide（ui 包单测 / 独立消费）时注入为 null，注册静默跳过——ui 组件在任何宿主下
 * 可用性不变。
 *
 * 为什么自注册而非消费方注册：登记表契约是「表面挂载点自报开合态」（§6.7 完备性判据——
 * 新增表面不注册即编排器让位盲区），开合态本体（props.open / expanded 状态 / reka root
 * context）只有表面组件自己持有；放消费方则每个未来消费点都要记得补注册，漂移面不可控。
 *
 * surface id 用 string（词表归 renderer manifest SSOT；未登记 id 由 renderer 侧注册函数
 * 抛错拒绝——本包不复制词表防双权威）。
 */
import { inject } from 'vue'
import type { InjectionKey } from 'vue'

/** 表面几何矩形（视口坐标 CSS px，getBoundingClientRect 同空间） */
export interface UiSurfaceRect { // oe-exempt:20261003:framework:聚合/view 联动契约层——payload 与 ui 桥数据契约，消费面为本批 D1/D2 单元
  x: number
  y: number
  width: number
  height: number
}

/** 注册入参（renderer 侧 ModalSurfaceRegistration 的结构镜像；rect 语义同源） */
export interface UiModalSurfaceRegistration { // oe-exempt:20261003:framework:聚合/view 联动契约层——payload 与 ui 桥数据契约，消费面为本批 D1/D2 单元
  /** 登记表内的表面 id（词表归 renderer manifest；未登记 id 注册时抛错） */
  surface: string
  /** 实例级去重键（同 key 重复注册走 refCount；同表面多实例各用独立 key） */
  key: string
  /** 开合态读点（动作时刻直读，禁缓存） */
  isOpen: () => boolean
  /** 开态几何读点（view 遮蔽族 'intersecting' 成员上报用）；缺省/返回 null = 不带 rect */
  rect?: () => UiSurfaceRect | null
}

/** 注册函数形态：返回注销函数（幂等）；未装配注册桥时 renderer 侧不会调用本类型 */
export type ModalSurfaceRegistrar = (registration: UiModalSurfaceRegistration) => () => void

/** ui 包表面宿主 inject 的注册桥键（renderer App.vue provide 实函数） */
export const MODAL_SURFACE_REGISTRAR_KEY: InjectionKey<ModalSurfaceRegistrar> = Symbol(
  'taiji:modal-surface-registrar',
)

/**
 * ui 包表面宿主的自注册辅助：inject 注册桥并立即注册，返回注销函数（未装配桥时返回
 * no-op——ui 单测 / 非 taiji 宿主下零副作用）。必须在组件 setup 顶层调用（inject 时序）。
 */
export function registerUiModalSurface(registration: UiModalSurfaceRegistration): () => void {
  const registrar = inject(MODAL_SURFACE_REGISTRAR_KEY, null)
  if (!registrar) return () => {}
  return registrar(registration)
}
