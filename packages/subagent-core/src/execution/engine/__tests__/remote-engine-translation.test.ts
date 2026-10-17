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
import { RemoteEngine } from "../client/remote-engine.ts";
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

function makeEngine(manifest: { modelTranslation?: Record<string, string> }): RemoteEngine {
  const client = new EngineClient({
    engineId: "zcode",
    command: process.execPath,
    args: [],
    hostKind: "test",
    dataDir: tmpRoot,
    envPrefixes: [],
  });
  return new RemoteEngine({
    engineId: "zcode",
    client,
    manifest: { capabilities: { ...FAKE_CAPS }, ...manifest },
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
});
