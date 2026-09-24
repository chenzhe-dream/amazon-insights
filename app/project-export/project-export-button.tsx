"use client";

import styles from "./project-export.module.css";

export function ProjectExportButton({ id, onClick }: {
  id: string;
  onClick: () => void;
}) {
  return <button id={id} type="button" className={`ghost-btn ${styles.trigger}`} aria-haspopup="dialog"
      onClick={onClick}>
      导出
    </button>;
}
