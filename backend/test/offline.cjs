// Loaded before every Node test worker. SDKs and fetch must use mocks; only
// loopback HTTP fixtures and the disposable Firestore emulator may connect.
'use strict';
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node also forwards a normalized [options, callback] tuple internally.
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  const options = first && typeof first === 'object' ? first : null;
  const host = options ? (options.host || 'localhost') :
    (typeof values[1] === 'string' ? values[1] : 'localhost');
  const path = options?.path || (typeof first === 'string' && !/^\d+$/.test(first));
  if (path || !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw Object.assign(new Error('Unit tests cannot open outbound network connections; mock the service.'), {
      code: 'ERR_TEST_NETWORK_BLOCKED',
    });
  }
  return connect.apply(this, args);
};
