// src/shared/__tests__/zcode-model-ref.test.ts
//
// [⑦ 模型引用三元组化] splitZcodeModelRef 收敛到 parseModelSelector 单源后的语义锚定：
// 切分语法（`/` 取第一个、id 可含 `/`、合法 thinking 档位后缀剥离、非白名单冒号不误剥）
// 只在 shared/model-ref.ts 裁决，本文件锁定 zcode 命名域返回形状（providerId/modelId）
// 与单源语义一致——防未来回退为本地 split 双实现漂移。

import { describe, expect, it } from "vitest";

import { splitZcodeModelRef } from "../zcode-model-ref.ts";

describe("splitZcodeModelRef（parseModelSelector 单源语义）", () => {
  it("规范全名 provider/model → {providerId, modelId}", () => {
    expect(splitZcodeModelRef("zai-coding-cn/glm-5.3")).toEqual({
      providerId: "zai-coding-cn",
      modelId: "glm-5.3",
    });
  });

  it("id 含斜杠：`/` 取第一个（id 保留余段），与 parseModelSelector 同源", () => {
    expect(splitZcodeModelRef("prov/org/model")).toEqual({
      providerId: "prov",
      modelId: "org/model",
    });
  });

  it("合法 thinking 档位后缀随单源剥离（档位不进 modelId）", () => {
    expect(splitZcodeModelRef("prov/model:xhigh")).toEqual({
      providerId: "prov",
      modelId: "model",
    });
  });

  it("非白名单冒号不误剥（model:foo 仍属 id）", () => {
    expect(splitZcodeModelRef("prov/model:foo")).toEqual({
      providerId: "prov",
      modelId: "model:foo",
    });
  });

  it("无斜杠形态：providerId 空串、整串进 modelId", () => {
    expect(splitZcodeModelRef("bare-model")).toEqual({
      providerId: "",
      modelId: "bare-model",
    });
  });
});
