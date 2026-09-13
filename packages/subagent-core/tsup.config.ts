import { defineConfig } from 'tsup'

// D4（docs/architecture/subagent-core-package-extraction.md §3.3）：双形态构建——
// TS 源供 workspace 消费（main/exports 指向 src），dist 双格式供 npm 消费。
//
// 两档配置按运行时的 script 名分流（npm_lifecycle_event 由 pnpm/npm 跑 script
// 时注入当前 script 名）：`build` / 裸 `npx tsup` → 档 1（既有行为零变化）；
// `build:bundle` → 档 2（host-surface D2 的 vendoring 产物）。tsup CLI 无多档
// 选择参数，config 内分流是零额外文件的唯一入口；全量构建 = build && build:bundle。
const bundleOnly = process.env.npm_lifecycle_event === 'build:bundle'

// ── 档 1：双形态常规构建 ────────────────────────────────────────
// entry 用对象形态保形输出：dist/<key>.js|cjs|d.ts|d.cts 与 src/ 目录结构一一对应
// （src/ 前缀替换为 dist/），package.json exports 的语义子入口按同形路径映射
// （./execution/relay-env -> dist/execution/relay-env.cjs 等）。
// [W11/H3] 引擎子入口（./engines/zcode/{reader,constants}）已随内建引擎删除。
// 主入口 index 之外的三个 entry 恰好是 exports 的三个语义子入口（D5 公共面）：
// runtime 复用链（D8）与 zsw 复用链（D6）只允许经语义子入口消费这些模块，
// 语义子入口因此必须各自成为 bundle 入口——否则它们只存在于主入口 bundle 内部，
// 无法被独立加载（单一 bundle 不做 chunk 拆分，模块实例也会分裂成两份）。
const mainConfig = defineConfig({
  entry: {
    index: 'src/index.ts',
    'execution/relay-env': 'src/execution/relay-env.ts',
    'execution/engine/paths': 'src/execution/engine/paths.ts',
    // [W4] 引擎发现器语义子入口（runtime 冷启动回退链深路径消费：
    // session-records.ts → @zhushanwen/subagent-core/engine/engine-discovery-scan）
    'execution/engine/engine-discovery-scan': 'src/execution/engine/engine-discovery-scan.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  target: 'node20',
  // D4 关键点：zsw 宿主是 CJS（node>=20），而 @xyz-agent/extension-protocol 的
  // npm dist 仅 ESM（.mjs），node 20 下 require() 加载 ESM 不可靠——
  // 运行时面仅常量的 protocol 必须 bundle 进产物（noExternal），
  // 不让它以外部 ESM 依赖形态出现在 CJS require 链上。
  // （一致性审查 r2 注记：[W11] 现为 3 个 entry，闭包无 protocol 运行时引用——唯一 import
  // 点 engine-discovery.ts 仅 pi 壳深路径消费，dist 实测零常量命中；noExternal 为
  // 防御性边界，未来 entry 引入运行时引用时即生效 bundle。）
  // 降级路径（D4 既定）：bundle 边界出问题时改为全量 bundle 闭包内非 node 依赖。
  noExternal: ['@xyz-agent/extension-protocol'],
})

// ── 档 2：自包含 CJS bundle（host-surface D2） ──────────────────
// 产物 dist.bundle/index.cjs——给无 node_modules 解析面的宿主 vendoring（zsw：
// 插件目录整体复制，无依赖安装链，marketplace 副本/inline 加载双形态都要能直跑）。
// 与档 1 的本质差异：档 1 的 dist 仍把 ajv/yaml/proper-lockfile 留作外部依赖
// （宿主有正常 node_modules 解析面），档 2 noExternal 全部运行时依赖后单文件
// 自包含——vendored 消费只认文件不认解析链。仅 cjs（zsw 是纯 CJS 宿主），
// dts 刻意关闭：zsw 无 TS 消费面，类型由主包 dist 的 .d.cts 承载。
const bundleConfig = defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'dist.bundle',
  format: ['cjs'],
  dts: false,
  clean: true,
  sourcemap: false,
  target: 'node20',
  // 全部运行时依赖内联：@xyz-agent/* 用前缀正则（未来新增 workspace 运行时
  // 依赖自动跟随，不静默漏网）；ajv/yaml/proper-lockfile 逐名列出。node 内建
  // 模块（node: 前缀）不受 noExternal 影响，仍保持 external。
  // @zhushanwen/subagent-engine-sdk（W12：worktree git 出站卫生经其
  // buildOutboundChildEnv）是 @zhushanwen 域 workspace 依赖，前缀正则覆盖不到，
  // 逐名列入。
  noExternal: [/^@xyz-agent\//, '@zhushanwen/subagent-engine-sdk', 'ajv', 'yaml', 'proper-lockfile'],
})

export default bundleOnly ? bundleConfig : mainConfig
