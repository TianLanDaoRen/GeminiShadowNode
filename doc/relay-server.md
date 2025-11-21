# 🚀 Gemini 中转服务器 (Relay Server) 部署指南 (终极版)

这个文件包含了使用 Node.js、Express 和 `ws` 库实现中转服务器的完整代码。

## 核心功能

- **通用 HTTP 代理**: 暴露 `/v1beta/*` 通配符端点。它捕获任何 Gemini API 请求（包括模型名称、生成配置、系统指令等）并按原样转发。
- **WebSocket 服务器**: 在 `/ws` 路径上启动一个 WebSocket 服务器，等待安全的 Applet 客户端连接。
- **透明转发**: 将 HTTP 请求的 **路径 (Path)** 和 **请求体 (Body)** 打包并通过 WebSocket 发送给 Applet。
- **响应匹配**: 使用唯一的请求 ID 来匹配从 Applet 返回的响应，并将其作为 HTTP 响应发送回给原始请求者。

---

## 📋 准备工作

1.  你需要一台 **Linux 服务器** (推荐 Ubuntu/Debian)。
2.  你需要 **Root 权限** (或者使用 `sudo`)。
3.  确保服务器已安装 **Node.js** (建议 v18 或更高版本)。

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
1.  创建文件：
    ```bash
    nano index.js
    ```

2.  **完整复制**以下代码并粘贴进去：

```javascript
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws'; // 引入 WebSocket 常量
import crypto from 'crypto';
import cors from 'cors';

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 240000;

const app = express();
const server = http.createServer(app);

// 512MB 大载荷支持
const MAX_PAYLOAD = 512 * 1024 * 1024;
const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_PAYLOAD
});

// 【关键修改 1】从单个 socket 变为 节点池 (Set)
const appletPool = new Set();
const pendingRequests = new Map();

// 【新增】广播集群状态给所有节点
function broadcastClusterStatus() {
    const count = appletPool.size;
    // 构造系统消息
    const msg = JSON.stringify({
        type: 'cluster_sync',
        count: count
    });

    appletPool.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// =================================================================
// 心跳与存活检测 (全员检测)
// =================================================================
function heartbeat() {
    this.isAlive = true;
}

const interval = setInterval(function ping() {
    // 遍历池子里的每一个节点
    appletPool.forEach((ws) => {
        if (ws.isAlive === false) {
            // 豁免逻辑：如果这个节点正在干活，别杀它
            if (ws.pendingTasks > 0) {
                console.log(`⚠️ 节点 [${ws.nodeId}] 心跳超时，但有 ${ws.pendingTasks} 个任务在运行，豁免...`);
                ws.ping();
                return;
            }
            console.log(`💀 节点 [${ws.nodeId}] 失去响应，移除连接。`);
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

// =================================================================
// WebSocket 连接管理
// =================================================================
wss.on('connection', (ws, req) => {
    // 给每个连接分配一个短 ID，方便日志观察
    ws.nodeId = Math.random().toString(36).substring(2, 7);
    ws.isAlive = true;
    ws.pendingTasks = 0; // 【关键】记录该节点的负载
    ws.lastUsed = 0; // 【新增】初始化上次使用时间，0 表示还没用过（优先级最高）

    // 加入节点池
    appletPool.add(ws);

    // 【关键】连接成功后，广播最新数量
    broadcastClusterStatus();

    const clientIp = req.socket.remoteAddress;
    console.log(`✅ 新节点接入 [ID: ${ws.nodeId}] 来自: ${clientIp}. 当前在线节点数: ${appletPool.size}`);

    ws.on('pong', heartbeat);

    ws.on('message', (message) => {
        ws.isAlive = true;
        try {
            const msgString = message.toString();
            if (msgString.trim().toLowerCase().startsWith('p')) return;

            const { id, success, payload, error } = JSON.parse(msgString);

            if (pendingRequests.has(id)) {
                const { res, timeoutId } = pendingRequests.get(id);
                clearTimeout(timeoutId);

                // 任务完成，减少该节点的负载计数
                ws.pendingTasks = Math.max(0, ws.pendingTasks - 1);
                console.log(`📉 节点 [${ws.nodeId}] 完成任务. 当前负载: ${ws.pendingTasks}`);

                if (success) {
                    res.json(payload);
                } else {
                    res.status(500).json({ error: { code: 500, message: error || 'Applet Error', status: 'INTERNAL_ERROR' } });
                }
                pendingRequests.delete(id);
            }
        } catch (e) {
            if (!e.message.includes('Unexpected token')) console.error('消息解析失败:', e.message);
        }
    });

    ws.on('close', () => {
        console.log(`❌ 节点 [${ws.nodeId}] 断开连接.`);
        appletPool.delete(ws);
        // 【新增】故障转移逻辑
        // 检查这个断开的节点手头有没有还没做完的任务
        // 注意：我们需要遍历 pendingRequests，找到分配给这个 ws 的任务
        // 为了高效，我们需要稍微修改 pendingRequests 的结构，或者遍历查找
        // 简单高效的做法：遍历 pendingRequests
        for (const [id, reqData] of pendingRequests.entries()) {
            // 这里的 reqData 是 { res, timeoutId, assignedNodeId } 
            // 我们需要在分配任务时记录 assignedNodeId
            if (reqData.assignedNodeId === ws.nodeId) {
                console.log(`⚠️ 任务 [${id}] 因节点 [${ws.nodeId}] 断开而中断，正在尝试故障转移...`);

                // 尝试获取新节点
                const newNode = getBestNode();

                if (newNode) {
                    console.log(`🔄 任务 [${id}] 重新调度 -> 节点 [${newNode.nodeId}]`);
                    // 更新分配记录
                    reqData.assignedNodeId = newNode.nodeId;
                    // 增加新节点负载
                    newNode.pendingTasks++;
                    // 重新发送指令 (注意：我们需要在 reqData 里暂存原始的 message 字符串或 body)
                    // 这一步需要我们在 app.post 里把 body 也存进 pendingRequests
                    newNode.send(JSON.stringify({
                        id: id,
                        path: reqData.originalPath, // 需在 app.post 存储
                        body: reqData.originalBody  // 需在 app.post 存储
                    }));
                } else {
                    console.error(`💥 任务 [${id}] 故障转移失败：无可用节点。`);
                    // 既然没节点了，立即报错，不要让用户等超时
                    clearTimeout(reqData.timeoutId);
                    reqData.res.status(503).json({
                        error: { code: 503, message: 'Worker node crashed and no standby nodes available.', status: 'UNAVAILABLE' }
                    });
                    pendingRequests.delete(id);
                }
            }
        }
        // 【关键】断开后，广播最新数量
        broadcastClusterStatus();
        console.log(`📊 当前剩余节点数: ${appletPool.size}`);
    });

    ws.on('error', (err) => {
        console.error(`节点 [${ws.nodeId}] 错误:`, err.message);
    });
});

// =================================================================
// 优化后的调度算法 (O(N) + LRU 策略)
// =================================================================
function getBestNode() {
    let bestNode = null;
    let minLoad = Infinity;
    let oldestUsage = Infinity; // 记录“上一次工作时间”，越小表示休息得越久

    // 直接遍历 Set，无需 Array.from，零内存分配
    for (const node of appletPool) {
        // 1. 过滤掉断开的
        if (node.readyState !== WebSocket.OPEN) continue;

        const load = node.pendingTasks || 0;
        const lastUsed = node.lastUsed || 0; // 默认为 0 (很久以前)

        // 2. 第一优先级：找负载最小的
        if (load < minLoad) {
            bestNode = node;
            minLoad = load;
            oldestUsage = lastUsed;
        }
        // 3. 第二优先级：负载一样时，选休息最久的 (LRU)
        // 这一步至关重要！它实现了“账号轮询”的效果，保护你的 API Rate Limit
        else if (load === minLoad) {
            if (lastUsed < oldestUsage) {
                bestNode = node;
                oldestUsage = lastUsed;
            }
        }
    }

    return bestNode;
}

// =================================================================
// Express HTTP API
// =================================================================

app.use(cors());
app.use(express.json({ limit: '512mb' }));
app.use(express.urlencoded({ limit: '512mb', extended: true }));

app.get('/', (req, res) => {
    // 统计总负载
    let totalLoad = 0;
    appletPool.forEach(ws => totalLoad += ws.pendingTasks);

    res.status(200).json({
        status: 'running',
        mode: 'distributed_cluster',
        totalNodes: appletPool.size,
        totalPendingTasks: pendingRequests.size,
        nodes: Array.from(appletPool).map(ws => ({
            id: ws.nodeId,
            load: ws.pendingTasks,
            alive: ws.isAlive
        }))
    });
});

app.post('/v1beta/*', (req, res) => {
    // 【关键修改 2】获取最佳节点
    const targetNode = getBestNode();

    if (!targetNode) {
        return res.status(503).json({ error: { code: 503, message: 'No available execution nodes connected.', status: 'UNAVAILABLE' } });
    }

    const id = crypto.randomUUID();
    const path = req.originalUrl;
    const body = req.body; // 获取 body

    // 增加节点负载计数
    // 【新增】更新该节点的“最后使用时间”为当前时间
    // 这样它在下一轮调度中，优先级就会排到最后，让其他兄弟节点先上
    targetNode.lastUsed = Date.now();
    targetNode.pendingTasks++;
    console.log(`🚀 调度任务 [${id}] -> 节点 [${targetNode.nodeId}] (负载: ${targetNode.pendingTasks})`);

    const timeoutId = setTimeout(() => {
        if (pendingRequests.has(id)) {
            console.log(`⏰ 任务 [${id}] 超时. 修正节点 [${targetNode.nodeId}] 负载.`);
            // 超时了也要把负载减回去，防止计数器泄露
            targetNode.pendingTasks = Math.max(0, targetNode.pendingTasks - 1);

            res.status(504).json({ error: { code: 504, message: 'Gateway Timeout', status: 'DEADLINE_EXCEEDED' } });
            pendingRequests.delete(id);
        }
    }, REQUEST_TIMEOUT);

    // 【关键修改】在 Map 里存储更多信息，以便故障转移时使用
    pendingRequests.set(id, {
        res,
        timeoutId,
        assignedNodeId: targetNode.nodeId, // 记录是谁接的单
        originalPath: path,                // 存下来备用
        originalBody: body                 // 存下来备用
    });

    targetNode.send(JSON.stringify({ id, path, body: req.body }));
});

server.listen(PORT, () => {
    console.log(`🚀 分布式中转集群启动: http://localhost:${PORT}`);
});
```

3.  **保存退出**：按 `Ctrl+O` -> `Enter` -> `Ctrl+X`。

4.  **修改 package.json** (开启 ES Module 支持)：
    运行命令：
    ```bash
    npm pkg set type="module"
    ```


---

## 第三步：配置 Systemd (开机自启与守护)

我们不直接用 `npm start` 跑，因为那样只要你关掉 SSH 窗口，服务就停了。我们要用 Systemd 把它变成像 Nginx 一样的系统服务。

1.  **查找 npm 路径**：
    运行 `which npm`。通常是 `/usr/bin/npm`。如果你的不一样，请替换下面配置中的路径。

2.  **创建服务文件**：
    ```bash
    sudo nano /etc/systemd/system/gemini-relay.service
    ```

3.  **粘贴配置**：

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

4.  **启动并设为开机自启**：

```bash
# 重载配置
sudo systemctl daemon-reload
# 启动服务
sudo systemctl start gemini-relay
# 设为开机自启
sudo systemctl enable gemini-relay
```

5.  **验证状态**：
    ```bash
    sudo systemctl status gemini-relay
    ```
    如果你看到绿色的 **`active (running)`**，说明配置成功！

---

## 第四步：配置 Nginx (HTTPS 与 大文件支持)

如果不配置 Nginx，你只能用 `http://IP:3000`，这不安全且 Applet 无法连接（因为 Applet 在 HTTPS 环境下必须连 WSS）。

1.  **编辑你的 Nginx 站点配置** (假设你的域名已配置好 SSL)：
    ```bash
    sudo nano /etc/nginx/sites-available/your-site # 替换为你的站点配置文件
    ```

2.  **确保包含以下核心配置** (特别是 WebSocket 支持和大小限制)：

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
        
        # WebSocket 协议升级头 (必须!)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # 传递真实 IP
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 超时设置 (防止生成视频时长连接断开)
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # 2. 转发 API 请求 (/v1beta)
    location /v1beta/ {
        proxy_pass http://127.0.0.1:3000;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 同样需要长超时
        proxy_read_timeout 300s;
    }
    
    # ... 其他配置 ...
}
```

3.  **测试并重载 Nginx**：
    ```bash
    sudo nginx -t
    sudo systemctl reload nginx
    ```

---

## 📝 常用维护命令

现在，你的服务器已经完全自动化了。以下是一些常用命令：

*   **查看实时日志** (查看 Applet 连接状态、报错等)：
    ```bash
    journalctl -u gemini-relay -f
    ```
    *(按 `Ctrl+C` 退出)*

*   **重启服务** (如果你修改了 `index.js` 代码)：
    ```bash
    sudo systemctl restart gemini-relay
    ```

*   **停止服务**：
    ```bash
    sudo systemctl stop gemini-relay
    ```

---

## 🎉 部署完成

现在，你的中转服务器已经：
1.  **支持 512MB 大数据包**（视频/高清图无压力）。
2.  **智能防断连**（生成任务时不会因心跳超时被杀）。
3.  **全自动运行**（VPS 重启后自动复活）。
4.  **安全加密**（通过 Nginx 走 HTTPS/WSS）。

现在去你的 Applet 里填入 `wss://your-site/ws`，即可享受丝滑的 Gemini 服务！