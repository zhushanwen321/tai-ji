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
  piSyncedProviderConfigPath,
  resolvePersonalProviderConfigPath,
  resolveZcodeMinimalReasoningLevel,
  resolveZcodeModelRef,
  resolveZcodeReasoningValues,
  translatePiModelRefToZcode,
} from "../preparer.ts";

/** 副本语境恢复指引句（§5 单元 3 文案修复——四处 throw 公共尾句的断言锚点）。 */
const TAIJI_GUIDANCE = "若使用 taiji 同步副本/默认模型，到 taiji settings 核对或重选，重启 taiji 生效。";

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
      expect(e.message).toContain(TAIJI_GUIDANCE);
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
      expect((err as ZcodePrepareError).message).toContain(TAIJI_GUIDANCE);
    }
  });

  it("provider 存在但无 apiKey → engine_credential_missing", () => {
    try {
      resolveZcodeModelRef("no-key-provider/M1", { personalProviderConfigPath: personalPath });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("engine_credential_missing");
      expect((err as ZcodePrepareError).message).toContain(TAIJI_GUIDANCE);
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
      expect((err as ZcodePrepareError).message).toContain(TAIJI_GUIDANCE);
    }
  });
});

// ── 默认解析链（engine-provider-unification D3 换轨：副本存在→读 merge(真实,副本)
// 视图，缺失→回落真实文件直读；路径函数仍按三态链返回单路径供 env 赋值）──
// env 全局污染防护：本 describe 用例独占 TAIJI_AGENT_DATA_DIR 的 save/set/restore
//（防线 global-setup 会把它钉死 tmp 树，这里指向本用例自建 dataDir）；homedir 经
// zcHomeRef 指向 tmp 树内的 fakeHome——真实文件与副本都写在 tmp 内，零触碰真实目录。
const DATA_DIR_ENV_KEY = "TAIJI_AGENT_DATA_DIR";
const COPY_PROVIDER = "33333333-cccc-4000-8000-000000000003";

describe("resolvePersonalProviderConfigPath（默认解析链：显式 sources > 副本存在 > 真实文件）", () => {
  let savedDataDirEnv: string | undefined;
  let dataDir: string;
  let realPath: string;

  beforeEach(() => {
    savedDataDirEnv = process.env[DATA_DIR_ENV_KEY];
    dataDir = path.join(tmpRoot, "chain-data");
    const fakeHome = path.join(tmpRoot, "chain-home");
    realPath = path.join(fakeHome, ".zcode", "v2", "provider_config.json");
    zcHomeRef.current = fakeHome;
    // 真实文件只含 PROVIDER_A（与副本/显式源内容互异——三者可区分）
    writeJson(realPath, {
      schemaVersion: 1,
      config: {
        providerOrder: [PROVIDER_A],
        providerConfigRules: {
          providerRules: [
            {
              providerId: PROVIDER_A,
              providerName: "provider-a",
              config: { access: { type: "api-key", apiKey: "key-a" }, personalModelIds: ["GLM-5.3"] },
            },
          ],
        },
      },
    });
  });

  afterEach(() => {
    if (savedDataDirEnv === undefined) {
      delete process.env[DATA_DIR_ENV_KEY];
    } else {
      process.env[DATA_DIR_ENV_KEY] = savedDataDirEnv;
    }
    zcHomeRef.current = undefined;
  });

  function writeCopy(dir: string, order: string[] = [COPY_PROVIDER]): string {
    const copyPath = piSyncedProviderConfigPath(dir);
    writeJson(copyPath, {
      schemaVersion: 1,
      config: {
        providerOrder: order,
        providerConfigRules: {
          providerRules: [
            {
              providerId: COPY_PROVIDER,
              providerName: "copy-only",
              config: { access: { type: "api-key", apiKey: "key-c" }, personalModelIds: ["copy-model-x"] },
            },
          ],
        },
      },
    });
    return copyPath;
  }

  it("副本存在 → 读 merge 视图（真实 ∪ 副本；路径函数仍锚定副本路径供 env 赋值）", () => {
    process.env[DATA_DIR_ENV_KEY] = dataDir;
    const copyPath = writeCopy(dataDir);
    expect(resolvePersonalProviderConfigPath()).toBe(copyPath);
    // 副本独有条目可见（merge 追加面）。用全名 ref：短名按合并序首位（真实侧
    // PROVIDER_A）解析，不再落副本——「副本遮蔽真实」的旧短名语义已随 merge 退役
    expect(resolveZcodeModelRef(`${COPY_PROVIDER}/copy-model-x`)).toBe(`${COPY_PROVIDER}/copy-model-x`);
    // 真实文件条目同样可见——D3 换轨核心：校验链与 Registry 读同一 merge 视图，
    // 「读源 = 副本整体遮蔽真实」的旧语义已退役
    expect(resolveZcodeModelRef("GLM-5.3")).toBe(`${PROVIDER_A}/GLM-5.3`);
    // 清单聚合 = merge 视图全体（真实条目整条保留在前 → PROVIDER_A 先于副本条目）
    expect(listZcodeModels().map((m) => m.id)).toEqual([
      `${PROVIDER_A}/GLM-5.3`,
      `${COPY_PROVIDER}/copy-model-x`,
    ]);
  });

  it("同名 id 冲突 → 真实整条保留（副本同 id 条目让位——运行时第二道防线）", () => {
    process.env[DATA_DIR_ENV_KEY] = dataDir;
    const copyPath = piSyncedProviderConfigPath(dataDir);
    writeJson(copyPath, {
      schemaVersion: 1,
      config: {
        providerOrder: [PROVIDER_A, COPY_PROVIDER],
        providerConfigRules: {
          providerRules: [
            {
              // 与真实文件同 id：key 与模型清单都不同——merge 后真实条目胜出
              providerId: PROVIDER_A,
              providerName: "copy-shadow",
              config: { access: { type: "api-key", apiKey: "key-copy-a" }, personalModelIds: ["copy-only-model"] },
            },
            {
              providerId: COPY_PROVIDER,
              providerName: "copy-only",
              config: { access: { type: "api-key", apiKey: "key-c" }, personalModelIds: ["copy-model-x"] },
            },
          ],
        },
      },
    });
    // 真实侧模型可见（真实条目整条保留）
    expect(resolveZcodeModelRef(`${PROVIDER_A}/GLM-5.3`)).toBe(`${PROVIDER_A}/GLM-5.3`);
    // 副本侧同 id 条目的独有模型不可见（模型清单也是真实侧的）
    expect(() => resolveZcodeModelRef(`${PROVIDER_A}/copy-only-model`)).toThrowError(/未知模型/);
  });

  it("order 合并 = 真实现值序前缀 + 副本独有追加（去重保序）——短名默认 provider 取合并序首位", () => {
    process.env[DATA_DIR_ENV_KEY] = dataDir;
    // 副本 order 把 COPY_PROVIDER 排前：若读副本整体，短名会先落到 COPY_PROVIDER；
    // merge 后序 = [PROVIDER_A(真实), COPY_PROVIDER] → 短名仍落 PROVIDER_A
    writeCopy(dataDir, [COPY_PROVIDER, PROVIDER_A]);
    expect(resolveZcodeModelRef("GLM-5.3")).toBe(`${PROVIDER_A}/GLM-5.3`);
  });

  it("真实文件缺失 → 副本独有条目为全集（merge 输出 = 副本整体，真实侧条目不残留）", () => {
    process.env[DATA_DIR_ENV_KEY] = dataDir;
    fs.rmSync(realPath);
    writeCopy(dataDir);
    expect(resolveZcodeModelRef("copy-model-x")).toBe(`${COPY_PROVIDER}/copy-model-x`);
    expect(listZcodeModels().map((m) => m.id)).toEqual([`${COPY_PROVIDER}/copy-model-x`]);
    // 真实侧条目随真实文件缺席而消失
    expect(() => resolveZcodeModelRef("GLM-5.3")).toThrowError(/未知模型/);
  });

  it("真实文件损坏 → 同真实缺失语义（副本独有条目为全集）", () => {
    process.env[DATA_DIR_ENV_KEY] = dataDir;
    fs.writeFileSync(realPath, "{broken-json");
    writeCopy(dataDir);
    expect(resolveZcodeModelRef("copy-model-x")).toBe(`${COPY_PROVIDER}/copy-model-x`);
  });

  it("merge 视图激活时凭据缺失报错的已读源 = merge(真实 + 副本) 双路径（诊断面锚点）", () => {
    process.env[DATA_DIR_ENV_KEY] = dataDir;
    writeJson(realPath, { schemaVersion: 1, config: { providerOrder: [], providerConfigRules: { providerRules: [] } } });
    const copyPath = piSyncedProviderConfigPath(dataDir);
    writeJson(copyPath, {
      schemaVersion: 1,
      config: {
        providerOrder: ["no-key"],
        providerConfigRules: {
          providerRules: [{ providerId: "no-key", config: { access: { type: "api-key" }, personalModelIds: ["m"] } }],
        },
      },
    });
    try {
      resolveZcodeModelRef(undefined);
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("engine_credential_missing");
      expect((err as ZcodePrepareError).message).toContain("merge(真实 ");
      expect((err as ZcodePrepareError).message).toContain(copyPath);
    }
  });

  it("副本缺失（env 指向的 dataDir 下无副本文件）→ 回落真实文件", () => {
    process.env[DATA_DIR_ENV_KEY] = dataDir;
    expect(resolvePersonalProviderConfigPath()).toBe(realPath);
    expect(resolveZcodeModelRef("GLM-5.3")).toBe(`${PROVIDER_A}/GLM-5.3`);
  });

  it("env 缺席（standalone 裸跑形态）→ 副本无定位点，回落真实文件", () => {
    delete process.env[DATA_DIR_ENV_KEY];
    expect(resolvePersonalProviderConfigPath()).toBe(realPath);
  });

  it("显式 sources.personalProviderConfigPath → 绕过副本与回落直读指定路径", () => {
    process.env[DATA_DIR_ENV_KEY] = dataDir;
    writeCopy(dataDir); // 副本在也压不过显式定型
    expect(resolvePersonalProviderConfigPath({ personalProviderConfigPath: personalPath })).toBe(personalPath);
  });

  it("engineDataDir 入参优先于 env 推导（zcode-engine deps 注入形态）", () => {
    process.env[DATA_DIR_ENV_KEY] = dataDir; // env 指向的 dataDir 无副本
    const otherDir = path.join(tmpRoot, "chain-data-alt");
    const copyPath = writeCopy(otherDir);
    expect(resolvePersonalProviderConfigPath(undefined, otherDir)).toBe(copyPath);
  });
});

describe("listZcodeModels（U7 可发现性）", () => {
  it("带凭据 provider × 模型清单（无凭据者排除；name = provider 名 · 模型；account 直通家族追加）", () => {
    const catalogPath = path.join(tmpRoot, "list-account-catalog.json");
    writeJson(catalogPath, {
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "account:bigmodel-individual-coding-plan",
              providerName: "BigModel Individual Coding Plan",
              config: { builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"] },
            },
          ],
        },
      },
    });
    const models = listZcodeModels({ personalProviderConfigPath: personalPath, builtinCatalogPath: catalogPath });
    expect(models.map((m) => m.id)).toEqual([
      `${PROVIDER_A}/GLM-5.3`,
      `${PROVIDER_A}/GLM-5.3-Flash`,
      `${PROVIDER_A}/GLM-5.2`,
      `${PROVIDER_B}/mimo-v2.6-pro`,
      "account:bigmodel-individual-coding-plan/GLM-5.3",
      "account:bigmodel-individual-coding-plan/GLM-5.3-Flash",
    ]);
    expect(models[0]?.name).toBe("provider-a · GLM-5.3");
    expect(models[4]?.name).toBe("BigModel Individual Coding Plan · GLM-5.3");
  });

  it("源缺失 → 空清单（失败安全；目录缺失同空）", () => {
    expect(
      listZcodeModels({
        personalProviderConfigPath: path.join(tmpRoot, "absent.json"),
        builtinCatalogPath: path.join(tmpRoot, "absent-catalog.json"),
      }),
    ).toEqual([]);
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

describe("resolveZcodeReasoningValues（目录值域全量）", () => {
  let catalogPath: string;

  beforeEach(() => {
    catalogPath = path.join(tmpRoot, "values-catalog.json");
    // 目录规则小写词干 × 模型 id 包侧大小写——不敏感匹配对齐 app-server 注册表
    writeJson(catalogPath, {
      config: {
        modelConfigRules: {
          modelRules: [
            { modelMatch: ".*", config: { optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } } },
            { modelMatch: ".*glm-5\\.3-flash(?:[.\\-:/\\[].*)?", config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } } },
            { modelMatch: ".*no-values.*", config: { optionSpecs: { maxOutputTokens: { max: 1 } } } },
          ],
        },
      },
    });
  });

  it("命中规则 → 值域全量（非只首值）；大小写不敏感（目录小写词干 × 包侧大小写 id）", () => {
    const sources = { builtinCatalogPath: catalogPath };
    expect(resolveZcodeReasoningValues(`${PROVIDER_A}/GLM-5.3-Flash`, sources)).toEqual(["low", "high", "max"]);
    expect(resolveZcodeReasoningValues(`${PROVIDER_B}/mimo-v2.6-pro`, sources)).toEqual(["disabled", "enabled"]);
    // 命中但无值域的规则不参与 → 落回通配规则值域（与 minimal 版同语义，全量口径）
    expect(resolveZcodeReasoningValues(`${PROVIDER_B}/no-values-x`, sources)).toEqual(["disabled", "enabled"]);
  });

  it("目录缺失 / JSON 损坏 / 无 modelConfigRules / modelRules 非数组 → undefined", () => {
    expect(resolveZcodeReasoningValues(`${PROVIDER_A}/m1`, { builtinCatalogPath: path.join(tmpRoot, "absent.json") })).toBeUndefined();
    const broken = path.join(tmpRoot, "broken-catalog.json");
    fs.writeFileSync(broken, "{not json");
    expect(resolveZcodeReasoningValues(`${PROVIDER_A}/m1`, { builtinCatalogPath: broken })).toBeUndefined();
    const noRules = path.join(tmpRoot, "no-rules-catalog.json");
    writeJson(noRules, { config: {} });
    expect(resolveZcodeReasoningValues(`${PROVIDER_A}/m1`, { builtinCatalogPath: noRules })).toBeUndefined();
    const badRules = path.join(tmpRoot, "bad-rules-catalog.json");
    writeJson(badRules, { config: { modelConfigRules: { modelRules: "nope" } } });
    expect(resolveZcodeReasoningValues(`${PROVIDER_A}/m1`, { builtinCatalogPath: badRules })).toBeUndefined();
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

// ── account 家族直通（2026-10-13 用户裁决）：account 凭据由 zcode CLI 账号体系
// 自解析，不经个人 provider 表——校验降为目录存在性：规则存在 + 模型在清单内 →
// 原样放行（大小写保留）。env 全局污染防护同 locate describe：独占
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 的 save/delete/restore + zcHomeRef 归位。
describe("resolveZcodeModelRef account 家族直通", () => {
  const ACCOUNT_PROVIDER = "account:zai-individual-coding-plan";
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

  function accountSources(catalogPath?: string): { personalProviderConfigPath: string; builtinCatalogPath?: string } {
    return { personalProviderConfigPath: personalPath, ...(catalogPath !== undefined ? { builtinCatalogPath: catalogPath } : {}) };
  }

  /** 写一个 account 目录（providerRules 单规则形态；name 区分用例文件）。 */
  function writeAccountCatalog(name: string, rules: Array<Record<string, unknown>>): string {
    const catalogPath = path.join(tmpRoot, name);
    writeJson(catalogPath, { config: { providerConfigRules: { providerRules: rules } } });
    return catalogPath;
  }

  it("模型在 builtinModelIds 内 → 原样放行（account id 不在个人 provider 表也可用；大小写保留）", () => {
    const catalogPath = writeAccountCatalog("account-catalog.json", [
      { providerId: ACCOUNT_PROVIDER, config: { builtinModelIds: ["GLM-5.3-Flash", "GLM-5.3"] } },
    ]);
    expect(resolveZcodeModelRef(`${ACCOUNT_PROVIDER}/GLM-5.3-Flash`, accountSources(catalogPath))).toBe(
      `${ACCOUNT_PROVIDER}/GLM-5.3-Flash`,
    );
  });

  it("builtinModelIds 缺席 → personalModelIds 兜底判清单", () => {
    const catalogPath = writeAccountCatalog("account-personal-ids-catalog.json", [
      { providerId: ACCOUNT_PROVIDER, config: { personalModelIds: ["M2-Plan"] } },
    ]);
    expect(resolveZcodeModelRef(`${ACCOUNT_PROVIDER}/M2-Plan`, accountSources(catalogPath))).toBe(
      `${ACCOUNT_PROVIDER}/M2-Plan`,
    );
  });

  it("模型不在清单 → model_not_available（列该 account provider 可用模型）", () => {
    const catalogPath = writeAccountCatalog("account-miss-model-catalog.json", [
      { providerId: ACCOUNT_PROVIDER, config: { builtinModelIds: ["GLM-5.3-Flash"] } },
    ]);
    try {
      resolveZcodeModelRef(`${ACCOUNT_PROVIDER}/nope`, accountSources(catalogPath));
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZcodePrepareError);
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("model_not_available");
      expect(e.message).toContain("未知模型");
      expect(e.message).toContain("GLM-5.3-Flash");
    }
  });

  it("清单为空数组 → 不设限放行（目录未枚举模型交注册表实况裁决）", () => {
    const catalogPath = writeAccountCatalog("account-empty-list-catalog.json", [
      { providerId: ACCOUNT_PROVIDER, config: { builtinModelIds: [] } },
    ]);
    expect(resolveZcodeModelRef(`${ACCOUNT_PROVIDER}/Anything-Model`, accountSources(catalogPath))).toBe(
      `${ACCOUNT_PROVIDER}/Anything-Model`,
    );
  });

  it("目录无此 account 规则 → model_not_available（含可用规则指引）", () => {
    const catalogPath = writeAccountCatalog("account-other-rule-catalog.json", [
      { providerId: "account:other-plan", config: { builtinModelIds: ["M1"] } },
    ]);
    try {
      resolveZcodeModelRef(`${ACCOUNT_PROVIDER}/GLM-5.3-Flash`, accountSources(catalogPath));
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("model_not_available");
      expect(e.message).toContain("未知 account provider");
    }
  });

  it("目录不可读（JSON 损坏）→ model_not_available（内建目录不可读）", () => {
    const catalogPath = path.join(tmpRoot, "account-broken-catalog.json");
    fs.writeFileSync(catalogPath, "{broken json");
    try {
      resolveZcodeModelRef(`${ACCOUNT_PROVIDER}/GLM-5.3-Flash`, accountSources(catalogPath));
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("model_not_available");
      expect(e.message).toContain("内建目录不可读");
    }
  });

  it("目录定位失败（无显式源 + env 未注入 + home 扫描不命中）→ model_not_available（内建目录定位失败）", () => {
    zcHomeRef.current = path.join(tmpRoot, "empty-home");
    try {
      resolveZcodeModelRef(`${ACCOUNT_PROVIDER}/GLM-5.3-Flash`, accountSources());
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("model_not_available");
      expect(e.message).toContain("内建目录定位失败");
    }
  });

  it("个人 provider 全空（无凭据）→ account ref 仍可派发（account 分支先于 withKey 检查，直通语义）", () => {
    writeJson(personalPath, { schemaVersion: 1, config: { providerOrder: [], providerConfigRules: { providerRules: [] } } });
    const catalogPath = writeAccountCatalog("account-empty-personal-catalog.json", [
      { providerId: "account:bigmodel-individual-coding-plan", config: { builtinModelIds: ["GLM-5.3-Flash"] } },
    ]);
    expect(
      resolveZcodeModelRef("account:bigmodel-individual-coding-plan/GLM-5.3-Flash", accountSources(catalogPath)),
    ).toBe("account:bigmodel-individual-coding-plan/GLM-5.3-Flash");
  });

  it("翻译通道：zai-coding-cn/* 显式派发经翻译落 account 直通（pi 词汇不进个人表校验）", () => {
    const catalogPath = writeAccountCatalog("account-translate-catalog.json", [
      { providerId: "account:bigmodel-individual-coding-plan", config: { builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"] } },
    ]);
    expect(resolveZcodeModelRef("zai-coding-cn/glm-5.3-flash", accountSources(catalogPath))).toBe(
      "account:bigmodel-individual-coding-plan/GLM-5.3-Flash",
    );
  });
});

// ── 派发期模型 ref 翻译（engine-ref-translation D1，2026-10-14 用户裁决）：
// zai-coding-cn ↔ account:bigmodel-individual-coding-plan 等价对，其余 1:1 原样。
describe("translatePiModelRefToZcode", () => {
  const TARGET = "account:bigmodel-individual-coding-plan";

  function catalogWith(models: string[], providerId = TARGET): string {
    const p = path.join(tmpRoot, `translate-catalog-${providerId.replace(/[^a-z]/g, "")}-${models.length}.json`);
    writeJson(p, {
      config: {
        providerConfigRules: {
          providerRules: [{ providerId, providerName: "BigModel Individual Coding Plan", config: { builtinModelIds: models } }],
        },
      },
    });
    return p;
  }

  it("zai-coding-cn/* → account:bigmodel-individual-coding-plan/*（模型段大小写归一，返回目录原生拼写）", () => {
    const catalog = catalogWith(["GLM-5.3", "GLM-5.3-Flash"]);
    expect(translatePiModelRefToZcode("zai-coding-cn/glm-5.3-flash", { builtinCatalogPath: catalog })).toBe(
      `${TARGET}/GLM-5.3-Flash`,
    );
    expect(translatePiModelRefToZcode("zai-coding-cn/glm-5.3", { builtinCatalogPath: catalog })).toBe(`${TARGET}/GLM-5.3`);
  });

  it("幂等：翻译产物（account ref）再入恒等；个人 id 与裸 id 原样透传（1:1 通道不翻译）", () => {
    const catalog = catalogWith(["GLM-5.3-Flash"]);
    expect(translatePiModelRefToZcode(`${TARGET}/GLM-5.3-Flash`, { builtinCatalogPath: catalog })).toBe(`${TARGET}/GLM-5.3-Flash`);
    expect(
      translatePiModelRefToZcode("xiaomi-token-plan-cn/mimo-v2.6-flash", { builtinCatalogPath: catalog }),
    ).toBe("xiaomi-token-plan-cn/mimo-v2.6-flash");
    expect(translatePiModelRefToZcode("GLM-5.3", { builtinCatalogPath: catalog })).toBe("GLM-5.3");
  });

  it("模型无等价 → model_not_available（列目标通道可用清单）", () => {
    const catalog = catalogWith(["GLM-5.3", "GLM-5.3-Flash"]);
    try {
      translatePiModelRefToZcode("zai-coding-cn/glm-4.6v", { builtinCatalogPath: catalog });
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("model_not_available");
      expect(e.message).toContain("glm-4.6v");
      expect(e.message).toContain("GLM-5.3-Flash");
    }
  });

  it("目标规则缺失 → model_not_available（ZCode 桌面端配置指引）", () => {
    const catalog = catalogWith(["GLM-5.3"], "account:other-plan");
    try {
      translatePiModelRefToZcode("zai-coding-cn/glm-5.3", { builtinCatalogPath: catalog });
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("model_not_available");
      expect(e.message).toContain("ZCode 桌面端");
    }
  });

  it("目录不可读/定位失败 → model_not_available（翻译不可达显式失败，不静默回落）", () => {
    try {
      translatePiModelRefToZcode("zai-coding-cn/glm-5.3", { builtinCatalogPath: path.join(tmpRoot, "absent-translate-catalog.json") });
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("model_not_available");
      expect(e.message).toContain("翻译失败");
    }
  });

  it("目标清单为空数组 → 请求拼写直传（不设限，交注册表实况裁决）", () => {
    const catalog = catalogWith([]);
    expect(translatePiModelRefToZcode("zai-coding-cn/glm-5.3", { builtinCatalogPath: catalog })).toBe(`${TARGET}/glm-5.3`);
  });
});

describe("defaultPersonalProviderConfigPath（缺省源路径）", () => {
  it("= homedir × [.zcode, v2, provider_config.json]", () => {
    expect(defaultPersonalProviderConfigPath()).toBe(
      path.join(os.homedir(), ".zcode", "v2", "provider_config.json"),
    );
  });
});
