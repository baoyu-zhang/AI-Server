import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 8080,
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
