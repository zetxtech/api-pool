# API 池管理系统

## 项目介绍

API 池管理系统是一个专为管理 OpenAI 格式 API 密钥设计的应用程序。该系统支持多个 API 密钥的轮询调用，自动处理速率限制和错误，并提供简洁的管理界面和实时监控仪表盘。系统实现了 API 代理功能，可以转发 OpenAI 格式的 API 请求，适用于多人共享 API 密钥或提高 API 请求可靠性的场景。

## 主要功能

### 1. API 转发与兼容性

- 完整支持 OpenAI API 格式的请求转发
- 支持多种 API 端点：聊天(chat)、嵌入(embeddings)、图像生成(images)、模型列表(models)和硅基额度查询(userInfo)等等
- 自动维护请求头和授权信息

### 2. 令牌管理

- 在 KV 存储中保存和管理 API 密钥
- 支持批量添加、删除、启用、禁用 API 密钥
- 识别多行/换行和逗号区分的多令牌格式
- 自动检测令牌余额和状态

### 3. 智能负载均衡

- 智能轮询选择算法，根据令牌的历史成功率和使用量决定优先级
- 自动处理 API 请求失败和重试机制
- 对连续失败超过阈值的令牌自动禁用，并定期尝试恢复

### 4. 高级流式处理

- 完整支持 OpenAI 的流式响应（SSE）处理
- 实现自适应延迟算法，根据内容大小和生成速度动态调整响应速率
- 支持多种响应处理模式：字符逐个发送或批量发送
- 智能处理 JSON 格式和流式内容
- 保留原始 SSE 事件格式，确保与原生 API 完全兼容

### 5. 实时统计与监控

- 内置智能令牌计数算法，准确估算不同类型内容的 token 使用量
- 提供简约的仪表盘，实时监控请求速率(RPM, RPD)和令牌使用量(TPM, TPD)
- 追踪每个密钥的使用情况、成功率和错误次数
- 支持统计数据的定期保存和加载

### 6. 安全特性

- 管理界面密码保护
- JWT 令牌认证
- 密钥混淆显示，保护 API 密钥安全

## 技术架构

- 使用 Cloudflare Workers 运行
- 利用 KV 存储保存令牌和统计数据
- 无需数据库，全内存运行提高性能
- 定期任务自动清理过期数据和恢复令牌

## 部署教程

### 方式一：手动部署

1. 创建 Cloudflare 账号（如果没有）
2. 复制 apipool.js 到 worker 中粘贴
3. 创建 KV 命名空间 ：API_TOKENS
4. worker 绑定 KV 即可

### 方式二：通过 Wrangler CLI 部署

1. 安装 Wrangler CLI

```bash
npm install -g wrangler
```

2. 登录到你的 Cloudflare 账号

```bash
wrangler login
```

3. 创建项目目录并初始化文件

```bash
mkdir api-pool-system
cd api-pool-system
```

4. 创建必要的文件：

   - `apipool.js`：复制主程序代码
   - `wrangler.toml`：创建配置文件

5. 创建 KV 命名空间并获取 ID

```bash
wrangler kv:namespace create "API_TOKENS"
```

6. 更新 `wrangler.toml` 文件，填入 KV 命名空间 ID：

```toml
name = "api-pool-system"
main = "apipool.js"
compatibility_date = "2024-01-01"

workers_dev = true

[[kv_namespaces]]
binding = "API_TOKENS"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"   # 替换为上面命令输出的 id
```

7. 部署到 Cloudflare Workers

```bash
wrangler deploy
```

部署成功后，您将获得一个`*.workers.dev`的 URL，例如`https://api-pool-system.username.workers.dev`。
注意修改以下内容：

1. 设置 API 基础 URL（替换为您的目标 API 地址）

   ```javascript
   const API_BASE_URL = "https://api.siliconflow.cn"; // 改为您需要代理的API地址
   ```

2. 设置管理员密码（务必修改默认密码）
   ```javascript
   const DEFAULT_ADMIN_PASSWORD = "xxx"; // 改为您的安全密码
   ```

### 使用方法

#### 访问管理界面

1. 打开浏览器，访问您的 Worker URL
2. 使用您设置的管理员密码登录
3. 登录后即可进入管理面板，添加和管理 API 密钥

#### 使用 API 代理

将您的应用程序中的 OpenAI API 地址修改为您的 Worker URL，并使用您设置的 API 密钥，例如：

**原始 OpenAI 调用：**

```javascript
const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  },
  body: JSON.stringify(payload),
});
```

**修改为：**

```javascript
const response = await fetch("https://your-worker-url.workers.dev/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer sk-yourCustomApiKey123456789`, // 使用您设置的API密钥
  },
  body: JSON.stringify(payload),
});
```

> **重要提示**：必须使用在代码中设置的 API 密钥进行身份验证，否则 API 请求将被拒绝。默认密钥为`sk-yourCustomApiKey123456789`，建议您修改为自己的安全密钥。修改位置在`apipool.js`文件顶部的常量定义区域。

## 使用提示

1. **令牌管理**：

   - 定期检查令牌余额和状态
   - 禁用频繁出错的令牌
   - 批量添加令牌时可以使用逗号或换行分隔

2. **监控统计**：

   - 关注 RPM（每分钟请求数）和 TPM（每分钟令牌使用量）指标
   - 使用刷新按钮获取最新统计数据

3. **自定义**：
   - 可以修改代码中的`MAX_CONSECUTIVE_ERRORS`调整自动禁用的连续错误阈值
   - 调整`KV_SAVE_INTERVAL`和`MAX_PENDING_UPDATES`优化 KV 存储写入频率
   - 修改`API_KEY`常量来自定义 API 鉴权密钥

## 故障排除

1. **令牌不可用**：检查是否所有令牌都被禁用或余额不足
2. **请求失败**：查看管理面板中的错误统计，识别问题令牌
3. **响应缓慢**：可能是目标 API 服务器响应慢，或者令牌超出速率限制

## 高级配置

### 自定义 API 端点

如需添加更多 API 端点，修改`API_ENDPOINTS`常量：

```javascript
const API_ENDPOINTS = {
  chat: "/v1/chat/completions",
  embeddings: "/v1/embeddings",
  images: "/v1/images/generations",
  models: "/v1/models",
  userInfo: "/v1/user/info",
  // 添加更多端点
  audio: "/v1/audio/transcriptions",
};
```

### 调整日志级别

可通过管理页面的 API 或直接修改代码设置日志级别：

```javascript
let logLevel = "info"; // 可选值: debug, info, warn, error
```

## 安全建议

1. 务必修改默认管理员密码
2. 务必修改默认的 API 鉴权密钥（`sk-yourCustomApiKey123456789`）为更复杂的密钥
3. 考虑为 Worker 设置自定义域名，并启用 HTTPS
4. 定期审查访问日志，监控异常请求
5. 对重要的 API 密钥设置使用限制

## 许可和贡献

本项目开源使用，欢迎提交问题和改进建议。

---

如有任何问题或需要帮助，请提交 issue 或联系管理员。
