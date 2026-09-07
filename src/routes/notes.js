'use strict';

const express = require('express');
const store = require('../store');
const { noteId } = require('../ids');

const MAX_NOTE_LENGTH = 4000;

module.exports = function createNotesRouter(hub) {
  const router = express.Router();

  // GET /api/notes
  router.get('/api/notes', (req, res) => {
    res.json({ notes: store.listNotes() });
  });

  // POST /api/notes  { text }
  router.post('/api/notes', (req, res) => {
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Empty note' });

    const note = store.addNote({
      id: noteId(),
      text: text.slice(0, MAX_NOTE_LENGTH),
      createdAt: Date.now(),
      author: req.ip,
    });
    const payload = { id: note.id, text: note.text, createdAt: note.createdAt };
    hub.broadcast('note-added', payload);
    res.json(payload);
  });

  // POST /api/dm  { to, text, fromName } — a private message to ONE device.
  // Ephemeral: delivered over WebSocket, never stored on the server.
  router.post('/api/dm', (req, res) => {
    const to = typeof req.body.to === 'string' ? req.body.to.trim().slice(0, 64) : '';
    const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, MAX_NOTE_LENGTH) : '';
    const fromName = typeof req.body.fromName === 'string' ? req.body.fromName.trim().slice(0, 60) : 'Someone';
    const fromId = typeof req.body.fromId === 'string' ? req.body.fromId.trim().slice(0, 64) : '';
    if (!to || !text) return res.status(400).json({ error: 'Missing recipient or text' });
    const payload = { id: noteId(), text, fromName, fromId, ts: Date.now() };
    const delivered = hub.sendToDevice(to, 'dm', payload);
    res.json({ ok: true, delivered });
  });

  // DELETE /api/notes/:id
  router.delete('/api/notes/:id', (req, res) => {
    const note = store.removeNote(req.params.id);
    if (!note) return res.status(404).json({ error: 'Not found' });
    hub.broadcast('note-removed', { id: note.id });
    res.json({ ok: true });
  });

  return { router };
};
