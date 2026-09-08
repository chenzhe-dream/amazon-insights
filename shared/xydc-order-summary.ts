import type { XydcVariantFamily } from "./xydc-variant-contract";
import type {
  XydcOrderSnapshot,
  XydcOrderSummary,
  XydcOrderWindow,
} from "./xydc-order-contract";

function formatMonth(index: number) {
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function safeSum(values: readonly number[]) {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum)) {
      throw new RangeError("Derived Xiyou order sum is not a safe integer");
    }
  }
  return sum;
}

function sameWindow(left: XydcOrderWindow, right: XydcOrderWindow) {
  return left.startMonth === right.startMonth
    && left.endMonth === right.endMonth
    && left.months.length === right.months.length
    && left.months.every((month, index) => month === right.months[index]);
}

function hasUniqueValues(values: readonly string[]) {
  return new Set(values).size === values.length;
}

export function getXydcOrderWindow(now: Date): XydcOrderWindow {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("A valid date is required for the Xiyou order window");
  }
  const currentMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const months = Array.from({ length: 12 }, (_, index) => formatMonth(currentMonth - 12 + index));
  if (months.some(month => !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) {
    throw new RangeError("Xiyou order window is outside supported ISO calendar years");
  }
  return { startMonth: months[0], endMonth: months[11], months };
}

export function matchesXydcOrderSnapshot(
  snapshot: XydcOrderSnapshot,
  family: XydcVariantFamily,
  window: XydcOrderWindow,
) {
  const snapshotChildren = snapshot.childAsins;
  const familyChildren = family.children.map(child => child.asin);
  if (
    snapshotChildren.length === 0
    || familyChildren.length === 0
    || !hasUniqueValues(snapshotChildren)
    || !hasUniqueValues(familyChildren)
    || snapshotChildren.length !== familyChildren.length
  ) {
    return false;
  }
  const familyChildSet = new Set(familyChildren);
  return snapshot.country === family.country
    && snapshot.parentAsin === family.parentAsin
    && snapshotChildren.every(asin => familyChildSet.has(asin))
    && sameWindow(snapshot.window, window);
}

export function summarizeXydcOrders(snapshot: XydcOrderSnapshot): XydcOrderSummary {
  const expectedChildren = snapshot.childAsins.length;
  const returnedByAsin = new Map(snapshot.children.map(child => [child.asin, child]));
  const rows = snapshot.childAsins.map(asin => {
    const child = returnedByAsin.get(asin);
    const trends = new Map(child?.trends.map(trend => [trend.date, trend.orders]) ?? []);
    const missingMonths = snapshot.window.months.filter(month => !trends.has(month));
    const complete = child !== undefined && child.reasonCode === null && missingMonths.length === 0;
    const disclosedValues = snapshot.window.months.flatMap(month => {
      const orders = trends.get(month);
      return orders === undefined ? [] : [orders];
    });
    return {
      asin,
      complete,
      total: complete ? safeSum(disclosedValues) : null,
      share: null,
      missingMonths,
      undisclosedMonths: disclosedValues.filter(orders => orders === 0).length,
      trends,
    };
  });

  const complete = expectedChildren > 0
    && rows.length === expectedChildren
    && rows.every(row => row.complete);
  const total = complete ? safeSum(rows.map(row => row.total ?? 0)) : null;
  const withShares = rows.map(row => ({
    ...row,
    share: total !== null && total > 0 && row.total !== null && row.total > 0
      ? row.total / total * 100
      : null,
  }));
  withShares.sort((left, right) => {
    if (left.total === null) return right.total === null ? left.asin.localeCompare(right.asin) : 1;
    if (right.total === null) return -1;
    return right.total - left.total || left.asin.localeCompare(right.asin);
  });

  const months = snapshot.window.months.map(date => {
    const values = withShares.map(row => ({ asin: row.asin, orders: row.trends.get(date) ?? null }));
    const monthComplete = values.length === expectedChildren && values.every(value => value.orders !== null);
    return {
      date,
      total: monthComplete ? safeSum(values.map(value => value.orders ?? 0)) : null,
      values,
    };
  });

  return {
    complete,
    total,
    returnedChildren: snapshot.children.length,
    expectedChildren,
    undisclosedChildMonths: rows.reduce((sum, row) => sum + row.undisclosedMonths, 0),
    rows: withShares.map(row => ({
      asin: row.asin,
      complete: row.complete,
      total: row.total,
      share: row.share,
      missingMonths: row.missingMonths,
      undisclosedMonths: row.undisclosedMonths,
    })),
    months,
  };
}
