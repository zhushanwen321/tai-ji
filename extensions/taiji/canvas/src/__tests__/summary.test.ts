// summary.test.ts —— 六工具 details.summary 产出与 summary 纯函数文案（GUI 对话流
// 收起态摘要的产出侧契约）：execute 组装断言走 harness（marker 往返），数据缺失
// 分支直接测纯函数（形状漂移退化为无后缀短文案，不抛错）。

import { beforeEach, describe, expect, it } from "vitest";

import {
  canvasEditSummary,
  canvasEnterSummary,
  canvasExportSummary,
  canvasListSummary,
  canvasReadSummary,
  canvasReviewSummary,
} from "../summary.js";

import {
  mountCanvas,
  toolOf,
  withExtLogEnv,
  type ToolHarness,
} from "./helpers/canvas-harness.js";

describe("execute 组装 details.summary（六工具全路径）", () => {
  let harness: ToolHarness;
  beforeEach(() => {
    harness = mountCanvas();
  });

  it("canvas_enter 创建形态（params.name 可得）", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(
        JSON.stringify({ ok: true, eventId: "e1", evType: "CanvasCreated", summary: "created" }),
      );
      const enter = toolOf(harness, "canvas_enter");
      const result = (await enter.execute(
        "t1",
        { name: "多引擎支持", statement: "s", criterias: ["c"], scope: [] },
        undefined,
        undefined,
        harness.ctx,
      )) as { details: { summary: string } };
      expect(result.details.summary).toBe('Entered canvas "多引擎支持"');
    });
  });

  it("canvas_enter 打开形态（reply=CanvasState.name 优先于 params）", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(
        JSON.stringify({ canvasId: "c9", name: "已有画布", nodes: [] }),
      );
      const enter = toolOf(harness, "canvas_enter");
      const result = (await enter.execute("t1", { canvasId: "c9" }, undefined, undefined, harness.ctx)) as {
        details: { summary: string };
      };
      expect(result.details.summary).toBe('Entered canvas "已有画布"');
    });
  });

  it("canvas_edit grow 带 batch 数量；patch 无数量语义", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(
        JSON.stringify({ ok: true, eventId: "e2", evType: "NodeCreated", summary: "grown" }),
      );
      const edit = toolOf(harness, "canvas_edit");
      const batch = [
        { id: "n1", type: "question", content: "q", attachTo: "root", edge: "decompose" },
        { id: "n2", type: "option", content: "o", attachTo: "root", edge: "resolve" },
      ];
      const growResult = (await edit.execute(
        "t1",
        { action: "grow", growParams: { canvasId: "c1", batch, reason: "r" } },
        undefined,
        undefined,
        harness.ctx,
      )) as { details: { summary: string } };
      expect(growResult.details.summary).toBe("Canvas edited · +2 nodes");

      const patchResult = (await edit.execute(
        "t1",
        { action: "patch", patchParams: { canvasId: "c1", nodeId: "n1", reason: "r" } },
        undefined,
        undefined,
        harness.ctx,
      )) as { details: { summary: string } };
      expect(patchResult.details.summary).toBe("Canvas edited");
    });
  });

  it("canvas_read 带 name 与节点数", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(
        JSON.stringify({ canvasId: "c1", name: "多引擎支持", nodes: [{ id: "root" }, { id: "n1" }] }),
      );
      const read = toolOf(harness, "canvas_read");
      const result = (await read.execute("t1", { canvasId: "c1" }, undefined, undefined, harness.ctx)) as {
        details: { summary: string };
      };
      expect(result.details.summary).toBe('Read canvas "多引擎支持" · 2 nodes');
    });
  });

  it("canvas_review resolve：条目 id + 处置结论", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(
        JSON.stringify({ ok: true, eventId: "e3", evType: "ReviewEntryResolved", summary: "r" }),
      );
      const review = toolOf(harness, "canvas_review");
      const result = (await review.execute(
        "t1",
        { action: "resolve", resolveParams: { canvasId: "c1", entryId: "rv-1", disposition: "accepted", note: "已修" } },
        undefined,
        undefined,
        harness.ctx,
      )) as { details: { summary: string } };
      expect(result.details.summary).toBe("Review resolved rv-1 (accepted)");
    });
  });

  it("canvas_review append：条目数 + must-fix 计数（params 侧统计）", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(
        JSON.stringify({ ok: true, eventId: "e4", evType: "ReviewEntryAppended", summary: "a" }),
      );
      const review = toolOf(harness, "canvas_review");
      const result = (await review.execute(
        "t1",
        {
          action: "append",
          appendParams: {
            canvasId: "c1",
            round: 1,
            entries: [
              { id: "rv-1", dimension: "support", severity: "must-fix", targetId: "e1", note: "n" },
              { id: "rv-2", dimension: "depth", severity: "suggestion", targetId: "n1", note: "n" },
              { id: "rv-3", dimension: "conflict", severity: "must-fix", targetId: "n2", note: "n" },
            ],
          },
        },
        undefined,
        undefined,
        harness.ctx,
      )) as { details: { summary: string } };
      expect(result.details.summary).toBe("Review appended 3 entries · 2 must-fix");
    });
  });

  it("canvas_review run：编排产物带轮次与写回条目数", async () => {
    await withExtLogEnv("1", async () => {
      // marker 三跳：review-request（留痕 mutate）→ read（全量，R1）→ review-append（写回 mutate）
      harness.selectMock
        .mockResolvedValueOnce(JSON.stringify({ ok: true, eventId: "e6", evType: "ReviewRequested", summary: "req" }))
        .mockResolvedValueOnce(
          JSON.stringify({
            canvasId: "c1",
            name: "多引擎支持",
            root: { nodeId: "root", statement: "s", criterias: ["c"], scopeExclusions: [] },
            direction: null,
            nodes: [],
            edges: [],
            comments: [],
            dirtyPaths: [],
            review: null,
            converged: false,
            createdAt: "2026-10-17T00:00:00Z",
            updatedAt: "2026-10-17T00:00:00Z",
          }),
        )
        .mockResolvedValueOnce(JSON.stringify({ ok: true, eventId: "e7", evType: "ReviewEntryAppended", summary: "app" }));
      const SLOT_KEY = Symbol.for("@zhushanwen/subagent-core.service");
      // 槽值形状 = { current: service } 持有者（service-bootstrap getServiceSlot），
      // getSubagentService() 解 .current——直接放 service 本体会取不到
      (globalThis as Record<symbol, unknown>)[SLOT_KEY] = {
        current: {
          executeAndAwait: async () => ({
            parsedOutput: {
              entries: [{ id: "rv-1", dimension: "support", severity: "must-fix", targetId: "e1", note: "n" }],
              summary: "总体判断",
            },
          }),
        },
      };
      try {
        const review = toolOf(harness, "canvas_review");
        const result = (await review.execute(
          "t1",
          { action: "run", runParams: { canvasId: "c1" } },
          undefined,
          undefined,
          harness.ctx,
        )) as { details: { summary: string } };
        expect(result.details.summary).toBe("Review round 1 · +1 entries");
      } finally {
        delete (globalThis as Record<symbol, unknown>)[SLOT_KEY];
      }
    });
  });

  it("canvas_review run：达轮次上限停回短路带状态词", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock
        .mockResolvedValueOnce(JSON.stringify({ ok: true, eventId: "e6", evType: "ReviewRequested", summary: "已达上限" }))
        .mockResolvedValueOnce(
          JSON.stringify({
            canvasId: "c1",
            name: "多引擎支持",
            root: { nodeId: "root", statement: "s", criterias: ["c"], scopeExclusions: [] },
            direction: null,
            nodes: [],
            edges: [],
            comments: [],
            dirtyPaths: [],
            review: {
              status: "max-rounds",
              round: 5,
              maxRounds: 5,
              entries: [],
              stopNote: "停回用户裁决",
              recoverHint: "升级裁决后重发",
            },
            converged: false,
            createdAt: "2026-10-17T00:00:00Z",
            updatedAt: "2026-10-17T00:00:00Z",
          }),
        );
      const review = toolOf(harness, "canvas_review");
      const result = (await review.execute(
        "t1",
        { action: "run", runParams: { canvasId: "c1" } },
        undefined,
        undefined,
        harness.ctx,
      )) as { details: { summary: string } };
      expect(result.details.summary).toBe("Review stopped: max-rounds");
    });
  });

  it("canvas_export 按目标形态呈现（导出文件路径不在 mutate 回包内，不虚构）", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(
        JSON.stringify({ ok: true, eventId: "e5", evType: "CanvasExported", summary: "x" }),
      );
      const exp = toolOf(harness, "canvas_export");
      const docResult = (await exp.execute(
        "t1",
        { canvasId: "c1", target: "planning-doc" },
        undefined,
        undefined,
        harness.ctx,
      )) as { details: { summary: string } };
      expect(docResult.details.summary).toBe("Exported planning-doc");

      const cardResult = (await exp.execute(
        "t1",
        { canvasId: "c1", target: "requirement-card", leafId: "leaf-9" },
        undefined,
        undefined,
        harness.ctx,
      )) as { details: { summary: string } };
      expect(cardResult.details.summary).toBe("Exported requirement-card (leaf leaf-9)");
    });
  });

  it("canvas_list 带清单计数", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(
        JSON.stringify({ canvases: [{ canvasId: "c1" }, { canvasId: "c2" }, { canvasId: "c3" }] }),
      );
      const list = toolOf(harness, "canvas_list");
      const result = (await list.execute("t1", {}, undefined, undefined, harness.ctx)) as {
        details: { summary: string };
      };
      expect(result.details.summary).toBe("Listed 3 canvases");
    });
  });
});

describe("summary 纯函数数据缺失分支（形状漂移退化为短文案，不抛错）", () => {
  it("canvasEnterSummary：reply 与 params 均无名 → 裸文案", () => {
    expect(canvasEnterSummary({ statement: "s", criterias: ["c"], scope: [] }, { ok: true })).toBe("Entered canvas");
    expect(canvasEnterSummary({ statement: "s", criterias: ["c"], scope: [] }, "not-an-object")).toBe("Entered canvas");
  });

  it("canvasEditSummary：grow 缺参数块 / batch 非数组 → 无数量后缀", () => {
    expect(canvasEditSummary({ action: "grow" })).toBe("Canvas edited");
    expect(canvasEditSummary({ action: "select" })).toBe("Canvas edited");
  });

  it("canvasReadSummary：name 缺失 / nodes 非数组 → 逐级省略", () => {
    expect(canvasReadSummary({ name: "n", nodes: "bad" })).toBe('Read canvas "n"');
    expect(canvasReadSummary({})).toBe("Read canvas");
    expect(canvasReadSummary(undefined)).toBe("Read canvas");
  });

  it("canvasReviewSummary run：编排产物缺 round/appended → Review ran；append 缺 entries → Review appended；resolve 缺参数块 → Review resolved", () => {
    expect(canvasReviewSummary({ action: "run" }, { ok: true })).toBe("Review ran");
    expect(canvasReviewSummary({ action: "append" }, { ok: true })).toBe("Review appended");
    expect(canvasReviewSummary({ action: "resolve" }, { ok: true })).toBe("Review resolved");
  });

  it("canvasReviewSummary run 停回：status 缺失 → 无状态词", () => {
    expect(canvasReviewSummary({ action: "run" }, { stopped: true })).toBe("Review stopped");
  });

  it("canvasReviewSummary append：全 suggestion（must-fix 零计数不显示零后缀）", () => {
    expect(
      canvasReviewSummary(
        { action: "append", appendParams: { canvasId: "c", round: 1, entries: [{ id: "a", severity: "suggestion" }] } },
        { ok: true },
      ),
    ).toBe("Review appended 1 entries");
  });

  it("canvasExportSummary：requirement-card 缺 leafId → 通用文案", () => {
    expect(canvasExportSummary({ canvasId: "c", target: "requirement-card" })).toBe("Exported canvas");
  });

  it("canvasListSummary：canvases 缺失/非数组 → 无计数", () => {
    expect(canvasListSummary({})).toBe("Listed canvases");
    expect(canvasListSummary({ canvases: 3 })).toBe("Listed canvases");
  });
});
