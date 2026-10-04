// mobile-renderer 入口：样式装配 + bootstrap 编排。
// core/ui 依赖与平台注入由 bootstrap.ts 内部真实 import 承载（依赖边由 package.json
// workspace 声明 + bootstrap import 图护住，ac1-dependency-edge.test.ts 断言 package.json 面）。
import './styles/tokens.css'

// 浮层进出场过渡（dialog 居中依赖 translate(-50%,-50%)，缺失时弹窗出视口）。
// styles/shell.css 是桌面 style.css 同段的 mobile 镜像副本，改动须同步两处。
import './styles/shell.css'

import { bootstrap } from './bootstrap'

// 全局错误留痕（error-reporter 双面）：Vue 体系内 render/setup 错误在无 app 级
// errorHandler 时会 rethrow，落 window error（同步路径）或 unhandledrejection
// （调度器 promise 路径）；此处兜住两面写 console.error，防渲染单点错误零现场。
// 上报通道不需要（远程壳无 IPC 落盘面）。
window.addEventListener('error', (e: ErrorEvent) => {
  // 资源加载错误事件无 error 对象与 message，非 JS 错误，跳过
  if (!e.error && !e.message) return
  console.error('[mobile-shell] uncaught error:', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  console.error('[mobile-shell] unhandled rejection:', e.reason)
})

// 启动壳编排（platform 注入 → 壳层端口注入/连接编排 → 挂载 App）。
// 任一环 reject（initConnection 抛错路径等）时 Vue app 可能尚未挂载，静态 HTML
// #app 为空 = 白屏。catch 落最小兜底呈现 + console.error 留现场，不让失败静默。
bootstrap().catch((err: unknown) => {
  console.error('[mobile-shell] bootstrap failed:', err)
  renderFatalError(err)
})

// bootstrap 失败的极简兜底呈现：裸 HTML + 内联样式（此刻 Vue app 未挂载，组件体系
// 不可用）；颜色取 tokens 变量并带字面量回退——tokens.css 已随本模块 import 加载时
// 走设计系统色，异常环境下回退值仍保证可读。
function renderFatalError(err: unknown): void {
  const container = document.getElementById('app')
  if (!container) return
  const detail = err instanceof Error ? err.message : String(err)
  container.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg, #131316);">
      <div style="max-width:420px;text-align:center;">
        <p style="margin:0 0 8px;font-size:16px;color:var(--neutral-fg, #dedee2);">应用启动失败</p>
        <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:var(--neutral-mid, #96969c);">请刷新页面重试；若反复出现，请联系服务提供者检查服务状态。</p>
        <p style="margin:0;font-size:12px;line-height:1.6;color:var(--neutral-faint, #74747a);word-break:break-all;">${escapeHtml(detail)}</p>
      </div>
    </div>`
}

/** 错误详情文本 HTML 转义（消息内可能含尖括号等字符，直插会注入标记）。 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
