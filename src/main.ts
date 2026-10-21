import Phaser from 'phaser';
import './style.css';
import { DEFAULT_FACTIONS, PLAYER_COLORS } from './core/data';
import { createGame, mapMode, MODES, slotsFor, type MapMode, type PlayerSetup } from './core/maps';
import { MapEditor } from './editor/editor';
import { allMaps, isBuiltin } from './ui/mapStore';
import { GameScene, TILE } from './game/GameScene';
import { cssColor, escapeHtml, Hud } from './ui/hud';
import { pickOnlineSave, pickSaveFile, readAutosave } from './ui/saves';
import { applyUnitSet } from './core/unitSets';
import { UnitEditor } from './ui/unitEditor';
import { lastUnitSetPick, listUnitSets, rememberUnitSetPick } from './ui/unitSetStore';
import type { Difficulty, GameEvent, GameState } from './core/state';
import { OnlineClient, savedSession, type OnlineLink } from './net/client';
import type { LobbyInfo, SeatRow } from './net/protocol';
import { COMMANDER_IDS, COMMANDERS } from './core/commanders';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const mapSelect = $<HTMLSelectElement>('map-select');
const countSelect = $<HTMLSelectElement>('player-count');
const rows = $('player-rows');

const CONTROLS: Array<[string, string]> = [
  ['human', 'Human'],
  ['easy', 'CPU · Easy'],
  ['medium', 'CPU · Medium'],
  ['hard', 'CPU · Hard'],
];

function commanderOptions(selected: string): string {
  const opts: Array<[string, string]> = [
    ...COMMANDER_IDS.map(id => [id, `${COMMANDERS[id].name} · ${COMMANDERS[id].style}`] as [string, string]),
    ['random', '🎲 Random commander'],
    ['none', 'No commander (classic rules)'],
  ];
  return opts.map(([v, label]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

/** Resolve "random" picks, preferring commanders nobody else chose. */
function resolveCommanders(picks: string[]): Array<string | undefined> {
  const taken = new Set(picks.filter(p => COMMANDERS[p]));
  return picks.map(p => {
    if (p === 'none') return undefined;
    if (p !== 'random') return p;
    const free = COMMANDER_IDS.filter(id => !taken.has(id));
    const pool = free.length ? free : COMMANDER_IDS;
    const id = pool[Math.floor(Math.random() * pool.length)];
    taken.add(id);
    return id;
  });
}

$('commander-guide').innerHTML = COMMANDER_IDS.map(id => {
  const c = COMMANDERS[id];
  return `<div class="cmd-card"><b>${escapeHtml(c.name)}</b> <span class="meta" style="display:inline">· ${escapeHtml(c.style)}</span>
    <span class="meta">${escapeHtml(c.passive.description)}</span>
    <span class="meta">⚡ <b>${escapeHtml(c.power.name)}</b>: ${escapeHtml(c.power.description)}</span></div>`;
}).join('');

/** Control value: "human", a CPU difficulty, or "with:<slot>" = played by the human of that ally slot. */
function controlToSetup(value: string): Pick<PlayerSetup, 'ai' | 'difficulty'> {
  if (value === 'human' || value.startsWith('with:')) return { ai: false };
  return { ai: true, difficulty: value as Difficulty };
}

// ---------------------------------------------------------------- mode & map

const modeSelect = $<HTMLSelectElement>('mode-select');
modeSelect.innerHTML = (Object.keys(MODES) as MapMode[])
  .map(m => `<option value="${m}">${escapeHtml(MODES[m].name)}</option>`).join('');
const currentMode = () => modeSelect.value as MapMode;

let maps = allMaps().filter(m => mapMode(m) === currentMode());
const selectedMap = () => maps.find(m => m.id === mapSelect.value) ?? maps[0];

function renderMapOptions(selectId?: string) {
  // Picking a specific map (e.g. "Save & play" from the editor) switches to its mode.
  const wanted = selectId ? allMaps().find(m => m.id === selectId) : undefined;
  if (wanted) modeSelect.value = mapMode(wanted);
  maps = allMaps().filter(m => mapMode(m) === currentMode());
  const prev = selectId ?? mapSelect.value;
  mapSelect.innerHTML = maps.map(m => {
    const size = `${m.terrain[0].length}×${m.terrain.length}`;
    const tag = isBuiltin(m.id) ? '' : ' · custom';
    const players = mapMode(m) === '3v3' ? '3 vs 3' : `up to ${m.maxPlayers}P`;
    return `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (${size}, ${players}${tag})</option>`;
  }).join('') || '<option value="">No maps for this mode yet — make one in the Map editor</option>';
  if (maps.some(m => m.id === prev)) mapSelect.value = prev;

  const is3v3 = currentMode() === '3v3';
  $('count-row').classList.toggle('hidden', is3v3);
  $('presets-row').classList.toggle('hidden', is3v3);
  const help = $('mode-help');
  help.classList.toggle('hidden', !is3v3);
  help.textContent = 'West (players 1–3) vs East (players 4–6). Turns alternate between the teams. '
    + 'Cities pay 800 per turn in this mode (HQs and factories 1,000). '
    + 'Set any slot to CPU, or let one person command several armies on the same team with “Same human as …”.';
}
renderMapOptions();

/** Offer only the player counts the chosen map supports. */
function renderCountOptions() {
  const map = selectedMap();
  if (!map) return;
  const counts = Object.keys(map.slotsByPlayerCount).map(Number).sort();
  const prev = Number(countSelect.value) || counts[counts.length - 1];
  countSelect.innerHTML = counts.map(c => `<option value="${c}">${c}</option>`).join('');
  countSelect.value = String(counts.includes(prev) ? prev : counts[counts.length - 1]);
}

/** Slots in play, in turn order. */
const activeSlots = () => (selectedMap() ? slotsFor(selectedMap(), Number(countSelect.value)) : []);
const TEAM_NAMES_3V3: Record<number, string> = { 1: 'West', 2: 'East' };

/** Rows remember their settings per start slot, so switching maps or counts keeps your choices. */
function rememberRows() {
  const memo = new Map<number, { name: string; control: string; commander: string; team: string }>();
  rows.querySelectorAll<HTMLElement>('.player-row').forEach(r => memo.set(Number(r.dataset.slot), {
    name: (r.querySelector('input') as HTMLInputElement).value,
    control: (r.querySelector('select.control') as HTMLSelectElement).value,
    commander: (r.querySelector('select.commander') as HTMLSelectElement).value,
    team: (r.querySelector('select.team') as HTMLSelectElement | null)?.value ?? '',
  }));
  return memo;
}

function renderRows(teams?: number[]) {
  const map = selectedMap();
  const turnOrder = activeSlots();
  const is3v3 = !!map && mapMode(map) === '3v3';
  // 3 vs 3 rows are listed by team (West 1–3, East 4–6); standard rows in turn order.
  const shown = is3v3 ? [...turnOrder].sort((a, b) => a - b) : turnOrder;
  const memo = rememberRows();
  rows.innerHTML = '';
  shown.forEach((slot, i) => {
    const old = memo.get(slot);
    if (is3v3 && (slot === 1 || slot === 4)) {
      const h = document.createElement('div');
      h.className = 'team-header';
      h.textContent = `${TEAM_NAMES_3V3[map!.teams?.[String(slot)] ?? 1]} team`;
      rows.appendChild(h);
    }
    const row = document.createElement('div');
    row.className = 'player-row';
    row.dataset.slot = String(slot);
    const team = teams?.[i] ?? (old?.team ? Number(old.team) : i + 1);
    const control = old?.control ?? (i > 0 ? 'medium' : 'human'); // default: you vs. the computer
    const teamCell = is3v3
      ? `<span class="team-tag">Player ${slot}</span>`
      : `<select class="team">${[1, 2, 3, 4].map(t => `<option value="${t}" ${t === team ? 'selected' : ''}>Team ${t}</option>`).join('')}</select>`;
    row.innerHTML = `
      <span class="swatch" style="background:${cssColor(PLAYER_COLORS[slot - 1])}"></span>
      <input value="${escapeHtml(old?.name ?? DEFAULT_FACTIONS[slot - 1])}" maxlength="24" />
      <select class="control" data-want="${escapeHtml(control)}"></select>
      ${teamCell}
      <select class="commander" title="Commander">${commanderOptions(old?.commander ?? COMMANDER_IDS[(slot - 1) % COMMANDER_IDS.length])}</select>`;
    rows.appendChild(row);
  });
  refreshControlOptions();
}

/**
 * Fill each row's control menu. On 3 vs 3 maps a row can be "Same human as X"
 * for any teammate X that is played by a human (so one person runs 2–3 armies).
 */
function refreshControlOptions() {
  const map = selectedMap();
  const is3v3 = !!map && mapMode(map) === '3v3';
  const rowEls = [...rows.querySelectorAll<HTMLElement>('.player-row')];
  const info = rowEls.map(r => {
    const sel = r.querySelector('select.control') as HTMLSelectElement;
    return {
      slot: Number(r.dataset.slot),
      name: (r.querySelector('input') as HTMLInputElement).value.trim() || `Player ${r.dataset.slot}`,
      sel,
      value: sel.dataset.want ?? sel.value,
    };
  });
  const teamOfSlot = (slot: number) => map?.teams?.[String(slot)] ?? 0;
  for (const me of info) {
    const leads = is3v3
      ? info.filter(o => o.slot !== me.slot && teamOfSlot(o.slot) === teamOfSlot(me.slot) && o.value === 'human')
      : [];
    const options: Array<[string, string]> = [
      ...CONTROLS,
      ...leads.map(o => [`with:${o.slot}`, `Same human as ${o.name}`] as [string, string]),
    ];
    // A "same human" pick whose teammate stopped being human falls back to Human.
    const value = options.some(([v]) => v === me.value) ? me.value : 'human';
    me.sel.innerHTML = options.map(([v, label]) =>
      `<option value="${escapeHtml(v)}" ${v === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
    me.value = value;
    delete me.sel.dataset.want;
  }
}
rows.addEventListener('change', e => {
  if ((e.target as HTMLElement).matches('select.control')) refreshControlOptions();
});
rows.addEventListener('input', e => {
  if ((e.target as HTMLElement).matches('input')) refreshControlOptions(); // names appear in "Same human as …"
});

modeSelect.onchange = () => { showSetupError(null); renderMapOptions(); renderCountOptions(); renderRows(); };
mapSelect.onchange = () => { renderCountOptions(); renderRows(); };
countSelect.onchange = () => renderRows();
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(b => {
  b.onclick = () => {
    showSetupError(null);
    if (b.dataset.preset === '2v2') {
      if (selectedMap().maxPlayers < 4) return showSetupError(`${selectedMap().name} only supports ${selectedMap().maxPlayers} players.`);
      countSelect.value = '4';
      renderRows([1, 2, 1, 2]); // diagonal allies, turns alternate between teams
    } else {
      renderRows();
    }
  };
});
renderCountOptions();
renderRows();

// Unit set: Standard or one made in the unit editor (the last pick is remembered).
const unitSetSelect = $<HTMLSelectElement>('unitset-select');
function renderUnitSetOptions(selectId?: string) {
  const sets = listUnitSets();
  const want = selectId ?? (unitSetSelect.value || lastUnitSetPick());
  unitSetSelect.innerHTML = '<option value="">Standard</option>'
    + sets.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} · custom</option>`).join('');
  unitSetSelect.value = sets.some(s => s.id === want) ? want : '';
}
renderUnitSetOptions();
unitSetSelect.onchange = () => rememberUnitSetPick(unitSetSelect.value);

// Fog of war checkbox remembers your last choice in this browser.
const FOG_PREF_KEY = 'iron-front.fogPref';
const fogToggle = $<HTMLInputElement>('fog-toggle');
try {
  fogToggle.checked = localStorage.getItem(FOG_PREF_KEY) === '1';
} catch {
  fogToggle.checked = false;
}

// ---------------------------------------------------------------- continue / load

function showSetupError(message: string | null) {
  const el = $('setup-error');
  el.classList.toggle('hidden', !message);
  el.textContent = message ?? '';
}

const autosave = readAutosave();
if (autosave && autosave.winnerTeam === null) {
  const p = autosave.players[autosave.current];
  $('continue-info').textContent =
    `${autosave.mapName ?? 'Saved game'}${autosave.fog ? ' · Fog' : ''}${autosave.unitSet ? ` · ${autosave.unitSet.name} units` : ''} · Day ${autosave.day} · ${p.name}'s turn`;
  $('continue-box').classList.remove('hidden');
  $('continue-btn').onclick = () => startGame(autosave, true);
}

$('load-file-btn').onclick = () => {
  showSetupError(null);
  pickSaveFile()
    .then(state => startGame(state, true))
    .catch((e: Error) => showSetupError(e.message));
};

$('start-btn').onclick = () => {
  const map = selectedMap();
  if (!map) return showSetupError('There are no maps for this mode yet. Make one in the Map editor.');
  // Setups go in turn order; rows may be listed differently (3 vs 3 groups them by team).
  const turnOrder = activeSlots();
  const rowBySlot = new Map([...rows.querySelectorAll<HTMLElement>('.player-row')].map(r => [Number(r.dataset.slot), r]));
  const rowEls = turnOrder.map(slot => rowBySlot.get(slot)!);
  const commanders = resolveCommanders(rowEls.map(r => (r.querySelector('select.commander') as HTMLSelectElement).value));
  const setups: PlayerSetup[] = rowEls.map((r, i) => {
    const control = (r.querySelector('select.control') as HTMLSelectElement).value;
    const lead = control.startsWith('with:') ? turnOrder.indexOf(Number(control.slice(5))) : -1;
    return {
      name: (r.querySelector('input') as HTMLInputElement).value.trim() || `Player ${turnOrder[i]}`,
      team: Number((r.querySelector('select.team') as HTMLSelectElement | null)?.value ?? 0),
      commander: commanders[i],
      ...(lead >= 0 ? { controller: lead } : {}),
      ...controlToSetup(control),
    };
  });
  if (mapMode(map) === 'standard' && new Set(setups.map(s => s.team)).size < 2) {
    showSetupError('Everyone is on the same team — put at least one player on a different team.');
    return;
  }
  const fog = fogToggle.checked;
  try {
    localStorage.setItem(FOG_PREF_KEY, fog ? '1' : '0');
  } catch {
    // just a convenience
  }
  const stored = listUnitSets().find(s => s.id === unitSetSelect.value);
  const unitSet = stored ? { name: stored.name, units: stored.units, damage: stored.damage } : undefined;
  startGame(createGame(map, setups, { fog, unitSet }), false);
};

// ---------------------------------------------------------------- map editor

const editor = new MapEditor(playMapId => {
  $('setup').classList.remove('hidden');
  renderMapOptions(playMapId);
  renderCountOptions();
  renderRows();
});
$('editor-btn').onclick = () => {
  showSetupError(null);
  editor.open();
};

// ---------------------------------------------------------------- unit editor

const unitEditor = new UnitEditor(() => renderUnitSetOptions());
$('unit-editor-btn').onclick = () => {
  showSetupError(null);
  unitEditor.open();
};

// ---------------------------------------------------------------- online

const NAME_KEY = 'iron-front.onlineName';
const onlineName = $<HTMLInputElement>('online-name');
const onlineCommander = $<HTMLSelectElement>('online-commander');
const onlineStatus = $('online-status');
const joinCode = $<HTMLInputElement>('join-code');
onlineCommander.innerHTML = commanderOptions(COMMANDER_IDS[0]);
try {
  onlineName.value = localStorage.getItem(NAME_KEY) ?? '';
} catch {
  // just a convenience
}

function onlineYou() {
  const name = onlineName.value.trim() || 'Commander';
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // just a convenience
  }
  return { name, commander: resolveCommanders([onlineCommander.value])[0] };
}

function showOnlineStatus(html: string | null) {
  onlineStatus.classList.toggle('hidden', html === null);
  onlineStatus.innerHTML = html ?? '';
}

let online: OnlineClient | null = null;

/**
 * The waiting room: who sits where, empty seats you can move to, and the host's Start
 * button. Empty seats can get a CPU (host), and in 3 vs 3 a teammate can take one over.
 */
function showLobby(client: OnlineClient, lobby: LobbyInfo) {
  const me = client.seat;
  const amHost = me === lobby.host;
  const is3v3 = lobby.mode === '3v3';
  const full = lobby.seats.every(Boolean);
  const isPerson = (i: number) => !!lobby.seats[i] && !lobby.seats[i]!.cpu && lobby.seats[i]!.lead === undefined;
  const teamName = (i: number) => (is3v3 ? TEAM_NAMES_3V3[lobby.teams[i]] ?? `Team ${lobby.teams[i]}` : `Team ${lobby.teams[i]}`);
  // Resuming a saved match: each seat is a saved army, shown by its name.
  const armies = lobby.restored?.armies;
  const details = `${lobby.restored ? `Resuming a saved match · day ${lobby.restored.day} · ` : ''}${escapeHtml(lobby.mapName)}${lobby.fog ? ' · Fog' : ''}${lobby.unitSetName ? ` · ${escapeHtml(lobby.unitSetName)} units` : ''}`;
  const seats = lobby.seats.map((s, i) => {
    const lead = s?.lead !== undefined ? lobby.seats[s.lead] : null;
    const leadName = lead ? lead.name : armies && s?.lead !== undefined ? `${armies[s.lead]}'s player` : '?';
    const control = s?.cpu ? CONTROLS.find(([v]) => v === s.cpu)?.[1] ?? 'CPU'
      : s?.lead !== undefined ? `played by ${escapeHtml(leadName)}` : '';
    // The host decides who plays any seat nobody sits in: nobody yet, a CPU, or (3 vs 3) a teammate.
    const teammates = is3v3 ? lobby.seats.map((_, j) => j).filter(j => isPerson(j) && lobby.teams[j] === lobby.teams[i]) : [];
    const current = s?.cpu ?? (s?.lead !== undefined ? `lead:${s.lead}` : 'human');
    const options: Array<[string, string]> = [
      ['human', 'Open seat'],
      ...CONTROLS.filter(([v]) => v !== 'human'),
      ...teammates.map(j => [`lead:${j}`, `Played by ${lobby.seats[j]!.name}`] as [string, string]),
    ];
    const hostPick = amHost && !isPerson(i)
      ? `<select data-seat-control="${i}" title="Who plays this army">${options.map(([v, label]) =>
        `<option value="${escapeHtml(v)}" ${v === current ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`
      : '';
    // In 3 vs 3 anyone can take over an empty army on their team, and give back one they took.
    const sameTeam = me >= 0 && lobby.teams[me] === lobby.teams[i];
    const takeOver = is3v3 && !amHost && !s && sameTeam ? `<button type="button" data-take="${i}">Take over</button>` : '';
    const giveBack = !amHost && s?.lead === me ? `<button type="button" data-give="${i}">Give back</button>` : '';
    let who: string;
    const army = armies ? `<b>${escapeHtml(armies[i])}</b> ` : '';
    if (isPerson(i)) {
      // In a resumed match, say who is playing a saved army if it's someone with another name.
      const other = armies && s!.name.trim().toLowerCase() !== armies[i].trim().toLowerCase() ? `played by ${escapeHtml(s!.name)}` : '';
      const tags = [other, i === me ? 'you' : '', i === lobby.host ? 'host' : '', !s!.online ? 'offline' : ''].filter(Boolean);
      who = `<b>${escapeHtml(armies ? armies[i] : s!.name)}</b>${tags.length ? ` <span class="meta">(${tags.join(', ')})</span>` : ''}`;
    } else if (s) {
      who = `<b>${escapeHtml(armies ? armies[i] : s.name)}</b> ${hostPick || `<span class="meta">(${control})</span>`} ${giveBack}`;
    } else {
      who = `${army}<span class="meta">${armies ? 'empty' : 'Empty'}</span> <button type="button" data-sit="${i}">Sit here</button> ${takeOver} ${hostPick}`;
    }
    return `<div class="lobby-seat"><span class="swatch" style="background:${cssColor(lobby.colors[i])}"></span>
      <span class="meta">${i + 1}. ${escapeHtml(teamName(i))}</span><span>${who}</span></div>`;
  }).join('');
  const waitingFor = lobby.seats.filter(s => s === null).length;
  const fill = is3v3 ? 'CPUs or teammates' : 'CPUs';
  const status = full
    ? (amHost ? 'Everyone is here.' : 'Everyone is here. Waiting for the host to start…')
    : `Waiting for ${waitingFor} more player${waitingFor === 1 ? '' : 's'}…${amHost ? ` (or fill the empty seats with ${fill})` : ''}`;
  const help = lobby.restored
    ? 'Friends join with this new code. Using the same name as before puts them back on their army, or they can pick one with Sit here. Names, commanders and the whole match come from the save.'
    : is3v3
      ? 'West vs East, turns alternate between the teams. Pick an empty seat to change team. An army nobody sits in is played by a CPU, or by a teammate who then plays two armies.'
      : 'Turns go in seat order. Pick an empty seat to change your team or turn.';
  showOnlineStatus(`Share this code with your friends:<div class="code">${escapeHtml(lobby.code)}</div>${details}
    <div class="lobby-seats">${seats}</div>
    <div class="meta">${help}</div>
    <div>${status}</div>
    <div class="actions">
      ${amHost ? `<button id="online-start" class="primary" type="button" ${full ? '' : 'disabled'}>Start game</button>` : ''}
      <button id="online-cancel" type="button">${amHost ? 'Close game' : 'Leave'}</button>
    </div>`);
  onlineStatus.querySelectorAll<HTMLButtonElement>('[data-sit]').forEach(b => { b.onclick = () => client.sit(Number(b.dataset.sit)); });
  onlineStatus.querySelectorAll<HTMLButtonElement>('[data-take]').forEach(b => { b.onclick = () => client.share(Number(b.dataset.take), me); });
  onlineStatus.querySelectorAll<HTMLButtonElement>('[data-give]').forEach(b => { b.onclick = () => client.share(Number(b.dataset.give), null); });
  onlineStatus.querySelectorAll<HTMLSelectElement>('[data-seat-control]').forEach(sel => {
    sel.onchange = () => {
      const seat = Number(sel.dataset.seatControl);
      if (sel.value.startsWith('lead:')) client.share(seat, Number(sel.value.slice(5)));
      else client.setCpu(seat, sel.value === 'human' ? null : sel.value as Difficulty);
    };
  });
  document.getElementById('online-start')?.addEventListener('click', () => client.start());
  document.getElementById('online-cancel')?.addEventListener('click', () => { client.cancel(); showOnlineStatus(null); });
}

function newOnlineClient(): OnlineClient {
  $('online-rejoin').classList.add('hidden'); // a new connection replaces any older saved game

  const client: OnlineClient = new OnlineClient({
    lobby: lobby => showLobby(client, lobby),
    start: (state, events, link) => {
      showOnlineStatus(null);
      startGame(state, true, { link, events });
    },
    error: message => showOnlineStatus(`<span style="color:#ffb4b4">${escapeHtml(message)}</span>`),
  });
  online = client;
  return client;
}

$('host-btn').onclick = () => {
  showSetupError(null);
  const map = selectedMap();
  if (!map) return showOnlineStatus('<span style="color:#ffb4b4">Pick a map first.</span>');
  // Seats follow the player rows above: their count, teams and turn order (3 vs 3: always 6, teams set by the map).
  const turnOrder = activeSlots();
  const rowBySlot = new Map([...rows.querySelectorAll<HTMLElement>('.player-row')].map(r => [Number(r.dataset.slot), r]));
  const rowEls = turnOrder.map(slot => rowBySlot.get(slot)!);
  const teams = mapMode(map) === '3v3'
    ? turnOrder.map(slot => map.teams?.[String(slot)] ?? 0)
    : rowEls.map(r => Number((r.querySelector('select.team') as HTMLSelectElement | null)?.value ?? 0));
  // Rows set to CPU become CPU seats; the others are open for people. (A row's name and
  // commander are also used if the host turns that seat into a CPU in the lobby.)
  const commanders = resolveCommanders(rowEls.map(r => (r.querySelector('select.commander') as HTMLSelectElement).value));
  const seatRows: SeatRow[] = rowEls.map((r, i) => {
    const value = (r.querySelector('select.control') as HTMLSelectElement).value;
    const control = controlToSetup(value);
    // "Same human as …" (3 vs 3): kept when that row turns out to be the host's own seat.
    const lead = value.startsWith('with:') ? turnOrder.indexOf(Number(value.slice(5))) : -1;
    return {
      name: (r.querySelector('input') as HTMLInputElement).value.trim(),
      commander: commanders[i],
      ...(control.ai ? { cpu: control.difficulty } : {}),
      ...(lead >= 0 ? { with: lead } : {}),
    };
  });
  if (seatRows.every(row => row.cpu)) {
    return showOnlineStatus('<span style="color:#ffb4b4">Every player row is set to CPU: set at least one to Human for yourself.</span>');
  }
  if (new Set(teams).size < 2) {
    return showOnlineStatus('<span style="color:#ffb4b4">Everyone is on the same team: put at least one player on a different team.</span>');
  }
  const stored = listUnitSets().find(s => s.id === unitSetSelect.value);
  const unitSet = stored ? { name: stored.name, units: stored.units, damage: stored.damage } : undefined;
  showOnlineStatus('Connecting…');
  newOnlineClient().host({ t: 'host', you: onlineYou(), map, fog: fogToggle.checked, unitSet, teams, rows: seatRows });
};

$('join-btn').onclick = () => {
  const code = joinCode.value.trim().toUpperCase();
  if (code.length !== 4) return showOnlineStatus('<span style="color:#ffb4b4">Enter the 4-letter code from the host.</span>');
  showOnlineStatus('Connecting…');
  newOnlineClient().join(code, onlineYou());
};
joinCode.onkeydown = e => { if (e.key === 'Enter') $('join-btn').click(); };

// Carry on a match the host saved earlier: the server opens a new room with everyone's seats waiting.
$('resume-btn').onclick = () => {
  showSetupError(null);
  pickOnlineSave()
    .then(file => {
      showOnlineStatus('Connecting…');
      newOnlineClient().hostSave(onlineYou(), file);
    })
    .catch((e: Error) => showOnlineStatus(`<span style="color:#ffb4b4">${escapeHtml(e.message)}</span>`));
};

const savedOnline = savedSession();
if (savedOnline) {
  $('online-rejoin-info').textContent = `Code ${savedOnline.code} · you are player ${savedOnline.seat + 1}`;
  $('online-rejoin').classList.remove('hidden');
  $('online-rejoin-btn').onclick = () => {
    showOnlineStatus('Reconnecting…');
    newOnlineClient().resume(savedOnline);
  };
}

function startGame(state: GameState, resumed: boolean, onlineGame?: { link: OnlineLink; events: GameEvent[] }) {
  applyUnitSet(state.unitSet); // this game's unit stats (Standard unless it was set up with a custom set)
  $('setup').classList.add('hidden');
  $('game').classList.remove('hidden');

  // The canvas fills the board area; the camera handles zoom and scrolling.
  const board = $('board');
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'board',
    width: board.clientWidth || state.width * TILE,
    height: board.clientHeight || state.height * TILE,
    backgroundColor: '#1b2027',
    scale: { mode: Phaser.Scale.RESIZE },
  });
  game.scene.add('game', GameScene, true, { state, hud: new Hud(), resumed, online: onlineGame });
  // Handy for debugging in the browser console during development (not in built releases).
  if (import.meta.env.DEV) (window as unknown as { ironFront: Phaser.Game }).ironFront = game;
}
