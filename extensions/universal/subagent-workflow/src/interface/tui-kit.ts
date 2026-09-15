// src/interface/tui-kit.ts
//
// TUI 终端零件 kit（post-convergence C4）：全屏视图族的共享零件单点——
// 终端探测常量 / termRows() / 边框着色家族（b/dash/dashes/titleBorder/plainBorder/walled，
// 自由函数形态，WorkflowsView 形态胜出）/ ANSI 可见宽度文本布局家族
// （truncLine/wrapText/padToVisible/segFillColored，自 format.ts 迁入）。
//
// 零依赖叶（D7）：不 import format.ts 与其他壳 module——边框家族的填充/对齐
// 需要 ANSI 可见宽度计算（titleBorder→segFillColored→truncLine、walled→padToVisible），
// 该布局家族整体随迁本文件，否则 kit 须反向依赖 format.ts 或复制实现（双定义）。
// 唯一外部依赖 = pi-tui 的 visibleWidth（纯函数，无内部耦合）。
//
// 布局家族原定义与行为（含 __fixtures__/truncline.snapshot.json 逐字节锚定）不变，
// format.ts 经 re-export 保持既有导入面（bg-notify-render / tool-render / 测试零改动）。

import { visibleWidth } from "@earendil-works/pi-tui";

// ============================================================
// 终端探测常量（单定义）
// ============================================================

/** terminal.rows 读不到时的兜底行数（防 duck-type 失败）。 */
const TERM_ROWS_FALLBACK = 24;
/** PgUp/PgDn 翻页默认步长（viewport 信息缺失时兜底，防 NaN）。 */
export const PAGE_SCROLL_DEFAULT = 10;

/** terminal.rows 的最小 duck-type 面（list-shared TuiLike / WorkflowsView TuiLike 均结构兼容）。 */
export interface TerminalRowsSource {
  terminal?: { rows?: unknown };
}

/** 安全读 terminal.rows（兜底防 duck-type 失败）。 */
export function termRows(tui: TerminalRowsSource): number {
  const rows = tui.terminal?.rows;
  return typeof rows === "number" && rows > 0 ? rows : TERM_ROWS_FALLBACK;
}

// ============================================================
// 边框着色 helper 家族（统一 borderMuted，避 ANSI 嵌套失色）
// ============================================================

/** 边框着色所需的最小主题面（结构兼容 format.ts 的 ThemeLike / Pi Theme）。 */
export interface BorderTheme {
  fg(color: string, text: string): string;
}

/** 着色单个框线字符（borderMuted）。所有 ╭╮╰╯├┤┬┴─│ 统一走这里。 */
export function b(theme: BorderTheme, s: string): string {
  return theme.fg("borderMuted", s);
}
/** 着色单字符填充用的 `─`（供 segFillColored 的 fillStyled）。 */
export function dash(theme: BorderTheme): string {
  return theme.fg("borderMuted", "─");
}
/** 满宽 `─` 填充串（borderMuted）。n 次单字符着色，ANSI 自然延续。 */
export function dashes(theme: BorderTheme, n: number): string {
  return dash(theme).repeat(Math.max(0, n));
}
/** 顶/底框行：`╭` + 着色标题填充 + `╮`（或 ╰╯）。每段独立着色，无嵌套。 */
export function titleBorder(
  theme: BorderTheme,
  left: string,
  titleStyled: string,
  right: string,
  contentWidth: number,
): string {
  return b(theme, left) + segFillColored(titleStyled, dash(theme), contentWidth) + b(theme, right);
}
/** 纯线顶/底框（无标题）：`╭` + `─`×W + `╮`。 */
export function plainBorder(theme: BorderTheme, left: string, right: string, contentWidth: number): string {
  return b(theme, left) + dashes(theme, contentWidth) + b(theme, right);
}
/** 内容行墙：`│` + 内容(pad 到 contentWidth) + `│`，墙字符 borderMuted。 */
export function walled(theme: BorderTheme, content: string, contentWidth: number): string {
  return `${b(theme, "│")}${padToVisible(content, contentWidth)}${b(theme, "│")}`;
}

// ============================================================
// ANSI 可见宽度文本布局家族（自 format.ts 原样迁入）
// ============================================================

/** grapheme 切分器(Unicode/emoji 安全).模块级共享,勿热路径 new. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 把文本 pad 到指定**可见**宽度(grapheme/emoji/CJK 安全).
 *
 * 用 visibleWidth 而非 `.length`——避免 ANSI 转义、emoji、宽字符(CJK 占 2 列)
 * 把列对齐算错(dev guide §2.4 警告的坑).
 *
 *   - 已 ≥ width → 原样返回(调用方负责先 truncLine 截断)
 *   - < width → 末尾补空格到可见宽度对齐
 *
 * 与 truncLine 配对:左/右列对齐时先 `truncLine(s, colWidth)` 再 `padToVisible(s, colWidth)`.
 */
export function padToVisible(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + " ".repeat(width - w);
}

/**
 * 分段着色版 segFill:title 和 fill 都已着色(含 ANSI),拼接时各自 ANSI 延续.
 *
 * 解决 ANSI 嵌套失色问题:若用 `t.fg("c1", fill(title, "─", n))`,
 * title 内的 `\x1b[0m` 会重置外层 c1,导致 title 之后的 `─` 失去 c1.
 * 本函数改成 `title + fill.repeat(后)`,fill 整段保持着自己的 ANSI,不依赖外层包裹 → 全线着色一致.
 *
 *   segFillColored(t.fg("accent"," Subagents "), t.fg("borderMuted","─"), 20)
 *   → accent(" Subagents ") + borderMuted(─×N),无嵌套
 *
 * 注意:fill 必须是「单字符着色」(如 `t.fg("borderMuted","─")`),visibleWidth=1.
 * 调用方负责 title/fill 着色;本函数不接 theme.标题在前、填充在后.
 */
export function segFillColored(titleStyled: string | undefined, fillStyled: string, width: number): string {
  if (width <= 0) return "";
  const fillW = visibleWidth(fillStyled);
  if (!titleStyled || fillW === 0) {
    // 纯填充线:fillStyled.visibleWidth 应为 1,按 width 次重复
    return fillStyled.repeat(width);
  }
  const tw = visibleWidth(titleStyled);
  if (tw >= width) return truncLine(titleStyled, width);
  const fillCount = width - tw;
  return titleStyled + fillStyled.repeat(fillCount);
}

/**
 * SGR 序列 sticky regex（truncLine 专用）。
 *
 * lastIndex 置位后 exec/test 只在该位置匹配（等价 `flat.slice(pos).match(/^\x1b\[[0-9;]*m/)`，
 * 但零子串分配）。同步代码内「设 lastIndex → 立即用」，无跨调用残留。
 */
const SGR_STICKY_RE = /\x1b\[[0-9;]*m/y;

/** 判断 s 在 pos 处是否开始一个 SGR 序列（非 SGR ESC——OSC/非 SGR CSI/裸 ESC——返回 false）。 */
function isSgrStart(s: string, pos: number): boolean {
  SGR_STICKY_RE.lastIndex = pos;
  return SGR_STICKY_RE.test(s);
}

/**
 * 截断文本到 maxWidth 可见宽度(带省略号 `…`,ANSI 安全).
 *
 * 问题:pi-tui 的 truncateToWidth 在省略号前插 `\x1b[0m`(全局 reset),
 * 导致 contentBox 施加的背景色在省略号处断裂.
 *
 * 解决:遍历追踪 active SGR styles,遇 `\x1b[0m` 清空、遇其他 `\x1b[..m` push,
 * 截断时 `result + activeStyles.join("") + "…"`——重应用 active 样式,背景不断裂.
 * 用 Intl.Segmenter grapheme 切分,正确处理 emoji/CJK/组合字符.
 *
 * 性能（IF12/#18）：旧实现逐字符 `flat.slice(end).match(...)` 是 O(n²)（每字符
 * 一次子串分配 + 正则扫描）；现改为 `indexOf("\x1b", ...)` 跳到下一 ESC，仅在 ESC
 * 位置做一次 sticky 判定——纯文本段零分配零正则。
 *
 * **非 SGR ESC 行为（等价关键，逐字节等价的定义点）**：OSC（\x1b]0;..\x07）、
 * 非 SGR CSI（\x1b[K）、裸 \x1b 后跟非 [ 字符——均不构成文本段边界，作为纯文本
 * 并入 textPortion 被 segmenter 消费（占 currentWidth、进 result），与旧实现
 * 「while 停点集合 = SGR 序列起点」完全一致。输出由 __fixtures__/truncline.snapshot.json
 * （改造前实现生成）逐字节锚定。
 *
 * 移植自 pi-subagents render.ts:44-89.
 */
export function truncLine(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  // 剥离换行符（\n / \r）：text 可能含多行 prompt / turn.text，\n 不占可见宽度
  // 但在终端会换行，导致单行渲染意外变成多行，破坏行对齐（list overlay 左右列错位、
  // tool block 行数跳变）。单行渲染入口必须保证无 \n。用空格替代（保留词边界可读性）。
  const flat = text.replace(/[\r\n]+/g, " ");
  if (visibleWidth(flat) <= maxWidth) return flat;

  const targetWidth = Math.max(0, maxWidth - 1);
  const state: TruncState = { result: "", currentWidth: 0, activeStyles: [] };
  let i = 0;

  while (i < flat.length) {
    // 捕获 ANSI SGR 序列（sticky：只在 i 处匹配，等价旧 slice(i).match(/^.../m)）
    SGR_STICKY_RE.lastIndex = i;
    const ansiMatch = SGR_STICKY_RE.exec(flat);
    if (ansiMatch) {
      applySgr(state, ansiMatch[0]);
      i += ansiMatch[0].length;
      continue;
    }

    const end = findNextSgrStart(flat, i);
    if (consumeGraphemes(state, flat.slice(i, end), targetWidth)) {
      return truncTail(state);
    }
    i = end;
  }

  // 理论上 visibleWidth 检查已提前返回,此行兜底
  return truncTail(state);
}

/** truncLine 遍历累积态：已产出文本 / 已占可见宽度 / active SGR 栈。 */
interface TruncState {
  result: string;
  currentWidth: number;
  activeStyles: string[];
}

/** 消费一个 SGR 序列：写入 result 并维护 activeStyles 栈（reset 清空 / 其他 push）。 */
function applySgr(state: TruncState, code: string): void {
  state.result += code;
  if (code === "\x1b[0m" || code === "\x1b[m") {
    state.activeStyles = []; // reset → 清空栈
  } else {
    state.activeStyles.push(code);
  }
}

/**
 * 找 flat 自 from 起下一段纯文本的终点：下一处 SGR 序列起点（或串尾）。
 *
 * indexOf 跳到 ESC 候选位，仅对 ESC 位置做一次 sticky 判定；非 SGR ESC
 * （OSC/\x1b[K/裸 \x1b）不构成边界、并入文本段（返回值推进到该 ESC 之后继续找），
 * 与旧逐字符 while 的停点集合逐字节一致。
 */
function findNextSgrStart(s: string, from: number): number {
  for (
    let escPos = s.indexOf("\x1b", from);
    escPos !== -1;
    escPos = s.indexOf("\x1b", escPos + 1)
  ) {
    if (isSgrStart(s, escPos)) {
      return escPos;
    }
  }
  return s.length;
}

/**
 * 按 grapheme 迭代 textPortion 累加到 targetWidth；超宽时停笔并返回 true
 * （截断点已到达，由调用方收尾）。
 */
function consumeGraphemes(state: TruncState, textPortion: string, targetWidth: number): boolean {
  for (const seg of segmenter.segment(textPortion)) {
    const grapheme = seg.segment;
    const graphemeWidth = visibleWidth(grapheme);
    if (state.currentWidth + graphemeWidth > targetWidth) {
      return true;
    }
    state.result += grapheme;
    state.currentWidth += graphemeWidth;
  }
  return false;
}

/**
 * 截断尾部：重应用 active 样式 + 省略号 + reset。
 *
 * reset 不可省——否则行尾颜色渗透到 padToVisible 的填充空格、乃至下一帧行，
 * 视觉上表现为颜色重影（被截断的着色延伸到行尾之外）。
 * 但纯文本输入（activeStyles 为空）不发 reset——\x1b[0m 是全局重置，
 * 会清除 theme.bg 施加的外层背景色（背景框内省略号后失去背景的根因）。
 */
function truncTail(state: TruncState): string {
  return state.result + state.activeStyles.join("") + "…" + (state.activeStyles.length ? "\x1b[0m" : "");
}

/**
 * 把长文本按指定可见宽度拆成多行（word-wrap），完整展示不截断。
 *
 * 用于 detail 模式完整展示长内容（task / output text）。detail 有翻屏能力，
 * 不应像预览那样截断成一行省略号——信息完整性优先。
 *
 * 输入为纯文本（不含 ANSI 颜色）。调用方对返回的每行单独着色，
 * 这样避免对 ANSI 文本做复杂 wrap（SGR 状态跨行续重应用）。
 *
 * grapheme 迭代（CJK/emoji 安全）：逐字素累加可见宽度，超 maxWidth 即断行。
 * CJK 可在任意字素间断（每个汉字占 2 列但可断），拉丁文不强制保留词边界
 * （detail 场景优先完整性，width 足够宽时自然在空格附近断）。
 *
 * 原始 \n 保留为段落分隔（split 后每段独立 wrap，空行保留为 ""）。
 * 与 truncLine 的扁平化不同：wrapText 的产物是多行，\n 是有意的段落边界。
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const result: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const trimmed = para.trim();
    if (!trimmed) {
      result.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const seg of segmenter.segment(trimmed)) {
      const g = seg.segment;
      const gw = visibleWidth(g);
      if (lineWidth + gw > maxWidth && line.length > 0) {
        result.push(line);
        line = g;
        lineWidth = gw;
      } else {
        line += g;
        lineWidth += gw;
      }
    }
    if (line.length > 0) result.push(line);
  }
  return result;
}
