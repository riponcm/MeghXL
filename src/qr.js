'use strict';

const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

/** Render text as a PNG data URL (used for the terminal-independent join QR). */
function toDataUrl(text) {
  return QRCode.toDataURL(text, { margin: 1, width: 256 });
}

/** Render text as a PNG Buffer (served by GET /api/qr so each client gets a QR for its own origin). */
function toBuffer(text) {
  return QRCode.toBuffer(text, { margin: 1, width: 256 });
}

/** Print a scannable QR code to the terminal. Resolves when done. */
function printTerminal(text) {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(text, { small: true }, (code) => {
      console.log(code);
      resolve();
    });
  });
}

module.exports = { toDataUrl, toBuffer, printTerminal };
