import type { TractorProfile } from "./types";

export function upsertSavedTractorProfile(profiles: TractorProfile[], savedProfile: TractorProfile) {
  const existingIndex = profiles.findIndex((profile) => profile.id === savedProfile.id);
  if (existingIndex === -1) {
    return [...profiles, savedProfile];
  }

  return profiles.map((profile) => profile.id === savedProfile.id ? savedProfile : profile);
}

export function removeSavedTractorProfile(profiles: TractorProfile[], profileId: number) {
  return profiles.filter((profile) => profile.id !== profileId);
}
