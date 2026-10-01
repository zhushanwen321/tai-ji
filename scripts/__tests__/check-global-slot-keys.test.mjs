// scripts/__tests__/check-global-slot-keys.test.mjs
//
// C-state-20 守卫（scripts/check-global-slot-keys.mjs）的 fixture 单测：声明文件外的
// 字面量必红 / 前缀越界必红 / 跨文件重复键必红 / 合规树绿——四态覆盖「守卫恒绿」与
// 「误伤声明文件」两侧退化。fixture 全在 tmpdir（禁触真实仓库）。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-global-slot-keys.mjs");
const CORE_SLOTS = "packages/subagent-core/src/shared/global-slots.ts";
const SDK_SLOTS = "packages/subagent-engine-sdk/src/global-slots.ts";

const tempDirs = [];
function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), "slot-keys-guard-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}
function run(root) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], { cwd: REPO_ROOT, encoding: "utf8" });
}

const CORE_OK = `export const GLOBAL_SLOT_KEYS = {\n  engineRegistry: "@zhushanwen/subagent-core.engineRegistry",\n} as const;\n`;
const SDK_OK = `export const ENGINE_SDK_SLOT_KEYS = {\n  loggerSink: "@zhushanwen/subagent-engine-sdk.logger-sink",\n} as const;\n`;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("check-global-slot-keys", () => {
  it("合规树 → exit 0，键计数正确", () => {
    const root = makeTree({
      [CORE_SLOTS]: CORE_OK,
      [SDK_SLOTS]: SDK_OK,
      "packages/subagent-core/src/consumer.ts": 'import { GLOBAL_SLOT_KEYS } from "./shared/global-slots.ts";\nconst k = Symbol.for(GLOBAL_SLOT_KEYS.engineRegistry);\nexport { k };\n',
    });
    const res = run(root);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("2 个槽键");
  });

  it("声明文件外出现 Symbol.for 字面量 → exit 1", () => {
    const root = makeTree({
      [CORE_SLOTS]: CORE_OK,
      "extensions/universal/subagent-workflow/src/rogue.ts": 'const k = Symbol.for("@zhushanwen/pi-subagents.dialogQueue");\nexport { k };\n',
    });
    const res = run(root);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("散落在声明文件之外");
  });

  it("声明文件内前缀越界 → exit 1", () => {
    const root = makeTree({
      [CORE_SLOTS]: 'export const GLOBAL_SLOT_KEYS = {\n  wrong: "@zhushanwen/pi-subagents.wrong",\n} as const;\n',
    });
    const res = run(root);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("前缀越界");
  });

  it("跨声明文件重复键 → exit 1", () => {
    const root = makeTree({
      [CORE_SLOTS]: CORE_OK,
      [SDK_SLOTS]: 'export const ENGINE_SDK_SLOT_KEYS = {\n  dup: "@zhushanwen/subagent-core.engineRegistry",\n} as const;\n',
    });
    const res = run(root);
    // 前缀越界 + 重复两条都应报出（重复判定依赖首个声明文件已被登记）
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("前缀越界");
  });

  it("注释中的示例字面量不误伤", () => {
    const root = makeTree({
      [CORE_SLOTS]: `// 机制：globalThis[Symbol.for("@zhushanwen/example.x")]\n${CORE_OK}`,
      [SDK_SLOTS]: SDK_OK,
    });
    expect(run(root).status).toBe(0);
  });
});
