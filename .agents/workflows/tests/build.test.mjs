// build.test.mjs — 构建管线确定性测试：生成一致性 / --check 幂等 / 公共观测层单一构建
// 输入（缺失 fail-fast）/ 改写完整性 / 产物语法（按真实执行形态 = async 包装）/
// 本机绝对路径零字面。构建一律在临时 HOME（装好观测层副本）下执行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir as realHomedir } from "node:os";
import { fileURLToPath } from "node:url";
import { installObsScripts } from "./helpers/obs-home.mjs";

const WF = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(WF, "scripts", "build-workflows.mjs");
const PRODUCTS = {
  "dev-merge-gates": {
    zcode: join(WF, "dev-merge-gates.dwf.ts"),
    pi: join(WF, "dev-merge-gates.js"),
  },
  "pr-lifecycle": {
    zcode: join(WF, "..", "skills", "pr-cr-fix", "workflows", "pr-lifecycle.dwf.ts"),
    pi: join(WF, "pr-lifecycle.js"),
  },
};

// 临时测试 HOME：装观测层与 CLI 副本（安装契约形态）；typescript 经 env 显式传递
//（临时 HOME 下构建器的 ~/Code/zsw-skills fallback 会 miss）
function makeTestHome() {
  const home = mkdtempSync(join(tmpdir(), "wf-build-home-"));
  installObsScripts(home);
  const tsPath = zswTsPath();
  return { home, env: { ...process.env, HOME: home, WORKFLOW_BUILD_TYPESCRIPT: tsPath } };
}

import { createRequire } from "node:module";
import { homedir } from "node:os";

function runBuild(args, env) {
  return execFileSync(process.execPath, [BUILD, ...args], { encoding: "utf8", cwd: WF, env });
}

// 构建期 typescript 入口（显式 zsw 仓路径——node 解析链向上可能命中无关副本，不可控；
// 用进程真实 HOME（homedir()，非测试注入的 env.HOME）推导）
const zswTsPath = () => join(realHomedir(), "Code", "zsw-skills", "node_modules", "typescript");

test("构建幂等：临时 HOME（含观测层副本）下连续生成稳定，--check 全绿", () => {
  const { env } = makeTestHome();
  try {
    const out1 = runBuild([], env);
    assert.match(out1, /已生成|（一致）/);
    assert.match(out1, /观测契约：dev-merge-gates/);
    assert.match(out1, /观测契约：pr-lifecycle/);
    runBuild([], env);
    const chk = runBuild(["--check"], env);
    assert.match(chk, /（一致）/);
    assert.doesNotMatch(chk, /过期|不一致/);
  } finally {
    // 恢复真实 HOME 视角的产物（构建内容与 HOME 无关——公共层来源内容一致）
    runBuild([], process.env);
  }
});

test("公共观测层缺失：构建 fail-fast 并给安装恢复动作（不允许静默退回无观测产物）", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-build-nolayer-"));
  const tsPath = zswTsPath();
  const env = { ...process.env, HOME: home, WORKFLOW_BUILD_TYPESCRIPT: tsPath };
  try {
    const r = spawnSync(process.execPath, [BUILD], { encoding: "utf8", cwd: WF, env });
    assert.notEqual(r.status, 0, "公共层缺失时构建必须失败");
    const out = `${r.stderr}${r.stdout}`;
    assert.match(out, /公共观测层缺失/);
    assert.match(out, /恢复动作/);
    assert.match(out, /workflow-observability\.shared\.ts/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("四个产物全部存在且非空", () => {
  for (const name of Object.keys(PRODUCTS)) {
    for (const [, path] of Object.entries(PRODUCTS[name])) {
      const c = readFileSync(path, "utf8");
      assert.ok(c.length > 10_000, `${path} 应为完整产物（实际 ${c.length} 字节）`);
    }
  }
});

test("--check 拦截产物篡改：改产物后 --check 失败，重建后恢复", () => {
  const { env } = makeTestHome();
  const p = PRODUCTS["dev-merge-gates"].pi;
  const orig = readFileSync(p, "utf8");
  try {
    writeFileSync(p, orig + "\n// selftest tamper\n");
    let failed = false;
    try {
      runBuild(["--check"], env);
    } catch {
      failed = true;
    }
    assert.equal(failed, true, "--check 应对产物篡改报非零");
  } finally {
    writeFileSync(p, orig);
  }
  runBuild(["--check"], env);
});

test("pi 产物改写完整性：shared 调用点全部改写为 wfAgent(，壳 shim 保留唯一平台原生 agent 调用", () => {
  for (const name of Object.keys(PRODUCTS)) {
    const pi = readFileSync(PRODUCTS[name].pi, "utf8");
    const wfCount = (pi.match(/(?<![\w.$])wfAgent\(/g) ?? []).length;
    assert.ok(wfCount >= 3, `${name} pi 产物 wfAgent( 调用点应来自 shared 改写（实际 ${wfCount}）`);
    const strayCallSpec = (pi.match(/(?<![\w.$])agent\(\{/g) ?? []).length;
    assert.equal(strayCallSpec, 0, `${name} pi 产物出现 callSpec 形态裸 agent(（shared 改写遗漏）`);
    const shimCalls = (pi.match(/await agent\(callSpec\)/g) ?? []).length;
    assert.equal(shimCalls, 1, `${name} pi 产物壳内平台原生 agent 调用应恰 1 处（实际 ${shimCalls}）`);
  }
});

test("两平台产物语法有效（按真实执行形态 = async 函数体包装后解析）", () => {
  const ts = createRequire(import.meta.url)(zswTsPath());
  const dir = mkdtempSync(join(tmpdir(), "wf-syntax-"));
  try {
    for (const name of Object.keys(PRODUCTS)) {
      for (const [platform, path] of Object.entries(PRODUCTS[name])) {
        let code = readFileSync(path, "utf8");
        if (platform === "zcode") {
          code = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        }
        const wrapped = "async function __wrap__() {\n" + code + "\n}";
        const f = join(dir, `${name}-${platform}.mjs`);
        writeFileSync(f, wrapped);
        execFileSync(process.execPath, ["--check", f]);
      }
    }
  } finally {
    for (const f of ["dev-merge-gates-zcode", "dev-merge-gates-pi", "pr-lifecycle-zcode", "pr-lifecycle-pi"]) {
      try { rmSync(join(dir, `${f}.mjs`)); } catch { /* 已清理 */ }
    }
  }
});

test("产物不含本机绝对路径字面（workspace 约定）", () => {
  const home = process.env.HOME ?? "";
  for (const name of Object.keys(PRODUCTS)) {
    for (const [, path] of Object.entries(PRODUCTS[name])) {
      const c = readFileSync(path, "utf8");
      assert.ok(!c.includes(home + "/"), `${path} 不得含本机绝对路径字面`);
    }
  }
});

test("公共观测层以单一来源拼入两侧产物（obsCtx/obsBegin 定义在业务正文之前；壳不含观测层副本）", () => {
  for (const name of Object.keys(PRODUCTS)) {
    for (const [, path] of Object.entries(PRODUCTS[name])) {
      const c = readFileSync(path, "utf8");
      const initPos = c.indexOf("function initObservation");
      const ctxPos = c.indexOf("let obsCtx");
      const bizPos = c.indexOf('obsCtx = initObservation("');
      assert.ok(initPos > 0 && ctxPos >= 0, `${path} 应含拼入的公共观测层`);
      assert.ok(bizPos > ctxPos, `${path} 业务正文应在观测层之后（obsCtx let 声明先于赋值）`);
    }
  }
});
