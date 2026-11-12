import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  build: {
    // 构建产物目录「只覆盖、不删除」。vite 默认会先递归清空 dist，这一步在没有
    // 删除权限的环境里会直接报错中断构建（CI 沙箱、受限容器、部分托管 IDE 都会遇到）。
    // 代价是旧哈希文件（index-abc123.js）会留在目录里——无害：index.html 只引用
    // 新文件名，旧文件没人访问；需要瘦身时手动清一次 dist 即可。
    emptyOutDir: false
  },
  server: {
    // 固定 8082 并 strictPort：不加 strictPort 时端口被占 vite 会静默 +1，
    // 于是同一份代码跑出 8081/8082 两个实例，localStorage 按端口隔离，
    // 登录态和本地快照互不相通——排查时会误判成"改了没生效"
    port: 8082,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        secure: false
      },
      // AG-UI 事件流：SSE 不能被代理缓冲，故关闭超时
      '/agui': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        secure: false,
        timeout: 0,
        proxyTimeout: 0
      }
    },
  },
})
