import { describe, expect, it } from 'vitest';
import { InMemorySimulatorStore, SimulatorConnector } from './simulator';

const creds = { accessToken: 'simulator', scopes: [] };
const base = {
  credentials: creds,
  accountExternalId: 'acc',
  interactionExternalId: 'sim-1',
  idempotencyKey: 'k1',
};

describe('SimulatorConnector', () => {
  it('genera datos ficticios marcados y pagina', async () => {
    const store = new InMemorySimulatorStore();
    const c = new SimulatorConnector(store, 'acc');
    await c.simulateNewReviews(7, 0);
    const p1 = await c.fetchInteractions({
      credentials: creds,
      accountExternalId: 'acc',
      pageSize: 5,
    });
    expect(p1.ok && p1.value.items).toHaveLength(5);
    expect(p1.ok && p1.value.nextCursor).toBe('5');
    const p2 = await c.fetchInteractions({
      credentials: creds,
      accountExternalId: 'acc',
      pageSize: 5,
      cursor: '5',
    });
    expect(p2.ok && p2.value.items).toHaveLength(2);
    expect(p1.ok && p1.value.items.every((i) => i.authorName?.includes('ficticio'))).toBe(true);
  });

  it('declara capacidades reales y no simula OAuth', async () => {
    const c = new SimulatorConnector(new InMemorySimulatorStore(), 'acc');
    expect((await c.getCapabilities()).supported.has('webhooks')).toBe(false);
    expect((await c.connect()).ok).toBe(false);
  });

  it('modo ambiguo: publica en remoto pero devuelve error; la consulta lo confirma', async () => {
    const store = new InMemorySimulatorStore();
    const c = new SimulatorConnector(store, 'acc', { publishMode: 'ambiguous' });
    const r = await c.publishReply({ ...base, content: 'Gracias' });
    expect(!r.ok && r.error.kind).toBe('ambiguous');
    const st = await c.getPublicationStatus({ ...base, expectedContent: 'Gracias' });
    expect(st.ok && st.value.status).toBe('published');
    const other = await c.getPublicationStatus({ ...base, expectedContent: 'Otro texto' });
    expect(other.ok && other.value.status).toBe('rejected');
  });

  it('modos de fallo', async () => {
    const store = new InMemorySimulatorStore();
    const rl = await new SimulatorConnector(store, 'acc', {
      publishMode: 'rate_limited',
    }).publishReply({ ...base, content: 'x' });
    expect(!rl.ok && rl.error).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterSec: 30,
    });
    const ex = await new SimulatorConnector(store, 'acc', {
      syncMode: 'credentials_expired',
    }).fetchInteractions({ credentials: creds, accountExternalId: 'acc' });
    expect(!ex.ok && ex.error.kind).toBe('credentials_expired');
    expect(await store.getReply('acc', 'sim-1')).toBeNull();
  });
});
