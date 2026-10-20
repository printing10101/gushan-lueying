import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { endReadError } = require('./lib/stream-error.js');
const test = require('node:test');
const assert = require('node:assert');

test('endReadError:响应头已发出时 destroy,不能二次 writeHead', () => {
  const destroyed = [];
  const res = {
    headersSent: true,
    destroy(err) { destroyed.push(err); },
    writeHead() { throw new Error('二次 writeHead 会抛 ERR_HTTP_HEADERS_SENT'); },
    end() { throw new Error('已发出响应头时不该正常 end'); },
  };
  const err = new Error('disk read failed');
  assert.doesNotThrow(() => endReadError(res, err));
  assert.deepEqual(destroyed, [err]);
});

test('endReadError:响应头未发出时补 500 并结束', () => {
  const calls = [];
  const res = {
    headersSent: false,
    writeHead(status) { calls.push(['writeHead', status]); },
    end(body) { calls.push(['end', body]); },
  };
  assert.doesNotThrow(() => endReadError(res, new Error('x')));
  assert.deepEqual(calls, [['writeHead', 500], ['end', 'read error']]);
});
