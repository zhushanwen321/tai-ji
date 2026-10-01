// scripts/__tests__/check-domain-type-path.test.mjs
//
// [D2] 领域类型路径单源检查的自测：三类形态——干净树（放行）/ assembly 复活 re-export
// （拦）/ 消费者绕道 assembly 取领域名（拦）。用临时目录 + --root 注入，不碰真仓。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/check-domain-type-path.mjs");
let dirs = [];

function makeTree({ shimExports = "", consumer = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "domain-path-"));
  dirs.push(root);
  const core = join(root, "packages/subagent-core/src");
  mkdirSync(join(core, "execution/domain"), { recursive: true });
  mkdirSync(join(core, "execution/assembly"), { recursive: true });
  writeFileSync(join(core, "execution/domain/record-types.ts"),
    'export type ExecutionStatus = "running" | "idle";\nexport const CLOSED_REASONS: readonly string[] = [];\n');
  writeFileSync(join(core, "execution/domain/record-model.ts"),
    'export type ExecutionRecord = { readonly id: string };\n');
  writeFileSync(join(core, "execution/assembly/types.ts"),
    `import type { ExecutionStatus } from "../domain/record-types.ts";\n${shimExports}export type Other = { s?: ExecutionStatus };\n`);
  if (consumer) writeFileSync(join(core, "consumer.ts"), consumer);
  return root;
}

function run(root) {
  try {
    return { code: 0, out: execFileSync("node", [SCRIPT, "--root", root], { encoding: "utf8" }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  dirs = [];
});

describe("check-domain-type-path", () => {
  it("干净树：assembly 只 import 领域名（内部使用）→ 放行", () => {
    const r = run(makeTree());
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK");
  });

  it("assembly 复活 re-export → 拦（路径双源）", () => {
    const r = run(makeTree({ shimExports: 'export type { ExecutionStatus } from "../domain/record-types.ts";\n' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("重新导出领域名 ExecutionStatus");
  });

  it("消费者绕道 assembly 取领域名 → 拦", () => {
    const r = run(makeTree({ consumer: 'import type { ExecutionRecord } from "./execution/assembly/types.ts";\n' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("从 assembly 取领域名 ExecutionRecord");
  });

  it("消费者走 domain 路径 → 放行", () => {
    const r = run(makeTree({ consumer: 'import type { ExecutionRecord } from "./execution/domain/record-model.ts";\n' }));
    expect(r.code).toBe(0);
  });
});
