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

describe("resolveEngineModelWithTranslation 偏好层翻译 + 降级（resolvePreferenceLayer 语义锚）", () => {
  /** model_not_available 形态错误（zcode 实装 preparer 的同款：Error + code 字段，非 any）。 */
  function modelNotAvailableError(message: string): Error & { code: string } {
    const err = new Error(message) as Error & { code: string };
    err.code = "model_not_available";
    return err;
  }

  it("翻译命中且在清单 → preference 来源（translateModelRef + listModels 双面引擎）", () => {
    const warns: string[] = [];
    const route = fakeRoute(`pref-hit-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => "native/m1",
      listModels: () => [{ id: "native/m1" }],
    });

    const resolved = resolveEngineModelWithTranslation(route, undefined, undefined, () => "pi-prov/m1", (m) => warns.push(m), "test");
    expect(resolved).toEqual({ engineModel: "native/m1", source: "preference" });
    expect(warns).toHaveLength(0);
  });

  it("无枚举面引擎（listModels 缺席）→ 翻译产物放行，不被当空清单误跳过", () => {
    const warns: string[] = [];
    const route = fakeRoute(`pref-no-list-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: (ref) => ref,
    });

    const resolved = resolveEngineModelWithTranslation(route, undefined, undefined, () => "prov/m1", (m) => warns.push(m), "test");
    expect(resolved).toEqual({ engineModel: "prov/m1", source: "preference" });
    expect(warns).toHaveLength(0);
  });

  it("翻译抛 model_not_available → 降级走引擎缺省 + warn（不炸派发）", () => {
    const warns: string[] = [];
    const route = fakeRoute(`pref-na-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => {
        throw modelNotAvailableError("no rule for legacy ref");
      },
    });

    const resolved = resolveEngineModelWithTranslation(route, undefined, undefined, () => "zai-coding-plan/legacy", (m) => warns.push(m), "wf");
    expect(resolved).toEqual({ engineModel: undefined, source: "default" });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("翻译失败");
    expect(warns[0]).toContain("no rule for legacy ref");
    expect(warns[0]).toContain("跳过偏好层走引擎缺省");
  });

  it("翻译抛非 model_not_available 错误 → 原样上抛（首败即停边界不吞）", () => {
    const warns: string[] = [];
    const route = fakeRoute(`pref-boom-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => {
        throw new Error("exploded");
      },
    });

    expect(() =>
      resolveEngineModelWithTranslation(route, undefined, undefined, () => "prov/m1", (m) => warns.push(m), "test"),
    ).toThrow("exploded");
    expect(warns).toHaveLength(0);
  });

  it("翻译后不在引擎清单 → 降级走引擎缺省 + warn（清单漂移不炸派发）", () => {
    const warns: string[] = [];
    const route = fakeRoute(`pref-drift-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => "retired/native-ref",
      listModels: () => [{ id: "native/m1" }],
    });

    const resolved = resolveEngineModelWithTranslation(route, undefined, undefined, () => "prov/m1", (m) => warns.push(m), "wf");
    expect(resolved).toEqual({ engineModel: undefined, source: "default" });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("retired/native-ref");
    expect(warns[0]).toContain("不在引擎模型清单");
  });

  it("偏好缺席（readPreference 返回 undefined）→ default 来源且不触翻译面", () => {
    const warns: string[] = [];
    let translateCalls = 0;
    const route = fakeRoute(`pref-absent-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => {
        translateCalls += 1;
        return "never";
      },
    });

    const resolved = resolveEngineModelWithTranslation(route, undefined, undefined, () => undefined, (m) => warns.push(m), "test");
    expect(resolved).toEqual({ engineModel: undefined, source: "default" });
    expect(translateCalls).toBe(0);
    expect(warns).toHaveLength(0);
  });

  it("显式层在场 → 偏好 thunk 不求值（惰性纪律：前两层命中不触盘）", () => {
    const route = fakeRoute(`pref-lazy-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: (ref) => ref,
    });
    let preferenceReads = 0;

    const resolved = resolveEngineModelWithTranslation(route, "prov/explicit", undefined, () => {
      preferenceReads += 1;
      return "prov/pref";
    }, () => undefined, "test");
    expect(resolved).toEqual({ engineModel: "prov/explicit", source: "explicit" });
    expect(preferenceReads).toBe(0);
  });
});
