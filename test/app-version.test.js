// The APK link may only ever point at this project's GitHub releases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('version.json is valid and its APK address, when set, is one of this project\'s releases', () => {
  const v = JSON.parse(fs.readFileSync('public/download/version.json', 'utf8'));
  assert.ok(Number.isInteger(v.versionCode) && v.versionCode > 0);
  assert.equal(typeof v.versionName, 'string');
  if (v.apkUrl) {
    assert.ok(v.apkUrl.startsWith('https://github.com/bandasihle/BTA-TAXIS/releases/download/'), v.apkUrl);
    assert.match(v.sha256, /^[0-9a-f]{64}$/);
    assert.ok(v.sizeBytes > 0);
  }
  const gradle = fs.readFileSync('android/app/build.gradle', 'utf8');
  const code = Number(gradle.match(/versionCode (\d+)/)[1]);
  assert.ok(v.versionCode <= code, 'the site never offers a version newer than the app source');
});
