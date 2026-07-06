import { tool } from '@langchain/core/tools';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';

import { TroliAuthError } from '../utils/auth.js';
import { fetchWithAuth, GoogleApiError } from '../utils/google-api.js';

const GOOGLE_CALENDAR_API_BASE_URL = 'https://www.googleapis.com/calendar/v3';

type CalendarEventDateTime = {
  date?: string;
  dateTime?: string;
};

type CalendarEvent = {
  id: string;
  summary?: string;
  location?: string;
  start?: CalendarEventDateTime;
  end?: CalendarEventDateTime;
};

type CalendarEventAttendee = {
  email?: string;
};

type DetailedCalendarEvent = CalendarEvent & {
  description?: string;
  attendees?: CalendarEventAttendee[];
  status?: string;
  htmlLink?: string;
};

type ListCalendarEventsResponse = {
  items?: CalendarEvent[];
};

function getAccessToken(config: LangGraphRunnableConfig): string {
  const configurable = config.configurable as
    | Record<string, unknown>
    | undefined;
  const accessToken = configurable?.access_token;

  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw new TroliAuthError(
      'AUTH_MISSING_ACCESS_TOKEN',
      'Missing Google access token in run config.',
      {
        retryable: false,
        status: 401,
      },
    );
  }

  return accessToken.trim();
}

function buildListCalendarEventsUrl(input: {
  timeMin?: string;
  timeMax?: string;
  query?: string;
}): string {
  const url = new URL(
    `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/primary/events`,
  );

  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');

  if (input.timeMin) {
    url.searchParams.set('timeMin', input.timeMin);
  }

  if (input.timeMax) {
    url.searchParams.set('timeMax', input.timeMax);
  }

  if (input.query) {
    url.searchParams.set('q', input.query);
  }

  return url.toString();
}

function buildGetCalendarEventUrl(eventId: string): string {
  return `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/primary/events/${encodeURIComponent(eventId)}`;
}

function exclusiveEndToInclusive(exclusiveEnd: string): string {
  const date = new Date(exclusiveEnd + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() - 1);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatEventDateRange(event: CalendarEvent): string {
  const start = event.start?.dateTime ?? event.start?.date;
  const end = event.end?.dateTime ?? event.end?.date;

  if (event.start?.date && !event.start.dateTime) {
    if (!end) {
      return `${start} (all day)`;
    }
    const inclusiveEnd = exclusiveEndToInclusive(end);
    return inclusiveEnd === start
      ? `${start} (all day)`
      : `${start} to ${inclusiveEnd} (all day)`;
  }

  if (start && end) {
    return `${start} to ${end}`;
  }

  if (start) {
    return start;
  }

  return 'time unavailable';
}

function formatCalendarEvents(events: CalendarEvent[]): string {
  if (events.length === 0) {
    return 'No calendar events found.';
  }

  const lines = events.map((event) => {
    const summary = event.summary?.trim() || 'Untitled event';
    const location = event.location?.trim()
      ? ` @ ${event.location.trim()}`
      : '';

    return `- ${formatEventDateRange(event)} — ${summary}${location}`;
  });

  return `Calendar events:\n${lines.join('\n')}`;
}

function formatEventDetail(event: DetailedCalendarEvent): string {
  const summary = event.summary?.trim() || 'Untitled event';
  const lines = [`Event: ${summary}`, `When: ${formatEventDateRange(event)}`];
  const location = event.location?.trim();
  const description = event.description?.trim();
  const attendeeEmails =
    event.attendees
      ?.map((attendee) => attendee.email?.trim())
      .filter((email): email is string => Boolean(email)) ?? [];
  const status = event.status?.trim();
  const htmlLink = event.htmlLink?.trim();

  if (location) {
    lines.push(`Location: ${location}`);
  }

  if (description) {
    lines.push(`Description: ${description}`);
  }

  if (attendeeEmails.length > 0) {
    lines.push(`Attendees: ${attendeeEmails.join(', ')}`);
  }

  if (status) {
    lines.push(`Status: ${status}`);
  }

  if (htmlLink) {
    lines.push(`Link: ${htmlLink}`);
  }

  return lines.join('\n');
}

export const listCalendarEvents = tool(
  async ({ timeMin, timeMax, query }, config) => {
    const accessToken = getAccessToken(config);
    const response = await fetchWithAuth<ListCalendarEventsResponse>(
      buildListCalendarEventsUrl({ timeMin, timeMax, query }),
      {
        method: 'GET',
      },
      accessToken,
    );

    return formatCalendarEvents(response?.items ?? []);
  },
  {
    name: 'list_calendar_events',
    description:
      "List events from the user's primary Google Calendar within an optional time range or search query.",
    schema: z.object({
      timeMin: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe('Inclusive RFC3339 lower bound for event start times.'),
      timeMax: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe('Exclusive RFC3339 upper bound for event start times.'),
      query: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Free-text search query for matching event details.'),
    }),
  },
);

export const getCalendarEvent = tool(
  async ({ eventId }, config) => {
    const accessToken = getAccessToken(config);

    try {
      const event = await fetchWithAuth<DetailedCalendarEvent>(
        buildGetCalendarEventUrl(eventId),
        {
          method: 'GET',
        },
        accessToken,
      );

      return formatEventDetail(
        event ?? {
          id: eventId,
        },
      );
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        return `No event found with ID '${eventId}'.`;
      }

      throw error;
    }
  },
  {
    name: 'get_calendar_event',
    description:
      "Get the details for a single event from the user's primary Google Calendar.",
    schema: z.object({
      eventId: z
        .string()
        .trim()
        .min(1)
        .describe('The Google Calendar event ID to fetch.'),
    }),
  },
);

export const calendarTools = [listCalendarEvents, getCalendarEvent];
