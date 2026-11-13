<template>
  <!--
    登录门：未登录时整屏只显示这一张卡片，登录成功后 App.vue 才挂载主界面。

    第二阶段「品牌与皮肤」：标题、副标题、Logo、协议链接、页脚、授权信息全部来自
    branding 单例（启动时由 main.ts 从 /api/branding 拉取）。这里不再写死任何产品名，
    同一份前端产物发给不同客户，只改数据卷里的 branding.json 即可。
    这个页面是「未登录可见」的，所以只使用公开接口里的字段，不涉及任何用户数据。
  -->
  <div class="login-gate">
    <div class="login-gate__card">
      <!-- 客户 Logo：没配就不占位，避免卡片顶部出现一块空白或裂图 -->
      <img v-if="branding.logoUrl" :src="branding.logoUrl" alt="" class="login-gate__logo" />
      <h1 class="login-gate__title">{{ branding.loginTitle || branding.productName }}</h1>
      <p class="login-gate__subtitle">{{ isRegister ? branding.registerSubtitle : branding.loginSubtitle }}</p>

      <t-form :data="formData" :rules="rules" label-width="0" @submit="onSubmit">
        <t-form-item name="username">
          <t-input v-model="formData.username" clearable placeholder="用户名（字母/数字/_/-，3~32 位）">
            <template #prefix-icon><UserIcon /></template>
          </t-input>
        </t-form-item>
        <t-form-item name="password">
          <t-input v-model="formData.password" type="password" clearable placeholder="密码（至少 6 位）">
            <template #prefix-icon><LockOnIcon /></template>
          </t-input>
        </t-form-item>
        <t-form-item>
          <!-- 首个使用流程：没有账号就注册，注册成功即登录，不设"先注册再回来登录"的弯路 -->
          <t-button theme="primary" type="submit" block :loading="submitting">
            {{ isRegister ? '注册并进入' : '登录' }}
          </t-button>
        </t-form-item>
      </t-form>

      <div class="login-gate__switch">
        <t-button variant="text" size="small" @click="toggleMode">
          {{ isRegister ? '已有账号？去登录' : '没有账号？注册一个' }}
        </t-button>
      </div>

      <!-- 协议 / 帮助 / 版权：全部可选，没配就整块不渲染。
           协议模板见随包 docs/legal/，客户把自己的 URL 填进 branding.json 即可。
           rel="noopener noreferrer" 是外链基本卫生，防止新页面反向操作本页。 -->
      <div v-if="hasMeta" class="login-gate__meta">
        <div v-if="hasLinks" class="login-gate__links">
          <a v-if="branding.termsUrl" :href="branding.termsUrl" target="_blank" rel="noopener noreferrer">用户协议</a>
          <a v-if="branding.privacyUrl" :href="branding.privacyUrl" target="_blank" rel="noopener noreferrer">隐私政策</a>
          <a v-if="branding.supportUrl" :href="branding.supportUrl" target="_blank" rel="noopener noreferrer">需要帮助</a>
        </div>
        <!-- 授权信息只在客户装了许可文件时显示：没装 = 试用/内部部署，
             在登录页挂一行「未授权」反而会让正式客户误以为交付不完整。 -->
        <div v-if="branding.license.installed" class="login-gate__license" :class="{ 'is-warn': licenseWarn }">
          {{ licenseNotice }}
        </div>
        <div v-if="branding.footer || branding.companyName" class="login-gate__footer">
          {{ branding.footer || branding.companyName }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import type { FormProps } from 'tdesign-vue-next'
import { UserIcon, LockOnIcon } from 'tdesign-icons-vue-next'
import { login, register } from '../api/auth'
import { branding } from '../config/branding'

const emit = defineEmits<{ (e: 'authenticated'): void }>()

const isRegister = ref(false)
const submitting = ref(false)
const formData = reactive({ username: '', password: '' })

// 与服务端 auth.js 的校验规则保持一致：不一致的话，前端放行的请求会被后端 400 打回
const rules: FormProps['rules'] = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { pattern: /^[a-zA-Z0-9_-]{3,32}$/, message: '字母/数字/_/-，长度 3~32', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' }
  ]
}

/** 只要有任何一项页脚信息就渲染整个区块；全空时保持原来那张干净的登录卡片 */
const hasLinks = computed(() => Boolean(branding.termsUrl || branding.privacyUrl || branding.supportUrl))
const hasMeta = computed(() => hasLinks.value || branding.license.installed || Boolean(branding.footer || branding.companyName))

/** 需要提醒的许可状态：正常有效不打扰用户，只显示一行淡淡的授权信息 */
const licenseWarn = computed(() =>
  ['expiring', 'expired', 'over_seats', 'invalid', 'unsigned', 'none'].includes(branding.license.status)
)
const licenseNotice = computed(() => {
  const l = branding.license
  const base = l.customer ? `已授权：${l.customer}` : '已安装许可'
  const expiry = l.expiresAt ? ` · 有效期至 ${l.expiresAt}` : ''
  return licenseWarn.value && l.message ? `${base}${expiry} · ${l.message}` : `${base}${expiry}`
})

function toggleMode() {
  isRegister.value = !isRegister.value
}

async function onSubmit({ validateResult }: { validateResult: unknown }) {
  if ((validateResult as { result?: boolean })?.result === false) return
  submitting.value = true
  try {
    if (isRegister.value) await register(formData.username, formData.password)
    else await login(formData.username, formData.password)
    emit('authenticated')
  } catch (err) {
    // 到期停用（LICENSE_ENFORCE=1）时服务端返回 403 + 中文说明，这里原样展示，
    // 让用户知道该找谁续期，而不是看到一句笼统的「登录失败」。
    MessagePlugin.error((err as Error).message)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.login-gate {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--td-bg-color-page, #f3f3f3);
}

.login-gate__card {
  width: 360px;
  padding: 40px 36px 24px;
  background: var(--td-bg-color-container, #fff);
  border-radius: var(--td-radius-large, 12px);
  box-shadow: var(--td-shadow-2, 0 4px 16px rgba(0, 0, 0, 0.08));
}

/* 客户 Logo 统一限高，避免一张大图把登录表单挤到屏幕外 */
.login-gate__logo {
  display: block;
  max-width: 160px;
  max-height: 48px;
  margin: 0 auto 12px;
  object-fit: contain;
}

.login-gate__title {
  margin: 0 0 4px;
  font-size: 22px;
  font-weight: 600;
  color: var(--td-text-color-primary);
  text-align: center;
}

.login-gate__subtitle {
  margin: 0 0 24px;
  font-size: 13px;
  color: var(--td-text-color-secondary);
  text-align: center;
}

.login-gate__switch {
  margin-top: 8px;
  text-align: center;
}

.login-gate__meta {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--td-border-level-1-color, #e7e7e7);
  text-align: center;
  font-size: 12px;
  line-height: 1.8;
  color: var(--td-text-color-placeholder, #999);
}

.login-gate__links {
  display: flex;
  gap: 14px;
  justify-content: center;
  flex-wrap: wrap;
}

.login-gate__links a {
  color: var(--td-text-color-secondary, #666);
  text-decoration: none;
}

.login-gate__links a:hover {
  color: var(--td-brand-color, #0052d9);
  text-decoration: underline;
}

.login-gate__license {
  margin-top: 6px;
}

/* 到期 / 超额 / 签名异常时用暖色提醒，但不用刺眼的错误红：登录仍可能可用（默认不阻断） */
.login-gate__license.is-warn {
  color: var(--td-warning-color, #ed7b2f);
}

.login-gate__footer {
  margin-top: 6px;
}
</style>
