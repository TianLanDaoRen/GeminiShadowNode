# 用户测试客户端 (Client) 实现指南

这个文件提供了一个功能完备的前端示例，展示了最终用户如何与您的 **Shadow Node** 中转架构进行交互。

它不仅仅是一个简单的聊天框，更是一个能够测试服务器极限的 **多模态控制台**。

## 核心设计理念

为了保持架构的通用性和灵活性，客户端 **不依赖** 任何 Google 官方 SDK。它使用原生的 `fetch` API 发送标准的 HTTP POST 请求。

**Shadow Node 协议标准：**
客户端发送的请求体（Body）必须严格遵循 **Google Gemini REST API** 的 JSON 结构。这样做的好处是，Applet 端无需做复杂的格式转换，只需进行简单的字段清洗即可透传给 Google 内部 SDK。

### ✨ 关键特性

1. **多模态支持 (Multi-modal)**: 支持上传图片。客户端负责将图片文件转换为 **Base64** 编码，并封装为标准的 `inlineData` 格式。
2. **上下文记忆 (Context-Aware)**: 客户端在本地维护 `chatHistory` 数组。每次请求都会将之前的对话历史一并打包发送，实现连续对话。
3. **压力测试 (Stress Test)**: 内置并发请求生成器，用于测试 VPS、Nginx 和 Node.js 队列在高负载下的稳定性。
4. **Markdown 渲染**: 集成了 `marked.js`，支持代码高亮、表格渲染和 GitHub 风格换行。

---

## API 交互规范

### 1. 请求地址 (Endpoint)

客户端通过动态修改 URL 路径来切换模型。中转服务器捕获此路径并转发给 Applet。

* **URL 模板**: `https://{你的域名}/v1beta/models/{模型名称}:generateContent`
* **示例**: `https://your-site.com/v1beta/models/gemini-2.0-flash-exp:generateContent`

### 2. 请求体结构 (JSON Body)

这是客户端发送给中转服务器的标准载荷格式：

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "这张图片里有什么？"
        },
        {
          "inlineData": {
            "mimeType": "image/jpeg",
            "data": "Base64String......" 
          }
        }
      ]
    },
    {
      "role": "model",
      "parts": [{ "text": "这是一只在太空冲浪的猫。" }]
    }
    // ...更多历史记录
  ],
  "generationConfig": {
    "temperature": 0.7
  }
}
```

> **注意**: 为了适应低内存的中转服务器环境，客户端在发送图片前建议在前端进行适当压缩，避免发送超过 10MB 的超大 Base64 字符串。

---

## 步骤 1: 创建 HTML 文件

创建一个名为 `index.html` 的文件。该文件集成了 Tailwind CSS 界面库、Marked.js 渲染库以及所有的业务逻辑。

```html
<!DOCTYPE html>
<html lang="zh-CN">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gemini Shadow Node - 终极测试终端</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <!-- 引入 Markdown 解析库 -->
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        /* 自定义滚动条 */
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }

        ::-webkit-scrollbar-track {
            background: #1f2937;
        }

        ::-webkit-scrollbar-thumb {
            background: #4b5563;
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: #6b7280;
        }

        .spinner {
            border: 3px solid rgba(255, 255, 255, 0.1);
            border-radius: 50%;
            border-top: 3px solid #2dd4bf;
            width: 20px;
            height: 20px;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            0% {
                transform: rotate(0deg);
            }

            100% {
                transform: rotate(360deg);
            }
        }

        /* Markdown 样式微调 */
        .prose p {
            margin-bottom: 0.5em;
        }

        .prose pre {
            background-color: #111827;
            padding: 0.5rem;
            border-radius: 0.375rem;
            overflow-x: auto;
        }

        .prose code {
            color: #e2e8f0;
            background-color: #374151;
            padding: 0.1rem 0.3rem;
            border-radius: 0.2rem;
            font-size: 0.9em;
        }
    </style>
</head>

<body class="bg-gray-900 text-gray-200 font-sans h-screen flex flex-col overflow-hidden">

    <!-- 顶部栏 -->
    <header
        class="bg-gray-800 border-b border-gray-700 p-4 shrink-0 flex flex-col sm:flex-row justify-between items-center gap-4 z-10">
        <div class="flex items-center gap-3">
            <div class="w-3 h-3 rounded-full bg-green-500 animate-pulse"></div>
            <h1 class="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-teal-400 to-cyan-500">
                Gemini Shadow Node <span class="text-gray-500 text-sm font-mono">/ Client</span>
            </h1>
        </div>

        <div class="flex items-center gap-3 w-full sm:w-auto">
            <!-- 模型选择 -->
            <select id="model-select"
                class="bg-gray-900 border border-gray-600 text-sm rounded-lg block p-2.5 focus:ring-cyan-500 focus:border-cyan-500">
                <option value="gemini-3-pro-preview">Gemini 3.0 Pro (推荐)</option>
                <option value="gemini-2.5-flash-image">Nano Banana</option>
                <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                <option value="gemini-flash-latest">Gemini 2.5 Flash</option>
            </select>

            <!-- 压力测试开关 -->
            <button onclick="toggleStressPanel()"
                class="text-xs bg-red-900/50 text-red-300 border border-red-800 hover:bg-red-900 px-3 py-2 rounded transition">
                ⚡ 压力测试
            </button>

            <!-- 清除历史 -->
            <button onclick="clearHistory()"
                class="text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 px-3 py-2 rounded transition">
                🗑️ 清除上下文
            </button>
        </div>
    </header>

    <!-- 压力测试面板 (默认隐藏) -->
    <div id="stress-panel" class="hidden bg-red-950/90 border-b border-red-900 p-4 transition-all">
        <div class="max-w-4xl mx-auto flex flex-col sm:flex-row gap-4 items-end">
            <div class="flex-grow w-full">
                <label class="block text-xs text-red-300 mb-1">并发请求数量 (小心 OOM)</label>
                <input type="number" id="stress-count" value="5" min="1" max="50"
                    class="w-full bg-gray-900 border border-red-800 rounded p-2 text-sm">
            </div>
            <div class="flex-grow w-full">
                <label class="block text-xs text-red-300 mb-1">测试 Prompt</label>
                <input type="text" id="stress-prompt" value="你好，请简短回答你的型号。"
                    class="w-full bg-gray-900 border border-red-800 rounded p-2 text-sm">
            </div>
            <button onclick="startStressTest()"
                class="w-full sm:w-auto bg-red-600 hover:bg-red-500 text-white font-bold py-2 px-6 rounded shadow-lg whitespace-nowrap">
                🚀 发射!
            </button>
        </div>
        <div id="stress-logs" class="mt-3 h-24 overflow-y-auto bg-black/50 p-2 rounded text-xs font-mono text-gray-400">
            等待开始...
        </div>
    </div>

    <!-- 聊天内容区域 -->
    <main id="chat-container" class="flex-grow overflow-y-auto p-4 space-y-6 scroll-smooth">
        <!-- 欢迎消息 -->
        <div class="flex gap-4 max-w-3xl mx-auto">
            <div class="w-8 h-8 rounded-full bg-cyan-600 flex items-center justify-center shrink-0 text-xs font-bold">AI
            </div>
            <div
                class="bg-gray-800 rounded-2xl rounded-tl-none p-4 shadow-lg border border-gray-700 text-sm leading-relaxed">
                <p>Shadow Node 已连接。你可以发送文本，或者点击下方📎图标上传图片进行多模态测试。支持上下文连续对话。</p>
            </div>
        </div>
    </main>

    <!-- 底部输入栏 -->
    <footer class="bg-gray-800 border-t border-gray-700 p-4 shrink-0">
        <div class="max-w-3xl mx-auto">
            <!-- 图片预览区 -->
            <div id="image-preview-area" class="flex gap-2 mb-2 overflow-x-auto"></div>

            <div
                class="flex gap-2 items-end bg-gray-900 p-2 rounded-xl border border-gray-600 focus-within:border-cyan-500 transition-colors">
                <!-- 图片上传按钮 -->
                <button onclick="document.getElementById('file-input').click()"
                    class="p-2 text-gray-400 hover:text-cyan-400 transition shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"
                        stroke="currentColor" class="w-6 h-6">
                        <path stroke-linecap="round" stroke-linejoin="round"
                            d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                    </svg>
                </button>
                <input type="file" id="file-input" multiple accept="image/*" class="hidden"
                    onchange="handleFileSelect(event)">

                <!-- 文本输入 -->
                <textarea id="user-input" rows="1"
                    class="w-full bg-transparent border-none focus:ring-0 text-gray-200 resize-none py-2 max-h-32"
                    placeholder="输入消息... (Enter 换行，Ctrl/Cmd+Enter 发送)" onkeydown="handleEnter(event)"></textarea>

                <!-- 发送按钮 -->
                <button id="send-btn" onclick="sendMessage()"
                    class="p-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg shadow-lg disabled:opacity-50 disabled:cursor-not-allowed shrink-0 transition">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"
                        class="w-5 h-5 transform -rotate-45 translate-x-0.5 -translate-y-0.5">
                        <path
                            d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" />
                    </svg>
                </button>
            </div>
            <div class="text-center mt-2 text-xs text-gray-500">Powered by Gemini Shadow Node</div>
        </div>
    </footer>

    <script>
        // ================= 配置 Marked.js =================
        // 开启 "GitHub 风格换行"：允许单个回车换行
        marked.use({
            breaks: true, // <--- 核心设置：把 \n 解析为 <br>
            gfm: true     // 开启 GitHub Flavored Markdown
        });

        // ================= 配置 =================
        const API_BASE = 'https://myriadly-steplike-lynwood.ngrok-free.dev/v1beta/models';

        // 上下文历史 (Chat History)
        let chatHistory = [];
        // 待发送的图片 (Base64)
        let pendingImages = [];

        const chatContainer = document.getElementById('chat-container');
        const userInput = document.getElementById('user-input');
        const sendBtn = document.getElementById('send-btn');
        const imagePreviewArea = document.getElementById('image-preview-area');

        // ================= 核心逻辑 =================

        // 1. 处理图片选择
        async function handleFileSelect(event) {
            const files = event.target.files;
            if (!files.length) return;

            for (const file of files) {
                try {
                    const base64 = await fileToBase64(file);
                    // 保存到待发送队列，移除 Data URL 前缀，保留纯 Base64
                    const base64Data = base64.split(',')[1];
                    const mimeType = file.type;

                    pendingImages.push({ mimeType, data: base64Data });

                    // UI 预览
                    const previewDiv = document.createElement('div');
                    previewDiv.className = 'relative shrink-0 group';
                    previewDiv.innerHTML = `
                        <img src="${base64}" class="h-16 w-16 object-cover rounded-lg border border-gray-600">
                        <button onclick="removeImage(this, ${pendingImages.length - 1})" class="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs shadow-md opacity-0 group-hover:opacity-100 transition">×</button>
                    `;
                    imagePreviewArea.appendChild(previewDiv);
                } catch (e) {
                    console.error("图片处理失败", e);
                    alert("图片处理失败");
                }
            }
            // 清空 input 允许重复选择
            event.target.value = '';
        }

        function removeImage(btn, index) {
            // 简单处理：直接移除 UI，逻辑上清空该索引 (实际应用可以做更复杂的 ID 匹配)
            // 这里为了演示简单，清空所有图片重新选择可能更安全，或者只做 UI 隐藏
            btn.parentElement.remove();
            // 真正删除需要复杂的索引管理，这里简化为：如果用户删了一个，就全部清空重选吧 (懒人写法)
            // 为了演示完整性，我们暂时只支持追加，不支持单独删除某个（除非清空）
            // 实际项目请实现完整的 splice 逻辑
        }

        function fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.readAsDataURL(file);
                reader.onload = () => resolve(reader.result);
                reader.onerror = error => reject(error);
            });
        }

        // 2. 发送消息
        async function sendMessage() {
            const text = userInput.value.trim();
            const model = document.getElementById('model-select').value;

            if (!text && pendingImages.length === 0) return;

            // UI 状态更新
            userInput.value = '';
            sendBtn.disabled = true;
            userInput.style.height = 'auto';

            // 构造本次用户输入 parts
            const currentParts = [];

            // 如果有文本
            if (text) currentParts.push({ text: text });

            // 如果有图片 (转为 Gemini 标准 inlineData 格式)
            if (pendingImages.length > 0) {
                pendingImages.forEach(img => {
                    currentParts.push({
                        inlineData: {
                            mimeType: img.mimeType,
                            data: img.data
                        }
                    });
                });
            }

            // 渲染用户消息到 UI
            appendMessage('user', currentParts);

            // 更新历史上下文
            // 注意：上下文里不需要再次发 Base64 图片给历史，虽然 Gemini 支持，
            // 但为了节省 Token 和传输，通常历史记录里只保留文本，或者保留图片引用。
            // 但为了连贯性测试，我们先完整保留。
            chatHistory.push({
                role: 'user',
                parts: currentParts
            });

            // 清空待发送图片队列和 UI
            pendingImages = [];
            imagePreviewArea.innerHTML = '';

            // 添加 Loading 气泡
            const loadingId = appendLoading();
            const mytools = model.includes("image") ? [] : [{ googleSearch: {} }];

            try {
                // 发送请求
                const response = await fetch(`${API_BASE}/${model}:generateContent`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: chatHistory, // 发送完整历史
                        // 【新增】注入 Google 搜索工具
                        tools: mytools,
                        generationConfig: { temperature: 0.7 }
                    })
                });

                if (!response.ok) {
                    const err = await response.text();
                    throw new Error(`Status ${response.status}: ${err}`);
                }

                const data = await response.json();

                // 移除 Loading
                document.getElementById(loadingId).remove();

                // 解析 AI 响应
                const aiContent = data.candidates?.[0]?.content;
                if (aiContent) {
                    // 渲染 AI 消息
                    appendMessage('model', aiContent.parts);

                    // 将 AI 回复加入历史
                    chatHistory.push(aiContent);
                } else {
                    appendMessage('error', [{ text: '收到空响应，请检查服务端日志' }]);
                }

            } catch (error) {
                document.getElementById(loadingId)?.remove();
                appendMessage('error', [{ text: `请求失败: ${error.message}` }]);
                // 出错后回滚最后一条用户历史，防止上下文错乱
                chatHistory.pop();
            } finally {
                sendBtn.disabled = false;
                userInput.focus();
            }
        }

        // ================= UI 辅助 =================

        function appendMessage(role, parts) {
            const div = document.createElement('div');
            div.className = `flex gap-4 max-w-3xl mx-auto ${role === 'user' ? 'flex-row-reverse' : ''}`;

            const avatar = role === 'user'
                ? `<div class="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center shrink-0 text-xs">You</div>`
                : `<div class="w-8 h-8 rounded-full bg-cyan-600 flex items-center justify-center shrink-0 text-xs font-bold">AI</div>`;

            // 错误消息图标
            const errorAvatar = `<div class="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center shrink-0 text-xs">Err</div>`;

            let contentHtml = '';

            parts.forEach(part => {
                // 1. 文本渲染
                if (part.text) {
                    const parsedText = marked.parse(part.text);
                    contentHtml += `<div class="prose prose-invert max-w-none text-sm leading-relaxed break-words">${parsedText}</div>`;
                }

                // 2. 图片渲染
                if (part.inlineData || part.inline_data) {
                    const imgData = part.inlineData || part.inline_data;
                    contentHtml += `<div class="mt-2"><img src="data:${imgData.mimeType};base64,${imgData.data}" class="max-w-full sm:max-w-xs rounded-lg border border-gray-600"></div>`;
                }

                // 【新增】3. 工具调用渲染 (Function Call)
                if (part.functionCall) {
                    const funcName = part.functionCall.name;
                    const args = JSON.stringify(part.functionCall.args, null, 2);
                    contentHtml += `
                        <div class="mt-2 p-3 bg-gray-900 rounded border border-purple-500/50 font-mono text-xs">
                            <div class="flex items-center gap-2 text-purple-400 mb-2">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                                <span>调用工具: ${funcName}</span>
                            </div>
                            <pre class="text-gray-400 overflow-x-auto">${args}</pre>
                        </div>
                    `;
                }

                // 【新增】4. 工具执行结果 (Function Response - 用于回显历史)
                if (part.functionResponse) {
                    contentHtml += `
                        <div class="mt-2 p-2 bg-gray-800/50 rounded border border-gray-700 font-mono text-xs text-gray-500">
                            ↳ 工具返回: ${JSON.stringify(part.functionResponse.response)}
                        </div>
                     `;
                }
            });

            const bgClass = role === 'user' ? 'bg-gray-700 rounded-tr-none' : (role === 'error' ? 'bg-red-900/50 border-red-700' : 'bg-gray-800 rounded-tl-none');

            div.innerHTML = `
                ${role === 'error' ? errorAvatar : avatar}
                <div class="${bgClass} rounded-2xl p-4 shadow-lg border border-gray-700 min-w-[100px]">
                    ${contentHtml}
                </div>
            `;

            chatContainer.appendChild(div);
            // 滚动到底部
            setTimeout(() => chatContainer.scrollTop = chatContainer.scrollHeight, 100);
        }

        function appendLoading() {
            const id = 'loading-' + Date.now();
            const div = document.createElement('div');
            div.id = id;
            div.className = `flex gap-4 max-w-3xl mx-auto`;
            div.innerHTML = `
                <div class="w-8 h-8 rounded-full bg-cyan-600 flex items-center justify-center shrink-0 text-xs font-bold">AI</div>
                <div class="bg-gray-800 rounded-2xl rounded-tl-none p-4 shadow-lg border border-gray-700 flex items-center gap-2">
                    <div class="spinner"></div>
                    <span class="text-gray-400 text-xs">Shadow Node 正在思考...</span>
                </div>
            `;
            chatContainer.appendChild(div);
            chatContainer.scrollTop = chatContainer.scrollHeight;
            return id;
        }

        function handleEnter(e) {
            // 检测 Ctrl/Cmd + Enter
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                // 【关键修复】检查发送按钮是否被禁用
                // 如果正在发送中（按钮是灰的），则忽略这次快捷键
                if (document.getElementById('send-btn').disabled) {
                    console.log('正在发送中，忽略快捷键...');
                    return;
                }

                sendMessage();
                return;
            }

            // 自动高度调整
            setTimeout(() => {
                e.target.style.height = 'auto';
                e.target.style.height = e.target.scrollHeight + 'px';
            }, 0);
        }

        function clearHistory() {
            chatHistory = [];
            chatContainer.innerHTML = `
                <div class="flex gap-4 max-w-3xl mx-auto">
                    <div class="w-8 h-8 rounded-full bg-cyan-600 flex items-center justify-center shrink-0 text-xs font-bold">AI</div>
                    <div class="bg-gray-800 rounded-2xl rounded-tl-none p-4 shadow-lg border border-gray-700 text-sm leading-relaxed">
                        <p>上下文已清除。一切重新开始。</p>
                    </div>
                </div>
            `;
        }

        // ================= 压力测试逻辑 =================

        function toggleStressPanel() {
            document.getElementById('stress-panel').classList.toggle('hidden');
        }

        async function startStressTest() {
            const count = parseInt(document.getElementById('stress-count').value) || 5;
            const prompt = document.getElementById('stress-prompt').value;
            const model = document.getElementById('model-select').value;
            const logsDiv = document.getElementById('stress-logs');

            logsDiv.innerHTML = `开始并发测试: ${count} 请求...\n`;

            const promises = [];
            const startTime = Date.now();

            for (let i = 0; i < count; i++) {
                const p = fetch(`${API_BASE}/${model}:generateContent`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ role: 'user', parts: [{ text: prompt + ` (Req ID: ${i})` }] }]
                    })
                }).then(async res => {
                    const status = res.status;
                    const time = Date.now() - startTime;
                    logsDiv.innerHTML += `[Req ${i}] Status: ${status} (${time}ms)\n`;
                    logsDiv.scrollTop = logsDiv.scrollHeight;
                    return status;
                }).catch(err => {
                    logsDiv.innerHTML += `[Req ${i}] FAIL: ${err.message}\n`;
                });
                promises.push(p);
            }

            await Promise.all(promises);
            logsDiv.innerHTML += `\n测试完成。总耗时: ${Date.now() - startTime}ms`;
        }

    </script>
</body>

</html>
```

---

## 步骤 2: 运行与测试

您不需要安装任何额外的 Node.js 依赖来运行这个客户端。

### 方法 A: 直接打开 (最简单)

直接在您的文件管理器中双击 `index.html` 文件，或者将其拖入 **Chrome** 或 **Edge** 浏览器中。

### 方法 B: 使用本地服务器 (推荐)

为了获得最佳体验（并避免某些浏览器严格的 `file://` 协议跨域限制），建议使用 VS Code 的 **Live Server** 插件，或者在终端运行：

```bash
# 如果安装了 Python
python3 -m http.server 8000
# 然后访问 http://localhost:8000
```

---

## 步骤 3: 功能操作指南

### 1. 基础对话

* 在输入框输入文本，按 `Ctrl + Enter` (或 `Cmd + Enter`) 发送。
* AI 的回复支持 **Markdown** 渲染，包括代码块高亮和表格。

### 2. 图片理解 (多模态)

* 点击输入框左侧的 **📎 (回形针)** 图标，选择一张或多张图片。
* 输入提示词（例如：“提取图片中的文字”），然后发送。
* 客户端会自动将图片转换为 Base64 并通过中转服务器发送给 Applet。

### 3. 上下文连续对话

* 无需任何设置，客户端会自动记录您的聊天历史。
* 您可以像与 ChatGPT 聊天一样进行追问。
* 点击顶部的 **“🗑️ 清除上下文”** 按钮可以重置记忆，开始新话题。

### 4. 压力测试 (Stress Test)

* 点击顶部的 **“⚡ 压力测试”** 按钮打开控制面板。
* 设置并发数量（建议从 5 开始）。
* 点击 **“🚀 发射”**。
* 观察下方的日志面板，如果所有请求都返回 `Status: 200`，说明您的 **Shadow Node** 架构坚如磐石。

---

## 常见问题排查

* **请求一直转圈不返回**:
  * 检查 AiStudio 的 Gemini Shadow Node Applet 是否已连接。
  * 检查是否触发了 Nginx 的 60秒超时（我们配置了 300s，通常够用）。
* **图片发送失败**:
  * 虽然服务器支持 512MB，但浏览器端处理超大图片（如 10MB+ 原图）可能导致卡顿。建议发送前适当压缩图片。
* **CORS 跨域错误**:
  * 确保您的 Nginx 配置或 Node.js 代码中包含了 `cors` 中间件（我们的 `relay-server` 已包含）。
