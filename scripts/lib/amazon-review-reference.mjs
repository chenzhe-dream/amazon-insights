/** A review date is a calendar date, never a local-midnight timestamp. */
export function parseReviewCalendarDate(value) {
  const match = String(value).match(/^Reviewed in .+ on ([A-Za-z]+) (\d{1,2}), (\d{4})$/);
  if (!match) return null;
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const month=months.indexOf(match[1]), day=Number(match[2]), year=Number(match[3]);
  if (month < 0 || day < 1 || year < 1900) return null;
  const result=new Date(Date.UTC(year,month,day)).toISOString().slice(0,10);
  return result === `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}` ? result : null;
}
