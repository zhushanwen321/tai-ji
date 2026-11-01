// stages.test.mjs — 阶段集合契约：业务 shared 声明的观测边界（公共观测层 API）覆盖任务
// 规定集合，且两平台产物（同一公共体生成）的步骤调用点集合完全一致
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WF = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(WF, "src");
const PRODUCTS = {
  "dev-merge-gates": {
    shared: join(SRC, "dev-merge-gates.shared.ts"),
    zcode: join(WF, "dev-merge-gates.dwf.ts"),
    pi: join(WF, "dev-merge-gates.js"),
  },
  "pr-lifecycle": {
    shared: join(SRC, "pr-lifecycle.shared.ts"),
    zcode: join(WF, "..", "skills", "pr-cr-fix", "workflows", "pr-lifecycle.dwf.ts"),
    pi: join(WF, "pr-lifecycle.js"),
  },
};

// 串行步骤边界（公共层 openStep 槽）：obsBegin/withStage
function extractStages(code) {
  return [...code.matchAll(/\b(?:obsBegin|withStage)\("([A-Za-z0-9-]+)"/g)].map((m) => m[1]);
}

test("dev-merge-gates：观测边界至少区分 gates / branch-review / review / aggregate / fix / round", () => {
  const code = readFileSync(PRODUCTS["dev-merge-gates"].shared, "utf8");
  const stages = new Set(extractStages(code));
  // gates / branch-review 两大步经 runStep wrapper 的 withStage；轮内三段为 obsBegin 串行段
  for (const required of ["review", "aggregate", "fix"]) {
    assert.ok(stages.has(required), `dev-merge-gates 缺串行观测段 "${required}"（实际：${[...stages].join("/")}）`);
  }
  for (const wrapperStep of ["gates", "branch-review"]) {
    assert.ok(code.includes(`runStep("${wrapperStep}"`), `dev-merge-gates 缺 runStep("${wrapperStep}") 调用点（其 start/end 经 withStage 观测）`);
  }
  // round 为直发轮次边界（obsEmit，不占打开槽）
  assert.match(code, /obsEmit\("round"/, "dev-merge-gates 应有 round 直发轮次边界");
});

test("pr-lifecycle：九 step + cr-fix 内 review / aggregate / fix / round 全部有观测边界", () => {
  const code = readFileSync(PRODUCTS["pr-lifecycle"].shared, "utf8");
  const nine = ["preflight", "static-gate", "pr-meta", "pr-submit", "constraints", "gate-suite", "cr-fix", "simplify", "final-gates"];
  // 九步经 step wrapper 的 withStage（step: id 占位形态）
  assert.match(code, /withStage\(id, null, fn\)/, "pr-lifecycle step wrapper 应经 withStage 观测");
  const stages = new Set(extractStages(code));
  for (const required of ["review", "aggregate", "fix"]) {
    assert.ok(stages.has(required), `pr-lifecycle 缺串行观测段 "${required}"（实际：${[...stages].join("/")}）`);
  }
  for (const id of nine) {
    assert.ok(code.includes(`step("${id}"`), `pr-lifecycle 缺 step("${id}") 调用点`);
  }
  assert.match(code, /obsEmit\("round"/, "pr-lifecycle 应有 round 直发轮次边界");
});

test("两平台产物的观测步骤调用点集合完全一致（同一公共体生成，壳不得吞边界）", () => {
  for (const name of Object.keys(PRODUCTS)) {
    const zc = extractStages(readFileSync(PRODUCTS[name].zcode, "utf8")).sort();
    const pi = extractStages(readFileSync(PRODUCTS[name].pi, "utf8")).sort();
    assert.deepEqual(pi, zc, `${name} 两平台产物 obsBegin/withStage 调用点集合不一致`);
    assert.ok(zc.length > 0, `${name} 产物无观测步骤调用点`);
  }
});
