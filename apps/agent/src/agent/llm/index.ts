import { config } from '../../config.js';
import type { LLMProvider } from './provider.js';
import { getGeminiProvider } from './gemini.js';

export function getLLM(): LLMProvider {
  switch (config.LLM_PROVIDER) {
    case 'gemini':
      return getGeminiProvider();
    case 'anthropic':
      throw new Error('Anthropic provider not yet implemented');
    default: {
      const _exhaustive: never = config.LLM_PROVIDER;
      throw new Error(`Unknown LLM provider: ${String(_exhaustive)}`);
    }
  }
}

export * from './provider.js';
