export interface AddressSuggestion {
  id: string;
  label: string;
  line1: string;
  city: string;
  region: string;
  postcode: string;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  lat: number;
  lng: number;
}
