/**
 * Projects v2 Status updater for a user-owned GitHub project.
 * Uses only the official GitHub GraphQL API. Safe defaults: preview changes,
 * reject ambiguous matches, and verify the persisted field after a mutation.
 * No third-party packages or access to member-system credentials are required.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PROJECT_OWNER = 'yongshengchen0615';
export const PROJECT_NUMBER = 5;
export const REPOSITORY = 'yongshengchen0615/memberwebsocket-dev-netlify';
export const STATUS_OPTIONS = Object.freeze([
  '待規劃', '準備開始', '開發中', '程式碼審查', 'QA / E2E',
  '等待部署', '觀察中', '已完成', '已阻塞',
]);
export const LABEL_STATUS = Object.freeze({
  'project-status/backlog': '待規劃',
  'project-status/ready': '準備開始',
  'project-status/in-progress': '開發中',
  'project-status/code-review': '程式碼審查',
  'project-status/qa': 'QA / E2E',
  'project-status/blocked': '已阻塞',
});

const PROJECT_QUERY = `
query ProjectStatus($owner:String!, $number:Int!, $after:String) {
  user(login:$owner) {
    projectV2(number:$number) {
      id
      title
      field(name:"Status") {
        ... on ProjectV2SingleSelectField { id name options { id name } }
      }
      items(first:100, after:$after) {
        nodes {
          id
          type
          content {
            ... on Issue { id number repository { nameWithOwner } }
          }
          fieldValueByName(name:"Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
const CURRENT_ITEM_QUERY = `
query CurrentProjectItem($item:ID!) {
  node(id:$item) {
    ... on ProjectV2Item {
      id
      project { id }
      content { ... on Issue { id number repository { nameWithOwner } } }
      fieldValueByName(name:"Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
      }
    }
  }
}`;
const LABEL_QUERY = `
query CurrentIssueLabels($issue:ID!) {
  node(id:$issue) {
    ... on Issue {
      labels(first:100) { nodes { name } pageInfo { hasNextPage } }
    }
  }
}`;
const UPDATE_MUTATION = `
mutation UpdateProjectStatus($project:ID!, $item:ID!, $field:ID!, $option:String!) {
  updateProjectV2ItemFieldValue(input:{
    projectId:$project, itemId:$item, fieldId:$field,
    value:{singleSelectOptionId:$option}
  }) { projectV2Item { id } }
}`;

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}
function parseIssueNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || !/^\d+$/.test(String(value))) {
    throw new Error('ISSUE_NUMBER must be a positive integer');
  }
  return number;
}

export function resolveRequest(env, eventPayload) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error('Untrusted repository for Project #5');
  const event = env.GITHUB_EVENT_NAME;
  if (event === 'workflow_dispatch') {
    const issueNumber = parseIssueNumber(env.ISSUE_NUMBER);
    const status = requireString(env.TARGET_STATUS, 'TARGET_STATUS');
    if (!STATUS_OPTIONS.includes(status)) throw new Error(`Unknown Status: ${status}`);
    if (!['true', 'false'].includes(env.APPLY)) throw new Error('APPLY must be true or false');
    return { issueNumber, status, apply: env.APPLY === 'true', event };
  }
  if (event === 'issues') {
    // No arbitrary input via issue body/title; only allowlisted label transitions.
    const payload = eventPayload;
    if (payload?.action !== 'labeled') throw new Error('Only labeled events are supported');
    if (payload?.repository?.full_name !== REPOSITORY) throw new Error('Untrusted issue repository');
    if (!payload?.issue || payload.issue.pull_request) throw new Error('Only repository issues are supported');
    const label = payload.label?.name;
    const status = LABEL_STATUS[label];
    if (!status) throw new Error('This label does not authorize a status change');
    const eventLabels = (payload.issue.labels || []).map(x => x.name);
    if (eventLabels.filter(x => Object.hasOwn(LABEL_STATUS, x)).length !== 1 || !eventLabels.includes(label)) {
      throw new Error('Conflicting or missing Project Status labels');
    }
    return { issueNumber: parseIssueNumber(payload.issue.number), status, apply: true, event, label };
  }
  throw new Error(`Untrusted event: ${event}`);
}

export function createGraphqlClient(token, fetchImpl = globalThis.fetch) {
  requireString(token, 'PROJECTS_V2_TOKEN');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  return async (query, variables) => {
    let response;
    try {
      response = await fetchImpl('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (cause) {
      throw new Error('GitHub GraphQL transport failure', { cause });
    }
    if (!response.ok) throw new Error(`GitHub GraphQL HTTP ${response.status}; check PAT project scope and owner access`);
    let payload;
    try { payload = await response.json(); } catch { throw new Error('Invalid JSON from GitHub GraphQL'); }
    if (payload.errors?.length) {
      // Deliberately do not echo raw provider messages: they can contain sensitive input.
      throw new Error(`GitHub GraphQL returned ${payload.errors.length} error(s); check token/project permissions and schema`);
    }
    if (!payload.data) throw new Error('GitHub GraphQL returned no data');
    return payload.data;
  };
}

function matchingItem(item, issueNumber) {
  const content = item?.content;
  return item?.type === 'ISSUE' && content?.number === issueNumber &&
    content?.repository?.nameWithOwner?.toLowerCase() === REPOSITORY.toLowerCase();
}

export async function getProjectIssue(graphql, issueNumber, status) {
  let after = null;
  const matches = [];
  let projectId = null;
  let projectTitle = '';
  let statusField;
  const seenCursors = new Set();
  for (let page = 0; page < 100; page++) {
    const data = await graphql(PROJECT_QUERY, { owner: PROJECT_OWNER, number: PROJECT_NUMBER, after });
    const project = data.user?.projectV2;
    if (!project?.id) throw new Error('Project #5 is unavailable or token cannot read it');
    if (projectId && projectId !== project.id) throw new Error('Project changed during pagination');
    projectId = project.id;
    projectTitle = project.title;
    statusField = project.field;
    if (!statusField?.id || statusField.name !== 'Status' || !Array.isArray(statusField.options)) {
      throw new Error('Project Status must be a readable single-select field');
    }
    const items = project.items;
    if (!Array.isArray(items?.nodes)) throw new Error('Project items are not readable');
    for (const item of items.nodes) if (matchingItem(item, issueNumber)) matches.push(item);
    if (!items.pageInfo?.hasNextPage) break;
    const cursor = items.pageInfo.endCursor;
    if (!cursor || seenCursors.has(cursor)) throw new Error('Invalid Project pagination cursor');
    seenCursors.add(cursor);
    after = cursor;
    if (page === 99) throw new Error('Project pagination exceeds safety limit');
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Project item for issue #${issueNumber}; found ${matches.length}`);
  }
  const options = statusField.options.filter(x => x.name === status);
  if (options.length !== 1 || !options[0].id) throw new Error(`Expected exactly one configured Status option: ${status}`);
  if (!matches[0].content?.id) throw new Error('Matched issue has no node ID');
  return { projectId, projectTitle, statusFieldId: statusField.id, item: matches[0], optionId: options[0].id };
}

function assertCurrentItem(data, original) {
  const found = data?.node;
  if (!found || found.id !== original.item.id || found.project?.id !== original.projectId ||
    !matchingItem({ type: 'ISSUE', content: found.content }, original.item.content.number)) {
    throw new Error('Project item identity or ownership changed');
  }
  return found.fieldValueByName;
}

export async function changeProjectStatus(graphql, request) {
  const details = await getProjectIssue(graphql, request.issueNumber, request.status);
  const oldStatus = details.item.fieldValueByName?.name ?? null;
  const changed = details.item.fieldValueByName?.optionId !== details.optionId;
  const summary = {
    project: `${PROJECT_OWNER}/${PROJECT_NUMBER}`,
    issue: `${REPOSITORY}#${request.issueNumber}`,
    itemId: details.item.id,
    from: oldStatus,
    to: request.status,
    action: !changed ? 'unchanged' : (request.apply ? 'updated' : 'preview'),
  };
  if (!request.apply || !changed) return summary;

  if (request.event === 'issues') {
    // Re-read live labels, not only the (possibly stale) webhook payload.
    const labelData = await graphql(LABEL_QUERY, { issue: details.item.content.id });
    const labels = labelData.node?.labels;
    if (!Array.isArray(labels?.nodes) || labels.pageInfo?.hasNextPage) {
      throw new Error('Live Issue status labels cannot be fully verified');
    }
    const activeLabels = labels.nodes.map(x => x.name).filter(x => Object.hasOwn(LABEL_STATUS, x));
    if (activeLabels.length !== 1 || activeLabels[0] !== request.label) {
      throw new Error('Live Issue labels changed or conflict; refusing stale update');
    }
  }
  // Optimistic re-read narrows, but does not eliminate, a concurrent UI edit race.
  const beforeData = await graphql(CURRENT_ITEM_QUERY, { item: details.item.id });
  const currentValue = assertCurrentItem(beforeData, details);
  if ((currentValue?.optionId ?? null) !== (details.item.fieldValueByName?.optionId ?? null)) {
    throw new Error('Status changed concurrently; refusing to overwrite');
  }
  const updateData = await graphql(UPDATE_MUTATION, {
    project: details.projectId, item: details.item.id, field: details.statusFieldId, option: details.optionId,
  });
  if (updateData.updateProjectV2ItemFieldValue?.projectV2Item?.id !== details.item.id) {
    throw new Error('Mutation did not confirm the target item');
  }
  const afterData = await graphql(CURRENT_ITEM_QUERY, { item: details.item.id });
  const afterValue = assertCurrentItem(afterData, details);
  if (afterValue?.optionId !== details.optionId || afterValue?.name !== request.status) {
    throw new Error('Post-write Status read-back mismatch');
  }
  return summary;
}

export async function main(env = process.env, fetchImpl = globalThis.fetch) {
  let payload;
  if (env.GITHUB_EVENT_NAME === 'issues') {
    payload = JSON.parse(readFileSync(requireString(env.GITHUB_EVENT_PATH, 'GITHUB_EVENT_PATH'), 'utf8'));
  }
  const request = resolveRequest(env, payload);
  const graphql = createGraphqlClient(env.PROJECTS_V2_TOKEN, fetchImpl);
  const result = await changeProjectStatus(graphql, request);
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Project status automation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
