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
  
  // 【优化 1】UI 消息流：仅保留简短的系统通知，不再传输大数据，防止 UI 卡死
  messages$ = new Subject<any>();
  // 1. 在类中新增一个 Signal
  nodeCount = signal<number>(0); // 默认为 0
  
  private isExpectedDisconnect = false; 
  private reconnectTimer: any = null;
  private readonly RECONNECT_DELAY = 3000;

  constructor() {
    const apiKey = process.env['API_KEY'];
    if (!apiKey) {
      throw new Error('API_KEY is not set.');
    }
    this.ai = new GoogleGenAI({ apiKey });
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
    // 【优化 2】减少控制台噪音
    console.log(`[System] Connecting to relay...`);

    try {
      this.socket$ = webSocket({
        url: this.currentUrl,
        openObserver: {
          next: () => {
            console.log('[System] Connected');
            this.connectionStatus.set('connected');
            // 连接成功后申请 Wake Lock (防止休眠)
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
          // 不再向 UI 发送详细错误对象，防止渲染开销
          this.messages$.next({ type: 'error', text: 'Connection Error' });
          return EMPTY;
        })
      ).subscribe({
        next: (msg) => this.handleIncomingMessage(msg), // 核心处理逻辑
        error: (err) => console.error(err)
      });
      
    } catch (e) {
      console.error('Init Error:', e);
      this.handleClose(); 
    }
  }

  // --- 核心业务逻辑优化 ---
  private async handleIncomingMessage(message: any) {
    // 忽略心跳包
    if (message === 'ping' || message.type === 'ping') return;

    // 【新增】处理集群同步消息
    if (message && message.type === 'cluster_sync') {
        console.log(`[System] Cluster Sync: ${message.count} nodes active`);
        this.nodeCount.set(message.count);
        return; // 系统消息不作为任务处理
    }

    if (message && message.id && message.path && message.body) {
      // 【优化 3】绝对不要打印 message.body！如果是视频，这行 log 会直接撑爆内存
      console.log(`Processing Task [${message.id}]...`); 
      
      // 通知 UI 正在处理，但不带数据
      this.messages$.next({ type: 'info', text: `Processing request ${message.id}` });
      
      try {
        const modelName = this.extractModelName(message.path);
        
        // 执行调用
        const result = await this.proxyRequest(modelName, message.body);

        // 发送成功响应
        this.sendMessage({
          id: message.id,
          success: true,
          payload: result
        });
        
        console.log(`Task [${message.id}] Completed.`);
        
        // 【优化 4】手动释放大对象引用（虽然 JS 有 GC，但显式置空有助于低内存环境）
        // 这里的 result 和 message.body 在函数结束后理应被回收，
        // 但在闭包繁重的 Angular 中，保持函数短小精悍很重要。

      } catch (error: any) {
        console.error(`Task [${message.id}] Failed:`, error.message);
        
        this.sendMessage({
          id: message.id,
          success: false,
          error: error.message || 'Applet Error'
        });
      }
    }
  }

  private handleClose() {
    this.socket$ = null;
    if (this.isExpectedDisconnect) {
      this.connectionStatus.set('disconnected');
    } else {
      this.connectionStatus.set('connecting');
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        this.initSocket(); 
      }, this.RECONNECT_DELAY);
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  sendMessage(message: any): void {
    if (this.socket$) {
      this.socket$.next(message);
    }
  }

  disconnect(): void {
    this.isExpectedDisconnect = true;
    this.clearReconnectTimer();
    this.destroySocket$.next();
    if (this.socket$) {
      this.socket$.complete();
      this.socket$ = null;
    }
    this.connectionStatus.set('disconnected');
  }

  // --- 唤醒锁 (防止 VPS 浏览器休眠) ---
  private async requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        await (navigator as any).wakeLock.request('screen');
        // console.log('Wake Lock active'); // 减少日志
      }
    } catch (e) {}
  }

  // --- Helpers ---
  private extractModelName(path: string): string {
    const match = path.match(/models\/([^/:]+)/);
    return match && match[1] ? match[1] : 'gemini-1.5-flash';
  }

  private normalizeError(error: any): string {
    if (error instanceof Error) return error.message;
    return 'Unknown Error';
  }

  // --- Gemini API Method (修复图片支持) ---
  async proxyRequest(model: string, rawBody: any): Promise<any> {
    try {
      let { contents, generationConfig, safetySettings, systemInstruction, tools, toolConfig } = rawBody;

      // 【关键修复 1】清洗 contents，适配图片格式
      // 将 REST API 的 inline_data 转换为 SDK 需要的 inlineData
      contents = this.normalizeContents(contents);

      // 清理 Config
      const sanitizedConfig = this.cleanGenerationConfig(generationConfig);

      const config: any = {
        ...sanitizedConfig,
        safetySettings,
        systemInstruction,
        tools,
        toolConfig
      };

      // 移除 undefined 键
      Object.keys(config).forEach(key => config[key] === undefined && delete config[key]);
      
      // 调用 SDK
      const response = await this.ai.models.generateContent({
        model: model,
        contents: contents,
        config: config
      });
      
      // 序列化响应
      const plainResponse = JSON.parse(JSON.stringify(response));
      if (plainResponse.sdkHttpResponse) delete plainResponse.sdkHttpResponse;
      
      return plainResponse;

    } catch (error: any) {
      console.error('Gemini API Fail:', error.message);
      throw new Error(error.message);
    }
  }

  // 【新增辅助方法】格式标准化
  private normalizeContents(contents: any[]): any[] {
    if (!Array.isArray(contents)) return [];

    return contents.map(content => {
      // 确保 parts 存在
      if (!content.parts || !Array.isArray(content.parts)) return content;

      const newParts = content.parts.map((part: any) => {
        // 检查是否是 REST 风格的图片数据 (inline_data)
        if (part.inline_data) {
          return {
            inlineData: {
              mimeType: part.inline_data.mime_type || part.inline_data.mimeType,
              data: part.inline_data.data
            }
          };
        }
        // 如果已经是 inlineData，确保内部字段也是驼峰
        if (part.inlineData) {
           // SDK 有时比较宽容，但为了保险，检查 mime_type
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

  private cleanGenerationConfig(config: any): any {
    if (!config || typeof config !== 'object') return {};
    // 仅保留核心参数，移除不必要的对象
    const allowedKeys = [
      'candidateCount', 'stopSequences', 'maxOutputTokens', 'temperature',
      'topP', 'topK', 'responseMimeType', 'responseSchema', 'presencePenalty',
      'frequencyPenalty', 'responseLogprobs', 'logprobs', 'thinkingConfig',
      'seed', 'speechConfig', 'audioTimestamp'
    ];
    const cleaned: any = {};
    for (const key of allowedKeys) {
      if (key in config) cleaned[key] = config[key];
    }
    return cleaned;
  }
}