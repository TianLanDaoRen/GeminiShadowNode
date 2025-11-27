import { Injectable, signal } from '@angular/core';
import { GoogleGenAI } from '@google/genai';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { Subject, takeUntil, catchError, EMPTY } from 'rxjs';

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

@Injectable({
    providedIn: 'root',
})
export class GeminiService {
    private ai: GoogleGenAI;

    private socket$: WebSocketSubject<any> | null = null;
    private destroySocket$ = new Subject < void> ();
    private currentUrl: string = '';

    connectionStatus = signal < ConnectionStatus > ('disconnected');
    messages$ = new Subject < any > ();
    nodeCount = signal < number > (0);

    private isExpectedDisconnect = false;
    private reconnectTimer: any = null;
    private readonly RECONNECT_DELAY = 3000;

    // 【新增】流式缓冲间隔信号 (默认 500ms)
    bufferInterval = signal < number > (500);

    constructor() {
        let key = process.env['API_KEY'];
        if (!key) throw new Error('API_KEY is not set.');
        key = key.trim().replace(/^["']|["']$/g, '');
        this.ai = new GoogleGenAI({ apiKey: key });
        // 【新增】从 LocalStorage 读取上次的设置
        const savedInterval = localStorage.getItem('buffer_interval');
        if (savedInterval) {
            this.bufferInterval.set(parseInt(savedInterval, 10));
        }
    }

    // 【新增】更新间隔的方法
    setBufferInterval(ms: number) {
        this.bufferInterval.set(ms);
        localStorage.setItem('buffer_interval', ms.toString());
        console.log(`[System] Buffer interval set to ${ms}ms`);
    }

    connect(url: string): void {
        if (this.socket$ && !this.socket$.closed) return;
        this.currentUrl = url;
        this.isExpectedDisconnect = false;
        this.clearReconnectTimer();
        this.initSocket();
    }

    private initSocket(): void {
        this.connectionStatus.set('connecting');
        console.log(`[System] Connecting to relay...`);

        try {
            this.socket$ = webSocket({
                url: this.currentUrl,
                openObserver: {
                    next: () => {
                        console.log('[System] Connected');
                        this.connectionStatus.set('connected');
                        this.requestWakeLock();
                    },
                },
                closeObserver: {
                    next: (evt) => {
                        console.log('[System] Closed', evt.code);
                        this.handleClose();
                    }
                },
            });

            this.socket$.pipe(
                takeUntil(this.destroySocket$),
                catchError(error => {
                    console.error('[System] Socket Error:', this.normalizeError(error));
                    this.connectionStatus.set('error');
                    this.messages$.next({ type: 'error', text: 'Connection Error' });
                    return EMPTY;
                })
            ).subscribe({
                next: (msg) => this.handleIncomingMessage(msg),
                error: (err) => console.error(err)
            });

        } catch (e) {
            console.error('Init Error:', e);
            this.handleClose();
        }
    }

    // --- 【核心升级】API 路由分发 ---
    private async handleIncomingMessage(message: any) {
        if (message?.type === 'cluster_sync') {
            this.nodeCount.set(message.count);
            return;
        }

        if (message && message.id && message.path) {
        const path = message.path;
        
        // 1. 模型列表 (GET)
        if (message.method === 'GET' && path.includes('/models')) {
            this.handleListModels(message.id);
        } 
        // 2. 内容生成 (POST)
        else if (path.includes(':generateContent') || path.includes(':streamGenerateContent')) {
            this.handleGenerateRequest(message);
        }
        // 3. 【新增】嵌入 (Embedding - POST)
        else if (path.includes(':embedContent')) {
            this.handleEmbedRequest(message, false); // false = not batch
        }
        // 4. 【新增】批量嵌入 (Batch Embedding - POST)
        else if (path.includes(':batchEmbedContent')) {
            this.handleEmbedRequest(message, true); // true = batch
        }
        // ... 可以在这里添加更多 API 路由
        else {
            this.sendMessage({ 
                id: message.id, 
                success: false, 
                error: `Unsupported API endpoint: ${path}` 
            });
        }
        }
    }

    // --- 业务逻辑分离 ---

    private async handleListModels(id: string) {
        try {
            const modelsData = await this.listModels();
            this.sendMessage({ id, success: true, payload: modelsData });
        } catch (error: any) {
            this.sendMessage({ id, success: false, error: error.message });
        }
    }

    private async handleGenerateRequest(message: any) {
        const { id, path, body } = message;
        // 判断是否需要流式：通过 URL 或 Body 参数
        const isStreaming = path.includes('stream') || body.stream === true;

        console.log(`Processing Task [${id}] (Stream: ${isStreaming})...`);
        this.messages$.next({ type: 'info', text: `Processing ${isStreaming ? 'Stream' : 'Request'} ${id}` });

        try {
            const modelName = this.extractModelName(path);

            // 【关键步骤】全能参数清洗：snake_case -> camelCase
            // 【关键】不再需要 cleanGenerationConfig，直接对整个 body 做清洗
            // 我们只分离出 contents，剩下的所有参数都扔给 toCamelCaseRecursive
            const { contents, ...restOfBody } = body;
            console.log(body);

            const normalizedContents = this.normalizeContents(contents);

            const normalizedConfigItems = this.toCamelCaseRecursive(restOfBody);
            //【新增】类型校准 (防御性编程)
            // 这一步确保了 tools 和 safetySettings 永远是数组
            const sanitizedConfigItems = this.sanitizeSdkConfig(normalizedConfigItems);

            // 从转换后的配置项中，提取出 generationConfig，剩下的就是 tools, safetySettings 等
            const { generationConfig, ...otherConfigs } = sanitizedConfigItems;

            // 将 generationConfig 里的属性 与其他配置项 合并成一个大的 config 对象
            const finalConfig = {
                ...(generationConfig || {}), // 展开 temperature, maxOutputTokens 等
                ...otherConfigs              // 展开 tools, safetySettings 等
            };


            // 重新组装成 SDK 需要的参数对象
            const sdkParams = {
                model: modelName,
                contents: normalizedContents,
                config: finalConfig // 所有配置项都在这里！
            };
            console.log(sdkParams);

            if (isStreaming) {
                await this.processStream(id, sdkParams);
            } else {
                const result = await this.generateContent(sdkParams);
                this.sendMessage({ id, success: true, payload: result });
            }

            console.log(`Task [${id}] Completed.`);
        } catch (error: any) {
            console.error(`Task [${id}] Failed:`, error.message);
            this.sendMessage({ id, success: false, error: error.message || 'Applet Error' });
        }
    }

    // --- 【终极修正】Embedding 请求处理器 (原生SDK兼容版) ---
    private async handleEmbedRequest(message: any, isBatch: boolean) {
        const { id, path, body } = message;
        const modelName = this.extractModelName(path);
      
        console.log(`Processing Task [${id}] (Batch: ${isBatch})...`);
        this.messages$.next({ type: 'info', text: `Processing ${isBatch ? 'BatchEmbed' : 'Embed'} ${id}` });
        console.log(body);
        
        try {
            let result;
            if (isBatch) {
                // --- 批量嵌入 (Batch Embedding) ---
                // REST API body: { requests: [{ content: { parts: [{ text: "..." }] } }, ...] }
                // JS SDK 需要: embedContent({ model, contents: ["...", "...", ...] })
                
                if (!body.requests || !Array.isArray(body.requests)) {
                    throw new Error("Invalid batch embed request: 'requests' field missing or not an array.");
                }

                // 【核心修复】从 REST 格式中提取所有文本，放入一个字符串数组
                const textsToEmbed: string[] = body.requests.map((req: any) => {
                    return req?.content?.parts?.[0]?.text || '';
                }).filter((text: string) => text); // 过滤掉空字符串

                if (textsToEmbed.length === 0) {
                    throw new Error("Batch embed request contains no text to process.");
                }

                // 【关键】调用一次 embedContent，传入字符串数组
                result = await this.ai.models.embedContent({
                    model: modelName,
                    contents: textsToEmbed
                });
                
                // SDK 返回的已经是 { embeddings: [...] } 格式，与 REST 批量接口一致

            } else {
                // --- 单个嵌入 (Non-batch) ---
                // REST API body: { content: { parts: [{ text: "..." }] } }
                // JS SDK 需要: embedContent({ model, contents: ["..."] })
                
                const textToEmbed = body?.content?.parts?.[0]?.text;
                if (typeof textToEmbed !== 'string') {
                    throw new Error("Invalid embed request: text content is missing.");
                }

                // 【关键】调用一次 embedContent，传入包含单个字符串的数组
                result = await this.ai.models.embedContent({
                    model: modelName,
                    contents: [textToEmbed]
                });
                
                // SDK 返回的是 { embedding: {...} }，与 REST 单个接口一致
            }
            
            // 原生透传
            this.sendMessage({ 
                id, 
                success: true, 
                payload: JSON.parse(JSON.stringify(result)) 
            });

            console.log(`Task [${id}] Completed.`);

        } catch (error: any) {
          console.error(`Task [${id}] Failed:`, error.message);
            this.sendMessage({ id, success: false, error: error.message });
        }
    }


    // --- 【核心升级】流式缓冲处理器 (原生对象透传版) ---
    private async processStream(id: string, sdkParams: any) {
        try {
            const response = await this.ai.models.generateContentStream(sdkParams);

            // 兼容性处理
            let streamIterable = (response as any).stream;
            if (!streamIterable && (response as any)[Symbol.asyncIterator]) {
                streamIterable = response;
            }
            if (!streamIterable) throw new Error('SDK returned non-stream response.');

            // 【修改】不再存字符串，而是存对象数组
            let bufferedChunks: any[] = [];
            let lastEmitTime = Date.now();

            for await (const chunk of streamIterable) {
                // 【关键】序列化清洗：将 SDK 的类实例转为纯 JSON 对象
                // 这保留了 candidates, usageMetadata, safetyRatings 等所有字段
                const cleanChunk = JSON.parse(JSON.stringify(chunk));

                // 过滤掉无用的 SDK 内部字段 (可选)
                if (cleanChunk.sdkHttpResponse) delete cleanChunk.sdkHttpResponse;

                bufferedChunks.push(cleanChunk);

                const now = Date.now();
                // 【大坝开闸】每 bufferInterval 发送一次对象数组
                // 【关键修改】使用 this.bufferInterval() 获取动态值
                // 如果设为 0，则每次都发送 (原生体验)
                const threshold = this.bufferInterval();

                if (now - lastEmitTime >= threshold) {
                    if (bufferedChunks.length > 0) {
                        this.sendStreamBatch(id, bufferedChunks);
                        bufferedChunks = [];
                    }
                    lastEmitTime = now;
                }
            }

            // 发送剩余的 chunks
            if (bufferedChunks.length > 0) {
                this.sendStreamBatch(id, bufferedChunks);
            }

            this.sendMessage({ id, stream: true, done: true });

        } catch (e: any) {
            console.error('Stream Error:', e);
            this.sendMessage({ id, stream: true, error: e.message, done: true });
        }
    }

    // 【新增】批量发送辅助函数
    private sendStreamBatch(id: string, chunks: any[]) {
        this.sendMessage({
            id,
            stream: true,
            type: 'batch', // 标记为批量数据
            chunks: chunks // 发送对象数组
        });
    }

    // 递归将 snake_case 转换为 camelCase
    private toCamelCaseRecursive(obj: any): any {
        if (Array.isArray(obj)) {
            return obj.map(v => this.toCamelCaseRecursive(v));
        }
        if (obj !== null && typeof obj === 'object') {
            return Object.keys(obj).reduce((result, key) => {
                // 转换 Key: stop_sequences -> stopSequences
                const camelKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
                result[camelKey] = this.toCamelCaseRecursive(obj[key]);
                return result;
            }, {} as any);
        }
        return obj;
    }

    // 普通生成 (非流式)
    async generateContent(sdkParams: any): Promise<any> {
        const response = await this.ai.models.generateContent(sdkParams);
        const plainResponse = JSON.parse(JSON.stringify(response));
        if (plainResponse.sdkHttpResponse) delete plainResponse.sdkHttpResponse;
        return plainResponse;
    }

    async listModels(): Promise<any> {
        try {
            // SDK 的 list() 返回的是一个 AsyncIterable (异步迭代器)
            const response = await this.ai.models.list();
            const models = [];

            // 我们必须遍历它，把每个模型数据单独取出来
            // 这样 SDK 会自动处理分页，并给我们纯净的数据对象
            for await (const model of response) {
                // 再次做一次 JSON 清洗，确保没有 SDK 的隐藏属性
                models.push(JSON.parse(JSON.stringify(model)));
            }

            // 构造成标准的 { "models": [...] } 格式返回
            return { models };

        } catch (e: any) {
            console.error('List Models Error:', e);
            throw new Error(`Failed to list models: ${e.message}`);
        }
    }

    // --- 基础设施保持不变 ---

    private handleClose() {
        this.socket$ = null;
        if (this.isExpectedDisconnect) {
            this.connectionStatus.set('disconnected');
        } else {
            this.connectionStatus.set('connecting');
            this.clearReconnectTimer();
            this.reconnectTimer = setTimeout(() => this.initSocket(), this.RECONNECT_DELAY);
        }
    }

    private clearReconnectTimer() {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    }

    sendMessage(message: any): void {
        if (this.socket$) this.socket$.next(message);
    }

    disconnect(): void {
        this.isExpectedDisconnect = true;
        this.clearReconnectTimer();
        this.destroySocket$.next();
        if (this.socket$) { this.socket$.complete(); this.socket$ = null; }
        this.connectionStatus.set('disconnected');
    }

    private async requestWakeLock() {
        try { if ('wakeLock' in navigator) await (navigator as any).wakeLock.request('screen'); } catch (e) { }
    }

    private extractModelName(path: string): string {
        const match = path.match(/models\/([^/:]+)/);
        return match && match[1] ? match[1] : 'gemini-1.5-flash';
    }

    private normalizeError(error: any): string {
        if (error instanceof Error) return error.message;
        return 'Unknown Error';
    }

    private normalizeContents(contents: any[]): any[] {
        if (!Array.isArray(contents)) return [];
        return contents.map(content => {
            if (!content.parts || !Array.isArray(content.parts)) return content;
            const newParts = content.parts.map((part: any) => {
                // 处理 REST 风格的 inline_data
                if (part.inline_data) {
                    return {
                        inlineData: {
                            mimeType: part.inline_data.mime_type || part.inline_data.mimeType,
                            data: part.inline_data.data
                        }
                    };
                }
                // 确保 inlineData 内部也是驼峰
                if (part.inlineData) {
                    if (part.inlineData.mime_type && !part.inlineData.mimeType) {
                        part.inlineData.mimeType = part.inlineData.mime_type;
                        delete part.inlineData.mime_type;
                    }
                    return part;
                }
                return part;
            });
            return { ...content, parts: newParts };
        });
    }

    // 【增强】协议校准官：递归强制修正数据类型
    private sanitizeSdkConfig(config: any): any {
        if (!config || typeof config !== 'object') return config;

        // 创建深度副本以避免修改原始对象
        const sanitized = JSON.parse(JSON.stringify(config));

        // 定义配置
        const arrayKeys = ['tools', 'safetySettings', 'responseModalities'];
        const upperCaseKeys = ['responseModalities']; // 可以扩展其他需要大写的字段

        // 递归处理所有嵌套对象
        this.recursiveSanitize(sanitized, arrayKeys, upperCaseKeys);

        return sanitized;
    }

    // 递归清洗函数
    private recursiveSanitize(obj: any, arrayKeys: string[], upperCaseKeys: string[]): void {
        if (!obj || typeof obj !== 'object') return;

        // 处理数组
        if (Array.isArray(obj)) {
            obj.forEach((item, index) => {
                if (typeof item === 'string' && upperCaseKeys.some(key => this.isFieldInPath(key))) {
                    // 如果当前在需要大写的字段路径中，且元素是字符串，则大写
                    obj[index] = item.toUpperCase();
                } else if (typeof item === 'object') {
                    this.recursiveSanitize(item, arrayKeys, upperCaseKeys);
                }
            });
            return;
        }

        // 处理对象的每个属性
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const value = obj[key];

                // 递归处理嵌套对象
                if (value && typeof value === 'object') {
                    this.recursiveSanitize(value, arrayKeys, upperCaseKeys);
                }

                // 处理需要强制为数组的字段
                if (arrayKeys.includes(key) && value !== undefined && value !== null) {
                    if (!Array.isArray(value)) {
                        console.warn(`[Sanitizer] Correcting non-array '${key}' field from a non-compliant client.`);
                        obj[key] = [value];
                    }
                }

                // 处理需要大写的字段
                if (upperCaseKeys.includes(key)) {
                    if (typeof value === 'string') {
                        obj[key] = value.toUpperCase();
                    } else if (Array.isArray(value)) {
                        obj[key] = value.map(item =>
                            typeof item === 'string' ? item.toUpperCase() : item
                        );
                    }
                }
            }
        }
    }

    // 辅助方法：检查字段是否在当前路径中（简化实现）
    private isFieldInPath(field: string): boolean {
        // 这里可以扩展为更复杂的路径匹配逻辑
        // 当前简化实现假设我们关心所有路径中的该字段
        return true;
    }
}