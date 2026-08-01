import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { fetchWithAuth } from '../utils/google-api.js';
import { getAccessToken } from '../utils/tool-config.js';

const GOOGLE_TASKS_API_BASE_URL = 'https://www.googleapis.com/tasks/v1';

type TaskList = {
  id: string;
  title?: string;
};

type ListTaskListsResponse = {
  items?: TaskList[];
  nextPageToken?: string;
};

// The Tasks API defaults to 20 results per page, low enough that a normal
// account can be silently truncated; 100 is the documented maximum.
const MAX_LIST_RESULTS = 100;

function buildListTaskListsUrl(): string {
  const url = new URL(`${GOOGLE_TASKS_API_BASE_URL}/users/@me/lists`);

  url.searchParams.set('maxResults', String(MAX_LIST_RESULTS));

  return url.toString();
}

function formatTaskLists(taskLists: TaskList[]): string {
  if (taskLists.length === 0) {
    return 'No task lists found.';
  }

  const lines = taskLists.map((taskList) => {
    const title = taskList.title?.trim() || 'Untitled list';

    return `- ${title} (id: ${taskList.id})`;
  });

  return `Task lists:\n${lines.join('\n')}`;
}

export const listTaskLists = tool(
  async (_input, config) => {
    const accessToken = getAccessToken(config);
    const response = await fetchWithAuth<ListTaskListsResponse>(
      buildListTaskListsUrl(),
      {
        method: 'GET',
      },
      accessToken,
    );

    const formatted = formatTaskLists(response?.items ?? []);

    if (response?.nextPageToken) {
      return `${formatted}\n\nNote: only the first ${MAX_LIST_RESULTS} task lists are shown; more exist. Tell the user the list is incomplete.`;
    }

    return formatted;
  },
  {
    name: 'list_task_lists',
    description:
      "List the user's Google Tasks lists. Use this to resolve a task list name to the ID that the other task tools require.",
    schema: z.object({}),
  },
);

export const taskTools = [listTaskLists];
