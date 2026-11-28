
export type ZoomRegistrationEligibility = {
  payment_status: string;
  zoom_access_released: boolean;
  registration_id: string;
  registration_session_id: string;
  requested_session_id: string;
  registered_email: string;
  account_status: string;
  role: string;
  session_status: string;
};

export function validateZoomRegistrationEligibility(
  data: ZoomRegistrationEligibility
): void {
  if (
    !data.registration_id?.trim() ||
    !data.registration_session_id?.trim() ||
    !data.requested_session_id?.trim() ||
    data.registration_session_id !== data.requested_session_id
  ) {
    throw new Error("Invalid session registration.");
  }

  if (
    data.role !== "MEMBER" ||
    data.account_status !== "Active"
  ) {
    throw new Error("An active member account is required.");
  }

  if (!data.registered_email?.trim()) {
    throw new Error("Member email is required.");
  }

  if (!["Upcoming", "Live"].includes(data.session_status)) {
    throw new Error("Session is not available.");
  }

  if (
    !["FREE", "PAID", "WAIVED"].includes(data.payment_status) ||
    data.zoom_access_released !== true
  ) {
    throw new Error("Zoom access has not been authorized.");
  }
}
