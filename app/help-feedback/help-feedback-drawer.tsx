"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { User } from "../../shared/agent-contracts";
import { isPrimaryAdministrator } from "../lib/primary-admin";
import { FeedbackImageInput } from "./feedback-image-input";
import { HelpManual } from "./help-manual";
import {
  createHelpFeedbackClient,
  FeedbackRequestError,
} from "./help-feedback-client";
import type {
  FeedbackDetail,
  FeedbackDraft,
  FeedbackDrawerTab,
  FeedbackListItem,
  FeedbackStatus,
} from "./feedback-types";

type ClosePath = "button" | "backdrop" | "escape";

export function isPrimaryFeedbackAdmin(user: User) {
  return isPrimaryAdministrator(user);
}

export function availableFeedbackTabs(user: User): FeedbackDrawerTab[] {
  return ["manual", "submit", "mine", ...(isPrimaryFeedbackAdmin(user) ? ["admin" as const] : [])];
}

export function hasDirtyFeedbackDraft(draft: FeedbackDraft) {
  return draft.title.trim().length > 0
    || draft.description.trim().length > 0
    || draft.images.length > 0;
}

export function shouldCloseFeedbackDrawer(
  draft: FeedbackDraft,
  _path: ClosePath,
  confirmDiscard: () => boolean,
) {
  return !hasDirtyFeedbackDraft(draft) || confirmDiscard();
}

export function createLatestUnreadRequest() {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      const current = ++generation;
      return {
        signal: controller.signal,
        isLatest: () => current === generation && controller?.signal.aborted === false,
      };
    },
    abort() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}

const client = createHelpFeedbackClient();
const statusLabels: Record<FeedbackStatus, string> = {
  new: "新反馈",
  processing: "处理中",
  resolved: "已解决",
  closed: "已关闭",
};
const tabLabels: Record<FeedbackDrawerTab, string> = {
  manual: "使用手册",
  submit: "提交反馈",
  mine: "我的反馈",
  admin: "反馈管理",
};

function FeedbackList({ items, onOpen }: {
  items: readonly FeedbackListItem[];
  onOpen: (item: FeedbackListItem) => void;
}) {
  if (items.length === 0) return <p className="feedback-empty">暂无反馈</p>;
  return <div className="feedback-list">
    {items.map((item) => <button
      key={item.id}
      type="button"
      className="feedback-list-item"
      onClick={() => onOpen(item)}
    >
      <span>
        <b>{item.title}</b>
        <small>{new Date(item.createdAt).toLocaleString("zh-CN")} · {item.attachmentCount} 张图片</small>
      </span>
      <em data-status={item.status}>{statusLabels[item.status]}</em>
    </button>)}
  </div>;
}

function FeedbackDetailPanel({
  detail,
  admin,
  onBack,
  onChanged,
}: {
  detail: FeedbackDetail;
  admin: boolean;
  onBack: () => void;
  onChanged: (detail: FeedbackDetail) => void;
}) {
  const [status, setStatus] = useState<FeedbackStatus>(detail.status);
  const [pending, setPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const attachmentPrefix = admin ? `/v1/feedback/admin/${detail.id}` : `/v1/feedback/mine/${detail.id}`;

  async function updateStatus() {
    setPending(true);
    setStatusMessage(null);
    try {
      onChanged(await client.changeStatus(detail.id, status, detail.workflowVersion));
    } catch (error) {
      if (error instanceof FeedbackRequestError && error.status === 409) {
        try {
          const latest = await client.getAdmin(detail.id);
          setStatus(latest.status);
          onChanged(latest);
          setStatusMessage("状态已被其他管理员更新，已加载最新记录");
        } catch {
          setStatusMessage("状态已发生变化，刷新失败，请稍后重试");
        }
      } else {
        setStatusMessage("状态更新失败，请重试");
      }
    } finally {
      setPending(false);
    }
  }

  return <section className="feedback-detail">
    <button type="button" className="feedback-back-button" onClick={onBack}>返回列表</button>
    <div className="feedback-detail-heading">
      <div><h3>{detail.title}</h3><p>{detail.description}</p></div>
      <em data-status={detail.status}>{statusLabels[detail.status]}</em>
    </div>
    {detail.attachments.length > 0 ? <div className="feedback-attachments">
      {detail.attachments.map((attachment) => <button
        type="button"
        key={attachment.id}
        onClick={() => {
          void client.openAttachment(`${attachmentPrefix}/attachments/${attachment.id}`)
            .catch(() => setStatusMessage("图片打开失败，请重试"));
        }}
      >
        {attachment.fileName}<small>{Math.ceil(attachment.byteSize / 1024)} KB</small>
      </button>)}
    </div> : null}
    {admin ? <div className="feedback-status-editor">
      <select aria-label="反馈状态" value={status} onChange={(event) => setStatus(event.target.value as FeedbackStatus)}>
        {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <button type="button" disabled={pending || status === detail.status} onClick={() => void updateStatus()}>
        {pending ? "保存中…" : "更新状态"}
      </button>
    </div> : null}
    {statusMessage ? <p className="feedback-inline-message" role="status">{statusMessage}</p> : null}
    <h4>状态历史</h4>
    <ol className="feedback-history">
      {detail.events.map((event) => <li key={event.id}>
        <b>{statusLabels[event.toStatus]}</b>
        <span>{new Date(event.createdAt).toLocaleString("zh-CN")}</span>
      </li>)}
    </ol>
  </section>;
}

export function HelpFeedbackDrawer({ user }: { user: User }) {
  const canManage = isPrimaryFeedbackAdmin(user);
  const tabs = useMemo(() => availableFeedbackTabs(user), [user]);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<FeedbackDrawerTab>("manual");
  const [category, setCategory] = useState<FeedbackDraft["category"]>("bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<FeedbackDraft["images"]>([]);
  const [imageErrors, setImageErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [items, setItems] = useState<FeedbackListItem[]>([]);
  const [detail, setDetail] = useState<FeedbackDetail | null>(null);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState<FeedbackStatus | null>(null);
  const unreadRequests = useRef(createLatestUnreadRequest());
  const submitGeneration = useRef(0);
  const draft = useMemo<FeedbackDraft>(() => ({ category, title, description, images }), [category, description, images, title]);

  const refreshUnread = useCallback(() => {
    if (!canManage) return;
    const request = unreadRequests.current.begin();
    void client.unreadCount(request.signal).then((count) => {
      if (request.isLatest()) setUnread(count);
    }).catch(() => undefined);
  }, [canManage]);

  useEffect(() => {
    refreshUnread();
    const requests = unreadRequests.current;
    return () => requests.abort();
  }, [refreshUnread]);

  useEffect(() => {
    if (!open || (tab !== "mine" && tab !== "admin")) return;
    let active = true;
    const load = tab === "mine" ? client.listMine() : client.listAdmin(filter);
    void load.then((nextItems) => {
      if (!active) return;
      setDetail(null);
      setItems(nextItems);
    }).catch(() => {
      if (active) setMessage("反馈列表加载失败");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [filter, open, tab]);

  const requestClose = useCallback((path: ClosePath) => {
    if (!shouldCloseFeedbackDrawer(draft, path, () => window.confirm("放弃尚未提交的反馈草稿？"))) return;
    submitGeneration.current += 1;
    setPending(false);
    setCategory("bug");
    setTitle("");
    setDescription("");
    setImages([]);
    setImageErrors([]);
    setMessage(null);
    setOpen(false);
  }, [draft]);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose("escape");
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [open, requestClose]);

  useEffect(() => () => { submitGeneration.current += 1; }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const generation = ++submitGeneration.current;
    setPending(true);
    setMessage(null);
    try {
      const result = await client.submit({
        ...draft,
        pagePath: `${window.location.pathname}${window.location.search}`,
      });
      if (generation !== submitGeneration.current) return;
      setTitle("");
      setDescription("");
      setImages([]);
      setImageErrors([]);
      setMessage(`提交成功 · ${result.feedbackId}`);
      refreshUnread();
    } catch {
      if (generation === submitGeneration.current) setMessage("提交失败，请检查内容和图片后重试");
    } finally {
      if (generation === submitGeneration.current) setPending(false);
    }
  }

  async function openItem(item: FeedbackListItem) {
    setLoading(true);
    setMessage(null);
    try {
      const next = tab === "admin" ? await client.getAdmin(item.id) : await client.getMine(item.id);
      setDetail(next);
      if (tab === "admin" && next.adminSeenAt === null) {
        const changed = await client.markSeen(item.id);
        if (changed) setUnread((current) => Math.max(0, current - 1));
        setItems((current) => current.map((entry) => entry.id === item.id
          ? { ...entry, adminSeenAt: new Date().toISOString() }
          : entry));
        refreshUnread();
      }
    } catch {
      setMessage("反馈详情加载失败");
    } finally {
      setLoading(false);
    }
  }

  return <>
    <button
      type="button"
      className="help-feedback-entry"
      onClick={() => setOpen(true)}
      aria-haspopup="dialog"
    >
      <span aria-hidden="true">?</span>
      <b>帮助与反馈</b>
      {canManage && unread > 0 ? <em className="feedback-unread-badge" aria-label={`${unread} 条未读反馈`}>
        {unread > 99 ? "99+" : unread}
      </em> : null}
    </button>
    <div
      className="help-feedback-layer"
      hidden={!open}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose("backdrop");
      }}
    >
      <aside className="help-feedback-drawer" role="dialog" aria-modal="true" aria-label="帮助与反馈中心">
        <header>
          <div><small>HELP CENTER</small><h2>帮助与反馈</h2></div>
          <button type="button" onClick={() => requestClose("button")} aria-label="关闭帮助与反馈">×</button>
        </header>
        <div className="help-feedback-tabs" role="tablist">
          {tabs.map((item) => <button
            type="button"
            role="tab"
            aria-selected={tab === item}
            key={item}
            onClick={() => { setTab(item); setDetail(null); setMessage(null); }}
          >
            {tabLabels[item]}
            {item === "admin" && unread > 0 ? <em className="feedback-unread-badge">{unread > 99 ? "99+" : unread}</em> : null}
          </button>)}
        </div>
        <div className="help-feedback-content">
          {tab === "manual" ? <HelpManual /> : null}
          {tab === "submit" ? <form className="feedback-submit-form" onSubmit={(event) => void submit(event)}>
            <label>类型
              <select value={category} onChange={(event) => setCategory(event.target.value as FeedbackDraft["category"])}>
                <option value="bug">问题</option>
                <option value="suggestion">建议</option>
                <option value="other">其他</option>
              </select>
            </label>
            <label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required /></label>
            <label>详细描述<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={7} maxLength={4000} required /></label>
            <FeedbackImageInput images={images} errors={imageErrors} onChange={setImages} onErrors={setImageErrors} />
            <button className="feedback-submit-button" type="submit" disabled={pending}>
              {pending ? "提交中…" : "提交反馈"}
            </button>
          </form> : null}
          {tab === "mine" ? (detail
            ? <FeedbackDetailPanel key={`${detail.id}-${detail.workflowVersion}`} detail={detail} admin={false} onBack={() => setDetail(null)} onChanged={setDetail} />
            : <FeedbackList items={items} onOpen={(item) => void openItem(item)} />) : null}
          {tab === "admin" && canManage ? <>
            {!detail ? <div className="feedback-admin-filter">
              <label>状态筛选
                <select aria-label="管理筛选" value={filter ?? ""} onChange={(event) => setFilter((event.target.value || null) as FeedbackStatus | null)}>
                  <option value="">全部</option>
                  {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div> : null}
            {detail
              ? <FeedbackDetailPanel
                  key={`${detail.id}-${detail.workflowVersion}`}
                  detail={detail}
                  admin
                  onBack={() => setDetail(null)}
                  onChanged={(next) => {
                    setDetail(next);
                    setItems((current) => current.map((item) => item.id === next.id ? next : item));
                  }}
                />
              : <FeedbackList items={items} onOpen={(item) => void openItem(item)} />}
          </> : null}
          {loading ? <p className="feedback-message" role="status">正在加载…</p> : null}
          {message ? <p className="feedback-message" role="status">{message}</p> : null}
        </div>
      </aside>
    </div>
  </>;
}
