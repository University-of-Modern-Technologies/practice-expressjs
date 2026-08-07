import {
  CLASSIFY_INQUIRY_TASK,
  SUMMARIZE_DEAL_TASK,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
} from './prompts.js';
import type { AiProvider } from './provider.js';
import { inquiryCategories, type InquiryCategory } from './types.js';

/**
 * The default provider: deterministic, offline, no API key, no cost.
 *
 * It exists so the feature is complete on a fresh checkout — routes answer,
 * tests run, the UI has something to render — without anybody signing up for a
 * model vendor. It is a *stand-in*, not a model: it templates an answer from the
 * prompt it is given, and it is intentionally obvious about it.
 */
const KEYWORDS: ReadonlyArray<readonly [InquiryCategory, readonly string[]]> = [
  ['billing', ['invoice', 'payment', 'refund', 'charge', 'billing', 'price']],
  ['shipping', ['delivery', 'shipment', 'parcel', 'tracking', 'courier', 'shipping']],
  ['technical_support', ['error', 'bug', 'crash', 'login', 'broken', 'not working']],
  ['complaint', ['complaint', 'unacceptable', 'angry', 'terrible', 'disappointed']],
  ['sales', ['quote', 'demo', 'pricing plan', 'buy', 'purchase', 'upgrade']],
];

const untrustedBlock = (prompt: string): string => {
  const start = prompt.indexOf(UNTRUSTED_OPEN);
  const end = prompt.indexOf(UNTRUSTED_CLOSE);
  if (start === -1 || end === -1 || end < start) return '';
  return prompt.slice(start + UNTRUSTED_OPEN.length, end).trim();
};

const classify = (prompt: string): string => {
  // Only the untrusted block is inspected, and only for keywords. Even the mock
  // treats that text as data it reads, never as instructions it obeys.
  const haystack = untrustedBlock(prompt).toLowerCase();

  for (const [category, keywords] of KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      return JSON.stringify({ category, confidence: 0.72 });
    }
  }

  return JSON.stringify({ category: 'other' satisfies InquiryCategory, confidence: 0.4 });
};

const summarise = (prompt: string): string => {
  const facts = prompt
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes(': ') && !line.startsWith(UNTRUSTED_OPEN));

  const title = facts.find((line) => line.startsWith('Title: '))?.slice('Title: '.length) ?? 'Deal';
  const details = facts.filter((line) => !line.startsWith('Title: ')).join('; ');

  return details.length === 0
    ? `${title}: no further details were provided.`
    : `${title}. Current state — ${details}. Generated offline without a language model.`;
};

export const MOCK_AI_PROVIDER_NAME = 'mock';

export const createMockAiProvider = (): AiProvider => ({
  name: MOCK_AI_PROVIDER_NAME,
  complete({ system, prompt, maxTokens }) {
    const text = system.includes(CLASSIFY_INQUIRY_TASK)
      ? classify(prompt)
      : system.includes(SUMMARIZE_DEAL_TASK)
        ? summarise(prompt)
        : 'No offline template is available for this task.';

    // A crude but honest stand-in for the token budget: four characters per
    // token is the usual rule of thumb, so callers still see truncation.
    return Promise.resolve(text.slice(0, Math.max(1, maxTokens * 4)));
  },
});

/** Exposed so tests can assert the closed list has not silently drifted. */
export const mockKnownCategories: readonly InquiryCategory[] = inquiryCategories;
