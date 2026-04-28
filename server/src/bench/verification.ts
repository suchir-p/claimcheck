/**
 * Measures the extraction check (verifyItem) against labeled cases. Each synthetic bill is
 * rendered to a real PDF and read back through the app's own pdf.js reader, so the check sees
 * the same kind of text layer it sees in production. The ground truth is what the PDF prints.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { verifyItem, type ExtractedItem } from '../extraction/verify';
import { readPdfText } from '../services/pdfText';
import { loadCmsDescriptions } from '../services/referenceData';
import type { CodePool } from './bills';
import { rng } from './stats';

interface Row {
  date: string;
  code: string;
  description: string;
  units: number;
  charge: number;
  /** Long descriptions wrap onto a second printed line, as they often do on real bills. */
  wrapped: boolean;
  wordWrap: boolean;
}

const money = (n: number) => n.toFixed(2);
/** The row as a person (or the model) reads it, left to right. */
const rowText = (r: Row) => `${r.date.slice(5, 7)}/${r.date.slice(8)}/${r.date.slice(0, 4)} ${r.code} ${r.description} ${r.units} ${money(r.charge)}`;

async function renderPdf(rows: Row[], wrapAt: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage([612, 792]);
  let y = 740;
  const text = (s: string, x: number) => page.drawText(s, { x, y, size: 8, font });
  text('ITEMIZED STATEMENT  Account 00000-00', 40);
  y -= 24;
  for (const r of rows) {
    if (y < 60) { page = pdf.addPage([612, 792]); y = 740; }
    // Half the wrapped rows break at a word boundary, half at a fixed column (mid-word), as
    // fixed-width billing systems do.
    const space = r.description.lastIndexOf(' ', wrapAt);
    const cut = r.wordWrap && space > 0 ? space : wrapAt;
    const [first, rest] = r.wrapped ? [r.description.slice(0, cut).trim(), r.description.slice(cut).trim()] : [r.description, ''];
    // Cells are drawn left to right, the order the app's reader joins them in.
    text(rowText(r).split(' ')[0], 40);
    text(r.code, 95);
    text(first, 140);
    text(String(r.units), 430);
    text(money(r.charge), 480);
    if (rest) { y -= 10; text(rest, 140); }
    y -= 14;
  }
  return pdf.save();
}

/** Codes one keystroke away (one digit changed, or two adjacent digits swapped). */
function neighbors(code: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i < code.length; i++) {
    if (!/\d/.test(code[i])) continue;
    for (let d = 0; d <= 9; d++) if (String(d) !== code[i]) out.add(code.slice(0, i) + d + code.slice(i + 1));
    if (i + 1 < code.length && code[i] !== code[i + 1]) out.add(code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2));
  }
  out.delete(code);
  return [...out];
}

export type Category =
  | 'clean_full_line'
  | 'clean_partial_line'
  | 'misread_to_real_code'
  | 'misread_to_real_code_source_correct'
  | 'misread_to_nonexistent_code'
  | 'swapped_with_another_line'
  | 'wrong_charge';

/** Clean cases should pass; every other category is an extraction error that should be flagged. */
export const SHOULD_FLAG: Record<Category, boolean> = {
  clean_full_line: false,
  clean_partial_line: false,
  misread_to_real_code: true,
  misread_to_real_code_source_correct: true,
  misread_to_nonexistent_code: true,
  swapped_with_another_line: true,
  wrong_charge: true,
};

export type Layout = 'single_line' | 'wrapped';

export interface CategoryResult {
  category: Category;
  /** Whether the row's description wrapped onto a second printed line. */
  layout: Layout;
  shouldFlag: boolean;
  cases: number;
  flagged: number;
  flaggedRate: number;
  caughtByPdfCheck: number;
  caughtByCmsCheck: number;
  caughtByDescriptionCheck: number;
}

export async function runVerificationBenchmark(pool: CodePool, opts: { bills: number; seed: number }) {
  const r = rng(opts.seed);
  const cmsCodes = new Set(pool.pfs.map((p) => p.code));
  const counts = new Map<string, CategoryResult>();
  const record = (category: Category, layout: Layout, v: ReturnType<typeof verifyItem>) => {
    const key = `${category}|${layout}`;
    const c = counts.get(key) ?? {
      category, layout, shouldFlag: SHOULD_FLAG[category], cases: 0, flagged: 0, flaggedRate: 0,
      caughtByPdfCheck: 0, caughtByCmsCheck: 0, caughtByDescriptionCheck: 0,
    };
    c.cases++;
    if (v.extractionStatus !== 'verified') c.flagged++;
    if (!v.verification.foundInDocument) c.caughtByPdfCheck++;
    if (!v.verification.cmsMatch) c.caughtByCmsCheck++;
    else if (!v.verification.descriptionMatch) c.caughtByDescriptionCheck++;
    counts.set(key, c);
  };

  for (let b = 0; b < opts.bills; b++) {
    const size = 10 + r.int(11);
    const used = new Set<string>();
    const rows: Row[] = [];
    while (rows.length < size) {
      const p = r.pick(pool.pfs);
      if (used.has(p.code) || p.description.length < 6) continue;
      used.add(p.code);
      rows.push({ date: '2026-09-14', code: p.code, description: p.description.toUpperCase(), units: 1, charge: Math.round(p.rate * 3 * 100) / 100, wrapped: p.description.length > 14 && r.next() < 0.2, wordWrap: r.next() < 0.5 });
    }
    const pages = await readPdfText(await renderPdf(rows, 14));
    const descriptions = await loadCmsDescriptions([...new Set([...used, ...rows.flatMap((row) => neighbors(row.code))])]);
    const check = (item: ExtractedItem) => verifyItem(item, pages, descriptions.get(item.code));

    rows.forEach((row, i) => {
      const layout: Layout = row.wrapped ? 'wrapped' : 'single_line';
      const rec = (category: Category, item: ExtractedItem) => record(category, layout, check(item));
      const base: ExtractedItem = { code: row.code, description: row.description, sourceText: rowText(row), charge: row.charge };
      rec('clean_full_line', base);
      rec('clean_partial_line', { ...base, sourceText: `${row.code} ${row.description}` });

      const near = neighbors(row.code);
      const real = near.filter((c) => cmsCodes.has(c));
      const fake = near.filter((c) => !cmsCodes.has(c) && !descriptions.has(c));
      if (real.length) {
        const wrong = r.pick(real);
        rec('misread_to_real_code', { ...base, code: wrong, sourceText: base.sourceText.replace(row.code, wrong) });
        rec('misread_to_real_code_source_correct', { ...base, code: wrong });
      }
      if (fake.length) {
        const wrong = r.pick(fake);
        rec('misread_to_nonexistent_code', { ...base, code: wrong, sourceText: base.sourceText.replace(row.code, wrong) });
      }
      const other = rows[(i + 1 + r.int(rows.length - 1)) % rows.length];
      if (other.code !== row.code) {
        // The right code and printed text for another line, paired with this line's description and charge.
        rec('swapped_with_another_line', { code: other.code, sourceText: rowText(other), description: row.description, charge: row.charge });
      }
      rec('wrong_charge', { ...base, charge: Math.round((row.charge * 10 + 1) * 100) / 100 });
    });
  }

  const results = [...counts.values()].map((c) => ({ ...c, flaggedRate: Math.round((c.flagged / c.cases) * 1000) / 10 }));
  const order = Object.keys(SHOULD_FLAG);
  results.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.layout.localeCompare(b.layout));
  const errors = results.filter((c) => c.shouldFlag && c.category !== 'wrong_charge');
  const clean = results.filter((c) => !c.shouldFlag);
  const rate = (rs: CategoryResult[]) => {
    const n = rs.reduce((s, c) => s + c.cases, 0);
    return { cases: n, flagged: rs.reduce((s, c) => s + c.flagged, 0), rate: n ? Math.round((rs.reduce((s, c) => s + c.flagged, 0) / n) * 1000) / 10 : 0 };
  };
  const by = (rs: CategoryResult[], layout: Layout) => rate(rs.filter((c) => c.layout === layout));
  return {
    results,
    // Code and line errors only: wrong charges are a known blind spot, reported separately above.
    codeErrorDetection: rate(errors),
    codeErrorDetectionByLayout: { single_line: by(errors, 'single_line'), wrapped: by(errors, 'wrapped') },
    falsePositives: rate(clean),
    falsePositivesByLayout: { single_line: by(clean, 'single_line'), wrapped: by(clean, 'wrapped') },
  };
}
