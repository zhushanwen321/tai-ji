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
