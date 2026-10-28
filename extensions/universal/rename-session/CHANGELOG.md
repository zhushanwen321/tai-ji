# @zhushanwen/pi-rename-session

## 0.14.1

### Patch Changes

- da658a786: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.23.0 → @zhushanwen/extension-protocol@0.24.0)

## 0.14.0

### Minor Changes

- df839883b: feat: add "topic tag" built-in prompt style — generates subject-label titles (object + action, 4-15 chars, code symbols kept verbatim) with a full-sentence exception for scheduled/waiting tasks; resolved with the generic system prompt because the topic wording carries its own complete style constraints that conflict with the slug system prompt.

## 0.13.0

### Minor Changes

- 796f01b29: rename_session 结果 details 新增 summary 一行摘要，并新增 TUI renderResult（折叠态摘要、展开态原文）。

## 0.12.1

### Patch Changes

- 7babdefa7: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.4 → @zhushanwen/pi-ext-guards@0.5.0, @zhushanwen/pi-llm-shared@0.11.2 → @zhushanwen/pi-llm-shared@0.11.3)

## 0.12.0

### Minor Changes

- f6248708b: feat: support configurable title prompt styles (slug / sentence / emoji / custom)

  新增 style + customInstruction 配置侧（rename-prompt-config 设计）：非 custom 枚举风格映射内置词表（slug 现状行为 / sentence 完整短句 ≤20 字 / emoji 点缀开头 ≤15 字），custom 消费用户自定义自由文本（空串回落内置 slug 默认，systemPrompt 降级为输出契约骨架以消解双处风格冲突）。GUI 配置页经 runtime config.get/setRenamePrompt 读写，pi CLI 用户可直接改配置文件。maxTitleLength 语义不变。

## 0.11.2

### Patch Changes

- 993ee907f: Mark rename_session exposure:deferred (activates on a tool_search hit instead of the resident tool list) and fold the title format spec into the title field description, keeping the tool description to when-to-call guidance.

  Standalone pi users: deferred tools activate via pi's built-in tool_search, which ships inactive — add `"+tool_search"` to `defaultTools` in `<agentDir>/settings.json` (the `+` prefix keeps the read/bash/edit/write defaults) before the tool is reachable; without it the tool stays invisible to the model.

## 0.11.1

### Patch Changes

- 0c4bec66e: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.3 → @zhushanwen/pi-ext-guards@0.4.4, @zhushanwen/pi-llm-shared@0.11.1 → @zhushanwen/pi-llm-shared@0.11.2)

## 0.11.0

### Minor Changes

- 802af968f: Automatic session renaming no longer aborts the title call after 30 seconds: slow LLM responses complete the rename instead of being silently skipped (requires pi 1.0.0).

## 0.10.0

### Minor Changes

- 0d36077d4: thinkingLevel 配置契约放宽并数据驱动：配置归一不再做七值白名单校验（非空字符串即采信，`RenameSessionConfig.thinkingLevel` 类型放宽为 string）；标题生成 LLM 调用时档位按该模型 supportedLevels 判定（pi-ai `getSupportedThinkingLevels`），模型不支持的档位 warn 留痕并按「不传 reasoning」处理，不再静默换档。

## 0.9.5

### Patch Changes

- 43a50ae2e: Title generation now gives the LLM a 2048-token output budget so reasoning models can finish their thinking phase and still produce a title; previously the tight budget could yield empty or truncated session titles on reasoning models.

## 0.9.4

### Patch Changes

- 8285841af: chore: refresh dependency range (triggered by @zhushanwen/pi-llm-shared@0.8.1 → @zhushanwen/pi-llm-shared@0.9.0)

## 0.9.3

### Patch Changes

- 10bde2f26: Fix README inaccuracies found in a fact-check pass: correct trigger conditions, config keys, and feature descriptions against current source behavior.

## 0.9.2

### Patch Changes

- a59739edb: refactor(extensions): single-source rename landing pipeline and session-reader units
