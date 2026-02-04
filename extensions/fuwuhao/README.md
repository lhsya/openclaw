# Simple WeCom Demo

这是一个简化的企业微信 Webhook 接收消息的 Demo，只保留了核心的消息接收功能。

## 文件结构

```
demo/
├── simple-plugin.ts      # 插件入口文件
├── simple-webhook.ts     # 简化的 Webhook 处理器
├── simple-runtime.ts     # 简化的运行时管理
└── README.md            # 说明文档
```

## 功能特点

- ✅ 接收企业微信 Webhook 消息
- ✅ 基本的签名验证（模拟实现）
- ✅ 消息解密（模拟实现）
- ✅ 消息处理和日志记录
- ❌ 移除了复杂的状态管理
- ❌ 移除了消息防抖和去重
- ❌ 移除了流式处理
- ❌ 移除了媒体文件处理

## 使用方法

1. **配置账号信息**
   
   在 `simple-webhook.ts` 中修改 `mockAccount` 对象：
   ```typescript
   const mockAccount: SimpleAccount = {
     token: "your_token_here",              // 企业微信应用的 Token
     encodingAESKey: "your_encoding_aes_key_here", // 企业微信应用的 EncodingAESKey
     receiveId: "your_receive_id_here"      // 企业微信应用的 ReceiveId
   };
   ```

2. **实现真实的加密解密**
   
   当前的 `verifySignature` 和 `decryptMessage` 函数是模拟实现，实际使用时需要：
   - 实现真实的企业微信签名验证算法
   - 实现真实的 AES 解密算法
   
3. **添加业务逻辑**
   
   在 `handleMessage` 函数中添加您的业务处理逻辑：
   ```typescript
   const handleMessage = (message: SimpleWecomMessage): void => {
     // 在这里添加您的业务逻辑
     // 例如：调用 AI 模型、存储消息、转发消息等
   };
   ```

## 消息处理流程

1. **URL 验证** (GET 请求)
   - 验证签名
   - 解密 echostr 参数
   - 返回解密结果

2. **消息接收** (POST 请求)
   - 验证签名
   - 解密消息内容
   - 调用 `handleMessage` 处理消息
   - 返回成功响应

## 注意事项

⚠️ **这是一个简化的 Demo 版本，不适合直接用于生产环境**

- 签名验证和消息解密使用的是模拟实现
- 缺少错误处理和重试机制
- 没有消息去重和防抖功能
- 没有完整的配置管理

如需生产使用，请参考完整版本的实现。