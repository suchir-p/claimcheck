import { parseGeminiModels } from '../src/config';

describe('parseGeminiModels', () => {
  it('reads a comma-separated chain, trimming spaces and a models/ prefix', () => {
    expect(parseGeminiModels(' gemini-3-flash-preview, models/gemini-2.5-flash ,gemini-3-flash-preview')).toEqual(['gemini-3-flash-preview', 'gemini-2.5-flash']);
  });

  it('falls back to the default Flash chain when unset', () => {
    expect(parseGeminiModels(undefined)[0]).toBe('gemini-3-flash-preview');
  });

  it('rejects a pasted-together .env line with a clear error', () => {
    expect(() => parseGeminiModels('GEMINI_MODELS=gemini-3-flash-preview,gemini-2.5-flash')).toThrow(/Invalid Gemini model name\(s\) in \.env: "GEMINI_MODELS=gemini-3-flash-preview"/);
  });
});
