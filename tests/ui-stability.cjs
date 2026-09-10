'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8');
const dashboard=read('dashboard-ui.js');
const brain=read('brain.css');
const theme=read('theme.js');

// Core screens stay mounted. Navigation scrolls to a screen instead of hiding
// the rest of the application or moving live content into collapsible wrappers.
assert.doesNotMatch(dashboard,/data-synap-view[^\n]*display\s*:\s*none/i);
assert.doesNotMatch(dashboard,/wrapActions\s*\(/);
assert.doesNotMatch(dashboard,/wrapConversations\s*\(/);
assert.doesNotMatch(dashboard,/createElement\(['"]details['"]\)/);
assert.match(dashboard,/scrollIntoView/);
assert.match(dashboard,/IntersectionObserver/);
assert.match(dashboard,/SynapDashboardUI/);
assert.match(dashboard,/setView/);

// The second-brain UI must be readable on a phone. 7–9px type was functionally
// invisible on real devices even when the DOM contained the content.
assert.match(brain,/\.brain-action-row strong\{[^}]*font-size:(?:12|13|14)px/);
assert.match(brain,/\.brain-empty\{[^}]*font-size:(?:12|13|14)px/);
assert.match(brain,/\.ask-form input\{[^}]*font-size:(?:14|15|16)px/);
assert.match(brain,/\.conversation-card strong\{[^}]*font-size:(?:13|14|15)px/);

// Appearance bootstrap must not inject a second copy of brain.css ahead of the
// static stylesheet and then race it with another cached revision.
assert.doesNotMatch(theme,/css\(['"]brain\.css/);
assert.doesNotMatch(theme,/css\(['"]brand\.css/);

console.log('PASS: Synap uses a stable mounted shell with readable second-brain UI.');
