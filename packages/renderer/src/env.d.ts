/// <reference types="vite/client" />

/** vite define 注入的 taiji 版本号（renderer/vite.config.ts，来自 package.json）。 */
declare const __APP_VERSION__: string

declare module "*.vue" {
  import type { DefineComponent } from "vue"
  const component: DefineComponent<object, object, unknown>
  export default component
}

/**
 * markdown-it-katex@2.0.3 无 TypeScript 类型（CJS 老包，仅注册 math_inline/math_block
 * 解析 + renderer 规则）。此处声明默认导出为 markdown-it 插件，renderer 由 markdown.ts 自行
 * 覆盖（调 katex.renderToString）以控制 displayMode 与错误降级。
 */
declare module 'markdown-it-katex' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginSimple
  export default plugin
}
