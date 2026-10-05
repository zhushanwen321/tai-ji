/// <reference types="vite/client" />

/**
 * markdown-it-katex@2.0.3 无 TypeScript 类型（CJS 老包）。移动壳 vue-tsc 编译
 * ui 渲染链（@taiji/ui/features/chat/markdown 源码级依赖）时需要本声明——
 * 声明内容与 ui 包 env.d.ts 同款（ui 的 env.d.ts 不在 mobile tsconfig include 内）。
 */
declare module 'markdown-it-katex' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginSimple
  export default plugin
}
