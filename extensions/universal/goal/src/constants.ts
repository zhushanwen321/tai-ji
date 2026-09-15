/**
 * Goal 扩展语义常量
 *
 * 所有数字的含义都通过命名自解释，避免 magic number。
 */

// ── 时间换算 ────────────────────────────────────────

export const SECONDS_PER_MINUTE = 60;
export const MS_PER_SECOND = 1000;

// ── 预算比例阈值 (0-1) ──────────────────────────────

export const BUDGET_RATIO_HIGH = 0.9;            // 90% — 触发预警/收尾 steering
export const BUDGET_RATIO_LOW = 0.7;             // 70% — 触发提醒
export const CONTEXT_USAGE_RATIO_LIMIT = 0.85;   // 85% — 上下文空间不足阈值

// ── 长度/数量上限 ───────────────────────────────────

export const UPDATE_PREFIX_LENGTH = 7;        // "update ".length
export const SHORT_ID_LENGTH = 8;             // goalId 截取前 8 字符作短标识（GUI 显示 fallback）

// ── 百分比换算因子 ──────────────────────────────────

export const PERCENT_FACTOR = 100;

// ── TUI 显示 ────────────────────────────────────────

export const PROGRESS_BAR_DEFAULT_WIDTH = 10;
export const OBJECTIVE_DISPLAY_LIMIT = 80;
export const OBJECTIVE_TRUNCATE_KEEP = 77; // DISPLAY_LIMIT - 3 for "..."
export const TOKEN_K_THRESHOLD = 1000;     // token 数 ≥ 此值时缩写为 k 单位（12000 → 12k）

// ── 停滞/清理阈值 ────────────────────────────────────

export const AUTO_CLEAR_TURNS = 2;				// 终态后自动清理轮数
export const MAX_HISTORY_ENTRIES = 20;			// goal-history entry GC 上限

// ── 轮次活性熔断（chat-domain-v1x D4 / W5）─────────────
//
// 事故背景（2026-09-08，64 分钟 ~320 turn 空转烧 2.93M token）：pending 守卫被
// 「等待已注销的后台任务」击穿后，goal 每轮注入 continuation、主 agent 每轮回一句
// 等待，无任何无进展熔断。双维度封顶：主判据总量上限（与是否调工具正交，不可被
// 任何目标行为绕过）+ 辅判据无进展退避（间隔 ×2 递增）。全部可经 PI_GOAL_* env 覆盖。

export const DEFAULT_CONTINUATION_CAP = 50;              // 主判据：单激活周期 continuation 连发总次数上限（封顶必停发）
export const DEFAULT_NO_PROGRESS_TURNS = 5;              // 辅判据：连续无进展轮数阈值（第 N 轮起退避间隔翻倍）
export const DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD = 1000; // 辅判据：tokenDelta 低于此值视为低产出（一句「等待」量级）
export const DEFAULT_BACKOFF_BASE_MS = 10_000;           // 辅判据：退避基础间隔（×2 递增的基数）
export const DEFAULT_BACKOFF_MAX_MS = 600_000;           // 辅判据：退避间隔上限（指数天花板，防止级数失控）
