import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  Calendar,
  Check,
  CheckCheck,
  FileText,
  LogIn,
  LogOut,
  MessageSquare,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader } from "@/components/Loader";
import { StickyBar } from "@/components/StickyBar";
import { api } from "@/lib/api";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

interface ListResp {
  items: Notification[];
  unreadCount: number;
}

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const TYPE_META: Record<string, { icon: typeof Bell; label: string; tint: string }> = {
  reservation_created: { icon: Calendar, label: "Booking", tint: "text-brand bg-brand/10" },
  reservation_cancelled: { icon: XCircle, label: "Cancelled", tint: "text-danger bg-danger/10" },
  guest_checked_in: { icon: LogIn, label: "Check-in", tint: "text-success bg-success/10" },
  guest_checked_out: { icon: LogOut, label: "Check-out", tint: "text-[#157f5f] bg-brass/10" },
  housekeeping_assigned: { icon: Sparkles, label: "Housekeeping", tint: "text-accentBlue bg-accentBlue/10" },
  housekeeping_completed: { icon: Sparkles, label: "Housekeeping", tint: "text-success bg-success/10" },
  invoice_issued: { icon: FileText, label: "Invoice", tint: "text-brand bg-brand/10" },
  message_received: { icon: MessageSquare, label: "Message", tint: "text-accentBlue bg-accentBlue/10" },
  system: { icon: Bell, label: "System", tint: "text-textSecondary bg-bg" },
};

type FilterMode = "all" | "unread";

export default function Notifications() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FilterMode>("all");

  const q = useQuery({
    queryKey: ["notifications", "page", filter],
    queryFn: () =>
      api.get<ListResp>("/notifications", {
        ...(filter === "unread" ? { unreadOnly: "true" } : {}),
        limit: 100,
      }),
    refetchInterval: 30_000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  const markAll = useMutation({
    mutationFn: () => api.post("/notifications/read-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  if (q.isLoading) return <Loader label="Loading notifications…" />;

  const items = q.data?.items ?? [];
  const unread = q.data?.unreadCount ?? 0;

  // Group by day
  const groups = new Map<string, Notification[]>();
  for (const n of items) {
    const d = new Date(n.createdAt);
    const key =
      d.toDateString() === new Date().toDateString()
        ? "Today"
        : d.toDateString() === new Date(Date.now() - 86400000).toDateString()
          ? "Yesterday"
          : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }

  return (
    <div className="space-y-4">
      <StickyBar>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-brand-dark">Notifications</h1>
          <p className="text-sm text-textSecondary mt-0.5">
            {unread > 0 ? `${unread} unread` : "All caught up"}
          </p>
        </div>
        {unread > 0 && (
          <button
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending}
            className="btn-secondary inline-flex items-center gap-2"
          >
            <CheckCheck className="w-4 h-4" /> Mark all read
          </button>
        )}
      </div>

      <div className="inline-flex rounded-sm border border-borderc overflow-hidden text-sm bg-surface">
        {(
          [
            { v: "all", label: "All", count: items.length },
            { v: "unread", label: "Unread", count: unread },
          ] as const
        ).map((opt) => (
          <button
            key={opt.v}
            type="button"
            onClick={() => setFilter(opt.v)}
            className={`px-4 py-2 transition-colors ${
              filter === opt.v
                ? "bg-brand text-textPrimary"
                : "text-textSecondary hover:bg-bg"
            }`}
          >
            {opt.label}
            {opt.count > 0 && (
              <span
                className={`ml-2 inline-grid place-items-center min-w-[1.2rem] h-[1.2rem] px-1 rounded-full text-[10px] font-semibold ${
                  filter === opt.v ? "bg-cream/20 text-cream" : "bg-borderc text-textSecondary"
                }`}
              >
                {opt.count}
              </span>
            )}
          </button>
        ))}
      </div>
      </StickyBar>

      {items.length === 0 && (
        <div className="card flex flex-col items-center justify-center py-16 text-center text-textSecondary">
          <BellOff className="w-10 h-10 mb-3 opacity-40" />
          <div className="text-sm">
            {filter === "unread" ? "No unread notifications." : "Nothing yet."}
          </div>
        </div>
      )}

      <div className="space-y-6">
        {Array.from(groups.entries()).map(([day, list]) => (
          <section key={day}>
            <div className="text-[10px] uppercase tracking-[0.2em] text-textSecondary font-semibold mb-2">
              {day}
            </div>
            <div className="card p-0 divide-y divide-borderc/60">
              {list.map((n) => {
                const meta = TYPE_META[n.type] ?? TYPE_META.system!;
                const Icon = meta.icon;
                return (
                  <div
                    key={n.id}
                    className={`flex items-start gap-3 px-4 py-3 transition-colors ${
                      !n.readAt ? "bg-brand-soft/30" : ""
                    } ${n.href ? "cursor-pointer hover:bg-bg" : ""}`}
                    onClick={() => {
                      if (!n.readAt) markRead.mutate(n.id);
                      if (n.href) navigate(n.href);
                    }}
                  >
                    <span
                      className={`grid place-items-center w-9 h-9 rounded-md shrink-0 ${meta.tint}`}
                    >
                      <Icon className="w-4 h-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {!n.readAt && (
                          <span className="w-2 h-2 rounded-full bg-brand shrink-0" />
                        )}
                        <div className="font-semibold text-textPrimary truncate">{n.title}</div>
                        <span
                          className={`shrink-0 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold ${meta.tint}`}
                        >
                          {meta.label}
                        </span>
                      </div>
                      <div className="text-sm text-textSecondary mt-0.5">{n.body}</div>
                      <div className="text-[11px] text-textSecondary mt-1">
                        {timeAgo(n.createdAt)}
                      </div>
                    </div>
                    {!n.readAt && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          markRead.mutate(n.id);
                        }}
                        className="text-textSecondary hover:text-brand p-1.5 rounded shrink-0"
                        title="Mark as read"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
