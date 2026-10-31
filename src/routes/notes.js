'use strict';

const express = require('express');
const store = require('../store');
const { noteId } = require('../ids');
const { isAdmin } = require('../admin-auth');
const { deviceOf, handleOf, sameId, remoteIp } = require('../identity');
const { cleanText } = require('../text');
const { rateLimit } = require('../limits');

const MAX_NOTE_LENGTH = 4000;

/** What every device is allowed to see. The sender's IP never leaves the server. */
const toPublicNote = (n) => ({
  id: n.id,
  text: n.text,
  createdAt: n.createdAt,
  fromName: n.fromName || null,
  ownerHandle: handleOf(n.ownerId) || null,
});

/**
 * Who is sending, from the hub's own records — never from the request body,
 * so nobody can post as someone else or as the host.
 */
function sender(req) {
  if (isAdmin(req)) return { id: deviceOf(req), name: 'Host' };
  const id = deviceOf(req);
  const name = id && store.getDeviceName(id);
  return { id: name ? id : null, name: name || null };
}

module.exports = function createNotesRouter(hub) {
  const router = express.Router();
  // Plenty for people typing; a wall for a script flooding every screen.
  const writeLimit = rateLimit({ burst: 10, perMinute: 20, keyOf: remoteIp,
    message: 'You are sending messages too quickly — wait a moment.' });

  // GET /api/notes
  router.get('/api/notes', (req, res) => {
    res.json({ notes: store.listNotes().map(toPublicNote) });
  });

  // POST /api/notes  { text }
  router.post('/api/notes', writeLimit, (req, res) => {
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Empty note' });

    const from = sender(req);
    const note = store.addNote({
      id: noteId(),
      text: text.slice(0, MAX_NOTE_LENGTH),
      createdAt: Date.now(),
      // The device's own display name, so the board reads like a conversation.
      // Deliberately not the IP: that would put every sender's address on
      // every other device's screen.
      fromName: from.name,
      ownerId: from.id,
    });
    const payload = toPublicNote(note);
    hub.broadcast('note-added', payload);
    res.json(payload);
  });

  // POST /api/dm  { to, text } — a private message to ONE device, addressed by
  // its handle. Ephemeral: delivered over WebSocket, never stored on the server.
  router.post('/api/dm', writeLimit, (req, res) => {
    const to = cleanText(req.body.to, 40);
    const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, MAX_NOTE_LENGTH) : '';
    if (!to || !text) return res.status(400).json({ error: 'Missing recipient or text' });
    const from = sender(req);
    const payload = {
      id: noteId(),
      text,
      fromName: from.name || 'Someone',
      // Where a reply goes: the sender's handle, as the hub knows it.
      fromId: handleOf(from.id),
      ts: Date.now(),
    };
    const delivered = hub.sendToDevice(to, 'dm', payload);
    res.json({ ok: true, delivered });
  });

  // DELETE /api/notes/:id — by the device that posted it, or the host.
  router.delete('/api/notes/:id', (req, res) => {
    const note = store.listNotes().find((n) => n.id === req.params.id);
    if (!note) return res.status(404).json({ error: 'Not found' });
    if (!isAdmin(req) && !sameId(deviceOf(req), note.ownerId)) {
      return res.status(403).json({ error: 'Only the device that posted this message, or the host, can delete it.' });
    }
    store.removeNote(note.id);
    hub.broadcast('note-removed', { id: note.id });
    res.json({ ok: true });
  });

  return { router };
};
