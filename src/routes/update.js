'use strict';

const express = require('express');
const config = require('./../config');

// MeghXL makes no network calls of its own. This endpoint is the single
// exception, and it only runs when someone presses "Check for updates":
// one GET to the GitHub releases API, sending nothing but the request itself.
// No identifiers, no usage data, no telemetry. See SECURITY.md.
const RELEASES_API = 'https://api.github.com/repos/riponcm/MeghXL/releases/latest';
const RELEASES_PAGE = 'https://github.com/riponcm/MeghXL/releases';
const CACHE_MS = 60 * 60 * 1000; // GitHub allows 60 unauthenticated calls an hour
const TIMEOUT_MS = 8000;

/** "1.2.0" > "1.10.0"? No. Compare numerically, part by part. */
function isNewer(latest, current) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

module.exports = function createUpdateRouter() {
  const router = express.Router();
  let cache = null; // { at, body }

  router.get('/api/update', async (req, res) => {
    const current = config.version;
    if (cache && Date.now() - cache.at < CACHE_MS) {
      return res.json({ ...cache.body, current, cached: true });
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(RELEASES_API, {
        signal: ctrl.signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MeghXL' },
      });
      // A repo with no published releases answers 404. That is a valid
      // answer to "is there an update", not a failure.
      if (r.status === 404) {
        const body = { latest: null, notes: '', publishedAt: null, url: RELEASES_PAGE, updateAvailable: false, noReleases: true };
        cache = { at: Date.now(), body };
        return res.json({ ...body, current, cached: false });
      }
      if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
      const rel = await r.json();
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      const body = {
        latest: latest || null,
        notes: typeof rel.body === 'string' ? rel.body.slice(0, 4000) : '',
        publishedAt: rel.published_at || null,
        url: rel.html_url || RELEASES_PAGE,
        updateAvailable: Boolean(latest) && isNewer(latest, current),
      };
      cache = { at: Date.now(), body };
      res.json({ ...body, current, cached: false });
    } catch (err) {
      // Offline is the normal case for a LAN tool — say so plainly.
      res.status(503).json({
        current,
        error: err.name === 'AbortError' ? 'Timed out' : 'Could not reach GitHub',
        url: RELEASES_PAGE,
      });
    } finally {
      clearTimeout(timer);
    }
  });

  return { router };
};
