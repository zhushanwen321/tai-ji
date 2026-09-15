import { defineConfig } from 'tsup'

// pi-rpc 双形态构建（形态对齐 subagent-engine-sdk / pi-subagent-cli：workspace 消费
// src、npm 消费 dist，npm 面经 package.json publishConfig 整体替换）。
//
// 单 entry：exports 面只有 "."（barrel index），无 SDK 式子路径 exports，故无需
// 逐模块具名登记——新增子路径 exports 面时此处同步补 entry。
//
// target node22：包 engines >=22.19.0（与 pi-subagent-cli 同源下限，原生
// type-stripping 时代的锚点），对齐 pi-subagent-cli tsup target。
//
// 无 noExternal：本包零生产依赖（dependencies 缺席，纯 Node 内建），全部产物自包含
// 于「无外部裸名 require」意义下；宿主 node_modules 解析面无对象。
export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  target: 'node22',
})
