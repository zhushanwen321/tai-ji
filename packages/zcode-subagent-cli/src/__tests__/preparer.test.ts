// preparer.test.ts —— provider_config 单源模型解析 / 模型可发现性 / 凭据与模型前置错误。
// 源切换背景（2026-09-29 account 体系迁移同步）：app 3.14.x 起 plan 家族 provider
// （builtin:/account: 前缀）经账号 entitlement 门控，外部 spawn 的 app-server 注册表
// 只装载 provider_config.json 的个人 provider——引擎侧校验源与之对齐（旧 v2 config
// 源的 plan 家族条目与注册表实况不符，已退役为 launcher 凭据注入专用）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ZcodePrepareError,
  defaultPersonalProviderConfigPath,
  listZcodeModels,
  locateZcodeBuiltinCatalog,
  resolveZcodeMinimalReasoningLevel,
  resolveZcodeModelRef,
} from "../preparer.ts";

// locateZcodeBuiltinCatalog 目录扫描分支以 os.homedir() 为根——测试不触碰真实
// ~/.zcode：zcHomeRef 置值后 homedir 指向 tmp 树（缺省回落真实 HOME，供缺省路径
// 断言用例）。
const { zcHomeRef } = vi.hoisted(() => ({ zcHomeRef: { current: undefined as string | undefined } }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    homedir: () => zcHomeRef.current ?? actual.homedir(),
  };
});

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

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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

  it("regex 编译失败的规则跳过（后续规则继续参与——坏规则不毒化整目录）", () => {
    const badRegexCatalog = path.join(tmpRoot, "bad-regex-catalog.json");
    writeJson(badRegexCatalog, {
      config: {
        modelConfigRules: {
          modelRules: [
            { modelMatch: "([", config: { optionSpecs: { reasoningLevel: { values: ["broken"] } } } },
            { modelMatch: ".*", config: { optionSpecs: { reasoningLevel: { values: ["low"] } } } },
          ],
        },
      },
    });
    expect(resolveZcodeMinimalReasoningLevel(`${PROVIDER_B}/any`, { builtinCatalogPath: badRegexCatalog })).toBe("low");
  });

  it("目录缺失 → undefined（不携带，行为与未实现等价）", () => {
    expect(resolveZcodeMinimalReasoningLevel(`${PROVIDER_B}/m1`, { builtinCatalogPath: path.join(tmpRoot, "absent-catalog.json") })).toBeUndefined();
  });
});

// ── locateZcodeBuiltinCatalog 目录定位（显式源 > env > runtime/provider 扫描）──
// env 全局污染防护：本 describe 用例独占 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 的
// save/delete/restore（其余 describe 一律走显式 sources，不受影响）。
const CATALOG_ENV_KEY = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";

describe("locateZcodeBuiltinCatalog（目录定位三源）", () => {
  let savedCatalogEnv: string | undefined;

  beforeEach(() => {
    savedCatalogEnv = process.env[CATALOG_ENV_KEY];
    delete process.env[CATALOG_ENV_KEY];
  });

  afterEach(() => {
    if (savedCatalogEnv === undefined) {
      delete process.env[CATALOG_ENV_KEY];
    } else {
      process.env[CATALOG_ENV_KEY] = savedCatalogEnv;
    }
    zcHomeRef.current = undefined;
  });

  it("env 注入优先于目录扫描（launcher/宿主注入通道）", () => {
    const envPath = path.join(tmpRoot, "env-catalog.json");
    process.env[CATALOG_ENV_KEY] = envPath;
    expect(locateZcodeBuiltinCatalog()).toBe(envPath);
  });

  it("runtime/provider 扫描：本平台目录 × semver 最大版本 × endpoint 排序内首个命中", () => {
    const fakeHome = path.join(tmpRoot, "fake-home");
    const providerRoot = path.join(fakeHome, ".zcode", "v2", "runtime", "provider");
    const plat = `${process.platform}-test`;
    // 字符串排序会误判 1.9.0 > 1.10.0（'9' > '1'）——本用例钉住 semver 数值比较：
    // 旧版本目录即使有命中文件也必须让位给 1.10.0。
    writeJson(path.join(providerRoot, plat, "1.9.0", "endpoint-a", "zcode-builtin.json"), {});
    // 新版本 endpoint-a 空目录（不命中）→ 落到同版本 endpoint-b。
    fs.mkdirSync(path.join(providerRoot, plat, "1.10.0", "endpoint-a"), { recursive: true });
    const expected = path.join(providerRoot, plat, "1.10.0", "endpoint-b", "zcode-builtin.json");
    writeJson(expected, {});
    // 非本平台前缀目录不参与扫描。
    writeJson(path.join(providerRoot, "otheros-1", "9.9.9", "endpoint-a", "zcode-builtin.json"), {});
    zcHomeRef.current = fakeHome;
    expect(locateZcodeBuiltinCatalog()).toBe(expected);
  });

  it("版本目录被文件占据（readdir ENOTDIR）→ 跳过该版本继续扫后续", () => {
    const fakeHome = path.join(tmpRoot, "fake-home-filever");
    const providerRoot = path.join(fakeHome, ".zcode", "v2", "runtime", "provider");
    const plat = `${process.platform}-test`;
    fs.mkdirSync(path.join(providerRoot, plat), { recursive: true });
    // "2.0.0" 是文件（命中 /^\d+\.\d+/ 名形）→ readdirSync 抛 ENOTDIR → continue。
    fs.writeFileSync(path.join(providerRoot, plat, "2.0.0"), "occupied");
    const expected = path.join(providerRoot, plat, "1.0.0", "endpoint-a", "zcode-builtin.json");
    writeJson(expected, {});
    zcHomeRef.current = fakeHome;
    expect(locateZcodeBuiltinCatalog()).toBe(expected);
  });

  it("provider 根目录缺失 → undefined（reasoningLevel 解析降级为不携带）", () => {
    zcHomeRef.current = path.join(tmpRoot, "empty-home");
    expect(locateZcodeBuiltinCatalog()).toBeUndefined();
  });
});

describe("defaultPersonalProviderConfigPath（缺省源路径）", () => {
  it("= homedir × [.zcode, v2, provider_config.json]", () => {
    expect(defaultPersonalProviderConfigPath()).toBe(
      path.join(os.homedir(), ".zcode", "v2", "provider_config.json"),
    );
  });
});
