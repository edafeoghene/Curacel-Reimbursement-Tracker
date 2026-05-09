// Classifier orchestration.
//
// Builds messages, calls the LLM through `callLLM`, validates the JSON
// response with zod against the ClassifierResult contract from `../types.js`.
//
// On any parse / validation failure: throw `ClassifierParseError` carrying
// the raw response. The caller decides whether that becomes MANUAL_REVIEW.
//
// `is_expense: false` is a normal outcome — return a valid result, do not throw.

import { z } from "zod";
import type {
  ClassifierResult,
  ClassifyInput,
} from "../types.js";
import { callLLM } from "./client.js";
import { buildClassifierMessages, CLASSIFIER_CATEGORIES } from "./prompts.js";

export class ClassifierParseError extends Error {
  public readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "ClassifierParseError";
    this.raw = raw;
  }
}

const ItemSchema = z.object({
  description: z.string(),
  category: z.enum(CLASSIFIER_CATEGORIES),
  // Positive — zero or negative amounts are invalid.
  amount: z.number().positive().finite(),
  // ISO 4217 three-letter codes, uppercase.
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO 4217 uppercase code"),
  vendor: z.string(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
});

const ResultSchema = z.object({
  is_expense: z.boolean(),
  confidence: z.number().min(0).max(1),
  items: z.array(ItemSchema),
  notes: z.string(),
});

/**
 * Dependency-injectable LLM function. Tests pass a fake; production omits.
 */
export type LLMFn = (
  messages: Parameters<typeof callLLM>[0],
  options?: Parameters<typeof callLLM>[1],
) => Promise<string>;

/**
 * Classify a single source message into a ClassifierResult.
 *
 * Throws:
 *   - LLMCallFailed (from callLLM) if the LLM itself failed.
 *   - ClassifierParseError if the response was not valid JSON or did not
 *     match the schema.
 *
 * Returns a well-formed `ClassifierResult` with `is_expense: false` and
 * `items: []` when the LLM determines the message is not an expense.
 */
export async function classifyExpense(
  input: ClassifyInput,
  llmFn: LLMFn = callLLM,
): Promise<ClassifierResult> {
  const messages = buildClassifierMessages(input);
  const raw = await llmFn(messages, { jsonMode: true });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ClassifierParseError(
      `Classifier response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    );
  }

  const validated = ResultSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ClassifierParseError(
      `Classifier response did not match schema: ${validated.error.message}`,
      raw,
    );
  }

  const result = validated.data;

  // is_expense:false should always carry an empty items array. Defensive
  // normalization in case the model emitted items anyway — they would be
  // ignored downstream.
  if (!result.is_expense) {
    return { ...result, items: [] };
  }

  return result;
}
