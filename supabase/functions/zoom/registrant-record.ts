
export type StoredZoomRegistrant = {
  registration_id: string;
  zoom_meeting_id: string;
  zoom_registrant_id: string;
  registered_email: string;
  zoom_join_url: string;
};

export type ZoomRegistrantIdentity = {
  registration_id: string;
  zoom_meeting_id: string;
  email: string;
};

export function reusableZoomRegistrantLink(
  record: StoredZoomRegistrant | null,
  identity: ZoomRegistrantIdentity
): string | null {
  if (!record) return null;

  if (
    !identity.registration_id.trim() ||
    !identity.zoom_meeting_id.trim() ||
    !identity.email.trim()
  ) {
    return null;
  }

  if (
    record.registration_id !== identity.registration_id ||
    record.zoom_meeting_id !== identity.zoom_meeting_id ||
    record.registered_email.trim().toLowerCase() !==
      identity.email.trim().toLowerCase() ||
    !record.zoom_registrant_id.trim()
  ) {
    return null;
  }

  try {
    const url = new URL(record.zoom_join_url);


if (
  url.protocol !== "https:" ||
  url.username !== "" ||
  url.password !== "" ||
  (!/^(zoom\.us|us[0-9]+web\.zoom\.us)$/i.test(url.hostname) || !!url.port)
) {
  return null;
}


    return record.zoom_join_url;
  } catch {
    return null;
  }
}
