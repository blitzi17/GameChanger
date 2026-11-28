/** Normalize report rows without using display names as identity. */
export type AttendanceReportRow = {
  email: string;
  name: string;
  join: string;
  leave: string;
  seconds: number;
  minutes: number;
};

type Segment = { start: number; end: number; seconds: number; name: string };

function segment(raw: unknown): { email: string; segment: Segment } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid attendance report participant");
  }
  const p = raw as Record<string, unknown>;
  const start = typeof p.join_time === "string" ? Date.parse(p.join_time) : NaN;
  const end = typeof p.leave_time === "string" ? Date.parse(p.leave_time) : NaN;
  if (
    !Number.isFinite(start) || !Number.isFinite(end) || end < start ||
    typeof p.duration !== "number" || !Number.isSafeInteger(p.duration) ||
    p.duration < 0
  ) {
    throw new Error("Invalid attendance report duration or timestamp");
  }
  if (p.user_email != null && typeof p.user_email !== "string") {
    throw new Error("Invalid attendance report email");
  }
  return {
    email: typeof p.user_email === "string"
      ? p.user_email.trim().toLowerCase()
      : "",
    segment: {
      start,
      end,
      seconds: Math.min(p.duration, Math.floor((end - start) / 1000)),
      name: typeof p.name === "string" ? p.name : "",
    },
  };
}

function summarize(email: string, segments: Segment[]): AttendanceReportRow {
  const sorted = [...segments].sort((a, b) =>
    a.start - b.start || a.end - b.end
  );
  let total = 0;
  let clusterCredit = 0;
  let clusterEnd = -Infinity;
  for (const s of sorted) {
    if (s.start >= clusterEnd) {
      total += clusterCredit;
      clusterCredit = s.seconds;
      clusterEnd = s.end;
    } else {
      // Conservative lower bound: overlap cannot count twice. If a reported
      // duration is shorter than its time span, do not assume where it occurred.
      const overlap = Math.ceil((Math.min(clusterEnd, s.end) - s.start) / 1000);
      clusterCredit = Math.max(
        clusterCredit,
        s.seconds,
        clusterCredit + s.seconds - overlap,
      );
      clusterEnd = Math.max(clusterEnd, s.end);
    }
  }
  const seconds = total + clusterCredit;
  return {
    email,
    name: sorted.find((s) => s.name.trim())?.name ?? "",
    join: new Date(sorted[0].start).toISOString(),
    leave: new Date(
      sorted.reduce((latest, s) => Math.max(latest, s.end), sorted[0].end),
    ).toISOString(),
    seconds,
    minutes: Math.floor(seconds / 60),
  };
}

export function buildAttendanceRows(
  participants: readonly unknown[],
): AttendanceReportRow[] {
  const byEmail = new Map<string, Segment[]>();
  const unmatched: AttendanceReportRow[] = [];
  for (const raw of participants) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("Invalid attendance report participant");
    }

    const status = (raw as Record<string, unknown>).status;

    if (status === "in_waiting_room") continue;

    if (status !== "in_meeting") {
      throw new Error("Invalid attendance report participant status");
    }

    const { email, segment: s } = segment(raw);
    if (!email) {
      unmatched.push(summarize("", [s]));
      continue;
    }
    const group = byEmail.get(email);
    if (group) group.push(s);
    else byEmail.set(email, [s]);
  }
  return [
    ...Array.from(byEmail, ([email, segments]) => summarize(email, segments)),
    ...unmatched,
  ];
}
