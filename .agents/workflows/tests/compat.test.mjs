// compat.test.mjs — 兼容性静态对账：既有调用参数不中断（白名单保留）+ 结构化返回
// 关键字段保留 + pi 参数承载形态（$ARGS 平铺字符串 → 数组/数字转换）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WF = join(dirname(fileURLToPath(import.meta.url)), "..");
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

test("pr-lifecycle 参数白名单保留既有 5 参数（zcode 调用不中断）+ 观测 3 参数", () => {
  for (const [, path] of Object.entries(PRODUCTS["pr-lifecycle"])) {
    const c = readFileSync(path, "utf8");
    const m = c.match(/VALID_ARG_KEYS = new Set\(\[([^\]]+)\]/);
    assert.ok(m, "VALID_ARG_KEYS 白名单应存在");
    for (const key of ["base", "maxRounds", "reviewers", "simplifyMode", "skipSteps", "taskId", "executionId", "sampleType"]) {
      assert.ok(m[1].includes(`"${key}"`), `pr-lifecycle 白名单缺 "${key}"（${path}）`);
    }
  }
});

test("dev-merge-gates 参数白名单保留既有 2 参数 + 观测 3 参数", () => {
  for (const [, path] of Object.entries(PRODUCTS["dev-merge-gates"])) {
    const c = readFileSync(path, "utf8");
    const m = c.match(/VALID_ARG_KEYS = new Set\(\[([^\]]+)\]/);
    assert.ok(m, "VALID_ARG_KEYS 白名单应存在");
    for (const key of ["base", "maxRounds", "taskId", "executionId", "sampleType"]) {
      assert.ok(m[1].includes(`"${key}"`), `dev-merge-gates 白名单缺 "${key}"（${path}）`);
    }
  }
});

test("pi 产物保留 $ARGS 平铺字符串承载形态（逗号分隔列表 → 数组）", () => {
  const pi = readFileSync(PRODUCTS["pr-lifecycle"].pi, "utf8");
  assert.match(pi, /const raw = \$ARGS \|\| \{\}/, "$ARGS 读取应保留");
  assert.match(pi, /split\(","\)/, "reviewers/skipSteps 逗号分隔解析应保留");
  assert.match(pi, /_runId/, "_runId 引擎内部字段的排除注释应保留");
});

test("zcode 产物保留 zcode-workflow frontmatter / pi 产物保留 @pi-meta", () => {
  assert.match(readFileSync(PRODUCTS["pr-lifecycle"].zcode, "utf8"), /\/\* zcode-workflow/);
  assert.match(readFileSync(PRODUCTS["dev-merge-gates"].zcode, "utf8"), /\/\* zcode-workflow/);
  assert.match(readFileSync(PRODUCTS["pr-lifecycle"].pi, "utf8"), /@pi-meta/);
  assert.match(readFileSync(PRODUCTS["dev-merge-gates"].pi, "utf8"), /@pi-meta/);
});

test("pr-lifecycle 结构化返回关键字段保留（awaiting-push / failed 两形态全集）", () => {
  for (const [, path] of Object.entries(PRODUCTS["pr-lifecycle"])) {
    const c = readFileSync(path, "utf8");
    for (const field of [
      'status: "awaiting-push"', 'status: "failed"',
      "failedStep", "recovery", "prUrl", "terminated",
      "simplify", "sweptFiles", "skippedSteps", "nextAction",
    ]) {
      assert.ok(c.includes(field), `pr-lifecycle 产物缺返回字段/关键串 "${field}"（${path}）`);
    }
  }
});

test("dev-merge-gates 结构化返回关键字段保留（done / failed 两形态全集）", () => {
  for (const [, path] of Object.entries(PRODUCTS["dev-merge-gates"])) {
    const c = readFileSync(path, "utf8");
    for (const field of [
      'status: "failed"', '"needs-human"', '"review-failure"', '"aggregator-failure"', '"fix-failure"',
      "deferredCommits", "sweptFiles", "remaining", "disputed",
      "ledger.json",
    ]) {
      assert.ok(c.includes(field), `dev-merge-gates 产物缺返回字段/关键串 "${field}"（${path}）`);
    }
  }
});

test("业务判据未被改动：reviewer 维度集与触发规则保持（reviewers 判据不进本任务范围）", () => {
  const dmg = readFileSync(join(WF, "src", "dev-merge-gates.shared.ts"), "utf8");
  assert.match(dmg, /ALWAYS_DIMS = \["business-logic", "arch-boundary", "data-governance"\]/);
  assert.match(dmg, /electron-build/);
  assert.match(dmg, /monorepo-impact/);
  assert.match(dmg, /extension-api/);
  const prl = readFileSync(join(WF, "src", "pr-lifecycle.shared.ts"), "utf8");
  // cr-fix 维度集判定：显式 reviewers 白名单裁剪是唯一开启方式
  assert.match(prl, /reviewers\.some\(\(kw\) => f\.includes\(kw\)\)/);
  assert.match(prl, /SLOW_POOL = \["extension-api", "data-governance", "arch-boundary"\]/);
});
