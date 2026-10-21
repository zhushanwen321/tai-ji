// model-catalog.test.ts — D4 目录缓存语义：事件边界替换、缓存命中判定、快照兜底、persist entry。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModelCatalogStore, readSnapshotFile, toPersistEntry, type WoolCatalogSnapshot } from "../model-catalog.ts";

function chatModel(id: string) {
	return {
		id,
		name: id,
		api: "wool-test",
		provider: "wool-test",
		baseUrl: "https://upstream.invalid",
		type: "chat" as const,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

describe("createModelCatalogStore（D4 语义）", () => {
	it("初始为空；restore(persist 目录) 恢复为当前清单", () => {
		const store = createModelCatalogStore();
		expect(store.current()).toBeUndefined();
		expect(store.shouldFetchUpstream(false)).toBe(true);

		store.restore({ models: [chatModel("m1")] });
		expect(store.current()?.map((model) => model.id)).toEqual(["m1"]);
		expect(store.lastSource()).toBe("restored");
	});

	it("缓存命中：有清单且非 force → 不发上游；force=true 或空清单 → 发", () => {
		const store = createModelCatalogStore();
		expect(store.shouldFetchUpstream(undefined)).toBe(true);
		store.restore({ models: [chatModel("m1")] });
		expect(store.shouldFetchUpstream(undefined)).toBe(false);
		expect(store.shouldFetchUpstream(false)).toBe(false);
		// force = taiji 显式刷新 / 报错触发路径（D4 两条强制路径）
		expect(store.shouldFetchUpstream(true)).toBe(true);
	});

	it("restore 无 persist 且无快照 → 空清单（首装离线形态）", () => {
		const store = createModelCatalogStore();
		store.restore(undefined);
		expect(store.current()).toEqual([]);
		expect(store.lastSource()).toBe("empty");
	});

	it("restore 无 persist 且有快照 → 快照兜底", () => {
		const store = createModelCatalogStore({
			loadSnapshot: () => ({ family: "qoder", fetchedAt: 1, models: [chatModel("snap-1")] }),
		});
		store.restore(undefined);
		expect(store.current()?.map((model) => model.id)).toEqual(["snap-1"]);
		expect(store.lastSource()).toBe("snapshot");
	});

	it("快照形状非法 → 记录 onSnapshotInvalid，清单置空不炸", () => {
		const invalidReasons: string[] = [];
		const store = createModelCatalogStore({
			loadSnapshot: () => ({ family: "qoder", fetchedAt: 1, models: [{ nope: true }] as unknown as WoolCatalogSnapshot["models"] }),
			onSnapshotInvalid: (reason) => invalidReasons.push(reason),
		});
		store.restore(undefined);
		expect(store.current()).toEqual([]);
		expect(invalidReasons).toHaveLength(1);
	});

	it("replace 为唯一写入口（事件边界替换语义）；无 TTL 判定字段参与逻辑", () => {
		const store = createModelCatalogStore();
		store.restore({ models: [chatModel("m1")] });
		store.replace([chatModel("m2")], "upstream");
		expect(store.current()?.map((model) => model.id)).toEqual(["m2"]);
		expect(store.lastSource()).toBe("upstream");
	});
});

describe("readSnapshotFile（包内快照读入）", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wool-shared-snapshot-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	it("读入合法快照", () => {
		const path = join(dir, "snapshot.json");
		writeFileSync(path, JSON.stringify({ family: "trae", fetchedAt: 42, models: [chatModel("t1")] }));
		const snapshot = readSnapshotFile(path);
		expect(snapshot?.family).toBe("trae");
		expect(snapshot?.models.map((model) => model.id)).toEqual(["t1"]);
	});

	it("文件缺失 / 坏 JSON / 形状非法 → undefined（兜底路径静默降级）", () => {
		expect(readSnapshotFile(join(dir, "missing.json"))).toBeUndefined();

		const badPath = join(dir, "bad.json");
		writeFileSync(badPath, "{not json");
		expect(readSnapshotFile(badPath)).toBeUndefined();

		const shapePath = join(dir, "shape.json");
		writeFileSync(shapePath, JSON.stringify({ family: "x", models: "not-array" }));
		expect(readSnapshotFile(shapePath)).toBeUndefined();
	});
});

describe("toPersistEntry", () => {
	it("persist 只装目录本体 + 采集时点（无过期语义字段）", () => {
		const entry = toPersistEntry([chatModel("m1")]);
		expect(Object.keys(entry).sort()).toEqual(["checkedAt", "models"]);
		expect(entry.models.map((model) => (model as { id: string }).id)).toEqual(["m1"]);
	});
});
