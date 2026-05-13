const fs = require('node:fs/promises');
const path = require('node:path');

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

const DEFAULT_GITHUB_STATE_PATH = 'data/beograd-live-state.json';
const DEFAULT_LOCAL_STATE_PATH = process.env.VERCEL
  ? '/tmp/beograd-live-state.json'
  : path.join(process.cwd(), 'data', 'beograd-live-state.json');

function makeDefaultState() {
  return {
    people: DEFAULT_PEOPLE.map((person) => ({ ...person })),
    entries: {},
  };
}

function normalizeState(raw) {
  const fallback = makeDefaultState();
  if (!raw || typeof raw !== 'object') return fallback;

  const people = Array.isArray(raw.people)
    ? raw.people
        .filter((person) => person && typeof person.id === 'string' && typeof person.name === 'string')
        .map((person) => ({ id: person.id, name: person.name.trim() || person.name }))
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

  return {
    people: people.length ? people : fallback.people,
    entries,
  };
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
  return state.people.some((person) => person.id === personId);
}

function hasEntry(state, personId, entryId) {
  const list = state.entries[personId] || [];
  return list.some((entry) => entry.id === entryId);
}

function normalizeEnvelope(raw) {
  const base = {
    state: makeDefaultState(),
    revision: 0,
    version: 0,
    updatedAt: null,
    updatedBy: null,
  };

  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const payloadState = raw.state && typeof raw.state === 'object'
    ? raw.state
    : raw;
  base.state = normalizeState(payloadState);

  const revisionCandidate = Number(raw.revision ?? raw.version ?? 0);
  if (Number.isFinite(revisionCandidate) && revisionCandidate >= 0) {
    base.revision = revisionCandidate;
    base.version = revisionCandidate;
  }

  if (typeof raw.updatedAt === 'string' && raw.updatedAt.trim()) {
    base.updatedAt = raw.updatedAt;
  }
  if (typeof raw.updatedBy === 'string' && raw.updatedBy.trim()) {
    base.updatedBy = raw.updatedBy.slice(0, 64);
  }

  return base;
}

function cloneState(state) {
  return normalizeState(JSON.parse(JSON.stringify(state || makeDefaultState())));
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

function applyActionToState(rawState, normalizedAction) {
  const state = cloneState(rawState);
  const { action, payload } = normalizedAction;

  if (action === 'replace_state') {
    return normalizeState(payload.state || {});
  }

  if (action === 'add_person') {
    const personId = String(payload.personId || '').trim();
    const name = String(payload.name || '').trim();
    if (!personId || !name) return state;
    if (state.people.some((person) => person.id === personId)) return state;
    state.people.push({ id: personId, name });
    return state;
  }

  if (action === 'remove_person') {
    const personId = String(payload.personId || '').trim();
    if (!personId) return state;
    state.people = state.people.filter((person) => person.id !== personId);
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

function envFirst(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function storageConfig(pathOverride = null) {
  const repo = envFirst('BEOGRAD_GITHUB_REPO', 'TIPSKLUBBEN_GITHUB_REPO', 'GITHUB_REPOSITORY');
  const token = envFirst('BEOGRAD_GITHUB_TOKEN', 'TIPSKLUBBEN_GITHUB_TOKEN', 'GITHUB_TOKEN');
  const branch = envFirst('BEOGRAD_GITHUB_BRANCH', 'TIPSKLUBBEN_GITHUB_BRANCH') || 'main';
  const configuredPath = String(
    pathOverride
    || envFirst('BEOGRAD_STATE_PATH', 'TIPSKLUBBEN_STATE_PATH')
    || DEFAULT_GITHUB_STATE_PATH
  ).trim();

  if (repo && token) {
    return {
      type: 'github',
      repo,
      token,
      branch,
      path: configuredPath,
    };
  }

  const localConfigured = String(pathOverride || envFirst('BEOGRAD_LOCAL_STATE_PATH') || DEFAULT_LOCAL_STATE_PATH).trim();
  const resolvedPath = path.isAbsolute(localConfigured)
    ? localConfigured
    : path.join(process.cwd(), localConfigured);

  return {
    type: 'local',
    path: resolvedPath,
  };
}

function encodeGithubPath(filePath) {
  return filePath.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function githubFetch(config, method, body = null) {
  const url = `https://api.github.com/repos/${config.repo}/contents/${encodeGithubPath(config.path)}`;
  const fullUrl = method === 'GET'
    ? `${url}?ref=${encodeURIComponent(config.branch)}`
    : url;

  const response = await fetch(fullUrl, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || `GitHub API fejl (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function loadFromGithub(config) {
  try {
    const payload = await githubFetch(config, 'GET');
    const encoded = String(payload?.content || '');
    if (!encoded) return null;
    const decoded = Buffer.from(encoded.replace(/\n/g, ''), 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    const env = normalizeEnvelope(parsed);
    env._sha = String(payload?.sha || payload?.content?.sha || '').trim() || null;
    env.storage = 'github';
    return env;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function saveToGithub(config, envelope, sha = null, commitMessage = null) {
  const body = {
    message: commitMessage || `chore(data): update beograd live state (${envelope.updatedBy || 'web'})`,
    content: Buffer.from(JSON.stringify(envelope, null, 2), 'utf8').toString('base64'),
    branch: config.branch,
  };
  if (sha) body.sha = sha;

  const payload = await githubFetch(config, 'PUT', body);
  const out = normalizeEnvelope(envelope);
  out._sha = String(payload?.content?.sha || '').trim() || sha || null;
  out.storage = 'github';
  return out;
}

async function loadFromLocal(localPath) {
  try {
    const raw = await fs.readFile(localPath, 'utf8');
    const parsed = JSON.parse(raw);
    const env = normalizeEnvelope(parsed);
    env.storage = 'local';
    return env;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveToLocal(localPath, envelope) {
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  const out = normalizeEnvelope(envelope);
  out.storage = 'local';
  return out;
}

async function loadStateEnvelope(config = storageConfig()) {
  let loaded = null;

  if (config.type === 'github') {
    loaded = await loadFromGithub(config);
  } else {
    loaded = await loadFromLocal(config.path);
  }

  if (!loaded) {
    return {
      state: makeDefaultState(),
      revision: 0,
      version: 0,
      updatedAt: null,
      updatedBy: null,
      storage: config.type,
      _sha: null,
    };
  }

  return {
    ...normalizeEnvelope(loaded),
    storage: loaded.storage || config.type,
    _sha: loaded._sha || null,
  };
}

async function saveStateEnvelope(nextState, updatedBy = 'web', commitMessage = null, attempt = 0) {
  const config = storageConfig();
  const current = await loadStateEnvelope(config);
  const nextRevision = (Number(current.revision || current.version || 0) || 0) + 1;

  const envelope = {
    state: normalizeState(nextState),
    revision: nextRevision,
    version: nextRevision,
    updatedAt: new Date().toISOString(),
    updatedBy: sanitizeUpdatedBy(updatedBy),
  };

  try {
    if (config.type === 'github') {
      return await saveToGithub(config, envelope, current._sha || null, commitMessage);
    }
    return await saveToLocal(config.path, envelope);
  } catch (error) {
    if (config.type === 'github' && (error.status === 409 || error.status === 422) && attempt < 2) {
      return saveStateEnvelope(nextState, updatedBy, commitMessage, attempt + 1);
    }
    throw error;
  }
}

function toPublicEnvelope(envelope) {
  return {
    state: normalizeState(envelope?.state),
    revision: Number(envelope?.revision || envelope?.version || 0) || 0,
    version: Number(envelope?.revision || envelope?.version || 0) || 0,
    updatedAt: envelope?.updatedAt || null,
    updatedBy: envelope?.updatedBy || null,
    storage: envelope?.storage || 'unknown',
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  if (req.method === 'GET') {
    try {
      const envelope = await loadStateEnvelope();
      return res.status(200).json(toPublicEnvelope(envelope));
    } catch (error) {
      return res.status(500).json({ error: 'Failed to fetch live state', detail: error.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const current = await loadStateEnvelope();
      const normalizedAction = normalizeAction(body?.action, body?.payload, current.state);
      const nextState = applyActionToState(current.state, normalizedAction);
      const updatedBy = sanitizeUpdatedBy(body?.updatedBy);
      const commitMessage = `chore(data): ${normalizedAction.action}`;
      const saved = await saveStateEnvelope(nextState, updatedBy, commitMessage);
      return res.status(200).json(toPublicEnvelope(saved));
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
