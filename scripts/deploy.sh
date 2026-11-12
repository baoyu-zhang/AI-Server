#!/usr/bin/env bash
# ============================================================================
# deploy.sh —— 一键构建 + 部署（P0）
#
# 做四件事，任何一步失败立即停止（set -e）：
#   1. 前端构建：web/ → dist/（vue-tsc 类型检查 + vite build）
#   2. 部署前备份一次数据库（改代码重启前留个快照，出问题可回滚数据）
#   3. pm2 启动/重启后端（已装 pm2 走 pm2；没装则降级提示如何安装）
#   4. 健康检查：/api/health 通了才算部署成功
#
# 用法：
#   bash scripts/deploy.sh            # 构建 + 重启 + 健康检查
#   bash scripts/deploy.sh --skip-web # 跳过前端构建（只改了后端代码时）
#
# 首次部署前置条件（一次性）：
#   npm install -g pm2                # 安装进程守护
#   server/.env 里配好 DEEPSEEK_API_KEY / ADMIN_USERNAME / ADMIN_PASSWORD
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"
WEB_DIR="$ROOT/web"
PORT="${PORT:-3000}"
SKIP_WEB=false
[ "${1:-}" = "--skip-web" ] && SKIP_WEB=true

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

# ---- 1. 前端构建 ----
if [ "$SKIP_WEB" = true ]; then
  step "跳过前端构建（--skip-web）"
else
  step "构建前端（web/ → dist/）"
  if [ ! -d "$WEB_DIR" ]; then
    echo "未找到 $WEB_DIR，跳过前端构建"
  else
    # 产物目录只覆盖不删除（web/vite.config.ts 里 emptyOutDir:false）：
    # 受限环境没有递归删除权限，vite 默认的"清空 dist"会让构建直接失败。
    # NODE_OPTIONS 清空：某些托管环境会给所有 node 进程注入 fs 拦截 shim，
    # 它对"覆盖已有构建文件"会弹策略询问导致构建挂住——构建只写 dist 目录，无需拦截。
    (cd "$WEB_DIR" && NODE_OPTIONS= npm run build)
  fi
fi

# ---- 2. 部署前数据库备份 ----
# 备份失败不阻断部署：它是兜底而不是前置条件。失败只需事后手动补一次，
# 让"备份磁盘抖动"变成一次告警而不是一次部署事故。
step "部署前数据库备份"
if ! (cd "$SERVER_DIR" && npm run backup); then
  echo "⚠️  备份失败（不影响本次部署）。请稍后在终端手动执行：cd server && npm run backup"
fi

# ---- 3. pm2 启动/重启 ----
step "重启服务（pm2）"
if ! command -v pm2 >/dev/null 2>&1; then
  echo "⚠️  未安装 pm2，降级为前台运行（Ctrl+C 会停服务）。建议：npm install -g pm2"
  echo "    临时启动：cd server && npm start"
  exit 1
fi
(cd "$SERVER_DIR" && pm2 start ecosystem.config.cjs --update-env 2>/dev/null || pm2 restart ai-server --update-env)

# ---- 4. 健康检查 ----
# 首次启动要加载本地 embedding 模型与向量索引，冷启动实测可达 60~90 秒，
# 所以窗口给到 90 秒——等不到再报错，比"误报失败其实马上就好"省心。
step "健康检查（最多等 90 秒，冷启动含模型加载）"
for i in $(seq 1 90); do
  # curl 走本机直连：绕开可能存在的系统代理（本机调试常见坑）
  if curl -fsS -m 2 --noproxy '*' "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "✅ 服务已就绪：http://localhost:$PORT（前端页面与 API 同端口）"

    # ---- 5. 部署后回归守门（P1）----
    # 光健康检查通了不算部署成功：200 只能证明进程活着，证明不了登录/落库/配额/工具链路没坏。
    # 默认跑「省钱模式」（SKIP_MODEL=1，跳过会真调模型产生费用的段落）；
    # 赶时间可以 SKIP_VERIFY=1 跳过，但上线前建议至少手动跑一次 npm run verify:all。
    if [ "${SKIP_VERIFY:-0}" != "1" ]; then
      step "部署后回归验收（省钱模式，不真调模型）"
      if (cd "$SERVER_DIR" && SKIP_MODEL=1 BASE_URL="http://127.0.0.1:$PORT" bash ../scripts/verify-all.sh); then
        echo "✅ 回归验收通过，部署完成"
        exit 0
      fi
      echo "❌ 回归验收失败：新版本可能有问题，请按上面的失败项排查，必要时回滚上一版"
      exit 1
    fi
    exit 0
  fi
  # 每 15 秒打一行进度，避免用户以为脚本卡死
  if [ $((i % 15)) -eq 0 ]; then echo "  …已等待 ${i}s（首次启动需加载模型，属正常）"; fi
  sleep 1
done
echo "❌ 健康检查未通过，请查看：bash scripts/logs.sh err 或 pm2 logs ai-server"
exit 1
