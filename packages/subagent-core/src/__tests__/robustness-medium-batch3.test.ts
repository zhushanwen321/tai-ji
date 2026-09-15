// Medium batch 3: thinkingLevel 字段声明检查
//
// M2（保留）: AgentCallOpts 声明 thinkingLevel 字段（仍有效）
// M2 propagation / M3 model fallback: resolveAgentOpts 删除 agent 处理块后废弃，相关测试已移除

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

// ── M2: AgentCallOpts has thinkingLevel ───────────────────────

describe("M2: AgentCallOpts has thinkingLevel field", () => {
  const src = readSrc(join("src", "orchestration", "models", "types.ts"));

  it("AgentCallOpts interface declares thinkingLevel", () => {
    // 找到 AgentCallOpts interface 块，断言含 thinkingLevel 字段
    const ifaceMatch = src.match(/export interface AgentCallOpts \{[\s\S]*?\}/);
    expect(ifaceMatch).toBeTruthy();
    expect(ifaceMatch![0]).toContain("thinkingLevel");
  });
});
