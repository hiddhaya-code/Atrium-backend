"use client";

import { useEffect, useState, useCallback } from "react";
import {
  X,
  Link2,
  Trash2,
  Check,
  Plus,
  Vote,
  Lock,
  Upload,
  ExternalLink,
  Image as ImageIcon,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  ShieldCheck,
  Clock,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { CommentsSection } from "@/components/comments-section";
import { LabelBadge } from "@/components/label-badge";
import { Avatar } from "@/components/avatar";
import { ColorPatchGrid, PRESET_COLORS } from "@/components/color-patch-grid";
import { TASK_STATUS_OPTIONS } from "@/lib/task-status";
import { ManualEntryModal } from "@/components/manual-entry-modal";
import { invalidate } from "@/lib/cached";

export interface TaskSubmissionRecord {
  id: string;
  notes?: string | null;
  previewUrl?: string | null;
  attachments?: { fileId?: string; filename: string; url?: string; storageKey?: string }[];
  createdAt: string;
  verifiedAt?: string | null;
  verifiedById?: string | null;
  adminFeedback?: string | null;
  isVerified: boolean;
  submittedBy?: { id: string; name: string; image?: string | null };
}

export interface TaskRevisionRecord {
  id: string;
  revisionNumber: number;
  clientFeedback: string;
  adminNotes?: string | null;
  status: string;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface TaskDetailRecord {
  id: string;
  title: string;
  description?: string | null;
  dueDate?: string | null;
  status: string;
  type: string;
  requestedById?: string | null;
  assigneeId?: string | null;
  requester?: { id: string; name: string; image?: string | null } | null;
  assignee?: { id: string; name: string; image?: string | null } | null;
  isClientRequest?: boolean;
  labels?: { label: { id: string; name: string; color: string } }[];
  createdAt?: string;
  question?: string;
  closedAt?: string | null;
  options?: { id: string; label: string; order: number; _count: { votes: number } }[];
  votes?: { optionId: string }[];
  _count?: { comments: number; votes?: number };
  verificationStatus?: string;
  clientReviewStatus?: string;
  revisionCount?: number;
  submissions?: TaskSubmissionRecord[];
  revisions?: TaskRevisionRecord[];
}

export interface TaskDetailMember {
  userId: string;
  user: { id: string; name: string; image?: string | null };
}

export interface TaskDetailLabel {
  id: string;
  name: string;
  color: string;
}

export type TaskDetailViewer = "agency" | "client";

const STATUS_OPTIONS = TASK_STATUS_OPTIONS;

export function TaskDetailModal({
  task,
  viewer,
  projectId,
  currentUserId,
  members,
  labels,
  onClose,
  onChange,
  onDelete,
}: {
  task: TaskDetailRecord;
  viewer: TaskDetailViewer;
  /** When set (agency only), marking the task done prompts to log time. */
  projectId?: string;
  currentUserId?: string | null;
  members?: TaskDetailMember[];
  labels?: TaskDetailLabel[];
  onClose: () => void;
  /** Called after a successful mutation so the caller can refresh its list. */
  onChange: () => void;
  /** Called after a successful delete. Caller should close + refresh. */
  onDelete?: () => void;
}) {
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const isAgency = viewer === "agency";
  const isOwnRequest =
    !!currentUserId && task.requestedById === currentUserId;
  const canCancel = !isAgency && isOwnRequest && task.status === "open";

  const [title, setTitle] = useState(task.title);
  const [titleEditing, setTitleEditing] = useState(false);
  const [description, setDescription] = useState(task.description ?? "");
  const [descEditing, setDescEditing] = useState(false);
  const [dueDate, setDueDate] = useState(task.dueDate ? task.dueDate.split("T")[0] : "");
  const [dueEditing, setDueEditing] = useState(false);
  const [status, setStatus] = useState(task.status);
  const [logTimeOpen, setLogTimeOpen] = useState(false);
  const [assigneeId, setAssigneeId] = useState(task.assigneeId ?? "");
  const [assignedLabels, setAssignedLabels] = useState<string[]>(
    task.labels?.map((l) => l.label.id) ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState<string>(PRESET_COLORS[0].hex);
  const [savingLabel, setSavingLabel] = useState(false);
  const [labelError, setLabelError] = useState("");

  // Workflow states
  const [submitNotes, setSubmitNotes] = useState("");
  const [submitPreviewUrl, setSubmitPreviewUrl] = useState("");
  const [submitAttachments, setSubmitAttachments] = useState<{ filename: string; url: string; fileId?: string }[]>([]);
  const [showSubmitForm, setShowSubmitForm] = useState(false);
  const [submittingWork, setSubmittingWork] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);

  const [verifyFeedback, setVerifyFeedback] = useState("");
  const [verifying, setVerifying] = useState(false);

  const [clientFeedback, setClientFeedback] = useState("");
  const [clientReviewing, setClientReviewing] = useState(false);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !projectId) return;
    setUploadingFile(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await apiFetch<{ id: string; filename: string; url?: string }>(`/files/upload?projectId=${projectId}`, {
        method: "POST",
        body: formData,
      });
      setSubmitAttachments((prev) => [
        ...prev,
        { fileId: res.id, filename: res.filename, url: res.url || `/files/${res.id}/download` },
      ]);
      success("Screenshot attached");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to upload screenshot");
    } finally {
      setUploadingFile(false);
      e.target.value = "";
    }
  };

  const handleSubmitWork = async () => {
    setSubmittingWork(true);
    try {
      await apiFetch(`/tasks/${task.id}/submit-work`, {
        method: "POST",
        body: JSON.stringify({
          notes: submitNotes,
          previewUrl: submitPreviewUrl,
          attachments: submitAttachments,
        }),
      });
      success("Work submitted for verification!");
      setShowSubmitForm(false);
      setSubmitNotes("");
      setSubmitPreviewUrl("");
      setSubmitAttachments([]);
      onChange();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmittingWork(false);
    }
  };

  const handleVerifyWork = async (approved: boolean) => {
    setVerifying(true);
    try {
      await apiFetch(`/tasks/${task.id}/verify`, {
        method: "POST",
        body: JSON.stringify({
          approved,
          feedback: verifyFeedback,
        }),
      });
      success(approved ? "Work verified and sent to client!" : "Work returned with feedback");
      setVerifyFeedback("");
      onChange();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Verification action failed");
    } finally {
      setVerifying(false);
    }
  };

  const handleClientReview = async (action: "approve" | "request_changes") => {
    setClientReviewing(true);
    try {
      await apiFetch(`/tasks/${task.id}/client-review`, {
        method: "POST",
        body: JSON.stringify({
          action,
          feedback: clientFeedback,
        }),
      });
      success(action === "approve" ? "Task approved!" : "Change request submitted");
      setClientFeedback("");
      onChange();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Review submission failed");
    } finally {
      setClientReviewing(false);
    }
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (logTimeOpen) {
        setLogTimeOpen(false);
        return;
      }
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, logTimeOpen]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setSaving(true);
      try {
        await apiFetch(`/tasks/${task.id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        onChange();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Update failed");
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [task.id, onChange, showError],
  );

  const handleSaveTitle = async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === task.title) {
      setTitle(task.title);
      setTitleEditing(false);
      return;
    }
    try {
      await patch({ title: trimmed });
      setTitleEditing(false);
    } catch {
      setTitle(task.title);
    }
  };

  const handleSaveDescription = async () => {
    if (description === (task.description ?? "")) {
      setDescEditing(false);
      return;
    }
    try {
      await patch({ description: description || null });
      setDescEditing(false);
    } catch {
      setDescription(task.description ?? "");
    }
  };

  const handleSaveDueDate = async () => {
    const normalized = task.dueDate ? task.dueDate.split("T")[0] : "";
    if (dueDate === normalized) {
      setDueEditing(false);
      return;
    }
    try {
      await patch({ dueDate: dueDate || null });
      setDueEditing(false);
    } catch {
      setDueDate(normalized);
    }
  };

  const handleStatusChange = async (next: string) => {
    if (next === status) return;
    const prev = status;
    setStatus(next);
    try {
      await patch({ status: next });
    } catch {
      setStatus(prev);
      return;
    }
    if (isAgency && projectId && next === "done" && prev !== "done") {
      await promptLogTime();
    }
  };

  // Offer to log time for a just-completed task, unless a timer is already
  // running on it (that timer will capture the time when stopped).
  const promptLogTime = async (): Promise<void> => {
    try {
      const running = await apiFetch<{ taskId: string | null } | null>("/time-entries/running");
      if (running?.taskId === task.id) return;
    } catch (err) {
      console.error(err);
    }
    setLogTimeOpen(true);
  };

  const handleAssigneeChange = async (next: string) => {
    if (next === assigneeId) return;
    const prev = assigneeId;
    setAssigneeId(next);
    try {
      await patch({ assigneeId: next || null });
    } catch {
      setAssigneeId(prev);
    }
  };

  const handleToggleLabel = async (labelId: string) => {
    const isAssigned = assignedLabels.includes(labelId);
    const nextIds = isAssigned
      ? assignedLabels.filter((id) => id !== labelId)
      : [...assignedLabels, labelId];
    const previous = assignedLabels;
    setAssignedLabels(nextIds);
    try {
      await apiFetch(`/labels/${labelId}/assign`, {
        method: isAssigned ? "DELETE" : "POST",
        body: JSON.stringify({ entityType: "task", entityId: task.id }),
      });
      onChange();
    } catch (err) {
      setAssignedLabels(previous);
      showError(err instanceof Error ? err.message : "Failed to update labels");
    }
  };

  const handleCreateLabel = async () => {
    if (!newLabelName.trim() || savingLabel) return;
    setSavingLabel(true);
    setLabelError("");
    try {
      const created = await apiFetch<TaskDetailLabel>("/labels", {
        method: "POST",
        body: JSON.stringify({ name: newLabelName.trim(), color: newLabelColor }),
      });
      invalidate("/labels");
      await handleToggleLabel(created.id);
      setNewLabelName("");
      setNewLabelColor(PRESET_COLORS[0].hex);
      setCreatingLabel(false);
    } catch (err) {
      setLabelError(err instanceof Error ? err.message : "Failed to create label");
    } finally {
      setSavingLabel(false);
    }
  };

  const handleCopyLink = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("task", task.id);
    if (await copyToClipboard(url.toString())) {
      success("Link copied");
    } else {
      showError("Could not copy link");
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: "Delete Task",
      message: "Delete this task? This cannot be undone.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/tasks/${task.id}`, { method: "DELETE" });
      success("Task deleted");
      onDelete?.();
      onClose();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to delete task");
    }
  };

  const handleCancelClient = async () => {
    const ok = await confirm({
      title: "Cancel Request",
      message: "Cancel this request? You won't be able to undo this.",
      confirmLabel: "Cancel Request",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/tasks/${task.id}/cancel`, { method: "PATCH" });
      success("Request cancelled");
      onChange();
      onClose();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to cancel");
    }
  };

  const isDecision = task.type === "decision";
  const decisionClosed = !!task.closedAt;
  const currentVoteOptionId = task.votes?.[0]?.optionId ?? null;
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(currentVoteOptionId);
  const [voting, setVoting] = useState(false);

  const handleVote = async () => {
    if (!selectedOptionId || decisionClosed || voting) return;
    setVoting(true);
    try {
      await apiFetch(`/tasks/${task.id}/vote`, {
        method: "POST",
        body: JSON.stringify({ optionId: selectedOptionId }),
      });
      success("Vote recorded");
      onChange();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to vote");
    } finally {
      setVoting(false);
    }
  };

  const handleCloseVoting = async () => {
    if (decisionClosed) return;
    const ok = await confirm({
      title: "Close Voting",
      message: "Close voting on this decision? No further votes can be cast.",
      confirmLabel: "Close Voting",
    });
    if (!ok) return;
    try {
      await apiFetch(`/tasks/${task.id}/close`, { method: "POST" });
      success("Voting closed");
      onChange();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to close voting");
    }
  };

  const statusOption = STATUS_OPTIONS.find((s) => s.value === status) ?? STATUS_OPTIONS[0];
  const assignedLabelObjects = labels?.filter((l) => assignedLabels.includes(l.id)) ?? [];
  const readOnlyLabels = !isAgency;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="task-detail-modal"
    >
      <div className="bg-[var(--background)] rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusOption.color}`}
          >
            {statusOption.label}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={handleCopyLink}
              className="p-1.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded transition-colors"
              title="Copy link"
              aria-label="Copy link"
            >
              <Link2 size={16} />
            </button>
            {isAgency && (
              <button
                onClick={handleDelete}
                className="p-1.5 text-[var(--muted-foreground)] hover:text-red-500 rounded transition-colors"
                title="Delete"
                aria-label="Delete task"
              >
                <Trash2 size={16} />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded transition-colors"
              title="Close"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_240px] gap-0 md:gap-0">
            {/* Main column */}
            <div className="p-5 space-y-4 min-w-0">
              {/* Title */}
              {isAgency && titleEditing ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveTitle();
                      if (e.key === "Escape") {
                        setTitle(task.title);
                        setTitleEditing(false);
                      }
                    }}
                    autoFocus
                    maxLength={255}
                    className="flex-1 px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-lg font-semibold outline-none focus:ring-1 focus:ring-[var(--primary)]"
                  />
                  <button
                    onClick={handleSaveTitle}
                    disabled={saving}
                    className="px-3 py-2 text-sm text-[var(--primary)] hover:underline"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <h2
                  onClick={() => isAgency && setTitleEditing(true)}
                  className={`text-lg font-semibold break-words ${
                    isAgency
                      ? "cursor-text hover:bg-[var(--muted)]/50 rounded px-1 -mx-1"
                      : ""
                  }`}
                  data-testid="task-title"
                >
                  {task.title}
                </h2>
              )}

              {/* Description */}
              {isAgency && descEditing ? (
                <div className="space-y-2">
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setDescription(task.description ?? "");
                        setDescEditing(false);
                      }
                    }}
                    autoFocus
                    rows={4}
                    maxLength={5000}
                    placeholder="Add a description..."
                    className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm resize-y outline-none focus:ring-1 focus:ring-[var(--primary)]"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleSaveDescription}
                      disabled={saving}
                      className="px-3 py-1.5 bg-[var(--primary)] text-white rounded-lg text-sm hover:opacity-90 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setDescription(task.description ?? "");
                        setDescEditing(false);
                      }}
                      className="px-3 py-1.5 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : description ? (
                <p
                  onClick={() => isAgency && setDescEditing(true)}
                  className={`text-sm whitespace-pre-wrap break-words text-[var(--foreground)] ${
                    isAgency
                      ? "cursor-text hover:bg-[var(--muted)]/50 rounded px-1 -mx-1"
                      : ""
                  }`}
                  data-testid="task-description"
                >
                  {description}
                </p>
              ) : isAgency ? (
                <button
                  onClick={() => setDescEditing(true)}
                  className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] italic"
                >
                  Add a description...
                </button>
              ) : null}

              {/* Decision voting */}
              {isDecision && task.options && task.options.length > 0 && (() => {
                const totalVotes = task.options.reduce((s, o) => s + o._count.votes, 0);
                const hasResults = totalVotes > 0;
                return (
                  <div className="pt-2 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)] flex items-center gap-1.5">
                        <Vote size={12} />
                        Decision
                      </h3>
                      {decisionClosed ? (
                        <span className="text-xs px-2 py-0.5 bg-[var(--muted)] rounded-full text-[var(--muted-foreground)] flex items-center gap-1">
                          <Lock size={10} />
                          Closed
                        </span>
                      ) : isAgency ? (
                        <button
                          onClick={handleCloseVoting}
                          className="flex items-center gap-1 px-2 py-1 text-xs border border-[var(--border)] rounded-lg hover:bg-[var(--muted)]"
                        >
                          <Lock size={10} />
                          Close Voting
                        </button>
                      ) : null}
                    </div>
                    <div className="space-y-1.5">
                      {task.options.map((opt) => {
                        const pct = totalVotes > 0 ? (opt._count.votes / totalVotes) * 100 : 0;
                        const isSelected = selectedOptionId === opt.id;
                        const canVote = !isAgency && !decisionClosed;
                        return (
                          <label
                            key={opt.id}
                            className={`relative flex items-center gap-3 p-2 rounded-lg border transition-colors ${
                              isSelected ? "border-[var(--primary)]" : "border-[var(--border)]"
                            } ${canVote ? "cursor-pointer hover:bg-[var(--muted)]/40" : "cursor-default"} ${decisionClosed && !isSelected ? "opacity-60" : ""}`}
                          >
                            {hasResults && (
                              <div
                                className="absolute inset-0 rounded-lg bg-[var(--primary)] opacity-10 pointer-events-none"
                                style={{ width: `${pct}%` }}
                              />
                            )}
                            {canVote && (
                              <input
                                type="radio"
                                name={`vote-${task.id}`}
                                value={opt.id}
                                checked={isSelected}
                                onChange={() => setSelectedOptionId(opt.id)}
                                className="accent-[var(--primary)] relative z-10"
                              />
                            )}
                            <span className="text-sm flex-1 relative z-10">{opt.label}</span>
                            {hasResults && (
                              <span className="text-xs text-[var(--muted-foreground)] relative z-10">
                                {opt._count.votes} ({Math.round(pct)}%)
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                    {!isAgency && !decisionClosed && (
                      <div className="flex justify-end">
                        <button
                          onClick={handleVote}
                          disabled={!selectedOptionId || voting || selectedOptionId === currentVoteOptionId}
                          className="px-4 py-1.5 text-sm rounded-lg bg-[var(--primary)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
                        >
                          {currentVoteOptionId ? "Change Vote" : "Vote"}
                        </button>
                      </div>
                    )}
                    {hasResults && (
                      <p className="text-xs text-[var(--muted-foreground)]">
                        {totalVotes} total vote{totalVotes !== 1 ? "s" : ""}
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* ─── Agency Workflow: QA Verification Banner (Admin View) ─── */}
              {isAgency && task.status === "submitted_for_verification" && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-medium text-sm">
                    <ShieldCheck size={18} />
                    <span>QA Verification Required</span>
                  </div>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Work has been submitted by the developer. Please inspect the preview link and screenshots below before releasing to the client.
                  </p>
                  <div>
                    <textarea
                      value={verifyFeedback}
                      onChange={(e) => setVerifyFeedback(e.target.value)}
                      placeholder="Add verification notes or feedback for the developer..."
                      rows={2}
                      className="w-full text-xs p-2 border border-[var(--border)] rounded-lg bg-[var(--background)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleVerifyWork(true)}
                      disabled={verifying}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                    >
                      <CheckCircle2 size={14} />
                      {verifying ? "Approving..." : "Verify & Send to Client"}
                    </button>
                    <button
                      onClick={() => handleVerifyWork(false)}
                      disabled={verifying}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-rose-300 text-rose-700 dark:text-rose-300 rounded-lg text-xs font-medium hover:bg-rose-50 dark:hover:bg-rose-950/20 disabled:opacity-50 transition-colors"
                    >
                      <RotateCcw size={14} />
                      {verifying ? "Processing..." : "Reject & Request Fixes"}
                    </button>
                  </div>
                </div>
              )}

              {/* ─── Agency Workflow: Client Review Banner (Client View) ─── */}
              {!isAgency && task.status === "in_client_review" && (
                <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-purple-700 dark:text-purple-300 font-medium text-sm">
                    <CheckCircle2 size={18} />
                    <span>Work Ready for Your Approval</span>
                  </div>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    The team has verified this task. Please review the submitted demo and screenshots below, then approve or request changes.
                  </p>
                  <div>
                    <textarea
                      value={clientFeedback}
                      onChange={(e) => setClientFeedback(e.target.value)}
                      placeholder="Provide revision notes or feedback if requesting changes..."
                      rows={2}
                      className="w-full text-xs p-2 border border-[var(--border)] rounded-lg bg-[var(--background)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleClientReview("approve")}
                      disabled={clientReviewing}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                    >
                      <Check size={14} />
                      {clientReviewing ? "Approving..." : "Approve Work"}
                    </button>
                    <button
                      onClick={() => handleClientReview("request_changes")}
                      disabled={clientReviewing}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-orange-300 text-orange-700 dark:text-orange-300 rounded-lg text-xs font-medium hover:bg-orange-50 dark:hover:bg-orange-950/20 disabled:opacity-50 transition-colors"
                    >
                      <RotateCcw size={14} />
                      {clientReviewing ? "Submitting..." : "Request Changes"}
                    </button>
                  </div>
                </div>
              )}

              {/* ─── Agency Workflow: Work Submission Form (Developer / Agency) ─── */}
              {isAgency &&
                (task.status === "open" ||
                  task.status === "in_progress" ||
                  task.status === "revision_requested") && (
                  <div className="rounded-xl border border-[var(--border)] p-4 space-y-3 bg-[var(--muted)]/20">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-medium text-sm">
                        <Upload size={16} className="text-[var(--primary)]" />
                        <span>Submit Work for QA Verification</span>
                      </div>
                      <button
                        onClick={() => setShowSubmitForm((v) => !v)}
                        className="text-xs text-[var(--primary)] font-medium hover:underline"
                      >
                        {showSubmitForm ? "Cancel" : "Open Form"}
                      </button>
                    </div>

                    {showSubmitForm && (
                      <div className="space-y-3 pt-2">
                        <div>
                          <label className="block text-xs font-medium text-[var(--muted-foreground)] mb-1">
                            Live Preview or Demo Staging URL
                          </label>
                          <input
                            type="url"
                            value={submitPreviewUrl}
                            onChange={(e) => setSubmitPreviewUrl(e.target.value)}
                            placeholder="https://staging.agency.com/feature"
                            className="w-full text-xs px-3 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-[var(--muted-foreground)] mb-1">
                            Completion Notes & Summary of Work
                          </label>
                          <textarea
                            value={submitNotes}
                            onChange={(e) => setSubmitNotes(e.target.value)}
                            placeholder="Explain what was implemented or resolved..."
                            rows={3}
                            className="w-full text-xs p-2 border border-[var(--border)] rounded-lg bg-[var(--background)]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-[var(--muted-foreground)] mb-1">
                            Attach Screenshots / Proof of Work
                          </label>
                          <div className="flex items-center gap-2">
                            <label className="cursor-pointer flex items-center gap-1.5 px-3 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] text-xs font-medium hover:bg-[var(--muted)]">
                              <ImageIcon size={14} />
                              <span>{uploadingFile ? "Uploading..." : "Upload Screenshot"}</span>
                              <input
                                type="file"
                                accept="image/*,.pdf"
                                onChange={handleFileUpload}
                                disabled={uploadingFile}
                                className="hidden"
                              />
                            </label>
                          </div>
                          {submitAttachments.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-2">
                              {submitAttachments.map((att, i) => (
                                <div
                                  key={i}
                                  className="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-[var(--muted)] border border-[var(--border)]"
                                >
                                  <ImageIcon size={12} />
                                  <span className="truncate max-w-[150px]">{att.filename}</span>
                                  <button
                                    onClick={() =>
                                      setSubmitAttachments((prev) => prev.filter((_, idx) => idx !== i))
                                    }
                                    className="text-[var(--muted-foreground)] hover:text-red-500"
                                  >
                                    <X size={12} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="pt-2">
                          <button
                            onClick={handleSubmitWork}
                            disabled={submittingWork || uploadingFile}
                            className="flex items-center gap-1.5 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
                          >
                            <ShieldCheck size={14} />
                            {submittingWork ? "Submitting..." : "Submit to Admin QA"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

              {/* ─── Agency Workflow: Submissions & Screenshots Gallery ─── */}
              {task.submissions && task.submissions.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                    Work Submissions & Screenshots ({task.submissions.length})
                  </h3>
                  <div className="space-y-2">
                    {task.submissions.map((sub) => (
                      <div
                        key={sub.id}
                        className="rounded-lg border border-[var(--border)] p-3 text-xs space-y-2 bg-[var(--card)]"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {sub.submittedBy && (
                              <Avatar
                                name={sub.submittedBy.name}
                                image={sub.submittedBy.image}
                                size={18}
                              />
                            )}
                            <span className="font-medium">{sub.submittedBy?.name ?? "Developer"}</span>
                            <span className="text-[var(--muted-foreground)]">
                              {new Date(sub.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                          <div>
                            {sub.isVerified ? (
                              <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 font-medium text-[11px]">
                                Verified by Admin
                              </span>
                            ) : sub.adminFeedback ? (
                              <span className="px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-700 dark:text-rose-300 font-medium text-[11px]">
                                Returned with Fixes
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300 font-medium text-[11px]">
                                Awaiting QA
                              </span>
                            )}
                          </div>
                        </div>

                        {sub.previewUrl && (
                          <div className="flex items-center gap-1.5 text-[var(--primary)]">
                            <ExternalLink size={13} />
                            <a
                              href={sub.previewUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium hover:underline truncate"
                            >
                              {sub.previewUrl}
                            </a>
                          </div>
                        )}

                        {sub.notes && <p className="text-[var(--foreground)] whitespace-pre-wrap">{sub.notes}</p>}

                        {sub.adminFeedback && (
                          <div className="p-2 rounded bg-rose-50 dark:bg-rose-950/20 border border-rose-200 text-rose-800 dark:text-rose-200">
                            <span className="font-semibold">Admin feedback: </span>
                            {sub.adminFeedback}
                          </div>
                        )}

                        {sub.attachments && Array.isArray(sub.attachments) && sub.attachments.length > 0 && (
                          <div className="space-y-1.5 pt-1">
                            <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
                              Screenshots & Assets:
                            </span>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                              {sub.attachments.map((att, attIdx) => (
                                <a
                                  key={attIdx}
                                  href={att.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="group relative block overflow-hidden rounded border border-[var(--border)] bg-[var(--muted)] aspect-video hover:opacity-90 transition-opacity"
                                >
                                  {att.url &&
                                  (att.filename.match(/\.(png|jpg|jpeg|webp|gif)$/i) ||
                                    att.url.startsWith("data:image")) ? (
                                    <img
                                      src={att.url}
                                      alt={att.filename}
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <div className="flex h-full items-center justify-center p-2 text-center text-[11px]">
                                      {att.filename}
                                    </div>
                                  )}
                                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white text-[11px] font-medium transition-opacity">
                                    View Full
                                  </div>
                                </a>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ─── Agency Workflow: Revisions History ─── */}
              {task.revisions && task.revisions.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                    Revision Requests ({task.revisions.length})
                  </h3>
                  <div className="space-y-1.5">
                    {task.revisions.map((rev) => (
                      <div
                        key={rev.id}
                        className="rounded border border-orange-500/20 bg-orange-500/5 p-2.5 text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between text-orange-700 dark:text-orange-300 font-medium">
                          <span>Revision #{rev.revisionNumber}</span>
                          <span className="text-[11px] text-[var(--muted-foreground)]">
                            {new Date(rev.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        <p className="text-[var(--foreground)]">{rev.clientFeedback}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Comments */}
              <div className="pt-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)] mb-2">
                  Comments
                </h3>
                <CommentsSection
                  targetType="task"
                  targetId={task.id}
                  commentCount={task._count?.comments ?? 0}
                  alwaysExpanded
                />
              </div>
            </div>

            {/* Sidebar */}
            <aside className="border-t md:border-t-0 md:border-l border-[var(--border)] p-5 space-y-4 bg-[var(--muted)]/30 text-sm">
              {/* Status */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)] mb-1">
                  Status
                </label>
                {isAgency ? (
                  <select
                    value={status}
                    onChange={(e) => handleStatusChange(e.target.value)}
                    disabled={saving}
                    className="w-full px-2 py-1.5 border border-[var(--border)] rounded bg-[var(--background)] text-sm cursor-pointer"
                    data-testid="task-status-select"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${statusOption.color}`}>
                    {statusOption.label}
                  </span>
                )}
              </div>

              {/* Assignee */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)] mb-1">
                  Assignee
                </label>
                {isAgency && members ? (
                  <select
                    value={assigneeId}
                    onChange={(e) => handleAssigneeChange(e.target.value)}
                    disabled={saving}
                    className="w-full px-2 py-1.5 border border-[var(--border)] rounded bg-[var(--background)] text-sm cursor-pointer"
                    data-testid="task-assignee-select"
                  >
                    <option value="">Unassigned</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.user.name}
                      </option>
                    ))}
                  </select>
                ) : task.assignee ? (
                  <div className="flex items-center gap-2">
                    <Avatar name={task.assignee.name} image={task.assignee.image} size={20} />
                    <span>{task.assignee.name}</span>
                  </div>
                ) : (
                  <span className="text-[var(--muted-foreground)]">Unassigned</span>
                )}
              </div>

              {/* Due date */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)] mb-1">
                  Due date
                </label>
                {isAgency && dueEditing ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="date"
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                      autoFocus
                      className="flex-1 min-w-0 px-2 py-1 border border-[var(--border)] rounded bg-[var(--background)] text-sm"
                    />
                    <button
                      onClick={handleSaveDueDate}
                      disabled={saving}
                      className="p-1 text-[var(--primary)]"
                      aria-label="Save"
                    >
                      <Check size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setDueDate(task.dueDate ? task.dueDate.split("T")[0] : "");
                        setDueEditing(false);
                      }}
                      className="p-1 text-[var(--muted-foreground)]"
                      aria-label="Cancel"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => isAgency && setDueEditing(true)}
                    disabled={!isAgency}
                    className={`text-sm ${
                      isAgency ? "hover:text-[var(--foreground)]" : "cursor-default"
                    } ${dueDate ? "" : "text-[var(--muted-foreground)] italic"}`}
                  >
                    {dueDate
                      ? new Date(dueDate).toLocaleDateString()
                      : isAgency
                        ? "Set due date"
                        : "None"}
                  </button>
                )}
              </div>

              {/* Labels */}
              {labels && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                      Labels
                    </label>
                    {!readOnlyLabels && (
                      <button
                        onClick={() => {
                          setLabelMenuOpen((v) => !v);
                          if (labelMenuOpen) setCreatingLabel(false);
                        }}
                        className="text-xs text-[var(--primary)] hover:underline"
                        aria-expanded={labelMenuOpen}
                      >
                        {labelMenuOpen ? "Done" : "Edit"}
                      </button>
                    )}
                  </div>
                  {assignedLabelObjects.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {assignedLabelObjects.map((l) => (
                        <LabelBadge key={l.id} name={l.name} color={l.color} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--muted-foreground)] italic">None</p>
                  )}
                  {labelMenuOpen && !readOnlyLabels && (
                    <div className="mt-2 border border-[var(--border)] rounded-lg bg-[var(--background)] overflow-hidden">
                      <div className="max-h-40 overflow-y-auto py-1">
                        {labels.length === 0 && !creatingLabel && (
                          <p className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
                            No labels yet.
                          </p>
                        )}
                        {labels.map((l) => {
                          const checked = assignedLabels.includes(l.id);
                          return (
                            <button
                              key={l.id}
                              onClick={() => handleToggleLabel(l.id)}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-[var(--muted)] transition-colors text-left"
                            >
                              <span
                                className="w-3 h-3 rounded-full shrink-0"
                                style={{ backgroundColor: l.color }}
                              />
                              <span className="flex-1 truncate">{l.name}</span>
                              <span
                                className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${
                                  checked
                                    ? "bg-[var(--primary)] border-[var(--primary)] text-white"
                                    : "border-[var(--border)]"
                                }`}
                              >
                                {checked && "\u2713"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {creatingLabel ? (
                        <div className="border-t border-[var(--border)] px-3 py-2 space-y-2">
                          <input
                            type="text"
                            value={newLabelName}
                            onChange={(e) => setNewLabelName(e.target.value)}
                            placeholder="Label name"
                            maxLength={50}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleCreateLabel();
                              if (e.key === "Escape") {
                                setCreatingLabel(false);
                                setLabelError("");
                              }
                            }}
                            className="w-full px-2 py-1 border border-[var(--border)] rounded bg-[var(--background)] text-sm"
                          />
                          <ColorPatchGrid value={newLabelColor} onChange={setNewLabelColor} />
                          {labelError && <p className="text-xs text-red-500">{labelError}</p>}
                          <div className="flex gap-1.5">
                            <button
                              onClick={handleCreateLabel}
                              disabled={!newLabelName.trim() || savingLabel}
                              className="flex-1 px-2 py-1 bg-[var(--primary)] text-white rounded text-xs font-medium disabled:opacity-50"
                            >
                              {savingLabel ? "Creating..." : "Create"}
                            </button>
                            <button
                              onClick={() => {
                                setCreatingLabel(false);
                                setLabelError("");
                              }}
                              className="px-2 py-1 border border-[var(--border)] rounded text-xs"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setCreatingLabel(true)}
                          className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors border-t border-[var(--border)]"
                        >
                          <Plus size={12} />
                          Create new label
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Requester */}
              {task.requester && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)] mb-1">
                    Requested by
                  </label>
                  <div className="flex items-center gap-2">
                    <Avatar name={task.requester.name} image={task.requester.image} size={20} />
                    <span>{task.requester.name}</span>
                    {task.isClientRequest && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300 font-medium">
                        Client
                      </span>
                    )}
                  </div>
                  {task.createdAt && (
                    <p className="text-xs text-[var(--muted-foreground)] mt-1">
                      {new Date(task.createdAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
              )}

              {/* Client cancel */}
              {canCancel && (
                <button
                  onClick={handleCancelClient}
                  className="w-full px-3 py-1.5 border border-red-200 text-red-600 rounded-lg text-sm hover:bg-red-50 transition-colors"
                >
                  Cancel request
                </button>
              )}
            </aside>
          </div>
        </div>
      </div>
      {logTimeOpen && projectId && (
        <ManualEntryModal
          projectId={projectId}
          taskId={task.id}
          title="Log time for this task"
          cancelLabel="Skip"
          onClose={() => setLogTimeOpen(false)}
          onSaved={() => {
            setLogTimeOpen(false);
            success("Time logged");
          }}
        />
      )}
    </div>
  );
}
