type Reporter = Readonly<{actorUserId: string; actorDisplayName?: string | null; actorEmail?: string | null}>;

export function FeedbackReporter({item, showAccount = false}: {item: Reporter; showAccount?: boolean}) {
  const account = item.actorEmail?.trim() || item.actorUserId;
  const name = item.actorDisplayName?.trim() || item.actorEmail?.trim() || `用户 ${item.actorUserId}`;
  return <small className="feedback-reporter" title={`提交账号：${account}`}>
    提出人：{name}{showAccount && account !== name ? ` · 账号：${account}` : ""}
  </small>;
}
