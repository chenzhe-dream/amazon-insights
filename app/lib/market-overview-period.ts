/** A report opened from a monthly result needs multiple completed months to show a trend. */
export function overviewReportStartMonth(selectedMonth:string,configuredFromMonth:string){
 const [year,month]=selectedMonth.split('-').map(Number);
 if(!Number.isInteger(year)||!Number.isInteger(month)||month<1||month>12)throw new TypeError('Invalid selected month');
 if(configuredFromMonth<selectedMonth)return configuredFromMonth;
 const first=new Date(Date.UTC(year,month-3,1));
 return `${first.getUTCFullYear()}-${String(first.getUTCMonth()+1).padStart(2,'0')}`;
}
