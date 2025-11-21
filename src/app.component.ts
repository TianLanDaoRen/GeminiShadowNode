import { Component, ChangeDetectionStrategy, signal, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GeminiService } from './services/gemini.service';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly proxyService = inject(GeminiService);
  private readonly destroy$ = new Subject<void>();

  // 默认连接地址
  relayUrl = signal<string>('wss://your-site/ws'); 
  
  // 日志仅保留最新的 50 条，防止 DOM 节点过多消耗内存
  logs = signal<string[]>([]);
  
  connectionStatus = this.proxyService.connectionStatus;
  nodeCount = this.proxyService.nodeCount;

  constructor() {
    // 监听 Service 发来的精简消息
    this.proxyService.messages$
      .pipe(takeUntil(this.destroy$))
      .subscribe((msg: any) => {
        // 这里的 msg 已经是 Service 优化过的 { type: 'info', text: '...' }
        // 绝对不包含大体积数据
        if (msg.text) {
          this.addLog(msg.text);
        } else if (msg.error) {
          this.addLog(`Error: ${msg.error}`);
        }
      });
  }

  ngOnInit() {
    // 自动连接 (可选：为了无人值守，建议初始化即连接)
    this.connect();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.proxyService.disconnect();
  }

  connect(): void {
    const url = this.relayUrl();
    if (!url) return;
    
    // 防止重复点击
    if (this.connectionStatus() === 'connected' || this.connectionStatus() === 'connecting') return;

    this.addLog(`Connecting to system...`);
    this.proxyService.connect(url);
  }

  disconnect(): void {
    this.proxyService.disconnect();
    this.addLog('Disconnected manually.');
  }

  updateRelayUrl(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.relayUrl.set(target.value);
  }

  /**
   * 极简日志记录
   * 移除了所有 JSON.stringify 逻辑，防止内存爆破
   */
  private addLog(message: string): void {
    const time = new Date().toLocaleTimeString();
    const newLog = `[${time}] ${message}`;
    
    this.logs.update(currentLogs => {
      // 内存优化：只保留最新的 50 条日志
      // 之前的 100 条可能在 DOM 中积压过多
      const newHistory = [newLog, ...currentLogs];
      return newHistory.slice(0, 50);
    });
  }
}