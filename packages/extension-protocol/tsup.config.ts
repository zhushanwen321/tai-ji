import { defineConfig } from 'tsup'

export default defineConfig({
  // index 桶出口（纯契约/纯算法）+ background-task 子出口（含 node 内建依赖的行为原语）
  entry: ['src/index.ts', 'src/background-task-entry.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: false,
  // 零运行时依赖，不需要 external
  external: [],
  // package.json "type": "module"（ext-simplify-13）：tsup esm 默认输出 dist/*.js + *.d.ts
  // （此前无 type 声明时 esm 产物为 *.mjs）——publishConfig 指针已同步为 .js/.d.ts
})
