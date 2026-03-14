// Independent verification of LLM-extracted line items. The model never reports its own
// confidence; every status comes from deterministic checks against the PDF text and CMS data.

/**
 * verified: confirmed against the PDF text and CMS data. corrected: changed by the patient during
 * review, so it reflects what they entered rather than an independent check.
 */
export type ExtractionStatus = 'verified' | 'corrected' | 'needs_review' | 'unverified';

export interface ExtractedItem {
  code: string;
  description: string;
  sourceText: string; // exact text the model says it read from the bill
  charge: number;
}

export interface Verification {
  foundInDocument: boolean;
  cmsMatch: boolean;
  descriptionMatch: boolean;
}

export interface VerifiedItem {
  verification: Verification;
  extractionStatus: ExtractionStatus;
  source?: { page: number; text: string };
  reasons: string[];
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Finds which page contains the item's source text, and confirms the extracted code
 * itself appears in that text. A misread code (99283 read as 99285) fails here even
 * though it exists in CMS data and has a similar description.
 */
export function locateInDocument(item: ExtractedItem, pageTexts: string[]): { page: number; text: string } | undefined {
  const needle = normalize(item.sourceText);
  if (!needle) return undefined;
  const codeRe = new RegExp(`(^|[^0-9a-z])${escapeRe(item.code.toLowerCase())}([^0-9a-z]|$)`);
  if (!codeRe.test(needle)) return undefined;
  for (let i = 0; i < pageTexts.length; i++) {
    if (normalize(pageTexts[i]).includes(needle)) return { page: i + 1, text: item.sourceText };
  }
  // A long description often wraps onto the next printed line, sometimes mid-word, so the row's
  // text isn't one contiguous string on the page. Accept it when the code is on a printed line and
  // every word of the source text appears in that line plus the one below it.
  const wanted = tokens(needle);
  for (let i = 0; i < pageTexts.length; i++) {
    const lines = pageTexts[i].split('\n').map(normalize);
    for (let l = 0; l < lines.length; l++) {
      if (codeRe.test(lines[l]) && wanted.every((t) => onLineOrWrapped(t, lines[l], lines[l + 1] ?? ''))) {
        return { page: i + 1, text: item.sourceText };
      }
    }
  }
  return undefined;
}

const compact = (s: string) => s.replace(/[^a-z0-9]/g, '');

/**
 * Whether a word of the source text is printed on the row's line or the line below, including a
 * word cut mid-way by a fixed-width column ("POCKE" at the end of the row's description, "T FOR
 * DEFIB" on the next line).
 */
function onLineOrWrapped(word: string, line: string, next: string): boolean {
  const nextText = compact(next);
  if (compact(line).includes(word) || nextText.includes(word)) return true;
  const lineWords = line.split(/[^a-z0-9]+/);
  for (let k = 1; k < word.length; k++) {
    if (nextText.startsWith(word.slice(k)) && lineWords.some((w) => w.endsWith(word.slice(0, k)))) return true;
  }
  return false;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const tokens = (s: string) => normalize(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

/** "dept" abbreviates "department": same first letter, and its letters appear in order. */
function isAbbreviation(short: string, long: string): boolean {
  if (short.length < 3 || short[0] !== long[0]) return false;
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
}

const tokensMatch = (a: string, b: string) =>
  a === b || (a.length <= b.length ? isAbbreviation(a, b) : isAbbreviation(b, a));

/**
 * Loose text similarity between the bill's description and CMS's short descriptor:
 * the share of CMS descriptor words that appear on the bill. CMS descriptors are
 * abbreviated ("Emergency dept visit hi mdm"), so abbreviations count as matches.
 */
export function descriptionSimilarity(billDescription: string, cmsDescription: string): number {
  const cms = tokens(cmsDescription);
  const bill = tokens(billDescription);
  if (cms.length === 0 || bill.length === 0) return 0;
  // Take the better of both directions: a terse bill line ("Routine venipuncture") can match
  // a wordier CMS descriptor, and vice versa.
  const cmsCovered = cms.filter((c) => bill.some((b) => tokensMatch(c, b))).length / cms.length;
  const billCovered = bill.filter((b) => cms.some((c) => tokensMatch(c, b))).length / bill.length;
  return Math.max(cmsCovered, billCovered);
}

export const DESCRIPTION_MATCH_THRESHOLD = 0.34;

export function verifyItem(
  item: ExtractedItem,
  pageTexts: string[],
  cmsDescription: string | undefined,
): VerifiedItem {
  const source = locateInDocument(item, pageTexts);
  const cmsMatch = cmsDescription !== undefined;
  const descriptionMatch = cmsMatch && descriptionSimilarity(item.description, cmsDescription!) >= DESCRIPTION_MATCH_THRESHOLD;
  const verification = { foundInDocument: !!source, cmsMatch, descriptionMatch };

  const reasons: string[] = [];
  if (!source) reasons.push(`Code ${item.code} was not found on the bill as extracted.`);
  if (!cmsMatch) reasons.push(`Code ${item.code} is not in Medicare's reference data, so it could not be verified.`);
  else if (!descriptionMatch) reasons.push(`The bill's description doesn't match CMS's description for code ${item.code}.`);

  let extractionStatus: ExtractionStatus;
  if (!source) extractionStatus = 'needs_review';
  else if (!cmsMatch) extractionStatus = 'unverified';
  else if (!descriptionMatch) extractionStatus = 'needs_review';
  else extractionStatus = 'verified';

  return { verification, extractionStatus, source, reasons };
}

export function totalsReconcile(charges: number[], statedTotal: number | undefined): boolean | undefined {
  if (statedTotal === undefined) return undefined;
  const sum = charges.reduce((s, c) => s + c, 0);
  return Math.abs(sum - statedTotal) <= 0.01;
}
