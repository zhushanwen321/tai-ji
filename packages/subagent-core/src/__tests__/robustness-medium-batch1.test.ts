// Medium batch 1 robustness fixes verification
//
// M4: [H2 W3 改写] dispatchAgentCall 的 node.live 清理已随 trace.live 字段退役
//     （设计 subagent-workflow-record-unification.md D2——旁路 progress record 族
//     整体删除，节点无运行期附属对象）。原「live 清理先于 stale guard」的顺序
//     断言改为退役回归：pump 无 node.live 写点。
// M7: handleWorkerMessage validates msg shape before dereferencing msg.opts
// M8: session-reconstructor guards Array.isArray(msg.content) before for...of

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

// ── M4: node.live 写点已退役（[H2 W3] 回归锁定） ─────────────

describe("M4: [H2 W3] dispatchAgentCall 不再写 node.live", () => {
  const src = readSrc(join("src", "orchestration", "worker-message-pump.ts"));

  it("整个 pump 源码无 .live 写点（旁路 record 族退役），stale guard 仍在", () => {
    expect(src).not.toMatch(/\.live\s*=/);
    // .then 的 stale guard 仍在（原顺序断言的对象消失，守卫本身保留）
    const thenMatch = src.match(/\.then\(\(\)\s*=>\s*\{[\s\S]*?\}\)/);
    expect(thenMatch).toBeTruthy();
    expect(thenMatch![0]).toContain('run.state.status !== "running"');
  });
});

// ── M7: handleWorkerMessage shape validation ─────────────────

describe("M7: handleWorkerMessage validates msg before dereferencing", () => {
  const src = readSrc(join("src", "orchestration", "worker-message-pump.ts"));

  it("handleWorkerMessage has shape guard for msg before dereferencing opts", () => {
    // handleWorkerMessage 中 `raw as WorkerMsg` 后应有 typeof/形状校验
    // 防止畸形 IPC 消息（msg.opts undefined）导致 TypeError
    const handlerMatch = src.match(/export async function handleWorkerMessage[\s\S]*?switch/);
    expect(handlerMatch).toBeTruthy();
    const handlerBlock = handlerMatch![0];
    // 在 switch 前应有 msg 形状校验（typeof msg === 'object' 或 msg?.type 检查）
    expect(handlerBlock).toMatch(/typeof\s+(msg|raw)|!\s*(msg|raw)|(msg|raw)\s*&&/);
  });
});

// ── M8: reconstructor Array.isArray guard ────────────────────

describe("M8: session-reconstructor guards msg.content with Array.isArray", () => {
  const src = readSrc(join("src", "execution", "session-reconstructor.ts"));

  it("for...of msg.content is guarded by Array.isArray", () => {
    // 验证 for (const block of msg.content) 前有 Array.isArray 守卫
    expect(src).toContain("Array.isArray");
    // 确保守卫与 msg.content 相关
    const contentGuardMatch = src.match(/Array\.isArray\([^)]*content[^)]*\)/);
    expect(contentGuardMatch).toBeTruthy();
  });
});
