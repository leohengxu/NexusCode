/**
 * OpenCode Zen 配置 — 通过 LangChain ChatOpenAI 调用
 *
 * 环境变量:
 *   OPENCODE_API_KEY   - OpenCode Zen API Key (https://opencode.ai/auth)
 *   OPENCODE_BASE_URL   - API 端点 (默认 https://opencode.ai/zen/v1)
 *   OPENCODE_MODEL      - 模型 ID (如 deepseek-v4-flash-free)
 *   LLM_TEMPERATURE     - 温度，默认 0.3
 *   LLM_MAX_TOKENS      - 每次生成最大 token，默认 8000
 */

export interface OpencodeConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/**
 * 加载配置。
 *
 * @param strict true（默认）：缺 apiKey/model 时抛错，用于真正调用 LLM 前的校验。
 *               false：缺失项以空字符串占位返回，不抛错 —— 供 onModuleInit / 构造函数
 *               等初始化期使用，避免缺配置导致整个 Nest 应用启动失败（改为运行期报错）。
 */
export function loadOpencodeConfig(strict = true): OpencodeConfig {
  const apiKey = process.env.OPENCODE_API_KEY;
  const model = process.env.OPENCODE_MODEL;

  if (strict) {
    if (!apiKey) {
      throw new Error(
        '缺少环境变量: OPENCODE_API_KEY\n' +
        '请访问 https://opencode.ai/auth 登录获取 API Key',
      );
    }
    if (!model) {
      throw new Error('缺少环境变量: OPENCODE_MODEL');
    }
  }

  return {
    apiKey: apiKey || '',
    baseURL: process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/v1',
    model: model || '',
    temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.3'),
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '8000', 10),
  };
}

/** 是否已配置好可用于调用 LLM 的凭据与模型 */
export function isOpencodeConfigured(): boolean {
  return !!process.env.OPENCODE_API_KEY && !!process.env.OPENCODE_MODEL;
}
