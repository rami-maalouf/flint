const assert = require('node:assert/strict');
const test = require('node:test');
const app = require('../../../../app.json').expo;

test('full stack builds cannot access the original app identity', () => {
  assert.equal(app.slug, 'habit-system-fullstack');
  assert.equal(app.scheme, 'habitsystemfullstack');
  assert.equal(app.ios.bundleIdentifier, 'studio.orbitlabs.habitsystem.fullstack');
  assert.notEqual(app.extra.eas.projectId, '07481ea0-9f44-4f24-ad3c-fd889569cade');
  const widgets = app.plugins.find(value => Array.isArray(value) && value[0] === 'expo-widgets')[1];
  assert.equal(widgets.groupIdentifier, 'group.studio.orbitlabs.habitsystem.fullstack');
  assert.equal(widgets.widgets[0].name, 'HabitSystemFullStackBoards');
  assert.ok(app.plugins.includes('expo-secure-store'));
  assert.equal(app.extra.eas.build.experimental.ios.appExtensions.length, 1);
});
