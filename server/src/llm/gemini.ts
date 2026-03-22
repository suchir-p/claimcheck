import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { config } from '../config';
import { ModelChain } from './modelChain';
import { EobExtractionSchema, ExtractionSchema, type LlmProvider, type LlmResult } from './provider';

const EXTRACTION_PROMPT = `You are reading an itemized medical bill. Return every billed line item as JSON.
Rules:
- Copy codes exactly as printed. Never guess or correct a code.
- "sourceText" must be the exact text of that line as printed on the bill, including the code.
- Dates as YYYY-MM-DD. Money as plain numbers without $ or commas.
- Include revenueCode, placeOfService, typeOfBill, admission/discharge dates, statedTotal (total charges), and amountDue (the balance the patient is asked to pay) only if printed on the bill.
- Do not include payments, adjustments, or insurance lines as line items.`;

const EOB_PROMPT = `You are reading a health insurance Explanation of Benefits (EOB). Return every service line as JSON.
Rules:
- Copy codes exactly as printed, and leave "code" out if the statement doesn't show one. Never guess a code.
- "billed" is the amount the provider charged the insurer. "patientResponsibility" is everything the patient owes for that line (deductible, copay, coinsurance, and amounts not covered).
- "sourceText" must be the exact text of that line as printed.
- Dates as YYYY-MM-DD. Money as plain numbers without $ or commas.
- Do not include summary or total rows as lines.`;

export class GeminiProvider implements LlmProvider {
  private ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  private chain = new ModelChain(config.gemini.models);

  /** Sends the request to the first model that answers; see ModelChain for the fallback rules. */
  private async generateJson(parts: object[], schema: unknown, timeoutMs = config.gemini.timeoutMs): Promise<LlmResult> {
    const { value, model } = await this.chain.run(async (model) => {
      const res = await this.ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          temperature: 0,
          abortSignal: AbortSignal.timeout(timeoutMs),
        },
      });
      if (!res.text) throw new Error(`${model} returned an empty response`);
      return JSON.parse(res.text) as unknown;
    });
    return { data: value, model };
  }

  extractBill(pdf: Uint8Array) {
    return this.generateJson(
      [{ inlineData: { mimeType: 'application/pdf', data: Buffer.from(pdf).toString('base64') } }, { text: EXTRACTION_PROMPT }],
      z.toJSONSchema(ExtractionSchema, { io: 'input' }),
    );
  }

  extractEob(pdf: Uint8Array) {
    return this.generateJson(
      [{ inlineData: { mimeType: 'application/pdf', data: Buffer.from(pdf).toString('base64') } }, { text: EOB_PROMPT }],
      z.toJSONSchema(EobExtractionSchema, { io: 'input' }),
    );
  }
}
