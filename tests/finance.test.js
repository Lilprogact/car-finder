import test from "node:test";
import assert from "node:assert/strict";
import { hp, pcp, depositAmount, estimates, monthlyRate } from "../finance.js";

const within = (actual, expected, tolerance = 0.5) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test("HP: £16,990, £1,699 deposit, 48 months, 11.87% APR gives £397.21 a month", () => {
  const result = hp(16990, 1699, 11.87, 48);
  within(result.monthly, 397.21);
  within(result.total, 1699 + 48 * 397.21, 1);
  assert.equal(result.borrowed, 15291);
});

test("PCP: same inputs with a £7,000 final payment gives £281.11 a month", () => {
  const result = pcp(16990, 1699, 11.87, 48, 7000);
  within(result.monthly, 281.11);
  within(result.totalIfKept, 1699 + 48 * 281.11 + 7000, 1);
});

test("monthly rate compounds from the APR", () => {
  within(monthlyRate(12.6825), 0.01, 0.00001);
  assert.equal(monthlyRate(0), 0);
});

test("zero APR splits the loan evenly", () => {
  within(hp(12000, 2000, 0, 50).monthly, 200, 0.001);
});

test("deposit in pounds or percent, never above the price", () => {
  assert.equal(depositAmount(20000, 10, "percent"), 2000);
  assert.equal(depositAmount(20000, 1500, "gbp"), 1500);
  assert.equal(depositAmount(20000, 50000, "gbp"), 20000);
});

test("estimates uses the search's finance settings", () => {
  const e = estimates(16990, { deposit_value: 1699, deposit_type: "gbp", term_months: 48, apr: 11.87, balloon_percent: 41.2 });
  within(e.hp.monthly, 397.21);
  within(e.pcp.finalPayment, 6999.88, 0.01);
});
