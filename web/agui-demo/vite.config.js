import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 4312,
    proxy: {
      '/agui': {
        target: 'http://127.0.0.1:4311',
        changeOrigin: true,
        // SSE 长连接，别让代理超时或缓冲
        timeout: 0,
        proxyTimeout: 0,
        ws: false,
      },
    },
  },
})
