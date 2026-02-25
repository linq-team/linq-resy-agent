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
  const method = (options.method || 'GET').toUpperCase();
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

  // Only set content-type on requests with a body
  if (method !== 'GET' && method !== 'HEAD' && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  const res = await fetch(`${RESY_BASE_URL}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text();

    // Detect expired/invalid auth token — Resy returns 419 or sometimes 500 on bad tokens
    if (res.status === 419 || (res.status === 500 && /unauthorized|auth|token/i.test(body))) {
      throw new ResyAuthError(`Your Resy session has expired. Text "sign out" then reconnect your account to refresh it.`);
    }

    throw new Error(`Resy API ${res.status}: ${body}`);
  }

  return res;
}

/** Thrown when the user's Resy auth token is expired or invalid. */
export class ResyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResyAuthError';
  }
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
    venue: { name: string; venue_url_slug?: string; location?: { url_slug?: string } };
    config: { type: string };
  };

  const bookToken = detailsData.book_token.value;
  const venueName = detailsData.venue?.name || 'Restaurant';
  const slotType = detailsData.config?.type || 'Dining Room';
  const citySlug = detailsData.venue?.location?.url_slug || 'new-york-ny';
  const venueSlug = detailsData.venue?.venue_url_slug || '';
  const venueUrl = venueSlug
    ? `https://resy.com/cities/${citySlug}/${venueSlug}`
    : `https://resy.com`;
  console.log(`[resy] Got book_token for ${venueName} (${venueUrl})`);

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
    venue_url: venueUrl,
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
 * Get the authenticated user's Resy profile.
 */
export async function getResyProfile(authToken: string): Promise<Record<string, unknown>> {
  console.log('[resy] Fetching user profile');

  const res = await resyFetch(authToken, '/2/user', { method: 'GET' });
  const data = await res.json() as Record<string, unknown>;

  // Return a clean subset — don't leak payment IDs etc. to Claude
  return {
    first_name: data.first_name,
    last_name: data.last_name,
    email: data.em_address,
    phone: data.mobile_number,
    num_bookings: data.num_bookings,
    member_since: data.date_created,
    is_resy_select: data.resy_select,
    profile_image_url: data.profile_image_url,
  };
}

/**
 * Cancel a reservation by resy_token (rr://... format).
 */
// ── SMS OTP Authentication ────────────────────────────────────────────────

const RESY_PRE_AUTH_HEADERS = {
  'authorization': `ResyAPI api_key="${RESY_API_KEY}"`,
  'content-type': 'application/x-www-form-urlencoded',
  'origin': 'https://resy.com',
  'referer': 'https://resy.com/',
  'accept': 'application/json, text/plain, */*',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

/**
 * Send a Resy OTP code via SMS to the given phone number.
 * Returns 'sms' on success, 'rate_limited' if throttled, false on other failures.
 */
export async function sendResyOTP(mobileNumber: string): Promise<'sms' | 'rate_limited' | false> {
  console.log(`[resy] Sending OTP to ${mobileNumber}`);

  const smsRes = await fetch(`${RESY_BASE_URL}/3/auth/mobile`, {
    method: 'POST',
    headers: RESY_PRE_AUTH_HEADERS,
    body: new URLSearchParams({ mobile_number: mobileNumber, method: 'sms' }).toString(),
  });

  if (smsRes.ok) {
    const data = await smsRes.json() as { sent?: boolean };
    if (data.sent) {
      console.log(`[resy] OTP sent via SMS`);
      return 'sms';
    }
  }

  if (smsRes.status === 429) {
    console.log(`[resy] SMS rate limited (429) for ${mobileNumber}`);
    return 'rate_limited';
  }

  const body = await smsRes.text();
  console.error(`[resy] OTP send failed (${smsRes.status}): ${body}`);
  return false;
}

/**
 * Resy OTP challenge data returned after successful code verification.
 */
export interface ResyChallenge {
  claimToken: string;
  challengeId: string;
  mobileNumber: string;
  firstName: string;
  isNewUser: boolean;
  requiredFields: Array<{ name: string; type: string; message: string }>;
}

/**
 * Verify a Resy OTP code.
 *
 * Step 1 of the mobile auth flow: POST /3/auth/mobile with mobile_number + code.
 * Returns either an auth token directly (rare) or challenge data requiring
 * the user to provide their email address.
 */
export async function verifyResyOTP(mobileNumber: string, code: string): Promise<{ token: string } | { challenge: ResyChallenge } | { error: 'server' } | null> {
  console.log(`[resy] Verifying OTP for ${mobileNumber}`);

  const authHeaders = {
    'authorization': `ResyAPI api_key="${RESY_API_KEY}"`,
    'content-type': 'application/x-www-form-urlencoded',
    'origin': 'https://resy.com',
    'referer': 'https://resy.com/',
    'accept': 'application/json, text/plain, */*',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };

  const verifyRes = await fetch(`${RESY_BASE_URL}/3/auth/mobile`, {
    method: 'POST',
    headers: authHeaders,
    body: new URLSearchParams({ mobile_number: mobileNumber, code }).toString(),
  });

  if (!verifyRes.ok) {
    const body = await verifyRes.text();
    console.error(`[resy] OTP verify failed (${verifyRes.status}): ${body}`);
    if (verifyRes.status >= 500) {
      return { error: 'server' as const };
    }
    return null;
  }

  const verifyData = await verifyRes.json() as Record<string, any>;
  console.log(`[resy] OTP verify response:`, JSON.stringify(verifyData, null, 2));

  // Some accounts may return a token directly (check multiple locations)
  const directToken = verifyData.token || verifyData.auth_token || verifyData.access_token;
  if (directToken) {
    console.log(`[resy] OTP verified — got auth token directly`);
    return { token: directToken };
  }

  // Otherwise, return the challenge data for the caller to handle
  const claimToken = verifyData.mobile_claim?.claim_token;
  const challengeId = verifyData.challenge?.challenge_id;

  if (!claimToken) {
    console.error(`[resy] OTP verify returned unexpected response (no claim_token)`);
    return null;
  }

  // No challenge — account may exist but Resy skipped verification.
  // Try to exchange claim token directly via multiple endpoints.
  if (!challengeId) {
    console.log(`[resy] OTP accepted — no challenge, trying claim token exchange`);

    const exchangeEndpoints = [
      '/3/auth/mobile/claim',
      '/3/auth/claim',
    ];

    for (const endpoint of exchangeEndpoints) {
      console.log(`[resy] Trying ${endpoint}`);
      try {
        const res = await fetch(`${RESY_BASE_URL}${endpoint}`, {
          method: 'POST',
          headers: RESY_PRE_AUTH_HEADERS,
          body: new URLSearchParams({
            mobile_number: mobileNumber,
            claim_token: claimToken,
          }).toString(),
        });
        const body = await res.text();
        console.log(`[resy] ${endpoint} (${res.status}):`, body.substring(0, 1000));

        if (res.ok) {
          try {
            const data = JSON.parse(body) as Record<string, any>;
            const token = data.token || data.auth_token || data.access_token;
            if (token) {
              console.log(`[resy] Got auth token via ${endpoint}!`);
              return { token };
            }
          } catch { /* not JSON */ }
        }
      } catch (err) {
        console.error(`[resy] ${endpoint} error:`, err);
      }
    }

    // Exchange failed — ask for email to try challenge route
    console.log(`[resy] Claim exchange failed — asking for email`);
    return {
      challenge: {
        claimToken,
        challengeId: '',
        mobileNumber,
        firstName: '',
        isNewUser: true,
        requiredFields: [
          { name: 'em_address', type: 'email', message: 'Email address' },
        ],
      },
    };
  }

  console.log(`[resy] OTP code accepted — challenge requires additional verification`);
  return {
    challenge: {
      claimToken,
      challengeId,
      mobileNumber,
      firstName: verifyData.challenge?.first_name || '',
      isNewUser: false,
      requiredFields: verifyData.challenge?.properties || [],
    },
  };
}

/**
 * Complete a Resy mobile auth challenge (existing user — has challenge_id).
 */
export async function completeResyChallenge(
  challenge: ResyChallenge,
  fieldValues: Record<string, string>,
): Promise<string | null> {
  console.log(`[resy] Completing challenge for ${challenge.mobileNumber}`);

  const body: Record<string, string> = {
    mobile_number: challenge.mobileNumber,
    claim_token: challenge.claimToken,
    challenge_id: challenge.challengeId,
    ...fieldValues,
  };

  console.log(`[resy] Challenge body:`, JSON.stringify(body));

  const res = await fetch(`${RESY_BASE_URL}/3/auth/challenge`, {
    method: 'POST',
    headers: RESY_PRE_AUTH_HEADERS,
    body: new URLSearchParams(body).toString(),
  });

  const text = await res.text();
  console.log(`[resy] Challenge response (${res.status}):`, text.substring(0, 500));

  if (!res.ok) {
    console.error(`[resy] Challenge failed (${res.status})`);
    return null;
  }

  try {
    const data = JSON.parse(text) as Record<string, any>;
    console.log(`[resy] Challenge response keys:`, Object.keys(data));
    const token = data.token || data.auth_token || data.access_token;
    if (token) {
      console.log(`[resy] Got auth token!`);
      return token;
    }
    console.log(`[resy] Full challenge response:`, JSON.stringify(data, null, 2));
  } catch {
    console.error(`[resy] Failed to parse challenge response as JSON`);
  }
  return null;
}

/**
 * Register a new Resy user using a claim token + user info.
 * Tries multiple endpoints since the Resy registration API isn't documented.
 */
export async function registerResyUser(
  claimToken: string,
  mobileNumber: string,
  firstName: string,
  lastName: string,
  email: string,
): Promise<string | null> {
  console.log(`[resy] Registering new user: ${firstName} ${lastName} <${email}>`);

  const userFields = {
    mobile_number: mobileNumber,
    claim_token: claimToken,
    first_name: firstName,
    last_name: lastName,
    em_address: email,
  };

  // Try known Resy registration endpoints in order
  const endpoints = [
    '/3/auth/mobile/claim',
    '/3/user',
    '/2/user',
    '/3/auth/register',
  ];

  for (const endpoint of endpoints) {
    console.log(`[resy] Trying registration via ${endpoint}`);

    const res = await fetch(`${RESY_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: RESY_PRE_AUTH_HEADERS,
      body: new URLSearchParams(userFields).toString(),
    });

    const text = await res.text();
    console.log(`[resy] ${endpoint} response (${res.status}):`, text.substring(0, 1000));

    if (res.ok) {
      try {
        const data = JSON.parse(text) as Record<string, any>;
        const token = data.token || data.auth_token || data.access_token;
        if (token) {
          console.log(`[resy] Registration succeeded via ${endpoint}!`);
          return token;
        }
        console.log(`[resy] ${endpoint} keys:`, Object.keys(data));
      } catch {
        console.error(`[resy] Could not parse ${endpoint} response`);
      }
    }
  }

  console.error(`[resy] All registration endpoints failed`);
  return null;
}

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
