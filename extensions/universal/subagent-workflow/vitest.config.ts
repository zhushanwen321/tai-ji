import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for @zhushanwen/pi-subagent-workflow.
 *
 * External Pi SDK packages are aliased to inline mocks or shared type stubs
 * so that vitest's module resolution succeeds without the real packages installed.
 */
export default defineConfig({
  test: {
    reporters: ["default", "junit"],
    outputFile: { junit: "./test-results/vitest-junit.xml" },
    include: ["src/**/__tests__/**/*.test.ts"],
    // [F-R5] 每个测试文件加载前统一删三个 watchdog env（watchdog 预算语义默认关），
    // 根治宿主 shell export 导致的假红；用例内 vi.stubEnv 仍照常叠加生效。
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    // 数组形态按序匹配、先命中先用（vite 文档）。顺序约束：
    // ① 字符串条目（精确前缀）必须先于正则条目——尤其 testing alias，若被
    //    深路径正则先截获，`testing/` 段会被当物理路径拼进 core src 导致解析失败；
    // ② 深路径正则殿后，只兜测试残留的 `.ts` 深路径 specifier。
    alias: [
      { find: "@earendil-works/pi-coding-agent", replacement: path.resolve(__dirname, "mocks/pi-coding-agent.ts") },
      { find: "@earendil-works/pi-ai", replacement: path.resolve(__dirname, "mocks/pi-ai.ts") },
      { find: "@earendil-works/pi-tui", replacement: path.resolve(__dirname, "mocks/pi-tui.ts") },
      { find: "typebox", replacement: path.resolve(__dirname, "mocks/typebox.ts") },
      { find: "@zhushanwen/pi-structured-output", replacement: path.resolve(__dirname, "../structured-output/src/index.ts") },
      // [B-2/D3] 壳测试引 core `__tests__` helpers 走此 alias（绝对路径前缀重写，
      // 不经 package.json exports，删 `./*` 通配后仍可用；helpers 物理零移动——
      // 保持在 core src/<域>/__tests__/ 就位，闭包守卫豁免面不变）。
      { find: "@zhushanwen/subagent-core/testing", replacement: path.resolve(__dirname, "../../../packages/subagent-core/src") },
      // [B-2/D3 主 agent 裁决 2026-09-03] 测试残留深路径旁路（长期方案）：
      // 62 个仅测试消费符号按 D3 标准不进 barrel、百余处测试深路径（from/vi.mock/
      // 动态 import 三形态，精确数以 rg 实测为准）不改写，统一经
      // 此正则重写到 core src 物理路径——不依赖 package exports 的 `./*` 通配，
      // u-2c 删通配后测试解析不受影响。vi.mock / 动态 import 的 specifier 同走
      // vite 解析命中本条（解析后同一物理模块 ID，mock 语义不变）。
      // 仅命中带 .ts 后缀的深路径；barrel（`@zhushanwen/subagent-core` 无路径段）、
      // 子入口（`relay-env` 等无 .ts 后缀）、testing/（上方字符串条目先行）均不命中。
      {
        find: /^@zhushanwen\/subagent-core\/(.+\.ts)$/,
        replacement: `${path.resolve(__dirname, "../../../packages/subagent-core/src")}/$1`,
      },
    ],
  },
});
