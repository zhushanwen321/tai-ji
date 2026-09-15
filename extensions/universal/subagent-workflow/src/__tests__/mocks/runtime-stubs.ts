// src/__tests__/mocks/runtime-stubs.ts
//
// 共享测试桩（u-5a / 设计 §2.2 C6 / §4 A-V5）：壳测试里逐字重复的手写 mock
// 收敛到本 module——桩更新一处生效，消费方不再各自手写。
//
// 消费方式（vi.mock 提升约束）：vi.mock 工厂被提升到文件顶部，工厂体内禁止
// 引用普通顶层变量，引用本 module 一律经 async 工厂 + 动态 import：
//
//   vi.mock("@earendil-works/pi-ai", async () => {
//     const { piAiStringEnumStub } = await import("../../__tests__/mocks/runtime-stubs.ts");
//     return piAiStringEnumStub();
//   });
//
// 使用纪律（A-V5）：同文件同模块 vi.mock 只注册一次；禁止在测试文件内重新
// 手写以下桩——桩形变更改本 module，全量消费方同步生效。

// ── 桩 1：pi-ai StringEnum ──

export function piAiStringEnumStub(): {
  StringEnum: (values: string[]) => { type: "string"; enum: string[] };
} {
  return {
    StringEnum: (values: string[]) => ({ type: "string", enum: values }),
  };
}

// ── 桩 2：typebox Type ──
// 与包根 mocks/typebox.ts（vitest alias stub）形态不等价：alias 的 Record 丢弃
// key/value、Union 返回 items 字段名；本桩保留 additionalProperties/key/members
// （测试断言依赖手写桩形态）。消费方的 vi.mock 覆盖不可省——删掉即回落到
// alias stub 的弱形态。

export const typeboxStub = {
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    Optional: (schema: unknown) => ({ ...(schema as object), optional: true }),
    String: () => ({ type: "string" }),
    Boolean: () => ({ type: "boolean" }),
    Number: () => ({ type: "number" }),
    Array: (items: unknown) => ({ type: "array", items }),
    Record: (key: unknown, value: unknown) => ({ type: "object", additionalProperties: value, key }),
    Unknown: () => ({ type: "unknown" }),
    Union: (members: unknown[]) => ({ type: "union", members }),
    Literal: (value: unknown) => ({ type: "literal", value }),
  },
};
