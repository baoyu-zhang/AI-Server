import { createApp } from 'vue'
import App from './App.vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import TDesign from 'tdesign-vue-next'
import TDesignChat from '@tdesign-vue-next/chat'
import 'tdesign-vue-next/dist/tdesign.css'
import { loadBranding } from './config/branding'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

// 先拉品牌配置再挂载：登录页是用户看到的第一屏，若先 mount 再异步改文案，
// 客户会看到「默认品牌闪一下再变成自己的名字」，交付演示时很扎眼。
// loadBranding() 内部保证永不抛错、2 秒超时后降级为内置默认值，
// 所以 .finally() 里的 mount 一定会被执行 —— 品牌接口挂了也不影响使用。
loadBranding().finally(() => {
  createApp(App)
    .use(pinia)
    .use(TDesign)
    .use(TDesignChat)
    .mount('#app')
})
