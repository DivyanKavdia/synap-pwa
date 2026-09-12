'use strict';
const path = require('node:path');
const { createStaticServer } = require('./support/browser-fixture.cjs');
const port = Number(process.env.SYNAP_PORT || 4173);
const server = createStaticServer(path.resolve(__dirname, '..'));
server.listen(port, '127.0.0.1', () => {
  console.log(`Synap: http://localhost:${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
