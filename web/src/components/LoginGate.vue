<template>
  <!-- 登录门：未登录时整屏只显示这一张卡片，登录成功后 App.vue 才挂载主界面 -->
  <div class="login-gate">
    <div class="login-gate__card">
      <h1 class="login-gate__title">知识库助手</h1>
      <p class="login-gate__subtitle">{{ isRegister ? '创建账号后即可使用' : '登录后进入你的私有知识库' }}</p>

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
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import type { FormProps } from 'tdesign-vue-next'
import { UserIcon, LockOnIcon } from 'tdesign-icons-vue-next'
import { login, register } from '../api/auth'

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
</style>
