// src/__tests__/schema-arming.test.ts
//
// [D3 止血版] 武装断言单测（纯函数面，无子进程）：assertSchemaEnforcementArmed 的
// 断言集 ①env 注入 / ②扩展在场 + capability 分流（native 生效 / emulated 豁免）+
// 双形态恢复指引文案。接线面（runSpawnOnce spawn 前 fail-fast / 零 spawn / 断言②
// 消费 extensionPaths 派生 argv）见 run-spawn-once.integration.test.ts。

import { describe, expect, it } from "vitest";

import { SCHEMA_ENV_VAR } from "../constants.ts";
import { assertSchemaEnforcementArmed, type SchemaArmingInput } from "../spawn-runner.ts";

const SCHEMA = { type: "object", properties: { answer: { type: "number" } } } as const;

const STRUCTURED_OUTPUT_DIR = "/x/node_modules/@zhushanwen/pi-structured-output";
const STRUCTURED_OUTPUT_ENTRY = "/x/node_modules/@zhushanwen/pi-structured-output/index.js";

/** 全武装基线：native + schema + env 已派生 + --extension 含 structured-output。 */
function armedInput(overrides: Partial<SchemaArmingInput> = {}): SchemaArmingInput {
  return {
    schemaEnforcement: "native",
    schema: SCHEMA,
    childEnv: { [SCHEMA_ENV_VAR]: JSON.stringify(SCHEMA) },
    spawnArgs: ["--extension", STRUCTURED_OUTPUT_DIR, "--no-extensions"],
    ...overrides,
  };
}

function messageOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err.message;
    throw err;
  }
  throw new Error("expected fn to throw, but it resolved");
}

describe("assertSchemaEnforcementArmed — [D3 止血版] 武装断言", () => {
  it("断言①：native + schema 任务 + PI_WORKFLOW_SCHEMA 未派生进 env → 抛引擎侧派生漂移错误", () => {
    const msg = messageOf(() =>
      assertSchemaEnforcementArmed(
        armedInput({ childEnv: {}, spawnArgs: ["--extension", STRUCTURED_OUTPUT_DIR] }),
      ),
    );
    expect(msg).toContain("[schema-arming]");
    expect(msg).toContain(SCHEMA_ENV_VAR);
    // 引擎侧归因（非宿主配置错误）+ 可操作恢复动作
    expect(msg).toContain("engine-side derivation drift");
    expect(msg).toContain("Recovery:");
  });

  it("断言②（验收 a）：native + schema 任务 + 扩展缺席 → 错误文本含双形态恢复指引", () => {
    const msg = messageOf(() =>
      assertSchemaEnforcementArmed(armedInput({ spawnArgs: ["--no-extensions"] })),
    );
    // taiji 宿主形态 → extension-service 诊断
    expect(msg).toContain("extension-service");
    // 独立形态 → 安装 peerDependency 或改用无 schema workflow（D2 行为变更声明文案）
    expect(msg).toContain("install @zhushanwen/pi-structured-output (peerDependency)");
    expect(msg).toContain("schema-less workflow");
    expect(msg).toContain("[schema-arming]");
  });

  it("断言②：--extension 为目录形态与入口文件形态都命中（不抛）", () => {
    expect(() =>
      assertSchemaEnforcementArmed(armedInput({ spawnArgs: ["--extension", STRUCTURED_OUTPUT_ENTRY] })),
    ).not.toThrow();
  });

  it("断言②：路径段前缀相似（pi-structured-output-lookalike）不误判为在场", () => {
    expect(() =>
      assertSchemaEnforcementArmed(
        armedInput({ spawnArgs: ["--extension", "/x/@zhushanwen/pi-structured-output-lookalike"] }),
      ),
    ).toThrow(/\[schema-arming\]/);
  });

  it("断言②：dev 源码布局（extensions/universal/structured-output，目录与入口文件形态）命中", () => {
    // L4 A1 根因回归锁：dev 下 taiji 宿主注入的 ctx.extensionPaths 是源码目录
    // （无 @zhushanwen scope 段）——断言②须同判据识别 dev 布局别名段。
    expect(() =>
      assertSchemaEnforcementArmed(
        armedInput({ spawnArgs: ["--extension", "/repo/extensions/universal/structured-output"] }),
      ),
    ).not.toThrow();
    expect(() =>
      assertSchemaEnforcementArmed(
        armedInput({
          spawnArgs: [
            "--extension", "/repo/extensions/universal/subagent-workflow",
            "--extension", "/repo/extensions/universal/structured-output/index.js",
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("断言②：dev 布局尾段同名前缀目录不误判为在场（两段连续匹配防误伤）", () => {
    expect(() =>
      assertSchemaEnforcementArmed(
        armedInput({ spawnArgs: ["--extension", "/repo/extensions/universal/structured-output-lookalike"] }),
      ),
    ).toThrow(/\[schema-arming\]/);
  });

  it("全武装（env + 扩展在场）→ 不抛", () => {
    expect(() => assertSchemaEnforcementArmed(armedInput())).not.toThrow();
  });

  it("capability 分流（验收 b）：emulated 引擎（zcode mock capabilities）豁免——schema 任务全缺席不触发断言", () => {
    expect(() =>
      assertSchemaEnforcementArmed(
        armedInput({ schemaEnforcement: "emulated", childEnv: {}, spawnArgs: [] }),
      ),
    ).not.toThrow();
  });

  it("无 schema 任务（声明缺省）→ 无武装面，不触发断言", () => {
    expect(() =>
      assertSchemaEnforcementArmed(armedInput({ schema: undefined, childEnv: {}, spawnArgs: [] })),
    ).not.toThrow();
  });
});
