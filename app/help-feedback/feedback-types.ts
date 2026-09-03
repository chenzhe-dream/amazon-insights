import type { CreateFeedbackRequest } from "../../shared/agent-contracts";

export type {
  FeedbackAttachmentMetadata,
  FeedbackDetail,
  FeedbackListItem,
  FeedbackStatus,
  FeedbackStatusEvent,
} from "../../shared/agent-contracts";

export type FeedbackImageDraft = Readonly<{
  id: string;
  file: File;
  previewUrl: string;
}>;

export type FeedbackDraft = Readonly<{
  category: CreateFeedbackRequest["category"];
  title: string;
  description: string;
  images: readonly FeedbackImageDraft[];
}>;

export type FeedbackDrawerTab = "manual" | "submit" | "mine" | "admin";
