# Iron Front

An original turn-based 2D military tactics game for 2–6 players (free-for-all, teams, or 3 vs 3), built with Phaser 3 + TypeScript. Play on one computer, against CPUs, or online with friends.

**Play it now:** https://iron-front-r94w.onrender.com. It runs on a free server, so the first visit after a quiet spell can take about a minute to wake up.

**Host it from your own PC** (you and your friends play online, no server needed):
1. Install [Node.js](https://nodejs.org) (the LTS version).
2. On GitHub, click **Code → Download ZIP** and extract it, or run `git clone https://github.com/chillyhobos/Iron-Front.git`.
3. **Windows:** double-click **Start Iron Front.bat**. **Mac / Linux:** open a terminal in the folder and run `npm run play`.

It installs and builds the game the first time (a minute or two), starts it, and opens it in your browser. It then offers a free tunnel so friends anywhere can join, and prints the link to send them. Keep its window open while you play. More detail: **Hosting from your own PC** under Online play.

**Battles:** every unit that can attack fires its own weapon. Rifles fire tracer bursts, Engineers a quicker SMG burst, snipers a single fast shot, bazookas a rocket, and tanks a shell with recoil. Machine guns rattle off rapid tracers, artillery and battleships lob arcing shells, rocket launchers fire a salvo, missile launchers send missiles up steeply, gunships fire straight missiles and bombers drop bombs. The damage shows when the shots land. If the defender survives and can hit back, it fires its own weapon, and then the attacker's damage shows. The map updates only after that, so a unit destroyed by return fire stays on screen until its explosion. Battles look and time the same offline and online, for every player, and are built to stay smooth (pooled effects from two tiny generated shapes).

**Sound:** sound effects are original and made in code too, so there are no audio files. They play in step with the animations, on every player's screen. So far:
- **Rifleman:** a punchy, bassy automatic-rifle crack with a sci-fi edge, three shots per attack in time with its tracers.
- **Engineer:** a lighter, faster SMG: a higher, raspy rattle with a bolt clack, four quick shots per attack. Blowing up a bridge gives a short, crisp blast, and repairing one gives a wrench ratchet and two clanks on steel.
- **Infantry footsteps:** Riflemen, Bazookas, Snipers and Engineers run with a step on every tile, by what the ground is. Plains give a soft grass step, forest a crunch of leaves, mountains gravel, and roads, towns and bases a crisp boot tap. Bridges give a hollow wooden thunk and rivers a splash. Under fog you only hear steps where you can see.
- **Capture hops:** a capturing unit's two hops are heard as well as seen, and they sound playful rather than heavy: a springy rising "bwip" as it leaves the ground and a soft, bouncy "bup" as it lands, in step with the animation. The second hop is a little higher than the first.
- **Vehicle engines:** everything else makes an engine sound for as long as it moves. Tanks, the Armored Carrier, Artillery and Flak Guns get a diesel chug and clanking treads. The Scout Car and the rocket and missile trucks get a smoother engine and tire roar. Interceptors and Bombers get a jet roar with a turbine whine. Gunships and Airlifts get a chopping rotor. Ships get the wash of a bow wave over a low hum. Bigger units play deeper, so a Heavy Tank rumbles lower than a Light Tank. Under fog you only hear a unit while it moves through tiles you can see.

**Music:** soft, calm electronic background music, also original and made in code as it plays: warm pads, a deep bass, a gentle echoing arpeggio, a soft kick and a shaker. When units attack, it picks up on the next beat into a faster battle groove (four-on-the-floor kick, claps, quick hats, a driving bass and a faster arpeggio), with a crash and a chord stab on each attack. A few bars after the fighting stops it eases back to calm. The music sits well under the sound effects and pauses while the tab is hidden.

Other units' weapons are silent for now. Every sound effect plays at the same loudness. Use the speaker button and volume slider in the side panel, or press **M** to mute. The 🎵 slider sets the music on its own (all the way down turns it off). Your settings are remembered in your browser. Sound starts after your first click, as browsers require.

**Art:** all graphics are original vector art drawn in code. There are no image files, so everything stays sharp at any zoom.
- **Units:** each unit has its own sprite in its army's colour. Soldiers carry distinct gear (rifle, bazooka, ghillie hood and scoped rifle, hard hat and wrench), vehicles run on tracks or wheels, aircraft hover over a shadow, and ships sit in the water with a wake.
- **Facing:** armies whose HQ is on the right half of the map face left, toward the enemy.
- **Terrain:** grass varies slightly from tile to tile, coasts get sand and surf, and buildings have shading and shadows.
- **Where the code lives:** unit art is in `src/game/sprites.ts`. Units without art fall back to a simple shape by move type.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

**Just playing (no dev server):** build once, then start the game server. It serves the game and online play at http://localhost:8787.

```bash
npm run build
npm start
```

Run `npm run build` again after changing the code.

The dev server checks for file changes on a short timer (`vite.config.ts`), because change notifications in OneDrive folders can get lost and leave the game running old code.

## How to play (hot-seat)

- **Build:** click one of your factories (ground units), ports (ships) or airfields (aircraft) to buy units. New units can act next turn.
- **Move:** click a unit; blue tiles are where it can go and red outlines are enemies it can reach. Click a tile, then pick **Attack**, **Capture** or **Wait**.
- **Inspect:** click an enemy unit to see its movement (orange) and threat range (red).
- **Capture:** Riflemen and Bazookas capture cities, factories and HQs (20 points; each turn subtracts the unit's HP). A capturing unit hops twice on the building, the same for every player, offline or online.
- **Income:** +1,000 per property at the start of your turn (3 vs 3 cities pay 800). Units repair 2 HP for a fee at your own buildings of the right kind: ground units at cities, factories and HQs, ships at ports, aircraft at airfields.
- **Win:** capture an enemy HQ or destroy all their units. The last team standing wins.
- **Camera:** scroll the mouse wheel to zoom toward the cursor, or use the **− / + / Fit** buttons at the top right of the map. Drag the map (or use the arrow keys or WASD) to scroll. A short click still selects. Each turn starts centered on the current player's army, and the camera follows CPU moves. Small maps show in full; big maps (up to 40×40) open zoomed in to a readable size.
- Right-click or Esc cancels. **Undo** (or Ctrl+Z) takes back your confirmed moves and builds, back to the start of your turn.
- Each player can have at most 50 units on the map.
- **Rivers:** only infantry (Riflemen, Bazookas, Snipers) can wade across, and it costs them 2 movement points per river tile. A Rifleman (move 3) gets in and one tile past it; a Bazooka or Sniper (move 2) needs two turns to get across. Ground vehicles can't enter rivers at all: they need a road crossing or a transport. Transports can't drop vehicles into a river, but they can drop infantry there. Rivers give no cover (0 stars). Aircraft fly over them with no penalty, and ships can't sail up them. Change the costs in `src/data/terrain.json`.

## Air and naval units

| Unit | Type | Cost | Move | Notes |
|---|---|---|---|---|
| Armored Carrier (APC) | ground | 5,000 | 6 | Carries 1 infantry. Refuels and rearms adjacent friendly units each turn. No weapon. |
| Missile Launcher | ground | 12,000 | 4 | Anti-air only, from 3–5 tiles away (can't move and fire): Gunships and Airlifts 120%, Interceptors and Bombers 100%. 6 missiles, rearms like other units. Vision 5. Tanks, Bazookas and artillery deal with it on the ground. |
| Gunship | air | 9,000 | 6 | Attacks ground units, ships and helicopters |
| Interceptor | air | 20,000 | 9 | Attacks aircraft only |
| Bomber | air | 22,000 | 7 | Heavy damage to ground units and ships |
| Airlift | air | 5,000 | 6 | Carries 1 infantry over anything. No weapon. |
| Cruiser | ship | 18,000 | 6 | Anti-air, also hits ships |
| Battleship | ship | 28,000 | 5 | Long-range guns (2–6 squares), hits ground units and ships |
| Lander | ship | 12,000 | 6 | Carries 2 ground units across water. No weapon. |

- **Buildings:** factories build ground units, **ports** build ships, **airfields** build aircraft.
- **Movement:** aircraft fly over anything. Ships stay on sea and ports. Aircraft get no cover from terrain.
- **Fuel (vehicles, aircraft and ships; infantry don't use it):** the amounts follow Advance Wars: Dual Strike.

  | Unit | Fuel | Burned each day |
  |---|---|---|
  | Scout Car | 80 | 0 |
  | APC, Light Tank | 70 | 0 |
  | Flak Gun | 60 | 0 |
  | Heavy Tank, Artillery, Rocket Launcher, Missile Launcher | 50 | 0 |
  | Gunship, Airlift | 99 | 2 |
  | Interceptor, Bomber | 99 | 5 |
  | Cruiser, Battleship, Lander | 70 | 1 |

  - **Burning it:** moving burns fuel equal to the movement points spent, so a tank crossing a forest uses 2 for that tile. A unit can't move farther than its fuel allows. Ground vehicles burn nothing while standing still.
  - **Running out:** a ground vehicle with 0 fuel can't move, but it isn't lost and can still fire from where it stands. Aircraft crash and ships sink at 0 fuel, along with any passengers.
  - **Warning:** a red **F** badge means about 3 days of fuel left for aircraft and ships, or not enough for a full move for vehicles. The info panel shows the exact amount.
- **Ammo (armed aircraft and ships):** each attack or counterattack uses 1 ammo. A red **A** badge means empty: no attacking or counterattacking until rearmed.
- **Resupply:** at the start of your turn, a unit standing on one of your own buildings of the right kind is refuelled, rearmed and repaired. Vehicles use cities, factories and HQs, aircraft use airfields, and ships use ports. An APC refuels and rearms every friendly unit right next to it (but doesn't repair them). It can't refuel itself, so it has to visit a building like everyone else.
- **Transports:** move a unit onto your own APC, Airlift or Lander and choose **Load**. Later, move the transport, choose **Unload**, pick the passenger and click a highlighted tile. A Lander can drop both passengers in one turn. Ground units can also board a Lander that is on the water next to the shore. Unloaded units have finished their turn. A "▲" badge shows how many units are aboard. If a transport is destroyed, its passengers are lost.
- **Map:** **Straits (air & sea)** is built for these units. Each player has an HQ, factory, airfield, port and city, with sea channels between the bases.
- **Test Range (all terrain):** a small 2-player map (17×13) for trying out units and rules. It has every terrain type and building in the game, and both sides own an HQ, factory, airfield, port and city, with neutral copies of each to capture. A 1-tile channel splits the map: river in the north, sea in the south (where the neutral ports sit), with a single road crossing in between. Mountain ridges flank the river, and open plains fill the south. It's a place to try out future bridge and engineer rules.
- **Infantry** don't use fuel or ammo.
- **CPU players:** build and use armed aircraft and ships, head home to refuel and rearm, and keep at most 3 aircraft per airfield and 3 ships per port.
- **CPU vehicles:** they head for their nearest supply building or APC once their fuel won't cover the trip plus a turn of driving, and they still fight on the way. With no passengers to carry, a CPU APC drives out to vehicles low on fuel or ammo and parks next to them. In test games no CPU vehicle was left stranded.
- **CPU transports:** when ground units have no land route to their target (for example, the enemy is on another island), the CPU buys a Lander or Airlift. Its units walk to the transport and board, the transport carries them across, and it drops each passenger on the tile closest to that unit's goal. Medium and Hard CPUs also buy an APC to speed infantry up long marches. Once 4 or more ground units are waiting for a lift, the CPU stops building ground units and spends on transports, aircraft and ships instead.
- **Tuning:** the numbers live in `src/data/units.json` (`fuel`, `fuelPerDay`, `ammo`, `transport`) and `src/data/terrain.json` (`supplies`, `builds`).

## Sniper

A support unit that deters and weakens infantry so other units can finish them. It isn't meant to beat an infantry push on its own.

- **Stats:** costs 4,000, moves 2 (climbs mountains easily), sees 3 tiles, can't capture, and attacks anything 1–3 squares away. It can move and shoot in the same turn.
- **Targets:** it can't damage vehicles at all.
- **Damage depends on cover, not terrain stars.** Cover means forest, mountain, city, factory or HQ.

  | Target | In the open | In cover |
  |---|---|---|
  | Rifleman | 20% | 10% |
  | Bazooka | 10% | 5% |
  | Enemy Sniper | always destroyed | 90% |

- **Steady aim:** it's the only unit that deals full damage no matter how hurt it is.
- **Shooting from range:** targets 2–3 squares away can't hit back. Adjacent ones can.
- **Fragile:** damage taken by snipers is fixed. A full-health attacker deals exactly this much, less as the attacker loses health (a 7 HP Rifleman deals 70% in the open, 63% in cover). Terrain stars and commander bonuses don't change it.

  | Attacker at full health | Sniper in the open | Sniper in cover |
  |---|---|---|
  | Any infantry | destroyed | left at 1 HP (90%) |
  | Any vehicle | destroyed | destroyed |

- **Camouflage:** with fog on, enemies only see a sniper from right next to it (Agent Wren's Blackout reveals them).
- **Commanders:** snipers count as infantry, so Juno's discount (3,400) and Vex's −10% infantry attack apply.
- **CPU players:** Medium and Hard CPUs add one sniper as support once they already have an army and the enemy fields infantry.
- **Tuning:** the numbers live in `src/data/units.json` (`precision` for damage dealt, `incomingDamage` for damage taken, `coverTerrain`) and `src/data/damage.json`.

## Engineer and bridges

A weak support unit that builds and blows up bridges, so you control where vehicles can cross rivers.

- **Stats:** costs 5,000 and is built at factories. It's half a Rifleman:
  - **Health:** 5 HP instead of 10. Repairs stop at 5 HP, and each 2 HP costs 40% of its price.
  - **Attack:** hits half as hard, because damage scales with the attacker's health.
  - **Movement:** moves 2 instead of 3 (1.5, rounded up). It wades rivers like other infantry.
  - **In the open:** gets half the benefit of terrain stars, so most full-health attackers destroy it in one hit.
  - **Dug into cover** (forest, mountain, city, factory or HQ): it takes only **30%** of a normal hit, instead of using terrain stars. A full-health attacker leaves it at:

    | Attacker at full health | Damage | Engineer left at |
    |---|---|---|
    | Rifleman / Bazooka | 16% / 19% | 4 HP |
    | Light Tank / Artillery / **Rocket Launcher** | 22% / 27% / 28% | 3 HP |
    | Heavy Tank / Flak Gun / Bomber | 31% / 31% / 33% | 2 HP |

    Damaged attackers hit for less, as usual. Snipers keep their own numbers (10% in cover). Hovering over an Engineer in cover shows "In cover: takes 30% damage". Roads, rivers, bridges, ports and airfields aren't cover. CPU Engineers count on cover too: they treat a dug-in tile as much safer.
  - **No capturing.** Snipers hit it like a Rifleman (20% in the open, 10% in cover).
- **Bridge kit:** each Engineer carries one kit. Using it either builds or demolishes one bridge.
  - **Build bridge:** move the Engineer into a river and choose **Build bridge**. That tile becomes a bridge that every ground unit can drive over (1 move point, like a road). Ships can't pass under bridges.
  - **Blow up bridge:** move the Engineer next to any bridge (yours, an enemy's or one that came with the map), choose **Blow up bridge**, and click the bridge highlighted in orange. The tile turns back into river. This works from the bank or while wading in the river beside the bridge, never from on top of it, since anyone on it dies.
  - **Repair bridge:** move the Engineer onto the **bank** (dry land) next to a cracked bridge, choose **Repair bridge**, and click the bridge. That fixes it completely. It can't repair while wading in the river or standing on the bridge.
  - **Rearm:** a used kit comes back at the start of your turn if the Engineer is on any building you own (city, factory, HQ, port or airfield) or next to one of your APCs. A red **K** badge marks an Engineer with no kit. The info panel shows "Bridge kit 0/1".
- **Shelling bridges:** Bombers, Artillery and Rocket Launchers can fire at a bridge in range. Choose **Hit bridge**, then click a bridge highlighted in orange.
  - Every bridge can take 2 damage before it collapses back into river.
  - A **Bomber** deals 2, so one bomb destroys a bridge (it uses one of its 9 bombs).
  - **Artillery** and **Rocket Launchers** deal 1. The first hit **cracks** the bridge, which shows cracks and a scorch mark. The second hit destroys it.
  - Cracked bridges can still be crossed. Hovering over one shows how many hits it has left.
  - Artillery and Rockets can't move and fire in the same turn, as usual.
  - No other unit can damage a bridge. Tanks and infantry can't; only Engineers can blow one up.
- **Anyone on a falling bridge dies.** Every ground unit on a bridge when it collapses is destroyed instantly, whatever its health and whatever brought it down (a Bomber, an Artillery or Rocket's second hit, or an Engineer). That includes infantry, vehicles, and passengers inside a transport, and units hidden in the fog.
  - A crack alone hurts nobody.
  - Aircraft flying over a bridge are unharmed.
  - Enemy units on a bridge are fair targets: bringing the bridge down kills them.
  - You can't shell or blow up a bridge that one of your own or an ally's units is standing on.
- **Maps:** bridges are their own terrain (`=` in `maps.json`, **Bridge** brush in the map editor), so maps can start with bridges already in place. Test Range has one at its middle crossing.
- **Fog of war:** everyone sees bridges appear and disappear, but the log doesn't say who built or blew them up.
- **CPU players (Medium and Hard):** they plan bridges from where their tanks need to go: the enemy's buildings, from each tank they have and from each factory.
  - **Building:** a river crossing that saves at least 8 move points (more than a turn of driving), or is the only way across, becomes a bridge site. A site enemy tanks would rush over first is skipped, unless the CPU's own armour is about as strong.
  - **Blowing up:** the CPU blows up a bridge when visible enemy tanks are within two turns of using it to reach its buildings, and its own tanks don't need it. It also does this when its armour is clearly weaker, even if it would use the bridge.
  - **Buying:** a CPU buys an Engineer when there's a job and at most 2 Engineers are alive (riders inside transports count too). It won't buy one before its first 2 capturers are out, while the factory is under fire, for a bridge site enemies currently cover, or to blow up a bridge more than about 3 turns' walk away.
  - **Orders:** Engineers press on to their job even under some fire, then walk home (or to an APC) to rearm. Without a job they stay back instead of fighting.
  - **Shelling:** the CPU's Bombers, Artillery and Rockets fire at the same bridges it wants gone. They also bring down any bridge an enemy unit is standing on, counting it as a kill, unless the CPU needs that bridge for its own tanks.
  - **Parking:** CPU ground units and transports avoid stopping on a bridge the enemy could bring down next turn. That means enough Bomber, Artillery or Rocket hits in range, or an enemy Engineer with a kit close by.
  - **Repairs:** its Engineers walk to the bank next to a cracked bridge its own tanks drive over and repair it from there. Repairs count as a job when deciding whether to buy an Engineer.
  - Easy CPUs never buy Engineers. Tanks cut off by a river wait at the planned crossing.
- **Tuning:** `maxHp`, `coverFactor`, `coverTerrain`, `coverDamage`, `bridgeKits` and `bridgeDamage` in `src/data/units.json`; the bridge's `durability` in `src/data/terrain.json`; the Engineer row in `src/data/damage.json` copies the Rifleman's.

## 3 vs 3 mode

Choose **Mode → 3 vs 3 (6 players)** on the setup screen.

- **Teams:** six armies on fixed teams, West (players 1–3) against East (players 4–6). Turns alternate between the teams: West 1, East 4, West 2, East 5, West 3, East 6.
- **Income:** in this mode, cities pay **800** per turn. HQs and factories still pay 1,000. Income goes only to the army that owns the building, not its teammates. Per-mode income lives in `MODES` in `src/core/maps.ts`.
- **Who plays:** any mix of humans and CPUs. Set a slot to CPU and the computer plays that army. Online play works too (see **Online play**).
- **One person, several armies:** set a slot to **Same human as …** to have one person command 2 or 3 armies on their team. When that person is up again, the game skips the "pass the device" screen and just shows a banner. The same applies whenever the same human plays two turns in a row, such as one human against CPUs.
- **Maps:** this mode has its own maps, which don't appear in standard games and vice versa. Each map is an exact west/east mirror, so both teams get the same ground and the same income:
  - **Riverlands (37×25):** a river splits the two sides, with one bridge per lane. Bridges are the fight: Engineers build new ones, and Bombers and artillery bring them down.
  - **Coral Straits (37×27):** island cities and airfields in the straits between two coasts, with one land bridge in the middle. Every player has a port and an airfield.
  - **Iron Ridge (39×31):** a mountain range down the middle with three passes. Tanks must take the passes, while infantry can climb.
  - **Test maps:** Twin Fronts (test) and Grand Front (40×40 test) are still there.
- **Making maps:** in the editor, set **Map type → 3 vs 3**. You need exactly one HQ for each of the six players. Left↔Right mirroring turns West players 1/2/3 into East players 4/5/6, so maps stay fair. Maps can now be up to 40×40.

## Commanders

Each player picks a commander on the setup screen (or 🎲 Random, or none for classic rules). Open **Commander guide** on that screen for the full list.

| Commander | Passive | Power |
| --- | --- | --- |
| Marshal Kade (Balanced) | none | **Rally:** +15% attack and defense, heal 1 HP |
| Colonel Vex (Armor) | Tanks +10% attack, infantry −10% | **Blitz:** vehicles +2 movement |
| Major Thorn (Artillery) | Artillery/rockets +25% attack and +1 vision, direct units −5% | **Barrage:** artillery/rockets +1 range, +25% attack |
| Captain Juno (Infantry) | Infantry 15% cheaper, capture 20% faster | **Mobilize:** infantry +2 movement, +10% attack |
| General Hask (Defense) | +10% defense, −10% attack | **Fortify:** +30% defense, heal 1 HP |
| Agent Wren (Recon, best with fog) | +1 vision, sees into forests, Scout Cars +1 move and +20% attack | **Blackout:** +10% attack, +1 movement, reveals the map under fog |

- **Power meter:** fills from combat. You get half the value of damage you take and a quarter of the damage you deal. When it's full, click **⚡ Use [power]** on your turn. The power lasts until your next turn, and each use makes the next one need 20% more charge.
- **CPU players:** they use powers as soon as they're charged and build units that suit their commander.
- **Balance:** tested with CPU-vs-CPU round-robins, 180 games with fog and 180 without. Numbers live in `src/data/commanders.json`; the `_help` note at the top explains every field.

## Fog of war

Tick **Fog of war** on the setup screen before deploying (it remembers your choice).

- You only see what your team can see: tiles within each unit's **vision** range, plus your own buildings. Fogged tiles are shaded. Allies share vision.
- Vision: Scout Car 5, Light Tank 3, everything else 2. Riflemen and Bazookas on a **mountain** see 2 tiles farther.
- **Forests hide units:** you only see into a forest from right next to it.
- **Ambush:** if your move runs into an enemy you couldn't see, your unit stops right before it and its turn ends.
- You can only attack enemies you can see. Artillery and rockets need someone to spot targets for them.
- Opponents' funds and unit counts show as "?", and the log only says someone "deployed a unit".
- Hot-seat: the handover screen fully covers the board between players.
- Undo still works, but not after a move that spotted a new enemy (so it can't be used to scout for free).
- CPU players follow the same rules. They only react to what their own units can see.

## Saving

- **Autosave:** the game saves in your browser after every action. Use **Continue** on the main menu to pick up where you left off, even mid-way through a CPU's turn.
- **Save file:** the **Save** button downloads a `.json` file. Use **Load save file…** on the main menu to load it, on any computer.
- CPU turns keep running if you switch to another tab. Animations are skipped while the tab is hidden.
- **Online matches** have their own save: see **Saving an online match** under Online play.

## Online play (2–6 players)

2 to 6 people on different computers can play one game: free-for-all or teams on standard maps (2–4 armies), or **3 vs 3** for 5 or 6 players. A small server runs the rules, so neither browser can cheat.

**Start it:** run the game server in a second terminal, next to the dev server.

```bash
npm run server
```

It listens on port 8787. The dev server forwards `/ws` to it, so players still open http://localhost:5173.

**Host and join:**
1. On the main menu, set up the game as for a local one: a Standard map, the number of **Players**, each seat's **Team** (or **Quick teams → 2 vs 2**), fog and units. Rows set to **CPU** become CPU players, with that row's name and commander. People's rows are open seats: each person picks their own name and commander.
2. Under **Online (2–6 players)**, type your name, pick a commander and click **Host online game**. You get a 4-letter code and a lobby with one row per seat. You sit in the first seat that isn't a CPU.
3. Friends type the code and click **Join with code**. Each takes the next empty seat.
4. **Sit here** on an empty seat moves you there, to pick your team or when you play. Turns go in seat order.
5. **CPU seats:** the host has a menu on every seat nobody is sitting in: **Open seat**, or **CPU · Easy / Medium / Hard**. Use it to fill seats nobody joined, or to open a CPU seat for a friend.
6. Once every seat is taken, the host clicks **Start game**. **Close game** (host) or **Leave** gets you out of the lobby.

**5 or 6 players (3 vs 3):** set **Mode → 3 vs 3** and pick a 3 vs 3 map before hosting. The game always has six armies, West against East, with turns alternating between the teams. Every army nobody sits in must be covered before the start:
- **CPU:** the host sets it to **CPU · Easy / Medium / Hard** (or sets the row to CPU before hosting).
- **A teammate plays it:** anyone can click **Take over** on an empty army on their own team, and **Give back** to undo. They then play two armies, taking both turns from their own browser. The host can also hand any army to a player on its team (**Played by …** in the seat menu). A row set to **Same human as …** the host's row starts out played by the host.
- If a new friend joins when no seat is empty, they take over an army a teammate was going to play: a real person beats sharing. Switching teams or leaving gives back the armies you had taken.

**Playing:**
- You can only act on your own turn, or the turn of a teammate's army you play (the banner names it). On anyone else's turn you see "Waiting for …" (marked "ally" for a teammate).
- **Everyone's moves are animated**, as in a game on one computer: units slide along their path, then attack (see **Battles**) or hop twice on a building they capture. Under fog you only see the part you could see: a unit seen walking into the fog vanishes where it leaves your sight, and units you couldn't see just appear. If your tab was in the background, it catches up at once instead of replaying everything.
- **CPU players** run on the server and play one action at a time, waiting for each move's animation, so everyone can follow. They pause while no person is connected and carry on when someone rejoins.
- **Teams:** allies share vision under fog and can see each other's funds. Turns are not shared: each ally plays their own army.
- The side panel shows the game code, or which players are disconnected.
- A beaten player can keep watching until the game ends.
- **Closing the tab is fine:** use **Rejoin** on the main menu to come back. The game waits on the server.
- **Saving an online match:** the host has a **Save** button. It downloads a file of the whole match (`iron-front-online-…-dayN.json`), taken at that moment. To carry on later, even after the server restarted or slept:
  1. The host clicks **Resume a saved match…** under Online and picks the file. A lobby opens with a **new code**, with every army's seat waiting.
  2. Friends join with the new code. Using the **same name** as before puts each of them back on their own army, or they can pick one with **Sit here**.
  3. CPU armies stay CPUs, and an army someone played for a teammate goes back to them. The host can put a CPU or a teammate on any army whose player can't make it, then clicks **Start game**. Play carries on exactly where it was saved, mid-turn included.
  - The file is sealed by the server: nobody can open it to peek at armies hidden by fog, and an edited file is refused.
  - A save only opens on the server that made it. Saves from your PC (`npm start`) and from Render don't mix. On Render the key is `SAVE_SECRET` (Render generates it): changing or deleting it means older saves can't be opened.
- **Someone drops out:** the host gets an **Away players** box in the side panel, with a menu for each army whose player is disconnected (including armies they play for a teammate):
  - **Nobody: wait for them:** the game waits for them, as before.
  - **CPU · Easy / Medium / Hard:** a CPU plays the army, starting at once if it's that army's turn.
  - **A connected teammate** (or **Me**): that player plays it as well as their own army.
  - When the player rejoins, they get every army back straight away, even mid-turn. The log notes each hand-over and return.
- **Fog of war:** the server only sends each player what their army can see, so hidden units stay hidden even to someone reading the network traffic.

**Hosting from your own PC:** double-click **Start Iron Front.bat** (Windows) or run `npm run play` (Mac / Linux) in the game folder. It:
- **Installs and builds** the game when needed: the first time, and again only after the game changes, such as when you download a newer version.
- **Starts the game** at http://localhost:8787 and opens it in your browser.
- **Prints a "same network" address** such as `http://192.168.0.51:8787` for friends on your Wi-Fi. Windows may ask once to let Node through the firewall; allow it on Private networks.
- **Asks whether to open a tunnel** for friends anywhere else. Say **y** and it prints a `https://….trycloudflare.com` link to send them. The link changes each time. The tunnel uses Cloudflare's free `cloudflared` tool; if it isn't installed, the window tells you how (on Windows: `winget install --id Cloudflare.cloudflared`). Skip the question with `--tunnel` or `--no-tunnel`, for example `npm run play -- --tunnel`.
- **Seals saved matches with your own private key**, made the first time and kept in your home folder (`.iron-front-save-secret`). Saves stay private, and still open after you update the game. Back that file up if you move to another PC.

Keep the window open while you play; closing it stops the game. Everyone plays through your PC, so it has to stay on and awake. Players only need a browser.

Doing it by hand instead: `npm install`, `npm run build`, then `npm start`, plus `cloudflared tunnel --url http://localhost:8787` in a second window for a tunnel. Set `SAVE_SECRET` yourself to keep saves private.

**Always on, without your PC:** host it on Render for a permanent link (see **Hosting on Render** below).

**Limits for now:**
- Only the host can hand out stand-ins, so if the host is away the others have to wait for them.
- No undo online. A save is only taken when the host clicks Save: nothing saves by itself.
- Games live in the server's memory: restarting the server ends them unless the host saved first. Unfinished games are cleared after 6 hours without activity.
- Two tabs in the same browser share one Rejoin slot, so test with different browsers or private windows.

## Hosting on Render

[Render](https://render.com) can run the game server for free, so friends can play from a link like `https://iron-front-xxxx.onrender.com` even while your PC is off. The project is ready for it: `render.yaml` tells Render how to build and start it.

### 1. Put the project on GitHub

1. Make a free account at [github.com](https://github.com), then click **New repository**. Name it `iron-front`. Private or public both work. Leave "Add a README" and ".gitignore" **unticked**, so the repository starts empty.
2. Open a terminal in the `iron-front` folder and run these one at a time, with your GitHub user name in the last-but-one line:

```bash
git init
git add .
git commit -m "Iron Front"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/iron-front.git
git push -u origin main
```

The first push opens a GitHub sign-in window. `.gitignore` keeps out `node_modules`, the build folders and local settings: about 40 source files go up, and Render rebuilds the rest.

### 2. Create the service on Render

1. Sign up at [render.com](https://render.com) with **GitHub** (easiest), and let Render see your `iron-front` repository.
2. In the dashboard, click **New → Blueprint** and pick the `iron-front` repository. Render reads `render.yaml` and shows one free web service named `iron-front`.
3. Click **Deploy Blueprint**. The first build takes a few minutes. When the log says `Iron Front server on …`, it's live.

Without the Blueprint, **New → Web Service** works too:
- **Runtime:** Node
- **Build command:** `npm ci --include=dev && npm run build`
- **Start command:** `npm start`
- **Instance type:** Free
- **Health check path:** `/healthz`

### 3. Play and share

Open the `https://….onrender.com` address shown at the top of the service page. Send that link to your friends, host an online game, and give them the 4-letter code. Offline games (hot-seat, CPU) work from the same link.

### Updating

Commit and push your changes (`git add .`, `git commit -m "…"`, `git push`), and Render rebuilds and redeploys by itself. A redeploy restarts the server, which ends games in progress, so push between games.

### Free-tier things to know

- **It sleeps when unused:** after 15 minutes with no visitors. The next visit wakes it in about a minute (the page shows a loading screen). It stays awake while people are playing.
- **Games live in memory:** a sleep, redeploy or restart ends every game in progress, and lobby codes from before stop working. Click **Save** before you stop or push an update, then carry on with **Resume a saved match**.
- **Save key:** `render.yaml` makes Render generate a `SAVE_SECRET` for sealing saves. Check it's listed under your service's **Environment** tab. If it isn't, add it there yourself (any long random text) before saving matches, and don't change it afterwards.
- **Hours:** free services get 750 hours a month, enough for one service running all month.
- **If the game says it can't reach the server:** it was probably waking up. Refresh the page.

## Map editor

Click **Map editor** on the main menu.

- **Camera:** mouse wheel or − / + / Fit to zoom. Scroll with the middle mouse button, **Space + drag**, or the arrow keys or WASD (left-drag is for painting here).
- **Paint:** pick terrain, a building or a unit, then click or drag on the map. Right-click or right-drag erases: it removes a unit, otherwise it paints plains. Tick **Fill area** to flood-fill a connected region of terrain.
- **Owner:** the colored circles set which player a building or unit belongs to. HQs and units need a player; cities and factories can be neutral (grey).
- **Mirror painting:** keeps maps fair by copying every stroke to the other side (left↔right, top↔bottom, 4 corners, or rotated 180°). Buildings and units switch to the matching player's color.
- **Check panel:** tells you if the map is playable (each player needs exactly one HQ, at least 2 players) and warns about players with no factory or units.
- **Saving:** **Save** adds the map to the map list on the setup screen. **Save & play** jumps straight there with the map selected. **Export** and **Import** share maps as `.iron-map.json` files. Built-in maps open as a copy.
- Turn order is set automatically: clockwise around the map from the left edge, and 2-player games use the two HQs farthest apart.
- Unsaved work is kept as a draft and comes back next time you open the editor. Undo (Ctrl+Z) covers painting, resizing and opening maps.

## Unit editor

Click **Unit editor** on the main menu to make your own **unit set**: a named copy of every unit's stats and the damage table. Then pick it under **Units** on the setup screen. **Standard** is the built-in set and can't be changed.

- **Editing:** pick a unit on the left. Its numbers are grouped into Basics (name, badge, cost, movement, vision, move type, capturing), Combat (health, range, cover, camouflage), Supplies (fuel, ammo, resupplying, passengers) and Special (bridge kits, bridge damage, and the Sniper's fixed damage numbers). Each field explains itself.
  - Fields that only make sense for some units (fuel for vehicles, aircraft and ships; passengers for transports) only appear there.
  - Optional fields can be left blank to switch them off; for example, blank ammo means unlimited.
- **Damage:** below the fields, set what the unit deals to every other unit (its row) and takes from every other unit (its column). 0 means it can't attack that unit. For Snipers, these only decide who can be hit; their real damage is in Special.
- **Changes from Standard** are outlined in gold, and changed units get a dot in the list. **Reset unit to Standard** puts one unit (and its damage row and column) back.
- **Checks:** problems such as an empty name, a badge longer than 3 letters, a cost under 500, min range above max range, damage outside 0–200, or a daily fuel burn with no fuel tank are listed in red, and the set can't be saved or exported until they're fixed. Move types can only switch within the same kind (foot↔boot, treads↔tires), so the same building still builds the unit.
- **Saving:** **Save** keeps the set in this browser. **Export** and **Import** share it as an `.iron-units.json` file.
- **Playing:** a game remembers its unit set. Save files and **Continue** bring it back, and the game log's first line names it. CPU players use the set's numbers like everything else, including buying units that a set gives a weapon to.
- **Adding to the form:** fields come from the `FIELDS` list in `src/core/unitSets.ts`. A new unit ability only needs one entry there.

## Computer opponents

On the setup screen, set any player to **CPU · Easy / Medium / Hard**. You can mix humans and CPUs on any team, or set everyone to CPU and watch. On each move, the CPU scores every tile and order (attack, capture, wait) using damage forecasts, capture value, distance to goals, terrain cover and enemy threat ranges. It plays the best one, then buys units at its factories.

| Difficulty | How it plays |
| --- | --- |
| **Easy** | Sloppy, random choices. Ignores danger and counterattacks, never retreats, buys random units. |
| **Medium** | Solid basics with some randomness. Counter-picks units and defends its buildings, but doesn't retreat damaged units. |
| **Hard** | No randomness. Careful with risk, focuses fire to finish units, retreats to repair, saves up for stronger units instead of cheap swarms, and pushes for the HQ once it's ahead. |

**Long games:** from day 30 (day 20 in 3 vs 3), or once a CPU is near the 50-unit cap, it stops holding the line. It sends its army at enemy buildings and its capturers at enemy HQs, accepts much more risk, stops blowing up bridges it might need, and stops pulling damaged units back to repair. "Ahead" is judged team against team. Medium CPUs also press home a clear advantage, like Hard. In CPU-only 3 vs 3 games, most matches now reach a decisive state, but some still run long. Finishing 3 vs 3 matches is on hold for now.

None of the difficulties get extra money or other bonuses. In simulated 1v1 games, each tier beat the one below about 75–80% of the time. To retune them, edit `PROFILES` at the top of `src/core/ai.ts`.

## Code layout

| Path | What it is |
| --- | --- |
| `src/data/units.json` | Unit stats: cost, move, range, capture. Edit to rebalance. |
| `src/data/damage.json` | Damage table: attacker row vs defender column |
| `src/data/terrain.json` | Terrain defense and movement costs |
| `src/data/maps.json` | Maps as full grids, with a terrain grid and an owner grid (see the top of `maps.ts`) |
| `src/core/data.ts` | Loads the JSON above and gives it types |
| `src/core/maps.ts` | Turns a map into a new game |
| `src/ui/saves.ts` | Autosave, save files, and checks that a save file is valid |
| `src/core/rules.ts` | Rules engine: movement, combat, capture, turns. No graphics. |
| `src/core/ai.ts` | Computer opponent: picks the next Action for a CPU player |
| `src/core/unitSets.ts` | Unit sets: switching the live unit data, the editor's field list, and validation |
| `src/ui/unitEditor.ts`, `src/ui/unitSetStore.ts` | Unit editor screen, and saving/exporting unit sets |
| `src/core/state.ts` | Plain-JSON game state + `Action` types |
| `src/data/commanders.json` | Commanders: passives, powers and meter sizes |
| `src/core/commanders.ts` | Applies commander bonuses and power-meter rules |
| `src/core/mapTools.ts` | Map-editing logic: brushes, mirroring, fill, resize, map checks, turn order |
| `src/editor/` | Map editor screen (`editor.ts`) and its drawing canvas (`EditorScene.ts`) |
| `src/ui/mapStore.ts` | Custom maps saved in the browser, plus map file import/export |
| `src/game/camera.ts` | Zoom and scroll camera shared by the game and the editor |
| `src/game/sprites.ts` | Unit art: a code-drawn vector sprite for every unit, in the owner's colour |
| `src/game/cues.ts` | Named moments sounds hook into (`fire` and `impact` with the unit type, `explosion`, `footstep` with the terrain, `drive` with the unit type, `capture-jump` and `capture-hop` (each hop's takeoff and landing), `captured`, and `bridge-built/cracked/repaired/destroyed` with the unit that did it, if seen) |
| `src/game/sound.ts` | Sound engine: makes each sound once when sound starts, plays it on its cue (volume, mute, voice limit); `FIRE_SOUNDS` says which unit makes which sound and `DRIVE_SOUNDS` which engine each vehicle has (loops fade in and out around a move). Every sound plays at the same level (`SFX_LEVEL` in synth.ts) |
| `src/game/music.ts` | Background music: a step sequencer that schedules notes ahead on the audio clock; calm and battle parts (chords, patterns, tempo), the switch on attacks, and the instruments (oscillator pads, bass and plucks, drum hits, a reverb and an echo) |
| `src/game/synth.ts` | Sound recipes: each effect computed sample by sample (the Rifleman's and Engineer's, infantry footsteps, capture hops, and seamless one-second engine loops for vehicles, so far). To give another unit a sound, add a recipe that ends with `finish()`, so it peaks at the same level as every other sound |
| `src/game/attackFx.ts` | Battle effects: muzzle flashes, tracers, shells, rockets, bombs and impacts (one small pool of reused images) |
| `src/core/timing.ts` | How long animations take, and each unit's weapon style; the server paces CPU moves with the same numbers |
| `src/game/render.ts` | Terrain, building and unit drawing shared by the game and the editor |
| `src/game/GameScene.ts` | Phaser rendering and input |
| `src/ui/hud.ts` | HTML side panel, menus, overlays |
| `server/` | Online game server: rooms, join codes, turn checks (Node + WebSockets); `seal.ts` seals saved matches |
| `render.yaml` | How Render builds and starts the server (see **Hosting on Render**) |
| `Start Iron Front.bat`, `scripts/play.mjs` | One-step hosting from your own PC: install, build, start, tunnel (`npm run play`) |
| `src/net/` | Online message format (`protocol.ts`) and the browser connection (`client.ts`) |
| `src/core/view.ts` | What each player may see online under fog |

**Online play:** the server (`server/`) runs the same `rules.ts`. It checks each `Action`, applies it, and sends each player a fog-filtered copy of the new state (`src/core/view.ts`).
