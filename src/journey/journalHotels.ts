export type HotelSelection = {
  eventId: string;
  evidence: string;
  label: string;
  context: string;
  latitude: number;
  longitude: number;
  providerId: string;
  existingPointId: string | null;
};
export type HotelPreview = {
  token: string;
  hotels: HotelSelection[];
  questions: string[];
};
