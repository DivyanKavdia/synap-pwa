'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8');
const dashboard=read('dashboard-ui.js');
const brain=read('brain.css');
const compact=read('compact.css');
const capture=read('capture-ui.js');
const product=read('product-ui.js');
const theme=read('theme.js');

// Core screens stay mounted. Navigation scrolls to a screen instead of hiding
// the rest of the application or moving live content into collapsible wrappers.
assert.doesNotMatch(dashboard,/data-synap-view[^\n]*display\s*:\s*none/i);
assert.doesNotMatch(dashboard,/wrapActions\s*\(/);
assert.doesNotMatch(dashboard,/wrapConversations\s*\(/);
assert.doesNotMatch(dashboard,/createElement\(['"]details['"]\)/);
assert.match(dashboard,/scrollIntoView/);
assert.match(dashboard,/IntersectionObserver/);
assert.match(dashboard,/capture:'#capture'/);
assert.match(dashboard,/href='#capture'|href="\#capture"/);
assert.match(dashboard,/SynapDashboardUI/);
assert.match(dashboard,/setView/);

// Capture is a first-class visible surface; the header mic is only a shortcut.
assert.doesNotMatch(compact,/\.capture-minimal\s*\{\s*display\s*:\s*none/i);
assert.match(compact,/\.capture-minimal,\.capture-product\{display:grid!important/);
assert.match(capture,/classList\.remove\('capture-minimal'\)/);
assert.match(capture,/classList\.add\('capture-product'\)/);
assert.match(capture,/removeAttribute\('aria-hidden'\)/);

// Recording controls remain visible. Old product-ui moved almost every action to
// a ••• disclosure while runtime-ui hid the remaining loader button.
assert.doesNotMatch(product,/createElement\(['"]details['"]\).*recording-more/s);
assert.match(product,/restoreRecordingActions/);
assert.match(product,/recording-action-memory/);
assert.match(product,/recording-action-export/);
assert.match(product,/recording-action-delete/);
assert.match(product,/recording-actions\{display:grid!important/);

// The second-brain UI must be readable on a phone. 7–9px type was functionally
// invisible on real devices even when the DOM contained the content.
assert.match(brain,/\.brain-action-row strong\{[^}]*font-size:(?:12|13|14)px/);
assert.match(brain,/\.brain-empty\{[^}]*font-size:(?:12|13|14)px/);
assert.match(brain,/\.ask-form input\{[^}]*font-size:(?:14|15|16)px/);
assert.match(brain,/\.conversation-card strong\{[^}]*font-size:(?:13|14|15)px/);
assert.match(compact,/\.header-status-text\{[^}]*font-size:(?:10|11|12)px/);

// Appearance bootstrap must not inject a second copy of core styles ahead of
// index.html and then race it with another cached revision.
assert.doesNotMatch(theme,/css\(['"]brain\.css/);
assert.doesNotMatch(theme,/css\(['"]brand\.css/);

console.log('PASS: Synap uses a stable mounted shell, visible capture, readable memory UI and visible Library actions.');
