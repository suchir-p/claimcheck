import request from 'supertest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { clearTestDb, connectTestDb, disconnectTestDb } from './db';

const app = createApp();

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
  process.env.AUTH_RATE_LIMIT = '1000';
  await connectTestDb();
}, 60_000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('cross-site request protection', () => {
  const login = () => request(app).post('/auth/login').send({ email: 'someone@example.com', password: 'wrong-password-123' });

  it('rejects a state-changing request sent from another website', async () => {
    const res = await login().set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Cross-site request blocked');
  });

  it('allows requests from the app itself', async () => {
    expect((await login().set('Origin', config.clientOrigin)).status).toBe(401);
  });

  it('allows requests without an Origin header, which carry no browser cookies', async () => {
    expect((await login()).status).toBe(401);
  });

  it('never blocks reads', async () => {
    expect((await request(app).get('/health').set('Origin', 'https://evil.example')).status).toBe(200);
  });
});
