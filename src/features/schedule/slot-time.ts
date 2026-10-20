/**
 * A slot boundary's time as the Schedule panel shows its estimated starts: the viewer's local date and time
 * (`Date#toLocaleString`). The owner's resting line (Task 23.9) shows the boundary that returns its gladiator the same way.
 */
export const slotTimeText = (ms: number): string => new Date(ms).toLocaleString();
