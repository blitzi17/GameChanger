import {
  getZoomAccessToken,
  type ZoomCredentials
} from "../_shared/zoom-auth.ts";

import {
  addZoomMeetingRegistrant
} from "../zoom/meeting-registrant.ts";

import type {
  StoredZoomRegistrant
} from "../zoom/registrant-record.ts";

import type {
  RegistrationDependencies
} from "./registration-service.ts";

import type {
  SupabaseClient
} from "https://esm.sh/@supabase/supabase-js@2";

export function createRegistrationDependencies(
  admin: SupabaseClient,
  credentials: ZoomCredentials
): RegistrationDependencies {

  return {

    async findRegistrant(registrationId) {
      const { data, error } = await admin
        .from("zoom_registrants")
        .select(
          "registration_id,zoom_meeting_id,zoom_registrant_id,registered_email,zoom_join_url"
        )
        .eq("registration_id", registrationId)
        .maybeSingle();

      if (error) {
        throw new Error("REGISTRANT_LOOKUP_FAILED");
      }

      return data as StoredZoomRegistrant | null;
    },

    async claimRegistration(identity) {
      const { data, error } = await admin.rpc(
        "zoom_claim_registration",
        {
          p_registration_id: identity.registration_id,
          p_zoom_meeting_id: identity.zoom_meeting_id,
          p_email: identity.email
        }
      );

      if (error) {
        throw new Error("REGISTRATION_CLAIM_FAILED");
      }

      if (data !== null && typeof data !== "string") {
        throw new Error("INVALID_CLAIM_RESPONSE");
      }

      return data;
    },

    async createRegistrant(identity) {
      const token = await getZoomAccessToken(
        credentials
      );

      return await addZoomMeetingRegistrant(
        token.accessToken,
        identity.zoom_meeting_id,
        {
          email: identity.email,
          first_name: identity.first_name,
          last_name: identity.last_name
        }
      );
    },

    async completeRegistration(
      registrationId,
      claimToken,
      registrant
    ) {
      const { data, error } = await admin.rpc(
        "zoom_complete_registration",
        {
          p_registration_id: registrationId,
          p_claim_token: claimToken,
          p_registrant_id: registrant.registrant_id,
          p_join_url: registrant.join_url
        }
      );

      if (error) {
        throw new Error("REGISTRATION_COMPLETION_FAILED");
      }

      return data === true;
    },

    async markReview(registrationId, claimToken) {
      const { data, error } = await admin.rpc(
        "zoom_mark_registration_review",
        {
          p_registration_id: registrationId,
          p_claim_token: claimToken
        }
      );

      if (error) {
        throw new Error("REGISTRATION_REVIEW_FAILED");
      }

      return data === true;
    }
  };
}