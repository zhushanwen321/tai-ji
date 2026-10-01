# @zhushanwen/pi-rename-session

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
