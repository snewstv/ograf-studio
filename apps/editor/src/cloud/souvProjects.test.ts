import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getSouvAccID, setSouvAccID, setSouvToken } from './souvAuth';
import { listSouvAccounts } from './souvProjects';

// Cut the DOM-heavy state chain (fileIO/export/thumbnail pull canvas + the
// graphic runtime at module level); the account logic never touches them.
vi.mock('../state/fileIO', () => ({ openProjectFromUrl: vi.fn() }));
vi.mock('../state/exportPackage', () => ({
  blobToBase64: vi.fn(),
  buildCertifiedZip: vi.fn(),
}));
vi.mock('../state/templateThumbnail', () => ({ createTemplateThumbnail: vi.fn() }));
// Keep the real auth/account state, but pin the API base: import.meta.env is
// snapshotted at module import in vitest, so env stubbing cannot reach it.
vi.mock('./souvAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./souvAuth')>();
  return { ...actual, getSouvApiBase: () => 'https://api.example.test' };
});

/**
 * Regression: the Souv backend computes `UserAccount.isMe` from the member
 * row JSON, whose `id` is the member user — so it returns `isMe: true` for
 * invited accounts too. The editor must derive the personal account from
 * `userMe { id }` instead, or every selection collapses to personal.
 */
describe('listSouvAccounts personal-account derivation', () => {
  let lastRequestBody = '';

  beforeAll(() => {
    setSouvToken('test-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        lastRequestBody = typeof init?.body === 'string' ? init.body : '';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              userMe: { id: 'me-1' },
              userAccounts: [
                {
                  id: 'me-1',
                  title: 'Minha Conta',
                  isMe: true,
                  permission: { visaoEffective: { canWrite: true } },
                },
                {
                  id: 'acc-2',
                  title: 'Equipe Convidada',
                  // Backend bug shape: invited rows also arrive with isMe true.
                  isMe: true,
                  permission: { visaoEffective: { canWrite: true } },
                },
              ],
            },
          }),
        };
      }),
    );
  });

  it('marks only the login account as personal', async () => {
    const accounts = await listSouvAccounts();
    // Pin the contract that feeds the derivation: dropping `userMe` from the
    // query must fail this test, not just the real backend.
    expect(lastRequestBody).toContain('userMe');
    expect(accounts.map((account) => [account.id, account.isMe])).toEqual([
      ['me-1', true],
      ['acc-2', false],
    ]);
  });

  it('keeps an invited-account selection instead of collapsing to personal', async () => {
    setSouvAccID('acc-2', 'Equipe Convidada');
    await listSouvAccounts();
    expect(getSouvAccID()).toBe('acc-2');
    setSouvAccID(null);
  });
});
