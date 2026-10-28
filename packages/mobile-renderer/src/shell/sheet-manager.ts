// sheet-manager.ts —— 壳级 Sheet 单例互斥状态（remote-use-mobile-v2 §6.13，B 级决策）。
//
// 拥有面：全壳唯一活动 Sheet 槽位 activeSheet。任何时刻至多一个 Sheet 打开（spec §4.3
// 浮层互斥）；打开新的即替换旧的（「先关旧的」= 单槽覆盖语义，无需显式两步）。
//
// Sheet 组件挂载（v-model 语义收敛到 manager）：消费方按 activeSheet 值条件挂载对应
// Sheet 组件，关闭 = closeSheet()（Sheet 内部关闭动作经此出口，不各自持 open ref——
// 散落的独立 open 状态正是 §6.13 不采用段否决的形态）。
//
// W3 并行单元接线锚（契约，u-shell-skeleton 立契）：
//   - u-sheets 六 Sheet（form/permission/model/command/newTask/subagent 两级）挂载与
//     closeSheet 接线按本契约消费，不改本模块状态语义
//   - u-sessions sessionActions 长按动作 Sheet 同上
//   - Sheet 生命周期联动（§7.1：路由离开 chat / activeSessionId 变化 / 会话删除时关闭
//     活动 Sheet）= 消费方在各自事件点调 closeSheet()，本模块不反向 watch（依赖方向：
//     manager 是被消费的槽位，不感知业务事件源）
//
// subagent 两级（subagentList/subagentDetail）：列表态/详情态是同 key 内部推进的呈现细节
// （§6.13 采用段），槽位上仍占一个名字——两级互推由 SubagentSheet 内部状态承载，不占两槽。

import { ref, type Ref } from 'vue'

/** 壳级 Sheet 名词表（§6.13 采用段的封闭清单；新增 Sheet 先扩此表再挂组件） */
export type SheetName =
  | 'newTask'
  | 'sessionActions'
  | 'form'
  | 'permission'
  | 'model'
  | 'command'
  | 'subagentList'
  | 'subagentDetail'

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：唯一活动 Sheet 槽位（null = 全关）
export const activeSheet: Ref<SheetName | null> = ref(null)

/**
 * 打开 Sheet（单例互斥唯一入口）：打开新的即关旧的（单槽覆盖）。同名词重复打开 = 幂等
 * （不重放、不翻转）——调用方无需先判当前槽位。
 */
export function openSheet(name: SheetName): void {
  activeSheet.value = name
}

/** 关闭当前活动 Sheet（幂等：null 态调用 no-op）。 */
export function closeSheet(): void {
  activeSheet.value = null
}

/** 测试复位（生产代码禁止消费）：槽位归零——模块级单例 ref 跨测试泄漏消除。 */export function resetSheetManagerForTesting(): void {
  activeSheet.value = null
}
