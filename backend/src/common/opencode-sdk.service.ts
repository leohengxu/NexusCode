/**
 * OpenCode SDK 封装服务
 *
 * 使用 @opencode-ai/sdk 替代 LangChain ChatOpenAI 作为所有 Agent 的执行引擎。
 * SDK 加载/启动/调用细节已移至 proxy.ts 集中管理，本文件聚焦于：
 *   - SDK → LangChain 回退策略
 *   - 配置解析（provider/model 映射）
 *   - 对上层 service 暴露统一的 prompt() 接口
 *   - SDK server 闲置暂停 & 自动唤醒
 *
 * 如果 SDK 初始化失败（如 opencode CLI 不可用），自动回退到 LangChain ChatOpenAI。
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { loadOpencodeConfig, OpencodeConfig } from '../modules/opencode/opencode.config';
import { withRetry } from './retry.util';
import {
  SdkServer,
  startServer,
  createClient,
  prompt as proxyPrompt,
  listProviders,
} from './proxy';

export interface PromptOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * 闲置超时（ms）：超过此时间无请求则 close SDK server 释放 ~500MB 内存。
 * 下次 prompt 时自动 relaunch。请求进行中不会暂停（由 activeRequests 保护）。
 * 设为 10 分钟：足够覆盖一次完整文档生成（5 步连续调用）之间的间隙，减少无谓 relaunch。
 */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

@Injectable()
export class OpencodeSdkService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpencodeSdkService.name);
  private sdkClient: any = null;
  private sdkServer: SdkServer | null = null;
  private useSdk = false;
  private modelConfig: { providerID: string; modelID: string } | null = null;

  // LangChain 回退
  private langchainConfig: OpencodeConfig | null = null;
  private fallbackLlm: ChatOpenAI | null = null;

  // ── 闲置暂停 ──
  private idleTimer: NodeJS.Timeout | null = null;
  private paused = false;
  private savedProviderConfig: Record<string, unknown> | null = null;
  // 正在进行的 prompt 数量。>0 时禁止暂停 server（否则会中断进行中的请求）。
  private activeRequests = 0;
  // 唤醒互斥锁：并发请求复用同一个唤醒 Promise，避免重复启动 server 子进程泄漏
  private wakePromise: Promise<void> | null = null;

  // ═══════════════════ 生命周期 ═══════════════════

  async onModuleInit() {
    const config = loadOpencodeConfig(false);
    if (!config.apiKey || !config.model) {
      this.logger.error(
        '[OpencodeSDK] 缺少 OPENCODE_API_KEY 或 OPENCODE_MODEL，LLM 调用将失败。' +
        '请在 backend/.env 中配置后重启。',
      );
    }

    this.langchainConfig = config;

    // 初始化 LangChain 回退客户端
    this.fallbackLlm = new ChatOpenAI({
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      configuration: {
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        timeout: 300000,
      },
    });

    await this.ensureServer();
  }

  /**
   * 应用退出时：取消 idle timer，close SDK server 子进程。
   */
  async onModuleDestroy() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.sdkServer) {
      try {
        this.sdkServer.close();
        this.logger.log('[OpencodeSDK] 🛑 SDK server 已关闭');
      } catch { /* ignore */ }
      this.sdkServer = null;
    }
    this.sdkClient = null;
    this.paused = true;
  }

  // ═══════════════════ Server 管理 ═══════════════════

  /**
   * 确保 SDK server 处于运行态。
   * - 首次调用 → 启动 server
   * - 闲置暂停后 → 自动 relaunch
   * - 已在运行 → 只重置 idle timer
   */
  private async ensureServer(): Promise<void> {
    if (this.useSdk && this.sdkServer && !this.paused) {
      this.resetIdleTimer();
      return;
    }

    if (this.paused) {
      this.logger.log('[OpencodeSDK] 🔄 闲置后重新激活 SDK server...');
      this.paused = false;
    }

    await this.tryInitSdk(this.langchainConfig!);
  }

  /**
   * 每次 prompt 调用后重置闲置倒计时。
   */
  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.suspendServer(), IDLE_TIMEOUT_MS);
  }

  /**
   * 暂停 SDK server（close 子进程释放内存），保留配置供后续 relaunch。
   * 若有正在进行的 prompt（activeRequests>0），不暂停并重排检查，
   * 避免中断进行中的请求导致 sdkClient=null 崩溃。
   */
  private suspendServer() {
    if (!this.sdkServer || this.paused) return;
    if (this.activeRequests > 0) {
      // 有请求在跑，推迟暂停
      this.resetIdleTimer();
      return;
    }
    this.logger.log('[OpencodeSDK] ⏸️  闲置超时，暂停 SDK server（下次请求自动唤醒）');
    this.paused = true;
    this.sdkClient = null;
    try { this.sdkServer.close(); } catch { /* ignore */ }
    this.sdkServer = null;
  }

  // ═══════════════════ 初始化 ═══════════════════

  /**
   * 通过 proxy.ts 启动 SDK server + client + 探测 providers
   */
  private async tryInitSdk(config: OpencodeConfig) {
    try {
      this.logger.log('[OpencodeSDK] 通过 proxy 启动 OpenCode Server...');

      const providerConfig = {
        provider: {
          zen: {
            npm: '@ai-sdk/openai-compatible',
            name: 'OpenCode Zen',
            options: {
              baseURL: config.baseURL,
              apiKey: config.apiKey,
            },
            models: {
              [config.model]: {
                name: config.model,
                limit: {
                  context: 131072,
                  output: 32768,
                },
              },
            },
          },
        },
      };

      this.savedProviderConfig = providerConfig;
      this.sdkServer = await startServer(providerConfig);
      this.sdkClient = createClient(this.sdkServer.url);

      const modelStr = config.model;
      if (modelStr.includes('/')) {
        const [providerID, modelID] = modelStr.split('/', 2);
        this.modelConfig = { providerID, modelID };
      } else {
        this.modelConfig = { providerID: 'zen', modelID: modelStr };
      }

      const providerIds = await listProviders(this.sdkClient);
      if (providerIds.length > 0) {
        this.logger.log(`[OpencodeSDK] 可用 providers: ${providerIds.join(', ')}`);
      }

      this.useSdk = true;
      this.paused = false;
      this.resetIdleTimer();
      this.logger.log(`[OpencodeSDK] ✅ SDK 已激活！Server: ${this.sdkServer.url}`);
      this.logger.log(`[OpencodeSDK] Provider/Model: ${this.modelConfig.providerID}/${this.modelConfig.modelID}`);
    } catch (e: any) {
      this.logger.warn(
        `[OpencodeSDK] ⚠️  SDK 启动失败，回退到 LangChain: ${e?.message}`,
      );
      this.useSdk = false;
      this.paused = true;
      if (this.sdkServer) {
        try { this.sdkServer.close(); } catch { /* ignore */ }
        this.sdkServer = null;
      }
      this.sdkClient = null;
    }
  }

  // ═══════════════════ Prompt ═══════════════════

  /**
   * 发送 prompt。
   * SDK 可用 → proxyPrompt（如果 server 暂停了自动唤醒）。
   * SDK 不可用 → LangChain 回退。
   */
  async prompt(
    systemPrompt: string,
    userMessage: string,
    options?: PromptOptions,
  ): Promise<string> {
    // 唤醒（若已暂停）：用互斥锁确保并发请求只唤醒一次，
    // 避免 ensureServer 被并发调用导致重复启动 server 子进程泄漏，
    // 以及部分请求因 sdkClient 尚未就绪而错误降级到 LangChain。
    if (this.paused && this.savedProviderConfig) {
      if (!this.wakePromise) {
        this.wakePromise = this.ensureServer().finally(() => {
          this.wakePromise = null;
        });
      }
      await this.wakePromise;
    }

    // 走 SDK：用 activeRequests 保护，防止请求进行中被 idle timer 暂停
    if (this.useSdk && this.sdkClient && this.modelConfig) {
      this.activeRequests++;
      if (this.idleTimer) clearTimeout(this.idleTimer); // 请求期间不计闲置
      try {
        return await this.promptViaSdk(systemPrompt, userMessage, options);
      } catch (sdkErr: any) {
        // SDK 运行期失败（非初始化失败）：自动回退到 LangChain，避免单次调用失败直接中断业务
        this.logger.warn(
          `[OpencodeSDK] SDK prompt 失败，回退到 LangChain: ${sdkErr?.message}`,
        );
        return await this.promptViaLangChain(systemPrompt, userMessage, options);
      } finally {
        this.activeRequests--;
        this.resetIdleTimer(); // 请求结束后重新开始闲置计时
      }
    }
    return this.promptViaLangChain(systemPrompt, userMessage, options);
  }

  /**
   * 通过 proxy.ts 的 SDK prompt（带重试）。
   * 每次读取 this.sdkClient 前确认非 null（防御暂停竞态），null 时抛错触发上层回退/失败。
   */
  private async promptViaSdk(
    systemPrompt: string,
    userMessage: string,
    options?: PromptOptions,
  ): Promise<string> {
    return withRetry(
      async () => {
        const client = this.sdkClient;
        if (!client) {
          throw new Error('SDK client 不可用（server 可能已暂停），返回内容为空');
        }
        const result = await proxyPrompt(client, {
          system: systemPrompt,
          user: userMessage,
          providerID: this.modelConfig!.providerID,
          modelID: this.modelConfig!.modelID,
          temperature: options?.temperature,
          maxTokens: options?.maxTokens,
        });
        return result.text;
      },
      { maxRetries: 2, baseDelay: 5000 },
    );
  }

  /**
   * LangChain 回退路径
   */
  private async promptViaLangChain(
    systemPrompt: string,
    userMessage: string,
    options?: PromptOptions,
  ): Promise<string> {
    const config = this.langchainConfig!;

    const llm = options?.temperature !== undefined || options?.maxTokens !== undefined
      ? new ChatOpenAI({
          model: config.model,
          temperature: options?.temperature ?? 0.3,
          maxTokens: options?.maxTokens ?? 8000,
          configuration: {
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            timeout: 300000,
          },
        })
      : this.fallbackLlm!;

    const messages = [new SystemMessage(systemPrompt), new HumanMessage(userMessage)];

    const response = await withRetry(
      () => llm.invoke(messages),
      { maxRetries: 2, baseDelay: 5000 },
    );

    const text = this.extractTextContent(response);
    this.logger.log(`[LangChain] 响应长度: ${text.length} chars`);
    return text;
  }

  /**
   * 从 AIMessage 中提取纯文本。
   */
  private extractTextContent(response: any): string {
    const content = response?.content;
    if (!content) return '';

    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
      return content
        .filter((block: any) => block.type === 'text' || block.type === 'text_delta')
        .map((block: any) => block.text || '')
        .join('');
    }

    return String(content);
  }

  /** 当前是否使用 SDK */
  isUsingSdk(): boolean {
    return this.useSdk;
  }
}
