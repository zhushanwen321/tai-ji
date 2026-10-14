// tool-execute.test.ts —— 工具 execute 的 marker 往返与错误闭环（设计 §3.1(2) 通道）：
// 宿主门 / 参数分派 / marker 载荷形状 / enter 引导协议 / mutate 拒绝与通道错误 throw。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_MARKER } from "@zhushanwen/extension-protocol";

import {
  lastMarkerCall,
  mountCanvas,
  toolOf,
  withExtLogEnv,
  type ToolHarness,
} from "./helpers/canvas-harness.js";

describe("宿主门（select 前置，禁超时探测）", () => {
  let harness: ToolHarness;
  beforeEach(() => {
    harness = mountCanvas();
  });

  it("env 缺失：抛「画布需要 taiji 宿主」，select 未被调用", async () => {
    await withExtLogEnv(undefined, async () => {
      const enter = toolOf(harness, "canvas_enter");
      await expect(
        enter.execute("t1", { statement: "s", criterias: ["c"], scope: [] }, undefined, undefined, harness.ctx),
      ).rejects.toThrow("画布需要 taiji 宿主");
      expect(harness.selectMock).not.toHaveBeenCalled();
    });
  });

  it("env=1 但 mode=tui：拒绝进入 select（env 泄漏形态）", async () => {
    await withExtLogEnv("1", async () => {
      const read = toolOf(harness, "canvas_read");
      await expect(
        read.execute("t1", { canvasId: "c1" }, undefined, undefined, {
          ...harness.ctx,
          mode: "tui" as const,
        }),
      ).rejects.toThrow("画布需要 taiji 宿主");
      expect(harness.selectMock).not.toHaveBeenCalled();
    });
  });
});

describe("canvas_enter 双形态 marker 往返", () => {
  let harness: ToolHarness;
  beforeEach(() => {
    harness = mountCanvas();
  });

  it("创建形态：payload={action:'create', params:{statement,criterias,scopeExclusions}}（scope→scopeExclusions 映射），结果文本带工具检索引导", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(
        JSON.stringify({ ok: true, eventId: "e1", evType: "CanvasCreated", summary: "created" }),
      );
      const enter = toolOf(harness, "canvas_enter");
      const result = (await enter.execute(
        "t1",
        { statement: "多引擎支持怎么落地", criterias: ["c1"], scope: ["不做 UI"] },
        undefined,
        undefined,
        harness.ctx,
      )) as { content: Array<{ type: string; text: string }> };
      const call = lastMarkerCall(harness.selectMock);
      expect(call.marker).toBe(CANVAS_MARKER);
      expect(call.payload).toEqual({
        action: "create",
        params: { statement: "多引擎支持怎么落地", criterias: ["c1"], scopeExclusions: ["不做 UI"] },
      });
      expect(result.content[0].text).toContain("tool_search");
      expect(result.content[0].text).toContain("canvas_edit / canvas_read / canvas_review / canvas_export");
    });
  });

  it("创建形态 name 可选透传；打开形态 payload={action:'enter', params:{canvasId}}", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(JSON.stringify({ canvasId: "c9", name: "n", nodes: [] }));
      const enter = toolOf(harness, "canvas_enter");
      await enter.execute("t1", { canvasId: "c9" }, undefined, undefined, harness.ctx);
      expect(lastMarkerCall(harness.selectMock).payload).toEqual({ action: "enter", params: { canvasId: "c9" } });
    });
  });

  it("两形态互斥：canvasId 与 statement 同传 → 结构化错误，不进入 select", async () => {
    await withExtLogEnv("1", async () => {
      const enter = toolOf(harness, "canvas_enter");
      await expect(
        enter.execute(
          "t1",
          { canvasId: "c1", statement: "s", criterias: ["c"], scope: [] },
          undefined,
          undefined,
          harness.ctx,
        ),
      ).rejects.toThrow("invalid_params");
      expect(harness.selectMock).not.toHaveBeenCalled();
    });
  });

  it("缺创建三要素 → 结构化错误（invalid_params + 恢复动作）", async () => {
    await withExtLogEnv("1", async () => {
      const enter = toolOf(harness, "canvas_enter");
      await expect(
        enter.execute("t1", {}, undefined, undefined, harness.ctx),
      ).rejects.toThrow("恢复动作");
      await expect(
        enter.execute("t1", { statement: "s" }, undefined, undefined, harness.ctx),
      ).rejects.toThrow("invalid_params");
      expect(harness.selectMock).not.toHaveBeenCalled();
    });
  });
});

describe("canvas_edit 五 action 分派", () => {
  let harness: ToolHarness;
  beforeEach(() => {
    harness = mountCanvas();
  });

  it("grow：payload 按契约组装（batch/reason 透传）", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(JSON.stringify({ ok: true, eventId: "e2", evType: "NodeCreated", summary: "grown" }));
      const edit = toolOf(harness, "canvas_edit");
      const batch = [{ id: "n1", type: "question", content: "q", attachTo: "root", edge: "decompose" }];
      await edit.execute(
        "t1",
        { action: "grow", growParams: { canvasId: "c1", batch, reason: "MECE 分解" } },
        undefined,
        undefined,
        harness.ctx,
      );
      expect(lastMarkerCall(harness.selectMock).payload).toEqual({
        action: "grow",
        params: { canvasId: "c1", batch, reason: "MECE 分解" },
      });
    });
  });

  it("action 与参数块缺失 → 结构化错误（五 action 各自报块名）", async () => {
    await withExtLogEnv("1", async () => {
      const edit = toolOf(harness, "canvas_edit");
      for (const [action, block] of [
        ["grow", "growParams"],
        ["patch", "patchParams"],
        ["select", "selectParams"],
        ["transition", "transitionParams"],
        ["comment-respond", "commentRespondParams"],
      ] as const) {
        await expect(
          edit.execute("t1", { action }, undefined, undefined, harness.ctx),
        ).rejects.toThrow(block);
      }
      expect(harness.selectMock).not.toHaveBeenCalled();
    });
  });
});

describe("canvas_review / canvas_export / canvas_list 转译", () => {
  let harness: ToolHarness;
  beforeEach(() => {
    harness = mountCanvas();
  });

  it("review resolve：payload={action:'review-resolve', params 透传}", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(JSON.stringify({ ok: true, eventId: "e3", evType: "ReviewEntryResolved", summary: "r" }));
      const review = toolOf(harness, "canvas_review");
      await review.execute(
        "t1",
        { action: "resolve", resolveParams: { canvasId: "c1", entryId: "rv-1", disposition: "accepted", note: "已修" } },
        undefined,
        undefined,
        harness.ctx,
      );
      expect(lastMarkerCall(harness.selectMock).payload).toEqual({
        action: "review-resolve",
        params: { canvasId: "c1", entryId: "rv-1", disposition: "accepted", note: "已修" },
      });
    });
  });

  it("review append：payload={action:'review-append', params 透传}", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(JSON.stringify({ ok: true, eventId: "e4", evType: "ReviewEntryAppended", summary: "a" }));
      const review = toolOf(harness, "canvas_review");
      await review.execute(
        "t1",
        {
          action: "append",
          appendParams: {
            canvasId: "c1",
            round: 1,
            entries: [{ id: "rv-1", dimension: "support", severity: "must-fix", targetId: "n1", note: "悬空" }],
          },
        },
        undefined,
        undefined,
        harness.ctx,
      );
      expect(lastMarkerCall(harness.selectMock).payload).toEqual({
        action: "review-append",
        params: {
          canvasId: "c1",
          round: 1,
          // 契约收口：逐条注入 round（CanvasReviewEntryInput 幂等锚点）
          entries: [{ id: "rv-1", dimension: "support", severity: "must-fix", targetId: "n1", note: "悬空", round: 1 }],
        },
      });
    });
  });

  it("review run：达上限停回（read 后 review.status=max-rounds）→ 短路返回停回说明，不派 reviewer", async () => {
    await withExtLogEnv("1", async () => {
      // marker 两跳：review-request（达上限 = 合法终态转移，mutate 成功）→ read（max-rounds 态）
      harness.selectMock
        .mockResolvedValueOnce(JSON.stringify({ ok: true, eventId: "e6", evType: "ReviewRequested", summary: "已达轮次上限（5 轮）：已置终态 max-rounds 停回用户" }))
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
              stopNote: "审查已达轮次上限（5 轮）未收敛，停回用户裁决",
              recoverHint: "升级裁决（扩大审查范围或修改完成判据）后重新发起审查（画布「发起审查」入口，用户操作）",
            },
            converged: false,
            createdAt: "2026-10-15T00:00:00Z",
            updatedAt: "2026-10-15T00:00:00Z",
          }),
        );
      // service 槽 = 陷阱：停回态下 reviewer 不得被派发（本轮没有开始）
      const SLOT_KEY = Symbol.for("@zhushanwen/subagent-core.service");
      const dispatch = vi.fn();
      (globalThis as Record<symbol, unknown>)[SLOT_KEY] = { executeAndAwait: dispatch };
      try {
        const review = toolOf(harness, "canvas_review");
        const result = (await review.execute("t1", { action: "run", runParams: { canvasId: "c1" } }, undefined, undefined, harness.ctx)) as {
          content: Array<{ type: string; text: string }>;
        };
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        expect(payload.stopped).toBe(true);
        expect(payload.status).toBe("max-rounds");
        expect(String(payload.stopNote)).toContain("轮次上限");
        expect(String(payload.recoverHint)).toContain("升级裁决");
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        delete (globalThis as Record<symbol, unknown>)[SLOT_KEY];
      }
    });
  });

  it("export 需求卡缺 leafId → 结构化错误；planning-doc 正常映射", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(JSON.stringify({ ok: true, eventId: "e5", evType: "CanvasExported", summary: "x" }));
      const exp = toolOf(harness, "canvas_export");
      await expect(
        exp.execute("t1", { canvasId: "c1", target: "requirement-card" }, undefined, undefined, harness.ctx),
      ).rejects.toThrow("invalid_params");
      await exp.execute("t1", { canvasId: "c1", target: "planning-doc" }, undefined, undefined, harness.ctx);
      expect(lastMarkerCall(harness.selectMock).payload).toEqual({
        action: "export",
        params: { canvasId: "c1", target: { target: "planning-doc" } },
      });
    });
  });

  it("list：空参数 payload，marker 一致", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(JSON.stringify({ canvases: [] }));
      const list = toolOf(harness, "canvas_list");
      await list.execute("t1", {}, undefined, undefined, harness.ctx);
      const call = lastMarkerCall(harness.selectMock);
      expect(call.marker).toBe(CANVAS_MARKER);
      expect(call.payload).toEqual({ action: "list", params: {} });
    });
  });
});

describe("错误闭环（禁止错误成功模式）", () => {
  let harness: ToolHarness;
  beforeEach(() => {
    harness = mountCanvas();
  });

  it("mutate 领域拒绝（ok:false）：throw 且消息含错误码与恢复动作", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(
        JSON.stringify({
          ok: false,
          error: { code: "selection_conflict", message: "该问题已有选定方案", recover: "换选走 replace 参数" },
        }),
      );
      const edit = toolOf(harness, "canvas_edit");
      await expect(
        edit.execute(
          "t1",
          {
            action: "select",
            selectParams: { canvasId: "c1", questionId: "q1", optionId: "o2", reason: "r" },
          },
          undefined,
          undefined,
          harness.ctx,
        ),
      ).rejects.toThrow(/\[selection_conflict\].*恢复动作/s);
    });
  });

  it("runtime 结构化错误回包（{error,hint}）：throw formatChannelErrorText 形态", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(JSON.stringify({ error: "boom", hint: "check runtime" }));
      const list = toolOf(harness, "canvas_list");
      await expect(list.execute("t1", {}, undefined, undefined, harness.ctx)).rejects.toThrow("boom");
    });
  });

  it("select resolve undefined（取消/超时折叠）：throw，不静默成功", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(undefined);
      const list = toolOf(harness, "canvas_list");
      await expect(list.execute("t1", {}, undefined, undefined, harness.ctx)).rejects.toThrow(/cancelled or channel error/);
    });
  });

  it("非 JSON 回包：throw 协议漂移提示", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue("<html>gateway</html>");
      const list = toolOf(harness, "canvas_list");
      await expect(list.execute("t1", {}, undefined, undefined, harness.ctx)).rejects.toThrow(/non-JSON/);
    });
  });

  it("无墙钟超时：select 选项不携带 timeout（任务级正常路径不设时限）", async () => {
    await withExtLogEnv("1", async () => {
      harness.selectMock.mockResolvedValue(JSON.stringify({ canvases: [] }));
      const list = toolOf(harness, "canvas_list");
      await list.execute("t1", {}, undefined, undefined, harness.ctx);
      const opts = harness.selectMock.mock.calls[0][2] as { timeout?: number } | undefined;
      expect(opts?.timeout).toBeUndefined();
    });
  });
});
