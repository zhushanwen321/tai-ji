import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { normalizeSkillName, resolveSkills } from "../resolve-skills.js";

/**
 * fake skill 命令条目（SlashCommandInfo 形态：source === 'skill' + sourceInfo.path）。
 * name 带 pi 命名空间前缀（`skill:<name>`）——真实 pi.getCommands() 枚举 skill 类
 * 命令即此形态，归一化比对的靶子。
 */
const SKILL_COMMANDS = [
  { name: "skill:tech-design", source: "skill", sourceInfo: { path: "/skills/tech-design/SKILL.md" } },
  { name: "skill:dev-flow", source: "skill", sourceInfo: { path: "/skills/dev-flow/SKILL.md" } },
  { name: "skill:code review", source: "skill", sourceInfo: { path: "/skills/code review/SKILL.md" } },
  { name: "plan", source: "extension", sourceInfo: { path: "/extensions/universal/plan" } },
];

const makePi = (commands: unknown[] = SKILL_COMMANDS) =>
  ({ getCommands: vi.fn(() => commands) }) as unknown as ExtensionAPI;

describe("normalizeSkillName（skill: 命名空间前缀剥离）", () => {
  it("strips the leading 'skill:' namespace prefix once", () => {
    expect(normalizeSkillName("skill:tech-design")).toBe("tech-design");
  });

  it("leaves bare names untouched", () => {
    expect(normalizeSkillName("tech-design")).toBe("tech-design");
  });

  it("only strips the prefix form, not a bare name that merely contains it", () => {
    // skill: 前缀是命名空间标记，非子串替换——「xskill:y」的自然名不是「xy」
    expect(normalizeSkillName("xskill:y")).toBe("xskill:y");
  });
});

describe("resolveSkills（执行门禁：pi 注册表枚举比对，双向剥 skill: 前缀归一）", () => {
  it("resolves prefixed enum entries from bare-name input (short name in resolved)", () => {
    // 无前缀输入命中带前缀枚举（输入面：用户用自然技能名）
    const resolution = resolveSkills(makePi(), ["tech-design", "code review"]);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.resolved).toEqual([
        { name: "tech-design", skillPath: "/skills/tech-design/SKILL.md" },
        { name: "code review", skillPath: "/skills/code review/SKILL.md" },
      ]);
    }
  });

  it("resolves explicit 'skill:'-prefixed input too (both directions normalize)", () => {
    const resolution = resolveSkills(makePi(), ["skill:tech-design", "skill:dev-flow"]);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      // resolved 用归一后的短名（无前缀）
      expect(resolution.resolved).toEqual([
        { name: "tech-design", skillPath: "/skills/tech-design/SKILL.md" },
        { name: "dev-flow", skillPath: "/skills/dev-flow/SKILL.md" },
      ]);
    }
  });

  it("only compares entries with source === 'skill'", () => {
    // 非 skill source 的命令（extension 等）不参与门禁——「plan」不被当作技能放行
    const resolution = resolveSkills(makePi(), ["plan"]);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.missing).toEqual(["plan"]);
      // available 维持枚举原形态（带前缀，错误信息里可直接复制为 pi 命令）
      expect(resolution.available).toEqual(["skill:tech-design", "skill:dev-flow", "skill:code review"]);
    }
  });

  it("unknown skill reports missing together with the available list", () => {
    const resolution = resolveSkills(makePi(), ["tech-design", "tech-desig"]);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.missing).toEqual(["tech-desig"]);
    }
  });

  it("prefixed-but-unknown input reports the normalized short name as missing", () => {
    const resolution = resolveSkills(makePi(), ["skill:tech-desig"]);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.missing).toEqual(["tech-desig"]);
    }
  });

  it("empty request resolves to empty list without consulting availability", () => {
    const resolution = resolveSkills(makePi(), []);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.resolved).toEqual([]);
    }
  });
});
