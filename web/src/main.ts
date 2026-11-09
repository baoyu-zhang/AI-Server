import { createApp } from 'vue'
import App from './App.vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import TDesign from 'tdesign-vue-next'
import TDesignChat from '@tdesign-vue-next/chat'
import 'tdesign-vue-next/dist/tdesign.css'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

createApp(App)
  .use(pinia)
  .use(TDesign)
  .use(TDesignChat)
  .mount('#app')
