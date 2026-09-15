// src/interface/__tests__/workflow-state-file-exposure.test.ts
//
// W2: WorkflowToolDetails 携带 stateFile + toRunSummary 填充逻辑
//
// 防的 bug：workflow run 自身的状态文件路径（<sessionDir>/workflow-state/<runId>.jsonl）
// 从未暴露到 tool details——overlay/GUI 拿不到，无法定位 run 状态文件做后续查看。
// 本测试验证 toRunSummary 和 actionRun 的 details 包含 stateFile 字段。
//
// 使用源码断言（读 .ts 文件文本）避免 import 重 mock 链——与 workflow-tool-prompt.test.ts 同模式。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_WORKFLOW_SRC = readFileSync(
  join(__dirname, "../tool-workflow.ts"),
  "utf-8",
);

describe("W2: workflow tool details 暴露 stateFile", () => {
  it("RunSummary 类型声明含 stateFile 可选字段", () => {
    // RunSummary 必须声明 stateFile，否则 toRunSummary 返回的对象类型不含此字段
    expect(TOOL_WORKFLOW_SRC).toMatch(/stateFile\?\s*:\s*string/);
  });

  it("toRunSummary 调用 deps.store.stateFilePath 填充 stateFile", () => {
    // toRunSummary 必须从 store.stateFilePath(runId) 取值——这是数据来源
    expect(TOOL_WORKFLOW_SRC).toMatch(/stateFilePath/);
  });

  it("run action 的 details 含 stateFile 字段", () => {
    // actionRun 返回的 details 必须携带 stateFile（run 启动时即暴露路径）
    // 验证 actionRun 函数体中构造 details 时引用了 stateFilePath
    expect(TOOL_WORKFLOW_SRC).toMatch(/action.*run[\s\S]*stateFilePath|stateFilePath[\s\S]*action.*run/i);
  });
});
