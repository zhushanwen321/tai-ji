// [subagent-observability §3.3.7①] 轮应答正文五分支事实化的行为锁（u4 验收②文案面）：
// 失败 / 中止 / 被接管 / 空正文 / 正常——轮应答不再硬编码 `finished a round`（故障 B
// 呈现面废除）；失败轮写失败摘要 + FailureCause 点拼 + 恢复指引（UC-4/UC-5/UC-15）。
// 直测 createNotifier.notify（真实 port.deliver 通路——payload.details 即 BgNotifyRecord）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNotifier, type BgNotifier, type BgNotifyRecord, type NotifierHost } from "../notify/notifier.ts";
import { configureNotifyDomain, resetNotifyDomainForTests } from "../../core/notify-ports.ts";

/** 捕获 port.deliver envelope 的最小 fake（content 判定的观察侧）。 */
function makeFakePort() {
  const contents: string[] = [];
  const handle = {
    deliver: (envelope: { payload: { content: string } }) => {
      contents.push(envelope.payload.content);
      return { kind: "accepted" as const, id: envelope.payload.content };
    },
    flush: () => {},
  };
  return { handle, contents };
}

function makeHost(): NotifierHost {
  return { sendMessage: () => {}, isIdle: () => true };
}

/** 轮次通知基底（running 形态——轮终通知载荷）。 */
function roundRecord(overrides: Partial<BgNotifyRecord> = {}): BgNotifyRecord {
  return {
    id: "sa-round-1",
    status: "running",
    agent: "w",
    round: 3,
    result: "round text",
    startedAt: 1,
    endedAt: 2,
    ...overrides,
  };
}

describe("[§3.3.7①] 轮应答正文五分支事实化", () => {
  let fake: ReturnType<typeof makeFakePort>;
  let notifier: BgNotifier;

  beforeEach(() => {
    resetNotifyDomainForTests();
    fake = makeFakePort();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle as never });
    notifier = createNotifier(makeHost());
  });

  afterEach(() => {
    notifier.dispose();
  });

/** 取唯一一条已投递正文。 */
function sentContent(): string {
  expect(fake.contents).toHaveLength(1);
  return fake.contents[0]!;
}

/** 子串出现次数（恢复指引「恰好一段」断言的计数原语）。 */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

  it("③ 失败轮：失败摘要 + FailureCause 点拼 + 恢复指引；transcript 指针在场", () => {
    notifier.notify(roundRecord({
      result: "",
      error: "429 too many requests",
      lastRoundFailure: { class: "provider", kind: "rate_limited", retryable: "conditional", retryAfterMs: 1200, raw: "429 too many requests" },
      sessionFile: "/tmp/s.jsonl",
    }));
    const content = sentContent();
    expect(content).toContain("failed (provider.rate_limited)");
    expect(content).toContain("429 too many requests");
    expect(content).toContain("Recovery: re-send your message");
    // 恢复指引恰好一段（载荷 error 嵌尾 + 正文尾段 = 双段指引的双拼防线锚）；
    // ③ 支正文统一走轮应答指引（ROUND_REPLY_RECOVERY_TAIL），不混旧收尾语义词。
    expect(countOccurrences(content, "Recovery: re-send your message")).toBe(1);
    expect(content).not.toContain("action:'close'");
    expect(content).not.toContain("action:'list'");
    expect(content).toContain("Full transcript: /tmp/s.jsonl");
    expect(content).not.toContain("finished a round");
  });

  it("② 中止轮（user.cancelled）：「本轮被中止」+ 来源；无 transcript 指针", () => {
    notifier.notify(roundRecord({
      result: "",
      lastRoundFailure: { class: "user", kind: "cancelled", retryable: false, raw: "user abort" },
      sessionFile: "/tmp/s.jsonl",
    }));
    const content = sentContent();
    expect(content).toContain("was aborted (cancelled by user)");
    expect(content).not.toContain("Full transcript");
    expect(content).not.toContain("finished a round");
  });

  it("② 中止轮迁移期回落（aborted 停因、无 failure 分类事实）：维持取消文案", () => {
    notifier.notify(roundRecord({ result: "", lastRoundStopReason: "aborted" }));
    expect(sentContent()).toContain("was aborted (aborted)");
  });

  it("取消支判据事实优先：aborted 停因但带 engine 失败分类 → 走失败分支全文案（分类与恢复指引不丢，§3.3.7①）", () => {
    notifier.notify(roundRecord({
      result: "",
      error: "engine aborted abnormally",
      lastRoundStopReason: "aborted",
      lastRoundFailure: { class: "engine", kind: "engine_aborted", retryable: false, raw: "engine aborted abnormally" },
      sessionFile: "/tmp/s.jsonl",
    }));
    const content = sentContent();
    // 失败分支（③）：失败摘要 + cause 点拼 + 恢复指引 + transcript 指针；
    // 不再被 aborted 停因吸进中止简短文案（修复前 = 「was aborted (aborted)」丢分类）。
    expect(content).toContain("failed (engine.engine_aborted)");
    expect(content).toContain("engine aborted abnormally");
    expect(content).toContain("Recovery: re-send your message");
    expect(countOccurrences(content, "Recovery: re-send your message")).toBe(1);
    expect(content).toContain("Full transcript: /tmp/s.jsonl");
    expect(content).not.toContain("was aborted");
  });

  it("③' 迁移期回落（轮失败、分类事实缺席）：失败摘要 + 恢复指引恰好一段（error 原文不嵌尾）", () => {
    // settleRoundFailed 载荷 error = 失败摘要原文（指引由五分支尾部单点承载）——
    // 本支若 error 嵌尾即 FAILURE_RECOVERY_TAIL 双拼，单次计数是双拼防线锚。
    notifier.notify(roundRecord({
      result: "",
      error: "round did not complete: engine_crashed: child died",
      sessionFile: "/tmp/s.jsonl",
    }));
    const content = sentContent();
    expect(content).toContain("failed: round did not complete: engine_crashed: child died");
    expect(countOccurrences(content, "Recovery: re-send your message")).toBe(1);
    expect(content).toContain("Full transcript: /tmp/s.jsonl");
  });

  it("① 被接管轮（promptDisposition=handled）：接管事实——引擎未执行，无成败词", () => {
    notifier.notify(roundRecord({
      result: "",
      lastRoundDisposition: "handled",
      sessionFile: "/tmp/s.jsonl",
    }));
    const content = sentContent();
    expect(content).toContain("was taken over by an extension");
    expect(content).toContain("handled");
    expect(content).not.toContain("completed");
    expect(content).not.toContain("failed");
  });

  it("④ 正常轮空正文：「本轮完成，无文本输出」简短事实（UC-15——不告警不谎报）", () => {
    notifier.notify(roundRecord({ result: "" }));
    const content = sentContent();
    expect(content).toContain("completed with no text output");
    expect(content).not.toContain("finished a round");
  });

  it("⑤ 正常轮：结果正文 + round 标签（多轮与 one-shot 同形）", () => {
    notifier.notify(roundRecord({ round: 3, result: "round text", sessionFile: "/tmp/s.jsonl" }));
    const content = sentContent();
    expect(content).toBe(
      'Subagent "w" (sa-round-1) round 3 completed. Reply:\nround text' +
      "\n\nFull transcript: /tmp/s.jsonl",
    );
  });

  it("回归锚：任何分支都不再产出 `finished a round` 硬编码文案", () => {
    const samples: Array<Partial<BgNotifyRecord>> = [
      { result: "ok" },
      { result: "", lastRoundFailure: { class: "provider", kind: "rate_limited", retryable: "conditional", retryAfterMs: 1, raw: "429" } },
      { result: "", lastRoundStopReason: "aborted" },
      { result: "", lastRoundDisposition: "handled" },
      { result: "" },
    ];
    for (const overrides of samples) {
      notifier.notify(roundRecord(overrides));
    }
    expect(fake.contents).toHaveLength(samples.length);
    for (const content of fake.contents) {
      expect(content).not.toContain("finished a round");
    }
  });
});

describe("[§3.3.7①] 迁移期回落：轮收条缺席（无轮事实字段）回落正常轮形态", () => {
  it("无 lastRound 事实 + result 有值 → 正常轮文案（不误判失败/中止）", () => {
    resetNotifyDomainForTests();
    const fake = makeFakePort();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle as never });
    const notifier = createNotifier(makeHost());
    notifier.notify(roundRecord({ result: "legacy reply" }));
    expect(fake.contents[0]).toContain("completed. Reply:\nlegacy reply");
    notifier.dispose();
  });
});
