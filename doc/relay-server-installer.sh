#!/bin/bash

# =================================================================
# Gemini Relay Server Installer (Smart Path V4)
# 作者: 云笥散人 | 架构优化: 世纪级全能技术宗师
# =================================================================

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}错误: 请使用 root 权限运行 (sudo -i)。${NC}"
  exit 1
fi

clear
echo -e "${BLUE}#########################################################${NC}"
echo -e "${BLUE}#    Gemini Relay Server Installer (Smart V4)           #${NC}"
echo -e "${BLUE}#########################################################${NC}"
echo ""

read -p "是否继续安装? (y/n): " consent
if [[ "$consent" != "y" ]]; then exit 0; fi

# =================================================================
# 0. 配置参数
# =================================================================
echo -e "\n${GREEN}[0/5] 配置服务参数...${NC}"

read -p "请输入服务监听端口 [默认 3000]: " USER_PORT
USER_PORT=${USER_PORT:-3000}

if ! [[ "$USER_PORT" =~ ^[0-9]+$ ]] || [ "$USER_PORT" -lt 1 ] || [ "$USER_PORT" -gt 65535 ]; then
    echo -e "${YELLOW}输入无效，已自动重置为默认端口 3000${NC}"
    USER_PORT=3000
fi
echo -e "✅ 将使用端口: ${GREEN}${USER_PORT}${NC}"

# =================================================================
# 1. 环境构建
# =================================================================
echo -e "\n${GREEN}[1/5] 准备运行环境...${NC}"

apt-get update -y
apt-get install -y curl gnupg2 ca-certificates lsb-release build-essential

if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# =================================================================
# 2. 项目初始化
# =================================================================
echo -e "\n${GREEN}[2/5] 初始化应用目录...${NC}"
PROJECT_DIR="/root/gemini-relay"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

if [ ! -f "package.json" ]; then npm init -y > /dev/null; fi

npm pkg set type="module"
npm pkg set scripts.start="node index.js"
npm install express ws cors

# =================================================================
# 3. 写入核心逻辑
# =================================================================
echo -e "\n${GREEN}[3/5] 部署高性能核心代码...${NC}"

cat > index.js << 'EOF'
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws'; 
import crypto from 'crypto';
import cors from 'cors';

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 240000;
const MAX_PAYLOAD = 512 * 1024 * 1024;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD });

const appletPool = new Set();
const pendingRequests = new Map();

function broadcastClusterStatus() {
    const msg = JSON.stringify({ type: 'cluster_sync', count: appletPool.size });
    appletPool.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

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

            const { id, success, payload, error } = JSON.parse(msgString);

            if (pendingRequests.has(id)) {
                const { res, timeoutId } = pendingRequests.get(id);
                clearTimeout(timeoutId);
                ws.pendingTasks = Math.max(0, ws.pendingTasks - 1);

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
        for (const [id, reqData] of pendingRequests.entries()) {
            if (reqData.assignedNodeId === ws.nodeId) {
                const newNode = getBestNode();
                if (newNode) {
                    reqData.assignedNodeId = newNode.nodeId;
                    newNode.pendingTasks++;
                    newNode.send(JSON.stringify({ id, path: reqData.originalPath, body: reqData.originalBody }));
                } else {
                    clearTimeout(reqData.timeoutId);
                    reqData.res.status(503).json({ error: { code: 503, message: 'Node crashed, no standby available.', status: 'UNAVAILABLE' } });
                    pendingRequests.delete(id);
                }
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

        if (load < minLoad) {
            bestNode = node;
            minLoad = load;
            oldestUsage = lastUsed;
        } else if (load === minLoad) {
            if (lastUsed < oldestUsage) {
                bestNode = node;
                oldestUsage = lastUsed;
            }
        }
    }
    return bestNode;
}

app.use(cors());
app.use(express.json({ limit: '512mb' }));
app.use(express.urlencoded({ limit: '512mb', extended: true }));

app.get('/', (req, res) => {
    res.status(200).json({
        status: 'running',
        nodes: appletPool.size,
        tasks: pendingRequests.size
    });
});

app.post('/v1beta/*', (req, res) => {
    const targetNode = getBestNode();
    if (!targetNode) return res.status(503).json({ error: { code: 503, message: 'No execution nodes.', status: 'UNAVAILABLE' } });

    const id = crypto.randomUUID();
    targetNode.lastUsed = Date.now();
    targetNode.pendingTasks++;

    const timeoutId = setTimeout(() => {
        if (pendingRequests.has(id)) {
            targetNode.pendingTasks = Math.max(0, targetNode.pendingTasks - 1);
            res.status(504).json({ error: { code: 504, message: 'Gateway Timeout', status: 'DEADLINE_EXCEEDED' } });
            pendingRequests.delete(id);
        }
    }, REQUEST_TIMEOUT);

    pendingRequests.set(id, {
        res, timeoutId,
        assignedNodeId: targetNode.nodeId, 
        originalPath: req.originalUrl,                
        originalBody: req.body                 
    });

    targetNode.send(JSON.stringify({ id, path: req.originalUrl, body: req.body }));
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
EOF

# =================================================================
# 4. 进程守护 (Systemd) - 动态路径注入
# =================================================================
echo -e "\n${GREEN}[4/5] 配置系统守护进程...${NC}"

SERVICE_FILE="/etc/systemd/system/gemini-relay.service"
# 【关键修复】动态获取 npm 路径
NPM_PATH=$(which npm)

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Gemini Relay Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$PROJECT_DIR
ExecStart=$NPM_PATH start
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=$USER_PORT

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable gemini-relay
systemctl restart gemini-relay

# =================================================================
# 5. Ngrok 内网穿透 (可选) - 智能路径修复
# =================================================================
echo -e "\n${GREEN}[5/5] 网络接入配置${NC}"
echo "---------------------------------------------------------"
echo "如果您没有公网 IP、域名或 SSL 证书，请使用 Ngrok。"
echo "---------------------------------------------------------"
read -p "是否启用 Ngrok 免费隧道? [y/N]: " use_ngrok

if [[ "$use_ngrok" =~ ^[yY]$ ]]; then
    echo -e "\n正在安装 Ngrok Client..."
    
    curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
    echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | tee /etc/apt/sources.list.d/ngrok.list
    apt-get update && apt-get install ngrok -y

    echo ""
    echo -e "${YELLOW}请前往: https://dashboard.ngrok.com/get-started/your-authtoken${NC}"
    read -p "粘贴您的 Ngrok Authtoken: " ngrok_token
    
    if [ -z "$ngrok_token" ]; then
        echo -e "${RED}Token 未输入，Ngrok 配置跳过。${NC}"
    else
        ngrok config add-authtoken "$ngrok_token" >/dev/null 2>&1
        
        NGROK_SERVICE="/etc/systemd/system/ngrok-tunnel.service"
        
        # 【关键修复】动态获取 ngrok 真实路径
        NGROK_EXEC_PATH=$(which ngrok)
        
        if [ -z "$NGROK_EXEC_PATH" ]; then
            echo -e "${RED}严重错误: 找不到 ngrok 可执行文件，请检查安装！${NC}"
        else
            cat > "$NGROK_SERVICE" << EOF
[Unit]
Description=Ngrok Tunnel
After=network.target gemini-relay.service

[Service]
Type=simple
User=root
ExecStart=$NGROK_EXEC_PATH http $USER_PORT --log=stdout
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
            systemctl daemon-reload
            systemctl enable ngrok-tunnel
            systemctl restart ngrok-tunnel
            
            echo -e "正在请求隧道地址..."
            sleep 5
            
            PUBLIC_URL=$(curl -s localhost:4040/api/tunnels | grep -o '"public_url":"[^"]*' | grep -o 'https://[^"]*')
            
            if [ -n "$PUBLIC_URL" ]; then
                echo ""
                echo -e "${BLUE}==============================================${NC}"
                echo -e "${GREEN}✅ 部署完成！${NC}"
                echo -e "${BLUE}==============================================${NC}"
                echo -e "Applet 连接地址 (WebSocket):"
                echo -e "${YELLOW}${PUBLIC_URL/https/wss}/ws${NC}"
                echo -e "${BLUE}==============================================${NC}"
            else
                echo -e "${RED}部署完成，但无法获取 Ngrok 地址。${NC}"
                echo "请尝试手动运行: systemctl status ngrok-tunnel"
            fi
        fi
    fi
else
    echo -e "\n${GREEN}✅ 部署完成 (本地模式)${NC}"
    echo "服务端口: ${USER_PORT}"
fi

echo -e "\n管理命令:"
echo "-------------------------------------"
echo "重启服务: systemctl restart gemini-relay"
echo "查看日志: journalctl -u gemini-relay -f"
echo "-------------------------------------"