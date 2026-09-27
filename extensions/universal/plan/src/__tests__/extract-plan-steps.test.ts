import { describe, expect,it } from "vitest";

import { extractPlanSteps } from "../execution-notice.js";

describe("extractPlanSteps", () => {
  it("extracts numbered steps from 实现步骤 section", () => {
    const plan = `# Plan

## 背景
Some context
1. Background numbered line that must not leak

## 实现步骤
1. Create the user model
2. Add validation logic
3. Write unit tests

## 验证
Run tests`;
    const steps = extractPlanSteps(plan);
    expect(steps).toEqual([
      "Create the user model",
      "Add validation logic",
      "Write unit tests",
    ]);
  });

  it("extracts numbered steps from 实施步骤 section", () => {
    const plan = `## 实施步骤
1. Step one
2. Step two

## 验证
1. Verification line that must not leak`;
    const steps = extractPlanSteps(plan);
    expect(steps).toEqual(["Step one", "Step two"]);
  });

  it("extracts steps from English Steps section", () => {
    const plan = `## Steps
1. First step
2. Second step

## Notes
1. Notes line that must not leak`;
    const steps = extractPlanSteps(plan);
    expect(steps).toEqual(["First step", "Second step"]);
  });

  it("extracts steps from Implementation section", () => {
    const plan = `## Implementation Steps
1. Create file
2. Add exports

## Validation
1. Validation line that must not leak`;
    const steps = extractPlanSteps(plan);
    expect(steps).toEqual(["Create file", "Add exports"]);
  });

  it("stops at next ## header", () => {
    const plan = `## 实现步骤
1. Step in plan section

## 验证
1. Not a plan step
2. Also not a plan step`;
    const steps = extractPlanSteps(plan);
    expect(steps).toEqual(["Step in plan section"]);
  });

  it("extracts checkbox items from steps section", () => {
    const plan = `## 实现步骤
- [ ] Add auth middleware
- [x] Create user model
- [ ] Write integration test`;
    const steps = extractPlanSteps(plan);
    expect(steps).toEqual([
      "Add auth middleware",
      "Create user model",
      "Write integration test",
    ]);
  });

  it("fallback: collects numbered items when no steps section header", () => {
    const plan = `# Plan
1. First thing
2. Second thing
3. Third thing`;
    const steps = extractPlanSteps(plan);
    expect(steps).toEqual(["First thing", "Second thing", "Third thing"]);
  });

  it("skips empty lines and whitespace-only items", () => {
    const plan = `## 实现步骤
1. Valid step

2. Another valid step
3.
4. ${"   "}`;
    const steps = extractPlanSteps(plan);
    expect(steps).toEqual(["Valid step", "Another valid step"]);
  });

  it("fallback cap: collects at most the first 10 numbered items when no steps section header", () => {
    const plan = Array.from({ length: 12 }, (_, i) => `${i + 1}. step ${i + 1}`).join("\n");
    const steps = extractPlanSteps(plan);
    expect(steps).toHaveLength(10);
    expect(steps[9]).toBe("step 10");
  });
});
