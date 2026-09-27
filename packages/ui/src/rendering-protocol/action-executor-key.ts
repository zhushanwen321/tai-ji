/**
 * action-bar 执行器注入 key —— rendering-protocol 交互原语与宿主壳层的注入契约
 * （设计 AP-3：GuiComponent 协议首个交互原语）。
 *
 * action-bar 的点击统一走宿主命令链（commandRegistry.execute → WS
 * plugin.executeCommand，设计 §3.3 D2——只复用既有命令链，不新增回调通道）。
 * commandRegistry 权威在 core，由壳层 provide 真实实现（对齐 PRIMITIVE_RENDER_KEY /
 * VIEW_HOST_SOURCE_KEY 既有注入范式）；@taiji/ui 只定义此最小结构接口，core/renderer
 * 侧实现结构兼容即可——本文件不 import core 类型，避免 ui→core 反向依赖
 * （设计 §5.2 检查点 3 裁决）。
 */
import type { InjectionKey } from 'vue'

/** 操作参数——与 GuiComponentProps['action-bar'] items[].args 同形（只许标量，防注入结构化 payload） */
export type ActionArgs = Record<string, string | number | boolean>

/** 最小结构接口：壳层命令执行器的兼容面（core commandRegistry.execute 结构兼容此形状） */
export interface ActionExecutor {
  execute(id: string, args?: ActionArgs): void
}

export const ACTION_EXECUTOR_KEY: InjectionKey<ActionExecutor> = Symbol('action-executor')
