
# 中转服务器 (Relay Server) 实现指南

这个文件包含了使用 Node.js、Express 和 `ws` 库实现中转服务器的完整代码。

## 核心功能

- **通用 HTTP 代理**: 暴露 `/v1beta/*` 通配符端点。它捕获任何 Gemini API 请求（包括模型名称、生成配置、系统指令等）并按原样转发。
- **WebSocket 服务器**: 在 `/ws` 路径上启动一个 WebSocket 服务器，等待安全的 Applet 客户端连接。
- **透明转发**: 将 HTTP 请求的 **路径 (Path)** 和 **请求体 (Body)** 打包并通过 WebSocket 发送给 Applet。
- **响应匹配**: 使用唯一的请求 ID 来匹配从 Applet 返回的响应，并将其作为 HTTP 响应发送回给原始请求者。

---

## ⚠️ 重要：在 HTTPS 环境下运行 (如 AI Studio)

如果你正在 AI Studio 或其他 HTTPS 环境中运行 Angular Applet，浏览器**禁止**连接到不安全的 WebSocket (`ws://localhost`).

**必须使用 `wss://` (安全 WebSocket) 进行连接。**

最简单的解决方法是使用 **ngrok** 将你的本地服务器暴露到公网：

1.  安装 ngrok: `npm install -g ngrok` (或从官网下载)
2.  启动本地 Relay Server: `npm start` (默认端口 3000)
3.  启动 ngrok 隧道: `ngrok http 3000`
4.  复制 ngrok 提供的 HTTPS URL (例如 `https://abc-123.ngrok-free.app`).
5.  在 Angular Applet 中，将 WebSocket URL 设置为: `wss://abc-123.ngrok-free.app/ws` (注意将 `https` 替换为 `wss`)

---

## 步骤 1: 项目设置

1.  创建一个新的文件夹，例如 `relay-server`。
2.  进入该文件夹并在其中创建 `package.json` 和 `index.js` 文件。

### `package.json`

将以下内容复制到 `package.json` 文件中。这定义了项目所需的依赖。

```json
{
  "name": "gemini-relay-server",
  "version": "2.1.0",
  "description": "A generic relay server to proxy any LLM request to a secure applet via WebSockets.",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "ws": "^8.17.0"
  }
}
```

### 步骤 2: 安装依赖

在 `relay-server` 文件夹中打开终端并运行以下命令：

```bash
npm install
```

---

## 步骤 3: 服务器代码

将以下代码复制到 `index.js` 文件中。

### `index.js`

```javascript
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import cors from 'cors';

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 120000; // 120秒超时 (图片/视频生成可能需要较长时间)

const app = express();
const server = http.createServer(app);

// =================================================================
// WebSocket 服务器设置 (用于连接Applet)
// =================================================================
const wss = new WebSocketServer({ server, path: '/ws' });

let appletSocket = null; // 简化处理：假设只有一个Applet连接
const pendingRequests = new Map(); // 存储待处理的HTTP请求

wss.on('connection', (ws) => {
  console.log('✅ 安全执行节点 (Applet) 已连接!');
  appletSocket = ws;

  ws.on('message', (message) => {
    try {
      const { id, success, payload, error } = JSON.parse(message);
      if (pendingRequests.has(id)) {
        const { res, timeoutId } = pendingRequests.get(id);
        clearTimeout(timeoutId); // 清除超时定时器
        
        if (success) {
          // 成功：直接返回 payload。
          // Payload 必须是标准的 Gemini API 响应结构 (包含 candidates, usageMetadata 等)
          // 不要在此处包裹 { text: ... }，否则会破坏官方 SDK 的解析。
          res.json(payload);
        } else {
          res.status(500).json({ error: { code: 500, message: error || 'Unknown error from execution node', status: 'INTERNAL_ERROR' } });
        }
        pendingRequests.delete(id);
      }
    } catch (e) {
      console.error('解析来自 Applet 的消息时出错:', e);
    }
  });

  ws.on('close', () => {
    console.log('❌ 安全执行节点 (Applet) 已断开.');
    appletSocket = null;
    // 当Applet断开时，拒绝所有待处理的请求
    for (const [id, { res, timeoutId }] of pendingRequests.entries()) {
      clearTimeout(timeoutId);
      res.status(503).json({ error: { code: 503, message: 'Execution node disconnected while processing request.', status: 'UNAVAILABLE' } });
      pendingRequests.delete(id);
    }
  });
  
  ws.on('error', (err) => {
    console.error('Applet WebSocket 错误:', err);
    ws.close();
  });
});

// =================================================================
// Express HTTP 服务器设置 (用于接收用户请求)
// =================================================================

app.use(cors()); // 允许跨域请求
app.use(express.json({ limit: '50mb' })); // 解析JSON请求体，增加限制以支持大图片/视频上传

// 健康检查端点
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'running',
    appletConnected: !!appletSocket,
    pendingRequests: pendingRequests.size
  });
});


// 核心代理端点：通配符匹配
// 匹配如 /v1beta/models/gemini-2.5-flash:generateContent
app.post('/v1beta/*', (req, res) => {
  if (!appletSocket) {
    return res.status(503).json({ error: { code: 503, message: 'Service Unavailable: Secure execution node is not connected.', status: 'UNAVAILABLE' } });
  }
  
  const id = crypto.randomUUID();
  
  // 捕获完整的路径 (例如 /models/gemini-2.5-flash:generateContent)
  const path = req.originalUrl; 
  
  const timeoutId = setTimeout(() => {
    if (pendingRequests.has(id)) {
      res.status(504).json({ error: { code: 504, message: 'Gateway Timeout: The request to the execution node timed out.', status: 'DEADLINE_EXCEEDED' } });
      pendingRequests.delete(id);
    }
  }, REQUEST_TIMEOUT);

  pendingRequests.set(id, { res, timeoutId });

  // 发送完整的请求上下文
  const message = JSON.stringify({ 
    id, 
    path, 
    body: req.body 
  });
  
  appletSocket.send(message);
});

// =================================================================
// 启动服务器
// =================================================================

server.listen(PORT, () => {
  console.log(`🚀 通用中转服务器正在运行于 http://localhost:${PORT}`);
  console.log(`🔌 等待 Applet 连接到 ws://localhost:${PORT}/ws`);
  console.log(`📡 准备代理请求到 /v1beta/*`);
});
```