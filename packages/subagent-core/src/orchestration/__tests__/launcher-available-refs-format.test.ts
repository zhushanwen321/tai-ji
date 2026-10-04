/**
 * formatAvailableWorkflowRefs 表驱动直测。
 *
 * 可用 workflow 清单 item 模板单源（S2 收敛）：三个 render 点（run 拒单缺省形态 /
 * 壳 lint not-found 缺省形态 / 壳 actionList includeSource 形态）共用本函数。
 * 本文件锁两轴（includeLocation × includeSource）全组合的输出字节 + available
 * filter——尤其缺省组合必须与历史 run 拒单格式逐字节一致（回归锚，改动即红）。
 *
 * 框架：vitest。
 */
import { describe, expect, it } from "vitest";

import { formatAvailableWorkflowRefs } from "../launcher.ts";
import { WorkflowScript, type WorkflowSource } from "../models/workflow-script.ts";
import type { WorkflowMeta } from "../../shared/resource-meta.ts";

function makeScript(opts: {
  name: string;
  source?: WorkflowSource;
  path?: string;
  description?: string;
  available?: boolean;
}): WorkflowScript {
  const meta: WorkflowMeta = {
    kind: "workflow",
    name: opts.name,
    description: opts.description ?? "",
    phases: [],
  };
  return new WorkflowScript({
    name: opts.name,
    source: opts.source ?? "saved",
    path: opts.path ?? `/abs/${opts.name}.js`,
    sourceCode: "// x",
    meta,
    available: opts.available ?? true,
  });
}

const SAVED = makeScript({ name: "deploy-wf", source: "saved", path: "/abs/deploy-wf.js", description: "deploy the app" });
const TMP = makeScript({ name: "scratch-wf", source: "tmp", path: "/abs/scratch-wf.js", description: "scratch task" });
const NO_DESC = makeScript({ name: "bare-wf", path: "/abs/bare-wf.js", description: "" });
const BROKEN = makeScript({ name: "broken-wf", path: "/abs/broken-wf.js", description: "解析失败", available: false });

describe("formatAvailableWorkflowRefs（item 模板单源）", () => {
  // 两轴全组合表：期望值逐字节锁定（缺省行 = 历史 run 拒单格式的回归锚）。
  it.each([
    {
      title: "缺省（includeLocation=true / includeSource=false）= run 拒单格式",
      opts: undefined,
      expected:
        "  - deploy-wf: deploy the app\n    location: /abs/deploy-wf.js\n" +
        "  - scratch-wf: scratch task\n    location: /abs/scratch-wf.js",
    },
    {
      title: "includeLocation=false / includeSource=false：单行、无 source 标签",
      opts: { includeLocation: false },
      expected: "  - deploy-wf: deploy the app\n  - scratch-wf: scratch task",
    },
    {
      title: "includeSource=true（保留 location）: [source] 前缀插在 '- ' 后",
      opts: { includeSource: true },
      expected:
        "  - [saved] deploy-wf: deploy the app\n    location: /abs/deploy-wf.js\n" +
        "  - [tmp] scratch-wf: scratch task\n    location: /abs/scratch-wf.js",
    },
    {
      title: "includeSource=true / includeLocation=false = actionList 形态（':' 分隔）",
      opts: { includeSource: true, includeLocation: false },
      expected: "  - [saved] deploy-wf: deploy the app\n  - [tmp] scratch-wf: scratch task",
    },
  ])("$title", ({ opts, expected }) => {
    expect(formatAvailableWorkflowRefs([SAVED, TMP], opts)).toBe(expected);
  });

  it("available filter：available=false 的 stub 剔除，不进任何选项组合的输出", () => {
    expect(formatAvailableWorkflowRefs([SAVED, BROKEN])).toBe(
      "  - deploy-wf: deploy the app\n    location: /abs/deploy-wf.js",
    );
    expect(formatAvailableWorkflowRefs([BROKEN], { includeSource: true, includeLocation: false })).toBe("");
  });

  it("description 为空串 → (no description) 占位（全部选项组合一致）", () => {
    expect(formatAvailableWorkflowRefs([NO_DESC])).toBe(
      "  - bare-wf: (no description)\n    location: /abs/bare-wf.js",
    );
    expect(formatAvailableWorkflowRefs([NO_DESC], { includeSource: true, includeLocation: false })).toBe(
      "  - [saved] bare-wf: (no description)",
    );
  });

  it("空 available 集 → 空串（调用点以 falsy 判空态）", () => {
    expect(formatAvailableWorkflowRefs([])).toBe("");
  });
});
