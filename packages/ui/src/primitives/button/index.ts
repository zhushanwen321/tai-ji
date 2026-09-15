// buttonVariants 定义在 ./button-variants.ts（独立文件，防 Button.vue ↔ 本 barrel
// 自引用环）；此处 `export *` 保持原导出面，外部消费方（顶层 barrel / renderer
// re-export shim）import 路径不变。
export * from './button-variants'

export { default as Button } from './Button.vue'
