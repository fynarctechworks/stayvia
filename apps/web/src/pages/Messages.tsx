import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, isToday, isYesterday } from "date-fns";
import { ArrowLeft, Check, CheckCheck, Loader2, MessageSquare, Search, Send, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { api } from "@/lib/api";

interface Staff {
  id: string;
  fullName: string;
  role: string;
  email: string;
}
interface Thread {
  other_id: string;
  full_name: string;
  role: string;
  last_body: string;
  last_at: string;
  unread: number;
}
interface Message {
  id: string;
  senderId: string;
  recipientId: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

// Deterministic avatar colour per person — same person always gets the
// same tint, and adjacent list entries usually differ.
const AVATAR_COLORS = [
  "bg-brand-dark text-cream",
  "bg-brass text-cream",
  "bg-accentBlue text-cream",
  "bg-success text-cream",
  "bg-navy text-cream",
];
function avatarClasses(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1]![0] : "";
  return `${first}${last ?? ""}`.toUpperCase();
}

function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span
      className={`grid place-items-center rounded-full font-semibold shrink-0 ${
        size === "sm" ? "w-8 h-8 text-[11px]" : "w-10 h-10 text-xs"
      } ${avatarClasses(name)}`}
    >
      {initials(name)}
    </span>
  );
}

// Compact relative time for the thread list ("now", "5m", "2h", "3d",
// then the date).
function shortAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return format(new Date(iso), "dd MMM");
}

function dayLabel(d: Date): string {
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "dd MMM yyyy");
}

// WhatsApp visual constants — deliberately hardcoded hexes (this pane
// mimics WhatsApp's chat surface, not the app theme): beige wallpaper,
// green outgoing bubble, white incoming, grey header/composer bars,
// blue read ticks.
const WA = {
  wallpaper: "bg-[#efeae2]",
  bar: "bg-[#f0f2f5]",
  out: "bg-[#d9fdd3]",
  in: "bg-white",
  text: "text-[#111b21]",
  subtext: "text-[#667781]",
  send: "bg-[#00a884] hover:bg-[#017561]",
  unread: "bg-[#25d366]",
  tickRead: "text-[#53bdeb]",
  tickSent: "text-[#8696a0]",
};

export default function Messages() {
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();
  const activeId = params.get("with");

  const staffQ = useQuery({
    queryKey: ["staff-list"],
    queryFn: () => api.get<{ items: Staff[] }>("/messages/staff"),
  });
  const threadsQ = useQuery({
    queryKey: ["msg-threads"],
    queryFn: () => api.get<{ items: Thread[] }>("/messages/threads"),
    refetchInterval: 15000,
  });
  const msgsQ = useQuery({
    queryKey: ["msg-thread", activeId],
    queryFn: () =>
      activeId ? api.get<{ items: Message[] }>("/messages", { with: activeId }) : Promise.resolve({ items: [] }),
    enabled: !!activeId,
    refetchInterval: activeId ? 8000 : false,
  });

  const qc = useQueryClient();
  const sendM = useMutation({
    mutationFn: (body: string) => api.post<Message>("/messages", { recipientId: activeId, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["msg-thread", activeId] });
      qc.invalidateQueries({ queryKey: ["msg-threads"] });
    },
  });

  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Hoist the message count so the dep array stays statically
  // analysable. ESLint can't follow the `?? []` inside the array,
  // and the extracted local lets the rule see exactly what changes.
  const messageCount = msgsQ.data?.items?.length ?? 0;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messageCount, activeId]);

  const q = search.trim().toLowerCase();
  const threads = (threadsQ.data?.items ?? []).filter(
    (t) => !q || t.full_name.toLowerCase().includes(q),
  );
  const staff = staffQ.data?.items ?? [];
  const threadIds = new Set((threadsQ.data?.items ?? []).map((t) => t.other_id));
  // The "start new" section only lists people you have NO thread with —
  // existing conversations already cover the rest.
  const freshStaff = staff.filter(
    (s) => !threadIds.has(s.id) && (!q || s.fullName.toLowerCase().includes(q)),
  );
  const activeStaff = staff.find((s) => s.id === activeId);
  const activeThread = (threadsQ.data?.items ?? []).find((t) => t.other_id === activeId);
  const activeName = activeStaff?.fullName ?? activeThread?.full_name ?? "Conversation";
  const activeRole = activeStaff?.role ?? activeThread?.role ?? "";
  const messages = msgsQ.data?.items ?? [];
  const totalUnread = (threadsQ.data?.items ?? []).reduce((s, t) => s + t.unread, 0);

  function send() {
    if (!draft.trim() || sendM.isPending) return;
    sendM.mutate(draft.trim(), { onSuccess: () => setDraft("") });
  }

  return (
    // Phone: ONE pane at a time — list, or the open chat (driven by the
    // ?with= param). md+: the classic two-column split.
    <div className="grid grid-cols-1 md:grid-cols-[21rem_1fr] h-[calc(100vh-9.5rem)] md:h-[calc(100vh-6.5rem)] rounded-md overflow-hidden border border-borderc shadow-[0_2px_8px_-2px_rgba(15,61,46,0.06)]">
      {/* ============ LEFT: conversation list ============ */}
      <aside
        className={`bg-white border-r border-borderc flex-col min-w-0 ${
          activeId ? "hidden md:flex" : "flex"
        }`}
      >
        <div className={`px-4 py-3 ${WA.bar} flex items-center gap-2 shrink-0`}>
          <span className="font-semibold text-[#111b21]">Chats</span>
          {totalUnread > 0 && (
            <span className={`grid place-items-center min-w-[1.2rem] h-[1.2rem] px-1 rounded-full ${WA.unread} text-white text-[10px] font-semibold`}>
              {totalUnread}
            </span>
          )}
        </div>
        <div className="px-3 py-2 border-b border-borderc/60 shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#667781]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search or start a new chat"
              className="w-full h-9 pl-9 pr-3 rounded-lg bg-[#f0f2f5] text-sm text-[#111b21] placeholder:text-[#667781] outline-none focus:ring-1 focus:ring-[#00a884]/40"
            />
          </div>
        </div>

        <div className="overflow-y-auto flex-1">
          {threads.map((t) => {
            const active = activeId === t.other_id;
            return (
              <button
                key={t.other_id}
                onClick={() => setParams({ with: t.other_id })}
                className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors ${
                  active ? "bg-[#f0f2f5]" : "hover:bg-[#f5f6f6]"
                }`}
              >
                <Avatar name={t.full_name} />
                <div className="min-w-0 flex-1 border-b border-borderc/40 pb-2.5 -mb-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[15px] text-[#111b21] truncate">{t.full_name}</span>
                    <span
                      className={`text-[11px] shrink-0 ${
                        t.unread > 0 ? "text-[#25d366] font-semibold" : "text-[#667781]"
                      }`}
                    >
                      {shortAgo(t.last_at)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span
                      className={`text-[13px] truncate ${
                        t.unread > 0 ? "text-[#111b21] font-medium" : "text-[#667781]"
                      }`}
                    >
                      {t.last_body}
                    </span>
                    {t.unread > 0 && (
                      <span className={`grid place-items-center min-w-[1.25rem] h-[1.25rem] px-1 rounded-full ${WA.unread} text-white text-[11px] font-semibold shrink-0`}>
                        {t.unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
          {threads.length === 0 && q === "" && (
            <div className="px-4 py-10 text-center text-[#667781]">
              <MessageSquare className="w-7 h-7 mx-auto mb-2 opacity-30" />
              <div className="text-xs leading-relaxed">
                No conversations yet.
                <br />
                Pick a teammate below to start one.
              </div>
            </div>
          )}

          {freshStaff.length > 0 && (
            <div className="mt-1">
              <div className="px-4 pt-2.5 pb-1 text-[11px] uppercase tracking-[0.12em] text-[#667781] font-semibold flex items-center gap-1.5">
                <Users className="w-3 h-3" /> Start a conversation
              </div>
              {freshStaff.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setParams({ with: s.id })}
                  className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors ${
                    activeId === s.id ? "bg-[#f0f2f5]" : "hover:bg-[#f5f6f6]"
                  }`}
                >
                  <Avatar name={s.fullName} size="sm" />
                  <span className="text-sm text-[#111b21] truncate flex-1">{s.fullName}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#f0f2f5] text-[#667781] capitalize shrink-0">
                    {s.role}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ============ RIGHT: chat ============ */}
      <section
        className={`flex-col min-w-0 overflow-hidden ${
          activeId ? "flex" : "hidden md:flex"
        }`}
      >
        {!activeId && (
          <div className="flex-1 grid place-items-center bg-[#f8fafa] border-b-[6px] border-[#00a884]">
            <div className="text-center text-[#667781] px-8">
              <span className="grid place-items-center w-20 h-20 rounded-full bg-[#f0f2f5] mx-auto mb-4">
                <MessageSquare className="w-9 h-9 opacity-50" />
              </span>
              <div className="text-xl font-light text-[#41525d]">HotelDesk Chat</div>
              <div className="text-sm mt-2">
                Pick a conversation or a teammate to start chatting.
              </div>
            </div>
          </div>
        )}
        {activeId && (
          <>
            <div className={`px-4 py-2.5 ${WA.bar} flex items-center gap-3 shrink-0 border-b border-borderc/60`}>
              {/* Back to the conversation list (phone only). */}
              <button
                onClick={() => setParams({})}
                className="md:hidden -ml-1 p-1 rounded text-[#54656f] hover:bg-black/5"
                aria-label="Back to chats"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <Avatar name={activeName} />
              <div className="min-w-0">
                <div className="font-medium text-[#111b21] leading-tight truncate">{activeName}</div>
                {activeRole && (
                  <div className="text-xs text-[#667781] capitalize">{activeRole}</div>
                )}
              </div>
            </div>

            {/* Wallpaper: WhatsApp beige + a faint dot grid so it reads
                as the familiar doodle texture without shipping an image. */}
            <div
              ref={scrollRef}
              className={`flex-1 overflow-y-auto px-[8%] py-3 ${WA.wallpaper}`}
              style={{
                backgroundImage:
                  "radial-gradient(rgba(0,0,0,0.035) 1px, transparent 1.2px)",
                backgroundSize: "22px 22px",
              }}
            >
              {msgsQ.isLoading && (
                <div className="text-center text-[#667781] text-sm py-6">
                  <Loader2 className="inline w-4 h-4 animate-spin" />
                </div>
              )}
              {messages.map((m, i) => {
                const mine = m.senderId === profile?.id;
                const d = new Date(m.createdAt);
                const prev = messages[i - 1];
                const newDay = !prev || new Date(prev.createdAt).toDateString() !== d.toDateString();
                // WhatsApp puts the bubble tail on the FIRST message of a
                // sender's run; follow-ups are plain rounded bubbles.
                const firstOfRun = newDay || prev?.senderId !== m.senderId;
                return (
                  <div key={m.id}>
                    {newDay && (
                      <div className="flex justify-center my-3">
                        <span className="px-3 py-1 rounded-lg bg-white/95 shadow-sm text-[11px] font-medium text-[#54656f] uppercase tracking-wide">
                          {dayLabel(d)}
                        </span>
                      </div>
                    )}
                    <div
                      className={`flex ${mine ? "justify-end" : "justify-start"} ${
                        firstOfRun ? "mt-2.5" : "mt-[3px]"
                      }`}
                    >
                      <div
                        className={`relative max-w-[65%] px-2.5 py-1.5 text-[14.2px] leading-snug shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] ${WA.text} ${
                          mine
                            ? `${WA.out} rounded-lg ${firstOfRun ? "rounded-tr-none" : ""}`
                            : `${WA.in} rounded-lg ${firstOfRun ? "rounded-tl-none" : ""}`
                        }`}
                      >
                        {/* Bubble tail — only on the first bubble of a run. */}
                        {firstOfRun && (
                          <span
                            aria-hidden
                            className={`absolute top-0 w-0 h-0 border-t-[10px] ${
                              mine
                                ? "-right-2 border-t-[#d9fdd3] border-r-[10px] border-r-transparent"
                                : "-left-2 border-t-white border-l-[10px] border-l-transparent"
                            }`}
                          />
                        )}
                        <span className="whitespace-pre-wrap break-words">{m.body}</span>
                        {/* Timestamp + ticks float bottom-right like WhatsApp;
                            the spacer span reserves room so text never sits
                            under them. */}
                        <span className="inline-block w-16" />
                        <span className={`absolute bottom-1 right-2 flex items-center gap-0.5 text-[11px] ${WA.subtext}`}>
                          {format(d, "h:mm a").toLowerCase()}
                          {mine &&
                            (m.readAt ? (
                              <CheckCheck className={`w-4 h-4 ${WA.tickRead}`} />
                            ) : (
                              <Check className={`w-4 h-4 ${WA.tickSent}`} />
                            ))}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {!msgsQ.isLoading && messages.length === 0 && (
                <div className="grid place-items-center h-full text-center">
                  <span className="px-4 py-2 rounded-lg bg-[#ffeecd] shadow-sm text-[12.5px] text-[#54656f]">
                    No messages yet — say hello to {activeName.split(" ")[0]} 👋
                  </span>
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className={`${WA.bar} px-4 py-2.5 flex items-center gap-3 shrink-0`}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="flex-1 h-10 px-4 rounded-lg bg-white text-[15px] text-[#111b21] placeholder:text-[#667781] outline-none"
                placeholder="Type a message"
                autoFocus
              />
              <button
                type="submit"
                className={`grid place-items-center w-10 h-10 rounded-full ${WA.send} text-white transition-colors disabled:opacity-40 shrink-0`}
                disabled={!draft.trim() || sendM.isPending}
                aria-label="Send"
              >
                {sendM.isPending ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5 -ml-0.5" />
                )}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
