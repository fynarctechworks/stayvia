export const UI_PREVIEW = import.meta.env.VITE_UI_PREVIEW === "true";

const emptyDashboard = {
  occupancy: { occupied: 0, total: 0, percentage: 0 },
  today_checkins: { count: 0, reservations: [] },
  today_checkouts: { count: 0, reservations: [] },
  revenue_today: { total_collected: 0 },
  room_grid: [],
  recent_activity: [],
};

const emptySettings = {
  settings: {
    id: "s0",
    hotelName: "My Hotel",
    address: "",
    phone: "",
    email: "",
    gstin: "",
    stateCode: "",
    defaultCgstRate: "9",
    defaultSgstRate: "9",
    invoicePrefix: "INV",
    defaultCheckInTime: "12:00",
    defaultCheckOutTime: "11:00",
  },
  roomTypes: [],
  chargeTemplates: [],
};

export function mockGet<T>(path: string, _params?: Record<string, string | number | undefined>): T {
  if (path === "/dashboard") return emptyDashboard as T;
  if (path === "/settings") return emptySettings as T;
  if (path === "/settings/room-types") return [] as T;
  if (path.startsWith("/guests/") && path.endsWith("/kyc")) {
    return { verified: false, kycVerifiedAt: null, frontUrl: null, backUrl: null } as T;
  }
  return [] as T;
}

export function mockMutation<T>(_path: string): T {
  return { id: "preview", ok: true } as T;
}
