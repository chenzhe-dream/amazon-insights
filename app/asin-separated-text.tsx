import { Fragment } from "react";

/** Keep report text intact while starting each bracketed ASIN on a new line. */
export function AsinSeparatedText({ text }: { text: string }) {
  return text.split(/(?=\[[A-Z0-9]{10}\])/g).map((part, index) => (
    <Fragment key={index}>
      {index > 0 ? <br /> : null}
      {part}
    </Fragment>
  ));
}
