import { tool } from '@langchain/core/tools';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';

import { TroliAuthError } from '../utils/auth.js';
import { fetchWithAuth } from '../utils/google-api.js';

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
  displayName?: string;
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

type CreateCalendarEventInput = {
  summary: string;
  startDateTime?: string;
  endDateTime?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  description?: string;
  attendees?: string[];
};

type CreateCalendarEventRequestBody = {
  summary: string;
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
  location?: string;
  description?: string;
  attendees?: Array<{ email: string }>;
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

function exclusiveEndToInclusive(exclusiveEnd: string): string {
  const date = new Date(exclusiveEnd + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() - 1);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function inclusiveEndToExclusive(inclusiveEnd: string): string {
  const date = new Date(inclusiveEnd + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
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

function formatEventAttendee(attendee: CalendarEventAttendee): string | null {
  const email = attendee.email?.trim();
  const displayName = attendee.displayName?.trim();

  if (displayName && email) {
    return `${displayName} <${email}>`;
  }

  if (email) {
    return email;
  }

  if (displayName) {
    return displayName;
  }

  return null;
}

function formatEventDetail(event: DetailedCalendarEvent): string {
  const summary = event.summary?.trim() || 'Untitled event';
  const lines = [`Event: ${summary}`, `When: ${formatEventDateRange(event)}`];
  const location = event.location?.trim();
  const description = event.description?.trim();
  const attendees = (event.attendees ?? [])
    .map(formatEventAttendee)
    .filter((attendee): attendee is string => attendee !== null);
  const status = event.status?.trim();
  const htmlLink = event.htmlLink?.trim();

  if (location) {
    lines.push(`Location: ${location}`);
  }

  if (description) {
    lines.push(`Description: ${description}`);
  }

  if (attendees.length > 0) {
    lines.push(`Attendees: ${attendees.join(', ')}`);
  }

  if (status) {
    lines.push(`Status: ${status}`);
  }

  if (htmlLink) {
    lines.push(`Link: ${htmlLink}`);
  }

  return lines.join('\n');
}

function buildEventRequestBody(
  input: CreateCalendarEventInput,
): CreateCalendarEventRequestBody {
  const requestBody: CreateCalendarEventRequestBody = {
    summary: input.summary,
    start: input.startDateTime
      ? { dateTime: input.startDateTime }
      : { date: input.startDate! },
    end: input.endDateTime
      ? { dateTime: input.endDateTime }
      : {
          date: inclusiveEndToExclusive(input.endDate ?? input.startDate!),
        },
  };

  if (input.location) {
    requestBody.location = input.location;
  }

  if (input.description) {
    requestBody.description = input.description;
  }

  if (input.attendees && input.attendees.length > 0) {
    requestBody.attendees = input.attendees.map((email) => ({ email }));
  }

  return requestBody;
}

const createCalendarEventSchema = z
  .object({
    summary: z.string().trim().min(1).describe('Title for the calendar event.'),
    startDateTime: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('RFC3339 start date-time for a timed event.'),
    endDateTime: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('RFC3339 end date-time for a timed event.'),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Start date for an all-day event in YYYY-MM-DD format.'),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Inclusive end date for an all-day event in YYYY-MM-DD format.',
      ),
    location: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Optional event location.'),
    description: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Optional event description.'),
    attendees: z
      .array(z.string().trim().email())
      .optional()
      .describe('Optional list of attendee email addresses.'),
  })
  .superRefine((value, ctx) => {
    const hasTimedStart = value.startDateTime !== undefined;
    const hasTimedEnd = value.endDateTime !== undefined;
    const hasAllDayStart = value.startDate !== undefined;
    const hasAllDayEnd = value.endDate !== undefined;

    if ((hasTimedStart || hasTimedEnd) && (hasAllDayStart || hasAllDayEnd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Timed and all-day event fields cannot be combined.',
      });
    }

    if (hasTimedStart !== hasTimedEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Timed events require both startDateTime and endDateTime.',
      });
    }

    if (hasAllDayEnd && !hasAllDayStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endDate requires startDate for all-day events.',
        path: ['endDate'],
      });
    }

    if (!hasTimedStart && !hasAllDayStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Provide either startDateTime/endDateTime or startDate/endDate.',
      });
    }
  });

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
    const response = await fetchWithAuth<DetailedCalendarEvent>(
      `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/primary/events/${encodeURIComponent(eventId)}`,
      {
        method: 'GET',
      },
      accessToken,
    );

    return formatEventDetail(response ?? { id: eventId });
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
        .describe('Google Calendar event ID to retrieve.'),
    }),
  },
);

export const createCalendarEvent = tool(
  async (input, config) => {
    const accessToken = getAccessToken(config);
    const response = await fetchWithAuth<DetailedCalendarEvent>(
      `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/primary/events`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildEventRequestBody(input)),
      },
      accessToken,
    );

    return formatEventDetail(response ?? { id: 'created-event' });
  },
  {
    name: 'create_calendar_event',
    description:
      "Create an event on the user's primary Google Calendar, either timed or all-day.",
    schema: createCalendarEventSchema,
  },
);

export const calendarTools = [
  listCalendarEvents,
  getCalendarEvent,
  createCalendarEvent,
];
