// Background jobs racing with patient actions. Storage, PDF reading, Gemini, and the queue are
// faked; MongoDB is real, because the guarantees come from its conditional updates.
import { Types } from 'mongoose';
import request from 'supertest';
import { createApp } from '../../src/app';
import { analyzeBill, extractEob } from '../../src/jobs/processors';
import type { LlmProvider } from '../../src/llm/provider';
import { Bill } from '../../src/models/Bill';
import { User } from '../../src/models/User';
import * as referenceData from '../../src/services/referenceData';
import { clearTestDb, connectTestDb, disconnectTestDb } from './db';

jest.mock('../../src/services/storage', () => ({
  presignUpload: jest.fn(async () => 'https://s3.test/presigned-upload'),
  deleteFile: jest.fn(async () => undefined),
  downloadFile: jest.fn(async () => new Uint8Array()),
}));
jest.mock('../../src/services/pdfText', () => ({
  readPdfText: jest.fn(async () => ['09/14/2026 99214 Office visit 410.00 380.00 102.50 40.00']),
}));
jest.mock('../../src/jobs/queue', () => ({
  ...jest.requireActual('../../src/jobs/queue'),
  enqueue: jest.fn(async () => undefined),
}));

const emptyRef = { rates: [], ncciEdits: [], mueLimits: [] };

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
  process.env.AUTH_RATE_LIMIT = '1000';
  await connectTestDb();
}, 60_000);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDb();
});
afterAll(disconnectTestDb);

const line = (id: string, code: string, charge: number) => ({
  id, code, description: 'Service', modifiers: [], units: 1, charge, dateOfService: '2026-09-14',
  extractionStatus: 'verified', reviewReasons: [], verification: { foundInDocument: true, cmsMatch: true, descriptionMatch: true },
});

async function reviewedBill(extra: Record<string, unknown> = {}) {
  return Bill.create({
    userId: new Types.ObjectId(), fileKey: 'uploads/x.pdf', status: 'analyzing', billType: 'physician',
    lineItems: [line('li-1', '85025', 64), line('li-2', '85025', 64)], ...extra,
  });
}

describe('analysis', () => {
  it('saves its results when nothing changed while it ran', async () => {
    jest.spyOn(referenceData, 'loadReferenceData').mockResolvedValue(emptyRef);
    const bill = await reviewedBill();
    await analyzeBill(bill.id);
    const saved = await Bill.findById(bill.id).lean();
    expect(saved!.status).toBe('complete');
    expect(saved!.findings.map((f) => f.checkId)).toEqual(['duplicates']);
    expect(saved!.findingsVersion).toBe(1);
  });

  it('discards its results if the inputs changed while it ran, leaving them to the newer analysis', async () => {
    const bill = await reviewedBill();
    jest.spyOn(referenceData, 'loadReferenceData').mockImplementation(async () => {
      // The patient removes a statement or re-submits the review mid-audit.
      await Bill.updateOne({ _id: bill._id }, { $inc: { inputsVersion: 1 } });
      return emptyRef;
    });
    await analyzeBill(bill.id);
    const saved = await Bill.findById(bill.id).lean();
    expect(saved!.findings).toHaveLength(0);
    expect(saved!.status).toBe('analyzing');
    expect(saved!.findingsVersion ?? 0).toBe(0);
  });
});

describe('insurance statement extraction', () => {
  const eob = (id: string) => ({ id, fileKey: `uploads/${id}.pdf`, status: 'pending', lines: [] });
  const llm = (onRead: () => Promise<void>) =>
    ({
      extractEob: jest.fn(async () => {
        await onRead();
        return {
          data: {
            payer: 'Peachtree Health Plan',
            lines: [{ dateOfService: '2026-09-14', code: '99214', description: 'Office visit', billed: 380, patientResponsibility: 40, sourceText: '99214 Office visit 410.00 380.00' }],
          },
          model: 'fake-model',
        };
      }),
    }) as unknown as LlmProvider;

  it('updates the right statement even if another one is removed while it is being read', async () => {
    const bill = await reviewedBill({ status: 'complete', eobs: [eob('eob-a'), eob('eob-b')] });
    await extractEob(bill.id, 'eob-b', llm(async () => {
      // The patient deletes the first statement, shifting eob-b to index 0.
      await Bill.updateOne({ _id: bill._id }, { $pull: { eobs: { id: 'eob-a' } } });
    }));
    const saved = (await Bill.findById(bill.id).lean())!;
    expect(saved.eobs.map((e) => e.id)).toEqual(['eob-b']);
    expect(saved.eobs[0].status).toBe('ready');
    expect(saved.eobs[0].payer).toBe('Peachtree Health Plan');
    expect(saved.eobs[0].lines).toHaveLength(1);
    expect(saved.inputsVersion).toBe(1);
  });

  it('does nothing if its own statement was removed while it was being read', async () => {
    const bill = await reviewedBill({ status: 'complete', eobs: [eob('eob-a')] });
    await extractEob(bill.id, 'eob-a', llm(async () => {
      await Bill.updateOne({ _id: bill._id }, { $pull: { eobs: { id: 'eob-a' } } });
    }));
    const saved = (await Bill.findById(bill.id).lean())!;
    expect(saved.eobs).toHaveLength(0);
    expect(saved.inputsVersion ?? 0).toBe(0);
  });
});

describe('review', () => {
  it('marks a line the patient corrected as corrected, not verified', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await agent.post('/auth/signup').send({ name: 'Pat', email: 'pat@example.com', password: 'correct-horse-battery' }).expect(201);
    const user = await User.findOne({ email: 'pat@example.com' });
    const bill = await reviewedBill({ userId: user!._id, status: 'awaiting_review' });
    const items = bill.lineItems.map((l) => ({
      id: l.id, code: l.id === 'li-2' ? '81003' : l.code, description: l.description, modifiers: [], units: l.units, charge: l.charge, dateOfService: l.dateOfService, notReceived: false,
    }));
    await agent.put(`/bills/${bill.id}/review`).send({ admissionAnswer: 'not_admitted', lineItems: items }).expect(202);
    const saved = (await Bill.findById(bill.id).lean())!;
    expect(saved.lineItems.map((l) => l.extractionStatus)).toEqual(['verified', 'corrected']);
    expect(saved.inputsVersion).toBe(1);
  });
});
