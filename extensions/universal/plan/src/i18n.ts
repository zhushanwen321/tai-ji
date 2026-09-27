/**
 * plan 包 i18n 层（u-locale-channel 消费端，先例 = scheduler/src/i18n.ts 同款模式）：
 * 只本地化「给人看的交互面」——complete 执行方式选择的 FormOverlay 单 choice 问题
 * （question/header/options）与 ctx.ui.notify 提示。tool result 里的英文是给 LLM 的
 * 执行指令，不进词典（agent 会以会话语言转述，指令语言 ≠ UI 语言）。
 *
 * locale 读取 = `<dataDir>/ui-preferences.json`（runtime `config.setUiLocale` 唯一写方，
 * renderer 上报）。env `TAIJI_AGENT_DATA_DIR` 缺失 / 文件缺失 / JSON 损坏 → 回落
 * `en-US`（与 runtime readUiPreferences 的降级口径一致）。
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * UI 语言两值（与 shared protocol.ts 的 UiLocale 字面量一致、与 scheduler format.ts
 * 同款本地定义——extension 不依赖 @taiji/shared，字面量漂移由 ui-preferences.json
 * 读写两端守卫测试拦截）。
 */
export type UiLocale = "zh-CN" | "en-US";

export const DEFAULT_UI_LOCALE: UiLocale = "en-US";

/** 词典 key 集合（exec-choice 交互面 + notify；键缺失回落链见 t()）。 */
type Dictionary = Record<string, string>;

const EN_US: Dictionary = {
  "exec.question": "Plan is ready. Choose how to execute:",
  "exec.header": "Execution method",
  "exec.viaSkill": "Execute via skill: {name}",
  "exec.viaSkillDesc": "Load the {name} skill and follow its workflow to execute the plan.",
  "exec.execute": "Execute",
  "exec.executeDesc":
    "Set up goal tracking when available, then execute: delegate independent tasks to subagents, run small or tightly-coupled steps in this session.",
  "exec.later": "Not now",
  "exec.laterDesc": "Keep the plan and stay in plan mode. You can execute it later.",
  "exec.goalFailedNotify": "Goal tracking was not started ({reason}).",
};

const ZH_CN: Dictionary = {
  "exec.question": "计划已就绪，请选择执行方式：",
  "exec.header": "执行方式",
  "exec.viaSkill": "用技能「{name}」执行",
  "exec.viaSkillDesc": "加载 {name} 技能并按其工作流执行该计划。",
  "exec.execute": "执行",
  "exec.executeDesc": "可用时先建立 goal 跟踪，再自动执行：独立任务派发 subagent，小而紧耦合的步骤在本会话逐步完成。",
  "exec.later": "暂不执行",
  "exec.laterDesc": "保留计划并留在计划模式，稍后可再执行。",
  "exec.goalFailedNotify": "Goal 跟踪未能启动（{reason}）。",
};

const DICTIONARIES: Record<UiLocale, Dictionary> = {
  "zh-CN": ZH_CN,
  "en-US": EN_US,
};

/** 指定语言的词典 key 集合（测试用于 zh/en 双侧对齐断言）。 */
export function dictionaryKeys(locale: UiLocale): string[] {
  return Object.keys(DICTIONARIES[locale]);
}

/**
 * 渲染词典模板。回落链：当前 locale → en-US → 键名本身（禁返回空串，scheduler r4 S1
 * 同款）。占位符缺参时保留 `{name}` 原样。
 */
export function t(key: string, params?: Record<string, string | number>, locale?: UiLocale): string {
  const resolved = locale ?? readUiLocale();
  const template = DICTIONARIES[resolved][key] ?? DICTIONARIES[DEFAULT_UI_LOCALE][key] ?? key;
  return interpolate(template, params);
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match: string, name: string): string => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

// ── 就地 locale 读取（mtime+size 双键缓存，scheduler 同款降级口径）──

const UI_PREFERENCES_FILENAME = "ui-preferences.json";

let localeCache: { filePath: string; mtimeMs: number; size: number; locale: UiLocale } | null = null;

/** 读界面语言（数据目录动态推导，禁硬编码路径）；任何失败回落 en-US 且不出声。 */
export function readUiLocale(): UiLocale {
  const dataDir = process.env.TAIJI_AGENT_DATA_DIR;
  if (!dataDir) return DEFAULT_UI_LOCALE;

  const filePath = join(dataDir, UI_PREFERENCES_FILENAME);
  try {
    const stat = statSync(filePath);
    const cached = localeCache;
    if (
      cached !== null &&
      cached.filePath === filePath &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.locale;
    }
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
    const locale = parseUiLocale(parsed);
    localeCache = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, locale };
    return locale;
  } catch {
    localeCache = null;
    return DEFAULT_UI_LOCALE;
  }
}

function parseUiLocale(raw: unknown): UiLocale {
  if (typeof raw !== "object" || raw === null) return DEFAULT_UI_LOCALE;
  const locale = (raw as Record<string, unknown>).locale;
  return locale === "zh-CN" || locale === "en-US" ? locale : DEFAULT_UI_LOCALE;
}
