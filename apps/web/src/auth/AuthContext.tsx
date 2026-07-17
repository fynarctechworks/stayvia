import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { UI_PREVIEW } from "@/lib/mock-data";
import { supabase } from "@/lib/supabase";
import type { Role } from "@stayvia/shared";

interface Profile {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  rbacRoleKey: string | null;
  isGodMode: boolean;
  permissions: string[];
  // The hotel this account belongs to (one hotel per account in v1).
  property: { id: string; name: string } | null;
}

interface AuthCtx {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  permissions: Set<string>;
  isGodMode: boolean;
  // Convenience mirror of profile.property for shell branding.
  property: { id: string; name: string } | null;
  can: (key: string) => boolean;
  // signIn returns whether a second factor is still required. When true,
  // the caller (Login) must collect a TOTP code and call verifyMfa
  // before the user is fully authenticated. While mfaPending is true the
  // app treats the user as NOT logged in (guards redirect to /login).
  signIn: (email: string, password: string) => Promise<{ mfaRequired: boolean }>;
  // Completes the second-factor challenge with a 6-digit TOTP code.
  // Throws on a wrong/expired code so the caller can show an error.
  verifyMfa: (code: string) => Promise<void>;
  // True between a successful password sign-in and a completed MFA
  // challenge. The route guard uses this to keep the user on the
  // challenge screen instead of letting them into the app.
  mfaPending: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

const FAKE_SESSION = { access_token: "ui-preview", user: { id: "preview" } } as unknown as Session;
const FAKE_PROFILE: Profile = {
  id: "preview",
  email: "admin@stayvia.local",
  fullName: "Preview Admin",
  role: "admin",
  rbacRoleKey: "admin",
  isGodMode: true,
  permissions: [],
  property: { id: "preview-property", name: "Preview Hotel" },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(UI_PREVIEW ? FAKE_SESSION : null);
  const [profile, setProfile] = useState<Profile | null>(UI_PREVIEW ? FAKE_PROFILE : null);
  const [loading, setLoading] = useState(!UI_PREVIEW);
  // True when the user has passed password auth but still owes a TOTP
  // challenge. While true, guards keep them out of the app.
  const [mfaPending, setMfaPending] = useState(false);
  const queryClient = useQueryClient();
  // Last authenticated user id seen by the auth listener. When it changes
  // (sign-out or a different account signing in on a shared front-desk
  // machine) every cached query is dropped — react-query would otherwise
  // keep serving the previous hotel's dashboard/guests from cache.
  const lastUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (UI_PREVIEW) return;
    supabase.auth.getSession().then(async ({ data }) => {
      setSession((prev) => (prev?.user.id === data.session?.user.id ? prev : data.session));
      if (!data.session) {
        setLoading(false);
        return;
      }
      // A restored session might be AAL1 while the user has a verified
      // TOTP factor (e.g. they closed the tab mid-challenge, or the
      // session predates enrollment). If so, hold them at the challenge
      // screen until they complete the second factor.
      try {
        const { data: aal } =
          await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aal && aal.nextLevel === "aal2" && aal.currentLevel === "aal1") {
          setMfaPending(true);
        }
      } catch {
        // MFA not configured on the project, or call failed — proceed as
        // a normal AAL1 session.
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      const uid = s?.user.id ?? null;
      if (lastUserIdRef.current !== uid) {
        if (lastUserIdRef.current !== null) queryClient.clear();
        lastUserIdRef.current = uid;
      }
      setSession((prev) => (prev?.user.id === s?.user.id ? prev : s));
      if (!s) {
        setProfile(null);
        setMfaPending(false);
        setLoading(false);
      }
    });
    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (UI_PREVIEW) return;
    if (!userId) return;
    // Don't load the profile until the second factor is satisfied — the
    // user isn't fully authenticated while a challenge is outstanding.
    if (mfaPending) return;
    if (profile?.id === userId) return;
    setLoading(true);
    api
      .get<{ profile: Profile }>("/auth/me")
      .then((r) => setProfile(r.profile))
      .catch(() => setProfile(null))
      .finally(() => setLoading(false));
  }, [userId, profile?.id, mfaPending]);

  async function signIn(email: string, password: string): Promise<{ mfaRequired: boolean }> {
    if (UI_PREVIEW) return { mfaRequired: false };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    // Password accepted → check whether a second factor is owed. If the
    // user has a verified TOTP factor, AAL jumps to nextLevel 'aal2'
    // while currentLevel is still 'aal1' until they complete a challenge.
    let needs = false;
    try {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      needs = !!aal && aal.nextLevel === "aal2" && aal.currentLevel === "aal1";
    } catch {
      // MFA not available — treat as a normal AAL1 login.
      needs = false;
    }

    // When no second factor is owed, the session is fully authenticated —
    // verify the account is still ACTIVE before letting them proceed. The
    // browser authenticates directly against Supabase, which happily signs
    // in a deactivated/deleted staff member (their auth user still exists),
    // so without this they'd land on the dashboard and only then hit a 403.
    // Checking here surfaces the error on the login page instead. (For MFA
    // users the same check runs after verifyMfa completes.)
    if (!needs) {
      await assertActiveAccount();
    }

    setMfaPending(needs);
    return { mfaRequired: needs };
  }

  // Confirm the signed-in user has an active profile. /auth/me runs through
  // requireAuth, which returns 403 for a deactivated user or one with no
  // profile (deleted staff). On failure we sign out so no usable session
  // lingers, and throw a clear message for the login page.
  async function assertActiveAccount(): Promise<void> {
    try {
      await api.get("/auth/me");
    } catch (err) {
      await supabase.auth.signOut();
      setSession(null);
      const msg =
        err instanceof Error && /deactivat|inactive|no.?profile|403/i.test(err.message)
          ? "This account has been deactivated. Contact your administrator."
          : "Unable to sign in. Please try again.";
      throw new Error(msg);
    }
  }

  // Complete the TOTP challenge. We pick the user's first verified TOTP
  // factor, create a fresh challenge, and verify the supplied code. On
  // success the session is upgraded to AAL2 and we clear mfaPending so
  // the profile loads and guards let the user in.
  async function verifyMfa(code: string): Promise<void> {
    if (UI_PREVIEW) return;
    const { data: factorsData, error: listErr } = await supabase.auth.mfa.listFactors();
    if (listErr) throw listErr;
    const totp = factorsData?.totp?.find((f) => f.status === "verified");
    if (!totp) {
      throw new Error("No verified authenticator found for this account.");
    }
    const { data: chal, error: chalErr } = await supabase.auth.mfa.challenge({
      factorId: totp.id,
    });
    if (chalErr) throw chalErr;
    const { error: verErr } = await supabase.auth.mfa.verify({
      factorId: totp.id,
      challengeId: chal.id,
      code,
    });
    if (verErr) throw verErr;
    // Verified → now AAL2 (fully authenticated). Same active-account gate as
    // the non-MFA path: a deactivated user must be stopped here, not on the
    // dashboard. Throws (and signs out) if the account is disabled.
    await assertActiveAccount();
    // Clear the gate; the profile-load effect fires.
    setMfaPending(false);
  }

  async function signOut() {
    if (UI_PREVIEW) {
      setSession(null);
      setProfile(null);
      return;
    }
    setMfaPending(false);
    await supabase.auth.signOut();
  }

  const permissions = useMemo(
    () => new Set(profile?.permissions ?? []),
    [profile?.permissions],
  );
  const isGodMode = profile?.isGodMode ?? false;

  function can(key: string): boolean {
    if (isGodMode) return true;
    return permissions.has(key);
  }

  return (
    <Ctx.Provider
      value={{
        session,
        profile,
        loading,
        permissions,
        isGodMode,
        property: profile?.property ?? null,
        can,
        signIn,
        verifyMfa,
        mfaPending,
        signOut,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}

export function usePermission(key: string): boolean {
  return useAuth().can(key);
}
