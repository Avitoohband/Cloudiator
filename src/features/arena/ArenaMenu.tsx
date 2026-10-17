'use client';

// The "Arena" menu: the bouts in the camp's sparring rings now (the keyboard and touch equivalent of clicking a fighting
// pair, from the bridge's `arena-fights` event), the Arena card, and the league standings. The card section stays
// mounted while the menu is closed, so a click on an Arena entrant in the camp (`open-arena`) opens its card as before;
// the standings mount, and read, only while the menu is open.
import type { OwnerState, WorldSnapshot } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { ArenaFightSummary, SceneBridge } from '../../game/bridge';
import type { DisplayClock } from '../../game/display-clock';
import { arenaFightButton } from '../../game/arena-layout';
import { ArenaPanel, type ArenaSample } from './ArenaPanel';
import { StandingsPanel } from './StandingsPanel';
import styles from './ArenaPanel.module.css';

export function ArenaMenu({ open, bridge, reads, owner, world, clock, fixture, samples, fights, sceneUnavailable, revision }: {
  open: boolean;
  bridge: SceneBridge;
  reads: GameGateway | null;
  owner: OwnerState | null;
  world: WorldSnapshot | null;
  clock: DisplayClock;
  fixture: boolean;
  samples: readonly ArenaSample[];
  /** The scene's last `arena-fights` event: the revealed bouts in the rings now. */
  fights: readonly ArenaFightSummary[];
  sceneUnavailable: boolean;
  revision: string | null;
}) {
  return <>
    {open && !sceneUnavailable && fights.length > 0 && (
      <div className={styles.rings}>
        <p className="eyebrow">IN THE RINGS NOW</p>
        <div className={styles.fights} role="group" aria-label="Arena bouts in the rings">
          {fights.map(fight => {
            const { label, entrant } = arenaFightButton(fight);
            return (
              <button key={fight.battleId} type="button" onClick={() => {
                if (entrant.gladiatorId) bridge.emit('find-character', { gladiatorId: entrant.gladiatorId });
                bridge.emit('open-arena', { activityId: entrant.activityId, gladiatorId: entrant.gladiatorId });
              }}>{label}</button>
            );
          })}
        </div>
      </div>
    )}
    {/* Live mode reads Arena timelines and opponent profiles through the live gateway (Tasks 10/16); without an owner
        it is a spectator's: cards opened from the camp, with public stages and results only. */}
    <ArenaPanel bridge={bridge} reads={reads} owner={owner} world={world} clock={clock} fixture={fixture} samples={samples} />
    {/* Live mode reads the paginated league standings through the live gateway (Task 16). */}
    {open && <StandingsPanel key={owner?.gladiatorId ?? 'none'} reads={reads} owner={owner} clock={clock} revision={revision} />}
  </>;
}
