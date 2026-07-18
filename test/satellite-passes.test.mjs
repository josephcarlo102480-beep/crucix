// Satellite pass helper tests — no network calls

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  observerForQuestion,
  questionNeedsSatellitePassContext,
} from '../lib/space/satellitePasses.mjs';

describe('satellite pass helpers', () => {
  it('detects satellite visibility questions', () => {
    assert.equal(questionNeedsSatellitePassContext('are any satellites visible over 70443 now?'), true);
    assert.equal(questionNeedsSatellitePassContext('when is the next METEOR-M pass?'), true);
    assert.equal(questionNeedsSatellitePassContext('what changed in oil?'), false);
  });

  it('maps ZIP 70443 to the Crucix satellite tracker observer', () => {
    const observer = observerForQuestion('satellites over 70443');
    assert.equal(observer.zip, '70443');
    assert.equal(observer.label, 'Independence, LA');
    assert.equal(observer.lat, 30.5155);
    assert.equal(observer.lng, -90.5063);
  });
});
