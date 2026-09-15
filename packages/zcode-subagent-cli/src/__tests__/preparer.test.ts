// preparer.test.ts —— v2 单源模型解析 / 模型可发现性 / 凭据与模型前置错误。
// 凭据源 = v2 config 单源（2026-08-25 拍板：不读 ~/.zcode/cli/config.json——GUI 不
// 管理该文件，可能残留历史验证配置）。原 HOME 池化面（池目录 SSOT / 原子写 /
// mtime 免重写 / 池 config 无 plugins 块）已随「共享宿主 HOME」重构删除（2026-09：
// app-server 侧凭据经 appserver-launcher fs 拦截注入，不再建池写 config）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { ZcodePrepareError, listZcodeModels, resolveZcodeModelRef } from "../preparer.ts";

let tmpRoot: string;
let v2Path: string;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

const PROVIDER_A = "builtin:bigmodel-coding-plan";
const PROVIDER_B = "e512d53e-test-provider";

function seedSources(): void {
  writeJson(v2Path, {
    provider: {
      [PROVIDER_A]: { options: { apiKey: "key-a", baseURL: "https://a.example" }, models: { "GLM-5.3": {}, "GLM-5.2": {} } },
      [PROVIDER_B]: { name: "test-router", options: { apiKey: "key-b", baseURL: "https://b.example" }, models: { "mimo-v2.5-pro": {} } },
      "no-key-provider": { options: { baseURL: "https://x.example" }, models: { "M1": {} } },
    },
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-preparer-"));
  v2Path = path.join(tmpRoot, "v2-config.json");
  seedSources();
});

describe("resolveZcodeModelRef（v2 单源）", () => {
  it("显式全名解析 + 规范化", () => {
    expect(resolveZcodeModelRef(`${PROVIDER_B}/mimo-v2.5-pro`, { v2ConfigPath: v2Path })).toBe(
      `${PROVIDER_B}/mimo-v2.5-pro`,
    );
  });

  it("短名按默认 provider（builtin:bigmodel-coding-plan）解析", () => {
    expect(resolveZcodeModelRef("GLM-5.3", { v2ConfigPath: v2Path })).toBe(
      `${PROVIDER_A}/GLM-5.3`,
    );
  });

  it("未指定时落官方兜底（不受任何本机 CLI 配置影响）", () => {
    expect(resolveZcodeModelRef(undefined, { v2ConfigPath: v2Path })).toBe(
      `${PROVIDER_A}/GLM-5.3`,
    );
  });

  it("未知模型 → model_not_available（列该 provider 可用模型）", () => {
    try {
      resolveZcodeModelRef(`${PROVIDER_A}/nope`, { v2ConfigPath: v2Path });
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZcodePrepareError);
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("model_not_available");
      expect(e.message).toContain("GLM-5.3, GLM-5.2");
    }
  });

  it("未知 provider → model_not_available（列带凭据 provider）", () => {
    try {
      resolveZcodeModelRef("ghost/m", { v2ConfigPath: v2Path });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("model_not_available");
      expect((err as ZcodePrepareError).message).toContain(PROVIDER_A);
      expect((err as ZcodePrepareError).message).toContain(PROVIDER_B);
    }
  });

  it("provider 存在但无 apiKey → engine_credential_missing", () => {
    try {
      resolveZcodeModelRef("no-key-provider/M1", { v2ConfigPath: v2Path });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("engine_credential_missing");
    }
  });

  it("v2 无任何带 apiKey 的 provider → engine_credential_missing（指向配置说明）", () => {
    writeJson(v2Path, { provider: {} });
    try {
      resolveZcodeModelRef(undefined, { v2ConfigPath: v2Path });
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("engine_credential_missing");
      expect(e.message).toContain("ZCode 桌面端");
      expect(e.message).toContain("docs/research/agent-engine-zcode.md");
    }
  });
});

describe("listZcodeModels（U7 可发现性）", () => {
  it("聚合 v2 带凭据 provider × models（含 name 拼接），无凭据/空清单过滤", () => {
    const models = listZcodeModels({ v2ConfigPath: v2Path });
    const ids = models.map((m) => m.id);
    expect(ids).toContain(`${PROVIDER_A}/GLM-5.3`);
    expect(ids).toContain(`${PROVIDER_A}/GLM-5.2`);
    expect(ids).toContain(`${PROVIDER_B}/mimo-v2.5-pro`);
    // 无凭据 provider 不进清单
    expect(ids.some((id) => id.startsWith("no-key-provider/"))).toBe(false);
    // name = "<provider.name> · <model>"（v2 有 name 字段时）
    const withName = models.find((m) => m.id === `${PROVIDER_B}/mimo-v2.5-pro`);
    expect(withName?.name).toBe("test-router · mimo-v2.5-pro");
  });

  it("v2 不可读 → 空清单（fail-safe）", () => {
    expect(listZcodeModels({ v2ConfigPath: path.join(tmpRoot, "absent.json") })).toEqual([]);
  });
});
