import { defineConfig } from 'tsup'

// 引擎 SDK 双形态构建（形态对齐 subagent-core D4：workspace 消费 src、npm 消费 dist）。
//
// entry 逐模块具名登记（impl-plan §2.1 末行「SDK tsup entry 显式登记」，R2 S-Y2 / R3 S-A）：
//   protocol/（protocol/index 单 entry 覆盖目录闭包）+ 7 原语模块（schema-emulation /
//   nesting-guard / logger / kill-chain / journal-replay / data-dir / paths）+
//   ui-types.ts + env.ts + spawn.ts——W12 扩 env/spawn 实现时同守卫核对，后续新增模块
//   必须同步登记 entry。index 为主 barrel（供 exports "."；§2.1 清单外补登记）。
//
// 跨 entry 共享模块的形态说明：各原语 entry 闭包引用 protocol/* 与 logger（如
// kill-chain → contract-types / logger）。ESM 侧 splitting 抽共享 chunk，实例唯一；
// CJS 无 splitting，共享模块按 entry 内联复制——SDK 侧模块级状态全部无害化
// （facade 缓存只为引用稳定、warn-once 退化重复 warn、ajv 缓存 miss 重新编译；
// 跨实例语义性状态一律落 globalThis slot，见 src/logger.ts 与 src/data-dir.ts 注释）。
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'protocol/index': 'src/protocol/index.ts',
    'schema-emulation': 'src/schema-emulation.ts',
    'nesting-guard': 'src/nesting-guard.ts',
    logger: 'src/logger.ts',
    'kill-chain': 'src/kill-chain.ts',
    'journal-replay': 'src/journal-replay.ts',
    'data-dir': 'src/data-dir.ts',
    paths: 'src/paths.ts',
    'ui-types': 'src/ui-types.ts',
    'ui-channels': 'src/ui-channels.ts',
    env: 'src/env.ts',
    spawn: 'src/spawn.ts',
    'node-executor': 'src/node-executor.ts',
    'logs/stderr-rotation': 'src/logs/stderr-rotation.ts',
    'relay-env': 'src/relay-env.ts',
    'error-message': 'src/error-message.ts',
    'best-effort': 'src/best-effort.ts',
    'journal-io': 'src/journal-io.ts',
    'port-contract': 'src/port-contract.ts',
    'cli-entry': 'src/cli-entry.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  target: 'node20',
  // schema-emulation 的 ajv 必须 bundle 进产物（唯一运行时依赖）。
  noExternal: ['ajv'],
})
