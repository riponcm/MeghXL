'use strict';

/**
 * Mutable runtime state (things that change while the server runs, as opposed to
 * the immutable env-derived `config`).
 */
module.exports = {
  adminKey: null, // resolved at startup from the optional ADMIN_KEY env var
};
