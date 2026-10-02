import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// NVIDIA build.nvidia.com (OpenAI-compatible). Override the model with NVIDIA_MODEL.
const nvidia = createOpenAICompatible({
  name: 'nvidia',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: process.env.NVIDIA_API_KEY,
  supportsStructuredOutputs: true,
  // Live notes need answers in seconds: turn reasoning off (Nemotron & co.) or
  // down to the minimum (gpt-oss, which ignores the thinking switch).
  transformRequestBody: (body) => ({
    ...body,
    chat_template_kwargs: { enable_thinking: false },
    ...(String(body.model).includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
  }),
});

/**
 * 'live' = fast model for notes during the meeting; 'final' = the end-of-meeting
 * pass, where quality matters more than speed (NVIDIA_FINAL_MODEL, default Nemotron Super).
 */
export function getModel(kind: 'live' | 'final' = 'live') {
  if (process.env.NVIDIA_API_KEY) {
    const live = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
    return nvidia(kind === 'final' ? process.env.NVIDIA_FINAL_MODEL || 'nvidia/nemotron-3-super-120b-a12b' : live);
  }
  if (process.env.ANTHROPIC_API_KEY) return anthropic('claude-sonnet-5-5');
  return 'anthropic/claude-sonnet-5.5'; // Vercel AI Gateway (AI_GATEWAY_API_KEY or OIDC)
}

export function hasModelKey() {
  return !!(
    process.env.NVIDIA_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.AI_GATEWAY_API_KEY ||
    process.env.VERCEL_OIDC_TOKEN
  );
}

/** Swap any em/en dashes the model still produced for a plain hyphen. */
export function stripDashes<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/\s*[\u2014\u2013]\s*/g, ' - '));
}
