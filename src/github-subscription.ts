import { githubFetch } from './transports/github-api.js';

export interface MuteIssueOptions {
  token?: string;
  fetchFn?: typeof fetch;
}

export interface MuteIssueResult {
  ok: boolean;
  detail: string;
}

const GRAPHQL_URL = 'https://api.github.com/graphql';

const MUTE_MUTATION =
  'mutation($id:ID!){updateSubscription(input:{subscribableId:$id,state:IGNORED}){subscribable{viewerSubscription}}}';

/**
 * Silences GitHub notifications for a bus (or presence) issue, via the
 * `updateSubscription` GraphQL mutation (SPEC-v0.7 §3.4). Looks up the
 * issue's `node_id` over REST first, since the mutation needs a GraphQL node
 * id rather than the issue number.
 *
 * Never throws: per the spec, a failure to mute is a warning, not an error —
 * callers should log `detail` and move on.
 */
export async function muteIssue(
  ownerRepo: string,
  issueNumber: number,
  opts: MuteIssueOptions = {},
): Promise<MuteIssueResult> {
  try {
    const [owner, repo] = ownerRepo.split('/');
    if (!owner || !repo) {
      return { ok: false, detail: `Invalid owner/repo "${ownerRepo}"` };
    }

    const issueResponse = await githubFetch(`/repos/${owner}/${repo}/issues/${issueNumber}`, { method: 'GET' }, opts);
    if (!issueResponse.ok) {
      const text = await issueResponse.text();
      return {
        ok: false,
        detail: `Could not read issue ${ownerRepo}#${issueNumber} (${issueResponse.status}): ${text.slice(0, 200)}`,
      };
    }

    const issue = (await issueResponse.json()) as { node_id?: string };
    if (!issue.node_id) {
      return { ok: false, detail: `Issue ${ownerRepo}#${issueNumber} has no node_id in the API response` };
    }

    const graphqlResponse = await githubFetch(
      GRAPHQL_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: MUTE_MUTATION, variables: { id: issue.node_id } }),
      },
      opts,
    );
    if (!graphqlResponse.ok) {
      const text = await graphqlResponse.text();
      return {
        ok: false,
        detail: `Could not mute ${ownerRepo}#${issueNumber} (${graphqlResponse.status}): ${text.slice(0, 200)}`,
      };
    }

    const payload = (await graphqlResponse.json()) as {
      errors?: Array<{ message: string }>;
      data?: { updateSubscription?: { subscribable?: { viewerSubscription?: string } } };
    };
    if (payload.errors && payload.errors.length > 0) {
      return {
        ok: false,
        detail: `Could not mute ${ownerRepo}#${issueNumber}: ${payload.errors[0]!.message}`,
      };
    }

    const state = payload.data?.updateSubscription?.subscribable?.viewerSubscription ?? 'IGNORED';
    return { ok: true, detail: `Muted notifications for ${ownerRepo}#${issueNumber} (viewerSubscription=${state})` };
  } catch (err) {
    return {
      ok: false,
      detail: `Could not mute ${ownerRepo}#${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
