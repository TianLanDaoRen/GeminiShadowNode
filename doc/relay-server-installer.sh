#!/bin/bash

# =================================================================
# Gemini Relay Server 一键部署脚本 (生产环境纯净版)
# 作者: 云笥散人 | 架构优化: 世纪级全能技术宗师
# =================================================================

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 检查 Root 权限
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}错误: 请使用 root 权限运行 (sudo -i)。${NC}"
  exit 1
fi

clear
echo -e "${BLUE}#########################################################${NC}"
echo -e "${BLUE}#       Gemini Relay Server 一键部署 (Production)       #${NC}"
echo -e "${BLUE}#########################################################${NC}"
echo ""
echo -e "${YELLOW}警告: 执行此脚本将修改系统服务配置。${NC}"
echo -e "${YELLOW}作者与优化者不对因使用此脚本导致的任何损失负责。${NC}"
echo ""

read -p "是否已知晓风险并继续? (请输入 y): " consent
if [[ "$consent" != "y" ]]; then
    echo "操作已取消。"
    exit 0
fi

# =================================================================
# 1. 环境构建
# =================================================================
echo -e "\n${GREEN}[1/5] 准备运行环境...${NC}"

# 安装系统级依赖
apt-get update -y
apt-get install -y curl gnupg2 ca-certificates lsb-release build-essential

# 安装 Node.js (v20 LTS)
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    echo "Node.js 已安装: $(node -v)"
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
npm install express ws cors

# =================================================================
# 3. 写入核心逻辑 (Clean Version)
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

// 心跳检测
const interval = setInterval(() => {
    appletPool.forEach((ws) => {
        if (ws.isAlive === false) {
            // 正在工作的节点豁免被杀
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
            if (msgString.trim().toLowerCase().startsWith('p')) return; // 忽略 ping 包

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

    // 关键：断连故障转移逻辑
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

// LRU 调度算法
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
# 4. 进程守护 (Systemd)
# =================================================================
echo -e "\n${GREEN}[4/5] 配置系统守护进程...${NC}"

SERVICE_FILE="/etc/systemd/system/gemini-relay.service"
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

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable gemini-relay
systemctl restart gemini-relay

# =================================================================
# 5. Ngrok 内网穿透 (可选)
# =================================================================
echo -e "\n${GREEN}[5/5] 网络接入配置${NC}"
echo "---------------------------------------------------------"
echo "如果您没有公网 IP、域名或 SSL 证书，请使用 Ngrok。"
echo "---------------------------------------------------------"
read -p "是否启用 Ngrok 免费隧道? [y/N]: " use_ngrok

if [[ "$use_ngrok" =~ ^[yY]$ ]]; then
    echo -e "\n正在安装 Ngrok Client..."
    
    # 官方安装源
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
        
        # 配置 Ngrok 守护进程
        NGROK_SERVICE="/etc/systemd/system/ngrok-tunnel.service"
        cat > "$NGROK_SERVICE" << EOF
[Unit]
Description=Ngrok Tunnel
After=network.target gemini-relay.service

[Service]
Type=simple
User=root
ExecStart=/usr/bin/ngrok http 3000 --log=stdout
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
        
        # 动态抓取公网地址
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
else
    echo -e "\n${GREEN}✅ 部署完成 (本地模式)${NC}"
    echo "服务端口: 3000"
    echo "请配置 Nginx 反代或放行防火墙端口。"
fi

echo -e "\n管理命令:"
echo "-------------------------------------"
echo "重启服务: systemctl restart gemini-relay"
echo "查看日志: journalctl -u gemini-relay -f"
echo "-------------------------------------"