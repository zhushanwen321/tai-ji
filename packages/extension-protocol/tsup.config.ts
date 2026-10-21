import { defineConfig } from 'tsup'

export default defineConfig({
  // index 桶出口（纯契约/纯算法）+ background-task 子出口（含 node 内建依赖的行为原语）
  entry: ['src/index.ts', 'src/background-task-entry.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: false,
  // 运行时依赖 @zhushanwen/state-machine（M4 起）由 tsup 默认按 package.json
  // dependencies external 化——dist 产物 import 外部包，npm 安装侧解析（发布位次
  // 登记见 src/extensions/plan/state-machine.ts 模块头，D7③）
  external: [],
  // package.json "type": "module"（ext-simplify-13）：tsup esm 默认输出 dist/*.js + *.d.ts
  // （此前无 type 声明时 esm 产物为 *.mjs）——publishConfig 指针已同步为 .js/.d.ts
})
