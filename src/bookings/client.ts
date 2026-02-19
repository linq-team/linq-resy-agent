/**
 * Resy API Client — standalone version for the bookings agent.
 *
 * Auth: Each user provides a Resy auth token (JWT) during onboarding.
 * The RESY_API_KEY is a public key embedded in Resy's frontend.
 */

import type { ResyVenue, ResyTimeSlot, ResyBookingConfirmation, ResyReservation, ResyCancellationResult } from './types.js';

const RESY_BASE_URL = 'https://api.resy.com';
const RESY_API_KEY = process.env.RESY_API_KEY || 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5';

// Default geo: NYC
const DEFAULT_LAT = 40.7128;
const DEFAULT_LNG = -73.9876;

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
}

async function resyFetch(authToken: string, path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'authorization': `ResyAPI api_key="${RESY_API_KEY}"`,
    'x-resy-auth-token': authToken,
    'x-resy-universal-auth': authToken,
    'origin': 'https://resy.com',
    'referer': 'https://resy.com/',
    'accept': 'application/json, text/plain, */*',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ...(options.headers as Record<string, string> || {}),
  };

  if (!headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  const res = await fetch(`${RESY_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resy API ${res.status}: ${body}`);
  }

  return res;
}

/**
 * Search for restaurants on Resy.
 */
export async function searchRestaurants(
  authToken: string,
  query: string,
  geo?: { lat: number; lng: number }
): Promise<ResyVenue[]> {
  const lat = geo?.lat ?? DEFAULT_LAT;
  const lng = geo?.lng ?? DEFAULT_LNG;

  console.log(`[resy] Searching for "${query}" near (${lat}, ${lng})`);

  const res = await resyFetch(authToken, '/3/venuesearch/search', {
    method: 'POST',
    body: JSON.stringify({
      geo: { latitude: lat, longitude: lng },
      query,
      types: ['venue'],
    }),
  });

  const data = await res.json() as {
    search: {
      hits: Array<{
        id: { resy: number };
        name: string;
        location: { locality: string; region: string; neighborhood?: string };
        cuisine: string[];
        price_range: number;
        rating?: number;
        url_slug: string;
      }>;
    };
  };

  const hits = data.search?.hits || [];
  console.log(`[resy] Found ${hits.length} venues`);

  return hits.map(hit => {
    const citySlug = (hit.location.locality || 'new-york').toLowerCase().replace(/\s+/g, '-');
    return {
      venue_id: hit.id.resy,
      name: hit.name,
      location: {
        city: hit.location.locality,
        state: hit.location.region,
        neighborhood: hit.location.neighborhood,
      },
      cuisine: hit.cuisine || [],
      price_range: hit.price_range,
      rating: hit.rating,
      url_slug: hit.url_slug,
      url: `https://resy.com/cities/${citySlug}/${hit.url_slug}`,
    };
  });
}

/**
 * Find available time slots for a venue on a given day.
 */
export async function findSlots(
  authToken: string,
  venueId: number,
  day: string,      // YYYY-MM-DD
  partySize: number,
  geo?: { lat: number; lng: number }
): Promise<ResyTimeSlot[]> {
  const lat = geo?.lat ?? DEFAULT_LAT;
  const lng = geo?.lng ?? DEFAULT_LNG;

  console.log(`[resy] Finding slots for venue ${venueId} on ${day}, party of ${partySize}`);

  const params = new URLSearchParams({
    lat: lat.toString(),
    long: lng.toString(),
    day,
    party_size: partySize.toString(),
    venue_id: venueId.toString(),
  });

  const res = await resyFetch(authToken, `/4/find?${params}`, { method: 'GET' });
  const data = await res.json() as {
    results: {
      venues: Array<{
        slots: Array<{
          config: { token: string; type: string };
          date: { start: string; end: string };
        }>;
      }>;
    };
  };

  const venue = data.results?.venues?.[0];
  const slots = venue?.slots || [];
  console.log(`[resy] Found ${slots.length} available slots`);

  return slots.map(slot => {
    const startDate = new Date(slot.date.start);
    const hours = startDate.getHours().toString().padStart(2, '0');
    const minutes = startDate.getMinutes().toString().padStart(2, '0');

    return {
      config_token: slot.config.token,
      date: day,
      time: `${hours}:${minutes}`,
      party_size: partySize,
      type: slot.config.type || 'Dining Room',
    };
  });
}

/**
 * Book a reservation. Composite: find fresh slot → details → user → book.
 *
 * Takes venue_id + desired time instead of a config_token, because config tokens
 * expire within minutes. We re-fetch a fresh slot at booking time to avoid stale tokens.
 */
export async function bookReservation(
  authToken: string,
  venueId: number,
  day: string,
  partySize: number,
  desiredTime?: string, // HH:MM — picks closest slot if provided
  geo?: { lat: number; lng: number }
): Promise<ResyBookingConfirmation> {
  console.log(`[resy] Booking: venue ${venueId}, ${day}, party of ${partySize}, desired time: ${desiredTime || 'any'}`);

  // Step 0: Get a fresh config token by searching for current slots
  const freshSlots = await findSlots(authToken, venueId, day, partySize, geo);
  if (freshSlots.length === 0) {
    throw new Error('No available slots for this venue/date/party size. The restaurant may be fully booked.');
  }

  // Pick the best matching slot
  let configToken: string;
  if (desiredTime) {
    // Find the closest time match
    const match = freshSlots.find(s => s.time === desiredTime)
      || freshSlots.reduce((best, slot) => {
          const bestDiff = Math.abs(timeToMinutes(best.time) - timeToMinutes(desiredTime));
          const slotDiff = Math.abs(timeToMinutes(slot.time) - timeToMinutes(desiredTime));
          return slotDiff < bestDiff ? slot : best;
        });
    configToken = match.config_token;
    console.log(`[resy] Matched slot at ${match.time} (requested ${desiredTime})`);
  } else {
    configToken = freshSlots[0].config_token;
    console.log(`[resy] Using first available slot at ${freshSlots[0].time}`);
  }

  // Step 1: Get booking details (book_token)
  const detailsParams = new URLSearchParams({
    config_id: configToken,
    day,
    party_size: partySize.toString(),
  });
  const detailsRes = await resyFetch(authToken, `/3/details?${detailsParams}`, { method: 'GET' });
  const detailsData = await detailsRes.json() as {
    book_token: { value: string; date_expires: string };
    venue: { name: string };
    config: { type: string };
  };

  const bookToken = detailsData.book_token.value;
  const venueName = detailsData.venue?.name || 'Restaurant';
  const slotType = detailsData.config?.type || 'Dining Room';
  console.log(`[resy] Got book_token for ${venueName}`);

  // Step 2: Get user payment method
  const userRes = await resyFetch(authToken, '/2/user', { method: 'GET' });
  const userData = await userRes.json() as {
    payment_methods: Array<{ id: number; is_default: boolean }>;
  };

  const paymentMethod = userData.payment_methods?.find(pm => pm.is_default) || userData.payment_methods?.[0];
  if (!paymentMethod) {
    throw new Error('No payment method on file. Add one at resy.com/account before booking.');
  }
  console.log(`[resy] Using payment method ${paymentMethod.id}`);

  // Step 3: Book the reservation (form-encoded)
  const bookBody = new URLSearchParams({
    book_token: bookToken,
    struct_payment_method: JSON.stringify({ id: paymentMethod.id }),
    source_id: 'resy.com-venue-details',
  });

  const bookRes = await resyFetch(authToken, '/3/book', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: bookBody.toString(),
  });

  const bookData = await bookRes.json() as {
    resy_token: string;
    reservation_id: number;
    date: string;
    time_slot: string;
    num_seats: number;
  };

  console.log(`[resy] Booked! resy_token=${bookData.resy_token}, reservation_id=${bookData.reservation_id}`);

  return {
    resy_token: bookData.resy_token,
    reservation_id: bookData.reservation_id,
    venue_name: venueName,
    date: day,
    time: bookData.time_slot || day,
    party_size: bookData.num_seats || partySize,
    type: slotType,
  };
}

/**
 * List the user's upcoming reservations.
 */
export async function getReservations(authToken: string): Promise<ResyReservation[]> {
  console.log('[resy] Fetching user reservations');

  const res = await resyFetch(authToken, '/3/user/reservations', { method: 'GET' });
  const data = await res.json() as Record<string, unknown>;

  const reservations = (data.reservations || data.upcoming || data.results || []) as Array<Record<string, any>>;
  console.log(`[resy] Found ${reservations.length} reservations`);

  return reservations.map((r: Record<string, any>) => ({
    resy_token: r.resy_token || r.token || '',
    reservation_id: r.reservation_id || r.id || 0,
    venue_name: r.venue?.name || r.venue_name || r.name || 'Unknown',
    date: r.date || r.day || r.reservation_date || '',
    time: r.time_slot || r.time || r.start_time || '',
    party_size: r.num_seats || r.party_size || r.seats || 0,
    type: r.config?.type || r.type || 'Dining Room',
  }));
}

/**
 * Cancel a reservation by resy_token (rr://... format).
 */
export async function cancelReservation(authToken: string, resyToken: string): Promise<ResyCancellationResult> {
  console.log(`[resy] Cancelling reservation: ${resyToken}`);

  try {
    const body = new URLSearchParams({ resy_token: resyToken });

    await resyFetch(authToken, '/3/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    console.log(`[resy] Cancelled successfully`);
    return { success: true, resy_token: resyToken };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[resy] Cancel error:`, error);
    return { success: false, resy_token: resyToken, error: msg };
  }
}
