// Fetch helpers for the PUBLIC QR pages (/r/:token, /h/:token). No auth, no
// Supabase session — these run on a guest's phone. Same API origin as the
// app, /public/qr/* endpoints.

const BASE = ((import.meta.env.VITE_API_URL as string) ?? "").replace(/\/+$/, "");

export class PublicApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: { code?: string; message?: string };
  };
  if (!res.ok || body.success === false) {
    throw new PublicApiError(
      res.status,
      body.error?.code ?? "ERROR",
      body.error?.message ?? "Something went wrong",
    );
  }
  return body.data as T;
}

export const publicQr = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, payload: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(payload) }),
};

export interface QrHotelCard {
  name: string;
  address: string;
  phone: string;
  logoUrl: string | null;
  checkInTime: string;
  checkOutTime: string;
  // Public GST config — lets the booking page preview the exact tax the
  // desk will charge (mirrors the server's slab + mode).
  gstMode: "exclusive" | "inclusive";
  gstSlabs: {
    exemptBelow: number;
    lowRate: number;
    lowMax: number;
    highRate: number;
  };
}

export interface QrRoomBrochure {
  hotel: QrHotelCard;
  roomNumber: string;
  occupied: boolean;
}

export interface QrRoomHome {
  hotel: QrHotelCard;
  roomNumber: string;
  guestName: string;
  checkOutDate: string;
  checkOutTime: string;
  wifiSsid: string | null;
  wifiPassword: string | null;
}

export interface QrRoomImage {
  url: string;
  caption: string | null;
}

export interface QrCatalogRoom {
  id: string;
  roomNumber: string;
  floor: number;
  roomType: string;
  roomTypeLabel: string;
  roomTypeDescription: string | null;
  baseRate: number;
  maxOccupancy: number;
  hasAc: boolean;
  hasTv: boolean;
  hasWifi: boolean;
  images: QrRoomImage[];
  amenities: string[];
}

export interface QrCatalog {
  hotel: QrHotelCard;
  rooms: QrCatalogRoom[];
}

// Best-effort browser geolocation for the advisory geofence. Resolves null
// on deny/timeout — never blocks the flow.
export function tryGetGeo(): Promise<{ lat: number; lng: number; accuracyM?: number } | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    const timer = setTimeout(() => resolve(null), 4000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
        });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 3500, maximumAge: 60000 },
    );
  });
}
