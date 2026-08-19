# OpenAI 注册助手集成说明

## 功能概述

在 mailbox 扩展面板中集成了 OpenAI 账号注册助手，实现浏览器自动化注册流程的手动辅助界面。

## 集成的文件

### 后端逻辑
- **src/operations/registration-flow.cjs**: Playwright 自动化流程，管理 OpenAI 注册表单的9个状态
- **src/operations/registration-manager.cjs**: 会话管理器，支持最多3个并发注册会话

### 前端集成
- **src/ui/integration.cjs**: 
  - 添加了 `RegistrationManager` 实例
  - 添加了消息处理器（registrationCreate/Submit/Cancel等）
  - 修复了参数名匹配问题（phoneNumber/otp）
  
- **src/ui/panel.cjs**:
  - 添加了注册助手面板UI（CSS + HTML渲染）
  - 添加了所有交互事件处理器（toggle/create/submit/cancel/cleanup）
  - 添加了 input 事件监听器同步 registrationEmail

## 使用流程

1. 点击面板顶部的"注册助手"按钮展开面板
2. 输入邮箱地址，点击"创建注册会话"
3. 系统自动打开 Playwright 浏览器并填写：
   - 邮箱（用户输入）
   - 密码（固定：Chatgpt189687）
   - 姓名（固定：jdd）
   - 年龄（固定：24）
4. 在会话卡片中：
   - 状态显示为"等待手机号输入"时，从接码平台复制号码并粘贴，点击"提交号码"
   - 状态显示为"等待验证码输入"时，从接码平台复制验证码并粘贴，点击"提交验证码"
   - 如果号码不可用，点击"换号"重新输入
5. 注册完成后，使用现有的"Codex 导入"功能完成账号导入

## 技术要点

- **并发控制**: 最多支持3个会话同时进行
- **状态同步**: 通过 EventEmitter 实时更新前端状态
- **错误处理**: 会话失败时显示错误信息，支持清除记录
- **手动操作**: 所有接码操作由用户手动完成，避免自动化滥用风险

## 参数配置

注册会话默认参数：
- password: "Chatgpt189687"
- name: "jdd"
- age: 24
- maxRetries: 用户可在创建时自定义（默认25）

## 下一步

构建扩展并在 VS Code 中测试：
```bash
npm run build
code --install-extension <生成的.vsix文件> --force
```

重新加载 VS Code 后，打开 mailbox 面板即可看到"注册助手"按钮。
