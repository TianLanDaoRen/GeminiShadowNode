
# 用户客户端实现指南

这个文件提供了一个完整的前端示例，展示了最终用户如何与您的中转服务器进行交互以调用 Gemini API。

## 核心理念

我们不会直接使用 `@google/genai` SDK，因为它被设计为直接连接到 Google 的官方端点。相反，我们将创建一个简单的JavaScript客户端，该客户端向我们的中转服务器发起一个 `fetch` 请求。

这个请求的 **URL** 和 **请求体 (body)** 结构将与官方SDK 发出的请求完全相同。这样做的好处是，我们的中转服务器就像是官方 API 的一个透明代理，使得客户端代码非常简洁且易于理解。

**新的通用代理功能**: 您现在可以通过更改 URL 路径来请求不同的模型 (如 `gemini-2.0-flash` 或 `gemini-1.5-pro`)，中转服务器会自动将其转发给 Applet。

---

## 步骤 1: 创建 HTML 文件

创建一个名为 `index.html` 的文件，并将以下代码复制进去。这个文件包含了所有必要的 HTML 结构、使用 Tailwind CSS 的样式以及完整的 JavaScript 客户端逻辑。

### `index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gemini Relay Client</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        .spinner {
            border: 4px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top: 4px solid #3498db;
            width: 24px;
            height: 24px;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body class="bg-gray-800 text-gray-200 font-sans flex items-center justify-center min-h-screen p-4">

    <div class="w-full max-w-2xl bg-gray-900 rounded-xl shadow-2xl p-8 border border-gray-700">
        <h1 class="text-3xl font-bold text-center text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-teal-400 mb-6">
            Gemini 通用代理客户端
        </h1>

        <div class="space-y-4">
            
            <!-- 模型选择器 -->
            <div>
                 <label for="model-select" class="block text-sm font-medium text-gray-400 mb-1">选择模型:</label>
                 <select id="model-select" class="w-full p-2 bg-gray-800 border border-gray-600 rounded-md focus:ring-2 focus:ring-teal-500 focus:outline-none">
                     <option value="gemini-2.5-flash">Gemini 2.5 Flash (Text)</option>
                     <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image (Image Gen)</option>
                     <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                 </select>
            </div>

            <div>
                <label for="prompt-input" class="block text-sm font-medium text-gray-400 mb-1">输入提示词:</label>
                <textarea 
                    id="prompt-input" 
                    rows="4"
                    class="w-full p-3 bg-gray-800 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:outline-none transition duration-200"
                    placeholder="例如：一只在太空冲浪的猫"
                ></textarea>
            </div>

            <button 
                id="generate-button"
                class="w-full flex items-center justify-center px-6 py-3 bg-gradient-to-r from-blue-600 to-teal-500 text-white font-bold rounded-md hover:from-blue-700 hover:to-teal-600 disabled:opacity-50 disabled:cursor-wait transition-all duration-300 shadow-lg"
            >
                <span id="button-text">生成内容</span>
                <div id="loading-spinner" class="spinner hidden ml-3"></div>
            </button>
        </div>

        <div class="mt-8">
            <h2 class="text-xl font-semibold text-gray-300 mb-3">响应:</h2>
            <div 
                id="response-output" 
                class="min-h-[100px] p-4 bg-gray-800/80 rounded-lg border border-gray-700 overflow-y-auto font-mono text-gray-300 text-sm leading-relaxed whitespace-pre-wrap"
            >
                <p class="text-gray-500">结果将显示在这里...</p>
            </div>
            <!-- 图片容器 -->
            <div id="image-container" class="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 empty:hidden"></div>
        </div>
    </div>

<script>
    // =================================================================
    // JavaScript 客户端逻辑
    // =================================================================
    
    // 基础 Relay Server URL (不包含具体模型路径)
    const RELAY_BASE_URL = 'http://localhost:3000/v1beta/models';

    const modelSelect = document.getElementById('model-select');
    const promptInput = document.getElementById('prompt-input');
    const generateButton = document.getElementById('generate-button');
    const buttonText = document.getElementById('button-text');
    const loadingSpinner = document.getElementById('loading-spinner');
    const responseOutput = document.getElementById('response-output');
    const imageContainer = document.getElementById('image-container');

    /**
     * 通过中转服务器调用Gemini API
     */
    async function generateContentProxy(model, prompt) {
        // 动态构建 URL
        const url = `${RELAY_BASE_URL}/${model}:generateContent`;
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // [关键修复] Ngrok 免费版跳过浏览器警告页面
                    'ngrok-skip-browser-warning': 'true', 
                },
                // 发送完整的 JSON 结构，包括配置
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        // 如果是图片生成模型，可以添加相关参数
                        // 注意：gemini-2.5-flash-image 可能需要 imagen-3.0/4.0 的配置风格
                        ...(model.includes('image') 
                            ? { aspectRatio: '1:1', numberOfImages: 1, outputMimeType: 'image/png' } 
                            : { temperature: 0.7 })
                    }
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: '无法解析错误响应' }));
                // 尝试从不同的错误结构中提取信息
                const errorMessage = errorData.error?.message || errorData.message || '未知错误';
                throw new Error(`HTTP 错误 ${response.status}: ${errorMessage}`);
            }

            return await response.json();

        } catch (error) {
            console.error('调用代理时出错:', error);
            throw error; 
        }
    }

    // 处理按钮点击事件
    generateButton.addEventListener('click', async () => {
        const prompt = promptInput.value.trim();
        const model = modelSelect.value;

        if (!prompt) {
            responseOutput.innerHTML = '<p class="text-yellow-400">请输入提示词!</p>';
            return;
        }

        // 更新UI为加载状态
        generateButton.disabled = true;
        buttonText.textContent = '生成中...';
        loadingSpinner.classList.remove('hidden');
        responseOutput.innerHTML = '<p class="text-gray-500">正在等待响应...</p>';
        imageContainer.innerHTML = ''; // 清空旧图片

        try {
            const data = await generateContentProxy(model, prompt);
            
            let textContent = '';
            let hasImage = false;
            
            // 解析标准 Gemini API 响应 (包含 candidates)
            if (data.candidates && data.candidates.length > 0) {
                data.candidates.forEach(candidate => {
                    if (candidate.content && candidate.content.parts) {
                        candidate.content.parts.forEach(part => {
                            // 1. 处理文本
                            if (part.text) {
                                textContent += part.text + '\n';
                            }
                            
                            // 2. 处理内联数据 (图片)
                            // 注意：检查 inlineData (camelCase) 和 inline_data (snake_case)
                            const inlineData = part.inlineData || part.inline_data;
                            
                            if (inlineData) {
                                const mimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
                                const base64Data = inlineData.data;
                                
                                const imgContainer = document.createElement('div');
                                imgContainer.className = 'relative group';

                                const img = document.createElement('img');
                                img.src = `data:${mimeType};base64,${base64Data}`;
                                img.className = 'w-full h-auto rounded-lg border border-gray-600 shadow-md transition-transform duration-300 group-hover:scale-[1.02]';
                                
                                const label = document.createElement('div');
                                label.textContent = mimeType;
                                label.className = 'absolute bottom-2 left-2 bg-black/70 text-xs text-white px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity';
                                
                                imgContainer.appendChild(img);
                                imgContainer.appendChild(label);
                                imageContainer.appendChild(imgContainer);
                                
                                textContent += `\n[已生成图像: ${mimeType}]`;
                                hasImage = true;
                            }
                        });
                    }
                });
            } 
            // 兼容处理: 如果后端直接返回了 raw generatedImages (未归一化的情况)
            else if (data.generatedImages) {
                 data.generatedImages.forEach(imgObj => {
                     const imgData = imgObj.image;
                     const img = document.createElement('img');
                     const mimeType = imgData.mimeType || 'image/png';
                     img.src = `data:${mimeType};base64,${imgData.imageBytes}`;
                     img.className = 'w-full h-auto rounded-lg border border-gray-600 shadow-md';
                     imageContainer.appendChild(img);
                     textContent += `[已生成图像]\n`;
                     hasImage = true;
                 });
            }
            else if (data.promptFeedback) {
                textContent = `提示被拦截: ${JSON.stringify(data.promptFeedback)}`;
            } 
            else {
                // 如果既没有candidates也没有generatedImages，可能是纯粹的元数据响应或者空响应
                textContent = `收到响应，但没有内容 (Status: ${JSON.stringify(data)})`;
            }
            
            if (!textContent.trim() && hasImage) {
                textContent = "图像生成成功！";
            }
            
            responseOutput.textContent = textContent || '无文本内容';

        } catch (error) {
            responseOutput.innerHTML = `<p class="text-red-400">出错了: ${error.message}</p>`;
        } finally {
            // 恢复UI
            generateButton.disabled = false;
            buttonText.textContent = '生成内容';
            loadingSpinner.classList.add('hidden');
        }
    });

</script>
</body>
</html>
