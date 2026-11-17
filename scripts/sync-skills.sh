#!/usr/bin/env bash
# ============================================================================
# sync-skills.sh —— 把 skill 从唯一事实源同步到各 AI 编辑器的发现目录
#
# 为什么要这个脚本：
#   WorkBuddy 从 <项目>/.workbuddy/skills/ 发现 skill，
#   Trae     从 <项目>/.trae/skills/ 发现 skill，两边都遵循同一套 SKILL.md 规范。
#   如果手动在两处各放一份，改的时候必然漏一处——两边内容漂移后，
#   "在 WorkBuddy 里改好的流程"到 Trae 里就是旧的，非常隐蔽。
#   所以固定 .workbuddy/skills/ 为唯一事实源（source of truth），
#   这个文件一键把它整目录拷到 .trae/skills/，任何改动先改源再跑同步。
#
# 用法：
#   bash scripts/sync-skills.sh
#
# 行为：
#   - 目标目录内容与源保持一致（用 rsync --delete 清掉源里已删除的 skill）
#   - 打印同步了哪些 skill，方便确认
#   - 不联网、不调模型、不碰任何业务代码
# ============================================================================
set -euo pipefail

# 脚本在 scripts/ 下，项目根是它的上一级；用绝对路径拼接，避免依赖当前工作目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC="$PROJECT_ROOT/.workbuddy/skills"
DST_TRAE="$PROJECT_ROOT/.trae/skills"

if [ ! -d "$SRC" ]; then
  echo "错误：源目录不存在：$SRC" >&2
  exit 1
fi

# 统计源里的 skill 数量（算 SKILL.md 的个数），用于同步后核对
count_skills() {
  find "$1" -name SKILL.md -type f 2>/dev/null | wc -l | tr -d ' '
}

SRC_COUNT="$(count_skills "$SRC")"
echo "事实源：${SRC}（${SRC_COUNT} 个 skill）"

# rsync 的 --delete 保证目标不残留源里已删除的 skill；
# 没有 rsync 时退化为 cp（不删旧文件，至少保证内容同步过去）
if command -v rsync >/dev/null 2>&1; then
  mkdir -p "$DST_TRAE"
  rsync -a --delete "$SRC/" "$DST_TRAE/"
else
  echo "提示：未检测到 rsync，用 cp 同步（不会删除 Trae 目录里的多余文件）"
  mkdir -p "$DST_TRAE"
  cp -R "$SRC/." "$DST_TRAE/"
fi

DST_COUNT="$(count_skills "$DST_TRAE")"
echo "已同步 → ${DST_TRAE}（${DST_COUNT} 个 skill）"

if [ "$SRC_COUNT" != "$DST_COUNT" ]; then
  echo "警告：两端 skill 数量不一致，请手动检查" >&2
  exit 1
fi

echo "完成。以后新增/修改 skill 请只改 .workbuddy/skills/，改完重跑本脚本。"
