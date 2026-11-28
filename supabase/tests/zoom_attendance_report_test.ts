/// <reference lib="deno.ns" />
import { buildAttendanceRows } from "../functions/zoom/attendance-report.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function participant(
  email: string | null,
  name: string,
  start: number,
  end: number,
  duration = end - start,
) {
  const base = Date.UTC(2026, 0, 1);
  return {
    user_email: email,
    status: "in_meeting",
    name,
    join_time: new Date(base + start * 1000).toISOString(),
    leave_time: new Date(base + end * 1000).toISOString(),
    duration,
  };
}
Deno.test("attendance: normalize email, merge reconnects despite changed name", () => {
  const rows = buildAttendanceRows([
    participant(" A@EXAMPLE.COM ", "A", 0, 600),
    participant("a@example.com", "Other", 700, 1300),
  ]);
  equal(rows.length, 1);
  equal(rows[0].email, "a@example.com");
  equal(rows[0].seconds, 1200);
});
Deno.test("attendance: same display name, different email stays separate", () => {
  equal(
    buildAttendanceRows([
      participant("a@example.com", "A", 0, 600),
      participant("b@example.com", "A", 0, 600),
    ]).length,
    2,
  );
});
Deno.test("attendance: missing emails never merge by name", () => {
  const rows = buildAttendanceRows([
    participant(null, "A", 0, 600),
    participant("  ", "A", 0, 600),
    participant("a@example.com", "A", 0, 600),
  ]);
  equal(rows.length, 3);
  equal(rows.filter((r) => !r.email).length, 2);
});
Deno.test("attendance: anonymous participant retained for review", () => {
  const rows = buildAttendanceRows([participant(null, "", 0, 60)]);
  equal(rows.length, 1);
  equal(rows[0].email, "");
});
Deno.test("attendance: duplicate report rows cannot double duration", () => {
  const p = participant("a@example.com", "A", 0, 600);
  equal(buildAttendanceRows([p, p])[0].seconds, 600);
});
Deno.test("attendance: overlapping device connections count only once", () => {
  equal(
    buildAttendanceRows([
      participant("a@example.com", "A", 0, 600),
      participant("a@example.com", "A", 300, 900),
    ])[0].seconds,
    900,
  );
});
Deno.test("attendance: duration shorter than span receives conservative credit", () => {
  equal(
    buildAttendanceRows([
      participant("a@example.com", "A", 0, 600, 300),
      participant("a@example.com", "A", 300, 900, 300),
    ])[0].seconds,
    300,
  );
});
Deno.test("attendance: cannot credit more than reported time span", () => {
  equal(
    buildAttendanceRows([participant("a@example.com", "A", 0, 60, 90)])[0]
      .seconds,
    60,
  );
});
Deno.test("attendance: 47m59s is not rounded to 48 minutes", () => {
  const row =
    buildAttendanceRows([participant("a@example.com", "A", 0, 2879)])[0];
  equal(row.seconds, 2879);
  equal(row.minutes, 47);
});
Deno.test("attendance: exact 48 minute threshold preserved", () => {
  const row =
    buildAttendanceRows([participant("a@example.com", "A", 0, 2880)])[0];
  equal(row.seconds, 2880);
  equal(row.minutes, 48);
});
Deno.test("attendance: malformed report rejected instead of partially imported", () => {
  let rejected = false;
  try {
    buildAttendanceRows([
      participant("a@example.com", "A", 0, 60),
      participant("a@example.com", "A", 0, 60, -1),
    ]);
  } catch {
    rejected = true;
  }
  equal(rejected, true);
});
Deno.test("attendance: empty report returns no rows", () => {
  equal(buildAttendanceRows([]), []);
});
// Waiting room attendance regression tests.

Deno.test("WAIT-01: waiting room records excluded", () => {
  const rows = buildAttendanceRows([
    {
      ...participant("a@example.com", "A", 0, 160),
      status: "in_waiting_room",
    },
    participant("a@example.com", "A", 160, 735),
  ]);

  equal(rows.length, 1);
  equal(rows[0].seconds, 575);
});

Deno.test("WAIT-02: waiting room only produces no attendance", () => {
  equal(buildAttendanceRows([
    {
      ...participant("a@example.com", "A", 0, 600),
      status: "in_waiting_room",
    },
  ]), []);
});

Deno.test("WAIT-03: missing participant status rejected", () => {
  let rejected = false;

  try {
    buildAttendanceRows([
      {
        ...participant("a@example.com", "A", 0, 600),
        status: undefined,
      },
    ]);
  } catch {
    rejected = true;
  }

  equal(rejected, true);
});

Deno.test("WAIT-04: unknown participant status rejected", () => {
  let rejected = false;

  try {
    buildAttendanceRows([
      participant("a@example.com", "A", 0, 600),
      {
        ...participant("b@example.com", "B", 0, 600),
        status: "unknown_status",
      },
    ]);
  } catch {
    rejected = true;
  }

  equal(rejected, true);
});

Deno.test("WAIT-05: reconnects exclude waiting room durations", () => {
  const rows = buildAttendanceRows([
    {
      ...participant("a@example.com", "A", 0, 120),
      status: "in_waiting_room",
    },
    participant("a@example.com", "A", 120, 300),
    {
      ...participant("a@example.com", "A", 300, 360),
      status: "in_waiting_room",
    },
    participant("a@example.com", "Changed Name", 360, 600),
  ]);

  equal(rows.length, 1);
  equal(rows[0].seconds, 420);
});

Deno.test("WAIT-06: reproduce actual live meeting durations", () => {
  const rows = buildAttendanceRows([
    {
      ...participant("b@example.com", "B", 29, 192),
      status: "in_waiting_room",
    },
    {
      ...participant("a@example.com", "A", 31, 191),
      status: "in_waiting_room",
    },
    participant("a@example.com", "Different A", 191, 766),
    participant("b@example.com", "Different B", 192, 461),
  ]);

  equal(rows.length, 2);

  equal(
    rows.find(r => r.email === "a@example.com")?.seconds,
    575,
  );

  equal(
    rows.find(r => r.email === "b@example.com")?.seconds,
    269,
  );
});

Deno.test("WAIT-07: never-admitted participant excluded", () => {
  const rows = buildAttendanceRows([
    {
      ...participant("waiting@example.com", "Waiting", 0, 600),
      status: "in_waiting_room",
    },
    participant("admitted@example.com", "Admitted", 0, 480),
  ]);

  equal(rows.length, 1);
  equal(rows[0].email, "admitted@example.com");
  equal(rows[0].seconds, 480);
});
