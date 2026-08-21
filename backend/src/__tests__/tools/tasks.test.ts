import { afterEach, describe, expect, it, vi } from 'vitest';

import { AisistAuthError } from '../../utils/auth.js';
import { fetchWithAuth } from '../../utils/google-api.js';

vi.mock('../../utils/google-api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/google-api.js')>();

  return {
    ...actual,
    fetchWithAuth: vi.fn(),
  };
});

import { listTaskLists } from '../../tools/tasks.js';

afterEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
});

describe('listTaskLists', () => {
  it('calls the Google Tasks lists endpoint and formats the result', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [
        { id: 'list-1', title: 'My Tasks' },
        { id: 'list-2', title: 'Groceries' },
      ],
    });

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/tasks/v1/users/@me/lists?maxResults=100',
      { method: 'GET' },
      'token-123',
    );
    expect(result).toBe(
      'Task lists:\n- My Tasks (id: list-1)\n- Groceries (id: list-2)',
    );
  });

  it('falls back to a placeholder title when a list has none', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [{ id: 'list-1', title: '   ' }, { id: 'list-2' }],
    });

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'Task lists:\n- Untitled list (id: list-1)\n- Untitled list (id: list-2)',
    );
  });

  it('returns an empty-state message when no task lists exist', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ items: [] });

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No task lists found.');
  });

  it('returns an empty-state message when the response omits items', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({});

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No task lists found.');
  });

  it('returns an empty-state message when the response body is empty', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(null);

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe('No task lists found.');
  });

  it('appends a truncation note when more task lists exist', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [{ id: 'list-1', title: 'My Tasks' }],
      nextPageToken: 'next-page',
    });

    const result = await listTaskLists.invoke(
      {},
      { configurable: { access_token: 'token-123' } },
    );

    expect(result).toBe(
      'Task lists:\n- My Tasks (id: list-1)\n\nNote: only the first 100 task lists are shown; more exist. Tell the user the list is incomplete.',
    );
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      listTaskLists.invoke({}, { configurable: {} }),
    ).rejects.toThrow(AisistAuthError);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
