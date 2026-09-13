// src/interface/list-component.ts
//
// /subagents list 全屏带框左右分屏组件实现。
// 从 list-view.ts 抽出（文件行数控制）：list-view.ts 保留 factory / key 处理，
// 组件渲染逻辑（边框、分屏布局、详情翻屏）归此文件。
//
// 依赖关系：组件只读 service.collectRecords + applyFilter，状态由 list-view 注入（ViewState）。
// 输入分发委托 keyHandler（list-view factory 注入 processKey），组件本身不处理按键语义。
// 组件 import list-shared（共享契约），不 import list-view → list-view → 组件单向依赖，无循环。

import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

import { computeElapsedSeconds } from "@zhushanwen/subagent-core";
import type { DisplayItem } from "@zhushanwen/subagent-core";
import type { SubagentService } from "@zhushanwen/subagent-core";
import type { SubagentRecord } from "@zhushanwen/subagent-core";
import { displayAgentName } from "@zhushanwen/subagent-core";
import {
  firstLine,
  formatDisplayItem,
  formatElapsedSeconds,
  formatEventLine,
  formatTokens,
  sanitizeLabel,
  shortId,
  spinnerGlyph,
  statusGlyph,
  type ThemeLike,
} from "./format.ts";
import {
  b,
  dash,
  dashes,
  padToVisible,
  plainBorder,
  segFillColored,
  termRows,
  titleBorder,
  truncLine,
  walled,
  wrapText,
} from "./tui-kit.ts";
import {
  applyFilter,
  type DetailKeyContext,
  type KeyHandler,
  LIST_LIMIT,
  type NotifyFn,
  type TuiLike,
  type ViewState,
} from "./list-shared.ts";

// ── 组件专用布局常量（factory/key 层不使用） ──

/** 左列占比。 */
const LEFT_COL_RATIO = 0.32;
/** 列最小宽度。 */
const COL_MIN_WIDTH = 20;
/** 列内最小内容宽度（兜底防负）。 */
const COL_INNER_MIN = 4;
/** 列内缩进（"→ " 或 "  " 前缀宽度）。 */
const COL_INDENT = 2;
/** 右列预览的最近 eventLog 条数。 */
const PREVIEW_RECENT_LINES = 3;

// ── 边框常量 ──
/** 左右边框字符宽度（│ x 2）。 */
const BORDER_WIDTH = 2;
/** 分屏模式下，框内**不滚动**的固定行数（顶框 1 + filter 1 + 分区线 1 + 底分区线 1 + footer 1 + 底框 1）。 */
const SPLIT_FIXED_LINES = 6;
/** 终端最小行数（低于此回退紧凑空列表框）。 */
const MIN_TERM_ROWS = 8;
/** 自画视觉边距：框外左右各 1 列空白（盖住底下对话流）。 */
const PAD_COLS = 2;
/** 自画视觉边距：框外顶底各 1 行空白。 */
const PAD_ROWS = 2;
/** 内框最小宽（兜底防极窄终端）。 */
const MIN_INNER_WIDTH = 4;
/** 内框最小高（兜底防极矮终端）。 */
const MIN_INNER_ROWS = 4;
/** 详情内容总行数探测宽度（够大避免截断折行影响行数统计）。 */
const DETAIL_LEN_PROBE_WIDTH = 9999;
/** 垂直居中除数（floor(剩余/2)）。 */
const VERT_CENTER_DIVISOR = 2;
/** spinner 帧切换粒度（与 Date.now() 配合选帧）。 */
const SPINNER_FRAME_MS = 250;
/**
 * [perf] 同帧 records 共享窗口（swf-perf-impl cleanup TC3/IF3/DM5）。
 * 250ms 动画帧内 hasRunning 与 buildLines（含 detail 路径 children 计算）各自
 * collectRecords(LIST_LIMIT) 全量合并扫描（内存 running + 磁盘 light 重建）——帧内合一。
 * 取值 50：须 < store 事件 debounce 120ms（事件驱动渲染大概率 TTL 已过走新鲜扫描）
 * 且 > 同 tick 内 hasRunning→render 微秒级间隔（命中复用）。最坏滞后 = 渲染合帧场景下
 * 50ms 内旧快照一帧，下一 animTimer tick / 事件渲染自愈，对 250ms 动画无感知差异。
 */
const FRAME_TTL_MS = 50;
/** 顶框嵌入标题（分屏模式）。 */
const TITLE_SPLIT = "Subagents";
/** 分屏分区线左/右嵌入标题。 */
const TITLE_LEFT = "Records";
const TITLE_RIGHT = "Detail";

/**
 * 全屏带框左右分屏 list 组件。
 *
 * 不缓存行（render 每次重建；records 经 collectRecordsFrame 帧缓存拉取——TTL 50ms 内
 * 同帧共享一份，保证 store 变化后刷新由 TTL/事件 debounce 兜底，见 FRAME_TTL_MS）。
 * 缓存的是「上次 render 的 width×rows」（用于 invalidate 后强制重建）。
 */
export class SubagentsListComponent implements Component {
  private cachedKey: string | undefined;
  private cachedLines: string[] | undefined;
  private closeFn: () => void = () => {};
  /** 动画 timer 句柄（dispose 兜底清理）。 */
  private animTimer: ReturnType<typeof setInterval> | undefined;
  /** [perf] 帧缓存：TTL 内复用同一份 records（collectRecordsFrame，TC3/IF3/DM5）。 */
  private frameRecords: SubagentRecord[] | undefined;
  private frameAt = 0;

  constructor(
    private readonly service: SubagentService,
    private readonly theme: ThemeLike,
    private readonly tui: TuiLike,
    private readonly state: ViewState,
    private readonly unsubscribe: () => void,
    private readonly notify: NotifyFn,
    /** 按键处理（list-view 的 processKey，依赖注入避免组件 import list-view）。 */
    private readonly keyHandler: KeyHandler,
  ) {}

  setCloseFn(fn: () => void): void {
    this.closeFn = fn;
  }

  /** 注入动画 timer 句柄（dispose 兜底清理用）。 */
  setAnimTimer(timer: ReturnType<typeof setInterval>): void {
    this.animTimer = timer;
  }

  /** 是否有 running record（动画 timer 据此决定是否刷新）。 */
  hasRunning(): boolean {
    return this.collectRecordsFrame().some((r) => r.status === "running");
  }

  /**
   * [perf] 帧缓存读取（TC3/IF3/DM5）：TTL（FRAME_TTL_MS=50ms）内复用同一份 records，
   * 过期/未缓存则调 service.collectRecords 刷新 {frameRecords, frameAt}。
   * hasRunning / handleInput / buildLines / buildDetailContent(children) 四个消费点统一走这里。
   * invalidate() 刻意不清帧缓存：invalidate 在 timer 序列（hasRunning→invalidate→requestRender）
   * 的共享路径中间，清了共享即失效；新鲜度由 TTL 独立保证 + animTimer 250ms tick 双重兜底。
   */
  private collectRecordsFrame(): SubagentRecord[] {
    if (this.frameRecords !== undefined && Date.now() - this.frameAt <= FRAME_TTL_MS) {
      return this.frameRecords;
    }
    const records = this.service.queries.collectRecords(LIST_LIMIT);
    this.frameRecords = records;
    this.frameAt = Date.now();
    return records;
  }

  /** [perf] 选中项详情数据：优先全量（懒加载 + per-file 缓存），拿不到回退 light。 */
  private fullRecordOf(r: SubagentRecord): SubagentRecord {
    return this.service.queries.getFullRecord(r.id) ?? r;
  }

  invalidate(): void {
    this.cachedKey = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    const rows = termRows(this.tui);
    const key = `${width}x${rows}`;
    if (key === this.cachedKey && this.cachedLines) return this.cachedLines;
    const lines = this.buildLines(width, rows);
    this.cachedKey = key;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (this.state.disposed) return;

    const records = applyFilter(this.collectRecordsFrame(), this.state.filterText);
    const selected = records[this.state.selectedIdx] ?? null;
    // 详情翻屏上下文：视口高 = 右侧 body 高（内框高 - SPLIT_FIXED_LINES），
    // contentLines = 详情内容总行数（含元数据/段头/eventLog/result/error，单一数据源）。
    // 与 renderRightDetail 的 viewH + max 计算保持一致。
    // [perf] 详情长度需重数据：选中项懒加载全量（带缓存）。
    const innerRows = Math.max(MIN_INNER_ROWS, termRows(this.tui) - PAD_ROWS);
    const bodyH = Math.max(1, innerRows - SPLIT_FIXED_LINES);
    const detailCtx: DetailKeyContext = {
      viewportHeight: bodyH,
      contentLines: selected ? this.detailContentLength(this.fullRecordOf(selected)) : 0,
    };

    const result = this.keyHandler(data, records, this.state, selected, this.service, detailCtx, this.notify);

    if (result.exit) {
      this.closeFn();
      return;
    }
    if (result.changed) {
      this.invalidate();
      this.tui.requestRender();
    }
  }

  // ── 内部：渲染 ──────────────────────────────────────────

  /**
   * 构建行数组（全屏覆盖 + 自画视觉边距）。
   *
   *   width  = render 收到的全屏宽（margin:0 → termCols，overlay 覆盖整个终端）
   *   rows   = terminal.rows（满屏高）
   *
   * overlay 不用 Pi 的 margin（那是物理留白会透出底下内容），改 margin:0 全屏覆盖，
   * 自己在框外加 1 行/1 列空白（盖住底下的对话流）：
   *   - 每行：` ` + 框行 + ` `（左右各 1 空格视觉边距）
   *   - 顶/底：各 1 行全宽空白
   *   - 内框宽 = width - 2（左右边距），内框高 = rows - 2（顶底边距）
   *
   * 分三个分支（基于内框尺寸）：
   *   1. 终端太矮（< MIN_TERM_ROWS）→ 紧凑提示，不画框
   *   2. 空列表 → 紧凑小框（不填满全屏）
   *   3. 有 records → 分屏满屏框（detailMode 控制右侧预览 vs 完整翻屏，不再切全屏页）
   */
  private buildLines(width: number, rows: number): string[] {
    // 内框尺寸（减去左右 1 列 + 顶底 1 行的视觉边距）
    const innerWidth = Math.max(MIN_INNER_WIDTH, width - PAD_COLS);
    const innerRows = Math.max(MIN_INNER_ROWS, rows - PAD_ROWS);

    const allRecords = this.collectRecordsFrame();
    const records = applyFilter(allRecords, this.state.filterText);

    // 先在内框尺寸下生成框行
    let innerLines: string[];
    if (rows < MIN_TERM_ROWS) {
      innerLines = this.renderTooSmall(innerWidth);
    } else if (allRecords.length === 0) {
      // 真正的空列表（无任何 subagent）→ 紧凑小框
      innerLines = this.renderEmptyBox(innerWidth);
    } else {
      // 有 records（即使 filter 无匹配，也保留分屏布局——只清空左右内容区）
      this.state.selectedIdx = Math.min(this.state.selectedIdx, Math.max(0, records.length - 1));
      innerLines = this.renderSplitBox(records, innerWidth, innerRows);
    }

    return this.applyPadding(innerLines, width, rows);
  }

  /**
   * 给内框行套视觉边距并填满全屏：顶/底各加空白行直到满屏高，每行加左右 1 空格。
   * 这些空白是 overlay 自己画的（盖住底下对话流），区别于 Pi 的物理 margin（透出底内容）。
   * 紧凑框（空列表/太矮）也会被空白填满全屏——保证整个终端被 overlay 覆盖。
   */
  private applyPadding(innerLines: string[], width: number, rows: number): string[] {
    const blank = " ".repeat(width);
    // 左右各加 1 空格的边距行（内框行 visibleWidth 已 = width - 2）
    const padLine = (line: string) => ` ${line} `;
    const result: string[] = [];
    // 顶部空白填满（紧凑框时把框垂直居中）
    const topPad = Math.max(1, Math.floor((rows - innerLines.length) / VERT_CENTER_DIVISOR));
    for (let i = 0; i < topPad; i++) result.push(blank);
    for (const line of innerLines) result.push(padLine(line));
    // 底部空白填满到 rows
    while (result.length < rows) result.push(blank);
    return result;
  }

  // ── 边框着色 helper 家族（b/dash/dashes/titleBorder/plainBorder/walled）──
  // 已收敛 ./tui-kit.ts 自由函数形态（post-convergence C4，WorkflowsView 形态胜出）；
  // 此处经 kit 导入消费，边框字符统一 borderMuted（避 ANSI 嵌套失色）。

  // ── 分支 1：终端太小 ──────────────────────────────────

  private renderTooSmall(width: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - BORDER_WIDTH);
    const msg = t.fg("warning", `Terminal too small (need >=${MIN_TERM_ROWS} rows)`);
    return [
      plainBorder(t, "╭", "╮", contentWidth),
      walled(t, padToVisible(msg, contentWidth), contentWidth),
      plainBorder(t, "╰", "╯", contentWidth),
    ];
  }

  // ── 分支 2：空列表紧凑框 ──────────────────────────────

  private renderEmptyBox(width: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - BORDER_WIDTH);
    const title = t.fg("accent", t.bold(` ${TITLE_SPLIT} `));
    return [
      titleBorder(t, "╭", title, "╮", contentWidth),
      walled(t, "", contentWidth),
      walled(t, truncLine(t.fg("dim", "(no subagent records)"), contentWidth), contentWidth),
      walled(t, "", contentWidth),
      walled(t, truncLine(t.fg("dim", "Esc to exit"), contentWidth), contentWidth),
      plainBorder(t, "╰", "╯", contentWidth),
    ];
  }

  // ── 分支 3：分屏满屏框（detailMode 控制右侧预览 vs 完整翻屏）──
  // 主函数只留「顶框 → filter 行 → 分区线 → body → 底分区线 → footer → 底框」编排，
  // 各段文案/内容构建拆至 splitBox* 私有方法。

  /** filter 行文案：阶段 2 锚定提示 / filter 输入态（光标 _）/ 空态。 */
  private splitBoxFilterLine(selected: SubagentRecord | null, inDetail: boolean): string {
    const t = this.theme;
    return inDetail
      ? t.fg("dim", `Pinned: ${selected?.agent ? displayAgentName(selected.agent) : ""} · Esc to return to list`)
      : (this.state.filterText
        ? `${t.fg("dim", "filter: ")}${t.bold(this.state.filterText)}${t.fg("accent", "_")}`
        : `${t.fg("dim", "filter: ")}${t.fg("accent", "_")}`);
  }

  /** 分区线右标题：阶段 2 带滚动位置指示（detailScrollInfo），否则固定 " Detail "。 */
  private splitBoxRightTitle(
    inDetail: boolean,
    selectedFull: SubagentRecord | null,
    bodyH: number,
    detailContent: string[] | null,
  ): string {
    const t = this.theme;
    return inDetail
      ? t.fg("accent", t.bold(` ${TITLE_RIGHT}${this.detailScrollInfo(selectedFull, bodyH, detailContent?.length)} `))
      : t.fg("accent", t.bold(` ${TITLE_RIGHT} `));
  }

  /** body 左右列内容：filter 无匹配时双提示占位（保留分屏布局）；
   *  否则左列视口窗口（选中行居中，到列表顶/底贴边）+ 右列预览 or 完整翻屏。 */
  private splitBoxBodyLines(
    records: SubagentRecord[],
    selectedFull: SubagentRecord | null,
    inDetail: boolean,
    leftWidth: number,
    rightWidth: number,
    bodyH: number,
    detailContent: string[] | null,
  ): { leftLines: string[]; rightLines: string[] } {
    const t = this.theme;
    if (records.length === 0) {
      // filter 无匹配：保留分屏布局，左右都显示提示
      return {
        leftLines: [t.fg("dim", `(no match for "${this.state.filterText}")`)],
        rightLines: [t.fg("dim", "(no record selected)")],
      };
    }
    // 左列视口窗口：选中行尽量居中，到列表顶/底贴边。
    // 保证 leftLines.length <= bodyH → bodyRows = bodyH 恒定，帧行不溢出终端（无残影）。
    const maxLeftStart = Math.max(0, records.length - bodyH);
    const leftStart = Math.max(0, Math.min(
      Math.floor(this.state.selectedIdx - bodyH / VERT_CENTER_DIVISOR),
      maxLeftStart,
    ));
    return {
      leftLines: this.renderLeftColumn(records, leftWidth, leftStart, bodyH),
      rightLines: inDetail
        ? this.renderRightDetail(selectedFull, rightWidth, bodyH, detailContent)
        : this.renderRightPreview(selectedFull, rightWidth, bodyH),
    };
  }

  /** footer 双文案：阶段 2 滚动提示（running 时附取消提示）/ 阶段 1 导航提示。 */
  private splitBoxFooter(inDetail: boolean, selected: SubagentRecord | null): string {
    const t = this.theme;
    return inDetail
      ? t.fg("dim", "Esc back to list · Up/Dn/PgUp/PgDn/Home/End scroll detail" + this.cancelHint(selected))
      : t.fg("dim", "Up/Dn navigate · Enter detail · type to filter · Esc exit");
  }

  private renderSplitBox(records: SubagentRecord[], width: number, rows: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - BORDER_WIDTH);
    // 左右列宽：左按比例，右占余下（减去分隔符 1 列）
    const leftWidth = Math.max(COL_MIN_WIDTH, Math.floor(contentWidth * LEFT_COL_RATIO));
    const rightWidth = Math.max(COL_MIN_WIDTH, contentWidth - leftWidth - 1);
    const sep = b(t, "│");

    // 满屏可用 body 高 = 内框高 - 固定行（顶框/filter/分区线/底分区线/footer/底框 = 6）
    // rows 参数已是内框高（顶底空白边距已在 buildLines 扣除）。
    const bodyH = Math.max(1, rows - SPLIT_FIXED_LINES);

    const selected = records[this.state.selectedIdx] ?? null;
    const inDetail = this.state.detailMode; // 阶段 2：右侧滚动焦点
    // [perf] 预览/详情需重数据（displayItems/turns/tokens/result）：选中项按需全量加载
    // （per-file 缓存，stat 校验）；列表其余行保持 light（identity+状态），列表扫描不开销全量解析。
    const selectedFull = selected ? this.fullRecordOf(selected) : null;
    // 预构建详情内容（inDetail 时）：分区线标题(detailScrollInfo 算长度)与右列(renderRightDetail 渲染)
    // 共用同一份，避免每帧双倍构建（animTimer 250ms 触发，长 eventLog 下有感）。
    const detailContent = inDetail && selectedFull ? this.buildDetailContent(selectedFull, rightWidth) : null;

    const lines: string[] = [];

    // 顶框（嵌入标题，分段着色）
    lines.push(titleBorder(t, "╭", t.fg("accent", t.bold(` ${TITLE_SPLIT} `)), "╮", contentWidth));

    // filter 行（阶段 2 时隐藏 filter 提示，显示锚定提示）
    lines.push(walled(t, padToVisible(truncLine(this.splitBoxFilterLine(selected, inDetail), contentWidth), contentWidth), contentWidth));

    // 分区线（嵌入左/右标题，分段着色）
    const leftTitleStyled = t.fg("accent", t.bold(` ${TITLE_LEFT} `));
    const rightTitleStyled = this.splitBoxRightTitle(inDetail, selectedFull, bodyH, detailContent);
    lines.push(
      b(t, "├") + segFillColored(leftTitleStyled, dash(t), leftWidth)
        + b(t, "┬") + segFillColored(rightTitleStyled, dash(t), rightWidth) + b(t, "┤"),
    );

    // body：左列 record 列表 + 右列（预览 or 完整翻屏）
    const { leftLines, rightLines } = this.splitBoxBodyLines(records, selectedFull, inDetail, leftWidth, rightWidth, bodyH, detailContent);
    const bodyRows = Math.max(leftLines.length, rightLines.length, bodyH);
    for (let i = 0; i < bodyRows; i++) {
      const l = leftLines[i] ?? "";
      const r = rightLines[i] ?? "";
      const row = `${padToVisible(truncLine(l, leftWidth), leftWidth)}${sep}${padToVisible(truncLine(r, rightWidth), rightWidth)}`;
      lines.push(walled(t, padToVisible(row, contentWidth), contentWidth));
    }

    // 底分区线
    lines.push(b(t, "├") + dashes(t, leftWidth) + b(t, "┴") + dashes(t, rightWidth) + b(t, "┤"));

    // footer（双文案）
    lines.push(walled(t, padToVisible(truncLine(this.splitBoxFooter(inDetail, selected), contentWidth), contentWidth), contentWidth));

    // 底框
    lines.push(plainBorder(t, "╰", "╯", contentWidth));

    return lines;
  }

  /** 详情模式滚动位置指示（嵌入分区线标题），如 "Detail (5-12/30)"。无内容则空。
   *  contentLen 由调用方（renderSplitBox）从预构建的 detailContent 传入，避免重复构建。 */
  private detailScrollInfo(record: SubagentRecord | null, viewH: number, contentLen?: number): string {
    if (!record) return "";
    const len = contentLen ?? this.detailContentLength(record);
    if (len <= viewH) return ""; // 内容一屏装下，不显示
    const max = Math.max(0, len - viewH);
    const start = Math.max(0, Math.min(this.state.scrollOffset, max));
    const end = Math.min(start + viewH, len);
    return ` (${start + 1}-${end}/${len})`;
  }

  /** footer 的取消提示（仅 running 时显示）。 */
  private cancelHint(record: SubagentRecord | null): string {
    if (!record || record.status !== "running") return "";
    return record.mode === "background" ? " · x stop" : " · x stop (hint)";
  }

  /**
   * 左列：record 列表（带视口窗口）。阶段 2（detailMode）时非锚定行 dim，锚定行用 ▶。
   *
   * 视口窗口 [startIdx, startIdx+count)：record 数超过 bodyH 时只渲染选中行附近的窗口，
   * 保证 leftLines.length <= bodyH → bodyRows = bodyH 恒定 → 帧行不溢出终端。
   * 溢出会导致 overlay 无法清屏，残留旧帧行（递归场景 record 多，必然触发）。
   * 窗口由 renderSplitBox 按 selectedIdx 居中算定，此处只做切片渲染。
   */
  private renderLeftColumn(records: SubagentRecord[], width: number, startIdx: number, count: number): string[] {
    const t = this.theme;
    const innerWidth = Math.max(COL_INNER_MIN, width - COL_INDENT);
    const inDetail = this.state.detailMode;
    // spinner 当前帧（Date.now() 驱动；animTimer 定期 invalidate → render 重选帧）
    const spinFrame = spinnerGlyph(Math.floor(Date.now() / SPINNER_FRAME_MS));
    const endIdx = Math.min(records.length, startIdx + count);
    const lines: string[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      const r = records[i];
      const selected = i === this.state.selectedIdx;
      const glyph = statusGlyph(r.status);
      const icon = glyph.icon ?? spinFrame;
      const iconStr = t.fg(glyph.color, icon);
      const modeTag = "bg";
      const dur = formatElapsedSeconds(elapsedSec(r));
      // 短编号(dim)置于行首——列表一眼看到「第几个」, 不必进详情.
      const sid = t.fg("dim", shortId(r.id));
      // 方案 D：递归深度标记。顶层(depth=0, 主 session 直接创建)不显示；
      // depth≥1 显示 [L2]/[L3]...——平铺列表一眼区分哪些是嵌套产生的，不干扰 fan-out 场景。
      const depthTag = r.depth > 0 ? ` ${t.fg("dim", `[L${r.depth + 1}]`)}` : "";
      // slug 非空时在 agent 后展示（accent 色），空串时省略。
      const slugTag = r.slug ? ` ${t.fg("accent", r.slug)}` : "";
      const label = `${iconStr} ${sid}${depthTag} ${displayAgentName(r.agent)}${slugTag} ${t.fg("dim", modeTag)} ${t.fg("dim", dur)}`;
      // 阶段 2：锚定行 accent + ▶；其余行 dim。阶段 1：选中 accent + →，其余正常。
      const content = inDetail
        ? (selected ? t.fg("accent", label) : t.fg("dim", label))
        : (selected ? t.fg("accent", label) : label);
      const prefix = selected ? (inDetail ? "▶ " : "→ ") : "  ";
      lines.push(`${prefix}${truncLine(content, innerWidth)}`);
    }
    return lines;
  }

  /** 右列：选中 record 的预览（阶段 1）。bodyH 截断防小终端溢出（见 renderSplitBox 不变量）。 */
  private renderRightPreview(record: SubagentRecord | null, width: number, bodyH: number): string[] {
    const t = this.theme;
    if (!record) return [t.fg("dim", "(no record selected)")];

    const lines: string[] = [];
    // task 置顶——这是「subagent 在干什么」的唯一线索（streaming 时尤甚）。
    // 预览阶段不进详情也必须可见，否则用户浏览列表时无法判断每条记录的任务。
    if (record.task) {
      // task 取首行——prompt 常含换行（多行指令），直接渲染会因 \n 意外换行，
      // 破坏右列行对齐（每行变多行，后续内容全部错位）。完整多行 task 在 detail 模式可滚屏查看。
      const taskLine = firstLine(record.task);
      if (taskLine) {
        lines.push(truncLine(t.fg("accent", `task: ${taskLine}`), width));
        lines.push("");
      }
    }
    lines.push(truncLine(`${t.bold(displayAgentName(record.agent))} ${t.fg("dim", `· ${record.model}`)}`, width));
    lines.push(truncLine(
      t.fg("dim", `${record.status} · ${record.turns} turns · ${formatTokens(record.totalTokens)} · ${formatElapsedSeconds(elapsedSec(record))}`),
      width,
    ));
    // 完整 id(含 background 时间戳): cancel/read session file 需精确引用. 左列只显示短编号.
    lines.push(truncLine(t.fg("dim", `id: ${record.id}`), width));
    // 层级：父 subagent（顶层显示 root）——不需要外部数据，record 自带 parentRecordId。
    lines.push(truncLine(
      t.fg("dim", `parent: ${record.parentRecordId ? shortId(record.parentRecordId) : "(root)"}`),
      width,
    ));
    lines.push("");

    // displayItems 从 turns[] 派生（含完整 text + toolCall），比 eventLog 信息密度高——
    // eventLog 的 turn_end 丢弃 text 正文，预览看不到 subagent 输出。改用 displayItems
    // 让流式/终态都能看到 text。running 时实时派生，终态从重建 turns[] 派生。
    const recent = record.displayItems.slice(-PREVIEW_RECENT_LINES);
    if (recent.length === 0 && record.eventLog.length > 0) {
      // displayItems 为空但 eventLog 有（旧数据兜底）：回退 eventLog。
      for (const entry of record.eventLog.slice(-PREVIEW_RECENT_LINES)) {
        lines.push(truncLine(formatEventLine(entry, t), width));
      }
    } else if (recent.length === 0) {
      lines.push(truncLine(t.fg("dim", "(no output)"), width));
    } else {
      for (const item of recent) {
        lines.push(truncLine(formatDisplayItem(item, t), width));
      }
    }

    lines.push("");
    lines.push(truncLine(t.fg("dim", "Enter for full detail"), width));
    // 截断到 bodyH：小终端（tmux 分屏 bodyH 可能 2-6 行）下预览固定 ~10 行会溢出框，
    // 导致 bodyRows = max(left,right,bodyH) > bodyH → 帧行把底分区线/footer/底框推出终端（残影）。
    // 左列已有视口窗口保证 <= bodyH，右列预览在此对齐。优先保留头部身份信息。
    return lines.slice(0, bodyH);
  }

  /**
   * 右列：完整详情（阶段 2，detailMode）。完整 eventLog + result/error + sessionFile，
   * scrollOffset 翻屏。顶部对齐（task 置顶可见）——Enter 进阶段 2 时 scrollOffset=0。
   *
   * 内容行生成与 detailContentLength 共用 buildDetailContent（单一数据源）。
   */
  private renderRightDetail(record: SubagentRecord | null, width: number, viewH: number, content?: string[] | null): string[] {
    const t = this.theme;
    if (!record) return [t.fg("dim", "(no record selected)")];

    const lines = content ?? this.buildDetailContent(record, width);
    // 翻屏（顶部对齐：scrollOffset ∈ [0, max]）
    const max = Math.max(0, lines.length - viewH);
    if (this.state.scrollOffset > max) this.state.scrollOffset = max;
    const start = Math.max(0, Math.min(this.state.scrollOffset, max));
    this.state.scrollOffset = start; // 回写收敛（End/Home 越界后下次渲染归位）
    const visible = lines.slice(start, start + viewH);
    // pad 到 viewH（视口填满）
    while (visible.length < viewH) visible.push("");
    return visible;
  }

  /** 详情内容行（单一数据源：renderRightDetail 渲染 + detailScrollInfo 算长度都走这里）。
   *  只做分段编排；各段构建见 push*Section 家族（顺序 = 原 buildDetailContent 单函数内行序）。 */
  private buildDetailContent(record: SubagentRecord, width: number): string[] {
    const content: string[] = [];
    this.pushTaskSection(content, record, width);
    this.pushMetaSection(content, record, width);
    this.pushActivitySection(content, record, width);
    this.pushOutputSection(content, record, width);
    this.pushTailSections(content, record, width);
    return content;
  }

  /**
   * task 段：完整 word-wrap 置顶（streaming 时这是「它在干嘛」的唯一线索，不截断）。
   * 首行带 `task: ` 前缀，续行缩进对齐（缩进宽度 = 前缀可见宽度）。
   */
  private pushTaskSection(content: string[], record: SubagentRecord, width: number): void {
    const t = this.theme;
    const taskPrefix = "task: ";
    const taskWrapWidth = Math.max(1, width - visibleWidth(taskPrefix));
    const taskLines = wrapText(record.task, taskWrapWidth);
    for (let i = 0; i < taskLines.length; i++) {
      const lineText = taskLines[i];
      if (i === 0) {
        content.push(truncLine(t.fg("accent", `${taskPrefix}${lineText}`), width));
      } else {
        content.push(truncLine(t.fg("accent", `${" ".repeat(visibleWidth(taskPrefix))}${lineText}`), width));
      }
    }
    if (taskLines.length === 0) {
      content.push(truncLine(t.fg("accent", `${taskPrefix}(empty)`), width));
    }
  }

  /** 元数据段：id/mode/status/stopReason/turns/tokens 行 + model/thinking 行 + parent/children 层级行。 */
  private pushMetaSection(content: string[], record: SubagentRecord, width: number): void {
    const t = this.theme;
    // 元数据：第 1 行 id + 状态 + turns + tokens。stopReason（上一轮为什么停）只在
    // 详情面板出现（§3.2.1 展示层词汇收敛：列表主展示用状态词，停因是排障信息）；
    // 有值即追加 `stopped: <reason>` 段（与 SubagentTab 同判据——A-lite 轮终
    // running-resumable 也携带合法停因），缺省省略（在飞首轮 / 存量无字段）。
    const stopPart = record.stopReason
      ? ` · stopped: ${record.stopReason}`
      : "";
    content.push(truncLine(
      t.fg("dim", `${record.id} · ${record.mode} · ${record.status}${stopPart} · ${record.turns} turns · ${formatTokens(record.totalTokens)}`),
      width,
    ));
    // 元数据：第 2 行 model + thinking（括号分组）
    const metaParts: string[] = [];
    if (record.model) metaParts.push(record.model);
    if (record.thinkingLevel) metaParts.push(`thinking ${record.thinkingLevel}`);
    content.push(metaParts.length > 0
      ? truncLine(t.fg("dim", `(${metaParts.join(" · ")})`), width)
      : "");

    // 层级信息（方案 B）：parent + children，让递归链可追溯。
    // parent 不需外部数据；children 需查同 session 的 record（collectRecords 有磁盘缓存，开销可接受）。
    const parentLabel = record.parentRecordId ? shortId(record.parentRecordId) : "(root)";
    content.push(truncLine(t.fg("dim", `parent: ${parentLabel}`), width));
    const childIds = this.collectRecordsFrame()
      .filter((r) => r.parentRecordId === record.id)
      .map((r) => shortId(r.id));
    content.push(truncLine(
      t.fg("dim", `children: ${childIds.length > 0 ? childIds.join(", ") : "(none)"}`),
      width,
    ));
  }

  /** 当前活动行（仅内存 running 源；磁盘重建为 undefined）。streaming 可观测性。 */
  private pushActivitySection(content: string[], record: SubagentRecord, width: number): void {
    if (record.currentActivity) {
      content.push(truncLine(this.theme.fg("accent", `▸ ${record.currentActivity.label}`), width));
    }
  }

  /**
   * Output 段：标题 + displayItems（text 完整 word-wrap / toolCall 单行）。
   * displayItems 为空但 eventLog 有数据时回退 eventLog（旧数据兼容）。
   */
  private pushOutputSection(content: string[], record: SubagentRecord, width: number): void {
    const t = this.theme;
    content.push("");
    content.push(truncLine(t.fg("accent", t.bold("── Output ──")), width));

    // displayItems 从 turns[] 派生：完整 text + toolCall 序列（对齐 nicobailon getDisplayItems）。
    // 替代旧 Event Log——eventLog 的 turn_end 曾丢弃 text 正文（现虽显示摘要但不完整），
    // 导致详情看不到 subagent 的完整输出。displayItems 保留每 turn 的完整 text。
    // running 时实时派生（流式 text 不丢失），终态从重建 turns[] 派生。
    if (record.displayItems.length === 0 && record.eventLog.length > 0) {
      // 旧数据兼容（displayItems 为空但 eventLog 有数据）：回退 eventLog。
      for (const entry of record.eventLog) {
        content.push(truncLine(formatEventLine(entry, t), width));
      }
    } else if (record.displayItems.length === 0) {
      content.push(truncLine(t.fg("dim", "(no output)"), width));
    } else {
      for (const item of record.displayItems) {
        this.pushDisplayItemLines(content, item, width);
      }
    }
  }

  /** 单个 displayItem 行：text 完整 word-wrap（每行单独着色），toolCall 单行（name + args 摘要 + ✓/✗）。 */
  private pushDisplayItemLines(content: string[], item: DisplayItem, width: number): void {
    const t = this.theme;
    if (item.type === "text") {
      // detail 模式：text 完整换行展示（word-wrap），不截断。subagent 的正文输出
      // 可能很长（报告/分析），截断成省略号会丢信息——detail 有翻屏，完整性优先。
      // wrapText 输入纯文本，每行单独着色 toolOutput。
      const textLines = wrapText(item.text ?? "", width);
      for (const tl of textLines) {
        content.push(truncLine(t.fg("toolOutput", tl), width));
      }
    } else {
      // toolCall：单行足够（name + args 摘要 + ✓/✗），truncLine 截断。
      content.push(truncLine(formatDisplayItem(item, t), width));
    }
  }

  /** 尾段：result（word-wrap 完整展示）/ error（首行）/ session 文件路径，各自前置空行。 */
  private pushTailSections(content: string[], record: SubagentRecord, width: number): void {
    const t = this.theme;
    if (record.result) {
      content.push("");
      content.push(truncLine(t.fg("accent", "Result:"), width));
      // result 同样 word-wrap 完整展示（与 task/text 一致，detail 不截断）。
      for (const l of wrapText(record.result, width)) {
        content.push(truncLine(sanitizeLabel(l), width));
      }
    }
    if (record.error) {
      content.push("");
      content.push(truncLine(t.fg("error", `Error: ${firstLine(record.error)}`), width));
    }
    if (record.sessionFile) {
      content.push("");
      content.push(truncLine(t.fg("dim", `session: ${record.sessionFile}`), width));
    }
  }

  /** 详情内容总行数（供 detailScrollInfo 算 max，不重复生成）。 */
  private detailContentLength(record: SubagentRecord): number {
    // 复用 buildDetailContent 的行数：用足够大的宽度避免截断折行影响行数统计。
    return this.buildDetailContent(record, DETAIL_LEN_PROBE_WIDTH).length;
  }


  /** dispose 时清理（Pi overlay 销毁时调用；wrappedDone 已清过，此处兜底防漏）。
   *  Pi SDK `showExtensionCustom.close()` 在 `done()` 后调 `component.dispose()`
   *  （pi-mono interactive-mode.ts 的 close 回调）——框架回调契约，非死代码。
   *  wrappedDone 已做 unsubscribe + clearInterval，此处幂等兜底。 */
  // fallow 检测不到框架动态调用，标记 unused-class-member 是误报。
  dispose(): void {
    this.unsubscribe();
    if (this.animTimer !== undefined) {
      clearInterval(this.animTimer);
      this.animTimer = undefined;
    }
  }
}

/** 计算 record 已耗时秒（endedAt 优先，否则 now - startedAt）。
 *  委托给 Core 层共享 helper computeElapsedSeconds，消除发散。 */
function elapsedSec(r: SubagentRecord): number {
  return computeElapsedSeconds(r);
}
