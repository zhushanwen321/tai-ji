import { defineConfig } from 'tsup'

// 引擎 CLI 双形态构建（形态对齐 subagent-core D4 / subagent-engine-sdk：
// workspace 消费 src、npm 消费 dist，npm 面经 package.json publishConfig 整体替换）。
//
// entry 两个，恰好覆盖两个消费面：
//   - main：bin/pi-subagent-cli.mjs 的 dist 目标（npm 发布形态唯一真实入口——
//     本包仓内零生产 import，bin 是 manifest xyz-agent.subagentEngine.bin 的解析目标）；
//   - index：exports "." 的库面（npm publishConfig 指向 dist/index.*）。
// 两 entry 独立 bundle（ESM splitting 各自内联共享模块）——CLI 进程只加载 main、
// 库消费者只加载 index，无跨 entry 双载场景，模块复制无实例分裂风险
// （同 subagent-engine-sdk tsup.config.ts 的无害化论证）。
//
// target node22：包 engines >=22.19（bin 直跑 src 时代的下限即来自原生
// type-stripping），与打包链 bundle-extensions.mjs 引擎 bundle 的 target 一致。
//
// noExternal 只有 @zhushanwen/pi-rpc：SDK 经宿主 node_modules 解析到其发布 dist
// （版本单源），而 pi-rpc 尚无 npm 发布版本——external 化会让 npm 形态 404，故
// 内联进本包 dist（pi-rpc 是零依赖纯 TS 包，内联无实例分裂风险；pi-rpc 发布后
// 可切 external 对齐 SDK 做法）。
// 引擎 CLI 无 vendoring 宿主场景（zsw 用存在性发现非 vendoring），按 C-proc-11
// 自包含档（dist.bundle）仅 vendoring 需要时启用的约定不建该档。
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    main: 'src/main.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  target: 'node22',
  noExternal: ['@zhushanwen/pi-rpc'],
})
