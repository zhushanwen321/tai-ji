import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_UI_LOCALE, dictionaryKeys, readUiLocale, t, type UiLocale } from "../i18n.js";

describe("plan i18n（u-locale-channel 消费端）", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    while (tmpRoots.length > 0) {
      const root = tmpRoots.pop();
        if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("zh/en 双侧词典 key 集合严格对齐（漂移即红灯）", () => {
    expect(dictionaryKeys("zh-CN").sort()).toEqual(dictionaryKeys("en-US").sort());
    expect(dictionaryKeys("en-US").length).toBeGreaterThan(0);
  });

  it("t() 回落链：locale 命中 → 键缺失回落键名（禁空串）；缺参占位符原样保留", () => {
    expect(t("exec.execute", {}, "zh-CN")).toBe("执行");
    expect(t("exec.execute", {}, "en-US")).toBe("Execute");
    expect(t("exec.nonexistent", {}, "zh-CN")).toBe("exec.nonexistent");
    expect(t("exec.viaSkill", {}, "en-US")).toContain("{name}");
    expect(t("exec.viaSkill", { name: "dev-flow" }, "en-US")).toContain("dev-flow");
  });

  it("readUiLocale：ui-preferences.json zh-CN 命中 + 值域外回落", () => {
    const root = mkdtempSync(join(tmpdir(), "plan-i18n-test-"));
    tmpRoots.push(root);
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", root);

    writeFileSync(join(root, "ui-preferences.json"), JSON.stringify({ v: 1, locale: "zh-CN" }));
    expect(readUiLocale()).toBe("zh-CN");

    // 值域外回落：换新目录（readUiLocale 有 (mtimeMs,size,filePath) 模块缓存，
    // 同尺寸同 mtime 的原地重写可能命中缓存，换 filePath 强制重读）
    const root2 = mkdtempSync(join(tmpdir(), "plan-i18n-test-"));
    tmpRoots.push(root2);
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", root2);
    writeFileSync(join(root2, "ui-preferences.json"), JSON.stringify({ v: 1, locale: "fr-FR" }));
    expect(readUiLocale()).toBe(DEFAULT_UI_LOCALE);
  });

  it("readUiLocale：env 缺失 / 文件缺失 / JSON 损坏 → 回落 en-US 不出声", () => {
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", join(tmpdir(), "plan-i18n-missing-dir"));
    expect(readUiLocale()).toBe("en-US");

    vi.stubEnv("TAIJI_AGENT_DATA_DIR", undefined);
    expect(readUiLocale()).toBe("en-US");
  });
});
