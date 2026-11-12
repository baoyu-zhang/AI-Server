#!/usr/bin/env bash
# ============================================================================
# logs.sh —— 日志查询小工具（server/logs/app-YYYY-MM-DD.log）
#
#   bash scripts/logs.sh            实时跟随最新日志（默认，Ctrl+C 退出）
#   bash scripts/logs.sh err        只看 warn / error
#   bash scripts/logs.sh ls         列出所有日志文件与大小
#   bash scripts/logs.sh grep 关键词 跨所有日志搜关键词（带行号）
#   bash scripts/logs.sh http       只看 HTTP 访问行（方法 路径 状态 耗时）
#   bash scripts/logs.sh open       在 Finder 里打开日志目录
#   bash scripts/logs.sh clean      清空所有日志（要输 yes 确认）
#
# 也可以直接 npm run logs（在 server/ 目录下）
# ============================================================================
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LOG_DIR:-$ROOT/server/logs}"

if [ ! -d "$LOG_DIR" ]; then
  echo "日志目录不存在：$LOG_DIR"
  echo "后端还没用新版 logger 启动过吧？先启动一次：cd server && npm start"
  exit 0
fi

# 按修改时间取最新的那个文件：轮转后 app-日期.1.log 可能比 app-日期.log 新
latest() {
  ls -t "$LOG_DIR"/app-*.log 2>/dev/null | head -1
}

cmd="${1:-tail}"
[ $# -gt 0 ] && shift

case "$cmd" in
  tail)
    f="$(latest)"
    if [ -z "$f" ]; then
      echo "还没有日志文件，等后端产生第一条输出即可"
      exit 0
    fi
    echo ">>> 正在跟随 $f（Ctrl+C 退出）"
    # -F 能跟住轮转：文件被切走会重新打开新文件
    tail -n 80 -F "$f"
    ;;

  err)
    echo ">>> 最近 50 条 warn / error"
    grep -hE '"level":"(warn|error)"' "$LOG_DIR"/app-*.log 2>/dev/null | tail -50
    ;;

  ls)
    echo ">>> $LOG_DIR"
    ls -lh "$LOG_DIR"/app-*.log 2>/dev/null
    ;;

  grep)
    kw="${1:-}"
    if [ -z "$kw" ]; then
      echo "用法：bash scripts/logs.sh grep 关键词"
      exit 1
    fi
    grep -Hn -- "$kw" "$LOG_DIR"/app-*.log 2>/dev/null | tail -60
    ;;

  http)
    # 访问日志形如 {"msg":"GET /api/threads 200 1ms"}，按状态码归类更直观
    grep -ho '"msg":"[A-Z]* [^"]* [0-9]\{3\} [0-9]*ms"' "$LOG_DIR"/app-*.log 2>/dev/null \
      | sed 's/"msg":"//; s/"$//' | tail -80
    ;;

  open)
    open "$LOG_DIR"
    ;;

  clean)
    read -r -p "确认清空 $LOG_DIR 下所有日志？(yes/N) " ans
    if [ "$ans" = "yes" ]; then
      rm -f "$LOG_DIR"/app-*.log
      echo "已清空（后端再写时会自动重建文件）"
    else
      echo "已取消"
    fi
    ;;

  *)
    sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
esac
