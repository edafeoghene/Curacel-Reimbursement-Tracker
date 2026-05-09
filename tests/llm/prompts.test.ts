import { describe, it, expect } from "vitest";
import {
  buildClassifierMessages,
  CLASSIFIER_CATEGORIES,
  CLASSIFIER_SYSTEM_PROMPT,
} from "../../src/llm/prompts.js";
import type { ClassifyInput } from "../../src/types.js";

describe("CLASSIFIER_SYSTEM_PROMPT", () => {
  it("mentions every category from the enum", () => {
    for (const cat of CLASSIFIER_CATEGORIES) {
      expect(
        CLASSIFIER_SYSTEM_PROMPT.includes(cat),
        `system prompt should mention category "${cat}"`,
      ).toBe(true);
    }
  });

  it("documents the JSON schema and the multi-expense rule", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("is_expense");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("confidence");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("items");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("notes");
    // Multi-expense rule — group same purpose vs split unrelated.
    expect(CLASSIFIER_SYSTEM_PROMPT.toLowerCase()).toMatch(/group/);
    expect(CLASSIFIER_SYSTEM_PROMPT.toLowerCase()).toMatch(/split/);
  });

  it("documents the receipt-vs-message reconciliation rule", () => {
    // Should tell the model to prefer the receipt and flag in notes.
    expect(CLASSIFIER_SYSTEM_PROMPT.toLowerCase()).toMatch(/receipt/);
    expect(CLASSIFIER_SYSTEM_PROMPT.toLowerCase()).toMatch(/notes/);
  });
});

describe("buildClassifierMessages", () => {
  it("produces a system message and a single user message with text + image parts", () => {
    const input: ClassifyInput = {
      text: "Repaired office laptop, ₦15,000",
      images: [
        { mime: "image/png", base64: "AAAA" },
        { mime: "image/jpeg", base64: "BBBB" },
      ],
    };

    const messages = buildClassifierMessages(input);

    // Two messages: system + user.
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");

    // User message should be a content-parts array.
    const userMsg = messages[1]!;
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as Array<{ type: string }>;

    // 1 text part + N image_url parts.
    expect(parts).toHaveLength(1 + input.images.length);

    const textParts = parts.filter((p) => p.type === "text");
    const imageParts = parts.filter((p) => p.type === "image_url");
    expect(textParts).toHaveLength(1);
    expect(imageParts).toHaveLength(input.images.length);

    // Text part carries the message text exactly.
    const textPart = textParts[0] as { type: "text"; text: string };
    expect(textPart.text).toBe(input.text);
  });

  it("formats each image as a data: URL with the correct mime and base64", () => {
    const input: ClassifyInput = {
      text: "see attachments",
      images: [
        { mime: "image/png", base64: "PNGDATA==" },
        { mime: "image/jpeg", base64: "JPGDATA==" },
        { mime: "image/webp", base64: "WEBPDATA==" },
      ],
    };

    const messages = buildClassifierMessages(input);
    const parts = messages[1]!.content as Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;
    const imageParts = parts.filter(
      (p): p is { type: "image_url"; image_url: { url: string } } =>
        p.type === "image_url",
    );

    expect(imageParts[0]!.image_url.url).toBe("data:image/png;base64,PNGDATA==");
    expect(imageParts[1]!.image_url.url).toBe("data:image/jpeg;base64,JPGDATA==");
    expect(imageParts[2]!.image_url.url).toBe("data:image/webp;base64,WEBPDATA==");
  });

  it("handles the no-images case (text-only)", () => {
    const input: ClassifyInput = {
      text: "Invoice for ₦50,000",
      images: [],
    };

    const messages = buildClassifierMessages(input);
    const parts = messages[1]!.content as Array<{ type: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("text");
  });
});
