#!/usr/bin/env node
"use strict";

/** Test i izoluar: 5 kuponë → Z → kuponi i ri = ditor 1 (pa git, pa ATK). */
function computeNextDailyNumber(state, today) {
  const lastZ = state.last_z ? String(state.last_z).slice(0, 10) : "";
  const lastDaily = state.last_daily ? String(state.last_daily).slice(0, 10) : "";
  const counter = Number(state.counter) || 0;
  let next;

  if (lastZ === today) {
    next = counter + 1;
    if (next < 1) next = 1;
  } else if (lastDaily !== today) {
    next = 1;
  } else {
    next = counter + 1;
    if (next < 1) next = 1;
  }

  return next;
}

function issueCoupon(state, today) {
  const next = computeNextDailyNumber(state, today);
  state.counter = next;
  state.last_daily = today;
  return next;
}

function resetDailyCounter(state, today) {
  state.counter = 0;
  state.last_z = today;
  state.last_daily = today;
}

function runScenario() {
  const today = "2026-09-06";
  const state = { counter: 0, last_z: "", last_daily: "" };

  const issued = [];
  for (let i = 0; i < 5; i += 1) {
    issued.push(issueCoupon(state, today));
  }

  resetDailyCounter(state, today);
  const afterZ = issueCoupon(state, today);

  const ok =
    issued.join(",") === "1,2,3,4,5" &&
    afterZ === 1 &&
    state.last_z === today;

  return {
    ok,
    issued,
    afterZ,
    last_z: state.last_z,
    counter: state.counter,
  };
}

const result = runScenario();
if (result.ok) {
  console.log("PASS: 5 kuponë → Z → kuponi i ri = 1");
  console.log("  kuponët:", result.issued.join(", "));
  console.log("  pas Z:", result.afterZ);
  process.exit(0);
}

console.error("FAIL:", JSON.stringify(result, null, 2));
process.exit(1);
