#!/bin/bash

# =================================================================
# Gemini Relay Server Installer (Ultimate Edition)
# =================================================================

# 颜色定义 (Neon Palette)
RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
PURPLE='\033[1;35m'
CYAN='\033[1;36m'
WHITE='\033[1;37m'
NC='\033[0m'

# 检查 Root 权限
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}❌ 错误: 请赋予我 Root 权限 (sudo -i) 以释放全部潜能。${NC}"
  exit 1
fi

clear

# =================================================================
# 🆒 酷炫启动头 (Cyberpunk Style)
# =================================================================
echo -e "${CYAN}"
cat << "EOF"
  ____                 _       _   
 / ___| ___ _ __ ___  (_)____ (_)  
| |  _ / _ \ '_ ` _ \ | |_  / | |  
| |_| |  __/ | | | | || |/ /  | |  
 \____|\___|_| |_| |_||_/___| |_|  
                    |__/           
       RELAY SERVER INSTALLER
EOF
echo -e "${NC}"
echo -e "${PURPLE}=========================================================${NC}"
echo -e "${YELLOW} ⚡ 原创作者    : ${WHITE}云笥散人${NC}"
echo -e "${YELLOW} 🧠 架构师    : ${WHITE}Gemini 3.0 Pro${NC}"
echo -e "${YELLOW} 🛠  版本号      : ${GREEN}Ultimate V6 (Production Ready)${NC}"
echo -e "${PURPLE}=========================================================${NC}"
echo -e "${BLUE} 正在初始化量子连接...${NC}"
echo ""

# 简单的确认交互
read -p "准备好部署了吗? (y/n): " consent
if [[ "$consent" != "y" ]]; then 
    echo -e "${CYAN}操作已取消，期待下次相遇。${NC}"
    exit 0
fi

# =================================================================
# 0. 配置参数
# =================================================================
echo -e "\n${GREEN}[0/5] 核心参数配置...${NC}"

read -p "请输入服务监听端口 [默认 3000]: " USER_PORT
USER_PORT=${USER_PORT:-3000}

# 端口校验
if ! [[ "$USER_PORT" =~ ^[0-9]+$ ]] || [ "$USER_PORT" -lt 1 ] || [ "$USER_PORT" -gt 65535 ]; then
    echo -e "${YELLOW}⚠️  输入无效，系统自动重置端口为 3000${NC}"
    USER_PORT=3000
fi
echo -e "✅ 目标端口锁定: ${CYAN}${USER_PORT}${NC}"

# =================================================================
# 1. 环境构建
# =================================================================
echo -e "\n${GREEN}[1/5] 检测并构建运行环境...${NC}"

apt-get update -y >/dev/null 2>&1
echo -e "📦 系统依赖库... ${GREEN}OK${NC}"
apt-get install -y curl gnupg2 ca-certificates lsb-release build-essential >/dev/null 2>&1

# 安装 Node.js (v20 LTS)
if ! command -v node &> /dev/null; then
    echo -e "⬇️  正在下载 Node.js v20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null 2>&1
fi
echo -e "🟢 Node.js 环境: ${GREEN}$(node -v)${NC}"

# =================================================================
# 2. 项目初始化
# =================================================================
echo -e "\n${GREEN}[2/5] 初始化神经网络节点 (App)...${NC}"
PROJECT_DIR="/root/gemini-relay"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

if [ ! -f "package.json" ]; then npm init -y > /dev/null; fi

# 修复启动命令和模块类型
npm pkg set type="module"
npm pkg set scripts.start="node index.js"
echo -e "📦 安装核心依赖 (Express/WS)..."
npm install express ws cors >/dev/null 2>&1

# =================================================================
# 3. 写入核心逻辑 (含路由修复)
# =================================================================
echo -e "\n${GREEN}[3/5] 注入高性能逻辑核心...${NC}"

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

// 兼容性路由定义
app.post('/v1beta/:path*', (req, res) => {
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
echo -e "\n${GREEN}[4/5] 配置系统守护精灵 (Daemon)...${NC}"

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
Environment=PORT=$USER_PORT

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable gemini-relay
systemctl restart gemini-relay

echo -e "✅ 核心服务状态: ${GREEN}Active${NC}"

# =================================================================
# 5. Ngrok 内网穿透 (可选) - 智能路径修复
# =================================================================
echo -e "\n${GREEN}[5/5] 网络接入配置${NC}"
echo "---------------------------------------------------------"
echo "如果您没有公网 IP、域名或 SSL 证书，请使用 Ngrok。"
echo "---------------------------------------------------------"
read -p "是否启用 Ngrok 免费隧道? [y/N]: " use_ngrok

if [[ "$use_ngrok" =~ ^[yY]$ ]]; then
    echo -e "\n⬇️  正在安装 Ngrok Client..."
    
    curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
    echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | tee /etc/apt/sources.list.d/ngrok.list
    apt-get update >/dev/null 2>&1
    apt-get install ngrok -y >/dev/null 2>&1

    echo ""
    echo -e "${YELLOW}请前往: https://dashboard.ngrok.com/get-started/your-authtoken${NC}"
    read -p "🔑 粘贴您的 Ngrok Authtoken: " ngrok_token
    
    if [ -z "$ngrok_token" ]; then
        echo -e "${RED}❌ Token 未输入，Ngrok 配置跳过。${NC}"
    else
        ngrok config add-authtoken "$ngrok_token" >/dev/null 2>&1
        
        NGROK_SERVICE="/etc/systemd/system/ngrok-tunnel.service"
        NGROK_EXEC_PATH=$(which ngrok)
        
        if [ -z "$NGROK_EXEC_PATH" ]; then
            echo -e "${RED}❌ 严重错误: 找不到 ngrok 可执行文件！${NC}"
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
            
            echo -e "⏳ 正在建立量子隧道..."
            sleep 5
            
            PUBLIC_URL=$(curl -s localhost:4040/api/tunnels | grep -o '"public_url":"[^"]*' | grep -o 'https://[^"]*')
            
            if [ -n "$PUBLIC_URL" ]; then
                echo ""
                echo -e "${PURPLE}==============================================${NC}"
                echo -e "${GREEN}🎉 部署成功！所有系统已上线。${NC}"
                echo -e "${PURPLE}==============================================${NC}"
                echo -e "🔗 Applet 连接地址 (WebSocket):"
                echo -e "${CYAN}${PUBLIC_URL/https/wss}/ws${NC}"
                echo -e "${PURPLE}==============================================${NC}"
            else
                echo -e "${RED}部署完成，但无法获取 Ngrok 地址。${NC}"
                echo "请尝试手动运行: systemctl status ngrok-tunnel"
            fi
        fi
    fi
else
    echo -e "\n${GREEN}🎉 部署成功 (本地模式)${NC}"
    echo -e "🔹 服务端口: ${CYAN}${USER_PORT}${NC}"
fi

echo -e "\n🔧 管理命令:"
echo -e "${WHITE}-------------------------------------${NC}"
echo -e "🔄 重启服务: ${YELLOW}systemctl restart gemini-relay${NC}"
echo -e "📄 查看日志: ${YELLOW}journalctl -u gemini-relay -f${NC}"
echo -e "${WHITE}-------------------------------------${NC}"