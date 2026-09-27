// injector-chain-order.test.ts —— system-prompt 注入链注册顺序的源码锚点守卫（D7）。
//
// index.ts 的注入链序只由 setup*Injector 调用的先后表达（subagent 清单 → workflow
// 清单 → provider models → engine-awareness），无任何运行时检查。D7 硬约束
// （injectors/engine-awareness.ts「生产装配」节注释）：engine-awareness 恒链尾
// 注册——其段落内容变化只断 system prompt 尾部 cache 前缀。新增注入器若插到
// engine-awareness 之后 = 静默断 KV-cache 前缀（无运行时红灯），本守卫把该
// 违例变成测试红灯。
//
// 手段 = source-anchored（prompt-quality 系列同款 readSrc）：读 src/index.ts 源文本，
// 正则匹配 `setup…Injector(` 调用点（大小写敏感；import 语句不含 `(` 不命中），
// 逐个比较位置而非硬编码清单——未来新增 injector 自动纳入守卫。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

const INDEX_TS = join("src", "index.ts");

/** D7 约束主体：必须恒为注入链尾的 injector setup 函数名。 */
const CHAIN_TAIL_INJECTOR = "setupEngineAwarenessInjector";

interface InjectorCall {
  name: string;
  /** 1-based 行号（人可直接跳转 index.ts 定位）。 */
  line: number;
}

/**
 * 匹配 `setup…Injector(` 调用点（大小写敏感）。import 语句不含 `(` 不命中；
 * 注释里带调用括号的提及会误命中——index.ts 现状无此形态，未来注释提及请写成
 * 不带括号的 `setupXxxInjector`。
 */
function findInjectorCalls(src: string): InjectorCall[] {
  const calls: InjectorCall[] = [];
  const pattern = /\b(setup[A-Za-z]*Injector)\s*\(/g;
  for (let m = pattern.exec(src); m !== null; m = pattern.exec(src)) {
    calls.push({ name: m[1]!, line: src.slice(0, m.index).split("\n").length });
  }
  return calls;
}

/** 守卫失败信息（可操作闭环）：约束依据 + 违例 injector 名与双方行号 + 恢复动作。 */
function buildChainTailViolationMessage(
  engine: InjectorCall,
  violators: InjectorCall[],
): string {
  const violatorList = violators.map((v) => `${v.name} (index.ts L${v.line})`).join(", ");
  return (
    `${CHAIN_TAIL_INJECTOR} 必须恒为 system-prompt 注入链尾（D7 约束：engine-awareness ` +
    `段内容变化只断 system prompt 尾部 cache 前缀——非链尾注册会静默断 KV-cache 前缀）。` +
    `违例：${violatorList} 注册在 ${CHAIN_TAIL_INJECTOR} (index.ts L${engine.line}) 之后。` +
    `恢复：把违例 injector 的 setup 调用移到 ${CHAIN_TAIL_INJECTOR} 之前。`
  );
}

describe("injector 链序守卫（D7：engine-awareness 恒链尾）", () => {
  const src = readSrc(INDEX_TS);
  const calls = findInjectorCalls(src);

  it("守卫前提：index.ts 恰好注册一次 engine-awareness injector", () => {
    expect(
      calls.filter((c) => c.name === CHAIN_TAIL_INJECTOR),
      `守卫前提失效：${INDEX_TS} 中 ${CHAIN_TAIL_INJECTOR} 调用数应为 1。` +
        `若注册点已迁走，请把本守卫与 D7 约束一并迁到新装配点。`,
    ).toHaveLength(1);
  });

  it("engine-awareness 的调用位置在所有其他 setup*Injector 调用之后（逐个比较，新增 injector 自动纳入）", () => {
    const engineCalls = calls.filter((c) => c.name === CHAIN_TAIL_INJECTOR);
    expect(engineCalls.length).toBeGreaterThan(0);
    const engine = engineCalls[0]!;
    // 逐位置比较而非硬编码清单：任何插到 engine-awareness 之后的 injector（含未来
    // 新增）都进 violators → 红。engine-awareness 自身已排除。
    const violators = calls.filter(
      (c) => c.name !== CHAIN_TAIL_INJECTOR && c.line > engine.line,
    );
    expect(violators, buildChainTailViolationMessage(engine, violators)).toEqual([]);
  });

  it("守卫不退化为空集：index.ts 还有其他 setup*Injector 调用被覆盖", () => {
    expect(calls.filter((c) => c.name !== CHAIN_TAIL_INJECTOR).length).toBeGreaterThanOrEqual(1);
  });

  it("失败信息可操作：含约束依据（D7/链尾）、违例 injector 名、双方行号与恢复动作", () => {
    // 固定 fixture 锁消息模板——主用例违例时 expect 第二参输出的就是这条消息
    const msg = buildChainTailViolationMessage(
      { name: CHAIN_TAIL_INJECTOR, line: 200 },
      [{ name: "setupNewListInjector", line: 210 }],
    );
    expect(msg).toContain(CHAIN_TAIL_INJECTOR);
    expect(msg).toContain("D7");
    expect(msg).toContain("链尾");
    expect(msg).toContain("setupNewListInjector (index.ts L210)");
    expect(msg).toContain("L200");
    expect(msg).toContain("恢复");
  });
});
