
export type ZoomRegistrantInput = {
  email: string;
  first_name: string;
  last_name: string;
};

export type ZoomRegistrantResult = {
  registrant_id: string;
  join_url: string;
};

export async function addZoomMeetingRegistrant(
  accessToken: string,
  meetingId: string,
  member: ZoomRegistrantInput
): Promise<ZoomRegistrantResult> {
  if (
    !accessToken.trim() ||
    !meetingId.trim() ||
    !member.email.trim() ||
    !member.first_name.trim() ||
    !member.last_name.trim()
  ) {
    throw new Error("Missing required Zoom registrant information.");
  }

  const response = await fetch(
    `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}/registrants`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: member.email.trim(),
        first_name: member.first_name.trim(),
        last_name: member.last_name.trim()
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Zoom registrant request failed: HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (
    typeof data.registrant_id !== "string" ||
    !data.registrant_id.trim() ||
    typeof data.join_url !== "string" ||
    !data.join_url.trim()
  ) {
    throw new Error("Zoom did not return complete registrant details.");
  }

  return {
    registrant_id: data.registrant_id,
    join_url: data.join_url
  };
}
