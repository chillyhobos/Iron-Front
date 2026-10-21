// Browser side of online play: one WebSocket to the game server, plus the saved
// seat (code + token) so a refresh can rejoin the game.

import type { Action, Difficulty, GameEvent, GameState } from '../core/state';
import type { ClientMessage, LobbyInfo, OnlineSaveFile, SeatStatus, ServerMessage, StandIn } from './protocol';

const SESSION_KEY = 'iron-front.online';

/** The online game this browser has a seat in. */
export interface OnlineSession { code: string; token: string; seat: number }

export function savedSession(): OnlineSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as OnlineSession) : null;
  } catch {
    return null;
  }
}

export function forgetSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

function saveSession(s: OnlineSession) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    // Without storage you just can't rejoin after a refresh.
  }
}

/** What the game screen needs: who we are, a way to send moves, and updates from the server. */
export interface OnlineLink {
  seat: number;
  code: string;
  send(action: Action): void;
  onState(cb: (state: GameState, events: GameEvent[]) => void): void;
  /** Seat of the host (who can hand absent players' armies to stand-ins). */
  host: number;
  /** Who can play each army right now, and how each seat is played. Called at once with the latest. */
  onPresence(cb: (online: boolean[], seats: SeatStatus[]) => void): void;
  /** Host: cover an absent player's army with a CPU or a teammate, or null to wait for them. */
  standIn(seat: number, to: StandIn | null): void;
  /** Host: ask the server for a save file of the whole match (it arrives through onSaveFile). */
  requestSave(): void;
  onSaveFile(cb: (file: OnlineSaveFile) => void): void;
  onError(cb: (message: string) => void): void;
  /** Stop playing here (the seat is kept on the server, so you can rejoin). */
  leave(): void;
}

export interface ClientEvents {
  lobby(lobby: LobbyInfo): void;
  /** The game started (or we rejoined it): hand over to the game screen. */
  start(state: GameState, events: GameEvent[], link: OnlineLink): void;
  error(message: string, fatal: boolean): void;
}

export class OnlineClient {
  private ws: WebSocket | null = null;
  private session: OnlineSession | null = null;
  private started = false;
  private queue: ClientMessage[] = [];
  private stateCb: (state: GameState, events: GameEvent[]) => void = () => {};
  private presenceCb: (online: boolean[], seats: SeatStatus[]) => void = () => {};
  private lastPresence: [boolean[], SeatStatus[]] = [[], []];
  private saveFileCb: (file: OnlineSaveFile) => void = () => {};
  private hostSeat = -1;
  private errorCb: (message: string) => void = () => {};
  private retry = 0;
  private closedOnPurpose = false;

  constructor(private events: ClientEvents) {}

  host(msg: Extract<ClientMessage, { t: 'host' }>) { this.connect(msg); }
  join(code: string, you: { name: string; commander?: string }) { this.connect({ t: 'join', code, you }); }
  /** Carry on a saved match in a new room (you host it). */
  hostSave(you: { name: string; commander?: string }, file: OnlineSaveFile) { this.connect({ t: 'hostSave', you, file }); }
  resume(s: OnlineSession) { this.connect({ t: 'resume', code: s.code, token: s.token }); }

  /** Our seat, or -1 before the server gave us one. */
  get seat() { return this.session?.seat ?? -1; }

  /** Before the start: move to an empty seat. */
  sit(seat: number) { this.send({ t: 'sit', seat }); }
  /** Host, before the start: put a CPU in an empty seat, or open a CPU seat again (null). */
  setCpu(seat: number, difficulty: Difficulty | null) { this.send({ t: 'cpu', seat, difficulty }); }
  /** 3 vs 3, before the start: the person in seat `lead` also plays army `seat`, or null to open it again. */
  share(seat: number, lead: number | null) { this.send({ t: 'share', seat, lead }); }
  /** Host: start once every seat is taken. */
  start() { this.send({ t: 'start' }); }

  /** Leave the lobby (the host closes the game for everyone). */
  cancel() {
    this.send({ t: 'leave' });
    this.closedOnPurpose = true;
    this.ws?.close();
    forgetSession();
  }

  private connect(first: ClientMessage) {
    this.closedOnPurpose = false;
    this.queue = [first];
    this.open();
  }

  private open() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = e => this.receive(JSON.parse(String(e.data)) as ServerMessage);
    ws.onclose = () => {
      if (this.closedOnPurpose) return;
      // Lost the connection: once we have a seat, keep trying to rejoin quietly.
      if (this.session) {
        this.errorCb('Connection lost. Reconnecting…');
        const delay = Math.min(10000, 1000 * 2 ** this.retry++);
        window.setTimeout(() => { this.queue = [{ t: 'resume', code: this.session!.code, token: this.session!.token }]; this.open(); }, delay);
      } else {
        this.events.error("Couldn't reach the game server. Is it running (npm run server)?", true);
      }
    };
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  private receive(msg: ServerMessage) {
    switch (msg.t) {
      case 'seat':
        this.session = { code: msg.code, token: msg.token, seat: msg.seat };
        saveSession(this.session);
        return;
      case 'lobby':
        return this.events.lobby(msg.lobby);
      case 'state':
        this.hostSeat = msg.host;
        this.presence(msg.online, msg.seats);
        if (!this.started && this.session) {
          this.started = true;
          return this.events.start(msg.state, msg.events, this.link());
        }
        return this.stateCb(msg.state, msg.events);
      case 'presence':
        return this.presence(msg.online, msg.seats);
      case 'saveFile':
        return this.saveFileCb(msg.file);
      case 'error':
        if (msg.fatal) {
          forgetSession();
          this.session = null;
          this.closedOnPurpose = true;
          this.ws?.close();
        }
        if (this.started && !msg.fatal) return this.errorCb(msg.message);
        return this.events.error(msg.message, !!msg.fatal);
    }
  }

  private presence(online: boolean[], seats: SeatStatus[]) {
    this.lastPresence = [online, seats];
    this.presenceCb(online, seats);
  }

  private link(): OnlineLink {
    const s = this.session!;
    return {
      seat: s.seat,
      code: s.code,
      send: action => this.send({ t: 'action', action }),
      onState: cb => { this.stateCb = cb; },
      host: this.hostSeat,
      onPresence: cb => { this.presenceCb = cb; cb(...this.lastPresence); },
      standIn: (seat, to) => this.send({ t: 'standin', seat, to }),
      requestSave: () => this.send({ t: 'save' }),
      onSaveFile: cb => { this.saveFileCb = cb; },
      onError: cb => { this.errorCb = cb; },
      leave: () => { this.closedOnPurpose = true; this.ws?.close(); },
    };
  }
}
