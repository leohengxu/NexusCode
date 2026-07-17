/**
 * 通用重试工具 — 指数退避策略
 *
 * 对 LLM 调用等可能因网络/限流瞬时失败的操作进行自动重试。
 * 认证类错误 (401/403) 不重试，直接抛出。
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryableErrors?: string[];
}

// 可重试错误关键字。
// - 网络/限流类（timeout/429/ECONNRESET 等）：瞬时故障，重试有效。
// - 空返回类（返回内容为空/返回空响应）：LLM 偶发空响应，重试通常能恢复，故保留。
// 注意：不包含宽泛的 'empty'（会误伤任意含该词的错误），也不包含
// "未解析到任何代码文件"这类确定性格式错误——那类重试无意义，只会放大 3 倍成本。
const DEFAULT_RETRYABLE = ['timeout', 'ETIMEDOUT', '429', 'ECONNRESET', 'ECONNREFUSED', 'socket hang up', 'fetch failed', '返回内容为空', '返回空响应'];

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 2,
    baseDelay = 3000,
    maxDelay = 30000,
    retryableErrors = DEFAULT_RETRYABLE,
  } = options;

  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const msg = err?.message || String(err);

      // 认证错误不重试
      if (msg.includes('401') || msg.includes('403')) {
        throw err;
      }

      // 检查是否为可重试错误
      const isRetryable = retryableErrors.some(pattern => msg.toLowerCase().includes(pattern.toLowerCase()));
      if (!isRetryable) {
        throw err;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        // 加一点随机抖动避免雪崩
        const jitter = Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, delay + jitter));
      }
    }
  }

  throw lastError;
}
