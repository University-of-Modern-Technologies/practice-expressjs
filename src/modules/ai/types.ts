/**
 * Categories the classifier is allowed to return. The list is closed on
 * purpose: a language model will happily invent a label, and an invented label
 * that reaches the database or a routing rule is a bug waiting to happen.
 */
export const inquiryCategories = [
  'billing',
  'sales',
  'technical_support',
  'shipping',
  'complaint',
  'other',
] as const;
export type InquiryCategory = (typeof inquiryCategories)[number];

/** Returned when the model answers with anything outside the closed list. */
export const UNKNOWN_INQUIRY_CATEGORY = 'unknown';
export type ResolvedInquiryCategory = InquiryCategory | typeof UNKNOWN_INQUIRY_CATEGORY;

/**
 * The exact, explicitly listed fields of a deal that may be sent to a provider.
 * Nothing is spread from a database record: an allow-list is the only reliable
 * way to guarantee that a column added later — a token, a hash, a note with
 * personal data — does not silently start leaving the system.
 */
export interface DealSummaryInput {
  readonly id: string;
  readonly title: string;
  readonly stage: string;
  readonly amount?: string | undefined;
  readonly currency?: string | undefined;
  readonly probability?: number | undefined;
  readonly expectedCloseDate?: string | undefined;
  readonly notes?: string | undefined;
}

export interface DealSummaryDto {
  readonly dealId: string;
  readonly summary: string;
  readonly provider: string;
  readonly cached: boolean;
}

export interface InquiryClassificationInput {
  readonly text: string;
}

export interface InquiryClassificationDto {
  readonly category: ResolvedInquiryCategory;
  readonly confidence: number;
  readonly provider: string;
  readonly cached: boolean;
}
