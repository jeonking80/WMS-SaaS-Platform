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
