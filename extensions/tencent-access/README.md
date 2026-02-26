# @tencent/openclaw-fuwuhao

OpenClaw 微信服务号智能机器人插件 - 通过加密 Webhook 接收消息并回复。

## 安装

```bash
# 使用 OpenClaw CLI 安装（推荐）
openclaw plugin install @tencent/openclaw-fuwuhao

# 或者直接使用 npm
npm install @tencent/openclaw-fuwuhao
```

## 配置

在 OpenClaw 配置文件 (`~/.openclaw/openclaw.json`) 中添加：

```json
{
  "channels": {
    "fuwuhao": {
      "enabled": true,
      "accounts": [
        {
          "accountId": "your-account-id",
          "appId": "your-app-id",
          "appSecret": "your-app-secret",
          "token": "your-token",
          "encodingAESKey": "your-encoding-aes-key"
        }
      ]
    }
  }
}
```

### 配置说明

| 字段 | 说明 |
|------|------|
| `accountId` | 账号标识（自定义） |
| `appId` | 微信公众号 AppID |
| `appSecret` | 微信公众号 AppSecret |
| `token` | 服务器配置的 Token |
| `encodingAESKey` | 消息加解密密钥 |

## 微信公众平台配置

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入 **设置与开发** → **基本配置**
3. 配置服务器地址：
   - URL: `http://your-server:19001/fuwuhao`
   - Token: 与配置文件中的 `token` 一致
   - EncodingAESKey: 与配置文件中的 `encodingAESKey` 一致
   - 消息加解密方式: 安全模式

## 使用方法

配置完成后，启动 OpenClaw Gateway：

```bash
openclaw gateway run
```

当用户向公众号发送消息时，插件会自动接收并通过 AI 处理后回复。

## 功能特点

- ✅ 接收微信服务号 Webhook 消息
- ✅ 消息签名验证
- ✅ AES 消息加解密
- ✅ 文本消息处理
- ✅ 图片/语音/视频消息处理
- ✅ 自动回复 AI 响应

## 消息处理流程

```
用户发送消息 → 微信服务器 → Webhook → OpenClaw Gateway → AI 处理 → 回复用户
```

1. **URL 验证** (GET 请求)
   - 验证签名
   - 解密 echostr 参数
   - 返回解密结果

2. **消息接收** (POST 请求)
   - 验证签名
   - 解密消息内容
   - 调用 AI 处理
   - 加密并返回响应

## 测试

使用 curl 测试接口：

```bash
# URL 验证测试
curl "http://127.0.0.1:19001/fuwuhao?signature=xxx&timestamp=123&nonce=abc&echostr=hello"

# 消息发送测试
curl -X POST "http://127.0.0.1:19001/fuwuhao?msg_signature=xxx&timestamp=123&nonce=abc" \
  -H "Content-Type: text/xml" \
  -d '<xml><Encrypt>...</Encrypt></xml>'
```

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 本地开发（在 openclaw 项目中）
openclaw plugin link ./extensions/fuwuhao
```

## License

MIT

## 作者

Tencent
