export interface ResyVenue {
  venue_id: number;
  name: string;
  location: {
    city: string;
    state: string;
    neighborhood?: string;
  };
  cuisine: string[];
  price_range: number; // 1-4
  rating?: number;
  url_slug: string;
  url: string;         // e.g., https://resy.com/cities/new-york/carbone-new-york
}

export interface ResyTimeSlot {
  config_token: string;
  date: string;        // YYYY-MM-DD
  time: string;        // HH:MM (24h)
  party_size: number;
  type: string;        // e.g., "Dining Room", "Bar", "Patio"
}

export interface ResyBookingConfirmation {
  resy_token: string;  // rr://... format — needed for cancellation
  reservation_id: number;
  venue_name: string;
  venue_url: string;   // e.g., https://resy.com/cities/new-york-ny/carbone
  date: string;
  time: string;
  party_size: number;
  type: string;
}

export interface ResyReservation {
  resy_token: string;
  reservation_id: number;
  venue_name: string;
  date: string;
  time: string;
  party_size: number;
  type: string;
}

export interface ResyCancellationResult {
  success: boolean;
  resy_token: string;
  error?: string;
}
