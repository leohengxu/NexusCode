/**
 * OpenCode SDK Proxy — 薄封装层
 *
 * 职责：
 *  1. 用不会被 TS 降级成 require() 的方式加载 ESM-only 的 @opencode-ai/sdk
 *  2. 管理 OpenCode Server 生命周期（启动/关闭）
 *  3. 暴露统一的 prompt() 接口
 *
 * LLM 调用经 opencode serve 走 session.prompt。
 * 为防止 agent(build) 模式触发 shell/skill 工具循环导致极慢/卡死，
 * 传入 agent="general" 轻量模式，并禁用所有 tools，强制纯文本 chat 行为。
 */

import { Logger } from '@nestjs/common';
import fetch from 'node-fetch';

// ── ESM bridge ──
const dynamicEsmImport: (specifier: string) => Promise<any> =
  new Function('specifier', 'return import(specifier)') as any;

// ── 类型 ──
export interface SdkServer {
  url: string;
  close(): void;
}

export interface PromptOptions {
  system: string;
  user: string;
  providerID: string;
  modelID: string;
  temperature?: number;
  maxTokens?: number;
}

export interface PromptResult {
  text: string;
  sessionId: string;
}

// ── Proxy Service ──
let cachedSdk: any = null;
const logger = new Logger('OpencodeProxy');

// ═══════════════════════ Server ═══════════════════════

export async function startServer(providerCfg: Record<string, unknown>): Promise<SdkServer> {
  const sdk = await loadSdk();
  logger.log('[Proxy] 正在启动 opencode serve...');
  const server = await sdk.createOpencodeServer({
    hostname: '127.0.0.1',
    port: 0,
    config: providerCfg,
    timeout: 30000,
  });
  logger.log(`[Proxy] Server 已启动: ${server.url}`);
  return { url: server.url, close: () => server.close() };
}

export function createClient(baseUrl: string): any {
  if (!cachedSdk) throw new Error('SDK 尚未加载，请先调用 startServer()');
  return cachedSdk.createOpencodeClient({ baseUrl });
}

// ═══════════════════════ Prompt ═══════════════════════

// 禁用的工具列表：阻止 build agent 跑 shell/bash/skill 等工具循环
const ALL_TOOLS_DISABLED: Record<string, boolean> = {
  bash: false, edit: false, write: false, read: false, glob: false,
  grep: false, list: false, patch: false, todowrite: false, todoread: false,
  webfetch: false, task: false,
};

/**
 * 通过 session.prompt 发送一次对话。
 * - agent="general" 避免 build 模式的完整工具链
 * - tools=all_disabled 进一步禁止工具调用
 * - noReply=false 保持正常响应
 */
export async function prompt(
  client: any,
  opts: PromptOptions,
  _onThinking?: (step: any) => void,
): Promise<PromptResult> {
  const startTime = Date.now();
  logger.log(
    `[Proxy] prompt → ${opts.providerID}/${opts.modelID} ` +
    `system=${opts.system.length}chars user=${opts.user.length}chars`,
  );

  // 1. 创建 Session
  const sessionRes = await withTimeout<any>(
    client.session.create({ body: { title: `Chat_${Date.now()}` } }),
    30000,
    'session.create',
  );
  const sessionId: string = sessionRes?.data?.id;
  if (!sessionId) throw new Error('Session 创建失败');

  try {
    // 2. 发送 prompt — agent="general" + tools disabled = 纯 chat
    const promptTimeoutMs = (opts.maxTokens && opts.maxTokens > 8000) ? 300000 : 180000;
    const promptRes = await withTimeout<any>(
      client.session.prompt({
        path: { id: sessionId },
        body: {
          system: opts.system,
          agent: 'general',
          parts: [{ type: 'text', text: opts.user }],
          model: { providerID: opts.providerID, modelID: opts.modelID },
          tools: ALL_TOOLS_DISABLED,
        },
      }),
      promptTimeoutMs,
      'session.prompt',
    );

    // 3. 提取文本
    const parts: any[] = promptRes?.data?.parts || [];
    const text = parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');

    if (!text || text.trim().length < 10) {
      throw new Error('SDK prompt 返回内容为空');
    }

    const duration = Date.now() - startTime;
    logger.log(`[Proxy] ✅ prompt 返回 ${text.length} chars，耗时 ${duration}ms`);
    return { text, sessionId };
  } finally {
    // 4. 清理 Session
    client.session.delete({ path: { id: sessionId } }).catch(() => {});
  }
}

// ═══════════════════════ 辅助 ═══════════════════════

async function loadSdk(): Promise<any> {
  if (cachedSdk) return cachedSdk;
  logger.log('[Proxy] 通过 ESM dynamic import 加载 @opencode-ai/sdk...');
  cachedSdk = await dynamicEsmImport('@opencode-ai/sdk');
  return cachedSdk;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function listProviders(client: any): Promise<string[]> {
  try {
    const res = await client.config.providers();
    if (res?.data && Array.isArray(res.data)) {
      return res.data.map((p: any) => p.id);
    }
  } catch { /* ok */ }
  return [];
}
