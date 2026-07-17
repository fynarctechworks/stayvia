import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { Loader } from "@/components/Loader";
import { PermissionGuard, ProtectedRoute } from "@/auth/guards";

const Login = lazy(() => import("@/pages/Login"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Rooms = lazy(() => import("@/pages/Rooms"));
const RoomDetail = lazy(() => import("@/pages/RoomDetail"));
const CalendarPage = lazy(() => import("@/pages/Calendar"));
const Reservations = lazy(() => import("@/pages/Reservations"));
const NewReservation = lazy(() => import("@/pages/NewReservation"));
const ReservationDetail = lazy(() => import("@/pages/ReservationDetail"));
const Guests = lazy(() => import("@/pages/Guests"));
const GuestProfile = lazy(() => import("@/pages/GuestProfile"));
const Housekeeping = lazy(() => import("@/pages/Housekeeping"));
const Activity = lazy(() => import("@/pages/Activity"));
const Reports = lazy(() => import("@/pages/Reports"));
const Settings = lazy(() => import("@/pages/Settings"));
const Messages = lazy(() => import("@/pages/Messages"));
const Notifications = lazy(() => import("@/pages/Notifications"));
const Collections = lazy(() => import("@/pages/Collections"));
const Credits = lazy(() => import("@/pages/Credits"));
const Invoices = lazy(() => import("@/pages/Invoices"));
const Expenses = lazy(() => import("@/pages/Expenses"));
const ExpenseDetail = lazy(() => import("@/pages/ExpenseDetail"));
const MaintenanceDetail = lazy(() => import("@/pages/MaintenanceDetail"));

export default function App() {
  return (
    <Suspense fallback={<Loader size="lg" fullscreen />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Password-reset confirmation. Public (no auth) — the user
            arrives from the recovery email link with a token in the URL
            hash. No AppShell. */}
        <Route path="/reset-password" element={<ResetPassword />} />

        {/* Dashboard is mounted at both / and /dashboard so the URL is
            explicit when staff types or bookmarks the dashboard. Both
            paths render the same component — no redirect, no
            additional fetch cost. */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppShell>
                <Dashboard />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <AppShell>
                <Dashboard />
              </AppShell>
            </ProtectedRoute>
          }
        />

        <Route
          path="/rooms"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_rooms"]}>
                  <Rooms />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/rooms/:id"
          element={
            <ProtectedRoute>
              <AppShell>
                {/* RoomDetail is the maintenance-history view (see its
                    header comment) — no room editing happens here, so it
                    gates on view_maintenance, not edit_rooms. Front desk /
                    housekeeping reach it from the Housekeeping board's
                    "room details + maintenance history" link. */}
                <PermissionGuard any={["view_maintenance"]}>
                  <RoomDetail />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />

        <Route
          path="/calendar"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_reservations"]}>
                  <CalendarPage />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/reservations"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_reservations"]}>
                  <Reservations />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/reservations/new"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["create_reservations"]}>
                  <NewReservation />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/reservations/:id"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_reservations"]}>
                  <ReservationDetail />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />

        <Route
          path="/guests"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_guests"]}>
                  <Guests />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/guests/:id"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_guests"]}>
                  <GuestProfile />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />

        <Route
          path="/housekeeping"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_housekeeping"]}>
                  <Housekeeping />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/activity"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_activity"]}>
                  <Activity />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/reports"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_reports"]}>
                  <Reports />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["manage_settings", "manage_staff", "manage_roles", "manage_templates"]}>
                  <Settings />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />

        <Route
          path="/messages"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_messages"]}>
                  <Messages />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/notifications"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_notifications"]}>
                  <Notifications />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/collections"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_revenue"]}>
                  <Collections />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/credits"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_revenue"]}>
                  <Credits />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/invoices"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_invoices"]}>
                  <Invoices />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/expenses"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_expenses"]}>
                  <Expenses />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/expenses/:id"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_expenses"]}>
                  <ExpenseDetail />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/maintenance/:id"
          element={
            <ProtectedRoute>
              <AppShell>
                <PermissionGuard any={["view_maintenance"]}>
                  <MaintenanceDetail />
                </PermissionGuard>
              </AppShell>
            </ProtectedRoute>
          }
        />

        <Route
          path="*"
          element={
            <div className="p-8">
              <h1 className="text-xl font-semibold">404</h1>
            </div>
          }
        />
      </Routes>
    </Suspense>
  );
}
