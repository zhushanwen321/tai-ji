// src/__tests__/registry.test.ts —— registry 持久化白盒：原子写 / 损坏防御 / LRU / 条目剥离
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_TERMINAL_REGISTRY_ENTRIES } from "@taiji/extension-protocol";

import {
	getRegistryPath,
	readRegistry,
	taskToRegistryEntry,
	writeRegistryEntry,
} from "../background/registry.ts";
import type { BackgroundTask } from "../background/types.ts";

let tmpRoot = "";

function freshRegistryPath(): string {
	tmpRoot = mkdtempSync(join(tmpdir(), "bte-registry-"));
	return getRegistryPath(tmpRoot, "session-test");
}

function makeEntry(overrides: Partial<BackgroundTask> = {}) {
	const task: BackgroundTask = {
		taskId: "bt-1000-abcd",
		pid: 111,
		command: "echo hi",
		outputFile: join(tmpRoot || tmpdir(), "bt-1000-abcd.log"),
		registryPath: "/tmp/unused-registry.json",
		startedAt: 1000,
		state: "running",
		ownerPiPid: 222,
		sessionId: "session-test",
		// 运行时字段：taskToRegistryEntry 必须剥离（intent/timeoutTimer/child/registryPath）
		intent: { reason: "killed", at: 1234 },
		child: undefined,
		...overrides,
	};
	return task;
}

afterEach(() => {
	tmpRoot = "";
});

describe("writeRegistryEntry / readRegistry roundtrip", () => {
	it("creates the registry file with a valid entry and no tmp residue", () => {
		const path = freshRegistryPath();
		const result = writeRegistryEntry(path, taskToRegistryEntry(makeEntry()));
		expect(result.success).toBe(true);
		expect(existsSync(path)).toBe(true);
		// 原子写不留 tmp 中间文件
		const residues = readdirSync(join(path, "..")).filter((f) => f.includes(".tmp_"));
		expect(residues).toEqual([]);

		const map = readRegistry(path);
		expect(map.get("bt-1000-abcd")?.pid).toBe(111);
		expect(map.get("bt-1000-abcd")?.ownerPiPid).toBe(222);
	});

	it("serialized entry strips runtime-only fields (intent/child/registryPath)", () => {
		const path = freshRegistryPath();
		writeRegistryEntry(path, taskToRegistryEntry(makeEntry()));
		const raw = JSON.parse(readFileSync(path, "utf8")) as {
			version: number;
			entries: Array<Record<string, unknown>>;
		};
		expect(raw.version).toBe(1);
		const entry = raw.entries[0];
		expect(entry.intent).toBeUndefined();
		expect(entry.child).toBeUndefined();
		expect(entry.registryPath).toBeUndefined();
	});

	it("same task_id merges as update (not duplicate)", () => {
		const path = freshRegistryPath();
		writeRegistryEntry(path, taskToRegistryEntry(makeEntry()));
		writeRegistryEntry(
			path,
			taskToRegistryEntry(
				makeEntry({ state: "exited", exitCode: 0, reason: "natural", endedAt: 2000, durationMs: 1000 }),
			),
		);
		const map = readRegistry(path);
		expect(map.size).toBe(1);
		expect(map.get("bt-1000-abcd")?.state).toBe("exited");
	});
});

describe("corruption defense (§3.6)", () => {
	it("bad JSON → renamed .corrupt + empty table rebuild + no crash", () => {
		const path = freshRegistryPath();
		writeRegistryEntry(path, taskToRegistryEntry(makeEntry()));
		// 外力写坏（半程写/手编坏 JSON）
		writeFileSync(path, '{"version":1,"entries":[{ broken', "utf8");

		const map = readRegistry(path);
		expect(map.size).toBe(0);
		expect(existsSync(`${path}.corrupt`)).toBe(true);
		// 现场保留：.corrupt 里是坏内容本身
		expect(readFileSync(`${path}.corrupt`, "utf8")).toContain("broken");
		// 重建可写：下一次写入恢复工作
		writeRegistryEntry(path, taskToRegistryEntry(makeEntry()));
		expect(readRegistry(path).size).toBe(1);
	});

	it("shape-invalid content (entries not array) → same corrupt path", () => {
		const path = freshRegistryPath();
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, '{"version":1,"entries":"not-an-array"}', "utf8");
		const map = readRegistry(path);
		expect(map.size).toBe(0);
		expect(existsSync(`${path}.corrupt`)).toBe(true);
	});

	it("missing file → empty table (first spawn before any write)", () => {
		const path = freshRegistryPath();
		expect(readRegistry(path).size).toBe(0);
	});
});

describe("terminal LRU (cap 50, symmetric with task store)", () => {
	it("keeps newest 50 terminal entries, evicts oldest overflow", () => {
		const path = freshRegistryPath();
		const TOTAL = MAX_TERMINAL_REGISTRY_ENTRIES + 5;
		for (let i = 0; i < TOTAL; i++) {
			writeRegistryEntry(
				path,
				taskToRegistryEntry(
					makeEntry({
						taskId: `bt-${1000 + i}-aaaa`,
						startedAt: 1000 + i,
						state: "exited",
						endedAt: 2000 + i,
					}),
				),
			);
		}
		const map = readRegistry(path);
		expect(map.size).toBe(MAX_TERMINAL_REGISTRY_ENTRIES);
		expect(map.has("bt-1000-aaaa")).toBe(false);
		expect(map.has("bt-1001-aaaa")).toBe(false);
		expect(map.has("bt-1002-aaaa")).toBe(false);
		expect(map.has("bt-1003-aaaa")).toBe(false);
		expect(map.has("bt-1004-aaaa")).toBe(false);
		expect(map.has(`bt-${1000 + TOTAL - 1}-aaaa`)).toBe(true);
	});
});
