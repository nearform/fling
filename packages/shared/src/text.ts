/**
 * Text every store keeps as it is: no NUL and no lone surrogate (half of a UTF-16 pair, which has
 * no UTF-8). A user string that becomes part of a stored key (an address, a file path, a Path's
 * folder) must be such text, so admission refuses anything else with a 400 before the Table ever
 * sees it (the Table's `storableKey` is this rule).
 */
import { z } from 'zod'

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** Whether `s` holds no NUL and no lone surrogate. */
export const isStorableText = (s: string) => !s.includes('\0') && !LONE_SURROGATE.test(s)

export const STORABLE_TEXT_RULE = 'may not hold NUL or invalid Unicode (a lone surrogate)'

/** An email address as a request gives it: trimmed, lower-cased, 3-254 characters of storable text. */
export const EmailInputSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .refine(isStorableText, `An address ${STORABLE_TEXT_RULE}`)
