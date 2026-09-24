const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('auth forms keep conditionally hidden fields out of the login view', () => {
  const html = fs.readFileSync('auth.html', 'utf8');
  const css = fs.readFileSync('styles.css', 'utf8');
  assert.match(html, /class="field name-field" hidden/);
  assert.match(html, /class="field reset-field" hidden/);
  assert.match(css, /\.field\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*\}/);
});

test('public booking renders a clear empty state when a host has no active meeting types', () => {
  const client = fs.readFileSync('app.js', 'utf8');
  assert.match(client, /const meetingTypes=Array\.isArray\(d\.meetingTypes\)[\s\S]*?if\(!meetingTypes\.length\)\{/);
  assert.match(client, /No meeting types are available to book right now/);
  assert.doesNotMatch(client, /d\.meetingTypes\[0\]\.(?:en|duration|mode)/);
});
