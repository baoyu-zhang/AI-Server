/**
 * ecosystem.config.cjs —— pm2 进程守护配置
 *
 * ===== 为什么需要 pm2 =====
 * `nohup node index.js &` 三个问题：终端关了日志没地方看、进程崩了没人拉起、
 * 改代码要手动 kill + 重启。pm2 一次解决：崩溃自动重启、日志集中管理、
 * `pm2 reload` 零停机重启（对我们这个单进程服务就是快速重启）。
 *
 * 常用命令（在 server/ 目录下）：
 *   pm2 start ecosystem.config.cjs      首次启动
 *   pm2 restart ai-server               改代码后重启
 *   pm2 logs ai-server                  看实时日志（也可用 npm run logs 看落盘日志）
 *   pm2 status                          看存活状态
 *   pm2 startup && pm2 save             开机自启（服务器上执行一次）
 */
module.exports = {
  apps: [
    {
      name: 'ai-server',
      script: 'index.js',
      cwd: __dirname,
      // .env 里的变量由 dotenv 在应用内加载，这里只放"进程级"配置，避免两处维护
      // fork 而不是 cluster：cluster 模式下 pm2 会用 IPC 包装入口进程，
      // 本应用启动时要同步加载 SQLite 句柄与本地向量索引，cluster 包装会让启动卡住
      // （表现为 pm2 status 显示 online 但端口一直没监听）。SQLite 单文件本来也不适合多进程。
      exec_mode: 'fork',
      instances: 1, // SQLite + 内存限流/会话归属都是单机状态，多实例会打架——单实例是当前架构的硬约束
      autorestart: true,
      max_restarts: 20, // 短时间反复崩溃就别无限拉起了，多半是配置错误
      min_uptime: '30s', // 起来 30 秒才算"稳定"，防止启动即崩被算作正常运行
      restart_delay: 3000, // 崩溃后等 3 秒再拉：给磁盘 IO / 模型加载留口气
      max_memory_restart: '1G', // 内存超过 1G 自动重启：embedding 模型偶发泄漏的兜底
      env: {
        NODE_ENV: 'production'
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      merge_logs: true,
      time: true // 日志带时间戳
    }
  ]
}
