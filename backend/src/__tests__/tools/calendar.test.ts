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

import {
  createCalendarEvent,
  getCalendarEvent,
  listCalendarEvents,
} from '../../tools/calendar.js';

describe('listCalendarEvents', () => {
  afterEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
  });

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
  afterEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
  });

  it('fetches an event by ID and returns formatted details', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'event-123',
      summary: 'Design Review',
      location: 'Room 301',
      description: 'Review the Q1 launch plan',
      attendees: [
        { email: 'alex@example.com' },
        { displayName: 'Sam Lee', email: 'sam@example.com' },
      ],
      status: 'confirmed',
      htmlLink: 'https://calendar.google.com/event?eid=event-123',
      start: { dateTime: '2026-03-04T14:00:00-05:00' },
      end: { dateTime: '2026-03-04T15:00:00-05:00' },
    });

    const result = await getCalendarEvent.invoke(
      { eventId: 'event-123' },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('Event: Design Review');
    expect(result).toContain(
      'When: 2026-03-04T14:00:00-05:00 to 2026-03-04T15:00:00-05:00',
    );
    expect(result).toContain('Location: Room 301');
    expect(result).toContain('Description: Review the Q1 launch plan');
    expect(result).toContain(
      'Attendees: alex@example.com, Sam Lee <sam@example.com>',
    );
    expect(result).toContain('Status: confirmed');
    expect(result).toContain(
      'Link: https://calendar.google.com/event?eid=event-123',
    );
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/event-123',
      expect.objectContaining({ method: 'GET' }),
      'calendar-access-token',
    );
  });

  it('omits absent optional fields and formats all-day dates with an inclusive end', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'event-all-day',
      summary: 'Company Retreat',
      status: 'tentative',
      start: { date: '2026-04-10' },
      end: { date: '2026-04-13' },
    });

    const result = await getCalendarEvent.invoke(
      { eventId: 'event-all-day' },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('Event: Company Retreat');
    expect(result).toContain('When: 2026-04-10 to 2026-04-12 (all day)');
    expect(result).toContain('Status: tentative');
    expect(result).not.toContain('Location:');
    expect(result).not.toContain('Description:');
    expect(result).not.toContain('Attendees:');
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      getCalendarEvent.invoke({ eventId: 'event-123' }, {}),
    ).rejects.toMatchObject<TroliAuthError>({
      code: 'AUTH_MISSING_ACCESS_TOKEN',
      retryable: false,
      status: 401,
    });
  });

  it('propagates Google API errors such as not found', async () => {
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
        { eventId: 'missing-event' },
        {
          configurable: {
            access_token: 'calendar-access-token',
          },
        },
      ),
    ).rejects.toMatchObject<GoogleApiError>({
      code: 'GOOGLE_API_REQUEST_FAILED',
      retryable: false,
      status: 404,
    });
  });
});

describe('createCalendarEvent', () => {
  afterEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
  });

  it('creates a timed event and returns formatted details', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'event-created',
      summary: 'Meeting',
      start: { dateTime: '2026-05-01T10:00:00-04:00' },
      end: { dateTime: '2026-05-01T11:00:00-04:00' },
      status: 'confirmed',
      htmlLink: 'https://calendar.google.com/event?eid=event-created',
    });

    const result = await createCalendarEvent.invoke(
      {
        summary: 'Meeting',
        startDateTime: '2026-05-01T10:00:00-04:00',
        endDateTime: '2026-05-01T11:00:00-04:00',
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('Event: Meeting');
    expect(result).toContain(
      'When: 2026-05-01T10:00:00-04:00 to 2026-05-01T11:00:00-04:00',
    );
    expect(result).toContain('Status: confirmed');
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: 'Meeting',
          start: { dateTime: '2026-05-01T10:00:00-04:00' },
          end: { dateTime: '2026-05-01T11:00:00-04:00' },
        }),
      }),
      'calendar-access-token',
    );
  });

  it('creates a single-day all-day event with an exclusive end date', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'event-all-day',
      summary: 'Focus Day',
      start: { date: '2026-02-10' },
      end: { date: '2026-02-11' },
      status: 'confirmed',
    });

    const result = await createCalendarEvent.invoke(
      {
        summary: 'Focus Day',
        startDate: '2026-02-10',
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('When: 2026-02-10 (all day)');
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          summary: 'Focus Day',
          start: { date: '2026-02-10' },
          end: { date: '2026-02-11' },
        }),
      }),
      'calendar-access-token',
    );
  });

  it('creates a multi-day all-day event and maps attendees', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      id: 'event-retreat',
      summary: 'Retreat',
      location: 'Lakeside',
      description: 'Team offsite',
      attendees: [{ email: 'a@b.com' }],
      start: { date: '2026-02-10' },
      end: { date: '2026-02-13' },
      status: 'confirmed',
    });

    const result = await createCalendarEvent.invoke(
      {
        summary: 'Retreat',
        startDate: '2026-02-10',
        endDate: '2026-02-12',
        location: 'Lakeside',
        description: 'Team offsite',
        attendees: ['a@b.com'],
      },
      {
        configurable: {
          access_token: 'calendar-access-token',
        },
      },
    );

    expect(result).toContain('When: 2026-02-10 to 2026-02-12 (all day)');
    expect(result).toContain('Location: Lakeside');
    expect(result).toContain('Description: Team offsite');
    expect(result).toContain('Attendees: a@b.com');
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          summary: 'Retreat',
          start: { date: '2026-02-10' },
          end: { date: '2026-02-13' },
          location: 'Lakeside',
          description: 'Team offsite',
          attendees: [{ email: 'a@b.com' }],
        }),
      }),
      'calendar-access-token',
    );
  });

  it('rejects invalid date combinations before calling the API', async () => {
    await expect(
      createCalendarEvent.invoke(
        { summary: 'Missing time' },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow();

    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Mixed event',
          startDateTime: '2026-05-01T10:00:00-04:00',
          endDateTime: '2026-05-01T11:00:00-04:00',
          startDate: '2026-05-01',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow();

    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Missing timed end',
          startDateTime: '2026-05-01T10:00:00-04:00',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow();

    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Missing timed start',
          endDateTime: '2026-05-01T11:00:00-04:00',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow();

    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Missing all-day start',
          endDate: '2026-05-02',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow();

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects impossible calendar dates', async () => {
    await expect(
      createCalendarEvent.invoke(
        { summary: 'Bad date', startDate: '2026-02-31' },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow();

    await expect(
      createCalendarEvent.invoke(
        { summary: 'Bad date', startDate: '2026-06-31' },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow();

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects inverted date ranges', async () => {
    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Backwards all-day',
          startDate: '2026-03-15',
          endDate: '2026-03-10',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow();

    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Backwards timed',
          startDateTime: '2026-05-01T14:00:00-04:00',
          endDateTime: '2026-05-01T10:00:00-04:00',
        },
        { configurable: { access_token: 'calendar-access-token' } },
      ),
    ).rejects.toThrow();

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('rejects when the access token is missing from the run config', async () => {
    await expect(
      createCalendarEvent.invoke(
        {
          summary: 'Meeting',
          startDateTime: '2026-05-01T10:00:00-04:00',
          endDateTime: '2026-05-01T11:00:00-04:00',
        },
        {},
      ),
    ).rejects.toMatchObject<TroliAuthError>({
      code: 'AUTH_MISSING_ACCESS_TOKEN',
      retryable: false,
      status: 401,
    });
  });
});
