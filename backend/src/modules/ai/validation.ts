import { z } from 'zod';

import { DEFAULT_AI_MAX_INPUT_CHARS } from './provider-factory.js';

// Input is bounded at the edge as well as in the service: oversized text is
// rejected with 400 before a single token is paid for.
export const summariseDealSchema = z.object({
  body: z.object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    stage: z.string().trim().min(1).max(40),
    amount: z
      .string()
      .trim()
      .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Invalid monetary amount')
      .optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
    probability: z.number().int().min(0).max(100).optional(),
    // The same calendar day the deal itself carries: `YYYY-MM-DD`, and a real
    // one, so 2026-02-31 is refused rather than passed into a prompt.
    expectedCloseDate: z.iso.date().optional(),
    notes: z.string().trim().min(1).max(DEFAULT_AI_MAX_INPUT_CHARS).optional(),
  }),
});

export const classifyInquirySchema = z.object({
  body: z.object({
    text: z.string().trim().min(1).max(DEFAULT_AI_MAX_INPUT_CHARS),
  }),
});
