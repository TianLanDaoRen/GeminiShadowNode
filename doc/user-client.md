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
    <title>Gemini Shadow Node - Pro Client</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        /* 基础样式 */
        ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }

        ::-webkit-scrollbar-track {
            background: #111827;
        }

        ::-webkit-scrollbar-thumb {
            background: #374151;
            border-radius: 3px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: #4b5563;
        }

        /* 动画 */
        .spinner {
            border: 2px solid rgba(255, 255, 255, 0.1);
            border-top: 2px solid #2dd4bf;
            border-radius: 50%;
            width: 16px;
            height: 16px;
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

        /* Markdown */
        .prose p {
            margin-bottom: 0.5em;
        }

        .prose pre {
            background: #1f2937;
            padding: 0.8rem;
            border-radius: 0.5rem;
            border: 1px solid #374151;
            overflow-x: auto;
        }

        .prose code {
            color: #e5e7eb;
            background: #374151;
            padding: 0.1rem 0.3rem;
            border-radius: 0.2rem;
            font-size: 0.85em;
            font-family: monospace;
        }

        /* Thinking Process 样式 */
        details.thinking-box {
            background: #1f2937;
            border: 1px solid #374151;
            border-radius: 0.5rem;
            margin-bottom: 1rem;
            overflow: hidden;
        }

        details.thinking-box summary {
            padding: 0.5rem 1rem;
            cursor: pointer;
            font-size: 0.75rem;
            color: #9ca3af;
            font-family: monospace;
            user-select: none;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        details.thinking-box summary:hover {
            background: #374151;
            color: #e5e7eb;
        }

        details.thinking-box[open] summary {
            border-bottom: 1px solid #374151;
        }

        .thinking-content {
            padding: 1rem;
            font-size: 0.85rem;
            color: #9ca3af;
            font-style: italic;
            border-left: 2px solid #6366f1;
            background: #111827;
        }

        /* 光标 */
        .cursor-blink::after {
            content: '▋';
            margin-left: 2px;
            color: #2dd4bf;
            animation: blink 1s infinite;
        }

        @keyframes blink {

            0%,
            100% {
                opacity: 1;
            }

            50% {
                opacity: 0;
            }
        }

        /* 【新增】图片骨架屏动画 */
        .image-skeleton {
            width: 100%;
            height: 300px;
            /* 默认占位高度 */
            background: linear-gradient(90deg, #1f2937 25%, #374151 50%, #1f2937 75%);
            background-size: 200% 100%;
            animation: loading 1.5s infinite;
            border-radius: 0.5rem;
            border: 1px solid #374151;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #6b7280;
            font-family: monospace;
            font-size: 0.8rem;
        }

        @keyframes loading {
            0% {
                background-position: 200% 0;
            }

            100% {
                background-position: -200% 0;
            }
        }
    </style>
</head>

<body
    class="bg-gray-950 text-gray-200 font-sans h-screen flex flex-col overflow-hidden selection:bg-teal-500/30 selection:text-teal-200">

    <!-- Header -->
    <header
        class="bg-gray-900/80 backdrop-blur border-b border-gray-800 p-4 shrink-0 flex flex-col sm:flex-row justify-between items-center gap-4 z-20">
        <div class="flex items-center gap-3">
            <div class="relative flex h-3 w-3">
                <span
                    class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span class="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
            </div>
            <h1 class="text-lg font-bold text-gray-100 tracking-tight font-mono">
                SHADOW<span class="text-teal-400">NODE</span> <span class="text-gray-600 text-xs">CLIENT v3.0</span>
            </h1>
        </div>

        <div class="flex items-center gap-2 w-full sm:w-auto">
            <!-- 模型选择 (onchange 触发配置切换) -->
            <select id="model-select" onchange="updateConfigPanel()"
                class="bg-gray-800 border border-gray-700 text-xs rounded-md px-3 py-2 focus:ring-1 focus:ring-teal-500 outline-none text-gray-300 hover:bg-gray-700 transition cursor-pointer">
                <option value="gemini-flash-latest" selected>Gemini 2.5 Flash (极速)</option>
                <option value="gemini-3-pro-preview">Gemini 3.0 Pro (最强)</option>
                <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                <option value="gemini-2.5-flash-image">Nano Banana (画图)</option>
            </select>

            <!-- 设置按钮 (高亮状态) -->
            <button onclick="togglePanel('settings-panel')" id="settings-btn"
                class="w-8 h-8 flex items-center justify-center bg-gray-800 border border-gray-700 hover:bg-gray-700 text-teal-400 rounded-md transition relative"
                title="生成配置">
                <i class="fa-solid fa-sliders"></i>
            </button>

            <!-- 压力测试按钮 -->
            <button onclick="togglePanel('stress-panel')"
                class="w-8 h-8 flex items-center justify-center bg-gray-800 border border-gray-700 hover:bg-red-900/30 hover:text-red-400 hover:border-red-900 rounded-md transition text-gray-400"
                title="压力测试">
                <i class="fa-solid fa-bolt"></i>
            </button>

            <!-- 清除按钮 -->
            <button onclick="clearHistory()"
                class="w-8 h-8 flex items-center justify-center bg-gray-800 border border-gray-700 hover:bg-gray-700 hover:text-red-400 rounded-md transition text-gray-400"
                title="清除上下文">
                <i class="fa-regular fa-trash-can"></i>
            </button>
        </div>
    </header>

    <!-- 设置面板 (动态变化) -->
    <div id="settings-panel"
        class="hidden absolute top-16 right-4 z-30 w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-5 backdrop-blur-xl transform transition-all duration-200 origin-top-right">
        <h3 class="text-xs font-bold text-gray-500 uppercase mb-4 flex items-center gap-2">
            <i class="fa-solid fa-microchip"></i> Model Config
        </h3>

        <!-- 1. 流式开关 -->
        <div class="flex items-center justify-between mb-5 pb-4 border-b border-gray-800">
            <span class="text-sm text-gray-300">Stream Response</span>
            <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" id="stream-toggle" class="sr-only peer" checked>
                <div
                    class="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-teal-600">
                </div>
            </label>
        </div>

        <!-- 2. 思考配置 (动态区域) -->
        <div id="thinking-config-container" class="mb-5 pb-4 border-b border-gray-800">
            <!-- Case A: Gemini 3.0 Level -->
            <div id="config-v3" class="hidden space-y-2">
                <div class="flex justify-between items-center">
                    <span class="text-sm text-purple-400 font-medium">Thinking Level</span>
                    <span class="text-[10px] text-gray-500 bg-gray-800 px-2 py-0.5 rounded">v3.0 Exclusive</span>
                </div>
                <select id="thinking-level"
                    class="w-full bg-gray-950 border border-gray-700 text-gray-300 text-xs rounded p-2 outline-none focus:border-purple-500">
                    <option value="high" selected>High (深度推理)</option>
                    <option value="low">Low (快速响应)</option>
                </select>
            </div>

            <!-- Case B: Gemini 2.x Budget -->
            <div id="config-v2" class="hidden space-y-2">
                <div class="flex justify-between items-center">
                    <span class="text-sm text-teal-400 font-medium">Thinking Budget</span>
                    <span class="text-[10px] text-gray-500 bg-gray-800 px-2 py-0.5 rounded">Token Limit</span>
                </div>
                <div class="flex gap-2">
                    <input type="number" id="thinking-budget" value="-1"
                        class="w-2/3 bg-gray-950 border border-gray-700 text-gray-300 text-xs rounded p-2 outline-none focus:border-teal-500"
                        placeholder="例如: 1024">
                    <button onclick="document.getElementById('thinking-budget').value = 0"
                        class="w-1/3 bg-gray-800 text-[10px] text-gray-400 rounded hover:bg-gray-700 hover:text-white transition">Off
                        (0)</button>
                </div>
                <p class="text-[10px] text-gray-600">-1 代表无限制 (Unlimited)</p>
            </div>

            <!-- Case C: No Thinking -->
            <div id="config-none" class="hidden text-center py-2">
                <span class="text-xs text-gray-600 italic">当前模型不支持思维链</span>
            </div>
        </div>

        <!-- 3. 温度滑块 -->
        <div class="mb-2">
            <div class="flex justify-between mb-1">
                <span class="text-sm text-gray-300">Temperature</span>
                <span id="temp-value" class="text-xs font-mono text-teal-400">1.0</span>
            </div>
            <input type="range" id="temp-slider" min="0" max="2" step="0.1" value="1.0"
                class="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-teal-500"
                oninput="document.getElementById('temp-value').innerText = this.value">
        </div>
    </div>

    <!-- 压力测试面板 (Stress) -->
    <div id="stress-panel"
        class="hidden absolute top-16 right-14 z-30 w-80 bg-gray-900 border border-red-900/50 rounded-xl shadow-2xl p-4 backdrop-blur-xl">
        <h3 class="text-xs font-bold text-red-400 uppercase mb-4 flex items-center gap-2">
            <i class="fa-solid fa-fire"></i> Stress Test
        </h3>
        <div class="space-y-3">
            <input type="number" id="stress-count" value="5" min="1" max="20"
                class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:border-red-500 outline-none"
                placeholder="并发数">
            <input type="text" id="stress-prompt" value="Hi"
                class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:border-red-500 outline-none"
                placeholder="Prompt">
            <button onclick="startStressTest()"
                class="w-full bg-red-900/50 hover:bg-red-800 text-red-200 text-sm font-bold py-2 rounded border border-red-800 transition">开始轰炸</button>
            <div id="stress-logs"
                class="h-24 overflow-y-auto bg-black/30 p-2 rounded text-[10px] font-mono text-gray-500 border border-gray-800">
                Ready.</div>
        </div>
    </div>

    <!-- 聊天主区域 -->
    <main id="chat-container" class="flex-grow overflow-y-auto p-4 space-y-6 scroll-smooth">
        <div class="flex gap-4 max-w-3xl mx-auto animate-fade-in">
            <div
                class="w-8 h-8 rounded-lg bg-teal-900/50 border border-teal-800 flex items-center justify-center shrink-0 text-teal-400">
                <i class="fa-solid fa-robot"></i>
            </div>
            <div
                class="bg-gray-800/50 border border-gray-700 rounded-2xl rounded-tl-none p-4 text-sm text-gray-300 shadow-sm">
                <p><strong>Shadow Node v3.0</strong> 已就绪。检测到新特性：</p>
                <ul class="list-disc list-inside mt-2 text-gray-400 text-xs space-y-1">
                    <li>完美适配 <strong>Gemini 3.0 Pro</strong> (Thinking Level)</li>
                    <li>完美适配 <strong>Gemini 2.5</strong> (Thinking Budget)</li>
                    <li>自动识别模型能力，动态切换配置面板</li>
                </ul>
            </div>
        </div>
    </main>

    <!-- 底部输入 -->
    <footer class="p-4 shrink-0 bg-gradient-to-t from-gray-950 to-transparent">
        <div class="max-w-3xl mx-auto">
            <!-- 图片预览 -->
            <div id="image-preview-area" class="flex gap-3 mb-3 overflow-x-auto min-h-0"></div>

            <!-- 输入框容器 -->
            <div
                class="relative bg-gray-900 rounded-xl border border-gray-700 shadow-2xl focus-within:border-teal-600/50 focus-within:ring-1 focus-within:ring-teal-900 transition-all">
                <textarea id="user-input" rows="1"
                    class="w-full bg-transparent text-gray-200 text-sm p-4 pr-12 resize-none max-h-48 focus:outline-none leading-relaxed placeholder-gray-600"
                    placeholder="发送消息给 Gemini... (Ctrl + Enter 发送)" onkeydown="handleEnter(event)"></textarea>

                <div class="absolute bottom-2 right-2 flex items-center gap-1">
                    <!-- 上传图片 -->
                    <button onclick="document.getElementById('file-input').click()"
                        class="p-2 text-gray-500 hover:text-gray-300 transition rounded-lg hover:bg-gray-800">
                        <i class="fa-solid fa-paperclip"></i>
                    </button>
                    <input type="file" id="file-input" multiple accept="image/*" class="hidden"
                        onchange="handleFileSelect(event)">

                    <!-- 发送 -->
                    <button id="send-btn" onclick="sendMessage()"
                        class="p-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg shadow-lg disabled:opacity-50 disabled:cursor-not-allowed transition active:scale-95">
                        <i class="fa-solid fa-paper-plane text-xs"></i>
                    </button>
                </div>
            </div>
            <div class="text-center mt-3 text-[10px] text-gray-600 font-mono tracking-widest opacity-50">
                POWERED BY SHADOW NODE
            </div>
        </div>
    </footer>

    <script>
        // ================= 初始化 =================
        marked.use({ breaks: true, gfm: true });
        const API_BASE = 'https://yunsisanren.top/v1beta/models';
        let chatHistory = [];
        let pendingImages = [];

        // ================= UI 逻辑：面板自动切换 =================
        function updateConfigPanel() {
            const model = document.getElementById('model-select').value;
            const v3Panel = document.getElementById('config-v3');
            const v2Panel = document.getElementById('config-v2');
            const nonePanel = document.getElementById('config-none');

            // 隐藏所有
            v3Panel.classList.add('hidden');
            v2Panel.classList.add('hidden');
            nonePanel.classList.add('hidden');

            if (model.includes('gemini-3')) {
                v3Panel.classList.remove('hidden');
            } else if (model.includes('image')) {
                nonePanel.classList.remove('hidden');
            } else {
                // 默认假设是 2.0/2.5 系列
                v2Panel.classList.remove('hidden');
            }
        }

        // 初始化运行一次
        updateConfigPanel();

        // ================= 核心逻辑 =================
        async function sendMessage() {
            const text = document.getElementById('user-input').value.trim();
            const model = document.getElementById('model-select').value;
            // 获取配置
            const isStream = document.getElementById('stream-toggle').checked;
            const temperature = parseFloat(document.getElementById('temp-slider').value);

            if (!text && pendingImages.length === 0) return;

            // UI 冻结
            const inputEl = document.getElementById('user-input');
            inputEl.value = ''; inputEl.style.height = 'auto';
            document.getElementById('send-btn').disabled = true;

            // 构造 Parts
            const currentParts = [];
            if (text) currentParts.push({ text });
            pendingImages.forEach(img => currentParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } }));

            appendMessage('user', currentParts);
            chatHistory.push({ role: 'user', parts: currentParts });

            pendingImages = [];
            document.getElementById('image-preview-area').innerHTML = '';

            // 【新增】判断是否是绘图模型
            const isImageModel = model.includes('image') || model.includes('banana');

            // 创建 AI 气泡 & 获取各种容器的引用
            // 如果是绘图模型，initThinking 显示为“正在绘制...”的骨架屏
            const { container, contentDiv, imageWrapper } = createAiMessagePlaceholder(isImageModel);
            let fullText = '';
            let thinkingText = '';

            // === 构造 Config 对象 ===
            let generationConfig = { temperature: temperature };

            if (model.includes('gemini-3')) {
                // Gemini 3.0 策略
                const level = document.getElementById('thinking-level').value;
                generationConfig.includeThoughts = true;
                generationConfig.thinkingLevel = level;
                // 3.0 的 thinkingLevel 和 temperature 并不冲突，但注意不要传 thinkingBudget
            } else if (!model.includes('image')) {
                // Gemini 2.x 策略
                const budgetVal = parseInt(document.getElementById('thinking-budget').value);
                // 只有当预算不为 0 时才发送配置
                if (budgetVal !== 0) {
                    generationConfig.thinkingConfig = {
                        includeThoughts: true,
                        thinkingBudget: budgetVal === -1 ? undefined : budgetVal // -1 表示不传（无限），或者传一个很大值
                    };
                    if (budgetVal === -1) delete generationConfig.thinkingConfig.thinkingBudget;
                }
            }

            try {
                // 根据开关选择 Endpoint
                const endpoint = isStream ? ':streamGenerateContent' : ':generateContent';

                const response = await fetch(`${API_BASE}/${model}${endpoint}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: chatHistory,
                        tools: model.includes("image") ? [] : [{ googleSearch: {} }],
                        generationConfig: generationConfig // 发送动态配置
                    })
                });

                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                if (isStream) {
                    // === 流式处理 ===
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });

                        // 鲁棒 JSON 解析
                        let startIndex = buffer.indexOf('{');
                        while (startIndex !== -1) {
                            let braceCount = 0, endIndex = -1, inString = false;
                            for (let i = startIndex; i < buffer.length; i++) {
                                if (buffer[i] === '"' && buffer[i - 1] !== '\\') inString = !inString;
                                if (!inString) {
                                    if (buffer[i] === '{') braceCount++;
                                    if (buffer[i] === '}') braceCount--;
                                }
                                if (braceCount === 0) { endIndex = i; break; }
                            }

                            if (endIndex !== -1) {
                                const jsonStr = buffer.substring(startIndex, endIndex + 1);
                                try {
                                    const data = JSON.parse(jsonStr);
                                    const parts = data.candidates?.[0]?.content?.parts;

                                    if (parts) {
                                        parts.forEach(part => {
                                            // 1. 处理 Thinking
                                            if (part.thought) {
                                                thinkingText += part.text;
                                                updateAiThinking(container, thinkingText);
                                            }
                                            // 2. 处理 Text
                                            else if (part.text) {
                                                fullText += part.text;
                                                updateAiText(container, fullText, false);
                                            }
                                            // 3. 【关键修复】处理 inlineData (图片)
                                            else if (part.inlineData) {
                                                // 移除骨架屏，渲染真图
                                                renderAiImage(container, part.inlineData);
                                            }
                                        });
                                    }
                                } catch (e) { }
                                buffer = buffer.substring(endIndex + 1);
                                startIndex = buffer.indexOf('{');
                            } else { break; }
                        }
                    }
                    // 如果是绘图且结束了还没收到图（少见），移除骨架屏显示空
                    if (isImageModel && !container.querySelector('img')) {
                        const skeleton = container.querySelector('.image-skeleton');
                        if (skeleton) skeleton.textContent = 'Generation Finished (No Image)';
                    }
                    updateAiText(aiMsgDiv, fullText, true);
                } else {
                    // === 非流式处理 ===
                    const data = await response.json();
                    const parts = data.candidates?.[0]?.content?.parts || [];

                    parts.forEach(part => {
                        if (part.thought) {
                            thinkingText += part.text;
                        } else {
                            fullText += part.text;
                        }
                    });

                    // 一次性渲染
                    if (thinkingText) updateAiThinking(aiMsgDiv, thinkingText);
                    updateAiText(aiMsgDiv, fullText, true);
                }

                // 保存历史 (文本部分)
                if (fullText) chatHistory.push({ role: 'model', parts: [{ text: fullText }] });

            } catch (error) {
                updateAiText(aiMsgDiv, fullText + `\n\n**Error:** ${error.message}`, true);
                // 如果出错，移除骨架屏
                const skeleton = container.querySelector('.image-skeleton');
                if (skeleton) skeleton.remove();
                if (chatHistory.length > 0)
                    chatHistory.pop();
            } finally {
                document.getElementById('send-btn').disabled = false;
                inputEl.focus();
                // 【双重保险修复】在最后，再次确保所有光标都被移除了
                // 找到最后一条 AI 消息（可能是刚创建的那个）
                const lastAiBubble = document.querySelector('#chat-container > div:last-child .content-wrapper');
                if (lastAiBubble) {
                    lastAiBubble.classList.remove('cursor-blink');
                }
            }
        }

        // ================= UI 渲染 =================

        function appendMessage(role, parts) {
            const div = document.createElement('div');
            div.className = `flex gap-4 max-w-3xl mx-auto animate-fade-in ${role === 'user' ? 'flex-row-reverse' : ''}`;

            const avatar = role === 'user'
                ? `<div class="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 text-[10px] text-gray-400">ME</div>`
                : `<div class="w-8 h-8 rounded bg-teal-900/50 border border-teal-800 flex items-center justify-center shrink-0 text-teal-400"><i class="fa-solid fa-robot"></i></div>`;

            let html = '';
            parts.forEach(p => {
                if (p.text) html += `<div class="prose prose-invert max-w-none text-sm leading-relaxed break-words">${marked.parse(p.text)}</div>`;
                if (p.inlineData) html += `<div class="mt-2"><img src="data:${p.inlineData.mimeType};base64,${p.inlineData.data}" class="max-w-xs rounded border border-gray-700"></div>`;
            });

            div.innerHTML = `${avatar}<div class="${role === 'user' ? 'bg-gray-800 text-gray-200' : 'bg-gray-800/50 text-gray-300'} rounded-xl p-4 border border-gray-700/50 min-w-[100px] shadow-sm">${html}</div>`;
            document.getElementById('chat-container').appendChild(div);
            scrollToBottom();
        }

        function createAiMessagePlaceholder(isImageTask = false) {
            const div = document.createElement('div');
            div.className = `flex gap-4 max-w-3xl mx-auto animate-fade-in`;

            // 如果是绘图任务，初始插入 Skeleton
            const imagePlaceholder = isImageTask
                ? `<div class="image-skeleton"><i class="fa-solid fa-paintbrush animate-bounce mr-2"></i> Creating Artwork...</div>`
                : '';

            div.innerHTML = `
                <div class="w-8 h-8 rounded bg-teal-900/50 border border-teal-800 flex items-center justify-center shrink-0 text-teal-400"><i class="fa-solid fa-robot"></i></div>
                <div class="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 min-w-[100px] w-full max-w-2xl shadow-sm">
                    <div class="thinking-wrapper hidden"></div>
                    <div class="content-wrapper prose prose-invert max-w-none text-sm leading-relaxed break-words cursor-blink"></div>
                    <div class="images-wrapper mt-2 flex flex-wrap gap-2">${imagePlaceholder}</div>
                </div>
            `;
            document.getElementById('chat-container').appendChild(div);
            scrollToBottom();

            return {
                container: div,
                contentDiv: div.querySelector('.content-wrapper'),
                imageWrapper: div.querySelector('.images-wrapper')
            };
        }

        // 【新增】渲染流式图片
        function renderAiImage(containerDiv, inlineData) {
            const wrapper = containerDiv.querySelector('.images-wrapper');
            const skeleton = wrapper.querySelector('.image-skeleton');
            if (skeleton) skeleton.remove();

            const img = document.createElement('img');
            img.src = `data:${inlineData.mimeType};base64,${inlineData.data}`;
            img.className = 'max-w-full rounded-lg border border-gray-600 shadow-lg animate-fade-in';
            wrapper.appendChild(img);

            // 【关键修复】渲染图片时，检查文本部分的光标
            // 因为图片通常是流的最后一部分
            const contentDiv = containerDiv.querySelector('.content-wrapper');
            if (contentDiv) {
                contentDiv.classList.remove('cursor-blink');
            }

            scrollToBottom();
        }

        // 确保 updateAiThinking 使用 <details> 标签
        function updateAiThinking(containerDiv, text) {
            const wrapper = containerDiv.querySelector('.thinking-wrapper');
            wrapper.classList.remove('hidden');
            wrapper.innerHTML = `<details class="thinking-box" open><summary><i class="fa-solid fa-brain text-purple-400"></i> Thinking Process</summary><div class="thinking-content whitespace-pre-wrap">${text}</div></details>`;
            scrollToBottom();
        }

        function updateAiText(containerDiv, text, isDone) {
            const contentDiv = containerDiv.querySelector('.content-wrapper');
            contentDiv.innerHTML = marked.parse(text);
            if (isDone) contentDiv.classList.remove('cursor-blink');
            scrollToBottom();
        }

        function scrollToBottom() {
            const c = document.getElementById('chat-container');
            c.scrollTop = c.scrollHeight;
        }

        // ================= 辅助功能 =================
        function togglePanel(id) {
            const el = document.getElementById(id);
            // 关闭其他面板
            ['settings-panel', 'stress-panel'].forEach(pid => {
                if (pid !== id) document.getElementById(pid).classList.add('hidden');
            });
            el.classList.toggle('hidden');
        }

        function handleEnter(e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (!document.getElementById('send-btn').disabled) sendMessage();
            } else {
                setTimeout(() => {
                    e.target.style.height = 'auto';
                    e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
                }, 0);
            }
        }

        async function handleFileSelect(event) {
            const files = event.target.files;
            if (!files.length) return;
            for (const file of files) {
                try {
                    const base64 = await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.readAsDataURL(file);
                        reader.onload = () => resolve(reader.result);
                    });
                    pendingImages.push({ mimeType: file.type, data: base64.split(',')[1] });

                    const div = document.createElement('div');
                    div.className = 'relative shrink-0 group';
                    div.innerHTML = `<img src="${base64}" class="h-12 w-12 object-cover rounded border border-gray-600"><button onclick="this.parentElement.remove(); pendingImages.shift()" class="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition">×</button>`;
                    document.getElementById('image-preview-area').appendChild(div);
                } catch (e) { }
            }
            event.target.value = '';
        }

        function clearHistory() {
            chatHistory = [];
            document.getElementById('chat-container').innerHTML = '';
        }

        async function startStressTest() {
            const count = parseInt(document.getElementById('stress-count').value) || 5;
            const prompt = document.getElementById('stress-prompt').value;
            const model = document.getElementById('model-select').value;
            const logs = document.getElementById('stress-logs');
            logs.innerHTML = 'Starting...';

            const reqs = Array.from({ length: count }).map((_, i) =>
                fetch(`${API_BASE}/${model}:generateContent`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
                }).then(res => {
                    logs.innerHTML += `<div>Req ${i}: ${res.status}</div>`;
                    logs.scrollTop = logs.scrollHeight;
                })
            );
            await Promise.all(reqs);
            logs.innerHTML += '<div>Done.</div>';
        }
    </script>
</body>

</html>
```
> 注意：您应该将 `const API_BASE = 'https://your-site/v1beta/models';`  中的 `your-site` 替换为您自己的中转服务域名。

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
