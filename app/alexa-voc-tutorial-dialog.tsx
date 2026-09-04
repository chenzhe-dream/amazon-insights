"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./alexa-voc-tutorial-dialog.module.css";

export function AlexaVocTutorialDialog() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [close, open]);

  const dialog = open && typeof document !== "undefined"
    ? createPortal(
        <div
          className={styles.backdrop}
          data-testid="alexa-voc-tutorial-backdrop"
          onClick={event => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="alexa-voc-tutorial-title"
          >
            <header className={styles.header}>
              <h2 id="alexa-voc-tutorial-title">Alexa VOC 录入教程</h2>
              <button
                ref={closeRef}
                type="button"
                className={styles.close}
                aria-label="关闭录入教程"
                onClick={close}
              >
                ×
              </button>
            </header>
            <div className={styles.content}>
              <div className={styles.instructions}>
                <ol>
                  <li>打开 Amazon 商品详情页与 Alexa for Shopping。</li>
                  <li>将七问模板一次性粘贴到对话框。</li>
                  <li>复制 Alexa 完整回复，返回系统选择对应 ASIN 并导入。</li>
                </ol>
                <p className={styles.note}>请复制完整回复，不要只复制摘要。</p>
              </div>
              <div className={styles.screenshotFrame}>
                <Image
                  className={styles.screenshot}
                  src="/tutorials/alexa-voc-entry.png"
                  width={338}
                  height={719}
                  alt="Alexa for Shopping 中粘贴七问模板的操作示例"
                  priority
                />
              </div>
            </div>
          </section>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">ⓘ</span>
        查看录入教程
      </button>
      {dialog}
    </>
  );
}
