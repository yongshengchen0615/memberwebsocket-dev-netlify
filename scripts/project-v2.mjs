import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PROJECT_QUERY = `query($login:String!,$number:Int!,$after:String) {
  user(login:$login) { projectV2(number:$number) {
    id title
    fields(first:100) { nodes {
      ... on ProjectV2Field { id name dataType }
      ... on ProjectV2SingleSelectField { id name options { id name } }
    } }
    items(first:100,after:$after) { nodes {
      id type isArchived
      content { __typename
        ... on Issue { id number title url repository { nameWithOwner } }
        ... on PullRequest { id number title url repository { nameWithOwner } }
        ... on DraftIssue { id title body }
      }
      fieldValues(first:100) { nodes {
        ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2SingleSelectField { id name } } }
        ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { id name } } }
      } }
    } pageInfo { hasNextPage endCursor } }
  } }
}`;

const OPERATIONS = {
  set: 'mutation($input:UpdateProjectV2ItemFieldValueInput!){updateProjectV2ItemFieldValue(input:$input){projectV2Item{id}}}',
  add: 'mutation($input:AddProjectV2ItemByIdInput!){addProjectV2ItemById(input:$input){item{id}}}',
  draft: 'mutation($input:AddProjectV2DraftIssueInput!){addProjectV2DraftIssue(input:$input){projectItem{id}}}',
  editDraft: 'mutation($input:UpdateProjectV2DraftIssueInput!){updateProjectV2DraftIssue(input:$input){draftIssue{id}}}',
  remove: 'mutation($input:DeleteProjectV2ItemInput!){deleteProjectV2Item(input:$input){deletedItemId}}',
  archive: 'mutation($input:ArchiveProjectV2ItemInput!){archiveProjectV2Item(input:$input){item{id}}}'
};

function fail(message) { throw new Error(message); }
function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function fieldValue(item, name) {
  return item.fieldValues.nodes.find(v => v.field?.name === name)?.name ?? null;
}
function findItem(items, flags) {
  const matches = items.filter(item => {
    if (flags.item) return item.id === flags.item;
    if (!flags.issue) return false;
    const content = item.content;
    if (!content || !['Issue', 'PullRequest'].includes(content.__typename)) return false;
    const key = content.repository?.nameWithOwner + '#' + content.number;
    return String(flags.issue).replace(/^#/, '') === String(content.number) || flags.issue === key;
  });
  if (matches.length !== 1) fail('Expected exactly one matching item; found ' + matches.length + '. Use --item NODE_ID or --issue OWNER/REPO#NUMBER.');
  return matches[0];
}
function requireOption(project, fieldName, value) {
  const field = project.fields.find(f => f.name === fieldName);
  if (!field?.options) fail('Single-select field not found: ' + fieldName);
  const option = field.options.find(o => o.name === value);
  if (!option) fail('Unknown option ' + JSON.stringify(value) + ' for ' + fieldName);
  return { field, option };
}
function parseArgs(args) {
  const [command, ...tokens] = args;
  const flags = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const key = tokens[i];
    if (!key?.startsWith('--')) fail('Expected --option, found: ' + key);
    if (key === '--apply') { flags.apply = true; i -= 1; continue; }
    if (!tokens[i + 1] || tokens[i + 1].startsWith('--')) fail('Value missing for ' + key);
    const name = key.slice(2);
    if (has(flags, name)) fail('Duplicate flag: ' + key);
    flags[name] = tokens[i + 1];
  }
  return { command, flags };
}

export function createManager({ graphql, rest }) {
  async function snapshot(owner, number) {
    const items = [];
    let cursor = null;
    let project = null;
    do {
      const response = await graphql(PROJECT_QUERY, { login: owner, number, after: cursor });
      const current = response.user?.projectV2;
      if (!current) fail('Project not found or insufficient project permissions');
      project ??= { id: current.id, title: current.title, fields: current.fields.nodes };
      items.push(...current.items.nodes);
      if (!current.items.pageInfo.hasNextPage) break;
      const next = current.items.pageInfo.endCursor;
      if (!next || next === cursor) fail('Invalid items cursor');
      cursor = next;
      if (items.length > 5000) fail('Project too large for safe snapshot');
    } while (true);
    if (new Set(items.map(x => x.id)).size !== items.length) fail('Duplicate Project item IDs in snapshot');
    return { ...project, items };
  }

  async function execute(command, flags, { owner = 'yongshengchen0615', number = 5 } = {}) {
    const before = await snapshot(owner, number);
    const apply = flags.apply === true;
    if (command === 'list') {
      return { applied: false, project: before.title, count: before.items.length,
        items: before.items.map(item => ({ id: item.id, type: item.content?.__typename ?? item.type,
          title: item.content?.title, url: item.content?.url ?? null,
          status: fieldValue(item, 'Status'), priority: fieldValue(item, 'Priority') })) };
    }
    if (!['move', 'set', 'add', 'draft', 'edit', 'archive', 'remove'].includes(command)) fail('Supported: list, move, set, add, draft, edit, archive, remove');
    if (command === 'add') {
      if (!flags.issue || !/^[-\w]+\/[-.\w]+#\d+$/.test(flags.issue)) fail('add needs --issue OWNER/REPO#NUMBER');
      const [fullName, issue] = flags.issue.split('#');
      if (before.items.some(x => x.content?.repository?.nameWithOwner === fullName && String(x.content.number) === issue)) fail('Item already exists in Project');
      const [repoOwner, repoName] = fullName.split('/');
      const record = await graphql('query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){id}pullRequest(number:$number){id}}}', {owner:repoOwner,repo:repoName,number:Number(issue)});
      const contentId = record.repository?.issue?.id ?? record.repository?.pullRequest?.id;
      if (!contentId) fail('Issue or PR not found or inaccessible');
      const plan = { action: 'add', content: flags.issue, project: before.id };
      if (!apply) return { applied:false, plan };
      const response = await graphql(OPERATIONS.add, {input:{projectId:before.id, contentId}});
      const after = await snapshot(owner,number);
      if (!after.items.some(x => x.id === response.addProjectV2ItemById?.item?.id)) fail('Add not confirmed by readback');
      return { applied:true, plan, itemId:response.addProjectV2ItemById.item.id };
    }
    if (command === 'draft') {
      if (!flags.title?.trim()) fail('draft requires --title');
      const plan = { action:'draft', title:flags.title, project:before.id };
      if (!apply) return { applied:false, plan };
      const response = await graphql(OPERATIONS.draft,{input:{projectId:before.id,title:flags.title,body:flags.body || ''}});
      const after = await snapshot(owner,number);
      if (!after.items.some(x=>x.id===response.addProjectV2DraftIssue?.projectItem?.id)) fail('Draft creation not confirmed by readback');
      return {applied:true, plan, itemId:response.addProjectV2DraftIssue.projectItem.id};
    }
    const item = findItem(before.items,flags);
    const plan = { action:command, itemId:item.id, title:item.content?.title, project:before.id };
    if (command === 'move' || command === 'set') {
      const fieldName = command === 'move' ? 'Status' : flags.field;
      if (command === 'set' && fieldName === 'Status') fail('Use move to change Status so expected state and WIP are checked');
      const target = command === 'move' ? flags.to : flags.value;
      if (!target) fail('move needs --to; set needs --field and --value');
      const {field, option} = requireOption(before,fieldName,target);
      const old = fieldValue(item,fieldName);
      if (command === 'move') {
        if (!flags.from) fail('move requires --from CURRENT_STATUS to prevent stale writes');
        if (old !== flags.from) fail('Status conflict: current=' + old + ', expected=' + flags.from);
        const limit = 2; // Project #5 policy; do not permit flag override
        if (target === 'In Progress' && old !== target && before.items.filter(x => !x.isArchived && fieldValue(x,'Status') === target).length >= limit) fail('In Progress WIP limit exceeded');
      }
      plan.field = fieldName; plan.from = old; plan.to = target;
      if (old === target) return {applied:false, noChange:true, plan};
      if (!apply) return { applied:false, plan };
      await graphql(OPERATIONS.set,{input:{projectId:before.id,itemId:item.id,fieldId:field.id,value:{singleSelectOptionId:option.id}}});
      const after = await snapshot(owner,number);
      const current = after.items.find(x=>x.id===item.id);
      if (!current || fieldValue(current,fieldName)!==target) fail('Field update not confirmed by readback');
      return {applied:true, plan};
    }
    if (command === 'edit') {
      if (!has(flags,'title') && !has(flags,'body')) fail('edit requires --title or --body');
      plan.fields = Object.fromEntries(['title','body'].filter(k=>has(flags,k)).map(k=>[k,flags[k]]));
      if (!apply) return { applied:false,plan };
      if (item.content?.__typename === 'DraftIssue') {
        await graphql(OPERATIONS.editDraft,{input:{draftIssueId:item.content.id,...plan.fields}});
        const after = await snapshot(owner,number);
        const current = after.items.find(x=>x.id===item.id)?.content;
        if (!current || Object.entries(plan.fields).some(([k,v])=>current[k]!==v)) fail('Draft edit not confirmed');
      } else {
        const content = item.content;
        if (!['Issue','PullRequest'].includes(content?.__typename)) fail('Unsupported card type');
        const base = '/repos/' + content.repository.nameWithOwner + '/' + (content.__typename === 'Issue' ? 'issues/' : 'pulls/') + content.number;
        await rest('PATCH',base,plan.fields);
        const current = await rest('GET',base);
        if (Object.entries(plan.fields).some(([k,v])=>current[k]!==v)) fail('Issue/PR edit not confirmed');
      }
      return { applied:true,plan };
    }
    if (command === 'remove' && flags.confirm !== item.id) fail('remove requires --confirm ' + item.id + ' (deletes Project association only)');
    if (!apply) return { applied:false,plan };
    await graphql(OPERATIONS[command],{input:{projectId:before.id,itemId:item.id}});
    const after = await snapshot(owner,number);
    const current = after.items.find(x=>x.id===item.id);
    if (command==='remove' && current) fail('Removal not confirmed by readback');
    if (command==='archive' && current && !current.isArchived) fail('Archive not confirmed by readback');
    return { applied:true,plan };
  }
  return {snapshot,execute};
}

export function createGithubTransport(token, fetchImpl = fetch) {
  if (!token) fail('GH_TOKEN must have Project read/write permission (do not print it)');
  async function request(url, method, data) {
    const response = await fetchImpl(url,{method,headers:{Authorization:'Bearer ' + token,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:method==='GET'?undefined:JSON.stringify(data)});
    const json = await response.json();
    if (!response.ok) fail('GitHub API HTTP ' + response.status + ': ' + (json.message || 'request failed'));
    if (json.errors?.length) fail('GitHub GraphQL: ' + json.errors.map(e=>e.message).join('; '));
    return json;
  }
  return {
    graphql:async(query,variables)=> (await request('https://api.github.com/graphql','POST',{query,variables})).data,
    rest:(method,payload,body)=>request('https://api.github.com' + payload,method,body)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const {command,flags} = parseArgs(process.argv.slice(2));
    const api = createManager(createGithubTransport(process.env.GH_TOKEN));
    const result = await api.execute(command,flags,{owner:process.env.GH_PROJECT_OWNER || 'yongshengchen0615',number:Number(process.env.GH_PROJECT_NUMBER || 5)});
    console.log(JSON.stringify(result,null,2));
  } catch (error) {
    console.error('Project v2 operation failed: ' + error.message);
    process.exitCode = 1;
  }
}