const { list, put } = require('@vercel/blob');

const EVENTS_PREFIX = 'events/';

const DEFAULT_PEOPLE = [
  { id: 'p1', name: 'Dalle' },
  { id: 'p2', name: 'Deniz' },
  { id: 'p3', name: 'Ulle' },
  { id: 'p4', name: 'Sebastian Jensen' },
  { id: 'p5', name: 'Frede' },
  { id: 'p6', name: 'Thom' },
  { id: 'p7', name: 'Jenne' },
  { id: 'p8', name: 'Hans' },
  { id: 'p9', name: 'Jonas P' },
];

function makeDefaultState() {
  return {
    people: DEFAULT_PEOPLE.map((p) => ({ ...p })),
    entries: {},
  };
}

function normalizeState(raw) {
  const fallback = makeDefaultState();
  if (!raw || typeof raw !== 'object') return fallback;

  const people = Array.isArray(raw.people)
    ? raw.people
        .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
        .map((p) => ({ id: p.id, name: p.name.trim() || p.name }))
    : fallback.people;

  const entries = {};
  const inputEntries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  for (const [personId, listForPerson] of Object.entries(inputEntries)) {
    if (!Array.isArray(listForPerson)) continue;
    entries[personId] = listForPerson
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.ts === 'number')
      .map((entry) => {
        const dnf = !!entry.dnf;
        const numericTime = dnf ? null : Number(entry.time);
        return {
          id: entry.id,
          dnf,
          time: dnf ? null : (Number.isFinite(numericTime) && numericTime > 0 ? Math.round(numericTime * 100) / 100 : null),
          ts: entry.ts,
        };
      });
  }

  return { people: people.length ? people : fallback.people, entries };
}

function cloneState(raw) {
  return normalizeState(JSON.parse(JSON.stringify(raw || makeDefaultState())));
}

function sanitizeUpdatedBy(value) {
  if (typeof value !== 'string') return 'web';
  const clean = value.trim();
  return clean ? clean.slice(0, 64) : 'web';
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function hasPerson(state, personId) {
  return state.people.some((p) => p.id === personId);
}

function hasEntry(state, personId, entryId) {
  const list = state.entries[personId] || [];
  return list.some((entry) => entry.id === entryId);
}

function normalizeAction(actionName, rawPayload, currentState) {
  const action = String(actionName || '').trim().toLowerCase();
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};

  if (action === 'replace_state') {
    if (!payload.state || typeof payload.state !== 'object') {
      throw new Error('replace_state kræver payload.state');
    }
    return { action, payload: { state: normalizeState(payload.state) } };
  }

  if (action === 'add_person') {
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('Navn mangler');
    return {
      action,
      payload: {
        personId: makeId('p'),
        name,
      },
    };
  }

  if (action === 'remove_person') {
    const personId = String(payload.personId || '').trim();
    if (!personId) throw new Error('personId mangler');
    if (!hasPerson(currentState, personId)) throw new Error('Person findes ikke');
    return { action, payload: { personId } };
  }

  if (action === 'log_time') {
    const personId = String(payload.personId || '').trim();
    if (!personId) throw new Error('personId mangler');
    if (!hasPerson(currentState, personId)) throw new Error('Person findes ikke');
    const time = Number(payload.time);
    if (!Number.isFinite(time) || time <= 0) throw new Error('Ugyldig tid');
    return {
      action,
      payload: {
        personId,
        entryId: makeId('t'),
        ts: Date.now(),
        dnf: false,
        time: Math.round(time * 100) / 100,
      },
    };
  }

  if (action === 'log_dnf') {
    const personId = String(payload.personId || '').trim();
    if (!personId) throw new Error('personId mangler');
    if (!hasPerson(currentState, personId)) throw new Error('Person findes ikke');
    return {
      action,
      payload: {
        personId,
        entryId: makeId('t'),
        ts: Date.now(),
        dnf: true,
        time: null,
      },
    };
  }

  if (action === 'delete_entry') {
    const personId = String(payload.personId || '').trim();
    const entryId = String(payload.entryId || '').trim();
    if (!personId || !entryId) throw new Error('personId eller entryId mangler');
    if (!hasPerson(currentState, personId)) throw new Error('Person findes ikke');
    if (!hasEntry(currentState, personId, entryId)) throw new Error('Loglinje findes ikke');
    return { action, payload: { personId, entryId } };
  }

  throw new Error('Ukendt action');
}

function applyEventToState(rawState, event) {
  const state = cloneState(rawState);
  const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
  const action = String(event?.action || '').trim().toLowerCase();

  if (action === 'replace_state') {
    return normalizeState(payload.state || {});
  }

  if (action === 'add_person') {
    const personId = String(payload.personId || '').trim();
    const name = String(payload.name || '').trim();
    if (!personId || !name) return state;
    if (state.people.some((p) => p.id === personId)) return state;
    state.people.push({ id: personId, name });
    return state;
  }

  if (action === 'remove_person') {
    const personId = String(payload.personId || '').trim();
    if (!personId) return state;
    state.people = state.people.filter((p) => p.id !== personId);
    delete state.entries[personId];
    return state;
  }

  if (action === 'log_time' || action === 'log_dnf') {
    const personId = String(payload.personId || '').trim();
    if (!personId || !hasPerson(state, personId)) return state;
    const entryId = String(payload.entryId || '').trim();
    const ts = Number(payload.ts);
    if (!entryId || !Number.isFinite(ts)) return state;

    const entry = {
      id: entryId,
      dnf: action === 'log_dnf' ? true : !!payload.dnf,
      time: action === 'log_dnf' ? null : Number(payload.time),
      ts,
    };
    if (!entry.dnf && (!Number.isFinite(entry.time) || entry.time <= 0)) return state;
    if (entry.dnf) entry.time = null;

    const list = Array.isArray(state.entries[personId]) ? [...state.entries[personId]] : [];
    list.push(entry);
    state.entries[personId] = list;
    return state;
  }

  if (action === 'delete_entry') {
    const personId = String(payload.personId || '').trim();
    const entryId = String(payload.entryId || '').trim();
    if (!personId || !entryId) return state;
    const list = Array.isArray(state.entries[personId]) ? state.entries[personId] : [];
    state.entries[personId] = list.filter((entry) => entry.id !== entryId);
    return state;
  }

  return state;
}

async function listAllEventBlobs() {
  const blobs = [];
  let cursor = null;
  for (let i = 0; i < 50; i += 1) {
    const params = { prefix: EVENTS_PREFIX, limit: 1000 };
    if (cursor) params.cursor = cursor;
    const page = await list(params);
    blobs.push(...(page.blobs || []));
    const nextCursor = page.cursor || page.nextCursor || page.continuationToken || null;
    const hasMore = Boolean(page.hasMore || page.hasNextPage || nextCursor);
    if (!hasMore || !nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return blobs;
}

async function readEventBlob(blob) {
  const separator = blob.url.includes('?') ? '&' : '?';
  const response = await fetch(`${blob.url}${separator}t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) return null;
  const event = await response.json().catch(() => null);
  if (!event || typeof event !== 'object') return null;
  const action = String(event.action || '').trim().toLowerCase();
  const ts = Number(event.ts);
  if (!action || !Number.isFinite(ts)) return null;
  return {
    id: String(event.id || blob.pathname),
    ts,
    at: typeof event.at === 'string' ? event.at : new Date(ts).toISOString(),
    by: sanitizeUpdatedBy(event.by),
    action,
    payload: event.payload && typeof event.payload === 'object' ? event.payload : {},
  };
}

async function loadEventRecords() {
  const blobs = await listAllEventBlobs();
  if (!blobs.length) return [];

  const events = await Promise.all(blobs.map((blob) => readEventBlob(blob)));
  const clean = events.filter(Boolean);
  clean.sort((a, b) => (a.ts - b.ts) || String(a.id).localeCompare(String(b.id)));
  return clean;
}

async function buildEnvelopeFromEvents() {
  const events = await loadEventRecords();
  let state = makeDefaultState();
  for (const event of events) {
    state = applyEventToState(state, event);
  }
  const latest = events.length ? events[events.length - 1] : null;
  const revision = events.length;
  return {
    state: normalizeState(state),
    revision,
    version: revision,
    updatedAt: latest?.at || null,
    updatedBy: latest?.by || null,
    storage: 'blob-events',
  };
}

async function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) return JSON.parse(req.body);
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function writeEvent(record) {
  const path = `${EVENTS_PREFIX}${record.ts}-${record.id}.json`;
  await put(path, JSON.stringify(record), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 60,
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'Missing BLOB_READ_WRITE_TOKEN' });
  }

  if (req.method === 'GET') {
    try {
      const envelope = await buildEnvelopeFromEvents();
      return res.status(200).json(envelope);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to fetch live state', detail: error.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const current = await buildEnvelopeFromEvents();
      const normalizedAction = normalizeAction(body?.action, body?.payload, current.state);
      const updatedBy = sanitizeUpdatedBy(body?.updatedBy);

      const record = {
        id: makeId('ev'),
        ts: Date.now(),
        at: new Date().toISOString(),
        by: updatedBy,
        action: normalizedAction.action,
        payload: normalizedAction.payload,
      };

      await writeEvent(record);
      const nextState = applyEventToState(current.state, record);
      const nextRevision = (current.revision || 0) + 1;
      return res.status(200).json({
        state: normalizeState(nextState),
        revision: nextRevision,
        version: nextRevision,
        updatedAt: record.at,
        updatedBy,
        storage: 'blob-events',
      });
    } catch (error) {
      const badRequest = /mangler|Ugyldig|Ukendt|findes ikke|kræver/.test(String(error?.message || ''));
      return res.status(badRequest ? 400 : 500).json({
        error: badRequest ? String(error.message) : 'Failed to persist live state',
        detail: badRequest ? undefined : error.message,
      });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method Not Allowed' });
};
