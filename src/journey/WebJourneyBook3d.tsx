import type { ComponentProps } from "react";
import { useAtlasView } from "./atlasView";
import { JourneyBook3dReader } from "./JourneyBook3d";
import { useMediaPresentationRecovery } from "./mediaPresentation";

export function JourneyBook3d(props: Omit<ComponentProps<typeof JourneyBook3dReader>, "readMedia" | "recoverPresentation" | "embedded">) {
  const { readMedia } = useAtlasView();
  const recoverPresentation = useMediaPresentationRecovery();
  return <JourneyBook3dReader {...props} readMedia={readMedia} recoverPresentation={recoverPresentation} />;
}
