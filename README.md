# ClaimCheck

**A full-stack medical bill auditor that pairs AI document extraction with deterministic checks against Medicare's official coding rules and payment rates.**

Itemized medical bills are dense pages of billing codes, and errors are easy to miss: a charge listed twice, a test billed separately when it's part of a panel, a balance higher than what insurance says the patient owes. ClaimCheck reads an uploaded bill, checks its billing codes against Medicare's NCCI and MUE coding rules, compares charges with Medicare reference rates, and identifies discrepancies with the patient's insurance statements.

[How it works](#how-it-works) · [Running locally](#running-locally) · [API](docs/api.md)

**Stack:** TypeScript · React · Node.js · Express · MongoDB · Agenda · AWS S3 · Gemini API · Docker · Jest · GitHub Actions

## Engineering highlights

- **The model reads; code decides.** Gemini only extracts line items. Every extracted code is checked against the PDF's own text layer and Medicare's code list before the audit, and the model never reports its own confidence. All findings come from a pure TypeScript rules engine with 7 checks chosen by bill type.
- **Fast lookups over millions of rules.** Reference data for a whole bill loads in one indexed `$in` query per collection, run concurrently, instead of one query per line item.
- **Insurance reconciliation.** Bill lines are matched to Explanation of Benefits lines by date, code, and amount, with a subset-sum search for statement lines that group several charges.
- **Resilient background jobs.** Extraction and audit jobs run on a MongoDB-backed Agenda queue with retries, falling back across Gemini models when one is overloaded. Version checks keep a job that finishes after the patient changes something from overwriting newer results.
- **Tested access control.** JWT sessions in httpOnly cookies, bcrypt passwords, Origin checks against cross-site requests, and per-user ownership checks on every bill route, covered by integration tests against a real MongoDB in CI.

## How it works

1. **Upload.** The browser uploads the PDF straight to S3 with a presigned URL. The Express API queues an extraction job.
2. **Extraction (worker).** Gemini turns the bill into structured line items and returns the exact text it read for each one. Code then verifies every item independently:
   - `foundInDocument`: the code appears in the PDF's own text layer (pdf.js)
   - `cmsMatch`: the code exists in Medicare's fee schedules
   - `descriptionMatch`: the bill's description resembles CMS's descriptor

   The model never reports confidence scores or page coordinates.
3. **Review.** The patient corrects flagged items, marks services not received, and answers whether they were formally admitted. A classifier combines that answer with signals on the bill (room-and-board and observation revenue codes, type-of-bill code) to pick the bill type.
4. **Audit (worker).** A pure TypeScript rules engine runs the checks valid for the bill type, using reference data fetched in one indexed query per collection.
5. **Insurance comparison (optional).** The patient can add the Explanation of Benefits (EOB) their insurer sent. Gemini extracts its lines, which are checked against the PDF's text the same way. A matching step pairs bill lines with EOB lines by date, then code, then billed amount, and also finds EOB lines that group several bill lines (for example, one "Laboratory services" line covering three lab tests) by searching for subsets of same-day charges that add up to the EOB amount. It then flags a balance higher than the patient can owe, charges no statement covers (possibly never submitted to insurance), and charges billed to the patient at a different price than the insurer was billed.

**Model fallback.** Every Gemini call goes through a chain of Flash models set in `GEMINI_MODELS`, best first. A model that's overloaded (503), out of quota (429), or times out is skipped for a few minutes (10 for quota) and the request moves to the next one; a model the key can't use (404) is skipped for an hour; a bad request or invalid key (other 4xx) stops immediately, since every model would fail the same way. If every model is busy, the job queue retries the whole chain with growing waits (30 seconds up to 10 minutes) before giving up. The bill records which model read it. `npm run gemini:models` lists the model IDs your key can use.

| Check | Doctor | Hospital outpatient | Inpatient / uncertain |
|---|---|---|---|
| Duplicates | ✓ | ✓ | ✓ |
| Math errors | ✓ | ✓ | ✓ |
| Unbundling (NCCI) | practitioner table | hospital table | skipped |
| Unit limits (MUE) | practitioner table | hospital table | skipped |
| Pricing vs. Medicare | PFS facility/non-facility | OPPS, lab fee schedule | skipped |
| Not received | ✓ | ✓ | ✓ |
| Charges outside the stay | | | ✓ |

**Pricing threshold.** Charges above `BENCHMARK_MULTIPLIER` (default 3x) times the Medicare benchmark are flagged as *benchmark outliers*, a pricing concern rather than a billing error. Hospital list prices and commercial negotiated rates commonly run well above Medicare, so a low threshold would flag nearly everything. Every flag shows the benchmark, charge, ratio, and threshold.

## Running locally

You need Docker Desktop, an S3 bucket, and a Gemini API key.

```bash
cp server/.env.example server/.env   # fill in your keys
docker compose up --build            # MongoDB, the API on :4000, and the job worker
```

Load the Medicare data once with `npm run import:fees` and `npm run import:rules` (usage is at the top of each script in `server/src/import/`), then start the React app:

```bash
cd client && npm install && npm run dev               # http://localhost:5173
```

Tests and benchmarks run from `server/`:

```bash
MONGODB_TEST_URI=mongodb://localhost:27017 npm test   # unit and API integration tests
npm run bench                                         # lookup, audit, and extraction-check benchmarks
```

The REST endpoints are listed in the [API reference](docs/api.md).
