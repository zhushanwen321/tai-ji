// model-prompt.test.ts —— [U7] 引擎模型段注入的开关语义（defaultEngine）与段格式；
// [engine-awareness U2] 恒在状态段三形态（zcode/pi/ghost）+ 清单段双降级文案
// （未实现/null → 与主体系一致声明；空清单/异常 → 无凭据提示行）+ 渲染确定性（D7）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EnginePort } from "../port.ts";
import { clearEngines, registerEngine } from "../registry.ts";
import { buildEngineModelsPromptAppend, buildSubagentEngineSection } from "../model-prompt.ts";

/** 最小 fake 引擎：仅 id + 可选 listModels（其余面 run/read 走不到，测试只触碰注入链）。 */
function fakeEngine(id: string, models: Array<{ id: string; name?: string }> | null): EnginePort {
  return {
    id,
    capabilities: () => ({
      schemaEnforcement: "emulated",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "coarse",
      sandbox: "none",
      sessionRead: "outcome-only",
      resume: "unsupported",
      interrupt: "kill-only",
      permissionMode: "ignored",
      maxTurns: false,
    }),
    probe: async () => ({ ok: true, engineVersion: "test", checks: [] }),
    run: async () => {
      throw new Error("not used in this test");
    },
    read: async () => ({ engineId: id, turns: [], source: "outcome-only" }),
    ...(models !== null ? { listModels: () => models } : {}),
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-prompt-"));
  clearEngines();
});

afterEach(() => {
  clearEngines();
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("buildEngineModelsPromptAppend（defaultEngine 开关语义）", () => {
  it("defaultEngine 缺省 / 'pi' → 不注入（pi 段由核心提供）", () => {
    registerEngine("zcode", () => fakeEngine("zcode", [{ id: "p/m1" }]));
    expect(buildEngineModelsPromptAppend(undefined)).toBe("");
    expect(buildEngineModelsPromptAppend("pi")).toBe("");
    expect(buildEngineModelsPromptAppend("  ")).toBe("");
  });

  it("defaultEngine=zcode 且引擎实现 listModels → 注入段（含分界说明与模型 id）", () => {
    registerEngine("zcode", () =>
      fakeEngine("zcode", [
        { id: "builtin:bigmodel-coding-plan/GLM-5.3", name: "Z.ai - Coding Plan · GLM-5.3" },
        { id: "e512/mimo-v2.5-pro" },
      ]),
    );
    const append = buildEngineModelsPromptAppend("zcode");
    expect(append).toContain("<available_zcode_models>");
    expect(append).toContain("</available_zcode_models>");
    expect(append).toContain("<id>builtin:bigmodel-coding-plan/GLM-5.3</id>");
    expect(append).toContain("<name>Z.ai - Coding Plan · GLM-5.3</name>");
    expect(append).toContain("<id>e512/mimo-v2.5-pro</id>");
    // 分界语义：pi 段的 id 不适用于本引擎
    expect(append).toContain("do NOT apply to engine 'zcode'");
  });

  it("引擎未实现 listModels → 「与主 agent 模型体系一致」声明段（port 契约：未实现 ≠ 无模型）", () => {
    // fakeEngine(id, null) = 不带 listModels 方法（未实现形态）
    registerEngine("bare", () => fakeEngine("bare", null));
    expect(buildEngineModelsPromptAppend("bare")).toBe(
      [
        "<available_bare_models>",
        "engine 'bare' uses the same model registry as the main agent — use ids from <available_provider_models> above",
        "</available_bare_models>",
      ].join("\n"),
    );
    // 文案语义守卫：指向上方核心段、不含 ZCode desktop 指引（那是无凭据形态专属）
    const append = buildEngineModelsPromptAppend("bare");
    expect(append).toContain("use ids from <available_provider_models> above");
    expect(append).not.toContain("ZCode desktop");
  });

  it("listModels 返回 null → 「与主 agent 模型体系一致」声明段；空清单 → 无凭据提示行段", () => {
    // null：listModels 存在但显式返回 null——port 契约与「未实现」同语义（与主体系一致）
    registerEngine("nul", () => ({ ...fakeEngine("nul", []), listModels: () => null }));
    expect(buildEngineModelsPromptAppend("nul")).toBe(
      [
        "<available_nul_models>",
        "engine 'nul' uses the same model registry as the main agent — use ids from <available_provider_models> above",
        "</available_nul_models>",
      ].join("\n"),
    );
    expect(buildEngineModelsPromptAppend("nul")).not.toContain("ZCode desktop");
    // 空清单：引擎枚举面存在但当前无凭据模型——维持「无凭据 + ZCode desktop 指引」文案
    registerEngine("empty", () => fakeEngine("empty", []));
    expect(buildEngineModelsPromptAppend("empty")).toBe(
      [
        "<available_empty_models>",
        "engine 'empty' has no credentialed models right now — configure the provider in ZCode desktop first",
        "</available_empty_models>",
      ].join("\n"),
    );
    expect(buildEngineModelsPromptAppend("empty")).toContain("<available_empty_models>");
  });

  it("未注册引擎 → 清单段不注入（警告归状态段负责，避免双份）", () => {
    registerEngine("zcode", () => fakeEngine("zcode", [{ id: "p/m1" }]));
    expect(buildEngineModelsPromptAppend("ghost")).toBe("");
  });

  it("listModels 抛异常 → fail-safe 输出提示行段不向外抛", () => {
    const throwing: EnginePort = {
      ...fakeEngine("boom", null),
      listModels: () => {
        throw new Error("v2 config broken");
      },
    };
    registerEngine("boom", () => throwing);
    const append = buildEngineModelsPromptAppend("boom");
    expect(append).toContain("<available_boom_models>");
    expect(append).toContain(
      "engine 'boom' has no credentialed models right now — configure the provider in ZCode desktop first",
    );
  });
});

describe("buildSubagentEngineSection（恒在状态段三形态，§3.1 逐字基准）", () => {
  it("defaultEngine=zcode（已注册非 pi）→ 声明 + 指向下方清单段 + AGENTS.md 冲突裁决 bullet", () => {
    registerEngine("zcode", () => fakeEngine("zcode", [{ id: "p/m1" }]));
    // 逐字基准：设计 §3.1 Turn 1 样例（含 AGENTS.md bullet 的 em dash 与换行拆分）
    expect(buildSubagentEngineSection("zcode")).toBe(
      [
        "<current_subagent_engine>",
        "Default engine for subagent dispatches when neither the call's `engine` param",
        "nor an agent .md `engine` frontmatter overrides: zcode",
        "- Model ids for zcode dispatches are listed in <available_zcode_models> below.",
        "  Ids in <available_provider_models> do NOT apply to zcode dispatches.",
        "- Omit `model` to use the engine default.",
        "- If AGENTS.md or other standing guidance names model ids from the pi registry",
        "  (e.g. zai-coding-cn/*), those ids apply to pi-engine dispatches ONLY — when",
        "  the current engine is not pi, use only ids from the engine section below.",
        "</current_subagent_engine>",
      ].join("\n"),
    );
  });

  it("defaultEngine=pi / 缺省 / 空白 → 声明 pi + 指向上方核心段（无冲突 bullet）", () => {
    // pi 形态不依赖注册表（缺省形态注册表为空也成立）
    const expected = [
      "<current_subagent_engine>",
      "Default engine for subagent dispatches when neither the call's `engine` param",
      "nor an agent .md `engine` frontmatter overrides: pi",
      "- Model ids for pi dispatches are the ids in <available_provider_models> above.",
      "- Omit `model` to use the engine default.",
      "</current_subagent_engine>",
    ].join("\n");
    expect(buildSubagentEngineSection("pi")).toBe(expected);
    expect(buildSubagentEngineSection(undefined)).toBe(expected);
    expect(buildSubagentEngineSection("  ")).toBe(expected);
  });

  it("defaultEngine=未注册引擎（ghost）→ 显示配置值 + 未注册警告行（失败路径表逐字）", () => {
    // 注册表里有其他引擎也不能让 ghost 误判为已注册
    registerEngine("zcode", () => fakeEngine("zcode", [{ id: "p/m1" }]));
    expect(buildSubagentEngineSection("ghost")).toBe(
      [
        "<current_subagent_engine>",
        "Default engine for subagent dispatches when neither the call's `engine` param",
        "nor an agent .md `engine` frontmatter overrides: ghost",
        "- engine 'ghost' is not registered — dispatches will fail at routing; fix subagents/config.json",
        "</current_subagent_engine>",
      ].join("\n"),
    );
  });

  it("渲染确定性（D7）：同输入两次调用输出逐字节相等", () => {
    registerEngine("zcode", () => fakeEngine("zcode", [{ id: "a/m1" }, { id: "b/m2" }]));
    const inputs: Array<string | undefined> = ["zcode", "pi", "ghost", undefined];
    for (const input of inputs) {
      // 字符串 toBe = 逐 UTF-16 码元值比较，即「同输入恒同输出」的字节稳定契约
      expect(buildSubagentEngineSection(input)).toBe(buildSubagentEngineSection(input));
      // 独立两次取值再比一次，排除实现内共享可变状态的可能
      const first = buildSubagentEngineSection(input);
      const second = buildSubagentEngineSection(input);
      expect(second).toBe(first);
    }
    expect(buildEngineModelsPromptAppend("zcode")).toBe(buildEngineModelsPromptAppend("zcode"));
    expect(buildEngineModelsPromptAppend("pi")).toBe(buildEngineModelsPromptAppend("pi"));
    // 新降级形态（U2 修订）确定性：「与主体系一致」声明段同输入恒同输出
    registerEngine("shared", () => fakeEngine("shared", null));
    registerEngine("nulled", () => ({ ...fakeEngine("nulled", []), listModels: () => null }));
    expect(buildEngineModelsPromptAppend("shared")).toBe(buildEngineModelsPromptAppend("shared"));
    expect(buildEngineModelsPromptAppend("nulled")).toBe(buildEngineModelsPromptAppend("nulled"));
  });
});
