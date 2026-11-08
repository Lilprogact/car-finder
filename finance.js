// Finance maths for the estimates on each car card. Pure functions, unit-tested in tests/finance.test.js.
//
// Amount borrowed L = price − deposit. Monthly rate r = (1 + APR)^(1/12) − 1. Term n = months.
// HP monthly  = L × r ÷ (1 − (1 + r)^−n).            HP total      = deposit + n × monthly.
// PCP monthly = (L − B ÷ (1 + r)^n) × r ÷ (1 − (1 + r)^−n), B = final payment.
// PCP total if kept = deposit + n × monthly + B.
// Every figure is an estimate: real figures come from Zuto or the lender, and fees aren't included.

export const ESTIMATE_LABEL = "Estimate: real figures come from Zuto or the lender. Fees aren't included.";

export function monthlyRate(aprPercent) {
  const apr = Number(aprPercent) / 100;
  if (!Number.isFinite(apr) || apr <= 0) return 0;
  return Math.pow(1 + apr, 1 / 12) - 1;
}

export function depositAmount(price, value, type) {
  const p = Number(price) || 0;
  const v = Number(value) || 0;
  const amount = type === "gbp" ? v : p * (v / 100);
  return Math.min(Math.max(amount, 0), p);
}

function annuity(principal, r, n) {
  if (n <= 0) return NaN;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

export function hp(price, deposit, aprPercent, months) {
  const L = Number(price) - Number(deposit);
  const n = Number(months);
  const r = monthlyRate(aprPercent);
  const monthly = annuity(L, r, n);
  return { monthly, total: Number(deposit) + n * monthly, borrowed: L };
}

export function pcp(price, deposit, aprPercent, months, finalPayment) {
  const L = Number(price) - Number(deposit);
  const n = Number(months);
  const B = Number(finalPayment);
  const r = monthlyRate(aprPercent);
  const principal = L - B / Math.pow(1 + r, n);
  const monthly = annuity(principal, r, n);
  return { monthly, finalPayment: B, totalIfKept: Number(deposit) + n * monthly + B, borrowed: L };
}

export function estimates(price, finance) {
  const f = finance || {};
  const deposit = depositAmount(price, f.deposit_value ?? 10, f.deposit_type || "percent");
  const months = Number(f.term_months) || 48;
  const apr = Number(f.apr) || 0;
  const balloon = Number(price) * ((Number(f.balloon_percent) || 0) / 100);
  return {
    deposit,
    months,
    apr,
    hp: hp(price, deposit, apr, months),
    pcp: pcp(price, deposit, apr, months, balloon),
  };
}

export function gbp(value, decimals = 0) {
  if (!Number.isFinite(value)) return "n/a";
  return "£" + value.toLocaleString("en-GB", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
