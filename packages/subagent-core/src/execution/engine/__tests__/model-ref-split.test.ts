// model-ref-split.test.ts —— [W3 契约变更④] 无斜杠 canonicalRef 的 core 侧拆分单测。
//
// 设计权威源：docs/architecture/subagent-engine-protocolization.md §3.3 validateModel 行
// （「core 必须改 resolveIdentityForEngine 与续聊回读对无斜杠 ref 的处理：provider="",
// id=ref，整串进 name，否则落成 "<ref>/" 畸形」）。拆分单一权威 = splitEngineModelRef，
// 写入词形 = joinEngineModelRef（provider 空串不拼斜杠）；两消费方（chat 域留痕 /
// 续聊回读）必须同源，否则写入/回读对同一 ref 给出不同 provider/id。

import { describe, expect, it } from "vitest";

import { joinEngineModelRef, splitEngineModelRef } from "../model-validation.ts";

describe("splitEngineModelRef（契约④：无斜杠 ref 不落畸形）", () => {
  it("有斜杠 ref：provider/id 常规拆分，name = 整串", () => {
    expect(splitEngineModelRef("zai/glm-4.6")).toEqual({
      provider: "zai",
      id: "glm-4.6",
      name: "zai/glm-4.6",
    });
  });

  it("无斜杠 ref（引擎原样返回）：provider=''、id=整串、name=整串——不落 \"<ref>/\" 畸形", () => {
    expect(splitEngineModelRef("glm-4.6")).toEqual({
      provider: "",
      id: "glm-4.6",
      name: "glm-4.6",
    });
  });

  it("空串（引擎未实现校验面且无显式 model 的防御形态）：provider/id/name 全空串", () => {
    expect(splitEngineModelRef("")).toEqual({ provider: "", id: "", name: "" });
  });

  it("开头斜杠（异常形态防御）：按无斜杠分支处理，不 crash", () => {
    expect(splitEngineModelRef("/glm")).toEqual({ provider: "", id: "/glm", name: "/glm" });
  });

  it("多斜杠 ref：首个斜杠拆分（provider 不含斜杠、id 保留其余）", () => {
    expect(splitEngineModelRef("prov/org/model")).toEqual({
      provider: "prov",
      id: "org/model",
      name: "prov/org/model",
    });
  });
});

describe("joinEngineModelRef（record.model 写入词形，与拆分往返自洽）", () => {
  it("provider 非空：provider/id 词形", () => {
    expect(joinEngineModelRef({ provider: "zai", id: "glm-4.6", name: "zai/glm-4.6" })).toBe("zai/glm-4.6");
  });

  it("provider 空串（契约④）：只写 id，无头斜杠——续聊回读可还原", () => {
    expect(joinEngineModelRef({ provider: "", id: "glm-4.6", name: "glm-4.6" })).toBe("glm-4.6");
  });

  it("写入 → 回读往返（join ∘ split 恒等；split ∘ join 语义还原）", () => {
    for (const modelStr of ["zai/glm-4.6", "glm-4.6", ""]) {
      const split = splitEngineModelRef(modelStr);
      const joined = joinEngineModelRef(split);
      expect(joined).toBe(modelStr); // 写出词形 == 原 ref（无任何斜杠畸形增删）
      const reSplit = splitEngineModelRef(joined);
      expect(reSplit).toEqual(split); // 回读还原同一 provider/id/name
    }
  });

  it("回归锚（旧行为对照）：无斜杠 ref 旧实现落 record.model=\"<ref>/\" 且续聊还原 provider=\"<ref>\"——现两处均消除", () => {
    const ref = "glm-4.6";
    const split = splitEngineModelRef(ref);
    // 写入侧：无尾斜杠
    expect(joinEngineModelRef(split)).not.toContain("/");
    // 回读侧：provider 为空串（旧行为是 "unknown"/整串，给续轮注入虚构 provider）
    expect(splitEngineModelRef(joinEngineModelRef(split)).provider).toBe("");
  });
});
