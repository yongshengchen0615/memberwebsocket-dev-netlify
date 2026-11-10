const { test } = require('node:test');
const database = require('./database.cjs');
const acceptance = require('../fixtures/reminder-message-contract.cjs');

test('PG17 AC-002: existing/new reminder schemas, merchant text, role denial and DDL rollback', async () => {
  const options = await database();
  try { await acceptance(options.db, { rolesCreated: true }); }
  finally { await options.db.close(); }
});
