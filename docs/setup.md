# Running ClaimCheck locally

The full setup: Docker or a local install, loading the Medicare data, tests, benchmarks, and S3. For a quick start, see the [README](../README.md#running-locally).

You need an S3 bucket and a Gemini API key either way. Copy `server/.env.example` to `server/.env` and fill it in.

## With Docker (recommended)

Requires Docker Desktop. One command starts MongoDB, the API, and the job worker:

```bash
docker compose up --build    # API on http://localhost:4000
```

The API and worker are the same image started with different commands. MongoDB data lives in a named volume, so imports and bills survive restarts. To load the CMS data, put the files under `data/` (layout below) and run the imports once, using the compiled scripts inside the container:

```bash
docker compose run --rm api node dist/import/importFeeSchedules.js \
  --pfs /data/PPRRVU2026_Oct_nonQPP.csv --opps /data/OPPS_AddendumB_2026_Jul.csv --clfs /data/PUF_CLFS_CY2026_Q4V1.csv

docker compose run --rm api node dist/import/importCodingRules.js \
  --ncci-practitioner '/data/ncci/ccipra-v323r0-f*.txt' --ncci-hospital '/data/ncci/ccioph-v323r0-f*.txt' \
  --mue-practitioner /data/ncci/MCR_MUE_PractitionerServices_Eff_10-01-2026.csv \
  --mue-hospital /data/ncci/MCR_MUE_OutpatientHospitalServices_Eff_10-01-2026.csv
```

```
data/
  PPRRVU2026_Oct_nonQPP.csv
  OPPS_AddendumB_2026_Jul.csv
  PUF_CLFS_CY2026_Q4V1.csv
  ncci/
    ccipra-v323r0-f1.txt ... f4.txt
    ccioph-v323r0-f1.txt ... f4.txt
    MCR_MUE_PractitionerServices_Eff_10-01-2026.csv
    MCR_MUE_OutpatientHospitalServices_Eff_10-01-2026.csv
```

## Running the tests

```bash
cd server
npm install
npm run test:unit                                          # rules engine, verification, letters, parsers: no database
MONGODB_TEST_URI=mongodb://localhost:27017 npm test        # everything, including API tests against the Docker MongoDB
```

The API tests cover sign-up and sign-in (bcrypt hashing, identical errors for wrong passwords and unknown emails, rate limiting), session checks (missing, expired, forged, and wrongly signed JWTs), and bill ownership: every route returns "not found" for another user's bill, and nothing they try changes it. Each test run uses its own `claimcheck_test_*` database and never touches your real data. Without `MONGODB_TEST_URI`, the tests start a temporary in-memory MongoDB instead.

## Benchmarks

`npm run bench` (in `server/`, with the CMS data imported) measures the parts of the system that don't depend on Gemini, and writes the results with the machine, MongoDB version, data versions, and trial counts to `server/bench-results/`. It takes about five minutes.

- **Reference-data lookups.** Synthetic physician bills of 10, 50, 100, and 500 lines, built from real codes and real NCCI pairs, are looked up three ways: the app's batched lookup (one indexed `$in` query per collection, run concurrently), three indexed queries per line item in sequence, and the batched queries forced to scan every document. It reports median and p95 times, query counts, documents examined (from MongoDB's `explain`), and checks that every strategy returns the same rows.
- **Audit engine.** All seven checks on reference data already in memory.
- **Extraction check.** Synthetic bills are rendered to PDF and read back with the app's pdf.js reader, then labeled cases go through the verification step: clean lines (full and partial source text), codes misread as other real codes or as nonexistent codes, lines swapped with each other, and wrong charges, on rows printed on one line and rows whose description wraps. It reports how many of each are flagged and which check caught them. Wrong charges are a known blind spot at the line level; the bill-level total check covers them.

Options: `--skip-unindexed`, `--verify-only`, `--trials N`, `--sizes 10,50,100`, `--seed N`.

## Without Docker

Install MongoDB 7 and Node 22, then:

```bash
cd server
npm install
npm test
npm run dev            # API on :4000
npm run dev:worker     # job worker, in a second terminal
```

The `npm run import:*` commands in the next section load the CMS data.

## Frontend

```bash
cd client
cp .env.example .env    # VITE_API_URL points at the API
npm install
npm run dev             # http://localhost:5173
VITE_DEMO=1 npm run dev # no backend: a sample bill whose findings come from the real rules engine and 2026 CMS data
```

The demo build is deployed on Vercel (`client/vercel.json`, project root `client`, environment variable `VITE_DEMO=1`). It runs entirely in the browser on a sample bill and insurance statement, both viewable as PDFs, so it needs no API, database, or Gemini key.

The React app walks a patient through upload, a review screen that marks lines that couldn't be confirmed against the bill, the annotated results (errors struck through in red, pricing concerns highlighted, with the math behind each one), and an editable dispute letter.

## Loading Medicare data

Download from CMS (accept the AMA license; don't commit these files):

- [Physician Fee Schedule](https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files) — the `PPRRVU..._nonQPP.csv` file
- [OPPS Addendum B](https://www.cms.gov/Medicare/Medicare-Fee-For-Service-Payment/HospitalOutpatientPPS/Addendum-A-and-Addendum-B-Updates) — the CSV
- [Clinical Laboratory Fee Schedule](https://www.cms.gov/medicare/payment/fee-schedules/clinical-laboratory-fee-schedule-clfs/files)

```bash
npm run import:fees -- --pfs data/PPRRVU2026_Oct_nonQPP.csv \
  --opps data/OPPS_AddendumB_2026_Jul.csv --clfs data/PUF_CLFS_CY2026_Q4V1.csv [--dry-run]
```

The import streams each file and writes in 1,000-row bulk upserts. With the October 2026 PFS, July 2026 OPPS, and Q4 2026 lab files it loads **19,011 priced rates** (9,526 PFS, 7,360 OPPS, 2,125 lab) plus 2,086 packaged OPPS codes.

Then the coding rules (Q4 2026: the 8 NCCI PTP files from the [PTP edits page](https://www.cms.gov/medicare-medicaid-coordination/national-correct-coding-initiative-ncci/ncci-medicare/medicare-ncci-procedure-procedure-ptp-edits) and the practitioner and outpatient hospital tables from the [MUE page](https://www.cms.gov/medicare-medicaid-coordination/national-correct-coding-initiative-ncci/ncci-medicare/medicare-ncci-medically-unlikely-edits); use the `.txt` and `.csv` files inside the ZIPs):

```bash
npm run import:rules -- \
  --ncci-practitioner 'data/ncci/ccipra-v323r0-f*.txt' --ncci-hospital 'data/ncci/ccioph-v323r0-f*.txt' \
  --mue-practitioner data/ncci/MCR_MUE_PractitionerServices_Eff_10-01-2026.csv \
  --mue-hospital data/ncci/MCR_MUE_OutpatientHospitalServices_Eff_10-01-2026.csv [--since 2024-01-01] [--dry-run]
```

The PTP files are read line by line and inserted in 5,000-row batches. Of 4,506,527 Q4 2026 PTP rows, the import keeps **3,191,316 edits** (1,761,922 practitioner, 1,429,394 hospital): it drops edits CMS marks not applicable (modifier indicator 9) and edits deleted before `--since`. It also loads **30,374 MUE limits**. Each run replaces that table version, so importing a new quarter leaves no stale rules.

## S3 setup

Enable CORS for `PUT` from your frontend origin, and add a lifecycle rule that expires objects under `uploads/` after 30 days.
