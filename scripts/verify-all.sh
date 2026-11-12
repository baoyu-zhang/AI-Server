#!/usr/bin/env bash
# ============================================================================
# verify-all.sh —— P1 运维闭环：一条命令串跑 6 套验收
#
# 为什么要有这个脚本：验收套件散在 server/package.json 里，人肉按「命令清单.md §6」
# 一条条敲，容易漏、也记不住哪套会真调模型烧钱。这里按固定顺序一次跑完，
# 每套打印通过/失败与耗时，任何一套红了立即停（不把后面的套件带进一个已经坏掉的环境），
# 最后给一份中文汇总。CI / 改完代码的自检都用它。
#
# 顺序（与命令清单 §6 对齐，全部在 server/ 下用 npm run 执行）：
#   verify:auth → verify:p0 → verify:models → verify:mcp → verify:hr → test:agui
#
# 用法：
#   bash scripts/verify-all.sh                         # 全跑（会真调模型，产生 API 费用）
#   BASE_URL=http://127.0.0.1:3000 bash scripts/verify-all.sh   # 指向别处已启动的服务
#   SKIP_MODEL=1 bash scripts/verify-all.sh          # 省钱模式：全程不真调模型
#
# ===== 哪些脚本会真调模型、会产生 API 费用（SKIP_MODEL=1 就是为它准备的）=====
#   · verify:models 的 C 段：/agui 与 /v1 共 3 次短 prompt（命令清单标注「会真调 3 次」）
#   · verify:mcp   的 E 段：MCP 审批链路真调 1 次模型（仅 E 段调，A-D 不调）
#   · verify:hr    的 C/D 段：评分工具 + 改状态审批，两段都靠真模型发 tool-call
#   · verify:auth / verify:p0 / test:agui：完全不调模型（纯鉴权/配额/限流/协议断言）
#
# ===== SKIP_MODEL=1 具体怎么处理 =====
#   · verify:hr 内置了 --skip-model 开关，加参数即可跳过 C/D 段、保留 A/B/E/F，照常跑。
#   · verify:models / verify:mcp 当前版本【没有】内置「只跳过某一段」的开关：这两个脚本
#     是一个整体进程，一跑就会把 A/B/C 或 A~E 全部跑完，脚本也不读 SKIP_MODEL。
#     本模块不允许改动这两个验收脚本，因此 SKIP_MODEL=1 时只能【整套跳过】这两套——
#     等价于跳过其中会真调模型的 C / E 段，确保零 API 费用。汇总里会明确标「已跳过」，
#     不会伪装成通过。SKIP_MODEL 变量本身也会 export 透传下去：将来这两个脚本支持读它
#     自行跳过模型段时，把这里的 skip 改成 run 即可自动生效。
#
# 前置检查：先探 /api/health，不通直接报「服务未启动」退出，避免 6 套脚本各报一次连接拒绝。
# 刻意不使用任何 set 命令开关（尤其不逐条打印命令，保持输出干净）：因为要手动收每套的
# 退出码来做中文汇总，自动「遇错即退」反而来不及打印汇总。
# ============================================================================

# 脚本所在目录的上一级就是项目根；用 BASH_SOURCE 定位，从任何目录调用都成立
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"                       # 所有 npm run 都在这个目录下执行

# BASE_URL 可选透传：http-auth.mjs 及各验收脚本都读这个环境变量，默认指向本机 3000。
# export 是必须的——不 export 的话 npm 启动的子进程读不到，会退回脚本各自的默认值。
BASE_URL="${BASE_URL:-http://localhost:3000}"
export BASE_URL
# SKIP_MODEL 只认字面量 1；同样 export 透传，便于验收脚本将来自行读取
SKIP_MODEL="${SKIP_MODEL:-0}"
export SKIP_MODEL

# 汇总里逐套累积一行结果；总耗时用秒级时间戳做差（macOS / Linux 的 date +%s 都支持）
declare -a RESULTS=()
TOTAL_START=$(date +%s)

# ---- 前置检查：服务没起来就别浪费时间跑 6 套 ----
# --noproxy '*' 绕开系统代理（本机调试常见坑，deploy.sh 也是这么写的）；-m 3 最多等 3 秒。
if ! curl --noproxy '*' -fsS -m 3 "$BASE_URL/api/health" >/dev/null 2>&1; then
  echo "❌ 服务未启动：$BASE_URL/api/health 不通"
  echo "   请先在 server/ 下执行 npm start（冷启动要加载 embedding 模型，约 30 秒），再跑本脚本。"
  exit 1
fi
echo "✓ 服务已就绪：$BASE_URL"

# 跑一套：① 打印标题 ② 进入 server/ 执行 npm run ③ 收退出码算耗时 ④ 失败立即汇总并退出
# 额外参数（如 --skip-model）通过 npm 的 `--` 原样转给脚本：npm run X -- --skip-model
run_suite() {
  local label="$1"
  local script="$2"
  shift 2
  local extra=("$@")                            # 剩余参数 = 要透传给该 npm 脚本的参数
  local start dur code
  start=$(date +%s)
  printf '\n\033[1;34m==> %s\033[0m\n' "$label"

  local cmd=(npm run "$script")
  if [ "${#extra[@]}" -gt 0 ]; then
    cmd+=(-- "${extra[@]}")                   # `--` 之后 npm 不再解析，全部交给脚本
  fi
  (cd "$SERVER_DIR" && "${cmd[@]}")           # 子 shell 里 cd，不污染本脚本的工作目录
  code=$?
  dur=$(( $(date +%s) - start ))

  if [ "$code" -eq 0 ]; then
    RESULTS+=("✓ ${label}：通过（${dur}s）")
    return 0
  fi
  RESULTS+=("✗ ${label}：失败（${dur}s，退出码 ${code}）")
  printf '\033[1;31m✗ %s 失败，立即停止后续验收\033[0m\n' "$label"
  print_summary
  echo "❌ 存在失败项，验收中止。"
  exit 1
}

# 记一套「已跳过」：不算通过也不算失败，汇总里如实标注，避免把省钱模式误读成全绿
skip_suite() {
  local label="$1"
  RESULTS+=("— ${label}：已跳过（SKIP_MODEL=1，避免真调模型产生 API 费用）")
  printf '\n\033[1;33m==> %s：已跳过（SKIP_MODEL=1）\033[0m\n' "$label"
}

# 中文汇总：逐套结果 + 总耗时。失败中止与全部通过两条路径都会调它
print_summary() {
  local total_dur=$(( $(date +%s) - TOTAL_START ))
  echo ""
  echo "==================== 验收汇总 ===================="
  echo "BASE_URL=$BASE_URL    SKIP_MODEL=$SKIP_MODEL"
  for line in "${RESULTS[@]}"; do
    echo "  $line"
  done
  echo "---------------------------------------------------"
  echo "总耗时：${total_dur}s"
  echo "==================================================="
}

# ---- 按固定顺序跑 6 套 ----
run_suite "① 鉴权验收（verify:auth）"     verify:auth
run_suite "② P0 验收（verify:p0）"         verify:p0

if [ "$SKIP_MODEL" = "1" ]; then
  skip_suite "③ 模型验收（verify:models）"             # C 段真调 3 次模型，整套跳过
  skip_suite "④ MCP 验收（verify:mcp）"                # E 段真调 1 次模型，整套跳过
else
  run_suite "③ 模型验收（verify:models）" verify:models
  run_suite "④ MCP 验收（verify:mcp）"    verify:mcp
fi

if [ "$SKIP_MODEL" = "1" ]; then
  run_suite "⑤ 招聘场景验收（verify:hr）" verify:hr --skip-model   # 脚本内置开关：只跳 C/D 段
else
  run_suite "⑤ 招聘场景验收（verify:hr）" verify:hr
fi

run_suite "⑥ AG-UI 协议验收（test:agui）" test:agui

print_summary
echo "✅ 全部验收通过。"
exit 0
