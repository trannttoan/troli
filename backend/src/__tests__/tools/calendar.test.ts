import { afterEach, describe, expect, it, vi } from 'vitest';

import { TroliAuthError } from '../../utils/auth.js';
import { fetchWithAuth, GoogleApiError } from '../../utils/google-api.js';

vi.mock('../../utils/google-api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/google-api.js')>();

  return {
    ...actual,
    fetchWithAuth: vi.fn(),
  };
});

import { getCalendarEvent, listCalendarEvents } from '../../tools/calendar.js';

afterEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
});

describe('listCalendarEvents', () => {
  it('calls the Google Calendar events endpoint with the expected query params', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [
        {
          id: 'event-1',
          summary: 'Team Sync',
          location: 'Conference Room',
          start: { dateTime: '2026-01-16T09:00:00-05:00' },
          end: { dateTime: '2026-01-16T09:30:00-05:00' },
        },
        {
          id: 'event-2',
          summary: 'Offsite',
          start: { date: '2026-01-17' },
          end: { date: '2026-01-18' },
        },
      ],
    });

    const result = await listCalendarEvents.invoke(
      {
        timeMin: '2026-01-16T00:00:00-05:00',
        timeMax: '2026-01-18T00:00:00-05:00',
        query: 'team',
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('Calendar events:');
    expect(result).toContain('Team Sync @ Conference Room');
    expect(result).toContain('2026-01-17 (all day)');
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=2026-01-16T00%3A00%3A00-05%3A00&timeMax=2026-01-18T00%3A00%3A00-05%3A00&q=team',
      expect.objectContaining({ method: 'GET' }),
      'calendar-access-token',
    );
  });

  it('returns a friendly empty state when no events are found', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ items: [] });

    await expect(
      listCalendarEvents.invoke(
        {},
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe('No calendar events found.');
  });

  it('formats a multi-day all-day event with inclusive end date', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      items: [
        {
          id: 'event-multi',
          summary: 'Company Retreat',
          start: { date: '2026-02-10' },
          end: { date: '2026-02-13' },
        },
      ],
    });

    const result = await listCalendarEvents.invoke(
      {},
      { configurable: { access_token: 'calendar-access-token' } },
    );

    expect(result).toContain('2026-02-10 to 2026-02-12 (all day)');
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      listCalendarEvents.invoke({}, {}),
    ).rejects.toMatchObject<TroliAuthError>({
      code: 'AUTH_MISSING_ACCESS_TOKEN',
      retryable: false,
      status: 401,
    });
  });
});

describe('getCalendarEvent', () => {
  it('fetches an event by ID and returns formatted event details', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'abc',
      summary: 'Planning Offsite',
      location: 'HQ',
      description: 'Review roadmap and assign owners.',
      attendees: [{ email: 'lead@example.com' }, { email: 'pm@example.com' }],
      status: 'confirmed',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=abc',
      start: { date: '2026-02-10' },
      end: { date: '2026-02-13' },
    });

    const result = await getCalendarEvent.invoke(
      { eventId: 'abc' },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('Event: Planning Offsite');
    expect(result).toContain('When: 2026-02-10 to 2026-02-12 (all day)');
    expect(result).toContain('Location: HQ');
    expect(result).toContain('Description: Review roadmap and assign owners.');
    expect(result).toContain('Attendees: lead@example.com, pm@example.com');
    expect(result).toContain('Status: confirmed');
    expect(result).toContain(
      'Link: https://calendar.google.com/calendar/event?eid=abc',
    );
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/abc',
      expect.objectContaining({ method: 'GET' }),
      'calendar-access-token',
    );
  });

  it('omits optional fields when they are absent from the event response', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'event-123',
      summary: 'Focus Block',
      status: 'tentative',
      start: { dateTime: '2026-01-16T13:00:00-05:00' },
      end: { dateTime: '2026-01-16T15:00:00-05:00' },
    });

    const result = await getCalendarEvent.invoke(
      { eventId: 'event-123' },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain(
      'When: 2026-01-16T13:00:00-05:00 to 2026-01-16T15:00:00-05:00',
    );
    expect(result).toContain('Status: tentative');
    expect(result).not.toContain('Location:');
    expect(result).not.toContain('Description:');
    expect(result).not.toContain('Attendees:');
  });

  it('returns a friendly not-found message when the Google API responds with 404', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(
      new GoogleApiError(
        'GOOGLE_API_REQUEST_FAILED',
        'Google API request failed with status 404.',
        {
          retryable: false,
          status: 404,
        },
      ),
    );

    await expect(
      getCalendarEvent.invoke(
        { eventId: 'abc' },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).resolves.toBe("No event found with ID 'abc'.");
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      getCalendarEvent.invoke({ eventId: 'abc' }, {}),
    ).rejects.toMatchObject<TroliAuthError>({
      code: 'AUTH_MISSING_ACCESS_TOKEN',
      retryable: false,
      status: 401,
    });
  });
});
