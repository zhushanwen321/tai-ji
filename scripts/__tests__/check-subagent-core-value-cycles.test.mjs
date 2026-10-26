// scripts/__tests__/check-subagent-core-value-cycles.test.mjs
//
// C-data-27 检查（scripts/check-subagent-core-value-cycles.mjs）的 fixture 单测：
// 值环必红 / 纯类型环放行（类型边编译期擦除）/ 混合说明符按值边 / 动态 import 与
// require 计入 / 干净图绿 / 反向依赖边零容忍（值边与类型边同拦、入 barrel 边拦、
// barrel 出边豁免、测试文件同射程、orchestration/** 同层消费射程外、新顶层目录自动
// 入射程）——防「检查恒绿」「类型边被当成值边误伤」「反向边漏拦」多侧退化。
// fixture 全在 tmpdir 自建自删（禁触真实仓库）。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-subagent-core-value-cycles.mjs");

const tempDirs = [];
function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "core-cycle-guard-"));
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

    // require 形态用 .cts（扫描范围 = core src 的 .ts/.mts/.cts；.cjs 不在 core 源内）
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

  it("反向值边（层文件 → orchestration）→ exit 1，附恢复动作与 C-data-27", () => {
    const dir = makeFixture({
      "orchestration/orchestrator.ts": 'export function orchestrator() { return 1; }\n',
      "execution/consumer.ts": 'import { orchestrator } from "../orchestration/orchestrator.ts";\nconsole.log(orchestrator());\n',
    });
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("反向依赖边");
    expect(res.stderr).toContain("C-data-27");
    expect(res.stderr).toContain("下沉 shared/");
    expect(res.stderr).toContain("搬迁 execution/");
    expect(res.stderr).toContain("测试归属迁移");
    expect(res.stderr).toContain(join("execution", "consumer.ts"));
  });

  it("反向类型边（import type → orchestration）→ exit 1（零容忍不分值/类型）", () => {
    const dir = makeFixture({
      "orchestration/shape.ts": "export type Shape = { w: number };\n",
      "execution/typer.ts": 'import type { Shape } from "../orchestration/shape.ts";\nexport type U = Shape;\n',
    });
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("反向依赖边");
    expect(res.stderr).toContain(join("execution", "typer.ts"));
  });

  it("barrel re-export 出边放行（index.ts → orchestration 是包公共 API 出口）", () => {
    const dir = makeFixture({
      "index.ts": 'export { orchestrator } from "./orchestration/orchestrator.ts";\n',
      "orchestration/orchestrator.ts": 'export function orchestrator() { return 1; }\n',
    });
    const res = run(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("OK");
  });

  it("barrel 之外新顶层目录的反向边照拦（判据按射程不按枚举目录）", () => {
    const dir = makeFixture({
      "orchestration/orchestrator.ts": 'export function orchestrator() { return 1; }\n',
      "plugin/fresh.ts": 'import { orchestrator } from "../orchestration/orchestrator.ts";\nconsole.log(orchestrator());\n',
    });
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("反向依赖边");
    expect(res.stderr).toContain(join("plugin", "fresh.ts"));
  });

  it("入 barrel 边照拦（from \"../index.ts\" 与无扩展名 from \"../index\" 均命中）", () => {
    const withExt = makeFixture({
      "index.ts": 'export const VERSION = "1.0.0";\n',
      "execution/user.ts": 'import { VERSION } from "../index.ts";\nconsole.log(VERSION);\n',
    });
    const resExt = run(withExt);
    expect(resExt.status).toBe(1);
    expect(resExt.stderr).toContain("反向依赖边");
    expect(resExt.stderr).toContain("index.ts");

    const noExt = makeFixture({
      "index.ts": 'export const VERSION = "1.0.0";\n',
      "execution/user.ts": 'import { VERSION } from "../index";\nconsole.log(VERSION);\n',
    });
    const resNoExt = run(noExt);
    expect(resNoExt.status).toBe(1);
    expect(resNoExt.stderr).toContain("反向依赖边");
    expect(resNoExt.stderr).toContain("index.ts");
  });

  it("测试文件入射程（__tests__ 反向边红；orchestration/__tests__ 同层消费射程外）", () => {
    const testInScope = makeFixture({
      "orchestration/orchestrator.ts": 'export function orchestrator() { return 1; }\n',
      "execution/__tests__/consumer.test.ts": 'import { orchestrator } from "../../orchestration/orchestrator.ts";\ntest("x", () => expect(orchestrator()).toBe(1));\n',
    });
    const resRed = run(testInScope);
    expect(resRed.status).toBe(1);
    expect(resRed.stderr).toContain("反向依赖边");
    expect(resRed.stderr).toContain(join("execution", "__tests__", "consumer.test.ts"));

    const orchestrationTestsOut = makeFixture({
      "index.ts": "export const K = 1;\n",
      "orchestration/orchestrator.ts": 'import { K } from "../index.ts";\nexport function orchestrator() { return K; }\n',
      "orchestration/__tests__/orchestrator.test.ts": 'import { orchestrator } from "../orchestrator.ts";\nimport { K } from "../../index.ts";\ntest("x", () => expect(orchestrator()).toBe(K));\n',
    });
    const resGreen = run(orchestrationTestsOut);
    expect(resGreen.status).toBe(0);
    expect(resGreen.stdout).toContain("OK");
  });
});
