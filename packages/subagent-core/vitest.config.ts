import { taijiTestConfig } from "../../test-guard/factory.ts";

/**
 * Vitest config for @zhushanwen/subagent-core.
 *
 * 本包测试对 pi-ai / pi-tui / typebox 零运行时触点，无 alias、无 mocks/：
 * 消费方测试 format.test.ts / sdk-contract.test.ts 留在壳包（pi-subagent-workflow），
 * 壳包 vitest.config.ts 自带同款 alias；pi-coding-agent 仅剩 import type，
 * 转译擦除后无运行时解析，无需 alias。
 */
export default taijiTestConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // 对齐壳侧 F-R5：每个测试文件加载前净化四键 opt-in env（见 vitest.setup.ts），防宿主 shell export 假红。
    setupFiles: ["./vitest.setup.ts"],
  },
});
