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

/** 最小 route 替身（消费面只读 engineId + engine 两个可选成员；listModels 允许 union——Promise 侧 = 协议 RPC 活清单替身）。 */
function fakeRoute(
  engineId: string,
  members: {
    translateModelRef?: (ref: string) => string;
    listModels?: () => Array<{ id: string }> | null | Promise<Array<{ id: string }> | null>;
  },
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
  it("翻译面缺席 → 首次解析 warn 一次；同引擎再解析不重复（进程级去重）", async () => {
    const warns: string[] = [];
    const warn = (m: string): void => {
      warns.push(m);
    };
    const route = fakeRoute(`no-face-${Math.random().toString(36).slice(2)}`, {});

    await resolveEngineModelWithTranslation(route, "prov/m1", undefined, () => undefined, warn, "test");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("no model translation face");
    expect(warns[0]).toContain(route.engineId);

    // 同引擎第二次解析：不重复告警（去重），语义照常恒等透传
    const second = await resolveEngineModelWithTranslation(route, "prov/m2", undefined, () => undefined, warn, "test");
    expect(warns).toHaveLength(1);
    expect(second.engineModel).toBe("prov/m2");
  });

  it("翻译面在场 → 不触发缺席告警；照常翻译", async () => {
    const warns: string[] = [];
    const warn = (m: string): void => {
      warns.push(m);
    };
    const route = fakeRoute(`with-face-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: (ref) => ref.replace("pi-prov/", "native-prov/"),
    });

    const resolved = await resolveEngineModelWithTranslation(route, "pi-prov/m1", undefined, () => undefined, warn, "test");
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

  it("翻译命中且在清单 → preference 来源（translateModelRef + listModels 双面引擎）", async () => {
    const warns: string[] = [];
    const route = fakeRoute(`pref-hit-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => "native/m1",
      listModels: () => [{ id: "native/m1" }],
    });

    const resolved = await resolveEngineModelWithTranslation(route, undefined, undefined, () => "pi-prov/m1", (m) => warns.push(m), "test");
    expect(resolved).toEqual({ engineModel: "native/m1", source: "preference" });
    expect(warns).toHaveLength(0);
  });

  it("无枚举面引擎（listModels 缺席）→ 翻译产物放行，不被当空清单误跳过", async () => {
    const warns: string[] = [];
    const route = fakeRoute(`pref-no-list-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: (ref) => ref,
    });

    const resolved = await resolveEngineModelWithTranslation(route, undefined, undefined, () => "prov/m1", (m) => warns.push(m), "test");
    expect(resolved).toEqual({ engineModel: "prov/m1", source: "preference" });
    expect(warns).toHaveLength(0);
  });

  it("翻译抛 model_not_available → 降级走引擎缺省 + warn（不炸派发）", async () => {
    const warns: string[] = [];
    const route = fakeRoute(`pref-na-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => {
        throw modelNotAvailableError("no rule for legacy ref");
      },
    });

    const resolved = await resolveEngineModelWithTranslation(route, undefined, undefined, () => "zai-coding-plan/legacy", (m) => warns.push(m), "wf");
    expect(resolved).toEqual({ engineModel: undefined, source: "default" });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("翻译失败");
    expect(warns[0]).toContain("no rule for legacy ref");
    expect(warns[0]).toContain("跳过偏好层走引擎缺省");
  });

  it("翻译抛非 model_not_available 错误 → 原样上抛（首败即停边界不吞）", async () => {
    const warns: string[] = [];
    const route = fakeRoute(`pref-boom-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => {
        throw new Error("exploded");
      },
    });

    await expect(
      resolveEngineModelWithTranslation(route, undefined, undefined, () => "prov/m1", (m) => warns.push(m), "test"),
    ).rejects.toThrow("exploded");
    expect(warns).toHaveLength(0);
  });

  it("翻译后不在引擎清单 → 降级走引擎缺省 + warn（清单漂移不炸派发）", async () => {
    const warns: string[] = [];
    const route = fakeRoute(`pref-drift-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => "retired/native-ref",
      listModels: () => [{ id: "native/m1" }],
    });

    const resolved = await resolveEngineModelWithTranslation(route, undefined, undefined, () => "prov/m1", (m) => warns.push(m), "wf");
    expect(resolved).toEqual({ engineModel: undefined, source: "default" });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("retired/native-ref");
    expect(warns[0]).toContain("不在引擎模型清单");
  });

  it("偏好缺席（readPreference 返回 undefined）→ default 来源且不触翻译面", async () => {
    const warns: string[] = [];
    let translateCalls = 0;
    const route = fakeRoute(`pref-absent-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => {
        translateCalls += 1;
        return "never";
      },
    });

    const resolved = await resolveEngineModelWithTranslation(route, undefined, undefined, () => undefined, (m) => warns.push(m), "test");
    expect(resolved).toEqual({ engineModel: undefined, source: "default" });
    expect(translateCalls).toBe(0);
    expect(warns).toHaveLength(0);
  });

  it("显式层在场 → 偏好 thunk 不求值（惰性纪律：前两层命中不触盘）", async () => {
    const route = fakeRoute(`pref-lazy-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: (ref) => ref,
    });
    let preferenceReads = 0;

    const resolved = await resolveEngineModelWithTranslation(route, "prov/explicit", undefined, () => {
      preferenceReads += 1;
      return "prov/pref";
    }, () => undefined, "test");
    expect(resolved).toEqual({ engineModel: "prov/explicit", source: "explicit" });
    expect(preferenceReads).toBe(0);
  });
});

describe("resolveEngineModelWithTranslation 成员校验异步化（listModels union Promise 侧）", () => {
  it("活清单（Promise 侧）命中 → preference 来源（await 消费协议 RPC 面）", async () => {
    const warns: string[] = [];
    let rpcCalls = 0;
    const route = fakeRoute(`async-hit-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => "account:plan/glm-5.3",
      listModels: () => {
        rpcCalls += 1;
        return Promise.resolve([{ id: "account:plan/glm-5.3" }, { id: "account:plan/kimi" }]);
      },
    });

    const resolved = await resolveEngineModelWithTranslation(
      route, undefined, undefined, () => "zai-coding-cn/glm-5.3", (m) => warns.push(m), "test",
    );
    expect(resolved).toEqual({ engineModel: "account:plan/glm-5.3", source: "preference" });
    expect(rpcCalls).toBe(1);
    expect(warns).toHaveLength(0);
  });

  it("活清单（Promise 侧）未命中 → 降级走引擎缺省 + warn（动态引擎清单漂移不炸派发）", async () => {
    const warns: string[] = [];
    const route = fakeRoute(`async-miss-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => "account:plan/retired",
      listModels: () => Promise.resolve([{ id: "account:plan/glm-5.3" }]),
    });

    const resolved = await resolveEngineModelWithTranslation(
      route, undefined, undefined, () => "zai-coding-cn/retired", (m) => warns.push(m), "wf",
    );
    expect(resolved).toEqual({ engineModel: undefined, source: "default" });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("account:plan/retired");
    expect(warns[0]).toContain("不在引擎模型清单");
  });

  it("RPC 失败 → 放行（不拦截模型解析）+ per-engine warn 恰一次（同引擎会话不刷屏）", async () => {
    const warns: string[] = [];
    let rpcCalls = 0;
    const route = fakeRoute(`async-fail-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => "account:plan/glm-5.3",
      listModels: () => {
        rpcCalls += 1;
        return Promise.reject(new Error("engine_transport_lost: socket closed"));
      },
    });

    // 第一次：放行偏好值（引擎侧校验兜底）+ warn 一次
    const first = await resolveEngineModelWithTranslation(
      route, undefined, undefined, () => "zai-coding-cn/glm-5.3", (m) => warns.push(m), "test",
    );
    expect(first).toEqual({ engineModel: "account:plan/glm-5.3", source: "preference" });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("listModels failed");
    expect(warns[0]).toContain(route.engineId);
    expect(warns[0]).toContain("engine_transport_lost");
    expect(warns[0]).toContain("passed through unvalidated");

    // 第二次：照常放行，不重复 warn（进程级去重）
    const second = await resolveEngineModelWithTranslation(
      route, undefined, undefined, () => "zai-coding-cn/glm-5.3", (m) => warns.push(m), "test",
    );
    expect(second).toEqual({ engineModel: "account:plan/glm-5.3", source: "preference" });
    expect(rpcCalls).toBe(2); // 每次派发仍真拉清单（新鲜度优先，去重只作用于 warn）
    expect(warns).toHaveLength(1);
  });

  it("RPC 失败后清单恢复 → 成员校验照常生效（失败是按次的，不粘住引擎）", async () => {
    const warns: string[] = [];
    let fail = true;
    const route = fakeRoute(`async-recover-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: () => "account:plan/glm-5.3",
      listModels: () =>
        fail
          ? Promise.reject(new Error("engine_request_timeout"))
          : Promise.resolve([{ id: "account:plan/glm-5.3" }]),
    });

    const degraded = await resolveEngineModelWithTranslation(
      route, undefined, undefined, () => "zai-coding-cn/glm-5.3", (m) => warns.push(m), "test",
    );
    expect(degraded).toEqual({ engineModel: "account:plan/glm-5.3", source: "preference" });

    fail = false;
    const recovered = await resolveEngineModelWithTranslation(
      route, undefined, undefined, () => "zai-coding-cn/glm-5.3", (m) => warns.push(m), "test",
    );
    expect(recovered).toEqual({ engineModel: "account:plan/glm-5.3", source: "preference" });
    expect(warns).toHaveLength(1); // 恢复后无新增 warn
  });

  it("显式层在场 → 不触 listModels（RPC 只属偏好层成员校验）", async () => {
    let rpcCalls = 0;
    const route = fakeRoute(`async-lazy-${Math.random().toString(36).slice(2)}`, {
      translateModelRef: (ref) => ref,
      listModels: () => {
        rpcCalls += 1;
        return Promise.resolve([]);
      },
    });

    const resolved = await resolveEngineModelWithTranslation(
      route, "prov/explicit", undefined, () => "prov/pref", () => undefined, "test",
    );
    expect(resolved).toEqual({ engineModel: "prov/explicit", source: "explicit" });
    expect(rpcCalls).toBe(0);
  });
});
