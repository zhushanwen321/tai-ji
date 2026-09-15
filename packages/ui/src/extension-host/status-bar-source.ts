/**
 * status-bar-source.ts —— StatusBar 组件的数据源注入接口（W3 · T1，C1 契约）。
 *
 * 对齐 S2 plan IF8（StatusBarController）签名：getItems(scope, sessionId) 两 scope 重载。
 * S2 的 StatusBarController 类尚未交付（S2 W4 headless-consumers），本接口即 ui 侧消费契约：
 * 壳（P5）在 S2 落地后把真 controller 适配注入（S4 TC4『props/inject 接 core 状态，
 * 不直接 import core 内部实现』），单测注入 mock 实现。类型本地定义（不 import core——
 * core exports 无 ./extension-host 子路径，W1 clarify Q3 先例）。
 *
 * StatusBarEntry 形状对齐 core DM3（core/src/extension-host/types.ts 同形状）：
 * id/pluginId/text/tooltip?/alignment('left'|'right')/priority/commandId?。
 * S2 落地后若 core 字段演进，由壳适配层对齐（design-review R1）。
 */
import type { InjectionKey } from 'vue'

/** 状态点五色（spec §2 A4：ok=success / warn / danger / neutral=neutral-ico / plugin-src=accent）。 */
export type StatusDot = 'ok' | 'warn' | 'danger' | 'neutral' | 'plugin-src'

/** 状态栏条目（对齐 core DM3 StatusBarEntry + A4 状态点扩展）。 */
export interface StatusBarEntry {
  id: string
  pluginId: string
  text: string
  tooltip?: string
  alignment: 'left' | 'right'
  priority: number
  commandId?: string
  /** A4 状态点（spec §2 A4 五色）。可选——旧数据源不带则不渲染圆点。 */
  status?: StatusDot
}

/** StatusBar 数据源（对齐 S2 IF8 StatusBarController 消费面）。 */
export interface StatusBarSource {
  getItems(scope: 'per-session', sessionId: string): StatusBarEntry[]
  getItems(scope: 'global'): StatusBarEntry[]
}

/** provide/inject key——壳 provide，组件 inject，单测 global.provide mock。 */
export const STATUS_BAR_SOURCE_KEY: InjectionKey<StatusBarSource> = Symbol('status-bar-source')
