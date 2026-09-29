// preparer.test.ts —— provider_config 单源模型解析 / 模型可发现性 / 凭据与模型前置错误。
// 源切换背景（2026-09-29 account 体系迁移同步）：app 3.14.x 起 plan 家族 provider
// （builtin:/account: 前缀）经账号 entitlement 门控，外部 spawn 的 app-server 注册表
// 只装载 provider_config.json 的个人 provider——引擎侧校验源与之对齐（旧 v2 config
// 源的 plan 家族条目与注册表实况不符，已退役为 launcher 凭据注入专用）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  ZcodePrepareError,
  listZcodeModels,
  resolveZcodeMinimalReasoningLevel,
  resolveZcodeModelRef,
} from "../preparer.ts";

let tmpRoot: string;
let personalPath: string;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

const PROVIDER_A = "11111111-aaaa-4000-8000-000000000001";
const PROVIDER_B = "22222222-bbbb-4000-8000-000000000002";

function seedSources(): void {
  writeJson(personalPath, {
    schemaVersion: 1,
    config: {
      providerOrder: [PROVIDER_A, PROVIDER_B],
      providerConfigRules: {
        providerRules: [
          {
            providerId: PROVIDER_A,
            providerName: "provider-a",
            config: { access: { type: "api-key", apiKey: "key-a" }, personalModelIds: ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2"] },
          },
          {
            providerId: PROVIDER_B,
            providerName: "provider-b",
            config: { access: { type: "api-key", apiKey: "key-b" }, personalModelIds: ["mimo-v2.6-pro"] },
          },
          {
            providerId: "no-key-provider",
            config: { access: { type: "api-key" }, personalModelIds: ["M1"] },
          },
        ],
      },
    },
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-preparer-"));
  personalPath = path.join(tmpRoot, "provider_config.json");
  seedSources();
});

describe("resolveZcodeModelRef（provider_config 单源）", () => {
  it("显式全名解析 + 规范化", () => {
    expect(resolveZcodeModelRef(`${PROVIDER_B}/mimo-v2.6-pro`, { personalProviderConfigPath: personalPath })).toBe(
      `${PROVIDER_B}/mimo-v2.6-pro`,
    );
  });

  it("短名按 providerOrder 首个带凭据 provider 解析", () => {
    expect(resolveZcodeModelRef("GLM-5.3", { personalProviderConfigPath: personalPath })).toBe(
      `${PROVIDER_A}/GLM-5.3`,
    );
  });

  it("未指定时返回空串（= create 省略 model 键，CLI 缺省解析——不伪造兜底 id）", () => {
    expect(resolveZcodeModelRef(undefined, { personalProviderConfigPath: personalPath })).toBe("");
  });

  it("未知模型 → model_not_available（列该 provider 可用模型）", () => {
    try {
      resolveZcodeModelRef(`${PROVIDER_A}/nope`, { personalProviderConfigPath: personalPath });
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZcodePrepareError);
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("model_not_available");
      expect(e.message).toContain("GLM-5.3, GLM-5.3-Flash, GLM-5.2");
    }
  });

  it("未知 provider → model_not_available（列带凭据 provider；plan 家族 id 在此被拒）", () => {
    try {
      resolveZcodeModelRef("builtin:bigmodel-coding-plan/GLM-5.3-Flash", { personalProviderConfigPath: personalPath });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("model_not_available");
      expect((err as ZcodePrepareError).message).toContain(PROVIDER_A);
      expect((err as ZcodePrepareError).message).toContain(PROVIDER_B);
    }
  });

  it("provider 存在但无 apiKey → engine_credential_missing", () => {
    try {
      resolveZcodeModelRef("no-key-provider/M1", { personalProviderConfigPath: personalPath });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("engine_credential_missing");
    }
  });

  it("源内零带凭据 provider → engine_credential_missing（缺席输入同判——凭据预检）", () => {
    writeJson(personalPath, { config: { providerConfigRules: { providerRules: [] } } });
    try {
      resolveZcodeModelRef(undefined, { personalProviderConfigPath: personalPath });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("engine_credential_missing");
      expect((err as ZcodePrepareError).message).toContain("provider_config.json");
    }
  });
});

describe("listZcodeModels（U7 可发现性）", () => {
  it("带凭据 provider × 模型清单（无凭据者排除；name = provider 名 · 模型）", () => {
    const models = listZcodeModels({ personalProviderConfigPath: personalPath });
    expect(models.map((m) => m.id)).toEqual([
      `${PROVIDER_A}/GLM-5.3`,
      `${PROVIDER_A}/GLM-5.3-Flash`,
      `${PROVIDER_A}/GLM-5.2`,
      `${PROVIDER_B}/mimo-v2.6-pro`,
    ]);
    expect(models[0]?.name).toBe("provider-a · GLM-5.3");
  });

  it("源缺失 → 空清单（失败安全）", () => {
    expect(listZcodeModels({ personalProviderConfigPath: path.join(tmpRoot, "absent.json") })).toEqual([]);
  });
});

describe("resolveZcodeMinimalReasoningLevel（目录值域）", () => {
  let catalogPath: string;

  beforeEach(() => {
    catalogPath = path.join(tmpRoot, "zcode-builtin.json");
    writeJson(catalogPath, {
      schemaVersion: 1,
      revision: 1,
      config: {
        modelConfigRules: {
          modelRules: [
            { modelMatch: ".*", config: { optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } } },
            { modelMatch: ".*mimo-v2\\.6-flash(?:[.\\-:/\\[].*)?", config: { optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } } },
            { modelMatch: ".*glm-5\\.3(?:[.\\-:/\\[].*)?", config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } } },
            { modelMatch: ".*no-values.*", config: { optionSpecs: { maxOutputTokens: { max: 1 } } } },
          ],
        },
      },
    });
  });

  it("通配规则命中 → 首值（最小档）；特异规则在后覆盖（glm 家族 low）", () => {
    const sources = { builtinCatalogPath: catalogPath };
    expect(resolveZcodeMinimalReasoningLevel(`${PROVIDER_B}/mimo-v2.6-flash`, sources)).toBe("disabled");
    expect(resolveZcodeMinimalReasoningLevel(`${PROVIDER_B}/glm-5.3`, sources)).toBe("low");
    expect(resolveZcodeMinimalReasoningLevel(`${PROVIDER_B}/other-model`, sources)).toBe("disabled");
  });

  it("命中但无值域的规则不参与 → 落回通配值域", () => {
    expect(resolveZcodeMinimalReasoningLevel(`${PROVIDER_B}/no-values-x`, { builtinCatalogPath: catalogPath })).toBe("disabled");
  });

  it("目录缺失 → undefined（不携带，行为与未实现等价）", () => {
    expect(resolveZcodeMinimalReasoningLevel(`${PROVIDER_B}/m1`, { builtinCatalogPath: path.join(tmpRoot, "absent-catalog.json") })).toBeUndefined();
  });
});
