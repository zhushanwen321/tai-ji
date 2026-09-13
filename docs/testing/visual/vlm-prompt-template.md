# VLM 视觉验证 Prompt 模板

> minimax-m3 VLM 对照 v6-master-spec 做语义对齐验证的标准化派发模板。
> 用途：v6 重构期半自动验收（agent / 人触发，非 CI gate）。失败不阻塞，降级为人工肉眼对照（ERR3）。

## 使用流程

1. 用 `scripts/visual-capture.mjs` 截目标页面 PNG（`node scripts/visual-capture.mjs --target demo --page <name>`）
2. 从 `docs/DESIGN.md` 摘录与截图相关的章节文字描述（要具体，见下方「SPEC_DESCRIPTION 示例」）
3. 主 agent 用 `subagent` 工具派发 `minimax-token-plan-router/minimax-m3`，task 用下方「派发 task 模板」填充两个占位
4. 接收 subagent 返回，校验 JSON schema，补全 `meta`（timestamp / model / screenshot 绝对路径等）
5. 归档到 `.xyz-harness/visual/<date>-<page>/result.json`，复制副本到 `docs/testing/visual/baselines/<page>-<target>.json`（git tracked）

## 派发 task 模板（三段式：背景 / 目标 / 验收标准）

```
【背景】xyz-agent 正在进行 v6 UI 重构，需要验证参考实现（demo）是否对齐 v6-master-spec 的视觉规则。
你是视觉验证 VLM，擅长看图说话（颜色 / 间距 / 对齐 / 元素是否存在）。本次验证一张静态截图。

【目标】对照下方 v6-master-spec 章节描述，逐区域检查截图是否符合，输出 VlmVerificationResult JSON。

截图绝对路径：{{SCREENSHOT_PATH}}

v6-master-spec 章节描述（逐条对照）：
{{SPEC_DESCRIPTION}}

【验收标准 / 输出契约】
输出必须是纯 JSON（不要 markdown 代码块包裹、不要前后多余文字），结构如下：
{
  "meta": {
    "page": "<页面名，如 sidebar / shell>",
    "target": "demo",
    "screenshot": "{{SCREENSHOT_PATH}}",
    "specRef": "<引用的 v6-master-spec 章节，如 §6.1 / D8>",
    "timestamp": "<ISO 8601>",
    "model": "minimax-token-plan-router/minimax-m3"
  },
  "regions": [
    {
      "region": "<区域或规则项名，如 'Sidebar 会话列表项选中态'>",
      "present": <true | false>,
      "issue": "<不符时的具体问题；present=true 时填 'ok' 或空字符串>"
    }
  ],
  "verdict": "aligned" | "partially-aligned" | "not-aligned"
}

可验收检查点（自检后再返回）：
- 输出是合法 JSON，可被 JSON.parse
- regions 是数组，每项都含 region / present / issue 三个字段
- present 为布尔值，issue 为字符串
- verdict 是 aligned / partially-aligned / not-aligned 三者之一
- 每条 SPEC_DESCRIPTION 都有对应的 regions 条目
```

## 占位符说明

### `{{SCREENSHOT_PATH}}`
截图 PNG 的绝对路径（minimax-m3 通过 read 工具读图）。例如：
`/Users/zhushanwen/Code/xyz-agent-workspace/feat-optimize-ui/.xyz-harness/visual/2026-08-03-shell/demo-shell.png`

### `{{SPEC_DESCRIPTION}}`
从 `docs/DESIGN.md` 摘录的具体章节文字描述。**必须具体到可对照，不能只写「检查对不对」**。

**好的示例**（D8 选中态二分规则）：
```
- D8 选中态二分规则：
  - tab 型选中态（顶部 Tab 切换、SegmentedTab）：用 bg-elevated（抬升层底色）表示选中
  - 列表项型选中态（会话列表 SessionList、文件树）：用 bg-surface（表面层）+ 蓝字（text-accent）表示选中，非选中项是默认底色 + text-neutral-fg
- Sidebar 布局：aside-region 顶部留白 52px（traffic light 安全区），含 Brand / SessionList / UserArea 三段
- 整体配色：太极纯灰暗色系统，--bg 深灰底，--surface / --elevated 分层，--accent 蓝色强调
```

**差的示例**（禁止）：
```
- 检查 sidebar 对不对
- 看看选中态是否符合 spec
```

## VlmVerificationResult schema（DM2）

```typescript
interface VlmVerificationResult {
  /** 验证元数据（主 agent 派发后补全部分字段）*/
  meta: {
    page: string
    target: 'demo' | 'devapp' | 'mock'
    screenshot: string         // 截图绝对路径
    specRef: string            // v6-master-spec 章节引用
    timestamp: string          // ISO 8601
    model: string              // 'minimax-token-plan-router/minimax-m3'
  }
  /** 逐区域 / 规则项对照结果 */
  regions: Array<{
    /** 区域或 v6-master-spec 规则项（如 'Composer 6 区结构' / 'D8 选中态二分'）*/
    region: string
    /** 该区域 / 规则是否在截图中符合 spec 描述 */
    present: boolean
    /** 不符时的具体问题（present=true 时为空或 'ok'）*/
    issue: string
  }>
  /** VLM 整体结论 */
  verdict: 'aligned' | 'partially-aligned' | 'not-aligned'
}
```

## 归档约定

- 截图 + result.json 同目录：`.xyz-harness/visual/<YYYY-MM-DD>-<page>/`（不进 git，在 `.gitignore` 的 `.xyz-harness/` 下）
- result.json 副本进 git：`docs/testing/visual/baselines/<page>-<target>.json`（便于团队追溯与基线沉淀）
- 多次验证按日期 / page 区分，避免覆盖

## 注意事项

- minimax-m3 是 VLM，输出非确定性。若返回严重偏离 schema（漏字段 / 叙述性文字），主 agent 人工修正后归档——这是 ERR3「降级人工肉眼对照」的体现
- demo（`.tmp/v6`）是 v6 视觉参考实现（gitignored 独立项目），devapp（CDP 9222）是重构后的真实 renderer。F4（token 反写）后对照对象从 demo 切换为 devapp
- 本模板适用于任意 v6-master-spec 章节的视觉验证，不限于 sidebar / shell
