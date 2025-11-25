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
  private destroySocket$ = new Subject<void>();
  private currentUrl: string = '';
  
  connectionStatus = signal<ConnectionStatus>('disconnected');
  messages$ = new Subject<any>();
  nodeCount = signal<number>(0);
  
  private isExpectedDisconnect = false; 
  private reconnectTimer: any = null;
  private readonly RECONNECT_DELAY = 3000;
  
  // 【新特性】流式缓冲配置：每 500ms 发送一次，平衡体验与负载
  private readonly STREAM_BUFFER_INTERVAL = 500; 
  // 【新增】流式缓冲间隔信号 (默认 500ms)
  bufferInterval = signal<number>(500);

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

  private async handleIncomingMessage(message: any) {
    if (message === 'ping' || message.type === 'ping') return;

    if (message && message.type === 'cluster_sync') {
        this.nodeCount.set(message.count);
        return;
    }

    if (message && message.id && message.path) {
      // 1. 处理 GET Models
      if (message.method === 'GET' && message.path.includes('/models')) {
          this.handleListModels(message.id);
          return;
      }

      // 2. 处理生成请求 (POST)
      if (message.body) {
          this.handleGenerateRequest(message);
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
          // 这样就不用担心 inline_data 或 stop_sequences 报错了
          const cleanBody = this.normalizeRequestBody(body);

          if (isStreaming) {
              // 【新特性】进入流式处理模式
              await this.processStream(id, modelName, cleanBody);
          } else {
              // 原有普通模式
              const result = await this.generateContent(modelName, cleanBody);
              this.sendMessage({ id, success: true, payload: result });
          }
          
          console.log(`Task [${id}] Completed.`);
      } catch (error: any) {
          console.error(`Task [${id}] Failed:`, error.message);
          this.sendMessage({ id, success: false, error: error.message || 'Applet Error' });
      }
  }

  // --- 【核心升级】流式缓冲处理器 (原生对象透传版) ---
  private async processStream(id: string, model: string, body: any) {
      try {
          const response = await this.ai.models.generateContentStream({
              model: model,
              contents: body.contents,
              config: body.generationConfig
          });

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

  // 【新增】手动从 Chunk 对象中提取文本
  private extractTextFromChunk(chunk: any): string {
      // 结构通常是: chunk.candidates[0].content.parts[0].text
      try {
          const candidate = chunk.candidates?.[0];
          const parts = candidate?.content?.parts;
          
          if (parts && Array.isArray(parts)) {
              // 把所有 part 的 text 拼起来 (通常只有一个)
              return parts.map((p: any) => p.text || '').join('');
          }
      } catch (e) {
          // 忽略解析错误，防止中断流
      }
      return '';
  }

  // 发送流式片段的辅助函数
  private sendStreamChunk(id: string, text: string) {
      // 定义流式协议格式：type: 'chunk'
      this.sendMessage({
          id,
          stream: true,
          type: 'chunk',
          content: text
      });
  }

  // --- 【核心升级】全能参数清洗器 ---
  private normalizeRequestBody(body: any): any {
      // 1. 先处理 contents 里的 inlineData (因为这个最特殊)
      if (body.contents) {
          body.contents = this.normalizeContents(body.contents);
      }

      // 2. 递归转换 Config 和 Tools 的 Key 为驼峰
      // 我们只转换配置项，保留 contents 不动（因为已经单独处理了）
      const { contents, ...rest } = body;
      const camelRest = this.toCamelCaseRecursive(rest);

      return {
          contents,
          ...camelRest
      };
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
  async generateContent(model: string, body: any): Promise<any> {
      const response = await this.ai.models.generateContent({
          model: model,
          contents: body.contents,
          config: body.generationConfig // 此时已经是驼峰了
      });
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
    try { if ('wakeLock' in navigator) await (navigator as any).wakeLock.request('screen'); } catch (e) {}
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
}