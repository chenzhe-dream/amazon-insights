'use client';

import {useId, useRef} from 'react';
import DatePicker from 'react-datepicker';
import {zhCN} from 'date-fns/locale/zh-CN';

function monthDate(value: string): Date | undefined {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)) return undefined;
  return new Date(Number(value.slice(0, 4)), Number(value.slice(5)) - 1, 1);
}

/** UI dates are local calendar months; the API continues to receive YYYY-MM. */
export function MarketShapeMonthPicker({label, value, max, disabled, onChange}: {
  label: string; value: string; max: string; disabled?: boolean; onChange: (month: string) => void;
}) {
  const id = useId();
  const picker = useRef<DatePicker>(null);
  const clearValidity = () => {
    const input = picker.current?.input;
    if (input instanceof HTMLInputElement) input.setCustomValidity('');
  };
  const maxDate = monthDate(max);
  const lastYear = maxDate?.getFullYear() ?? new Date().getFullYear();
  return <div className="shape-month-field">
    <label htmlFor={id}>{label}</label>
    <DatePicker
      ref={picker}
      id={id}
      selected={monthDate(value) ?? null}
      onChange={(date: Date | null) => {
        clearValidity();
        onChange(date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : '');
      }}
      onChangeRaw={event => {
        const input = event?.target;
        if (!(input instanceof HTMLInputElement)) return;
        const raw = input.value;
        input.setCustomValidity(raw && (!monthDate(raw) || raw > max) ? `请输入不晚于 ${max} 的有效月份（YYYY-MM）` : '');
      }}
      onCalendarClose={clearValidity}
      dateFormat="yyyy-MM"
      placeholderText="年-月"
      locale={zhCN}
      showMonthYearPicker
      showFullMonthYearPicker
      onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); picker.current?.setOpen(true); }
      }}
      preventOpenOnFocus
      strictParsing
      required
      disabled={disabled}
      maxDate={maxDate}
      calendarClassName="shape-month-calendar"
      popperClassName="shape-month-popper"
      popperPlacement="bottom-start"
      showPopperArrow={false}
      chooseDayAriaLabelPrefix="选择"
      disabledDayAriaLabelPrefix="不可选"
      renderCustomHeader={({date, changeYear, decreaseYear, increaseYear}) => <div className="shape-month-header">
        <button type="button" aria-label="上一年" onClick={decreaseYear} disabled={date.getFullYear() <= 2000}>‹</button>
        <select aria-label="选择年份" value={date.getFullYear()} onChange={event => changeYear(Number(event.target.value))}>
          {Array.from({length: lastYear - 1999}, (_, index) => lastYear - index).map(year => <option key={year} value={year}>{year}年</option>)}
        </select>
        <button type="button" aria-label="下一年" onClick={increaseYear} disabled={date.getFullYear() >= lastYear}>›</button>
      </div>}
    />
  </div>;
}
