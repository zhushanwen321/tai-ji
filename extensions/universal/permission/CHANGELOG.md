# @zhushanwen/pi-permission

## 1.6.0

### Minor Changes

- 802af968f: Waiting for your approval no longer fails closed after 5 minutes — the dialog stays open until you decide. The AI risk classifier's built-in 90-second timeout default is also retired: classification runs unbounded unless you configure `classifier.timeout` explicitly (requires pi 1.0.0).

## 1.5.0

### Minor Changes

- 0d36077d4: classifier thinkingLevel 配置契约放宽并数据驱动：配置归一不再做七值白名单校验（非空字符串即采信，`ClassifierConfig.thinkingLevel` 类型放宽为 string）；LLM 分类调用时档位按该模型 supportedLevels 判定（pi-ai `getSupportedThinkingLevels`），模型不支持的档位按「不传 reasoning」处理并 warn 留痕，不再静默换档。

## 1.4.9

### Patch Changes

- 50f31a73c: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.1 → @zhushanwen/pi-ext-guards@0.4.2, @zhushanwen/pi-llm-shared@0.10.0 → @zhushanwen/pi-llm-shared@0.10.1)

## 1.4.8

### Patch Changes

- 43a50ae2e: chore: refresh dependency range (triggered by @zhushanwen/pi-llm-shared@0.9.0 → @zhushanwen/pi-llm-shared@0.10.0)

## 1.4.7

### Patch Changes

- 8285841af: chore: refresh dependency range (triggered by @zhushanwen/pi-llm-shared@0.8.1 → @zhushanwen/pi-llm-shared@0.9.0)

## 1.4.6

### Patch Changes

- 10bde2f26: Fix README inaccuracies found in a fact-check pass: correct trigger conditions, config keys, and feature descriptions against current source behavior.

## 1.4.5

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
