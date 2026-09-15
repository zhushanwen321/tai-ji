/**
 * WT6: PermissionMode 枚举完整性测试
 */
import { describe, expect, it } from "vitest";

import {
	DEFAULT_CONFIG,
	isValidPermissionMode,
	MODE_DESCRIPTIONS,
	MODE_LABELS,
	PERMISSION_MODES,
} from "../types.js";

describe("WT6: PermissionMode 枚举完整性", () => {
	it("PERMISSION_MODES 包含四档且顺序正确（严格等级低→高）", () => {
		expect(PERMISSION_MODES).toEqual(["yolo", "auto", "approve", "strict"]);
	});

	it("MODE_DESCRIPTIONS 四个 key 都有值", () => {
		for (const mode of PERMISSION_MODES) {
			expect(MODE_DESCRIPTIONS[mode]).toBeTruthy();
			expect(typeof MODE_DESCRIPTIONS[mode]).toBe("string");
		}
	});

	it("MODE_LABELS 四个 key 都有值", () => {
		for (const mode of PERMISSION_MODES) {
			expect(MODE_LABELS[mode]).toBeTruthy();
			expect(typeof MODE_LABELS[mode]).toBe("string");
		}
	});

	it("isValidPermissionMode 对四档返回 true", () => {
		for (const mode of PERMISSION_MODES) {
			expect(isValidPermissionMode(mode)).toBe(true);
		}
	});

	it("isValidPermissionMode 对非法值返回 false", () => {
		expect(isValidPermissionMode("Yolo")).toBe(false); // 大小写敏感
		expect(isValidPermissionMode("read-only")).toBe(false);
		expect(isValidPermissionMode("")).toBe(false);
		expect(isValidPermissionMode(undefined)).toBe(false);
		expect(isValidPermissionMode(null)).toBe(false);
		expect(isValidPermissionMode(123)).toBe(false);
		expect(isValidPermissionMode({ mode: "yolo" })).toBe(false);
	});

	it("DEFAULT_CONFIG 有合理默认值", () => {
		expect(DEFAULT_CONFIG.mode).toBe("yolo");
		expect(DEFAULT_CONFIG.enabled).toBe(true);
		expect(DEFAULT_CONFIG.classifier.enabled).toBe(true);
		expect(DEFAULT_CONFIG.classifier.model).toBe("auto");
		expect(DEFAULT_CONFIG.classifier.timeout).toBe(90);
		expect(DEFAULT_CONFIG.classifier.autoApproveLowRisk).toBe(true);
		expect(DEFAULT_CONFIG.classifier.autoDenyHighRisk).toBe(true);
		expect(DEFAULT_CONFIG.userRules).toEqual([]);
	});
});
