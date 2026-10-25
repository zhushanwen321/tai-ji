/**
 * plan 工具测试共享 node:fs 全桩 mock（enter / skills / command 三文件共用）。
 *
 * 独立于 test-setup-mocks 的原因：node:fs 的布景形态按测试语义三选一，不可统一——
 * ① 本文件全桩（fs-guard 红线：单测不触真实盘，模板发现走 mock 清单）；
 * ② fsm-consumption 的本地部分透传（读路径保留真实实现）；
 * ③ tool.test.ts / review 系无 fs mock（模板发现依赖真实目录）。
 * 同一模块被两个模块重复 vi.mock 时注册覆盖关系不可靠，故 fs mock 单独成模块、
 * 只由语义 ① 的消费文件 import。
 *
 * 执行顺序约束：vi.mock 在本模块求值时注册（helper 内调用不做 hoist 提升），必须
 * 先于被 mock 模块的加载——消费文件把对本模块的 import 放在 import 区首行。
 */
import { vi } from "vitest";

// readFileSync 实现的注入点（hoisted：vi.mock 工厂求值先于消费方模块体）。
const fsReadFileSyncImpl = vi.hoisted(() => ({ read: (): string => "" }));

/** 定制 readFileSync 返回值（--template 全文 fixture 等特化读布景；在消费方模块体调用）。 */
export function setFsReadFileSync(read: () => string): void {
  fsReadFileSyncImpl.read = read;
}

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => fsReadFileSyncImpl.read()),
}));
