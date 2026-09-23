import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAskRequestAuthorized, isLoopbackHost } from '../server.mjs';

describe('isLoopbackHost', () => {
  it('accepts every loopback spelling', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', '::1', 'localhost', '::ffff:127.0.0.1', 'LOCALHOST']) {
      assert.equal(isLoopbackHost(h), true, h);
    }
  });
  it('rejects non-loopback and empty', () => {
    for (const h of ['0.0.0.0', '10.0.0.5', '::ffff:192.168.1.2', 'example.com', '', null, undefined]) {
      assert.equal(isLoopbackHost(h), false, String(h));
    }
  });
});

describe('isAskRequestAuthorized', () => {
  it('bypasses the token only for a direct loopback client on a loopback bind', () => {
    assert.equal(isAskRequestAuthorized('127.0.0.1', null, null), true);
    assert.equal(isAskRequestAuthorized('127.0.0.1', null, null, { remoteAddress: '::ffff:127.0.0.1' }), true);
  });
  it('requires the token when the request was proxied to a loopback bind', () => {
    assert.equal(isAskRequestAuthorized('127.0.0.1', 'secret', null, { remoteAddress: '127.0.0.1', forwarded: true }), false);
    assert.equal(isAskRequestAuthorized('127.0.0.1', 'secret', 'secret', { remoteAddress: '127.0.0.1', forwarded: true }), true);
    assert.equal(isAskRequestAuthorized('127.0.0.1', null, null, { remoteAddress: '127.0.0.1', forwarded: true }), false);
  });
  it('requires the token when a loopback client names a non-loopback Host (DNS rebinding)', () => {
    assert.equal(isAskRequestAuthorized('127.0.0.1', null, null, { hostHeader: 'evil.example:3118' }), false);
    assert.equal(isAskRequestAuthorized('127.0.0.1', null, null, { hostHeader: 'localhost:3118' }), true);
    assert.equal(isAskRequestAuthorized('127.0.0.1', null, null, { hostHeader: '[::1]:3118' }), true);
    assert.equal(isAskRequestAuthorized('127.0.0.1', 'secret', 'secret', { hostHeader: 'evil.example' }), true);
  });
  it('requires the token when the client is not loopback', () => {
    assert.equal(isAskRequestAuthorized('127.0.0.1', 'secret', '', { remoteAddress: '192.168.1.20' }), false);
    assert.equal(isAskRequestAuthorized('0.0.0.0', 'secret', 'wrong'), false);
    assert.equal(isAskRequestAuthorized('0.0.0.0', 'secret', 'secret'), true);
  });
});
