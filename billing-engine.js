// ============================================================================
// ADV MEDIA — AISD BILLING ENGINE
// ============================================================================
// Turns a worked shift into billable hours and dollars, per the ADV Media
// Crew Rate & Break Policy.
//
// IMPORTANT: this is what ADV bills AISD. It is NOT what ADV pays crew.
// Those are separate numbers and must never be shown to the client.
// ============================================================================

// "postMealMin" is the guaranteed hours after a crew member is released for
// a meal. Only the 5-hour-minimum roles have one — stagehands get 3 hours,
// assistants get 5. Every 10-hour-minimum role is null: they bill 10 hours
// regardless of when lunch lands. (Meal PENALTY still applies to them if no
// meal is given by hour 5 — that is a separate rule.)
const RATE_CLASSES = {
  stagehand: {
    label: "Stagehand",
    rate: 40, minHours: 5, otAfter: 8, dtAfter: 12, postMealMin: 3,
    roles: ["Stagehand"],
  },
  spotlight: {
    label: "Spotlight Operator",
    rate: 40, minHours: 10, otAfter: 10, dtAfter: 12, postMealMin: null,
    roles: ["Spotlight Operator"],
  },
  assistant: {
    label: "Assistant",
    rate: 50, minHours: 5, otAfter: 8, dtAfter: 12, postMealMin: 5,
    roles: ["A2", "L2", "V2", "GAV", "General AV"],
  },
  showAssist: {
    label: "Show Assist",
    rate: 55, minHours: 10, otAfter: 10, dtAfter: 12, postMealMin: null,
    roles: ["Show A2", "Show L2", "Show V2"],
  },
  coordinator: {
    label: "Coordinator",
    rate: 55, minHours: 10, otAfter: 10, dtAfter: 12, postMealMin: null,
    roles: ["Coordinator"],
  },
  lead: {
    label: "Lead",
    rate: 60, minHours: 10, otAfter: 10, dtAfter: 12, postMealMin: null,
    roles: ["L1", "A1", "V1", "Engineer", "Stage Manager", "GFX", "PowerPoint", "Teleprompter"],
    // Note: "Director" intentionally lives in the senior class, not here.
  },
  senior: {
    label: "Senior / Management",
    rate: 75, minHours: 10, otAfter: 10, dtAfter: 12, postMealMin: null,
    roles: ["ME", "EIC", "Project Manager", "Producer", "Director"],
  },
};

// Flat role -> class lookup, built from the table above.
const ROLE_TO_CLASS = {};
Object.entries(RATE_CLASSES).forEach(([classId, def]) => {
  def.roles.forEach((r) => { ROLE_TO_CLASS[r.toLowerCase()] = classId; });
});

function classForRole(role) {
  return ROLE_TO_CLASS[String(role || "").toLowerCase()] || null;
}

// ---------------------------------------------------------------------------
// ASSUMPTIONS — flagged for review. Change these if any are wrong.
// ---------------------------------------------------------------------------
// A1. Multipliers do NOT stack. If an hour qualifies for more than one
//     premium (e.g. night differential AND overtime), it bills at the
//     HIGHEST single multiplier, not the product.
//
// A2. Minimum-call guarantee hours bill at STRAIGHT time. A stagehand who
//     works 2 hours bills 5 x 1.0.
//
// A3. Post-meal guarantee applies ONLY to the 5-hour-minimum roles:
//     stagehands 3 hours, assistants 5 hours, measured from when the meal
//     ENDS. Every 10-hour-minimum role bills 10 hours regardless of when
//     lunch happens, so no post-meal floor applies to them.
//
// A4. Meal penalty (no meal by hour 5) bills those hours at 1.5x, and stops
//     once the meal starts.
//
// A5. SCHEDULED overtime is billed even if not worked. When a shift is
//     scheduled long enough to include OT, those hours were already
//     committed to the contractor and can't be clawed back, so the client
//     is billed for them at their OT rate. Unscheduled overtime is
//     billed on hours actually worked. Pass `scheduledHours` to use this.
//
// A6. Scheduled hours that were NOT actually worked cap at time and a half.
//     Booked-but-not-worked time never reaches double time, even if the
//     scheduled shift ran past the 12-hour DT threshold.
// ---------------------------------------------------------------------------

const MULT = { straight: 1, ot: 1.5, dt: 2 };

// Is this clock-hour inside the 12:00am-6:00am night window?
function isNightHour(date) {
  const h = date.getHours();
  return h >= 0 && h < 6;
}

/**
 * Calculate what AISD gets billed for one worked shift.
 *
 * @param {Object} shift
 * @param {string} shift.role             e.g. "A1", "Stagehand"
 * @param {string} shift.clockIn          ISO timestamp
 * @param {string} shift.clockOut         ISO timestamp
 * @param {string} [shift.mealStart]      ISO timestamp, if a meal was given
 * @param {string} [shift.mealEnd]        ISO timestamp
 * @param {number} [shift.scheduledHours] hours the crew member was booked
 *                                        for. If this runs into overtime,
 *                                        the client is billed for it even
 *                                        if the shift ended early.
 * @returns {Object} breakdown
 */
function calculateShiftBilling(shift) {
  const classId = classForRole(shift.role);
  if (!classId) {
    return { error: `No rate class defined for role "${shift.role}".` };
  }
  const def = RATE_CLASSES[classId];

  const start = new Date(shift.clockIn);
  const end = new Date(shift.clockOut);
  if (isNaN(start) || isNaN(end) || end <= start) {
    return { error: "Clock in/out times are missing or out of order." };
  }

  const workedHours = (end - start) / 36e5;
  const scheduledHours = Number(shift.scheduledHours) > 0 ? Number(shift.scheduledHours) : 0;
  const mealStart = shift.mealStart ? new Date(shift.mealStart) : null;
  const mealEnd = shift.mealEnd ? new Date(shift.mealEnd) : null;
  const hadMeal = !!(mealStart && !isNaN(mealStart));

  const mealStartAt = hadMeal ? (mealStart - start) / 36e5 : null;
  const mealEndAt = (mealEnd && !isNaN(mealEnd)) ? (mealEnd - start) / 36e5 : mealStartAt;

  // ---- Step 1: hours eligible for premium rates ----
  // Hours actually worked, plus any scheduled hours the crew member was
  // booked for. Scheduled hours carry their OT/DT multiplier (A5) because
  // that time was already promised to the contractor.
  const premiumHours = Math.max(workedHours, scheduledHours);

  // ---- Step 2: total billed hours, after floors ----
  let billedHours = premiumHours;

  // A3: post-meal guarantee — only for roles that have one.
  if (hadMeal && mealEndAt != null && def.postMealMin) {
    billedHours = Math.max(billedHours, mealEndAt + def.postMealMin);
  }

  // Minimum call.
  billedHours = Math.max(billedHours, def.minHours);

  // ---- Step 3: bucket premium-eligible hours by multiplier ----
  const SLICE = 0.25;
  const buckets = { straight: 0, ot: 0, dt: 0 };
  const premiumCap = Math.min(premiumHours, billedHours);

  for (let t = 0; t < premiumCap - 1e-9; t += SLICE) {
    const sliceLen = Math.min(SLICE, premiumCap - t);
    const at = new Date(start.getTime() + t * 36e5);
    const elapsed = t;

    let mult = MULT.straight;

    if (elapsed >= def.dtAfter) mult = Math.max(mult, MULT.dt);
    else if (elapsed >= def.otAfter) mult = Math.max(mult, MULT.ot);

    if (isNightHour(at)) mult = Math.max(mult, MULT.ot);

    // A4: meal penalty — past hour 5 with no meal yet. Only applies to
    // time actually worked; you can't incur a meal penalty on a shift
    // that already ended.
    const withinWorked = elapsed < workedHours;
    const mealNotYetTaken = !hadMeal || (mealStartAt != null && elapsed < mealStartAt);
    if (withinWorked && elapsed >= 5 && mealNotYetTaken) mult = Math.max(mult, MULT.ot);

    // A6: scheduled hours that were NOT actually worked cap at time and a
    // half. The crew member was owed the booked time, but they didn't work
    // it, so it never reaches double time.
    if (!withinWorked) mult = Math.min(mult, MULT.ot);

    if (mult === MULT.dt) buckets.dt += sliceLen;
    else if (mult === MULT.ot) buckets.ot += sliceLen;
    else buckets.straight += sliceLen;
  }

  // A2: pure minimum-call guarantee bills at straight time.
  const guaranteeHours = Math.max(0, billedHours - premiumCap);
  buckets.straight += guaranteeHours;

  const amount =
    buckets.straight * def.rate * MULT.straight +
    buckets.ot * def.rate * MULT.ot +
    buckets.dt * def.rate * MULT.dt;

  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    role: shift.role,
    rateClass: def.label,
    rate: def.rate,
    workedHours: round2(workedHours),
    scheduledHours: round2(scheduledHours),
    billedHours: round2(billedHours),
    minimumApplied: billedHours > workedHours,
    scheduledOtBilled: scheduledHours > workedHours && scheduledHours > def.otAfter,
    guaranteeHours: round2(guaranteeHours),
    hadMeal,
    straightHours: round2(buckets.straight),
    otHours: round2(buckets.ot),
    dtHours: round2(buckets.dt),
    amount: round2(amount),
  };
}

/** Roll several shifts into one AISD invoice. */
function buildInvoice(shifts, meta) {
  const lines = [];
  const errors = [];
  shifts.forEach((s) => {
    const r = calculateShiftBilling(s);
    if (r.error) errors.push({ shift: s, error: r.error });
    else lines.push({ ...r, personName: s.personName, date: s.clockIn });
  });
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  return {
    ...(meta || {}),
    lines, errors,
    subtotal: Math.round(subtotal * 100) / 100,
    terms: "Net 30",
  };
}

if (typeof module !== "undefined") {
  module.exports = { RATE_CLASSES, ROLE_TO_CLASS, classForRole, calculateShiftBilling, buildInvoice };
}
