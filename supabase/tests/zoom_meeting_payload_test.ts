
/// <reference lib="deno.ns" />

import {
  buildZoomMeetingSettings,
  buildVerifiedZoomMeetingSettings,
  buildNewMeetingPayload,
  buildExistingMeetingUpdatePayload
} from "../functions/zoom/meeting-payload.ts";

Deno.test("New verified Zoom meetings require registration and authentication", () => {
  const settings = buildZoomMeetingSettings("mock-profile-id");

  if (settings.approval_type !== 0) {
    throw new Error("Zoom registration must be required.");
  }

  if (settings.meeting_authentication !== true) {
    throw new Error("Zoom authentication must be enabled.");
  }

  if (settings.authentication_option !== "mock-profile-id") {
    throw new Error("Incorrect Zoom authentication profile.");
  }
});


Deno.test("Existing Zoom meeting settings remain unchanged", () => {
  const settings = buildZoomMeetingSettings();

  if (settings.approval_type !== 2) {
    throw new Error("Legacy meeting registration setting changed.");
  }

  if (settings.meeting_authentication !== undefined) {
    throw new Error("Legacy meeting authentication was modified.");
  }

  if (settings.authentication_option !== undefined) {
    throw new Error("Legacy authentication profile was modified.");
  }

  if (
    settings.join_before_host !== false ||
    settings.waiting_room !== true ||
    settings.mute_upon_entry !== true
  ) {
    throw new Error("Existing Zoom security settings changed.");
  }
});


Deno.test("Empty authentication profile IDs must not enable verified meetings", () => {
  const settings = buildZoomMeetingSettings("");

  if (
    settings.meeting_authentication === true ||
    settings.authentication_option === ""
  ) {
    throw new Error("An empty profile ID must not enable authentication.");
  }
});


Deno.test("Verified Zoom meetings reject missing or blank profile IDs", () => {
  for (const profileId of ["", "   "]) {
    let rejected = false;

    try {
      buildVerifiedZoomMeetingSettings(profileId);
    } catch {
      rejected = true;
    }

    if (!rejected) {
      throw new Error(
        "Verified meetings must reject missing authentication profile IDs."
      );
    }
  }

  const settings = buildVerifiedZoomMeetingSettings("  mock-profile-id  ");

  if (
    settings.approval_type !== 0 ||
    settings.meeting_authentication !== true ||
    settings.authentication_option !== "mock-profile-id"
  ) {
    throw new Error("Valid authentication profile was not applied correctly.");
  }
});


Deno.test("New meeting payload requires verification without changing the original", () => {
  const originalPayload = {
    topic: "GameChanger Test Session",
    type: 2,
    settings: buildZoomMeetingSettings()
  };

  const newPayload = buildNewMeetingPayload(
    originalPayload,
    "mock-profile-id"
  );

  // New meeting must require registration and authentication.
  if (
    newPayload.settings.approval_type !== 0 ||
    newPayload.settings.meeting_authentication !== true ||
    newPayload.settings.authentication_option !== "mock-profile-id"
  ) {
    throw new Error("New meeting verification settings are incorrect.");
  }

  // Original payload must remain unchanged.
  if (
    originalPayload.settings.approval_type !== 2 ||
    originalPayload.settings.meeting_authentication !== undefined
  ) {
    throw new Error("Original meeting payload was modified.");
  }

  if (newPayload === originalPayload) {
    throw new Error("Expected a separate payload object.");
  }

  // Missing profile IDs must be rejected.
  for (const profileId of ["", "   "]) {
    let rejected = false;

    try {
      buildNewMeetingPayload(originalPayload, profileId);
    } catch {
      rejected = true;
    }

    if (!rejected) {
      throw new Error("Missing profile ID was not rejected.");
    }
  }
});


Deno.test("Existing meeting updates preserve Zoom security settings", () => {
  const originalPayload = {
    topic: "Updated GameChanger Session",
    type: 2,
    duration: 60,
    settings: buildZoomMeetingSettings("existing-profile-id")
  };

  const updatePayload = buildExistingMeetingUpdatePayload(originalPayload);

  if ("settings" in updatePayload) {
    throw new Error("PATCH payload must not contain Zoom security settings.");
  }

  if (
    updatePayload.topic !== originalPayload.topic ||
    updatePayload.duration !== originalPayload.duration
  ) {
    throw new Error("PATCH payload lost meeting details.");
  }

  if (
    originalPayload.settings.authentication_option !== "existing-profile-id"
  ) {
    throw new Error("Original meeting settings were modified.");
  }
});


Deno.test("Whitespace-only authentication profiles remain disabled", () => {
  const settings = buildZoomMeetingSettings("   ");

  if (
    settings.approval_type !== 2 ||
    settings.meeting_authentication !== undefined ||
    settings.authentication_option !== undefined
  ) {
    throw new Error(
      "Whitespace-only authentication profile was accepted."
    );
  }
});
