
export type ZoomMeetingSettings = {
  join_before_host: boolean;
  waiting_room: boolean;
  mute_upon_entry: boolean;
  approval_type: number;
  meeting_authentication?: boolean;
  authentication_option?: string;
};


export function buildZoomMeetingSettings(
  authenticationProfileId?: string
): ZoomMeetingSettings {
  const profileId = authenticationProfileId?.trim();

  const settings: ZoomMeetingSettings = {
    join_before_host: false,
    waiting_room: true,
    mute_upon_entry: true,
    approval_type: 2
  };

  if (profileId) {
    settings.approval_type = 0;
    settings.meeting_authentication = true;
    settings.authentication_option = profileId;
  }

  return settings;
}



export function buildVerifiedZoomMeetingSettings(
  authenticationProfileId: string
): ZoomMeetingSettings {
  const profileId = authenticationProfileId?.trim();

  if (!profileId) {
    throw new Error(
      "A Zoom authentication profile ID is required for verified meetings."
    );
  }

  return buildZoomMeetingSettings(profileId);
}


export function buildNewMeetingPayload<
  T extends { settings: ZoomMeetingSettings }
>(
  existingPayload: T,
  authenticationProfileId: string
): T {
  return {
    ...existingPayload,
    settings: buildVerifiedZoomMeetingSettings(authenticationProfileId)
  };
}


export function buildExistingMeetingUpdatePayload<
  T extends { settings: ZoomMeetingSettings }
>(payload: T): Omit<T, "settings"> {
  const { settings: _settings, ...updatePayload } = payload;
  return updatePayload;
}
