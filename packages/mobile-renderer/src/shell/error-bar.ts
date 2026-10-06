// error-bar —— 移动壳全局错误条状态单例（remote-use A7/U14）。
//
// 单槽覆盖式文本槽（null = 不渲染）+ 手动关闭（无自动消失 timer——时间平抑类逻辑红线）。
// 状态独立成模块的原因：两条注入链共用同一出口，状态居任一注入方都会制造壳内循环依赖——
// - companion-bridge 三链：onSessionError（markSessionError 流内持久反馈 + 置顶瞬态补充）/
//   onGlobalError（直显）/ notifyNotDelivered（dialog 作答未送达内联错误行）；
// - app-runtime core toast 通道：UseChatDeps/EnsureStreamSubDeps 的 { error, warning } 注入
//   （core 失败面——revoke/stop/bash/compact 等 RPC 失败的翻译后文案——直入本槽；
//   error/warning 同槽，移动壳无分级 toast 组件，可见性优先）。
// views/ErrorBar.vue 纯展示消费（依赖方向 views → shell）；挂载与 effects 注入在 bootstrap/App。
import { ref } from 'vue'

/**
 * 当前错误条文本（null = 不渲染；ErrorBar 消费）。
 * taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：错误条单槽文本（§4 ⑧ 2026-10-04 批登记）
 */
export const errorBarMessage = ref<string | null>(null)

/** 写入错误条（core toast 通道与 companion-bridge 错误回调共用的单点出口） */
export function showErrorBar(text: string): void {
  errorBarMessage.value = text
}

/** 关闭错误条（ErrorBar 关闭钮消费） */
export function dismissErrorBar(): void {
  errorBarMessage.value = null
}

/** 测试后门：清空单槽文本（模块级 ref 跨用例隔离；companion-bridge 测试隔离出口委托此实现） */
export function resetErrorBarForTest(): void {
  errorBarMessage.value = null
}
