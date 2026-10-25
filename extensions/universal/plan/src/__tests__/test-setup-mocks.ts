/**
 * plan 工具测试共享 mock 布景（typebox / pi-ai / execution-notice / exec-skills / widget）。
 *
 * node:fs 不在本模块：其布景形态按测试语义三选一（全桩 / 部分透传 / 不 mock），见
 * test-setup-fs-mock.ts 头注，需要全桩形态的文件另 import 该模块。
 *
 * 执行顺序约束：vi.mock 在本模块求值时注册（helper 内调用不做 hoist 提升），必须
 * 先于被 mock 模块的加载——消费文件把对本模块的 import 放在 import 区首行，
 * ESM 按序求值保证注册先行。
 */
import { vi } from "vitest";

// Mock typebox（plan 工具 schema 构建依赖——单测断言走结构化桩形态）
vi.mock("typebox", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    String: (opts?: Record<string, unknown>) => ({ type: "string", ...opts }),
    Optional: (schema: unknown) => schema,
    Array: (item: unknown, opts?: Record<string, unknown>) => ({ type: "array", items: item, ...opts }),
  },
  Static: class {},
}));

vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[]) => ({ type: "string", enum: [...values] }),
}));

// Mock execution-notice（statically imported since 06-u1）：handlePlanComplete 打桩，
// GOAL_FAILURE_RECOVERY 与真实实现同文案——failure 断言在 completeResultText 里消费它
// （enter.test.ts 的空对象形态是其本地特例，不入本 helper）
vi.mock("../execution-notice.js", async () => {
  const { GOAL_FAILURE_RECOVERY } = await vi.importActual<typeof import("../execution-notice.js")>("../execution-notice.js");
  return {
    handlePlanComplete: vi.fn(),
    GOAL_FAILURE_RECOVERY,
  };
});

// Mock 执行方式检测（D10）：单测不扫真实目录。importActual 展开：只覆写
// detectExecSkills，其余导出（含 enter.ts re-export 的 resolveSkills 执行门禁）走
// 真实现——mock 罩全模块会把它一并变 undefined
vi.mock("@zhushanwen/pi-exec-skills", async () => {
  const actual = await vi.importActual<typeof import("@zhushanwen/pi-exec-skills")>(
    "@zhushanwen/pi-exec-skills",
  );
  return { ...actual, detectExecSkills: vi.fn(() => []) };
});

// Mock widget（plan 工具链路 imported by abort / enter——单测不触真实 TUI 渲染）
vi.mock("../widget.js", () => ({
  updatePlanWidget: vi.fn(),
}));
