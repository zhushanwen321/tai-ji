/**
 * adapters/ports.ts 测试 — UiPort 双模 widget 接线（setWidgetDual 委托集成）。
 *
 * 验证 buildPorts 构造的 uiPort.setWidget（dual payload 签名）：
 * - rpc 模式：gui 臂经 guiSetWidget 编码 marker 进 ctx.ui.setWidget
 * - tui 模式：text 臂透传（pi 原生文本行，无 marker）
 * - undefined：清除语义（模式无关）
 *
 * 模式分派守卫单点在 protocol helpers.ts（守卫单点化），本测试只验证委托接线。
 *
 * 运行：cd extensions/universal/goal && npx vitest run src/__tests__/ports.test.ts
 */
import { describe, expect, it } from "vitest";
import {
	GUI_WIDGET_MARKER,
	guiComponent,
	guiResult,
	type DualWidgetContent,
} from "@xyz-agent/extension-protocol";

import { buildPorts } from "../adapters/ports";

/** mock pi（buildPorts 仅用 pi.appendEntry，此处不测 persistence）。 */
function makePi(): Parameters<typeof buildPorts>[0] {
	return { appendEntry: () => {} } as unknown as Parameters<typeof buildPorts>[0];
}

/** mock ctx，捕获 ui.setWidget 收到的 lines（验证 marker 编码 / text 透传）。 */
function makeCtx(opts: { mode?: string; hasUI?: boolean } = {}) {
	let captured: string[] | undefined = undefined;
	const ctx = {
		mode: opts.mode ?? "rpc",
		hasUI: opts.hasUI ?? true,
		ui: {
			setWidget: (_key: string, lines: string[] | undefined) => {
				captured = lines;
			},
			setStatus: () => {},
			notify: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	} as unknown as Parameters<typeof buildPorts>[1];
	return { ctx, getCaptured: () => captured };
}

function makeDualContent(): DualWidgetContent {
	return {
		gui: guiResult(guiComponent("stats-line", { items: [{ value: "x" }] })),
		text: ["tui line"],
	};
}

describe("buildPorts UiPort.setWidget（setWidgetDual 委托）", () => {
	it("rpc 模式 → ctx.ui.setWidget 收到 gui 臂 marker 编码的 string[]", () => {
		const { ctx, getCaptured } = makeCtx({ mode: "rpc" });
		const ports = buildPorts(makePi(), ctx);

		ports.ui.setWidget("goal", makeDualContent());

		const captured = getCaptured();
		expect(captured).toBeDefined();
		expect(captured).toHaveLength(1);
		// marker 前缀（host 侧 EventAdapter 据此解码成 extension:widgetGui）
		expect(captured![0].startsWith(GUI_WIDGET_MARKER)).toBe(true);
		// 解码还原 GuiRenderResult 信封（TUI text 臂不出现）
		const json = captured![0].slice(GUI_WIDGET_MARKER.length);
		const parsed = JSON.parse(json);
		expect(parsed.v).toBe(1);
		expect(parsed.component.type).toBe("stats-line");
	});

	it("tui 模式 → ctx.ui.setWidget 收到 text 臂原生文本行（无 marker 前缀）", () => {
		const { ctx, getCaptured } = makeCtx({ mode: "tui" });
		const ports = buildPorts(makePi(), ctx);

		ports.ui.setWidget("goal", makeDualContent());

		const captured = getCaptured();
		expect(captured).toEqual(["tui line"]);
		for (const line of captured!) {
			expect(line.startsWith(GUI_WIDGET_MARKER)).toBe(false);
		}
	});

	it("setWidget(undefined) → ctx.ui.setWidget 收到 undefined（清除语义，模式无关）", () => {
		const { ctx, getCaptured } = makeCtx({ mode: "rpc" });
		const ports = buildPorts(makePi(), ctx);

		ports.ui.setWidget("goal", undefined);

		expect(getCaptured()).toBeUndefined();
	});
});
