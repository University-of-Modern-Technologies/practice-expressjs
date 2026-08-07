import { createHash } from 'node:crypto';
import { z } from 'zod';

import { createNoopCacheService, type CacheService } from '../../cache/cache.service.js';
import { cacheKey } from '../../cache/keys.js';
import {
  dealSummaryPrompt,
  dealSummarySystemPrompt,
  inquiryClassificationPrompt,
  inquiryClassificationSystemPrompt,
} from './prompts.js';
import { aiInputTooLargeError, type AiProvider } from './provider.js';
import {
  DEFAULT_AI_CACHE_TTL_SECONDS,
  DEFAULT_AI_MAX_INPUT_CHARS,
  DEFAULT_AI_MAX_TOKENS,
  type AiConfig,
} from './provider-factory.js';
import {
  inquiryCategories,
  UNKNOWN_INQUIRY_CATEGORY,
  type DealSummaryDto,
  type DealSummaryInput,
  type InquiryClassificationDto,
  type InquiryClassificationInput,
  type ResolvedInquiryCategory,
} from './types.js';

export const AI_NAMESPACE = 'ai';

/**
 * The shape the classifier is asked to produce. The category is validated
 * against the closed list here — the single place where a model's free-form
 * answer becomes a value the rest of the system is allowed to act on.
 */
const classificationSchema = z.object({
  category: z.enum(inquiryCategories),
  confidence: z.number().min(0).max(1),
});

export interface AiService {
  summariseDeal(input: DealSummaryInput): Promise<DealSummaryDto>;
  classifyInquiry(input: InquiryClassificationInput): Promise<InquiryClassificationDto>;
}

export interface AiServiceOptions {
  readonly cache?: CacheService | undefined;
  readonly config?: AiConfig | undefined;
}

const hashKey = (task: string, payload: unknown): string =>
  cacheKey(
    AI_NAMESPACE,
    task,
    createHash('sha256')
      .update(JSON.stringify(payload) ?? '')
      .digest('hex')
      .slice(0, 32),
  );

/**
 * Models like to wrap JSON in prose or fences. The first balanced-looking object
 * is extracted rather than trusting the whole answer to be parseable.
 */
const extractJson = (text: string): unknown => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
};

export const createAiService = (
  provider: AiProvider,
  { cache = createNoopCacheService(), config = {} }: AiServiceOptions = {},
): AiService => {
  const maxTokens = config.maxTokens ?? DEFAULT_AI_MAX_TOKENS;
  const maxInputChars = config.maxInputChars ?? DEFAULT_AI_MAX_INPUT_CHARS;
  const cacheTtlSeconds = config.cacheTtlSeconds ?? DEFAULT_AI_CACHE_TTL_SECONDS;

  const assertWithinLimit = (text: string): void => {
    if (text.length > maxInputChars) throw aiInputTooLargeError(maxInputChars);
  };

  return {
    async summariseDeal(input) {
      // Only the fields listed on `DealSummaryInput` are ever forwarded, and the
      // free-text note is the only one that can be long enough to matter.
      assertWithinLimit(input.notes ?? '');
      assertWithinLimit(input.title);

      const key = hashKey('deal-summary', {
        title: input.title,
        stage: input.stage,
        amount: input.amount,
        currency: input.currency,
        probability: input.probability,
        expectedCloseDate: input.expectedCloseDate,
        notes: input.notes,
      });

      const cached = await cache.get<string>(key);
      if (cached !== null) {
        return { dealId: input.id, summary: cached, provider: provider.name, cached: true };
      }

      const summary = (
        await provider.complete({
          system: dealSummarySystemPrompt(),
          prompt: dealSummaryPrompt(input),
          maxTokens,
        })
      ).trim();

      await cache.set(key, summary, cacheTtlSeconds);
      return { dealId: input.id, summary, provider: provider.name, cached: false };
    },

    async classifyInquiry(input) {
      assertWithinLimit(input.text);

      const normalised = input.text.trim().replace(/\s+/g, ' ').toLowerCase();
      const key = hashKey('inquiry-classification', normalised);

      const cached = await cache.get<{ category: ResolvedInquiryCategory; confidence: number }>(
        key,
      );
      if (cached !== null) {
        return { ...cached, provider: provider.name, cached: true };
      }

      const answer = await provider.complete({
        system: inquiryClassificationSystemPrompt(),
        prompt: inquiryClassificationPrompt(input.text),
        maxTokens: Math.min(maxTokens, 64),
      });

      const parsed = classificationSchema.safeParse(extractJson(answer));
      // An unrecognised label is downgraded, never forwarded: the caller gets a
      // value it can switch on, and a hallucinated category cannot become a
      // routing decision or a database row.
      const result = parsed.success
        ? {
            category: parsed.data.category as ResolvedInquiryCategory,
            confidence: parsed.data.confidence,
          }
        : { category: UNKNOWN_INQUIRY_CATEGORY as ResolvedInquiryCategory, confidence: 0 };

      await cache.set(key, result, cacheTtlSeconds);
      return { ...result, provider: provider.name, cached: false };
    },
  };
};
