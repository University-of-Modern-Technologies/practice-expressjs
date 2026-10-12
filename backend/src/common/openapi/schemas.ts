import { z } from 'zod';

/** The envelope every refusal and every failure is answered with. */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ example: 'VALIDATION_ERROR' }),
      message: z.string().meta({ example: 'Request validation failed' }),
      details: z.unknown().optional(),
    }),
    requestId: z.string(),
  })
  .meta({ id: 'ErrorResponse' });

/** Monetary amounts travel as decimal strings, never as JSON numbers. */
export const decimalStringSchema = z
  .string()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/)
  .meta({ description: 'Десяткове число у вигляді рядка.' });

export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);

/** The optimistic-concurrency counter a record carries on the wire. */
export const versionNumberSchema = z.int().min(1);

/** Envelope shared by every paginated list endpoint. */
export const pageOf = <Item extends z.ZodType>(
  item: Item,
): z.ZodObject<{
  items: z.ZodArray<Item>;
  page: z.ZodInt;
  pageSize: z.ZodInt;
  total: z.ZodInt;
}> =>
  z.object({
    items: z.array(item),
    page: z.int(),
    pageSize: z.int(),
    total: z.int(),
  });
