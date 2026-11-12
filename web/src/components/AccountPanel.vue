<!--
  AccountPanel.vue —— 「账号」页签（P2 产品化的用户自主权三件套）
  为什么单独成页：改密码、导出数据、退出登录都属于「我的账号」而非业务功能，
  放在右上角那个拥挤的账号角标里塞不下，也不好做二次确认，于是收进侧栏一个页签。

  三块能力：
  1) 修改密码：服务端改密后会作废旧 token，所以成功后要提示「其它设备已退出登录」；
  2) 导出我的数据：接口要 Authorization 头，浏览器直接 location.href 带不上 Bearer token，
     必须先 fetch 拿 Blob 再用 <a download> 触发保存；
  3) 退出登录：不在这里自己清 localStorage 就完事——App.vue 还持有 authed 与引擎里的消息，
     必须 emit('logout') 冒泡到 App.vue 复用它完整的 onLogout（清引擎消息，防止串号）。

  请求同样只用 authHeaders() + 原生 fetch，风格与 KeyPanel/DocPanel 一致，不引入新依赖。
-->
<script setup lang="ts">
import { ref } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { authHeaders, clearAuth } from '../api/auth'

// 退出登录是「整个应用的状态变更」，本组件无权直接改 App.vue 的 authed，
// 因此只发事件，由 SidePanel 原样转发给 App.vue 处理
const emit = defineEmits<{ logout: [] }>()

// 统一请求封装（与其它面板同一套约定）：带鉴权头、401 清登录态、非 2xx 抛后端 error 文案
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), ...(options?.headers as Record<string, string> | undefined) }
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) {
    clearAuth()
    throw new Error('登录已失效，请刷新页面重新登录')
  }
  if (!res.ok) throw new Error((data as { error?: string }).error || `请求失败（${res.status}）`)
  return data as T
}

// ===== 修改密码表单 =====
const oldPassword = ref('') // 当前密码
const newPassword = ref('') // 新密码
const confirmPassword = ref('') // 再输一次新密码，防手滑
const saving = ref(false) // 提交中：按钮转圈 + 防连点

/**
 * 提交改密。校验放在前端先行拦一道（省一次注定 400 的往返）：
 * 新密码至少 8 位、两次输入必须一致。服务端仍会再校验一遍，前端不能替代它。
 */
async function changePassword() {
  if (saving.value) return
  if (!oldPassword.value) {
    MessagePlugin.warning('请输入旧密码')
    return
  }
  if (newPassword.value.length < 8) {
    MessagePlugin.warning('新密码至少 8 位')
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    MessagePlugin.warning('两次输入的新密码不一致')
    return
  }
  saving.value = true
  try {
    await request<{ ok: boolean }>('/api/account/password', {
      method: 'POST',
      // 显式声明 JSON：request 会把它与 authHeaders() 合并，两个头都不会丢
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: oldPassword.value, newPassword: newPassword.value })
    })
    // 清空三个输入框：改完不留明文在界面上，也避免误以为没提交成功又点一次
    oldPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    // 后端改密会作废旧会话，其它登录设备会掉线，这里如实告知
    MessagePlugin.success('密码已修改，其它设备已退出登录')
  } catch (e: any) {
    MessagePlugin.error(e?.message || '修改密码失败')
  } finally {
    saving.value = false
  }
}

// ===== 导出数据 =====
const exporting = ref(false) // 导出中，防连点重复生成大文件

/**
 * 导出「我的数据」为 JSON 文件。
 * 关键点：不能用 location.href / window.open，因为导出接口挂在 /api 下要 Authorization 头，
 * 直接导航不会被带上 Bearer token，必被 401 拦截。只能用 fetch 拿到响应，再本地拼下载。
 */
async function exportData() {
  if (exporting.value) return
  exporting.value = true
  try {
    const res = await fetch('/api/account/export', { headers: authHeaders() })
    if (res.status === 401) {
      clearAuth()
      throw new Error('登录已失效，请刷新页面重新登录')
    }
    if (!res.ok) {
      // 失败时响应是 { error } 而不是文件，读出来给用户看具体原因
      const body = await res.json().catch(() => ({}))
      throw new Error((body as { error?: string }).error || `导出失败（${res.status}）`)
    }
    // 文件名优先用服务端 Content-Disposition: attachment; filename="..."
    // 同时兼容 RFC 5987 的 filename*=UTF-8''xxx 形式；取不到就给个带日期的兜底名
    const disposition = res.headers.get('Content-Disposition') || ''
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
    const fallback = `我的数据-${new Date().toISOString().slice(0, 10)}.json`
    let fileName = fallback
    if (match) {
      try {
        fileName = decodeURIComponent(match[1])
      } catch {
        fileName = match[1] // 不是合法的百分号编码时原样使用，不让解码异常毁掉整次导出
      }
    }
    // 把响应体读成 Blob → 生成临时 object URL → 交给一个临时 <a download> 点击下载
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 延后释放：部分浏览器在 click() 后同步 revoke 会取消下载，放下一个事件循环最稳
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    MessagePlugin.success('数据已导出')
  } catch (e: any) {
    MessagePlugin.error(e?.message || '导出数据失败')
  } finally {
    exporting.value = false
  }
}

/** 账号页没有需要拉取的列表；保留空 load() 只为与 SidePanel 其它页签的刷新接口保持一致 */
function load() {
  /* 无需加载：本页只有表单与按钮，切页时没有过期数据要刷新 */
}

defineExpose({ load })
</script>

<template>
  <div class="account-panel">
    <!-- 块一：修改密码。三行输入 + 提交按钮，回车也能提交（最后一个框绑了 enter） -->
    <t-card title="修改密码" :bordered="true" class="account-panel__card">
      <div class="account-panel__field">
        <span class="account-panel__label">旧密码</span>
        <t-input v-model="oldPassword" type="password" clearable placeholder="请输入当前密码" />
      </div>
      <div class="account-panel__field">
        <span class="account-panel__label">新密码</span>
        <t-input v-model="newPassword" type="password" clearable placeholder="至少 8 位" />
      </div>
      <div class="account-panel__field">
        <span class="account-panel__label">确认新密码</span>
        <t-input v-model="confirmPassword" type="password" clearable placeholder="再输入一次新密码" @enter="changePassword" />
      </div>
      <t-button theme="primary" block :loading="saving" @click="changePassword">确认修改</t-button>
      <p class="account-panel__hint">修改成功后，其它已登录的设备会退出登录，需要重新输入新密码。</p>
    </t-card>

    <!-- 块二：导出数据。说明导出内容，避免用户以为是「导出聊天记录文件」 -->
    <t-card title="导出我的数据" :bordered="true" class="account-panel__card">
      <p class="account-panel__desc">把账号资料、会话、记忆、用量等属于你的数据打包成一个 JSON 文件下载到本地。</p>
      <t-button variant="outline" block :loading="exporting" @click="exportData">导出 JSON 文件</t-button>
    </t-card>

    <!-- 块三：退出登录。危险操作用 outline 弱化，但主题色标红以示区别 -->
    <t-card title="退出登录" :bordered="true" class="account-panel__card">
      <p class="account-panel__desc">退出后需要重新登录才能继续使用。</p>
      <t-button theme="danger" variant="outline" block @click="emit('logout')">退出登录</t-button>
    </t-card>
  </div>
</template>

<style scoped>
.account-panel {
  height: 100%;
  overflow-y: auto;
  padding: 16px 12px;
  box-sizing: border-box;
  background: var(--td-bg-color-container);
}
.account-panel__card {
  margin-bottom: var(--td-comp-margin-m);
}
.account-panel__field {
  margin-bottom: var(--td-comp-margin-s);
}
.account-panel__label {
  display: block;
  margin-bottom: 4px;
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-secondary);
}
.account-panel__hint {
  margin: var(--td-comp-margin-s) 0 0;
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
  line-height: 1.5;
}
.account-panel__desc {
  margin: 0 0 var(--td-comp-margin-m);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-secondary);
  line-height: 1.6;
}
</style>
