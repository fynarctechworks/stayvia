import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldCheck, Upload } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";

interface KycStatus {
  verified: boolean;
  kycVerifiedAt: string | null;
  frontUrl: string | null;
  backUrl: string | null;
  photoUrl: string | null;
}

export function KycModal({
  guestId,
  onClose,
  onUploaded,
}: {
  guestId: string;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { data: status, refetch } = useQuery({
    queryKey: ["kyc", guestId],
    queryFn: () => api.get<KycStatus>(`/guests/${guestId}/kyc`),
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!front && !status?.frontUrl) throw new Error("Select the front photo of the ID proof");
      if (!photo && !status?.photoUrl) throw new Error("Customer photo is required");
      if (!front && !back && !photo) throw new Error("Select at least one file to upload");
      const form = new FormData();
      if (front) form.append("front", front);
      if (back) form.append("back", back);
      if (photo) form.append("photo", photo);
      return api.upload(`/guests/${guestId}/kyc`, form);
    },
    onSuccess: () => {
      refetch();
      onUploaded();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end justify-center sm:items-center z-50 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-t-2xl sm:rounded-md w-full sm:max-w-lg p-6 sm:p-7 pb-safe max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-navy mb-1 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5" /> KYC Documents
        </h2>
        <div className="text-xs text-textSecondary mb-4">
          Upload a clear photo/scan of the guest's government ID proof (Aadhaar, PAN, Passport, or Driving License). Required by Form C / Foreigners Order before check-in.
        </div>

        {status?.verified && (
          <div className="mb-3 rounded bg-success/10 border border-success/30 text-success text-sm px-3 py-2">
            Verified. Re-uploading will replace the existing documents.
          </div>
        )}

        {(status?.frontUrl || status?.backUrl || status?.photoUrl) && (
          <div className="grid grid-cols-3 gap-2 mb-3">
            {status?.photoUrl && (
              <a href={status.photoUrl} target="_blank" rel="noreferrer" className="block">
                <img src={status.photoUrl} alt="Customer photo" className="w-full h-32 object-cover border rounded" />
                <div className="text-xs text-center mt-1 text-textSecondary">Customer</div>
              </a>
            )}
            {status?.frontUrl && (
              <a href={status.frontUrl} target="_blank" rel="noreferrer" className="block">
                <img src={status.frontUrl} alt="ID front" className="w-full h-32 object-cover border rounded" />
                <div className="text-xs text-center mt-1 text-textSecondary">ID Front</div>
              </a>
            )}
            {status?.backUrl && (
              <a href={status.backUrl} target="_blank" rel="noreferrer" className="block">
                <img src={status.backUrl} alt="ID back" className="w-full h-32 object-cover border rounded" />
                <div className="text-xs text-center mt-1 text-textSecondary">ID Back</div>
              </a>
            )}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="label block mb-1">
              Customer Photo {status?.photoUrl ? "(replace)" : "(required)"}
            </label>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
              className="input"
            />
          </div>
          <div>
            <label className="label block mb-1">
              ID Front {status?.frontUrl ? "(replace)" : "(required)"}
            </label>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setFront(e.target.files?.[0] ?? null)}
              className="input"
            />
          </div>
          <div>
            <label className="label block mb-1">ID Back (optional, for Aadhaar / DL)</label>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setBack(e.target.files?.[0] ?? null)}
              className="input"
            />
          </div>
          {err && <div className="text-danger text-sm">{err}</div>}
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose}>Close</button>
            <button
              className="btn-primary inline-flex items-center gap-2"
              disabled={
                (!front && !status?.frontUrl) ||
                (!photo && !status?.photoUrl) ||
                (!front && !back && !photo) ||
                upload.isPending
              }
              onClick={() => upload.mutate()}
            >
              <Upload className="w-4 h-4" />
              {upload.isPending ? "Uploading…" : "Upload & Verify"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
