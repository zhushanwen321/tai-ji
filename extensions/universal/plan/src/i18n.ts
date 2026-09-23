/**
 * plan 包 i18n 层（u-locale-channel 消费端）：只本地化「给人看的交互面」——complete
 * 执行方式选择的 FormOverlay 单 choice 问题（question/header/options）与 ctx.ui.notify
 * 提示。tool result 里的英文是给 LLM 的执行指令，不进词典（agent 会以会话语言转述，
 * 指令语言 ≠ UI 语言）。
 *
 * locale 读取（readUiLocale + mtime/size 缓存 + 降级）下沉在
 * `@zhushanwen/pi-llm-shared` 单一实现（@data-owner #39 注解随实现持有），本包
 * re-export；env `TAIJI_AGENT_DATA_DIR` 缺失 / 文件缺失 / JSON 损坏 → 回落 `en-US`
 * （与 runtime readUiPreferences 的降级口径一致）。
 */
import { DEFAULT_UI_LOCALE, readUiLocale, type UiLocale } from "@zhushanwen/pi-llm-shared/ui-locale";

export { DEFAULT_UI_LOCALE, readUiLocale, type UiLocale };

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
