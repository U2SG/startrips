import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activateAccountScope, sessionGuard } from '../src/accountScope.ts';

test('signed-out work stays invalid even when the same user signs back in', () => {
  activateAccountScope('alice');
  const oldLesson = sessionGuard();
  activateAccountScope('');
  activateAccountScope('alice');
  assert.throws(oldLesson);
  assert.doesNotThrow(sessionGuard());
  activateAccountScope('bob');
  assert.throws(oldLesson);
  activateAccountScope('');
  assert.throws(() => sessionGuard());
});
