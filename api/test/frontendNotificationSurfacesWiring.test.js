import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function readFrontend(relPath) {
  return fs.readFileSync(
    fileURLToPath(new URL(`../../frontend/src/${relPath}`, import.meta.url)),
    'utf8'
  );
}

test('Unit: syncBuildingFilterBeforeNavigate resolves cross-building filter mismatch safely', async () => {
  const { syncBuildingFilterBeforeNavigate } = await import(
    '../../frontend/src/utils/notificationNavigation.js'
  );

  let updatedBuildingId = undefined;
  const setSelectedBuildingId = (val) => {
    updatedBuildingId = val;
  };

  // Case 1: Admin has Building A selected, clicks notification for Building B (which is in accessible buildings) -> switches to B
  updatedBuildingId = undefined;
  syncBuildingFilterBeforeNavigate('bldg-b', {
    selectedBuildingId: 'bldg-a',
    accessibleBuildingIds: ['bldg-a', 'bldg-b'],
    setSelectedBuildingId,
  });
  assert.equal(updatedBuildingId, 'bldg-b');

  // Case 2: Admin has Building A selected, clicks notification for Building C (not in cached list yet, e.g. SYS_ADMIN) -> resets to '' (All buildings)
  updatedBuildingId = undefined;
  syncBuildingFilterBeforeNavigate('bldg-c', {
    selectedBuildingId: 'bldg-a',
    accessibleBuildingIds: ['bldg-a', 'bldg-b'],
    setSelectedBuildingId,
  });
  assert.equal(updatedBuildingId, '');

  // Case 3: Admin already on '' (All buildings) -> stays on '' without forcing single-building lock
  updatedBuildingId = undefined;
  syncBuildingFilterBeforeNavigate('bldg-b', {
    selectedBuildingId: '',
    accessibleBuildingIds: ['bldg-a', 'bldg-b'],
    setSelectedBuildingId,
  });
  assert.equal(updatedBuildingId, undefined);

  // Case 4: Same building already selected -> no-op
  updatedBuildingId = undefined;
  syncBuildingFilterBeforeNavigate('bldg-a', {
    selectedBuildingId: 'bldg-a',
    accessibleBuildingIds: ['bldg-a', 'bldg-b'],
    setSelectedBuildingId,
  });
  assert.equal(updatedBuildingId, undefined);
});

test('Wiring Contract: NotificationBell, TopBar, NotificationsPage, and NotificationsTab all use unified useNotificationAction & NotificationDetailModal', () => {
  const modalExists = fs.existsSync(
    fileURLToPath(
      new URL('../../frontend/src/components/common/NotificationDetailModal.jsx', import.meta.url)
    )
  );
  const hookExists = fs.existsSync(
    fileURLToPath(
      new URL('../../frontend/src/hooks/useNotificationAction.js', import.meta.url)
    )
  );
  assert.equal(modalExists, true, 'NotificationDetailModal.jsx must exist');
  assert.equal(hookExists, true, 'useNotificationAction.js must exist');

  const bellSrc = readFrontend('components/common/NotificationBell.jsx');
  const topBarSrc = readFrontend('components/layout/TopBar.jsx');
  const adminPageSrc = readFrontend('pages/admin/notifications/NotificationsPage.jsx');
  const resTabSrc = readFrontend('pages/resident/tabs/NotificationsTab.jsx');

  assert.match(bellSrc, /useNotificationAction/);
  assert.match(bellSrc, /NotificationDetailModal/);
  assert.match(topBarSrc, /\/admin\/notifications\?tab=inbox/);
  assert.match(adminPageSrc, /useNotificationAction/);
  assert.match(adminPageSrc, /NotificationDetailModal/);
  assert.match(adminPageSrc, /useSearchParams/);
  assert.match(resTabSrc, /useNotificationAction/);
  assert.match(resTabSrc, /NotificationDetailModal/);
});

