import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changeProjectStatus, checkProjectHealth, createGraphqlClient, getProjectIssue, LABEL_STATUS,
  REPOSITORY, resolveRequest, STATUS_OPTIONS, main,
} from './project-v2-status.mjs';

const opts = STATUS_OPTIONS.map((name, n) => ({ name, id: `opt${n}` }));
const optionId = name => opts.find(x => x.name === name).id;
const issue = { id: 'ISSUE40', number: 40, repository: { nameWithOwner: REPOSITORY } };
const item = (name = '已阻塞') => ({ id: 'ITEM40', type: 'ISSUE', content: issue,
  fieldValueByName: { name, optionId: optionId(name) } });
const page = (nodes = [item()], next = false, cursor = null, extra = {}) => ({ user: { projectV2: {
  id: 'PROJECT5', title: 'P5', field: { id: 'FIELD', name: 'Status', options: opts },
  items: { nodes, pageInfo: { hasNextPage: next, endCursor: cursor } }, ...extra,
} } });
const read = name => ({ node: { id: 'ITEM40', project: { id: 'PROJECT5' }, content: issue,
  fieldValueByName: { name, optionId: optionId(name) } } });
function mock({ pages = [page()], before = '已阻塞', after = '觀察中', labels = ['project-status/qa'], wrongMutation = false } = {}) {
  let pageIndex = 0, reads = 0, writes = 0;
  const requests = [];
  const graphql = async (query, vars) => {
    requests.push({ query, vars });
    if (query.includes('query ProjectStatus')) return pages[pageIndex++];
    if (query.includes('query CurrentIssueLabels')) return { node: { labels: { nodes: labels.map(name => ({ name })), pageInfo: { hasNextPage: false } } } };
    if (query.includes('query CurrentProjectItem')) return read(reads++ === 0 ? before : after);
    if (query.includes('mutation UpdateProjectStatus')) {
      writes++;
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: wrongMutation ? 'OTHER' : 'ITEM40' } } };
    }
    throw new Error('Unexpected GraphQL operation');
  };
  return { graphql, requests, get writes() { return writes; } };
}
const manual = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'workflow_dispatch', ISSUE_NUMBER: '40', TARGET_STATUS: '觀察中', APPLY: 'false' };
const update = (api, status = '觀察中', additional = {}) => changeProjectStatus(api.graphql, { issueNumber: 40, status, apply: true, ...additional }, { sleep: async () => {} });

test('nine stable workflow status options are unique', () => {
  assert.equal(STATUS_OPTIONS.length, 9);
  assert.equal(new Set(STATUS_OPTIONS).size, 9);
});
test('manual operation defaults to dry run and explicit apply enables write', () => {
  assert.equal(resolveRequest(manual).apply, false);
  assert.equal(resolveRequest({ ...manual, APPLY: 'true' }).apply, true);
});
test('unknown events, issue IDs, Status and repository are rejected', () => {
  for (const bad of [
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY: 'other/repo' },
    { ISSUE_NUMBER: '0' }, { ISSUE_NUMBER: '41.5' }, { ISSUE_NUMBER: 'NaN' },
    { TARGET_STATUS: 'Done' }, { APPLY: 'yes' },
  ]) assert.throws(() => resolveRequest({ ...manual, ...bad }));
});
test('allowlisted label event can apply, but done and deployment cannot be label-driven', () => {
  const event = { action: 'labeled', repository: { full_name: REPOSITORY },
    issue: { number: 40, labels: [{ name: 'project-status/qa' }] }, label: { name: 'project-status/qa' } };
  assert.equal(resolveRequest({ ...manual, GITHUB_EVENT_NAME: 'issues' }, event).status, 'QA / E2E');
  assert.equal(Object.keys(LABEL_STATUS).length, 6);
  for (const label of ['project-status/done', 'project-status/observing', 'project-status/ready-to-deploy']) {
    assert.equal(LABEL_STATUS[label], undefined);
    assert.throws(() => resolveRequest({ ...manual, GITHUB_EVENT_NAME: 'issues' }, { ...event, label: { name: label } }));
  }
  assert.throws(() => resolveRequest({ ...manual, GITHUB_EVENT_NAME: 'issues' }, { ...event,
    issue: { number: 40, labels: [{ name: 'project-status/qa' }, { name: 'project-status/blocked' }] } }));
});
test('missing Project token is a blocking failure', () => {
  for (const token of ['', ' ', null, undefined]) assert.throws(() => createGraphqlClient(token), /PROJECTS_V2_TOKEN/);
});
test('GraphQL client sends Bearer credential and handles HTTP 403 and GraphQL errors', async () => {
  let args;
  const api = createGraphqlClient('example-secret', async (url, options) => {
    args = { url, options };
    return { ok: true, json: async () => ({ data: { ok: true } }) };
  });
  assert.deepEqual(await api('query Test', { a: 1 }), { ok: true });
  assert.equal(args.url, 'https://api.github.com/graphql');
  assert.equal(args.options.headers.Authorization, 'Bearer example-secret');
  assert.deepEqual(JSON.parse(args.options.body).variables, { a: 1 });
  await assert.rejects(createGraphqlClient('secret', async () => ({ ok: false, status: 403 }))('q', {}), /HTTP 403/);
  await assert.rejects(createGraphqlClient('secret', async () => ({ ok: true, json: async () => ({ errors: [{ message: 'secret message' }] }) }))('q', {}), e => !e.message.includes('secret message'));
});
test('preview and already-correct Status never mutate', async () => {
  const preview = mock();
  assert.equal((await changeProjectStatus(preview.graphql, { issueNumber: 40, status: '觀察中', apply: false })).action, 'preview');
  assert.equal(preview.writes, 0);
  const same = mock({ pages: [page([item('觀察中')])] });
  assert.equal((await update(same)).action, 'unchanged');
  assert.equal(same.writes, 0);
});
test('successful update targets only matched Project Status field and verifies read-back', async () => {
  const api = mock();
  assert.equal((await update(api)).action, 'updated');
  assert.equal(api.writes, 1);
  assert.deepEqual(api.requests.find(x => x.query.includes('mutation UpdateProjectStatus')).vars,
    { project: 'PROJECT5', item: 'ITEM40', field: 'FIELD', option: optionId('觀察中') });
  assert.equal(api.requests.filter(x => x.query.includes('query CurrentProjectItem')).length, 2);
});
test('pagination finds an Issue on later pages', async () => {
  const api = mock({ pages: [page([], true, 'NEXT'), page([item()])] });
  assert.equal((await getProjectIssue(api.graphql, 40, '觀察中')).item.id, 'ITEM40');
  assert.equal(api.requests[1].vars.after, 'NEXT');
});
test('wrong repo, missing/duplicate item, unknown option, cursor or field are rejected', async () => {
  const cases = [
    page([{ ...item(), content: { ...issue, number: 100 } }]),
    page([{ ...item(), content: { ...issue, repository: { nameWithOwner: 'other/repo' } } }]),
    page([item(), item()]),
    page([item()], false, null, { field: { id: 'FIELD', name: 'Status', options: [] } }),
    page([item()], false, null, { field: null }),
    page([], true, null),
  ];
  for (const data of cases) {
    const api = mock({ pages: [data] });
    await assert.rejects(update(api));
    assert.equal(api.writes, 0);
  }
});
test('stale current status prevents concurrent overwrites', async () => {
  const api = mock({ before: '程式碼審查' });
  await assert.rejects(update(api), /concurrently/);
  assert.equal(api.writes, 0);
});
test('a failed mutation receipt cannot be reported successful', async () => {
  await assert.rejects(update(mock({ wrongMutation: true })), /did not confirm/);
});
test('post-write discrepancy is a failure, not a successful move', async () => {
  const api = mock({ after: '已阻塞' });
  await assert.rejects(update(api), /read-back mismatch/);
  assert.equal(api.writes, 1);
});
test('label-triggered transitions verify current labels and reject changed/duplicate labels', async () => {
  const ok = mock({ after: 'QA / E2E' });
  assert.equal((await update(ok, 'QA / E2E', { event: 'issues', label: 'project-status/qa' })).action, 'updated');
  for (const labels of [[], ['project-status/blocked'], ['project-status/qa', 'project-status/blocked']]) {
    const api = mock({ labels });
    await assert.rejects(update(api, 'QA / E2E', { event: 'issues', label: 'project-status/qa' }), /Live Issue labels changed/);
    assert.equal(api.writes, 0);
  }
});

const health = () => ({ viewer: { login: 'project-owner' }, user: { projectV2: {
  id: 'PROJECT5', title: 'Project 5', field: { id: 'FIELD', name: 'Status', options: opts },
} } });

test('AC-PV2-015: health check validates viewer, project and all Status options without mutation', async () => {
  let calls = 0;
  const result = await checkProjectHealth(async (query, vars) => {
    calls++;
    assert.match(query, /query ProjectHealthCheck/);
    assert.doesNotMatch(query, /mutation/);
    assert.deepEqual(vars, { owner: 'yongshengchen0615', number: 5 });
    return health();
  });
  assert.equal(calls, 1);
  assert.equal(result.action, 'healthy');
  assert.equal(result.optionCount, 9);
});

test('AC-PV2-016: missing access, absent field, and options drift fail closed', async () => {
  const base = health();
  for (const broken of [
    { ...base, viewer: null },
    { ...base, user: { projectV2: null } },
    { ...base, user: { projectV2: { ...base.user.projectV2, field: null } } },
    { ...base, user: { projectV2: { ...base.user.projectV2, field: { id: 'FIELD', name: 'Status', options: opts.filter(x => x.name !== '開發中') } } } },
    { ...base, user: { projectV2: { ...base.user.projectV2, field: { id: 'FIELD', name: 'Status', options: [...opts, opts[0]] } } } },
  ]) await assert.rejects(checkProjectHealth(async () => broken));
});

test('AC-PV2-017: read query retries transport and 502 faults a bounded number of times', async () => {
  let calls = 0;
  const waits = [];
  const api = createGraphqlClient('test-secret', async () => {
    calls++;
    if (calls === 1) throw new Error('secret-text');
    if (calls === 2) return { ok: false, status: 502 };
    return { ok: true, status: 200, json: async () => ({ data: health() }) };
  }, { sleep: async ms => waits.push(ms) });
  assert.deepEqual(await api('query Health', {}), health());
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
});

test('AC-PV2-018: 403 and 429 never retry and response body stays private', async () => {
  for (const status of [403, 429]) {
    let calls = 0;
    const api = createGraphqlClient('test-secret', async () => {
      calls++;
      return { ok: false, status, text: async () => 'test-secret' };
    }, { sleep: async () => { throw Error('unexpected retry'); } });
    await assert.rejects(api('query Read', {}), e => e.message.includes(String(status)) && !e.message.includes('test-secret'));
    assert.equal(calls, 1);
  }
});

test('AC-PV2-019: ambiguous mutations are never replayed, even on network failure', async () => {
  for (const response of [null, 503]) {
    let calls = 0;
    const api = createGraphqlClient('secret', async () => {
      calls++;
      if (response === null) throw Error('network');
      return { ok: false, status: response };
    }, { sleep: async () => { throw Error('mutation was retried'); } });
    await assert.rejects(api('mutation Update { updateProjectV2ItemFieldValue { id } }', {}), /UNKNOWN/);
    assert.equal(calls, 1);
  }
});

test('AC-PV2-020: exhausting read retries fails after exactly three attempts', async () => {
  let calls = 0;
  const api = createGraphqlClient('secret', async () => { calls++; return { ok: false, status: 504 }; }, { sleep: async () => {} });
  await assert.rejects(api('query Read', {}), /HTTP 504/);
  assert.equal(calls, 3);
});

test('AC-PV2-021: replication lag only retries verification, never repeats mutation', async () => {
  const api = mock();
  let verifyCount = 0;
  let delays = 0;
  const graphql = async (query, vars) => {
    if (query.includes('query CurrentProjectItem')) {
      verifyCount++;
      return read(verifyCount <= 2 ? '已阻塞' : '觀察中');
    }
    return api.graphql(query, vars);
  };
  const result = await changeProjectStatus(graphql, { issueNumber: 40, status: '觀察中', apply: true }, { sleep: async () => { delays++; } });
  assert.equal(result.action, 'updated');
  assert.equal(api.writes, 1);
  assert.equal(verifyCount, 3);
  assert.equal(delays, 1);
});

test('AC-PV2-022: persistent read-back mismatch is UNKNOWN and never counts as success', async () => {
  const api = mock({ after: '已阻塞' });
  let reads = 0;
  const graphql = async (query, vars) => {
    if (query.includes('query CurrentProjectItem')) reads++;
    return api.graphql(query, vars);
  };
  await assert.rejects(changeProjectStatus(graphql, { issueNumber: 40, status: '觀察中', apply: true }, { sleep: async () => {} }), /UNKNOWN/);
  assert.equal(reads, 4);
  assert.equal(api.writes, 1);
});

test('AC-PV2-023: mutation detection also recognizes leading whitespace', async () => {
  let calls = 0;
  const api = createGraphqlClient('secret', async () => { calls++; throw Error('network'); }, { sleep: async () => {} });
  await assert.rejects(api('\n mutation Update { x }', {}), /UNKNOWN/);
  assert.equal(calls, 1);
});

test('AC-PV2-024: scheduled check is one read-only API call using synthetic token', async () => {
  const queries = [];
  const result = await main({ GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'schedule', HEALTHCHECK: 'true', PROJECTS_V2_TOKEN: 'test-token' },
    async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      queries.push(JSON.parse(options.body).query);
      return { ok: true, status: 200, json: async () => ({ data: health() }) };
    });
  assert.equal(result.action, 'healthy');
  assert.equal(queries.length, 1);
  assert.match(queries[0], /query ProjectHealthCheck/);
  assert.doesNotMatch(queries[0], /mutation/);
});

test('AC-PV2-025: spoofed health events and repository are rejected before I/O', async () => {
  for (const env of [
    { GITHUB_REPOSITORY: 'other/repo', GITHUB_EVENT_NAME: 'schedule' },
    { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'issues' },
    { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'pull_request' },
  ]) {
    let calls = 0;
    await assert.rejects(main({ ...env, HEALTHCHECK: 'true', PROJECTS_V2_TOKEN: 'test-token' }, async () => {
      calls++; return { ok: true, json: async () => ({ data: health() }) };
    }), /Untrusted health/);
    assert.equal(calls, 0);
  }
});
