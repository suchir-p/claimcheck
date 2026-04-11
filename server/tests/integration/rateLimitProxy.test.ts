import request from 'supertest';
import { createApp } from '../../src/app';
import { clearTestDb, connectTestDb, disconnectTestDb } from './db';

// Its own file, so the limiter's in-memory counter starts fresh. TRUST_PROXY_HOPS is unset, as
// when the API is reached directly.
process.env.AUTH_RATE_LIMIT = '3';
const app = createApp();

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
  await connectTestDb();
}, 60_000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('ignores a spoofed X-Forwarded-For header, so changing it does not reset the limit', async () => {
  const attempt = (i: number) =>
    request(app).post('/auth/login').set('X-Forwarded-For', `203.0.113.${i}`).send({ email: 'target@example.com', password: 'guess-number-xyz' });
  for (let i = 0; i < 3; i++) expect((await attempt(i)).status).toBe(401);
  expect((await attempt(99)).status).toBe(429);
});
