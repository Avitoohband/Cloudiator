'use client';

// The Clock setting (Patch A, item 7): "Clock" with "12-hour" | "24-hour" as two pressed-state buttons, in the corner chip's account
// menu (desktop and the phone bar). The choice itself belongs to `src/lib/clock-setting.ts`; this only shows and sets it.
import { useId } from 'react';
import type { ClockMode } from '../../lib/clock-setting';
import styles from './shell.module.css';

export function ClockSwitch({ mode, onChange }: { mode: ClockMode; onChange(mode: ClockMode): void }) {
  const labelId = useId();
  return (
    <div className={styles.clockRow} role="group" aria-labelledby={labelId}>
      <span id={labelId}>Clock</span>
      <span className={styles.clockOptions}>
        <button type="button" aria-pressed={mode === '12'} onClick={() => onChange('12')}>12-hour</button>
        <button type="button" aria-pressed={mode === '24'} onClick={() => onChange('24')}>24-hour</button>
      </span>
    </div>
  );
}
