# 🚀 Gemini 中转服务器 (Relay Server) 部署指南 (纯文字版)

这个文件包含了使用 Node.js、Express 和 `ws` 库实现中转服务器的完整代码。

## 核心功能

- **通用 HTTP 代理**: 暴露 `/v1beta/*` 通配符端点。它捕获任何 Gemini API 请求（包括模型名称、生成配置、系统指令等）并按原样转发。
- **WebSocket 服务器**: 在 `/ws` 路径上启动一个 WebSocket 服务器，等待安全的 Applet 客户端连接。
- **透明转发**: 将 HTTP 请求的 **路径 (Path)** 和 **请求体 (Body)** 打包并通过 WebSocket 发送给 Applet。
- **响应匹配**: 使用唯一的请求 ID 来匹配从 Applet 返回的响应，并将其作为 HTTP 响应发送回给原始请求者。

---

## 📋 准备工作

1. 你需要一台国内可以正常访问的 **Linux 服务器** (推荐 Ubuntu/Debian)。
2. 你需要 **Root 权限** (或者使用 `sudo`)。
3. 你的服务器可以**正常访问谷歌AI STUDIO服务**。
4. 确保服务器已安装 **Node.js** (建议 v18 或更高版本)。

---

## 第一步：创建项目目录

我们将把代码放在 `/root/gemini-relay` 目录下（你可以放在别处，但请记住路径）。

在终端中依次执行：

```bash
# 1. 创建文件夹
mkdir -p /root/gemini-relay

# 2. 进入文件夹
cd /root/gemini-relay

# 3. 初始化项目 (一路回车即可)
npm init -y

# 4. 安装必要的依赖库
npm install express ws cors
```

---

## 第二步：写入服务器代码

1. 创建文件：

   ```bash
   nano index.js
   ```
2. **完整复制**以下代码并粘贴进去：

```javascript
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import cors from 'cors';

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 240000; // 4分钟超时
const MAX_PAYLOAD = 512 * 1024 * 1024;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD });

const appletPool = new Set();
const pendingRequests = new Map();

// --- 广播集群状态 ---
function broadcastClusterStatus() {
    const msg = JSON.stringify({ type: 'cluster_sync', count: appletPool.size });
    appletPool.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// --- 心跳检测 ---
const interval = setInterval(() => {
    appletPool.forEach((ws) => {
        if (ws.isAlive === false) {
            if (ws.pendingTasks > 0) { ws.ping(); return; }
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(interval));

// =================================================================
// WebSocket 核心处理逻辑
// =================================================================
wss.on('connection', (ws) => {
    ws.nodeId = Math.random().toString(36).substring(2, 7);
    ws.isAlive = true;
    ws.pendingTasks = 0;
    ws.lastUsed = 0;

    appletPool.add(ws);
    broadcastClusterStatus();

    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', (message) => {
        ws.isAlive = true;
        try {
            const msgString = message.toString();
            if (msgString.trim().toLowerCase().startsWith('p')) return;

            const msg = JSON.parse(msgString);
            // 注意这里解构出了 chunks
            const { id, success, payload, error, stream, type, chunks, done } = msg;

            if (pendingRequests.has(id)) {
                const reqData = pendingRequests.get(id);
                const { res, isSSE } = reqData;

                clearTimeout(reqData.timeoutId);
                reqData.timeoutId = setTimeout(() => handleTimeout(id), REQUEST_TIMEOUT);

                if (stream) {
                    // 1. 初始化流式头 (保持不变)
                    if (!reqData.hasStartedStream) {
                        if (isSSE) {
                            res.setHeader('Content-Type', 'text/event-stream');
                            res.setHeader('Cache-Control', 'no-cache');
                            res.setHeader('Connection', 'keep-alive');
                            res.setHeader('X-Accel-Buffering', 'no');
                            res.flushHeaders && res.flushHeaders();
                        } else {
                            res.setHeader('Content-Type', 'application/json');
                            res.setHeader('X-Accel-Buffering', 'no');
                            res.write('[\n');
                        }
                        reqData.hasStartedStream = true;
                        reqData.isFirstChunk = true;
                    }

                    // 2. 【核心修改】处理原生对象批次
                    if (type === 'batch' && Array.isArray(chunks)) {
                        for (const googleChunk of chunks) {
                            const jsonStr = JSON.stringify(googleChunk);

                            if (isSSE) {
                                // SSE 标准: data: {JSON}\n\n
                                res.write(`data: ${jsonStr}\n\n`);
                            } else {
                                // JSON Array: 逗号分隔
                                const prefix = reqData.isFirstChunk ? '  ' : ',\n  ';
                                res.write(prefix + jsonStr);
                                reqData.isFirstChunk = false;
                            }
                        }
                    }

                    // 3. 结束处理 (保持不变)
                    if (done) {
                        if (!isSSE) {
                            res.write('\n]');
                        } else {
                            // 只有 SSE 需要发 [DONE] 或者是空的 finishReason，Google 风格通常直接断开
                            // 为了兼容性，我们可以发一个空数据包
                            // res.write('data: [DONE]\n\n'); 
                        }
                        res.end();

                        ws.pendingTasks = Math.max(0, ws.pendingTasks - 1);
                        clearTimeout(reqData.timeoutId);
                        pendingRequests.delete(id);
                    }
                    return;
                }

                // 普通响应 (非流式)
                ws.pendingTasks = Math.max(0, ws.pendingTasks - 1);
                clearTimeout(reqData.timeoutId);
                if (success) res.json(payload);
                else res.status(500).json({ error: { code: 500, message: error || 'Applet Error', status: 'INTERNAL_ERROR' } });
                pendingRequests.delete(id);
            }
        } catch (e) {
            if (!e.message.includes('Unexpected token')) console.error(`[${ws.nodeId}] Parse Error:`, e.message);
        }
    });

    ws.on('close', () => {
        appletPool.delete(ws);
        // 故障转移逻辑 (简化版：仅对未开始流式的任务转移)
        for (const [id, reqData] of pendingRequests.entries()) {
            if (reqData.assignedNodeId === ws.nodeId) {
                if (!reqData.hasStartedStream) {
                    const newNode = getBestNode();
                    if (newNode) {
                        reqData.assignedNodeId = newNode.nodeId;
                        newNode.pendingTasks++;
                        newNode.send(JSON.stringify({ id, path: reqData.originalPath, body: reqData.originalBody, method: reqData.originalMethod }));
                        continue;
                    }
                }
                clearTimeout(reqData.timeoutId);
                if (reqData.hasStartedStream) reqData.res.end();
                else reqData.res.status(503).json({ error: { code: 503, message: 'Node crashed.', status: 'UNAVAILABLE' } });
                pendingRequests.delete(id);
            }
        }
        broadcastClusterStatus();
    });
    ws.on('error', (err) => console.error(`[${ws.nodeId}] Error:`, err.message));
});

function getBestNode() {
    let bestNode = null;
    let minLoad = Infinity;
    let oldestUsage = Infinity;
    for (const node of appletPool) {
        if (node.readyState !== WebSocket.OPEN) continue;
        const load = node.pendingTasks || 0;
        const lastUsed = node.lastUsed || 0;
        if (load < minLoad) { bestNode = node; minLoad = load; oldestUsage = lastUsed; }
        else if (load === minLoad) { if (lastUsed < oldestUsage) { bestNode = node; oldestUsage = lastUsed; } }
    }
    return bestNode;
}

function handleTimeout(id) {
    if (pendingRequests.has(id)) {
        const reqData = pendingRequests.get(id);
        if (reqData.hasStartedStream) reqData.res.end();
        else reqData.res.status(504).json({ error: { code: 504, message: 'Gateway Timeout', status: 'DEADLINE_EXCEEDED' } });
        pendingRequests.delete(id);
    }
}

app.use(cors());
app.use(express.json({ limit: '512mb' }));
app.use(express.urlencoded({ limit: '512mb', extended: true }));

app.get('/', (req, res) => {
    res.status(200).json({ status: 'running', nodes: appletPool.size, tasks: pendingRequests.size });
});

// GET Models
app.get('/v1beta/models', (req, res) => {
    const targetNode = getBestNode();
    if (!targetNode) return res.status(503).json({ error: { code: 503, message: 'No execution nodes.', status: 'UNAVAILABLE' } });
    const id = crypto.randomUUID();
    targetNode.lastUsed = Date.now();
    targetNode.pendingTasks++;
    const timeoutId = setTimeout(() => handleTimeout(id), REQUEST_TIMEOUT);
    pendingRequests.set(id, { res, timeoutId, assignedNodeId: targetNode.nodeId, originalPath: req.originalUrl, originalBody: {}, originalMethod: 'GET' });
    targetNode.send(JSON.stringify({ id, path: '/v1beta/models', method: 'GET', body: {} }));
});

// POST Generate (全能版)
app.post(/\/v1beta\/.*/, (req, res) => {
    const targetNode = getBestNode();
    if (!targetNode) return res.status(503).json({ error: { code: 503, message: 'No execution nodes.', status: 'UNAVAILABLE' } });

    const id = crypto.randomUUID();
    // 【关键修改】检测 SSE 请求参数
    const isSSE = req.query.alt === 'sse';

    targetNode.lastUsed = Date.now();
    targetNode.pendingTasks++;

    const timeoutId = setTimeout(() => handleTimeout(id), REQUEST_TIMEOUT);

    pendingRequests.set(id, {
        res,
        timeoutId,
        assignedNodeId: targetNode.nodeId,
        originalPath: req.originalUrl,
        originalBody: req.body,
        originalMethod: 'POST',
        hasStartedStream: false,
        isSSE: isSSE // 存储模式标记
    });

    targetNode.send(JSON.stringify({ id, path: req.originalUrl, body: req.body, method: 'POST' }));
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
```

3. **保存退出**：按 `Ctrl+O` -> `Enter` -> `Ctrl+X`。
4. **修改 package.json** (开启 ES Module 支持)：
   运行命令：

   ```bash
   npm pkg set type="module"
   ```

---

## 第三步：配置 Systemd (开机自启与守护)

我们不直接用 `npm start` 跑，因为那样只要你关掉 SSH 窗口，服务就停了。我们要用 Systemd 把它变成像 Nginx 一样的系统服务。

1. **查找 npm 路径**：
   运行 `which npm`。通常是 `/usr/bin/npm`。如果你的不一样，请替换下面配置中的路径。
2. **创建服务文件**：

   ```bash
   sudo nano /etc/systemd/system/gemini-relay.service
   ```
3. **粘贴配置**：

```ini
[Unit]
Description=Gemini Relay Server (Shadow Node Backend)
After=network.target

[Service]
# 服务类型
Type=simple
# 运行用户 (root)
User=root
# 项目所在目录 (请确保和第一步一致)
WorkingDirectory=/root/gemini-relay
# 启动命令 (注意路径)
ExecStart=/usr/bin/npm start
# 崩溃自动重启
Restart=always
RestartSec=10
# 环境变量
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

4. **启动并设为开机自启**：

```bash
# 重载配置
sudo systemctl daemon-reload
# 启动服务
sudo systemctl start gemini-relay
# 设为开机自启
sudo systemctl enable gemini-relay
```

5. **验证状态**：

   ```bash
   sudo systemctl status gemini-relay
   ```

   如果你看到绿色的 **`active (running)`**，说明配置成功！

---

## 第四步：配置 Nginx (HTTPS 与 大文件支持)

如果不配置 Nginx，你只能用 `http://IP:3000`，这不安全且 Applet 无法连接（因为 Applet 在 HTTPS 环境下必须连 WSS）。

1. **编辑你的 Nginx 站点配置** (假设你的域名已配置好 SSL)：

   ```bash
   sudo nano /etc/nginx/sites-available/your-site # 替换为你的站点配置文件
   ```
2. **确保包含以下核心配置** (特别是 WebSocket 支持和大小限制)：

```nginx
server {
    listen 443 ssl;
    server_name your-site; # 替换为你的域名

    # ... SSL 证书配置 ...

    # 【关键 1】允许上传大文件 (如视频/图片)
    client_max_body_size 512m;

    # 1. 转发 WebSocket (/ws)
    location /ws {
        proxy_pass http://127.0.0.1:3000;
  
        # WebSocket 必须的头信息
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 传递真实IP
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 超时设置：因为 WebSocket 是长连接，且你代码中有 240s 的逻辑
        # 这里设置 300s 以防止 Nginx 提前断开连接
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # 2. 转发 API 请求 (/v1beta)
    location /v1beta/ {
        proxy_pass http://127.0.0.1:3000;
        
        # 关闭缓冲，适配流式响应
        proxy_buffering off;

        # 标准代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 超时设置：你的代码设置了 REQUEST_TIMEOUT = 240000 (4分钟)
        # Nginx 默认是 60s，如果生成图片/视频超过 60s 会报 504 Gateway Timeout
        # 所以这里必须设置得比 Node 代码长
        proxy_read_timeout 300s;
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
    }
  
    # ... 其他配置 ...
}
```

3. **测试并重载 Nginx**：
   ```bash
   sudo nginx -t
   sudo systemctl reload nginx
   ```

---

## 📝 常用维护命令

现在，你的服务器已经完全自动化了。以下是一些常用命令：

* **查看实时日志** (查看 Applet 连接状态、报错等)：

  ```bash
  journalctl -u gemini-relay -f
  ```

  *(按 `Ctrl+C` 退出)*
* **重启服务** (如果你修改了 `index.js` 代码)：

  ```bash
  sudo systemctl restart gemini-relay
  ```
* **停止服务**：

  ```bash
  sudo systemctl stop gemini-relay
  ```

---

## 🎉 部署完成

现在，你的中转服务器已经：

1. **支持 512MB 大数据包**（视频/高清图无压力）。
2. **智能防断连**（生成任务时不会因心跳超时被杀）。
3. **全自动运行**（VPS 重启后自动复活）。
4. **安全加密**（通过 Nginx 走 HTTPS/WSS）。

现在去你的 Applet 里填入 `wss://your-site/ws`，即可享受丝滑的 Gemini 服务！
