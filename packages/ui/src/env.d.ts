/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue"
  const component: DefineComponent<object, object, unknown>
  export default component
}

// vite `?raw` 后缀导入（组件测试读 .vue 源码文本做类名断言）。
// 必须放 .d.ts：.ts 文件里的 declare module 会被当作 module augmentation，
// 触发 TS2666（augmentation 内不允许 export）。
declare module "*.vue?raw" {
  const content: string
  export default content
}

/**
 * markdown-it-katex@2.0.3 无 TypeScript 类型（CJS 老包，仅注册 math_inline/math_block
 * 解析 + renderer 规则）。此处声明默认导出为 markdown-it 插件，渲染链 markdown.ts 自行
 * 覆盖（调 katex.renderToString）以控制 displayMode 与错误降级。
 * （随渲染链下沉自 renderer env.d.ts 迁入，remote-use-mobile D10。）
 */
declare module 'markdown-it-katex' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginSimple
  export default plugin
}
