# @zhushanwen/pi-rename-session

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
