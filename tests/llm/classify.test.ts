// Classifier tests use dependency injection: classifyExpense accepts an
// optional `llmFn` arg defaulting to the real callLLM. Each test passes a
// fake that returns a canned string, so we never touch OpenRouter and never
// need vitest module mocking.

import { describe, it, expect } from "vitest";
import { classifyExpense, ClassifierParseError } from "../../src/llm/classify.js";
import type { ClassifyInput } from "../../src/types.js";

const baseInput: ClassifyInput = {
  text: "Office laptop repair, ₦15,000",
  images: [],
};

function fakeLLM(returnValue: string) {
  return async () => returnValue;
}

describe("classifyExpense", () => {
  it("returns a parsed result on a well-formed expense response", async () => {
    const raw = JSON.stringify({
      is_expense: true,
      confidence: 0.92,
      items: [
        {
          description: "Office laptop charging port repair",
          category: "repair",
          amount: 15000,
          currency: "NGN",
          vendor: "TechFix Lagos",
          date: "2026-05-08",
        },
      ],
      notes: "",
    });

    const result = await classifyExpense(baseInput, fakeLLM(raw));

    expect(result.is_expense).toBe(true);
    expect(result.confidence).toBeCloseTo(0.92);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      category: "repair",
      amount: 15000,
      currency: "NGN",
      vendor: "TechFix Lagos",
      date: "2026-05-08",
    });
    expect(result.notes).toBe("");
  });

  it("returns a valid result (no throw) when is_expense is false", async () => {
    const raw = JSON.stringify({
      is_expense: false,
      confidence: 0.85,
      items: [],
      notes: "",
    });

    const result = await classifyExpense(baseInput, fakeLLM(raw));
    expect(result.is_expense).toBe(false);
    expect(result.items).toEqual([]);
  });

  it("normalizes items to [] when is_expense is false even if model emitted some", async () => {
    const raw = JSON.stringify({
      is_expense: false,
      confidence: 0.6,
      // Model misbehaved and included items anyway — we drop them.
      items: [
        {
          description: "x",
          category: "other",
          amount: 1,
          currency: "NGN",
          vendor: "y",
          date: "2026-05-09",
        },
      ],
      notes: "",
    });

    const result = await classifyExpense(baseInput, fakeLLM(raw));
    expect(result.is_expense).toBe(false);
    expect(result.items).toEqual([]);
  });

  it("returns a confidence below 0.7 verbatim — routing is the handler's job", async () => {
    const raw = JSON.stringify({
      is_expense: true,
      confidence: 0.4,
      items: [
        {
          description: "Maybe an Uber",
          category: "transport",
          amount: 3500,
          currency: "NGN",
          vendor: "",
          date: "2026-05-09",
        },
      ],
      notes: "Receipt unreadable.",
    });

    const result = await classifyExpense(baseInput, fakeLLM(raw));
    expect(result.is_expense).toBe(true);
    expect(result.confidence).toBeCloseTo(0.4);
    expect(result.items).toHaveLength(1);
  });

  it("throws ClassifierParseError with .raw when the response is not JSON", async () => {
    const garbage = "not json at all { [";

    await expect(classifyExpense(baseInput, fakeLLM(garbage))).rejects.toMatchObject({
      name: "ClassifierParseError",
      raw: garbage,
    });

    // And it really is the typed error class.
    try {
      await classifyExpense(baseInput, fakeLLM(garbage));
    } catch (err) {
      expect(err).toBeInstanceOf(ClassifierParseError);
      expect((err as ClassifierParseError).raw).toBe(garbage);
    }
  });

  it("throws ClassifierParseError when category is not in the enum", async () => {
    const raw = JSON.stringify({
      is_expense: true,
      confidence: 0.9,
      items: [
        {
          description: "snack",
          category: "snacks", // not in enum
          amount: 1000,
          currency: "NGN",
          vendor: "Shoprite",
          date: "2026-05-09",
        },
      ],
      notes: "",
    });

    await expect(classifyExpense(baseInput, fakeLLM(raw))).rejects.toBeInstanceOf(
      ClassifierParseError,
    );
    await expect(classifyExpense(baseInput, fakeLLM(raw))).rejects.toMatchObject({
      raw,
    });
  });

  it("throws ClassifierParseError when amount is negative", async () => {
    const raw = JSON.stringify({
      is_expense: true,
      confidence: 0.9,
      items: [
        {
          description: "negative amount, nonsense",
          category: "other",
          amount: -100,
          currency: "NGN",
          vendor: "",
          date: "2026-05-09",
        },
      ],
      notes: "",
    });

    await expect(classifyExpense(baseInput, fakeLLM(raw))).rejects.toBeInstanceOf(
      ClassifierParseError,
    );
  });

  it("throws ClassifierParseError when amount is zero", async () => {
    const raw = JSON.stringify({
      is_expense: true,
      confidence: 0.9,
      items: [
        {
          description: "zero amount",
          category: "other",
          amount: 0,
          currency: "NGN",
          vendor: "",
          date: "2026-05-09",
        },
      ],
      notes: "",
    });

    await expect(classifyExpense(baseInput, fakeLLM(raw))).rejects.toBeInstanceOf(
      ClassifierParseError,
    );
  });

  it("throws ClassifierParseError when currency is not 3-letter ISO", async () => {
    const raw = JSON.stringify({
      is_expense: true,
      confidence: 0.9,
      items: [
        {
          description: "bad currency",
          category: "other",
          amount: 100,
          currency: "Naira",
          vendor: "",
          date: "2026-05-09",
        },
      ],
      notes: "",
    });

    await expect(classifyExpense(baseInput, fakeLLM(raw))).rejects.toBeInstanceOf(
      ClassifierParseError,
    );
  });

  it("throws ClassifierParseError when date is not YYYY-MM-DD", async () => {
    const raw = JSON.stringify({
      is_expense: true,
      confidence: 0.9,
      items: [
        {
          description: "bad date",
          category: "other",
          amount: 100,
          currency: "NGN",
          vendor: "",
          date: "09/05/2026",
        },
      ],
      notes: "",
    });

    await expect(classifyExpense(baseInput, fakeLLM(raw))).rejects.toBeInstanceOf(
      ClassifierParseError,
    );
  });

  it("forwards jsonMode:true to the LLM function", async () => {
    let capturedOptions: { jsonMode?: boolean } | undefined;
    const spyLLM = async (
      _messages: unknown,
      options?: { jsonMode?: boolean },
    ): Promise<string> => {
      capturedOptions = options;
      return JSON.stringify({
        is_expense: false,
        confidence: 0.9,
        items: [],
        notes: "",
      });
    };

    await classifyExpense(baseInput, spyLLM);
    expect(capturedOptions?.jsonMode).toBe(true);
  });
});
