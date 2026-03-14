import { descriptionSimilarity, totalsReconcile, verifyItem } from '../src/extraction/verify';

const page = '08/01/2026 99283 EMERGENCY DEPT VISIT MOD MDM 1 $850.00\n08/01/2026 85025 CBC W/AUTO DIFF 1 $112.00';

describe('verifyItem', () => {
  const wrappedPage = [
    '08/01/2026 99283 EMERGENCY DEPT VISIT 1 $850.00',
    '08/01/2026 80053 COMPREHENSIVE METABOLIC 1 $186.00',
    'PANEL WITH CALCULATED RESULTS',
    '08/01/2026 85025 CBC W/AUTO DIFF 1 $112.00',
  ].join('\n');

  it('verifies a row whose description wraps onto the next printed line', () => {
    const v = verifyItem(
      { code: '80053', description: 'Comprehensive metabolic panel', sourceText: '08/01/2026 80053 COMPREHENSIVE METABOLIC PANEL WITH CALCULATED RESULTS 1 $186.00', charge: 186 },
      [wrappedPage],
      'Comprehensive metabolic panel',
    );
    expect(v.verification.foundInDocument).toBe(true);
  });

  it('verifies a row whose description is cut mid-word by a fixed-width column', () => {
    const page = '09/14/2026   33223   RELOCATE POCKE   1   1092.21\nT FOR DEFIB\n09/14/2026   85025   CBC W/AUTO DIFF   1   64.00';
    const v = verifyItem(
      { code: '33223', description: 'Relocate pocket for defib', sourceText: '09/14/2026 33223 RELOCATE POCKET FOR DEFIB 1 1092.21', charge: 1092.21 },
      [page],
      'Relocate pocket for defib',
    );
    expect(v.verification.foundInDocument).toBe(true);
  });

  it('still catches a misread code on a wrapped row', () => {
    const v = verifyItem(
      { code: '80050', description: 'Comprehensive metabolic panel', sourceText: '08/01/2026 80050 COMPREHENSIVE METABOLIC PANEL WITH CALCULATED RESULTS 1 $186.00', charge: 186 },
      [wrappedPage],
      'General health panel',
    );
    expect(v.verification.foundInDocument).toBe(false);
  });

  it('does not stitch together text from rows that are not adjacent', () => {
    const v = verifyItem(
      { code: '99283', description: 'Emergency dept visit', sourceText: '99283 EMERGENCY DEPT VISIT CBC $112.00', charge: 850 },
      [wrappedPage],
      'Emergency dept visit mod mdm',
    );
    expect(v.verification.foundInDocument).toBe(false);
  });

  it('verifies an item whose code appears in the source text on the bill', () => {
    const v = verifyItem({ code: '99283', description: 'Emergency dept visit mod mdm', sourceText: '99283 EMERGENCY DEPT VISIT', charge: 850 }, [page], 'Emergency dept visit mod mdm');
    expect(v.extractionStatus).toBe('verified');
    expect(v.source).toEqual({ page: 1, text: '99283 EMERGENCY DEPT VISIT' });
  });

  it('catches a misread code that exists in CMS data with a similar description', () => {
    // The model read 99283 as 99285 and echoed a source text containing the wrong code.
    const v = verifyItem({ code: '99285', description: 'Emergency dept visit', sourceText: '99285 EMERGENCY DEPT VISIT', charge: 850 }, [page], 'Emergency dept visit hi mdm');
    expect(v.verification.foundInDocument).toBe(false);
    expect(v.extractionStatus).toBe('needs_review');
  });

  it('marks codes missing from CMS data as unverified, not invalid', () => {
    const v = verifyItem({ code: '85025', description: 'CBC', sourceText: '85025 CBC W/AUTO DIFF', charge: 112 }, [page], undefined);
    expect(v.extractionStatus).toBe('unverified');
  });

  it('flags a description that does not match the CMS descriptor', () => {
    const v = verifyItem({ code: '85025', description: 'Knee replacement', sourceText: '85025 CBC W/AUTO DIFF', charge: 112 }, [page], 'Complete cbc w/auto diff wbc');
    expect(v.extractionStatus).toBe('needs_review');
  });
});

describe('descriptionSimilarity', () => {
  it('matches abbreviations by prefix', () => {
    expect(descriptionSimilarity('Emergency department visit', 'Emergency dept visit hi mdm')).toBeGreaterThan(0.5);
  });

  it('matches a terse bill line against a wordier CMS descriptor', () => {
    expect(descriptionSimilarity('Routine venipuncture', 'Collj venous bld venipuncture')).toBeGreaterThanOrEqual(0.5);
  });

  it('scores unrelated descriptions low', () => {
    expect(descriptionSimilarity('Knee replacement', 'Complete cbc w/auto diff wbc')).toBe(0);
  });
});

describe('totalsReconcile', () => {
  it('compares line items to the stated total', () => {
    expect(totalsReconcile([850, 112], 962)).toBe(true);
    expect(totalsReconcile([850, 112], 1000)).toBe(false);
    expect(totalsReconcile([850], undefined)).toBeUndefined();
  });
});
