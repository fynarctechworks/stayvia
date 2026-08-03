// Guest request alert — the centered overlay that tells staff, anywhere in
// the app, that a guest just tapped a tile on the in-room QR sheet.
//
// The sidebar badge (Sidebar.tsx) already counts what is waiting. A badge
// that quietly ticks from 2 to 3 is not an announcement: the guest is
// standing in their room with a wet towel. This is the announcement.
//
// Mounted once, inside the authed shell (AppShell.tsx), so it can appear over
// any page. Polling only — no sound, no browser notifications, no sockets.
//
// ---------------------------------------------------------------------------
// WHAT COUNTS AS "NEW"
// ---------------------------------------------------------------------------
//   ids       — every request this browser has already put on screen for this
//               user, so a re-poll, a reload or a second tab never announces
//               the same thing twice.
//   freshness — a request is only announced while it is within
//               MAX_ANNOUNCE_AGE_MS of the NEWEST request on the page.
//
// The age bound is what stops the 9am wall-of-overlays and the wake-from-sleep
// backlog burst: a laptop that slept through the night resumes, polls once and
// gets everything at once, and only the last few minutes of that is news.
//
// It is measured against the newest `created_at` in the same response, never
// against the browser's clock: both sides of that comparison are then server
// timestamps, so a front-desk PC whose clock is ten minutes out does not
// silently stop announcing anything.
//
// It deliberately does NOT keep a `since` high-water mark. `created_at` is
// PG now() — transaction START time — which is not commit order, so a row can
// become visible with a timestamp below one already seen; discarding on that
// comparison drops a real guest request permanently. The id set carries the
// "already announced" duty on its own, and the age bound covers the case the
// mark used to cover (an old request climbing onto the newest page when
// newer ones get acknowledged — old is old, whatever page it turns up on).
//
// Both live in localStorage keyed by hotel + user: shared across the tabs of
// one signed-in user (two tabs announcing the same request twice is noise, not
// safety), never shared between two users on the same front-desk machine, and
// re-seeded from scratch once the stored set goes stale (STALE_STATE_MS).
//
// ---------------------------------------------------------------------------
// WHY status=open AND NOT GUEST_REQUEST_OPEN_STATUSES
// ---------------------------------------------------------------------------
// The sidebar badge counts open + acknowledged because it answers "how much
// still needs doing". This overlay answers "something just arrived".
// `acknowledged` means a colleague already picked it up — interrupting the
// whole desk about work that is already owned is exactly the noise that makes
// people stop reading alerts.
//
// That filter applies at fetch time, so it is not enough on its own: a request
// queued at 10:00:15 and shown at 10:02 may have been acknowledged at 10:00:30
// by housekeeping's phone. Every poll therefore also RECONCILES the queue —
// anything that has left the open set is removed from it, displayed or not.
import {
  GUEST_REQUEST_KIND_LABELS,
  type GuestRequestKind,
} from "@stayvia/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  BedDouble,
  Check,
  ChevronRight,
  Gift,
  Loader2,
  SprayCan,
  User,
  Wrench,
  X,
} from "@/lib/micons";
import { useAuth } from "@/auth/AuthContext";
import { useToast } from "@/components/Toast";
import { ApiError, api, getList } from "@/lib/api";

// Only the columns the overlay renders. Same rows as GuestRequests.tsx —
// guestName is nullable because that FK is ON DELETE SET NULL (a request
// outlives a DPDP purge of the stay).
interface AlertRow {
  id: string;
  kind: GuestRequestKind;
  note: string | null;
  createdAt: string;
  roomNumber: string;
  guestName: string | null;
}

// What PATCH /guest-requests/:id answers with. Only the ownership stamps
// matter here: re-sending a status the row already has is a deliberate no-op
// 200 on the API side (double-taps on a phone are the normal case), so the
// stamps are the only way to tell "I got it" from "someone else got it".
interface AckResult {
  id: string;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
}

// Same 15s cadence as the sidebar badge, for the same reason.
const POLL_MS = 15_000;
// Newest open requests per poll. Deep enough that a realistic burst is fully
// seen, shallow enough to keep the queue (and the modal counter) sane.
const PAGE_SIZE = 20;
// Cap on the persisted id list.
const SEEN_CAP = 300;
// How long every text field must stay unfocused before we are willing to
// interrupt. Long enough that Tab between two inputs doesn't flash the
// overlay, short enough that it appears the moment someone stops typing.
const QUIET_MS = 1200;
// How far back an arrival still counts as an announcement rather than
// backlog, measured against the newest request in the same response.
const MAX_ANNOUNCE_AGE_MS = 10 * 60_000;
// A stored seen-set older than this is treated as absent, so the next poll
// re-seeds silently instead of announcing a shift's worth of backlog.
const STALE_STATE_MS = 12 * 60 * 60_000;
// Dead time after the overlay appears (and after it swaps to the next
// request) during which it ignores dismissing input. The overlay arrives
// unprompted, under whatever the cursor was about to click and whatever key
// was about to be pressed; without this, input already in flight silently
// destroys the announcement and no later poll can bring it back.
const GRACE_MS = 500;
// How often we re-check whether another modal is stacked above us, while a
// request is waiting to be announced.
const OVERLAY_CHECK_MS = 400;

const STORAGE_PREFIX = "stayvia:guest-request-alert";

interface SeenState {
  ids: string[];
  savedAt: number;
}

// `primed: false` means "this browser has no usable seen-set for this
// account" — the seed pass. Deliberately signalled by the KEY being absent
// rather than by the id list being empty: a desk that keeps its queue clear
// (the normal state) seeds an empty list, and treating empty as unprimed
// would swallow that desk's very first real request.
function loadSeen(key: string): { primed: boolean; state: SeenState } {
  const empty = { primed: false, state: { ids: [], savedAt: 0 } };
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return empty;
    const parsed = JSON.parse(raw) as Partial<SeenState>;
    const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
    // Yesterday's seen-set is not a seen-set. Re-seed rather than announce a
    // night's worth of requests to whoever opens the app first.
    if (Date.now() - savedAt > STALE_STATE_MS) return empty;
    return {
      primed: true,
      state: {
        savedAt,
        ids: Array.isArray(parsed.ids)
          ? parsed.ids.filter((v): v is string => typeof v === "string")
          : [],
      },
    };
  } catch {
    // Private-mode Safari, quota, or corrupt JSON. Falling back to unprimed
    // means the next poll seeds silently — never a burst of overlays.
    return empty;
  }
}

function saveSeen(key: string, state: SeenState): void {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Storage unavailable. The in-memory state still suppresses repeats for
    // this page view; only a reload loses it, and a reload re-seeds silently.
  }
}

// Union, newest-last, capped. Never a replace: the other tab's ids are as
// authoritative as ours.
function mergeIds(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b])).slice(-SEEN_CAP);
}

function timeAgo(iso: string, now: number): string {
  const s = Math.max(1, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const KIND_META: Record<
  GuestRequestKind,
  { icon: typeof SprayCan; chip: string; asked: string }
> = {
  cleaning: {
    icon: SprayCan,
    chip: "bg-infoBg text-info border-infoBorder",
    asked: "Asked for their room to be cleaned.",
  },
  amenity: {
    icon: Gift,
    chip: "bg-brand-soft text-brand-deep border-brand-tint",
    asked: "Asked for towels, water or another amenity.",
  },
  issue: {
    icon: Wrench,
    chip: "bg-dangerBg text-dangerFg border-dangerBorder",
    asked: "Reported something broken in the room.",
  },
};

// A field where an interrupting modal would eat the next keystroke and lose
// the caret. Buttons and checkboxes are not in that category.
function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return !["button", "submit", "reset", "checkbox", "radio", "file", "image"].includes(type);
}

// Is some other full-screen layer stacked ABOVE this alert right now?
//
// Every modal in this app is a `fixed inset-0` layer with an explicit
// z-index, and several sit above ours: Dialog.tsx at 200, PdfPreviewModal /
// RolesManager / the guest-profile sheets at 150-160, the Expenses and
// Reports forms at 100. Announcing underneath one of those is the worst of
// both worlds — the alert is invisible behind their backdrop, yet it is the
// one that answers the Escape aimed at the modal on top, and that silently
// consumes an announcement that can never be made again.
//
// So we neither show nor listen while one is up. The request stays queued and
// is announced the moment the screen is ours.
const ALERT_Z = 90;
function overlayAbove(): boolean {
  for (const el of document.querySelectorAll<HTMLElement>("div.fixed.inset-0")) {
    if (el.dataset.guestRequestAlert === "1") continue;
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
    const z = Number.parseInt(cs.zIndex, 10);
    if (Number.isFinite(z) && z > ALERT_Z) return true;
  }
  return false;
}

// True when it is safe to interrupt: nothing has been typed into for
// QUIET_MS, and no higher layer owns the screen.
//
// The owner asked for a centered overlay and gets one — but a modal that
// steals focus mid-sentence makes staff lose a half-typed booking, and the
// next thing they learn is to close alerts without reading them. So the
// overlay waits: the request stays queued, the sidebar badge still ticks, and
// the moment the caret leaves the form the overlay appears. Nothing is
// dropped, only deferred.
//
// This is an ENTRY gate only — see the latch in the component. A dialog that
// is already up must not vanish because focus later landed in a text field;
// unmounting mid-read loses the announcement and yanks focus back out of
// whatever the user just opened.
function useSafeToInterrupt(pending: boolean): boolean {
  const [quiet, setQuiet] = useState(() => !isTextEntry(document.activeElement));

  useEffect(() => {
    let timer: number | undefined;
    function evaluate() {
      window.clearTimeout(timer);
      if (isTextEntry(document.activeElement)) {
        setQuiet(false);
        return;
      }
      // focusout fires before the matching focusin, so activeElement is
      // momentarily <body> while tabbing between two inputs. The delay lets
      // the incoming focusin cancel this.
      timer = window.setTimeout(() => setQuiet(!isTextEntry(document.activeElement)), QUIET_MS);
    }
    evaluate();
    document.addEventListener("focusin", evaluate);
    document.addEventListener("focusout", evaluate);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("focusin", evaluate);
      document.removeEventListener("focusout", evaluate);
    };
  }, []);

  // Polled rather than observed: modals mount and unmount without an event
  // we can subscribe to. Only runs while something is actually waiting.
  const [clear, setClear] = useState(true);
  useEffect(() => {
    if (!pending) return;
    setClear(!overlayAbove());
    const t = window.setInterval(() => setClear(!overlayAbove()), OVERLAY_CHECK_MS);
    return () => window.clearInterval(t);
  }, [pending]);

  return quiet && clear;
}

export function GuestRequestAlert() {
  const { profile, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();

  // Read gate matches the API and the sidebar badge (view_housekeeping).
  // Write gate on top of it: the overlay's whole point is its Acknowledge
  // button, and a read-only role (owner) can only be interrupted by it, never
  // act on it. They keep the badge and the queue page. Narrower than the
  // sidebar's gate, so this never polls an endpoint the user can't read.
  const enabled = !!profile && can("view_housekeeping") && can("update_housekeeping");

  // Per hotel AND per user: a shared front-desk machine must not hand one
  // user's seen-set to whoever signs in next.
  const storageKey = profile
    ? `${STORAGE_PREFIX}:${profile.property?.id ?? "no-property"}:${profile.id}`
    : null;

  // On the queue page the overlay is pure obstruction: that page polls at 10s,
  // renders the same request as a card, and carries every action this modal
  // has plus Convert and Cancel. Covering the list you are working with a
  // modal about one row of it is worse than useless. We still mark arrivals
  // seen while here, so walking away doesn't trigger a backlog burst.
  const onQueuePage = location.pathname.startsWith("/guest-requests");

  const q = useQuery({
    queryKey: ["guest-requests", "alert"],
    queryFn: () => getList<AlertRow>("/guest-requests", { status: "open", per_page: PAGE_SIZE }),
    refetchInterval: POLL_MS,
    // Overrides the app-wide refetchOnWindowFocus:false (main.tsx) for this
    // query only. The interval does not run in a backgrounded tab, so coming
    // back to one otherwise leaves a queued (or displayed) request that a
    // colleague has since taken sitting there for up to 15s more. Refetching
    // on focus reconciles immediately; it cannot cause a backlog burst
    // because announcing is bounded by MAX_ANNOUNCE_AGE_MS.
    refetchOnWindowFocus: true,
    // The app-wide 30s staleTime would make that focus refetch a no-op most
    // of the time (data is usually <30s old on a 15s interval).
    staleTime: 0,
    enabled,
  });

  const [queue, setQueue] = useState<AlertRow[]>([]);
  const seenRef = useRef<{ key: string; primed: boolean; state: SeenState } | null>(null);
  const safeToInterrupt = useSafeToInterrupt(queue.length > 0);

  const rows = q.data?.data;
  useEffect(() => {
    if (!rows || !storageKey) return;

    // Account or hotel changed under us (sign-out / different user on a
    // shared machine): reload from that user's own key and drop the queue.
    if (seenRef.current?.key !== storageKey) {
      seenRef.current = { key: storageKey, ...loadSeen(storageKey) };
      setQueue([]);
    }
    const mem = seenRef.current;

    // Re-read the shared entry every poll rather than trusting the copy this
    // tab loaded on mount: two tabs on one account share one key, and
    // whichever polls second must union in what the other already announced
    // instead of overwriting it.
    const stored = loadSeen(storageKey);
    if (stored.primed) {
      mem.primed = true;
      mem.state = {
        ids: mergeIds(stored.state.ids, mem.state.ids),
        savedAt: stored.state.savedAt,
      };
    }

    // --- reconcile: anything that has left the open set leaves the queue ---
    //
    // We only read the newest page, so absence from a FULL page proves
    // nothing about rows older than its oldest entry — they may simply have
    // been pushed off the end. Below that floor we keep what we have; at or
    // above it (and always, when the page is short enough to be the whole
    // open set) absence means the request is no longer open.
    const openIds = new Set(rows.map((r) => r.id));
    const pageFloor =
      rows.length >= PAGE_SIZE
        ? rows.reduce<string | null>(
            (min, r) => (min === null || r.createdAt < min ? r.createdAt : min),
            null,
          )
        : null;
    const stillOpen = (r: AlertRow) =>
      openIds.has(r.id) || (pageFloor !== null && r.createdAt < pageFloor);

    let fresh: AlertRow[] = [];
    if (!mem.primed) {
      // Seed pass: whatever is open right now is backlog. Announce nothing.
      mem.primed = true;
      mem.state = { ids: rows.map((r) => r.id).slice(-SEEN_CAP), savedAt: Date.now() };
      saveSeen(storageKey, mem.state);
    } else {
      // Server-clock only — see the header note on MAX_ANNOUNCE_AGE_MS.
      const newest = rows.reduce((max, r) => Math.max(max, Date.parse(r.createdAt)), 0);
      const cutoff = newest - MAX_ANNOUNCE_AGE_MS;
      const seen = new Set(mem.state.ids);
      fresh = rows.filter((r) => !seen.has(r.id) && Date.parse(r.createdAt) >= cutoff);
      if (fresh.length > 0) {
        // Marked seen the moment we take them, not when they are dismissed —
        // a request is announced exactly once, and the next poll (4s later,
        // if the user is mid-form) must not queue it a second time. Safe
        // because the overlay ignores dismissing input for GRACE_MS, so a
        // "dismissal" the user never made cannot consume the announcement.
        mem.state = {
          ids: mergeIds(mem.state.ids, fresh.map((r) => r.id)),
          savedAt: Date.now(),
        };
        saveSeen(storageKey, mem.state);
      }
    }

    setQueue((prev) => {
      const kept = prev.filter(stillOpen);
      // Oldest first: the guest who has been waiting longest is dealt with
      // first. The API hands them back newest-first for the queue page.
      const add = onQueuePage ? [] : fresh.filter((r) => !kept.some((k) => k.id === r.id));
      if (add.length === 0) return kept.length === prev.length ? prev : kept;
      return [...kept, ...add].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }, [rows, storageKey, onQueuePage]);

  // Navigating onto the queue page closes whatever is showing — they are now
  // looking at the full list, which is strictly more information.
  useEffect(() => {
    if (onQueuePage) setQueue([]);
  }, [onQueuePage]);

  // BY ID, never by index. These run from async mutation callbacks, and the
  // queue can have advanced (a dismissal, or a poll that reconciled the row
  // away) between the PATCH going out and its answer coming back. Slicing
  // position 0 there would discard a request that was never shown and is
  // already marked seen — a guest silently dropped from the announcement path.
  const dismiss = useCallback(
    (id: string) => setQueue((prev) => prev.filter((r) => r.id !== id)),
    [],
  );
  const dismissAll = useCallback(() => setQueue([]), []);
  const viewQueue = useCallback(() => {
    setQueue([]);
    navigate("/guest-requests");
  }, [navigate]);

  const acknowledge = useMutation({
    mutationFn: (id: string) => api.patch<AckResult>(`/guest-requests/${id}`, { status: "acknowledged" }),
    onSuccess: (result, id) => {
      // 200 does not mean "you got it". A same-status PATCH is a no-op on the
      // API, so if a colleague acknowledged this request first the row comes
      // back stamped with THEIR id. Telling both of them it is theirs is how
      // two people end up walking to the same room — and how nobody does.
      const mine = !result?.acknowledgedBy || result.acknowledgedBy === profile?.id;
      if (mine) {
        toast("Acknowledged - the guest's request is now yours.", "success");
      } else {
        toast(`${result.acknowledgedByName ?? "A colleague"} already picked that one up.`, "info");
      }
      dismiss(id);
      // The whole "guest-requests" prefix: the sidebar badge
      // (["guest-requests","count"]), the queue page's list, and this
      // overlay's own poll. The count and the overlay can never disagree.
      void qc.invalidateQueries({ queryKey: ["guest-requests"] });
    },
    onError: (e, id) => {
      // Someone else already closed it — nothing left to do, so move on
      // rather than parking a dead request in front of the user.
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
        toast("Someone else already picked that one up.", "info");
        dismiss(id);
      } else {
        toast(e instanceof ApiError ? e.message : "Could not acknowledge the request", "error");
      }
      void qc.invalidateQueries({ queryKey: ["guest-requests"] });
    },
  });

  // Latch: safety decides WHETHER to interrupt, not whether to keep
  // interrupting. Once the dialog is up it stays up until the queue empties.
  const [interrupting, setInterrupting] = useState(false);
  useEffect(() => {
    if (queue.length === 0) setInterrupting(false);
    else if (safeToInterrupt) setInterrupting(true);
  }, [queue.length, safeToInterrupt]);

  const current = queue[0];
  if (!current || !interrupting) return null;

  return (
    <AlertDialog
      row={current}
      remaining={queue.length}
      busy={acknowledge.isPending && acknowledge.variables === current.id}
      onAcknowledge={() => acknowledge.mutate(current.id)}
      onView={viewQueue}
      onDismiss={() => dismiss(current.id)}
      onDismissAll={dismissAll}
    />
  );
}

// ---------------------------------------------------------------- overlay

// ONE dialog at a time, advanced one request at a time, with the remaining
// count on the header. Three simultaneous requests do NOT get three stacked
// modals (three backdrops, an ambiguous focus owner, and a Z-order lottery),
// and they do not get merged into one list either — "Acknowledge" means "I am
// taking THIS guest's request", and a single button over three rooms cannot
// mean that. One room, one guest, one unambiguous primary action; "Dismiss
// all" is there so a checkout-hour burst is never a modal treadmill.
function AlertDialog({
  row,
  remaining,
  busy,
  onAcknowledge,
  onView,
  onDismiss,
  onDismissAll,
}: {
  row: AlertRow;
  remaining: number;
  busy: boolean;
  onAcknowledge: () => void;
  onView: () => void;
  onDismiss: () => void;
  onDismissAll: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const meta = KIND_META[row.kind];
  const Icon = meta.icon;

  // Keeps "2m ago" honest between the 15s polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Dead time on arrival AND on every swap to the next request: the content
  // under the cursor changes without the user asking, so a click or an
  // Escape already on its way must not act on something nobody has read yet.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    const t = window.setTimeout(() => setArmed(true), GRACE_MS);
    return () => window.clearTimeout(t);
  }, [row.id]);

  // Latest props for the mount-scoped key handler below, which must not
  // re-subscribe (it captures the focus-restore target at mount).
  const latest = useRef({ armed, busy, onDismiss });
  useEffect(() => {
    latest.current = { armed, busy, onDismiss };
  });

  // Everything the dialog does with the keyboard, plus scroll lock and focus
  // restore. Mount-scoped: the dialog stays mounted while the queue drains, so
  // focus is restored to where the user actually was exactly once, at the end.
  //
  // Declared BEFORE the focus effect below on purpose: effects run in
  // declaration order, so this one reads document.activeElement while it is
  // still the element the user was on. Swap the two and it captures the
  // dialog's own panel and "restores" focus to a node that is being removed.
  useEffect(() => {
    const panel = panelRef.current;
    const restoreTo = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      // Something opened on top of us after we did (a confirm at z-200, say).
      // We are no longer the layer the user is talking to, so we stand down
      // entirely rather than swallowing keys meant for it.
      if (overlayAbove()) return;
      // CAPTURE phase on document, and nothing gets past us. Every other
      // modal in the app (Dialog.tsx, EditInvoiceModal, CheckInReceiptModal,
      // EarlyCheckInModal, PdfPreviewModal...) binds an unconditional
      // document/window keydown listener that keeps firing while this alert
      // sits on top of it. Without this, Escape aimed at the alert also
      // closes the half-filled form underneath and discards it, and a bare
      // Enter reaches DialogShell's window listener and CONFIRMS a question
      // the user cannot even see (Dialog.tsx maps Enter to confirm()).
      //
      // stopPropagation does not touch default actions, so Enter and Space
      // still activate whichever of this dialog's own buttons has focus.
      e.stopPropagation();
      e.stopImmediatePropagation();

      if (e.key === "Escape") {
        e.preventDefault();
        // Escape dismisses. It does NOT acknowledge — the request stays open
        // in the queue, which is the only safe meaning for a key that gets
        // pressed reflexively. Ignored during the arming grace, and while an
        // acknowledgement is in flight (dismissing then would race the
        // mutation's own callback).
        const { armed: canAct, busy: isBusy, onDismiss: dismissNow } = latest.current;
        if (canAct && !isBusy) dismissNow();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])"),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      // Put the user back where they were — but only if focus is still ours
      // to give back. If something else took it while we were up, dragging it
      // away on unmount is exactly the theft this component tries to avoid.
      const active = document.activeElement;
      const focusIsOurs = !active || active === document.body || !!panel?.contains(active);
      if (focusIsOurs && restoreTo && document.contains(restoreTo)) restoreTo.focus();
    };
  }, []);

  // Focus lands on the PANEL, never on Acknowledge. The dialog appears
  // unprompted, so an Enter or Space already in flight — or held down while
  // advancing through a burst — must not acknowledge a request nobody read.
  // Focusing the panel also gives screen readers its name and description.
  useEffect(() => {
    panelRef.current?.focus();
  }, [row.id]);

  // Advancing the queue swaps the dialog's text in place. role="alertdialog"
  // carries no implicit live region, the ids are static, and focus is already
  // on the panel so re-focusing it fires no event — without this, a screen
  // reader user who dismisses the first alert hears nothing at all while the
  // second one sits on screen. The dialog's own mount announcement covers the
  // first row, so only changes after that go through here.
  const liveMessage =
    `Room ${row.roomNumber}. ${meta.asked}` +
    (remaining > 1 ? ` ${remaining - 1} more guest request${remaining > 2 ? "s" : ""} waiting.` : "");
  const [live, setLive] = useState("");
  const announcedOnce = useRef(false);
  useEffect(() => {
    if (!announcedOnce.current) {
      announcedOnce.current = true;
      return;
    }
    setLive(liveMessage);
  }, [liveMessage]);

  // Every dismissing/acting control goes through this: nothing acts during
  // the arming grace, and nothing acts while an acknowledgement is in flight.
  const guard = (fn: () => void) => () => {
    if (armed && !busy) fn();
  };

  const note = row.note?.trim();

  return (
    // z-[90] — keep in step with ALERT_Z: above the sidebar and the mobile
    // drawer (z-50) and the alert strips (z-40), below the toast stack
    // (z-100) so the "Acknowledged" confirmation is readable over it.
    // Anything else above 90 is a modal, and overlayAbove() keeps this alert
    // from showing (or answering keys) while one of those owns the screen.
    <div
      data-guest-request-alert="1"
      className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto overscroll-contain bg-inkDark/60 backdrop-blur-[3px] p-3 sm:p-6 animate-in fade-in duration-150"
      onMouseDown={(e) => {
        // Backdrop click dismisses this one only — same meaning as Escape.
        // Swallowed during the grace: the overlay lands under a cursor that
        // was already pressing something else, and one lost click is far
        // cheaper than an announcement nobody ever saw.
        if (e.target === e.currentTarget) guard(onDismiss)();
      }}
    >
      <div
        ref={panelRef}
        // alertdialog, not dialog: this interrupts unprompted to announce
        // something time-critical, which is exactly what the role is for.
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="gr-alert-title"
        aria-describedby="gr-alert-body"
        tabIndex={-1}
        className="my-auto w-full max-w-sm min-w-0 bg-surface rounded-2xl shadow-modal outline-none animate-in fade-in zoom-in-95 duration-150"
      >
        <div aria-live="assertive" aria-atomic="true" className="sr-only">
          {live}
        </div>

        <div className="flex items-start gap-2 px-4 pt-4 pb-3 border-b border-divider">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] ${meta.chip}`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" /> {GUEST_REQUEST_KIND_LABELS[row.kind]}
              </span>
              {remaining > 1 && (
                <span className="inline-flex items-center rounded-full border border-warnBorder bg-warnBg px-2 py-0.5 text-[11px] font-bold text-warnFg tabular-nums">
                  +{remaining - 1} more
                </span>
              )}
            </div>
            <h2
              id="gr-alert-title"
              className="flex items-center gap-1.5 mt-2 text-[17px] font-semibold text-ink min-w-0"
            >
              <BedDouble className="w-5 h-5 shrink-0 text-inkMuted" />
              <span className="font-mono truncate">Room {row.roomNumber}</span>
            </h2>
            {/* textSecondary, not inkMuted: 11px bold on surface is body text
                by WCAG's measure and inkMuted only reaches 3.27:1. */}
            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-textSecondary mt-1">
              New guest request
            </p>
          </div>
          <button
            type="button"
            onClick={guard(onDismiss)}
            disabled={busy}
            aria-label="Dismiss this alert"
            aria-describedby="gr-alert-dismiss-note"
            className="w-11 h-11 -mt-1 -mr-1 shrink-0 grid place-items-center rounded-md text-inkMuted hover:text-ink hover:bg-parchment transition-colors disabled:opacity-60"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div id="gr-alert-body" className="px-4 py-3.5 space-y-3">
          <p className="text-[14px] text-inkBody leading-snug">{meta.asked}</p>

          {/* The guest's own words, verbatim. */}
          {note && (
            <blockquote className="rounded-md bg-surfaceSubtle border-l-2 border-brand-tint px-3 py-2 text-[13px] text-inkBody leading-snug break-words">
              &ldquo;{note}&rdquo;
            </blockquote>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-textSecondary min-w-0">
            <span className="inline-flex items-center gap-1 min-w-0">
              <User className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{row.guestName ?? "Guest record removed"}</span>
            </span>
            <span className="tabular-nums">{timeAgo(row.createdAt, now)}</span>
          </div>
        </div>

        <div className="px-4 pb-4 pt-1 space-y-2">
          <button
            type="button"
            className="btn-primary h-11 w-full inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
            disabled={busy}
            onClick={guard(onAcknowledge)}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Acknowledge
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn-secondary h-11 inline-flex items-center justify-center gap-1 px-2 min-w-0 disabled:opacity-60"
              disabled={busy}
              onClick={guard(onView)}
            >
              <span className="truncate">View queue</span>
              <ChevronRight className="w-4 h-4 shrink-0" />
            </button>
            <button
              type="button"
              className="btn-secondary h-11 px-2 min-w-0 truncate disabled:opacity-60"
              disabled={busy}
              aria-describedby="gr-alert-dismiss-note"
              onClick={guard(onDismiss)}
            >
              Dismiss
            </button>
          </div>
          {/* Dismissing is not acknowledging, and the copy has to say so —
              otherwise the desk thinks the guest has been taken care of. Both
              dismiss controls point at it with aria-describedby so it is not
              a sighted-only caveat. */}
          <p
            id="gr-alert-dismiss-note"
            className="text-[11px] text-textSecondary leading-snug text-center"
          >
            Dismiss just hides this alert. The request stays open in the queue
            until someone acknowledges it.
          </p>
          {remaining > 1 && (
            <button
              type="button"
              onClick={guard(onDismissAll)}
              disabled={busy}
              aria-describedby="gr-alert-dismiss-note"
              className="w-full h-11 rounded-md text-[13px] font-semibold text-textSecondary hover:text-ink hover:bg-parchment transition-colors disabled:opacity-60"
            >
              Dismiss all {remaining} alerts
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
