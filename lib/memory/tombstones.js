import { selectedHistoricalMemoryPaths } from './brain-backup-selection.js';

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`memory tombstone ${label} must be an object`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`memory tombstone ${label} must be an array of strings`);
  }
}

function assertMemoryPath(repositoryPath, label) {
  const segments = repositoryPath.split('/');
  if (
    repositoryPath.includes('\\') ||
    repositoryPath.includes('\0') ||
    segments[0] !== 'memory' ||
    segments.length < 2 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`memory tombstone ${label} contains an invalid memory path: ${repositoryPath}`);
  }
}

function assertMemoryPaths(paths, label) {
  for (const repositoryPath of paths) assertMemoryPath(repositoryPath, label);
}

/**
 * Calculate a publisher head's next tombstone set for every transport.
 */
export function calculateNextTombstones({
  prevMarkers = {},
  prevTombstones = {},
  markers = {},
  extraDeletions = [],
  extraDeletionTimes = {},
  authoritativePriorPages = [],
  selection = null,
  now = Date.now(),
}) {
  assertRecord(prevMarkers, 'prevMarkers');
  assertRecord(prevTombstones, 'prevTombstones');
  assertRecord(markers, 'markers');
  assertStringArray(extraDeletions, 'extraDeletions');
  assertRecord(extraDeletionTimes, 'extraDeletionTimes');
  assertStringArray(authoritativePriorPages, 'authoritativePriorPages');
  assertMemoryPaths(Object.keys(prevMarkers), 'prevMarkers');
  assertMemoryPaths(Object.keys(prevTombstones), 'prevTombstones');
  assertMemoryPaths(Object.keys(markers), 'markers');
  assertMemoryPaths(extraDeletions, 'extraDeletions');
  assertMemoryPaths(Object.keys(extraDeletionTimes), 'extraDeletionTimes');
  assertMemoryPaths(authoritativePriorPages, 'authoritativePriorPages');
  const originalPriorLive = [...new Set([...Object.keys(prevMarkers), ...authoritativePriorPages])];
  if (selection) {
    const priorSelected = selectedHistoricalMemoryPaths(selection, originalPriorLive);
    const selectedExtraDeletions = selectedHistoricalMemoryPaths(selection, extraDeletions);
    if (Object.keys(markers).length === 0) {
      if (selectedExtraDeletions.length !== extraDeletions.length) {
        throw new Error(
          'memory publish refused: unselected extra deletions cannot authorize an empty selected tree',
        );
      }
      // An empty first publish cannot prove deletion, and narrowing any prior
      // live path out of policy cannot manufacture a tombstone. Both cases are
      // intentionally rejected; callers must retain explicit prior authority.
      if (originalPriorLive.length < 1) {
        throw new Error('memory publish refused: empty selected tree has no authoritative own prior live path or sync baseline');
      }
      if (priorSelected.length !== originalPriorLive.length) {
        const narrowedCount = originalPriorLive.length - priorSelected.length;
        throw new Error(
          'memory publish refused: cannot narrow policy and publish an empty selected tree in the same operation ' +
          `(${narrowedCount} authoritative prior live path(s) are no longer selected)`,
        );
      }
    }
    const selectedMarkerPaths = new Set(selectedHistoricalMemoryPaths(selection, Object.keys(prevMarkers)));
    const selectedTombstonePaths = new Set(selectedHistoricalMemoryPaths(selection, Object.keys(prevTombstones)));
    prevMarkers = Object.fromEntries(Object.entries(prevMarkers).filter(([page]) => selectedMarkerPaths.has(page)));
    prevTombstones = Object.fromEntries(Object.entries(prevTombstones).filter(([page]) => selectedTombstonePaths.has(page)));
    extraDeletions = selectedExtraDeletions;
  }

  const currentSet = new Set(Object.keys(markers));
  const tombstones = {};
  for (const [page, value] of Object.entries(prevTombstones)) {
    if (!currentSet.has(page)) tombstones[page] = finiteOr(value, now);
  }
  for (const page of Object.keys(prevMarkers)) {
    if (!currentSet.has(page) && !(page in tombstones)) {
      tombstones[page] = finiteOr(extraDeletionTimes[page], now);
    }
  }
  for (const page of extraDeletions) {
    if (typeof page === 'string' && !currentSet.has(page) && !(page in tombstones)) {
      tombstones[page] = finiteOr(extraDeletionTimes[page], now);
    }
  }
  return tombstones;
}
