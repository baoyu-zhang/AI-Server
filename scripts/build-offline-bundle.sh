#!/usr/bin/env bash
set -euo pipefail
# ============================================================================
# build-offline-bundle.sh —— 产出可搬运到客户内网的「离线安装包」
# ============================================================================
# 产物目录：output/offline-bundle-<YYYYMMDD>/
#   ├── image.tar.gz        docker save | gzip 出来的完整镜像（含 web/dist + server + 模型缓存）
#   ├── docker-compose.yml  交付用编排文件（从 deploy/ 复制，路径与镜像名已对齐）
#   ├── .env.example        环境变量模板（客户机据此生成 .env，绝不随包分发真实密钥）
#   ├── BUILD-INFO.txt      镜像架构 / 构建机架构 / 构建时间，现场排 exec format error 用
#   ├── LICENSE             仓版权属声明（商业许可，不是开源许可）
#   ├── CHANGELOG.md        本版本变更与已知限制
#   ├── docs/操作手册.md     一页纸：部署、管理员、备份恢复、换品牌、常见故障
#   ├── docs/legal/         协议四件套 + 法务待确认清单（模板草案，需法务审核）
#   ├── templates/          branding / license / mcp 三份配置示例（改成客户自己的值）
#   └── SHA256SUMS          除自身外所有文件的校验和，客户机校验完整性用
#
# 为什么把文档也打进包：Docker 镜像里只 COPY 了 server/ 与 web/dist，docs/ 不在镜像内。
# 客户机房通常没外网，拿不到仓库，协议、操作手册、品牌模板必须随包一起搬运，
# 否则「能签」这一步缺件。SHA256SUMS 用 find 动态枚举，新增文件不会漏校验。
#
# ===== 为什么要把镜像 save 成 tar.gz =====
# 客户现场不能出网，也就没法 docker pull。把「已经装好模型」的镜像导出成一个文件，
# 用硬盘/内网拷过去再 docker load，才算真正的离线交付。
#
# ===== 为什么先跑 prefetch 再 build =====
# Dockerfile.offline 会 COPY model-cache/ 进镜像。顺序反了（先 build）会直接报目录不存在；
# 更隐蔽的是目录存在但不完整，镜像能构建出来、离线启动才失败。所以这里显式先跑一次
# prefetch，并用 set -e 保证它失败就整体退出、绝不继续打出一个「看起来成功」的包。
#
# ===== 为什么必须检测 docker =====
# 开发机通常没有 docker，而打包必须在装有 docker 且 daemon 已启动的构建机上做。
# 若不检测，docker build 只报一句英文 "command not found"，脚本还会在 set -e 下中途退出、
# 留下一个空目录，很容易被误当成「包打好了」。这里给出可操作的中文提示后明确退出。
#
# ===== 为什么同时打两个镜像 tag =====
# 带日期的 tag 便于区分批次；ai-server-offline:latest 则与 deploy/docker-compose.yml
# 里的 image 名一致——客户机 docker load 后 compose 直接命中现成镜像、不会触发重新 build
# （离线包里没有源码，一旦触发 build 必然失败）。docker save 会把两个 tag 一起导出。
# ============================================================================

# 以脚本自身位置反推仓库根：无论从哪个 cwd 调用，COPY 上下文与所有路径都正确。
# 项目路径含中文，所有路径变量一律加引号。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# ---------- 前置检查：docker 必须存在且 daemon 可用 ----------
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ 未检测到 docker 命令，无法构建离线镜像包。" >&2
  echo "" >&2
  echo "   离线安装包必须在【已安装 docker 且 daemon 正在运行】的构建机上生成，本脚本不会假装成功。" >&2
  echo "   请按以下步骤处理后重试：" >&2
  echo "     1) 安装 Docker Desktop（macOS/Windows）或 docker engine（Linux）；" >&2
  echo "     2) 启动 docker，确认 'docker version' 能同时看到 Client 与 Server；" >&2
  echo "     3) 确认 'docker info' 无报错（daemon 已就绪）；" >&2
  echo "     4) 重新执行：bash scripts/build-offline-bundle.sh" >&2
  echo "" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "❌ 已找到 docker 命令，但 docker daemon 未就绪（'docker info' 失败）。" >&2
  echo "   请先启动 Docker Desktop / docker 服务，确认 'docker info' 正常后再重试。" >&2
  exit 1
fi

# ---------- 变量 ----------
DATE="$(date +%Y%m%d)"                       # 8 位日期，同一天重跑覆盖同一目录
TAG="ai-server-offline:${DATE}"              # 批次 tag
LATEST="ai-server-offline:latest"            # 与 compose 的 image 对齐
BUNDLE_DIR="$ROOT/output/offline-bundle-${DATE}"
IMAGE_FILE="image.tar.gz"

# ===== 目标 CPU 架构：这是离线交付最容易翻车的一处 =====
# 默认 linux/amd64：客户机房 / 政企内网服务器绝大多数是 x86_64。
# 若开发机是 Apple Silicon（arm64，本项目当前开发机就是），不显式指定 --platform 的话，
# docker build 会按【构建机】架构产出 arm64 镜像；客户机 docker load 后能导入、compose
# 也能起容器，但一执行就报 "exec /usr/local/bin/node: exec format error"，现场极难定位。
# 镜像架构是构建时固化的，docker load / docker run 都改不了，只能在 build 这一步决定。
#
# 覆盖方式（客户机是 ARM 服务器时才需要）：
#   TARGET_PLATFORM=linux/arm64 npm run bundle:offline
# 客户机怎么查：uname -m → x86_64 选 linux/amd64，aarch64/arm64 选 linux/arm64。
TARGET_PLATFORM="${TARGET_PLATFORM:-linux/amd64}"

# 构建机 daemon 的真实架构（Docker Desktop / Colima 是 Linux VM，不能只看 macOS 的 uname）。
# 只用于打印提示，取不到就退回收主机架构，绝不让脚本因为这一句失败。
HOST_ARCH="$(docker info --format '{{.Architecture}}' 2>/dev/null || uname -m)"
case "$TARGET_PLATFORM" in
  linux/amd64) WANT_ARCH="x86_64" ;;
  linux/arm64) WANT_ARCH="aarch64" ;;
  *) WANT_ARCH="$TARGET_PLATFORM" ;;
esac
# 不同 docker 版本 / 发行版对同一架构的写法不一样（x86_64 / amd64、aarch64 / arm64），
# 先归一化再比较，否则明明同架构也会误报「交叉构建」警告。
case "$HOST_ARCH" in
  x86_64|amd64)   HOST_ARCH_NORM="x86_64" ;;
  aarch64|arm64)  HOST_ARCH_NORM="aarch64" ;;
  *)              HOST_ARCH_NORM="$HOST_ARCH" ;;
esac

echo "=== 开始构建离线安装包 ==="
echo "   仓库根　：$ROOT"
echo "   产物目录：$BUNDLE_DIR"
echo "   镜像标签：$TAG / $LATEST"
echo "   目标架构：$TARGET_PLATFORM（构建机：$HOST_ARCH）"
echo ""

# 交叉构建提醒：目标架构与构建机不一致时要靠 QEMU 指令模拟执行 RUN 指令。
# 功能上可行（Docker Desktop 自带 binfmt_misc/QEMU），但 npm ci、apt-get、前端构建
# 都会慢数倍，且原生依赖偶尔会在模拟环境下安装失败。这里如实警告而不是假装没问题：
# 要交付给客户的生产镜像，优先在【同架构的 x86_64 Linux 构建机】上打包。
if [ "$HOST_ARCH_NORM" != "$WANT_ARCH" ]; then
  echo "⚠️  正在交叉构建：$HOST_ARCH 的机器打 $TARGET_PLATFORM 镜像。"
  echo "    将走 QEMU 模拟，首次构建可能要 15–30 分钟；若 npm ci / 原生模块报错，"
  echo "    请换一台 x86_64 Linux 构建机重跑本脚本（不要靠改客户机配置绕过）。"
  echo ""
fi

mkdir -p "$BUNDLE_DIR"

# ---------- 1) 预下载 embedding 模型 ----------
# 必须在有网的构建机上跑；失败时 set -e 终止，不会留下不完整的包。
echo "[1/5] 预下载 embedding 模型到 model-cache/ …"
node scripts/prefetch-model.mjs
echo ""

# ---------- 2) 构建离线镜像 ----------
# -f 指向根目录的 Dockerfile.offline，构建上下文是仓库根（.），
# 这样 web/、server/、model-cache/ 三处都能被 COPY 到。
# --platform 决定镜像架构（必须匹配客户机 CPU，见上方变量区的说明）；
# node:22-bookworm-slim 是多架构 manifest，会自动解析到对应架构的基础镜像。
echo "[2/5] 构建离线镜像（Dockerfile.offline，目标架构 ${TARGET_PLATFORM}）…"
docker build --platform "$TARGET_PLATFORM" -f Dockerfile.offline -t "$TAG" -t "$LATEST" .
echo ""

# ---------- 3) 导出镜像并 gzip ----------
# pipefail 保证 docker save 失败时整条管道非 0、脚本退出，
# 不会把半截文件当成成功产物留到下一步算校验和。
echo "[3/5] 导出镜像并压缩为 ${IMAGE_FILE} …"
docker save "$TAG" "$LATEST" | gzip -c > "${BUNDLE_DIR}/${IMAGE_FILE}"
echo ""

# ---------- 4) 复制交付配置、协议与文档 ----------
# 只带模板不带真实 .env：密钥必须由客户机现场生成，绝不随包分发。
# 同日重跑时先清掉旧的两个文档子目录，避免上一轮残留文件混进 SHA256SUMS。
echo "[4/5] 复制交付配置、协议与文档 …"
rm -rf "$BUNDLE_DIR/docs" "$BUNDLE_DIR/templates"
mkdir -p "$BUNDLE_DIR/docs/legal" "$BUNDLE_DIR/templates"
cp "$ROOT/deploy/docker-compose.yml"      "$BUNDLE_DIR/docker-compose.yml"
cp "$ROOT/deploy/.env.example"            "$BUNDLE_DIR/.env.example"
cp "$ROOT/deploy/branding.example.json"   "$BUNDLE_DIR/templates/branding.example.json"
cp "$ROOT/deploy/license.example.json"    "$BUNDLE_DIR/templates/license.example.json"
cp "$ROOT/deploy/mcp.example.json"        "$BUNDLE_DIR/templates/mcp.example.json"
cp "$ROOT/LICENSE"                        "$BUNDLE_DIR/LICENSE"
cp "$ROOT/CHANGELOG.md"                   "$BUNDLE_DIR/CHANGELOG.md"
cp "$ROOT/docs/操作手册.md"                "$BUNDLE_DIR/docs/操作手册.md"
cp "$ROOT/docs/legal/"*.md                "$BUNDLE_DIR/docs/legal/"
echo ""

# ---------- 5) 写构建信息 + 生成 SHA256SUMS ----------
# BUILD-INFO.txt 记录镜像架构与构建机架构：客户现场一旦报 exec format error，
# 第一件事就是核对「这包是给哪种 CPU 打的」，把答案直接放进包里能省掉一轮来回。
# 校验和在产物目录内用相对文件名计算，客户机可直接 shasum -a 256 -c SHA256SUMS；
# 校验和文件本身不参与计算，避免自引用。macOS 自带 shasum，Linux 上退回 sha256sum。
echo "[5/5] 写构建信息并生成 SHA256SUMS …"
cat > "$BUNDLE_DIR/BUILD-INFO.txt" <<EOF
AI-Server 离线镜像构建信息
--------------------------
镜像架构    : ${TARGET_PLATFORM}
构建机架构  : ${HOST_ARCH}
构建时间    : $(date '+%Y-%m-%d %H:%M:%S %z')
镜像标签    : ${TAG} / ${LATEST}

客户机自检  : uname -m
  x86_64        -> 本包可用（linux/amd64）
  aarch64/arm64 -> 本包不可用，请索取 TARGET_PLATFORM=linux/arm64 重新打的包
不匹配症状  : 容器反复重启，日志报 "exec format error"
导入后复核  : docker image inspect ${LATEST} --format '{{.Architecture}}'
EOF
(
  cd "$BUNDLE_DIR"
  # 单个文件的哈希工具：macOS 自带 shasum，Linux 用 sha256sum，输出格式一致
  hash_one() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"
    else sha256sum "$1"; fi
  }
  # 动态枚举而不是手列文件名：以后往包里加一份协议/手册，不会漏掉校验和。
  # 排除 SHA256SUMS 自身避免自引用；排序保证同一批产物在任何构建机上顺序一致。
  # 文件名含中文（操作手册、协议），所以整条链路按行传递、不用 xargs 拆词。
  find . -type f ! -name 'SHA256SUMS' -print \
    | sed 's|^\./||' \
    | LC_ALL=C sort \
    | while IFS= read -r f; do hash_one "$f"; done > SHA256SUMS
)
echo ""

# 只有前面全部成功才会走到这里（set -e 保证），所以这里可以如实打印「完成」。
echo "✅ 离线安装包已生成：$BUNDLE_DIR"
echo ""
echo "   文件清单："
ls -lah "$BUNDLE_DIR"
echo ""
echo "   客户机部署步骤（同样需要已安装 docker 且 daemon 已启动）："
echo "     0) 核对架构　：uname -m；本包为 ${TARGET_PLATFORM}，字段详见 BUILD-INFO.txt"
echo "     1) 校验完整性：cd $(basename "$BUNDLE_DIR") && sha256sum -c SHA256SUMS"
echo "     2) 导入镜像　：docker load -i image.tar.gz"
echo "     3) 生成配置　：参考包内 .env.example 在同目录生成 .env，填入真实密钥"
echo "     4) 启动服务　：docker compose -f docker-compose.yml --env-file .env up -d"
echo "        （镜像已导入，切勿加 --build：离线包内没有源码，重新构建必然失败）"
echo "     5) 浏览器访问：http://<服务器IP>:3000"
echo "     6) 可选换品牌：把 templates/branding.example.json 改成 branding.json 放进数据卷，重启即生效"
echo ""
echo "   随包文档：docs/操作手册.md（照抄执行）、docs/legal/（协议草案，需法务审核）、"
echo "             CHANGELOG.md（本版本已知限制）、LICENSE（商业权属声明）"
echo ""
echo "   ⚠️ 提醒 1：离线包内不含 .env / branding.json / license.json，也不含任何真实密钥；"
echo "             这些必须由客户机现场生成并妥善保管。"
echo "   ⚠️ 提醒 2：镜像架构在构建时固化，客户机 CPU 不匹配只能重新打包，改 compose 无效。"
echo "   ⚠️ 提醒 3：docs/legal/ 均为模板草案，正式签署前必须由法务结合实际情况审核修订。"
