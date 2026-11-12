import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
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
