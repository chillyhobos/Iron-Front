// HTML side panel, popup menus and overlays. Kept in the DOM (not the canvas)
// so text stays crisp and layouts are easy to tweak with CSS.

import { MAX_UNITS, supplyClassOf, UNIT_ORDER, UNITS, type SupplyClass, type UnitType } from '../core/data';
import { allUnitsOf, atUnitCap } from '../core/rules';
import { canUsePower, commanderOf, powerCharge, unitCost } from '../core/commanders';
import type { GameState, Player } from '../core/state';

const $ = (id: string) => document.getElementById(id)!;

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** "CPU · Hard" for computer players, "Played by …" for shared armies, "Human" otherwise. */
export const controlLabel = (p: Player, players?: Player[]) => {
  if (p.ai) return `CPU · ${p.difficulty[0].toUpperCase()}${p.difficulty.slice(1)}`;
  const lead = p.controller !== undefined ? players?.[p.controller] : undefined;
  return lead ? `Played by ${lead.name}` : 'Human';
};

export const cssColor = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export interface MenuOption {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export class Hud {
  private menu = $('action-menu');
  private build = $('build-menu');
  private overlay = $('overlay');

  onEndTurn(cb: () => void) {
    $('end-turn').onclick = cb;
  }

  onUndo(cb: () => void) {
    $('undo-btn').onclick = cb;
  }

  onSave(cb: () => void) {
    $('save-btn').onclick = cb;
  }

  onMenu(cb: () => void) {
    $('menu-btn').onclick = cb;
  }

  setUndoEnabled(enabled: boolean) {
    ($('undo-btn') as HTMLButtonElement).disabled = !enabled;
  }

  /** Online games: no undo (the other player already saw the move) and no save file (the server keeps the game). */
  setOnline(code: string) {
    $('undo-btn').classList.add('hidden');
    $('save-btn').classList.add('hidden');
    $('online-tag').textContent = `Online · code ${code}`;
    $('online-tag').classList.remove('hidden');
  }

  /** Online: show whether the other player is connected. */
  setPresence(text: string, ok: boolean) {
    const el = $('online-tag');
    el.textContent = text;
    el.classList.toggle('offline', !ok);
  }

  private standInHtml = '';

  /**
   * Online host: armies whose player is away, each with a menu of who covers it
   * (option values are passed back to onPick). Empty list hides the box.
   */
  setStandIns(rows: Array<{ seat: number; label: string; value: string; options: Array<[string, string]> }>, onPick: (seat: number, value: string) => void) {
    $('standins').classList.toggle('hidden', !rows.length);
    const html = rows.map(r => `<div class="standin-row"><span>${escapeHtml(r.label)}</span>
      <select data-seat="${r.seat}">${r.options.map(([v, label]) =>
        `<option value="${escapeHtml(v)}" ${v === r.value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></div>`).join('');
    // Updates arrive many times a turn: only rebuild when something changed, so an open menu stays open.
    if (html === this.standInHtml) return;
    this.standInHtml = html;
    const list = $('standin-list');
    list.innerHTML = html;
    list.querySelectorAll<HTMLSelectElement>('select').forEach(sel => { sel.onchange = () => onPick(Number(sel.dataset.seat), sel.value); });
  }

  /** viewerTeam: under fog, opponents' funds and unit counts are hidden from this team. */
  render(s: GameState, viewerTeam: number | null = null) {
    const p = s.players[s.current];
    const secret = (team: number) => !!s.fog && viewerTeam !== null && team !== viewerTeam;
    $('turn-info').innerHTML = `
      <div>Day ${s.day}${s.fog ? ' · <span title="Fog of war is on">🌫 Fog</span>' : ''}</div>
      <div class="who" style="color:${cssColor(p.color)}">${escapeHtml(p.name)}</div>
      <div>Funds: <b>${secret(p.team) ? '?' : p.funds.toLocaleString()}</b></div>`;

    $('player-list').innerHTML = s.players.map(pl => {
      const units = secret(pl.team) ? '?' : String(allUnitsOf(s, pl.id).length);
      const funds = secret(pl.team) ? '?' : pl.funds.toLocaleString();
      const props = s.tiles.filter(t => t.owner === pl.id).length;
      const cls = ['player-entry', pl.id === s.current ? 'active' : '', pl.alive ? '' : 'dead'].join(' ');
      return `<div class="${cls}">
        <span class="swatch" style="background:${cssColor(pl.color)}"></span>
        <div style="flex:1;min-width:0"><div>${escapeHtml(pl.name)}</div>
        <div class="meta">${pl.ai || pl.controller !== undefined ? `${escapeHtml(controlLabel(pl, s.players))} · ` : ''}Team ${pl.team} · ${units} units · ${props} props · ${funds}</div>
        ${this.commanderLine(s, pl.id)}</div>
      </div>`;
    }).join('');
    this.renderPowerButton(s);

    const log = $('log');
    log.innerHTML = s.log.slice(-30).map(l => `<div>${escapeHtml(l)}</div>`).join('');
    log.scrollTop = log.scrollHeight;
  }

  /** Commander name, power status and meter bar for the side panel. */
  private commanderLine(s: GameState, pid: number): string {
    const c = commanderOf(s, pid);
    if (!c) return '';
    const p = s.players[pid];
    const { meter, needed } = powerCharge(s, pid);
    const pct = Math.round(Math.min(1, meter / needed) * 100);
    const status = p.powerActive
      ? ` · <b class="power-on">⚡ ${escapeHtml(c.power.name)} active</b>`
      : pct >= 100 ? ` · <b style="color:#ffd76a">⚡ ready</b>` : '';
    return `<div class="meta" title="${escapeHtml(`${c.passive.description} Power — ${c.power.name}: ${c.power.description}`)}">${escapeHtml(c.name)}${status}</div>
      <div class="meter ${pct >= 100 ? 'full' : ''}"><span style="width:${p.powerActive ? 100 : pct}%"></span></div>`;
  }

  private renderPowerButton(s: GameState) {
    const btn = $('power-btn') as HTMLButtonElement;
    const p = s.players[s.current];
    const c = commanderOf(s, s.current);
    btn.classList.toggle('hidden', !c || p.ai);
    if (!c) return;
    const { meter, needed } = powerCharge(s, s.current);
    const ready = canUsePower(s, s.current);
    btn.classList.toggle('ready', ready);
    btn.classList.toggle('active', !!p.powerActive);
    btn.disabled = !ready;
    btn.textContent = p.powerActive
      ? `⚡ ${c.power.name} active`
      : ready ? `⚡ Use ${c.power.name}!` : `⚡ ${c.power.name} ${Math.floor((meter / needed) * 100)}%`;
    btn.title = `${c.power.name}: ${c.power.description}`;
  }

  onPower(cb: () => void) {
    $('power-btn').onclick = cb;
  }

  setInfo(html: string) {
    $('tile-info').innerHTML = html;
  }

  showActionMenu(left: number, top: number, options: MenuOption[]) {
    this.menu.innerHTML = '';
    for (const o of options) {
      const b = document.createElement('button');
      b.textContent = o.label;
      b.disabled = !!o.disabled;
      b.onclick = e => { e.stopPropagation(); o.onClick(); };
      this.menu.appendChild(b);
    }
    this.menu.classList.remove('hidden');
    this.placeActionMenu(left, top);
  }

  /** Move the open menu (e.g. to follow its tile while the map scrolls), keeping it on screen. */
  placeActionMenu(left: number, top: number) {
    if (this.menu.classList.contains('hidden')) return;
    const r = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - r.width - 8))}px`;
    this.menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - r.height - 8))}px`;
  }

  hideActionMenu() {
    this.menu.classList.add('hidden');
  }

  /** builds: which kind of building was clicked (factory = ground, port = naval, airfield = air). */
  showBuild(s: GameState, builds: SupplyClass, buildingName: string, onPick: (t: UnitType) => void, onCancel: () => void) {
    const funds = s.players[s.current].funds;
    const capped = atUnitCap(s, s.current);
    this.build.innerHTML = `<div class="panel">
      <h2 style="margin:0">Build at ${escapeHtml(buildingName)}</h2>
      <div style="color:var(--muted)">Funds: ${funds.toLocaleString()}</div>
      ${capped ? `<div class="error" style="margin-top:8px">Unit limit reached (${MAX_UNITS}). Lose or trade units to build more.</div>` : ''}
      <div class="build-list"></div>
      <button class="cancel">Cancel</button>
    </div>`;
    const list = this.build.querySelector('.build-list')!;
    for (const t of UNIT_ORDER.filter(u => supplyClassOf(u) === builds)) {
      const d = UNITS[t];
      const b = document.createElement('button');
      const range = d.maxRange > 1 ? ` · range ${d.minRange}–${d.maxRange}` : '';
      const cost = unitCost(s, s.current, t);
      const deal = cost < d.cost ? ` <s style="color:var(--muted);font-weight:400">${d.cost.toLocaleString()}</s>` : '';
      b.innerHTML = `<span>${d.name} <span style="color:var(--muted)">(move ${d.move}${range})</span></span><b>${cost.toLocaleString()}${deal}</b>`;
      b.disabled = capped || cost > funds;
      b.onclick = () => { this.hideBuild(); onPick(t); };
      list.appendChild(b);
    }
    (this.build.querySelector('.cancel') as HTMLButtonElement).onclick = () => { this.hideBuild(); onCancel(); };
    this.build.onclick = e => { if (e.target === this.build) { this.hideBuild(); onCancel(); } };
    this.build.classList.remove('hidden');
  }

  hideBuild() {
    this.build.classList.add('hidden');
  }

  /** Small non-blocking banner above the board (e.g. "CPU is thinking"). Pass null to hide. */
  showBanner(text: string | null, color?: number) {
    const b = $('banner');
    b.classList.toggle('hidden', text === null);
    if (text !== null) {
      b.textContent = text;
      b.style.borderColor = color !== undefined ? cssColor(color) : '';
    }
  }

  /** End-of-game summary table. */
  statsTable(s: GameState): string {
    const rows = [...s.players]
      .sort((a, b) => Number(b.team === s.winnerTeam) - Number(a.team === s.winnerTeam))
      .map(p => {
        const st = p.stats;
        const props = s.tiles.filter(t => t.owner === p.id).length;
        return `<tr class="${p.team === s.winnerTeam ? 'winner' : ''}">
          <td><span class="swatch" style="display:inline-block;background:${cssColor(p.color)}"></span> ${escapeHtml(p.name)}</td>
          <td>${p.team}</td><td>${st.built}</td><td>${st.destroyed}</td><td>${st.lost}</td>
          <td>${st.captured}</td><td>${props}</td><td>${st.spent.toLocaleString()}</td>
        </tr>`;
      }).join('');
    return `<table class="stats-table">
      <thead><tr><th>Commander</th><th>Team</th><th>Built</th><th>Destroyed</th><th>Lost</th><th>Captured</th><th>Buildings</th><th>Spent</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  showOverlay(title: string, subtitle: string, button: string, onClick: () => void, color?: number, bodyHtml = '', opaque = false) {
    this.overlay.classList.toggle('opaque', opaque);
    this.overlay.innerHTML = `<div class="panel">
      <h2 style="color:${color !== undefined ? cssColor(color) : 'var(--accent)'}">${escapeHtml(title)}</h2>
      <p>${escapeHtml(subtitle)}</p>
      ${bodyHtml}
      <button class="primary">${escapeHtml(button)}</button>
    </div>`;
    (this.overlay.querySelector('button') as HTMLButtonElement).onclick = () => {
      this.overlay.classList.add('hidden');
      onClick();
    };
    this.overlay.classList.remove('hidden');
  }
}
