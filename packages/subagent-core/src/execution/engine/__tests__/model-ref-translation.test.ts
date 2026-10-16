// src/execution/engine/__tests__/model-ref-translation.test.ts
//
// [engine-ref-translation D5 生效回执] 翻译面缺席 warn 的去重语义（2026-10-16）：
// 缺席 = 恒等透传语义不变，但必须可观测——staged 引擎 cli 形态此前无任何信号，
// 修复语义在部署形态整体静默失效（2026-10-16 会话实测事故）。warn 为 per-engineId
// 进程级一次；去重 Set 是模块级状态，用例以唯一 engineId 隔离。

import { describe, expect, it } from "vitest";

import type { EngineCapabilities } from "../types.ts";
import type { EnginePort } from "../port.ts";
import { resolveEngineModelWithTranslation } from "../model-ref-translation.ts";

const CAPS: EngineCapabilities = {
  schemaEnforcement: "emulated",
  steer: "unsupported",
  conversation: "unsupported",
  personaInjection: "prompt",
  eventGranularity: "coarse",
  sandbox: "none",
  sessionRead: "outcome-only",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "ignored",
  maxTurns: false,
  setModel: "unsupported",
};

/** 最小 route 替身（消费面只读 engineId + engine 两个可选成员）。 */
function fakeRoute(
  engineId: string,
  members: { translateModelRef?: (ref: string) => string; listModels?: () => Array<{ id: string }> },
): { engineId: string; source: "default"; engine: EnginePort } {
  const engine = {
    id: engineId,
    capabilities: () => CAPS,
    async probe() {
      return { ok: true, engineVersion: "fake", checks: [] };
    },
    async run() {
      throw new Error("not used");
    },
    async read() {
      throw new Error("not used");
    },
    ...members,
  } as unknown as EnginePort;
  return { engineId, source: "default", engine };
}

describe("resolveEngineModelWithTranslation 生效回执（翻译面缺席 warn 去重）", () => {
  it("翻译面缺席 → 首次解析 warn 一次；同引擎再解析不重复（进程级去重）", () => {
    const warns: string[] = [];
    const warn = (m: string): void => {
      warns.push(m);
    };
    const route = fakeRoute(`no-face-${Math.random().toString(36).slice(2)}`, {});

    resolveEngineModelWithTranslation(route, "prov/m1", undefined, () => undefined, warn, "test");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("no model translation face");
    expect(warns[0]).toContain(route.engineId);

    // 同引擎第二次解析：不重复告警（去重），语义照常恒等透传
    const second = resolveEngineModelWithTranslation(route, "prov/m2", undefined, () => undefined, warn, "test");
    expect(warns).toHaveLength(1);
    expect(second.engineModel).toBe("prov/m2");
  });

  it("翻译面在场 → 不触发缺席告警；照常翻译", () => {
    const warns: string[] = [];
    const warn = (m: string): void => {
      warns.push(m);
    };
    const route = fakeRoute(`with-face-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: (ref) => ref.replace("pi-prov/", "native-prov/"),
    });

    const resolved = resolveEngineModelWithTranslation(route, "pi-prov/m1", undefined, () => undefined, warn, "test");
    expect(resolved.engineModel).toBe("native-prov/m1");
    expect(warns).toHaveLength(0);
  });
});
