#!/bin/bash
# 共享 ANSI 颜色常量（RED/GREEN/YELLOW/BOLD/NC）。消费方 source 约定：scripts/ 子目录下的脚本
# 经 `source "$SCRIPT_DIR/../_lib/output.sh"` 引入，使用 `${RED}...${NC}` 形态着色。
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'
