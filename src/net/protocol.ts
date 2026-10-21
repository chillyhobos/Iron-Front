// Messages between the browser and the game server (JSON over a WebSocket at /ws).
// The server runs the real rules: browsers only send what they want to do, and get
// back the game as their player may see it.

import type { MapDef, MapMode } from '../core/maps';
import type { Action, Difficulty, GameEvent, GameState } from '../core/state';
import type { UnitSetData } from '../core/unitSets';

/** Join codes: 4 letters, no look-alikes (no I/O). */
export const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;

export interface SeatSetup {
  name: string;
  /** Commander id, or undefined for classic rules. */
  commander?: string;
}

/**
 * A seat as set up in the host's player rows: cpu set = played by the server. In 3 vs 3,
 * `with` = the seat whose person also plays this army (only kept if that is the host).
 */
export interface SeatRow extends SeatSetup {
  cpu?: Difficulty;
  with?: number;
}

/** Who covers an army while the person who normally plays it is away: a CPU, or a teammate's seat. */
export type StandIn = { cpu: Difficulty } | { lead: number };

/** How a seat is played during the game (sent with every state, so the host can manage stand-ins). */
export interface SeatStatus {
  /** person = someone sits there; shared = played by the person in seat `lead` as well as their own army. */
  kind: 'person' | 'cpu' | 'shared';
  lead?: number;
  /** A person seat whose browser is disconnected. */
  away: boolean;
  /** Covering for an absent player, until they come back. */
  standIn?: StandIn;
}

export type ClientMessage =
  /**
   * Open a new game. Standard maps: teams.length players (2–4), teams[i] is the team of
   * seat i, and seats take turns in that order. 3 vs 3 maps: always 6 seats, with
   * teams set by the map (teams is ignored). rows[i] (optional) can make seat i a CPU; its name
   * and commander are also used if the host turns that seat into a CPU later. The host
   * takes the first seat that isn't a CPU.
   */
  | { t: 'host'; you: SeatSetup; map: MapDef; fog: boolean; unitSet?: UnitSetData; teams: number[]; rows?: SeatRow[] }
  | { t: 'join'; code: string; you: SeatSetup }
  /** Come back after a refresh or dropped connection. */
  | { t: 'resume'; code: string; token: string }
  /** Before the game starts: move to an empty seat (to pick your team or turn). */
  | { t: 'sit'; seat: number }
  /** Host only, before the start: make an empty seat a CPU, or a CPU seat empty again (null). */
  | { t: 'cpu'; seat: number; difficulty: Difficulty | null }
  /**
   * 3 vs 3, before the start: the person in seat `lead` also plays army `seat` (same team),
   * or null to open it again. Anyone can take over an empty seat on their team for
   * themselves or give back their own; the host can assign or clear any seat nobody sits in.
   */
  | { t: 'share'; seat: number; lead: number | null }
  /** Host only, once every seat is taken. */
  | { t: 'start' }
  | { t: 'action'; action: Action }
  /**
   * Host only, during the game: an army whose player is disconnected gets a stand-in (a CPU,
   * or a connected teammate), or null to wait for them. It goes back to them when they return.
   */
  | { t: 'standin'; seat: number; to: StandIn | null }
  /** Before the start the host closes the game, anyone else gives up their seat. Later: stop playing here. */
  | { t: 'leave' };

export interface LobbyInfo {
  code: string;
  mode: MapMode;
  mapName: string;
  fog: boolean;
  unitSetName?: string;
  /**
   * null = empty. CPU seats are always online. lead = the seat of the person who also
   * plays this army (3 vs 3); it's online when they are.
   */
  seats: Array<{ name: string; online: boolean; cpu?: Difficulty; lead?: number } | null>;
  /** Team and army colour of each seat. */
  teams: number[];
  colors: number[];
  /** Seat of the player who can start the game. */
  host: number;
}

export type ServerMessage =
  /** You have a seat: keep the token to rejoin later. */
  | { t: 'seat'; code: string; seat: number; token: string }
  | { t: 'lobby'; lobby: LobbyInfo }
  /** The game as you may see it, plus what just happened that you could see. */
  | { t: 'state'; state: GameState; events: GameEvent[]; online: boolean[]; seats: SeatStatus[]; host: number }
  /** Someone came or went. online[i]: army i can be played right now (by its person, a CPU or a stand-in). */
  | { t: 'presence'; online: boolean[]; seats: SeatStatus[] }
  | { t: 'error'; message: string; fatal?: boolean };
