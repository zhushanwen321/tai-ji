// src/execution/engine/__tests__/remote-engine-translation.test.ts
//
// [engine-ref-translation D5] RemoteEngine 翻译面（2026-10-16 部署形态修复）：
// manifest modelTranslation 声明 → 构造器装配 translateModelRef 成员；缺席 → 摘除
// （与 validateModel/setModel 同款形态映射）。此前 RemoteEngine 未实装本成员且无任何
// 信号——staged 引擎 cli 形态下派发层翻译整体静默失效，偏好层死值直穿引擎侧炸
// model_not_available（2026-10-16 会话实测事故），本文件是该缺口的回归守卫。
//
// EngineClient 构造纯内存无副作用（spawn 在 ensureConnected），translateModelRef 只读
// manifest 注册期快照不触协议——无需连接，也无需清理（与 model-prompt.test.ts 同款）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { EngineClient } from "../client/engine-client.ts";
import { RemoteEngine, type RemoteEngineManifestSnapshot } from "../client/remote-engine.ts";
import { translateByTableReverse } from "../client/manifest-lookup.ts";
import type { EngineCapabilities } from "../types.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remote-engine-translation-"));

const FAKE_CAPS: EngineCapabilities = {
  schemaEnforcement: "emulated",
  steer: "unsupported",
  conversation: "cold",
  personaInjection: "prompt",
  eventGranularity: "stream",
  sandbox: "none",
  sessionRead: "outcome-only",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "ignored",
  maxTurns: false,
  setModel: "unsupported",
};

const TABLE = { "zai-coding-cn": "account:bigmodel-individual-coding-plan" };

function makeEngine(manifest: {
  modelTranslation?: Record<string, string> | null;
}): RemoteEngine {
  const client = new EngineClient({
    engineId: "zcode",
    command: process.execPath,
    args: [],
    hostKind: "test",
    dataDir: tmpRoot,
    envPrefixes: [],
  });
  // 正规解析链（parseModelTranslation）把 manifest JSON 的 null 归一 undefined，
  // snapshot 类型不含 null；null 注入 = 模拟注入方绕过类型契约的运行时形态
  // （S-15 防御面），构造器双判定兜住，此处 as 仅为构造该契约外形态。
  return new RemoteEngine({
    engineId: "zcode",
    client,
    manifest: { capabilities: { ...FAKE_CAPS }, ...manifest } as RemoteEngineManifestSnapshot,
    dataDir: tmpRoot,
    hostKind: "test",
  });
}

describe("RemoteEngine translateModelRef 形态映射（manifest modelTranslation）", () => {
  it("声明表在 → 成员实装：provider 段查表改写，模型段原样保留", () => {
    const engine = makeEngine({ modelTranslation: TABLE });
    expect(typeof engine.translateModelRef).toBe("function");
    expect(engine.translateModelRef("zai-coding-cn/glm-5.3-flash")).toBe(
      "account:bigmodel-individual-coding-plan/glm-5.3-flash",
    );
  });

  it("幂等：翻译产物（account:/个人 id）与裸 id 再入恒等", () => {
    const engine = makeEngine({ modelTranslation: TABLE });
    expect(engine.translateModelRef("account:bigmodel-individual-coding-plan/GLM-5.3-Flash")).toBe(
      "account:bigmodel-individual-coding-plan/GLM-5.3-Flash",
    );
    expect(engine.translateModelRef("e512d53e-0bfc/mimo-v2.6-flash")).toBe("e512d53e-0bfc/mimo-v2.6-flash");
    expect(engine.translateModelRef("GLM-5.3")).toBe("GLM-5.3");
  });

  it("表外 provider（含已退役 pi 词汇）原样透传——不纠正不抛错，引擎侧裁决", () => {
    const engine = makeEngine({ modelTranslation: TABLE });
    expect(engine.translateModelRef("zai-coding-plan/GLM-5.3-Flash")).toBe("zai-coding-plan/GLM-5.3-Flash");
  });

  it("原型链键（toString/constructor）不作 provider 段命中——原样透传（自有属性判定）", () => {
    const engine = makeEngine({ modelTranslation: TABLE });
    expect(engine.translateModelRef("toString/GLM-5.3")).toBe("toString/GLM-5.3");
    expect(engine.translateModelRef("constructor/GLM-5.3")).toBe("constructor/GLM-5.3");
  });

  it("声明表缺席 → 成员摘除（消费方 typeof 探测缺席语义：恒等透传 + 生效回执 warn）", () => {
    const engine = makeEngine({});
    expect(typeof engine.translateModelRef).toBe("undefined");
  });

  it("声明表为 null（JSON 合法形态）→ 等价省略：成员摘除（S-15：构造器判定未含 null 时 null 穿透查表）", () => {
    const engine = makeEngine({ modelTranslation: null });
    expect(typeof engine.translateModelRef).toBe("undefined");
  });
});

describe("translateByTableReverse — 显示侧反向查表（引擎原生 ref 翻回 pi 词汇）", () => {
  it("值域命中：引擎原生 provider 段翻回 pi 词汇，模型段原样保留（引擎目录大小写不在此归一）", () => {
    expect(translateByTableReverse(TABLE, "account:bigmodel-individual-coding-plan/GLM-5.3-Flash")).toBe(
      "zai-coding-cn/GLM-5.3-Flash",
    );
  });

  it("幂等：pi 词汇 ref 与 1:1 provider ref 再入恒等（不在值域透传）", () => {
    expect(translateByTableReverse(TABLE, "zai-coding-cn/glm-5.3-flash")).toBe("zai-coding-cn/glm-5.3-flash");
    expect(translateByTableReverse(TABLE, "xiaomi-token-plan-cn/mimo-v2.6-flash")).toBe(
      "xiaomi-token-plan-cn/mimo-v2.6-flash",
    );
  });

  it("裸 id（无 '/' 或空 provider 段）恒等透传", () => {
    expect(translateByTableReverse(TABLE, "GLM-5.3-Flash")).toBe("GLM-5.3-Flash");
    expect(translateByTableReverse(TABLE, "/GLM-5.3-Flash")).toBe("/GLM-5.3-Flash");
  });

  it("模型段可含 '/'：反查只吞第一个 '/' 前的 provider 段", () => {
    expect(translateByTableReverse(TABLE, "account:bigmodel-individual-coding-plan/family/GLM-5.3")).toBe(
      "zai-coding-cn/family/GLM-5.3",
    );
  });
});
