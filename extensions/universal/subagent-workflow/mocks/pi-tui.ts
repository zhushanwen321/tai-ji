/**
 * Mock for @earendil-works/pi-tui / @earendil-works/pi-tui
 *
 * 最小 UI 桩。如 config-wizard 测试需要 ctx.ui.select 等，在此扩展。
 */

/**
 * Component 接口（与 @earendil-works/pi-tui 对齐）。
 * SubagentResultComponent / SubagentsProgressWidget / CategoryConfirmComponent /
 * SubagentsListComponent implements Component 需此类型。
 * render 必填；invalidate 必填；handleInput / dispose 可选。
 */
export interface Component {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
	dispose?(): void;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Unicode 宽字符区间边界（East Asian Width = Wide / Fullwidth 等近似），
// 按 Unicode 区块语义命名；区间判断见下方 WIDE_RANGES。
const HANGUL_JAMO_START = 0x1100;
const HANGUL_JAMO_END = 0x115f;
const CJK_IDEOGRAPHS_START = 0x2e80; // 覆盖 CJK Radicals、假名、CJK 统一表意、彝文等
const CJK_IDEOGRAPHS_END = 0xa4cf;
const HANGUL_SYLLABLES_START = 0xac00;
const HANGUL_SYLLABLES_END = 0xd7a3;
const CJK_COMPATIBILITY_IDEOGRAPHS_START = 0xf900;
const CJK_COMPATIBILITY_IDEOGRAPHS_END = 0xfaff;
const VERTICAL_FORMS_START = 0xfe10;
const VERTICAL_FORMS_END = 0xfe19;
const CJK_COMPATIBILITY_FORMS_START = 0xfe30;
const CJK_COMPATIBILITY_FORMS_END = 0xfe6f;
const FULLWIDTH_ASCII_START = 0xff00;
const FULLWIDTH_ASCII_END = 0xff60;
const FULLWIDTH_SYMBOLS_START = 0xffe0;
const FULLWIDTH_SYMBOLS_END = 0xffe6;
const EMOJI_PICTOGRAPHS_START = 0x1f300; // Misc Symbols & Pictographs + Emoticons
const EMOJI_PICTOGRAPHS_END = 0x1f64f;
const SUPPLEMENTAL_PICTOGRAPHS_START = 0x1f900;
const SUPPLEMENTAL_PICTOGRAPHS_END = 0x1f9ff;

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [HANGUL_JAMO_START, HANGUL_JAMO_END],
  [CJK_IDEOGRAPHS_START, CJK_IDEOGRAPHS_END],
  [HANGUL_SYLLABLES_START, HANGUL_SYLLABLES_END],
  [CJK_COMPATIBILITY_IDEOGRAPHS_START, CJK_COMPATIBILITY_IDEOGRAPHS_END],
  [VERTICAL_FORMS_START, VERTICAL_FORMS_END],
  [CJK_COMPATIBILITY_FORMS_START, CJK_COMPATIBILITY_FORMS_END],
  [FULLWIDTH_ASCII_START, FULLWIDTH_ASCII_END],
  [FULLWIDTH_SYMBOLS_START, FULLWIDTH_SYMBOLS_END],
  [EMOJI_PICTOGRAPHS_START, EMOJI_PICTOGRAPHS_END],
  [SUPPLEMENTAL_PICTOGRAPHS_START, SUPPLEMENTAL_PICTOGRAPHS_END],
];

const FULL_WIDTH = 2;
const HALF_WIDTH = 1;

// 左右两侧各一份 padding，innerW = width - paddingX * HORIZONTAL_PADDING_SIDES
const HORIZONTAL_PADDING_SIDES = 2;

function isWideCodePoint(code: number): boolean {
  for (const [start, end] of WIDE_RANGES) {
    if (code >= start && code <= end) return true;
  }
  return false;
}

/**
 * 粗略可见宽度：剥离 ANSI 转义，ASCII 1 列，东亚宽字符 2 列。
 * 足够覆盖测试中的截断断言；不追求与真实 pi-tui 100% 一致。
 */
export function visibleWidth(str: string): number {
  const clean = str.replace(ANSI_RE, "");
  let width = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0) ?? 0;
    width += isWideCodePoint(code) ? FULL_WIDTH : HALF_WIDTH;
  }
  return width;
}

const ELLIPSIS = "...";
const EMPTY_STRING = "";

/**
 * 按可见宽度截断文本，超出部分替换为 "..."（与真实 pi-tui 行为一致）。
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return EMPTY_STRING;
  if (visibleWidth(text) <= maxWidth) return text;

  const ellipsisWidth = visibleWidth(ELLIPSIS);
  const targetWidth = Math.max(0, maxWidth - ellipsisWidth);
  let result = EMPTY_STRING;
  let width = 0;

  for (const ch of text.replace(ANSI_RE, "")) {
    const code = ch.codePointAt(0) ?? 0;
    const chWidth = isWideCodePoint(code) ? FULL_WIDTH : HALF_WIDTH;
    if (width + chWidth > targetWidth) break;
    result += ch;
    width += chWidth;
  }

  return result + ELLIPSIS;
}

/** 把含换行/制表符的文本压成单行（测试侧与生产侧行为一致）。 */
function sanitizeLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
}

/** 模拟 pi-tui Text 组件。对齐真实 Text.render：按 \n 分割多行 + 截断 + pad。 */
export class Text {
  constructor(
    private text: string = "",
    private paddingX = 1,
    private paddingY = 1,
    private customBgFn?: (text: string) => string,
  ) {}

  setText(text: string): void {
    this.text = text;
  }

  setCustomBgFn(fn?: (text: string) => string): void {
    this.customBgFn = fn;
  }

  invalidate(): void {}

  render(width: number): string[] {
    // 对齐真实 pi-tui：空文本返回空数组（不占行）
    if (!this.text || this.text.trim() === "") {
      return [];
    }
    const innerW = Math.max(1, width - this.paddingX * HORIZONTAL_PADDING_SIDES);
    // 对齐真实 pi-tui 的 wrapTextWithAnsi：按 \n 分割成多行
    const inputLines = this.text.split("\n");
    const lines: string[] = [];
    for (let i = 0; i < this.paddingY; i++) lines.push("");
    for (const inputLine of inputLines) {
      const line = sanitizeLine(inputLine);
      const truncated = truncateToWidth(line, innerW);
      const pad = " ".repeat(Math.max(0, innerW - visibleWidth(truncated)));
      const padded = " ".repeat(this.paddingX) + truncated + pad + " ".repeat(this.paddingX);
      lines.push(this.customBgFn ? this.customBgFn(padded) : padded);
    }
    for (let i = 0; i < this.paddingY; i++) lines.push("");
    return lines;
  }
}

/** 模拟 pi-tui Box 组件：给所有子组件加左右 padding 和背景色。 */
export class Box {
  children: unknown[] = [];

  constructor(
    private paddingX = 1,
    private paddingY = 1,
    private bgFn?: (text: string) => string,
  ) {}

  addChild(component: { render(width: number): string[] }): void {
    this.children.push(component);
  }

  removeChild(component: unknown): void {
    this.children = this.children.filter((c) => c !== component);
  }

  clear(): void {
    this.children = [];
  }

  setBgFn(fn?: (text: string) => string): void {
    this.bgFn = fn;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const innerW = Math.max(1, width - this.paddingX * HORIZONTAL_PADDING_SIDES);
    const lines: string[] = [];
    for (let i = 0; i < this.paddingY; i++) {
      lines.push(this.bgFn ? this.bgFn(" ".repeat(width)) : " ".repeat(width));
    }
    for (const child of this.children) {
      const childLines = (child as { render(width: number): string[] }).render(innerW);
      for (const line of childLines) {
        const truncated = truncateToWidth(line, innerW);
        const pad = " ".repeat(Math.max(0, innerW - visibleWidth(truncated)));
        const padded = " ".repeat(this.paddingX) + truncated + pad + " ".repeat(this.paddingX);
        lines.push(this.bgFn ? this.bgFn(padded) : padded);
      }
    }
    for (let i = 0; i < this.paddingY; i++) {
      lines.push(this.bgFn ? this.bgFn(" ".repeat(width)) : " ".repeat(width));
    }
    return lines;
  }
}

/** 模拟 pi-tui Container 组件：垂直拼接子组件。 */
export class Container {
  children: unknown[] = [];

  constructor(children: unknown[] = []) {
    this.children = children;
  }

  addChild(child: unknown): void {
    this.children.push(child);
  }

  removeChild(child: unknown): void {
    this.children = this.children.filter((c) => c !== child);
  }

  clear(): void {
    this.children = [];
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
      lines.push(...(child as { render(width: number): string[] }).render(width));
    }
    return lines;
  }
}

/** Mock SelectList：渲染可见项，handleInput 改 selectedIndex（↑↓），Enter 触发 onSelect */
export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}
export interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}
export class SelectList {
  items: SelectItem[];
  private selectedIndex = 0;
  private filter = "";
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  constructor(items: SelectItem[], _maxVisible: number, _theme: SelectListTheme) {
    this.items = items;
  }
  setSelectedIndex(i: number): void {
    this.selectedIndex = Math.max(0, Math.min(Math.max(0, this.items.length - 1), i));
  }
  setFilter(f: string): void {
    this.filter = f;
  }
  getSelectedItem(): SelectItem | null {
    return this.items[this.selectedIndex] ?? null;
  }
  handleInput(data: string): void {
    if (data === "k" || data === "\x1b[A") this.setSelectedIndex(this.selectedIndex - 1);
    else if (data === "j" || data === "\x1b[B") this.setSelectedIndex(this.selectedIndex + 1);
    else if (data === "\r" || data === "\n") {
      const item = this.getSelectedItem();
      if (item) this.onSelect?.(item);
    }
  }
  invalidate(): void {}
  render(_width: number): string[] {
    return this.items.map((it, i) => (i === this.selectedIndex ? `→ ${it.label}` : `  ${it.label}`));
  }
}

/** Mock Input：单行文本，handleInput 处理可打印字符/backspace/enter/esc */
export class Input {
  private value = "";
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  getValue(): string {
    return this.value;
  }
  setValue(v: string): void {
    this.value = v;
  }
  handleInput(data: string): void {
    if (data === "\r" || data === "\n") {
      this.onSubmit?.(this.value);
    } else if (data === "\x1b") {
      this.onEscape?.();
    } else if (data === "\x7f" || data === "\b") {
      this.value = this.value.slice(0, -1);
    } else if (data.length === 1 && data >= " " && data <= "~") {
      this.value += data;
    }
  }
  invalidate(): void {}
  render(_width: number): string[] {
    return [this.value];
  }
}

/** Mock KeybindingsManager + getKeybindings：用原始终端序列匹配 */
export interface KeybindingsManager {
  matches(data: string, keybinding: string): boolean;
  getKeys(keybinding: string): string[];
}
function makeKb(): KeybindingsManager {
  const MAP: Record<string, string[]> = {
    "tui.select.up": ["\x1b[A", "k"],
    "tui.select.down": ["\x1b[B", "j"],
    "tui.select.confirm": ["\r", "\n"],
    "tui.select.cancel": ["\x1b"],
  };
  return {
    matches(data, keybinding) {
      return (MAP[keybinding] ?? []).includes(data);
    },
    getKeys(keybinding) {
      return MAP[keybinding] ?? [];
    },
  };
}
let globalKb: KeybindingsManager | null = null;
export function getKeybindings(): KeybindingsManager {
  if (!globalKb) globalKb = makeKb();
  return globalKb;
}
export function setKeybindings(kb: KeybindingsManager): void {
  globalKb = kb;
}

/** Mock fuzzyFilter：子串匹配（测试足够） */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
  const q = query.toLowerCase();
  if (!q) return items;
  return items.filter((it) => getText(it).toLowerCase().includes(q));
}

export class Spacer {
  constructor(private size = 1) {}
  render(_width: number): string[] {
    return Array.from({ length: this.size }, () => "");
  }
}

export class Markdown {
  constructor(private text: string) {}
  setText(text: string): void {
    this.text = text;
  }
  render(width: number): string[] {
    return this.text.split("\n").map((line) => truncateToWidth(line, width));
  }
}

// ── Key / matchesKey mock（最小实现，覆盖测试中的 arrow/enter/escape/backspace/home/end/page）──

export const Key = {
  escape: "escape",
  esc: "esc",
  enter: "enter",
  return: "return",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  backspace: "backspace",
  space: "space",
  home: "home",
  end: "end",
  pageUp: "pageUp",
  pageDown: "pageDown",
} as const;

/** 简化版 matchesKey：把 raw terminal data 映射到 keyId，再与预期比较。
 *  覆盖测试场景中的 legacy 序列（\x1b[A/B/OA/OB, \r, \x1b, \x7f, \x1b[H/F/[5~/[6~）。 */
const DATA_TO_KEY: Record<string, string> = {
  "\x1b": "escape",
  "\r": "enter",
  "\n": "enter",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1bOA": "up",
  "\x1bOB": "down",
  "\x1bOC": "right",
  "\x1bOD": "left",
  "\x1b[H": "home",
  "\x1b[F": "end",
  "\x1bOH": "home",
  "\x1bOF": "end",
  "\x1b[5~": "pageUp",
  "\x1b[6~": "pageDown",
};

export function matchesKey(data: string, keyId: string): boolean {
  const mapped = DATA_TO_KEY[data];
  if (mapped !== undefined) return mapped === keyId;
  // 单字符匹配（如 "x", " " 等）
  if (data.length === 1 && data >= " " && data <= "~") return data === keyId;
  return false;
}
