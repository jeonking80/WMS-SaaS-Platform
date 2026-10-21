const businessTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** A datetime-local field always represents Korea business time, regardless of the browser zone. */
export function businessInputTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(businessTime.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function businessInputTimestamp(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || value.startsWith('0000-')) return undefined;
  const date = new Date(`${value}:00+09:00`);
  if (!Number.isFinite(date.getTime()) || businessInputTime(date.toISOString()) !== value) return undefined;
  return date.toISOString();
}

/** Quick-fill value for a datetime-local field: a Korea business day offset from now at a whole hour. */
export function businessDayAt(offsetDays: number, hour: number, now = new Date()): string {
  const today = businessInputTime(now.toISOString()).slice(0, 10);
  const date = new Date(`${today}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return `${businessInputTime(date.toISOString()).slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
}
