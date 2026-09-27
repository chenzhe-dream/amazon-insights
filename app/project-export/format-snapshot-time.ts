/** Export timestamps have an explicit timezone, independent of the viewer's machine. */
export function formatSnapshotTime(value: string | null | undefined): string {
  if (!value) return '未记录';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未记录';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
  }).formatToParts(date);
  const part = (name: string) => parts.find(item => item.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}（北京时间）`;
}
