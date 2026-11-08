'use strict';

// Everything the service prints goes to stdout, which systemd keeps in the
// journal. The service user is not in systemd-journal, so the owner panel can't
// read the journal, and giving a web process sudo access to journalctl is worse
// than keeping our own copy. Mirror console output into a small bounded buffer
// and let the Logs tab read that. In memory only: the window starts at boot.

const util = require('util');

const MAX_ENTRIES = 500;
const MAX_CHARS = 1000;

const LEVELS = { debug: 'debug', log: 'info', info: 'info', warn: 'warn', error: 'error' };

const startedAt = new Date().toISOString();
const entries = [];
let written = 0;
let installed = false;

function push(level, args) {
  let message;
  try {
    message = util.format(...args);
  } catch (e) {
    message = args.map(String).join(' ');
  }
  if (message.length > MAX_CHARS) message = `${message.slice(0, MAX_CHARS)}…`;

  written += 1;
  entries.push({ id: written, ts: new Date().toISOString(), level, message });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

// Patching console keeps every existing console.log/warn/error call working as
// before: the original writer still runs, the entry is just also recorded.
function install() {
  if (installed) return;
  installed = true;

  Object.keys(LEVELS).forEach((name) => {
    const original = console[name] ? console[name].bind(console) : console.log.bind(console);
    console[name] = (...args) => {
      push(LEVELS[name], args);
      original(...args);
    };
  });
}

function recent(limit = 200, level = 'all') {
  const wanted = level && level !== 'all' ? entries.filter((e) => e.level === level) : entries;
  const size = Math.min(Math.max(Number.isFinite(limit) ? limit : 200, 1), MAX_ENTRIES);
  return wanted.slice(-size);
}

function info() {
  return { startedAt, written, kept: entries.length, capacity: MAX_ENTRIES };
}

module.exports = { install, recent, info };
