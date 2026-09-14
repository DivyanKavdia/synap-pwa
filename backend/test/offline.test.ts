import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';

test('the test runner blocks outbound SDK connections before opening a socket', () => {
  for (const host of ['example.invalid', '192.0.2.1', '169.254.169.254']) {
    assert.throws(() => net.createConnection({ host, port: 443 }), { code: 'ERR_TEST_NETWORK_BLOCKED' });
    assert.throws(() => new net.Socket().connect(443, host), { code: 'ERR_TEST_NETWORK_BLOCKED' });
  }
});
