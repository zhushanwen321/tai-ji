// scripts/__tests__/check-subagent-core-value-cycles.test.mjs
//
// C-data-26 守卫（scripts/check-subagent-core-value-cycles.mjs）的 fixture 单测：
// 值环必红 / 纯类型环放行（类型边编译期擦除）/ 混合说明符按值边 / 动态 import 与
// require 计入 / 干净图绿——防「守卫恒绿」或「类型边被当成值边误伤」两侧退化。
// fixture 全在 tmpdir 自建自删（禁触真实仓库）。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-subagent-core-value-cycles.mjs");

const tempDirs = [];
function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "core-cycle-guard-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}
function run(root) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], { cwd: REPO_ROOT, encoding: "utf8" });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("check-subagent-core-value-cycles", () => {
  it("值依赖环 → exit 1，输出 SCC 成员与内部边", () => {
    const dir = makeFixture({
      "a.ts": 'import { b } from "./b.ts";\nfunction a() { return b(); }\nconsole.log(a());\n',
      "b.ts": 'import { a } from "./a.ts";\nfunction b() { return a(); }\nconsole.log(b());\n',
    });
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("值依赖环");
    expect(res.stderr).toContain("a.ts");
    expect(res.stderr).toContain("b.ts");
  });

  it("纯类型环 → exit 0（编译期擦除边不参与判定）", () => {
    const dir = makeFixture({
      "a.ts": 'import type { B } from "./b.ts";\ntype A = { b?: B };\nfunction makeA(): A { return {}; }\nconsole.log(makeA());\n',
      "b.ts": 'import type { A } from "./a.ts";\ntype B = { a?: A };\nfunction makeB(): B { return {}; }\nconsole.log(makeB());\n',
    });
    const res = run(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("含类型边的环 1 个");
  });

  it("混合说明符按值边判定（{ type T, value } = 值边）", () => {
    const dir = makeFixture({
      "a.ts": 'import { type B, makeB } from "./b.ts";\nfunction a() { makeB(); }\nconsole.log(a());\ntype U = B;\n',
      "b.ts": 'import { type A, makeA } from "./a.ts";\nfunction b() { makeA(); }\nconsole.log(b());\ntype V = A;\n',
    });
    expect(run(dir).status).toBe(1);
  });

  it("动态 import 与 require 也计入值边", () => {
    const dynamicDir = makeFixture({
      "a.ts": 'async function a() { return (await import("./b.ts")).b(); }\nconsole.log(a());\n',
      "b.ts": 'import { a } from "./a.ts";\nfunction b() { return a(); }\nconsole.log(b());\n',
    });
    expect(run(dynamicDir).status).toBe(1);

    // require 形态用 .cts（扫描面 = core src 的 .ts/.mts/.cts；.cjs 不在 core 源内）
    const requireDir = makeFixture({
      "a.cts": 'const { b } = require("./b.cts");\nconst a = () => b();\nconsole.log(a);\n',
      "b.cts": 'const { a } = require("./a.cts");\nconst b = () => a();\nconsole.log(b);\n',
    });
    expect(run(requireDir).status).toBe(1);
  });

  it("干净图 → exit 0", () => {
    const dir = makeFixture({
      "a.ts": 'import { b } from "./b.ts";\nfunction a() { return b(); }\nconsole.log(a());\n',
      "b.ts": 'function b() { return 1; }\nconsole.log(b());\n',
    });
    const res = run(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("OK");
  });
});
