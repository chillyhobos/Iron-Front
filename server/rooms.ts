// Online matches: rooms with a join code, 2–6 seats, and the authoritative game.
// Standard maps take 2–4 seats; 3 vs 3 maps always take 6, and an army nobody sits
// in is played by a CPU or by a teammate who runs two armies.
// Everything players do arrives here as a message; the real rules engine decides
// what happens, and each player gets back only what their side may see.
// If someone drops out mid-game, the host can hand their army to a CPU or a teammate
// until they come back. The host can also save the match to a sealed file and carry
// on from it later in a new room, where everyone's seats wait for them.

import { randomBytes } from 'crypto';
import { createGame, mapMode, slotsFor, type MapDef, type MapMode } from '../src/core/maps';
import { applyAction, startTurn } from '../src/core/rules';
import { applyUnitSet, upgradeUnitSet, validateUnitSet, type UnitSetData } from '../src/core/unitSets';
import { nextAiAction } from '../src/core/ai';
import { COMMANDERS } from '../src/core/commanders';
import { PLAYER_COLORS } from '../src/core/data';
import { playerView, visibleEvents } from '../src/core/view';
import { checkMap } from '../src/core/mapTools';
import { seal, unseal } from './seal';
import type { Action, Difficulty, GameEvent, GameState } from '../src/core/state';
import {
  CODE_LENGTH, CODE_LETTERS, type ClientMessage, type LobbyInfo, type OnlineSaveFile, type SeatRow, type SeatSetup, type SeatStatus, type ServerMessage, type StandIn,
} from '../src/net/protocol';

export const MIN_SEATS = 2;
export const MAX_SEATS = 4;
export const SEATS_3V3 = 6;
/** Pause between CPU actions, so people can follow what the CPU does. */
export const CPU_STEP_MS = 300;
const DIFFICULTIES = new Set<Difficulty>(['easy', 'medium', 'hard']);
/** Bump when saved matches change shape in a way older servers can't read. */
const SAVE_VERSION = 1;
/** Rooms nobody has touched for this long are closed. */
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

/** One browser connection. */
export interface Conn {
  send(msg: ServerMessage): void;
  room?: Room;
  seat?: number;
}

/** A taken seat: a person, a CPU, or (3 vs 3) an army a teammate plays as well as their own. */
interface Seat {
  you: SeatSetup;
  /** Secret for rejoining; empty for CPU and teammate-played seats, which nobody can take over. */
  token: string;
  conn: Conn | null;
  /** Played by the server. */
  cpu?: Difficulty;
  /** Played by the person with this token (it follows them if they change seats). */
  leadToken?: string;
  /** During the game: who covers this army while the person who normally plays it is away. */
  standIn?: { cpu?: Difficulty; leadToken?: string };
  /** Resuming a save: played by whoever takes this other seat (becomes leadToken when they do). */
  pendingLead?: number;
}

/** A seat with a person in it. */
const isPerson = (s: Seat | null | undefined): boolean => !!s && !s.cpu && !s.leadToken && s.pendingLead === undefined;

/** What a save file holds (sealed): the whole match, not any one player's fogged view. */
interface SavedMatch {
  room: {
    map: MapDef; mode: MapMode; fog: boolean; unitSet?: UnitSetData; teams: number[]; armySetups: SeatSetup[];
    seats: Array<{ kind: 'person' | 'cpu' | 'shared'; cpu?: Difficulty; lead?: number }>;
    hostSeat: number;
  };
  state: GameState;
}

export interface Room {
  code: string;
  map: MapDef;
  mode: MapMode;
  fog: boolean;
  unitSet?: UnitSetData;
  /** Team of each seat; seats take turns in this order. */
  teams: number[];
  seats: Array<Seat | null>;
  /** Name and commander for each seat if a CPU or a teammate plays it, from the host's player rows. */
  armySetups: SeatSetup[];
  /** A CPU step is waiting to run. */
  cpuBusy: boolean;
  /** The host's token: it follows them if they change seats. */
  hostToken: string;
  state: GameState | null;
  touched: number;
  /** Carrying on a saved match: the game waiting for the host to start it again. */
  restored?: GameState;
  /** In a resumed match, the army in each seat (people rejoining with that name get it back). */
  armyNames?: string[];
}

const ACTION_TYPES = new Set(['act', 'build', 'endTurn', 'power']);

export class Rooms {
  readonly rooms = new Map<string, Room>();

  constructor(
    private now: () => number = Date.now,
    /** How CPU steps are delayed (tests run them by hand). */
    private schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms); },
  ) {}

  handle(conn: Conn, msg: ClientMessage) {
    try {
      switch (msg?.t) {
        case 'host': return this.host(conn, msg);
        case 'join': return this.join(conn, msg);
        case 'hostSave': return this.hostSave(conn, msg);
        case 'save': return this.saveMatch(conn);
        case 'resume': return this.resume(conn, msg);
        case 'sit': return this.sit(conn, msg.seat);
        case 'cpu': return this.setCpu(conn, msg.seat, msg.difficulty);
        case 'share': return this.share(conn, msg.seat, msg.lead);
        case 'start': return this.startByHost(conn);
        case 'action': return this.act(conn, msg.action);
        case 'standin': return this.setStandIn(conn, msg.seat, msg.to);
        case 'leave': return this.leave(conn);
        default: return conn.send({ t: 'error', message: 'Unknown message.' });
      }
    } catch (e) {
      conn.send({ t: 'error', message: `Server error: ${(e as Error).message}` });
    }
  }

  /** A browser went away: keep its seat (it can resume) and tell the others. */
  disconnect(conn: Conn) {
    const room = conn.room;
    if (!room || conn.seat === undefined) return;
    const seat = room.seats[conn.seat];
    if (seat?.conn === conn) seat.conn = null;
    this.broadcastPresence(room);
  }

  /** Close rooms nobody has touched in a long time. */
  sweep() {
    for (const [code, room] of this.rooms) if (this.now() - room.touched > ROOM_TTL_MS) this.rooms.delete(code);
  }

  // ------------------------------------------------------------ joining

  private host(conn: Conn, msg: Extract<ClientMessage, { t: 'host' }>) {
    if (conn.room) return conn.send({ t: 'error', message: "You're already in a game." });
    const you = cleanSetup(msg.you);
    const problem = checkMap(msg.map);
    if (problem) return conn.send({ t: 'error', message: `That map can't be used: ${problem}` });
    const mode = mapMode(msg.map);
    let teams: number[];
    if (mode === '3v3') {
      // Always 6 armies, teams fixed by the map.
      const slots = slotsFor(msg.map, SEATS_3V3);
      if (slots.length !== SEATS_3V3) return conn.send({ t: 'error', message: `${msg.map.name} has no 6-player setup.` });
      teams = slots.map(slot => msg.map.teams?.[String(slot)] ?? 0);
    } else {
      teams = Array.isArray(msg.teams) ? msg.teams.map(Number) : [];
      if (teams.length < MIN_SEATS || teams.length > MAX_SEATS) {
        return conn.send({ t: 'error', message: `Standard maps are for ${MIN_SEATS}–${MAX_SEATS} players. For 5 or 6, pick a 3 vs 3 map.` });
      }
      if (!teams.every(t => Number.isInteger(t) && t >= 1 && t <= MAX_SEATS)) return conn.send({ t: 'error', message: 'Teams must be 1–4.' });
      if (slotsFor(msg.map, teams.length).length !== teams.length) {
        return conn.send({ t: 'error', message: `${msg.map.name} doesn't support ${teams.length} players.` });
      }
    }
    if (new Set(teams).size < 2) return conn.send({ t: 'error', message: 'Everyone is on the same team: put at least one player on a different team.' });
    let unitSet: UnitSetData | undefined;
    if (msg.unitSet) {
      unitSet = upgradeUnitSet(msg.unitSet);
      const bad = validateUnitSet(unitSet);
      if (bad.length) return conn.send({ t: 'error', message: `That unit set can't be used: ${bad[0]}` });
    }
    const rows: SeatRow[] = teams.map((_, i) => (Array.isArray(msg.rows) ? msg.rows[i] : undefined) ?? { name: '' });
    const cpus = rows.map(row => (DIFFICULTIES.has(row.cpu as Difficulty) ? row.cpu : undefined));
    const shared = (i: number) => mode === '3v3' && Number.isInteger(rows[i].with) && rows[i].with !== i;
    // The host takes the first seat that's for a person of its own (not a CPU, not "same human as").
    let hostSeat = cpus.findIndex((c, i) => !c && !shared(i));
    if (hostSeat < 0) hostSeat = cpus.findIndex(c => !c);
    if (hostSeat < 0) return conn.send({ t: 'error', message: 'Every seat is a CPU: leave at least one seat for yourself.' });
    const room: Room = {
      code: this.newCode(), map: msg.map, mode, fog: !!msg.fog, unitSet, teams,
      seats: Array(teams.length).fill(null),
      armySetups: rows.map((row, i) => cleanSetup(row, `${mode === '3v3' ? 'Army' : 'CPU'} ${i + 1}`)),
      cpuBusy: false, hostToken: '', state: null, touched: this.now(),
    };
    cpus.forEach((cpu, i) => { if (cpu) room.seats[i] = this.cpuSeat(room, i, cpu); });
    this.rooms.set(room.code, room);
    room.hostToken = this.seat(conn, room, hostSeat, you);
    // "Same human as" rows pointing at the host's seat: the host plays those armies too.
    rows.forEach((row, i) => {
      if (shared(i) && !cpus[i] && i !== hostSeat && row.with === hostSeat && teams[i] === teams[hostSeat]) {
        room.seats[i] = this.sharedSeat(room, i, room.hostToken);
      }
    });
    this.broadcastLobby(room);
  }

  private join(conn: Conn, msg: Extract<ClientMessage, { t: 'join' }>) {
    if (conn.room) return conn.send({ t: 'error', message: "You're already in a game." });
    const room = this.rooms.get(String(msg.code ?? '').trim().toUpperCase());
    if (!room) return conn.send({ t: 'error', message: 'No game with that code. Check it with your friend.' });
    const you = cleanSetup(msg.you);
    // Their old seat in a resumed match, an empty seat, or else an army a teammate was going
    // to play as well: a real person beats sharing.
    let free = this.savedSeatFor(room, you.name);
    if (free < 0) free = room.seats.findIndex(s => s === null);
    if (free < 0) free = room.seats.findIndex(s => !!s?.leadToken);
    if (room.state || free < 0) return conn.send({ t: 'error', message: 'That game is already full.' });
    room.touched = this.now();
    this.seat(conn, room, free, you);
    this.broadcastLobby(room);
  }

  /** In a resumed match: the empty seat whose army has this person's name (-1 if none). */
  private savedSeatFor(room: Room, name: string): number {
    const want = name.trim().toLowerCase();
    return room.armyNames ? room.seats.findIndex((s, i) => s === null && room.armyNames![i].trim().toLowerCase() === want) : -1;
  }

  /** Carry on a saved match: a new room whose seats are the saved armies, waiting for their people. */
  private hostSave(conn: Conn, msg: Extract<ClientMessage, { t: 'hostSave' }>) {
    if (conn.room) return conn.send({ t: 'error', message: "You're already in a game." });
    const file = msg.file;
    if (file?.game !== 'iron-front-online' || typeof file.data !== 'string') return conn.send({ t: 'error', message: "That file isn't a saved online match." });
    if (!(file.version <= SAVE_VERSION)) return conn.send({ t: 'error', message: 'That save is from a newer version of the game.' });
    let saved: SavedMatch;
    try {
      saved = unseal(file.data) as SavedMatch;
    } catch {
      return conn.send({ t: 'error', message: 'That save is damaged, or was made on a different server (saves only open on the server that made them).' });
    }
    const { room: r, state } = saved;
    const n = state?.players?.length ?? 0;
    if (!r || r.seats?.length !== n || r.teams?.length !== n || r.armySetups?.length !== n || checkMap(r.map)) {
      return conn.send({ t: 'error', message: 'That save is damaged.' });
    }
    if (state.winnerTeam !== null) return conn.send({ t: 'error', message: 'That match is already over.' });
    let unitSet: UnitSetData | undefined;
    if (r.unitSet) {
      unitSet = upgradeUnitSet(r.unitSet);
      if (validateUnitSet(unitSet).length) return conn.send({ t: 'error', message: "That save's unit set is damaged." });
    }
    const room: Room = {
      code: this.newCode(), map: r.map, mode: r.mode, fog: r.fog, unitSet, teams: r.teams,
      seats: Array(n).fill(null), armySetups: r.armySetups, cpuBusy: false, hostToken: '', state: null,
      touched: this.now(), restored: state, armyNames: state.players.map(p => p.name),
    };
    r.seats.forEach((st, i) => {
      if (st.kind === 'cpu') room.seats[i] = this.cpuSeat(room, i, DIFFICULTIES.has(st.cpu!) ? st.cpu! : 'medium');
      else if (st.kind === 'shared' && Number.isInteger(st.lead)) room.seats[i] = { you: room.armySetups[i], token: '', conn: null, pendingLead: st.lead };
    });
    // The host takes their own army back (by name, else the seat the match was saved from), else any free seat.
    const you = cleanSetup(msg.you);
    let hostSeat = this.savedSeatFor(room, you.name);
    if (hostSeat < 0 && room.seats[r.hostSeat] === null) hostSeat = r.hostSeat;
    if (hostSeat < 0) hostSeat = room.seats.findIndex(s => s === null);
    if (hostSeat < 0) return conn.send({ t: 'error', message: 'Every army in that match is a CPU: there is no seat for you.' });
    this.rooms.set(room.code, room);
    room.hostToken = this.seat(conn, room, hostSeat, you);
    this.broadcastLobby(room);
  }

  /** Host only: the whole match, sealed, to download and carry on later. */
  private saveMatch(conn: Conn) {
    const room = conn.room;
    const s = room?.state;
    if (!room || !s || conn.seat === undefined) return conn.send({ t: 'error', message: 'The game has not started.' });
    if (room.seats[conn.seat]?.token !== room.hostToken) return conn.send({ t: 'error', message: 'Only the host can save the match.' });
    if (s.winnerTeam !== null) return conn.send({ t: 'error', message: 'The match is over: there is nothing to save.' });
    const saved: SavedMatch = {
      room: {
        map: room.map, mode: room.mode, fog: room.fog, unitSet: room.unitSet, teams: room.teams, armySetups: room.armySetups,
        // Stand-ins aren't saved: absent players get their armies back when the match carries on.
        seats: room.seats.map(seat => {
          if (seat?.cpu) return { kind: 'cpu' as const, cpu: seat.cpu };
          const lead = seat?.leadToken ? this.leadOf(room, seat) : -1;
          return lead >= 0 ? { kind: 'shared' as const, lead } : { kind: 'person' as const };
        }),
        hostSeat: conn.seat,
      },
      state: s,
    };
    const file: OnlineSaveFile = {
      game: 'iron-front-online', version: SAVE_VERSION, savedAt: new Date(this.now()).toISOString(),
      summary: { map: room.map.name, day: s.day, armies: s.players.map(p => p.name) },
      data: seal(saved),
    };
    conn.send({ t: 'saveFile', file });
  }

  /** Before the start, players can move to an empty seat to choose their team and turn. */
  private sit(conn: Conn, to: number) {
    const room = conn.room;
    if (!room || conn.seat === undefined) return conn.send({ t: 'error', message: "You're not in a game." });
    if (room.state) return conn.send({ t: 'error', message: 'The game has already started.' });
    if (!Number.isInteger(to) || to < 0 || to >= room.seats.length || room.seats[to]) {
      return conn.send({ t: 'error', message: 'That seat is taken.' });
    }
    const seat = room.seats[conn.seat]!;
    room.seats[to] = seat;
    room.seats[conn.seat] = null;
    conn.seat = to;
    // Armies they were going to play on their old team go back to being empty.
    room.seats.forEach((s, i) => { if (s?.leadToken === seat.token && room.teams[i] !== room.teams[to]) room.seats[i] = null; });
    this.claimPendingLeads(room, to, seat.token);
    room.touched = this.now();
    conn.send({ t: 'seat', code: room.code, seat: to, token: seat.token });
    this.broadcastLobby(room);
  }

  /** Host only, before the start: fill an empty seat with a CPU, change its difficulty, or open it again. */
  private setCpu(conn: Conn, seatNo: number, difficulty: Difficulty | null) {
    const room = this.hostRoom(conn);
    if (!room) return;
    if (!Number.isInteger(seatNo) || seatNo < 0 || seatNo >= room.seats.length) return conn.send({ t: 'error', message: 'No such seat.' });
    if (isPerson(room.seats[seatNo])) return conn.send({ t: 'error', message: 'Someone is sitting there.' });
    if (difficulty !== null && !DIFFICULTIES.has(difficulty)) return conn.send({ t: 'error', message: 'Unknown CPU difficulty.' });
    room.seats[seatNo] = difficulty ? this.cpuSeat(room, seatNo, difficulty) : null;
    room.touched = this.now();
    this.broadcastLobby(room);
  }

  /** 3 vs 3, before the start: a person also plays the army in another seat on their team (or gives it back). */
  private share(conn: Conn, seatNo: number, lead: number | null) {
    const room = conn.room;
    if (!room || conn.seat === undefined) return conn.send({ t: 'error', message: "You're not in a game." });
    if (room.state) return conn.send({ t: 'error', message: 'The game has already started.' });
    if (room.mode !== '3v3') return conn.send({ t: 'error', message: 'Only 3 vs 3 games let one person play two armies.' });
    if (!Number.isInteger(seatNo) || seatNo < 0 || seatNo >= room.seats.length) return conn.send({ t: 'error', message: 'No such seat.' });
    const seat = room.seats[seatNo];
    if (isPerson(seat)) return conn.send({ t: 'error', message: 'Someone is sitting there.' });
    const me = room.seats[conn.seat]!;
    const amHost = me.token === room.hostToken;
    if (lead === null) {
      if (seat && !amHost && seat.leadToken !== me.token) return conn.send({ t: 'error', message: 'Only the host or the person playing that army can open it.' });
      room.seats[seatNo] = null;
    } else {
      if (!amHost && lead !== conn.seat) return conn.send({ t: 'error', message: 'You can only take over an army for yourself.' });
      if (!amHost && seat) return conn.send({ t: 'error', message: 'That army already has a player: ask the host.' });
      const leader = Number.isInteger(lead) ? room.seats[lead] : undefined;
      if (!isPerson(leader)) return conn.send({ t: 'error', message: "There's nobody in that seat to play it." });
      if (room.teams[lead] !== room.teams[seatNo]) return conn.send({ t: 'error', message: 'You can only play armies on your own team.' });
      room.seats[seatNo] = this.sharedSeat(room, seatNo, leader!.token);
    }
    room.touched = this.now();
    this.broadcastLobby(room);
  }

  private cpuSeat(room: Room, seatNo: number, difficulty: Difficulty): Seat {
    return { you: room.armySetups[seatNo], token: '', conn: null, cpu: difficulty };
  }

  private sharedSeat(room: Room, seatNo: number, leadToken: string): Seat {
    return { you: room.armySetups[seatNo], token: '', conn: null, leadToken };
  }

  /** The seat of the person who plays a shared army (-1 if none). */
  private leadOf(room: Room, seat: Seat) {
    return room.seats.findIndex(s => isPerson(s) && s!.token === seat.leadToken);
  }

  /** The room this connection hosts, if it hasn't started (otherwise tells them why not). */
  private hostRoom(conn: Conn): Room | undefined {
    const room = conn.room;
    if (!room || conn.seat === undefined) { conn.send({ t: 'error', message: "You're not in a game." }); return undefined; }
    if (room.state) { conn.send({ t: 'error', message: 'The game has already started.' }); return undefined; }
    if (room.seats[conn.seat]?.token !== room.hostToken) { conn.send({ t: 'error', message: 'Only the host can do that.' }); return undefined; }
    return room;
  }

  private startByHost(conn: Conn) {
    const room = this.hostRoom(conn);
    if (!room) return;
    if (!room.seats.every(Boolean)) {
      return conn.send({ t: 'error', message: `Wait until every seat is taken (or fill empty seats with CPUs${room.mode === '3v3' ? ' or teammates' : ''}).` });
    }
    const orphan = room.seats.findIndex(s => s?.pendingLead !== undefined);
    if (orphan >= 0) {
      const names = room.armyNames!;
      return conn.send({ t: 'error', message: `${names[orphan]} was played by ${names[room.seats[orphan]!.pendingLead!]}'s player, who isn't here: choose who plays it now.` });
    }
    this.start(room);
  }

  private resume(conn: Conn, msg: Extract<ClientMessage, { t: 'resume' }>) {
    const room = this.rooms.get(String(msg.code ?? '').toUpperCase());
    const seatNo = msg.token ? room?.seats.findIndex(s => isPerson(s) && s!.token === msg.token) ?? -1 : -1;
    if (!room || seatNo < 0) return conn.send({ t: 'error', message: 'That game has ended or expired.', fatal: true });
    const seat = room.seats[seatNo]!;
    // A newer tab takes over the seat from an older one.
    if (seat.conn && seat.conn !== conn) seat.conn.send({ t: 'error', message: 'This game was opened somewhere else.', fatal: true });
    seat.conn = conn;
    conn.room = room;
    conn.seat = seatNo;
    room.touched = this.now();
    conn.send({ t: 'seat', code: room.code, seat: seatNo, token: seat.token });
    if (room.state && this.giveBack(room, seat)) return this.runCpu(room); // (that sent everyone the game)
    if (room.state) this.sendState(room, seatNo, []);
    this.broadcastPresence(room);
    this.runCpu(room); // CPUs wait while nobody is watching
  }

  private leave(conn: Conn) {
    const room = conn.room;
    if (!room || conn.seat === undefined) return;
    const seat = room.seats[conn.seat];
    conn.room = undefined;
    conn.seat = undefined;
    if (!seat || seat.conn !== conn) return;
    if (room.state) {
      // The game goes on; they can rejoin.
      seat.conn = null;
      return this.broadcastPresence(room);
    }
    if (seat.token === room.hostToken) {
      // Nobody has started playing: the host just closes it.
      this.rooms.delete(room.code);
      for (const s of room.seats) if (s && s !== seat) s.conn?.send({ t: 'error', message: 'The host closed this game.', fatal: true });
      return;
    }
    // Their seat, and any army they were going to play as well, are free again.
    room.seats.forEach((s, i) => { if (s === seat || s?.leadToken === seat.token) room.seats[i] = null; });
    this.broadcastLobby(room);
  }

  // ------------------------------------------------------------ playing

  private start(room: Room) {
    applyUnitSet(room.unitSet);
    if (room.restored) {
      // Carry on exactly where the save left off; the seats decide who plays each army now.
      room.state = room.restored;
      delete room.restored;
      room.state.log.push(`Match resumed from a save (day ${room.state.day}).`);
      room.touched = this.now();
      return this.controlChanged(room, room.seats.map((_, i) => i));
    }
    const setups = room.seats.map((seat, i) => {
      const lead = seat!.leadToken ? this.leadOf(room, seat!) : -1;
      return {
        name: seat!.you.name, team: room.teams[i], commander: seat!.you.commander,
        // (A shared army whose person is gone can't happen; a CPU covers it just in case.)
        ai: !!seat!.cpu || (!!seat!.leadToken && lead < 0), difficulty: seat!.cpu ?? 'medium' as Difficulty,
        ...(lead >= 0 ? { controller: lead } : {}),
      };
    });
    room.state = createGame(room.map, setups, { fog: room.fog, unitSet: room.unitSet });
    const events = startTurn(room.state);
    room.state.log.push('Online game: good luck!');
    room.touched = this.now();
    room.seats.forEach((_, i) => this.sendState(room, i, events));
    this.runCpu(room);
  }

  private act(conn: Conn, action: Action) {
    const room = conn.room;
    const s = room?.state;
    if (!room || !s || conn.seat === undefined) return conn.send({ t: 'error', message: 'The game has not started.' });
    if (s.winnerTeam !== null) return conn.send({ t: 'error', message: 'The game is over.' });
    // Your own army's turn, or the turn of a teammate's army you play.
    if (s.current !== conn.seat && s.players[s.current].controller !== conn.seat) return conn.send({ t: 'error', message: "It isn't your turn." });
    if (!action || !ACTION_TYPES.has(action.type)) return conn.send({ t: 'error', message: 'Unknown action.' });
    room.touched = this.now();
    applyUnitSet(room.unitSet); // several rooms can use different unit sets
    const before = JSON.parse(JSON.stringify(s)) as GameState;
    const res = applyAction(s, action);
    if (!res.ok) {
      conn.send({ t: 'error', message: res.error });
      return this.sendState(room, conn.seat, []);
    }
    room.seats.forEach((_, i) => this.sendState(room, i, visibleEvents(before, s, res.events, i)));
    this.runCpu(room);
  }

  /**
   * Play CPU turns, one action per step so everyone can follow along. Pauses while no
   * person is connected (resuming starts it again) and stops when it's a person's turn.
   */
  private runCpu(room: Room) {
    if (room.cpuBusy || !this.cpuShouldMove(room)) return;
    room.cpuBusy = true;
    this.schedule(() => {
      room.cpuBusy = false;
      if (!this.cpuShouldMove(room)) return;
      const s = room.state!;
      applyUnitSet(room.unitSet);
      const before = JSON.parse(JSON.stringify(s)) as GameState;
      let res = applyAction(s, nextAiAction(s, Math.random));
      if (!res.ok) res = applyAction(s, { type: 'endTurn' }); // never let a confused CPU stall the game
      if (!res.ok) return; // (can't happen: ending the turn is always allowed)
      room.touched = this.now();
      room.seats.forEach((_, i) => this.sendState(room, i, visibleEvents(before, s, res.events, i)));
      this.runCpu(room);
    }, CPU_STEP_MS);
  }

  private cpuShouldMove(room: Room) {
    const s = room.state;
    return !!s && this.rooms.get(room.code) === room && s.winnerTeam === null && s.players[s.current].ai
      && room.seats.some(seat => seat?.conn);
  }

  // ------------------------------------------------------------ stand-ins

  /** Host only, mid-game: cover an absent player's army with a CPU or a connected teammate (null = wait for them). */
  private setStandIn(conn: Conn, seatNo: number, to: StandIn | null) {
    const room = conn.room;
    const s = room?.state;
    if (!room || !s || conn.seat === undefined) return conn.send({ t: 'error', message: 'The game has not started.' });
    if (room.seats[conn.seat]?.token !== room.hostToken) return conn.send({ t: 'error', message: 'Only the host can do that.' });
    if (s.winnerTeam !== null) return conn.send({ t: 'error', message: 'The game is over.' });
    const seat = Number.isInteger(seatNo) ? room.seats[seatNo] : undefined;
    if (!seat || !s.players[seatNo]?.alive) return conn.send({ t: 'error', message: 'No such army in the game.' });
    const owner = this.ownerOf(room, seatNo);
    if (owner < 0) return conn.send({ t: 'error', message: 'A CPU already plays that army.' });
    if (room.seats[owner]!.conn) return conn.send({ t: 'error', message: `${room.seats[owner]!.you.name} is still connected.` });
    let standIn: Seat['standIn'];
    let label: string;
    if (to === null) {
      standIn = undefined;
      label = `waits for ${room.seats[owner]!.you.name} to come back`;
    } else if ('cpu' in to) {
      if (!DIFFICULTIES.has(to.cpu)) return conn.send({ t: 'error', message: 'Unknown CPU difficulty.' });
      standIn = { cpu: to.cpu };
      label = `is played by a CPU (${to.cpu}) for now`;
    } else {
      const lead = to.lead;
      const leader = Number.isInteger(lead) ? room.seats[lead] : undefined;
      if (!isPerson(leader) || !leader!.conn) return conn.send({ t: 'error', message: 'That player is not connected.' });
      if (lead === owner) return conn.send({ t: 'error', message: "That's the player who is away." });
      if (room.teams[lead] !== room.teams[seatNo]) return conn.send({ t: 'error', message: 'Only a teammate can stand in.' });
      standIn = { leadToken: leader!.token };
      label = `is played by ${leader!.you.name} for now`;
    }
    seat.standIn = standIn;
    s.log.push(`${s.players[seatNo].name} ${label}.`);
    room.touched = this.now();
    this.controlChanged(room, [seatNo]);
  }

  /** Someone came back: armies others were covering for them go back to them. Returns whether any did. */
  private giveBack(room: Room, person: Seat): boolean {
    const s = room.state!;
    const mine = room.seats.map((_, i) => i).filter(i => room.seats[i]?.standIn && this.ownerOf(room, i) >= 0
      && room.seats[this.ownerOf(room, i)] === person);
    if (!mine.length) return false;
    for (const i of mine) delete room.seats[i]!.standIn;
    s.log.push(`${person.you.name} is back and takes over again.`);
    this.controlChanged(room, mine);
    return true;
  }

  /** The seat of the person who normally plays an army (-1 for CPU armies). */
  private ownerOf(room: Room, seatNo: number): number {
    const seat = room.seats[seatNo];
    if (!seat || seat.cpu) return -1;
    return seat.leadToken ? this.leadOf(room, seat) : seatNo;
  }

  /**
   * Write who plays each army into the game (Player.ai / difficulty / controller), tell
   * everyone, and let a CPU carry on if it now has the turn.
   */
  private controlChanged(room: Room, changed: number[]) {
    const s = room.state!;
    room.seats.forEach((seat, i) => {
      if (!seat) return;
      const p = s.players[i];
      const control = seat.standIn ?? (seat.cpu ? { cpu: seat.cpu } : seat.leadToken ? { leadToken: seat.leadToken } : {});
      const lead = control.leadToken ? room.seats.findIndex(o => isPerson(o) && o!.token === control.leadToken) : -1;
      if (control.cpu || (control.leadToken && lead < 0)) {
        p.ai = true;
        p.difficulty = control.cpu ?? 'medium';
        delete p.controller;
      } else {
        p.ai = false;
        if (lead >= 0 && lead !== i) p.controller = lead;
        else delete p.controller;
      }
    });
    // A new hand on the army whose turn it is: a fresh turn event makes every screen catch up.
    const events: GameEvent[] = changed.includes(s.current) ? [{ kind: 'turn', player: s.current, day: s.day }] : [];
    room.seats.forEach((_, i) => this.sendState(room, i, events));
    this.runCpu(room);
  }

  /** Per seat, for the game screen: how it's played, who is away, and any stand-in. */
  private statusOf(room: Room): SeatStatus[] {
    return room.seats.map(seat => {
      const kind = !seat || seat.cpu ? 'cpu' : seat.leadToken ? 'shared' : 'person';
      const status: SeatStatus = { kind, away: kind === 'person' && !seat!.conn };
      if (kind === 'shared') status.lead = this.leadOf(room, seat!);
      if (seat?.standIn?.cpu) status.standIn = { cpu: seat.standIn.cpu };
      else if (seat?.standIn?.leadToken) status.standIn = { lead: room.seats.findIndex(o => isPerson(o) && o!.token === seat.standIn!.leadToken) };
      return status;
    });
  }

  // ------------------------------------------------------------ sending

  /** Put a connection in a seat; returns the seat's secret token. */
  private seat(conn: Conn, room: Room, seatNo: number, you: SeatSetup): string {
    const token = randomBytes(16).toString('hex');
    room.seats[seatNo] = { you, token, conn };
    conn.room = room;
    conn.seat = seatNo;
    conn.send({ t: 'seat', code: room.code, seat: seatNo, token });
    this.claimPendingLeads(room, seatNo, token);
    return token;
  }

  /** Resumed match: whoever takes a seat also gets the armies that seat's player was playing for teammates. */
  private claimPendingLeads(room: Room, seatNo: number, token: string) {
    for (const s of room.seats) {
      if (s?.pendingLead === seatNo) {
        s.leadToken = token;
        delete s.pendingLead;
      }
    }
  }

  private sendState(room: Room, seatNo: number, events: GameEvent[]) {
    const conn = room.seats[seatNo]?.conn;
    if (!conn || !room.state) return;
    conn.send({
      t: 'state', state: playerView(room.state, seatNo), events, online: this.online(room), seats: this.statusOf(room),
      host: room.seats.findIndex(s => s?.token === room.hostToken),
    });
  }

  /** Per seat: can its army be played right now? (CPUs always; others when whoever plays it is connected.) */
  private online(room: Room) {
    const connected = (token: string) => !!room.seats.find(o => isPerson(o) && o!.token === token)?.conn;
    return room.seats.map(s => {
      if (!s) return false;
      const control = s.standIn ?? s;
      if (control.cpu) return true;
      if (control.leadToken) return connected(control.leadToken);
      return !!s.conn;
    });
  }

  private broadcastLobby(room: Room) {
    const slots = slotsFor(room.map, room.seats.length);
    const online = this.online(room);
    const lobby: LobbyInfo = {
      code: room.code, mode: room.mode, mapName: room.map.name, fog: room.fog, unitSetName: room.unitSet?.name,
      seats: room.seats.map((s, i) => (s ? {
        name: s.you.name, online: online[i],
        ...(s.cpu ? { cpu: s.cpu } : {}),
        ...(s.leadToken ? { lead: this.leadOf(room, s) } : s.pendingLead !== undefined ? { lead: s.pendingLead } : {}),
      } : null)),
      teams: room.teams,
      colors: slots.map(slot => PLAYER_COLORS[slot - 1]),
      host: room.seats.findIndex(s => s?.token === room.hostToken),
      ...(room.armyNames ? { restored: { day: (room.restored ?? room.state)?.day ?? 0, armies: room.armyNames } } : {}),
    };
    for (const s of room.seats) s?.conn?.send({ t: 'lobby', lobby });
  }

  private broadcastPresence(room: Room) {
    if (!room.state) return this.broadcastLobby(room);
    const online = this.online(room);
    const seats = this.statusOf(room);
    for (const s of room.seats) s?.conn?.send({ t: 'presence', online, seats });
  }

  private newCode(): string {
    for (;;) {
      const bytes = randomBytes(CODE_LENGTH);
      const code = [...bytes].map(b => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
      if (!this.rooms.has(code)) return code;
    }
  }
}

/** Keep player-chosen names and commanders sensible. */
function cleanSetup(you: SeatSetup | undefined, fallback = 'Commander'): SeatSetup {
  const name = String(you?.name ?? '').trim().slice(0, 24) || fallback;
  const commander = you?.commander && COMMANDERS[you.commander] ? you.commander : undefined;
  return { name, commander };
}
