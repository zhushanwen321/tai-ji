// src/__tests__/config.test.ts
//
// loadGlobalConfig + readGlobalConfig（三态，设计 D5）测试。
// 配置已退化为仅 maxConcurrent + 引擎路由字段（模型解析改为「主 agent model 优先」，
// 不再有 categories/fallback/yolo/session 级覆盖）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 三态用例需断言 read-failure warn 日志（设计 D5 第 3 态的验收面），
// 用包内测试既有 vi.mock 模式拦 logger（见 epipe-fallback.test.ts 同款）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import {
  DEFAULT_CONFIG,
  getGlobalConfigPath,
  loadGlobalConfig,
  readGlobalConfig,
  type GlobalConfigReadResult,
} from "../assembly/config.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../assembly/model-resolver.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 写入 config.json（自动创建 subagents/ 子目录）。 */
function writeConfig(agentDir: string, content: string): void {
  const configPath = getGlobalConfigPath(agentDir);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, content, "utf-8");
}

// ============================================================
// loadGlobalConfig
// ============================================================

describe("loadGlobalConfig", () => {
  it("returns default config when file does not exist", () => {
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.version).toBe(1);
    expect(cfg.maxConcurrent).toBe(6);
  });

  it("returns default config when JSON is corrupt", () => {
    writeConfig(tmpDir, "{not valid json");
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.version).toBe(1);
    expect(cfg.maxConcurrent).toBe(6);
  });

  it("deep-merges with defaults: missing fields fall back to defaults", () => {
    writeConfig(tmpDir, JSON.stringify({ version: 1 }));
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.version).toBe(1);
    expect(cfg.maxConcurrent).toBe(6);
  });

  it("loads valid config with maxConcurrent override", () => {
    writeConfig(tmpDir, JSON.stringify({ version: 1, maxConcurrent: 8 }));
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.maxConcurrent).toBe(8);
  });

  it("ignores legacy categories/fallback/yoloByDefault fields (model resolution deprecated)", () => {
    // 旧 config.json 仍可能含这些字段——读取时不报错，但 SubagentsGlobalConfig
    // 类型上已不含它们，loadGlobalConfig 只取 version + maxConcurrent。
    writeConfig(
      tmpDir,
      JSON.stringify({
        version: 1,
        maxConcurrent: 6,
        yoloByDefault: true,
        categories: { coding: { label: "C", model: "x/y" } },
        fallback: { model: "anthropic/x" },
      }),
    );
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.maxConcurrent).toBe(6);
    expect(cfg.version).toBe(1);
    // 仅两个字段（类型保证）
    expect(Object.keys(cfg).sort()).toEqual(["maxConcurrent", "version"]);
  });
});

// ============================================================
// sanitizeMaxConcurrent（经 loadGlobalConfig 间接覆盖）
// ============================================================

describe("sanitizeMaxConcurrent (via loadGlobalConfig)", () => {
  it("rejects non-number maxConcurrent → default", () => {
    writeConfig(tmpDir, JSON.stringify({ maxConcurrent: "eight" }));
    expect(loadGlobalConfig(tmpDir).maxConcurrent).toBe(6);
  });

  it("rejects non-integer maxConcurrent → default", () => {
    writeConfig(tmpDir, JSON.stringify({ maxConcurrent: 4.5 }));
    expect(loadGlobalConfig(tmpDir).maxConcurrent).toBe(6);
  });

  it("rejects zero/negative maxConcurrent → default", () => {
    writeConfig(tmpDir, JSON.stringify({ maxConcurrent: 0 }));
    expect(loadGlobalConfig(tmpDir).maxConcurrent).toBe(6);
    writeConfig(tmpDir, JSON.stringify({ maxConcurrent: -1 }));
    expect(loadGlobalConfig(tmpDir).maxConcurrent).toBe(6);
  });

  it("accepts positive integer", () => {
    writeConfig(tmpDir, JSON.stringify({ maxConcurrent: 16 }));
    expect(loadGlobalConfig(tmpDir).maxConcurrent).toBe(16);
  });
});

// ============================================================
// readGlobalConfig 三态（设计 D5：明确值 / 明确缺省 / 读失败）
// ============================================================

describe("readGlobalConfig 三态（设计 D5）", () => {
  beforeEach(() => {
    loggerMock.warn.mockClear();
  });

  it("明确缺省：文件不存在（ENOENT）→ absent 态 + 缺省配置，非失败、无 warn", () => {
    const result = readGlobalConfig(tmpDir);
    expect(result.status).toBe("absent");
    if (result.status !== "absent") return; // 判别联合收窄（运行时 guard）
    expect(result.config).toEqual({ ...DEFAULT_CONFIG });
    // 缺省态是用户意图（删配置切回缺省 pi），不是故障——不落 warn
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("明确值：合法 JSON 透传 defaultEngine 与 engineRouting（sanitize 后）", () => {
    writeConfig(
      tmpDir,
      JSON.stringify({ version: 1, maxConcurrent: 8, defaultEngine: "zcode", engineRouting: { strict: true } }),
    );
    const result = readGlobalConfig(tmpDir);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.config.defaultEngine).toBe("zcode");
    expect(result.config.engineRouting).toEqual({ strict: true });
    expect(result.config.maxConcurrent).toBe(8);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("明确值：defaultEngine 坏值被 sanitize 剔除（undefined，缺省语义留给路由层）", () => {
    writeConfig(tmpDir, JSON.stringify({ version: 1, defaultEngine: "   " }));
    const result = readGlobalConfig(tmpDir);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.config.defaultEngine).toBeUndefined();
  });

  it("读失败：坏 JSON → failed 态 + 携带原因 + warn 恰一次（含路径）", () => {
    writeConfig(tmpDir, "{not valid json");
    const result = readGlobalConfig(tmpDir);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).not.toBe("");
    // read-failure warn 日志是 D5 第 3 态的验收面（现状 loadGlobalConfig catch 静默）
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const warnMsg = String(loggerMock.warn.mock.calls[0]?.[0]);
    expect(warnMsg).toContain(getGlobalConfigPath(tmpDir));
  });

  it("读失败：config.json 位置是目录（EISDIR，非 ENOENT）→ failed 态", () => {
    fs.mkdirSync(getGlobalConfigPath(tmpDir), { recursive: true });
    const result = readGlobalConfig(tmpDir);
    expect(result.status).toBe("failed");
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it("loadGlobalConfig 既有行为不回归：ENOENT 与坏 JSON 同归默认配置（静默回落形态保持）", () => {
    expect(loadGlobalConfig(tmpDir)).toEqual({ ...DEFAULT_CONFIG });
    writeConfig(tmpDir, "{not valid json");
    expect(loadGlobalConfig(tmpDir)).toEqual({ ...DEFAULT_CONFIG });
  });
});

// ============================================================
// ModelConfigService.reloadGlobalConfig（设计 D2：从 initModel 提取）
// ============================================================

function makeModel(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: over.id ?? "GLM-5.3",
    name: over.name ?? "GLM 5.3",
    provider: over.provider ?? "zai-coding-cn",
    reasoning: over.reasoning ?? false,
  };
}

function makeRegistry(models: ModelInfo[]): ModelRegistryLike {
  return {
    getAvailable: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: () => true,
  };
}

describe("ModelConfigService.reloadGlobalConfig（设计 D2）", () => {
  it("重载生效：写新 maxConcurrent 后 reload，getGlobalConfig 反映新值", () => {
    const service = new ModelConfigService({ agentDir: tmpDir, cwd: tmpDir });
    service.initModel({
      modelRegistry: makeRegistry([makeModel()]),
      sessionId: "s1",
    });
    writeConfig(tmpDir, JSON.stringify({ version: 1, maxConcurrent: 9 }));
    service.reloadGlobalConfig();
    expect(service.getGlobalConfig().maxConcurrent).toBe(9);
  });

  it("幂等可重入：连续两次 reload 结果一致且不抛错", () => {
    const service = new ModelConfigService({ agentDir: tmpDir, cwd: tmpDir });
    writeConfig(tmpDir, JSON.stringify({ version: 1, maxConcurrent: 9 }));
    service.reloadGlobalConfig();
    service.reloadGlobalConfig();
    expect(service.getGlobalConfig().maxConcurrent).toBe(9);
  });

  it("initModel 行为零变化：内部走 reloadGlobalConfig，注入的 modelRegistry 可用", () => {
    const service = new ModelConfigService({ agentDir: tmpDir, cwd: tmpDir });
    writeConfig(tmpDir, JSON.stringify({ version: 1, maxConcurrent: 9, defaultEngine: "zcode" }));
    service.initModel({
      modelRegistry: makeRegistry([makeModel()]),
      sessionId: "s1",
    });
    // initModel 首步重载配置 → 构造后写入的 config 值在 initModel 后可见
    expect(service.getGlobalConfig().maxConcurrent).toBe(9);
    expect(service.getGlobalConfig().defaultEngine).toBe("zcode");
    expect(() => service.getModelRegistry()).not.toThrow();
  });

  it("三态返回：文件存在 → ok 且返回值含文件值；文件删除 → absent 且缓存变缺省", () => {
    const service = new ModelConfigService({ agentDir: tmpDir, cwd: tmpDir });
    writeConfig(tmpDir, JSON.stringify({ version: 1, maxConcurrent: 9, defaultEngine: "zcode" }));
    const okResult = service.reloadGlobalConfig();
    expect(okResult.status).toBe("ok");
    if (okResult.status !== "ok") return; // 判别联合收窄（运行时 guard）
    expect(okResult.config.maxConcurrent).toBe(9);
    expect(service.getGlobalConfig().defaultEngine).toBe("zcode");

    fs.rmSync(getGlobalConfigPath(tmpDir));
    const absentResult = service.reloadGlobalConfig();
    expect(absentResult.status).toBe("absent");
    // absent = 用户删配置切回缺省（合法意图）：缓存覆盖为缺省，不当作故障保持
    expect(service.getGlobalConfig()).toEqual({ ...DEFAULT_CONFIG });
  });

  it("failed 保持缓存：坏 JSON 重读返回 failed 且缓存保持上次值，不被打回缺省", () => {
    const service = new ModelConfigService({ agentDir: tmpDir, cwd: tmpDir });
    writeConfig(tmpDir, JSON.stringify({ version: 1, maxConcurrent: 9, defaultEngine: "zcode" }));
    service.reloadGlobalConfig();
    writeConfig(tmpDir, "{not valid json");
    const result = service.reloadGlobalConfig();
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).not.toBe("");
    // 旧缺陷回归锁定：旧实现用静默 loadGlobalConfig，读失败把好缓存打回 DEFAULT_CONFIG
    expect(service.getGlobalConfig().maxConcurrent).toBe(9);
    expect(service.getGlobalConfig().defaultEngine).toBe("zcode");
  });

  it("applyGlobalConfig：ok/absent 覆盖缓存、failed 保持，返回值 === 入参（纯赋值幂等）", () => {
    const service = new ModelConfigService({ agentDir: tmpDir, cwd: tmpDir });
    // 手工构造 read 结果（绕过读取层 sanitize）：锁定「提交什么缓存什么」的纯赋值语义
    const okRead: GlobalConfigReadResult = {
      status: "ok",
      config: { version: 1, maxConcurrent: 7, defaultEngine: "zcode" },
    };
    expect(service.applyGlobalConfig(okRead)).toBe(okRead);
    expect(service.getGlobalConfig().maxConcurrent).toBe(7);
    expect(service.getGlobalConfig().defaultEngine).toBe("zcode");

    const absentRead: GlobalConfigReadResult = {
      status: "absent",
      config: { version: 1, maxConcurrent: 5 },
    };
    expect(service.applyGlobalConfig(absentRead)).toBe(absentRead);
    expect(service.getGlobalConfig().maxConcurrent).toBe(5);
    expect(service.getGlobalConfig().defaultEngine).toBeUndefined();

    // failed 保持：缓存停在最近一次成功提交的值
    const failedRead: GlobalConfigReadResult = { status: "failed", reason: "EACCES" };
    expect(service.applyGlobalConfig(failedRead)).toBe(failedRead);
    expect(service.getGlobalConfig().maxConcurrent).toBe(5);
    expect(service.getGlobalConfig().defaultEngine).toBeUndefined();
  });
});
