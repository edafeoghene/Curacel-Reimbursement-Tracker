// Classifier prompts and message-shape builders.
//
// PLAN.md §8 — decision rules embedded in the system prompt:
//   - is_expense strict
//   - confidence 0..1 (caller routes to MANUAL_REVIEW under 0.7)
//   - fixed category enum
//   - multi-expense grouping (same purpose) vs splitting (unrelated)
//   - receipt-vs-message reconciliation: prefer receipt, flag in notes
//
// The prompt does NOT name the model nor do role-play filler. It states the
// task, the rules, and the schema. That's it.

import type OpenAI from "openai";
import type { ClassifyInput } from "@curacel/shared";

export const CLASSIFIER_CATEGORIES = [
  "transport",
  "equipment",
  "repair",
  "subscription",
  "meals",
  "travel",
  "professional_services",
  "other",
] as const;
export type ClassifierCategory = (typeof CLASSIFIER_CATEGORIES)[number];

const CATEGORY_LIST = CLASSIFIER_CATEGORIES.join(", ");

export const CLASSIFIER_SYSTEM_PROMPT = `You classify Slack messages from a corporate expenses channel.

Task: decide whether the message (and any attached receipt images) is a request to record an expense or invoice for payment/reimbursement, and if so, extract the structured fields.

Output: a single JSON object. No prose, no markdown fences, no commentary outside the JSON.

Schema:
{
  "is_expense": boolean,
  "confidence": number,          // 0..1, your calibrated certainty that this is a real expense request
  "items": [
    {
      "description": string,     // human-readable summary of what the expense is for
      "category": string,        // exactly one of: ${CATEGORY_LIST}
      "amount": number,          // positive number, no currency symbol, no thousands separators
      "currency": string,        // ISO 4217 three-letter code, uppercase (e.g. "NGN", "USD")
      "vendor": string,          // merchant or payee; empty string if genuinely unknown
      "date": string             // ISO date "YYYY-MM-DD"; if unknown use today's date
    }
  ],
  "notes": string                // brief notes for the human reviewer; empty string if nothing to flag
}

Decision rules:

1. is_expense:
   - true ONLY if the message clearly raises a payable expense or invoice (e.g. "Uber to client meeting, ₦15,000" with or without a receipt; or an attached invoice).
   - false for chatter, questions, status updates, jokes, or anything that does not request payment/reimbursement.
   - When false, set "items": [] and "confidence" to your certainty that it is NOT an expense.

2. confidence:
   - Calibrate honestly. A reading below 0.7 routes the ticket to manual human review, which is the correct outcome when in doubt.
   - Do not inflate. "Probably an expense but the receipt is unreadable" is exactly the case for low confidence.

3. Category:
   - Pick exactly one value from the enum. If nothing fits, use "other" rather than inventing a new category.

4. Multi-expense grouping vs splitting:
   - Group items as ONE expense if they share a single purpose or trip (e.g. outbound + return Uber for the same meeting; two parts of one repair).
   - Split into SEPARATE items if items are for unrelated purposes (e.g. a laptop repair and a team lunch in the same message). Each split item is its own object in the array.
   - Even when there is only one expense, "items" must still be an array with a single object.

5. Receipt-vs-message reconciliation:
   - If the message text and the attached receipt disagree on amount, currency, vendor, or date, PREFER the receipt's values and add a short note in "notes" flagging the discrepancy (e.g. "Message said 12,000; receipt shows 14,500.").
   - If the receipt is unreadable, fall back to the message text and lower your confidence.

6. Currency:
   - Always emit a 3-letter ISO 4217 code in uppercase. Convert symbols (₦ -> NGN, $ -> USD, € -> EUR, £ -> GBP). If the symbol is ambiguous and there is no other signal, leave currency as the most likely match for the workspace context but flag the uncertainty in notes.

7. Amount:
   - Always a positive number. No currency symbols, no commas, no spaces.

Return ONLY the JSON object.`;

/**
 * Build a single user message with one text part and one image_url part per
 * image (data: URL with the supplied mime). Per PLAN.md §6, OpenAI-style
 * content parts (NOT Anthropic-native blocks).
 *
 * The system prompt and the user message together form the full chat input.
 */
export function buildClassifierMessages(
  input: ClassifyInput,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const userParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: input.text },
  ];

  for (const img of input.images) {
    userParts.push({
      type: "image_url",
      image_url: { url: `data:${img.mime};base64,${img.base64}` },
    });
  }

  return [
    { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
    { role: "user", content: userParts },
  ];
}
