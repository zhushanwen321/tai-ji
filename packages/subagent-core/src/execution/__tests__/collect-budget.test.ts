// src/execution/__tests__/collect-budget.test.ts
//
// U4 预算截断 + 指针 纯函数规格锁（subagent-sync-collect 设计 §3.1.2）：
//
//   两段式预算（确定性，无瀑布分配）：
//     ① per-item 截断：每条目正文 ≤ perItemChars（默认 4000）；
//     ② 总量再压缩：Σ(截断后正文) > totalChars（默认 24000）时统一收紧
//        effectivePerItem = clamp(floor(totalChars / n), 200, perItemChars)；
//        floor < 200（n > totalChars/200）→ 纯清单退化（头行 + 指针行，正文 0）。
//
//   指针行：[truncated {omitted} of {total} chars — full result: session_read
//   {"action":"result","session":"{id}"}]（omitted = total − kept；千位分隔）。
//   [D6 #9] fixture id 统一 `sa-` 前缀——与产线 record id（`sa-<uuid>`，
//   subprocess-agent-runner.ts / subagent-service.ts 同款）同形，session_read 指针行
//   断言的是产线真实可达的 id 形态。
//   [C3 limit 随附] 该成员预算（effectivePerItem）> session_read 默认 8000 时 JSON 附
//   "limit":N（N = effectivePerItem）；≤8000 不附（默认已覆盖）。
//
//   totalChars 口径：仅计条目正文（截断后）之和；批头/头行/指针行/分隔符等
//   包装开销有界常量不入预算。
//
// 纯内存零 IO；不依赖产线 mock（只 import 两个纯函数 + BgNotifyRecord 类型）。

import { describe, expect, it } from "vitest";
import type { BgNotifyRecord } from "../notify/notifier.ts";
import { buildBatchLlmContent, computeBatchBudget } from "../notify/notifier.ts";

// ─── fixture ──

/** 成功完成的批成员；result = ch 重复 bodyLen 次（缺省 7 字符，永不触预算）。 */
function member(id: string, over: Partial<BgNotifyRecord> = {}): BgNotifyRecord {
  return {
    id,
    status: "closed",
    outcome: "completed",
    agent: `worker-${id}`,
    result: `result of ${id}`,
    startedAt: 1000,
    endedAt: 2000,
    ...over,
  };
}

function filled(id: string, bodyLen: number, ch = "A"): BgNotifyRecord {
  return member(id, { result: ch.repeat(bodyLen) });
}

/** 设计默认预算（config 热读接线前 U4 以默认常量锁规格）。 */
const PER_ITEM = 4000;
const TOTAL = 24000;

/** 期望指针行（千位分隔与设计样例 11,234 对齐）。perItemLimit > 8000 时附 "limit":N（C3）。 */
function pointer(id: string, kept: number, total: number, perItemLimit: number): string {
  const fmt = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const limitPart = perItemLimit > 8000 ? `,"limit":${perItemLimit}` : "";
  return `[truncated ${fmt(total - kept)} of ${fmt(total)} chars — full result: session_read {"action":"result","session":"${id}"${limitPart}}]`;
}

/** 期望条目：Result: 头行 + kept 正文 + （截断时）… + 指针行。 */
function expectedEntry(
  rec: { id: string; agent: string },
  fullBody: string,
  kept: number,
  perItemLimit: number,
): string {
  const head = `Subagent "${rec.agent}" (${rec.id}) completed. Result:\n`;
  if (fullBody.length <= kept) return head + fullBody;
  return `${head}${fullBody.slice(0, kept)}…\n${pointer(rec.id, kept, fullBody.length, perItemLimit)}`;
}

// ─── computeBatchBudget 纯函数公式 ──

describe("computeBatchBudget（两段式预算公式）", () => {
  it("7 成员各 6000：effectivePerItem = clamp(floor(24000/7)=3428, 200, 4000) = 3428", () => {
    const plan = computeBatchBudget(Array.from({ length: 7 }, () => 6000), PER_ITEM, TOTAL);
    expect(plan.tightened).toBe(true);
    expect(plan.listOnly).toBe(false);
    expect(plan.effectivePerItem).toBe(3428);
  });

  it("6 成员各 3000（Σ=18000 ≤ totalChars）：不触发第二段收紧", () => {
    const plan = computeBatchBudget(Array.from({ length: 6 }, () => 3000), PER_ITEM, TOTAL);
    expect(plan.tightened).toBe(false);
    expect(plan.listOnly).toBe(false);
    expect(plan.effectivePerItem).toBe(PER_ITEM);
  });

  it("n > totalChars/200（n=125 → floor=192 < 200）：纯清单退化 effectivePerItem = 0", () => {
    expect(TOTAL / 200).toBe(120);
    const plan = computeBatchBudget(Array.from({ length: 125 }, () => 1000), PER_ITEM, TOTAL);
    expect(plan.tightened).toBe(true);
    expect(plan.listOnly).toBe(true);
    expect(plan.effectivePerItem).toBe(0);
  });

  it("边界 n=120（floor(24000/120)=200 恰达下限）：不退化，effectivePerItem = 200", () => {
    const plan = computeBatchBudget(Array.from({ length: 120 }, () => 1000), PER_ITEM, TOTAL);
    expect(plan.listOnly).toBe(false);
    expect(plan.effectivePerItem).toBe(200);
  });

  it("口径：bodyLengths 仅收正文长度，Σ 恰等于 totalChars（=24000）不算超、不收紧", () => {
    const plan = computeBatchBudget(Array.from({ length: 6 }, () => 4000), PER_ITEM, TOTAL);
    expect(plan.tightened).toBe(false);
  });
});

// ─── buildBatchLlmContent 组装链 ──

describe("buildBatchLlmContent 预算截断组装（设计 §3.1.2）", () => {
  it("7 成员各 6000：每条收紧至 3428 字符 + 指针行，总量回到预算内", () => {
    const records = Array.from({ length: 7 }, (_, i) => filled(`sa-${i}`, 6000));
    const content = buildBatchLlmContent(records);
    const parts = content.split("\n\n---\n\n");

    expect(parts[0]).toBe("Subagent batch completed: 7 finished, 0 failed, 0 cancelled.");
    expect(parts).toHaveLength(8);
    for (let i = 0; i < 7; i++) {
      expect(parts[i + 1]).toBe(expectedEntry(records[i], "A".repeat(6000), 3428, 3428));
      expect(parts[i + 1]).toContain(
        pointer(`sa-${i}`, 3428, 6000, 3428), // omitted = 6000 − 3428 = 2,572
      );
    }
  });

  it("6 成员各 3000（Σ=18000）：不触发第二段——每条全量在场、零指针行", () => {
    const records = Array.from({ length: 6 }, (_, i) => filled(`sa-${i}`, 3000));
    const content = buildBatchLlmContent(records);
    const parts = content.split("\n\n---\n\n");

    expect(parts[0]).toBe("Subagent batch completed: 6 finished, 0 failed, 0 cancelled.");
    expect(content).not.toContain("[truncated");
    for (let i = 0; i < 6; i++) {
      expect(parts[i + 1]).toBe(expectedEntry(records[i], "A".repeat(3000), 3000, PER_ITEM));
    }
  });

  it("n=125：纯清单退化——每条只剩头行 + 指针行，正文零残留", () => {
    const records = Array.from({ length: 125 }, (_, i) => filled(`sa-${i}`, 1000, "B"));
    const content = buildBatchLlmContent(records);
    const parts = content.split("\n\n---\n\n");

    expect(parts[0]).toBe("Subagent batch completed: 125 finished, 0 failed, 0 cancelled.");
    expect(parts).toHaveLength(126);
    for (let i = 0; i < 125; i++) {
      // 头行 + 指针行紧邻（kept=0 → 无正文、无省略号）
      expect(parts[i + 1]).toBe(
        `Subagent "worker-sa-${i}" (sa-${i}) completed. Result:\n${pointer(`sa-${i}`, 0, 1000, 0)}`,
      );
    }
    // 正文零残留（kept=0）
    expect(content).not.toContain("BBBB");
    expect(content).not.toContain("…");
  });

  it("指针行格式（第一段 per-item 截断同样接指针）：omitted = total − kept", () => {
    // 2 成员各 5000：Σ=8000 ≤ 24000 不收紧，per-item 截 4000
    const records = [filled("sa-aaa", 5000), filled("sa-bbb", 5000)];
    const parts = buildBatchLlmContent(records).split("\n\n---\n\n");
    for (const rec of records) {
      expect(parts).toContain(expectedEntry(rec, "A".repeat(5000), PER_ITEM, PER_ITEM));
    }
    expect(parts[1]).toContain(pointer("sa-aaa", 4000, 5000, PER_ITEM)); // 1,000 of 5,000
  });

  it("长短参差（1 短 500 + 6 长 6000）：统一收紧 3428，短条目足额保留——非瀑布分配", () => {
    // Σ(per-item 后) = 500 + 6×4000 = 24500 > 24000 → 触发收紧
    const shortOne = filled("sa-short", 500, "S");
    const longs = Array.from({ length: 6 }, (_, i) => filled(`sa-long-${i}`, 6000));
    const records = [shortOne, ...longs];
    const content = buildBatchLlmContent(records);
    const parts = content.split("\n\n---\n\n");

    expect(parts[0]).toBe("Subagent batch completed: 7 finished, 0 failed, 0 cancelled.");
    // 短条目：500 < 3428 足额全文，无截断
    expect(parts[1]).toBe(expectedEntry(shortOne, "S".repeat(500), 500, 3428));
    expect(parts[1]).not.toContain("[truncated");
    // 长条目：统一收紧到同一 effectivePerItem = 3428
    for (let i = 0; i < 6; i++) {
      expect(parts[i + 2]).toBe(expectedEntry(longs[i], "A".repeat(6000), 3428, 3428));
    }
  });

  it("确定性：同输入同输出；打乱条目顺序不改变各条目自身截断结果", () => {
    const records = [
      filled("sa-a", 6000),
      filled("sa-b", 500), // 短
      filled("sa-c", 6000),
      filled("sa-d", 6000),
      filled("sa-e", 3000),
      filled("sa-f", 6000),
      filled("sa-g", 6000),
    ];
    const run1 = buildBatchLlmContent(records);
    const run2 = buildBatchLlmContent(records);
    expect(run1).toBe(run2); // 同输入同输出

    const entryOf = (content: string, id: string): string =>
      content.split("\n\n---\n\n").find((p) => p.includes(`(${id})`)) ?? "";
    const reversed = buildBatchLlmContent([...records].reverse());
    for (const rec of records) {
      // 统一收紧与顺序无关：每条目内容在两种排布下逐字节一致
      expect(entryOf(reversed, rec.id)).toBe(entryOf(run1, rec.id));
    }
  });

  it("totalChars 口径：仅计条目正文之和——Σ=23898 < 24000 时包装开销（批头/头行/指针行/分隔符）不触发收紧", () => {
    // 整条通知实际字节数 ≈ 23898 + 批头 ~60 + 头行 7×~45 + 分隔符 ~80 > 24000，
    // 但预算判定只看正文和 → 不收紧
    const records = Array.from({ length: 6 }, (_, i) => filled(`sa-${i}`, 3983));
    const content = buildBatchLlmContent(records);
    expect(content.length).toBeGreaterThan(TOTAL); // 整体确实超了 totalChars
    expect(content).not.toContain("[truncated"); // 却不收紧
    for (let i = 0; i < 6; i++) {
      expect(content).toContain("A".repeat(3983)); // 全量正文在场
    }
  });

  it("Σ=24000 恰好等于 totalChars：不算超（> 才收紧），6×4000 全量在场零指针行", () => {
    const records = Array.from({ length: 6 }, (_, i) => filled(`sa-${i}`, 4000));
    const content = buildBatchLlmContent(records);
    expect(content).not.toContain("[truncated");
    const parts = content.split("\n\n---\n\n");
    for (let i = 0; i < 6; i++) {
      expect(parts[i + 1]).toBe(expectedEntry(records[i], "A".repeat(4000), 4000, PER_ITEM));
    }
  });

  it("失败成员不入正文预算：failed error 全文原样，且不计入 Σ——成功条目 kept=4000 而非收紧 3428", () => {
    const failedOne = member("sa-bad", { outcome: "failed", error: "boom".repeat(2000) });
    const longs = Array.from({ length: 6 }, (_, i) => filled(`sa-${i}`, 6000));
    const records = [failedOne, ...longs];
    // 成功正文 Σ(per-item 后) = 6×4000 = 24000 ≤ 24000 → 不收紧；若把 failed error
    //（8000）计入 Σ = 32000 > 24000 → 会收紧至 3428。断言 kept=4000 即锁住口径。
    const content = buildBatchLlmContent(records);
    const parts = content.split("\n\n---\n\n");
    expect(parts[0]).toBe("Subagent batch completed: 6 finished, 1 failed, 0 cancelled.");
    // failed 条目：error 全文原样、无截断无指针
    expect(content).toContain(`Subagent "worker-sa-bad" (sa-bad) failed: ${"boom".repeat(2000)}`);
    const failedPart = parts.find((p) => p.includes("(sa-bad)")) ?? "";
    expect(failedPart).not.toContain("[truncated");
    // 成功条目：仅第一段 per-item 截断（kept=4000），未被第二段收紧
    for (let i = 0; i < 6; i++) {
      expect(parts).toContain(expectedEntry(longs[i], "A".repeat(6000), 4000, PER_ITEM));
      expect(content).toContain(pointer(`sa-${i}`, 4000, 6000, PER_ITEM)); // 2,000 of 6,000
    }
    expect(content).not.toContain("2,572 of 6,000"); // 3428 收紧形态未出现
  });

  it("极短 result 的既有形态零回归：不触预算时输出与 U3 基线逐字节一致", () => {
    const records = [member("sa-1"), member("sa-2")];
    const content = buildBatchLlmContent(records);
    expect(content).toBe(
      [
        "Subagent batch completed: 2 finished, 0 failed, 0 cancelled.",
        'Subagent "worker-sa-1" (sa-1) completed. Result:\nresult of sa-1',
        'Subagent "worker-sa-2" (sa-2) completed. Result:\nresult of sa-2',
      ].join("\n\n---\n\n"),
    );
  });
});

// ─── C3 指针行 limit 随附（adversarial-review-fixes §3.4 C3）───

describe("buildBatchLlmContent 指针行 limit 随附（C3：预算 > session_read 默认 8000 时附，≤ 不附）", () => {
  it("perItemChars=12000（>8000）：指针行 JSON 附 \"limit\":12000——模型照抄即取回 ≥ 默认值的有效正文", () => {
    // 2 成员各 15000：Σ=24000 ≤ totalChars=48000 不收紧 → effectivePerItem = 12000
    const records = [filled("sa-big", 15000), filled("sa-big2", 15000)];
    const content = buildBatchLlmContent(records, { perItemChars: 12000, totalChars: 48000 });
    expect(content).toContain(
      `[truncated 3,000 of 15,000 chars — full result: session_read {"action":"result","session":"sa-big","limit":12000}]`,
    );
    expect(content).toContain(`"session":"sa-big2","limit":12000`);
  });

  it("perItemChars=4000（默认，≤8000）：指针行无 limit 字段（默认已覆盖，避免噪音）", () => {
    const records = [filled("sa-a", 5000)];
    const content = buildBatchLlmContent(records);
    expect(content).toContain(
      `[truncated 1,000 of 5,000 chars — full result: session_read {"action":"result","session":"sa-a"}]`,
    );
    expect(content).not.toContain(`"limit"`);
  });

  it("收紧后 effectivePerItem=3428（≤8000）：同样不附 limit——判定看收紧后的实际预算", () => {
    const records = Array.from({ length: 7 }, (_, i) => filled(`sa-${i}`, 6000));
    const content = buildBatchLlmContent(records);
    expect(content).toContain(`"session":"sa-0"}`);
    expect(content).not.toContain(`"limit"`);
  });
});
