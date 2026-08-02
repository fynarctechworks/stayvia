import {
  MAINTENANCE_CATEGORY_LABELS,
  MAINTENANCE_SEVERITY_LABELS,
  MAINTENANCE_STATUS_LABELS,
  type MaintenanceCategory,
  type MaintenanceSeverity,
  type MaintenanceStatus,
} from "@stayvia/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { CheckCircle2, ChevronLeft, Send } from "@/lib/micons";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader } from "@/components/Loader";
import { api } from "@/lib/api";
import { inr } from "@/lib/utils";

interface IssueComment {
  id: string;
  body: string;
  createdAt: string;
  authorId: string;
  authorName: string;
}

interface IssueDetail {
  id: string;
  roomId: string;
  room: {
    id: string;
    roomNumber: string;
    roomType: string;
    floor: number;
  };
  category: MaintenanceCategory;
  severity: MaintenanceSeverity;
  status: MaintenanceStatus;
  title: string;
  description: string | null;
  reportedAt: string;
  reportedByName: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNotes: string | null;
  costEstimate: string | null;
  costActual: string | null;
  comments: IssueComment[];
}

// Semantic bg/fg/border triads per the Warm Concierge spec.
const STATUS_STYLES: Record<MaintenanceStatus, string> = {
  open: "bg-dangerBg text-dangerFg border-dangerBorder",
  in_progress: "bg-warnBg text-warning border-warnBorder",
  resolved: "bg-successBg text-success border-successBorder",
  cancelled: "bg-neutralBg text-inkMuted border-neutralBorder",
};

const SEVERITY_STYLES: Record<MaintenanceSeverity, string> = {
  urgent: "bg-dangerBg text-dangerFg border-dangerBorder",
  normal: "bg-warnBg text-warning border-warnBorder",
  low: "bg-neutralBg text-inkMuted border-neutralBorder",
};

export default function MaintenanceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [comment, setComment] = useState("");
  const [showResolve, setShowResolve] = useState(false);
  const [resolveNotes, setResolveNotes] = useState("");
  const [costActual, setCostActual] = useState("");

  const issueQ = useQuery({
    queryKey: ["maint-issue", id],
    queryFn: () => api.get<IssueDetail>(`/maintenance/${id}`),
    enabled: !!id,
    refetchInterval: 30_000,
  });

  const issue = issueQ.data;

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<IssueDetail>(`/maintenance/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["maint-issue", id] });
      qc.invalidateQueries({ queryKey: ["maint-room"] });
      qc.invalidateQueries({ queryKey: ["hk"] });
    },
  });

  const addComment = useMutation({
    mutationFn: (body: string) =>
      api.post(`/maintenance/${id}/comments`, { body }),
    onSuccess: () => {
      setComment("");
      qc.invalidateQueries({ queryKey: ["maint-issue", id] });
    },
  });

  if (issueQ.isLoading || !issue) return <Loader label="Loading issue…" />;

  const isClosed =
    issue.status === "resolved" || issue.status === "cancelled";

  return (
    <div className="space-y-4 w-full">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => navigate(-1)}
          className="btn-secondary !h-10 w-10 !px-0 grid place-items-center !rounded-[11px]"
          title="Back"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h1 className="text-[clamp(19px,2.6vw,24px)] font-semibold tracking-[-0.4px] text-ink">
          {issue.title}
        </h1>
        <span
          className={`text-[10px] uppercase tracking-[0.05em] font-bold px-2 py-0.5 rounded-[6px] border ${STATUS_STYLES[issue.status]}`}
        >
          {MAINTENANCE_STATUS_LABELS[issue.status]}
        </span>
        <span
          className={`text-[10px] uppercase tracking-[0.05em] font-bold px-2 py-0.5 rounded-[6px] border ${SEVERITY_STYLES[issue.severity]}`}
        >
          {MAINTENANCE_SEVERITY_LABELS[issue.severity]}
        </span>
      </div>

      {/* Single column: details → actions → updates. Stacking
          vertically keeps the action pills directly under the
          issue-info card so staff don't have to scan across to
          change status / severity / category. */}
      <div className="space-y-4">
          <div className="card space-y-3.5">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4 text-sm">
              <div>
                <div className="label">Room</div>
                <button
                  className="font-mono font-bold text-brand-deep hover:underline"
                  onClick={() => navigate(`/rooms/${issue.room.roomNumber}`)}
                >
                  {issue.room.roomNumber}
                </button>
                <span className="ml-2 text-inkMuted text-xs">
                  Floor {issue.room.floor} ·{" "}
                  {issue.room.roomType.replace(/_/g, " ")}
                </span>
              </div>
              <div>
                <div className="label">Category</div>
                <div>{MAINTENANCE_CATEGORY_LABELS[issue.category]}</div>
              </div>
              <div>
                <div className="label">Reported</div>
                <div>
                  {format(new Date(issue.reportedAt), "dd MMM yyyy · h:mm a")}
                </div>
                {issue.reportedByName && (
                  <div className="text-xs text-textSecondary">
                    by {issue.reportedByName}
                  </div>
                )}
              </div>
              {issue.resolvedAt && (
                <div>
                  <div className="label">Resolved</div>
                  <div>
                    {format(new Date(issue.resolvedAt), "dd MMM yyyy · h:mm a")}
                  </div>
                  {issue.resolvedByName && (
                    <div className="text-xs text-textSecondary">
                      by {issue.resolvedByName}
                    </div>
                  )}
                </div>
              )}
              {(issue.costEstimate || issue.costActual) && (
                <div>
                  <div className="label">Cost</div>
                  <div className="font-mono">
                    {issue.costActual
                      ? inr(issue.costActual)
                      : isClosed
                        ? inr(issue.costEstimate ?? "0")
                        : `Est. ${inr(issue.costEstimate ?? "0")}`}
                  </div>
                </div>
              )}
            </div>

            {issue.description && (
              <div className="border-t border-divider pt-3.5">
                <div className="label mb-1">Description</div>
                <div className="text-sm leading-relaxed text-ink whitespace-pre-wrap">
                  {issue.description}
                </div>
              </div>
            )}

            {issue.resolutionNotes && (
              <div className="border-t border-divider pt-3">
                <div className="label mb-1">Resolution Notes</div>
                <div className="text-sm leading-relaxed text-ink whitespace-pre-wrap bg-successBg border border-successBorder p-3 rounded-md">
                  {issue.resolutionNotes}
                </div>
              </div>
            )}
          </div>

          {/* Actions — one-way close. The Mark Closed CTA opens the
              resolution-notes modal so the audit trail captures *how*
              the issue was fixed. Once closed there's no reopen — staff
              file a new issue if the same problem recurs, which keeps
              the chronic-issue history honest. */}
          <div className="card space-y-3">
            <div className="text-[15px] font-semibold text-ink">Actions</div>
            {!isClosed ? (
              <button
                onClick={() => setShowResolve(true)}
                className="w-full sm:w-auto text-sm h-[42px] px-[18px] bg-success text-white border border-success rounded-[11px] hover:opacity-90 font-semibold inline-flex items-center justify-center gap-1.5 shadow-primary transition-opacity"
              >
                <CheckCircle2 className="w-[18px] h-[18px]" />
                Mark Closed
              </button>
            ) : (
              <div>
                <div
                  className="inline-flex items-center text-[11px] font-semibold uppercase tracking-[0.05em] px-2.5 py-1 rounded-full border bg-successBg text-success border-successBorder"
                >
                  Closed
                </div>
                <div className="text-[11px] text-textSecondary italic mt-2">
                  Closed issues are read-only. File a new issue if the same
                  problem recurs.
                </div>
              </div>
            )}
          </div>

          {/* Comments thread */}
          <div className="card space-y-3.5">
            <div className="text-[15px] font-semibold text-ink">Updates</div>
            {issue.comments.length === 0 ? (
              <div className="text-xs text-textSecondary italic">
                {isClosed
                  ? "No updates were recorded on this issue."
                  : "No updates yet. Use the box below to record progress."}
              </div>
            ) : (
              <ul className="space-y-3.5">
                {issue.comments.map((c) => (
                  <li
                    key={c.id}
                    className="border-l-2 border-brand-soft pl-3.5 py-0.5"
                  >
                    <div className="text-[11.5px] text-inkMuted">
                      <strong className="text-brand-deep">{c.authorName}</strong>
                      {" · "}
                      {format(new Date(c.createdAt), "dd MMM · h:mm a")}
                    </div>
                    <div className="text-sm leading-relaxed whitespace-pre-wrap mt-1">
                      {c.body}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {!isClosed && (
              <div className="flex gap-2 pt-3 border-t border-divider">
                <textarea
                  className="input flex-1 min-h-[60px]"
                  placeholder="Record an update - e.g. technician arrived, parts ordered…"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={2000}
                />
                <button
                  className="btn-primary !px-3 self-start inline-flex items-center gap-1.5"
                  disabled={!comment.trim() || addComment.isPending}
                  onClick={() => addComment.mutate(comment.trim())}
                >
                  <Send className="w-3.5 h-3.5" />
                  Post
                </button>
              </div>
            )}
          </div>
      </div>

      {/* Resolve modal — required resolution notes + optional actual cost */}
      {showResolve && (
        <div
          className="fixed inset-0 bg-inkDark/50 backdrop-blur-[3px] flex items-center justify-center z-50 p-4"
          onClick={() => setShowResolve(false)}
        >
          <div
            className="bg-surface rounded-2xl shadow-modal w-full max-w-md p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-ink">
              Mark issue resolved
            </h2>
            <div className="text-xs text-textSecondary">
              Record what was done so the next person (or audit) can see how
              the issue was fixed.
            </div>
            <div>
              <label className="label block mb-1">
                Resolution notes <span className="text-danger">*</span>
              </label>
              <textarea
                className="input min-h-[100px]"
                placeholder="What was the cause? What was done to fix it?"
                value={resolveNotes}
                onChange={(e) => setResolveNotes(e.target.value)}
                maxLength={2000}
              />
            </div>
            <div>
              <label className="label block mb-1">Actual cost (₹)</label>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                placeholder="Leave blank if not tracked"
                value={costActual}
                onChange={(e) => setCostActual(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                className="btn-secondary"
                onClick={() => setShowResolve(false)}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!resolveNotes.trim() || update.isPending}
                onClick={() => {
                  const body: Record<string, unknown> = {
                    status: "resolved",
                    resolutionNotes: resolveNotes.trim(),
                  };
                  if (costActual.trim()) {
                    body.costActual = Number(costActual);
                  }
                  update.mutate(body, {
                    onSuccess: () => {
                      setShowResolve(false);
                      setResolveNotes("");
                      setCostActual("");
                    },
                  });
                }}
              >
                {update.isPending ? "Saving…" : "Resolve"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
